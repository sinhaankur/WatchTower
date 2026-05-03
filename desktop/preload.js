'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Inject the per-launch API token into localStorage BEFORE React renders.
// sendSync blocks until the main process replies, so the token is in place
// before any useEffect runs — no race condition.
try {
  const bootstrap = ipcRenderer.sendSync('wt:getAuthBootstrap');
  const autoAuth = Boolean(bootstrap?.autoAuth);
  const token = typeof bootstrap?.apiToken === 'string' ? bootstrap.apiToken : '';
  if (autoAuth && token) {
    window.localStorage.setItem('authToken', token);
  }
} catch (_) { /* non-fatal */ }

contextBridge.exposeInMainWorld('electronAPI', {
  minimize:   ()        => ipcRenderer.send('wt:minimize'),
  maximize:   ()        => ipcRenderer.send('wt:maximize'),
  close:      ()        => ipcRenderer.send('wt:close'),
  isMaximized: ()       => ipcRenderer.invoke('wt:isMaximized'),
  onMaximizeChange: (cb) => {
    const listener = (_e, val) => cb(val);
    ipcRenderer.on('wt:maximizeChange', listener);
    return () => ipcRenderer.off('wt:maximizeChange', listener);
  },
  // Open the GitHub OAuth URL in a popup BrowserWindow (shared session).
  openOAuth: (url) => ipcRenderer.send('wt:openOAuth', url),
  // Signal main process that OAuth completed — close popup, reload main window.
  oauthDone: () => ipcRenderer.send('wt:oauthDone'),
  // Trigger an in-app update. Packaged: electron-updater download+install.
  // Dev clone: git pull + rebuild + relaunch via run.sh update.
  updateNow: (releaseUrl) => ipcRenderer.invoke('wt:updateNow', releaseUrl),
  // Native folder picker. Returns { ok, path? , canceled?, error? }.
  // Used by the SetupWizard's local-folder source option so users
  // don't have to type an absolute path.
  selectFolder: (opts) => ipcRenderer.invoke('wt:selectFolder', opts ?? {}),
  // Fire an OS-level notification (visible even if WatchTower is
  // minimized / in another workspace). Pass {title, body, silent?}.
  showNotification: (payload) => ipcRenderer.send('wt:showNotification', payload ?? {}),
  // Probe Python + container runtime + return platform/version/log path.
  // Used by the System tab in Settings to show what's installed and
  // give the user copy-paste install commands for anything missing.
  getDependencyStatus: () => ipcRenderer.invoke('wt:getDependencyStatus'),
  // Relaunch the app — used by the "Recheck" button after a user
  // installs a missing dependency. PATH staleness makes in-place
  // re-probing unreliable, so we restart cleanly.
  relaunchApp: () => ipcRenderer.invoke('wt:relaunchApp'),
  // Open the user's mail client with a pre-filled bug report addressed
  // to the maintainer (system info + log tail). User reviews and sends.
  openErrorReport: (payload) => ipcRenderer.invoke('wt:openErrorReport', payload ?? {}),
  // Setup-mode helpers used when backend prerequisites are missing.
  openTerminal: () => ipcRenderer.invoke('wt:openTerminal'),
  copyText: (text) => ipcRenderer.invoke('wt:copyText', text ?? ''),
  openExternal: (url) => ipcRenderer.invoke('wt:openExternal', url ?? ''),
  platform: process.platform,
});
