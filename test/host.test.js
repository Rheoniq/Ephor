'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  friendlyName,
  walkAncestors,
  createHostResolver,
  folderNameOf,
  parseProcessTable,
  loadProcessTable,
} = require('../src/main/host');

// claude.exe -> pwsh.exe -> Zed.exe -> explorer.exe, as recon showed on this
// machine. start is the creation time in FILETIME ticks: parents start first.
const TABLE = [
  { pid: 4, ppid: 0, name: 'System', start: 1 },
  { pid: 900, ppid: 4, name: 'smss.exe', start: 10 },
  { pid: 1000, ppid: 900, name: 'explorer.exe', start: 100 },
  { pid: 2000, ppid: 1000, name: 'Zed.exe', start: 200 },
  { pid: 3000, ppid: 2000, name: 'pwsh.exe', start: 300 },
  { pid: 4000, ppid: 3000, name: 'claude.exe', start: 400000 },
  { pid: 5000, ppid: 3000, name: 'node.exe', start: 500000 },
  { pid: 6000, ppid: 1000, name: 'chrome.exe', start: 600 },
  { pid: 6100, ppid: 6000, name: 'chrome.exe', start: 610 },
];
const CLAUDE = '400000';
const NODE = '500000';

// --- friendlyName ---

test('friendlyName maps known hosts', () => {
  const cases = {
    'Zed.exe': 'Zed',
    'Code.exe': 'VS Code',
    'Code - Insiders.exe': 'VS Code Insiders',
    'Cursor.exe': 'Cursor',
    'WindowsTerminal.exe': 'Terminal',
    'wt.exe': 'Terminal',
    'conhost.exe': 'Terminal',
    'pwsh.exe': 'Terminal',
    'powershell.exe': 'Terminal',
    'cmd.exe': 'Terminal',
    'idea64.exe': 'JetBrains',
    'webstorm64.exe': 'JetBrains',
    'pycharm64.exe': 'JetBrains',
  };
  for (const [exe, name] of Object.entries(cases)) {
    assert.equal(friendlyName(exe), name, exe);
  }
});

test('friendlyName ignores case', () => {
  assert.equal(friendlyName('ZED.EXE'), 'Zed');
  assert.equal(friendlyName('code.exe'), 'VS Code');
  assert.equal(friendlyName('CODE - INSIDERS.EXE'), 'VS Code Insiders');
});

test('friendlyName gives an unknown executable its name without extension', () => {
  assert.equal(friendlyName('alacritty.exe'), 'alacritty');
  assert.equal(friendlyName('WezTerm-gui.exe'), 'WezTerm-gui');
  assert.equal(friendlyName('my.tool.exe'), 'my.tool');
  assert.equal(friendlyName('noext'), 'noext');
});

test('friendlyName cuts long names to 24 characters', () => {
  const out = friendlyName(`${'a'.repeat(40)}.exe`);
  assert.ok(out.length <= 24, out);
  assert.ok(out.startsWith('aaaa'));
});

test('friendlyName replaces hidden characters', () => {
  assert.equal(friendlyName('ev\u202eil.exe'), 'ev?il');
  assert.equal(friendlyName('a\u0007b.exe'), 'a?b');
  assert.equal(friendlyName('zero\u200bwidth.exe'), 'zero?width');
});

test('friendlyName never throws on odd input', () => {
  for (const v of [undefined, null, 42, {}, [], '', '.exe', '   ']) {
    assert.equal(typeof friendlyName(v), 'string', String(v));
  }
  assert.equal(friendlyName(undefined), '');
  assert.equal(friendlyName(''), '');
});

// --- walkAncestors ---

test('walkAncestors follows the chain upward and stops before pid 4', () => {
  assert.deepEqual(walkAncestors(TABLE, 4000), [
    { pid: 4000, name: 'claude.exe' },
    { pid: 3000, name: 'pwsh.exe' },
    { pid: 2000, name: 'Zed.exe' },
    { pid: 1000, name: 'explorer.exe' },
    { pid: 900, name: 'smss.exe' },
  ]);
});

test('walkAncestors stops at a missing parent', () => {
  const t = [
    { pid: 10, ppid: 20, name: 'a.exe', start: 50 },
    { pid: 20, ppid: 31337, name: 'b.exe', start: 40 },
  ];
  assert.deepEqual(walkAncestors(t, 10), [
    { pid: 10, name: 'a.exe' },
    { pid: 20, name: 'b.exe' },
  ]);
});

test('walkAncestors gives an empty chain for a pid not in the table', () => {
  assert.deepEqual(walkAncestors(TABLE, 12345), []);
  assert.deepEqual(walkAncestors(TABLE, 0), []);
  assert.deepEqual(walkAncestors(TABLE, 4), []);
});

test('walkAncestors stops on a cycle', () => {
  // Equal start times keep the order rule out of the way.
  const t = [
    { pid: 10, ppid: 20, name: 'a.exe', start: 5 },
    { pid: 20, ppid: 30, name: 'b.exe', start: 5 },
    { pid: 30, ppid: 10, name: 'c.exe', start: 5 },
  ];
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10, 20, 30]);
  const self = [{ pid: 10, ppid: 10, name: 'a.exe', start: 5 }];
  assert.deepEqual(walkAncestors(self, 10).map((e) => e.pid), [10]);
});

test('walkAncestors stops at pid 0', () => {
  const t = [{ pid: 10, ppid: 0, name: 'a.exe', start: 5 }, { pid: 0, ppid: 0, name: 'Idle', start: 1 }];
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10]);
});

test('walkAncestors caps the depth', () => {
  const t = [];
  for (let i = 1; i <= 40; i++) t.push({ pid: i * 8, ppid: (i + 1) * 8, name: `p${i}.exe`, start: 1000 - i });
  assert.equal(walkAncestors(t, 8).length, 16);
  assert.equal(walkAncestors(t, 8, 3).length, 3);
});

test('walkAncestors ends at a parent that started after its child (a reused pid)', () => {
  const t = [
    { pid: 10, ppid: 20, name: 'claude.exe', start: 500 },
    { pid: 20, ppid: 30, name: 'pwsh.exe', start: 400 },
    // pid 30 was the host; it died and the pid now belongs to a newer process.
    { pid: 30, ppid: 1, name: 'chrome.exe', start: 900 },
  ];
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10, 20]);
});

test('walkAncestors treats an unknown start time as the end of the chain', () => {
  const parentUnknown = [
    { pid: 10, ppid: 20, name: 'claude.exe', start: 500 },
    { pid: 20, ppid: 30, name: 'pwsh.exe', start: 0 },
  ];
  assert.deepEqual(walkAncestors(parentUnknown, 10).map((e) => e.pid), [10]);
  const parentMissing = [
    { pid: 10, ppid: 20, name: 'claude.exe', start: 500 },
    { pid: 20, ppid: 30, name: 'pwsh.exe' },
  ];
  assert.deepEqual(walkAncestors(parentMissing, 10).map((e) => e.pid), [10]);
  const childUnknown = [
    { pid: 10, ppid: 20, name: 'claude.exe' },
    { pid: 20, ppid: 30, name: 'pwsh.exe', start: 400 },
  ];
  assert.deepEqual(walkAncestors(childUnknown, 10).map((e) => e.pid), [10]);
});

test('walkAncestors compares real FILETIME values exactly', () => {
  const t = [
    { pid: 10, ppid: 20, name: 'claude.exe', start: '134398573554097853' },
    { pid: 20, ppid: 30, name: 'pwsh.exe', start: '134398573554097852' },
    { pid: 30, ppid: 40, name: 'Zed.exe', start: '134398573554097854' },
  ];
  // 852 <= 853 continues; 854 > 852 ends (beyond float precision).
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10, 20]);
});

test('walkAncestors tolerates bad input', () => {
  assert.deepEqual(walkAncestors(null, 10), []);
  assert.deepEqual(walkAncestors('x', 10), []);
  assert.deepEqual(walkAncestors([null, 7, { pid: 'x' }], 10), []);
  assert.deepEqual(walkAncestors(TABLE, '4000'), []);
});

// --- parseProcessTable ---

test('parseProcessTable keeps only well-formed rows', () => {
  const text = JSON.stringify([
    { pid: 1, ppid: 0, name: 'a.exe', start: '134398573554097850' },
    { pid: -1, ppid: 0, name: 'neg.exe', start: '1' },
    { pid: 2.5, ppid: 0, name: 'frac.exe', start: '1' },
    { pid: 3, ppid: 'x', name: 'bad.exe', start: '1' },
    { pid: 4, ppid: 0, start: '1' },
    { pid: 5, ppid: 1, name: '', start: '1' },
    null,
    'junk',
    { pid: 6, ppid: 1, name: 'b.exe', start: '0', extra: 'ignored' },
  ]);
  assert.deepEqual(parseProcessTable(text), [
    { pid: 1, ppid: 0, name: 'a.exe', start: 134398573554097850n },
    { pid: 6, ppid: 1, name: 'b.exe', start: 0n },
  ]);
});

test('parseProcessTable reads a missing or malformed start as unknown (0)', () => {
  const rows = [
    { pid: 1, ppid: 0, name: 'a.exe' },
    { pid: 2, ppid: 0, name: 'b.exe', start: null },
    { pid: 3, ppid: 0, name: 'c.exe', start: '-5' },
    { pid: 4, ppid: 0, name: 'd.exe', start: '12x' },
    { pid: 5, ppid: 0, name: 'e.exe', start: '1'.repeat(21) },
    { pid: 6, ppid: 0, name: 'f.exe', start: 1.5 },
    { pid: 7, ppid: 0, name: 'g.exe', start: 77 },
  ];
  assert.deepEqual(
    parseProcessTable(JSON.stringify(rows)).map((r) => r.start),
    [0n, 0n, 0n, 0n, 0n, 0n, 77n],
  );
});

test('parseProcessTable accepts a single object and tolerates garbage', () => {
  assert.deepEqual(parseProcessTable('{"pid":7,"ppid":1,"name":"x.exe","start":"9"}'), [
    { pid: 7, ppid: 1, name: 'x.exe', start: 9n },
  ]);
  for (const bad of ['', 'not json', '42', 'null', '[1,2', undefined, null, 17]) {
    assert.deepEqual(parseProcessTable(bad), [], String(bad));
  }
});

test('parseProcessTable decodes escaped unicode names', () => {
  assert.deepEqual(parseProcessTable('[{"pid":8,"ppid":1,"name":"caf\\u00e9.exe","start":"3"}]'), [
    { pid: 8, ppid: 1, name: 'caf\u00e9.exe', start: 3n },
  ]);
});

test('loadProcessTable passes no data and parses the output', async () => {
  const calls = [];
  const run = async (script, input, opts) => {
    calls.push({ script, input, opts });
    return { code: 0, stdout: '[{"pid":1,"ppid":0,"name":"a.exe","start":"5"}]\r\n' };
  };
  assert.deepEqual(await loadProcessTable({ run }), [{ pid: 1, ppid: 0, name: 'a.exe', start: 5n }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, undefined);
  assert.equal(calls[0].opts.timeoutMs, 5000);
  assert.match(calls[0].script, /Get-CimInstance/);
  assert.match(calls[0].script, /CreationDate/);
});

test('loadProcessTable gives null (a failure, not an empty table) on any failure', async () => {
  const runs = [
    async () => null,
    async () => ({ code: 1, stdout: '[{"pid":1,"ppid":0,"name":"a.exe","start":"5"}]' }),
    async () => { throw new Error('spawn failed'); },
    () => { throw new Error('sync throw'); },
    async () => ({ code: 0, stdout: 'garbage' }),
    async () => ({ code: 0, stdout: '' }),
    async () => ({ code: 0, stdout: '42' }),
    // A live system always has processes: an empty table is a failed read.
    async () => ({ code: 0, stdout: '[]' }),
    async () => ({ code: 0, stdout: '[{"pid":-1,"ppid":0,"name":"a.exe"}]' }),
  ];
  for (const run of runs) {
    assert.equal(await loadProcessTable({ run }), null);
  }
});

// --- createHostResolver ---

function fakeResolver({ table = TABLE, windows = [2000], ttlMs = 5000 } = {}) {
  const state = { t: 1000, loads: 0, checks: [] };
  const resolver = createHostResolver({
    loadTable: async () => {
      state.loads += 1;
      return typeof table === 'function' ? table() : table;
    },
    hasVisibleWindow: async (pids) => {
      state.checks.push(pids);
      const owned = typeof windows === 'function' ? windows() : windows;
      return new Map(owned.map((p) => [p, [{ hwnd: '1', title: 't' }]]));
    },
    now: () => state.t,
    ttlMs,
  });
  return { resolver, state };
}

test('resolve finds the first ancestor with a visible window', async () => {
  const { resolver, state } = fakeResolver();
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
  // The claude process itself is never asked for; the walk stops before explorer.
  assert.deepEqual(state.checks, [[3000, 2000]]);
});

test('five concurrent resolves share one table load', async () => {
  const { resolver, state } = fakeResolver();
  const results = await Promise.all([
    resolver.resolve(4000, CLAUDE),
    resolver.resolve(4000, CLAUDE),
    resolver.resolve(5000, NODE),
    resolver.resolve(4000, CLAUDE, { revalidate: true }),
    resolver.resolve(12345, '1'),
  ]);
  assert.equal(state.loads, 1);
  assert.deepEqual(results[0], { name: 'Zed', ownerPid: 2000 });
  assert.deepEqual(results[1], { name: 'Zed', ownerPid: 2000 });
  assert.deepEqual(results[2], { name: 'Zed', ownerPid: 2000 });
  assert.deepEqual(results[3], { name: 'Zed', ownerPid: 2000 });
  assert.equal(results[4], null);
});

test('a cache miss after the ttl loads a new table', async () => {
  const { resolver, state } = fakeResolver({ ttlMs: 5000 });
  await resolver.resolve(4000, CLAUDE);
  state.t += 4999;
  await resolver.resolve(5000, NODE);
  assert.equal(state.loads, 1);
  state.t += 1;
  await resolver.resolve(4000, '400001');
  assert.equal(state.loads, 2);
});

test('cached hits are served without any table load or window check', async () => {
  const { resolver, state } = fakeResolver();
  await resolver.resolve(4000, CLAUDE);
  assert.equal(state.loads, 1);
  state.t += 60000;
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => resolver.resolve(4000, CLAUDE)));
  for (const r of results) assert.deepEqual(r, { name: 'Zed', ownerPid: 2000 });
  assert.equal(state.loads, 1);
  assert.equal(state.checks.length, 1);
});

test('revalidate loads the table at most once, shared, and keeps a still-valid owner', async () => {
  const { resolver, state } = fakeResolver();
  await resolver.resolve(4000, CLAUDE);
  state.t += 60000;
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(() => resolver.resolve(4000, CLAUDE, { revalidate: true })),
  );
  for (const r of results) assert.deepEqual(r, { name: 'Zed', ownerPid: 2000 });
  assert.equal(state.loads, 2);
  assert.equal(state.checks.length, 1);
  // Within the ttl the shared table is reused.
  await resolver.resolve(4000, CLAUDE, { revalidate: true });
  assert.equal(state.loads, 2);
});

test('a reused pid with a different startKey is not served from the cache', async () => {
  let table = TABLE;
  let windows = [2000];
  const { resolver, state } = fakeResolver({ table: () => table, windows: () => windows });
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
  // pid 4000 now belongs to a new claude under VS Code.
  table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe', start: 100 },
    { pid: 7000, ppid: 1000, name: 'Code.exe', start: 700 },
    { pid: 7100, ppid: 7000, name: 'pwsh.exe', start: 710 },
    { pid: 4000, ppid: 7100, name: 'claude.exe', start: 900000 },
  ];
  windows = [7000];
  state.t += 10000;
  assert.deepEqual(await resolver.resolve(4000, '900000'), { name: 'VS Code', ownerPid: 7000 });
  assert.equal(state.checks.length, 2);
  // The stale registry key no longer matches the live process on revalidation,
  // and is then dropped from the cache.
  assert.equal(await resolver.resolve(4000, CLAUDE, { revalidate: true }), null);
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
});

test('a cached owner that is no longer in the chain is looked up again on revalidation', async () => {
  let table = TABLE;
  let windows = [2000];
  const { resolver, state } = fakeResolver({ table: () => table, windows: () => windows });
  await resolver.resolve(4000, CLAUDE);
  // Same process, but the old host is gone.
  table = [
    { pid: 4000, ppid: 3000, name: 'claude.exe', start: 400000 },
    { pid: 3000, ppid: 8000, name: 'pwsh.exe', start: 300 },
  ];
  windows = [];
  state.t += 10000;
  assert.equal(await resolver.resolve(4000, CLAUDE, { revalidate: true }), null);
  assert.equal(state.checks.length, 2);
});

test('the registry start must match the live process within 1 ms', async () => {
  const table = [
    { pid: 3000, ppid: 2000, name: 'pwsh.exe', start: '134398573000000000' },
    { pid: 2000, ppid: 1000, name: 'Zed.exe', start: '134398572000000000' },
    { pid: 1000, ppid: 4, name: 'explorer.exe', start: '134398571000000000' },
    { pid: 4000, ppid: 3000, name: 'claude.exe', start: '134398573554097850' },
  ];
  const ok = ['134398573554097853', '134398573554097850', '134398573554107850', '134398573554087850'];
  for (const startKey of ok) {
    const { resolver } = fakeResolver({ table });
    assert.deepEqual(await resolver.resolve(4000, startKey), { name: 'Zed', ownerPid: 2000 }, startKey);
  }
  const bad = ['134398573554107851', '134398573554087849', '134398573654097850'];
  for (const startKey of bad) {
    const { resolver, state } = fakeResolver({ table });
    assert.equal(await resolver.resolve(4000, startKey), null, startKey);
    assert.equal(state.checks.length, 0);
  }
});

test('a live process with an unknown start never resolves', async () => {
  const table = TABLE.map((r) => (r.pid === 4000 ? { ...r, start: 0 } : r));
  const { resolver, state } = fakeResolver({ table });
  assert.equal(await resolver.resolve(4000, '0'), null);
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
  assert.equal(state.checks.length, 0);
});

test('a missing or malformed startKey gives null without loading', async () => {
  const { resolver, state } = fakeResolver();
  for (const startKey of [undefined, null, '', '0', 'abc', '-400000', '4e5', ' 400000', 1.5, {}, '1'.repeat(21)]) {
    assert.equal(await resolver.resolve(4000, startKey), null, String(startKey));
  }
  assert.equal(state.loads, 0);
});

test('a numeric startKey works like its decimal string', async () => {
  const { resolver } = fakeResolver();
  assert.deepEqual(await resolver.resolve(4000, 400000), { name: 'Zed', ownerPid: 2000 });
});

test('a dead pid gives null', async () => {
  const { resolver, state } = fakeResolver();
  assert.equal(await resolver.resolve(12345, CLAUDE), null);
  assert.equal(state.checks.length, 0);
});

test('a pid that is not a claude or node process gives null (pid reuse)', async () => {
  const { resolver, state } = fakeResolver({ windows: [6000] });
  // 6100 is a chrome child whose parent owns windows: never a host.
  assert.equal(await resolver.resolve(6100, '610'), null);
  assert.equal(state.checks.length, 0);
});

test('claude and node ancestors are skipped as owners', async () => {
  const table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe', start: 100 },
    { pid: 2000, ppid: 1000, name: 'WindowsTerminal.exe', start: 200 },
    { pid: 2100, ppid: 2000, name: 'node.exe', start: 210 },
    { pid: 2200, ppid: 2100, name: 'Claude.exe', start: 220 },
    { pid: 2300, ppid: 2200, name: 'cmd.exe', start: 230 },
    { pid: 2400, ppid: 2300, name: 'claude.exe', start: 240 },
  ];
  // Every process "owns" a window: only the terminal may win.
  const { resolver, state } = fakeResolver({ table, windows: [2000, 2100, 2200, 2300, 2400] });
  assert.deepEqual(await resolver.resolve(2400, '240'), { name: 'Terminal', ownerPid: 2300 });
  assert.deepEqual(state.checks, [[2300, 2000]]);
});

test('the walk never reaches past explorer to a random window', async () => {
  const table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe', start: 100 },
    { pid: 4000, ppid: 1000, name: 'claude.exe', start: 400000 },
  ];
  const { resolver, state } = fakeResolver({ table, windows: [1000] });
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
  assert.equal(state.checks.length, 0);
});

test('a reused parent pid is never taken as the host', async () => {
  const table = [
    { pid: 4000, ppid: 3000, name: 'claude.exe', start: 400000 },
    { pid: 3000, ppid: 2000, name: 'pwsh.exe', start: 300 },
    // The real host (pid 2000) is gone; a newer windowed process got its pid.
    { pid: 2000, ppid: 1000, name: 'chrome.exe', start: 999999 },
  ];
  const { resolver, state } = fakeResolver({ table, windows: [2000] });
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
  assert.deepEqual(state.checks, [[3000]]);
});

test('no ancestor with a window gives null and is retried after the ttl', async () => {
  let windows = [];
  const { resolver, state } = fakeResolver({ windows: () => windows });
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
  assert.equal(await resolver.resolve(4000, CLAUDE), null);
  assert.equal(state.checks.length, 1);
  assert.equal(state.loads, 1);
  windows = [2000];
  state.t += 5000;
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
});

test('loader and window check failures give null, never throw', async () => {
  const cases = [
    { loadTable: async () => { throw new Error('x'); }, hasVisibleWindow: async () => new Map() },
    { loadTable: () => { throw new Error('sync'); }, hasVisibleWindow: async () => new Map() },
    { loadTable: async () => 'garbage', hasVisibleWindow: async () => new Map() },
    { loadTable: async () => TABLE, hasVisibleWindow: async () => { throw new Error('x'); } },
    { loadTable: async () => TABLE, hasVisibleWindow: () => { throw new Error('sync'); } },
    { loadTable: async () => TABLE, hasVisibleWindow: async () => null },
    { loadTable: async () => TABLE, hasVisibleWindow: async () => 'junk' },
  ];
  for (const deps of cases) {
    const resolver = createHostResolver({ ...deps, now: () => 0 });
    assert.equal(await resolver.resolve(4000, CLAUDE), null);
    assert.equal(await resolver.resolve(4000, CLAUDE, { revalidate: true }), null);
  }
  const resolver = createHostResolver({ loadTable: async () => TABLE, hasVisibleWindow: async () => new Map() });
  assert.equal(await resolver.resolve(4000, CLAUDE, null), null);
});

test('an owner listed with no windows does not count', async () => {
  const resolver = createHostResolver({
    loadTable: async () => TABLE,
    hasVisibleWindow: async () => new Map([[3000, []], [2000, [{ hwnd: '1', title: 'x' }]]]),
    now: () => 0,
  });
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
});

// --- lookup: stale or not ---

const LIVE_ZED = { host: { name: 'Zed', ownerPid: 2000 }, stale: false };
const NO_ANSWER = { host: null, stale: false };
const STALE = { host: null, stale: true, reason: 'pid-missing' };
const MISMATCH = { host: null, stale: true, reason: 'start-mismatch' };

test('lookup gives the host and stale false for a live session', async () => {
  const { resolver } = fakeResolver();
  assert.deepEqual(await resolver.lookup(4000, CLAUDE), LIVE_ZED);
  // Cached hit, revalidate: the same answer.
  assert.deepEqual(await resolver.lookup(4000, CLAUDE), LIVE_ZED);
  assert.deepEqual(await resolver.lookup(4000, CLAUDE, { revalidate: true }), LIVE_ZED);
});

test('lookup reports stale when the pid is missing from a loaded table', async () => {
  const { resolver, state } = fakeResolver();
  assert.deepEqual(await resolver.lookup(12345, CLAUDE), STALE);
  assert.equal(state.checks.length, 0);
  assert.equal(await resolver.resolve(12345, CLAUDE), null);
});

test('lookup reports stale when the start time does not match within 1 ms', async () => {
  const { resolver } = fakeResolver();
  assert.deepEqual(await resolver.lookup(4000, '410001'), MISMATCH);
  assert.deepEqual(await resolver.lookup(4000, '389999'), MISMATCH);
  // Within 1 ms is the same process.
  assert.deepEqual(await resolver.lookup(4000, '410000'), LIVE_ZED);
});

test('a start mismatch is confirmed on a table loaded after the first verdict', async () => {
  const { resolver, state } = fakeResolver();
  assert.deepEqual(await resolver.lookup(4000, '410001'), MISMATCH);
  // The first table was read for this lookup, and still one more is read.
  assert.equal(state.loads, 2);
});

test('a start mismatch that is not confirmed on the fresh table is not stale', async () => {
  let table = TABLE.map((r) => (r.pid === 4000 ? { ...r, start: 999999 } : r));
  const { resolver, state } = fakeResolver({
    table: () => {
      const t = table;
      table = TABLE;
      return t;
    },
  });
  // A glitched first read: the fresh table shows the right start.
  assert.deepEqual(await resolver.lookup(4000, CLAUDE), LIVE_ZED);
  assert.equal(state.loads, 2);
});

test('a mismatch first seen on the fresh read after an old table is confirmed once more', async () => {
  let table = TABLE.filter((r) => r.pid !== 5000);
  const { resolver, state } = fakeResolver({ table: () => table });
  await resolver.resolve(4000, CLAUDE);
  // pid 5000 appears with another start after the first read.
  table = TABLE;
  state.t += 1000;
  assert.deepEqual(await resolver.lookup(5000, '510001'), MISMATCH);
  assert.equal(state.loads, 3);
});

test('concurrent start mismatches share one confirming load', async () => {
  const { resolver, state } = fakeResolver();
  const results = await Promise.all([resolver.lookup(4000, '410001'), resolver.lookup(5000, '510001')]);
  assert.deepEqual(results, [MISMATCH, MISMATCH]);
  assert.equal(state.loads, 2);
});

test('a failed confirming load gives no verdict', async () => {
  let n = 0;
  const { resolver } = fakeResolver({
    table: () => {
      n += 1;
      if (n > 1) throw new Error('wmi down');
      return TABLE;
    },
  });
  assert.deepEqual(await resolver.lookup(4000, '410001'), NO_ANSWER);
});

test('lookup is not stale when the pid is not a claude or node process (unknown)', async () => {
  const { resolver, state } = fakeResolver({ windows: [6000] });
  assert.deepEqual(await resolver.lookup(6100, '610'), NO_ANSWER);
  // Whatever its start time says.
  const unknown = TABLE.map((r) => (r.pid === 6100 ? { ...r, start: 0 } : r));
  const other = fakeResolver({ table: unknown, windows: [6000] });
  assert.deepEqual(await other.resolver.lookup(6100, '610'), NO_ANSWER);
  assert.deepEqual(await other.resolver.lookup(6100, '999'), NO_ANSWER);
  // A mismatched start on another program is unknown too.
  assert.deepEqual(await resolver.lookup(6100, '999999'), NO_ANSWER);
  assert.equal(state.checks.length, 0);
});

test('lookup is never stale on a failed load, a failed window check or an unknown start', async () => {
  const failures = [
    { loadTable: async () => { throw new Error('x'); }, hasVisibleWindow: async () => new Map() },
    { loadTable: () => { throw new Error('sync'); }, hasVisibleWindow: async () => new Map() },
    { loadTable: async () => null, hasVisibleWindow: async () => new Map() },
    { loadTable: async () => 'garbage', hasVisibleWindow: async () => new Map() },
    { loadTable: async () => [], hasVisibleWindow: async () => new Map() },
    { loadTable: async () => TABLE, hasVisibleWindow: async () => { throw new Error('x'); } },
    { loadTable: async () => TABLE, hasVisibleWindow: async () => null },
    { loadTable: async () => TABLE.map((r) => (r.pid === 4000 ? { ...r, start: 0 } : r)), hasVisibleWindow: async () => new Map([[2000, [1]]]) },
  ];
  for (const deps of failures) {
    const resolver = createHostResolver({ ...deps, now: () => 0 });
    assert.deepEqual(await resolver.lookup(4000, CLAUDE), NO_ANSWER);
    assert.deepEqual(await resolver.lookup(4000, CLAUDE, { revalidate: true }), NO_ANSWER);
  }
});

test('lookup is not stale for a live session without a host', async () => {
  // No ancestor owns a window.
  const none = fakeResolver({ windows: [] });
  assert.deepEqual(await none.resolver.lookup(4000, CLAUDE), NO_ANSWER);
  // Remembered "no owner": still not stale.
  assert.deepEqual(await none.resolver.lookup(4000, CLAUDE), NO_ANSWER);
  // Nothing but explorer above the session.
  const table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe', start: 100 },
    { pid: 4000, ppid: 1000, name: 'claude.exe', start: 400000 },
  ];
  const bare = fakeResolver({ table, windows: [1000] });
  assert.deepEqual(await bare.resolver.lookup(4000, CLAUDE), NO_ANSWER);
});

test('lookup is not stale for a missing or malformed startKey or an invalid pid', async () => {
  const { resolver, state } = fakeResolver();
  for (const startKey of [undefined, null, '', '0', 'abc']) {
    assert.deepEqual(await resolver.lookup(4000, startKey), NO_ANSWER, String(startKey));
  }
  for (const pid of [undefined, '4000', 0, -4, 1.5]) {
    assert.deepEqual(await resolver.lookup(pid, CLAUDE), NO_ANSWER, String(pid));
  }
  assert.equal(state.loads, 0);
});

test('a stale verdict from a table read before the lookup began is checked on a fresh table', async () => {
  let table = TABLE.filter((r) => r.pid !== 5000);
  const { resolver, state } = fakeResolver({ table: () => table });
  await resolver.resolve(4000, CLAUDE);
  assert.equal(state.loads, 1);
  // The node session started after that table was read.
  table = TABLE;
  state.t += 1000;
  assert.deepEqual(await resolver.lookup(5000, NODE), LIVE_ZED);
  assert.equal(state.loads, 2);
  // Gone from the fresh table too: stale, after exactly one more load.
  state.t += 1000;
  assert.deepEqual(await resolver.lookup(7777, '1'), STALE);
  assert.equal(state.loads, 3);
  // Within the same moment the table just read is used as it is.
  assert.deepEqual(await resolver.lookup(7778, '1'), STALE);
  assert.equal(state.loads, 3);
});

test('a failed load keeps good cache entries and is remembered as a failure for at most the ttl', async () => {
  let fail = false;
  const { resolver, state } = fakeResolver({
    table: () => {
      if (fail) throw new Error('wmi down');
      return TABLE;
    },
  });
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
  fail = true;
  state.t += 10000;
  assert.deepEqual(await resolver.lookup(4000, CLAUDE, { revalidate: true }), NO_ANSWER);
  assert.equal(state.loads, 2);
  // The good entry survives the failed load: served at once, no load.
  assert.deepEqual(await resolver.resolve(4000, CLAUDE), { name: 'Zed', ownerPid: 2000 });
  assert.equal(state.loads, 2);
  // Within the ttl the failure is reused, never read as an empty table.
  assert.deepEqual(await resolver.lookup(12345, CLAUDE), NO_ANSWER);
  assert.equal(state.loads, 2);
  // After the ttl the table is read again.
  fail = false;
  state.t += 5000;
  assert.deepEqual(await resolver.lookup(4000, CLAUDE, { revalidate: true }), LIVE_ZED);
  assert.equal(state.loads, 3);
});

test('resolve rejects invalid pids without loading anything', async () => {
  const { resolver, state } = fakeResolver();
  for (const pid of [undefined, null, '4000', 0, -4, 1.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(await resolver.resolve(pid, CLAUDE), null, String(pid));
  }
  assert.equal(state.loads, 0);
});

// --- folderNameOf ---

test('folderNameOf gives the last path segment', () => {
  const cases = {
    'C:\\Users\\jenss\\B.R.I.A.N': 'B.R.I.A.N',
    'C:\\Users\\jenss\\B.R.I.A.N\\': 'B.R.I.A.N',
    'C:/Users/jenss/Code/Huddle': 'Huddle',
    'C:/Users/jenss/Code/Huddle//': 'Huddle',
    'C:\\Users/mixed\\sep/last': 'last',
    '/home/user/project': 'project',
    '\\\\server\\share\\dir': 'dir',
    '\\\\?\\C:\\deep\\name': 'name',
    'relative': 'relative',
    'C:\\My Folder $(x) `y` "z"': 'My Folder $(x) `y` "z"',
    'C:\\caf\u00e9': 'caf\u00e9',
  };
  for (const [cwd, name] of Object.entries(cases)) {
    assert.equal(folderNameOf(cwd), name, cwd);
  }
});

test('folderNameOf gives an empty name for roots and odd input', () => {
  for (const cwd of ['C:\\', 'C:/', 'C:', 'c:\\\\', '\\\\?\\C:\\', '/', '\\', '', '.', 'C:\\x\\..', undefined, null, 42]) {
    assert.equal(folderNameOf(cwd), '', String(cwd));
  }
});
