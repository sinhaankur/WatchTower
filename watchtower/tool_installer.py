"""One-click local tool installation.

Replaces the "copy these shell commands and run them yourself" flow with a
button that installs a tool via the host's package manager and reports
progress. Scope is deliberately narrow and safe:

  * Only a fixed allowlist of tools (podman, nginx, cloudflared, tailscale)
    mapped to package-manager argv — NO user input ever reaches a command,
    and we never use a shell, so there's no injection surface.
  * Only package-manager installs that can run unattended:
      - macOS  → Homebrew (runs as the user; no sudo prompt)
      - Linux  → apt / dnf with `sudo -n` (non-interactive; fails fast and
                 cleanly if passwordless sudo isn't configured, rather than
                 hanging on a password prompt)
      - Windows→ winget
  * The install runs as a detached background process that writes a small
    JSON state file the API polls — same shape as the self-update flow.

Anything that needs a GUI installer or interactive sudo is reported as
not-auto-installable so the UI falls back to showing the copy-paste recipe.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Tools the one-click installer understands. Keep in sync with the install-
# command recipes in api/runtime.py (those remain the copy-paste fallback).
INSTALLABLE_TOOLS = ("podman", "nginx", "cloudflared", "tailscale")


def _platform() -> str:
    if sys.platform == "darwin":
        return "mac"
    if sys.platform.startswith("win"):
        return "windows"
    return "linux"


def _state_dir() -> Path:
    """Where install state files live — mirrors api/runtime.py's DEV_DIR
    resolution so everything stays under one place."""
    base = os.getenv("WATCHTOWER_DATA_DIR")
    root = Path(base).expanduser() if base else (Path.home() / ".watchtower")
    return root / ".dev"


def _state_file(tool: str) -> Path:
    return _state_dir() / f"tool-install-{tool}.state"


def _which(binary: str) -> Optional[str]:
    return shutil.which(binary)


def _linux_pkg_argv(tool: str) -> Optional[List[str]]:
    """apt or dnf argv for *tool*, run non-interactively under `sudo -n`.

    `sudo -n` never prompts: if passwordless sudo isn't set up it exits
    immediately with an error we surface, instead of hanging the job on a
    password prompt the user can't answer through the UI.
    """
    pkg = {"podman": "podman", "nginx": "nginx", "cloudflared": "cloudflared",
           "tailscale": "tailscale"}.get(tool)
    if not pkg:
        return None
    sudo = _which("sudo")
    if not sudo:
        return None
    if _which("apt-get"):
        return [sudo, "-n", "apt-get", "install", "-y", pkg]
    if _which("dnf"):
        return [sudo, "-n", "dnf", "install", "-y", pkg]
    return None


def _install_argv(tool: str) -> Optional[List[str]]:
    """Resolve the package-manager argv to install *tool* on this host, or None
    if there's no unattended path (UI then shows the copy-paste recipe)."""
    plat = _platform()
    if plat == "mac":
        brew = _which("brew")
        if not brew:
            return None
        # cloudflared & tailscale are casks on some taps but the formula works
        # for cloudflared; tailscale is a cask. Keep it simple + correct:
        if tool == "tailscale":
            return [brew, "install", "--cask", "tailscale"]
        return [brew, "install", tool]
    if plat == "windows":
        winget = _which("winget")
        if not winget:
            return None
        ids = {
            "podman": "RedHat.Podman",
            "cloudflared": "Cloudflare.cloudflared",
            "tailscale": "tailscale.tailscale",
        }
        wid = ids.get(tool)
        if not wid:  # nginx has no clean winget path
            return None
        return [winget, "install", "--silent", "--accept-package-agreements",
                "--accept-source-agreements", "--id", wid]
    return _linux_pkg_argv(tool)


def can_install(tool: str) -> tuple[bool, Optional[str]]:
    """Whether one-click install is available for *tool* on this host."""
    if tool not in INSTALLABLE_TOOLS:
        return False, f"'{tool}' is not in the one-click install list."
    if _install_argv(tool) is None:
        plat = _platform()
        mgr = {"mac": "Homebrew", "windows": "winget"}.get(plat, "apt/dnf with passwordless sudo")
        return False, f"No unattended installer found on this host ({mgr})."
    return True, None


def read_state(tool: str) -> Dict[str, Any]:
    try:
        raw = _state_file(tool).read_text(encoding="utf-8").strip()
        if raw:
            return json.loads(raw)
    except (FileNotFoundError, ValueError, OSError):
        pass
    return {"state": "idle"}


def _write_state(tool: str, payload: Dict[str, Any]) -> None:
    sd = _state_dir()
    sd.mkdir(parents=True, exist_ok=True)
    _state_file(tool).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def start_install(tool: str) -> Dict[str, Any]:
    """Kick off a background install for *tool*. Returns the initial state.

    Raises ValueError if the tool can't be auto-installed or a run is already
    in flight (caller maps these to 4xx).
    """
    ok, reason = can_install(tool)
    if not ok:
        raise ValueError(reason or "Cannot auto-install this tool.")

    current = read_state(tool)
    if current.get("state") == "running":
        raise ValueError("An install for this tool is already in progress.")

    argv = _install_argv(tool)
    assert argv is not None  # guarded by can_install above

    started = datetime.now(timezone.utc).isoformat()
    _write_state(tool, {"state": "running", "tool": tool, "started_at": started})

    # Run a tiny wrapper that executes the install argv, captures output, and
    # writes the terminal state file when done — so the API can poll progress
    # and the result survives even though the job is detached.
    _spawn(tool, argv, started)
    return read_state(tool)


def _spawn(tool: str, argv: List[str], started_at: str) -> None:
    """Detach a worker that runs *argv* and records the outcome. We use a
    Python wrapper (not a shell) so argv is passed verbatim — no quoting, no
    injection — and the state write can't be skipped by a shell error."""
    state_path = str(_state_file(tool))
    log_path = str(_state_dir() / f"tool-install-{tool}.log")
    wrapper = (
        "import json,subprocess,sys,datetime\n"
        f"argv={argv!r}\n"
        f"state={state_path!r}\n"
        f"logp={log_path!r}\n"
        f"started={started_at!r}\n"
        f"tool={tool!r}\n"
        "rc=1\nout=''\n"
        "try:\n"
        "    p=subprocess.run(argv,capture_output=True,text=True,timeout=900)\n"
        "    rc=p.returncode\n"
        "    out=(p.stdout or '')+(p.stderr or '')\n"
        "except Exception as e:\n"
        "    out=str(e)\n"
        "open(logp,'w').write(out)\n"
        "json.dump({'state':'succeeded' if rc==0 else 'failed','tool':tool,"
        "'exit_code':rc,'started_at':started,"
        "'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),"
        "'log_tail':out[-2000:]},open(state,'w'),separators=(',',':'))\n"
    )
    creationflags = 0
    if sys.platform.startswith("win"):
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    kwargs: Dict[str, Any] = {}
    if not sys.platform.startswith("win"):
        kwargs["start_new_session"] = True  # detach from API's process group
    subprocess.Popen(  # noqa: S603 - argv is a fixed allowlist, no user input
        [sys.executable, "-c", wrapper],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        **kwargs,
    )
