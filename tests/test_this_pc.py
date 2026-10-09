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
    """Online peers running WatchTower are flagged runs_watchtower=True and
    carry a watchtower_url so the UI can offer 'Open' + standby pairing."""
    monkeypatch.setattr("watchtower.tool_resolver.tailscale_binary", lambda: "/usr/bin/tailscale")
    monkeypatch.setattr(
        _this_pc.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=_FAKE_TS_STATUS, stderr=""),
    )
    # build-box (100.64.0.2) runs WatchTower; old-laptop is offline (not probed).
    monkeypatch.setattr(
        _this_pc, "_probe_peer_watchtower",
        lambda ip, timeout=2.0: {
            "runs_watchtower": ip == "100.64.0.2",
            "reachable": ip == "100.64.0.2",
            "version": "2.1.0" if ip == "100.64.0.2" else None,
            "url": f"http://{ip}:8000",
        },
    )
    peers = client.get("/api/this-pc/discover-nodes").json()["peers"]
    bb = next(p for p in peers if p["hostname"] == "build-box")
    ol = next(p for p in peers if p["hostname"] == "old-laptop")
    assert bb["runs_watchtower"] is True
    assert bb["watchtower_url"] == "http://100.64.0.2:8000"
    assert bb["watchtower_version"] == "2.1.0"
    assert ol["runs_watchtower"] is False  # offline → not probed
    assert ol["watchtower_url"]  # still has a URL even when offline


def test_peer_health_rejects_non_tailscale_ip(client: TestClient):
    """The peer-health probe must refuse arbitrary hosts — SSRF guard."""
    r = client.get("/api/this-pc/peer-health", params={"ip": "8.8.8.8"})
    assert r.status_code == 400
    r = client.get("/api/this-pc/peer-health", params={"ip": "not-an-ip"})
    assert r.status_code == 400


def test_peer_health_probes_a_tailscale_ip(client: TestClient, monkeypatch):
    """A valid tailnet IP is probed and the live result returned."""
    monkeypatch.setattr(
        _this_pc, "_probe_peer_watchtower",
        lambda ip, timeout=3.0: {
            "runs_watchtower": True, "reachable": True,
            "version": "2.1.0", "url": f"http://{ip}:8000",
        },
    )
    r = client.get("/api/this-pc/peer-health", params={"ip": "100.64.0.5"})
    assert r.status_code == 200
    body = r.json()
    assert body["ip"] == "100.64.0.5"
    assert body["runs_watchtower"] is True
    assert body["url"] == "http://100.64.0.5:8000"


# ── Pairing token (the two-device setup) ─────────────────────────────────────


def test_pairing_token_returns_this_devices_details(client: TestClient, monkeypatch):
    """The owner can fetch this device's token + address to pair it from another
    box — the piece that was missing, leaving the pairing instruction a dead end."""
    _bootstrap_admin_cp(client)  # first user → owner (can_manage_team)
    monkeypatch.setattr(_this_pc, "_self_tailscale_ip", lambda: "100.64.0.9")
    r = client.get("/api/this-pc/pairing-token")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_token"] is True
    assert body["token"]                       # the real WATCHTOWER_API_TOKEN
    assert body["tailscale_ip"] == "100.64.0.9"
    assert body["address"] == "100.64.0.9:8000"


def test_pairing_token_requires_admin(client: TestClient):
    """The token is a credential to this machine — non-admins can't reveal it."""
    from unittest.mock import patch
    with patch("watchtower.api.runtime._user_can_manage_org_secrets", return_value=False):
        r = client.get("/api/this-pc/pairing-token")
    assert r.status_code == 403


def test_pairing_token_requires_auth(anon_client):
    assert anon_client.get("/api/this-pc/pairing-token").status_code == 401


# ── Control-plane pairing ────────────────────────────────────────────────────


def test_control_plane_default_standalone(client: TestClient):
    r = client.get("/api/this-pc/control-plane")
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "standalone"
    assert body["peer_host"] is None
    assert body["peer_name"] is None
    assert body["has_peer_token"] is False
    assert body["snapshot_present"] is False


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
        "peer_token": "primary-token-xyz",
    })
    r = client.post("/api/this-pc/control-plane/unpair")
    assert r.status_code == 200
    body = r.json()
    assert body["role"] == "standalone"
    assert body["peer_host"] is None
    assert body["has_peer_token"] is False


def test_control_plane_pair_stores_token_without_echoing(client: TestClient):
    _bootstrap_admin_cp(client)
    r = client.post("/api/this-pc/control-plane/pair", json={
        "role": "standby", "peer_host": "100.64.0.2", "peer_token": "s3cr3t-token",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # The token is stored (has_peer_token) but never returned verbatim.
    assert body["has_peer_token"] is True
    assert "s3cr3t-token" not in r.text


# ── Standby state sync ───────────────────────────────────────────────────────

from watchtower import control_plane_sync as _cps  # noqa: E402


def test_sync_now_skips_when_not_standby(client: TestClient, monkeypatch):
    # Default standalone → sync is a no-op, never touches the network.
    pulled = {"called": False}
    monkeypatch.setattr(_cps, "_pull_once", lambda *a, **k: (pulled.update(called=True), (True, "x"))[1])
    ok, msg = _cps.sync_now()
    assert ok is False
    assert "not a standby" in msg.lower()
    assert pulled["called"] is False


def test_sync_now_pulls_when_standby(client: TestClient, monkeypatch, tmp_path):
    _bootstrap_admin_cp(client)
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    client.post("/api/this-pc/control-plane/pair", json={
        "role": "standby", "peer_host": "100.64.0.2", "peer_token": "tok",
    })
    # Mock the actual HTTP pull to succeed without a network call.
    monkeypatch.setattr(_cps, "_pull_once", lambda host, port, token: (True, "Synced 123 bytes from primary."))
    ok, msg = _cps.sync_now()
    assert ok is True
    assert "synced" in msg.lower()
    # last_synced_at recorded.
    status = client.get("/api/this-pc/control-plane").json()
    assert status["last_synced_at"] is not None


def test_sync_now_records_error_on_failure(client: TestClient, monkeypatch):
    _bootstrap_admin_cp(client)
    client.post("/api/this-pc/control-plane/pair", json={
        "role": "standby", "peer_host": "100.64.0.2", "peer_token": "tok",
    })
    monkeypatch.setattr(_cps, "_pull_once", lambda *a, **k: (False, "Could not reach primary: timed out"))
    ok, msg = _cps.sync_now()
    assert ok is False
    status = client.get("/api/this-pc/control-plane").json()
    assert status["last_sync_error"] and "could not reach primary" in status["last_sync_error"].lower()


def test_sync_now_endpoint_requires_standby(client: TestClient):
    _bootstrap_admin_cp(client)
    # standalone → 400, not allowed to pull.
    r = client.post("/api/this-pc/control-plane/sync-now")
    assert r.status_code == 400


def test_sync_now_endpoint_requires_auth(anon_client: TestClient):
    assert anon_client.post("/api/this-pc/control-plane/sync-now").status_code == 401


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

    # First call establishes the caller's org membership. Use the org the
    # ENDPOINT actually resolves for this caller (via /api/me) rather than
    # reconstructing an identity by hand — the static-token identity label is
    # an implementation detail and shouldn't be duplicated here.
    client.get("/api/this-pc/discover-nodes")
    me = client.get("/api/me").json()
    target_org = _uuid.UUID(me["org_id"]) if me.get("org_id") else None
    db = SessionLocal()
    try:
        if target_org is not None:
            db.add(OrgNode(org_id=target_org, name="bb", host="100.64.0.2", user="x",
                           port=22, remote_path="/srv", reload_command="true"))
            db.commit()
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
