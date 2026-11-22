'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenRequest, createHostLookups, openSucceeded, MAX_OPEN_ID_LEN } = require('../src/main/open-target');

const desk = { sessionId: 'a', hostSessionId: 'local_a', source: 'desktop', finished: false };
const term = { sessionId: 'b', hostSessionId: undefined, source: 'terminal', finished: true };
const shown = [desk, term];

test('parseOpenRequest: accepts the desktop tagged form for a shown desktop session', () => {
  assert.deepEqual(parseOpenRequest({ kind: 'desktop', hostSessionId: 'local_a' }, shown), {
    kind: 'desktop',
    session: desk,
  });
});

test('parseOpenRequest: accepts the terminal tagged form for a shown terminal session', () => {
  assert.deepEqual(parseOpenRequest({ kind: 'terminal', sessionId: 'b' }, shown), { kind: 'terminal', session: term });
});

test('parseOpenRequest: the old plain string still opens a desktop session', () => {
  assert.deepEqual(parseOpenRequest('local_a', shown), { kind: 'desktop', session: desk });
  assert.equal(parseOpenRequest('', shown), null);
  assert.equal(parseOpenRequest('b', shown), null);
});

test('parseOpenRequest: rejects unknown or missing kinds', () => {
  assert.equal(parseOpenRequest({ kind: 'web', sessionId: 'b' }, shown), null);
  assert.equal(parseOpenRequest({ sessionId: 'b' }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'Terminal', sessionId: 'b' }, shown), null);
  assert.equal(parseOpenRequest({ kind: ['terminal'], sessionId: 'b' }, shown), null);
});

test('parseOpenRequest: rejects non-objects and arrays', () => {
  for (const v of [undefined, null, 42, true, ['terminal', 'b'], () => 'b']) {
    assert.equal(parseOpenRequest(v, shown), null);
  }
});

test('parseOpenRequest: rejects ids that are not strings', () => {
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: 7 }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: { toString: () => 'b' } }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'desktop', hostSessionId: null }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: '' }, shown), null);
});

test('parseOpenRequest: rejects overlong ids even when a session has that id', () => {
  const long = 'x'.repeat(MAX_OPEN_ID_LEN + 1);
  const list = [
    { sessionId: long, source: 'terminal' },
    { sessionId: 'd', hostSessionId: long, source: 'desktop' },
  ];
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: long }, list), null);
  assert.equal(parseOpenRequest({ kind: 'desktop', hostSessionId: long }, list), null);
  assert.equal(parseOpenRequest(long, list), null);
  const ok = 'y'.repeat(MAX_OPEN_ID_LEN);
  const one = [{ sessionId: ok, source: 'terminal' }];
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: ok }, one).kind, 'terminal');
});

test('parseOpenRequest: rejects ids that are not in the shown list', () => {
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: 'zz' }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'desktop', hostSessionId: 'local_zz' }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: 'b' }, []), null);
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: 'b' }, undefined), null);
});

test('parseOpenRequest: the kind must match the session source', () => {
  assert.equal(parseOpenRequest({ kind: 'terminal', sessionId: 'a' }, shown), null);
  assert.equal(parseOpenRequest({ kind: 'desktop', hostSessionId: 'b' }, shown), null);
});

test('openSucceeded: only a real success counts for marking a buddy seen', () => {
  assert.equal(openSucceeded('focused'), true);
  assert.equal(openSucceeded('focus'), true);
  assert.equal(openSucceeded('deeplink'), true);
  assert.equal(openSucceeded('demo'), true);
  assert.equal(openSucceeded('not-found'), false);
  assert.equal(openSucceeded('failed'), false);
  assert.equal(openSucceeded(undefined), false);
});

// --- lazy host lookups -----------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function setup({ answers = {} } = {}) {
  let t = 1000;
  const calls = [];
  const pending = [];
  let refreshes = 0;
  const lookups = createHostLookups({
    resolve: (pid, startKey, options) => {
      calls.push({ pid, startKey, options });
      if (Object.prototype.hasOwnProperty.call(answers, pid)) return Promise.resolve(answers[pid]);
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    now: () => t,
    onResolved: () => {
      refreshes += 1;
    },
  });
  return {
    lookups,
    calls,
    pending,
    refreshes: () => refreshes,
    advance: (ms) => {
      t += ms;
    },
  };
}

const START = '134398573554097853';
const ts = (id, pid, procStart = START) => ({ sessionId: id, pid, procStart, source: 'terminal' });

test('host lookups: the first ask returns null at once and starts one resolve without revalidate', () => {
  const h = setup();
  assert.equal(h.lookups.hostFor(ts('s1', 10)), null);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { pid: 10, startKey: START, options: { revalidate: false } });
});

test('host lookups: procStart is passed through unchanged as a string', () => {
  const h = setup();
  h.lookups.hostFor(ts('s1', 10));
  assert.equal(typeof h.calls[0].startKey, 'string');
  assert.equal(h.calls[0].startKey, START);
});

test('host lookups: once per session id while a resolve is in flight', () => {
  const h = setup();
  h.lookups.hostFor(ts('s1', 10));
  h.lookups.hostFor(ts('s1', 10));
  h.lookups.hostFor(ts('s1', 10));
  assert.equal(h.calls.length, 1);
});

test('host lookups: a landed name is served afterwards and a refresh is requested', async () => {
  const h = setup();
  h.lookups.hostFor(ts('s1', 10));
  h.pending[0].resolve({ name: 'Zed', ownerPid: 33020 });
  await flush();
  assert.equal(h.refreshes(), 1);
  assert.equal(h.lookups.hostFor(ts('s1', 10)), 'Zed');
  h.advance(10 * 60 * 1000);
  assert.equal(h.lookups.hostFor(ts('s1', 10)), 'Zed');
  assert.equal(h.calls.length, 1);
});

test('host lookups: a null result is remembered for 60 s, then retried once', async () => {
  const h = setup({ answers: { 10: null } });
  assert.equal(h.lookups.hostFor(ts('s1', 10)), null);
  await flush();
  h.advance(59 * 1000);
  assert.equal(h.lookups.hostFor(ts('s1', 10)), null);
  assert.equal(h.calls.length, 1);
  h.advance(1000);
  h.lookups.hostFor(ts('s1', 10));
  assert.equal(h.calls.length, 2);
});

test('host lookups: a null result does not request a refresh (nothing changed)', async () => {
  const h = setup({ answers: { 10: null } });
  h.lookups.hostFor(ts('s1', 10));
  await flush();
  assert.equal(h.refreshes(), 0);
});

test('host lookups: a rejected or throwing resolve counts as null and never throws', async () => {
  const rejecting = createHostLookups({ resolve: () => Promise.reject(new Error('x')), now: () => 0 });
  assert.equal(rejecting.hostFor(ts('s1', 10)), null);
  await flush();
  assert.equal(rejecting.hostFor(ts('s1', 10)), null);
  const throwing = createHostLookups({
    resolve: () => {
      throw new Error('sync');
    },
    now: () => 0,
  });
  assert.equal(throwing.hostFor(ts('s1', 10)), null);
});

test('host lookups: a malformed result counts as null', async () => {
  const h = setup({ answers: { 10: { name: 42 }, 11: { name: '' } } });
  h.lookups.hostFor(ts('s1', 10));
  h.lookups.hostFor(ts('s2', 11));
  await flush();
  assert.equal(h.lookups.hostFor(ts('s1', 10)), null);
  assert.equal(h.lookups.hostFor(ts('s2', 11)), null);
  assert.equal(h.refreshes(), 0);
});

test('host lookups: desktop sessions are never resolved', () => {
  const h = setup();
  assert.equal(h.lookups.hostFor({ sessionId: 'd', pid: 5, procStart: '1', source: 'desktop' }), null);
  assert.equal(h.lookups.hostFor({ sessionId: 'd', pid: 5, procStart: '1' }), null);
  assert.equal(h.calls.length, 0);
});

test('host lookups: a session with a new pid or procStart is looked up again', async () => {
  const h = setup({ answers: { 10: { name: 'Zed', ownerPid: 1 }, 12: { name: 'VS Code', ownerPid: 2 } } });
  h.lookups.hostFor(ts('s1', 10));
  await flush();
  assert.equal(h.lookups.hostFor(ts('s1', 10)), 'Zed');
  assert.equal(h.lookups.hostFor(ts('s1', 12)), null);
  await flush();
  assert.equal(h.lookups.hostFor(ts('s1', 12)), 'VS Code');
  assert.equal(h.lookups.hostFor(ts('s1', 12, '999')), null);
  assert.equal(h.calls.length, 3);
});

test('host lookups: a stale answer for an old pid is dropped', async () => {
  const h = setup();
  h.lookups.hostFor(ts('s1', 10));
  h.lookups.hostFor(ts('s1', 12));
  assert.equal(h.calls.length, 2);
  h.pending[0].resolve({ name: 'Zed', ownerPid: 1 });
  await flush();
  assert.equal(h.refreshes(), 0);
  assert.equal(h.lookups.hostFor(ts('s1', 12)), null);
  h.pending[1].resolve({ name: 'VS Code', ownerPid: 2 });
  await flush();
  assert.equal(h.lookups.hostFor(ts('s1', 12)), 'VS Code');
});

test('host lookups: prune forgets sessions that left, and a late answer for them is dropped', async () => {
  const h = setup();
  h.lookups.hostFor(ts('s1', 10));
  h.lookups.hostFor(ts('s2', 11));
  h.lookups.prune(['s2']);
  h.pending[0].resolve({ name: 'Zed', ownerPid: 1 });
  await flush();
  assert.equal(h.refreshes(), 0);
  // s1 comes back: a fresh lookup.
  h.lookups.hostFor(ts('s1', 10));
  assert.equal(h.calls.length, 3);
});

test('host lookups: bad session values give null without a resolve', () => {
  const h = setup();
  for (const s of [null, undefined, 'x', { source: 'terminal' }, { sessionId: 5, source: 'terminal', pid: 1 }]) {
    assert.equal(h.lookups.hostFor(s), null);
  }
  assert.equal(h.calls.length, 0);
});
