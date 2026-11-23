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
const { createDismissals } = require('./dismissals');
const { transcriptPath, agentFiles } = require('./paths');
const { openClaudeDesktop, focusWindowOf } = require('./focus');
const { createHostResolver, loadProcessTable, windowsOf, folderNameOf } = require('./host');
const {
  parseOpenRequest,
  openTargetFor,
  openSucceeded,
  createHostLookups,
  createOpenGate,
  openTerminal,
} = require('./open-target');
const { createGrace } = require('./grace');
const { createFinished } = require('./finished');
const {
  clampHeight,
  createSnapshotGate,
  toSnapshotSession,
  snapshotPlan,
  createPlanSource,
  isShown,
} = require('./panel');
const { createPlanReader } = require('./plan-reader');
const { createAgentReader, createAgentSource, effectiveStatus } = require('./agent-reader');
const { demoSessions, demoPrompts } = require('./demo');
const { loginItemTarget } = require('./login');
const { loadSettings, saveSettings, DEFAULTS: SETTINGS_DEFAULTS } = require('./settings');
const { createVisibility, toastAllowed, keepsWhilePanelSeen } = require('./visibility');
const { createRendererHealth } = require('./health');
const { createEventDetector } = require('./events');
const { createToastQueue } = require('./toast');
const { createHookServer } = require('./hooks');
const { parseHook } = require('./prompts');
const {
  promptView,
  buildResponse,
  buddyFor,
  canAnswerFor,
  holdState,
  createHold,
  armHold,
  answerInTime,
  releasePrompt,
  MAX_PROMPT_ID_LEN,
} = require('./answering');
const { loadOrCreateToken, setupCommand } = require('./token');
const { createControls, hideTitle } = require('./controls');
const { createWindowDrag, createPanelAnchor, placeNear } = require('../renderer/drag');

// HUDDLE_DEMO=1 feeds fixed fake sessions instead of reading ~/.claude.
// HUDDLE_DEMO_THEME=light|dark forces the theme (demo only).
// HUDDLE_DEMO_SHOT=<file.png> saves a screenshot after render and quits
// (demo only, never in a packaged build: it runs script in the page and
// writes a file).
// HUDDLE_DEMO_TOAST=1 pushes one fake toast 1 s after load (demo only,
// never in a packaged build).
const DEMO = process.env.HUDDLE_DEMO === '1';
const DEMO_FROM_SOURCE = DEMO && !app.isPackaged;
const DEMO_THEME = DEMO ? process.env.HUDDLE_DEMO_THEME : undefined;
const DEMO_SHOT = DEMO_FROM_SOURCE ? process.env.HUDDLE_DEMO_SHOT : undefined;
const DEMO_TOAST = DEMO_FROM_SOURCE && process.env.HUDDLE_DEMO_TOAST === '1';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const POLL_MS = 2000;
const DEBOUNCE_MS = 150;
// The renderer reports its content height; the window starts small.
const WIN_WIDTH = 360;
// Collapsed, the window shrinks to the pill so no transparent strip can
// swallow clicks meant for other apps. Fits a 3-digit count, the "!" dot,
// the pill padding and the panel margins.
const PILL_WIDTH = 96;
const WIN_HEIGHT = 120;
const MARGIN = 12;

// The toast is its own non-focusable window, top-right below the panel.
const TOAST_WIDTH = 340;
const TOAST_HEIGHT = 64;
const TOAST_GAP = 8;
const TOAST_MS = 4000;

// Answering prompts from the panel: Claude Code http hooks post to this
// localhost port. A held hook ends after holdMs with no decision, so
// Desktop's or the terminal's own prompt takes over; the hook entries'
// timeout must be longer than the hold (see docs/superpowers/notes).
// holdMs is the setting holdSeconds, read once at startup (a change needs a
// restart); until then the default applies.
const HOOK_PORT = 47821;
let holdMs = SETTINGS_DEFAULTS.holdSeconds * 1000;
const TOKEN_FILE = 'hook-token';
// While the port is taken (or the server failed to start), listening is
// tried again this often until it works or the app quits.
const ANSWER_RETRY_MS = 30000;

const dismissals = createDismissals();
const finished = createFinished();
let demoPrimed = false;
const detector = createEventDetector();
const toastQueue = createToastQueue({ show: showToast, durationMs: TOAST_MS });
let toastWin = null;
let toastTimer = null;
let shownToast = null; // the toast in toastWin, if any
let demoToastSent = false;
const grace = createGrace(2);
const snapshotGate = createSnapshotGate();
// One plan reader for all sessions; planSource keeps each session's last good
// plan and forgets sessions that left the kept list.
const planSource = createPlanSource(
  createPlanReader(),
  (s) => transcriptPath(HOME, s.cwd, s.sessionId),
  (id, err) => console.error(`[huddle] reading the plan for ${id} failed: ${err.message}`),
);
// One agent reader for all sessions: a registry-idle session whose transcript
// shows background agents still running counts as busy (agent-reader.js).
// Not used in demo mode (demo sessions carry a fixed pendingAgents).
const agentSource = createAgentSource(
  createAgentReader(),
  (s) => agentFiles(HOME, s),
  (line) => console.log(`[huddle] ${line}`),
);
let win = null;
// The expanded panel's top (see panelTarget).
const panelAnchor = createPanelAnchor();
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
let answerServer = null; // the hook server, listening or waiting for its port
let hookServer = null; // set once the server listens
let answerRetryTimer = null;
let portNoticeShown = false; // the "port in use" toast shows once per run
let hookToken = null;
let answeringNote = null; // tray note when answering is off
let quitting = false;
// Prompts are held only while the panel page is loaded and responsive.
const panelHealth = createRendererHealth();
let panelReloadTimer = null;
let lastKept = []; // kept sessions from the last read, with cwd
let lastVisible = []; // the kept sessions that are not dismissed
// Which program hosts each terminal session (Zed, VS Code, a terminal), for
// the badge and the arrow. Not in demo mode: no process table is read there.
const hostResolver = DEMO
  ? null
  : createHostResolver({ loadTable: () => loadProcessTable(), hasVisibleWindow: (pids) => windowsOf(pids) });
// Looked up lazily for shown terminal sessions only, never awaited by a
// refresh; a name that lands, or a verdict that the registry entry is stale,
// asks for one more refresh.
const hostLookups = DEMO
  ? null
  : createHostLookups({
      lookup: (pid, startKey, options) => hostResolver.lookup(pid, startKey, options),
      log: (line) => console.log(`[huddle] ${line}`),
      onResolved: () => {
        if (!quitting) scheduleRefresh();
      },
    });

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');

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
  // A demo session's fixed pendingAgents turns idle into busy as running
  // agents do for real sessions; no transcript is read.
  const kept = demoSessions().map((s) => {
    const status = effectiveStatus(s.status, s.pendingAgents);
    return status === s.status ? s : { ...s, status };
  });
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
  // Demo plans are fixed data: no transcript is read.
  const sessions = shownSessions(visible).map((s) =>
    toSnapshotSession(
      s,
      promptFor(s.sessionId),
      finished.isFinished(s.sessionId),
      snapshotPlan(s.planItems),
      s.host,
    ),
  );
  return { kept, snapshot: { sessions } };
}

// Returns all kept sessions (before visibility filtering) and the snapshot.
function buildSnapshot() {
  if (DEMO) return buildDemoSnapshot();
  // Sessions missing from one read stay for a short grace period. Stale
  // entries are left out before duplicates are merged, so a stale newest file
  // never hides a live sibling with the same session id.
  const read = grace.apply(readSessions(SESSIONS_DIR, pidIsAlive, (s) => hostLookups.isStale(s)));
  // Pruned with every session read, so a stale mark holds while its file stays.
  hostLookups.prune(read.map((s) => s.sessionId));
  // A terminal session whose host lookup proved its registry entry stale (a
  // file left behind whose pid is gone or now belongs to a claude or node
  // process that started at another time) is dropped, until its pid or
  // procStart changes; the grace copy of a just-marked entry goes here.
  const registryKept = read.filter((s) => !hostLookups.isStale(s));
  const keptIds = registryKept.map((s) => s.sessionId);
  agentSource.prune(keptIds);
  // The effective status, once per read and before anything below looks at
  // a status: a registry-idle session with background agents still running
  // is a busy copy, so the finished tracker, the toasts, the dismissals, the
  // shown rule and the snapshot all agree. 'waiting' never changes. Hidden
  // and dismissed sessions go through it too.
  const kept = agentSource.apply(registryKept);
  lastStatus = new Map(kept.map((s) => [s.sessionId, s.status]));
  dismissals.prune(keptIds);
  finished.update(kept);
  planSource.prune(keptIds);
  const visible = notDismissed(kept);
  lastKept = kept;
  lastVisible = visible;
  // Before the snapshot is built, so an ended hold shows no card and an idle
  // session whose prompt ended is no longer shown.
  endStaleHolds(visible);
  // Plans are read only for the shown sessions, so hidden ones cost nothing.
  const sessions = shownSessions(visible).map((s) => {
    const { plan } = planSource.read(s);
    return toSnapshotSession(
      s,
      promptFor(s.sessionId),
      finished.isFinished(s.sessionId),
      plan,
      hostLookups.hostFor(s),
    );
  });
  return { kept, snapshot: { sessions } };
}

// --- Answering prompts -----------------------------------------------------

function canHoldPrompts() {
  return !quitting && visibility.canHold() && panelHealth.isAlive() && !!win && !win.isDestroyed();
}

// After any hold ended: once none is left, a pill that a prompt opened
// closes again (never persisted; the user's own choice stays in settings).
function afterHoldEnded() {
  if (quitting || prompts.size > 0) return;
  if (visibility.holdsEnded()) applyCollapsed();
}

// Ends a held prompt with no decision (204), so Desktop shows its own.
function cancelHold(entry) {
  if (hookServer) hookServer.cancelSession(entry.sessionId);
  prompts.delete(entry.id);
  afterHoldEnded();
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

// Hiding or hand-collapsing the panel, turning quiet on, or a dead or hung
// panel page ends every hold at once instead of after holdMs.
function cancelAllHolds() {
  if (!hookServer || prompts.size === 0) return;
  for (const entry of [...prompts.values()]) cancelHold(entry);
  scheduleRefresh();
}

// Server callback: the buddy a hook belongs to, or null to answer 204 at
// once. A prompt the card cannot show in full is never held, and a terminal
// session's prompt only while the setting terminalAnswering is on (off, the
// terminal shows its own prompt at once).
function findBuddy(parsed) {
  return buddyFor(parsed, { kept: lastKept, visible: lastVisible, home: HOME, settings });
}

// The tray checkbox "Answer terminal prompts". Turning it off hands every
// held terminal prompt back to its terminal at once.
function setTerminalAnswering(on) {
  settings.terminalAnswering = on === true;
  persistSettings();
  console.log(`[huddle] answering terminal prompts: ${settings.terminalAnswering ? 'on' : 'off'}`);
  if (!settings.terminalAnswering && hookServer) {
    let ended = false;
    for (const entry of [...prompts.values()]) {
      const session = lastKept.find((s) => s.sessionId === entry.sessionId);
      if (session && !canAnswerFor(session, settings)) {
        cancelHold(entry);
        ended = true;
      }
    }
    if (ended) scheduleRefresh();
  }
  rebuildTrayMenu();
}

// Server callback: a hook is held for `sessionId`. Tool input is never logged.
function onPrompt({ id, sessionId, parsed }) {
  const view = promptView(parsed);
  // A throw makes the server end the hold with 204.
  if (!view) throw new Error('prompt cannot be shown');
  prompts.set(id, createHold({ id, sessionId, parsed, view, now: performance.now(), holdMs }));
  console.log(`[huddle] prompt held: ${view.kind} for ${sessionId}`);
  // A collapsed pill opens so the card can be seen; it closes again when no
  // hold is left (afterHoldEnded). Not persisted.
  if (visibility.expandForPrompt()) {
    pillDrag.end();
    applyCollapsed();
  }
  scheduleRefresh();
}

// Server callback: a hold ended without an answer from the panel (timeout,
// client gone, cancelSession, or stop() during before-quit). It must not
// throw and must not touch a destroyed window.
function onCancel(id) {
  try {
    if (!prompts.delete(id)) return;
    if (quitting) return;
    afterHoldEnded();
    scheduleRefresh();
  } catch (err) {
    console.error(`[huddle] ending a prompt failed: ${err && err.message ? err.message : err}`);
  }
}

// The tray note and tooltip say when answering is off.
function updateTray() {
  rebuildTrayMenu();
  if (tray && !tray.isDestroyed()) tray.setToolTip(answeringNote ? `Huddle\n${answeringNote}` : 'Huddle');
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
    updateTray();
    return;
  }
  answerServer = createHookServer({
    token: hookToken,
    port: HOOK_PORT,
    holdMs,
    canHold: canHoldPrompts,
    findBuddy,
    onPrompt,
    onCancel,
  });
  await listenForHooks();
}

// Starts listening. While the port is taken (or the start failed), the app
// works on without answering, says so in the tray (and once in a toast for
// a taken port), and tries again every ANSWER_RETRY_MS until it quits.
async function listenForHooks() {
  answerRetryTimer = null;
  const server = answerServer;
  if (!server || hookServer || quitting) return;
  let state;
  try {
    state = await server.start();
  } catch (err) {
    console.error(`[huddle] hook server failed to start: ${err && err.message ? err.message : err}`);
    state = 'failed';
  }
  // before-quit stops the server; nothing more to do here.
  if (quitting) return;
  if (state === 'listening') {
    hookServer = server;
    answeringNote = null;
    const address = server.address();
    console.log(`[huddle] answering on 127.0.0.1:${address ? address.port : HOOK_PORT}`);
  } else {
    answeringNote = state === 'in-use' ? `Answering off: port ${HOOK_PORT} in use` : 'Answering off: hook server failed';
    console.error(`[huddle] answering off: port ${HOOK_PORT} ${state}; trying again in ${ANSWER_RETRY_MS / 1000} s`);
    if (state === 'in-use') showPortNotice();
    answerRetryTimer = setTimeout(() => {
      listenForHooks().catch((err) => {
        console.error(`[huddle] answering retry failed: ${err && err.stack ? err.stack : err}`);
      });
    }, ANSWER_RETRY_MS);
  }
  updateTray();
}

// One toast per run when the hook port is taken (not in quiet mode).
function showPortNotice() {
  if (portNoticeShown) return;
  portNoticeShown = true;
  if (visibility.isQuiet()) return;
  toastQueue.push({ sessionId: null, kind: 'notice', name: `Answering is off: port ${HOOK_PORT} in use` });
}

// Demo only: the fake prompts go into the same table as held ones, so the
// cards and the answer check run as for real prompts.
function loadDemoPrompts() {
  for (const { id, body } of demoPrompts()) {
    const parsed = parseHook(body);
    const view = promptView(parsed);
    if (view) {
      prompts.set(id, createHold({ id, sessionId: parsed.sessionId, parsed, view, now: performance.now(), holdMs }));
    }
  }
}

function copySetupCommand() {
  if (!hookToken) return;
  clipboard.writeText(setupCommand(hookToken));
  console.log('[huddle] token setup command copied');
}

// What the toast gate needs to know about the panel right now.
function toastState() {
  return {
    quiet: visibility.isQuiet(),
    hidden: visibility.isHidden(),
    collapsed: visibility.isCollapsed(),
    windowVisible: panelOnScreen(),
  };
}

// Queues a toast unless quiet mode is on, the session is dismissed, or the
// panel is open on screen (its card already says it). `force` (demo toast
// only) skips the panel check, not quiet or dismissal.
function pushToast(event, status, force = false) {
  const toast = { sessionId: event.sessionId, name: event.name, kind: event.kind };
  if (force) toast.force = true;
  if (!toastAllowed(toast, toastState())) return;
  if (!dismissals.visible(event.sessionId, status)) return;
  toastQueue.push(toast);
}

// The panel is on screen and open: session toasts showing or queued go, as
// the cards say the same. Notices and the forced demo toast stay.
function clearToastsIfPanelSeen() {
  const s = toastState();
  if (s.hidden || s.collapsed || !s.windowVisible) return;
  toastQueue.retain(keepsWhilePanelSeen);
  if (shownToast && !keepsWhilePanelSeen(shownToast)) closeToast();
}

function notifyEvents(kept) {
  const statusById = new Map(kept.map((s) => [s.sessionId, s.status]));
  for (const event of detector.detect(kept)) pushToast(event, statusById.get(event.sessionId));
}

// Next to the panel on the display the panel is on (the pill may have been
// dragged to another monitor): below it, or above it when below does not fit
// the work area. Top-right of the primary display when the panel is hidden.
function toastBounds() {
  const size = { width: TOAST_WIDTH, height: TOAST_HEIGHT };
  if (win && !win.isDestroyed() && win.isVisible()) {
    const b = win.getBounds();
    return placeNear(b, size, screen.getDisplayMatching(b).workArea, TOAST_GAP);
  }
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - MARGIN - TOAST_WIDTH, y: workArea.y + MARGIN, ...size };
}

function closeToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (toastWin && !toastWin.isDestroyed()) {
    toastWin.hide();
    toastWin.destroy();
  }
  toastWin = null;
  shownToast = null;
}

// Shows one toast in a window that never takes focus: focusable false,
// shown with showInactive, focus() is never called. A 'notice' toast is a
// line of app status in the name slot, with no session behind it.
function showToast(toast) {
  closeToast();
  // A toast may wait in the queue; re-check quiet, the panel and dismissal
  // at show time. A session that is gone from the last read is skipped too.
  if (!toastAllowed(toast, toastState())) return;
  if (toast.kind !== 'notice') {
    if (!lastStatus.has(toast.sessionId)) return;
    if (!dismissals.visible(toast.sessionId, lastStatus.get(toast.sessionId))) return;
  }
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
      preload: path.join(__dirname, 'toast-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  toastWin = w;
  shownToast = toast;
  // Click-through: clicks reach whatever is underneath, e.g. a player's
  // controls. Mouse moves are forwarded so the renderer sees the pointer
  // enter the close cross and makes only then the window clickable.
  w.setIgnoreMouseEvents(true, { forward: true });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (event) => event.preventDefault());
  // A crashed or hung toast page is closed (after the event, not inside it);
  // the queue moves on at its own time.
  const closeBroken = () => {
    setImmediate(() => {
      try {
        if (toastWin === w) closeToast();
      } catch (err) {
        console.error(`[huddle] closing a broken toast failed: ${err && err.message ? err.message : err}`);
      }
    });
  };
  w.webContents.on('render-process-gone', closeBroken);
  w.webContents.on('unresponsive', closeBroken);
  w.once('ready-to-show', () => {
    if (!w.isDestroyed()) w.showInactive();
  });
  w.loadFile(path.join(__dirname, '..', 'renderer', 'toast.html'), {
    query: { name: String(toast.name || ''), kind: String(toast.kind) },
  });
  toastTimer = setTimeout(closeToast, TOAST_MS);
  console.log(`[huddle] toast: ${toast.kind}${toast.sessionId ? ` ${toast.sessionId}` : ''}`);
}

// The toast's close cross: the toast goes at once and the queue moves on,
// even when closing the window throws.
function dismissToast() {
  try {
    closeToast();
  } finally {
    toastQueue.skip();
  }
}

// Clickable only while the pointer is over the close cross; elsewhere the
// toast stays click-through. focusable false keeps it from taking focus.
function setToastClickable(clickable) {
  if (!toastWin || toastWin.isDestroyed()) return;
  if (clickable) toastWin.setIgnoreMouseEvents(false);
  else toastWin.setIgnoreMouseEvents(true, { forward: true });
}

// The panel's Hide button: hidden like the hotkey or tray toggle, so held
// prompts are released and Desktop takes over. Already hidden stays hidden.
function hidePanel() {
  setHidden(true);
}

function updateVisibility(count) {
  if (!win || win.isDestroyed()) return;
  if (!visibility.shouldShowWindow(count)) {
    if (win.isVisible()) win.hide();
  } else if (!win.isVisible()) {
    win.showInactive();
  }
  clearToastsIfPanelSeen();
}

function persistSettings() {
  // Demo mode never writes the settings file.
  if (!DEMO && settingsFile) saveSettings(settingsFile, settings);
}

function sendUiState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('huddle:ui-state', {
    collapsed: visibility.isCollapsed(),
    hideTitle: hideTitle(hotkeyNote ? null : settings.hotkey),
  });
}

function rebuildTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu());
}

function panelOnScreen() {
  return !!win && !win.isDestroyed() && win.isVisible();
}

// Hide or show the panel (hotkey, tray, Hide button). A hide while the
// window is not on screen (no session shown) is ignored: there is nothing
// to hide, and a hidden state would only keep the panel away later. The
// tray checkbox is rebuilt from the real state either way.
function setHidden(hidden) {
  if (visibility.setHidden(hidden, panelOnScreen())) {
    console.log(`[huddle] panel ${visibility.isHidden() ? 'hidden' : 'shown'}`);
    if (visibility.isHidden()) cancelAllHolds();
    updateVisibility(lastSnapshot.sessions.length);
  } else if (hidden && !visibility.isHidden()) {
    console.log('[huddle] hide ignored: the panel is not on screen');
  }
  rebuildTrayMenu();
}

function toggleHidden() {
  setHidden(!visibility.isHidden());
}

function windowWidth() {
  return visibility.isCollapsed() ? PILL_WIDTH : WIN_WIDTH;
}

// The window bounds for `width` and `height`, keeping the right edge. The
// collapsed pill keeps its top and may stick out (see drag.js). The expanded
// panel takes its top from panelAnchor and lies wholly inside the work area
// of its display; every size report places it from the anchor again, so a
// transient tall height after expand does not leave it pinned at the top.
function panelTarget(b, width, height) {
  const rect = { x: b.x + b.width - width, y: b.y, width, height };
  if (visibility.isCollapsed()) return rect;
  const display = screen.getDisplayMatching(b);
  return panelAnchor.place(rect, display.workArea, display.id);
}

function setPanelBounds(target) {
  const b = win.getBounds();
  if (b.x === target.x && b.y === target.y && b.width === target.width && b.height === target.height) return;
  win.setBounds(target);
}

// Resizes to the width for the current state, keeping the right edge. On
// expand the pill's top becomes the anchor; on collapse the anchor goes.
function applyWindowWidth() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const width = windowWidth();
  if (b.width === width) return;
  if (visibility.isCollapsed()) panelAnchor.clear();
  else panelAnchor.set(b.y, screen.getDisplayMatching(b).id);
  setPanelBounds(panelTarget(b, width, b.height));
}

// Applies the collapsed state to the window, the renderer and the tray.
function applyCollapsed() {
  applyWindowWidth();
  sendUiState();
  rebuildTrayMenu();
  clearToastsIfPanelSeen();
}

// The user's own collapse or expand (collapse button, pill, tray): it is
// persisted and ends an automatic expand. A hand collapse also ends every
// hold, since no card can be seen in the pill.
function setCollapsedByUser(collapsed) {
  // A drag of the pill ends when the panel opens.
  if (!collapsed) pillDrag.end();
  visibility.setCollapsed(collapsed);
  settings.collapsed = visibility.isCollapsed();
  persistSettings();
  if (visibility.isCollapsed()) cancelAllHolds();
  applyCollapsed();
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
  const count = lastSnapshot.sessions.length;
  if (count !== lastCount) {
    console.log(`[huddle] visible sessions: ${count}`);
    lastCount = count;
  }
  if (win && !win.isDestroyed() && snapshotGate.shouldSend(lastSnapshot)) {
    win.webContents.send('huddle:snapshot', lastSnapshot);
  }
  updateVisibility(count);
  // After the window was shown or hidden: the toast gate asks whether the
  // panel is on screen, and a panel that just appeared shows the card itself.
  try {
    notifyEvents(kept);
  } catch (err) {
    // A toast failure is logged; the panel was already updated.
    console.error(`[huddle] toast events failed: ${err && err.stack ? err.stack : err}`);
  }
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
  // A header drag of the expanded panel: its new top becomes the anchor.
  // Our own placements are recognised and change nothing.
  win.on('moved', () => {
    if (win.isDestroyed() || visibility.isCollapsed()) return;
    const b = win.getBounds();
    panelAnchor.moved(b.y, screen.getDisplayMatching(b).id);
  });
  // A dead or hung panel page cannot show a card: holds end at once and new
  // ones fall through until the page is alive again.
  win.webContents.on('render-process-gone', (_event, details) => onPanelGone(details));
  win.webContents.on('unresponsive', onPanelHung);
  win.webContents.on('responsive', onPanelResponsive);
  win.webContents.on('did-finish-load', () => {
    panelHealth.loaded();
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
  loadPanelPage();
}

function loadPanelPage() {
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')).catch((err) => {
    // Holding stays off until a load finishes (panelHealth).
    console.error(`[huddle] loading the panel failed: ${err && err.message ? err.message : err}`);
  });
}

// The panel page's process crashed or was killed: holds go to Desktop and
// the page is reloaded after a short delay, unless it keeps crashing.
function onPanelGone(details) {
  try {
    const delay = panelHealth.gone(performance.now());
    console.error(`[huddle] panel page gone (${details && details.reason ? details.reason : 'unknown'}); prompts go to Desktop`);
    cancelAllHolds();
    if (quitting) return;
    clearTimeout(panelReloadTimer);
    panelReloadTimer = null;
    if (delay === null) {
      console.error('[huddle] panel page keeps crashing; not reloading it');
      return;
    }
    panelReloadTimer = setTimeout(() => {
      panelReloadTimer = null;
      try {
        if (!quitting && win && !win.isDestroyed()) loadPanelPage();
      } catch (err) {
        console.error(`[huddle] reloading the panel failed: ${err && err.message ? err.message : err}`);
      }
    }, delay);
  } catch (err) {
    console.error(`[huddle] handling a gone panel page failed: ${err && err.message ? err.message : err}`);
  }
}

function onPanelHung() {
  try {
    panelHealth.hung();
    console.error('[huddle] panel page not responding; prompts go to Desktop');
    cancelAllHolds();
  } catch (err) {
    console.error(`[huddle] handling a hung panel page failed: ${err && err.message ? err.message : err}`);
  }
}

function onPanelResponsive() {
  try {
    panelHealth.responsive();
    console.log('[huddle] panel page responding again');
  } catch (err) {
    console.error(`[huddle] handling a responsive panel page failed: ${err && err.message ? err.message : err}`);
  }
}

// Demo only: one fake 'waiting' toast for the demo waiting session, through
// the same quiet and dismissal checks as real events. It is forced past the
// panel check so its look can be checked with the panel open.
function pushDemoToast() {
  if (!DEMO_TOAST) return;
  const s = demoSessions().find((d) => d.status === 'waiting');
  if (s) pushToast({ sessionId: s.sessionId, name: s.name, kind: 'waiting' }, s.status, true);
}

// Demo only: open the waiting session's view (a click on its card), wait for
// the resize, save a PNG, quit.
// Never in a packaged build (DEMO_SHOT is unset there).
async function takeDemoShot() {
  if (!DEMO_SHOT || app.isPackaged) return;
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
    {
      // Shows the real hidden state; setHidden rebuilds the menu, so a hide
      // ignored because the panel is not on screen unticks it again.
      label: 'Panel hidden',
      type: 'checkbox',
      checked: visibility.isHidden(),
      click: (item) => setHidden(item.checked),
    },
    {
      label: 'Collapse panel',
      type: 'checkbox',
      checked: visibility.isCollapsed(),
      click: (item) => setCollapsedByUser(item.checked),
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
    {
      // Off by default: prompts of terminal sessions stay in the terminal.
      label: 'Answer terminal prompts',
      type: 'checkbox',
      checked: settings.terminalAnswering === true,
      click: (item) => setTerminalAnswering(item.checked),
    },
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

// Dragging the collapsed pill: the renderer sends the pointer's total screen
// offset; the window goes to its position at drag start plus that offset,
// keeping its current size, with at least 24 px left on a display's work area.
// Every resize elsewhere reads win.getBounds(), so a dragged position stays.
const pillDrag = createWindowDrag({
  getBounds: () => win.getBounds(),
  setPosition: (x, y) => win.setPosition(x, y),
  workAreaFor: (rect) => screen.getDisplayMatching(rect).workArea,
});

function panelReady() {
  return !!win && !win.isDestroyed();
}

const controls = createControls({
  isPanelSender: fromOurWindow,
  isToastSender: (event) => !!toastWin && !toastWin.isDestroyed() && event.sender === toastWin.webContents,
  hide: hidePanel,
  // Through app.quit, so before-quit ends held prompts (204) and stops the server.
  quit: () => app.quit(),
  closeToast: dismissToast,
  setToastClickable,
  // Only the collapsed pill drags; the expanded header uses the app region.
  dragStart: () => {
    if (panelReady() && visibility.isCollapsed()) pillDrag.start();
  },
  dragTo: (delta) => {
    if (panelReady() && visibility.isCollapsed()) pillDrag.to(delta);
  },
  dragEnd: () => pillDrag.end(),
});

ipcMain.on('huddle:hide', (event) => controls.onHide(event));
ipcMain.on('huddle:quit', (event) => controls.onQuit(event));
ipcMain.on('huddle:drag-start', (event) => controls.onDragStart(event));
ipcMain.on('huddle:drag-to', (event, payload) => controls.onDragTo(event, payload));
ipcMain.on('huddle:drag-end', (event) => controls.onDragEnd(event));
ipcMain.on('huddle-toast:close', (event) => controls.onToastClose(event));
ipcMain.on('huddle-toast:clickable', (event, clickable) => controls.onToastClickable(event, clickable));

ipcMain.on('huddle:content-size', (event, height) => {
  if (!fromOurWindow(event)) return;
  const h = clampHeight(height);
  if (h === null) return;
  const b = win.getBounds();
  const width = windowWidth();
  if (b.height === h && b.width === width) return;
  // Width, position and height in one setBounds (see panelTarget).
  setPanelBounds(panelTarget(b, width, h));
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
  // Only the collapse button and the pill send this: a user action.
  setCollapsedByUser(collapsed);
});

// Tells the renderer that main refused an answer or an arm for a held
// prompt, so its card comes back instead of waiting for the hold to run out.
function refuseAnswer(id) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('huddle:answer-refused', id);
}

// The first Allow click on a permission card. Main keeps the time, so an
// allow counts only as a second step 400 ms to 5 s later (answerInTime).
ipcMain.on('huddle:arm', (event, id) => {
  if (!fromOurWindow(event)) return;
  if (typeof id !== 'string' || id.length > MAX_PROMPT_ID_LEN) return;
  const entry = prompts.get(id);
  if (entry && !armHold(entry, performance.now())) {
    console.error('[huddle] arm refused: not a permission prompt, or too soon');
    refuseAnswer(entry.id);
  }
});

// An answer from a prompt card: { id, kind, answers?, allow? }. It counts
// only for a held prompt, only when it fits that prompt exactly (see
// buildResponse) and only at an acceptable time (see answerInTime); a
// refused answer is reported back and the card shows again.
ipcMain.on('huddle:answer', (event, payload) => {
  if (!fromOurWindow(event)) return;
  const at = performance.now();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  if (typeof payload.id !== 'string' || payload.id.length > MAX_PROMPT_ID_LEN) return;
  const entry = prompts.get(payload.id);
  if (!entry) return;
  const response = buildResponse(entry.parsed, payload);
  if (!response) {
    console.error(`[huddle] answer refused: it does not fit the ${entry.view.kind} prompt`);
    refuseAnswer(entry.id);
    return;
  }
  if (!answerInTime(entry, payload, at)) {
    console.error(`[huddle] answer refused: ${entry.view.kind} prompt answered too soon or not confirmed`);
    refuseAnswer(entry.id);
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
  afterHoldEnded();
  scheduleRefresh();
});

// Opens a shown session: { kind: 'desktop', hostSessionId } in Claude
// Desktop, or { kind: 'terminal', sessionId } by bringing its host window
// to the front (an older plain hostSessionId string still means desktop).
// Only an id from the last snapshot counts. For a terminal session the pid,
// cwd and procStart come from main's own registry copy, never from the
// renderer. Fast repeated clicks on one session share one open, and at most
// two sessions open at once; a click for a third gets 'failed' at once.
ipcMain.handle('huddle:open', async (event, request) => {
  if (!fromOurWindow(event)) return 'failed';
  const target = parseOpenRequest(request, lastSnapshot.sessions);
  if (!target) return 'failed';
  const id = target.kind === 'desktop' ? target.session.hostSessionId : target.session.sessionId;
  return openGate.open(`${target.kind}:${id}`, target);
});

const openGate = createOpenGate((_key, target) => runOpen(target), { maxConcurrent: 2 });

// "Answer it there yourself" on a prompt card: { id }. Only a prompt still
// held counts (a replayed, unknown, answered or ended id gets 'failed' and
// touches nothing). The hook ends at once with no decision (204), so the
// terminal's or Desktop's own prompt appears, and then the session's app
// opens through the arrow's gated open. An open that fails never undoes the
// release: the answer is 'ok' once the hold is freed. No 500 ms guard: a
// release answers nothing.
ipcMain.handle('huddle:release', (event, payload) => {
  if (!fromOurWindow(event)) return 'failed';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'failed';
  const id = payload.id;
  if (typeof id !== 'string' || id.length > MAX_PROMPT_ID_LEN) return 'failed';
  const released = releasePrompt({
    id,
    prompts,
    resolve: (promptId) => {
      if (DEMO) console.log('[huddle] demo: prompt released (no hook to end)');
      else if (hookServer) hookServer.resolve(promptId, null);
    },
    open: (entry) => {
      // The prompt's session as the last snapshot shows it, opened as its
      // row's arrow would open it.
      const target = openTargetFor(entry.sessionId, lastSnapshot.sessions);
      if (!target) return 'failed';
      const key = target.kind === 'desktop' ? target.session.hostSessionId : target.session.sessionId;
      return openGate.open(`${target.kind}:${key}`, target);
    },
  });
  if (released.result !== 'ok') return 'failed';
  console.log('[huddle] prompt released to its own app');
  afterHoldEnded();
  scheduleRefresh();
  released.open.then((result) => {
    if (result === 'failed' || result === 'not-found') console.log(`[huddle] open after release: ${result}`);
  });
  return 'ok';
});

async function runOpen(target) {
  const shown = target.session;
  let result;
  if (DEMO) {
    console.log(`[huddle] demo: open ${target.kind} ${target.kind === 'desktop' ? shown.hostSessionId : shown.sessionId} (no-op)`);
    result = 'demo';
  } else if (target.kind === 'desktop') {
    result = await openClaudeDesktop(shown.hostSessionId);
  } else {
    result = await openTerminal(shown.sessionId, {
      kept: lastKept,
      resolve: hostResolver ? (pid, startKey, options) => hostResolver.resolve(pid, startKey, options) : undefined,
      focusWindowOf,
      folderNameOf,
    });
  }
  // Only the kind, the session id and the result: never a window title.
  if (result === 'not-found' || result === 'failed') {
    console.log(`[huddle] open ${target.kind} ${shown.sessionId}: ${result}`);
  }
  // A successful open counts as looking at the session: a finished buddy
  // leaves the panel on the next refresh. A failed open, or a host window
  // that was not found, keeps it.
  if (openSucceeded(result) && shown.finished) {
    finished.markSeen(shown.sessionId);
    scheduleRefresh();
  }
  return result;
}

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
    // Demo mode never writes the settings file and reads only holdSeconds
    // from it (so a demo run with its own --user-data-dir can try a hold).
    settings = DEMO
      ? { ...SETTINGS_DEFAULTS, holdSeconds: loadSettings(settingsFile).holdSeconds }
      : loadSettings(settingsFile);
    holdMs = settings.holdSeconds * 1000;
    visibility = createVisibility({ collapsed: settings.collapsed, quiet: settings.quiet });
    registerHotkey();
    if (DEMO) loadDemoPrompts();
    createWindow();
    // A display added, removed or rescaled: the next placement re-anchors at
    // the panel's current top.
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(name, () => panelAnchor.clear());
    }
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
  if (answerRetryTimer) clearTimeout(answerRetryTimer);
  answerRetryTimer = null;
  if (panelReloadTimer) clearTimeout(panelReloadTimer);
  panelReloadTimer = null;
  toastQueue.clear();
  closeToast();
  // Held prompts end with 204, so Desktop shows its own prompts. A server
  // still waiting for its port is stopped too (no more retries).
  if (answerServer) answerServer.stop().catch(() => {});
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
