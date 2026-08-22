/**
 * Biome art: per-biome tile images drawn inside every cell instead of flat
 * colors. The default set ships in assets/biomes (one PNG per biome id); the
 * world setting "biomeArt" overrides individual paths ("" = keep the flat
 * color for that biome) and is edited via the visual config menu. Pure data +
 * lazy `game`/`document` access — safe to import from Node smoke tests, where
 * biomeArtContext() simply returns null and the renderer falls back to colors.
 */

import { BIOME_KEYS } from "../generator/biomes.js";

/** Default artwork path per biome id (the packaged placeholder set). */
export const DEFAULT_BIOME_ART = {};
for (const [id, key] of Object.entries(BIOME_KEYS)) {
  DEFAULT_BIOME_ART[id] = `modules/hexworld/assets/biomes/${key.toLowerCase()}.png`;
}

/** Resolved artwork path per biome id: setting override or default. */
export function configuredBiomeArt() {
  let overrides = {};
  try {
    overrides = game.settings.get("hexworld", "biomeArt") ?? {};
  } catch (_err) { /* setting not registered yet */ }
  const out = {};
  for (const id of Object.keys(DEFAULT_BIOME_ART)) {
    const v = overrides[id];
    out[id] = typeof v === "string" ? v : DEFAULT_BIOME_ART[id];
  }
  return out;
}

/** Client toggle: whether the terrain view uses artwork at all. */
export function biomeArtEnabled() {
  try {
    return game.settings.get("hexworld", "useBiomeArt") !== false;
  } catch (_err) {
    return typeof document !== "undefined";
  }
}

/* -------------------------------------------- */
/*  Image cache (browser only)                   */
/* -------------------------------------------- */

/** path -> {img: HTMLImageElement|null, done: boolean} (null img = failed). */
const images = new Map();
/** Repaint callbacks waiting for pending image loads. */
const pendingRepaints = new Set();

function resolveSrc(path) {
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  try {
    return foundry.utils.getRoute?.(path) ?? path;
  } catch (_err) {
    return path;
  }
}

function requestImage(path) {
  let entry = images.get(path);
  if (entry) return entry;
  entry = { img: null, done: false };
  images.set(path, entry);
  const img = new Image();
  if (/^https?:/.test(path)) img.crossOrigin = "anonymous";
  img.onload = () => { entry.img = img; entry.done = true; flushRepaints(); };
  img.onerror = () => { entry.done = true; flushRepaints(); }; // -> flat color
  img.src = resolveSrc(path);
  return entry;
}

function flushRepaints() {
  for (const e of images.values()) if (!e.done) return;
  const cbs = [...pendingRepaints];
  pendingRepaints.clear();
  for (const cb of cbs) cb();
}

/** Drop every cache (art settings changed); next context reloads/rebuilds. */
export function invalidateBiomeArt() {
  images.clear();
  pendingRepaints.clear();
  spriteCache = { key: null, sprites: null };
}

/* -------------------------------------------- */
/*  Pre-rasterized cell sprites                  */
/* -------------------------------------------- */

/**
 * All cells of a regular grid share one polygon shape, so each biome is
 * rasterized ONCE per grid size — an offscreen canvas clipped to the (slightly
 * overscanned, to hide antialiasing seams) cell shape — and then blitted per
 * cell, which keeps art repaints in the same cost range as flat fills.
 */
let spriteCache = { key: null, sprites: null };

function buildSprite(img, shape, minX, minY, w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  ctx.translate(-minX, -minY);
  ctx.beginPath();
  ctx.moveTo(shape[0], shape[1]);
  for (let k = 2; k < shape.length; k += 2) ctx.lineTo(shape[k], shape[k + 1]);
  ctx.closePath();
  ctx.clip();
  // Cover-fit the image over the shape bounds.
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, minX + (w - dw) / 2, minY + (h - dh) / 2, dw, dh);
  return { canvas, dx: minX, dy: minY };
}

function spritesFor(world, loaded, paths) {
  const grid = world.grid;
  // Cell shape relative to the cell center, overscanned ~0.8 px outward so
  // adjacent sprites overlap and no background bleeds through the seams.
  const flat = grid.polys[0];
  const ov = 1 + 1.6 / (grid.size || 1);
  const shape = new Array(flat.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < flat.length; k += 2) {
    const x = (flat[k] - grid.cx[0]) * ov;
    const y = (flat[k + 1] - grid.cy[0]) * ov;
    shape[k] = x; shape[k + 1] = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const key = `${grid.size}|${shape.map(v => v.toFixed(1)).join(",")}|` +
    Object.entries(paths).map(([id, p]) => `${id}=${p}:${loaded[id] ? 1 : 0}`).join("|");
  if (spriteCache.key === key) return spriteCache.sprites;
  const sprites = new Map();
  for (const [id, img] of Object.entries(loaded)) {
    sprites.set(Number(id), buildSprite(img, shape, minX, minY, maxX - minX, maxY - minY));
  }
  spriteCache = { key, sprites };
  return sprites;
}

/**
 * Everything the renderer needs to draw biome artwork for this world, or null
 * (headless, or nothing loaded yet). Images still loading trigger `onLoaded`
 * exactly once when the whole configured set has settled, so hosts repaint.
 */
export function biomeArtContext(world, onLoaded = null) {
  if (typeof document === "undefined" || !world?.grid) return null;
  const paths = configuredBiomeArt();
  const loaded = {};
  let pending = false;
  for (const [id, path] of Object.entries(paths)) {
    if (!path) continue;
    const entry = requestImage(path);
    if (!entry.done) pending = true;
    else if (entry.img) loaded[id] = entry.img;
  }
  if (pending && onLoaded) pendingRepaints.add(onLoaded);
  const sprites = spritesFor(world, loaded, paths);
  return sprites.size ? { sprites } : null;
}
