'use strict';

// Reads Claude Code's session registry (~/.claude/sessions/<pid>.json).
// Read-only: never writes to or deletes anything in the registry dir.

const fs = require('node:fs');
const path = require('node:path');

const KNOWN_STATUSES = new Set(['busy', 'waiting', 'idle']);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it.
    return err.code === 'EPERM';
  }
}

function readSessions(dir, isAlive) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const sessions = [];
  for (const file of entries) {
    if (path.extname(file) !== '.json') continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    // Interactive sessions only: Desktop and terminal (cli). Headless and SDK
    // sessions have another kind and are dropped.
    if (data.kind !== 'interactive') continue;
    // sessionId ends up in a transcript path and in IPC: accept only a UUID.
    if (typeof data.sessionId !== 'string' || !SESSION_ID_RE.test(data.sessionId)) continue;
    if (!isAlive(data.pid)) continue;

    const entrypoint = typeof data.entrypoint === 'string' ? data.entrypoint : '';
    const hasHost = typeof data.hostSessionId === 'string' && data.hostSessionId !== '';
    // A Desktop session can be opened by its hostSessionId; any other
    // interactive session runs in a terminal and has none.
    const source = entrypoint === 'claude-desktop' && hasHost ? 'desktop' : 'terminal';

    sessions.push({
      sessionId: data.sessionId,
      hostSessionId: source === 'desktop' ? data.hostSessionId : undefined,
      name: data.name,
      status: KNOWN_STATUSES.has(data.status) ? data.status : 'idle',
      cwd: data.cwd,
      pid: data.pid,
      updatedAt: data.updatedAt,
      // Main only (a pid-reuse guard); never sent to the renderer.
      procStart: data.procStart,
      source,
      entrypoint,
    });
  }
  return sessions;
}

module.exports = { readSessions, pidIsAlive };
