'use strict';

// Tracks user dismissals. A dismissed session reappears when its status
// becomes 'busy' or 'waiting' and differs from the status at dismiss time.
function createDismissals() {
  const dismissed = new Map(); // sessionId -> status at dismiss

  function dismiss(sessionId, status) {
    dismissed.set(sessionId, status);
  }

  function visible(sessionId, status) {
    if (!dismissed.has(sessionId)) return true;
    const atDismiss = dismissed.get(sessionId);
    if ((status === 'busy' || status === 'waiting') && status !== atDismiss) {
      dismissed.delete(sessionId);
      return true;
    }
    return false;
  }

  function prune(liveIds) {
    const live = new Set(liveIds);
    for (const id of dismissed.keys()) if (!live.has(id)) dismissed.delete(id);
  }

  return { dismiss, visible, prune };
}

module.exports = { createDismissals };
