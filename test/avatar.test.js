'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { colorIndex, PALETTE, createAvatar } = require('../src/renderer/avatar');

const SVG_NS = 'http://www.w3.org/2000/svg';

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

test('PALETTE has six hex colors readable on light and dark cards', () => {
  assert.equal(PALETTE.length, 6);
  for (const c of PALETTE) {
    assert.match(c, /^#[0-9a-f]{6}$/i);
    assert.ok(contrast(c, '#ffffff') >= 3, `${c} on white`);
    assert.ok(contrast(c, '#1e1e24') >= 3, `${c} on #1e1e24`);
  }
  assert.equal(new Set(PALETTE.map((c) => c.toLowerCase())).size, 6);
});

test('colorIndex is deterministic and within 0..5', () => {
  for (const id of ['', 'a', 'demo-busy', 'local_123', crypto.randomUUID()]) {
    const i = colorIndex(id);
    assert.equal(i, colorIndex(id));
    assert.ok(Number.isInteger(i) && i >= 0 && i <= 5, `${id} -> ${i}`);
  }
});

test('colorIndex tolerates non-string input', () => {
  for (const v of [undefined, null, 42, {}]) {
    const i = colorIndex(v);
    assert.ok(Number.isInteger(i) && i >= 0 && i <= 5);
  }
});

test('colorIndex spreads 50 random uuids over at least 4 buckets', () => {
  const buckets = new Set();
  for (let n = 0; n < 50; n++) buckets.add(colorIndex(crypto.randomUUID()));
  assert.ok(buckets.size >= 4, `only ${buckets.size} buckets`);
});

for (const status of ['busy', 'waiting', 'idle']) {
  test(`createAvatar builds an svg with class av-${status}`, () => {
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
    for (const n of walk(svg)) assert.equal(n.namespaceURI, SVG_NS);
  });
}

test('createAvatar fills the body with the session palette color', () => {
  const doc = fakeDocument();
  const svg = createAvatar(doc, 'session-1', 'idle');
  const fills = walk(svg).map((n) => n.attributes.fill);
  assert.ok(fills.includes(PALETTE[colorIndex('session-1')]));
});

test('createAvatar shows a "!" bubble only when waiting', () => {
  const texts = (status) =>
    walk(createAvatar(fakeDocument(), 's', status))
      .filter((n) => n.tagName === 'text')
      .map((n) => n.textContent);
  assert.deepEqual(texts('waiting'), ['!']);
  assert.deepEqual(texts('busy'), []);
  assert.deepEqual(texts('idle'), []);
});

test('createAvatar falls back to idle for an unknown status', () => {
  const svg = createAvatar(fakeDocument(), 's', 'bogus');
  assert.ok(svg.classList.contains('av-idle'));
});
