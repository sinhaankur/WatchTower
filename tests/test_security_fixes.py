"""Tests covering the H1+M1+M2+M3 security findings.

H1 — POST /api/auth/guest is rate-limited.
M1 — get_current_user populates request.state.user_id so the per-user
     rate-limit key extractor (_key_user_then_remote) actually keys by
     user instead of silently falling back to the remote IP.
M2 — AuditEvent rows reject UPDATE / DELETE at the ORM event layer.
M3 — _redact_sensitive_tokens catches custom credential flags
     (--api-key, --bearer-token) and KEY=value pairs.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from watchtower.api import audit as audit_module
from watchtower.api.runtime import _redact_sensitive_tokens
from watchtower.database import AuditEvent


# ── H1: rate limit on /auth/guest ────────────────────────────────────────────

def test_guest_endpoint_is_rate_limited(anon_client: TestClient, monkeypatch):
    """11 quick guest-token requests from the same IP — the 11th must 429.

    The default budget is 10/minute; we don't actually wait a minute,
    we just verify the limiter engages.
    """
    # Ensure guest mode is on (it's the default but be explicit).
    monkeypatch.setenv("WATCHTOWER_ALLOW_GUEST_MODE", "true")
    statuses = []
    for _ in range(11):
        r = anon_client.post("/api/auth/guest")
        statuses.append(r.status_code)
    assert 429 in statuses, (
        f"Expected at least one 429 in 11 burst requests, got {statuses}"
    )


# ── M1: request.state.user_id wired through ─────────────────────────────────

def test_get_current_user_populates_state_user_id():
    """Direct unit test: calling get_current_user with a fake request
    must set request.state.user_id so the per-user rate-limit key
    extractor (_key_user_then_remote) keys by user instead of falling
    back to the remote IP.
    """
    from types import SimpleNamespace
    from watchtower.api import util

    # Static-token path
    fake_request = SimpleNamespace(state=SimpleNamespace())
    user = util.get_current_user(
        request=fake_request,
        authorization=f"Bearer {__import__('os').environ['WATCHTOWER_API_TOKEN']}",
    )
    assert user["user_id"]
    assert getattr(fake_request.state, "user_id", None) == user["user_id"], (
        "get_current_user must surface user_id on request.state"
    )


# ── M2: AuditEvent is append-only at the ORM layer ──────────────────────────

def test_audit_event_delete_is_blocked(db_session):
    """Trying to db.delete() an existing audit row must raise."""
    e = AuditEvent(action="test.create", entity_type="test")
    db_session.add(e)
    db_session.flush()
    db_session.delete(e)
    with pytest.raises(audit_module.AuditLogImmutableError):
        db_session.flush()
    db_session.rollback()


def test_audit_event_update_is_blocked(db_session):
    """Mutating an existing audit row must raise."""
    e = AuditEvent(action="test.update", entity_type="test")
    db_session.add(e)
    db_session.flush()
    db_session.refresh(e)
    e.action = "tampered"
    with pytest.raises(audit_module.AuditLogImmutableError):
        db_session.flush()
    db_session.rollback()


# ── M3: redaction catches custom credential names ───────────────────────────

@pytest.mark.parametrize(
    "argv,expected",
    [
        # Long-form flags the old code missed
        (["curl", "--api-key", "supersecret"], ["curl", "--api-key", "***"]),
        (["cli", "--bearer-token", "abc"], ["cli", "--bearer-token", "***"]),
        (["cli", "--gh-pat", "ghp_xxx"], ["cli", "--gh-pat", "***"]),
        # KEY=VALUE form with custom prefix
        (["env", "WATCHTOWER_TOKEN=hunter2"], ["env", "WATCHTOWER_TOKEN=***"]),
        (["env", "GITHUB_API_KEY=foo"], ["env", "GITHUB_API_KEY=***"]),
        # Existing patterns still work
        (["mysql", "-p", "root123"], ["mysql", "-p", "***"]),
        (["docker", "login", "--password", "x"], ["docker", "login", "--password", "***"]),
        # Non-secret args untouched
        (["ls", "-la", "/tmp"], ["ls", "-la", "/tmp"]),
        (["echo", "hello world"], ["echo", "hello world"]),
    ],
)
def test_redact_handles_custom_credential_flags(argv, expected):
    assert _redact_sensitive_tokens(argv) == expected


def test_redact_does_not_match_innocent_substrings():
    # "monkey" contains "key" but isn't a credential flag — must not redact.
    argv = ["echo", "monkey", "--keyboard", "qwerty"]
    out = _redact_sensitive_tokens(argv)
    # "--keyboard" ends in "board", not in a credential suffix → not redacted.
    # "qwerty" should pass through.
    assert out == argv
