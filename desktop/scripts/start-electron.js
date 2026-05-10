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
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.platform === 'linux' ? ['--no-sandbox', '.'] : ['.'];
const child = spawn(electron, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
