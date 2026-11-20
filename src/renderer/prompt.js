'use strict';

// State of one prompt card: which question of an ask is shown, the options
// picked so far, and the two-click confirm for Allow on a permission prompt.
// It holds no DOM. Plain script: in the page it sets window.HuddlePrompt,
// under Node it is a CommonJS module.

(function (root) {
  // A first click on Allow arms it; a second click within this time sends.
  const ARM_MS = 5000;

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
      return typeof p.toolName === 'string' && (p.summary === undefined || typeof p.summary === 'string');
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

  function createPromptState(options) {
    const now = options && typeof options.now === 'function' ? options.now : Date.now;
    let prompt = null;
    let index = 0; // question shown, for an ask
    let chosen = new Set(); // labels picked on a multi-select question
    let answers = Object.create(null);
    let armedAt = null;
    let answered = false;

    function reset() {
      prompt = null;
      index = 0;
      chosen = new Set();
      answers = Object.create(null);
      armedAt = null;
      answered = false;
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
      return true;
    }

    function openQuestion() {
      return prompt && prompt.kind === 'ask' && !answered ? prompt.questions[index] : null;
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

    // 'send' only on the second click within ARM_MS. Without an open
    // permission prompt it returns 'armed' and changes nothing, so a caller
    // that sends only on 'send' never sends twice.
    function armAllow() {
      if (!openPermission()) return 'armed';
      if (confirmPending()) {
        answered = true;
        armedAt = null;
        return 'send';
      }
      armedAt = now();
      return 'armed';
    }

    // Deny is always one click.
    function deny() {
      if (!openPermission()) return false;
      answered = true;
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
        summary: typeof prompt.summary === 'string' ? prompt.summary : '',
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
      reset,
    };
  }

  const api = { createPromptState, ARM_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddlePrompt = api;
})(typeof window !== 'undefined' ? window : globalThis);
