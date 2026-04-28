"""WatchTower FastAPI application package."""

import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException

from watchtower.database import init_db
from watchtower.log_config import request_id_middleware, setup_logging

from . import (
    agent,
    audit,
    builds,
    deployments,
    enterprise,
    envvars,
    me,
    notifications,
    projects,
    runtime,
    setup,
    webhooks,
)
from .rate_limit import limiter, rate_limit_exceeded_handler


# Idempotent — safe to call again from deploy_server / worker entrypoints
# (the audit flagged a silent double-init that lost whichever ran second).
setup_logging()
logger = logging.getLogger(__name__)


def _ensure_dev_api_token() -> None:
    """Auto-set a known dev API token so the app "just works" in dev mode.

    The history: ``WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true`` used to mean
    "accept any bearer". That was removed in a security commit (3f645d0)
    because it was too permissive. Now dev mode requires both the env
    var AND ``WATCHTOWER_API_TOKEN`` to be set — and if you forget the
    second one, every request 503s with
    "WATCHTOWER_API_TOKEN must be set even in dev mode."

    That trips users up a lot — running uvicorn directly without
    sourcing ``.env`` is enough. So at startup, if dev-auth is on and
    ``WATCHTOWER_API_TOKEN`` is missing, we set a known shared dev
    value (``dev-watchtower-token``, the value already shipped in
    ``.env``) and log a clear warning. The shared value matches what
    the SPA already uses in dev fallback paths, so the auth flow
    "just works" on first run.

    Production paths (no ``WATCHTOWER_ALLOW_INSECURE_DEV_AUTH``) are
    unchanged — the original 401/503 contract still applies.
    """
    if os.getenv("WATCHTOWER_API_TOKEN"):
        return
    if os.getenv("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false").lower() != "true":
        return
    os.environ["WATCHTOWER_API_TOKEN"] = "dev-watchtower-token"
    logger.warning(
        "Dev mode self-heal: WATCHTOWER_API_TOKEN was unset; defaulting to "
        "'dev-watchtower-token' (the value shipped in .env). The SPA's dev "
        "fallback uses the same string, so auth will work. Set "
        "WATCHTOWER_API_TOKEN explicitly in production."
    )


def _ensure_secret_key() -> None:
    """Auto-generate WATCHTOWER_SECRET_KEY on first run if not provided.

    The key is persisted to ``~/.watchtower/secret.key`` (or
    ``$WATCHTOWER_DATA_DIR/secret.key`` if set) with 0o600 permissions, so
    that secrets stored in the database (GitHub PATs, etc.) remain decryptable
    across restarts. Production deployments should set
    ``WATCHTOWER_SECRET_KEY`` explicitly via environment / secret manager.
    """
    if os.getenv("WATCHTOWER_SECRET_KEY"):
        return

    data_dir = Path(
        os.getenv("WATCHTOWER_DATA_DIR")
        or os.path.join(os.path.expanduser("~"), ".watchtower")
    )
    key_path = data_dir / "secret.key"

    try:
        if key_path.exists():
            key = key_path.read_text(encoding="utf-8").strip()
        else:
            try:
                from cryptography.fernet import Fernet  # type: ignore
            except Exception:  # pragma: no cover - cryptography is a hard dep
                logger.warning(
                    "cryptography not installed; cannot auto-generate "
                    "WATCHTOWER_SECRET_KEY. Stored secrets will not work."
                )
                return
            key = Fernet.generate_key().decode("utf-8")
            data_dir.mkdir(parents=True, exist_ok=True)
            try:
                # Tighten parent-dir perms — the key file itself is 0600 but
                # an open parent (umask 022 → 0755) would still allow other
                # local users to inspect timestamps / replace the file.
                os.chmod(data_dir, 0o700)
            except OSError:
                pass
            key_path.write_text(key, encoding="utf-8")
            try:
                os.chmod(key_path, 0o600)
            except OSError:
                pass
            logger.info(
                "Generated WATCHTOWER_SECRET_KEY at %s (0600). "
                "Set this env var explicitly in production.",
                key_path,
            )
        # Validate that the loaded key is a usable Fernet key before exporting
        # it; a corrupt file would otherwise surface as 503 on first encrypt.
        try:
            from cryptography.fernet import Fernet  # type: ignore
            Fernet(key.encode("utf-8"))
        except Exception:
            logger.exception(
                "Stored secret key at %s is invalid; ignoring.", key_path
            )
            return
        os.environ["WATCHTOWER_SECRET_KEY"] = key
    except Exception:
        logger.exception(
            "Failed to load or generate WATCHTOWER_SECRET_KEY; "
            "secret storage will be unavailable."
        )


# ── Module-level startup steps ───────────────────────────────────────────────
# These run once when uvicorn (or any importer) loads the package, BEFORE
# the FastAPI app object is constructed. We do them here rather than inside
# the lifespan because:
#   * `init_db()` calls Alembic's `command.upgrade(...)` and has been
#     observed to deadlock uvicorn's lifespan implementation on Alembic
#     1.13 / uvicorn 0.29 — the call returns but uvicorn never receives
#     `lifespan.startup.complete`. Running it at import time avoids the
#     interaction entirely.
#   * `_ensure_dev_api_token()` materialises the dev token early so the
#     auth signing secret is stable across restarts (sessions survive)
#     and so /api/me + every other authed endpoint stops 503ing in dev.

_ensure_dev_api_token()
init_db()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("Starting WatchTower API")
    _ensure_secret_key()
    # Security: warn loudly when running without a real API token in dev mode.
    if (
        os.getenv("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", "false").lower() == "true"
        and not os.getenv("WATCHTOWER_API_TOKEN")
    ):
        logger.warning(
            "⚠  WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true with no WATCHTOWER_API_TOKEN. "
            "Any request with any Bearer token is accepted. "
            "Do NOT expose this server outside localhost."
        )
    yield
    logger.info("Shutting down WatchTower API")


_enable_docs = os.getenv("WATCHTOWER_ENABLE_DOCS", "false").lower() == "true"

app = FastAPI(
    title="WatchTower API",
    description="Unified deployment platform - Netlify + Vercel + Self-hosted",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs" if _enable_docs else None,
    redoc_url="/redoc" if _enable_docs else None,
    openapi_url="/openapi.json" if _enable_docs else None,
)


allowed_origins = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        (
            "http://localhost:3000,http://localhost:8000,"
            "http://127.0.0.1:5173,http://127.0.0.1:5222"
        ),
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)

# ── Request ID + structured logging ──────────────────────────────────────────
# Adds X-Request-ID to every response (re-using a client-supplied header when
# present so an upstream proxy's trace ID flows through). The contextvar set
# inside this middleware is read by the JSON log formatter, so every log line
# emitted during the request carries the ID.
# Registered first so it runs OUTERMOST — every later middleware (rate limit,
# CORS) and every handler is wrapped in this context.
app.middleware("http")(request_id_middleware)

# ── Rate limiting ────────────────────────────────────────────────────────────
# slowapi reads `app.state.limiter`, applies @limiter.limit(...) decorators
# on individual routes, and handles RateLimitExceeded via the handler we
# install below. Default budget for everything else is governed by the
# Limiter's default_limits (see watchtower/api/rate_limit.py).
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)


# ── Global error handlers ────────────────────────────────────────────────────
# Without these, unhandled exceptions surface as bare 500s with full tracebacks
# in dev (and confusing client errors in prod). These handlers preserve the
# response shape FastAPI already uses ({"detail": ...}) and ensure server-side
# logs always include the path + method for triage.

@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code >= 500:
        logger.error("%s %s -> %s: %s", request.method, request.url.path, exc.status_code, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.info("%s %s -> 422 validation: %s", request.method, request.url.path, exc.errors())
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# index.html references the asset bundle by content-hashed filename
# (`/assets/index-XXXX.js`). The hashed assets are immutable and safe to
# cache forever; index.html itself MUST NOT be cached, or after a deploy
# the browser keeps serving the old HTML that points at JS files which
# no longer exist on disk → blank screen / "doesn't load" until the
# user manually clears the Electron cache. Forcing revalidation on
# every load fixes this for every install permanently.
# Strict same-origin CSP for the SPA. Mirrors what the desktop static
# server (`desktop/main.js:startStaticServer`) ships in browser-mode so
# the security posture is identical regardless of which entrypoint
# serves the bundle. `connect-src` lets the SPA reach the API over the
# same origin and (when the React bundle hits an absolute backend URL
# in dev) localhost.
_SPA_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: https:; "
        "font-src 'self' data:; "
        "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* "
        "http://localhost:* ws://localhost:*; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    ),
}

_INDEX_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    **_SPA_SECURITY_HEADERS,
}

_PUBLIC_ASSET_HEADERS = {
    # Favicon / manifest / robots are content-stable but not hashed —
    # cache briefly (15 min) so they don't go stale across deploys.
    "Cache-Control": "public, max-age=900",
    **_SPA_SECURITY_HEADERS,
}


@app.get("/", tags=["Health"], include_in_schema=False)
async def root():
    """Serve the React SPA, or a JSON fallback if web/dist is not built."""
    index = Path(__file__).resolve().parents[2] / "web" / "dist" / "index.html"
    if index.is_file():
        return FileResponse(str(index), headers=_INDEX_NO_CACHE_HEADERS)
    return {"message": "WatchTower API", "version": "2.0.0", "docs": "/docs"}


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "healthy", "service": "watchtower-api"}


@app.get("/api/health", tags=["Health"], include_in_schema=False)
async def health_alias():
    """Alias so the frontend apiClient (baseURL=/api) can reach /health."""
    return {"status": "healthy", "service": "watchtower-api"}


app.include_router(projects.router)
app.include_router(deployments.router)
app.include_router(builds.router)
app.include_router(webhooks.router)
app.include_router(setup.router)
app.include_router(enterprise.router)
app.include_router(runtime.router)
app.include_router(envvars.router)
app.include_router(notifications.router)
app.include_router(agent.router)
app.include_router(audit.router)
app.include_router(me.router)

# ── Serve React SPA from web/dist (same-origin, no proxy needed) ──────────────
# Resolution order:
#   1. WATCHTOWER_WEB_DIST env override — used by the desktop launcher to
#      point at the SPA bundle inside the AppImage's extraResources.
#   2. ../../web/dist relative to this file — works in dev clones where
#      watchtower is installed via `pip install -e .` from a checkout.
# When the watchtower package is pip-installed from a wheel, the wheel
# does NOT ship web/dist, so the relative path resolves to a missing
# directory and we fall through to the JSON health response. That's
# the right behaviour for headless server installs; the desktop
# launcher overrides via env so the AppImage serves the real SPA.
_WEB_DIST = Path(
    os.getenv("WATCHTOWER_WEB_DIST")
    or (Path(__file__).resolve().parents[2] / "web" / "dist")
)

if _WEB_DIST.is_dir():
    # Static assets (JS/CSS/images) served under /assets
    app.mount("/assets", StaticFiles(directory=str(_WEB_DIST / "assets")), name="assets")

    # Public root files (favicon, etc.) — serve any file that exists
    @app.get("/{filename:path}", include_in_schema=False)
    async def spa_fallback(filename: str):
        """Serve static files or fall back to index.html for SPA routing.

        Path-traversal hardening: resolve the candidate path and require it to
        live inside ``_WEB_DIST``. A request like ``GET /../../etc/passwd``
        would otherwise escape the web root via ``Path / filename``.
        """
        web_root = _WEB_DIST.resolve()
        try:
            candidate = (_WEB_DIST / filename).resolve()
            candidate.relative_to(web_root)
        except (ValueError, OSError):
            # Outside the web root → fall through to SPA index (no-cache).
            return FileResponse(str(_WEB_DIST / "index.html"), headers=_INDEX_NO_CACHE_HEADERS)
        if candidate.is_file():
            return FileResponse(str(candidate), headers=_PUBLIC_ASSET_HEADERS)
        # SPA route fallback — the request is for a React Router path
        # (e.g. /servers, /agent), so serve index.html with no-cache so a
        # post-deploy reload doesn't keep pointing at deleted JS bundles.
        return FileResponse(str(_WEB_DIST / "index.html"), headers=_INDEX_NO_CACHE_HEADERS)
