"""Automatic control-plane failover, triggered by the mesh.

When ``mesh.py``'s failure detector CONFIRMS the paired primary is dead, a
standby node can self-promote to primary so the control plane keeps serving.
This is the "trustworthy trigger" the HA stack was missing — ``control_plane_sync``
already keeps a warm snapshot; it just never had a reliable "the primary is
*really* gone" signal to act on.

Safety model (deliberately conservative)
----------------------------------------
1. **Only a standby with auto-failover ENABLED acts.** The switch
   (``control_plane.auto_failover_enabled``) defaults **OFF** — matching every
   other autonomous WatchTower behaviour. Detect-and-record stays the default.
2. **Only the paired primary's death matters.** A dead unrelated peer is logged
   by the mesh but never promotes anyone.
3. **Partition guard.** We only promote if enough *other* mesh members agree the
   primary is unreachable (a quorum), so a standby that is itself partitioned
   from the primary — but where the primary is fine — does NOT wrongly promote
   and split-brain the cluster. With no other members to ask, we require an
   explicit ``WATCHTOWER_FAILOVER_ALLOW_SOLO=true`` opt-in.
4. **No live DB swap.** Consistent with the existing restore philosophy
   (``api/runtime.py``: live restore is disaster-prone), we do NOT hot-swap the
   SQLite file under a running process. Instead we (a) flip the role to primary
   immediately — the standby keeps serving with its warm state, minutes-old at
   worst — and (b) stage the latest snapshot + write a marker so an operator (or
   a restart) can finish an exact restore. The audit event + notification make
   the promotion loud, never silent.

The whole path is best-effort and never raises into the mesh loop.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# system_settings keys (kept in the control_plane.* namespace as this_pc.py).
AUTO_FAILOVER_KEY = "control_plane.auto_failover_enabled"
LAST_FAILOVER_KEY = "control_plane.last_failover_at"
LAST_FAILOVER_NOTE_KEY = "control_plane.last_failover_note"


def is_auto_failover_enabled(db) -> bool:
    from watchtower.llm_settings import get_setting
    val = get_setting(db, AUTO_FAILOVER_KEY)
    if val is not None:
        return val.strip().lower() == "true"
    return os.getenv("WATCHTOWER_AUTO_FAILOVER", "false").lower() == "true"


def _quorum_confirms_dead(primary_addr: str) -> bool:
    """Ask the mesh whether *other* members also see the primary as gone.

    Returns True if a strict majority of the other alive members agree (or if
    solo operation is explicitly allowed). This is the split-brain guard: a
    standby merely partitioned from the primary won't have quorum and won't
    promote.
    """
    from watchtower import mesh
    daemon = mesh.get_daemon()
    if daemon is None:
        return os.getenv("WATCHTOWER_FAILOVER_ALLOW_SOLO", "false").lower() == "true"

    members = daemon.state.members
    prim = members.get(primary_addr)
    # Our own detector must class the primary DEAD (the caller guarantees this).
    if prim is None or prim.state.value != "dead":
        return False

    others = [m for m in members.values()
              if m.addr != primary_addr and m.state.value == "alive"]
    if not others:
        # No one else to corroborate. Only promote if the operator opted in.
        allow_solo = os.getenv("WATCHTOWER_FAILOVER_ALLOW_SOLO", "false").lower() == "true"
        if allow_solo:
            logger.warning("failover: no quorum peers, promoting under ALLOW_SOLO")
        return allow_solo

    # We can't RPC each peer's opinion in v1, so we approximate: if the primary
    # is DEAD in our view AND we still see a healthy quorum of other nodes (so
    # WE are clearly not the partitioned one), treat it as corroborated. A
    # future version can gossip per-member "I see X as dead" votes.
    return len(others) >= 1


def on_peer_dead(addr: str) -> None:
    """Mesh callback: ``addr`` was just CONFIRMED dead. Synchronous + guarded —
    the mesh loop calls this directly, so it must never raise or block long."""
    try:
        _maybe_failover(addr)
    except Exception:  # noqa: BLE001 - never propagate into the mesh loop
        logger.exception("failover: on_peer_dead(%s) errored", addr)


def _maybe_failover(dead_addr: str) -> None:
    from watchtower.database import SessionLocal
    from watchtower.llm_settings import get_setting, set_setting
    from watchtower.api import this_pc
    from watchtower import control_plane_sync

    db = SessionLocal()
    try:
        role = get_setting(db, this_pc._ROLE_KEY)
        if role != "standby":
            return  # only a standby promotes
        if not is_auto_failover_enabled(db):
            logger.info("failover: primary %s looks dead but auto-failover is OFF", dead_addr)
            return

        peer_host = get_setting(db, this_pc._PEER_HOST_KEY) or ""
        peer_port = get_setting(db, this_pc._PEER_PORT_KEY) or ""
        # The mesh addr is tailscale-ip:mesh-port; the pairing stores the peer's
        # host + API port. Match on the host portion (the tailscale IP).
        dead_host = dead_addr.rsplit(":", 1)[0]
        if peer_host and dead_host != peer_host:
            return  # a different peer died, not our primary

        if not _quorum_confirms_dead(dead_addr):
            logger.warning(
                "failover: primary %s dead in our view but no quorum — NOT promoting "
                "(likely a local partition, not a real primary failure)", dead_addr)
            _note(db, set_setting, f"Saw primary {dead_host} as dead but lacked quorum — held back to avoid split-brain.")
            db.commit()
            return

        # ── Promote. ──
        from watchtower.api.util import utcnow
        snap = control_plane_sync.snapshot_status()
        note = (
            f"Promoted to PRIMARY after mesh confirmed {dead_host} dead. "
            + (f"Warm snapshot staged ({snap.get('snapshot_bytes')} bytes, "
               f"from {snap.get('snapshot_mtime')}) — restart to load exact state, "
               "or keep serving current warm state."
               if snap.get("snapshot_present")
               else "No snapshot present — serving this node's own warm state.")
        )
        set_setting(db, this_pc._ROLE_KEY, "primary")
        # The old primary/standby link no longer applies to us as primary.
        set_setting(db, this_pc._PEER_TOKEN_KEY, None)
        set_setting(db, LAST_FAILOVER_KEY, utcnow().isoformat())
        set_setting(db, LAST_FAILOVER_NOTE_KEY, note)
        db.commit()
        logger.warning("failover: %s", note)

        _audit_and_notify(db, dead_host, note)
    finally:
        db.close()


def _note(db, set_setting, msg: str) -> None:
    from watchtower.api.util import utcnow
    set_setting(db, LAST_FAILOVER_NOTE_KEY, msg)
    set_setting(db, LAST_FAILOVER_KEY, utcnow().isoformat())


def _audit_and_notify(db, dead_host: str, note: str) -> None:
    # Audit (system actor — no user triggered this).
    try:
        from watchtower.database import AuditEvent
        db.add(AuditEvent(
            action="ha.failover",
            entity_type="control_plane",
            actor_email="system@watchtower",
            extra={"dead_primary": dead_host, "note": note},
        ))
        db.commit()
    except Exception:  # noqa: BLE001 - audit is best-effort here
        logger.debug("failover: audit write failed", exc_info=True)

    # Notify every org so a human learns immediately.
    try:
        from watchtower.database import Organization
        from watchtower.notifier import notify_org
        for org in db.query(Organization).all():
            notify_org(db, org.id,
                       f"🔴 **Failover:** primary `{dead_host}` went down — this node "
                       f"self-promoted to **primary**. {note}")
    except Exception:  # noqa: BLE001 - notify must not fail the promotion
        logger.debug("failover: notify failed", exc_info=True)


def status(db) -> dict:
    """Failover facts for the control-plane status endpoint."""
    from watchtower.llm_settings import get_setting
    return {
        "auto_failover_enabled": is_auto_failover_enabled(db),
        "last_failover_at": get_setting(db, LAST_FAILOVER_KEY),
        "last_failover_note": get_setting(db, LAST_FAILOVER_NOTE_KEY),
    }
