'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHealth, RELOAD_DELAY_MS, MAX_RELOADS, RELOAD_WINDOW_MS } = require('../src/main/health');

test('defaults: reload after 1 s, at most 3 reloads a minute', () => {
  assert.equal(RELOAD_DELAY_MS, 1000);
  assert.equal(MAX_RELOADS, 3);
  assert.equal(RELOAD_WINDOW_MS, 60000);
});

test('a page is not alive until it has loaded', () => {
  const h = createRendererHealth();
  assert.equal(h.isAlive(), false);
  h.loaded();
  assert.equal(h.isAlive(), true);
});

test('a hung renderer is not alive until it responds again', () => {
  const h = createRendererHealth();
  h.loaded();
  h.hung();
  assert.equal(h.isAlive(), false);
  h.responsive();
  assert.equal(h.isAlive(), true);
});

test('a gone renderer is alive again only after a reload finished', () => {
  const h = createRendererHealth();
  h.loaded();
  assert.equal(h.gone(0), RELOAD_DELAY_MS);
  assert.equal(h.isAlive(), false);
  h.responsive(); // a late event from the dead process
  assert.equal(h.isAlive(), false);
  h.loaded();
  assert.equal(h.isAlive(), true);
});

test('loaded clears a hang as well', () => {
  const h = createRendererHealth();
  h.loaded();
  h.hung();
  h.gone(0);
  h.loaded();
  assert.equal(h.isAlive(), true);
});

test('a crash loop stops reloading; crashes spread out keep reloading', () => {
  const h = createRendererHealth({ reloadDelayMs: 10, maxReloads: 2, windowMs: 1000 });
  h.loaded();
  assert.equal(h.gone(0), 10);
  h.loaded();
  assert.equal(h.gone(100), 10);
  h.loaded();
  assert.equal(h.gone(200), null, 'third crash within the window');
  assert.equal(h.isAlive(), false);
  // Later, once the old crashes are out of the window, it reloads again.
  assert.equal(h.gone(1300), 10);
});

test('bad options fall back to the defaults', () => {
  const h = createRendererHealth({ reloadDelayMs: -1, maxReloads: 'x', windowMs: NaN });
  h.loaded();
  assert.equal(h.gone(0), RELOAD_DELAY_MS);
});
