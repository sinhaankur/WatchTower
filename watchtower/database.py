"""
Database configuration and ORM setup for WatchTower
"""

import os
from sqlalchemy import (
    create_engine,
    Column,
    String,
    Integer,
    DateTime,
    Boolean,
    Enum,
    ForeignKey,
    Text,
    UniqueConstraint,
    Uuid,
    inspect,
    text,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

import uuid
from datetime import datetime
import enum

def _default_database_url() -> str:
    """Pick a default DATABASE_URL that's actually writable.

    The previous default — ``sqlite:///./watchtower.db`` — assumed the
    process's cwd was writable. That holds for source-clone runs but
    breaks for pip-installed installs (cwd is wherever the user
    happened to be, often non-writable) and *especially* for packaged
    AppImage launches (cwd is the AppImage's read-only FUSE mount —
    SQLite can't open a writable connection, init_db throws, the
    backend never reaches /health, the smoke test sees a hang).

    Resolution order:
      1. ``DATABASE_URL`` env var (production: Postgres URL).
      2. ``WATCHTOWER_DATA_DIR/watchtower.db`` if the env var is set.
      3. ``~/.watchtower/watchtower.db`` — same data dir as the Fernet
         secret key, always writable.
      4. ``./watchtower.db`` only if cwd is writable AND already has
         the file (preserves dev-clone behaviour where you've been
         running with the cwd-relative path for ages).

    The dev-clone fallback is last so a user who already has a populated
    ``./watchtower.db`` in their source clone keeps using it instead of
    silently switching to ~/.watchtower/.
    """
    env_url = os.getenv("DATABASE_URL")
    if env_url:
        return env_url

    data_dir = os.getenv("WATCHTOWER_DATA_DIR")
    if not data_dir:
        # Preserve dev-clone behaviour: if a SQLite file already exists
        # in cwd, use it. Avoids unexpectedly migrating to a new DB.
        cwd_db = os.path.abspath("./watchtower.db")
        if os.path.exists(cwd_db) and os.access(os.path.dirname(cwd_db), os.W_OK):
            return f"sqlite:///{cwd_db}"
        data_dir = os.path.join(os.path.expanduser("~"), ".watchtower")

    try:
        os.makedirs(data_dir, exist_ok=True)
    except OSError:
        pass
    return f"sqlite:///{os.path.join(data_dir, 'watchtower.db')}"


DATABASE_URL = _default_database_url()

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


class ProjectSourceType(str, enum.Enum):
    GITHUB = "github"
    LOCAL_FOLDER = "local_folder"


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
    source_type = Column(String, default=ProjectSourceType.GITHUB.value)
    local_folder_path = Column(String, nullable=True)
    launch_url = Column(String, nullable=True)
    repo_url = Column(String)
    repo_branch = Column(String, default="main")
    webhook_secret = Column(String)
    # Port WatchTower picked (or the user accepted/overrode) at create
    # time. Used as the deploy-time default for the local-podman runner;
    # re-validated at bind time, so a port that's free at create time
    # but taken at deploy time falls through to a fresh pick.
    recommended_port = Column(Integer, nullable=True)
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


class InstallationClaim(Base):
    """Singleton record describing who owns this WatchTower installation."""
    __tablename__ = "installation_claims"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), unique=True)
    owner_github_id = Column(Integer, nullable=True)
    owner_login = Column(String, nullable=True)
    claimed_at = Column(DateTime, default=datetime.utcnow)
    github_connected_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    owner_user = relationship("User", backref="installation_claims")


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
    status_message = Column(String, nullable=True)   # Last health-check message
    last_health_check = Column(DateTime, nullable=True)
    cpu_usage = Column(Integer, nullable=True)
    memory_usage = Column(Integer, nullable=True)
    disk_usage = Column(Integer, nullable=True)
    
    # Configuration
    max_concurrent_deployments = Column(Integer, default=1)
    is_active = Column(Boolean, default=True)
    is_primary = Column(Boolean, default=False)  # Primary node for deployments
    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    updated_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    
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


class ProjectRelation(Base):
    """A directional dependency between two projects.

    When project ``project_id`` is launched via the "run with related" endpoint,
    every project in this row's ``related_project_id`` is also queued for
    deployment, ordered by ``order_index`` (lower first). This is *not*
    transitive — only direct relations are followed, so cycles cannot loop.
    """
    __tablename__ = "project_relations"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), index=True)
    related_project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"))
    order_index = Column(Integer, default=0)
    note = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "related_project_id",
            name="uq_project_relation_pair",
        ),
    )


class AuditEvent(Base):
    """Append-only record of who did what, when, and from where.

    Captures mutations across the API surface so an operator can answer
    "who changed prod env vars at 2am" without grep'ing log files. Linked
    to the per-request ``X-Request-ID`` (from log_config) so a single
    audit row points at every log line in the same HTTP request.

    Conventions:
      * ``action`` is dotted: ``"project.create"``, ``"deployment.trigger"``
      * ``entity_type`` matches the model: ``"project"``, ``"deployment"``
      * ``actor_*`` fields are nullable — webhook-triggered or system
        events have no human actor
      * Cross-org reads are blocked at the read endpoint, but rows are
        still written with their org_id for auditing operator overrides
    """
    __tablename__ = "audit_events"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    # Who
    actor_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True)
    actor_email = Column(String, nullable=True)

    # What
    action = Column(String, index=True)             # e.g. "project.create"
    entity_type = Column(String, nullable=True, index=True)  # "project", "deployment"
    entity_id = Column(Uuid(as_uuid=True), nullable=True, index=True)

    # Org scope (so the read endpoint can filter without joining)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True, index=True)

    # Trace correlation
    request_id = Column(String, nullable=True)
    ip_address = Column(String, nullable=True)

    # Free-form context (action-specific). Stored as JSON text; never use
    # for query predicates — that's what the structured columns are for.
    extra_json = Column(Text, nullable=True)


class NotificationWebhook(Base):
    """Discord / Slack webhook for deployment notifications per project."""
    __tablename__ = "notification_webhooks"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), nullable=True)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True)
    provider = Column(String, default="discord")   # "discord" | "slack"
    url = Column(String)                            # Webhook URL
    label = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", backref="notification_webhooks")


# Dependency for getting DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Bring the database schema to the current version.

    Strategy:
      1. **Empty DB** → run ``alembic upgrade head`` to create everything
         from scratch via the migration scripts. Ensures fresh installs
         run the same SQL the migration history records.
      2. **DB pre-dates Alembic adoption** (has tables but no
         ``alembic_version``) → ``stamp head`` so subsequent migrations
         apply incrementally. The pre-Alembic ``_ensure_*_columns()``
         helpers used to keep these schemas current; the baseline
         migration matches that final state, so stamping is safe.
      3. **DB already managed by Alembic** → ``upgrade head`` is a no-op
         when on the latest revision, otherwise applies pending changes.

    Production deployments can bypass this and invoke ``alembic upgrade``
    explicitly during release; ``init_db`` exists so single-process
    desktop / dev / test starts "just work."
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    has_app_tables = bool(existing_tables - {"alembic_version"})
    has_alembic_table = "alembic_version" in existing_tables

    cfg = _alembic_config()
    if has_app_tables and not has_alembic_table:
        # Adopt: assume the existing schema matches baseline. The previous
        # _ensure_*_columns() helpers kept this true.
        from alembic import command
        command.stamp(cfg, "head")
    else:
        from alembic import command
        command.upgrade(cfg, "head")


def _alembic_config():
    """Build an Alembic Config that points at the in-tree ``alembic/`` dir
    and uses the runtime ``DATABASE_URL`` (so the runner and migration
    layer always agree on the target database)."""
    from pathlib import Path
    from alembic.config import Config

    repo_root = Path(__file__).resolve().parents[1]
    cfg = Config(str(repo_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(repo_root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", str(engine.url))
    return cfg
