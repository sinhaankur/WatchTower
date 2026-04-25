#!/usr/bin/env bash
set -euo pipefail

# Cloudflare/Tunnel validation helper for WatchTower-hosted apps.
#
# Usage examples:
#   scripts/test-cloudflare.sh --hostname app.example.com
#   scripts/test-cloudflare.sh --hostname app.example.com --tunnel watchtower-app
#   scripts/test-cloudflare.sh --hostname app.example.com --path /health --allow-5xx

HOSTNAME=""
TUNNEL_NAME=""
PATH_TO_CHECK="/"
TIMEOUT_SECONDS=10
ALLOW_5XX=false

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "${GREEN}PASS${NC} - $*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  echo -e "${YELLOW}WARN${NC} - $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo -e "${RED}FAIL${NC} - $*"
}

usage() {
  cat <<EOF
Cloudflare hosting validator for WatchTower.

Required:
  --hostname <fqdn>        Public hostname to test (for example: app.example.com)

Optional:
  --tunnel <name>          Expected cloudflared tunnel name
  --path <path>            Request path to test (default: /)
  --timeout <seconds>      Curl timeout in seconds (default: 10)
  --allow-5xx              Do not fail on 5xx response (useful during rollout)
  -h, --help               Show help

Examples:
  scripts/test-cloudflare.sh --hostname app.example.com
  scripts/test-cloudflare.sh --hostname app.example.com --path /health --tunnel wt-app
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)
      HOSTNAME="${2:-}"
      shift 2
      ;;
    --tunnel)
      TUNNEL_NAME="${2:-}"
      shift 2
      ;;
    --path)
      PATH_TO_CHECK="${2:-/}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-10}"
      shift 2
      ;;
    --allow-5xx)
      ALLOW_5XX=true
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$HOSTNAME" ]]; then
  echo "--hostname is required"
  usage
  exit 1
fi

if [[ "$HOSTNAME" =~ yourdomain\.com$ ]] || [[ "$HOSTNAME" =~ (^|\.)example\.com$ ]]; then
  echo "Refusing placeholder hostname: $HOSTNAME"
  echo "Use your real public domain, for example: app.mycompany.com"
  exit 2
fi

if [[ "$PATH_TO_CHECK" != /* ]]; then
  PATH_TO_CHECK="/$PATH_TO_CHECK"
fi

echo "== WatchTower Cloudflare Validation =="
echo "hostname: $HOSTNAME"
echo "path:     $PATH_TO_CHECK"
if [[ -n "$TUNNEL_NAME" ]]; then
  echo "tunnel:   $TUNNEL_NAME"
fi
echo

if command -v cloudflared >/dev/null 2>&1; then
  pass "cloudflared binary found"
  if cloudflared tunnel list --output json >/tmp/wt-cloudflare-tunnels.json 2>/tmp/wt-cloudflare-tunnels.err; then
    pass "cloudflared authenticated (tunnel list succeeded)"
    if [[ -n "$TUNNEL_NAME" ]]; then
      if python3 - <<'PY' "/tmp/wt-cloudflare-tunnels.json" "$TUNNEL_NAME"
import json
import sys
p = sys.argv[1]
name = sys.argv[2]
with open(p, 'r', encoding='utf-8') as f:
    rows = json.load(f)
found = any((r.get('name') == name) for r in rows if isinstance(r, dict))
raise SystemExit(0 if found else 1)
PY
      then
        pass "tunnel '$TUNNEL_NAME' exists"
      else
        fail "tunnel '$TUNNEL_NAME' was not found in cloudflared tunnel list"
      fi
    fi
  else
    warn "cloudflared installed but not authenticated (run: cloudflared tunnel login)"
    if [[ -n "$TUNNEL_NAME" ]]; then
      warn "cannot verify tunnel '$TUNNEL_NAME' without cloudflared authentication"
    fi
  fi
else
  warn "cloudflared binary not found on this machine"
fi

if command -v dig >/dev/null 2>&1; then
  cname="$(dig +short CNAME "$HOSTNAME" | tail -n1 | tr -d '\n' || true)"
  a_records="$(dig +short A "$HOSTNAME" | tr '\n' ' ' || true)"
  aaaa_records="$(dig +short AAAA "$HOSTNAME" | tr '\n' ' ' || true)"
  if [[ -n "$cname" || -n "$a_records" || -n "$aaaa_records" ]]; then
    pass "DNS resolves for $HOSTNAME"
    [[ -n "$cname" ]] && echo "    CNAME: $cname"
    [[ -n "$a_records" ]] && echo "    A:     $a_records"
    [[ -n "$aaaa_records" ]] && echo "    AAAA:  $aaaa_records"
  else
    fail "DNS does not currently resolve for $HOSTNAME"
  fi
else
  warn "dig is not installed; skipping DNS resolution check"
fi

URL="https://${HOSTNAME}${PATH_TO_CHECK}"
echo
echo "Requesting: $URL"

set +e
curl_output="$(curl -sS -I -L --max-time "$TIMEOUT_SECONDS" "$URL" 2>&1)"
curl_exit=$?
set -e

if [[ $curl_exit -ne 0 ]]; then
  fail "HTTP request failed: ${curl_output}"
else
  status_line="$(printf '%s\n' "$curl_output" | grep -E '^HTTP/' | tail -n1 || true)"
  status_code="$(printf '%s' "$status_line" | awk '{print $2}' || true)"
  cf_ray="$(printf '%s\n' "$curl_output" | grep -i '^cf-ray:' | tail -n1 || true)"
  server_hdr="$(printf '%s\n' "$curl_output" | grep -i '^server:' | tail -n1 || true)"

  if [[ -n "$status_code" ]]; then
    if [[ "$status_code" =~ ^2|3|4 ]]; then
      pass "HTTP reachable (status $status_code)"
    elif [[ "$status_code" =~ ^5 ]]; then
      if [[ "$ALLOW_5XX" == true ]]; then
        warn "HTTP returned $status_code (allowed due to --allow-5xx)"
      else
        fail "HTTP returned server error $status_code"
      fi
    else
      warn "Unexpected HTTP status: ${status_line}"
    fi
  else
    fail "Could not parse HTTP status from response"
  fi

  if [[ -n "$cf_ray" ]]; then
    pass "Cloudflare edge header detected (${cf_ray})"
  else
    warn "No CF-RAY header found; traffic may not be proxied through Cloudflare"
  fi

  if [[ -n "$server_hdr" ]]; then
    echo "    ${server_hdr}"
  fi
fi

echo
echo "== Summary =="
echo "PASS: $PASS_COUNT"
echo "WARN: $WARN_COUNT"
echo "FAIL: $FAIL_COUNT"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo
  echo "Suggested next checks:"
  echo "  1) cloudflared tunnel list"
  echo "  2) cloudflared tunnel info <name>"
  echo "  3) cloudflared tunnel route dns <name> <hostname>"
  echo "  4) Ensure Cloudflare DNS record for ${HOSTNAME} is proxied"
  exit 1
fi

exit 0
