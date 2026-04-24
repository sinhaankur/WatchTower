"""
Builds API endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status, WebSocket
from sqlalchemy.orm import Session
from typing import List
from uuid import UUID

from watchtower.database import get_db, Build, Deployment, Project
from watchtower import schemas
from watchtower.api import util

router = APIRouter(prefix="/api", tags=["Builds"])


@router.get("/deployments/{deployment_id}/builds", response_model=List[schemas.BuildResponse])
async def list_builds(
    deployment_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List builds for a deployment"""
    deployment = db.query(Deployment).join(Project).filter(
        Deployment.id == deployment_id,
        Project.owner_id == current_user["user_id"]
    ).first()
    
    if not deployment:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Deployment not found"
        )
    
    builds = db.query(Build).filter(Build.deployment_id == deployment_id).all()
    
    return builds


@router.get("/builds/{build_id}", response_model=schemas.BuildResponse)
async def get_build(
    build_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Get build details"""
    build = db.query(Build).join(Deployment).join(Project).filter(
        Build.id == build_id,
        Project.owner_id == current_user["user_id"]
    ).first()
    
    if not build:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Build not found"
        )
    
    return build


# TODO: Implement WebSocket for real-time build logs
# @router.websocket("/ws/builds/{build_id}/logs")
# async def stream_build_logs(websocket: WebSocket, build_id: UUID):
#     await websocket.accept()
#     try:
#         while True:
#             # Stream build logs from container
#             pass
#     except Exception as e:
#         await websocket.close(code=1000)
