"""
Schemas for multi-user, GitHub Enterprise, and node network features
"""

from pydantic import BaseModel, Field, HttpUrl
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from enum import Enum


class GitHubProvider(str, Enum):
    GITHUB_COM = "github_com"
    GITHUB_ENTERPRISE = "github_enterprise"


class TeamRole(str, Enum):
    OWNER = "owner"
    ADMIN = "admin"
    DEVELOPER = "developer"
    VIEWER = "viewer"


class NodeStatus(str, Enum):
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    OFFLINE = "offline"
    MAINTENANCE = "maintenance"


# ============================================================================
# GitHub Connection Schemas
# ============================================================================

class GitHubConnectionBase(BaseModel):
    provider: GitHubProvider = GitHubProvider.GITHUB_COM
    github_username: str
    is_primary: bool = False


class GitHubConnectionCreate(GitHubConnectionBase):
    github_access_token: str
    enterprise_url: Optional[str] = None
    enterprise_name: Optional[str] = None


class GitHubConnectionResponse(GitHubConnectionBase):
    id: UUID
    user_id: UUID
    org_id: Optional[UUID]
    enterprise_url: Optional[str]
    enterprise_name: Optional[str]
    is_active: bool
    last_synced: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


class GitHubConnectionUpdate(BaseModel):
    is_primary: Optional[bool] = None
    is_active: Optional[bool] = None


class GitHubOAuthCallback(BaseModel):
    code: str
    state: str
    redirect_uri: Optional[str] = None
    enterprise_name: Optional[str] = None


# ============================================================================
# Team Member Schemas
# ============================================================================

class TeamMemberBase(BaseModel):
    email: str
    role: TeamRole = TeamRole.DEVELOPER
    can_create_projects: bool = True
    can_manage_deployments: bool = True
    can_manage_nodes: bool = False
    can_manage_team: bool = False


class TeamMemberCreate(TeamMemberBase):
    pass


class TeamMemberResponse(TeamMemberBase):
    id: UUID
    org_id: UUID
    user_id: Optional[UUID]
    is_active: bool
    joined_at: datetime
    invited_at: Optional[datetime]

    class Config:
        from_attributes = True


class TeamMemberUpdate(BaseModel):
    role: Optional[TeamRole] = None
    can_create_projects: Optional[bool] = None
    can_manage_deployments: Optional[bool] = None
    can_manage_nodes: Optional[bool] = None
    can_manage_team: Optional[bool] = None
    is_active: Optional[bool] = None


# ============================================================================
# Node Schemas
# ============================================================================

class OrgNodeBase(BaseModel):
    name: str
    host: str
    user: str
    port: int = 22
    remote_path: str
    reload_command: str
    is_primary: bool = False
    max_concurrent_deployments: int = 1


class OrgNodeCreate(OrgNodeBase):
    ssh_key_path: str


class OrgNodeResponse(OrgNodeBase):
    id: UUID
    org_id: UUID
    status: NodeStatus
    last_health_check: Optional[datetime]
    cpu_usage: Optional[int]
    memory_usage: Optional[int]
    disk_usage: Optional[int]
    is_active: bool
    created_by_user_id: Optional[UUID] = None
    updated_by_user_id: Optional[UUID] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class OrgNodeUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    remote_path: Optional[str] = None
    reload_command: Optional[str] = None
    is_primary: Optional[bool] = None
    max_concurrent_deployments: Optional[int] = None
    is_active: Optional[bool] = None


class OrgNodeHealthCheck(BaseModel):
    """Health check response from node"""
    status: NodeStatus
    cpu_usage: int
    memory_usage: int
    disk_usage: int
    timestamp: datetime


# ============================================================================
# Node Network Schemas
# ============================================================================

class NodeNetworkBase(BaseModel):
    name: str
    description: Optional[str] = None
    environment: Optional[str] = None
    is_default: bool = False
    load_balance: bool = True
    health_check_interval: int = 300


class NodeNetworkCreate(NodeNetworkBase):
    pass


class NodeNetworkResponse(NodeNetworkBase):
    id: UUID
    org_id: UUID
    is_default: bool
    created_at: datetime
    updated_at: datetime
    nodes: List[OrgNodeResponse] = []

    class Config:
        from_attributes = True


class NodeNetworkUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_default: Optional[bool] = None
    load_balance: Optional[bool] = None
    health_check_interval: Optional[int] = None


class NodeNetworkMemberAdd(BaseModel):
    node_id: UUID
    priority: int = 0
    weight: int = 100


class NodeNetworkMemberUpdate(BaseModel):
    priority: Optional[int] = None
    weight: Optional[int] = None


# ============================================================================
# Setup Wizard Extensions
# ============================================================================

class SetupWizardGitHub(BaseModel):
    """Step 1B: User connects GitHub/Enterprise"""
    provider: GitHubProvider
    github_username: str
    github_access_token: str
    enterprise_url: Optional[str] = None
    enterprise_name: Optional[str] = None


class SetupWizardTeam(BaseModel):
    """Step 2B: Invite team members"""
    team_name: str
    members: List[TeamMemberCreate] = []


class SetupWizardNodeNetwork(BaseModel):
    """Step 3B: Setup node network"""
    network_name: str
    environment: Optional[str] = None
    nodes: List[OrgNodeCreate] = []


# ============================================================================
# Dashboard Response Schemas
# ============================================================================

class OrganizationDashboard(BaseModel):
    """Full org dashboard with all data"""
    id: UUID
    name: str
    team_members: List[TeamMemberResponse]
    github_connections: List[GitHubConnectionResponse]
    node_networks: List[NodeNetworkResponse]
    total_nodes: int
    active_nodes: int
    projects_count: int
    created_at: datetime

    class Config:
        from_attributes = True


class InstallationOwnerResponse(BaseModel):
    owner_user_id: Optional[UUID] = None
    owner_login: Optional[str] = None
    owner_github_id: Optional[int] = None
    claimed_at: Optional[datetime] = None
    github_connected_at: Optional[datetime] = None
    is_claimed: bool
    is_owner: bool
    owner_mode_enabled: bool
