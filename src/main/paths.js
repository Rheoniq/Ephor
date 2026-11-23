'use strict';

// Pure path helpers for Claude Code's on-disk layout under ~/.claude.

const path = require('node:path');

// Claude Code stores a session's transcript at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, where encoded-cwd is the
// cwd with every non-alphanumeric character replaced by '-'.
function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptPath(homeDir, cwd, sessionId) {
  return path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

// The transcripts of a session's subagents live next to its transcript, in
// ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl.
function subagentsPath(homeDir, cwd, sessionId) {
  return path.join(homeDir, '.claude', 'projects', encodeCwd(cwd), String(sessionId), 'subagents');
}

// The files the agent reader needs for a registry session: { transcript,
// subagents }, or null when the session has no cwd or session id.
function agentFiles(homeDir, session) {
  if (!session || typeof session.cwd !== 'string' || !session.cwd) return null;
  if (typeof session.sessionId !== 'string' || !session.sessionId) return null;
  return {
    transcript: transcriptPath(homeDir, session.cwd, session.sessionId),
    subagents: subagentsPath(homeDir, session.cwd, session.sessionId),
  };
}

module.exports = { encodeCwd, transcriptPath, subagentsPath, agentFiles };
