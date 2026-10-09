"""Runtime-agnostic container support — Podman OR Docker.

WatchTower defaults to Podman (rootless) but works with Docker so a host
that already runs Docker just works. These tests pin the preference-order
logic, runtime detection, the pod-capability branch, and the friendly
Docker-only managed-DB guard.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from watchtower import managed_db_runtime as mdr


# ── preference order ──────────────────────────────────────────────────────────

def test_default_order_is_podman_first(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_CONTAINER_RUNTIME", raising=False)
    assert mdr._runtime_preference_order() == ("podman", "docker")


def test_docker_preference_flips_order(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_CONTAINER_RUNTIME", "docker")
    assert mdr._runtime_preference_order() == ("docker", "podman")


def test_podman_preference_is_exclusive(monkeypatch):
    # Explicit podman means podman-only — don't silently fall back to docker.
    monkeypatch.setenv("WATCHTOWER_CONTAINER_RUNTIME", "podman")
    assert mdr._runtime_preference_order() == ("podman",)


def test_unknown_preference_uses_default(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_CONTAINER_RUNTIME", "containerd")
    assert mdr._runtime_preference_order() == ("podman", "docker")


# ── detection ─────────────────────────────────────────────────────────────────

def test_detect_runtime_returns_docker_when_only_docker(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_CONTAINER_RUNTIME", raising=False)

    def fake_resolve(tool):
        return "/usr/bin/docker" if tool == "docker" else None

    with patch("watchtower.tool_resolver.resolve_tool", side_effect=fake_resolve):
        assert mdr.detect_runtime() == "docker"
        assert mdr.runtime_supports_pods() is False  # docker has no pods


def test_detect_runtime_prefers_podman_when_both(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_CONTAINER_RUNTIME", raising=False)
    with patch("watchtower.tool_resolver.resolve_tool", return_value="/usr/bin/x"):
        # Both resolve; podman-first order wins.
        assert mdr.detect_runtime() == "podman"
        assert mdr.runtime_supports_pods() is True


def test_detect_runtime_none_when_neither(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_CONTAINER_RUNTIME", raising=False)
    with patch("watchtower.tool_resolver.resolve_tool", return_value=None):
        assert mdr.detect_runtime() is None
        assert mdr.have_runtime() is False


# ── managed-DB pod guard on Docker ────────────────────────────────────────────

def test_managed_db_create_on_docker_gives_actionable_error(monkeypatch):
    """A Docker-only host must get a clear 'needs Podman' message for managed
    databases, not a cryptic `docker: 'pod' is not a docker command`."""
    monkeypatch.delenv("WATCHTOWER_CONTAINER_RUNTIME", raising=False)

    def fake_resolve(tool):
        return "/usr/bin/docker" if tool == "docker" else None

    spec = mdr.CreateSpec(
        db_id="11111111-1111-1111-1111-111111111111",
        image="docker.io/library/postgres:16-alpine",
        host_port=55432,
        container_port=5432,
        env={"POSTGRES_PASSWORD": "x"},
    )

    with patch("watchtower.tool_resolver.resolve_tool", side_effect=fake_resolve):
        with pytest.raises(mdr.ManagedDbRuntimeError) as ei:
            mdr.create_pod(spec)
    msg = str(ei.value)
    assert "Podman" in msg
    assert "Docker doesn't have" in msg or "everything else" in msg
