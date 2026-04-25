"""
FastAPI application setup and configuration
"""

import os
import secrets
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from watchtower.database import init_db, get_db
from watchtower import schemas

# Configure logging
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def get_current_user(
    authorization: str = Header(None),
    db: Session = Depends(get_db)
):
    """
    Get current user from JWT token or API key.
    In self-hosted mode, this can be simplified.
    """
    if not authorization:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    # TODO: Implement JWT/token validation
    # For now, return a dummy user
    return {"user_id": "dummy-user-id"}


def generate_webhook_secret() -> str:
    """Generate a secure webhook secret"""
    return secrets.token_urlsafe(32)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup and shutdown logic
    """
    # Startup
    logger.info("Starting WatchTower API")
    init_db()
    yield
    # Shutdown
    logger.info("Shutting down WatchTower API")


# Create FastAPI app
app = FastAPI(
    title="WatchTower API",
    description="Unified deployment platform - Netlify + Vercel + Self-hosted",
    version="2.0.0",
    lifespan=lifespan
)

# Configure CORS
ALLOWED_ORIGINS = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:3000,http://localhost:8000"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Root endpoint
@app.get("/", tags=["Health"])
async def root():
    return {
        "message": "WatchTower API",
        "version": "2.0.0",
        "docs": "/docs"
    }


# Health check
@app.get("/health", tags=["Health"])
async def health():
    return {
        "status": "healthy",
        "service": "watchtower-api"
    }


# Include routers
from watchtower.api import projects, deployments, builds, webhooks, setup, enterprise

app.include_router(projects.router)
app.include_router(deployments.router)
app.include_router(builds.router)
app.include_router(webhooks.router)
app.include_router(setup.router)
app.include_router(enterprise.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
