#!/usr/bin/env bash
# Build a self-contained Python venv with WatchTower + dependencies
# pre-installed. Output: desktop/python-bundle/python/  (default).
#
# Lets the desktop .app ship Python inside its bundle so end users don't
# need pipx + watchtower-podman installed separately. The Python
# distribution comes from astral-sh/python-build-standalone — purpose-built
# for embedding, fully relocatable, no system deps.
#
# Used by .github/workflows/release.yml before electron-builder runs.
# Also runnable locally for testing: ./scripts/build-python-bundle.sh
#
# Env vars:
#   PYTHON_BUILD_STANDALONE_TAG  pinned release tag (default below)
#   PYTHON_VERSION               Python version (default below)
#   TARGET                       darwin-arm64 | darwin-x64 | linux-x64 |
#                                linux-arm64 | windows-x64
#                                Auto-detected from uname when not set.
#   OUT_DIR                      output directory (default desktop/python-bundle)

set -euo pipefail

PYTHON_BUILD_STANDALONE_TAG="${PYTHON_BUILD_STANDALONE_TAG:-20260414}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12.13}"
TARGET="${TARGET:-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/desktop/python-bundle}"

if [ -z "$TARGET" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  TARGET="darwin-arm64" ;;
    Darwin-x86_64) TARGET="darwin-x64" ;;
    Linux-x86_64)  TARGET="linux-x64" ;;
    Linux-aarch64) TARGET="linux-arm64" ;;
    *)
      echo "ERROR: cannot auto-detect TARGET. uname: $(uname -a)" >&2
      echo "Set TARGET explicitly: darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64" >&2
      exit 1
      ;;
  esac
fi

case "$TARGET" in
  darwin-arm64)  TRIPLE="aarch64-apple-darwin" ;;
  darwin-x64)    TRIPLE="x86_64-apple-darwin" ;;
  linux-x64)     TRIPLE="x86_64-unknown-linux-gnu" ;;
  linux-arm64)   TRIPLE="aarch64-unknown-linux-gnu" ;;
  windows-x64)   TRIPLE="x86_64-pc-windows-msvc" ;;
  *)
    echo "ERROR: unknown TARGET $TARGET" >&2
    exit 1
    ;;
esac

URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_STANDALONE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${TRIPLE}-install_only.tar.gz"

echo "==> Building Python bundle for $TARGET"
echo "    Python:  $PYTHON_VERSION (build $PYTHON_BUILD_STANDALONE_TAG)"
echo "    Triple:  $TRIPLE"
echo "    Output:  $OUT_DIR"

# Cache the tarball — re-running locally during dev shouldn't re-download
# 25 MB every time.
CACHE_DIR="${HOME}/.cache/watchtower-python-bundle"
mkdir -p "$CACHE_DIR"
ARCHIVE="$CACHE_DIR/cpython-${PYTHON_VERSION}+${PYTHON_BUILD_STANDALONE_TAG}-${TARGET}.tar.gz"

if [ ! -f "$ARCHIVE" ]; then
  echo "==> Downloading $URL"
  curl -L --fail --retry 3 --retry-delay 5 -o "$ARCHIVE.tmp" "$URL"
  mv "$ARCHIVE.tmp" "$ARCHIVE"
else
  echo "==> Using cached archive ($ARCHIVE)"
fi

# Wipe old bundle and re-extract — guarantees a clean state.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
echo "==> Extracting Python distribution"
tar -xzf "$ARCHIVE" -C "$OUT_DIR"
# Archive contains a top-level `python/` directory.

if [ "$TARGET" = "windows-x64" ]; then
  PYTHON_BIN="$OUT_DIR/python/python.exe"
else
  PYTHON_BIN="$OUT_DIR/python/bin/python3"
fi

if [ ! -x "$PYTHON_BIN" ]; then
  echo "ERROR: Python binary not found at $PYTHON_BIN after extract" >&2
  ls -la "$OUT_DIR/python/" >&2
  exit 1
fi

echo "==> Installing WatchTower + dependencies into bundled Python"

# Detect host arch FIRST so we know whether the bundled Python can even
# execute — calling `python -m pip --version` on a cross-arch binary
# fails with "cannot execute binary file: Exec format error" before we
# reach the cross-install branch below.
#
# Windows host (Git Bash) is special-cased: its uname returns
# MINGW64_NT-* so it doesn't match any case below, and we deliberately
# DON'T set HOST_TARGET=windows-x64 even though the runner is x86_64
# Windows. Reason: native install on Windows hangs forever at
# `python.exe -m pip install --upgrade pip` because Windows file
# locking prevents pip from replacing its own pip.exe while running.
# This caused the v1.12.1 windows-x64 job to hang for 80+ minutes
# before being cancelled. Forcing the cross-install path uses the
# host's setup-python `python3` to download win_amd64 wheels via
# `--target` — no in-bundle pip self-upgrade happens, no lock.
HOST_TARGET=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  HOST_TARGET="darwin-arm64" ;;
  Darwin-x86_64) HOST_TARGET="darwin-x64" ;;
  Linux-x86_64)  HOST_TARGET="linux-x64" ;;
  Linux-aarch64) HOST_TARGET="linux-arm64" ;;
  # MINGW*/MSYS*/CYGWIN* deliberately omitted — see comment above.
esac

if [ "$TARGET" = "$HOST_TARGET" ] && [ -n "$HOST_TARGET" ]; then
  echo "    bundled pip --version:"
  "$PYTHON_BIN" -m pip --version
fi

# Cross-arch install support: when the host CPU doesn't match TARGET (e.g.
# building a Mac x64 bundle on an Apple Silicon runner), we can't run the
# bundled Python natively. Instead, install dependencies via the host's
# Python with --target + --platform + --only-binary so pip downloads the
# right-arch wheels without executing them. The watchtower module itself
# is pure Python so it installs cleanly either way.
#
# windows-x64 always takes this path (HOST_TARGET is empty on Windows
# Git Bash by design — see comment above) regardless of which runner OS
# is doing the build. This avoids the Windows pip-self-replace deadlock.
USE_CROSS_INSTALL=false
if [ "$TARGET" = "windows-x64" ]; then
  USE_CROSS_INSTALL=true
elif [ "$TARGET" != "$HOST_TARGET" ] && [ -n "$HOST_TARGET" ]; then
  USE_CROSS_INSTALL=true
fi

if [ "$USE_CROSS_INSTALL" = "true" ]; then
  echo "==> Cross-install: building for $TARGET on $HOST_TARGET host"
  case "$TARGET" in
    darwin-arm64) PIP_PLATFORM="macosx_11_0_arm64" ;;
    darwin-x64)   PIP_PLATFORM="macosx_11_0_x86_64" ;;
    linux-x64)    PIP_PLATFORM="manylinux_2_17_x86_64 manylinux2014_x86_64" ;;
    linux-arm64)  PIP_PLATFORM="manylinux_2_17_aarch64 manylinux2014_aarch64" ;;
    windows-x64)  PIP_PLATFORM="win_amd64" ;;
    *) echo "ERROR: cross-install not supported for $TARGET" >&2; exit 1 ;;
  esac
  # Pick the matching site-packages dir inside the bundle to install into.
  if [ "$TARGET" = "windows-x64" ]; then
    SITE_PACKAGES="$OUT_DIR/python/Lib/site-packages"
  else
    PYV="${PYTHON_VERSION%.*}"  # e.g. 3.12.13 → 3.12
    SITE_PACKAGES="$OUT_DIR/python/lib/python${PYV}/site-packages"
  fi
  mkdir -p "$SITE_PACKAGES"
  PLATFORM_ARGS=""
  for p in $PIP_PLATFORM; do
    PLATFORM_ARGS="$PLATFORM_ARGS --platform $p"
  done
  python3 -m pip install --no-cache-dir --target "$SITE_PACKAGES" \
    $PLATFORM_ARGS --only-binary=:all: --upgrade \
    -r "$REPO_ROOT/requirements.txt"
  # Install watchtower itself (pure Python → no platform constraint needed).
  python3 -m pip install --no-cache-dir --target "$SITE_PACKAGES" \
    --no-deps --upgrade "$REPO_ROOT"
else
  echo "==> Native install: $TARGET matches host"
  "$PYTHON_BIN" -m pip install --no-cache-dir --upgrade pip
  "$PYTHON_BIN" -m pip install --no-cache-dir -r "$REPO_ROOT/requirements.txt"
  "$PYTHON_BIN" -m pip install --no-cache-dir --no-deps "$REPO_ROOT"
fi

echo "==> Copying alembic migrations into bundled watchtower package"
# The watchtower package needs the alembic/ directory at runtime to
# upgrade fresh databases. pyproject.toml's `include = ["watchtower*"]`
# only picks up the watchtower module itself; alembic/ lives at repo
# root and is missed by every install path that goes through pip.
# Copy it INSIDE the installed watchtower module so _alembic_config()
# finds it via Path(__file__).parent / 'alembic'. This is the path the
# new fallback in database.py looks at first.
if [ "$TARGET" = "windows-x64" ]; then
  WT_PKG_DIR="$OUT_DIR/python/Lib/site-packages/watchtower"
else
  PYV="${PYTHON_VERSION%.*}"
  WT_PKG_DIR="$OUT_DIR/python/lib/python${PYV}/site-packages/watchtower"
fi
if [ ! -d "$WT_PKG_DIR" ]; then
  echo "ERROR: watchtower package not found at $WT_PKG_DIR — install above must have failed silently" >&2
  exit 1
fi
rm -rf "$WT_PKG_DIR/alembic"
cp -R "$REPO_ROOT/alembic" "$WT_PKG_DIR/alembic"
echo "    Copied alembic/ ($(du -sh "$WT_PKG_DIR/alembic" | awk '{print $1}'))"

if [ "$USE_CROSS_INSTALL" = "false" ]; then
  echo "==> Verifying watchtower importable + alembic discoverable from bundled Python"
  # Run from a neutral cwd so Python doesn't shadow the bundled
  # watchtower with the source-tree one (sys.path puts cwd first).
  # `cd /tmp` is cross-platform enough for Mac/Linux (Windows uses a
  # different temp path but this verify-step only runs on native-arch
  # builds; Windows always cross-installs and skips this).
  (cd /tmp && "$PYTHON_BIN" -c "
import watchtower, sys
from pathlib import Path
pkg = Path(watchtower.__file__).parent
env_py = pkg / 'alembic' / 'env.py'
assert env_py.is_file(), f'alembic/env.py missing in bundle at {env_py}'
print(f'watchtower {watchtower.__version__} OK on Python {sys.version.split()[0]} (alembic env.py at {env_py})')
")
else
  echo "==> Skipping import verification (cross-install build — bundled Python can't run on host)"
fi

# Shrink the bundle: drop bytecode caches (pip just regenerates these on
# first import in the user environment if needed).
echo "==> Stripping __pycache__ directories"
find "$OUT_DIR/python" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true

# Drop pip itself — the user can't pip install into the bundle anyway
# (no write perms on the .app bundle), and shipping it adds ~10 MB.
# Cross-install case: skip (pip never ran in the bundle Python; nothing
# to uninstall).
if [ "$USE_CROSS_INSTALL" = "false" ]; then
  echo "==> Removing pip + setuptools (unused at runtime)"
  "$PYTHON_BIN" -m pip uninstall -y pip setuptools wheel 2>/dev/null || true
fi

SIZE_MB=$(du -sm "$OUT_DIR/python" | awk '{print $1}')
echo ""
echo "✅ Bundle ready at $OUT_DIR/python/  (${SIZE_MB} MB)"
echo "   Python binary: $PYTHON_BIN"
