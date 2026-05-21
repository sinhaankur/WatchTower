"""External databases — connection metadata for DBs WatchTower does NOT manage.

The bring-your-own-DB counterpart to managed_db.py. Stores host / port /
user / encrypted-password / engine for a remote database so apps deployed
through WatchTower can reference it by name. No podman, no lifecycle.

Engines are the same identifier set as ManagedDatabase so the UI's
"pick a database" surface looks uniform regardless of which side it
lives on.
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
from watchtower.api.managed_db import _ENGINES  # share the engine catalogue
from watchtower.database import ExternalDatabase, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/external-databases", tags=["External Databases"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class CreateExternalRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    engine: str = Field(...)
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(..., ge=1, le=65535)
    database_name: str = Field("", max_length=63)
    username: str = Field("", max_length=63)
    password: str = Field("", max_length=512)
    use_tls: bool = True
    notes: Optional[str] = Field(None, max_length=500)


class UpdateExternalRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=64)
    host: Optional[str] = Field(None, min_length=1, max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    database_name: Optional[str] = Field(None, max_length=63)
    username: Optional[str] = Field(None, max_length=63)
    password: Optional[str] = Field(None, max_length=512)
    use_tls: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=500)


class ExternalDbResponse(BaseModel):
    id: str
    name: str
    engine: str
    host: str
    port: int
    database_name: str
    username: str
    use_tls: bool
    notes: Optional[str] = None
    # We expose whether a password is on file but never the value itself
    # in list/get responses — operators reveal explicitly via /credentials.
    has_password: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _serialize(row: ExternalDatabase) -> ExternalDbResponse:
    return ExternalDbResponse(
        id=str(row.id),
        name=row.name,
        engine=row.engine,
        host=row.host,
        port=row.port,
        database_name=row.database_name or "",
        username=row.username or "",
        use_tls=bool(row.use_tls),
        notes=row.notes,
        has_password=bool(row.password_encrypted),
        created_at=row.created_at.isoformat() if row.created_at else None,
        updated_at=row.updated_at.isoformat() if row.updated_at else None,
    )


def _validate_engine(engine: str) -> None:
    if engine not in _ENGINES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported engine '{engine}'. "
                f"Supported: {', '.join(sorted(_ENGINES))}."
            ),
        )


def _get_or_404(db: Session, db_id) -> ExternalDatabase:
    uid = util.to_uuid(db_id)
    row = db.query(ExternalDatabase).filter(ExternalDatabase.id == uid).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="External database not found")
    return row


def _resolve_org_id(db_session: Session, current_user: dict):
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _u, org, _m = _ensure_user_org_member(db_session, current_user)
        return org.id
    except Exception:  # noqa: BLE001
        return None


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=list[ExternalDbResponse])
async def list_external(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[ExternalDbResponse]:
    rows = db.query(ExternalDatabase).order_by(ExternalDatabase.created_at.desc()).all()
    return [_serialize(r) for r in rows]


@router.post("", response_model=ExternalDbResponse)
async def create_external(
    body: CreateExternalRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    _validate_engine(body.engine)

    if db.query(ExternalDatabase).filter(ExternalDatabase.name == body.name).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An external database named '{body.name}' already exists.",
        )

    row = ExternalDatabase(
        org_id=_resolve_org_id(db, current_user),
        name=body.name,
        engine=body.engine,
        host=body.host,
        port=body.port,
        database_name=body.database_name or "",
        username=body.username or "",
        password_encrypted=util.encrypt_secret(body.password) if body.password else "",
        use_tls=body.use_tls,
        notes=body.notes,
    )
    db.add(row)
    db.flush()

    audit_log.record_for_user(
        db, current_user,
        action="external_db.create",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        # Never log the password. Host + port + name are fine — same
        # info the operator has in their own DNS / docs.
        extra={
            "name": row.name,
            "engine": row.engine,
            "host": row.host,
            "port": row.port,
            "use_tls": row.use_tls,
        },
    )
    db.commit()
    return _serialize(row)


@router.get("/{db_id}", response_model=ExternalDbResponse)
async def get_external(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    return _serialize(_get_or_404(db, db_id))


@router.patch("/{db_id}", response_model=ExternalDbResponse)
async def update_external(
    db_id: UUID,
    body: UpdateExternalRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    row = _get_or_404(db, db_id)
    updates: dict = {}
    for field in ("name", "host", "port", "database_name", "username", "use_tls", "notes"):
        val = getattr(body, field)
        if val is not None:
            setattr(row, field, val)
            updates[field] = val
    if body.password is not None:
        # Empty string means "clear the password" (e.g. moved to OS keychain).
        row.password_encrypted = util.encrypt_secret(body.password) if body.password else ""
        updates["password_changed"] = True

    audit_log.record_for_user(
        db, current_user,
        action="external_db.update",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name, "updated_fields": list(updates.keys())},
    )
    db.commit()
    return _serialize(row)


@router.delete("/{db_id}")
async def delete_external(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    row = _get_or_404(db, db_id)
    audit_log.record_for_user(
        db, current_user,
        action="external_db.delete",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.delete(row)
    db.commit()
    return {"ok": True, "id": str(db_id)}


@router.get("/{db_id}/credentials")
async def reveal_external(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Reveal password + assemble connection string. Audit-logged."""
    row = _get_or_404(db, db_id)
    password = util.decrypt_secret(row.password_encrypted) if row.password_encrypted else ""
    spec = _ENGINES.get(row.engine)
    scheme = spec.conn_scheme if spec else row.engine
    if row.engine == "redis":
        conn = f"{scheme}://:{password}@{row.host}:{row.port}"
    else:
        userinfo = f"{row.username}:{password}@" if row.username or password else ""
        path = f"/{row.database_name}" if row.database_name else ""
        conn = f"{scheme}://{userinfo}{row.host}:{row.port}{path}"

    audit_log.record_for_user(
        db, current_user,
        action="external_db.credentials.view",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.commit()
    return {"password": password, "connection_string": conn}
