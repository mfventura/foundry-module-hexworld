/**
 * Smoke test: manual river editing (add path to water, remove downstream with
 * confluence stop, undo, codec, latency, determinism). Square-grid mocks.
 * Run: node smoke-rivers.mjs
 */

import "./mock-foundry.mjs";

const root = "../scripts";
const { buildBase, deriveWorld } = await import(`${root}/generator/worldgen.js`);
const { applyRiverTool, applyBrush } = await import(`${root}/generator/brush.js`);
const { RIVER_FORCE, RIVER_SUPPRESS } = await import(`${root}/generator/hydrology.js`);
const { encodeBytes, decodeBytes } = await import(`${root}/lib/codec.js`);

const params = {
  seed: "smoke", template: "continents", gridType: 1,
  cols: 60, rows: 45, cellSize: 20, waterFraction: 0.4,
  climate: "temperate", moisture: 1, riverDensity: 0.4
};

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const base = buildBase(params);
const n = base.grid.n;
let world = deriveWorld(base, null, null, null);
const at = c => ({ x: base.grid.cx[c], y: base.grid.cy[c] });

// Probe: a dry land cell without river whose drainage path to water/river is
// several cells long, so the traced river is a real line, not a coastal drip.
function chainLength(c) {
  let cur = c, steps = 0;
  while (cur >= 0 && !world.isWater[cur] && !world.isRiver[cur] && steps < 50) { steps++; cur = world.flowTo[cur]; }
  return steps;
}
let dry = -1;
for (let c = 0; c < n; c++) {
  if (base.grid.isBorder(c) || world.isWater[c] || world.isRiver[c]) continue;
  if (base.grid.neighbors[c].some(nb => world.isRiver[nb])) continue;
  if (chainLength(c) >= 5) { dry = c; break; }
}
assert(dry >= 0, "found a dry springless probe cell with a long drainage path");

// --- Add a river: forced path from the click to water/border/existing river.
const riverEdits = new Uint8Array(n);
const undo = new Map();
const touched = applyRiverTool(world, riverEdits, undo, { tool: "riverAdd", ...at(dry) });
assert(touched >= 5, `riverAdd traces a path (${touched} cells)`);
let w = deriveWorld(base, null, null, riverEdits);
assert(w.isRiver[dry], "clicked cell is now a river");
// Every forced cell is river and the path from the click reaches water/border/existing river.
let cur = dry, steps = 0, endsWell = false;
while (cur >= 0 && steps++ < n) {
  if (w.isWater[cur]) { endsWell = true; break; }
  if (!w.isRiver[cur]) break;
  const next = w.flowTo[cur];
  if (next < 0) { endsWell = true; break; } // border drain
  cur = next;
}
assert(endsWell, "new river flows downhill into water or off the map");

// --- Undo the stroke restores the pre-stroke state.
for (const [c, prev] of undo) riverEdits[c] = prev;
w = deriveWorld(base, null, null, riverEdits);
assert(!w.isRiver[dry], "undoing riverAdd removes the new river");

// --- Remove a derived river from its upper course.
world = deriveWorld(base, null, null, null);
let src = -1;
for (let c = 0; c < n; c++) {
  if (!world.isRiver[c] || world.isWater[c]) continue;
  // upper course: no river neighbor flows into it
  if (!base.grid.neighbors[c].some(nb => world.isRiver[nb] && world.flowTo[nb] === c)) { src = c; break; }
}
assert(src >= 0, "found a river source cell");
const removeEdits = new Uint8Array(n);
const removed = applyRiverTool(world, removeEdits, null, { tool: "riverRemove", ...at(src) });
assert(removed > 0, `riverRemove suppresses cells (${removed})`);
w = deriveWorld(base, null, null, removeEdits);
assert(!w.isRiver[src], "source cell is no longer a river");
let suppressed = 0;
for (let c = 0; c < n; c++) if (removeEdits[c] === RIVER_SUPPRESS) { suppressed++; assert2(w, c); }
function assert2(ww, c) { if (ww.isRiver[c]) { console.error("FAIL: suppressed cell still river", c); process.exitCode = 1; } }
assert(suppressed === removed, "all removals recorded as SUPPRESS");

// --- riverRemove on a non-river cell is a no-op.
assert(applyRiverTool(world, new Uint8Array(n), null, { tool: "riverRemove", ...at(dry) }) === 0, "remove on non-river is a no-op");
// --- riverAdd on water is a no-op.
let wet = -1;
for (let c = 0; c < n; c++) if (world.isWater[c]) { wet = c; break; }
assert(applyRiverTool(world, new Uint8Array(n), null, { tool: "riverAdd", ...at(wet) }) === 0, "add on water is a no-op");

// --- Latency: sink a forced river cell -> no river drawn there (water wins).
applyRiverTool(world, riverEdits, null, { tool: "riverAdd", ...at(dry) });
const elevEdits = new Float32Array(n);
for (let k = 0; k < 6; k++) applyBrush(base, elevEdits, null, { tool: "water", radius: 2, strength: 0.06, ...at(dry) });
w = deriveWorld(base, elevEdits, null, riverEdits);
assert(w.isWater[dry] && !w.isRiver[dry], "submerged forced river goes dormant");

// --- Codec roundtrip + determinism.
const enc = encodeBytes(riverEdits);
const dec = decodeBytes(enc, n);
assert(dec && dec.every((v, i) => v === riverEdits[i]), "river channel codec roundtrip");
assert(encodeBytes(new Uint8Array(n)) === null, "untouched river channel encodes to null");
const wAgain = deriveWorld(buildBase(params), elevEdits, null, dec);
assert(wAgain.isRiver.every((v, i) => v === w.isRiver[i]), "deterministic with river edits");
assert(w.elev.every(Number.isFinite), "no NaN");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
