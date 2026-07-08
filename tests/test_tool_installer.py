"""One-click tool installer — argv resolution, allowlist, state, and the
/runtime/tools/{tool}/install endpoints.

No real package manager is invoked: we monkeypatch shutil.which (so a manager
"exists") and tool_installer._spawn (so no subprocess runs). State files go to a
tmp dir via WATCHTOWER_DATA_DIR.
"""
from __future__ import annotations

import pytest

from watchtower import tool_installer


@pytest.fixture
def tmp_state(monkeypatch, tmp_path):
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    return tmp_path


def _bootstrap_admin(client) -> None:
    """Make the static-token user an OWNER with can_manage_team=True (the
    install gate) by creating a project — same pattern as the self-update
    tests."""
    r = client.post(
        "/api/projects",
        json={
            "name": "tool-install-bootstrap",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/ti.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text


# ── allowlist + argv resolution ──────────────────────────────────────────────


def test_unknown_tool_not_installable():
    ok, reason = tool_installer.can_install("rm-rf-everything")
    assert ok is False
    assert "one-click install list" in (reason or "")


def test_mac_uses_brew(monkeypatch):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "/opt/homebrew/bin/brew" if b == "brew" else None)
    assert tool_installer._install_argv("podman") == ["/opt/homebrew/bin/brew", "install", "podman"]
    # tailscale is a cask on mac
    assert tool_installer._install_argv("tailscale")[-2:] == ["--cask", "tailscale"]


def test_mac_without_brew_not_installable(monkeypatch):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: None)
    ok, reason = tool_installer.can_install("podman")
    assert ok is False
    assert "Homebrew" in (reason or "")


def test_linux_uses_apt_with_noninteractive_sudo(monkeypatch):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "linux")

    def which(b):
        return {"sudo": "/usr/bin/sudo", "apt-get": "/usr/bin/apt-get"}.get(b)

    monkeypatch.setattr(tool_installer, "_which", which)
    argv = tool_installer._install_argv("podman")
    assert argv == ["/usr/bin/sudo", "-n", "apt-get", "install", "-y", "podman"]
    # -n = never prompt for a password (fail fast instead of hanging)
    assert "-n" in argv


def test_linux_without_sudo_not_installable(monkeypatch):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "linux")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "/usr/bin/apt-get" if b == "apt-get" else None)
    assert tool_installer._install_argv("podman") is None


def test_windows_uses_winget(monkeypatch):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "windows")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "winget.exe" if b == "winget" else None)
    argv = tool_installer._install_argv("podman")
    assert argv is not None and "--id" in argv and "RedHat.Podman" in argv


# ── start_install + state ────────────────────────────────────────────────────


def test_start_install_writes_running_state(monkeypatch, tmp_state):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "/opt/homebrew/bin/brew" if b == "brew" else None)
    spawned = {}
    monkeypatch.setattr(tool_installer, "_spawn", lambda tool, argv, started: spawned.update(tool=tool, argv=argv))

    state = tool_installer.start_install("podman")
    assert state["state"] == "running"
    assert state["tool"] == "podman"
    assert spawned["tool"] == "podman"
    # And it persisted so a poll can read it.
    assert tool_installer.read_state("podman")["state"] == "running"


def test_start_install_refuses_when_already_running(monkeypatch, tmp_state):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "/opt/homebrew/bin/brew" if b == "brew" else None)
    monkeypatch.setattr(tool_installer, "_spawn", lambda *a: None)
    tool_installer.start_install("podman")
    with pytest.raises(ValueError, match="already in progress"):
        tool_installer.start_install("podman")


def test_start_install_refuses_non_installable(monkeypatch, tmp_state):
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: None)  # no brew
    with pytest.raises(ValueError):
        tool_installer.start_install("podman")


# ── API endpoints ────────────────────────────────────────────────────────────


def test_install_status_requires_auth(anon_client):
    assert anon_client.get("/api/runtime/tools/podman/install/status").status_code == 401


def test_install_requires_auth(anon_client):
    assert anon_client.post("/api/runtime/tools/podman/install").status_code == 401


def test_install_status_shape(client, monkeypatch):
    r = client.get("/api/runtime/tools/podman/install/status")
    assert r.status_code == 200
    body = r.json()
    assert body["tool"] == "podman"
    assert "can_install" in body
    assert "last_run" in body


def test_install_requires_manage_team(client, monkeypatch):
    """Without the admin bootstrap, the static-token user lacks can_manage_team."""
    from unittest.mock import patch
    with patch("watchtower.api.runtime._user_can_manage_org_secrets", return_value=False):
        r = client.post("/api/runtime/tools/podman/install")
    assert r.status_code == 403
    assert "can_manage_team" in r.json()["detail"]


def test_install_kicks_off_job(client, monkeypatch, tmp_path):
    _bootstrap_admin(client)
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: "/opt/homebrew/bin/brew" if b == "brew" else None)
    monkeypatch.setattr(tool_installer, "_spawn", lambda *a: None)

    r = client.post("/api/runtime/tools/podman/install")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["started"] is True
    assert body["last_run"]["state"] == "running"


def test_install_non_installable_returns_400(client, monkeypatch):
    _bootstrap_admin(client)
    monkeypatch.setattr(tool_installer, "_platform", lambda: "mac")
    monkeypatch.setattr(tool_installer, "_which", lambda b: None)  # no brew
    r = client.post("/api/runtime/tools/podman/install")
    assert r.status_code == 400
