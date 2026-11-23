'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createViewState,
  cardKind,
  escapeGoesBack,
  backCue,
  returnStep,
  createReturnState,
} = require('../src/renderer/view');

// Snapshot sessions as the view state needs them: an id, an optional prompt
// and a status.
function s(sessionId, extra) {
  return { sessionId, status: 'busy', ...extra };
}

const PROMPT = { id: 'p1', kind: 'ask' };

test('starts on the list', () => {
  const v = createViewState();
  assert.deepEqual(v.current(), { kind: 'list' });
  assert.deepEqual(v.needsYou(), []);
});

test('open shows one session, back returns to the list', () => {
  const v = createViewState();
  v.sync([s('a'), s('b')]);
  v.open('b');
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'b' });
  v.back();
  assert.deepEqual(v.current(), { kind: 'list' });
});

test('opening a session that is not in the list is ignored', () => {
  const v = createViewState();
  v.sync([s('a')]);
  v.open('zzz');
  assert.deepEqual(v.current(), { kind: 'list' });
  v.open('a');
  v.open('zzz');
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' }, 'an unknown id keeps the open view');
  for (const bad of [undefined, null, 42, {}, '']) {
    v.open(bad);
    assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' }, String(bad));
  }
});

test('nothing can be opened before the first sync', () => {
  const v = createViewState();
  v.open('a');
  assert.deepEqual(v.current(), { kind: 'list' });
});

test('current returns a copy, so a caller cannot change the state', () => {
  const v = createViewState();
  v.sync([s('a'), s('b')]);
  v.open('a');
  const cur = v.current();
  cur.sessionId = 'b';
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' });
});

test('sync returns to the list when the open session leaves the snapshot', () => {
  const v = createViewState();
  v.sync([s('a'), s('b')]);
  v.open('a');
  v.sync([s('a'), s('b')]);
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' }, 'still there: stays open');
  v.sync([s('b')]); // ended, dismissed or hidden
  assert.deepEqual(v.current(), { kind: 'list' });
  // Coming back later does not reopen it.
  v.sync([s('a'), s('b')]);
  assert.deepEqual(v.current(), { kind: 'list' });
});

test('sync with an empty or malformed list returns to the list', () => {
  for (const bad of [[], null, undefined, 'x', [null, 42, { sessionId: 7 }]]) {
    const v = createViewState();
    v.sync([s('a')]);
    v.open('a');
    v.sync(bad);
    assert.deepEqual(v.current(), { kind: 'list' }, JSON.stringify(bad));
    assert.deepEqual(v.needsYou(), []);
  }
});

test('a prompt on another session never changes the open view', () => {
  const v = createViewState();
  v.sync([s('a'), s('b')]);
  v.open('a');
  v.sync([s('a'), s('b', { prompt: PROMPT })]);
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' });
  assert.equal(v.onPromptsSettled('b', 1), false);
  assert.equal(v.onPromptsSettled('b', 0), false);
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' });
});

test('a prompt never opens a session from the list either', () => {
  const v = createViewState();
  v.sync([s('a')]);
  v.sync([s('a', { prompt: PROMPT })]);
  assert.deepEqual(v.current(), { kind: 'list' });
  assert.equal(v.onPromptsSettled('a', 1), false);
  assert.equal(v.onPromptsSettled('a', 0), false);
});

test('onPromptsSettled: true once when the open session had a prompt and now has none', () => {
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT })]);
  v.open('a');
  assert.equal(v.onPromptsSettled('a', 1), false, 'still pending');
  v.sync([s('a')]);
  assert.equal(v.onPromptsSettled('a', 0), true, 'answered or released');
  assert.equal(v.onPromptsSettled('a', 0), false, 'only once');
  // The return itself is the renderer's (after a short delay): the state
  // stays on the session until back().
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' });
});

test('onPromptsSettled: false for an open session that never had a prompt', () => {
  const v = createViewState();
  v.sync([s('a')]);
  v.open('a');
  assert.equal(v.onPromptsSettled('a', 0), false);
  assert.equal(v.onPromptsSettled('a', 0), false);
});

test('onPromptsSettled: a prompt that arrives while the session is open counts', () => {
  const v = createViewState();
  v.sync([s('a')]);
  v.open('a');
  assert.equal(v.onPromptsSettled('a', 0), false);
  v.sync([s('a', { prompt: PROMPT })]);
  assert.equal(v.onPromptsSettled('a', 1), false);
  v.sync([s('a')]);
  assert.equal(v.onPromptsSettled('a', 0), true);
});

test('onPromptsSettled: opening a session that has a prompt remembers it', () => {
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT })]);
  v.open('a');
  // The next snapshot already has no prompt (answered elsewhere).
  v.sync([s('a')]);
  assert.equal(v.onPromptsSettled('a', 0), true);
});

test('onPromptsSettled: a new prompt after the settle arms it again', () => {
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT })]);
  v.open('a');
  assert.equal(v.onPromptsSettled('a', 0), true);
  assert.equal(v.onPromptsSettled('a', 1), false, 'a new prompt arrives before the return');
  assert.equal(v.onPromptsSettled('a', 0), true, 'and settles again');
});

test('onPromptsSettled: back or opening another session forgets the earlier prompt', () => {
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  v.open('a');
  v.back();
  v.sync([s('a'), s('b')]);
  v.open('a');
  assert.equal(v.onPromptsSettled('a', 0), false, 'the prompt was before this open');
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  v.open('a');
  v.open('b');
  assert.equal(v.onPromptsSettled('b', 0), false);
  assert.equal(v.onPromptsSettled('a', 0), false, 'not the open session');
});

test('onPromptsSettled ignores junk counts and ids', () => {
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT })]);
  v.open('a');
  for (const bad of [undefined, null, NaN, -1, '0', {}]) {
    assert.equal(v.onPromptsSettled('a', bad), false, String(bad));
  }
  assert.equal(v.onPromptsSettled(undefined, 0), false);
  assert.equal(v.onPromptsSettled('a', 0), true, 'the real settle still counts');
});

test('needsYou lists sessions with a pending prompt or status waiting, in order', () => {
  const v = createViewState();
  v.sync([
    s('a'),
    s('b', { status: 'waiting' }),
    s('c', { prompt: PROMPT }),
    s('d', { status: 'idle', finished: true }),
    s('e', { status: 'waiting', prompt: PROMPT }),
  ]);
  assert.deepEqual(v.needsYou(), ['b', 'c', 'e']);
  v.sync([s('a'), s('c')]);
  assert.deepEqual(v.needsYou(), [], 'the prompt was answered');
});

test('needsYou returns a fresh array', () => {
  const v = createViewState();
  v.sync([s('b', { status: 'waiting' })]);
  v.needsYou().push('x');
  assert.deepEqual(v.needsYou(), ['b']);
});

test('the open session is kept while the panel is collapsed and syncs go on', () => {
  // The renderer keeps syncing while it shows the pill; an open session
  // with a prompt is still open when the panel expands again.
  const v = createViewState();
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  v.open('a');
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'a' });
  assert.equal(v.onPromptsSettled('a', 1), false);
});

test('cardKind: needs you wins over finished and busy; then finished; then the status', () => {
  assert.equal(cardKind({ status: 'busy' }, true), 'needs-you', 'a prompt on a busy session');
  assert.equal(cardKind({ status: 'waiting' }, true), 'needs-you');
  assert.equal(cardKind({ status: 'idle', finished: true }, true), 'needs-you');
  assert.equal(cardKind({ status: 'idle', finished: true }, false), 'finished');
  assert.equal(cardKind({ status: 'busy', finished: true }, false), 'busy', 'finished counts only when idle');
  assert.equal(cardKind({ status: 'busy' }, false), 'busy');
  assert.equal(cardKind({ status: 'idle' }, false), 'idle');
  // A waiting status always comes with needsYou from the view state; alone
  // it still reads as needing the user.
  assert.equal(cardKind({ status: 'waiting' }, false), 'needs-you');
  for (const odd of [{ status: 'weird' }, { status: 7 }, {}, null, undefined]) {
    assert.equal(cardKind(odd, false), 'idle', JSON.stringify(odd));
  }
});

test('backCue: nothing when no other session needs you', () => {
  const none = { count: 0, badge: '', label: 'All sessions' };
  assert.deepEqual(backCue([], 'a'), none);
  assert.deepEqual(backCue(['a'], 'a'), none, 'the open session itself does not count');
});

test('backCue: counts the other sessions that need you, with a visible number and a spoken label', () => {
  assert.deepEqual(backCue(['a', 'b'], 'b'), { count: 1, badge: '1', label: 'All sessions (1 needs you)' });
  assert.deepEqual(backCue(['a', 'b', 'c'], 'b'), { count: 2, badge: '2', label: 'All sessions (2 need you)' });
  assert.deepEqual(backCue(['a', 'c'], 'b'), { count: 2, badge: '2', label: 'All sessions (2 need you)' });
  assert.equal(backCue(['a', 'a', 'c'], 'b').count, 2, 'a repeated id counts once');
});

test('backCue: from the view state, a prompt on another session shows on the back button', () => {
  const v = createViewState();
  v.sync([s('a'), s('b')]);
  v.open('b');
  v.sync([s('a', { prompt: PROMPT }), s('b')]);
  assert.deepEqual(v.current(), { kind: 'session', sessionId: 'b' }, 'the view never switches by itself');
  assert.equal(backCue(v.needsYou(), 'b').count, 1);
});

test('backCue: junk input is no cue', () => {
  for (const junk of [undefined, null, 'ab', 7, {}]) {
    assert.deepEqual(backCue(junk, 'a'), { count: 0, badge: '', label: 'All sessions' }, String(junk));
  }
  assert.equal(backCue(['a', null, 7, '', {}], 'b').count, 1, 'only non-empty string ids count');
});

// A keydown as escapeGoesBack reads it: the key, the modifiers, IME
// composition, the focused element's tag, type and editability, the view
// and whether a pointer is pressed.
function esc(extra) {
  return { key: 'Escape', view: 'session', pointerDown: false, target: { tagName: 'BUTTON' }, ...extra };
}

test('escapeGoesBack: Escape in the session view goes back', () => {
  assert.equal(escapeGoesBack(esc()), true);
  assert.equal(escapeGoesBack(esc({ target: null })), true, 'focus on nothing');
  assert.equal(escapeGoesBack(esc({ target: { tagName: 'BODY' } })), true);
  assert.equal(escapeGoesBack(esc({ target: { tagName: 'INPUT', type: 'checkbox' } })), true);
});

test('escapeGoesBack: not on the list, not for other keys, not with a modifier or while composing', () => {
  assert.equal(escapeGoesBack(esc({ view: 'list' })), false);
  assert.equal(escapeGoesBack(esc({ key: 'Esc' })), false);
  assert.equal(escapeGoesBack(esc({ key: 'Backspace' })), false);
  for (const m of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
    assert.equal(escapeGoesBack(esc({ [m]: true })), false, m);
  }
  assert.equal(escapeGoesBack(esc({ isComposing: true })), false);
});

test('escapeGoesBack: never during a pointer press', () => {
  assert.equal(escapeGoesBack(esc({ pointerDown: true })), false);
});

test('escapeGoesBack: ignored while a text-like control has focus', () => {
  for (const target of [
    { tagName: 'TEXTAREA' },
    { tagName: 'SELECT' },
    { tagName: 'INPUT' },
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'search' },
    { tagName: 'DIV', isContentEditable: true },
  ]) {
    assert.equal(escapeGoesBack(esc({ target })), false, JSON.stringify(target));
  }
});

test('escapeGoesBack: junk input is false', () => {
  for (const junk of [undefined, null, 'Escape', 7, [], {}]) assert.equal(escapeGoesBack(junk), false);
});

// --- The delayed return after the open session's last prompt ---------------

test('returnStep: a prompt cancels, a wait without a card waits, anything else goes', () => {
  assert.equal(returnStep(s('a', { prompt: PROMPT })), 'cancel');
  assert.equal(returnStep(s('a', { status: 'waiting', prompt: PROMPT })), 'cancel');
  assert.equal(returnStep(s('a', { status: 'waiting' })), 'wait', 'the handover notice stays');
  assert.equal(returnStep(s('a', { status: 'busy' })), 'go');
  assert.equal(returnStep(s('a', { status: 'idle' })), 'go');
  assert.equal(returnStep(null), 'go', 'the session left the snapshot');
  assert.equal(returnStep(undefined), 'go');
});

// Drives the view state and the return state as the renderer does: one
// snapshot of session `a` (open), then what the delay timer is told.
function harness() {
  const v = createViewState();
  const r = createReturnState();
  let timer = false; // the delay runs
  let last = null; // the session as the last snapshot showed it
  const log = [];
  return {
    v,
    r,
    open(session) {
      last = session;
      v.sync([session]);
      v.open('a');
    },
    snap(session) {
      last = session;
      v.sync([session]);
      const cur = v.current();
      if (cur.kind !== 'session') {
        r.clear();
        timer = false;
        return;
      }
      const settled = v.onPromptsSettled('a', session.prompt ? 1 : 0);
      const step = r.onSnapshot('a', settled, session);
      if (step === 'start') timer = true;
      if (step === 'stop') timer = false;
    },
    // The delay runs out (only while it runs).
    fire() {
      if (!timer) return;
      timer = false;
      const cur = v.current();
      if (r.onDue(cur.kind === 'session' ? cur.sessionId : null, last) === 'back') {
        v.back();
        log.push('back');
      }
    },
    running: () => timer,
    log,
  };
}

test('return: a card, then waiting without a card keeps the session view', () => {
  const h = harness();
  h.open(s('a', { status: 'waiting', prompt: PROMPT }));
  h.snap(s('a', { status: 'waiting', prompt: PROMPT }));
  h.snap(s('a', { status: 'waiting' })); // the hold ended, the question is open in the app
  assert.equal(h.running(), false, 'no delay while it waits');
  assert.equal(h.r.owedFor(), 'a', 'the return is still owed');
  h.fire();
  assert.deepEqual(h.v.current(), { kind: 'session', sessionId: 'a' });
  // Answered in the app: the session moves on, and the view returns once.
  h.snap(s('a', { status: 'busy' }));
  assert.equal(h.running(), true);
  h.fire();
  assert.deepEqual(h.log, ['back']);
  assert.deepEqual(h.v.current(), { kind: 'list' });
  assert.equal(h.r.owedFor(), null);
});

test('return: a card, then busy, then waiting inside the delay stays and is still owed', () => {
  const h = harness();
  h.open(s('a', { prompt: PROMPT }));
  h.snap(s('a', { status: 'busy' })); // answered in the panel
  assert.equal(h.running(), true);
  h.snap(s('a', { status: 'waiting' })); // a question open in the app before the delay ran out
  assert.equal(h.running(), false);
  assert.equal(h.r.owedFor(), 'a');
  h.fire();
  assert.deepEqual(h.log, []);
  h.snap(s('a', { status: 'busy' }));
  h.fire();
  assert.deepEqual(h.log, ['back']);
});

test('return: answered from the panel, busy at once, returns after the delay', () => {
  const h = harness();
  h.open(s('a', { prompt: PROMPT }));
  h.snap(s('a', { status: 'busy' }));
  h.snap(s('a', { status: 'busy' })); // a second snapshot changes nothing
  assert.equal(h.running(), true);
  h.fire();
  assert.deepEqual(h.log, ['back']);
});

test('return: the delay running out while the session waits keeps the view and the debt', () => {
  // The timer fires before any snapshot told it to stop (the session as
  // last seen waits): no return, still owed.
  const h = harness();
  h.open(s('a', { prompt: PROMPT }));
  h.snap(s('a', { status: 'busy' }));
  const r = h.r;
  assert.equal(r.onDue('a', s('a', { status: 'waiting' })), 'none');
  assert.equal(r.owedFor(), 'a');
  assert.equal(r.onDue('a', s('a', { status: 'busy' })), 'back');
  assert.equal(r.owedFor(), null);
});

test('return: a waiting session that never had a card never returns by itself', () => {
  const h = harness();
  h.open(s('a', { status: 'waiting' }));
  h.snap(s('a', { status: 'waiting' }));
  h.snap(s('a', { status: 'busy' }));
  h.snap(s('a', { status: 'idle' }));
  assert.equal(h.running(), false);
  h.fire();
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.v.current(), { kind: 'session', sessionId: 'a' });
});

test('return: a new prompt during the delay cancels it; its own answer arms it again', () => {
  const h = harness();
  h.open(s('a', { prompt: PROMPT }));
  h.snap(s('a', { status: 'busy' }));
  assert.equal(h.running(), true);
  h.snap(s('a', { prompt: { id: 'p2', kind: 'ask' } }));
  assert.equal(h.running(), false);
  assert.equal(h.r.owedFor(), null);
  h.snap(s('a', { status: 'busy' }));
  assert.equal(h.running(), true);
  h.fire();
  assert.deepEqual(h.log, ['back']);
});

test('return: due for another session or with nothing owed does nothing', () => {
  const r = createReturnState();
  assert.equal(r.onDue('a', s('a')), 'none');
  assert.equal(r.onSnapshot('a', true, s('a', { status: 'busy' })), 'start');
  assert.equal(r.onDue('b', s('b')), 'none', 'another session is open now');
  assert.equal(r.owedFor(), null);
  assert.equal(r.onSnapshot('a', true, s('a', { status: 'busy' })), 'start');
  assert.equal(r.onSnapshot('b', false, s('b')), 'stop', 'a debt for a session no longer open goes');
  assert.equal(r.owedFor(), null);
  assert.equal(r.onSnapshot(null, false, null), 'stop');
  assert.equal(r.onSnapshot('a', false, s('a')), 'none');
  r.clear();
  assert.equal(r.owedFor(), null);
});
