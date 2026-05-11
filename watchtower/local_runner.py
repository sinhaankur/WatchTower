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
import signal
import socket
import subprocess
import sys
import time
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
    # When kind="python-http-server", this is the PID of the spawned
    # python http.server subprocess instead of a podman container. The
    # container_* fields are filled with placeholder values so the UI
    # can render the same "Live at http://…" pill without branching.
    kind: str = "podman"  # "podman" | "python-http-server"
    pid: Optional[int] = None


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


def _have_container_runtime() -> bool:
    """Check whether a container runtime is available WITHOUT raising.
    Used by run_locally to decide whether to fall back to the no-Podman
    Python http.server path for static sites."""
    try:
        _podman()
        return True
    except LocalRunError:
        return False


def _serve_static_with_python(serving_path: Path, port: int) -> int:
    """Spawn `python -m http.server <port> -d <serving_path>` and return
    its PID. Used as a fallback when Podman/Docker isn't installed and
    the project is a static site — the user just wants to see their
    files at a URL, not learn container tooling.

    Logs go to the local-runs state directory so they're discoverable
    without `ps`-ing for the process. The subprocess is detached from
    our process group so a Ctrl-C on the WatchTower API doesn't kill
    it; stop_locally() sends an explicit SIGTERM by PID."""
    log_dir = _RUNS_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"http-server-{port}.log"

    log_fp = open(log_path, "ab")  # binary append; subprocess writes raw bytes
    cmd = [
        sys.executable, "-m", "http.server",
        str(port),
        "--bind", "127.0.0.1",
        "--directory", str(serving_path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=log_fp,
        stderr=log_fp,
        cwd=str(serving_path),
        # New process group so the server keeps running if the API restarts.
        start_new_session=True,
    )
    # Brief pause + liveness probe so we fail fast if it crashed at boot
    # (e.g. port collision the kernel didn't catch). The bind-then-close
    # in _pick_free_port races with this rare-but-possible.
    time.sleep(0.3)
    if proc.poll() is not None:
        log_fp.close()
        try:
            tail = log_path.read_text()[-1500:]
        except Exception:
            tail = "(no log captured)"
        raise LocalRunError(
            f"Static-site server failed to start on port {port}. "
            f"Last log: {tail}"
        )
    return proc.pid


def _iso_now() -> str:
    """ISO-8601 timestamp for the python http.server path — that runtime
    has no equivalent of `podman inspect StartedAt`, so we just record
    spawn-time when we save state."""
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _process_alive(pid: int) -> bool:
    """True if a process with the given PID is still running.
    Uses kill(pid, 0) which is non-fatal — returns immediately with
    success if the process exists, OSError(ESRCH) otherwise."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


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
    """Idempotent: removes any prior container OR python http.server we
    started for this project. Failing-soft because a missing process
    is the desired end state.

    Branch on the recorded `kind` so we don't ask Podman to remove a
    pure-Python server (and don't try to SIGTERM a container PID we
    never recorded). When Podman isn't available at all we skip the
    container path silently — there's nothing to clean up there."""
    name = _container_name(project_id)
    prior = _load_state(project_id)
    if prior and prior.kind == "python-http-server" and prior.pid:
        if _process_alive(prior.pid):
            try:
                os.kill(prior.pid, signal.SIGTERM)
                # Give it a moment to flush + exit cleanly.
                for _ in range(20):
                    if not _process_alive(prior.pid):
                        break
                    time.sleep(0.05)
                if _process_alive(prior.pid):
                    os.kill(prior.pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
    if _have_container_runtime():
        podman = _podman()
        _run_cmd([podman, "rm", "-f", name], timeout=15)
    _clear_state(project_id)


# ── Workspace + image discovery ───────────────────────────────────────────────


def _project_workspace(project_id: str) -> Path:
    """Locate the most recent build workspace for *project_id*.

    Layout history:
      - Post-1.7: BUILD_BASE/workspaces/<project_id>/repo/  (current)
      - Legacy:   BUILD_BASE/<deployment_id>/repo/          (old)
    The current builder pipeline writes under `workspaces/<project_id>/repo`
    so we look there FIRST. If absent, fall back to the legacy layout —
    pick the newest dir directly under BUILD_BASE that has a `repo` child.

    Was a real bug: the function only handled the legacy layout, so on a
    fresh install Run Locally always failed with "No build workspace
    found" even after a successful deploy.
    """
    project_ws = BUILD_BASE / "workspaces" / project_id / "repo"
    if project_ws.is_dir():
        return project_ws

    # Legacy fallback: newest top-level dir with a `repo` child.
    candidates = []
    for child in BUILD_BASE.iterdir():
        if child.name.startswith("_") or child.name in ("workspaces", "caches", "locks"):
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
    serves on whatever ``_pick_free_port`` returns.

    Three paths in priority order:
      1. Containerfile/Dockerfile — podman build + run (REQUIRES container runtime)
      2. Static output dir + container runtime available — nginx mounts the dir
      3. Static output dir + NO container runtime — pure-Python http.server

    Path (3) is the "I just want to see my Portfolio at a URL" case — a
    hand-coded static site, no Node, no Docker, no surface area to learn.
    Tradeoff: no caching headers, no compression, slow on large sites.
    Fine for previewing; not a production server.
    """
    repo_dir = _project_workspace(project_id)

    # Detect the workspace shape FIRST so we can pick the right runtime.
    # _find_static_output returns repo_dir itself when there's an
    # index.html and no package.json — that's our hand-coded-site case.
    static_output = _find_static_output(repo_dir)
    containerfile = _has_containerfile(repo_dir)

    have_runtime = _have_container_runtime()
    if containerfile and not have_runtime:
        raise LocalRunError(
            "This project has a Dockerfile/Containerfile but Podman/Docker "
            "isn't installed. Install Podman with `brew install podman && "
            "podman machine init && podman machine start`, or remove the "
            "Dockerfile to fall back to the static-site path."
        )

    # If we have neither a Dockerfile nor a static output, there's nothing
    # to serve — surface that explicitly before we even resolve podman.
    if not containerfile and not static_output:
        raise LocalRunError(
            "No Containerfile / Dockerfile found, and no static-site output "
            "(dist/, build/, _site/, out/, public/, or index.html at the "
            "repo root). Add one of those, or trigger a deploy that produces "
            "a build output."
        )

    _stop_existing(project_id)
    name = _container_name(project_id)
    host_port = _pick_free_port()

    # Static site → Python http.server, always.
    #
    # Originally this fell through to the Podman+nginx path when a
    # container runtime was available. That breaks on macOS, where
    # `podman machine` runs Podman inside a VM and `/tmp` (where the
    # builder rsyncs workspaces) isn't auto-bind-mounted — `podman run
    # -v /tmp/…:/usr/share/nginx/html` fails with
    # "Error: statfs /tmp/…: no such file or directory" even though
    # the host path is fine. The Python http.server runs on the host
    # directly, no VM, no bind mounts, works on Mac/Linux/Windows the
    # same. Tradeoff: no caching headers, no compression, no SPA
    # fallback. Fine for previewing.
    if static_output and not containerfile:
        pid = _serve_static_with_python(static_output, host_port)
        status = LocalRunStatus(
            project_id=project_id,
            container_id=f"py-{pid}",
            container_name=name,
            port=host_port,
            url=f"http://localhost:{host_port}",
            image="python-http-server",
            serving_path=str(static_output),
            started_at=_iso_now(),
            project_name=project_name,
            kind="python-http-server",
            pid=pid,
        )
        _save_state(status)
        logger.info(
            "Local run (python http.server) started for %s: %s (pid=%d)",
            project_name, status.url, pid,
        )
        return status

    # From here on we definitely have a container runtime.
    podman = _podman()

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

    For the python http.server path there's no equivalent of
    ``podman restart``; we return None so the caller falls back to a
    fresh run_locally(), which respawns the subprocess with the same
    serving_path (cheap — no build to redo).
    """
    state = _load_state(project_id)
    if not state:
        return None
    if state.kind == "python-http-server":
        return None  # caller falls back to run_locally
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

    if state.kind == "python-http-server":
        # Read the on-disk log we point the subprocess at.
        log_path = _RUNS_DIR / "logs" / f"http-server-{state.port}.log"
        if not log_path.is_file():
            return ""
        try:
            text = log_path.read_text(errors="replace")
        except OSError:
            return ""
        lines = text.splitlines()
        tail_n = max(1, min(int(tail), 5000))
        return "\n".join(lines[-tail_n:])

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
        podman_bin = None

    for f in sorted(_RUNS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            state = LocalRunStatus(**data)
        except (ValueError, TypeError):
            try: f.unlink()
            except OSError: pass
            continue

        if state.kind == "python-http-server":
            # PID-based liveness — no Podman query needed.
            if state.pid and _process_alive(state.pid):
                out.append(state)
            else:
                try: f.unlink()
                except OSError: pass
            continue

        if podman_bin is None:
            # State references a container but we can't query the runtime.
            # Treat as stale — better to clear than to lie about uptime.
            try: f.unlink()
            except OSError: pass
            continue

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
    """Return the cached state, or None if the runtime is no longer
    alive. We do a lightweight liveness check — if the container or
    Python http.server process disappeared (host reboot, manual ``podman
    rm``, ``kill``) we clear the cache so the UI doesn't claim "running"
    indefinitely.

    Refreshes ``started_at`` on every call so the UI's uptime stays
    correct even after a ``podman restart`` from outside WatchTower."""
    state = _load_state(project_id)
    if not state:
        return None

    if state.kind == "python-http-server":
        # No container_inspect equivalent — just check the PID.
        if not state.pid or not _process_alive(state.pid):
            _clear_state(project_id)
            return None
        return state

    if not _have_container_runtime():
        # Stale state from a previous Podman session that's no longer
        # available — best to clear it so the UI doesn't lie.
        _clear_state(project_id)
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
