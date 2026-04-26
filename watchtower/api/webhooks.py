"""
GitHub webhook endpoints
"""

import hmac
import hashlib
import json
import logging
import time
from collections import OrderedDict
from threading import Lock
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Request, Header, HTTPException, status, Depends
from sqlalchemy.orm import Session

from watchtower.database import (
    get_db, Project, Deployment, DeploymentStatus, 
    DeploymentTrigger
)
from watchtower import builder as build_runner

router = APIRouter(prefix="/api/webhooks", tags=["Webhooks"])
logger = logging.getLogger(__name__)


# In-memory bounded cache of recent ``X-GitHub-Delivery`` IDs to reject
# replayed webhook payloads. Each delivery ID is a UUID and is unique per
# GitHub send attempt — but a leaked signed body could otherwise be replayed
# until the next secret rotation. 1024 entries × ~5 minute window is enough
# for the typical commit/PR rate of a small instance.
_REPLAY_TTL_SECONDS = 600
_REPLAY_MAX_ENTRIES = 1024
_replay_cache: "OrderedDict[str, float]" = OrderedDict()
_replay_lock = Lock()
# 5 MB hard cap on incoming webhook bodies to prevent DoS via huge payloads.
_MAX_WEBHOOK_BODY = 5 * 1024 * 1024


def _seen_delivery(delivery_id: str) -> bool:
    """Return True if ``delivery_id`` was already processed recently."""
    if not delivery_id:
        return False
    now = time.time()
    with _replay_lock:
        # Drop stale entries opportunistically.
        stale = [k for k, ts in _replay_cache.items() if now - ts > _REPLAY_TTL_SECONDS]
        for k in stale:
            _replay_cache.pop(k, None)
        if delivery_id in _replay_cache:
            return True
        _replay_cache[delivery_id] = now
        # Cap size — drop oldest.
        while len(_replay_cache) > _REPLAY_MAX_ENTRIES:
            _replay_cache.popitem(last=False)
    return False


def verify_webhook_signature(
    payload_body: bytes,
    secret: str,
    signature: str | None
) -> bool:
    """
    Verify GitHub webhook signature
    """
    if not signature or not signature.startswith("sha256="):
        return False

    expected_signature = "sha256=" + hmac.new(
        secret.encode(),
        payload_body,
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(expected_signature, signature)


@router.post("/github/{project_id}")
async def github_webhook(
    project_id: UUID,
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: str = Header(None),
    x_github_delivery: str = Header(None),
    db: Session = Depends(get_db)
):
    """
    GitHub webhook endpoint - triggered on push/PR
    """
    try:
        # Get project
        project = db.query(Project).filter(Project.id == project_id).first()
        
        if not project:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Project not found"
            )
        
        # Read request body (with size cap to prevent DoS)
        body = await request.body()
        if len(body) > _MAX_WEBHOOK_BODY:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Webhook payload too large",
            )
        
        # Verify webhook signature
        if not verify_webhook_signature(body, project.webhook_secret, x_hub_signature_256):
            logger.warning(
                "Webhook signature mismatch for project %s (delivery=%s)",
                project_id, x_github_delivery,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid webhook signature"
            )

        # Replay protection: reject repeated X-GitHub-Delivery values.
        if _seen_delivery(x_github_delivery or ""):
            logger.warning(
                "Duplicate webhook delivery ignored: project=%s delivery=%s",
                project_id, x_github_delivery,
            )
            return {"message": "Duplicate delivery ignored"}
        
        # Parse payload
        payload = json.loads(body)
        
        # Handle push event
        if payload.get("ref"):
            ref = payload["ref"]  # e.g., "refs/heads/main"
            branch = ref.split("/")[-1]
            
            # Only trigger if pushing to configured branch
            if branch != project.repo_branch:
                return {"message": f"Ignoring push to {branch}, watching {project.repo_branch}"}
            
            commit_sha = payload.get("after") or payload.get("head_commit", {}).get("id")
            commit_message = payload.get("head_commit", {}).get("message")
            
            # Create deployment
            deployment = Deployment(
                project_id=project.id,
                commit_sha=commit_sha,
                commit_message=commit_message,
                branch=branch,
                status=DeploymentStatus.PENDING,
                trigger=DeploymentTrigger.WEBHOOK
            )
            
            db.add(deployment)
            db.commit()
            db.refresh(deployment)

            background_tasks.add_task(build_runner.run_build_async, str(deployment.id))

            return {
                "message": "Deployment queued",
                "deployment_id": str(deployment.id)
            }
        
        # Handle PR event
        elif payload.get("pull_request"):
            pr = payload["pull_request"]
            pr_number = pr["number"]
            head_ref = pr["head"]["ref"]
            commit_sha = pr["head"]["sha"]
            
            # Only create preview if watching this branch or PR
            # (for now, you'd configure which branches create previews)
            
            deployment = Deployment(
                project_id=project.id,
                commit_sha=commit_sha,
                commit_message=pr["title"],
                branch=head_ref,
                pr_number=pr_number,
                status=DeploymentStatus.PENDING,
                trigger=DeploymentTrigger.WEBHOOK
            )
            
            db.add(deployment)
            db.commit()
            db.refresh(deployment)

            background_tasks.add_task(build_runner.run_build_async, str(deployment.id))

            return {
                "message": "Preview deployment queued",
                "deployment_id": str(deployment.id),
                "pr_number": pr_number
            }
        
        return {"message": "Webhook received but no action taken"}
    
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        logger.exception("Webhook processing failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Webhook processing error"
        )
