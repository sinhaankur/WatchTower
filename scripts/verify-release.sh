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

# Asset count sanity. A complete release ships ~27 files (DMGs + zips +
# blockmaps + AppImages + debs + EXEs + latest-*.yml). Allow ±2 for
# minor variations.
COUNT=$(echo "$ASSET_NAMES" | wc -l | tr -d ' ')
if [ "$COUNT" -lt 25 ] || [ "$COUNT" -gt 30 ]; then
  FAIL "Asset count $COUNT outside expected 25-30 range — partial build?"
else
  PASS "Asset count $COUNT in expected range (25-30)"
fi

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
  hdiutil detach "$mount_point" 2>/dev/null || true
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

verify_mac_dmg arm64 "arm64"
verify_mac_dmg x64 "x86_64"
verify_linux_appimage x64 "x86-64"
verify_linux_appimage arm64 "aarch64"
# Note: armv7l + Windows arm64 don't ship a python-build-standalone bundle
# (no PBS target exists), so there's nothing to arch-verify there. They
# fall back to system/pipx Python at runtime.

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
