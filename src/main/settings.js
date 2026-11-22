'use strict';

// Huddle's own small settings file. Each field falls back to its default
// when the file is missing, unreadable, malformed or holds a wrong type.
// terminalAnswering: prompt cards for terminal sessions (off until the live
// check of hook answers in a terminal has passed).
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
  terminalAnswering: false,
  holdSeconds: 60,
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
    terminalAnswering:
      typeof obj.terminalAnswering === 'boolean' ? obj.terminalAnswering : DEFAULTS.terminalAnswering,
    holdSeconds: validHoldSeconds(obj.holdSeconds) ? obj.holdSeconds : DEFAULTS.holdSeconds,
  };
}

function saveSettings(file, s) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      hotkey: s.hotkey,
      quiet: s.quiet,
      collapsed: s.collapsed,
      terminalAnswering: s.terminalAnswering === true,
      holdSeconds: validHoldSeconds(s.holdSeconds) ? s.holdSeconds : DEFAULTS.holdSeconds,
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[huddle] saving settings failed: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS, HOLD_SECONDS_MIN, HOLD_SECONDS_MAX };
