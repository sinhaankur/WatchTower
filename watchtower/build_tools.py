"""Resolution and metadata for external build tools bundled with the app.

WatchTower ships Nixpacks (https://nixpacks.com) inside the Electron
installer via electron-builder's ``extraResources`` — so the user can
deploy a project locally without first installing Rust + Cargo + Nix.
The matching download script is ``desktop/scripts/download-nixpacks.py``.

This module is the runtime side of that arrangement: given the current
process's environment, return the path to a usable ``nixpacks`` binary
(or None) plus a description of where we found it. The status endpoint
(``GET /api/runtime/nixpacks-status``) wraps this for the SPA, and
PR-3's local-podman runner will consume ``find_nixpacks()`` directly.

Resolution order (first hit wins):

  1. ``WATCHTOWER_NIXPACKS_BIN`` env override — explicit user choice for
     testing or running against a development build.
  2. The bundled binary under ``WATCHTOWER_RESOURCES_DIR/binaries/<plat>/
     nixpacks`` — set by ``desktop/main.js`` to ``process.resourcesPath``
     when Electron spawns the backend, so packaged installers ship a
     known-good Nixpacks without the user installing anything.
  3. ``shutil.which("nixpacks")`` — system PATH. Catches dev clones
     (``./run.sh browser``) where the maintainer installed nixpacks for
     iteration, and any user who has installed it themselves.

Returns ``None`` only if all three fail. The status endpoint surfaces
that as an actionable banner ("install Nixpacks" with a link to docs)
so users on platforms we don't bundle (Windows — no upstream binary)
get a clear next step instead of a silent failure deep in the build.
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


# Bumped in lockstep with desktop/scripts/download-nixpacks.py's
# NIXPACKS_VERSION. The status endpoint flags drift so a stale resolved
# binary doesn't silently pretend to be the bundled one.
NIXPACKS_EXPECTED_VERSION = "1.41.0"


def _platform_subdir() -> Optional[str]:
    """Map (sys.platform, machine) to the subdir name the download script
    wrote into ``desktop/build/binaries/``. Returns None on unsupported
    platforms (notably Windows — Nixpacks doesn't ship Windows binaries).
    """
    machine = platform.machine().lower()
    if sys.platform.startswith("linux"):
        if machine in ("x86_64", "amd64"):
            return "linux-x64"
        if machine in ("aarch64", "arm64"):
            return "linux-arm64"
        return None
    if sys.platform == "darwin":
        if machine in ("x86_64", "amd64"):
            return "darwin-x64"
        if machine in ("arm64", "aarch64"):
            return "darwin-arm64"
        return None
    return None  # Windows, BSDs, etc. — no upstream binary


@dataclass(frozen=True)
class NixpacksResolution:
    """Resolved Nixpacks state. ``path`` is None when not found."""

    path: Optional[Path]
    source: str  # 'env' | 'bundled' | 'system' | 'missing'
    platform_supported: bool


def find_nixpacks() -> NixpacksResolution:
    """Resolve a usable nixpacks binary. See module docstring for order.

    Always returns a NixpacksResolution — caller can branch on
    ``resolution.path is None`` (or ``resolution.source == 'missing'``)
    to surface a UI banner rather than crashing later in a build.
    """
    # 1. explicit env override
    env_bin = os.environ.get("WATCHTOWER_NIXPACKS_BIN")
    if env_bin:
        p = Path(env_bin)
        if p.is_file() and os.access(p, os.X_OK):
            return NixpacksResolution(path=p, source="env", platform_supported=True)
        # Bad override is a misconfiguration, not a fallback signal —
        # caller should see something actionable. Still try other paths
        # so a typo'd env doesn't permanently break the app.

    # 2. bundled binary under resources/
    resources_dir = os.environ.get("WATCHTOWER_RESOURCES_DIR", "").strip()
    subdir = _platform_subdir()
    if resources_dir and subdir:
        candidate = Path(resources_dir) / "binaries" / subdir / "nixpacks"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return NixpacksResolution(path=candidate, source="bundled", platform_supported=True)

    # 3. system PATH
    on_path = shutil.which("nixpacks")
    if on_path:
        return NixpacksResolution(
            path=Path(on_path),
            source="system",
            platform_supported=subdir is not None,
        )

    return NixpacksResolution(
        path=None,
        source="missing",
        platform_supported=subdir is not None,
    )


def get_nixpacks_version(binary: Path, *, timeout: float = 5.0) -> Optional[str]:
    """Run ``<binary> --version`` and return the trimmed output. Returns
    None on any error so the status endpoint shows ``version: null``
    rather than crashing if the binary is corrupt or hangs.
    """
    try:
        result = subprocess.run(
            [str(binary), "--version"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            return None
        # Output format: "nixpacks 1.41.0" — strip the prefix to match
        # NIXPACKS_EXPECTED_VERSION's bare-version form.
        line = (result.stdout or "").strip().splitlines()[0] if result.stdout else ""
        for part in line.split():
            if part and part[0].isdigit():
                return part
        return line or None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None
