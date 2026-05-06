#!/usr/bin/env bash
# WatchTower install / update / re-launch script for Linux.
#
# Idempotent: safe to run as many times as you like.
#
# Usage:
#   wt-update                # kill any stuck instance, install latest, launch
#   wt-update --skip-install # just kill stuck instances and relaunch
#   wt-update --no-launch    # install only, don't open the GUI
#   wt-update --version v1.5.26  # install a specific tag instead of latest
#
# What it does, in order:
#   1. Stop any currently-running watchtower-desktop process tree.
#      (dpkg -i replaces /opt/WatchTower/ on disk but Linux keeps the
#      OLD binary's inode alive in the running process — so a fresh
#      install while the app is open actually leaves the old version
#      running. Killing it first avoids that confusion.)
#   2. Clear stale Singleton{Lock,Cookie,Socket} symlinks if a prior
#      instance died abnormally. We fixed the self-heal in v1.5.23
#      but stale locks from older installs (or future crashes) still
#      need clearing.
#   3. Free port 8000 if an orphan uvicorn is squatting on it.
#   4. Download the .deb for the right architecture from GitHub
#      Releases. Uses /releases/latest by default, or the --version
#      argument if you want to pin.
#   5. dpkg -i (this is the only step that needs sudo).
#   6. Launch the new binary in the background with --no-sandbox
#      (Ubuntu 24.04 AppArmor restricts unprivileged user namespaces
#      which Electron's sandbox needs; --no-sandbox is the standard
#      workaround until we ship a proper AppArmor profile).

set -euo pipefail

SKIP_INSTALL=0
NO_LAUNCH=0
PIN_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --no-launch)    NO_LAUNCH=1 ;;
    --version)
      shift
      PIN_VERSION="${1:-}"
      [[ -z "$PIN_VERSION" ]] && { echo "--version requires a tag (e.g. v1.5.26)"; exit 2; }
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
  shift
done

step() { printf "\n── %s\n" "$*"; }

step "1/6: stop any running watchtower-desktop"
if pgrep -f "/opt/WatchTower/watchtower-desktop" >/dev/null 2>&1; then
  pkill -TERM -f "/opt/WatchTower/watchtower-desktop" 2>/dev/null || true
  sleep 1
  # Force-kill anything that didn't exit on SIGTERM
  pkill -KILL -f "/opt/WatchTower/watchtower-desktop" 2>/dev/null || true
  sleep 1
  echo "  stopped"
else
  echo "  none running"
fi

step "2/6: clear stale Singleton lock files"
if ls ~/.config/watchtower-desktop/Singleton* >/dev/null 2>&1; then
  rm -f ~/.config/watchtower-desktop/SingletonLock \
        ~/.config/watchtower-desktop/SingletonCookie \
        ~/.config/watchtower-desktop/SingletonSocket
  echo "  cleared"
else
  echo "  no stale locks"
fi

step "3/6: free port 8000 if orphan backend is squatting"
PIDS_8000=$(ss -tlnp 2>/dev/null | awk '/127\.0\.0\.1:8000\>/{ for(i=1;i<=NF;i++) if($i~/pid=/){gsub(/[^0-9]/, "", $i); print $i; exit} }' || true)
if [[ -n "${PIDS_8000:-}" ]]; then
  echo "  killing PID $PIDS_8000 on port 8000"
  kill "$PIDS_8000" 2>/dev/null || true
  sleep 1
  # If it's still alive, force it
  kill -KILL "$PIDS_8000" 2>/dev/null || true
else
  echo "  port 8000 free"
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  step "4/6: resolve install target"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  DEB_ARCH=amd64 ;;
    aarch64) DEB_ARCH=arm64 ;;
    armv7l)  DEB_ARCH=armv7l ;;
    *) echo "unsupported arch: $ARCH"; exit 1 ;;
  esac

  if [[ -n "$PIN_VERSION" ]]; then
    TAG="$PIN_VERSION"
  else
    # /releases/latest is a 302 to /releases/tag/v<X.Y.Z>; pull the tag
    # out of the redirect target. -I is HEAD, -L follows redirects, but
    # we want the FIRST hop's location (which is the resolved tag).
    TAG=$(curl -sI https://github.com/Node2-io/WatchTowerOps/releases/latest \
            | awk -F/ '/^[Ll]ocation:/{print $NF; exit}' | tr -d '\r\n')
  fi
  if [[ -z "$TAG" || ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "  could not resolve tag (got: '$TAG')"; exit 1
  fi
  ASSET="WatchTower-${TAG#v}-linux-${DEB_ARCH}.deb"
  URL="https://github.com/Node2-io/WatchTowerOps/releases/download/${TAG}/${ASSET}"
  echo "  $TAG → $ASSET"

  step "5/6: download + install"
  TMP=$(mktemp /tmp/wt-XXXXXX.deb)
  trap 'rm -f "$TMP"' EXIT
  echo "  downloading $URL"
  curl -fL --retry 3 -o "$TMP" "$URL"
  SIZE_MB=$(( $(stat -c%s "$TMP") / 1048576 ))
  echo "  downloaded ${SIZE_MB} MB → $TMP"

  # ── dpkg-lock pre-flight ─────────────────────────────────────────────
  # aptd (GNOME Software Updater backend) and unattended-upgrades both
  # hold the dpkg frontend lock during their package operations. If
  # we just call `sudo dpkg -i` while one of them is running, dpkg
  # errors out with the unhelpful
  #   "dpkg frontend lock was locked by another process with pid <X>"
  # message and the user has no idea what to do.
  #
  # Detect the lock holder up-front so the user gets actionable copy
  # instead of a raw dpkg complaint. Wait up to 60 s for it to clear
  # on its own — most Software Updater operations finish quickly.
  if [[ -e /var/lib/dpkg/lock-frontend ]]; then
    DEADLINE=$(( $(date +%s) + 60 ))
    while LOCK_PID=$(sudo fuser /var/lib/dpkg/lock-frontend 2>/dev/null | awk '{print $1}'); [[ -n "$LOCK_PID" ]]; do
      LOCK_CMD=$(ps -p "$LOCK_PID" -o comm= 2>/dev/null || echo "?")
      NOW=$(date +%s)
      if [[ "$NOW" -ge "$DEADLINE" ]]; then
        echo
        echo "  ❌ dpkg lock held by PID $LOCK_PID ($LOCK_CMD) — gave up after 60s."
        echo "     Close any open Software Updater / Software Center window,"
        echo "     wait for unattended-upgrades to finish, or run:"
        echo "       sudo kill $LOCK_PID"
        echo "     then re-run this script."
        exit 1
      fi
      printf "\r  ⏳ dpkg lock held by PID %s (%s) — waiting up to %ds..." "$LOCK_PID" "$LOCK_CMD" "$(( DEADLINE - NOW ))"
      sleep 2
    done
    printf "\r  dpkg lock free%-50s\n" ""
  fi

  echo "  installing (sudo will prompt for password)"
  sudo dpkg -i "$TMP"
else
  step "4-5/6: skipping install (--skip-install)"
fi

if [[ "$NO_LAUNCH" -eq 0 ]]; then
  step "6/6: launch"
  if [[ ! -x /opt/WatchTower/watchtower-desktop ]]; then
    echo "  /opt/WatchTower/watchtower-desktop missing — install must have failed"
    exit 1
  fi
  /opt/WatchTower/watchtower-desktop --no-sandbox >/tmp/wt-launch.log 2>&1 &
  disown
  PID=$!
  echo "  launched (PID $PID)"
  echo "  if it doesn't appear within ~10s, check:"
  echo "    tail -30 ~/.watchtower/logs/desktop-electron.log"
  echo "    tail -30 ~/.watchtower/logs/desktop-backend.log"
  echo "    /tmp/wt-launch.log"
else
  step "6/6: skipping launch (--no-launch)"
fi

printf "\n  done\n"
