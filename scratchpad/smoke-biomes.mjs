/**
 * Smoke test: biome override channel (paint, erase, water precedence,
 * latency under water, codec roundtrip, determinism). Square-grid mocks.
 * Run: node smoke-biomes.mjs
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
const { buildBase, deriveWorld, B } = await import(`${root}/generator/worldgen.js`);
const { applyBrush, applyBiomeBrush } = await import(`${root}/generator/brush.js`);
const { encodeOverrides, decodeOverrides, NO_OVERRIDE } = await import(`${root}/lib/codec.js`);

const params = {
  seed: "smoke", template: "continents", gridType: 1,
  cols: 60, rows: 45, cellSize: 20, waterFraction: 0.4,
  climate: "temperate", moisture: 1, riverDensity: 0.5
};

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const base = buildBase(params);
const n = base.grid.n;
const before = deriveWorld(base, null, null);
const at = c => ({ x: base.grid.cx[c], y: base.grid.cy[c] });

let landCell = -1, waterCell = -1;
for (let c = 0; c < n; c++) {
  if (base.grid.isBorder(c)) continue;
  if (landCell < 0 && !before.isWater[c] && before.elev[c] > base.sea + 0.1) landCell = c;
  if (waterCell < 0 && before.isWater[c]) waterCell = c;
}
assert(landCell >= 0 && waterCell >= 0, "found probe cells");
assert(before.biome[landCell] !== B.HOT_DESERT, "probe land cell is not already hot desert");

// --- Paint hot desert on land: biome forced.
const overrides = new Uint8Array(n).fill(NO_OVERRIDE);
const touched = applyBiomeBrush(base, overrides, null, { biome: B.HOT_DESERT, radius: 2, ...at(landCell) });
assert(touched > 0, `biome brush touches cells (${touched})`);
let w = deriveWorld(base, null, overrides);
assert(w.biome[landCell] === B.HOT_DESERT, "override forces hot desert on land");

// --- Override on a water cell is ignored (water wins).
applyBiomeBrush(base, overrides, null, { biome: B.HOT_DESERT, radius: 1, ...at(waterCell) });
w = deriveWorld(base, null, overrides);
assert([B.OCEAN, B.LAKE].includes(w.biome[waterCell]), "water cell keeps water biome despite override");

// --- Eraser restores the derived biome.
const undo = new Map();
applyBiomeBrush(base, overrides, undo, { biome: NO_OVERRIDE, radius: 2, ...at(landCell) });
w = deriveWorld(base, null, overrides);
assert(w.biome[landCell] === before.biome[landCell], "eraser returns cell to derived biome");
// and the stroke undo can restore the paint:
for (const [c, prev] of undo) overrides[c] = prev;
w = deriveWorld(base, null, overrides);
assert(w.biome[landCell] === B.HOT_DESERT, "undoing the erase restores the override");

// --- Latency: sink the overridden cell, override goes dormant; dry it, it returns.
const edits = new Float32Array(n);
for (let k = 0; k < 6; k++) applyBrush(base, edits, null, { tool: "water", radius: 2, strength: 0.06, ...at(landCell) });
w = deriveWorld(base, edits, overrides);
assert(w.isWater[landCell] && [B.OCEAN, B.LAKE].includes(w.biome[landCell]), "submerged override goes dormant");
for (let k = 0; k < 8; k++) applyBrush(base, edits, null, { tool: "land", radius: 2, strength: 0.06, ...at(landCell) });
w = deriveWorld(base, edits, overrides);
assert(!w.isWater[landCell] && w.biome[landCell] === B.HOT_DESERT, "override resurfaces when land again");

// --- Codec roundtrip.
const enc = encodeOverrides(overrides);
assert(typeof enc === "string" && enc.length > 0, "overrides encode to base64");
const dec = decodeOverrides(enc, n);
assert(dec && dec.every((v, i) => v === overrides[i]), "decode(encode(x)) === x");
assert(encodeOverrides(new Uint8Array(n).fill(NO_OVERRIDE)) === null, "all-empty overrides encode to null");
assert(decodeOverrides(null, n) === null, "null decodes to null");

// --- Determinism with both channels.
const w2 = deriveWorld(buildBase(params), edits, dec);
assert(w2.biome.every((b, i) => b === w.biome[i]), "deterministic with edits + overrides");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
