#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/ensure-container-runtime.sh" --auto-install --auto-start

COMPOSE_CMD=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

if [[ -z "$COMPOSE_CMD" ]]; then
  echo "Docker Compose is required but was not found."
  echo "Install Docker Compose or Podman compose provider and retry."
  exit 1
fi

echo "Starting WatchTower application stack (web + api + postgres + redis) ..."
$COMPOSE_CMD -f "$ROOT_DIR/docker-compose.yml" up --build -d

echo
echo "WatchTower is running:"
echo "  UI:  http://127.0.0.1:5173"
echo "  API: http://127.0.0.1:8000"
echo
echo "Tail logs with: $COMPOSE_CMD -f $ROOT_DIR/docker-compose.yml logs -f"
