'use strict';

// Counts the background agents a session still has running, from its
// transcript. An async agent launch (a user event whose toolUseResult has
// isAsync true and an agentId) or a resume (a user event whose toolUseResult
// has a resumedAgentId) marks the agent pending; a task notification enqueued
// for it (a queue-operation event, operation enqueue) clears it, except an
// interim notice. The same notification also shows up as remove operations,
// attachments, user events and api-request events: only the enqueue counts.
// Notifications for ids that never had a launch or a resume (background shell
// tasks) are ignored, and so are sidechain events.
//
// A pending agent counts only while it looks alive: its own transcript
// (<subagentsDir>/agent-<id>.jsonl) was written within aliveMs, or its launch
// or resume is younger than freshLaunchMs. So an agent that stopped without
// reporting back ages out. The limit of this guard: a live agent whose own
// transcript stays silent for longer than aliveMs (45 minutes), for example
// during one long tool call or while it waits on its own background work, is
// missed and its session may show as finished early. An entry whose record
// and subagent transcript are both older than twice aliveMs leaves the ledger.
//
// The first read of a transcript scans its last windowBytes, from the first
// complete line; later reads go on from where the last one stopped when the
// file only grew (the plan-reader rules). A file that only grew, but by more
// than windowBytes, gets a window scan on top of the old ledger (agents whose
// notification fell in the skipped bytes then age out through liveness); any
// other change scans the window again from scratch. The ledger is cached per
// file by size and mtime; the liveness check runs on every read. read never
// throws. Transcript text is never kept or returned.

const fs = require('node:fs');
const path = require('node:path');

const NL = 0x0a;
const MARKS = [Buffer.from('"isAsync"'), Buffer.from('"resumedAgentId"'), Buffer.from('"queue-operation"')];
const ID_RE = /^[0-9a-f]{8,40}$/;
const NOTIFICATION_TAG = '<task-notification>';
const INTERIM = 'is waiting on its own background work';
// At most this many pending agents are tracked per transcript (the oldest go
// first), so the stat calls of one read stay bounded.
const MAX_PENDING = 128;

const DEFAULTS = Object.freeze({
  windowBytes: 8 * 1024 * 1024,
  aliveMs: 45 * 60 * 1000,
  freshLaunchMs: 2 * 60 * 1000,
});

const NONE = Object.freeze({ pending: 0 });

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const r = fs.readSync(fd, buf, off, length - off, start + off);
    if (r === 0) break;
    off += r;
  }
  return off === length ? buf : buf.subarray(0, off);
}

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasMark(line) {
  for (const m of MARKS) if (line.indexOf(m) !== -1) return true;
  return false;
}

// The record time in ms, or -Infinity (old) when missing or invalid.
function timeOf(event) {
  const t = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

// The agent id a notification is for, or null for an interim notice or
// anything that is not a task notification. Only the head before <result>
// is looked at: the result is the agent's own free text.
function notifiedId(content) {
  if (typeof content !== 'string' || !content.trimStart().startsWith(NOTIFICATION_TAG)) return null;
  const cut = content.indexOf('<result>');
  const head = cut === -1 ? content : content.slice(0, cut);
  const id = /<task-id>([^<]*)<\/task-id>/.exec(head);
  if (!id) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(head);
  if (summary && summary[1].includes(INTERIM)) return null;
  return id[1].trim();
}

// Applies one transcript line to the ledger (agent id -> record time).
function applyLine(ledger, line) {
  if (!hasMark(line)) return;
  let event;
  try {
    event = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (!isObject(event) || event.isSidechain === true) return;
  if (event.type === 'user') {
    const r = event.toolUseResult;
    if (!isObject(r)) return;
    if (r.isAsync === true && typeof r.agentId === 'string' && ID_RE.test(r.agentId)) setPending(ledger, r.agentId, timeOf(event));
    if (typeof r.resumedAgentId === 'string' && ID_RE.test(r.resumedAgentId)) setPending(ledger, r.resumedAgentId, timeOf(event));
  } else if (event.type === 'queue-operation' && event.operation === 'enqueue') {
    const id = notifiedId(event.content);
    // An id with no launch or resume is not in the ledger: nothing happens.
    if (id !== null) ledger.delete(id);
  }
}

function setPending(ledger, id, at) {
  ledger.delete(id); // re-inserted last, so the oldest go first at the cap
  ledger.set(id, at);
  if (ledger.size > MAX_PENDING) ledger.delete(ledger.keys().next().value);
}

// Applies the complete lines of buf[from..] and returns the offset just past
// the last complete line (relative to buf).
function applyLines(ledger, buf, from) {
  const end = buf.lastIndexOf(NL);
  if (end < from) return from;
  let pos = from;
  while (pos <= end) {
    const nl = buf.indexOf(NL, pos);
    if (nl > pos) applyLine(ledger, buf.subarray(pos, nl));
    pos = nl + 1;
  }
  return end + 1;
}

// Scans the last windowBytes of the file, from the first complete line, on
// top of a copy of `base` (an old ledger of the same file, or none).
function scanWindow(fd, size, windowBytes, base) {
  const ledger = new Map(base || []);
  const start = Math.max(0, size - windowBytes);
  if (start === 0) {
    const buf = readRange(fd, 0, size);
    return { ledger, parsedEnd: applyLines(ledger, buf, 0) };
  }
  // One byte before the window shows whether it starts at a line start.
  const buf = readRange(fd, start - 1, size - start + 1);
  const first = buf.indexOf(NL);
  if (first === -1) return { ledger, parsedEnd: size }; // no line starts in the window
  const done = applyLines(ledger, buf, first + 1);
  return { ledger, parsedEnd: start - 1 + done };
}

// Reads [from, size) and applies its complete lines onto a copy of `ledger`.
function scanForward(fd, from, size, ledger) {
  const next = new Map(ledger);
  const buf = readRange(fd, from, size - from);
  return { ledger: next, parsedEnd: from + applyLines(next, buf, 0) };
}

// Whether the file was only appended to since the last read: it grew, its
// mtime did not go back, and the byte just before the resume offset is still
// the newline that ended the last parsed line. Only then is the old ledger
// kept.
function appendedTo(fd, prev, size, mtimeMs) {
  if (!prev) return false;
  if (size <= prev.size || size < prev.parsedEnd) return false;
  if (mtimeMs < prev.mtimeMs) return false;
  if (prev.parsedEnd === 0) return true;
  const b = readRange(fd, prev.parsedEnd - 1, 1);
  return b.length === 1 && b[0] === NL;
}

function createAgentReader(opts = {}) {
  const pick = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const windowBytes = Math.floor(pick(opts.windowBytes, DEFAULTS.windowBytes));
  const aliveMs = pick(opts.aliveMs, DEFAULTS.aliveMs);
  const freshLaunchMs = pick(opts.freshLaunchMs, DEFAULTS.freshLaunchMs);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const cache = new Map(); // file -> { size, mtimeMs, parsedEnd, ledger }

  function within(age, limit) {
    return age < limit && age > -limit;
  }

  // Counts the ledger's agents that look alive right now. An entry whose
  // record and subagent transcript (or its absence) are both older than twice
  // aliveMs is dropped from the ledger for good.
  function alive(ledger, subagentsDir) {
    if (!ledger || ledger.size === 0) return 0;
    const t = now();
    const dirOk = typeof subagentsDir === 'string' && subagentsDir !== '';
    let n = 0;
    for (const [id, at] of ledger) {
      if (within(t - at, freshLaunchMs)) {
        n += 1;
        continue;
      }
      let fileAge = Infinity; // no file counts as old
      if (dirOk) {
        try {
          const st = fs.statSync(path.join(subagentsDir, `agent-${id}.jsonl`), { throwIfNoEntry: false });
          if (st && st.isFile()) fileAge = t - st.mtimeMs;
        } catch {
          fileAge = NaN; // unreadable: not alive, and not dropped either
        }
      }
      if (within(fileAge, aliveMs)) n += 1;
      // A record without a valid time is dropped only through an old file,
      // never for a file that is not there (yet).
      else if (t - at > 2 * aliveMs && fileAge > 2 * aliveMs && (fileAge !== Infinity || Number.isFinite(at))) ledger.delete(id);
    }
    return n;
  }

  function result(ledger, subagentsDir) {
    let n = 0;
    try {
      n = alive(ledger, subagentsDir);
    } catch {
      n = 0;
    }
    return n === 0 ? NONE : Object.freeze({ pending: n });
  }

  function read(transcriptFile, subagentsDir) {
    if (typeof transcriptFile !== 'string' || !transcriptFile) return NONE;
    const prev = cache.get(transcriptFile);
    const fallback = () => result(prev && prev.ledger, subagentsDir);
    let fd;
    try {
      fd = fs.openSync(transcriptFile, 'r');
    } catch {
      return fallback();
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return fallback();
      const size = st.size;
      const mtimeMs = st.mtimeMs;
      if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return result(prev.ledger, subagentsDir);
      const appended = appendedTo(fd, prev, size, mtimeMs);
      // Growth beyond the window: the window lies wholly after the old
      // resume offset, so it is scanned on top of the old ledger.
      const state = appended && size - prev.parsedEnd <= windowBytes
        ? scanForward(fd, prev.parsedEnd, size, prev.ledger)
        : scanWindow(fd, size, windowBytes, appended ? prev.ledger : null);
      cache.set(transcriptFile, { size, mtimeMs, parsedEnd: state.parsedEnd, ledger: state.ledger });
      return result(state.ledger, subagentsDir);
    } catch {
      return fallback();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  // Drops the cached ledger for a file (for example a session that left).
  function forget(file) {
    cache.delete(file);
  }

  return { read, forget };
}

// The status main uses everywhere downstream: an idle session with pending
// agents is still working. 'waiting' and 'busy' never change.
function effectiveStatus(registryStatus, pendingAgents) {
  if (registryStatus === 'idle' && Number.isInteger(pendingAgents) && pendingAgents > 0) return 'busy';
  return registryStatus;
}

// Main's per-session wiring: apply(kept) returns the kept sessions with their
// effective status, reading pending agents for registry-idle sessions only
// (through one shared reader; `filesFor(session)` gives { transcript,
// subagents } or null). A promoted session is a copy with `status` 'busy' and
// `pendingAgents`; every other session is returned as it is.
//
// Settle rule: the last notification is written while the registry still
// says idle, and the parent wakes up only a moment later. So a session that
// counted as working because of its agents and now reads idle with none
// pending stays a busy copy until it has read so for settleMs in a row (by
// `now`); only then is it released, once. Without this the finished tracker
// and the toasts would see busy, idle, busy within two polls. A registry
// status of busy or waiting, and prune, clear the settle state; a session
// that never had agents gets no delay.
//
// `log` gets one line when a registry-idle session starts counting as
// working because of its agents and one when it is released, with the first
// 8 characters of its id and the count. prune(keptIds) forgets the files of
// sessions that left. Never throws.
const SETTLE_MS = 6000; // three polls

function createAgentSource(reader, filesFor, log, opts = {}) {
  const settleMs =
    typeof opts.settleMs === 'number' && Number.isFinite(opts.settleMs) && opts.settleMs >= 0 ? opts.settleMs : SETTLE_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const files = new Map(); // sessionId -> transcript file last read
  const promoted = new Set(); // sessions counted as working because of their agents
  const settling = new Map(); // sessionId -> when it first read idle with no agents after that

  function clear(id) {
    promoted.delete(id);
    settling.delete(id);
  }

  function say(line) {
    if (typeof log !== 'function') return;
    try {
      log(line);
    } catch {
      /* ignore */
    }
  }

  function forgetFile(file) {
    if (typeof reader.forget !== 'function') return;
    try {
      reader.forget(file);
    } catch {
      /* ignore */
    }
  }

  function pendingOf(s) {
    try {
      const f = filesFor(s);
      if (!f || typeof f.transcript !== 'string' || !f.transcript) return 0;
      const before = files.get(s.sessionId);
      if (before !== undefined && before !== f.transcript) forgetFile(before);
      files.set(s.sessionId, f.transcript);
      const r = reader.read(f.transcript, f.subagents);
      const n = r && r.pending;
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  function applyOne(s) {
    if (!s || typeof s.sessionId !== 'string') return s;
    const id = s.sessionId;
    if (s.status !== 'idle') {
      clear(id);
      return s;
    }
    const n = pendingOf(s);
    if (n > 0) {
      if (!promoted.has(id)) say(`session ${id.slice(0, 8)}: ${n} agents pending, counts as working`);
      promoted.add(id);
      settling.delete(id);
      return { ...s, status: effectiveStatus(s.status, n), pendingAgents: n };
    }
    if (!promoted.has(id)) return s;
    let t;
    try {
      t = Number(now());
    } catch {
      t = NaN;
    }
    if (!Number.isFinite(t)) t = Date.now();
    let since = settling.get(id);
    // A clock that went back starts the settle again instead of holding.
    if (since === undefined || t < since) {
      since = t;
      settling.set(id, since);
    }
    if (t - since < settleMs) return { ...s, status: 'busy', pendingAgents: 0 };
    clear(id);
    say(`session ${id.slice(0, 8)}: 0 agents pending, no longer counts as working`);
    return s;
  }

  function apply(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.map(applyOne);
  }

  function prune(keptIds) {
    const keep = new Set(keptIds);
    for (const [id, file] of [...files]) {
      if (keep.has(id)) continue;
      files.delete(id);
      forgetFile(file);
    }
    for (const id of [...promoted]) if (!keep.has(id)) clear(id);
    for (const id of [...settling.keys()]) if (!keep.has(id)) clear(id);
  }

  return { apply, prune };
}

module.exports = { createAgentReader, effectiveStatus, createAgentSource, DEFAULTS, SETTLE_MS };
