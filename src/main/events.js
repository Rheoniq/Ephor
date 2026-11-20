'use strict';

// Attention events from status changes between two registry reads:
// 'waiting' when a session becomes waiting, 'finished' when it goes busy to
// idle. A session without a previous status (first call, new or returning
// after it vanished) emits nothing.

function createEventDetector() {
  let previous = new Map(); // sessionId -> status

  return {
    detect(sessions) {
      const events = [];
      const next = new Map();
      for (const s of sessions) {
        next.set(s.sessionId, s.status);
        if (!previous.has(s.sessionId)) continue;
        const before = previous.get(s.sessionId);
        if (s.status === 'waiting' && before !== 'waiting') {
          events.push({ sessionId: s.sessionId, name: s.name, kind: 'waiting' });
        } else if (s.status === 'idle' && before === 'busy') {
          events.push({ sessionId: s.sessionId, name: s.name, kind: 'finished' });
        }
      }
      previous = next; // sessions not in this read are forgotten
      return events;
    },
  };
}

module.exports = { createEventDetector };
