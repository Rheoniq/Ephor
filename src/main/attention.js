'use strict';

// What needs the user while the panel is minimized: counts from the snapshot
// sessions, the tray tooltip text and the tray icon's badge. Pure: main.js
// draws the badge with nativeImage and sets the tooltip.

// Waiting: status waiting or a pending prompt. Finished: idle, finished and
// no prompt (the same rule as the card kind 'finished' in the renderer), so
// a session is never counted in both.
function attentionCounts(sessions) {
  let waiting = 0;
  let finished = 0;
  const seen = new Set();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s === null || typeof s !== 'object') continue;
    if (typeof s.sessionId === 'string' && s.sessionId !== '') {
      if (seen.has(s.sessionId)) continue;
      seen.add(s.sessionId);
    }
    if (s.status === 'waiting' || !!s.prompt) waiting += 1;
    else if (s.status === 'idle' && s.finished === true) finished += 1;
  }
  return { waiting, finished };
}

// The badge on the tray icon: 'waiting' wins over 'finished'; null for none.
function badgeKind(counts) {
  if (counts && counts.waiting > 0) return 'waiting';
  if (counts && counts.finished > 0) return 'finished';
  return null;
}

// "Ephor", then "1 waiting, 2 finished" (zero parts left out), then the
// answering note when there is one, each on its own line.
function trayTooltip(counts, answeringNote) {
  const parts = [];
  if (counts && counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts && counts.finished > 0) parts.push(`${counts.finished} finished`);
  const lines = ['Ephor'];
  if (parts.length) lines.push(parts.join(', '));
  if (answeringNote) lines.push(answeringNote);
  return lines.join('\n');
}

// A key that changes exactly when the tooltip or the badge would: main
// updates the tray only when it differs from the last one.
function attentionKey(counts, answeringNote) {
  return `${trayTooltip(counts, answeringNote)}|${badgeKind(counts)}`;
}

// Badge colors as [r, g, b]: the clay of the pill "!" and a green.
const BADGE_COLORS = { waiting: [217, 119, 87], finished: [63, 163, 77] };

// Draws a filled dot with a thin dark ring into the bottom-right corner of a
// BGRA bitmap (the layout of nativeImage.toBitmap on Windows), in place.
// Edges are blended by coverage, so the dot is smooth at 16x16.
function drawBadge(bitmap, width, height, kind) {
  const color = BADGE_COLORS[kind];
  if (!color || !Buffer.isBuffer(bitmap) || bitmap.length < width * height * 4) return bitmap;
  const radius = Math.max(2.5, Math.min(width, height) * 0.3);
  const cx = width - radius - 0.5;
  const cy = height - radius - 0.5;
  const ring = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const outer = Math.min(1, Math.max(0, radius + ring + 0.5 - d));
      if (outer <= 0) continue;
      const inner = Math.min(1, Math.max(0, radius + 0.5 - d));
      const i = (y * width + x) * 4;
      // The ring first (dark, so the dot reads on light and dark taskbars),
      // then the color over it.
      blend(bitmap, i, [20, 20, 19], outer);
      blend(bitmap, i, color, inner);
    }
  }
  return bitmap;
}

function blend(bitmap, i, rgb, cover) {
  if (cover <= 0) return;
  const a0 = bitmap[i + 3] / 255;
  const a = cover + a0 * (1 - cover);
  for (let c = 0; c < 3; c++) {
    const dst = bitmap[i + 2 - c]; // BGRA: index 2 is red
    const out = (rgb[c] * cover + dst * a0 * (1 - cover)) / (a || 1);
    bitmap[i + 2 - c] = Math.round(out);
  }
  bitmap[i + 3] = Math.round(a * 255);
}

module.exports = { attentionCounts, badgeKind, trayTooltip, attentionKey, drawBadge, BADGE_COLORS };
