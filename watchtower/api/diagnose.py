"""Self-diagnostic endpoint for the WatchTower API.

Returns the live state of every subsystem the operator might need to
configure for a feature to work — DB, Fernet key, API token, GitHub
OAuth, GitHub Device Flow, SMTP, LLM agent, Redis, alembic head, and
the SPA bundle. Each check is fast (<100ms) and returns a status
(``ok``/``warn``/``fail``) plus an actionable ``hint`` when something
is missing or misconfigured.

The Settings → Diagnostics tab in the SPA renders these as red/green
dots so users (and us, fielding bug reports) can answer "why doesn't
X work?" without DevTools or a shell.

Intentionally NOT covered:
  - Live connectivity probes that might hang (LLM, SMTP). Config
    presence only; the operator can still test by clicking through.
  - Anything that requires sending a real network request that costs
    money (e.g. a full LLM round-trip).
  - Stripe / billing — that lands when Pro billing wires up.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text

from watchtower.api import util
from watchtower.database import SessionLocal, engine

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["Health"])


class DiagnosticCheck(BaseModel):
    id: str
    name: str
    status: str  # "ok" | "warn" | "fail"
    detail: Optional[str] = None
    hint: Optional[str] = None


class DiagnosticReport(BaseModel):
    checks: list[DiagnosticCheck]
    summary: dict[str, int]  # {"ok": N, "warn": N, "fail": N}
    version: str
    checked_at: datetime


def _check_database() -> DiagnosticCheck:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        url_str = str(engine.url)
        # Mask Postgres password if present.
        backend = engine.url.get_backend_name()
        return DiagnosticCheck(
            id="database",
            name="Database",
            status="ok",
            detail=f"{backend} reachable",
        )
    except Exception as e:
        return DiagnosticCheck(
            id="database",
            name="Database",
            status="fail",
            detail=str(e)[:200],
            hint="Verify DATABASE_URL or that ~/.watchtower/watchtower.db is writable.",
        )


def _check_fernet_key() -> DiagnosticCheck:
    try:
        from cryptography.fernet import Fernet  # noqa: WPS433
    except Exception:
        return DiagnosticCheck(
            id="fernet_key",
            name="Secret encryption key",
            status="fail",
            detail="cryptography package not importable",
            hint="Reinstall: pip install --prefer-binary -r requirements.txt",
        )
    key = os.getenv("WATCHTOWER_SECRET_KEY")
    secret_path = Path.home() / ".watchtower" / "secret.key"
    if not key and not secret_path.exists():
        return DiagnosticCheck(
            id="fernet_key",
            name="Secret encryption key",
            status="fail",
            detail="No key in env or ~/.watchtower/secret.key",
            hint=(
                "Set WATCHTOWER_SECRET_KEY to a Fernet key, or let the app "
                "auto-generate ~/.watchtower/secret.key on first run."
            ),
        )
    try:
        if not key:
            key = secret_path.read_text().strip()
        fernet = Fernet(key.encode("utf-8") if isinstance(key, str) else key)
        token = fernet.encrypt(b"diagnose-roundtrip")
        assert fernet.decrypt(token) == b"diagnose-roundtrip"
        source = "env" if os.getenv("WATCHTOWER_SECRET_KEY") else "~/.watchtower/secret.key"
        return DiagnosticCheck(
            id="fernet_key",
            name="Secret encryption key",
            status="ok",
            detail=f"loaded from {source}, round-trip OK",
        )
    except Exception as e:
        return DiagnosticCheck(
            id="fernet_key",
            name="Secret encryption key",
            status="fail",
            detail=str(e)[:200],
            hint="Key looks malformed. Generate a new one with `cryptography.fernet.Fernet.generate_key()`.",
        )


def _check_api_token() -> DiagnosticCheck:
    token = os.getenv("WATCHTOWER_API_TOKEN")
    if not token:
        return DiagnosticCheck(
            id="api_token",
            name="API token",
            status="fail",
            detail="WATCHTOWER_API_TOKEN not set",
            hint="Set WATCHTOWER_API_TOKEN to a strong random string. The desktop app generates one per launch.",
        )
    if token == "dev-watchtower-token":
        return DiagnosticCheck(
            id="api_token",
            name="API token",
            status="warn",
            detail="Using the well-known dev token",
            hint="Replace WATCHTOWER_API_TOKEN with a strong random value before exposing this server.",
        )
    return DiagnosticCheck(
        id="api_token",
        name="API token",
        status="ok",
        detail="set",
    )


def _check_github_oauth() -> DiagnosticCheck:
    client_id = os.getenv("GITHUB_OAUTH_CLIENT_ID") or os.getenv("GITHUB_CLIENT_ID")
    client_secret = os.getenv("GITHUB_OAUTH_CLIENT_SECRET") or os.getenv("GITHUB_CLIENT_SECRET")
    if client_id and client_secret:
        return DiagnosticCheck(
            id="github_oauth",
            name="GitHub OAuth (web flow)",
            status="ok",
            detail="client id + secret configured",
        )
    if client_id or client_secret:
        return DiagnosticCheck(
            id="github_oauth",
            name="GitHub OAuth (web flow)",
            status="warn",
            detail="partial: only one of client_id / client_secret is set",
            hint="Set both GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET, or rely on Device Flow only.",
        )
    return DiagnosticCheck(
        id="github_oauth",
        name="GitHub OAuth (web flow)",
        status="warn",
        detail="not configured",
        hint=(
            "Optional. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to enable the web "
            "redirect login flow. Device Flow still works without these."
        ),
    )


def _check_github_device_flow() -> DiagnosticCheck:
    # The shipped builds have a built-in default device-flow client id, so
    # this is normally always-ok. Only fails if the operator explicitly
    # cleared it (e.g. by running their own fork without setting it).
    client_id = (
        os.getenv("WATCHTOWER_GITHUB_DEVICE_CLIENT_ID")
        or os.getenv("GITHUB_OAUTH_CLIENT_ID")
        or os.getenv("GITHUB_CLIENT_ID")
        or "Ov23lilAUjd9BVg8rNl8"  # default in enterprise.py
    )
    if client_id:
        return DiagnosticCheck(
            id="github_device_flow",
            name="GitHub Device Flow",
            status="ok",
            detail=f"client id configured ({client_id[:8]}…)",
        )
    return DiagnosticCheck(
        id="github_device_flow",
        name="GitHub Device Flow",
        status="warn",
        detail="no device-flow client id",
        hint="Set WATCHTOWER_GITHUB_DEVICE_CLIENT_ID to a public OAuth app id with Device Flow enabled.",
    )


def _check_smtp() -> DiagnosticCheck:
    host = os.getenv("WATCHTOWER_SMTP_HOST")
    if host:
        return DiagnosticCheck(
            id="smtp",
            name="SMTP (team-invite emails)",
            status="ok",
            detail=f"host={host}",
        )
    return DiagnosticCheck(
        id="smtp",
        name="SMTP (team-invite emails)",
        status="warn",
        detail="not configured",
        hint=(
            "Optional. Set WATCHTOWER_SMTP_HOST (and WATCHTOWER_SMTP_USER / "
            "_PASSWORD if your relay needs auth) to send invite emails. "
            "Without this, invite URLs are returned in the API response so "
            "admins can share them manually."
        ),
    )


def _check_llm_agent() -> DiagnosticCheck:
    base = os.getenv("WATCHTOWER_LLM_BASE_URL")
    if base:
        return DiagnosticCheck(
            id="llm_agent",
            name="LLM agent",
            status="ok",
            detail=f"base_url={base}",
        )
    return DiagnosticCheck(
        id="llm_agent",
        name="LLM agent",
        status="warn",
        detail="not configured",
        hint=(
            "Optional. Set WATCHTOWER_LLM_BASE_URL to any OpenAI-compatible "
            "endpoint (Ollama, LM Studio, OpenAI, OpenRouter, vLLM, …) to "
            "enable the agent. /api/agent/chat returns 503 until configured."
        ),
    )


def _check_redis() -> DiagnosticCheck:
    url = os.getenv("REDIS_URL")
    if not url:
        return DiagnosticCheck(
            id="redis",
            name="Redis (build queue)",
            status="warn",
            detail="not configured — using BackgroundTasks fallback",
            hint=(
                "Optional. Set REDIS_URL to enqueue builds via RQ so they "
                "survive API restarts. Run `python -m watchtower.worker` "
                "alongside the API to drain the queue."
            ),
        )
    try:
        import redis  # noqa: WPS433
        client = redis.Redis.from_url(url, socket_connect_timeout=1)
        client.ping()
        return DiagnosticCheck(
            id="redis",
            name="Redis (build queue)",
            status="ok",
            detail="reachable",
        )
    except Exception as e:
        return DiagnosticCheck(
            id="redis",
            name="Redis (build queue)",
            status="fail",
            detail=f"unreachable: {str(e)[:120]}",
            hint="Verify REDIS_URL is correct and the broker is running.",
        )


def _check_migration_head() -> DiagnosticCheck:
    try:
        from alembic.script import ScriptDirectory  # noqa: WPS433
        from alembic.config import Config  # noqa: WPS433
        from alembic.runtime.migration import MigrationContext  # noqa: WPS433

        alembic_ini = Path(__file__).resolve().parents[2] / "alembic.ini"
        if not alembic_ini.exists():
            return DiagnosticCheck(
                id="migration_head",
                name="Database migrations",
                status="warn",
                detail="alembic.ini not found (packaged build)",
                hint=None,
            )
        cfg = Config(str(alembic_ini))
        cfg.set_main_option("script_location", str(alembic_ini.parent / "alembic"))
        scripts = ScriptDirectory.from_config(cfg)
        expected = scripts.get_current_head()
        with engine.connect() as conn:
            mc = MigrationContext.configure(conn)
            current = mc.get_current_revision()
        if current == expected:
            return DiagnosticCheck(
                id="migration_head",
                name="Database migrations",
                status="ok",
                detail=f"at head ({current})",
            )
        return DiagnosticCheck(
            id="migration_head",
            name="Database migrations",
            status="warn",
            detail=f"db at {current}, expected {expected}",
            hint="Restart the API — init_db() runs `alembic upgrade head` on import.",
        )
    except Exception as e:
        return DiagnosticCheck(
            id="migration_head",
            name="Database migrations",
            status="warn",
            detail=f"could not determine: {str(e)[:120]}",
            hint=None,
        )


def _check_web_dist() -> DiagnosticCheck:
    candidates = [
        Path(__file__).resolve().parents[2] / "web" / "dist" / "index.html",
        Path(__file__).resolve().parents[1] / "web-dist" / "index.html",
    ]
    for c in candidates:
        if c.exists():
            return DiagnosticCheck(
                id="web_dist",
                name="Frontend bundle",
                status="ok",
                detail=str(c),
            )
    return DiagnosticCheck(
        id="web_dist",
        name="Frontend bundle",
        status="fail",
        detail="web/dist/index.html missing",
        hint="Run `npm --prefix web run build`. The packaged build bakes this in; if missing, reinstall.",
    )


_CHECKS = [
    _check_database,
    _check_fernet_key,
    _check_api_token,
    _check_github_oauth,
    _check_github_device_flow,
    _check_smtp,
    _check_llm_agent,
    _check_redis,
    _check_migration_head,
    _check_web_dist,
]


@router.get("/diagnose", response_model=DiagnosticReport)
async def diagnose(_current_user: dict = Depends(util.get_current_user)) -> DiagnosticReport:
    """Run every subsystem health check and return a structured report.

    Auth-gated like the rest of /api/* — anonymous callers can already
    use /api/health for a binary up/down. /diagnose surfaces operator
    detail (env-var presence, file paths, error strings) which we don't
    want leaking unauthenticated.
    """
    import watchtower as wt
    checks = [c() for c in _CHECKS]
    summary = {"ok": 0, "warn": 0, "fail": 0}
    for c in checks:
        summary[c.status] = summary.get(c.status, 0) + 1
    return DiagnosticReport(
        checks=checks,
        summary=summary,
        version=getattr(wt, "__version__", "unknown"),
        checked_at=datetime.now(timezone.utc),
    )
