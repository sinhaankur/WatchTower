#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/watchtower-appcenter}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.watchtower}"
PORT="${PORT:-8000}"
REPO_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${INSTALL_DIR}/.venv"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.8+ is required. Install with Homebrew: brew install python"
  exit 1
fi

mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}"

rsync -a --delete \
  --exclude ".git" \
  --exclude "__pycache__" \
  --exclude ".venv" \
  "${REPO_SOURCE_DIR}/" "${INSTALL_DIR}/"

python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip
"${VENV_DIR}/bin/python" -m pip install "${INSTALL_DIR}"

[[ -f "${CONFIG_DIR}/nodes.json" ]] || cp "${INSTALL_DIR}/nodes.json" "${CONFIG_DIR}/nodes.json"
[[ -f "${CONFIG_DIR}/apps.json" ]] || cp "${INSTALL_DIR}/apps.json" "${CONFIG_DIR}/apps.json"

if [[ ! -f "${CONFIG_DIR}/appcenter.env" ]]; then
  cat > "${CONFIG_DIR}/appcenter.env" <<EOF
WATCHTOWER_REPO_DIR=${INSTALL_DIR}
WATCHTOWER_NODES_FILE=${CONFIG_DIR}/nodes.json
WATCHTOWER_APPS_FILE=${CONFIG_DIR}/apps.json
WATCHTOWER_TRIGGER_TOKEN=change-me-now
WATCHTOWER_DEFAULT_BRANCH=main
WATCHTOWER_LOG_LEVEL=INFO
WATCHTOWER_PORT=${PORT}
EOF
fi

echo
echo "WatchTower App Center installed on macOS."
echo "Start with:"
echo "  ./run_app_center_macos.sh"
echo
echo "Health check: curl http://127.0.0.1:${PORT}/health"
