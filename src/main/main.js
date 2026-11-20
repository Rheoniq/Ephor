'use strict';

// Huddle main process: watches the Claude Code session registry (read-only),
// builds snapshots and pushes them to a small always-on-top panel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
} = require('electron');

const { readSessions, pidIsAlive } = require('./sessions');
const { readSteps } = require('./steps');
const { createDismissals } = require('./dismissals');
const { transcriptPath } = require('./paths');
const { openClaudeDesktop } = require('./focus');
const { createGrace } = require('./grace');
const { clampHeight, createSnapshotGate, toSnapshotSession } = require('./panel');
const { demoSessions } = require('./demo');
const { loginItemTarget } = require('./login');
const { loadSettings, saveSettings, DEFAULTS: SETTINGS_DEFAULTS } = require('./settings');
const { createVisibility } = require('./visibility');
const { createEventDetector } = require('./events');
const { createToastQueue } = require('./toast');

// HUDDLE_DEMO=1 feeds fixed fake sessions instead of reading ~/.claude.
// HUDDLE_DEMO_THEME=light|dark forces the theme (demo only).
// HUDDLE_DEMO_SHOT=<file.png> saves a screenshot after render and quits (demo only).
// HUDDLE_DEMO_TOAST=1 pushes one fake toast 1 s after load (demo only).
const DEMO = process.env.HUDDLE_DEMO === '1';
const DEMO_THEME = DEMO ? process.env.HUDDLE_DEMO_THEME : undefined;
const DEMO_SHOT = DEMO ? process.env.HUDDLE_DEMO_SHOT : undefined;
const DEMO_TOAST = DEMO && process.env.HUDDLE_DEMO_TOAST === '1';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const POLL_MS = 2000;
const DEBOUNCE_MS = 150;
const STEPS_PER_SESSION = 8;
// The renderer reports its content height; the window starts small.
const WIN_WIDTH = 360;
// Collapsed, the window shrinks to the pill so no transparent strip can
// swallow clicks meant for other apps. Fits a 3-digit count, the "!" dot,
// the pill padding and the panel margins.
const PILL_WIDTH = 96;
const WIN_HEIGHT = 120;
const MARGIN = 12;

const MAX_HOST_ID_LEN = 100;

// The toast is its own non-focusable window, top-right below the panel.
const TOAST_WIDTH = 340;
const TOAST_HEIGHT = 64;
const TOAST_GAP = 8;
const TOAST_MS = 4000;

const dismissals = createDismissals();
const detector = createEventDetector();
const toastQueue = createToastQueue({ show: showToast, durationMs: TOAST_MS });
let toastWin = null;
let toastTimer = null;
let demoToastSent = false;
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
let tray = null; // module-level so it is not garbage collected
// Settings are loaded in app.whenReady; until then the defaults apply.
let settingsFile = null;
let settings = { ...SETTINGS_DEFAULTS };
let visibility = createVisibility(settings);
let hotkeyNote = null; // set when the global hotkey could not be registered

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

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

// Returns all kept sessions (before dismissal filtering) and the snapshot.
function buildDemoSnapshot() {
  const kept = demoSessions();
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  const sessions = kept
    .filter((s) => dismissals.visible(s.sessionId, s.status))
    .map((s) => toSnapshotSession(s, s.steps));
  return { kept, snapshot: { sessions } };
}

// Returns all kept sessions (before dismissal filtering) and the snapshot.
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
    .map((s) => toSnapshotSession(s, safeSteps(s)));
  return { kept, snapshot: { sessions } };
}

// Queues a toast unless quiet mode is on or the session is dismissed.
// The toast shows even when the panel is hidden.
function pushToast(event, status) {
  if (visibility.isQuiet()) return;
  if (!dismissals.visible(event.sessionId, status)) return;
  toastQueue.push({ sessionId: event.sessionId, name: event.name, kind: event.kind });
}

function notifyEvents(kept) {
  const statusById = new Map(kept.map((s) => [s.sessionId, s.status]));
  for (const event of detector.detect(kept)) pushToast(event, statusById.get(event.sessionId));
}

function toastBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  let right = workArea.x + workArea.width - MARGIN;
  let top = workArea.y + MARGIN;
  if (win && !win.isDestroyed() && win.isVisible()) {
    const b = win.getBounds();
    right = b.x + b.width;
    top = b.y + b.height + TOAST_GAP;
  }
  return { x: right - TOAST_WIDTH, y: top, width: TOAST_WIDTH, height: TOAST_HEIGHT };
}

function closeToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.hide();
    toastWin.destroy();
  }
  toastWin = null;
}

// Shows one toast in a window that never takes focus: focusable false,
// shown with showInactive, focus() is never called.
function showToast(toast) {
  closeToast();
  // A toast may wait in the queue; re-check quiet and dismissal at show time.
  // A session that is gone from the last read is skipped too.
  if (visibility.isQuiet()) return;
  if (!lastStatus.has(toast.sessionId)) return;
  if (!dismissals.visible(toast.sessionId, lastStatus.get(toast.sessionId))) return;
  const w = new BrowserWindow({
    ...toastBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  toastWin = w;
  // Click-through: clicks reach whatever is underneath, e.g. a player's controls.
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (event) => event.preventDefault());
  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) w.showInactive();
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'), {
    query: { name: String(toast.name || ''), kind: String(toast.kind) },
  });
  toastTimer = setTimeout(closeToast, TOAST_MS);
  console.log(`[huddle] toast: ${toast.kind} ${toast.sessionId}`);
}

function updateVisibility(count) {
  if (!win || win.isDestroyed()) return;
  if (!visibility.shouldShowWindow(count)) {
    if (win.isVisible()) win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
  }
}

function persistSettings() {
  // Demo mode never writes the settings file.
  if (!DEMO && settingsFile) saveSettings(settingsFile, settings);
}

function sendUiState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('huddle:ui-state', { collapsed: visibility.isCollapsed() });
}

function rebuildTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu());
}

function toggleHidden() {
  visibility.toggleHidden();
  console.log(`[huddle] panel ${visibility.isHidden() ? 'hidden' : 'shown'}`);
  updateVisibility(lastSnapshot.sessions.length);
}

function windowWidth() {
  return visibility.isCollapsed() ? PILL_WIDTH : WIN_WIDTH;
}

// Resizes to the width for the current state, keeping the right edge and top.
function applyWindowWidth() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const width = windowWidth();
  if (b.width === width) return;
  win.setBounds({ x: b.x + b.width - width, y: b.y, width, height: b.height });
}

function setCollapsed(collapsed) {
  visibility.setCollapsed(collapsed);
  settings.collapsed = visibility.isCollapsed();
  persistSettings();
  applyWindowWidth();
  sendUiState();
  rebuildTrayMenu();
}

function setQuiet(quiet) {
  visibility.setQuiet(quiet);
  settings.quiet = visibility.isQuiet();
  if (settings.quiet) {
    // Quiet means silent now, not after the queued toasts.
    toastQueue.clear();
    closeToast();
  }
  persistSettings();
  rebuildTrayMenu();
}

function registerHotkey() {
  const accel = settings.hotkey;
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggleHidden);
  } catch (err) {
    console.error(`[huddle] hotkey ${accel} rejected: ${err && err.message ? err.message : err}`);
    ok = false;
  }
  hotkeyNote = ok ? null : `Hotkey ${accel} unavailable`;
  if (!ok) console.error(`[huddle] ${hotkeyNote}`);
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
  const { kept, snapshot } = buildSnapshot();
  lastSnapshot = snapshot;
  try {
    notifyEvents(kept);
  } catch (err) {
    // A toast failure must not skip this refresh's panel update.
    console.error(`[huddle] toast events failed: ${err && err.stack ? err.stack : err}`);
  }
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

// Trailing throttle: the first event starts the timer and later events in
// the window ride along, so a steady stream of events cannot starve refresh.
function scheduleRefresh() {
  if (debounceTimer) return;
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
  const width = windowWidth();
  win = new BrowserWindow({
    width,
    height: WIN_HEIGHT,
    x: workArea.x + workArea.width - width - MARGIN,
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
  // 'screen-saver' keeps the panel above borderless full-screen windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', () => {
    // A (re)loaded page has nothing yet: always send the current state.
    sendUiState();
    win.webContents.send('huddle:snapshot', lastSnapshot);
    snapshotGate.mark(lastSnapshot);
    if (DEMO_SHOT) setTimeout(takeDemoShot, 800);
    if (DEMO_TOAST && !demoToastSent) {
      demoToastSent = true;
      setTimeout(pushDemoToast, 1000);
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Demo only: one fake 'waiting' toast for the demo waiting session, through
// the same quiet and dismissal checks as real events.
function pushDemoToast() {
  const s = demoSessions().find((d) => d.status === 'waiting');
  if (s) pushToast({ sessionId: s.sessionId, name: s.name, kind: 'waiting' }, s.status);
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

function loginTarget() {
  return loginItemTarget({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    appPath: app.getAppPath(),
  });
}

function startsAtLogin() {
  try {
    return app.getLoginItemSettings(loginTarget()).openAtLogin;
  } catch {
    return false;
  }
}

function setStartAtLogin(enabled) {
  try {
    const target = loginTarget();
    app.setLoginItemSettings({ openAtLogin: enabled, path: target.path, args: target.args });
    console.log(`[huddle] start at login: ${enabled ? 'on' : 'off'}`);
  } catch (err) {
    // The menu is rebuilt from the real state afterwards either way.
    console.error(`[huddle] setting start at login failed: ${err && err.message ? err.message : err}`);
  }
}

function trayMenu() {
  const items = [];
  if (hotkeyNote) items.push({ label: hotkeyNote, enabled: false }, { type: 'separator' });
  items.push(
    { label: 'Hide / Show panel', click: () => toggleHidden() },
    {
      label: 'Collapse panel',
      type: 'checkbox',
      checked: visibility.isCollapsed(),
      click: (item) => setCollapsed(item.checked),
    },
    {
      label: 'Quiet mode',
      type: 'checkbox',
      checked: visibility.isQuiet(),
      click: (item) => setQuiet(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: startsAtLogin(),
      click: (item) => {
        setStartAtLogin(item.checked);
        tray.setContextMenu(trayMenu()); // re-read the real state
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  if (image.isEmpty()) console.error(`[huddle] tray icon missing: ${ICON_PATH}`);
  tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Huddle');
  tray.setContextMenu(trayMenu());
}

function fromOurWindow(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents;
}

ipcMain.on('huddle:content-size', (event, height) => {
  if (!fromOurWindow(event)) return;
  const h = clampHeight(height);
  if (h === null) return;
  const b = win.getBounds();
  const width = windowWidth();
  if (b.height === h && b.width === width) return;
  // Keep the right edge and top so the panel stays anchored top-right.
  win.setBounds({ x: b.x + b.width - width, y: b.y, width, height: h });
});

ipcMain.on('huddle:dismiss', (event, sessionId) => {
  if (!fromOurWindow(event)) return;
  if (typeof sessionId !== 'string' || !lastStatus.has(sessionId)) return;
  // In demo mode lastStatus holds only fake ids, so this touches nothing real.
  dismissals.dismiss(sessionId, lastStatus.get(sessionId));
  scheduleRefresh();
});

ipcMain.on('huddle:set-collapsed', (event, collapsed) => {
  if (!fromOurWindow(event)) return;
  if (typeof collapsed !== 'boolean') return;
  setCollapsed(collapsed);
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
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    // Demo mode neither reads nor writes the real settings file.
    settings = DEMO ? { ...SETTINGS_DEFAULTS } : loadSettings(settingsFile);
    visibility = createVisibility({ collapsed: settings.collapsed, quiet: settings.quiet });
    registerHotkey();
    createWindow();
    createTray();
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
  if (tray) tray.destroy();
  toastQueue.clear();
  closeToast();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
