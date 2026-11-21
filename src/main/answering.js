'use strict';

// Pure rules for answering hooks from the panel: which prompts the panel can
// answer in full, which buddy a hook belongs to, when a hold must end, and
// the hook response for a click. What the renderer sends is untrusted: an
// answer counts only as a known option label of a shown question, and the
// response is built from the raw hook input by index.

const path = require('node:path');
const { askResponse, permissionResponse, joinMulti, showableCommand, PERMISSION_TOOLS } = require('./prompts');
const { transcriptPath } = require('./paths');

// The card shows at most this many questions and options (as prompts.js
// cuts them). Anything larger falls through to Desktop instead of being
// answered in part.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// True when every question can be shown in full and answered by index:
// 1 to 4 questions, each with text and 1 to 4 labelled options; question
// texts unique both raw (the response keys) and as shown (the renderer's
// keys); labels unique as shown within a question.
function askAnswerable(parsed) {
  const raw = parsed.rawQuestions;
  const shown = parsed.questions;
  if (!Array.isArray(raw) || !Array.isArray(shown)) return false;
  if (raw.length === 0 || raw.length > MAX_QUESTIONS || shown.length !== raw.length) return false;
  const rawTexts = new Set();
  const shownTexts = new Set();
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const s = shown[i];
    if (!isObject(r) || !nonEmpty(r.question) || !Array.isArray(r.options)) return false;
    if (r.options.length === 0 || r.options.length > MAX_OPTIONS) return false;
    if (!isObject(s) || !Array.isArray(s.options) || s.options.length !== r.options.length) return false;
    if (rawTexts.has(r.question) || shownTexts.has(s.question)) return false;
    rawTexts.add(r.question);
    shownTexts.add(s.question);
    const labels = new Set();
    for (let j = 0; j < r.options.length; j++) {
      if (!isObject(r.options[j]) || !nonEmpty(r.options[j].label)) return false;
      const label = s.options[j].label;
      if (labels.has(label)) return false;
      labels.add(label);
    }
  }
  return true;
}

// What the renderer shows for a parsed hook, or null when the panel cannot
// answer it in full (the hook then falls through at once). A permission is
// shown only for Bash or PowerShell, with the whole command (prompts.js).
function promptView(parsed) {
  if (!isObject(parsed)) return null;
  if (parsed.kind === 'ask') {
    return askAnswerable(parsed) ? { kind: 'ask', questions: parsed.questions } : null;
  }
  if (parsed.kind === 'permission' && PERMISSION_TOOLS.has(parsed.toolName)) {
    const command = showableCommand(parsed.command);
    return command === null ? null : { kind: 'permission', toolName: parsed.toolName, command };
  }
  return null;
}

// Option index of a shown label in question i, or -1.
function labelIndex(shownQuestion, label) {
  if (typeof label !== 'string') return -1;
  return shownQuestion.options.findIndex((o) => o.label === label);
}

function askAnswers(parsed, sent) {
  const raw = parsed.rawQuestions;
  const shown = parsed.questions;
  if (!isObject(sent) || Object.keys(sent).length !== raw.length) return null;
  const answers = Object.create(null);
  for (let i = 0; i < raw.length; i++) {
    const key = shown[i].question;
    if (!own(sent, key)) return null;
    const value = sent[key];
    if (raw[i].multiSelect === true) {
      if (!Array.isArray(value) || value.length === 0) return null;
      const picked = new Set();
      for (const label of value) {
        const j = labelIndex(shown[i], label);
        if (j < 0 || picked.has(j)) return null;
        picked.add(j);
      }
      const ordered = [...picked].sort((a, b) => a - b).map((j) => raw[i].options[j].label);
      answers[raw[i].question] = joinMulti(ordered);
    } else {
      const j = labelIndex(shown[i], value);
      if (j < 0) return null;
      answers[raw[i].question] = raw[i].options[j].label;
    }
  }
  return answers;
}

// The hook response for an answer from the renderer, or null when the
// answer does not fit the prompt (main then refuses it, the prompt stays
// held and the card shows again).
// An ask needs one answer per question, keyed by the shown question text:
// a shown label for a single-select question, a non-empty list of distinct
// shown labels for a multi-select one.
function buildResponse(parsed, payload) {
  if (!isObject(parsed) || !isObject(payload) || payload.kind !== parsed.kind) return null;
  if (parsed.kind === 'permission') {
    if (!promptView(parsed)) return null;
    return typeof payload.allow === 'boolean' ? permissionResponse(payload.allow) : null;
  }
  if (parsed.kind !== 'ask' || !askAnswerable(parsed)) return null;
  const answers = askAnswers(parsed, payload.answers);
  return answers ? askResponse(parsed.rawQuestions, answers) : null;
}

// Windows paths compare without case and without a trailing separator.
function samePath(a, b) {
  if (!nonEmpty(a) || !nonEmpty(b)) return false;
  const norm = (p) => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// The visible buddy a hook belongs to, or null. A session id the registry
// knows decides on its own, so a hidden session never borrows another
// buddy. Otherwise the hook's transcript path must equal the transcript path
// of exactly one kept session, and that session must be visible. There is
// no cwd fallback: hooks fire for every Claude Code session on the machine
// (CLI, IDE, SDK), and one in the same folder is not the Desktop buddy.
function matchBuddy(parsed, ctx) {
  if (!isObject(parsed) || !isObject(ctx)) return null;
  const kept = Array.isArray(ctx.kept) ? ctx.kept : [];
  const visibleIds = new Set((Array.isArray(ctx.visible) ? ctx.visible : []).map((s) => s.sessionId));
  const pick = (s) => (visibleIds.has(s.sessionId) ? s.sessionId : null);

  const byId = kept.find((s) => s.sessionId === parsed.sessionId);
  if (byId) return pick(byId);

  const byTranscript = kept.filter(
    (s) => typeof s.cwd === 'string' && samePath(transcriptPath(ctx.home, s.cwd, s.sessionId), parsed.transcriptPath),
  );
  return byTranscript.length === 1 ? pick(byTranscript[0]) : null;
}

// Whether a held prompt must end, checked on every registry read. The
// registry may not show 'waiting' while a hook holds the request, so only a
// session seen 'waiting' and then not (Desktop was answered first) ends it,
// as do a buddy no longer visible and a panel that may no longer hold.
function holdState(entry, now) {
  const sawWaiting = !!(entry && entry.sawWaiting) || now.status === 'waiting';
  const leftWaiting = sawWaiting && now.status !== 'waiting';
  return { sawWaiting, cancel: !now.visible || !now.canHold || leftWaiting };
}

// Timing rules for answers, checked in main so a faulty renderer cannot
// approve with one message. An answer (or an arm) sooner than
// MIN_ANSWER_AGE_MS after the prompt was held is refused: the card may have
// appeared under a click meant for the row that was there before. Allow on
// a permission prompt needs an arm first (huddle:arm) and then the allow
// MIN_CONFIRM_MS to ARM_MS later, so one double-click cannot approve.
const MIN_ANSWER_AGE_MS = 500;
const MIN_CONFIRM_MS = 400;
const ARM_MS = 5000;

// A new held prompt. `sawWaiting` starts false: only registry reads made
// after the prompt arrived count, so a 'waiting' left from an earlier
// dialog cannot end a fresh hold. `now` is a monotonic time in ms.
function createHold({ id, sessionId, parsed, view, now }) {
  return { id, sessionId, parsed, view: { id, ...view }, heldAt: now, armedAt: null, sawWaiting: false };
}

// Records the first Allow click of a permission prompt. A later arm starts
// the window again. Returns false (and records nothing) for an ask or a
// prompt younger than MIN_ANSWER_AGE_MS.
function armHold(entry, now) {
  if (!isObject(entry) || !isObject(entry.parsed) || entry.parsed.kind !== 'permission') return false;
  if (now - entry.heldAt < MIN_ANSWER_AGE_MS) return false;
  entry.armedAt = now;
  return true;
}

// Whether an answer arrives at an acceptable time for its prompt.
function answerInTime(entry, payload, now) {
  if (now - entry.heldAt < MIN_ANSWER_AGE_MS) return false;
  if (entry.parsed.kind === 'permission' && payload.allow === true) {
    if (typeof entry.armedAt !== 'number') return false;
    const since = now - entry.armedAt;
    return since >= MIN_CONFIRM_MS && since <= ARM_MS;
  }
  return true;
}

module.exports = {
  promptView,
  buildResponse,
  matchBuddy,
  holdState,
  createHold,
  armHold,
  answerInTime,
  MIN_ANSWER_AGE_MS,
  MIN_CONFIRM_MS,
  ARM_MS,
};
