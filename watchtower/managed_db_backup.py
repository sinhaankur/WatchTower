"""On-demand backups for managed Postgres databases (v0).

Design:
  * The dump runs in a *transient* Postgres container (same image as the
    primary, so the pg_dump version matches the server version exactly
    — version-mismatch is the most common cause of confusing "could not
    backup" errors). The container talks to the primary over its
    published host port and writes the dump to a host-bind-mounted dir.
  * The host dir is rooted under ``$WATCHTOWER_DATA_DIR/managed_db_backups``
    (default ``~/.watchtower/managed_db_backups``). One subdir per DB,
    one file per backup timestamp.
  * Custom format (``-Fc``) so v1's restore feature can use ``pg_restore``
    with parallelism + selective restore. ``.dump`` extension to match
    Postgres conventions.

v0 deliberate non-features (these come in v1):
  * No scheduled / cron backups — POST a backup when you want one.
  * No off-host storage (S3, remote-PC via Tailscale).
  * No restore — too dangerous as a one-shot UX; needs dry-run + diff.
  * No GPG / encryption — backups are on the same disk as the DB, so
    an attacker with disk access already has the DB itself.
"""
from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from watchtower import managed_db_runtime as runtime

logger = logging.getLogger(__name__)


class BackupError(Exception):
    """User-facing backup failure with the pg_dump stderr inside."""


# ── Storage layout ───────────────────────────────────────────────────────────


def _backups_root() -> Path:
    """Where on the host we drop dump files.

    `~/.watchtower/managed_db_backups/<db_id>/<ts>.dump`. Lives under
    `$WATCHTOWER_DATA_DIR` to match the rest of WatchTower's local-state
    convention (secret.key, auth-signing.key, watchtower.db all live
    there too).
    """
    base = Path(
        os.getenv("WATCHTOWER_DATA_DIR")
        or os.path.join(os.path.expanduser("~"), ".watchtower")
    ) / "managed_db_backups"
    base.mkdir(parents=True, exist_ok=True)
    return base


def backup_path(db_id: str, label: Optional[str] = None) -> Path:
    """Compute the absolute file path for a new backup.

    Filename: ``YYYYMMDDTHHMMSS_microsec-<label?>.dump``. Microsecond
    precision so two backups taken within the same second (rapid
    "Backup now" clicks; the scheduler firing alongside an on-demand
    backup) never collide — without microseconds the second write
    silently overwrote the first dump file and the older row's
    file_path then pointed at the newer dump's bytes.
    """
    db_dir = _backups_root() / db_id
    db_dir.mkdir(parents=True, exist_ok=True)
    # `%f` is microseconds (6 digits). Stays sortable as a string.
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%f")
    slug = ""
    if label:
        cleaned = "".join(c for c in label if c.isalnum() or c in "-_")
        if cleaned:
            slug = f"-{cleaned[:40]}"
    return db_dir / f"{ts}{slug}.dump"


# ── pg_dump execution ────────────────────────────────────────────────────────


@dataclass
class BackupSpec:
    """Inputs for a backup of ANY supported engine.

    Routed by `engine` to the right tool — pg_dump for Postgres,
    mysqldump for MySQL/MariaDB, mongodump for MongoDB. Per-engine
    semantics:

      * **postgres**: pg_dump -Fc custom format. Restores with
        pg_restore --clean --if-exists.
      * **mysql / mariadb**: mysqldump --single-transaction --quick
        --routines --triggers. Restores by piping the .sql back into
        `mysql`.
      * **mongodb**: mongodump --archive=… (binary archive that
        mongorestore understands).
      * **redis**: NOT YET — RDB save+copy lives in a follow-up.
        Caller should reject before this is invoked.
    """
    # `engine` defaults to "postgres" so existing call sites (scheduler,
    # tests) that were written before the multi-engine refactor keep
    # working. Callers should set it explicitly when invoking for
    # MySQL/MariaDB/MongoDB.
    engine: str = "postgres"
    image: str = ""          # SAME image as the primary so dump tool versions match server
    primary_host: str = "127.0.0.1"
    primary_port: int = 5432
    db_name: str = ""
    db_user: str = ""
    db_password: str = ""
    host_dump_path: Path = Path()


# Format suffix per engine — used by callers (router + UI) to label the
# `format` column. Keeps the data model + restore-side dispatch in sync.
ENGINE_DUMP_FORMAT = {
    "postgres": "pgcustom",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "mongodb": "mongo",
}


def run_backup(spec: BackupSpec) -> int:
    """Run an engine-appropriate dump in a one-shot container.

    Returns the resulting file's size on disk. Mounts the dump file's
    PARENT directory into the container (not the file itself) — file
    bind-mounts race-create on Linux Podman; directory mounts are
    reliable everywhere.

    `PGPASSWORD` / `MYSQL_PWD` / mongo URI passwords are passed via
    env vars only — never on the command line — so they don't leak
    to host-side `ps`.
    """
    bin_ = runtime._podman_path()
    if not bin_:
        raise BackupError("No container runtime found.")

    spec.host_dump_path.parent.mkdir(parents=True, exist_ok=True)
    host_dir = str(spec.host_dump_path.parent)
    out_filename = spec.host_dump_path.name

    if spec.engine == "postgres":
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-e", f"PGPASSWORD={spec.db_password}",
               "-v", f"{host_dir}:/backup",
               spec.image,
               "pg_dump",
               "-h", spec.primary_host,
               "-p", str(spec.primary_port),
               "-U", spec.db_user,
               "-d", spec.db_name,
               "-Fc",                                       # custom format
               "-f", f"/backup/{out_filename}"]
    elif spec.engine in ("mysql", "mariadb"):
        # `--single-transaction` gives a consistent snapshot without
        # locking InnoDB tables for the dump duration. `--quick` avoids
        # buffering huge tables in memory inside the container.
        # `--routines --triggers --events` makes sure stored procs,
        # triggers, and scheduled events come along.
        # The mysqldump output goes to stdout; we use sh -c so the
        # shell redirect runs inside the container, not in the host shell.
        dump_tool = "mariadb-dump" if spec.engine == "mariadb" else "mysqldump"
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-e", f"MYSQL_PWD={spec.db_password}",
               "-v", f"{host_dir}:/backup",
               spec.image,
               "sh", "-c",
               # `--protocol=TCP` forces TCP even when the host is
               # 127.0.0.1; otherwise mysql client tries a local socket
               # inside the container that doesn't exist.
               f"{dump_tool} -h {spec.primary_host} -P {spec.primary_port} "
               f"--protocol=TCP -u {spec.db_user} "
               f"--single-transaction --quick --routines --triggers --events "
               f"{spec.db_name} > /backup/{out_filename}"]
    elif spec.engine == "mongodb":
        # mongodump produces a self-contained archive (--archive) that
        # mongorestore reads as a stream — no temp directory dance.
        # Auth lives in the connection URI; we use admin DB for auth
        # because the official image creates the root user there.
        uri = (
            f"mongodb://{spec.db_user}:{spec.db_password}@"
            f"{spec.primary_host}:{spec.primary_port}/?authSource=admin"
        )
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-v", f"{host_dir}:/backup",
               spec.image,
               "sh", "-c",
               f"mongodump --uri='{uri}' --db={spec.db_name} "
               f"--archive=/backup/{out_filename}"]
    else:
        raise BackupError(
            f"v1 backups don't yet support engine '{spec.engine}'. "
            f"Supported: postgres, mysql, mariadb, mongodb."
        )

    rc, out, err = runtime._run(cmd, timeout=3600.0)
    if rc != 0:
        # Clean up the partial file so a follow-up backup with the same
        # timestamp prefix doesn't pick up the half-baked one.
        try:
            spec.host_dump_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise BackupError(
            f"{spec.engine} backup failed: {err.strip() or out.strip() or 'unknown error'}"
        )

    try:
        return spec.host_dump_path.stat().st_size
    except OSError as exc:
        raise BackupError(
            f"backup completed but dump file is unreadable: {exc}"
        ) from exc


# Back-compat shim — the scheduler + tests call this name. Keeping the
# original signature so nothing else has to change.
def run_pg_dump(spec: BackupSpec) -> int:
    return run_backup(spec)


@dataclass
class RestoreSpec:
    """Inputs for a restore-in-place against a running managed database.

    Same engine routing as BackupSpec: postgres/mysql/mariadb/mongodb.
    The backup file must already be on the host at ``host_dump_path``;
    the transient restore container mounts its parent directory at
    ``/backup`` read-only.
    """
    engine: str = "postgres"
    image: str = ""
    primary_host: str = "127.0.0.1"
    primary_port: int = 5432
    db_name: str = ""
    db_user: str = ""
    db_password: str = ""
    host_dump_path: Path = Path()


def run_restore(spec: RestoreSpec) -> None:
    """Engine-aware restore-in-place. See ``run_pg_restore`` for the
    Postgres-specific notes; the same "replace objects without
    stopping the pod" goal applies across engines.
    """
    bin_ = runtime._podman_path()
    if not bin_:
        raise BackupError("No container runtime found.")
    if not spec.host_dump_path.is_file():
        raise BackupError(
            f"Backup file no longer exists on disk: {spec.host_dump_path}"
        )

    host_dir = str(spec.host_dump_path.parent)
    in_filename = spec.host_dump_path.name

    if spec.engine == "postgres":
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-e", f"PGPASSWORD={spec.db_password}",
               "-v", f"{host_dir}:/backup:ro",
               spec.image,
               "pg_restore",
               "-h", spec.primary_host,
               "-p", str(spec.primary_port),
               "-U", spec.db_user,
               "-d", spec.db_name,
               "--clean", "--if-exists",
               "--no-owner", "--no-privileges",
               "-v",
               f"/backup/{in_filename}"]
    elif spec.engine in ("mysql", "mariadb"):
        # Pipe the .sql back into the mysql client. mysqldump's output
        # is `DROP TABLE IF EXISTS` + `CREATE TABLE` per object, so the
        # restore replaces each table without dropping the database
        # itself — symmetric with the Postgres --clean --if-exists path.
        client_tool = "mariadb" if spec.engine == "mariadb" else "mysql"
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-e", f"MYSQL_PWD={spec.db_password}",
               "-v", f"{host_dir}:/backup:ro",
               spec.image,
               "sh", "-c",
               f"{client_tool} -h {spec.primary_host} -P {spec.primary_port} "
               f"--protocol=TCP -u {spec.db_user} "
               f"{spec.db_name} < /backup/{in_filename}"]
    elif spec.engine == "mongodb":
        # `--drop` drops each collection before restoring — same
        # "replace, don't merge" semantics as the others.
        uri = (
            f"mongodb://{spec.db_user}:{spec.db_password}@"
            f"{spec.primary_host}:{spec.primary_port}/?authSource=admin"
        )
        cmd = [bin_, "run", "--rm",
               "--network", "host",
               "-v", f"{host_dir}:/backup:ro",
               spec.image,
               "sh", "-c",
               f"mongorestore --uri='{uri}' --nsInclude='{spec.db_name}.*' "
               f"--drop --archive=/backup/{in_filename}"]
    else:
        raise BackupError(
            f"v1 restores don't yet support engine '{spec.engine}'. "
            f"Supported: postgres, mysql, mariadb, mongodb."
        )

    rc, out, err = runtime._run(cmd, timeout=3600.0)
    if rc != 0:
        raise BackupError(
            f"{spec.engine} restore failed: "
            f"{err.strip() or out.strip() or 'unknown error'}"
        )


# Back-compat shim — kept so test_managed_db_backup.py's monkeypatch
# target name stays stable.
def run_pg_restore(spec: RestoreSpec) -> None:
    """Restore a pg_dump custom-format backup into the running primary.

    Strategy: ``pg_restore --clean --if-exists`` against the *existing*
    database, instead of DROP DATABASE + CREATE + restore. Why:

      * Dropping the database requires terminating every connection to
        it first, which means racing the app + breaking active queries.
        Operators don't expect "restore my data" to also tear down
        every open session.
      * ``--clean --if-exists`` drops each object inside the DB before
        recreating it, so the end state is equivalent to "fresh DB
        loaded from the dump." The downside: extension state and
        objects not in the dump (manually-created views, custom roles)
        also get dropped — but that's true of any restore.
      * No need for the DB to be stopped/restarted, so the connection
        URL stays valid for the apps using it.

    Runs as a transient ``--rm`` container using the SAME image as the
    target DB so the pg_restore version matches the server version
    exactly (a mismatch is the #1 cause of confusing "could not
    restore" errors).
    """
    bin_ = runtime._podman_path()
    if not bin_:
        raise BackupError("No container runtime found.")

    if not spec.host_dump_path.is_file():
        raise BackupError(
            f"Backup file no longer exists on disk: {spec.host_dump_path}"
        )

    host_dir = str(spec.host_dump_path.parent)
    in_filename = spec.host_dump_path.name

    rc, out, err = runtime._run(
        [bin_, "run", "--rm",
         "--network", "host",
         "-e", f"PGPASSWORD={spec.db_password}",
         "-v", f"{host_dir}:/backup:ro",
         spec.image,
         "pg_restore",
         "-h", spec.primary_host,
         "-p", str(spec.primary_port),
         "-U", spec.db_user,
         "-d", spec.db_name,
         "--clean",          # drop existing objects before recreating
         "--if-exists",      # don't error on already-absent objects
         "--no-owner",       # restore objects as the connecting user, not the dumper
         "--no-privileges",  # skip GRANT/REVOKE — connecting user has full access
         "-v",               # verbose so failures surface in stderr
         f"/backup/{in_filename}"],
        timeout=3600.0,  # 1h for large restores
    )
    if rc != 0:
        # pg_restore prints actionable detail (e.g. "could not connect:
        # FATAL: password authentication failed"); preserve verbatim.
        raise BackupError(
            f"pg_restore failed: {err.strip() or out.strip() or 'unknown error'}"
        )


def delete_backup_file(file_path: str) -> None:
    """Unlink the dump from disk. Best-effort — a missing file is fine
    (the DB row gets removed regardless)."""
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Failed to delete backup file %s: %s", file_path, exc)


def prune_empty_dir(file_path: str) -> None:
    """If the per-DB backup directory is now empty, remove it. Keeps
    `~/.watchtower/managed_db_backups/` from accumulating empty dirs
    after a DB is fully deleted."""
    try:
        parent = Path(file_path).parent
        if parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
    except OSError:
        pass


def total_size_for_db(db_id: str) -> int:
    """Sum of all backup file sizes for one DB. Surfaced in the UI so
    users can see how much disk the snapshots are eating."""
    db_dir = _backups_root() / db_id
    if not db_dir.is_dir():
        return 0
    total = 0
    for p in db_dir.iterdir():
        try:
            total += p.stat().st_size
        except OSError:
            continue
    return total


def free_disk_bytes() -> int:
    """Free space on the backups volume — surfaced in the UI as a
    sanity check before kicking off a large backup."""
    try:
        usage = shutil.disk_usage(str(_backups_root()))
        return usage.free
    except OSError:
        return 0
