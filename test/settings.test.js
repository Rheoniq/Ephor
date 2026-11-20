'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, saveSettings } = require('../src/main/settings');

const DEFAULTS = { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-settings-'));
}

test('missing file gives defaults', () => {
  const file = path.join(tmpDir(), 'nope.json');
  assert.deepEqual(loadSettings(file), DEFAULTS);
});

test('valid file round-trips', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const s = { hotkey: 'Ctrl+Shift+K', quiet: true, collapsed: true };
  saveSettings(file, s);
  assert.deepEqual(loadSettings(file), s);
});

test('wrong types give defaults for those fields', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hotkey: 5, quiet: 'x', collapsed: true }));
  assert.deepEqual(loadSettings(file), { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: true });
});

test('invalid JSON gives defaults', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadSettings(file), DEFAULTS);
});

test('a non-object JSON value gives defaults', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, 'null');
  assert.deepEqual(loadSettings(file), DEFAULTS);
});

test('saveSettings to an unwritable path does not throw', () => {
  const dir = tmpDir();
  // A path under a regular file cannot be created.
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, '');
  assert.doesNotThrow(() => saveSettings(path.join(blocker, 'sub', 'settings.json'), DEFAULTS));
});
