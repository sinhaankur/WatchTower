"""Self-heal loop: diagnose every failed deployment, fix what's safe, queue the rest.

Closes the detect → diagnose → fix → verify circle for *build/deploy*
failures the way watchtower/autonomous.py closes it for *runtime*
failures (crashed containers). Every tick (default 45s):

  1. Find FAILED deployments from the last 24h that don't have a
     ``HealingAction`` row yet (the unique deployment_id constraint is
     the idempotency anchor — each failure is decided exactly once).
  2. Classify the build log with watchtower/failure_analyzer.
  3. Decide:
       * fix is auto-applicable AND the global autonomy switch is ON
         → apply it (new port / plain retry), queue the redeploy, record
         the action as AUTO_APPLIED. The new deployment is the verify step.
       * otherwise → record a PENDING action: the human-intervention
         queue the SPA renders under Settings → AI & Autonomy. For
         UNKNOWN failures, ask the configured LLM (LM Studio, Ollama,
         OpenAI, …) for a root-cause analysis and attach it so the human
         starts from a diagnosis instead of a raw log.

  Thrash guardrail: after 3 AUTO_APPLIED actions for the same project
  inside 10 minutes, stop auto-applying and queue for a human instead —
  same philosophy as the /auto-fix endpoint's 429.

The autonomy switch lives in system_settings (UI-editable; see
watchtower/llm_settings.is_autonomous_enabled). With the switch OFF the
loop still diagnoses everything — it just never acts without approval.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from watchtower import failure_analyzer
from watchtower.database import (
    Build,
    Deployment,
    DeploymentNode,
    DeploymentStatus,
    DeploymentTrigger,
    HealingAction,
    HealingActionStatus,
    Project,
    SessionLocal,
)
from watchtower.api.util import utcnow
from watchtower.llm_settings import is_autonomous_enabled, resolve_llm_config

logger = logging.getLogger(__name__)

LOG_EXCERPT_BYTES = 8 * 1024
MAX_DEPLOYMENTS_PER_TICK = 10
THRASH_WINDOW_MINUTES = 10
THRASH_MAX_AUTO_FIXES = 3


def _interval_secs() -> int:
    try:
        v = int(os.getenv("WATCHTOWER_SELF_HEAL_INTERVAL_SECS", "45"))
    except ValueError:
        v = 45
    return max(5, v)


# ── Diagnosis helpers ────────────────────────────────────────────────────────


def _log_excerpt_for(db: Session, deployment: Deployment) -> str:
    latest_build = (
        db.query(Build)
        .filter(Build.deployment_id == deployment.id)
        .order_by(Build.started_at.desc().nullslast())
        .first()
    )
    excerpt = (latest_build.build_output if latest_build else "") or ""
    return excerpt[-LOG_EXCERPT_BYTES:] if len(excerpt) > LOG_EXCERPT_BYTES else excerpt


def _is_thrashing(db: Session, project_id: UUID) -> bool:
    cutoff = utcnow() - timedelta(minutes=THRASH_WINDOW_MINUTES)
    recent = (
        db.query(HealingAction)
        .filter(
            HealingAction.project_id == project_id,
            HealingAction.status == HealingActionStatus.AUTO_APPLIED,
            HealingAction.created_at >= cutoff,
        )
        .count()
    )
    return recent >= THRASH_MAX_AUTO_FIXES


# ── LLM analysis (for UNKNOWN failures) ─────────────────────────────────────

_ANALYSIS_SYSTEM_PROMPT = (
    "You are WatchTower's deployment-failure analyst. You receive the tail "
    "of a failed build/deploy log. Reply with: (1) the most likely root "
    "cause in one or two sentences, (2) a concrete fix the operator can "
    "apply. Be specific — name the file, variable, package, or command "
    "involved. No preamble."
)


def _llm_analyze_sync(base_url: str, api_key: Optional[str], model: str, log_excerpt: str) -> str:
    from openai import OpenAI

    client = OpenAI(base_url=base_url, api_key=api_key or "not-set", timeout=30.0, max_retries=0)
    resp = client.chat.completions.create(
        model=model,
        max_tokens=600,
        messages=[
            {"role": "system", "content": _ANALYSIS_SYSTEM_PROMPT},
            {"role": "user", "content": f"Failed deployment log (tail):\n```\n{log_excerpt}\n```"},
        ],
    )
    return (resp.choices[0].message.content or "").strip()


async def analyze_with_llm(db: Session, log_excerpt: str) -> Optional[str]:
    """Best-effort free-form analysis. Returns None when no LLM is
    configured or the call fails — the healing action is still useful
    without it."""
    cfg = resolve_llm_config(db)
    if not cfg.configured or not log_excerpt:
        return None
    try:
        # analysis_model: the operator can pin a tiny model (0.5–2B) for
        # this background job while chat keeps a bigger one — or vice
        # versa. Falls back to the main model when unset.
        return await asyncio.to_thread(
            _llm_analyze_sync, cfg.base_url, cfg.api_key, cfg.analysis_model, log_excerpt
        )
    except Exception as exc:  # noqa: BLE001 — LLM down must not break the loop
        logger.info("self-heal: LLM analysis failed (%s) — continuing without it", exc)
        return None


# ── Second-tier classification (tiny-model) ──────────────────────────────────
#
# When the regex library returns UNKNOWN, a tiny model gets a second attempt
# at mapping the log onto a *known* FailureKind. It never invents a fix: its
# only job is to pick one of the kinds the deterministic library already knows
# how to handle. We then reuse that library's fix — so the action is always
# deterministic even when the classification came from the model.
#
# Only two kinds are auto-applied this way (REGISTRY_TRANSIENT, PORT_IN_USE)
# because they re-derive everything they need from the log and carry no risk
# of a wrong edit — a retry or a port change. Any other kind the model names
# is surfaced to the human as a *suggestion*, not applied. A confidence floor
# keeps a hedging model from acting.

# Kinds the model is allowed to act on (self-contained, log-derivable fixes).
_LLM_AUTO_APPLY_KINDS: frozenset[str] = frozenset({
    failure_analyzer.FailureKind.REGISTRY_TRANSIENT.value,
    failure_analyzer.FailureKind.PORT_IN_USE.value,
})

# Below this the model's guess is advisory only, never auto-applied.
_LLM_CONFIDENCE_FLOOR = 0.75


@dataclass
class LlmClassification:
    kind: str
    confidence: float
    reason: str


def _llm_classify_sync(
    base_url: str, api_key: Optional[str], model: str, log_excerpt: str,
) -> Optional["LlmClassification"]:
    """Ask the tiny model to pick a known FailureKind. Returns None on any
    parse/validation problem — a malformed answer must never become an action."""
    import json

    from openai import OpenAI

    known = [k.value for k in failure_analyzer.FailureKind if k != failure_analyzer.FailureKind.UNKNOWN]
    system = (
        "You classify a failed build/deploy log into exactly one known failure "
        "kind. Reply with ONLY a JSON object: "
        '{"kind": "<one of the kinds>", "confidence": <0..1>, "reason": "<short>"}. '
        "Use \"unknown\" if nothing fits. Kinds: " + ", ".join(known) + "."
    )
    client = OpenAI(base_url=base_url, api_key=api_key or "not-set", timeout=30.0, max_retries=0)
    resp = client.chat.completions.create(
        model=model,
        max_tokens=120,
        temperature=0,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": f"Log tail:\n```\n{log_excerpt}\n```"},
        ],
    )
    raw = (resp.choices[0].message.content or "").strip()
    # Tolerate a model that wraps JSON in prose or ```json fences.
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        data = json.loads(raw[start : end + 1])
    except (ValueError, TypeError):
        return None
    kind = str(data.get("kind", "")).strip().lower()
    valid = {k.value for k in failure_analyzer.FailureKind}
    if kind not in valid:
        return None
    try:
        conf = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))
    return LlmClassification(kind=kind, confidence=conf, reason=str(data.get("reason", ""))[:300])


async def classify_with_llm(db: Session, log_excerpt: str) -> Optional["LlmClassification"]:
    """Second-tier classifier. Returns None when no LLM is configured, the
    call fails, or the answer can't be trusted — the caller then falls back
    to the normal human-queue path."""
    cfg = resolve_llm_config(db)
    if not cfg.configured or not log_excerpt:
        return None
    try:
        return await asyncio.to_thread(
            _llm_classify_sync, cfg.base_url, cfg.api_key, cfg.analysis_model, log_excerpt
        )
    except Exception as exc:  # noqa: BLE001 — model problems must not break the loop
        logger.info("self-heal: LLM classification failed (%s) — continuing without it", exc)
        return None


# ── Fix application ─────────────────────────────────────────────────────────


def _queue_retry_deployment(db: Session, project: Project, failed: Deployment) -> Deployment:
    """Queue a fresh deployment with the failed one's branch/commit and
    the same node fan-out rule the manual trigger uses."""
    from watchtower.api.deployments import _select_org_nodes_for_deploy

    retry = Deployment(
        project_id=project.id,
        commit_sha=failed.commit_sha,
        commit_message=failed.commit_message,
        branch=failed.branch or "main",
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.SCHEDULED,  # filterable as "WatchTower acted on its own"
    )
    db.add(retry)
    db.flush()
    for node in _select_org_nodes_for_deploy(db, project, []):
        db.add(DeploymentNode(
            deployment_id=retry.id,
            node_id=node.id,
            status=DeploymentStatus.PENDING,
        ))
    return retry


def apply_fix(db: Session, action: HealingAction, project: Project, failed: Deployment) -> Deployment:
    """Apply an auto-applicable fix and queue the retry deployment.

    Raises ValueError for kinds that need human input — callers decide
    whether that's a 400 (API) or a queue-for-human (tick). The caller
    owns the transaction and the enqueue_build call.
    """
    kind = action.failure_kind
    if kind == failure_analyzer.FailureKind.REGISTRY_TRANSIENT.value:
        return _queue_retry_deployment(db, project, failed)

    if kind == failure_analyzer.FailureKind.PORT_IN_USE.value:
        from watchtower.api.runtime import pick_free_port_for_user

        diagnosis = failure_analyzer.classify_failure(_log_excerpt_for(db, failed))
        failed_port = None
        raw = (diagnosis.extracted or {}).get("port")
        if raw:
            try:
                failed_port = int(raw)
            except (TypeError, ValueError):
                failed_port = None
        new_port = pick_free_port_for_user(
            db, project.owner_id, excluded={failed_port} if failed_port else set()
        )
        if new_port is None:
            raise ValueError("No free port available in the project range.")
        project.recommended_port = new_port
        return _queue_retry_deployment(db, project, failed)

    raise ValueError(f"Fix for {kind} needs human input — it can't be applied automatically.")


# ── The tick ────────────────────────────────────────────────────────────────


async def _heal_deployment(db: Session, deployment: Deployment) -> None:
    project = db.query(Project).filter(Project.id == deployment.project_id).first()
    if not project or not project.is_active:
        return

    log_excerpt = _log_excerpt_for(db, deployment)
    diagnosis = failure_analyzer.classify_failure(log_excerpt)

    action = HealingAction(
        org_id=project.org_id,
        project_id=project.id,
        deployment_id=deployment.id,
        failure_kind=diagnosis.kind.value,
        cause=diagnosis.cause,
        fix_description=diagnosis.fix.description,
        auto_applicable=diagnosis.fix.auto_applicable,
        status=HealingActionStatus.PENDING,
    )
    db.add(action)

    autonomous = is_autonomous_enabled(db)

    if diagnosis.fix.auto_applicable and autonomous:
        if _is_thrashing(db, project.id):
            action.error = (
                f"Auto-fix guardrail: {THRASH_MAX_AUTO_FIXES} automatic fixes already "
                f"applied in the last {THRASH_WINDOW_MINUTES} minutes — waiting for a human."
            )
            db.commit()
            logger.warning("self-heal: project %s is thrashing — queued for human", project.id)
            return
        try:
            retry = apply_fix(db, action, project, deployment)
            action.status = HealingActionStatus.AUTO_APPLIED
            action.result_deployment_id = retry.id
            action.resolved_at = utcnow()
            from watchtower.api import audit as audit_log
            audit_log.record(
                db,
                action="healing.auto_fix",
                entity_type="deployment",
                entity_id=retry.id,
                org_id=project.org_id,
                actor_email="self-heal",
                extra={
                    "project_id": str(project.id),
                    "fix_kind": diagnosis.kind.value,
                    "failed_deployment_id": str(deployment.id),
                },
            )
            db.commit()
            from watchtower.queue import enqueue_build
            enqueue_build(str(retry.id))
            logger.warning(
                "self-heal: auto-fixed %s on project %s — retry deployment %s queued",
                diagnosis.kind.value, project.id, retry.id,
            )
            try:
                from watchtower.notifier import notify_project
                notify_project(
                    db, project.id,
                    f"🔧 Self-heal auto-fixed **{project.name}**\n"
                    f"Issue: {diagnosis.kind.value} — applied a fix and queued a retry deploy.",
                )
            except Exception:  # noqa: BLE001 - notify must not break the heal loop
                pass
            return
        except Exception as exc:  # noqa: BLE001 — a failed fix becomes a human task
            db.rollback()
            db.add(action)
            action.status = HealingActionStatus.PENDING
            action.error = f"Auto-fix failed: {exc}"
            db.commit()
            logger.exception("self-heal: auto-fix for deployment %s failed", deployment.id)
            return

    # Second tier: the regex library couldn't classify this. Give a tiny model
    # a chance to map it onto a KNOWN kind. If it names a confident, safe,
    # auto-applicable kind and autonomous mode is on (and we're not thrashing),
    # apply that library fix — the classification came from the model but the
    # fix is still deterministic. Otherwise, store the suggestion + free-text
    # analysis so the human queue entry is actionable.
    if diagnosis.kind == failure_analyzer.FailureKind.UNKNOWN:
        clf = await classify_with_llm(db, log_excerpt)
        if clf is not None:
            suggested = (
                f"[LLM classified: {clf.kind} · confidence {clf.confidence:.0%}]"
                f"{(' ' + clf.reason) if clf.reason else ''}"
            )
            can_act = (
                autonomous
                and clf.kind in _LLM_AUTO_APPLY_KINDS
                and clf.confidence >= _LLM_CONFIDENCE_FLOOR
                and clf.kind != failure_analyzer.FailureKind.UNKNOWN.value
                and not _is_thrashing(db, project.id)
            )
            if can_act:
                try:
                    action.failure_kind = clf.kind
                    action.auto_applicable = True
                    action.llm_analysis = suggested
                    retry = apply_fix(db, action, project, deployment)
                    action.status = HealingActionStatus.AUTO_APPLIED
                    action.result_deployment_id = retry.id
                    action.resolved_at = utcnow()
                    from watchtower.api import audit as audit_log
                    audit_log.record(
                        db,
                        action="healing.llm_fix",   # distinct from healing.auto_fix
                        entity_type="deployment",
                        entity_id=retry.id,
                        org_id=project.org_id,
                        actor_email="self-heal",
                        extra={
                            "project_id": str(project.id),
                            "fix_kind": clf.kind,
                            "confidence": round(clf.confidence, 3),
                            "failed_deployment_id": str(deployment.id),
                            "classifier": "llm",
                        },
                    )
                    db.commit()
                    from watchtower.queue import enqueue_build
                    enqueue_build(str(retry.id))
                    logger.warning(
                        "self-heal: LLM-classified %s (%.0f%%) on project %s — retry %s queued",
                        clf.kind, clf.confidence * 100, project.id, retry.id,
                    )
                    try:
                        from watchtower.notifier import notify_project
                        notify_project(
                            db, project.id,
                            f"🔧 Self-heal (assisted) fixed **{project.name}**\n"
                            f"An unrecognised failure was identified as `{clf.kind}` "
                            f"({clf.confidence:.0%} confidence) and a fix was applied.",
                        )
                    except Exception:  # noqa: BLE001 - notify must not break the loop
                        pass
                    return
                except Exception as exc:  # noqa: BLE001 — a failed fix becomes a human task
                    db.rollback()
                    db.add(action)
                    action.failure_kind = failure_analyzer.FailureKind.UNKNOWN.value
                    action.auto_applicable = False
                    action.status = HealingActionStatus.PENDING
                    action.llm_analysis = suggested
                    action.error = f"LLM-assisted fix failed: {exc}"
                    db.commit()
                    logger.exception("self-heal: LLM-assisted fix for deployment %s failed", deployment.id)
                    return
            # Not acted on — keep the suggestion + a human-readable analysis.
            analysis = await analyze_with_llm(db, log_excerpt)
            action.llm_analysis = f"{suggested}\n\n{analysis}" if analysis else suggested
        else:
            # No usable classification — fall back to free-text analysis.
            action.llm_analysis = await analyze_with_llm(db, log_excerpt)
    db.commit()
    logger.info(
        "self-heal: deployment %s (%s) queued for human intervention",
        deployment.id, diagnosis.kind.value,
    )
    try:
        from watchtower.notifier import notify_project
        notify_project(
            db, project.id,
            f"⚠️ **{project.name}** needs attention\n"
            f"A failed deploy ({diagnosis.kind.value}) couldn't be auto-fixed — "
            f"review it in Settings → AI & Autonomy.",
        )
    except Exception:  # noqa: BLE001 - notify must not break the heal loop
        pass


async def tick() -> int:
    """One scheduler iteration. Returns the number of failed deployments
    processed, for tests and cadence sanity-checks."""
    db = SessionLocal()
    processed = 0
    try:
        from sqlalchemy import select

        cutoff = utcnow() - timedelta(hours=24)
        already_decided = select(HealingAction.deployment_id)
        failed = (
            db.query(Deployment)
            .filter(
                Deployment.status == DeploymentStatus.FAILED,
                Deployment.created_at >= cutoff,
                ~Deployment.id.in_(already_decided),
            )
            .order_by(Deployment.created_at.asc())
            .limit(MAX_DEPLOYMENTS_PER_TICK)
            .all()
        )
        for d in failed:
            try:
                await _heal_deployment(db, d)
                processed += 1
            except Exception:  # pragma: no cover - defensive
                db.rollback()
                logger.exception("self-heal: deployment %s tick crashed", d.id)
    finally:
        db.close()
    return processed


# ── Scheduler glue (mirrors watchtower/autonomous.py) ───────────────────────

_scheduler = None


def start_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        return
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

    sched = AsyncIOScheduler()
    sched.add_job(tick, "interval", seconds=_interval_secs(), id="watchtower-self-heal-tick", max_instances=1)
    sched.start()
    _scheduler = sched
    logger.info("self-heal: scheduler started, ticking every %ss", _interval_secs())


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is None:
        return
    try:
        _scheduler.shutdown(wait=False)
    finally:
        _scheduler = None
        logger.info("self-heal: scheduler stopped")
