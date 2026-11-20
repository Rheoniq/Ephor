'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrace } = require('../src/main/grace');

const s = (id, status = 'busy') => ({ sessionId: id, status });
const ids = (list) => list.map((x) => x.sessionId);

test('passes current sessions through unchanged', () => {
  const g = createGrace(2);
  assert.deepEqual(ids(g.apply([s('a'), s('b')])), ['a', 'b']);
});

test('keeps a missing session for 2 refreshes with last good data, drops on the 3rd', () => {
  const g = createGrace(2);
  g.apply([s('a'), s('b', 'waiting')]);
  const r1 = g.apply([s('a')]);
  assert.deepEqual(ids(r1), ['a', 'b']);
  assert.equal(r1[1].status, 'waiting');
  assert.deepEqual(ids(g.apply([s('a')])), ['a', 'b']);
  assert.deepEqual(ids(g.apply([s('a')])), ['a']);
  assert.deepEqual(ids(g.apply([s('a')])), ['a']);
});

test('a reappearing session resets its miss count and takes the new data', () => {
  const g = createGrace(2);
  g.apply([s('a', 'busy')]);
  g.apply([]);
  g.apply([]);
  const back = g.apply([s('a', 'idle')]);
  assert.equal(back[0].status, 'idle');
  g.apply([]);
  assert.deepEqual(ids(g.apply([])), ['a']);
  assert.deepEqual(ids(g.apply([])), []);
});
