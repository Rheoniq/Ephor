'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventDetector } = require('../src/main/events');

const s = (sessionId, status, name = `name-${sessionId}`) => ({ sessionId, name, status });

test('first call emits nothing', () => {
  const d = createEventDetector();
  assert.deepEqual(d.detect([s('a', 'waiting'), s('b', 'idle')]), []);
});

test('idle to waiting emits waiting', () => {
  const d = createEventDetector();
  d.detect([s('a', 'idle')]);
  assert.deepEqual(d.detect([s('a', 'waiting', 'Alpha')]), [
    { sessionId: 'a', name: 'Alpha', kind: 'waiting' },
  ]);
});

test('busy to idle emits finished', () => {
  const d = createEventDetector();
  d.detect([s('a', 'busy')]);
  assert.deepEqual(d.detect([s('a', 'idle', 'Alpha')]), [
    { sessionId: 'a', name: 'Alpha', kind: 'finished' },
  ]);
});

test('busy to waiting emits waiting', () => {
  const d = createEventDetector();
  d.detect([s('a', 'busy')]);
  assert.deepEqual(d.detect([s('a', 'waiting', 'Alpha')]), [
    { sessionId: 'a', name: 'Alpha', kind: 'waiting' },
  ]);
});

test('waiting to busy emits nothing', () => {
  const d = createEventDetector();
  d.detect([s('a', 'waiting')]);
  assert.deepEqual(d.detect([s('a', 'busy')]), []);
});

test('unchanged status emits nothing on later calls', () => {
  const d = createEventDetector();
  d.detect([s('a', 'waiting')]);
  d.detect([s('a', 'idle')]);
  assert.deepEqual(d.detect([s('a', 'idle')]), []);
});

test('vanished session returning idle does not emit finished', () => {
  const d = createEventDetector();
  d.detect([s('a', 'busy'), s('b', 'idle')]);
  d.detect([s('b', 'idle')]); // a vanished and is forgotten
  assert.deepEqual(d.detect([s('a', 'idle'), s('b', 'idle')]), []);
});

test('several sessions report their own events', () => {
  const d = createEventDetector();
  d.detect([s('a', 'busy'), s('b', 'idle'), s('c', 'busy')]);
  const events = d.detect([s('a', 'idle'), s('b', 'waiting'), s('c', 'busy')]);
  assert.deepEqual(events.map((e) => [e.sessionId, e.kind]), [
    ['a', 'finished'],
    ['b', 'waiting'],
  ]);
});
