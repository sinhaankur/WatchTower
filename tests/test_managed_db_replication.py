"""Tests for the v1 HA layer — add/promote/remove replicas.

Real podman is never invoked. We mock both `runtime._run` (low-level
subprocess) and `replication.*` exec helpers so the API flow can be
exercised without psql or pg_basebackup actually executing.
"""
from __future__ import annotations

import pytest

from watchtower import managed_db_replication as replication
from watchtower import managed_db_runtime as runtime
from watchtower.database import (
    ManagedDatabaseReplica,
    ManagedDatabaseStatus,
    ReplicaRole,
    ReplicaStatus,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_podman(monkeypatch):
    """Podman/Docker is "installed" and every command succeeds (rc=0)."""
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    def ok(cmd, *, timeout=60.0):
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", ok)
    return monkeypatch


@pytest.fixture
def fake_replication(monkeypatch):
    """Every replication-specific helper succeeds.

    Each test that wants to exercise a specific failure path overrides
    one of these on its own.
    """
    monkeypatch.setattr(
        replication, "configure_primary_for_replication",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "create_replication_user",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "create_replication_slot",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "allow_replication_in_pg_hba",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "provision_standby",
        lambda spec: ("pod", "container", "volume"),
    )
    monkeypatch.setattr(
        replication, "promote_standby",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "stop_container_best_effort",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        replication, "drop_replication_slot_best_effort",
        lambda *a, **k: None,
    )
    return monkeypatch


@pytest.fixture
def primary_db(client, fake_podman):
    """Create a running Postgres primary for replication tests."""
    r = client.post("/api/managed-databases", json={"name": "primary"})
    assert r.status_code == 200, r.text
    return r.json()


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_replica_routes_require_auth(anon_client):
    fake_id = "00000000-0000-0000-0000-000000000001"
    assert anon_client.get(f"/api/managed-databases/{fake_id}/replicas").status_code == 401
    assert anon_client.post(f"/api/managed-databases/{fake_id}/replicas", json={}).status_code == 401


# ── Add replica ──────────────────────────────────────────────────────────────


def test_add_replica_happy_path(client, primary_db, fake_replication):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["primary_db_id"] == primary_db["id"]
    assert body["name"] == "primary-standby"  # default derived
    assert body["role"] == "standby"
    assert body["status"] == "streaming"
    assert body["port"] > 0
    assert body["replication_slot_name"].startswith("wt_repl_")


def test_add_replica_custom_name(client, primary_db, fake_replication):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={"name": "warm-standby"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "warm-standby"


def test_add_replica_rejects_unsafe_name(client, primary_db, fake_replication):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={"name": "bad name; rm -rf /"},
    )
    assert r.status_code == 422


def test_add_replica_rejects_non_postgres(client, fake_podman, fake_replication):
    cr = client.post(
        "/api/managed-databases",
        json={"name": "redis-db", "engine": "redis", "version": "7.4"},
    )
    assert cr.status_code == 200
    r = client.post(
        f"/api/managed-databases/{cr.json()['id']}/replicas",
        json={},
    )
    assert r.status_code == 400
    assert "postgres" in r.json()["detail"].lower()


def test_add_replica_rejects_when_primary_not_running(
    client, primary_db, db_session, fake_replication,
):
    # Force the primary into STOPPED state in the DB.
    from uuid import UUID
    from watchtower.database import ManagedDatabase
    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(primary_db["id"])
    ).first()
    row.status = ManagedDatabaseStatus.STOPPED
    db_session.commit()

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={},
    )
    assert r.status_code == 400
    assert "running" in r.json()["detail"].lower()


def test_add_replica_setup_failure_marks_row_failed(
    client, primary_db, monkeypatch, db_session,
):
    """A failure in the replication setup must leave the row in FAILED
    state so the operator can retry/delete from the UI, not vanish."""
    def boom(*_a, **_k):
        raise replication.ReplicationError("pg_basebackup: connection refused")

    monkeypatch.setattr(replication, "configure_primary_for_replication", lambda *a, **k: None)
    monkeypatch.setattr(replication, "create_replication_user", lambda *a, **k: None)
    monkeypatch.setattr(replication, "create_replication_slot", lambda *a, **k: None)
    monkeypatch.setattr(replication, "allow_replication_in_pg_hba", lambda *a, **k: None)
    monkeypatch.setattr(replication, "provision_standby", boom)

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={},
    )
    assert r.status_code == 400
    assert "connection refused" in r.json()["detail"]

    rows = db_session.query(ManagedDatabaseReplica).all()
    assert len(rows) == 1
    assert rows[0].status == ReplicaStatus.FAILED


# ── List ─────────────────────────────────────────────────────────────────────


def test_list_replicas_empty(client, primary_db):
    r = client.get(f"/api/managed-databases/{primary_db['id']}/replicas")
    assert r.status_code == 200
    assert r.json() == []


def test_list_replicas_after_add(client, primary_db, fake_replication):
    client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas",
        json={"name": "second"},
    )
    r = client.get(f"/api/managed-databases/{primary_db['id']}/replicas")
    assert r.status_code == 200
    names = {row["name"] for row in r.json()}
    assert names == {"primary-standby", "second"}


# ── Promote ──────────────────────────────────────────────────────────────────


def test_promote_replica_flips_roles(client, primary_db, fake_replication, db_session):
    from uuid import UUID
    from watchtower.database import ManagedDatabase

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    replica_id = cr.json()["id"]

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}/promote",
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["role"] == "promoted"
    assert body["status"] == "promoted"

    # Primary row should be marked STOPPED post-failover.
    primary_row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(primary_db["id"])
    ).first()
    db_session.refresh(primary_row)
    assert primary_row.status == ManagedDatabaseStatus.STOPPED
    assert "demoted" in (primary_row.status_message or "").lower()


def test_promote_rejects_when_not_streaming(client, primary_db, fake_replication, db_session):
    from uuid import UUID

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    replica_id = cr.json()["id"]

    # Force the replica into FAILED status to simulate "can't promote yet."
    row = db_session.query(ManagedDatabaseReplica).filter(
        ManagedDatabaseReplica.id == UUID(replica_id)
    ).first()
    row.status = ReplicaStatus.FAILED
    db_session.commit()

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}/promote",
    )
    assert r.status_code == 400
    assert "streaming" in r.json()["detail"].lower()


def test_promote_idempotency_guard(client, primary_db, fake_replication):
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    replica_id = cr.json()["id"]

    p1 = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}/promote",
    )
    assert p1.status_code == 200

    p2 = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}/promote",
    )
    assert p2.status_code == 400
    assert "already promoted" in p2.json()["detail"].lower()


def test_promote_surfaces_pg_promote_failure(
    client, primary_db, fake_replication, monkeypatch, db_session,
):
    from uuid import UUID

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    replica_id = cr.json()["id"]

    def boom(*_a, **_k):
        raise replication.ReplicationError("pg_promote returned false")

    monkeypatch.setattr(replication, "promote_standby", boom)

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}/promote",
    )
    assert r.status_code == 400
    assert "pg_promote" in r.json()["detail"]

    row = db_session.query(ManagedDatabaseReplica).filter(
        ManagedDatabaseReplica.id == UUID(replica_id)
    ).first()
    assert row.status == ReplicaStatus.FAILED


# ── Remove ───────────────────────────────────────────────────────────────────


def test_remove_replica(client, primary_db, fake_replication, db_session):
    from uuid import UUID

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    replica_id = cr.json()["id"]

    r = client.delete(
        f"/api/managed-databases/{primary_db['id']}/replicas/{replica_id}",
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    assert db_session.query(ManagedDatabaseReplica).filter(
        ManagedDatabaseReplica.id == UUID(replica_id)
    ).first() is None


def test_remove_replica_404_for_unknown(client, primary_db, fake_replication):
    r = client.delete(
        f"/api/managed-databases/{primary_db['id']}/replicas/00000000-0000-0000-0000-000000000099",
    )
    assert r.status_code == 404


def test_remove_replica_drops_slot_on_primary(
    client, primary_db, fake_replication, monkeypatch,
):
    """Removal should drop the primary's replication slot so it doesn't
    pin WAL indefinitely. We just verify the call happened with the
    slot name on the row."""
    called = []

    def record(primary_container, primary_user, primary_db_name, slot_name):
        called.append({"slot": slot_name})

    monkeypatch.setattr(replication, "drop_replication_slot_best_effort", record)

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    slot = cr.json()["replication_slot_name"]

    client.delete(
        f"/api/managed-databases/{primary_db['id']}/replicas/{cr.json()['id']}",
    )
    assert called == [{"slot": slot}]


# ── Audit ────────────────────────────────────────────────────────────────────


def test_replica_lifecycle_audits(client, primary_db, fake_replication, db_session):
    from watchtower.database import AuditEvent

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/replicas", json={})
    rid = cr.json()["id"]
    client.post(f"/api/managed-databases/{primary_db['id']}/replicas/{rid}/promote")

    actions = {e.action for e in db_session.query(AuditEvent).all()}
    assert "managed_db.replica.create" in actions
    assert "managed_db.replica.promote" in actions
