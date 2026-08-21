/**
 * Smoke test: pipeline versioning (algo 1 back-compat vs algo 2 features).
 * Run: node smoke-algo2.mjs
 */
import "./mock-foundry.mjs";

const root = "../scripts";
const { buildBase, generateWorld } = await import(`${root}/generator/worldgen.js`);
const { windDirFor } = await import(`${root}/generator/climate.js`);

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok:", msg); };

const mk = (tpl, algo, extra = {}) => ({
  seed: "compat", template: tpl, gridType: 1, cols: 70, rows: 50, cellSize: 20,
  waterFraction: 0.55, climate: "planet", moisture: 1, riverDensity: 0.5,
  ...(algo == null ? {} : { algo }), ...extra
});

// --- Back-compat: missing algo === algo 1, byte-identical elevBase and sea.
const legacy = buildBase(mk("continents", null));
const a1 = buildBase(mk("continents", 1));
assert(legacy.sea === a1.sea, "missing algo defaults to algo 1 (same sea)");
assert(legacy.elevBase.every((v, i) => v === a1.elevBase[i]), "missing algo defaults to algo 1 (identical heightmap)");

// --- Algo 2 changes terrain and moisture but keeps the water budget.
const a2 = buildBase(mk("continents", 2));
assert(a2.elevBase.some((v, i) => v !== a1.elevBase[i]), "algo 2 heightmap differs from algo 1");
for (const tpl of ["continents", "pangea", "archipelago", "islands"]) {
  for (const algo of [1, 2]) {
    const w = generateWorld(mk(tpl, algo, { waterFraction: 0.55 }));
    assert(Math.abs(w.stats.landPct - 45) <= 10, `${tpl} algo ${algo}: land% sane (${w.stats.landPct})`);
    assert(w.elev.every(Number.isFinite) && w.moist.every(Number.isFinite) && w.temp.every(Number.isFinite),
      `${tpl} algo ${algo}: no NaN`);
  }
}

// --- Moisture: algo 2 differs from algo 1, stays in [0,1], sane mean on land.
const w1 = generateWorld(mk("continents", 1));
const w2 = generateWorld(mk("continents", 2));
assert(w2.moist.some((v, i) => Math.abs(v - w1.moist[i]) > 0.01), "algo 2 moisture differs (rain shadow active)");
assert(w2.moist.every(v => v >= 0 && v <= 1), "moisture in [0,1]");
let sum = 0, landN = 0;
for (let c = 0; c < w2.grid.n; c++) if (!w2.isWater[c]) { sum += w2.moist[c]; landN++; }
const mean = sum / landN;
assert(mean > 0.15 && mean < 0.75, `algo 2 land moisture mean sane (${mean.toFixed(2)})`);

// --- Wind bands are the documented toy-Earth pattern.
assert(windDirFor(0.1) === 1 && windDirFor(0.5) === -1 && windDirFor(0.9) === 1, "zonal wind bands");

// --- Determinism for algo 2.
const w2b = generateWorld(mk("continents", 2));
assert(w2b.biome.every((b, i) => b === w2.biome[i]) && w2b.moist.every((v, i) => v === w2.moist[i]),
  "algo 2 fully deterministic");

// --- Rivers still connected in algo 2 (every river cell drains or is water).
let bad = 0;
for (let c = 0; c < w2.grid.n; c++) if (w2.isRiver[c] && w2.flowTo[c] < 0 && !w2.isWater[c]) bad++;
assert(bad === 0, "algo 2 rivers keep downstream targets");

console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
