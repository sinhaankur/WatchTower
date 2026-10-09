#!/bin/sh
# WatchTower one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/sinhaankur/WatchTower/main/install/get.sh | sh
#
# Detects your OS + CPU, grabs the matching installer from the latest GitHub
# Release, and hands off to it — no git clone, no build toolchain. Linux can
# also install the headless server straight from PyPI with --pip.
#
# POSIX sh (works on macOS's /bin/sh and minimal Linux). No bashisms.

set -eu

REPO="sinhaankur/WatchTower"
API="https://api.github.com/repos/${REPO}/releases/latest"
MODE="${1:-}"            # "", "--pip", "--docker"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs '$1' on your PATH."; }

# ── Fast paths: pip (headless server) / docker (container) ───────────────────
if [ "$MODE" = "--pip" ]; then
  need python3
  say "Installing WatchTower (headless) from PyPI…"
  python3 -m pip install --upgrade watchtower-podman \
    || python3 -m pip install --user --upgrade watchtower-podman \
    || die "pip install failed — try: pipx install watchtower-podman"
  info "Done. Start it with:  watchtower-deploy"
  exit 0
fi
if [ "$MODE" = "--docker" ]; then
  need docker
  say "Running WatchTower in Docker…"
  docker run -d --name watchtower -p 8000:8000 "ghcr.io/sinhaankur/watchtower:latest"
  info "Open http://127.0.0.1:8000"
  exit 0
fi

# ── Detect OS + arch, map to the release asset naming ────────────────────────
need curl
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)          ASSET_RE='mac-arm64\.dmg$' ;;
      x86_64)         ASSET_RE='mac-x64\.dmg$' ;;
      *) die "unsupported macOS arch: $ARCH" ;;
    esac ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64)   ASSET_RE='linux-x86_64\.AppImage$' ;;
      aarch64|arm64)  ASSET_RE='linux-arm64\.AppImage$' ;;
      armv7l)         ASSET_RE='linux-armv7l\.AppImage$' ;;
      *) die "unsupported Linux arch: $ARCH" ;;
    esac ;;
  *)
    die "unsupported OS: $OS. On Windows, download the .exe from https://github.com/${REPO}/releases/latest" ;;
esac

say "Finding the latest WatchTower release…"
# Pull the matching asset's download URL from the GitHub API (no jq dependency).
URL="$(curl -fsSL "$API" \
  | grep -oE '"browser_download_url": *"[^"]+"' \
  | sed -E 's/.*"(https[^"]+)".*/\1/' \
  | grep -E "$ASSET_RE" \
  | head -1 || true)"

[ -n "$URL" ] || die "couldn't find an installer for $OS/$ARCH in the latest release.
  Browse all downloads: https://github.com/${REPO}/releases/latest
  Or install headless:   curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install/get.sh | sh -s -- --pip"

FILE="$(basename "$URL")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
info "Downloading $FILE…"
curl -fsSL "$URL" -o "$TMP/$FILE"

# ── Hand off to the platform installer ───────────────────────────────────────
case "$OS" in
  Darwin)
    say "Opening the installer…"
    open "$TMP/$FILE"
    info "Drag WatchTower to Applications, then launch it. (First launch: right-click → Open.)"
    # Keep the dmg around until the user mounts it.
    cp "$TMP/$FILE" "$HOME/Downloads/$FILE" 2>/dev/null && info "A copy is in ~/Downloads too." || true
    ;;
  Linux)
    DEST="$HOME/.local/bin"
    mkdir -p "$DEST"
    chmod +x "$TMP/$FILE"
    mv "$TMP/$FILE" "$DEST/WatchTower.AppImage"
    say "Installed to $DEST/WatchTower.AppImage"
    info "Run it:  $DEST/WatchTower.AppImage"
    case ":$PATH:" in *":$DEST:"*) ;; *) info "(add $DEST to your PATH to run 'WatchTower.AppImage' from anywhere)";; esac
    ;;
esac

say "Done. Welcome to WatchTower."
