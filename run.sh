#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# WatchTower — one-command launcher
#
# Usage:
#   ./run.sh              # auto-detect: desktop app if DISPLAY, else browser
#   ./run.sh desktop      # Electron desktop app
#   ./run.sh browser      # Browser (http://127.0.0.1:5222)
#   ./run.sh stop         # Kill all WatchTower processes
#   ./run.sh logs         # Tail backend + frontend logs
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT=8000
WEB_PORT=5222
VENV="$ROOT/.venv"
LOG_API=/tmp/watchtower-api.log
LOG_WEB=/tmp/watchtower-web.log

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

# Kill whatever is holding a port — works without fuser (not on Pi OS Lite)
free_port() {
  local port="$1"
  if is_listening "$port"; then
    warn "Port $port is occupied — killing existing process..."
    # Try fuser first (Debian full), fall back to ss+kill (Pi OS Lite)
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" 2>/dev/null || true
    else
      local pids
      pids=$(ss -tlnpH "sport = :${port}" 2>/dev/null \
             | grep -oP 'pid=\K[0-9]+' || true)
      for pid in $pids; do
        kill "$pid" 2>/dev/null || true
      done
    fi
    sleep 0.5
  fi
}

# ── stop ─────────────────────────────────────────────────────────────────────
cmd_stop() {
  info "Stopping WatchTower..."
  pkill -f "electron \." 2>/dev/null && info "Electron stopped." || true
  fuser -k "${API_PORT}/tcp" 2>/dev/null && info "Backend stopped." || true
  fuser -k "${WEB_PORT}/tcp" 2>/dev/null && info "Frontend stopped." || true
  success "Done."
  exit 0
}

# ── logs ─────────────────────────────────────────────────────────────────────
cmd_logs() {
  info "Tailing logs (Ctrl-C to stop)..."
  tail -f "$LOG_API" "$LOG_WEB" 2>/dev/null || {
    error "No logs found yet. Start the app first."; exit 1; }
}

# ── Parse args ───────────────────────────────────────────────────────────────
MODE="${1:-auto}"
case "$MODE" in
  stop)  cmd_stop ;;
  logs)  cmd_logs ;;
  desktop|browser|auto) ;;
  *)
    error "Unknown command: $MODE"
    echo "Usage: $0 [desktop|browser|stop|logs]"
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
  "$VENV/bin/pip" install --upgrade pip -q
  "$VENV/bin/pip" install -r "$ROOT/requirements.txt" -q
  touch "$SENTINEL"
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

# ── Step 4: Start backend ────────────────────────────────────────────────────
if ! is_listening "$API_PORT"; then
  free_port "$API_PORT"
  info "Starting backend on 127.0.0.1:$API_PORT..."
  # Load .env if present (non-secret dev config only)
  if [[ -f "$ROOT/.env" ]]; then
    set -a; source "$ROOT/.env"; set +a
  fi
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
else
  success "Backend already running on port $API_PORT."
fi

# ── Step 5: Launch UI ────────────────────────────────────────────────────────
# Detect best mode if auto
if [[ "$MODE" == "auto" ]]; then
  if [[ "$IS_ARM" == true ]]; then
    # Raspberry Pi / ARM: default to browser mode.
    # Electron can run on Pi 4/5 (arm64) but requires ~500 MB RAM and a
    # connected display. Browser mode works on any Pi with just the backend.
    # Override with: ./run.sh desktop
    info "ARM detected ($ARCH) — defaulting to browser mode."
    info "To run the desktop app instead: ./run.sh desktop"
    MODE=browser
  elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && \
       ( command -v electron >/dev/null 2>&1 || [[ -d "$ROOT/desktop/node_modules" ]] ); then
    MODE=desktop
  else
    MODE=browser
  fi
fi

if [[ "$MODE" == "desktop" ]]; then
  info "Launching Electron desktop app..."
  # Kill any stale Electron instance first
  pkill -f "electron \." 2>/dev/null || true
  sleep 0.3
  # npm run desktop uses the built-in static server — fast startup
  npm --prefix "$ROOT" run desktop >/dev/null 2>&1 &
  success "Desktop app launched."

elif [[ "$MODE" == "browser" ]]; then
  free_port "$WEB_PORT"
  info "Starting static frontend server on 127.0.0.1:$WEB_PORT..."
  # Serve web/dist with a tiny Python HTTP server + show the URL
  "$VENV/bin/python" -m http.server "$WEB_PORT" \
    --bind 127.0.0.1 \
    --directory "$ROOT/web/dist" \
    >"$LOG_WEB" 2>&1 &
  for i in $(seq 1 20); do
    is_listening "$WEB_PORT" && break
    sleep 0.5
  done
  is_listening "$WEB_PORT" || { error "Frontend failed to start. Check: $LOG_WEB"; exit 1; }
  success "Frontend ready."
  echo ""
  echo -e "  ${GREEN}Open in your browser:${NC}  http://127.0.0.1:${WEB_PORT}"
  echo ""
  # Open browser
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://127.0.0.1:${WEB_PORT}" 2>/dev/null &
  elif command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:${WEB_PORT}" &
  fi
fi

echo ""
echo -e "  ${CYAN}API health:${NC}  http://127.0.0.1:${API_PORT}/health"
echo -e "  ${CYAN}Logs:${NC}        $LOG_API  |  $LOG_WEB"
echo -e "  ${CYAN}Stop:${NC}        ./run.sh stop"
echo ""
