'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotHold } = require('../src/renderer/hold');

function setup() {
  const applied = [];
  const hold = createSnapshotHold((s) => applied.push(s));
  return { hold, applied };
}

test('applies a snapshot at once when no pointer is down', () => {
  const { hold, applied } = setup();
  hold.push('a');
  assert.deepEqual(applied, ['a']);
});

test('holds snapshots while the pointer is down and applies only the latest after release', () => {
  const { hold, applied } = setup();
  hold.down();
  hold.push('a');
  hold.push('b');
  assert.deepEqual(applied, []);
  hold.up();
  hold.flush();
  assert.deepEqual(applied, ['b']);
  hold.flush();
  assert.deepEqual(applied, ['b'], 'a second flush applies nothing');
});

test('flush does nothing while a new press is down', () => {
  const { hold, applied } = setup();
  hold.down();
  hold.push('a');
  hold.up();
  hold.down(); // second press before the deferred flush runs
  hold.flush();
  assert.deepEqual(applied, []);
  hold.up();
  hold.flush();
  assert.deepEqual(applied, ['a']);
});

test('release without a held snapshot applies nothing', () => {
  const { hold, applied } = setup();
  hold.down();
  hold.up();
  hold.flush();
  assert.deepEqual(applied, []);
});
