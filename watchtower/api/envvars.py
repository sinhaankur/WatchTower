"""
Environment Variables API — CRUD per project.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List, Optional

from watchtower.database import (
    EnvironmentVariable,
    Environment,
    get_db,
    Project,
)
from watchtower.api import audit as audit_log
from watchtower.api import util

router = APIRouter(prefix="/api/projects", tags=["Environment Variables"])
logger = logging.getLogger(__name__)


# ── Schemas ───────────────────────────────────────────────────────────────────

class EnvVarCreate(BaseModel):
    key: str
    value: str
    environment: str = "production"   # production | staging | development


class EnvVarUpdate(BaseModel):
    value: str


class EnvVarResponse(BaseModel):
    id: UUID
    project_id: UUID
    key: str
    # value is intentionally REDACTED in list responses (returned as masked string)
    # Use the single-item GET or the POST/PUT response to retrieve the real value.
    value: str
    environment: str

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


def _mask(value: str) -> str:
    """Show only last 4 chars masked — safe to display in lists."""
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/env", response_model=List[EnvVarResponse])
async def list_env_vars(
    project_id: UUID,
    environment: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """List environment variables for a project (values are masked)."""
    user_id = util.canonical_user_id(db, current_user)
    _get_project_or_404(db, project_id, user_id)

    q = db.query(EnvironmentVariable).filter(EnvironmentVariable.project_id == project_id)
    if environment:
        q = q.filter(EnvironmentVariable.environment == environment)
    rows = q.order_by(EnvironmentVariable.key).all()

    return [
        EnvVarResponse(
            id=r.id,
            project_id=r.project_id,
            key=r.key,
            value=_mask(r.value),
            environment=r.environment.value if hasattr(r.environment, "value") else str(r.environment),
        )
        for r in rows
    ]


@router.post("/{project_id}/env", response_model=EnvVarResponse, status_code=status.HTTP_201_CREATED)
async def create_env_var(
    request: Request,
    project_id: UUID,
    data: EnvVarCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Create a new environment variable (or overwrite if key already exists)."""
    user_id = util.canonical_user_id(db, current_user)
    project = _get_project_or_404(db, project_id, user_id)

    if not data.key.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Key cannot be empty")

    # Upsert: if key already exists for this env, replace value
    existing = db.query(EnvironmentVariable).filter(
        EnvironmentVariable.project_id == project_id,
        EnvironmentVariable.key == data.key.strip(),
        EnvironmentVariable.environment == data.environment,
    ).first()

    if existing:
        existing.value = data.value
        db.flush()
        row = existing
        action = "envvar.update"
    else:
        row = EnvironmentVariable(
            project_id=project_id,
            key=data.key.strip(),
            value=data.value,
            environment=data.environment,
        )
        db.add(row)
        db.flush()
        action = "envvar.create"

    # Audit captures the KEY but never the VALUE — this is critical: the audit
    # log is queryable by org members, and the whole point of env vars is that
    # values are secret. Recording the value would defeat the purpose.
    audit_log.record_for_user(
        db, current_user,
        action=action,
        entity_type="envvar",
        entity_id=row.id,
        org_id=project.org_id,
        request=request,
        extra={"key": row.key, "environment": data.environment, "project_id": str(project_id)},
    )
    db.commit()
    db.refresh(row)

    return EnvVarResponse(
        id=row.id,
        project_id=row.project_id,
        key=row.key,
        value=row.value,    # full value on create/update
        environment=row.environment.value if hasattr(row.environment, "value") else str(row.environment),
    )


@router.put("/{project_id}/env/{env_var_id}", response_model=EnvVarResponse)
async def update_env_var(
    request: Request,
    project_id: UUID,
    env_var_id: UUID,
    data: EnvVarUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Update an existing environment variable value."""
    user_id = util.canonical_user_id(db, current_user)
    project = _get_project_or_404(db, project_id, user_id)

    row = db.query(EnvironmentVariable).filter(
        EnvironmentVariable.id == env_var_id,
        EnvironmentVariable.project_id == project_id,
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Environment variable not found")

    row.value = data.value
    audit_log.record_for_user(
        db, current_user,
        action="envvar.update",
        entity_type="envvar",
        entity_id=row.id,
        org_id=project.org_id,
        request=request,
        extra={"key": row.key, "project_id": str(project_id)},
    )
    db.commit()
    db.refresh(row)

    return EnvVarResponse(
        id=row.id,
        project_id=row.project_id,
        key=row.key,
        value=row.value,
        environment=row.environment.value if hasattr(row.environment, "value") else str(row.environment),
    )


@router.delete("/{project_id}/env/{env_var_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_env_var(
    request: Request,
    project_id: UUID,
    env_var_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Delete an environment variable."""
    user_id = util.canonical_user_id(db, current_user)
    project = _get_project_or_404(db, project_id, user_id)

    row = db.query(EnvironmentVariable).filter(
        EnvironmentVariable.id == env_var_id,
        EnvironmentVariable.project_id == project_id,
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Environment variable not found")

    audit_log.record_for_user(
        db, current_user,
        action="envvar.delete",
        entity_type="envvar",
        entity_id=row.id,
        org_id=project.org_id,
        request=request,
        extra={"key": row.key, "project_id": str(project_id)},
    )
    db.delete(row)
    db.commit()
    return None
