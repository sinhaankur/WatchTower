"""Lightweight identity endpoint.

The session-token already carries the user's email + GitHub ID, but the
SPA only stores the opaque token in localStorage — it never decodes it.
``GET /api/me`` lets the frontend show "signed in as <email>" without
having to re-implement the HMAC parser, and surfaces the resolved org
+ role so a user knows which tenant they're operating against.

Deliberately read-only and cheap — the sidebar identity badge calls
this on every mount.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower.database import get_db
from watchtower.api import util

router = APIRouter(prefix="/api", tags=["Identity"])


class MeResponse(BaseModel):
    user_id: str
    email: Optional[str] = None
    name: Optional[str] = None
    github_id: Optional[str] = None
    avatar_url: Optional[str] = None
    org_id: Optional[str] = None
    org_name: Optional[str] = None
    role: Optional[str] = None  # owner | admin | member | viewer
    can_manage_team: bool = False
    can_manage_deployments: bool = False
    can_manage_nodes: bool = False
    can_create_projects: bool = False
    is_guest: bool = False
    is_github_authenticated: bool = False
    # True for the static-token desktop/CI identity (authenticated local
    # operator, not GitHub). Lets the UI label it honestly as a local admin.
    is_local_admin: bool = False


@router.get("/me", response_model=MeResponse)
async def get_me(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> MeResponse:
    """Return the caller's identity + canonical org membership.

    Falls back gracefully when the org cannot be resolved (e.g. token
    auth without a real session): the user fields still come back so
    the UI can show "signed in as token-user".
    """
    user_id = str(current_user.get("user_id", ""))
    email = current_user.get("email")
    name = current_user.get("name")
    github_id = current_user.get("github_id")

    org_id: Optional[str] = None
    org_name: Optional[str] = None
    role: Optional[str] = None
    can_manage_team = False
    can_manage_deployments = False
    can_manage_nodes = False
    can_create_projects = False
    avatar_url = current_user.get("avatar_url")

    try:
        from watchtower.api.enterprise import _ensure_user_org_member

        user, org, member = _ensure_user_org_member(db, current_user)
        if user is not None:
            email = email or user.email
            # The DB user's name WINS over the token's default: once you've
            # personalized it (PATCH /api/me), that's your name — the token's
            # generic "Local admin" default must not shadow it. Fall back to the
            # token name only when the DB has none yet.
            db_name = getattr(user, "name", None)
            name = db_name or name
            avatar_url = avatar_url or getattr(user, "avatar_url", None)
        if org is not None:
            org_id = str(org.id)
            org_name = org.name
        if member is not None:
            role_val = getattr(member.role, "value", member.role)
            role = str(role_val) if role_val else None
            can_manage_team = bool(getattr(member, "can_manage_team", False))
            can_manage_deployments = bool(getattr(member, "can_manage_deployments", False))
            can_manage_nodes = bool(getattr(member, "can_manage_nodes", False))
            can_create_projects = bool(getattr(member, "can_create_projects", False))
    except Exception:
        # Token-auth users (CI, curl) won't have a real org — that's fine,
        # we still return their identity dict so the UI can render.
        pass

    is_github_authenticated = bool(github_id)
    # is_guest is keyed off the guest email, NOT off "lacks github_id".
    # Three identity classes here, only ONE of which is meant to be limited:
    #   1. GitHub-authenticated user → full access
    #   2. API-token user (operator who installed the server, no GitHub
    #      OAuth configured) → full access; they ARE the operator
    #   3. Guest (clicked "Continue as Guest") → limited, gated below
    # The previous logic conflated #2 with #3 by checking github_id alone,
    # which locked single-user desktop installs out of adding deploy nodes
    # whenever they used the WATCHTOWER_API_TOKEN auth path. Surfaced via
    # user feedback ("adding remote deployment nodes requires a GitHub-
    # authenticated session" while signed in via API token).
    is_guest = (not is_github_authenticated) and (email == "guest@watchtower.local")

    return MeResponse(
        user_id=user_id,
        email=email,
        name=name,
        github_id=str(github_id) if github_id else None,
        avatar_url=avatar_url,
        org_id=org_id,
        org_name=org_name,
        role=role,
        can_manage_team=can_manage_team,
        can_manage_deployments=can_manage_deployments,
        # Only guests are blocked from registering remote nodes. API-token
        # operators and GitHub-authenticated users keep can_manage_nodes
        # exactly as their TeamMember row says.
        can_manage_nodes=can_manage_nodes and not is_guest,
        can_create_projects=can_create_projects,
        is_guest=is_guest,
        is_github_authenticated=is_github_authenticated,
        # The static-token path sets this; GitHub/guest sessions don't.
        is_local_admin=bool(current_user.get("is_local_admin")) and not is_github_authenticated,
    )


class UpdateMeRequest(BaseModel):
    # Just your display name, for now — easy personalization without needing to
    # set up GitHub login. Trimmed, capped, and cannot be blanked to nothing.
    name: str


@router.patch("/me", response_model=MeResponse)
async def update_me(
    body: UpdateMeRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> MeResponse:
    """Personalize your display name — persisted to your user record, so the app
    stops showing a generic 'Local admin' and shows YOU. No GitHub required.

    Only the name is editable here; email is the stable identity key and isn't
    changed. GitHub-authenticated users can rename too (it won't be overwritten
    on next login unless GitHub sends a name)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Name can't be empty.")
    if len(name) > 80:
        name = name[:80]

    from watchtower.api.enterprise import _ensure_user_org_member
    user, _org, _member = _ensure_user_org_member(db, current_user)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No user record to update.")
    user.name = name
    db.commit()
    # Re-read the full identity so the response reflects the new name everywhere.
    return await get_me(db=db, current_user={**current_user, "name": name})
