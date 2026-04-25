#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/watchtower-appcenter}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.watchtower}"
PORT="${PORT:-8000}"
REPO_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${INSTALL_DIR}/.venv"
PLIST_LABEL="com.watchtower.appcenter"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"

generate_token() {
  python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
}

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.8+ is required. Install with Homebrew: brew install python"
  exit 1
fi

# ── Detect existing installation ───────────────────────────────────────────────
EXISTING_VERSION="none"
if [[ -x "${VENV_DIR}/bin/python" ]]; then
  EXISTING_VERSION="$("${VENV_DIR}/bin/python" -c \
    "import importlib.metadata; print(importlib.metadata.version('watchtower'))" 2>/dev/null || echo "none")"
fi

if [[ "${EXISTING_VERSION}" != "none" ]]; then
  echo "[install] WatchTower ${EXISTING_VERSION} already installed at ${INSTALL_DIR}."

  # Unload LaunchAgent if it is running so we can replace its files safely.
  if launchctl list "${PLIST_LABEL}" &>/dev/null 2>&1; then
    echo "[install] Stopping running LaunchAgent before update…"
    launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  fi

  echo "[install] Updating in-place — config files in ${CONFIG_DIR} are preserved."
else
  echo "[install] Fresh installation of WatchTower."
fi

mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}"

rsync -a --delete \
  --exclude ".git" \
  --exclude "__pycache__" \
  --exclude ".venv" \
  "${REPO_SOURCE_DIR}/../" "${INSTALL_DIR}/"

python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip -q
"${VENV_DIR}/bin/python" -m pip install "${INSTALL_DIR}" -q

[[ -f "${CONFIG_DIR}/nodes.json" ]] || cp "${INSTALL_DIR}/config/nodes.json" "${CONFIG_DIR}/nodes.json"
[[ -f "${CONFIG_DIR}/apps.json" ]] || cp "${INSTALL_DIR}/config/apps.json" "${CONFIG_DIR}/apps.json"

if [[ ! -f "${CONFIG_DIR}/appcenter.env" ]]; then
  TRIGGER_TOKEN="$(generate_token)"
  cat > "${CONFIG_DIR}/appcenter.env" <<EOF
WATCHTOWER_REPO_DIR=${INSTALL_DIR}
WATCHTOWER_NODES_FILE=${CONFIG_DIR}/nodes.json
WATCHTOWER_APPS_FILE=${CONFIG_DIR}/apps.json
WATCHTOWER_TRIGGER_TOKEN=${TRIGGER_TOKEN}
WATCHTOWER_DEFAULT_BRANCH=main
WATCHTOWER_LOG_LEVEL=INFO
WATCHTOWER_PORT=${PORT}
WATCHTOWER_BIND_HOST=127.0.0.1
EOF
  chmod 600 "${CONFIG_DIR}/appcenter.env"
fi

# Reload LaunchAgent if a plist already existed (auto-start after update).
if [[ -f "${PLIST_PATH}" ]]; then
  launchctl load "${PLIST_PATH}" 2>/dev/null || true
  echo "[install] LaunchAgent reloaded."
fi

NEW_VER="$("${VENV_DIR}/bin/python" -c \
  "import importlib.metadata; print(importlib.metadata.version('watchtower'))" 2>/dev/null || echo "?")"

echo
echo "WatchTower App Center ${NEW_VER} — ready on macOS."
echo "Start with:"
echo "  ./run_app_center_macos.sh"
echo
echo "Health check: curl http://127.0.0.1:${PORT}/health"
