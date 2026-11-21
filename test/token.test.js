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

// A stand-in for fs whose read fails with `readCode` and whose writes are
// recorded (or fail with `writeCode`).
function fakeFs({ readCode, writeCode }) {
  const writes = [];
  return {
    writes,
    readFileSync() {
      throw Object.assign(new Error(readCode), { code: readCode });
    },
    mkdirSync() {},
    writeFileSync(file, data) {
      if (writeCode) throw Object.assign(new Error(writeCode), { code: writeCode });
      writes.push([file, data]);
    },
  };
}

test('a read error other than a missing file throws and never overwrites the file', () => {
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EISDIR']) {
    const io = fakeFs({ readCode: code });
    assert.throws(() => loadOrCreateToken('C:\\x\\hook-token', io), { code });
    assert.deepEqual(io.writes, [], code);
  }
});

test('a directory at the path is left alone', (t) => {
  const file = tempFile(t);
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => loadOrCreateToken(file));
  assert.equal(fs.statSync(file).isDirectory(), true);
});

test('a missing file is created through the given fs', () => {
  const io = fakeFs({ readCode: 'ENOENT' });
  const token = loadOrCreateToken('C:\\x\\hook-token', io);
  assert.deepEqual(io.writes, [['C:\\x\\hook-token', token]]);
});

test('throws when a new token cannot be saved, so no unsaved token is used', () => {
  const io = fakeFs({ readCode: 'ENOENT', writeCode: 'EACCES' });
  assert.throws(() => loadOrCreateToken('C:\\x\\hook-token', io), { code: 'EACCES' });
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
