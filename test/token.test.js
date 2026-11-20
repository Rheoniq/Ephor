'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateToken, setupCommand } = require('../src/main/token');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-token-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'hook-token');
}

test('creates a 64-char hex token (32 random bytes) when the file is missing', (t) => {
  const file = tempFile(t);
  const token = loadOrCreateToken(file);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
});

test('returns the same token on later calls', (t) => {
  const file = tempFile(t);
  const first = loadOrCreateToken(file);
  assert.equal(loadOrCreateToken(file), first);
  assert.equal(loadOrCreateToken(file), first);
});

test('a missing file after deletion gives a new token', (t) => {
  const file = tempFile(t);
  const first = loadOrCreateToken(file);
  fs.rmSync(file);
  const second = loadOrCreateToken(file);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(second, first);
});

test('a file with malformed content is regenerated', (t) => {
  const file = tempFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ['', 'not a token', 'ab'.repeat(16), 'G'.repeat(64)]) {
    fs.writeFileSync(file, bad);
    const token = loadOrCreateToken(file);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
  }
});

test('throws when a new token cannot be saved, so no unsaved token is used', (t) => {
  const file = tempFile(t);
  // A directory at the path can be neither read as a file nor written over.
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => loadOrCreateToken(file));
});

test('surrounding whitespace in the file is ignored', (t) => {
  const file = tempFile(t);
  const token = loadOrCreateToken(file);
  fs.writeFileSync(file, `${token}\r\n`);
  assert.equal(loadOrCreateToken(file), token);
});

test('setupCommand is a setx line for HUDDLE_HOOK_TOKEN with the token', () => {
  const token = 'a'.repeat(64);
  assert.equal(setupCommand(token), `setx HUDDLE_HOOK_TOKEN ${token}`);
});
