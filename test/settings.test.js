'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, saveSettings } = require('../src/main/settings');

const DEFAULTS = { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false, answering: true, terminalAnswering: false, holdSeconds: 60, diagnosticLog: true };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ephor-settings-'));
}

test('missing file gives defaults', () => {
  const file = path.join(tmpDir(), 'nope.json');
  assert.deepEqual(loadSettings(file), DEFAULTS);
});

test('valid file round-trips', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const s = { hotkey: 'Ctrl+Shift+K', quiet: true, collapsed: true, answering: false, terminalAnswering: true, holdSeconds: 30, diagnosticLog: false };
  saveSettings(file, s);
  assert.deepEqual(loadSettings(file), s);
});

test('wrong types give defaults for those fields', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hotkey: 5, quiet: 'x', collapsed: true }));
  assert.deepEqual(loadSettings(file), {
    hotkey: 'Ctrl+Alt+H',
    quiet: false,
    collapsed: true,
    answering: true,
    terminalAnswering: false,
    holdSeconds: 60,
    diagnosticLog: true,
  });
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
  assert.deepEqual(raw, { hotkey: 'Ctrl+Alt+H', quiet: false, collapsed: false, answering: true, terminalAnswering: true, holdSeconds: 60, diagnosticLog: true });
  saveSettings(file, { ...DEFAULTS });
  assert.equal(loadSettings(file).terminalAnswering, false);
});

test('holdSeconds defaults to 60 and takes an integer from 5 to 300', () => {
  const file = path.join(tmpDir(), 'settings.json');
  for (const value of [5, 6, 60, 120, 300]) {
    fs.writeFileSync(file, JSON.stringify({ holdSeconds: value }));
    assert.equal(loadSettings(file).holdSeconds, value, String(value));
  }
  fs.writeFileSync(file, JSON.stringify({ quiet: true }));
  assert.equal(loadSettings(file).holdSeconds, 60);
});

test('holdSeconds out of range or not an integer gives the default', () => {
  const file = path.join(tmpDir(), 'settings.json');
  for (const value of [4, 0, -10, 301, 1e9, 7.5, '30', null, true, [], {}]) {
    fs.writeFileSync(file, JSON.stringify({ holdSeconds: value }));
    assert.equal(loadSettings(file).holdSeconds, 60, JSON.stringify(value));
  }
});

test('saveSettings keeps holdSeconds, and an invalid one is saved as the default', () => {
  const file = path.join(tmpDir(), 'settings.json');
  saveSettings(file, { ...DEFAULTS, holdSeconds: 45 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).holdSeconds, 45);
  saveSettings(file, { ...DEFAULTS, holdSeconds: 9999 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).holdSeconds, 60);
});

test('answering is on by default and only a boolean changes it', () => {
  const file = path.join(tmpDir(), 'settings.json');
  for (const value of [0, 'false', null, {}, []]) {
    fs.writeFileSync(file, JSON.stringify({ answering: value }));
    assert.equal(loadSettings(file).answering, true, JSON.stringify(value));
  }
  fs.writeFileSync(file, JSON.stringify({ quiet: true }));
  assert.equal(loadSettings(file).answering, true);
  fs.writeFileSync(file, JSON.stringify({ answering: false }));
  assert.equal(loadSettings(file).answering, false);
  saveSettings(file, { ...DEFAULTS, answering: false });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).answering, false);
  assert.equal(loadSettings(file).answering, false);
  saveSettings(file, { ...DEFAULTS });
  assert.equal(loadSettings(file).answering, true);
});

test('diagnosticLog is on by default and only a boolean changes it', () => {
  const file = path.join(tmpDir(), 'settings.json');
  for (const value of [1, 'false', null, {}, 0]) {
    fs.writeFileSync(file, JSON.stringify({ diagnosticLog: value }));
    assert.equal(loadSettings(file).diagnosticLog, true, JSON.stringify(value));
  }
  fs.writeFileSync(file, JSON.stringify({ diagnosticLog: false }));
  assert.equal(loadSettings(file).diagnosticLog, false);
  saveSettings(file, { ...DEFAULTS, diagnosticLog: false });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).diagnosticLog, false);
  assert.equal(loadSettings(file).diagnosticLog, false);
});
