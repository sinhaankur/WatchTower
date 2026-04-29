"""Tests for GET /api/runtime/active-deployments.

Powers the sidebar nav badge showing live in-flight deploy count next
to "Applications". Cheap query, polled every 8s by the SPA. Lives on
/api/runtime/ instead of /api/projects/ to avoid colliding with the
projects router's /{project_id} catch-all path.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_active_count_returns_int(client: TestClient):
    """Response shape is {active: int} regardless of state."""
    r = client.get("/api/runtime/active-deployments")
    assert r.status_code == 200
    body = r.json()
    assert "active" in body
    assert isinstance(body["active"], int)
    assert body["active"] >= 0


def test_active_count_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/active-deployments")
    assert r.status_code == 401
