'use strict';

// Panel visibility state: hidden (hotkey or tray toggle, not persisted),
// collapsed (pill only) and quiet (no holding of the window for prompts).

function createVisibility(initial) {
  let hidden = false;
  let collapsed = !!(initial && initial.collapsed);
  let quiet = !!(initial && initial.quiet);

  return {
    toggleHidden() {
      hidden = !hidden;
    },
    setCollapsed(b) {
      collapsed = !!b;
    },
    setQuiet(b) {
      quiet = !!b;
    },
    isHidden: () => hidden,
    isCollapsed: () => collapsed,
    isQuiet: () => quiet,
    shouldShowWindow: (sessionCount) => !hidden && sessionCount > 0,
    // Collapsed does not block holding: the caller auto-expands the panel
    // on a prompt (wired in Task 7).
    canHold: () => !hidden && !quiet,
  };
}

module.exports = { createVisibility };
