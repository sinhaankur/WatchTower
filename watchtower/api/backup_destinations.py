"""Backup destinations API — manage off-host targets that every managed-DB
backup is auto-pushed to (always-on peer over the tailnet, cloud/NAS folder).

Installation-wide (org-scoped) and org-admin gated (``can_manage_team``), the
same model as org webhooks — a backup destination is an infrastructure
concern, not a per-project one.

The heavy lifting lives in ``watchtower/backup_shipper.py``; this router is
just CRUD + a synchronous "test" that ships the most recent backup (or an
empty probe file) so the operator can confirm connectivity before relying on
it.
"""
from __future__ import annotations

import logging
import re
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import (
    BackupDestination,
    BackupDestinationKind,
    OrgNode,
    get_db,
)

router = APIRouter(prefix="/api/backup-destinations", tags=["Backup Destinations"])
logger = logging.getLogger(__name__)


# ── Schemas ───────────────────────────────────────────────────────────────────


class DestinationCreate(BaseModel):
    kind: str                       # "peer" | "folder"
    label: Optional[str] = None
    # peer:
    node_id: Optional[UUID] = None
    remote_subdir: Optional[str] = "watchtower-backups"
    # folder:
    folder_path: Optional[str] = None


class DestinationResponse(BaseModel):
    id: UUID
    kind: str
    label: Optional[str]
    is_enabled: bool
    node_id: Optional[UUID]
    remote_subdir: Optional[str]
    folder_path: Optional[str]

    class Config:
        from_attributes = True

    @classmethod
    def of(cls, d: BackupDestination) -> "DestinationResponse":
        return cls(
            id=d.id,
            kind=d.kind.value if hasattr(d.kind, "value") else str(d.kind),
            label=d.label,
            is_enabled=d.is_enabled,
            node_id=d.node_id,
            remote_subdir=d.remote_subdir,
            folder_path=d.folder_path,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────


# Windows drive path (C:\...) or UNC share (\\server\share). POSIX paths are
# handled separately (leading / or ~). We accept these so a WatchTower host on
# Windows — or backing up TO a Windows-hosted folder — can register a
# destination without a POSIX-only validation rejecting a valid path.
_WINDOWS_PATH_RE = re.compile(r"^([a-zA-Z]:[\\/]|\\\\[^\\]+\\)")


def _is_absolute_folder_path(path: str) -> bool:
    """True for an absolute path on any supported OS: POSIX (/... or ~...) or
    Windows (C:\\... / \\\\server\\share). Cross-platform because the WatchTower
    host can be Linux, macOS, or Windows."""
    if path.startswith("/") or path.startswith("~"):
        return True
    return bool(_WINDOWS_PATH_RE.match(path))


def _require_org_admin(db: Session, current_user: dict):
    """Resolve the caller's org and require can_manage_team. Mirrors the
    org-webhooks gate — a backup destination is an installation concern."""
    from watchtower.api.enterprise import _ensure_user_org_member

    _user, org, member = _ensure_user_org_member(db, current_user)
    if not member or not getattr(member, "can_manage_team", False):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail="Managing backup destinations requires can_manage_team permission.",
        )
    return org


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("", response_model=List[DestinationResponse])
async def list_destinations(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    dests = (
        db.query(BackupDestination)
        .filter(BackupDestination.org_id == org.id)
        .order_by(BackupDestination.created_at.asc())
        .all()
    )
    return [DestinationResponse.of(d) for d in dests]


class NodeOption(BaseModel):
    id: UUID
    name: Optional[str]
    host: Optional[str]


@router.get("/nodes", response_model=List[NodeOption])
async def list_peer_node_options(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Nodes in the caller's org, for the 'peer' destination picker. Avoids the
    UI needing the org id to hit /orgs/{id}/nodes."""
    org = _require_org_admin(db, current_user)
    nodes = (
        db.query(OrgNode)
        .filter(OrgNode.org_id == org.id, OrgNode.is_active.is_(True))
        .order_by(OrgNode.name.asc())
        .all()
    )
    return [NodeOption(id=n.id, name=n.name, host=n.host) for n in nodes]


@router.post("", response_model=DestinationResponse, status_code=status.HTTP_201_CREATED)
async def create_destination(
    body: DestinationCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)

    kind = (body.kind or "").lower().strip()
    if kind not in ("peer", "folder"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="kind must be 'peer' or 'folder'")

    if kind == "peer":
        if not body.node_id:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="peer destinations require node_id")
        node = (
            db.query(OrgNode)
            .filter(OrgNode.id == body.node_id, OrgNode.org_id == org.id)
            .first()
        )
        if not node:
            raise HTTPException(status.HTTP_404_NOT_FOUND,
                                detail="node not found in your organization")
        dest = BackupDestination(
            org_id=org.id,
            kind=BackupDestinationKind.PEER,
            label=body.label or node.name,
            node_id=node.id,
            remote_subdir=(body.remote_subdir or "watchtower-backups").strip() or "watchtower-backups",
            created_by_user_id=util.canonical_user_id(db, current_user),
        )
    else:  # folder
        path = (body.folder_path or "").strip()
        if not path:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail="folder destinations require folder_path")
        if not _is_absolute_folder_path(path):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="folder_path must be an absolute path — POSIX "
                       "(/mnt/nas/backups or ~/Dropbox/watchtower-backups) or "
                       "Windows (C:\\Backups or \\\\server\\share\\backups).",
            )
        dest = BackupDestination(
            org_id=org.id,
            kind=BackupDestinationKind.FOLDER,
            label=body.label or path,
            folder_path=path,
            created_by_user_id=util.canonical_user_id(db, current_user),
        )

    db.add(dest)
    db.flush()
    audit_log.record_for_user(
        db, current_user,
        action="backup_destination.create",
        entity_type="backup_destination",
        entity_id=dest.id,
        org_id=org.id,
        request=request,
        extra={"kind": kind, "label": dest.label},
    )
    db.commit()
    db.refresh(dest)
    return DestinationResponse.of(dest)


class DestinationToggle(BaseModel):
    is_enabled: bool


@router.patch("/{dest_id}", response_model=DestinationResponse)
async def toggle_destination(
    dest_id: UUID,
    body: DestinationToggle,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    dest = _get_or_404(db, dest_id, org.id)
    dest.is_enabled = body.is_enabled
    db.commit()
    db.refresh(dest)
    return DestinationResponse.of(dest)


@router.delete("/{dest_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_destination(
    dest_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    org = _require_org_admin(db, current_user)
    dest = _get_or_404(db, dest_id, org.id)
    audit_log.record_for_user(
        db, current_user,
        action="backup_destination.delete",
        entity_type="backup_destination",
        entity_id=dest.id,
        org_id=org.id,
        request=request,
        extra={"kind": dest.kind.value, "label": dest.label},
    )
    db.delete(dest)
    db.commit()
    return None


class DestinationTestResponse(BaseModel):
    ok: bool
    detail: Optional[str] = None
    dest_path: Optional[str] = None


@router.post("/{dest_id}/test", response_model=DestinationTestResponse)
async def test_destination(
    dest_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Ship a tiny probe file to the destination so the operator can verify
    connectivity (SSH key / reachable peer / writable folder) before relying
    on it. Side-effect: a small ``.watchtower-probe`` file lands on the dest.
    """
    import tempfile
    from pathlib import Path

    from watchtower import backup_shipper

    org = _require_org_admin(db, current_user)
    dest = _get_or_404(db, dest_id, org.id)

    with tempfile.NamedTemporaryFile(
        prefix="watchtower-probe-", suffix=".txt", delete=False
    ) as tf:
        tf.write(b"WatchTower backup-destination connectivity probe.\n")
        probe = Path(tf.name)
    try:
        if dest.kind == BackupDestinationKind.FOLDER:
            path = backup_shipper._push_to_folder(probe, dest.folder_path, "_probe")
        else:
            if dest.node is None:
                return DestinationTestResponse(ok=False, detail="peer destination has no node")
            path = backup_shipper._push_to_peer(dest.node, probe, dest.remote_subdir, "_probe")
        return DestinationTestResponse(ok=True, dest_path=path,
                                       detail="Probe file delivered successfully.")
    except Exception as exc:  # noqa: BLE001
        return DestinationTestResponse(ok=False, detail=str(exc)[:500])
    finally:
        try:
            probe.unlink(missing_ok=True)
        except OSError:
            pass


def _get_or_404(db: Session, dest_id: UUID, org_id) -> BackupDestination:
    dest = (
        db.query(BackupDestination)
        .filter(BackupDestination.id == dest_id, BackupDestination.org_id == org_id)
        .first()
    )
    if not dest:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Backup destination not found")
    return dest
