"""
Deployments API endpoints
"""

import logging
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from sqlalchemy.orm import Session
from typing import List
from uuid import UUID
from datetime import datetime

from watchtower.database import (
    get_db,
    Project,
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    OrgNode,
    TeamMember,
    DeploymentNode,
    NodeStatus,
    Build,
)
from watchtower import schemas
from watchtower.api import util
from watchtower import builder as build_runner
from watchtower.api import audit as audit_log
from watchtower import failure_analyzer
from watchtower.queue import enqueue_build

router = APIRouter(prefix="/api/projects", tags=["Deployments"])
logger = logging.getLogger(__name__)


def _select_org_nodes_for_deploy(db: Session, project: Project, requested_node_ids: List[UUID]) -> List[OrgNode]:
    if requested_node_ids:
        selected = db.query(OrgNode).filter(
            OrgNode.org_id == project.org_id,
            OrgNode.id.in_(requested_node_ids),
            OrgNode.is_active == True,
        ).all()
        if len(selected) != len(requested_node_ids):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="One or more selected deployment nodes are invalid or inactive",
            )
        return selected

    healthy_primaries = db.query(OrgNode).filter(
        OrgNode.org_id == project.org_id,
        OrgNode.is_active == True,
        OrgNode.is_primary == True,
        OrgNode.status == NodeStatus.HEALTHY,
    ).all()
    if healthy_primaries:
        return healthy_primaries

    healthy_nodes = db.query(OrgNode).filter(
        OrgNode.org_id == project.org_id,
        OrgNode.is_active == True,
        OrgNode.status == NodeStatus.HEALTHY,
    ).order_by(OrgNode.updated_at.desc()).all()
    if healthy_nodes:
        return healthy_nodes[:1]

    fallback = db.query(OrgNode).filter(
        OrgNode.org_id == project.org_id,
        OrgNode.is_active == True,
    ).order_by(OrgNode.is_primary.desc(), OrgNode.updated_at.desc()).all()
    return fallback[:1]


@router.get("/{project_id}/deployments", response_model=List[schemas.DeploymentResponse])
async def list_deployments(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List deployments for a project"""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == util.canonical_user_id(db, current_user)
    ).first()
    
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found"
        )
    
    deployments = db.query(Deployment).filter(
        Deployment.project_id == project_id
    ).order_by(Deployment.created_at.desc()).all()
    
    return deployments


@router.post("/{project_id}/deployments", response_model=schemas.DeploymentResponse, status_code=status.HTTP_201_CREATED)
async def trigger_deployment(
    request: Request,
    project_id: UUID,
    deploy_data: schemas.DeploymentTriggerRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Manually trigger a deployment"""
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _user, canonical_org, canonical_member = _ensure_user_org_member(db, current_user)
        user_id = _user.id

        # Locate the project: first by ownership, then by org membership as fallback
        # for projects created under a prior user-id derived from a different token.
        project = db.query(Project).filter(
            Project.id == project_id,
            Project.owner_id == user_id,
        ).first()
        if not project:
            project = db.query(Project).filter(
                Project.id == project_id,
                Project.org_id == canonical_org.id,
            ).first()
        if not project:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

        # Use canonical member if project is in the canonical org; else look up separately.
        if project.org_id == canonical_org.id:
            member = canonical_member
        else:
            member = db.query(TeamMember).filter(
                TeamMember.org_id == project.org_id,
                TeamMember.user_id == user_id,
                TeamMember.is_active == True,
            ).first()

        if not member or not member.can_manage_deployments:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

        target_nodes = _select_org_nodes_for_deploy(db, project, deploy_data.node_ids or [])
        # For self-hosted / vercel-like projects we allow zero nodes: the
        # builder will run the build locally and store artifacts under the
        # local builds directory. Only block when the user explicitly asked
        # for specific nodes that don't exist, or when the deployment model
        # requires remote nodes.
        _model_val = getattr(project.deployment_model, "value", project.deployment_model)
        if not target_nodes and (deploy_data.node_ids or _model_val not in ("self_hosted", None)):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No active deployment nodes are available for this organization",
            )

        # Create deployment record
        deployment = Deployment(
            project_id=project_id,
            commit_sha=deploy_data.commit_sha or "manual-trigger",
            branch=deploy_data.branch,
            status=DeploymentStatus.PENDING,
            trigger=DeploymentTrigger.MANUAL
        )

        db.add(deployment)
        db.flush()

        for node in target_nodes:
            db.add(
                DeploymentNode(
                    deployment_id=deployment.id,
                    node_id=node.id,
                    status=DeploymentStatus.PENDING,
                )
            )

        audit_log.record_for_user(
            db, current_user,
            action="deployment.trigger",
            entity_type="deployment",
            entity_id=deployment.id,
            org_id=project.org_id,
            request=request,
            extra={
                "project_id": str(project.id),
                "branch": deploy_data.branch,
                "commit_sha": deployment.commit_sha,
                "node_ids": [str(n.id) for n in target_nodes],
            },
        )
        db.commit()
        db.refresh(deployment)

        enqueue_build(str(deployment.id), background_tasks)

        return deployment
    
    except FastAPIHTTPException:
        raise
    except Exception:
        db.rollback()
        logger.exception("Deployment trigger failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Deployment trigger failed"
        )


@router.get("/deployments/{deployment_id}", response_model=schemas.DeploymentResponse)
async def get_deployment(
    deployment_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Get deployment details"""
    deployment = db.query(Deployment).join(Project).filter(
        Deployment.id == deployment_id,
        Project.owner_id == util.canonical_user_id(db, current_user)
    ).first()
    
    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found"
        )
    
    return deployment


@router.get("/deployments/{deployment_id}/diagnose")
async def diagnose_deployment(
    deployment_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Classify a failed deployment's build/deploy log into a structured
    diagnosis with a suggested fix.

    The autonomous-ops loop's "diagnose" step. Pulls the most recent
    Build for the deployment, runs the log through
    :func:`watchtower.failure_analyzer.classify_failure`, and returns
    ``{kind, cause, fix, extracted}``. Cheap and synchronous — no LLM
    cost on the common patterns.

    Returns ``kind == "unknown"`` for failures that didn't match a known
    pattern. The SPA can then offer the LLM agent as a fallback for
    free-form analysis.

    Doesn't block on deployment status: even a successful (LIVE)
    deployment will get diagnosed if a caller asks, returning
    ``unknown`` if nothing in the log looks like a failure. That keeps
    the endpoint simple — no enum-state guard logic — and harmless on
    accidental calls.
    """
    deployment = db.query(Deployment).join(Project).filter(
        Deployment.id == deployment_id,
        Project.owner_id == util.canonical_user_id(db, current_user),
    ).first()

    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found",
        )

    # Last build for this deployment — that's where the actionable
    # error usually lives. Multiple builds can exist if a deployment
    # was retried; we only diagnose the most recent attempt.
    latest_build = (
        db.query(Build)
        .filter(Build.deployment_id == deployment.id)
        .order_by(Build.started_at.desc().nullslast())
        .first()
    )
    log_excerpt = (latest_build.build_output if latest_build else "") or ""

    # Cap to last 8 KB of log — patterns appear near the end (the failing
    # exception, the OOM kill notice). Cheaper regex pass than scanning
    # multi-megabyte logs verbatim, and matches what we'd send to the
    # LLM agent on fallback anyway.
    if len(log_excerpt) > 8 * 1024:
        log_excerpt = log_excerpt[-8 * 1024:]

    diagnosis = failure_analyzer.classify_failure(log_excerpt)
    payload = diagnosis.to_dict()
    payload["deployment_id"] = str(deployment.id)
    payload["deployment_status"] = deployment.status.value if deployment.status else None
    payload["build_id"] = str(latest_build.id) if latest_build else None
    return payload


@router.post("/deployments/{deployment_id}/auto-fix")
async def auto_fix_deployment(
    request: Request,
    deployment_id: UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Apply the suggested fix for a failed deployment, when safe.

    Closes the autonomous-ops loop's "fix" half: detect → diagnose →
    **fix** → verify. Re-classifies the latest build's log; if the
    failure kind is one of the safely-auto-applicable patterns
    (currently just PORT_IN_USE), it applies the fix and triggers a
    fresh deployment with the same branch/commit. The new deployment
    runs the verify step naturally.

    For PORT_IN_USE specifically: picks a free port from the project
    range (excluding the port that just failed), persists it as
    ``Project.recommended_port``, and queues a fresh deployment. The
    builder reads ``recommended_port`` at deploy time, so the new
    attempt binds to the new port without further user action.

    For other failure kinds the response is 400 with a clear message
    that this fix needs human intent (env var values, package install,
    free disk space) — the SPA shows the suggestion but doesn't
    pretend it can apply on its own.

    Returns the new deployment's id + status so the SPA can navigate
    the user to it ("we restarted with port 3001 — watching it now").
    """
    # Auth + project lookup match the diagnose endpoint, plus the same
    # canonical-org fallback used by trigger_deployment so deploys
    # created under a prior token still resolve. If the project's
    # missing or the user can't manage deploys on it, 404/403.
    from watchtower.api.enterprise import _ensure_user_org_member
    from watchtower.api.runtime import pick_free_port_for_user

    deployment = db.query(Deployment).filter(Deployment.id == deployment_id).first()
    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found",
        )

    _user, canonical_org, canonical_member = _ensure_user_org_member(db, current_user)
    project = db.query(Project).filter(Project.id == deployment.project_id).first()
    if not project or (
        project.owner_id != _user.id and project.org_id != canonical_org.id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found",
        )

    member = (
        canonical_member
        if project.org_id == canonical_org.id
        else db.query(TeamMember).filter(
            TeamMember.org_id == project.org_id,
            TeamMember.user_id == _user.id,
            TeamMember.is_active == True,  # noqa: E712
        ).first()
    )
    if not member or not member.can_manage_deployments:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Permission denied",
        )

    # Re-classify so the auto-fix path doesn't trust a stale diagnosis
    # from the SPA. Same 8 KB cap as the diagnose endpoint.
    latest_build = (
        db.query(Build)
        .filter(Build.deployment_id == deployment.id)
        .order_by(Build.started_at.desc().nullslast())
        .first()
    )
    log_excerpt = (latest_build.build_output if latest_build else "") or ""
    if len(log_excerpt) > 8 * 1024:
        log_excerpt = log_excerpt[-8 * 1024:]
    diagnosis = failure_analyzer.classify_failure(log_excerpt)

    if not diagnosis.fix.auto_applicable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"This failure ({diagnosis.kind.value}) needs human input "
                f"to fix — open the diagnose panel for the suggested next step."
            ),
        )

    if diagnosis.kind != failure_analyzer.FailureKind.PORT_IN_USE:
        # Defensive: the only auto_applicable=True kind right now is
        # PORT_IN_USE. If a future pattern flips the flag, we want
        # explicit dispatch here rather than a generic "retry as-is"
        # that might do the wrong thing.
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=f"Auto-fix for {diagnosis.kind.value} isn't wired yet.",
        )

    # PORT_IN_USE branch: bump the project's port and redeploy.
    failed_port = None
    extracted_port = diagnosis.extracted.get("port") if diagnosis.extracted else None
    if extracted_port:
        try:
            failed_port = int(extracted_port)
        except (TypeError, ValueError):
            failed_port = None

    excluded_ports = {failed_port} if failed_port else set()
    new_port = pick_free_port_for_user(db, _user.id, excluded=excluded_ports)
    if new_port is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "No free port available in the project range. Free up some "
                "ports on the deploy target and try again."
            ),
        )

    project.recommended_port = new_port

    # Queue a fresh deployment using the same branch/commit as the
    # failed one. Re-uses trigger_deployment's data shape so the
    # builder pipeline can't tell the difference between a manual
    # retry and an auto-fix retry. Audit log distinguishes them via
    # the action and extra metadata.
    new_deployment = Deployment(
        project_id=project.id,
        commit_sha=deployment.commit_sha,
        branch=deployment.branch or "main",
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.MANUAL,
    )
    db.add(new_deployment)
    db.flush()

    # Mirror the per-node DeploymentNode fan-out from trigger_deployment
    # so the new deploy targets the same set of nodes (or none, for
    # local-only).
    target_nodes = _select_org_nodes_for_deploy(db, project, [])
    for node in target_nodes:
        db.add(
            DeploymentNode(
                deployment_id=new_deployment.id,
                node_id=node.id,
                status=DeploymentStatus.PENDING,
            )
        )

    audit_log.record_for_user(
        db, current_user,
        action="deployment.auto_fix",
        entity_type="deployment",
        entity_id=new_deployment.id,
        org_id=project.org_id,
        request=request,
        extra={
            "project_id": str(project.id),
            "fix_kind": diagnosis.kind.value,
            "failed_deployment_id": str(deployment.id),
            "failed_port": failed_port,
            "new_port": new_port,
        },
    )
    db.commit()
    db.refresh(new_deployment)

    enqueue_build(str(new_deployment.id), background_tasks)

    return {
        "applied": True,
        "fix_kind": diagnosis.kind.value,
        "new_deployment_id": str(new_deployment.id),
        "new_deployment_status": new_deployment.status.value,
        "details": {"failed_port": failed_port, "new_port": new_port},
    }


@router.post("/deployments/{deployment_id}/rollback", response_model=schemas.DeploymentResponse)
async def rollback_deployment(
    request: Request,
    deployment_id: UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Rollback to previous deployment"""
    deployment = db.query(Deployment).join(Project).filter(
        Deployment.id == deployment_id,
        Project.owner_id == util.canonical_user_id(db, current_user)
    ).first()
    
    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found"
        )
    
    if deployment.status != DeploymentStatus.LIVE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can only rollback from live deployments"
        )
    
    # Get previous successful deployment
    prev_deployment = db.query(Deployment).filter(
        Deployment.project_id == deployment.project_id,
        Deployment.status == DeploymentStatus.LIVE,
        Deployment.created_at < deployment.created_at
    ).order_by(Deployment.created_at.desc()).first()
    
    if not prev_deployment:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No previous deployment to rollback to"
        )
    
    # Create new deployment from previous one
    rollback = Deployment(
        project_id=deployment.project_id,
        commit_sha=prev_deployment.commit_sha,
        commit_message=prev_deployment.commit_message,
        branch=prev_deployment.branch,
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.MANUAL
    )
    
    db.add(rollback)
    deployment.status = DeploymentStatus.ROLLED_BACK
    db.flush()
    audit_log.record_for_user(
        db, current_user,
        action="deployment.rollback",
        entity_type="deployment",
        entity_id=rollback.id,
        org_id=deployment.project.org_id,
        request=request,
        extra={
            "rolled_back_from": str(deployment.id),
            "to_commit_sha": rollback.commit_sha,
        },
    )
    db.commit()
    db.refresh(rollback)

    # Route through the queue so rollback builds get the same durable
    # scheduling (or in-process fallback) as forward deploys.
    enqueue_build(str(rollback.id), background_tasks)

    return rollback


@router.get("/{project_id}/deployment-targets")
async def list_deployment_targets(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List recommended deployment nodes for project-triggered deployments."""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == util.canonical_user_id(db, current_user),
    ).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    nodes = db.query(OrgNode).filter(
        OrgNode.org_id == project.org_id,
        OrgNode.is_active == True,
    ).order_by(OrgNode.is_primary.desc(), OrgNode.updated_at.desc()).all()
    recommended = _select_org_nodes_for_deploy(db, project, [])
    recommended_ids = {str(node.id) for node in recommended}

    return {
        "project_id": str(project.id),
        "recommended_node_ids": list(recommended_ids),
        "nodes": [
            {
                "id": str(node.id),
                "name": node.name,
                "host": node.host,
                "status": node.status.value if hasattr(node.status, "value") else str(node.status),
                "is_primary": node.is_primary,
                "cpu_usage": node.cpu_usage,
                "memory_usage": node.memory_usage,
                "disk_usage": node.disk_usage,
                "last_health_check": node.last_health_check,
                "recommended": str(node.id) in recommended_ids,
            }
            for node in nodes
        ],
    }
