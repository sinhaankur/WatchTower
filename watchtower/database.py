"""
Database configuration and ORM setup for WatchTower
"""

import os
from sqlalchemy import create_engine, Column, String, Integer, DateTime, Boolean, Enum, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

import uuid
from datetime import datetime
import enum

# Database URL (self-hosted uses SQLite, can be overridden for PostgreSQL)
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite:///./watchtower.db"
)

# Create engine
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {},
    echo=os.getenv("SQL_ECHO", "False").lower() == "true"
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# Enums
class UseCaseType(str, enum.Enum):
    NETLIFY_LIKE = "netlify_like"
    VERCEL_LIKE = "vercel_like"
    DOCKER_PLATFORM = "docker_platform"


class DeploymentModel(str, enum.Enum):
    SELF_HOSTED = "self_hosted"
    SAAS = "saas"


class DeploymentStatus(str, enum.Enum):
    PENDING = "pending"
    BUILDING = "building"
    DEPLOYING = "deploying"
    LIVE = "live"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class BuildStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class DeploymentTrigger(str, enum.Enum):
    WEBHOOK = "webhook"
    MANUAL = "manual"
    SCHEDULED = "scheduled"


class Environment(str, enum.Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class GitHubProvider(str, enum.Enum):
    GITHUB_COM = "github_com"
    GITHUB_ENTERPRISE = "github_enterprise"


class TeamRole(str, enum.Enum):
    OWNER = "owner"
    ADMIN = "admin"
    DEVELOPER = "developer"
    VIEWER = "viewer"


class NodeStatus(str, enum.Enum):
    HEALTHY = "healthy"
    UNHEALTHY = "unhealthy"
    OFFLINE = "offline"
    MAINTENANCE = "maintenance"


# Models
class User(Base):
    __tablename__ = "users"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String, unique=True, index=True)
    github_id = Column(Integer, nullable=True, unique=True)
    name = Column(String)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    organizations = relationship("Organization", back_populates="owner")
    projects = relationship("Project", back_populates="owner")


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, index=True)
    owner_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner = relationship("User", back_populates="organizations")
    projects = relationship("Project", back_populates="organization")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"))
    owner_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    name = Column(String, index=True)
    use_case = Column(Enum(UseCaseType), index=True)
    deployment_model = Column(Enum(DeploymentModel), default=DeploymentModel.SELF_HOSTED)
    repo_url = Column(String)
    repo_branch = Column(String, default="main")
    webhook_secret = Column(String)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    organization = relationship("Organization", back_populates="projects")
    owner = relationship("User", back_populates="projects")
    deployments = relationship("Deployment", back_populates="project", cascade="all, delete-orphan")
    custom_domains = relationship("CustomDomain", back_populates="project", cascade="all, delete-orphan")
    env_variables = relationship("EnvironmentVariable", back_populates="project", cascade="all, delete-orphan")


class Deployment(Base):
    __tablename__ = "deployments"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"))
    commit_sha = Column(String)
    commit_message = Column(String, nullable=True)
    branch = Column(String)
    status = Column(Enum(DeploymentStatus), default=DeploymentStatus.PENDING, index=True)
    trigger = Column(Enum(DeploymentTrigger), default=DeploymentTrigger.MANUAL)
    pr_number = Column(Integer, nullable=True)  # For PR preview deployments
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    project = relationship("Project", back_populates="deployments")
    builds = relationship("Build", back_populates="deployment", cascade="all, delete-orphan")


class Build(Base):
    __tablename__ = "builds"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    deployment_id = Column(Uuid(as_uuid=True), ForeignKey("deployments.id"))
    status = Column(Enum(BuildStatus), default=BuildStatus.PENDING, index=True)
    container_id = Column(String, nullable=True)  # Podman container ID
    build_command = Column(String)
    build_output = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    deployment = relationship("Deployment", back_populates="builds")

    @property
    def duration_seconds(self):
        if self.started_at and self.completed_at:
            return int((self.completed_at - self.started_at).total_seconds())
        return None


class NetlifeLikeConfig(Base):
    __tablename__ = "netlify_like_configs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), unique=True)
    output_dir = Column(String)  # e.g., "dist", "build"
    functions_dir = Column(String, nullable=True)  # e.g., "api"
    enable_functions = Column(Boolean, default=False)
    spa_fallback = Column(Boolean, default=True)  # Fallback to index.html for SPA


class VericelLikeConfig(Base):
    __tablename__ = "vercel_like_configs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), unique=True)
    framework = Column(String)  # e.g., "next.js", "nuxt", "sveltekit"
    enable_preview_deployments = Column(Boolean, default=True)
    preview_max_age = Column(Integer, default=7)  # Days to keep preview deployments


class DockerPlatformConfig(Base):
    __tablename__ = "docker_platform_configs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), unique=True)
    dockerfile_path = Column(String, default="./Dockerfile")
    exposed_port = Column(Integer, default=3000)
    docker_compose_path = Column(String, nullable=True)
    target_nodes = Column(String)  # Comma-separated node names


class CustomDomain(Base):
    __tablename__ = "custom_domains"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"))
    domain = Column(String, unique=True, index=True)
    is_primary = Column(Boolean, default=False)
    tls_enabled = Column(Boolean, default=True)
    tls_cert_path = Column(String, nullable=True)
    letsencrypt_validated = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship("Project", back_populates="custom_domains")


class EnvironmentVariable(Base):
    __tablename__ = "environment_variables"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"))
    key = Column(String)
    value = Column(String)  # Should be encrypted in production
    environment = Column(Enum(Environment), default=Environment.PRODUCTION)
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", back_populates="env_variables")

    __table_args__ = (
        UniqueConstraint("project_id", "key", "environment", name="uq_env_var_project_key_env"),
    )


# ============================================================================
# Multi-User & GitHub Enterprise Support
# ============================================================================

class GitHubConnection(Base):
    """User's GitHub or GitHub Enterprise connection"""
    __tablename__ = "github_connections"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True)
    
    provider = Column(Enum(GitHubProvider), default=GitHubProvider.GITHUB_COM)
    github_username = Column(String)
    github_access_token = Column(String)  # Should be encrypted in production
    
    # For GitHub Enterprise
    enterprise_url = Column(String, nullable=True)  # e.g., https://github.enterprise.com
    enterprise_name = Column(String, nullable=True)
    
    is_active = Column(Boolean, default=True)
    is_primary = Column(Boolean, default=False)  # Primary account for org
    last_synced = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", backref="github_connections")
    organization = relationship("Organization", backref="github_connections")


class TeamMember(Base):
    """Team members for multi-user collaboration"""
    __tablename__ = "team_members"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"))
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    
    role = Column(Enum(TeamRole), default=TeamRole.DEVELOPER)
    email = Column(String)  # Can be different from user email (for invites)
    
    # Permissions (granular control)
    can_create_projects = Column(Boolean, default=True)
    can_manage_deployments = Column(Boolean, default=True)
    can_manage_nodes = Column(Boolean, default=False)
    can_manage_team = Column(Boolean, default=False)
    
    is_active = Column(Boolean, default=True)
    joined_at = Column(DateTime, default=datetime.utcnow)
    invited_at = Column(DateTime, nullable=True)

    organization = relationship("Organization", backref="team_members")
    user = relationship("User", backref="team_memberships")


class OrgNode(Base):
    """Deployment nodes managed by organization"""
    __tablename__ = "org_nodes"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"))
    
    name = Column(String, index=True)
    host = Column(String)
    user = Column(String)
    port = Column(Integer, default=22)
    remote_path = Column(String)
    
    # SSH Key Management
    ssh_key_path = Column(String)
    ssh_key_encrypted = Column(Text, nullable=True)  # Encrypted private key
    
    reload_command = Column(String)  # e.g., "sudo systemctl restart nginx"
    
    # Status Monitoring
    status = Column(Enum(NodeStatus), default=NodeStatus.OFFLINE)
    last_health_check = Column(DateTime, nullable=True)
    cpu_usage = Column(Integer, nullable=True)
    memory_usage = Column(Integer, nullable=True)
    disk_usage = Column(Integer, nullable=True)
    
    # Configuration
    max_concurrent_deployments = Column(Integer, default=1)
    is_active = Column(Boolean, default=True)
    is_primary = Column(Boolean, default=False)  # Primary node for deployments
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    organization = relationship("Organization", backref="nodes")
    networks = relationship("NodeNetwork", secondary="node_network_members", back_populates="nodes")


class NodeNetwork(Base):
    """Logical grouping of nodes for environment or team"""
    __tablename__ = "node_networks"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"))
    
    name = Column(String, index=True)  # e.g., "Production", "Staging", "Team Alpha"
    description = Column(String, nullable=True)
    
    # Environment type
    environment = Column(Enum(Environment), nullable=True)  # Optional: tie to env
    
    # Network settings
    is_default = Column(Boolean, default=False)  # Default network for org
    load_balance = Column(Boolean, default=True)  # Distribute across nodes
    health_check_interval = Column(Integer, default=300)  # seconds
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    organization = relationship("Organization", backref="node_networks")
    nodes = relationship("OrgNode", secondary="node_network_members", back_populates="networks")
    projects = relationship("Project", backref="node_network")


class NodeNetworkMember(Base):
    """Association table between nodes and networks"""
    __tablename__ = "node_network_members"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    node_id = Column(Uuid(as_uuid=True), ForeignKey("org_nodes.id"))
    network_id = Column(Uuid(as_uuid=True), ForeignKey("node_networks.id"))
    
    # Priority/weight for load balancing
    priority = Column(Integer, default=0)
    weight = Column(Integer, default=100)  # Traffic weight percentage
    
    added_at = Column(DateTime, default=datetime.utcnow)


class DeploymentNode(Base):
    """Which node a deployment was deployed to"""
    __tablename__ = "deployment_nodes"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    deployment_id = Column(Uuid(as_uuid=True), ForeignKey("deployments.id"))
    node_id = Column(Uuid(as_uuid=True), ForeignKey("org_nodes.id"))
    
    status = Column(Enum(DeploymentStatus), default=DeploymentStatus.PENDING)
    deploy_log = Column(Text, nullable=True)
    deployed_at = Column(DateTime, nullable=True)

    deployment = relationship("Deployment", backref="nodes")
    node = relationship("OrgNode", backref="deployments")


# Dependency for getting DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Create all tables
def init_db():
    Base.metadata.create_all(bind=engine)
