/**
 * Label layout with collision avoidance. Single source of truth for where
 * every label is drawn: the renderer paints from this layout and the
 * label-move tool hit-tests against it.
 *
 * Each label starts at its base position (from computeLabelAnchors; site
 * labels sit under their marker). A manual offset (world.labelOffsets, key →
 * [dx, dy] in grid pixels, persisted in flags.hexworld.labels) pins a label
 * exactly. Automatic labels try a small set of candidate positions and take
 * the first free one — site markers and already-placed labels count as
 * obstacles — falling back to the least-overlapping candidate.
 */

import { computeLabelAnchors } from "../generator/names.js";
import { SITE_STYLE } from "./site-icons.js";

export const LABEL_STYLES = {
  realm: { px: s => s * 0.8, font: px => `bold ${px}px "Signika", serif`, rank: 1, fixed: true },
  city: { px: s => s * 0.4, font: px => `bold ${px}px "Signika", sans-serif`, rank: 2 },
  village: { px: s => s * 0.32, font: px => `${px}px "Signika", sans-serif`, rank: 3 },
  poi: { px: s => s * 0.28, font: px => `${px}px "Signika", sans-serif`, rank: 4 },
  sea: { px: s => s * 0.42, font: px => `italic ${px}px "Signika", serif`, rank: 5 },
  lake: { px: s => s * 0.32, font: px => `italic ${px}px "Signika", serif`, rank: 5 },
  river: { px: s => s * 0.32, font: px => `italic ${px}px "Signika", serif`, rank: 6 }
};

let measureCanvas = null;

/** Text width via a shared offscreen canvas; character estimate headless. */
function defaultMeasure(text, font) {
  try {
    measureCanvas ??= document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    ctx.font = font;
    return ctx.measureText(text).width;
  } catch (_err) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
    return text.length * px * 0.55;
  }
}

const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const h = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * @returns {Array<{key, kind, text, font, px, x, y, w, h, bx, by, manual}>}
 *   (x, y) is the text center (draw with textAlign center / baseline middle);
 *   (bx, by) is the base position manual offsets are relative to.
 */
export function layoutLabels(world, measure = defaultMeasure) {
  const names = world.names;
  if (!names) return [];
  const s = world.grid.size;
  const anchors = computeLabelAnchors(world, world.sites ?? null);
  const offsets = world.labelOffsets ?? {};

  const entries = [];
  const add = (key, kind, cx, cy, siteType = 0) => {
    const text = names[key];
    if (!text) return;
    const style = LABEL_STYLES[kind];
    const px = Math.max(8, Math.round(style.px(s)));
    const font = style.font(px);
    const w = measure(text, font) + px * 0.3;
    const h = px * 1.25;
    // Site labels sit under their marker by default.
    const by = siteType ? cy + s * 0.42 + h / 2 : cy;
    const off = offsets[key];
    entries.push({
      key, kind, text, font, px, w, h, bx: cx, by,
      manual: Array.isArray(off) && off.length === 2,
      dx: off?.[0] ?? 0, dy: off?.[1] ?? 0,
      rank: style.rank, fixed: !!style.fixed,
      markerY: cy
    });
  };

  const grid = world.grid;
  for (const a of anchors.realms) add(a.key, "realm", grid.cx[a.cell], grid.cy[a.cell]);
  for (const a of anchors.sites) {
    const kind = a.type === 2 ? "city" : (a.type === 1 ? "village" : "poi");
    add(a.key, kind, grid.cx[a.cell], grid.cy[a.cell], a.type);
  }
  for (const a of anchors.rivers) add(a.key, "river", grid.cx[a.cell], grid.cy[a.cell]);
  for (const a of anchors.waters) add(a.key, a.isSea ? "sea" : "lake", grid.cx[a.cell], grid.cy[a.cell]);

  // Obstacles: every site marker badge.
  const placed = [];
  if (world.sites) {
    for (let c = 0; c < grid.n; c++) {
      const t = world.sites[c];
      if (!t) continue;
      const r = s * 0.34 * (SITE_STYLE[t]?.scale ?? 1);
      placed.push({ x: grid.cx[c], y: grid.cy[c], w: r * 2, h: r * 2 });
    }
  }

  // Manual labels are pinned first, then automatics by cartographic rank.
  entries.sort((a, b) => (Number(b.manual) - Number(a.manual)) || (a.rank - b.rank));

  for (const e of entries) {
    let x = e.bx + e.dx, y = e.by + e.dy;
    if (!e.manual && !e.fixed) {
      const cands = e.markerY !== e.by
        ? [ // site label: below (default), above the marker, right, left, further below
            [0, 0],
            [0, -(s * 0.84 + e.h)],
            [s * 0.45 + e.w / 2, -(s * 0.42 + e.h / 2)],
            [-(s * 0.45 + e.w / 2), -(s * 0.42 + e.h / 2)],
            [0, e.h * 1.05]
          ]
        : [ // free-floating label: center, up, down, right, left
            [0, 0],
            [0, -(e.h + s * 0.2)],
            [0, e.h + s * 0.2],
            [(e.w + s) / 2, 0],
            [-((e.w + s) / 2), 0]
          ];
      let best = null, bestOverlap = Infinity;
      for (const [dx, dy] of cands) {
        const box = { x: e.bx + dx, y: e.by + dy, w: e.w, h: e.h };
        let ov = 0;
        for (const p of placed) {
          ov += overlapArea(box, p);
          if (ov >= bestOverlap) break;
        }
        if (ov < bestOverlap) {
          bestOverlap = ov;
          best = box;
          if (ov === 0) break;
        }
      }
      x = best.x;
      y = best.y;
    }
    e.x = x;
    e.y = y;
    placed.push({ x, y, w: e.w, h: e.h });
  }
  return entries;
}

/** The layout entry nearest to a point (within maxDist of its box), or null. */
export function labelAt(world, x, y, maxDist) {
  let best = null, bd = Infinity;
  for (const e of layoutLabels(world)) {
    const dx = Math.max(Math.abs(x - e.x) - e.w / 2, 0);
    const dy = Math.max(Math.abs(y - e.y) - e.h / 2, 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bd) { bd = d; best = e; }
  }
  return best && bd <= maxDist ? best : null;
}
