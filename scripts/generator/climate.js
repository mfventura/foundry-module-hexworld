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
 * Moisture in [0,1]: fBm base + bonus near any water body (BFS distance),
 * scaled by the user multiplier.
 * @param {Uint8Array} isWater 1 for ocean/lake cells
 */
export function computeMoisture(grid, rng, isWater, multiplier) {
  const n = grid.n;
  const noise = new Simplex2(rng);
  const maxDim = Math.max(grid.pixelWidth, grid.pixelHeight);

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
    const nx = grid.cx[c] / maxDim, ny = grid.cy[c] / maxDim;
    const base = (fbm(noise, nx * 3.0, ny * 3.0, { octaves: 4 }) + 1) / 2;
    const waterBonus = Math.max(0, (CAP - dist[c]) / CAP) * 0.35;
    let m = (0.55 * base + 0.15 + waterBonus) * multiplier;
    moist[c] = Math.min(1, Math.max(0, m));
  }
  return moist;
}
