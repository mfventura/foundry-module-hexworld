/**
 * Smoke test: free markers (v0.12) — session channel, per-cell icons, undo
 * latency policy, flags payload, name-generation guard and the journal-sync
 * feature collector.
 * Run: node smoke-markers.mjs
 */
import "./mock-foundry.mjs";

const root = "../scripts";
const { buildBase } = await import(`${root}/generator/worldgen.js`);
const { SITE, generateSettlements } = await import(`${root}/generator/sites.js`);
const { generateNames } = await import(`${root}/generator/names.js`);
const { collectJournalFeatures } = await import(`${root}/integration/journal-sync.js`);
const { WorldEditSession } = await import(`${root}/edit/edit-session.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke-markers", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const s = new WorldEditSession();
s.setBase(buildBase(params));
const grid = s.base.grid;
const at = c => [grid.cx[c], grid.cy[c]];

let land = -1;
for (let c = 0; c < grid.n; c++) {
  if (!grid.isBorder(c) && !s.world.isWater[c]) { land = c; break; }
}
assert(land >= 0, "found a land probe cell");

// --- Placing a marker records the icon and asks the host for a name.
s.brush.site = SITE.MARKER;
s.brush.markerIcon = "fa-skull";
s.beginStroke("site");
let r = s.paint("site", ...at(land));
assert(r.changed && r.status === "rename" && r.key === `s${land}`, "marker placement returns the rename status");
assert(s.sites[land] === SITE.MARKER && s.markers[land] === "fa-skull", "marker cell holds type 6 + its icon");
const end = s.endStroke();
assert(end.channel === "site" && end.fields.includes("markers"), "site stroke persists sites AND markers");

// --- Undo restores the u8 channel; the icon stays latent (by design).
s.undo();
assert(s.sites[land] === 0 && s.markers[land] === "fa-skull", "undo clears the site, icon stays latent");
s.redo();
assert(s.sites[land] === SITE.MARKER, "redo restores the marker");

// --- Placing a normal site elsewhere returns no rename status.
s.brush.site = SITE.VILLAGE;
let land2 = -1;
for (let c = land + 1; c < grid.n; c++) {
  if (!grid.isBorder(c) && !s.world.isWater[c] && c !== land) { land2 = c; break; }
}
s.beginStroke("site");
r = s.paint("site", ...at(land2));
assert(r.changed && !r.status, "village placement has no rename status");
s.endStroke();

// --- Flags payload: markers map present; explicit deletion when empty.
s.attach();
let update = s.flagsUpdate(["sites", "markers"]);
assert(update["flags.hexworld.markers"]?.[land] === "fa-skull", "payload carries the markers map");
const flagsRound = {
  params, sites: update["flags.hexworld.sites"], markers: update["flags.hexworld.markers"]
};
const s2 = new WorldEditSession();
s2.loadFlags(flagsRound);
assert(s2.sites[land] === SITE.MARKER && s2.markers[land] === "fa-skull", "loadFlags round-trips markers");
s2.reset();
update = s2.flagsUpdate(["markers"]);
assert("flags.hexworld.-=markers" in update, "empty markers map uses the deletion syntax");

// --- generateNames must skip markers (manual-only) without crashing.
const gen = generateSettlements(s.world, makeRng(params.seed + ":sites"), 0.5);
gen.sites[land] = SITE.MARKER; // inject the marker among procedural sites
s.sites = gen.sites;
s.roads = gen.roads;
s.attach();
const names = generateNames(s.world, s.sites, null, makeRng(params.seed + ":names"));
assert(!(`s${land}` in names), "generateNames leaves markers unnamed");
const namedSite = Object.keys(names).find(k => k.startsWith("s"));
assert(!!namedSite, "generateNames still names procedural sites");

// --- Journal collector: only NAMED features, markers included once named.
s.names = names;
s.attach();
let features = collectJournalFeatures(s.world);
assert(features.every(f => f.name), "collector only returns named features");
assert(!features.some(f => f.key === `s${land}`), "unnamed marker is not collected");
s.setName(`s${land}`, "La Guarida");
s.attach();
features = collectJournalFeatures(s.world);
const marker = features.find(f => f.key === `s${land}`);
assert(marker?.kind === "site" && marker.siteType === SITE.MARKER, "named marker is collected as a site feature");
const kinds = new Set(features.map(f => f.kind));
assert(kinds.has("site"), "collector covers sites");
const order = features.map(f => f.kind);
assert(order.indexOf("river") === -1 || order.indexOf("site") < order.indexOf("river") || order.indexOf("site") === -1,
  "sites are ordered before rivers");
