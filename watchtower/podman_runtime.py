"""General-purpose local Podman management: machine, containers, pods.

Third member of the local-runtime family:

  * ``local_runner.py``        — WatchTower-built project containers
  * ``managed_db_runtime.py``  — managed-database pods
  * ``podman_runtime.py``      — *anything else* the user wants to run:
    arbitrary containers and pods created from the Containers page.

Reuses managed_db_runtime's binary resolution + subprocess wrapper so
all three behave identically on PATH quirks (Homebrew macOS) and the
docker fallback. Everything here is argv-list subprocess — never a
shell — and every user-supplied token is validated against a strict
pattern before it can reach argv, so a name like ``--privileged`` can't
smuggle flags in.

Containers/pods created here are labelled ``watchtower.managed=true``
(plus ``watchtower.project=<uuid>`` when linked to a project) so the UI
can distinguish "ours" from pre-existing containers, and project pages
can show their own containers via label filter.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

# Deliberate reuse of the sibling module's private helpers — keeping one
# resolution + subprocess shape across the whole local-runtime family.
from watchtower.managed_db_runtime import _podman_path, _run

logger = logging.getLogger(__name__)

LABEL_MANAGED = "watchtower.managed"
LABEL_PROJECT = "watchtower.project"
LABEL_PROJECT_NAME = "watchtower.project_name"

# Container/pod/image name discipline. First char alphanumeric so a
# value can never be parsed as a flag; the rest mirrors what podman
# itself accepts.
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$")
# Image refs: registry/repo:tag@digest character set. Also must not
# start with '-'.
_IMAGE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.\-/:@]{0,255}$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


class PodmanError(Exception):
    """User-facing podman failure — message is safe to surface verbatim."""


def _require_bin() -> str:
    bin_ = _podman_path()
    if not bin_:
        raise PodmanError(
            "Podman (or Docker) is not installed or not on PATH. "
            "Install it from Settings → System, then retry."
        )
    return bin_


def _validate_name(name: str, what: str = "name") -> str:
    if not _NAME_RE.match(name or ""):
        raise PodmanError(
            f"Invalid {what} {name!r} — use letters, digits, '.', '_' or '-', "
            f"starting with a letter or digit."
        )
    return name


def _validate_image(image: str) -> str:
    if not _IMAGE_RE.match(image or ""):
        raise PodmanError(f"Invalid image reference {image!r}.")
    return image


def _validate_port(value: Any, what: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise PodmanError(f"Invalid {what} port {value!r}.")
    if not (1 <= port <= 65535):
        raise PodmanError(f"{what} port {port} out of range 1-65535.")
    return port


# ── Status / machine ─────────────────────────────────────────────────────────


def runtime_status() -> Dict[str, Any]:
    """Everything the connection card needs in one call: binary, version,
    machine state (macOS/Windows VMs), and whether the socket answers."""
    bin_ = _podman_path()
    if not bin_:
        return {
            "available": False,
            "binary": None,
            "version": None,
            "machine": None,
            "connected": False,
            "hint": "Install Podman (https://podman.io) or Docker, then refresh.",
        }

    _rc, out, _err = _run([bin_, "--version"], timeout=10.0)
    version = out.strip() or None

    # `podman machine` only exists where podman runs in a VM (mac/Win).
    # On Linux the subcommand errors — that's fine, machine stays None.
    machine: Optional[Dict[str, Any]] = None
    if "podman" in bin_:
        rc, out, _err = _run([bin_, "machine", "list", "--format", "json"], timeout=15.0)
        if rc == 0 and out.strip():
            try:
                machines = json.loads(out)
                if machines:
                    m = next((x for x in machines if x.get("Default")), machines[0])
                    machine = {
                        "name": m.get("Name"),
                        "running": bool(m.get("Running")),
                        "cpus": m.get("CPUs"),
                        "memory": m.get("Memory"),
                    }
            except json.JSONDecodeError:
                machine = None

    rc, _out, err = _run([bin_, "info", "--format", "{{.Host.Arch}}"], timeout=15.0)
    connected = rc == 0

    hint = None
    if not connected:
        if machine and not machine["running"]:
            hint = "The Podman machine is stopped — click Start to bring it up."
        else:
            hint = (err or "Podman is installed but not responding.").strip()[:300]

    return {
        "available": True,
        "binary": bin_,
        "version": version,
        "machine": machine,
        "connected": connected,
        "hint": hint,
    }


def machine_start() -> Dict[str, Any]:
    bin_ = _require_bin()
    rc, _out, err = _run([bin_, "machine", "start"], timeout=180.0)
    if rc != 0 and "already running" not in (err or "").lower():
        raise PodmanError(f"Could not start the Podman machine: {(err or 'unknown error').strip()[:300]}")
    return runtime_status()


# ── Containers ───────────────────────────────────────────────────────────────


def list_containers() -> List[Dict[str, Any]]:
    bin_ = _require_bin()
    rc, out, err = _run([bin_, "ps", "-a", "--format", "json"], timeout=30.0)
    if rc != 0:
        raise PodmanError((err or "podman ps failed").strip()[:300])
    try:
        raw = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        raise PodmanError("Could not parse podman output.")

    containers = []
    for c in raw:
        labels = c.get("Labels") or {}
        ports = []
        for p in c.get("Ports") or []:
            if isinstance(p, dict) and p.get("host_port"):
                ports.append({"host": p.get("host_port"), "container": p.get("container_port")})
        containers.append({
            "id": (c.get("Id") or "")[:12],
            "name": (c.get("Names") or ["?"])[0],
            "image": c.get("Image"),
            "state": c.get("State"),
            "status": c.get("Status"),
            "pod": c.get("PodName") or None,
            "created": c.get("CreatedAt") or c.get("Created"),
            "ports": ports,
            "managed": labels.get(LABEL_MANAGED) == "true",
            "project_id": labels.get(LABEL_PROJECT),
            "project_name": labels.get(LABEL_PROJECT_NAME),
        })
    return containers


def create_container(
    *,
    name: str,
    image: str,
    ports: Optional[List[Dict[str, Any]]] = None,
    env: Optional[Dict[str, str]] = None,
    volumes: Optional[List[Dict[str, str]]] = None,
    pod: Optional[str] = None,
    restart_policy: str = "unless-stopped",
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
) -> Dict[str, Any]:
    """`podman run -d` with validated arguments. Pulls the image on first
    use (timeout sized accordingly). Returns {id, name}."""
    bin_ = _require_bin()
    _validate_name(name, "container name")
    _validate_image(image)
    if restart_policy not in ("no", "always", "on-failure", "unless-stopped"):
        raise PodmanError(f"Invalid restart policy {restart_policy!r}.")

    args = [bin_, "run", "-d", "--name", name, "--label", f"{LABEL_MANAGED}=true"]
    if project_id:
        args += ["--label", f"{LABEL_PROJECT}={project_id}"]
        if project_name:
            # Label values land in argv directly (no shell) — but keep them sane.
            args += ["--label", f"{LABEL_PROJECT_NAME}={project_name[:64]}"]
    if pod:
        _validate_name(pod, "pod name")
        args += ["--pod", pod]
    else:
        # --restart conflicts with pod membership (the pod owns lifecycle).
        args += ["--restart", restart_policy]
        for p in ports or []:
            host = _validate_port(p.get("host"), "host")
            ctr = _validate_port(p.get("container"), "container")
            args += ["-p", f"{host}:{ctr}"]
    for key, value in (env or {}).items():
        if not _ENV_KEY_RE.match(key):
            raise PodmanError(f"Invalid environment variable name {key!r}.")
        args += ["-e", f"{key}={value}"]
    for v in volumes or []:
        host_path = (v.get("host") or "").strip()
        ctr_path = (v.get("container") or "").strip()
        if not host_path.startswith("/") or not ctr_path.startswith("/"):
            raise PodmanError("Volume paths must be absolute (start with '/').")
        args += ["-v", f"{host_path}:{ctr_path}"]
    args.append(image)

    # 300s: first run may pull a multi-GB image. The API endpoint runs
    # this in a worker thread so the event loop isn't blocked.
    rc, out, err = _run(args, timeout=300.0)
    if rc != 0:
        raise PodmanError((err or "podman run failed").strip()[:500])
    return {"id": out.strip()[:12], "name": name}


_CONTAINER_ACTIONS = {
    "start": ["start"],
    "stop": ["stop", "-t", "10"],
    "restart": ["restart", "-t", "10"],
    "remove": ["rm", "-f"],
}


def container_action(name: str, action: str) -> None:
    bin_ = _require_bin()
    _validate_name(name, "container name")
    verb = _CONTAINER_ACTIONS.get(action)
    if not verb:
        raise PodmanError(f"Unknown action {action!r}.")
    rc, _out, err = _run([bin_, *verb, name], timeout=60.0)
    if rc != 0:
        raise PodmanError((err or f"podman {action} failed").strip()[:300])


def container_logs(name: str, tail: int = 200) -> str:
    bin_ = _require_bin()
    _validate_name(name, "container name")
    tail = max(1, min(int(tail), 2000))
    rc, out, err = _run([bin_, "logs", "--tail", str(tail), name], timeout=30.0)
    if rc != 0:
        raise PodmanError((err or "podman logs failed").strip()[:300])
    # podman writes container stderr to stderr — users want both streams.
    return (out + err)[-64 * 1024:]


# ── Pods ─────────────────────────────────────────────────────────────────────


def list_pods() -> List[Dict[str, Any]]:
    bin_ = _require_bin()
    rc, out, err = _run([bin_, "pod", "ps", "--format", "json"], timeout=30.0)
    if rc != 0:
        raise PodmanError((err or "podman pod ps failed").strip()[:300])
    try:
        raw = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        raise PodmanError("Could not parse podman output.")

    pods = []
    for p in raw:
        labels = p.get("Labels") or {}
        pods.append({
            "id": (p.get("Id") or "")[:12],
            "name": p.get("Name"),
            "status": p.get("Status"),
            "created": p.get("Created"),
            "containers": [
                {"id": (c.get("Id") or "")[:12], "names": c.get("Names"), "status": c.get("Status")}
                for c in p.get("Containers") or []
            ],
            "managed": labels.get(LABEL_MANAGED) == "true",
            "project_id": labels.get(LABEL_PROJECT),
            "project_name": labels.get(LABEL_PROJECT_NAME),
        })
    return pods


def create_pod(
    *,
    name: str,
    ports: Optional[List[Dict[str, Any]]] = None,
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
) -> Dict[str, Any]:
    """`podman pod create`. Port mappings live on the pod — containers
    added later share its network namespace, which is exactly the
    multi-container app pattern (web + db on localhost)."""
    bin_ = _require_bin()
    _validate_name(name, "pod name")
    args = [bin_, "pod", "create", "--name", name, "--label", f"{LABEL_MANAGED}=true"]
    if project_id:
        args += ["--label", f"{LABEL_PROJECT}={project_id}"]
        if project_name:
            args += ["--label", f"{LABEL_PROJECT_NAME}={project_name[:64]}"]
    for p in ports or []:
        host = _validate_port(p.get("host"), "host")
        ctr = _validate_port(p.get("container"), "container")
        args += ["-p", f"{host}:{ctr}"]
    rc, out, err = _run(args, timeout=60.0)
    if rc != 0:
        raise PodmanError((err or "podman pod create failed").strip()[:300])
    return {"id": out.strip()[:12], "name": name}


_POD_ACTIONS = {
    "start": ["pod", "start"],
    "stop": ["pod", "stop", "-t", "10"],
    "restart": ["pod", "restart"],
    "remove": ["pod", "rm", "-f"],
}


def pod_action(name: str, action: str) -> None:
    bin_ = _require_bin()
    _validate_name(name, "pod name")
    verb = _POD_ACTIONS.get(action)
    if not verb:
        raise PodmanError(f"Unknown action {action!r}.")
    rc, _out, err = _run([bin_, *verb, name], timeout=120.0)
    if rc != 0:
        raise PodmanError((err or f"podman pod {action} failed").strip()[:300])
