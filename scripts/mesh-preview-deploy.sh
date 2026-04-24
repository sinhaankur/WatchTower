#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.mesh}"
BRANCH_NAME="${2:-}"

if [[ -z "$BRANCH_NAME" ]]; then
  echo "Usage: $0 [env-file] <branch-name-or-tag>"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman is required but not installed."
  exit 1
fi

if [[ -z "${PREVIEW_BASE_DOMAIN:-}" ]]; then
  echo "PREVIEW_BASE_DOMAIN is not set in $ENV_FILE."
  exit 1
fi

slug="$(printf '%s' "$BRANCH_NAME" | tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]#-#g' | sed 's#--*#-#g' | sed 's#^-##; s#-$##')"
if [[ -z "$slug" ]]; then
  echo "Could not derive a preview slug from '$BRANCH_NAME'."
  exit 1
fi

base_image="${APP_IMAGE%%@*}"
if [[ "$base_image" == *:* && "${base_image##*/}" != *:* ]]; then
  image_repo="$base_image"
else
  image_repo="${base_image%:*}"
fi
image_ref="${image_repo}:${slug}"

port_offset="$(printf '%s' "$slug" | cksum | awk '{print $1 % 1000}')"
preview_port="$(( ${PREVIEW_PORT_BASE:-19000} + port_offset ))"
container_name="wt-preview-${NODE_NAME:-node}-${slug}"
preview_host="${slug}.${PREVIEW_BASE_DOMAIN}"

echo "Pulling preview image $image_ref ..."
podman pull "$image_ref"

podman rm -f "$container_name" >/dev/null 2>&1 || true

run_args=(
  run -d
  --name "$container_name"
  --restart always
  --label com.centurylinklabs.watchtower.enable=false
  -p "127.0.0.1:${preview_port}:${APP_CONTAINER_PORT:-8000}"
  -e "NODE_ENV=${NODE_ENV:-production}"
  -e "MONGODB_URI_FILE=${MONGODB_URI_FILE:-}"
  -e "DATABASE_URL_FILE=${DATABASE_URL_FILE:-}"
)

if [[ -n "${MESH_MONGO_SECRET_NAME:-}" ]]; then
  run_args+=( --secret "${MESH_MONGO_SECRET_NAME},type=mount,target=mongo_uri" )
fi

if [[ -n "${MESH_DATABASE_URL_SECRET_NAME:-}" ]]; then
  run_args+=( --secret "${MESH_DATABASE_URL_SECRET_NAME},type=mount,target=database_url" )
fi

podman "${run_args[@]}" "$image_ref"

health_url="http://127.0.0.1:${preview_port}${HEALTHCHECK_PATH:-/health}"
deadline=$((SECONDS + ${HEALTHCHECK_TIMEOUT_SECONDS:-90}))
until curl -fsS "$health_url" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "Preview container failed health check before timeout."
    podman logs "$container_name" --tail 100 || true
    podman rm -f "$container_name" >/dev/null 2>&1 || true
    exit 1
  fi
  sleep 2
done

mkdir -p "$ROOT_DIR/config/caddy/previews"
cat > "$ROOT_DIR/config/caddy/previews/${slug}.caddy" <<EOF
${preview_host} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${preview_port}
}
EOF

podman exec "wt-caddy-${NODE_NAME:-node}" caddy reload --config /etc/caddy/Caddyfile

echo "Preview deployment completed."
echo "  URL: https://${preview_host}"
echo "  Image: ${image_ref}"