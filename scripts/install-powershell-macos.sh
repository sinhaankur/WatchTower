#!/usr/bin/env bash
set -euo pipefail

if command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell already installed: $(pwsh --version)"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required on macOS."
  echo "Install Homebrew first: https://brew.sh"
  exit 1
fi

# Prefer cask; fallback to formula if needed.
if ! brew install --cask powershell; then
  brew install powershell
fi

if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell installation failed."
  exit 1
fi

echo "Installed successfully: $(pwsh --version)"
