'use strict';

// Per-session avatar: a small blob character in a color picked from the
// session id, with a face that shows the status. Built with createElementNS
// only, never innerHTML. Plain script: in the page it sets window.HuddleAvatar,
// under Node it is a CommonJS module.

(function (root) {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Mid-tone fills, each at least 3:1 against white and against #1e1e24, so
  // the blob reads on a light card and on a dark card.
  const PALETTE = ['#3b82f6', '#8b5cf6', '#d9548f', '#e0604f', '#119c93', '#4a9a3c'];

  const STATUSES = ['busy', 'waiting', 'idle'];

  // FNV-1a over the UTF-16 code units: stable across runs and machines.
  function colorIndex(sessionId) {
    const s = typeof sessionId === 'string' ? sessionId : String(sessionId);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % PALETTE.length;
  }

  // Soft gumdrop body with two little feet, in a 36 x 36 box.
  const BODY =
    'M18 6C25.5 6 30 11.5 30 19V26C30 28.8 28.4 31 26.2 31' +
    'C24.6 31 23.6 30 22.4 30C21 30 20 31 18 31C16 31 15 30 13.6 30' +
    'C12.4 30 11.4 31 9.8 31C7.6 31 6 28.8 6 26V19C6 11.5 10.5 6 18 6Z';

  function createAvatar(doc, sessionId, status) {
    const st = STATUSES.includes(status) ? status : 'idle';

    function node(tag, attrs) {
      const n = doc.createElementNS(SVG_NS, tag);
      for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
      return n;
    }

    const svg = node('svg', {
      viewBox: '0 0 36 36',
      width: '36',
      height: '36',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    svg.classList.add('avatar', `av-${st}`);

    const figure = node('g', { class: 'av-figure' });
    figure.append(
      node('path', { class: 'av-body', d: BODY, fill: PALETTE[colorIndex(sessionId)] }),
      node('ellipse', { class: 'av-shine', cx: '12.5', cy: '11.5', rx: '3', ry: '1.8', fill: '#ffffff', 'fill-opacity': '0.35' }),
    );

    if (st === 'idle') {
      // Closed eyes: two downward arcs, and a small calm smile.
      for (const x of [11.5, 20.5]) {
        figure.append(node('path', { class: 'av-lid', d: `M${x} 18.5q2 2 4 0`, fill: 'none' }));
      }
      figure.append(node('path', { class: 'av-mouth', d: 'M16.5 24q1.5 1 3 0', fill: 'none' }));
    } else {
      const wide = st === 'waiting';
      const r = wide ? 3.6 : 3;
      const look = st === 'busy' ? 1.2 : 0; // busy glances aside
      for (const cx of [13.5, 22.5]) {
        figure.append(
          node('circle', { class: 'av-eye', cx: String(cx), cy: '18', r: String(r), fill: '#ffffff' }),
          node('circle', { class: 'av-pupil', cx: String(cx + look), cy: '18.3', r: wide ? '1.9' : '1.6' }),
        );
      }
      figure.append(
        wide
          ? node('ellipse', { class: 'av-mouth av-mouth-o', cx: '18', cy: '25', rx: '1.4', ry: '1.6' })
          : node('path', { class: 'av-mouth', d: 'M15.5 24q2.5 2 5 0', fill: 'none' }),
      );
    }
    svg.append(figure);

    if (st === 'busy') {
      // A small dot that circles the blob; CSS spins the group.
      const orbit = node('g', { class: 'av-orbit' });
      orbit.append(node('circle', { class: 'av-dot', cx: '18', cy: '3', r: '2.2' }));
      svg.append(orbit);
    } else if (st === 'waiting') {
      const bubble = node('g', { class: 'av-bubble' });
      const mark = node('text', { class: 'av-mark', x: '29', y: '10', 'text-anchor': 'middle' });
      mark.textContent = '!';
      bubble.append(node('circle', { class: 'av-bubble-bg', cx: '29', cy: '7', r: '6' }), mark);
      svg.append(bubble);
    }
    return svg;
  }

  const api = { colorIndex, PALETTE, createAvatar };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleAvatar = api;
})(typeof window !== 'undefined' ? window : globalThis);
