"""WatchTower FastAPI application package."""

import os
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from watchtower.database import init_db

from . import (
    builds,
    deployments,
    enterprise,
    envvars,
    notifications,
    projects,
    runtime,
    setup,
    webhooks,
)


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logger.info("Starting WatchTower API")
    init_db()
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


allowed_origins = os.getenv(
    "CORS_ORIGINS",
    (
        "http://localhost:3000,http://localhost:8000,"
        "http://127.0.0.1:5173,http://127.0.0.1:5222"
    ),
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Requested-With"],
)


@app.get("/", tags=["Health"], include_in_schema=False)
async def root():
    """Serve the React SPA, or a JSON fallback if web/dist is not built."""
    index = Path(__file__).resolve().parents[2] / "web" / "dist" / "index.html"
    if index.is_file():
        return FileResponse(str(index))
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

# ── Serve React SPA from web/dist (same-origin, no proxy needed) ──────────────
_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

if _WEB_DIST.is_dir():
    # Static assets (JS/CSS/images) served under /assets
    app.mount("/assets", StaticFiles(directory=str(_WEB_DIST / "assets")), name="assets")

    # Public root files (favicon, etc.) — serve any file that exists
    @app.get("/{filename:path}", include_in_schema=False)
    async def spa_fallback(filename: str):
        """Serve static files or fall back to index.html for SPA routing."""
        candidate = _WEB_DIST / filename
        if candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(_WEB_DIST / "index.html"))
