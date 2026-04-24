#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.watchtower}"

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman is not installed."
  echo "Install on Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y podman"
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

echo "Enabling Podman socket for Watchtower ..."
systemctl --user enable --now podman.socket

if [[ -z "${GH_USERNAME:-}" ]]; then
  read -rp "GHCR username: " GH_USERNAME
fi

if [[ -z "${GH_PAT_TOKEN:-}" ]]; then
  read -rsp "GHCR token (read:packages): " GH_PAT_TOKEN
  echo
fi

echo "Logging in to GHCR with Podman ..."
printf '%s' "$GH_PAT_TOKEN" | podman login ghcr.io -u "$GH_USERNAME" --password-stdin

echo "Starting DIY Vercel-like stack ..."
podman compose -f "$ROOT_DIR/docker-compose.vercel-like.yml" --env-file "$ENV_FILE" up -d

echo
echo "Stack started."
echo "  App: http://127.0.0.1:${APP_PORT:-3000}"
echo "  Poll interval: ${WATCHTOWER_POLL_INTERVAL:-30}s"
