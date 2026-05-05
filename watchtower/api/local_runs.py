"""Cross-project view of WatchTower-managed local containers.

Run-Locally lives under /api/projects/{id}/run-locally/* (one project
at a time). This module adds the dashboard view: "what does my machine
have running across all projects?". Single endpoint at
GET /api/local-containers backs a sidebar Admin page so the user can
see + manage everything from one place instead of clicking through
each project's detail page.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from watchtower import local_runner
from watchtower.database import Project, get_db
from watchtower.api import util

router = APIRouter(prefix="/api/local-containers", tags=["LocalContainers"])
logger = logging.getLogger(__name__)


@router.get("")
async def list_local_containers(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
):
    """Return every WatchTower-managed local container that's currently
    alive on this host, joined with a friendly project_name from the DB.

    Stale state files (containers that were removed externally) are
    cleaned up as a side effect of ``local_runner.list_running()`` —
    this endpoint is therefore safe to poll from a dashboard without
    accumulating ghost rows.
    """
    runs = local_runner.list_running()
    if not runs:
        return []

    # Resolve project names in a single query — avoids N+1 lookups
    # when many containers are running. Fall back to the saved
    # ``project_name`` (which may be None for old state files written
    # before 1.14.0) or the ID if the project row is gone.
    project_ids = [r.project_id for r in runs]
    rows = (
        db.query(Project.id, Project.name)
        .filter(Project.id.in_(project_ids))
        .all()
    )
    name_by_id = {str(pid): name for pid, name in rows}

    return [
        {
            "project_id": r.project_id,
            "project_name": name_by_id.get(r.project_id) or r.project_name or r.project_id,
            "url": r.url,
            "port": r.port,
            "container_id": r.container_id,
            "container_name": r.container_name,
            "image": r.image,
            "serving_path": r.serving_path,
            "started_at": r.started_at,
        }
        for r in runs
    ]
