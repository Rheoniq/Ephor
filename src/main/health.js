'use strict';

// Whether the panel's renderer can show a prompt card. Prompts are held only
// while it can: a page that has not loaded, is hung or has crashed answers
// nothing, so its holds end at once and Desktop shows its own prompts.
// A crashed page is reloaded after a short delay; a crash loop stops the
// reloading (holding stays off, Desktop keeps asking).

const RELOAD_DELAY_MS = 1000;
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 60000;

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRendererHealth(options = {}) {
  const reloadDelayMs = positive(options.reloadDelayMs, RELOAD_DELAY_MS);
  const maxReloads = positive(options.maxReloads, MAX_RELOADS);
  const windowMs = positive(options.windowMs, RELOAD_WINDOW_MS);
  let loaded = false; // the page finished loading and its process lives
  let hung = false;
  let crashes = []; // times of recent crashes, oldest first

  return {
    // did-finish-load: a fresh page in a live process.
    loaded() {
      loaded = true;
      hung = false;
    },
    // 'unresponsive' and 'responsive' of the page's process.
    hung() {
      hung = true;
    },
    responsive() {
      hung = false;
    },
    // render-process-gone at monotonic time `now` (ms). Returns the delay
    // before the page is reloaded, or null when it crashed more than
    // maxReloads times within windowMs and is left alone.
    gone(now) {
      loaded = false;
      crashes = crashes.filter((t) => now - t < windowMs);
      crashes.push(now);
      return crashes.length > maxReloads ? null : reloadDelayMs;
    },
    isAlive: () => loaded && !hung,
  };
}

module.exports = { createRendererHealth, RELOAD_DELAY_MS, MAX_RELOADS, RELOAD_WINDOW_MS };
