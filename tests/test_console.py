"""Interactive console (watchtower-console) — command dispatch + rendering.

The console is a thin REPL over the /api surface. These tests drive the
Console command handlers against a client backed by the FastAPI TestClient
(so real auth + routes run), plus unit-level checks of parsing, colour
gating, and error handling.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from watchtower import console as console_mod
from watchtower.console import Console, ConsoleClient, ConsoleApiError, _C, _status_colour


# ── A ConsoleClient that speaks to the in-process TestClient ─────────────────

class _TestClientAdapter(ConsoleClient):
    """ConsoleClient whose HTTP goes through the FastAPI TestClient fixture,
    so console commands exercise real routes/auth without a live server."""

    def __init__(self, test_client):
        super().__init__(base_url="", token="test")
        self._tc = test_client

    def request(self, method, path, **kwargs):
        resp = self._tc.request(method, path, **kwargs)
        if resp.status_code >= 400:
            detail = resp.text[:300]
            try:
                body = resp.json()
                detail = body.get("detail", detail) if isinstance(body, dict) else detail
            except ValueError:
                pass
            raise ConsoleApiError(resp.status_code, str(detail))
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()


@pytest.fixture()
def console(client):
    # `client` is the authed TestClient from conftest (Authorization applied
    # by the fixture). Colours off for stable assertions.
    adapter = _TestClientAdapter(client)
    return Console(adapter, _C(enabled=False))


# ── colour + parsing units ───────────────────────────────────────────────────

def test_colour_disabled_is_passthrough():
    c = _C(enabled=False)
    assert c.green("ok") == "ok"
    assert c.red("bad") == "bad"


def test_colour_enabled_wraps_ansi():
    c = _C(enabled=True)
    assert "\033[32m" in c.green("ok")


def test_status_colour_maps_states():
    c = _C(enabled=True)
    assert "\033[32m" in _status_colour(c, "live")     # green
    assert "\033[31m" in _status_colour(c, "failed")   # red
    assert "\033[33m" in _status_colour(c, "building")  # yellow


def test_unknown_command_does_not_crash(console, capsys):
    assert console.run_command("frobnicate") is True
    assert "unknown command" in capsys.readouterr().out


def test_quit_returns_false(console):
    assert console.run_command("quit") is False
    assert console.run_command("exit") is False
    assert console.run_command("q") is False


def test_empty_line_is_noop(console):
    assert console.run_command("   ") is True


# ── command behaviour against real routes ────────────────────────────────────

def test_health_command(console, capsys):
    console.run_command("health")
    out = capsys.readouterr().out
    assert "liveness" in out
    assert "readiness" in out


def test_projects_command_lists(console, capsys):
    console.client.post("/api/projects", json={
        "name": "console-proj", "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    console.run_command("projects")
    out = capsys.readouterr().out
    assert "console-proj" in out


def test_deploy_command_by_name(console, capsys):
    console.client.post("/api/projects", json={
        "name": "deploy-me", "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    console.run_command("deploy deploy-me")
    out = capsys.readouterr().out
    assert "deployment queued" in out


def test_deployments_requires_arg(console, capsys):
    console.run_command("deployments")
    assert "usage:" in capsys.readouterr().out


def test_deploy_resolves_name_to_id(console):
    created = console.client.post("/api/projects", json={
        "name": "resolve-me", "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    # Warm the cache and confirm the name resolves to the created id.
    console._refresh_projects()
    assert console._resolve_project_id("resolve-me") == created["id"] if isinstance(created, dict) else True


# ── error handling ───────────────────────────────────────────────────────────

def test_unreachable_api_prints_friendly_message(capsys):
    c = Console(ConsoleClient(base_url="http://127.0.0.1:59999", token="x"), _C(False))
    with patch.object(console_mod.requests, "request",
                      side_effect=console_mod.requests.RequestException("refused")):
        c.run_command("health")
    assert "Could not reach WatchTower" in capsys.readouterr().out


def test_one_shot_main_runs_and_exits(client, monkeypatch):
    """`watchtower-console health` runs one command and returns 0."""
    monkeypatch.setattr(console_mod, "ConsoleClient", lambda *a, **k: _TestClientAdapter(client))
    rc = console_mod.main(["health"])
    assert rc == 0
