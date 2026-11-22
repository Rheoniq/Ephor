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

// --- open gate ---------------------------------------------------------------

const { createOpenGate, openTerminal } = require('../src/main/open-target');

test('open gate: the same key shares one in-flight promise and one run', async () => {
  const runs = [];
  const d = deferred();
  const gate = createOpenGate((key) => {
    runs.push(key);
    return d.promise;
  });
  const a = gate.open('t:s1');
  const b = gate.open('t:s1');
  assert.equal(a, b);
  assert.equal(runs.length, 1);
  d.resolve('focused');
  assert.equal(await a, 'focused');
});

test('open gate: different keys run in parallel up to the cap, extra callers get failed at once', async () => {
  const runs = [];
  const ds = [];
  const gate = createOpenGate(
    (key) => {
      runs.push(key);
      const d = deferred();
      ds.push(d);
      return d.promise;
    },
    { maxConcurrent: 2 },
  );
  const a = gate.open('a');
  const b = gate.open('b');
  assert.equal(await gate.open('c'), 'failed');
  assert.deepEqual(runs, ['a', 'b']);
  // A caller for a running key still shares its promise over the cap.
  assert.equal(gate.open('a'), a);
  ds[0].resolve('focused');
  await a;
  const c = gate.open('c');
  assert.deepEqual(runs, ['a', 'b', 'c']);
  ds[1].resolve('ok');
  ds[2].resolve('focused');
  assert.equal(await b, 'ok');
  assert.equal(await c, 'focused');
});

test('open gate: the entry is cleared after a settle, so a later click runs again', async () => {
  let n = 0;
  const gate = createOpenGate(async () => {
    n += 1;
    return 'focused';
  });
  await gate.open('a');
  await gate.open('a');
  assert.equal(n, 2);
});

test('open gate: a rejecting run gives failed and clears the key', async () => {
  let n = 0;
  const gate = createOpenGate(async () => {
    n += 1;
    throw new Error('x');
  });
  assert.equal(await gate.open('a'), 'failed');
  assert.equal(await gate.open('a'), 'failed');
  assert.equal(n, 2);
});

test('open gate: a synchronously throwing run never leaves the key stuck or the cap used', async () => {
  let n = 0;
  const gate = createOpenGate(
    () => {
      n += 1;
      throw new Error('sync');
    },
    { maxConcurrent: 1 },
  );
  assert.equal(await gate.open('a'), 'failed');
  assert.equal(await gate.open('b'), 'failed');
  assert.equal(n, 2);
});

test('open gate: passes the extra arguments to run', async () => {
  const gate = createOpenGate(async (key, x, y) => `${key}${x}${y}`);
  assert.equal(await gate.open('k', 1, 2), 'k12');
});

// --- openTerminal --------------------------------------------------------------

function terminalDeps(kept) {
  const calls = { resolve: [], focus: [], folder: [] };
  return {
    calls,
    deps: {
      kept,
      resolve: async (pid, startKey, options) => {
        calls.resolve.push({ pid, startKey, options });
        return { name: 'Zed', ownerPid: 900 };
      },
      focusWindowOf: async (arg) => {
        calls.focus.push(arg);
        return 'focused';
      },
      folderNameOf: (cwd) => {
        calls.folder.push(cwd);
        return 'B.R.I.A.N';
      },
    },
  };
}

const REG = { sessionId: 's1', source: 'terminal', pid: 31808, cwd: 'C:/Users/x/B.R.I.A.N', procStart: START };

test('openTerminal: pid, cwd and procStart come from main registry copy only', async () => {
  const { calls, deps } = terminalDeps([REG]);
  // A shown snapshot entry or payload carrying its own pid, cwd or procStart
  // has no say: openTerminal takes only the session id.
  const result = await openTerminal('s1', deps);
  assert.equal(result, 'focused');
  assert.deepEqual(calls.resolve, [{ pid: 31808, startKey: START, options: { revalidate: true } }]);
  assert.equal(typeof calls.resolve[0].startKey, 'string');
  assert.deepEqual(calls.folder, ['C:/Users/x/B.R.I.A.N']);
  assert.deepEqual(calls.focus, [{ ownerPid: 900, folderName: 'B.R.I.A.N' }]);
});

test('openTerminal: an object id never matches (no payload fields reach the lookup)', async () => {
  const { calls, deps } = terminalDeps([REG]);
  assert.equal(await openTerminal({ sessionId: 's1', pid: 4, cwd: 'C:/evil', procStart: '1' }, deps), 'failed');
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.focus.length, 0);
});

test('openTerminal: an unknown or non-terminal session gives failed without calling the resolver', async () => {
  const desk = { sessionId: 'd1', source: 'desktop', pid: 5, cwd: 'C:/d', procStart: START };
  const { calls, deps } = terminalDeps([REG, desk]);
  assert.equal(await openTerminal('nope', deps), 'failed');
  assert.equal(await openTerminal('d1', deps), 'failed');
  assert.equal(await openTerminal('s1', { ...deps, kept: undefined }), 'failed');
  assert.equal(await openTerminal('s1', { ...deps, resolve: undefined }), 'failed');
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.focus.length, 0);
});

test('openTerminal: no host gives not-found without a focus call', async () => {
  const { calls, deps } = terminalDeps([REG]);
  deps.resolve = async () => null;
  assert.equal(await openTerminal('s1', deps), 'not-found');
  assert.equal(calls.focus.length, 0);
});
