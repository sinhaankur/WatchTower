"""
Projects API endpoints
"""

import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from uuid import UUID

from watchtower.database import get_db, Project, Organization, User
from watchtower import schemas
from watchtower.api import util

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
    project_data: schemas.ProjectCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Create a new project"""
    try:
        user_id = UUID(str(current_user["user_id"]))
        # Get or create default organization for user
        org = db.query(Organization).filter(
            Organization.owner_id == user_id
        ).first()
        
        if not org:
            # Create default organization
            user = db.query(User).filter(User.id == user_id).first()
            org = Organization(
                name=f"{user.name}'s Organization" if user else "Default Organization",
                owner_id=user_id
            )
            db.add(org)
            db.flush()
        
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
    
    # Update fields
    if project_data.name:
        project.name = project_data.name
    if project_data.repo_branch:
        project.repo_branch = project_data.repo_branch
    if project_data.is_active is not None:
        project.is_active = project_data.is_active
    
    db.commit()
    db.refresh(project)
    
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
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
    
    db.delete(project)
    db.commit()
    
    return None
