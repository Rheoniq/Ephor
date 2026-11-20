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
const { createGrace } = require('./grace');

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const POLL_MS = 2000;
const DEBOUNCE_MS = 150;
const STEPS_PER_SESSION = 8;
// Placeholder size and margin; Task 5 owns the real panel layout.
const WIN_WIDTH = 360;
const WIN_HEIGHT = 520;
const MARGIN = 12;

const MAX_HOST_ID_LEN = 100;

const dismissals = createDismissals();
const grace = createGrace(2);
const lastSteps = new Map(); // sessionId -> last good steps
let win = null;
let lastSnapshot = { sessions: [] };
let lastStatus = new Map(); // sessionId -> status, from the last registry read
let lastCount = -1;
let debounceTimer = null;
let pollTimer = null;
let watcher = null;

function safeSteps(s) {
  try {
    const steps = readSteps(transcriptPath(HOME, s.cwd, s.sessionId), STEPS_PER_SESSION);
    lastSteps.set(s.sessionId, steps);
    return steps;
  } catch (err) {
    console.error(`[huddle] reading steps for ${s.sessionId} failed: ${err.message}`);
    return lastSteps.get(s.sessionId) || [];
  }
}

function buildSnapshot() {
  // Sessions missing from one read stay for a short grace period.
  const kept = grace.apply(readSessions(SESSIONS_DIR, pidIsAlive));
  const keptIds = kept.map((s) => s.sessionId);
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  dismissals.prune(keptIds);
  for (const id of lastSteps.keys()) if (!lastStatus.has(id)) lastSteps.delete(id);
  const sessions = kept
    .filter((s) => dismissals.visible(s.sessionId, s.status))
    .map((s) => ({ ...s, steps: safeSteps(s) }));
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
  try {
    refreshUnsafe();
  } catch (err) {
    // Keep lastSnapshot and keep polling; the next refresh may succeed.
    console.error(`[huddle] refresh failed: ${err && err.stack ? err.stack : err}`);
  }
}

function refreshUnsafe() {
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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('huddle:snapshot', lastSnapshot);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function fromOurWindow(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents;
}

ipcMain.on('huddle:dismiss', (event, sessionId) => {
  if (!fromOurWindow(event)) return;
  if (typeof sessionId !== 'string' || !lastStatus.has(sessionId)) return;
  dismissals.dismiss(sessionId, lastStatus.get(sessionId));
  scheduleRefresh();
});

ipcMain.handle('huddle:open', async (event, hostSessionId) => {
  if (!fromOurWindow(event)) return 'failed';
  if (typeof hostSessionId !== 'string' || hostSessionId.length > MAX_HOST_ID_LEN) return 'failed';
  if (!lastSnapshot.sessions.some((s) => s.hostSessionId === hostSessionId)) return 'failed';
  return openClaudeDesktop(hostSessionId);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Keep the single panel; just re-apply the visibility rule.
    updateVisibility(lastSnapshot.sessions.length);
  });

  app.whenReady().then(() => {
    createWindow();
    // Start polling before the first refresh so a failing first read
    // cannot leave the app without updates.
    startWatching();
    refresh();
  });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) watcher.close();
});
