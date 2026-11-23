'use strict';

// Which view the panel shows: the list of sessions, or one session with a
// back arrow. It holds no DOM and no timers: the renderer owns the short
// delay before an open session whose prompts were all answered or released
// goes back to the list, and createReturnState says when that delay runs.
// Plain script: in the page it sets window.EphorView, under Node it is a
// CommonJS module.

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

  // Input types that do not take text: Escape there still goes back.
  const NON_TEXT_INPUTS = ['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color'];

  function textLike(target) {
    if (target === null || typeof target !== 'object') return false;
    if (target.isContentEditable === true) return true;
    const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = typeof target.type === 'string' ? target.type.toLowerCase() : '';
    return !NON_TEXT_INPUTS.includes(type);
  }

  // Whether a keydown returns the session view to the list: a plain Escape
  // (no modifier, not while composing) in the session view, while no
  // text-like control has focus and no pointer is pressed. `ev` carries the
  // key, the modifier flags, isComposing, target (the focused element), view
  // ('list' or 'session') and pointerDown.
  function escapeGoesBack(ev) {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return false;
    if (ev.key !== 'Escape' || ev.view !== SESSION || ev.pointerDown === true) return false;
    if (ev.ctrlKey === true || ev.altKey === true || ev.metaKey === true || ev.shiftKey === true) return false;
    if (ev.isComposing === true) return false;
    return !textLike(ev.target);
  }

  // The back button's needs-you cue in the session view: how many OTHER
  // sessions need the user (`needIds` from needsYou(), minus `openId`), the
  // number shown in the clay badge ('' for none) and the button's spoken
  // label. The view never switches to those sessions by itself; this cue is
  // the notification instead.
  function backCue(needIds, openId) {
    const others = new Set();
    if (Array.isArray(needIds)) {
      for (const id of needIds) if (typeof id === 'string' && id !== '' && id !== openId) others.add(id);
    }
    const count = others.size;
    if (count === 0) return { count: 0, badge: '', label: 'All sessions' };
    return { count, badge: String(count), label: `All sessions (${count} ${count === 1 ? 'needs' : 'need'} you)` };
  }

  // What the delayed return does with the open session as the snapshot shows
  // it (null or undefined when it left): 'cancel' when it has a prompt again,
  // 'wait' while it still waits for an answer without a card (the handover
  // notice stays, with its Open button), else 'go'.
  function returnStep(session) {
    if (session === null || typeof session !== 'object') return 'go';
    if (hasPrompt(session)) return 'cancel';
    return session.status === 'waiting' ? 'wait' : 'go';
  }

  // The return owed after the open session's last prompt went (answered,
  // released, timed out or closed). It is owed from the snapshot where
  // onPromptsSettled said so until the view goes back, a new prompt comes,
  // or another session is open. The delay runs only while the session does
  // not wait: a wait stops it and keeps the return owed, so the view goes
  // back only once the session moved on (or left).
  function createReturnState() {
    let owed = null; // the session id the return is owed for

    // A snapshot while session `openId` is open (null: the list is shown).
    // `settled` is what onPromptsSettled said for it; `session` its snapshot
    // entry, or null. Returns 'start' (start the delay unless it runs),
    // 'stop' (stop a running delay) or 'none'.
    function onSnapshot(openId, settled, session) {
      if (typeof openId !== 'string' || openId === '') {
        owed = null;
        return 'stop';
      }
      let dropped = false;
      if (owed !== null && owed !== openId) {
        owed = null;
        dropped = true;
      }
      if (settled === true) owed = openId;
      if (owed === null) return dropped ? 'stop' : 'none';
      const step = returnStep(session);
      if (step === 'cancel') {
        owed = null;
        return 'stop';
      }
      return step === 'wait' ? 'stop' : 'start';
    }

    // The delay ran out while `openId` is open, with `session` as the last
    // snapshot shows it. 'back' when the view should go back to the list,
    // else 'none'; a session that still waits keeps the return owed.
    function onDue(openId, session) {
      if (owed === null || owed !== openId) {
        owed = null;
        return 'none';
      }
      const step = returnStep(session);
      if (step === 'wait') return 'none';
      owed = null;
      return step === 'go' ? 'back' : 'none';
    }

    function clear() {
      owed = null;
    }

    return { onSnapshot, onDue, clear, owedFor: () => owed };
  }

  const api = { createViewState, cardKind, escapeGoesBack, backCue, returnStep, createReturnState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EphorView = api;
})(typeof window !== 'undefined' ? window : globalThis);
