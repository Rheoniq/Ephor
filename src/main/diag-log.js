'use strict';

// A small diagnostic log: one line per status decision, so an intermittent
// "Finished too early" can be diagnosed afterwards. It records ids cut to 8
// characters, statuses and counts only; never names, paths, plan text,
// commands or prompt text. createDiagLog never throws: a failing write is
// dropped. The file is rotated to <file>.old when it grows past maxBytes.

const fs = require('node:fs');

const MAX_BYTES = 256 * 1024;
const MAX_LINE = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

function clean(line) {
  return String(line).replace(CONTROL, '').slice(0, MAX_LINE);
}

function createDiagLog({ file, now, maxBytes } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BYTES;
  let size = null; // bytes in the file, read lazily

  function stamp() {
    try {
      const t = clock();
      const d = t instanceof Date ? t : new Date(t);
      return d.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  function rotate() {
    try {
      fs.rmSync(`${file}.old`, { force: true });
      fs.renameSync(file, `${file}.old`);
    } catch {
      /* ignore */
    }
    size = 0;
  }

  function log(line) {
    try {
      if (typeof file !== 'string' || !file) return;
      const text = `${stamp()} ${clean(line)}\n`;
      if (size === null) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      if (size > limit) rotate();
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      /* never throw */
    }
  }

  function close() {
    size = null;
  }

  return { log, close };
}

function flag(v) {
  return v ? 1 : 0;
}

// The one-line state tuple of a session. Every field is a status word or a
// count; an unknown value is written as '?'.
function formatState(s) {
  const o = s && typeof s === 'object' ? s : {};
  const word = (v) => (typeof v === 'string' && /^[a-z]{1,16}$/.test(v) ? v : '?');
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  const id = typeof o.sessionId === 'string' ? o.sessionId.slice(0, 8) : '?';
  return (
    `sess ${id} reg=${word(o.reg)} pending=${count(o.pending)} settle=${word(o.settle)} ` +
    `eff=${word(o.eff)} finished=${flag(o.finished)} shown=${flag(o.shown)} ` +
    `prompt=${flag(o.prompt)} src=${word(o.src)}`
  );
}

// Change-only logging over the kept sessions of each read: a line when a
// session first appears, when its state tuple changes, and when it leaves.
function createStateLogger(log) {
  const last = new Map(); // sessionId -> last logged state line

  function say(line) {
    try {
      log(line);
    } catch {
      /* ignore */
    }
  }

  function observe(states) {
    const seen = new Set();
    for (const s of Array.isArray(states) ? states : []) {
      if (!s || typeof s.sessionId !== 'string') continue;
      seen.add(s.sessionId);
      const line = formatState(s);
      const before = last.get(s.sessionId);
      if (before === undefined) say(`sess ${s.sessionId.slice(0, 8)} appeared`);
      if (before !== line) {
        last.set(s.sessionId, line);
        say(line);
      }
    }
    for (const id of [...last.keys()]) {
      if (seen.has(id)) continue;
      last.delete(id);
      say(`sess ${id.slice(0, 8)} left`);
    }
  }

  return { observe };
}

module.exports = { createDiagLog, createStateLogger, formatState, MAX_BYTES, MAX_LINE };
