const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, Tray, nativeImage } = require('electron');
const { spawn, execSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

// ── Global safety net: silent diagnostic capture ─────────────────────────
//
// Goal: the app should NEVER show a "JavaScript error in the main process"
// dialog under normal operation. Stack traces go to a diagnostic log file
// where the Send Error Report flow can pick them up; the user sees nothing.
//
// This is deliberately more permissive than the previous "show dialog +
// process.exit(1)" handler. Most errors that reach this point are either:
//   1. Recoverable (a failed HTTP probe, a thrown error inside a single
//      IPC handler) — the app can keep running.
//   2. Already handled with a specific friendly dialog at the source
//      (missing Python, port conflict, backend startup timeout) — by the
//      time uncaughtException fires we'd just be showing a redundant
//      generic dialog over the specific one.
//
// Truly fatal failures (Electron itself crashed, ENOMEM, etc) will still
// bring the process down; we just don't add a scary dialog on top of them.

function diagnosticLogPath() {
  // Resolve once per call so we don't depend on writableDataDir being
  // available at module-load time.
  try {
    const dir = path.join(
      process.env.WATCHTOWER_DATA_DIR || path.join(os.homedir(), '.watchtower'),
      'logs'
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'desktop-electron.log');
  } catch {
    return null;
  }
}

function appendDiagnostic(label, payload) {
  const line = `[${new Date().toISOString()}] ${label}: ${payload}\n`;
  // Always log to stderr — surfaces in journald, .desktop launcher, dev
  // terminal, or `npm start` output.
  console.error('[WatchTower]', label + ':', payload);
  // Best-effort file write so the Send Error Report flow can attach it.
  const logPath = diagnosticLogPath();
  if (!logPath) return;
  try { fs.appendFileSync(logPath, line); } catch { /* disk full / permission */ }
}

process.on('uncaughtException', (err) => {
  const trace = err && err.stack ? err.stack : (err && err.message ? err.message : String(err));
  appendDiagnostic('uncaughtException', trace);
  // Deliberately do NOT show a dialog and do NOT exit. The error has been
  // captured; if it broke something the user will see *that* (a button
  // doesn't work, a panel doesn't load) and can send a report which
  // includes this log. Most uncaughtExceptions we've seen in practice are
  // benign: a renderer disconnected mid-IPC, a stale promise rejecting
  // after the window closed, a probe hitting EACCES on a sandbox path.
});

process.on('unhandledRejection', (reason) => {
  const trace = reason && reason.stack ? reason.stack : String(reason);
  appendDiagnostic('unhandledRejection', trace);
});

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
  // Silent by design: download in the background, surface a single
  // non-blocking OS notification when ready, then auto-apply on next
  // quit (autoInstallOnAppQuit=true). No modal dialogs, no
  // "Restart Now / Later" prompt — interrupting the user mid-task to
  // ask about an update is exactly what we want to avoid.
  if (autoUpdater && app.isPackaged) {
    autoUpdater.on('update-available', (info) => {
      console.log(`[WatchTower] Update ${info.version} available — downloading in background`);
    });

    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[WatchTower] Update ${info.version} downloaded — will apply on next quit`);
      try {
        if (Notification.isSupported()) {
          const n = new Notification({
            title: 'WatchTower update ready',
            body: `Version ${info.version} will be applied next time you quit.`,
            silent: true,
            ...(APP_ICON ? { icon: APP_ICON } : {}),
          });
          n.on('click', () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
          });
          n.show();
        }
      } catch (err) {
        console.warn('[WatchTower] Update notification failed:', err.message);
      }
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
/**
 * On macOS, `/usr/bin/python3` is a stub that pops up the Xcode Command
 * Line Tools installer dialog when invoked from a GUI app *that doesn't
 * have CLT installed*. The dialog spawn surfaces in our caller as
 * `Error: spawn /Applications/Xcode.app ENOENT` (or similar), with the
 * error originating BEFORE execSync's own try/catch can absorb it —
 * crashing the Electron main process with the dreaded "A JavaScript
 * error occurred" dialog.
 *
 * This helper detects the stub and refuses to probe it. We can tell
 * because:
 *   - The path is /usr/bin/python3 (not /usr/local/bin/, /opt/homebrew/,
 *     pyenv, asdf, or anywhere a real Python lives).
 *   - `xcode-select -p` returns exit code 2 (no developer tools chosen)
 *     OR the path it returns is the CLT placeholder.
 *
 * Cheaper approximation: if we see /usr/bin/python3 AND `xcode-select
 * --print-path` exits non-zero, treat it as the stub. Skipping it means
 * the candidate loop falls through and `startBackend()` shows a friendly
 * "install Python" dialog — much better UX than a crash.
 */
function isMacOSPythonStub(absolutePath) {
  if (process.platform !== 'darwin') return false;
  if (absolutePath !== '/usr/bin/python3') return false;
  try {
    // -p exits 0 with the path on success, non-zero (or stderr) when no
    // CLT/Xcode is selected. Either way, if we get a clean exit we trust
    // /usr/bin/python3 to work; if we don't, treat it as the stub.
    execSync('xcode-select --print-path', { stdio: 'ignore', timeout: 2000 });
    return false;
  } catch {
    return true; // CLT not installed → /usr/bin/python3 is the stub
  }
}

/**
 * Run a probe command but treat any spawn-level error (ENOENT, EACCES,
 * the macOS stub crash, Windows "App not found" dialog) as a soft miss.
 * Without this wrapper, those errors escape as unhandled exceptions and
 * crash the Electron main process before the candidate loop can move on.
 */
function probePythonCandidate(cmd) {
  try {
    execSync(`${cmd} -c "import watchtower"`, {
      stdio: 'ignore',
      timeout: 5000,
      // shell:false keeps the spawn synchronous and bounded — `cmd` is
      // an inline arg list, never user-provided, so there's no
      // injection risk to worry about.
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePython() {
  // Bundled venv next to the desktop app (dev clone path).
  if (fs.existsSync(pythonUnix)) return pythonUnix;
  if (fs.existsSync(pythonWin)) return pythonWin;

  // Explicit user override beats every probe.
  const explicit = process.env.WATCHTOWER_PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;

  // System candidates. On macOS we filter out the /usr/bin/python3 stub
  // so the GUI doesn't pop the CLT installer mid-launch.
  const candidates = process.platform === 'win32'
    ? ['python3.exe', 'python.exe', 'python']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    // Only the bare-name macOS form `python3` resolves through PATH to
    // /usr/bin/python3 — short-circuit with the stub check.
    if (process.platform === 'darwin' && cmd === 'python3') {
      if (isMacOSPythonStub('/usr/bin/python3')) {
        // Stub detected — skip without probing. Continue to other
        // candidates (`python`) which usually isn't the stub on macOS.
        continue;
      }
    }
    if (probePythonCandidate(cmd)) return cmd;
  }
  return null; // surfaced as a clear dialog in startBackend()
}

// Probe a container runtime CLI (podman/docker). Returns the resolved
// version string on success, null on miss. Bounded so a hung CLI can't
// stall the dependency-status IPC.
function probeContainerRuntime(cmd) {
  try {
    const out = execSync(`${cmd} --version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().trim();
    return out || cmd;
  } catch {
    return null;
  }
}

// Most recent backend log path — populated by startBackend() so the
// "Send error report" feature can attach the tail without re-deriving
// the path. Null until the first launch attempt.
let lastBackendLogPath = null;

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

/**
 * Per-platform install instructions for Python + the watchtower-podman
 * package. Returned as a structured object so the dialog can render
 * `commands` separately (with a "Copy" button) from `description` text.
 *
 * The previous "pip install watchtower-podman" suggestion was useless to
 * users who didn't have Python installed yet. Naming the actual platform
 * package manager (homebrew / python.org / apt) closes that gap.
 */
function pythonInstallGuide() {
  if (process.platform === 'darwin') {
    return {
      description:
        "WatchTower needs Python 3.8+ with the watchtower-podman " +
        "package installed.\n\n" +
        "Run these two commands in Terminal, then reopen WatchTower.",
      commands: [
        'brew install python@3.11',
        'python3 -m pip install watchtower-podman',
      ],
      docsUrl: 'https://github.com/sinhaankur/WatchTower#macos-installation-app-center',
      // Note: we deliberately do NOT auto-launch xcode-select --install
      // here. That popup is the same one the system /usr/bin/python3
      // stub would have triggered on its own — letting the user drive
      // the install via brew avoids it entirely.
    };
  }
  if (process.platform === 'win32') {
    return {
      description:
        "WatchTower needs Python 3.8+ with the watchtower-podman " +
        "package installed.\n\n" +
        "Install Python from python.org (check 'Add Python to PATH' " +
        "during install), then run this in PowerShell and reopen " +
        "WatchTower.",
      commands: [
        'py -3 -m pip install watchtower-podman',
      ],
      docsUrl: 'https://www.python.org/downloads/',
    };
  }
  return {
    description:
      "WatchTower needs Python 3.8+ with the watchtower-podman " +
      "package installed.\n\n" +
      "Run these in a terminal, then reopen WatchTower.",
    commands: [
      'sudo apt install -y python3 python3-pip',
      'pip3 install --user watchtower-podman',
    ],
    docsUrl: 'https://github.com/sinhaankur/WatchTower#installation',
  };
}

/**
 * Show an actionable dialog for missing Python:
 *   - Description of why it's blocked
 *   - Copyable install command (one click → clipboard)
 *   - "Open install docs" button (one click → browser)
 *   - Quit
 *
 * Returns true if the user wants the app to proceed in degraded mode
 * (currently we exit either way — backend is required — but reserving
 * the slot for the in-app onboarding flow that lands in a follow-up PR).
 */
async function showPythonMissingDialog() {
  const guide = pythonInstallGuide();
  const fullCommand = guide.commands.join(' && ');
  const detail =
    `${guide.description}\n\n` +
    `Commands:\n  ${guide.commands.join('\n  ')}\n\n` +
    `Override (advanced): set WATCHTOWER_PYTHON to a python ` +
    `you already have installed.`;

  const buttons = ['Copy install command', 'Open install docs', 'Quit'];
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Python not found',
    message: 'WatchTower can\'t start without Python',
    detail,
    buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (result.response === 0) {
    try { clipboard.writeText(fullCommand); } catch { /* clipboard unavailable */ }
    // Re-show the dialog with a confirmation line so the user has a
    // visible "got it, now restart me" cue.
    await dialog.showMessageBox({
      type: 'info',
      title: 'Copied to clipboard',
      message: 'Install command copied',
      detail:
        'Paste it into your terminal, run the install, then reopen ' +
        'WatchTower. The app will pick up the new Python automatically.',
      buttons: ['OK'],
    });
  } else if (result.response === 1) {
    try { shell.openExternal(guide.docsUrl); } catch { /* offline / no browser */ }
  }
  // Always exit — backend can't run without Python. The "skip and run
  // in degraded mode" pathway lands in the follow-up onboarding PR
  // (which also surfaces dependency status from the SPA itself).
  return false;
}

async function startBackend() {
  // Kill any process already holding the backend port (stale uvicorn, container, etc.)
  await killPortProcesses(BACKEND_PORT);

  const python = resolvePython();
  if (!python) {
    // Show a real interactive dialog (copy command / open docs / quit)
    // instead of a passive errorBox. Then exit cleanly — backend can't
    // run without Python.
    if (app && app.isReady && app.isReady()) {
      await showPythonMissingDialog();
      // showPythonMissingDialog never returns true today; quit here so
      // the splash window closes and we don't sit in zombie state.
      stopProcesses();
      app.exit(1);
      // Throw something the app.whenReady() catch can log even though
      // we've already exited — keeps the diagnostic path consistent.
      throw new Error('Python not found — user dismissed install dialog');
    }
    // app not ready yet (very early failure) — fall back to throwing so
    // the catch block in app.whenReady() shows the dialog at the right
    // time.
    const guide = pythonInstallGuide();
    throw new Error(
      `${guide.description}\n\nRun:\n  ${guide.commands.join('\n  ')}`
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
  lastBackendLogPath = backendLogPath;
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
        // Lets the Python backend find bundled binaries (Nixpacks etc.)
        // shipped via electron-builder's extraResources. In packaged
        // builds, process.resourcesPath is the resources/ dir inside the
        // app bundle. In dev (npm start), it's the Electron node_modules
        // path which doesn't have our binaries — find_nixpacks() falls
        // back to system PATH automatically.
        WATCHTOWER_RESOURCES_DIR: process.env.WATCHTOWER_RESOURCES_DIR || process.resourcesPath || '',
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

/**
 * Push a real status update into the splash window. The splash's own
 * scripted progress animation stops the moment the first real update
 * lands, so the bar reflects actual launch state instead of fake ticks.
 *
 * Safe to call before/after splash exists — silently no-ops if the
 * window has been closed (cancel + early-failure paths use this).
 */
function setSplashStatus(msg, pct) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const safeMsg = String(msg || '').replace(/[\\'"<>]/g, (c) =>
    ({ '\\': '\\\\', "'": "\\'", '"': '\\"', '<': '\\u003c', '>': '\\u003e' }[c])
  );
  const pctArg = typeof pct === 'number' ? `, ${Math.max(0, Math.min(100, pct))}` : '';
  splashWindow.webContents
    .executeJavaScript(`window.__setStatus && window.__setStatus('${safeMsg}'${pctArg})`)
    .catch(() => { /* splash closed mid-update — fine */ });
}

/**
 * Probe whether a TCP port is currently bound on loopback. Returns the
 * accepting-process PID-style string ("in use") or null ("free").
 *
 * Implementation: try to bind a server to the port. If the bind fails
 * with EADDRINUSE, something else owns it. We don't need the PID —
 * the friendly dialog tells the user how to find it themselves.
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref(); // don't keep the event loop alive on this probe
    server.once('error', (err) => {
      resolve(err && err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

// Tracks whether launch() has reached the point of showing the main
// window. The splash's 'closed' event uses this to decide: if the user
// closed the splash before the main window appeared, treat it as a
// "Cancel and quit" — kill the backend, exit. If after, just normal
// fade-out (no action needed).
let mainWindowShown = false;

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

  // Inject the real version into splash.html's <#version> div once the
  // page is parsed. The HTML used to hardcode "v1.2.2" which stayed
  // stale through every release; reading it from app.getVersion() makes
  // this self-updating.
  splashWindow.webContents.once('dom-ready', () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    const v = (app.getVersion() || '').trim();
    if (!v) return;
    const escaped = v.replace(/[\\'"<>]/g, (c) =>
      ({ '\\': '\\\\', "'": "\\'", '"': '\\"', '<': '\\u003c', '>': '\\u003e' }[c])
    );
    splashWindow.webContents
      .executeJavaScript(
        `(()=>{const e=document.getElementById('version');if(e)e.textContent='v${escaped}';})()`
      )
      .catch(() => { /* dom-ready handler raced with close — fine */ });
  });

  // User clicked "Cancel and quit" on the splash. mainWindowShown tells
  // us whether this is an actual cancellation (main window never made
  // it) or a normal post-launch fade-out (main is already up; splash
  // close is just cleanup).
  splashWindow.on('closed', () => {
    if (!mainWindowShown) {
      appendDiagnostic('launch.cancelled', 'user clicked Cancel on splash');
      stopProcesses();
      app.quit();
    }
  });
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

// Dependency probe surfaced in Settings → System. Renderer can't shell
// out, so Electron main is the only place these can be answered. Each
// probe is independently bounded; a hung CLI won't stall the others.
//
// Shape:
//   { platform, arch, appVersion, python: {found, command, version, isStub},
//     podman: {found, version, source}, dataDir, backendLogPath }
ipcMain.handle('wt:getDependencyStatus', async () => {
  const status = {
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    python: { found: false, command: null, version: null, isStub: false },
    podman: { found: false, version: null, source: null },
    dataDir: writableDataDir(),
    backendLogPath: lastBackendLogPath,
  };

  try {
    const py = resolvePython();
    if (py) {
      status.python.found = true;
      status.python.command = py;
      try {
        const ver = execSync(`${py} --version`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 3000,
        }).toString().trim();
        status.python.version = ver;
      } catch { /* version probe failed but command exists */ }
    } else if (process.platform === 'darwin' && isMacOSPythonStub('/usr/bin/python3')) {
      status.python.isStub = true;
    }
  } catch (err) {
    console.warn('[WatchTower] python probe failed:', err.message);
  }

  for (const [cmd, source] of [['podman', 'podman'], ['docker', 'docker']]) {
    const ver = probeContainerRuntime(cmd);
    if (ver) {
      status.podman.found = true;
      status.podman.version = ver;
      status.podman.source = source;
      break;
    }
  }

  return status;
});

// Recheck = relaunch. PATH staleness after the user installs Python or
// Podman in their terminal is the main reason a probe-in-place would
// lie. Restarting the app picks up the new PATH for free, and is the
// cleanest UX for the user too — no "wait, did it actually find it?"
// guesswork.
ipcMain.handle('wt:relaunchApp', () => {
  app.relaunch();
  app.exit(0);
  return { ok: true };
});

// Compose a pre-filled error report email so the user can send a crash
// or bug straight to the maintainer without copy-pasting versions.
// Body includes platform, app version, dependency status, and the last
// few hundred lines of the backend log if it exists. The user's mail
// client opens with the subject + body — they review and click send.
//
// We never send anything ourselves: a mailto: link puts the user in
// control of what leaves their machine.
ipcMain.handle('wt:openErrorReport', async (_event, payload = {}) => {
  const TO = 'sinhaankur@ymail.com';
  const userMessage = typeof payload.message === 'string' ? payload.message : '';

  let logTail = '';
  try {
    if (lastBackendLogPath && fs.existsSync(lastBackendLogPath)) {
      const raw = fs.readFileSync(lastBackendLogPath, 'utf8');
      const lines = raw.split('\n');
      logTail = lines.slice(Math.max(0, lines.length - 200)).join('\n');
    }
  } catch (err) {
    logTail = `(could not read backend log: ${err.message})`;
  }

  // Also include the Electron-side diagnostic log if it has anything.
  // Many "main-process" errors land there but never the backend log.
  let electronTail = '';
  try {
    const elPath = diagnosticLogPath();
    if (elPath && fs.existsSync(elPath)) {
      const raw = fs.readFileSync(elPath, 'utf8');
      const lines = raw.split('\n');
      electronTail = lines.slice(Math.max(0, lines.length - 100)).join('\n');
    }
  } catch (err) {
    electronTail = `(could not read electron log: ${err.message})`;
  }

  // Re-probe inline so this handler is self-contained — works even if
  // the renderer never called getDependencyStatus first.
  let depBlock = '';
  try {
    const py = resolvePython();
    const podman = probeContainerRuntime('podman') || probeContainerRuntime('docker') || 'not found';
    depBlock =
      `Platform: ${process.platform} (${process.arch})\n` +
      `App version: ${app.getVersion()}\n` +
      `Python: ${py || 'not found'}\n` +
      `Container runtime: ${podman}\n` +
      `Data dir: ${writableDataDir()}\n` +
      `Log: ${lastBackendLogPath || 'n/a'}`;
  } catch (err) {
    depBlock = `(diagnostic probe failed: ${err.message})`;
  }

  const subject = `WatchTower ${app.getVersion()} bug report (${process.platform})`;
  const body =
    (userMessage ? `${userMessage}\n\n` : '') +
    `--- Diagnostics ---\n${depBlock}\n\n` +
    `--- Backend log (last 200 lines) ---\n${logTail || '(empty)'}\n\n` +
    (electronTail ? `--- Electron diagnostic log (last 100 lines) ---\n${electronTail}\n` : '');

  // mailto: bodies have a per-mail-client length cap (~2 KB on macOS,
  // ~32 KB on Linux/Windows). Trim conservatively so the link doesn't
  // get truncated mid-encode.
  const trimmedBody = body.length > 6000
    ? body.slice(0, 6000) + '\n\n[truncated — full log: ' + (lastBackendLogPath || 'n/a') + ']'
    : body;

  const url =
    `mailto:${TO}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(trimmedBody)}`;

  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
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

/**
 * Translate raw launch errors into user-facing copy. Strips internal
 * URLs (127.0.0.1, ports) and replaces them with terms a non-developer
 * understands. Keeps the original message available for the diagnostic
 * log and the Send Error Report flow.
 */
function friendlyLaunchError(error) {
  const raw = error?.message ?? String(error);

  // Port conflict — already a friendly message constructed in launch().
  // Pass it through as-is (it includes the diagnosis + the lsof/netstat
  // commands the user can run).
  if (raw.startsWith('Port ') && raw.includes('in use by another application')) {
    return raw;
  }

  if (raw.includes('Timed out waiting for')) {
    return (
      "WatchTower's backend service didn't start in time.\n\n" +
      "Common causes:\n" +
      "  • Another app is using port 8000 (firewall, Docker desktop, jupyter, etc).\n" +
      "  • First-launch database setup is slow on this disk.\n" +
      "  • Python is missing or its install is incomplete.\n\n" +
      "Open Settings → System after launch to see exactly which dependency is missing, " +
      "or send an error report so we can diagnose."
    );
  }

  if (raw.includes('Backend exited before responding')) {
    return (
      "WatchTower's backend crashed during startup.\n\n" +
      "This is almost always a Python install issue (missing dependency, " +
      "wrong version, broken venv). The diagnostic log captured the exact error.\n\n" +
      "Try: open the log shown below, look for an ImportError or ModuleNotFoundError, " +
      "and run `pip install watchtower-podman` to repair the install."
    );
  }

  if (raw.includes('Service check failed') || raw.includes('status 5')) {
    return (
      "WatchTower's backend is running but returned an error.\n\n" +
      "This usually means the database is corrupted or migrations failed. " +
      "Try moving ~/.watchtower/watchtower.db aside and relaunching to start fresh."
    );
  }

  // Unknown error — return the raw message but don't pretend to know what it means.
  return `WatchTower hit an unexpected error during startup:\n\n${raw}`;
}

async function launch() {
  createSplash();
  setSplashStatus('Checking environment', 5);

  const backendHealthUrl = `http://${HOST}:${BACKEND_PORT}/health`;

  // Start backend if not already running. Use a 120s post-spawn wait —
  // the FastAPI lifespan runs init_db() which can take 30-90s on first-
  // run when Alembic migrations stamp/upgrade an empty database on a
  // slow disk. The default 45s was too tight: users on SD-card-backed
  // Pis or HDD-backed laptops would hit a timeout on first launch only.
  try {
    setSplashStatus('Looking for an existing backend', 10);
    await waitForUrl(backendHealthUrl, 1200);
    setSplashStatus('Backend already running', 70);
  } catch {
    // Port-in-use early detection: if something else owns 8000, the
    // backend will fail to bind and we'd burn 120 seconds before showing
    // a confusing timeout. Catching it here lets us show a specific
    // dialog with actionable copy.
    if (await isPortInUse(BACKEND_PORT)) {
      throw new Error(
        `Port ${BACKEND_PORT} is already in use by another application. ` +
        `WatchTower needs that port for its local backend service. ` +
        `Common culprits: another Electron dev server, Docker Desktop, ` +
        `jupyter, or a leftover WatchTower process. ` +
        `Find it with: lsof -i :${BACKEND_PORT}  (macOS/Linux)  or  ` +
        `netstat -ano | findstr :${BACKEND_PORT}  (Windows), then quit it and reopen WatchTower.`
      );
    }
    setSplashStatus('Starting WatchTower backend', 25);
    await startBackend();
    setSplashStatus('Loading database (this can take up to 90s on first launch)', 50);
    await waitForUrl(backendHealthUrl, 120000);
    setSplashStatus('Backend ready', 80);
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

  setSplashStatus('Loading interface', 90);
  const win = createMainWindow();

  // Helper: close splash and show the main window (idempotent).
  let shown = false;
  function showMain() {
    if (shown) return;
    shown = true;
    setSplashStatus('Ready', 100);
    mainWindowShown = true;
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
    const parts = [friendlyLaunchError(error)];
    if (!distExists) {
      parts.push(
        `\nFrontend bundle not found at:\n  ${distIndex}\n` +
        `Build it once with:\n  npm --prefix web install && npm --prefix web run build`
      );
    }
    if (backendLogPath) {
      parts.push(`\nFor support, attach this log:\n  ${backendLogPath}`);
    }
    // Persist the raw error to the diagnostic log so the Send Error Report
    // flow includes the original (URL-bearing) message even though we
    // don't show it to the user.
    appendDiagnostic('launch.failure', error?.stack ?? error?.message ?? String(error));
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
