"""Smoke tests for the GET /api/runtime/version endpoint.

The endpoint queries GitHub Releases at request time. We patch
``_fetch_latest_release`` so tests don't depend on network access or on
the actual contents of the GitHub repository.
"""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

import watchtower
from watchtower.api import runtime as runtime_module


def _reset_cache() -> None:
    runtime_module._update_cache["value"] = None
    runtime_module._update_cache["fetched_at"] = 0.0


def test_version_returns_current_when_github_unreachable(client: TestClient):
    _reset_cache()
    with patch.object(runtime_module, "_fetch_latest_release", return_value=None):
        r = client.get("/api/runtime/version")
    assert r.status_code == 200
    body = r.json()
    assert body["current"] == watchtower.__version__
    assert body["latest"] is None
    assert body["has_update"] is False
    assert "error" in body  # degraded response when fetch fails


def test_version_reports_update_when_remote_is_newer(client: TestClient):
    _reset_cache()
    fake = {
        "latest": "99.0.0",
        "tag_name": "v99.0.0",
        "release_url": "https://github.com/sinhaankur/WatchTower/releases/tag/v99.0.0",
        "published_at": "2099-01-01T00:00:00Z",
        "name": "v99.0.0",
    }
    with patch.object(runtime_module, "_fetch_latest_release", return_value=fake):
        r = client.get("/api/runtime/version?force=true")
    assert r.status_code == 200
    body = r.json()
    assert body["current"] == watchtower.__version__
    assert body["latest"] == "99.0.0"
    assert body["has_update"] is True
    assert body["release_url"].endswith("/v99.0.0")


def test_version_no_update_when_remote_is_same(client: TestClient):
    _reset_cache()
    fake = {
        "latest": watchtower.__version__,
        "tag_name": f"v{watchtower.__version__}",
        "release_url": "https://github.com/sinhaankur/WatchTower/releases/latest",
        "published_at": "2026-01-01T00:00:00Z",
        "name": f"v{watchtower.__version__}",
    }
    with patch.object(runtime_module, "_fetch_latest_release", return_value=fake):
        r = client.get("/api/runtime/version?force=true")
    assert r.status_code == 200
    assert r.json()["has_update"] is False


def test_version_requires_auth(anon_client: TestClient):
    _reset_cache()
    r = anon_client.get("/api/runtime/version")
    assert r.status_code == 401
