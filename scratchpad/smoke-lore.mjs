/**
 * Smoke test: procedural lore (v0.12.1) — LORE_VARIANTS coverage in BOTH lang
 * files (and no stray Lore keys), facts extraction per feature kind, seeded
 * determinism, placeholder resolution, cross-link decoration and language
 * independence of the slot/variant choices.
 * Run: node smoke-lore.mjs
 */
import "./mock-foundry.mjs";
import { readFileSync } from "node:fs";

const root = "../scripts";
const { buildBase, deriveWorld } = await import(`${root}/generator/worldgen.js`);
const { SITE, generateSettlements } = await import(`${root}/generator/sites.js`);
const { generateRealms } = await import(`${root}/generator/realms.js`);
const { generateNames } = await import(`${root}/generator/names.js`);
const { collectJournalFeatures } = await import(`${root}/integration/journal-sync.js`);
const { LORE_VARIANTS, featureFacts, composeLore } = await import(`${root}/generator/lore.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

// --- Lang files: every manifest key exists in both, and no orphan Lore keys.
const langs = {
  en: JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")),
  es: JSON.parse(readFileSync(new URL("../lang/es.json", import.meta.url), "utf8"))
};
const expected = new Set();
for (const [slot, n] of Object.entries(LORE_VARIANTS)) {
  for (let i = 1; i <= n; i++) expected.add(`HEXWORLD.Lore${slot}${i}`);
}
const FIELD_KEYS = [
  "JournalFieldType", "JournalFieldBiome", "JournalFieldClimate", "JournalFieldRealm",
  "JournalFieldNearest", "JournalFieldLength", "JournalFieldMouth", "JournalFieldExtent",
  "JournalFieldCapital", "JournalFieldTerritory", "JournalWilderness", "JournalOpenSea", "JournalCells"
].map(k => `HEXWORLD.${k}`);
for (const [code, dict] of Object.entries(langs)) {
  const missing = [...expected, ...FIELD_KEYS].filter(k => !(k in dict));
  assert(missing.length === 0, `${code}.json has every lore/field key${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const orphans = Object.keys(dict).filter(k => /^HEXWORLD\.Lore/.test(k) && !expected.has(k));
  assert(orphans.length === 0, `${code}.json has no Lore keys outside the manifest${orphans.length ? ` (${orphans.join(", ")})` : ""}`);
}

/** Node localizer over one lang dict (mimics game.i18n.format). */
const makeT = dict => (key, data) => {
  const template = dict[`HEXWORLD.${key}`];
  if (template == null) throw new Error(`missing lang key HEXWORLD.${key}`);
  return template.replace(/\{(\w+)\}/g, (_m, k) => String(data?.[k] ?? `{${k}}`));
};
const tEN = makeT(langs.en), tES = makeT(langs.es);

// --- Build a world with every channel populated.
const params = {
  seed: "smoke-lore", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const world = deriveWorld(buildBase(params), null);
const { sites, roads } = generateSettlements(world, makeRng(params.seed + ":sites"), 0.7);
world.sites = sites;
world.roads = roads;
world.realms = generateRealms(world, sites, 0.6);
// Add a free marker on some named-realm land cell so the marker path is covered.
let markerCell = -1;
for (let c = 0; c < world.grid.n; c++) {
  if (!world.isWater[c] && !sites[c] && !world.grid.isBorder(c)) { markerCell = c; break; }
}
sites[markerCell] = SITE.MARKER;
world.names = generateNames(world, sites, null, makeRng(params.seed + ":names"));
world.names[`s${markerCell}`] = "La Encrucijada";

const features = collectJournalFeatures(world);
assert(features.length > 0, `collected ${features.length} named features`);
const kinds = new Set(features.map(f => f.kind === "site" ? `site:${f.siteType}` : f.kind));
assert(kinds.has(`site:${SITE.CITY}`) && kinds.has(`site:${SITE.VILLAGE}`), "world has named cities and villages");
assert(kinds.has("river"), "world has named rivers");
assert(kinds.has("realm"), "world has named realms");
assert(features.some(f => f.siteType === SITE.MARKER), "the named marker is collected");

// --- Facts + lore for EVERY feature, in both languages.
const loreFor = (f, t, link) =>
  composeLore(featureFacts(world, f), makeRng(`${params.seed}:lore:${f.key}`), t, link);
let linked = 0;
const wrapLink = (key, name) => { linked++; return `[[${key}|${name}]]`; };
for (const f of features) {
  const facts = featureFacts(world, f);
  assert(facts.kind !== undefined && facts.name === f.name, `facts extracted for ${f.key} (${facts.kind})`);
  for (const [code, t] of [["en", tEN], ["es", tES]]) {
    const sentences = loreFor(f, t);
    if (!(sentences.length >= 2)) assert(false, `${f.key} ${code}: at least two sentences (got ${sentences.length})`);
    const leftover = sentences.filter(s => /\{\w+\}/.test(s));
    if (leftover.length) assert(false, `${f.key} ${code}: unresolved placeholders in "${leftover[0]}"`);
  }
  // Determinism: same seed, same text.
  const a = loreFor(f, tEN).join("|"), b = loreFor(f, tEN).join("|");
  if (a !== b) assert(false, `${f.key}: lore is deterministic`);
  // Language independence: same slots/variants → same sentence COUNT.
  if (loreFor(f, tEN).length !== loreFor(f, tES).length) {
    assert(false, `${f.key}: EN and ES pick the same slots`);
  }
  loreFor(f, tEN, wrapLink);
}
console.log("ok: every feature produced lore in EN and ES, deterministic, placeholders resolved");
assert(linked > 0, `link decorator was used (${linked} cross-references)`);

// --- Spot checks per kind.
const city = features.find(f => f.siteType === SITE.CITY);
const cityFacts = featureFacts(world, city);
assert(typeof cityFacts.temp === "number" && cityFacts.biomeKey, "city facts carry biome and temperature");
const cityLore = loreFor(city, tEN).join(" ");
assert(cityLore.includes(city.name), "city lore mentions the city by name");

const realm = features.find(f => f.kind === "realm");
const realmFacts = featureFacts(world, realm);
assert(realmFacts.cells > 0 && realmFacts.settlements >= 0, "realm facts carry territory counts");
if (realmFacts.capitalName) {
  assert(loreFor(realm, tEN).join(" ").includes(realmFacts.capitalName), "realm lore mentions its capital");
}

const river = features.find(f => f.kind === "river");
const riverFacts = featureFacts(world, river);
assert(riverFacts.length >= 4, `river facts carry its length (${riverFacts.length} cells)`);

const marker = features.find(f => f.siteType === SITE.MARKER);
const markerLore = loreFor(marker, tES);
assert(markerLore.length === 3, "marker lore composes near/remote + terrain + hook");

// --- A water feature (if any enclosed body got named).
const water = features.find(f => f.kind === "sea" || f.kind === "lake");
if (water) {
  const wf = featureFacts(world, water);
  assert(wf.size >= 3, `water facts carry the body size (${wf.size})`);
} else {
  console.log("note: no enclosed named water in this seed (water spot-check skipped)");
}
