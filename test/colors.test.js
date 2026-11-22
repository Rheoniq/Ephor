'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assignColors } = require('../src/renderer/colors');

const obj = (m) => Object.fromEntries(m);

test('assignColors gives new ids the lowest free index in order', () => {
  const m = assignColors(['a', 'b', 'c'], new Map(), 12);
  assert.deepEqual(obj(m), { a: 0, b: 1, c: 2 });
});

test('assignColors keeps the color of a session when another one leaves', () => {
  const first = assignColors(['a', 'b', 'c'], new Map(), 12);
  const next = assignColors(['a', 'c'], first, 12);
  assert.deepEqual(obj(next), { a: 0, c: 2 });
});

test('assignColors releases the index of a session that left and reuses it', () => {
  const first = assignColors(['a', 'b', 'c'], new Map(), 12);
  const gone = assignColors(['a', 'c'], first, 12);
  assert.equal(gone.has('b'), false);
  const next = assignColors(['a', 'c', 'd'], gone, 12);
  assert.deepEqual(obj(next), { a: 0, c: 2, d: 1 });
});

test('assignColors never gives two ids the same index while the palette lasts', () => {
  let m = new Map();
  const ids = [];
  for (let n = 0; n < 12; n++) {
    ids.push(`s-${n}`);
    m = assignColors(ids, m, 12);
    assert.equal(new Set(m.values()).size, ids.length);
  }
  // Drop a few, add new ones: still all distinct.
  m = assignColors(['s-1', 's-4', 's-7', 'x', 'y'], m, 12);
  assert.equal(new Set(m.values()).size, 5);
  assert.deepEqual([m.get('s-1'), m.get('s-4'), m.get('s-7')], [1, 4, 7]);
  assert.deepEqual([m.get('x'), m.get('y')], [0, 2]);
});

test('assignColors reuses the least used index when ids outnumber the palette', () => {
  const m = assignColors(['a', 'b', 'c', 'd', 'e'], new Map(), 3);
  assert.deepEqual(obj(m), { a: 0, b: 1, c: 2, d: 0, e: 1 });
  // Index 0 and 1 are used twice, 2 once: the next id gets 2.
  const next = assignColors(['a', 'b', 'c', 'd', 'e', 'f'], m, 3);
  assert.equal(next.get('f'), 2);
  for (const k of ['a', 'b', 'c', 'd', 'e']) assert.equal(next.get(k), m.get(k));
});

test('assignColors with 14 sessions on 12 colors does not throw and frees on leave', () => {
  const ids = Array.from({ length: 14 }, (_, n) => `s-${n}`);
  const m = assignColors(ids, new Map(), 12);
  assert.equal(m.size, 14);
  for (const v of m.values()) assert.ok(Number.isInteger(v) && v >= 0 && v < 12);
  assert.equal(new Set(m.values()).size, 12);
  // s-12 and s-13 share 0 and 1; when s-0 leaves, index 0 is used only once.
  const after = assignColors(ids.filter((i) => i !== 's-0' && i !== 's-12'), m, 12);
  const fresh = assignColors([...after.keys(), 'new'], after, 12);
  assert.equal(fresh.get('new'), 0);
});

test('assignColors is pure and deterministic', () => {
  const prev = new Map([['a', 3]]);
  const snapshot = obj(prev);
  const x = assignColors(['b', 'a', 'c'], prev, 12);
  const y = assignColors(['b', 'a', 'c'], prev, 12);
  assert.deepEqual(obj(prev), snapshot, 'previous is not changed');
  assert.notEqual(x, prev);
  assert.deepEqual(obj(x), obj(y));
  assert.deepEqual(obj(x), { b: 0, a: 3, c: 1 });
});

test('assignColors tolerates odd input', () => {
  assert.equal(assignColors([], new Map(), 12).size, 0);
  assert.equal(assignColors(undefined, undefined, 12).size, 0);
  // Duplicate ids count once; a stale out-of-range index is reassigned.
  const m = assignColors(['a', 'a', 'b'], new Map([['b', 40]]), 12);
  assert.deepEqual(obj(m), { a: 0, b: 1 });
});
