'use strict';

// Ephor's own small settings file. Each field falls back to its default
// when the file is missing, unreadable, malformed or holds a wrong type.
// terminalAnswering: prompt cards for terminal sessions (off until the live
// check of hook answers in a terminal has passed).
// answering: the top-bar toggle "Answer in Ephor"; off, no prompt is held and
// every question or approval stays with Claude Desktop (default on).
// diagnosticLog: write the diagnostic log (ephor-diag.log, diag-log.js); on
// by default for now.
// holdSeconds: how long a prompt card holds a hook before Desktop or the
// terminal takes over; an integer from 5 to 300, else 60. Read at startup,
// so a change needs a restart.

const fs = require('node:fs');
const path = require('node:path');

const HOLD_SECONDS_MIN = 5;
const HOLD_SECONDS_MAX = 300;
const DEFAULTS = Object.freeze({
  hotkey: 'Ctrl+Alt+H',
  quiet: false,
  collapsed: false,
  answering: true,
  terminalAnswering: false,
  holdSeconds: 60,
  diagnosticLog: true,
});

function validHoldSeconds(value) {
  return Number.isInteger(value) && value >= HOLD_SECONDS_MIN && value <= HOLD_SECONDS_MAX;
}

function loadSettings(file) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    hotkey: typeof obj.hotkey === 'string' && obj.hotkey.trim() ? obj.hotkey : DEFAULTS.hotkey,
    quiet: typeof obj.quiet === 'boolean' ? obj.quiet : DEFAULTS.quiet,
    collapsed: typeof obj.collapsed === 'boolean' ? obj.collapsed : DEFAULTS.collapsed,
    answering: typeof obj.answering === 'boolean' ? obj.answering : DEFAULTS.answering,
    terminalAnswering:
      typeof obj.terminalAnswering === 'boolean' ? obj.terminalAnswering : DEFAULTS.terminalAnswering,
    holdSeconds: validHoldSeconds(obj.holdSeconds) ? obj.holdSeconds : DEFAULTS.holdSeconds,
    diagnosticLog: typeof obj.diagnosticLog === 'boolean' ? obj.diagnosticLog : DEFAULTS.diagnosticLog,
  };
}

function saveSettings(file, s) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      hotkey: s.hotkey,
      quiet: s.quiet,
      collapsed: s.collapsed,
      answering: s.answering !== false,
      terminalAnswering: s.terminalAnswering === true,
      holdSeconds: validHoldSeconds(s.holdSeconds) ? s.holdSeconds : DEFAULTS.holdSeconds,
      diagnosticLog: s.diagnosticLog !== false,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[ephor] saving settings failed: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS, HOLD_SECONDS_MIN, HOLD_SECONDS_MAX };
