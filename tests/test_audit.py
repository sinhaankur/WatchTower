"""Tests for the audit log (audit-review item #10).

Verifies that mutations across the API surface produce AuditEvent rows,
that the read endpoint scopes to the caller's organization, and that
secret values (env-var values) NEVER appear in the audit metadata.
"""
from __future__ import annotations

import json
from uuid import UUID

from fastapi.testclient import TestClient

from watchtower.database import AuditEvent


# ── Helpers ──────────────────────────────────────────────────────────────────

def _create_project(client: TestClient, name: str = "audit-target") -> dict:
    r = client.post(
        "/api/projects",
        json={
            "name": name,
            "use_case": "vercel_like",
            "repo_url": f"https://example.com/{name}.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# ── Project lifecycle audit ──────────────────────────────────────────────────

def test_project_create_writes_audit_event(client: TestClient, db_session):
    proj = _create_project(client, "alpha")

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.create")
        .all()
    )
    assert len(rows) == 1
    e = rows[0]
    assert str(e.entity_id) == proj["id"]
    assert e.entity_type == "project"
    extra = json.loads(e.extra_json)
    assert extra["name"] == "alpha"
    assert extra["repo_url"].endswith("alpha.git")


def test_project_update_records_diff(client: TestClient, db_session):
    proj = _create_project(client, "beta")
    r = client.put(f"/api/projects/{proj['id']}", json={"repo_branch": "develop"})
    assert r.status_code == 200

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.update")
        .filter(AuditEvent.entity_id == UUID(proj["id"]))
        .all()
    )
    assert len(rows) == 1
    extra = json.loads(rows[0].extra_json)
    assert extra["changes"]["repo_branch"] == {"from": "main", "to": "develop"}


def test_project_update_with_no_changes_writes_no_audit(client: TestClient, db_session):
    """Updating with the same values shouldn't produce a noisy audit row."""
    proj = _create_project(client, "gamma")
    # Send the value it already has — no real change
    r = client.put(f"/api/projects/{proj['id']}", json={"repo_branch": "main"})
    assert r.status_code == 200

    update_rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.update")
        .filter(AuditEvent.entity_id == UUID(proj["id"]))
        .all()
    )
    assert update_rows == []


def test_project_delete_writes_audit_event(client: TestClient, db_session):
    proj = _create_project(client, "delta")
    r = client.delete(f"/api/projects/{proj['id']}")
    assert r.status_code == 204

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.delete")
        .filter(AuditEvent.entity_id == UUID(proj["id"]))
        .all()
    )
    assert len(rows) == 1


# ── Env-var audit (sensitive — secrecy of value is critical) ────────────────

def test_envvar_create_records_key_but_NEVER_value(client: TestClient, db_session):
    """The whole point of env vars is the value is secret. The audit row
    captures the key (so operators can answer "who changed DATABASE_URL?")
    but MUST NOT capture the value itself."""
    proj = _create_project(client, "secret-host")
    secret_value = "postgres://supersecret-do-not-leak-this@db/prod"
    r = client.post(
        f"/api/projects/{proj['id']}/env",
        json={"key": "DATABASE_URL", "value": secret_value, "environment": "production"},
    )
    assert r.status_code == 201, r.text

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "envvar.create")
        .all()
    )
    assert len(rows) == 1
    extra_json = rows[0].extra_json or ""
    extra = json.loads(extra_json)
    # Key IS recorded — that's the point of the audit.
    assert extra["key"] == "DATABASE_URL"
    assert extra["environment"] == "production"
    # Value is NEVER recorded — defence in depth: this assert is the whole test.
    assert "supersecret" not in extra_json
    assert "supersecret" not in (rows[0].extra_json or "")


def test_envvar_delete_records_audit(client: TestClient, db_session):
    proj = _create_project(client, "del-env-host")
    create = client.post(
        f"/api/projects/{proj['id']}/env",
        json={"key": "API_KEY", "value": "secret123", "environment": "staging"},
    )
    env_id = create.json()["id"]

    r = client.delete(f"/api/projects/{proj['id']}/env/{env_id}")
    assert r.status_code == 204

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "envvar.delete")
        .all()
    )
    assert len(rows) == 1
    extra = json.loads(rows[0].extra_json)
    assert extra["key"] == "API_KEY"
    # No value snapshot
    assert "secret123" not in (rows[0].extra_json or "")


# ── Read endpoint scoping ────────────────────────────────────────────────────
# All read tests run with WATCHTOWER_TIER=pro because the GET /api/audit
# endpoint is gated behind the Pro tier (added in 1.12). The audit-WRITE
# behavior covered earlier in this file is not gated — every install
# captures audit events; only the read view requires Pro.

def test_audit_read_endpoint_returns_recent_events(client: TestClient, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_TIER", "pro")
    proj = _create_project(client, "list-host")
    client.put(f"/api/projects/{proj['id']}", json={"repo_branch": "next"})

    r = client.get("/api/audit?limit=50")
    assert r.status_code == 200
    body = r.json()
    actions = [e["action"] for e in body]
    assert "project.create" in actions
    assert "project.update" in actions


def test_audit_read_filters_by_entity_type(client: TestClient, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_TIER", "pro")
    _create_project(client, "alpha-type")
    proj = _create_project(client, "beta-type")
    # mutate to create another row (project.update on beta-type only)
    client.put(f"/api/projects/{proj['id']}", json={"repo_branch": "qa"})

    r = client.get("/api/audit?entity_type=project&action=project.update")
    assert r.status_code == 200
    rows = r.json()
    assert all(e["action"] == "project.update" for e in rows)
    assert all(e["entity_type"] == "project" for e in rows)


def test_audit_read_includes_request_id_for_traceability(client: TestClient, monkeypatch):
    """Operators trace incidents by request ID — verify the column flows."""
    monkeypatch.setenv("WATCHTOWER_TIER", "pro")
    custom_rid = "trace-incident-12345"
    client.post(
        "/api/projects",
        headers={"X-Request-ID": custom_rid},
        json={
            "name": "trace-host",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/trace.git",
            "repo_branch": "main",
        },
    )

    r = client.get("/api/audit?action=project.create")
    assert r.status_code == 200
    rows = r.json()
    matching = [e for e in rows if e.get("request_id") == custom_rid]
    assert matching, "Expected at least one audit event with the custom request_id"


def test_audit_read_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/audit")
    assert r.status_code == 401


def test_audit_read_returns_402_on_free_tier(client: TestClient, monkeypatch):
    """Free-tier installs hit a 402 Payment Required with a structured detail
    that the frontend uses to render the upgrade card. Regression guard for
    the Pro-gating in 1.12."""
    monkeypatch.delenv("WATCHTOWER_TIER", raising=False)
    r = client.get("/api/audit")
    assert r.status_code == 402
    detail = r.json()["detail"]
    assert detail["tier"] == "free"
    assert detail["feature"] == "audit-log"
    assert "Audit Log" in detail["feature_name"]
