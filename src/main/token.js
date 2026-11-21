'use strict';

// The shared secret the hooks send in X-Huddle-Token. Huddle creates it once
// in its user-data folder; the user puts it in the HUDDLE_HOOK_TOKEN user
// environment variable with the setup command. Huddle never sets the variable
// itself and never logs the token.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_RE = /^[0-9a-f]{64}$/;

// Returns the saved token. Makes, saves and returns a new one only when the
// file is missing or its content is not a token. Any other read error (no
// access, locked, a folder at the path) throws without touching the file, so
// a token the user already set up is never replaced by accident. Also throws
// when a new token cannot be saved: a token that changes on every start
// would never match the hooks. `io` stands in for fs in tests.
function loadOrCreateToken(file, io = fs) {
  let saved = null;
  try {
    saved = io.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (saved !== null && TOKEN_RE.test(saved)) return saved;
  const token = crypto.randomBytes(32).toString('hex');
  io.mkdirSync(path.dirname(file), { recursive: true });
  // The file lives in the user's own profile folder. The mode below only
  // matters on other systems: Windows ignores it and the file inherits the
  // folder's access rules.
  io.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

// The command the user runs once (then restarts Claude Desktop).
function setupCommand(token) {
  return `setx HUDDLE_HOOK_TOKEN ${token}`;
}

module.exports = { loadOrCreateToken, setupCommand };
