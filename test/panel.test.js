'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampHeight,
  createSnapshotGate,
  toSnapshotSession,
  isShown,
  snapshotPlan,
  createPlanSource,
} = require('../src/main/panel');
const { demoSessions } = require('../src/main/demo');

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
  assert.deepEqual(toSnapshotSession(s), {
    sessionId: 'a',
    hostSessionId: 'local_a',
    name: 'N',
    status: 'busy',
    finished: false,
    plan: null,
    lastCommand: null,
  });
});

test('toSnapshotSession sets finished as a boolean', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'idle', cwd: 'C:\\x' };
  assert.equal(toSnapshotSession(s, undefined, true).finished, true);
  assert.equal(toSnapshotSession(s, undefined, false).finished, false);
  assert.equal(toSnapshotSession(s).finished, false);
  assert.equal(toSnapshotSession(s, undefined, 'yes').finished, false);
});

test('toSnapshotSession adds a prompt only when one is given', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'waiting', cwd: 'C:\\x' };
  const prompt = { id: 'p1', kind: 'permission', toolName: 'Bash', command: 'npm test' };
  assert.deepEqual(toSnapshotSession(s, prompt), {
    sessionId: 'a',
    hostSessionId: 'local_a',
    name: 'N',
    status: 'waiting',
    finished: false,
    plan: null,
    lastCommand: null,
    prompt,
  });
  assert.equal('prompt' in toSnapshotSession(s, null), false);
  assert.equal('prompt' in toSnapshotSession(s), false);
});

test('snapshot gate ignores changes in fields that are not sent', () => {
  const g = createSnapshotGate();
  const base = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy' };
  assert.equal(g.shouldSend({ sessions: [toSnapshotSession({ ...base, updatedAt: 1, pid: 1 })] }), true);
  assert.equal(g.shouldSend({ sessions: [toSnapshotSession({ ...base, updatedAt: 2, pid: 2 })] }), false);
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
  const a = { sessions: [{ sessionId: 'a', status: 'busy', plan: null }] };
  assert.equal(g.shouldSend(a), true);
  assert.equal(g.shouldSend({ sessions: [{ sessionId: 'a', status: 'busy', plan: null }] }), false);
  assert.equal(g.shouldSend({ sessions: [{ sessionId: 'a', status: 'waiting', plan: null }] }), true);
  assert.equal(g.shouldSend({ sessions: [] }), true);
});

test('snapshot gate mark() records a send made elsewhere', () => {
  const g = createSnapshotGate();
  const a = { sessions: [] };
  g.mark(a);
  assert.equal(g.shouldSend(a), false);
});

// --- Plan and last command -------------------------------------------------

const items = (...statuses) => statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));

test('toSnapshotSession carries plan and lastCommand when given', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy', cwd: 'C:\\x' };
  const plan = snapshotPlan(items('completed', 'in_progress'));
  const out = toSnapshotSession(s, undefined, false, plan, 'npm test');
  assert.deepEqual(out.plan, plan);
  assert.equal(out.lastCommand, 'npm test');
  assert.deepEqual(Object.keys(out), [
    'sessionId',
    'hostSessionId',
    'name',
    'status',
    'finished',
    'plan',
    'lastCommand',
  ]);
});

test('toSnapshotSession: plan and lastCommand default to null; non-strings are dropped', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy' };
  const out = toSnapshotSession(s);
  assert.equal(out.plan, null);
  assert.equal(out.lastCommand, null);
  assert.equal(toSnapshotSession(s, undefined, false, undefined, 42).lastCommand, null);
  assert.equal(toSnapshotSession(s, undefined, false, undefined, '').lastCommand, null);
});

test('snapshotPlan is null without items', () => {
  assert.equal(snapshotPlan(null), null);
  assert.equal(snapshotPlan(undefined), null);
  assert.equal(snapshotPlan([]), null);
  assert.equal(snapshotPlan('x'), null);
});

test('snapshotPlan gives the summary fields and the items', () => {
  const plan = snapshotPlan(items('completed', 'completed', 'in_progress', 'pending'));
  assert.deepEqual(plan, {
    items: items('completed', 'completed', 'in_progress', 'pending'),
    total: 4,
    current: 3,
    phase: 'Step 3',
    done: 2,
    state: 'active',
  });
});

test('snapshotPlan: all completed is complete with current at the last item', () => {
  const plan = snapshotPlan(items('completed', 'completed'));
  assert.equal(plan.state, 'complete');
  assert.equal(plan.current, 2);
  assert.equal(plan.done, 2);
});

test('snapshotPlan normalises items and copies them', () => {
  const input = [
    { content: '  multi\n line  ', status: 'weird' },
    { content: '', status: 'pending' },
    'junk',
    { content: 'x'.repeat(500), status: 'in_progress' },
  ];
  const plan = snapshotPlan(input);
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.items[0], { content: 'multi line', status: 'pending' });
  assert.equal(plan.items[1].content.length, 200);
  assert.notEqual(plan.items[0], input[0]);
});

test('snapshotPlan: HTML in item text stays plain data', () => {
  const plan = snapshotPlan([{ content: '<b>x</b>', status: 'in_progress' }]);
  assert.equal(plan.phase, '<b>x</b>');
});

function fakeReader(results, { withForget = true } = {}) {
  const calls = [];
  const forgotten = [];
  const reader = {
    read(file) {
      calls.push(file);
      const r = results[file];
      if (r instanceof Error) throw r;
      return r === undefined ? { items: null, lastCommand: null } : r;
    },
  };
  if (withForget) reader.forget = (file) => forgotten.push(file);
  return { reader, calls, forgotten };
}

const fileFor = (s) => `T/${s.sessionId}.jsonl`;

test('createPlanSource reads the session transcript and summarises it', () => {
  const { reader, calls } = fakeReader({
    'T/a.jsonl': { items: items('completed', 'in_progress', 'pending'), lastCommand: 'npm test' },
  });
  const src = createPlanSource(reader, fileFor);
  const got = src.read({ sessionId: 'a' });
  assert.deepEqual(calls, ['T/a.jsonl']);
  assert.equal(got.lastCommand, 'npm test');
  assert.equal(got.plan.current, 2);
  assert.equal(got.plan.total, 3);
});

test('createPlanSource: no plan gives null, a command still comes through', () => {
  const { reader } = fakeReader({ 'T/a.jsonl': { items: null, lastCommand: 'ls' } });
  const got = createPlanSource(reader, fileFor).read({ sessionId: 'a' });
  assert.deepEqual(got, { plan: null, lastCommand: 'ls' });
});

test('createPlanSource keeps the last good value when a read throws', () => {
  const results = { 'T/a.jsonl': { items: items('in_progress'), lastCommand: 'git status' } };
  const { reader } = fakeReader(results);
  const errors = [];
  const src = createPlanSource(reader, fileFor, (id, err) => errors.push([id, err.message]));
  const good = src.read({ sessionId: 'a' });
  results['T/a.jsonl'] = new Error('boom');
  assert.deepEqual(src.read({ sessionId: 'a' }), good);
  assert.deepEqual(errors, [['a', 'boom']]);
  // A first read that throws gives an empty value.
  results['T/b.jsonl'] = new Error('boom');
  assert.deepEqual(src.read({ sessionId: 'b' }), { plan: null, lastCommand: null });
});

test('createPlanSource survives a bad result shape and a throwing path helper', () => {
  const { reader } = fakeReader({ 'T/a.jsonl': null });
  const src = createPlanSource(reader, fileFor);
  assert.deepEqual(src.read({ sessionId: 'a' }), { plan: null, lastCommand: null });
  const bad = createPlanSource(reader, () => {
    throw new Error('no path');
  });
  assert.deepEqual(bad.read({ sessionId: 'a' }), { plan: null, lastCommand: null });
});

test('createPlanSource.prune forgets sessions that left the kept list', () => {
  const { reader, forgotten } = fakeReader({});
  const src = createPlanSource(reader, fileFor);
  src.read({ sessionId: 'a' });
  src.read({ sessionId: 'b' });
  src.prune(['b', 'c']);
  assert.deepEqual(forgotten, ['T/a.jsonl']);
  src.prune(['b']);
  assert.deepEqual(forgotten, ['T/a.jsonl']);
});

test('createPlanSource.prune works with a reader that has no forget', () => {
  const { reader } = fakeReader({}, { withForget: false });
  const src = createPlanSource(reader, fileFor);
  src.read({ sessionId: 'a' });
  assert.doesNotThrow(() => src.prune([]));
});

test('createPlanSource: the same transcript gives an equal snapshot (gate stays quiet)', () => {
  const { reader } = fakeReader({
    'T/a.jsonl': { items: items('completed', 'in_progress'), lastCommand: 'x' },
  });
  const src = createPlanSource(reader, fileFor);
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy' };
  const g = createSnapshotGate();
  const snap = () => {
    const p = src.read(s);
    return { sessions: [toSnapshotSession(s, undefined, false, p.plan, p.lastCommand)] };
  };
  assert.equal(g.shouldSend(snap()), true);
  assert.equal(g.shouldSend(snap()), false);
});

test('toSnapshotSession sends no steps list, even when the session has one', () => {
  const s = { sessionId: 'a', hostSessionId: 'local_a', name: 'N', status: 'busy', steps: ['Ran: x'] };
  assert.equal('steps' in toSnapshotSession(s), false);
});

test('demo sessions: the planned plans, and a command on each', () => {
  const sessions = demoSessions();
  for (const s of sessions) assert.equal(typeof s.lastCommand, 'string', s.sessionId);
  // Shown in the panel: busy, waiting, or finished (idle now, busy before).
  const shownPlans = sessions
    .filter((s) => s.status !== 'idle' || s.before === 'busy')
    .map((s) => snapshotPlan(s.planItems));
  const active = (total, current, phase) =>
    shownPlans.some(
      (p) => p && p.total === total && p.current === current && p.phase === phase && p.state === 'active',
    );
  assert.ok(active(7, 5, 'Animations'));
  assert.ok(active(5, 2, 'Watching'));
  assert.ok(active(6, 4, 'Drafting'));
  assert.ok(shownPlans.some((p) => p && p.state === 'complete' && p.current === p.total));
  assert.ok(shownPlans.some((p) => p === null));
});
