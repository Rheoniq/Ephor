'use strict';

// Panel visibility state: hidden (hotkey, tray or Hide button, not
// persisted), collapsed (pill only) and quiet (no holding of the window for
// prompts). Collapsed has two sources: the user (persisted by the caller)
// and a prompt that opened the pill (expandForPrompt, never persisted),
// which closes again when the holds end (holdsEnded).

function createVisibility(initial) {
  let hidden = false;
  let collapsed = !!(initial && initial.collapsed);
  let quiet = !!(initial && initial.quiet);
  let autoExpanded = false; // the pill was opened by a prompt, not the user

  // Returns true when the state changed. Hiding needs the window on screen:
  // when no session is shown the window is already off screen, and a hide
  // then would only keep the panel away when a session appears.
  function setHidden(b, onScreen) {
    const next = !!b;
    if (next === hidden) return false;
    if (next && onScreen !== true) return false;
    hidden = next;
    return true;
  }

  return {
    setHidden,
    toggleHidden(onScreen) {
      return setHidden(!hidden, onScreen);
    },
    // The user's own collapse or expand; it ends an automatic expand.
    setCollapsed(b) {
      autoExpanded = false;
      collapsed = !!b;
    },
    // A prompt opens a collapsed pill so its card can be seen. Returns true
    // when it opened it.
    expandForPrompt() {
      if (!collapsed) return false;
      collapsed = false;
      autoExpanded = true;
      return true;
    },
    // No prompt is held any more: a pill opened by a prompt closes again.
    // Returns true when it closed it.
    holdsEnded() {
      if (!autoExpanded) return false;
      autoExpanded = false;
      collapsed = true;
      return true;
    },
    setQuiet(b) {
      quiet = !!b;
    },
    isHidden: () => hidden,
    isCollapsed: () => collapsed,
    isAutoExpanded: () => autoExpanded,
    isQuiet: () => quiet,
    shouldShowWindow: (sessionCount) => !hidden && sessionCount > 0,
    // Collapsed does not block holding: the caller opens the pill on a
    // prompt (expandForPrompt).
    canHold: () => !hidden && !quiet,
  };
}

module.exports = { createVisibility };
