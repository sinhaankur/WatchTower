#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.ha}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy one of the examples and retry:"
  echo "  cp .env.ha.primary.example .env.ha"
  echo "  cp .env.ha.standby.example .env.ha"
  exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman is required but not installed."
  echo "Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y podman podman-compose"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "Enabling Podman user socket ..."
systemctl --user enable --now podman.socket

if [[ -n "${GH_USERNAME:-}" && -n "${GH_PAT_TOKEN:-}" ]]; then
  echo "Logging in to GHCR ..."
  printf '%s' "$GH_PAT_TOKEN" | podman login ghcr.io -u "$GH_USERNAME" --password-stdin
else
  echo "GHCR credentials are not set in $ENV_FILE."
  echo "Public images can still be pulled without login."
fi

echo "Starting HA stack for ${NODE_NAME:-unknown-node} ..."
podman compose -f "$ROOT_DIR/docker-compose.ha.yml" --env-file "$ENV_FILE" up -d

echo
echo "HA stack started for ${NODE_NAME:-unknown-node}."
echo "  App: http://${NODE_TAILSCALE_IP:-127.0.0.1}:${APP_PORT:-8080}"
echo "  DB role: ${POSTGRESQL_REPLICATION_MODE:-master}"
echo "  Replication primary: ${POSTGRESQL_MASTER_HOST:-unset}"
