"""Generic OIDC login — provider-agnostic auth alongside GitHub.

Covers the watchtower.oidc helpers (discovery, code exchange, claim
normalisation, nonce replay guard, SSRF guard) and the /api/auth/oidc/*
routes end to end with the provider's HTTP calls mocked.
"""
from __future__ import annotations

import base64
import json
from unittest.mock import patch

import pytest

from watchtower import oidc
from watchtower.api import util


def _jwt(payload: dict) -> str:
    """Build an unsigned JWT (header.payload.sig) — we only decode the
    payload, authenticity comes from the TLS back-channel (see oidc.py)."""
    def seg(d: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{seg({'alg': 'none'})}.{seg(payload)}.sig"


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture()
def oidc_env(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_OIDC_ISSUER", "https://accounts.example.com")
    monkeypatch.setenv("WATCHTOWER_OIDC_CLIENT_ID", "client-abc")
    monkeypatch.setenv("WATCHTOWER_OIDC_CLIENT_SECRET", "secret-xyz")
    monkeypatch.setenv("WATCHTOWER_OIDC_PROVIDER_NAME", "Example SSO")
    # Explicit endpoints so discover() doesn't need to hit the network.
    monkeypatch.setenv("WATCHTOWER_OIDC_AUTHORIZE_URL", "https://accounts.example.com/authorize")
    monkeypatch.setenv("WATCHTOWER_OIDC_TOKEN_URL", "https://accounts.example.com/token")
    monkeypatch.setenv("WATCHTOWER_OIDC_USERINFO_URL", "https://accounts.example.com/userinfo")
    # The SSRF guard resolves hostnames via DNS; in CI/offline the test host
    # can't (and shouldn't) resolve example.com. This is the documented
    # bypass for exercising outbound-URL code without real DNS — the SSRF
    # guard itself is tested separately (test_discover_ssrf_guard_*).
    monkeypatch.setenv("WATCHTOWER_ALLOW_INTERNAL_HTTP", "true")


# ── helper-level ──────────────────────────────────────────────────────────────


def test_is_configured_reflects_env(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_OIDC_ISSUER", raising=False)
    assert oidc.is_configured() is False


def test_discover_uses_explicit_endpoints(oidc_env):
    cfg = oidc.discover()
    assert cfg.authorize_url == "https://accounts.example.com/authorize"
    assert cfg.token_url == "https://accounts.example.com/token"
    assert cfg.client_id == "client-abc"


def test_discover_ssrf_guard_blocks_internal_issuer(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_OIDC_ISSUER", "https://accounts.example.com")
    monkeypatch.setenv("WATCHTOWER_OIDC_CLIENT_ID", "c")
    monkeypatch.setenv("WATCHTOWER_OIDC_CLIENT_SECRET", "s")
    monkeypatch.setenv("WATCHTOWER_OIDC_AUTHORIZE_URL", "http://169.254.169.254/authorize")
    monkeypatch.setenv("WATCHTOWER_OIDC_TOKEN_URL", "https://accounts.example.com/token")
    monkeypatch.delenv("WATCHTOWER_ALLOW_INTERNAL_HTTP", raising=False)
    with pytest.raises(Exception):  # HTTPException from assert_safe_external_url
        oidc.discover()


def test_claims_from_id_token(oidc_env):
    cfg = oidc.discover()
    id_token = _jwt({"sub": "user-123", "email": "a@example.com", "email_verified": True,
                     "name": "Ada", "nonce": "n1"})
    claims = oidc.claims_from_tokens(cfg, {"id_token": id_token}, expected_nonce="n1")
    assert claims.subject == "https://accounts.example.com|user-123"
    assert claims.email == "a@example.com"
    assert claims.email_verified is True
    assert claims.name == "Ada"


def test_claims_nonce_mismatch_rejected(oidc_env):
    cfg = oidc.discover()
    id_token = _jwt({"sub": "u", "nonce": "attacker"})
    with pytest.raises(oidc.OidcError):
        oidc.claims_from_tokens(cfg, {"id_token": id_token}, expected_nonce="expected")


def test_claims_no_subject_is_error(oidc_env):
    cfg = oidc.discover()
    with pytest.raises(oidc.OidcError):
        oidc.claims_from_tokens(cfg, {"id_token": _jwt({"email": "x@y.z"})}, expected_nonce=None)


# ── route-level ─────────────────────────────────────────────────────────────


def test_status_route_configured(client, oidc_env):
    r = client.get("/api/auth/oidc/status")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["provider_name"] == "Example SSO"


def test_start_route_builds_authorize_url_with_nonce(client, oidc_env):
    r = client.get("/api/auth/oidc/start", params={"redirect_uri": "https://app/cb", "next_path": "/dash"})
    assert r.status_code == 200
    body = r.json()
    assert body["authorize_url"].startswith("https://accounts.example.com/authorize?")
    assert "nonce=" in body["authorize_url"]
    assert "state=" in body["authorize_url"]
    assert body["next"] == "/dash"


def test_callback_creates_user_and_returns_session_token(client, oidc_env, db_session):
    # 1. Get a valid signed state + nonce from /start.
    start = client.get("/api/auth/oidc/start", params={"redirect_uri": "https://app/cb"})
    state = start.json()["state"]

    id_token = _jwt({"sub": "user-999", "email": "new@example.com", "email_verified": True,
                     "name": "New User"})
    # Extract the nonce the server embedded so the callback verifies.
    from watchtower.api.enterprise import _parse_oauth_state
    nonce = _parse_oauth_state(state)["nonce"]
    id_token = _jwt({"sub": "user-999", "email": "new@example.com", "email_verified": True,
                     "name": "New User", "nonce": nonce})

    with patch.object(oidc.requests, "post", return_value=_Resp(200, {"id_token": id_token, "access_token": "at"})):
        r = client.post("/api/auth/oidc/callback", json={
            "code": "auth-code", "state": state, "redirect_uri": "https://app/cb",
        })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"]  # signed WatchTower session token
    assert body["user"]["email"] == "new@example.com"
    assert body["user"]["name"] == "New User"

    # The session token must be a valid WatchTower session for the new user.
    parsed = util._parse_user_session_token(body["token"])
    assert parsed is not None
    assert parsed["email"] == "new@example.com"


def test_callback_rejects_wrong_mode_state(client, oidc_env):
    from watchtower.api.enterprise import _sign_oauth_state
    import time
    # A state signed for the GitHub flow must not be accepted by the OIDC callback.
    bad_state = _sign_oauth_state({"mode": "login", "next": "/", "iat": int(time.time())})
    r = client.post("/api/auth/oidc/callback", json={
        "code": "c", "state": bad_state, "redirect_uri": "https://app/cb",
    })
    assert r.status_code == 400
