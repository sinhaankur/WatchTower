#!/usr/bin/env bash
set -euo pipefail

AUTO_INSTALL="false"
AUTO_START="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-install)
      AUTO_INSTALL="true"
      shift
      ;;
    --auto-start)
      AUTO_START="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--auto-install] [--auto-start]"
      exit 1
      ;;
  esac
done

is_ubuntu_like() {
  command -v apt-get >/dev/null 2>&1
}

try_start_services() {
  local started="false"

  if command -v systemctl >/dev/null 2>&1; then
    if command -v docker >/dev/null 2>&1; then
      sudo systemctl start docker >/dev/null 2>&1 && started="true" || true
    fi

    if command -v podman >/dev/null 2>&1; then
      sudo systemctl start podman.socket >/dev/null 2>&1 && started="true" || true
      sudo systemctl start podman >/dev/null 2>&1 && started="true" || true
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    podman machine start >/dev/null 2>&1 && started="true" || true
  fi

  [[ "$started" == "true" ]]
}

runtime_available() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if docker compose ps >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    if docker-compose ps >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

if runtime_available; then
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 && ! command -v podman >/dev/null 2>&1; then
  echo "No container runtime found (Docker/Podman)."

  if [[ "$AUTO_INSTALL" == "true" ]] && is_ubuntu_like && command -v sudo >/dev/null 2>&1; then
    echo "Installing Podman (Ubuntu/Debian) ..."
    sudo apt-get update
    sudo apt-get install -y podman
  else
    echo "Install one of the following and retry:"
    echo "  Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y podman"
    echo "  Docker: https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

if runtime_available; then
  exit 0
fi

echo "Container runtime is installed but not reachable yet."

if [[ "$AUTO_START" == "true" ]]; then
  echo "Attempting to start container services ..."
  try_start_services || true
fi

if runtime_available; then
  exit 0
fi

echo "Please start your container runtime, then run the command again:"
echo "  Docker: sudo systemctl start docker"
echo "  Podman (Linux): sudo systemctl start podman.socket"
echo "  Podman machine: podman machine start"
exit 1
