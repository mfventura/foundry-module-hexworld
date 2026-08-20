/**
 * Smoke test: procedural names (anchors, generation, uniqueness, renames
 * preserved, nameKeyAt, determinism). Square-grid mocks.
 * Run: node smoke-names.mjs
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
const { generateSettlements, SITE } = await import(`${root}/generator/sites.js`);
const { generateNames, computeLabelAnchors, nameKeyAt, makeNamer } = await import(`${root}/generator/names.js`);
const { makeRng } = await import(`${root}/lib/random.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const params = {
  seed: "smoke", template: "continents", gridType: 1, cols: 80, rows: 60, cellSize: 20,
  waterFraction: 0.5, climate: "temperate", moisture: 1, riverDensity: 0.5, algo: 2
};
const world = generateWorld(params);
const { sites, roads } = generateSettlements(world, makeRng(params.seed + ":sites"), 0.5);
world.sites = sites; world.roads = roads;

// --- Anchors.
const anchors = computeLabelAnchors(world, sites);
const nSites = sites.reduce((a, v) => a + (v > 0), 0);
assert(anchors.sites.length === nSites, `one anchor per site (${anchors.sites.length})`);
assert(anchors.rivers.length >= 1, `river systems found (${anchors.rivers.length})`);
for (const r of anchors.rivers) {
  if (!world.isRiver[r.cell]) { assert(false, "river label anchored on a river cell"); break; }
}
console.log("ok: river anchors sit on river cells");
for (const w of anchors.waters) {
  if (!world.isWater[w.cell]) { assert(false, "water label anchored on water"); break; }
}
console.log("ok: water anchors sit on water cells");

// --- Generation: every anchor gets a unique name; patterns applied.
const names = generateNames(world, sites, null, makeRng(params.seed + ":names"));
const total = anchors.sites.length + anchors.rivers.length + anchors.waters.length;
assert(Object.keys(names).length === total, `every feature named (${Object.keys(names).length}/${total})`);
assert(new Set(Object.values(names)).size === Object.keys(names).length, "all names unique");
assert(anchors.rivers.every(r => names[r.key].startsWith("Río ")), "river pattern applied");
const dungeonAnchor = anchors.sites.find(s => s.type === SITE.DUNGEON);
if (dungeonAnchor) assert(names[dungeonAnchor.key].startsWith("Cripta de "), "dungeon pattern applied");

// --- Renames survive regeneration of missing names.
const cityAnchor = anchors.sites.find(s => s.type === SITE.CITY);
const custom = { [cityAnchor.key]: "Villa del Usuario" };
const merged = generateNames(world, sites, custom, makeRng(params.seed + ":names"));
assert(merged[cityAnchor.key] === "Villa del Usuario", "manual rename preserved by ensure-names");
assert(Object.keys(merged).length === total, "ensure-names fills the rest");

// --- nameKeyAt agrees with the anchors.
assert(nameKeyAt(world, sites, cityAnchor.cell) === cityAnchor.key, "nameKeyAt on a site");
const riverAnchor = anchors.rivers[0];
assert(nameKeyAt(world, sites, riverAnchor.cell) === riverAnchor.key, "nameKeyAt on a river matches its system key");
let borderOcean = -1;
for (let c = 0; c < world.grid.n; c++) if (world.isOcean[c] && world.grid.isBorder(c)) { borderOcean = c; break; }
assert(nameKeyAt(world, sites, borderOcean) === null, "open ocean is not nameable");

// --- Determinism.
const again = generateNames(world, sites, null, makeRng(params.seed + ":names"));
assert(Object.keys(again).every(k => again[k] === names[k]), "name generation deterministic");

// --- Namer uniqueness under pressure.
const used = new Set();
const namer = makeNamer(makeRng("x"), used);
for (let i = 0; i < 500; i++) namer();
assert(used.size === 500, "500 generated names, all unique");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
