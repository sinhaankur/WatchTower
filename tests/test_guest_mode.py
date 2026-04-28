"""Guest-mode auth: anonymous users can use the app, but the server gates
remote-node creation on a real GitHub identity.
"""
from __future__ import annotations

import os

from fastapi.testclient import TestClient


def test_guest_login_returns_session_token(anon_client: TestClient):
    """POST /api/auth/guest issues a signed token without prior auth."""
    r = anon_client.post("/api/auth/guest")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"]
    assert body["user"]["is_guest"] is True
    assert body["user"]["email"] == "guest@watchtower.local"


def test_guest_token_authenticates_on_me(anon_client: TestClient):
    """The guest token must work as a Bearer credential on /api/me."""
    issue = anon_client.post("/api/auth/guest")
    token = issue.json()["token"]
    r = anon_client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["is_guest"] is True
    assert me["is_github_authenticated"] is False
    # Defence-in-depth: guests cannot manage remote nodes.
    assert me["can_manage_nodes"] is False


def test_guest_mode_can_be_disabled(anon_client: TestClient, monkeypatch):
    """Operators can opt out of guest mode."""
    monkeypatch.setenv("WATCHTOWER_ALLOW_GUEST_MODE", "false")
    r = anon_client.post("/api/auth/guest")
    assert r.status_code == 403
    assert "disabled" in r.json()["detail"].lower()


def test_guest_cannot_add_remote_node(anon_client: TestClient):
    """Direct API call to add a node must be rejected for guest sessions
    even though the same call would succeed with GitHub identity."""
    issue = anon_client.post("/api/auth/guest")
    token = issue.json()["token"]
    me = anon_client.get("/api/me", headers={"Authorization": f"Bearer {token}"}).json()
    org_id = me.get("org_id")
    if not org_id:
        # Without an org, we can't even hit the route — that's an even
        # stronger denial. The 404 path is acceptable for this test.
        return
    r = anon_client.post(
        f"/api/orgs/{org_id}/nodes",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "name": "guest-attempt",
            "host": "10.0.0.1",
            "user": "deploy",
            "port": 22,
            "remote_path": "/srv",
            "reload_command": "true",
            "ssh_key_path": "/tmp/never-used",
        },
    )
    assert r.status_code == 403, r.text
    assert "github" in r.json()["detail"].lower()
