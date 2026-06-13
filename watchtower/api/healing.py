"""Self-heal API: the autonomy switch + the human-intervention queue.

Read side powers Settings → AI & Autonomy:
  * ``GET /api/healing/config``    — autonomy switch + whether an LLM is wired
  * ``GET /api/healing/actions``   — healing decisions, newest first
Write side:
  * ``PUT /api/healing/config``                  — flip the autonomy switch (admin)
  * ``POST /api/healing/actions/{id}/approve``   — apply the fix / retry the deploy
  * ``POST /api/healing/actions/{id}/dismiss``   — close without acting

Approve semantics: for auto-applicable fixes (port conflict, registry
flake) WatchTower applies the fix and queues the retry. For everything
else, approve means "I fixed the underlying problem myself — retry the
deployment now". Dismiss just archives the entry.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower import self_heal
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.api.util import utcnow
from watchtower.database import (
    Deployment,
    HealingAction,
    HealingActionStatus,
    Project,
    get_db,
)
from watchtower.llm_settings import (
    KEY_AUTONOMOUS_ENABLED,
    is_autonomous_enabled,
    resolve_llm_config,
    set_setting,
)
from watchtower.queue import enqueue_build

router = APIRouter(prefix="/api/healing", tags=["Self-heal"])
logger = logging.getLogger(__name__)


class HealingConfigUpdate(BaseModel):
    autonomous_enabled: bool


def _action_dict(a: HealingAction, project_name: Optional[str] = None) -> Dict[str, Any]:
    return {
        "id": str(a.id),
        "project_id": str(a.project_id),
        "project_name": project_name,
        "deployment_id": str(a.deployment_id),
        "failure_kind": a.failure_kind,
        "cause": a.cause,
        "fix_description": a.fix_description,
        "auto_applicable": a.auto_applicable,
        "llm_analysis": a.llm_analysis,
        "status": a.status.value if hasattr(a.status, "value") else str(a.status),
        "result_deployment_id": str(a.result_deployment_id) if a.result_deployment_id else None,
        "error": a.error,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "resolved_at": a.resolved_at.isoformat() if a.resolved_at else None,
    }


@router.get("/config")
async def get_healing_config(
    _user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    cfg = resolve_llm_config(db)
    pending = (
        db.query(HealingAction)
        .filter(HealingAction.status == HealingActionStatus.PENDING)
        .count()
    )
    return {
        "autonomous_enabled": is_autonomous_enabled(db),
        "llm_configured": cfg.configured,
        "pending_actions": pending,
    }


@router.put("/config")
async def update_healing_config(
    req: HealingConfigUpdate,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Flip the global autonomy switch. Admin-gated like the LLM config —
    'WatchTower may act without asking' is an instance-level decision."""
    from watchtower.api.agent import _require_admin

    user, org = _require_admin(db, current_user)
    set_setting(
        db, KEY_AUTONOMOUS_ENABLED,
        "true" if req.autonomous_enabled else "false",
        user_id=user.id,
    )
    audit_log.record_for_user(
        db, current_user,
        action="healing.autonomy_toggle",
        entity_type="system_setting",
        org_id=org.id,
        extra={"autonomous_enabled": req.autonomous_enabled},
    )
    db.commit()
    return {"autonomous_enabled": is_autonomous_enabled(db)}


@router.get("/actions")
async def list_healing_actions(
    status_filter: Optional[str] = None,
    limit: int = 50,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
):
    """Healing decisions for projects the caller can see, newest first.
    ``status_filter=pending`` is the intervention queue."""
    user_id = util.canonical_user_id(db, current_user)
    q = (
        db.query(HealingAction, Project.name)
        .join(Project, HealingAction.project_id == Project.id)
        .filter(Project.owner_id == user_id)
    )
    if status_filter:
        try:
            wanted = HealingActionStatus(status_filter)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown status {status_filter!r}.",
            )
        q = q.filter(HealingAction.status == wanted)
    rows = q.order_by(HealingAction.created_at.desc()).limit(max(1, min(limit, 200))).all()
    return [_action_dict(a, name) for a, name in rows]


def _load_pending_action(db: Session, action_id: UUID, current_user: dict) -> tuple[HealingAction, Project]:
    user_id = util.canonical_user_id(db, current_user)
    row = (
        db.query(HealingAction, Project)
        .join(Project, HealingAction.project_id == Project.id)
        .filter(HealingAction.id == action_id, Project.owner_id == user_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Healing action not found")
    action, project = row
    if action.status != HealingActionStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This action was already resolved ({action.status.value}).",
        )
    return action, project


@router.post("/actions/{action_id}/approve")
async def approve_healing_action(
    action_id: UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    action, project = _load_pending_action(db, action_id, current_user)
    failed = db.query(Deployment).filter(Deployment.id == action.deployment_id).first()
    if not failed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Original deployment is gone")

    user_id = util.canonical_user_id(db, current_user)
    try:
        if action.auto_applicable:
            retry = self_heal.apply_fix(db, action, project, failed)
        else:
            # Human says "I fixed the underlying cause — run it again".
            retry = self_heal._queue_retry_deployment(db, project, failed)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))

    action.status = HealingActionStatus.APPROVED
    action.result_deployment_id = retry.id
    action.resolved_at = utcnow()
    action.resolved_by_user_id = user_id
    audit_log.record_for_user(
        db, current_user,
        action="healing.approve",
        entity_type="deployment",
        entity_id=retry.id,
        org_id=project.org_id,
        request=request,
        extra={
            "project_id": str(project.id),
            "fix_kind": action.failure_kind,
            "failed_deployment_id": str(action.deployment_id),
        },
    )
    db.commit()
    db.refresh(retry)
    enqueue_build(str(retry.id), background_tasks)
    return {
        "applied": True,
        "fix_kind": action.failure_kind,
        "new_deployment_id": str(retry.id),
        "new_deployment_status": retry.status.value,
    }


@router.post("/actions/{action_id}/dismiss")
async def dismiss_healing_action(
    action_id: UUID,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    action, project = _load_pending_action(db, action_id, current_user)
    action.status = HealingActionStatus.DISMISSED
    action.resolved_at = utcnow()
    action.resolved_by_user_id = util.canonical_user_id(db, current_user)
    audit_log.record_for_user(
        db, current_user,
        action="healing.dismiss",
        entity_type="deployment",
        entity_id=action.deployment_id,
        org_id=project.org_id,
        request=request,
        extra={"project_id": str(project.id), "fix_kind": action.failure_kind},
    )
    db.commit()
    return {"dismissed": True, "id": str(action.id)}
