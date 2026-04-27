"""Pytest fixtures for the WatchTower API test pack.

Sets environment vars BEFORE the watchtower package is imported so that the
SQLAlchemy engine binds to a dedicated test database (not ``watchtower.db``
in the repo root) and so auth helpers don't fall back to ephemeral keys.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# ── 1. Configure env BEFORE importing watchtower ─────────────────────────────
_TEST_DB_DIR = tempfile.mkdtemp(prefix="watchtower-test-")
_TEST_DB_PATH = Path(_TEST_DB_DIR) / "test.db"

os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_PATH}"
os.environ["WATCHTOWER_API_TOKEN"] = "test-token"
os.environ["WATCHTOWER_AUTH_SECRET"] = "test-auth-secret-do-not-use-in-prod"
os.environ["WATCHTOWER_DATA_DIR"] = _TEST_DB_DIR
# Generate a deterministic Fernet key once so encrypt/decrypt round-trip works.
from cryptography.fernet import Fernet  # noqa: E402  (after env setup)
os.environ.setdefault("WATCHTOWER_SECRET_KEY", Fernet.generate_key().decode("utf-8"))
os.environ["WATCHTOWER_INSTALL_OWNER_MODE"] = "false"
os.environ.pop("WATCHTOWER_ALLOW_INSECURE_DEV_AUTH", None)


# ── 2. Import the app and DB plumbing AFTER env is set ───────────────────────
from fastapi.testclient import TestClient  # noqa: E402

from watchtower.api import app  # noqa: E402
from watchtower.database import (  # noqa: E402
    Base,
    SessionLocal,
    engine,
    init_db,
)


@pytest.fixture(scope="session", autouse=True)
def _initialize_database():
    """Create all tables once for the test session."""
    init_db()
    yield
    # Drop everything afterwards so re-runs don't pick up old state.
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean_tables():
    """Truncate every table between tests so each test starts clean.

    SQLite doesn't have TRUNCATE; iterate tables in reverse-FK order and
    DELETE. Fastest path for a small schema like ours.
    """
    yield
    with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(table.delete())


@pytest.fixture
def client() -> TestClient:
    """A TestClient with the static API token already attached."""
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-token"})
    return c


@pytest.fixture
def anon_client() -> TestClient:
    """A TestClient with NO auth header — for testing rejection paths."""
    return TestClient(app)


@pytest.fixture
def db_session():
    """Direct SQLAlchemy session for tests that need to assert on DB state."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
