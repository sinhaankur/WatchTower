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
    # Try both removal paths — whichever one actually has the install
    # will succeed; the other is a no-op.
    pipx uninstall watchtower-podman 2>/dev/null || true
    pip3 uninstall -y watchtower 2>/dev/null || true
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
    echo "Installing WatchTower via pipx (isolated venv at /opt/pipx/venvs/watchtower-podman)..."
    # --global so the install lands in /opt/pipx/ (system-wide), not
    # /root/.local/. Falls back to user-scope if --global isn't supported
    # on this pipx version (added in pipx 1.5).
    PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install --force watchtower-podman 2>&1 \
        || pipx install --force --pip-args="-r ${PWD}/requirements.txt" .
    echo "WatchTower installed to /opt/pipx/venvs/watchtower-podman/"
else
    # Pre-PEP-668 system. The legacy path still works.
    echo ""
    echo "Installing Python dependencies (legacy pip path)..."
    pip3 install -r requirements.txt

    echo ""
    echo "Installing WatchTower..."
    pip3 install .
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
