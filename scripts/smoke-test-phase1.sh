#!/usr/bin/env bash
# Smoke-test for Phase 1 of autonomous global-deploy — verifies that a
# project configured with `run_as_container=True` actually ends up
# serving its artifact via a Podman container on each attached node.
#
# This is the runbook a human follows the first time they enable Phase 1
# on a real project. It can't replace a true integration test (which
# would need a remote Podman host CI runners don't have), but it
# automates everything observable from outside the node:
#
#   1. Project has run_as_container=true and recommended_port set
#   2. A deploy trigger reaches LIVE within the timeout
#   3. Each node's exposed port answers HTTP
#
# Usage:
#   WATCHTOWER_BASE_URL=http://127.0.0.1:8000 \
#   WATCHTOWER_API_TOKEN=$TOKEN \
#     ./scripts/smoke-test-phase1.sh <PROJECT_ID>
#
# Optional:
#   DEPLOY_TIMEOUT_SECS=240   how long to wait for status=LIVE (default 240)
#   PROBE_HOST=overrides.example.com   probe a different hostname than the node's `host`
#                                       (useful when the WatchTower box can't reach the
#                                       node directly but a public DNS name can)
#   SKIP_TRIGGER=1            don't trigger a fresh deploy — just probe whatever's running
set -uo pipefail

PROJECT_ID="${1:-}"
BASE_URL="${WATCHTOWER_BASE_URL:-}"
TOKEN="${WATCHTOWER_API_TOKEN:-}"
DEPLOY_TIMEOUT_SECS="${DEPLOY_TIMEOUT_SECS:-240}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "${GREEN}PASS${NC} $*"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); echo -e "${YELLOW}WARN${NC} $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo -e "${RED}FAIL${NC} $*"; }
head() { echo -e "\n${BOLD}── $* ──${NC}"; }

if [ -z "$PROJECT_ID" ] || [ -z "$BASE_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: WATCHTOWER_BASE_URL=... WATCHTOWER_API_TOKEN=... $0 <PROJECT_ID>" >&2
  exit 2
fi

API() {
  # Wraps curl so every call gets the auth header + a sane timeout.
  # Caller passes everything *after* the URL path, e.g. `API GET /projects/<id>`.
  local method="$1"; shift
  local path="$1"; shift
  curl -sS -m 15 \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -X "$method" \
    "$@" \
    "${BASE_URL%/}/api${path}"
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "FAIL: jq is required (brew install jq | apt install jq)" >&2
    exit 2
  fi
}

require_jq

# ─── 1. Project shape ─────────────────────────────────────────────────────────
head "1. Project configuration"
PROJECT_JSON=$(API GET "/projects/${PROJECT_ID}") || { fail "GET /projects/$PROJECT_ID failed"; exit 1; }
NAME=$(echo "$PROJECT_JSON" | jq -r '.name // empty')
ORG_ID=$(echo "$PROJECT_JSON" | jq -r '.org_id // empty')
RUN_AS_CONTAINER=$(echo "$PROJECT_JSON" | jq -r '.run_as_container // false')
PORT=$(echo "$PROJECT_JSON" | jq -r '.recommended_port // empty')

if [ -z "$NAME" ]; then
  fail "Project $PROJECT_ID not found (or token lacks access)"
  exit 1
fi
pass "Project: ${NAME}"

if [ "$RUN_AS_CONTAINER" = "true" ]; then
  pass "run_as_container=true"
else
  fail "run_as_container is FALSE — enable it on the project Overview tab first"
  exit 1
fi

if [ -n "$PORT" ] && [ "$PORT" != "null" ]; then
  pass "recommended_port=${PORT}"
else
  fail "recommended_port is unset — Phase 1 cannot bind a container without it"
  exit 1
fi

# ─── 2. Nodes attached to the project ─────────────────────────────────────────
head "2. Deployment targets"
if [ -z "$ORG_ID" ] || [ "$ORG_ID" = "null" ]; then
  warn "Project has no org_id — can't list nodes."
  NODES_JSON="[]"
else
  NODES_JSON=$(API GET "/orgs/${ORG_ID}/nodes" || echo "[]")
fi
NODE_COUNT=$(echo "$NODES_JSON" | jq 'length')
if [ "$NODE_COUNT" = "0" ] || [ -z "$NODE_COUNT" ]; then
  warn "No nodes registered in this org. Add a node before testing remote container deploys."
fi

# Each node we'll probe. PROBE_HOST overrides every node's host field
# (useful when the WatchTower box can't route to the node's private IP
# but a public DNS name can).
PROBE_HOSTS=()
if [ -n "${PROBE_HOST:-}" ]; then
  PROBE_HOSTS=("$PROBE_HOST")
  pass "PROBE_HOST set — probing only ${PROBE_HOST}"
else
  while IFS= read -r h; do
    [ -n "$h" ] && PROBE_HOSTS+=("$h")
  done < <(echo "$NODES_JSON" | jq -r '.[].host')
  pass "Will probe ${#PROBE_HOSTS[@]} node host(s): ${PROBE_HOSTS[*]:-<none>}"
fi

# ─── 3. Trigger deploy (unless SKIP_TRIGGER=1) ────────────────────────────────
head "3. Deploy"
if [ "${SKIP_TRIGGER:-0}" = "1" ]; then
  warn "SKIP_TRIGGER=1 set — using whatever was last deployed."
  DEPLOYMENT_ID=$(API GET "/projects/${PROJECT_ID}/deployments" | jq -r '.[0].id // empty')
  if [ -z "$DEPLOYMENT_ID" ]; then
    fail "SKIP_TRIGGER=1 but project has no prior deployments. Drop SKIP_TRIGGER to trigger one."
    exit 1
  fi
else
  BRANCH=$(echo "$PROJECT_JSON" | jq -r '.repo_branch // "main"')
  TRIGGER_JSON=$(API POST "/projects/${PROJECT_ID}/deployments" -d "{\"branch\":\"${BRANCH}\"}") \
    || { fail "Failed to trigger deployment"; exit 1; }
  DEPLOYMENT_ID=$(echo "$TRIGGER_JSON" | jq -r '.id // empty')
  if [ -z "$DEPLOYMENT_ID" ]; then
    fail "trigger response had no .id: $TRIGGER_JSON"
    exit 1
  fi
  pass "Deploy queued: ${DEPLOYMENT_ID}"
fi

# Poll for terminal status. Builds normally take 30s–5min depending on
# the build command; container start adds ~5–15s once the artifact is
# ready. We poll every 5s and bail at DEPLOY_TIMEOUT_SECS.
DEADLINE=$(( $(date +%s) + DEPLOY_TIMEOUT_SECS ))
STATUS=""
while [ $(date +%s) -lt $DEADLINE ]; do
  STATUS=$(API GET "/deployments/${DEPLOYMENT_ID}" | jq -r '.status // "?"')
  echo "  status=${STATUS}"
  case "$STATUS" in
    live)          pass "Deployment reached LIVE"; break ;;
    failed|rolled_back) fail "Deployment terminated as ${STATUS}"; exit 1 ;;
    *)             sleep 5 ;;
  esac
done
if [ "$STATUS" != "live" ]; then
  fail "Deployment did not reach LIVE within ${DEPLOY_TIMEOUT_SECS}s (last status: ${STATUS})"
  exit 1
fi

# ─── 4. HTTP probe each host on the bound port ────────────────────────────────
head "4. HTTP probe"
if [ ${#PROBE_HOSTS[@]} -eq 0 ]; then
  warn "No hosts to probe. Skipping HTTP check."
else
  for host in "${PROBE_HOSTS[@]}"; do
    # We don't check status-code semantics — the deploy could be any
    # static site. We're just confirming the container is bound to the
    # port and responds with *something*. A connection-level failure
    # (curl exit 7) is the signal that the container isn't there.
    code=$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "http://${host}:${PORT}/" || echo "000")
    if [ "$code" = "000" ]; then
      fail "${host}:${PORT} did not respond (no TCP or HTTP). Container probably not running."
    elif [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then
      pass "${host}:${PORT} responded HTTP ${code}"
    else
      warn "${host}:${PORT} responded HTTP ${code} — container is up but app may be broken"
    fi
  done
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
head "Result"
echo "  ${GREEN}${PASS_COUNT} pass${NC}, ${YELLOW}${WARN_COUNT} warn${NC}, ${RED}${FAIL_COUNT} fail${NC}"
if [ $FAIL_COUNT -gt 0 ]; then
  exit 1
fi
echo -e "${GREEN}Phase 1 smoke test passed.${NC}"
