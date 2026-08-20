/**
 * Terrain brush shared by the generator preview and the in-scene canvas
 * layer. Mutates the `edits` delta array; coordinates are in world pixels
 * (the grid's own coordinate space).
 */

/**
 * Semantic paint tools push elevation toward a target relative to the frozen
 * sea level; the derived pipeline (flood-fill, rivers, biomes) then makes the
 * cell water/land/mountain consistently with its surroundings.
 * Targets: water = clearly below sea; land = lowland (climate picks the
 * biome); mountain = above the 0.55 mountain override in assignBiomes.
 */
function toolTarget(tool, sea) {
  switch (tool) {
    case "water": return sea * 0.5;
    case "land": return sea + (1 - sea) * 0.12;
    case "mountain": return sea + (1 - sea) * 0.7;
    default: return null;
  }
}

/**
 * @param {object} base  result of buildBase()
 * @param {Float32Array} edits  elevation deltas (mutated)
 * @param {Map<number, number>|null} strokeUndo  records the pre-stroke delta per touched cell
 * @param {object} opts
 * @param {string} opts.tool  raise|lower|smooth|water|land|mountain
 * @param {number} opts.radius  brush radius in cells
 * @param {number} opts.strength  elevation delta per application (paint tools: convergence speed)
 * @param {number} opts.x  world pixel x
 * @param {number} opts.y  world pixel y
 * @returns {number} cells touched
 */
export function applyBrush(base, edits, strokeUndo, { tool, radius, strength, x, y }) {
  const { grid, elevBase, sea } = base;
  const radiusPx = radius * grid.size;
  const r2 = radiusPx * radiusPx;
  const target = toolTarget(tool, sea);
  let touched = 0;

  for (let c = 0; c < grid.n; c++) {
    const dx = grid.cx[c] - x;
    const dy = grid.cy[c] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const falloff = (1 - Math.sqrt(d2) / radiusPx) ** 2;
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, edits[c]);
    touched++;

    if (tool === "raise") edits[c] += strength * falloff;
    else if (tool === "lower") edits[c] -= strength * falloff;
    else if (target !== null) {
      const current = Math.min(1, Math.max(0, elevBase[c] + edits[c]));
      edits[c] += (target - current) * Math.min(1, strength * 10) * falloff;
    }
    else if (tool === "smooth") {
      const nbs = grid.neighbors[c];
      if (!nbs.length) continue;
      let sum = 0;
      for (const nb of nbs) sum += Math.min(1, Math.max(0, elevBase[nb] + edits[nb]));
      const current = Math.min(1, Math.max(0, elevBase[c] + edits[c]));
      edits[c] += (sum / nbs.length - current) * Math.min(1, strength * 8) * falloff;
    }
  }
  return touched;
}

/**
 * Biome override brush: categorical, so every cell within the radius gets the
 * full value (no falloff). Painting NO_OVERRIDE acts as the eraser, returning
 * cells to their derived biome.
 * @param {object} base  result of buildBase()
 * @param {Uint8Array} overrides  biome id per cell (mutated)
 * @param {Map<number, number>|null} strokeUndo  pre-stroke override per touched cell
 * @param {object} opts
 * @param {number} opts.biome  biome id to paint, or NO_OVERRIDE to erase
 * @param {number} opts.radius  brush radius in cells
 * @param {number} opts.x  world pixel x
 * @param {number} opts.y  world pixel y
 * @returns {number} cells touched
 */
export function applyBiomeBrush(base, overrides, strokeUndo, { biome, radius, x, y }) {
  const { grid } = base;
  const radiusPx = radius * grid.size;
  const r2 = radiusPx * radiusPx;
  let touched = 0;
  for (let c = 0; c < grid.n; c++) {
    const dx = grid.cx[c] - x;
    const dy = grid.cy[c] - y;
    if (dx * dx + dy * dy > r2) continue;
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, overrides[c]);
    overrides[c] = biome;
    touched++;
  }
  return touched;
}
