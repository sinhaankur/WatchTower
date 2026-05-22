"""Tests for v0 backups — on-demand pg_dump.

Real pg_dump is never invoked. We monkeypatch `backup.run_pg_dump` to
write a tiny file and return its size, simulating a successful dump
without needing a real Postgres or Podman.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watchtower import managed_db_backup as backup
from watchtower import managed_db_runtime as runtime
from watchtower.database import BackupStatus, ManagedDatabaseBackup


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_podman(monkeypatch):
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    def ok(cmd, *, timeout=60.0):
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", ok)
    return monkeypatch


@pytest.fixture
def fake_pg_dump(monkeypatch, tmp_path):
    """Replace pg_dump / mysqldump / mongodump with a stub that writes
    a placeholder file. Multi-engine refactor moved the entry point
    from ``run_pg_dump`` to ``run_backup``; we patch both so tests on
    either side of the rename keep working."""
    monkeypatch.setattr(backup, "_backups_root", lambda: tmp_path)

    def stub(spec):
        spec.host_dump_path.parent.mkdir(parents=True, exist_ok=True)
        spec.host_dump_path.write_bytes(b"PGDUMPFAKE" * 100)
        return spec.host_dump_path.stat().st_size

    monkeypatch.setattr(backup, "run_backup", stub)
    monkeypatch.setattr(backup, "run_pg_dump", stub)
    return tmp_path


@pytest.fixture
def primary_db(client, fake_podman):
    r = client.post("/api/managed-databases", json={"name": "main"})
    assert r.status_code == 200, r.text
    return r.json()


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_backup_routes_require_auth(anon_client):
    fake_id = "00000000-0000-0000-0000-000000000001"
    assert anon_client.get(f"/api/managed-databases/{fake_id}/backups").status_code == 401
    assert anon_client.post(f"/api/managed-databases/{fake_id}/backups", json={}).status_code == 401


# ── Create ───────────────────────────────────────────────────────────────────


def test_create_backup_happy_path(client, primary_db, fake_pg_dump):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "weekly"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["primary_db_id"] == primary_db["id"]
    assert body["label"] == "weekly"
    assert body["status"] == "ready"
    assert body["size_bytes"] > 0
    assert body["file_path"].endswith(".dump")


def test_create_backup_without_label(client, primary_db, fake_pg_dump):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={},
    )
    assert r.status_code == 200
    assert r.json()["label"] is None


def test_create_backup_rejects_redis(client, fake_podman, fake_pg_dump):
    """Redis backups (BGSAVE + RDB copy) are a different shape than
    dump-tool-based engines; they're explicitly deferred to a later
    release. The endpoint should reject Redis with a clear message
    while still accepting postgres/mysql/mariadb/mongodb.
    """
    cr = client.post(
        "/api/managed-databases",
        json={"name": "cache", "engine": "redis", "version": "7.4"},
    )
    r = client.post(
        f"/api/managed-databases/{cr.json()['id']}/backups",
        json={},
    )
    assert r.status_code == 400
    body = r.json()
    assert "redis" in body["detail"].lower()
    # The error should also name the engines that ARE supported, so
    # the operator knows their options.
    detail_lower = body["detail"].lower()
    assert "postgres" in detail_lower
    assert "mysql" in detail_lower
    assert "mongodb" in detail_lower


def test_create_backup_works_for_mysql(client, fake_podman, fake_pg_dump):
    """Multi-engine v1: MySQL gets backed up via the same endpoint as
    Postgres. The fake_pg_dump fixture intercepts run_backup so we
    don't actually invoke mysqldump."""
    cr = client.post(
        "/api/managed-databases",
        json={"name": "mysql-prod", "engine": "mysql", "version": "8.4"},
    )
    assert cr.status_code == 200, cr.text
    r = client.post(
        f"/api/managed-databases/{cr.json()['id']}/backups",
        json={"label": "weekly"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ready"
    # MySQL backups land with format=mysql so a future restore knows
    # which client to use.
    assert body["format"] == "mysql"


def test_create_backup_works_for_mariadb(client, fake_podman, fake_pg_dump):
    cr = client.post(
        "/api/managed-databases",
        json={"name": "mariadb-1", "engine": "mariadb", "version": "11.4"},
    )
    r = client.post(
        f"/api/managed-databases/{cr.json()['id']}/backups",
        json={},
    )
    assert r.status_code == 200, r.text
    assert r.json()["format"] == "mariadb"


def test_create_backup_works_for_mongodb(client, fake_podman, fake_pg_dump):
    cr = client.post(
        "/api/managed-databases",
        json={"name": "mongo-1", "engine": "mongodb", "version": "8.0"},
    )
    r = client.post(
        f"/api/managed-databases/{cr.json()['id']}/backups",
        json={"label": "pre-migration"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["format"] == "mongo"
    assert body["label"] == "pre-migration"


def test_backup_spec_passes_engine_to_runtime(
    client, fake_podman, monkeypatch, tmp_path,
):
    """Verify the API call site sets BackupSpec.engine correctly — the
    runtime's dispatcher uses it to pick pg_dump vs mysqldump vs
    mongodump. Captures the spec instead of running the dump."""
    monkeypatch.setattr(backup, "_backups_root", lambda: tmp_path)
    captured: list[backup.BackupSpec] = []

    def capture(spec):
        captured.append(spec)
        spec.host_dump_path.parent.mkdir(parents=True, exist_ok=True)
        spec.host_dump_path.write_bytes(b"x")
        return 1

    monkeypatch.setattr(backup, "run_backup", capture)
    monkeypatch.setattr(backup, "run_pg_dump", capture)

    cr = client.post(
        "/api/managed-databases",
        json={"name": "engine-test", "engine": "mongodb", "version": "7.0"},
    )
    client.post(f"/api/managed-databases/{cr.json()['id']}/backups", json={})

    assert len(captured) == 1
    assert captured[0].engine == "mongodb"
    # Image should match what the DB was created with — version-match
    # is critical so mongodump's BSON format matches the running server.
    assert "mongo" in captured[0].image


def test_create_backup_rejects_when_db_not_running(
    client, primary_db, fake_pg_dump, db_session,
):
    from uuid import UUID
    from watchtower.database import ManagedDatabase, ManagedDatabaseStatus

    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(primary_db["id"])
    ).first()
    row.status = ManagedDatabaseStatus.STOPPED
    db_session.commit()

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={},
    )
    assert r.status_code == 400
    assert "running" in r.json()["detail"].lower()


def test_create_backup_rejects_unsafe_label(client, primary_db, fake_pg_dump):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "bad; rm -rf /"},
    )
    assert r.status_code == 422


def test_pg_dump_failure_marks_row_failed(
    client, primary_db, monkeypatch, tmp_path, db_session,
):
    monkeypatch.setattr(backup, "_backups_root", lambda: tmp_path)

    def boom(_spec):
        raise backup.BackupError("pg_dump: server version 16 does not match client version 17")

    monkeypatch.setattr(backup, "run_backup", boom)
    monkeypatch.setattr(backup, "run_pg_dump", boom)

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={},
    )
    assert r.status_code == 400
    assert "server version" in r.json()["detail"]

    rows = db_session.query(ManagedDatabaseBackup).all()
    assert len(rows) == 1
    assert rows[0].status == BackupStatus.FAILED


# ── List ─────────────────────────────────────────────────────────────────────


def test_list_backups_empty(client, primary_db):
    r = client.get(f"/api/managed-databases/{primary_db['id']}/backups")
    assert r.status_code == 200
    assert r.json() == []


def test_list_backups_orders_newest_first(client, primary_db, fake_pg_dump):
    import time
    client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={"label": "first"})
    time.sleep(0.01)  # ensure distinct created_at
    client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={"label": "second"})

    r = client.get(f"/api/managed-databases/{primary_db['id']}/backups")
    rows = r.json()
    assert len(rows) == 2
    assert rows[0]["label"] == "second"  # newest first
    assert rows[1]["label"] == "first"


# ── Delete ───────────────────────────────────────────────────────────────────


def test_delete_backup_removes_row_and_file(
    client, primary_db, fake_pg_dump, db_session,
):
    from uuid import UUID

    cr = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "doomed"},
    )
    backup_id = cr.json()["id"]
    file_path = Path(cr.json()["file_path"])
    assert file_path.exists()

    r = client.delete(
        f"/api/managed-databases/{primary_db['id']}/backups/{backup_id}",
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True

    assert not file_path.exists(), "backup file should be unlinked"
    assert db_session.query(ManagedDatabaseBackup).filter(
        ManagedDatabaseBackup.id == UUID(backup_id)
    ).first() is None


def test_delete_backup_404_for_unknown(client, primary_db, fake_pg_dump):
    r = client.delete(
        f"/api/managed-databases/{primary_db['id']}/backups/00000000-0000-0000-0000-000000000099",
    )
    assert r.status_code == 404


# ── Usage ────────────────────────────────────────────────────────────────────


def test_backup_usage_reports_total_size(client, primary_db, fake_pg_dump):
    client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})

    r = client.get(f"/api/managed-databases/{primary_db['id']}/backups/usage")
    assert r.status_code == 200
    body = r.json()
    assert body["used_bytes"] > 0
    assert body["free_bytes"] >= 0


# ── Audit ────────────────────────────────────────────────────────────────────


def test_backup_lifecycle_audits(client, primary_db, fake_pg_dump, db_session):
    from watchtower.database import AuditEvent

    cr = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "audited"},
    )
    bid = cr.json()["id"]
    client.delete(f"/api/managed-databases/{primary_db['id']}/backups/{bid}")

    actions = {e.action for e in db_session.query(AuditEvent).all()}
    assert "managed_db.backup.create" in actions
    assert "managed_db.backup.delete" in actions


# ── Restore (v1) ─────────────────────────────────────────────────────────────


@pytest.fixture
def fake_pg_restore(monkeypatch):
    """Replace the restore entry point with a no-op that just verifies
    the file exists. Patches both ``run_restore`` (new multi-engine
    entry point used by the router) and ``run_pg_restore`` (legacy
    shim) so tests targeting either name keep working."""
    called: list[backup.RestoreSpec] = []

    def stub(spec):
        called.append(spec)
        if not spec.host_dump_path.is_file():
            raise backup.BackupError(
                f"Backup file no longer exists on disk: {spec.host_dump_path}"
            )

    monkeypatch.setattr(backup, "run_restore", stub)
    monkeypatch.setattr(backup, "run_pg_restore", stub)
    return called


def test_restore_requires_auth(anon_client):
    fake_db = "00000000-0000-0000-0000-000000000001"
    fake_bk = "00000000-0000-0000-0000-000000000002"
    r = anon_client.post(
        f"/api/managed-databases/{fake_db}/backups/{fake_bk}/restore",
        json={"confirm_db_name": "x"},
    )
    assert r.status_code == 401


def test_restore_happy_path(client, primary_db, fake_pg_dump, fake_pg_restore):
    cr = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "before-prod-migration"},
    )
    bid = cr.json()["id"]

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["database_name"] == primary_db["name"]
    assert body["restored_from"]["label"] == "before-prod-migration"
    assert len(fake_pg_restore) == 1
    # The pg_restore stub got the right inputs.
    assert fake_pg_restore[0].db_name == primary_db["database_name"]
    assert fake_pg_restore[0].db_user == primary_db["username"]


def test_restore_rejects_wrong_db_name_confirmation(
    client, primary_db, fake_pg_dump, fake_pg_restore,
):
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    bid = cr.json()["id"]

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": "wrong-name"},
    )
    assert r.status_code == 400
    assert "match" in r.json()["detail"].lower()
    # pg_restore must not have been invoked.
    assert len(fake_pg_restore) == 0


def test_restore_rejects_empty_confirmation(client, primary_db, fake_pg_dump, fake_pg_restore):
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    bid = cr.json()["id"]
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": ""},
    )
    assert r.status_code == 400


def test_restore_404_for_unknown_backup(client, primary_db, fake_pg_dump, fake_pg_restore):
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/00000000-0000-0000-0000-000000000099/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 404


def test_restore_rejects_non_ready_backup(
    client, primary_db, fake_pg_dump, fake_pg_restore, db_session,
):
    from uuid import UUID
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    bid = cr.json()["id"]
    # Force the row into FAILED state to simulate "the backup itself failed."
    row = db_session.query(ManagedDatabaseBackup).filter(
        ManagedDatabaseBackup.id == UUID(bid)
    ).first()
    row.status = BackupStatus.FAILED
    db_session.commit()

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 400
    assert "ready" in r.json()["detail"].lower()


def test_restore_rejects_when_db_not_running(
    client, primary_db, fake_pg_dump, fake_pg_restore, db_session,
):
    from uuid import UUID
    from watchtower.database import ManagedDatabase, ManagedDatabaseStatus

    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    bid = cr.json()["id"]

    # Stop the DB to simulate "user clicked Restore while pod was stopped."
    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(primary_db["id"])
    ).first()
    row.status = ManagedDatabaseStatus.STOPPED
    db_session.commit()

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 400
    assert "running" in r.json()["detail"].lower()


def test_restore_surfaces_pg_restore_error(
    client, primary_db, fake_pg_dump, monkeypatch, db_session,
):
    """When pg_restore fails partway through, the API must surface the
    error AND log a failure audit so operators can timeline what
    happened."""
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    bid = cr.json()["id"]

    def boom(_spec):
        raise backup.BackupError("pg_restore: relation users does not exist")

    monkeypatch.setattr(backup, "run_restore", boom)
    monkeypatch.setattr(backup, "run_pg_restore", boom)

    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 400
    assert "relation users does not exist" in r.json()["detail"]

    from watchtower.database import AuditEvent
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "managed_db.backup.restore.failed")
        .all()
    )
    assert len(events) == 1


def test_restore_writes_audit_on_success(
    client, primary_db, fake_pg_dump, fake_pg_restore, db_session,
):
    cr = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "audited-restore"},
    )
    bid = cr.json()["id"]
    client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )

    from watchtower.database import AuditEvent
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "managed_db.backup.restore")
        .all()
    )
    assert len(events) == 1


def test_restore_fails_when_dump_file_missing(
    client, primary_db, fake_pg_dump, monkeypatch, db_session,
):
    """If the user deleted the .dump file from disk out-of-band, the
    restore must fail fast with a clear message instead of running
    pg_restore against a non-existent file."""
    cr = client.post(f"/api/managed-databases/{primary_db['id']}/backups", json={})
    body = cr.json()
    bid = body["id"]

    # Delete the file out-of-band.
    Path(body["file_path"]).unlink()

    # No monkey-patch on run_pg_restore — let the real one check the file.
    r = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups/{bid}/restore",
        json={"confirm_db_name": primary_db["name"]},
    )
    assert r.status_code == 400
    assert "no longer exists" in r.json()["detail"].lower()
