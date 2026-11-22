'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { colorIndex, variantIndex, PALETTE, createAvatar } = require('../src/renderer/avatar');

const SVG_NS = 'http://www.w3.org/2000/svg';

// The card colors from style.css: plain and waiting (clay tint), light and dark.
const CARDS = {
  light: '#faf9f5',
  lightWaiting: '#f7ede7',
  dark: '#2a2926',
  darkWaiting: '#3c312b',
};
const EYE = '#141413';

// Minimal stand-in for document: only what createAvatar may use. Setting
// innerHTML throws, so any use of it fails the test.
function fakeDocument() {
  function makeNode(ns, tag) {
    const classes = new Set();
    const node = {
      namespaceURI: ns,
      tagName: tag,
      attributes: {},
      children: [],
      text: '',
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        contains: (n) => classes.has(n),
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value);
      },
      append(...kids) {
        node.children.push(...kids);
      },
      set textContent(v) {
        node.text = String(v);
      },
      get textContent() {
        return node.text;
      },
      set innerHTML(_) {
        throw new Error('innerHTML must not be used');
      },
    };
    return node;
  }
  return {
    createElementNS: (ns, tag) => makeNode(ns, tag),
    createElement() {
      throw new Error('use createElementNS for SVG');
    },
  };
}

function walk(node, out = []) {
  out.push(node);
  for (const c of node.children) if (typeof c === 'object') walk(c, out);
  return out;
}

function hasClass(node, name) {
  if (node.classList.contains(name)) return true;
  return (node.attributes.class || '').split(/\s+/).includes(name);
}

function byClass(svg, name) {
  return walk(svg).filter((n) => hasClass(n, name));
}

// CIE76 color difference in L*a*b* (D65): two avatars side by side at
// 36 px need a clearly visible difference, so near-duplicates are rejected.
function lab(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function deltaE(a, b) {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The rects of the drawing as "x,y,w,h" strings, in grid cells.
function shape(svg) {
  return walk(svg)
    .filter((n) => n.tagName === 'rect')
    .map((n) => ['x', 'y', 'width', 'height'].map((k) => n.attributes[k]).join(','))
    .sort();
}

// A session id whose variantIndex is v.
function idWithVariant(v) {
  for (let n = 0; n < 1000; n++) if (variantIndex(`s-${n}`) === v) return `s-${n}`;
  throw new Error(`no id found for variant ${v}`);
}

test('PALETTE has twelve distinct hex colors readable on every card color', () => {
  assert.equal(PALETTE.length, 12);
  for (const c of PALETTE) {
    assert.match(c, /^#[0-9a-f]{6}$/i);
    for (const [name, card] of Object.entries(CARDS)) {
      assert.ok(contrast(c, card) >= 3, `${c} on ${name} card: ${contrast(c, card).toFixed(2)}`);
    }
    // The square eyes stay visible on every body color.
    assert.ok(contrast(EYE, c) >= 3, `eyes on ${c}`);
  }
  assert.equal(new Set(PALETTE.map((c) => c.toLowerCase())).size, 12);
});

test('PALETTE keeps the six original colors first', () => {
  assert.deepEqual(PALETTE.slice(0, 6), ['#c96442', '#788c5d', '#5789bf', '#a46d9f', '#ad7e0a', '#289588']);
});

test('PALETTE colors differ from each other by a CIE76 delta E of at least 18', () => {
  for (let i = 0; i < PALETTE.length; i++) {
    for (let j = i + 1; j < PALETTE.length; j++) {
      const d = deltaE(PALETTE[i], PALETTE[j]);
      assert.ok(d >= 18, `${PALETTE[i]} vs ${PALETTE[j]}: ${d.toFixed(1)}`);
    }
  }
});

test('colorIndex is deterministic and within 0..11', () => {
  for (const id of ['', 'a', 'demo-busy', 'local_123', crypto.randomUUID()]) {
    const i = colorIndex(id);
    assert.equal(i, colorIndex(id));
    assert.ok(Number.isInteger(i) && i >= 0 && i < PALETTE.length, `${id} -> ${i}`);
  }
});

test('colorIndex tolerates non-string input', () => {
  for (const v of [undefined, null, 42, {}]) {
    const i = colorIndex(v);
    assert.ok(Number.isInteger(i) && i >= 0 && i < PALETTE.length);
  }
});

test('colorIndex spreads 50 random uuids over at least 4 buckets', () => {
  const buckets = new Set();
  for (let n = 0; n < 50; n++) buckets.add(colorIndex(crypto.randomUUID()));
  assert.ok(buckets.size >= 4, `only ${buckets.size} buckets`);
});

test('variantIndex is deterministic and within 0..2', () => {
  for (const id of ['', 'a', 'demo-busy', 'local_123', crypto.randomUUID()]) {
    const v = variantIndex(id);
    assert.equal(v, variantIndex(id));
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 2, `${id} -> ${v}`);
  }
});

test('variantIndex tolerates non-string input', () => {
  for (const x of [undefined, null, 42, {}]) {
    const v = variantIndex(x);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 2);
  }
});

test('variantIndex uses all three variants over 50 random uuids', () => {
  const buckets = new Set();
  for (let n = 0; n < 50; n++) buckets.add(variantIndex(crypto.randomUUID()));
  assert.equal(buckets.size, 3);
});

test('variantIndex is mixed apart from colorIndex', () => {
  // Same color does not mean same variant: 600 ids cover most of the 36 pairs.
  const pairs = new Set();
  for (let n = 0; n < 600; n++) {
    const id = crypto.randomUUID();
    pairs.add(`${colorIndex(id)}:${variantIndex(id)}`);
  }
  assert.ok(pairs.size >= 30, `only ${pairs.size} of 36 color and variant pairs`);
});

for (const status of ['busy', 'waiting', 'idle']) {
  test(`createAvatar builds a crisp pixel svg with class av-${status}`, () => {
    const doc = fakeDocument();
    const svg = createAvatar(doc, 'session-1', status);
    assert.equal(svg.namespaceURI, SVG_NS);
    assert.equal(svg.tagName, 'svg');
    assert.ok(svg.classList.contains('avatar'));
    assert.ok(svg.classList.contains(`av-${status}`));
    for (const other of ['busy', 'waiting', 'idle']) {
      if (other !== status) assert.ok(!svg.classList.contains(`av-${other}`));
    }
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.attributes.focusable, 'false');
    assert.equal(svg.attributes['shape-rendering'], 'crispEdges');
    assert.equal(svg.attributes.width, '36');
    assert.equal(svg.attributes.height, '36');
    for (const n of walk(svg)) assert.equal(n.namespaceURI, SVG_NS);
    // Pixels only: no text, no curves.
    for (const n of walk(svg)) assert.ok(['svg', 'g', 'rect'].includes(n.tagName), `unexpected <${n.tagName}>`);
  });
}

test('createAvatar fills the body with the session palette color', () => {
  const svg = createAvatar(fakeDocument(), 'session-1', 'idle');
  const color = PALETTE[colorIndex('session-1')];
  const body = byClass(svg, 'av-body');
  assert.ok(body.length >= 1);
  for (const n of body) assert.equal(n.attributes.fill, color);
});

test('createAvatar uses an in-range color index instead of the hash', () => {
  const own = colorIndex('session-1');
  for (const idx of [0, 7, 11, (own + 5) % 12]) {
    const svg = createAvatar(fakeDocument(), 'session-1', 'busy', idx);
    for (const n of byClass(svg, 'av-body')) assert.equal(n.attributes.fill, PALETTE[idx]);
  }
});

test('createAvatar ignores an out-of-range or non-integer color index', () => {
  const color = PALETTE[colorIndex('session-1')];
  for (const idx of [-1, 12, 99, 1.5, '3', null, NaN]) {
    const svg = createAvatar(fakeDocument(), 'session-1', 'idle', idx);
    for (const n of byClass(svg, 'av-body')) assert.equal(n.attributes.fill, color, `index ${String(idx)}`);
  }
});

test('createAvatar keeps the hash variant when a color index is given', () => {
  const id = idWithVariant(2);
  const svg = createAvatar(fakeDocument(), id, 'idle', 0);
  assert.ok(svg.classList.contains('av-v2'));
});

test('createAvatar marks the variant and draws it differently', () => {
  const shapes = new Set();
  for (const v of [0, 1, 2]) {
    const id = idWithVariant(v);
    const svg = createAvatar(fakeDocument(), id, 'idle');
    assert.ok(svg.classList.contains(`av-v${v}`));
    for (const other of [0, 1, 2]) if (other !== v) assert.ok(!svg.classList.contains(`av-v${other}`));
    shapes.add(shape(svg).join(' '));
  }
  assert.equal(shapes.size, 3);
});

function eyes(status) {
  return byClass(createAvatar(fakeDocument(), 's', status), 'av-eye').map((n) => ({
    w: Number(n.attributes.width),
    h: Number(n.attributes.height),
    x: Number(n.attributes.x),
  }));
}

test('createAvatar draws two square-pixel eyes that follow the status', () => {
  const idle = eyes('idle');
  const busy = eyes('busy');
  const waiting = eyes('waiting');
  for (const e of [idle, busy, waiting]) assert.equal(e.length, 2);
  // Idle: flat bars. Waiting: taller than busy.
  for (const e of idle) assert.ok(e.w > e.h, 'idle eyes are flat bars');
  for (let i = 0; i < 2; i++) assert.ok(waiting[i].h > busy[i].h, 'waiting eyes are taller');
  // Busy looks aside: both eyes shifted the same way from the waiting gaze.
  const shift = busy.map((e, i) => e.x - waiting[i].x);
  assert.ok(shift[0] !== 0 && shift[0] === shift[1], 'busy eyes look aside');
});

test('createAvatar shows a pixel "!" only when waiting and a pulse pixel only when busy', () => {
  const parts = (status) => {
    const svg = createAvatar(fakeDocument(), 's', status);
    return { alert: byClass(svg, 'av-alert').length, pulse: byClass(svg, 'av-pulse').length };
  };
  assert.ok(parts('waiting').alert > 0);
  assert.equal(parts('waiting').pulse, 0);
  assert.ok(parts('busy').pulse > 0);
  assert.equal(parts('busy').alert, 0);
  assert.deepEqual(parts('idle'), { alert: 0, pulse: 0 });
});

test('createAvatar falls back to idle for an unknown status', () => {
  const svg = createAvatar(fakeDocument(), 's', 'bogus');
  assert.ok(svg.classList.contains('av-idle'));
});

test('createAvatar is stable for one session id', () => {
  const a = shape(createAvatar(fakeDocument(), 'same-id', 'busy'));
  const b = shape(createAvatar(fakeDocument(), 'same-id', 'busy'));
  assert.deepEqual(a, b);
});
