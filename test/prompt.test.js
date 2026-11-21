'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPromptState, ARM_MS, MIN_CONFIRM_MS, MIN_AGE_MS } = require('../src/renderer/prompt');

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

test('timing constants keep the renderer a little stricter than main', () => {
  assert.equal(MIN_AGE_MS, 500);
  assert.ok(MIN_CONFIRM_MS >= 400 && MIN_CONFIRM_MS < 500);
  assert.ok(ARM_MS <= 5000 && ARM_MS > 4000);
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
