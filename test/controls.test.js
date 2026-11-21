'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createControls, hideTitle } = require('../src/main/controls');
const { createToastQueue } = require('../src/main/toast');

const PANEL = { id: 'panel' };
const TOAST = { id: 'toast' };
const OTHER = { id: 'other' };

function setup() {
  const calls = [];
  const c = createControls({
    isPanelSender: (event) => event.sender === PANEL,
    isToastSender: (event) => event.sender === TOAST,
    hide: () => calls.push('hide'),
    quit: () => calls.push('quit'),
    closeToast: () => calls.push('close'),
    setToastClickable: (b) => calls.push(`clickable:${b}`),
  });
  return { c, calls };
}

const from = (sender) => ({ sender });

test('hide and quit run only for the panel window', () => {
  const { c, calls } = setup();
  c.onHide(from(OTHER));
  c.onQuit(from(OTHER));
  c.onHide(from(TOAST));
  c.onQuit(from(TOAST));
  assert.deepEqual(calls, []);
  c.onHide(from(PANEL));
  c.onQuit(from(PANEL));
  assert.deepEqual(calls, ['hide', 'quit']);
});

test('toast close and clickable run only for the toast window', () => {
  const { c, calls } = setup();
  c.onToastClose(from(PANEL));
  c.onToastClickable(from(PANEL), true);
  c.onToastClose(from(OTHER));
  c.onToastClickable(from(OTHER), true);
  assert.deepEqual(calls, []);
  c.onToastClickable(from(TOAST), true);
  c.onToastClickable(from(TOAST), false);
  c.onToastClose(from(TOAST));
  assert.deepEqual(calls, ['clickable:true', 'clickable:false', 'close']);
});

test('toast clickable ignores anything but a boolean', () => {
  const { c, calls } = setup();
  for (const v of [1, 0, 'true', null, undefined, {}, []]) c.onToastClickable(from(TOAST), v);
  assert.deepEqual(calls, []);
});

test('a missing or odd event is ignored, never thrown on', () => {
  const { c, calls } = setup();
  assert.doesNotThrow(() => {
    c.onHide(undefined);
    c.onQuit(null);
    c.onToastClose({});
    c.onToastClickable(undefined, true);
  });
  assert.deepEqual(calls, []);
});

test('a throwing action is caught and logged, not thrown', () => {
  const errors = [];
  const c = createControls({
    isPanelSender: () => true,
    isToastSender: () => true,
    hide: () => {
      throw new Error('boom');
    },
    quit: () => {},
    closeToast: () => {
      throw new Error('gone');
    },
    setToastClickable: () => {
      throw new Error('destroyed');
    },
    log: (msg) => errors.push(msg),
  });
  assert.doesNotThrow(() => {
    c.onHide(from(PANEL));
    c.onToastClose(from(TOAST));
    c.onToastClickable(from(TOAST), true);
  });
  assert.equal(errors.length, 3);
});

function dragSetup() {
  const calls = [];
  const c = createControls({
    isPanelSender: (event) => event.sender === PANEL,
    isToastSender: (event) => event.sender === TOAST,
    hide: () => {},
    quit: () => {},
    closeToast: () => {},
    setToastClickable: () => {},
    dragStart: () => calls.push('start'),
    dragTo: (d) => calls.push(`to:${d.dx},${d.dy}`),
    dragEnd: () => calls.push('end'),
  });
  return { c, calls };
}

test('drag messages run only for the panel window', () => {
  const { c, calls } = dragSetup();
  for (const sender of [OTHER, TOAST]) {
    c.onDragStart(from(sender));
    c.onDragTo(from(sender), { dx: 1, dy: 2 });
    c.onDragEnd(from(sender));
  }
  c.onDragStart(undefined);
  c.onDragTo(null, { dx: 1, dy: 2 });
  assert.deepEqual(calls, []);
  c.onDragStart(from(PANEL));
  c.onDragTo(from(PANEL), { dx: 1, dy: -2 });
  c.onDragEnd(from(PANEL));
  assert.deepEqual(calls, ['start', 'to:1,-2', 'end']);
});

test('drag-to ignores anything but finite numbers within +-20000', () => {
  const { c, calls } = dragSetup();
  for (const v of [null, 1, 'x', [], {}, { dx: NaN, dy: 0 }, { dx: 0, dy: Infinity }, { dx: 20001, dy: 0 }]) {
    c.onDragTo(from(PANEL), v);
  }
  assert.deepEqual(calls, []);
});

test('hideTitle names the hotkey, or the tray when there is none', () => {
  assert.equal(hideTitle('Ctrl+Alt+H'), 'Hide panel (Ctrl+Alt+H shows it again)');
  assert.equal(hideTitle(null), 'Hide panel (the tray icon shows it again)');
  assert.equal(hideTitle(''), 'Hide panel (the tray icon shows it again)');
  assert.equal(hideTitle(42), 'Hide panel (the tray icon shows it again)');
});

// The toast queue's skip(): a toast closed on its cross ends its slot now.
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

const toast = (sessionId) => ({ sessionId, name: sessionId, kind: 'waiting' });

function queue() {
  const clock = fakeClock();
  const shown = [];
  const q = createToastQueue({
    show: (t) => shown.push(t.sessionId),
    durationMs: 4000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, shown, q };
}

test('skip shows the next toast at once and restarts its full time', () => {
  const { clock, shown, q } = queue();
  q.push(toast('a'));
  q.push(toast('b'));
  q.push(toast('c'));
  clock.advance(1000);
  q.skip();
  assert.deepEqual(shown, ['a', 'b']);
  assert.equal(clock.pending(), 1);
  clock.advance(3999);
  assert.deepEqual(shown, ['a', 'b']);
  clock.advance(1);
  assert.deepEqual(shown, ['a', 'b', 'c']);
});

test('skip of the last toast leaves the queue idle and a new push shows at once', () => {
  const { clock, shown, q } = queue();
  q.push(toast('a'));
  q.skip();
  assert.equal(clock.pending(), 0);
  q.push(toast('a'));
  assert.deepEqual(shown, ['a', 'a']);
});

test('skip with nothing showing does nothing', () => {
  const { clock, shown, q } = queue();
  assert.doesNotThrow(() => q.skip());
  assert.deepEqual(shown, []);
  assert.equal(clock.pending(), 0);
});
