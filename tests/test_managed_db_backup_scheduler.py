"""Tests for v1.1 scheduled backups — cron driven, retention pruned.

Real APScheduler is exercised but jobs never actually fire during
the test (we don't sleep through cron intervals). The scheduler's
TICK FUNCTION ``_run_scheduled_backup`` is tested directly with the
same monkeypatched pg_dump used in test_managed_db_backup.py — so
we cover the retention prune, the not-running guard, and the
file-on-disk side effects without burning real time.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from watchtower import managed_db_backup as backup
from watchtower import managed_db_backup_scheduler as scheduler
from watchtower import managed_db_runtime as runtime
from watchtower.database import (
    BackupStatus,
    ManagedDatabase,
    ManagedDatabaseBackup,
    ManagedDatabaseStatus,
)


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
    monkeypatch.setattr(backup, "_backups_root", lambda: tmp_path)
    def stub(spec):
        spec.host_dump_path.parent.mkdir(parents=True, exist_ok=True)
        spec.host_dump_path.write_bytes(b"FAKEDUMP" * 64)
        return spec.host_dump_path.stat().st_size
    monkeypatch.setattr(backup, "run_pg_dump", stub)
    return tmp_path


@pytest.fixture
def primary_db(client, fake_podman):
    r = client.post("/api/managed-databases", json={"name": "schedmain"})
    assert r.status_code == 200, r.text
    return r.json()


# ── Cron validation ─────────────────────────────────────────────────────────


def test_parse_cron_accepts_standard_5_field():
    scheduler.parse_cron_or_raise("0 3 * * *")
    scheduler.parse_cron_or_raise("*/5 * * * *")
    scheduler.parse_cron_or_raise("0 0 * * 0")


def test_parse_cron_rejects_bad_input():
    with pytest.raises(ValueError):
        scheduler.parse_cron_or_raise("not a cron")
    with pytest.raises(ValueError):
        scheduler.parse_cron_or_raise("")
    with pytest.raises(ValueError):
        scheduler.parse_cron_or_raise("99 * * * *")  # minute out of range


# ── Schedule endpoint ────────────────────────────────────────────────────────


def test_get_schedule_default(client, primary_db):
    r = client.get(f"/api/managed-databases/{primary_db['id']}/schedule")
    assert r.status_code == 200
    body = r.json()
    assert body["schedule_cron"] is None
    assert body["schedule_retention_count"] == 7
    assert body["next_run_at"] is None


def test_patch_schedule_sets_cron(client, primary_db):
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *", "retention_count": 14},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schedule_cron"] == "0 3 * * *"
    assert body["schedule_retention_count"] == 14
    # next_run_at requires scheduler to be running, which it isn't in tests.
    # Verified separately in the scheduler-module tests.


def test_patch_schedule_clears_cron(client, primary_db):
    client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *"},
    )
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": None},
    )
    assert r.status_code == 200
    assert r.json()["schedule_cron"] is None


def test_patch_schedule_clears_with_empty_string(client, primary_db):
    """Empty string should be treated the same as None — the SPA passes
    "" when the user picks "Off" from the preset dropdown."""
    client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *"},
    )
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": ""},
    )
    assert r.status_code == 200
    assert r.json()["schedule_cron"] is None


def test_patch_schedule_rejects_invalid_cron(client, primary_db):
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "this is not cron"},
    )
    assert r.status_code == 422
    assert "cron" in r.json()["detail"].lower()


def test_patch_schedule_retention_bounds(client, primary_db):
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *", "retention_count": 0},
    )
    assert r.status_code == 422   # below ge=1
    r = client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *", "retention_count": 99999},
    )
    assert r.status_code == 422   # above le=1000


def test_patch_schedule_rejects_non_postgres(client, fake_podman):
    cr = client.post(
        "/api/managed-databases",
        json={"name": "cache-sched", "engine": "redis", "version": "7.4"},
    )
    r = client.patch(
        f"/api/managed-databases/{cr.json()['id']}/schedule",
        json={"cron": "0 3 * * *"},
    )
    assert r.status_code == 400
    assert "postgres" in r.json()["detail"].lower()


def test_patch_schedule_writes_audit(client, primary_db, db_session):
    from watchtower.database import AuditEvent

    client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *"},
    )
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "managed_db.backup.schedule.update")
        .all()
    )
    assert len(events) == 1


# ── Scheduler tick function (the actual backup execution) ────────────────────


def test_tick_records_scheduled_backup(client, primary_db, fake_pg_dump, db_session):
    """_run_scheduled_backup is what APScheduler calls when the cron
    fires. We invoke it directly so the test doesn't have to wait for
    a real cron interval."""
    from uuid import UUID

    scheduler._run_scheduled_backup(primary_db["id"])

    rows = (
        db_session.query(ManagedDatabaseBackup)
        .filter(ManagedDatabaseBackup.primary_db_id == UUID(primary_db["id"]))
        .all()
    )
    assert len(rows) == 1
    assert rows[0].is_scheduled is True
    assert rows[0].status == BackupStatus.READY
    assert rows[0].label.startswith("scheduled-")
    assert rows[0].size_bytes is not None
    assert rows[0].size_bytes > 0


def test_tick_skips_when_db_not_running(client, primary_db, fake_pg_dump, db_session):
    """If the DB pod is stopped at fire time, the tick records a FAILED
    backup row with a clear message — schedule keeps firing because
    transient downtime self-resolves."""
    from uuid import UUID

    row = db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(primary_db["id"])
    ).first()
    row.status = ManagedDatabaseStatus.STOPPED
    db_session.commit()

    scheduler._run_scheduled_backup(primary_db["id"])

    rows = (
        db_session.query(ManagedDatabaseBackup)
        .filter(ManagedDatabaseBackup.primary_db_id == UUID(primary_db["id"]))
        .all()
    )
    assert len(rows) == 1
    assert rows[0].status == BackupStatus.FAILED
    assert "stopped" in (rows[0].status_message or "").lower()


def test_tick_skips_unknown_db_gracefully(fake_podman, fake_pg_dump):
    """A scheduled job firing for a deleted DB must not crash the
    scheduler. The job should be unregistered as a side effect, but
    even when the scheduler isn't running (test env), the function
    must return cleanly."""
    scheduler._run_scheduled_backup("00000000-0000-0000-0000-000000000099")
    # No assertion needed — the test passes if the function returns
    # without raising.


def test_tick_skips_non_postgres(client, fake_podman, fake_pg_dump):
    """v1 scheduled backups are Postgres only; a redis schedule
    shouldn't actually execute even if somehow set."""
    cr = client.post(
        "/api/managed-databases",
        json={"name": "redis-sched", "engine": "redis", "version": "7.4"},
    )
    # Tick the scheduler against the redis row — should no-op.
    scheduler._run_scheduled_backup(cr.json()["id"])
    # No new backup row should appear.
    from watchtower.database import ManagedDatabaseBackup, SessionLocal
    from uuid import UUID
    with SessionLocal() as db:
        rows = db.query(ManagedDatabaseBackup).filter(
            ManagedDatabaseBackup.primary_db_id == UUID(cr.json()["id"])
        ).all()
        assert rows == []


# ── Retention prune ──────────────────────────────────────────────────────────


def test_retention_prunes_oldest_scheduled_backups(
    client, primary_db, fake_pg_dump, db_session,
):
    """With retention_count=3, after the fourth scheduled tick we
    should still have only 3 scheduled backup rows on disk + in DB.
    Manual backups are untouched."""
    from uuid import UUID
    import time

    # Set retention to 3.
    client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *", "retention_count": 3},
    )

    # Drop one manual backup first — must survive every prune.
    manual_resp = client.post(
        f"/api/managed-databases/{primary_db['id']}/backups",
        json={"label": "manual-snap"},
    )
    assert manual_resp.status_code == 200

    # Fire 5 scheduled ticks.
    for _ in range(5):
        scheduler._run_scheduled_backup(primary_db["id"])
        # Slight sleep so created_at timestamps strictly order.
        time.sleep(0.01)

    rows = (
        db_session.query(ManagedDatabaseBackup)
        .filter(ManagedDatabaseBackup.primary_db_id == UUID(primary_db["id"]))
        .order_by(ManagedDatabaseBackup.created_at.desc())
        .all()
    )

    scheduled = [r for r in rows if r.is_scheduled]
    manual = [r for r in rows if not r.is_scheduled]
    assert len(scheduled) == 3, f"expected exactly 3 scheduled rows, got {len(scheduled)}"
    assert len(manual) == 1, "manual backup must survive prune"
    assert manual[0].label == "manual-snap"


def test_retention_default_of_seven(client, primary_db, fake_pg_dump, db_session):
    """When the operator hasn't set retention, the default 7 applies."""
    import time
    # No PATCH call — leave schedule_retention_count at default 7.
    for _ in range(9):
        scheduler._run_scheduled_backup(primary_db["id"])
        time.sleep(0.01)

    from uuid import UUID
    scheduled = (
        db_session.query(ManagedDatabaseBackup)
        .filter(
            ManagedDatabaseBackup.primary_db_id == UUID(primary_db["id"]),
            ManagedDatabaseBackup.is_scheduled.is_(True),
        )
        .all()
    )
    assert len(scheduled) == 7


def test_retention_deletes_files_from_disk(
    client, primary_db, fake_pg_dump, db_session,
):
    """Prune must also delete the .dump files, not just the DB rows."""
    import time

    client.patch(
        f"/api/managed-databases/{primary_db['id']}/schedule",
        json={"cron": "0 3 * * *", "retention_count": 2},
    )

    # Fire 4 ticks → 2 oldest should be pruned on the 3rd and 4th.
    paths: list[Path] = []
    from uuid import UUID
    for _ in range(4):
        scheduler._run_scheduled_backup(primary_db["id"])
        time.sleep(0.01)
        last = (
            db_session.query(ManagedDatabaseBackup)
            .filter(ManagedDatabaseBackup.primary_db_id == UUID(primary_db["id"]))
            .order_by(ManagedDatabaseBackup.created_at.desc())
            .first()
        )
        paths.append(Path(last.file_path))

    # The two newest survive; the two oldest are gone from disk.
    assert paths[-1].exists() and paths[-2].exists(), "newest files must survive"
    assert not paths[0].exists() and not paths[1].exists(), "oldest files must be deleted"


# ── Scheduler module surface (no APScheduler running) ───────────────────────


def test_register_and_unregister_are_safe_without_scheduler():
    """In tests the scheduler isn't started, but register/unregister
    must still be safe no-ops so the API endpoint doesn't blow up."""
    scheduler.register_schedule("11111111-1111-1111-1111-111111111111", "0 3 * * *")
    scheduler.unregister_schedule("11111111-1111-1111-1111-111111111111")
    # Just checking it doesn't raise.


def test_next_run_time_returns_none_when_no_job():
    assert scheduler.next_run_time("nonexistent") is None
