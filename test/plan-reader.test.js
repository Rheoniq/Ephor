'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPlanReader } = require('../src/main/plan-reader');

const PLAN = 'mcp__ccd_turn__update_plan';

let n = 0;
function toolLine(name, input, type = 'assistant') {
  n += 1;
  return JSON.stringify({
    type,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name, input }] },
  });
}
const plan = (input) => toolLine(PLAN, input);
const bash = (command) => toolLine('Bash', { command });
const pwsh = (command) => toolLine('PowerShell', { command });
const filler = (i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `filler line number ${i} ` + 'z'.repeat(60) } });

function items(count, active = 0) {
  return Array.from({ length: count }, (_, i) => ({
    content: `Step ${i + 1}`,
    status: i < active ? 'completed' : i === active ? 'in_progress' : 'pending',
  }));
}

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-plan-'));
  file = path.join(dir, 't.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function append(lines) {
  fs.appendFileSync(file, lines.join('\n') + '\n');
  // Make sure the mtime moves even on coarse clocks.
  const t = new Date(Date.now() + 5000 + n);
  fs.utimesSync(file, t, t);
}

function statuses(r) {
  return r.items.map((i) => i.status);
}

test('reads the latest items call across many small chunks and replays later updates', () => {
  const lines = [plan({ items: items(2) })];
  for (let i = 0; i < 20; i++) lines.push(filler(i));
  lines.push(plan({ items: items(4) }));
  for (let i = 0; i < 20; i++) lines.push(filler(100 + i));
  lines.push(plan({ advance: true }));
  lines.push(bash('npm test'));
  lines.push(filler(999));
  lines.push(plan({ done: [2], start: 3 }));
  write(lines);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.equal(r.items.length, 4);
  assert.deepEqual(statuses(r), ['completed', 'completed', 'in_progress', 'pending']);
  assert.equal(r.lastCommand, 'npm test');
});

test('a plan call larger than a chunk is parsed whole', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ content: `Item ${i} ` + 'q'.repeat(150), status: 'pending' }));
  write([filler(1), plan({ items: big }), filler(2)]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.equal(r.items.length, 30);
  assert.ok(r.items[0].content.startsWith('Item 0 '));
  assert.equal(r.lastCommand, null);
});

test('ignores a corrupt line and an unterminated last line', () => {
  const lines = [plan({ items: items(3) }), 'not json {"type":"tool_use"', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"', plan({ advance: true })];
  fs.writeFileSync(file, lines.join('\n') + '\n' + plan({ advance: true }).slice(0, 40));
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['completed', 'in_progress', 'pending']);
  assert.equal(r.lastCommand, null);
});

test('ignores tool calls that are not in assistant events', () => {
  write([plan({ items: items(3) }), toolLine(PLAN, { advance: true }, 'api-request-blob'), toolLine('Bash', { command: 'blob' }, 'api-request-blob')]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['in_progress', 'pending', 'pending']);
  assert.equal(r.lastCommand, null);
});

test('returns the latest Bash or PowerShell command as one line cut to 160 chars', () => {
  write([bash('old'), pwsh('Get-ChildItem\n   -Force\t x')]);
  assert.equal(createPlanReader().read(file).lastCommand, 'Get-ChildItem -Force x');
  write([bash('echo ' + 'a'.repeat(400))]);
  const c = createPlanReader().read(file).lastCommand;
  assert.equal(c.length, 160);
  assert.ok(c.endsWith('…'));
  assert.equal(createPlanReader().read(file).items, null);
});

test('stops at maxScanBytes: an items call beyond it is not found', () => {
  const lines = [plan({ items: items(3) })];
  for (let i = 0; i < 60; i++) lines.push(filler(i));
  lines.push(plan({ advance: true }));
  lines.push(bash('ls'));
  write(lines);
  const r = createPlanReader({ chunkBytes: 200, maxScanBytes: 1000 }).read(file);
  assert.equal(r.items, null);
  assert.equal(r.lastCommand, 'ls');
  const full = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(full), ['completed', 'in_progress', 'pending']);
});

test('stops scanning once both the items call and a command are found', () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(filler(i));
  lines.push(plan({ items: items(2) }), bash('x'));
  write(lines);
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...args) { const r = orig.apply(this, args); bytes += r; return r; };
  try {
    const r = createPlanReader({ chunkBytes: 200 }).read(file);
    assert.equal(r.lastCommand, 'x');
  } finally {
    fs.readSync = orig;
  }
  assert.ok(bytes < 2000, `read ${bytes} bytes`);
});

test('an unchanged file returns the cached result without reading', () => {
  write([plan({ items: items(2) }), bash('a')]);
  const reader = createPlanReader({ chunkBytes: 200 });
  const first = reader.read(file);
  const orig = fs.readSync;
  let calls = 0;
  fs.readSync = function (...args) { calls += 1; return orig.apply(this, args); };
  try {
    const second = reader.read(file);
    assert.deepEqual(second, first);
  } finally {
    fs.readSync = orig;
  }
  assert.equal(calls, 0);
});

test('a grown file picks up appended updates and commands', () => {
  const lines = [plan({ items: items(3) })];
  for (let i = 0; i < 30; i++) lines.push(filler(i));
  lines.push(bash('first'));
  write(lines);
  const reader = createPlanReader({ chunkBytes: 200 });
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending', 'pending']);

  append([plan({ advance: true }), pwsh('second')]);
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...args) { const r = orig.apply(this, args); bytes += r; return r; };
  let r;
  try {
    r = reader.read(file);
  } finally {
    fs.readSync = orig;
  }
  assert.deepEqual(statuses(r), ['completed', 'in_progress', 'pending']);
  assert.equal(r.lastCommand, 'second');
  assert.ok(bytes < 1000, `re-read ${bytes} bytes`);

  append([plan({ items: items(1) })]);
  assert.deepEqual(statuses(reader.read(file)), ['in_progress']);
});

test('a line completed by a later append is read once it is whole', () => {
  const advance = plan({ advance: true });
  fs.writeFileSync(file, plan({ items: items(3) }) + '\n' + advance.slice(0, 30));
  const reader = createPlanReader({ chunkBytes: 200 });
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending', 'pending']);
  fs.appendFileSync(file, advance.slice(30) + '\n');
  const t = new Date(Date.now() + 9000);
  fs.utimesSync(file, t, t);
  assert.deepEqual(statuses(reader.read(file)), ['completed', 'in_progress', 'pending']);
});

test('a shrunk file is read again from scratch', () => {
  write([plan({ items: items(3) }), plan({ advance: true }), bash('a'), filler(1), filler(2)]);
  const reader = createPlanReader({ chunkBytes: 200 });
  reader.read(file);
  write([plan({ items: items(2, 1) })]);
  const r = reader.read(file);
  assert.deepEqual(statuses(r), ['completed', 'in_progress']);
  assert.equal(r.lastCommand, null);
});

test('keeps the last good result when the file disappears', () => {
  write([plan({ items: items(2) }), bash('kept')]);
  const reader = createPlanReader();
  const first = reader.read(file);
  fs.rmSync(file);
  assert.deepEqual(reader.read(file), first);
});

test('a missing file with no history returns nulls and never throws', () => {
  const reader = createPlanReader();
  assert.deepEqual(reader.read(path.join(dir, 'nope.jsonl')), { items: null, lastCommand: null });
  assert.deepEqual(reader.read(dir), { items: null, lastCommand: null });
  assert.deepEqual(reader.read(undefined), { items: null, lastCommand: null });
});

test('an empty file returns nulls', () => {
  fs.writeFileSync(file, '');
  assert.deepEqual(createPlanReader().read(file), { items: null, lastCommand: null });
});
