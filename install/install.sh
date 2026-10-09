#!/bin/bash

# WatchTower Installation Script for Ubuntu/Linux

set -e

echo "================================"
echo "WatchTower Installation Script"
echo "================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

# ── Anchor to the repo root ─────────────────────────────────────────────────
# install.sh lives in install/; the package, requirements.txt, config/, and
# systemd/ live one level up. Resolve paths off the SCRIPT location so the
# script works no matter where it's invoked from (fixes relative-path failures).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"
echo "Installing from local repo: ${REPO_ROOT}"

# Under sudo, $HOME is /root — but the Electron cache lives in the INVOKING
# user's home. Resolve that so the purge below actually hits the right dir.
REAL_USER="${SUDO_USER:-${USER}}"
REAL_HOME="$(getent passwd "${REAL_USER}" 2>/dev/null | cut -d: -f6)"
[[ -z "${REAL_HOME}" ]] && REAL_HOME="${HOME}"

# ── Detect existing installation ───────────────────────────────────────────────
# Look in three places, in order:
#   1. The watchtower CLI on PATH (most reliable signal that an install
#      shipped via install.sh is in place).
#   2. pipx — current install path (1.5.23+), uses an isolated venv.
#   3. pip3 system packages — pre-PEP-668 install path. Won't find
#      anything on Ubuntu 24.04+ even if packages are technically present.
EXISTING_VERSION=""
if command -v watchtower &>/dev/null; then
    EXISTING_VERSION=$(watchtower --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
fi
if [[ -z "${EXISTING_VERSION}" ]] && command -v pipx &>/dev/null && pipx list 2>/dev/null | grep -q watchtower-podman; then
    EXISTING_VERSION=$(pipx list 2>/dev/null | grep "watchtower-podman" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
fi
if [[ -z "${EXISTING_VERSION}" ]] && pip3 show watchtower &>/dev/null 2>&1; then
    EXISTING_VERSION=$(pip3 show watchtower 2>/dev/null | grep '^Version:' | awk '{print $2}' || true)
fi

if [[ -n "${EXISTING_VERSION}" ]]; then
    echo "Existing WatchTower ${EXISTING_VERSION} detected."
    # Stop the service if running so files can be replaced safely.
    if systemctl is-active --quiet watchtower.service 2>/dev/null; then
        echo "Stopping watchtower.service before update…"
        systemctl stop watchtower.service || true
    fi
    echo "Removing old installation before re-install…"
    # Remove via EVERY path an old version could have landed, system-wide and
    # in both the root and invoking-user pipx homes. Each is a no-op if empty.
    PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx uninstall watchtower-podman 2>/dev/null || true
    pipx uninstall watchtower-podman 2>/dev/null || true
    sudo -u "${REAL_USER}" pipx uninstall watchtower-podman 2>/dev/null || true
    pip3 uninstall -y watchtower-podman 2>/dev/null || true
    pip3 uninstall -y watchtower 2>/dev/null || true
    # Nuke any leftover pipx venv dirs outright (a half-removed venv can shadow
    # the new install and keep the OLD code around — the reported bug).
    rm -rf /opt/pipx/venvs/watchtower-podman 2>/dev/null || true
    rm -rf "${REAL_HOME}/.local/pipx/venvs/watchtower-podman" 2>/dev/null || true

    # Purge stale caches so the new version never serves OLD code/UI. This is
    # the fix for the "I updated but nothing changed" class of bug: the Electron
    # shell caches the SPA aggressively, and an orphaned _web_dist from a wheel
    # install can shadow a fresh build. Clearing them forces the new bundle.
    # Use REAL_HOME, not $HOME — under sudo $HOME is /root (wrong dir).
    echo "Clearing stale caches (Electron + bundled SPA) for ${REAL_USER}…"
    for cache in \
        "${REAL_HOME}/.config/watchtower-desktop/Cache" \
        "${REAL_HOME}/.config/watchtower-desktop/Code Cache" \
        "${REAL_HOME}/.config/watchtower-desktop/GPUCache" \
        "${REAL_HOME}/.config/watchtower-desktop/last-version"; do
        rm -rf "$cache" 2>/dev/null || true
    done
    # Any orphaned _web_dist left by a previous wheel install.
    find "${REAL_HOME}/.local" /opt/pipx -type d -path "*/watchtower/_web_dist" -prune -exec rm -rf {} + 2>/dev/null || true

    echo "Old version removed. Installing new version now."
else
    echo "No existing WatchTower installation found — performing fresh install."
fi
echo ""

# Check Python version
echo "Checking Python version..."
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
echo "Found Python $PYTHON_VERSION"

# Check Podman
echo "Checking Podman..."
if ! command -v podman &> /dev/null; then
    echo "Podman is not installed."
    read -p "Would you like to install Podman? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        apt update
        apt install -y podman
    else
        echo "Podman is required. Please install it manually."
        exit 1
    fi
fi

podman --version

# ── Detect PEP 668 (externally-managed Python) ─────────────────────────────────
# Ubuntu 24.04+, Debian 12+, Fedora 38+, recent Homebrew Python all set
# the EXTERNALLY-MANAGED marker. `pip install` then refuses to write
# to system site-packages and tells the user to use pipx or a venv.
#
# We test by checking whether the marker file exists for the
# system python3. If it does, we install via pipx (modern recommended
# path). If not, we fall through to the legacy `pip install -r
# requirements.txt` path so older systems keep working.
PYTHON_STDLIB=$(python3 -c 'import sysconfig; print(sysconfig.get_paths()["stdlib"])')
EXTERNALLY_MANAGED="${PYTHON_STDLIB}/EXTERNALLY-MANAGED"

# ── Build the SPA into the package so the wheel ships the CURRENT UI ─────────
# Without this, pip/pipx install the Python code but no web bundle, and the
# server falls back to a 61-byte JSON stub — "installed but no UI". We stage
# web/dist → watchtower/_web_dist (scripts/build-wheel.sh does the same).
echo ""
echo "Building the web UI into the package…"
if command -v npm &>/dev/null; then
    if [[ ! -d web/dist ]]; then
        echo "  · web/dist missing — building it (npm --prefix web run build)…"
        sudo -u "${REAL_USER}" npm --prefix web ci 2>/dev/null || npm --prefix web ci || true
        sudo -u "${REAL_USER}" npm --prefix web run build || npm --prefix web run build
    fi
    rm -rf watchtower/_web_dist
    cp -R web/dist watchtower/_web_dist
    echo "  ✓ Staged web/dist → watchtower/_web_dist ($(find watchtower/_web_dist -type f 2>/dev/null | wc -l | tr -d ' ') files)"
else
    echo "  ⚠ npm not found — installing without a freshly-built UI."
    echo "    If the dashboard shows a JSON stub, install Node.js and re-run."
fi

if [[ -f "${EXTERNALLY_MANAGED}" ]]; then
    echo ""
    echo "Detected externally-managed Python (PEP 668). Installing via pipx."
    if ! command -v pipx &> /dev/null; then
        echo "Installing pipx..."
        apt update
        apt install -y pipx python3-venv
        # Make pipx-managed bin dirs available system-wide
        pipx ensurepath --global 2>/dev/null || pipx ensurepath
    fi
    echo ""
    echo "Installing WatchTower via pipx from THIS repo (isolated venv at /opt/pipx/venvs/watchtower-podman)..."
    # Install the LOCAL package (".") — NOT the PyPI name. Installing
    # "watchtower-podman" from PyPI was the bug: it pulled a stale published
    # version instead of the code in this repo. "." installs exactly what's
    # checked out here, deps resolved from pyproject.toml.
    PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install --force "${REPO_ROOT}"
    echo "WatchTower installed to /opt/pipx/venvs/watchtower-podman/"
else
    # Pre-PEP-668 system. The legacy path still works — install the LOCAL repo.
    echo ""
    echo "Installing Python dependencies (legacy pip path)..."
    pip3 install -r requirements.txt

    echo ""
    echo "Installing WatchTower from this repo..."
    pip3 install --force-reinstall .
fi

# ── Verify the version we actually installed ────────────────────────────────
echo ""
INSTALLED_VERSION="$(watchtower --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
EXPECTED_VERSION="$(python3 -c 'import tomllib,pathlib; 1' 2>/dev/null && python3 - <<PY 2>/dev/null || true
import re, pathlib
m = re.search(r'__version__\s*=\s*"([^"]+)"', pathlib.Path("watchtower/__init__.py").read_text())
print(m.group(1) if m else "")
PY
)"
if [[ -n "${INSTALLED_VERSION}" ]]; then
    echo "Installed WatchTower ${INSTALLED_VERSION}."
    if [[ -n "${EXPECTED_VERSION}" && "${INSTALLED_VERSION}" != "${EXPECTED_VERSION}" ]]; then
        echo "⚠ Expected ${EXPECTED_VERSION} from this repo but CLI reports ${INSTALLED_VERSION}."
        echo "  An old copy may still be on PATH — run: which -a watchtower"
    fi
else
    echo "⚠ Could not confirm the installed version (watchtower CLI not on PATH yet)."
    echo "  Open a new shell or run: pipx ensurepath"
fi

# Create directories
echo ""
echo "Creating directories..."
mkdir -p /etc/watchtower
mkdir -p /var/log/watchtower
mkdir -p /opt/watchtower

# Copy configuration if it doesn't exist
if [ ! -f /etc/watchtower/watchtower.yml ]; then
    echo "Copying default configuration..."
    cp config/watchtower.yml /etc/watchtower/
    echo "Configuration file created at: /etc/watchtower/watchtower.yml"
else
    echo "Configuration file already exists at: /etc/watchtower/watchtower.yml"
fi

# Install systemd service
echo ""
echo "Installing systemd service..."
cp systemd/watchtower.service /etc/systemd/system/
systemctl daemon-reload

echo ""
echo "================================"
echo "Installation Complete!"
echo "================================"
echo ""
echo "Next steps:"
echo "1. Edit configuration: sudo nano /etc/watchtower/watchtower.yml"
echo "2. Start WatchTower: sudo systemctl start watchtower"
echo "3. Enable auto-start: sudo systemctl enable watchtower"
echo "4. Check status: sudo systemctl status watchtower"
echo "5. View logs: sudo journalctl -u watchtower -f"
echo ""
echo "CLI commands:"
echo "  watchtower status          - Check status"
echo "  watchtower update-now      - Run update now"
echo "  watchtower list-containers - List monitored containers"
echo "  watchtower validate-config - Validate configuration"
echo ""
