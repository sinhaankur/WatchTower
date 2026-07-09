"""Per-user password / secrets vault.

A personal vault (parallel to the photo vault in ``api/photos.py``): each
entry's secret value is Fernet-encrypted at rest and is NEVER returned by
list or get — only by an explicit ``GET /{id}/reveal``, which is written
to the audit log. Metadata (name, username, url, notes, category) stays
plaintext so the vault is browsable without decrypting anything.

Security invariants (do not regress — tested in tests/test_passwords.py):
  * The plaintext secret leaves the server only via ``/reveal``.
  * The audit log records the entry *name*, never the secret value
    (same rule as env-var audits).
  * Entries are strictly per-user; cross-user access 404s.
"""

import logging
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import PasswordEntry, get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/passwords", tags=["Passwords"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class PasswordCreate(BaseModel):
    name: str
    secret: str
    username: Optional[str] = None
    url: Optional[str] = None
    notes: Optional[str] = None
    category: Optional[str] = None


class PasswordUpdate(BaseModel):
    # All optional — only provided fields change. A non-empty ``secret``
    # re-encrypts; omit it to leave the stored secret untouched.
    name: Optional[str] = None
    secret: Optional[str] = None
    username: Optional[str] = None
    url: Optional[str] = None
    notes: Optional[str] = None
    category: Optional[str] = None


class PasswordResponse(BaseModel):
    id: uuid.UUID
    name: str
    username: Optional[str]
    url: Optional[str]
    notes: Optional[str]
    category: Optional[str]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]


class RevealResponse(BaseModel):
    id: uuid.UUID
    secret: str


# ── Helpers ──────────────────────────────────────────────────────────────────


def _current_uid(db: Session, current_user: dict) -> uuid.UUID:
    """Resolve caller to a persisted ``User.id`` (get-or-create) for the FK."""
    from watchtower.api.enterprise import _ensure_user_org_member

    user, _org, _member = _ensure_user_org_member(db, current_user)
    return user.id


def _serialize(e: PasswordEntry) -> dict:
    # NB: deliberately excludes secret_encrypted — the secret never rides
    # along on a metadata response.
    return {
        "id": e.id,
        "name": e.name,
        "username": e.username,
        "url": e.url,
        "notes": e.notes,
        "category": e.category,
        "created_at": e.created_at,
        "updated_at": e.updated_at,
    }


def _get_owned(db: Session, user_id: uuid.UUID, entry_id: str) -> PasswordEntry:
    entry = (
        db.query(PasswordEntry)
        .filter(
            PasswordEntry.id == util.to_uuid(entry_id),
            PasswordEntry.user_id == user_id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


# ── CRUD ─────────────────────────────────────────────────────────────────────


@router.post("", response_model=PasswordResponse, status_code=status.HTTP_201_CREATED)
async def create_entry(
    body: PasswordCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not body.secret:
        raise HTTPException(status_code=400, detail="secret is required")

    user_id = _current_uid(db, current_user)
    entry = PasswordEntry(
        user_id=user_id,
        name=name[:200],
        username=body.username,
        url=body.url,
        notes=body.notes,
        category=body.category,
        secret_encrypted=util.encrypt_secret(body.secret),
    )
    db.add(entry)
    db.flush()
    audit_log.record_for_user(
        db,
        current_user,
        action="password.create",
        entity_type="password_entry",
        entity_id=entry.id,
        request=request,
        extra={"name": entry.name},  # never the secret value
    )
    db.commit()
    db.refresh(entry)
    return _serialize(entry)


@router.get("", response_model=list[PasswordResponse])
async def list_entries(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> list[dict]:
    user_id = _current_uid(db, current_user)
    entries = (
        db.query(PasswordEntry)
        .filter(PasswordEntry.user_id == user_id)
        .order_by(PasswordEntry.name.asc())
        .all()
    )
    return [_serialize(e) for e in entries]


@router.get("/{entry_id}", response_model=PasswordResponse)
async def get_entry(
    entry_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    user_id = _current_uid(db, current_user)
    return _serialize(_get_owned(db, user_id, entry_id))


@router.get("/{entry_id}/reveal", response_model=RevealResponse)
async def reveal_entry(
    entry_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Return the decrypted secret. This is the ONLY path that emits the
    plaintext, and every call is written to the audit log (name only)."""
    user_id = _current_uid(db, current_user)
    entry = _get_owned(db, user_id, entry_id)
    secret = util.decrypt_secret(entry.secret_encrypted)
    audit_log.record_for_user(
        db,
        current_user,
        action="password.reveal",
        entity_type="password_entry",
        entity_id=entry.id,
        request=request,
        extra={"name": entry.name},  # never the secret value
    )
    db.commit()
    return {"id": entry.id, "secret": secret}


@router.put("/{entry_id}", response_model=PasswordResponse)
async def update_entry(
    entry_id: str,
    body: PasswordUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    user_id = _current_uid(db, current_user)
    entry = _get_owned(db, user_id, entry_id)

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        entry.name = name[:200]
    if body.username is not None:
        entry.username = body.username
    if body.url is not None:
        entry.url = body.url
    if body.notes is not None:
        entry.notes = body.notes
    if body.category is not None:
        entry.category = body.category
    if body.secret:  # only re-encrypt when a non-empty secret is supplied
        entry.secret_encrypted = util.encrypt_secret(body.secret)

    audit_log.record_for_user(
        db,
        current_user,
        action="password.update",
        entity_type="password_entry",
        entity_id=entry.id,
        request=request,
        extra={"name": entry.name, "secret_changed": bool(body.secret)},
    )
    db.commit()
    db.refresh(entry)
    return _serialize(entry)


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_entry(
    entry_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    user_id = _current_uid(db, current_user)
    entry = _get_owned(db, user_id, entry_id)
    db.delete(entry)
    audit_log.record_for_user(
        db,
        current_user,
        action="password.delete",
        entity_type="password_entry",
        entity_id=entry.id,
        request=request,
        extra={"name": entry.name},
    )
    db.commit()
