/**
 * Climate: temperature from latitude + altitude lapse; moisture from noise,
 * proximity to water and a global multiplier. Temperatures are in °C so the
 * biome table can use intuitive thresholds.
 */

import { Simplex2, fbm } from "../lib/noise.js";

export const CLIMATES = {
  temperate: { north: 0, south: 22 },
  cold:      { north: -18, south: 10 },
  tropical:  { north: 18, south: 32 },
  planet:    { planet: true, equator: 28, pole: -25 }
};

/**
 * @returns {Float32Array} temperature in °C per cell
 */
export function computeTemperature(grid, elev, sea, climateKey) {
  const cfg = CLIMATES[climateKey] ?? CLIMATES.temperate;
  const n = grid.n;
  const temp = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const lat = grid.latFrac(c);
    let t;
    if (cfg.planet) {
      const x = Math.abs(lat - 0.5) * 2; // 0 at equator (map middle), 1 at poles
      t = cfg.equator - (cfg.equator - cfg.pole) * Math.pow(x, 1.2);
    } else {
      t = cfg.north + (cfg.south - cfg.north) * lat;
    }
    const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
    t -= 26 * Math.pow(above, 1.4); // altitude lapse: up to ~-26°C at the highest peaks
    temp[c] = t;
  }
  return temp;
}

/**
 * Prevailing zonal wind per latitude band, in row direction (+1 = the wind
 * blows toward +x / east, -1 = toward -x / west). Three bands like a toy
 * Earth: westerlies, easterlies (trades), westerlies.
 */
export function windDirFor(latFrac) {
  if (latFrac < 1 / 3) return 1;
  if (latFrac < 2 / 3) return -1;
  return 1;
}

/**
 * Algo v2 rain shadow: sweep each row along the prevailing wind carrying an
 * air-humidity budget. Water recharges it; land drains it slowly and dumps it
 * fast on upslopes (orographic precipitation) — so the lee side of a mountain
 * range receives little rain. Returns per-cell rainfall in [0,1] (normalized
 * by a high land quantile so the multiplier keeps meaning).
 */
function computeRainShadow(grid, isWater, elev, sea) {
  const n = grid.n;
  const rain = new Float32Array(n);
  const relief = c => Math.max(0, (elev[c] - sea) / (1 - sea || 1));

  for (let i = 0; i < grid.rows; i++) {
    const dir = windDirFor(grid.rows > 1 ? i / (grid.rows - 1) : 0.5);
    let humidity = 0.7; // offshore air entering the map
    let prevRelief = 0;
    const j0 = dir > 0 ? 0 : grid.cols - 1;
    for (let s = 0; s < grid.cols; s++) {
      const j = j0 + dir * s;
      const c = grid.index(i, j);
      if (isWater[c]) {
        humidity = Math.min(1, humidity + 0.30);
        rain[c] = 0.6;
        prevRelief = 0;
        continue;
      }
      const rel = relief(c);
      const upslope = Math.max(0, rel - prevRelief);
      const rate = Math.min(0.9, 0.07 + 2.2 * upslope + 0.10 * rel);
      const precip = humidity * rate;
      humidity -= precip;
      rain[c] = precip;
      prevRelief = rel;
    }
  }

  // Normalize by the 90th percentile of land rainfall so the field spans [0,1].
  const land = [];
  for (let c = 0; c < n; c++) if (!isWater[c]) land.push(rain[c]);
  land.sort((a, b) => a - b);
  const p90 = land.length ? land[Math.floor(land.length * 0.9)] || 1 : 1;
  for (let c = 0; c < n; c++) rain[c] = Math.min(1, rain[c] / p90);
  return rain;
}

/**
 * The seed-only fBm term of the moisture field. Depends on grid + rng only —
 * never on edits — so buildBase computes it once and every deriveWorld
 * (brush stroke) reuses it instead of reshuffling a Simplex table + 4-octave
 * fbm per cell per frame.
 * @returns {Float32Array} values in [0,1]
 */
export function moistureNoiseField(grid, rng) {
  const noise = new Simplex2(rng);
  const maxDim = Math.max(grid.pixelWidth, grid.pixelHeight);
  const field = new Float32Array(grid.n);
  for (let c = 0; c < grid.n; c++) {
    const nx = grid.cx[c] / maxDim, ny = grid.cy[c] / maxDim;
    field[c] = (fbm(noise, nx * 3.0, ny * 3.0, { octaves: 4 }) + 1) / 2;
  }
  return field;
}

/**
 * Moisture in [0,1]: fBm base + bonus near any water body (BFS distance),
 * scaled by the user multiplier. With opts.algo >= 2 the dominant term is
 * orographic rainfall (rain shadow) instead of pure noise.
 * @param {Uint8Array} isWater 1 for ocean/lake cells
 * @param {{algo?: number, elev?: Float32Array, sea?: number,
 *          noiseField?: Float32Array}|null} opts precomputed noise wins over rng
 */
export function computeMoisture(grid, rng, isWater, multiplier, opts = null) {
  const n = grid.n;
  const noiseField = opts?.noiseField ?? moistureNoiseField(grid, rng);
  const rain = (opts?.algo ?? 1) >= 2 && opts.elev
    ? computeRainShadow(grid, isWater, opts.elev, opts.sea)
    : null;

  // Multi-source BFS distance (in cells) to the nearest water, capped.
  const CAP = 10;
  const dist = new Int16Array(n).fill(CAP);
  const queue = [];
  for (let c = 0; c < n; c++) if (isWater[c]) { dist[c] = 0; queue.push(c); }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    const d = dist[c] + 1;
    if (d >= CAP) continue;
    for (const nb of grid.neighbors[c]) {
      if (d < dist[nb]) { dist[nb] = d; queue.push(nb); }
    }
  }

  const moist = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const base = noiseField[c];
    const waterBonus = Math.max(0, (CAP - dist[c]) / CAP) * 0.35;
    let m;
    if (rain) {
      // Rainfall dominates; noise adds local variety and coasts stay moist.
      m = (0.55 * rain[c] + 0.20 * base + 0.08 + waterBonus * 0.55) * multiplier;
    } else {
      m = (0.55 * base + 0.15 + waterBonus) * multiplier;
    }
    moist[c] = Math.min(1, Math.max(0, m));
  }
  return moist;
}
