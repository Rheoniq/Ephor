'use strict';

// Dragging the collapsed pill. The pill is a button that expands on click,
// so an app-region drag area would swallow that click; instead the renderer
// tracks the pointer in screen coordinates (createDragTracker) and sends the
// total offset, and main moves the window (createWindowDrag).
// Plain script: in the page it sets window.HuddleDrag, under Node it is a
// CommonJS module.

(function (root) {
  const DEFAULT_THRESHOLD = 4; // px; less movement than this is a click
  const MAX_DELTA = 20000; // px; a larger offset from the renderer is ignored
  const MIN_VISIBLE = 24; // px of the window that stay on a work area

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  // start(x, y) on pointer down, move(x, y) on pointer move, end() on pointer
  // up or cancel. Coordinates are screen coordinates (event.screenX/Y), so
  // they do not shift when the window itself moves.
  function createDragTracker(opts) {
    const t = opts && opts.threshold;
    const threshold = finite(t) && t > 0 ? t : DEFAULT_THRESHOLD;
    let origin = null;
    let dragging = false;

    function start(x, y) {
      origin = finite(x) && finite(y) ? { x, y } : null;
      dragging = false;
    }

    function move(x, y) {
      if (!origin || !finite(x) || !finite(y)) return { dragging, dx: 0, dy: 0 };
      const dx = x - origin.x;
      const dy = y - origin.y;
      if (!dragging && Math.hypot(dx, dy) >= threshold) dragging = true;
      return { dragging, dx, dy };
    }

    function end() {
      const wasDrag = dragging;
      origin = null;
      dragging = false;
      return { wasDrag };
    }

    return { start, move, end };
  }

  // The drag offset from IPC, or null unless it is { dx, dy } with finite
  // numbers within +-MAX_DELTA.
  function parseDragDelta(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const { dx, dy } = payload;
    if (!finite(dx) || !finite(dy)) return null;
    if (Math.abs(dx) > MAX_DELTA || Math.abs(dy) > MAX_DELTA) return null;
    return { dx, dy };
  }

  // The window position nearest to bounds that keeps at least `visible` px of
  // the window inside workArea on each axis.
  function clampToWorkArea(bounds, workArea, visible = MIN_VISIBLE) {
    const minX = workArea.x - bounds.width + visible;
    const maxX = workArea.x + workArea.width - visible;
    const minY = workArea.y - bounds.height + visible;
    const maxY = workArea.y + workArea.height - visible;
    return {
      x: Math.min(maxX, Math.max(minX, bounds.x)),
      y: Math.min(maxY, Math.max(minY, bounds.y)),
    };
  }

  // Main side: the window origin is taken at start() (or on the first to()
  // of a drag), and each to({ dx, dy }) puts the window at origin plus the
  // offset with its current size, clamped to the work area that
  // workAreaFor(rect) returns for the target rectangle.
  function createWindowDrag({ getBounds, setBounds, workAreaFor }) {
    let origin = null;

    function start() {
      const b = getBounds();
      origin = { x: b.x, y: b.y };
    }

    function to(payload) {
      const delta = parseDragDelta(payload);
      if (!delta) return;
      if (!origin) start();
      const b = getBounds();
      const target = {
        x: Math.round(origin.x + delta.dx),
        y: Math.round(origin.y + delta.dy),
        width: b.width,
        height: b.height,
      };
      const { x, y } = clampToWorkArea(target, workAreaFor(target));
      if (x === b.x && y === b.y) return;
      setBounds({ x, y, width: b.width, height: b.height });
    }

    function end() {
      origin = null;
    }

    return { start, to, end, isDragging: () => origin !== null };
  }

  const api = {
    createDragTracker,
    parseDragDelta,
    clampToWorkArea,
    createWindowDrag,
    DEFAULT_THRESHOLD,
    MAX_DELTA,
    MIN_VISIBLE,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleDrag = api;
})(typeof window !== 'undefined' ? window : globalThis);
