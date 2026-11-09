// Generates the torn-paper 9-slice masks for the "Colored paper" theme (css/paper/tear-{a,b,c}.png, tag.png).
// Run once: node scripts/gen-paper-tears.mjs  (no dependencies; PNGs are written with node:zlib).
// Each PNG is 96×96 grayscale+alpha: an opaque centre and a ragged transparent outer 24px. CSS uses them with
//   -webkit-mask-box-image: url(tear-a.png) 24 fill / 24px round;
// so the middle 48px of every edge is periodic (it tiles seamlessly with `round`) and the element's background
// colour is the paper colour. tag.png has a straight left edge (the rail's active tab attaches to the screen there).
// The CSS draws only the 24px rim with the mask (no `fill`) over a plain inset background, so the 9 pieces' antialiased
// seams never show on the sheet. *-rim.png = the same tear cut to its outer 14px, for the (translated) shadow.
// strip.png (96×18, torn top and bottom, periodic in x) is the room-heading underline, used with mask-repeat: repeat-x.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../css/paper/', import.meta.url));
const N = 96, B = 24;            // image size, 9-slice border
const BASE = 6.5;                // mean depth of the torn edge from the outside, px
const SS = 4;                    // supersampling per axis (antialiasing)

// Small seeded PRNG so the committed PNGs are reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Jagged polygon: knots every 6–14px, offsets within ±(1.5..3)px (3–6px peak to peak), plus a 1px fibre jitter.
// knotsOn(a, b, v0, v1) returns knots covering [a, b] that start at depth v0 and end at v1.
function knotsOn(r, a, b, v0, v1) {
  const k = [[a, v0]];
  let x = a;
  for (;;) {
    x += 6 + r() * 8;
    if (x > b - 4) break;
    const amp = 1.5 + r() * 1.5;
    k.push([x, BASE + (r() * 2 - 1) * amp]);
    // fibre: a short sharp notch between knots now and then
    if (r() < 0.45) { const fx = x + 1.5 + r() * 2; if (fx < b - 4) k.push([fx, BASE + (r() * 2 - 1) * 3]); x = Math.max(x, fx); }
  }
  k.push([b, v1]);
  return k;
}
function lerpKnots(k, x) {
  for (let i = 1; i < k.length; i++) if (x <= k[i][0]) { const [x0, y0] = k[i - 1], [x1, y1] = k[i]; return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1)); }
  return k[k.length - 1][1];
}
// One side's depth profile along t in [0, 96]: corner [0,24], periodic middle [24,72] (same depth at 24 and 72), corner [72,96].
function side(r, straight) {
  if (straight) return () => 0;
  const e = BASE + (r() * 2 - 1) * 2;          // depth where the middle tile starts/ends (seam)
  const c0 = BASE + (r() * 2 - 1) * 2, c1 = BASE + (r() * 2 - 1) * 2;
  const k = [...knotsOn(r, 0, B, c0, e), ...knotsOn(r, B, N - B, e, e).slice(1), ...knotsOn(r, N - B, N, e, c1).slice(1)];
  return (t) => lerpKnots(k, t);
}

function mask(seed, straightLeft, rim) {
  const r = rng(seed);
  const top = side(r), right = side(r), bottom = side(r), left = side(r, straightLeft);
  const px = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let inside = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      if (fy >= top(fx) && fy <= N - bottom(fx) && fx >= left(fy) && fx <= N - right(fy) && (!rim || fx < rim || fy < rim || fx > N - rim || fy > N - rim)) inside++;
    }
    px[y * N + x] = Math.round((inside / (SS * SS)) * 255);
  }
  return px;
}

// ---- minimal PNG writer (colour type 4 = grey + alpha, 8 bit)
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(alpha, W = N, H = N) {
  const raw = Buffer.alloc(H * (1 + W * 2));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 2)] = 0; // filter: none
    for (let x = 0; x < W; x++) { const o = y * (1 + W * 2) + 1 + x * 2; raw[o] = 255; raw[o + 1] = alpha[y * W + x]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 4; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Underline strip: W×H, top and bottom edges torn and periodic over W (tiles seamlessly as a pattern).
function strip(seed, W = 96, H = 18) {
  const r = rng(seed), per = (amp) => { const k = knotsOn(r, 0, W, 2.5, 2.5).map(([x, y]) => [x, 2.5 + (y - BASE) * amp]); return (t) => lerpKnots(k, ((t % W) + W) % W); };
  const top = per(0.6), bot = per(0.6), px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let inside = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) { const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS; if (fy >= top(fx) && fy <= H - bot(fx)) inside++; }
    px[y * W + x] = Math.round((inside / (SS * SS)) * 255);
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
{ const buf = png(strip(5), 96, 18); writeFileSync(OUT + 'strip.png', buf); console.log('strip.png', buf.length, 'bytes'); }
for (const [name, seed, straight, rim] of [['tear-a', 11, false], ['tear-b', 2024, false], ['tear-c', 777, false], ['tag', 31, true],
  ['tear-a-rim', 11, false, 14], ['tear-b-rim', 2024, false, 14], ['tear-c-rim', 777, false, 14], ['tag-rim', 31, true, 14]]) {
  const buf = png(mask(seed, straight, rim));
  writeFileSync(OUT + name + '.png', buf);
  console.log(name + '.png', buf.length, 'bytes');
}
