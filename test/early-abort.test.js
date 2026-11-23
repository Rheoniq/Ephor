'use strict';

// The hook timeout notice: which ended holds count, and when the notice is
// pushed. The first part drives createAbortWatch with an injected clock; the
// second wires it to the real hook server (port 0, never 47821) the way main
// does, so the order of main's own ends is checked against the server's
// synchronous onCancel.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const {
  createAbortWatch,
  endHold,
  abortNoticeText,
  DECIDE_MS,
  EARLY_MS,
} = require('../src/main/early-abort');
const { createHookServer } = require('../src/main/hooks');
const { createHold, promptView, buildResponse, releasePrompt } = require('../src/main/answering');

const HOLD_MS = 60000;

// A watch on a hand-moved clock, a table with one held entry, and a push
// spy. `push` returns what `pushResult` says (false stands for quiet mode).
function setup({ heldAt = 0 } = {}) {
  let t = heldAt;
  const watch = createAbortWatch({ now: () => t });
  const prompts = new Map();
  const entry = { id: 'p1', sessionId: 's1', heldAt };
  prompts.set(entry.id, entry);
  const pushed = [];
  let pushResult = true;
  const push = (text) => {
    pushed.push(text);
    return pushResult;
  };
  return {
    watch,
    prompts,
    entry,
    pushed,
    push,
    at: (ms) => {
      t = ms;
    },
    quiet: (on) => {
      pushResult = !on;
    },
    // Holds the same session again with a new entry, for a second round.
    holdAgain(id, at) {
      const e = { id, sessionId: 's1', heldAt: at };
      prompts.set(id, e);
      return e;
    },
  };
}

const waiting = () => ({ status: 'waiting', held: false, dismissed: false });
const busy = () => ({ status: 'busy', held: false, dismissed: false });

test('a client close long before the hold ends, then the session waits without a card: one notice', () => {
  const h = setup();
  h.at(20400);
  const entry = h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'busy' });
  assert.equal(entry, h.entry, 'the entry that was still held comes back');
  assert.equal(h.prompts.has('p1'), false, 'and leaves the table');
  assert.equal(h.watch.hasCandidate(), true);
  h.at(20600);
  assert.equal(h.watch.refreshed(waiting, h.push), true);
  assert.deepEqual(h.pushed, [abortNoticeText(20)]);
  assert.equal(h.watch.wasShown(), true);
  assert.equal(h.watch.hasCandidate(), false);
  // Later refreshes push nothing more.
  assert.equal(h.watch.refreshed(waiting, h.push), false);
  assert.equal(h.pushed.length, 1);
});

test('a session not waiting yet at the first refresh still gets the notice within the window', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'busy' });
  h.at(20150);
  assert.equal(h.watch.refreshed(busy, h.push), false, 'the registry has not turned waiting yet');
  assert.equal(h.watch.hasCandidate(), true);
  h.at(20000 + DECIDE_MS);
  assert.equal(h.watch.refreshed(waiting, h.push), true, 'waiting at the last moment of the window');
  assert.equal(h.pushed.length, 1);
});

test('a session that never waits within the window gets no notice, not even later', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'busy' });
  h.at(21000);
  assert.equal(h.watch.refreshed(busy, h.push), false);
  h.at(20000 + DECIDE_MS + 1);
  assert.equal(h.watch.refreshed(waiting, h.push), false, 'too late: the window is over');
  assert.equal(h.watch.hasCandidate(), false);
  assert.deepEqual(h.pushed, []);
});

test('a session that was waiting at the close and is no longer waiting gets no notice', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  h.at(20150);
  assert.equal(h.watch.refreshed(busy, h.push), false, 'answered in the app');
  assert.equal(h.watch.hasCandidate(), false, 'dropped at once');
  h.at(20500);
  assert.equal(h.watch.refreshed(waiting, h.push), false, 'a later wait is another question');
  assert.deepEqual(h.pushed, []);
});

test('a session that left, was dismissed or is held again gets no notice', () => {
  for (const state of [
    () => null,
    () => ({ status: 'waiting', held: false, dismissed: true }),
    () => ({ status: 'waiting', held: true, dismissed: false }),
  ]) {
    const h = setup();
    h.at(20000);
    h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
    h.at(20150);
    assert.equal(h.watch.refreshed(state, h.push), false, String(state()));
    assert.equal(h.watch.hasCandidate(), false);
    assert.deepEqual(h.pushed, []);
    assert.equal(h.watch.wasShown(), false, 'the once is not used up');
  }
});

test('a dismissed session does not use up the once: the next early close shows', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  h.watch.refreshed(() => ({ status: 'waiting', held: false, dismissed: true }), h.push);
  h.holdAgain('p2', 30000);
  h.at(45000);
  h.watch.serverEnded(h.prompts, 'p2', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(h.watch.refreshed(waiting, h.push), true);
  assert.deepEqual(h.pushed, [abortNoticeText(15)]);
});

test('quiet mode suppresses the notice without using up the once', () => {
  const h = setup();
  h.quiet(true);
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(h.watch.refreshed(waiting, h.push), false, 'the push was refused');
  assert.equal(h.pushed.length, 1, 'main was asked once');
  assert.equal(h.watch.wasShown(), false);
  assert.equal(h.watch.hasCandidate(), false, 'that close is used up');
  h.quiet(false);
  h.holdAgain('p2', 30000);
  h.at(50000);
  h.watch.serverEnded(h.prompts, 'p2', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(h.watch.refreshed(waiting, h.push), true);
  assert.deepEqual(h.pushed, [abortNoticeText(20), abortNoticeText(20)]);
  assert.equal(h.watch.wasShown(), true);
});

test('a push that throws counts as not pushed', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(
    h.watch.refreshed(waiting, () => {
      throw new Error('toast');
    }),
    false,
  );
  assert.equal(h.watch.wasShown(), false);
});

test('a lookup that throws drops the candidate quietly', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(
    h.watch.refreshed(() => {
      throw new Error('lookup');
    }, h.push),
    false,
  );
  assert.equal(h.watch.hasCandidate(), false);
  assert.deepEqual(h.pushed, []);
});

test('a second early close after a shown notice says nothing', () => {
  const h = setup();
  h.at(20000);
  h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
  assert.equal(h.watch.refreshed(waiting, h.push), true);
  h.holdAgain('p2', 30000);
  h.at(40000);
  assert.equal(h.watch.serverEnded(h.prompts, 'p2', { quitting: false, holdMs: HOLD_MS, status: 'waiting' }).id, 'p2');
  assert.equal(h.prompts.has('p2'), false);
  assert.equal(h.watch.hasCandidate(), false);
  assert.equal(h.watch.refreshed(waiting, h.push), false);
  assert.equal(h.pushed.length, 1);
});

test("the server's own hold timer (at holdMs) is no early close", () => {
  const h = setup();
  for (const at of [HOLD_MS, HOLD_MS + 5, HOLD_MS - EARLY_MS + 1]) {
    h.prompts.set('p1', h.entry);
    h.at(at);
    h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' });
    assert.equal(h.watch.hasCandidate(), false, String(at));
  }
  assert.equal(h.watch.refreshed(waiting, h.push), false);
  assert.deepEqual(h.pushed, []);
});

test('quitting ends holds with no candidate', () => {
  const h = setup();
  h.at(20000);
  assert.equal(h.watch.serverEnded(h.prompts, 'p1', { quitting: true, holdMs: HOLD_MS, status: 'waiting' }), h.entry);
  assert.equal(h.prompts.has('p1'), false);
  assert.equal(h.watch.hasCandidate(), false);
});

test('a hold main already took out of the table is nothing to the watch', () => {
  const h = setup();
  h.prompts.delete('p1');
  h.at(20000);
  assert.equal(h.watch.serverEnded(h.prompts, 'p1', { quitting: false, holdMs: HOLD_MS, status: 'waiting' }), null);
  assert.equal(h.watch.hasCandidate(), false);
  assert.equal(h.watch.refreshed(waiting, h.push), false);
});

test('serverEnded and refreshed survive junk', () => {
  const watch = createAbortWatch({ now: () => 0 });
  assert.equal(watch.serverEnded(null, 'x', {}), null);
  assert.equal(watch.serverEnded(new Map(), 'x', null), null);
  const prompts = new Map([['p', { id: 'p', sessionId: 's', heldAt: -20000 }]]);
  assert.equal(watch.serverEnded(prompts, 'p', null).id, 'p', 'no context: removed, no candidate');
  assert.equal(watch.hasCandidate(), false);
  assert.equal(watch.refreshed(null, null), false);
});

test('endHold takes the entry out of the table before the server is told', () => {
  const prompts = new Map([['p1', { id: 'p1', sessionId: 's1' }]]);
  const seen = [];
  const removed = endHold(prompts, prompts.get('p1'), (sessionId) => seen.push([sessionId, prompts.has('p1')]));
  assert.equal(removed, true);
  assert.deepEqual(seen, [['s1', false]]);
  assert.equal(endHold(prompts, { id: 'p1', sessionId: 's1' }, () => {}), false, 'already gone');
  assert.equal(endHold(prompts, null, () => {}), false);
  assert.equal(endHold(null, { id: 'p1' }, () => {}), false);
  // Without a server it only removes.
  prompts.set('p2', { id: 'p2', sessionId: 's2' });
  assert.equal(endHold(prompts, prompts.get('p2'), null), true);
  assert.equal(prompts.size, 0);
});

// --- Wired to the real hook server, as main wires it -----------------------

const TOKEN = 'c3'.repeat(32);
const SESSION = 'c0ffee12-3456-4789-abcd-ef0123456789';

function askBody() {
  return {
    session_id: SESSION,
    transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl',
    cwd: 'C:\\Users\\x\\TEST',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Pick one?',
          header: 'Pick',
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
          multiSelect: false,
        },
      ],
    },
  };
}

// Main's table, watch and callbacks around a real server on port 0. The
// session reads 'waiting' (the question stays open in the app) unless a
// test changes `state.status`.
async function startMain(t, { holdMs = HOLD_MS } = {}) {
  const prompts = new Map();
  const watch = createAbortWatch({ now: () => performance.now() });
  const events = new EventEmitter();
  const state = { quitting: false, status: 'waiting' };
  const hooks = createHookServer({
    token: TOKEN,
    port: 0,
    holdMs,
    canHold: () => true,
    findBuddy: () => SESSION,
    onPrompt: ({ id, sessionId, parsed }) => {
      const view = promptView(parsed);
      prompts.set(id, createHold({ id, sessionId, parsed, view, now: performance.now(), holdMs }));
      events.emit('prompt', id);
    },
    onCancel: (id) => {
      watch.serverEnded(prompts, id, { quitting: state.quitting, holdMs, status: state.status });
      events.emit('cancel', id);
    },
  });
  t.after(() => hooks.stop());
  assert.equal(await hooks.start(), 'listening');
  const port = hooks.address().port;

  // Sends the question and waits until it is held. Returns its id, the
  // client request and a promise of the status code.
  async function hold() {
    const seen = once(events, 'prompt', { signal: AbortSignal.timeout(2000) });
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/hook',
      headers: { 'x-huddle-token': TOKEN, 'content-type': 'application/json' },
      agent: false,
    });
    const status = new Promise((resolve) => {
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve('closed'));
    });
    req.end(JSON.stringify(askBody()));
    const [id] = await seen;
    return { id, req, status };
  }

  // One refresh as main runs it: the session's state and a push that works.
  const pushed = [];
  function refresh() {
    return watch.refreshed(
      () => ({ status: state.status, held: [...prompts.values()].some((e) => e.sessionId === SESSION), dismissed: false }),
      (text) => {
        pushed.push(text);
        return true;
      },
    );
  }
  return { hooks, prompts, watch, events, state, hold, refresh, pushed };
}

test('main: a hold Claude Code closes early, with the question still open, shows the notice', async (t) => {
  const m = await startMain(t);
  const { id, req, status } = await m.hold();
  const cancelled = once(m.events, 'cancel', { signal: AbortSignal.timeout(2000) });
  req.destroy();
  assert.deepEqual(await cancelled, [id]);
  await status;
  assert.equal(m.prompts.size, 0);
  assert.equal(m.watch.hasCandidate(), true);
  assert.equal(m.refresh(), true);
  assert.equal(m.pushed.length, 1);
  assert.match(m.pushed[0], /^Claude Code closed a question after 0 s\./);
});

test('main: an early close whose session no longer waits shows nothing', async (t) => {
  const m = await startMain(t);
  const { req, status } = await m.hold();
  const cancelled = once(m.events, 'cancel', { signal: AbortSignal.timeout(2000) });
  req.destroy();
  await cancelled;
  await status;
  m.state.status = 'busy';
  assert.equal(m.refresh(), false);
  assert.equal(m.watch.hasCandidate(), false);
  assert.deepEqual(m.pushed, []);
});

// Every hold main ends on its own goes through cancelHold (endHold):
// Ctrl+Alt+H or the Hide button, a collapse by hand, quiet mode, a
// dismissal, the app answered first, terminal answering turned off, a
// crashed or hung panel page.
for (const cause of ['hidden', 'collapsed', 'quiet', 'dismissed', 'answered in the app', 'terminal answering off', 'page crashed']) {
  test(`main: a hold main ends itself (${cause}) is no early close`, async (t) => {
    const m = await startMain(t);
    const { id, status } = await m.hold();
    let cancelSeen = false;
    m.events.once('cancel', () => {
      cancelSeen = true;
    });
    endHold(m.prompts, m.prompts.get(id), (sessionId) => m.hooks.cancelSession(sessionId));
    assert.equal(cancelSeen, true, 'the server called onCancel inside cancelSession');
    assert.equal(await status, 204);
    assert.equal(m.watch.hasCandidate(), false);
    assert.equal(m.refresh(), false);
    assert.deepEqual(m.pushed, []);
  });
}

test('main: telling the server before taking the entry out (the old order) would count it', async (t) => {
  // Pins what endHold prevents: the server's onCancel runs inside
  // cancelSession and finds the entry still there.
  const m = await startMain(t);
  const { id, status } = await m.hold();
  const entry = m.prompts.get(id);
  m.hooks.cancelSession(entry.sessionId);
  m.prompts.delete(entry.id);
  await status;
  assert.equal(m.watch.hasCandidate(), true);
});

test('main: an answer from the panel is no early close', async (t) => {
  const m = await startMain(t);
  const { id, status } = await m.hold();
  const entry = m.prompts.get(id);
  const response = buildResponse(entry.parsed, { id, kind: 'ask', answers: { 'Pick one?': 'A' } });
  assert.ok(response);
  m.prompts.delete(id);
  assert.equal(m.hooks.resolve(id, response), true);
  assert.equal(await status, 200);
  assert.equal(m.watch.hasCandidate(), false);
  assert.equal(m.refresh(), false);
});

test('main: a release (button or arrow) is no early close', async (t) => {
  const m = await startMain(t);
  const { id, status } = await m.hold();
  const released = releasePrompt({
    id,
    prompts: m.prompts,
    resolve: (promptId) => m.hooks.resolve(promptId, null),
    open: () => 'ok',
  });
  assert.equal(released.result, 'ok');
  assert.equal(await status, 204);
  assert.equal(m.watch.hasCandidate(), false);
  assert.equal(m.refresh(), false);
});

test("main: the server's hold timer is no early close", async (t) => {
  const m = await startMain(t, { holdMs: 50 });
  const { id, status } = await m.hold();
  const cancelled = once(m.events, 'cancel', { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(await cancelled, [id]);
  assert.equal(await status, 204);
  assert.equal(m.watch.hasCandidate(), false);
  assert.equal(m.refresh(), false);
});

test('main: quitting ends holds with no notice', async (t) => {
  const m = await startMain(t);
  const { status } = await m.hold();
  m.state.quitting = true;
  await m.hooks.stop();
  assert.equal(await status, 204);
  assert.equal(m.prompts.size, 0);
  assert.equal(m.watch.hasCandidate(), false);
  assert.equal(m.refresh(), false);
});
