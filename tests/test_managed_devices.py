"""Managed devices — pair/list/unpair + the allow-listed read proxy.

Covers the security-critical bits: auth required, tailnet-only IPs (SSRF guard),
the token is stored encrypted + never echoed, and the proxy refuses anything
off the read allow-list.
"""
from __future__ import annotations

from watchtower.api import managed_devices as md


def _bootstrap_admin(client) -> None:
    """Create a project so the first user is promoted to org OWNER
    (can_manage_team=True) — the admin gate the pairing endpoints require."""
    r = client.post("/api/projects", json={
        "name": "md-bootstrap", "use_case": "vercel_like",
        "repo_url": "https://example.com/md.git", "repo_branch": "main",
    })
    assert r.status_code == 201, r.text


def test_list_requires_auth(anon_client):
    assert anon_client.get("/api/managed-devices").status_code == 401


def test_pair_rejects_non_tailnet_ip(client):
    _bootstrap_admin(client)
    r = client.post("/api/managed-devices", json={
        "name": "evil", "ip": "8.8.8.8", "port": 8000, "token": "t",
    })
    assert r.status_code == 400
    assert "tailscale" in r.json()["detail"].lower()


def test_pair_and_list_roundtrip(client):
    _bootstrap_admin(client)
    r = client.post("/api/managed-devices", json={
        "name": "build-box", "ip": "100.64.0.2", "port": 8000, "token": "secret-token",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "build-box"
    assert body["ip"] == "100.64.0.2"
    assert body["has_token"] is True
    # The token must never come back in the response.
    assert "secret-token" not in r.text

    listed = client.get("/api/managed-devices").json()
    assert any(d["ip"] == "100.64.0.2" and d["has_token"] for d in listed)


def test_token_stored_encrypted(client, db_session):
    _bootstrap_admin(client)
    client.post("/api/managed-devices", json={
        "name": "pg", "ip": "100.64.0.9", "port": 8000, "token": "plaintext-secret",
    })
    from watchtower.database import SystemSetting
    rows = db_session.query(SystemSetting).filter(SystemSetting.key.like("managed_device.%.token")).all()
    assert rows, "token row should exist"
    for row in rows:
        assert row.is_secret is True
        assert "plaintext-secret" not in (row.value or "")  # Fernet ciphertext


def test_repair_same_ip_updates_in_place(client):
    _bootstrap_admin(client)
    client.post("/api/managed-devices", json={"name": "a", "ip": "100.64.0.3", "port": 8000, "token": "t1"})
    client.post("/api/managed-devices", json={"name": "a-renamed", "ip": "100.64.0.3", "port": 9000, "token": "t2"})
    listed = [d for d in client.get("/api/managed-devices").json() if d["ip"] == "100.64.0.3"]
    assert len(listed) == 1  # not duplicated
    assert listed[0]["name"] == "a-renamed"
    assert listed[0]["port"] == 9000


def test_unpair_removes_device(client):
    _bootstrap_admin(client)
    dev = client.post("/api/managed-devices", json={
        "name": "temp", "ip": "100.64.0.4", "port": 8000, "token": "t",
    }).json()
    assert client.delete(f"/api/managed-devices/{dev['id']}").status_code == 200
    assert not any(d["id"] == dev["id"] for d in client.get("/api/managed-devices").json())


def test_unpair_unknown_404(client):
    _bootstrap_admin(client)
    assert client.delete("/api/managed-devices/does-not-exist").status_code == 404


# ── proxy ─────────────────────────────────────────────────────────────────────


def test_proxy_rejects_unknown_view(client):
    _bootstrap_admin(client)
    dev = client.post("/api/managed-devices", json={
        "name": "bb", "ip": "100.64.0.5", "port": 8000, "token": "t",
    }).json()
    r = client.get(f"/api/managed-devices/{dev['id']}/view/shell")  # not allow-listed
    assert r.status_code == 400
    assert "allowed" in r.json()["detail"].lower()


def test_proxy_unknown_device_404(client):
    _bootstrap_admin(client)
    assert client.get("/api/managed-devices/nope/view/projects").status_code == 404


def test_proxy_forwards_allowlisted_view(client, monkeypatch):
    """A whitelisted view proxies to the device with its token and returns
    the upstream JSON verbatim."""
    _bootstrap_admin(client)
    dev = client.post("/api/managed-devices", json={
        "name": "bb", "ip": "100.64.0.6", "port": 8000, "token": "the-token",
    }).json()

    captured = {}

    def fake_proxy(ip, port, upstream_path, token, *, timeout=6.0):
        captured.update(ip=ip, port=port, path=upstream_path, token=token)
        return (200, [{"id": "p1", "name": "api"}])

    monkeypatch.setattr(md, "_proxy_get", fake_proxy)
    r = client.get(f"/api/managed-devices/{dev['id']}/view/projects")
    assert r.status_code == 200
    body = r.json()
    assert body["view"] == "projects"
    assert body["status"] == 200
    assert body["data"] == [{"id": "p1", "name": "api"}]
    # The device's own token was used against its own IP + the mapped path.
    assert captured["ip"] == "100.64.0.6"
    assert captured["token"] == "the-token"
    assert captured["path"] == "/api/projects"


# ── write actions ───────────────────────────────────────────────────────────


def _pair_one(client, ip="100.64.0.8"):
    _bootstrap_admin(client)
    return client.post("/api/managed-devices", json={
        "name": "bb", "ip": ip, "port": 8000, "token": "the-token",
    }).json()


def test_action_requires_auth(anon_client):
    r = anon_client.post("/api/managed-devices/x/action", json={"action": "container.start", "target": "web"})
    assert r.status_code == 401


def test_action_rejects_unknown_action(client):
    dev = _pair_one(client)
    r = client.post(f"/api/managed-devices/{dev['id']}/action", json={"action": "rm -rf", "target": "web"})
    assert r.status_code == 400
    assert "allowed" in r.json()["detail"].lower()


def test_action_rejects_bad_container_verb(client):
    dev = _pair_one(client)
    r = client.post(f"/api/managed-devices/{dev['id']}/action", json={"action": "container.nuke", "target": "web"})
    assert r.status_code == 400


def test_action_unknown_device_404(client):
    _bootstrap_admin(client)
    r = client.post("/api/managed-devices/nope/action", json={"action": "container.start", "target": "web"})
    assert r.status_code == 404


def test_container_start_proxies_correctly(client, monkeypatch):
    dev = _pair_one(client, ip="100.64.0.10")
    captured = {}

    def fake_post(ip, port, path, token, payload, *, timeout=20.0):
        captured.update(ip=ip, port=port, path=path, token=token, payload=payload)
        return (200, {"ok": True, "name": "web", "action": "start"})

    monkeypatch.setattr(md, "_proxy_post", fake_post)
    r = client.post(f"/api/managed-devices/{dev['id']}/action", json={"action": "container.start", "target": "web"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == 200
    assert captured["path"] == "/api/podman/containers/web/action"
    assert captured["payload"] == {"action": "start"}
    assert captured["token"] == "the-token"


def test_deploy_trigger_proxies_with_overrides(client, monkeypatch):
    dev = _pair_one(client, ip="100.64.0.11")
    captured = {}

    def fake_post(ip, port, path, token, payload, *, timeout=20.0):
        captured.update(path=path, payload=payload)
        return (201, {"id": "deploy-1"})

    monkeypatch.setattr(md, "_proxy_post", fake_post)
    r = client.post(f"/api/managed-devices/{dev['id']}/action", json={
        "action": "deploy.trigger", "target": "proj-123", "branch": "main", "commit_sha": "abc123",
    })
    assert r.status_code == 200
    assert captured["path"] == "/api/projects/proj-123/deployments"
    assert captured["payload"] == {"branch": "main", "commit_sha": "abc123"}


def test_action_is_audited(client, db_session, monkeypatch):
    dev = _pair_one(client, ip="100.64.0.12")
    monkeypatch.setattr(md, "_proxy_post", lambda *a, **k: (200, {"ok": True}))
    client.post(f"/api/managed-devices/{dev['id']}/action", json={"action": "container.stop", "target": "db"})
    from watchtower.database import AuditEvent
    ev = db_session.query(AuditEvent).filter(AuditEvent.action == "managed_device.action").first()
    assert ev is not None
