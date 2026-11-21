'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { createHookServer } = require('../src/main/hooks');
const { promptView, matchBuddy } = require('../src/main/answering');

const TOKEN = 'a1'.repeat(32);
const SESSION = 'cd47e535-4ad5-4353-b403-4cd8a2f1f0c7';
const BUDDY = 'buddy-cd47e535';

function permissionBody(sessionId = SESSION, overrides = {}) {
  return {
    session_id: sessionId,
    transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl',
    cwd: 'C:\\Users\\x\\TEST',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    ...overrides,
  };
}

function askBody(sessionId = SESSION) {
  return {
    session_id: sessionId,
    transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\t.jsonl',
    cwd: 'C:\\Users\\x\\TEST',
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [
        {
          question: 'Pick one?',
          header: 'Pick',
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
          multiSelect: false,
        },
      ],
    },
  };
}

// Starts a hook server on a port the OS picks (never the real 47821) and
// stops it when the test ends. Every onPrompt and onCancel call is recorded
// and also emitted on `events` so a test can wait for it.
async function startServer(t, options = {}) {
  const events = new EventEmitter();
  const prompts = [];
  const cancels = [];
  const hooks = createHookServer({
    token: TOKEN,
    port: 0,
    canHold: () => true,
    findBuddy: (parsed) => (parsed.sessionId === SESSION ? BUDDY : null),
    onPrompt: (prompt) => {
      prompts.push(prompt);
      events.emit('prompt', prompt);
    },
    onCancel: (id) => {
      cancels.push(id);
      events.emit('cancel', id);
    },
    ...options,
  });
  t.after(() => hooks.stop());
  assert.equal(await hooks.start(), 'listening');
  return { hooks, port: hooks.address().port, events, prompts, cancels };
}

// One request on its own connection (`agent: false`, so no socket outlives
// the test). Returns the request and a promise of the response.
function request(port, { method = 'POST', path = '/hook', token = TOKEN, body, chunked = false } = {}) {
  let payload;
  if (body === undefined) payload = undefined;
  else if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
  else payload = JSON.stringify(body);
  const headers = {};
  if (token !== null) headers['x-huddle-token'] = token;
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false });
  const response = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  if (chunked && payload !== undefined) {
    const buf = Buffer.from(payload);
    for (let i = 0; i < buf.length; i += 4096) req.write(buf.subarray(i, i + 4096));
    req.end();
  } else {
    req.end(payload);
  }
  return { req, response };
}

const send = (port, options) => request(port, options).response;

test('a request without the token or with a wrong one gets 401', async (t) => {
  const { port, prompts } = await startServer(t);
  assert.equal((await send(port, { token: null, body: permissionBody() })).status, 401);
  assert.equal((await send(port, { token: 'b1'.repeat(32), body: permissionBody() })).status, 401);
  assert.equal((await send(port, { token: 'short', body: permissionBody() })).status, 401);
  assert.equal((await send(port, { token: `${TOKEN}x`, body: permissionBody() })).status, 401);
  assert.equal(prompts.length, 0);
});

test('an empty configured token rejects every request', async (t) => {
  const { port, prompts } = await startServer(t, { token: '' });
  assert.equal((await send(port, { token: '', body: permissionBody() })).status, 401);
  assert.equal((await send(port, { token: null, body: permissionBody() })).status, 401);
  assert.equal(prompts.length, 0);
});

test('another path gets 404', async (t) => {
  const { port } = await startServer(t);
  assert.equal((await send(port, { path: '/other', body: permissionBody() })).status, 404);
  assert.equal((await send(port, { path: '/', body: permissionBody() })).status, 404);
});

test('a method other than POST on /hook gets 405', async (t) => {
  const { port } = await startServer(t);
  const res = await send(port, { method: 'GET' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('a 200 KiB body gets 413 and the server still serves the next request', async (t) => {
  const { hooks, port, events, prompts } = await startServer(t);
  const big = 'x'.repeat(200 * 1024);
  assert.equal((await send(port, { body: big })).status, 413);
  assert.equal((await send(port, { body: big, chunked: true })).status, 413);
  assert.equal(prompts.length, 0);
  const promptSeen = once(events, 'prompt');
  const next = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  assert.equal(hooks.resolve(prompt.id, { ok: true }), true);
  assert.equal((await next).status, 200);
});

test('a body declared far over the limit is cut at once and the server keeps serving', async (t) => {
  const { port, prompts } = await startServer(t);
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/hook',
    agent: false,
    headers: { 'x-huddle-token': TOKEN, 'content-length': String(64 * 1024 * 1024) },
  });
  // The client sees a 413 or a reset, depending on timing; both end it.
  const ended = new Promise((resolve) => {
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (err) => resolve(err.code));
  });
  const started = Date.now();
  req.write('{"session_id":');
  assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(await ended));
  // At once: not after the 2 s drain window for smaller oversized bodies.
  assert.ok(Date.now() - started < 1500);
  req.destroy();
  assert.equal((await send(port, { body: permissionBody('another-session') })).status, 204);
  assert.equal(prompts.length, 0);
});

test('the default body limit is 64 KiB', async (t) => {
  const { port } = await startServer(t);
  const atLimit = 'x'.repeat(64 * 1024);
  assert.equal((await send(port, { body: atLimit })).status, 400);
  assert.equal((await send(port, { body: `${atLimit}x` })).status, 413);
});

test('a custom maxBody is honoured', async (t) => {
  const { port } = await startServer(t, { maxBody: 100 });
  assert.equal((await send(port, { body: 'x'.repeat(101), chunked: true })).status, 413);
  assert.equal((await send(port, { body: 'x'.repeat(100) })).status, 400);
});

test('a maxBody above the drain bound still reads bodies up to maxBody', async (t) => {
  const { port } = await startServer(t, { maxBody: 6 * 1024 * 1024 });
  assert.equal((await send(port, { body: 'x'.repeat(5 * 1024 * 1024) })).status, 400);
});

test('invalid JSON gets 400', async (t) => {
  const { port, prompts } = await startServer(t);
  assert.equal((await send(port, { body: '{' })).status, 400);
  assert.equal(prompts.length, 0);
});

test('a hook parseHook does not handle gets 204 at once', async (t) => {
  const { port, prompts } = await startServer(t);
  // A PermissionRequest for AskUserQuestion is not held a second time.
  const askPermission = permissionBody(SESSION, {
    tool_name: 'AskUserQuestion',
    tool_input: askBody().tool_input,
  });
  const res = await send(port, { body: askPermission });
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  assert.equal((await send(port, { body: permissionBody(SESSION, { hook_event_name: 'PostToolUse' }) })).status, 204);
  assert.equal((await send(port, { body: [] })).status, 204);
  assert.equal(prompts.length, 0);
});

test('canHold false gets 204 without looking for a buddy', async (t) => {
  let looked = 0;
  const { port, prompts } = await startServer(t, {
    canHold: () => false,
    findBuddy: () => {
      looked += 1;
      return BUDDY;
    },
  });
  assert.equal((await send(port, { body: permissionBody() })).status, 204);
  assert.equal(looked, 0);
  assert.equal(prompts.length, 0);
});

test('a session without a buddy gets 204', async (t) => {
  const { port, prompts } = await startServer(t);
  assert.equal((await send(port, { body: permissionBody('another-session') })).status, 204);
  assert.equal(prompts.length, 0);
});

test('a hook from a session not in the registry gets 204 even when a buddy shares its cwd', async (t) => {
  // The real matching rules, as main wires them.
  const buddy = { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', cwd: 'C:\\Users\\x\\TEST' };
  const ctx = { kept: [buddy], visible: [buddy], home: 'C:\\Users\\x' };
  const { hooks, port, events, prompts } = await startServer(t, {
    findBuddy: (parsed) => (promptView(parsed) ? matchBuddy(parsed, ctx) : null),
  });
  // Same cwd as the buddy, its own session id and transcript: a CLI session.
  assert.equal((await send(port, { body: permissionBody('cli-session') })).status, 204);
  assert.equal((await send(port, { body: askBody('cli-session') })).status, 204);
  assert.equal(prompts.length, 0);
  // The buddy's own session is held.
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody(buddy.sessionId) });
  const [prompt] = await promptSeen;
  assert.equal(prompt.sessionId, buddy.sessionId);
  assert.equal(hooks.resolve(prompt.id, null), true);
  assert.equal((await pending).status, 204);
});

test('a held permission prompt receives the resolved JSON', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  assert.equal(typeof prompt.id, 'string');
  assert.ok(prompt.id.length > 0);
  assert.equal(prompt.sessionId, BUDDY);
  assert.equal(prompt.eventName, 'PermissionRequest');
  assert.equal(prompt.parsed.kind, 'permission');
  assert.equal(prompt.parsed.sessionId, SESSION);
  assert.equal(hooks.pendingFor(BUDDY), prompt.id);

  const decision = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  };
  assert.equal(hooks.resolve(prompt.id, decision), true);
  const res = await pending;
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), decision);
  assert.equal(hooks.resolve(prompt.id, decision), false);
  assert.equal(hooks.pendingFor(BUDDY), null);
  assert.deepEqual(cancels, []);
});

test('a held question passes PreToolUse and resolve with null gives 204', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: askBody() });
  const [prompt] = await promptSeen;
  assert.equal(prompt.eventName, 'PreToolUse');
  assert.equal(prompt.parsed.kind, 'ask');
  assert.equal(hooks.resolve(prompt.id, null), true);
  const res = await pending;
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  assert.deepEqual(cancels, []);
});

test('a second prompt for a session with one pending gets 204', async (t) => {
  const { hooks, port, events, prompts } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const first = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  assert.equal((await send(port, { body: askBody() })).status, 204);
  assert.equal(prompts.length, 1);
  assert.equal(hooks.pendingFor(BUDDY), prompt.id);
  assert.equal(hooks.resolve(prompt.id, { ok: true }), true);
  assert.equal((await first).status, 200);
});

test('after holdMs the request gets 204 and onCancel runs', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t, { holdMs: 50 });
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  const res = await pending;
  assert.equal(res.status, 204);
  assert.deepEqual(cancels, [prompt.id]);
  assert.equal(hooks.resolve(prompt.id, { late: true }), false);
  assert.equal(hooks.pendingFor(BUDDY), null);
});

test('a client that disconnects while held triggers onCancel', async (t) => {
  // A long hold, so only the disconnect (not the timeout) can cancel in time.
  const { hooks, port, events, cancels } = await startServer(t, { holdMs: 60000 });
  const promptSeen = once(events, 'prompt');
  const { req, response } = request(port, { body: permissionBody() });
  response.catch(() => {});
  const [prompt] = await promptSeen;
  const cancelled = once(events, 'cancel', { signal: AbortSignal.timeout(2000) });
  req.destroy();
  assert.deepEqual(await cancelled, [prompt.id]);
  assert.deepEqual(cancels, [prompt.id]);
  assert.equal(hooks.pendingFor(BUDDY), null);
  assert.equal(hooks.resolve(prompt.id, { late: true }), false);
});

test('cancelSession answers 204 and calls onCancel', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  hooks.cancelSession('not-a-buddy');
  assert.equal(hooks.pendingFor(BUDDY), prompt.id);
  hooks.cancelSession(BUDDY);
  assert.equal((await pending).status, 204);
  assert.deepEqual(cancels, [prompt.id]);
  assert.equal(hooks.pendingFor(BUDDY), null);
  assert.equal(hooks.resolve(prompt.id, { late: true }), false);
});

test('an answer that cannot be serialized falls through with 204 and onCancel', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  const circular = {};
  circular.self = circular;
  assert.equal(hooks.resolve(prompt.id, circular), false);
  assert.equal((await pending).status, 204);
  assert.deepEqual(cancels, [prompt.id]);
  assert.equal(hooks.pendingFor(BUDDY), null);
});

test('resolve and pendingFor know nothing of unknown ids and sessions', async (t) => {
  const { hooks } = await startServer(t);
  assert.equal(hooks.resolve('nope', { ok: true }), false);
  assert.equal(hooks.pendingFor(BUDDY), null);
});

test('a throwing callback falls through with 204 and the server keeps serving', async (t) => {
  let mode = 'canHold';
  const { hooks, port, cancels } = await startServer(t, {
    canHold: () => {
      if (mode === 'canHold') throw new Error('boom');
      return true;
    },
    findBuddy: () => {
      if (mode === 'findBuddy') throw new Error('boom');
      return BUDDY;
    },
    onPrompt: () => {
      throw new Error('boom');
    },
    onCancel: (id) => {
      cancels.push(id);
      throw new Error('boom');
    },
  });
  assert.equal((await send(port, { body: permissionBody() })).status, 204);
  mode = 'findBuddy';
  assert.equal((await send(port, { body: permissionBody() })).status, 204);
  mode = 'onPrompt';
  assert.equal((await send(port, { body: permissionBody() })).status, 204);
  assert.equal(cancels.length, 1);
  assert.equal(hooks.pendingFor(BUDDY), null);
});

test('a second server on the same port reports in-use', async (t) => {
  const { port } = await startServer(t);
  const second = createHookServer({
    token: TOKEN,
    port,
    canHold: () => true,
    findBuddy: () => BUDDY,
    onPrompt: () => {},
    onCancel: () => {},
  });
  t.after(() => second.stop());
  assert.equal(await second.start(), 'in-use');
  assert.equal(second.address(), null);
});

test('the server listens on 127.0.0.1 only', async (t) => {
  const { hooks } = await startServer(t);
  assert.equal(hooks.address().address, '127.0.0.1');
});

test('stop answers pending prompts with 204, calls onCancel and closes', async (t) => {
  const { hooks, port, events, cancels } = await startServer(t);
  const promptSeen = once(events, 'prompt');
  const pending = send(port, { body: permissionBody() });
  const [prompt] = await promptSeen;
  await hooks.stop();
  assert.equal((await pending).status, 204);
  assert.deepEqual(cancels, [prompt.id]);
  assert.equal(hooks.address(), null);
  await assert.rejects(send(port, { body: permissionBody() }), { code: 'ECONNREFUSED' });
  await hooks.stop();
});
