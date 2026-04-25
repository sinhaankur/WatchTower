#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.mesh}"
IMAGE_REF_OVERRIDE="${2:-}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy one of the examples and retry:"
  echo "  cp .env.mesh.primary.example .env.mesh"
  echo "  cp .env.mesh.standby.example .env.mesh"
  exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman is required but not installed."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p "$ROOT_DIR/.mesh" "$ROOT_DIR/config/caddy/upstreams" "$ROOT_DIR/config/caddy/previews"

active_slot_file="$ROOT_DIR/.mesh/active-slot"
current_slot=""
if [[ -f "$active_slot_file" ]]; then
  current_slot="$(cat "$active_slot_file")"
fi

if [[ "$current_slot" == "blue" ]]; then
  next_slot="green"
  next_port="${APP_GREEN_PORT:-18081}"
  old_port="${APP_BLUE_PORT:-18080}"
else
  next_slot="blue"
  next_port="${APP_BLUE_PORT:-18080}"
  old_port="${APP_GREEN_PORT:-18081}"
fi

container_name="wt-mesh-${NODE_NAME:-node}-${next_slot}"
old_container_name=""
if [[ -n "$current_slot" ]]; then
  old_container_name="wt-mesh-${NODE_NAME:-node}-${current_slot}"
fi

image_ref="$APP_IMAGE"
if [[ -n "$IMAGE_REF_OVERRIDE" ]]; then
  image_ref="$IMAGE_REF_OVERRIDE"
fi

echo "Pulling image $image_ref ..."
podman pull "$image_ref"

podman rm -f "$container_name" >/dev/null 2>&1 || true

run_args=(
  run -d
  --name "$container_name"
  --restart always
  --label com.centurylinklabs.watchtower.enable=false
  -p "127.0.0.1:${next_port}:${APP_CONTAINER_PORT:-8000}"
  -e "NODE_ENV=${NODE_ENV:-production}"
  -e "MONGODB_URI_FILE=${MONGODB_URI_FILE:-}"
  -e "DATABASE_URL_FILE=${DATABASE_URL_FILE:-}"
  -e "WATCHTOWER_API_TOKEN=${WATCHTOWER_API_TOKEN:-}"
  -e "WATCHTOWER_SECRET_KEY=${WATCHTOWER_SECRET_KEY:-}"
  -e "ATLAS_APP_NAME=${ATLAS_APP_NAME:-watchtower-mesh}"
  -e "MONGO_MAX_POOL_SIZE=${MONGO_MAX_POOL_SIZE:-}"
  -e "MONGO_MIN_POOL_SIZE=${MONGO_MIN_POOL_SIZE:-}"
  -e "MONGO_MAX_IDLE_TIME_MS=${MONGO_MAX_IDLE_TIME_MS:-}"
  -e "MONGO_CONNECT_TIMEOUT_MS=${MONGO_CONNECT_TIMEOUT_MS:-}"
  -e "MONGO_SOCKET_TIMEOUT_MS=${MONGO_SOCKET_TIMEOUT_MS:-}"
  -e "MONGO_SERVER_SELECTION_TIMEOUT_MS=${MONGO_SERVER_SELECTION_TIMEOUT_MS:-}"
)

if [[ -n "${MESH_MONGO_SECRET_NAME:-}" ]]; then
  run_args+=( --secret "${MESH_MONGO_SECRET_NAME},type=mount,target=mongo_uri" )
fi

if [[ -n "${MESH_DATABASE_URL_SECRET_NAME:-}" ]]; then
  run_args+=( --secret "${MESH_DATABASE_URL_SECRET_NAME},type=mount,target=database_url" )
fi

echo "Starting $container_name on port $next_port ..."
podman "${run_args[@]}" "$image_ref"

health_url="http://127.0.0.1:${next_port}${HEALTHCHECK_PATH:-/health}"
timeout_seconds="${HEALTHCHECK_TIMEOUT_SECONDS:-90}"
deadline=$((SECONDS + timeout_seconds))

echo "Waiting for health check: $health_url"
until curl -fsS "$health_url" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "New slot failed health check before timeout."
    podman logs "$container_name" --tail 100 || true
    podman rm -f "$container_name" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 2
done

cat > "$ROOT_DIR/config/caddy/upstreams/app.active" <<EOF
reverse_proxy 127.0.0.1:${next_port}
EOF

echo "Reloading Caddy ..."
podman exec "wt-caddy-${NODE_NAME:-node}" caddy reload --config /etc/caddy/Caddyfile

echo "$next_slot" > "$active_slot_file"
echo "$image_ref" > "$ROOT_DIR/.mesh/current-image"

if [[ -n "$old_container_name" ]]; then
  sleep "${CUTOVER_GRACE_SECONDS:-5}"
  echo "Stopping previous slot $old_container_name ..."
  podman rm -f "$old_container_name" >/dev/null 2>&1 || true
fi

echo "Blue-green deployment completed. Active slot: $next_slot"
echo "  Active image: $image_ref"
echo "  Route: ${APP_DOMAIN:-localhost} -> 127.0.0.1:${next_port}"