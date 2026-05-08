// Generates 32x32 PNG tray icons (transparent background, filled circle).
// Pure Node, no deps — uses zlib for IDAT compression and a hand-rolled CRC32.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'resources');
mkdirSync(OUT_DIR, { recursive: true });

const W = 32;
const H = 32;
const RADIUS = 13;
const CX = 15.5;
const CY = 15.5;

function buildRgba(r, g, b) {
  // RGBA pixels, fully transparent except for an antialiased filled circle.
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - CX;
      const dy = y + 0.5 - CY;
      const d = Math.sqrt(dx * dx + dy * dy);
      // 1px feathered edge for antialias
      const fill = d <= RADIUS - 0.5 ? 1 : d >= RADIUS + 0.5 ? 0 : RADIUS + 0.5 - d;
      const idx = (y * W + x) * 4;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = Math.round(fill * 255);
    }
  }
  return buf;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // color type RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter
  ihdr.writeUInt8(0, 12);  // interlace
  // Filter byte 0 (None) per scanline
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    rgba.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const variants = {
  'tray-idle.png':       [92, 200, 168],
  'tray-listening.png':  [240, 195, 100],
  'tray-processing.png': [92, 144, 200],
  'tray-error.png':      [229, 115, 115],
  'icon.png':            [92, 200, 168]
};

for (const [name, [r, g, b]] of Object.entries(variants)) {
  const png = encodePng(buildRgba(r, g, b));
  const out = resolve(OUT_DIR, name);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
