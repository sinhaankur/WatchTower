#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT_DIR/.dev"
VENV_DIR="$ROOT_DIR/.venv"
API_LOG="$DEV_DIR/api.log"
WEB_LOG="$DEV_DIR/web.log"
COMPOSE_LOG="$DEV_DIR/compose.log"
API_PID_FILE="$DEV_DIR/api.pid"
WEB_PID_FILE="$DEV_DIR/web.pid"

mkdir -p "$DEV_DIR"

cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not installed."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but not installed."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not installed."
  exit 1
fi

install_python_prereqs() {
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    echo "Attempting to install Python prerequisites (python3-pip, python3-venv) ..."
    sudo apt-get update >/dev/null || return 1
    sudo apt-get install -y python3-pip python3-venv >/dev/null || return 1
    return 0
  fi
  return 1
}

COMPOSE_CMD=""
USE_POSTGRES="false"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

if [[ -n "$COMPOSE_CMD" ]]; then
  echo "Starting PostgreSQL and Redis with $COMPOSE_CMD ..."
  if $COMPOSE_CMD -f "$ROOT_DIR/docker-compose.yml" up -d postgres redis >"$COMPOSE_LOG" 2>&1; then
    USE_POSTGRES="true"
  else
    echo "Could not start container services. Falling back to SQLite mode."
    echo "Compose details: $COMPOSE_LOG"
  fi
else
  echo "Docker Compose not found. Continuing without containers (SQLite mode)."
fi

PYTHON_BIN=""
PIP_BIN=""

if [[ ! -d "$VENV_DIR" || ! -f "$VENV_DIR/bin/activate" ]]; then
  echo "Creating Python virtual environment..."
  rm -rf "$VENV_DIR"
  if ! python3 -m venv "$VENV_DIR"; then
    echo "Could not create virtual environment (python3-venv may be missing)."
    if install_python_prereqs; then
      echo "Retrying virtual environment creation..."
      rm -rf "$VENV_DIR"
      python3 -m venv "$VENV_DIR" || true
    else
      echo "Falling back to system Python."
    fi
  fi
fi

if [[ -f "$VENV_DIR/bin/activate" ]] && "$VENV_DIR/bin/python" -m pip --version >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  PYTHON_BIN="$VENV_DIR/bin/python"
  PIP_BIN="$VENV_DIR/bin/pip"
else
  PYTHON_BIN="python3"
  PIP_BIN="python3 -m pip"
fi

if ! $PIP_BIN --version >/dev/null 2>&1; then
  if install_python_prereqs; then
    if [[ "$PIP_BIN" != "python3 -m pip" ]] && ! $PIP_BIN --version >/dev/null 2>&1; then
      PIP_BIN="python3 -m pip"
      PYTHON_BIN="python3"
    fi
  fi

  if ! $PIP_BIN --version >/dev/null 2>&1; then
    echo "pip is not available for the selected Python interpreter."
    echo "Install pip (for example: sudo apt install python3-pip) and try again."
    exit 1
  fi
fi

$PIP_BIN install --upgrade pip >/dev/null
$PIP_BIN install -r "$ROOT_DIR/requirements-new.txt" >/dev/null

if [[ ! -d "$ROOT_DIR/web/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  npm --prefix "$ROOT_DIR/web" install --legacy-peer-deps >/dev/null
fi

if [[ -f "$API_PID_FILE" ]] && kill -0 "$(cat "$API_PID_FILE")" 2>/dev/null; then
  echo "API already running (PID $(cat "$API_PID_FILE"))."
else
  echo "Starting API on http://127.0.0.1:8000 ..."
  API_DATABASE_URL="sqlite:///$ROOT_DIR/watchtower.db"
  if [[ "$USE_POSTGRES" == "true" ]]; then
    API_DATABASE_URL="postgresql://watchtower:watchtower-dev@127.0.0.1:5432/watchtower"
  fi

  DATABASE_URL="$API_DATABASE_URL" \
    CORS_ORIGINS="http://127.0.0.1:5173,http://localhost:5173,http://localhost:3000" \
    nohup "$PYTHON_BIN" -m uvicorn watchtower.api:app --host 127.0.0.1 --port 8000 >"$API_LOG" 2>&1 &
  echo $! > "$API_PID_FILE"
fi

if [[ -f "$WEB_PID_FILE" ]] && kill -0 "$(cat "$WEB_PID_FILE")" 2>/dev/null; then
  echo "Web UI already running (PID $(cat "$WEB_PID_FILE"))."
else
  echo "Starting Web UI on http://127.0.0.1:5173 ..."
  nohup npm --prefix "$ROOT_DIR/web" run dev -- --host 127.0.0.1 --port 5173 >"$WEB_LOG" 2>&1 &
  echo $! > "$WEB_PID_FILE"
fi

sleep 2

echo
echo "WatchTower local dev is starting:"
echo "  UI:  http://127.0.0.1:5173"
echo "  API: http://127.0.0.1:8000"
echo "  API health: http://127.0.0.1:8000/health"
echo
echo "Logs:"
echo "  API: $API_LOG"
echo "  Web: $WEB_LOG"
echo
echo "Stop everything with: ./scripts/dev-down.sh"
