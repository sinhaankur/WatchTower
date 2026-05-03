"""Cloudflare integration — Phase 1: store + verify API tokens.

Phase 1 ships the foundation only:
  * `POST   /api/integrations/cloudflare`       — save a token (verifies it first)
  * `GET    /api/integrations/cloudflare`       — list creds for caller's org (token is NEVER returned)
  * `POST   /api/integrations/cloudflare/{id}/verify` — re-ping CF, refresh `last_verified_at`
  * `DELETE /api/integrations/cloudflare/{id}`  — remove a credential

Future phases will use these tokens to:
  * Phase 2: manage DNS A/AAAA records when a project gains a custom domain
  * Phase 3: provision a Cloudflare Load Balancer with primary/standby pool
              members so traffic fails over automatically
  * Phase 4: spin up Cloudflare Tunnel connectors per node so HA works
              for nodes behind NAT (home self-host)

Design notes:
  * Tokens stored encrypted via util.encrypt_secret (Fernet).
  * Verification calls Cloudflare's `/user/tokens/verify` then
    `/accounts` to capture the account_id + name. We only persist the
    *first* account the token is scoped to — multi-account tokens are
    rare and Phase 2+ will handle the per-zone scoping anyway.
  * Read responses NEVER include the plaintext token. The
    `account_name` + last 4 chars of the token id (NOT the secret) are
    enough for the operator to identify the row in the UI.
"""

import logging
from datetime import datetime, timezone
from typing import List, Optional
from uuid import UUID

import requests
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import CloudflareCredential, get_db

router = APIRouter(prefix="/api/integrations/cloudflare", tags=["Integrations"])
logger = logging.getLogger(__name__)

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"


# ── Schemas ───────────────────────────────────────────────────────────────────

class CloudflareCredentialCreate(BaseModel):
    api_token: str = Field(..., min_length=20, description="Cloudflare API token. Will be verified before save.")
    label: Optional[str] = Field(None, max_length=80, description="Operator-chosen label, e.g. 'Personal CF'.")


class CloudflareCredentialResponse(BaseModel):
    id: UUID
    label: Optional[str]
    account_id: Optional[str]
    account_name: Optional[str]
    last_verified_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class CloudflareVerifyResult(BaseModel):
    ok: bool
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    detail: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _verify_token(token: str) -> CloudflareVerifyResult:
    """Ping Cloudflare to confirm the token is live + capture account info.

    Two calls:
      1. ``GET /user/tokens/verify`` — fastest "is this token valid" check.
      2. ``GET /accounts`` — list accounts the token is scoped to so we
         can persist the friendly account_name. If the token isn't
         scoped to any account (rare but possible for some token
         templates) we still treat verification as ok — the row just
         carries account_id=None.

    Network errors map to ok=False with a human-readable detail; the
    handler turns that into a 4xx for the caller.
    """
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        resp = requests.get(f"{CLOUDFLARE_API_BASE}/user/tokens/verify", headers=headers, timeout=15)
    except requests.RequestException as exc:
        return CloudflareVerifyResult(ok=False, detail=f"Cloudflare unreachable: {exc}")

    if resp.status_code == 401 or resp.status_code == 403:
        return CloudflareVerifyResult(ok=False, detail="Token rejected by Cloudflare (invalid or expired).")
    if resp.status_code >= 400:
        return CloudflareVerifyResult(ok=False, detail=f"Cloudflare error {resp.status_code}: {resp.text[:200]}")

    body = resp.json() or {}
    if not body.get("success"):
        # Cloudflare uses success=false + errors[] even on 200s for some failures
        errs = "; ".join(e.get("message", "") for e in body.get("errors") or [])
        return CloudflareVerifyResult(ok=False, detail=errs or "Token verification failed.")

    # Capture account info best-effort — token may not be scoped to any
    # account (e.g. zone-only tokens), in which case we accept the
    # verification but record None.
    account_id = None
    account_name = None
    try:
        acc_resp = requests.get(f"{CLOUDFLARE_API_BASE}/accounts", headers=headers, timeout=15)
        if acc_resp.status_code < 400:
            acc_body = acc_resp.json() or {}
            results = acc_body.get("result") or []
            if results:
                account_id = results[0].get("id")
                account_name = results[0].get("name")
    except requests.RequestException:
        pass  # Non-fatal; verification already passed.

    return CloudflareVerifyResult(ok=True, account_id=account_id, account_name=account_name)


def _resolve_org(db: Session, current_user: dict):
    """Return the canonical org for the caller. Mirrors the pattern used
    by deployments / projects so per-org credentials live in the same
    blast radius as the resources that use them."""
    from watchtower.api.enterprise import _ensure_user_org_member
    _user, org, _member = _ensure_user_org_member(db, current_user)
    return _user, org


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("", response_model=CloudflareCredentialResponse, status_code=status.HTTP_201_CREATED)
async def create_cloudflare_credential(
    payload: CloudflareCredentialCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Save a Cloudflare API token after verifying it works.

    Verification is mandatory — saving an invalid token would surface
    only when Phase 2/3 features fire, which is the worst time to
    discover the credential is broken.
    """
    user, org = _resolve_org(db, current_user)

    verify = _verify_token(payload.api_token)
    if not verify.ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=verify.detail or "Token verification failed.",
        )

    encrypted = util.encrypt_secret(payload.api_token)
    if not encrypted:
        # encrypt_secret returns "" only if WATCHTOWER_SECRET_KEY is
        # missing AND cryptography is unavailable — unrecoverable.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Server cannot encrypt secrets — set WATCHTOWER_SECRET_KEY and restart.",
        )

    cred = CloudflareCredential(
        org_id=org.id,
        label=payload.label,
        account_id=verify.account_id,
        account_name=verify.account_name,
        api_token_encrypted=encrypted,
        last_verified_at=datetime.now(timezone.utc).replace(tzinfo=None),
        created_by_user_id=user.id,
    )
    db.add(cred)
    db.flush()
    audit_log.record_for_user(
        db, current_user,
        action="cloudflare.credential.create",
        entity_type="cloudflare_credential",
        entity_id=cred.id,
        org_id=org.id,
        request=request,
        extra={"label": payload.label, "account_id": verify.account_id},
    )
    db.commit()
    db.refresh(cred)
    return cred


@router.get("", response_model=List[CloudflareCredentialResponse])
async def list_cloudflare_credentials(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """List all Cloudflare credentials for the caller's org. Tokens are
    never returned — only the account info + verification timestamp."""
    _user, org = _resolve_org(db, current_user)
    rows = (
        db.query(CloudflareCredential)
        .filter(CloudflareCredential.org_id == org.id)
        .order_by(CloudflareCredential.created_at.desc())
        .all()
    )
    return rows


@router.post("/{cred_id}/verify", response_model=CloudflareCredentialResponse)
async def verify_cloudflare_credential(
    cred_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Re-ping Cloudflare for an existing credential and update
    last_verified_at + account fields. Useful after rotating a token
    or when Cloudflare reports auth errors during a deploy."""
    _user, org = _resolve_org(db, current_user)
    cred = (
        db.query(CloudflareCredential)
        .filter(CloudflareCredential.id == cred_id, CloudflareCredential.org_id == org.id)
        .first()
    )
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found.")

    plaintext = util.decrypt_secret(cred.api_token_encrypted)
    if not plaintext:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not decrypt stored token — WATCHTOWER_SECRET_KEY may have changed.",
        )

    verify = _verify_token(plaintext)
    if not verify.ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=verify.detail or "Verification failed.")

    cred.account_id = verify.account_id or cred.account_id
    cred.account_name = verify.account_name or cred.account_name
    cred.last_verified_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    db.refresh(cred)
    return cred


@router.delete("/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cloudflare_credential(
    cred_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Permanently delete a Cloudflare credential. Audited because
    losing the row also loses any DNS/LB/Tunnel automation it backed."""
    _user, org = _resolve_org(db, current_user)
    cred = (
        db.query(CloudflareCredential)
        .filter(CloudflareCredential.id == cred_id, CloudflareCredential.org_id == org.id)
        .first()
    )
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credential not found.")

    audit_log.record_for_user(
        db, current_user,
        action="cloudflare.credential.delete",
        entity_type="cloudflare_credential",
        entity_id=cred.id,
        org_id=org.id,
        request=request,
        extra={"label": cred.label, "account_id": cred.account_id},
    )
    db.delete(cred)
    db.commit()
    return None
