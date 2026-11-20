'use strict';

// Keeps the last good copy of each session so a registry file caught
// half-written (and so skipped for one read) does not drop the session.
// A session missing from the registry is kept for up to `maxMisses`
// consecutive refreshes, then dropped.
// The result is sorted by first-seen order, so a session that enters and
// leaves its grace period keeps its place in the list.
function createGrace(maxMisses = 2) {
  const entries = new Map(); // sessionId -> { session, misses, order }
  let nextOrder = 0;

  function apply(current) {
    const seen = new Set();
    for (const session of current) {
      seen.add(session.sessionId);
      const prev = entries.get(session.sessionId);
      const order = prev ? prev.order : nextOrder++;
      entries.set(session.sessionId, { session, misses: 0, order });
    }
    const kept = [];
    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        entry.misses += 1;
        if (entry.misses > maxMisses) {
          entries.delete(id);
          continue;
        }
      }
      kept.push(entry);
    }
    kept.sort((a, b) => a.order - b.order);
    return kept.map((entry) => entry.session);
  }

  return { apply };
}

module.exports = { createGrace };
