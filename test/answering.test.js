'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseHook, askResponse, permissionResponse } = require('../src/main/prompts');
const { promptView, buildResponse, matchBuddy, holdState } = require('../src/main/answering');
const { transcriptPath } = require('../src/main/paths');

const SESSION = 'cd47e535-4ad5-4353-b403-4cd8a2f1f0c7';

function q(text, labels, extra = {}) {
  return {
    question: text,
    header: 'H',
    options: labels.map((label) => ({ label, description: `about ${label}` })),
    multiSelect: false,
    ...extra,
  };
}

function askParsed(questions) {
  return parseHook({
    session_id: SESSION,
    transcript_path: 'C:\\t.jsonl',
    cwd: 'C:\\work',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions },
  });
}

function permParsed(toolName = 'Bash', toolInput = { command: 'npm test' }) {
  return parseHook({
    session_id: SESSION,
    transcript_path: 'C:\\t.jsonl',
    cwd: 'C:\\work',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

// What the renderer would send: answers keyed by the shown question text.
function sent(answers) {
  return { kind: 'ask', answers };
}

// --- promptView ---

test('promptView: an ask shows the display questions', () => {
  const parsed = askParsed([q('Which db?', ['Pg', 'Lite']), q('Pick?', ['A', 'B'], { multiSelect: true })]);
  const view = promptView(parsed);
  assert.deepEqual(view, { kind: 'ask', questions: parsed.questions });
});

test('promptView: a permission shows tool name and summary only', () => {
  const view = promptView(permParsed('Bash', { command: 'rm -rf build', secret: 'x' }));
  assert.deepEqual(view, { kind: 'permission', toolName: 'Bash', summary: 'rm -rf build' });
});

test('promptView: an ask Huddle cannot answer in full gives null', () => {
  const long = 'x'.repeat(300);
  const cases = {
    'five questions': [q('1?', ['A']), q('2?', ['A']), q('3?', ['A']), q('4?', ['A']), q('5?', ['A'])],
    'no options': [q('Q?', [])],
    'options missing': [{ question: 'Q?', options: undefined }],
    'empty text': [q('', ['A'])],
    'blank text': [q('   ', ['A'])],
    'text not a string': [{ question: 7, options: [{ label: 'A' }] }],
    'five options': [q('Q?', ['A', 'B', 'C', 'D', 'E'])],
    'empty label': [q('Q?', ['A', ''])],
    'label not a string': [{ question: 'Q?', options: [{ label: 'A' }, { label: 3 }] }],
    'option not an object': [{ question: 'Q?', options: ['A'] }],
    'question not an object': ['Q?'],
    'same question twice': [q('Same?', ['A']), q('Same?', ['B'])],
    'questions equal once cut to 300': [q(`${long}a`, ['A']), q(`${long}b`, ['B'])],
    'labels equal once cut to 300': [q('Q?', [`${long}a`, `${long}b`])],
    'same label twice': [q('Q?', ['A', 'A'])],
  };
  for (const [name, questions] of Object.entries(cases)) {
    assert.equal(promptView(askParsed(questions)), null, name);
  }
});

test('promptView: more than 4 questions is refused even when every one is shown', () => {
  const questions = [1, 2, 3, 4, 5].map((n) => q(`${n}?`, ['A']));
  const shown = questions.map((x) => ({ ...x, options: x.options.map((o) => ({ ...o })) }));
  const parsed = { kind: 'ask', sessionId: SESSION, questions: shown, rawQuestions: questions };
  assert.equal(promptView(parsed), null);
  assert.equal(buildResponse(parsed, sent(Object.fromEntries(questions.map((x) => [x.question, 'A'])))), null);
});

test('promptView: null for nothing or an unknown kind', () => {
  assert.equal(promptView(null), null);
  assert.equal(promptView({ kind: 'other' }), null);
});

// --- buildResponse: ask ---

test('buildResponse: answers keyed by raw question text with raw labels', () => {
  const raw = [q('Which db?', ['Pg', 'Lite']), q('Which port?', ['80', '8080'])];
  const parsed = askParsed(raw);
  const r = buildResponse(parsed, sent({ 'Which db?': 'Lite', 'Which port?': '80' }));
  assert.deepEqual(r, askResponse(raw, { 'Which db?': 'Lite', 'Which port?': '80' }, 'PreToolUse'));
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.hookSpecificOutput.updatedInput.questions, parsed.rawQuestions);
});

test('buildResponse: a "__proto__" question survives as an own key in the JSON', () => {
  const raw = [q('__proto__', ['A', 'B'])];
  const r = buildResponse(askParsed(raw), sent(JSON.parse('{"__proto__":"B"}')));
  assert.ok(r, 'answer accepted');
  const answers = r.hookSpecificOutput.updatedInput.answers;
  assert.deepEqual(Object.keys(answers), ['__proto__']);
  const json = JSON.stringify(r);
  assert.match(json, /"answers":\{"__proto__":"B"\}/);
  assert.equal(Object.getPrototypeOf(answers), Object.prototype, 'prototype not replaced');
});

test('buildResponse: long text and labels map back to the full raw values', () => {
  const longQ = `${'q'.repeat(299)}QQ`;
  const longL = `${'l'.repeat(299)}LL`;
  const raw = [q(longQ, ['short', longL])];
  const parsed = askParsed(raw);
  const shownQ = parsed.questions[0].question;
  const shownL = parsed.questions[0].options[1].label;
  assert.equal(shownQ.length, 300);
  assert.equal(shownL.length, 300);
  const r = buildResponse(parsed, sent({ [shownQ]: shownL }));
  assert.deepEqual({ ...r.hookSpecificOutput.updatedInput.answers }, { [longQ]: longL });
});

test('buildResponse: multi-select labels are joined in raw option order', () => {
  const raw = [q('Pick?', ['A', 'B', 'C'], { multiSelect: true })];
  const r = buildResponse(askParsed(raw), sent({ 'Pick?': ['C', 'A'] }));
  assert.equal(r.hookSpecificOutput.updatedInput.answers['Pick?'], 'A, C');
});

test('buildResponse: labels with quotes and unicode echo unchanged', () => {
  const label = 'Use "fast" mode \u00e9\u{1F600}';
  const raw = [q('Mode?', [label, 'Other'])];
  const r = buildResponse(askParsed(raw), sent({ 'Mode?': label }));
  const back = JSON.parse(JSON.stringify(r));
  assert.equal(back.hookSpecificOutput.updatedInput.answers['Mode?'], label);
});

test('buildResponse: rejects answers that do not fit the prompt', () => {
  const raw = [q('One?', ['A', 'B']), q('Many?', ['X', 'Y', 'Z'], { multiSelect: true })];
  const parsed = askParsed(raw);
  const good = { 'One?': 'A', 'Many?': ['X'] };
  assert.ok(buildResponse(parsed, sent(good)), 'baseline is accepted');
  const bad = {
    'not an object': 'A',
    'null': null,
    'an array': ['A', ['X']],
    'missing question': { 'One?': 'A' },
    'extra key': { ...good, 'Three?': 'A' },
    'unknown label': { 'One?': 'C', 'Many?': ['X'] },
    'label from the other question': { 'One?': 'X', 'Many?': ['X'] },
    'single as array': { 'One?': ['A'], 'Many?': ['X'] },
    'multi as string': { 'One?': 'A', 'Many?': 'X' },
    'multi empty': { 'One?': 'A', 'Many?': [] },
    'multi duplicate': { 'One?': 'A', 'Many?': ['X', 'X'] },
    'multi non-string': { 'One?': 'A', 'Many?': [1] },
    'label not a string': { 'One?': 1, 'Many?': ['X'] },
  };
  for (const [name, answers] of Object.entries(bad)) {
    assert.equal(buildResponse(parsed, sent(answers)), null, name);
  }
  const inherited = Object.create({ 'One?': 'A' });
  inherited['Many?'] = ['X'];
  assert.equal(buildResponse(parsed, sent(inherited)), null, 'inherited key');
  // Same key count as questions, but one answer only inherited.
  const padded = Object.create({ 'One?': 'A' });
  padded['Many?'] = ['X'];
  padded.Other = 'A';
  assert.equal(buildResponse(parsed, sent(padded)), null, 'inherited key with padding');
  assert.equal(buildResponse(parsed, { kind: 'permission', answers: good }), null, 'kind mismatch');
  assert.equal(buildResponse(parsed, null), null, 'no payload');
});

test('buildResponse: an ask that promptView refuses is never answered', () => {
  const parsed = askParsed([q('Same?', ['A']), q('Same?', ['A'])]);
  assert.equal(buildResponse(parsed, sent({ 'Same?': 'A' })), null);
});

// --- buildResponse: permission ---

test('buildResponse: permission allow and deny', () => {
  const parsed = permParsed();
  assert.deepEqual(buildResponse(parsed, { kind: 'permission', allow: true }), permissionResponse(true));
  assert.deepEqual(buildResponse(parsed, { kind: 'permission', allow: false }), permissionResponse(false));
});

test('buildResponse: permission without a boolean allow is rejected', () => {
  const parsed = permParsed();
  for (const allow of [undefined, 'true', 1, null]) {
    assert.equal(buildResponse(parsed, { kind: 'permission', allow }), null);
  }
  assert.equal(buildResponse(parsed, { kind: 'ask', allow: true }), null);
});

// --- matchBuddy ---

const HOME = 'C:\\Users\\x';
const A = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', cwd: 'C:\\work\\one' };
const B = { sessionId: 'bbbbbbbb-0000-0000-0000-000000000002', cwd: 'C:\\work\\two' };
const C = { sessionId: 'cccccccc-0000-0000-0000-000000000003', cwd: 'C:\\work\\two' };

function hook(sessionId, extra = {}) {
  return { sessionId, transcriptPath: '', cwd: '', ...extra };
}

test('matchBuddy: by session id when the buddy is visible', () => {
  const ctx = { kept: [A, B], visible: [A, B], home: HOME };
  assert.equal(matchBuddy(hook(A.sessionId), ctx), A.sessionId);
});

test('matchBuddy: a known but hidden session never falls back to another buddy', () => {
  const ctx = { kept: [A, B], visible: [B], home: HOME };
  const parsed = hook(A.sessionId, { cwd: B.cwd, transcriptPath: transcriptPath(HOME, B.cwd, B.sessionId) });
  assert.equal(matchBuddy(parsed, ctx), null);
});

test('matchBuddy: unknown id falls back to the transcript path, case-insensitive', () => {
  const ctx = { kept: [A, B], visible: [A, B], home: HOME };
  const tp = transcriptPath(HOME, B.cwd, B.sessionId).toUpperCase();
  assert.equal(matchBuddy(hook('other', { transcriptPath: tp }), ctx), B.sessionId);
});

test('matchBuddy: unknown id falls back to a cwd only one session has', () => {
  const ctx = { kept: [A, B], visible: [A, B], home: HOME };
  assert.equal(matchBuddy(hook('other', { cwd: `${A.cwd}${path.win32.sep}` }), ctx), A.sessionId);
});

test('matchBuddy: a cwd shared by two sessions matches nothing', () => {
  assert.equal(matchBuddy(hook('other', { cwd: B.cwd }), { kept: [A, B, C], visible: [A, B, C], home: HOME }), null);
  // Also when the other one is dismissed.
  assert.equal(matchBuddy(hook('other', { cwd: B.cwd }), { kept: [A, B, C], visible: [A, B], home: HOME }), null);
});

test('matchBuddy: a fallback match to a hidden buddy gives null', () => {
  const ctx = { kept: [A, B], visible: [A], home: HOME };
  assert.equal(matchBuddy(hook('other', { cwd: B.cwd }), ctx), null);
});

test('matchBuddy: nothing matches gives null', () => {
  const ctx = { kept: [A], visible: [A], home: HOME };
  assert.equal(matchBuddy(hook('other', { cwd: 'C:\\elsewhere' }), ctx), null);
  assert.equal(matchBuddy(hook('other'), ctx), null);
  assert.equal(matchBuddy(null, ctx), null);
});

// --- holdState ---

test('holdState: a session still busy keeps the hold (the registry may not show waiting)', () => {
  assert.deepEqual(holdState({ sawWaiting: false }, { status: 'busy', visible: true, canHold: true }), {
    sawWaiting: false,
    cancel: false,
  });
});

test('holdState: waiting is remembered, and leaving waiting cancels', () => {
  const seen = holdState({ sawWaiting: false }, { status: 'waiting', visible: true, canHold: true });
  assert.deepEqual(seen, { sawWaiting: true, cancel: false });
  assert.equal(holdState(seen, { status: 'busy', visible: true, canHold: true }).cancel, true);
  assert.equal(holdState(seen, { status: 'idle', visible: true, canHold: true }).cancel, true);
});

test('holdState: a hidden buddy or a panel that cannot hold cancels', () => {
  assert.equal(holdState({ sawWaiting: false }, { status: 'busy', visible: false, canHold: true }).cancel, true);
  assert.equal(holdState({ sawWaiting: false }, { status: 'busy', visible: true, canHold: false }).cancel, true);
  assert.equal(holdState({ sawWaiting: false }, { status: undefined, visible: false, canHold: true }).cancel, true);
});
