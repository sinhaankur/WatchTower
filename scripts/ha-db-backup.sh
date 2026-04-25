#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.ha}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

CONTAINER_NAME="wt-db-${NODE_NAME:-node}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/${NODE_NAME:-node}-${POSTGRESQL_DATABASE:-watchtower}-$TS.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "Creating DB backup from $CONTAINER_NAME ..."
podman exec "$CONTAINER_NAME" bash -lc \
  "PGPASSWORD='$POSTGRESQL_PASSWORD' pg_dump -U '$POSTGRESQL_USERNAME' '$POSTGRESQL_DATABASE'" | gzip > "$OUT_FILE"

echo "Backup written to: $OUT_FILE"
