'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessions, pidIsAlive } = require('../src/main/sessions');

let dir;

function base(overrides = {}) {
  return {
    pid: 1001,
    sessionId: 'sess-1',
    cwd: 'C:\\work\\proj',
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    name: 'My session',
    status: 'busy',
    updatedAt: 1700000000000,
    hostSessionId: 'local_abc',
    ...overrides,
  };
}

function writeJson(file, obj) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj));
}

const allAlive = () => true;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-sessions-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('returns an interactive claude-desktop session with a live pid, all fields', () => {
  writeJson('1001.json', base());
  const sessions = readSessions(dir, allAlive);
  assert.deepEqual(sessions, [
    {
      sessionId: 'sess-1',
      hostSessionId: 'local_abc',
      name: 'My session',
      status: 'busy',
      cwd: 'C:\\work\\proj',
      pid: 1001,
      updatedAt: 1700000000000,
    },
  ]);
});

test('excludes sessions whose kind is not interactive or entrypoint is not claude-desktop', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: 'ok' }));
  writeJson('1002.json', base({ pid: 1002, sessionId: 'bg', kind: 'background' }));
  writeJson('1003.json', base({ pid: 1003, sessionId: 'cli', entrypoint: 'cli' }));
  const ids = readSessions(dir, allAlive).map((s) => s.sessionId);
  assert.deepEqual(ids, ['ok']);
});

test('excludes sessions whose pid is not alive', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: 'live' }));
  writeJson('1002.json', base({ pid: 1002, sessionId: 'dead' }));
  const ids = readSessions(dir, (pid) => pid === 1001).map((s) => s.sessionId);
  assert.deepEqual(ids, ['live']);
});

test('skips a file with invalid JSON without throwing', () => {
  fs.writeFileSync(path.join(dir, '9999.json'), '{not json');
  writeJson('1001.json', base());
  let sessions;
  assert.doesNotThrow(() => {
    sessions = readSessions(dir, allAlive);
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'sess-1');
});

test('maps an unknown status to idle and keeps known statuses', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: 'a', status: 'weird' }));
  writeJson('1002.json', base({ pid: 1002, sessionId: 'b', status: 'waiting' }));
  writeJson('1003.json', base({ pid: 1003, sessionId: 'c', status: 'idle' }));
  const byId = Object.fromEntries(readSessions(dir, allAlive).map((s) => [s.sessionId, s.status]));
  assert.deepEqual(byId, { a: 'idle', b: 'waiting', c: 'idle' });
});

test('ignores .key files and non-.json files', () => {
  writeJson('1001.json', base());
  fs.writeFileSync(path.join(dir, '1001.abcdef.key'), JSON.stringify(base({ sessionId: 'key' })));
  fs.writeFileSync(path.join(dir, 'notes.txt'), JSON.stringify(base({ sessionId: 'txt' })));
  const ids = readSessions(dir, allAlive).map((s) => s.sessionId);
  assert.deepEqual(ids, ['sess-1']);
});

test('returns an empty array when the directory does not exist', () => {
  assert.deepEqual(readSessions(path.join(dir, 'missing'), allAlive), []);
});

test('pidIsAlive is true for the current process and false for an unused pid', () => {
  assert.equal(pidIsAlive(process.pid), true);
  assert.equal(pidIsAlive(2147483646), false);
});
