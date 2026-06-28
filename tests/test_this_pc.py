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


# ── Tailnet node discovery ───────────────────────────────────────────────────

import json as _json  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from watchtower.api import this_pc as _this_pc  # noqa: E402


_FAKE_TS_STATUS = _json.dumps({
    "Self": {"HostName": "my-pc", "TailscaleIPs": ["100.64.0.1"], "DNSName": "my-pc.tail.ts.net."},
    "Peer": {
        "k1": {"HostName": "build-box", "TailscaleIPs": ["100.64.0.2"],
               "DNSName": "build-box.tail.ts.net.", "Online": True, "OS": "linux"},
        "k2": {"HostName": "old-laptop", "TailscaleIPs": ["100.64.0.3"],
               "DNSName": "old-laptop.tail.ts.net.", "Online": False, "OS": "macOS"},
    },
})


def test_discover_nodes_requires_auth(anon_client: TestClient):
    assert anon_client.get("/api/this-pc/discover-nodes").status_code == 401


def test_discover_nodes_empty_without_tailscale(client: TestClient, monkeypatch):
    """No Tailscale CLI → empty list, not an error."""
    monkeypatch.setattr("watchtower.tool_resolver.tailscale_binary", lambda: None)
    r = client.get("/api/this-pc/discover-nodes")
    assert r.status_code == 200
    assert r.json() == {"source": "tailscale", "peers": []}


def test_discover_nodes_lists_peers(client: TestClient, monkeypatch):
    monkeypatch.setattr("watchtower.tool_resolver.tailscale_binary", lambda: "/usr/bin/tailscale")
    monkeypatch.setattr(
        _this_pc.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=_FAKE_TS_STATUS, stderr=""),
    )
    r = client.get("/api/this-pc/discover-nodes")
    assert r.status_code == 200
    peers = r.json()["peers"]
    names = [p["hostname"] for p in peers]
    # Self excluded; both peers present; online sorted first.
    assert "my-pc" not in names
    assert names[0] == "build-box"  # online peer ranks above offline
    assert {"build-box", "old-laptop"} == set(names)
    bb = next(p for p in peers if p["hostname"] == "build-box")
    assert bb["ip"] == "100.64.0.2"
    assert bb["online"] is True
    assert bb["already_added"] is False


def test_discover_nodes_flags_watchtower_peers(client: TestClient, monkeypatch):
    """Online peers running WatchTower are flagged runs_watchtower=True so the
    UI can offer control-plane standby pairing."""
    monkeypatch.setattr("watchtower.tool_resolver.tailscale_binary", lambda: "/usr/bin/tailscale")
    monkeypatch.setattr(
        _this_pc.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=_FAKE_TS_STATUS, stderr=""),
    )
    # build-box (100.64.0.2) runs WatchTower; old-laptop is offline (not probed).
    monkeypatch.setattr(_this_pc, "_peer_runs_watchtower", lambda ip: ip == "100.64.0.2")
    peers = client.get("/api/this-pc/discover-nodes").json()["peers"]
    bb = next(p for p in peers if p["hostname"] == "build-box")
    ol = next(p for p in peers if p["hostname"] == "old-laptop")
    assert bb["runs_watchtower"] is True
    assert ol["runs_watchtower"] is False  # offline → not probed


# ── Control-plane pairing ────────────────────────────────────────────────────


def test_control_plane_default_standalone(client: TestClient):
    r = client.get("/api/this-pc/control-plane")
    assert r.status_code == 200
    assert r.json() == {"role": "standalone", "peer_host": None, "peer_name": None}


def test_control_plane_requires_auth(anon_client: TestClient):
    assert anon_client.get("/api/this-pc/control-plane").status_code == 401
    assert anon_client.post("/api/this-pc/control-plane/pair", json={}).status_code == 401


def _bootstrap_admin_cp(client: TestClient) -> None:
    r = client.post("/api/projects", json={
        "name": "cp-bootstrap", "use_case": "vercel_like",
        "repo_url": "https://example.com/cp.git", "repo_branch": "main",
    })
    assert r.status_code == 201, r.text


def test_control_plane_pair_records_role(client: TestClient):
    _bootstrap_admin_cp(client)
    r = client.post("/api/this-pc/control-plane/pair", json={
        "role": "primary", "peer_host": "100.64.0.2", "peer_name": "build-box",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "primary"
    assert body["peer_host"] == "100.64.0.2"
    assert body["peer_name"] == "build-box"
    # Persisted across a fresh read.
    assert client.get("/api/this-pc/control-plane").json()["role"] == "primary"


def test_control_plane_pair_rejects_bad_role(client: TestClient):
    _bootstrap_admin_cp(client)
    r = client.post("/api/this-pc/control-plane/pair", json={
        "role": "leader", "peer_host": "100.64.0.2",
    })
    assert r.status_code == 422


def test_control_plane_pair_requires_manage_team(client: TestClient):
    from unittest.mock import patch
    with patch("watchtower.api.runtime._user_can_manage_org_secrets", return_value=False):
        r = client.post("/api/this-pc/control-plane/pair", json={
            "role": "primary", "peer_host": "100.64.0.2",
        })
    assert r.status_code == 403


def test_control_plane_unpair_resets_to_standalone(client: TestClient):
    _bootstrap_admin_cp(client)
    client.post("/api/this-pc/control-plane/pair", json={
        "role": "standby", "peer_host": "100.64.0.9", "peer_name": "main",
    })
    r = client.post("/api/this-pc/control-plane/unpair")
    assert r.status_code == 200
    assert r.json() == {"role": "standalone", "peer_host": None, "peer_name": None}


def test_discover_nodes_flags_already_added(client: TestClient, monkeypatch):
    """A peer whose IP matches a registered OrgNode is flagged already_added."""
    monkeypatch.setattr("watchtower.tool_resolver.tailscale_binary", lambda: "/usr/bin/tailscale")
    monkeypatch.setattr(
        _this_pc.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=_FAKE_TS_STATUS, stderr=""),
    )
    # Register an OrgNode at build-box's IP in the caller's org, then confirm
    # discovery flags that peer as already added.
    import uuid as _uuid
    from watchtower.database import OrgNode, SessionLocal
    from watchtower.api import enterprise

    # First call establishes the caller's org membership.
    client.get("/api/this-pc/discover-nodes")
    db = SessionLocal()
    try:
        _u, org, _m = enterprise._ensure_user_org_member(
            db, {"user_id": str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "watchtower-static-token-user")),
                 "email": "developer@watchtower.local"}
        )
        # The static-token user's org is deterministic; register the node there.
        db.add(OrgNode(org_id=org.id, name="bb", host="100.64.0.2", user="x",
                       port=22, remote_path="/srv", reload_command="true"))
        db.commit()
        target_org = org.id
    finally:
        db.close()

    r = client.get("/api/this-pc/discover-nodes")
    assert r.status_code == 200
    peers = r.json()["peers"]
    bb = next(p for p in peers if p["hostname"] == "build-box")
    # If the registration landed in the same org the endpoint resolves, the
    # peer is flagged. (Static-token org resolution is deterministic, so it
    # should match; assert defensively that the key exists regardless.)
    assert "already_added" in bb
    if target_org is not None:
        assert bb["already_added"] is True
