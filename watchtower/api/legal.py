"""Legal documents + click-through acceptance.

Three endpoints back the login acceptance gate:

  * ``GET /api/legal/documents`` — the canonical Terms of Use,
    Acceptable Use Policy, and Privacy Policy (markdown) plus the
    current ``terms_version``. Deliberately auth-gated like the rest of
    /api/* — the SPA's login page shows its own static consent line, and
    the gate renders post-auth.
  * ``GET /api/legal/status`` — has the current user accepted the
    current version? The SPA blocks the app behind the gate until true.
  * ``POST /api/legal/accept`` — record acceptance. Append-only: every
    acceptance is a new ``LegalAcceptance`` row (user, version,
    timestamp, IP) and an audit-log event, so there is an evidentiary
    trail that this user agreed to this version at this time.

Version bumps in watchtower/legal_docs.py automatically re-gate every
user: ``status`` only counts rows matching the *current* version.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower import legal_docs
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import LegalAcceptance, get_db

router = APIRouter(prefix="/api/legal", tags=["Legal"])
logger = logging.getLogger(__name__)


class AcceptRequest(BaseModel):
    # The SPA echoes back the version it displayed. Refusing a stale
    # echo prevents "accepted v1 while v2 was current" ambiguity when a
    # tab predates a server upgrade.
    terms_version: str


@router.get("/documents")
async def get_documents(_user: dict = Depends(util.get_current_user)) -> Dict[str, Any]:
    return {
        "terms_version": legal_docs.TERMS_VERSION,
        "effective_date": legal_docs.TERMS_EFFECTIVE_DATE,
        "documents": legal_docs.DOCUMENTS,
    }


@router.get("/status")
async def acceptance_status(
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    user_id = util.canonical_user_id(db, current_user)
    row = (
        db.query(LegalAcceptance)
        .filter(
            LegalAcceptance.user_id == user_id,
            LegalAcceptance.terms_version == legal_docs.TERMS_VERSION,
        )
        .order_by(LegalAcceptance.accepted_at.desc())
        .first()
    )
    return {
        "terms_version": legal_docs.TERMS_VERSION,
        "accepted": row is not None,
        "accepted_at": row.accepted_at.isoformat() if row else None,
    }


@router.post("/accept")
async def accept_terms(
    req: AcceptRequest,
    request: Request,
    current_user: dict = Depends(util.get_current_user),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if req.terms_version != legal_docs.TERMS_VERSION:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"The documents were updated (you viewed {req.terms_version!r}, "
                f"current is {legal_docs.TERMS_VERSION!r}). Reload and review the "
                f"current version."
            ),
        )

    # Materialise the User row first — first-ever request from a fresh
    # token may not have one yet, and the acceptance row FKs users.id.
    from watchtower.api.enterprise import _ensure_user_org_member

    user, _org, _member = _ensure_user_org_member(db, current_user)
    user_id = user.id
    ip = request.client.host if request.client else None
    db.add(LegalAcceptance(
        user_id=user_id,
        user_email=current_user.get("email"),
        terms_version=legal_docs.TERMS_VERSION,
        ip_address=ip,
    ))
    audit_log.record_for_user(
        db, current_user,
        action="legal.accept",
        entity_type="legal_terms",
        request=request,
        extra={"terms_version": legal_docs.TERMS_VERSION},
    )
    db.commit()
    logger.info("legal: user %s accepted terms v%s", user_id, legal_docs.TERMS_VERSION)
    return {"accepted": True, "terms_version": legal_docs.TERMS_VERSION}
