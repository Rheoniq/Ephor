'use strict';

// Pure helpers for the arrow on a session row: which shown session an open
// request from the renderer means, and the lazy host-name lookups for the
// badge of terminal sessions.

const { findOpenable } = require('./panel');

// Longest id the open IPC accepts (session ids are UUIDs, hostSessionIds
// are a short prefix plus an id).
const MAX_OPEN_ID_LEN = 100;
// An unresolvable host is asked again after 60 s, then after 5 minutes, and
// then not again until the session's pid or procStart changes.
const RETRY_DELAYS_MS = Object.freeze([60000, 5 * 60000]);
const RETRY_NULL_MS = RETRY_DELAYS_MS[0];

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

// The open target of a shown session by its session id, as the arrow of
// its row would send it: { kind, session } or null. Used by the release IPC,
// which knows the prompt's session id, not the renderer's open request.
function openTargetFor(sessionId, shown) {
  if (!validId(sessionId) || !Array.isArray(shown)) return null;
  const s = shown.find((x) => x && x.sessionId === sessionId);
  if (!s) return null;
  return s.source === 'terminal'
    ? parseOpenRequest({ kind: 'terminal', sessionId }, shown)
    : parseOpenRequest({ kind: 'desktop', hostSessionId: s.hostSessionId }, shown);
}

// Whether an open result counts as looking at the session (a finished buddy
// is then marked seen). 'not-found' and 'failed' do not.
function openSucceeded(result) {
  return typeof result === 'string' && result !== 'failed' && result !== 'not-found';
}

// The host name of each shown terminal session, looked up lazily and off the
// refresh path. hostFor(session) answers at once from what is known (a name,
// or null) and, when nothing is known or a retry is due, starts one lookup
// with { revalidate: false }. procStart goes through unchanged (FILETIME
// strings exceed safe integers).
// Deps: lookup(pid, procStart, options) -> { host: { name } | null, stale }
// (host.js createHostResolver().lookup), or the older resolve(pid, procStart,
// options) -> { name } | null, which never reports stale.
// A landed name calls onResolved() so main refreshes; the snapshot gate drops
// a refresh that changes nothing. A lookup with no host is retried after
// retryDelays[0] (60 s), then retryDelays[1] (5 min), then not again. A stale
// verdict (the registry entry no longer describes a live session, see
// host.js) marks the session stale for isStale(), calls onResolved() so main
// drops it on the next refresh, and stops the lookups; log(line) gets one
// line per verdict: the session id's first 8 characters, the pid and the
// reason ('pid-missing' or 'start-mismatch'), never a name or a path.
// Entries are per session id and pid plus procStart: a new pid or procStart
// starts over with a fresh backoff and no stale mark. Starting one drops the
// other entries of that session id, except stale marks, so a stale registry
// file keeps its mark while a live sibling with the same session id is
// looked up. Never throws.
const STALE_REASONS = new Set(['pid-missing', 'start-mismatch']);

function createHostLookups({
  resolve,
  lookup,
  now = Date.now,
  onResolved,
  log,
  retryDelays = RETRY_DELAYS_MS,
} = {}) {
  // sessionId -> Map(ident -> { ident, state, name, until, misses })
  const entries = new Map();

  function entryOf(sessionId, ident) {
    const byIdent = entries.get(sessionId);
    return byIdent ? byIdent.get(ident) : undefined;
  }

  function logStale(session, reason) {
    if (typeof log !== 'function') return;
    try {
      const why = STALE_REASONS.has(reason) ? reason : 'unspecified';
      log(`stale session ${session.sessionId.slice(0, 8)} pid ${session.pid}: ${why}`);
    } catch {
      /* ignore */
    }
  }

  function ask(session) {
    if (typeof lookup === 'function') return lookup(session.pid, session.procStart, { revalidate: false });
    return Promise.resolve(resolve(session.pid, session.procStart, { revalidate: false })).then((host) => ({
      host,
      stale: false,
    }));
  }

  function notify(sessionId) {
    if (typeof onResolved !== 'function') return;
    try {
      onResolved(sessionId);
    } catch {
      /* ignore */
    }
  }

  function start(session, ident, misses) {
    const entry = { ident, state: 'pending', name: null, until: 0, misses };
    let byIdent = entries.get(session.sessionId);
    if (!byIdent) {
      byIdent = new Map();
      entries.set(session.sessionId, byIdent);
    }
    for (const [other, e] of [...byIdent]) if (other !== ident && e.state !== 'stale') byIdent.delete(other);
    byIdent.set(ident, entry);
    let p;
    try {
      p = Promise.resolve(ask(session));
    } catch {
      p = Promise.resolve(null);
    }
    p.catch(() => null).then((res) => {
      // Dropped when the session left or was started over meanwhile.
      if (entryOf(session.sessionId, ident) !== entry) return;
      if (res && res.stale === true) {
        entry.state = 'stale';
        logStale(session, res.reason);
        notify(session.sessionId);
        return;
      }
      const host = res && res.host;
      const name = host && typeof host.name === 'string' && host.name !== '' ? host.name : null;
      if (name) {
        entry.state = 'done';
        entry.name = name;
        notify(session.sessionId);
        return;
      }
      entry.misses += 1;
      if (entry.misses <= retryDelays.length) {
        entry.state = 'none';
        entry.until = now() + retryDelays[entry.misses - 1];
      } else {
        entry.state = 'off';
      }
    });
  }

  function identOf(session) {
    if (!session || typeof session !== 'object' || session.source !== 'terminal') return null;
    if (typeof session.sessionId !== 'string' || session.sessionId === '') return null;
    return `${session.pid}|${session.procStart}`;
  }

  function hostFor(session) {
    try {
      const ident = identOf(session);
      if (ident === null) return null;
      const entry = entryOf(session.sessionId, ident);
      if (!entry) {
        start(session, ident, 0);
        return null;
      }
      if (entry.state === 'none' && now() >= entry.until) {
        start(session, ident, entry.misses);
        return null;
      }
      return entry.state === 'done' ? entry.name : null;
    } catch {
      return null;
    }
  }

  // True when a lookup proved that this session's registry entry (its pid and
  // procStart as now) no longer describes a live session.
  function isStale(session) {
    try {
      const ident = identOf(session);
      if (ident === null) return false;
      const entry = entryOf(session.sessionId, ident);
      return !!entry && entry.state === 'stale';
    } catch {
      return false;
    }
  }

  // Forgets sessions that are not in keptIds. Main passes every session read
  // from the registry, stale ones included, so a stale mark holds while its
  // file stays.
  function prune(keptIds) {
    const keep = new Set(keptIds);
    for (const id of [...entries.keys()]) if (!keep.has(id)) entries.delete(id);
  }

  return { hostFor, isStale, prune };
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
  openTargetFor,
  openSucceeded,
  createHostLookups,
  createOpenGate,
  openTerminal,
  MAX_OPEN_ID_LEN,
  RETRY_NULL_MS,
  RETRY_DELAYS_MS,
};
