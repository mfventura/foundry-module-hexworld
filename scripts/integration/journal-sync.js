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
 * v0.12.1: new pages get a data table plus procedurally composed prose
 * (generator/lore.js — seeded per feature, localized via lang templates) with
 * @UUID cross-links to sibling pages. Bodies are written ONLY at creation, so
 * pages are created first (empty) and filled in a second pass once every
 * page id is known for linking.
 *
 * collectJournalFeatures() is pure (Node smoke-testable); everything else
 * talks to Foundry documents and is browser-only.
 */

import { computeLabelAnchors } from "../generator/names.js";
import { SITE } from "../generator/sites.js";
import { featureFacts, composeLore } from "../generator/lore.js";
import { makeRng } from "../lib/random.js";

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
const POI_TYPES = [SITE.DUNGEON, SITE.TEMPLE, SITE.RUIN, SITE.MARKER];

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

/**
 * Initial page body: a compact data table plus the procedural prose, with
 * @UUID links to any sibling page. Written once at creation — the GM owns
 * the body after.
 * @param {Map<string, JournalEntryPage>} pages every page of the entry by feature key
 */
function pageContent(world, f, pages) {
  const esc = foundry.utils.escapeHTML;
  const facts = featureFacts(world, f);
  const t = (key, data) => {
    if (!data) return game.i18n.localize(`HEXWORLD.${key}`);
    const safe = {};
    for (const [k, v] of Object.entries(data)) safe[k] = typeof v === "string" && !v.includes("@UUID[") ? esc(v) : v;
    return game.i18n.format(`HEXWORLD.${key}`, safe);
  };
  const link = (key, name) => {
    const page = pages.get(key);
    return page ? `@UUID[${page.uuid}]{${esc(name)}}` : esc(name);
  };

  const rows = [[t("JournalFieldType"), esc(kindLabel(f))]];
  if (f.kind === "site") {
    if (facts.biomeKey) rows.push([t("JournalFieldBiome"), esc(t(`Biome${facts.biomeKey}`))]);
    rows.push([t("JournalFieldClimate"), `${facts.temp} °C`]);
    rows.push([t("JournalFieldRealm"), facts.realmName ? link(facts.realmKey, facts.realmName) : t("JournalWilderness")]);
    if (POI_TYPES.includes(f.siteType)) {
      rows.push([t("JournalFieldNearest"), facts.nearest ? link(facts.nearest.key, facts.nearest.name) : "—"]);
    }
  } else if (f.kind === "river") {
    rows.push([t("JournalFieldLength"), t("JournalCells", { n: facts.length })]);
    rows.push([t("JournalFieldMouth"), facts.mouthName ? link(facts.mouthKey, facts.mouthName) : t("JournalOpenSea")]);
  } else if (f.kind === "sea" || f.kind === "lake") {
    rows.push([t("JournalFieldExtent"), t("JournalCells", { n: facts.size })]);
  } else if (f.kind === "realm") {
    rows.push([t("JournalFieldCapital"), facts.capitalName ? link(facts.capitalKey, facts.capitalName) : "—"]);
    rows.push([t("JournalFieldTerritory"), t("JournalRealmSummary", { cells: facts.cells, settlements: facts.settlements })]);
  }
  const table = `<table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</tbody></table>`;

  const rng = makeRng(`${world.params.seed}:lore:${f.key}`);
  const prose = composeLore(facts, rng, t, link).map(s => `<p>${s}</p>`).join("");
  return table + prose;
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
        flags: { hexworld: { key: f.key } }
      });
    } else if (page.name !== f.name) {
      renames.push({ _id: page.id, name: f.name });
    }
  });
  const createdKeys = new Set(creates.map(c => c.flags.hexworld.key));
  if (creates.length) await entry.createEmbeddedDocuments("JournalEntryPage", creates);
  if (renames.length) await entry.updateEmbeddedDocuments("JournalEntryPage", renames);

  // Second pass: generate the bodies of the JUST-CREATED pages, now that
  // every page exists and cross-links can resolve. Existing bodies are the
  // GM's and are never rewritten.
  const pages = pageByKey();
  const bodies = [];
  for (const f of features) {
    if (!createdKeys.has(f.key)) continue;
    const page = pages.get(f.key);
    if (!page) continue;
    bodies.push({
      _id: page.id,
      "text.content": pageContent(world, f, pages),
      "text.format": CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML
    });
  }
  if (bodies.length) await entry.updateEmbeddedDocuments("JournalEntryPage", bodies);

  // Map notes: settlements/POIs/markers only (features with a marker cell).
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
