"""Tests for the GET /api/diagnose self-diagnostic endpoint.

Verifies that:
  - The endpoint requires auth
  - Each subsystem reports the expected status under different env-var
    states (set / unset / malformed)
  - The summary counts match the per-check statuses
  - The response shape is stable enough for the SPA's Diagnostics tab

The endpoint is the operator's primary self-service troubleshoot
surface (Settings → Diagnostics) — regressions here will land users
back in "ask Claude what's wrong" territory.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def _get(client: TestClient) -> dict:
    r = client.get("/api/diagnose")
    assert r.status_code == 200, r.text
    return r.json()


def _check(report: dict, check_id: str) -> dict:
    matches = [c for c in report["checks"] if c["id"] == check_id]
    assert len(matches) == 1, f"missing check '{check_id}'"
    return matches[0]


# ── Auth gate ───────────────────────────────────────────────────────────────

def test_diagnose_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/diagnose")
    assert r.status_code == 401


# ── Shape ───────────────────────────────────────────────────────────────────

def test_diagnose_returns_structured_report(client: TestClient):
    body = _get(client)
    assert "checks" in body
    assert "summary" in body
    assert "version" in body
    assert "checked_at" in body

    expected_ids = {
        "database",
        "fernet_key",
        "api_token",
        "github_oauth",
        "github_device_flow",
        "smtp",
        "llm_agent",
        "redis",
        "migration_head",
        "web_dist",
    }
    actual_ids = {c["id"] for c in body["checks"]}
    assert expected_ids <= actual_ids, f"missing: {expected_ids - actual_ids}"

    # Every check has the contract fields.
    for c in body["checks"]:
        assert c["id"] and c["name"] and c["status"]
        assert c["status"] in {"ok", "warn", "fail"}

    # Summary is internally consistent.
    summary_total = body["summary"]["ok"] + body["summary"]["warn"] + body["summary"]["fail"]
    assert summary_total == len(body["checks"])


# ── Database ────────────────────────────────────────────────────────────────

def test_database_check_ok_in_test_env(client: TestClient):
    body = _get(client)
    assert _check(body, "database")["status"] == "ok"


# ── Fernet key ──────────────────────────────────────────────────────────────

def test_fernet_key_check_ok_in_test_env(client: TestClient):
    body = _get(client)
    assert _check(body, "fernet_key")["status"] == "ok"


# ── API token ───────────────────────────────────────────────────────────────

def test_api_token_check_warn_when_dev_token(monkeypatch):
    # Call the check function directly. The HTTP path is exercised by the
    # auth-gate test above; here we want to verify the check's behaviour
    # under each env-var state without fighting the auth dep, which itself
    # reads WATCHTOWER_API_TOKEN.
    from watchtower.api.diagnose import _check_api_token
    monkeypatch.setenv("WATCHTOWER_API_TOKEN", "dev-watchtower-token")
    chk = _check_api_token()
    assert chk.status == "warn"
    assert "dev" in (chk.detail or "").lower()


def test_api_token_check_ok_when_strong_token(monkeypatch):
    from watchtower.api.diagnose import _check_api_token
    monkeypatch.setenv("WATCHTOWER_API_TOKEN", "real-strong-token")
    chk = _check_api_token()
    assert chk.status == "ok"


def test_api_token_check_fail_when_unset(monkeypatch):
    from watchtower.api.diagnose import _check_api_token
    monkeypatch.delenv("WATCHTOWER_API_TOKEN", raising=False)
    chk = _check_api_token()
    assert chk.status == "fail"
    assert chk.hint and "WATCHTOWER_API_TOKEN" in chk.hint


# ── GitHub OAuth / Device Flow ──────────────────────────────────────────────

def test_github_oauth_check_warn_when_unconfigured(client: TestClient, monkeypatch):
    for var in ("GITHUB_OAUTH_CLIENT_ID", "GITHUB_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"):
        monkeypatch.delenv(var, raising=False)
    body = _get(client)
    assert _check(body, "github_oauth")["status"] == "warn"


def test_github_oauth_check_ok_when_both_set(client: TestClient, monkeypatch):
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "test-client-secret")
    body = _get(client)
    assert _check(body, "github_oauth")["status"] == "ok"


def test_github_oauth_check_warn_when_only_id(client: TestClient, monkeypatch):
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "test-client-id")
    monkeypatch.delenv("GITHUB_OAUTH_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("GITHUB_CLIENT_SECRET", raising=False)
    body = _get(client)
    chk = _check(body, "github_oauth")
    assert chk["status"] == "warn"
    assert "partial" in chk["detail"].lower()


def test_device_flow_check_ok_with_default_client_id(client: TestClient, monkeypatch):
    for var in ("WATCHTOWER_GITHUB_DEVICE_CLIENT_ID", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_CLIENT_ID"):
        monkeypatch.delenv(var, raising=False)
    body = _get(client)
    # Falls back to baked-in default — should still be ok.
    assert _check(body, "github_device_flow")["status"] == "ok"


# ── SMTP ────────────────────────────────────────────────────────────────────

def test_smtp_check_warn_when_unset(client: TestClient, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_SMTP_HOST", raising=False)
    body = _get(client)
    chk = _check(body, "smtp")
    assert chk["status"] == "warn"
    assert "invite" in chk["hint"].lower()


def test_smtp_check_ok_when_configured(client: TestClient, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_SMTP_HOST", "smtp.example.com")
    body = _get(client)
    assert _check(body, "smtp")["status"] == "ok"


# ── LLM ─────────────────────────────────────────────────────────────────────

def test_llm_check_warn_when_unset(client: TestClient, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_LLM_BASE_URL", raising=False)
    body = _get(client)
    assert _check(body, "llm_agent")["status"] == "warn"


def test_llm_check_ok_when_set(client: TestClient, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://localhost:11434/v1")
    body = _get(client)
    assert _check(body, "llm_agent")["status"] == "ok"


# ── Redis ───────────────────────────────────────────────────────────────────

def test_redis_check_warn_when_unset(client: TestClient, monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    body = _get(client)
    chk = _check(body, "redis")
    assert chk["status"] == "warn"
    assert "BackgroundTasks" in chk["detail"]


# ── web/dist ────────────────────────────────────────────────────────────────

def test_web_dist_check_ok_in_dev_clone(client: TestClient):
    # The repo has web/dist built; conftest doesn't move us out of the repo.
    body = _get(client)
    assert _check(body, "web_dist")["status"] == "ok"
