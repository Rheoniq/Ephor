'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFinished } = require('../src/main/finished');

const s = (sessionId, status) => ({ sessionId, status });

test('the first update marks nothing', () => {
  const f = createFinished();
  f.update([s('a', 'idle'), s('b', 'busy')]);
  assert.equal(f.isFinished('a'), false);
  assert.equal(f.isFinished('b'), false);
});

test('busy to idle marks finished', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), true);
});

test('waiting to idle marks finished', () => {
  const f = createFinished();
  f.update([s('a', 'waiting')]);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), true);
});

test('finished stays through later idle reads', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), true);
});

test('finished clears on markSeen', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  f.markSeen('a');
  assert.equal(f.isFinished('a'), false);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), false);
});

test('finished clears when the session is busy again', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  f.update([s('a', 'busy')]);
  assert.equal(f.isFinished('a'), false);
});

test('finished clears when the session is waiting again', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  f.update([s('a', 'waiting')]);
  assert.equal(f.isFinished('a'), false);
});

test('finished clears when the session disappears and does not come back finished', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'idle')]);
  f.update([]);
  assert.equal(f.isFinished('a'), false);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), false);
});

test('idle to idle never finishes', () => {
  const f = createFinished();
  f.update([s('a', 'idle')]);
  f.update([s('a', 'idle')]);
  f.update([s('a', 'idle')]);
  assert.equal(f.isFinished('a'), false);
});

test('a new session that appears idle is not finished', () => {
  const f = createFinished();
  f.update([s('a', 'busy')]);
  f.update([s('a', 'busy'), s('b', 'idle')]);
  assert.equal(f.isFinished('b'), false);
});

test('two sessions are independent', () => {
  const f = createFinished();
  f.update([s('a', 'busy'), s('b', 'busy')]);
  f.update([s('a', 'idle'), s('b', 'busy')]);
  assert.equal(f.isFinished('a'), true);
  assert.equal(f.isFinished('b'), false);
  f.update([s('a', 'idle'), s('b', 'idle')]);
  f.markSeen('a');
  assert.equal(f.isFinished('a'), false);
  assert.equal(f.isFinished('b'), true);
});

test('markSeen and isFinished on unknown ids are harmless', () => {
  const f = createFinished();
  f.markSeen('nope');
  assert.equal(f.isFinished('nope'), false);
});
