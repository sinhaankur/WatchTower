"""
Deployments API endpoints
"""
from watchtower.api.util import utcnow

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
    User,
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

    return _serialize_deployments(db, deployments)


def _serialize_deployments(db: Session, deployments: List[Deployment]) -> List[schemas.DeploymentResponse]:
    """Attach the triggering user's email/name to each deployment.

    Resolved in a single batched lookup keyed by user-id so a list of N
    deployments costs one extra query, not N. Deployments with no
    triggering user (webhook / scheduled / self-heal) get nulls.
    """
    user_ids = {d.triggered_by_user_id for d in deployments if d.triggered_by_user_id}
    users_by_id: dict = {}
    if user_ids:
        rows = db.query(User.id, User.email, User.name).filter(User.id.in_(user_ids)).all()
        users_by_id = {r.id: (r.email, r.name) for r in rows}

    out: List[schemas.DeploymentResponse] = []
    for d in deployments:
        resp = schemas.DeploymentResponse.model_validate(d)
        email, name = users_by_id.get(d.triggered_by_user_id, (None, None))
        resp.triggered_by_email = email
        resp.triggered_by_name = name
        out.append(resp)
    return out


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
            trigger=DeploymentTrigger.MANUAL,
            triggered_by_user_id=user_id,
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


@router.get("/deployments/{deployment_id}/detail", response_model=schemas.DeploymentDetailResponse)
async def get_deployment_detail(
    deployment_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Full detail for the deployment detail page in one call.

    Bundles the deployment (with triggered-by resolved), its build
    history, and per-node deploy status (node name resolved). Owner-scoped
    exactly like get_deployment.
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

    # Reuse the batched triggered-by resolver so this row matches the list.
    dep_resp = _serialize_deployments(db, [deployment])[0]

    builds = (
        db.query(Build)
        .filter(Build.deployment_id == deployment.id)
        .order_by(Build.started_at.desc().nullslast())
        .all()
    )

    # Per-node status, with node names resolved in one join.
    node_rows = (
        db.query(DeploymentNode, OrgNode.name, OrgNode.host)
        .outerjoin(OrgNode, OrgNode.id == DeploymentNode.node_id)
        .filter(DeploymentNode.deployment_id == deployment.id)
        .all()
    )
    nodes = [
        schemas.DeploymentNodeStatus(
            node_id=dn.node_id,
            node_name=name,
            node_host=host,
            status=dn.status,
            deployed_at=dn.deployed_at,
        )
        for dn, name, host in node_rows
    ]

    return schemas.DeploymentDetailResponse(
        deployment=dep_resp,
        builds=[schemas.BuildResponse.model_validate(b) for b in builds],
        nodes=nodes,
    )


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

    # LLM fallback escape hatch for UNKNOWN diagnoses. The regex
    # library doesn't cover everything; when it misses, the SPA can
    # launch the agent with this pre-filled prompt to get a
    # free-form analysis. We don't invoke the agent here — keeping
    # the diagnose endpoint synchronous + cheap is the point. Just
    # hand the SPA enough context to wire the handoff.
    if diagnosis.kind == failure_analyzer.FailureKind.UNKNOWN and log_excerpt:
        payload["agent_prompt"] = (
            "I'm investigating a failed WatchTower deployment that doesn't "
            "match any known failure pattern. Read the build log below and "
            "tell me the most likely root cause + a concrete fix.\n\n"
            f"Build log (last {len(log_excerpt)} chars):\n```\n{log_excerpt}\n```"
        )
        # Path the SPA deep-links to: the AI & Autonomy card in Settings,
        # where the LLM connection and the self-heal intervention queue
        # (which auto-analyzes UNKNOWN failures) both live.
        payload["agent_route"] = "/settings"

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

    # ── Idempotency + thrash guardrails ────────────────────────────────────
    # Without these, a user who double-clicks Apply Fix queues two
    # retry deploys, and a misbehaving tool (or a project that flaps
    # back to the same failure) could spin up dozens of retries
    # without anyone noticing. Both windows are derived from the
    # audit log so we don't need new schema or a separate table.
    #
    # 60s idempotency window — protects against double-clicks /
    # network retries inside the SPA. Refuse with a clear message.
    # 10-min, 3-attempt thrash guardrail — protects against a true
    # auto-fix loop where the suggested fix doesn't actually fix the
    # underlying problem. After 3 attempts in 10 minutes we make the
    # human take over.
    from datetime import timedelta

    project_id_str = str(project.id)
    now = utcnow()
    recent_audit_rows = (
        db.query(audit_log.AuditEvent)
        .filter(
            audit_log.AuditEvent.action == "deployment.auto_fix",
            audit_log.AuditEvent.org_id == project.org_id,
            audit_log.AuditEvent.created_at >= now - timedelta(minutes=10),
        )
        .all()
    )
    # Match by project_id embedded in extra_json — cheap string check
    # since project IDs are UUID4 (no false-positive collision risk).
    project_recent = [
        row for row in recent_audit_rows
        if row.extra_json and project_id_str in row.extra_json
    ]
    very_recent = [
        row for row in project_recent
        if row.created_at >= now - timedelta(seconds=60)
    ]
    if very_recent:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "An auto-fix retry was already queued for this project in "
                "the last 60 seconds. Wait for it to finish before applying "
                "another fix."
            ),
        )
    if len(project_recent) >= 3:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"This project has already been auto-fixed {len(project_recent)} "
                f"times in the last 10 minutes. The suggested fix isn't "
                f"sticking — investigate manually before retrying."
            ),
        )

    # ── REGISTRY_TRANSIENT branch: just re-deploy as-is ────────────────────
    # Registry flakes (npm 5xx, pip read-timeout, etc) almost always
    # clear on retry with no changes. We use the same redeploy path
    # as PORT_IN_USE but skip the port-change step.
    if diagnosis.kind == failure_analyzer.FailureKind.REGISTRY_TRANSIENT:
        new_deployment = Deployment(
            project_id=project.id,
            commit_sha=deployment.commit_sha,
            branch=deployment.branch or "main",
            status=DeploymentStatus.PENDING,
            trigger=DeploymentTrigger.MANUAL,
            triggered_by_user_id=_user.id,
        )
        db.add(new_deployment)
        db.flush()

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
            "details": {
                "retry_strategy": "registry_transient — re-running build with no changes",
            },
        }

    if diagnosis.kind != failure_analyzer.FailureKind.PORT_IN_USE:
        # Defensive: PORT_IN_USE and REGISTRY_TRANSIENT are the only
        # auto_applicable=True kinds wired. If a future pattern flips
        # the flag, we want explicit dispatch here rather than a
        # generic "retry as-is" that might do the wrong thing.
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
        triggered_by_user_id=_user.id,
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
        trigger=DeploymentTrigger.MANUAL,
        triggered_by_user_id=util.canonical_user_id(db, current_user),
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


@router.post("/{project_id}/go-live", response_model=schemas.GoLiveResponse)
async def go_live(
    project_id: UUID,
    body: schemas.GoLiveRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Take a project from deployed → globally reachable + autonomous.

    Orchestrates steps that already exist individually, returning a
    per-step checklist so the UI can show exactly how far it got and
    what (if anything) still needs a human:

      container   — ensure the project deploys as a Podman container
      deploy      — queue a fresh deployment so the container is current
      domain      — ensure a CustomDomain row for the requested hostname
      public      — DNS mode: create/update a Cloudflare A record to the
                    primary node's host. Tunnel mode: return guided setup
                    steps (server-side tunnel automation isn't built yet,
                    so we don't pretend it is).
      autonomous  — flip autonomous_mode on so the probe loop watches it

    Each step is best-effort and recorded; a failure in one doesn't abort
    the rest where it's safe to continue, so the user sees the full picture.
    """
    from watchtower.api.enterprise import _ensure_user_org_member
    from watchtower.database import CustomDomain, CloudflareCredential
    from watchtower import cloudflare_dns

    _user, canonical_org, canonical_member = _ensure_user_org_member(db, current_user)

    project = db.query(Project).filter(
        Project.id == project_id, Project.owner_id == _user.id,
    ).first()
    if not project:
        project = db.query(Project).filter(
            Project.id == project_id, Project.org_id == canonical_org.id,
        ).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if project.org_id == canonical_org.id:
        member = canonical_member
    else:
        member = db.query(TeamMember).filter(
            TeamMember.org_id == project.org_id,
            TeamMember.user_id == _user.id,
            TeamMember.is_active == True,  # noqa: E712
        ).first()
    if not member or not member.can_manage_deployments:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    hostname = body.hostname.strip().lower()
    steps: list[schemas.GoLiveStepResult] = []

    def add(step: str, title: str, status_: str, detail: str | None = None,
            instructions: list[str] | None = None) -> None:
        steps.append(schemas.GoLiveStepResult(
            step=step, title=title, status=status_, detail=detail, instructions=instructions,
        ))

    # ── 1. container mode ─────────────────────────────────────────────────
    if project.run_as_container:
        add("container", "Run as container", "skipped", "Already enabled.")
    else:
        project.run_as_container = True
        add("container", "Run as container", "ok", "Enabled — the app will deploy as a Podman container.")

    # ── 2. queue a fresh deployment ───────────────────────────────────────
    new_deployment = Deployment(
        project_id=project.id,
        commit_sha="go-live",
        branch=project.repo_branch or "main",
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.MANUAL,
        triggered_by_user_id=_user.id,
    )
    db.add(new_deployment)
    db.flush()
    for node in _select_org_nodes_for_deploy(db, project, []):
        db.add(DeploymentNode(
            deployment_id=new_deployment.id, node_id=node.id, status=DeploymentStatus.PENDING,
        ))
    add("deploy", "Deploy latest", "ok", f"Queued deployment {str(new_deployment.id)[:8]}.")

    # ── 3. ensure the custom domain ───────────────────────────────────────
    domain = db.query(CustomDomain).filter(
        CustomDomain.project_id == project.id,
        CustomDomain.domain == hostname,
    ).first()
    if domain:
        add("domain", "Custom domain", "skipped", f"{hostname} already attached.")
    else:
        # First domain on a project becomes primary.
        has_primary = db.query(CustomDomain).filter(
            CustomDomain.project_id == project.id,
            CustomDomain.is_primary == True,  # noqa: E712
        ).first() is not None
        domain = CustomDomain(
            project_id=project.id, domain=hostname, is_primary=not has_primary,
        )
        db.add(domain)
        db.flush()
        add("domain", "Custom domain", "ok", f"Attached {hostname}.")

    # ── 4. make it publicly reachable ─────────────────────────────────────
    overall_blocked = False

    def _tunnel_manual_fallback(reason: str) -> None:
        """When auto-tunnel can't run, hand back the exact manual steps so
        the user can finish by hand — the rest of go-live still applied."""
        add(
            "public", "Public access (Cloudflare Tunnel)", "manual",
            f"{reason} Run these on the deploy host to finish:",
            instructions=[
                "curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
                "cloudflared tunnel login",
                f"cloudflared tunnel create {project.name}",
                f"cloudflared tunnel route dns {project.name} {hostname}",
                f"cloudflared tunnel run --url http://localhost:{project.recommended_port or 8080} {project.name}",
            ],
        )

    if body.public_mode == "tunnel":
        # One-click remotely-managed tunnel: create it via the CF API, route
        # the hostname through it (CNAME → <id>.cfargotunnel.com), and install
        # the connector as a systemd service on the primary node. Each missing
        # prerequisite degrades to the guided manual steps rather than failing.
        cred = None
        if body.cloudflare_credential_id:
            cred = db.query(CloudflareCredential).filter(
                CloudflareCredential.id == body.cloudflare_credential_id,
                CloudflareCredential.org_id == project.org_id,
            ).first()
        primary_node = db.query(OrgNode).filter(
            OrgNode.org_id == project.org_id,
            OrgNode.is_active == True,  # noqa: E712
        ).order_by(OrgNode.is_primary.desc(), OrgNode.updated_at.desc()).first()

        token = util.decrypt_secret(cred.api_token_encrypted) if cred else None
        port = project.recommended_port or 8080

        if not cred or not token:
            _tunnel_manual_fallback("No usable Cloudflare credential for automatic tunnel setup.")
        elif not cred.account_id:
            _tunnel_manual_fallback("The Cloudflare credential has no account id (re-verify it under Integrations).")
        elif not primary_node:
            _tunnel_manual_fallback("No active node to run the tunnel connector on.")
        else:
            try:
                tunnel = cloudflare_dns.create_tunnel(token, cred.account_id, f"wt-{project.name}")
                cloudflare_dns.configure_tunnel_ingress(
                    token, cred.account_id, tunnel.tunnel_id, hostname, f"http://localhost:{port}",
                )
                cname_target = f"{tunnel.tunnel_id}.cfargotunnel.com"
                result = cloudflare_dns.sync_cname(
                    token, hostname, cname_target,
                    existing_zone_id=domain.cloudflare_zone_id,
                    existing_record_id=domain.cloudflare_record_id,
                )
                domain.cloudflare_credential_id = cred.id
                domain.cloudflare_zone_id = result.zone_id
                domain.cloudflare_record_id = result.record_id
                domain.cloudflare_target_ip = cname_target
                domain.cloudflare_tunnel_id = tunnel.tunnel_id
                domain.cloudflare_synced_at = utcnow()

                # Install the connector on the node (best-effort over SSH).
                logs: list[str] = []
                ok, err = await build_runner.install_cloudflared_tunnel_on_node(
                    primary_node, tunnel.token, logs.append,
                )
                if ok:
                    add("public", "Public access (Cloudflare Tunnel)", "ok",
                        f"Tunnel '{tunnel.name}' live → {hostname} (connector on {primary_node.name}).")
                else:
                    # CF side is set up; only the node connector failed. Give
                    # the one command to finish, not the whole sequence.
                    add("public", "Public access (Cloudflare Tunnel)", "manual",
                        f"Tunnel created and DNS routed, but installing the connector on "
                        f"{primary_node.name} failed: {err[:200]} — run on that host:",
                        instructions=[f"sudo cloudflared service install <token-from-Cloudflare-dashboard>"])
            except cloudflare_dns.CloudflareDnsError as exc:
                _tunnel_manual_fallback(f"Cloudflare tunnel API error: {exc.detail}")
    elif body.public_mode == "dns":
        primary_node = db.query(OrgNode).filter(
            OrgNode.org_id == project.org_id,
            OrgNode.is_active == True,  # noqa: E712
        ).order_by(OrgNode.is_primary.desc(), OrgNode.updated_at.desc()).first()
        cred = None
        if body.cloudflare_credential_id:
            cred = db.query(CloudflareCredential).filter(
                CloudflareCredential.id == body.cloudflare_credential_id,
                CloudflareCredential.org_id == project.org_id,
            ).first()

        if not primary_node or not primary_node.host:
            add("public", "Public access (Cloudflare DNS)", "failed",
                "No active node with a public host to point DNS at. Add or provision a node first.")
            overall_blocked = True
        elif not cred:
            add("public", "Public access (Cloudflare DNS)", "failed",
                "No Cloudflare credential selected/found for this org.")
            overall_blocked = True
        else:
            token = util.decrypt_secret(cred.api_token_encrypted)
            if not token:
                add("public", "Public access (Cloudflare DNS)", "failed",
                    "Could not decrypt the Cloudflare token (WATCHTOWER_SECRET_KEY may have changed).")
                overall_blocked = True
            else:
                try:
                    result = cloudflare_dns.sync_a_record(
                        token, hostname, primary_node.host,
                        existing_zone_id=domain.cloudflare_zone_id,
                        existing_record_id=domain.cloudflare_record_id,
                        proxied=body.proxied,
                    )
                    domain.cloudflare_credential_id = cred.id
                    domain.cloudflare_zone_id = result.zone_id
                    domain.cloudflare_record_id = result.record_id
                    domain.cloudflare_target_ip = result.target_ip
                    domain.cloudflare_synced_at = utcnow()
                    add("public", "Public access (Cloudflare DNS)", "ok",
                        f"{hostname} → {result.target_ip} ({'proxied' if body.proxied else 'DNS-only'}).")
                except cloudflare_dns.CloudflareDnsError as exc:
                    add("public", "Public access (Cloudflare DNS)", "failed", exc.detail)
                    overall_blocked = True

    # ── 5. autonomous mode ────────────────────────────────────────────────
    if body.enable_autonomous:
        if project.autonomous_mode:
            add("autonomous", "Autonomous monitoring", "skipped", "Already on.")
        else:
            project.autonomous_mode = True
            add("autonomous", "Autonomous monitoring", "ok",
                "Enabled — WatchTower will probe, restart, and roll back automatically.")
    else:
        add("autonomous", "Autonomous monitoring", "skipped", "Left off per request.")

    # Record the public URL on the project for convenience.
    live_url = f"https://{hostname}"
    project.live_url = live_url

    audit_log.record_for_user(
        db, current_user,
        action="project.go_live",
        entity_type="project",
        entity_id=project.id,
        org_id=project.org_id,
        request=request,
        extra={"hostname": hostname, "public_mode": body.public_mode,
               "autonomous": body.enable_autonomous},
    )
    db.commit()
    db.refresh(new_deployment)
    enqueue_build(str(new_deployment.id), background_tasks)

    # Overall verdict from the step statuses.
    statuses = {s.status for s in steps}
    if "failed" in statuses:
        overall = "failed" if overall_blocked else "partial"
    elif "manual" in statuses:
        overall = "manual"
    else:
        overall = "live"

    return schemas.GoLiveResponse(
        project_id=project.id,
        hostname=hostname,
        overall=overall,
        live_url=live_url,
        steps=steps,
    )
