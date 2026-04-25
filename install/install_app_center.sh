#!/usr/bin/env bash
set -euo pipefail

APP_USER="watchtower"
APP_GROUP="watchtower"
INSTALL_DIR="/opt/watchtower"
VENV_DIR="${INSTALL_DIR}/.venv"
SERVICE_NAME="watchtower-appcenter"
REPO_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Helpers ────────────────────────────────────────────────────────────────────

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run as root: sudo ./install_app_center.sh"
    exit 1
  fi
}

# Returns the installed version string, or "none" if not installed.
installed_version() {
  if [[ -x "${VENV_DIR}/bin/python" ]]; then
    "${VENV_DIR}/bin/python" -c \
      "import importlib.metadata; print(importlib.metadata.version('watchtower'))" 2>/dev/null \
      || echo "none"
  else
    echo "none"
  fi
}

# Returns the version that is about to be installed from the source tree.
incoming_version() {
  python3 -c \
    "import tomllib, pathlib; d=tomllib.loads(pathlib.Path('${REPO_SOURCE_DIR}/../pyproject.toml').read_text()); print(d['project']['version'])" \
    2>/dev/null \
    || python3 -c \
      "import re, pathlib; m=re.search(r'version\\s*=\\s*[\"\\x27]([^\"\\x27]+)[\"\\x27]', pathlib.Path('${REPO_SOURCE_DIR}/../pyproject.toml').read_text()); print(m.group(1) if m else 'unknown')" \
      2>/dev/null \
    || echo "unknown"
}

# ── Detect existing installation ───────────────────────────────────────────────

detect_existing() {
  local existing
  existing="$(installed_version)"

  if [[ "${existing}" == "none" ]]; then
    echo "[install] Fresh installation detected."
    return
  fi

  local incoming
  incoming="$(incoming_version)"
  echo "[install] WatchTower ${existing} is already installed."
  echo "[install] Incoming version: ${incoming}"

  # Stop the service before touching files so rsync doesn't race with uvicorn.
  if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    echo "[install] Stopping existing service before update…"
    systemctl stop "${SERVICE_NAME}.service" || true
  fi

  echo "[install] Existing installation will be updated in-place."
  echo "[install] Config files in /etc/watchtower/ are preserved."
}

# ── Install steps ──────────────────────────────────────────────────────────────

ensure_user_group() {
  if ! getent group "${APP_GROUP}" >/dev/null; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --gid "${APP_GROUP}" --shell /usr/sbin/nologin "${APP_USER}"
  fi
}

install_dependencies() {
  apt-get update -q
  apt-get install -y python3 python3-venv git rsync openssh-client
}

install_app() {
  mkdir -p "${INSTALL_DIR}"

  # Sync application files; config preserved because rsync only touches INSTALL_DIR.
  rsync -a --delete \
    --exclude ".git" \
    --exclude "__pycache__" \
    --exclude ".venv" \
    "${REPO_SOURCE_DIR}/../" "${INSTALL_DIR}/"

  # Recreate venv to pick up any new dependencies cleanly.
  python3 -m venv "${VENV_DIR}"
  "${VENV_DIR}/bin/pip" install --upgrade pip -q
  "${VENV_DIR}/bin/pip" install "${INSTALL_DIR}" -q

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
  local new_ver
  new_ver="$(installed_version)"
  echo
  echo "WatchTower App Center ${new_ver} — ready."
  echo "Service: ${SERVICE_NAME}.service"
  echo
  echo "Config files:"
  echo "  /etc/watchtower/nodes.json"
  echo "  /etc/watchtower/apps.json"
  echo "  /etc/watchtower/appcenter.env"
  echo
  echo "Check status : systemctl status ${SERVICE_NAME}.service"
  echo "API health   : curl http://<server-ip>:8000/health"
}

# ── Entry point ────────────────────────────────────────────────────────────────

main() {
  require_root
  detect_existing   # stop old service if present; print version info
  ensure_user_group
  install_dependencies
  install_app
  install_service
  print_next_steps
}

main "$@"
