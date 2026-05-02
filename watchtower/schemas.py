"""
Pydantic schemas for API request/response validation
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from enum import Enum


# Enums matching database
class UseCaseType(str, Enum):
    NETLIFY_LIKE = "netlify_like"
    VERCEL_LIKE = "vercel_like"
    DOCKER_PLATFORM = "docker_platform"


class DeploymentModel(str, Enum):
    SELF_HOSTED = "self_hosted"
    SAAS = "saas"


class ProjectSourceType(str, Enum):
    GITHUB = "github"
    LOCAL_FOLDER = "local_folder"


class DeploymentStatus(str, Enum):
    PENDING = "pending"
    BUILDING = "building"
    DEPLOYING = "deploying"
    LIVE = "live"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class BuildStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class DeploymentTrigger(str, Enum):
    WEBHOOK = "webhook"
    MANUAL = "manual"
    SCHEDULED = "scheduled"


class Environment(str, Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


# User Schemas
class UserBase(BaseModel):
    email: str
    name: str


class UserCreate(UserBase):
    github_id: Optional[int] = None


class UserResponse(UserBase):
    id: UUID
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


# Organization Schemas
class OrganizationBase(BaseModel):
    name: str


class OrganizationCreate(OrganizationBase):
    pass


class OrganizationResponse(OrganizationBase):
    id: UUID
    owner_id: UUID
    created_at: datetime

    class Config:
        from_attributes = True


# Project Schemas
class ProjectBase(BaseModel):
    name: str
    use_case: UseCaseType
    deployment_model: DeploymentModel = DeploymentModel.SELF_HOSTED
    source_type: ProjectSourceType = ProjectSourceType.GITHUB
    local_folder_path: Optional[str] = None
    launch_url: Optional[str] = None
    repo_url: str
    repo_branch: str = "main"
    # Set by the wizard from /api/runtime/recommend-port. Optional so the
    # legacy SSH/rsync flow that doesn't need a port can omit it.
    recommended_port: Optional[int] = None


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    repo_branch: Optional[str] = None
    is_active: Optional[bool] = None
    recommended_port: Optional[int] = None


class ProjectResponse(ProjectBase):
    id: UUID
    org_id: UUID
    owner_id: UUID
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


# Project Relation Schemas
class ProjectRelationCreate(BaseModel):
    related_project_id: UUID
    order_index: int = 0
    note: Optional[str] = None


class ProjectRelationResponse(BaseModel):
    id: UUID
    project_id: UUID
    related_project_id: UUID
    related_project_name: Optional[str] = None
    related_project_branch: Optional[str] = None
    order_index: int
    note: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class RunWithRelatedResultItem(BaseModel):
    project_id: UUID
    project_name: str
    deployment_id: Optional[UUID] = None
    status: str  # "queued" | "skipped" | "error"
    detail: Optional[str] = None


class RunWithRelatedResponse(BaseModel):
    triggered_count: int
    skipped_count: int
    results: List[RunWithRelatedResultItem]


# Deployment Schemas
class DeploymentBase(BaseModel):
    commit_sha: str
    commit_message: Optional[str] = None
    branch: str
    trigger: DeploymentTrigger = DeploymentTrigger.MANUAL


class DeploymentTriggerRequest(BaseModel):
    branch: str = Field(default="main")
    commit_sha: Optional[str] = None
    node_ids: Optional[List[UUID]] = None


class DeploymentResponse(BaseModel):
    id: UUID
    project_id: UUID
    commit_sha: str
    commit_message: Optional[str]
    branch: str
    status: DeploymentStatus
    trigger: DeploymentTrigger
    pr_number: Optional[int]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]

    class Config:
        from_attributes = True


# Build Schemas
class BuildResponse(BaseModel):
    id: UUID
    deployment_id: UUID
    status: BuildStatus
    container_id: Optional[str]
    build_command: str
    build_output: Optional[str]
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    duration_seconds: Optional[int]

    class Config:
        from_attributes = True


# Netlify-like Config Schemas
class NetlifeLikeConfigBase(BaseModel):
    output_dir: str = "dist"
    functions_dir: Optional[str] = None
    enable_functions: bool = False
    spa_fallback: bool = True


class NetlifeLikeConfigResponse(NetlifeLikeConfigBase):
    project_id: UUID

    class Config:
        from_attributes = True


# Vercel-like Config Schemas
class VercelLikeConfigBase(BaseModel):
    framework: str
    enable_preview_deployments: bool = True
    preview_max_age: int = 7


class VercelLikeConfigResponse(VercelLikeConfigBase):
    project_id: UUID

    class Config:
        from_attributes = True


# Docker Platform Config Schemas
class DockerPlatformConfigBase(BaseModel):
    dockerfile_path: str = "./Dockerfile"
    exposed_port: int = 3000
    docker_compose_path: Optional[str] = None
    target_nodes: str


class DockerPlatformConfigResponse(DockerPlatformConfigBase):
    project_id: UUID

    class Config:
        from_attributes = True


# Custom Domain Schemas
class CustomDomainBase(BaseModel):
    domain: str
    is_primary: bool = False
    tls_enabled: bool = True


class CustomDomainCreate(CustomDomainBase):
    pass


class CustomDomainUpdate(BaseModel):
    is_primary: Optional[bool] = None
    tls_enabled: Optional[bool] = None


class CustomDomainResponse(CustomDomainBase):
    id: UUID
    project_id: UUID
    tls_cert_path: Optional[str]
    letsencrypt_validated: bool
    created_at: datetime

    class Config:
        from_attributes = True


# Environment Variable Schemas
class EnvironmentVariableBase(BaseModel):
    key: str
    environment: Environment = Environment.PRODUCTION


class EnvironmentVariableCreate(EnvironmentVariableBase):
    value: str


class EnvironmentVariableResponse(EnvironmentVariableBase):
    id: UUID
    project_id: UUID
    value: str  # In production, this should be redacted in responses

    class Config:
        from_attributes = True


# Setup Wizard Schemas
class SetupWizardDeploymentModel(BaseModel):
    """Step 1: User selects deployment model"""
    deployment_model: DeploymentModel


class SetupWizardUseCase(BaseModel):
    """Step 2: User selects use case"""
    use_case: UseCaseType


class SetupWizardRepository(BaseModel):
    """Step 3: User connects repository"""
    repo_url: str
    repo_branch: str = "main"
    build_command: str


class SetupWizardNetlifeLike(BaseModel):
    """Step 4: Netlify-like specific config"""
    project_name: str
    output_dir: str = "dist"
    functions_dir: Optional[str] = None
    enable_functions: bool = False
    custom_domain: Optional[str] = None


class SetupWizardVercelLike(BaseModel):
    """Step 4: Vercel-like specific config"""
    project_name: str
    framework: str
    enable_preview_deployments: bool = True
    custom_domain: Optional[str] = None
    environment_variables: Optional[List[EnvironmentVariableCreate]] = None


class SetupWizardDockerPlatform(BaseModel):
    """Step 4: Docker platform specific config"""
    project_name: str
    dockerfile_path: str = "./Dockerfile"
    exposed_port: int = 3000
    docker_compose_path: Optional[str] = None
    target_nodes: str
    environment_variables: Optional[List[EnvironmentVariableCreate]] = None


class SetupWizardComplete(BaseModel):
    """Step 5: Complete setup wizard with all data"""
    deployment_model: DeploymentModel
    use_case: UseCaseType
    source_type: ProjectSourceType = ProjectSourceType.GITHUB
    local_folder_path: Optional[str] = None
    launch_url: Optional[str] = None
    repo_url: str
    repo_branch: str
    build_command: str
    project_name: str
    # Use-case specific fields
    output_dir: Optional[str] = None  # Netlify-like
    functions_dir: Optional[str] = None  # Netlify-like
    enable_functions: Optional[bool] = False  # Netlify-like
    framework: Optional[str] = None  # Vercel-like
    enable_preview_deployments: Optional[bool] = True  # Vercel-like
    dockerfile_path: Optional[str] = "./Dockerfile"  # Docker
    exposed_port: Optional[int] = 3000  # Docker (legacy — per-use-case)
    docker_compose_path: Optional[str] = None  # Docker
    target_nodes: Optional[str] = None  # Docker
    custom_domain: Optional[str] = None
    environment_variables: Optional[List[EnvironmentVariableCreate]] = None
    # Universal port suggestion fed by /api/runtime/recommend-port — applies
    # regardless of use_case, persisted on Project itself rather than on the
    # per-use-case config tables.
    recommended_port: Optional[int] = None


# GitHub Webhook Schemas
class GitHubWebhookPayload(BaseModel):
    """GitHub webhook event payload"""
    action: Optional[str] = None
    ref: Optional[str] = None
    repository: Optional[dict] = None
    head_commit: Optional[dict] = None
    pull_request: Optional[dict] = None
    pusher: Optional[dict] = None


# Response Schemas
class ApiResponse(BaseModel):
    """Generic API response wrapper"""
    success: bool
    message: str
    data: Optional[dict] = None


class ErrorResponse(BaseModel):
    """Error response"""
    success: bool = False
    message: str
    error_code: str
    details: Optional[dict] = None
