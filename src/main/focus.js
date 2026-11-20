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

module.exports = { openClaudeDesktop, deepLinkUrl, focusClaudeWindow, SESSION_ID_RE };
