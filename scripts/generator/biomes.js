/**
 * Biome assignment: a Whittaker-style temperature × moisture table, with
 * overrides for mountains (elevation), glaciers (deep cold), wetlands
 * (low, wet, near water) and beaches (warm ocean-adjacent lowlands).
 */

export const B = {
  OCEAN: 0, LAKE: 1, GLACIER: 2, TUNDRA: 3, TAIGA: 4, COLD_DESERT: 5,
  GRASSLAND: 6, SAVANNA: 7, HOT_DESERT: 8, TROP_SEASONAL: 9, DECIDUOUS: 10,
  TROP_RAIN: 11, TEMP_RAIN: 12, WETLAND: 13, MOUNTAIN: 14, SNOW: 15, BEACH: 16
};

export const BIOME_COLORS = {
  [B.OCEAN]: "#2e5c8a",
  [B.LAKE]: "#5d8fbf",
  [B.GLACIER]: "#e8eef2",
  [B.TUNDRA]: "#96784b",
  [B.TAIGA]: "#4b6b32",
  [B.COLD_DESERT]: "#b5b887",
  [B.GRASSLAND]: "#c8d68f",
  [B.SAVANNA]: "#d2d082",
  [B.HOT_DESERT]: "#fbe79f",
  [B.TROP_SEASONAL]: "#b6d95d",
  [B.DECIDUOUS]: "#29bc56",
  [B.TROP_RAIN]: "#7dcb35",
  [B.TEMP_RAIN]: "#409c43",
  [B.WETLAND]: "#2f8f5b",
  [B.MOUNTAIN]: "#8d8579",
  [B.SNOW]: "#eef2f5",
  [B.BEACH]: "#e0d5a3"
};

// Rows: temperature band (polar → hot). Columns: moisture band (arid → wet).
const MATRIX = [
  [B.GLACIER, B.GLACIER, B.GLACIER, B.GLACIER, B.GLACIER],
  [B.COLD_DESERT, B.TUNDRA, B.TUNDRA, B.TUNDRA, B.TUNDRA],
  [B.COLD_DESERT, B.GRASSLAND, B.TAIGA, B.TAIGA, B.TAIGA],
  [B.COLD_DESERT, B.GRASSLAND, B.GRASSLAND, B.DECIDUOUS, B.TEMP_RAIN],
  [B.HOT_DESERT, B.SAVANNA, B.GRASSLAND, B.DECIDUOUS, B.TEMP_RAIN],
  [B.HOT_DESERT, B.HOT_DESERT, B.SAVANNA, B.TROP_SEASONAL, B.TROP_RAIN]
];

function tBand(t) {
  if (t < -10) return 0;
  if (t < 2) return 1;
  if (t < 10) return 2;
  if (t < 18) return 3;
  if (t < 24) return 4;
  return 5;
}

function mBand(m) {
  if (m < 0.15) return 0;
  if (m < 0.3) return 1;
  if (m < 0.5) return 2;
  if (m < 0.7) return 3;
  return 4;
}

/**
 * @returns {Uint8Array} biome id per cell
 */
export function assignBiomes(world) {
  const { grid, elev, sea, temp, moist, isOcean, isLake, isWater, flux, riverThreshold } = world;
  const n = grid.n;
  const biome = new Uint8Array(n);

  for (let c = 0; c < n; c++) {
    if (isOcean[c]) { biome[c] = B.OCEAN; continue; }
    if (isLake[c]) { biome[c] = B.LAKE; continue; }

    const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
    const t = temp[c];
    const m = moist[c];

    // Mountains override the climate table.
    if (above > 0.55) {
      biome[c] = (t < -2 || above > 0.8) ? B.SNOW : B.MOUNTAIN;
      continue;
    }

    // Beaches: warm ocean-adjacent lowland.
    let oceanAdjacent = false, waterAdjacent = false;
    for (const nb of grid.neighbors[c]) {
      if (isOcean[nb]) oceanAdjacent = true;
      if (isWater[nb]) waterAdjacent = true;
    }
    if (oceanAdjacent && above < 0.035 && t > 2) { biome[c] = B.BEACH; continue; }

    // Wetlands: low, wet, mild, next to water or fed by a sizable stream.
    const nearStream = flux[c] > riverThreshold * 0.5;
    if (above < 0.06 && t > -2 && m > 0.6 && (waterAdjacent || nearStream)) {
      biome[c] = B.WETLAND;
      continue;
    }

    biome[c] = MATRIX[tBand(t)][mBand(m)];
  }
  return biome;
}
