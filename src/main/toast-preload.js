'use strict';

// Toast window preload (sandboxed): only the close cross talks to main.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toast', {
  // true while the pointer is over the close cross, false when it leaves.
  setClickable(clickable) {
    ipcRenderer.send('huddle-toast:clickable', clickable === true);
  },
  close() {
    ipcRenderer.send('huddle-toast:close');
  },
});
