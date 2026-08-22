/**
 * Smoke test: realms (cost-limited growth from capitals, wilderness, naming
 * from capital, reach monotonicity, determinism, nameKeyAt). Square mocks.
 * Run: node smoke-realms.mjs
 */
import "./mock-foundry.mjs";

const root = "../scripts";
const { generateWorld } = await import(`${root}/generator/worldgen.js`);
const { generateSettlements, SITE } = await import(`${root}/generator/sites.js`);
const { generateRealms, realmCapitals } = await import(`${root}/generator/realms.js`);
const { generateNames, computeLabelAnchors, nameKeyAt } = await import(`${root}/generator/names.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const world = generateWorld(params);
const { sites } = generateSettlements(world, makeRng(params.seed + ":sites"), 0.5);
const capitals = realmCapitals(world, sites);
assert(capitals.length >= 2, `capitals found (${capitals.length})`);

const realms = generateRealms(world, sites, 0.5);
world.sites = sites;
world.realms = realms;

// --- Capitals own their realm; ids match the capitals order.
capitals.forEach((cap, i) => {
  if (realms[cap] !== i + 1) { assert(false, `capital ${i} owns realm ${i + 1} (got ${realms[cap]})`); }
});
console.log("ok: every capital sits inside its own realm");

// --- No realm on water; wilderness exists at medium reach.
let onWater = 0, claimed = 0, land = 0;
for (let c = 0; c < world.grid.n; c++) {
  if (realms[c] && world.isWater[c]) onWater++;
  if (!world.isWater[c]) { land++; if (realms[c]) claimed++; }
}
assert(onWater === 0, "no realm claims water");
assert(claimed > 0 && claimed < land, `wilderness remains (${claimed}/${land} land claimed)`);

// --- Reach is monotonic: more reach never shrinks the claimed area.
const small = generateRealms(world, sites, 0.2);
const big = generateRealms(world, sites, 1);
const count = arr => arr.reduce((a, v) => a + (v > 0), 0);
assert(count(small) <= count(realms) && count(realms) <= count(big),
  `reach monotonic (${count(small)} <= ${count(realms)} <= ${count(big)})`);
assert(generateRealms(world, sites, 0).every(v => v === 0), "reach 0 disables realms");

// --- Names: realm named after its capital toponym.
const names = generateNames(world, sites, null, makeRng(params.seed + ":names"));
const anchors = computeLabelAnchors(world, sites);
assert(anchors.realms.length >= 1, `realm label anchors (${anchors.realms.length})`);
const first = anchors.realms[0];
const capName = names[`s${capitals[first.id - 1]}`];
assert(names[first.key] === `Reino de ${capName}`, `realm named after its capital (${names[first.key]})`);
assert(!world.isWater[first.cell] && realms[first.cell] === first.id, "realm label anchored inside the realm");

// --- nameKeyAt: realm land without site/river resolves to the realm key.
let plain = -1;
for (let c = 0; c < world.grid.n; c++) {
  if (realms[c] && !sites[c] && !world.isRiver[c] && !world.isWater[c]) { plain = c; break; }
}
assert(nameKeyAt(world, sites, plain) === `k${realms[plain]}`, "nameKeyAt on realm land");

// --- Determinism.
const again = generateRealms(generateWorld(params), sites, 0.5);
assert(again.every((v, i) => v === realms[i]), "realm generation deterministic");

// --- Maritime claims (v0.12.2): painted water counts as territory.
// Claim some border-ocean cells for realm 1 (as the brush now allows).
const oceanCells = [];
for (let c = 0; c < world.grid.n && oceanCells.length < 12; c++) {
  if (world.isOcean[c] && world.grid.isBorder(c) && !realms[c]) oceanCells.push(c);
}
assert(oceanCells.length > 0, "found open-ocean cells to claim");
for (const c of oceanCells) realms[c] = 1;
assert(nameKeyAt(world, sites, oceanCells[0]) === "k1", "nameKeyAt on claimed open ocean resolves to the realm");
let unclaimedOcean = -1;
for (let c = 0; c < world.grid.n; c++) {
  if (world.isOcean[c] && world.grid.isBorder(c) && !realms[c]) { unclaimedOcean = c; break; }
}
assert(nameKeyAt(world, sites, unclaimedOcean) === null, "unclaimed open ocean still resolves to nothing");
const anchorsWet = computeLabelAnchors(world, sites);
const r1 = anchorsWet.realms.find(r => r.id === 1);
const r1Before = anchors.realms.find(r => r.id === 1);
assert(r1 && r1.size === r1Before.size + oceanCells.length, "realm anchors count claimed water as territory");
for (const c of oceanCells) realms[c] = 0; // restore

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
