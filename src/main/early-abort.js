'use strict';

// A hold that Claude Code closed long before Huddle's own hold would have
// ended means the hook timeout is shorter than the hold. Pure helpers: main
// decides when to ask and shows the notice.

// A close this much earlier than the hold's end counts as early.
const EARLY_MS = 2000;

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

module.exports = { earlyAbort, abortNoticeText, EARLY_MS };
