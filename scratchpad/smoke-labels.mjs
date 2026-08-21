/**
 * Smoke test: label layout (collision avoidance vs naive placement, manual
 * offsets honored, hit-testing, determinism). Headless measure fallback.
 * Run: node smoke-labels.mjs
 */
import "./mock-foundry.mjs";

const root = "../scripts";
const { generateWorld } = await import(`${root}/generator/worldgen.js`);
const { generateSettlements } = await import(`${root}/generator/sites.js`);
const { generateRealms } = await import(`${root}/generator/realms.js`);
const { generateNames } = await import(`${root}/generator/names.js`);
const { layoutLabels, labelAt } = await import(`${root}/render/labels.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const world = generateWorld(params);
const { sites, roads } = generateSettlements(world, makeRng(params.seed + ":sites"), 0.6);
world.sites = sites; world.roads = roads;
world.realms = generateRealms(world, sites, 0.5);
world.names = generateNames(world, sites, null, makeRng(params.seed + ":names"));

const overlap = (a, b) => {
  const w = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const h = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return w > 0 && h > 0 ? w * h : 0;
};
const overlapPairs = entries => {
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (overlap(entries[i], entries[j]) > 0) n++;
    }
  }
  return n;
};

// --- Layout produces one placed entry per named feature.
const entries = layoutLabels(world);
assert(entries.length === Object.keys(world.names).length, `every name placed (${entries.length})`);
assert(entries.every(e => Number.isFinite(e.x) && Number.isFinite(e.y) && e.w > 0 && e.h > 0), "finite boxes");

// --- Collision avoidance beats naive placement (all labels at base position).
const naive = entries.map(e => ({ x: e.bx, y: e.by, w: e.w, h: e.h }));
const naivePairs = overlapPairs(naive);
const placedPairs = overlapPairs(entries.filter(e => e.kind !== "realm"));
console.log(`   naive overlaps: ${naivePairs}, laid-out overlaps (non-realm): ${placedPairs}`);
assert(placedPairs <= naivePairs, "layout never worse than naive");
assert(naivePairs === 0 || placedPairs < naivePairs, "layout resolves overlaps when there are any");

// --- Manual offset pins the label exactly.
const target = entries.find(e => e.kind === "village") ?? entries[0];
world.labelOffsets = { [target.key]: [130, -70] };
const manual = layoutLabels(world).find(e => e.key === target.key);
assert(manual.manual && manual.x === target.bx + 130 && manual.y === target.by - 70, "manual offset honored exactly");

// --- labelAt finds the moved label at its new position, not the old one.
const hit = labelAt(world, manual.x, manual.y, world.grid.size * 1.2);
assert(hit?.key === target.key, "labelAt hits the moved label");
world.labelOffsets = {};

// --- Determinism.
const again = layoutLabels(world);
assert(again.every((e, i) => e.key === entries[i].key && e.x === entries[i].x && e.y === entries[i].y),
  "layout deterministic");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
