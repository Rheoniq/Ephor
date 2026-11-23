'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentReader, effectiveStatus, createAgentSource } = require('../src/main/agent-reader');
const { createFinished } = require('../src/main/finished');
const { createEventDetector } = require('../src/main/events');
const { createDismissals } = require('../src/main/dismissals');

// Synthetic transcript lines in the shapes Claude Code writes (structure
// only, no conversation text).
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const A = 'a03d35aaa4671c6e7';
const B = 'b15890240fcf2bf50';
const C = 'c18b6a7baf1e074c7';

function launch(id, at = NOW - 1000, extra = {}) {
  return JSON.stringify({
    parentUuid: 'p-1',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Async agent launched' }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: 'Synthetic agent', prompt: 'Synthetic prompt' },
    timestamp: typeof at === 'number' ? iso(at) : at,
    ...extra,
  });
}

function resume(id, at = NOW - 1000, extra = {}) {
  return JSON.stringify({
    parentUuid: 'p-2',
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'Sent' }] }] },
    toolUseResult: { success: true, message: 'Sent', resumedAgentId: id, revivedAgentId: id },
    timestamp: iso(at),
    ...extra,
  });
}

function notificationText(id, { status = 'completed', summary = 'Agent "Synthetic" completed', result = 'Synthetic result' } = {}) {
  return (
    '<task-notification>\n' +
    `<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>C:\\x\\out.txt</output-file>\n` +
    `<status>${status}</status>\n<summary>${summary}</summary>\n<note>n</note>\n` +
    `<result>${result}</result>\n<usage>u</usage>\n</task-notification>`
  );
}

function enqueue(id, opts = {}, operation = 'enqueue', extra = {}) {
  return JSON.stringify({ type: 'queue-operation', operation, timestamp: iso(NOW - 500), sessionId: 's-1', content: notificationText(id, opts), ...extra });
}
const removeOp = (id, opts) => enqueue(id, opts, 'remove');
const attachmentCopy = (id) => JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: notificationText(id) }, timestamp: iso(NOW - 400) });
const userCopy = (id) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: notificationText(id) }, timestamp: iso(NOW - 300) });
const apiCopy = (id) => JSON.stringify({ type: 'api-request-blob', body: JSON.stringify({ messages: [{ role: 'user', content: notificationText(id) }] }) });
const filler = (i) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `filler line ${i} ` + 'z'.repeat(60) } });
const INTERIM = 'Agent "Synthetic" is waiting on its own background work';

let dir;
let file;
let subDir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ephor-agents-'));
  file = path.join(dir, 's-1.jsonl');
  subDir = path.join(dir, 's-1', 'subagents');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

let bump = 0;
function append(lines) {
  fs.appendFileSync(file, lines.join('\n') + '\n');
  // Make sure the mtime moves even on coarse clocks.
  bump += 1;
  const t = new Date(Date.now() + 5000 + bump);
  fs.utimesSync(file, t, t);
}

function setMtime(target, ms) {
  const t = new Date(ms);
  fs.utimesSync(target, t, t);
}

// A subagent transcript with the given mtime.
function agentFile(id, mtimeMs) {
  fs.mkdirSync(subDir, { recursive: true });
  const f = path.join(subDir, `agent-${id}.jsonl`);
  fs.writeFileSync(f, filler(0) + '\n');
  setMtime(f, mtimeMs);
  return f;
}

const reader = (o = {}) => createAgentReader({ now: () => NOW, ...o });
const pending = (r, f = file) => r.read(f, subDir).pending;

function spyReads(fn) {
  const orig = fs.readSync;
  let calls = 0;
  let bytes = 0;
  fs.readSync = function (...args) { calls += 1; const n = orig.apply(this, args); bytes += n; return n; };
  try {
    return { value: fn(), calls: () => calls, bytes: () => bytes };
  } finally {
    fs.readSync = orig;
  }
}

// --- folding -----------------------------------------------------------------

test('a launch with no notification is pending while fresh', () => {
  write([filler(1), launch(A), filler(2)]);
  assert.deepEqual(reader().read(file, subDir), { pending: 1 });
});

test('liveness: the subagent file keeps an old launch pending until it is older than aliveMs', () => {
  const now = Date.now();
  write([launch(A, now - 10 * MIN)]);
  const f = agentFile(A, now - 1 * MIN);
  const r = createAgentReader({ now: () => now });
  assert.equal(r.read(file, subDir).pending, 1);
  setMtime(f, now - 46 * MIN);
  assert.equal(r.read(file, subDir).pending, 0, 'file older than aliveMs and launch older than freshLaunchMs');
  setMtime(f, now - 44 * MIN);
  assert.equal(r.read(file, subDir).pending, 1, 'a file written again counts again');
});

test('liveness: an old launch without a subagent file is not pending; a fresh one is', () => {
  write([launch(A, NOW - 3 * MIN), launch(B, NOW - 90 * 1000)]);
  assert.equal(pending(reader()), 1);
  assert.equal(pending(reader({ freshLaunchMs: 60 * 1000 })), 0);
  assert.equal(pending(reader({ freshLaunchMs: 5 * MIN })), 2);
});

test('liveness: an unchanged transcript is re-checked against now on every read, without reading it', () => {
  const now = Date.now();
  let clock = now;
  write([launch(A, now - 10 * MIN), filler(1)]);
  agentFile(A, now - 1 * MIN);
  const r = createAgentReader({ now: () => clock });
  assert.equal(r.read(file, subDir).pending, 1);
  clock = now + 45 * MIN;
  const spy = spyReads(() => r.read(file, subDir));
  assert.equal(spy.value.pending, 0);
  assert.equal(spy.calls(), 0);
});

test('liveness: a missing or bad subagents dir falls back to the launch age', () => {
  write([launch(A)]);
  const r = reader();
  assert.equal(r.read(file, path.join(dir, 'nope')).pending, 1);
  assert.equal(r.read(file, undefined).pending, 1);
  assert.equal(r.read(file, 42).pending, 1);
  write([launch(A, NOW - 10 * MIN)]);
  assert.equal(reader().read(file, undefined).pending, 0);
});

test('liveness: a launch far in the future is not fresh', () => {
  write([launch(A, NOW + 24 * 60 * MIN)]);
  assert.equal(pending(reader()), 0);
  write([launch(A, NOW + 5 * 1000)]);
  assert.equal(pending(reader()), 1, 'a few seconds of clock skew still count');
});

test('a launch without a valid timestamp is treated as old', () => {
  const now = Date.now();
  write([launch(A, 'not a date'), launch(B, null)]);
  const r = createAgentReader({ now: () => now });
  assert.equal(r.read(file, subDir).pending, 0);
  agentFile(A, now - 1000);
  assert.equal(r.read(file, subDir).pending, 1, 'it still counts through its subagent file');
});

test('a completed enqueue notification clears the agent', () => {
  write([launch(A), filler(1), enqueue(A)]);
  assert.equal(pending(reader()), 0);
});

test('a failed or stopped agent is cleared too', () => {
  write([launch(A), launch(B), enqueue(A, { status: 'failed' }), enqueue(B, { status: 'stopped' })]);
  assert.equal(pending(reader()), 0);
});

test('two agents, one done', () => {
  write([launch(A), launch(B), enqueue(B)]);
  assert.equal(pending(reader()), 1);
});

test('an interim notice does not clear; the final notification does', () => {
  write([launch(A), enqueue(A, { summary: INTERIM })]);
  assert.equal(pending(reader()), 1);
  write([launch(A), enqueue(A, { summary: INTERIM }), enqueue(A)]);
  assert.equal(pending(reader()), 0);
});

test('the interim phrase in the result body does not make a final notification interim', () => {
  write([launch(A), enqueue(A, { result: `Quoted: ${INTERIM}` })]);
  assert.equal(pending(reader()), 0);
});

test('repeated notifications are harmless', () => {
  write([launch(A), enqueue(A), enqueue(A), enqueue(A, { summary: INTERIM }), enqueue(A)]);
  assert.equal(pending(reader()), 0);
});

test('a notification for an id that never had a launch or resume is ignored', () => {
  write([enqueue('b1x2y3z4w'), enqueue(B)]);
  assert.equal(pending(reader()), 0);
  write([launch(A), enqueue(B), enqueue('bash-task-1')]);
  assert.equal(pending(reader()), 1);
});

test('a resume record sets the agent pending again until its next notification', () => {
  write([launch(A), enqueue(A), resume(A)]);
  assert.equal(pending(reader()), 1);
  write([launch(A), enqueue(A), resume(A), enqueue(A, { summary: INTERIM })]);
  assert.equal(pending(reader()), 1);
  write([launch(A), enqueue(A), resume(A), enqueue(A)]);
  assert.equal(pending(reader()), 0);
});

test('a resume alone (its launch outside the window) sets pending', () => {
  write([resume(C)]);
  assert.equal(pending(reader()), 1);
});

test('a notification before its launch in file order leaves the agent pending (liveness decides)', () => {
  write([enqueue(A), launch(A)]);
  assert.equal(pending(reader()), 1);
  write([enqueue(A), launch(A, NOW - 10 * MIN)]);
  assert.equal(pending(reader()), 0);
});

test('remove, attachment, user and api-request copies of a notification never clear', () => {
  write([launch(A), removeOp(A), attachmentCopy(A), userCopy(A), apiCopy(A)]);
  assert.equal(pending(reader()), 1);
  // Copies of the earlier notification after a resume do not clear the resumed agent.
  write([launch(A), enqueue(A), resume(A), removeOp(A), attachmentCopy(A), userCopy(A), apiCopy(A)]);
  assert.equal(pending(reader()), 1);
});

test('only the head before <result> is parsed: an interim summary inside the result does not count', () => {
  const content =
    '<task-notification>\n' +
    `<task-id>${A}</task-id>\n<status>completed</status>\n` +
    `<result>Quoted: <summary>${INTERIM}</summary> <task-id>${B}</task-id></result>\n</task-notification>`;
  const note = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(NOW), content });
  write([launch(A), launch(B), note]);
  assert.equal(pending(reader()), 1, 'A is cleared, B is not');
});

test('an enqueue whose content is not a task notification is ignored', () => {
  const queued = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(NOW), content: `see <task-id>${A}</task-id> <status>completed</status>` });
  write([launch(A), queued]);
  assert.equal(pending(reader()), 1);
});

test('sidechain events are ignored', () => {
  write([launch(A, NOW - 1000, { isSidechain: true }), resume(B, NOW - 1000, { isSidechain: true })]);
  assert.equal(pending(reader()), 0);
  write([launch(A), enqueue(A, {}, 'enqueue', { isSidechain: true })]);
  assert.equal(pending(reader()), 1);
});

test('only user events count as launch or resume records', () => {
  const asAssistant = JSON.parse(launch(A));
  asAssistant.type = 'assistant';
  const asProgress = JSON.parse(resume(B));
  asProgress.type = 'progress';
  write([JSON.stringify(asAssistant), JSON.stringify(asProgress)]);
  assert.equal(pending(reader()), 0);
});

test('agent ids that are not 8 to 40 hex characters are rejected', () => {
  for (const id of ['../../evil', 'ABCDEF0123', 'a1b2c3', 'g'.repeat(10), 'a'.repeat(41), '', 42, null]) {
    write([launch(id), resume(id)]);
    assert.equal(pending(reader()), 0, String(id));
  }
  write([launch('a'.repeat(8)), launch('0'.repeat(40))]);
  assert.equal(pending(reader()), 2);
});

test('a launch record needs isAsync true', () => {
  const sync = JSON.parse(launch(A));
  sync.toolUseResult.isAsync = 'true';
  const noFlag = JSON.parse(launch(B));
  delete noFlag.toolUseResult.isAsync;
  write([JSON.stringify(sync), JSON.stringify(noFlag)]);
  assert.equal(pending(reader()), 0);
});

test('corrupt lines and an unterminated last line never throw', () => {
  const lines = [
    launch(A),
    'not json {"isAsync":true "queue-operation"',
    '{"type":"user","toolUseResult":{"isAsync":true,"agentId":"' + B,
    '{"type":"queue-operation","operation":"enqueue","content":42}',
    '{"type":"queue-operation","operation":"enqueue"}',
    '{"type":"user","toolUseResult":null,"isAsync":true}',
    'null',
    '[1,2,"isAsync"]',
    '"resumedAgentId"',
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n' + enqueue(A).slice(0, 80));
  assert.equal(pending(reader()), 1);
});

test('reads CRLF-terminated lines', () => {
  fs.writeFileSync(file, [launch(A), launch(B), enqueue(B)].join('\r\n') + '\r\n');
  assert.equal(pending(reader()), 1);
});

// --- scanning ------------------------------------------------------------------

test('a missing transcript returns pending 0 and never throws', () => {
  const r = reader();
  assert.deepEqual(r.read(path.join(dir, 'nope.jsonl'), subDir), { pending: 0 });
  assert.deepEqual(r.read(dir, subDir), { pending: 0 });
  assert.deepEqual(r.read(undefined, subDir), { pending: 0 });
  assert.deepEqual(r.read('', subDir), { pending: 0 });
  fs.writeFileSync(file, '');
  assert.deepEqual(r.read(file, subDir), { pending: 0 });
});

test('results are frozen', () => {
  write([launch(A)]);
  const res = reader().read(file, subDir);
  assert.ok(Object.isFrozen(res));
  assert.throws(() => { res.pending = 5; }, TypeError);
  assert.ok(Object.isFrozen(reader().read(path.join(dir, 'nope.jsonl'), subDir)));
});

test('the first read scans only windowBytes from the end', () => {
  const lines = [launch(A)];
  for (let i = 0; i < 200; i++) lines.push(filler(i));
  lines.push(launch(B));
  write(lines);
  const spy = spyReads(() => pending(reader({ windowBytes: 4000 })));
  assert.equal(spy.value, 1, 'the launch before the window is not seen');
  assert.ok(spy.bytes() <= 4001, `read ${spy.bytes()} bytes`);
  assert.equal(pending(reader()), 2);
});

test('the window starts at the first complete line', () => {
  const head = [launch(A)];
  for (let i = 0; i < 10; i++) head.push(filler(i));
  const tail = [launch(B), launch(C)];
  write([...head, ...tail]);
  const size = fs.statSync(file).size;
  const bStart = Buffer.byteLength(head.join('\n') + '\n');
  // The window starts exactly at the start of B's line: B counts.
  assert.equal(pending(reader({ windowBytes: size - bStart })), 2);
  // The window starts one byte into B's line: B is cut, C counts.
  assert.equal(pending(reader({ windowBytes: size - bStart - 1 })), 1);
  // The window starts at the newline before B: B counts.
  assert.equal(pending(reader({ windowBytes: size - bStart + 1 })), 2);
});

test('the cut tail of the first line in the window is never parsed, even when it is valid JSON', () => {
  const head = [filler(1)];
  const cutLine = 'x'.repeat(10) + launch(B); // not JSON as a whole; its tail is
  write([...head, cutLine, launch(C)]);
  const size = fs.statSync(file).size;
  const tailStart = Buffer.byteLength(head.join('\n') + '\n') + 10;
  assert.equal(pending(reader({ windowBytes: size - tailStart })), 1);
  assert.equal(pending(reader()), 1);
});

test('a window inside one long line finds nothing and does not throw', () => {
  write([filler(1), launch(A, NOW - 1000, { pad: 'p'.repeat(5000) })]);
  assert.equal(pending(reader({ windowBytes: 1000 })), 0);
});

test('an unchanged file is not read again', () => {
  write([launch(A), filler(1)]);
  const r = reader();
  assert.equal(pending(r), 1);
  const spy = spyReads(() => pending(r));
  assert.equal(spy.value, 1);
  assert.equal(spy.calls(), 0);
});

test('a notification appended later clears pending without rereading the file', () => {
  const lines = [launch(A), launch(B)];
  for (let i = 0; i < 100; i++) lines.push(filler(i));
  write(lines);
  const r = reader();
  assert.equal(pending(r), 2);
  const added = [enqueue(A)];
  append(added);
  const spy = spyReads(() => pending(r));
  assert.equal(spy.value, 1);
  const addedBytes = Buffer.byteLength(added.join('\n') + '\n');
  assert.ok(spy.bytes() <= addedBytes + 1, `re-read ${spy.bytes()} bytes for ${addedBytes} appended`);
  append([enqueue(B), resume(A)]);
  assert.equal(pending(r), 1);
});

test('a line completed by a later append is read once it is whole', () => {
  const note = enqueue(A);
  fs.writeFileSync(file, launch(A) + '\n' + note.slice(0, 50));
  const r = reader();
  assert.equal(pending(r), 1);
  fs.appendFileSync(file, note.slice(50) + '\n');
  setMtime(file, Date.now() + 9000);
  assert.equal(pending(r), 0);
});

test('an append larger than the window scans only the window, on top of the old ledger', () => {
  write([launch(A), launch(C)]);
  const r = reader({ windowBytes: 3000 });
  assert.equal(pending(r), 2);
  const more = [];
  for (let i = 0; i < 100; i++) more.push(filler(i));
  more.push(launch(B), enqueue(C));
  append(more);
  const spy = spyReads(() => pending(r));
  assert.equal(spy.value, 2, 'A is kept from the old ledger, C is cleared in the window, B counts');
  assert.ok(spy.bytes() <= 3001 + 1, `read ${spy.bytes()} bytes`);
});

test('a rewrite larger than the window drops the old ledger', () => {
  const now = Date.now();
  write([launch(A)]);
  setMtime(file, now);
  const r = reader({ windowBytes: 3000 });
  assert.equal(pending(r), 1);
  const lines = [filler(0)];
  for (let i = 1; i < 100; i++) lines.push(filler(i));
  lines.push(launch(B));
  write(lines);
  setMtime(file, now - 60000); // the mtime went back: not an append
  assert.equal(pending(r), 1, 'only B');
});

test('an entry whose record and subagent file are both older than twice aliveMs leaves the ledger', () => {
  const now = Date.now();
  const clock = now;
  write([launch(A, now - 100 * MIN), launch(B, now - 100 * MIN), launch(C, now - 100 * MIN)]);
  const fa = agentFile(A, now - 100 * MIN); // both old: dropped
  const fb = agentFile(B, now - 60 * MIN); // file within 2x aliveMs: kept, not alive
  const r = createAgentReader({ now: () => clock });
  assert.equal(r.read(file, subDir).pending, 0);
  // Written again: B counts again, A was dropped for good, C (no file) too.
  setMtime(fa, now);
  setMtime(fb, now);
  agentFile(C, now);
  assert.equal(r.read(file, subDir).pending, 1);
  // A fresh reader still sees all three through their files.
  assert.equal(createAgentReader({ now: () => clock }).read(file, subDir).pending, 3);
});

test('a shrunk file is read again from scratch', () => {
  write([launch(A), launch(B), filler(1), filler(2)]);
  const r = reader();
  assert.equal(pending(r), 2);
  write([launch(C)]);
  assert.equal(pending(r), 1);
  write([enqueue(C)]);
  assert.equal(pending(r), 0);
});

// Same-length launch lines for two ids, so a rewrite keeps the size.
test('a same-size rewrite with a new mtime is read again', () => {
  write([launch(A)]);
  setMtime(file, Date.now() - 60000);
  const r = reader();
  assert.equal(pending(r), 1);
  write([launch(A).replace('"isAsync":true', '"isAsync":null')]);
  assert.equal(fs.statSync(file).size, Buffer.byteLength(launch(A) + '\n'));
  setMtime(file, Date.now());
  assert.equal(pending(r), 0);
});

test('a grown file whose mtime went back is read again from scratch', () => {
  const now = Date.now();
  write([launch(A)]);
  setMtime(file, now);
  const r = reader();
  assert.equal(pending(r), 1);
  // Same first-line length, so the byte before the old resume offset is
  // still a newline; only the mtime shows the rewrite.
  write([launch(A).replace('"isAsync":true', '"isAsync":null'), launch(B)]);
  setMtime(file, now - 60000);
  assert.equal(pending(r), 1);
  write([launch(A).replace('"isAsync":true', '"isAsync":null'), launch(B), enqueue(B)]);
  setMtime(file, now - 120000);
  assert.equal(pending(r), 0);
});

test('a file truncated and regrown with new content is read again from scratch', () => {
  write([launch(A), filler(1)]);
  setMtime(file, Date.now() - 60000);
  const r = reader();
  assert.equal(pending(r), 1);
  write([filler(2), filler(3), filler(4), launch(B), enqueue(B)]);
  setMtime(file, Date.now());
  assert.equal(pending(r), 0);
});

test('a vanished transcript keeps its ledger and still ages out', () => {
  const now = Date.now();
  let clock = now;
  write([launch(A, now - 10 * MIN)]);
  agentFile(A, now - 1 * MIN);
  const r = createAgentReader({ now: () => clock });
  assert.equal(r.read(file, subDir).pending, 1);
  fs.rmSync(file);
  assert.equal(r.read(file, subDir).pending, 1);
  clock = now + 50 * MIN;
  assert.equal(r.read(file, subDir).pending, 0);
});

test('forget drops the cached ledger', () => {
  write([launch(A)]);
  const r = reader();
  assert.equal(pending(r), 1);
  r.forget(file);
  r.forget(path.join(dir, 'never-read.jsonl'));
  r.forget(undefined);
  fs.rmSync(file);
  assert.equal(pending(r), 0);
  write([launch(A)]);
  const spy = spyReads(() => pending(r));
  assert.equal(spy.value, 1);
  assert.ok(spy.calls() > 0);
});

test('many pending agents are capped, so the per-read stat work stays bounded', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(launch(i.toString(16).padStart(12, '0')));
  write(lines);
  const n = pending(reader());
  assert.ok(n > 0 && n <= 128, `pending ${n}`);
});

// --- effective status ------------------------------------------------------------

test('effectiveStatus: idle with pending agents is busy; nothing else changes', () => {
  assert.equal(effectiveStatus('idle', 1), 'busy');
  assert.equal(effectiveStatus('idle', 3), 'busy');
  assert.equal(effectiveStatus('idle', 0), 'idle');
  assert.equal(effectiveStatus('waiting', 2), 'waiting');
  assert.equal(effectiveStatus('busy', 0), 'busy');
  assert.equal(effectiveStatus('busy', 2), 'busy');
  for (const bad of [undefined, null, NaN, -1, '2', 1.5, Infinity]) {
    assert.equal(effectiveStatus('idle', bad), 'idle', String(bad));
  }
});

test('finished, toasts and dismissals see agents as working until the last one ends', () => {
  const finished = createFinished();
  const detector = createEventDetector();
  const dismissals = createDismissals();
  const step = (registry, pendingAgents) => {
    const sessions = [{ sessionId: 's', name: 'N', status: effectiveStatus(registry, pendingAgents) }];
    finished.update(sessions);
    return { events: detector.detect(sessions), status: sessions[0].status };
  };
  step('busy', 0);
  // The parent turn ends while two agents run: still working, no finished.
  let r = step('idle', 2);
  assert.equal(r.status, 'busy');
  assert.deepEqual(r.events, []);
  assert.equal(finished.isFinished('s'), false);
  r = step('idle', 1);
  assert.deepEqual(r.events, []);
  assert.equal(finished.isFinished('s'), false);
  // The last agent ends and the parent does not wake up: finished now.
  r = step('idle', 0);
  assert.equal(r.status, 'idle');
  assert.deepEqual(r.events.map((e) => e.kind), ['finished']);
  assert.equal(finished.isFinished('s'), true);
  // A session dismissed while agents run comes back only when it works again.
  dismissals.dismiss('s', effectiveStatus('idle', 2));
  assert.equal(dismissals.visible('s', effectiveStatus('idle', 2)), false);
  assert.equal(dismissals.visible('s', effectiveStatus('idle', 0)), false);
  assert.equal(dismissals.visible('s', effectiveStatus('idle', 1)), true);
});

// --- agent source (main's per-session wiring) ------------------------------------

function fakeReader(counts) {
  const calls = [];
  const forgotten = [];
  return {
    calls,
    forgotten,
    read(f, sub) {
      calls.push([f, sub]);
      const v = counts[f];
      if (v instanceof Error) throw v;
      return Object.freeze({ pending: v || 0 });
    },
    forget(f) { forgotten.push(f); },
  };
}

const filesFor = (s) => ({ transcript: `T:${s.sessionId}`, subagents: `D:${s.sessionId}` });
const sess = (sessionId, status, extra = {}) => ({ sessionId, name: `Name ${sessionId}`, cwd: 'C:\\secret\\path', status, ...extra });

test('agent source: only idle sessions are read; idle with pending becomes busy; waiting never changes', () => {
  const rd = fakeReader({ 'T:a1111111-x': 2, 'T:b2222222-x': 0, 'T:w': 5, 'T:busy': 3 });
  const src = createAgentSource(rd, filesFor, () => {});
  const kept = [sess('a1111111-x', 'idle'), sess('b2222222-x', 'idle'), sess('w', 'waiting'), sess('busy', 'busy')];
  const out = src.apply(kept);
  assert.deepEqual(out.map((s) => s.status), ['busy', 'idle', 'waiting', 'busy']);
  assert.deepEqual(rd.calls, [['T:a1111111-x', 'D:a1111111-x'], ['T:b2222222-x', 'D:b2222222-x']]);
  // Copies, never the registry objects; untouched sessions stay as they are.
  assert.notEqual(out[0], kept[0]);
  assert.equal(kept[0].status, 'idle');
  assert.equal(out[1], kept[1]);
  assert.equal(out[0].cwd, kept[0].cwd);
  assert.equal(out[0].pendingAgents, 2);
});

test('agent source: a throwing reader or path helper counts as no agents and never throws', () => {
  const rd = fakeReader({ 'T:a': new Error('boom') });
  const src = createAgentSource(rd, filesFor, () => {});
  assert.deepEqual(src.apply([sess('a', 'idle')]).map((s) => s.status), ['idle']);
  const src2 = createAgentSource(rd, () => { throw new Error('bad path'); }, () => {});
  assert.deepEqual(src2.apply([sess('b', 'idle')]).map((s) => s.status), ['idle']);
  const src3 = createAgentSource(rd, () => null, () => {});
  assert.deepEqual(src3.apply([sess('c', 'idle')]).map((s) => s.status), ['idle']);
  const src4 = createAgentSource({ read() { return null; } }, filesFor, () => { throw new Error('log'); });
  assert.deepEqual(src4.apply([sess('d', 'idle')]).map((s) => s.status), ['idle']);
});

// A synthetic session id (UUID-shaped).
const SID = 'c0ffee12-3456-4789-abcd-ef0123456789';

test('agent source: logs one line when agents start and one when they are released, 8 id characters and the count', () => {
  const counts = { [`T:${SID}`]: 2 };
  const rd = fakeReader(counts);
  const lines = [];
  let clock = 0;
  const src = createAgentSource(rd, filesFor, (l) => lines.push(l), { now: () => clock });
  const s = sess(SID, 'idle');
  src.apply([s]);
  src.apply([s]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /c0ffee12/);
  assert.match(lines[0], /\b2\b/);
  assert.doesNotMatch(lines[0], /3456|Name|secret|T:|D:/);
  // The agents end: held busy without a line, then released once with one line.
  counts[`T:${SID}`] = 0;
  clock = 2000;
  src.apply([s]);
  clock = 4000;
  src.apply([s]);
  assert.equal(lines.length, 1);
  clock = 8000;
  assert.equal(src.apply([s])[0].status, 'idle');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /c0ffee12/);
  assert.match(lines[1], /\b0\b/);
  assert.doesNotMatch(lines[1], /3456|Name|secret|T:|D:/);
  src.apply([s]);
  assert.equal(lines.length, 2);
  // The registry turns busy and idle again with no agents: no line.
  src.apply([sess(SID, 'busy')]);
  src.apply([s]);
  assert.equal(lines.length, 2);
});

// The finished tracker and the toast detector over what the source returns.
function settleHarness(opts = { settleMs: 6000 }) {
  const counts = {};
  let clock = 0;
  const src = createAgentSource(fakeReader(counts), filesFor, () => {}, { ...opts, now: () => clock });
  const finished = createFinished();
  const detector = createEventDetector();
  const all = [];
  const step = (at, registry, pendingAgents) => {
    clock = at;
    counts['T:s'] = pendingAgents;
    const sessions = src.apply([sess('s', registry)]);
    finished.update(sessions);
    const events = detector.detect(sessions).map((e) => e.kind);
    all.push(...events);
    return { status: sessions[0].status, events, finished: finished.isFinished('s') };
  };
  return { step, src, all };
}

test('settle: the last agent ending while the registry still says idle gives no finished flash', () => {
  const { step, all } = settleHarness();
  step(0, 'busy', 0);
  assert.deepEqual(step(2000, 'idle', 2), { status: 'busy', events: [], finished: false });
  // The last notification lands; the parent has not woken up yet.
  assert.deepEqual(step(4000, 'idle', 0), { status: 'busy', events: [], finished: false });
  assert.deepEqual(step(6000, 'idle', 0), { status: 'busy', events: [], finished: false });
  // The parent wakes up to read the result.
  assert.deepEqual(step(8000, 'busy', 0), { status: 'busy', events: [], finished: false });
  // Its turn ends: one real finished edge, with no delay.
  assert.deepEqual(step(10000, 'idle', 0), { status: 'idle', events: ['finished'], finished: true });
  assert.deepEqual(all, ['finished']);
});

test('settle: idle with no agents held past settleMs gives exactly one finished event', () => {
  const { step, all } = settleHarness();
  step(0, 'busy', 0);
  step(2000, 'idle', 2);
  assert.equal(step(4000, 'idle', 0).status, 'busy');
  assert.equal(step(8000, 'idle', 0).status, 'busy');
  assert.deepEqual(step(10000, 'idle', 0), { status: 'idle', events: ['finished'], finished: true });
  step(12000, 'idle', 0);
  step(14000, 'idle', 0);
  assert.deepEqual(all, ['finished']);
});

test('settle: a session that never had agents gets no delay', () => {
  const { step, all } = settleHarness();
  step(0, 'busy', 0);
  assert.deepEqual(step(2000, 'idle', 0), { status: 'idle', events: ['finished'], finished: true });
  assert.deepEqual(all, ['finished']);
});

test('settle: agents pending again during the settle restart it', () => {
  const { step } = settleHarness();
  step(0, 'idle', 1);
  step(2000, 'idle', 0);
  assert.equal(step(4000, 'idle', 1).status, 'busy');
  assert.equal(step(6000, 'idle', 0).status, 'busy');
  assert.equal(step(10000, 'idle', 0).status, 'busy', 'the settle started again at 6000');
  assert.equal(step(12000, 'idle', 0).status, 'idle');
});

test('settle: waiting, busy and prune clear the settle state', () => {
  let h = settleHarness();
  h.step(0, 'idle', 2);
  h.step(2000, 'idle', 0);
  assert.equal(h.step(3000, 'waiting', 0).status, 'waiting');
  assert.equal(h.step(4000, 'idle', 0).status, 'idle');
  h = settleHarness();
  h.step(0, 'idle', 2);
  h.step(2000, 'idle', 0);
  h.src.prune([]);
  assert.equal(h.step(4000, 'idle', 0).status, 'idle');
  // Pruned while still counted as working (not settling yet).
  h = settleHarness();
  h.step(0, 'idle', 2);
  h.src.prune([]);
  assert.equal(h.step(2000, 'idle', 0).status, 'idle');
  // Busy clears it too.
  h = settleHarness();
  h.step(0, 'idle', 2);
  h.step(2000, 'busy', 0);
  assert.equal(h.step(4000, 'idle', 0).status, 'idle');
});

test('settle: a clock that goes back restarts the settle instead of holding forever', () => {
  const { step } = settleHarness();
  step(100000, 'idle', 2);
  step(100000, 'idle', 0);
  assert.equal(step(50000, 'idle', 0).status, 'busy');
  assert.equal(step(56000, 'idle', 0).status, 'idle');
});

test('settle: settleMs 0 releases at once', () => {
  const { step } = settleHarness({ settleMs: 0 });
  step(0, 'idle', 2);
  assert.equal(step(2000, 'idle', 0).status, 'idle');
});

test('agent source: prune forgets the files of sessions that left the kept list', () => {
  const rd = fakeReader({});
  const src = createAgentSource(rd, filesFor, () => {});
  src.apply([sess('a', 'idle'), sess('b', 'idle'), sess('c', 'busy')]);
  src.prune(['b', 'c']);
  assert.deepEqual(rd.forgotten, ['T:a']);
  src.prune([]);
  assert.deepEqual(rd.forgotten.sort(), ['T:a', 'T:b']);
  const noForget = createAgentSource({ read: () => ({ pending: 0 }) }, filesFor, () => {});
  noForget.apply([sess('a', 'idle')]);
  noForget.prune([]);
});

test('agent source: a session whose transcript path changes forgets the old file', () => {
  const rd = fakeReader({});
  let n = 0;
  const src = createAgentSource(rd, (s) => ({ transcript: `T${n}:${s.sessionId}`, subagents: 'D' }), () => {});
  src.apply([sess('a', 'idle')]);
  n = 1;
  src.apply([sess('a', 'idle')]);
  assert.deepEqual(rd.forgotten, ['T0:a']);
});

test('end to end: the real reader through agentFiles under a temp home, as main wires it', () => {
  const { agentFiles } = require('../src/main/paths');
  const home = path.join(dir, 'home');
  const now = Date.now();
  const s = sess(SID, 'idle', { cwd: 'C:\\Code\\Ephor' });
  const files = agentFiles(home, s);
  fs.mkdirSync(path.dirname(files.transcript), { recursive: true });
  fs.writeFileSync(files.transcript, [launch(A, now - 10 * MIN), launch(B, now - 10 * MIN), enqueue(B)].join('\n') + '\n');
  fs.mkdirSync(files.subagents, { recursive: true });
  const agentTranscript = path.join(files.subagents, `agent-${A}.jsonl`);
  fs.writeFileSync(agentTranscript, filler(1) + '\n');
  setMtime(agentTranscript, now - 1 * MIN);
  const lines = [];
  let clock = now;
  const src = createAgentSource(
    createAgentReader({ now: () => clock }),
    (x) => agentFiles(home, x),
    (l) => lines.push(l),
    { now: () => clock },
  );
  let out = src.apply([s, sess('no-cwd', 'idle', { cwd: undefined })]);
  assert.deepEqual(out.map((x) => x.status), ['busy', 'idle']);
  assert.equal(out[0].pendingAgents, 1);
  // The agent stops writing: once its transcript is older than aliveMs the
  // session is idle again, after the settle time.
  setMtime(agentTranscript, now - 50 * MIN);
  out = src.apply([s]);
  assert.deepEqual(out.map((x) => x.status), ['busy']);
  clock = now + 6000;
  out = src.apply([s]);
  assert.deepEqual(out.map((x) => x.status), ['idle']);
  assert.equal(lines.length, 2);
  assert.equal(agentFiles(home, { sessionId: 'x' }), null);
  assert.equal(agentFiles(home, { cwd: 'C:\\x' }), null);
  // The path is the one the brief names: <projectDir>/<sessionId>/subagents.
  assert.equal(files.subagents, path.join(path.dirname(files.transcript), s.sessionId, 'subagents'));
  assert.equal(agentFiles(home, null), null);
});

// --- diagnostic counts and lines ---------------------------------------------

test('reader stats: alive counts fresh subagent files, fresh counts fresh launches, ledger the entries', () => {
  // A: old launch, fresh subagent file. B: fresh launch, no file. C: old launch, old file.
  write([launch(A, NOW - 10 * MIN), launch(B, NOW - 1000), launch(C, NOW - 10 * MIN)]);
  agentFile(A, NOW - MIN);
  agentFile(C, NOW - 60 * MIN);
  const r = reader();
  assert.equal(pending(r), 2);
  assert.deepEqual(r.stats(file), { alive: 1, fresh: 1, ledger: 3 });
  assert.deepEqual(r.stats(path.join(dir, 'unknown.jsonl')), { alive: 0, fresh: 0, ledger: 0 });
  r.forget(file);
  assert.deepEqual(r.stats(file), { alive: 0, fresh: 0, ledger: 0 });
});

test('agent source diag: one line per pending change with the counts, settle start and end', () => {
  const counts = { 'T:c0ffee12-x': 2 };
  const stats = { alive: 1, fresh: 2, ledger: 3 };
  const rd = { ...fakeReader(counts), stats: () => stats };
  const lines = [];
  let clock = 0;
  const src = createAgentSource(rd, filesFor, () => {}, { now: () => clock, diag: (l) => lines.push(l) });
  const s = sess('c0ffee12-x', 'idle');
  assert.equal(src.settleState('c0ffee12-x'), 'none');
  src.apply([s]);
  src.apply([s]);
  assert.deepEqual(lines, ['agents c0ffee12 pending=0->2 alive=1 fresh=2 ledger=3']);
  assert.equal(src.settleState('c0ffee12-x'), 'off');
  // Agents end: pending 2->0 and a settle starts, once.
  counts['T:c0ffee12-x'] = 0;
  stats.alive = 0; stats.fresh = 0; stats.ledger = 0;
  clock = 2000;
  src.apply([s]);
  clock = 4000;
  src.apply([s]);
  assert.deepEqual(lines.slice(1), ['agents c0ffee12 pending=2->0 alive=0 fresh=0 ledger=0', 'agents c0ffee12 settle=start']);
  assert.equal(src.settleState('c0ffee12-x'), 'on');
  clock = 8000;
  src.apply([s]);
  assert.equal(lines[3], 'agents c0ffee12 settle=end why=elapsed');
  assert.equal(lines.length, 4);
  assert.equal(src.settleState('c0ffee12-x'), 'none');
  // Everything a line holds is an id prefix, a word or a count.
  for (const l of lines) assert.doesNotMatch(l, /Name|T:|D:|[\\]/);
});

test('agent source diag: agents returning end the settle; a busy registry ends it too; a throwing diag is ignored', () => {
  const counts = { 'T:s1': 1 };
  const lines = [];
  let clock = 0;
  const src = createAgentSource(fakeReader(counts), filesFor, () => {}, { now: () => clock, diag: (l) => lines.push(l) });
  src.apply([sess('s1', 'idle')]);
  counts['T:s1'] = 0;
  clock = 1000;
  src.apply([sess('s1', 'idle')]);
  counts['T:s1'] = 1;
  clock = 2000;
  src.apply([sess('s1', 'idle')]);
  assert.ok(lines.includes('agents s1 settle=end why=agents'));
  counts['T:s1'] = 0;
  clock = 3000;
  src.apply([sess('s1', 'idle')]);
  clock = 4000;
  src.apply([sess('s1', 'busy')]);
  assert.equal(lines.filter((l) => l.includes('settle=start')).length, 2);
  assert.ok(lines.includes('agents s1 settle=end why=registry'));
  const bad = createAgentSource(fakeReader({ 'T:s2': 1 }), filesFor, () => {}, { diag: () => { throw new Error('diag'); } });
  assert.equal(bad.apply([sess('s2', 'idle')])[0].status, 'busy');
});
