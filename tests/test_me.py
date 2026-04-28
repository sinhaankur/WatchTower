"""Tests for the /api/me identity endpoint."""
from __future__ import annotations

from fastapi.testclient import TestClient


def test_me_returns_user_id_for_authenticated_caller(client: TestClient):
    r = client.get("/api/me")
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"]
    # All permission flags should be booleans even when org cannot be resolved.
    for key in (
        "can_manage_team",
        "can_manage_deployments",
        "can_manage_nodes",
        "can_create_projects",
    ):
        assert isinstance(body[key], bool)


def test_me_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/me")
    assert r.status_code == 401
