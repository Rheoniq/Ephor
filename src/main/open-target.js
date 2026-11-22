'use strict';

// Pure helpers for the arrow on a session row: which shown session an open
// request from the renderer means, and the lazy host-name lookups for the
// badge of terminal sessions.

const { findOpenable } = require('./panel');

// Longest id the open IPC accepts (session ids are UUIDs, hostSessionIds
// are a short prefix plus an id).
const MAX_OPEN_ID_LEN = 100;
// An unresolvable host is asked again only after this long.
const RETRY_NULL_MS = 60000;

function validId(id) {
  return typeof id === 'string' && id !== '' && id.length <= MAX_OPEN_ID_LEN;
}

// The renderer sends { kind: 'desktop', hostSessionId } or
// { kind: 'terminal', sessionId }; a plain string is the older desktop form.
// Returns { kind, session } for a session in `shown` (the last snapshot's
// sessions) whose source matches the kind, else null. Never throws.
function parseOpenRequest(payload, shown) {
  const list = Array.isArray(shown) ? shown : [];
  if (typeof payload === 'string') payload = { kind: 'desktop', hostSessionId: payload };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.kind === 'desktop') {
    if (!validId(payload.hostSessionId)) return null;
    const session = findOpenable(list, payload.hostSessionId);
    return session ? { kind: 'desktop', session } : null;
  }
  if (payload.kind === 'terminal') {
    if (!validId(payload.sessionId)) return null;
    const session = list.find((s) => s && s.source === 'terminal' && s.sessionId === payload.sessionId);
    return session ? { kind: 'terminal', session } : null;
  }
  return null;
}

// Whether an open result counts as looking at the session (a finished buddy
// is then marked seen). 'not-found' and 'failed' do not.
function openSucceeded(result) {
  return typeof result === 'string' && result !== 'failed' && result !== 'not-found';
}

// The host name of each shown terminal session, looked up lazily and off the
// refresh path. hostFor(session) answers at once from what is known (a name,
// or null) and, when nothing is known or a null result is older than
// RETRY_NULL_MS, starts one resolve(pid, procStart, { revalidate: false }).
// procStart goes through unchanged (FILETIME strings exceed safe integers).
// A landed name calls onResolved() so main refreshes; the snapshot gate drops
// a refresh that changes nothing. Entries are per session id and are started
// over when the session's pid or procStart changes. Never throws.
function createHostLookups({ resolve, now = Date.now, onResolved, retryMs = RETRY_NULL_MS } = {}) {
  const entries = new Map(); // sessionId -> { ident, state, name, until }

  function start(session, ident) {
    const entry = { ident, state: 'pending', name: null, until: 0 };
    entries.set(session.sessionId, entry);
    let p;
    try {
      p = Promise.resolve(resolve(session.pid, session.procStart, { revalidate: false }));
    } catch {
      p = Promise.resolve(null);
    }
    p.catch(() => null).then((res) => {
      // Dropped when the session left or was started over meanwhile.
      if (entries.get(session.sessionId) !== entry) return;
      const name = res && typeof res.name === 'string' && res.name !== '' ? res.name : null;
      if (name) {
        entry.state = 'done';
        entry.name = name;
        if (typeof onResolved === 'function') {
          try {
            onResolved(session.sessionId);
          } catch {
            /* ignore */
          }
        }
      } else {
        entry.state = 'none';
        entry.until = now() + retryMs;
      }
    });
  }

  function hostFor(session) {
    try {
      if (!session || typeof session !== 'object' || session.source !== 'terminal') return null;
      if (typeof session.sessionId !== 'string' || session.sessionId === '') return null;
      const ident = `${session.pid}|${session.procStart}`;
      const entry = entries.get(session.sessionId);
      if (!entry || entry.ident !== ident || (entry.state === 'none' && now() >= entry.until)) {
        start(session, ident);
        return null;
      }
      return entry.state === 'done' ? entry.name : null;
    } catch {
      return null;
    }
  }

  // Forgets sessions that are not in keptIds.
  function prune(keptIds) {
    const keep = new Set(keptIds);
    for (const id of [...entries.keys()]) if (!keep.has(id)) entries.delete(id);
  }

  return { hostFor, prune };
}

module.exports = { parseOpenRequest, openSucceeded, createHostLookups, MAX_OPEN_ID_LEN, RETRY_NULL_MS };
