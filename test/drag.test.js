'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDragTracker,
  parseDragDelta,
  clampToWorkArea,
  createWindowDrag,
  fitInside,
  DEFAULT_THRESHOLD,
  MIN_VISIBLE,
} = require('../src/renderer/drag');

test('fitInside leaves a rect already inside the work area unchanged', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(fitInside({ x: 100, y: 50, width: 360, height: 400 }, wa), { x: 100, y: 50 });
});

test('fitInside pulls a panel off the left and top edges inside', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(fitInside({ x: -200, y: -30, width: 360, height: 400 }, wa), { x: 0, y: 0 });
});

test('fitInside pulls a panel off the right and bottom edges inside', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(fitInside({ x: 1700, y: 900, width: 360, height: 400 }, wa), { x: 1560, y: 640 });
});

test('fitInside works on a monitor at negative coordinates', () => {
  const wa = { x: -2560, y: -200, width: 2560, height: 1400 };
  assert.deepEqual(fitInside({ x: -2700, y: -300, width: 360, height: 400 }, wa), { x: -2560, y: -200 });
  assert.deepEqual(fitInside({ x: -100, y: 1000, width: 360, height: 400 }, wa), { x: -360, y: 800 });
});

test('fitInside pins a panel larger than the work area to its top-left', () => {
  const wa = { x: 100, y: 50, width: 300, height: 200 };
  assert.deepEqual(fitInside({ x: 400, y: 300, width: 360, height: 400 }, wa), { x: 100, y: 50 });
  assert.deepEqual(fitInside({ x: -50, y: -50, width: 360, height: 400 }, wa), { x: 100, y: 50 });
});

test('the default threshold is 4 px and 24 px must stay visible', () => {
  assert.equal(DEFAULT_THRESHOLD, 4);
  assert.equal(MIN_VISIBLE, 24);
});

test('movement below the threshold is a click', () => {
  const t = createDragTracker({ threshold: 4 });
  t.start(100, 100);
  assert.deepEqual(t.move(102, 101), { dragging: false, dx: 2, dy: 1 });
  assert.deepEqual(t.end(), { wasDrag: false });
});

test('passing the threshold starts dragging and it stays on until end', () => {
  const t = createDragTracker({ threshold: 4 });
  t.start(100, 100);
  assert.equal(t.move(105, 100).dragging, true);
  // Back at the start point is still a drag.
  assert.deepEqual(t.move(100, 100), { dragging: true, dx: 0, dy: 0 });
  assert.deepEqual(t.end(), { wasDrag: true });
});

test('dx and dy are totals from the start point, in screen coordinates', () => {
  const t = createDragTracker({ threshold: 4 });
  t.start(-1500, 200);
  t.move(-1490, 210);
  assert.deepEqual(t.move(-1400, 150), { dragging: true, dx: 100, dy: -50 });
});

test('end resets and a second drag starts clean', () => {
  const t = createDragTracker({ threshold: 4 });
  t.start(0, 0);
  t.move(50, 50);
  assert.deepEqual(t.end(), { wasDrag: true });
  assert.deepEqual(t.end(), { wasDrag: false });
  t.start(10, 10);
  assert.deepEqual(t.move(11, 11), { dragging: false, dx: 1, dy: 1 });
  assert.deepEqual(t.end(), { wasDrag: false });
});

test('move without start, or with odd values, is no drag', () => {
  const t = createDragTracker({ threshold: 4 });
  assert.deepEqual(t.move(50, 50), { dragging: false, dx: 0, dy: 0 });
  t.start(0, 0);
  assert.deepEqual(t.move(NaN, 50), { dragging: false, dx: 0, dy: 0 });
  assert.deepEqual(t.end(), { wasDrag: false });
});

test('zero, negative or missing threshold uses the default', () => {
  for (const opts of [{ threshold: 0 }, { threshold: -3 }, { threshold: NaN }, {}, undefined]) {
    const t = createDragTracker(opts);
    t.start(0, 0);
    assert.equal(t.move(3, 0).dragging, false);
    assert.equal(t.move(4, 0).dragging, true);
  }
});

test('parseDragDelta accepts finite numbers within +-20000 only', () => {
  assert.deepEqual(parseDragDelta({ dx: 10, dy: -20 }), { dx: 10, dy: -20 });
  assert.deepEqual(parseDragDelta({ dx: 20000, dy: -20000 }), { dx: 20000, dy: -20000 });
  for (const bad of [
    null,
    undefined,
    42,
    'x',
    [],
    [1, 2],
    {},
    { dx: 1 },
    { dx: '1', dy: 2 },
    { dx: NaN, dy: 0 },
    { dx: 0, dy: Infinity },
    { dx: 20001, dy: 0 },
    { dx: 0, dy: -20001 },
  ]) {
    assert.equal(parseDragDelta(bad), null, JSON.stringify(bad));
  }
});

const WA = { x: 0, y: 0, width: 1920, height: 1040 };

test('clamp leaves a window inside the work area alone', () => {
  assert.deepEqual(clampToWorkArea({ x: 100, y: 100, width: 96, height: 40 }, WA), { x: 100, y: 100 });
});

test('clamp keeps at least 24 px of the window inside the work area', () => {
  // Off the left and top edges.
  assert.deepEqual(clampToWorkArea({ x: -500, y: -500, width: 96, height: 40 }, WA), { x: -72, y: -16 });
  // Off the right and bottom edges.
  assert.deepEqual(clampToWorkArea({ x: 5000, y: 5000, width: 96, height: 40 }, WA), { x: 1896, y: 1016 });
});

test('clamp handles a monitor at negative coordinates', () => {
  const left = { x: -2560, y: -200, width: 2560, height: 1400 };
  assert.deepEqual(clampToWorkArea({ x: -1000, y: 0, width: 96, height: 40 }, left), { x: -1000, y: 0 });
  assert.deepEqual(clampToWorkArea({ x: -9000, y: -9000, width: 96, height: 40 }, left), { x: -2632, y: -216 });
  assert.deepEqual(clampToWorkArea({ x: 9000, y: 9000, width: 96, height: 40 }, left), { x: -24, y: 1176 });
});

function fakeWindow(start) {
  let bounds = { ...start };
  const sets = [];
  return {
    getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => {
      sets.push({ x, y });
      bounds = { ...bounds, x, y };
    },
    resize: (b) => {
      bounds = { ...bounds, ...b };
    },
    sets,
  };
}

test('window drag moves the window to origin plus the offset, keeping its size', () => {
  const w = fakeWindow({ x: 1800, y: 12, width: 96, height: 40 });
  const d = createWindowDrag({ getBounds: w.getBounds, setPosition: w.setPosition, workAreaFor: () => WA });
  d.start();
  d.to({ dx: -100, dy: 50 });
  d.to({ dx: -300, dy: 80 });
  assert.deepEqual(w.getBounds(), { x: 1500, y: 92, width: 96, height: 40 });
  d.end();
});

test('window drag without start takes the origin on the first move', () => {
  const w = fakeWindow({ x: 500, y: 500, width: 96, height: 40 });
  const d = createWindowDrag({ getBounds: w.getBounds, setPosition: w.setPosition, workAreaFor: () => WA });
  d.to({ dx: 10, dy: 10 });
  d.to({ dx: 20, dy: 20 });
  assert.deepEqual(w.getBounds(), { x: 520, y: 520, width: 96, height: 40 });
});

test('a new drag starts from where the last one left the window', () => {
  const w = fakeWindow({ x: 500, y: 500, width: 96, height: 40 });
  const d = createWindowDrag({ getBounds: w.getBounds, setPosition: w.setPosition, workAreaFor: () => WA });
  d.start();
  d.to({ dx: 100, dy: 0 });
  d.end();
  d.start();
  d.to({ dx: 0, dy: 100 });
  assert.deepEqual(w.getBounds(), { x: 600, y: 600, width: 96, height: 40 });
});

test('window drag keeps a size changed mid-drag and clamps to the matching work area', () => {
  const w = fakeWindow({ x: 100, y: 100, width: 96, height: 40 });
  const asked = [];
  const d = createWindowDrag({
    getBounds: w.getBounds,
    setPosition: w.setPosition,
    workAreaFor: (rect) => {
      asked.push(rect);
      return WA;
    },
  });
  d.start();
  w.resize({ height: 60 }); // a content-size update during the drag
  d.to({ dx: -1000, dy: 0 });
  assert.deepEqual(w.getBounds(), { x: -72, y: 100, width: 96, height: 60 });
  assert.deepEqual(asked[0], { x: -900, y: 100, width: 96, height: 60 });
});

test('window drag ignores an invalid offset', () => {
  const w = fakeWindow({ x: 100, y: 100, width: 96, height: 40 });
  const d = createWindowDrag({ getBounds: w.getBounds, setPosition: w.setPosition, workAreaFor: () => WA });
  d.start();
  d.to({ dx: NaN, dy: 0 });
  d.to(null);
  assert.equal(w.sets.length, 0);
});

const { createPanelAnchor, placeNear } = require('../src/renderer/drag');

const SHORT_WA = { x: 0, y: 0, width: 1440, height: 762 };

test('anchor: a transient tall height then the settled one ends at the minimum shift', () => {
  const a = createPanelAnchor();
  a.set(738, 1); // the pill's top at expand time, parked at the bottom
  const tall = a.place({ x: 1080, y: 738, width: 360, height: 795 }, SHORT_WA, 1);
  assert.deepEqual(tall, { x: 1080, y: 0, width: 360, height: 795 });
  // The settled height is a shrink, but it still places from the anchor.
  const settled = a.place({ x: 1080, y: 0, width: 360, height: 463 }, SHORT_WA, 1);
  assert.deepEqual(settled, { x: 1080, y: 299, width: 360, height: 463 });
});

test('anchor: a panel that fits stays at the anchor', () => {
  const a = createPanelAnchor();
  a.set(100, 1);
  assert.deepEqual(a.place({ x: 500, y: 100, width: 360, height: 463 }, SHORT_WA, 1), {
    x: 500,
    y: 100,
    width: 360,
    height: 463,
  });
});

test('anchor: with no anchor yet, the current top becomes the anchor', () => {
  const a = createPanelAnchor();
  assert.equal(a.place({ x: 0, y: 700, width: 360, height: 795 }, SHORT_WA, 1).y, 0);
  assert.equal(a.place({ x: 0, y: 0, width: 360, height: 463 }, SHORT_WA, 1).y, 299);
});

test('anchor: a user move (header drag) re-anchors at the new top', () => {
  const a = createPanelAnchor();
  a.set(738, 1);
  a.place({ x: 1080, y: 738, width: 360, height: 463 }, SHORT_WA, 1); // placed at 299
  a.moved(299, 1); // our own placement: no change
  assert.equal(a.place({ x: 1080, y: 299, width: 360, height: 300 }, SHORT_WA, 1).y, 462);
  a.moved(50, 1); // the user dragged the header
  assert.equal(a.place({ x: 1080, y: 50, width: 360, height: 463 }, SHORT_WA, 1).y, 50);
});

test('anchor: a move with no anchor, or clear, leaves no anchor', () => {
  const a = createPanelAnchor();
  a.moved(400, 1);
  assert.equal(a.anchorY(), null);
  a.set(10, 1);
  a.clear();
  assert.equal(a.anchorY(), null);
});

test('anchor: a different display re-anchors at the current top', () => {
  const a = createPanelAnchor();
  a.set(738, 1);
  const other = { x: -1098, y: -86, width: 1098, height: 570 };
  assert.equal(a.place({ x: -400, y: 10, width: 360, height: 463 }, other, 2).y, 10);
  assert.equal(a.anchorY(), 10);
});

test('placeNear puts the toast below the panel, right edges aligned', () => {
  const panel = { x: 1068, y: 12, width: 360, height: 463 };
  assert.deepEqual(placeNear(panel, { width: 340, height: 64 }, SHORT_WA, 8), {
    x: 1088,
    y: 483,
    width: 340,
    height: 64,
  });
});

test('placeNear puts the toast above a panel flush with the work-area bottom', () => {
  const panel = { x: 1080, y: 299, width: 360, height: 463 };
  assert.deepEqual(placeNear(panel, { width: 340, height: 64 }, SHORT_WA, 8), {
    x: 1100,
    y: 227,
    width: 340,
    height: 64,
  });
});

test('placeNear keeps the toast inside the work area when neither side fits', () => {
  const panel = { x: -50, y: 0, width: 96, height: 762 };
  const t = placeNear(panel, { width: 340, height: 64 }, SHORT_WA, 8);
  assert.deepEqual(t, { x: 0, y: 0, width: 340, height: 64 });
});
