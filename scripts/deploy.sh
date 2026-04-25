#!/usr/bin/env bash
set -euo pipefail

# Trigger remote Watchtower deployment from a developer machine.
# Usage:
#   WATCHTOWER_BASE_URL=http://server:8000 WATCHTOWER_TOKEN=secret ./deploy.sh --app <app_name> [branch]
#   WATCHTOWER_URL=http://server:8000/deploy WATCHTOWER_TOKEN=secret ./deploy.sh [branch] [source_path]

MODE="legacy"
APP_NAME=""

if [[ "${1:-}" == "--app" ]]; then
  MODE="app"
  APP_NAME="${2:-}"
  BRANCH="${3:-main}"
  SOURCE_PATH=""
else
  BRANCH="${1:-main}"
  SOURCE_PATH="${2:-}"
fi

WATCHTOWER_BASE_URL="${WATCHTOWER_BASE_URL:-http://127.0.0.1:8000}"
WATCHTOWER_URL="${WATCHTOWER_URL:-${WATCHTOWER_BASE_URL}/deploy}"
WATCHTOWER_TOKEN="${WATCHTOWER_TOKEN:-change-me}"

if [[ -z "${WATCHTOWER_URL}" ]]; then
  echo "WATCHTOWER_URL is required"
  exit 1
fi

if [[ "${MODE}" == "app" ]]; then
  if [[ -z "${APP_NAME}" ]]; then
    echo "Usage: ./deploy.sh --app <app_name> [branch]"
    exit 1
  fi

  APP_URL="${WATCHTOWER_BASE_URL}/apps/${APP_NAME}/deploy"
  APP_PAYLOAD=$(printf '{"branch":"%s"}' "${BRANCH}")
  echo "Triggering app deployment to ${APP_URL} (app: ${APP_NAME}, branch: ${BRANCH})"
  curl -sS -X POST "${APP_URL}" \
    -H "Content-Type: application/json" \
    -H "X-Watchtower-Token: ${WATCHTOWER_TOKEN}" \
    -d "${APP_PAYLOAD}"
  echo
  exit 0
fi

if [[ -n "${SOURCE_PATH}" ]]; then
  PAYLOAD=$(printf '{"branch":"%s","source_path":"%s"}' "${BRANCH}" "${SOURCE_PATH}")
else
  PAYLOAD=$(printf '{"branch":"%s"}' "${BRANCH}")
fi

echo "Triggering deployment to ${WATCHTOWER_URL} (branch: ${BRANCH})"
curl -sS -X POST "${WATCHTOWER_URL}" \
  -H "Content-Type: application/json" \
  -H "X-Watchtower-Token: ${WATCHTOWER_TOKEN}" \
  -d "${PAYLOAD}"
echo
