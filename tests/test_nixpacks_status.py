"""Tests for the Nixpacks resolver and ``GET /api/runtime/nixpacks-status``.

Locks the resolution order documented in build_tools.py:
  1. WATCHTOWER_NIXPACKS_BIN env override
  2. Bundled binary under WATCHTOWER_RESOURCES_DIR/binaries/<platform>/
  3. system PATH

And the status endpoint's auth + shape contract that the SPA's banner
relies on.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from watchtower import build_tools


def _make_executable(path: Path) -> None:
    path.write_text("#!/bin/sh\necho nixpacks 1.41.0\n")
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Each test starts from a clean slate so previous overrides don't
    leak. The resolver reads env at call time, not import time, so
    monkeypatch.delenv is sufficient."""
    monkeypatch.delenv("WATCHTOWER_NIXPACKS_BIN", raising=False)
    monkeypatch.delenv("WATCHTOWER_RESOURCES_DIR", raising=False)


def test_find_nixpacks_returns_missing_when_nothing_configured(monkeypatch):
    """No env, no bundled, nothing on PATH → 'missing' source. The status
    endpoint surfaces this as an actionable banner."""
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: None)
    res = build_tools.find_nixpacks()
    assert res.path is None
    assert res.source == "missing"


def test_find_nixpacks_picks_env_override_first(tmp_path, monkeypatch):
    """env var beats everything else — it's the test/CI/dev escape hatch."""
    bin_path = tmp_path / "nixpacks-from-env"
    _make_executable(bin_path)
    monkeypatch.setenv("WATCHTOWER_NIXPACKS_BIN", str(bin_path))
    # Set up bundled too — env should still win
    monkeypatch.setenv("WATCHTOWER_RESOURCES_DIR", str(tmp_path))
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: "/some/system/nixpacks")

    res = build_tools.find_nixpacks()
    assert res.source == "env"
    assert res.path == bin_path


def test_find_nixpacks_falls_back_to_bundled_when_env_missing(tmp_path, monkeypatch):
    """No env override → bundled binary under resources/<platform>/ wins
    over system PATH. This is the packaged-installer's default path."""
    subdir = build_tools._platform_subdir()
    if subdir is None:
        pytest.skip("Unsupported test platform — no bundled subdir to populate")
    bundled_dir = tmp_path / "binaries" / subdir
    bundled_dir.mkdir(parents=True)
    bundled = bundled_dir / "nixpacks"
    _make_executable(bundled)

    monkeypatch.setenv("WATCHTOWER_RESOURCES_DIR", str(tmp_path))
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: "/some/system/nixpacks")

    res = build_tools.find_nixpacks()
    assert res.source == "bundled"
    assert res.path == bundled


def test_find_nixpacks_falls_back_to_system_when_bundled_missing(monkeypatch):
    """No env, no bundled → system PATH. This is the dev-clone path."""
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: "/usr/local/bin/nixpacks")

    res = build_tools.find_nixpacks()
    assert res.source == "system"
    assert str(res.path) == "/usr/local/bin/nixpacks"


def test_find_nixpacks_bad_env_override_falls_through(tmp_path, monkeypatch):
    """A typo'd env var pointing at a non-existent file shouldn't
    permanently break the app — fall through to other resolution
    strategies. (Resolver still tries, just doesn't take it.)"""
    monkeypatch.setenv("WATCHTOWER_NIXPACKS_BIN", str(tmp_path / "does-not-exist"))
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: "/usr/bin/nixpacks")

    res = build_tools.find_nixpacks()
    assert res.source == "system", "bad env override should fall through, not pin to 'env'"


def test_get_nixpacks_version_returns_none_for_unrunnable_binary(tmp_path):
    """A corrupt or non-binary file should return None, not crash. The
    status endpoint then shows 'version: null' rather than a 500."""
    fake = tmp_path / "fake-nixpacks"
    fake.write_text("not actually a binary")
    fake.chmod(0o755)
    # Either the version probe returns None or hits a permission/exec
    # error and returns None — both are fine, what matters is we don't
    # raise.
    assert build_tools.get_nixpacks_version(fake, timeout=2.0) is None


# ── Endpoint tests ───────────────────────────────────────────────────────────


def test_nixpacks_status_endpoint_shape_when_missing(client, monkeypatch):
    """Lock the response shape the SPA's banner code reads. When the
    binary isn't found, every required key still has a sensible value
    so the frontend doesn't need defensive coalescing everywhere."""
    monkeypatch.delenv("WATCHTOWER_NIXPACKS_BIN", raising=False)
    monkeypatch.delenv("WATCHTOWER_RESOURCES_DIR", raising=False)
    monkeypatch.setattr(build_tools.shutil, "which", lambda _: None)

    resp = client.get("/api/runtime/nixpacks-status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["available"] is False
    assert data["source"] == "missing"
    assert data["path"] is None
    assert data["version"] is None
    assert data["expected_version"] == build_tools.NIXPACKS_EXPECTED_VERSION
    assert data["version_drift"] is False
    # platform_supported reflects "would Nixpacks even build for us"
    # — True on linux/macOS, False on Windows.
    assert isinstance(data["platform_supported"], bool)


def test_nixpacks_status_endpoint_requires_auth(anon_client):
    resp = anon_client.get("/api/runtime/nixpacks-status")
    assert resp.status_code == 401
