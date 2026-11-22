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

// Guards the arrow against click spam. open(key, ...args) runs
// run(key, ...args) once per key at a time: a caller for a key that is still
// running gets the same promise. At most maxConcurrent different keys run at
// once; a caller for another key over the cap gets 'failed' at once (no
// queue, so a looping renderer cannot pile up PowerShell runs). A run that
// throws or rejects gives 'failed'; the key and the cap slot are released
// when the run settles, whatever the outcome.
function createOpenGate(run, { maxConcurrent = 2 } = {}) {
  const inflight = new Map(); // key -> promise

  function open(key, ...args) {
    const pending = inflight.get(key);
    if (pending) return pending;
    if (inflight.size >= maxConcurrent) return Promise.resolve('failed');
    // run starts now (not on a later tick), so the cap counts it at once.
    let started;
    try {
      started = Promise.resolve(run(key, ...args));
    } catch (err) {
      started = Promise.reject(err);
    }
    const p = started
      .catch(() => 'failed')
      .finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  }

  return { open };
}

// Brings the window that hosts a terminal session to the front. Only the
// session id comes from the renderer: pid, cwd and procStart are read from
// `kept` (main's own registry copy). The host is resolved again on the click
// (revalidate), so a stale badge never decides. Gives 'focused', 'not-found'
// (no host or no window) or 'failed'. Deps: { kept, resolve, focusWindowOf,
// folderNameOf }.
async function openTerminal(sessionId, { kept, resolve, focusWindowOf, folderNameOf } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return 'failed';
  if (!Array.isArray(kept) || typeof resolve !== 'function') return 'failed';
  const reg = kept.find((s) => s && s.sessionId === sessionId && s.source === 'terminal');
  if (!reg) return 'failed';
  const host = await resolve(reg.pid, reg.procStart, { revalidate: true });
  if (!host) return 'not-found';
  return focusWindowOf({ ownerPid: host.ownerPid, folderName: folderNameOf(reg.cwd) });
}

module.exports = {
  parseOpenRequest,
  openSucceeded,
  createHostLookups,
  createOpenGate,
  openTerminal,
  MAX_OPEN_ID_LEN,
  RETRY_NULL_MS,
};
