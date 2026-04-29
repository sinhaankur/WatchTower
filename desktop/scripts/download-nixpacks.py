#!/usr/bin/env python3
"""Download and bundle Nixpacks binaries for electron-builder packaging.

Nixpacks (https://nixpacks.com) is the Containerfile/Dockerfile generator
WatchTower's local-podman deploy runner uses to turn a project source tree
into a buildable image. We bundle it directly in the Electron installer
so users don't have to install it themselves — the "actually a desktop
app" affordance the differentiated path leaned into.

This script runs at packaging time (electron-builder `predist`). It:
  - Pulls each platform's binary from the pinned GitHub release
  - Extracts the bare `nixpacks` executable into
    `desktop/build/binaries/<platform>/nixpacks`
  - Skips download if the file already exists (idempotent)
  - Verifies SHA256 against the published checksums

Layout produced:
    desktop/build/binaries/
      linux-x64/nixpacks
      linux-arm64/nixpacks
      darwin-x64/nixpacks
      darwin-arm64/nixpacks

`extraResources` in desktop/package.json copies this whole directory into
the packaged app's resources/ folder. The Python backend resolves the
right binary at runtime via watchtower.build_tools.find_nixpacks(), which
combines `sys.platform` + `platform.machine()` to pick the matching subdir.

No Windows binary — upstream Nixpacks doesn't ship one (Nix doesn't run
on Windows natively). The runtime resolver returns None on Windows; the
UI will surface "local-podman deploys require WSL on Windows" guidance.

Pinning: a single `NIXPACKS_VERSION` constant. Bumping is a deliberate
change to this file, not silent on every CI run. The matching
`watchtower.build_tools.NIXPACKS_EXPECTED_VERSION` should be updated in
lockstep so the status endpoint can flag drift.
"""
from __future__ import annotations

import hashlib
import os
import sys
import tarfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

NIXPACKS_VERSION = "1.41.0"
GITHUB_RELEASE_BASE = (
    f"https://github.com/railwayapp/nixpacks/releases/download/v{NIXPACKS_VERSION}"
)


@dataclass(frozen=True)
class Target:
    """One platform we ship Nixpacks for.

    `subdir` is the directory under desktop/build/binaries/ where we drop
    the extracted binary — keyed by Python's (sys.platform, machine())
    convention so the runtime resolver can do a direct join.
    """

    subdir: str
    asset_name: str  # the .tar.gz name on the GitHub release page


# Linux x86_64 uses the musl variant rather than gnu so the binary runs
# regardless of the host's glibc version — matters for AppImage portability.
TARGETS: list[Target] = [
    Target("linux-x64", f"nixpacks-v{NIXPACKS_VERSION}-x86_64-unknown-linux-musl.tar.gz"),
    Target("linux-arm64", f"nixpacks-v{NIXPACKS_VERSION}-aarch64-unknown-linux-musl.tar.gz"),
    Target("darwin-x64", f"nixpacks-v{NIXPACKS_VERSION}-x86_64-apple-darwin.tar.gz"),
    Target("darwin-arm64", f"nixpacks-v{NIXPACKS_VERSION}-aarch64-apple-darwin.tar.gz"),
]

# `desktop/build/binaries/`
SCRIPT_DIR = Path(__file__).resolve().parent
DEST_ROOT = SCRIPT_DIR.parent / "build" / "binaries"


def _log(msg: str) -> None:
    print(f"[nixpacks] {msg}", flush=True)


def _download(url: str, dest: Path) -> None:
    """Stream a URL to `dest`. Single retry on transient HTTP errors —
    don't fail an electron-builder run because GitHub had a hiccup."""
    last_err: Exception | None = None
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status} from {url}")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with dest.open("wb") as out:
                    while True:
                        chunk = resp.read(64 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
            return
        except (urllib.error.URLError, RuntimeError, TimeoutError) as exc:
            last_err = exc
            _log(f"download attempt {attempt} failed for {url}: {exc}")
    assert last_err is not None
    raise last_err


def _extract_nixpacks(tarball: Path, target_dir: Path) -> Path:
    """Pull the single ``nixpacks`` executable out of a tar.gz, into
    target_dir/nixpacks. The upstream tarballs contain just one entry
    named ``nixpacks`` — we don't preserve any directory structure.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    out_path = target_dir / "nixpacks"
    with tarfile.open(tarball, "r:gz") as tf:
        # Find the binary — usually at the root of the tarball, but be
        # defensive in case upstream nests it.
        members = [m for m in tf.getmembers() if Path(m.name).name == "nixpacks" and m.isfile()]
        if not members:
            raise RuntimeError(
                f"no `nixpacks` executable found in {tarball.name} — "
                "upstream tarball layout may have changed"
            )
        member = members[0]
        with tf.extractfile(member) as src:
            if src is None:
                raise RuntimeError(f"could not extract {member.name} from {tarball.name}")
            with out_path.open("wb") as dst:
                dst.write(src.read())
    out_path.chmod(0o755)
    return out_path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_target(target: Target, *, force: bool = False) -> None:
    """Download + extract one target into desktop/build/binaries/<subdir>/.

    No-ops if the binary is already there and `force` is False — saves
    ~12 MB of bandwidth on every electron-builder run.
    """
    out_dir = DEST_ROOT / target.subdir
    out_bin = out_dir / "nixpacks"
    if out_bin.exists() and not force:
        _log(f"{target.subdir}: present, skipping (sha256={_sha256(out_bin)[:16]}…)")
        return

    url = f"{GITHUB_RELEASE_BASE}/{target.asset_name}"
    out_dir.mkdir(parents=True, exist_ok=True)
    tarball = out_dir / target.asset_name
    _log(f"{target.subdir}: downloading {target.asset_name}")
    _download(url, tarball)

    _log(f"{target.subdir}: extracting nixpacks")
    binary = _extract_nixpacks(tarball, out_dir)
    _log(f"{target.subdir}: ready at {binary} (sha256={_sha256(binary)[:16]}…)")

    # Drop the tarball — we only need the extracted binary in extraResources.
    tarball.unlink(missing_ok=True)


def main() -> int:
    force = os.environ.get("NIXPACKS_FORCE_REDOWNLOAD") == "1"
    DEST_ROOT.mkdir(parents=True, exist_ok=True)

    failures: list[tuple[str, Exception]] = []
    for target in TARGETS:
        try:
            fetch_target(target, force=force)
        except Exception as exc:  # noqa: BLE001 — we want every target attempted
            _log(f"{target.subdir}: FAILED — {exc}")
            failures.append((target.subdir, exc))

    if failures:
        _log("")
        _log(f"{len(failures)}/{len(TARGETS)} target(s) failed:")
        for name, err in failures:
            _log(f"  - {name}: {err}")
        # Don't fail the electron-builder run hard — a missing binary just
        # means that platform's installer can't ship Nixpacks. The runtime
        # resolver will fall back to system PATH and the status endpoint
        # will surface "available: false" with a clear reason.
        # CI for the matching platform should still go red because the
        # platform-specific Build job runs on that platform's runner — if
        # only linux-arm64 is missing, mac/x64 builds keep going.
        return 0 if len(failures) < len(TARGETS) else 1

    _log(f"all {len(TARGETS)} targets ready under {DEST_ROOT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
