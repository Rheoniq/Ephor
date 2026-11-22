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

// The processes a registry pid may belong to. Any other name means the pid was
// reused by an unrelated process: no host, so no window is ever focused.
const SESSION_PROCESSES = new Set(['claude.exe', 'node.exe']);
// Never the host: the session process itself, a parent claude or node.
const NOT_HOSTS = new Set(['claude.exe', 'node.exe']);
// The shell and system processes: nothing at or above them hosts a session,
// and their windows (File Explorer) are never the target.
const WALK_STOPS = new Set(['explorer.exe', 'svchost.exe', 'services.exe', 'wininit.exe', 'winlogon.exe']);

function lower(name) {
  return typeof name === 'string' ? name.toLowerCase() : '';
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
    if (!index.has(pid)) index.set(pid, { pid, ppid, name });
  }
  return index;
}

// The chain from pid upward: [{ pid, name }], pid first. Stops at a missing
// parent, a cycle, pid 0 or 4 (Idle, System) or after maxDepth entries.
function walkAncestors(table, pid, maxDepth = MAX_DEPTH) {
  const index = table instanceof Map ? table : indexTable(table);
  const chain = [];
  const seen = new Set();
  let cur = pid;
  while (chain.length < maxDepth) {
    if (!Number.isSafeInteger(cur) || cur === 0 || cur === 4 || seen.has(cur)) break;
    const row = index.get(cur);
    if (!row) break;
    seen.add(cur);
    chain.push({ pid: row.pid, name: row.name });
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

// resolve(pid, startKey) -> { name, ownerPid } | null. One process-table load
// per ttlMs window, shared by every lookup. hasVisibleWindow(pids) answers for
// all candidates in one call (windowsOf). An owner is cached per pid and
// startKey (the registry's procStart, so a reused pid never hits an old entry)
// and served again only while the current table still shows it in the chain.
// "No owner" is remembered for ttlMs. Never rejects.
function createHostResolver({ loadTable, hasVisibleWindow, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  let table = null; // { at, promise -> Map | null }
  const cache = new Map(); // key -> { ownerPid, exe, name } | { none: true, until }
  const inflight = new Map();

  function snapshot() {
    const t = now();
    if (!table || t - table.at >= ttlMs || t < table.at) {
      table = {
        at: t,
        promise: Promise.resolve()
          .then(() => loadTable())
          .then((rows) => indexTable(rows), () => null),
      };
    }
    return table.promise;
  }

  function remember(key, value) {
    cache.delete(key);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
  }

  async function compute(pid, key) {
    const index = await snapshot();
    if (!index) return null;
    const candidates = hostCandidates(walkAncestors(index, pid));
    if (candidates.length === 0) return null;
    const cached = cache.get(key);
    if (cached && !cached.none) {
      const still = candidates.some((c) => c.pid === cached.ownerPid && lower(c.name) === cached.exe);
      if (still) return { name: cached.name, ownerPid: cached.ownerPid };
      cache.delete(key);
    } else if (cached && cached.none && now() < cached.until) {
      return null;
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
      return null;
    }
    const result = { name: friendlyName(owner.name), ownerPid: owner.pid };
    remember(key, { ownerPid: owner.pid, exe: lower(owner.name), name: result.name });
    return result;
  }

  function resolve(pid, startKey) {
    if (!isValidPid(pid)) return Promise.resolve(null);
    const key = `${pid}|${startKey == null ? '' : String(startKey)}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = compute(pid, key)
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { resolve };
}

// Rows of the process table script, only well-formed ones. Tolerates garbage.
function parseProcessTable(text) {
  if (typeof text !== 'string') return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) data = [data];
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const { pid, ppid, name } = row;
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    if (typeof name !== 'string' || name.length === 0) continue;
    out.push({ pid, ppid, name: name.slice(0, MAX_EXE_NAME) });
  }
  return out;
}

// Fixed text, no data: pid, parent pid and name of every process, as ASCII JSON.
const PROCESS_TABLE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name | ForEach-Object {
  [pscustomobject]@{ pid = [long]$_.ProcessId; ppid = [long]$_.ParentProcessId; name = [string]$_.Name }
})
$json = ConvertTo-Json -InputObject $rows -Compress
[regex]::Replace($json, '[^\\x20-\\x7e]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })
`;

// The process table in one PowerShell call (5 s timeout). Never rejects: any
// failure gives an empty table.
async function loadProcessTable(deps = {}) {
  const run = (deps && deps.run) || runPowerShell;
  try {
    const res = await run(PROCESS_TABLE_SCRIPT, undefined, { timeoutMs: LOAD_TABLE_TIMEOUT_MS });
    if (!res || res.code !== 0) return [];
    return parseProcessTable(res.stdout);
  } catch {
    return [];
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
