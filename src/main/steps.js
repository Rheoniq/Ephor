'use strict';

// Turns Claude Code transcript events (one JSON object per line) into short
// step summaries. Only tool names plus a path or command are ever shown;
// message text and tool output are never included.

const fs = require('node:fs');

const TAIL_BYTES = 256 * 1024;
const MAX_LEN = 80;
const ELLIPSIS = '…';

const PATH_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

function truncate(s) {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + ELLIPSIS : s;
}

// For "<tool> <path>": keeps the tool name and the end of the path (the
// filename) and cuts the path from the left, so the result is at most MAX_LEN.
function truncatePath(name, p) {
  const full = `${name} ${p}`;
  if (full.length <= MAX_LEN) return full;
  const room = MAX_LEN - name.length - 1 - ELLIPSIS.length;
  if (room <= 0) return truncate(name);
  return `${name} ${ELLIPSIS}${p.slice(p.length - room)}`;
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function summarizeToolUse(block) {
  const name = typeof block.name === 'string' ? block.name : '';
  if (!name) return null;
  const input = block.input && typeof block.input === 'object' ? block.input : {};

  if (name === 'AskUserQuestion') return 'Asked you a question';
  if (COMMAND_TOOLS.has(name) && typeof input.command === 'string') {
    return truncate(`Ran: ${oneLine(input.command)}`);
  }
  if (PATH_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path;
    if (typeof p === 'string' && p) return truncatePath(name, oneLine(p));
  }
  return truncate(name);
}

function summarizeEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || event.type !== 'assistant') return null;
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) return null;
  // Only the first tool_use block of an event is summarised; any later
  // tool_use blocks in the same event (parallel calls) are not shown.
  const block = content.find((b) => b && b.type === 'tool_use');
  return block ? summarizeToolUse(block) : null;
}

function readTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    // Read one byte before the tail so a cut exactly on a line start is
    // recognised as a complete line.
    const start = Math.max(0, size - TAIL_BYTES - 1);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const r = fs.readSync(fd, buf, off, length - off, start + off);
      if (r === 0) break;
      off += r;
    }
    let text = buf.toString('utf8', 0, off);
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function readSteps(file, n) {
  if (!(n > 0)) return [];
  const steps = [];
  for (const line of readTail(file).split('\n')) {
    if (!line.trim()) continue;
    const s = summarizeEvent(line);
    if (s) steps.push(s);
  }
  return steps.slice(-n);
}

module.exports = { summarizeEvent, readSteps, TAIL_BYTES };
