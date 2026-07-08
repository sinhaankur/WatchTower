"""Off-host backup shipping: fan a completed managed-DB dump out to every
enabled :class:`BackupDestination`.

The always-on-Linux-PC use case: an operator registers their home Linux box
as a ``kind='peer'`` destination once, and from then on every managed-DB
backup this machine produces (on-demand *and* scheduled) is auto-copied there
over the tailnet. A cloud-synced or NAS folder is a ``kind='folder'``
destination — same fan-out, the bytes just land in a local path instead of a
remote node.

Two transports:
  * **peer** — non-destructive single-file rsync-over-SSH into
    ``~/<remote_subdir>/<db_id>/`` on the node. We deliberately do NOT reuse
    ``builder._rsync_to_node`` because that syncs a *directory* with
    ``--delete`` (it would wipe everything else at the node's deploy path).
    We copy its injection-safe ``-e`` construction instead.
  * **folder** — ``shutil.copy2`` into ``<folder_path>/<db_id>/``. Works for a
    NAS mount or a Dropbox/Drive/rclone-synced directory.

Everything here is **best-effort**: a down peer or an unwritable folder marks
the copy ``PENDING``/``FAILED`` and is retried on the next scheduler tick — it
must never raise into the backup path, because a failed *off-host copy* must
not fail the *backup itself* (the local dump is already safe on disk).
"""
from __future__ import annotations

import logging
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# rsync/ssh push timeout. Dumps can be large; an hour matches the backup
# runner's own timeout so a slow-but-progressing transfer isn't killed.
_PUSH_TIMEOUT_SECS = 3600.0


def _enabled_destinations(db: Session, org_id) -> list:
    """Enabled destinations for an org (org_id may be None on single-user
    installs — those rows have org_id NULL and still match)."""
    from watchtower.database import BackupDestination

    q = db.query(BackupDestination).filter(BackupDestination.is_enabled.is_(True))
    if org_id is None:
        q = q.filter(BackupDestination.org_id.is_(None))
    else:
        q = q.filter(BackupDestination.org_id == org_id)
    return q.all()


def _org_id_for_backup(db: Session, backup_row) -> Optional[object]:
    """The org that owns the backup's primary database — destinations are
    org-scoped, so we match on this."""
    from watchtower.database import ManagedDatabase

    mdb = (
        db.query(ManagedDatabase)
        .filter(ManagedDatabase.id == backup_row.primary_db_id)
        .first()
    )
    return getattr(mdb, "org_id", None) if mdb else None


# ── Transports ────────────────────────────────────────────────────────────────


def _push_to_folder(src: Path, folder_path: str, db_id: str) -> str:
    """Copy the dump into ``<folder_path>/<db_id>/``. Returns the dest path.
    Raises on any filesystem error (caller records it as FAILED)."""
    dest_dir = Path(folder_path).expanduser() / db_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    # copy2 preserves mtime — nice for "when was this backed up" at a glance.
    shutil.copy2(src, dest)
    return str(dest)


def _safe_remote_dir(remote_subdir: str, db_id: str) -> str:
    """Relative remote dir under the login user's home. Sanitised to plain
    path segments so a malicious subdir can't escape or inject."""
    subdir = (remote_subdir or "watchtower-backups").strip().strip("/")
    if not subdir or ".." in subdir.split("/"):
        subdir = "watchtower-backups"
    return f"{subdir}/{db_id}"


def _push_to_peer(node, src: Path, remote_subdir: str, db_id: str) -> str:
    """Copy one dump file to ``~/<remote_subdir>/<db_id>/`` on *node* over SSH.
    Non-destructive. Returns the remote path.

    Transport auto-selection so this works on Linux, macOS, AND Windows,
    regardless of chip:
      * ``rsync`` on PATH (Linux/macOS, or Windows with rsync) → the fast
        delta-transfer path.
      * else ``paramiko`` (pure-Python SSH/SFTP, ships with the [ssh] extra)
        → universal fallback; the key is read in-memory (no temp file, so no
        Windows file-permission gap).
      * neither available → a clear, actionable error (never a silent hang).
    """
    if shutil.which("rsync"):
        return _push_to_peer_rsync(node, src, remote_subdir, db_id)
    if _have_paramiko():
        return _push_to_peer_sftp(node, src, remote_subdir, db_id)
    raise RuntimeError(
        "Peer backups need either `rsync` on PATH or the pure-Python SSH extra. "
        "Install rsync, or `pip install watchtower-podman[ssh]`, or use a "
        "folder destination instead."
    )


def _have_paramiko() -> bool:
    try:
        import paramiko  # noqa: F401
        return True
    except ImportError:
        return False


def _push_to_peer_rsync(node, src: Path, remote_subdir: str, db_id: str) -> str:
    """rsync-over-SSH transport (Linux/macOS fast path).

    Security: every node-supplied token that lands inside rsync's ``-e``
    string is ``shlex.quote``-d — the same CWE-78 guard the builder uses —
    because ``-e`` is parsed by a local shell.
    """
    from watchtower.api import util

    remote_dir = _safe_remote_dir(remote_subdir, db_id)
    remote_dest = f"{node.user}@{node.host}:{remote_dir}/"
    port = int(node.port or 22)  # cast → ValueError on an injection attempt

    keyfile_to_cleanup: Optional[str] = None
    try:
        ssh_parts = [
            "ssh",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ConnectTimeout=15",
            "-p", str(port),
        ]

        # Prefer an on-disk key path; otherwise materialise the encrypted key
        # to a 0600 temp file for the duration of the transfer.
        if node.ssh_key_path:
            ssh_parts += ["-i", node.ssh_key_path]
        elif getattr(node, "ssh_key_encrypted", None):
            private_pem = util.decrypt_secret(node.ssh_key_encrypted)
            kf = tempfile.NamedTemporaryFile(
                prefix="wt-backup-key-", suffix=".pem", delete=False
            )
            kf.write(private_pem.encode("ascii"))
            kf.close()
            Path(kf.name).chmod(0o600)
            keyfile_to_cleanup = kf.name
            ssh_parts += ["-i", kf.name]

        ssh_e = " ".join(shlex.quote(p) for p in ssh_parts)

        # `--mkpath` makes the remote dir on the fly (rsync ≥3.2.3).
        cmd = [
            "rsync", "-az", "--mkpath",
            "-e", ssh_e,
            str(src),
            remote_dest,
        ]
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=_PUSH_TIMEOUT_SECS,
        )
        if proc.returncode != 0:
            out = (proc.stdout or b"").decode("utf-8", "replace")
            # --mkpath is rsync ≥3.2.3; on older rsync it errors. Retry once
            # with an explicit remote mkdir via --rsync-path.
            if "--mkpath" in out or "unknown option" in out:
                cmd_fallback = [
                    "rsync", "-az",
                    "--rsync-path", f"mkdir -p {shlex.quote(remote_dir)} && rsync",
                    "-e", ssh_e,
                    str(src),
                    remote_dest,
                ]
                proc = subprocess.run(
                    cmd_fallback,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=_PUSH_TIMEOUT_SECS,
                )
                out = (proc.stdout or b"").decode("utf-8", "replace")
            if proc.returncode != 0:
                raise RuntimeError(out.strip() or f"rsync exit {proc.returncode}")

        return f"{node.host}:{remote_dir}/{src.name}"
    finally:
        if keyfile_to_cleanup:
            try:
                os.unlink(keyfile_to_cleanup)
            except OSError:
                pass


def _push_to_peer_sftp(node, src: Path, remote_subdir: str, db_id: str) -> str:
    """Pure-Python SSH/SFTP transport (paramiko). Universal fallback that runs
    identically on Windows, macOS, and Linux with no external binary.

    The private key is loaded from the encrypted blob IN MEMORY — nothing
    touches disk, so the Windows "chmod is a no-op" temp-key-permission gap
    can't apply here. No shell is invoked, so there's no ``-e``/quoting
    surface at all.
    """
    import paramiko

    from watchtower.api import util

    remote_dir = _safe_remote_dir(remote_subdir, db_id)
    port = int(node.port or 22)  # cast → ValueError on an injection attempt

    pkey = None
    if getattr(node, "ssh_key_encrypted", None):
        pkey = _load_private_key(paramiko, util.decrypt_secret(node.ssh_key_encrypted))
    elif node.ssh_key_path:
        pkey = _load_private_key_file(paramiko, node.ssh_key_path)

    client = paramiko.SSHClient()
    # accept-new equivalent: trust on first use (same posture as the rsync
    # path's StrictHostKeyChecking=accept-new; these are the operator's own
    # tailnet peers).
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=node.host,
            port=port,
            username=node.user,
            pkey=pkey,
            timeout=15,
            allow_agent=False,
            look_for_keys=False,
        )
        sftp = client.open_sftp()
        try:
            _sftp_makedirs(sftp, remote_dir)
            remote_file = f"{remote_dir}/{src.name}"
            sftp.put(str(src), remote_file)
        finally:
            sftp.close()
        return f"{node.host}:{remote_dir}/{src.name}"
    finally:
        client.close()


def _load_private_key(paramiko, pem: str):
    """Parse a PEM private key string into a paramiko key, trying each key
    type (RSA / Ed25519 / ECDSA) — we don't know which the operator used."""
    import io

    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key(io.StringIO(pem))
        except Exception:  # noqa: BLE001 - wrong type, try the next
            continue
    raise RuntimeError("could not parse the node's SSH private key (unsupported type?)")


def _load_private_key_file(paramiko, path: str):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError(f"could not parse SSH private key at {path}")


def _sftp_makedirs(sftp, remote_dir: str) -> None:
    """mkdir -p over SFTP (relative to the login user's home). paramiko has no
    recursive mkdir, so we create each segment, ignoring 'already exists'."""
    parts = [p for p in remote_dir.split("/") if p]
    cur = ""
    for part in parts:
        cur = f"{cur}/{part}" if cur else part
        try:
            sftp.stat(cur)
        except IOError:
            sftp.mkdir(cur)


# ── Fan-out ───────────────────────────────────────────────────────────────────


def _ship_one(db: Session, backup_row, dest, src: Path) -> None:
    """Ship *src* to a single destination, upserting its BackupCopy row.
    Never raises — records COPIED / FAILED / PENDING on the row instead."""
    from watchtower.database import (
        BackupCopy,
        BackupCopyStatus,
        BackupDestinationKind,
    )

    copy = (
        db.query(BackupCopy)
        .filter(BackupCopy.backup_id == backup_row.id,
                BackupCopy.destination_id == dest.id)
        .first()
    )
    if copy is None:
        copy = BackupCopy(backup_id=backup_row.id, destination_id=dest.id)
        db.add(copy)
    if copy.status == BackupCopyStatus.COPIED:
        return  # already shipped — idempotent no-op

    copy.attempts = (copy.attempts or 0) + 1
    db_id = str(backup_row.primary_db_id)
    try:
        if dest.kind == BackupDestinationKind.FOLDER:
            if not dest.folder_path:
                raise RuntimeError("folder destination has no folder_path set")
            copy.dest_path = _push_to_folder(src, dest.folder_path, db_id)
        elif dest.kind == BackupDestinationKind.PEER:
            if dest.node is None:
                raise RuntimeError("peer destination has no node")
            copy.dest_path = _push_to_peer(dest.node, src, dest.remote_subdir, db_id)
        else:
            raise RuntimeError(f"unknown destination kind {dest.kind!r}")
        copy.status = BackupCopyStatus.COPIED
        copy.message = None
        logger.info("backup %s → %s (%s): copied", backup_row.id, dest.label or dest.id, dest.kind.value)
    except Exception as exc:  # noqa: BLE001 - best-effort; one dest can't break others
        copy.status = BackupCopyStatus.FAILED
        copy.message = str(exc)[:500]
        logger.warning(
            "backup %s → %s (%s): failed: %s",
            backup_row.id, dest.label or dest.id, dest.kind.value, exc,
        )


def ship_backup(db: Session, backup_row) -> int:
    """Fan a completed backup out to every enabled destination. Returns the
    number of destinations the file reached successfully. Best-effort — never
    raises into the backup path.

    Call this right after a backup row is marked READY (the local dump is
    already safe on disk; this is the *extra* off-host copy)."""
    from watchtower.database import BackupStatus

    if getattr(backup_row, "status", None) != BackupStatus.READY:
        return 0
    if not backup_row.file_path:
        return 0
    src = Path(backup_row.file_path)
    if not src.is_file():
        logger.warning("ship_backup: dump file missing on disk: %s", src)
        return 0

    org_id = _org_id_for_backup(db, backup_row)
    dests = _enabled_destinations(db, org_id)
    if not dests:
        return 0

    for dest in dests:
        _ship_one(db, backup_row, dest, src)
    db.commit()

    from watchtower.database import BackupCopy, BackupCopyStatus
    return (
        db.query(BackupCopy)
        .filter(BackupCopy.backup_id == backup_row.id,
                BackupCopy.status == BackupCopyStatus.COPIED)
        .count()
    )


def retry_pending_copies(db: Session, limit: int = 50) -> int:
    """Re-attempt PENDING / FAILED copies (a destination that was offline when
    the backup ran). Returns how many newly succeeded. Called from the backup
    scheduler tick so an intermittently-reachable peer eventually catches up."""
    from watchtower.database import (
        BackupCopy,
        BackupCopyStatus,
        ManagedDatabaseBackup,
    )

    stuck = (
        db.query(BackupCopy)
        .filter(BackupCopy.status.in_([BackupCopyStatus.PENDING, BackupCopyStatus.FAILED]))
        .order_by(BackupCopy.updated_at.asc())
        .limit(limit)
        .all()
    )
    succeeded = 0
    for copy in stuck:
        backup_row = (
            db.query(ManagedDatabaseBackup)
            .filter(ManagedDatabaseBackup.id == copy.backup_id)
            .first()
        )
        if backup_row is None or not backup_row.file_path:
            continue
        src = Path(backup_row.file_path)
        if not src.is_file():
            copy.status = BackupCopyStatus.FAILED
            copy.message = "source dump no longer on disk"
            continue
        dest = copy.destination
        if dest is None or not dest.is_enabled:
            continue
        _ship_one(db, backup_row, dest, src)
        if copy.status == BackupCopyStatus.COPIED:
            succeeded += 1
    db.commit()
    return succeeded
