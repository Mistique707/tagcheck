/**
 * Draw the app icons.
 *
 * Written by hand rather than pulled from an image library so the icons can be
 * regenerated from source with no toolchain: shapes are rasterised into an RGBA
 * buffer at 4x and boxed down for anti-aliasing, then encoded as PNG with the
 * zlib that ships with Node.
 *
 *   npm run icons
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
const SS = 4; // supersampling factor

const INK = [0x12, 0x15, 0x1c];
const PLATE = [0xff, 0xd2, 0x3f];
const CHECK = [0x38, 0xd0, 0x7f];

/* Raster ------------------------------------------------------------------ */

function createCanvas(size) {
  const width = size * SS;
  const data = new Uint8ClampedArray(width * width * 4);
  return { width, data };
}

function setPixel(canvas, x, y, [r, g, b]) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.width) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = r;
  canvas.data[i + 1] = g;
  canvas.data[i + 2] = b;
  canvas.data[i + 3] = 255;
}

function fillRoundRect(canvas, x, y, w, h, radius, color) {
  const r = Math.min(radius, w / 2, h / 2);
  for (let py = Math.floor(y); py < y + h; py += 1) {
    for (let px = Math.floor(x); px < x + w; px += 1) {
      const dx = Math.max(x + r - px, px - (x + w - r - 1), 0);
      const dy = Math.max(y + r - py, py - (y + h - r - 1), 0);
      if (dx * dx + dy * dy <= r * r) setPixel(canvas, px, py, color);
    }
  }
}

function fillCircle(canvas, cx, cy, radius, color) {
  for (let py = Math.floor(cy - radius); py <= cy + radius; py += 1) {
    for (let px = Math.floor(cx - radius); px <= cx + radius; px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) setPixel(canvas, px, py, color);
    }
  }
}

/** Round-capped segment, drawn by stamping discs along the line. */
function strokeLine(canvas, x1, y1, x2, y2, width, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    fillCircle(canvas, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color);
  }
}

/** Average each SS x SS block down to one pixel, which is where the AA comes from. */
function downsample(canvas, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * canvas.width + (x * SS + sx)) * 4;
          r += canvas.data[i];
          g += canvas.data[i + 1];
          b += canvas.data[i + 2];
          a += canvas.data[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* PNG encoding ------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each scanline is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* The mark ---------------------------------------------------------------- */

/**
 * A number plate with a tick on it. `inset` pulls the artwork into the safe
 * zone for maskable icons, where the launcher may crop the outer edge away.
 */
function drawIcon(size, { maskable = false } = {}) {
  const canvas = createCanvas(size);
  const w = canvas.width;

  if (maskable) {
    fillRoundRect(canvas, 0, 0, w, w, 0, INK);
  } else {
    fillRoundRect(canvas, 0, 0, w, w, w * 0.22, INK);
  }

  const safe = maskable ? 0.78 : 0.98;
  const scale = (v) => (v * safe + (1 - safe) / 2) * w;

  // The plate.
  const plateX = scale(0.11);
  const plateY = scale(0.3);
  const plateW = scale(0.89) - plateX;
  const plateH = scale(0.62) - plateY;
  fillRoundRect(canvas, plateX, plateY, plateW, plateH, w * 0.035, PLATE);

  // Three bars standing in for the characters.
  const barY = plateY + plateH * 0.3;
  const barH = plateH * 0.4;
  const barW = plateW * 0.13;
  const gap = plateW * 0.09;
  const startX = plateX + plateW * 0.12;
  for (let i = 0; i < 3; i += 1) {
    fillRoundRect(canvas, startX + i * (barW + gap), barY, barW, barH, barW * 0.35, INK);
  }

  // The tick, sitting over the lower right corner of the plate.
  const cx = scale(0.72);
  const cy = scale(0.68);
  const radius = w * 0.155 * safe;
  fillCircle(canvas, cx, cy, radius + w * 0.022, INK);
  fillCircle(canvas, cx, cy, radius, CHECK);

  const stroke = radius * 0.26;
  strokeLine(canvas, cx - radius * 0.46, cy + radius * 0.02,
    cx - radius * 0.1, cy + radius * 0.4, stroke, INK);
  strokeLine(canvas, cx - radius * 0.1, cy + radius * 0.4,
    cx + radius * 0.48, cy - radius * 0.42, stroke, INK);

  return encodePng(downsample(canvas, size), size);
}

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-180.png', 180, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
];

for (const [name, size, options] of outputs) {
  const png = drawIcon(size, options);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote icons/${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)} kB)`);
}
