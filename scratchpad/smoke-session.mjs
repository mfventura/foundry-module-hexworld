/**
 * Smoke test: the shared WorldEditSession (stroke lifecycle, undo/redo,
 * cancel revert, tool dispatch incl. routes/labels/realms, flags payload).
 * Run: node smoke-session.mjs
 */
import "./mock-foundry.mjs";

const root = "../scripts";
const { buildBase } = await import(`${root}/generator/worldgen.js`);
const { generateSettlements } = await import(`${root}/generator/sites.js`);
const { generateNames } = await import(`${root}/generator/names.js`);
const { WorldEditSession, strokeChannelFor } = await import(`${root}/edit/edit-session.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const s = new WorldEditSession();
s.setBase(buildBase(params));
const grid = s.base.grid;
const at = c => [grid.cx[c], grid.cy[c]];

// Probe cells.
let land = -1, land2 = -1;
for (let c = 0; c < grid.n; c++) {
  if (grid.isBorder(c) || s.world.isWater[c]) continue;
  if (land < 0) { land = c; continue; }
  if (Math.abs(grid.cx[c] - grid.cx[land]) > 15 * grid.size) { land2 = c; break; }
}
assert(land >= 0 && land2 >= 0, "found probe cells");

// --- Elevation stroke: paint, commit, undo, redo.
s.beginStroke("raise");
let r = s.paint("raise", ...at(land));
assert(r.changed && r.needsDerive, "raise paints and requires derive");
const end = s.endStroke();
assert(end.channel === "elev" && end.fields.includes("edits"), "elev stroke commits with edits fields");
const painted = s.edits[land];
assert(painted > 0, "delta applied");
s.derive();
assert(s.hasUndo && !s.hasRedo, "undo available after stroke");
let h = s.undo();
assert(h.channel === "elev" && s.edits[land] === 0 && s.hasRedo, "undo reverts and arms redo");
h = s.redo();
assert(h.channel === "elev" && s.edits[land] === painted, "redo restores");

// --- Cancel reverts from pre-stroke values.
s.beginStroke("lower");
s.paint("lower", ...at(land));
assert(s.edits[land] < painted, "lower changed the cell mid-stroke");
s.cancelStroke();
assert(s.edits[land] === painted, "cancel restored the pre-stroke value");

// --- Route tool: anchor status, then a traced road; anchor chains.
s.beginStroke("roadMajor");
r = s.paint("roadMajor", ...at(land));
assert(r.status === "anchor-set" && s.routeAnchor === land, "first route click sets the anchor");
r = s.paint("roadMajor", ...at(land2));
assert(r.changed && s.roads && s.roads[land] === 2 && s.roads[land2] === 2, "second click traces the road");
assert(s.routeAnchor === land2, "anchor chains to the destination");
const roadEnd = s.endStroke();
assert(roadEnd.channel === "road" && roadEnd.needsDerive === false, "road stroke is overlay-only");

// --- Realm brush claims water too (v0.12.2: maritime territory).
s.brush.realm = 1;
let wet = -1;
for (let c = 0; c < grid.n; c++) if (s.world.isWater[c]) { wet = c; break; }
s.beginStroke("realm");
s.paint("realm", ...at(wet));
assert(s.realms?.[wet] === 1, "realm paint claims water");
s.paint("realm", ...at(land));
assert(s.realms[land] === 1, "realm paint claimed land");
s.endStroke();
s.undo();
assert(s.realms[wet] === 0 && s.realms[land] === 0, "realm stroke over water undoes");
s.redo();

// --- Realm lifecycle: alloc skips used ids; delete clears history + offsets.
s.setName("k1", "Reino de Prueba");
assert(s.allocRealmId() === 2, "alloc skips ids in use");
s.labelOffsets = { k1: [10, 10] };
s.deleteRealm(1);
assert(!s.realmIdsInUse().has(1) && !s.names.k1 && !s.labelOffsets.k1, "deleteRealm clears territory, name and offset");
assert(!s.hasUndo && !s.hasRedo, "deleteRealm drops the history");

// --- Rename status and label flow.
const { sites } = generateSettlements(s.world, makeRng(params.seed + ":sites"), 0.5);
s.sites = sites;
s.attach();
s.names = generateNames(s.world, sites, null, makeRng(params.seed + ":names"));
s.attach();
const siteCell = sites.findIndex(v => v > 0);
s.beginStroke("rename");
r = s.paint("rename", ...at(siteCell));
assert(r.status === "rename" && r.key === `s${siteCell}`, `rename resolves the site key (${r.key})`);
r = s.paint("rename", ...at(land));
assert(r.status === "rename" && r.key === null, "rename over plain land yields no key");
s.endStroke();

const anchorsKey = Object.keys(s.names).find(k => k.startsWith("s"));
const cell = Number(anchorsKey.slice(1));
s.beginStroke("labelMove");
r = s.paint("labelMove", grid.cx[cell], grid.cy[cell] + grid.size * 0.5);
assert(s.dragLabel, "labelMove picks a label on first application");
r = s.paint("labelMove", grid.cx[cell] + 60, grid.cy[cell] + 90);
assert(r.changed && s.labelOffsets[s.dragLabel.key], "drag writes an offset");
const labelEnd = s.endStroke();
assert(labelEnd.channel === "labels" && labelEnd.fields.includes("labels"), "label stroke persists labels only");

// --- Flags payload shapes.
const full = s.flagsUpdate();
assert("flags.hexworld.edits" in full && "flags.hexworld.names" in full, "full payload covers channels and names");
const partial = s.flagsUpdate(["roads"]);
assert(Object.keys(partial).length === 1 && "flags.hexworld.roads" in partial, "partial payload writes only the touched channel");

// --- Reset clears everything.
s.reset();
assert(!s.edits && !s.sites && !Object.keys(s.names).length && !s.hasUndo, "reset clears all channels");
assert(strokeChannelFor("water") === "elev" && strokeChannelFor("riverAdd") === "river", "channel mapping sane");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
