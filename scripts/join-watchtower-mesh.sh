#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.mesh}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy one of the examples and retry:"
  echo "  cp .env.mesh.primary.example .env.mesh"
  echo "  cp .env.mesh.standby.example .env.mesh"
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

mkdir -p "$ROOT_DIR/config/caddy/upstreams" "$ROOT_DIR/config/caddy/previews" "$ROOT_DIR/data/caddy/data" "$ROOT_DIR/data/caddy/config"

echo "Enabling Podman user socket ..."
systemctl --user enable --now podman.socket

if [[ -n "${GH_USERNAME:-}" && -n "${GH_PAT_TOKEN:-}" ]]; then
  echo "Logging in to GHCR ..."
  printf '%s' "$GH_PAT_TOKEN" | podman login ghcr.io -u "$GH_USERNAME" --password-stdin
else
  echo "GHCR credentials are not set in $ENV_FILE."
  echo "Public images can still be pulled without login."
fi

if [[ -n "${MESH_MONGO_SECRET_NAME:-}" ]] && ! podman secret inspect "$MESH_MONGO_SECRET_NAME" >/dev/null 2>&1; then
  echo "Required Podman secret '$MESH_MONGO_SECRET_NAME' does not exist."
  echo "Create it first, for example:"
  echo "  echo 'mongodb+srv://user:pass@cluster.mongodb.net/app?retryWrites=true&w=majority' | podman secret create $MESH_MONGO_SECRET_NAME -"
  exit 1
fi

if [[ ! -f "$ROOT_DIR/config/caddy/upstreams/app.active" ]]; then
  cat > "$ROOT_DIR/config/caddy/upstreams/app.active" <<EOF
reverse_proxy 127.0.0.1:${APP_BLUE_PORT:-18080}
EOF
fi

echo "Starting Caddy and Watchtower mesh services ..."
podman compose -f "$ROOT_DIR/docker-compose.mesh.yml" --env-file "$ENV_FILE" up -d

echo "Performing initial blue-green deployment ..."
"$ROOT_DIR/scripts/mesh-bluegreen-deploy.sh" "$ENV_FILE"

echo
echo "WatchTower Mesh node joined successfully."
echo "  Domain: ${APP_DOMAIN:-unset}"
echo "  Node: ${NODE_NAME:-unknown}"
echo "  Caddy admin: http://127.0.0.1:${CADDY_ADMIN_PORT:-2019}"