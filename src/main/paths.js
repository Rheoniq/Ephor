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

module.exports = { encodeCwd, transcriptPath };
