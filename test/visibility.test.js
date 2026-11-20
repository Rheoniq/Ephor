'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVisibility } = require('../src/main/visibility');

const fresh = () => createVisibility({ collapsed: false, quiet: false });

test('toggleHidden twice returns to visible', () => {
  const v = fresh();
  assert.equal(v.isHidden(), false);
  v.toggleHidden();
  assert.equal(v.isHidden(), true);
  v.toggleHidden();
  assert.equal(v.isHidden(), false);
});

test('shouldShowWindow needs sessions and not hidden', () => {
  const v = fresh();
  assert.equal(v.shouldShowWindow(0), false);
  assert.equal(v.shouldShowWindow(2), true);
  v.toggleHidden();
  assert.equal(v.shouldShowWindow(2), false);
});

test('canHold is false when hidden', () => {
  const v = fresh();
  v.toggleHidden();
  assert.equal(v.canHold(), false);
});

test('canHold is false when quiet', () => {
  const v = fresh();
  v.setQuiet(true);
  assert.equal(v.isQuiet(), true);
  assert.equal(v.canHold(), false);
});

test('canHold is true when only collapsed', () => {
  const v = fresh();
  v.setCollapsed(true);
  assert.equal(v.isCollapsed(), true);
  assert.equal(v.canHold(), true);
});

test('initial state is taken from the argument', () => {
  const v = createVisibility({ collapsed: true, quiet: true });
  assert.equal(v.isCollapsed(), true);
  assert.equal(v.isQuiet(), true);
  assert.equal(v.isHidden(), false);
});
