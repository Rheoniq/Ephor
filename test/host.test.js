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

// claude.exe -> pwsh.exe -> Zed.exe -> explorer.exe, as recon showed on this machine.
const TABLE = [
  { pid: 4, ppid: 0, name: 'System' },
  { pid: 900, ppid: 4, name: 'smss.exe' },
  { pid: 1000, ppid: 900, name: 'explorer.exe' },
  { pid: 2000, ppid: 1000, name: 'Zed.exe' },
  { pid: 3000, ppid: 2000, name: 'pwsh.exe' },
  { pid: 4000, ppid: 3000, name: 'claude.exe' },
  { pid: 5000, ppid: 3000, name: 'node.exe' },
  { pid: 6000, ppid: 1000, name: 'chrome.exe' },
  { pid: 6100, ppid: 6000, name: 'chrome.exe' },
];

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
    { pid: 10, ppid: 20, name: 'a.exe' },
    { pid: 20, ppid: 31337, name: 'b.exe' },
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
  const t = [
    { pid: 10, ppid: 20, name: 'a.exe' },
    { pid: 20, ppid: 30, name: 'b.exe' },
    { pid: 30, ppid: 10, name: 'c.exe' },
  ];
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10, 20, 30]);
  const self = [{ pid: 10, ppid: 10, name: 'a.exe' }];
  assert.deepEqual(walkAncestors(self, 10).map((e) => e.pid), [10]);
});

test('walkAncestors stops at pid 0', () => {
  const t = [{ pid: 10, ppid: 0, name: 'a.exe' }, { pid: 0, ppid: 0, name: 'Idle' }];
  assert.deepEqual(walkAncestors(t, 10).map((e) => e.pid), [10]);
});

test('walkAncestors caps the depth', () => {
  const t = [];
  for (let i = 1; i <= 40; i++) t.push({ pid: i * 8, ppid: (i + 1) * 8, name: `p${i}.exe` });
  assert.equal(walkAncestors(t, 8).length, 16);
  assert.equal(walkAncestors(t, 8, 3).length, 3);
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
    { pid: 1, ppid: 0, name: 'a.exe' },
    { pid: -1, ppid: 0, name: 'neg.exe' },
    { pid: 2.5, ppid: 0, name: 'frac.exe' },
    { pid: 3, ppid: 'x', name: 'bad.exe' },
    { pid: 4, ppid: 0 },
    { pid: 5, ppid: 1, name: '' },
    null,
    'junk',
    { pid: 6, ppid: 1, name: 'b.exe', extra: 'ignored' },
  ]);
  assert.deepEqual(parseProcessTable(text), [
    { pid: 1, ppid: 0, name: 'a.exe' },
    { pid: 6, ppid: 1, name: 'b.exe' },
  ]);
});

test('parseProcessTable accepts a single object and tolerates garbage', () => {
  assert.deepEqual(parseProcessTable('{"pid":7,"ppid":1,"name":"x.exe"}'), [
    { pid: 7, ppid: 1, name: 'x.exe' },
  ]);
  for (const bad of ['', 'not json', '42', 'null', '[1,2', undefined, null, 17]) {
    assert.deepEqual(parseProcessTable(bad), [], String(bad));
  }
});

test('parseProcessTable decodes escaped unicode names', () => {
  assert.deepEqual(parseProcessTable('[{"pid":8,"ppid":1,"name":"caf\\u00e9.exe"}]'), [
    { pid: 8, ppid: 1, name: 'caf\u00e9.exe' },
  ]);
});

test('loadProcessTable passes no data and parses the output', async () => {
  const calls = [];
  const run = async (script, input, opts) => {
    calls.push({ script, input, opts });
    return { code: 0, stdout: '[{"pid":1,"ppid":0,"name":"a.exe"}]\r\n' };
  };
  assert.deepEqual(await loadProcessTable({ run }), [{ pid: 1, ppid: 0, name: 'a.exe' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, undefined);
  assert.equal(calls[0].opts.timeoutMs, 5000);
  assert.match(calls[0].script, /Get-CimInstance/);
});

test('loadProcessTable gives an empty table on any failure', async () => {
  const runs = [
    async () => null,
    async () => ({ code: 1, stdout: '[{"pid":1,"ppid":0,"name":"a.exe"}]' }),
    async () => { throw new Error('spawn failed'); },
    () => { throw new Error('sync throw'); },
  ];
  for (const run of runs) {
    assert.deepEqual(await loadProcessTable({ run }), []);
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
  assert.deepEqual(await resolver.resolve(4000, 'k1'), { name: 'Zed', ownerPid: 2000 });
  // The claude process itself is never asked for; the walk stops before explorer.
  assert.deepEqual(state.checks, [[3000, 2000]]);
});

test('five concurrent resolves share one table load', async () => {
  const { resolver, state } = fakeResolver();
  const results = await Promise.all([
    resolver.resolve(4000, 'k1'),
    resolver.resolve(4000, 'k1'),
    resolver.resolve(5000, 'k5'),
    resolver.resolve(4000, 'k2'),
    resolver.resolve(12345, 'k3'),
  ]);
  assert.equal(state.loads, 1);
  assert.deepEqual(results[0], { name: 'Zed', ownerPid: 2000 });
  assert.deepEqual(results[1], { name: 'Zed', ownerPid: 2000 });
  assert.deepEqual(results[2], { name: 'Zed', ownerPid: 2000 });
  assert.equal(results[4], null);
});

test('the table is reloaded once the ttl has passed', async () => {
  const { resolver, state } = fakeResolver({ ttlMs: 5000 });
  await resolver.resolve(4000, 'k1');
  state.t += 4999;
  await resolver.resolve(4000, 'k1');
  assert.equal(state.loads, 1);
  state.t += 1;
  await resolver.resolve(4000, 'k1');
  assert.equal(state.loads, 2);
});

test('a cached owner is served without a new window check', async () => {
  const { resolver, state } = fakeResolver();
  await resolver.resolve(4000, 'k1');
  state.t += 10000;
  assert.deepEqual(await resolver.resolve(4000, 'k1'), { name: 'Zed', ownerPid: 2000 });
  assert.equal(state.checks.length, 1);
});

test('a reused pid with a different startKey is not served from the cache', async () => {
  let table = TABLE;
  let windows = [2000];
  const { resolver, state } = fakeResolver({ table: () => table, windows: () => windows });
  assert.deepEqual(await resolver.resolve(4000, 'old'), { name: 'Zed', ownerPid: 2000 });
  // pid 4000 now belongs to a new claude under VS Code.
  table = [
    { pid: 7000, ppid: 1000, name: 'Code.exe' },
    { pid: 7100, ppid: 7000, name: 'pwsh.exe' },
    { pid: 4000, ppid: 7100, name: 'claude.exe' },
    { pid: 1000, ppid: 4, name: 'explorer.exe' },
  ];
  windows = [7000];
  state.t += 10000;
  assert.deepEqual(await resolver.resolve(4000, 'new'), { name: 'VS Code', ownerPid: 7000 });
  assert.equal(state.checks.length, 2);
});

test('a cached owner that is no longer in the chain is looked up again', async () => {
  let table = TABLE;
  let windows = [2000];
  const { resolver, state } = fakeResolver({ table: () => table, windows: () => windows });
  await resolver.resolve(4000, 'k1');
  // Same key, but the parent chain changed (the old host is gone).
  table = [
    { pid: 4000, ppid: 3000, name: 'claude.exe' },
    { pid: 3000, ppid: 8000, name: 'pwsh.exe' },
  ];
  windows = [];
  state.t += 10000;
  assert.equal(await resolver.resolve(4000, 'k1'), null);
  assert.equal(state.checks.length, 2);
});

test('a dead pid gives null', async () => {
  const { resolver, state } = fakeResolver();
  assert.equal(await resolver.resolve(12345, 'k'), null);
  assert.equal(state.checks.length, 0);
});

test('a pid that is not a claude or node process gives null (pid reuse)', async () => {
  const { resolver, state } = fakeResolver({ windows: [6000] });
  // 6100 is a chrome child whose parent owns windows: never a host.
  assert.equal(await resolver.resolve(6100, 'k'), null);
  assert.equal(state.checks.length, 0);
});

test('claude and node ancestors are skipped as owners', async () => {
  const table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe' },
    { pid: 2000, ppid: 1000, name: 'WindowsTerminal.exe' },
    { pid: 2100, ppid: 2000, name: 'node.exe' },
    { pid: 2200, ppid: 2100, name: 'Claude.exe' },
    { pid: 2300, ppid: 2200, name: 'cmd.exe' },
    { pid: 2400, ppid: 2300, name: 'claude.exe' },
  ];
  // Every process "owns" a window: only the terminal may win.
  const { resolver, state } = fakeResolver({ table, windows: [2000, 2100, 2200, 2300, 2400] });
  assert.deepEqual(await resolver.resolve(2400, 'k'), { name: 'Terminal', ownerPid: 2300 });
  assert.deepEqual(state.checks, [[2300, 2000]]);
});

test('the walk never reaches past explorer to a random window', async () => {
  const table = [
    { pid: 1000, ppid: 4, name: 'explorer.exe' },
    { pid: 4000, ppid: 1000, name: 'claude.exe' },
  ];
  const { resolver, state } = fakeResolver({ table, windows: [1000] });
  assert.equal(await resolver.resolve(4000, 'k'), null);
  assert.equal(state.checks.length, 0);
});

test('no ancestor with a window gives null and is retried after the ttl', async () => {
  let windows = [];
  const { resolver, state } = fakeResolver({ windows: () => windows });
  assert.equal(await resolver.resolve(4000, 'k'), null);
  assert.equal(await resolver.resolve(4000, 'k'), null);
  assert.equal(state.checks.length, 1);
  windows = [2000];
  state.t += 5000;
  assert.deepEqual(await resolver.resolve(4000, 'k'), { name: 'Zed', ownerPid: 2000 });
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
    assert.equal(await resolver.resolve(4000, 'k'), null);
  }
});

test('an owner listed with no windows does not count', async () => {
  const resolver = createHostResolver({
    loadTable: async () => TABLE,
    hasVisibleWindow: async () => new Map([[3000, []], [2000, [{ hwnd: '1', title: 'x' }]]]),
    now: () => 0,
  });
  assert.deepEqual(await resolver.resolve(4000, 'k'), { name: 'Zed', ownerPid: 2000 });
});

test('resolve rejects invalid pids without loading anything', async () => {
  const { resolver, state } = fakeResolver();
  for (const pid of [undefined, null, '4000', 0, -4, 1.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(await resolver.resolve(pid, 'k'), null, String(pid));
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
