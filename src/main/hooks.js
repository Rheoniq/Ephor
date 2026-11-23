'use strict';

// Localhost HTTP server for Claude Code http hooks. A hook POSTs its JSON to
// /hook. The server either answers 204 at once (no decision, so Desktop shows
// its own prompt) or holds the response until the panel answers, the session
// is cancelled, the client goes away or `holdMs` runs out. Every path that
// cannot decide ends in 204, so a fault here never blocks a session.
//
// Hook bodies carry untrusted tool input: it is parsed and passed on, never
// logged.

const http = require('node:http');
const crypto = require('node:crypto');
const { parseHook } = require('./prompts');

const HOST = '127.0.0.1';
const HOOK_PATH = '/hook';
// Only a fallback: main always passes holdMs (the holdSeconds setting).
const DEFAULT_HOLD_MS = 60000;
const DEFAULT_MAX_BODY = 64 * 1024;
// Node's limits for receiving a request (they end only the receiving, not a
// held response) and for open connections. A connection past the limit is
// closed at once, which the hook treats as no decision.
const REQUEST_TIMEOUT_MS = 30000;
const HEADERS_TIMEOUT_MS = 10000;
const MAX_CONNECTIONS = 32;
// How long stop() waits for open connections before cutting them.
const STOP_GRACE_MS = 1000;
// Bounds for reading and dropping the rest of an oversized body (see
// readBody). The byte bound is never below maxBody.
const DRAIN_MAX = 4 * 1024 * 1024;
const DRAIN_MS = 2000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const JSON_TYPE = 'application/json; charset=utf-8';

function noop() {}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Constant-time compare. The lengths are checked first because
// timingSafeEqual throws on buffers of different length; the token length is
// not a secret. An empty expected token matches nothing.
function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Writes a complete response, or nothing when one was already sent or the
// client is gone. Every response closes its connection, so no idle socket
// outlives a request and stop() ends promptly.
function send(res, status, body = '', headers = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  try {
    const all = { Connection: 'close', ...headers };
    if (status !== 204) all['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(status, all);
    if (status === 204) res.end();
    else res.end(body);
    return true;
  } catch {
    try {
      res.destroy();
    } catch {
      // Already gone.
    }
    return false;
  }
}

// 204 with an empty body: no decision, Desktop's own prompt appears.
function fallThrough(res) {
  return send(res, 204);
}

// Runs a step of request handling; any fault answers 204 instead of
// escaping the handler.
function guard(res, step) {
  try {
    step();
  } catch {
    fallThrough(res);
  }
}

function createHookServer(options) {
  const { token, port, canHold, findBuddy, onPrompt, onCancel } = options;
  const expected = typeof token === 'string' ? token : '';
  // setTimeout treats a delay above MAX_TIMER_MS as 1 ms.
  const holdMs = Math.min(positive(options.holdMs, DEFAULT_HOLD_MS), MAX_TIMER_MS);
  const maxBody = positive(options.maxBody, DEFAULT_MAX_BODY);
  const drainMax = Math.max(DRAIN_MAX, maxBody);
  // Node refuses a headers timeout above the request timeout.
  const requestTimeout = Math.min(positive(options.requestTimeout, REQUEST_TIMEOUT_MS), MAX_TIMER_MS);
  const headersTimeout = Math.min(positive(options.headersTimeout, HEADERS_TIMEOUT_MS), requestTimeout);
  const maxConnections = Math.floor(positive(options.maxConnections, MAX_CONNECTIONS));
  // How often Node checks those timeouts; only tests shorten it.
  const checkEvery = positive(options.connectionsCheckingInterval, 0);

  const pending = new Map(); // id -> { id, sessionId, res, timer }
  const bySession = new Map(); // buddy sessionId -> id
  let starting = null;
  let stopping = null;
  let stopped = false;

  function notifyCancel(id) {
    try {
      onCancel(id);
    } catch {
      // The server outlives a faulty callback.
    }
  }

  // Removes a held prompt and returns it, or null when it is not held.
  function take(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    if (bySession.get(entry.sessionId) === id) bySession.delete(entry.sessionId);
    clearTimeout(entry.timer);
    return entry;
  }

  // Ends a held prompt with 204 and tells the owner it is gone.
  function cancel(id) {
    const entry = take(id);
    if (!entry) return false;
    fallThrough(entry.res);
    notifyCancel(id);
    return true;
  }

  function hold(res, parsed) {
    if (stopped || !canHold()) return fallThrough(res);
    // The prompt belongs to the buddy findBuddy names, which can differ from
    // the hook's own session_id when it matched by transcript path.
    const sessionId = findBuddy(parsed);
    if (typeof sessionId !== 'string' || sessionId === '' || bySession.has(sessionId)) {
      return fallThrough(res);
    }
    // The client may have left while the body was read.
    if (res.destroyed || !res.socket || res.socket.destroyed) return false;

    const id = crypto.randomUUID();
    const entry = { id, sessionId, res, timer: null };
    pending.set(id, entry);
    bySession.set(sessionId, id);
    entry.timer = setTimeout(() => cancel(id), holdMs);
    // 'close' also fires after a normal response; by then the entry is gone.
    res.on('close', () => {
      if (take(id)) notifyCancel(id);
    });
    try {
      onPrompt({ id, sessionId, parsed });
    } catch {
      cancel(id);
    }
    return true;
  }

  function answer(res, raw) {
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return send(res, 400);
    }
    const parsed = parseHook(body);
    if (!parsed) return fallThrough(res);
    return hold(res, parsed);
  }

  // A body over maxBody is never buffered: Huddle cannot show such a prompt,
  // so it gets no decision (204). Its rest is read and dropped first, up to
  // drainMax bytes or DRAIN_MS, because a socket closed with unread input is
  // reset and the client then loses the response (seen on Windows). Past
  // either bound, or for a declared length above drainMax, the connection is
  // cut at once: a 204 is sent when it still can be and the socket is
  // destroyed, so the client sees the 204 or a reset. Both are non-blocking.
  function readBody(req, res) {
    const chunks = [];
    let size = 0;
    let over = false;
    let done = false;
    let drainTimer = null;

    function cut() {
      if (done) return;
      done = true;
      clearTimeout(drainTimer);
      const destroy = () => req.socket && req.socket.destroy();
      if (fallThrough(res)) res.once('finish', destroy);
      else destroy();
    }

    function goOver() {
      over = true;
      chunks.length = 0;
      drainTimer = setTimeout(() => guard(res, cut), DRAIN_MS);
      res.once('close', () => clearTimeout(drainTimer));
    }

    const declared = Number(req.headers['content-length']);
    if (declared > drainMax) return cut();
    if (declared > maxBody) goOver();

    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (!over && size > maxBody) guard(res, goOver);
      if (over) {
        if (size > drainMax) guard(res, cut);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(drainTimer);
      // Fully drained: the response is still possible, with no decision.
      if (over) guard(res, () => fallThrough(res));
      else guard(res, () => answer(res, Buffer.concat(chunks, size)));
    });
    return true;
  }

  // Only Claude Code's own hook client may talk to the server: a browser
  // page sends an Origin header, and a DNS-rebinding page a foreign Host.
  function fromHookClient(req) {
    if (req.headers.origin !== undefined) return false;
    const addr = server.address();
    if (!addr || typeof addr !== 'object') return false;
    return req.headers.host === `${HOST}:${addr.port}`;
  }

  function handle(req, res) {
    // A client that aborts mid-body raises 'error'; it must not crash the app.
    req.on('error', noop);
    res.on('error', noop);
    // Checked before anything else and before the body is read.
    if (!fromHookClient(req)) return send(res, 403);
    const path = String(req.url || '').split('?')[0];
    if (path !== HOOK_PATH) return send(res, 404);
    if (req.method !== 'POST') return send(res, 405, '', { Allow: 'POST' });
    if (!tokenMatches(expected, req.headers['x-huddle-token'])) return send(res, 401);
    return readBody(req, res);
  }

  const serverOptions = { requestTimeout, headersTimeout };
  if (checkEvery > 0) serverOptions.connectionsCheckingInterval = checkEvery;
  const server = http.createServer(serverOptions, (req, res) => guard(res, () => handle(req, res)));
  server.maxConnections = maxConnections;
  // An 'error' after listening (an accept failure) must not crash the app.
  server.on('error', noop);

  function start() {
    if (stopped) return Promise.reject(new Error('hook server was stopped'));
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        reject(new RangeError(`invalid hook port: ${port}`));
        return;
      }
      const onError = (err) => {
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE') resolve('in-use');
        else reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve('listening');
      };
      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen({ port, host: HOST });
      } catch (err) {
        server.off('error', onError);
        server.off('listening', onListening);
        reject(err);
      }
    });
    // A failed or in-use start may be tried again.
    starting.then(
      (state) => {
        if (state !== 'listening') starting = null;
      },
      () => {
        starting = null;
      },
    );
    return starting;
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    for (const id of [...pending.keys()]) cancel(id);
    stopping = (async () => {
      if (starting) await starting.catch(noop);
      if (!server.listening) return;
      await new Promise((resolve) => {
        const cut = setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS);
        server.close(() => {
          clearTimeout(cut);
          resolve();
        });
        server.closeIdleConnections();
      });
    })();
    return stopping;
  }

  function resolve(id, response) {
    const entry = pending.get(id);
    // A gone client is cleaned up by its 'close' handler.
    if (!entry || entry.res.destroyed) return false;
    let body = null;
    if (response !== null && response !== undefined) {
      try {
        body = typeof response === 'object' ? JSON.stringify(response) : undefined;
      } catch {
        body = undefined;
      }
      // An answer that cannot be sent falls through instead.
      if (typeof body !== 'string') {
        cancel(id);
        return false;
      }
    }
    take(id);
    const sent = body === null
      ? fallThrough(entry.res)
      : send(entry.res, 200, body, { 'Content-Type': JSON_TYPE });
    if (!sent) notifyCancel(id);
    return sent;
  }

  function cancelSession(sessionId) {
    const id = bySession.get(sessionId);
    if (id !== undefined) cancel(id);
  }

  function address() {
    return server.listening ? server.address() : null;
  }

  return { start, stop, resolve, cancelSession, address };
}

module.exports = { createHookServer, DEFAULT_HOLD_MS, REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, MAX_CONNECTIONS };
