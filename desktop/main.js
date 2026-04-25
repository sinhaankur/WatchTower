const { app, BrowserWindow, dialog, ipcMain, nativeImage } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const FRONTEND_PORT = 5222;
const BACKEND_PORT = 8000;

const repoRoot = path.resolve(__dirname, '..');
const webRoot = path.join(repoRoot, 'web');
const pythonUnix = path.join(repoRoot, '.venv', 'bin', 'python');
const pythonWin = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
const runtimeApiToken = process.env.WATCHTOWER_API_TOKEN || `wt-${crypto.randomBytes(24).toString('hex')}`;

// Resolve the best available icon for this platform.
const iconsDir = path.join(__dirname, 'build', 'icons');
function resolveAppIcon() {
  const candidates = [
    path.join(iconsDir, 'app.icns'),  // macOS
    path.join(iconsDir, 'app.ico'),   // Windows
    path.join(iconsDir, 'favicon-128.png'), // Linux / fallback
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}
const APP_ICON = resolveAppIcon();

let backendProcess;
let frontendProcess;
let splashWindow;
let mainWindow;

function resolvePython() {
  if (fs.existsSync(pythonUnix)) return pythonUnix;
  if (fs.existsSync(pythonWin)) return pythonWin;
  return 'python3';
}

function waitForUrl(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) { resolve(); return; }
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Service check failed at ${url} (status ${res.statusCode})`));
          return;
        }
        setTimeout(attempt, 700);
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 700);
      });
    };
    attempt();
  });
}

function startBackend() {
  const python = resolvePython();
  backendProcess = spawn(
    python,
    ['-m', 'uvicorn', 'watchtower.api:app', '--app-dir', repoRoot, '--host', HOST, '--port', String(BACKEND_PORT)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        WATCHTOWER_API_TOKEN: runtimeApiToken,
        WATCHTOWER_ALLOW_INSECURE_DEV_AUTH: process.env.WATCHTOWER_ALLOW_INSECURE_DEV_AUTH || 'false',
      },
      stdio: 'inherit',
    }
  );
}

function startFrontend() {
  frontendProcess = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--host', HOST, '--port', String(FRONTEND_PORT), '--strictPort'],
    {
      cwd: webRoot,
      env: { ...process.env, VITE_API_TOKEN: process.env.VITE_API_TOKEN || runtimeApiToken },
      stdio: 'inherit',
    }
  );
}

function stopProcesses() {
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
  if (frontendProcess && !frontendProcess.killed) frontendProcess.kill();
}

// ── Splash window ────────────────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#fbf6ea',
    ...(APP_ICON ? { icon: APP_ICON } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

// ── Main window ──────────────────────────────────────────────────────────────
function createMainWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 740,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    title: 'WatchTower',
    backgroundColor: '#fbf6ea',
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    ...(APP_ICON ? { icon: APP_ICON } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Notify renderer of maximize state changes
  mainWindow.on('maximize', () => mainWindow.webContents.send('wt:maximizeChange', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('wt:maximizeChange', false));

  return mainWindow;
}

// ── IPC window controls ──────────────────────────────────────────────────────
ipcMain.on('wt:minimize', () => mainWindow?.minimize());
ipcMain.on('wt:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('wt:close', () => mainWindow?.close());
ipcMain.handle('wt:isMaximized', () => mainWindow?.isMaximized() ?? false);

async function launch() {
  createSplash();

  const backendHealthUrl = `http://${HOST}:${BACKEND_PORT}/health`;
  const frontendUrl = `http://${HOST}:${FRONTEND_PORT}/`;

  // Start backend if not already running.
  try {
    await waitForUrl(backendHealthUrl, 1200);
  } catch {
    startBackend();
    await waitForUrl(backendHealthUrl);
  }

  // Start frontend if not already running.
  try {
    await waitForUrl(frontendUrl, 1200);
  } catch {
    startFrontend();
    await waitForUrl(frontendUrl);
  }

  const win = createMainWindow();
  await win.loadURL(frontendUrl);

  // Fade from splash to main window.
  win.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    win.show();
    win.focus();
  });
  // Fallback: if ready-to-show never fires, close splash after 3 s.
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    if (!win.isVisible()) win.show();
  }, 3000);
}

app.whenReady().then(async () => {
  try {
    await launch();
  } catch (error) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox('WatchTower failed to start', error.message);
    stopProcesses();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  stopProcesses();
  app.quit();
});

app.on('before-quit', () => {
  stopProcesses();
});
