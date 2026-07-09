"""Per-user photo backup vault.

The buildable core of the "photo backup" feature: an authenticated ingest
endpoint the companion mobile app pushes phone photos to, plus list /
download / delete / stats. iCloud and Google Photos are deliberately not
here — neither exposes an API that can read a user's existing library
(Apple: none; Google post-2025: app-created / user-picked only), so
device-push is the only source that actually works. The ``source`` column
leaves room for a future Picker path without a migration.

Storage + hashing + dedup live in ``watchtower/photo_backups.py``; this
module owns auth, DB rows, and HTTP. Modeled on ``api/managed_db.py``.
"""

import hashlib
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from watchtower import photo_backups
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import (
    PhotoBackup,
    PhotoBackupDevice,
    PhotoBackupStatus,
    get_db,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/photos", tags=["Photos"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class DeviceCreateRequest(BaseModel):
    label: str


class DeviceResponse(BaseModel):
    id: uuid.UUID
    label: str
    last_seen_at: Optional[datetime]
    created_at: Optional[datetime]


class DeviceCreatedResponse(DeviceResponse):
    # The plaintext token, returned ONCE at creation. Store it on the phone;
    # it is never retrievable again (only its SHA-256 is persisted).
    token: str


class PhotoResponse(BaseModel):
    id: uuid.UUID
    original_filename: Optional[str]
    content_type: Optional[str]
    size_bytes: Optional[int]
    sha256: str
    captured_at: Optional[datetime]
    source: str
    device_id: Optional[uuid.UUID]
    status: PhotoBackupStatus
    created_at: Optional[datetime]


class UploadResponse(PhotoResponse):
    # True when these exact bytes were already in the vault (idempotent
    # re-push); the existing row is returned unchanged.
    deduplicated: bool


class VaultStats(BaseModel):
    photo_count: int
    total_bytes: int


# ── Helpers ────────────────────────────────────────────────────────────────


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _current_uid(db: Session, current_user: dict) -> uuid.UUID:
    """Resolve the caller to a persisted ``User.id``, creating the row if new.

    ``photo_backups.user_id`` is a hard (non-null) FK, so we can't use the
    bare synthetic id from ``canonical_user_id`` — with the static API
    token there may be no ``User`` row yet and the insert would violate the
    FK on Postgres. ``_ensure_user_org_member`` get-or-creates it (same
    helper projects/audit/legal use).
    """
    from watchtower.api.enterprise import _ensure_user_org_member

    user, _org, _member = _ensure_user_org_member(db, current_user)
    return user.id


def _serialize(p: PhotoBackup) -> dict:
    return {
        "id": p.id,
        "original_filename": p.original_filename,
        "content_type": p.content_type,
        "size_bytes": p.size_bytes,
        "sha256": p.sha256,
        "captured_at": p.captured_at,
        "source": p.source,
        "device_id": p.device_id,
        "status": p.status,
        "created_at": p.created_at,
    }


def _resolve_uploader(
    request: Request,
    db: Session,
    authorization: Optional[str],
    device_token: Optional[str],
) -> tuple[uuid.UUID, Optional[uuid.UUID]]:
    """Authenticate an upload as either a device or a user session.

    Returns ``(user_id, device_id)``. The device path is preferred so the
    phone can carry a scoped, revocable token instead of the master
    ``WATCHTOWER_API_TOKEN``. Falls back to the standard Bearer auth
    (web UI / CLI) when no device token is presented.
    """
    if device_token:
        device = (
            db.query(PhotoBackupDevice)
            .filter(PhotoBackupDevice.token_hash == _token_hash(device_token))
            .first()
        )
        if not device:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid device token",
            )
        device.last_seen_at = util.utcnow()
        return device.user_id, device.id

    # No device token → standard session/API-token auth.
    current_user = util.get_current_user(request, authorization)
    return _current_uid(db, current_user), None


# ── Device registration ──────────────────────────────────────────────────────


@router.post(
    "/devices",
    response_model=DeviceCreatedResponse,
    status_code=status.HTTP_201_CREATED,
)
async def register_device(
    body: DeviceCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Register a device and mint its push token (shown once)."""
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label is required")

    user_id = _current_uid(db, current_user)
    token = f"whphoto_{secrets.token_urlsafe(32)}"
    device = PhotoBackupDevice(
        user_id=user_id,
        label=label[:120],
        token_hash=_token_hash(token),
    )
    db.add(device)
    db.flush()
    audit_log.record_for_user(
        db,
        current_user,
        action="photo.device.register",
        entity_type="photo_backup_device",
        entity_id=device.id,
        request=request,
        extra={"label": device.label},
    )
    db.commit()
    db.refresh(device)
    return {
        "id": device.id,
        "label": device.label,
        "last_seen_at": device.last_seen_at,
        "created_at": device.created_at,
        "token": token,
    }


@router.get("/devices", response_model=list[DeviceResponse])
async def list_devices(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> list[dict]:
    user_id = _current_uid(db, current_user)
    devices = (
        db.query(PhotoBackupDevice)
        .filter(PhotoBackupDevice.user_id == user_id)
        .order_by(PhotoBackupDevice.created_at.desc())
        .all()
    )
    return [
        {
            "id": d.id,
            "label": d.label,
            "last_seen_at": d.last_seen_at,
            "created_at": d.created_at,
        }
        for d in devices
    ]


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    device_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    user_id = _current_uid(db, current_user)
    dev_uuid = util.to_uuid(device_id)
    device = (
        db.query(PhotoBackupDevice)
        .filter(
            PhotoBackupDevice.id == dev_uuid,
            PhotoBackupDevice.user_id == user_id,
        )
        .first()
    )
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    db.delete(device)
    audit_log.record_for_user(
        db,
        current_user,
        action="photo.device.revoke",
        entity_type="photo_backup_device",
        entity_id=dev_uuid,
        request=request,
    )
    db.commit()


# ── Ingest ───────────────────────────────────────────────────────────────────


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def upload_photo(
    request: Request,
    file: UploadFile = File(...),
    captured_at: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    authorization: Optional[str] = Header(None),
    x_photo_device_token: Optional[str] = Header(None),
):
    """Ingest one photo/video from a device or the web UI.

    Auth: ``X-Photo-Device-Token`` (preferred, from ``POST /devices``) or a
    standard ``Authorization: Bearer`` session token. Dedup is by content
    hash within the user's vault — re-pushing the same bytes returns the
    existing row (``deduplicated: true``) so a phone re-sync is a cheap
    no-op. NB: uploads are intentionally not written to the audit log —
    a phone syncing thousands of photos would flood it; device
    register/revoke and deletes are audited instead.
    """
    user_id, device_id = _resolve_uploader(
        request, db, authorization, x_photo_device_token
    )

    # Stream to a temp file in the vault while hashing, then dedup on the
    # hash before committing to a permanent name.
    vault = photo_backups.user_vault(str(user_id))
    tmp = vault / f".incoming-{uuid.uuid4().hex}"
    try:
        size, sha = photo_backups.write_stream(file.file, tmp)
    except photo_backups.PhotoBackupError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    existing = (
        db.query(PhotoBackup)
        .filter(PhotoBackup.user_id == user_id, PhotoBackup.sha256 == sha)
        .first()
    )
    if existing:
        photo_backups.delete_file(str(tmp))
        # last_seen_at update from a device path still needs persisting.
        db.commit()
        return {**_serialize(existing), "deduplicated": True}

    final = photo_backups.stored_path_for(str(user_id), sha, file.filename)
    try:
        tmp.rename(final)
    except OSError as exc:
        photo_backups.delete_file(str(tmp))
        raise HTTPException(status_code=500, detail="failed to store photo") from exc

    captured_dt = _parse_captured_at(captured_at)
    photo = PhotoBackup(
        user_id=user_id,
        original_filename=(file.filename or None),
        content_type=(file.content_type or None),
        file_path=str(final),
        size_bytes=size,
        sha256=sha,
        captured_at=captured_dt,
        source="device",
        device_id=device_id,
        status=PhotoBackupStatus.READY,
    )
    db.add(photo)
    db.commit()
    db.refresh(photo)
    return {**_serialize(photo), "deduplicated": False}


def _parse_captured_at(raw: Optional[str]) -> Optional[datetime]:
    """Best-effort parse of a client-supplied capture timestamp (ISO 8601)."""
    if not raw:
        return None
    try:
        # Accept a trailing 'Z' as UTC; store naive-UTC to match the schema.
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            # Normalise to naive-UTC to match util.utcnow() (the schema's
            # convention). astimezone(tz=None) would give naive-*local*.
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except (ValueError, TypeError):
        return None


# ── Read / download / delete ────────────────────────────────────────────────


@router.get("/stats", response_model=VaultStats)
async def vault_stats(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    user_id = _current_uid(db, current_user)
    # DB is the source of truth (not a disk scan): it excludes stray temp
    # files and stays consistent with what list/delete operate on.
    count, total = (
        db.query(
            func.count(PhotoBackup.id),
            func.coalesce(func.sum(PhotoBackup.size_bytes), 0),
        )
        .filter(PhotoBackup.user_id == user_id)
        .one()
    )
    return {"photo_count": count, "total_bytes": int(total)}


@router.get("", response_model=list[PhotoResponse])
async def list_photos(
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> list[dict]:
    user_id = _current_uid(db, current_user)
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    photos = (
        db.query(PhotoBackup)
        .filter(PhotoBackup.user_id == user_id)
        .order_by(PhotoBackup.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return [_serialize(p) for p in photos]


def _get_owned_photo(db: Session, user_id: uuid.UUID, photo_id: str) -> PhotoBackup:
    photo = (
        db.query(PhotoBackup)
        .filter(
            PhotoBackup.id == util.to_uuid(photo_id),
            PhotoBackup.user_id == user_id,
        )
        .first()
    )
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")
    return photo


@router.get("/{photo_id}", response_model=PhotoResponse)
async def get_photo(
    photo_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    user_id = _current_uid(db, current_user)
    return _serialize(_get_owned_photo(db, user_id, photo_id))


@router.get("/{photo_id}/content")
async def download_photo(
    photo_id: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    user_id = _current_uid(db, current_user)
    photo = _get_owned_photo(db, user_id, photo_id)
    # Defence-in-depth: never stream bytes from outside the caller's vault,
    # even if file_path were somehow tampered with.
    if not photo_backups.path_is_inside_vault(str(user_id), photo.file_path):
        raise HTTPException(status_code=404, detail="Photo bytes unavailable")
    return FileResponse(
        photo.file_path,
        media_type=photo.content_type or "application/octet-stream",
        filename=photo.original_filename or f"{photo.id}",
    )


@router.delete("/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_photo(
    photo_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    user_id = _current_uid(db, current_user)
    photo = _get_owned_photo(db, user_id, photo_id)
    file_path = photo.file_path
    db.delete(photo)
    audit_log.record_for_user(
        db,
        current_user,
        action="photo.delete",
        entity_type="photo_backup",
        entity_id=photo.id,
        request=request,
        extra={"sha256": photo.sha256},
    )
    db.commit()
    photo_backups.delete_file(file_path)
