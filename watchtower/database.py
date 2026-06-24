"""
Database configuration and ORM setup for WatchTower
"""

import os
import logging
import re
from sqlalchemy import (
    create_engine,
    Column,
    String,
    Integer,
    DateTime,
    Boolean,
    Enum,
    ForeignKey,
    Index,
    Text,
    UniqueConstraint,
    Uuid,
    inspect,
    text,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

import uuid
from datetime import datetime, timezone
import enum


def _utcnow() -> datetime:
    """Naive UTC ``datetime`` for SQLAlchemy column defaults.

    Replaces the deprecated ``_utcnow`` callable. Returns a naive
    UTC datetime so values are consistent with the existing schema —
    every ``DateTime`` column in this module is naive.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


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
logger = logging.getLogger(__name__)


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
    # Optional: GitHub avatar URL captured on OAuth upsert. The sidebar
    # identity badge falls back to an initial-letter placeholder when
    # missing (token-auth / guest sessions never have one).
    avatar_url = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    organizations = relationship("Organization", back_populates="owner")
    projects = relationship("Project", back_populates="owner")


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, index=True)
    owner_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    owner = relationship("User", back_populates="organizations")
    projects = relationship("Project", back_populates="organization")


class Project(Base):
    __tablename__ = "projects"
    # Unique constraint on (org_id, name) prevents duplicate projects per organization
    __table_args__ = (
        UniqueConstraint(
            "org_id",
            "name",
            name="uq_projects_org_id_name",
        ),
    )

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"))
    owner_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"))
    name = Column(String, index=True)
    use_case = Column(Enum(UseCaseType), index=True)
    deployment_model = Column(Enum(DeploymentModel), default=DeploymentModel.SELF_HOSTED)
    source_type = Column(String, default=ProjectSourceType.GITHUB.value)
    local_folder_path = Column(String, nullable=True)
    launch_url = Column(String, nullable=True)
    # Public-facing URL where this project is published to end users —
    # GitHub Pages site, custom domain, Vercel preview, etc. Separate
    # from `launch_url` (which points at the local dev/preview server)
    # because the user often wants to surface BOTH: "click to preview
    # locally" and "share the live site." Stored as the raw URL string
    # without any liveness probing.
    live_url = Column(String, nullable=True)
    repo_url = Column(String)
    repo_branch = Column(String, default="main")
    # User-provided override for the install/build pipeline. When NULL the
    # builder picks a sensible default at deploy time based on the lockfile
    # present in the cloned repo (npm/pnpm/yarn/bun) plus the project's
    # use_case. See watchtower/builder.py:_resolve_build_command.
    build_command = Column(String, nullable=True)
    webhook_secret = Column(String)
    # Port WatchTower picked (or the user accepted/overrode) at create
    # time. Used as the deploy-time default for the local-podman runner;
    # re-validated at bind time, so a port that's free at create time
    # but taken at deploy time falls through to a fresh pick.
    recommended_port = Column(Integer, nullable=True)
    # Phase 1 of autonomous global-deploy: when True, deploys wrap the
    # build artifact in a Podman container on the remote node (nginx:alpine
    # for static sites) instead of relying on a pre-existing webserver to
    # serve the rsync'd files. Default False keeps existing projects on
    # the legacy rsync+reload_command path until they opt in.
    run_as_container = Column(Boolean, default=False, nullable=False)
    # Phase 4: when True, the API process probes this project's container
    # every WATCHTOWER_AUTONOMOUS_INTERVAL_SECS, restarts it on transient
    # failure, and rolls back to the previous LIVE deployment if restarts
    # don't recover. No-op without run_as_container — the probe needs the
    # canonical bound port to be present.
    autonomous_mode = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    organization = relationship("Organization", back_populates="projects")
    owner = relationship("User", back_populates="projects")
    deployments = relationship("Deployment", back_populates="project", cascade="all, delete-orphan")
    custom_domains = relationship("CustomDomain", back_populates="project", cascade="all, delete-orphan")
    env_variables = relationship("EnvironmentVariable", back_populates="project", cascade="all, delete-orphan")
    database_links = relationship(
        "ProjectDatabaseLink",
        back_populates="project",
        cascade="all, delete-orphan",
    )


class Deployment(Base):
    __tablename__ = "deployments"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), index=True)
    commit_sha = Column(String)
    commit_message = Column(String, nullable=True)
    branch = Column(String)
    status = Column(Enum(DeploymentStatus), default=DeploymentStatus.PENDING, index=True)
    trigger = Column(Enum(DeploymentTrigger), default=DeploymentTrigger.MANUAL)
    pr_number = Column(Integer, nullable=True)  # For PR preview deployments
    # Who kicked this off. Nullable because webhook/scheduled/self-heal
    # deploys have no interactive user, and pre-existing rows predate the
    # column. Deliberately NOT a hard FK — users can be deleted, and we'd
    # rather keep the deploy's audit trail ("triggered by <uuid>") than
    # cascade-null or block deletion. Resolved to an email at read time.
    triggered_by_user_id = Column(Uuid(as_uuid=True), nullable=True, index=True)
    created_at = Column(DateTime, default=_utcnow, index=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    project = relationship("Project", back_populates="deployments")
    builds = relationship("Build", back_populates="deployment", cascade="all, delete-orphan")

    __table_args__ = (
        # "Latest deployments for project X" is the canonical hot path
        # (deployments list, dashboard, rollback target lookup). Composite
        # lets the planner do a single index range-scan instead of
        # filter-then-sort.
        Index("ix_deployments_project_created", "project_id", "created_at"),
    )


class Build(Base):
    __tablename__ = "builds"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    deployment_id = Column(Uuid(as_uuid=True), ForeignKey("deployments.id"), index=True)
    status = Column(Enum(BuildStatus), default=BuildStatus.PENDING, index=True)
    container_id = Column(String, nullable=True)  # Podman container ID
    build_command = Column(String)
    build_output = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    deployment = relationship("Deployment", back_populates="builds")

    __table_args__ = (
        # "Latest build for deployment X" — used by diagnose/auto-fix and
        # build-status panels. Without this the rollback path scans the
        # entire builds table on every click.
        Index("ix_builds_deployment_started", "deployment_id", "started_at"),
    )

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
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), index=True)
    domain = Column(String, unique=True, index=True)
    is_primary = Column(Boolean, default=False)
    tls_enabled = Column(Boolean, default=True)
    tls_cert_path = Column(String, nullable=True)
    letsencrypt_validated = Column(Boolean, default=False)

    # Cloudflare-managed DNS (Phase 2 of the CF integration). When set,
    # WatchTower owns the A record for this domain; sync endpoint uses
    # the credential's token to create/update/delete the record. The
    # zone_id is cached so each sync skips the per-zone lookup roundtrip.
    cloudflare_credential_id = Column(
        Uuid(as_uuid=True), ForeignKey("cloudflare_credentials.id"),
        nullable=True, index=True,
    )
    cloudflare_zone_id = Column(String, nullable=True)
    cloudflare_record_id = Column(String, nullable=True)
    cloudflare_target_ip = Column(String, nullable=True)
    cloudflare_synced_at = Column(DateTime, nullable=True)
    # Set when this domain is served via a Cloudflare Tunnel (Go Live's
    # tunnel mode) rather than a plain A record. Persisted so the tunnel
    # can be torn down on project/domain delete instead of orphaning a
    # billable connector on the user's Cloudflare account.
    cloudflare_tunnel_id = Column(String, nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    project = relationship("Project", back_populates="custom_domains")
    cloudflare_credential = relationship("CloudflareCredential")


class EnvironmentVariable(Base):
    __tablename__ = "environment_variables"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), index=True)
    key = Column(String)
    value = Column(String)  # Should be encrypted in production
    environment = Column(Enum(Environment), default=Environment.PRODUCTION)
    created_at = Column(DateTime, default=_utcnow)

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
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    user = relationship("User", backref="github_connections")
    organization = relationship("Organization", backref="github_connections")


class GitHubDeviceConnectSession(Base):
    """Persistent state for GitHub Device Flow used by repo-connect UX.

    This replaces process-local memory so polling survives API restarts and
    multi-worker deployments.
    """
    __tablename__ = "github_device_connect_sessions"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # `unique=True` already creates an implicit index in both SQLite (autoindex)
    # and Postgres, so a separate `index=True` would be redundant — the original
    # migration mistakenly created both, leaving a duplicate non-unique index
    # that the follow-up migration drops.
    device_code = Column(String, nullable=False, unique=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)

    user = relationship("User", backref="github_device_connect_sessions")
    organization = relationship("Organization", backref="github_device_connect_sessions")


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
    joined_at = Column(DateTime, default=_utcnow)
    invited_at = Column(DateTime, nullable=True)

    invitation_token = Column(String(64), nullable=True, unique=True, index=True)
    accepted_at = Column(DateTime, nullable=True)

    organization = relationship("Organization", backref="team_members")
    user = relationship("User", backref="team_memberships")


class InstallationClaim(Base):
    """Singleton record describing who owns this WatchTower installation."""
    __tablename__ = "installation_claims"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), unique=True)
    owner_github_id = Column(Integer, nullable=True)
    owner_login = Column(String, nullable=True)
    claimed_at = Column(DateTime, default=_utcnow)
    github_connected_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

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

    # Phase 5: provider tracking for auto-provisioned nodes. NULL on
    # manually-registered nodes (the pre-Phase-5 path). When set, the
    # delete-node endpoint can also tear down the underlying VM.
    provider = Column(String, nullable=True)                # 'digitalocean' | 'hetzner'
    provider_resource_id = Column(String, nullable=True)    # droplet id / Hetzner server id
    provider_credential_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("cloud_provider_credentials.id"),
        nullable=True,
    )
    provisioned_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    organization = relationship("Organization", backref="nodes")
    networks = relationship("NodeNetwork", secondary="node_network_members", back_populates="nodes")
    provider_credential = relationship("CloudProviderCredential")


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
    
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

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
    
    added_at = Column(DateTime, default=_utcnow)


class DeploymentNode(Base):
    """Which node a deployment was deployed to"""
    __tablename__ = "deployment_nodes"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    deployment_id = Column(Uuid(as_uuid=True), ForeignKey("deployments.id"), index=True)
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
    related_project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), index=True)
    order_index = Column(Integer, default=0)
    note = Column(String, nullable=True)
    created_at = Column(DateTime, default=_utcnow)

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
    created_at = Column(DateTime, default=_utcnow, index=True)

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


class CloudflareCredential(Base):
    """A Cloudflare API token scoped to one org.

    Stored encrypted via ``encrypt_secret`` (Fernet, key in
    ``WATCHTOWER_SECRET_KEY``); the plaintext token only round-trips
    through ``decrypt_secret`` at use time. The ``account_id`` is the
    Cloudflare account UUID the token is scoped to — surfaced so the
    UI can show "which Cloudflare account am I connected to" without
    decrypting the token.

    One row per org. The label is operator-chosen (e.g. "Personal CF",
    "Work CF") so multi-account flows are possible later, but Phase 1
    treats the most-recent row per org as the active credential.
    """
    __tablename__ = "cloudflare_credentials"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True)
    label = Column(String, nullable=True)
    account_id = Column(String, nullable=True)            # Cloudflare account UUID
    account_name = Column(String, nullable=True)          # Cloudflare account display name
    api_token_encrypted = Column(Text, nullable=False)    # encrypt_secret() output
    last_verified_at = Column(DateTime, nullable=True)    # last successful CF API ping
    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    organization = relationship("Organization", backref="cloudflare_credentials")
    created_by = relationship("User")


class ProvisioningJob(Base):
    """Phase 5 step 2: a record of an in-flight or completed VM
    provisioning attempt against an external cloud provider.

    State machine (status column):
      queued → creating_vm → waiting_for_ready → installing_stack →
        verifying → registered
      … with 'failed' / 'cancelled' as terminals from any step.

    Why a table (not just in-memory like autonomous-mode probe state):
      - Provisioning can take 2-5 minutes. The UI polls — restarting
        the API mid-provision must not lose progress.
      - The cleanup path (delete the VM if registration failed) needs
        provider_resource_id to survive a crash. In-memory loses it.
      - Operator wants a history: "what did I provision when, did it
        succeed." That's a real audit need, not transient state.
    """
    __tablename__ = "provisioning_jobs"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True)
    provider_credential_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("cloud_provider_credentials.id"),
        nullable=False,
    )
    provider = Column(String, nullable=False)  # denormalised from credential so a deleted cred doesn't orphan history
    region = Column(String, nullable=False)
    size = Column(String, nullable=False)
    name = Column(String, nullable=False)
    status = Column(String, nullable=False, default="queued", index=True)
    error = Column(Text, nullable=True)
    provider_resource_id = Column(String, nullable=True)
    public_ipv4 = Column(String, nullable=True)
    node_id = Column(Uuid(as_uuid=True), ForeignKey("org_nodes.id"), nullable=True)
    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    organization = relationship("Organization", backref="provisioning_jobs")
    provider_credential = relationship("CloudProviderCredential")
    node = relationship("OrgNode")
    created_by = relationship("User")


class CloudProviderCredential(Base):
    """Phase 5: an org-scoped API token for an IaaS provider (DigitalOcean
    or Hetzner today). The auto-provisioning flow decrypts this at
    use-time to call the provider's REST API, create a VM, and register
    it as an OrgNode.

    Stored encrypted via ``encrypt_secret``. ``account_email`` is captured
    on the verify call so the UI can show "connected as foo@bar.com"
    without decrypting the token on every list.

    Provider is a String, not an Enum, so a third provider lands without
    a schema migration; the API layer validates against ``SUPPORTED_PROVIDERS``.
    """
    __tablename__ = "cloud_provider_credentials"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True)
    provider = Column(String, nullable=False)  # 'digitalocean' | 'hetzner'
    label = Column(String, nullable=True)
    api_token_encrypted = Column(Text, nullable=False)
    account_email = Column(String, nullable=True)
    last_verified_at = Column(DateTime, nullable=True)
    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)

    organization = relationship("Organization", backref="cloud_provider_credentials")
    created_by = relationship("User")


class NotificationWebhook(Base):
    """Discord / Slack webhook for deployment notifications per project."""
    __tablename__ = "notification_webhooks"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), nullable=True, index=True)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True)
    provider = Column(String, default="discord")   # "discord" | "slack"
    url = Column(String)                            # Webhook URL
    label = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)

    project = relationship("Project", backref="notification_webhooks")


class ManagedDatabaseStatus(str, enum.Enum):
    """Lifecycle states for a WatchTower-managed database pod.

    `creating`/`deleting` are transient — the API sets them while the
    podman command runs and clears them on completion. `failed` means
    the last lifecycle action errored; the operator can retry from the
    UI. The pod may still exist in podman with stale data — failure
    paths try to clean up but never trust that they succeeded.
    """
    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"
    DELETING = "deleting"


class ManagedDatabase(Base):
    """A WatchTower-managed database instance running in a Podman pod.

    Phase v0: single-node only (the host running this API instance).
    Phase v1 will add a Replica row + primary/standby roles for HA.

    The pod contains a single container today (the database). The pod
    abstraction exists so v1 can sidecar `pg_exporter` / `pgbackrest`
    in the same network namespace without changing the data model.
    """
    __tablename__ = "managed_databases"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True, index=True)

    # User-facing identity
    name = Column(String, nullable=False, index=True)        # e.g. "blog-prod"
    engine = Column(String, nullable=False, default="postgres")  # only "postgres" in v0
    version = Column(String, nullable=False, default="16")    # postgres major version

    # Pod / container plumbing (set when create() runs podman)
    image = Column(String, nullable=False)                   # full image ref incl. tag
    pod_name = Column(String, nullable=False, unique=True)   # podman pod name
    container_name = Column(String, nullable=False, unique=True)
    volume_name = Column(String, nullable=False)             # podman named volume

    # Connection
    host = Column(String, nullable=False, default="127.0.0.1")
    port = Column(Integer, nullable=False)
    database_name = Column(String, nullable=False, default="appdb")
    username = Column(String, nullable=False, default="watchtower")
    # Fernet-encrypted password. Surfaced once on create; the operator
    # can request a reveal later via an explicit endpoint (audit-logged).
    password_encrypted = Column(Text, nullable=False)

    # State
    status = Column(Enum(ManagedDatabaseStatus), default=ManagedDatabaseStatus.CREATING, nullable=False)
    status_message = Column(String, nullable=True)
    last_status_at = Column(DateTime, nullable=True)

    # Scheduled backups (v1.1 — companion to on-demand pg_dump in
    # ManagedDatabaseBackup). `schedule_cron` is a standard 5-field cron
    # string ("min hour dom month dow"); NULL means no schedule.
    # `schedule_retention_count` caps the number of scheduled backups
    # kept on disk — older ones get pruned after each successful run.
    # Manual (on-demand) backups are NEVER pruned by the scheduler.
    schedule_cron = Column(String, nullable=True)
    schedule_retention_count = Column(Integer, default=7, nullable=False)
    last_scheduled_backup_at = Column(DateTime, nullable=True)

    # Audit-light columns (full audit lives in audit_events)
    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    organization = relationship("Organization", backref="managed_databases")
    replicas = relationship(
        "ManagedDatabaseReplica",
        back_populates="primary",
        cascade="all, delete-orphan",
    )
    backups = relationship(
        "ManagedDatabaseBackup",
        back_populates="database",
        cascade="all, delete-orphan",
    )


class ReplicaRole(str, enum.Enum):
    """Where the replica sits in the cluster.

    * STANDBY  — streaming WAL from the primary, read-only.
    * PROMOTED — was a standby, was promoted via `pg_promote()`. Now
                 accepting writes. The original ManagedDatabase row is
                 the *old* primary (now stale / stopped); the PROMOTED
                 replica is the *new* primary. Apps should switch
                 connection strings.

    There is intentionally no `PRIMARY` role here — the primary is the
    parent ManagedDatabase row itself. This keeps the data model linear
    and avoids two rows simultaneously claiming primary-ness.
    """
    STANDBY = "standby"
    PROMOTED = "promoted"


class ReplicaStatus(str, enum.Enum):
    INITIALIZING = "initializing"   # pg_basebackup running
    STREAMING = "streaming"         # healthy WAL streaming
    FAILED = "failed"
    PROMOTED = "promoted"           # post-failover (mirrors role for fast filtering)


class ManagedDatabaseReplica(Base):
    """A standby (or promoted-ex-standby) for a ManagedDatabase primary.

    v1 limitation: single-PC only. The replica pod runs on the same host
    as the primary, with `--network host` so the standby connects to
    the primary at `127.0.0.1:<primary_port>`. v2 will add a `node_id`
    FK so standbys can run on remote PCs reachable via Tailscale.
    """
    __tablename__ = "managed_database_replicas"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    primary_db_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("managed_databases.id"),
        nullable=False,
        index=True,
    )

    # Pod / container plumbing for the replica itself
    name = Column(String, nullable=False, index=True)
    pod_name = Column(String, nullable=False, unique=True)
    container_name = Column(String, nullable=False, unique=True)
    volume_name = Column(String, nullable=False)
    host = Column(String, nullable=False, default="127.0.0.1")
    port = Column(Integer, nullable=False)

    # Replication slot name on the primary. Tracking this lets us drop
    # the slot on `remove replica` so the primary doesn't accumulate
    # orphaned slots that pin WAL indefinitely.
    replication_slot_name = Column(String, nullable=False)

    role = Column(Enum(ReplicaRole), default=ReplicaRole.STANDBY, nullable=False)
    status = Column(Enum(ReplicaStatus), default=ReplicaStatus.INITIALIZING, nullable=False)
    status_message = Column(String, nullable=True)
    last_status_at = Column(DateTime, nullable=True)

    # Last observed replay lag, populated by an explicit refresh (not
    # by every list call — querying both DBs on every list would be
    # expensive). NULL means "never measured."
    last_lag_seconds = Column(Integer, nullable=True)
    last_health_check = Column(DateTime, nullable=True)

    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    primary = relationship("ManagedDatabase", back_populates="replicas")


class BackupStatus(str, enum.Enum):
    RUNNING = "running"     # pg_dump in progress
    READY = "ready"         # file on disk, restorable
    FAILED = "failed"       # pg_dump exited non-zero — see status_message


class ManagedDatabaseBackup(Base):
    """An on-demand snapshot of a managed database, taken via pg_dump.

    v0 scope: file lives on the host disk under ``$WATCHTOWER_DATA_DIR/
    managed_db_backups/<db_id>/<timestamp>.dump``. v1 will add scheduled
    backups + off-host storage targets (S3, remote-PC over Tailscale).

    We store metadata in the DB and the dump itself on disk because the
    dumps are arbitrarily large (gigabytes for real DBs) and reading
    them back through ORM/JSON is not a workflow anyone wants.
    """
    __tablename__ = "managed_database_backups"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    primary_db_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("managed_databases.id"),
        nullable=False,
        index=True,
    )
    # User-facing label. Free-form; the timestamp goes in `created_at`.
    label = Column(String, nullable=True)
    # Absolute host path to the dump file. Computed at create time so
    # we can serve / delete without re-deriving from the timestamp.
    file_path = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=True)
    # pg_dump format. v0 always emits "custom" (-Fc) so restores can be
    # done with pg_restore. Stored so v1's multi-engine support can
    # mix in "sqldump" (MySQL) or "bson" (Mongo).
    format = Column(String, nullable=False, default="pgcustom")

    status = Column(Enum(BackupStatus), default=BackupStatus.RUNNING, nullable=False)
    status_message = Column(String, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # Distinguishes scheduler-created backups from on-demand ones. The
    # retention prune only deletes is_scheduled=True rows so the operator's
    # manually-clicked snapshots stick around indefinitely.
    is_scheduled = Column(Boolean, default=False, nullable=False)

    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    database = relationship("ManagedDatabase", back_populates="backups")


class ExternalDatabase(Base):
    """A user-supplied connection to a database WatchTower does NOT manage.

    Counterpart to ManagedDatabase. WatchTower stores the connection
    metadata (host, port, db_name, user, encrypted password) so apps
    deployed via WatchTower can reference it by name, but the lifecycle
    (starting / stopping / upgrading / backups) is the user's problem.

    This is the bring-your-own option for users who already run a
    Postgres on RDS / Supabase / their NAS / a different PC.
    """
    __tablename__ = "external_databases"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True, index=True)

    name = Column(String, nullable=False, index=True)
    engine = Column(String, nullable=False)   # matches ManagedDatabase engine ids
    host = Column(String, nullable=False)
    port = Column(Integer, nullable=False)
    database_name = Column(String, nullable=False, default="")
    username = Column(String, nullable=False, default="")
    password_encrypted = Column(Text, nullable=False, default="")
    use_tls = Column(Boolean, default=True, nullable=False)
    notes = Column(String, nullable=True)

    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    organization = relationship("Organization", backref="external_databases")


class ProjectDatabaseLink(Base):
    """Bind a project to a database (managed OR external) for env-var injection.

    The deploy pipeline (builder.py) reads these on every build, resolves
    each link to a connection string, and exposes the result to the app
    container as an environment variable. Typical pattern: link a
    Postgres + name the env var ``DATABASE_URL`` and the app picks it up
    automatically (Django/Rails/Next.js/Sequelize/SQLAlchemy all read
    that by convention).

    Exactly ONE of ``managed_database_id`` and ``external_database_id``
    must be set per row — enforced application-side in the router since
    SQLite doesn't support partial unique constraints cleanly across
    backends.

    Multiple links per project are allowed (e.g. a primary Postgres
    plus a Redis cache). Each has its own ``env_var_name`` so apps can
    receive ``DATABASE_URL`` + ``REDIS_URL`` from the same flow.
    """
    __tablename__ = "project_database_links"
    __table_args__ = (
        # Same project can't have two links with the same env var name —
        # second one would silently overwrite the first in the deploy env.
        UniqueConstraint("project_id", "env_var_name",
                         name="uq_project_db_links_project_env_var"),
    )

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id"),
        nullable=False,
        index=True,
    )
    managed_database_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("managed_databases.id"),
        nullable=True,
    )
    external_database_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("external_databases.id"),
        nullable=True,
    )

    # The env var the connection string will be injected as. Defaults to
    # the conventional DATABASE_URL; the operator can override for
    # multi-DB setups (REDIS_URL, MONGODB_URI, etc.).
    env_var_name = Column(String, nullable=False, default="DATABASE_URL")

    # Lets the operator pause injection without unlinking — useful when
    # debugging a deploy that's misbehaving due to env-var collision.
    is_active = Column(Boolean, default=True, nullable=False)

    # Free-text. Surfaced in the UI next to the link so operators can
    # explain why this binding exists ("prod replica for analytics",
    # "session cache for the Rails app").
    notes = Column(String, nullable=True)

    created_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)

    project = relationship("Project", back_populates="database_links")
    managed_database = relationship("ManagedDatabase", backref="project_links")
    external_database = relationship("ExternalDatabase", backref="project_links")


class SystemSetting(Base):
    """Instance-wide key-value settings the operator edits from the UI.

    Backs runtime-configurable knobs that previously required env vars —
    first consumer is the LLM agent connection (base URL / API key /
    model) and the self-heal autonomy switch. Env vars still work as a
    fallback for everything stored here, so headless/compose installs
    keep their existing configuration surface.

    ``is_secret`` rows hold values encrypted with ``util.encrypt_secret``
    (Fernet) — never store a secret here as plaintext.
    """
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)
    is_secret = Column(Boolean, default=False, nullable=False)
    updated_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class HealingActionStatus(str, enum.Enum):
    PENDING = "pending"            # waiting for a human decision
    AUTO_APPLIED = "auto_applied"  # autonomous mode applied the fix itself
    APPROVED = "approved"          # human approved → fix applied / retried
    DISMISSED = "dismissed"        # human dismissed without acting
    FAILED = "failed"              # applying the fix raised — see error


class HealingAction(Base):
    """One self-heal decision for one failed deployment.

    The self-heal tick (watchtower/self_heal.py) creates exactly one row
    per failed deployment: the diagnosis from failure_analyzer, the
    optional LLM analysis for unknown failures, and what happened next.
    Rows in PENDING form the human-intervention queue; AUTO_APPLIED rows
    are the audit trail of what autonomous mode did on its own.
    """
    __tablename__ = "healing_actions"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = Column(Uuid(as_uuid=True), ForeignKey("organizations.id"), nullable=True, index=True)
    project_id = Column(Uuid(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    deployment_id = Column(
        Uuid(as_uuid=True),
        ForeignKey("deployments.id"),
        nullable=False,
        unique=True,  # one healing decision per deployment — the tick's idempotency anchor
    )

    failure_kind = Column(String(50), nullable=False)   # FailureKind value
    cause = Column(Text, nullable=True)
    fix_description = Column(Text, nullable=True)
    auto_applicable = Column(Boolean, default=False, nullable=False)
    # Free-form root-cause analysis from the configured LLM, populated
    # only for UNKNOWN failures when an LLM endpoint is configured.
    llm_analysis = Column(Text, nullable=True)

    status = Column(Enum(HealingActionStatus), default=HealingActionStatus.PENDING, nullable=False)
    # The retry deployment queued by apply/approve, for deep-linking.
    result_deployment_id = Column(Uuid(as_uuid=True), nullable=True)
    error = Column(Text, nullable=True)

    created_at = Column(DateTime, default=_utcnow)
    resolved_at = Column(DateTime, nullable=True)
    resolved_by_user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=True)

    project = relationship("Project", backref="healing_actions")


class LegalAcceptance(Base):
    """Append-only record that a user accepted the legal documents.

    One row per acceptance event — never updated, never deleted. The
    (user_id, terms_version) pair is what the login gate checks; the
    timestamp and IP make each row usable as evidence that a specific
    user agreed to a specific version at a specific time. Canonical
    document text + version live in watchtower/legal_docs.py.
    """
    __tablename__ = "legal_acceptances"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    user_email = Column(String, nullable=True)  # denormalised — survives user renames
    terms_version = Column(String(20), nullable=False)
    ip_address = Column(String(64), nullable=True)
    accepted_at = Column(DateTime, default=_utcnow, nullable=False)


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

    Production deployments can bypass this with
    ``WATCHTOWER_SKIP_DB_INIT=true`` and invoke ``alembic upgrade``
    explicitly during release; ``init_db`` exists so single-process
    desktop / dev / test starts "just work."
    """
    if os.getenv("WATCHTOWER_SKIP_DB_INIT", "").lower() == "true":
        return

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    has_app_tables = bool(existing_tables - {"alembic_version"})
    has_alembic_table = "alembic_version" in existing_tables

    # Fast path: the dominant case is a desktop/dev restart where the DB is
    # already at head. Loading the Alembic ScriptDirectory + running upgrade
    # costs ~70 ms even when no migrations apply. Skip it if a cheap file
    # scan + single-row query proves we're up to date.
    if has_app_tables and has_alembic_table:
        head = _head_from_version_files()
        current = _current_alembic_version()
        if head and current and head == current:
            return

    cfg = _alembic_config()
    if has_app_tables and not has_alembic_table:
        # Adopt: assume the existing schema matches baseline. The previous
        # _ensure_*_columns() helpers kept this true.
        from alembic import command
        command.stamp(cfg, "head")
    else:
        from alembic import command
        from alembic.util.exc import CommandError

        try:
            command.upgrade(cfg, "head")
        except CommandError as exc:
            missing_rev = _missing_revision_from_alembic_error(str(exc))
            current_rev = _current_alembic_version()
            is_sqlite = str(engine.url).startswith("sqlite")

            # Recovery path for packaged installs that shipped an incomplete
            # migration directory: if the DB's recorded revision is exactly
            # the missing revision, re-stamp to available head and continue.
            if (
                is_sqlite
                and missing_rev
                and current_rev
                and current_rev == missing_rev
                and os.getenv("WATCHTOWER_DISABLE_ALEMBIC_SELF_HEAL", "").lower() != "true"
            ):
                logger.warning(
                    "Alembic revision '%s' not found in bundled migrations; "
                    "attempting sqlite self-heal by stamping to head.",
                    missing_rev,
                )
                command.stamp(cfg, "head")
                command.upgrade(cfg, "head")
            else:
                raise


def _missing_revision_from_alembic_error(message: str) -> str | None:
    """Extract missing Alembic revision ID from common CommandError text."""
    m = re.search(r"(?:locate revision identified by|No such revision or branch) ['\"]([0-9a-fA-F]+)['\"]", message)
    return m.group(1) if m else None


def _current_alembic_version() -> str | None:
    """Read the single ``version_num`` from ``alembic_version`` without
    loading Alembic. Returns ``None`` if the table is empty / unreadable
    (caller falls through to the full Alembic path)."""
    try:
        with engine.connect() as conn:
            row = conn.execute(text("SELECT version_num FROM alembic_version")).fetchone()
            return row[0] if row else None
    except Exception:
        return None


def _head_from_version_files() -> str | None:
    """Compute the migration head by parsing ``alembic/versions/*.py``
    (revision + down_revision strings only — no Alembic import). Returns
    ``None`` if the directory has zero or multiple heads (branching),
    forcing the slow path so Alembic can resolve them properly."""
    import re
    from pathlib import Path

    versions_dir = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    if not versions_dir.is_dir():
        return None

    # Must accept BOTH styles alembic templates have emitted over time:
    #   revision = 'abc123'                      (old, unannotated)
    #   revision: str = 'abc123'                 (new, type-annotated)
    # and non-hex revision ids (e.g. 'add_unique_project_name').
    # Matching only the unannotated hex subset made this scan compute a
    # stale head equal to older DBs' current revision, so the fast path
    # said "up to date" and silently skipped every newer migration.
    rev_re = re.compile(
        r"^revision(?:\s*:\s*[^=\n]+)?\s*=\s*['\"]([\w.\-]+)['\"]", re.MULTILINE
    )
    down_re = re.compile(
        r"^down_revision(?:\s*:\s*[^=\n]+)?\s*=\s*['\"]([\w.\-]+)['\"]", re.MULTILINE
    )

    revisions: set[str] = set()
    referenced: set[str] = set()
    for path in versions_dir.glob("*.py"):
        try:
            content = path.read_text(encoding="utf-8")
        except OSError:
            return None
        m_rev = rev_re.search(content)
        if not m_rev:
            continue
        revisions.add(m_rev.group(1))
        for m_down in down_re.finditer(content):
            referenced.add(m_down.group(1))

    heads = revisions - referenced
    return next(iter(heads)) if len(heads) == 1 else None


def _alembic_config():
    """Build an Alembic Config pointing at our migrations dir.

    Search order:
      1. ``WATCHTOWER_ALEMBIC_DIR`` env override (operator escape hatch).
      2. Inside the watchtower package (``watchtower/alembic/``) — used
         by the bundled-Python desktop install (1.11+) and by any wheel
         install that includes the migrations as package data.
      3. Sibling of the watchtower module (``<repo_root>/alembic/``) —
         used by dev-clone runs (`pip install -e .` from a checkout).

    We pick the FIRST candidate whose ``env.py`` exists so a partial
    install (e.g. an older wheel without bundled migrations) doesn't
    silently match an empty directory.
    """
    from pathlib import Path
    from alembic.config import Config

    candidates: list[Path] = []
    env_override = os.getenv("WATCHTOWER_ALEMBIC_DIR")
    if env_override:
        candidates.append(Path(env_override))
    pkg_dir = Path(__file__).parent
    # Wheel-bundled layout: scripts/build-wheel.sh stages alembic/ into
    # watchtower/_alembic/ (underscore-prefixed to avoid being treated as
    # an importable Python subpackage by setuptools' package-finder).
    # This MUST come before the legacy `pkg_dir / "alembic"` check —
    # 1.16.0 wheels shipped with _alembic but pre-1.16.1 dev clones may
    # have a stale `alembic/` symlink under the package root.
    candidates.append(pkg_dir / "_alembic")
    candidates.append(pkg_dir / "alembic")  # legacy bundled-into-package layout
    candidates.append(pkg_dir.parent / "alembic")  # dev-clone layout

    for alembic_dir in candidates:
        if (alembic_dir / "env.py").is_file():
            # Use a sibling alembic.ini if one exists (dev clone provides
            # one). Otherwise instantiate a bare Config — script_location
            # below is the only thing alembic actually needs from the ini
            # for our use case.
            ini_path = alembic_dir.parent / "alembic.ini"
            cfg = Config(str(ini_path)) if ini_path.is_file() else Config()
            cfg.set_main_option("script_location", str(alembic_dir))
            cfg.set_main_option("sqlalchemy.url", str(engine.url))
            return cfg

    searched = "\n  ".join(str(c) for c in candidates)
    raise RuntimeError(
        f"Could not find alembic/env.py in any expected location:\n  {searched}"
    )
