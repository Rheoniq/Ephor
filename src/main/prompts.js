'use strict';

// Pure functions for Claude Code hook payloads: parse what a hook posts and
// build the JSON the hook answers with. Every string in a payload is
// untrusted; display fields are cut to size here, while `rawQuestions` is
// kept as received so it can be echoed back unchanged in `updatedInput`.

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_TEXT = 300;

// Permission prompts are held only for shell commands the card can show in
// full: Bash or PowerShell with a command of at most MAX_COMMAND characters.
// Every other tool, and any longer command, falls through to Desktop at once.
const PERMISSION_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_COMMAND = 600;
// Characters that would make the shown command differ from the one that
// runs: control characters other than tab, line feed and a carriage return
// that starts a CRLF pair; invisible format characters (bidi overrides,
// zero-width marks); and the Unicode line and paragraph separators, which
// show as a line break but do not run as one.
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]|\r(?!\n)|\p{Cf}/u;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The command when the card can show all of it as it runs, else null.
function showableCommand(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (value.length > MAX_COMMAND || HIDDEN_CHARS.test(value)) return null;
  return value;
}

// Cuts to at most `max` UTF-16 units without leaving half a surrogate pair.
function truncate(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// The card shows the question, its option labels and their descriptions.
function displayQuestion(raw) {
  const item = isObject(raw) ? raw : {};
  const options = Array.isArray(item.options) ? item.options : [];
  return {
    question: truncate(item.question, MAX_TEXT),
    options: options.slice(0, MAX_OPTIONS).map((opt) => {
      const o = isObject(opt) ? opt : {};
      return { label: truncate(o.label, MAX_TEXT), description: truncate(o.description, MAX_TEXT) };
    }),
    multiSelect: item.multiSelect === true,
  };
}

function parseHook(body) {
  if (!isObject(body)) return null;
  const sessionId = body.session_id;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const toolName = typeof body.tool_name === 'string' ? body.tool_name : '';
  if (toolName === '') return null;
  const base = {
    sessionId,
    transcriptPath: typeof body.transcript_path === 'string' ? body.transcript_path : '',
    cwd: typeof body.cwd === 'string' ? body.cwd : '',
  };
  const event = body.hook_event_name;

  if (event === 'PreToolUse' && toolName === 'AskUserQuestion') {
    const input = isObject(body.tool_input) ? body.tool_input : {};
    const rawQuestions = input.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
    return {
      kind: 'ask',
      ...base,
      questions: rawQuestions.slice(0, MAX_QUESTIONS).map(displayQuestion),
      rawQuestions,
    };
  }

  // Only a shell command shown in full is held. A PermissionRequest for
  // AskUserQuestion (it arrives only when nothing answered it at PreToolUse)
  // and every other tool fall through to Desktop.
  if (event === 'PermissionRequest' && PERMISSION_TOOLS.has(toolName)) {
    const input = isObject(body.tool_input) ? body.tool_input : {};
    const command = showableCommand(input.command);
    if (command === null) return null;
    return { kind: 'permission', ...base, toolName, command };
  }

  return null;
}

// Questions are answered at PreToolUse only (docs/superpowers/notes/hook-gate.md).
function askResponse(rawQuestions, answers) {
  const updatedInput = { questions: rawQuestions, answers: { ...answers } };
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  };
}

function permissionResponse(allow) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Huddle' },
    },
  };
}

// Multi-select answers are the chosen labels joined with ", ". The caller
// passes them in option order.
function joinMulti(labels) {
  return labels.join(', ');
}

module.exports = {
  parseHook,
  askResponse,
  permissionResponse,
  joinMulti,
  showableCommand,
  PERMISSION_TOOLS,
  MAX_COMMAND,
};
