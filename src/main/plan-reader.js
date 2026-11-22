'use strict';

// Reads a session's plan and last shell command from its transcript. The
// file is read backwards in chunks until the latest update_plan call that
// carries items and the latest Bash or PowerShell command are found, or the
// scan limit or the start of the file is reached. The plan calls after that
// items call, and the wrap_up calls among them (each checks the whole plan
// off), are then replayed in file order. Results are cached per file by size
// and mtime; a grown file is read forward from where the last read stopped.
// Plan text and commands are untrusted and passed on as data only.

const fs = require('node:fs');
const { applyUpdate, replayPlan, WRAP_UP } = require('./plan');

const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up';
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_COMMAND = 160;
const ELLIPSIS = '…';
const NL = 0x0a;
const TOOL_USE_MARK = Buffer.from('"tool_use"');

function emptyResult() {
  return { items: null, lastCommand: null };
}

function formatCommand(s) {
  const line = s.replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > MAX_COMMAND ? line.slice(0, MAX_COMMAND - 1) + ELLIPSIS : line;
}

// Returns the tool_use blocks of one transcript line, in order, or [] when
// the line is not an assistant event or does not parse.
function toolUses(lineBuf) {
  if (lineBuf.indexOf(TOOL_USE_MARK) === -1) return [];
  let event;
  try {
    event = JSON.parse(lineBuf.toString('utf8'));
  } catch {
    return [];
  }
  if (!event || event.type !== 'assistant') return [];
  // Subagent transcripts normally live in separate files; a sidechain event
  // that does show up here must never reach the parent's plan or command.
  if (event.isSidechain === true) return [];
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string');
}

function commandOf(block) {
  if (!COMMAND_TOOLS.has(block.name)) return null;
  const input = block.input;
  if (!input || typeof input.command !== 'string') return null;
  return formatCommand(input.command);
}

// The plan input of a block: an update_plan call's input, the WRAP_UP marker
// for a wrap_up call (it checks the whole plan off), else undefined.
function planInputOf(block) {
  if (block.name === PLAN_TOOL) return block.input;
  if (block.name === WRAP_UP_TOOL) return WRAP_UP;
  return undefined;
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const r = fs.readSync(fd, buf, off, length - off, start + off);
    if (r === 0) break;
    off += r;
  }
  return off === length ? buf : buf.subarray(0, off);
}

// Scans backwards from the end of the last complete line. Returns the state
// the cache keeps: current items, last command and the byte offset just past
// the last complete line.
function scanBackward(fd, size, chunkBytes, maxScanBytes) {
  let buf = readRange(fd, Math.max(0, size - Math.min(chunkBytes, size)), Math.min(chunkBytes, size));
  let bufStart = size - buf.length;
  // Find the end of the last complete line; an unterminated tail is still
  // being written and is skipped. A complete final line without a trailing
  // newline therefore stays invisible until another line is appended.
  let end = buf.lastIndexOf(NL);
  while (end === -1 && bufStart > 0 && size - bufStart < maxScanBytes) {
    const len = Math.min(chunkBytes, bufStart);
    buf = Buffer.concat([readRange(fd, bufStart - len, len), buf]);
    bufStart -= len;
    end = buf.lastIndexOf(NL);
  }
  if (end === -1) return { items: null, lastCommand: null, parsedEnd: bufStart === 0 ? 0 : size };
  const parsedEnd = bufStart + end + 1;

  const inputs = [];
  let lastCommand = null;
  let foundItems = false;
  let scanned = size - bufStart;
  // `pending` holds bytes [bufStart, lineEnd) not yet split into lines.
  let pending = buf.subarray(0, end);
  let pendingStart = bufStart;

  const visit = (line) => {
    const blocks = toolUses(line);
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (lastCommand === null) {
        const c = commandOf(b);
        if (c) lastCommand = c;
      }
      if (!foundItems) {
        const input = planInputOf(b);
        if (input !== undefined) {
          inputs.push(input);
          if (input && typeof input === 'object' && Array.isArray(input.items)) foundItems = true;
        }
      }
    }
  };

  for (;;) {
    let nl = pending.lastIndexOf(NL);
    while (nl !== -1 && !(foundItems && lastCommand !== null)) {
      visit(pending.subarray(nl + 1));
      pending = pending.subarray(0, nl);
      nl = pending.lastIndexOf(NL);
    }
    if (foundItems && lastCommand !== null) break;
    if (pendingStart === 0) {
      // The first line of the file is complete.
      if (pending.length) visit(pending);
      break;
    }
    if (scanned >= maxScanBytes) break; // `pending` is a cut line: skipped.
    const len = Math.min(chunkBytes, pendingStart, maxScanBytes - scanned);
    const chunk = readRange(fd, pendingStart - len, len);
    if (chunk.length !== len) break;
    pending = Buffer.concat([chunk, pending]);
    pendingStart -= len;
    scanned += len;
  }

  inputs.reverse();
  const items = foundItems ? replayPlan(inputs) : null;
  return { items, lastCommand, parsedEnd };
}

// Reads [from, size) forward and applies complete lines onto `state`.
function scanForward(fd, from, size, state) {
  const buf = readRange(fd, from, size - from);
  const end = buf.lastIndexOf(NL);
  if (end === -1) return state;
  let items = state.items;
  let lastCommand = state.lastCommand;
  let pos = 0;
  while (pos <= end) {
    const nl = buf.indexOf(NL, pos);
    for (const b of toolUses(buf.subarray(pos, nl))) {
      const c = commandOf(b);
      if (c) lastCommand = c;
      const input = planInputOf(b);
      if (input !== undefined) items = applyUpdate(items, input);
    }
    pos = nl + 1;
  }
  return { items, lastCommand, parsedEnd: from + end + 1 };
}

function createPlanReader(opts = {}) {
  const chunkBytes = opts.chunkBytes > 0 ? Math.floor(opts.chunkBytes) : 262144;
  const maxScanBytes = opts.maxScanBytes > 0 ? Math.floor(opts.maxScanBytes) : 8388608;
  const cache = new Map();

  function read(file) {
    const prev = typeof file === 'string' ? cache.get(file) : undefined;
    const fallback = () => (prev ? prev.result : emptyResult());
    if (typeof file !== 'string' || !file) return emptyResult();
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return fallback();
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return fallback();
      const size = st.size;
      const mtimeMs = st.mtimeMs;
      if (prev && prev.size === size && prev.mtimeMs === mtimeMs) return prev.result;

      let state;
      if (canResume(fd, prev, size, mtimeMs, maxScanBytes)) {
        state = scanForward(fd, prev.parsedEnd, size, prev.state);
      } else {
        state = scanBackward(fd, size, chunkBytes, maxScanBytes);
      }
      const result = freezeResult(state.items, state.lastCommand);
      cache.set(file, { size, mtimeMs, parsedEnd: state.parsedEnd, state: { ...state, items: result.items }, result });
      return result;
    } catch {
      return fallback();
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  // Drops the cached result for a file (for example a session that left).
  function forget(file) {
    cache.delete(file);
  }

  return { read, forget };
}

// The forward path is only safe when the file was appended to: it grew, its
// mtime did not go back, and the byte just before the resume offset is still
// the newline that ended the last parsed line. Anything else is treated as a
// rewrite and gets a full backward scan.
function canResume(fd, prev, size, mtimeMs, maxScanBytes) {
  if (!prev) return false;
  if (size <= prev.size || size < prev.parsedEnd) return false;
  if (mtimeMs < prev.mtimeMs) return false;
  if (size - prev.parsedEnd > maxScanBytes) return false;
  if (prev.parsedEnd === 0) return true;
  const b = readRange(fd, prev.parsedEnd - 1, 1);
  return b.length === 1 && b[0] === NL;
}

// Results are shared with callers and kept in the cache, so they are frozen.
function freezeResult(items, lastCommand) {
  const frozen = Array.isArray(items) ? Object.freeze(items.map((i) => Object.freeze({ ...i }))) : null;
  return Object.freeze({ items: frozen, lastCommand });
}

module.exports = { createPlanReader };
