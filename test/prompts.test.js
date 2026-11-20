'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHook,
  askResponse,
  permissionResponse,
  joinMulti,
} = require('../src/main/prompts');

const SESSION = 'cd47e535-4ad5-4353-b403-4cd8a2f1f0c7';

function q(n, extra = {}) {
  return {
    question: `Question ${n}?`,
    header: `H${n}`,
    options: [
      { label: `A${n}`, description: `first ${n}` },
      { label: `B${n}`, description: `second ${n}` },
    ],
    multiSelect: false,
    ...extra,
  };
}

function askBody(questions, overrides = {}) {
  return {
    session_id: SESSION,
    transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl',
    cwd: 'C:\\Users\\x\\TEST',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions },
    ...overrides,
  };
}

function permBody(toolName, toolInput, overrides = {}) {
  return {
    session_id: SESSION,
    transcript_path: 'C:\\t.jsonl',
    cwd: 'C:\\work',
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    ...overrides,
  };
}

test('parseHook: 4 questions with one multi-select', () => {
  const questions = [q(1), q(2, { multiSelect: true }), q(3), q(4)];
  const r = parseHook(askBody(questions));
  assert.equal(r.kind, 'ask');
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.transcriptPath, 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl');
  assert.equal(r.cwd, 'C:\\Users\\x\\TEST');
  assert.equal(r.questions.length, 4);
  assert.deepEqual(r.questions.map((x) => x.multiSelect), [false, true, false, false]);
  assert.deepEqual(r.questions[0], {
    question: 'Question 1?',
    header: 'H1',
    options: [
      { label: 'A1', description: 'first 1' },
      { label: 'B1', description: 'second 1' },
    ],
    multiSelect: false,
  });
  assert.equal(r.rawQuestions, questions);
});

test('parseHook: 5 questions cut to 4 for display, rawQuestions keeps all 5', () => {
  const questions = [q(1), q(2), q(3), q(4), q(5)];
  const r = parseHook(askBody(questions));
  assert.equal(r.questions.length, 4);
  assert.equal(r.rawQuestions.length, 5);
  assert.deepEqual(r.rawQuestions, [q(1), q(2), q(3), q(4), q(5)]);
});

test('parseHook: at most 4 options and strings truncated to 300', () => {
  const long = 'x'.repeat(500);
  const options = [1, 2, 3, 4, 5, 6].map((i) => ({ label: `L${i}`, description: long }));
  const r = parseHook(askBody([{ question: long, header: long, options, multiSelect: false }]));
  const shown = r.questions[0];
  assert.equal(shown.options.length, 4);
  assert.equal(shown.question.length, 300);
  assert.equal(shown.header.length, 300);
  assert.equal(shown.options[0].description.length, 300);
});

test('parseHook: missing session_id gives null', () => {
  const body = askBody([q(1)]);
  delete body.session_id;
  assert.equal(parseHook(body), null);
  assert.equal(parseHook(askBody([q(1)], { session_id: '' })), null);
});

test('parseHook: non-objects and unknown events give null', () => {
  assert.equal(parseHook(null), null);
  assert.equal(parseHook(undefined), null);
  assert.equal(parseHook('text'), null);
  assert.equal(parseHook([]), null);
  assert.equal(parseHook(askBody([q(1)], { hook_event_name: 'Stop' })), null);
  assert.equal(parseHook(askBody([q(1)], { tool_name: 'Bash' })), null);
  assert.equal(parseHook(askBody(null)), null);
  assert.equal(parseHook(askBody([])), null);
});

test('parseHook: PermissionRequest for AskUserQuestion gives null', () => {
  const body = askBody([q(1)], { hook_event_name: 'PermissionRequest' });
  assert.equal(parseHook(body), null);
});

test('parseHook: Bash with a 500-char command gives a 160-char one-line summary', () => {
  const command = ('echo hello\r\n' + 'y'.repeat(30) + '\t').repeat(20).slice(0, 500);
  assert.equal(command.length, 500);
  const r = parseHook(permBody('Bash', { command }));
  assert.equal(r.kind, 'permission');
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.transcriptPath, 'C:\\t.jsonl');
  assert.equal(r.cwd, 'C:\\work');
  assert.equal(r.toolName, 'Bash');
  assert.equal(r.risky, true);
  assert.equal(r.summary.length, 160);
  assert.doesNotMatch(r.summary, /[\r\n\t]/);
});

test('parseHook: summary uses file_path, url, else the tool name', () => {
  assert.equal(parseHook(permBody('Write', { file_path: 'C:\\a.txt', content: 'x' })).summary, 'C:\\a.txt');
  assert.equal(parseHook(permBody('WebFetch', { url: 'https://example.com' })).summary, 'https://example.com');
  assert.equal(parseHook(permBody('mcp__x__y', { foo: 1 })).summary, 'mcp__x__y');
  assert.equal(parseHook(permBody('Task', undefined)).summary, 'Task');
});

test('parseHook: PreToolUse for another tool gives null', () => {
  assert.equal(parseHook(permBody('Bash', { command: 'ls' }, { hook_event_name: 'PreToolUse' })), null);
});

test('askResponse: PreToolUse shape echoes labels and raw questions exactly', () => {
  const raw = [
    q(1),
    { ...q(2), options: [{ label: 'Say "hi"', description: 'quotes' }, { label: 'Zürich \u{1F680} \u00e9', description: 'unicode' }], multiSelect: true },
  ];
  const before = JSON.parse(JSON.stringify(raw));
  const answers = {
    'Question 1?': 'A1',
    'Question 2?': joinMulti(['Say "hi"', 'Zürich \u{1F680} \u00e9']),
  };
  const res = askResponse(raw, answers, 'PreToolUse');
  assert.deepEqual(res, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions: raw, answers },
    },
  });
  const round = JSON.parse(JSON.stringify(res));
  assert.deepEqual(round.hookSpecificOutput.updatedInput.questions, before);
  assert.equal(round.hookSpecificOutput.updatedInput.answers['Question 2?'], 'Say "hi", Zürich \u{1F680} \u00e9');
  assert.deepEqual(raw, before);
});

test('askResponse: 5 raw questions pass through, answers only what was answered', () => {
  const raw = [q(1), q(2), q(3), q(4), q(5)];
  const answers = { 'Question 1?': 'A1', 'Question 2?': 'B2', 'Question 3?': 'A3', 'Question 4?': 'B4' };
  const res = askResponse(raw, answers, 'PreToolUse');
  assert.equal(res.hookSpecificOutput.updatedInput.questions.length, 5);
  assert.deepEqual(res.hookSpecificOutput.updatedInput.answers, answers);
});

test('askResponse: PermissionRequest shape', () => {
  const raw = [q(1)];
  const answers = { 'Question 1?': 'B1' };
  assert.deepEqual(askResponse(raw, answers, 'PermissionRequest'), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow', updatedInput: { questions: raw, answers } },
    },
  });
});

test('permissionResponse: allow and deny shapes', () => {
  assert.deepEqual(permissionResponse(true), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.deepEqual(permissionResponse(false), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Denied from Huddle' },
    },
  });
});

test('joinMulti: comma-joined in the given order', () => {
  assert.equal(joinMulti(['A', 'B', 'C']), 'A, B, C');
  assert.equal(joinMulti(['Only']), 'Only');
});
