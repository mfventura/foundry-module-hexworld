/**
 * Terrain brush shared by the generator preview and the in-scene canvas
 * layer. Mutates the `edits` delta array; coordinates are in world pixels
 * (the grid's own coordinate space).
 */

/**
 * @param {object} base  result of buildBase()
 * @param {Float32Array} edits  elevation deltas (mutated)
 * @param {Map<number, number>|null} strokeUndo  records the pre-stroke delta per touched cell
 * @param {object} opts
 * @param {string} opts.tool  raise|lower|smooth
 * @param {number} opts.radius  brush radius in cells
 * @param {number} opts.strength  elevation delta per application
 * @param {number} opts.x  world pixel x
 * @param {number} opts.y  world pixel y
 * @returns {number} cells touched
 */
export function applyBrush(base, edits, strokeUndo, { tool, radius, strength, x, y }) {
  const { grid, elevBase } = base;
  const radiusPx = radius * grid.size;
  const r2 = radiusPx * radiusPx;
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
