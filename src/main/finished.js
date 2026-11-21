'use strict';

// Tracks sessions that just finished and were not looked at yet. A session
// becomes finished when its status goes from 'busy' or 'waiting' to 'idle'
// between two update calls. It stays finished until markSeen, until it is
// 'busy' or 'waiting' again, or until it leaves the registry. The first update
// has no history and marks nothing, so a session already idle at start never
// becomes finished.

const ACTIVE = new Set(['busy', 'waiting']);

function createFinished() {
  let previous = new Map(); // sessionId -> status from the last update
  const finished = new Set();

  function update(sessions) {
    const next = new Map();
    for (const s of sessions) {
      next.set(s.sessionId, s.status);
      if (ACTIVE.has(s.status)) {
        finished.delete(s.sessionId);
      } else if (s.status === 'idle' && ACTIVE.has(previous.get(s.sessionId))) {
        finished.add(s.sessionId);
      }
    }
    for (const id of finished) if (!next.has(id)) finished.delete(id);
    previous = next;
  }

  function isFinished(sessionId) {
    return finished.has(sessionId);
  }

  function markSeen(sessionId) {
    finished.delete(sessionId);
  }

  return { update, isFinished, markSeen };
}

module.exports = { createFinished };
