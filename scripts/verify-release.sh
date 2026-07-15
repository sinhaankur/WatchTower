#!/usr/bin/env bash
# Post-CI release verification.
#
# Implements item 3 of RELEASE_QUALITY.md — checks that the artifacts
# actually published on GitHub Releases have the right arch + intact
# Python bundle. This is the check that would have caught the 1.12.0
# Mac DMG bug (arm64 DMG containing x86_64 Python bundle), since that
# only manifested at install time, not in CI.
#
# Usage:  ./scripts/verify-release.sh v1.12.1
#
# Requires:  gh CLI authenticated, file(1), unzip(1), tar(1).
# Optional:  hdiutil(1) on macOS for actually mounting the DMG and
#            running its bundled Python — without it we can only
#            verify file integrity, not import-correctness.

set -uo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "Usage: $0 vX.Y.Z" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

PASS() { printf '\033[32m✓\033[0m %s\n' "$*"; }
FAIL() { printf '\033[31m✗ %s\033[0m\n' "$*"; FAILURES=$((FAILURES+1)); }
WARN() { printf '\033[33m! %s\033[0m\n' "$*"; }
HEAD() { printf '\n\033[1m── %s ──\033[0m\n' "$*"; }

FAILURES=0

HEAD "Pulling release manifest"
ASSETS_JSON=$(gh release view "$TAG" --json assets 2>/dev/null) || {
  echo "Failed to fetch release $TAG. Is the tag pushed and the build complete?"
  exit 1
}
ASSET_NAMES=$(echo "$ASSETS_JSON" | jq -r '.assets[].name')

# Item 3 baseline: latest-*.yml files MUST be present so electron-updater works.
HEAD "Auto-update manifests present"
for f in latest-mac.yml latest-linux.yml latest.yml; do
  if echo "$ASSET_NAMES" | grep -qx "$f"; then
    PASS "$f present"
  else
    FAIL "$f missing — auto-update channel for that platform is broken"
  fi
done

# latest-mac.yml MUST list BOTH arm64 and x64. The two macOS matrix jobs each
# emit a single-arch latest-mac.yml and race to overwrite each other on the
# release; if only one survives, the OTHER arch's electron-updater never sees an
# update (silently broke Mac auto-update through 1.16.x). The merge-mac-manifest
# CI job combines them — this asserts the published result actually did.
if echo "$ASSET_NAMES" | grep -qx "latest-mac.yml"; then
  MAC_YML="$WORK_DIR/latest-mac.yml"
  if gh release download "$TAG" -p "latest-mac.yml" -O "$MAC_YML" --clobber >/dev/null 2>&1; then
    HAS_ARM=$(grep -c "mac-arm64.zip" "$MAC_YML" || true)
    HAS_X64=$(grep -c "mac-x64.zip" "$MAC_YML" || true)
    if [ "$HAS_ARM" -ge 1 ] && [ "$HAS_X64" -ge 1 ]; then
      PASS "latest-mac.yml lists both arm64 + x64 (auto-update works on both Macs)"
    else
      FAIL "latest-mac.yml is single-arch (arm64=$HAS_ARM x64=$HAS_X64) — one Mac arch can't auto-update. The merge-mac-manifest job must run/succeed."
    fi
    # Electron 43+ builds require macOS 12; without this field, updaters on
    # older macOS download + install a build the OS refuses to launch. The
    # merge-mac-manifest job injects it — assert it survived to the release.
    if grep -q "minimumSystemVersion:" "$MAC_YML"; then
      PASS "latest-mac.yml carries minimumSystemVersion (old-macOS installs are protected)"
    else
      FAIL "latest-mac.yml is missing minimumSystemVersion — macOS <12 users would auto-update into an app that can't launch."
    fi
  else
    WARN "Could not download latest-mac.yml to inspect its arch coverage."
  fi
fi

# Asset count sanity. A complete release ships ~29 files (DMGs + zips +
# blockmaps + AppImages + debs + EXEs + latest-*.yml + payload tarball +
# payload manifest). Allow ±2 for minor variations.
COUNT=$(echo "$ASSET_NAMES" | wc -l | tr -d ' ')
if [ "$COUNT" -lt 27 ] || [ "$COUNT" -gt 32 ]; then
  FAIL "Asset count $COUNT outside expected 27-32 range — partial build?"
else
  PASS "Asset count $COUNT in expected range (27-32)"
fi

# Per-platform installer presence. Catches the v1.12.1 case where the
# windows-x64 matrix entry hung on `python.exe -m pip install --upgrade
# pip` (Windows file lock) so the .exe never got published — total
# count was 22 (still close to 25, fuzzy-match wouldn't always catch
# this, but a named-asset assertion always will).
HEAD "Per-platform installer presence"
VERSION_NUM="${TAG#v}"
EXPECTED_INSTALLERS=(
  "WatchTower-${VERSION_NUM}-mac-arm64.dmg"
  "WatchTower-${VERSION_NUM}-mac-x64.dmg"
  "WatchTower-${VERSION_NUM}-linux-x86_64.AppImage"
  "WatchTower-${VERSION_NUM}-linux-arm64.AppImage"
  "WatchTower-${VERSION_NUM}-linux-armv7l.AppImage"
  "WatchTower-${VERSION_NUM}-win-x64.exe"
  "WatchTower-${VERSION_NUM}-win-arm64.exe"
)
for asset in "${EXPECTED_INSTALLERS[@]}"; do
  if echo "$ASSET_NAMES" | grep -qx "$asset"; then
    PASS "$asset present"
  else
    FAIL "$asset MISSING — that platform's matrix job didn't publish"
  fi
done

# ──────────────────────────────────────────────────────────────────────────
# The arch-correctness check — this is the one that would have caught
# the 1.12.0 Mac DMG cross-contamination. For each platform/arch combo we
# expect, download the artifact, extract enough of it to find the bundled
# Python's pydantic_core .so (or .pyd), and check `file` reports the
# correct architecture.
HEAD "Bundle architecture checks"

VERSION="${TAG#v}"
DOWNLOAD() {
  local name="$1"
  local out="$WORK_DIR/$name"
  if [ ! -f "$out" ]; then
    gh release download "$TAG" --pattern "$name" --dir "$WORK_DIR" >/dev/null 2>&1 || {
      FAIL "Could not download $name from release $TAG"
      return 1
    }
  fi
  echo "$out"
}

# Mac arm64 DMG — _pydantic_core .so should be Mach-O arm64.
verify_mac_dmg() {
  local arch="$1"
  local expected_arch_pattern="$2"
  local dmg="WatchTower-$VERSION-mac-$arch.dmg"
  local dmg_path
  dmg_path=$(DOWNLOAD "$dmg") || return 1
  if [ "$(uname -s)" != "Darwin" ]; then
    WARN "Not on macOS — can't mount $dmg, skipping import check (CI smoke test on the user's machine catches this)"
    return 0
  fi
  local mount_output
  mount_output=$(hdiutil attach "$dmg_path" -nobrowse -noautoopen 2>&1) || {
    FAIL "Could not mount $dmg"
    return 1
  }
  local mount_point
  mount_point=$(echo "$mount_output" | grep -Eo '/Volumes/[^	]+' | head -1)
  if [ -z "$mount_point" ] || [ ! -d "$mount_point/WatchTower.app" ]; then
    FAIL "$dmg mounted but no WatchTower.app inside (mount=$mount_point)"
    hdiutil detach "$mount_point" 2>/dev/null || true
    return 1
  fi
  local pc_so
  pc_so=$(find "$mount_point/WatchTower.app/Contents/Resources/python" -name '_pydantic_core*.so' 2>/dev/null | head -1)
  if [ -z "$pc_so" ]; then
    FAIL "$dmg: bundled python missing pydantic_core's .so file (would crash on first launch)"
  else
    local file_info
    file_info=$(file "$pc_so")
    if echo "$file_info" | grep -q "$expected_arch_pattern"; then
      PASS "$dmg: pydantic_core .so is $expected_arch_pattern (correct)"
    else
      FAIL "$dmg: pydantic_core .so is WRONG arch — file says: $file_info"
      FAIL "  This is the 1.12.0-class bug. Block release."
    fi
  fi
  verify_bundle_contents "$dmg" "$mount_point/WatchTower.app/Contents/Resources/python"
  verify_mac_signing "$dmg" "$mount_point/WatchTower.app"
  hdiutil detach "$mount_point" 2>/dev/null || true
}

# Code-signing state. The meaningful boundary is IDENTITY, not seal validity:
#   1. No Developer ID identity (unsigned or ad-hoc, pre-membership) → WARN.
#      Do NOT judge seal validity here — electron-builder's repack always
#      leaves ad-hoc helper seals userland-"invalid" (verified empirically on
#      v1.21.0: all four Helper.app seals fail codesign --verify, yet the app
#      launches fine — the kernel's exec check only validates the binary's
#      own code pages, and Gatekeeper routes users to right-click-open
#      regardless). That's the expected shipped state until the Apple
#      Developer membership lands (docs/MAC_CODE_SIGNING.md).
#   2. Developer-ID signed + valid seal + notarized → PASS.
#   3. Developer-ID identity but broken seal / not notarized → FAIL. A
#      half-signed app is WORSE than unsigned: Gatekeeper hard-blocks it with
#      no right-click-open escape hatch.
verify_mac_signing() {
  local label="$1" app="$2"
  local sig_info
  sig_info=$(codesign -dvv "$app" 2>&1)
  if echo "$sig_info" | grep -q "code object is not signed"; then
    WARN "$label: unsigned (code signing not enabled yet — docs/MAC_CODE_SIGNING.md)"
    return 0
  fi
  if ! echo "$sig_info" | grep -q "Authority=Developer ID Application"; then
    WARN "$label: ad-hoc/non-Developer-ID signed (expected pre-membership state — docs/MAC_CODE_SIGNING.md)"
    return 0
  fi
  # Developer ID identity present — from here on, everything must be right.
  PASS "$label: signed with a Developer ID Application cert"
  if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    PASS "$label: codesign verifies (--deep --strict)"
  else
    FAIL "$label: Developer-ID signature does NOT verify (broken seal) — Gatekeeper hard-blocks this, worse than unsigned. Block release."
  fi
  if spctl -a -t exec "$app" >/dev/null 2>&1; then
    PASS "$label: Gatekeeper accepts (signed + notarized)"
  else
    FAIL "$label: signed but Gatekeeper REJECTS — likely not notarized. Block release (worse than unsigned)."
  fi
  if xcrun stapler validate "$app" >/dev/null 2>&1; then
    PASS "$label: notarization ticket stapled (first launch works offline)"
  else
    WARN "$label: no stapled notarization ticket — first launch needs network for Gatekeeper's online check"
  fi
}

# Stale-bundle guard. A DMG can carry the right ARCH but a stale Python
# bundle — wrong watchtower __version__ and an incomplete alembic/versions
# set. That's the 1.16.3 incident: a 1.14.4 bundle whose migrations stopped
# before the user's DB revision, so the app crashed on every launch with
# "Can't locate revision". Arch checks never see it. This does.
verify_bundle_contents() {
  local label="$1"
  local python_root="$2"
  local wt_init
  wt_init=$(find "$python_root" -path '*/site-packages/watchtower/__init__.py' 2>/dev/null | head -1)
  if [ -z "$wt_init" ]; then
    FAIL "$label: bundled watchtower package not found under $python_root"
    return 1
  fi
  # Version must match the tag.
  local bundle_ver
  bundle_ver=$(grep -E '^__version__' "$wt_init" | sed -E 's/.*"([^"]+)".*/\1/')
  if [ "$bundle_ver" = "$VERSION" ]; then
    PASS "$label: bundled watchtower __version__ = $bundle_ver (matches tag)"
  else
    FAIL "$label: bundled watchtower __version__ = '$bundle_ver' but tag is $VERSION — STALE BUNDLE. Block release."
  fi
  # Migration count must match the repo (incomplete migrations crash on
  # users whose DB is past the bundle's last revision).
  local repo_mig bundle_mig vers_dir
  vers_dir="$(dirname "$wt_init")/alembic/versions"
  repo_mig=$(ls "$REPO_ROOT"/alembic/versions/*.py 2>/dev/null | grep -v __pycache__ | wc -l | tr -d ' ')
  bundle_mig=$(ls "$vers_dir"/*.py 2>/dev/null | grep -v __pycache__ | wc -l | tr -d ' ')
  if [ "$bundle_mig" = "$repo_mig" ]; then
    PASS "$label: $bundle_mig alembic migrations bundled (matches repo)"
  else
    FAIL "$label: bundle has $bundle_mig migrations, repo has $repo_mig — INCOMPLETE. Users past the bundle's head will crash. Block release."
  fi
  # Capture the shell's runtime fingerprint (two-stage updater). The payload
  # section below cross-checks payload-manifest.json's requirementsSha256
  # against it — a mismatch on the SAME release means payload-aware shells
  # from this release could never apply this release's own payloads.
  if [ -f "$python_root/runtime-fingerprint.json" ]; then
    if [ ! -f "$WORK_DIR/shell-runtime-fingerprint.json" ]; then
      cp "$python_root/runtime-fingerprint.json" "$WORK_DIR/shell-runtime-fingerprint.json"
    fi
    PASS "$label: runtime-fingerprint.json present in shell bundle"
  else
    WARN "$label: no runtime-fingerprint.json in shell bundle (pre-payload release, or build-python-bundle.sh regressed)"
  fi
}

# Linux AppImage — extract the embedded squashfs and check the .so arch.
verify_linux_appimage() {
  local arch="$1"
  local expected_arch_pattern="$2"
  local appimage_arch="$arch"
  case "$arch" in arm64) appimage_arch=aarch64 ;; x64) appimage_arch=x86_64 ;; esac
  local img="WatchTower-$VERSION-linux-${appimage_arch}.AppImage"
  local img_path
  img_path=$(DOWNLOAD "$img") || return 1
  # AppImage lets us extract without mounting (`--appimage-extract` works
  # cross-arch). Need executable bit.
  chmod +x "$img_path" 2>/dev/null || true
  local extract_dir="$WORK_DIR/extract-$arch"
  mkdir -p "$extract_dir"
  if (cd "$extract_dir" && "$img_path" --appimage-extract '*/python/lib/python3.12/site-packages/pydantic_core/_pydantic_core*.so' 2>&1 | head -5) >/dev/null 2>&1; then
    local pc_so
    pc_so=$(find "$extract_dir" -name '_pydantic_core*.so' 2>/dev/null | head -1)
    if [ -z "$pc_so" ]; then
      WARN "$img: --appimage-extract didn't yield _pydantic_core.so (extract not supported on this host or AppImage runtime missing). Skipping arch check."
    else
      local file_info
      file_info=$(file "$pc_so")
      if echo "$file_info" | grep -q "$expected_arch_pattern"; then
        PASS "$img: pydantic_core .so is $expected_arch_pattern (correct)"
      else
        FAIL "$img: pydantic_core .so is WRONG arch — file says: $file_info"
      fi
    fi
  else
    WARN "$img: could not run --appimage-extract on this host. Visual inspection required on a Linux $arch box."
  fi
}

# Windows x64 .zip — easier to verify than the NSIS .exe (no 7zip needed).
# We check that every native .pyd matches the bundled Python's ABI tag.
# The .zip and the .exe come from the same electron-builder run, so what's
# in the .zip is exactly what the .exe writes to disk after install.
#
# Catches the 1.14.0 ship-blocker: pip's cross-install from a host Python
# 3.11 wrote cp311-win_amd64.pyd files into a bundle whose interpreter is
# python312.dll. The user's first-launch backend log was a textbook
# "ModuleNotFoundError: No module named 'pydantic_core._pydantic_core'"
# in fastapi → pydantic → pydantic_core's native loader. Filename-only
# check, no Windows host needed.
verify_windows_zip() {
  local arch="$1"   # x64
  local zip="WatchTower-$VERSION-win-${arch}.zip"
  local zip_path
  zip_path=$(DOWNLOAD "$zip") || return 1
  local extract_dir="$WORK_DIR/win-${arch}"
  mkdir -p "$extract_dir"
  if ! unzip -q -o "$zip_path" -d "$extract_dir" >/dev/null 2>&1; then
    FAIL "$zip: failed to unzip"
    return 1
  fi
  local py_dll
  py_dll=$(find "$extract_dir" -maxdepth 6 -name 'python3*.dll' \
    -not -name 'python3.dll' 2>/dev/null | head -1)
  if [ -z "$py_dll" ]; then
    FAIL "$zip: bundled python interpreter DLL missing (no python3XY.dll)"
    return 1
  fi
  # python312.dll → 312
  local expected_abi
  expected_abi=$(basename "$py_dll" | sed -E 's/^python([0-9]+)\.dll$/\1/')
  local pyds
  pyds=$(find "$extract_dir" -name '*.pyd' 2>/dev/null)
  if [ -z "$pyds" ]; then
    FAIL "$zip: no .pyd files found in bundle (extract failed?)"
    return 1
  fi
  local mismatched
  mismatched=$(echo "$pyds" \
    | grep -E "\.(cp|pp)[0-9]+-" \
    | grep -v -E "\.cp${expected_abi}-" || true)
  if [ -n "$mismatched" ]; then
    FAIL "$zip: native extensions tagged for the WRONG Python ABI " \
      "(bundle is cp${expected_abi}, but found):"
    echo "$mismatched" | sed 's|^|    |'
    FAIL "  This is the 1.14.0-class bug. Block release."
  else
    PASS "$zip: all .pyd files match bundle ABI cp${expected_abi}"
  fi
}

# Windows Authenticode state — same three-world logic as verify_mac_signing.
# osslsigncode (brew install osslsigncode) lets a Mac/Linux host inspect a
# PE signature; without it this check degrades to a WARN, never a silent skip.
verify_windows_authenticode() {
  local arch="$1"
  local exe="WatchTower-$VERSION-win-${arch}.exe"
  local exe_path
  exe_path=$(DOWNLOAD "$exe") || return 1
  if ! command -v osslsigncode >/dev/null 2>&1; then
    WARN "$exe: osslsigncode not installed — can't inspect Authenticode from this host (brew install osslsigncode)"
    return 0
  fi
  local out
  out=$(osslsigncode verify "$exe_path" 2>&1)
  if echo "$out" | grep -qi "no signature found"; then
    WARN "$exe: unsigned (Windows signing not enabled yet — docs/WINDOWS_CODE_SIGNING.md)"
  elif echo "$out" | grep -q "Signature verification: ok"; then
    PASS "$exe: Authenticode signature verifies"
  else
    FAIL "$exe: signature present but does NOT verify — SmartScreen treats a broken signature worse than none. Block release."
  fi
}

verify_mac_dmg arm64 "arm64"
verify_mac_dmg x64 "x86_64"
verify_linux_appimage x64 "x86-64"
verify_linux_appimage arm64 "aarch64"
verify_windows_zip x64
verify_windows_authenticode x64
verify_windows_authenticode arm64
# Note: armv7l + Windows arm64 don't ship a python-build-standalone bundle
# (no PBS target exists), so there's nothing to arch-verify there. They
# fall back to system/pipx Python at runtime.

# ──────────────────────────────────────────────────────────────────────────
# Two-stage-updater payload (docs/DESKTOP_TWO_STAGE_UPDATER.md, phase 1).
# The released tarball + manifest must be internally consistent (sha256,
# Ed25519 signature against the pinned public key), carry the right
# contents, and — critically — declare the same requirementsSha256 the
# released shell bundles were built with, or payload-aware shells from
# this release could never apply this release's own payloads.
HEAD "Update payload (two-stage updater)"

# Signature verification needs the cryptography lib — prefer the repo venv
# (always has it, it's a core dep), fall back to system python3.
if [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  PAYLOAD_PY="$REPO_ROOT/.venv/bin/python"
else
  PAYLOAD_PY=python3
fi

PAYLOAD_TAR_NAME="watchtower-payload-$VERSION.tar.gz"
PAYLOAD_OK=1
for asset in "$PAYLOAD_TAR_NAME" "payload-manifest.json"; do
  if echo "$ASSET_NAMES" | grep -qx "$asset"; then
    PASS "$asset present"
  else
    FAIL "$asset MISSING — the build-payload CI job didn't publish"
    PAYLOAD_OK=0
  fi
done

if [ "$PAYLOAD_OK" = "1" ]; then
  PAYLOAD_TAR_PATH=$(DOWNLOAD "$PAYLOAD_TAR_NAME")
  MANIFEST_PATH=$(DOWNLOAD "payload-manifest.json")
  if [ -n "$PAYLOAD_TAR_PATH" ] && [ -n "$MANIFEST_PATH" ]; then
    M_VERSION=$(jq -r .version "$MANIFEST_PATH")
    M_SHA=$(jq -r .sha256 "$MANIFEST_PATH")
    M_SIG=$(jq -r .signature "$MANIFEST_PATH")
    M_REQ_SHA=$(jq -r .requirementsSha256 "$MANIFEST_PATH")

    if [ "$M_VERSION" = "$VERSION" ]; then
      PASS "payload-manifest.json version = $M_VERSION (matches tag)"
    else
      FAIL "payload-manifest.json version '$M_VERSION' != tag $VERSION"
    fi

    ACTUAL_SHA=$("$PAYLOAD_PY" "$REPO_ROOT/scripts/payload_tools.py" sha256 "$PAYLOAD_TAR_PATH")
    if [ "$ACTUAL_SHA" = "$M_SHA" ]; then
      PASS "Payload sha256 matches manifest"
    else
      FAIL "Payload sha256 MISMATCH — manifest says $M_SHA, asset is $ACTUAL_SHA. Tampered or corrupt upload. Block release."
    fi

    if [ -z "$M_SIG" ] || [ "$M_SIG" = "null" ]; then
      FAIL "Payload manifest has an EMPTY signature — clients will reject it. Block release."
    elif "$PAYLOAD_PY" "$REPO_ROOT/scripts/payload_tools.py" verify "$PAYLOAD_TAR_PATH" \
           --pub "$REPO_ROOT/desktop/payload-signing.pub" --signature "$M_SIG" >/dev/null 2>&1; then
      PASS "Payload Ed25519 signature verifies against desktop/payload-signing.pub"
    else
      FAIL "Payload signature INVALID against the pinned public key — CI secret and desktop/payload-signing.pub have diverged. Block release."
    fi

    # Contents + internal version — the payload-flavored stale-bundle guard.
    PAYLOAD_EXTRACT="$WORK_DIR/payload-extract"
    mkdir -p "$PAYLOAD_EXTRACT"
    if tar -xzf "$PAYLOAD_TAR_PATH" -C "$PAYLOAD_EXTRACT" 2>/dev/null; then
      for required in "payload/watchtower/alembic/env.py" "payload/web-dist/index.html" "payload/payload.json"; do
        if [ -f "$PAYLOAD_EXTRACT/$required" ]; then
          PASS "Payload contains $required"
        else
          FAIL "Payload missing $required — a shell booting it would crash"
        fi
      done
      P_VERSION=$(jq -r .version "$PAYLOAD_EXTRACT/payload/payload.json" 2>/dev/null)
      if [ "$P_VERSION" = "$VERSION" ]; then
        PASS "Embedded payload.json version = $P_VERSION (matches tag)"
      else
        FAIL "Embedded payload.json version '$P_VERSION' != tag $VERSION — STALE PAYLOAD. Block release."
      fi
      REPO_MIG=$(ls "$REPO_ROOT"/alembic/versions/*.py 2>/dev/null | grep -v __pycache__ | wc -l | tr -d ' ')
      PAYLOAD_MIG=$(ls "$PAYLOAD_EXTRACT"/payload/watchtower/alembic/versions/*.py 2>/dev/null | grep -v __pycache__ | wc -l | tr -d ' ')
      if [ "$PAYLOAD_MIG" = "$REPO_MIG" ]; then
        PASS "Payload ships $PAYLOAD_MIG alembic migrations (matches repo)"
      else
        FAIL "Payload has $PAYLOAD_MIG migrations, repo has $REPO_MIG — INCOMPLETE. Block release."
      fi
    else
      FAIL "Could not extract $PAYLOAD_TAR_NAME — corrupt tarball?"
    fi

    # Fingerprint cross-check: the released shell's runtime-fingerprint.json
    # (captured while a DMG was mounted above) must match the manifest.
    # On non-macOS hosts no DMG gets mounted, so fall back to fingerprinting
    # the local checkout's requirements.txt — valid as long as the checkout
    # is at the released tag.
    if [ -f "$WORK_DIR/shell-runtime-fingerprint.json" ]; then
      SHELL_REQ_SHA=$(jq -r .requirementsSha256 "$WORK_DIR/shell-runtime-fingerprint.json")
      if [ "$M_REQ_SHA" = "$SHELL_REQ_SHA" ]; then
        PASS "requirementsSha256 matches the released shell bundle's runtime fingerprint"
      else
        FAIL "requirementsSha256 MISMATCH: manifest=$M_REQ_SHA shell=$SHELL_REQ_SHA — this release's shells can't apply this release's payloads. Block release."
      fi
    else
      LOCAL_REQ_SHA=$("$PAYLOAD_PY" "$REPO_ROOT/scripts/payload_tools.py" fingerprint "$REPO_ROOT/requirements.txt")
      if [ "$M_REQ_SHA" = "$LOCAL_REQ_SHA" ]; then
        PASS "requirementsSha256 matches local requirements.txt fingerprint"
        WARN "  (shell bundle fingerprint not inspected on this host — run on macOS to check the released DMG directly)"
      else
        FAIL "requirementsSha256 MISMATCH vs local requirements.txt — is the checkout at tag $TAG?"
      fi
    fi
  fi
fi

# ──────────────────────────────────────────────────────────────────────────
HEAD "Result"

if [ "$FAILURES" = "0" ]; then
  printf '\033[32m✅  RELEASE %s VERIFIED\033[0m — meets the Stable artifact-integrity bar.\n' "$TAG"
  echo
  echo "If you also passed preflight.sh before tagging, this release is Stable-ready."
  exit 0
else
  printf '\033[31m❌  RELEASE %s HAS %s ISSUE(S)\033[0m\n' "$TAG" "$FAILURES"
  echo
  echo "Don't auto-update users to this tag. Either:"
  echo "  - Re-run the failed CI matrix job(s) and re-verify"
  echo "  - Ship as Beta only (when channel split lands)"
  echo "  - Cut a fresh patch release with the fix"
  exit 1
fi
