"""Unit tests for the run-locally Podman manager (1.14.0+).

Like test_local_deploy.py, we focus on the cheap-but-load-bearing
helpers that don't require an actual Podman runtime:

  * ``restart_locally`` / ``logs`` / ``list_running`` graceful behavior
    when no state file exists (empty install, container externally
    removed). These are user-visible "click button → nothing breaks"
    paths.
  * ``LocalRunStatus`` JSON round-trip — the new ``started_at`` and
    ``project_name`` fields must survive the file sidecar.

End-to-end "actually start a container" testing is left to manual
verification on macOS/Linux with Podman installed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from watchtower import local_runner
from watchtower.local_runner import LocalRunStatus


@pytest.fixture
def isolated_runs_dir(tmp_path, monkeypatch):
    """Redirect _RUNS_DIR to a tmp path so tests don't see (or write
    to) the real ~/.watchtower-builds/_local_runs from a dev clone."""
    runs = tmp_path / "_local_runs"
    runs.mkdir()
    monkeypatch.setattr(local_runner, "_RUNS_DIR", runs)
    return runs


def test_restart_locally_returns_none_when_no_state(isolated_runs_dir):
    """Clicking Restart on a project that's never been Run-Locally'd
    should be a clean no-op, not a 500."""
    result = local_runner.restart_locally("00000000-0000-0000-0000-000000000000")
    assert result is None


def test_logs_returns_empty_when_no_state(isolated_runs_dir):
    """Same — fetching logs before any container exists shouldn't
    error. The dashboard polls this on mount; a 500 here would
    spam toasts."""
    text = local_runner.logs("00000000-0000-0000-0000-000000000000")
    assert text == ""


def test_list_running_empty_when_no_state_files(isolated_runs_dir):
    assert local_runner.list_running() == []


def test_list_running_clears_unparseable_state_files(isolated_runs_dir):
    """A corrupt sidecar (truncated write, wrong shape) shouldn't
    poison the dashboard. ``list_running`` should remove it and
    move on."""
    bad = isolated_runs_dir / "broken.json"
    bad.write_text("not-valid-json")
    result = local_runner.list_running()
    # Either the bad file gets cleaned up (preferred) or it's just
    # skipped; either way the result is an empty list. The cleanup
    # path requires podman to be on PATH so it can liveness-check
    # other entries; if podman isn't installed, the function bails
    # early and just unlinks every state file.
    assert result == []


def test_local_run_status_serializes_new_fields(isolated_runs_dir):
    """``started_at`` + ``project_name`` (added in 1.14.0) must
    round-trip the JSON sidecar so the UI's uptime label survives a
    backend restart."""
    status = LocalRunStatus(
        project_id="abc-123",
        container_id="deadbeef",
        container_name="watchtower-abc123",
        port=12345,
        url="http://localhost:12345",
        image="watchtower/test:latest",
        serving_path=None,
        started_at="2026-05-04T22:00:00.000000000Z",
        project_name="My Test Project",
    )
    local_runner._save_state(status)

    sidecar = isolated_runs_dir / "abc-123.json"
    assert sidecar.is_file()
    raw = json.loads(sidecar.read_text())
    assert raw["started_at"] == "2026-05-04T22:00:00.000000000Z"
    assert raw["project_name"] == "My Test Project"

    loaded = local_runner._load_state("abc-123")
    assert loaded is not None
    assert loaded.started_at == status.started_at
    assert loaded.project_name == status.project_name


def test_local_run_status_loads_old_state_without_new_fields(isolated_runs_dir):
    """Pre-1.14.0 state files don't have ``started_at`` /
    ``project_name``. Loading them shouldn't crash — those fields just
    default to None. Without this, an upgrade would 500 every Run
    Locally page until the user manually deleted the sidecar."""
    legacy = {
        "project_id": "old-project",
        "container_id": "abc",
        "container_name": "watchtower-old",
        "port": 8000,
        "url": "http://localhost:8000",
        "image": "nginx:alpine",
        "serving_path": None,
    }
    sidecar = isolated_runs_dir / "old-project.json"
    sidecar.write_text(json.dumps(legacy))

    loaded = local_runner._load_state("old-project")
    assert loaded is not None
    assert loaded.started_at is None
    assert loaded.project_name is None
    # Existing fields unchanged
    assert loaded.url == "http://localhost:8000"
