'use strict';

// Toast queue: shows one toast at a time for durationMs, then the next.
// A toast with the same sessionId and kind as the showing or a queued one is
// dropped; at most MAX_PENDING wait, the oldest is dropped first.

const MAX_PENDING = 5;

const sameToast = (a, b) => !!a && !!b && a.sessionId === b.sessionId && a.kind === b.kind;

function createToastQueue({ show, durationMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null;
  let timer = null;
  const pending = [];

  function next() {
    timer = null;
    current = pending.shift() || null;
    if (!current) return;
    show(current);
    timer = setTimer(next, durationMs);
  }

  return {
    push(toast) {
      if (sameToast(current, toast) || pending.some((p) => sameToast(p, toast))) return;
      pending.push(toast);
      while (pending.length > MAX_PENDING) pending.shift();
      if (!current) next();
    },
    clear() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      current = null;
      pending.length = 0;
    },
  };
}

module.exports = { createToastQueue, MAX_PENDING };
