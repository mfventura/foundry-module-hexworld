/**
 * Terrain brush shared by the generator preview and the in-scene canvas
 * layer. Mutates the `edits` delta array; coordinates are in world pixels
 * (the grid's own coordinate space).
 */

import { RIVER_FORCE, RIVER_SUPPRESS } from "./hydrology.js";

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
// The persistence codec quantizes deltas to Int8 (±1.27): accumulate past
// that bound and the author's in-memory terrain silently diverges from what
// every other client decodes. Clamp at the source instead.
const EDIT_LIMIT = 1.27;
const clampEdit = v => Math.max(-EDIT_LIMIT, Math.min(EDIT_LIMIT, v));

/** Pointer→cell via the foundry grid (bounds-checked); -1 off the map. */
export function cellAt(grid, x, y) {
  if (x < 0 || y < 0 || x > grid.pixelWidth || y > grid.pixelHeight) return -1;
  let o;
  try {
    o = grid.foundryGrid.getOffset({ x, y });
  } catch (_err) {
    return -1;
  }
  if (!o || o.i < 0 || o.j < 0 || o.i >= grid.rows || o.j >= grid.cols) return -1;
  return grid.index(o.i, o.j);
}

/**
 * Cells within radiusPx of a point: a bounded neighbor expansion from the
 * pointer's cell instead of scanning every cell of the map per brush tick.
 * The pointer is clamped into the map so brushing along the border works.
 */
function cellsWithin(grid, x, y, radiusPx) {
  const cx = Math.min(grid.pixelWidth - 1, Math.max(0, x));
  const cy = Math.min(grid.pixelHeight - 1, Math.max(0, y));
  const start = cellAt(grid, cx, cy);
  if (start < 0) return [];
  const r2 = radiusPx * radiusPx;
  const maxHops = Math.ceil(radiusPx / grid.size) + 2;
  const out = [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let hop = 0; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const c of frontier) {
      const dx = grid.cx[c] - x;
      const dy = grid.cy[c] - y;
      if (dx * dx + dy * dy <= r2) out.push(c);
      for (const nb of grid.neighbors[c]) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export function applyBrush(base, edits, strokeUndo, { tool, radius, strength, x, y }) {
  const { grid, elevBase, sea } = base;
  const radiusPx = radius * grid.size;
  const target = toolTarget(tool, sea);
  let touched = 0;

  for (const c of cellsWithin(grid, x, y, radiusPx)) {
    const dx = grid.cx[c] - x;
    const dy = grid.cy[c] - y;
    const d2 = dx * dx + dy * dy;
    const falloff = (1 - Math.sqrt(d2) / radiusPx) ** 2;
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, edits[c]);
    touched++;

    if (tool === "raise") edits[c] = clampEdit(edits[c] + strength * falloff);
    else if (tool === "lower") edits[c] = clampEdit(edits[c] - strength * falloff);
    else if (target !== null) {
      const current = Math.min(1, Math.max(0, elevBase[c] + edits[c]));
      edits[c] = clampEdit(edits[c] + (target - current) * Math.min(1, strength * 10) * falloff);
    }
    else if (tool === "smooth") {
      const nbs = grid.neighbors[c];
      if (!nbs.length) continue;
      let sum = 0;
      for (const nb of nbs) sum += Math.min(1, Math.max(0, elevBase[nb] + edits[nb]));
      const current = Math.min(1, Math.max(0, elevBase[c] + edits[c]));
      edits[c] = clampEdit(edits[c] + (sum / nbs.length - current) * Math.min(1, strength * 8) * falloff);
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
 * @param {(c: number) => boolean} [opts.skip]  cells to leave untouched
 * @returns {number} cells touched
 */
export function applyBiomeBrush(base, overrides, strokeUndo, { biome, radius, x, y, skip = null }) {
  const { grid } = base;
  let touched = 0;
  for (const c of cellsWithin(grid, x, y, radius * grid.size)) {
    if (skip?.(c)) continue;
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, overrides[c]);
    overrides[c] = biome;
    touched++;
  }
  return touched;
}

/**
 * River editing: path-based, one application per click (no radius/strength).
 * - "riverAdd": from the clicked land cell, follow the real drainage (flowTo
 *   over the filled surface) forcing river cells until reaching water, the
 *   map border, or an existing river — the new river always flows downhill
 *   and ends somewhere sensible.
 * - "riverRemove": from the clicked river cell, suppress downstream until the
 *   mouth, but stop at a confluence still fed by another river branch, so
 *   shared trunks survive. Click a source to delete a whole river.
 * @param {object} world  result of deriveWorld() — current isRiver/flowTo
 * @param {Uint8Array} riverEdits  per-cell river state (mutated)
 * @param {Map<number, number>|null} strokeUndo  pre-stroke state per touched cell
 * @param {object} opts {tool: "riverAdd"|"riverRemove", x, y} world pixels
 * @returns {number} cells touched
 */
export function applyRiverTool(world, riverEdits, strokeUndo, { tool, x, y }) {
  const { grid, isWater, isRiver, flowTo } = world;
  const start = cellAt(grid, x, y);
  if (start < 0) return 0;
  let touched = 0;
  const set = (c, v) => {
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, riverEdits[c]);
    riverEdits[c] = v;
    touched++;
  };

  if (tool === "riverAdd") {
    if (isWater[start]) return 0;
    let cur = start, steps = 0;
    while (cur >= 0 && !isWater[cur] && steps++ < grid.n) {
      const joinsExisting = (cur !== start) && isRiver[cur] && riverEdits[cur] !== RIVER_SUPPRESS;
      set(cur, RIVER_FORCE);
      if (joinsExisting) break; // the existing network already reaches water
      cur = flowTo[cur];
    }
  } else if (tool === "riverRemove") {
    if (isWater[start] || !isRiver[start]) return 0;
    let cur = start, steps = 0;
    while (cur >= 0 && !isWater[cur] && isRiver[cur] && steps++ < grid.n) {
      set(cur, RIVER_SUPPRESS);
      const next = flowTo[cur];
      if (next < 0 || isWater[next] || !isRiver[next]) break;
      let fedByOther = false;
      for (const nb of grid.neighbors[next]) {
        if (nb !== cur && isRiver[nb] && riverEdits[nb] !== RIVER_SUPPRESS && flowTo[nb] === next) {
          fedByOther = true;
          break;
        }
      }
      if (fedByOther) break;
      cur = next;
    }
  }
  return touched;
}
