"""Podman-pod lifecycle helpers for WatchTower-managed databases.

Parallel module to `local_runner.py` — same low-level subprocess +
binary-resolution patterns, but a different concern. `local_runner`
deploys user *apps*; this module manages first-class WatchTower-owned
*infrastructure* (Postgres pods today; pgbouncer / pg_exporter
sidecars later).

Design choices:
  * One **pod** per managed database, even though v0 ships with a single
    container in it. The pod is the addressable thing the rest of the
    feature talks to; v1 sidecars (exporter, backup agent) join the
    same pod and share its network namespace.
  * **Named volumes**, not bind mounts. macOS Podman runs in a VM and
    bind mounts of host paths (especially /tmp) are flaky; named
    volumes Just Work everywhere.
  * **Port published on 127.0.0.1 by default**, with an opt-in env
    `WATCHTOWER_MANAGED_DB_BIND=0.0.0.0` for tailnet exposure. We
    don't default to 0.0.0.0 because the operator hasn't necessarily
    set up Tailscale yet — that's a separate flow (see Remote Access).
  * Every subprocess call uses the same `_run_cmd` shape as
    `local_runner` (returncode + combined stdout/stderr) so error
    handling is consistent across the codebase.

Tests monkeypatch `_run` and `_podman_path` to avoid invoking real
podman during CI.
"""
from __future__ import annotations

import logging
import socket
import subprocess
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


class ManagedDbRuntimeError(Exception):
    """Raised for any podman-side failure that should surface to the user verbatim."""


# ── Binary resolution ────────────────────────────────────────────────────────


def _podman_path() -> Optional[str]:
    """Resolve podman, falling back to docker for Linux dev hosts.

    Returns None if neither is installed — callers turn that into a
    user-facing 400 with an install hint, not a 500. Both lookups go
    through the shared tool_resolver, so the GUI-bundle / Homebrew
    fallback paths stay consistent with the rest of the app (no more
    one-off "/opt/homebrew/bin/podman" check that drifts from the table).
    """
    from watchtower.tool_resolver import resolve_tool

    for candidate in ("podman", "docker"):
        found = resolve_tool(candidate)
        if found:
            return found
    return None


def have_runtime() -> bool:
    return _podman_path() is not None


# ── Subprocess wrapper ───────────────────────────────────────────────────────


def _run(args: list[str], *, timeout: float = 60.0) -> tuple[int, str, str]:
    """Run a command; return (rc, stdout, stderr). Never raises on non-zero."""
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout or "", result.stderr or ""
    except FileNotFoundError:
        return 127, "", f"{args[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{args[0]}: timed out after {timeout}s"


# ── Naming + port allocation ─────────────────────────────────────────────────


def pod_name(db_id: str) -> str:
    """Stable pod name from the DB UUID. Distinct prefix from
    `local_runner`'s `watchtower-<project>` so the two namespaces never
    collide on a host that runs both features."""
    return f"watchtower-db-{db_id.replace('-', '')[:20]}"


def container_name(db_id: str) -> str:
    return f"{pod_name(db_id)}-pg"


def volume_name(db_id: str) -> str:
    return f"{pod_name(db_id)}-data"


def _data_volume_path(image: str) -> str:
    """Where the engine stores its persistent data inside the container.

    Looked up by image ref substring so we don't need a parallel lookup
    table that the router has to keep in sync. Default to Postgres'
    path since that was v0's only engine.
    """
    img = image.lower()
    if "mysql" in img or "mariadb" in img:
        return "/var/lib/mysql"
    if "mongo" in img:
        return "/data/db"
    if "redis" in img:
        return "/data"
    return "/var/lib/postgresql/data"


def pick_free_port() -> int:
    """Same bind-then-close trick local_runner uses — cheap and good
    enough for desktop / personal-server use. Real multi-tenant
    deployments should reserve ranges instead."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ── Pod / container lifecycle ────────────────────────────────────────────────


@dataclass
class CreateSpec:
    db_id: str
    image: str                 # e.g. "docker.io/library/postgres:16-alpine"
    host_port: int             # port to publish on the host
    container_port: int        # engine's listen port inside the container (5432, 3306, …)
    env: dict[str, str]        # engine-specific POSTGRES_* / MYSQL_* / etc.
    bind_host: str = "127.0.0.1"  # set to "0.0.0.0" for tailnet exposure


def create_pod(spec: CreateSpec) -> None:
    """Create the pod + Postgres container. Idempotent: if either
    object already exists with our generated name, we tear it down
    first and re-create. The DB row is the source of truth; podman is
    state we own and can rebuild.

    Raises `ManagedDbRuntimeError` with the verbatim podman stderr on
    any failure so the API surfaces it to the operator.
    """
    bin_ = _podman_path()
    if not bin_:
        raise ManagedDbRuntimeError(
            "No container runtime found. Install Podman (or Docker) and retry."
        )

    pod = pod_name(spec.db_id)
    container = container_name(spec.db_id)
    volume = volume_name(spec.db_id)

    # Cleanest path: tear down anything left from a prior attempt so
    # `podman pod create` doesn't fail with "name already in use".
    # We're conservative — failures here are non-fatal, the create
    # call below will surface a clear error if state is still bad.
    _run([bin_, "pod", "rm", "-f", pod], timeout=30.0)
    _run([bin_, "volume", "create", volume], timeout=10.0)

    rc, _out, err = _run(
        [bin_, "pod", "create",
         "--name", pod,
         "-p", f"{spec.bind_host}:{spec.host_port}:{spec.container_port}"],
        timeout=20.0,
    )
    if rc != 0:
        raise ManagedDbRuntimeError(
            f"Failed to create pod: {err.strip() or 'unknown error'}"
        )

    # Build the `podman run` argv with one `-e KEY=VALUE` per env entry.
    # Order is stable so failure messages are reproducible.
    env_args: list[str] = []
    for k, v in spec.env.items():
        env_args += ["-e", f"{k}={v}"]

    # Engine-specific data dir. We don't try to be clever here: the
    # caller passes a `data_volume_path` if they want something other
    # than the engine's canonical default.
    data_path = _data_volume_path(spec.image)
    rc, _out, err = _run(
        [bin_, "run", "-d",
         "--pod", pod,
         "--name", container,
         "--restart", "unless-stopped",
         *env_args,
         "-v", f"{volume}:{data_path}",
         spec.image],
        timeout=60.0,
    )
    if rc != 0:
        # Roll back the pod we just created so we don't leave debris.
        _run([bin_, "pod", "rm", "-f", pod], timeout=30.0)
        raise ManagedDbRuntimeError(
            f"Failed to start container: {err.strip() or 'unknown error'}"
        )


def start_pod(db_id: str) -> None:
    bin_ = _podman_path()
    if not bin_:
        raise ManagedDbRuntimeError("No container runtime found.")
    rc, _out, err = _run([bin_, "pod", "start", pod_name(db_id)], timeout=30.0)
    if rc != 0:
        raise ManagedDbRuntimeError(err.strip() or "pod start failed")


def stop_pod(db_id: str) -> None:
    bin_ = _podman_path()
    if not bin_:
        raise ManagedDbRuntimeError("No container runtime found.")
    rc, _out, err = _run([bin_, "pod", "stop", pod_name(db_id)], timeout=30.0)
    if rc != 0:
        raise ManagedDbRuntimeError(err.strip() or "pod stop failed")


def delete_pod(db_id: str, *, keep_volume: bool = False) -> None:
    """Tear down the pod, container, and (optionally) the data volume.

    `keep_volume=True` is the safe default for the v0 UI's delete flow
    so a misclick doesn't nuke the user's data; the SPA passes
    `purge=true` only when the user explicitly checks "also delete data".
    """
    bin_ = _podman_path()
    if not bin_:
        raise ManagedDbRuntimeError("No container runtime found.")
    _run([bin_, "pod", "rm", "-f", pod_name(db_id)], timeout=30.0)
    if not keep_volume:
        _run([bin_, "volume", "rm", "-f", volume_name(db_id)], timeout=10.0)


def wait_for_db_ready(
    container: str, engine: str, db_user: str, db_password: str,
    db_name: str, *, timeout_s: int = 30,
) -> None:
    """Poll a newly-started managed DB until it accepts auth-ed queries.

    Used by the restore-to-new flow: spin up a fresh pod, then wait
    here until the engine is accepting connections before running the
    restore. Without this the restore races the engine's init and
    fails with "could not connect: Connection refused" because the
    container is running but the server inside it hasn't bound the
    port yet.

    Per-engine probes:
      * **postgres**: `psql -c "SELECT 1"` against the user's DB
      * **mysql/mariadb**: `mysql -e "SELECT 1"` (auth via MYSQL_PWD)
      * **mongodb**: `mongosh --eval "db.runCommand({ping:1})"` against
        the admin DB (where the root user lives in our setup)

    Times out cleanly after `timeout_s` and raises `ManagedDbRuntimeError`
    with the last probe's stderr so the API can surface the failure.
    """
    import time as _time
    bin_ = _podman_path()
    if not bin_:
        raise ManagedDbRuntimeError("No container runtime found.")

    deadline = _time.time() + timeout_s
    last_err = ""
    while _time.time() < deadline:
        if engine == "postgres":
            cmd = [bin_, "exec", "-e", f"PGPASSWORD={db_password}",
                   container, "psql", "-U", db_user, "-d", db_name,
                   "-tA", "-c", "SELECT 1"]
        elif engine in ("mysql", "mariadb"):
            client = "mariadb" if engine == "mariadb" else "mysql"
            cmd = [bin_, "exec", "-e", f"MYSQL_PWD={db_password}",
                   container, client, "-u", db_user, "-h", "127.0.0.1",
                   "--protocol=TCP", db_name, "-e", "SELECT 1"]
        elif engine == "mongodb":
            cmd = [bin_, "exec", container,
                   "mongosh", "-u", db_user, "-p", db_password,
                   "--authenticationDatabase", "admin",
                   "--quiet", "--eval", "db.runCommand({ping:1}).ok"]
        else:
            raise ManagedDbRuntimeError(
                f"wait_for_db_ready: engine '{engine}' not supported"
            )
        rc, _out, err = _run(cmd, timeout=5.0)
        if rc == 0:
            return
        last_err = err
        _time.sleep(1.0)

    raise ManagedDbRuntimeError(
        f"Database '{container}' did not become ready within {timeout_s}s. "
        f"Last probe error: {last_err.strip() or '(none)'}"
    )


def pod_running(db_id: str) -> bool:
    """True iff the pod currently has at least one running container."""
    bin_ = _podman_path()
    if not bin_:
        return False
    rc, out, _err = _run(
        [bin_, "pod", "inspect", pod_name(db_id), "--format", "{{.State}}"],
        timeout=10.0,
    )
    if rc != 0:
        return False
    return out.strip().lower() in ("running", "degraded")
