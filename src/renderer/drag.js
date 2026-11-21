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

  // The window position nearest to bounds that puts the whole window inside
  // workArea. A window larger than the work area is pinned to its top-left.
  function fitInside(bounds, workArea) {
    const fit = (pos, size, start, span) => Math.max(start, Math.min(pos, start + span - size));
    return {
      x: fit(bounds.x, bounds.width, workArea.x, workArea.width),
      y: fit(bounds.y, bounds.height, workArea.y, workArea.height),
    };
  }

  // Main side: the window origin is taken at start() (or on the first to()
  // of a drag), and each to({ dx, dy }) moves the window to origin plus the
  // offset, clamped to the work area that workAreaFor(rect) returns for the
  // target rectangle. Only the position is set, so size rounding across
  // displays with different scale factors cannot build up during a drag.
  function createWindowDrag({ getBounds, setPosition, workAreaFor }) {
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
      setPosition(x, y);
    }

    function end() {
      origin = null;
    }

    return { start, to, end, isDragging: () => origin !== null };
  }

  // Main side, for the expanded panel: the top it should have (the anchor) and
  // where it goes for each reported size. Every placement starts from the
  // anchor, growing or shrinking, so a transient tall height right after
  // expand cannot leave the panel pinned higher than the settled height needs.
  // set(y, displayId) on expand; clear() on collapse; moved(y, displayId)
  // after the window moved, which re-anchors unless it is our own placement;
  // place(rect, workArea, displayId) re-anchors at rect.y when there is no
  // anchor or the display changed.
  function createPanelAnchor() {
    let anchor = null; // { y, displayId }
    let placedY = null; // the y of our last placement

    function set(y, displayId) {
      anchor = { y, displayId };
      placedY = null;
    }

    function clear() {
      anchor = null;
      placedY = null;
    }

    function moved(y, displayId) {
      if (!anchor || y === placedY) return;
      set(y, displayId);
    }

    function place(rect, workArea, displayId) {
      if (!anchor || anchor.displayId !== displayId) set(rect.y, displayId);
      const { x, y } = fitInside({ ...rect, y: anchor.y }, workArea);
      placedY = y;
      return { x, y, width: rect.width, height: rect.height };
    }

    return { set, clear, moved, place, anchorY: () => (anchor ? anchor.y : null) };
  }

  // A small window (the toast) next to `near` (the panel): right edges
  // aligned, `gap` px below it, or above it when below does not fit the work
  // area; always kept inside the work area.
  function placeNear(near, size, workArea, gap) {
    let y = near.y + near.height + gap;
    if (y + size.height > workArea.y + workArea.height) y = near.y - gap - size.height;
    const rect = { x: near.x + near.width - size.width, y, width: size.width, height: size.height };
    return { ...rect, ...fitInside(rect, workArea) };
  }

  const api = {
    createDragTracker,
    parseDragDelta,
    clampToWorkArea,
    fitInside,
    createWindowDrag,
    createPanelAnchor,
    placeNear,
    DEFAULT_THRESHOLD,
    MAX_DELTA,
    MIN_VISIBLE,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleDrag = api;
})(typeof window !== 'undefined' ? window : globalThis);
