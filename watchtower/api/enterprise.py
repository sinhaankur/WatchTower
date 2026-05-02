"""
GitHub Enterprise, Teams, and Node Management API endpoints
"""

import logging
import os
import hmac
import json
import base64
import hashlib
import smtplib
import subprocess
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from urllib.parse import urlencode
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional
import uuid as uuid_module
from uuid import UUID
from datetime import datetime
import requests

from watchtower.database import (
    get_db, Organization, User, GitHubConnection, TeamMember, OrgNode, InstallationClaim,
    NodeNetwork, NodeNetworkMember, Project, NodeStatus, TeamRole, GitHubProvider,
    GitHubDeviceConnectSession,
)
from watchtower import schemas_enterprise as schemas
from watchtower.api import util
from watchtower.api.rate_limit import limiter

router = APIRouter(prefix="/api", tags=["Enterprise"])
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Email helpers
# ---------------------------------------------------------------------------

def _send_invitation_email(
    to_email: str,
    org_name: str,
    role: str,
    inviter_name: str,
) -> None:
    """Send a team-invitation email via SMTP.

    Reads configuration from environment variables:
      WATCHTOWER_SMTP_HOST     — SMTP server hostname (required to send)
      WATCHTOWER_SMTP_PORT     — port, default 587
      WATCHTOWER_SMTP_USER     — login username (optional for local relays)
      WATCHTOWER_SMTP_PASSWORD — login password (optional for local relays)
      WATCHTOWER_SMTP_FROM     — From address, default noreply@watchtower.local
      WATCHTOWER_APP_URL       — base URL shown in the invitation link

    If ``WATCHTOWER_SMTP_HOST`` is not set, the function logs a warning and
    returns without raising — callers should still complete the DB write.
    """
    smtp_host = os.getenv("WATCHTOWER_SMTP_HOST")
    if not smtp_host:
        logger.warning(
            "Team invitation email NOT sent to %s — WATCHTOWER_SMTP_HOST is unset. "
            "Set WATCHTOWER_SMTP_HOST (and optionally WATCHTOWER_SMTP_PORT / "
            "WATCHTOWER_SMTP_USER / WATCHTOWER_SMTP_PASSWORD) to enable email.",
            to_email,
        )
        return

    smtp_port = int(os.getenv("WATCHTOWER_SMTP_PORT", "587"))
    smtp_user = os.getenv("WATCHTOWER_SMTP_USER", "")
    smtp_password = os.getenv("WATCHTOWER_SMTP_PASSWORD", "")
    from_addr = os.getenv("WATCHTOWER_SMTP_FROM", "noreply@watchtower.local")
    app_url = os.getenv("WATCHTOWER_APP_URL", "http://localhost:8000").rstrip("/")

    login_link = f"{app_url}/login"

    subject = f"You've been invited to join {org_name} on WatchTower"
    body_text = (
        f"Hi,\n\n"
        f"{inviter_name} has invited you to join the organization \"{org_name}\" "
        f"on WatchTower as a {role}.\n\n"
        f"To accept the invitation, sign in here:\n{login_link}\n\n"
        f"If you did not expect this invitation, you can safely ignore this email.\n\n"
        f"— The WatchTower Team"
    )
    body_html = (
        f"<p>Hi,</p>"
        f"<p><strong>{inviter_name}</strong> has invited you to join the organization "
        f"<strong>{org_name}</strong> on WatchTower as a <em>{role}</em>.</p>"
        f"<p><a href=\"{login_link}\">Accept invitation &rarr;</a></p>"
        f"<p>If you did not expect this invitation, you can safely ignore this email.</p>"
        f"<p>&mdash; The WatchTower Team</p>"
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_email
    msg.attach(MIMEText(body_text, "plain"))
    msg.attach(MIMEText(body_html, "html"))

    try:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as server:
            server.ehlo()
            if smtp_port != 25:
                server.starttls()
                server.ehlo()
            if smtp_user and smtp_password:
                server.login(smtp_user, smtp_password)
            server.sendmail(from_addr, [to_email], msg.as_string())
        logger.info("Invitation email sent to %s for org %s", to_email, org_name)
    except Exception:
        # Non-fatal — the DB record was already committed, the user can be
        # notified out-of-band. Log at ERROR so operators notice.
        logger.exception(
            "Failed to send invitation email to %s (SMTP %s:%s)",
            to_email,
            smtp_host,
            smtp_port,
        )




def _owner_mode_enabled() -> bool:
    raw = os.getenv("WATCHTOWER_INSTALL_OWNER_MODE", "true").lower()
    return raw not in {"0", "false", "no", "off"}


# Public OAuth Client ID baked into shipped builds. Users do NOT need to
# register their own OAuth app — they only need to authorize this one via
# GitHub Device Flow (no client secret required).
# Override with WATCHTOWER_GITHUB_DEVICE_CLIENT_ID env var if you publish
# your own fork. The Client ID is intentionally public — it's safe to embed.
DEFAULT_DEVICE_CLIENT_ID = ""  # set in shipped builds, or via env


def _device_flow_client_id() -> Optional[str]:
    """Resolve the Client ID used for GitHub Device Flow (no secret needed)."""
    return (
        os.getenv("WATCHTOWER_GITHUB_DEVICE_CLIENT_ID")
        or os.getenv("GITHUB_OAUTH_CLIENT_ID")
        or os.getenv("GITHUB_CLIENT_ID")
        or DEFAULT_DEVICE_CLIENT_ID
        or None
    )


_GUEST_NAMESPACE = uuid_module.UUID("a85f1e64-5f3b-4db8-9c1a-9f7c2c5b0001")
_GUEST_EMAIL = "guest@watchtower.local"
_GUEST_NAME = "Guest"


def _guest_mode_enabled() -> bool:
    """Guest mode is on by default. Operators of shared instances should
    set ``WATCHTOWER_ALLOW_GUEST_MODE=false`` to disable.

    The threat model: a guest gets a signed session token tied to a
    shared local user. They cannot register remote nodes, manage other
    users, or do anything that requires GitHub identity (private repo
    access, OAuth-gated org claims). Anything bound to GitHub identity
    will reject them naturally because ``github_id`` is None.
    """
    return os.getenv("WATCHTOWER_ALLOW_GUEST_MODE", "true").lower() != "false"


@router.post("/auth/guest")
@limiter.limit("10/minute")
async def auth_guest(request: Request):
    """Issue a signed session token for an anonymous "Guest" identity.

    Lets users into the app without a GitHub login. Guest sessions can
    browse, build local projects, and manage their local environment,
    but the frontend (and node-creation route below) gates remote-node
    creation on a real GitHub-authenticated identity.

    Rate-limited at 10/minute per IP. Without a limit an attacker can
    cheaply mint unlimited valid signed tokens, burn HMAC CPU, and
    inflate the audit table for every guest action they then perform.
    """
    if not _guest_mode_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Guest mode is disabled on this server. "
                "Sign in with GitHub or use an API token instead."
            ),
        )

    # Stable, deterministic user_id so a guest's projects survive across
    # repeated "Continue as Guest" clicks. All guests on a single instance
    # share this identity — appropriate for the single-user desktop
    # context where guest mode is meaningful.
    guest_uid = str(uuid_module.uuid5(_GUEST_NAMESPACE, _GUEST_EMAIL))
    token = util.create_user_session_token(
        user_id=guest_uid,
        email=_GUEST_EMAIL,
        name=_GUEST_NAME,
        github_id=None,
    )
    return {
        "token": token,
        "user": {
            "user_id": guest_uid,
            "email": _GUEST_EMAIL,
            "name": _GUEST_NAME,
            "is_guest": True,
        },
    }


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
    device_client_id = _device_flow_client_id()

    missing = []
    if not oauth_client_id:
        missing.append("GITHUB_OAUTH_CLIENT_ID or GITHUB_CLIENT_ID")
    if not oauth_client_secret:
        missing.append(
            "GITHUB_OAUTH_CLIENT_SECRET or GITHUB_CLIENT_SECRET"
        )

    device_flow_ready = bool(device_client_id)

    return {
        "oauth": {
            "github_configured": bool(oauth_client_id and oauth_client_secret),
            "missing": missing,
        },
        "device_flow": {
            "github_configured": device_flow_ready,
        },
        "api_token": {
            "configured": api_token_set,
        },
        "dev_auth": {
            "allow_insecure": insecure_dev_auth,
        },
        "recommended": (
            "device_flow"
            if device_flow_ready
            else ("oauth" if oauth_client_id and oauth_client_secret else "api_token")
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
                # Backfill permissions for owner rows created before these
                # columns existed (e.g. after a schema migration).
                changed = False
                if not member.can_manage_nodes:
                    member.can_manage_nodes = True
                    changed = True
                if not member.can_create_projects:
                    member.can_create_projects = True
                    changed = True
                if not member.can_manage_deployments:
                    member.can_manage_deployments = True
                    changed = True
                if not member.can_manage_team:
                    member.can_manage_team = True
                    changed = True
                if changed:
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
    else:
        # Backfill permissions for owner rows created before these columns
        # existed (e.g. after a schema migration or first-run upgrade).
        changed = False
        for attr in ("can_manage_nodes", "can_create_projects",
                     "can_manage_deployments", "can_manage_team"):
            if not getattr(member, attr, False):
                setattr(member, attr, True)
                changed = True
        if changed:
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
        # SSRF guard: the enterprise_url is user-controlled and is later used
        # in server-side requests.post()/get(); reject http(s)://localhost,
        # link-local, private RFC1918 ranges, etc. Bypass only via the
        # explicit WATCHTOWER_ALLOW_INTERNAL_HTTP=true env var.
        from . import util as _util
        _util.assert_safe_external_url(enterprise_url)
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
    # Capture the avatar so the SPA's identity badge can render it instead
    # of the initial-letter placeholder. Refresh on every login so a user
    # who changes their GitHub avatar sees the new one within one session.
    avatar_url = profile.get("avatar_url") or None

    user = db.query(User).filter(User.github_id == github_id).first()
    if not user:
        user = db.query(User).filter(User.email == email).first()

    if user:
        user.github_id = github_id
        user.email = email
        user.name = name
        user.avatar_url = avatar_url
        user.is_active = True
        db.flush()
        return user

    user = User(
        email=email,
        github_id=github_id,
        name=name,
        avatar_url=avatar_url,
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
    # For local nodes, check via HTTP instead of SSH
    if node.host in ("127.0.0.1", "localhost", "::1"):
        import urllib.request
        try:
            with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5) as resp:
                if resp.status == 200:
                    return {
                        "status": NodeStatus.HEALTHY,
                        "cpu_usage": None,
                        "memory_usage": None,
                        "disk_usage": None,
                    }
        except Exception:
            pass
        return {
            "status": NodeStatus.OFFLINE,
            "cpu_usage": None,
            "memory_usage": None,
            "disk_usage": None,
        }

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
@limiter.limit("20/minute")
async def redirect_github_login_oauth(
    request: Request,  # for slowapi key extraction
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
        avatar_url=user.avatar_url,
    )

    return {
        "token": session_token,
        "redirect_to": state_data.get("next") or "/",
        "user": {
            "id": str(user.id),
            "email": user.email,
            "name": user.name,
            "avatar_url": user.avatar_url,
        },
        "organization": {
            "id": str(org.id),
            "name": org.name,
        },
    }


# ---------------------------------------------------------------------------
# GitHub Device Flow (no client secret required, no callback URL required).
# Recommended for shipped desktop apps — works exactly like `gh auth login`.
# Users do NOT register their own OAuth app; the publisher embeds one public
# Client ID and every install of WatchTower uses it.
# ---------------------------------------------------------------------------

@router.post("/auth/github/device/start")
@limiter.limit("20/minute")
async def start_github_device_flow(request: Request):
    """Begin GitHub Device Flow. Returns a user code + verification URL."""
    client_id = _device_flow_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "GitHub Device Flow client id is not configured. Set "
                "WATCHTOWER_GITHUB_DEVICE_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID."
            ),
        )

    try:
        resp = requests.post(
            "https://github.com/login/device/code",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "scope": "read:user user:email repo",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to reach GitHub device endpoint",
        ) from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GitHub device endpoint error: {resp.text[:200]}",
        )

    data = resp.json()
    return {
        "device_code": data.get("device_code"),
        "user_code": data.get("user_code"),
        "verification_uri": data.get("verification_uri"),
        "verification_uri_complete": data.get("verification_uri_complete"),
        "expires_in": data.get("expires_in", 900),
        "interval": max(int(data.get("interval", 5)), 1),
    }


class _DevicePollPayload:
    pass


from pydantic import BaseModel as _PydBaseModel  # local import to avoid top-level churn


class DevicePollRequest(_PydBaseModel):
    device_code: str


class DeviceConnectStartRequest(_PydBaseModel):
    org_id: UUID


class DeviceConnectPollRequest(_PydBaseModel):
    device_code: str


def _fetch_github_profile_with_email(access_token: str) -> dict:
    profile_resp = requests.get(
        "https://api.github.com/user",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    if profile_resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to fetch GitHub user profile",
        )

    profile = profile_resp.json()
    if profile.get("email"):
        return profile

    # Backfill primary verified email if hidden in public profile.
    try:
        emails_resp = requests.get(
            "https://api.github.com/user/emails",
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {access_token}",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=10,
        )
        if emails_resp.ok:
            emails = emails_resp.json() or []
            primary = next(
                (e for e in emails if e.get("primary") and e.get("verified")),
                next((e for e in emails if e.get("verified")), None),
            )
            if primary and primary.get("email"):
                profile["email"] = primary["email"]
    except requests.RequestException:
        pass

    return profile


@router.post("/github/device/connect/start")
@limiter.limit("20/minute")
async def start_github_device_connect(
    request: Request,
    payload: DeviceConnectStartRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Begin GitHub Device Flow for repository connection (org-scoped token storage)."""
    _user, org, _member = _ensure_user_org_member(db, current_user)
    if org.id != payload.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot connect GitHub for a different organization.",
        )

    client_id = _device_flow_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "GitHub Device Flow client id is not configured. Set "
                "WATCHTOWER_GITHUB_DEVICE_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID."
            ),
        )

    try:
        resp = requests.post(
            "https://github.com/login/device/code",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "scope": "read:user user:email repo",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to reach GitHub device endpoint",
        ) from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"GitHub device endpoint error: {resp.text[:200]}",
        )

    data = resp.json()
    device_code = data.get("device_code")
    if not device_code:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="GitHub did not return a device_code",
        )

    now = datetime.utcnow()
    expires_in = int(data.get("expires_in", 900))

    # Clean up expired sessions opportunistically.
    db.query(GitHubDeviceConnectSession).filter(
        GitHubDeviceConnectSession.expires_at < now,
    ).delete(synchronize_session=False)

    # Upsert by device_code so retries are idempotent.
    existing_session = db.query(GitHubDeviceConnectSession).filter(
        GitHubDeviceConnectSession.device_code == device_code,
    ).first()
    if existing_session:
        existing_session.user_id = _current_user_uuid(current_user)
        existing_session.org_id = payload.org_id
        existing_session.created_at = now
        existing_session.expires_at = datetime.utcfromtimestamp(now.timestamp() + expires_in)
    else:
        db.add(GitHubDeviceConnectSession(
            device_code=device_code,
            user_id=_current_user_uuid(current_user),
            org_id=payload.org_id,
            created_at=now,
            expires_at=datetime.utcfromtimestamp(now.timestamp() + expires_in),
        ))
    db.commit()

    return {
        "device_code": device_code,
        "user_code": data.get("user_code"),
        "verification_uri": data.get("verification_uri"),
        "verification_uri_complete": data.get("verification_uri_complete"),
        "expires_in": expires_in,
        "interval": max(int(data.get("interval", 5)), 1),
    }


@router.post("/github/device/connect/poll")
@limiter.limit("120/minute")
async def poll_github_device_connect(
    request: Request,
    payload: DeviceConnectPollRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Poll GitHub device flow and persist org-scoped GitHub connection on success."""
    now = datetime.utcnow()
    # Clean up expired sessions opportunistically.
    db.query(GitHubDeviceConnectSession).filter(
        GitHubDeviceConnectSession.expires_at < now,
    ).delete(synchronize_session=False)
    db.commit()

    session = db.query(GitHubDeviceConnectSession).filter(
        GitHubDeviceConnectSession.device_code == payload.device_code,
    ).first()
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown or expired device flow session.",
        )

    current_uid = str(_current_user_uuid(current_user))
    if str(session.user_id) != current_uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This device flow session belongs to a different user.",
        )

    if session.expires_at < now:
        db.delete(session)
        db.commit()
        return {"status": "expired_token"}

    client_id = _device_flow_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GitHub Device Flow client id is not configured.",
        )

    try:
        resp = requests.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "device_code": payload.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to reach GitHub token endpoint",
        ) from exc

    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    error = data.get("error")
    if error:
        return {"status": error, "interval": data.get("interval")}

    access_token = data.get("access_token")
    if not access_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GitHub did not return an access token",
        )

    profile = _fetch_github_profile_with_email(access_token)
    github_username = profile.get("login") or current_user.get("name", "github-user")

    _user, org, _member = _ensure_user_org_member(db, current_user)
    if str(org.id) != str(session.org_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organization context changed during device flow.",
        )

    existing = db.query(GitHubConnection).filter(
        GitHubConnection.org_id == org.id,
        GitHubConnection.user_id == _current_user_uuid(current_user),
        GitHubConnection.provider == GitHubProvider.GITHUB_COM,
    ).first()

    if existing:
        existing.github_username = github_username
        existing.github_access_token = util.encrypt_secret(access_token)
        existing.enterprise_url = None
        existing.enterprise_name = None
        existing.is_active = True
        existing.is_primary = True
        existing.last_synced = datetime.utcnow()
        db.delete(session)
        db.commit()
        db.refresh(existing)
        return {
            "status": "success",
            "github_username": existing.github_username,
            "org_id": str(org.id),
        }

    connection = GitHubConnection(
        user_id=_current_user_uuid(current_user),
        org_id=org.id,
        provider=GitHubProvider.GITHUB_COM,
        github_username=github_username,
        github_access_token=util.encrypt_secret(access_token),
        enterprise_url=None,
        enterprise_name=None,
        is_primary=True,
        is_active=True,
        last_synced=datetime.utcnow(),
    )
    db.add(connection)
    db.delete(session)
    db.commit()
    db.refresh(connection)
    return {
        "status": "success",
        "github_username": connection.github_username,
        "org_id": str(org.id),
    }


@router.post("/auth/github/device/poll")
@limiter.limit("120/minute")  # legitimate clients poll every 5s = 12/min; 10x margin
async def poll_github_device_flow(
    request: Request,
    payload: DevicePollRequest,
    db: Session = Depends(get_db),
):
    """Poll GitHub for device flow completion. Returns a session token on success."""
    client_id = _device_flow_client_id()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="GitHub Device Flow client id is not configured.",
        )

    try:
        resp = requests.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": client_id,
                "device_code": payload.device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to reach GitHub token endpoint",
        ) from exc

    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    error = data.get("error")
    if error:
        # authorization_pending / slow_down / expired_token / access_denied
        return {"status": error, "interval": data.get("interval")}

    access_token = data.get("access_token")
    if not access_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="GitHub did not return an access token",
        )

    profile_resp = requests.get(
        "https://api.github.com/user",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    if profile_resp.status_code >= 400:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to fetch GitHub user profile",
        )
    profile = profile_resp.json()

    # Try to fetch a primary verified email if the public profile didn't expose one
    if not profile.get("email"):
        try:
            emails_resp = requests.get(
                "https://api.github.com/user/emails",
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {access_token}",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                timeout=10,
            )
            if emails_resp.ok:
                emails = emails_resp.json() or []
                primary = next(
                    (e for e in emails if e.get("primary") and e.get("verified")),
                    next((e for e in emails if e.get("verified")), None),
                )
                if primary and primary.get("email"):
                    profile["email"] = primary["email"]
        except requests.RequestException:
            pass

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
        avatar_url=user.avatar_url,
    )

    return {
        "status": "success",
        "token": session_token,
        "user": {
            "id": str(user.id),
            "email": user.email,
            "name": user.name,
            "github_login": profile.get("login"),
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
    next_path: Optional[str] = None,
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

    effective_next = next_path or "/team"
    if not effective_next.startswith("/") or effective_next.startswith("//"):
        effective_next = "/team"

    state = _sign_oauth_state(
        {
            "org_id": str(org_id),
            "provider": provider.value,
            "enterprise_url": enterprise_url,
            "next": effective_next,
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


@router.post("/github/oauth/callback")
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
    redirect_to = state_data.get("next", "/team")
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
        return {"redirect_to": redirect_to, **schemas.GitHubConnectionResponse.model_validate(existing).model_dump()}

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
    return {"redirect_to": redirect_to, **schemas.GitHubConnectionResponse.model_validate(connection).model_dump()}


# ============================================================================
# GitHub User Repos / Orgs (for wizard repo picker)
# ============================================================================

@router.get("/github/user/repos")
async def list_github_user_repos(
    org: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    per_page: int = 30,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """List GitHub repositories accessible to the current user's active GitHub connection."""
    _user, org_entity, _ = _ensure_user_org_member(db, current_user)
    connection = (
        db.query(GitHubConnection)
        .filter(
            GitHubConnection.org_id == org_entity.id,
            GitHubConnection.is_active == True,
        )
        .order_by(GitHubConnection.is_primary.desc(), GitHubConnection.created_at.desc())
        .first()
    )
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active GitHub connection found. Connect GitHub first via Team settings.",
        )

    try:
        token = util.decrypt_secret(connection.github_access_token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not decrypt GitHub token. Reconnect GitHub.",
        )

    base_url = connection.enterprise_url.rstrip("/") if connection.enterprise_url else "https://api.github.com"
    # Defence-in-depth: a stored enterprise_url could pre-date the SSRF
    # validation added at connection creation. Re-check here before any
    # outbound request so legacy rows can't pivot to internal services.
    util.assert_safe_external_url(base_url)
    api_url = f"{base_url}/orgs/{org}/repos" if org else f"{base_url}/user/repos"

    resp = requests.get(
        api_url,
        params={"sort": "updated", "per_page": min(per_page, 100), "page": max(page, 1), "type": "all"},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=15,
    )
    if resp.status_code == 401:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="GitHub token expired. Reconnect GitHub.")
    if resp.status_code >= 400:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="GitHub API error listing repositories.")

    repos = resp.json()
    if search:
        q = search.lower()
        repos = [r for r in repos if q in r.get("name", "").lower() or q in (r.get("description") or "").lower()]

    return [
        {
            "id": r["id"],
            "name": r["name"],
            "full_name": r["full_name"],
            "html_url": r["html_url"],
            "description": r.get("description"),
            "private": r.get("private", False),
            "default_branch": r.get("default_branch", "main"),
            "updated_at": r.get("updated_at"),
        }
        for r in repos
    ]


@router.get("/github/user/orgs")
async def list_github_user_orgs(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """List GitHub user profile and organizations accessible via the active connection."""
    _user, org_entity, _ = _ensure_user_org_member(db, current_user)
    connection = (
        db.query(GitHubConnection)
        .filter(
            GitHubConnection.org_id == org_entity.id,
            GitHubConnection.is_active == True,
        )
        .order_by(GitHubConnection.is_primary.desc(), GitHubConnection.created_at.desc())
        .first()
    )
    if not connection:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active GitHub connection found.",
        )

    try:
        token = util.decrypt_secret(connection.github_access_token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not decrypt GitHub token.",
        )

    base_url = connection.enterprise_url.rstrip("/") if connection.enterprise_url else "https://api.github.com"
    util.assert_safe_external_url(base_url)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    result: list[dict] = []

    user_resp = requests.get(f"{base_url}/user", headers=headers, timeout=15)
    if user_resp.status_code == 200:
        profile = user_resp.json()
        result.append({"login": profile["login"], "avatar_url": profile.get("avatar_url"), "type": "user"})

    orgs_resp = requests.get(f"{base_url}/user/orgs", params={"per_page": 100}, headers=headers, timeout=15)
    if orgs_resp.status_code == 200:
        for o in orgs_resp.json():
            result.append({"login": o["login"], "avatar_url": o.get("avatar_url"), "type": "organization"})

    return result


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

        # Resolve org name and inviter display name for the email.
        org = db.query(Organization).filter(Organization.id == org_id).first()
        org_name = org.name if org else str(org_id)
        inviter_name = current_user.get("name") or current_user.get("email") or "A WatchTower admin"
        _send_invitation_email(
            to_email=member_data.email,
            org_name=org_name,
            role=member_data.role.value if hasattr(member_data.role, "value") else str(member_data.role),
            inviter_name=inviter_name,
        )

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

    # Guest sessions can browse + manage local resources but cannot register
    # remote SSH nodes. Detect guest by the guest email sentinel rather than
    # by "lacks github_id" — the latter also blocks legitimate API-token
    # operators (who never go through GitHub but ARE the server's owner).
    # Enforce server-side too so direct API calls don't bypass the UI gate.
    if current_user.get("email") == _GUEST_EMAIL:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Guest mode can't add remote deployment servers. "
                "Sign in with GitHub OAuth, GitHub Device Flow, or your "
                "server's API token to continue."
            ),
        )

    # Resolve the target org: if the caller passed their canonical org_id use
    # the member we already resolved; otherwise look up a separate membership.
    if org_id != canonical_org.id:
        member = db.query(TeamMember).filter(
            TeamMember.org_id == org_id,
            TeamMember.user_id == _user.id,
        ).first()

    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")
    
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

    try:
        db.add(node)
        db.commit()
        db.refresh(node)
    except Exception:
        db.rollback()
        logger.exception("DB error persisting org node")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error — could not save deployment node.",
        )

    # Test SSH connectivity and record initial health status.
    # A failed SSH check does NOT prevent the node from being registered —
    # the node is saved with status UNREACHABLE so the user can fix it later.
    try:
        from watchtower.builder import check_ssh_connectivity
        from watchtower.database import NodeStatus
        ssh_ok, ssh_msg = check_ssh_connectivity(node)
        node.status = NodeStatus.HEALTHY if ssh_ok else NodeStatus.UNREACHABLE
        if not ssh_ok:
            logger.warning("SSH health check failed for new node %s: %s", node.host, ssh_msg)
        node.status_message = ssh_msg
        db.commit()
        db.refresh(node)
    except Exception:
        # SSH check failure must never prevent the node from being returned.
        logger.exception("SSH health check raised an exception for node %s", node.host)
        db.rollback()

    return node


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


@router.delete("/org-nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_org_node(
    node_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """Delete a deployment node"""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    node = db.query(OrgNode).filter(OrgNode.id == node_id).first()

    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")

    member = db.query(TeamMember).filter(
        TeamMember.org_id == node.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    db.delete(node)
    db.commit()


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


@router.put("/node-networks/{network_id}", response_model=schemas.NodeNetworkResponse)
async def update_node_network(
    network_id: UUID,
    update_data: schemas.NodeNetworkUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Update node network settings."""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    network = db.query(NodeNetwork).filter(NodeNetwork.id == network_id).first()
    if not network:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Network not found")

    member = db.query(TeamMember).filter(
        TeamMember.org_id == network.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    if update_data.name is not None:
        network.name = update_data.name
    if update_data.description is not None:
        network.description = update_data.description
    if update_data.is_default is not None:
        network.is_default = update_data.is_default
    if update_data.load_balance is not None:
        network.load_balance = update_data.load_balance
    if update_data.health_check_interval is not None:
        network.health_check_interval = update_data.health_check_interval

    db.commit()
    db.refresh(network)
    return network


@router.delete("/node-networks/{network_id}", status_code=204)
async def delete_node_network(
    network_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Delete a node network and all its member associations."""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    network = db.query(NodeNetwork).filter(NodeNetwork.id == network_id).first()
    if not network:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Network not found")

    member = db.query(TeamMember).filter(
        TeamMember.org_id == network.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    db.query(NodeNetworkMember).filter(NodeNetworkMember.network_id == network_id).delete()
    db.delete(network)
    db.commit()
    logger.info("Node network %s deleted", network_id)
    return None


@router.put("/node-networks/{network_id}/nodes/{node_id}", response_model=schemas.NodeNetworkResponse)
async def update_node_in_network(
    network_id: UUID,
    node_id: UUID,
    update_data: schemas.NodeNetworkMemberUpdate,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Update a node's priority/weight within a network."""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    network = db.query(NodeNetwork).filter(NodeNetwork.id == network_id).first()
    if not network:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Network not found")

    member = db.query(TeamMember).filter(
        TeamMember.org_id == network.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    net_member = db.query(NodeNetworkMember).filter(
        NodeNetworkMember.network_id == network_id,
        NodeNetworkMember.node_id == node_id,
    ).first()
    if not net_member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node is not in this network")

    if update_data.priority is not None:
        net_member.priority = update_data.priority
    if update_data.weight is not None:
        net_member.weight = update_data.weight

    db.commit()
    db.refresh(network)
    return network


@router.delete("/node-networks/{network_id}/nodes/{node_id}", status_code=204)
async def remove_node_from_network(
    network_id: UUID,
    node_id: UUID,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Remove a node from a network."""
    user_id = _current_user_uuid(current_user)
    _ensure_user_org_member(db, current_user)
    network = db.query(NodeNetwork).filter(NodeNetwork.id == network_id).first()
    if not network:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Network not found")

    member = db.query(TeamMember).filter(
        TeamMember.org_id == network.org_id,
        TeamMember.user_id == user_id,
    ).first()
    if not member or not member.can_manage_nodes:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permission denied")

    net_member = db.query(NodeNetworkMember).filter(
        NodeNetworkMember.network_id == network_id,
        NodeNetworkMember.node_id == node_id,
    ).first()
    if not net_member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node is not in this network")

    db.delete(net_member)
    db.commit()
    logger.info("Node %s removed from network %s", node_id, network_id)
    return None
