"""WatchTower FastAPI application package."""

import os
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from watchtower.database import init_db

from . import builds, deployments, enterprise, projects, setup, webhooks


logging.basicConfig(
	level=os.getenv("LOG_LEVEL", "INFO"),
	format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
	logger.info("Starting WatchTower API")
	init_db()
	yield
	logger.info("Shutting down WatchTower API")


app = FastAPI(
	title="WatchTower API",
	description="Unified deployment platform - Netlify + Vercel + Self-hosted",
	version="2.0.0",
	lifespan=lifespan,
)


allowed_origins = os.getenv(
	"CORS_ORIGINS", "http://localhost:3000,http://localhost:8000,http://127.0.0.1:5173"
).split(",")

app.add_middleware(
	CORSMiddleware,
	allow_origins=allowed_origins,
	allow_credentials=True,
	allow_methods=["*"],
	allow_headers=["*"],
)


@app.get("/", tags=["Health"])
async def root():
	return {"message": "WatchTower API", "version": "2.0.0", "docs": "/docs"}


@app.get("/health", tags=["Health"])
async def health():
	return {"status": "healthy", "service": "watchtower-api"}


app.include_router(projects.router)
app.include_router(deployments.router)
app.include_router(builds.router)
app.include_router(webhooks.router)
app.include_router(setup.router)
app.include_router(enterprise.router)
