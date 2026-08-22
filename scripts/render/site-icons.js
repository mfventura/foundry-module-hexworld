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
  [SITE.RUIN]: "fa-archway",
  // Free markers carry their own icon per cell (world.markers); this is only
  // the fallback for entries whose stored icon is missing or unknown.
  [SITE.MARKER]: "fa-location-dot"
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
  [SITE.RUIN]: { badge: "#cfc7b6", ring: "#4a4438", glyph: "#4a4438", scale: 0.95 },
  [SITE.MARKER]: { badge: "#dfe4e8", ring: "#22303c", glyph: "#22303c", scale: 0.95 }
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

/* -------------------------------------------- */
/*  Runtime glyph/font resolution (browser only) */
/* -------------------------------------------- */

let fontSpec = null;
const glyphCache = new Map();

/**
 * The EXACT Font Awesome family/weight this Foundry build uses, read from
 * a live `.fa-solid` element — canvas fillText needs the real family name,
 * which changes across Foundry/FA versions.
 */
export function faFontSpec() {
  if (fontSpec) return fontSpec;
  let family = "\"Font Awesome 6 Pro\", \"Font Awesome 6 Free\"";
  let weight = "900";
  try {
    const el = document.createElement("i");
    el.className = "fa-solid";
    el.style.position = "absolute";
    el.style.visibility = "hidden";
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    if (cs.fontFamily) family = cs.fontFamily;
    if (cs.fontWeight) weight = cs.fontWeight;
    el.remove();
  } catch (_err) { /* headless */ }
  fontSpec = { family, weight };
  return fontSpec;
}

/**
 * Glyph character for an icon, read from Foundry's own stylesheet
 * (::before content) so codepoints can never drift from the packaged FA
 * version; the curated table is only the headless fallback.
 */
export function glyphChar(name) {
  if (glyphCache.has(name)) return glyphCache.get(name);
  let ch = SITE_GLYPHS[name]?.glyph ?? "";
  try {
    const el = document.createElement("i");
    el.className = `fa-solid ${name}`;
    el.style.position = "absolute";
    el.style.visibility = "hidden";
    document.body.appendChild(el);
    const content = getComputedStyle(el, "::before").content;
    el.remove();
    if (content && content !== "none" && content !== "normal") {
      // Modern FA uses the alt-text syntax (`content: "\f015" / ""`): the
      // computed value is a list — take only the FIRST quoted string.
      const m = content.match(/["']([^"']+)["']/);
      if (m) ch = m[1];
    }
  } catch (_err) { /* headless */ }
  glyphCache.set(name, ch);
  return ch;
}

/** Everything drawSites needs to render markers on this client. */
export function siteRenderContext() {
  const icons = configuredSiteIcons();
  const { family, weight } = faFontSpec();
  const glyphs = {};
  for (const [type, name] of Object.entries(icons)) glyphs[type] = glyphChar(name);
  let markerStyle = "badge";
  try {
    markerStyle = game.settings.get("hexworld", "markerStyle") || "badge";
  } catch (_err) { /* setting not registered yet */ }
  // Nudge the face into the font cache so 2D canvas can rasterize it.
  try { document.fonts?.load(`${weight} 24px ${family.split(",")[0]}`, Object.values(glyphs).join("")); } catch (_err) { /* ok */ }
  // glyphFor: per-cell icons (free markers) resolved through the same cache.
  return { glyphs, fontFamily: family, fontWeight: weight, markerStyle, glyphFor: glyphChar };
}
