'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hostName,
  handoverNotice,
  arrowAction,
  arrowText,
  arrowAfterRelease,
  clickAllowed,
  MIN_AGE_MS,
} = require('../src/renderer/prompt');
const { earlyAbort, abortNoticeText, EARLY_MS } = require('../src/main/early-abort');

test('hostName: terminal host, unknown terminal host, desktop', () => {
  assert.equal(hostName('terminal', 'Zed'), 'Zed');
  assert.equal(hostName('terminal', '  VS Code '), 'VS Code');
  assert.equal(hostName('terminal', ''), 'the terminal');
  assert.equal(hostName('terminal', undefined), 'the terminal');
  assert.equal(hostName('terminal', 42), 'the terminal');
  assert.equal(hostName('desktop', 'Zed'), 'Claude Desktop');
  assert.equal(hostName(undefined, undefined), 'Claude Desktop');
});

test('handoverNotice: shows only for waiting without a held prompt', () => {
  const n = handoverNotice({ status: 'waiting', hasPrompt: false, source: 'terminal', host: 'Zed' });
  assert.deepEqual(n, {
    host: 'Zed',
    listLine: 'Answer waiting in Zed',
    kicker: 'Waiting for your answer',
    text: 'This question is open in Zed. Ephor is not holding it.',
    button: 'Open Zed',
  });
  assert.equal(handoverNotice({ status: 'waiting', hasPrompt: true, source: 'terminal', host: 'Zed' }), null);
  assert.equal(handoverNotice({ status: 'busy', hasPrompt: false, source: 'terminal', host: 'Zed' }), null);
  assert.equal(handoverNotice({ status: 'idle', hasPrompt: false }), null);
  assert.equal(handoverNotice(null), null);
  assert.equal(handoverNotice('x'), null);
});

test('handoverNotice: desktop and unknown terminal host', () => {
  const d = handoverNotice({ status: 'waiting', hasPrompt: false, source: 'desktop' });
  assert.equal(d.listLine, 'Answer waiting in Claude Desktop');
  assert.equal(d.button, 'Open Claude Desktop');
  const t = handoverNotice({ status: 'waiting', hasPrompt: false, source: 'terminal', host: '' });
  assert.equal(t.text, 'This question is open in the terminal. Ephor is not holding it.');
  assert.equal(t.button, 'Open the terminal');
});

test('arrowAction: release while a prompt is held, else open', () => {
  assert.equal(arrowAction({ hasHeldPrompt: true }), 'release');
  assert.equal(arrowAction({ hasHeldPrompt: false }), 'open');
  assert.equal(arrowAction({}), 'open');
  assert.equal(arrowAction(null), 'open');
  assert.equal(arrowAction({ hasHeldPrompt: 'yes' }), 'open');
});

test('arrowText: tooltip while a prompt is held', () => {
  assert.equal(arrowText({ hasHeldPrompt: true, source: 'terminal', host: 'Zed' }), 'Release the question and open Zed');
  assert.equal(arrowText({ hasHeldPrompt: true, source: 'desktop' }), 'Release the question and open Claude Desktop');
  assert.equal(arrowText({ hasHeldPrompt: true, source: 'terminal', host: '' }), 'Release the question and open the terminal');
  assert.equal(
    arrowText({ hasHeldPrompt: true, hasPrompt: true, status: 'waiting', source: 'terminal', host: 'Zed' }),
    'Release the question and open Zed',
    'a held prompt wins over the wait',
  );
  assert.equal(arrowText({ hasHeldPrompt: false, source: 'terminal', host: 'Zed' }), null);
});

test('arrowText: a waiting session without a held card opens its app to answer', () => {
  assert.equal(
    arrowText({ hasHeldPrompt: false, hasPrompt: false, status: 'waiting', source: 'terminal', host: 'Zed' }),
    'Open Zed to answer',
  );
  assert.equal(
    arrowText({ hasHeldPrompt: false, hasPrompt: false, status: 'waiting', source: 'desktop' }),
    'Open Claude Desktop to answer',
  );
  assert.equal(arrowText({ status: 'waiting', source: 'terminal', host: ' ' }), 'Open the terminal to answer');
  // The same host wording as the handover notice.
  const n = handoverNotice({ status: 'waiting', hasPrompt: false, source: 'terminal', host: 'VS Code' });
  assert.equal(arrowText({ status: 'waiting', source: 'terminal', host: 'VS Code' }), `Open ${n.host} to answer`);
  // A card still in the snapshot (answered or released here, not dropped
  // yet), or a session that does not wait: the plain wording stays.
  assert.equal(arrowText({ hasHeldPrompt: false, hasPrompt: true, status: 'waiting', source: 'desktop' }), null);
  assert.equal(arrowText({ hasHeldPrompt: false, hasPrompt: false, status: 'busy', source: 'desktop' }), null);
  assert.equal(arrowText({ hasHeldPrompt: false, hasPrompt: false, status: 'idle', source: 'desktop' }), null);
  assert.equal(arrowText(null), null);
});

test('arrowAfterRelease: a release main refused falls back to a plain open', () => {
  assert.equal(arrowAfterRelease('ok'), 'none', 'main opens the app after its own release');
  assert.equal(arrowAfterRelease('failed'), 'open', 'the hold ended just before the click');
  assert.equal(arrowAfterRelease(undefined), 'open');
  assert.equal(arrowAfterRelease(null), 'open');
  assert.equal(arrowAfterRelease('weird'), 'open');
});

test('clickAllowed: the 500 ms early-click guard', () => {
  assert.equal(MIN_AGE_MS, 500);
  assert.equal(clickAllowed(1000, 1499), false);
  assert.equal(clickAllowed(1000, 1500), true);
  assert.equal(clickAllowed(1000, 900), false);
  assert.equal(clickAllowed(NaN, 2000), false);
  assert.equal(clickAllowed('a', 2000), false);
});

test('earlyAbort: only a client close at least 2 s before the hold ends', () => {
  assert.equal(EARLY_MS, 2000);
  assert.equal(earlyAbort({ elapsedMs: 70000, holdMs: 290000, reason: 'closed' }), 70);
  assert.equal(earlyAbort({ elapsedMs: 70400, holdMs: 290000, reason: 'closed' }), 70);
  assert.equal(earlyAbort({ elapsedMs: 70600, holdMs: 290000, reason: 'closed' }), 70);
  // exactly 2 s early counts, 1 ms less does not
  assert.equal(earlyAbort({ elapsedMs: 288000, holdMs: 290000, reason: 'closed' }), 288);
  assert.equal(earlyAbort({ elapsedMs: 288001, holdMs: 290000, reason: 'closed' }), null);
  assert.equal(earlyAbort({ elapsedMs: 290000, holdMs: 290000, reason: 'closed' }), null);
  assert.equal(earlyAbort({ elapsedMs: 0, holdMs: 290000, reason: 'closed' }), 0);
});

test('earlyAbort: never for other reasons or bad input', () => {
  for (const reason of ['answered', 'released', 'timeout', 'cancelled', 'quit', undefined, '']) {
    assert.equal(earlyAbort({ elapsedMs: 1000, holdMs: 290000, reason }), null);
  }
  assert.equal(earlyAbort(null), null);
  assert.equal(earlyAbort({ elapsedMs: -5, holdMs: 290000, reason: 'closed' }), null);
  assert.equal(earlyAbort({ elapsedMs: NaN, holdMs: 290000, reason: 'closed' }), null);
  assert.equal(earlyAbort({ elapsedMs: 1000, holdMs: 0, reason: 'closed' }), null);
  assert.equal(earlyAbort({ elapsedMs: 1000, holdMs: 'x', reason: 'closed' }), null);
});

test('abortNoticeText', () => {
  assert.equal(
    abortNoticeText(70),
    'Claude Code closed a question after 70 s. Raise the hook timeout above the hold.',
  );
});
