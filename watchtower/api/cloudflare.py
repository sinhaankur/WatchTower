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

from watchtower import cloudflare_dns
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import CloudflareCredential, CustomDomain, Project, get_db

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


# ── Phase 2: DNS sync for custom domains ──────────────────────────────────────


class CloudflareDnsSyncRequest(BaseModel):
    credential_id: UUID = Field(..., description="Which CloudflareCredential row to use.")
    target_ip: str = Field(..., min_length=4, description="IPv4 address the A record should point at.")
    proxied: bool = Field(False, description="Run traffic through Cloudflare proxy. Phase 2 leaves this off — Phase 3 LB integration flips it.")


class CloudflareDnsStatus(BaseModel):
    domain: str
    cloudflare_credential_id: Optional[UUID] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_record_id: Optional[str] = None
    cloudflare_target_ip: Optional[str] = None
    cloudflare_synced_at: Optional[datetime] = None


def _load_owned_domain(db: Session, project_id: UUID, domain_id: UUID, current_user: dict) -> CustomDomain:
    """Resolve a CustomDomain that belongs to a project the caller owns
    (or is a member of via canonical org). Mirrors how the rest of
    /api/projects/* gates access."""
    user, org = _resolve_org(db, current_user)
    project = (
        db.query(Project)
        .filter(Project.id == project_id)
        .filter((Project.owner_id == user.id) | (Project.org_id == org.id))
        .first()
    )
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found.")
    domain = (
        db.query(CustomDomain)
        .filter(CustomDomain.id == domain_id, CustomDomain.project_id == project.id)
        .first()
    )
    if not domain:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Domain not found on this project.")
    return domain


@router.post("/projects/{project_id}/domains/{domain_id}/sync", response_model=CloudflareDnsStatus)
async def sync_domain_to_cloudflare(
    project_id: UUID,
    domain_id: UUID,
    payload: CloudflareDnsSyncRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Create or update the Cloudflare A record for this CustomDomain.

    Idempotent — calling twice with the same target_ip results in one
    record. Stores the resulting zone_id + record_id back on the domain
    so subsequent syncs skip the zone-lookup roundtrip.
    """
    domain = _load_owned_domain(db, project_id, domain_id, current_user)

    cred = (
        db.query(CloudflareCredential)
        .filter(CloudflareCredential.id == payload.credential_id, CloudflareCredential.org_id == domain.project.org_id)
        .first()
    )
    if not cred:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cloudflare credential not found in this org.")

    plaintext = util.decrypt_secret(cred.api_token_encrypted)
    if not plaintext:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not decrypt stored Cloudflare token — WATCHTOWER_SECRET_KEY may have changed.",
        )

    try:
        result = cloudflare_dns.sync_a_record(
            plaintext,
            domain.domain,
            payload.target_ip,
            existing_zone_id=domain.cloudflare_zone_id,
            existing_record_id=domain.cloudflare_record_id,
            proxied=payload.proxied,
        )
    except cloudflare_dns.CloudflareDnsError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc

    domain.cloudflare_credential_id = cred.id
    domain.cloudflare_zone_id = result.zone_id
    domain.cloudflare_record_id = result.record_id
    domain.cloudflare_target_ip = result.target_ip
    domain.cloudflare_synced_at = datetime.now(timezone.utc).replace(tzinfo=None)

    audit_log.record_for_user(
        db, current_user,
        action="cloudflare.dns.sync",
        entity_type="custom_domain",
        entity_id=domain.id,
        org_id=domain.project.org_id,
        request=request,
        extra={
            "domain": domain.domain,
            "target_ip": payload.target_ip,
            "zone_id": result.zone_id,
            "credential_id": str(cred.id),
        },
    )
    db.commit()
    db.refresh(domain)
    return CloudflareDnsStatus(
        domain=domain.domain,
        cloudflare_credential_id=domain.cloudflare_credential_id,
        cloudflare_zone_id=domain.cloudflare_zone_id,
        cloudflare_record_id=domain.cloudflare_record_id,
        cloudflare_target_ip=domain.cloudflare_target_ip,
        cloudflare_synced_at=domain.cloudflare_synced_at,
    )


@router.post("/projects/{project_id}/domains/{domain_id}/unsync", response_model=CloudflareDnsStatus)
async def unsync_domain_from_cloudflare(
    project_id: UUID,
    domain_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Delete the A record from Cloudflare and clear the linked
    columns. Treats a missing-on-Cloudflare record as success (the
    desired end state is "no record")."""
    domain = _load_owned_domain(db, project_id, domain_id, current_user)
    if not domain.cloudflare_credential_id or not domain.cloudflare_record_id or not domain.cloudflare_zone_id:
        # Nothing to do — return current (empty) status. Idempotent.
        return CloudflareDnsStatus(domain=domain.domain)

    cred = db.query(CloudflareCredential).filter(CloudflareCredential.id == domain.cloudflare_credential_id).first()
    if cred:
        plaintext = util.decrypt_secret(cred.api_token_encrypted)
        if plaintext:
            try:
                cloudflare_dns.delete_a_record(plaintext, domain.cloudflare_zone_id, domain.cloudflare_record_id)
            except cloudflare_dns.CloudflareDnsError as exc:
                # Token revoked or zone gone — clear the columns anyway,
                # since the operator's intent is "stop managing this
                # record". They can re-sync after fixing the credential.
                logger.warning(
                    "Cloudflare unsync for domain %s failed (%s); clearing local link anyway.",
                    domain.domain, exc.detail,
                )

    audit_log.record_for_user(
        db, current_user,
        action="cloudflare.dns.unsync",
        entity_type="custom_domain",
        entity_id=domain.id,
        org_id=domain.project.org_id,
        request=request,
        extra={
            "domain": domain.domain,
            "zone_id": domain.cloudflare_zone_id,
            "record_id": domain.cloudflare_record_id,
        },
    )
    domain.cloudflare_credential_id = None
    domain.cloudflare_zone_id = None
    domain.cloudflare_record_id = None
    domain.cloudflare_target_ip = None
    domain.cloudflare_synced_at = None
    db.commit()
    db.refresh(domain)
    return CloudflareDnsStatus(domain=domain.domain)


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
