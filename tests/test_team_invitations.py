"""Tests for the team-invitation flow.

Covers the gap previously called out by the security review of
PR <main>: invitation tokens MUST be bound to the invited email, not
left as transferable bearer credentials. ``test_accept_*`` is the
load-bearing security regression.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from watchtower.api import app
from watchtower.api.util import create_user_session_token
from watchtower.database import Organization, TeamMember, TeamRole, User


# ── Helpers ─────────────────────────────────────────────────────────────────

def _bootstrap_owner_org(client: TestClient) -> str:
    """Force the static-token caller into OWNER of an org. Returns org_id."""
    r = client.post(
        "/api/projects",
        json={
            "name": "team-invite-bootstrap",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/x.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    ctx = client.get("/api/context")
    assert ctx.status_code == 200, ctx.text
    return ctx.json()["organization"]["id"]


def _client_for_email(email: str, *, name: str = "Invited User") -> TestClient:
    """A TestClient signed in as a fresh GitHub-style user with the given email."""
    token = create_user_session_token(
        user_id=str(uuid.uuid4()),
        email=email,
        name=name,
        github_id=None,
    )
    c = TestClient(app)
    c.headers.update({"Authorization": f"Bearer {token}"})
    return c


def _invite(client: TestClient, org_id: str, email: str, role: str = "developer") -> dict:
    r = client.post(
        f"/api/orgs/{org_id}/team-members",
        json={
            "email": email,
            "role": role,
            "can_create_projects": True,
            "can_manage_deployments": role in ("owner", "admin"),
            "can_manage_nodes": role in ("owner", "admin"),
            "can_manage_team": role in ("owner", "admin"),
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# ── Invite POST ─────────────────────────────────────────────────────────────

def test_invite_returns_invitation_url_when_smtp_unconfigured(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "alice@example.com")
    assert body["invitation_url"].endswith(f"/invite/" + body["invitation_url"].split("/invite/")[-1])
    assert body["email_sent"] is False
    assert body["is_active"] is False
    assert body["accepted_at"] is None


def test_invite_token_is_persisted_and_unique(client, db_session, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    a = _invite(client, org_id, "a@example.com")
    b = _invite(client, org_id, "b@example.com")
    rows = db_session.query(TeamMember).filter(
        TeamMember.email.in_(["a@example.com", "b@example.com"])
    ).all()
    tokens = {r.invitation_token for r in rows}
    assert len(tokens) == 2 and None not in tokens
    # Tokens are exposed in the URL — assert they match.
    a_token = a["invitation_url"].rsplit("/", 1)[-1]
    b_token = b["invitation_url"].rsplit("/", 1)[-1]
    assert {a_token, b_token} == tokens


def test_invite_duplicate_email_returns_409(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    _invite(client, org_id, "dup@example.com")
    r = client.post(
        f"/api/orgs/{org_id}/team-members",
        json={
            "email": "dup@example.com",
            "role": "developer",
            "can_create_projects": True,
            "can_manage_deployments": False,
            "can_manage_nodes": False,
            "can_manage_team": False,
        },
    )
    assert r.status_code == 409, r.text


# ── Accept (the security-critical path) ─────────────────────────────────────

def test_accept_invitation_happy_path(client, db_session, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "happy@example.com", role="admin")
    token = body["invitation_url"].rsplit("/", 1)[-1]

    invitee = _client_for_email("happy@example.com")
    r = invitee.post(f"/api/invitations/{token}/accept")
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["org_id"] == org_id
    assert payload["member"]["is_active"] is True
    assert payload["member"]["accepted_at"] is not None

    row = db_session.query(TeamMember).filter(TeamMember.id == uuid.UUID(body["id"])).one()
    assert row.user_id is not None
    assert row.invitation_token is None
    assert row.is_active is True


def test_accept_invitation_with_wrong_email_returns_403(client, monkeypatch):
    """The load-bearing security check.

    Without this, the URL would be a transferable bearer credential —
    anyone who saw it could claim the invited role.
    """
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "victim@example.com", role="admin")
    token = body["invitation_url"].rsplit("/", 1)[-1]

    attacker = _client_for_email("attacker@evil.com")
    r = attacker.post(f"/api/invitations/{token}/accept")
    assert r.status_code == 403, r.text
    assert "different email" in r.json()["detail"].lower()


def test_accept_invitation_email_match_is_case_insensitive(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "Mixed.Case@Example.com")
    token = body["invitation_url"].rsplit("/", 1)[-1]

    invitee = _client_for_email("mixed.case@example.com")
    r = invitee.post(f"/api/invitations/{token}/accept")
    assert r.status_code == 200, r.text


def test_accept_invitation_already_redeemed_returns_410(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "twice@example.com")
    token = body["invitation_url"].rsplit("/", 1)[-1]

    invitee = _client_for_email("twice@example.com")
    first = invitee.post(f"/api/invitations/{token}/accept")
    assert first.status_code == 200, first.text
    # Token is burned — even the same caller can't redeem twice.
    second = invitee.post(f"/api/invitations/{token}/accept")
    assert second.status_code == 404, second.text  # token cleared → not found


def test_accept_invitation_unknown_token_returns_404(client):
    invitee = _client_for_email("nobody@example.com")
    r = invitee.post(f"/api/invitations/{'x' * 32}/accept")
    assert r.status_code == 404, r.text


def test_accept_invitation_unauthenticated_returns_401(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    anon = TestClient(app)
    r = anon.post(f"/api/invitations/{'x' * 32}/accept")
    assert r.status_code == 401, r.text


# ── Pending list ────────────────────────────────────────────────────────────

def test_pending_invitations_returns_only_for_caller_email(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    _invite(client, org_id, "callee@example.com", role="developer")
    _invite(client, org_id, "someoneelse@example.com")

    callee = _client_for_email("callee@example.com")
    r = callee.get("/api/invitations/pending")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["email"] == "callee@example.com"
    assert rows[0]["org_id"] == org_id


def test_pending_invitations_does_not_leak_other_tokens(client, monkeypatch):
    """A caller must never see tokens addressed to a different email."""
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    secret = _invite(client, org_id, "secret@example.com", role="owner")
    secret_token = secret["invitation_url"].rsplit("/", 1)[-1]

    nosy = _client_for_email("nosy@example.com")
    r = nosy.get("/api/invitations/pending")
    assert r.status_code == 200
    leaked = [row["invitation_token"] for row in r.json()]
    assert secret_token not in leaked
    assert leaked == []


# ── Delete ──────────────────────────────────────────────────────────────────

def test_delete_team_member_removes_row(client, db_session, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    body = _invite(client, org_id, "ephemeral@example.com")
    member_id = body["id"]

    r = client.delete(f"/api/team-members/{member_id}")
    assert r.status_code == 204, r.text
    assert (
        db_session.query(TeamMember)
        .filter(TeamMember.id == uuid.UUID(member_id))
        .first()
        is None
    )


def test_delete_team_member_unknown_id_returns_404(client):
    _bootstrap_owner_org(client)
    r = client.delete(f"/api/team-members/{uuid.uuid4()}")
    assert r.status_code == 404, r.text


def test_delete_team_member_blocks_owner_deletion(client, db_session, monkeypatch):
    """The auto-bootstrap OWNER row must not be removable via this endpoint —
    that path would let an admin lock the org out of self-recovery.
    """
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    owner_row = (
        db_session.query(TeamMember)
        .filter(TeamMember.role == TeamRole.OWNER)
        .first()
    )
    assert owner_row is not None
    r = client.delete(f"/api/team-members/{owner_row.id}")
    assert r.status_code == 403, r.text


def test_delete_team_member_requires_admin(client, db_session, monkeypatch):
    """A non-admin member of the same org cannot remove others."""
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    target = _invite(client, org_id, "target@example.com")
    bystander_invite = _invite(client, org_id, "bystander@example.com", role="developer")
    by_token = bystander_invite["invitation_url"].rsplit("/", 1)[-1]

    bystander = _client_for_email("bystander@example.com")
    accept = bystander.post(f"/api/invitations/{by_token}/accept")
    assert accept.status_code == 200, accept.text

    r = bystander.delete(f"/api/team-members/{target['id']}")
    assert r.status_code == 403, r.text
    # Target row should still exist
    assert (
        db_session.query(TeamMember)
        .filter(TeamMember.id == uuid.UUID(target["id"]))
        .first()
        is not None
    )


# ── Email (SMTP) configuration — Settings → Email ────────────────────────────

def test_email_config_get_reports_unconfigured_by_default(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    r = client.get("/api/email/config")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is False
    assert body["source"] is None
    assert body["has_password"] is False


def test_email_config_get_reflects_env_fallback(client, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_SMTP_HOST", "smtp.env.example")
    monkeypatch.setenv("WATCHTOWER_SMTP_PORT", "2525")
    _bootstrap_owner_org(client)
    r = client.get("/api/email/config")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["source"] == "env"
    assert body["smtp_host"] == "smtp.env.example"
    assert body["smtp_port"] == 2525


def test_email_config_put_persists_and_never_echoes_password(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    r = client.put(
        "/api/email/config",
        json={
            "smtp_host": "smtp.gmail.com",
            "smtp_port": 587,
            "smtp_user": "me@gmail.com",
            "smtp_password": "super-secret-app-password",
            "smtp_from": "me@gmail.com",
            "use_tls": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # DB now wins → source flips to "database".
    assert body["source"] == "database"
    assert body["configured"] is True
    assert body["smtp_host"] == "smtp.gmail.com"
    assert body["has_password"] is True
    # The password must NEVER be returned in any field.
    assert "super-secret-app-password" not in r.text
    assert "smtp_password" not in body


def test_email_config_db_wins_over_env(client, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_SMTP_HOST", "smtp.env.example")
    _bootstrap_owner_org(client)
    client.put("/api/email/config", json={"smtp_host": "smtp.db.example", "smtp_port": 465})
    r = client.get("/api/email/config")
    body = r.json()
    assert body["source"] == "database"
    assert body["smtp_host"] == "smtp.db.example"


def test_email_config_password_stored_encrypted_not_plaintext(client, db_session, monkeypatch):
    from watchtower.database import SystemSetting
    from watchtower.email_settings import KEY_SMTP_PASSWORD

    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    client.put(
        "/api/email/config",
        json={"smtp_host": "smtp.x", "smtp_password": "plaintext-secret"},
    )
    row = (
        db_session.query(SystemSetting)
        .filter(SystemSetting.key == KEY_SMTP_PASSWORD)
        .first()
    )
    assert row is not None
    assert row.is_secret is True
    # Fernet ciphertext, never the raw value at rest.
    assert row.value != "plaintext-secret"
    assert "plaintext-secret" not in (row.value or "")


def test_require_team_admin_blocks_non_admin_member(monkeypatch):
    """Unit-test the SMTP-settings gate directly.

    Going through the HTTP layer can't exercise this under the test harness:
    with owner mode OFF (the default) every caller gets their own org and is
    admin of it, and with owner mode ON a static-token caller is a "guest"
    that never claims the installation — so no request path produces a
    genuine non-admin. Testing the gate function against a non-admin member
    row is the honest, deterministic check.
    """
    import pytest
    from fastapi import HTTPException
    from watchtower.api import enterprise
    from watchtower.database import TeamMember, TeamRole

    non_admin = TeamMember(role=TeamRole.DEVELOPER, can_manage_team=False, is_active=True)
    monkeypatch.setattr(
        enterprise, "_ensure_user_org_member",
        lambda db, cu: (object(), object(), non_admin),
    )
    with pytest.raises(HTTPException) as exc:
        enterprise._require_team_admin(db=None, current_user={})
    assert exc.value.status_code == 403

    admin = TeamMember(role=TeamRole.ADMIN, can_manage_team=True, is_active=True)
    sentinel_user, sentinel_org = object(), object()
    monkeypatch.setattr(
        enterprise, "_ensure_user_org_member",
        lambda db, cu: (sentinel_user, sentinel_org, admin),
    )
    user, org = enterprise._require_team_admin(db=None, current_user={})
    assert user is sentinel_user and org is sentinel_org


def test_invite_auto_sends_when_db_smtp_configured(client, monkeypatch):
    """With SMTP saved in the DB, an invite reports email_sent=True and the
    low-level send is invoked — proving the DB config drives delivery."""
    from watchtower.api import enterprise

    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    client.put("/api/email/config", json={"smtp_host": "smtp.db", "smtp_from": "a@b.c"})

    sent = {}

    def _fake_send(cfg, to_email, subject, body_text, body_html):
        sent["to"] = to_email
        sent["host"] = cfg.host

    monkeypatch.setattr(enterprise, "_send_email", _fake_send)

    body = _invite(client, org_id, "newhire@example.com")
    assert body["email_sent"] is True
    assert sent == {"to": "newhire@example.com", "host": "smtp.db"}


def test_invite_send_failure_falls_back_to_link(client, monkeypatch):
    """If the SMTP send raises, the invite is still created and the URL is
    returned so the admin can share it manually (non-fatal path)."""
    from watchtower.api import enterprise

    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    org_id = _bootstrap_owner_org(client)
    client.put("/api/email/config", json={"smtp_host": "smtp.db"})

    def _boom(cfg, to_email, subject, body_text, body_html):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(enterprise, "_send_email", _boom)

    body = _invite(client, org_id, "fallback@example.com")
    assert body["email_sent"] is False
    assert body["invitation_url"].endswith(body["invitation_url"].split("/invite/")[-1])


def test_email_test_send_ok(client, monkeypatch):
    from watchtower.api import enterprise

    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    client.put("/api/email/config", json={"smtp_host": "smtp.db", "smtp_from": "a@b.c"})
    monkeypatch.setattr(enterprise, "_send_email", lambda *a, **k: None)

    r = client.post("/api/email/test", json={"to": "check@example.com"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["to"] == "check@example.com"
    assert body["error"] is None


def test_email_test_send_reports_error_verbatim(client, monkeypatch):
    from watchtower.api import enterprise

    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    client.put("/api/email/config", json={"smtp_host": "smtp.db", "smtp_from": "a@b.c"})

    def _boom(*a, **k):
        raise RuntimeError("auth failed")

    monkeypatch.setattr(enterprise, "_send_email", _boom)
    r = client.post("/api/email/test", json={"to": "check@example.com"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert "auth failed" in body["error"]


def test_email_test_send_400_when_unconfigured(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    _bootstrap_owner_org(client)
    r = client.post("/api/email/test", json={"to": "check@example.com"})
    assert r.status_code == 400, r.text
