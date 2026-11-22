'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, saveSettings } = require('../src/main/settings');

const DEFAULTS = { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false, terminalAnswering: false };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-settings-'));
}

test('missing file gives defaults', () => {
  const file = path.join(tmpDir(), 'nope.json');
  assert.deepEqual(loadSettings(file), DEFAULTS);
});

test('valid file round-trips', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const s = { hotkey: 'Ctrl+Shift+K', quiet: true, collapsed: true, terminalAnswering: true };
  saveSettings(file, s);
  assert.deepEqual(loadSettings(file), s);
});

test('wrong types give defaults for those fields', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hotkey: 5, quiet: 'x', collapsed: true }));
  assert.deepEqual(loadSettings(file), { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: true, terminalAnswering: false });
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

test('terminalAnswering is off by default and only a boolean true turns it on', () => {
  const file = path.join(tmpDir(), 'settings.json');
  for (const value of ['true', 1, null, {}, []]) {
    fs.writeFileSync(file, JSON.stringify({ terminalAnswering: value }));
    assert.equal(loadSettings(file).terminalAnswering, false, JSON.stringify(value));
  }
  fs.writeFileSync(file, JSON.stringify({ hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false }));
  assert.equal(loadSettings(file).terminalAnswering, false);
  fs.writeFileSync(file, JSON.stringify({ terminalAnswering: true }));
  assert.equal(loadSettings(file).terminalAnswering, true);
});

test('saveSettings writes terminalAnswering and only the known fields', () => {
  const file = path.join(tmpDir(), 'settings.json');
  saveSettings(file, { ...DEFAULTS, terminalAnswering: true, extra: 'x' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw, { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false, terminalAnswering: true });
  saveSettings(file, { ...DEFAULTS });
  assert.equal(loadSettings(file).terminalAnswering, false);
});
