'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampHeight, createSnapshotGate, toSnapshotSession, isShown } = require('../src/main/panel');

const shown = (status, o = {}) =>
  isShown({ status, finished: false, hasPrompt: false, dismissalsVisible: true, ...o });

test('isShown: busy and waiting are shown', () => {
  assert.equal(shown('busy'), true);
  assert.equal(shown('waiting'), true);
});

test('isShown: idle without prompt is not shown', () => {
  assert.equal(shown('idle'), false);
});

test('isShown: idle and finished is shown', () => {
  assert.equal(shown('idle', { finished: true }), true);
});

test('isShown: idle with a pending prompt is shown', () => {
  assert.equal(shown('idle', { hasPrompt: true }), true);
});

test('isShown: a dismissed session is not shown, prompt or not', () => {
  assert.equal(shown('idle', { dismissalsVisible: false }), false);
  assert.equal(shown('idle', { dismissalsVisible: false, hasPrompt: true }), false);
  assert.equal(shown('idle', { dismissalsVisible: false, finished: true }), false);
  assert.equal(shown('busy', { dismissalsVisible: false }), false);
});

test('toSnapshotSession keeps only the fields the renderer uses', () => {
  const s = {
    sessionId: 'a',
    hostSessionId: 'local_a',
    name: 'N',
    status: 'busy',
    cwd: 'C:\\secret',
    pid: 42,
    updatedAt: 1,
  };
  assert.deepEqual(toSnapshotSession(s, ['x']), {
    sessionId: 'a',
    hostSessionId: 'local_a',
    name: 'N',
    status: 'busy',
    steps: ['x'],
    finished: false,
  });
});

test('toSnapshotSession sets finished as a boolean', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'idle', cwd: 'C:\\x' };
  assert.equal(toSnapshotSession(s, [], undefined, true).finished, true);
  assert.equal(toSnapshotSession(s, [], undefined, false).finished, false);
  assert.equal(toSnapshotSession(s, []).finished, false);
  assert.equal(toSnapshotSession(s, [], undefined, 'yes').finished, false);
});

test('toSnapshotSession adds a prompt only when one is given', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'waiting', cwd: 'C:\\x' };
  const prompt = { id: 'p1', kind: 'permission', toolName: 'Bash', command: 'npm test' };
  assert.deepEqual(toSnapshotSession(s, [], prompt), {
    sessionId: 'a',
    hostSessionId: 'local_a',
    name: 'N',
    status: 'waiting',
    steps: [],
    finished: false,
    prompt,
  });
  assert.equal('prompt' in toSnapshotSession(s, [], null), false);
  assert.equal('prompt' in toSnapshotSession(s, []), false);
});

test('snapshot gate ignores changes in fields that are not sent', () => {
  const g = createSnapshotGate();
  const base = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy' };
  assert.equal(g.shouldSend({ sessions: [toSnapshotSession({ ...base, updatedAt: 1, pid: 1 }, [])] }), true);
  assert.equal(g.shouldSend({ sessions: [toSnapshotSession({ ...base, updatedAt: 2, pid: 2 }, [])] }), false);
});

test('clampHeight rounds and clamps to 40..800', () => {
  assert.equal(clampHeight(120.4), 120);
  assert.equal(clampHeight(120.6), 121);
  assert.equal(clampHeight(10), 40);
  assert.equal(clampHeight(-5), 40);
  assert.equal(clampHeight(5000), 800);
  assert.equal(clampHeight(40), 40);
  assert.equal(clampHeight(800), 800);
});

test('clampHeight rejects non-numbers and non-finite values', () => {
  for (const bad of ['100', null, undefined, NaN, Infinity, -Infinity, {}, [100]]) {
    assert.equal(clampHeight(bad), null);
  }
});

test('snapshot gate skips a snapshot identical to the last one sent', () => {
  const g = createSnapshotGate();
  const a = { sessions: [{ sessionId: 'a', status: 'busy', steps: [] }] };
  assert.equal(g.shouldSend(a), true);
  assert.equal(g.shouldSend({ sessions: [{ sessionId: 'a', status: 'busy', steps: [] }] }), false);
  assert.equal(g.shouldSend({ sessions: [{ sessionId: 'a', status: 'waiting', steps: [] }] }), true);
  assert.equal(g.shouldSend({ sessions: [] }), true);
});

test('snapshot gate mark() records a send made elsewhere', () => {
  const g = createSnapshotGate();
  const a = { sessions: [] };
  g.mark(a);
  assert.equal(g.shouldSend(a), false);
});
