'use strict';

// Toast queue: shows one toast at a time for durationMs (or until skip()),
// then the next.
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
    // Ends the showing toast's slot now (closed on its cross): the next one
    // shows at once with its full time. Does nothing when none shows.
    skip() {
      if (!current) return;
      if (timer !== null) clearTimer(timer);
      next();
    },
    // Keeps only the toasts `keep` accepts, in order. A showing toast it
    // rejects ends its slot now and the next kept one shows. Returns true
    // when the showing toast was dropped.
    retain(keep) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (!keep(pending[i])) pending.splice(i, 1);
      }
      if (!current || keep(current)) return false;
      if (timer !== null) clearTimer(timer);
      next();
      return true;
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
