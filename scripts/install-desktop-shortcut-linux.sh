#!/usr/bin/env bash
set -euo pipefail

# Creates a Linux desktop entry so WatchTower appears in app launchers and can be pinned.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
APP_DIR="$HOME/.local/share/applications"
LAUNCHER="$BIN_DIR/watchtower-desktop"
DESKTOP_FILE="$APP_DIR/watchtower.desktop"

mkdir -p "$BIN_DIR" "$APP_DIR"

cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
cd "$ROOT_DIR"
exec npm run desktop
EOF
chmod +x "$LAUNCHER"

# Use largest available PNG icon if present, else fall back to SVG.
ICON_PNG="$ROOT_DIR/desktop/build/icons/favicon-128.png"
ICON_SVG="$ROOT_DIR/assets/wt-logo.svg"
if [[ -f "$ICON_PNG" ]]; then
  ICON_PATH="$ICON_PNG"
else
  ICON_PATH="$ICON_SVG"
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=WatchTower
Comment=WatchTower Desktop — deployment control plane
Exec=$LAUNCHER
Icon=$ICON_PATH
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF

# Refresh desktop database when available.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Desktop shortcut installed: $DESKTOP_FILE"
echo "You can now search for 'WatchTower' in your app launcher and pin it to the dock/taskbar."
