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


def test_update_me_personalizes_display_name(client: TestClient):
    """Easy personalization: rename yourself without GitHub. Persists + shows up
    on the next GET /api/me."""
    r = client.patch("/api/me", json={"name": "Ankur Sinha"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Ankur Sinha"
    # sticks on a fresh read
    assert client.get("/api/me").json()["name"] == "Ankur Sinha"


def test_update_me_rejects_blank_name(client: TestClient):
    assert client.patch("/api/me", json={"name": "   "}).status_code == 400


def test_update_me_requires_auth(anon_client: TestClient):
    assert anon_client.patch("/api/me", json={"name": "x"}).status_code == 401
