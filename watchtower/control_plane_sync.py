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

# Set transiently by the mesh trigger right before it calls sync_now(), so the
# pull records exactly which primary version it caught up to. Not thread-shared
# in anger — the mesh loop and the tick both run on the API's single event loop.
_pending_target_version: dict = {}
# Debounce: don't fire more than one gossip-triggered pull per this many secs.
_last_triggered_at: dict = {}


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
            # Record the primary version we just caught up to (if the caller
            # passed it via the mesh trigger), so we don't re-pull for the same
            # advertised version. ``target_version`` rides on the module global
            # set by the mesh trigger just before it calls us.
            tv = _pending_target_version.get("v")
            if tv:
                set_setting(db, _LAST_SYNCED_VERSION_KEY, str(tv))
        else:
            set_setting(db, this_pc._LAST_SYNC_ERROR_KEY, message[:300])
        db.commit()
        return ok, message
    finally:
        db.close()


def on_primary_version(primary_addr: str, advertised_version: int) -> None:
    """Mesh callback: a peer advertised its state version on a datagram.

    If that peer is our paired primary and its version is newer than what we've
    synced, pull *now* instead of waiting for the timed tick — the whole point
    of gossip-triggered sync. Debounced so a burst of primary changes collapses
    into at most one pull per DEBOUNCE_SECS. Best-effort; never raises into the
    mesh loop.
    """
    import time as _time

    DEBOUNCE_SECS = _debounce_secs()
    try:
        from watchtower.database import SessionLocal
        from watchtower.llm_settings import get_setting
        from watchtower.api import this_pc

        db = SessionLocal()
        try:
            if get_setting(db, this_pc._ROLE_KEY) != "standby":
                return
            peer_host = get_setting(db, this_pc._PEER_HOST_KEY) or ""
            # Mesh addr is tailscale-ip:mesh-port; pairing stores host (the IP).
            if peer_host and primary_addr.rsplit(":", 1)[0] != peer_host:
                return  # not our primary
            if advertised_version <= last_synced_version(db):
                return  # already caught up
        finally:
            db.close()

        # "Never triggered" must be a sentinel, not 0.0: time.monotonic() is
        # roughly seconds-since-boot on Linux, so on a freshly booted machine
        # monotonic() - 0.0 < DEBOUNCE_SECS would debounce away the FIRST
        # gossip-triggered sync after boot.
        last = _last_triggered_at.get("t")
        if last is not None and _time.monotonic() - last < DEBOUNCE_SECS:
            return
        _last_triggered_at["t"] = _time.monotonic()

        _pending_target_version["v"] = advertised_version
        try:
            ok, message = sync_now()
            logger.info("gossip-triggered sync (v=%d): %s", advertised_version, message)
        finally:
            _pending_target_version.pop("v", None)
    except Exception:  # noqa: BLE001 - must never break the mesh loop
        logger.debug("on_primary_version errored", exc_info=True)


def _debounce_secs() -> float:
    try:
        return max(0.0, float(os.getenv("WATCHTOWER_CP_SYNC_DEBOUNCE_SECS", "3")))
    except ValueError:
        return 3.0


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


_LAST_SYNCED_VERSION_KEY = "control_plane.last_synced_version"


def current_state_version(db=None) -> int:
    """A cheap, monotonic-ish version number for the primary's exportable state.

    Used by the mesh to advertise "my state changed" so standbys pull *now*
    instead of waiting for the next timed tick. Derived from data we already
    have — no new column, no per-writer bump:

      * every mutating endpoint writes an ``AuditEvent`` (append-only), so the
        row count strictly increases on each change; plus
      * ``system_settings`` changes (LLM/email/pairing/toggles) that may not go
        through the audit path, folded in as an epoch of the latest update.

    The exact value doesn't matter — only that it *increases* when the primary's
    state changes and stays put otherwise. Best-effort: returns 0 on any error
    (which simply means "fall back to the timed pull").
    """
    from watchtower.database import SessionLocal, AuditEvent, SystemSetting
    from sqlalchemy import func

    own_db = db is None
    if own_db:
        db = SessionLocal()
    try:
        audit_count = db.query(func.count(AuditEvent.id)).scalar() or 0
        latest_setting = db.query(func.max(SystemSetting.updated_at)).scalar()
        settings_epoch = int(latest_setting.timestamp()) if latest_setting else 0
        return int(audit_count) + settings_epoch
    except Exception:  # noqa: BLE001 - a version read must never raise
        logger.debug("state-version read failed", exc_info=True)
        return 0
    finally:
        if own_db:
            db.close()


def last_synced_version(db=None) -> int:
    from watchtower.llm_settings import get_setting
    own_db = db is None
    if own_db:
        from watchtower.database import SessionLocal
        db = SessionLocal()
    try:
        raw = get_setting(db, _LAST_SYNCED_VERSION_KEY)
        return int(raw) if raw else 0
    except (ValueError, TypeError):
        return 0
    finally:
        if own_db:
            db.close()


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
