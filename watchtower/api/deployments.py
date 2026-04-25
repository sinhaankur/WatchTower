"""
Deployments API endpoints
"""

import logging
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
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
)
from watchtower import schemas
from watchtower.api import util
from watchtower import builder as build_runner

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
        Project.owner_id == current_user["user_id"]
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
        if not target_nodes:
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

        db.commit()
        db.refresh(deployment)

        background_tasks.add_task(build_runner.run_build_async, str(deployment.id))

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
        Project.owner_id == UUID(str(current_user["user_id"]))
    ).first()
    
    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found"
        )
    
    return deployment


@router.post("/deployments/{deployment_id}/rollback", response_model=schemas.DeploymentResponse)
async def rollback_deployment(
    deployment_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Rollback to previous deployment"""
    deployment = db.query(Deployment).join(Project).filter(
        Deployment.id == deployment_id,
        Project.owner_id == UUID(str(current_user["user_id"]))
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
    db.commit()
    db.refresh(rollback)

    # Schedule the rollback build asynchronously
    import asyncio
    asyncio.ensure_future(build_runner.run_build_async(str(rollback.id)))

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
        Project.owner_id == UUID(str(current_user["user_id"])),
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
