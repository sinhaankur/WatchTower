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
#   SKIP_TESTS=1, SKIP_LINT=1, SKIP_BUILD=1, SKIP_PACK=1, SKIP_WHEEL=1,
#   SKIP_PAYLOAD=1
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

# Dependency-vulnerability gate. The CI "Security Scan" workflow fails the
# build on any *fixable* HIGH/CRITICAL (Trivy, ignore-unfixed). Preflight
# used to not check this, so form-data CVE-2026-12143 passed preflight and
# only surfaced in CI after tagging. Mirror the CI posture here — a fixable
# HIGH/CRITICAL in the SHIPPED (production) frontend deps blocks the release
# before the tag. `--omit=dev` is deliberate: Trivy scans the deployed image,
# so a vuln in eslint/vitest/vite (build-only, never shipped) is not a CI
# gate and must not create a false preflight failure. `npm audit` needs no
# Docker/Trivy, so it runs on any dev box in seconds.
if [ -n "${SKIP_AUDIT:-}" ]; then
  WARN "SKIP_AUDIT set — dependency audit skipped (NOT a stable release)"
else
  AUDIT_JSON="$(cd "$REPO_ROOT" && npm --prefix web audit --omit=dev --audit-level=high --json 2>/dev/null || true)"
  # Count only vulnerabilities that have a fix available — matches Trivy's
  # ignore-unfixed, so an unfixable upstream advisory doesn't block a release
  # we can do nothing about. Falls back to 0 if jq/node parsing is unavailable.
  FIXABLE="$(printf '%s' "$AUDIT_JSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const a=JSON.parse(s).vulnerabilities||{};
        let n=0;for(const v of Object.values(a)){
          if((v.severity==="high"||v.severity==="critical")&&v.fixAvailable)n++;
        }process.stdout.write(String(n));
      }catch{process.stdout.write("0");}});' 2>/dev/null || echo 0)"
  if [ "${FIXABLE:-0}" -gt 0 ]; then
    FAIL "Frontend prod deps — $FIXABLE fixable HIGH/CRITICAL vuln(s) (run 'npm --prefix web audit --omit=dev --audit-level=high'); CI Security Scan will fail"
  else
    PASS "Frontend prod deps — no fixable HIGH/CRITICAL vulnerabilities"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "3. Desktop pack (Mac arm64 — most common install target)"

if [ -n "${SKIP_PACK:-}" ]; then
  WARN "SKIP_PACK set — desktop pack skipped (NOT a stable release)"
elif [ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]; then
  WARN "Not on Darwin-arm64 — skipping local pack (CI will catch other-arch issues)"
else
  # Stale-bundle guard. electron-builder packs whatever sits in
  # desktop/python-bundle — if that bundle is from an OLD build (stale
  # watchtower code + incomplete migrations), the DMG passes arch checks but
  # crashes users whose DB is past the bundle's last migration. This is the
  # 1.16.3 incident (a 1.14.4 bundle reused locally). Refuse to pack on a
  # stale/missing bundle; CI always rebuilds fresh, but local packs must too.
  BUNDLE_INIT=$(find "$REPO_ROOT/desktop/python-bundle" -path '*/site-packages/watchtower/__init__.py' 2>/dev/null | head -1)
  if [ -z "$BUNDLE_INIT" ]; then
    WARN "No desktop/python-bundle found — run scripts/build-python-bundle.sh before packing (CI builds it fresh; the local pack needs it too)"
  else
    BUNDLE_VER=$(grep -E '^__version__' "$BUNDLE_INIT" | sed -E 's/.*"([^"]+)".*/\1/')
    if [ "$BUNDLE_VER" = "$PKG_VERSION" ]; then
      PASS "Python bundle is fresh (watchtower $BUNDLE_VER matches repo)"
    else
      FAIL "Python bundle is STALE: bundles watchtower $BUNDLE_VER but repo is $PKG_VERSION"
      echo "    Rebuild it before packing:  ./scripts/build-python-bundle.sh"
      echo "    (A stale bundle ships old code + incomplete migrations → users crash on launch.)"
      echo
      echo "Aborting: refusing to pack a stale Python bundle."
      exit 1
    fi
  fi

  rm -rf "$REPO_ROOT/desktop/dist"
  PACK_LOG=$(mktemp)
  # Pack WITHOUT code signing. WatchTower ships unsigned (no Apple Developer
  # ID — see .claude/memory/code_signing_status.md), so the release pack and
  # CI both build unsigned. Without this, electron-builder tries an ad-hoc
  # local sign that fails on many dev machines (signApp → readDirectoryAndSign)
  # and false-fails preflight on something that never ships. The check we
  # actually care about — the bundled Python imports the critical deps — runs
  # below regardless of signing.
  if (cd "$REPO_ROOT/desktop" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack -- --mac --arm64) >"$PACK_LOG" 2>&1; then
    PASS "electron-builder pack succeeded (unsigned — matches release + CI)"
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
    # Actually LOAD the FastAPI ASGI app — importing `watchtower` alone does
    # NOT register routes, so a missing form-data dep (python-multipart) or any
    # other route-registration failure sails through the import check and only
    # crashes at real startup. This is exactly the 1.20.0 python-multipart bug:
    # photos.py's upload route calls ensure_multipart_is_installed() at import
    # time. Loading `watchtower.api:app` triggers full router registration.
    if (cd /tmp && WATCHTOWER_API_TOKEN=preflight-probe "$APP_PY" -c "from watchtower.api import app; assert app.routes; print('app-load-OK')" 2>&1 | grep -q app-load-OK); then
      PASS "Bundled Python loads the FastAPI app (all routes register — catches missing form/runtime deps)"
    else
      FAIL "Bundled Python cannot load watchtower.api:app — the packaged backend WILL crash at startup"
      (cd /tmp && WATCHTOWER_API_TOKEN=preflight-probe "$APP_PY" -c "from watchtower.api import app" 2>&1 | tail -12)
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
HEAD "4. PyPI wheel ships migrations + SPA bundle"
# 1.16.0 shipped a wheel that contained neither alembic/ nor web/dist/,
# so every `pip install watchtower-podman` crashed at startup with
# RuntimeError: Could not find alembic/env.py, and `/` returned a
# 61-byte JSON fallback instead of the SPA. The desktop DMG masked it
# because Electron ships its own source tree. scripts/build-wheel.sh
# now stages both into watchtower/_alembic/ and watchtower/_web_dist/
# before `python -m build`; this check builds a wheel and verifies the
# critical files land inside it before letting the release ship.
#
# Skip with SKIP_WHEEL=1 if iterating on something unrelated (e.g.,
# desktop pack), but the resulting release is NOT stable-bar.

if [ -n "${SKIP_WHEEL:-}" ]; then
  WARN "SKIP_WHEEL set — PyPI wheel verification skipped (NOT a stable release)"
else
  WHEEL_LOG=$(mktemp)
  if "$REPO_ROOT/scripts/build-wheel.sh" >"$WHEEL_LOG" 2>&1; then
    PASS "Wheel build succeeded with alembic/ + web/dist/ staged in package"
  else
    FAIL "Wheel build failed — see $WHEEL_LOG"
    tail -30 "$WHEEL_LOG"
  fi
  rm -f "$WHEEL_LOG"
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "5. Two-stage-updater payload"
# Phase 1 of docs/DESKTOP_TWO_STAGE_UPDATER.md: every release publishes an
# arch-independent watchtower-payload-<version>.tar.gz. This builds it the
# same way the release.yml build-payload job does and asserts the contract
# the (future) payload-aware shell relies on: migrations inside the package,
# the SPA present, version coherent, and a signature that verifies against
# the public key pinned in the desktop shell.

if [ -n "${SKIP_PAYLOAD:-}" ]; then
  WARN "SKIP_PAYLOAD set — payload verification skipped (NOT a stable release)"
else
  PAYLOAD_LOG=$(mktemp)
  if "$REPO_ROOT/scripts/build-payload.sh" >"$PAYLOAD_LOG" 2>&1; then
    PASS "Payload build succeeded (scripts/build-payload.sh)"
  else
    FAIL "Payload build failed — see $PAYLOAD_LOG"
    tail -20 "$PAYLOAD_LOG"
  fi
  rm -f "$PAYLOAD_LOG"

  PAYLOAD_TARBALL="$REPO_ROOT/payload-dist/watchtower-payload-$PKG_VERSION.tar.gz"
  PAYLOAD_MANIFEST="$REPO_ROOT/payload-dist/payload-manifest.json"
  if [ -f "$PAYLOAD_TARBALL" ] && [ -f "$PAYLOAD_MANIFEST" ]; then
    # Contract: alembic inside the package + SPA + self-describing payload.json.
    PAYLOAD_TAR_LIST=$(tar -tzf "$PAYLOAD_TARBALL" 2>/dev/null)
    for required in "payload/watchtower/alembic/env.py" "payload/web-dist/index.html" "payload/payload.json"; do
      if printf '%s\n' "$PAYLOAD_TAR_LIST" | grep -qx "$required"; then
        PASS "Payload contains $required"
      else
        FAIL "Payload missing $required — a shell booting this payload would crash"
      fi
    done

    # payload.json version must match the repo version (a mismatch means the
    # staging step resolved stale code — the payload-flavored stale-bundle bug).
    PAYLOAD_JSON_VERSION=$(tar -xzOf "$PAYLOAD_TARBALL" payload/payload.json 2>/dev/null \
      | "$VENV_PY" -c "import json,sys; print(json.load(sys.stdin)['version'])" 2>/dev/null)
    if [ "$PAYLOAD_JSON_VERSION" = "$PKG_VERSION" ]; then
      PASS "payload.json version = $PAYLOAD_JSON_VERSION (matches watchtower/__init__.py)"
    else
      FAIL "payload.json version '$PAYLOAD_JSON_VERSION' != repo version $PKG_VERSION"
    fi

    # The updater client logic itself: run the phase-2/3 selection,
    # verification, and decision-matrix tests against the REAL main.js code
    # and the payload built above. This is the check that caught the
    # minShellVersion=own-version bug that would have made payload updates
    # dead on arrival.
    if node "$REPO_ROOT/desktop/scripts/test-payload-logic.js" "$REPO_ROOT/desktop/main.js" >/dev/null 2>&1; then
      PASS "Updater client logic tests (desktop/scripts/test-payload-logic.js) — all pass"
    else
      FAIL "Updater client logic tests failed — run: node desktop/scripts/test-payload-logic.js desktop/main.js"
    fi

    # Signature must verify against the SAME public key the shell pins
    # (desktop/payload-signing.pub). When no local signing key exists, prove
    # the sign/verify machinery with an ephemeral keypair instead and warn —
    # CI signs with the real key either way.
    PAYLOAD_SIG=$("$VENV_PY" -c "import json; print(json.load(open('$PAYLOAD_MANIFEST'))['signature'])" 2>/dev/null)
    if [ -n "$PAYLOAD_SIG" ]; then
      if "$VENV_PY" "$REPO_ROOT/scripts/payload_tools.py" verify "$PAYLOAD_TARBALL" \
           --pub "$REPO_ROOT/desktop/payload-signing.pub" --signature "$PAYLOAD_SIG" >/dev/null 2>&1; then
        PASS "Payload signature verifies against pinned desktop/payload-signing.pub"
      else
        FAIL "Payload signature does NOT verify against desktop/payload-signing.pub — local key and pinned pubkey have diverged"
      fi
    else
      EPHEMERAL_DIR=$(mktemp -d)
      if "$VENV_PY" "$REPO_ROOT/scripts/payload_tools.py" keygen \
           --out-private "$EPHEMERAL_DIR/key.pem" --out-public "$EPHEMERAL_DIR/pub.pem" >/dev/null 2>&1 \
         && EPHEMERAL_SIG=$("$VENV_PY" "$REPO_ROOT/scripts/payload_tools.py" sign "$PAYLOAD_TARBALL" --key "$EPHEMERAL_DIR/key.pem" 2>/dev/null) \
         && "$VENV_PY" "$REPO_ROOT/scripts/payload_tools.py" verify "$PAYLOAD_TARBALL" \
              --pub "$EPHEMERAL_DIR/pub.pem" --signature "$EPHEMERAL_SIG" >/dev/null 2>&1; then
        PASS "Sign/verify machinery works (ephemeral key round-trip)"
        WARN "Payload is UNSIGNED locally — no key at ~/.watchtower/payload-signing-key.pem; CI signs with the repo secret"
      else
        FAIL "Ephemeral sign/verify round-trip failed — payload signing machinery is broken"
      fi
      rm -rf "$EPHEMERAL_DIR"
    fi
  else
    FAIL "payload-dist/ missing tarball or manifest after build"
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "6. Forbidden user-facing strings"
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
