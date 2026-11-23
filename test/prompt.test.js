'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPromptState,
  refusedId,
  promptDomIds,
  releaseLabel,
  releaseTitle,
  secondsLeft,
  countdownText,
  holdMsOf,
  ARM_MS,
  MIN_CONFIRM_MS,
  MIN_AGE_MS,
} = require('../src/renderer/prompt');
const main = require('../src/main/answering');

function question(text, labels, multiSelect = false) {
  return {
    question: text,
    header: '',
    options: labels.map((label) => ({ label, description: `about ${label}` })),
    multiSelect,
  };
}

function ask(id, questions) {
  return { id, kind: 'ask', questions };
}

function permission(id) {
  return { id, kind: 'permission', toolName: 'Bash', command: 'npm test' };
}

// A state on a fake clock. `settle()` moves past the minimum card age, as a
// user who reads the card before clicking would.
function make() {
  let t = 1000;
  const st = createPromptState({ now: () => t });
  return {
    st,
    tick: (ms) => {
      t += ms;
    },
    settle: () => {
      t += MIN_AGE_MS;
    },
  };
}

test('starts empty', () => {
  const st = createPromptState();
  assert.equal(st.current(), null);
});

test('timing constants keep the renderer clearly stricter than main', () => {
  assert.equal(MIN_AGE_MS, 500);
  assert.equal(MIN_CONFIRM_MS, 600);
  assert.equal(ARM_MS, 4500);
  // Room for IPC delays, so main does not refuse what the card sends.
  assert.ok(MIN_AGE_MS >= main.MIN_ANSWER_AGE_MS);
  assert.ok(MIN_CONFIRM_MS - main.MIN_CONFIRM_MS >= 200);
  assert.ok(main.ARM_MS - ARM_MS >= 500);
});

test('two-question ask is done only after the second answer, keyed by question text', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Which db?', ['Pg', 'Lite']), question('Which port?', ['80', '8080'])]));
  settle();
  const first = st.current();
  assert.equal(first.kind, 'ask');
  assert.equal(first.index, 0);
  assert.equal(first.count, 2);
  assert.equal(first.question.question, 'Which db?');

  assert.deepEqual(st.answerQuestion('Lite'), { done: false });
  assert.equal(st.current().index, 1);
  assert.equal(st.current().question.question, 'Which port?');

  settle();
  const r = st.answerQuestion('8080');
  assert.equal(r.done, true);
  assert.deepEqual({ ...r.answers }, { 'Which db?': 'Lite', 'Which port?': '8080' });
  assert.equal(st.current().answered, true);
});

test('clicks on a card younger than MIN_AGE_MS are ignored', () => {
  const { st, tick } = make();
  st.show(ask('p1', [question('Q?', ['A', 'B'])]));
  tick(100);
  assert.deepEqual(st.answerQuestion('A'), { done: false });
  assert.equal(st.current().answered, false);
  tick(MIN_AGE_MS - 100);
  assert.equal(st.answerQuestion('A').done, true);
});

test('each new question has its own minimum age, so a double-click cannot answer the next one', () => {
  const { st, tick, settle } = make();
  st.show(ask('p1', [question('Q1?', ['A', 'B']), question('Q2?', ['C', 'D'])]));
  settle();
  assert.deepEqual(st.answerQuestion('A'), { done: false });
  tick(120); // second click of a double-click lands on question 2
  assert.deepEqual(st.answerQuestion('C'), { done: false });
  assert.equal(st.current().index, 1);
  settle();
  assert.equal(st.answerQuestion('C').done, true);
});

test('an unknown label does not advance or answer', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Q?', ['A', 'B'])]));
  settle();
  assert.deepEqual(st.answerQuestion('C'), { done: false });
  assert.deepEqual(st.answerQuestion(undefined), { done: false });
  assert.equal(st.current().index, 0);
  assert.equal(st.current().answered, false);
});

test('answers are a null-prototype object and a "__proto__" question is kept as a key', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('__proto__', ['A', 'B'])]));
  settle();
  const r = st.answerQuestion('B');
  assert.equal(r.done, true);
  assert.equal(Object.getPrototypeOf(r.answers), null);
  assert.deepEqual(Object.keys(r.answers), ['__proto__']);
  assert.equal(r.answers.__proto__, 'B');
});

test('multi-select accumulates labels in option order and completes on finishMulti', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Pick?', ['A', 'B', 'C'], true)]));
  settle();
  // A multi-select question is not answered by a single click.
  assert.deepEqual(st.answerQuestion('A'), { done: false });
  assert.equal(st.toggleOption('C'), true);
  assert.equal(st.toggleOption('A'), true);
  assert.deepEqual(st.current().chosen, ['A', 'C']);
  assert.equal(st.toggleOption('B'), true);
  assert.equal(st.toggleOption('B'), false, 'second toggle removes it');
  assert.equal(st.toggleOption('Z'), false, 'unknown label is ignored');
  assert.deepEqual(st.current().chosen, ['A', 'C']);
  const r = st.finishMulti();
  assert.equal(r.done, true);
  assert.deepEqual(r.answers['Pick?'], ['A', 'C']);
});

test('multi-select toggles on a card younger than MIN_AGE_MS are ignored', () => {
  const { st, tick } = make();
  st.show(ask('p1', [question('Pick?', ['A', 'B'], true)]));
  tick(50);
  assert.equal(st.toggleOption('A'), false);
  assert.deepEqual(st.current().chosen, []);
});

test('finishMulti with nothing chosen does not advance', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Pick?', ['A', 'B'], true)]));
  settle();
  assert.deepEqual(st.finishMulti(), { done: false });
  assert.equal(st.current().index, 0);
});

test('a multi-select then single-select ask combines both answers', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Pick?', ['A', 'B'], true), question('One?', ['X', 'Y'])]));
  settle();
  st.toggleOption('B');
  assert.deepEqual(st.finishMulti(), { done: false });
  settle();
  assert.equal(st.toggleOption('X'), false, 'single-select question has no toggles');
  const r = st.answerQuestion('Y');
  assert.equal(r.done, true);
  assert.deepEqual({ ...r.answers }, { 'Pick?': ['B'], 'One?': 'Y' });
});

test('showing the same prompt id again keeps progress; a new id starts over', () => {
  const { st, settle } = make();
  const p = ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]);
  st.show(p);
  settle();
  st.answerQuestion('A');
  st.show(ask('p1', p.questions));
  assert.equal(st.current().index, 1);
  st.show(ask('p2', p.questions));
  assert.equal(st.current().id, 'p2');
  assert.equal(st.current().index, 0);
});

test('a malformed prompt is not shown', () => {
  const st = createPromptState();
  for (const bad of [
    null,
    'x',
    { kind: 'ask', questions: [question('Q?', ['A'])] },
    { id: 'p', kind: 'other' },
    { id: 'p', kind: 'ask', questions: [] },
    { id: 'p', kind: 'ask', questions: [{ question: 'Q?', options: [] }] },
    { id: 'p', kind: 'ask', questions: [question('', ['A'])] },
    { id: 'p', kind: 'ask', questions: [question('Same?', ['A']), question('Same?', ['B'])] },
    { id: 'p', kind: 'ask', questions: [question('Q?', ['A', 'A'])] },
    { id: 'p', kind: 'permission', toolName: 7, command: 'ls' },
    { id: 'p', kind: 'permission', toolName: 'Bash' },
    { id: 'p', kind: 'permission', toolName: 'Bash', command: '' },
    { id: 'p', kind: 'permission', toolName: 'Bash', command: ['ls'] },
  ]) {
    assert.equal(st.show(bad), false);
    assert.equal(st.current(), null);
  }
});

test('armAllow needs two calls for a permission prompt', () => {
  const { st, tick, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.confirmPending(), false);
  assert.equal(st.current().armed, false);
  assert.equal(st.current().command, 'npm test', 'the full command is shown');
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), true);
  assert.equal(st.current().armed, true);
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'send');
  assert.equal(st.current().answered, true);
  assert.equal(st.confirmPending(), false);
});

test('a second click sooner than MIN_CONFIRM_MS does not send (a double-click)', () => {
  const { st, tick, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.armAllow(), 'armed');
  tick(120);
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.current().answered, false);
  // The fast click neither sent nor restarted the arm.
  tick(MIN_CONFIRM_MS - 120);
  assert.equal(st.armAllow(), 'send');
});

test('the confirm click expires after ARM_MS and the next click arms again', () => {
  const { st, tick, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.armAllow(), 'armed');
  tick(ARM_MS);
  assert.equal(st.confirmPending(), false);
  assert.equal(st.armAllow(), 'armed');
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'send');
});

test('Allow and Deny on a card younger than MIN_AGE_MS are ignored', () => {
  const { st, tick } = make();
  st.show(permission('p1'));
  tick(100);
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), false, 'not armed');
  assert.equal(st.deny(), false);
  assert.equal(st.current().answered, false);
});

test('armAllow never sends for an ask, an answered prompt or no prompt', () => {
  const { st, tick, settle } = make();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.armAllow(), 'armed');
  st.show(ask('p1', [question('Q?', ['A'])]));
  settle();
  assert.equal(st.armAllow(), 'armed');
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'armed');
  st.show(permission('p2'));
  settle();
  st.armAllow();
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'send');
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'armed', 'no second send');
});

test('deny answers a permission prompt at once', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.deny(), true);
  assert.equal(st.current().answered, true);
  assert.equal(st.deny(), false, 'already answered');
  st.show(ask('p2', [question('Q?', ['A'])]));
  settle();
  assert.equal(st.deny(), false, 'not a permission prompt');
});

test('an answered ask takes no more answers', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Q?', ['A', 'B'])]));
  settle();
  assert.equal(st.answerQuestion('A').done, true);
  settle();
  assert.deepEqual(st.answerQuestion('B'), { done: false });
});

test('refused after an Allow re-shows the card unarmed, with its own minimum age', () => {
  const { st, tick, settle } = make();
  st.show(permission('p1'));
  settle();
  st.armAllow();
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'send');
  assert.equal(st.current().answered, true);
  assert.equal(st.refused(), true);
  assert.equal(st.current().answered, false);
  assert.equal(st.current().armed, false);
  // The card comes back where the click landed: a click right away is ignored.
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), false);
  assert.equal(st.deny(), false);
  settle();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), true);
  tick(MIN_CONFIRM_MS);
  assert.equal(st.armAllow(), 'send');
});

test('refused after a Deny re-shows the card', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.deny(), true);
  assert.equal(st.refused(), true);
  assert.equal(st.current().answered, false);
  settle();
  assert.equal(st.deny(), true);
});

test('refused arm resets the confirm state and keeps the card clickable', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.current().armed, true);
  assert.equal(st.refused(), true);
  assert.equal(st.current().armed, false);
  assert.equal(st.current().answered, false);
  // The card never left, so no new minimum age: the next click arms again.
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), true);
});

test('refused ask shows the last question again and keeps the earlier answers', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Q1?', ['A', 'B']), question('Q2?', ['C', 'D'])]));
  settle();
  st.answerQuestion('A');
  settle();
  assert.equal(st.answerQuestion('D').done, true);
  assert.equal(st.refused(), true);
  const view = st.current();
  assert.equal(view.answered, false);
  assert.equal(view.index, 1);
  assert.deepEqual(st.answerQuestion('C'), { done: false }, 'too soon after it came back');
  settle();
  const r = st.answerQuestion('C');
  assert.equal(r.done, true);
  assert.deepEqual({ ...r.answers }, { 'Q1?': 'A', 'Q2?': 'C' });
});

test('refusedId accepts only a prompt id string', () => {
  assert.equal(refusedId('7c9e6679-7425-40de-944b-e07fc1f90ae7'), '7c9e6679-7425-40de-944b-e07fc1f90ae7');
  for (const bad of [undefined, null, '', 7, {}, ['p1'], { id: 'p1' }, 'x'.repeat(101)]) {
    assert.equal(refusedId(bad), null, JSON.stringify(bad));
  }
});

test('refused with no prompt does nothing', () => {
  const st = createPromptState();
  assert.equal(st.refused(), false);
  assert.equal(st.current(), null);
});

test('reset clears the prompt and its progress', () => {
  const { st, settle } = make();
  st.show(ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]));
  settle();
  st.answerQuestion('A');
  st.reset();
  assert.equal(st.current(), null);
  st.show(ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]));
  assert.equal(st.current().index, 0, 'same id after reset starts over');
});

test('promptDomIds is stable per prompt id and gives kicker, text and command ids', () => {
  const a = promptDomIds('demo-ask');
  assert.deepEqual(a, {
    kicker: 'prompt-demo-ask-kicker',
    text: 'prompt-demo-ask-text',
    command: 'prompt-demo-ask-command',
  });
  assert.deepEqual(promptDomIds('demo-ask'), a);
  assert.notEqual(promptDomIds('demo-permission').kicker, a.kicker);
});

test('promptDomIds escapes every character outside letters, digits and hyphens', () => {
  const ids = promptDomIds('a b"<x>_');
  for (const v of Object.values(ids)) assert.match(v, /^[A-Za-z0-9_-]+$/);
  // Escaping keeps distinct prompt ids apart.
  assert.notEqual(promptDomIds('a b').text, promptDomIds('a_b').text);
  assert.notEqual(promptDomIds('a_20_b').text, promptDomIds('a b').text);
});

test('releaseTitle says the prompt is released and names the app, for any prompt kind', () => {
  assert.equal(releaseTitle('terminal', 'Zed'), 'Release this prompt and open Zed');
  assert.equal(releaseTitle('terminal', '  VS Code '), 'Release this prompt and open VS Code');
  for (const none of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(releaseTitle('terminal', none), 'Release this prompt and open the terminal', String(none));
  }
  assert.equal(releaseTitle('desktop', 'Zed'), 'Release this prompt and open Claude Desktop');
  for (const odd of [undefined, null, '', 'Terminal', 42, {}]) {
    assert.equal(releaseTitle(odd, 'Zed'), 'Release this prompt and open Claude Desktop', String(odd));
  }
  assert.doesNotMatch(releaseTitle('desktop'), /question/i);
});

test('releaseLabel names the app the release opens: the host, the terminal or Claude Desktop', () => {
  assert.equal(releaseLabel('terminal', 'Zed'), 'Answer in Zed');
  assert.equal(releaseLabel('terminal', 'VS Code'), 'Answer in VS Code');
  assert.equal(releaseLabel('terminal', '  Windows Terminal  '), 'Answer in Windows Terminal');
  // A terminal session whose host is not known yet.
  for (const none of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(releaseLabel('terminal', none), 'Answer in the terminal', String(none));
  }
  // Desktop sessions (and anything that is not 'terminal') never use a host.
  assert.equal(releaseLabel('desktop', null), 'Answer in Claude Desktop');
  assert.equal(releaseLabel('desktop', 'Zed'), 'Answer in Claude Desktop');
  for (const odd of [undefined, null, '', 'Terminal', 42, {}]) {
    assert.equal(releaseLabel(odd, 'Zed'), 'Answer in Claude Desktop', String(odd));
  }
});

test('releaseLabel keeps HTML in a host name as plain text', () => {
  assert.equal(releaseLabel('terminal', '<b>x</b>'), 'Answer in <b>x</b>');
});

test('secondsLeft counts whole seconds down from the hold, rounded up, never below 0', () => {
  assert.equal(secondsLeft(60000, 0), 60);
  assert.equal(secondsLeft(60000, 1), 60, 'a part of a second still shows the whole second');
  assert.equal(secondsLeft(60000, 999), 60);
  assert.equal(secondsLeft(60000, 1000), 59);
  assert.equal(secondsLeft(60000, 59001), 1);
  assert.equal(secondsLeft(60000, 60000), 0);
  assert.equal(secondsLeft(60000, 90000), 0, 'clamped at 0');
  assert.equal(secondsLeft(8000, 2500), 6, 'the hold comes from the payload');
  assert.equal(secondsLeft(300000, 0), 300);
});

test('secondsLeft: a negative or junk elapsed time counts as none', () => {
  for (const odd of [-5000, NaN, undefined, null, '10', Infinity]) {
    assert.equal(secondsLeft(30000, odd), 30, String(odd));
  }
});

test('secondsLeft: a hold outside 5 s to 300 s falls back like holdMsOf', () => {
  assert.equal(secondsLeft(undefined, 0), holdMsOf(null) / 1000);
  assert.equal(secondsLeft(1000, 0), holdMsOf({ holdMs: 1000 }) / 1000);
  assert.equal(secondsLeft('8000', 0), holdMsOf(null) / 1000);
});

test('countdownText reads "Releases in N s"', () => {
  assert.equal(countdownText(60000, 0), 'Releases in 60 s');
  assert.equal(countdownText(15000, 14200), 'Releases in 1 s');
  assert.equal(countdownText(15000, 20000), 'Releases in 0 s');
  assert.equal(countdownText(8000, 2500), 'Releases in 6 s');
});

test('release is ignored on a card younger than MIN_AGE_MS, like the option buttons', () => {
  const { st, tick } = make();
  st.show(ask('a1', [question('Pick?', ['A', 'B'])]));
  assert.equal(st.release(), false, 'a stray click right after the card appears');
  tick(MIN_AGE_MS - 1);
  assert.equal(st.release(), false);
  tick(1);
  assert.equal(st.release(), true);
});

test('release works once per prompt; a second click does nothing', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.current().released, false);
  assert.equal(st.release(), true);
  assert.equal(st.release(), false);
  assert.equal(st.current().released, true);
});

test('release is refused for an answered prompt or no prompt', () => {
  const { st, settle } = make();
  assert.equal(st.release(), false, 'no prompt');
  st.show(permission('p1'));
  settle();
  assert.equal(st.deny(), true);
  assert.equal(st.release(), false, 'answered');
});

test('release follows the minimum age of each new question of an ask', () => {
  const { st, settle, tick } = make();
  st.show(ask('a1', [question('One?', ['A', 'B']), question('Two?', ['C', 'D'])]));
  settle();
  assert.equal(st.answerQuestion('A').done, false);
  // The second question appeared where the click landed.
  assert.equal(st.release(), false);
  tick(MIN_AGE_MS);
  assert.equal(st.release(), true);
});

test('a new prompt id starts with release possible again', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.release(), true);
  st.show(permission('p2'));
  assert.equal(st.current().released, false);
  settle();
  assert.equal(st.release(), true);
});

test('holdMsOf takes holdMs from the prompt payload, within 5 s to 300 s, else 60 s', () => {
  assert.equal(holdMsOf({ holdMs: 60000 }), 60000);
  assert.equal(holdMsOf({ holdMs: 5000 }), 5000);
  assert.equal(holdMsOf({ holdMs: 300000 }), 300000);
  assert.equal(holdMsOf({ holdMs: 12345.6 }), 12346);
  for (const odd of [undefined, null, {}, { holdMs: 4999 }, { holdMs: 300001 }, { holdMs: '60000' }, { holdMs: NaN }, { holdMs: Infinity }]) {
    assert.equal(holdMsOf(odd), 60000, JSON.stringify(odd));
  }
});

test('the snapshot prompt from main carries holdMs and no heldAt', () => {
  const parsed = require('../src/main/prompts').parseHook({
    session_id: 's',
    transcript_path: 'C:\t.jsonl',
    cwd: 'C:\work',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  });
  const view = main.promptView(parsed);
  assert.ok(view);
  const entry = main.createHold({ id: 'p1', sessionId: 's', parsed, view, now: 5, holdMs: 30000 });
  assert.equal(entry.view.holdMs, 30000);
  assert.equal('heldAt' in entry.view, false);
  assert.equal(holdMsOf(entry.view), 30000);
});

test('shownAgain gives a card that comes back into view a new minimum age and disarms Allow', () => {
  // The session view was left and opened again (or the pill expanded): the
  // card appears under the cursor, so the second click of a double-click on
  // the list must not answer, release or confirm anything.
  const { st, settle, tick } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.shownAgain(), true);
  assert.equal(st.current().armed, false, 'disarmed');
  tick(MIN_AGE_MS - 100); // the second click of a double-click
  assert.equal(st.armAllow(), 'armed', 'too young to arm');
  assert.equal(st.confirmPending(), false);
  assert.equal(st.deny(), false);
  assert.equal(st.release(), false);
  settle();
  assert.equal(st.deny(), true);
});

test('shownAgain keeps the progress of an ask and its picked options', () => {
  const { st, settle } = make();
  st.show(ask('a1', [question('One?', ['A', 'B']), question('Pick?', ['C', 'D'], true)]));
  settle();
  st.answerQuestion('A');
  settle();
  st.toggleOption('D');
  st.shownAgain();
  assert.equal(st.current().index, 1);
  assert.deepEqual(st.current().chosen, ['D']);
  assert.deepEqual(st.finishMulti(), { done: false }, 'too young');
  settle();
  assert.equal(st.finishMulti().done, true);
});

test('shownAgain with no prompt does nothing', () => {
  const st = createPromptState();
  assert.equal(st.shownAgain(), false);
});

test('a released ask is inert: no answer, toggle or Done goes through', () => {
  const { st, settle } = make();
  st.show(ask('a1', [question('Pick?', ['A', 'B'])]));
  settle();
  assert.equal(st.release(), true);
  assert.equal(st.answerQuestion('A').done, false);
  assert.equal(st.current().answered, false);
  st.show(ask('a2', [question('Many?', ['A', 'B'], true)]));
  settle();
  assert.equal(st.toggleOption('A'), true);
  assert.equal(st.release(), true);
  assert.equal(st.toggleOption('B'), false);
  assert.equal(st.finishMulti().done, false);
  assert.deepEqual(st.current().chosen, ['A']);
});

test('a released permission is inert: an armed Allow ends, no Allow or Deny goes through', () => {
  const { st, settle, tick } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.current().armed, true);
  tick(MIN_CONFIRM_MS);
  assert.equal(st.release(), true);
  assert.equal(st.current().armed, false, 'no stale Confirm allow');
  assert.equal(st.confirmPending(), false);
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.current().armed, false);
  assert.equal(st.deny(), false);
  assert.equal(st.current().answered, false);
});

test('a refused answer does not undo a release', () => {
  const { st, settle } = make();
  st.show(permission('p1'));
  settle();
  assert.equal(st.release(), true);
  st.refused();
  assert.equal(st.current().released, true);
  assert.equal(st.deny(), false);
});
