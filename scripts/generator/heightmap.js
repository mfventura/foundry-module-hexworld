/**
 * Heightmap construction: layered simplex fBm + ridged mountains, shaped by
 * a per-template edge falloff so land masses avoid the map border. Elevation
 * is normalized to [0,1]; the sea level is later chosen as a quantile so the
 * "water percentage" slider is meaningful regardless of noise distribution.
 */

import { Simplex2, fbm, ridged } from "../lib/noise.js";

/**
 * Template tuning notes:
 *  - `falloffDrop` must stay small for anything that is not a pangea — the sea
 *    level is a quantile, so an aggressive border drop eats the whole water
 *    budget and every template collapses into one central landmass.
 *  - `water` is the default water fraction the UI adopts when the template is
 *    selected; the shape of each template only reads correctly near it.
 */
export const TEMPLATES = {
  continents:  { freq: 1.3, octaves: 5, ridge: 0.35, ridgeFreq: 3.2, falloff: 0.14, falloffDrop: 0.14, centerBoost: 0, water: 0.58 },
  pangea:      { freq: 1.2, octaves: 5, ridge: 0.40, ridgeFreq: 2.6, falloff: 0.30, falloffDrop: 0.35, centerBoost: 0.35, water: 0.5 },
  archipelago: { freq: 3.4, octaves: 5, ridge: 0.28, ridgeFreq: 5.0, falloff: 0.14, falloffDrop: 0.10, centerBoost: 0, water: 0.68 },
  islands:     { freq: 5.0, octaves: 4, ridge: 0.22, ridgeFreq: 7.0, falloff: 0.14, falloffDrop: 0.10, centerBoost: 0, water: 0.78 }
};

function smoothstep(t) { return t * t * (3 - 2 * t); }

/**
 * @param {import("./grid.js").WorldGrid} grid
 * @param {() => number} rng
 * @param {string} templateKey
 * @returns {Float32Array} elevation in [0,1]
 */
export function buildHeightmap(grid, rng, templateKey) {
  const cfg = TEMPLATES[templateKey] ?? TEMPLATES.continents;
  const base = new Simplex2(rng);
  const ridge = new Simplex2(rng);
  const n = grid.n;
  const elev = new Float32Array(n);
  const W = grid.pixelWidth, H = grid.pixelHeight;
  const maxDim = Math.max(W, H);

  for (let c = 0; c < n; c++) {
    const nx = grid.cx[c] / maxDim;
    const ny = grid.cy[c] / maxDim;

    const e = (fbm(base, nx * cfg.freq, ny * cfg.freq, { octaves: cfg.octaves }) + 1) / 2;
    const r = ridged(ridge, nx * cfg.ridgeFreq, ny * cfg.ridgeFreq, { octaves: 4 });
    let v = 0.72 * e + cfg.ridge * r * r;

    if (cfg.centerBoost) {
      const dx = grid.cx[c] / W - 0.5;
      const dy = grid.cy[c] / H - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2; // 0 center, ~1 corner
      v += cfg.centerBoost * Math.max(0, 1 - d);
    }

    // Edge falloff: bias the map border toward water without flattening it —
    // the noise must keep control of the interior shapes.
    const px = grid.cx[c] / W, py = grid.cy[c] / H;
    const edge = Math.min(px, 1 - px, py, 1 - py); // 0 at border, 0.5 at center
    const t = smoothstep(Math.min(1, Math.max(0, edge / cfg.falloff)));
    v = v * (0.6 + 0.4 * t) - (1 - t) * cfg.falloffDrop;

    elev[c] = v;
  }

  // One light smoothing pass: removes single-cell speckle (tiny lakes/islets)
  // and cleans up coastlines without erasing the large-scale shapes.
  const smoothed = new Float32Array(n);
  let min = Infinity, max = -Infinity;
  for (let c = 0; c < n; c++) {
    let sum = 0, count = 0;
    for (const nb of grid.neighbors[c]) { sum += elev[nb]; count++; }
    const v = count ? 0.65 * elev[c] + 0.35 * (sum / count) : elev[c];
    smoothed[c] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min || 1;
  for (let c = 0; c < n; c++) smoothed[c] = (smoothed[c] - min) / range;
  return smoothed;
}

/** Sea level such that ~waterFraction of cells are below it. */
export function seaLevelFor(elev, waterFraction) {
  const sorted = Float32Array.from(elev).sort();
  const k = Math.min(sorted.length - 1, Math.max(0, Math.floor(waterFraction * sorted.length)));
  return sorted[k];
}
