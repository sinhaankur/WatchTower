// Cross-platform Electron launcher for `npm start`.
//
// On Linux we pass --no-sandbox to avoid the X11/Pi GPU crash that
// commit 32094f7 added the flag for. On macOS/Windows the flag is
// rejected by Electron, so we omit it.
//
// We also explicitly clear ELECTRON_RUN_AS_NODE before spawning. VS
// Code's integrated terminal sets that var for its own Electron-based
// subprocess plumbing, and zsh inherits it. With it set, the spawned
// Electron treats main.js as a plain Node script — `require('electron')`
// returns the binary path string instead of the API, every imported
// API (ipcMain, app, BrowserWindow…) is undefined, and main.js
// crashes at the first ipcMain.on call. Clearing it here makes
// `npm --prefix desktop run start` work regardless of where the
// terminal was launched from.
//
// macOS only: rename node_modules/electron/dist/Electron.app to
// WatchTower.app so the macOS menu bar's leftmost item shows
// "WatchTower" instead of "Electron". That slot reads CFBundleName
// from the running .app's Info.plist; `app.setName()` and the menu
// template don't override it. Renaming the bundle is the only way
// to fix it in dev mode without packaging. Idempotent and safe — if
// `npm install` resets the dir, the next launch renames again.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let electron = require('electron');

if (process.platform === 'darwin') {
  try {
    const distDir = path.dirname(electron);
    // electron module resolves to <…>/Electron.app/Contents/MacOS/Electron;
    // walk up to the dist/ that holds the .app bundle.
    const appsRoot = path.resolve(distDir, '..', '..', '..');
    const stockApp = path.join(appsRoot, 'Electron.app');
    const renamedApp = path.join(appsRoot, 'WatchTower.app');
    if (fs.existsSync(stockApp) && !fs.existsSync(renamedApp)) {
      fs.renameSync(stockApp, renamedApp);
    }
    if (fs.existsSync(renamedApp)) {
      electron = path.join(renamedApp, 'Contents', 'MacOS', 'Electron');
    }
  } catch (e) {
    console.warn('[WatchTower] could not rename Electron.app:', e?.message || e);
  }
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.platform === 'linux' ? ['--no-sandbox', '.'] : ['.'];
const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
