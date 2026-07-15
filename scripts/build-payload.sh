#!/usr/bin/env bash
# Build the two-stage-updater payload: the arch-independent, per-release
# half of the desktop app (design: docs/DESKTOP_TWO_STAGE_UPDATER.md).
#
# Output (in $OUT_DIR, default payload-dist/):
#   watchtower-payload-<version>.tar.gz    payload/{watchtower/, web-dist/, payload.json}
#   payload-manifest.json                  version, minShellVersion,
#                                          requirementsSha256, sha256,
#                                          signature (Ed25519), keyId, sizeBytes
#
# The payload is pure Python + static assets — ONE artifact for all five
# desktop platforms, which is exactly why the 1.12.0 cross-arch bug class
# can't exist for it. Runs once per release (release.yml build-payload
# job), and locally from preflight.sh.
#
# Signing key resolution (first match wins):
#   WATCHTOWER_PAYLOAD_SIGNING_KEY        PEM contents in env (CI secret)
#   WATCHTOWER_PAYLOAD_SIGNING_KEY_FILE   path to PEM
#   ~/.watchtower/payload-signing-key.pem default local path (release box)
# No key found → manifest ships with an empty signature and a loud warning;
# preflight treats that as "machinery-only" verified, CI refuses to publish.
#
# Env vars:
#   OUT_DIR             output dir (default payload-dist/)
#   MIN_SHELL_VERSION   oldest shell main.js that can boot this payload
#                       (default: 1.21.0, the first payload-aware shell;
#                       bump only when the payload starts depending on
#                       new shell behavior — see comment at the default)
#   PAYLOAD_KEY_ID      manifest keyId for rotation (default 2026-07)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/payload-dist}"
PAYLOAD_KEY_ID="${PAYLOAD_KEY_ID:-2026-07}"

# Same venv-preference pattern as build-wheel.sh — macOS Homebrew Python
# blocks system-wide pip (PEP 668); CI has a working system python3.
if [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  PY="$REPO_ROOT/.venv/bin/python"
else
  PY=python3
fi

VERSION=$(grep -E '^__version__' watchtower/__init__.py | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
  echo "ERROR: could not read __version__ from watchtower/__init__.py" >&2
  exit 1
fi
# The OLDEST shell whose main.js can boot this payload — i.e. the first
# release that shipped the payload-aware boot path (updater phases 2+3).
# This must NOT default to $VERSION: a payload that demands a shell as new
# as itself can never be applied by any existing install, which would make
# the whole payload channel dead on arrival. Bump it ONLY when a payload
# starts depending on newer main.js behavior (new IPC, new spawn contract),
# and expect every older shell to fall back to a full-installer update.
MIN_SHELL_VERSION="${MIN_SHELL_VERSION:-1.21.0}"

echo "── Building payload v$VERSION (minShell $MIN_SHELL_VERSION, keyId $PAYLOAD_KEY_ID) ──"

# SPA bundle must exist — build it if missing, same as build-wheel.sh.
if [ ! -d web/dist ]; then
  echo "  · web/dist/ missing — building SPA first"
  npm --prefix web install --no-audit --no-fund --silent
  npm --prefix web run build
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

echo "── Staging watchtower package (pip install --no-deps --target) ──"
# --no-compile: no __pycache__ noise; the shell's Python compiles on first
# import. Building from the repo root gives exactly what a release install
# gets (pyproject-driven), not a raw source copy.
"$PY" -m pip install --quiet --no-deps --no-compile --target "$STAGE/pkg" "$REPO_ROOT"

PAYLOAD_DIR="$STAGE/payload"
mkdir -p "$PAYLOAD_DIR"
cp -R "$STAGE/pkg/watchtower" "$PAYLOAD_DIR/watchtower"

# If a wheel build was interrupted mid-stage, the source tree may contain
# leftover watchtower/_alembic + _web_dist copies — drop them; the payload
# carries alembic/ inside the package and web-dist/ as a sibling instead.
rm -rf "$PAYLOAD_DIR/watchtower/_alembic" "$PAYLOAD_DIR/watchtower/_web_dist"

# Same convention as the shell bundle (build-python-bundle.sh): alembic/
# lives INSIDE the package so _alembic_config() finds it via
# Path(__file__).parent / 'alembic'.
rm -rf "$PAYLOAD_DIR/watchtower/alembic"
cp -R "$REPO_ROOT/alembic" "$PAYLOAD_DIR/watchtower/alembic"

cp -R "$REPO_ROOT/web/dist" "$PAYLOAD_DIR/web-dist"
find "$PAYLOAD_DIR" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true

# The staged package's version must match the repo — a mismatch means pip
# resolved something other than this source tree.
STAGED_VERSION=$(grep -E '^__version__' "$PAYLOAD_DIR/watchtower/__init__.py" | sed -E 's/.*"([^"]+)".*/\1/')
if [ "$STAGED_VERSION" != "$VERSION" ]; then
  echo "ERROR: staged watchtower is $STAGED_VERSION but repo is $VERSION" >&2
  exit 1
fi

REQ_SHA=$("$PY" "$REPO_ROOT/scripts/payload_tools.py" fingerprint "$REPO_ROOT/requirements.txt")

# payload.json — the identity half of the manifest, embedded so an
# extracted payload dir is self-describing. It can't contain its own
# sha256/signature (those cover the tarball it lives inside); the external
# payload-manifest.json adds them.
cat > "$PAYLOAD_DIR/payload.json" <<EOF
{
  "version": "$VERSION",
  "minShellVersion": "$MIN_SHELL_VERSION",
  "requirementsSha256": "$REQ_SHA",
  "keyId": "$PAYLOAD_KEY_ID"
}
EOF

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/watchtower-payload-$VERSION.tar.gz"
rm -f "$TARBALL"
# COPYFILE_DISABLE: keep macOS AppleDouble (._*) files out so a tarball
# built locally on a Mac matches what CI's GNU tar produces structurally.
(cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$TARBALL" payload)

echo "── Signing ──"
SIGNATURE=""
if [ -n "${WATCHTOWER_PAYLOAD_SIGNING_KEY:-}" ]; then
  SIGNATURE=$("$PY" "$REPO_ROOT/scripts/payload_tools.py" sign "$TARBALL" --key-env WATCHTOWER_PAYLOAD_SIGNING_KEY)
  echo "  ✓ Signed with key from env (keyId $PAYLOAD_KEY_ID)"
elif [ -n "${WATCHTOWER_PAYLOAD_SIGNING_KEY_FILE:-}" ]; then
  SIGNATURE=$("$PY" "$REPO_ROOT/scripts/payload_tools.py" sign "$TARBALL" --key "$WATCHTOWER_PAYLOAD_SIGNING_KEY_FILE")
  echo "  ✓ Signed with key file $WATCHTOWER_PAYLOAD_SIGNING_KEY_FILE (keyId $PAYLOAD_KEY_ID)"
elif [ -f "$HOME/.watchtower/payload-signing-key.pem" ]; then
  SIGNATURE=$("$PY" "$REPO_ROOT/scripts/payload_tools.py" sign "$TARBALL" --key "$HOME/.watchtower/payload-signing-key.pem")
  echo "  ✓ Signed with ~/.watchtower/payload-signing-key.pem (keyId $PAYLOAD_KEY_ID)"
else
  echo "  ! NO SIGNING KEY FOUND — manifest will carry an empty signature." >&2
  echo "    Clients will reject this payload. CI signs with the repo secret;" >&2
  echo "    locally, keep the key at ~/.watchtower/payload-signing-key.pem." >&2
fi

"$PY" "$REPO_ROOT/scripts/payload_tools.py" manifest \
  --version "$VERSION" \
  --min-shell-version "$MIN_SHELL_VERSION" \
  --requirements-sha "$REQ_SHA" \
  --key-id "$PAYLOAD_KEY_ID" \
  --tarball "$TARBALL" \
  --signature "$SIGNATURE" \
  > "$OUT_DIR/payload-manifest.json"

echo "── Verifying tarball contents ──"
TAR_LIST=$(tar -tzf "$TARBALL")
for required in \
  "payload/watchtower/alembic/env.py" \
  "payload/web-dist/index.html" \
  "payload/payload.json"; do
  if printf '%s\n' "$TAR_LIST" | grep -qx "$required"; then
    echo "  ✓ $required"
  else
    echo "  ✗ payload missing $required" >&2
    exit 1
  fi
done

SIZE_MB=$(du -m "$TARBALL" | awk '{print $1}')
echo ""
echo "✅ Payload ready: $TARBALL (${SIZE_MB} MB, all platforms)"
echo "   Manifest:      $OUT_DIR/payload-manifest.json"
