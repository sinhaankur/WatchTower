"""
GitHub Enterprise, Teams, and Node Management API endpoints
"""

import logging
import os
import hmac
import json
import base64
import hashlib
import subprocess
from urllib.parse import urlencode
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional
from uuid import UUID
from datetime import datetime
import requests

from watchtower.database import (
    get_db, Organization, User, GitHubConnection, TeamMember, OrgNode, InstallationClaim,
    NodeNetwork, NodeNetworkMember, Project, NodeStatus, TeamRole, GitHubProvider
)
from watchtower import schemas_enterprise as schemas
from watchtower.api import util

router = APIRouter(prefix="/api", tags=["Enterprise"])
logger = logging.getLogger(__name__)


def _owner_mode_enabled() -> bool:
    raw = os.getenv("WATCHTOWER_INSTALL_OWNER_MODE", "true").lower()
    return raw not in {"0", "false", "no", "off"}


@router.get("/auth/status")
async def auth_status():
    """Return current auth mode and OAuth readiness for UI diagnostics."""
    oauth_client_id = (
        os.getenv("GITHUB_OAUTH_CLIENT_ID")
        or os.getenv("GITHUB_CLIENT_ID")
    )
    oauth_client_secret = (
        os.getenv("GITHUB_OAUTH_CLIENT_SECRET")
        or os.getenv("GITHUB_CLIENT_SECRET")
    )
    api_token_set = bool(os.getenv("WATCHTOWER_API_TOKEN"))
    insecure_dev_auth = (
        os.getenv("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false").lower()
        == "true"
    )

    missing = []
    if not oauth_client_id:
        missing.append("GITHUB_OAUTH_CLIENT_ID or GITHUB_CLIENT_ID")
    if not oauth_client_secret:
        missing.append(
            "GITHUB_OAUTH_CLIENT_SECRET or GITHUB_CLIENT_SECRET"
        )

    return {
        "oauth": {
            "github_configured": bool(oauth_client_id and oauth_client_secret),
            "missing": missing,
        },
        "api_token": {
            "configured": api_token_set,
        },
        "dev_auth": {
            "allow_insecure": insecure_dev_auth,
        },
        "recommended": (
            "oauth"
            if oauth_client_id and oauth_client_secret
            else "api_token"
        ),
        "installation": {
            "owner_mode_enabled": _owner_mode_enabled(),
        },
    }


def _current_user_uuid(current_user: dict) -> UUID:
    return UUID(str(current_user["user_id"]))


def _role_value(role) -> str:
    return role.value if hasattr(role, "value") else str(role)


def _is_owner_or_admin(member: TeamMember) -> bool:
    return _role_value(member.role) in {"owner", "admin"}


def _get_installation_claim(db: Session) -> Optional[InstallationClaim]:
    return db.query(InstallationClaim).order_by(InstallationClaim.claimed_at.asc()).first()


def _claim_installation_if_needed(db: Session, user: User) -> Optional[InstallationClaim]:
    if not _owner_mode_enabled():
        return None

    claim = _get_installation_claim(db)
    if claim:
        return claim

    claim = InstallationClaim(
        owner_user_id=user.id,
        owner_github_id=user.github_id,
        owner_login=(user.name or user.email or "owner"),
    )
    db.add(claim)
    db.flush()
    return claim


def _ensure_user_org_member(db: Session, current_user: dict):
    user_id = _current_user_uuid(current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        # Fallback: look up by email to handle token changes between restarts
        email = current_user.get("email", "developer@watchtower.local")
        user = db.query(User).filter(User.email == email).first()
        if not user:
            user = User(
                id=user_id,
                email=email,
                name=current_user.get("name", "WatchTower Developer"),
                is_active=True,
            )
            db.add(user)
            db.flush()
        else:
            # Use the existing user's canonical ID for all ownership checks
            user_id = user.id

    if _owner_mode_enabled():
        claim = _claim_installation_if_needed(db, user)
        owner_user_id = claim.owner_user_id
        owner_user = db.query(User).filter(User.id == owner_user_id).first()

        org = db.query(Organization).filter(Organization.owner_id == owner_user_id).first()
        if not org:
            org_owner = owner_user or user
            org = Organization(name=f"{org_owner.name} Organization", owner_id=owner_user_id)
            db.add(org)
            db.flush()

        member = db.query(TeamMember).filter(
            TeamMember.org_id == org.id,
            TeamMember.user_id == user_id,
        ).first()

        if user_id == owner_user_id:
            if not member:
                member = TeamMember(
                    org_id=org.id,
                    user_id=user_id,
                    email=user.email,
                    role=TeamRole.OWNER,
                    can_create_projects=True,
                    can_manage_deployments=True,
                    can_manage_nodes=True,
                    can_manage_team=True,
                    is_active=True,
                )
                db.add(member)
                db.flush()
        else:
            if not member and user.email:
                member = db.query(TeamMember).filter(
                    TeamMember.org_id == org.id,
                    TeamMember.user_id.is_(None),
                    func.lower(TeamMember.email) == user.email.lower(),
                ).first()
                if member:
                    member.user_id = user_id
                    member.is_active = True
                    member.joined_at = member.joined_at or datetime.utcnow()
                    db.flush()

            if not member or not member.is_active:
                owner_label = claim.owner_login or "installation owner"
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=(
                        f"This WatchTower installation is owned by {owner_label}. "
                        "Ask an owner/admin to invite your account before accessing resources."
                    ),
                )

        db.commit()
        db.refresh(user)
        db.refresh(org)
        db.refresh(member)
        return user, org, member

    org = db.query(Organization).filter(Organization.owner_id == user_id).first()
    if not org:
        org = Organization(name=f"{user.name} Organization", owner_id=user_id)
        db.add(org)
        db.flush()

    member = db.query(TeamMember).filter(
        TeamMember.org_id == org.id,
        TeamMember.user_id == user_id,
    ).first()
    if not member:
        member = TeamMember(
            org_id=org.id,
            user_id=user_id,
            email=user.email,
            role=TeamRole.OWNER,
            can_create_projects=True,
            can_manage_deployments=True,
            can_manage_nodes=True,
            can_manage_team=True,
            is_active=True,
        )
        db.add(member)
        db.flush()

    db.commit()
    db.refresh(user)
    db.refresh(org)
    db.refresh(member)
    return user, org, member


def _oauth_state_secret() -> str:
    secret = (
        os.getenv("WATCHTOWER_OAUTH_STATE_SECRET")
        or os.getenv("WATCHTOWER_API_TOKEN")
    )
    if not secret:
        if os.getenv("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false").lower() == "true":
            import secrets as _secrets
            secret = _secrets.token_hex(32)
            os.environ["WATCHTOWER_OAUTH_STATE_SECRET"] = secret
        else:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="OAuth state signing key is not configured.",
            )
    return secret


def _sign_oauth_state(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    sig = hmac.new(_oauth_state_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest().encode("utf-8")
    return base64.urlsafe_b64encode(raw + b"." + sig).decode("utf-8")


def _parse_oauth_state(state: str) -> dict:
    try:
        decoded = base64.urlsafe_b64decode(state.encode("utf-8"))
        raw, sig = decoded.rsplit(b".", 1)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state") from exc

    expected = hmac.new(_oauth_state_secret().encode("utf-8"), raw, hashlib.sha256).hexdigest().encode("utf-8")
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state signature")

    payload = json.loads(raw.decode("utf-8"))
    issued = int(payload.get("iat", 0))
    if int(datetime.utcnow().timestamp()) - issued > 900:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth state expired")
    return payload


def _resolve_github_oauth_endpoints(provider: schemas.GitHubProvider, enterprise_url: Optional[str]):
    if provider == schemas.GitHubProvider.GITHUB_ENTERPRISE:
        if not enterprise_url:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="enterprise_url is required")
        base = enterprise_url.rstrip("/")
        return {
            "authorize_url": f"{base}/login/oauth/authorize",
            "token_url": f"{base}/login/oauth/access_token",
            "user_url": f"{base}/api/v3/user",
            "client_id": os.getenv("GITHUB_ENTERPRISE_CLIENT_ID") or os.getenv("GITHUB_OAUTH_CLIENT_ID") or os.getenv("GITHUB_CLIENT_ID"),
            "client_secret": os.getenv("GITHUB_ENTERPRISE_CLIENT_SECRET") or os.getenv("GITHUB_OAUTH_CLIENT_SECRET") or os.getenv("GITHUB_CLIENT_SECRET"),
        }

    return {
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "user_url": "https://api.github.com/user",
        "client_id": os.getenv("GITHUB_OAUTH_CLIENT_ID") or os.getenv("GITHUB_CLIENT_ID"),
        "client_secret": os.getenv("GITHUB_OAUTH_CLIENT_SECRET") or os.getenv("GITHUB_CLIENT_SECRET"),
    }


def _upsert_user_from_github_profile(db: Session, profile: dict):
    github_id = profile.get("id")
    if github_id is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="GitHub profile missing id")

    login = profile.get("login") or "github-user"
    email = profile.get("email") or f"{login}@users.noreply.github.com"
    name = profile.get("name") or login

    user = db.query(User).filter(User.github_id == github_id).first()
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        user.github_id = github_id
        user.email = email
        user.name = name
        user.is_active = True
        db.flush()
        return user

    user = User(
        email=email,
        github_id=github_id,
        name=name,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _ensure_owner_membership(db: Session, user: User):
    if _owner_mode_enabled():
        claim = _claim_installation_if_needed(db, user)
        if claim.owner_user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the installation owner can create owner membership.",
            )

    org = db.query(Organization).filter(Organization.owner_id == user.id).first()
    if not org:
        org = Organization(name=f"{user.name} Organization", owner_id=user.id)
        db.add(org)
        db.flush()

    member = db.query(TeamMember).filter(
        TeamMember.org_id == org.id,
        TeamMember.user_id == user.id,
    ).first()
    if not member:
        member = TeamMember(
            org_id=org.id,
            user_id=user.id,
            email=user.email,
            role=TeamRole.OWNER,
            can_create_projects=True,
            can_manage_deployments=True,
            can_manage_nodes=True,
            can_manage_team=True,
            is_active=True,
        )
        db.add(member)
        db.flush()

    return org


def _perform_ssh_health_check(node: OrgNode):
    if not node.ssh_key_path:
        raise RuntimeError("SSH key path is not configured")

    remote_cmd = (
        "cpu=$(top -bn1 | awk '/Cpu\\(s\\)/ {print int($2 + $4)}');"
        "mem=$(free | awk '/Mem:/ {print int(($3/$2)*100)}');"
        "disk=$(df -P / | awk 'NR==2 {gsub(\"%\",\"\",$5); print int($5)}');"
        "echo cpu=$cpu mem=$mem disk=$disk"
    )
    ssh_cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        "-i", node.ssh_key_path,
        "-p", str(node.port),
        f"{node.user}@{node.host}",
        "sh",
        "-lc",
        remote_cmd,
    ]
    completed = subprocess.run(ssh_cmd, check=True, capture_output=True, text=True, timeout=15)
    metrics = {"cpu": 0, "mem": 0, "disk": 0}
    for token in completed.stdout.strip().split():
        if "=" not in token:
            continue
        key, value = token.split("=", 1)
        if key in metrics:
            try:
                metrics[key] = int(value)
            except ValueError:
                metrics[key] = 0

    return {
        "status": NodeStatus.HEALTHY,
        "cpu_usage": metrics["cpu"],
        "memory_usage": metrics["mem"],
        "disk_usage": metrics["disk"],
    }


@router.get("/context")
async def get_enterprise_context(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Return the current user/org context used by team and node screens."""
    user, org, member = _ensure_user_org_member(db, current_user)
    claim = _get_installation_claim(db)
    primary_connection = db.query(GitHubConnection).filter(
        GitHubConnection.org_id == org.id,
        GitHubConnection.is_active == True,
    ).order_by(GitHubConnection.is_primary.desc(), GitHubConnection.created_at.desc()).first()

    return {
        "user": {
            "id": str(user.id),
            "email": user.email,
            "name": user.name,
        },
        "organization": {
            "id": str(org.id),
            "name": org.name,
        },
        "membership": {
            "id": str(member.id),
            "role": member.role.value if hasattr(member.role, "value") else str(member.role),
            "can_manage_team": member.can_manage_team,
            "can_manage_nodes": member.can_manage_nodes,
            "can_manage_deployments": member.can_manage_deployments,
        },
        "installation": {
            "owner_mode_enabled": _owner_mode_enabled(),
            "is_claimed": bool(claim),
            "owner_user_id": str(claim.owner_user_id) if claim else None,
            "owner_login": claim.owner_login if claim else None,
            "is_owner": bool(claim and claim.owner_user_id == user.id),
        },
        "github_connection": {
            "connected": bool(primary_connection),
            "provider": primary_connection.provider.value if primary_connection else None,
            "github_username": primary_connection.github_username if primary_connection else None,
            "managed_by_user_id": str(primary_connection.user_id) if primary_connection else None,
            "last_synced": primary_connection.last_synced if primary_connection else None,
        },
    }


@router.get("/auth/ownership", response_model=schemas.InstallationOwnerResponse)
async def get_installation_ownership(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    user, _org, _member = _ensure_user_org_member(db, current_user)
    claim = _get_installation_claim(db)
    return {
        "owner_user_id": claim.owner_user_id if claim else None,
        "owner_login": claim.owner_login if claim else None,
        "owner_github_id": claim.owner_github_id if claim else None,
        "claimed_at": claim.claimed_at if claim else None,
        "github_connected_at": claim.github_connected_at if claim else None,
        "is_claimed": bool(claim),
        "is_owner": bool(claim and claim.owner_user_id == user.id),
        "owner_mode_enabled": _owner_mode_enabled(),
    }


@router.get("/auth/github/managed-status")
async def get_managed_github_status(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    user, org, _member = _ensure_user_org_member(db, current_user)
    connection = db.query(GitHubConnection).filter(
        GitHubConnection.org_id == org.id,
        GitHubConnection.is_active == True,
    ).order_by(GitHubConnection.is_primary.desc(), GitHubConnection.created_at.desc()).first()
    return {
        "connected": bool(connection),
        "org_id": str(org.id),
        "provider": connection.provider.value if connection else None,
        "github_username": connection.github_username if connection else None,
        "connected_by_user_id": str(connection.user_id) if connection else None,
        "is_connected_by_current_user": bool(connection and connection.user_id == user.id),
        "last_synced": connection.last_synced if connection else None,
    }


@router.get("/auth/github/start")
async def start_github_login_oauth(
    redirect_uri: str,
    next_path: Optional[str] = None,
):
    """Generate OAuth authorize URL for GitHub login."""
    oauth = _resolve_github_oauth_endpoints(schemas.GitHubProvider.GITHUB_COM, None)
    if not oauth["client_id"]:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OAuth client id not configured")

    effective_next = next_path or "/"
    if not effective_next.startswith("/") or effective_next.startswith("//"):
        effective_next = "/"

    state = _sign_oauth_state(
        {
            "mode": "login",
            "provider": schemas.GitHubProvider.GITHUB_COM.value,
            "next": effective_next,
            "iat": int(datetime.utcnow().timestamp()),
        }
    )

    params = {
        "client_id": oauth["client_id"],
        "redirect_uri": redirect_uri,
        "scope": "read:user user:email",
        "state": state,
    }

    return {
        "authorize_url": f"{oauth['authorize_url']}?{urlencode(params)}",
        "state": state,
        "next": effective_next,
    }


@router.get("/auth/github/login")
async def redirect_github_login_oauth(
    redirect_uri: str,
    next_path: Optional[str] = None,
):
    """Redirect directly to GitHub authorization for browser-first login."""
    payload = await start_github_login_oauth(redirect_uri=redirect_uri, next_path=next_path)
    return RedirectResponse(url=payload["authorize_url"], status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.post("/auth/github/callback")
async def github_login_oauth_callback(
    payload: schemas.GitHubOAuthCallback,
    db: Session = Depends(get_db),
):
    """Exchange OAuth code and return a signed WatchTower session token."""
    state_data = _parse_oauth_state(payload.state)
    if state_data.get("mode") != "login":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth login state")

    oauth = _resolve_github_oauth_endpoints(schemas.GitHubProvider.GITHUB_COM, None)
    if not oauth["client_id"] or not oauth["client_secret"]:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OAuth client is not configured")

    token_resp = requests.post(
        oauth["token_url"],
        headers={"Accept": "application/json"},
        data={
            "client_id": oauth["client_id"],
            "client_secret": oauth["client_secret"],
            "code": payload.code,
            "redirect_uri": payload.redirect_uri,
        },
        timeout=15,
    )
    if token_resp.status_code >= 400:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth token exchange failed")

    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth token not returned by provider")

    profile_resp = requests.get(
        oauth["user_url"],
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    if profile_resp.status_code >= 400:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to fetch GitHub user profile")

    profile = profile_resp.json()
    user = _upsert_user_from_github_profile(db, profile)
    user_payload = {
        "user_id": str(user.id),
        "email": user.email,
        "name": user.name,
    }
    user, org, _member = _ensure_user_org_member(db, user_payload)

    session_token = util.create_user_session_token(
        user_id=str(user.id),
        email=user.email,
        name=user.name,
        github_id=user.github_id,
    )

    return {
        "token": session_token,
        "redirect_to": state_data.get("next") or "/",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "name": user.name,
        },
        "organization": {
            "id": str(org.id),
            "name": org.name,
        },
    }


@router.get("/github/oauth/start")
async def start_github_oauth(
    org_id: UUID,
    provider: schemas.GitHubProvider = schemas.GitHubProvider.GITHUB_COM,
    enterprise_url: Optional[str] = None,
    redirect_uri: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Generate OAuth authorize URL for GitHub.com or GitHub Enterprise."""
    _ensure_user_org_member(db, current_user)
    oauth = _resolve_github_oauth_endpoints(provider, enterprise_url)
    if not oauth["client_id"]:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OAuth client id not configured")

    effective_redirect = redirect_uri or os.getenv("GITHUB_OAUTH_REDIRECT_URI")
    if not effective_redirect:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OAuth redirect URI not configured")

    state = _sign_oauth_state(
        {
            "org_id": str(org_id),
            "provider": provider.value,
            "enterprise_url": enterprise_url,
            "iat": int(datetime.utcnow().timestamp()),
        }
    )

    params = {
        "client_id": oauth["client_id"],
        "redirect_uri": effective_redirect,
        "scope": "read:user repo",
        "state": state,
    }

    return {
        "authorize_url": f"{oauth['authorize_url']}?{urlencode(params)}",
        "state": state,
        "provider": provider.value,
    }


@router.post("/github/oauth/callback", response_model=schemas.GitHubConnectionResponse)
async def github_oauth_callback(
    payload: schemas.GitHubOAuthCallback,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Exchange OAuth code and persist GitHub connection for the organization."""
    state_data = _parse_oauth_state(payload.state)
    org_id = UUID(state_data["org_id"])
    provider = schemas.GitHubProvider(state_data["provider"])
    enterprise_url = state_data.get("enterprise_url")
    user_id = _current_user_uuid(current_user)

    _ensure_user_org_member(db, current_user)
    oauth = _resolve_github_oauth_endpoints(provider, enterprise_url)
    if not oauth["client_id"] or not oauth["client_secret"]:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="OAuth client is not configured")

    token_resp = requests.post(
        oauth["token_url"],
        headers={"Accept": "application/json"},
        data={
            "client_id": oauth["client_id"],
            "client_secret": oauth["client_secret"],
            "code": payload.code,
            "redirect_uri": payload.redirect_uri or os.getenv("GITHUB_OAUTH_REDIRECT_URI"),
        },
        timeout=15,
    )
    if token_resp.status_code >= 400:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth token exchange failed")

    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth token not returned by provider")

    profile_resp = requests.get(
        oauth["user_url"],
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    if profile_resp.status_code >= 400:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to fetch GitHub user profile")

    profile = profile_resp.json()
    github_username = profile.get("login") or current_user.get("name", "github-user")

    existing = db.query(GitHubConnection).filter(
        GitHubConnection.org_id == org_id,
        GitHubConnection.user_id == user_id,
        GitHubConnection.provider == (
            GitHubProvider.GITHUB_ENTERPRISE
            if provider == schemas.GitHubProvider.GITHUB_ENTERPRISE
            else GitHubProvider.GITHUB_COM
        ),
    ).first()

    if existing:
        existing.github_username = github_username
        existing.github_access_token = util.encrypt_secret(access_token)
        existing.enterprise_url = enterprise_url
        existing.enterprise_name = payload.enterprise_name
        existing.is_active = True
        existing.last_synced = datetime.utcnow()
        claim = _get_installation_claim(db)
        if claim and claim.owner_user_id == user_id:
            owner_user = db.query(User).filter(User.id == user_id).first()
            claim.owner_github_id = owner_user.github_id if owner_user else None
            claim.owner_login = github_username
            claim.github_connected_at = datetime.utcnow()
        db.commit()
        db.refresh(existing)
        return existing

    connection = GitHubConnection(
        user_id=user_id,
        org_id=org_id,
        provider=(
            GitHubProvider.GITHUB_ENTERPRISE
            if provider == schemas.GitHubProvider.GITHUB_ENTERPRISE
            else GitHubProvider.GITHUB_COM
        ),
        github_username=github_username,
        github_access_token=util.encrypt_secret(access_token),
        enterprise_url=enterprise_url,
        enterprise_name=payload.enterprise_name,
        is_primary=True,
        is_active=True,
        last_synced=datetime.utcnow(),
    )
    db.add(connection)
    claim = _get_installation_claim(db)
    if claim and claim.owner_user_id == user_id:
        owner_user = db.query(User).filter(User.id == user_id).first()
        claim.owner_github_id = owner_user.github_id if owner_user else None
        claim.owner_login = github_username
        claim.github_connected_at = datetime.utcnow()
    db.commit()
    db.refresh(connection)
    return connection


# ============================================================================
# GitHub Enterprise Endpoints
# ============================================================================

@router.get("/orgs/{org_id}/github-connections", response_model=List[schemas.GitHubConnectionResponse])
async def list_github_connections(
    org_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List GitHub connections for organization"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    
    # Check permissions
    member = db.query(TeamMember).filter(
        TeamMember.org_id == org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    
    connections = db.query(GitHubConnection).filter(
        GitHubConnection.org_id == org_id
    ).all()
    
    return connections


@router.post("/orgs/{org_id}/github-connections", response_model=schemas.GitHubConnectionResponse, status_code=status.HTTP_201_CREATED)
async def add_github_connection(
    org_id: UUID,
    connection_data: schemas.GitHubConnectionCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Add GitHub/Enterprise connection to organization"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    
    # Check permissions (only admins/owners)
    member = db.query(TeamMember).filter(
        TeamMember.org_id == org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not member or not _is_owner_or_admin(member):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can add connections")
    
    try:
        connection = GitHubConnection(
            user_id=user_id,
            org_id=org_id,
            provider=connection_data.provider,
            github_username=connection_data.github_username,
            github_access_token=util.encrypt_secret(connection_data.github_access_token),
            enterprise_url=connection_data.enterprise_url,
            enterprise_name=connection_data.enterprise_name,
            is_primary=connection_data.is_primary
        )
        
        db.add(connection)
        db.commit()
        db.refresh(connection)
        
        return connection
    except Exception:
        db.rollback()
        logger.exception("Adding GitHub connection failed")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to add GitHub connection")


@router.put("/github-connections/{connection_id}", response_model=schemas.GitHubConnectionResponse)
async def update_github_connection(
    connection_id: UUID,
    update_data: schemas.GitHubConnectionUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Update GitHub connection"""
    user_id = _current_user_uuid(current_user)
    connection = db.query(GitHubConnection).filter(
        GitHubConnection.id == connection_id,
        GitHubConnection.user_id == user_id
    ).first()
    
    if not connection:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    
    if update_data.is_primary:
        connection.is_primary = update_data.is_primary
    if update_data.is_active is not None:
        connection.is_active = update_data.is_active
    
    db.commit()
    db.refresh(connection)
    return connection


@router.delete("/github-connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_github_connection(
    connection_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Delete GitHub connection"""
    user_id = _current_user_uuid(current_user)
    connection = db.query(GitHubConnection).filter(
        GitHubConnection.id == connection_id,
        GitHubConnection.user_id == user_id
    ).first()
    
    if not connection:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Connection not found")
    
    db.delete(connection)
    db.commit()


# ============================================================================
# Team Management Endpoints
# ============================================================================

@router.get("/orgs/{org_id}/team-members", response_model=List[schemas.TeamMemberResponse])
async def list_team_members(
    org_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List team members"""
    _ensure_user_org_member(db, current_user)
    members = db.query(TeamMember).filter(TeamMember.org_id == org_id).all()
    return members


@router.post("/orgs/{org_id}/team-members", response_model=schemas.TeamMemberResponse, status_code=status.HTTP_201_CREATED)
async def invite_team_member(
    org_id: UUID,
    member_data: schemas.TeamMemberCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Invite user to team"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    # Check permissions
    current_member = db.query(TeamMember).filter(
        TeamMember.org_id == org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not current_member or not _is_owner_or_admin(current_member):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can invite members")
    
    try:
        new_member = TeamMember(
            org_id=org_id,
            email=member_data.email,
            role=member_data.role,
            can_create_projects=member_data.can_create_projects,
            can_manage_deployments=member_data.can_manage_deployments,
            can_manage_nodes=member_data.can_manage_nodes,
            can_manage_team=member_data.can_manage_team,
            invited_at=datetime.utcnow()
        )
        
        db.add(new_member)
        db.commit()
        db.refresh(new_member)
        
        # TODO: Send email invitation
        
        return new_member
    except Exception:
        db.rollback()
        logger.exception("Inviting team member failed")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to invite team member")


@router.put("/team-members/{member_id}", response_model=schemas.TeamMemberResponse)
async def update_team_member(
    member_id: UUID,
    update_data: schemas.TeamMemberUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Update team member permissions"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    member = db.query(TeamMember).filter(TeamMember.id == member_id).first()
    
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    
    # Check permissions
    current_member = db.query(TeamMember).filter(
        TeamMember.org_id == member.org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not current_member or not _is_owner_or_admin(current_member):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can update members")
    
    # Update fields
    if update_data.role:
        member.role = update_data.role
    if update_data.can_create_projects is not None:
        member.can_create_projects = update_data.can_create_projects
    if update_data.can_manage_deployments is not None:
        member.can_manage_deployments = update_data.can_manage_deployments
    if update_data.can_manage_nodes is not None:
        member.can_manage_nodes = update_data.can_manage_nodes
    if update_data.can_manage_team is not None:
        member.can_manage_team = update_data.can_manage_team
    if update_data.is_active is not None:
        member.is_active = update_data.is_active
    
    db.commit()
    db.refresh(member)
    return member


# ============================================================================
# Node Management Endpoints
# ============================================================================

@router.get("/orgs/{org_id}/nodes", response_model=List[schemas.OrgNodeResponse])
async def list_org_nodes(
    org_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List deployment nodes for organization"""
    _ensure_user_org_member(db, current_user)
    nodes = db.query(OrgNode).filter(OrgNode.org_id == org_id).all()
    return nodes


@router.post("/orgs/{org_id}/nodes", response_model=schemas.OrgNodeResponse, status_code=status.HTTP_201_CREATED)
async def add_org_node(
    org_id: UUID,
    node_data: schemas.OrgNodeCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Add deployment node to organization"""
    user_id = _current_user_uuid(current_user)
    _user, canonical_org, member = _ensure_user_org_member(db, current_user)

    # Resolve the target org: if the caller passed their canonical org_id use
    # the member we already resolved; otherwise look up a separate membership.
    if org_id != canonical_org.id:
        member = db.query(TeamMember).filter(
            TeamMember.org_id == org_id,
            TeamMember.user_id == _user.id,
        ).first()

    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    
    try:
        node = OrgNode(
            org_id=org_id,
            name=node_data.name,
            host=node_data.host,
            user=node_data.user,
            port=node_data.port,
            remote_path=node_data.remote_path,
            ssh_key_path=node_data.ssh_key_path,
            reload_command=node_data.reload_command,
            is_primary=node_data.is_primary,
            max_concurrent_deployments=node_data.max_concurrent_deployments,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
        )
        
        db.add(node)
        db.commit()
        db.refresh(node)

        # Test SSH connectivity and record initial health status
        from watchtower.builder import check_ssh_connectivity
        from watchtower.database import NodeStatus
        ssh_ok, ssh_msg = check_ssh_connectivity(node)
        if ssh_ok:
            node.status = NodeStatus.HEALTHY
        else:
            node.status = NodeStatus.UNREACHABLE
            logger.warning("SSH health check failed for new node %s: %s", node.host, ssh_msg)
        node.status_message = ssh_msg
        db.commit()
        db.refresh(node)

        return node
    except Exception:
        db.rollback()
        logger.exception("Adding org node failed")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to add deployment node")


@router.put("/org-nodes/{node_id}", response_model=schemas.OrgNodeResponse)
async def update_org_node(
    node_id: UUID,
    update_data: schemas.OrgNodeUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Update deployment node"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    node = db.query(OrgNode).filter(OrgNode.id == node_id).first()
    
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")
    
    # Check permissions
    member = db.query(TeamMember).filter(
        TeamMember.org_id == node.org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    
    # Update fields
    if update_data.name:
        node.name = update_data.name
    if update_data.host:
        node.host = update_data.host
    if update_data.port:
        node.port = update_data.port
    if update_data.remote_path:
        node.remote_path = update_data.remote_path
    if update_data.reload_command:
        node.reload_command = update_data.reload_command
    if update_data.is_primary is not None:
        node.is_primary = update_data.is_primary
    if update_data.max_concurrent_deployments:
        node.max_concurrent_deployments = update_data.max_concurrent_deployments
    if update_data.is_active is not None:
        node.is_active = update_data.is_active
    node.updated_by_user_id = user_id
    
    db.commit()
    db.refresh(node)
    return node


@router.get("/org-nodes/{node_id}/health")
async def check_node_health(
    node_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Check node health status"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    node = db.query(OrgNode).filter(OrgNode.id == node_id).first()
    
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")
    
    member = db.query(TeamMember).filter(
        TeamMember.org_id == node.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    now = datetime.utcnow()
    try:
        health = _perform_ssh_health_check(node)
        node.status = health["status"]
        node.cpu_usage = health["cpu_usage"]
        node.memory_usage = health["memory_usage"]
        node.disk_usage = health["disk_usage"]
        node.last_health_check = now
        db.commit()
        db.refresh(node)
    except Exception:
        logger.exception("Node health check failed for %s", node.id)
        node.status = NodeStatus.OFFLINE
        node.last_health_check = now
        db.commit()
        db.refresh(node)

    return {
        "node_id": str(node_id),
        "status": node.status.value if hasattr(node.status, "value") else str(node.status),
        "last_check": node.last_health_check,
        "cpu_usage": node.cpu_usage,
        "memory_usage": node.memory_usage,
        "disk_usage": node.disk_usage
    }


# ============================================================================
# Node Network Endpoints
# ============================================================================

@router.get("/orgs/{org_id}/node-networks", response_model=List[schemas.NodeNetworkResponse])
async def list_node_networks(
    org_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """List node networks for organization"""
    _ensure_user_org_member(db, current_user)
    networks = db.query(NodeNetwork).filter(NodeNetwork.org_id == org_id).all()
    return networks


@router.post("/orgs/{org_id}/node-networks", response_model=schemas.NodeNetworkResponse, status_code=status.HTTP_201_CREATED)
async def create_node_network(
    org_id: UUID,
    network_data: schemas.NodeNetworkCreate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Create node network"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    # Check permissions
    member = db.query(TeamMember).filter(
        TeamMember.org_id == org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    
    try:
        network = NodeNetwork(
            org_id=org_id,
            name=network_data.name,
            description=network_data.description,
            environment=network_data.environment,
            is_default=network_data.is_default,
            load_balance=network_data.load_balance,
            health_check_interval=network_data.health_check_interval
        )
        
        db.add(network)
        db.commit()
        db.refresh(network)
        
        return network
    except Exception:
        db.rollback()
        logger.exception("Creating node network failed")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to create node network")


@router.post("/node-networks/{network_id}/nodes", response_model=schemas.NodeNetworkResponse)
async def add_node_to_network(
    network_id: UUID,
    member_data: schemas.NodeNetworkMemberAdd,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Add node to network"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    network = db.query(NodeNetwork).filter(NodeNetwork.id == network_id).first()
    
    if not network:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Network not found")
    
    # Check permissions
    member = db.query(TeamMember).filter(
        TeamMember.org_id == network.org_id,
        TeamMember.user_id == user_id
    ).first()
    
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    
    try:
        net_member = NodeNetworkMember(
            node_id=member_data.node_id,
            network_id=network_id,
            priority=member_data.priority,
            weight=member_data.weight
        )
        
        db.add(net_member)
        db.commit()
        db.refresh(network)
        
        return network
    except Exception:
        db.rollback()
        logger.exception("Adding node to network failed")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to add node to network")
