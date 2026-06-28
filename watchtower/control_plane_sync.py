"""Standby control-plane state sync.

When this node's control-plane role is ``standby`` (set via the pairing API in
api/this_pc.py), it periodically pulls the PRIMARY's state export
(GET /api/runtime/backup/export — a tar.gz of the SQLite DB + secret.key) over
the tailnet and stores the latest snapshot locally. Failover then means
restoring the most recent snapshot.

Scope (honest): this keeps a recent WARM snapshot on the standby. It does NOT
do live streaming replication or automatic failover — those are separate. The
value here is "if the primary dies, the standby has the state from minutes ago,
not nothing."

Transport is the tailnet (already WireGuard-encrypted), so we pull over http to
the peer's Tailscale IP; auth is the primary's API token (stored encrypted at
pair time). The pull is gated to SQLite installs because that's what the export
endpoint supports.
"""
from __future__ import annotations

import logging
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

_scheduler = None


def _interval_secs() -> int:
    try:
        v = int(os.getenv("WATCHTOWER_CP_SYNC_INTERVAL_SECS", "300"))  # 5 min default
        return max(30, v)
    except ValueError:
        return 300


def _snapshot_dir() -> Path:
    base = os.getenv("WATCHTOWER_DATA_DIR")
    root = Path(base).expanduser() if base else (Path.home() / ".watchtower")
    return root / "standby-snapshots"


def latest_snapshot_path() -> Path:
    return _snapshot_dir() / "primary-state.tar.gz"


def _pull_once(host: str, port: int, token: str) -> Tuple[bool, str]:
    """Pull the primary's state export to a temp file, then atomically swap it
    into place. Returns (ok, message). Never raises."""
    url = f"http://{host}:{port}/api/runtime/backup/export"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    sd = _snapshot_dir()
    try:
        sd.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, f"Could not create snapshot dir: {exc}"

    tmp = latest_snapshot_path().with_suffix(".tar.gz.part")
    try:
        with urllib.request.urlopen(req, timeout=30.0) as resp:  # noqa: S310 - tailnet IP, encrypted transport
            if resp.status != 200:
                return False, f"Primary returned HTTP {resp.status}."
            data = resp.read()
    except Exception as exc:  # noqa: BLE001 - network / auth / primary-down
        return False, f"Could not reach primary: {exc}"

    if not data:
        return False, "Primary returned an empty export."
    try:
        tmp.write_bytes(data)
        os.replace(tmp, latest_snapshot_path())  # atomic swap
    except OSError as exc:
        return False, f"Could not write snapshot: {exc}"
    return True, f"Synced {len(data)} bytes from primary."


def sync_now() -> Tuple[bool, str]:
    """Read the pairing from settings and pull once (used by the tick AND the
    manual 'Sync now' endpoint). Returns (ok, message)."""
    from watchtower.database import SessionLocal
    from watchtower.llm_settings import get_setting, set_setting
    from watchtower.api import this_pc

    db = SessionLocal()
    try:
        role = get_setting(db, this_pc._ROLE_KEY)
        if role != "standby":
            return False, "This node is not a standby — nothing to sync."
        host = get_setting(db, this_pc._PEER_HOST_KEY)
        token = get_setting(db, this_pc._PEER_TOKEN_KEY)
        port = int(get_setting(db, this_pc._PEER_PORT_KEY) or this_pc._WATCHTOWER_PORT)
        if not host or not token:
            return False, "Standby is missing the primary's host or token — re-pair with a token."

        ok, message = _pull_once(host, port, token)
        now = datetime.now(timezone.utc).isoformat()
        if ok:
            set_setting(db, this_pc._LAST_SYNC_KEY, now)
            set_setting(db, this_pc._LAST_SYNC_ERROR_KEY, None)
        else:
            set_setting(db, this_pc._LAST_SYNC_ERROR_KEY, message[:300])
        db.commit()
        return ok, message
    finally:
        db.close()


async def tick() -> bool:
    """Scheduler tick: pull if we're a standby. Returns whether a sync ran."""
    try:
        ok, message = sync_now()
        if ok:
            logger.info("control-plane sync: %s", message)
        else:
            # Demote noisy "not a standby" to debug; real failures stay info.
            (logger.debug if "not a standby" in message else logger.info)(
                "control-plane sync skipped/failed: %s", message
            )
        return ok
    except Exception:  # noqa: BLE001 - a tick must never crash the scheduler
        logger.exception("control-plane sync tick errored")
        return False


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    if os.getenv("WATCHTOWER_CP_SYNC_DISABLE", "").lower() == "true":
        logger.info("control-plane sync disabled via WATCHTOWER_CP_SYNC_DISABLE")
        return
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    sched = AsyncIOScheduler()
    sched.add_job(tick, "interval", seconds=_interval_secs(),
                  id="watchtower-cp-sync-tick", max_instances=1)
    sched.start()
    _scheduler = sched
    logger.info("control-plane sync: scheduler started, ticking every %ss", _interval_secs())


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        except Exception:  # noqa: BLE001
            pass
        _scheduler = None


def snapshot_status() -> dict:
    """Local snapshot facts for the status endpoint."""
    p = latest_snapshot_path()
    if not p.is_file():
        return {"snapshot_present": False, "snapshot_bytes": None, "snapshot_mtime": None}
    try:
        st = p.stat()
        return {
            "snapshot_present": True,
            "snapshot_bytes": st.st_size,
            "snapshot_mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
        }
    except OSError:
        return {"snapshot_present": False, "snapshot_bytes": None, "snapshot_mtime": None}
