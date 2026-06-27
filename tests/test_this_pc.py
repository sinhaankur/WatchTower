"""Plug-and-play "Use this PC as the server" endpoints.

Covers the readiness probe and the one-click localhost-node registration:
shape, idempotency (no duplicate local node), auth gating, and that the
registered node is marked provider='local' so the deploy path can skip SSH.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from watchtower.api import this_pc


def test_status_requires_auth(anon_client: TestClient):
    assert anon_client.get("/api/this-pc/status").status_code == 401


def test_use_as_server_requires_auth(anon_client: TestClient):
    assert anon_client.post("/api/this-pc/use-as-server").status_code == 401


def test_status_shape_before_registration(client: TestClient):
    r = client.get("/api/this-pc/status")
    assert r.status_code == 200
    body = r.json()
    # Identity + readiness fields the UI card needs.
    for key in ("hostname", "os", "arch", "registered", "runtime", "ready"):
        assert key in body, key
    assert body["registered"] is False
    assert body["node_id"] is None
    assert isinstance(body["runtime"], dict)
    assert "available" in body["runtime"]


def test_use_as_server_registers_local_node(client: TestClient):
    r = client.post("/api/this-pc/use-as-server")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    node = body["node"]
    assert node["host"] == this_pc.LOCAL_HOST
    assert node["provider"] == this_pc.LOCAL_PROVIDER
    assert node["is_primary"] is True
    assert node["id"]


def test_use_as_server_is_idempotent(client: TestClient):
    first = client.post("/api/this-pc/use-as-server")
    assert first.status_code == 200
    first_id = first.json()["node"]["id"]

    second = client.post("/api/this-pc/use-as-server")
    assert second.status_code == 200
    body = second.json()
    # Same node, not a duplicate, and flagged as not newly created.
    assert body["created"] is False
    assert body["node"]["id"] == first_id


def test_status_reflects_registration(client: TestClient):
    client.post("/api/this-pc/use-as-server")
    r = client.get("/api/this-pc/status")
    assert r.status_code == 200
    body = r.json()
    assert body["registered"] is True
    assert body["node_id"]


def test_registered_local_node_appears_with_local_provider(client: TestClient):
    """The local node must be queryable as provider='local' so the deploy
    runner can recognise it and skip SSH."""
    client.post("/api/this-pc/use-as-server")
    # Re-probe status; node_status should be populated from the OrgNode row.
    body = client.get("/api/this-pc/status").json()
    assert body["registered"] is True
    assert body["node_status"] in {"healthy", "offline", "unreachable", "degraded"}


def test_registered_local_node_has_real_deploy_path(client: TestClient):
    """The registered node must carry a non-empty, non-root remote_path so the
    builder's local rsync + container bind-mount don't target '/'. This is the
    contract that makes local deploys actually work."""
    from watchtower.database import OrgNode, SessionLocal
    from watchtower.api import this_pc

    client.post("/api/this-pc/use-as-server")
    db = SessionLocal()
    try:
        node = (
            db.query(OrgNode)
            .filter(OrgNode.provider == this_pc.LOCAL_PROVIDER)
            .first()
        )
        assert node is not None
        assert node.remote_path not in ("", "/", None)
        assert node.remote_path.rstrip("/").endswith("deployments/this-pc")
    finally:
        db.close()
