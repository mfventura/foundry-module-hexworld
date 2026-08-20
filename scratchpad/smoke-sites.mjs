/**
 * Smoke test: settlements, POIs and roads (generation, connectivity, manual
 * routing, determinism). Square-grid mocks.
 * Run: node smoke-sites.mjs
 */
globalThis.CONST = { GRID_TYPES: { SQUARE: 1, HEXODDR: 2, HEXEVENR: 3, HEXODDQ: 4, HEXEVENQ: 5 } };
globalThis.foundry = {
  grid: {
    SquareGrid: class {
      constructor({ size }) { this.size = size; }
      getCenterPoint({ i, j }) { return { x: (j + 0.5) * this.size, y: (i + 0.5) * this.size }; }
      getVertices({ i, j }) {
        const s = this.size;
        return [
          { x: j * s, y: i * s }, { x: (j + 1) * s, y: i * s },
          { x: (j + 1) * s, y: (i + 1) * s }, { x: j * s, y: (i + 1) * s }
        ];
      }
      getAdjacentOffsets({ i, j }) {
        const out = [];
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (a || b) out.push({ i: i + a, j: j + b, k: 0 });
        return out;
      }
    },
    HexagonalGrid: class {}
  }
};

const root = "../scripts";
const { generateWorld } = await import(`${root}/generator/worldgen.js`);
const { generateSettlements, routeRoad, SITE, ROAD } = await import(`${root}/generator/sites.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const world = generateWorld(params);
const n = world.grid.n;

const { sites, roads } = generateSettlements(world, makeRng(params.seed + ":sites"), 0.5);

// --- Placement sanity.
const count = t => sites.reduce((a, v) => a + (v === t), 0);
const cities = count(SITE.CITY), villages = count(SITE.VILLAGE);
const pois = count(SITE.DUNGEON) + count(SITE.TEMPLE) + count(SITE.RUIN);
assert(cities >= 1, `cities placed (${cities})`);
assert(villages >= 2, `villages placed (${villages})`);
assert(pois >= 3, `POIs placed (${pois})`);
for (let c = 0; c < n; c++) {
  if (sites[c] && world.isWater[c]) { assert(false, `site on water at ${c}`); break; }
}
console.log("ok: no site on water");

// --- Roads exist, never cross ocean, and every city touches the network.
let roadCells = 0, roadOnOcean = 0;
for (let c = 0; c < n; c++) {
  if (!roads[c]) continue;
  roadCells++;
  if (world.isOcean[c]) roadOnOcean++;
}
assert(cities < 2 || roadCells > 0, `road network exists (${roadCells} cells)`);
assert(roadOnOcean === 0, "no road cell on ocean");
if (cities >= 2) {
  // Connectivity: flood-fill the road network (+city cells) from one city.
  const inNet = c => roads[c] || sites[c] === SITE.CITY;
  const start = sites.findIndex(v => v === SITE.CITY);
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    for (const nb of world.grid.neighbors[c]) {
      if (!seen.has(nb) && inNet(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  let disconnected = 0;
  for (let c = 0; c < n; c++) if (sites[c] === SITE.CITY && !seen.has(c)) disconnected++;
  assert(disconnected === 0, "all cities connected by carreteras");
}

// --- Villages reach the network too (path from each village).
if (roadCells) {
  let orphan = 0;
  for (let c = 0; c < n; c++) {
    if (sites[c] !== SITE.VILLAGE) continue;
    const touches = roads[c] || world.grid.neighbors[c].some(nb => roads[nb]);
    if (!touches) orphan++;
  }
  assert(orphan === 0, "every village touches a camino");
}

// --- POIs are remote: at least 4 cells from any settlement.
let tooClose = 0;
const settle = [];
for (let c = 0; c < n; c++) if (sites[c] === SITE.CITY || sites[c] === SITE.VILLAGE) settle.push(c);
for (let c = 0; c < n; c++) {
  if (![SITE.DUNGEON, SITE.TEMPLE, SITE.RUIN].includes(sites[c])) continue;
  for (const s of settle) {
    const dx = (world.grid.cx[c] - world.grid.cx[s]) / world.grid.size;
    const dy = (world.grid.cy[c] - world.grid.cy[s]) / world.grid.size;
    if (Math.sqrt(dx * dx + dy * dy) < 4) { tooClose++; break; }
  }
}
assert(tooClose === 0, "POIs are remote from settlements");

// --- Determinism.
const again = generateSettlements(generateWorld(params), makeRng(params.seed + ":sites"), 0.5);
assert(again.sites.every((v, i) => v === sites[i]) && again.roads.every((v, i) => v === roads[i]),
  "settlement generation deterministic");

// --- Manual route tool: connect two distant land cells.
let a = -1, b = -1;
for (let c = 0; c < n; c++) {
  if (world.isWater[c] || world.grid.isBorder(c)) continue;
  if (a < 0) { a = c; continue; }
  const dx = (world.grid.cx[c] - world.grid.cx[a]) / world.grid.size;
  if (Math.abs(dx) > 20) { b = c; break; }
}
if (b >= 0) {
  const manual = new Uint8Array(n);
  const undo = new Map();
  const touched = routeRoad(world, manual, undo, a, b, ROAD.ROAD);
  assert(touched >= 10, `manual route traced (${touched} cells)`);
  assert(manual[a] === ROAD.ROAD && manual[b] === ROAD.ROAD, "route reaches both endpoints");
  let ocean = 0;
  for (let c = 0; c < n; c++) if (manual[c] && world.isOcean[c]) ocean++;
  assert(ocean === 0, "manual route avoids ocean");
  for (const [c, prev] of undo) manual[c] = prev;
  assert(manual.every(v => v === 0), "route undo restores");
} else {
  console.log("skip: no distant pair found");
}

// --- Density 0 yields nothing.
const empty = generateSettlements(world, makeRng("x"), 0);
assert(empty.sites.every(v => v === 0) && empty.roads.every(v => v === 0), "density 0 generates nothing");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
