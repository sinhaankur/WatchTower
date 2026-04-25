#!/usr/bin/env bash
set -euo pipefail

APP_USER="watchtower"
APP_GROUP="watchtower"
INSTALL_DIR="/opt/watchtower"
VENV_DIR="${INSTALL_DIR}/.venv"
SERVICE_NAME="watchtower-appcenter"
REPO_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run as root: sudo ./install_app_center.sh"
    exit 1
  fi
}

ensure_user_group() {
  if ! getent group "${APP_GROUP}" >/dev/null; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --gid "${APP_GROUP}" --shell /usr/sbin/nologin "${APP_USER}"
  fi
}

install_dependencies() {
  apt-get update
  apt-get install -y python3 python3-venv git rsync openssh-client
}

install_app() {
  mkdir -p "${INSTALL_DIR}"
  rsync -a --delete \
    --exclude ".git" \
    --exclude "__pycache__" \
    --exclude ".venv" \
    "${REPO_SOURCE_DIR}/" "${INSTALL_DIR}/"

  python3 -m venv "${VENV_DIR}"
  "${VENV_DIR}/bin/pip" install --upgrade pip
  "${VENV_DIR}/bin/pip" install "${INSTALL_DIR}"

  mkdir -p /etc/watchtower
  if [[ ! -f /etc/watchtower/nodes.json ]]; then
    cp "${INSTALL_DIR}/config/nodes.json" /etc/watchtower/nodes.json
  fi
  if [[ ! -f /etc/watchtower/apps.json ]]; then
    cp "${INSTALL_DIR}/config/apps.json" /etc/watchtower/apps.json
  fi
  if [[ ! -f /etc/watchtower/appcenter.env ]]; then
    cat > /etc/watchtower/appcenter.env <<'EOF'
WATCHTOWER_REPO_DIR=/opt/apps/website-main
WATCHTOWER_NODES_FILE=/etc/watchtower/nodes.json
WATCHTOWER_APPS_FILE=/etc/watchtower/apps.json
WATCHTOWER_TRIGGER_TOKEN=change-me-now
WATCHTOWER_DEFAULT_BRANCH=main
WATCHTOWER_LOG_LEVEL=INFO
EOF
  fi

  chown -R "${APP_USER}:${APP_GROUP}" "${INSTALL_DIR}" /etc/watchtower
}

install_service() {
  cp "${INSTALL_DIR}/systemd/watchtower-appcenter.service" \
    "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"
}

print_next_steps() {
  echo
  echo "WatchTower App Center installed."
  echo "Service: ${SERVICE_NAME}.service"
  echo "Edit config files:" 
  echo "  /etc/watchtower/nodes.json"
  echo "  /etc/watchtower/apps.json"
  echo "  /etc/watchtower/appcenter.env"
  echo
  echo "Check status: systemctl status ${SERVICE_NAME}.service"
  echo "API health:   curl http://<server-ip>:8000/health"
}

main() {
  require_root
  ensure_user_group
  install_dependencies
  install_app
  install_service
  print_next_steps
}

main "$@"
