#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_help() {
  cat <<'EOF'
WatchTower unified installer

Usage:
  ./install_watchtower.sh [--mode appcenter|legacy] [--help]

Modes:
  appcenter  Linux: installs WatchTower App Center as a systemd service (recommended)
             macOS: installs user-space App Center under $HOME/watchtower-appcenter
  legacy     Linux only: uses legacy install.sh flow

Examples:
  ./install_watchtower.sh
  ./install_watchtower.sh --mode appcenter
  ./install_watchtower.sh --mode legacy
EOF
}

MODE="appcenter"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="$2"
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      print_help
      exit 1
      ;;
  esac
done

OS="$(uname -s)"

if [[ "$OS" == "Darwin" ]]; then
  if [[ "$MODE" != "appcenter" ]]; then
    echo "legacy mode is only supported on Linux."
    exit 1
  fi
  exec "${ROOT_DIR}/install_macos.sh"
fi

if [[ "$OS" == "Linux" ]]; then
  if [[ "$MODE" == "legacy" ]]; then
    if [[ "$EUID" -ne 0 ]]; then
      exec sudo "${ROOT_DIR}/install.sh"
    fi
    exec "${ROOT_DIR}/install.sh"
  fi

  if [[ "$EUID" -ne 0 ]]; then
    exec sudo "${ROOT_DIR}/install_app_center.sh"
  fi
  exec "${ROOT_DIR}/install_app_center.sh"
fi

echo "Unsupported operating system: ${OS}"
echo "Windows users: run install_watchtower_windows.cmd"
exit 1
