"""Audit log: append-only record of mutations across the API surface.

Closes audit-review item #10. The terminal-command runner already had
its own encrypted audit log (`runtime.py`'s `terminal-audit.log.enc`),
but project / deployment / team / env-var / node mutations left no
trail. Now every state-changing endpoint can call ``record()`` and
operators get a queryable history scoped to their org.

Each event captures:
  * actor (user_id + email when authenticated)
  * action (dotted name like "project.create")
  * entity (type + UUID, when applicable)
  * trace correlation (request_id from log_config + client IP)
  * org_id so the read endpoint can scope without joining
  * action-specific JSON metadata

The read endpoint (``GET /api/audit``) returns events for the caller's
organization only; cross-org reads are not allowed.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import event
from sqlalchemy.orm import Session

from watchtower.database import AuditEvent, get_db
from watchtower.api import util
from watchtower.log_config import get_request_id

router = APIRouter(prefix="/api/audit", tags=["Audit"])
logger = logging.getLogger(__name__)


# ── Append-only enforcement ──────────────────────────────────────────────────
# An audit log is only meaningful if rows can't be tampered with after the
# fact. The existing `record()` helper writes via `db.flush()` and never
# updates or deletes — but ORM-level enforcement closes off accidental code
# paths and intentional bugs that try to clean up the table. A `before_*`
# event hook raises before the change reaches the database.
#
# DB-level immutability (revoking UPDATE/DELETE on the table for the API
# role, or a Postgres BEFORE-DELETE trigger) is still recommended in
# production — that's outside the application's reach but documented in
# CLAUDE.md.

class AuditLogImmutableError(RuntimeError):
    """Raised when code attempts to modify an existing AuditEvent row."""


@event.listens_for(AuditEvent, "before_update")
def _block_audit_update(_mapper, _connection, _target):  # pragma: no cover - guard
    raise AuditLogImmutableError(
        "AuditEvent rows are append-only — UPDATE is forbidden. "
        "If you intended to add a new event, call audit.record() instead."
    )


@event.listens_for(AuditEvent, "before_delete")
def _block_audit_delete(_mapper, _connection, _target):  # pragma: no cover - guard
    raise AuditLogImmutableError(
        "AuditEvent rows are append-only — DELETE is forbidden. "
        "Aged-out events should be exported, not deleted from the table."
    )


# ── Recording ────────────────────────────────────────────────────────────────

def record(
    db: Session,
    *,
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[UUID] = None,
    org_id: Optional[UUID] = None,
    actor_user_id: Optional[UUID] = None,
    actor_email: Optional[str] = None,
    request: Optional[Request] = None,
    extra: Optional[dict] = None,
) -> None:
    """Append an audit event. Never raises — failures log and return.

    The caller is responsible for the surrounding transaction. We
    ``flush()`` (not ``commit()``) so the event lives or dies with the
    user's intended write — if the project create rolls back due to a
    constraint, the audit row goes with it. That's intentional: an
    audit row about an action that didn't happen is misleading.
    """
    try:
        request_id = get_request_id() or None
        ip = None
        if request is not None and request.client is not None:
            ip = request.client.host

        event = AuditEvent(
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            org_id=org_id,
            actor_user_id=actor_user_id,
            actor_email=actor_email,
            request_id=request_id,
            ip_address=ip,
            extra_json=json.dumps(extra, default=str) if extra else None,
        )
        db.add(event)
        db.flush()
    except Exception:  # noqa: BLE001 — audit must never break the user-facing op
        logger.exception("Failed to record audit event action=%s", action)


def record_for_user(
    db: Session,
    current_user: dict,
    *,
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[UUID] = None,
    org_id: Optional[UUID] = None,
    request: Optional[Request] = None,
    extra: Optional[dict] = None,
) -> None:
    """Convenience wrapper that pulls actor fields out of the current_user dict.

    The dependency-injected ``current_user`` has ``user_id`` (string UUID)
    and ``email``; this helper coerces and forwards them so the call site
    stays a one-liner.
    """
    actor_uid = None
    user_id_raw = current_user.get("user_id")
    if user_id_raw:
        try:
            actor_uid = UUID(str(user_id_raw))
        except (ValueError, TypeError):
            actor_uid = None
    record(
        db,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        org_id=org_id,
        actor_user_id=actor_uid,
        actor_email=current_user.get("email"),
        request=request,
        extra=extra,
    )


# ── Read endpoint ────────────────────────────────────────────────────────────

@router.get("")
async def list_audit_events(
    request: Request,
    entity_type: Optional[str] = Query(None, description='Filter by entity type, e.g. "project"'),
    entity_id: Optional[UUID] = Query(None),
    action: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=365, description="Look-back window in days"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> List[dict]:
    """Return audit events for the caller's organization, newest first.

    Cross-org reads are rejected. The org is resolved the same way the
    rest of the API does — via the canonical user→org membership.
    """
    from watchtower.api.enterprise import _ensure_user_org_member
    _user, canonical_org, _member = _ensure_user_org_member(db, current_user)

    cutoff = datetime.utcnow() - timedelta(days=days)
    q = (
        db.query(AuditEvent)
        .filter(AuditEvent.org_id == canonical_org.id)
        .filter(AuditEvent.created_at >= cutoff)
    )
    if entity_type:
        q = q.filter(AuditEvent.entity_type == entity_type)
    if entity_id:
        q = q.filter(AuditEvent.entity_id == entity_id)
    if action:
        q = q.filter(AuditEvent.action == action)

    rows = q.order_by(AuditEvent.created_at.desc()).offset(offset).limit(limit).all()
    return [_serialize(e) for e in rows]


def _serialize(e: AuditEvent) -> dict:
    extra: Any = None
    if e.extra_json:
        try:
            extra = json.loads(e.extra_json)
        except json.JSONDecodeError:
            extra = e.extra_json
    return {
        "id": str(e.id),
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "action": e.action,
        "entity_type": e.entity_type,
        "entity_id": str(e.entity_id) if e.entity_id else None,
        "org_id": str(e.org_id) if e.org_id else None,
        "actor_user_id": str(e.actor_user_id) if e.actor_user_id else None,
        "actor_email": e.actor_email,
        "request_id": e.request_id,
        "ip_address": e.ip_address,
        "extra": extra,
    }
