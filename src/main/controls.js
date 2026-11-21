'use strict';

const { parseDragDelta } = require('../renderer/drag');

// Panel controls: the Hide and Quit buttons, the toast's close cross and the
// collapsed pill's drag messages. Each IPC message counts only from its own
// window; anything else, and any value that is not the expected type, is
// ignored. An action that throws (for example on a window destroyed
// meanwhile) is logged, not thrown.

function createControls({
  isPanelSender,
  isToastSender,
  hide,
  quit,
  closeToast,
  setToastClickable,
  dragStart = () => {},
  dragTo = () => {},
  dragEnd = () => {},
  log = (msg) => console.error(msg),
}) {
  function safe(what, fn) {
    try {
      fn();
    } catch (err) {
      log(`[huddle] ${what} failed: ${err && err.message ? err.message : err}`);
    }
  }

  const fromPanel = (event) => !!event && isPanelSender(event);
  const fromToast = (event) => !!event && isToastSender(event);

  return {
    onHide(event) {
      if (fromPanel(event)) safe('hide', hide);
    },
    onQuit(event) {
      if (fromPanel(event)) safe('quit', quit);
    },
    onToastClose(event) {
      if (fromToast(event)) safe('closing the toast', closeToast);
    },
    onToastClickable(event, clickable) {
      if (!fromToast(event) || typeof clickable !== 'boolean') return;
      safe('toast click state', () => setToastClickable(clickable));
    },
    onDragStart(event) {
      if (fromPanel(event)) safe('drag start', dragStart);
    },
    onDragTo(event, payload) {
      if (!fromPanel(event)) return;
      const delta = parseDragDelta(payload);
      if (delta) safe('drag', () => dragTo(delta));
    },
    onDragEnd(event) {
      if (fromPanel(event)) safe('drag end', dragEnd);
    },
  };
}

// The Hide button's tooltip: how to get the panel back.
function hideTitle(hotkey) {
  const back = typeof hotkey === 'string' && hotkey ? hotkey : 'the tray icon';
  return `Hide panel (${back} shows it again)`;
}

module.exports = { createControls, hideTitle };
