'use strict';

// The hook timeout notice. When Claude Code closes a held question's
// connection long before Huddle's own hold would end, its hook timeout is
// shorter than the hold: the card goes while the question stays open in the
// app. Main says so once per run.
//
// Only the hook server's client-close path counts. Every hold main ends on
// its own leaves main's table BEFORE the server is told: an answer and a
// release (answering.js) and cancelHold through endHold below (Ctrl+Alt+H or
// Hide, a collapse by hand, quiet mode, a dismissal, the app answered first,
// terminal answering turned off, a crashed or hung panel page). The server
// calls onCancel at once inside that call, so onCancel then finds nothing.
// An entry still in the table when onCancel runs ended in the server: its
// own hold timer at holdMs (never early, see earlyAbort) or Claude Code
// closing the connection. Quitting ends every hold with no notice.
//
// A close alone is not enough. It is a candidate, decided at the refreshes
// that follow: the notice is pushed at the first one within DECIDE_MS that
// finds the session waiting without a held card (the question is open in
// the app). A session that leaves, is dismissed, is held again, or was
// waiting at the close and no longer is, drops the candidate; so does the
// end of the window. The once-per-run flag is spent only when main pushed
// the toast, so quiet mode or a dismissal does not use it up.

// A close this much earlier than the hold's end counts as early.
const EARLY_MS = 2000;
// How long after the close the refreshes may decide.
const DECIDE_MS = 3000;

// The whole seconds the hold lasted when it ended early because the client
// closed the connection (reason 'closed'), or null. Answered, released,
// timed-out and cancelled holds, and anything malformed, are never early.
function earlyAbort(info) {
  if (info === null || typeof info !== 'object') return null;
  const { elapsedMs, holdMs, reason } = info;
  if (reason !== 'closed') return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (typeof holdMs !== 'number' || !Number.isFinite(holdMs) || holdMs <= 0) return null;
  if (holdMs - elapsedMs < EARLY_MS) return null;
  return Math.floor(elapsedMs / 1000);
}

function abortNoticeText(seconds) {
  return `Claude Code closed a question after ${seconds} s. Raise the hook timeout above the hold.`;
}

// Main's own end of a hold: the entry leaves `prompts` first, then
// cancelSession(sessionId) tells the server (which answers 204 and calls
// onCancel at once). Returns whether the entry was still in the table.
function endHold(prompts, entry, cancelSession) {
  if (!(prompts instanceof Map) || entry === null || typeof entry !== 'object') return false;
  const removed = prompts.delete(entry.id);
  if (typeof cancelSession === 'function') cancelSession(entry.sessionId);
  return removed;
}

function defaultNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// options.now: a monotonic clock in ms, the same one as the entries' heldAt
// (main: performance.now).
function createAbortWatch(options) {
  const now = options && typeof options.now === 'function' ? options.now : defaultNow;
  let shown = false;
  // { sessionId, seconds, at, waiting }: `waiting` is the session's status
  // at the close, so "no longer waiting" can be told from "not yet waiting".
  let candidate = null;

  // onCancel: the server ended hold `id`. An entry still in `prompts` is
  // removed and returned (main then refreshes); null when main had already
  // taken it out. ctx: { quitting, holdMs, status } with `status` the
  // session's last registry status.
  function serverEnded(prompts, id, ctx) {
    if (!(prompts instanceof Map)) return null;
    const entry = prompts.get(id);
    if (!entry) return null;
    prompts.delete(id);
    if (shown || ctx === null || typeof ctx !== 'object' || ctx.quitting === true) return entry;
    const at = now();
    const seconds = earlyAbort({ elapsedMs: at - entry.heldAt, holdMs: ctx.holdMs, reason: 'closed' });
    if (seconds !== null) {
      candidate = { sessionId: entry.sessionId, seconds, at, waiting: ctx.status === 'waiting' };
    }
    return entry;
  }

  // On every refresh. lookup(sessionId) gives { status, held, dismissed }
  // for a kept session, or null when it left; push(text) queues the notice
  // toast and returns true, or false when it may not (quiet mode). Returns
  // true when the notice was pushed now.
  function refreshed(lookup, push) {
    const c = candidate;
    if (!c) return false;
    if (shown || now() - c.at > DECIDE_MS) {
      candidate = null;
      return false;
    }
    let s = null;
    try {
      s = lookup(c.sessionId);
    } catch {
      s = null;
    }
    if (s === null || typeof s !== 'object' || s.dismissed === true || s.held === true) {
      candidate = null;
      return false;
    }
    if (s.status !== 'waiting') {
      // No longer waiting (answered in the app): dropped. Not waiting yet
      // (the registry lags behind): a later refresh in the window decides.
      if (c.waiting) candidate = null;
      return false;
    }
    candidate = null;
    let pushed = false;
    try {
      pushed = push(abortNoticeText(c.seconds)) === true;
    } catch {
      pushed = false;
    }
    if (pushed) shown = true;
    return pushed;
  }

  return {
    serverEnded,
    refreshed,
    hasCandidate: () => candidate !== null,
    wasShown: () => shown,
  };
}

module.exports = { earlyAbort, abortNoticeText, endHold, createAbortWatch, EARLY_MS, DECIDE_MS };
