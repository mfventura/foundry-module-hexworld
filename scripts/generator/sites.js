/**
 * Settlements, points of interest and road network.
 *
 * Unlike terrain fields these are NOT re-derived on every stroke: generation
 * runs once (seeded from `seed + ":sites"`), bakes the result into two
 * per-cell byte channels — `sites` and `roads` — and from then on they are
 * plain editable data, so terrain edits never teleport a city.
 *
 * Roads are least-cost paths over the terrain (flat lowland is cheap, slopes,
 * mountains and wetlands expensive, lakes nearly impassable, ocean forbidden):
 * carreteras (solid) connect cities, caminos (dashed) connect villages to the
 * nearest road. The same cost field powers the manual two-click route tool.
 */

export const SITE = { NONE: 0, VILLAGE: 1, CITY: 2, DUNGEON: 3, TEMPLE: 4, RUIN: 5 };
export const ROAD = { NONE: 0, PATH: 1, ROAD: 2 };

import { B } from "./biomes.js";
import { MinHeap } from "../lib/heap.js";

/* -------------------------------------------- */
/*  Cost field and pathfinding                   */
/* -------------------------------------------- */

/** Per-cell traversal cost for roads; Infinity = impassable (ocean). */
export function buildCostField(world) {
  const { grid, elev, sea, isOcean, isLake, isRiver, biome } = world;
  const cost = new Float32Array(grid.n);
  for (let c = 0; c < grid.n; c++) {
    if (isOcean[c]) { cost[c] = Infinity; continue; }
    if (isLake[c]) { cost[c] = 30; continue; }
    const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
    let v = 1 + above * 3;
    if (isRiver[c]) v += 4; // bridges are expensive
    const b = biome[c];
    if (b === B.MOUNTAIN || b === B.SNOW) v += 6;
    else if (b === B.GLACIER) v += 9;
    else if (b === B.WETLAND) v += 4;
    else if (b === B.TAIGA || b === B.DECIDUOUS || b === B.TROP_RAIN || b === B.TEMP_RAIN) v += 0.8;
    cost[c] = v;
  }
  return cost;
}

/** Edge cost between adjacent cells: mean cell cost + slope penalty. */
function edgeCost(world, cost, a, b) {
  const grid = world.grid;
  const dx = grid.cx[a] - grid.cx[b], dy = grid.cy[a] - grid.cy[b];
  const dist = Math.sqrt(dx * dx + dy * dy) / grid.size;
  const slope = Math.abs(world.elev[a] - world.elev[b]);
  return dist * ((cost[a] + cost[b]) / 2 + slope * 60);
}

/**
 * Multi-source Dijkstra over the cost field.
 * @param {Set<number>|number[]} sources
 * @param {number|null} target stop early when settled (single-target mode)
 * @returns {{dist: Float32Array, prev: Int32Array}}
 */
export function dijkstra(world, cost, sources, target = null) {
  const n = world.grid.n;
  const dist = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  for (const s of sources) {
    if (!Number.isFinite(cost[s])) continue;
    dist[s] = 0;
    heap.push(0, s);
  }
  while (heap.size) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    if (c === target) break;
    for (const nb of world.grid.neighbors[c]) {
      if (done[nb] || !Number.isFinite(cost[nb])) continue;
      const d = dist[c] + edgeCost(world, cost, c, nb);
      if (d < dist[nb]) {
        dist[nb] = d;
        prev[nb] = c;
        heap.push(d, nb);
      }
    }
  }
  return { dist, prev };
}

/** Walk predecessors from `to` back to a source. @returns {number[]} path cells */
function walkBack(prev, to) {
  const path = [];
  for (let c = to; c >= 0; c = prev[c]) path.push(c);
  return path;
}

/**
 * Manual route tool: least-cost path between two cells, baked into `roads`.
 * @param {Uint8Array} roads mutated
 * @param {Map<number, number>|null} strokeUndo pre-stroke road value per cell
 * @param {number} kind ROAD.PATH or ROAD.ROAD
 * @returns {number} cells touched (0 = unreachable)
 */
export function routeRoad(world, roads, strokeUndo, from, to, kind) {
  const cost = buildCostField(world);
  if (!Number.isFinite(cost[from]) || !Number.isFinite(cost[to])) return 0;
  const { dist, prev } = dijkstra(world, cost, [from], to);
  if (!Number.isFinite(dist[to])) return 0;
  let touched = 0;
  for (const c of walkBack(prev, to)) {
    if (strokeUndo && !strokeUndo.has(c)) strokeUndo.set(c, roads[c]);
    roads[c] = Math.max(roads[c], kind);
    touched++;
  }
  return touched;
}

/* -------------------------------------------- */
/*  Procedural generation                        */
/* -------------------------------------------- */

/** Habitability score for settlements (higher = better); -Infinity on water. */
function habitability(world, c) {
  const { grid, elev, sea, temp, moist, isWater, isOcean, isLake, isRiver, biome } = world;
  if (isWater[c]) return -Infinity;
  const b = biome[c];
  if (b === B.GLACIER || b === B.SNOW || b === B.MOUNTAIN) return -Infinity;
  const above = (elev[c] - sea) / (1 - sea || 1);
  let s = 1 - above * 1.6;
  s -= Math.abs(temp[c] - 15) / 28;
  s -= Math.abs(moist[c] - 0.55) * 0.8;
  if (b === B.HOT_DESERT || b === B.COLD_DESERT) s -= 0.5;
  if (b === B.WETLAND) s -= 0.4;
  let river = isRiver[c], coast = false, lake = false;
  for (const nb of grid.neighbors[c]) {
    if (isOcean[nb]) coast = true;
    if (isLake[nb]) lake = true;
    if (isRiver[nb]) river = true;
  }
  if (river) s += 0.5;
  if (coast) s += 0.45;
  if (lake) s += 0.25;
  return s;
}

/** Greedy top-score placement with minimum spacing (in cells). */
function placeByScore(world, scores, count, minDistCells, forbidden) {
  const grid = world.grid;
  const order = [];
  for (let c = 0; c < grid.n; c++) if (Number.isFinite(scores[c])) order.push(c);
  order.sort((a, b) => scores[b] - scores[a]);
  const chosen = [];
  const minPx2 = (minDistCells * grid.size) ** 2;
  for (const c of order) {
    if (chosen.length >= count) break;
    if (forbidden?.has(c)) continue;
    let ok = true;
    for (const o of chosen) {
      const dx = grid.cx[c] - grid.cx[o], dy = grid.cy[c] - grid.cy[o];
      if (dx * dx + dy * dy < minPx2) { ok = false; break; }
    }
    if (ok) chosen.push(c);
  }
  return chosen;
}

/** BFS distance (in cells) from a set of seeds over land. */
function bfsDistance(world, seeds, cap = 30) {
  const n = world.grid.n;
  const dist = new Int16Array(n).fill(cap);
  const queue = [];
  for (const s of seeds) { dist[s] = 0; queue.push(s); }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    const d = dist[c] + 1;
    if (d >= cap) continue;
    for (const nb of world.grid.neighbors[c]) {
      if (d < dist[nb]) { dist[nb] = d; queue.push(nb); }
    }
  }
  return dist;
}

/**
 * Generate settlements, POIs and the road network for a derived world.
 * Deterministic given the rng; density in [0,1] (0 = nothing).
 * @returns {{sites: Uint8Array, roads: Uint8Array}}
 */
export function generateSettlements(world, rng, density) {
  const grid = world.grid;
  const n = grid.n;
  const sites = new Uint8Array(n);
  const roads = new Uint8Array(n);
  if (!density || density <= 0) return { sites, roads };

  let land = 0;
  for (let c = 0; c < n; c++) if (!world.isWater[c]) land++;
  if (!land) return { sites, roads };

  // Jittered habitability so equal seeds with different :sites streams vary.
  const scores = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const h = habitability(world, c);
    scores[c] = Number.isFinite(h) ? h + rng() * 0.25 : -Infinity;
  }

  const nCities = Math.min(10, Math.max(1, Math.round((land * density) / 400)));
  const nVillages = Math.min(40, Math.max(2, Math.round((land * density) / 110)));
  const cities = placeByScore(world, scores, nCities, 9, null);
  const taken = new Set(cities);
  const villages = placeByScore(world, scores, nVillages, 4, taken).filter(c => !taken.has(c));
  for (const c of cities) sites[c] = SITE.CITY;
  for (const c of villages) { sites[c] = SITE.VILLAGE; taken.add(c); }

  // --- Roads: carreteras chain the cities (each joins the connected network).
  const cost = buildCostField(world);
  if (cities.length > 1) {
    const connected = new Set([cities[0]]);
    for (let i = 1; i < cities.length; i++) {
      const { dist, prev } = dijkstra(world, cost, connected, cities[i]);
      if (Number.isFinite(dist[cities[i]])) {
        for (const c of walkBack(prev, cities[i])) roads[c] = ROAD.ROAD;
      }
      connected.add(cities[i]);
    }
  }

  // --- Caminos: one multi-source Dijkstra from the existing network (or the
  // cities), then each village walks its predecessors until it merges.
  const anchors = new Set(cities);
  for (let c = 0; c < n; c++) if (roads[c]) anchors.add(c);
  if (anchors.size && villages.length) {
    const { dist, prev } = dijkstra(world, cost, anchors);
    for (const v of villages) {
      if (!Number.isFinite(dist[v])) continue;
      for (const c of walkBack(prev, v)) {
        if (roads[c] === ROAD.NONE) roads[c] = ROAD.PATH;
      }
    }
  }

  // --- POIs in the wilderness: far from any settlement, flavored by terrain.
  const remote = bfsDistance(world, [...cities, ...villages]);
  const poiScore = new Float32Array(n).fill(-Infinity);
  for (let c = 0; c < n; c++) {
    if (world.isWater[c] || remote[c] < 5) continue;
    poiScore[c] = remote[c] / 10 + rng() * 0.6;
  }
  const mountainous = c => [B.MOUNTAIN, B.SNOW].includes(world.biome[c]);
  const nDungeons = Math.max(1, Math.round((land * density) / 300));
  const nTemples = Math.max(1, Math.round((land * density) / 450));
  const nRuins = Math.max(1, Math.round((land * density) / 450));

  const dungeonScore = Float32Array.from(poiScore, (v, c) => v + (mountainous(c) ? 0.8 : 0));
  for (const c of placeByScore(world, dungeonScore, nDungeons, 5, taken)) { sites[c] = SITE.DUNGEON; taken.add(c); }
  for (const c of placeByScore(world, poiScore, nTemples, 6, taken)) { sites[c] = SITE.TEMPLE; taken.add(c); }
  for (const c of placeByScore(world, poiScore, nRuins, 5, taken)) { sites[c] = SITE.RUIN; taken.add(c); }

  return { sites, roads };
}
