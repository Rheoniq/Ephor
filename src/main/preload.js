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
});
