'use strict';

// Huddle main process: watches the Claude Code session registry (read-only),
// builds snapshots and pushes them to a small always-on-top panel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');

const { readSessions, pidIsAlive } = require('./sessions');
const { readSteps } = require('./steps');
const { createDismissals } = require('./dismissals');
const { transcriptPath } = require('./paths');
const { openClaudeDesktop } = require('./focus');

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const POLL_MS = 2000;
const DEBOUNCE_MS = 150;
const STEPS_PER_SESSION = 8;
// Placeholder size and margin; Task 5 owns the real panel layout.
const WIN_WIDTH = 360;
const WIN_HEIGHT = 520;
const MARGIN = 12;

const dismissals = createDismissals();
let win = null;
let lastSnapshot = { sessions: [] };
let lastStatus = new Map(); // sessionId -> status, from the last registry read
let lastCount = -1;
let debounceTimer = null;
let pollTimer = null;
let watcher = null;

function buildSnapshot() {
  const all = readSessions(SESSIONS_DIR, pidIsAlive);
  lastStatus = new Map(all.map((s) => [s.sessionId, s.status]));
  dismissals.prune(all.map((s) => s.sessionId));
  const sessions = all
    .filter((s) => dismissals.visible(s.sessionId, s.status))
    .map((s) => ({
      ...s,
      steps: readSteps(transcriptPath(HOME, s.cwd, s.sessionId), STEPS_PER_SESSION),
    }));
  return { sessions };
}

function updateVisibility(count) {
  if (!win || win.isDestroyed()) return;
  if (count === 0) {
    if (win.isVisible()) win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
  }
}

function refresh() {
  debounceTimer = null;
  lastSnapshot = buildSnapshot();
  const count = lastSnapshot.sessions.length;
  if (count !== lastCount) {
    console.log(`[huddle] visible sessions: ${count}`);
    lastCount = count;
  }
  if (win && !win.isDestroyed()) win.webContents.send('huddle:snapshot', lastSnapshot);
  updateVisibility(count);
}

function scheduleRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
}

function startWatching() {
  try {
    watcher = fs.watch(SESSIONS_DIR, { persistent: false }, scheduleRefresh);
    watcher.on('error', () => {
      // Polling below keeps the snapshot current if the watcher dies.
      watcher = null;
    });
  } catch {
    watcher = null; // directory missing or unwatchable: rely on polling
  }
  pollTimer = setInterval(scheduleRefresh, POLL_MS);
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: workArea.x + workArea.width - WIN_WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('huddle:snapshot', lastSnapshot);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.on('huddle:dismiss', (_event, sessionId) => {
  if (typeof sessionId !== 'string' || !lastStatus.has(sessionId)) return;
  dismissals.dismiss(sessionId, lastStatus.get(sessionId));
  scheduleRefresh();
});

ipcMain.handle('huddle:open', (_event, hostSessionId) => openClaudeDesktop(hostSessionId));

app.whenReady().then(() => {
  createWindow();
  refresh();
  startWatching();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) watcher.close();
});
