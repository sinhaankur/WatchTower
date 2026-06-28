"""Org-scoped notification webhooks (/api/org-webhooks).

Installation-wide webhooks (project_id NULL) for control-plane / org-level
events. Admin-gated (can_manage_team). The static-token caller becomes an org
OWNER (can_manage_team=True) once an org is bootstrapped, so a project create
unlocks these endpoints.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def _bootstrap_admin(client: TestClient) -> None:
    r = client.post("/api/projects", json={
        "name": "orgwh-bootstrap", "use_case": "vercel_like",
        "repo_url": "https://example.com/o.git", "repo_branch": "main",
    })
    assert r.status_code == 201, r.text


# ── auth / admin gate ─────────────────────────────────────────────────────────


def test_requires_auth(anon_client: TestClient):
    assert anon_client.get("/api/org-webhooks").status_code == 401
    assert anon_client.post("/api/org-webhooks", json={}).status_code == 401


def test_requires_manage_team(client: TestClient):
    from unittest.mock import patch
    # Force the gate closed regardless of bootstrap state.
    with patch("watchtower.api.enterprise._ensure_user_org_member") as m:
        from types import SimpleNamespace
        m.return_value = (SimpleNamespace(), SimpleNamespace(id="x"),
                          SimpleNamespace(can_manage_team=False))
        r = client.post("/api/org-webhooks", json={
            "provider": "slack", "url": "https://hooks.slack.com/services/x",
        })
    assert r.status_code == 403


# ── CRUD ──────────────────────────────────────────────────────────────────────


def test_create_list_delete_org_webhook(client: TestClient):
    _bootstrap_admin(client)

    # create
    r = client.post("/api/org-webhooks", json={
        "provider": "slack", "url": "https://hooks.slack.com/services/ABC/DEF",
        "label": "ops-channel",
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["provider"] == "slack"
    assert body["project_id"] is None
    wid = body["id"]

    # list — present
    lst = client.get("/api/org-webhooks").json()
    assert any(h["id"] == wid for h in lst)

    # delete
    assert client.delete(f"/api/org-webhooks/{wid}").status_code == 204
    lst2 = client.get("/api/org-webhooks").json()
    assert not any(h["id"] == wid for h in lst2)


def test_create_rejects_bad_provider(client: TestClient):
    _bootstrap_admin(client)
    r = client.post("/api/org-webhooks", json={"provider": "telegram", "url": "https://x"})
    assert r.status_code == 422


def test_create_rejects_wrong_slack_url(client: TestClient):
    _bootstrap_admin(client)
    r = client.post("/api/org-webhooks", json={
        "provider": "slack", "url": "https://example.com/not-slack",
    })
    assert r.status_code == 422
    assert "slack" in r.json()["detail"].lower()


def test_list_excludes_project_scoped_hooks(client: TestClient, db_session):
    """Org list must show only org-scoped (project_id NULL) hooks, not the
    per-project ones managed under /api/projects."""
    import uuid
    from watchtower.database import NotificationWebhook
    from watchtower.api import enterprise

    _bootstrap_admin(client)
    # Resolve the caller's org.
    org = enterprise._ensure_user_org_member(
        db_session,
        {"user_id": str(uuid.uuid5(uuid.NAMESPACE_DNS, "watchtower-static-token-user")),
         "email": "developer@watchtower.local"},
    )[1]
    # A project-scoped hook in the same org — must NOT appear in org list.
    db_session.add(NotificationWebhook(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=org.id,
        provider="slack", url="https://hooks.slack.com/services/proj", is_active=True,
    ))
    db_session.commit()

    lst = client.get("/api/org-webhooks").json()
    assert all(h["project_id"] is None for h in lst)
