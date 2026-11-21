'use strict';

// Huddle main process: watches the Claude Code session registry (read-only),
// builds snapshots and pushes them to a small always-on-top panel.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  clipboard,
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
const { createFinished } = require('./finished');
const { clampHeight, createSnapshotGate, toSnapshotSession, isShown } = require('./panel');
const { demoSessions, demoPrompts } = require('./demo');
const { loginItemTarget } = require('./login');
const { loadSettings, saveSettings, DEFAULTS: SETTINGS_DEFAULTS } = require('./settings');
const { createVisibility } = require('./visibility');
const { createEventDetector } = require('./events');
const { createToastQueue } = require('./toast');
const { createHookServer } = require('./hooks');
const { parseHook } = require('./prompts');
const {
  promptView,
  buildResponse,
  matchBuddy,
  holdState,
  createHold,
  armHold,
  answerInTime,
} = require('./answering');
const { loadOrCreateToken, setupCommand } = require('./token');

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

// Answering prompts from the panel: Claude Code http hooks post to this
// localhost port. A held hook ends after HOLD_MS with no decision, so
// Desktop's own prompt takes over within the 20 s hook timeout.
const HOOK_PORT = 47821;
const HOLD_MS = 15000;
const TOKEN_FILE = 'hook-token';
const MAX_PROMPT_ID_LEN = 100;

const dismissals = createDismissals();
const finished = createFinished();
let demoPrimed = false;
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
// Held hook prompts: id -> entry from createHold (answering.js). `view` is
// what the snapshot shows; `parsed` keeps the raw input for the response;
// `heldAt` and `armedAt` are performance.now() times for the timing checks.
// In demo mode it holds the fake prompts and no server runs.
const prompts = new Map();
let hookServer = null; // set once the server listens
let hookToken = null;
let answeringNote = null; // tray note when answering is off
let quitting = false;
let lastKept = []; // kept sessions from the last read, with cwd
let lastVisible = []; // the kept sessions that are not dismissed

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

// The prompt card data for a session, or undefined.
function promptFor(sessionId) {
  for (const entry of prompts.values()) if (entry.sessionId === sessionId) return entry.view;
  return undefined;
}

// The kept sessions that are not dismissed. dismissals.visible runs for every
// kept session, because it records an idle status for a dismissed session.
// Hooks match against this list (a hook proves the session is active, even
// when the registry still says idle), and holds end only when their session
// leaves it.
function notDismissed(kept) {
  return kept.filter((s) => dismissals.visible(s.sessionId, s.status));
}

// The sessions the panel shows (panel.js isShown): busy, waiting, finished
// and not looked at yet, or with a pending prompt. Runs after endStaleHolds,
// so a session whose idle-time prompt just ended leaves the panel at once.
function shownSessions(candidates) {
  return candidates.filter((s) =>
    isShown({
      status: s.status,
      finished: finished.isFinished(s.sessionId),
      hasPrompt: !!promptFor(s.sessionId),
      dismissalsVisible: true, // candidates are already filtered by dismissal
    }),
  );
}

// Returns all kept sessions (before visibility filtering) and the snapshot.
function buildDemoSnapshot() {
  const kept = demoSessions();
  // Demo statuses never change, so the first read is primed with each demo
  // session's `before` status; a session busy before and idle now is finished.
  if (!demoPrimed) {
    finished.update(kept.map((s) => ({ sessionId: s.sessionId, status: s.before || s.status })));
    demoPrimed = true;
  }
  finished.update(kept);
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  const visible = notDismissed(kept);
  lastKept = kept;
  lastVisible = visible;
  const sessions = shownSessions(visible).map((s) =>
    toSnapshotSession(s, s.steps, promptFor(s.sessionId), finished.isFinished(s.sessionId)),
  );
  return { kept, snapshot: { sessions } };
}

// Returns all kept sessions (before visibility filtering) and the snapshot.
function buildSnapshot() {
  if (DEMO) return buildDemoSnapshot();
  // Sessions missing from one read stay for a short grace period.
  const kept = grace.apply(readSessions(SESSIONS_DIR, pidIsAlive));
  const keptIds = kept.map((s) => s.sessionId);
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  dismissals.prune(keptIds);
  finished.update(kept);
  for (const id of lastSteps.keys()) if (!lastStatus.has(id)) lastSteps.delete(id);
  const visible = notDismissed(kept);
  lastKept = kept;
  lastVisible = visible;
  // Before the snapshot is built, so an ended hold shows no card and an idle
  // session whose prompt ended is no longer shown.
  endStaleHolds(visible);
  const sessions = shownSessions(visible).map((s) =>
    toSnapshotSession(s, safeSteps(s), promptFor(s.sessionId), finished.isFinished(s.sessionId)),
  );
  return { kept, snapshot: { sessions } };
}

// --- Answering prompts -----------------------------------------------------

function canHoldPrompts() {
  return !quitting && visibility.canHold() && !!win && !win.isDestroyed();
}

// Ends a held prompt with no decision (204), so Desktop shows its own.
function cancelHold(entry) {
  if (hookServer) hookServer.cancelSession(entry.sessionId);
  prompts.delete(entry.id);
}

// On every registry read: ends holds whose buddy is gone or dismissed, holds
// the panel may no longer keep (hidden, quiet), and holds of a session seen
// 'waiting' and then not (Desktop was answered first).
function endStaleHolds(visible) {
  if (!hookServer || prompts.size === 0) return;
  const visibleIds = new Set(visible.map((s) => s.sessionId));
  const canHold = canHoldPrompts();
  for (const entry of [...prompts.values()]) {
    const next = holdState(entry, {
      status: lastStatus.get(entry.sessionId),
      visible: visibleIds.has(entry.sessionId),
      canHold,
    });
    entry.sawWaiting = next.sawWaiting;
    if (next.cancel) cancelHold(entry);
  }
}

// Hiding the panel or turning quiet on ends every hold at once instead of
// after HOLD_MS.
function cancelAllHolds() {
  if (!hookServer || prompts.size === 0) return;
  for (const entry of [...prompts.values()]) cancelHold(entry);
  scheduleRefresh();
}

// Server callback: the buddy a hook belongs to, or null to answer 204 at
// once. A prompt the card cannot show in full is never held.
function findBuddy(parsed) {
  if (!promptView(parsed)) return null;
  return matchBuddy(parsed, { kept: lastKept, visible: lastVisible, home: HOME });
}

// Server callback: a hook is held for `sessionId`. Tool input is never logged.
function onPrompt({ id, sessionId, parsed }) {
  const view = promptView(parsed);
  // A throw makes the server end the hold with 204.
  if (!view) throw new Error('prompt cannot be shown');
  prompts.set(id, createHold({ id, sessionId, parsed, view, now: performance.now() }));
  console.log(`[huddle] prompt held: ${view.kind} for ${sessionId}`);
  // A collapsed pill opens so the card can be seen.
  if (visibility.isCollapsed()) setCollapsed(false);
  scheduleRefresh();
}

// Server callback: a hold ended without an answer from the panel (timeout,
// client gone, cancelSession, or stop() during before-quit). It must not
// throw and must not touch a destroyed window.
function onCancel(id) {
  try {
    if (!prompts.delete(id)) return;
    if (!quitting) scheduleRefresh();
  } catch (err) {
    console.error(`[huddle] ending a prompt failed: ${err && err.message ? err.message : err}`);
  }
}

async function startAnswering() {
  // Demo mode opens no port and neither reads nor writes the token file.
  if (DEMO) return;
  try {
    hookToken = loadOrCreateToken(path.join(app.getPath('userData'), TOKEN_FILE));
  } catch (err) {
    // Unreadable (other than missing) or not savable: the file is left as it
    // is and nothing is answered this run.
    console.error(`[huddle] hook token file unusable: ${err && err.code ? err.code : err}`);
    answeringNote = 'Answering off: token file unusable';
    rebuildTrayMenu();
    return;
  }
  const server = createHookServer({
    token: hookToken,
    port: HOOK_PORT,
    holdMs: HOLD_MS,
    canHold: canHoldPrompts,
    findBuddy,
    onPrompt,
    onCancel,
  });
  let state;
  try {
    state = await server.start();
  } catch (err) {
    console.error(`[huddle] hook server failed to start: ${err && err.message ? err.message : err}`);
    state = 'failed';
  }
  if (state === 'listening' && !quitting) {
    hookServer = server;
    const address = server.address();
    console.log(`[huddle] answering on 127.0.0.1:${address ? address.port : HOOK_PORT}`);
  } else {
    server.stop().catch(() => {});
    if (state !== 'listening') {
      answeringNote = `Answering off: port ${HOOK_PORT} in use`;
      console.error(`[huddle] answering off: port ${HOOK_PORT} ${state}`);
    }
  }
  rebuildTrayMenu();
}

// Demo only: the fake prompts go into the same table as held ones, so the
// cards and the answer check run as for real prompts.
function loadDemoPrompts() {
  for (const { id, body } of demoPrompts()) {
    const parsed = parseHook(body);
    const view = promptView(parsed);
    if (view) prompts.set(id, createHold({ id, sessionId: parsed.sessionId, parsed, view, now: performance.now() }));
  }
}

function copySetupCommand() {
  if (!hookToken) return;
  clipboard.writeText(setupCommand(hookToken));
  console.log('[huddle] token setup command copied');
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
  if (visibility.isHidden()) cancelAllHolds();
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
    cancelAllHolds();
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
  if (hotkeyNote) items.push({ label: hotkeyNote, enabled: false });
  if (answeringNote) items.push({ label: answeringNote, enabled: false });
  if (hotkeyNote || answeringNote) items.push({ type: 'separator' });
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
    { label: 'Copy token setup command', enabled: !!hookToken, click: () => copySetupCommand() },
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
  finished.markSeen(sessionId);
  scheduleRefresh();
});

ipcMain.on('huddle:set-collapsed', (event, collapsed) => {
  if (!fromOurWindow(event)) return;
  if (typeof collapsed !== 'boolean') return;
  setCollapsed(collapsed);
});

// The first Allow click on a permission card. Main keeps the time, so an
// allow counts only as a second step 400 ms to 5 s later (answerInTime).
ipcMain.on('huddle:arm', (event, id) => {
  if (!fromOurWindow(event)) return;
  if (typeof id !== 'string' || id.length > MAX_PROMPT_ID_LEN) return;
  const entry = prompts.get(id);
  if (entry && !armHold(entry, performance.now())) {
    console.error('[huddle] arm ignored: not a permission prompt, or too soon');
  }
});

// An answer from a prompt card: { id, kind, answers?, allow? }. It counts
// only for a held prompt, only when it fits that prompt exactly (see
// buildResponse) and only at an acceptable time (see answerInTime);
// anything else is ignored and the hold runs out.
ipcMain.on('huddle:answer', (event, payload) => {
  if (!fromOurWindow(event)) return;
  const at = performance.now();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (typeof payload.id !== 'string' || payload.id.length > MAX_PROMPT_ID_LEN) return;
  const entry = prompts.get(payload.id);
  if (!entry) return;
  const response = buildResponse(entry.parsed, payload);
  if (!response) {
    console.error(`[huddle] answer ignored: it does not fit the ${entry.view.kind} prompt`);
    return;
  }
  if (!answerInTime(entry, payload, at)) {
    console.error(`[huddle] answer ignored: ${entry.view.kind} prompt answered too soon or not confirmed`);
    return;
  }
  prompts.delete(entry.id);
  if (DEMO) {
    // Demo data only, so the payload may be logged.
    console.log(`[huddle] demo answer payload: ${JSON.stringify(payload)}`);
    console.log(`[huddle] demo hook response: ${JSON.stringify(response)}`);
  } else if (hookServer) {
    const sent = hookServer.resolve(entry.id, response);
    console.log(`[huddle] ${entry.view.kind} prompt answered: ${sent ? 'sent' : 'too late, Desktop decides'}`);
  }
  scheduleRefresh();
});

ipcMain.handle('huddle:open', async (event, hostSessionId) => {
  if (!fromOurWindow(event)) return 'failed';
  if (typeof hostSessionId !== 'string' || hostSessionId.length > MAX_HOST_ID_LEN) return 'failed';
  const shown = lastSnapshot.sessions.find((s) => s.hostSessionId === hostSessionId);
  if (!shown) return 'failed';
  let result;
  if (DEMO) {
    console.log(`[huddle] demo: open ${hostSessionId} (no-op)`);
    result = 'demo';
  } else {
    result = await openClaudeDesktop(hostSessionId);
  }
  // A successful open counts as looking at the session: a finished buddy
  // leaves the panel on the next refresh. A failed open keeps it.
  if (result !== 'failed' && shown.finished) {
    finished.markSeen(shown.sessionId);
    scheduleRefresh();
  }
  return result;
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
    if (DEMO) loadDemoPrompts();
    createWindow();
    createTray();
    // Start polling before the first refresh so a failing first read
    // cannot leave the app without updates.
    startWatching();
    refresh();
    startAnswering().catch((err) => {
      console.error(`[huddle] answering failed to start: ${err && err.stack ? err.stack : err}`);
    });
  });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  // Set first: the server's stop() below calls onCancel for each held
  // prompt, and onCancel must not schedule a refresh while quitting.
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watcher) watcher.close();
  if (tray) tray.destroy();
  toastQueue.clear();
  closeToast();
  // Held prompts end with 204, so Desktop shows its own prompts.
  if (hookServer) hookServer.stop().catch(() => {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
