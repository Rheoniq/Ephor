'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagLog, createStateLogger, formatState } = require('../src/main/diag-log');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ephor-diag-'));
}

const base = {
  sessionId: 'c0ffee12-3456-4789-abcd-ef0123456789',
  reg: 'idle',
  pending: 2,
  settle: 'none',
  eff: 'busy',
  finished: false,
  shown: true,
  prompt: false,
  src: 'desktop',
};

test('formatState: the fixed tuple, id cut to 8 characters', () => {
  assert.equal(
    formatState(base),
    'sess c0ffee12 reg=idle pending=2 settle=none eff=busy finished=0 shown=1 prompt=0 src=desktop',
  );
  assert.equal(
    formatState({ ...base, finished: true, shown: false, prompt: true, src: 'terminal', settle: 'on' }),
    'sess c0ffee12 reg=idle pending=2 settle=on eff=busy finished=1 shown=0 prompt=1 src=terminal',
  );
});

test('formatState: odd values never leak text', () => {
  const line = formatState({ sessionId: 'x', reg: 'D:\\some path', pending: -3, settle: 5, eff: null, src: 'a b' });
  assert.equal(line, 'sess x reg=? pending=0 settle=? eff=? finished=0 shown=0 prompt=0 src=?');
  assert.equal(formatState(null), 'sess ? reg=? pending=0 settle=? eff=? finished=0 shown=0 prompt=0 src=?');
});

test('log: appends "<ISO time> <line>" lines', () => {
  const file = path.join(tmp(), 'd.log');
  const l = createDiagLog({ file, now: () => new Date('2026-11-23T10:00:00.000Z') });
  l.log('one');
  l.log('two');
  l.close();
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-11-23T10:00:00.000Z one\n2026-11-23T10:00:00.000Z two\n');
});

test('log: caps a line at 300 characters and strips control characters', () => {
  const file = path.join(tmp(), 'd.log');
  const l = createDiagLog({ file, now: () => new Date(0) });
  l.log('a\nb\r\u0000c\u001b[31md\u2028e');
  l.log('x'.repeat(1000));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '1970-01-01T00:00:00.000Z abc[31mde');
  assert.equal(lines[1].slice('1970-01-01T00:00:00.000Z '.length).length, 300);
});

test('log: rotates to <file>.old past maxBytes and replaces an old .old', () => {
  const dir = tmp();
  const file = path.join(dir, 'd.log');
  fs.writeFileSync(`${file}.old`, 'ancient\n');
  const l = createDiagLog({ file, now: () => new Date(0), maxBytes: 200 });
  for (let i = 0; i < 12; i++) l.log(`line ${i} ${'x'.repeat(20)}`);
  assert.ok(fs.existsSync(`${file}.old`));
  assert.doesNotMatch(fs.readFileSync(`${file}.old`, 'utf8'), /ancient/);
  assert.ok(fs.statSync(file).size <= 200 + 100);
  const all = fs.readFileSync(`${file}.old`, 'utf8') + fs.readFileSync(file, 'utf8');
  assert.match(all, /line 11 /);
});

test('log: a file already past maxBytes at start is rotated on the first write', () => {
  const file = path.join(tmp(), 'd.log');
  fs.writeFileSync(file, 'y'.repeat(500));
  const l = createDiagLog({ file, now: () => new Date(0), maxBytes: 100 });
  l.log('fresh');
  assert.equal(fs.readFileSync(`${file}.old`, 'utf8'), 'y'.repeat(500));
  assert.match(fs.readFileSync(file, 'utf8'), /fresh\n$/);
});

test('log: never throws on an unwritable path, a bad clock or a bad line', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  for (const file of [path.join(blocker, 'sub', 'd.log'), '', undefined, null, dir]) {
    const l = createDiagLog({ file, now: () => new Date(0) });
    assert.doesNotThrow(() => l.log('hello'));
    assert.doesNotThrow(() => l.close());
  }
  const l = createDiagLog({
    file: path.join(dir, 'ok.log'),
    now: () => {
      throw new Error('clock');
    },
  });
  assert.doesNotThrow(() =>
    l.log({
      toString() {
        throw new Error('x');
      },
    }),
  );
  assert.doesNotThrow(() => l.log(undefined));
});

test('state logger: one line per change, plus appeared and left', () => {
  const lines = [];
  const s = createStateLogger((l) => lines.push(l));
  const at = (over) => [{ ...base, ...over }];
  s.observe(at({ reg: 'busy', pending: 0, eff: 'busy' }));
  assert.deepEqual(lines, [
    'sess c0ffee12 appeared',
    'sess c0ffee12 reg=busy pending=0 settle=none eff=busy finished=0 shown=1 prompt=0 src=desktop',
  ]);
  lines.length = 0;
  s.observe(at({ reg: 'busy', pending: 0, eff: 'busy' })); // no change
  assert.deepEqual(lines, []);
  s.observe(at({ reg: 'idle', pending: 2, eff: 'busy' })); // idle, 2 pending
  s.observe(at({ reg: 'idle', pending: 2, eff: 'busy' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /reg=idle pending=2 settle=none eff=busy finished=0/);
  s.observe(at({ reg: 'idle', pending: 0, settle: 'on', eff: 'busy' })); // settle
  assert.match(lines[1], /pending=0 settle=on eff=busy/);
  s.observe(at({ reg: 'idle', pending: 0, settle: 'none', eff: 'idle', finished: true })); // done
  assert.match(lines[2], /settle=none eff=idle finished=1/);
  s.observe(at({ reg: 'idle', pending: 0, settle: 'none', eff: 'idle', finished: true }));
  assert.equal(lines.length, 3);
  s.observe([]);
  assert.equal(lines.length, 4);
  assert.equal(lines[3], 'sess c0ffee12 left');
  s.observe([]);
  assert.equal(lines.length, 4);
});

test('state logger: several sessions are tracked apart; a throwing log is ignored', () => {
  const lines = [];
  const s = createStateLogger((l) => lines.push(l));
  s.observe([base, { ...base, sessionId: 'deadbeef-0000' }]);
  assert.equal(lines.length, 4);
  s.observe([{ ...base, pending: 1 }, { ...base, sessionId: 'deadbeef-0000' }]);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /^sess c0ffee12 .*pending=1/);
  const t = createStateLogger(() => {
    throw new Error('boom');
  });
  assert.doesNotThrow(() => t.observe([base]));
  assert.doesNotThrow(() => t.observe(null));
});
