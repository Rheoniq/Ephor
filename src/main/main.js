'use strict';

// Huddle main process: watches the Claude Code session registry (read-only),
// builds snapshots and pushes them to a small always-on-top panel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');

const { readSessions, pidIsAlive } = require('./sessions');
const { readSteps } = require('./steps');
const { createDismissals } = require('./dismissals');
const { transcriptPath } = require('./paths');
const { openClaudeDesktop } = require('./focus');
const { createGrace } = require('./grace');
const { clampHeight, createSnapshotGate } = require('./panel');
const { demoSessions } = require('./demo');

// HUDDLE_DEMO=1 feeds fixed fake sessions instead of reading ~/.claude.
// HUDDLE_DEMO_THEME=light|dark forces the theme (demo only).
// HUDDLE_DEMO_SHOT=<file.png> saves a screenshot after render and quits (demo only).
const DEMO = process.env.HUDDLE_DEMO === '1';
const DEMO_THEME = DEMO ? process.env.HUDDLE_DEMO_THEME : undefined;
const DEMO_SHOT = DEMO ? process.env.HUDDLE_DEMO_SHOT : undefined;

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const POLL_MS = 2000;
const DEBOUNCE_MS = 150;
const STEPS_PER_SESSION = 8;
// The renderer reports its content height; the window starts small.
const WIN_WIDTH = 360;
const WIN_HEIGHT = 120;
const MARGIN = 12;

const MAX_HOST_ID_LEN = 100;

const dismissals = createDismissals();
const grace = createGrace(2);
const snapshotGate = createSnapshotGate();
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

function buildDemoSnapshot() {
  const kept = demoSessions();
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  return { sessions: kept.filter((s) => dismissals.visible(s.sessionId, s.status)) };
}

function buildSnapshot() {
  if (DEMO) return buildDemoSnapshot();
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
  if (win && !win.isDestroyed() && snapshotGate.shouldSend(lastSnapshot)) {
    win.webContents.send('huddle:snapshot', lastSnapshot);
  }
  updateVisibility(count);
}

function scheduleRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
}

function startWatching() {
  if (DEMO) return; // demo data is fixed; nothing to watch or poll
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
    // A (re)loaded page has nothing yet: always send the current snapshot.
    win.webContents.send('huddle:snapshot', lastSnapshot);
    snapshotGate.mark(lastSnapshot);
    if (DEMO_SHOT) setTimeout(takeDemoShot, 800);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Demo only: expand the waiting buddy, wait for the resize, save a PNG, quit.
async function takeDemoShot() {
  try {
    await win.webContents.executeJavaScript(
      "document.querySelector('[data-session-id=\"demo-waiting\"] .buddy-body').click()",
    );
    // capturePage on a transparent window sometimes fails with
    // UnknownVizError on Windows; a few retries make it reliable enough.
    for (let attempt = 1; ; attempt++) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(DEMO_SHOT, image.toPNG());
        console.log(`[huddle] demo screenshot saved: ${DEMO_SHOT}`);
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
      }
    }
  } catch (err) {
    console.error(`[huddle] demo screenshot failed: ${err.message}`);
  }
  app.quit();
}

function fromOurWindow(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents;
}

ipcMain.on('huddle:content-size', (event, height) => {
  if (!fromOurWindow(event)) return;
  const h = clampHeight(height);
  if (h === null) return;
  const b = win.getBounds();
  if (b.height === h) return;
  // Width is fixed, so keeping x and y keeps the top-right anchor.
  win.setBounds({ x: b.x, y: b.y, width: WIN_WIDTH, height: h });
});

ipcMain.on('huddle:dismiss', (event, sessionId) => {
  if (!fromOurWindow(event)) return;
  if (typeof sessionId !== 'string' || !lastStatus.has(sessionId)) return;
  // In demo mode lastStatus holds only fake ids, so this touches nothing real.
  dismissals.dismiss(sessionId, lastStatus.get(sessionId));
  scheduleRefresh();
});

ipcMain.handle('huddle:open', async (event, hostSessionId) => {
  if (!fromOurWindow(event)) return 'failed';
  if (typeof hostSessionId !== 'string' || hostSessionId.length > MAX_HOST_ID_LEN) return 'failed';
  if (!lastSnapshot.sessions.some((s) => s.hostSessionId === hostSessionId)) return 'failed';
  if (DEMO) {
    console.log(`[huddle] demo: open ${hostSessionId} (no-op)`);
    return 'demo';
  }
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
    if (DEMO_THEME === 'dark' || DEMO_THEME === 'light') nativeTheme.themeSource = DEMO_THEME;
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
