"""Regression test for builder._run_build's UUID coercion.

Bug — enqueue_build always serialises the deployment id with
``str(deployment.id)`` so it survives RQ's JSON job payload, but
``Deployment.id`` is ``Uuid(as_uuid=True)``. SQLAlchemy's UUID type
processor calls ``.hex`` on the parameter — works on UUID objects, blows
up on bare strings with::

    sqlalchemy.exc.StatementError: (builtins.AttributeError) 'str' object
    has no attribute 'hex'

The exception is swallowed by FastAPI BackgroundTasks's runner (it logs
via ``logger.exception`` but never updates the deployment row), so every
queued build silently dies on the very first DB query and the deployment
sits at PENDING forever.

This test locks the coercion at the top of ``_run_build`` so the bug
can't quietly come back.
"""
from __future__ import annotations

import asyncio
import uuid

from watchtower import builder
from watchtower.database import (
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    Organization,
    Project,
    ProjectSourceType,
    SessionLocal,
    UseCaseType,
    User,
)


def _seed_minimal_project(db) -> Deployment:
    """Insert a User → Org → Project → Deployment so _run_build has
    something to load. We don't actually want the build to *succeed*
    (that would attempt a real git clone in the test); we only care
    about the FIRST query — the one that crashed before the fix.
    """
    user = User(
        id=uuid.uuid4(),
        email="builder-test@watchtower.local",
        name="Builder Test",
        is_active=True,
    )
    db.add(user)
    db.flush()

    org = Organization(name="Builder Test Org", owner_id=user.id)
    db.add(org)
    db.flush()

    project = Project(
        name="builder-test-project",
        use_case=UseCaseType.DOCKER_PLATFORM,
        source_type=ProjectSourceType.GITHUB.value,
        # Use a URL that will fail clone fast — port 1 is unused, so
        # `git clone` returns immediately rather than hanging.
        repo_url="https://127.0.0.1:1/no/such/repo",
        repo_branch="main",
        webhook_secret="test-webhook-secret",
        org_id=org.id,
        owner_id=user.id,
    )
    db.add(project)
    db.flush()

    deployment = Deployment(
        project_id=project.id,
        commit_sha="manual-trigger",
        branch="main",
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.MANUAL,
    )
    db.add(deployment)
    db.commit()
    db.refresh(deployment)
    return deployment


def test_run_build_accepts_string_deployment_id():
    """The fix path: passing a string id should NOT raise AttributeError
    at the first DB query, and the deployment should leave PENDING.

    Before the fix this raised
        StatementError: (builtins.AttributeError) 'str' object has no
        attribute 'hex'
    deep inside SQLAlchemy and the deployment row stayed PENDING.

    After the fix, _run_build coerces to UUID, finds the row, transitions
    it to BUILDING, attempts the clone, and fails the clone (because the
    repo URL is unreachable) — but the deployment moves to FAILED, which
    is a recoverable state instead of being stuck forever.
    """
    db = SessionLocal()
    try:
        deployment = _seed_minimal_project(db)
        deployment_id_str = str(deployment.id)
    finally:
        db.close()

    # _run_build is async — drive it from a fresh event loop.
    asyncio.run(builder._run_build(deployment_id_str))

    # Re-query in a fresh session to bypass any stale cache and confirm
    # the row has moved out of PENDING (either BUILDING/FAILED is fine —
    # what we're locking is "the runner started doing work").
    db = SessionLocal()
    try:
        refreshed = (
            db.query(Deployment)
            .filter(Deployment.id == uuid.UUID(deployment_id_str))
            .first()
        )
        assert refreshed is not None, "deployment row vanished"
        assert refreshed.status != DeploymentStatus.PENDING, (
            f"deployment stuck at PENDING — _run_build never started. "
            f"This is the symptom of the str-vs-UUID coercion bug."
        )
    finally:
        db.close()


def test_run_build_handles_malformed_id_gracefully():
    """Defensive: a non-UUID string shouldn't crash the worker process.
    Logs an error and returns — the next queued job still runs.
    """
    # Should not raise. Returns silently after logging.
    asyncio.run(builder._run_build("not-a-uuid"))
