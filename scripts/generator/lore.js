/**
 * Procedural lore (v0.12.1): structured facts plus template-driven prose for
 * the journal pages. Grammar safety across languages comes from keeping every
 * sentence WHOLE in the lang files (`HEXWORLD.Lore*` keys with placeholders);
 * the procedure only decides which slots apply (from the facts) and which
 * variant fills each slot (seeded per feature, so texts are stable across
 * re-syncs and clients — the language changes the words, never the choice).
 *
 * Pure and Node-safe: localization is injected as `t(key, data)` and
 * cross-page links as `link(key, name)`, so the browser passes game.i18n and
 * an @UUID decorator while the smoke tests pass the raw lang JSON.
 */

import { BIOME_KEYS } from "./biomes.js";
import { SITE } from "./sites.js";
import { riverMouth, nameKeyAt } from "./names.js";

/**
 * Variant count per sentence slot. Every `Lore<Slot><1..n>` key MUST exist in
 * every lang file — smoke-lore.mjs verifies both directions against this
 * manifest. Adding variety is lang-file-only work: add the keys, bump the
 * count here.
 */
export const LORE_VARIANTS = {
  CityOpen: 3,
  VillageOpen: 3,
  SettleCoast: 2,
  SettleRiver: 2,
  SettleLake: 2,
  SettleInland: 2,
  SettleRealm: 2,
  SettleWild: 2,
  SettleHook: 3,
  PoiNear: 2,
  PoiRemote: 2,
  PoiTerrain: 2,
  HookDungeon: 3,
  HookTemple: 3,
  HookRuin: 3,
  HookMarker: 2,
  RiverCourse: 2,
  RiverMouthSea: 1,
  RiverMouthLake: 1,
  RiverMouthGeneric: 1,
  RiverTowns: 1,
  RiverEmpty: 1,
  SeaOpen: 2,
  LakeOpen: 2,
  WaterShore: 1,
  WaterWild: 1,
  RealmOpen: 2,
  RealmLand: 2,
  RealmNeighbors: 1,
  RealmAlone: 1
};

const SITE_LORE_KIND = {
  [SITE.VILLAGE]: "village",
  [SITE.CITY]: "city",
  [SITE.DUNGEON]: "dungeon",
  [SITE.TEMPLE]: "temple",
  [SITE.RUIN]: "ruin",
  [SITE.MARKER]: "marker"
};

const SETTLEMENTS = [SITE.CITY, SITE.VILLAGE];

/** Nearest NAMED settlement by BFS steps from `from` (crossing water). */
function nearestNamedSettlement(world, from, maxSteps = 8) {
  const { grid } = world;
  const sites = world.sites, names = world.names ?? {};
  if (!sites) return null;
  const dist = new Map([[from, 0]]);
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q], d = dist.get(c);
    if (d >= maxSteps) continue;
    for (const nb of grid.neighbors[c]) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      if (SETTLEMENTS.includes(sites[nb]) && names[`s${nb}`]) {
        return { key: `s${nb}`, name: names[`s${nb}`], steps: d + 1 };
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Named settlements on/adjacent to a set of cells, deduped, at most `max`. */
function namedSettlementsAround(world, cells, max = 4) {
  const sites = world.sites, names = world.names ?? {};
  if (!sites) return [];
  const out = [], seen = new Set();
  const consider = c => {
    if (seen.has(c)) return;
    seen.add(c);
    if (SETTLEMENTS.includes(sites[c]) && names[`s${c}`]) out.push({ key: `s${c}`, name: names[`s${c}`] });
  };
  for (const c of cells) {
    consider(c);
    for (const nb of world.grid.neighbors[c]) consider(nb);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function siteFacts(world, f) {
  const { grid, isOcean, isLake, isRiver } = world;
  const names = world.names ?? {};
  const c = f.cell;
  const facts = {
    kind: SITE_LORE_KIND[f.siteType] ?? "marker",
    name: f.name,
    cell: c,
    biomeKey: BIOME_KEYS[world.biome[c]] ?? null,
    temp: Math.round(world.temp[c]),
    coastal: false,
    lakeside: false,
    riverKey: null,
    riverName: null,
    realmKey: null,
    realmName: null,
    nearest: null
  };
  let riverCell = isRiver[c] ? c : -1;
  for (const nb of grid.neighbors[c]) {
    if (isOcean[nb]) facts.coastal = true;
    if (isLake[nb]) facts.lakeside = true;
    if (riverCell < 0 && isRiver[nb]) riverCell = nb;
  }
  if (riverCell >= 0) {
    const key = `r${riverMouth(world, riverCell)}`;
    if (names[key]) { facts.riverKey = key; facts.riverName = names[key]; }
  }
  const realmId = world.realms?.[c];
  if (realmId && names[`k${realmId}`]) {
    facts.realmKey = `k${realmId}`;
    facts.realmName = names[`k${realmId}`];
  }
  facts.nearest = nearestNamedSettlement(world, c);
  return facts;
}

function riverFacts(world, f) {
  const { grid, isRiver, isWater, isOcean, flowTo } = world;
  const names = world.names ?? {};
  const mouth = Number(f.key.slice(1));
  const cells = [];
  for (let c = 0; c < grid.n; c++) {
    if (isRiver[c] && riverMouth(world, c) === mouth) cells.push(c);
  }
  const facts = {
    kind: "river", name: f.name, cell: f.cell, length: cells.length,
    mouthKind: "open", mouthKey: null, mouthName: null,
    towns: namedSettlementsAround(world, cells)
  };
  const dest = flowTo[mouth];
  if (dest >= 0 && isWater[dest]) {
    const key = nameKeyAt(world, null, dest);
    if (key && names[key]) {
      facts.mouthKey = key;
      facts.mouthName = names[key];
      facts.mouthKind = isOcean[dest] ? "sea" : "lake";
    }
  }
  return facts;
}

function waterFacts(world, f) {
  const { grid, isWater } = world;
  const seen = new Set([f.cell]);
  const body = [f.cell];
  for (let q = 0; q < body.length; q++) {
    for (const nb of grid.neighbors[body[q]]) {
      if (!seen.has(nb) && isWater[nb]) { seen.add(nb); body.push(nb); }
    }
  }
  return {
    kind: f.kind, name: f.name, cell: f.cell, size: body.length,
    towns: namedSettlementsAround(world, body)
  };
}

function realmFacts(world, f) {
  const { grid, isWater } = world;
  const names = world.names ?? {};
  const sites = world.sites, realms = world.realms;
  const id = Number(f.key.slice(1));
  let cells = 0, settlements = 0, capital = -1;
  const biomeCount = new Map();
  const neighborIds = new Set();
  for (let c = 0; c < grid.n; c++) {
    if (realms?.[c] !== id) continue;
    cells++; // claimed water counts as territory (v0.12.2)
    for (const nb of grid.neighbors[c]) {
      const other = realms[nb];
      if (other && other !== id) neighborIds.add(other);
    }
    if (isWater[c]) continue; // biome character and settlements are land facts
    biomeCount.set(world.biome[c], (biomeCount.get(world.biome[c]) ?? 0) + 1);
    const t = sites?.[c];
    if (t === SITE.CITY || t === SITE.VILLAGE) settlements++;
    if (t === SITE.CITY && capital < 0) capital = c;
  }
  let biomeKey = null, best = -1;
  for (const [b, n] of biomeCount) {
    if (n > best) { best = n; biomeKey = BIOME_KEYS[b] ?? null; }
  }
  const neighbors = [...neighborIds].sort((a, b) => a - b)
    .filter(n => names[`k${n}`])
    .map(n => ({ key: `k${n}`, name: names[`k${n}`] }));
  return {
    kind: "realm", name: f.name, cell: f.cell,
    cells, settlements, biomeKey,
    capitalKey: capital >= 0 && names[`s${capital}`] ? `s${capital}` : null,
    capitalName: capital >= 0 ? (names[`s${capital}`] ?? null) : null,
    neighbors
  };
}

/**
 * Structured facts for one journal feature (from collectJournalFeatures).
 * Pure; reads only the derived world plus the attached channels/names.
 */
export function featureFacts(world, feature) {
  switch (feature.kind) {
    case "site": return siteFacts(world, feature);
    case "river": return riverFacts(world, feature);
    case "sea":
    case "lake": return waterFacts(world, feature);
    case "realm": return realmFacts(world, feature);
    default: return { kind: feature.kind, name: feature.name, cell: feature.cell };
  }
}

const POI_HOOK_SLOT = {
  dungeon: "HookDungeon",
  temple: "HookTemple",
  ruin: "HookRuin",
  marker: "HookMarker"
};

/**
 * Compose the descriptive paragraphs for a feature: an array of localized
 * sentences. Deterministic given the rng (seed it per feature key); the slot
 * sequence depends only on the facts, so every language consumes the same
 * random stream and tells the same story.
 * @param {object} facts result of featureFacts()
 * @param {() => number} rng seeded PRNG
 * @param {(key: string, data?: object) => string} t localizer (keys WITHOUT the HEXWORLD. prefix)
 * @param {(key: string, name: string) => string} link cross-reference decorator
 */
export function composeLore(facts, rng, t, link = (_k, n) => n) {
  const pick = slot => `Lore${slot}${1 + Math.floor(rng() * LORE_VARIANTS[slot])}`;
  const out = [];
  const add = (slot, data) => out.push(t(pick(slot), data));
  const lower = s => (s ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s);
  const biome = facts.biomeKey ? lower(t(`Biome${facts.biomeKey}`)) : "";

  switch (facts.kind) {
    case "city":
    case "village": {
      add(facts.kind === "city" ? "CityOpen" : "VillageOpen", { name: facts.name });
      if (facts.riverName) add("SettleRiver", { river: link(facts.riverKey, facts.riverName) });
      else if (facts.coastal) add("SettleCoast");
      else if (facts.lakeside) add("SettleLake");
      else add("SettleInland", { biome });
      if (facts.realmName) add("SettleRealm", { realm: link(facts.realmKey, facts.realmName) });
      else add("SettleWild");
      add("SettleHook");
      break;
    }
    case "dungeon":
    case "temple":
    case "ruin":
    case "marker": {
      if (facts.nearest) add("PoiNear", { nearest: link(facts.nearest.key, facts.nearest.name) });
      else add("PoiRemote");
      add("PoiTerrain", { biome });
      add(POI_HOOK_SLOT[facts.kind]);
      break;
    }
    case "river": {
      add("RiverCourse", { name: facts.name });
      if (facts.mouthName) {
        add(facts.mouthKind === "sea" ? "RiverMouthSea" : "RiverMouthLake",
          { mouth: link(facts.mouthKey, facts.mouthName) });
      } else {
        add("RiverMouthGeneric");
      }
      if (facts.towns.length) add("RiverTowns", { towns: facts.towns.map(s => link(s.key, s.name)).join(", ") });
      else add("RiverEmpty");
      break;
    }
    case "sea":
    case "lake": {
      add(facts.kind === "sea" ? "SeaOpen" : "LakeOpen");
      if (facts.towns.length) add("WaterShore", { towns: facts.towns.map(s => link(s.key, s.name)).join(", ") });
      else add("WaterWild");
      break;
    }
    case "realm": {
      if (facts.capitalName) add("RealmOpen", { capital: link(facts.capitalKey, facts.capitalName) });
      add("RealmLand", { biome });
      if (facts.neighbors.length) add("RealmNeighbors", { neighbors: facts.neighbors.map(n => link(n.key, n.name)).join(", ") });
      else add("RealmAlone");
      break;
    }
  }
  return out;
}
