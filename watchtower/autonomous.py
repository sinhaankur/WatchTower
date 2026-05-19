"""Phase 4: autonomous-mode probe + restart + rollback engine.

Runs as a background tick inside the FastAPI process. Every
``WATCHTOWER_AUTONOMOUS_INTERVAL_SECS`` (default 60s), the tick:

  1. Loads every project where ``autonomous_mode=True`` AND
     ``run_as_container=True``.
  2. For each project, picks the primary deploy target node (preferring
     ``is_primary``; falls back to the first node).
  3. SSH-probes the container's bound port — the same probe the Phase 1
     deploy uses on first start.
  4. Follows a failure ladder per (project, node) pair:
       - 1st consecutive fail  → log only (transient blip tolerance).
       - 2nd consecutive fail  → `podman restart <name>`, re-probe.
       - 3rd consecutive fail  → trigger an auto-rollback to the
         previous LIVE deployment. Mark the project quarantined so
         further ticks don't re-act on the same failure until an
         operator intervenes.
  5. On any success, resets the per-pair failure counter.

The failure counters live in an in-memory dict — losing them on API
restart is *correct*: an operator restart is itself the resolution we
were ladder-ing toward. A migration-backed table would burn DB writes
every 60 seconds for state that's already cheap to rebuild.

This module deliberately does not depend on the MCP / agent layers —
the tick runs entirely server-side, no LLM, no external network beyond
the SSH probe.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shlex
import time
from dataclasses import dataclass, field
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from watchtower.database import (
    Build,
    BuildStatus,
    Deployment,
    DeploymentNode,
    DeploymentStatus,
    DeploymentTrigger,
    OrgNode,
    Project,
    SessionLocal,
)
from watchtower.api.util import utcnow

logger = logging.getLogger(__name__)


# ── Configuration ───────────────────────────────────────────────────────────


def _interval_secs() -> int:
    """Tick cadence. Operator override via env so a CI/test run can
    pin a fast cadence and we don't have to wait the default 60s."""
    try:
        v = int(os.getenv("WATCHTOWER_AUTONOMOUS_INTERVAL_SECS", "60"))
    except ValueError:
        v = 60
    return max(5, v)


def _quarantine_cooldown_secs() -> int:
    """After an auto-rollback, wait this long before acting on the same
    project again — gives the rollback build time to complete and lets
    an on-call human inspect. Operator-overridable."""
    try:
        v = int(os.getenv("WATCHTOWER_AUTONOMOUS_QUARANTINE_SECS", "900"))
    except ValueError:
        v = 900
    return max(60, v)


# ── Per-pair probe state ────────────────────────────────────────────────────


@dataclass
class _ProbeState:
    """In-memory bookkeeping for one (project_id, node_id) pair.

    Kept tiny — only what the failure ladder needs to make its next
    decision. Reset on success.
    """
    consecutive_failures: int = 0
    last_probe_at: float = 0.0
    last_action_at: float = 0.0
    quarantined_until: float = 0.0  # epoch seconds; 0 == not quarantined


_STATE: dict[tuple[UUID, UUID], _ProbeState] = {}


def _state_for(project_id: UUID, node_id: UUID) -> _ProbeState:
    key = (project_id, node_id)
    st = _STATE.get(key)
    if st is None:
        st = _ProbeState()
        _STATE[key] = st
    return st


def reset_state() -> None:
    """Test helper — wipes the in-memory probe state. Production callers
    don't need this; the dict resets implicitly on API restart."""
    _STATE.clear()


def snapshot_state() -> list[dict]:
    """Read-only view for the /autonomous-status endpoint and tests."""
    now = time.time()
    return [
        {
            "project_id": str(pid),
            "node_id": str(nid),
            "consecutive_failures": st.consecutive_failures,
            "last_probe_at": st.last_probe_at,
            "last_action_at": st.last_action_at,
            "quarantined": st.quarantined_until > now,
            "quarantined_until": st.quarantined_until if st.quarantined_until > now else None,
        }
        for (pid, nid), st in _STATE.items()
    ]


# ── Helpers for what we do on each tick ─────────────────────────────────────


def _pick_target_node(nodes: list[OrgNode]) -> Optional[OrgNode]:
    """Same selection rule as Phase 3's DNS sync — primary first, else
    the first node listed. Keeps the chosen target consistent across
    phases so an operator only has to think about one knob."""
    if not nodes:
        return None
    for n in nodes:
        if getattr(n, "is_primary", False):
            return n
    return nodes[0]


async def _probe_container(node: OrgNode, port: int) -> bool:
    """SSH a single HTTP probe to the container's bound port. Returns
    True only on a clean 2xx/3xx/4xx — connection refused or timeout
    means the container is sick."""
    # Lazy import — the builder module pulls in a lot of build-runner
    # state; this avoids a cycle when autonomous.py is imported during
    # FastAPI startup before builder's globals are settled.
    from watchtower.builder import _ssh_run

    cmd = f"curl -fsS -m 3 http://127.0.0.1:{int(port)}/ -o /dev/null"
    ok, _err = await _ssh_run(node, cmd, lambda _l: None, prefix="[autonomous] ")
    return ok


async def _restart_container(project: Project, node: OrgNode) -> tuple[bool, str]:
    """Restart the Phase 1 container on *node*. We restart rather than
    stop+run because the container is configured with --restart=always
    so podman keeps the desired state — restart is the minimum-blast-
    radius action that recovers from a crashed worker or an OOM.
    """
    from watchtower.builder import _container_name, _ssh_run

    cname = _container_name(project)
    cmd = f"podman restart {shlex.quote(cname)}"
    ok, err = await _ssh_run(node, cmd, lambda _l: None, prefix="[autonomous] ")
    return ok, err


# ── Auto-rollback (in-process, no HTTP roundtrip) ───────────────────────────


def _enqueue_auto_rollback(db: Session, project: Project) -> Optional[UUID]:
    """Mirror /deployments/{id}/rollback's logic without going through
    HTTP. Returns the new deployment's id on success, None if there's
    nothing to roll back to.

    The auto-rollback is logged under DeploymentTrigger.SCHEDULED so
    operators can filter "autonomous mode kicked in" in the deployment
    history.
    """
    # Find the current LIVE deployment we're rolling away from.
    current_live = (
        db.query(Deployment)
        .filter(Deployment.project_id == project.id, Deployment.status == DeploymentStatus.LIVE)
        .order_by(Deployment.created_at.desc())
        .first()
    )
    if not current_live:
        logger.warning("autonomous: no LIVE deployment for project %s — nothing to roll back", project.id)
        return None

    # Find the deployment before the current LIVE one — that's our target.
    prev_live = (
        db.query(Deployment)
        .filter(
            Deployment.project_id == project.id,
            Deployment.status == DeploymentStatus.LIVE,
            Deployment.created_at < current_live.created_at,
        )
        .order_by(Deployment.created_at.desc())
        .first()
    )
    if not prev_live:
        logger.warning(
            "autonomous: project %s has only one LIVE deployment — no rollback target",
            project.id,
        )
        return None

    rollback = Deployment(
        project_id=project.id,
        commit_sha=prev_live.commit_sha,
        commit_message=prev_live.commit_message,
        branch=prev_live.branch,
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.SCHEDULED,
    )
    db.add(rollback)
    current_live.status = DeploymentStatus.ROLLED_BACK
    db.flush()

    # Recreate the deployment-node fan-out so the build runner picks the
    # same targets the original deploy used. Avoids "rollback ran but
    # only on one node" surprises in multi-node setups.
    for dn in db.query(DeploymentNode).filter(DeploymentNode.deployment_id == current_live.id).all():
        db.add(DeploymentNode(
            deployment_id=rollback.id,
            node_id=dn.node_id,
            status=DeploymentStatus.PENDING,
        ))

    db.commit()
    db.refresh(rollback)

    # Enqueue the build runner. Import locally to avoid a cycle.
    from watchtower.queue import enqueue_build
    enqueue_build(str(rollback.id))

    logger.warning(
        "autonomous: project %s rolled back %s → %s (now deployment %s)",
        project.id, current_live.id, prev_live.id, rollback.id,
    )
    return rollback.id


# ── The tick ────────────────────────────────────────────────────────────────


async def _evaluate_project(db: Session, project: Project) -> None:
    """Run one tick of the failure ladder for one project.

    Skips work when there's an active deploy on the project — let the
    operator-triggered work finish before piling on probes. Skips
    quarantined pairs until the cooldown elapses.
    """
    active_deploy = (
        db.query(Deployment)
        .filter(
            Deployment.project_id == project.id,
            Deployment.status.in_([DeploymentStatus.BUILDING, DeploymentStatus.DEPLOYING]),
        )
        .first()
    )
    if active_deploy:
        logger.debug("autonomous: project %s has an active deploy — skipping tick", project.id)
        return

    port = project.recommended_port
    if not port:
        return  # Phase 1 won't even start without a port; ladder is moot

    # The DeploymentNode fan-out names which nodes hold the live build.
    live_deploy = (
        db.query(Deployment)
        .filter(Deployment.project_id == project.id, Deployment.status == DeploymentStatus.LIVE)
        .order_by(Deployment.created_at.desc())
        .first()
    )
    node_ids: list[UUID]
    if live_deploy:
        node_ids = [
            dn.node_id for dn in db.query(DeploymentNode).filter(DeploymentNode.deployment_id == live_deploy.id).all()
        ]
    else:
        node_ids = []
    nodes = (
        db.query(OrgNode).filter(OrgNode.id.in_(node_ids)).all()
        if node_ids
        else []
    )
    target = _pick_target_node(nodes)
    if not target:
        return  # no deploy targets yet — nothing to probe

    st = _state_for(project.id, target.id)
    now = time.time()
    if st.quarantined_until > now:
        return  # cooldown hasn't elapsed

    st.last_probe_at = now
    ok = await _probe_container(target, int(port))

    if ok:
        if st.consecutive_failures:
            logger.info(
                "autonomous: project %s recovered on node %s after %d fail(s)",
                project.id, target.host, st.consecutive_failures,
            )
        st.consecutive_failures = 0
        return

    # Ladder
    st.consecutive_failures += 1
    st.last_action_at = now
    failures = st.consecutive_failures

    if failures == 1:
        logger.info(
            "autonomous: project %s probe failed once on node %s — tolerating as transient",
            project.id, target.host,
        )
        return

    if failures == 2:
        logger.warning(
            "autonomous: project %s failed twice on node %s — restarting container",
            project.id, target.host,
        )
        await _restart_container(project, target)
        return

    # failures >= 3: rollback + quarantine
    logger.error(
        "autonomous: project %s failed %d times on node %s — auto-rollback",
        project.id, failures, target.host,
    )
    _enqueue_auto_rollback(db, project)
    st.quarantined_until = now + _quarantine_cooldown_secs()
    st.consecutive_failures = 0


async def tick() -> int:
    """One scheduler iteration. Returns the count of projects evaluated
    so the caller (or a test) can sanity-check the cadence."""
    db = SessionLocal()
    evaluated = 0
    try:
        projects = (
            db.query(Project)
            .filter(Project.autonomous_mode == True)  # noqa: E712 — SA needs literal True for SQLite
            .filter(Project.run_as_container == True)  # noqa: E712
            .filter(Project.is_active == True)  # noqa: E712
            .all()
        )
        for p in projects:
            try:
                await _evaluate_project(db, p)
                evaluated += 1
            except Exception:  # pragma: no cover - defensive
                logger.exception("autonomous: project %s tick crashed", p.id)
    finally:
        db.close()
    return evaluated


# ── Scheduler glue ──────────────────────────────────────────────────────────


_scheduler = None  # set by start_scheduler(); held module-level so stop_scheduler() can find it


def start_scheduler() -> None:
    """Stand up the AsyncIOScheduler that runs `tick` on a cadence.

    Idempotent — calling twice is a no-op. The lifespan hook in
    api/__init__.py calls this on startup; the worker process doesn't
    need it (a worker without an API in front of it has no need to
    autonomously act on deploys).
    """
    global _scheduler
    if _scheduler is not None:
        return
    # Lazy import: pulling in apscheduler at module-import time burns
    # ~100ms in tests that never need the scheduler. Defer the cost.
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    sched = AsyncIOScheduler()
    sched.add_job(tick, "interval", seconds=_interval_secs(), id="watchtower-autonomous-tick", max_instances=1)
    sched.start()
    _scheduler = sched
    logger.info("autonomous: scheduler started, ticking every %ss", _interval_secs())


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    try:
        _scheduler.shutdown(wait=False)
    finally:
        _scheduler = None
        logger.info("autonomous: scheduler stopped")
