// Generates the PWA icons.
//
// Written rather than drawn because there is no image tooling in this environment, and an
// installed application with a broken icon looks broken. The mark is deliberately simple —
// a crate on a brand-coloured tile — which is both what a warehouse app should look like and
// what can be rasterised honestly from rectangles.
//
//   node scripts/makeIcons.mjs
//
// Re-run it if the brand colour changes. Output goes to public/.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

const BRAND = [14, 116, 144];      // deep teal — reads as "utility", not "consumer app"
const CRATE = [248, 250, 252];
const CRATE_SHADE = [203, 213, 225];

// ── a minimal PNG encoder (RGBA, no interlacing) ────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  // 10..12 = compression, filter, interlace — all 0

  // One filter byte (0 = None) per scanline, then the row's pixels.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ─────────────────────────────────────────────────────────────────
function canvas(size) {
  const buf = Buffer.alloc(size * size * 4);   // transparent
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const rect = (x0, y0, w, h, colour) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y += 1) {
      for (let x = Math.round(x0); x < Math.round(x0 + w); x += 1) put(x, y, colour);
    }
  };
  // Rounded corners by testing the corner circles — enough for a tile, and avoids pulling in
  // a rasteriser for one shape.
  const roundedRect = (x0, y0, w, h, r, colour) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = x < r ? r - x : x >= w - r ? x - (w - r - 1) : 0;
        const dy = y < r ? r - y : y >= h - r ? y - (h - r - 1) : 0;
        if (dx * dx + dy * dy <= r * r) put(Math.round(x0 + x), Math.round(y0 + y), colour);
      }
    }
  };
  return { buf, rect, roundedRect };
}

/**
 * @param maskable  A maskable icon must keep its mark inside the safe zone (the middle 80%),
 *                  because the platform may crop it to a circle. The tile therefore bleeds to
 *                  the edges and the crate is drawn smaller.
 */
function drawIcon(size, { maskable = false } = {}) {
  const c = canvas(size);
  const pad = maskable ? 0 : Math.round(size * 0.06);
  const tile = size - pad * 2;
  c.roundedRect(pad, pad, tile, tile, maskable ? 0 : Math.round(tile * 0.22), BRAND);

  // The crate: a body, a lid, and a centre seam. Scaled to the safe zone when maskable.
  const scale = maskable ? 0.52 : 0.62;
  const w = Math.round(size * scale);
  const h = Math.round(w * 0.78);
  const x = Math.round((size - w) / 2);
  const y = Math.round((size - h) / 2 + size * 0.02);
  const t = Math.max(2, Math.round(size * 0.045));      // stroke weight

  c.rect(x, y, w, t, CRATE);                            // lid
  c.rect(x, y + h - t, w, t, CRATE);                    // base
  c.rect(x, y, t, h, CRATE);                            // left wall
  c.rect(x + w - t, y, t, h, CRATE);                    // right wall
  c.rect(x, y + Math.round(h * 0.34), w, t, CRATE_SHADE); // strap
  c.rect(x + Math.round(w / 2 - t / 2), y + Math.round(h * 0.34), t, h - Math.round(h * 0.34), CRATE_SHADE);

  return encodePng(size, size, c.buf);
}

const files = [
  ['icon-192.png', drawIcon(192)],
  ['icon-512.png', drawIcon(512)],
  ['icon-maskable-512.png', drawIcon(512, { maskable: true })],
  ['apple-touch-icon.png', drawIcon(180)],
  ['favicon-64.png', drawIcon(64)],
];

for (const [name, data] of files) {
  writeFileSync(join(OUT, name), data);
  console.log(`  ${name.padEnd(24)} ${(data.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${files.length} icons written to public/`);
