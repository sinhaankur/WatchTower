"""Guards the "lean by default" packaging contract.

The PyPI / pipx install of WatchTower is intentionally minimal: the SSH-deploy
(fabric), LLM-agent (openai), and durable-queue (redis/rq) dependencies live in
optional extras (see pyproject.toml [project.optional-dependencies]). The code
lazy-imports them at the one call site that needs each, so a minimal install
must still import the FastAPI app and degrade gracefully — never crash on
import — when an extra is absent.

These tests run in a subprocess with a sys.meta_path finder that simulates the
optional packages being absent. A subprocess is required because conftest.py
imports `watchtower` at collection time; the blocker has to be installed before
the very first import for the simulation to be faithful.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap


# The packages that MUST NOT be required for a minimal install to import.
_OPTIONAL_PACKAGES = ("fabric", "openai", "redis", "rq", "invoke", "paramiko")


def _run_under_blocker(body: str) -> subprocess.CompletedProcess:
    """Execute ``body`` in a fresh interpreter where the optional packages
    raise ModuleNotFoundError at import time, mirroring a minimal install."""
    preamble = textwrap.dedent(
        f"""
        import sys
        from importlib.abc import MetaPathFinder

        _BLOCKED = {set(_OPTIONAL_PACKAGES)!r}

        class _Blocker(MetaPathFinder):
            def find_spec(self, name, path, target=None):
                if name.split(".")[0] in _BLOCKED:
                    raise ModuleNotFoundError(
                        f"No module named {{name!r}} (simulated minimal install)"
                    )
                return None

        sys.meta_path.insert(0, _Blocker())
        """
    )
    script = preamble + textwrap.dedent(body)
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_api_app_imports_without_optional_extras():
    """watchtower.api:app must import with none of the optional extras."""
    result = _run_under_blocker(
        """
        import watchtower.api as api
        assert api.app is not None
        print("APP_OK")
        """
    )
    assert "APP_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr


def test_deploy_server_imports_without_fabric():
    """The legacy deploy-server module imports without fabric; the dep is
    only reached when an SSH deploy actually runs."""
    result = _run_under_blocker(
        """
        import watchtower.deploy_server as ds
        assert ds is not None
        print("DS_OK")
        """
    )
    assert "DS_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr


def test_agent_raises_503_with_install_hint_when_openai_absent():
    """Hitting the agent without [agent] yields a 503 that names the extra."""
    result = _run_under_blocker(
        """
        from watchtower.api.agent import _import_openai
        from fastapi import HTTPException
        try:
            _import_openai()
            raise SystemExit("did not raise")
        except HTTPException as e:
            assert e.status_code == 503, e.status_code
            assert "agent" in e.detail
            print("AGENT_503_OK")
        """
    )
    assert "AGENT_503_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr


def test_build_connection_raises_with_ssh_extra_hint_when_fabric_absent():
    """Building an SSH connection without [ssh] yields an actionable error."""
    result = _run_under_blocker(
        """
        from watchtower.deploy_server import build_connection, Node
        node = Node(
            name="n", host="h", user="u", port=22,
            remote_path="/x", reload_command="true",
        )
        try:
            build_connection(node, None)
            raise SystemExit("did not raise")
        except RuntimeError as e:
            assert "ssh" in str(e)
            print("SSH_RUNTIMEERROR_OK")
        """
    )
    assert "SSH_RUNTIMEERROR_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr


def test_queue_falls_back_in_process_without_redis():
    """With REDIS_URL set but redis absent, the queue degrades to the
    in-process BackgroundTasks path (returns None) instead of crashing."""
    result = _run_under_blocker(
        """
        import os
        os.environ["REDIS_URL"] = "redis://localhost:6379/0"
        from watchtower.queue import _get_queue
        assert _get_queue() is None
        print("QUEUE_FALLBACK_OK")
        """
    )
    assert "QUEUE_FALLBACK_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr


def test_worker_exits_cleanly_without_queue_extra():
    """`python -m watchtower.worker` without [queue] must exit with an
    actionable message, not a raw ModuleNotFoundError traceback."""
    result = _run_under_blocker(
        """
        try:
            import watchtower.worker  # noqa: F401  (import triggers the guard)
            raise SystemExit("did not raise")
        except SystemExit as e:
            msg = str(e)
            assert "queue" in msg, msg
            print("WORKER_GUARD_OK")
        """
    )
    assert "WORKER_GUARD_OK" in result.stdout, (result.stdout, result.stderr)
    assert result.returncode == 0, result.stderr
