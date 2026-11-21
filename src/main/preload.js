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
  // { id, kind, answers?, allow? }; main checks it against the held prompt.
  answer(payload) {
    ipcRenderer.send('huddle:answer', payload);
  },
  // The first Allow click of a permission card, by prompt id.
  arm(id) {
    ipcRenderer.send('huddle:arm', id);
  },
  // Main refused an answer or an arm for this prompt id; the card comes back.
  onAnswerRefused(cb) {
    ipcRenderer.on('huddle:answer-refused', (_event, id) => cb(id));
  },
  // Header buttons: hide like the hotkey; quit the app.
  hide() {
    ipcRenderer.send('huddle:hide');
  },
  quit() {
    ipcRenderer.send('huddle:quit');
  },
  // Dragging the collapsed pill: the pointer's total screen offset since the
  // drag began. Main checks the sender and the numbers.
  dragStart() {
    ipcRenderer.send('huddle:drag-start');
  },
  dragTo(dx, dy) {
    ipcRenderer.send('huddle:drag-to', { dx, dy });
  },
  dragEnd() {
    ipcRenderer.send('huddle:drag-end');
  },
});
