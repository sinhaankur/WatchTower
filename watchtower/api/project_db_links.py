"""Project ↔ Database links — turn a managed/external DB into an env var.

The data-pillar feature finally plugs into the deploy flow. Before
this, creating a Managed Database in WatchTower gave you a Postgres pod
but you still had to copy the connection string by hand into your
project's env-var settings. After this, the operator picks a database
+ an env-var name (defaults to ``DATABASE_URL``), and every subsequent
deploy auto-injects the live connection string into the build env.

Why the link, not just an EnvironmentVariable row pointing at the conn
string:

  * **Rotation safety.** When the managed DB's password rotates (or
    the external DB's password is updated via the credentials endpoint),
    the next deploy picks up the new value automatically. A static
    EnvironmentVariable row would silently freeze on the old password.
  * **Single source of truth.** The DB owns its connection details;
    the link just borrows them.
  * **Audit.** Linking + unlinking shows up in the audit log alongside
    project/deploy actions, so an operator can answer "when did app X
    start using DB Y?" without `git blame`-ing env-var changes.

Helper ``resolve_env_vars_for_project(db, project_id)`` is consumed by
``watchtower/builder.py`` at deploy time to inject the right vars.
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.api.managed_db import _ENGINES
from watchtower.database import (
    ExternalDatabase,
    ManagedDatabase,
    Project,
    ProjectDatabaseLink,
    get_db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/projects/{project_id}/databases", tags=["Project Databases"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class CreateLinkRequest(BaseModel):
    managed_database_id: Optional[UUID] = None
    external_database_id: Optional[UUID] = None
    env_var_name: str = Field(
        default="DATABASE_URL",
        min_length=1, max_length=64,
        description="Env var the connection string is injected as at deploy time.",
    )
    notes: Optional[str] = Field(default=None, max_length=500)


class UpdateLinkRequest(BaseModel):
    env_var_name: Optional[str] = Field(default=None, min_length=1, max_length=64)
    is_active: Optional[bool] = None
    notes: Optional[str] = Field(default=None, max_length=500)


class LinkResponse(BaseModel):
    id: str
    project_id: str
    managed_database_id: Optional[str] = None
    external_database_id: Optional[str] = None
    # Denormalised for the UI — avoids a chatty per-link round-trip to
    # fetch the human name + engine.
    database_name: str
    database_engine: str
    database_kind: str          # "managed" | "external"
    env_var_name: str
    is_active: bool
    notes: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────


def _validate_env_var_name(name: str) -> None:
    """Env var names are conventionally [A-Z_][A-Z0-9_]+; we enforce
    that so a stray space or shell metacharacter can't slip into the
    shell-context-bound deploy environment."""
    if not name or not (name[0].isalpha() or name[0] == "_"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="env_var_name must start with a letter or underscore",
        )
    if not all(c.isalnum() or c == "_" for c in name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="env_var_name must contain only letters, numbers, underscores",
        )


def _project_or_404(db: Session, project_id) -> Project:
    pid = util.to_uuid(project_id)
    row = db.query(Project).filter(Project.id == pid).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")
    return row


def _resolve_target(db: Session, body: CreateLinkRequest):
    """Validate exactly-one-of-managed-or-external + ensure the target exists."""
    if bool(body.managed_database_id) == bool(body.external_database_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Specify exactly one of managed_database_id OR external_database_id.",
        )
    if body.managed_database_id:
        target = db.query(ManagedDatabase).filter(
            ManagedDatabase.id == body.managed_database_id
        ).first()
        if not target:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Managed database not found.",
            )
        return ("managed", target)
    target = db.query(ExternalDatabase).filter(
        ExternalDatabase.id == body.external_database_id
    ).first()
    if not target:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="External database not found.",
        )
    return ("external", target)


def _serialize(link: ProjectDatabaseLink) -> LinkResponse:
    """Eager-load the target DB row to denormalise name + engine + kind."""
    if link.managed_database is not None:
        name = link.managed_database.name
        engine = link.managed_database.engine
        kind = "managed"
    elif link.external_database is not None:
        name = link.external_database.name
        engine = link.external_database.engine
        kind = "external"
    else:
        # Defensive — should never happen given the constraint, but
        # don't blow up the list endpoint if it does.
        name = "(unknown — dangling link)"
        engine = "?"
        kind = "?"
    return LinkResponse(
        id=str(link.id),
        project_id=str(link.project_id),
        managed_database_id=str(link.managed_database_id) if link.managed_database_id else None,
        external_database_id=str(link.external_database_id) if link.external_database_id else None,
        database_name=name,
        database_engine=engine,
        database_kind=kind,
        env_var_name=link.env_var_name,
        is_active=link.is_active,
        notes=link.notes,
        created_at=link.created_at.isoformat() if link.created_at else None,
        updated_at=link.updated_at.isoformat() if link.updated_at else None,
    )


# ── Connection-string resolver (consumed by builder.py at deploy time) ───────


def _conn_string_for_managed(mdb: ManagedDatabase) -> str:
    """Decrypt the password + assemble engine-appropriate URL."""
    spec = _ENGINES.get(mdb.engine)
    scheme = spec.conn_scheme if spec else "postgresql"
    password = util.decrypt_secret(mdb.password_encrypted)
    if mdb.engine == "redis":
        return f"{scheme}://:{password}@{mdb.host}:{mdb.port}"
    return f"{scheme}://{mdb.username}:{password}@{mdb.host}:{mdb.port}/{mdb.database_name}"


def _conn_string_for_external(edb: ExternalDatabase) -> str:
    """External DBs may have an empty password (no-auth) or empty
    user/database (Redis-style). The URL adapts."""
    spec = _ENGINES.get(edb.engine)
    scheme = spec.conn_scheme if spec else edb.engine
    password = util.decrypt_secret(edb.password_encrypted) if edb.password_encrypted else ""
    if edb.engine == "redis":
        return f"{scheme}://:{password}@{edb.host}:{edb.port}"
    userinfo = ""
    if edb.username or password:
        userinfo = f"{edb.username}:{password}@"
    path = f"/{edb.database_name}" if edb.database_name else ""
    return f"{scheme}://{userinfo}{edb.host}:{edb.port}{path}"


def resolve_env_vars_for_project(db: Session, project_id) -> dict[str, str]:
    """Build the {ENV_VAR_NAME: connection_string} map for a project.

    Called from builder.py at deploy time. Pulls every active link for
    the project, decrypts the linked DB's password, assembles the URL,
    returns the dict. Inactive links are skipped silently — operators
    use ``is_active=False`` to pause an injection without unlinking.

    Failures decrypting a single secret are logged + skipped (rather
    than failing the whole build). This is deliberate: a missing
    secret-encryption key after a rotation event should make ONE DB
    unavailable, not break every deploy in the install.
    """
    pid = util.to_uuid(project_id)
    links = (
        db.query(ProjectDatabaseLink)
        .filter(
            ProjectDatabaseLink.project_id == pid,
            ProjectDatabaseLink.is_active.is_(True),
        )
        .all()
    )
    out: dict[str, str] = {}
    for link in links:
        try:
            if link.managed_database_id and link.managed_database is not None:
                out[link.env_var_name] = _conn_string_for_managed(link.managed_database)
            elif link.external_database_id and link.external_database is not None:
                out[link.env_var_name] = _conn_string_for_external(link.external_database)
            # else: dangling link — should not happen; skip silently.
        except Exception:  # noqa: BLE001 — one bad link must not break the build
            logger.exception(
                "Failed to resolve connection string for link %s (env=%s) — skipping",
                link.id, link.env_var_name,
            )
    return out


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=list[LinkResponse])
async def list_links(
    project_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[LinkResponse]:
    project = _project_or_404(db, project_id)
    rows = (
        db.query(ProjectDatabaseLink)
        .filter(ProjectDatabaseLink.project_id == project.id)
        .order_by(ProjectDatabaseLink.created_at.asc())
        .all()
    )
    return [_serialize(r) for r in rows]


@router.post("", response_model=LinkResponse)
async def create_link(
    project_id: UUID,
    body: CreateLinkRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> LinkResponse:
    project = _project_or_404(db, project_id)
    _validate_env_var_name(body.env_var_name)
    target_kind, target = _resolve_target(db, body)

    # The unique constraint (project_id + env_var_name) blocks duplicates
    # at the DB level — but surface a clean 409 here so the UI can show
    # a helpful message instead of waiting for the SQL error.
    existing = db.query(ProjectDatabaseLink).filter(
        ProjectDatabaseLink.project_id == project.id,
        ProjectDatabaseLink.env_var_name == body.env_var_name,
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Project already has a link injecting as {body.env_var_name}. "
                f"Pick a different env var name or remove the existing link first."
            ),
        )

    link = ProjectDatabaseLink(
        project_id=project.id,
        managed_database_id=target.id if target_kind == "managed" else None,
        external_database_id=target.id if target_kind == "external" else None,
        env_var_name=body.env_var_name,
        is_active=True,
        notes=body.notes,
    )
    db.add(link)
    db.flush()

    audit_log.record_for_user(
        db, current_user,
        action="project.database.link",
        entity_type="project_database_link",
        entity_id=link.id,
        org_id=project.org_id,
        request=request,
        extra={
            "project_id": str(project.id),
            "project_name": project.name,
            "database_kind": target_kind,
            "database_id": str(target.id),
            "env_var_name": body.env_var_name,
        },
    )
    db.commit()
    db.refresh(link)
    return _serialize(link)


@router.patch("/{link_id}", response_model=LinkResponse)
async def update_link(
    project_id: UUID,
    link_id: UUID,
    body: UpdateLinkRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> LinkResponse:
    project = _project_or_404(db, project_id)
    link = db.query(ProjectDatabaseLink).filter(
        ProjectDatabaseLink.id == util.to_uuid(link_id),
        ProjectDatabaseLink.project_id == project.id,
    ).first()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found")

    updates: dict = {}
    if body.env_var_name is not None and body.env_var_name != link.env_var_name:
        _validate_env_var_name(body.env_var_name)
        # Check uniqueness manually before commit so we return a clean 409.
        clash = db.query(ProjectDatabaseLink).filter(
            ProjectDatabaseLink.project_id == project.id,
            ProjectDatabaseLink.env_var_name == body.env_var_name,
            ProjectDatabaseLink.id != link.id,
        ).first()
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Project already has a link injecting as {body.env_var_name}."
                ),
            )
        updates["env_var_name"] = body.env_var_name
        link.env_var_name = body.env_var_name
    if body.is_active is not None and body.is_active != link.is_active:
        updates["is_active"] = body.is_active
        link.is_active = body.is_active
    if body.notes is not None:
        updates["notes"] = body.notes
        link.notes = body.notes

    if updates:
        audit_log.record_for_user(
            db, current_user,
            action="project.database.link.update",
            entity_type="project_database_link",
            entity_id=link.id,
            org_id=project.org_id,
            request=request,
            extra={"project_name": project.name, "updated_fields": list(updates.keys())},
        )
    db.commit()
    db.refresh(link)
    return _serialize(link)


@router.delete("/{link_id}")
async def delete_link(
    project_id: UUID,
    link_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    project = _project_or_404(db, project_id)
    link = db.query(ProjectDatabaseLink).filter(
        ProjectDatabaseLink.id == util.to_uuid(link_id),
        ProjectDatabaseLink.project_id == project.id,
    ).first()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found")

    audit_log.record_for_user(
        db, current_user,
        action="project.database.unlink",
        entity_type="project_database_link",
        entity_id=link.id,
        org_id=project.org_id,
        request=request,
        extra={"project_name": project.name, "env_var_name": link.env_var_name},
    )
    db.delete(link)
    db.commit()
    return {"ok": True, "id": str(link_id)}
