'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeItems, applyUpdate, replayPlan, summarize, WRAP_UP } = require('../src/main/plan');

const P = 'pending';
const A = 'in_progress';
const C = 'completed';

function list(...statuses) {
  return statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));
}

function statuses(items) {
  return items.map((i) => i.status);
}

// normalizeItems

test('normalizeItems keeps valid items and maps unknown statuses to pending', () => {
  const out = normalizeItems([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'weird' },
    { content: 'e' },
  ]);
  assert.deepEqual(out, [
    { content: 'a', status: C },
    { content: 'b', status: A },
    { content: 'c', status: P },
    { content: 'd', status: P },
    { content: 'e', status: P },
  ]);
});

test('normalizeItems drops non-objects, empty and non-string content', () => {
  const out = normalizeItems([null, 3, 'x', [], {}, { content: '' }, { content: '   ' }, { content: 5 }, { content: 'ok', status: C }]);
  assert.deepEqual(out, [{ content: 'ok', status: C }]);
});

test('normalizeItems returns [] for a non-array', () => {
  assert.deepEqual(normalizeItems(undefined), []);
  assert.deepEqual(normalizeItems({ content: 'a' }), []);
  assert.deepEqual(normalizeItems('abc'), []);
});

test('normalizeItems collapses content to one line and truncates to 200 chars', () => {
  const out = normalizeItems([{ content: 'line one\n\tline   two ' }, { content: 'x'.repeat(500) }]);
  assert.equal(out[0].content, 'line one line two');
  assert.equal(out[1].content.length, 200);
  assert.ok(out[1].content.endsWith('…'));
});

test('normalizeItems keeps at most 30 items', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ content: `s${i}`, status: P }));
  const out = normalizeItems(many);
  assert.equal(out.length, 30);
  assert.equal(out[29].content, 's29');
});

// Hostile text: nothing invisible or reordering may reach the panel.
const NO_HIDDEN = /[\p{Cc}\p{Cf}͏︀-️\u{e0100}-\u{e01ef}ﾠㅤᅟᅠ⠀]/u;
const one = (content) => normalizeItems([{ content }])[0].content;

test('normalizeItems shows bidi overrides and isolates as ?', () => {
  assert.equal(one('Deploy ‮gnp.exe‬ now'), 'Deploy ?gnp.exe? now');
  assert.equal(one('‪‫‬‭‮|⁦⁧⁨⁩|‎‏؜'), '?????|????|???');
});

test('normalizeItems shows zero-width, BOM and soft hyphen characters as ?', () => {
  assert.equal(one('a​b‌c‍d﻿e­f⁠g'), 'a?b?c?d?e?f?g');
  assert.equal(one('﻿'), '?', 'a lone BOM is not taken for whitespace and dropped');
});

test('normalizeItems shows C0 and C1 controls as ?, but line breaks and tabs collapse to a space', () => {
  assert.equal(one('a\u0000b\u001B[2Kc\u007Fd\u0085e\u009Bf'), 'a?b?[2Kc?d?e?f');
  assert.equal(one('a\r\n\tb\u000Bc\u000Cd'), 'a b c d');
});

test('normalizeItems shows variation selectors and blank-looking characters as ?', () => {
  assert.equal(one('x️y︀z\u{E0100}w\u{E01EF}'), 'x?y?z?w?');
  assert.equal(one('[ﾠㅤᅟᅠ⠀͏]'), '[??????]');
});

test('normalizeItems output never carries a hidden character', () => {
  let all = '';
  for (let c = 0; c <= 0x3200; c++) all += String.fromCharCode(c);
  all += '﻿ﾠ\u{E0001}\u{E0020}\u{E007F}\u{E0100}\u{E01EF}';
  for (let k = 0; k < all.length; k += 150) {
    const out = normalizeItems([{ content: 'x' + all.slice(k, k + 150) }]);
    assert.ok(!NO_HIDDEN.test(out[0].content), `slice at ${k}`);
  }
});

test('normalizeItems collapses other spaces to one plain space', () => {
  assert.equal(one('a 　 b c'), 'a b c');
});

test('normalizeItems never cuts a surrogate pair in half', () => {
  // The emoji straddles the cut: its high half would be the 199th unit.
  const out = one('a'.repeat(198) + '\u{1F600}' + 'bbb');
  assert.ok(out.isWellFormed(), 'no lone surrogate');
  assert.equal(out, 'a'.repeat(198) + '…');
  // An emoji just before the cut stays whole.
  const kept = one('a'.repeat(197) + '\u{1F600}' + 'bbb');
  assert.equal(kept, 'a'.repeat(197) + '\u{1F600}' + '…');
  assert.equal(kept.length, 200);
});

test('normalizeItems keeps HTML in content as plain data', () => {
  const out = normalizeItems([{ content: '<img src=x onerror=alert(1)>', status: P }]);
  assert.equal(out[0].content, '<img src=x onerror=alert(1)>');
});

// applyUpdate

test('applyUpdate with items replaces the list', () => {
  const out = applyUpdate(list(C, A), { items: [{ content: 'new', status: 'in_progress' }], scope: 'new_task' });
  assert.deepEqual(out, [{ content: 'new', status: A }]);
  assert.deepEqual(applyUpdate(null, { items: [{ content: 'x' }] }), [{ content: 'x', status: P }]);
});

test('applyUpdate advance completes the active item and starts the next pending', () => {
  assert.deepEqual(statuses(applyUpdate(list(C, A, P, P), { advance: true })), [C, C, A, P]);
});

test('applyUpdate advance with none active completes the first pending and starts the next', () => {
  assert.deepEqual(statuses(applyUpdate(list(C, P, P), { advance: true })), [C, C, A]);
});

test('applyUpdate advance at the end of the list completes everything', () => {
  assert.deepEqual(statuses(applyUpdate(list(C, C, A), { advance: true })), [C, C, C]);
  assert.deepEqual(statuses(applyUpdate(list(C, C, C), { advance: true })), [C, C, C]);
});

test('applyUpdate advance does not mutate its input', () => {
  const before = list(A, P);
  applyUpdate(before, { advance: true });
  assert.deepEqual(statuses(before), [A, P]);
});

test('applyUpdate done marks 1-based indexes completed and start sets one in progress', () => {
  assert.deepEqual(statuses(applyUpdate(list(A, P, P, P), { done: [1, 2], start: 3 })), [C, C, A, P]);
  assert.deepEqual(statuses(applyUpdate(list(P, P, P), { done: [2] })), [P, C, P]);
  assert.deepEqual(statuses(applyUpdate(list(C, P, P), { start: 3 })), [C, P, A]);
});

test('applyUpdate start moves the active item back to pending', () => {
  assert.deepEqual(statuses(applyUpdate(list(C, A, P, P), { start: 4 })), [C, P, P, A]);
});

test('applyUpdate ignores out-of-range indexes', () => {
  assert.deepEqual(statuses(applyUpdate(list(A, P), { done: [0, 3, -1, 1.5], start: 9 })), [A, P]);
  assert.deepEqual(statuses(applyUpdate(list(A, P), { done: [1, 7], start: 2 })), [C, A]);
});

test('applyUpdate returns items unchanged for malformed or unknown input', () => {
  const items = list(A, P);
  for (const input of [null, undefined, 5, 'advance', [], {}, { foo: 1 }, { advance: 'yes' }, { done: 'x' }, { start: 'x' }, { items: 'x' }]) {
    assert.equal(applyUpdate(items, input), items, JSON.stringify(input));
  }
});

test('applyUpdate without a list only accepts an items input', () => {
  assert.equal(applyUpdate(null, { advance: true }), null);
  assert.equal(applyUpdate(null, { done: [1], start: 2 }), null);
});

// replayPlan

test('replayPlan folds inputs in order from null', () => {
  const items = [{ content: 'a' }, { content: 'b' }, { content: 'c' }];
  const out = replayPlan([
    { advance: true },
    { items: items.map((i, n) => ({ ...i, status: n === 0 ? 'in_progress' : 'pending' })) },
    { advance: true },
    { done: [2], start: 3 },
  ]);
  assert.deepEqual(statuses(out), [C, C, A]);
  assert.equal(replayPlan([]), null);
  assert.equal(replayPlan('junk'), null);
});

test('replayPlan restarts from a later items call', () => {
  const out = replayPlan([
    { items: [{ content: 'old', status: 'in_progress' }] },
    { items: [{ content: 'n1', status: 'completed' }, { content: 'n2', status: 'in_progress' }] },
  ]);
  assert.deepEqual(out.map((i) => i.content), ['n1', 'n2']);
});

// summarize

test('summarize reports the active item in the middle', () => {
  assert.deepEqual(summarize(list(C, A, P)), { total: 3, current: 2, phase: 'Step 2', done: 1, state: 'active' });
});

test('summarize with none active uses the first pending item', () => {
  assert.deepEqual(summarize(list(C, P, P)), { total: 3, current: 2, phase: 'Step 2', done: 1, state: 'active' });
});

test('summarize with all completed gives current === total and complete', () => {
  assert.deepEqual(summarize(list(C, C, C)), { total: 3, current: 3, phase: 'Step 3', done: 3, state: 'complete' });
});

test('summarize returns null for no items', () => {
  assert.equal(summarize(null), null);
  assert.equal(summarize([]), null);
  assert.equal(summarize(undefined), null);
});

test('applyUpdate with the same index in done and start leaves it in progress', () => {
  // done is applied first, then start: {done:[2],start:2} ends with item 2 in progress.
  assert.deepEqual(statuses(applyUpdate(list(C, P, P), { done: [2], start: 2 })), [C, A, P]);
});

test('summarize handles a single item', () => {
  assert.deepEqual(summarize(list(A)), { total: 1, current: 1, phase: 'Step 1', done: 0, state: 'active' });
});

// wrap_up: the end-of-turn call that checks the whole plan off

test('applyUpdate with WRAP_UP completes every item without mutating the input', () => {
  const before = list(C, A, P, P);
  const out = applyUpdate(before, WRAP_UP);
  assert.deepEqual(statuses(out), [C, C, C, C]);
  assert.deepEqual(out.map((i) => i.content), ['Step 1', 'Step 2', 'Step 3', 'Step 4']);
  assert.deepEqual(statuses(before), [C, A, P, P]);
  assert.equal(summarize(out).state, 'complete');
});

test('applyUpdate with WRAP_UP before any plan changes nothing', () => {
  assert.equal(applyUpdate(null, WRAP_UP), null);
  assert.equal(replayPlan([WRAP_UP]), null);
  assert.deepEqual(applyUpdate([], WRAP_UP), []);
});

test('WRAP_UP is a marker only the reader makes: a look-alike input is ignored', () => {
  const items = list(A, P);
  assert.equal(applyUpdate(items, { __wrapUp: true }), items);
  assert.equal(applyUpdate(items, JSON.parse(JSON.stringify({ wrapUp: true }))), items);
  assert.ok(Object.isFrozen(WRAP_UP));
});

test('replayPlan: a wrap_up then a new items call gives the new plan', () => {
  const out = replayPlan([
    { items: [{ content: 'old', status: 'in_progress' }] },
    WRAP_UP,
    { items: [{ content: 'n1', status: 'in_progress' }, { content: 'n2', status: 'pending' }] },
  ]);
  assert.deepEqual(out, [{ content: 'n1', status: A }, { content: 'n2', status: P }]);
});

test('replayPlan: updates after a wrap_up edit the completed plan in file order', () => {
  const three = { items: [{ content: 'a', status: 'in_progress' }, { content: 'b' }, { content: 'c' }] };
  assert.deepEqual(statuses(replayPlan([three, WRAP_UP, { start: 2 }])), [C, A, C]);
  assert.deepEqual(statuses(replayPlan([three, { advance: true }, WRAP_UP])), [C, C, C]);
  assert.deepEqual(statuses(replayPlan([three, WRAP_UP, { advance: true }])), [C, C, C]);
});
