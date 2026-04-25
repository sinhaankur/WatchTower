#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="127.0.0.1"
API_PORT="8000"
WEB_HOST="127.0.0.1"
WEB_PORT="5222"

is_listening() {
  local port="$1"
  lsof -i ":${port}" -sTCP:LISTEN -n -P >/dev/null 2>&1
}

echo "[WatchTower] Starting local app..."

cd "${ROOT_DIR}"

if ! is_listening "${API_PORT}"; then
  echo "[WatchTower] Starting backend on ${API_HOST}:${API_PORT}"
  if [[ ! -x "${ROOT_DIR}/.venv/bin/python" ]]; then
    echo "[WatchTower] Creating backend virtualenv..."
    python3 -m venv .venv
    ./.venv/bin/pip install --upgrade pip
    ./.venv/bin/pip install -r requirements.txt
  fi
  WATCHTOWER_ALLOW_INSECURE_DEV_AUTH=true \
    ./.venv/bin/python -m uvicorn watchtower.api:app --app-dir "${ROOT_DIR}" --host "${API_HOST}" --port "${API_PORT}" >/tmp/watchtower-api.log 2>&1 &
fi

if ! is_listening "${WEB_PORT}"; then
  echo "[WatchTower] Starting frontend on ${WEB_HOST}:${WEB_PORT}"
  npm --prefix web install >/tmp/watchtower-web-install.log 2>&1 || true
  npm --prefix web run dev -- --host "${WEB_HOST}" --port "${WEB_PORT}" --strictPort >/tmp/watchtower-web.log 2>&1 &
fi

echo "[WatchTower] Waiting for services..."
sleep 3

if ! is_listening "${API_PORT}"; then
  echo "[WatchTower] Backend failed. Check: /tmp/watchtower-api.log"
  exit 1
fi

if ! is_listening "${WEB_PORT}"; then
  echo "[WatchTower] Frontend failed. Check: /tmp/watchtower-web.log"
  exit 1
fi

echo ""
echo "WatchTower is running"
echo "- UI:  http://${WEB_HOST}:${WEB_PORT}"
echo "- API: http://${API_HOST}:${API_PORT}/health"
echo ""
echo "Logs:"
echo "- Backend:  /tmp/watchtower-api.log"
echo "- Frontend: /tmp/watchtower-web.log"

# Open the UI in the default browser
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://${WEB_HOST}:${WEB_PORT}" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "http://${WEB_HOST}:${WEB_PORT}"
fi
