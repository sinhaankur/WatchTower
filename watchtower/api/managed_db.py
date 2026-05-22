"""Managed databases — WatchTower-owned Postgres instances in Podman pods.

v0 scope:
  * Single-engine (postgres), single-node (this host)
  * Create / list / get / start / stop / delete
  * Password generated server-side, surfaced once on create, stored Fernet-encrypted
  * Connection string assembled from host + port + creds

v1 will add: standby replicas on remote nodes, `pg_basebackup` setup
over Tailscale, manual failover endpoint. The model already has the
header columns (org_id, role-by-implication-of-single-row); replicas
go in a sibling table.

Auth + audit follow the same patterns as the rest of /api.
"""
from __future__ import annotations

import logging
import secrets
from pathlib import Path
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower import managed_db_backup as backup
from watchtower import managed_db_backup_scheduler as backup_scheduler
from watchtower import managed_db_replication as replication
from watchtower import managed_db_runtime as runtime
from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.api.util import utcnow
from watchtower.database import (
    BackupStatus,
    ManagedDatabase,
    ManagedDatabaseBackup,
    ManagedDatabaseReplica,
    ManagedDatabaseStatus,
    ReplicaRole,
    ReplicaStatus,
    get_db,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/managed-databases", tags=["Managed Databases"])


# ── Supported engines / images ───────────────────────────────────────────────
# Single source of truth — versions, image refs, internal port, and env-var
# shape per engine. Whitelisting versions + assembling the image ref ourselves
# keeps user input out of shell-context positions.
#
# Engines deliberately excluded for now:
#   * Oracle — image not on Docker Hub publicly; licensing is its own story.
#   * SQL Server — same licensing issue + the official Linux image is heavy.
#   * Cassandra / ClickHouse — bigger ops surface than we want in v0.
# These can land later by extending this dict.

from dataclasses import dataclass


@dataclass(frozen=True)
class _EngineSpec:
    image_template: str            # e.g. "docker.io/library/postgres:{version}-alpine"
    versions: tuple[str, ...]
    container_port: int            # the engine's listen port inside the container
    env_factory: callable          # (db_name, user, password) -> dict[str, str]
    default_db_name: str
    default_user: str
    # The driver scheme used in connection strings. The frontend hides
    # this from users; the API surfaces it in the connection_string.
    conn_scheme: str


def _postgres_env(db_name: str, user: str, password: str) -> dict[str, str]:
    return {
        "POSTGRES_DB": db_name,
        "POSTGRES_USER": user,
        "POSTGRES_PASSWORD": password,
    }


def _mysql_env(db_name: str, user: str, password: str) -> dict[str, str]:
    # MYSQL_RANDOM_ROOT_PASSWORD avoids us inheriting a blank-root install.
    # The user-facing creds are a separate non-root user.
    return {
        "MYSQL_DATABASE": db_name,
        "MYSQL_USER": user,
        "MYSQL_PASSWORD": password,
        "MYSQL_RANDOM_ROOT_PASSWORD": "yes",
    }


def _mariadb_env(db_name: str, user: str, password: str) -> dict[str, str]:
    return {
        "MARIADB_DATABASE": db_name,
        "MARIADB_USER": user,
        "MARIADB_PASSWORD": password,
        "MARIADB_RANDOM_ROOT_PASSWORD": "yes",
    }


def _mongo_env(db_name: str, user: str, password: str) -> dict[str, str]:
    # Mongo's official image creates a root user from these env vars and
    # initialises the named DB on first boot. The user-facing `db_name`
    # is what apps `use`.
    return {
        "MONGO_INITDB_ROOT_USERNAME": user,
        "MONGO_INITDB_ROOT_PASSWORD": password,
        "MONGO_INITDB_DATABASE": db_name,
    }


def _redis_env(_db_name: str, _user: str, password: str) -> dict[str, str]:
    # Redis has no DB-name / user concept — just AUTH. We pass the
    # password via the official image's `REDIS_PASSWORD` env var; the
    # entrypoint script wires it into the server config.
    return {"REDIS_PASSWORD": password}


_ENGINES: dict[str, _EngineSpec] = {
    "postgres": _EngineSpec(
        image_template="docker.io/library/postgres:{version}-alpine",
        versions=("14", "15", "16", "17"),
        container_port=5432,
        env_factory=_postgres_env,
        default_db_name="appdb",
        default_user="watchtower",
        conn_scheme="postgresql",
    ),
    "mysql": _EngineSpec(
        image_template="docker.io/library/mysql:{version}",
        versions=("8.0", "8.4"),
        container_port=3306,
        env_factory=_mysql_env,
        default_db_name="appdb",
        default_user="watchtower",
        conn_scheme="mysql",
    ),
    "mariadb": _EngineSpec(
        image_template="docker.io/library/mariadb:{version}",
        versions=("10.11", "11.4"),
        container_port=3306,
        env_factory=_mariadb_env,
        default_db_name="appdb",
        default_user="watchtower",
        conn_scheme="mysql",
    ),
    "mongodb": _EngineSpec(
        image_template="docker.io/library/mongo:{version}",
        versions=("6.0", "7.0", "8.0"),
        container_port=27017,
        env_factory=_mongo_env,
        default_db_name="appdb",
        default_user="watchtower",
        conn_scheme="mongodb",
    ),
    "redis": _EngineSpec(
        image_template="docker.io/library/redis:{version}-alpine",
        versions=("7.2", "7.4"),
        container_port=6379,
        env_factory=_redis_env,
        default_db_name="",  # n/a
        default_user="",     # n/a (AUTH only)
        conn_scheme="redis",
    ),
}


def _resolve_engine(engine: str, version: str) -> tuple[_EngineSpec, str]:
    spec = _ENGINES.get(engine)
    if not spec:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported engine '{engine}'. "
                f"Supported: {', '.join(sorted(_ENGINES))}."
            ),
        )
    if version not in spec.versions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported {engine} version '{version}'. "
                f"Supported: {', '.join(spec.versions)}."
            ),
        )
    return spec, spec.image_template.format(version=version)


@router.get("/engines")
async def list_engines(
    _current_user: dict = Depends(util.get_current_user),
) -> list[dict]:
    """Catalogue used by the create modal to populate the engine + version dropdowns."""
    return [
        {
            "id": engine_id,
            "name": engine_id.replace("mariadb", "MariaDB")
                              .replace("mongodb", "MongoDB")
                              .replace("postgres", "PostgreSQL")
                              .replace("mysql", "MySQL")
                              .replace("redis", "Redis"),
            "versions": list(spec.versions),
            "default_db_name": spec.default_db_name,
            "default_user": spec.default_user,
        }
        for engine_id, spec in _ENGINES.items()
    ]


# ── Schemas ──────────────────────────────────────────────────────────────────


class CreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64,
                      description="User-friendly name. Letters, numbers, dashes, underscores.")
    engine: str = Field("postgres")
    version: str = Field("16")
    database_name: str = Field("appdb", min_length=1, max_length=63)
    username: str = Field("watchtower", min_length=1, max_length=63)


def _validate_create_input(body: CreateRequest) -> None:
    """Validate restricted-charset fields up-front so we never feed user
    input into shell-context positions (container names, env vars).
    Done in the handler — Pydantic v2's ValueError-from-validator path
    serialises poorly through our global RequestValidationError handler.
    """
    if not all(c.isalnum() or c in "-_" for c in body.name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="name must contain only letters, numbers, dashes, underscores",
        )
    for field, value in (("database_name", body.database_name), ("username", body.username)):
        if not all(c.isalnum() or c == "_" for c in value):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field} must contain only letters, numbers, underscores",
            )


class CreateResponse(BaseModel):
    """Returned once on create — includes the generated password.

    The plaintext password is shown ONLY here. Subsequent reads via
    /managed-databases/{id} return it only if the caller hits the
    explicit `/credentials` endpoint, which is audit-logged.
    """
    id: str
    name: str
    engine: str
    version: str
    status: str
    host: str
    port: int
    database_name: str
    username: str
    password: str  # plaintext — once
    connection_string: str


class ManagedDbResponse(BaseModel):
    id: str
    name: str
    engine: str
    version: str
    status: str
    status_message: Optional[str] = None
    host: str
    port: int
    database_name: str
    username: str
    pod_name: str
    container_name: str
    image: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class CredentialsResponse(BaseModel):
    password: str
    connection_string: str


# ── Serialisers ──────────────────────────────────────────────────────────────


def _conn_string(db: ManagedDatabase, password: str) -> str:
    # Engine-specific scheme + per-engine path/userinfo conventions.
    # Redis has no db_name / user, so its URL omits both.
    spec = _ENGINES.get(db.engine)
    scheme = spec.conn_scheme if spec else "postgresql"
    if db.engine == "redis":
        return f"{scheme}://:{password}@{db.host}:{db.port}"
    return f"{scheme}://{db.username}:{password}@{db.host}:{db.port}/{db.database_name}"


def _serialize(db: ManagedDatabase) -> ManagedDbResponse:
    return ManagedDbResponse(
        id=str(db.id),
        name=db.name,
        engine=db.engine,
        version=db.version,
        status=db.status.value if hasattr(db.status, "value") else str(db.status),
        status_message=db.status_message,
        host=db.host,
        port=db.port,
        database_name=db.database_name,
        username=db.username,
        pod_name=db.pod_name,
        container_name=db.container_name,
        image=db.image,
        created_at=db.created_at.isoformat() if db.created_at else None,
        updated_at=db.updated_at.isoformat() if db.updated_at else None,
    )


# ── Helpers ──────────────────────────────────────────────────────────────────


def _ensure_runtime():
    if not runtime.have_runtime():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No container runtime found on this host. "
                "Install Podman (https://podman.io/docs/installation) and refresh."
            ),
        )


def _get_or_404(db_session: Session, db_id) -> ManagedDatabase:
    # Coerce whatever FastAPI handed us (string from path, UUID from
    # tests) into a real UUID before the WHERE clause — SQLAlchemy's
    # `Uuid(as_uuid=True)` column processor calls `.hex` on the value
    # and barfs on strings.
    uid = util.to_uuid(db_id)
    row = db_session.query(ManagedDatabase).filter(ManagedDatabase.id == uid).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Database not found")
    return row


def _resolve_org_id(db_session: Session, current_user: dict):
    """Best-effort org resolution. Static-token callers won't have an
    org membership and that's fine — the row gets created without one."""
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _u, org, _m = _ensure_user_org_member(db_session, current_user)
        return org.id
    except Exception:  # noqa: BLE001
        return None


def _restore_to_new(
    db: Session,
    request: Request,
    current_user: dict,
    primary: ManagedDatabase,
    backup_row: ManagedDatabaseBackup,
    body,  # RestoreBackupRequest (avoid forward-ref to keep function above its use)
):
    """Restore a backup into a brand-new managed database.

    Resource shape: spins up a fresh Podman pod with a NEW volume,
    waits for the engine to be ready, then runs the restore. The
    original primary is untouched. Operators get a side-by-side
    comparison for free — at the cost of running 2× pods until they
    decide which to keep.

    Why this is its own function and not a generic "create + restore"
    composition: the restore is a one-shot operation tied to a
    specific backup; running it through the generic create endpoint
    would mean a brand-new password (and the operator might want the
    SAME password as the original DB so apps with cached connection
    strings still work). We give the new DB a fresh password — the
    operator can choose to re-link any project DB associations.
    """
    new_name = (body.new_name or "").strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="new_name is required when mode='new'.",
        )
    if not all(c.isalnum() or c in "-_" for c in new_name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="new_name must contain only letters, numbers, dashes, underscores.",
        )
    if new_name == primary.name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="new_name must differ from the source database's name.",
        )
    if db.query(ManagedDatabase).filter(ManagedDatabase.name == new_name).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A managed database named '{new_name}' already exists.",
        )

    # Mirror engine/version/image so dump-tool versions match — same
    # rule that applies to scheduled and on-demand backups.
    engine_spec = _ENGINES.get(primary.engine)
    if engine_spec is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Source database engine '{primary.engine}' is not in the engine catalogue.",
        )

    new_password = secrets.token_urlsafe(24)
    new_db = ManagedDatabase(
        org_id=primary.org_id,
        name=new_name,
        engine=primary.engine,
        version=primary.version,
        image=primary.image,
        pod_name="",
        container_name="",
        volume_name="",
        host="127.0.0.1",
        port=runtime.pick_free_port(),
        database_name=primary.database_name,
        username=primary.username,
        password_encrypted=util.encrypt_secret(new_password),
        status=ManagedDatabaseStatus.CREATING,
    )
    db.add(new_db)
    db.flush()
    new_db.pod_name = runtime.pod_name(str(new_db.id))
    new_db.container_name = runtime.container_name(str(new_db.id))
    new_db.volume_name = runtime.volume_name(str(new_db.id))

    # Spin up the empty pod. Same shape as the create-DB endpoint.
    env = engine_spec.env_factory(primary.database_name, primary.username, new_password)
    create_spec = runtime.CreateSpec(
        db_id=str(new_db.id),
        image=primary.image,
        host_port=new_db.port,
        container_port=engine_spec.container_port,
        env=env,
    )
    try:
        runtime.create_pod(create_spec)
    except runtime.ManagedDbRuntimeError as exc:
        new_db.status = ManagedDatabaseStatus.FAILED
        new_db.status_message = f"Failed to spin up restore target pod: {exc}"[:500]
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    # Wait for the new pod to be reachable before running the restore.
    # Without this the restore races the engine's init and fails with
    # "connection refused" because the port isn't bound yet.
    try:
        runtime.wait_for_db_ready(
            container=new_db.container_name,
            engine=new_db.engine,
            db_user=new_db.username,
            db_password=new_password,
            db_name=new_db.database_name,
            timeout_s=30,
        )
    except runtime.ManagedDbRuntimeError as exc:
        # Pod started but engine isn't accepting connections. Tear down
        # the half-built target so the operator doesn't have a stuck
        # CREATING row to clean up manually.
        try:
            runtime.delete_pod(str(new_db.id), keep_volume=False)
        except Exception:  # noqa: BLE001
            logger.exception("Cleanup of failed restore target %s also failed", new_db.id)
        db.delete(new_db)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"New database pod didn't become ready: {exc}",
        ) from exc

    # Run the restore against the new pod. Reuses the engine-aware
    # dispatcher — exactly the same restore logic as in-place; the
    # new DB is just empty, so the --clean / DROP IF EXISTS commands
    # in the dump are no-ops.
    spec = backup.RestoreSpec(
        engine=new_db.engine,
        image=new_db.image,
        primary_host="127.0.0.1",
        primary_port=new_db.port,
        db_name=new_db.database_name,
        db_user=new_db.username,
        db_password=new_password,
        host_dump_path=Path(backup_row.file_path),
    )
    try:
        backup.run_restore(spec)
    except backup.BackupError as exc:
        # Restore failed but the new pod is alive and well. Leave it
        # so the operator can investigate (logs, manual pg_restore,
        # etc.) before deciding to delete.
        new_db.status = ManagedDatabaseStatus.FAILED
        new_db.status_message = f"Pod created, restore failed: {exc}"[:500]
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Pod {new_db.name} was created and is running, but the restore failed: {exc}",
        ) from exc

    new_db.status = ManagedDatabaseStatus.RUNNING
    new_db.status_message = None

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.backup.restore_to_new",
        entity_type="managed_database_backup",
        entity_id=backup_row.id,
        org_id=primary.org_id,
        request=request,
        extra={
            "source_db_id": str(primary.id),
            "source_db_name": primary.name,
            "new_db_id": str(new_db.id),
            "new_db_name": new_db.name,
            "backup_label": backup_row.label,
        },
    )
    db.commit()

    return {
        "ok": True,
        "mode": "new",
        "id": str(backup_row.id),
        "source_db_name": primary.name,
        "new_db_id": str(new_db.id),
        "new_db_name": new_db.name,
        "new_db_port": new_db.port,
        "restored_from": {
            "label": backup_row.label,
            "created_at": backup_row.created_at.isoformat() if backup_row.created_at else None,
            "size_bytes": backup_row.size_bytes,
        },
    }


def _refresh_runtime_status(row: ManagedDatabase, db_session: Session) -> None:
    """Sync the row's status with what podman actually reports.

    Cheap (one `podman pod inspect`) and only called from list / get,
    so a deleted-out-from-under-us pod surfaces as `stopped` instead
    of a stale `running`.
    """
    if row.status in (ManagedDatabaseStatus.CREATING, ManagedDatabaseStatus.DELETING):
        return  # transient — leave alone
    actual = runtime.pod_running(str(row.id))
    desired = ManagedDatabaseStatus.RUNNING if actual else ManagedDatabaseStatus.STOPPED
    if row.status != desired:
        row.status = desired
        db_session.commit()


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("/runtime")
async def runtime_status(
    _current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Whether a container runtime is installed. Lets the SPA decide
    between rendering the create button vs. an install prompt."""
    return {"available": runtime.have_runtime()}


@router.get("", response_model=list[ManagedDbResponse])
async def list_databases(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[ManagedDbResponse]:
    rows = db.query(ManagedDatabase).order_by(ManagedDatabase.created_at.desc()).all()
    for row in rows:
        _refresh_runtime_status(row, db)
    return [_serialize(r) for r in rows]


@router.post("", response_model=CreateResponse)
async def create_database(
    body: CreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> CreateResponse:
    _ensure_runtime()
    _validate_create_input(body)
    engine_spec, image = _resolve_engine(body.engine, body.version)

    # Name uniqueness within the install (not just within an org) keeps
    # podman happy — pod_name collisions are global.
    existing = db.query(ManagedDatabase).filter(ManagedDatabase.name == body.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A managed database named '{body.name}' already exists.",
        )

    password = secrets.token_urlsafe(24)
    org_id = _resolve_org_id(db, current_user)

    # Reserve the DB row first so we get an ID; then materialise the
    # podman objects whose names derive from that ID.
    row = ManagedDatabase(
        org_id=org_id,
        name=body.name,
        engine=body.engine,
        version=body.version,
        image=image,
        # Filled below once we know the ID.
        pod_name="",
        container_name="",
        volume_name="",
        host="127.0.0.1",
        port=0,
        database_name=body.database_name,
        username=body.username,
        password_encrypted=util.encrypt_secret(password),
        status=ManagedDatabaseStatus.CREATING,
    )
    db.add(row)
    db.flush()  # populates row.id

    pod = runtime.pod_name(str(row.id))
    container = runtime.container_name(str(row.id))
    volume = runtime.volume_name(str(row.id))
    port = runtime.pick_free_port()

    row.pod_name = pod
    row.container_name = container
    row.volume_name = volume
    row.port = port

    env = engine_spec.env_factory(body.database_name, body.username, password)
    spec = runtime.CreateSpec(
        db_id=str(row.id),
        image=image,
        host_port=port,
        container_port=engine_spec.container_port,
        env=env,
    )
    try:
        runtime.create_pod(spec)
    except runtime.ManagedDbRuntimeError as exc:
        row.status = ManagedDatabaseStatus.FAILED
        row.status_message = str(exc)[:500]
        db.commit()
        # Surface the verbatim podman error to the operator. The DB row
        # remains so they can see what went wrong and either retry or delete.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    row.status = ManagedDatabaseStatus.RUNNING
    row.status_message = None

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.create",
        entity_type="managed_database",
        entity_id=row.id,
        org_id=org_id,
        request=request,
        extra={
            "name": row.name,
            "engine": row.engine,
            "version": row.version,
            "port": row.port,
        },
    )
    db.commit()

    return CreateResponse(
        id=str(row.id),
        name=row.name,
        engine=row.engine,
        version=row.version,
        status=row.status.value,
        host=row.host,
        port=row.port,
        database_name=row.database_name,
        username=row.username,
        password=password,
        connection_string=_conn_string(row, password),
    )


@router.get("/{db_id}", response_model=ManagedDbResponse)
async def get_database(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> ManagedDbResponse:
    row = _get_or_404(db, db_id)
    _refresh_runtime_status(row, db)
    return _serialize(row)


@router.post("/{db_id}/start", response_model=ManagedDbResponse)
async def start_database(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ManagedDbResponse:
    _ensure_runtime()
    row = _get_or_404(db, db_id)
    try:
        runtime.start_pod(str(row.id))
    except runtime.ManagedDbRuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    row.status = ManagedDatabaseStatus.RUNNING
    row.status_message = None
    audit_log.record_for_user(
        db, current_user,
        action="managed_db.start",
        entity_type="managed_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.commit()
    return _serialize(row)


@router.post("/{db_id}/stop", response_model=ManagedDbResponse)
async def stop_database(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ManagedDbResponse:
    _ensure_runtime()
    row = _get_or_404(db, db_id)
    try:
        runtime.stop_pod(str(row.id))
    except runtime.ManagedDbRuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    row.status = ManagedDatabaseStatus.STOPPED
    row.status_message = None
    audit_log.record_for_user(
        db, current_user,
        action="managed_db.stop",
        entity_type="managed_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.commit()
    return _serialize(row)


@router.delete("/{db_id}")
async def delete_database(
    db_id: UUID,
    request: Request,
    purge: bool = False,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Remove the pod + container. If `purge=true`, also delete the data volume."""
    _ensure_runtime()
    row = _get_or_404(db, db_id)
    row.status = ManagedDatabaseStatus.DELETING
    db.commit()
    try:
        runtime.delete_pod(str(row.id), keep_volume=not purge)
    except runtime.ManagedDbRuntimeError as exc:
        row.status = ManagedDatabaseStatus.FAILED
        row.status_message = str(exc)[:500]
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    # Drop any cron schedule for this DB before the row goes — otherwise
    # the scheduler would keep trying to back up a DB that no longer exists
    # (it would eventually self-clean on next fire via the "row missing"
    # branch, but unregistering up front is cleaner + faster).
    backup_scheduler.unregister_schedule(str(row.id))

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.delete",
        entity_type="managed_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name, "purge": purge},
    )
    db.delete(row)
    db.commit()
    return {"ok": True, "id": str(db_id), "purged_volume": purge}


# ── Replicas (HA v1: Postgres streaming replication, single-PC) ──────────────


class CreateReplicaRequest(BaseModel):
    name: Optional[str] = Field(
        default=None, max_length=64,
        description="Display name. Auto-generated from the primary's name if omitted.",
    )


class ReplicaResponse(BaseModel):
    id: str
    primary_db_id: str
    name: str
    role: str
    status: str
    status_message: Optional[str] = None
    host: str
    port: int
    pod_name: str
    container_name: str
    replication_slot_name: str
    last_lag_seconds: Optional[int] = None
    last_health_check: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _serialize_replica(r: ManagedDatabaseReplica) -> ReplicaResponse:
    return ReplicaResponse(
        id=str(r.id),
        primary_db_id=str(r.primary_db_id),
        name=r.name,
        role=r.role.value if hasattr(r.role, "value") else str(r.role),
        status=r.status.value if hasattr(r.status, "value") else str(r.status),
        status_message=r.status_message,
        host=r.host,
        port=r.port,
        pod_name=r.pod_name,
        container_name=r.container_name,
        replication_slot_name=r.replication_slot_name,
        last_lag_seconds=r.last_lag_seconds,
        last_health_check=r.last_health_check.isoformat() if r.last_health_check else None,
        created_at=r.created_at.isoformat() if r.created_at else None,
        updated_at=r.updated_at.isoformat() if r.updated_at else None,
    )


@router.get("/{db_id}/replicas", response_model=list[ReplicaResponse])
async def list_replicas(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[ReplicaResponse]:
    primary = _get_or_404(db, db_id)
    rows = (
        db.query(ManagedDatabaseReplica)
        .filter(ManagedDatabaseReplica.primary_db_id == primary.id)
        .order_by(ManagedDatabaseReplica.created_at.asc())
        .all()
    )
    return [_serialize_replica(r) for r in rows]


@router.post("/{db_id}/replicas", response_model=ReplicaResponse)
async def add_replica(
    db_id: UUID,
    body: CreateReplicaRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ReplicaResponse:
    """Provision a standby for this database.

    v1 limitation: Postgres only, single-PC (the standby runs on the
    same host as the primary). The flow:

      1. Configure the primary for replication + restart it.
      2. Create a replication user + slot on the primary.
      3. Update pg_hba.conf to allow the replication user.
      4. Run `pg_basebackup` into a fresh volume.
      5. Start the standby pod.

    The row lands in FAILED status if any step blows up; the operator
    can retry from the UI after fixing the underlying cause. Partial
    podman state is cleaned up by `provision_standby` on failure.
    """
    _ensure_runtime()
    primary = _get_or_404(db, db_id)

    if primary.engine != "postgres":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Replication is only supported for Postgres in v1 "
                f"(this database is {primary.engine}). "
                f"MySQL/Mongo/Redis replication is planned for v2."
            ),
        )

    if primary.status != ManagedDatabaseStatus.RUNNING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Primary must be RUNNING to add a replica (currently {primary.status.value}). "
                f"Start it and retry."
            ),
        )

    replica_name = body.name or f"{primary.name}-standby"
    if not all(c.isalnum() or c in "-_" for c in replica_name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="replica name must contain only letters, numbers, dashes, underscores",
        )

    # Reserve the row up front so we have an ID for podman naming.
    row = ManagedDatabaseReplica(
        primary_db_id=primary.id,
        name=replica_name,
        pod_name="",
        container_name="",
        volume_name="",
        port=runtime.pick_free_port(),
        replication_slot_name="",
        role=ReplicaRole.STANDBY,
        status=ReplicaStatus.INITIALIZING,
    )
    db.add(row)
    db.flush()  # populates row.id

    slot_name = replication.generate_slot_name(str(row.id))
    repl_user = f"watchtower_repl_{str(row.id).replace('-', '')[:12]}"
    repl_password = replication.generate_replication_password()

    row.pod_name = runtime.pod_name(str(row.id))
    row.container_name = runtime.container_name(str(row.id))
    row.volume_name = runtime.volume_name(str(row.id))
    row.replication_slot_name = slot_name

    try:
        # Steps 1-3: prep the primary.
        replication.configure_primary_for_replication(
            primary.container_name, primary.username, primary.database_name,
        )
        replication.create_replication_user(
            primary.container_name, primary.username, primary.database_name,
            repl_user, repl_password,
        )
        replication.create_replication_slot(
            primary.container_name, primary.username, primary.database_name,
            slot_name,
        )
        replication.allow_replication_in_pg_hba(primary.container_name)

        # Steps 4-5: bootstrap + start the standby.
        spec = replication.StandbySpec(
            replica_id=str(row.id),
            image=primary.image,
            primary_host="127.0.0.1",
            primary_port=primary.port,
            replica_port=row.port,
            repl_user=repl_user,
            repl_password=repl_password,
            slot_name=slot_name,
        )
        replication.provision_standby(spec)
    except replication.ReplicationError as exc:
        row.status = ReplicaStatus.FAILED
        row.status_message = str(exc)[:500]
        row.last_status_at = utcnow()
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    row.status = ReplicaStatus.STREAMING
    row.status_message = None
    row.last_status_at = utcnow()

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.replica.create",
        entity_type="managed_database_replica",
        entity_id=row.id,
        org_id=primary.org_id,
        request=request,
        extra={
            "primary_db_id": str(primary.id),
            "primary_name": primary.name,
            "replica_name": row.name,
            "slot_name": slot_name,
        },
    )
    db.commit()
    return _serialize_replica(row)


@router.post("/{db_id}/replicas/{replica_id}/promote", response_model=ReplicaResponse)
async def promote_replica(
    db_id: UUID,
    replica_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ReplicaResponse:
    """Manual failover: promote this standby to primary.

    What this does:
      1. Calls `pg_promote(true, 60)` on the standby. It becomes
         read-write.
      2. Stops the old primary container so it can't accept writes
         (rudimentary split-brain prevention — v3 will add proper
         witness-quorum fencing).
      3. Marks the replica row PROMOTED + the primary row STOPPED.

    What this does NOT do (operator's responsibility):
      * Update application connection strings. The promoted replica's
        URL is in the response — apps need to switch to it.
      * Set up replication from the new primary back to the old one
        (the "old primary becomes new standby" pattern). Currently the
        old primary stays stopped; you can manually re-bootstrap it.
    """
    _ensure_runtime()
    primary = _get_or_404(db, db_id)
    replica = db.query(ManagedDatabaseReplica).filter(
        ManagedDatabaseReplica.id == util.to_uuid(replica_id),
        ManagedDatabaseReplica.primary_db_id == primary.id,
    ).first()
    if not replica:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Replica not found")
    if replica.role == ReplicaRole.PROMOTED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This replica is already promoted.",
        )
    if replica.status != ReplicaStatus.STREAMING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Replica must be STREAMING to promote (currently {replica.status.value}). "
                f"Wait for replication to catch up, or fix the underlying error first."
            ),
        )

    try:
        replication.promote_standby(
            replica.container_name, primary.username, primary.database_name,
        )
    except replication.ReplicationError as exc:
        replica.status = ReplicaStatus.FAILED
        replica.status_message = str(exc)[:500]
        replica.last_status_at = utcnow()
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    # Fence the old primary so apps that haven't switched URLs yet
    # don't keep writing to it. Best-effort — if it fails the replica
    # is already promoted, surface a warning rather than rolling back.
    replication.stop_container_best_effort(primary.container_name)
    primary.status = ManagedDatabaseStatus.STOPPED
    primary.status_message = (
        "Demoted after manual failover. Switch app connection strings to the promoted replica."
    )

    replica.role = ReplicaRole.PROMOTED
    replica.status = ReplicaStatus.PROMOTED
    replica.status_message = "Promoted to primary via manual failover."
    replica.last_status_at = utcnow()

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.replica.promote",
        entity_type="managed_database_replica",
        entity_id=replica.id,
        org_id=primary.org_id,
        request=request,
        extra={
            "primary_db_id": str(primary.id),
            "primary_name": primary.name,
            "replica_name": replica.name,
        },
    )
    db.commit()
    return _serialize_replica(replica)


@router.delete("/{db_id}/replicas/{replica_id}")
async def remove_replica(
    db_id: UUID,
    replica_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Tear down a standby: stop its pod, drop the replication slot on
    the primary, delete the row.

    Always deletes the data volume — a standby's data is by definition
    a copy of the primary's, so retaining it serves no purpose. The
    primary's data is untouched.
    """
    _ensure_runtime()
    primary = _get_or_404(db, db_id)
    replica = db.query(ManagedDatabaseReplica).filter(
        ManagedDatabaseReplica.id == util.to_uuid(replica_id),
        ManagedDatabaseReplica.primary_db_id == primary.id,
    ).first()
    if not replica:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Replica not found")

    # Stop + remove the pod and its volume. Don't surface failures
    # because a removed-but-stale-podman-state still leaves the user
    # with a working primary; we just log.
    try:
        runtime.delete_pod(str(replica.id), keep_volume=False)
    except runtime.ManagedDbRuntimeError as exc:
        logger.warning("Failed to remove replica pod %s: %s", replica.pod_name, exc)

    # Drop the slot on the primary so it doesn't pin WAL forever.
    # Only attempt if the primary is still running — if it was demoted
    # by a prior failover the slot is moot anyway.
    if primary.status == ManagedDatabaseStatus.RUNNING:
        try:
            replication.drop_replication_slot_best_effort(
                primary.container_name, primary.username, primary.database_name,
                replica.replication_slot_name,
            )
        except Exception:  # noqa: BLE001 — best-effort cleanup
            logger.exception("Failed to drop replication slot %s on primary", replica.replication_slot_name)

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.replica.delete",
        entity_type="managed_database_replica",
        entity_id=replica.id,
        org_id=primary.org_id,
        request=request,
        extra={"primary_name": primary.name, "replica_name": replica.name},
    )
    db.delete(replica)
    db.commit()
    return {"ok": True, "id": str(replica_id)}


# ── Backups (v0: on-demand pg_dump) ─────────────────────────────────────────


class CreateBackupRequest(BaseModel):
    label: Optional[str] = Field(
        default=None, max_length=64,
        description="Optional human label appended to the file name.",
    )


class BackupResponse(BaseModel):
    id: str
    primary_db_id: str
    label: Optional[str] = None
    file_path: str
    size_bytes: Optional[int] = None
    format: str
    status: str
    status_message: Optional[str] = None
    completed_at: Optional[str] = None
    created_at: Optional[str] = None


def _serialize_backup(b: ManagedDatabaseBackup) -> BackupResponse:
    return BackupResponse(
        id=str(b.id),
        primary_db_id=str(b.primary_db_id),
        label=b.label,
        file_path=b.file_path,
        size_bytes=b.size_bytes,
        format=b.format,
        status=b.status.value if hasattr(b.status, "value") else str(b.status),
        status_message=b.status_message,
        completed_at=b.completed_at.isoformat() if b.completed_at else None,
        created_at=b.created_at.isoformat() if b.created_at else None,
    )


@router.get("/{db_id}/backups", response_model=list[BackupResponse])
async def list_backups(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[BackupResponse]:
    primary = _get_or_404(db, db_id)
    rows = (
        db.query(ManagedDatabaseBackup)
        .filter(ManagedDatabaseBackup.primary_db_id == primary.id)
        .order_by(ManagedDatabaseBackup.created_at.desc())
        .all()
    )
    return [_serialize_backup(r) for r in rows]


@router.post("/{db_id}/backups", response_model=BackupResponse)
async def create_backup(
    db_id: UUID,
    body: CreateBackupRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> BackupResponse:
    """Snapshot a managed database to a local dump file.

    v0 is synchronous — the request hangs until `pg_dump` finishes.
    For small DBs this is fine (sub-second to a few seconds). Large
    DBs (>100MB-ish) would benefit from a background-task flow, which
    is planned for v1 alongside scheduled backups.
    """
    _ensure_runtime()
    primary = _get_or_404(db, db_id)

    if primary.engine not in backup.ENGINE_DUMP_FORMAT:
        # v1 supports postgres/mysql/mariadb/mongodb. Redis backups
        # use BGSAVE+copy-RDB rather than a dump tool, so they live in
        # a follow-up.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Backups don't yet support engine '{primary.engine}'. "
                f"Supported: {', '.join(sorted(backup.ENGINE_DUMP_FORMAT))}. "
                f"Redis support is planned for a later release."
            ),
        )

    if primary.status != ManagedDatabaseStatus.RUNNING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Database must be RUNNING to take a backup "
                f"(currently {primary.status.value}). Start it and retry."
            ),
        )

    # Pre-flight: if the operator just clicked "label name" with shell-
    # unsafe chars, we strip in the runtime helper, but reject blatantly-
    # large labels up front for a clearer error.
    if body.label and not all(c.isalnum() or c in "-_ " for c in body.label):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="label must contain only letters, numbers, dashes, underscores, spaces",
        )

    dump_path = backup.backup_path(str(primary.id), body.label)
    row = ManagedDatabaseBackup(
        primary_db_id=primary.id,
        label=body.label,
        file_path=str(dump_path),
        format=backup.ENGINE_DUMP_FORMAT[primary.engine],
        status=BackupStatus.RUNNING,
    )
    db.add(row)
    db.flush()

    password = util.decrypt_secret(primary.password_encrypted)
    spec = backup.BackupSpec(
        engine=primary.engine,
        image=primary.image,
        primary_host="127.0.0.1",
        primary_port=primary.port,
        db_name=primary.database_name,
        db_user=primary.username,
        db_password=password,
        host_dump_path=dump_path,
    )
    try:
        size = backup.run_backup(spec)
    except backup.BackupError as exc:
        row.status = BackupStatus.FAILED
        row.status_message = str(exc)[:500]
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    row.status = BackupStatus.READY
    row.size_bytes = size
    row.completed_at = utcnow()

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.backup.create",
        entity_type="managed_database_backup",
        entity_id=row.id,
        org_id=primary.org_id,
        request=request,
        extra={
            "primary_db_id": str(primary.id),
            "primary_name": primary.name,
            "label": row.label,
            "size_bytes": size,
        },
    )
    db.commit()
    return _serialize_backup(row)


class RestoreBackupRequest(BaseModel):
    """Two modes:

    * **in-place** (default — same shape as v1): replaces the live DB's
      data. Destructive. Requires ``confirm_db_name`` to match the
      target's name exactly.
    * **new**: creates a NEW managed database, spins up a fresh pod
      alongside the original, and restores the backup into it. Safer
      because nothing existing is touched, but **costs 2× resources**
      (two pods, two volumes) until the operator deletes one. Requires
      ``new_name`` — the name of the new database to create.

    In-place stays the default because the resource-cost trade-off
    matters under the user's "keep WatchTower lightweight" constraint.
    Operators who want to compare before-and-after opt into "new"
    deliberately.
    """
    mode: str = Field(
        default="in-place",
        description='"in-place" (destructive, replaces live data) or "new" (creates a new DB).',
    )
    confirm_db_name: Optional[str] = Field(
        default=None,
        description="Required when mode='in-place'. Must match the target DB's name exactly.",
    )
    new_name: Optional[str] = Field(
        default=None,
        max_length=64,
        description="Required when mode='new'. Name for the freshly-created database.",
    )


@router.post("/{db_id}/backups/{backup_id}/restore")
async def restore_backup(
    db_id: UUID,
    backup_id: UUID,
    body: RestoreBackupRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Restore a backup into the live database, replacing its current contents.

    DESTRUCTIVE. Runs pg_restore --clean --if-exists which drops every
    object in the target database and re-creates it from the backup
    dump. Active connections are NOT terminated (--clean drops at the
    object level, not the database level), but in-flight queries
    against affected tables will fail.

    Requires:
      * ``confirm_db_name`` matches the target DB's name. Mid-air
        renames between page-load and click are caught here too.
      * Target DB must be RUNNING. Restoring into a stopped pod would
        succeed silently (the pod would start on a half-populated
        volume next time) — fail fast instead.
      * Backup row must be in READY status. RUNNING / FAILED backups
        are not restorable.

    We intentionally do NOT take an auto-backup-before-restore. The
    operator is encouraged to click "Backup now" first if they want a
    rollback point; making that automatic would mask the destructive
    nature of the operation.
    """
    _ensure_runtime()
    primary = _get_or_404(db, db_id)
    backup_row = db.query(ManagedDatabaseBackup).filter(
        ManagedDatabaseBackup.id == util.to_uuid(backup_id),
        ManagedDatabaseBackup.primary_db_id == primary.id,
    ).first()
    if not backup_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")

    if primary.engine not in backup.ENGINE_DUMP_FORMAT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Restore doesn't yet support engine '{primary.engine}'. "
                f"Supported: {', '.join(sorted(backup.ENGINE_DUMP_FORMAT))}."
            ),
        )

    if primary.status != ManagedDatabaseStatus.RUNNING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Target database must be RUNNING to restore "
                f"(currently {primary.status.value}). Start it and retry."
            ),
        )

    if backup_row.status != BackupStatus.READY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Backup is in '{backup_row.status.value if hasattr(backup_row.status, 'value') else backup_row.status}' "
                f"state — only READY backups can be restored."
            ),
        )

    if body.mode not in ("in-place", "new"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="mode must be 'in-place' or 'new'.",
        )

    # ── Restore-to-new database ─────────────────────────────────────
    # Spins up a NEW pod alongside the original, restores into it,
    # leaves the original untouched. Operator gets a side-by-side
    # comparison for free.
    if body.mode == "new":
        return _restore_to_new(
            db=db, request=request, current_user=current_user,
            primary=primary, backup_row=backup_row, body=body,
        )

    # ── Restore-in-place (the v1 path) ──────────────────────────────
    if body.confirm_db_name != primary.name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"confirm_db_name must match the database name exactly. "
                f"Expected '{primary.name}', got '{body.confirm_db_name}'."
            ),
        )

    password = util.decrypt_secret(primary.password_encrypted)
    spec = backup.RestoreSpec(
        engine=primary.engine,
        image=primary.image,
        primary_host="127.0.0.1",
        primary_port=primary.port,
        db_name=primary.database_name,
        db_user=primary.username,
        db_password=password,
        host_dump_path=Path(backup_row.file_path),
    )

    try:
        backup.run_restore(spec)
    except backup.BackupError as exc:
        # The restore failed — the DB might be in a partial state (some
        # objects dropped before pg_restore errored out). Audit the
        # failure so the operator knows when it happened. Don't try to
        # auto-recover; the user knows what to do (run pg_restore
        # manually with --verbose, or restore an earlier backup).
        audit_log.record_for_user(
            db, current_user,
            action="managed_db.backup.restore.failed",
            entity_type="managed_database_backup",
            entity_id=backup_row.id,
            org_id=primary.org_id,
            request=request,
            extra={
                "primary_name": primary.name,
                "backup_label": backup_row.label,
                "error": str(exc)[:500],
            },
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.backup.restore",
        entity_type="managed_database_backup",
        entity_id=backup_row.id,
        org_id=primary.org_id,
        request=request,
        extra={
            "primary_name": primary.name,
            "primary_db_id": str(primary.id),
            "backup_label": backup_row.label,
            "backup_size_bytes": backup_row.size_bytes,
        },
    )
    db.commit()
    return {
        "ok": True,
        "id": str(backup_id),
        "database_name": primary.name,
        "restored_from": {
            "label": backup_row.label,
            "created_at": backup_row.created_at.isoformat() if backup_row.created_at else None,
            "size_bytes": backup_row.size_bytes,
        },
    }


@router.delete("/{db_id}/backups/{backup_id}")
async def delete_backup(
    db_id: UUID,
    backup_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    primary = _get_or_404(db, db_id)
    row = db.query(ManagedDatabaseBackup).filter(
        ManagedDatabaseBackup.id == util.to_uuid(backup_id),
        ManagedDatabaseBackup.primary_db_id == primary.id,
    ).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup not found")

    backup.delete_backup_file(row.file_path)
    backup.prune_empty_dir(row.file_path)

    audit_log.record_for_user(
        db, current_user,
        action="managed_db.backup.delete",
        entity_type="managed_database_backup",
        entity_id=row.id,
        org_id=primary.org_id,
        request=request,
        extra={"primary_name": primary.name, "label": row.label},
    )
    db.delete(row)
    db.commit()
    return {"ok": True, "id": str(backup_id)}


# ── Schedule (v1.1: cron-driven scheduled backups) ──────────────────────────


class UpdateScheduleRequest(BaseModel):
    """PATCH body. `cron=None` clears the schedule entirely; `cron=""`
    is treated the same. Retention is bounded so a misconfigured value
    can't make us keep zero (which would make scheduled backups
    immediately self-delete after each run) or thousands (disk DoS)."""
    cron: Optional[str] = Field(
        default=None,
        max_length=128,
        description="5-field cron string (UTC), or null/empty to clear the schedule.",
    )
    retention_count: Optional[int] = Field(
        default=None,
        ge=1, le=1000,
        description="How many scheduled backups to keep on disk before pruning.",
    )


class ScheduleResponse(BaseModel):
    id: str
    name: str
    schedule_cron: Optional[str] = None
    schedule_retention_count: int
    last_scheduled_backup_at: Optional[str] = None
    next_run_at: Optional[str] = None


def _serialize_schedule(row: ManagedDatabase) -> ScheduleResponse:
    nxt = backup_scheduler.next_run_time(str(row.id))
    return ScheduleResponse(
        id=str(row.id),
        name=row.name,
        schedule_cron=row.schedule_cron,
        schedule_retention_count=int(row.schedule_retention_count or 7),
        last_scheduled_backup_at=row.last_scheduled_backup_at.isoformat() if row.last_scheduled_backup_at else None,
        next_run_at=nxt.isoformat() if nxt else None,
    )


@router.get("/{db_id}/schedule", response_model=ScheduleResponse)
async def get_schedule(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> ScheduleResponse:
    row = _get_or_404(db, db_id)
    return _serialize_schedule(row)


@router.patch("/{db_id}/schedule", response_model=ScheduleResponse)
async def update_schedule(
    db_id: UUID,
    body: UpdateScheduleRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ScheduleResponse:
    """Set or clear a cron schedule for this database's backups.

    The cron string is in UTC (no per-user timezone in v1 — keeps the
    UI honest about when the backup actually fires). Common presets
    the UI surfaces: ``0 * * * *`` (hourly), ``0 3 * * *`` (3am UTC
    daily), ``0 3 * * 0`` (3am UTC every Sunday).

    Setting cron to null/empty CLEARS the schedule and unregisters
    the APScheduler job. The DB itself is not modified, only its
    schedule.
    """
    row = _get_or_404(db, db_id)

    if row.engine not in backup.ENGINE_DUMP_FORMAT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Scheduled backups don't yet support engine '{row.engine}'. "
                f"Supported: {', '.join(sorted(backup.ENGINE_DUMP_FORMAT))}."
            ),
        )

    updates: dict = {}
    cron_changed = False
    if "cron" in body.model_fields_set:
        new_cron = (body.cron or "").strip() or None
        if new_cron is not None:
            try:
                backup_scheduler.parse_cron_or_raise(new_cron)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=str(exc),
                ) from exc
        if new_cron != row.schedule_cron:
            row.schedule_cron = new_cron
            updates["schedule_cron"] = new_cron
            cron_changed = True

    if body.retention_count is not None and body.retention_count != row.schedule_retention_count:
        row.schedule_retention_count = body.retention_count
        updates["retention_count"] = body.retention_count

    if updates:
        audit_log.record_for_user(
            db, current_user,
            action="managed_db.backup.schedule.update",
            entity_type="managed_database",
            entity_id=row.id,
            org_id=row.org_id,
            request=request,
            extra={"name": row.name, "updated_fields": list(updates.keys())},
        )
    db.commit()

    # Sync the live scheduler with the new state. Doing this after commit
    # so a successfully-saved schedule survives a scheduler hiccup.
    if cron_changed:
        if row.schedule_cron:
            try:
                backup_scheduler.register_schedule(str(row.id), row.schedule_cron)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Saved schedule but failed to register cron job for %s — "
                    "it will pick up on the next process restart.",
                    row.id,
                )
        else:
            backup_scheduler.unregister_schedule(str(row.id))

    return _serialize_schedule(row)


@router.get("/{db_id}/backups/usage")
async def backup_storage_usage(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Disk footprint of this DB's backups + free space on the volume.

    Surfaced in the UI so users see "you've used 240MB across 12 backups,
    free disk: 80GB" before deciding to click another Backup.
    """
    primary = _get_or_404(db, db_id)
    return {
        "used_bytes": backup.total_size_for_db(str(primary.id)),
        "free_bytes": backup.free_disk_bytes(),
    }


@router.get("/{db_id}/credentials", response_model=CredentialsResponse)
async def get_credentials(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> CredentialsResponse:
    """Reveal the plaintext password + connection string.

    Audit-logged because revealing a credential is a sensitive action
    even though the same user could have copied it on create. Lets an
    org admin see "alice viewed db creds at 14:32" alongside other
    sensitive operations.
    """
    row = _get_or_404(db, db_id)
    password = util.decrypt_secret(row.password_encrypted)
    audit_log.record_for_user(
        db, current_user,
        action="managed_db.credentials.view",
        entity_type="managed_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.commit()
    return CredentialsResponse(
        password=password,
        connection_string=_conn_string(row, password),
    )
