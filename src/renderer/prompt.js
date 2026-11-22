'use strict';

// State of one prompt card: which question of an ask is shown, the options
// picked so far, and the two-click confirm for Allow on a permission prompt.
// It holds no DOM. Plain script: in the page it sets window.HuddlePrompt,
// under Node it is a CommonJS module.

(function (root) {
  // Timing guards against clicks the user did not mean. Main checks the same
  // rules (src/main/answering.js: 500 ms age, Allow 400 ms to 5 s after the
  // arm); the values here are stricter by 200 ms and 500 ms, room for IPC
  // delays, so main rarely refuses what this card sends. Main's clock starts
  // earlier than this card's, which only adds margin. When main does refuse
  // an answer or an arm, it says so (huddle:answer-refused) and the card
  // comes back through refused().
  // A click on a card or question younger than this is ignored: it may have
  // been meant for what was under the cursor before the card appeared.
  const MIN_AGE_MS = 500;
  // A first click on Allow arms it; a second click sends only between these
  // two times later, so the second click of a double-click never approves.
  const MIN_CONFIRM_MS = 600;
  const ARM_MS = 4500;
  // Prompt ids from main are UUIDs; main ignores ids longer than this.
  const MAX_ID_LEN = 100;

  // The prompt id in a huddle:answer-refused message, or null.
  function refusedId(payload) {
    return typeof payload === 'string' && payload !== '' && payload.length <= MAX_ID_LEN ? payload : null;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validQuestion(q) {
    if (!isObject(q) || typeof q.question !== 'string' || q.question.trim() === '') return false;
    if (!Array.isArray(q.options) || q.options.length === 0) return false;
    const labels = new Set();
    for (const o of q.options) {
      if (!isObject(o) || typeof o.label !== 'string' || o.label === '' || labels.has(o.label)) return false;
      labels.add(o.label);
    }
    return true;
  }

  function validPrompt(p) {
    if (!isObject(p) || typeof p.id !== 'string' || p.id === '') return false;
    if (p.kind === 'ask') {
      if (!Array.isArray(p.questions) || p.questions.length === 0) return false;
      // Answers are keyed by question text, so the texts must differ.
      const texts = new Set();
      for (const q of p.questions) {
        if (!validQuestion(q) || texts.has(q.question)) return false;
        texts.add(q.question);
      }
      return true;
    }
    if (p.kind === 'permission') {
      // Allow is offered only with the whole command on the card.
      return typeof p.toolName === 'string' && typeof p.command === 'string' && p.command !== '';
    }
    return false;
  }

  // Answers use a null-prototype object, so a question text such as
  // "__proto__" is stored as a plain key.
  function copyAnswers(answers) {
    const out = Object.create(null);
    for (const key of Object.keys(answers)) {
      const value = answers[key];
      out[key] = Array.isArray(value) ? value.slice() : value;
    }
    return out;
  }

  // A monotonic clock, so a change of the system time cannot open or close
  // a timing window.
  function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function createPromptState(options) {
    const now = options && typeof options.now === 'function' ? options.now : defaultNow;
    let prompt = null;
    let index = 0; // question shown, for an ask
    let chosen = new Set(); // labels picked on a multi-select question
    let answers = Object.create(null);
    let armedAt = null;
    let answered = false;
    let shownAt = 0; // when the current card or question appeared

    function reset() {
      prompt = null;
      index = 0;
      chosen = new Set();
      answers = Object.create(null);
      armedAt = null;
      answered = false;
      shownAt = 0;
    }

    // Shows a prompt. The same id again keeps the progress made so far.
    function show(p) {
      if (!validPrompt(p)) {
        reset();
        return false;
      }
      if (prompt && prompt.id === p.id) return true;
      reset();
      prompt = p;
      shownAt = now();
      return true;
    }

    function settled() {
      return now() - shownAt >= MIN_AGE_MS;
    }

    function openQuestion() {
      return prompt && prompt.kind === 'ask' && !answered && settled() ? prompt.questions[index] : null;
    }

    function hasLabel(q, label) {
      return typeof label === 'string' && q.options.some((o) => o.label === label);
    }

    function chosenInOrder(q) {
      return q.options.map((o) => o.label).filter((label) => chosen.has(label));
    }

    function advance(value) {
      answers[prompt.questions[index].question] = value;
      chosen = new Set();
      if (index + 1 < prompt.questions.length) {
        index += 1;
        // The next question appears where the click just landed.
        shownAt = now();
        return { done: false };
      }
      answered = true;
      return { done: true, answers: copyAnswers(answers) };
    }

    function answerQuestion(label) {
      const q = openQuestion();
      if (!q || q.multiSelect === true || !hasLabel(q, label)) return { done: false };
      return advance(label);
    }

    // Returns whether the label is picked after the toggle.
    function toggleOption(label) {
      const q = openQuestion();
      if (!q || q.multiSelect !== true || !hasLabel(q, label)) return false;
      if (chosen.has(label)) {
        chosen.delete(label);
        return false;
      }
      chosen.add(label);
      return true;
    }

    // Multi-select answers are the picked labels in option order.
    function finishMulti() {
      const q = openQuestion();
      if (!q || q.multiSelect !== true || chosen.size === 0) return { done: false };
      return advance(chosenInOrder(q));
    }

    function openPermission() {
      return !!prompt && prompt.kind === 'permission' && !answered;
    }

    function confirmPending() {
      return openPermission() && armedAt !== null && now() - armedAt < ARM_MS;
    }

    // 'send' only on a second click MIN_CONFIRM_MS to ARM_MS after the
    // first. A second click sooner than that is ignored and keeps the first
    // arm. Anything else returns 'armed' without sending: no open permission
    // prompt, a card younger than MIN_AGE_MS (nothing is armed then), or a
    // click that arms. A caller sends only on 'send', so it never sends twice.
    function armAllow() {
      if (!openPermission() || !settled()) return 'armed';
      if (confirmPending()) {
        if (now() - armedAt < MIN_CONFIRM_MS) return 'armed';
        answered = true;
        armedAt = null;
        return 'send';
      }
      armedAt = now();
      return 'armed';
    }

    // Deny is one click, once the card is MIN_AGE_MS old.
    function deny() {
      if (!openPermission() || !settled()) return false;
      answered = true;
      armedAt = null;
      return true;
    }

    // Main refused the answer or the arm sent for this prompt: the card is
    // shown again, unarmed, at the question it was on (earlier answers of an
    // ask are kept). A card that was hidden by the answer gets a new minimum
    // age, as it comes back under the cursor. Returns false with no prompt.
    function refused() {
      if (!prompt) return false;
      if (answered) shownAt = now();
      answered = false;
      armedAt = null;
      return true;
    }

    function current() {
      if (!prompt) return null;
      if (prompt.kind === 'ask') {
        const q = prompt.questions[index];
        return {
          id: prompt.id,
          kind: 'ask',
          answered,
          index,
          count: prompt.questions.length,
          question: q,
          chosen: chosenInOrder(q),
        };
      }
      return {
        id: prompt.id,
        kind: 'permission',
        answered,
        toolName: prompt.toolName,
        command: prompt.command,
        armed: confirmPending(),
      };
    }

    return {
      show,
      current,
      answerQuestion,
      toggleOption,
      finishMulti,
      confirmPending,
      armAllow,
      deny,
      refused,
      reset,
    };
  }

  // DOM ids for one prompt card, derived from the prompt id so they stay the
  // same across re-renders. Every character other than a letter, a digit or
  // a hyphen becomes "_<hex code point>_", so two prompt ids never share ids.
  function promptDomIds(promptId) {
    const safe = String(promptId).replace(/[^A-Za-z0-9-]/gu, (c) => `_${c.codePointAt(0).toString(16)}_`);
    const base = `prompt-${safe}`;
    return { kicker: `${base}-kicker`, text: `${base}-text`, command: `${base}-command` };
  }

  // The line under a card that says where else the prompt can be answered
  // and that the card closes after the 15 s hold: the terminal for a
  // terminal session, Claude Desktop for any other.
  function promptHint(source) {
    const where = source === 'terminal' ? 'the terminal' : 'Claude Desktop';
    return `Or answer in ${where} (closes in 15 s)`;
  }

  const api = { createPromptState, refusedId, promptDomIds, promptHint, ARM_MS, MIN_CONFIRM_MS, MIN_AGE_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddlePrompt = api;
})(typeof window !== 'undefined' ? window : globalThis);
