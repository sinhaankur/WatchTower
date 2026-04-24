#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://127.0.0.1:8080/health}"

if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 3 "$URL" >/dev/null
else
  wget -q -T 3 -O /dev/null "$URL"
fi
