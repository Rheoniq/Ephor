'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  onSnapshot(cb) {
    ipcRenderer.on('huddle:snapshot', (_event, snapshot) => cb(snapshot));
  },
  dismiss(id) {
    ipcRenderer.send('huddle:dismiss', id);
  },
  open(hostSessionId) {
    return ipcRenderer.invoke('huddle:open', hostSessionId);
  },
  reportHeight(h) {
    ipcRenderer.send('huddle:content-size', h);
  },
  setCollapsed(b) {
    ipcRenderer.send('huddle:set-collapsed', b);
  },
  onUiState(cb) {
    ipcRenderer.on('huddle:ui-state', (_event, state) => cb(state));
  },
});
