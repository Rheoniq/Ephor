'use strict';

// The shared secret the hooks send in X-Huddle-Token. Huddle creates it once
// in its user-data folder; the user puts it in the HUDDLE_HOOK_TOKEN user
// environment variable with the setup command. Huddle never sets the variable
// itself and never logs the token.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_RE = /^[0-9a-f]{64}$/;

// Returns the saved token, or makes, saves and returns a new one when the
// file is missing, unreadable or malformed. Throws when a new token cannot
// be saved: a token that changes on every start would never match the hooks.
function loadOrCreateToken(file) {
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(saved)) return saved;
  } catch {
    // Missing or unreadable: make a new one below.
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

// The command the user runs once (then restarts Claude Desktop).
function setupCommand(token) {
  return `setx HUDDLE_HOOK_TOKEN ${token}`;
}

module.exports = { loadOrCreateToken, setupCommand };
