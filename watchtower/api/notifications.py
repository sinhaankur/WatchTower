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
    provider: str = "discord"   # "discord" | "slack" | "ntfy"
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

    if data.provider not in ("discord", "slack", "ntfy"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="provider must be 'discord', 'slack', or 'ntfy'")

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


class WebhookTestRequest(BaseModel):
    provider: str  # "slack" | "discord"
    url: HttpUrl
    label: Optional[str] = None


class WebhookTestResponse(BaseModel):
    ok: bool
    status_code: Optional[int] = None
    detail: Optional[str] = None


@router.post("/{project_id}/webhooks/test", response_model=WebhookTestResponse)
async def test_webhook(
    project_id: UUID,
    body: WebhookTestRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Send a synthetic 'this is a test from WatchTower' message to the
    given webhook URL, then report what happened. Lets users verify a
    Slack/Discord webhook URL is correct *before* committing it to a
    project — the alternative is configuring it, triggering a real
    deploy, and waiting to see if a notification shows up.

    The webhook itself isn't saved by this call. Side-effect free
    against the WatchTower DB; only side-effect is the test message
    delivered to the third-party endpoint.
    """
    import json as _json
    import urllib.request
    import urllib.error
    import re

    project = _get_project_or_404(db, project_id, util.canonical_user_id(db, current_user))

    provider = (body.provider or "").lower().strip()
    if provider not in {"slack", "discord", "ntfy"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="provider must be 'slack', 'discord', or 'ntfy'",
        )

    url_str = str(body.url)
    # Cheap shape check so users get a clearer error than the upstream's
    # 404 / 401 when they paste the wrong thing entirely.
    if provider == "slack" and not re.match(r"^https://hooks\.slack\.com/services/", url_str):
        return WebhookTestResponse(
            ok=False,
            detail=(
                "Slack webhook URLs start with `https://hooks.slack.com/services/...`. "
                "The URL you pasted doesn't match — double-check you copied the full "
                "Webhook URL from your Slack app's Incoming Webhooks page."
            ),
        )
    if provider == "discord" and "discord.com/api/webhooks" not in url_str:
        return WebhookTestResponse(
            ok=False,
            detail=(
                "Discord webhook URLs contain `discord.com/api/webhooks`. "
                "Copy the full URL from Channel Settings → Integrations → Webhooks."
            ),
        )
    if provider == "ntfy" and not re.match(r"^https?://", url_str):
        return WebhookTestResponse(
            ok=False,
            detail=(
                "ntfy topic URLs look like `https://ntfy.sh/your-topic` (or "
                "`https://ntfy.your-domain.com/your-topic` if you self-host). "
                "Paste the full topic URL, including the topic name at the end."
            ),
        )

    label = body.label or "test"
    text = (
        f"🦉 Test message from WatchTower\n"
        f"Project: {project.name}  ·  Webhook label: {label}\n"
        f"If you see this, the webhook is wired up correctly."
    )
    # ntfy speaks plain text with a Title header; slack/discord speak JSON.
    if provider == "ntfy":
        req = urllib.request.Request(
            url_str,
            data=text.encode("utf-8"),
            headers={
                "Content-Type": "text/plain; charset=utf-8",
                "Title": "WatchTower test",
            },
            method="POST",
        )
    else:
        payload = (
            {"text": text} if provider == "slack" else {"content": text}
        )
        data = _json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url_str,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return WebhookTestResponse(ok=True, status_code=resp.status)
    except urllib.error.HTTPError as e:
        body_snippet = ""
        try:
            body_snippet = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            pass
        return WebhookTestResponse(
            ok=False,
            status_code=e.code,
            detail=f"{provider.capitalize()} responded {e.code}: {body_snippet or e.reason}",
        )
    except urllib.error.URLError as e:
        return WebhookTestResponse(
            ok=False,
            detail=f"Could not reach {provider}: {e.reason}",
        )
    except Exception as e:
        return WebhookTestResponse(
            ok=False,
            detail=f"Unexpected error: {e}",
        )


# ── Org-scoped webhooks ───────────────────────────────────────────────────────
#
# Installation-wide notifications (not tied to a single project) — e.g.
# control-plane pair/unpair/failover via notifier.notify_org. These hooks have
# project_id NULL and an org_id, and only an org admin (can_manage_team) can
# manage them since they're an installation-level concern.

org_webhook_router = APIRouter(prefix="/api/org-webhooks", tags=["Notifications"])


def _validate_webhook_shape(provider: str, url: str) -> str:
    """Validate provider + a cheap URL shape check. Returns the normalised
    provider, raises 422 on bad input (clearer than the upstream's 404/401)."""
    p = (provider or "").lower().strip()
    if p not in {"slack", "discord", "ntfy"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="provider must be 'slack', 'discord', or 'ntfy'")
    if p == "slack" and not url.startswith("https://hooks.slack.com/services/"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Slack webhook URLs start with https://hooks.slack.com/services/...")
    if p == "discord" and "discord.com/api/webhooks" not in url:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Discord webhook URLs contain discord.com/api/webhooks")
    if p == "ntfy" and not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="ntfy topic URLs look like https://ntfy.sh/your-topic")
    return p


def _require_org_admin(db: Session, current_user: dict):
    """Resolve the caller's org and require can_manage_team. Returns the org."""
    from watchtower.api.enterprise import _ensure_user_org_member
    _user, org, member = _ensure_user_org_member(db, current_user)
    if not member or not getattr(member, "can_manage_team", False):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            detail="Managing installation-wide webhooks requires can_manage_team permission.")
    return org


@org_webhook_router.get("", response_model=List[WebhookResponse])
async def list_org_webhooks(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    return (
        db.query(NotificationWebhook)
        .filter(NotificationWebhook.org_id == org.id,
                NotificationWebhook.project_id.is_(None))
        .all()
    )


@org_webhook_router.post("", response_model=WebhookResponse, status_code=status.HTTP_201_CREATED)
async def create_org_webhook(
    data: WebhookCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    provider = _validate_webhook_shape(data.provider, data.url)
    hook = NotificationWebhook(
        project_id=None,
        org_id=org.id,
        provider=provider,
        url=data.url,
        label=data.label,
    )
    db.add(hook)
    db.commit()
    db.refresh(hook)
    return hook


@org_webhook_router.delete("/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_org_webhook(
    webhook_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    hook = db.query(NotificationWebhook).filter(
        NotificationWebhook.id == webhook_id,
        NotificationWebhook.org_id == org.id,
        NotificationWebhook.project_id.is_(None),
    ).first()
    if not hook:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Webhook not found")
    db.delete(hook)
    db.commit()
    return None
