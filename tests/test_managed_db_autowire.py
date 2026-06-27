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
