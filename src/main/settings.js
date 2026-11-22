'use strict';

// Huddle's own small settings file. Each field falls back to its default
// when the file is missing, unreadable, malformed or holds a wrong type.
// terminalAnswering: prompt cards for terminal sessions (off until the live
// check of hook answers in a terminal has passed).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false, terminalAnswering: false });

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
    };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[huddle] saving settings failed: ${err && err.message ? err.message : err}`);
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
