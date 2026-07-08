"""Off-host backup shipping (watchtower/backup_shipper.py).

Fans a completed managed-DB dump out to enabled BackupDestinations. We mock
the actual transports (_push_to_peer / _push_to_folder) so no network or peer
filesystem is touched, and assert:
  * only ENABLED destinations receive the file,
  * the right transport is chosen per kind,
  * best-effort: one failing destination doesn't stop the others, nothing
    raises into the backup path,
  * a BackupCopy row is upserted per (backup, destination) with the right
    status, and the unique constraint means re-shipping is idempotent,
  * retry_pending_copies re-attempts PENDING/FAILED copies.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from watchtower import backup_shipper
from watchtower.api import util
from watchtower.database import (
    BackupCopy,
    BackupCopyStatus,
    BackupDestination,
    BackupDestinationKind,
    BackupStatus,
    ManagedDatabase,
    ManagedDatabaseBackup,
    ManagedDatabaseStatus,
    OrgNode,
)


# ── fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def managed_db(db_session, org_id):
    mdb = ManagedDatabase(
        id=uuid.uuid4(),
        org_id=org_id,
        name="pg-main",
        engine="postgres",
        image="postgres:16",
        pod_name="wt-pg-main",
        container_name="wt-pg-main-db",
        volume_name="wt-pg-main-data",
        port=5433,
        database_name="app",
        username="app",
        password_encrypted=util.encrypt_secret("secret"),
        status=ManagedDatabaseStatus.RUNNING,
    )
    db_session.add(mdb)
    db_session.commit()
    return mdb


@pytest.fixture
def ready_backup(db_session, managed_db, tmp_path):
    dump = tmp_path / "dump.dump"
    dump.write_bytes(b"PGDMP fake dump bytes")
    row = ManagedDatabaseBackup(
        id=uuid.uuid4(),
        primary_db_id=managed_db.id,
        file_path=str(dump),
        format="pgcustom",
        status=BackupStatus.READY,
        size_bytes=dump.stat().st_size,
    )
    db_session.add(row)
    db_session.commit()
    return row


def _folder_dest(db, org_id, path="/mnt/nas/backups", enabled=True):
    d = BackupDestination(
        id=uuid.uuid4(), org_id=org_id, kind=BackupDestinationKind.FOLDER,
        label="nas", folder_path=path, is_enabled=enabled,
    )
    db.add(d)
    db.commit()
    return d


def _peer_dest(db, org_id, enabled=True):
    node = OrgNode(
        id=uuid.uuid4(), org_id=org_id, name="linux-pc",
        host="100.64.0.5", user="ankur", port=22, remote_path="/srv/deploy",
        ssh_key_path="/home/ankur/.ssh/id_ed25519",
    )
    db.add(node)
    db.commit()
    d = BackupDestination(
        id=uuid.uuid4(), org_id=org_id, kind=BackupDestinationKind.PEER,
        label="Home Linux PC", node_id=node.id, remote_subdir="watchtower-backups",
        is_enabled=enabled,
    )
    db.add(d)
    db.commit()
    return d


# ── fan-out ───────────────────────────────────────────────────────────────────


def test_ships_to_enabled_folder_and_peer(db_session, org_id, ready_backup, monkeypatch):
    _folder_dest(db_session, org_id)
    _peer_dest(db_session, org_id)
    folder_calls, peer_calls = [], []
    monkeypatch.setattr(backup_shipper, "_push_to_folder",
                        lambda src, path, db_id: folder_calls.append((str(src), path, db_id)) or f"{path}/{db_id}/x")
    monkeypatch.setattr(backup_shipper, "_push_to_peer",
                        lambda node, src, subdir, db_id: peer_calls.append((node.host, db_id)) or f"{node.host}:x")

    sent = backup_shipper.ship_backup(db_session, ready_backup)
    assert sent == 2
    assert len(folder_calls) == 1 and len(peer_calls) == 1
    copies = db_session.query(BackupCopy).filter_by(backup_id=ready_backup.id).all()
    assert {c.status for c in copies} == {BackupCopyStatus.COPIED}


def test_skips_disabled_destination(db_session, org_id, ready_backup, monkeypatch):
    _folder_dest(db_session, org_id, enabled=True)
    _folder_dest(db_session, org_id, path="/mnt/off", enabled=False)
    monkeypatch.setattr(backup_shipper, "_push_to_folder",
                        lambda src, path, db_id: f"{path}/x")
    sent = backup_shipper.ship_backup(db_session, ready_backup)
    assert sent == 1
    # Only the enabled dest got a copy row.
    assert db_session.query(BackupCopy).count() == 1


def test_one_failing_dest_does_not_stop_others(db_session, org_id, ready_backup, monkeypatch):
    good = _folder_dest(db_session, org_id, path="/mnt/good")
    bad = _folder_dest(db_session, org_id, path="/mnt/bad")

    def flaky(src, path, db_id):
        if "bad" in path:
            raise OSError("read-only filesystem")
        return f"{path}/x"

    monkeypatch.setattr(backup_shipper, "_push_to_folder", flaky)
    sent = backup_shipper.ship_backup(db_session, ready_backup)  # must not raise
    assert sent == 1
    by_dest = {c.destination_id: c for c in db_session.query(BackupCopy).all()}
    assert by_dest[good.id].status == BackupCopyStatus.COPIED
    assert by_dest[bad.id].status == BackupCopyStatus.FAILED
    assert "read-only" in by_dest[bad.id].message


def test_reship_is_idempotent(db_session, org_id, ready_backup, monkeypatch):
    _folder_dest(db_session, org_id)
    calls = []
    monkeypatch.setattr(backup_shipper, "_push_to_folder",
                        lambda src, path, db_id: calls.append(1) or f"{path}/x")
    backup_shipper.ship_backup(db_session, ready_backup)
    backup_shipper.ship_backup(db_session, ready_backup)  # second run
    # Only one copy row (unique constraint), and no re-push of an already-COPIED file.
    assert db_session.query(BackupCopy).count() == 1
    assert len(calls) == 1


def test_no_destinations_is_noop(db_session, org_id, ready_backup):
    assert backup_shipper.ship_backup(db_session, ready_backup) == 0
    assert db_session.query(BackupCopy).count() == 0


def test_not_ready_backup_is_skipped(db_session, org_id, managed_db):
    row = ManagedDatabaseBackup(
        id=uuid.uuid4(), primary_db_id=managed_db.id, file_path="/nope",
        format="pgcustom", status=BackupStatus.RUNNING,
    )
    db_session.add(row)
    db_session.commit()
    _folder_dest(db_session, org_id)
    assert backup_shipper.ship_backup(db_session, row) == 0


def test_missing_dump_file_is_skipped(db_session, org_id, managed_db):
    row = ManagedDatabaseBackup(
        id=uuid.uuid4(), primary_db_id=managed_db.id,
        file_path="/tmp/does-not-exist-xyz.dump",
        format="pgcustom", status=BackupStatus.READY,
    )
    db_session.add(row)
    db_session.commit()
    _folder_dest(db_session, org_id)
    assert backup_shipper.ship_backup(db_session, row) == 0


# ── retry sweep ───────────────────────────────────────────────────────────────


def test_retry_pending_copies_reships_failed(db_session, org_id, ready_backup, monkeypatch):
    dest = _folder_dest(db_session, org_id)
    # First attempt fails.
    monkeypatch.setattr(backup_shipper, "_push_to_folder",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("dest offline")))
    backup_shipper.ship_backup(db_session, ready_backup)
    copy = db_session.query(BackupCopy).filter_by(destination_id=dest.id).one()
    assert copy.status == BackupCopyStatus.FAILED
    assert copy.attempts == 1

    # Destination comes back — the sweep succeeds.
    monkeypatch.setattr(backup_shipper, "_push_to_folder", lambda src, path, db_id: f"{path}/x")
    n = backup_shipper.retry_pending_copies(db_session)
    assert n == 1
    db_session.refresh(copy)
    assert copy.status == BackupCopyStatus.COPIED
    assert copy.attempts == 2


# ── peer transport command shape (mock subprocess) ────────────────────────────


def test_push_to_peer_builds_injection_safe_rsync(db_session, org_id, tmp_path, monkeypatch):
    src = tmp_path / "d.dump"
    src.write_bytes(b"x")
    node = OrgNode(
        id=uuid.uuid4(), org_id=org_id, name="pc", host="100.64.0.9",
        user="me", port=2222, remote_path="/srv", ssh_key_path="/keys/id",
    )
    captured = {}

    class _P:
        returncode = 0
        stdout = b""

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return _P()

    # Force the rsync branch regardless of the test host's PATH.
    monkeypatch.setattr(backup_shipper.shutil, "which", lambda name: "/usr/bin/rsync")
    monkeypatch.setattr(backup_shipper.subprocess, "run", fake_run)
    out = backup_shipper._push_to_peer(node, src, "watchtower-backups", "dbid123")

    cmd = captured["cmd"]
    assert cmd[0] == "rsync"
    # -e string carries the ssh invocation with the port + key, shell-quoted.
    e_idx = cmd.index("-e")
    ssh_e = cmd[e_idx + 1]
    assert "-p 2222" in ssh_e
    assert "/keys/id" in ssh_e
    # destination is user@host:subdir/dbid/
    assert cmd[-1] == "me@100.64.0.9:watchtower-backups/dbid123/"
    assert out == "100.64.0.9:watchtower-backups/dbid123/d.dump"


# ── cross-platform transport selection (Windows/Mac/Linux, any chip) ──────────


def test_peer_falls_back_to_sftp_when_no_rsync(db_session, org_id, tmp_path, monkeypatch):
    """No rsync on PATH (e.g. stock Windows) → paramiko SFTP path is used."""
    src = tmp_path / "d.dump"
    src.write_bytes(b"x")
    node = OrgNode(
        id=uuid.uuid4(), org_id=org_id, name="pc", host="100.64.0.9",
        user="me", port=22, remote_path="/srv",
    )
    monkeypatch.setattr(backup_shipper.shutil, "which", lambda name: None)  # no rsync
    monkeypatch.setattr(backup_shipper, "_have_paramiko", lambda: True)
    sftp_calls = []
    monkeypatch.setattr(backup_shipper, "_push_to_peer_sftp",
                        lambda n, s, sub, dbid: sftp_calls.append((n.host, dbid)) or f"{n.host}:x")
    # rsync path must NOT be taken.
    monkeypatch.setattr(backup_shipper, "_push_to_peer_rsync",
                        lambda *a, **k: pytest.fail("rsync path used despite no rsync"))

    out = backup_shipper._push_to_peer(node, src, "watchtower-backups", "dbid123")
    assert sftp_calls == [("100.64.0.9", "dbid123")]
    assert out == "100.64.0.9:x"


def test_peer_actionable_error_when_no_transport(db_session, org_id, tmp_path, monkeypatch):
    """Neither rsync nor paramiko → a clear, actionable error (never a hang)."""
    src = tmp_path / "d.dump"
    src.write_bytes(b"x")
    node = OrgNode(id=uuid.uuid4(), org_id=org_id, name="pc", host="h", user="u", port=22)
    monkeypatch.setattr(backup_shipper.shutil, "which", lambda name: None)
    monkeypatch.setattr(backup_shipper, "_have_paramiko", lambda: False)
    with pytest.raises(RuntimeError) as ei:
        backup_shipper._push_to_peer(node, src, "watchtower-backups", "dbid123")
    msg = str(ei.value).lower()
    assert "rsync" in msg and ("[ssh]" in msg or "folder destination" in msg)


def test_sftp_makedirs_creates_missing_segments():
    """_sftp_makedirs is mkdir -p: creates each missing segment, skips existing."""
    made = []

    class FakeSftp:
        def __init__(self, existing):
            self.existing = set(existing)

        def stat(self, path):
            if path not in self.existing:
                raise IOError("no such file")

        def mkdir(self, path):
            made.append(path)
            self.existing.add(path)

    sftp = FakeSftp(existing={"watchtower-backups"})  # parent already there
    backup_shipper._sftp_makedirs(sftp, "watchtower-backups/dbid123")
    assert made == ["watchtower-backups/dbid123"]  # only the missing leaf


@pytest.mark.parametrize("path,ok", [
    ("/mnt/nas/backups", True),
    ("~/Dropbox/wt", True),
    (r"C:\Backups", True),
    ("D:/backups", True),
    (r"\\server\share\backups", True),
    ("relative/path", False),
    ("backups", False),
    ("", False),
])
def test_folder_path_validation_is_cross_platform(path, ok):
    """POSIX and Windows absolute paths accepted; relative paths rejected —
    so a WatchTower host on any OS can register a folder destination."""
    from watchtower.api.backup_destinations import _is_absolute_folder_path
    assert _is_absolute_folder_path(path) is ok
