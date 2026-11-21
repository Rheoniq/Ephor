'use strict';

// Per-session avatar: a small pixel-block creature in a color picked from the
// session id, with one of three small variants picked by a second hash, and a
// face that shows the status. Drawn on a 12 x 12 grid of 3 px cells with
// crisp edges. Built with createElementNS only, never innerHTML. Plain script:
// in the page it sets window.HuddleAvatar, under Node it is a CommonJS module.

(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Clay, olive green, sky blue, plum, golden, teal. Mid-tones, each at least
  // 3:1 against the light and dark cards (plain and waiting tint), so the
  // creature reads in both themes; the ink eyes stay at least 3:1 on each.
  const PALETTE = ['#c96442', '#788c5d', '#5789bf', '#a46d9f', '#ad7e0a', '#289588'];

  const EYE = '#141413';

  const STATUSES = ['busy', 'waiting', 'idle'];

  function text(v) {
    return typeof v === 'string' ? v : String(v);
  }

  // FNV-1a over the UTF-16 code units: stable across runs and machines.
  function colorIndex(sessionId) {
    const s = text(sessionId);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % PALETTE.length;
  }

  // A second, independent hash (another seed and multiplier, then the
  // murmur3 finalizer), so two sessions of one color still tend to differ.
  function variantIndex(sessionId) {
    const s = text(sessionId);
    let h = 0x9e3779b9;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995) >>> 0;
      h ^= h >>> 15;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) % 3; // ^ gives a signed 32-bit value
  }

  // The creature in grid cells [x, y, width, height]: a wide block body, two
  // arm nubs at the sides and four short legs in two pairs.
  const BODY = [
    [2, 4, 8, 5],
    [1, 6, 1, 1],
    [10, 6, 1, 1],
    [2, 9, 1, 1],
    [4, 9, 1, 1],
    [7, 9, 1, 1],
    [9, 9, 1, 1],
  ];

  // Small extras on top of the head, in the body color.
  const VARIANTS = [
    [[5, 2, 1, 2]], // 0: a pixel antenna
    [[2, 3, 1, 1], [9, 3, 1, 1]], // 1: two ear nubs
    [[6, 3, 1, 1], [7, 2, 1, 1]], // 2: a sprout leaning aside
  ];

  // Eyes per status: busy glances aside, waiting looks up with tall eyes,
  // idle rests with flat bars.
  const EYES = {
    busy: [[5, 5, 1, 2], [8, 5, 1, 2]],
    waiting: [[4, 5, 1, 3], [7, 5, 1, 3]],
    idle: [[3, 6, 2, 1], [7, 6, 2, 1]],
  };

  // A pulsing pixel above the head while busy; a pixel "!" while waiting.
  const PULSE = [[10, 2, 1, 1]];
  const ALERT = [[11, 0, 1, 2], [11, 3, 1, 1]];

  function createAvatar(doc, sessionId, status) {
    const st = STATUSES.includes(status) ? status : 'idle';
    const variant = variantIndex(sessionId);
    const color = PALETTE[colorIndex(sessionId)];

    function node(tag, attrs) {
      const n = doc.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
      return n;
    }

    function rects(cells, cls, fill) {
      return cells.map(([x, y, w, h]) => {
        const attrs = { class: cls, x: String(x), y: String(y), width: String(w), height: String(h) };
        if (fill) attrs.fill = fill;
        return node('rect', attrs);
      });
    }

    const svg = node('svg', {
      viewBox: '0 0 12 12',
      width: '36',
      height: '36',
      'shape-rendering': 'crispEdges',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    svg.classList.add('avatar', `av-${st}`, `av-v${variant}`);

    const figure = node('g', { class: 'av-figure' });
    figure.append(
      ...rects(BODY, 'av-body', color),
      ...rects(VARIANTS[variant], 'av-body av-extra', color),
      ...rects(EYES[st], 'av-eye', EYE),
    );
    svg.append(figure);

    if (st === 'busy') {
      const pulse = node('g', { class: 'av-pulse' });
      pulse.append(...rects(PULSE, 'av-pulse-px'));
      svg.append(pulse);
    } else if (st === 'waiting') {
      const alert = node('g', { class: 'av-alert' });
      alert.append(...rects(ALERT, 'av-alert-px'));
      svg.append(alert);
    }
    return svg;
  }

  const api = { colorIndex, variantIndex, PALETTE, createAvatar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleAvatar = api;
})(typeof window !== 'undefined' ? window : globalThis);
