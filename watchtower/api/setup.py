"""
Setup Wizard API endpoints
"""

import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from uuid import UUID

from watchtower.database import (
    get_db, Project, Organization, User,
    NetlifeLikeConfig, VericelLikeConfig, DockerPlatformConfig,
    EnvironmentVariable, Environment
)
from watchtower import schemas
from watchtower.api import util

router = APIRouter(prefix="/api/setup", tags=["Setup"])
logger = logging.getLogger(__name__)


@router.post("/wizard/complete", response_model=schemas.ProjectResponse, status_code=status.HTTP_201_CREATED)
async def complete_setup_wizard(
    setup_data: schemas.SetupWizardComplete,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user)
):
    """
    Complete setup wizard - create project with all configuration
    """
    try:
        # Use canonical org resolution so the project is always placed under
        # the installation owner's org (avoids org fragmentation when the token
        # changes between restarts).
        from watchtower.api.enterprise import _ensure_user_org_member
        user, org, _member = _ensure_user_org_member(db, current_user)
        user_id = user.id
        
        # Create project
        webhook_secret = util.generate_webhook_secret()
        project = Project(
            name=setup_data.project_name,
            use_case=setup_data.use_case,
            deployment_model=setup_data.deployment_model,
            source_type=setup_data.source_type.value,
            local_folder_path=setup_data.local_folder_path,
            launch_url=setup_data.launch_url,
            repo_url=setup_data.repo_url,
            repo_branch=setup_data.repo_branch,
            webhook_secret=webhook_secret,
            org_id=org.id,
            owner_id=user_id
        )
        db.add(project)
        db.flush()
        
        # Add use-case specific configuration
        if setup_data.use_case == schemas.UseCaseType.NETLIFY_LIKE:
            config = NetlifeLikeConfig(
                project_id=project.id,
                output_dir=setup_data.output_dir or "dist",
                functions_dir=setup_data.functions_dir,
                enable_functions=setup_data.enable_functions or False,
                spa_fallback=True
            )
            db.add(config)
        
        elif setup_data.use_case == schemas.UseCaseType.VERCEL_LIKE:
            config = VericelLikeConfig(
                project_id=project.id,
                framework=setup_data.framework or "next.js",
                enable_preview_deployments=setup_data.enable_preview_deployments or True
            )
            db.add(config)
        
        elif setup_data.use_case == schemas.UseCaseType.DOCKER_PLATFORM:
            config = DockerPlatformConfig(
                project_id=project.id,
                dockerfile_path=setup_data.dockerfile_path or "./Dockerfile",
                exposed_port=setup_data.exposed_port or 3000,
                docker_compose_path=setup_data.docker_compose_path,
                target_nodes=setup_data.target_nodes or "default"
            )
            db.add(config)
        
        # Add environment variables if provided
        if setup_data.environment_variables:
            for env_var in setup_data.environment_variables:
                db_env_var = EnvironmentVariable(
                    project_id=project.id,
                    key=env_var.key,
                    value=env_var.value,
                    environment=env_var.environment
                )
                db.add(db_env_var)
        
        # Commit all changes
        db.commit()
        db.refresh(project)
        
        return project
    
    except Exception:
        db.rollback()
        logger.exception("Setup wizard completion failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Error completing setup"
        )


@router.get("/wizard/validate-repo")
async def validate_repository(
    repo_url: str,
    branch: str = "main"
):
    """
    Validate that a repository is accessible
    """
    try:
        # TODO: Validate GitHub/GitLab repo access
        return {
            "valid": True,
            "message": "Repository is accessible"
        }
    except Exception:
        logger.exception("Repository validation failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Repository validation failed"
        )


@router.get("/wizard/detect-framework")
async def detect_framework(
    repo_url: str,
    branch: str = "main"
):
    """
    Auto-detect framework from repository by inspecting package.json.
    """
    import asyncio
    from watchtower import builder as build_runner
    try:
        # Run in a thread to avoid blocking the event loop (may do network I/O)
        result = await asyncio.get_event_loop().run_in_executor(
            None, build_runner.detect_framework, repo_url, branch
        )
        return result
    except Exception:
        logger.exception("Framework detection failed")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Framework detection failed"
        )
