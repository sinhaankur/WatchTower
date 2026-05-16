"""API surface for Project.run_as_container (Phase 1 of autonomous global-deploy).

Verifies the field round-trips correctly through POST /projects (create)
and PUT /projects/{id} (update), and that the audit log captures toggles
on a per-change basis."""
from __future__ import annotations

import json
from uuid import UUID

from fastapi.testclient import TestClient

from watchtower.database import AuditEvent


def _create(client: TestClient, name: str, **extra) -> dict:
    body = {
        "name": name,
        "use_case": "vercel_like",
        "repo_url": f"https://example.com/{name}.git",
        "repo_branch": "main",
        **extra,
    }
    r = client.post("/api/projects", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_defaults_run_as_container_to_false(client: TestClient):
    """Existing projects keep the legacy rsync+reload path — opt-in only."""
    proj = _create(client, "container-default-off")
    assert proj["run_as_container"] is False


def test_create_with_run_as_container_true(client: TestClient):
    proj = _create(client, "container-on", run_as_container=True, recommended_port=8090)
    assert proj["run_as_container"] is True
    assert proj["recommended_port"] == 8090


def test_update_can_toggle_run_as_container(client: TestClient, db_session):
    proj = _create(client, "container-toggle", recommended_port=8091)
    assert proj["run_as_container"] is False

    r = client.put(f"/api/projects/{proj['id']}", json={"run_as_container": True})
    assert r.status_code == 200, r.text
    assert r.json()["run_as_container"] is True

    # Audit row should pin the diff so security review can trace who
    # flipped a project to container mode (and when).
    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.update")
        .filter(AuditEvent.entity_id == UUID(proj["id"]))
        .all()
    )
    assert len(rows) == 1
    changes = json.loads(rows[0].extra_json)["changes"]
    assert changes["run_as_container"] == {"from": False, "to": True}


def test_update_with_same_value_writes_no_audit_row(client: TestClient, db_session):
    """No-op toggles must not generate audit noise."""
    proj = _create(client, "container-noop", run_as_container=False)

    r = client.put(f"/api/projects/{proj['id']}", json={"run_as_container": False})
    assert r.status_code == 200

    rows = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "project.update")
        .filter(AuditEvent.entity_id == UUID(proj["id"]))
        .all()
    )
    assert rows == []
