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
  platform: process.platform,
});
