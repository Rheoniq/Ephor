'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ephor', {
  onSnapshot(cb) {
    ipcRenderer.on('ephor:snapshot', (_event, snapshot) => cb(snapshot));
  },
  dismiss(id) {
    ipcRenderer.send('ephor:dismiss', id);
  },
  // { kind: 'desktop', hostSessionId } or { kind: 'terminal', sessionId };
  // main checks it against the last snapshot.
  open(target) {
    return ipcRenderer.invoke('ephor:open', target);
  },
  reportHeight(h) {
    ipcRenderer.send('ephor:content-size', h);
  },
  setCollapsed(b) {
    ipcRenderer.send('ephor:set-collapsed', b);
  },
  onUiState(cb) {
    ipcRenderer.on('ephor:ui-state', (_event, state) => cb(state));
  },
  // { id, kind, answers?, allow? }; main checks it against the held prompt.
  answer(payload) {
    ipcRenderer.send('ephor:answer', payload);
  },
  // The first Allow click of a permission card, by prompt id.
  arm(id) {
    ipcRenderer.send('ephor:arm', id);
  },
  // Frees a held prompt by id without answering it and opens the session's
  // app; resolves to 'ok' or 'failed' (main checks the id).
  release(id) {
    return ipcRenderer.invoke('ephor:release', { id });
  },
  // Main refused an answer or an arm for this prompt id; the card comes back.
  onAnswerRefused(cb) {
    ipcRenderer.on('ephor:answer-refused', (_event, id) => cb(id));
  },
  // Header buttons: hide like the hotkey; quit the app.
  hide() {
    ipcRenderer.send('ephor:hide');
  },
  quit() {
    ipcRenderer.send('ephor:quit');
  },
  // Dragging the collapsed pill: the pointer's total screen offset since the
  // drag began. Main checks the sender and the numbers.
  dragStart() {
    ipcRenderer.send('ephor:drag-start');
  },
  dragTo(dx, dy) {
    ipcRenderer.send('ephor:drag-to', { dx, dy });
  },
  dragEnd() {
    ipcRenderer.send('ephor:drag-end');
  },
});
