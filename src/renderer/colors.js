'use strict';

// Avatar color assignment: no two visible sessions share a palette index
// while the palette lasts. A session keeps its index for as long as it stays
// visible; an index is freed when its session leaves. Pure and deterministic.
// Plain script: in the page it sets window.EphorColors, under Node it is a
// CommonJS module.

(function (root) {
  // ids: the visible session ids, in display order.
  // previous: Map of id -> index from the last call (not changed).
  // paletteSize: number of colors.
  // Returns a new Map with an index for every id.
  function assignColors(sessionIds, previous, paletteSize) {
    const size = Number.isInteger(paletteSize) && paletteSize > 0 ? paletteSize : 1;
    const prev = previous instanceof Map ? previous : new Map();
    const ids = [];
    const seen = new Set();
    for (const raw of Array.isArray(sessionIds) ? sessionIds : []) {
      const id = typeof raw === 'string' ? raw : String(raw);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    const result = new Map();
    const uses = new Array(size).fill(0);

    // Keep the index of every id still present.
    for (const id of ids) {
      const idx = prev.get(id);
      if (Number.isInteger(idx) && idx >= 0 && idx < size) {
        result.set(id, idx);
        uses[idx] += 1;
      }
    }

    // New ids, in order: the least used index, lowest first on a tie. While
    // the palette lasts that is the lowest unused index.
    const out = new Map();
    for (const id of ids) {
      if (result.has(id)) {
        out.set(id, result.get(id));
        continue;
      }
      let best = 0;
      for (let i = 1; i < size; i++) if (uses[i] < uses[best]) best = i;
      uses[best] += 1;
      out.set(id, best);
    }
    return out;
  }

  const api = { assignColors };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EphorColors = api;
})(typeof window !== 'undefined' ? window : globalThis);
