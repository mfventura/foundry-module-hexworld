/**
 * Canvas renderer: paints the world into a 2D canvas. Used by the generator
 * preview (scaled down) and by the in-scene TerrainMesh, which turns the
 * same drawing into a PIXI texture stretched to the scene dimensions.
 */

import { B, BIOME_COLORS } from "../generator/biomes.js";
import { SITE } from "../generator/sites.js";
import { SITE_GLYPHS, SITE_STYLE, DEFAULT_SITE_ICONS } from "./site-icons.js";
import { layoutLabels } from "./labels.js";

const DEEP_OCEAN = [30, 61, 96];
const SHALLOW_OCEAN = [77, 129, 174];
const RIVER_COLOR = "rgba(66, 106, 152, 0.95)";
const COAST_COLOR = "rgba(30, 45, 65, 0.8)";

/** Distinguishable, muted hues for realm ids 1..10 (cycled beyond). */
export const REALM_COLORS = [
  [201, 79, 79], [79, 125, 201], [88, 160, 90], [181, 140, 62], [139, 95, 176],
  [62, 160, 160], [201, 116, 79], [160, 86, 139], [107, 125, 62], [90, 106, 176]
];
const WILDERNESS_RGB = [178, 172, 156];

function realmRgb(id) {
  return REALM_COLORS[(id - 1) % REALM_COLORS.length];
}

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

/** Piecewise-linear color ramp over [0,1]. Stops: [t, [r,g,b]]. */
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, c0] = stops[k - 1];
      const [t1, c1] = stops[k];
      return lerpRgb(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

const HEIGHT_LAND = [
  [0, [77, 129, 96]], [0.3, [151, 169, 98]], [0.55, [196, 172, 108]],
  [0.75, [153, 110, 79]], [0.9, [190, 190, 190]], [1, [245, 245, 245]]
];
const TEMP_RAMP = [
  [0, [34, 60, 138]], [0.35, [120, 170, 220]], [0.5, [235, 235, 225]],
  [0.7, [245, 170, 80]], [1, [190, 40, 30]]
];
const MOIST_RAMP = [
  [0, [150, 110, 60]], [0.4, [200, 190, 120]], [0.7, [90, 160, 100]], [1, [30, 100, 175]]
];

/** False-color views: raw pipeline fields for inspection while editing. */
function cellColorDebug(world, c, mode) {
  const { elev, sea, temp, moist, isWater } = world;
  if (mode === "realms") {
    const id = world.realms?.[c] ?? 0;
    if (world.isOcean?.[c]) {
      const depth = Math.pow(Math.max(0, Math.min(1, (sea - elev[c]) / (sea * 0.9 || 1))), 0.7);
      const water = lerpRgb(SHALLOW_OCEAN, DEEP_OCEAN, depth);
      // Claimed water: the realm color shows through the water tone.
      if (id) return css(lerpRgb(realmRgb(id), water, 0.55), 0.9);
      return css(water, 0.85);
    }
    if (isWater[c]) {
      if (id) return css(lerpRgb(realmRgb(id), [93, 143, 191], 0.55), 0.9);
      return css([93, 143, 191]);
    }
    const base = id ? realmRgb(id) : WILDERNESS_RGB;
    const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
    return css(base, 0.9 + 0.25 * above);
  }
  if (mode === "height") {
    if (elev[c] < sea) {
      const depth = Math.max(0, Math.min(1, (sea - elev[c]) / (sea || 1)));
      return css(lerpRgb([90, 140, 190], [15, 35, 70], depth));
    }
    return css(ramp(HEIGHT_LAND, (elev[c] - sea) / (1 - sea || 1)));
  }
  if (mode === "temp") return css(ramp(TEMP_RAMP, (temp[c] + 25) / 60));
  if (mode === "moist") {
    if (isWater[c]) return css([40, 70, 110]);
    return css(ramp(MOIST_RAMP, moist[c]));
  }
  return "#000";
}

/**
 * Artwork cell: blit the pre-rasterized biome sprite (see biome-art.js), then
 * overlay the SAME depth/relief cues the flat colors carry — ocean darkens
 * with depth, land keeps hillshade + altitude lightening + per-cell jitter —
 * as a translucent black/white fill over the polygon.
 */
function drawArtCell(ctx, world, c, spr, shade) {
  const { grid, elev, sea, isOcean, isWater } = world;
  ctx.drawImage(spr.canvas, grid.cx[c] + spr.dx, grid.cy[c] + spr.dy);
  let mult;
  if (isOcean[c]) {
    const depth = Math.pow(Math.max(0, Math.min(1, (sea - elev[c]) / (sea * 0.9 || 1))), 0.7);
    mult = 1 - depth * 0.35;
  } else if (isWater[c]) {
    mult = jitter(c);
  } else {
    const above = Math.max(0, (elev[c] - sea) / (1 - sea || 1));
    mult = (0.92 + 0.18 * above) * shade * jitter(c);
  }
  if (Math.abs(mult - 1) < 0.02) return;
  tracePoly(ctx, grid.polys[c]);
  ctx.fillStyle = mult < 1
    ? `rgba(0,0,0,${Math.min(0.5, 1 - mult).toFixed(3)})`
    : `rgba(255,255,255,${Math.min(0.35, (mult - 1) * 0.8).toFixed(3)})`;
  ctx.fill();
}

/** Biome id used to pick artwork: water wins over any (latent) land biome. */
function artBiomeId(world, c) {
  if (world.isOcean[c]) return B.OCEAN;
  if (world.isLake[c]) return B.LAKE;
  return world.biome[c];
}

function drawCells(ctx, world, mode) {
  const { grid } = world;
  const shade = mode === "terrain" ? computeShade(world) : null;
  const sprites = mode === "terrain" ? world.biomeArt?.sprites : null;
  for (let c = 0; c < grid.n; c++) {
    if (sprites) {
      const spr = sprites.get(artBiomeId(world, c));
      if (spr) { drawArtCell(ctx, world, c, spr, shade[c]); continue; }
    }
    const color = mode === "terrain" ? cellColor(world, c, shade[c]) : cellColorDebug(world, c, mode);
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
 * Squared-distance slack for matching a polygon edge to the neighbor across
 * it: the shared edge lies ON the bisector, so the midpoint is equidistant
 * from both centers — exactly on square grids, but only within float error on
 * hex grids (Foundry's vertices/centers). A strict comparison sporadically
 * misclassifies real shared edges as map-border edges and drops border/coast
 * segments. The slack is far below the gap to any non-adjacent center.
 */
function edgeTieEps(grid) {
  return grid.size * grid.size * 1e-3;
}

/**
 * Realm overlay: a soft per-cell tint (terrain view only) plus border strokes
 * along polygon edges where the realm changes. Water is claimable (v0.12.2):
 * claimed water is tinted and bordered like land — only the edge between a
 * claim and UNCLAIMED cells across the coastline stays unstroked, because the
 * coastline already separates them.
 */
function drawRealms(ctx, world, mode) {
  const realms = world.realms;
  if (!realms) return;
  const { grid, isWater } = world;

  if (mode === "terrain") {
    for (let c = 0; c < grid.n; c++) {
      const id = realms[c];
      if (!id) continue;
      const [r, g, b] = realmRgb(id);
      tracePoly(ctx, grid.polys[c]);
      ctx.fillStyle = `rgba(${r},${g},${b},0.12)`;
      ctx.fill();
    }
  }

  const eps = edgeTieEps(grid);
  ctx.lineWidth = grid.size * 0.06;
  ctx.lineCap = "round";
  ctx.setLineDash([grid.size * 0.22, grid.size * 0.14]);
  for (let c = 0; c < grid.n; c++) {
    const id = realms[c];
    if (!id) continue; // every border edge draws from its higher (claimed) id side
    const flat = grid.polys[c];
    const m = flat.length;
    const [r, g, b] = realmRgb(id);
    ctx.strokeStyle = `rgba(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(b * 0.6)},0.7)`;
    ctx.beginPath();
    let any = false;
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
      const dxc = grid.cx[c] - mx, dyc = grid.cy[c] - my;
      if (best < 0 || bestD > dxc * dxc + dyc * dyc + eps) continue; // map border edge
      const other = realms[best] ?? 0;
      if (other === id) continue;
      // Draw each border edge once, from the higher realm id side.
      if (id < other) continue;
      // Land claim against unclaimed water (or the reverse): the coastline
      // already draws that separation.
      if (!other && isWater[best] !== isWater[c]) continue;
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      any = true;
    }
    if (any) ctx.stroke();
  }
  ctx.setLineDash([]);
}

/**
 * Road network: one segment between every pair of adjacent network cells.
 * Carreteras are solid, caminos dashed; a mixed segment renders as camino.
 */
function drawRoads(ctx, world) {
  const { grid, roads } = world;
  if (!roads) return;
  const size = grid.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const kind of [1, 2]) { // draw caminos first, carreteras on top
    ctx.strokeStyle = kind === 2 ? "rgba(92, 64, 39, 0.95)" : "rgba(112, 84, 56, 0.9)";
    ctx.lineWidth = size * (kind === 2 ? 0.11 : 0.07);
    ctx.setLineDash(kind === 2 ? [] : [size * 0.28, size * 0.22]);
    ctx.beginPath();
    for (let c = 0; c < grid.n; c++) {
      if (!roads[c]) continue;
      for (const nb of grid.neighbors[c]) {
        if (nb <= c || !roads[nb]) continue;
        if (Math.min(roads[c], roads[nb]) !== kind) continue;
        ctx.moveTo(grid.cx[c], grid.cy[c]);
        ctx.lineTo(grid.cx[nb], grid.cy[nb]);
      }
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/**
 * Settlement and POI markers: a round badge plus the SAME Font Awesome glyph
 * shown in the editor palette (world.siteIcons carries the configured icon
 * names; DEFAULT_SITE_ICONS is the fallback outside a Foundry client).
 */
function drawSites(ctx, world) {
  const { grid, sites } = world;
  if (!sites) return;
  const s = grid.size;
  // world.siteRender is prepared per-client (real FA family + glyphs read
  // from Foundry's CSS); the curated table is the headless fallback.
  const rc = world.siteRender ?? null;
  const family = rc?.fontFamily ?? "\"Font Awesome 6 Pro\", \"Font Awesome 6 Free\", sans-serif";
  const weight = rc?.fontWeight ?? "900";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const plain = rc?.markerStyle === "plain";
  for (let c = 0; c < grid.n; c++) {
    const t = sites[c];
    if (!t) continue;
    const style = SITE_STYLE[t];
    let glyph;
    if (t === SITE.MARKER) {
      // Free markers carry their own icon name per cell.
      const name = world.markers?.[c] ?? DEFAULT_SITE_ICONS[SITE.MARKER];
      glyph = rc?.glyphFor?.(name)
        || SITE_GLYPHS[name]?.glyph
        || SITE_GLYPHS[DEFAULT_SITE_ICONS[SITE.MARKER]]?.glyph;
    } else {
      glyph = rc?.glyphs?.[t] ?? SITE_GLYPHS[DEFAULT_SITE_ICONS[t]]?.glyph;
    }
    if (!style || !glyph) continue;
    const x = grid.cx[c], y = grid.cy[c];
    if (plain) {
      // Bare glyph with a light halo: readable on any terrain, no badge.
      const px = Math.round(s * 0.52 * style.scale);
      ctx.font = `${weight} ${px}px ${family}`;
      ctx.lineWidth = Math.max(2, s * 0.09);
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(245, 240, 225, 0.92)";
      ctx.strokeText(glyph, x, y);
      ctx.fillStyle = "#2b2118";
      ctx.fillText(glyph, x, y);
      continue;
    }
    const r = s * 0.32 * style.scale;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style.badge;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, s * 0.045);
    ctx.strokeStyle = style.ring;
    ctx.stroke();
    ctx.fillStyle = style.glyph;
    ctx.font = `${weight} ${Math.round(r * 1.1)}px ${family}`;
    ctx.fillText(glyph, x, y + r * 0.04);
  }
}

const LABEL_COLORS = {
  realm: { fill: "rgba(52, 38, 24, 0.65)", halo: "rgba(245, 240, 225, 0.55)", haloScale: 0.16 },
  city: { fill: "#241c12", halo: "rgba(245, 240, 225, 0.85)", haloScale: 0.24 },
  village: { fill: "#241c12", halo: "rgba(245, 240, 225, 0.85)", haloScale: 0.24 },
  poi: { fill: "#241c12", halo: "rgba(245, 240, 225, 0.85)", haloScale: 0.24 },
  sea: { fill: "#1d4e79", halo: "rgba(235, 242, 248, 0.8)", haloScale: 0.24 },
  lake: { fill: "#1d4e79", halo: "rgba(235, 242, 248, 0.8)", haloScale: 0.24 },
  river: { fill: "#1d4e79", halo: "rgba(235, 242, 248, 0.8)", haloScale: 0.24 }
};

/**
 * Feature labels, positioned by layoutLabels (collision avoidance + manual
 * offsets) and drawn with a light halo.
 */
function drawLabels(ctx, world) {
  if (!world.names || world.showLabels === false) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const entries = layoutLabels(world);
  // Realms first (background), then the rest in layout order.
  entries.sort((a, b) => Number(b.kind === "realm") - Number(a.kind === "realm"));
  for (const e of entries) {
    const colors = LABEL_COLORS[e.kind] ?? LABEL_COLORS.poi;
    ctx.font = e.font;
    ctx.lineWidth = Math.max(2, e.px * colors.haloScale);
    ctx.strokeStyle = colors.halo;
    ctx.fillStyle = colors.fill;
    ctx.strokeText(e.text, e.x, e.y);
    ctx.fillText(e.text, e.x, e.y);
  }
}

/**
 * Coastline: stroke every polygon edge shared between a land cell and a water
 * cell. The neighbor across an edge is found as the one whose center is
 * closest to the edge midpoint — exact enough for regular grids.
 */
function drawCoast(ctx, world) {
  const { grid, isWater } = world;
  const eps = edgeTieEps(grid);
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
      // Also compare against the cell itself: border edges have no neighbor
      // across. The shared edge lies ON the bisector, so the distances TIE
      // (exactly on square grids, within float error on hex — see edgeTieEps).
      const dxc = grid.cx[c] - mx, dyc = grid.cy[c] - my;
      if (best >= 0 && bestD <= dxc * dxc + dyc * dyc + eps && isWater[best]) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
  }
  ctx.stroke();
}

/**
 * Overlay channels the hosts can toggle client-locally (v0.12.3): key in
 * `world.show` + i18n label for the visibility switches. Labels have their
 * own longstanding flag (`world.showLabels`) and are listed here only so the
 * UIs render one homogeneous switch group. Hiding never touches data.
 */
export const OVERLAY_LAYERS = [
  { key: "labels", label: "ShowLabels" },
  { key: "realms", label: "LayerRealms" },
  { key: "sites", label: "LayerSites" },
  { key: "roads", label: "LayerRoads" },
  { key: "rivers", label: "LayerRivers" }
];

/**
 * Render the world into a canvas at the given scale.
 * @param {string} mode "terrain" (default), the political view "realms", or
 *   a false-color debug view: "height" | "temp" | "moist". Debug views keep
 *   the coastline for orientation.
 */
export function renderWorld(world, canvas, scale = 1, mode = "terrain") {
  const g = world.grid;
  canvas.width = Math.max(1, Math.ceil(g.pixelWidth * scale));
  canvas.height = Math.max(1, Math.ceil(g.pixelHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = css(DEEP_OCEAN);
  ctx.fillRect(0, 0, g.pixelWidth, g.pixelHeight);
  drawCells(ctx, world, mode);
  const overlays = mode === "terrain" || mode === "height" || mode === "realms";
  // Visibility switches (world.show, absent = everything on). The political
  // view always draws realms — they are the point of that view.
  const show = world.show ?? {};
  if (mode === "realms" || (mode === "terrain" && show.realms !== false)) drawRealms(ctx, world, mode);
  if (overlays && show.rivers !== false) drawRivers(ctx, world);
  drawCoast(ctx, world);
  if (overlays) {
    if (show.roads !== false) drawRoads(ctx, world);
    if (show.sites !== false) drawSites(ctx, world);
    drawLabels(ctx, world); // gated by its own world.showLabels flag
  }
  ctx.restore();
  return canvas;
}

/** Scale that fits the world into a preview box. */
export function previewScale(world, maxW, maxH) {
  const g = world.grid;
  return Math.min(1, maxW / g.pixelWidth, maxH / g.pixelHeight);
}
