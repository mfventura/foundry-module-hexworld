/**
 * Procedural naming: fantasy toponyms plus the label-anchor geometry for
 * everything nameable — settlements/POIs (by cell), river systems (by mouth
 * cell) and enclosed water bodies (by their smallest cell index).
 *
 * Names live in a sparse map in flags (`names: {"s12": "...", "r345": ...}`).
 * Generation only ADDS missing entries, so manual renames always survive.
 * River/lake keys derive from geometry, so heavy terrain edits can orphan a
 * name (it simply stops rendering) — the rename tool re-names the new system.
 */

import { SITE } from "./sites.js";

const ONSETS = [
  "Val", "Bel", "Cor", "Dor", "Fal", "Gal", "Hel", "Kar", "Lor", "Mar", "Mor",
  "Nar", "Or", "Per", "Ral", "Sal", "Tar", "Thal", "Vel", "Zar", "Alt", "Bren",
  "Cal", "Dun", "Eld", "Fen", "Gris", "Lun", "Ser", "Tor"
];
const MIDS = ["a", "e", "i", "o", "u", "ae", "ia", "io", "ar", "en", "il", "or", "un", "an"];
const ENDS = [
  "dia", "gar", "lin", "mar", "nor", "ria", "san", "thos", "toria", "via",
  "burgo", "grado", "mira", "monte", "puerto", "vado", "helm", "dell", "gard", "ora"
];

/** Deterministic toponym factory; `used` guarantees map-wide uniqueness. */
export function makeNamer(rng, used = new Set()) {
  return () => {
    for (let tries = 0; tries < 60; tries++) {
      let n = ONSETS[(rng() * ONSETS.length) | 0];
      if (rng() < 0.45) n += MIDS[(rng() * MIDS.length) | 0];
      n += ENDS[(rng() * ENDS.length) | 0];
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    let i = 2, base = ONSETS[(rng() * ONSETS.length) | 0] + ENDS[(rng() * ENDS.length) | 0];
    while (used.has(`${base} ${i}`)) i++;
    const n = `${base} ${i}`;
    used.add(n);
    return n;
  };
}

/** Default (Spanish) naming patterns; the UI passes i18n-backed ones. */
export const DEFAULT_PATTERNS = {
  city: n => n,
  village: n => n,
  dungeon: n => `Cripta de ${n}`,
  temple: n => `Templo de ${n}`,
  ruin: n => `Ruinas de ${n}`,
  river: n => `Río ${n}`,
  lake: n => `Lago ${n}`,
  sea: n => `Mar de ${n}`,
  realm: n => `Reino de ${n}`
};

/** i18n-backed patterns (browser only). */
export function i18nNamePatterns() {
  const f = key => n => game.i18n.format(`HEXWORLD.${key}`, { name: n });
  return {
    city: n => n,
    village: n => n,
    dungeon: f("PatDungeon"),
    temple: f("PatTemple"),
    ruin: f("PatRuin"),
    river: f("PatRiver"),
    lake: f("PatLake"),
    sea: f("PatSea"),
    realm: f("PatRealm")
  };
}

const SITE_KIND = {
  [SITE.VILLAGE]: "village",
  [SITE.CITY]: "city",
  [SITE.DUNGEON]: "dungeon",
  [SITE.TEMPLE]: "temple",
  [SITE.RUIN]: "ruin"
};

/** Mouth cell of the river system containing `c` (the anchor identity). */
function riverMouth(world, c) {
  const { isRiver, isWater, flowTo, grid } = world;
  let cur = c, guard = 0;
  while (guard++ < grid.n) {
    const next = flowTo[cur];
    if (next < 0 || isWater[next] || !isRiver[next]) return cur;
    cur = next;
  }
  return cur;
}

/**
 * Every nameable feature and where its label belongs. Realms come from
 * world.realms (attached by the callers, like world.sites).
 * @returns {{sites: {key,cell,type}[], rivers: {key,cell,size}[],
 *            waters: {key,cell,size,isSea}[], realms: {key,cell,id,size}[]}}
 */
export function computeLabelAnchors(world, sites) {
  const { grid, isRiver, isWater, isOcean, flowTo, flux } = world;
  const out = { sites: [], rivers: [], waters: [], realms: [] };

  const realms = world.realms ?? null;
  if (realms) {
    const acc = new Map(); // id -> {sx, sy, count}
    for (let c = 0; c < grid.n; c++) {
      const id = realms[c];
      if (!id || isWater[c]) continue;
      const a = acc.get(id) ?? { sx: 0, sy: 0, count: 0 };
      a.sx += grid.cx[c];
      a.sy += grid.cy[c];
      a.count++;
      acc.set(id, a);
    }
    for (const [id, a] of acc) {
      if (a.count < 10) continue;
      const cx = a.sx / a.count, cy = a.sy / a.count;
      let anchor = -1, bd = Infinity;
      for (let c = 0; c < grid.n; c++) {
        if (realms[c] !== id || isWater[c]) continue;
        const dx = grid.cx[c] - cx, dy = grid.cy[c] - cy;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; anchor = c; }
      }
      if (anchor >= 0) out.realms.push({ key: `k${id}`, cell: anchor, id, size: a.count });
    }
    out.realms.sort((a, b) => a.id - b.id);
  }

  if (sites) {
    for (let c = 0; c < grid.n; c++) {
      if (sites[c]) out.sites.push({ key: `s${c}`, cell: c, type: sites[c] });
    }
  }

  // River systems, grouped by mouth; label at the middle of the main stem.
  const systems = new Map();
  for (let c = 0; c < grid.n; c++) {
    if (!isRiver[c]) continue;
    const m = riverMouth(world, c);
    systems.set(m, (systems.get(m) ?? 0) + 1);
  }
  for (const [mouth, size] of systems) {
    if (size < 4) continue;
    const stem = [mouth];
    let cur = mouth, guard = 0;
    while (guard++ < grid.n) {
      let best = -1, bf = -1;
      for (const nb of grid.neighbors[cur]) {
        if (isRiver[nb] && flowTo[nb] === cur && flux[nb] > bf) { bf = flux[nb]; best = nb; }
      }
      if (best < 0) break;
      stem.push(best);
      cur = best;
    }
    out.rivers.push({ key: `r${mouth}`, cell: stem[Math.floor(stem.length / 2)], size });
  }

  // Enclosed water bodies (lakes and inland seas); the open border ocean is
  // not named. Key = smallest cell of the body; label at the cell nearest to
  // its centroid.
  const seen = new Uint8Array(grid.n);
  for (let c0 = 0; c0 < grid.n; c0++) {
    if (seen[c0] || !isWater[c0]) continue;
    const body = [c0];
    seen[c0] = 1;
    let touchesBorder = grid.isBorder(c0);
    for (let q = 0; q < body.length; q++) {
      for (const nb of grid.neighbors[body[q]]) {
        if (!seen[nb] && isWater[nb]) {
          seen[nb] = 1;
          body.push(nb);
          if (grid.isBorder(nb)) touchesBorder = true;
        }
      }
    }
    if (touchesBorder || body.length < 3) continue;
    let sx = 0, sy = 0, minC = body[0];
    for (const b of body) {
      sx += grid.cx[b];
      sy += grid.cy[b];
      if (b < minC) minC = b;
    }
    const cx = sx / body.length, cy = sy / body.length;
    let anchor = body[0], bd = Infinity;
    for (const b of body) {
      const dx = grid.cx[b] - cx, dy = grid.cy[b] - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; anchor = b; }
    }
    out.waters.push({ key: `l${minC}`, cell: anchor, size: body.length, isSea: !!isOcean[minC] });
  }
  return out;
}

/**
 * Fill in names for every currently-unnamed feature. Existing entries are
 * never touched. Deterministic given the rng and the world.
 * @returns {Record<string, string>} a NEW map (existing + additions)
 */
export function generateNames(world, sites, existing, rng, patterns = null) {
  const P = { ...DEFAULT_PATTERNS, ...(patterns ?? {}) };
  const names = { ...(existing ?? {}) };
  const used = new Set(Object.values(names));
  const namer = makeNamer(rng, used);
  const anchors = computeLabelAnchors(world, sites);
  for (const s of anchors.sites) {
    if (!names[s.key]) names[s.key] = P[SITE_KIND[s.type]](namer());
  }
  for (const r of anchors.rivers) {
    if (!names[r.key]) names[r.key] = P.river(namer());
  }
  for (const w of anchors.waters) {
    if (!names[w.key]) names[w.key] = (w.isSea ? P.sea : P.lake)(namer());
  }
  // Realms are named after their capital city when it has a name. The
  // capital is resolved from the CHANNELS (a city standing on the realm's
  // own territory), never by index order — freely edited sites would desync
  // a positional mapping.
  if (anchors.realms.length) {
    const capitalByRealm = new Map();
    if (sites && world.realms) {
      for (let c = 0; c < world.grid.n; c++) {
        if (sites[c] !== SITE.CITY) continue;
        const id = world.realms[c];
        if (id && !capitalByRealm.has(id)) capitalByRealm.set(id, c);
      }
    }
    for (const r of anchors.realms) {
      if (names[r.key]) continue;
      const capital = capitalByRealm.get(r.id);
      const capitalName = capital != null ? names[`s${capital}`] : null;
      names[r.key] = P.realm(capitalName || namer());
    }
  }
  return names;
}

/** The name key of whatever nameable feature sits at cell `c`, or null. */
export function nameKeyAt(world, sites, c) {
  if (sites?.[c]) return `s${c}`;
  if (world.isRiver[c]) return `r${riverMouth(world, c)}`;
  if (world.isWater[c]) {
    const { grid, isWater } = world;
    const seen = new Set([c]);
    const body = [c];
    let minC = c;
    for (let q = 0; q < body.length; q++) {
      if (grid.isBorder(body[q])) return null; // open ocean is not named
      for (const nb of grid.neighbors[body[q]]) {
        if (!seen.has(nb) && isWater[nb]) {
          seen.add(nb);
          body.push(nb);
          if (nb < minC) minC = nb;
        }
      }
    }
    return `l${minC}`;
  }
  const realm = world.realms?.[c];
  if (realm) return `k${realm}`;
  return null;
}
