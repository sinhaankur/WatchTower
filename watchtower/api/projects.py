"""
Projects API endpoints
"""

import logging
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from typing import List
from uuid import UUID

from watchtower.database import (
    get_db,
    Project,
    ProjectRelation,
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    Organization,
    User,
)
from watchtower import schemas
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower import builder as build_runner  # noqa: F401  (kept for sync wrapper imports elsewhere)
from watchtower.queue import enqueue_build

router = APIRouter(prefix="/api/projects", tags=["Projects"])
logger = logging.getLogger(__name__)


@router.get("", response_model=List[schemas.ProjectResponse])
async def list_projects(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List all projects for the current user"""
    user_id = UUID(str(current_user["user_id"]))
    projects = db.query(Project).filter(Project.owner_id == user_id).all()
    return projects


@router.post("", response_model=schemas.ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    request: Request,
    project_data: schemas.ProjectCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Create a new project"""
    try:
        # Use canonical org resolution to avoid org fragmentation.
        from watchtower.api.enterprise import _ensure_user_org_member
        user, org, _member = _ensure_user_org_member(db, current_user)
        user_id = user.id

        # Generate webhook secret
        webhook_secret = util.generate_webhook_secret()
        
        # Create project
        db_project = Project(
            name=project_data.name,
            use_case=project_data.use_case,
            deployment_model=project_data.deployment_model,
            source_type=project_data.source_type.value,
            local_folder_path=project_data.local_folder_path,
            launch_url=project_data.launch_url,
            repo_url=project_data.repo_url,
            repo_branch=project_data.repo_branch,
            webhook_secret=webhook_secret,
            org_id=org.id,
            owner_id=user_id
        )
        
        db.add(db_project)
        db.flush()  # so audit_log gets the assigned UUID
        audit_log.record_for_user(
            db, current_user,
            action="project.create",
            entity_type="project",
            entity_id=db_project.id,
            org_id=org.id,
            request=request,
            extra={"name": db_project.name, "repo_url": db_project.repo_url},
        )
        db.commit()
        db.refresh(db_project)

        return db_project

    except Exception:
        db.rollback()
        logger.exception("Project creation failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Project creation failed"
        )


@router.get("/{project_id}", response_model=schemas.ProjectResponse)
async def get_project(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Get project details"""
    user_id = UUID(str(current_user["user_id"]))
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id
    ).first()
    
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found"
        )
    
    return project


@router.put("/{project_id}", response_model=schemas.ProjectResponse)
async def update_project(
    request: Request,
    project_id: UUID,
    project_data: schemas.ProjectUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Update project settings"""
    user_id = UUID(str(current_user["user_id"]))
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id
    ).first()
    
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found"
        )
    
    changes: dict = {}
    if project_data.name and project_data.name != project.name:
        changes["name"] = {"from": project.name, "to": project_data.name}
        project.name = project_data.name
    if project_data.repo_branch and project_data.repo_branch != project.repo_branch:
        changes["repo_branch"] = {"from": project.repo_branch, "to": project_data.repo_branch}
        project.repo_branch = project_data.repo_branch
    if project_data.is_active is not None and project_data.is_active != project.is_active:
        changes["is_active"] = {"from": project.is_active, "to": project_data.is_active}
        project.is_active = project_data.is_active

    if changes:
        audit_log.record_for_user(
            db, current_user,
            action="project.update",
            entity_type="project",
            entity_id=project.id,
            org_id=project.org_id,
            request=request,
            extra={"changes": changes},
        )
    db.commit()
    db.refresh(project)

    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    request: Request,
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Delete project"""
    user_id = UUID(str(current_user["user_id"]))
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id
    ).first()
    
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found"
        )
    
    audit_log.record_for_user(
        db, current_user,
        action="project.delete",
        entity_type="project",
        entity_id=project.id,
        org_id=project.org_id,
        request=request,
        extra={"name": project.name, "repo_url": project.repo_url},
    )
    db.delete(project)
    db.commit()

    return None


def _load_owned_project(db: Session, project_id: UUID, current_user: dict) -> Project:
    """Resolve a project the current user can manage.

    Mirrors the dual-lookup pattern from deployments.py: try owner_id first,
    fall back to org membership so users whose user_id changed across token
    rotations can still reach their projects.
    """
    user_id = util.to_uuid(current_user["user_id"])
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id,
    ).first()
    if project:
        return project

    from watchtower.api.enterprise import _ensure_user_org_member  # local import to avoid cycle
    _user, canonical_org, _member = _ensure_user_org_member(db, current_user)
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.org_id == canonical_org.id,
    ).first()
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )
    return project


@router.get("/{project_id}/related", response_model=List[schemas.ProjectRelationResponse])
async def list_related_projects(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """List projects that should run alongside this one."""
    project = _load_owned_project(db, project_id, current_user)

    rows = (
        db.query(ProjectRelation)
        .filter(ProjectRelation.project_id == project.id)
        .order_by(ProjectRelation.order_index.asc(), ProjectRelation.created_at.asc())
        .all()
    )
    out: List[schemas.ProjectRelationResponse] = []
    for rel in rows:
        related = db.query(Project).filter(Project.id == rel.related_project_id).first()
        out.append(
            schemas.ProjectRelationResponse(
                id=rel.id,
                project_id=rel.project_id,
                related_project_id=rel.related_project_id,
                related_project_name=related.name if related else None,
                related_project_branch=related.repo_branch if related else None,
                order_index=rel.order_index,
                note=rel.note,
                created_at=rel.created_at,
            )
        )
    return out


@router.post(
    "/{project_id}/related",
    response_model=schemas.ProjectRelationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_related_project(
    project_id: UUID,
    payload: schemas.ProjectRelationCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Declare that ``related_project_id`` should run when this project runs."""
    project = _load_owned_project(db, project_id, current_user)

    if payload.related_project_id == project.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A project cannot be related to itself",
        )

    # Caller must also have access to the related project.
    related = _load_owned_project(db, payload.related_project_id, current_user)

    # Cross-org links are not supported — the deploy trigger relies on
    # canonical org membership, and surfacing relations across orgs would
    # leak project visibility.
    if related.org_id != project.org_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Related project must belong to the same organization",
        )

    relation = ProjectRelation(
        project_id=project.id,
        related_project_id=related.id,
        order_index=payload.order_index,
        note=payload.note,
    )
    db.add(relation)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Relation already exists",
        )
    db.refresh(relation)

    return schemas.ProjectRelationResponse(
        id=relation.id,
        project_id=relation.project_id,
        related_project_id=relation.related_project_id,
        related_project_name=related.name,
        related_project_branch=related.repo_branch,
        order_index=relation.order_index,
        note=relation.note,
        created_at=relation.created_at,
    )


@router.delete(
    "/{project_id}/related/{related_project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_related_project(
    project_id: UUID,
    related_project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Remove a related-project link."""
    project = _load_owned_project(db, project_id, current_user)

    relation = (
        db.query(ProjectRelation)
        .filter(
            ProjectRelation.project_id == project.id,
            ProjectRelation.related_project_id == related_project_id,
        )
        .first()
    )
    if not relation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Relation not found",
        )
    db.delete(relation)
    db.commit()
    return None


@router.post(
    "/{project_id}/run-with-related",
    response_model=schemas.RunWithRelatedResponse,
)
async def run_project_with_related(
    project_id: UUID,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Queue a deployment for this project AND every direct related project.

    Each project gets its own ``Deployment`` row using its own ``repo_branch``;
    builds run via background tasks the same way single-project deploys do.
    Order is determined by ``ProjectRelation.order_index`` (related first if
    they sort lower than the trigger; the trigger itself is queued last so
    dependencies start first).
    """
    project = _load_owned_project(db, project_id, current_user)

    relations = (
        db.query(ProjectRelation)
        .filter(ProjectRelation.project_id == project.id)
        .order_by(ProjectRelation.order_index.asc(), ProjectRelation.created_at.asc())
        .all()
    )

    # Build the queue: related projects first (in order), then the trigger
    # itself. Skip any related project that has been deleted or whose org no
    # longer matches (defence in depth — the relation row should already
    # block cross-org adds, but data drift is possible).
    queue: List[Project] = []
    skipped: List[schemas.RunWithRelatedResultItem] = []
    seen: set = {project.id}

    for rel in relations:
        related = db.query(Project).filter(Project.id == rel.related_project_id).first()
        if not related:
            skipped.append(
                schemas.RunWithRelatedResultItem(
                    project_id=rel.related_project_id,
                    project_name="(deleted)",
                    status="skipped",
                    detail="Related project no longer exists",
                )
            )
            continue
        if related.org_id != project.org_id:
            skipped.append(
                schemas.RunWithRelatedResultItem(
                    project_id=related.id,
                    project_name=related.name,
                    status="skipped",
                    detail="Related project moved to a different organization",
                )
            )
            continue
        if not related.is_active:
            skipped.append(
                schemas.RunWithRelatedResultItem(
                    project_id=related.id,
                    project_name=related.name,
                    status="skipped",
                    detail="Related project is inactive",
                )
            )
            continue
        if related.id in seen:
            continue
        seen.add(related.id)
        queue.append(related)

    queue.append(project)

    triggered: List[schemas.RunWithRelatedResultItem] = []
    for proj in queue:
        try:
            deployment = Deployment(
                project_id=proj.id,
                commit_sha="run-with-related",
                branch=proj.repo_branch,
                status=DeploymentStatus.PENDING,
                trigger=DeploymentTrigger.MANUAL,
            )
            db.add(deployment)
            db.commit()
            db.refresh(deployment)
            enqueue_build(str(deployment.id), background_tasks)
            triggered.append(
                schemas.RunWithRelatedResultItem(
                    project_id=proj.id,
                    project_name=proj.name,
                    deployment_id=deployment.id,
                    status="queued",
                )
            )
        except Exception as exc:  # noqa: BLE001 — surface per-project failure, keep going
            db.rollback()
            logger.exception("Failed to queue deployment for project %s", proj.id)
            triggered.append(
                schemas.RunWithRelatedResultItem(
                    project_id=proj.id,
                    project_name=proj.name,
                    status="error",
                    detail=str(exc) or "Failed to queue deployment",
                )
            )

    return schemas.RunWithRelatedResponse(
        triggered_count=sum(1 for r in triggered if r.status == "queued"),
        skipped_count=len(skipped) + sum(1 for r in triggered if r.status == "error"),
        results=triggered + skipped,
    )


@router.post("/{project_id}/rotate-webhook-secret")
async def rotate_webhook_secret(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Generate a fresh webhook secret for a project.

    Returns the new secret in the response body so the caller can paste it
    into GitHub's webhook config. After rotation, all old signed payloads
    will fail signature verification — the replay cache becomes irrelevant
    for that secret because the HMAC won't match.
    """
    user_id = UUID(str(current_user["user_id"]))
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id,
    ).first()
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )
    new_secret = util.generate_webhook_secret()
    project.webhook_secret = new_secret
    db.commit()
    logger.info("Webhook secret rotated for project %s", project_id)
    return {"webhook_secret": new_secret}
