#!/usr/bin/env bash
set -euo pipefail

# Scan whether a GitHub repository is readable from this machine/session.
#
# Usage:
#   scripts/scan-repo-readability.sh --repo owner/name
#   scripts/scan-repo-readability.sh --repo owner/name --token <gh_token>
#
# Token fallback order:
#   --token arg -> GH_TOKEN -> GITHUB_TOKEN -> GH_PAT_TOKEN

REPO=""
TOKEN=""
TIMEOUT_SECONDS=12

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} - $*"; }
warn() { echo -e "${YELLOW}WARN${NC} - $*"; }
fail() { echo -e "${RED}FAIL${NC} - $*"; }

usage() {
  cat <<EOF
Scan GitHub repository readability.

Required:
  --repo <owner/name>       Example: Node2-io/WatchTowerOps

Optional:
  --token <token>           GitHub token with repo read access
  --timeout <seconds>       Timeout per check (default: 12)
  -h, --help                Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --token)
      TOKEN="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-12}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "--repo is required"
  usage
  exit 1
fi

if [[ -z "$TOKEN" ]]; then
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${GH_PAT_TOKEN:-}}}"
fi

if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed"
  exit 1
fi

echo "== Repo Readability Scan =="
echo "repo: $REPO"
if [[ -n "$TOKEN" ]]; then
  pass "token detected (masked)"
else
  warn "no token detected; private repos will likely fail"
fi

PUBLIC_URL="https://github.com/${REPO}.git"
AUTH_URL="https://x-access-token:${TOKEN}@github.com/${REPO}.git"

scan_url="$PUBLIC_URL"
if [[ -n "$TOKEN" ]]; then
  scan_url="$AUTH_URL"
fi

set +e
scan_output="$({ GIT_TERMINAL_PROMPT=0 timeout "$TIMEOUT_SECONDS" git ls-remote --heads "$scan_url"; } 2>&1)"
scan_code=$?
set -e

if [[ $scan_code -eq 0 ]]; then
  pass "repository is readable via git ls-remote"
else
  fail "repository is NOT readable via git ls-remote"
  if [[ "$scan_output" == *"Repository not found"* ]]; then
    warn "GitHub says repository not found (or token cannot access private repo)."
  elif [[ "$scan_output" == *"Authentication failed"* ]] || [[ "$scan_output" == *"could not read Username"* ]]; then
    warn "Authentication failed. Provide a token with private-repo read access."
  elif [[ $scan_code -eq 124 ]]; then
    warn "Timed out while checking repo access."
  fi
  echo "details: ${scan_output//$TOKEN/***}"
fi

# Optional API check for visibility/type when token exists.
if command -v curl >/dev/null 2>&1; then
  if [[ -n "$TOKEN" ]]; then
    api_code="$(curl -sS -o /tmp/wt-repo-scan.json -w "%{http_code}" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO}" || true)"

    if [[ "$api_code" == "200" ]]; then
      visibility="$(python3 - <<'PY'
import json
p='/tmp/wt-repo-scan.json'
with open(p, 'r', encoding='utf-8') as f:
    d=json.load(f)
print(d.get('visibility') or ('private' if d.get('private') else 'public'))
PY
)"
      default_branch="$(python3 - <<'PY'
import json
p='/tmp/wt-repo-scan.json'
with open(p, 'r', encoding='utf-8') as f:
    d=json.load(f)
print(d.get('default_branch') or '')
PY
)"
      pass "GitHub API access OK (visibility: ${visibility}, default branch: ${default_branch})"
    else
      warn "GitHub API check failed (HTTP ${api_code})"
    fi
  fi
else
  warn "curl not found; skipped API metadata check"
fi

echo
if [[ $scan_code -eq 0 ]]; then
  echo "Result: repo is readable from this environment."
  exit 0
fi

echo "Result: repo is NOT readable from this environment."
echo "Fixes:"
echo "  1) Ensure repo path is correct: owner/name"
echo "  2) Export token: export GH_TOKEN=<token>"
echo "  3) Token scopes for classic PAT: repo (private)"
exit 2
