"""Plug-and-play: create a managed DB AND auto-wire it into a project's env
in one call (link_project_id on the create endpoint).

The wiring itself (ProjectDatabaseLink → connection string injected at build
time) is covered by test_project_db_links.py; here we verify the one-click
create+link convenience: the link row is created, the response reports it, and
failures to link never roll back the created database.
"""
from __future__ import annotations

import uuid

import pytest

from watchtower import managed_db_runtime as runtime
from watchtower.database import (
    ManagedDatabase,
    Project,
    ProjectDatabaseLink,
    ProjectSourceType,
    UseCaseType,
)


@pytest.fixture
def fake_podman(monkeypatch):
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    def ok(cmd, *, timeout=60.0):
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", ok)
    return monkeypatch


def _resolved_org_id(client, db_session):
    """The org the static-token caller's managed DBs land in. We create one
    throwaway DB to force org creation, then read its org_id."""
    r = client.post("/api/managed-databases", json={"name": f"seed-{uuid.uuid4().hex[:6]}"})
    assert r.status_code == 200, r.text
    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == uuid.UUID(r.json()["id"])
    ).first()
    return row.org_id


def _make_project(db_session, org_id) -> Project:
    p = Project(
        id=uuid.uuid4(),
        name=f"proj-{uuid.uuid4().hex[:6]}",
        use_case=UseCaseType.DOCKER_PLATFORM,
        source_type=ProjectSourceType.GITHUB.value,
        repo_url="https://github.com/example/repo",
        repo_branch="main",
        webhook_secret="test-secret",
        org_id=org_id,
        owner_id=uuid.uuid4(),
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


def test_create_with_link_auto_wires_into_project(client, db_session, fake_podman):
    org_id = _resolved_org_id(client, db_session)
    project = _make_project(db_session, org_id)

    r = client.post(
        "/api/managed-databases",
        json={"name": "app-db", "link_project_id": str(project.id)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Response reports the wiring.
    assert body["linked_project_id"] == str(project.id)
    assert body["linked_env_var_name"] == "DATABASE_URL"

    # A link row exists tying the DB to the project as DATABASE_URL.
    link = db_session.query(ProjectDatabaseLink).filter(
        ProjectDatabaseLink.project_id == project.id,
        ProjectDatabaseLink.managed_database_id == uuid.UUID(body["id"]),
    ).first()
    assert link is not None
    assert link.env_var_name == "DATABASE_URL"
    assert link.is_active is True


def test_create_with_custom_env_var_name(client, db_session, fake_podman):
    org_id = _resolved_org_id(client, db_session)
    project = _make_project(db_session, org_id)

    r = client.post(
        "/api/managed-databases",
        json={
            "name": "cache-db",
            "link_project_id": str(project.id),
            "link_env_var_name": "CACHE_URL",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["linked_env_var_name"] == "CACHE_URL"


def test_create_without_link_does_not_wire(client, db_session, fake_podman):
    r = client.post("/api/managed-databases", json={"name": "standalone-db"})
    assert r.status_code == 200
    body = r.json()
    assert body["linked_project_id"] is None
    assert body["linked_env_var_name"] is None


def test_link_to_unknown_project_still_creates_db(client, db_session, fake_podman):
    """A bad link target must NOT fail the DB create — linking is additive."""
    r = client.post(
        "/api/managed-databases",
        json={
            "name": "resilient-db",
            "link_project_id": "00000000-0000-0000-0000-0000000000ff",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # DB created, but not linked.
    assert body["id"]
    assert body["linked_project_id"] is None


def test_link_to_cross_org_project_refused(client, db_session, fake_podman):
    """Linking to a project in a different org is silently skipped (the DB is
    still created), never wired across an org boundary."""
    other_org_project = _make_project(db_session, uuid.uuid4())  # random foreign org
    r = client.post(
        "/api/managed-databases",
        json={"name": "iso-db", "link_project_id": str(other_org_project.id)},
    )
    assert r.status_code == 200, r.text
    assert r.json()["linked_project_id"] is None


# ── Auto-backup on create ────────────────────────────────────────────────────


def test_auto_backup_sets_default_schedule(client, db_session, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "safe-db", "auto_backup": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["backup_schedule_cron"] == "0 3 * * *"

    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == uuid.UUID(body["id"])
    ).first()
    assert row.schedule_cron == "0 3 * * *"


def test_auto_backup_custom_cron(client, db_session, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "hourly-db", "auto_backup": True, "auto_backup_cron": "0 * * * *"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["backup_schedule_cron"] == "0 * * * *"


def test_no_auto_backup_by_default_via_api(client, db_session, fake_podman):
    """Omitting auto_backup leaves the DB without a schedule (the API default
    is False; the UI opts in)."""
    r = client.post("/api/managed-databases", json={"name": "plain-db"})
    assert r.status_code == 200
    assert r.json()["backup_schedule_cron"] is None


def test_auto_backup_invalid_cron_skips_not_fails(client, db_session, fake_podman):
    """A bad cron must not fail the (already-created) database — it just skips
    the schedule."""
    r = client.post(
        "/api/managed-databases",
        json={"name": "resilient-backup-db", "auto_backup": True, "auto_backup_cron": "nonsense"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"]
    assert body["backup_schedule_cron"] is None


# ── Test connection ──────────────────────────────────────────────────────────


def test_test_connection_requires_auth(anon_client):
    fake = "00000000-0000-0000-0000-000000000001"
    assert anon_client.post(f"/api/managed-databases/{fake}/test-connection").status_code == 401


def test_test_connection_ok_for_running_db(client, db_session, fake_podman):
    """fake_podman makes every exec return rc=0, so the probe succeeds."""
    created = client.post("/api/managed-databases", json={"name": "probe-db"}).json()
    r = client.post(f"/api/managed-databases/{created['id']}/test-connection")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert "connected" in body["message"].lower()


def test_test_connection_reports_not_running(client, db_session, fake_podman):
    """A stopped DB reports a clean, actionable result (not a 500)."""
    from watchtower.database import ManagedDatabase, ManagedDatabaseStatus

    created = client.post("/api/managed-databases", json={"name": "stopped-db"}).json()
    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == uuid.UUID(created["id"])
    ).first()
    row.status = ManagedDatabaseStatus.STOPPED
    db_session.commit()

    r = client.post(f"/api/managed-databases/{created['id']}/test-connection")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "not running" in body["message"].lower()
