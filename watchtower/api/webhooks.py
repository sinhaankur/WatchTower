"""
GitHub webhook endpoints
"""

import hmac
import hashlib
import json
import logging
from fastapi import APIRouter, Request, Header, HTTPException, status, Depends
from sqlalchemy.orm import Session

from watchtower.database import (
    get_db, Project, Deployment, DeploymentStatus, 
    DeploymentTrigger
)

router = APIRouter(prefix="/api/webhooks", tags=["Webhooks"])
logger = logging.getLogger(__name__)


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
    project_id: str,
    request: Request,
    x_hub_signature_256: str = Header(None),
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
        
        # Read request body
        body = await request.body()
        
        # Verify webhook signature
        if not verify_webhook_signature(body, project.webhook_secret, x_hub_signature_256):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid webhook signature"
            )
        
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
            
            # TODO: Queue build job
            
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
            
            # TODO: Queue preview deployment job
            
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
