"""Coverage for the server-side self-update endpoint.

Browser-mode / self-hosted installs running from a source checkout can
update in place: POST /api/runtime/self-update runs `run.sh update`
(git pull + reinstall + rebuild) detached, then run.sh restarts the
service. The desktop app uses electron-updater instead and never hits
this path.

Tested here:
  - auth gate (401 anon)
  - admin gate (403 without can_manage_team)
  - source-install detection (400 + actionable message on packaged builds)
  - happy path spawns the updater exactly once and writes 'running' state
  - in-progress guard (409 if a run is already going)
  - status endpoint reports capability + last-run state

The actual `run.sh update` is never executed — subprocess.Popen is
patched so the test process isn't restarted out from under pytest.
"""
from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient


def _bootstrap_admin(client: TestClient) -> None:
    """Create a project so the static-token user becomes OWNER with
    can_manage_team=True (the self-update gate). Mirrors the backup
    tests' bootstrap."""
    r = client.post(
        "/api/projects",
        json={
            "name": "self-update-bootstrap",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/su.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text


# ── Auth / admin gates ───────────────────────────────────────────────────────

def test_self_update_requires_auth(anon_client: TestClient):
    r = anon_client.post("/api/runtime/self-update")
    assert r.status_code == 401


def test_self_update_status_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/self-update/status")
    assert r.status_code == 401


def test_self_update_403_without_manage_team(client: TestClient):
    # No bootstrap → static-token user has no can_manage_team membership.
    with patch(
        "watchtower.api.runtime._user_can_manage_org_secrets", return_value=False
    ):
        r = client.post("/api/runtime/self-update")
    assert r.status_code == 403
    assert "can_manage_team" in r.json()["detail"]


# ── Source-install detection ─────────────────────────────────────────────────

def test_self_update_400_on_packaged_install(client: TestClient):
    """A packaged/pip install (no run.sh) must refuse with an actionable
    message rather than try and half-break."""
    _bootstrap_admin(client)
    with patch(
        "watchtower.api.runtime._self_update_capable",
        return_value=(False, "This install isn't a source checkout (no run.sh)."),
    ):
        r = client.post("/api/runtime/self-update")
    assert r.status_code == 400
    assert "source checkout" in r.json()["detail"]


# ── Happy path ───────────────────────────────────────────────────────────────

def test_self_update_spawns_updater_and_sets_running(client: TestClient, tmp_path):
    _bootstrap_admin(client)
    state_file = tmp_path / "self-update.state"
    log_file = tmp_path / "self-update.log"

    with patch(
        "watchtower.api.runtime._self_update_capable", return_value=(True, None)
    ), patch(
        "watchtower.api.runtime.SELF_UPDATE_STATE", state_file
    ), patch(
        "watchtower.api.runtime.SELF_UPDATE_LOG", log_file
    ), patch(
        "watchtower.api.runtime.DEV_DIR", tmp_path
    ), patch(
        "watchtower.api.runtime.subprocess.Popen"
    ) as popen:
        r = client.post("/api/runtime/self-update")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["started"] is True
    assert "from_version" in body
    # Spawned exactly once, detached.
    assert popen.call_count == 1
    _args, kwargs = popen.call_args
    assert kwargs.get("start_new_session") is True
    # State flipped to running before the spawn.
    assert state_file.exists()
    assert '"running"' in state_file.read_text()


def test_self_update_409_when_already_running(client: TestClient, tmp_path):
    _bootstrap_admin(client)
    state_file = tmp_path / "self-update.state"
    state_file.write_text('{"state":"running"}')

    with patch(
        "watchtower.api.runtime._self_update_capable", return_value=(True, None)
    ), patch(
        "watchtower.api.runtime.SELF_UPDATE_STATE", state_file
    ), patch(
        "watchtower.api.runtime.subprocess.Popen"
    ) as popen:
        r = client.post("/api/runtime/self-update")

    assert r.status_code == 409
    assert popen.call_count == 0  # never spawn a second run


# ── Status endpoint ──────────────────────────────────────────────────────────

def test_self_update_status_reports_capability(client: TestClient, tmp_path):
    state_file = tmp_path / "self-update.state"
    state_file.write_text('{"state":"succeeded","exit_code":0}')

    with patch(
        "watchtower.api.runtime._self_update_capable", return_value=(True, None)
    ), patch(
        "watchtower.api.runtime.SELF_UPDATE_STATE", state_file
    ):
        r = client.get("/api/runtime/self-update/status")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["can_self_update"] is True
    assert body["reason"] is None
    assert body["current_version"]
    assert body["last_run"]["state"] == "succeeded"


def test_self_update_status_reports_reason_when_not_capable(client: TestClient):
    with patch(
        "watchtower.api.runtime._self_update_capable",
        return_value=(False, "Not a source checkout."),
    ):
        r = client.get("/api/runtime/self-update/status")
    assert r.status_code == 200
    body = r.json()
    assert body["can_self_update"] is False
    assert body["reason"] == "Not a source checkout."
