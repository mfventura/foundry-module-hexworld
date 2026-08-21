/**
 * Smoke test: semantic paint brushes (water/land/mountain) on top of the
 * deterministic pipeline, with foundry.grid mocked as a square grid.
 * Run: node smoke-brush.mjs
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
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          if (di || dj) out.push({ i: i + di, j: j + dj, k: 0 });
        }
        return out;
      }
    },
    HexagonalGrid: class {}
  }
};

const root = "../scripts";
const { buildBase, deriveWorld } = await import(`${root}/generator/worldgen.js`);
const { applyBrush } = await import(`${root}/generator/brush.js`);

const params = {
  seed: "smoke", template: "continents", gridType: 1,
  cols: 60, rows: 45, cellSize: 20, waterFraction: 0.4,
  climate: "temperate", moisture: 1, riverDensity: 0.5
};

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const base = buildBase(params);
const before = deriveWorld(base, null);

// Pick a firmly-land cell (not water, decently above sea) near the map center.
let landCell = -1, waterCell = -1;
for (let c = 0; c < base.grid.n; c++) {
  if (base.grid.isBorder(c)) continue;
  if (landCell < 0 && !before.isWater[c] && before.elev[c] > base.sea + 0.1) landCell = c;
  if (waterCell < 0 && before.isWater[c]) waterCell = c;
}
assert(landCell >= 0 && waterCell >= 0, "found land and water probe cells");

// --- Water brush on land: cell must become water after enough strokes.
const edits = new Float32Array(base.grid.n);
const at = c => ({ x: base.grid.cx[c], y: base.grid.cy[c] });
for (let k = 0; k < 6; k++) {
  const touched = applyBrush(base, edits, null, { tool: "water", radius: 2, strength: 0.06, ...at(landCell) });
  if (!k) assert(touched > 0, `water brush touches cells (${touched})`);
}
let w = deriveWorld(base, edits);
assert(w.isWater[landCell], "painted cell became water");
assert(w.elev[landCell] < base.sea, `elevation below frozen sea (${w.elev[landCell].toFixed(3)} < ${base.sea.toFixed(3)})`);

// --- Land brush on water: cell must become dry land.
for (let k = 0; k < 6; k++) applyBrush(base, edits, null, { tool: "land", radius: 2, strength: 0.06, ...at(waterCell) });
w = deriveWorld(base, edits);
assert(!w.isWater[waterCell], "painted water cell became land");
assert(![14, 15].includes(w.biome[waterCell]), "lowland paint does not produce mountain/snow");

// --- Mountain brush: biome must become MOUNTAIN(14) or SNOW(15).
for (let k = 0; k < 8; k++) applyBrush(base, edits, null, { tool: "mountain", radius: 2, strength: 0.06, ...at(landCell) });
w = deriveWorld(base, edits);
assert([14, 15].includes(w.biome[landCell]), `mountain paint yields mountain/snow biome (got ${w.biome[landCell]})`);

// --- Strength 0.1+ converges in one touch at the center (blend = 1).
const edits2 = new Float32Array(base.grid.n);
applyBrush(base, edits2, null, { tool: "mountain", radius: 1, strength: 0.1, ...at(landCell) });
const w2 = deriveWorld(base, edits2);
assert([14, 15].includes(w2.biome[landCell]), "full-strength mountain converges in one touch");

// --- Edits stay within the Int8 codec range (author/client desync guard).
const editsClamp = new Float32Array(base.grid.n);
for (let k = 0; k < 60; k++) applyBrush(base, editsClamp, null, { tool: "raise", radius: 2, strength: 0.15, ...at(landCell) });
assert(editsClamp.every(v => v <= 1.27 && v >= -1.27), `edits clamped to ±1.27 (max ${Math.max(...editsClamp).toFixed(2)})`);

// --- No NaN, determinism, sea untouched.
assert(w.elev.every(Number.isFinite), "no NaN in elevation");
assert(w.sea === before.sea, "sea level stayed frozen");
const wAgain = deriveWorld(buildBase(params), edits);
assert(wAgain.biome.every((b, i) => b === w.biome[i]), "deterministic re-derive from same seed + edits");

// --- Rivers still terminate in water (flowTo of river cells valid).
let badRiver = 0;
for (let c = 0; c < w.grid.n; c++) {
  if (w.isRiver[c] && w.flowTo[c] < 0 && !w.isWater[c]) badRiver++;
}
assert(badRiver === 0, "river cells keep a downstream target or are water");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
