'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  focusWindowOf,
  windowsOf,
  chooseWindow,
  runPowerShell,
  asciiJson,
  parseWindowList,
  POWERSHELL_EXE,
} = require('../src/main/focus');

const SCRIPT_ON_DISK = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'focus-window.ps1'), 'utf8');

function fakeRun(result) {
  const calls = [];
  const run = async (script, input, opts) => {
    calls.push({ script, input, opts });
    return typeof result === 'function' ? result() : result;
  };
  return { run, calls };
}

// A runner that answers the list call with `windows` and the focus call with `focus`.
function fakeHost({ windows = [{ pid: 2000, hwnd: '111', title: 'B.R.I.A.N - AGENTS.md', normal: true }], focus = { code: 0, stdout: '' } } = {}) {
  const calls = [];
  const run = async (script, input, opts) => {
    calls.push({ script, input, opts });
    if (input && input.mode === 'list') {
      return typeof windows === 'function' ? windows() : { code: 0, stdout: JSON.stringify(windows) };
    }
    return typeof focus === 'function' ? focus() : focus;
  };
  return { run, calls };
}

function win(hwnd, title, normal = true) {
  return { hwnd, title, normal };
}

// --- chooseWindow ---

test('chooseWindow prefers a whole-name match over a longer folder name', () => {
  const wins = [
    win('1', 'Huddle-terminal - focus.js'),
    win('2', 'Old-Huddle - notes.md'),
    win('3', 'Huddle - README.md'),
  ];
  assert.equal(chooseWindow(wins, 'Huddle'), '3');
  assert.equal(chooseWindow(wins, 'Huddle-terminal'), '1');
  assert.equal(chooseWindow(wins, 'Old-Huddle'), '2');
});

test('chooseWindow accepts the documented right boundaries', () => {
  const rights = ['', ' x', '\t', ' \u2014 a', '\u2014a', '\u2013a', '|a', ':a', '[a]', ']', '(a)', ')'];
  for (const r of rights) {
    const wins = [win('1', 'Huddle-terminal'), win('2', `Huddle${r}`)];
    assert.equal(chooseWindow(wins, 'Huddle'), '2', JSON.stringify(r));
  }
});

test('chooseWindow needs a boundary on the left too', () => {
  const wins = [win('1', 'MyHuddle - a'), win('2', 'file.js - Huddle - Visual Studio Code')];
  assert.equal(chooseWindow(wins, 'Huddle'), '2');
  const paths = [win('1', 'xHuddle'), win('2', 'C:\\Code\\Huddle')];
  assert.equal(chooseWindow(paths, 'Huddle'), '2');
  const brackets = [win('1', 'aHuddle]'), win('2', 'repo [Huddle] - x')];
  assert.equal(chooseWindow(brackets, 'Huddle'), '2');
});

test('chooseWindow ignores case, also for non-ASCII names', () => {
  const wins = [win('1', 'other'), win('2', 'CAF\u00c9 \u2014 menu.md')];
  assert.equal(chooseWindow(wins, 'caf\u00e9'), '2');
  const greek = [win('1', 'x'), win('2', '\u03a3\u03a4\u039f\u0391 - a')];
  assert.equal(chooseWindow(greek, '\u03c3\u03c4\u03bf\u03b1'), '2');
});

test('chooseWindow treats a letter next to a non-ASCII name as no boundary', () => {
  const wins = [win('1', '\u00e9caf\u00e9 - a'), win('2', 'caf\u00e9 - b')];
  assert.equal(chooseWindow(wins, 'caf\u00e9'), '2');
});

test('chooseWindow falls back to a plain substring, then to the first window', () => {
  const sub = [win('1', 'a'), win('2', 'Huddle-terminal - x'), win('3', 'Old-Huddle-2')];
  assert.equal(chooseWindow(sub, 'huddle'), '2');
  const none = [win('7', 'first'), win('8', 'second')];
  assert.equal(chooseWindow(none, 'Huddle'), '7');
});

test('chooseWindow with an empty folder name takes the first window', () => {
  const wins = [win('7', 'first'), win('8', 'second')];
  assert.equal(chooseWindow(wins, ''), '7');
  assert.equal(chooseWindow(wins, undefined), '7');
});

test('chooseWindow with several windows of the same folder takes the topmost', () => {
  const wins = [win('5', 'Huddle - a.js'), win('6', 'Huddle - b.js')];
  assert.equal(chooseWindow(wins, 'Huddle'), '5');
});

test('chooseWindow prefers normal windows and falls back to the rest', () => {
  const mixed = [
    win('1', 'Huddle - tool palette', false),
    win('2', 'Huddle - on another desktop', false),
    win('3', 'Settings', true),
  ];
  // A matching tool, owned or cloaked window loses to any normal window.
  assert.equal(chooseWindow(mixed, 'Huddle'), '3');
  const onlyOther = [win('1', 'Palette', false), win('2', 'Huddle - x', false)];
  assert.equal(chooseWindow(onlyOther, 'Huddle'), '2');
  assert.equal(chooseWindow(onlyOther, ''), '1');
  const normals = [win('1', 'a', false), win('2', 'b', true), win('3', 'Huddle', true)];
  assert.equal(chooseWindow(normals, 'Huddle'), '3');
  assert.equal(chooseWindow(normals, 'zzz'), '2');
});

test('chooseWindow handles odd input', () => {
  assert.equal(chooseWindow([], 'x'), null);
  assert.equal(chooseWindow(undefined, 'x'), null);
  assert.equal(chooseWindow([null, { hwnd: 'x1', title: 'a' }, { hwnd: '1' }], 'x'), null);
  assert.equal(chooseWindow([{ hwnd: '9', title: 'a.b' }], '.'), '9');
  assert.equal(chooseWindow([win('1', 'a'), win('2', '$(x) [y]')], '$(x)'), '2');
});

// --- focusWindowOf ---

test('focusWindowOf rejects bad pids without spawning', async () => {
  const bad = [undefined, null, '2000', 0, -1, -2000, 1.5, NaN, Infinity, 2 ** 32, 2 ** 53, 1e20, {}, [2000]];
  for (const ownerPid of bad) {
    const { run, calls } = fakeHost();
    assert.equal(await focusWindowOf({ ownerPid, folderName: 'x' }, { run }), 'failed', String(ownerPid));
    assert.equal(calls.length, 0);
  }
  const { run, calls } = fakeHost();
  assert.equal(await focusWindowOf(undefined, { run }), 'failed');
  assert.equal(await focusWindowOf(null, { run }), 'failed');
  assert.equal(calls.length, 0);
});

test('focusWindowOf rejects a non-string or overlong folder name without spawning', async () => {
  for (const folderName of [42, {}, ['a'], 'x'.repeat(261)]) {
    const { run, calls } = fakeHost();
    assert.equal(await focusWindowOf({ ownerPid: 2000, folderName }, { run }), 'failed');
    assert.equal(calls.length, 0);
  }
});

test('focusWindowOf lists, chooses in JS and focuses only the chosen hwnd', async () => {
  const folderName = 'Huddle';
  const { run, calls } = fakeHost({
    windows: [
      { pid: 2000, hwnd: '111', title: 'Huddle-terminal - a', normal: true },
      { pid: 2000, hwnd: '222', title: 'Huddle - b', normal: true },
    ],
  });
  assert.equal(await focusWindowOf({ ownerPid: 2000, folderName }, { run }), 'focused');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].input, { mode: 'list', pids: [2000] });
  assert.deepEqual(calls[1].input, { mode: 'focus', ownerPid: 2000, hwnd: '222' });
  assert.equal(calls[1].opts.timeoutMs, 8000);
  for (const c of calls) assert.equal(c.script, SCRIPT_ON_DISK);
});

test('focusWindowOf never sends the folder name to the script', async () => {
  const folderName = 'a "b" $(Remove-Item x) `c` \'d\' caf\u00e9';
  const { run, calls } = fakeHost();
  assert.equal(await focusWindowOf({ ownerPid: 2000, folderName }, { run }), 'focused');
  for (const c of calls) {
    assert.ok(!JSON.stringify(c.input).includes('Remove-Item'));
    assert.ok(!c.script.includes('Remove-Item x'));
  }
});

test('focusWindowOf gives not-found when the process has no window', async () => {
  const { run, calls } = fakeHost({ windows: [] });
  assert.equal(await focusWindowOf({ ownerPid: 2000, folderName: 'x' }, { run }), 'not-found');
  assert.equal(calls.length, 1);
  const other = fakeHost({ windows: [{ pid: 3000, hwnd: '5', title: 'x', normal: true }] });
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: other.run }), 'not-found');
  assert.equal(other.calls.length, 1);
});

test('focusWindowOf gives failed when the window list fails', async () => {
  for (const windows of [() => null, () => ({ code: 1, stdout: '' }), () => ({ code: 0, stdout: 'garbage' })]) {
    const { run, calls } = fakeHost({ windows });
    assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run }), 'failed');
    assert.equal(calls.length, 1);
  }
});

test('focusWindowOf maps exit codes of the focus call to results', async () => {
  const cases = [
    [{ code: 0, stdout: '' }, 'focused'],
    [{ code: 2, stdout: '' }, 'not-found'],
    [{ code: 1, stdout: '' }, 'failed'],
    [{ code: 3, stdout: '' }, 'failed'],
    [null, 'failed'],
    [undefined, 'failed'],
    ['junk', 'failed'],
  ];
  for (const [focus, expected] of cases) {
    const { run } = fakeHost({ focus: () => focus });
    assert.equal(await focusWindowOf({ ownerPid: 2000, folderName: 'x' }, { run }), expected);
  }
});

test('focusWindowOf never throws when the runner throws', async () => {
  const asyncThrow = async () => { throw new Error('boom'); };
  const syncThrow = () => { throw new Error('boom'); };
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: asyncThrow }), 'failed');
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: syncThrow }), 'failed');
  const focusThrows = fakeHost({ focus: () => { throw new Error('boom'); } });
  assert.equal(await focusWindowOf({ ownerPid: 2000 }, { run: focusThrows.run }), 'failed');
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
    { pid: 2000, hwnd: '111', title: 'B.R.I.A.N - AGENTS.md', normal: true },
    { pid: 3000, hwnd: '222', title: 'other', normal: false },
    { pid: 2000, hwnd: '333', title: 'Huddle - x' },
  ]);
  const { run } = fakeRun({ code: 0, stdout });
  const out = await windowsOf([2000, 3000], { run });
  assert.deepEqual(out.get(2000), [
    { hwnd: '111', title: 'B.R.I.A.N - AGENTS.md', normal: true },
    { hwnd: '333', title: 'Huddle - x', normal: false },
  ]);
  assert.deepEqual(out.get(3000), [{ hwnd: '222', title: 'other', normal: false }]);
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
    { pid: 2000, hwnd: '111', title: 'ok', normal: true },
    { pid: 9999, hwnd: '112', title: 'not asked' },
    { pid: 2000, hwnd: '0x1', title: 'bad hwnd' },
    { pid: 2000, hwnd: 113, title: 'number hwnd' },
    { pid: 2000, hwnd: '114' },
    { pid: 2000, hwnd: '115', title: '' },
    { pid: 2000, hwnd: '1'.repeat(21), title: 'long hwnd' },
    null,
    { pid: 2000, hwnd: '116', title: 't'.repeat(600), normal: 'yes' },
  ]);
  const out = parseWindowList(text, [2000]);
  assert.deepEqual(out.get(2000).map((w) => w.hwnd), ['111', '116']);
  assert.equal(out.get(2000)[1].title.length, 512);
  assert.equal(out.get(2000)[1].normal, false);
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
  const input = { mode: 'focus', ownerPid: 2000, hwnd: '111', note: '$(calc) "x" `y` caf\u00e9 \ud83d\ude00' };
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
  const encoded = Buffer.from(SCRIPT_ON_DISK, 'utf16le').toString('base64');
  assert.ok(encoded.length < 30000, String(encoded.length));
});
