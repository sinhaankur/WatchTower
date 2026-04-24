#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo ./scripts/install-watchtower-linux-full.sh"
  exit 1
fi

cd "${ROOT_DIR}"

echo "[1/2] Installing PowerShell..."
./scripts/install-powershell-linux.sh

echo "[2/2] Installing WatchTower App Center service..."
./install_app_center.sh

echo
if command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell: $(pwsh --version)"
fi

echo "WatchTower service status:"
systemctl status watchtower-appcenter.service --no-pager -l | head -20 || true

echo
PORT="${WATCHTOWER_PORT:-8000}"
echo "Health check command: curl http://127.0.0.1:${PORT}/health"
