/**
 * Realms: political territories grown from the cities over the same terrain
 * cost field the roads use — expansion is cheap across plains and expensive
 * over mountains and water, so borders settle naturally on ridges and rivers.
 * Points-of-light style: territory is claimed only up to a cost budget
 * (the "reach" slider); everything beyond stays wilderness (realm 0).
 *
 * Like sites/roads, realms are baked into an editable per-cell byte channel
 * (`flags.hexworld.realms`), never re-derived. Realm ids are 1..nCities in
 * ascending capital-cell order; realm names live in the names map under
 * `k<id>`, so ids stay meaningful as long as the channel does.
 */

import { SITE, buildCostField, dijkstra } from "./sites.js";

/** Capital cells (cities) in ascending order — realm id = index + 1. */
export function realmCapitals(world, sites) {
  const capitals = [];
  if (sites) {
    for (let c = 0; c < world.grid.n; c++) {
      if (sites[c] === SITE.CITY) capitals.push(c);
    }
  }
  return capitals;
}

/**
 * @param {object} world derived world
 * @param {Uint8Array|null} sites settlement channel (cities become capitals)
 * @param {number} reach 0..1 slider — 0 disables realms entirely
 * @returns {Uint8Array} realm id per cell (0 = wilderness/water)
 */
export function generateRealms(world, sites, reach) {
  const n = world.grid.n;
  const realms = new Uint8Array(n);
  if (!reach || reach <= 0) return realms;
  const capitals = realmCapitals(world, sites);
  if (!capitals.length) return realms;

  const cost = buildCostField(world);
  const maxCost = 6 + reach * 44; // cost budget: ~6-50 plains-cells of radius
  const bestDist = new Float32Array(n).fill(Infinity);

  capitals.forEach((capital, i) => {
    const { dist } = dijkstra(world, cost, [capital]);
    const id = i + 1;
    for (let c = 0; c < n; c++) {
      if (world.isWater[c]) continue;
      if (dist[c] <= maxCost && dist[c] < bestDist[c]) {
        bestDist[c] = dist[c];
        realms[c] = id;
      }
    }
  });
  return realms;
}
