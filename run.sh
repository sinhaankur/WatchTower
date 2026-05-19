#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# WatchTower — one-command launcher
#
# Usage:
#   ./run.sh              # interactive: choose desktop or browser, then browser
#   ./run.sh desktop      # Electron desktop app (no prompt)
#   ./run.sh browser      # Browser mode — prompts to pick which browser
#   ./run.sh stop         # Kill all WatchTower processes
#   ./run.sh logs         # Tail backend + frontend logs
#   ./run.sh update       # Pull latest code from GitHub and rebuild
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT=8000
WEB_PORT=5222
VENV="$ROOT/.venv"
LOG_API=/tmp/watchtower-api.log
LOG_WEB=/tmp/watchtower-web.log

# Load .env once for all run modes so desktop/browser share the same local config
# (OAuth credentials, custom API token, etc.). Keep existing shell values if already set.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[WatchTower]${NC} $*"; }
success() { echo -e "${GREEN}[WatchTower]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WatchTower]${NC} $*"; }
error()   { echo -e "${RED}[WatchTower]${NC} $*" >&2; }

# Detect architecture (Raspberry Pi reports aarch64 or armv7l)
ARCH=$(uname -m)
IS_ARM=false
[[ "$ARCH" == aarch64 || "$ARCH" == armv7l || "$ARCH" == armv6l ]] && IS_ARM=true

# Portable TCP listen check — prefers ss (iproute2, always on Pi OS),
# falls back to lsof (macOS, Debian desktop), then netstat.
is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :${port}" 2>/dev/null | grep -q "."
  elif command -v lsof >/dev/null 2>&1; then
    lsof -i ":${port}" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else
    netstat -tln 2>/dev/null | grep -q ":${port} "
  fi
}

# Kill PIDs holding a port — portable across Linux, macOS, Pi OS Lite.
# Priority: fuser (Linux full) → lsof (macOS) → ss+kill (Pi OS Lite / no fuser)
# Uses only POSIX grep (no -P/lookbehind) so it works on BSD grep (macOS).
kill_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    # macOS: lsof -ti returns bare PIDs, one per line
    local pids
    pids=$(lsof -ti tcp:"${port}" 2>/dev/null || true)
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  elif command -v ss >/dev/null 2>&1; then
    # Pi OS Lite (no fuser, no lsof): use ss — POSIX grep only
    local pids
    pids=$(ss -tlnpH "sport = :${port}" 2>/dev/null \
           | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)
    for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  fi
}

# Kill whatever is holding a port — works on Linux, macOS, and Pi OS Lite.
free_port() {
  local port="$1"
  if is_listening "$port"; then
    warn "Port $port is occupied — killing existing process..."
    kill_port "$port"
    sleep 0.5
  fi
}

# ── update ────────────────────────────────────────────────────────────────────
cmd_update() {
  info "Checking for updates..."

  # Must be run from a git checkout
  if [[ ! -d "$ROOT/.git" ]]; then
    error "Not a git repository — cannot self-update. Download the latest release from:"
    echo "  https://github.com/sinhaankur/WatchTower/releases"
    exit 1
  fi

  # Fetch and compare
  git -C "$ROOT" fetch origin main -q
  LOCAL=$(git -C "$ROOT" rev-parse HEAD)
  REMOTE=$(git -C "$ROOT" rev-parse origin/main)

  if [[ "$LOCAL" == "$REMOTE" ]]; then
    success "Already up to date ($(git -C "$ROOT" describe --tags --always 2>/dev/null || echo ${LOCAL:0:8}))."
    exit 0
  fi

  CURRENT_VERSION=$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo "${LOCAL:0:8}")
  NEW_VERSION=$(git -C "$ROOT" describe --tags --always origin/main 2>/dev/null || echo "${REMOTE:0:8}")
  info "Updating from $CURRENT_VERSION → $NEW_VERSION..."

  # Stop running services first
  cmd_stop 2>/dev/null || true

  # Pull latest code
  git -C "$ROOT" pull --ff-only origin main

  # Force dependency reinstall
  rm -f "$VENV/.deps_installed"

  # Recreate venv if Python was upgraded
  if [[ -x "$VENV/bin/python" ]]; then
    "$VENV/bin/pip" install --prefer-binary --upgrade pip -q
    "$VENV/bin/pip" install --prefer-binary -r "$ROOT/requirements.txt" -q
    "$VENV/bin/pip" install -e "$ROOT" -q
    touch "$VENV/.deps_installed"
  fi

  # Rebuild frontend
  info "Rebuilding frontend..."
  npm --prefix "$ROOT/web" install --silent
  npm --prefix "$ROOT/web" run build --silent

  # Update desktop deps if present
  if [[ -d "$ROOT/desktop/node_modules" ]]; then
    npm --prefix "$ROOT/desktop" install --silent
  fi

  success "Update complete! Run ./run.sh to start the updated app."
  exit 0
}


cmd_stop() {
  info "Stopping WatchTower..."
  pkill -f "electron \." 2>/dev/null && info "Electron stopped." || true
  kill_port "$API_PORT" && info "Backend stopped." || true
  kill_port "$WEB_PORT" && info "Frontend stopped." || true
  success "Done."
  exit 0
}

# ── logs ─────────────────────────────────────────────────────────────────────
cmd_logs() {
  info "Tailing logs (Ctrl-C to stop)..."
  tail -f "$LOG_API" "$LOG_WEB" 2>/dev/null || {
    error "No logs found yet. Start the app first."; exit 1; }
}

# ── Browser detection ────────────────────────────────────────────────────────
# Returns a list of browser names that are available on this system.
# Each entry is "label:command" e.g. "Chrome:google-chrome"
detect_browsers() {
  local found=()
  # macOS app bundle names
  if [[ "$(uname)" == "Darwin" ]]; then
    [[ -d "/Applications/Google Chrome.app" ]]        && found+=("Chrome:open -a 'Google Chrome'")
    [[ -d "/Applications/Firefox.app" ]]              && found+=("Firefox:open -a Firefox")
    [[ -d "/Applications/Safari.app" ]]               && found+=("Safari:open -a Safari")
    [[ -d "/Applications/Brave Browser.app" ]]        && found+=("Brave:open -a 'Brave Browser'")
    [[ -d "/Applications/Microsoft Edge.app" ]]       && found+=("Edge:open -a 'Microsoft Edge'")
    [[ -d "/Applications/Arc.app" ]]                  && found+=("Arc:open -a Arc")
  fi
  # Linux / PATH-based commands
  for pair in \
    "Chrome:google-chrome" \
    "Chrome:google-chrome-stable" \
    "Chromium:chromium" \
    "Chromium:chromium-browser" \
    "Firefox:firefox" \
    "Brave:brave-browser" \
    "Edge:microsoft-edge" \
    "Vivaldi:vivaldi" \
    "Opera:opera"
  do
    local cmd="${pair#*:}"
    command -v "$cmd" >/dev/null 2>&1 && found+=("$pair")
  done
  # Always offer the system default as a fallback
  found+=("Default browser:__default__")
  printf '%s\n' "${found[@]}"
}

# Open $1 in the browser identified by a detect_browsers entry.
open_in_browser() {
  local url="$1" entry="$2"
  local cmd="${entry#*:}"
  if [[ "$cmd" == "__default__" ]]; then
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" 2>/dev/null &
    elif command -v open >/dev/null 2>&1; then
      open "$url" &
    fi
  else
    eval "$cmd \"$url\"" 2>/dev/null &
  fi
}

# ── Parse args ───────────────────────────────────────────────────────────────
MODE="${1:-auto}"
case "$MODE" in
  stop)   cmd_stop ;;
  logs)   cmd_logs ;;
  update) cmd_update ;;
  desktop|browser|auto) ;;
  *)
    error "Unknown command: $MODE"
    echo "Usage: $0 [desktop|browser|stop|logs|update]"
    exit 1 ;;
esac

echo ""
echo -e "${CYAN}╔══════════════════════════════════╗${NC}"
echo -e "${CYAN}║       WatchTower Launcher        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Python venv + dependencies ───────────────────────────────────────
if [[ ! -x "$VENV/bin/python" ]]; then
  info "Creating Python virtualenv..."
  python3 -m venv "$VENV"
fi

# Only reinstall if requirements.txt is newer than a sentinel file
SENTINEL="$VENV/.deps_installed"
if [[ ! -f "$SENTINEL" ]] || [[ "$ROOT/requirements.txt" -nt "$SENTINEL" ]]; then
  info "Installing Python dependencies (first run or requirements changed)..."
  # --prefer-binary: use pre-built wheels instead of compiling from source.
  # Critical on ARM (Pi, M1) where C extension compilation often fails or is slow.
  "$VENV/bin/pip" install --prefer-binary --upgrade pip -q
  "$VENV/bin/pip" install --prefer-binary -r "$ROOT/requirements.txt" -q
  # Install the watchtower package itself in editable mode so that
  # `import watchtower` works for both the backend and the test suite.
  "$VENV/bin/pip" install -e "$ROOT" -q
  touch "$SENTINEL"
fi

# Ensure the watchtower package itself is importable (editable install).
# Runs unconditionally — fast no-op when already installed, catches the
# case where the sentinel already exists but pip install -e . was never run.
if ! "$VENV/bin/pip" show watchtower >/dev/null 2>&1; then
  "$VENV/bin/pip" install -e "$ROOT" -q
fi

# ── Step 2: Node deps ─────────────────────────────────────────────────────────
if [[ ! -d "$ROOT/web/node_modules" ]]; then
  info "Installing web dependencies..."
  npm --prefix "$ROOT/web" install --silent
fi

if [[ ! -d "$ROOT/desktop/node_modules" ]] && [[ "$MODE" != "browser" ]]; then
  info "Installing desktop dependencies..."
  npm --prefix "$ROOT/desktop" install --silent
fi

# ── Step 3: Build frontend if dist is missing / stale ────────────────────────
DIST_INDEX="$ROOT/web/dist/index.html"
if [[ ! -f "$DIST_INDEX" ]]; then
  info "Building frontend (first run)..."
  npm --prefix "$ROOT/web" run build --silent
  success "Frontend built."
fi

# ── Resolve mode early (before Step 4) so desktop mode can skip backend start ──
# Global variable: which browser entry the user picked (detect_browsers format)
SELECTED_BROWSER="Default browser:__default__"

if [[ "$MODE" == "auto" ]]; then
  if [[ "$IS_ARM" == true ]]; then
    # Raspberry Pi / ARM: only browser mode makes sense.
    info "ARM detected ($ARCH) — browser mode only on this platform."
    MODE=browser
  else
    # Interactive launcher: let the user choose.
    HAS_ELECTRON=false
    ( command -v electron >/dev/null 2>&1 || [[ -d "$ROOT/desktop/node_modules" ]] ) && HAS_ELECTRON=true

    echo ""
    echo -e "  ${CYAN}How would you like to open WatchTower?${NC}"
    echo ""
    if [[ "$HAS_ELECTRON" == true ]]; then
      echo -e "  ${GREEN}[1]${NC} Desktop app  (Electron window)"
      echo -e "  ${GREEN}[2]${NC} Browser      (opens in your browser)"
    else
      echo -e "  ${GREEN}[1]${NC} Browser      (opens in your browser)"
    fi
    echo ""
    if [[ "$HAS_ELECTRON" == true ]]; then
      read -r -p "  Enter choice [1-2, default 1]: " UI_CHOICE </dev/tty
      UI_CHOICE="$(echo "${UI_CHOICE:-1}" | tr '[:upper:]' '[:lower:]' | xargs)"
      # Accept natural answers too: yes/browser/web, no/desktop/app.
      if [[ "$UI_CHOICE" == "2" || "$UI_CHOICE" == "yes" || "$UI_CHOICE" == "y" || "$UI_CHOICE" == "browser" || "$UI_CHOICE" == "web" ]]; then
        MODE=browser
      elif [[ "$UI_CHOICE" == "1" || "$UI_CHOICE" == "no" || "$UI_CHOICE" == "n" || "$UI_CHOICE" == "desktop" || "$UI_CHOICE" == "app" ]]; then
        MODE=desktop
      else
        warn "Unrecognized choice '$UI_CHOICE' — defaulting to Desktop (1)."
        MODE=desktop
      fi
    else
      read -r -p "  Press Enter to open in browser (or Ctrl-C to cancel): " </dev/tty || true
      MODE=browser
    fi
  fi
fi

# If browser mode, also ask which browser to use.
if [[ "$MODE" == "browser" ]]; then
  BROWSER_ENTRIES=()
  while IFS= read -r entry; do
    [[ -n "$entry" ]] && BROWSER_ENTRIES+=("$entry")
  done < <(detect_browsers)
  if [[ ${#BROWSER_ENTRIES[@]} -gt 1 ]]; then
    echo ""
    echo -e "  ${CYAN}Choose a browser:${NC}"
    echo ""
    for i in "${!BROWSER_ENTRIES[@]}"; do
      label="${BROWSER_ENTRIES[$i]%%:*}"
      echo -e "  ${GREEN}[$((i+1))]${NC} $label"
    done
    echo ""
    read -r -p "  Enter choice [1-${#BROWSER_ENTRIES[@]}, default 1]: " BROWSER_CHOICE </dev/tty
    BROWSER_CHOICE="${BROWSER_CHOICE:-1}"
    # Validate; fall back to 1 on bad input.
    if ! [[ "$BROWSER_CHOICE" =~ ^[0-9]+$ ]] || \
       (( BROWSER_CHOICE < 1 || BROWSER_CHOICE > ${#BROWSER_ENTRIES[@]} )); then
      BROWSER_CHOICE=1
    fi
    SELECTED_BROWSER="${BROWSER_ENTRIES[$((BROWSER_CHOICE-1))]}"
    info "Opening with: ${SELECTED_BROWSER%%:*}"
  fi
fi

# ── Step 4: Start backend ────────────────────────────────────────────────────
# In desktop mode, Electron manages the backend itself (with its own API token
# for auto-login). Skip here so Electron can own the process from the start.
if [[ "$MODE" != "desktop" ]] && ! is_listening "$API_PORT"; then
  free_port "$API_PORT"
  info "Starting backend on 127.0.0.1:$API_PORT..."
  WATCHTOWER_ALLOW_INSECURE_DEV_AUTH="${WATCHTOWER_ALLOW_INSECURE_DEV_AUTH:-true}" \
    "$VENV/bin/python" -m uvicorn watchtower.api:app \
      --app-dir "$ROOT" --host 127.0.0.1 --port "$API_PORT" \
      --no-access-log --timeout-keep-alive 5 \
      >"$LOG_API" 2>&1 &
  # Wait up to 15 s for it to be ready
  for i in $(seq 1 30); do
    is_listening "$API_PORT" && break
    sleep 0.5
  done
  is_listening "$API_PORT" || { error "Backend failed to start. Check: $LOG_API"; exit 1; }
  success "Backend ready."
elif [[ "$MODE" == "desktop" ]]; then
  # Desktop mode: Electron will start (and own) the backend with its own API token.
  # Killing any stale backend now so Electron gets a clean port.
  if is_listening "$API_PORT"; then
    info "Stopping existing backend so Electron can own it..."
    free_port "$API_PORT"
  fi
else
  success "Backend already running on port $API_PORT."
fi

# ── Step 5: Launch UI ────────────────────────────────────────────────────────
# (Mode already resolved above before Step 4)

if [[ "$MODE" == "desktop" ]]; then
  info "Launching Electron desktop app..."
  # Kill any stale Electron instance first
  pkill -f "electron \." 2>/dev/null || true
  sleep 0.3
  # npm run desktop uses the built-in static server — fast startup
  npm --prefix "$ROOT" run desktop >"$LOG_WEB" 2>&1 &
  success "Desktop app launched."

elif [[ "$MODE" == "browser" ]]; then
  # The backend (port 8000) now serves both the API and the React SPA.
  # No separate static server needed — opening port 8000 directly avoids
  # cross-origin issues where /api calls would 404 on a plain file server.
  success "Frontend served by backend."
  echo ""
  echo -e "  ${GREEN}Open in your browser:${NC}  http://127.0.0.1:${API_PORT}"
  echo ""
  open_in_browser "http://127.0.0.1:${API_PORT}" "$SELECTED_BROWSER"
fi

echo ""
echo -e "  ${CYAN}API health:${NC}  http://127.0.0.1:${API_PORT}/health"
echo -e "  ${CYAN}Logs:${NC}        $LOG_API  |  $LOG_WEB"
echo -e "  ${CYAN}Stop:${NC}        ./run.sh stop"
echo ""
