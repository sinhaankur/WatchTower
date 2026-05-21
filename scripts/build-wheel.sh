#!/usr/bin/env bash
# Build the watchtower-podman PyPI wheel + sdist with the alembic migrations
# and the React SPA bundle correctly embedded inside the package.
#
# The repo layout has `alembic/` and `web/dist/` at the root (siblings of
# `watchtower/`). That's natural for the dev clone — `pip install -e .`
# makes the loader's `pkg_dir.parent / "alembic"` fallback resolve to the
# real dirs — but a regular `pip install watchtower-podman` from PyPI
# produces a wheel that contains neither, so the loader hits
# `RuntimeError: Could not find alembic/env.py` on first start.
#
# This script copies both dirs INTO the package as `watchtower/_alembic/`
# and `watchtower/_web_dist/` just before building, so they land in the
# wheel as package_data (declared in pyproject.toml). After the build,
# the staged dirs are removed so the dev tree stays clean.
#
# Underscore prefix is intentional: it keeps setuptools' package-finder
# (which matches `watchtower*` via `[tool.setuptools.packages.find]`)
# from treating these data dirs as importable Python subpackages, which
# would confuse the alembic CLI ("watchtower.alembic" vs the alembic
# package on PyPI).
#
# Usage:  ./scripts/build-wheel.sh
#         python -m pip install dist/watchtower_podman-*.whl
#
# CI: invoked from .github/workflows/publish-pypi.yml.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

STAGED_ALEMBIC="watchtower/_alembic"
STAGED_WEB="watchtower/_web_dist"

cleanup() {
  rm -rf "$STAGED_ALEMBIC" "$STAGED_WEB" 2>/dev/null || true
}
# Always clean up — even on script failure, even on Ctrl-C — so a half-
# baked staged copy doesn't get committed by mistake.
trap cleanup EXIT INT TERM

echo "── Staging package data ──"

# alembic/ → watchtower/_alembic/
if [ ! -d alembic ]; then
  echo "  ✗ alembic/ missing at repo root — cannot stage." >&2
  exit 1
fi
cp -R alembic "$STAGED_ALEMBIC"
echo "  ✓ Copied alembic/ → $STAGED_ALEMBIC ($(find "$STAGED_ALEMBIC" -type f | wc -l | tr -d ' ') files)"

# web/dist/ → watchtower/_web_dist/
# The dist dir might not exist if the operator hasn't built the SPA yet.
# Build it first so the wheel always ships a current bundle.
if [ ! -d web/dist ]; then
  echo "  · web/dist/ missing — building SPA first"
  npm --prefix web install --no-audit --no-fund --silent
  npm --prefix web run build
fi
cp -R web/dist "$STAGED_WEB"
echo "  ✓ Copied web/dist/ → $STAGED_WEB ($(find "$STAGED_WEB" -type f | wc -l | tr -d ' ') files)"

echo ""
echo "── Building wheel + sdist ──"

# macOS Homebrew Python ships with PEP 668's "externally-managed-environment"
# marker that blocks `python3 -m pip install ...` system-wide. Use the
# project's .venv when it exists (dev clone path); otherwise we're in CI
# (Ubuntu / setup-python action) where system pip works fine.
if [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  BUILD_PY="$REPO_ROOT/.venv/bin/python"
  echo "  Using project .venv: $BUILD_PY"
else
  BUILD_PY=python3
  echo "  Using system python: $BUILD_PY"
fi

"$BUILD_PY" -m pip install --quiet --upgrade pip build
rm -rf dist build
"$BUILD_PY" -m build

echo ""
echo "── Verifying wheel contents ──"
WHEEL=$(ls dist/watchtower_podman-*.whl 2>/dev/null | head -1)
if [ -z "$WHEEL" ]; then
  echo "  ✗ No wheel produced under dist/" >&2
  exit 1
fi
echo "  Wheel: $WHEEL"

# These two paths are the load-bearing ones — the wheel is useless
# without them. Any future packaging regression that drops them will
# fail this check before the artifact ever reaches PyPI.
#
# Cache `unzip -l` once instead of piping into `grep -q` each time:
# `grep -q` exits on first match, which sends SIGPIPE (141) to `unzip`,
# and with `set -o pipefail` the pipeline reports 141 — the regression
# guard reads as "missing" even when the file is actually there. Caching
# decouples the two and makes the result correct.
WHEEL_LIST=$(unzip -l "$WHEEL")

check_wheel_file() {
  local pattern="$1"
  local description="$2"
  if printf '%s\n' "$WHEEL_LIST" | grep -qE "$pattern"; then
    echo "  ✓ Wheel contains $description"
  else
    echo "  ✗ Wheel missing $description (pattern: $pattern)" >&2
    exit 1
  fi
}

check_wheel_file "watchtower/_alembic/env\.py" "_alembic/env.py"
check_wheel_file "watchtower/_web_dist/index\.html" "_web_dist/index.html"
check_wheel_file "watchtower/_alembic/versions/[a-f0-9]+_.*\.py" "alembic migrations"

# Count migrations so the operator sees the chain length — a sudden
# drop (e.g. from 25 to 3) is a more useful regression signal than a
# binary pass/fail.
MIG_COUNT=$(printf '%s\n' "$WHEEL_LIST" | grep -cE "watchtower/_alembic/versions/[a-f0-9]+_.*\.py" || true)
echo "  ✓ Migration count: $MIG_COUNT"

echo ""
echo "── Build complete ──"
ls -lh dist/
