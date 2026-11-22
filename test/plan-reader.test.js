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
});

test('a plan call larger than a chunk is parsed whole', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ content: `Item ${i} ` + 'q'.repeat(150), status: 'pending' }));
  write([filler(1), plan({ items: big }), filler(2)]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.equal(r.items.length, 30);
  assert.ok(r.items[0].content.startsWith('Item 0 '));
});

test('ignores a corrupt line and an unterminated last line', () => {
  const lines = [plan({ items: items(3) }), 'not json {"type":"tool_use"', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"', plan({ advance: true })];
  fs.writeFileSync(file, lines.join('\n') + '\n' + plan({ advance: true }).slice(0, 40));
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['completed', 'in_progress', 'pending']);
});

test('ignores tool calls that are not in assistant events', () => {
  write([plan({ items: items(3) }), toolLine(PLAN, { advance: true }, 'api-request-blob'), toolLine('Bash', { command: 'blob' }, 'api-request-blob')]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['in_progress', 'pending', 'pending']);
});

test('the result carries only the plan items, never a command', () => {
  write([plan({ items: items(2) }), bash('old'), pwsh('Get-ChildItem -Force x')]);
  const r = createPlanReader().read(file);
  assert.deepEqual(Object.keys(r), ['items']);
  assert.deepEqual(statuses(r), ['in_progress', 'pending']);
  write([bash('echo ' + 'a'.repeat(400))]);
  assert.deepEqual(createPlanReader().read(file), { items: null });
});

test('plan item text shows hidden characters as ? and never cuts an emoji in half', () => {
  write([plan({ items: [{ content: 'rm ‮#txt.exe‬ \u001B[2K​', status: 'in_progress' }] })]);
  assert.equal(createPlanReader().read(file).items[0].content, 'rm ?#txt.exe? ?[2K?');
  write([plan({ items: [{ content: 'a'.repeat(198) + '\u{1F600}' + 'tail', status: 'pending' }] })]);
  const c = createPlanReader().read(file).items[0].content;
  assert.ok(c.isWellFormed(), 'no lone surrogate');
});

test('stops at maxScanBytes: an items call beyond it is not found', () => {
  const lines = [plan({ items: items(3) })];
  for (let i = 0; i < 60; i++) lines.push(filler(i));
  lines.push(plan({ advance: true }));
  lines.push(bash('ls'));
  write(lines);
  const r = createPlanReader({ chunkBytes: 200, maxScanBytes: 1000 }).read(file);
  assert.equal(r.items, null);
  const full = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(full), ['completed', 'in_progress', 'pending']);
});

test('stops scanning as soon as the latest items call is found', () => {
  const lines = [bash('long ago')];
  for (let i = 0; i < 200; i++) lines.push(filler(i));
  lines.push(plan({ items: items(2) }), plan({ advance: true }));
  write(lines);
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...args) { const r = orig.apply(this, args); bytes += r; return r; };
  let r;
  try {
    r = createPlanReader({ chunkBytes: 200 }).read(file);
  } finally {
    fs.readSync = orig;
  }
  assert.deepEqual(statuses(r), ['completed', 'in_progress']);
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

test('a grown file picks up appended updates', () => {
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
  assert.deepEqual(reader.read(path.join(dir, 'nope.jsonl')), { items: null });
  assert.deepEqual(reader.read(dir), { items: null });
  assert.deepEqual(reader.read(undefined), { items: null });
});

// Fixed-id plan line, so two lines with equally long content have equal length.
function fixedPlan(word) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixed', name: PLAN, input: { items: [{ content: `${word} 1`, status: 'in_progress' }] } }] },
  });
}

function setMtime(ms) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

test('a file truncated and regrown larger with new content is read again from scratch', () => {
  write([plan({ items: items(3) }), bash('a')]);
  setMtime(Date.now() - 60000);
  const reader = createPlanReader({ chunkBytes: 200 });
  reader.read(file);
  const long = [{ content: 'Rewritten ' + 'w'.repeat(180), status: 'in_progress' }];
  write([plan({ items: long }), plan({ items: long }), bash('b')]);
  setMtime(Date.now());
  const r = reader.read(file);
  assert.equal(r.items.length, 1);
  assert.ok(r.items[0].content.startsWith('Rewritten '));
});

test('a grown file whose mtime went back is read again from scratch', () => {
  const now = Date.now();
  write([fixedPlan('Old')]);
  setMtime(now);
  const reader = createPlanReader({ chunkBytes: 200 });
  assert.equal(reader.read(file).items[0].content, 'Old 1');
  // Same first-line length, so the byte before the old resume offset is
  // still a newline; only the mtime shows the rewrite.
  write([fixedPlan('New'), bash('c')]);
  setMtime(now - 60000);
  const r = reader.read(file);
  assert.equal(r.items[0].content, 'New 1');
});

test('a same-size file with a different mtime is read again', () => {
  write([fixedPlan('Old')]);
  setMtime(Date.now() - 60000);
  const reader = createPlanReader({ chunkBytes: 200 });
  reader.read(file);
  write([fixedPlan('New')]);
  setMtime(Date.now());
  assert.equal(reader.read(file).items[0].content, 'New 1');
});

test('sidechain events never reach the plan', () => {
  const side = (name, input) => JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_side', name, input }] },
  });
  write([plan({ items: items(3) }), bash('parent'), side(PLAN, { advance: true }), side(PLAN, { items: items(1) }), side('Bash', { command: 'child' })]);
  const reader = createPlanReader({ chunkBytes: 200 });
  const r = reader.read(file);
  assert.deepEqual(statuses(r), ['in_progress', 'pending', 'pending']);
  append([side(PLAN, { advance: true }), side('PowerShell', { command: 'child2' })]);
  const r2 = reader.read(file);
  assert.deepEqual(statuses(r2), ['in_progress', 'pending', 'pending']);
});

test('forget drops the cached result so the next read reads the file', () => {
  write([plan({ items: items(2) }), bash('a')]);
  const reader = createPlanReader();
  reader.read(file);
  reader.forget(file);
  reader.forget(path.join(dir, 'never-read.jsonl'));
  const orig = fs.readSync;
  let calls = 0;
  fs.readSync = function (...args) { calls += 1; return orig.apply(this, args); };
  try {
    assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending']);
  } finally {
    fs.readSync = orig;
  }
  assert.ok(calls > 0);
  fs.rmSync(file);
  reader.forget(file);
  assert.deepEqual(reader.read(file), { items: null });
});

test('results are frozen so callers cannot change the cache', () => {
  write([plan({ items: items(2) }), bash('a')]);
  const reader = createPlanReader();
  const r = reader.read(file);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.items));
  assert.ok(Object.isFrozen(r.items[0]));
  assert.throws(() => { r.items[0].status = 'completed'; }, TypeError);
  assert.throws(() => { r.items.push({}); }, TypeError);
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending']);
  append([plan({ advance: true })]);
  assert.deepEqual(statuses(reader.read(file)), ['completed', 'in_progress']);
});

test('reads CRLF-terminated lines', () => {
  fs.writeFileSync(file, [plan({ items: items(3) }), plan({ advance: true }), bash('dir')].join('\r\n') + '\r\n');
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['completed', 'in_progress', 'pending']);
});

test('multibyte characters survive chunks smaller than 10 bytes', () => {
  const text = 'Café résumé 日本 🚀';
  write([plan({ items: [{ content: text, status: 'in_progress' }] }), filler(1), bash('echo éè')]);
  const r = createPlanReader({ chunkBytes: 7 }).read(file);
  assert.equal(r.items[0].content, text);
});

test('a transcript with a plan and no command returns the plan', () => {
  write([plan({ items: items(2) }), filler(1), plan({ advance: true })]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['completed', 'in_progress']);
});

test('an empty file returns nulls', () => {
  fs.writeFileSync(file, '');
  assert.deepEqual(createPlanReader().read(file), { items: null });
});

// wrap_up (mcp__ccd_turn__wrap_up) checks the whole plan off at the end of a turn.

const WRAP = 'mcp__ccd_turn__wrap_up';
const wrapUp = () => toolLine(WRAP, { recap: 'All done. Nothing committed.' });
// One assistant event with several tool_use blocks, in this order.
function multi(blocks, extra = {}) {
  n += 1;
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: { role: 'assistant', content: blocks.map(([name, input], k) => ({ type: 'tool_use', id: `toolu_${n}_${k}`, name, input })) },
  });
}

test('wrap_up after an items call completes every item', () => {
  write([plan({ items: items(4, 1) }), bash('npm test'), wrapUp()]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['completed', 'completed', 'completed', 'completed']);
});

test('wrap_up then a new items call gives the new plan', () => {
  write([plan({ items: items(4, 2) }), wrapUp(), filler(1), plan({ items: items(2) })]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.deepEqual(statuses(r), ['in_progress', 'pending']);
});

test('wrap_up with no plan gives no plan', () => {
  write([bash('ls'), wrapUp(), filler(1)]);
  const r = createPlanReader({ chunkBytes: 200 }).read(file);
  assert.equal(r.items, null);
});

test('updates after the last wrap_up are replayed in file order', () => {
  write([plan({ items: items(3) }), wrapUp(), plan({ start: 2 })]);
  assert.deepEqual(statuses(createPlanReader({ chunkBytes: 200 }).read(file)), ['completed', 'in_progress', 'completed']);
  write([plan({ items: items(3) }), plan({ advance: true }), wrapUp(), plan({ advance: true })]);
  assert.deepEqual(statuses(createPlanReader({ chunkBytes: 200 }).read(file)), ['completed', 'completed', 'completed']);
});

test('wrap_up and update_plan in one event keep their block order', () => {
  write([plan({ items: items(3) }), multi([[WRAP, {}], [PLAN, { items: items(2) }]])]);
  assert.deepEqual(statuses(createPlanReader({ chunkBytes: 200 }).read(file)), ['in_progress', 'pending']);
  write([multi([[PLAN, { items: items(2) }], [WRAP, {}]])]);
  assert.deepEqual(statuses(createPlanReader({ chunkBytes: 200 }).read(file)), ['completed', 'completed']);
});

test('a wrap_up inside a sidechain event is ignored', () => {
  const sideWrap = () => multi([[WRAP, { recap: 'sub' }]], { isSidechain: true });
  write([plan({ items: items(3) }), sideWrap()]);
  const reader = createPlanReader({ chunkBytes: 200 });
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending', 'pending']);
  append([sideWrap()]);
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending', 'pending']);
});

test('wrap_up is found across chunk boundaries', () => {
  const lines = [plan({ items: items(3) })];
  for (let i = 0; i < 15; i++) lines.push(filler(i));
  lines.push(plan({ advance: true }));
  for (let i = 0; i < 15; i++) lines.push(filler(100 + i));
  lines.push(wrapUp());
  for (let i = 0; i < 15; i++) lines.push(filler(200 + i));
  write(lines);
  for (const chunkBytes of [7, 64, 200, 1000]) {
    const r = createPlanReader({ chunkBytes }).read(file);
    assert.deepEqual(statuses(r), ['completed', 'completed', 'completed'], `chunkBytes ${chunkBytes}`);
  }
});

test('a cached read picks up a wrap_up appended later, and a plan after it', () => {
  const lines = [plan({ items: items(3, 1) })];
  for (let i = 0; i < 30; i++) lines.push(filler(i));
  write(lines);
  const reader = createPlanReader({ chunkBytes: 200 });
  assert.deepEqual(statuses(reader.read(file)), ['completed', 'in_progress', 'pending']);

  append([wrapUp()]);
  const orig = fs.readSync;
  let bytes = 0;
  fs.readSync = function (...args) { const r = orig.apply(this, args); bytes += r; return r; };
  let r;
  try {
    r = reader.read(file);
  } finally {
    fs.readSync = orig;
  }
  assert.deepEqual(statuses(r), ['completed', 'completed', 'completed']);
  assert.ok(bytes < 1000, `re-read ${bytes} bytes`);

  append([plan({ items: items(2) })]);
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'pending']);
  append([wrapUp(), plan({ start: 1 })]);
  assert.deepEqual(statuses(reader.read(file)), ['in_progress', 'completed']);
});
