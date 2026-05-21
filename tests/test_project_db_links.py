"""Tests for /api/projects/{id}/databases — link projects to managed/external DBs.

Validates the binding endpoints + the env-var resolver consumed by
builder.py at deploy time.
"""
from __future__ import annotations

import uuid

import pytest

from watchtower import managed_db_runtime as runtime
from watchtower.api.project_db_links import resolve_env_vars_for_project
from watchtower.api.util import encrypt_secret
from watchtower.database import (
    ExternalDatabase,
    Project,
    ProjectDatabaseLink,
    ProjectSourceType,
    UseCaseType,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_podman(monkeypatch):
    """Stand-in for podman so managed-DB creation works in tests."""
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")
    def ok(cmd, *, timeout=60.0):
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""
    monkeypatch.setattr(runtime, "_run", ok)
    return monkeypatch


@pytest.fixture
def project(client, db_session):
    """Create a Project row directly. The HTTP create flow needs more
    orchestration (org, owner, etc.) than we need for these tests."""
    p = Project(
        id=uuid.uuid4(),
        name=f"proj-{uuid.uuid4().hex[:6]}",
        use_case=UseCaseType.DOCKER_PLATFORM,
        source_type=ProjectSourceType.GITHUB.value,
        repo_url="https://github.com/example/repo",
        repo_branch="main",
        webhook_secret="test-secret",
        org_id=uuid.uuid4(),
        owner_id=uuid.uuid4(),
    )
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    return p


@pytest.fixture
def managed_db(client, fake_podman):
    """Create a managed Postgres via the public API."""
    r = client.post("/api/managed-databases", json={"name": "linked-pg"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def external_db(client):
    r = client.post(
        "/api/external-databases",
        json={
            "name": "ext-redis",
            "engine": "redis",
            "host": "cache.example.com",
            "port": 6379,
            "password": "redispw",
        },
    )
    assert r.status_code == 200
    return r.json()


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_routes_require_auth(anon_client):
    fake = "00000000-0000-0000-0000-000000000001"
    assert anon_client.get(f"/api/projects/{fake}/databases").status_code == 401
    assert anon_client.post(f"/api/projects/{fake}/databases", json={}).status_code == 401


# ── List ─────────────────────────────────────────────────────────────────────


def test_list_empty(client, project):
    r = client.get(f"/api/projects/{project.id}/databases")
    assert r.status_code == 200
    assert r.json() == []


def test_list_unknown_project_404(client):
    r = client.get("/api/projects/00000000-0000-0000-0000-000000000099/databases")
    assert r.status_code == 404


# ── Create ───────────────────────────────────────────────────────────────────


def test_link_managed_db(client, project, managed_db):
    r = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["managed_database_id"] == managed_db["id"]
    assert body["database_kind"] == "managed"
    assert body["env_var_name"] == "DATABASE_URL"   # default
    assert body["is_active"] is True


def test_link_external_db_with_custom_env_var(client, project, external_db):
    r = client.post(
        f"/api/projects/{project.id}/databases",
        json={
            "external_database_id": external_db["id"],
            "env_var_name": "REDIS_URL",
            "notes": "session cache",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["external_database_id"] == external_db["id"]
    assert body["database_kind"] == "external"
    assert body["env_var_name"] == "REDIS_URL"
    assert body["notes"] == "session cache"


def test_link_rejects_both_managed_and_external(client, project, managed_db, external_db):
    r = client.post(
        f"/api/projects/{project.id}/databases",
        json={
            "managed_database_id": managed_db["id"],
            "external_database_id": external_db["id"],
        },
    )
    assert r.status_code == 400
    assert "exactly one" in r.json()["detail"].lower()


def test_link_rejects_neither(client, project):
    r = client.post(f"/api/projects/{project.id}/databases", json={})
    assert r.status_code == 400


def test_link_rejects_unknown_managed_db(client, project):
    r = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": "00000000-0000-0000-0000-000000000099"},
    )
    assert r.status_code == 404


def test_link_rejects_duplicate_env_var(client, project, managed_db, external_db):
    p1 = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    assert p1.status_code == 200
    p2 = client.post(
        f"/api/projects/{project.id}/databases",
        json={"external_database_id": external_db["id"]},
    )
    # Both default to DATABASE_URL — must collide.
    assert p2.status_code == 409
    assert "DATABASE_URL" in p2.json()["detail"]


def test_link_rejects_invalid_env_var_name(client, project, managed_db):
    for bad in ["1NUMBER_START", "has-dash", "has space", "has;semi"]:
        r = client.post(
            f"/api/projects/{project.id}/databases",
            json={"managed_database_id": managed_db["id"], "env_var_name": bad},
        )
        assert r.status_code == 422, f"bad name {bad} should 422"


# ── Patch ────────────────────────────────────────────────────────────────────


def test_patch_pause_resume(client, project, managed_db):
    cr = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    lid = cr.json()["id"]
    paused = client.patch(
        f"/api/projects/{project.id}/databases/{lid}",
        json={"is_active": False},
    )
    assert paused.status_code == 200
    assert paused.json()["is_active"] is False

    resumed = client.patch(
        f"/api/projects/{project.id}/databases/{lid}",
        json={"is_active": True},
    )
    assert resumed.json()["is_active"] is True


def test_patch_rename_env_var(client, project, managed_db):
    cr = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    lid = cr.json()["id"]
    r = client.patch(
        f"/api/projects/{project.id}/databases/{lid}",
        json={"env_var_name": "POSTGRES_URL"},
    )
    assert r.status_code == 200
    assert r.json()["env_var_name"] == "POSTGRES_URL"


# ── Delete ───────────────────────────────────────────────────────────────────


def test_delete_link(client, project, managed_db, db_session):
    from uuid import UUID
    cr = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    lid = cr.json()["id"]
    r = client.delete(f"/api/projects/{project.id}/databases/{lid}")
    assert r.status_code == 200
    remaining = db_session.query(ProjectDatabaseLink).filter(
        ProjectDatabaseLink.id == UUID(lid)
    ).first()
    assert remaining is None


# ── Resolver (consumed by builder.py at deploy time) ─────────────────────────


def test_resolver_returns_managed_connection_string(client, project, managed_db, db_session):
    client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    env = resolve_env_vars_for_project(db_session, project.id)
    assert "DATABASE_URL" in env
    assert env["DATABASE_URL"].startswith("postgresql://")
    # The password (from create response) must appear in the resolved URL.
    assert managed_db["host"] in env["DATABASE_URL"]


def test_resolver_returns_external_connection_string(client, project, external_db, db_session):
    client.post(
        f"/api/projects/{project.id}/databases",
        json={"external_database_id": external_db["id"], "env_var_name": "REDIS_URL"},
    )
    env = resolve_env_vars_for_project(db_session, project.id)
    assert "REDIS_URL" in env
    assert env["REDIS_URL"].startswith("redis://:redispw@cache.example.com:6379")


def test_resolver_skips_inactive_links(client, project, managed_db, db_session):
    cr = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    client.patch(
        f"/api/projects/{project.id}/databases/{cr.json()['id']}",
        json={"is_active": False},
    )
    env = resolve_env_vars_for_project(db_session, project.id)
    assert env == {}, "inactive link should not contribute env vars"


def test_resolver_multiple_links_distinct_env_vars(
    client, project, managed_db, external_db, db_session,
):
    client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"], "env_var_name": "DATABASE_URL"},
    )
    client.post(
        f"/api/projects/{project.id}/databases",
        json={"external_database_id": external_db["id"], "env_var_name": "REDIS_URL"},
    )
    env = resolve_env_vars_for_project(db_session, project.id)
    assert set(env.keys()) == {"DATABASE_URL", "REDIS_URL"}
    assert env["DATABASE_URL"].startswith("postgresql://")
    assert env["REDIS_URL"].startswith("redis://")


def test_resolver_swallows_decrypt_errors(client, project, db_session, monkeypatch):
    """One bad link must not break the build for other links — important
    behaviour because deploys read this on every build."""
    # Insert an external DB with a deliberately corrupt encrypted value.
    bad = ExternalDatabase(
        id=uuid.uuid4(),
        org_id=project.org_id,
        name="broken",
        engine="postgres",
        host="h",
        port=5432,
        database_name="d",
        username="u",
        password_encrypted="not-valid-fernet-ciphertext",
    )
    db_session.add(bad)
    db_session.flush()
    link = ProjectDatabaseLink(
        project_id=project.id,
        external_database_id=bad.id,
        env_var_name="BROKEN_URL",
    )
    db_session.add(link)
    db_session.commit()

    # The resolver should log + skip, not raise.
    env = resolve_env_vars_for_project(db_session, project.id)
    assert "BROKEN_URL" not in env


# ── Audit ────────────────────────────────────────────────────────────────────


def test_link_lifecycle_audits(client, project, managed_db, db_session):
    from watchtower.database import AuditEvent

    cr = client.post(
        f"/api/projects/{project.id}/databases",
        json={"managed_database_id": managed_db["id"]},
    )
    client.patch(
        f"/api/projects/{project.id}/databases/{cr.json()['id']}",
        json={"is_active": False},
    )
    client.delete(f"/api/projects/{project.id}/databases/{cr.json()['id']}")
    actions = {e.action for e in db_session.query(AuditEvent).all()}
    assert "project.database.link" in actions
    assert "project.database.link.update" in actions
    assert "project.database.unlink" in actions
