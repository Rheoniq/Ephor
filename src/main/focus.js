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
      'powershell.exe',
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
  };
}

async function openClaudeDesktop(hostSessionId, deps = defaultDeps()) {
  if (typeof hostSessionId !== 'string' || !SESSION_ID_RE.test(hostSessionId)) {
    return 'failed';
  }
  try {
    await deps.openExternal(deepLinkUrl(hostSessionId));
    // Best-effort raise: covers a link the app ignores or a minimized window.
    try {
      await deps.focusWindow();
    } catch {
      // ignored: the link already went out
    }
    return 'deeplink';
  } catch {
    // fall through to focus
  }
  try {
    if (await deps.focusWindow()) return 'focus';
  } catch {
    // fall through
  }
  return 'failed';
}

module.exports = { openClaudeDesktop, deepLinkUrl, focusClaudeWindow, SESSION_ID_RE };
