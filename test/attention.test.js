'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attentionCounts, badgeKind, trayTooltip, attentionKey, drawBadge } = require('../src/main/attention');

const S = (sessionId, extra) => ({ sessionId, status: 'busy', finished: false, ...extra });

test('counts waiting (status or prompt) and finished (idle, no prompt)', () => {
  const counts = attentionCounts([
    S('a', { status: 'waiting' }),
    S('b', { prompt: { id: 'p' } }),
    S('c', { status: 'idle', finished: true }),
    S('d', { status: 'idle', finished: true, prompt: { id: 'q' } }),
    S('e'),
    S('f', { status: 'idle' }),
  ]);
  assert.deepEqual(counts, { waiting: 3, finished: 1 });
});

test('counts ignore junk and repeated ids', () => {
  assert.deepEqual(attentionCounts(null), { waiting: 0, finished: 0 });
  assert.deepEqual(attentionCounts([null, 3, S('a', { status: 'waiting' }), S('a', { status: 'waiting' })]), {
    waiting: 1,
    finished: 0,
  });
});

test('badge: waiting wins over finished, none when nothing', () => {
  assert.equal(badgeKind({ waiting: 1, finished: 2 }), 'waiting');
  assert.equal(badgeKind({ waiting: 0, finished: 2 }), 'finished');
  assert.equal(badgeKind({ waiting: 0, finished: 0 }), null);
  assert.equal(badgeKind(null), null);
});

test('tooltip lists the non-zero parts and keeps the answering note', () => {
  assert.equal(trayTooltip({ waiting: 0, finished: 0 }), 'Ephor');
  assert.equal(trayTooltip({ waiting: 1, finished: 2 }), 'Ephor\n1 waiting, 2 finished');
  assert.equal(trayTooltip({ waiting: 0, finished: 2 }), 'Ephor\n2 finished');
  assert.equal(trayTooltip({ waiting: 3, finished: 0 }), 'Ephor\n3 waiting');
  assert.equal(trayTooltip({ waiting: 0, finished: 0 }, 'Answering off'), 'Ephor\nAnswering off');
  assert.equal(trayTooltip({ waiting: 1, finished: 0 }, 'Answering off'), 'Ephor\n1 waiting\nAnswering off');
});

test('key changes only when tooltip or badge change', () => {
  const a = attentionKey({ waiting: 1, finished: 0 }, null);
  assert.equal(a, attentionKey({ waiting: 1, finished: 0 }, null));
  assert.notEqual(a, attentionKey({ waiting: 2, finished: 0 }, null));
  assert.notEqual(a, attentionKey({ waiting: 1, finished: 0 }, 'note'));
});

test('drawBadge paints the bottom-right corner in BGRA and leaves the top-left', () => {
  const w = 16;
  const buf = Buffer.alloc(w * w * 4, 0);
  drawBadge(buf, w, w, 'waiting');
  const px = (x, y) => [...buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  assert.deepEqual(px(0, 0), [0, 0, 0, 0]);
  assert.deepEqual(px(11, 11), [87, 119, 217, 255]); // B, G, R, A of clay
  drawBadge(buf, w, w, 'bogus'); // unknown kind: no change, no throw
  const g = Buffer.alloc(w * w * 4, 0);
  drawBadge(g, w, w, 'finished');
  assert.deepEqual([...g.subarray((11 * w + 11) * 4, (11 * w + 11) * 4 + 4)], [77, 163, 63, 255]);
});
