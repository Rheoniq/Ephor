'use strict';

// Pure plan model. Replays the agent's update_plan tool inputs into a list of
// items. Item text comes from transcripts and is untrusted: it is only
// collapsed to one line, truncated and passed on as data.

const MAX_ITEMS = 30;
const MAX_CONTENT = 200;
const ELLIPSIS = '…';
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function oneLine(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (out.length >= MAX_ITEMS) break;
    if (!isObject(it) || typeof it.content !== 'string') continue;
    let content = oneLine(it.content);
    if (!content) continue;
    if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + ELLIPSIS;
    const status = STATUSES.has(it.status) ? it.status : 'pending';
    out.push({ content, status });
  }
  return out;
}

function validIndex(n, len) {
  return Number.isInteger(n) && n >= 1 && n <= len;
}

function applyUpdate(items, input) {
  if (!isObject(input)) return items;
  if (Array.isArray(input.items)) return normalizeItems(input.items);
  if (!Array.isArray(items)) return items;

  if (input.advance === true) {
    if (items.length === 0) return items;
    const next = items.map((i) => ({ ...i }));
    let idx = next.findIndex((i) => i.status === 'in_progress');
    if (idx === -1) idx = next.findIndex((i) => i.status === 'pending');
    if (idx === -1) return items;
    next[idx].status = 'completed';
    let start = next.findIndex((i, k) => k > idx && i.status === 'pending');
    if (start === -1) start = next.findIndex((i) => i.status === 'pending');
    if (start !== -1) next[start].status = 'in_progress';
    return next;
  }

  const hasDone = Array.isArray(input.done);
  const hasStart = Number.isInteger(input.start);
  if (!hasDone && !hasStart) return items;

  const next = items.map((i) => ({ ...i }));
  if (hasDone) {
    for (const n of input.done) {
      if (validIndex(n, next.length)) next[n - 1].status = 'completed';
    }
  }
  if (hasStart && validIndex(input.start, next.length)) {
    // Only one item is in progress: a started item moves any other active
    // item back to pending. `done` is applied first, so an index in both
    // `done` and `start` (for example {done:[2],start:2}) ends in progress.
    for (const i of next) if (i.status === 'in_progress') i.status = 'pending';
    next[input.start - 1].status = 'in_progress';
  }
  return next;
}

function replayPlan(inputs) {
  if (!Array.isArray(inputs)) return null;
  let items = null;
  for (const input of inputs) items = applyUpdate(items, input);
  return items;
}

function summarize(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const total = items.length;
  const done = items.filter((i) => i.status === 'completed').length;
  let idx = items.findIndex((i) => i.status === 'in_progress');
  if (idx === -1) idx = items.findIndex((i) => i.status === 'pending');
  const state = idx === -1 ? 'complete' : 'active';
  if (idx === -1) idx = total - 1;
  return { total, current: idx + 1, phase: items[idx].content, done, state };
}

module.exports = { normalizeItems, applyUpdate, replayPlan, summarize, MAX_ITEMS, MAX_CONTENT };
