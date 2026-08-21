/**
 * Hydrology:
 *  - Ocean detection: flood fill from border water cells (enclosed water = lakes).
 *  - Depression filling: priority-flood so every land cell has a strictly
 *    descending path to the ocean/border; deep filled pits become lakes.
 *  - Flow accumulation: rainfall (from moisture) routed downhill over the
 *    filled surface; high-flux cells are rivers. Because flux is monotonic
 *    downstream, thresholding produces connected river networks that pass
 *    through lakes and end at the sea.
 */

import { MinHeap } from "../lib/heap.js";

const EPS = 1e-5;

/** Per-cell manual river edit states (0 = derived). */
export const RIVER_FORCE = 1;
export const RIVER_SUPPRESS = 2;

/**
 * @returns {{isOcean: Uint8Array, isLake: Uint8Array, isWater: Uint8Array,
 *            filled: Float32Array, flowTo: Int32Array, flux: Float32Array}}
 */
export function computeHydrology(grid, elev, sea) {
  const n = grid.n;
  const isOcean = new Uint8Array(n);
  const isLake = new Uint8Array(n);

  // --- Ocean: flood fill from border cells below sea level ---
  const stack = [];
  for (let c = 0; c < n; c++) {
    if (grid.isBorder(c) && elev[c] < sea) { isOcean[c] = 1; stack.push(c); }
  }
  while (stack.length) {
    const c = stack.pop();
    for (const nb of grid.neighbors[c]) {
      if (!isOcean[nb] && elev[nb] < sea) { isOcean[nb] = 1; stack.push(nb); }
    }
  }

  // --- Priority-flood depression filling, seeded from the map border ---
  // A cell's filled value is final before it is pushed (visited guard), so a
  // push-time priority snapshot is exact.
  const filled = Float32Array.from(elev);
  const visited = new Uint8Array(n);
  const heap = new MinHeap();
  for (let c = 0; c < n; c++) {
    if (grid.isBorder(c)) { visited[c] = 1; heap.push(filled[c], c); }
  }
  while (heap.size) {
    const c = heap.pop();
    for (const nb of grid.neighbors[c]) {
      if (visited[nb]) continue;
      visited[nb] = 1;
      const floor = isOcean[nb] ? filled[c] : filled[c] + EPS;
      if (filled[nb] < floor) filled[nb] = floor;
      heap.push(filled[nb], nb);
    }
  }

  // --- Enclosed below-sea water: large connected bodies are inland seas
  // (they behave as ocean for climate, biomes and rendering); small ones are
  // lakes. Land pits filled noticeably above terrain are lakes too. ---
  const seaBodyMin = Math.max(24, Math.round(n * 0.015));
  const seen = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    if (seen[c] || isOcean[c] || elev[c] >= sea) continue;
    const body = [c];
    seen[c] = 1;
    for (let q = 0; q < body.length; q++) {
      for (const nb of grid.neighbors[body[q]]) {
        if (!seen[nb] && !isOcean[nb] && elev[nb] < sea) { seen[nb] = 1; body.push(nb); }
      }
    }
    const target = body.length >= seaBodyMin ? isOcean : isLake;
    for (const cell of body) target[cell] = 1;
  }
  for (let c = 0; c < n; c++) {
    if (!isOcean[c] && !isLake[c] && filled[c] - elev[c] > 0.02) isLake[c] = 1;
  }

  const isWater = new Uint8Array(n);
  for (let c = 0; c < n; c++) isWater[c] = (isOcean[c] || isLake[c]) ? 1 : 0;

  return { isOcean, isLake, isWater, filled };
}

/**
 * Route rainfall downhill over the filled surface and accumulate flux.
 * Lakes participate so rivers continue from inlets to outlets.
 * @returns {{flowTo: Int32Array, flux: Float32Array}}
 */
export function computeFlux(grid, filled, isOcean, isLake, moist) {
  const n = grid.n;
  const flowTo = new Int32Array(n).fill(-1);
  const flux = new Float32Array(n);

  const order = [];
  for (let c = 0; c < n; c++) {
    if (!isOcean[c]) {
      order.push(c);
      flux[c] = isLake[c] ? 0.02 : 0.05 + moist[c];
    }
  }
  order.sort((a, b) => filled[b] - filled[a]);

  for (const c of order) {
    let best = -1, bestF = filled[c];
    for (const nb of grid.neighbors[c]) {
      if (filled[nb] < bestF) { bestF = filled[nb]; best = nb; }
    }
    if (best === -1) continue; // border drain or perfectly flat: water leaves the map
    flowTo[c] = best;
    flux[best] += flux[c];
  }
  return { flowTo, flux };
}

/**
 * Mark river cells: land cells whose flux exceeds a quantile-based threshold,
 * then apply manual edits (RIVER_FORCE / RIVER_SUPPRESS) on land cells.
 * @param {number} density 0..1 slider — fraction of land that carries a river
 * @param {Uint8Array|null} riverEdits per-cell manual state, 0 = derived
 * @returns {{isRiver: Uint8Array, threshold: number}}
 */
export function markRivers(grid, flux, isWater, density, riverEdits = null) {
  const landFlux = [];
  for (let c = 0; c < grid.n; c++) if (!isWater[c]) landFlux.push(flux[c]);
  if (!landFlux.length) return { isRiver: new Uint8Array(grid.n), threshold: Infinity };
  landFlux.sort((a, b) => a - b);
  const frac = 0.005 + 0.035 * density; // 0.5%..4% of land cells are river
  const k = Math.max(0, Math.min(landFlux.length - 1, Math.floor((1 - frac) * landFlux.length)));
  const threshold = landFlux[k];

  const isRiver = new Uint8Array(grid.n);
  for (let c = 0; c < grid.n; c++) {
    if (isWater[c]) continue;
    let river = flux[c] >= threshold;
    const e = riverEdits ? riverEdits[c] : 0;
    if (e === RIVER_FORCE) river = true;
    else if (e === RIVER_SUPPRESS) river = false;
    if (river) isRiver[c] = 1;
  }
  return { isRiver, threshold };
}
