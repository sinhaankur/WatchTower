#!/usr/bin/env bash
# Pre-release verification — runs locally before tagging.
#
# Implements the local portion of RELEASE_QUALITY.md (items 1, 2, 6 there).
# Each check has a clear pass/fail print so a failure is unambiguous.
# Exits non-zero on any failure so it's safe to use as a `&&` chain
# before `git tag`.
#
# Usage:  ./scripts/preflight.sh
#
# Skip individual checks via env vars (escape hatch when iterating):
#   SKIP_TESTS=1, SKIP_LINT=1, SKIP_BUILD=1, SKIP_PACK=1
# Setting any of these means the release does NOT meet the Stable bar.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Pretty-print helpers — short names so the script reads top-to-bottom.
PASS() { printf '\033[32m✓\033[0m %s\n' "$*"; }
FAIL() { printf '\033[31m✗ %s\033[0m\n' "$*"; FAILURES=$((FAILURES+1)); }
WARN() { printf '\033[33m! %s\033[0m\n' "$*"; }
HEAD() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

FAILURES=0
START=$(date +%s)

VENV_PY="$REPO_ROOT/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  FAIL ".venv/bin/python missing — run ./run.sh once to bootstrap the venv"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "1. Code health"

# Working tree should be clean apart from version-bump files. We allow these
# specific files to be dirty since they're literally what gets edited
# during a release:
ALLOWED_DIRTY="watchtower/__init__.py|package.json|desktop/package.json|vscode-extension/package.json|docs/index.html|CHANGELOG.md"
DIRTY=$(git status --porcelain | awk '{print $2}' | grep -vE "^($ALLOWED_DIRTY)$" || true)
if [ -z "$DIRTY" ]; then
  PASS "Working tree clean (only version-bump files modified, if any)"
else
  FAIL "Uncommitted changes outside version-bump files:"
  echo "$DIRTY" | sed 's/^/    /'
fi

# Verify __version__ matches the latest tag direction. We only warn if
# they diverge — this script runs before tag creation so a mismatch is
# expected for an in-progress release. Useful sanity check though.
PKG_VERSION=$("$VENV_PY" -c "from watchtower import __version__; print(__version__)" 2>/dev/null)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
if [ "$PKG_VERSION" = "$LAST_TAG" ]; then
  WARN "watchtower/__version__ ($PKG_VERSION) matches last tag — bump it before tagging"
else
  PASS "watchtower/__version__ = $PKG_VERSION (last tag was v$LAST_TAG)"
fi

# CHANGELOG must mention the current version (so we don't ship a release
# with no notes in the curated history).
if grep -q "^## $PKG_VERSION " CHANGELOG.md; then
  PASS "CHANGELOG.md has an entry for $PKG_VERSION"
else
  FAIL "CHANGELOG.md missing entry for $PKG_VERSION"
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "2. Test + lint + build"

if [ -n "${SKIP_TESTS:-}" ]; then
  WARN "SKIP_TESTS set — pytest skipped (NOT a stable release)"
else
  if "$VENV_PY" -m pytest tests/ -q --tb=no >/dev/null 2>&1; then
    PASS "pytest tests/ — all pass"
  else
    FAIL "pytest tests/ — failures (run pytest tests/ for details)"
  fi
fi

if [ -n "${SKIP_LINT:-}" ]; then
  WARN "SKIP_LINT set — frontend lint skipped (NOT a stable release)"
else
  if (cd "$REPO_ROOT" && npm --prefix web run lint --silent) >/dev/null 2>&1; then
    PASS "Frontend lint — clean"
  else
    FAIL "Frontend lint — warnings/errors (run 'npm --prefix web run lint')"
  fi
fi

if [ -n "${SKIP_BUILD:-}" ]; then
  WARN "SKIP_BUILD set — frontend build skipped (NOT a stable release)"
else
  if (cd "$REPO_ROOT" && npm --prefix web run build --silent) >/dev/null 2>&1; then
    PASS "Frontend build — succeeds (typecheck + bundle)"
  else
    FAIL "Frontend build — failed (run 'npm --prefix web run build')"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "3. Desktop pack (Mac arm64 — most common install target)"

if [ -n "${SKIP_PACK:-}" ]; then
  WARN "SKIP_PACK set — desktop pack skipped (NOT a stable release)"
elif [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  WARN "Not on Darwin-arm64 — skipping local pack (CI will catch other-arch issues)"
else
  rm -rf "$REPO_ROOT/desktop/dist"
  PACK_LOG=$(mktemp)
  if (cd "$REPO_ROOT/desktop" && npm run pack -- --mac --arm64) >"$PACK_LOG" 2>&1; then
    PASS "electron-builder pack succeeded"
  else
    FAIL "electron-builder pack failed — see $PACK_LOG"
    cat "$PACK_LOG" | tail -20
    rm -f "$PACK_LOG"
    echo
    echo "Aborting: can't run downstream checks without a packed app."
    exit 1
  fi
  rm -f "$PACK_LOG"

  # Verify only ONE arch was packed (regression guard for the 1.12.0 bug
  # where package.json's arch list caused both arches to build per matrix
  # entry, with cross-arch overwrite).
  PACKED_DIRS=$(ls "$REPO_ROOT/desktop/dist" | grep -E "^mac-(arm64|x64)$" || true)
  if [ "$(echo "$PACKED_DIRS" | wc -l | tr -d ' ')" = "1" ] && [ "$PACKED_DIRS" = "mac-arm64" ]; then
    PASS "Only mac-arm64 produced — no cross-arch overwrite hazard"
  else
    FAIL "Expected only mac-arm64 dir, got: $PACKED_DIRS"
    FAIL "  Indicates package.json mac.target.arch is back — fix before shipping"
  fi

  # Verify the bundled Python actually imports the critical deps. This
  # is the check that would have caught 1.12.0's pydantic_core bug.
  APP_PY="$REPO_ROOT/desktop/dist/mac-arm64/WatchTower.app/Contents/Resources/python/bin/python3"
  if [ -x "$APP_PY" ]; then
    PASS "Bundled Python binary exists at $APP_PY"
    # Run from a neutral cwd so Python doesn't shadow the bundled
    # watchtower with the source-tree one.
    if (cd /tmp && "$APP_PY" -c "import watchtower, pydantic_core, cryptography, alembic; print('import-check-OK')" 2>&1 | grep -q import-check-OK); then
      PASS "Bundled Python imports watchtower + pydantic_core + cryptography + alembic"
    else
      FAIL "Bundled Python missing critical deps (would crash on first launch)"
      (cd /tmp && "$APP_PY" -c "import watchtower, pydantic_core, cryptography, alembic" 2>&1 | head -10)
    fi
    # Verify alembic migrations are bundled (caught the 1.11.0 fresh-DB bug).
    APP_ALEMBIC_ENV=$(find "$REPO_ROOT/desktop/dist/mac-arm64/WatchTower.app/Contents/Resources/python/lib" -path '*/site-packages/watchtower/alembic/env.py' 2>/dev/null | head -1)
    if [ -n "$APP_ALEMBIC_ENV" ]; then
      PASS "Bundled site-packages/watchtower/alembic/env.py present (fresh-DB migration works)"
    else
      FAIL "Bundled watchtower package is missing alembic/env.py — fresh DB installs will crash"
    fi
  else
    FAIL "Bundled Python binary missing at $APP_PY"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "4. Forbidden user-facing strings"
# RELEASE_QUALITY.md specifies plain English in user-facing dialogs. These
# strings would mean a developer-jargon error message slipped into the
# Electron failure paths.
FORBIDDEN_STRINGS=("ImportError" "ModuleNotFoundError" "Traceback" "PEP 668")
DIALOG_FILES=("desktop/main.js")
ANY_FORBIDDEN=0
for f in "${DIALOG_FILES[@]}"; do
  for s in "${FORBIDDEN_STRINGS[@]}"; do
    # Allow them in code that DETECTS those strings (not surfaces them).
    # The detect-then-suppress pattern uses .includes(); we flag only
    # occurrences inside dialog message/detail/title strings.
    if grep -nE "(message|detail|title)\s*:\s*['\"\`].*${s}" "$REPO_ROOT/$f" 2>/dev/null; then
      FAIL "Forbidden string '$s' appears in user-facing dialog field of $f (line above)"
      ANY_FORBIDDEN=1
    fi
  done
done
if [ "$ANY_FORBIDDEN" = "0" ]; then
  PASS "No developer-jargon strings (Traceback / ImportError / etc.) in user dialogs"
fi

# ──────────────────────────────────────────────────────────────────────────
DURATION=$(($(date +%s) - START))
HEAD "Result"

if [ "$FAILURES" = "0" ]; then
  printf '\033[32m✅  PREFLIGHT PASSED  (%ss)\033[0m  — release meets the Stable bar.\n' "$DURATION"
  echo
  echo "Next: bump version (already done), commit, tag, push:"
  echo "    git tag v$PKG_VERSION && git push origin main && git push origin v$PKG_VERSION"
  exit 0
else
  printf '\033[31m❌  PREFLIGHT FAILED  (%ss, %s issue(s))\033[0m\n' "$DURATION" "$FAILURES"
  echo
  echo "Fix the failures above, or ship as Beta if you must release now."
  exit 1
fi
