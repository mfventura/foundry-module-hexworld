/**
 * Site marker icons: one shared, curated Font Awesome catalog used by the
 * settings dropdowns, the editor palettes and the map renderer. The map
 * draws the actual FA glyph (via canvas fillText) so markers always match
 * the palette. Pure data + lazy `game` access — safe to import from Node
 * smoke tests as long as configuredSiteIcons() is not called there.
 */

import { SITE } from "../generator/sites.js";

/** FA solid icon name -> glyph codepoint + settings-choice label key. */
export const SITE_GLYPHS = {
  "fa-house": { glyph: "", label: "HEXWORLD.IconHouse" },
  "fa-city": { glyph: "", label: "HEXWORLD.IconCity" },
  "fa-chess-rook": { glyph: "", label: "HEXWORLD.IconChessRook" },
  "fa-fort": { glyph: "", label: "HEXWORLD.IconFort" },
  "fa-dungeon": { glyph: "", label: "HEXWORLD.IconDungeon" },
  "fa-skull": { glyph: "", label: "HEXWORLD.IconSkull" },
  "fa-place-of-worship": { glyph: "", label: "HEXWORLD.IconWorship" },
  "fa-gopuram": { glyph: "", label: "HEXWORLD.IconGopuram" },
  "fa-cross": { glyph: "", label: "HEXWORLD.IconCross" },
  "fa-archway": { glyph: "", label: "HEXWORLD.IconArchway" },
  "fa-monument": { glyph: "", label: "HEXWORLD.IconMonument" },
  "fa-landmark": { glyph: "", label: "HEXWORLD.IconLandmark" },
  "fa-campground": { glyph: "", label: "HEXWORLD.IconCampground" },
  "fa-anchor": { glyph: "", label: "HEXWORLD.IconAnchor" },
  "fa-tower-observation": { glyph: "", label: "HEXWORLD.IconTower" },
  "fa-tree": { glyph: "", label: "HEXWORLD.IconTree" },
  "fa-star": { glyph: "", label: "HEXWORLD.IconStar" },
  "fa-location-dot": { glyph: "", label: "HEXWORLD.IconLocationDot" }
};

/** Default icon per site type (also the fallback when a setting is invalid). */
export const DEFAULT_SITE_ICONS = {
  [SITE.VILLAGE]: "fa-house",
  [SITE.CITY]: "fa-city",
  [SITE.DUNGEON]: "fa-dungeon",
  [SITE.TEMPLE]: "fa-place-of-worship",
  [SITE.RUIN]: "fa-archway"
};

/** Module setting key per site type. */
export const SITE_ICON_SETTINGS = {
  [SITE.VILLAGE]: "iconVillage",
  [SITE.CITY]: "iconCity",
  [SITE.DUNGEON]: "iconDungeon",
  [SITE.TEMPLE]: "iconTemple",
  [SITE.RUIN]: "iconRuin"
};

/** Badge styling per site type (marker background/ring/glyph, size factor). */
export const SITE_STYLE = {
  [SITE.VILLAGE]: { badge: "#f3e7c8", ring: "#2b2118", glyph: "#2b2118", scale: 0.9 },
  [SITE.CITY]: { badge: "#f0cf6d", ring: "#2b2118", glyph: "#2b2118", scale: 1.15 },
  [SITE.DUNGEON]: { badge: "#33303b", ring: "#d9d4c8", glyph: "#e8e4da", scale: 1 },
  [SITE.TEMPLE]: { badge: "#efe9dc", ring: "#2b2118", glyph: "#4a3826", scale: 1 },
  [SITE.RUIN]: { badge: "#cfc7b6", ring: "#4a4438", glyph: "#4a4438", scale: 0.95 }
};

/** Resolve the configured icon name per site type from the module settings. */
export function configuredSiteIcons() {
  const out = {};
  for (const [type, key] of Object.entries(SITE_ICON_SETTINGS)) {
    let v = null;
    try {
      v = game.settings.get("hexworld", key);
    } catch (_err) { /* setting not registered yet */ }
    out[type] = SITE_GLYPHS[v] ? v : DEFAULT_SITE_ICONS[type];
  }
  return out;
}
