/**
 * World generation orchestrator. Fully deterministic from params.seed:
 * the same params always regenerate the same world, so scenes only need to
 * store the params in flags, never the raw arrays.
 */

import { makeRng } from "../lib/random.js";
import { NO_OVERRIDE } from "../lib/codec.js";
import { WorldGrid } from "./grid.js";
import { buildHeightmap, seaLevelFor } from "./heightmap.js";
import { computeTemperature, computeMoisture } from "./climate.js";
import { computeHydrology, computeFlux, markRivers } from "./hydrology.js";
import { assignBiomes, B } from "./biomes.js";

export const MAX_CELLS = 25000;

/**
 * @param {object} params
 * @param {string} params.seed
 * @param {string} params.template     continents|pangea|archipelago|islands
 * @param {number} params.gridType     CONST.GRID_TYPES value
 * @param {number} params.cols
 * @param {number} params.rows
 * @param {number} params.cellSize     pixels per grid space
 * @param {number} params.waterFraction 0..1
 * @param {string} params.climate      temperate|cold|tropical|planet
 * @param {number} params.moisture     multiplier ~0.5..1.5
 * @param {number} params.riverDensity 0..1
 */
export function generateWorld(params) {
  return deriveWorld(buildBase(params), null, null, null);
}

/**
 * The immutable part of a world: grid, procedural heightmap and sea level.
 * Manual terrain edits are applied on top of this without regenerating it,
 * and the sea level stays frozen so painting land never shifts the coastline
 * elsewhere on the map.
 */
export function buildBase(params) {
  const n = params.cols * params.rows;
  if (n > MAX_CELLS) {
    throw new Error(`HexWorld: too many cells (${n} > ${MAX_CELLS})`);
  }

  const grid = new WorldGrid({
    type: params.gridType,
    size: params.cellSize,
    cols: params.cols,
    rows: params.rows
  });

  // Independent RNG streams per stage so tweaking one slider (e.g. moisture)
  // never reshuffles unrelated stages of the same seed.
  // params.algo versions the pipeline: worlds re-derive from flags forever, so
  // algorithm improvements only apply to algo >= 2 worlds (old scenes keep
  // their exact terrain). Missing algo (pre-0.7.0 scenes) means 1.
  const algo = params.algo ?? 1;
  const elevBase = buildHeightmap(grid, makeRng(params.seed + ":elev"), params.template, algo);
  const sea = seaLevelFor(elevBase, params.waterFraction);
  return { params, grid, elevBase, sea, algo };
}

/**
 * Derive the full world (hydrology, climate, biomes) from a base plus
 * optional per-cell edits painted by the user: an elevation delta layer and
 * a biome override layer. Overrides are a final layer over assignBiomes —
 * water is always elevation-driven, so an override on a submerged cell stays
 * latent until the cell is dry land again.
 * Manual rivers are a third channel (RIVER_FORCE/RIVER_SUPPRESS per cell)
 * applied inside markRivers, land only — like biome overrides they stay
 * latent while a cell is submerged.
 * @param {object} base result of buildBase()
 * @param {Float32Array|null} edits elevation deltas, same length as cells
 * @param {Uint8Array|null} overrides biome id per cell, NO_OVERRIDE = none
 * @param {Uint8Array|null} riverEdits per-cell river state, 0 = derived
 */
export function deriveWorld(base, edits, overrides = null, riverEdits = null) {
  const { params, grid, elevBase, sea } = base;

  let elev = elevBase;
  if (edits) {
    elev = new Float32Array(grid.n);
    for (let c = 0; c < grid.n; c++) {
      elev[c] = Math.min(1, Math.max(0, elevBase[c] + edits[c]));
    }
  }

  const { isOcean, isLake, isWater, filled } = computeHydrology(grid, elev, sea);
  const temp = computeTemperature(grid, elev, sea, params.climate);
  const moist = computeMoisture(grid, makeRng(params.seed + ":moist"), isWater, params.moisture, {
    algo: base.algo ?? 1, elev, sea
  });
  const { flowTo, flux } = computeFlux(grid, filled, isOcean, isLake, moist);
  const { isRiver, threshold } = markRivers(grid, flux, isWater, params.riverDensity, riverEdits);

  const world = {
    params, grid, elev, sea, filled,
    isOcean, isLake, isWater,
    temp, moist, flowTo, flux, isRiver,
    riverThreshold: threshold,
    base, edits, overrides, riverEdits
  };
  world.biome = assignBiomes(world);
  if (overrides) {
    for (let c = 0; c < grid.n; c++) {
      if (overrides[c] !== NO_OVERRIDE && !isWater[c]) world.biome[c] = overrides[c];
    }
  }
  world.stats = computeStats(world);
  return world;
}

function computeStats(world) {
  const { grid, isWater, isLake, isRiver } = world;
  let land = 0, lakes = 0, rivers = 0;
  for (let c = 0; c < grid.n; c++) {
    if (!isWater[c]) land++;
    if (isLake[c]) lakes++;
    if (isRiver[c]) rivers++;
  }
  return {
    cells: grid.n,
    landPct: Math.round((land / grid.n) * 100),
    riverCells: rivers,
    lakeCells: lakes
  };
}

export { B };
