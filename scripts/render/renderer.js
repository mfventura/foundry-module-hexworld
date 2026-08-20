/**
 * Canvas renderer: paints the generated world as a polished map image.
 * The same vector drawing is used for the UI preview (scaled down) and the
 * full-resolution scene background (scaled to stay under canvas size limits —
 * Foundry stretches the background to the scene dimensions, so a downscaled
 * image still aligns with the grid).
 */

import { B, BIOME_COLORS } from "../generator/biomes.js";

const DEEP_OCEAN = [30, 61, 96];
const SHALLOW_OCEAN = [77, 129, 174];
const RIVER_COLOR = "rgba(66, 106, 152, 0.95)";
const COAST_COLOR = "rgba(30, 45, 65, 0.8)";
const MAX_IMAGE_SIDE = 13000;

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const BIOME_RGB = {};
for (const [id, hex] of Object.entries(BIOME_COLORS)) BIOME_RGB[id] = hexToRgb(hex);

function css(rgb, mult = 1) {
  const r = Math.max(0, Math.min(255, Math.round(rgb[0] * mult)));
  const g = Math.max(0, Math.min(255, Math.round(rgb[1] * mult)));
  const b = Math.max(0, Math.min(255, Math.round(rgb[2] * mult)));
  return `rgb(${r},${g},${b})`;
}

function lerpRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Deterministic per-cell jitter (±4%) for an organic, hand-tinted look. */
function jitter(idx) {
  const v = Math.sin(idx * 127.1 + 311.7) * 43758.5453;
  return 0.96 + (v - Math.floor(v)) * 0.08;
}

/** Hillshade: NW light over the elevation gradient, land cells only. */
function computeShade(world) {
  const { grid, elev, isWater } = world;
  const n = grid.n;
  const shade = new Float32Array(n).fill(1);
  const LX = -0.7071, LY = -0.7071;
  const K = 320;
  for (let c = 0; c < n; c++) {
    if (isWater[c]) continue;
    let gx = 0, gy = 0, count = 0;
    for (const nb of grid.neighbors[c]) {
      const dx = grid.cx[nb] - grid.cx[c];
      const dy = grid.cy[nb] - grid.cy[c];
      const d2 = dx * dx + dy * dy;
      if (!d2) continue;
      const de = elev[nb] - elev[c];
      gx += de * dx / d2;
      gy += de * dy / d2;
      count++;
    }
    if (count) { gx /= count; gy /= count; }
    const s = 1 + K * (gx * LX + gy * LY);
    shade[c] = Math.max(0.72, Math.min(1.28, s));
  }
  return shade;
}

function cellColor(world, c, shade) {
  const { elev, sea, isOcean, isLake, biome } = world;
  if (isOcean[c]) {
    const depth = Math.pow(Math.max(0, Math.min(1, (sea - elev[c]) / (sea * 0.9 || 1))), 0.7);
    return css(lerpRgb(SHALLOW_OCEAN, DEEP_OCEAN, depth), jitter(c) * 0.5 + 0.5);
  }
  if (isLake[c]) return css(BIOME_RGB[B.LAKE], jitter(c));
  const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
  const mult = (0.86 + 0.28 * above) * shade * jitter(c);
  return css(BIOME_RGB[biome[c]], mult);
}

function tracePoly(ctx, flat) {
  ctx.beginPath();
  ctx.moveTo(flat[0], flat[1]);
  for (let k = 2; k < flat.length; k += 2) ctx.lineTo(flat[k], flat[k + 1]);
  ctx.closePath();
}

function drawCells(ctx, world) {
  const { grid } = world;
  const shade = computeShade(world);
  for (let c = 0; c < grid.n; c++) {
    const color = cellColor(world, c, shade[c]);
    tracePoly(ctx, grid.polys[c]);
    ctx.fillStyle = color;
    // Stroke with the fill color to hide antialiasing seams between cells.
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
  }
}

function drawRivers(ctx, world) {
  const { grid, flowTo, flux, isRiver, isWater, riverThreshold } = world;
  ctx.strokeStyle = RIVER_COLOR;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const size = grid.size;
  for (let c = 0; c < grid.n; c++) {
    if (!isRiver[c]) continue;
    const t = flowTo[c];
    if (t < 0) continue;
    if (isWater[c] && isWater[t]) continue; // hidden under a lake
    const rel = Math.min(1, Math.sqrt(flux[c] / (riverThreshold * 14 || 1)));
    ctx.lineWidth = size * (0.06 + 0.12 * rel);
    ctx.beginPath();
    ctx.moveTo(grid.cx[c], grid.cy[c]);
    ctx.lineTo(grid.cx[t], grid.cy[t]);
    ctx.stroke();
  }
}

/**
 * Coastline: stroke every polygon edge shared between a land cell and a water
 * cell. The neighbor across an edge is found as the one whose center is
 * closest to the edge midpoint — exact enough for regular grids.
 */
function drawCoast(ctx, world) {
  const { grid, isWater } = world;
  ctx.strokeStyle = COAST_COLOR;
  ctx.lineWidth = grid.size * 0.045;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let c = 0; c < grid.n; c++) {
    if (isWater[c]) continue;
    let hasWaterNb = false;
    for (const nb of grid.neighbors[c]) if (isWater[nb]) { hasWaterNb = true; break; }
    if (!hasWaterNb) continue;
    const flat = grid.polys[c];
    const m = flat.length;
    for (let k = 0; k < m; k += 2) {
      const x1 = flat[k], y1 = flat[k + 1];
      const x2 = flat[(k + 2) % m], y2 = flat[(k + 3) % m];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      let best = -1, bestD = Infinity;
      for (const nb of grid.neighbors[c]) {
        const dx = grid.cx[nb] - mx, dy = grid.cy[nb] - my;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = nb; }
      }
      // Also compare against the cell itself: border edges have no neighbor across.
      const dxc = grid.cx[c] - mx, dyc = grid.cy[c] - my;
      if (best >= 0 && bestD < dxc * dxc + dyc * dyc && isWater[best]) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
  }
  ctx.stroke();
}

/**
 * Render the world into a canvas at the given scale.
 */
export function renderWorld(world, canvas, scale = 1) {
  const g = world.grid;
  canvas.width = Math.max(1, Math.ceil(g.pixelWidth * scale));
  canvas.height = Math.max(1, Math.ceil(g.pixelHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = css(DEEP_OCEAN);
  ctx.fillRect(0, 0, g.pixelWidth, g.pixelHeight);
  drawCells(ctx, world);
  drawRivers(ctx, world);
  drawCoast(ctx, world);
  ctx.restore();
  return canvas;
}

/** Scale that fits the world into a preview box. */
export function previewScale(world, maxW, maxH) {
  const g = world.grid;
  return Math.min(1, maxW / g.pixelWidth, maxH / g.pixelHeight);
}

/**
 * Full-resolution render to an image Blob (webp, png fallback), capped so the
 * canvas never exceeds browser limits.
 */
export async function renderWorldToBlob(world) {
  const g = world.grid;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(g.pixelWidth, g.pixelHeight));
  const canvas = document.createElement("canvas");
  renderWorld(world, canvas, scale);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.92));
  if (blob) return { blob, ext: "webp" };
  const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  return { blob: png, ext: "png" };
}
