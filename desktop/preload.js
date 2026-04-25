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
  platform: process.platform,
});
