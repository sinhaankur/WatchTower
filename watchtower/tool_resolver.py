"""Single source of truth for locating CLI tools on the host.

Several features shell out to system binaries — Tailscale (remote access),
Podman/Docker (containers, managed DBs), cloudflared (tunnels), nginx, etc.
The catch: ``shutil.which`` only sees what's on PATH, and the most common
desktop installs ship the CLI *inside* a GUI app bundle that isn't
symlinked onto PATH. The classic case is the macOS Tailscale app, whose
binary lives at ``/Applications/Tailscale.app/Contents/MacOS/Tailscale`` —
``which("tailscale")`` returns None even though it's installed and working.

This module unifies what used to be two divergent copies of this logic
(``runtime._resolve_tool_path`` and ``remote_access.tailscale_binary``).
They drifted: one had the macOS GUI fallback, the other didn't, so the same
install read as "installed" on one page and "missing" on another. Routing
every caller through here means a fix lands everywhere at once and a new
surface can't reintroduce the bug.

Resolution order for every tool: PATH first (the fast, normal case), then a
curated list of known GUI-installer / package-manager locations. The return
value is always an absolute path suitable to pass straight to
``subprocess.run`` — never a bare relative name.
"""
from __future__ import annotations

import os
import shutil
from typing import Optional

# Known absolute locations for each tool when it's installed but not on
# PATH — GUI app bundles and package-manager dirs that sub-shells (and the
# API process) don't always inherit. Order = probe priority.
#
# Keep these unioned and deduped: this table is the merge of the two former
# per-module lists. When you teach the app about a new tool, add it here,
# not in a caller.
_FALLBACK_TOOL_PATHS: dict[str, tuple[str, ...]] = {
    "tailscale": (
        # macOS GUI app bundles the CLI but doesn't symlink it — the #1
        # silent "not installed" footgun. Try both casings of the binary.
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        r"C:\Program Files\Tailscale\tailscale.exe",
        r"C:\Program Files (x86)\Tailscale\tailscale.exe",
    ),
    "docker": (
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ),
    "podman": (
        "/usr/local/bin/podman",
        "/opt/homebrew/bin/podman",
        "/usr/bin/podman",
    ),
    "cloudflared": (
        "/usr/local/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
    ),
}


def resolve_tool(command: str) -> Optional[str]:
    """Return an absolute path to ``command`` or None if not installed.

    Tries PATH first, then the curated GUI/package-manager fallback list
    for that command. The result is always absolute and executable, so it
    can go straight into an argv list for ``subprocess.run``.
    """
    found = shutil.which(command)
    if found:
        return found
    for candidate in _FALLBACK_TOOL_PATHS.get(command, ()):  # () = unknown tool
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def tailscale_binary() -> Optional[str]:
    """Convenience wrapper — resolve the Tailscale CLI.

    Kept as a named helper because Tailscale's GUI-bundle case is the one
    callers most often need and the one that bit us before.
    """
    return resolve_tool("tailscale")
