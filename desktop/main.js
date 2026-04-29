const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell, Tray, nativeImage } = require('electron');
const { spawn, execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

// ── Resolve npm binary ───────────────────────────────────────────────────────
// Electron does not inherit the shell PATH on Linux/macOS, so plain 'npm'
// may not be found when spawned as a child process.  Resolve it once at
// startup: prefer the npm sitting next to the node binary that is running
// this process (works for nvm, volta, system node), otherwise fall back to
// the bare name and rely on whatever PATH is available.
function resolveNpm() {
  if (process.platform === 'win32') return 'npm.cmd';
  const candidate = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(candidate) ? candidate : 'npm';
}
const NPM_BIN = resolveNpm();

// ── Auto-updater (GitHub Releases) ──────────────────────────────────────────
// electron-updater checks the GitHub Release for a newer version and
// downloads + installs it automatically. The publish config in package.json
// points at sinhaankur/WatchTower — the same repo that release.yml pushes to.
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  // Opt out of Squirrel on Windows — we use NSIS which handles its own installer.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;   // silence file logger; we surface messages via dialog
} catch {
  // electron-updater is a runtime dep but may be missing in dev (no node_modules).
  // Silently skip auto-update rather than crashing.
}

/**
 * Fire-and-forget update check called once after the main window is shown.
 * Shows a non-blocking notification dialog; never interrupts the user mid-task.
 *
 * Strategy:
 *  - Packaged build with electron-updater: use autoUpdater (downloads + installs).
 *  - Dev / unpackaged build: fall back to GitHub Releases API — compare versions
 *    and show a dialog with a link to the release page. No auto-install in dev.
 */
function checkForAppUpdates(win) {
  if (!win || win.isDestroyed()) return;

  // ── Packaged path: electron-updater handles download + install ─────────────
  if (autoUpdater && app.isPackaged) {
    autoUpdater.on('update-available', (info) => {
      if (win.isDestroyed()) return;
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Available',
        message: `WatchTower ${info.version} is available`,
        detail: "Downloading in the background. You'll be prompted to restart when it's ready.",
        buttons: ['OK'],
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      if (win.isDestroyed()) return;
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `WatchTower ${info.version} is ready to install`,
        detail: 'Restart WatchTower now to apply the update, or do it later from the tray menu.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall(false, true);
      });
    });

    autoUpdater.on('error', (err) => {
      console.warn('[WatchTower] Auto-update check failed:', err.message);
    });

    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[WatchTower] Auto-update check error:', err.message);
      // Fall through to GitHub API check on electron-updater failure
      checkForUpdatesViaGitHubAPI(win, false);
    });
    return;
  }

  // ── Unpackaged / dev path: GitHub Releases API ─────────────────────────────
  checkForUpdatesViaGitHubAPI(win, false);
}

/**
 * Check for a newer release on GitHub using the public API.
 * @param {BrowserWindow} win   - Parent window for dialogs.
 * @param {boolean} interactive - If true, always show a result dialog (manual check).
 *                                If false, only show a dialog when an update is found.
 */
function checkForUpdatesViaGitHubAPI(win, interactive) {
  if (!win || win.isDestroyed()) return;

  const currentVersion = app.getVersion(); // from desktop/package.json
  const apiUrl = 'https://api.github.com/repos/sinhaankur/WatchTower/releases/latest';

  const options = {
    hostname: 'api.github.com',
    path: '/repos/sinhaankur/WatchTower/releases/latest',
    headers: {
      'User-Agent': `WatchTower-Desktop/${currentVersion}`,
      'Accept': 'application/vnd.github+json',
    },
    timeout: 10000,
  };

  const req = https.get(options, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) {
          console.warn(`[WatchTower] GitHub update check returned ${res.statusCode}`);
          if (interactive && !win.isDestroyed()) {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'Update Check',
              message: 'Could not reach GitHub to check for updates.',
              detail: 'Check your internet connection and try again.',
              buttons: ['OK'],
            });
          }
          return;
        }
        const data = JSON.parse(body);
        const latestTag = (data.tag_name || '').replace(/^v/, '');
        const releaseUrl = data.html_url || 'https://github.com/sinhaankur/WatchTower/releases';
        const releaseNotes = (data.body || '').slice(0, 400) || 'See release page for details.';

        if (!latestTag) return;

        const isNewer = compareVersions(latestTag, currentVersion) > 0;

        if (isNewer) {
          if (win.isDestroyed()) return;
          // Update Now is offered in two modes:
          //   - Packaged build: trigger electron-updater's download+install
          //     so the user doesn't have to visit the release page at all.
          //   - Dev clone (./run.sh desktop, npm start): run `git pull`
          //     plus the deps/build steps and restart the app in-place,
          //     so iterating on a dev branch is one click instead of a
          //     terminal session.
          dialog.showMessageBox(win, {
            type: 'info',
            title: 'Update Available',
            message: `WatchTower ${latestTag} is available (you have ${currentVersion})`,
            detail: `${releaseNotes}\n\n` +
              (app.isPackaged
                ? 'Click Update Now to download and install in the background.'
                : 'Click Update Now to git pull + rebuild + restart from this dev clone.'),
            buttons: ['Update Now', 'Open Release Page', 'Later'],
            defaultId: 0,
            cancelId: 2,
          }).then(({ response }) => {
            if (response === 1) {
              shell.openExternal(releaseUrl);
              return;
            }
            if (response === 0) {
              void runUpdateNow(win, releaseUrl);
            }
          });
        } else if (interactive) {
          if (win.isDestroyed()) return;
          dialog.showMessageBox(win, {
            type: 'info',
            title: 'No Update Found',
            message: `WatchTower ${currentVersion} is already up to date.`,
            buttons: ['OK'],
          });
        }
      } catch (e) {
        console.warn('[WatchTower] GitHub update parse error:', e.message);
        if (interactive && !win.isDestroyed()) {
          dialog.showMessageBox(win, {
            type: 'info',
            title: 'Update Check',
            message: 'Could not parse update response from GitHub.',
            buttons: ['OK'],
          });
        }
      }
    });
  });

  req.on('error', (err) => {
    console.warn('[WatchTower] GitHub update check network error:', err.message);
    if (interactive && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Check',
        message: 'Could not reach GitHub to check for updates.',
        detail: 'Check your internet connection and try again.',
        buttons: ['OK'],
      });
    }
  });

  req.on('timeout', () => {
    req.destroy();
    console.warn('[WatchTower] GitHub update check timed out.');
  });
}

/**
 * Apply an available update.
 *
 * Two execution paths:
 *
 *   - **Packaged build**: hand off to electron-updater. Existing handlers
 *     in checkForAppUpdates wire `update-downloaded` → "Restart Now"
 *     prompt. We just kick off the download and let those hooks fire.
 *
 *   - **Dev clone (unpackaged)**: shell out to ``git pull`` from the repo
 *     root, then ``npm --prefix web install && run build`` so the SPA
 *     bundle reflects the new commit, then `app.relaunch()` + `app.exit()`.
 *     This is what `./run.sh update` does — wired into the UI so the
 *     "click here to update" path doesn't require a terminal.
 *
 * Errors fall back to the release page (same affordance the user had
 * before this button existed).
 */
async function runUpdateNow(win, releaseUrl) {
  if (app.isPackaged) {
    if (!autoUpdater) {
      shell.openExternal(releaseUrl);
      return;
    }
    try {
      // checkForUpdates() emits 'update-available' which the listener
      // installed in checkForAppUpdates() will pick up. Once downloaded,
      // it shows the "Restart Now" prompt.
      await autoUpdater.checkForUpdates();
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Updating WatchTower',
        message: 'Downloading update in the background.',
        detail: "You'll be prompted to restart when the download completes.",
        buttons: ['OK'],
      });
    } catch (err) {
      console.warn('[WatchTower] autoUpdater download failed:', err.message);
      shell.openExternal(releaseUrl);
    }
    return;
  }

  // Dev clone path — run `git pull`, install, build, relaunch.
  const repoRoot = path.resolve(__dirname, '..');
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Update Now unavailable',
      message: 'This install is not a git clone — open the release page to download the new installer.',
      buttons: ['Open Release Page', 'Cancel'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal(releaseUrl);
    });
    return;
  }

  // Run `./run.sh update` — handles git pull + reinstall + rebuild.
  const updateScript = path.join(repoRoot, 'run.sh');
  if (!fs.existsSync(updateScript)) {
    shell.openExternal(releaseUrl);
    return;
  }

  // Show a non-cancellable progress dialog while the update runs. Don't
  // try to make this fancy — the script is the source of truth.
  const progressMsg = dialog.showMessageBox(win, {
    type: 'info',
    title: 'Updating WatchTower',
    message: 'Pulling latest changes and rebuilding…',
    detail: 'This may take a minute on first run. The app will restart automatically.',
    buttons: [],
  });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn('bash', [updateScript, 'update'], {
        cwd: repoRoot,
        env: process.env,
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`run.sh update exited with code ${code}: ${stderr.slice(-500)}`));
      });
      child.on('error', reject);
    });
    // Give the dialog a moment to dismiss before we relaunch.
    await new Promise((r) => setTimeout(r, 200));
    app.relaunch();
    app.exit(0);
  } catch (err) {
    console.error('[WatchTower] Update Now failed:', err.message);
    dialog.showErrorBox(
      'Update Now failed',
      `${err.message}\n\nFalling back to the release page so you can install manually.`
    );
    shell.openExternal(releaseUrl);
  }

  // Mark the dialog promise as awaited even if the user is fast (rare,
  // since stdio buffering keeps this around for at least a few seconds).
  void progressMsg;
}


/**
 * Simple semver comparison. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Handles versions like "1.2.3", "1.2.3-beta.1".
 */
function compareVersions(a, b) {
  const parse = (v) => v.replace(/[^0-9.]/g, '').split('.').map(Number);
  const [aParts, bParts] = [parse(a), parse(b)];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}


// ── GPU / Renderer stability flags ──────────────────────────────────────────
// Must be set before app.whenReady().
//
// On Linux the correct GPU strategy depends on display server and architecture:
//
//   Wayland  — each app has an isolated GPU context; no workarounds needed.
//              Enable native Wayland window decorations and auto-select backend.
//
//   X11 / ARM / no-gpu — use SwiftShader software rendering via
//              disableHardwareAcceleration(). NVIDIA driver 500+ on kernel 6.x
//              crashes the Chromium GPU process (SIGSEGV in SharedImageStub)
//              regardless of EGL/ANGLE/sandbox flags. SwiftShader is bundled
//              in Electron, renders the UI correctly, and avoids the crash
//              entirely. For a dashboard app the CPU rendering overhead is
//              negligible. ARM (Pi) and headless also use this path.
if (process.platform === 'linux') {
  // Disable Chromium's Linux sandbox layers.
  //
  // On kernel 6.x (notably 6.17 on Ubuntu 24.04) Electron 31's namespace +
  // seccomp sandbox aborts every renderer with ESRCH ("Creating shared
  // memory in /tmp/... failed: No such process") before the page can load,
  // so the user sees no window at all when launching the app — only the
  // splash + zygote/gpu helper processes start. The chrome-sandbox SUID
  // helper is also frequently missing the SUID bit in npm-installed
  // node_modules, AppImage runs, Snap/Flatpak, or distros that disable
  // unprivileged user namespaces. All four flags are required together;
  // --no-sandbox alone is not enough on kernel 6.17. Disabling the sandbox
  // is safe for WatchTower because the window only loads local, trusted
  // content (the bundled frontend on 127.0.0.1).
  //
  // These switches must be set before app.whenReady().
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  app.commandLine.appendSwitch('disable-namespace-sandbox');
  app.commandLine.appendSwitch('disable-seccomp-filter-sandbox');

  if (process.env.WAYLAND_DISPLAY && !process.argv.includes('--no-gpu') && process.env.WATCHTOWER_NO_GPU !== '1') {
    // Wayland: native GPU isolation — no further workarounds needed.
    app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  } else {
    // X11, ARM, explicit --no-gpu / WATCHTOWER_NO_GPU=1:
    // Use SwiftShader (CPU software renderer bundled in Electron).
    // Avoids all GPU driver crashes on NVIDIA 500+ + kernel 6.x + X11.
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
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

/**
 * Resolve a writable directory for the backend's data files (SQLite DB,
 * Fernet secret key, etc.). Honours WATCHTOWER_DATA_DIR if set, else
 * defaults to ~/.watchtower (always writable; same place
 * `_ensure_secret_key()` already uses).
 */
function writableDataDir() {
  const explicit = process.env.WATCHTOWER_DATA_DIR;
  if (explicit) return explicit;
  const home = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  return path.join(home, '.watchtower');
}

/**
 * Resolve where the SPA bundle (web/dist) lives.
 *
 * Priority:
 *   1. dev-clone path: <repoRoot>/web/dist — used when running from a
 *      source checkout (./run.sh desktop).
 *   2. extraResources path: <process.resourcesPath>/web-dist — used when
 *      running from a packaged AppImage / dmg / nsis. electron-builder
 *      copies web/dist into resources/web-dist (see
 *      desktop/package.json's `extraResources`).
 *
 * Without (2), a packaged build would have no SPA at all — the
 * pip-installed watchtower wheel doesn't include web/dist, and the
 * relative-path fallback in `api/__init__.py:_WEB_DIST` would
 * resolve to a missing site-packages/web/dist.
 */
function resolveWebDist() {
  const devPath = path.join(repoRoot, 'web', 'dist');
  if (fs.existsSync(path.join(devPath, 'index.html'))) return devPath;
  const packagedPath = path.join(process.resourcesPath || '', 'web-dist');
  if (fs.existsSync(path.join(packagedPath, 'index.html'))) return packagedPath;
  // Returning the dev path as the last resort lets the backend fall back
  // to its JSON health response gracefully if neither location exists.
  return devPath;
}

// Where to find the Python backend + the SPA bundle. Resolution order:
//   1. WATCHTOWER_APP_DIR env override — explicit user choice (e.g. point
//      a packaged AppImage at a separately-installed dev clone).
//   2. ../ relative to main.js — the dev-clone layout (~/.../WatchTower/desktop/main.js
//      → repoRoot = ~/.../WatchTower/). Works when running from source.
//
// For packaged builds the relative-path resolution lands INSIDE the asar,
// where there's no .venv or web/dist. resolvePython() and resolveWebRoot()
// fall back to a system Python and to a per-user data directory (~/.watchtower)
// so the AppImage works even without a source clone.
const repoRoot = process.env.WATCHTOWER_APP_DIR || path.resolve(__dirname, '..');
const webRoot = path.join(repoRoot, 'web');
const pythonUnix = path.join(repoRoot, '.venv', 'bin', 'python');
const pythonWin = path.join(repoRoot, '.venv', 'Scripts', 'python.exe');
const runtimeApiToken = process.env.WATCHTOWER_API_TOKEN || `wt-${crypto.randomBytes(24).toString('hex')}`;

function isGithubOauthConfigured() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET;
  return Boolean(clientId && clientSecret);
}

function shouldAutoAuthDesktop() {
  // Explicit override for local/dev automation.
  if (process.env.WATCHTOWER_DESKTOP_AUTO_AUTH === '1') return true;
  if (process.env.WATCHTOWER_DESKTOP_AUTO_AUTH === '0') return false;
  // Default behavior:
  // - OAuth configured => require per-user login.
  // - OAuth not configured => keep bootstrap token login for local usability.
  return !isGithubOauthConfigured();
}

// Resolve the best available icon for this platform.
const iconsDir = path.join(__dirname, 'build', 'icons');

function isLoadableImage(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const img = nativeImage.createFromPath(filePath);
    return !img.isEmpty();
  } catch {
    return false;
  }
}

function resolveAppIcon() {
  // Only offer formats the current OS can actually load.
  const candidates =
    process.platform === 'darwin'
      ? [path.join(iconsDir, 'app.icns'), path.join(iconsDir, 'favicon-128.png')]
      : process.platform === 'win32'
      ? [path.join(iconsDir, 'app.ico'), path.join(iconsDir, 'favicon-128.png')]
      : /* linux / other */
        [path.join(iconsDir, 'favicon-128.png'), path.join(iconsDir, 'favicon-96.png')];
  for (const f of candidates) {
    if (isLoadableImage(f)) return f;
  }
  return undefined;
}
const APP_ICON = resolveAppIcon();

// ── Single-instance lock ─────────────────────────────────────────────────────

// Expose the per-launch API token to the renderer via synchronous IPC.
// The preload script calls this before React boots so the token is already
// in localStorage when the first useEffect runs.
//
// Token injection is safe only when:
//   (a) WATCHTOWER_API_TOKEN was explicitly set in the environment (user knows it), OR
//   (b) Electron spawned the backend itself (so runtimeApiToken is guaranteed to match).
ipcMain.on('wt:getAuthBootstrap', (event) => {
  const tokenIsKnown = Boolean(process.env.WATCHTOWER_API_TOKEN) || electronSpawnedBackend;
  event.returnValue = {
    autoAuth: shouldAutoAuthDesktop(),
    apiToken: tokenIsKnown ? runtimeApiToken : null,
  };
});

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
// True when this Electron process started the backend itself.
// Only then is runtimeApiToken guaranteed to match the running server.
let electronSpawnedBackend = false;
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
          `connect-src 'self' http://${HOST}:${BACKEND_PORT} ws://${HOST}:${BACKEND_PORT}; img-src 'self' data:; font-src 'self' data:;`,
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

    // Proxy WebSocket upgrade requests (e.g. /api/ws/builds/…/logs) to the backend.
    server.on('upgrade', (req, socket, head) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (!urlPath.startsWith('/api')) {
        socket.destroy();
        return;
      }
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const opts = {
        hostname: HOST,
        port: BACKEND_PORT,
        path: urlPath + query,
        headers: { ...req.headers, host: `${HOST}:${BACKEND_PORT}` },
      };
      const proxyReq = http.request(opts);
      proxyReq.on('upgrade', (_proxyRes, proxySocket, proxyHead) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
        );
        if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
    });
  });
}

/**
 * Pick a Python interpreter that has the watchtower backend importable.
 *
 * Resolution order:
 *   1. Project-local `.venv/bin/python` — present in dev clones; preferred
 *      because it has the exact pinned dependency versions.
 *   2. `WATCHTOWER_PYTHON` env override — explicit user choice.
 *   3. System `python3` / `python` — covers users who installed the
 *      backend via `pip install watchtower-podman` system-wide. We
 *      probe `import watchtower` to confirm the package is reachable
 *      before trusting it; otherwise the spawn would later fail with a
 *      cryptic ModuleNotFoundError.
 *   4. Return null — signals "no python found" to startBackend(), which
 *      raises a clean dialog telling the user how to install the deps.
 */
function resolvePython() {
  if (fs.existsSync(pythonUnix)) return pythonUnix;
  if (fs.existsSync(pythonWin)) return pythonWin;

  const explicit = process.env.WATCHTOWER_PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const candidates = process.platform === 'win32'
    ? ['python3.exe', 'python.exe', 'python']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      // Probe for both the binary AND the watchtower package — a system
      // python without `pip install watchtower-podman` is useless to us.
      execSync(`${cmd} -c "import watchtower"`, { stdio: 'ignore', timeout: 5000 });
      return cmd;
    } catch { /* not this one */ }
  }
  return null; // surfaced as a clear error in startBackend()
}

// Tracks whether the backend process has died — wired up by startBackend().
// waitForUrl checks this and rejects immediately so we don't sit on the
// splash for 120 s waiting for a process that's already gone.
let backendExited = false;
let backendExitReason = '';

function waitForUrl(url, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = () => {
      // Backend died while we were polling — fail the wait now instead of
      // exhausting the timeout. The exit reason is captured by the
      // backendProcess.on('exit') hook in startBackend().
      if (backendExited) {
        reject(new Error(`Backend exited before responding: ${backendExitReason}`));
        return;
      }
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
        if (backendExited) {
          reject(new Error(`Backend exited before responding: ${backendExitReason}`));
          return;
        }
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
  if (!python) {
    // No usable Python interpreter found. Three paths the user can take:
    //   * pip install watchtower-podman   (recommended for end users)
    //   * Set WATCHTOWER_PYTHON to an existing python with watchtower
    //   * Set WATCHTOWER_APP_DIR to a source clone with .venv built
    throw new Error(
      "Python backend not found. WatchTower needs Python with the\n" +
      "'watchtower' package installed. Pick one:\n\n" +
      "  1. Install system-wide:\n" +
      "       pip install watchtower-podman\n\n" +
      "  2. Use a source clone:\n" +
      "       git clone https://github.com/sinhaankur/WatchTower\n" +
      "       cd WatchTower && ./run.sh   (creates .venv)\n" +
      "       Then set WATCHTOWER_APP_DIR=/path/to/WatchTower\n\n" +
      "  3. Point at a custom Python:\n" +
      "       export WATCHTOWER_PYTHON=/path/to/python\n\n" +
      "Searched: " + pythonUnix
    );
  }

  // Tee backend stdout/stderr to a log file so users can diagnose without
  // journalctl. stdio:'inherit' would send output to a detached terminal
  // that doesn't exist when launched from a .desktop file.
  //
  // Path resolution: prefer the dev clone's `.dev/` (preserves existing
  // diagnostic UX for source-clone runs), but fall back to the writable
  // data dir (`~/.watchtower/logs/`) when the dev clone is read-only —
  // i.e. always for packaged AppImage launches, where repoRoot lives
  // inside the FUSE mount.
  // Without this fallback, `fs.openSync(... 'a')` throws on the
  // read-only mount, startBackend() aborts before spawning, and the
  // splash hangs (or the desktop smoke test times out at 90 s with no
  // backend ever having been launched).
  let backendLogPath;
  let backendLogFd;
  const devCloneLogDir = path.join(repoRoot, '.dev');
  try {
    fs.mkdirSync(devCloneLogDir, { recursive: true });
    backendLogPath = path.join(devCloneLogDir, 'desktop-backend.log');
    backendLogFd = fs.openSync(backendLogPath, 'a');
  } catch {
    const fallbackDir = path.join(writableDataDir(), 'logs');
    fs.mkdirSync(fallbackDir, { recursive: true });
    backendLogPath = path.join(fallbackDir, 'desktop-backend.log');
    backendLogFd = fs.openSync(backendLogPath, 'a');
  }
  try {
    fs.writeSync(backendLogFd, `\n--- desktop launch ${new Date().toISOString()} ---\n`);
  } catch {}

  electronSpawnedBackend = true;
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
      // cwd MUST be writable — the backend's default DATABASE_URL used to be
      // sqlite:///./watchtower.db, which would try to create the file in cwd.
      // For packaged AppImages the natural cwd (the AppImage's FUSE mount)
      // is read-only and SQLite can't open a writable connection. We override
      // DATABASE_URL below so cwd doesn't actually matter for the DB any more,
      // but plenty of Python libs still log/cache things relative to cwd, so
      // point it at the writable data dir.
      cwd: writableDataDir(),
      env: {
        ...process.env,
        WATCHTOWER_API_TOKEN: runtimeApiToken,
        // Stable identity across restarts — the email-based fallback lookup in
        // _ensure_user_org_member uses this to find the same DB user even when
        // runtimeApiToken (and thus the uuid5-derived user_id) changes.
        // Match the browser-mode default so the email-based fallback in
        // _ensure_user_org_member always resolves the same DB user across
        // browser↔desktop switches and across restarts with new random tokens.
        WATCHTOWER_DEFAULT_USER_EMAIL: process.env.WATCHTOWER_DEFAULT_USER_EMAIL || 'developer@watchtower.local',
        WATCHTOWER_DEFAULT_USER_NAME:  process.env.WATCHTOWER_DEFAULT_USER_NAME  || 'WatchTower Developer',
        // Desktop is single-user — disable the multi-user owner-mode claim
        // system so it never blocks access with "not invited" 403s.
        WATCHTOWER_INSTALL_OWNER_MODE: process.env.WATCHTOWER_INSTALL_OWNER_MODE || 'false',
        // Do NOT propagate dev-only overrides into the desktop process.
        WATCHTOWER_ALLOW_INSECURE_DEV_AUTH: undefined,
        // Tell the backend where to keep its data + where to find the SPA
        // bundle. Without these, a packaged AppImage either crashes
        // (sqlite write to read-only mount) or serves the JSON health
        // shell instead of the React SPA (the wheel doesn't ship web/dist).
        WATCHTOWER_DATA_DIR: writableDataDir(),
        WATCHTOWER_WEB_DIST: process.env.WATCHTOWER_WEB_DIST || resolveWebDist(),
      },
      stdio: ['ignore', backendLogFd, backendLogFd],
    }
  );

  // Capture an early exit so waitForUrl fails immediately instead of
  // burning the full 120 s timeout. The flag is read by waitForUrl on
  // every poll; the message surfaces in the "WatchTower failed to start"
  // dialog so users see the real cause (segfault, ImportError, port in
  // use, etc.) instead of the generic "Timed out".
  backendExited = false;
  backendExitReason = '';
  backendProcess.once('exit', (code, signal) => {
    backendExited = true;
    backendExitReason =
      `exit code=${code} signal=${signal}. See ${backendLogPath} for details.`;
    if (code !== 0 && code !== null) {
      console.warn(`[WatchTower] backend exited early — ${backendExitReason}`);
    }
  });
}

async function startFrontend() {
  // Legacy path — only reached when WATCHTOWER_DESKTOP_LEGACY_FRONTEND=1
  // is explicitly set. The default (since v1.5.2) loads the SPA from
  // the backend directly on :8000. Kept around so users who want
  // origin-isolated CSP across processes can opt back in.
  await killPortProcesses(FRONTEND_PORT);

  const distIndex = path.join(webRoot, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    // Fast path: serve the pre-built static files (<100 ms startup)
    staticServer = await startStaticServer(path.join(webRoot, 'dist'));
    return;
  }

  // The Vite-dev fallback only makes sense in an unpackaged dev clone
  // where `npm` is on PATH. Packaged builds don't ship npm or web/src,
  // so falling through to `spawn(NPM_BIN)` would crash the main process
  // with a "spawn npm ENOENT" Electron error dialog. Fail with a clear
  // message instead.
  if (app.isPackaged) {
    throw new Error(
      `Frontend bundle not found at ${distIndex}. The packaged build is missing web/dist — please reinstall WatchTower.`
    );
  }

  // Probe npm before spawning so we surface a clean error instead of a
  // dialog about "spawn npm ENOENT" (Electron doesn't inherit the
  // shell PATH on Linux/macOS).
  const npmAvailable =
    NPM_BIN !== 'npm' || (() => {
      try { execSync('npm --version', { stdio: 'ignore', timeout: 2000 }); return true; }
      catch { return false; }
    })();
  if (!npmAvailable) {
    throw new Error(
      `Frontend bundle not found at ${distIndex}, and npm is not on PATH so the Vite ` +
      `dev fallback can't be used. Run \`npm --prefix web run build\` once from a terminal, ` +
      `then re-launch the app.`
    );
  }

  frontendProcess = spawn(
    NPM_BIN,
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

  // If the spawn itself fails (rare — usually caught by the npmAvailable
  // probe above, but covers cases where npm exists but the project's
  // node_modules are missing), reject the launch so the user sees the
  // actual error instead of the splash hanging.
  frontendProcess.on('error', (err) => {
    console.warn('[WatchTower] npm/Vite spawn failed:', err.message);
  });
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

// Native folder picker — used by the SetupWizard's "Local folder" source
// option. A native dialog beats typing an absolute path manually: user
// gets file-system completion, can't typo, and the OS validates the
// folder exists before we even see the path. The renderer receives the
// path string only; we deliberately don't read the folder here — that
// happens in the build pipeline once the user has confirmed.
ipcMain.handle('wt:selectFolder', async (_event, opts = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no-window' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: typeof opts.title === 'string' ? opts.title : 'Select project folder',
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: typeof opts.buttonLabel === 'string' ? opts.buttonLabel : 'Use this folder',
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

// Native OS notification — surfaced from the renderer when long-running
// work finishes (deploy succeeded, build failed, update available, etc).
// The point is desktop affordance: a notification fires even when the
// WatchTower window is minimized or the user is in another workspace,
// which a web app can't do as reliably.
ipcMain.on('wt:showNotification', (_event, payload = {}) => {
  if (!Notification.isSupported()) return;
  const title = typeof payload.title === 'string' ? payload.title : 'WatchTower';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const silent = Boolean(payload.silent);
  try {
    const n = new Notification({
      title,
      body,
      silent,
      ...(APP_ICON ? { icon: APP_ICON } : {}),
    });
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      }
    });
    n.show();
  } catch (err) {
    console.warn('[WatchTower] Notification failed:', err.message);
  }
});

// In-app "Update Now" — same code path as the native modal that fires on
// startup, so the user can trigger an update from a button in the SPA
// without touching a terminal.
ipcMain.handle('wt:updateNow', async (_event, releaseUrl) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no-window' };
  const safeUrl = typeof releaseUrl === 'string' && releaseUrl
    ? releaseUrl
    : 'https://github.com/sinhaankur/WatchTower/releases';
  try {
    await runUpdateNow(mainWindow, safeUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

// ── GitHub OAuth popup ───────────────────────────────────────────────────────
let oauthPopup = null;

// Allowed origins for the OAuth popup. Two valid kinds:
//   1) The WatchTower API server itself (loopback only) — Login.tsx points
//      the popup at /api/auth/github/login, which then 302s to github.com.
//      Without this, the popup is silently rejected and "Sign in" appears
//      to do nothing in the desktop app.
//   2) GitHub itself (or a self-hosted GitHub Enterprise host the operator
//      configured) — for the redirected page once GitHub takes over.
//
// Anything else (e.g. an attacker-controlled URL passed via IPC) is rejected
// to prevent the popup from being weaponised as an open-redirect surface.
function isAllowedOAuthOrigin(parsed) {
  const proto = parsed.protocol;
  const host = parsed.hostname;
  const port = parsed.port;

  // GitHub.com proper.
  if (proto === 'https:' && host === 'github.com') return true;

  // Local API server: HTTP on loopback at the configured backend port.
  // (BACKEND_PORT is the constant the rest of main.js uses — by default 8000.)
  if (proto === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
    if (!port || Number(port) === BACKEND_PORT) return true;
  }

  // Self-hosted GitHub Enterprise: operators set WATCHTOWER_GHE_HOST so the
  // popup can also load their internal GHES login page after redirect.
  const gheHost = (process.env.WATCHTOWER_GHE_HOST || '').trim().toLowerCase();
  if (gheHost && proto === 'https:' && host === gheHost) return true;

  return false;
}

ipcMain.on('wt:openOAuth', (_event, url) => {
  // Validate before opening any window.
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (!isAllowedOAuthOrigin(parsed)) {
    console.warn(
      `[WatchTower] Blocked OAuth popup to untrusted origin: ${parsed.protocol}//${parsed.host}`
    );
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

  // Start backend if not already running. Use a 120s post-spawn wait —
  // the FastAPI lifespan runs init_db() which can take 30-90s on first-
  // run when Alembic migrations stamp/upgrade an empty database on a
  // slow disk. The default 45s in waitForUrl was too tight: users on
  // SD-card-backed Pis or HDD-backed laptops would hit "Timed out
  // waiting for http://127.0.0.1:8000/health" on first launch only.
  try {
    await waitForUrl(backendHealthUrl, 1200);
  } catch {
    await startBackend();
    await waitForUrl(backendHealthUrl, 120000);
  }

  // The FastAPI backend already serves the React SPA from web/dist
  // (see watchtower/api/__init__.py). Pointing the main window directly
  // at the backend eliminates the secondary :5222 server and the entire
  // class of "Timed out waiting for http://127.0.0.1:5222/" failures
  // that came from stale processes, slow Vite cold-starts, or a
  // missing web/dist on the secondary path.
  //
  // Set WATCHTOWER_DESKTOP_LEGACY_FRONTEND=1 to opt back into the
  // separate static-server-on-5222 architecture (preserves the per-
  // origin CSP isolation that the static server applied).
  const useLegacyFrontend = process.env.WATCHTOWER_DESKTOP_LEGACY_FRONTEND === '1';
  const frontendUrl = useLegacyFrontend
    ? `http://${HOST}:${FRONTEND_PORT}/`
    : `http://${HOST}:${BACKEND_PORT}/`;

  if (useLegacyFrontend) {
    // Start frontend server if not already running.
    try {
      await waitForUrl(frontendUrl, 1200);
    } catch {
      await startFrontend();
      // Static server resolves when listening; Vite dev still needs a poll.
      if (frontendProcess) await waitForUrl(frontendUrl);
    }
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
  const fallbackIcon = path.join(iconsDir, 'favicon-128.png');
  const iconPath = isLoadableImage(APP_ICON) ? APP_ICON : (isLoadableImage(fallbackIcon) ? fallbackIcon : null);

  try {
    tray = iconPath ? new Tray(iconPath) : new Tray(nativeImage.createEmpty());
  } catch (error) {
    // Never crash app startup due to a tray icon decode/format issue.
    console.warn('[WatchTower] Tray icon load failed, continuing without icon:', error.message);
    tray = new Tray(nativeImage.createEmpty());
  }

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
      label: 'Check for Updates…',
      enabled: true,
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (autoUpdater && app.isPackaged) {
            autoUpdater.checkForUpdates().catch(() => {
              checkForUpdatesViaGitHubAPI(mainWindow, true);
            });
          } else {
            checkForUpdatesViaGitHubAPI(mainWindow, true);
          }
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

    // Check for updates a few seconds after startup (non-blocking).
    if (mainWindow) {
      // Initial check 5 s after startup.
      setTimeout(() => checkForAppUpdates(mainWindow), 5000);
      // Periodic background re-check every 4 hours.
      setInterval(() => {
        if (mainWindow && !mainWindow.isDestroyed()) checkForAppUpdates(mainWindow);
      }, 4 * 60 * 60 * 1000);
    }

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
    // Pick the first existing log path: dev-clone preferred, fallback to
    // writable data dir (matches the resolution order in startBackend()).
    const candidateLogs = [
      path.join(repoRoot, '.dev', 'desktop-backend.log'),
      path.join(writableDataDir(), 'logs', 'desktop-backend.log'),
    ];
    const backendLogPath = candidateLogs.find((p) => fs.existsSync(p));

    // Surface the failure on stderr too so headless launches (CI, .desktop
    // file with no terminal) leave a trace in journald / xvfb-run output
    // rather than disappearing into a dialog nobody sees.
    console.error('[WatchTower] launch failed:', error.message);
    if (backendLogPath) {
      try {
        const tail = fs.readFileSync(backendLogPath, 'utf-8').split('\n').slice(-30).join('\n');
        console.error('[WatchTower] last 30 lines of backend log:');
        console.error(tail);
      } catch { /* ignore */ }
    }

    const distIndex = path.join(webRoot, 'dist', 'index.html');
    const distExists = fs.existsSync(distIndex);
    const parts = [error.message];
    if (!distExists) {
      parts.push(
        `\nFrontend bundle not found at:\n  ${distIndex}\n` +
        `Build it once with:\n  npm --prefix web install && npm --prefix web run build`
      );
    }
    if (backendLogPath) {
      parts.push(`\nBackend log:\n  ${backendLogPath}`);
    }
    dialog.showErrorBox('WatchTower failed to start', parts.join('\n'));
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
