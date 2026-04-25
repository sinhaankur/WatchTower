#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.hybrid}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy one of the examples and retry:"
  echo "  cp .env.hybrid.primary.example .env.hybrid"
  echo "  cp .env.hybrid.standby.example .env.hybrid"
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

override_file=""
cleanup() {
  if [[ -n "$override_file" && -f "$override_file" ]]; then
    rm -f "$override_file"
  fi
}
trap cleanup EXIT

append_secret() {
  local secret_name="$1"
  local target_name="$2"

  if ! podman secret inspect "$secret_name" >/dev/null 2>&1; then
    echo "Required Podman secret '$secret_name' does not exist."
    echo "Create it first, for example:"
    echo "  echo 'mongodb+srv://user:pass@cluster.mongodb.net/app?retryWrites=true&w=majority' | podman secret create $secret_name -"
    exit 1
  fi

  if [[ -z "$override_file" ]]; then
    override_file="$(mktemp)"
    cat > "$override_file" <<'EOF'
services:
  app-server:
    secrets:
EOF
  fi

  printf '      - source: %s\n        target: %s\n' "$secret_name" "$target_name" >> "$override_file"
}

append_top_level_secret() {
  local secret_name="$1"

  if ! grep -q '^secrets:$' "$override_file" 2>/dev/null; then
    printf 'secrets:\n' >> "$override_file"
  fi

  if ! grep -q "^  ${secret_name}:$" "$override_file" 2>/dev/null; then
    printf '  %s:\n    external: true\n' "$secret_name" >> "$override_file"
  fi
}

if [[ -n "${HYBRID_MONGO_SECRET_NAME:-}" ]]; then
  append_secret "$HYBRID_MONGO_SECRET_NAME" "mongo_uri"
  append_top_level_secret "$HYBRID_MONGO_SECRET_NAME"
fi

if [[ -n "${HYBRID_DATABASE_URL_SECRET_NAME:-}" ]]; then
  append_secret "$HYBRID_DATABASE_URL_SECRET_NAME" "database_url"
  append_top_level_secret "$HYBRID_DATABASE_URL_SECRET_NAME"
fi

compose_args=( -f "$ROOT_DIR/docker-compose.hybrid.yml" )
if [[ -n "$override_file" ]]; then
  compose_args+=( -f "$override_file" )
fi

echo "Starting hybrid stack for ${NODE_NAME:-unknown-node} ..."
podman compose "${compose_args[@]}" --env-file "$ENV_FILE" up -d

echo
echo "Hybrid stack started for ${NODE_NAME:-unknown-node}."
echo "  App: http://${NODE_TAILSCALE_IP:-127.0.0.1}:${APP_PORT:-8080}"
if [[ -n "${HYBRID_MONGO_SECRET_NAME:-}" ]]; then
  echo "  MongoDB secret: ${HYBRID_MONGO_SECRET_NAME}"
elif [[ -n "${MONGODB_URI:-}" ]]; then
  echo "  MongoDB mode: direct connection string from env"
else
  echo "  MongoDB mode: not configured"
fi