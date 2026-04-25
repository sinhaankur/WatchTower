const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage } = require('electron');
const { spawn, execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

// ── GPU / Renderer stability flags ──────────────────────────────────────────
// Must be set before app.whenReady().
//
// On Linux the correct flags depend on the display server and architecture:
//
//   ARM (Raspberry Pi) — VideoCore/V3D GPU has limited desktop-GL support.
//              Force software rendering so Chromium uses SwiftShader (CPU).
//              Electron still renders correctly; Pi 4/5 RAM is sufficient.
//
//   Wayland  — each app has an isolated GPU context; no sandbox workarounds
//              needed. Enable native Wayland window decorations and let
//              Chromium auto-select the best platform backend.
//
//   X11      — Electron apps share the GPU compositor. NVIDIA driver 500+
//              with kernel 6.x causes the Chromium GPU sandbox process to
//              crash with SIGSEGV, which also kills other Electron apps
//              (e.g. VS Code) that share the same GPU compositor.
//              Work around by running GPU in-process with no sandbox.
//
// Software-rendering fallback: set WATCHTOWER_NO_GPU=1 or pass --no-gpu.
if (process.platform === 'linux') {
  const isArm = process.arch === 'arm64' || process.arch === 'arm';

  if (process.argv.includes('--no-gpu') || process.env.WATCHTOWER_NO_GPU === '1' || isArm) {
    // Raspberry Pi / ARM: VideoCore GPU is incompatible with Chromium's desktop-GL
    // path. SwiftShader (software) renders the UI correctly with zero GPU crashes.
    // Also used as an explicit fallback for headless / broken-GPU environments.
    app.disableHardwareAcceleration();
  } else if (process.env.WAYLAND_DISPLAY) {
    // Wayland: native GPU isolation — no sandbox workarounds needed.
    app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  } else {
    // X11 fallback: guard against NVIDIA 500+ / kernel 6.x sandbox crash.
    // Run GPU in the browser process — avoids the sandbox fork that segfaults.
    app.commandLine.appendSwitch('in-process-gpu');
    // Use desktop EGL/OpenGL via NVIDIA instead of SwiftShader.
    app.commandLine.appendSwitch('use-gl', 'desktop');
    // Disable GPU sandbox — causes SIGSEGV on new NVIDIA open drivers.
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    // Avoid ANGLE black-window bug on NVIDIA + X11.
    app.commandLine.appendSwitch('use-angle', 'gl');
    // Reduce GPU memory pressure during startup.
    app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
  }
}

const HOST = '127.0.0.1';
const FRONTEND_PORT = 5222;
const BACKEND_PORT = 8000;

/**
 * Find all PIDs listening on `port`, kill them (SIGTERM then SIGKILL),
 * and wait for the port to be released before returning.
 *
 * Works on Linux (uses `ss`) and macOS (uses `lsof`).
 * On Windows it uses `netstat` + `taskkill`.
 * Safe no-op if nothing is on the port.
 */
async function killPortProcesses(port) {

  /** Return an array of integer PIDs listening on the given port. */
  function findPids(p) {
    try {
      if (process.platform === 'win32') {
        // netstat -ano | findstr ":PORT "
        const out = execSync(`netstat -ano | findstr ":${p} "`, { timeout: 3000 }).toString();
        const pids = new Set();
        for (const line of out.split('\n')) {
          const m = line.trim().match(/LISTENING\s+(\d+)/);
          if (m) pids.add(Number(m[1]));
        }
        return [...pids];
      } else {
        // Try lsof first (available on macOS and most Linux distros).
        try {
          const out = execSync(`lsof -ti tcp:${p} 2>/dev/null`, { timeout: 3000 }).toString();
          return out.trim().split('\n').filter(Boolean).map(Number);
        } catch {}
        // Fallback: ss (Linux only).
        try {
          const out = execSync(`ss -tlnp "sport = :${p}" 2>/dev/null`, { timeout: 3000 }).toString();
          const pids = new Set();
          for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
          return [...pids];
        } catch {}
      }
    } catch {}
    return [];
  }

  const pids = findPids(port);
  if (pids.length === 0) return;   // port is free — nothing to do

  console.log(`[WatchTower] Port ${port} occupied by PID(s) ${pids.join(', ')} — killing…`);

  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 3000 });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch { /* process may have already exited */ }
  }

  // Give processes up to 2 s to die; escalate to SIGKILL if still alive (Unix only).
  if (process.platform !== 'win32') {
    await new Promise(r => setTimeout(r, 800));
    for (const pid of pids) {
      const stillAlive = findPids(port).includes(pid);
      if (stillAlive) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  }

  // Wait for the OS to release the port (up to 3 s).
  const deadline = Date.now() + 3000;
  await new Promise(resolve => {
    const poll = () => {
      const probe = net.createConnection({ host: HOST, port }, () => { probe.destroy(); });
      probe.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          resolve();  // port is free
        } else if (Date.now() < deadline) {
          setTimeout(poll, 200);
        } else {
          resolve();  // give up waiting, try to bind anyway
        }
      });
      probe.on('connect', () => {
        probe.destroy();
        if (Date.now() < deadline) setTimeout(poll, 200); else resolve();
      });
    };
    poll();
  });

  console.log(`[WatchTower] Port ${port} is now free.`);
}

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

// ── Single-instance lock ─────────────────────────────────────────────────────
// Prevents a second Electron process from opening a duplicate splash window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance is already running — focus it and exit immediately.
  app.quit();
}

app.on('second-instance', () => {
  // If the user tries to open a second instance, just focus the existing window.
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let backendProcess;
let frontendProcess;
let staticServer;   // Node http.Server for pre-built static files
let splashWindow;
let mainWindow;
let tray = null;
let isQuitting = false;

// MIME types for the built-in static file server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webp': 'image/webp',
  '.txt':  'text/plain',
};

/**
 * Serve web/dist/ as a fast static HTTP server with an /api proxy.
 * Starts in <100 ms — no Vite JIT compilation.
 */
function startStaticServer(distDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];

      // Proxy /api/* requests to the backend
      if (urlPath.startsWith('/api')) {
        const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        const opts = {
          hostname: HOST,
          port: BACKEND_PORT,
          path: urlPath + query,
          method: req.method,
          headers: { ...req.headers, host: `${HOST}:${BACKEND_PORT}` },
        };
        const proxy = http.request(opts, (upstream) => {
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(res, { end: true });
        });
        proxy.on('error', () => { res.writeHead(502); res.end('Bad Gateway'); });
        req.pipe(proxy, { end: true });
        return;
      }

      // Static files with SPA fallback
      // Resolve and guard against path traversal (e.g. /../../../etc/passwd)
      const resolved = path.resolve(distDir, urlPath.replace(/^\//, ''));
      let filePath = resolved.startsWith(distDir + path.sep) || resolved === distDir
        ? resolved
        : path.join(distDir, 'index.html');
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }

      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const isIndex = filePath.endsWith('index.html');

      // Security headers on every response
      const securityHeaders = {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        // Tight CSP: same-origin only; connect-src allows localhost API
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          `connect-src 'self' http://${HOST}:${BACKEND_PORT}; img-src 'self' data:; font-src 'self' data:;`,
        // No caching for index.html (always re-check); long-lived cache for hashed assets
        'Cache-Control': isIndex
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
      };

      let stat;
      try { stat = fs.statSync(filePath); } catch {
        res.writeHead(404, securityHeaders);
        res.end('Not found');
        return;
      }

      res.writeHead(200, { ...securityHeaders, 'Content-Length': stat.size });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(FRONTEND_PORT, HOST, () => resolve(server));
    server.on('error', reject);
  });
}

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
        setTimeout(attempt, 300);
      });
      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function startBackend() {
  // Kill any process already holding the backend port (stale uvicorn, container, etc.)
  await killPortProcesses(BACKEND_PORT);

  const python = resolvePython();
  backendProcess = spawn(
    python,
    [
      '-m', 'uvicorn', 'watchtower.api:app',
      '--app-dir', repoRoot,
      '--host', HOST,
      '--port', String(BACKEND_PORT),
      '--no-access-log',       // less I/O overhead
      '--timeout-keep-alive', '5',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        WATCHTOWER_API_TOKEN: runtimeApiToken,
        // Do NOT propagate dev-only overrides into the desktop process.
        WATCHTOWER_ALLOW_INSECURE_DEV_AUTH: undefined,
      },
      stdio: 'inherit',
    }
  );
}

async function startFrontend() {
  // Kill any process already holding the frontend port (stale Vite, previous run, etc.)
  await killPortProcesses(FRONTEND_PORT);

  const distIndex = path.join(webRoot, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    // Fast path: serve the pre-built static files (<100 ms startup)
    staticServer = await startStaticServer(path.join(webRoot, 'dist'));
  } else {
    // Fallback: Vite dev server (first-run / dev mode)
    frontendProcess = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'dev', '--', '--host', HOST, '--port', String(FRONTEND_PORT), '--strictPort'],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          VITE_API_TOKEN: runtimeApiToken,
          VITE_API_URL: `http://${HOST}:${BACKEND_PORT}/api`,
        },
        stdio: 'inherit',
      }
    );
  }
}

function stopProcesses() {
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
  if (frontendProcess && !frontendProcess.killed) frontendProcess.kill();
  if (staticServer) { try { staticServer.close(); } catch {} staticServer = null; }
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

// ── GitHub OAuth popup ───────────────────────────────────────────────────────
let oauthPopup = null;

// Allowlisted GitHub OAuth origins — reject anything the renderer sends that
// isn't a real GitHub login URL (prevents open-redirect / XSS via IPC).
const OAUTH_ALLOWED_ORIGINS = new Set(['https://github.com']);

ipcMain.on('wt:openOAuth', (_event, url) => {
  // Validate before opening any window.
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  const origin = `${parsed.protocol}//${parsed.hostname}`;
  if (!OAUTH_ALLOWED_ORIGINS.has(origin)) {
    console.warn(`[WatchTower] Blocked OAuth popup to untrusted origin: ${origin}`);
    return;
  }

  if (oauthPopup && !oauthPopup.isDestroyed()) {
    oauthPopup.focus();
    return;
  }
  oauthPopup = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'Sign in with GitHub',
    parent: mainWindow ?? undefined,
    modal: false,
    autoHideMenuBar: true,
    ...(APP_ICON ? { icon: APP_ICON } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Use the same session as the main window so localStorage is shared.
      session: mainWindow?.webContents.session,
    },
  });
  oauthPopup.loadURL(url);
  oauthPopup.on('closed', () => { oauthPopup = null; });
});

ipcMain.on('wt:oauthDone', () => {
  if (oauthPopup && !oauthPopup.isDestroyed()) {
    oauthPopup.close();
    oauthPopup = null;
  }
  // Reload the main window so it picks up the newly stored auth token.
  mainWindow?.webContents.reload();
});

async function launch() {
  createSplash();

  const backendHealthUrl = `http://${HOST}:${BACKEND_PORT}/health`;
  const frontendUrl = `http://${HOST}:${FRONTEND_PORT}/`;

  // Start backend if not already running.
  try {
    await waitForUrl(backendHealthUrl, 1200);
  } catch {
    await startBackend();
    await waitForUrl(backendHealthUrl);
  }

  // Start frontend if not already running.
  try {
    await waitForUrl(frontendUrl, 1200);
  } catch {
    await startFrontend();
    // Static server resolves when listening; Vite dev still needs a poll.
    if (frontendProcess) await waitForUrl(frontendUrl);
  }

  const win = createMainWindow();

  // Helper: close splash and show the main window (idempotent).
  let shown = false;
  function showMain() {
    if (shown) return;
    shown = true;
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
    if (!win.isDestroyed()) { win.show(); win.focus(); }
  }

  // Register BEFORE loadURL so events are never missed.
  win.once('ready-to-show', showMain);
  win.webContents.once('did-finish-load', showMain);
  win.webContents.once('dom-ready', showMain);
  win.webContents.once('did-fail-load', showMain);

  // Hard fallback: services are already up, 5 s is plenty.
  setTimeout(showMain, 5000);

  // Fire-and-forget — visibility is handled by the events above.
  win.loadURL(frontendUrl).catch(() => showMain());
}

function createTray() {
  const iconPath = APP_ICON || path.join(iconsDir, 'favicon-128.png');
  tray = new Tray(iconPath);
  tray.setToolTip('WatchTower');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open WatchTower',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        stopProcesses();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

app.whenReady().then(async () => {
  try {
    await launch();
    createTray();

    // Hide to tray instead of quitting when the window X is clicked.
    mainWindow?.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault();
        mainWindow.hide();
        // Show a one-time hint on Linux/Windows (macOS uses the dock).
        if (process.platform !== 'darwin' && tray) {
          tray.displayBalloon && tray.displayBalloon({
            iconType: 'info',
            title: 'WatchTower',
            content: 'Running in the background. Click the tray icon to reopen.',
          });
        }
      }
    });
  } catch (error) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox('WatchTower failed to start', error.message);
    stopProcesses();
    app.quit();
  }
});

// On macOS re-clicking the dock icon should show the window.
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// Keep the app alive even when all windows are closed (tray mode).
app.on('window-all-closed', () => {
  // Do nothing — tray keeps the app running.
  // Quit is only triggered from the tray context menu.
});

app.on('before-quit', () => {
  isQuitting = true;
  stopProcesses();
});
