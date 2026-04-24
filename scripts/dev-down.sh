#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT_DIR/.dev"
API_PID_FILE="$DEV_DIR/api.pid"
WEB_PID_FILE="$DEV_DIR/web.pid"
COMPOSE_LOG="$DEV_DIR/compose.log"

stop_pid_file() {
  local pid_file="$1"
  local label="$2"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping $label (PID $pid) ..."
      kill "$pid" || true
    fi
    rm -f "$pid_file"
  fi
}

stop_pid_file "$API_PID_FILE" "API"
stop_pid_file "$WEB_PID_FILE" "Web UI"

COMPOSE_CMD=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

if [[ -n "$COMPOSE_CMD" ]]; then
  echo "Stopping PostgreSQL and Redis ..."
  $COMPOSE_CMD -f "$ROOT_DIR/docker-compose.yml" stop postgres redis >"$COMPOSE_LOG" 2>&1 || true
fi

echo "WatchTower local dev stopped."
