"""
Builds API endpoints — REST + WebSocket for live log streaming.
"""

import asyncio
from fastapi import APIRouter, Depends, HTTPException, status, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from typing import List
from uuid import UUID

from watchtower.database import get_db, Build, BuildStatus, Deployment, Project
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
        Project.owner_id == UUID(str(current_user["user_id"]))
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
        Project.owner_id == UUID(str(current_user["user_id"]))
    ).first()
    
    if not build:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Build not found"
        )
    
    return build


@router.websocket("/ws/builds/{build_id}/logs")
async def stream_build_logs(
    websocket: WebSocket,
    build_id: UUID,
    db: Session = Depends(get_db),
):
    """
    Stream live build logs for a running build.
    Sends newline-delimited log text in real time.
    Closes with code 1000 once the build finishes or fails.
    """
    await websocket.accept()

    # Validate build exists (no auth token in WS — rely on same-origin cookie / token param)
    build = db.query(Build).filter(Build.id == build_id).first()
    if not build:
        await websocket.send_text("[WatchTower] Build not found.\n")
        await websocket.close(code=1008)
        return

    sent_chars = 0
    try:
        while True:
            db.expire(build)   # re-read from DB
            build = db.query(Build).filter(Build.id == build_id).first()
            if not build:
                break

            output: str = build.build_output or ""
            if len(output) > sent_chars:
                chunk = output[sent_chars:]
                await websocket.send_text(chunk)
                sent_chars = len(output)

            if build.status in (BuildStatus.SUCCESS, BuildStatus.FAILED):
                # Send any remaining output, then close
                await asyncio.sleep(0.3)
                db.expire(build)
                build = db.query(Build).filter(Build.id == build_id).first()
                final_output: str = build.build_output or "" if build else ""
                if len(final_output) > sent_chars:
                    await websocket.send_text(final_output[sent_chars:])
                await websocket.close(code=1000)
                return

            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass

