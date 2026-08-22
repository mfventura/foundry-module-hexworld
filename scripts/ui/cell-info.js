/**
 * Cell inspector helpers shared by the in-scene brush HUD and the generator
 * preview: resolve a world-pixel position to a cell and format its data
 * (biome, relative altitude/depth, temperature, moisture, river).
 */

import { BIOME_KEYS } from "../generator/biomes.js";

/**
 * @param {object} world result of deriveWorld()
 * @param {number} x world pixel x (grid space, origin 0,0)
 * @param {number} y world pixel y
 * @returns {number} cell index, or -1 outside the map
 */
export function cellIndexAt(world, x, y) {
  const g = world.grid;
  if (x < 0 || y < 0 || x > g.pixelWidth || y > g.pixelHeight) return -1;
  let o;
  try {
    o = g.foundryGrid.getOffset({ x, y });
  } catch (_err) {
    return -1;
  }
  if (!o || o.i < 0 || o.j < 0 || o.i >= g.rows || o.j >= g.cols) return -1;
  return g.index(o.i, o.j);
}

/** One-line human summary of a cell, localized. */
export function describeCell(world, c) {
  const L = k => game.i18n.localize(`HEXWORLD.${k}`);
  const key = BIOME_KEYS[world.biome[c]];
  const name = key ? game.i18n.localize(`HEXWORLD.Biome${key}`) : "—";
  const t = Math.round(world.temp[c]);
  const parts = [name];
  if (world.isWater[c]) {
    const depth = Math.round(100 * Math.max(0, (world.sea - world.elev[c]) / (world.sea || 1)));
    parts.push(`${L("InfoDepth")} ${depth}%`, `${t} °C`);
  } else {
    const alt = Math.round(100 * Math.max(0, (world.elev[c] - world.sea) / (1 - world.sea || 1)));
    parts.push(
      `${L("InfoAlt")} ${alt}%`,
      `${t} °C`,
      `${L("InfoMoist")} ${Math.round(world.moist[c] * 100)}%`
    );
    if (world.isRiver[c]) parts.push(L("InfoRiver"));
  }
  // Realm membership shows on land AND on claimed waters (v0.12.2).
  const realm = world.realms?.[c];
  if (realm) {
    const realmName = world.names?.[`k${realm}`];
    if (realmName) parts.push(realmName);
  }
  return parts.join(" · ");
}
