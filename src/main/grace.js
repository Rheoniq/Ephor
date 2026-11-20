'use strict';

// Keeps the last good copy of each session so a registry file caught
// half-written (and so skipped for one read) does not drop the session.
// A session missing from the registry is kept for up to `maxMisses`
// consecutive refreshes, then dropped.
function createGrace(maxMisses = 2) {
  const entries = new Map(); // sessionId -> { session, misses }

  function apply(current) {
    const seen = new Set();
    for (const session of current) {
      seen.add(session.sessionId);
      entries.set(session.sessionId, { session, misses: 0 });
    }
    const kept = [...current];
    for (const [id, entry] of entries) {
      if (seen.has(id)) continue;
      entry.misses += 1;
      if (entry.misses > maxMisses) entries.delete(id);
      else kept.push(entry.session);
    }
    return kept;
  }

  return { apply };
}

module.exports = { createGrace };
