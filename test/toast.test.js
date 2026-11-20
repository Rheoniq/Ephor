'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createToastQueue } = require('../src/main/toast');

// Minimal fake clock: timers fire only when advance() passes their due time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].due;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

const t = (sessionId, kind = 'waiting') => ({ sessionId, name: `n-${sessionId}`, kind });

function setup() {
  const clock = fakeClock();
  const shown = [];
  const q = createToastQueue({
    show: (toast) => shown.push(toast),
    durationMs: 4000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, shown, q };
}

test('three toasts show one at a time, each after durationMs', () => {
  const { clock, shown, q } = setup();
  q.push(t('a'));
  q.push(t('b'));
  q.push(t('c'));
  assert.deepEqual(shown.map((x) => x.sessionId), ['a']);
  clock.advance(3999);
  assert.equal(shown.length, 1);
  clock.advance(1);
  assert.deepEqual(shown.map((x) => x.sessionId), ['a', 'b']);
  clock.advance(4000);
  assert.deepEqual(shown.map((x) => x.sessionId), ['a', 'b', 'c']);
  clock.advance(4000);
  assert.equal(shown.length, 3);
  assert.equal(clock.pending(), 0);
});

test('a push after the queue drained shows at once', () => {
  const { clock, shown, q } = setup();
  q.push(t('a'));
  clock.advance(4000);
  q.push(t('b'));
  assert.deepEqual(shown.map((x) => x.sessionId), ['a', 'b']);
});

test('duplicate of the showing toast is dropped', () => {
  const { clock, shown, q } = setup();
  q.push(t('a'));
  q.push(t('a'));
  clock.advance(8000);
  assert.equal(shown.length, 1);
});

test('duplicate of a queued toast is dropped, other kind is kept', () => {
  const { clock, shown, q } = setup();
  q.push(t('a'));
  q.push(t('b'));
  q.push(t('b'));
  q.push(t('b', 'finished'));
  clock.advance(12000);
  assert.deepEqual(shown.map((x) => [x.sessionId, x.kind]), [
    ['a', 'waiting'],
    ['b', 'waiting'],
    ['b', 'finished'],
  ]);
});

test('seven pushes keep at most five pending, oldest dropped', () => {
  const { clock, shown, q } = setup();
  for (const id of ['1', '2', '3', '4', '5', '6', '7']) q.push(t(id));
  // '1' shows at once; '2' to '7' are six pending, so '2' is dropped.
  clock.advance(4000 * 10);
  assert.deepEqual(shown.map((x) => x.sessionId), ['1', '3', '4', '5', '6', '7']);
});

test('clear stops the chain', () => {
  const { clock, shown, q } = setup();
  q.push(t('a'));
  q.push(t('b'));
  q.clear();
  clock.advance(20000);
  assert.equal(shown.length, 1);
  assert.equal(clock.pending(), 0);
  q.push(t('c'));
  assert.deepEqual(shown.map((x) => x.sessionId), ['a', 'c']);
});
