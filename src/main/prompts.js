'use strict';

// Pure functions for Claude Code hook payloads: parse what a hook posts and
// build the JSON the hook answers with. Every string in a payload is
// untrusted; display fields are cut to size here, while `rawQuestions` is
// kept as received so it can be echoed back unchanged in `updatedInput`.

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_TEXT = 300;
const MAX_SUMMARY = 160;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function oneLine(value, max) {
  return truncate(String(value).replace(/\s+/g, ' ').trim(), max);
}

function displayQuestion(raw) {
  const item = isObject(raw) ? raw : {};
  const options = Array.isArray(item.options) ? item.options : [];
  return {
    question: truncate(item.question, MAX_TEXT),
    header: truncate(item.header, MAX_TEXT),
    options: options.slice(0, MAX_OPTIONS).map((opt) => {
      const o = isObject(opt) ? opt : {};
      return { label: truncate(o.label, MAX_TEXT), description: truncate(o.description, MAX_TEXT) };
    }),
    multiSelect: item.multiSelect === true,
  };
}

function summarize(toolName, toolInput) {
  const input = isObject(toolInput) ? toolInput : {};
  for (const key of ['command', 'file_path', 'url']) {
    if (typeof input[key] === 'string' && input[key].trim() !== '') {
      return oneLine(input[key], MAX_SUMMARY);
    }
  }
  return oneLine(toolName, MAX_SUMMARY);
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

  // A PermissionRequest for AskUserQuestion only arrives when nothing answered
  // it at PreToolUse, so Huddle does not hold it a second time.
  if (event === 'PermissionRequest' && toolName !== 'AskUserQuestion') {
    return {
      kind: 'permission',
      ...base,
      toolName: truncate(toolName, MAX_TEXT),
      summary: summarize(toolName, body.tool_input),
      risky: true,
    };
  }

  return null;
}

function askResponse(rawQuestions, answers, eventName = 'PreToolUse') {
  const updatedInput = { questions: rawQuestions, answers: { ...answers } };
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput },
      },
    };
  }
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

module.exports = { parseHook, askResponse, permissionResponse, joinMulti };
