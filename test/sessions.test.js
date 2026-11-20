'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessions, pidIsAlive } = require('../src/main/sessions');

const ID_SESS_1 = '11111111-1111-4111-8111-111111111111';
const ID_OK = '22222222-2222-4222-8222-222222222222';
const ID_BG = '33333333-3333-4333-8333-333333333333';
const ID_CLI = '44444444-4444-4444-8444-444444444444';
const ID_LIVE = '55555555-5555-4555-8555-555555555555';
const ID_DEAD = '66666666-6666-4666-8666-666666666666';
const ID_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const ID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ID_C = 'cccccccc-0000-4000-8000-00000000000c';
const ID_KEY = 'dddddddd-0000-4000-8000-00000000000d';
const ID_TXT = 'eeeeeeee-0000-4000-8000-00000000000e';

let dir;

function base(overrides = {}) {
  return {
    pid: 1001,
    sessionId: ID_SESS_1,
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
      sessionId: ID_SESS_1,
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
  writeJson('1001.json', base({ pid: 1001, sessionId: ID_OK }));
  writeJson('1002.json', base({ pid: 1002, sessionId: ID_BG, kind: 'background' }));
  writeJson('1003.json', base({ pid: 1003, sessionId: ID_CLI, entrypoint: 'cli' }));
  const ids = readSessions(dir, allAlive).map((s) => s.sessionId);
  assert.deepEqual(ids, [ID_OK]);
});

test('excludes sessions whose pid is not alive', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: ID_LIVE }));
  writeJson('1002.json', base({ pid: 1002, sessionId: ID_DEAD }));
  const ids = readSessions(dir, (pid) => pid === 1001).map((s) => s.sessionId);
  assert.deepEqual(ids, [ID_LIVE]);
});

test('skips a file with invalid JSON without throwing', () => {
  fs.writeFileSync(path.join(dir, '9999.json'), '{not json');
  writeJson('1001.json', base());
  let sessions;
  assert.doesNotThrow(() => {
    sessions = readSessions(dir, allAlive);
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, ID_SESS_1);
});

test('maps an unknown status to idle and keeps known statuses', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: ID_A, status: 'weird' }));
  writeJson('1002.json', base({ pid: 1002, sessionId: ID_B, status: 'waiting' }));
  writeJson('1003.json', base({ pid: 1003, sessionId: ID_C, status: 'idle' }));
  const byId = Object.fromEntries(readSessions(dir, allAlive).map((s) => [s.sessionId, s.status]));
  assert.deepEqual(byId, { [ID_A]: 'idle', [ID_B]: 'waiting', [ID_C]: 'idle' });
});

test('ignores .key files and non-.json files', () => {
  writeJson('1001.json', base());
  fs.writeFileSync(path.join(dir, '1001.abcdef.key'), JSON.stringify(base({ sessionId: ID_KEY })));
  fs.writeFileSync(path.join(dir, 'notes.txt'), JSON.stringify(base({ sessionId: ID_TXT })));
  const ids = readSessions(dir, allAlive).map((s) => s.sessionId);
  assert.deepEqual(ids, [ID_SESS_1]);
});

test('returns an empty array when the directory does not exist', () => {
  assert.deepEqual(readSessions(path.join(dir, 'missing'), allAlive), []);
});

test('pidIsAlive is true for the current process and false for an unused pid', () => {
  assert.equal(pidIsAlive(process.pid), true);
  assert.equal(pidIsAlive(2147483646), false);
});

test('drops entries whose sessionId is not a UUID', () => {
  writeJson('1001.json', base({ pid: 1001, sessionId: ID_OK }));
  writeJson('1002.json', base({ pid: 1002, sessionId: 'sess-1' }));
  writeJson('1003.json', base({ pid: 1003, sessionId: '..\..\evil' }));
  writeJson('1004.json', base({ pid: 1004, sessionId: 12345 }));
  writeJson('1005.json', base({ pid: 1005, sessionId: undefined }));
  const ids = readSessions(dir, allAlive).map((s) => s.sessionId);
  assert.deepEqual(ids, [ID_OK]);
});
