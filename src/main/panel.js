'use strict';

// Small pure helpers for the panel window.

const { normalizeItems, summarize } = require('./plan');

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
// keeps them out of the snapshot gate's comparison. `prompt` is set only
// while a hook prompt for the session is held. `finished` is true only for a
// session that just finished and was not looked at yet (finished.js).
// `plan` (from snapshotPlan) and `lastCommand` are always present, null when
// unknown, so the snapshot keeps one shape.
function toSnapshotSession(s, prompt, finished, plan, lastCommand) {
  const out = {
    sessionId: s.sessionId,
    hostSessionId: s.hostSessionId,
    name: s.name,
    status: s.status,
    finished: finished === true,
    plan: plan || null,
    lastCommand: typeof lastCommand === 'string' && lastCommand ? lastCommand : null,
  };
  if (prompt) out.prompt = prompt;
  return out;
}

// The plan as the renderer gets it: the normalised items (fresh copies) plus
// the summary from plan.js, or null when there is no item.
function snapshotPlan(items) {
  const norm = normalizeItems(items);
  const sum = summarize(norm);
  if (!sum) return null;
  return {
    items: norm,
    total: sum.total,
    current: sum.current,
    phase: sum.phase,
    done: sum.done,
    state: sum.state,
  };
}

// Per-session plan and last command for the snapshot, through one shared
// plan reader. `fileFor(session)` gives the transcript path. A read that
// throws keeps the session's last good value (and reports through `onError`);
// it never throws to the caller. prune(keptIds) drops sessions that left the
// kept list and asks the reader to forget their files, when it can.
function createPlanSource(reader, fileFor, onError) {
  const last = new Map(); // sessionId -> { file, value }

  function read(s) {
    const prev = last.get(s.sessionId);
    try {
      const file = fileFor(s);
      const r = reader.read(file);
      const value = {
        plan: snapshotPlan(r && r.items),
        lastCommand: r && typeof r.lastCommand === 'string' && r.lastCommand ? r.lastCommand : null,
      };
      last.set(s.sessionId, { file, value });
      return value;
    } catch (err) {
      if (typeof onError === 'function') {
        try {
          onError(s.sessionId, err);
        } catch {
          /* ignore */
        }
      }
      return prev ? prev.value : { plan: null, lastCommand: null };
    }
  }

  function prune(keptIds) {
    const keep = new Set(keptIds);
    for (const [id, entry] of last) {
      if (keep.has(id)) continue;
      last.delete(id);
      if (typeof reader.forget === 'function') {
        try {
          reader.forget(entry.file);
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { read, prune };
}

// Whether the panel shows a session. A dismissed session is never shown.
// Otherwise it is shown when busy or waiting, when it just finished and was
// not looked at yet, or while a hook prompt for it is pending (a hook proves
// the session is active even if the registry still says idle). A plain idle
// session is not shown.
function isShown({ status, finished, hasPrompt, dismissalsVisible }) {
  if (dismissalsVisible !== true) return false;
  return status === 'busy' || status === 'waiting' || finished === true || hasPrompt === true;
}

module.exports = {
  clampHeight,
  createSnapshotGate,
  toSnapshotSession,
  snapshotPlan,
  createPlanSource,
  isShown,
  MIN_HEIGHT,
  MAX_HEIGHT,
};
