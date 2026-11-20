'use strict';

// Holds incoming snapshots while a pointer is down on the list, so a re-render
// cannot replace the button under a press and swallow the click. Plain script:
// in the page it sets window.HuddleHold, under Node it is a CommonJS module.

(function (root) {
  function createSnapshotHold(apply) {
    let held = false;
    let pending = null; // latest snapshot that arrived while held

    function push(snapshot) {
      if (held) pending = snapshot;
      else apply(snapshot);
    }

    function down() {
      held = true;
    }

    function up() {
      held = false;
    }

    // Applies the held snapshot, if any, unless a new press has started.
    function flush() {
      if (held || pending === null) return;
      const snapshot = pending;
      pending = null;
      apply(snapshot);
    }

    return { push, down, up, flush, isHeld: () => held };
  }

  const api = { createSnapshotHold };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleHold = api;
})(typeof window !== 'undefined' ? window : globalThis);
