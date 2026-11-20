'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clampHeight, createSnapshotGate } = require('../src/main/panel');

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
