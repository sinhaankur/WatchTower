"""Tests for the WatchTower service / config endpoints.

These power the Integrations page's "Autonomous Operation" section —
the toggle for ``watchtower.service`` (auto-update on boot) and the
form that edits ``watchtower.yml`` (poll interval, monitor mode,
include/exclude lists).

The status endpoint shells out to systemctl. On CI runners systemctl
exists but the unit isn't installed; we just assert the response shape
is intact and the flags are booleans.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


# ── /watchtower-service/status ──────────────────────────────────────────────

def test_service_status_returns_full_shape(client: TestClient):
    r = client.get("/api/runtime/watchtower-service/status")
    assert r.status_code == 200
    body = r.json()
    for key in ("service", "active", "enabled", "state", "installed"):
        assert key in body, f"Missing key: {key}"
    assert isinstance(body["active"], bool)
    assert isinstance(body["enabled"], bool)
    assert isinstance(body["installed"], bool)
    assert body["service"] == "watchtower.service"


def test_service_status_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/watchtower-service/status")
    assert r.status_code == 401


# ── /watchtower/config GET + PUT ────────────────────────────────────────────

def test_get_config_returns_safe_subset(client: TestClient, tmp_path, monkeypatch):
    """GET should return defaults when no file exists, and the safe-subset
    keys the SPA's form binds to."""
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WATCHTOWER_CONFIG", str(tmp_path / "absent.yml"))
    r = client.get("/api/runtime/watchtower/config")
    assert r.status_code == 200
    body = r.json()
    for key in ("path", "exists", "interval", "monitor_only", "cleanup", "include", "exclude"):
        assert key in body
    # Defaults match watchtower CLI's own defaults
    assert body["interval"] == 300
    assert body["monitor_only"] is False
    assert body["cleanup"] is True
    assert body["include"] == []
    assert body["exclude"] == []


def test_put_config_round_trips(client: TestClient, tmp_path, monkeypatch):
    """PUT writes the YAML; subsequent GET reads the same values back."""
    target = tmp_path / "watchtower.yml"
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WATCHTOWER_CONFIG", str(target))

    payload = {
        "interval": 600,
        "monitor_only": True,
        "cleanup": False,
        "include": ["web-*", "api-prod"],
        "exclude": ["postgres-*"],
    }
    r = client.put("/api/runtime/watchtower/config", json=payload)
    assert r.status_code == 200
    saved = r.json()
    # Service is presumably not running on CI → restart should be skipped.
    assert saved["restart"] in {"skipped", "restart_failed", "restarted"}

    # File now exists and round-trips.
    assert target.is_file()
    r2 = client.get("/api/runtime/watchtower/config")
    body = r2.json()
    assert body["exists"] is True
    assert body["interval"] == 600
    assert body["monitor_only"] is True
    assert body["cleanup"] is False
    assert body["include"] == ["web-*", "api-prod"]
    assert body["exclude"] == ["postgres-*"]


def test_put_config_validates_interval_range(client: TestClient, tmp_path, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WATCHTOWER_CONFIG", str(tmp_path / "watchtower.yml"))
    # Pydantic enforces 30 ≤ interval ≤ 86400 — 5 should 422.
    r = client.put("/api/runtime/watchtower/config", json={"interval": 5})
    assert r.status_code == 422


def test_put_config_preserves_unknown_keys(client: TestClient, tmp_path, monkeypatch):
    """If the existing watchtower.yml has a notifications block (or anything
    else we don't expose in the form), the round-trip must NOT discard it."""
    target = tmp_path / "watchtower.yml"
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("WATCHTOWER_CONFIG", str(target))
    target.write_text(
        "watchtower:\n"
        "  interval: 300\n"
        "  cleanup: true\n"
        "containers:\n"
        "  include: []\n"
        "  exclude: []\n"
        "notifications:\n"
        "  enabled: true\n"
        "  type: webhook\n"
        "  url: https://example.com/hook\n",
        encoding="utf-8",
    )

    r = client.put("/api/runtime/watchtower/config", json={
        "interval": 600,
        "monitor_only": False,
        "cleanup": True,
        "include": [],
        "exclude": [],
    })
    assert r.status_code == 200

    raw = target.read_text(encoding="utf-8")
    assert "notifications" in raw, "PUT must round-trip unknown keys"
    assert "https://example.com/hook" in raw


def test_config_endpoints_require_auth(anon_client: TestClient):
    assert anon_client.get("/api/runtime/watchtower/config").status_code == 401
    assert anon_client.put(
        "/api/runtime/watchtower/config",
        json={"interval": 300, "monitor_only": False, "cleanup": True, "include": [], "exclude": []},
    ).status_code == 401
