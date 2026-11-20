'use strict';

// Small pure helpers for the panel window.

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 800;

// Validates a content height reported by the renderer. Returns an integer
// in MIN_HEIGHT..MAX_HEIGHT, or null when the value is not a finite number.
function clampHeight(h) {
  if (typeof h !== 'number' || !Number.isFinite(h)) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));
}

// Remembers the last snapshot sent; shouldSend() is true only when the
// snapshot differs from it (compared as JSON).
function createSnapshotGate() {
  let last = null;
  function shouldSend(snapshot) {
    const json = JSON.stringify(snapshot);
    if (json === last) return false;
    last = json;
    return true;
  }
  function mark(snapshot) {
    last = JSON.stringify(snapshot);
  }
  return { shouldSend, mark };
}

// The renderer gets only what it shows or sends back. Internal fields such as
// cwd, pid and updatedAt stay in the main process, and leaving them out also
// keeps them out of the snapshot gate's comparison.
function toSnapshotSession(s, steps) {
  return {
    sessionId: s.sessionId,
    hostSessionId: s.hostSessionId,
    name: s.name,
    status: s.status,
    steps,
  };
}

module.exports = { clampHeight, createSnapshotGate, toSnapshotSession, MIN_HEIGHT, MAX_HEIGHT };
