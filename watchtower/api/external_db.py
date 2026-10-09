"""External databases — connection metadata for DBs WatchTower does NOT manage.

The bring-your-own-DB counterpart to managed_db.py. Stores host / port /
user / encrypted-password / engine for a remote database so apps deployed
through WatchTower can reference it by name. No podman, no lifecycle.

Engines are the same identifier set as ManagedDatabase so the UI's
"pick a database" surface looks uniform regardless of which side it
lives on.
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.api.managed_db import _ENGINES  # share the engine catalogue
from watchtower.database import ExternalDatabase, get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/external-databases", tags=["External Databases"])


# ── Schemas ──────────────────────────────────────────────────────────────────


class CreateExternalRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    engine: str = Field(...)
    host: str = Field(..., min_length=1, max_length=255)
    port: int = Field(..., ge=1, le=65535)
    database_name: str = Field("", max_length=63)
    username: str = Field("", max_length=63)
    password: str = Field("", max_length=512)
    use_tls: bool = True
    notes: Optional[str] = Field(None, max_length=500)


class UpdateExternalRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=64)
    host: Optional[str] = Field(None, min_length=1, max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    database_name: Optional[str] = Field(None, max_length=63)
    username: Optional[str] = Field(None, max_length=63)
    password: Optional[str] = Field(None, max_length=512)
    use_tls: Optional[bool] = None
    notes: Optional[str] = Field(None, max_length=500)


class TestConnectionRequest(BaseModel):
    """Test a database reachability BEFORE saving it. Two ways to describe the
    target, so a hosted DB (Supabase, Neon, …) can be pasted whole:
      • connection_string — a full URL (postgresql://…, redis://…). Wins if set.
      • discrete fields    — engine + host/port/user/password/database.
    We never persist anything here; this is a dry-run probe only."""
    connection_string: Optional[str] = Field(None, max_length=2048)
    engine: Optional[str] = Field(None)
    host: Optional[str] = Field(None, max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    database_name: str = Field("", max_length=128)
    username: str = Field("", max_length=128)
    password: str = Field("", max_length=512)
    use_tls: bool = True


class TestConnectionResult(BaseModel):
    ok: bool
    engine: Optional[str] = None
    # Human message either way — the UI shows it verbatim.
    message: str
    # Populated on success so the user can see what they actually reached.
    server_version: Optional[str] = None
    latency_ms: Optional[int] = None
    # "unsupported" when we recognise the engine but have no driver to probe it
    # from here — honest, not a fake green.
    detail: Optional[str] = None


class DiscoveredDb(BaseModel):
    """A database container already running on this host that WatchTower didn't
    create — an adoption candidate. The UI pre-fills the 'connect external DB'
    form from this so the user just adds the password."""
    container_id: str
    container_name: str
    image: str
    engine: str                     # classified from the image
    suggested_host: str = "127.0.0.1"
    suggested_port: Optional[int]   # published host port, if any
    suggested_username: str
    state: str
    already_connected: bool         # an ExternalDatabase already points here


# Image-substring → engine. Covers the common official images regardless of
# registry prefix or tag (e.g. "docker.io/library/postgres:16", "postgres:16-alpine",
# "mariadb:11", "bitnami/redis"). Order matters: check mariadb before mysql
# isn't needed (distinct substrings) but mongo before mongodb-ish is fine.
_IMAGE_ENGINE_HINTS: tuple[tuple[str, str], ...] = (
    ("postgres", "postgres"),
    ("postgis", "postgres"),
    ("mariadb", "mariadb"),
    ("mysql", "mysql"),
    ("percona", "mysql"),
    ("mongo", "mongodb"),
    ("redis", "redis"),
    ("valkey", "redis"),
)


def _classify_engine(image: str) -> Optional[str]:
    img = (image or "").lower()
    for hint, engine in _IMAGE_ENGINE_HINTS:
        if hint in img:
            return engine
    return None


# ── Connection testing ─────────────────────────────────────────────────────────
#
# A dry-run reachability probe for a DB the user is about to save. The whole
# point of the feature is that a hosted database (Supabase, Neon, Railway, RDS…)
# can be verified from the browser before it's stored — so people stop saving
# typo'd connection strings and finding out at deploy time.
#
# Honesty rule (ENGINE-STANDARDS): we only return ok=True when we actually
# opened a socket and spoke the protocol. If we don't have a driver for the
# engine, we say so plainly rather than guessing.

# URL scheme → engine. Mirrors the schemes managed_db hands out, plus the
# aliases hosted providers use (postgres://, postgresql+psycopg://, rediss://).
_SCHEME_ENGINE: dict[str, str] = {
    "postgres": "postgres",
    "postgresql": "postgres",
    "mysql": "mysql",
    "mariadb": "mariadb",
    "mongodb": "mongodb",
    "mongodb+srv": "mongodb",
    "redis": "redis",
    "rediss": "redis",
}


def _parse_connection_string(raw: str) -> dict:
    """Pull engine/host/port/user/password/db out of a connection URL.

    Tolerates the '+driver' suffix (postgresql+psycopg2://) and the TLS-implied
    schemes (rediss://, mongodb+srv://). Returns a dict with whatever it found;
    missing pieces are filled by the engine default later."""
    from urllib.parse import unquote, urlparse

    url = urlparse(raw.strip())
    raw_scheme = (url.scheme or "").lower()
    scheme = raw_scheme.split("+", 1)[0]
    engine = _SCHEME_ENGINE.get(scheme)
    host = url.hostname or ""
    # TLS is implied by the secure schemes, an explicit sslmode=require, OR a
    # non-local host (hosted DBs — Supabase/Neon/etc. — mandate TLS even when
    # their copy-paste URL omits sslmode). Only a loopback/private host defaults
    # to no-TLS, which is the right call for a self-hosted box on the tailnet.
    _lower = raw.lower()
    _is_local = host in ("localhost", "127.0.0.1", "::1") or host.startswith(
        ("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.")
    )
    use_tls = (
        scheme in ("rediss",)
        or raw_scheme.endswith("+srv")
        or "sslmode=require" in _lower
        or (not _is_local and host != "")
    )
    return {
        "engine": engine,
        "host": url.hostname or "",
        "port": url.port,
        "username": unquote(url.username) if url.username else "",
        "password": unquote(url.password) if url.password else "",
        "database_name": (url.path or "").lstrip("/"),
        "use_tls": use_tls,
    }


def _probe_postgres(host, port, user, password, dbname, use_tls, timeout=6) -> tuple[bool, str, Optional[str]]:
    """Open a real libpq connection and read server_version. Covers Supabase,
    Neon, RDS, Cloud SQL, or any self-hosted Postgres."""
    try:
        import psycopg2  # type: ignore
    except Exception:  # noqa: BLE001
        return (False, "", "driver_missing")
    conn = None
    try:
        conn = psycopg2.connect(
            host=host, port=port or 5432, user=user or None,
            password=password or None, dbname=dbname or "postgres",
            connect_timeout=timeout,
            sslmode="require" if use_tls else "prefer",
        )
        with conn.cursor() as cur:
            cur.execute("SHOW server_version;")
            ver = cur.fetchone()[0]
        return (True, f"PostgreSQL {ver}", None)
    except Exception as exc:  # noqa: BLE001 — surface the DB's own message
        return (False, str(exc).strip().splitlines()[0][:300], None)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def _probe_redis(host, port, password, use_tls, timeout=6) -> tuple[bool, str, Optional[str]]:
    try:
        import redis  # type: ignore
    except Exception:  # noqa: BLE001
        return (False, "", "driver_missing")
    try:
        client = redis.Redis(
            host=host, port=port or 6379, password=password or None,
            ssl=use_tls, socket_connect_timeout=timeout, socket_timeout=timeout,
        )
        client.ping()
        info = client.info("server")
        ver = info.get("redis_version", "")
        client.close()
        return (True, f"Redis {ver}".strip(), None)
    except Exception as exc:  # noqa: BLE001
        return (False, str(exc).strip().splitlines()[0][:300], None)


class ExternalDbResponse(BaseModel):
    id: str
    name: str
    engine: str
    host: str
    port: int
    database_name: str
    username: str
    use_tls: bool
    notes: Optional[str] = None
    # We expose whether a password is on file but never the value itself
    # in list/get responses — operators reveal explicitly via /credentials.
    has_password: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _serialize(row: ExternalDatabase) -> ExternalDbResponse:
    return ExternalDbResponse(
        id=str(row.id),
        name=row.name,
        engine=row.engine,
        host=row.host,
        port=row.port,
        database_name=row.database_name or "",
        username=row.username or "",
        use_tls=bool(row.use_tls),
        notes=row.notes,
        has_password=bool(row.password_encrypted),
        created_at=row.created_at.isoformat() if row.created_at else None,
        updated_at=row.updated_at.isoformat() if row.updated_at else None,
    )


def _validate_engine(engine: str) -> None:
    if engine not in _ENGINES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unsupported engine '{engine}'. "
                f"Supported: {', '.join(sorted(_ENGINES))}."
            ),
        )


def _get_or_404(db: Session, db_id) -> ExternalDatabase:
    uid = util.to_uuid(db_id)
    row = db.query(ExternalDatabase).filter(ExternalDatabase.id == uid).first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="External database not found")
    return row


def _resolve_org_id(db_session: Session, current_user: dict):
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _u, org, _m = _ensure_user_org_member(db_session, current_user)
        return org.id
    except Exception:  # noqa: BLE001
        return None


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=list[ExternalDbResponse])
async def list_external(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[ExternalDbResponse]:
    rows = db.query(ExternalDatabase).order_by(ExternalDatabase.created_at.desc()).all()
    return [_serialize(r) for r in rows]


@router.get("/discover", response_model=list[DiscoveredDb])
async def discover_local_databases(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> list[DiscoveredDb]:
    """Find database containers already running on this host that WatchTower
    didn't create, so the user can adopt them in one click instead of typing
    host/port/engine by hand. WatchTower-managed DBs are excluded (they're
    already first-class). Best-effort: if podman isn't available, returns []."""
    try:
        from watchtower import podman_runtime
        containers = podman_runtime.list_containers()
    except Exception as exc:  # noqa: BLE001 — no runtime / probe failure → nothing to adopt
        logger.info("discover: could not list containers (%s)", exc)
        return []

    # Hosts/ports already registered as external DBs → mark candidates as
    # already-connected so the UI can disable "adopt" for them.
    existing = db.query(ExternalDatabase).all()
    connected_hostports = {(e.host, e.port) for e in existing}

    out: list[DiscoveredDb] = []
    for c in containers:
        if c.get("managed"):
            continue  # WatchTower's own managed DB — not an adoption candidate
        engine = _classify_engine(c.get("image") or "")
        if not engine:
            continue  # not a recognised database image
        # First published host port (the one an app would connect to).
        host_port: Optional[int] = None
        for p in c.get("ports") or []:
            hp = p.get("host")
            if hp:
                try:
                    host_port = int(hp)
                    break
                except (TypeError, ValueError):
                    continue
        spec = _ENGINES.get(engine)
        out.append(DiscoveredDb(
            container_id=c.get("id", ""),
            container_name=c.get("name", "?"),
            image=c.get("image") or "",
            engine=engine,
            suggested_port=host_port,
            suggested_username=spec.default_user if spec else "",
            state=c.get("state") or "",
            already_connected=host_port is not None
            and ("127.0.0.1", host_port) in connected_hostports,
        ))
    return out


@router.post("/test", response_model=TestConnectionResult)
async def test_connection(
    body: TestConnectionRequest,
    _current_user: dict = Depends(util.get_current_user),
) -> TestConnectionResult:
    """Dry-run reachability check. Paste a hosted connection string (Supabase,
    Neon, …) OR fill the fields — we open a real socket and speak the protocol,
    then throw the connection away. Nothing is saved."""
    import time

    # Connection string wins; discrete fields fill any gap it leaves.
    parsed: dict = {}
    if body.connection_string and body.connection_string.strip():
        parsed = _parse_connection_string(body.connection_string)

    engine = parsed.get("engine") or body.engine
    host = parsed.get("host") or body.host or ""
    port = parsed.get("port") or body.port
    username = parsed.get("username") or body.username
    password = parsed.get("password") or body.password
    dbname = parsed.get("database_name") or body.database_name
    use_tls = parsed.get("use_tls") if parsed.get("use_tls") is not None else body.use_tls

    if not engine:
        return TestConnectionResult(
            ok=False,
            message="Couldn't tell which database this is. Pick an engine, or paste a full connection URL (postgresql://…, redis://…).",
            detail="unknown_engine",
        )
    if not host:
        return TestConnectionResult(
            ok=False, engine=engine,
            message="No host to connect to. Add a host, or paste a connection URL that includes one.",
            detail="no_host",
        )

    started = time.monotonic()
    if engine == "postgres":
        ok, msg, detail = _probe_postgres(host, port, username, password, dbname, use_tls)
    elif engine == "redis":
        ok, msg, detail = _probe_redis(host, port, password, use_tls)
    else:
        # Recognised engine, but no client library on this host to probe it.
        # Say so honestly instead of a fake green — the DB can still be SAVED,
        # it just can't be live-tested from here yet.
        return TestConnectionResult(
            ok=False, engine=engine,
            message=f"Can't live-test {engine} from WatchTower yet (no {engine} client installed here). "
                    f"You can still save it — connections are verified at deploy time.",
            detail="unsupported_engine",
        )

    latency = int((time.monotonic() - started) * 1000)
    if detail == "driver_missing":
        return TestConnectionResult(
            ok=False, engine=engine,
            message=f"Can't live-test {engine} from WatchTower yet (the {engine} client isn't installed on this host). "
                    f"You can still save it.",
            detail="driver_missing",
        )
    if ok:
        return TestConnectionResult(
            ok=True, engine=engine,
            message=f"Connected to {host}" + (f":{port}" if port else "") + " ✓",
            server_version=msg, latency_ms=latency,
        )
    return TestConnectionResult(
        ok=False, engine=engine,
        message=msg or "Couldn't connect.",
        latency_ms=latency,
    )


@router.post("", response_model=ExternalDbResponse)
async def create_external(
    body: CreateExternalRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    _validate_engine(body.engine)

    if db.query(ExternalDatabase).filter(ExternalDatabase.name == body.name).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An external database named '{body.name}' already exists.",
        )

    row = ExternalDatabase(
        org_id=_resolve_org_id(db, current_user),
        name=body.name,
        engine=body.engine,
        host=body.host,
        port=body.port,
        database_name=body.database_name or "",
        username=body.username or "",
        password_encrypted=util.encrypt_secret(body.password) if body.password else "",
        use_tls=body.use_tls,
        notes=body.notes,
    )
    db.add(row)
    db.flush()

    audit_log.record_for_user(
        db, current_user,
        action="external_db.create",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        # Never log the password. Host + port + name are fine — same
        # info the operator has in their own DNS / docs.
        extra={
            "name": row.name,
            "engine": row.engine,
            "host": row.host,
            "port": row.port,
            "use_tls": row.use_tls,
        },
    )
    db.commit()
    return _serialize(row)


@router.get("/{db_id}", response_model=ExternalDbResponse)
async def get_external(
    db_id: UUID,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    return _serialize(_get_or_404(db, db_id))


@router.patch("/{db_id}", response_model=ExternalDbResponse)
async def update_external(
    db_id: UUID,
    body: UpdateExternalRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ExternalDbResponse:
    row = _get_or_404(db, db_id)
    updates: dict = {}
    for field in ("name", "host", "port", "database_name", "username", "use_tls", "notes"):
        val = getattr(body, field)
        if val is not None:
            setattr(row, field, val)
            updates[field] = val
    if body.password is not None:
        # Empty string means "clear the password" (e.g. moved to OS keychain).
        row.password_encrypted = util.encrypt_secret(body.password) if body.password else ""
        updates["password_changed"] = True

    audit_log.record_for_user(
        db, current_user,
        action="external_db.update",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name, "updated_fields": list(updates.keys())},
    )
    db.commit()
    return _serialize(row)


@router.delete("/{db_id}")
async def delete_external(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    row = _get_or_404(db, db_id)
    audit_log.record_for_user(
        db, current_user,
        action="external_db.delete",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.delete(row)
    db.commit()
    return {"ok": True, "id": str(db_id)}


@router.get("/{db_id}/credentials")
async def reveal_external(
    db_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> dict:
    """Reveal password + assemble connection string. Audit-logged."""
    row = _get_or_404(db, db_id)
    password = util.decrypt_secret(row.password_encrypted) if row.password_encrypted else ""
    spec = _ENGINES.get(row.engine)
    scheme = spec.conn_scheme if spec else row.engine
    if row.engine == "redis":
        conn = f"{scheme}://:{password}@{row.host}:{row.port}"
    else:
        userinfo = f"{row.username}:{password}@" if row.username or password else ""
        path = f"/{row.database_name}" if row.database_name else ""
        conn = f"{scheme}://{userinfo}{row.host}:{row.port}{path}"

    audit_log.record_for_user(
        db, current_user,
        action="external_db.credentials.view",
        entity_type="external_database",
        entity_id=row.id,
        org_id=row.org_id,
        request=request,
        extra={"name": row.name},
    )
    db.commit()
    return {"password": password, "connection_string": conn}
