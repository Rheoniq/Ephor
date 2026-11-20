const test = require('node:test');
const assert = require('node:assert');
const { createDismissals } = require('../src/main/dismissals');

test('undismissed sessions are always visible', () => {
  const d = createDismissals();
  for (const s of ['busy', 'waiting', 'idle']) assert.strictEqual(d.visible('a', s), true);
});

test('dismissed idle session stays hidden while idle', () => {
  const d = createDismissals();
  d.dismiss('a', 'idle');
  assert.strictEqual(d.visible('a', 'idle'), false);
  assert.strictEqual(d.visible('a', 'idle'), false);
});

test('dismissed session stays hidden while status unchanged', () => {
  const d = createDismissals();
  d.dismiss('a', 'waiting');
  assert.strictEqual(d.visible('a', 'waiting'), false);
});

test('change to idle keeps it hidden', () => {
  const d = createDismissals();
  d.dismiss('a', 'busy');
  assert.strictEqual(d.visible('a', 'idle'), false);
});

for (const s of ['busy', 'waiting']) {
  test(`idle -> ${s} becomes visible and clears dismissal`, () => {
    const d = createDismissals();
    d.dismiss('a', 'idle');
    assert.strictEqual(d.visible('a', s), true);
    assert.strictEqual(d.visible('a', 'idle'), true);
    d.dismiss('a', 'idle');
    assert.strictEqual(d.visible('a', 'idle'), false);
  });
}

test('busy -> waiting becomes visible', () => {
  const d = createDismissals();
  d.dismiss('a', 'busy');
  assert.strictEqual(d.visible('a', 'waiting'), true);
});

test('prune forgets sessions not in liveIds', () => {
  const d = createDismissals();
  d.dismiss('a', 'idle');
  d.dismiss('b', 'idle');
  d.prune(['b']);
  assert.strictEqual(d.visible('a', 'idle'), true);
  assert.strictEqual(d.visible('b', 'idle'), false);
});

for (const s of ['busy', 'waiting']) {
  test(`dismiss at ${s}, idle, then ${s} again becomes visible and clears`, () => {
    const d = createDismissals();
    d.dismiss('a', s);
    assert.strictEqual(d.visible('a', 'idle'), false);
    assert.strictEqual(d.visible('a', s), true);
    assert.strictEqual(d.visible('a', 'idle'), true);
  });
}

test('repeated dismiss: latest wins', () => {
  const d = createDismissals();
  d.dismiss('a', 'idle');
  d.dismiss('a', 'busy');
  assert.strictEqual(d.visible('a', 'busy'), false);
  assert.strictEqual(d.visible('a', 'waiting'), true);
});

test('unknown id is visible', () => {
  assert.strictEqual(createDismissals().visible('nope', 'idle'), true);
});
