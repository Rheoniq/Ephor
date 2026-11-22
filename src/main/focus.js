'use strict';

// Arrow behaviour: take the user to a session in Claude Desktop.
// Spike (2026-11-20, Claude Desktop 6.6395): claude://code/continue?session=<id>
// opens that session in the main pane and raises the window. If the link
// cannot be opened, fall back to bringing the Claude Desktop window forward.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// hostSessionId as Huddle receives it; checked before it goes into any URL.
const SESSION_ID_RE = /^local_[0-9a-f-]{36}$/;

const FOCUS_SCRIPT = path.join(__dirname, 'focus-claude.ps1');
// Absolute path, so a powershell.exe earlier on PATH or in the cwd is never used.
const POWERSHELL_EXE = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

function deepLinkUrl(hostSessionId) {
  return `claude://code/continue?session=${hostSessionId}`;
}

// Runs the fixed focus script. The script text is read from disk (works inside
// an asar too) and passed as -EncodedCommand, so no string is interpolated into
// a command line. Resolves true only when the script reports success (exit 0).
function focusClaudeWindow() {
  return new Promise((resolve) => {
    let script;
    try {
      script = fs.readFileSync(FOCUS_SCRIPT, 'utf8');
    } catch {
      resolve(false);
      return;
    }
    // Size limit: the Windows command line caps at 32767 chars; this ~1.3 KB script encodes to ~3.5 KB.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 5000 },
      (err) => resolve(!err),
    );
  });
}

function defaultDeps() {
  return {
    openExternal: (url) => require('electron').shell.openExternal(url),
    focusWindow: focusClaudeWindow,
    focusTimeoutMs: DEFAULT_FOCUS_TIMEOUT_MS,
  };
}

const DEFAULT_FOCUS_TIMEOUT_MS = 3000;

// Runs focusWindow but never waits longer than timeoutMs: the execFile
// callback may never fire if a child (csc.exe from Add-Type) keeps the pipes
// open. Resolves true only on a truthy result in time; errors and timeouts are
// false. The timer is cleared so it does not hold the process open.
function focusWithTimeout(focusWindow, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const attempt = Promise.resolve()
    .then(() => focusWindow())
    .then((ok) => Boolean(ok), () => false);
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

async function openClaudeDesktop(hostSessionId, deps = defaultDeps()) {
  if (typeof hostSessionId !== 'string' || !SESSION_ID_RE.test(hostSessionId)) {
    return 'failed';
  }
  const timeoutMs = deps.focusTimeoutMs ?? DEFAULT_FOCUS_TIMEOUT_MS;
  let linked = false;
  try {
    await deps.openExternal(deepLinkUrl(hostSessionId));
    linked = true;
  } catch {
    // fall through to focus
  }
  if (linked) {
    // Best-effort raise: covers a link the app ignores or a minimized window.
    await focusWithTimeout(deps.focusWindow, timeoutMs);
    return 'deeplink';
  }
  return (await focusWithTimeout(deps.focusWindow, timeoutMs)) ? 'focus' : 'failed';
}

// --- Terminal sessions: the window of the process that hosts the session ---

const FOCUS_WINDOW_SCRIPT = path.join(__dirname, 'focus-window.ps1');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
const FOCUS_WINDOW_TIMEOUT_MS = 8000;
const LIST_WINDOWS_TIMEOUT_MS = 5000;
// Extra time after the child's own timeout before the result is given up:
// the execFile callback may never fire if csc.exe (Add-Type) holds the pipes.
const HARD_TIMEOUT_GRACE_MS = 250;
const MAX_BUFFER = 4 * 1024 * 1024;
// Windows pids are DWORDs.
const MAX_PID = 0xffffffff;
// NTFS caps one path segment at 255 UTF-16 units; 260 leaves room.
const MAX_FOLDER_NAME = 260;
const MAX_LIST_PIDS = 64;
const MAX_TITLE = 512;
const HWND_RE = /^[0-9]{1,20}$/;
const MAX_HWND = 0xffffffffffffffffn;

function isValidPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID;
}

// JSON with every character outside printable ASCII written as \uXXXX, so the
// bytes on stdin are plain ASCII and no console code page can change them.
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// Runs fixed script text through the absolute-path PowerShell. The text goes
// in as -EncodedCommand; data goes only to stdin as ASCII JSON, never onto the
// command line. Resolves { code, stdout } when the process exits, null on a
// spawn error, a kill or a timeout. Never rejects.
function runPowerShell(scriptText, input, { timeoutMs = LIST_WINDOWS_TIMEOUT_MS, execFile: exec = execFile } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), timeoutMs + HARD_TIMEOUT_GRACE_MS);
    let child;
    try {
      const encoded = Buffer.from(String(scriptText), 'utf16le').toString('base64');
      child = exec(
        POWERSHELL_EXE,
        [...PS_ARGS, encoded],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
        (err, stdout) => {
          const out = stdout == null ? '' : String(stdout);
          if (!err) return finish({ code: 0, stdout: out });
          // A kill (timeout) or a spawn error has no numeric exit code.
          if (err.killed || typeof err.code !== 'number') return finish(null);
          return finish({ code: err.code, stdout: out });
        },
      );
    } catch {
      finish(null);
      return;
    }
    try {
      if (child && child.stdin) {
        child.stdin.on('error', () => {});
        // Always close stdin: powershell.exe may otherwise wait for it.
        if (input === undefined) child.stdin.end();
        else child.stdin.end(asciiJson(input));
      }
    } catch {
      // The child is gone; its callback or the timer settles the promise.
    }
  });
}

function readFocusWindowScript() {
  try {
    return fs.readFileSync(FOCUS_WINDOW_SCRIPT, 'utf8');
  } catch {
    return null;
  }
}

// A window handle as the script prints it: a non-zero unsigned 64-bit decimal.
function isValidHwnd(hwnd) {
  if (typeof hwnd !== 'string' || !HWND_RE.test(hwnd)) return false;
  const v = BigInt(hwnd);
  return v > 0n && v <= MAX_HWND;
}

// Characters that end a folder name inside a title: whitespace, an em or en
// dash, a pipe, a colon, a bracket or a parenthesis (or the end of the title).
const RIGHT_BOUNDARY = /[\s\u2014\u2013|:[\]()]/u;
// A letter, mark, digit or underscore continues a name. A hyphen or a dot
// before the match also does, so "Huddle" does not match "Old-Huddle" or
// "x.Huddle" as a whole name.
const NAME_CHAR = /[\p{L}\p{M}\p{N}_.-]/u;

// The whole character before index i, a surrogate pair included.
function charBefore(s, i) {
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

// True when lowerFolder appears in lowerTitle as a whole name: start of title
// or a non-name character on the left, a RIGHT_BOUNDARY or the end on the right.
// Both are already lower case; lower-casing never turns a boundary character
// into a name character, so the check on the lowered title is exact.
function boundaryMatch(lowerTitle, lowerFolder) {
  let from = 0;
  for (;;) {
    const i = lowerTitle.indexOf(lowerFolder, from);
    if (i === -1) return false;
    const end = i + lowerFolder.length;
    const left = i === 0 || !NAME_CHAR.test(charBefore(lowerTitle, i));
    const right = end === lowerTitle.length || RIGHT_BOUNDARY.test(lowerTitle[end]);
    if (left && right) return true;
    from = i + 1;
  }
}

// The hwnd to focus among one process's windows (topmost first): normal
// windows (not a tool window, no owner, not cloaked on another desktop) when
// there are any, else all; within them the first whole-name match of
// folderName (case-insensitive), else the first plain substring match, else
// the first window. null when there is no well-formed window.
function chooseWindow(windows, folderName) {
  if (!Array.isArray(windows)) return null;
  const valid = windows.filter((w) => w && typeof w.title === 'string' && isValidHwnd(w.hwnd));
  if (valid.length === 0) return null;
  const normal = valid.filter((w) => w.normal === true);
  const pool = (normal.length ? normal : valid).map((w) => ({ hwnd: w.hwnd, title: w.title.toLowerCase() }));
  const folder = typeof folderName === 'string' ? folderName.toLowerCase() : '';
  if (folder) {
    const whole = pool.find((w) => boundaryMatch(w.title, folder));
    if (whole) return whole.hwnd;
    const part = pool.find((w) => w.title.includes(folder));
    if (part) return part.hwnd;
  }
  return pool[0].hwnd;
}

// Brings the best window of ownerPid to the front. Two script calls: list the
// process's windows, choose one here (chooseWindow), then focus that hwnd; the
// script checks again that it is a visible top-level window of ownerPid. The
// folder name never reaches the script. Resolves 'focused', 'not-found' (no
// such window, or it went away) or 'failed'. Never rejects.
async function focusWindowOf(target, deps = {}) {
  const { ownerPid, folderName } = target && typeof target === 'object' ? target : {};
  if (!isValidPid(ownerPid)) return 'failed';
  const folder = folderName == null ? '' : folderName;
  if (typeof folder !== 'string' || folder.length > MAX_FOLDER_NAME) return 'failed';
  const listed = await listWindows([ownerPid], deps);
  if (listed === null) return 'failed';
  const hwnd = chooseWindow(listed.get(ownerPid), folder);
  if (hwnd === null) return 'not-found';
  const script = readFocusWindowScript();
  if (script === null) return 'failed';
  const run = (deps && deps.run) || runPowerShell;
  let res;
  try {
    res = await run(script, { mode: 'focus', ownerPid, hwnd }, { timeoutMs: FOCUS_WINDOW_TIMEOUT_MS });
  } catch {
    return 'failed';
  }
  if (!res || typeof res !== 'object') return 'failed';
  if (res.code === 0) return 'focused';
  if (res.code === 2) return 'not-found';
  return 'failed';
}

function parseRows(text) {
  if (typeof text !== 'string') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  return Array.isArray(data) ? data : null;
}

function windowMap(rows, pids) {
  const out = new Map();
  const wanted = new Set(Array.isArray(pids) ? pids : []);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { pid, hwnd, title } = row;
    if (!wanted.has(pid)) continue;
    if (!isValidHwnd(hwnd)) continue;
    if (typeof title !== 'string' || title.length === 0) continue;
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid).push({ hwnd, title: title.slice(0, MAX_TITLE), normal: row.normal === true });
  }
  return out;
}

// The script's list output as Map<pid, [{ hwnd, title, normal }]> in the
// script's order (topmost first), only for asked pids, only well-formed rows.
function parseWindowList(text, pids) {
  const rows = parseRows(text);
  return rows === null ? new Map() : windowMap(rows, pids);
}

// Like windowsOf, but null when the call or its output fails.
async function listWindows(pids, deps) {
  const valid = [...new Set(pids.filter(isValidPid))].slice(0, MAX_LIST_PIDS);
  if (valid.length === 0) return new Map();
  const script = readFocusWindowScript();
  if (script === null) return null;
  const run = (deps && deps.run) || runPowerShell;
  let res;
  try {
    res = await run(script, { mode: 'list', pids: valid }, { timeoutMs: LIST_WINDOWS_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!res || typeof res !== 'object' || res.code !== 0) return null;
  const rows = parseRows(res.stdout);
  return rows === null ? null : windowMap(rows, valid);
}

// The visible, titled top-level windows of each pid, in one PowerShell call,
// each flagged normal or not. Pids without windows are absent from the map.
// Never rejects: any failure gives an empty map.
async function windowsOf(pids, deps = {}) {
  if (!Array.isArray(pids)) return new Map();
  return (await listWindows(pids, deps)) || new Map();
}

module.exports = {
  openClaudeDesktop,
  deepLinkUrl,
  focusClaudeWindow,
  SESSION_ID_RE,
  focusWindowOf,
  windowsOf,
  chooseWindow,
  runPowerShell,
  asciiJson,
  parseWindowList,
  isValidPid,
  POWERSHELL_EXE,
};
