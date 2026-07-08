"""APScheduler-driven cron backups for managed databases.

One APScheduler job per ManagedDatabase row with a non-NULL
``schedule_cron``. The job fires according to the cron string,
takes a pg_dump via the existing on-demand pipeline, marks the
backup row with ``is_scheduled=True``, then prunes scheduled
backups older than ``schedule_retention_count``.

Why a separate module + scheduler:
  * The autonomous-mode probe scheduler in ``watchtower/autonomous.py``
    polls *projects*, not databases. Sharing a single APScheduler
    instance would be fine technically, but separating concerns keeps
    each module's lifecycle independent — disabling autonomous mode
    via ``WATCHTOWER_AUTONOMOUS_DISABLE=true`` should not also
    disable backups, and vice versa.
  * APScheduler's BackgroundScheduler is the right shape for
    process-local cron: it parses the cron string, persists the next
    fire time across restarts (via the in-memory jobstore — for v1 the
    schedule lives in the DB and is re-registered on startup, so
    in-memory is fine), and gives us coalesce + max_instances
    out-of-the-box.

Failure handling:
  * Backup failures leave a FAILED row + a status_message. The next
    scheduled run still fires — we don't pause the schedule on a
    single failure because the most common transient cause (DB
    briefly down) self-resolves and the operator wants the next run
    to just work.
  * Repeated consecutive failures could be surfaced via an audit
    count later; for v1, the operator sees them in the Backups list.

Disabling globally: ``WATCHTOWER_BACKUP_SCHEDULER_DISABLE=true`` skips
scheduler start in the lifespan. Useful for tests + debugging.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Lazily imported so this module imports fast even when the scheduler
# is disabled. APScheduler pulls in pytz + tzlocal which take ~30ms.
_scheduler = None
_JOB_PREFIX = "managed-db-backup-"


def _job_id(db_id: str) -> str:
    return f"{_JOB_PREFIX}{db_id}"


def start_scheduler() -> None:
    """Initialise the APScheduler instance and register a job for every
    managed database with a current cron schedule.

    Called from the FastAPI lifespan startup. Idempotent — re-calling
    is a no-op (returns the existing scheduler). Safe to call when no
    schedules are configured: the scheduler runs with zero jobs and
    costs ~nothing.
    """
    global _scheduler
    if os.getenv("WATCHTOWER_BACKUP_SCHEDULER_DISABLE", "false").lower() == "true":
        logger.info("Backup scheduler disabled via WATCHTOWER_BACKUP_SCHEDULER_DISABLE")
        return
    if _scheduler is not None:
        return

    from apscheduler.schedulers.background import BackgroundScheduler

    _scheduler = BackgroundScheduler(
        # UTC throughout so cron strings have unambiguous semantics. The
        # UI shows "next run in X hours" relative to wall clock, which
        # avoids needing a per-user timezone field for v1.
        timezone="UTC",
        # Coalesce missed runs: if the API was down for 6 hours and the
        # schedule is hourly, we don't want 6 backups firing immediately
        # on restart — just one.
        job_defaults={"coalesce": True, "max_instances": 1},
    )
    _scheduler.start()
    logger.info("Backup scheduler started")
    _hydrate_jobs_from_db()
    _register_copy_retry_sweep()


def _register_copy_retry_sweep() -> None:
    """Register the interval job that retries off-host backup copies which
    were PENDING/FAILED (e.g. the peer was offline when the backup ran).

    Interval is ``WATCHTOWER_BACKUP_COPY_RETRY_SECS`` (default 600s / 10min).
    Kept separate from the per-DB cron jobs so an intermittently-reachable
    destination catches up regardless of when the next backup is scheduled."""
    if _scheduler is None:
        return
    try:
        secs = max(int(os.getenv("WATCHTOWER_BACKUP_COPY_RETRY_SECS", "600")), 30)
    except ValueError:
        secs = 600
    from apscheduler.triggers.interval import IntervalTrigger
    _scheduler.add_job(
        _sweep_pending_copies,
        IntervalTrigger(seconds=secs),
        id="backup-copy-retry-sweep",
        replace_existing=True,
        name="backup copy retry sweep",
    )
    logger.info("Backup scheduler: copy-retry sweep every %ds", secs)


def _sweep_pending_copies() -> None:
    """Interval-job body: retry stuck off-host copies. Own DB session; never
    raises (would kill the APScheduler job)."""
    try:
        from watchtower import backup_shipper
        from watchtower.database import SessionLocal
        with SessionLocal() as db:
            n = backup_shipper.retry_pending_copies(db)
            if n:
                logger.info("Backup scheduler: retried %d off-host copy(ies)", n)
    except Exception:  # noqa: BLE001
        logger.exception("Backup scheduler: copy-retry sweep failed")


def stop_scheduler() -> None:
    """Stop the scheduler at lifespan shutdown. Safe to call when never
    started (no-op)."""
    global _scheduler
    if _scheduler is None:
        return
    try:
        _scheduler.shutdown(wait=False)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to shut down backup scheduler cleanly")
    _scheduler = None


def _hydrate_jobs_from_db() -> None:
    """Read every ManagedDatabase with a non-NULL schedule_cron and
    register a job for each. Called once at startup so a restart picks
    up where we left off."""
    if _scheduler is None:
        return
    try:
        from watchtower.database import ManagedDatabase, SessionLocal
        with SessionLocal() as db:
            scheduled = db.query(ManagedDatabase).filter(
                ManagedDatabase.schedule_cron.isnot(None)
            ).all()
            for mdb in scheduled:
                try:
                    _register_job(str(mdb.id), mdb.schedule_cron)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "Failed to register backup schedule for %s (cron=%s)",
                        mdb.id, mdb.schedule_cron,
                    )
            if scheduled:
                logger.info(
                    "Backup scheduler: hydrated %d schedule(s) from DB",
                    len(scheduled),
                )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to hydrate scheduler jobs from DB")


def register_schedule(db_id: str, cron: str) -> None:
    """Public entry point called from the API when an operator sets or
    updates a schedule on a database. Replaces any existing job for
    the same DB.

    Caller is responsible for validating the cron string first via
    ``parse_cron_or_400(cron)`` — this function will raise if it's
    malformed but with a less helpful error.
    """
    if _scheduler is None:
        # Scheduler hasn't been started (test environment or disabled).
        # The schedule is still persisted in the DB and will be picked
        # up on the next process start via _hydrate_jobs_from_db.
        return
    _register_job(db_id, cron)


def unregister_schedule(db_id: str) -> None:
    """Remove the cron job for a database. Called when schedule_cron
    is cleared OR the database is deleted. Safe to call when no job
    exists."""
    if _scheduler is None:
        return
    job_id = _job_id(db_id)
    if _scheduler.get_job(job_id):
        try:
            _scheduler.remove_job(job_id)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to remove scheduler job %s", job_id)


def _register_job(db_id: str, cron: str) -> None:
    """Actually add/replace the APScheduler job. Internal helper."""
    if _scheduler is None:
        return
    from apscheduler.triggers.cron import CronTrigger
    trigger = CronTrigger.from_crontab(cron, timezone="UTC")
    _scheduler.add_job(
        _run_scheduled_backup,
        trigger,
        id=_job_id(db_id),
        args=[db_id],
        replace_existing=True,
        name=f"managed-db-backup {db_id}",
    )
    logger.info("Backup scheduler: registered %s with cron=%s", db_id, cron)


def next_run_time(db_id: str):
    """Return the datetime of this DB's next scheduled fire, or None
    if no job is registered. Surfaced in the API + UI so operators
    can see when the next backup will happen."""
    if _scheduler is None:
        return None
    job = _scheduler.get_job(_job_id(db_id))
    if job is None:
        return None
    return job.next_run_time


def parse_cron_or_raise(cron: str) -> None:
    """Validate a cron string. Raises ``ValueError`` (the caller turns
    into a 422). Used both at API write time and from tests."""
    if not cron or not isinstance(cron, str):
        raise ValueError("cron string must be non-empty")
    from apscheduler.triggers.cron import CronTrigger
    try:
        CronTrigger.from_crontab(cron, timezone="UTC")
    except Exception as exc:
        raise ValueError(f"Invalid cron expression: {exc}") from exc


# ── The actual backup-execution function ─────────────────────────────────────


def _run_scheduled_backup(db_id: str) -> None:
    """Body of each fired job. Runs pg_dump via the same code path the
    on-demand endpoint uses, then prunes old scheduled backups beyond
    the retention count.

    Lives outside the FastAPI dependency-injection tree (no Request,
    no current_user), so it manages its own DB session.
    """
    from watchtower import managed_db_backup as backup
    from watchtower.api.util import decrypt_secret, utcnow
    from watchtower.database import (
        BackupStatus,
        ManagedDatabase,
        ManagedDatabaseBackup,
        ManagedDatabaseStatus,
        SessionLocal,
    )
    from uuid import UUID

    try:
        uid = UUID(db_id)
    except ValueError:
        logger.error("Backup scheduler: invalid db_id %r — skipping", db_id)
        return

    with SessionLocal() as db:
        mdb = db.query(ManagedDatabase).filter(ManagedDatabase.id == uid).first()
        if mdb is None:
            logger.warning(
                "Backup scheduler: db %s no longer exists — unregistering job",
                db_id,
            )
            unregister_schedule(db_id)
            return

        from watchtower import managed_db_backup as _backup_mod
        if mdb.engine not in _backup_mod.ENGINE_DUMP_FORMAT:
            logger.warning(
                "Backup scheduler: db %s engine %r not supported (yet) — skipping.",
                db_id, mdb.engine,
            )
            return

        if mdb.status != ManagedDatabaseStatus.RUNNING:
            # Stopped or failed primary — record a failed backup row so
            # the operator sees in the UI that "the schedule fired but
            # the DB wasn't up." Don't pause the schedule; transient
            # downtime self-resolves.
            row = ManagedDatabaseBackup(
                primary_db_id=mdb.id,
                label=f"scheduled-skip-{utcnow().strftime('%Y%m%dT%H%M%SZ')}",
                file_path="",  # never created
                size_bytes=None,
                format="pgcustom",
                status=BackupStatus.FAILED,
                status_message=(
                    f"Scheduler fired but database was in '{mdb.status.value}' state "
                    f"— skipped pg_dump. Next fire will retry."
                ),
                is_scheduled=True,
            )
            db.add(row)
            db.commit()
            logger.info(
                "Backup scheduler: db %s not running (status=%s) — recorded skip",
                db_id, mdb.status,
            )
            return

        # The happy path.
        dump_path = backup.backup_path(str(mdb.id), label=None)
        row = ManagedDatabaseBackup(
            primary_db_id=mdb.id,
            label=f"scheduled-{utcnow().strftime('%Y%m%dT%H%M%SZ')}",
            file_path=str(dump_path),
            format=backup.ENGINE_DUMP_FORMAT.get(mdb.engine, "pgcustom"),
            status=BackupStatus.RUNNING,
            is_scheduled=True,
        )
        db.add(row)
        db.flush()

        try:
            password = decrypt_secret(mdb.password_encrypted)
            spec = backup.BackupSpec(
                engine=mdb.engine,
                image=mdb.image,
                primary_host="127.0.0.1",
                primary_port=mdb.port,
                db_name=mdb.database_name,
                db_user=mdb.username,
                db_password=password,
                host_dump_path=dump_path,
            )
            size = backup.run_backup(spec)
        except Exception as exc:  # noqa: BLE001
            row.status = BackupStatus.FAILED
            row.status_message = str(exc)[:500]
            db.commit()
            logger.exception("Backup scheduler: backup failed for db %s", db_id)
            return

        row.status = BackupStatus.READY
        row.size_bytes = size
        row.completed_at = utcnow()
        mdb.last_scheduled_backup_at = utcnow()
        db.commit()
        logger.info("Backup scheduler: db %s backed up successfully (%d bytes)", db_id, size)

        # Off-host fan-out (peer over tailnet / cloud folder). Best-effort —
        # a down destination can't fail the scheduled backup; PENDING/FAILED
        # copies are retried on the next tick via _sweep_pending_copies.
        try:
            from watchtower import backup_shipper
            backup_shipper.ship_backup(db, row)
        except Exception:  # noqa: BLE001
            logger.exception("Backup scheduler: off-host shipping raised for db %s", db_id)

        _prune_old_scheduled_backups(db, mdb)


def _prune_old_scheduled_backups(db, mdb) -> None:
    """Keep the most recent N scheduled backups, delete older ones from
    disk + DB. Manual backups (is_scheduled=False) are never touched.

    Called inside the scheduler's tick after a successful new backup.
    """
    from watchtower import managed_db_backup as backup
    from watchtower.database import ManagedDatabaseBackup

    keep = max(int(mdb.schedule_retention_count or 0), 1)
    candidates = (
        db.query(ManagedDatabaseBackup)
        .filter(
            ManagedDatabaseBackup.primary_db_id == mdb.id,
            ManagedDatabaseBackup.is_scheduled.is_(True),
        )
        .order_by(ManagedDatabaseBackup.created_at.desc())
        .all()
    )
    # Keep the first `keep` (newest), prune the rest.
    to_delete = candidates[keep:]
    for victim in to_delete:
        try:
            if victim.file_path:
                backup.delete_backup_file(victim.file_path)
                backup.prune_empty_dir(victim.file_path)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Backup scheduler: failed to delete file %s — continuing",
                victim.file_path,
            )
        db.delete(victim)
    if to_delete:
        db.commit()
        logger.info(
            "Backup scheduler: pruned %d old scheduled backup(s) for db %s",
            len(to_delete), mdb.id,
        )


def is_running() -> bool:
    """Test/debug helper: whether the scheduler is currently active."""
    return _scheduler is not None and _scheduler.running


def job_count() -> int:
    """Debug helper: how many cron jobs are currently registered."""
    if _scheduler is None:
        return 0
    return len(_scheduler.get_jobs())
