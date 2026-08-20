/**
 * Visual check: renders each template at algo 1 and algo 2 (plus algo-2
 * moisture view) as cell-per-pixel BMPs, upscaled ×6.
 * Run: node viz.mjs  → viz-<template>-a<algo>[-moist].bmp
 */
import { writeFileSync } from "node:fs";

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
const { BIOME_COLORS, B } = await import(`${root}/generator/biomes.js`);
const { TEMPLATES } = await import(`${root}/generator/heightmap.js`);

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const COLORS = Object.fromEntries(Object.entries(BIOME_COLORS).map(([k, v]) => [k, hex(v)]));

function writeBmp(path, w, h, px) { // px: [r,g,b] row-major top-down
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const data = Buffer.alloc(54 + rowSize * h);
  data.write("BM"); data.writeUInt32LE(data.length, 2); data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14); data.writeInt32LE(w, 18); data.writeInt32LE(h, 22);
  data.writeUInt16LE(1, 26); data.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px[(h - 1 - y) * w + x];
      const o = 54 + y * rowSize + x * 3;
      data[o] = b; data[o + 1] = g; data[o + 2] = r;
    }
  }
  writeFileSync(path, data);
}

const COLS = 120, ROWS = 90, SCALE = 5;

function render(world, view) {
  const { grid, elev, sea, isOcean, isLake, isRiver, moist, biome } = world;
  const px = [];
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < COLS; j++) {
    const c = i * COLS + j;
    let col;
    if (view === "moist") {
      if (isOcean[c] || isLake[c]) col = [30, 50, 80];
      else {
        const m = moist[c];
        col = [Math.round(150 - 120 * m), Math.round(110 + 20 * m), Math.round(60 + 115 * m)];
      }
    } else {
      if (isOcean[c]) {
        const d = Math.max(0, Math.min(1, (sea - elev[c]) / (sea || 1)));
        col = [Math.round(77 - 47 * d), Math.round(129 - 68 * d), Math.round(174 - 78 * d)];
      } else if (isLake[c]) col = COLORS[B.LAKE];
      else if (isRiver[c]) col = [40, 80, 140];
      else col = COLORS[biome[c]] ?? [255, 0, 255];
    }
    px.push(col);
  }
  // upscale
  const up = [];
  for (let y = 0; y < ROWS * SCALE; y++) for (let x = 0; x < COLS * SCALE; x++) {
    up.push(px[Math.floor(y / SCALE) * COLS + Math.floor(x / SCALE)]);
  }
  return up;
}

for (const tpl of Object.keys(TEMPLATES)) {
  for (const algo of [1, 2]) {
    const world = generateWorld({
      seed: "viz-" + tpl, template: tpl, gridType: 1, cols: COLS, rows: ROWS, cellSize: 10,
      waterFraction: TEMPLATES[tpl].water, climate: "planet", moisture: 1, riverDensity: 0.5, algo
    });
    writeBmp(`viz-${tpl}-a${algo}.bmp`, COLS * SCALE, ROWS * SCALE, render(world, "biome"));
    if (algo === 2) writeBmp(`viz-${tpl}-a2-moist.bmp`, COLS * SCALE, ROWS * SCALE, render(world, "moist"));
    console.log(tpl, "algo", algo, "land%", world.stats.landPct, "rivers", world.stats.riverCells);
  }
}
console.log("done");
