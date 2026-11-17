// Generates media/icon.png (128x128): rounded gradient square, white magnifier, yellow lightning bolt.
// Usage: node scripts/make-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 128;
const H = 128;
const px = Buffer.alloc(W * H * 4);
const blend = (i, r, g, b, a) => {
  const ia = 1 - a;
  px[i] = px[i] * ia + r * a;
  px[i + 1] = px[i + 1] * ia + g * a;
  px[i + 2] = px[i + 2] * ia + b * a;
  px[i + 3] = Math.min(255, px[i + 3] + 255 * a);
};
const cover = (x, y, f) => {
  let s = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) if (f(x + (a + 0.5) / 4, y + (b + 0.5) / 4)) s++;
  return s / 16;
};
const inRound = (x, y) => {
  const r = 26;
  const cx = Math.min(Math.max(x, r + 4), W - r - 4);
  const cy = Math.min(Math.max(y, r + 4), H - r - 4);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x > 4 && x < W - 4 && y > 4 && y < H - 4;
};
const ring = (x, y) => {
  const d = Math.hypot(x - 54, y - 54);
  return d <= 30 && d >= 20;
};
const handle = (x, y) => {
  const t = (x - 74 + (y - 74)) / 2;
  if (t < 0 || t > 30) return false;
  return Math.hypot(x - (74 + t), y - (74 + t)) <= 8;
};
const bolt = (x, y) => {
  const P = [[58, 36], [44, 58], [54, 58], [48, 74], [64, 50], [54, 50], [60, 36]];
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i];
    const [xj, yj] = P[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const t = (x + y) / (W + H);
    let a = cover(x, y, inRound);
    if (a) blend(i, 255 * (1 - t) + 120 * t, 60 * (1 - t) + 40 * t, 150 * (1 - t) + 230 * t, a);
    a = cover(x, y, ring);
    if (a) blend(i, 255, 255, 255, a);
    a = cover(x, y, handle);
    if (a) blend(i, 255, 255, 255, a);
    a = cover(x, y, bolt);
    if (a) blend(i, 255, 214, 64, a);
  }
}
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (t, d) => {
  const l = Buffer.alloc(4);
  l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
fs.writeFileSync(
  path.join(__dirname, '..', 'media', 'icon.png'),
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
);
console.log('media/icon.png written');
