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
const OUT_DIR = path.join(__dirname, '..', 'build', 'icons');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const svg = fs.readFileSync(SRC);

  await Promise.all([
    sharp(svg, { density: 320 })
      .resize(22, 22, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, 'trayTemplate.png')),
    sharp(svg, { density: 640 })
      .resize(44, 44, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(path.join(OUT_DIR, 'trayTemplate@2x.png')),
  ]);

  console.log('[WatchTower] Wrote trayTemplate.png + trayTemplate@2x.png');
}

main().catch((err) => {
  console.error('[WatchTower] Tray icon generation failed:', err);
  process.exit(1);
});
