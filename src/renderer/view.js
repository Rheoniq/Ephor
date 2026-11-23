'use strict';

// Which view the panel shows: the list of sessions, or one session with a
// back arrow. It holds no DOM and no timers: the renderer owns the short
// delay before an open session whose prompts were all answered or released
// goes back to the list. Plain script: in the page it sets window.HuddleView,
// under Node it is a CommonJS module.

(function (root) {
  const LIST = 'list';
  const SESSION = 'session';
  const STATUSES = ['busy', 'waiting', 'idle'];

  function idOf(s) {
    return s !== null && typeof s === 'object' && typeof s.sessionId === 'string' && s.sessionId !== ''
      ? s.sessionId
      : null;
  }

  function hasPrompt(s) {
    return !!(s && s.prompt);
  }

  // What a session card shows: 'needs-you' (a pending prompt or status
  // waiting), 'finished' (idle and just finished), else its status ('busy'
  // or 'idle'; anything unknown reads as idle).
  function cardKind(session, needsYou) {
    const status = session && STATUSES.includes(session.status) ? session.status : 'idle';
    if (needsYou === true || status === 'waiting') return 'needs-you';
    if (status === 'idle' && !!session && session.finished === true) return 'finished';
    return status;
  }

  function createViewState() {
    let openId = null; // the session shown, or null for the list
    let hadPrompt = false; // the open session showed a prompt since it was opened
    let known = new Map(); // sessionId -> { prompt, waiting } from the last sync
    let order = []; // session ids in snapshot order

    function current() {
      return openId === null ? { kind: LIST } : { kind: SESSION, sessionId: openId };
    }

    // Opens a session from the last sync; anything else is ignored.
    function open(sessionId) {
      if (typeof sessionId !== 'string' || !known.has(sessionId)) return;
      openId = sessionId;
      hadPrompt = known.get(sessionId).prompt;
    }

    function back() {
      openId = null;
      hadPrompt = false;
    }

    // Takes the snapshot's sessions. An open session that left (ended,
    // dismissed, hidden) sends the view back to the list. A prompt on any
    // session never opens it or changes the open view.
    function sync(sessions) {
      known = new Map();
      order = [];
      for (const s of Array.isArray(sessions) ? sessions : []) {
        const id = idOf(s);
        if (id === null || known.has(id)) continue;
        known.set(id, { prompt: hasPrompt(s), waiting: s.status === 'waiting' });
        order.push(id);
      }
      if (openId !== null && !known.has(openId)) back();
    }

    // Reports how many prompts the session has pending now. Returns true
    // (once) when it is the open session, it had a prompt, and now has none:
    // the renderer then goes back to the list after a short delay, unless a
    // new prompt for it arrives first. Any other session: false, no change.
    function onPromptsSettled(sessionId, pendingCount) {
      if (openId === null || sessionId !== openId) return false;
      if (!Number.isInteger(pendingCount) || pendingCount < 0) return false;
      if (pendingCount > 0) {
        hadPrompt = true;
        return false;
      }
      if (!hadPrompt) return false;
      hadPrompt = false;
      return true;
    }

    // The sessions that need the user: a pending prompt or status waiting,
    // in snapshot order.
    function needsYou() {
      return order.filter((id) => {
        const k = known.get(id);
        return k.prompt || k.waiting;
      });
    }

    return { current, open, back, sync, onPromptsSettled, needsYou };
  }

  const api = { createViewState, cardKind };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleView = api;
})(typeof window !== 'undefined' ? window : globalThis);
