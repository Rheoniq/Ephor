'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeEvent, readSteps, TAIL_BYTES } = require('../src/main/steps');

const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-sample.jsonl');
const fixtureLines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);

function toolUse(name, input) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input }] },
  });
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-steps-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('Edit tool use renders as "Edit <path>"', () => {
  assert.equal(summarizeEvent(fixtureLines[2]), 'Edit src/a.js');
});

test('Bash tool use renders as "Ran: <command>"', () => {
  assert.equal(summarizeEvent(fixtureLines[4]), 'Ran: npm test');
});

test('PowerShell tool use also renders as "Ran: <command>"', () => {
  assert.equal(summarizeEvent(toolUse('PowerShell', { command: 'Get-ChildItem' })), 'Ran: Get-ChildItem');
});

test('AskUserQuestion renders as "Asked you a question"', () => {
  assert.equal(summarizeEvent(fixtureLines[5]), 'Asked you a question');
});

test('queue-operation, malformed, user message and tool result return null', () => {
  assert.equal(summarizeEvent(fixtureLines[0]), null);
  assert.equal(summarizeEvent(fixtureLines[6]), null);
  assert.equal(summarizeEvent(fixtureLines[1]), null);
  assert.equal(summarizeEvent(fixtureLines[3]), null);
  assert.equal(summarizeEvent(''), null);
  assert.equal(summarizeEvent('null'), null);
});

test('long summaries are truncated to 80 chars with an ellipsis', () => {
  const long = 'echo ' + 'a'.repeat(200);
  const s = summarizeEvent(toolUse('Bash', { command: long }));
  assert.equal(s.length, 80);
  assert.ok(s.endsWith('…'));
  assert.ok(s.startsWith('Ran: echo aaa'));
});

test('a long path is cut from the left so the tool name and filename stay visible', () => {
  const head = 'C:\\Users\\someone\\projects\\';
  const tail = '\\src\\main\\x.js';
  const p = head + 'd'.repeat(120 - head.length - tail.length) + tail;
  assert.equal(p.length, 120);
  const s = summarizeEvent(toolUse('Edit', { file_path: p }));
  assert.ok(s.length <= 80, `length ${s.length}`);
  assert.ok(s.startsWith('Edit …'), s);
  assert.ok(s.endsWith('\\src\\main\\x.js'), s);
});

test('a short path is shown in full', () => {
  assert.equal(summarizeEvent(toolUse('Read', { file_path: 'C:\\a\\b.js' })), 'Read C:\\a\\b.js');
});

test('multi-line commands are collapsed onto one line', () => {
  assert.equal(summarizeEvent(toolUse('Bash', { command: 'cd x &&\n  npm test' })), 'Ran: cd x && npm test');
});

test('summaries never include message text or tool output', () => {
  const all = fixtureLines.map(summarizeEvent).filter(Boolean).join('|');
  assert.ok(!all.includes('PRIVATE'));
  assert.ok(!all.includes('Sure, editing'));
  assert.ok(!all.includes('widget'));
});

test('readSteps on the fixture returns summaries oldest first', () => {
  assert.deepEqual(readSteps(FIXTURE, 10), ['Edit src/a.js', 'Ran: npm test', 'Asked you a question']);
  assert.deepEqual(readSteps(FIXTURE, 2), ['Ran: npm test', 'Asked you a question']);
});

test('readSteps on a missing file returns []', () => {
  assert.deepEqual(readSteps(path.join(dir, 'nope.jsonl'), 5), []);
});

test('readSteps on a 5 MB file returns the last n and reads only the tail', () => {
  const file = path.join(dir, 'big.jsonl');
  const filler = JSON.stringify({ type: 'queue-operation', operation: 'x'.repeat(200) }) + '\n';
  const parts = [toolUse('Edit', { file_path: 'EARLY.js' }) + '\n'];
  let size = parts[0].length;
  while (size < 5 * 1024 * 1024) { parts.push(filler); size += filler.length; }
  for (let i = 1; i <= 5; i++) parts.push(toolUse('Edit', { file_path: `f${i}.js` }) + '\n');
  fs.writeFileSync(file, parts.join(''));
  assert.ok(fs.statSync(file).size > 5 * 1024 * 1024);

  const origReadSync = fs.readSync;
  const origReadFileSync = fs.readFileSync;
  let bytesRead = 0;
  fs.readSync = function (...args) {
    const r = origReadSync.apply(this, args);
    bytesRead += r;
    return r;
  };
  fs.readFileSync = () => { throw new Error('readFileSync must not be used'); };
  let steps;
  try {
    steps = readSteps(file, 3);
  } finally {
    fs.readSync = origReadSync;
    fs.readFileSync = origReadFileSync;
  }
  assert.deepEqual(steps, ['Edit f3.js', 'Edit f4.js', 'Edit f5.js']);
  assert.ok(bytesRead <= TAIL_BYTES + 1, `read ${bytesRead} bytes`);
  assert.ok(bytesRead > 0);
});

test('a leading partial line from the tail cut is dropped', () => {
  // The first line is not JSON as a whole, but its suffix is a valid tool-use
  // event. If the cut lands inside the garbage prefix, that suffix must not
  // be summarised.
  const suffix = toolUse('Edit', { file_path: 'partial.js' });
  const first = 'GARBAGE'.repeat(10) + suffix + '\n';
  const last = toolUse('Edit', { file_path: 'last.js' }) + '\n';
  const filler = JSON.stringify({ type: 'queue-operation', p: 'y'.repeat(60) }) + '\n';
  // Size the file so the tail starts 20 bytes into the garbage prefix.
  const bodyLen = TAIL_BYTES - (first.length - 20) - last.length;
  let body = '';
  while (body.length < bodyLen) body += filler;
  body = body.slice(0, bodyLen - 1) + '\n';
  const content = first + body + last;
  const file = path.join(dir, 'cut.jsonl');
  fs.writeFileSync(file, content);
  assert.equal(content.length - TAIL_BYTES, 20);
  // Sanity: the suffix alone would summarise if it were not dropped.
  assert.equal(summarizeEvent(suffix), 'Edit partial.js');
  assert.deepEqual(readSteps(file, 10), ['Edit last.js']);
});

test('a tail cut exactly on a line boundary keeps that first line', () => {
  const kept = toolUse('Edit', { file_path: 'kept.js' }) + '\n';
  const head = JSON.stringify({ type: 'queue-operation', p: 'z'.repeat(50) }) + '\n';
  const filler = JSON.stringify({ type: 'queue-operation', p: 'y'.repeat(60) }) + '\n';
  let body = '';
  while (kept.length + body.length < TAIL_BYTES) body += filler;
  body = body.slice(0, TAIL_BYTES - kept.length - 1) + '\n';
  const content = head + kept + body;
  assert.equal(content.length - TAIL_BYTES, head.length);
  const file = path.join(dir, 'edge.jsonl');
  fs.writeFileSync(file, content);
  assert.deepEqual(readSteps(file, 10), ['Edit kept.js']);
});
