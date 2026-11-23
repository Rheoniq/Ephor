'use strict';

// Generates the plain Ephor icon with no dependencies:
//   src/assets/icon.png  (256x256, used for the tray at runtime)
//   build/icon.ico       (256x256 PNG-in-ICO, used by electron-builder for the exe)
// Run: node build/make-icon.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const BG = [47, 111, 235]; // blue rounded square
const FG = [255, 255, 255]; // white dot
const RADIUS = 56; // corner radius of the square
const DOT = 64; // radius of the centre dot

// Coverage of pixel (x, y) by a shape, using 4x4 supersampling for soft edges.
function coverage(x, y, inside) {
  let hits = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) hits++;
    }
  }
  return hits / 16;
}

function inRoundedSquare(px, py) {
  const cx = Math.min(Math.max(px, RADIUS), SIZE - RADIUS);
  const cy = Math.min(Math.max(py, RADIUS), SIZE - RADIUS);
  return (px - cx) ** 2 + (py - cy) ** 2 <= RADIUS ** 2;
}

function inDot(px, py) {
  return (px - SIZE / 2) ** 2 + (py - SIZE / 2) ** 2 <= DOT ** 2;
}

function pixels() {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 4); // filter byte 0 + RGBA
    for (let x = 0; x < SIZE; x++) {
      const a = coverage(x, y, inRoundedSquare);
      const d = coverage(x, y, inDot);
      const o = 1 + x * 4;
      for (let c = 0; c < 3; c++) row[o + c] = Math.round(BG[c] * (1 - d) + FG[c] * d);
      row[o + 3] = Math.round(a * 255);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(pixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with a single 256x256 PNG entry (supported since Windows Vista).
function ico(pngData) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngData.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // data offset
  return Buffer.concat([header, entry, pngData]);
}

const root = path.join(__dirname, '..');
const pngData = png();
fs.mkdirSync(path.join(root, 'src', 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'assets', 'icon.png'), pngData);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngData));
console.log('icon written: src/assets/icon.png, build/icon.ico');
