const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
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

let backendProcess;
let frontendProcess;

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
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
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
    [
      '-m',
      'uvicorn',
      'watchtower.api:app',
      '--app-dir',
      repoRoot,
      '--host',
      HOST,
      '--port',
      String(BACKEND_PORT),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        WATCHTOWER_ALLOW_INSECURE_DEV_AUTH: process.env.WATCHTOWER_ALLOW_INSECURE_DEV_AUTH || 'true',
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
      env: process.env,
      stdio: 'inherit',
    }
  );
}

function stopProcesses() {
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
  if (frontendProcess && !frontendProcess.killed) frontendProcess.kill();
}

async function createWindow() {
  const backendHealthUrl = `http://${HOST}:${BACKEND_PORT}/health`;
  const frontendUrl = `http://${HOST}:${FRONTEND_PORT}/`;

  // Reuse existing local services when available; otherwise start them.
  try {
    await waitForUrl(backendHealthUrl, 1200);
  } catch {
    startBackend();
    await waitForUrl(backendHealthUrl);
  }

  try {
    await waitForUrl(frontendUrl, 1200);
  } catch {
    startFrontend();
    await waitForUrl(frontendUrl);
  }

  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 740,
    autoHideMenuBar: true,
    title: 'WatchTower',
    backgroundColor: '#f9fafb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(frontendUrl);
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
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
