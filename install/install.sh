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
EXISTING_VERSION=""
if command -v watchtower &>/dev/null; then
    EXISTING_VERSION=$(watchtower --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)
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

# Install Python dependencies
echo ""
echo "Installing Python dependencies..."
pip3 install -r requirements.txt

# Install WatchTower
echo ""
echo "Installing WatchTower..."
python3 setup.py install

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
