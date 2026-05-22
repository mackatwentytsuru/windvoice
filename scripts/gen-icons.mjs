// Generates the WindVoice tray icons: a status-colored rounded square
// with a white microphone glyph. Pure Node, no deps — geometry is drawn
// with signed-distance tests, 4x4 supersampled for clean anti-aliasing,
// and encoded with a hand-rolled PNG writer (zlib for IDAT, hand-rolled
// CRC32).
//
// Run manually after changing the design:  node scripts/gen-icons.mjs
// The four tray-*.png outputs are committed to resources/.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'resources');
mkdirSync(OUT_DIR, { recursive: true });

const W = 32;
const H = 32;
const SS = 4; // 4x4 supersampling

// ── geometry helpers ───────────────────────────────────────────────────
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Inside the rounded-square background? */
function bgInside(px, py) {
  const hw = 15;
  const r = 7;
  const qx = Math.abs(px - 16) - hw + r;
  const qy = Math.abs(py - 16) - hw + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const sd = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
  return sd < 0;
}

/** Inside the white microphone glyph? */
function micInside(px, py) {
  // mic body — a vertical capsule
  if (segDist(px, py, 16, 10.5, 16, 13.5) < 4.6) return true;
  // cradle — the lower arc of a ring, arms reaching just past mid-body
  if (py >= 11.5 && Math.abs(Math.hypot(px - 16, py - 13.2) - 7.6) < 1.6) return true;
  // neck — from the cradle down to the base
  if (segDist(px, py, 16, 19.5, 16, 24.5) < 1.5) return true;
  // base — a short horizontal capsule
  if (segDist(px, py, 11.5, 26.5, 20.5, 26.5) < 1.7) return true;
  return false;
}

function buildRgba(r, g, b) {
  const buf = Buffer.alloc(W * H * 4);
  const n = SS * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let aSum = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!bgInside(px, py)) continue; // transparent outside the square
          aSum++;
          if (micInside(px, py)) {
            rSum += 255;
            gSum += 255;
            bSum += 255;
          } else {
            rSum += r;
            gSum += g;
            bSum += b;
          }
        }
      }
      const idx = (y * W + x) * 4;
      buf[idx + 3] = Math.round((aSum / n) * 255);
      if (aSum > 0) {
        buf[idx] = Math.round(rSum / aSum);
        buf[idx + 1] = Math.round(gSum / aSum);
        buf[idx + 2] = Math.round(bSum / aSum);
      }
    }
  }
  return buf;
}

// ── PNG encoder ────────────────────────────────────────────────────────
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
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
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter byte 0 (None)
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

// ── outputs ────────────────────────────────────────────────────────────
// One icon per dictation status; the background color carries the state,
// the white microphone glyph keeps the app recognizable. `icon.png` (the
// app icon) is intentionally NOT generated here — it is a separately
// designed asset and must not be clobbered.
const variants = {
  'tray-idle.png': [92, 200, 168],
  'tray-listening.png': [240, 195, 100],
  'tray-processing.png': [92, 144, 200],
  'tray-error.png': [229, 115, 115]
};

for (const [name, [r, g, b]] of Object.entries(variants)) {
  const png = encodePng(buildRgba(r, g, b));
  const out = resolve(OUT_DIR, name);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
