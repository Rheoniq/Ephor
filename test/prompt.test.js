'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPromptState, ARM_MS } = require('../src/renderer/prompt');

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
  return { id, kind: 'permission', toolName: 'Bash', summary: 'npm test' };
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; } };
}

test('starts empty', () => {
  const st = createPromptState();
  assert.equal(st.current(), null);
});

test('two-question ask is done only after the second answer, keyed by question text', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Which db?', ['Pg', 'Lite']), question('Which port?', ['80', '8080'])]));
  const first = st.current();
  assert.equal(first.kind, 'ask');
  assert.equal(first.index, 0);
  assert.equal(first.count, 2);
  assert.equal(first.question.question, 'Which db?');

  assert.deepEqual(st.answerQuestion('Lite'), { done: false });
  assert.equal(st.current().index, 1);
  assert.equal(st.current().question.question, 'Which port?');

  const r = st.answerQuestion('8080');
  assert.equal(r.done, true);
  assert.deepEqual({ ...r.answers }, { 'Which db?': 'Lite', 'Which port?': '8080' });
  assert.equal(st.current().answered, true);
});

test('an unknown label does not advance or answer', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Q?', ['A', 'B'])]));
  assert.deepEqual(st.answerQuestion('C'), { done: false });
  assert.deepEqual(st.answerQuestion(undefined), { done: false });
  assert.equal(st.current().index, 0);
  assert.equal(st.current().answered, false);
});

test('answers are a null-prototype object and a "__proto__" question is kept as a key', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('__proto__', ['A', 'B'])]));
  const r = st.answerQuestion('B');
  assert.equal(r.done, true);
  assert.equal(Object.getPrototypeOf(r.answers), null);
  assert.deepEqual(Object.keys(r.answers), ['__proto__']);
  assert.equal(r.answers.__proto__, 'B');
});

test('multi-select accumulates labels in option order and completes on finishMulti', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Pick?', ['A', 'B', 'C'], true)]));
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

test('finishMulti with nothing chosen does not advance', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Pick?', ['A', 'B'], true)]));
  assert.deepEqual(st.finishMulti(), { done: false });
  assert.equal(st.current().index, 0);
});

test('a multi-select then single-select ask combines both answers', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Pick?', ['A', 'B'], true), question('One?', ['X', 'Y'])]));
  st.toggleOption('B');
  assert.deepEqual(st.finishMulti(), { done: false });
  assert.equal(st.toggleOption('X'), false, 'single-select question has no toggles');
  const r = st.answerQuestion('Y');
  assert.equal(r.done, true);
  assert.deepEqual({ ...r.answers }, { 'Pick?': ['B'], 'One?': 'Y' });
});

test('showing the same prompt id again keeps progress; a new id starts over', () => {
  const st = createPromptState();
  const p = ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]);
  st.show(p);
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
    { id: 'p', kind: 'permission', toolName: 7 },
  ]) {
    assert.equal(st.show(bad), false);
    assert.equal(st.current(), null);
  }
});

test('armAllow needs two calls for a permission prompt', () => {
  const c = clock(1000);
  const st = createPromptState({ now: c.now });
  st.show(permission('p1'));
  assert.equal(st.confirmPending(), false);
  assert.equal(st.current().armed, false);
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.confirmPending(), true);
  assert.equal(st.current().armed, true);
  c.set(1000 + ARM_MS - 1);
  assert.equal(st.armAllow(), 'send');
  assert.equal(st.current().answered, true);
  assert.equal(st.confirmPending(), false);
});

test('the confirm click expires after 5 s and the next click arms again', () => {
  const c = clock(0);
  const st = createPromptState({ now: c.now });
  st.show(permission('p1'));
  assert.equal(ARM_MS, 5000);
  assert.equal(st.armAllow(), 'armed');
  c.set(ARM_MS + 1);
  assert.equal(st.confirmPending(), false);
  assert.equal(st.armAllow(), 'armed');
  c.set(ARM_MS + 2);
  assert.equal(st.armAllow(), 'send');
});

test('armAllow never sends for an ask, an answered prompt or no prompt', () => {
  const st = createPromptState();
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.armAllow(), 'armed');
  st.show(ask('p1', [question('Q?', ['A'])]));
  assert.equal(st.armAllow(), 'armed');
  assert.equal(st.armAllow(), 'armed');
  st.show(permission('p2'));
  st.armAllow();
  assert.equal(st.armAllow(), 'send');
  assert.equal(st.armAllow(), 'armed', 'no second send');
});

test('deny answers a permission prompt at once', () => {
  const st = createPromptState();
  st.show(permission('p1'));
  assert.equal(st.deny(), true);
  assert.equal(st.current().answered, true);
  assert.equal(st.deny(), false, 'already answered');
  st.show(ask('p2', [question('Q?', ['A'])]));
  assert.equal(st.deny(), false, 'not a permission prompt');
});

test('an answered ask takes no more answers', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Q?', ['A', 'B'])]));
  assert.equal(st.answerQuestion('A').done, true);
  assert.deepEqual(st.answerQuestion('B'), { done: false });
});

test('reset clears the prompt and its progress', () => {
  const st = createPromptState();
  st.show(ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]));
  st.answerQuestion('A');
  st.reset();
  assert.equal(st.current(), null);
  st.show(ask('p1', [question('Q1?', ['A']), question('Q2?', ['B'])]));
  assert.equal(st.current().index, 0, 'same id after reset starts over');
});
