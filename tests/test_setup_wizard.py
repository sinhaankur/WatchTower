"""Setup wizard — the first thing a NEW user completes.

This path was previously untested (24% coverage). Per the project's own
principle (untested code eventually fails in front of a user), these pin the
first-run contract: a project is created with its config + encrypted env vars,
duplicate names 409, and bad input doesn't 500.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from watchtower.database import EnvironmentVariable
from watchtower.api.envvars import dec_value


def _wizard_payload(name: str, **over) -> dict:
    base = {
        "project_name": name,
        "use_case": "vercel_like",
        "deployment_model": "self_hosted",
        "source_type": "github",
        "repo_url": "https://example.com/x.git",
        "repo_branch": "main",
        "build_command": "npm run build",
        "recommended_port": 8080,
    }
    base.update(over)
    return base


def test_wizard_creates_project(client: TestClient):
    r = client.post("/api/setup/wizard/complete", json=_wizard_payload("wiz-basic"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "wiz-basic"
    assert body["use_case"] == "vercel_like"


def test_wizard_duplicate_name_returns_409(client: TestClient):
    client.post("/api/setup/wizard/complete", json=_wizard_payload("wiz-dup"))
    r = client.post("/api/setup/wizard/complete", json=_wizard_payload("wiz-dup"))
    assert r.status_code == 409, r.text
    assert "already exists" in r.json()["detail"]


def test_wizard_encrypts_env_vars(client: TestClient, db_session):
    """Env vars supplied during setup must land encrypted at rest — the
    wizard is a common place a user pastes their first DB password."""
    r = client.post("/api/setup/wizard/complete", json=_wizard_payload(
        "wiz-env",
        environment_variables=[
            {"key": "DB_PASSWORD", "value": "s3cr3t-pw", "environment": "production"},
        ],
    ))
    assert r.status_code == 201, r.text
    row = db_session.query(EnvironmentVariable).filter_by(key="DB_PASSWORD").first()
    assert row is not None
    assert row.value != "s3cr3t-pw", "wizard stored env var as PLAINTEXT"
    assert dec_value(row.value) == "s3cr3t-pw"


def test_wizard_requires_auth(anon_client: TestClient):
    r = anon_client.post("/api/setup/wizard/complete", json=_wizard_payload("wiz-noauth"))
    assert r.status_code == 401


def test_wizard_rejects_malformed_payload(client: TestClient):
    # Missing required fields → 422 validation, never a 500.
    r = client.post("/api/setup/wizard/complete", json={"project_name": "x"})
    assert r.status_code == 422
