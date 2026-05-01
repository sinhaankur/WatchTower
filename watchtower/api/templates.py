"""Template-catalog endpoints.

Two endpoints, both auth-gated:

  GET  /api/templates           — list the full catalog
  POST /api/templates/{slug}/create — create a project from a template

Why a dedicated router rather than tacking onto /api/projects: the
templates resource is read-mostly and the catalog is independent of
the user's projects. Keeping it separate also lets future evolutions
(curated/community templates, template versioning, ratings) land
without dragging the projects router along.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower import templates as template_catalog
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import (
    EnvironmentVariable,
    Project,
    ProjectSourceType,
    UseCaseType,
    get_db,
)


router = APIRouter(prefix="/api/templates", tags=["Templates"])


class CreateFromTemplateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    use_case: str = Field(default="vercel_like")
    # Override the catalog's default branch if the user wants to
    # follow a feature branch / fork. Empty/None falls back to
    # template's repo_branch.
    repo_branch: str = ""
    # Override the catalog repo_url if the user has forked. Empty
    # falls back to the template's upstream.
    repo_url_override: str = ""


@router.get("")
async def list_templates(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return the full template catalog. Auth-gated like every other
    /api/* read so unauthenticated visitors see a 401 (matches the
    rest of the API surface; the /login page still works because the
    SPA's apiClient handles 401 by redirecting)."""
    return {"templates": template_catalog.all_templates()}


@router.post("/{slug}/create", status_code=status.HTTP_201_CREATED)
async def create_from_template(
    slug: str,
    request: Request,
    body: CreateFromTemplateRequest,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
):
    """Create a Project pre-filled from the named template.

    Steps:
      1. Validate the slug + load the template recipe.
      2. Bootstrap the user's org membership (matches the existing
         project-create path; idempotent).
      3. Create a Project row with name + repo info from the template
         (overridable by the request body).
      4. Insert EnvironmentVariable rows for every default_env_var,
         marking placeholder=True ones as `production` env so the
         user sees them in the env-vars tab and edits before deploy.
      5. Audit-log the action so the trail shows "this project came
         from a template" (not just "user created project X").

    Returns the created project's row + the env-var ids that were
    pre-populated. The SPA can navigate to the env-vars tab and
    highlight rows that need filling in.
    """
    # ── 1. Resolve the template ────────────────────────────────────────────
    tpl = template_catalog.find_template(slug)
    if tpl is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No template with slug '{slug}'. Try GET /api/templates to list available slugs.",
        )

    # ── 2. Bootstrap org membership (mirrors project-create flow) ─────────
    from watchtower.api.enterprise import _ensure_user_org_member
    user, canonical_org, member = _ensure_user_org_member(db, current_user)

    if not member or not member.can_create_projects:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to create projects in this org.",
        )

    # ── 3. Resolve use-case enum (the schema demands one of the values) ───
    try:
        use_case_enum = UseCaseType(body.use_case)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid use_case '{body.use_case}'.",
        )

    # ── 4. Create the project ─────────────────────────────────────────────
    project = Project(
        org_id=canonical_org.id,
        owner_id=user.id,
        name=body.name,
        use_case=use_case_enum,
        source_type=ProjectSourceType.GITHUB.value,
        repo_url=body.repo_url_override or tpl.repo_url,
        repo_branch=body.repo_branch or tpl.repo_branch,
        webhook_secret="",  # set on first webhook configuration
        is_active=True,
    )
    db.add(project)
    db.flush()  # get project.id without committing — env vars need it

    # ── 5. Pre-fill env vars ──────────────────────────────────────────────
    # Default to 'production' environment so the env-vars tab shows
    # them on first load. Placeholder values stay as-is; the SPA
    # surfaces the placeholder=True flag in the response so the UI
    # can prompt the user to fill them in.
    created_env_var_ids: list[str] = []
    for tpl_env in tpl.default_env_vars:
        env_var = EnvironmentVariable(
            project_id=project.id,
            key=tpl_env.key,
            value=tpl_env.value,
            environment="production",
        )
        db.add(env_var)
        db.flush()
        created_env_var_ids.append(str(env_var.id))

    audit_log.record_for_user(
        db, current_user,
        action="project.create",
        entity_type="project",
        entity_id=project.id,
        org_id=canonical_org.id,
        request=request,
        extra={
            "from_template": tpl.slug,
            "template_name": tpl.name,
            "env_vars_prefilled": len(created_env_var_ids),
        },
    )
    db.commit()
    db.refresh(project)

    # Echo the placeholders flag so the SPA can highlight which env
    # vars need user input before the first deploy.
    placeholder_keys = [v.key for v in tpl.default_env_vars if v.placeholder]

    return {
        "project_id": str(project.id),
        "name": project.name,
        "repo_url": project.repo_url,
        "repo_branch": project.repo_branch,
        "template": {
            "slug": tpl.slug,
            "name": tpl.name,
            "icon_slug": tpl.icon_slug,
            "memory_hint_mb": tpl.memory_hint_mb,
            "notes": tpl.notes,
            "documentation_url": tpl.documentation_url,
        },
        "env_var_ids": created_env_var_ids,
        "placeholder_env_var_keys": placeholder_keys,
    }
