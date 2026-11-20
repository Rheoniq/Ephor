'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openClaudeDesktop, deepLinkUrl } = require('../src/main/focus');

const ID = 'local_dd995c2b-7cf2-44e3-886e-23b06704a53d';

function fakeDeps({ open = 'ok', focus = true } = {}) {
  const calls = { open: [], focus: 0 };
  return {
    calls,
    deps: {
      openExternal: async (url) => {
        calls.open.push(url);
        if (open === 'reject') throw new Error('no handler');
      },
      focusWindow: async () => {
        calls.focus += 1;
        if (focus === 'reject') throw new Error('spawn failed');
        return focus;
      },
    },
  };
}

test('builds the verified continue deep link from the session id', () => {
  assert.equal(deepLinkUrl(ID), `claude://code/continue?session=${ID}`);
});

test('uses the deep link when it opens', async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await openClaudeDesktop(ID, deps), 'deeplink');
  assert.deepEqual(calls.open, [`claude://code/continue?session=${ID}`]);
  assert.equal(calls.focus, 0);
});

test('falls back to focusing the window when the deep link fails', async () => {
  const { deps, calls } = fakeDeps({ open: 'reject' });
  assert.equal(await openClaudeDesktop(ID, deps), 'focus');
  assert.equal(calls.focus, 1);
});

test('returns failed when the deep link and focus both fail', async () => {
  const a = fakeDeps({ open: 'reject', focus: false });
  assert.equal(await openClaudeDesktop(ID, a.deps), 'failed');
  const b = fakeDeps({ open: 'reject', focus: 'reject' });
  assert.equal(await openClaudeDesktop(ID, b.deps), 'failed');
});

test('invalid ids return failed without calling anything', async () => {
  const bad = [
    undefined,
    null,
    42,
    '',
    'local_',
    'local_DD995C2B-7CF2-44E3-886E-23B06704A53D',
    `${ID}&q=hi`,
    `${ID}\n`,
    'session_abc',
    `x${ID}`,
  ];
  for (const id of bad) {
    const { deps, calls } = fakeDeps();
    assert.equal(await openClaudeDesktop(id, deps), 'failed', String(id));
    assert.equal(calls.open.length, 0);
    assert.equal(calls.focus, 0);
  }
});
