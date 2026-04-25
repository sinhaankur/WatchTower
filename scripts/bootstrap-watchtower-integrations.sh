#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${API_URL:-http://127.0.0.1:8000}"
AUTO_INSTALL="true"
START_BACKGROUND="true"
TAILSCALE_UP="false"
TOKEN_OVERRIDE=""

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

print_usage() {
  cat <<'EOF'
Usage: ./scripts/bootstrap-watchtower-integrations.sh [options]

Options:
  --api-url <url>        API base URL (default: http://127.0.0.1:8000)
  --token <token>        API bearer token (overrides WATCHTOWER_API_TOKEN)
  --no-install           Do not install missing tools
  --skip-background      Do not start background WatchTower updater
  --tailscale-up         Attempt "sudo tailscale up" (can require interactive auth)
  --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="$2"
      shift 2
      ;;
    --token)
      TOKEN_OVERRIDE="$2"
      shift 2
      ;;
    --no-install)
      AUTO_INSTALL="false"
      shift
      ;;
    --skip-background)
      START_BACKGROUND="false"
      shift
      ;;
    --tailscale-up)
      TAILSCALE_UP="true"
      shift
      ;;
    --help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      print_usage
      exit 1
      ;;
  esac
done

is_apt_like() {
  command -v apt-get >/dev/null 2>&1
}

can_sudo() {
  command -v sudo >/dev/null 2>&1
}

add_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "[PASS] %s\n" "$1"
}

add_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "[FAIL] %s\n" "$1"
}

add_warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf "[WARN] %s\n" "$1"
}

ensure_cmd() {
  local cmd="$1"
  local install_desc="$2"
  local install_fn="$3"

  if command -v "$cmd" >/dev/null 2>&1; then
    add_pass "$cmd is available"
    return 0
  fi

  if [[ "$AUTO_INSTALL" != "true" ]]; then
    add_fail "$cmd missing (install skipped with --no-install)"
    return 1
  fi

  if [[ "$install_fn" == "none" ]]; then
    add_fail "$cmd missing and no installer available: $install_desc"
    return 1
  fi

  if ! $install_fn; then
    add_fail "$cmd install failed ($install_desc)"
    return 1
  fi

  if command -v "$cmd" >/dev/null 2>&1; then
    add_pass "$cmd installed"
    return 0
  fi

  add_fail "$cmd still not found after install"
  return 1
}

install_podman() {
  if ! is_apt_like || ! can_sudo; then
    return 1
  fi
  sudo apt-get update -y >/dev/null
  sudo apt-get install -y podman >/dev/null
}

install_docker() {
  if ! is_apt_like || ! can_sudo; then
    return 1
  fi
  sudo apt-get update -y >/dev/null
  sudo apt-get install -y docker.io >/dev/null
  sudo systemctl enable --now docker >/dev/null 2>&1 || true
}

install_tailscale() {
  if ! can_sudo; then
    return 1
  fi
  curl -fsSL https://tailscale.com/install.sh | sudo sh >/dev/null
}

check_oauth_vars() {
  local cid="${GITHUB_OAUTH_CLIENT_ID:-${GITHUB_CLIENT_ID:-}}"
  local csecret="${GITHUB_OAUTH_CLIENT_SECRET:-${GITHUB_CLIENT_SECRET:-}}"

  if [[ -n "$cid" && -n "$csecret" ]]; then
    add_pass "OAuth env vars configured (GitHub client id/secret)"
    return 0
  fi

  add_warn "OAuth env vars missing. GitHub OAuth login will be unavailable until GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are set"
  return 0
}

check_runtime_podman() {
  if podman info >/dev/null 2>&1; then
    add_pass "Podman runtime reachable"
  else
    add_fail "Podman installed but runtime is not reachable"
  fi
}

check_runtime_docker() {
  if docker info >/dev/null 2>&1; then
    add_pass "Docker daemon reachable"
  else
    add_fail "Docker installed but daemon is not reachable"
  fi
}

check_tailscale_status() {
  if tailscale status >/dev/null 2>&1; then
    local ip
    ip="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
    if [[ -n "$ip" ]]; then
      add_pass "Tailscale connected ($ip)"
    else
      add_warn "Tailscale installed, but no IPv4 assigned yet"
    fi
  else
    add_warn "Tailscale installed, but not authenticated/connected"
  fi
}

api_health_ok() {
  curl -fsS "$API_URL/health" >/dev/null 2>&1
}

check_api_endpoint() {
  local token="$1"
  shift
  local path
  for path in "$@"; do
    local code
    code="$(curl -sS -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer $token" \
      "$API_URL$path" || true)"
    if [[ "$code" == "200" ]]; then
      echo "200:$path"
      return 0
    fi
  done
  echo "${code:-000}:${1}"
  return 1
}

start_background_via_api() {
  local token="$1"
  local bearer
  bearer="$token"
  if [[ -z "$bearer" ]]; then
    bearer="bootstrap-dev-token"
  fi

  curl -fsS -X POST \
    -H "Authorization: Bearer $bearer" \
    "$API_URL/api/runtime/watchtower/start-background" >/dev/null 2>&1
}

start_background_via_cli() {
  local python_bin=""
  if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    python_bin="$ROOT_DIR/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    python_bin="python3"
  else
    return 1
  fi

  (cd "$ROOT_DIR" && "$python_bin" -m watchtower start >/dev/null 2>&1)
}

echo "== Wt Bootstrap: OAuth + Podman + Docker + Tailscale + Background =="
echo "API URL: $API_URL"

echo
echo "[1/4] Validating OAuth env vars"
check_oauth_vars || true

echo
echo "[2/4] Installing/verifying tools"
ensure_cmd "curl" "curl is required for install checks" "none" || true
ensure_cmd "podman" "apt install podman" "install_podman" || true
ensure_cmd "docker" "apt install docker.io" "install_docker" || true
ensure_cmd "tailscale" "tailscale install script" "install_tailscale" || true

echo
echo "[3/4] Verifying runtime connectivity"
if command -v podman >/dev/null 2>&1; then
  check_runtime_podman
fi
if command -v docker >/dev/null 2>&1; then
  check_runtime_docker
fi
if command -v tailscale >/dev/null 2>&1; then
  if [[ "$TAILSCALE_UP" == "true" ]] && can_sudo; then
    sudo tailscale up >/dev/null 2>&1 || true
  fi
  check_tailscale_status
fi

echo
echo "[4/4] Starting WatchTower background updater + health checks"
if [[ "$START_BACKGROUND" == "true" ]]; then
  TOKEN="${TOKEN_OVERRIDE:-${WATCHTOWER_API_TOKEN:-}}"
  if api_health_ok; then
    if start_background_via_api "$TOKEN"; then
      add_pass "Background updater started via Runtime API"
    else
      add_warn "Runtime API start failed; trying CLI fallback"
      if start_background_via_cli; then
        add_pass "Background updater started via CLI fallback"
      else
        add_fail "Unable to start background updater (API and CLI failed)"
      fi
    fi
  else
    add_warn "API health unreachable at $API_URL/health; trying CLI fallback"
    if start_background_via_cli; then
      add_pass "Background updater started via CLI fallback"
    else
      add_fail "Unable to start background updater (API unreachable and CLI failed)"
    fi
  fi
else
  add_warn "Background start skipped (--skip-background)"
fi

TOKEN="${TOKEN_OVERRIDE:-${WATCHTOWER_API_TOKEN:-bootstrap-dev-token}}"
if api_health_ok; then
  add_pass "API health check passed"
else
  add_fail "API health check failed at $API_URL/health"
fi

RUNTIME_RESULT="$(check_api_endpoint "$TOKEN" "/api/runtime/status" "/runtime/status" || true)"
if [[ "$RUNTIME_RESULT" == 200:* ]]; then
  add_pass "Runtime status endpoint reachable (${RUNTIME_RESULT#200:})"
else
  add_fail "Runtime status endpoint failed (${RUNTIME_RESULT%%:*})"
fi

INTEGRATIONS_RESULT="$(check_api_endpoint "$TOKEN" "/api/runtime/integrations/status" "/runtime/integrations/status" || true)"
if [[ "$INTEGRATIONS_RESULT" == 200:* ]]; then
  add_pass "Integrations status endpoint reachable (${INTEGRATIONS_RESULT#200:})"
else
  add_warn "Integrations status endpoint unavailable (${INTEGRATIONS_RESULT%%:*}). This is optional unless you use Host Connect integrations"
fi

echo
echo "== Final Report =="
printf "Passed: %d\n" "$PASS_COUNT"
printf "Warnings: %d\n" "$WARN_COUNT"
printf "Failed: %d\n" "$FAIL_COUNT"

if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "Overall: PASS"
  exit 0
fi

echo "Overall: FAIL"
exit 1
