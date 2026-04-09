#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/watchtower-appcenter}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.watchtower}"
VENV_PYTHON="${INSTALL_DIR}/.venv/bin/python"
ENV_FILE="${CONFIG_DIR}/appcenter.env"

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "WatchTower is not installed in ${INSTALL_DIR}. Run ./install_macos.sh first."
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Run ./install_macos.sh first."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

PORT="${WATCHTOWER_PORT:-8000}"

exec "${VENV_PYTHON}" -m watchtower.deploy_server serve --host 0.0.0.0 --port "${PORT}"
