"""
Notification Webhooks API — manage Discord/Slack webhooks per project.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, HttpUrl
from sqlalchemy.orm import Session
from typing import List, Optional

from watchtower.database import NotificationWebhook, get_db, Project
from watchtower.api import util

router = APIRouter(prefix="/api/projects", tags=["Notifications"])
logger = logging.getLogger(__name__)


# ── Schemas ───────────────────────────────────────────────────────────────────

class WebhookCreate(BaseModel):
    url: str
    provider: str = "discord"   # "discord" | "slack"
    label: Optional[str] = None


class WebhookResponse(BaseModel):
    id: UUID
    project_id: Optional[UUID]
    provider: str
    label: Optional[str]
    url: str
    is_active: bool

    class Config:
        from_attributes = True


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_project_or_404(db: Session, project_id: UUID, user_id: UUID) -> Project:
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.owner_id == user_id,
    ).first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return project


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/webhooks", response_model=List[WebhookResponse])
async def list_webhooks(
    project_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    _get_project_or_404(db, project_id, util.canonical_user_id(db, current_user))
    hooks = db.query(NotificationWebhook).filter_by(project_id=project_id).all()
    return hooks


@router.post("/{project_id}/webhooks", response_model=WebhookResponse, status_code=status.HTTP_201_CREATED)
async def create_webhook(
    project_id: UUID,
    data: WebhookCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    _get_project_or_404(db, project_id, util.canonical_user_id(db, current_user))

    if data.provider not in ("discord", "slack"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="provider must be 'discord' or 'slack'")

    hook = NotificationWebhook(
        project_id=project_id,
        provider=data.provider,
        url=data.url,
        label=data.label,
    )
    db.add(hook)
    db.commit()
    db.refresh(hook)
    return hook


@router.delete("/{project_id}/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook(
    project_id: UUID,
    webhook_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    _get_project_or_404(db, project_id, util.canonical_user_id(db, current_user))
    hook = db.query(NotificationWebhook).filter_by(
        id=webhook_id, project_id=project_id
    ).first()
    if not hook:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Webhook not found")
    db.delete(hook)
    db.commit()
    return None
