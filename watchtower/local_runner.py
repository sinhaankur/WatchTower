"""Run a built project as a Podman container on localhost.

The current builder.py pipeline ends at "build artifacts produced + (if
remote nodes) rsync'd to nodes." For the develop-locally-before-paying-
for-a-server use case there's no further step — the operator's site
gets built but nothing serves it. This module fills that gap with a
single ``run_locally(project)`` entry point that:

  * Picks a free local TCP port.
  * Stops + removes any prior container WatchTower started for this
    project (idempotent — re-running ``Run Locally`` is the canonical
    "redeploy the latest build" flow).
  * For projects with a ``Containerfile`` / ``Dockerfile``: builds the
    image and runs it, exposing the project's recommended_port.
  * For static sites (Vite / Astro / plain HTML): runs ``nginx:alpine``
    with the build output mounted read-only at ``/usr/share/nginx/html``.

State is persisted in a small JSON sidecar under ``$WATCHTOWER_BUILD_DIR
/_local_runs/<project_id>.json`` so the UI can render "running on
http://localhost:<port>" across API restarts without re-querying podman
on every dashboard load.

Limitations (intentional for this slice):
  * Single-container per project. Phase 3 / multi-process apps need
    podman-compose or Kubernetes — out of scope here.
  * No log streaming yet — operators can ``podman logs <name>`` directly.
  * Static-site detection is path-based: if a build output dir exists
    we serve it; otherwise we expect a Dockerfile.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

BUILD_BASE = Path(os.getenv("WATCHTOWER_BUILD_DIR", "/tmp/watchtower-builds"))
_RUNS_DIR = BUILD_BASE / "_local_runs"


class LocalRunError(Exception):
    """Raised by run_locally / stop_locally with a user-facing message."""


@dataclass
class LocalRunStatus:
    project_id: str
    container_id: str
    container_name: str
    port: int
    url: str
    image: str
    serving_path: Optional[str] = None  # build output dir for static sites
    # ISO-8601 timestamp of when WatchTower spawned the container. Stays
    # in the JSON sidecar so the UI can render uptime without a per-load
    # `podman inspect`. Container restarts (`podman restart`) don't reset
    # this — `_started_at_iso()` is computed live for that case.
    started_at: Optional[str] = None
    # Convenience flag for the dashboard list — populated by
    # ``status_locally`` / ``list_running``, never persisted (mtime can
    # change after a host reboot, etc.).
    project_name: Optional[str] = None


# ── Internal helpers ──────────────────────────────────────────────────────────


def _podman() -> str:
    """Resolve the podman binary, falling back to docker for Linux dev
    machines. We prefer podman because the rest of WatchTower's
    container automation targets it and the macOS install path
    (``brew install podman``) is what the SetupWizard recommends."""
    p = shutil.which("podman") or "/opt/homebrew/bin/podman"
    if Path(p).exists():
        return p
    d = shutil.which("docker") or "/usr/local/bin/docker"
    if Path(d).exists():
        return d
    raise LocalRunError(
        "Neither podman nor docker is on PATH. Install podman with "
        "`brew install podman && podman machine init && podman machine start`."
    )


def _pick_free_port() -> int:
    """Bind-then-close trick: kernel picks a free port we can reuse a
    millisecond later. Cheaper than scanning a range, and safe enough
    for "develop locally" — true race-condition exposure would only
    matter at large scale."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _container_name(project_id: str) -> str:
    """Stable, project-specific name so the same project always points
    at the same container slot. Lets us stop the previous run cleanly
    on re-deploy."""
    return f"watchtower-{project_id.replace('-', '')[:24]}"


def _state_path(project_id: str) -> Path:
    _RUNS_DIR.mkdir(parents=True, exist_ok=True)
    return _RUNS_DIR / f"{project_id}.json"


def _load_state(project_id: str) -> Optional[LocalRunStatus]:
    p = _state_path(project_id)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text())
        return LocalRunStatus(**data)
    except (ValueError, TypeError):
        return None


def _save_state(status: LocalRunStatus) -> None:
    _state_path(status.project_id).write_text(json.dumps(asdict(status), indent=2))


def _clear_state(project_id: str) -> None:
    p = _state_path(project_id)
    if p.is_file():
        p.unlink()


def _run_cmd(args: list[str], cwd: Optional[Path] = None, timeout: int = 120) -> tuple[int, str]:
    """Wrapper around subprocess.run that returns (rc, combined_output)."""
    try:
        proc = subprocess.run(
            args,
            cwd=str(cwd) if cwd else None,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return 124, f"Timed out after {timeout}s: {' '.join(args[:4])}…"
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, out.strip()


def _stop_existing(project_id: str) -> None:
    """Idempotent: removes any prior container we started for this
    project. Failing-soft because a missing container is the desired
    end state."""
    name = _container_name(project_id)
    podman = _podman()
    _run_cmd([podman, "rm", "-f", name], timeout=15)
    _clear_state(project_id)


# ── Workspace + image discovery ───────────────────────────────────────────────


def _project_workspace(project_id: str) -> Path:
    """The most recent build's workspace lives at BUILD_BASE/<deployment_id>/repo
    (a symlink, post-1.7.x, into BUILD_BASE/_cache/<key>). We don't have
    the deployment id at run-time without another query, so the simpler
    rule: pick the newest dir under BUILD_BASE that has a ``repo`` child.
    Slight hack but keeps run_locally's signature clean."""
    candidates = []
    for child in BUILD_BASE.iterdir():
        if child.name.startswith("_"):
            continue
        repo = child / "repo"
        if repo.exists():
            candidates.append((child.stat().st_mtime, repo))
    if not candidates:
        raise LocalRunError(
            "No build workspace found. Trigger a deploy first so the project gets built."
        )
    candidates.sort(reverse=True)
    return candidates[0][1]


_STATIC_OUTPUT_CANDIDATES = ("dist", "build", "_site", "out", "public")


def _find_static_output(repo_dir: Path) -> Optional[Path]:
    """Look for a conventional static build output. Returning None means
    'this is not a static site — try the Containerfile path'."""
    for name in _STATIC_OUTPUT_CANDIDATES:
        candidate = repo_dir / name
        if candidate.is_dir() and any(candidate.iterdir()):
            return candidate
    # If the repo itself has an index.html and no node project markers,
    # treat the repo root as the static output.
    if (repo_dir / "index.html").is_file() and not (repo_dir / "package.json").is_file():
        return repo_dir
    return None


def _has_containerfile(repo_dir: Path) -> Optional[Path]:
    for name in ("Containerfile", "Dockerfile", "containerfile", "dockerfile"):
        p = repo_dir / name
        if p.is_file():
            return p
    return None


# ── Public API ────────────────────────────────────────────────────────────────


def run_locally(project_id: str, project_name: str, recommended_port: Optional[int] = None) -> LocalRunStatus:
    """Build (if needed) and run the project's most recent workspace as a
    container on localhost. Returns the URL the operator should open.

    ``recommended_port`` is the in-container port to expose for
    Dockerfile-based projects (defaults to 3000). Static-site path
    always exposes nginx's port 80 internally.
    """
    podman = _podman()
    repo_dir = _project_workspace(project_id)

    _stop_existing(project_id)

    name = _container_name(project_id)
    host_port = _pick_free_port()

    static_output = _find_static_output(repo_dir)
    containerfile = _has_containerfile(repo_dir)

    if containerfile:
        # Build then run the project's own image. Tag with the project
        # name so successive runs reuse the layer cache.
        image_tag = f"watchtower/{name}:latest"
        rc, out = _run_cmd(
            [podman, "build", "-t", image_tag, "-f", str(containerfile), str(repo_dir)],
            cwd=repo_dir,
            timeout=600,
        )
        if rc != 0:
            raise LocalRunError(f"podman build failed:\n{out[-1500:]}")

        in_port = recommended_port or 3000
        rc, out = _run_cmd(
            [
                podman, "run", "-d",
                "--name", name,
                "-p", f"{host_port}:{in_port}",
                image_tag,
            ],
            timeout=60,
        )
        if rc != 0:
            raise LocalRunError(f"podman run failed:\n{out[-1500:]}")
        container_id = out.strip().splitlines()[-1]
        status = LocalRunStatus(
            project_id=project_id,
            container_id=container_id,
            container_name=name,
            port=host_port,
            url=f"http://localhost:{host_port}",
            image=image_tag,
            started_at=_started_at_iso(name),
            project_name=project_name,
        )
        _save_state(status)
        logger.info("Local run started for project %s: %s", project_name, status.url)
        return status

    if static_output:
        image_tag = "docker.io/library/nginx:alpine"
        rc, out = _run_cmd(
            [
                podman, "run", "-d",
                "--name", name,
                "-p", f"{host_port}:80",
                "-v", f"{static_output}:/usr/share/nginx/html:ro,Z",
                image_tag,
            ],
            timeout=120,
        )
        if rc != 0:
            raise LocalRunError(f"podman run (nginx) failed:\n{out[-1500:]}")
        container_id = out.strip().splitlines()[-1]
        status = LocalRunStatus(
            project_id=project_id,
            container_id=container_id,
            container_name=name,
            port=host_port,
            url=f"http://localhost:{host_port}",
            image=image_tag,
            serving_path=str(static_output),
            started_at=_started_at_iso(name),
            project_name=project_name,
        )
        _save_state(status)
        logger.info("Local run (static) started for project %s: %s", project_name, status.url)
        return status

    raise LocalRunError(
        "No Containerfile / Dockerfile found, and no built static-site output "
        "directory (dist/, build/, _site/, out/, public/). Add one of those, "
        "or trigger a deploy that produces a build output."
    )


def stop_locally(project_id: str) -> None:
    """Stop the container we started for this project (idempotent)."""
    _stop_existing(project_id)


def restart_locally(project_id: str) -> Optional[LocalRunStatus]:
    """Restart the existing container without rebuilding the image.

    Different from re-running ``run_locally`` — that path stops, removes,
    and rebuilds. ``restart_locally`` is the cheap "bounce the container"
    path for picking up an env-var change or recovering from a crash
    without paying the rebuild cost. If no container is currently running
    for this project, returns None and the caller should fall back to
    ``run_locally``.
    """
    state = _load_state(project_id)
    if not state:
        return None
    podman = _podman()
    rc, out = _run_cmd([podman, "restart", state.container_name], timeout=30)
    if rc != 0:
        # Container vanished out from under us (manual ``podman rm``,
        # host reboot, etc.). Clear the state so the UI doesn't claim
        # "running" indefinitely; caller should re-run from scratch.
        _clear_state(project_id)
        raise LocalRunError(
            f"Could not restart container {state.container_name} — it may have been removed externally. "
            f"Click Run Locally to start a fresh one. Detail: {out[-400:]}"
        )
    # Update started_at so the UI's uptime counter resets correctly.
    state.started_at = _started_at_iso(state.container_name) or state.started_at
    _save_state(state)
    return state


def logs(project_id: str, tail: int = 200) -> str:
    """Return the most recent N lines of container output as a single
    string. Combines stdout + stderr the way operators expect from
    ``podman logs``. Returns empty string for a stopped container —
    callers can detect that via ``status_locally`` first if they need to
    distinguish 'no logs yet' from 'no container running'.
    """
    state = _load_state(project_id)
    if not state:
        return ""
    podman = _podman()
    # ``--tail`` accepts an integer; clamp to a sane range so a typo'd
    # negative or absurdly huge value can't return a 50 MB blob.
    tail_arg = max(1, min(int(tail), 5000))
    rc, out = _run_cmd(
        [podman, "logs", "--tail", str(tail_arg), state.container_name],
        timeout=15,
    )
    if rc != 0:
        # Container was removed externally — clear state and return empty
        # rather than raise, so the UI can still render "no logs" cleanly.
        if "no such container" in out.lower():
            _clear_state(project_id)
            return ""
        # Other errors: surface to the caller.
        raise LocalRunError(f"podman logs failed:\n{out[-1000:]}")
    return out


def _started_at_iso(container_name: str) -> Optional[str]:
    """Live-probe the container's start time. We could read it from the
    state file, but ``podman restart`` doesn't update that, so the live
    probe is correct after a restart. Returns None if the container
    isn't reachable (in which case the caller should fall back to the
    persisted ``started_at`` if any).
    """
    podman = _podman()
    rc, out = _run_cmd(
        [podman, "inspect", "--format", "{{.State.StartedAt}}", container_name],
        timeout=10,
    )
    if rc != 0:
        return None
    iso = out.strip()
    return iso or None


def list_running() -> list[LocalRunStatus]:
    """Return every project this WatchTower install has running locally.

    Walks the JSON state directory, lightly probes each container to
    confirm it's alive (clearing stale state on the fly), and returns
    the survivors with live ``started_at`` populated.

    Backs the new /api/local-containers dashboard endpoint. Cheaper than
    ``podman ps`` in the common case (zero or one running container)
    because we only shell out for the projects we already know about.
    """
    if not _RUNS_DIR.is_dir():
        return []
    out: list[LocalRunStatus] = []
    podman_bin: Optional[str]
    try:
        podman_bin = _podman()
    except LocalRunError:
        # No podman → no live containers to verify, but state files
        # might exist. Treat them all as stale.
        for f in _RUNS_DIR.glob("*.json"):
            try:
                f.unlink()
            except OSError:
                pass
        return []

    for f in sorted(_RUNS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            state = LocalRunStatus(**data)
        except (ValueError, TypeError):
            try: f.unlink()
            except OSError: pass
            continue
        # Liveness check
        rc, _ = _run_cmd(
            [podman_bin, "container", "exists", state.container_name],
            timeout=10,
        )
        if rc != 0:
            try: f.unlink()
            except OSError: pass
            continue
        live_started = _started_at_iso(state.container_name)
        if live_started:
            state.started_at = live_started
        out.append(state)
    return out


def status_locally(project_id: str) -> Optional[LocalRunStatus]:
    """Return the cached state, or None if the container has been
    stopped / never started. We do a lightweight liveness check — if the
    container disappeared (host reboot, manual ``podman rm``) we clear
    the cache so the UI doesn't claim "running" indefinitely.

    Refreshes ``started_at`` on every call so the UI's uptime stays
    correct even after a ``podman restart`` from outside WatchTower."""
    state = _load_state(project_id)
    if not state:
        return None
    podman = _podman()
    rc, _ = _run_cmd(
        [podman, "container", "exists", state.container_name],
        timeout=10,
    )
    if rc != 0:
        _clear_state(project_id)
        return None
    live_started = _started_at_iso(state.container_name)
    if live_started and live_started != state.started_at:
        state.started_at = live_started
        _save_state(state)
    return state
