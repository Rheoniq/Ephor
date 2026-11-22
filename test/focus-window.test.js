'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  focusWindowOf,
  windowsOf,
  runPowerShell,
  asciiJson,
  parseWindowList,
  POWERSHELL_EXE,
} = require('../src/main/focus');

function fakeRun(result) {
  const calls = [];
  const run = async (script, input, opts) => {
    calls.push({ script, input, opts });
    return typeof result === 'function' ? result() : result;
  };
  return { run, calls };
}

// --- focusWindowOf ---

test('focusWindowOf rejects bad pids without spawning', async () => {
  const bad = [undefined, null, '2000', 0, -1, -2000, 1.5, NaN, Infinity, 2 ** 32, 2 ** 53, 1e20, {}, [2000]];
  for (const ownerPid of bad) {
    const { run, calls } = fakeRun({ code: 0, stdout: '' });
    assert.equal(await focusWindowOf({ ownerPid, folderName: 'x' }, { run }), 'failed', String(ownerPid));
    assert.equal(calls.length, 0);
  }
  const { run, calls } = fakeRun({ code: 0, stdout: '' });
  assert.equal(await focusWindowOf(undefined, { run }), 'failed');
  assert.equal(await focusWindowOf(null, { run }), 'failed');
  assert.equal(calls.length, 0);
});

test('focusWindowOf rejects a non-string or overlong folder name without spawning', async () => {
  for (const folderName of [42, {}, ['a'], 'x'.repeat(261)]) {
    const { run, calls } = fakeRun({ code: 0, stdout: '' });
    assert.equal(await focusWindowOf({ ownerPid: 2000, folderName }, { run }), 'failed');
    assert.equal(calls.length, 0);
  }
});

test('focusWindowOf passes pid and folder name only as data', async () => {
  const folderName = 'a "b" $(Remove-Item x) `c` \'d\' caf\u00e9';
  const { run, calls } = fakeRun({ code: 0, stdout: '' });
  assert.equal(await focusWindowOf({ ownerPid: 2000, folderName }, { run }), 'focused');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { mode: 'focus', ownerPid: 2000, folderName });
  assert.equal(calls[0].opts.timeoutMs, 8000);
  // The script text is the fixed file, never built from the data.
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'focus-window.ps1'), 'utf8');
  assert.equal(calls[0].script, onDisk);
  assert.ok(!calls[0].script.includes('Remove-Item x'));
});

test('focusWindowOf treats a missing folder name as empty', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: '' });
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run }), 'focused');
  assert.equal(calls[0].input.folderName, '');
});

test('focusWindowOf maps exit codes to results', async () => {
  const cases = [
    [{ code: 0, stdout: '' }, 'focused'],
    [{ code: 2, stdout: '' }, 'not-found'],
    [{ code: 1, stdout: '' }, 'failed'],
    [{ code: 3, stdout: '' }, 'failed'],
    [null, 'failed'],
    [undefined, 'failed'],
    ['junk', 'failed'],
  ];
  for (const [result, expected] of cases) {
    const { run } = fakeRun(result);
    assert.equal(await focusWindowOf({ ownerPid: 2000, folderName: 'x' }, { run }), expected);
  }
});

test('focusWindowOf never throws when the runner throws', async () => {
  const asyncThrow = async () => { throw new Error('boom'); };
  const syncThrow = () => { throw new Error('boom'); };
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: asyncThrow }), 'failed');
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: syncThrow }), 'failed');
});

// --- windowsOf ---

test('windowsOf sends only valid pids, once, as data', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: '[]' });
  await windowsOf([2000, 2000, 3000, -1, '4', 1.5, 2 ** 40], { run });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { mode: 'list', pids: [2000, 3000] });
  assert.equal(calls[0].opts.timeoutMs, 5000);
});

test('windowsOf skips the call when no pid is valid', async () => {
  const { run, calls } = fakeRun({ code: 0, stdout: '[]' });
  for (const pids of [[], [-1, 0], undefined, null, 'x']) {
    const out = await windowsOf(pids, { run });
    assert.ok(out instanceof Map);
    assert.equal(out.size, 0);
  }
  assert.equal(calls.length, 0);
});

test('windowsOf groups windows by pid in script order', async () => {
  const stdout = JSON.stringify([
    { pid: 2000, hwnd: '111', title: 'B.R.I.A.N - AGENTS.md' },
    { pid: 3000, hwnd: '222', title: 'other' },
    { pid: 2000, hwnd: '333', title: 'Huddle - x' },
  ]);
  const { run } = fakeRun({ code: 0, stdout });
  const out = await windowsOf([2000, 3000], { run });
  assert.deepEqual(out.get(2000), [
    { hwnd: '111', title: 'B.R.I.A.N - AGENTS.md' },
    { hwnd: '333', title: 'Huddle - x' },
  ]);
  assert.deepEqual(out.get(3000), [{ hwnd: '222', title: 'other' }]);
});

test('windowsOf gives an empty map on failure', async () => {
  const results = [null, { code: 1, stdout: '[{"pid":2000,"hwnd":"1","title":"x"}]' }, { code: 0, stdout: 'garbage' }];
  for (const r of results) {
    const { run } = fakeRun(r);
    const out = await windowsOf([2000], { run });
    assert.equal(out.size, 0);
  }
  const out = await windowsOf([2000], { run: async () => { throw new Error('x'); } });
  assert.equal(out.size, 0);
});

test('parseWindowList keeps only well-formed rows for asked pids', () => {
  const text = JSON.stringify([
    { pid: 2000, hwnd: '111', title: 'ok' },
    { pid: 9999, hwnd: '112', title: 'not asked' },
    { pid: 2000, hwnd: '0x1', title: 'bad hwnd' },
    { pid: 2000, hwnd: 113, title: 'number hwnd' },
    { pid: 2000, hwnd: '114' },
    { pid: 2000, hwnd: '115', title: '' },
    null,
    { pid: 2000, hwnd: '116', title: 't'.repeat(600) },
  ]);
  const out = parseWindowList(text, [2000]);
  assert.deepEqual(out.get(2000).map((w) => w.hwnd), ['111', '116']);
  assert.equal(out.get(2000)[1].title.length, 512);
  assert.equal(out.has(9999), false);
  assert.equal(parseWindowList('{"pid":2000,"hwnd":"5","title":"one"}', [2000]).get(2000)[0].hwnd, '5');
  for (const bad of ['', 'nope', 'null', '7', undefined]) {
    assert.equal(parseWindowList(bad, [2000]).size, 0);
  }
});

// --- runPowerShell and the data channel ---

function fakeExecFile({ exitCode = 0, stdout = '', hang = false, throwSync = false, killed = false } = {}) {
  const seen = { file: null, args: null, opts: null, stdin: null };
  const execFile = (file, args, opts, cb) => {
    if (throwSync) throw new Error('spawn EPERM');
    seen.file = file;
    seen.args = args;
    seen.opts = opts;
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      seen.stdin = data === undefined ? '' : data;
      if (hang) return;
      setImmediate(() => {
        if (killed) {
          const err = new Error('killed');
          err.killed = true;
          err.signal = 'SIGTERM';
          err.code = null;
          cb(err, '', '');
        } else if (exitCode === 0) {
          cb(null, stdout, '');
        } else {
          const err = new Error('exit');
          err.code = exitCode;
          cb(err, stdout, '');
        }
      });
    };
    return child;
  };
  return { execFile, seen };
}

test('runPowerShell runs the absolute powershell with fixed arguments and data on stdin', async () => {
  const { execFile, seen } = fakeExecFile({ exitCode: 2, stdout: 'out' });
  const input = { mode: 'focus', ownerPid: 2000, folderName: '$(calc) "x" `y` caf\u00e9 \ud83d\ude00' };
  const res = await runPowerShell('Write-Output 1', input, { timeoutMs: 1000, execFile });
  assert.deepEqual(res, { code: 2, stdout: 'out' });
  assert.equal(seen.file, POWERSHELL_EXE);
  assert.ok(path.isAbsolute(seen.file));
  const encoded = Buffer.from('Write-Output 1', 'utf16le').toString('base64');
  assert.deepEqual(seen.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  assert.equal(seen.opts.windowsHide, true);
  assert.equal(seen.opts.timeout, 1000);
  // Data reaches the child only on stdin, as plain ASCII JSON.
  assert.ok(!seen.args.join(' ').includes('calc'));
  assert.match(seen.stdin, /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(seen.stdin), input);
});

test('runPowerShell closes stdin even without data', async () => {
  const { execFile, seen } = fakeExecFile({ stdout: 'x' });
  assert.deepEqual(await runPowerShell('1', undefined, { timeoutMs: 1000, execFile }), { code: 0, stdout: 'x' });
  assert.equal(seen.stdin, '');
});

test('runPowerShell resolves null on a hang, a kill or a spawn error', async () => {
  const hang = fakeExecFile({ hang: true });
  assert.equal(await runPowerShell('1', {}, { timeoutMs: 20, execFile: hang.execFile }), null);
  const killed = fakeExecFile({ killed: true });
  assert.equal(await runPowerShell('1', {}, { timeoutMs: 1000, execFile: killed.execFile }), null);
  const thrown = fakeExecFile({ throwSync: true });
  assert.equal(await runPowerShell('1', {}, { timeoutMs: 1000, execFile: thrown.execFile }), null);
});

test('asciiJson escapes every non-ASCII character', () => {
  const s = asciiJson({ a: 'caf\u00e9 \ud83d\ude00 \u202e \u007f' });
  assert.match(s, /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(s), { a: 'caf\u00e9 \ud83d\ude00 \u202e \u007f' });
});

test('the focus script fits on a command line', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'focus-window.ps1'), 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  assert.ok(encoded.length < 30000, String(encoded.length));
});
