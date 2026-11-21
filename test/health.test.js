'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRendererHealth, RELOAD_DELAY_MS } = require('../src/main/health');

test('defaults: a fourth crash within a minute stops the reloading', () => {
  const h = createRendererHealth();
  for (const at of [0, 1000, 2000]) {
    h.loaded();
    assert.equal(h.gone(at), RELOAD_DELAY_MS, `crash at ${at}`);
  }
  h.loaded();
  assert.equal(h.gone(59999), null, 'fourth crash within the window');
  // Once the first crash is a full window old it no longer counts.
  assert.equal(h.gone(60000 + 1000), RELOAD_DELAY_MS);
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
