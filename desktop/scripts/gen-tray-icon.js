// Render the monochrome tray-icon SVG into the two PNGs Electron's Tray
// expects on macOS: a 22x22 base size and a 44x44 @2x variant. Writes to
// desktop/build/icons/.
//
// Why a separate template image (not just the full-color app icon):
// macOS menu-bar icons are supposed to be template images — pure black on
// transparent — so the system can auto-invert them in dark mode and render
// them at the same scale as system icons. Feeding the colorful app .icns
// to Tray() makes WatchTower's icon scream in the menu bar at huge size,
// completely out of style with neighbouring apps.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', '..', 'assets', 'wt-tray-template.svg');
const APP_SRC = path.join(__dirname, '..', '..', 'assets', 'wt-logo.svg');
const OUT_DIR = path.join(__dirname, '..', 'build', 'icons');

// Linux desktop icons. electron-builder's LinuxTargetHelper only
// recognises files named "<size>x<size>.png" inside linux.icon dirs —
// icon-gen's favicon-NN.png output is invisible to it, which meant the
// AppImage shipped the default Electron icon (and electron-builder 26
// hard-crashes in computeDesktopIcons when no icon resolves at all).
const LINUX_ICON_SIZES = [128, 256, 512];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svg = fs.readFileSync(SRC);
  const appSvg = fs.readFileSync(APP_SRC);

  await Promise.all([
    sharp(svg, { density: 320 })
      .resize(22, 22, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, 'trayTemplate.png')),
    sharp(svg, { density: 640 })
      .resize(44, 44, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, 'trayTemplate@2x.png')),
    ...LINUX_ICON_SIZES.map((size) =>
      sharp(appSvg, { density: (72 * size) / 64 })
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(path.join(OUT_DIR, `${size}x${size}.png`))
    ),
  ]);

  console.log(
    `[WatchTower] Wrote trayTemplate.png + trayTemplate@2x.png + linux icons (${LINUX_ICON_SIZES.map((s) => `${s}x${s}`).join(', ')})`
  );
}

main().catch((err) => {
  console.error('[WatchTower] Tray icon generation failed:', err);
  process.exit(1);
});
