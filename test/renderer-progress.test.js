'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { barLabel, fillPercent, planRows, cutText, showsBar, PHASE_MAX } = require('../src/renderer/progress');

// A plan as the snapshot carries it (panel.js snapshotPlan): the items before
// `current` are completed, item `current` is in progress, the rest pending.
// `current` past the end gives a complete plan.
function plan(contents, current) {
  const items = contents.map((content, i) => ({
    content,
    status: i + 1 < current ? 'completed' : i + 1 === current ? 'in_progress' : 'pending',
  }));
  const total = items.length;
  const complete = current > total;
  return {
    items,
    total,
    current: complete ? total : current,
    phase: complete ? contents[total - 1] : contents[current - 1],
    done: items.filter((x) => x.status === 'completed').length,
    state: complete ? 'complete' : 'active',
  };
}

const SEVEN = ['Read the spec', 'Plan model', 'Transcript reader', 'Snapshot wiring', 'Animations', 'Docs', 'Review'];

test('barLabel: an active plan reads current/total and the phase', () => {
  const label = barLabel(plan(SEVEN, 5));
  assert.equal(label.text, '5/7 Animations');
  assert.equal(label.count, '5/7');
  assert.equal(label.phase, 'Animations');
  assert.equal(label.full, 'Animations');
  assert.equal(label.complete, false);
});

test('barLabel: the number is the current step, not the done count', () => {
  // Two done, the third active: 3/5.
  assert.equal(barLabel(plan(['a', 'b', 'c', 'd', 'e'], 3)).text, '3/5 c');
});

test('barLabel: a complete plan reads total/total Done', () => {
  const label = barLabel(plan(SEVEN, 8));
  assert.equal(label.text, '7/7 Done');
  assert.equal(label.count, '7/7');
  assert.equal(label.phase, 'Done');
  assert.equal(label.complete, true);
});

test('barLabel: a long phase is cut to about 28 characters, the full text kept', () => {
  const long = 'Wire the plan reader into the snapshot and the demo data';
  const label = barLabel(plan(['First', long, 'Last'], 2));
  assert.ok(label.phase.length <= PHASE_MAX, label.phase);
  assert.ok(label.phase.endsWith('\u2026'), label.phase);
  assert.ok(long.startsWith(label.phase.slice(0, -1).trimEnd()));
  assert.equal(label.full, long);
  assert.equal(label.text, `2/3 ${label.phase}`);
  // The title and the spoken text carry the whole phase.
  assert.ok(label.title.includes(long));
  assert.ok(label.spoken.includes(long));
});

test('barLabel: a phase of exactly PHASE_MAX characters is not cut', () => {
  const exact = 'x'.repeat(PHASE_MAX);
  assert.equal(barLabel(plan(['a', exact], 2)).phase, exact);
});

test('barLabel: title and spoken text name the step in words', () => {
  const active = barLabel(plan(SEVEN, 5));
  assert.equal(active.title, 'Step 5 of 7: Animations');
  assert.equal(active.spoken, 'step 5 of 7: Animations');
  const complete = barLabel(plan(SEVEN, 8));
  assert.equal(complete.title, 'All 7 steps done');
  assert.equal(complete.spoken, 'all 7 steps done');
  const one = barLabel(plan(['Only'], 2));
  assert.equal(one.title, 'The 1 step is done');
});

test('barLabel: no plan, or a malformed one, gives null', () => {
  for (const bad of [
    null,
    undefined,
    'x',
    [],
    {},
    { total: 0, current: 0, items: [] },
    { total: 3, current: 4, items: [], phase: 'x' },
    { total: 3, current: 0, items: [], phase: 'x' },
    { total: 2.5, current: 1, items: [], phase: 'x' },
    { total: 3, current: 1, items: 'nope', phase: 'x' },
  ]) {
    assert.equal(barLabel(bad), null, JSON.stringify(bad));
  }
});

test('barLabel: a missing or non-string phase reads as an empty phase', () => {
  const p = plan(['a', 'b'], 1);
  p.phase = 42;
  assert.equal(barLabel(p).text, '1/2');
  assert.equal(barLabel(p).phase, '');
});

test('barLabel: HTML in the phase stays plain text', () => {
  assert.equal(barLabel(plan(['<b>x</b>'], 1)).text, '1/1 <b>x</b>');
});

test('fillPercent: current over total, clamped to 0..100', () => {
  assert.equal(fillPercent(plan(SEVEN, 5)), (5 / 7) * 100);
  assert.equal(fillPercent(plan(SEVEN, 1)), (1 / 7) * 100);
  assert.equal(fillPercent(plan(SEVEN, 8)), 100);
  assert.equal(fillPercent({ total: 4, current: 9, items: [] }), 0, 'malformed plans give 0');
  assert.equal(fillPercent({ total: 4, current: -1, items: [] }), 0);
  assert.equal(fillPercent(null), 0);
});

test('fillPercent: a complete plan is full even with a stale current', () => {
  const p = plan(SEVEN, 8);
  p.current = 3;
  assert.equal(fillPercent(p), 100);
});

test('showsBar: a busy session with a complete plan shows its Working tag, not the bar', () => {
  // A follow-up that made no new plan: "7/7 Done" with a full bar would hide
  // that the session is working.
  assert.equal(showsBar(plan(SEVEN, 8), 'busy'), false);
});

test('showsBar: waiting, idle and finished sessions with a complete plan show the bar', () => {
  assert.equal(showsBar(plan(SEVEN, 8), 'waiting'), true);
  assert.equal(showsBar(plan(SEVEN, 8), 'idle'), true);
  assert.equal(showsBar(plan(SEVEN, 8), 'finished'), true);
});

test('showsBar: an active plan shows the bar for every status', () => {
  for (const status of ['busy', 'waiting', 'idle', 'finished']) {
    assert.equal(showsBar(plan(SEVEN, 5), status), true, status);
    assert.equal(showsBar(plan(SEVEN, 7), status), true, `${status}, last step active`);
  }
});

test('showsBar: no plan, or a malformed one, shows no bar', () => {
  for (const bad of [null, undefined, {}, { total: 3, current: 4, items: [], state: 'active' }]) {
    assert.equal(showsBar(bad, 'busy'), false, JSON.stringify(bad));
    assert.equal(showsBar(bad, 'waiting'), false, JSON.stringify(bad));
  }
});

test('planRows: one row per item in order, marked by status', () => {
  const rows = planRows(plan(['a', 'b', 'c', 'd'], 3));
  assert.deepEqual(
    rows.map((r) => [r.text, r.status, r.mark, r.active]),
    [
      ['a', 'completed', 'checked', false],
      ['b', 'completed', 'checked', false],
      ['c', 'in_progress', 'spinner', true],
      ['d', 'pending', 'empty', false],
    ],
  );
});

test('planRows: each row has words for screen readers', () => {
  const rows = planRows(plan(['a', 'b', 'c'], 2));
  assert.deepEqual(
    rows.map((r) => r.spoken),
    ['Done', 'Now', 'To do'],
  );
});

test('planRows: unknown statuses read as pending, junk items are skipped', () => {
  const rows = planRows({
    total: 3,
    current: 1,
    phase: 'a',
    state: 'active',
    items: [{ content: 'a', status: 'weird' }, null, 'junk', { content: 7, status: 'completed' }, { status: 'pending' }],
  });
  assert.deepEqual(
    rows.map((r) => [r.text, r.status, r.mark]),
    [
      ['a', 'pending', 'empty'],
      ['7', 'completed', 'checked'],
    ],
  );
});

test('planRows: no plan gives no rows', () => {
  assert.deepEqual(planRows(null), []);
  assert.deepEqual(planRows({ items: 'x' }), []);
});

test('planRows: 30 items and long text come through whole', () => {
  const long = 'y'.repeat(200);
  const contents = Array.from({ length: 30 }, (_, i) => (i === 29 ? long : `Item ${i + 1}`));
  const rows = planRows(plan(contents, 30));
  assert.equal(rows.length, 30);
  assert.equal(rows[29].text, long);
  assert.equal(rows[29].mark, 'spinner');
});

test('cutText keeps a surrogate pair whole', () => {
  const s = 'a'.repeat(26) + '\u{1F600}' + 'bbbb';
  const cut = cutText(s, 28);
  assert.ok(cut.length <= 28);
  assert.ok(cut.endsWith('\u2026'));
  const last = cut.charCodeAt(cut.length - 2);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no half surrogate before the ellipsis');
});

test('cutText leaves short text alone and handles non-strings', () => {
  assert.equal(cutText('short', 28), 'short');
  assert.equal(cutText(undefined, 28), '');
  assert.equal(cutText('   padded   ', 28), 'padded');
});
