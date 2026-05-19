"""Phase 5 step 1: CRUD + verify for cloud-provider credentials
(DigitalOcean, Hetzner). The orchestrator that *uses* these to
provision VMs lands in step 2; shipping the credential surface
separately means an operator can save + verify their token before any
"provision a node" UI exists, and we get to validate token storage in
production before stacking the orchestrator on top.

The credential model mirrors CloudflareCredential (Fernet-encrypted at
rest, plaintext only at use-time). Org membership is enforced via the
same _ensure_user_org_member dependency the rest of the org-scoped
surface uses.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from watchtower import cloud_providers as providers
from watchtower import provisioning as provisioning_orchestrator
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import CloudProviderCredential, ProvisioningJob, get_db


logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/api/integrations/cloud-providers",
    tags=["Integrations"],
)


# ── Schemas ─────────────────────────────────────────────────────────────────


class CloudProviderCredentialCreate(BaseModel):
    provider: str = Field(..., description="One of: digitalocean, hetzner")
    api_token: str = Field(..., min_length=10, description="API token from the provider. Treated like a password; encrypted at rest.")
    label: Optional[str] = Field(None, max_length=255)


class CloudProviderCredentialResponse(BaseModel):
    id: UUID
    org_id: UUID
    provider: str
    label: Optional[str]
    account_email: Optional[str]
    last_verified_at: Optional[datetime]
    created_at: datetime
    # api_token never surfaces — write-only on create.

    model_config = ConfigDict(from_attributes=True)


class VerifyResponse(BaseModel):
    ok: bool
    account_email: Optional[str] = None
    error: Optional[str] = None


class RegionItem(BaseModel):
    id: str
    name: str


class SizeItem(BaseModel):
    id: str
    vcpus: int
    memory_gb: float
    monthly_usd: Optional[float] = None


class ProvisionRequest(BaseModel):
    credential_id: UUID = Field(..., description="Which saved provider credential to use.")
    name: str = Field(..., min_length=1, max_length=63, description="Hostname-safe name for the VM.")
    region: str = Field(..., min_length=1, description="Provider-native region id (e.g., 'nyc3' for DO).")
    size: str = Field(..., min_length=1, description="Provider-native size/server-type id.")


class ProvisioningJobResponse(BaseModel):
    id: UUID
    org_id: UUID
    provider: str
    region: str
    size: str
    name: str
    status: str
    error: Optional[str]
    provider_resource_id: Optional[str]
    public_ipv4: Optional[str]
    node_id: Optional[UUID]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Helpers ─────────────────────────────────────────────────────────────────


def _resolve_org(db: Session, current_user: dict):
    """Same shape as cloudflare.py's helper — both surfaces are
    org-scoped via canonical membership. Returning the org row keeps
    every handler from importing _ensure_user_org_member directly."""
    from watchtower.api.enterprise import _ensure_user_org_member
    user, org, _member = _ensure_user_org_member(db, current_user)
    return user, org


def _load_owned_credential(
    db: Session, cred_id: UUID, current_user: dict
) -> CloudProviderCredential:
    _user, org = _resolve_org(db, current_user)
    cred = (
        db.query(CloudProviderCredential)
        .filter(
            CloudProviderCredential.id == cred_id,
            CloudProviderCredential.org_id == org.id,
        )
        .first()
    )
    if not cred:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cloud provider credential not found in this org.",
        )
    return cred


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── Endpoints ───────────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=CloudProviderCredentialResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_credential(
    payload: CloudProviderCredentialCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Store a new provider token (encrypted). Verifies the token by
    calling the provider's account/SSH-keys endpoint first; rejects with
    a 400 if the provider says it's invalid, so we never persist a
    known-bad credential.
    """
    user, org = _resolve_org(db, current_user)
    provider_key = payload.provider.lower().strip()
    if provider_key not in providers.SUPPORTED_PROVIDERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported provider: {payload.provider!r}. Supported: {', '.join(providers.SUPPORTED_PROVIDERS)}.",
        )

    provider = providers.get_provider(provider_key)
    result = provider.verify_token(payload.api_token)
    if not result.ok:
        # Surface the provider's error so the operator can fix their
        # token, not a generic "verification failed".
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result.error or "Token verification failed.",
        )

    cred = CloudProviderCredential(
        org_id=org.id,
        provider=provider_key,
        label=(payload.label or "").strip() or None,
        api_token_encrypted=util.encrypt_secret(payload.api_token),
        account_email=result.account_email,
        last_verified_at=_now(),
        created_by_user_id=user.id,
    )
    db.add(cred)
    db.flush()
    audit_log.record_for_user(
        db, current_user,
        action="cloud_provider.credential.create",
        entity_type="cloud_provider_credential",
        entity_id=cred.id,
        org_id=org.id,
        request=request,
        # NEVER log api_token — even hashed. Only metadata.
        extra={"provider": provider_key, "account_email": result.account_email},
    )
    db.commit()
    db.refresh(cred)
    return cred


@router.get("", response_model=List[CloudProviderCredentialResponse])
async def list_credentials(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    _user, org = _resolve_org(db, current_user)
    rows = (
        db.query(CloudProviderCredential)
        .filter(CloudProviderCredential.org_id == org.id)
        .order_by(CloudProviderCredential.created_at.desc())
        .all()
    )
    return rows


@router.post("/{cred_id}/verify", response_model=VerifyResponse)
async def reverify(
    cred_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Re-test an existing credential — usually called when the operator
    wants to confirm "did my token still work after I rotated my
    provider settings?". Stamps last_verified_at on success."""
    cred = _load_owned_credential(db, cred_id, current_user)
    token = util.decrypt_secret(cred.api_token_encrypted)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not decrypt stored token — WATCHTOWER_SECRET_KEY may have changed.",
        )
    provider = providers.get_provider(cred.provider)
    result = provider.verify_token(token)
    if result.ok:
        cred.last_verified_at = _now()
        if result.account_email and cred.account_email != result.account_email:
            cred.account_email = result.account_email
        db.commit()
    return VerifyResponse(ok=result.ok, account_email=result.account_email, error=result.error)


@router.get("/{cred_id}/regions", response_model=List[RegionItem])
async def list_regions(
    cred_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Surface the provider's list of regions, scoped to this credential.
    Lets the UI populate the region dropdown without having to know the
    provider's id scheme."""
    cred = _load_owned_credential(db, cred_id, current_user)
    token = util.decrypt_secret(cred.api_token_encrypted)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not decrypt stored token.",
        )
    try:
        regions = providers.get_provider(cred.provider).list_regions(token)
    except providers.ProviderError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return [RegionItem(id=r.id, name=r.name) for r in regions]


@router.get("/{cred_id}/sizes", response_model=List[SizeItem])
async def list_sizes(
    cred_id: UUID,
    region: str,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    cred = _load_owned_credential(db, cred_id, current_user)
    token = util.decrypt_secret(cred.api_token_encrypted)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not decrypt stored token.",
        )
    try:
        sizes = providers.get_provider(cred.provider).list_sizes(token, region)
    except providers.ProviderError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return [
        SizeItem(id=s.id, vcpus=s.vcpus, memory_gb=s.memory_gb, monthly_usd=s.monthly_usd)
        for s in sizes
    ]


@router.post("/provision", response_model=ProvisioningJobResponse, status_code=status.HTTP_202_ACCEPTED)
async def provision_node(
    payload: ProvisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Phase 5 step 2: kick off an auto-provision job. Returns 202 with
    the new ProvisioningJob — the UI polls ``GET /provisioning-jobs/{id}``
    until it reaches a terminal state (registered or failed). The actual
    VM creation, prep-script run, and node registration happens in an
    asyncio task spawned from this handler."""
    user, org = _resolve_org(db, current_user)
    cred = _load_owned_credential(db, payload.credential_id, current_user)

    # Sanity-check the name early so a hostname like "my server" with a
    # space doesn't propagate down to the SSH-and-bind-mount layer where
    # the failure mode is way less obvious.
    name = payload.name.strip()
    if not name.replace("-", "").replace("_", "").isalnum():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Name must be alphanumeric (with hyphens/underscores allowed).",
        )

    job = ProvisioningJob(
        org_id=org.id,
        provider_credential_id=cred.id,
        provider=cred.provider,
        region=payload.region.strip(),
        size=payload.size.strip(),
        name=name,
        status="queued",
        created_by_user_id=user.id,
    )
    db.add(job)
    db.flush()
    audit_log.record_for_user(
        db, current_user,
        action="cloud_provider.node.provision",
        entity_type="provisioning_job",
        entity_id=job.id,
        org_id=org.id,
        request=request,
        extra={
            "provider": cred.provider,
            "region": job.region,
            "size": job.size,
            "name": job.name,
        },
    )
    db.commit()
    db.refresh(job)

    # Spawn the background worker. Fire-and-forget on the request loop.
    provisioning_orchestrator.enqueue(job)
    return job


@router.get("/provisioning-jobs/{job_id}", response_model=ProvisioningJobResponse)
async def get_provisioning_job(
    job_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """UI polls this every second or so. Org-scoped — no leaking jobs
    across orgs."""
    _user, org = _resolve_org(db, current_user)
    job = (
        db.query(ProvisioningJob)
        .filter(ProvisioningJob.id == job_id, ProvisioningJob.org_id == org.id)
        .first()
    )
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Provisioning job not found.")
    return job


@router.get("/provisioning-jobs", response_model=List[ProvisioningJobResponse])
async def list_provisioning_jobs(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Recent provision history for the caller's org, newest first."""
    _user, org = _resolve_org(db, current_user)
    rows = (
        db.query(ProvisioningJob)
        .filter(ProvisioningJob.org_id == org.id)
        .order_by(ProvisioningJob.created_at.desc())
        .limit(50)
        .all()
    )
    return rows


@router.delete("/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    cred = _load_owned_credential(db, cred_id, current_user)
    cred_provider = cred.provider
    cred_org_id = cred.org_id
    audit_log.record_for_user(
        db, current_user,
        action="cloud_provider.credential.delete",
        entity_type="cloud_provider_credential",
        entity_id=cred.id,
        org_id=cred_org_id,
        request=request,
        extra={"provider": cred_provider},
    )
    db.delete(cred)
    db.commit()
    return None
