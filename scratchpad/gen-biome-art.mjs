/**
 * Generates the default biome art set: one 256x256 PNG per biome id in
 * assets/biomes/, named after the BIOME_KEYS slug in lowercase. Procedural
 * "classic hex map" motifs (trees, peaks, dunes, waves) over a noised base
 * color so the tiles read at 40-120 px per hex. Deterministic.
 *
 * Run: node scratchpad/gen-biome-art.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { B, BIOME_KEYS, BIOME_COLORS } from "../scripts/generator/biomes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "biomes");
mkdirSync(OUT, { recursive: true });

const S = 256;

/* ---------------- PNG encoding ---------------- */

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function writePng(path, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
  writeFileSync(path, png);
}

/* ---------------- Raster helpers ---------------- */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

class Tile {
  constructor() { this.px = new Uint8ClampedArray(S * S * 4); }
  set(x, y, [r, g, b], a = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const p = this.px;
    p[i] = p[i] * (1 - a) + r * a;
    p[i + 1] = p[i + 1] * (1 - a) + g * a;
    p[i + 2] = p[i + 2] * (1 - a) + b * a;
    p[i + 3] = 255;
  }
  fillNoise(base, amp, rng, scale = 32) {
    // Bilinear value noise, 2 octaves.
    const g1 = [], g2 = [], n1 = Math.ceil(S / scale) + 2, n2 = Math.ceil(S / (scale / 2)) + 2;
    for (let i = 0; i < n1 * n1; i++) g1.push(rng());
    for (let i = 0; i < n2 * n2; i++) g2.push(rng());
    const sample = (g, n, x, y, sc) => {
      const fx = x / sc, fy = y / sc;
      const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
      const sm = t => t * t * (3 - 2 * t);
      const sx = sm(tx), sy = sm(ty);
      const v00 = g[y0 * n + x0], v10 = g[y0 * n + x0 + 1];
      const v01 = g[(y0 + 1) * n + x0], v11 = g[(y0 + 1) * n + x0 + 1];
      return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
    };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = sample(g1, n1, x, y, scale) * 0.65 + sample(g2, n2, x, y, scale / 2) * 0.35;
      const m = 1 + (n - 0.5) * 2 * amp;
      this.set(x, y, [base[0] * m, base[1] * m, base[2] * m], 1);
    }
  }
  disc(cx, cy, r, color, a = 1) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) this.set(x, y, color, a * Math.min(1, r - d + 0.5));
    }
  }
  tri(x1, y1, x2, y2, x3, y3, color, a = 1) {
    const minX = Math.floor(Math.min(x1, x2, x3)), maxX = Math.ceil(Math.max(x1, x2, x3));
    const minY = Math.floor(Math.min(y1, y2, y3)), maxY = Math.ceil(Math.max(y1, y2, y3));
    const edge = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const area = edge(x1, y1, x2, y2, x3, y3);
    if (!area) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = edge(x2, y2, x3, y3, x, y) / area;
      const w1 = edge(x3, y3, x1, y1, x, y) / area;
      const w2 = edge(x1, y1, x2, y2, x, y) / area;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) this.set(x, y, color, a);
    }
  }
  line(x1, y1, x2, y2, w, color, a = 1) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.ceil(len * 2) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      this.disc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, w / 2, color, a);
    }
  }
}

const mul = (c, m) => [c[0] * m, c[1] * m, c[2] * m];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Scatter positions with minimum spacing, biased away from tile edges. */
function scatter(rng, count, minDist, margin = 26) {
  const pts = [];
  for (let tries = 0; tries < count * 40 && pts.length < count; tries++) {
    const x = margin + rng() * (S - 2 * margin);
    const y = margin + rng() * (S - 2 * margin);
    if (pts.every(p => Math.hypot(p[0] - x, p[1] - y) >= minDist)) pts.push([x, y]);
  }
  return pts.sort((p, q) => p[1] - q[1]); // paint back-to-front
}

/* ---------------- Motif painters ---------------- */

function conifer(t, x, y, h, dark, light) {
  t.line(x, y, x, y + h * 0.16, h * 0.14, mul(dark, 0.55), 0.9);
  for (let tier = 0; tier < 3; tier++) {
    const ty = y - h * (0.28 * tier);
    const w = h * (0.46 - 0.1 * tier);
    const th = h * 0.52;
    t.tri(x - w, ty, x + w, ty, x, ty - th, dark, 0.95);
    t.tri(x - w * 0.8, ty - h * 0.03, x, ty - th * 0.94, x, ty - h * 0.03, light, 0.5);
  }
}

function canopy(t, x, y, r, dark, light) {
  t.disc(x, y + r * 0.9, r * 0.45, mul(dark, 0.4), 0.35); // ground shadow
  t.line(x, y + r * 0.6, x, y + r * 1.05, r * 0.28, mul(dark, 0.5), 0.9);
  t.disc(x, y, r, dark, 0.97);
  t.disc(x - r * 0.3, y - r * 0.32, r * 0.62, light, 0.6);
}

function peak(t, x, y, w, h, base) {
  const rock = mul(base, 0.72), lit = mix(mul(base, 1.18), [255, 255, 255], 0.12);
  const snow = [244, 246, 249], snowShade = [205, 213, 224];
  t.tri(x - w, y, x, y - h, x + w * 0.1, y, lit, 1);       // lit left face
  t.tri(x + w * 0.1, y, x, y - h, x + w, y, rock, 1);       // shaded right face
  const sy = y - h * 0.62, sw = w * 0.34;
  t.tri(x - sw, sy, x, y - h, x + sw * 0.2, sy, snow, 1);
  t.tri(x + sw * 0.2, sy, x, y - h, x + sw, sy, snowShade, 1);
}

/* ---------------- Per-biome recipes ---------------- */

const RECIPES = {
  [B.OCEAN](t, rng, base) {
    t.fillNoise(mul(base, 0.94), 0.05, rng, 48);
    const light = mix(base, [255, 255, 255], 0.35);
    for (const [x, y] of scatter(rng, 9, 44, 20)) {
      const w = 20 + rng() * 16;
      t.line(x - w, y, x - w * 0.3, y - 3.5, 2.6, light, 0.4);
      t.line(x - w * 0.3, y - 3.5, x + w * 0.4, y, 2.6, light, 0.4);
    }
  },
  [B.LAKE](t, rng, base) {
    t.fillNoise(base, 0.045, rng, 44);
    const light = mix(base, [255, 255, 255], 0.4);
    for (const [x, y] of scatter(rng, 7, 50, 22)) {
      const w = 16 + rng() * 12;
      t.line(x - w, y, x + w * 0.4, y, 2.4, light, 0.35);
    }
  },
  [B.GLACIER](t, rng, base) {
    t.fillNoise(base, 0.03, rng, 40);
    const crack = [148, 176, 198];
    for (const [x, y] of scatter(rng, 6, 52, 18)) {
      const dx = 14 + rng() * 22, dy = (rng() - 0.5) * 26;
      t.line(x - dx, y - dy, x + dx, y + dy, 2, crack, 0.4);
      t.line(x + dx, y + dy, x + dx + 10, y + dy + (rng() - 0.5) * 14, 1.8, crack, 0.3);
    }
  },
  [B.TUNDRA](t, rng, base) {
    t.fillNoise(base, 0.07, rng, 30);
    const moss = mix(base, [90, 110, 60], 0.5), stone = mix(base, [200, 200, 205], 0.5);
    for (const [x, y] of scatter(rng, 26, 20, 12)) {
      t.disc(x, y, 2.5 + rng() * 2.5, rng() < 0.5 ? moss : stone, 0.5);
    }
  },
  [B.TAIGA](t, rng, base) {
    t.fillNoise(base, 0.06, rng, 34);
    const dark = mul(base, 0.62), light = mix(base, [200, 230, 170], 0.35);
    for (const [x, y] of scatter(rng, 9, 52, 30)) conifer(t, x, y, 34 + rng() * 10, dark, light);
  },
  [B.COLD_DESERT](t, rng, base) {
    t.fillNoise(base, 0.05, rng, 36);
    const shade = mul(base, 0.82);
    for (const [x, y] of scatter(rng, 8, 46, 20)) {
      const w = 24 + rng() * 18;
      t.line(x - w, y, x, y - 5, 2.4, shade, 0.55);
      t.line(x, y - 5, x + w * 0.7, y + 1, 2.4, shade, 0.4);
    }
  },
  [B.GRASSLAND](t, rng, base) {
    t.fillNoise(base, 0.06, rng, 30);
    const blade = mul(base, 0.7);
    for (const [x, y] of scatter(rng, 34, 17, 10)) {
      t.line(x, y, x - 2.5, y - 7, 1.6, blade, 0.6);
      t.line(x + 3, y, x + 4.5, y - 6, 1.4, blade, 0.5);
    }
  },
  [B.SAVANNA](t, rng, base) {
    t.fillNoise(base, 0.06, rng, 32);
    const blade = mul(base, 0.72), dark = [92, 100, 44], light = [136, 146, 66];
    for (const [x, y] of scatter(rng, 20, 20, 12)) t.line(x, y, x - 2, y - 6, 1.5, blade, 0.55);
    for (const [x, y] of scatter(rng, 3, 80, 40)) {
      t.line(x, y, x, y + 16, 3, [86, 66, 40], 0.9);
      t.disc(x, y - 2, 15, dark, 0.95);
      t.disc(x, y - 2, 15, light, 0.45);
      t.tri(x - 15, y + 2, x + 15, y + 2, x, y + 8, mul(base, 1.02), 1); // flatten bottom
    }
  },
  [B.HOT_DESERT](t, rng, base) {
    t.fillNoise(base, 0.04, rng, 40);
    const shade = mul(base, 0.8), lit = mix(base, [255, 255, 255], 0.18);
    for (const [x, y] of scatter(rng, 7, 52, 22)) {
      const w = 30 + rng() * 22;
      t.line(x - w, y + 4, x, y - 6, 3, lit, 0.5);
      t.line(x, y - 6, x + w * 0.8, y + 2, 2.6, shade, 0.5);
    }
  },
  [B.TROP_SEASONAL](t, rng, base) {
    t.fillNoise(base, 0.06, rng, 32);
    const dark = mul(base, 0.6), light = mix(base, [230, 240, 150], 0.3);
    for (const [x, y] of scatter(rng, 6, 60, 30)) canopy(t, x, y, 13 + rng() * 4, dark, light);
    const blade = mul(base, 0.72);
    for (const [x, y] of scatter(rng, 14, 24, 12)) t.line(x, y, x - 2, y - 6, 1.4, blade, 0.5);
  },
  [B.DECIDUOUS](t, rng, base) {
    t.fillNoise(base, 0.055, rng, 34);
    const dark = mul(base, 0.58), light = mix(base, [220, 245, 170], 0.35);
    for (const [x, y] of scatter(rng, 8, 52, 28)) canopy(t, x, y, 14 + rng() * 5, dark, light);
  },
  [B.TROP_RAIN](t, rng, base) {
    t.fillNoise(mul(base, 0.95), 0.06, rng, 30);
    const dark = mul(base, 0.52), light = mix(base, [225, 250, 160], 0.3);
    for (const [x, y] of scatter(rng, 12, 38, 20)) canopy(t, x, y, 12 + rng() * 6, dark, light);
  },
  [B.TEMP_RAIN](t, rng, base) {
    t.fillNoise(mul(base, 0.96), 0.055, rng, 32);
    const dark = mul(base, 0.55), light = mix(base, [210, 240, 180], 0.32);
    const pts = scatter(rng, 10, 42, 24);
    pts.forEach(([x, y], i) => {
      if (i % 2) conifer(t, x, y, 30 + rng() * 8, dark, light);
      else canopy(t, x, y, 12 + rng() * 4, dark, light);
    });
  },
  [B.WETLAND](t, rng, base) {
    t.fillNoise(base, 0.055, rng, 30);
    const pool = [70, 118, 150], reed = mul(base, 0.6);
    for (const [x, y] of scatter(rng, 5, 60, 26)) t.disc(x, y, 7 + rng() * 5, pool, 0.55);
    for (const [x, y] of scatter(rng, 16, 26, 14)) {
      t.line(x, y, x - 4, y - 10, 1.6, reed, 0.7);
      t.line(x, y, x + 1, y - 12, 1.6, reed, 0.7);
      t.line(x, y, x + 5, y - 9, 1.6, reed, 0.7);
    }
  },
  [B.MOUNTAIN](t, rng, base) {
    t.fillNoise(base, 0.06, rng, 36);
    peak(t, 82 + rng() * 12, 178, 58, 96, base);
    peak(t, 186 + rng() * 10, 190, 52, 82, base);
    peak(t, 132 + rng() * 12, 208, 64, 118, base);
  },
  [B.SNOW](t, rng, base) {
    t.fillNoise(base, 0.025, rng, 44);
    const shade = [206, 216, 228], rock = [148, 148, 152];
    for (const [x, y] of scatter(rng, 7, 48, 20)) {
      const w = 20 + rng() * 16;
      t.line(x - w, y, x + w * 0.5, y - 3, 2.6, shade, 0.5);
    }
    for (const [x, y] of scatter(rng, 4, 62, 30)) t.tri(x - 6, y, x + 6, y, x + 1, y - 8, rock, 0.55);
  },
  [B.BEACH](t, rng, base) {
    t.fillNoise(base, 0.045, rng, 34);
    const dot = mul(base, 0.78), light = mix(base, [255, 255, 255], 0.3);
    for (const [x, y] of scatter(rng, 30, 18, 10)) t.disc(x, y, 1.4 + rng(), dot, 0.5);
    for (const [x, y] of scatter(rng, 4, 70, 26)) {
      const w = 34 + rng() * 20;
      t.line(x - w, y, x + w, y + (rng() - 0.5) * 8, 2.2, light, 0.45);
    }
  }
};

/* ---------------- Main ---------------- */

for (const [idStr, key] of Object.entries(BIOME_KEYS)) {
  const id = Number(idStr);
  const t = new Tile();
  const rng = mulberry(0x9e3779b9 ^ (id * 2654435761));
  const base = hexToRgb(BIOME_COLORS[id]);
  RECIPES[id](t, rng, base);
  const file = join(OUT, `${key.toLowerCase()}.png`);
  writePng(file, t.px);
  console.log("wrote", file);
}
