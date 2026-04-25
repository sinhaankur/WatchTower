'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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
