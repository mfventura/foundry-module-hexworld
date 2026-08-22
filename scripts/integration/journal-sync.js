/**
 * Journal sync (v0.12): publish the named features of a HexWorld scene as
 * JournalEntry pages plus clickable map Notes over the settlements/POIs.
 *
 * Idempotent by flags, never by name: the scene's entry carries
 * `flags.hexworld.sceneId`, every page/note carries `flags.hexworld.key`
 * (the same feature key used in flags.hexworld.names — "s12", "r345", "l7",
 * "k2"). Re-syncing only creates what is missing and renames pages whose
 * feature was renamed — the page BODY belongs to the GM and is never touched.
 * Notes show their page's name, so renames propagate to the map for free.
 *
 * collectJournalFeatures() is pure (Node smoke-testable); everything else
 * talks to Foundry documents and is browser-only.
 */

import { computeLabelAnchors } from "../generator/names.js";
import { SITE } from "../generator/sites.js";
import { describeCell } from "../ui/cell-info.js";

/** i18n label key per site type (page subtitle). */
const SITE_LABELS = {
  [SITE.VILLAGE]: "SiteVillage",
  [SITE.CITY]: "SiteCity",
  [SITE.DUNGEON]: "SiteDungeon",
  [SITE.TEMPLE]: "SiteTemple",
  [SITE.RUIN]: "SiteRuin",
  [SITE.MARKER]: "SiteMarker"
};
const KIND_LABELS = {
  realm: "JournalKindRealm",
  sea: "JournalKindSea",
  lake: "JournalKindLake",
  river: "JournalKindRiver"
};

/**
 * Every NAMED feature of the world, in cartographic page order (realms,
 * cities, villages, POIs/markers, waters, rivers). Pure: safe from Node.
 * @returns {Array<{key: string, kind: string, cell: number, name: string, siteType?: number}>}
 */
export function collectJournalFeatures(world) {
  const names = world.names ?? {};
  const anchors = computeLabelAnchors(world, world.sites ?? null);
  const out = [];
  for (const r of anchors.realms) {
    if (names[r.key]) out.push({ key: r.key, kind: "realm", cell: r.cell, name: names[r.key] });
  }
  const rank = t => (t === SITE.CITY ? 0 : t === SITE.VILLAGE ? 1 : 2);
  const sites = anchors.sites
    .filter(s => names[s.key])
    .sort((a, b) => (rank(a.type) - rank(b.type)) || (a.cell - b.cell));
  for (const s of sites) {
    out.push({ key: s.key, kind: "site", cell: s.cell, name: names[s.key], siteType: s.type });
  }
  for (const w of anchors.waters) {
    if (names[w.key]) out.push({ key: w.key, kind: w.isSea ? "sea" : "lake", cell: w.cell, name: names[w.key] });
  }
  for (const r of anchors.rivers) {
    if (names[r.key]) out.push({ key: r.key, kind: "river", cell: r.cell, name: names[r.key] });
  }
  return out;
}

/* -------------------------------------------- */
/*  Browser-only: documents                      */
/* -------------------------------------------- */

function kindLabel(f) {
  const key = f.kind === "site" ? (SITE_LABELS[f.siteType] ?? "SiteMarker") : KIND_LABELS[f.kind];
  return game.i18n.localize(`HEXWORLD.${key}`);
}

/** Initial page body: type + a one-line cell summary. The GM owns it after. */
function pageContent(world, f) {
  const esc = foundry.utils.escapeHTML;
  let body = `<p><em>${esc(kindLabel(f))}</em></p>`;
  if (f.kind === "realm") {
    const id = Number(f.key.slice(1));
    let cells = 0, settlements = 0;
    for (let c = 0; c < world.grid.n; c++) {
      if (world.realms?.[c] !== id) continue;
      cells++;
      const t = world.sites?.[c];
      if (t === SITE.CITY || t === SITE.VILLAGE) settlements++;
    }
    body += `<p>${esc(game.i18n.format("HEXWORLD.JournalRealmSummary", { cells, settlements }))}</p>`;
  } else {
    body += `<p>${esc(describeCell(world, f.cell))}</p>`;
  }
  return body;
}

/** The scene's journal entry, tracked by flag (created on demand). */
function findSceneJournal(scene) {
  return game.journal.find(j => j.flags?.hexworld?.sceneId === scene.id) ?? null;
}

/**
 * Create/refresh the journal entry, its pages and the map notes for a scene.
 * @param {Scene} scene a HexWorld data-driven scene (flags v2)
 * @param {object} world the layer's derived world (names/sites/realms attached)
 * @returns {Promise<{pages: number, renamed: number, notes: number}|null>}
 */
export async function syncSceneJournal(scene, world) {
  if (!scene || !world || !game.user.isGM) return null;
  const features = collectJournalFeatures(world);
  let entry = findSceneJournal(scene);
  entry ??= await JournalEntry.create({
    name: scene.name,
    flags: { hexworld: { sceneId: scene.id } }
  });

  const pageByKey = () => {
    const map = new Map();
    for (const p of entry.pages) {
      const k = p.flags?.hexworld?.key;
      if (k) map.set(k, p);
    }
    return map;
  };

  const existing = pageByKey();
  const creates = [], renames = [];
  features.forEach((f, i) => {
    const page = existing.get(f.key);
    if (!page) {
      creates.push({
        name: f.name,
        type: "text",
        sort: (i + 1) * 100000,
        text: { content: pageContent(world, f), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
        flags: { hexworld: { key: f.key } }
      });
    } else if (page.name !== f.name) {
      renames.push({ _id: page.id, name: f.name });
    }
  });
  if (creates.length) await entry.createEmbeddedDocuments("JournalEntryPage", creates);
  if (renames.length) await entry.updateEmbeddedDocuments("JournalEntryPage", renames);

  // Map notes: settlements/POIs/markers only (features with a marker cell).
  const pages = pageByKey();
  const noted = new Set();
  for (const n of scene.notes) {
    const k = n.flags?.hexworld?.key;
    if (k) noted.add(k);
  }
  const d = scene.dimensions;
  const noteCreates = [];
  for (const f of features) {
    if (f.kind !== "site" || noted.has(f.key)) continue;
    const page = pages.get(f.key);
    if (!page) continue;
    noteCreates.push({
      entryId: entry.id,
      pageId: page.id,
      x: Math.round(d.sceneX + world.grid.cx[f.cell]),
      y: Math.round(d.sceneY + world.grid.cy[f.cell]),
      iconSize: Math.max(32, Math.round(world.grid.size * 0.45)),
      flags: { hexworld: { key: f.key } }
    });
  }
  if (noteCreates.length) await scene.createEmbeddedDocuments("Note", noteCreates);

  return { pages: creates.length, renamed: renames.length, notes: noteCreates.length };
}

/**
 * Keep the journal in step with the rename tool: if the feature already has
 * a page, rename it (notes display the page name, so they follow along).
 * A cleared name keeps the page — GM content is never discarded.
 */
export async function renameJournalFeature(scene, key, name) {
  if (!scene || !key || !name || !game.user.isGM) return;
  const entry = findSceneJournal(scene);
  const page = entry?.pages.find(p => p.flags?.hexworld?.key === key);
  if (page && page.name !== name) await page.update({ name });
}
