#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

COMPOSE_CMD=""
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

if [[ -z "$COMPOSE_CMD" ]]; then
  echo "Docker Compose is required but was not found."
  exit 1
fi

if ! $COMPOSE_CMD -f "$ROOT_DIR/docker-compose.yml" ps >/dev/null 2>&1; then
  echo "Container engine is not reachable for compose commands. Nothing to stop."
  exit 0
fi

echo "Stopping WatchTower application stack ..."
$COMPOSE_CMD -f "$ROOT_DIR/docker-compose.yml" down

echo "WatchTower application stack stopped."
