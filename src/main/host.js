'use strict';

// Which window hosts a terminal Claude session: walk up the process tree from
// the registry pid to the first ancestor that owns a visible top-level window.
// Pure core (names, walk, resolver) plus a thin process-table loader. Process
// names are untrusted text: they are only compared and turned into a short
// visible name, never put on a command line.

const { runPowerShell, windowsOf, isValidPid } = require('./focus');
const { oneLine, cutLine } = require('./plan');

const MAX_DEPTH = 16;
const DEFAULT_TTL_MS = 5000;
const LOAD_TABLE_TIMEOUT_MS = 5000;
const MAX_NAME = 24;
const MAX_EXE_NAME = 260;
const MAX_CACHE = 256;
// The registry's procStart and WMI's CreationDate are both FILETIME ticks
// (100 ns); WMI keeps microseconds only, so allow 1 ms between them.
const START_TOLERANCE = 10000n;
const MAX_TICKS = 0xffffffffffffffffn;
const TICKS_RE = /^[0-9]{1,20}$/;

const FRIENDLY = new Map([
  ['zed.exe', 'Zed'],
  ['code.exe', 'VS Code'],
  ['code - insiders.exe', 'VS Code Insiders'],
  ['cursor.exe', 'Cursor'],
  ['windowsterminal.exe', 'Terminal'],
  ['wt.exe', 'Terminal'],
  ['conhost.exe', 'Terminal'],
  ['pwsh.exe', 'Terminal'],
  ['powershell.exe', 'Terminal'],
  ['cmd.exe', 'Terminal'],
  ['idea64.exe', 'JetBrains'],
  ['webstorm64.exe', 'JetBrains'],
  ['pycharm64.exe', 'JetBrains'],
]);

// The processes a registry pid may belong to. Any other name gives no host, so
// no window is ever focused; it is not a stale verdict either (judgeEntry).
const SESSION_PROCESSES = new Set(['claude.exe', 'node.exe']);
// Never the host: the session process itself, a parent claude or node.
const NOT_HOSTS = new Set(['claude.exe', 'node.exe']);
// The shell and system processes: nothing at or above them hosts a session,
// and their windows (File Explorer) are never the target.
const WALK_STOPS = new Set(['explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe']);

function lower(name) {
  return typeof name === 'string' ? name.toLowerCase() : '';
}

// A FILETIME tick count as a BigInt; 0n means unknown. FILETIME values pass
// Number.MAX_SAFE_INTEGER, so they travel as decimal strings; a safe
// non-negative integer number is accepted too. Anything else is unknown.
function toTicks(value) {
  let t = 0n;
  if (typeof value === 'bigint') t = value;
  else if (typeof value === 'string' && TICKS_RE.test(value)) t = BigInt(value);
  else if (Number.isSafeInteger(value)) t = BigInt(value);
  return t > 0n && t <= MAX_TICKS ? t : 0n;
}

// Short visible name for an executable: a known host's name, else the file
// name without its extension, hidden characters as "?", cut to 24 characters.
function friendlyName(exeName) {
  if (typeof exeName !== 'string') return '';
  const base = exeName.split(/[\\/]/).pop();
  const known = FRIENDLY.get(base.toLowerCase());
  if (known) return known;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return cutLine(oneLine(stem), MAX_NAME);
}

function indexTable(table) {
  const index = new Map();
  if (!Array.isArray(table)) return index;
  for (const row of table) {
    if (!row || typeof row !== 'object') continue;
    const { pid, ppid, name } = row;
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    if (typeof name !== 'string') continue;
    if (!index.has(pid)) index.set(pid, { pid, ppid, name, start: toTicks(row.start) });
  }
  return index;
}

// The chain from pid upward: [{ pid, name }], pid first. Stops at a missing
// parent, a cycle, pid 0 or 4 (Idle, System), after maxDepth entries, and at a
// parent that started after its child (its pid was reused by a newer process)
// or whose start time, or the child's, is unknown.
function walkAncestors(table, pid, maxDepth = MAX_DEPTH) {
  const index = table instanceof Map ? table : indexTable(table);
  const chain = [];
  const seen = new Set();
  let cur = pid;
  let child = null;
  while (chain.length < maxDepth) {
    if (!Number.isSafeInteger(cur) || cur === 0 || cur === 4 || seen.has(cur)) break;
    const row = index.get(cur);
    if (!row) break;
    if (child && (child.start === 0n || row.start === 0n || row.start > child.start)) break;
    seen.add(cur);
    chain.push({ pid: row.pid, name: row.name });
    child = row;
    cur = row.ppid;
  }
  return chain;
}

// The ancestors that may own the host window, nearest first: none unless the
// pid is a Claude Code process; skips claude and node; ends before the shell.
function hostCandidates(chain) {
  if (chain.length === 0 || !SESSION_PROCESSES.has(lower(chain[0].name))) return [];
  const out = [];
  for (const entry of chain.slice(1)) {
    const name = lower(entry.name);
    if (WALK_STOPS.has(name)) break;
    if (!NOT_HOSTS.has(name)) out.push(entry);
  }
  return out;
}

function ownsWindow(found, pid) {
  if (!found || typeof found.has !== 'function' || !found.has(pid)) return false;
  const v = typeof found.get === 'function' ? found.get(pid) : undefined;
  return Array.isArray(v) ? v.length > 0 : true;
}

function sameStart(a, b) {
  if (a === 0n || b === 0n) return false;
  const d = a > b ? a - b : b - a;
  return d <= START_TOLERANCE;
}

// What one process table says about a registry entry: 'live' (the pid is a
// claude or node process that started at `start`, within 1 ms), a stale
// reason (definitely not: 'pid-missing' when the pid is not in the table,
// 'start-mismatch' when its claude or node process started at another time)
// or 'unknown' (the pid belongs to another program, or its start time is not
// known: no host, but the session stays).
function judgeEntry(index, pid, start) {
  const self = index.get(pid);
  if (!self) return 'pid-missing';
  if (!SESSION_PROCESSES.has(lower(self.name))) return 'unknown';
  if (self.start === 0n) return 'unknown';
  return sameStart(self.start, start) ? 'live' : 'start-mismatch';
}

const NO_ANSWER = Object.freeze({ host: null, stale: false });
const STALE = Object.freeze({
  'pid-missing': Object.freeze({ host: null, stale: true, reason: 'pid-missing' }),
  'start-mismatch': Object.freeze({ host: null, stale: true, reason: 'start-mismatch' }),
});
// Tables read for one lookup at most: the first, one read since the lookup
// began, and one more to confirm a start mismatch seen on that one.
const MAX_TABLES = 3;

// lookup(pid, startKey, { revalidate }) -> { host: { name, ownerPid } | null,
// stale: boolean, reason? }. stale is true only when a loaded process table
// proves that the registry entry no longer describes a live session
// (judgeEntry); reason is then 'pid-missing' or 'start-mismatch'. A failed
// table load, a failed window check, a pid held by another program, an
// unknown start time, bad input or a live session without a host give
// { host: null, stale: false }.
// resolve(pid, startKey, { revalidate }) -> { name, ownerPid } | null is
// lookup's host alone (the older API).
// startKey is the registry's procStart (FILETIME ticks); without it there is no
// answer. A cache hit is served at once, with no table load: the refresh path
// stays free. A miss, or revalidate: true (the click path), uses the shared
// process table (at most one load per ttlMs; a failed load is remembered as a
// failure for that long and never clears a cache entry) and checks that the
// pid's start matches startKey and, for a cached owner, that it is still in the
// chain. A stale verdict from a table read before the lookup began is checked
// once more on a table read since, so a session that started after the last
// read is never called stale; a start mismatch is confirmed on one more table
// read after it was seen (concurrent lookups share that read). A failed read
// on the way gives no verdict. hasVisibleWindow(pids) answers for all candidates
// in one call (windowsOf). "No owner" is remembered for ttlMs. Never rejects.
function createHostResolver({ loadTable, hasVisibleWindow, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  let table = null; // { at, gen, promise -> Map | null (a failed load) }
  let loads = 0;
  const cache = new Map(); // key -> { ownerPid, exe, name } | { none: true, until }
  const inflight = new Map();

  // The shared table, read again when it is older than ttlMs, was read before
  // notBefore, or is not newer than the read numbered afterGen.
  function snapshot(notBefore = -Infinity, afterGen = 0) {
    const t = now();
    const usable =
      table && t >= table.at && t - table.at < ttlMs && table.at >= notBefore && table.gen > afterGen;
    if (!usable) {
      loads += 1;
      table = {
        at: t,
        gen: loads,
        promise: Promise.resolve()
          .then(() => loadTable())
          .then((rows) => {
            if (!Array.isArray(rows)) return null;
            const index = indexTable(rows);
            // A live system always has processes: an empty table is a failed read.
            return index.size > 0 ? index : null;
          }, () => null),
      };
    }
    return table;
  }

  function remember(key, value) {
    cache.delete(key);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }

  async function compute(pid, start, key) {
    const began = now();
    let snap = snapshot();
    let index = await snap.promise;
    if (!index) return NO_ANSWER;
    let verdict = judgeEntry(index, pid, start);
    let prev = null;
    for (let read = 1; STALE[verdict]; read += 1) {
      // A table read before the lookup began may predate the process: only a
      // table read since counts. A start mismatch must show on two tables in
      // a row, the second read after the first verdict.
      const fresh = snap.at >= began;
      const confirmed = verdict === 'pid-missing' ? fresh : fresh && prev === 'start-mismatch';
      if (confirmed) {
        cache.delete(key);
        return STALE[verdict];
      }
      if (read >= MAX_TABLES) break;
      prev = verdict;
      snap = snapshot(began, snap.gen);
      index = await snap.promise;
      if (!index) return NO_ANSWER;
      verdict = judgeEntry(index, pid, start);
    }
    if (verdict !== 'live') {
      // Cannot be told: another program on that pid, an unknown start time,
      // or a stale verdict that was not confirmed.
      cache.delete(key);
      return NO_ANSWER;
    }
    const candidates = hostCandidates(walkAncestors(index, pid));
    if (candidates.length === 0) {
      cache.delete(key);
      return NO_ANSWER;
    }
    const cached = cache.get(key);
    if (cached && !cached.none) {
      const still = candidates.some((c) => c.pid === cached.ownerPid && lower(c.name) === cached.exe);
      if (still) return { host: { name: cached.name, ownerPid: cached.ownerPid }, stale: false };
      cache.delete(key);
    } else if (cached && cached.none && now() < cached.until) {
      return NO_ANSWER;
    }
    let found = null;
    try {
      found = await hasVisibleWindow(candidates.map((c) => c.pid));
    } catch {
      found = null;
    }
    const owner = candidates.find((c) => ownsWindow(found, c.pid));
    if (!owner) {
      remember(key, { none: true, until: now() + ttlMs });
      return NO_ANSWER;
    }
    const host = { name: friendlyName(owner.name), ownerPid: owner.pid };
    remember(key, { ownerPid: owner.pid, exe: lower(owner.name), name: host.name });
    return { host, stale: false };
  }

  function lookup(pid, startKey, options) {
    try {
      if (!isValidPid(pid)) return Promise.resolve(NO_ANSWER);
      const start = toTicks(startKey);
      if (start === 0n) return Promise.resolve(NO_ANSWER);
      const revalidate = Boolean(options && options.revalidate);
      const key = `${pid}|${start}`;
      if (!revalidate) {
        const cached = cache.get(key);
        if (cached && !cached.none) {
          return Promise.resolve({ host: { name: cached.name, ownerPid: cached.ownerPid }, stale: false });
        }
        if (cached && cached.none && now() < cached.until) return Promise.resolve(NO_ANSWER);
      }
      const flight = `${key}|${revalidate ? 'check' : 'miss'}`;
      const pending = inflight.get(flight);
      if (pending) return pending;
      const p = compute(pid, start, key)
        .catch(() => NO_ANSWER)
        .finally(() => inflight.delete(flight));
      inflight.set(flight, p);
      return p;
    } catch {
      return Promise.resolve(NO_ANSWER);
    }
  }

  function resolve(pid, startKey, options) {
    return lookup(pid, startKey, options).then((r) => (r && r.host ? { ...r.host } : null));
  }

  return { resolve, lookup };
}

// Rows of the process table script, only well-formed ones; start is FILETIME
// ticks as a BigInt, 0n when missing or malformed. Tolerates garbage.
function parseProcessTable(text) {
  return readRows(text) || [];
}

// Like parseProcessTable, but null when the text is not JSON or holds
// neither a list nor a single row.
function readRows(text) {
  if (typeof text !== 'string') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return null;
  const out = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const { pid, ppid, name } = row;
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    out.push({ pid, ppid, name: name.slice(0, MAX_EXE_NAME), start: toTicks(row.start) });
  }
  return out;
}

// Fixed text, no data: pid, parent pid, name and creation time (FILETIME ticks
// as a decimal string, '0' when unknown) of every process, as ASCII JSON.
const PROCESS_TABLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object {
  $start = '0'
  if ($null -ne $_.CreationDate) { $start = [string]$_.CreationDate.ToFileTimeUtc() }
  [pscustomobject]@{ pid = [long]$_.ProcessId; ppid = [long]$_.ParentProcessId; name = [string]$_.Name; start = $start }
})
$json = ConvertTo-Json -InputObject $rows -Compress
[regex]::Replace($json, '[^\\x20-\\x7e]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
`;

// The process table in one PowerShell call (5 s timeout). Never rejects: any
// failure gives null, never an empty table, so a failed read cannot pass for
// "every process is gone". A table with no well-formed row counts as failed
// too: a live system always has processes.
async function loadProcessTable(deps = {}) {
  const run = (deps && deps.run) || runPowerShell;
  try {
    const res = await run(PROCESS_TABLE_SCRIPT, undefined, { timeoutMs: LOAD_TABLE_TIMEOUT_MS });
    if (!res || res.code !== 0) return null;
    const rows = readRows(res.stdout);
    return rows && rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

// The last segment of a working directory: the folder name a host window's
// title usually shows. Drive roots, "." and ".." give ''.
function folderNameOf(cwd) {
  if (typeof cwd !== 'string') return '';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : '';
  if (/^[A-Za-z]:$/.test(last) || last === '.' || last === '..') return '';
  return last;
}

module.exports = {
  friendlyName,
  walkAncestors,
  createHostResolver,
  loadProcessTable,
  parseProcessTable,
  folderNameOf,
  windowsOf,
  PROCESS_TABLE_SCRIPT,
};
