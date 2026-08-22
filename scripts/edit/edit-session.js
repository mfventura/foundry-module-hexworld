/**
 * WorldEditSession — the editing engine shared by the in-scene layer and the
 * generator preview. Owns the base, the derived world, every editable
 * channel, the per-channel undo/redo history and the tool dispatch, so each
 * tool is implemented exactly once.
 *
 * The session is deliberately DOM/Foundry-light: coordinates are grid-space
 * pixels, user feedback is returned as status codes (hosts map them to
 * notifications) and render-only extras (siteRender, showLabels) are attached
 * from host-provided values. That keeps it drivable from Node smoke tests.
 */

import { buildBase, deriveWorld } from "../generator/worldgen.js";
import { applyBrush, applyBiomeBrush, applyRiverTool, cellAt } from "../generator/brush.js";
import { routeRoad } from "../generator/sites.js";
import { nameKeyAt } from "../generator/names.js";
import { labelAt } from "../render/labels.js";
import { B } from "../generator/biomes.js";
import { SITE } from "../generator/sites.js";
import {
  encodeEdits, decodeEdits, encodeOverrides, decodeOverrides,
  encodeBytes, decodeBytes, NO_OVERRIDE
} from "../lib/codec.js";

const UNDO_LIMIT = 20;

export const RIVER_TOOLS = new Set(["riverAdd", "riverRemove"]);
export const ROUTE_TOOLS = new Set(["roadMinor", "roadMajor"]);
/** Tools that act on a single click instead of dragging an area. */
export const CLICK_TOOLS = new Set([...RIVER_TOOLS, ...ROUTE_TOOLS, "site", "rename"]);
export const PAINT_TOOLS = new Set([
  "raise", "lower", "smooth", "water", "land", "mountain", "biome",
  "site", "roadErase", "rename", "realm", "labelMove", ...RIVER_TOOLS, ...ROUTE_TOOLS
]);

/** Channels that never feed the derived pipeline: repaint, don't re-derive. */
const OVERLAY_CHANNELS = new Set(["site", "road", "realm", "labels"]);
/** Scene-flag fields to persist per stroke channel. */
const CHANNEL_FIELDS = {
  elev: ["edits", "stats"],
  biome: ["biomes", "stats"],
  river: ["rivers", "stats"],
  site: ["sites", "markers"],
  road: ["roads"],
  realm: ["realms"],
  labels: ["labels"]
};

export function strokeChannelFor(tool) {
  if (tool === "biome") return "biome";
  if (RIVER_TOOLS.has(tool)) return "river";
  if (tool === "site") return "site";
  if (tool === "realm") return "realm";
  if (tool === "labelMove") return "labels";
  if (ROUTE_TOOLS.has(tool) || tool === "roadErase") return "road";
  return "elev";
}

export class WorldEditSession {
  base = null;
  world = null;
  /** @type {Float32Array|null} */ edits = null;
  /** @type {Uint8Array|null} */ overrides = null;
  /** @type {Uint8Array|null} */ riverEdits = null;
  /** @type {Uint8Array|null} */ sites = null;
  /** @type {Uint8Array|null} */ roads = null;
  /** @type {Uint8Array|null} */ realms = null;
  /** @type {Record<string, string>} */ names = {};
  /** @type {Record<string, [number, number]>} */ labelOffsets = {};
  /**
   * Icon per free-marker cell (`{cell: faIconName}`). Only read where
   * sites[cell] === SITE.MARKER; entries under other site values stay latent
   * (same policy as submerged biome overrides), so per-stroke undo of the u8
   * channel needs no second history.
   * @type {Record<string, string>}
   */
  markers = {};

  brush = {
    radius: 3, strength: 0.06, biome: B.GRASSLAND, site: SITE.VILLAGE, realm: 1,
    markerIcon: "fa-location-dot"
  };

  /** First endpoint of a pending two-click road route. */
  routeAnchor = -1;
  /** @type {{key, bx, by, prev}|null} label being dragged */
  dragLabel = null;

  /** Render-only extras merged onto the world on every attach (host-owned). */
  overlayExtras = null;

  #undoStack = [];
  #redoStack = [];
  /** @type {{channel: string, cells: Map<number, number>}|null} */
  #stroke = null;

  get hasUndo() { return this.#undoStack.length > 0; }
  get hasRedo() { return this.#redoStack.length > 0; }

  /* -------------------------------------------- */
  /*  Loading and deriving                         */
  /* -------------------------------------------- */

  /** Load a world from scene flags. @param {object|null} reusableBase */
  loadFlags(flags, reusableBase = null) {
    this.base = reusableBase ?? buildBase(flags.params);
    const n = this.base.grid.n;
    this.edits = decodeEdits(flags.edits ?? null, n);
    this.overrides = decodeOverrides(flags.biomes ?? null, n);
    this.riverEdits = decodeBytes(flags.rivers ?? null, n);
    this.sites = decodeBytes(flags.sites ?? null, n);
    this.roads = decodeBytes(flags.roads ?? null, n);
    this.realms = decodeBytes(flags.realms ?? null, n);
    this.markers = { ...(flags.markers ?? {}) };
    this.names = { ...(flags.names ?? {}) };
    this.labelOffsets = { ...(flags.labels ?? {}) };
    this.clearHistory();
    this.derive();
    return this.world;
  }

  /** Replace the base (generator Generate), optionally keeping channels. */
  setBase(base, { keepChannels = false } = {}) {
    this.base = base;
    if (!keepChannels) {
      this.edits = this.overrides = this.riverEdits = null;
      this.sites = this.roads = this.realms = null;
      this.markers = {};
      this.names = {};
      this.labelOffsets = {};
    }
    this.clearHistory();
    this.derive();
    return this.world;
  }

  /** Re-derive the world from base + channels and attach everything. */
  derive() {
    if (!this.base) return null;
    this.world = deriveWorld(this.base, this.edits, this.overrides, this.riverEdits);
    this.attach();
    return this.world;
  }

  /** Re-attach channels and render extras (cheap; no re-derive). */
  attach() {
    const w = this.world;
    if (!w) return;
    w.sites = this.sites;
    w.roads = this.roads;
    w.realms = this.realms;
    w.markers = this.markers;
    w.names = this.names;
    w.labelOffsets = this.labelOffsets;
    w._labelLayout = null; // in-place channel edits may have moved anything
    const extras = typeof this.overlayExtras === "function" ? this.overlayExtras() : this.overlayExtras;
    if (extras) Object.assign(w, extras);
  }

  clear() {
    this.base = this.world = null;
    this.edits = this.overrides = this.riverEdits = null;
    this.sites = this.roads = this.realms = null;
    this.markers = {};
    this.names = {};
    this.labelOffsets = {};
    this.routeAnchor = -1;
    this.dragLabel = null;
    this.clearHistory();
  }

  clearHistory() {
    this.#undoStack = [];
    this.#redoStack = [];
    this.#stroke = null;
  }

  /* -------------------------------------------- */
  /*  Strokes and painting                         */
  /* -------------------------------------------- */

  beginStroke(tool) {
    this.#stroke = { channel: strokeChannelFor(tool), cells: new Map() };
    return this.#stroke;
  }

  /**
   * Re-open a just-committed stroke so a drag can continue the click that
   * started the same gesture (scene layer: MIM fires both).
   * @returns {boolean} adopted
   */
  adoptStroke(stroke) {
    if (!stroke || this.#undoStack[this.#undoStack.length - 1] !== stroke) return false;
    this.#undoStack.pop();
    this.#stroke = stroke;
    return true;
  }

  /**
   * Apply a tool at grid-space (x, y).
   * @returns {{changed: boolean, needsDerive: boolean, status?: string}}
   *   status: "anchor-set" | "route-unreachable" | "rename" (host opens the
   *   dialog for the returned key) — mapped to UI by the hosts.
   */
  paint(tool, x, y) {
    const none = { changed: false, needsDerive: false };
    if (!this.base || !this.world) return none;
    const grid = this.base.grid;
    const cells = this.#stroke?.cells ?? null;

    if (tool === "rename") {
      const c = cellAt(grid, x, y);
      const key = c >= 0 ? nameKeyAt(this.world, this.sites, c) : null;
      return { ...none, status: "rename", key };
    }

    if (tool === "labelMove") {
      if (!this.dragLabel) {
        const e = labelAt(this.world, x, y, grid.size * 1.2);
        if (e) {
          this.dragLabel = { key: e.key, bx: e.bx, by: e.by, prev: this.labelOffsets[e.key] ?? null };
        }
        return none;
      }
      this.labelOffsets = {
        ...this.labelOffsets,
        [this.dragLabel.key]: [Math.round(x - this.dragLabel.bx), Math.round(y - this.dragLabel.by)]
      };
      return { changed: true, needsDerive: false };
    }

    if (tool === "site") {
      const c = cellAt(grid, x, y);
      if (c < 0) return none;
      this.sites ??= new Uint8Array(grid.n);
      if (cells && !cells.has(c)) cells.set(c, this.sites[c]);
      this.sites[c] = this.brush.site;
      if (this.brush.site === SITE.MARKER) {
        this.markers = { ...this.markers, [c]: this.brush.markerIcon };
        // A fresh free marker is worthless without a name: hosts open the
        // rename dialog for it (the placement itself still commits/persists).
        return { changed: true, needsDerive: false, status: "rename", key: `s${c}` };
      }
      return { changed: true, needsDerive: false };
    }

    if (ROUTE_TOOLS.has(tool)) {
      const c = cellAt(grid, x, y);
      if (c < 0) return none;
      if (this.routeAnchor < 0 || this.routeAnchor === c) {
        this.routeAnchor = c;
        return { ...none, status: "anchor-set" };
      }
      this.roads ??= new Uint8Array(grid.n);
      const kind = tool === "roadMajor" ? 2 : 1;
      const touched = routeRoad(this.world, this.roads, cells, this.routeAnchor, c, kind);
      this.routeAnchor = c; // chain: the next click extends the route
      if (!touched) return { ...none, status: "route-unreachable" };
      return { changed: true, needsDerive: false };
    }

    if (tool === "roadErase") {
      this.roads ??= new Uint8Array(grid.n);
      const t = applyBiomeBrush(this.base, this.roads, cells, {
        biome: 0, radius: this.brush.radius, x, y
      });
      return { changed: t > 0, needsDerive: false };
    }

    if (tool === "realm") {
      this.realms ??= new Uint8Array(grid.n);
      // v0.12.2: water is claimable too — coastal waters and seas can be
      // delimited by hand (generation still grows realms over land only).
      const t = applyBiomeBrush(this.base, this.realms, cells, {
        biome: this.brush.realm, radius: this.brush.radius, x, y
      });
      return { changed: t > 0, needsDerive: false };
    }

    if (RIVER_TOOLS.has(tool)) {
      this.riverEdits ??= new Uint8Array(grid.n);
      const t = applyRiverTool(this.world, this.riverEdits, cells, { tool, x, y });
      return { changed: t > 0, needsDerive: t > 0 };
    }

    if (tool === "biome") {
      this.overrides ??= new Uint8Array(grid.n).fill(NO_OVERRIDE);
      const t = applyBiomeBrush(this.base, this.overrides, cells, {
        biome: this.brush.biome, radius: this.brush.radius, x, y
      });
      return { changed: t > 0, needsDerive: true };
    }

    // Elevation tools (raise/lower/smooth/water/land/mountain).
    this.edits ??= new Float32Array(grid.n);
    const t = applyBrush(this.base, this.edits, cells, {
      tool, radius: this.brush.radius, strength: this.brush.strength, x, y
    });
    return { changed: t > 0, needsDerive: true };
  }

  /**
   * Commit the open stroke. @returns {{committed: boolean, stroke, channel,
   *   painted, movedLabel, needsDerive, fields}|null}
   */
  endStroke() {
    const stroke = this.#stroke;
    const painted = !!stroke?.cells.size;
    const movedLabel = !!this.dragLabel;
    if (painted) {
      this.#undoStack.push(stroke);
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
      this.#redoStack = [];
    }
    this.#stroke = null;
    this.dragLabel = null;
    if (!painted && !movedLabel) return null;
    const channel = movedLabel && !painted ? "labels" : stroke.channel;
    return {
      committed: true, stroke, channel, painted, movedLabel,
      needsDerive: !OVERLAY_CHANNELS.has(channel),
      fields: CHANNEL_FIELDS[channel] ?? null
    };
  }

  /** Revert the open stroke from the recorded pre-stroke values. */
  cancelStroke() {
    if (this.#stroke?.cells.size) this.applyStroke(this.#stroke);
    if (this.dragLabel) {
      this.labelOffsets = { ...this.labelOffsets };
      if (this.dragLabel.prev) this.labelOffsets[this.dragLabel.key] = this.dragLabel.prev;
      else delete this.labelOffsets[this.dragLabel.key];
    }
    this.#stroke = null;
    this.dragLabel = null;
  }

  /* -------------------------------------------- */
  /*  History                                      */
  /* -------------------------------------------- */

  #channelTarget(channel) {
    return {
      biome: this.overrides, river: this.riverEdits, elev: this.edits,
      site: this.sites, road: this.roads, realm: this.realms
    }[channel];
  }

  /** Write a stroke's cell values into its channel; returns the inverse. */
  applyStroke(stroke) {
    const target = this.#channelTarget(stroke.channel);
    if (!target) return null;
    const inverse = new Map();
    for (const [c, v] of stroke.cells) {
      inverse.set(c, target[c]);
      target[c] = v;
    }
    return { channel: stroke.channel, cells: inverse };
  }

  #applyHistory(from, into) {
    const stroke = from.pop();
    if (!stroke) return null;
    const inverse = this.applyStroke(stroke);
    if (inverse) into.push(inverse);
    return {
      channel: stroke.channel,
      needsDerive: !OVERLAY_CHANNELS.has(stroke.channel),
      fields: CHANNEL_FIELDS[stroke.channel] ?? null
    };
  }

  undo() { return this.#applyHistory(this.#undoStack, this.#redoStack); }
  redo() { return this.#applyHistory(this.#redoStack, this.#undoStack); }

  /* -------------------------------------------- */
  /*  Names and realms                             */
  /* -------------------------------------------- */

  /** Set (or clear, with empty value) a feature name. */
  setName(key, value) {
    this.names = { ...this.names };
    if (value) this.names[key] = value;
    else delete this.names[key];
  }

  /** Realm ids in use: painted in the channel or holding a name. */
  realmIdsInUse() {
    const ids = new Set();
    if (this.realms) for (const v of this.realms) if (v) ids.add(v);
    for (const k of Object.keys(this.names ?? {})) {
      if (/^k\d+$/.test(k)) ids.add(Number(k.slice(1)));
    }
    return ids;
  }

  /** Lowest free realm id, or -1 when the u8 channel is exhausted. */
  allocRealmId() {
    const used = this.realmIdsInUse();
    let id = 1;
    while (used.has(id) && id < 255) id++;
    return used.has(id) ? -1 : id;
  }

  /**
   * Remove a realm entirely: territory to wilderness, name and label offset
   * dropped. NOT undoable (ids are reused): clears both history stacks.
   */
  deleteRealm(id) {
    if (this.realms) {
      for (let c = 0; c < this.realms.length; c++) {
        if (this.realms[c] === id) this.realms[c] = 0;
      }
    }
    this.clearHistory();
    this.setName(`k${id}`, null);
    this.labelOffsets = { ...this.labelOffsets };
    delete this.labelOffsets[`k${id}`];
    if (this.brush.realm === id) {
      this.brush.realm = [...this.realmIdsInUse()].sort((a, b) => a - b)[0] ?? 0;
    }
  }

  /** Reset every manual channel (procedural world remains). */
  reset() {
    this.edits = this.overrides = this.riverEdits = null;
    this.sites = this.roads = this.realms = null;
    this.markers = {};
    this.names = {};
    this.labelOffsets = {};
    this.clearHistory();
  }

  /* -------------------------------------------- */
  /*  Flags payload                                */
  /* -------------------------------------------- */

  /**
   * Dotted-key update object for Scene#update. `fields` limits the write to
   * the given flag names (null = everything). Object flags merge on update,
   * so the sparse maps use the explicit deletion syntax when empty.
   */
  flagsUpdate(fields = null) {
    const want = f => !fields || fields.includes(f);
    const update = {};
    if (want("edits")) update["flags.hexworld.edits"] = encodeEdits(this.edits);
    if (want("biomes")) update["flags.hexworld.biomes"] = encodeOverrides(this.overrides);
    if (want("rivers")) update["flags.hexworld.rivers"] = encodeBytes(this.riverEdits);
    if (want("sites")) update["flags.hexworld.sites"] = encodeBytes(this.sites);
    if (want("markers")) {
      if (Object.keys(this.markers).length) update["flags.hexworld.markers"] = this.markers;
      else update["flags.hexworld.-=markers"] = null;
    }
    if (want("roads")) update["flags.hexworld.roads"] = encodeBytes(this.roads);
    if (want("realms")) update["flags.hexworld.realms"] = encodeBytes(this.realms);
    if (want("stats") && this.world) update["flags.hexworld.stats"] = this.world.stats;
    if (want("names")) {
      if (Object.keys(this.names).length) update["flags.hexworld.names"] = this.names;
      else update["flags.hexworld.-=names"] = null;
    }
    if (want("labels")) {
      if (Object.keys(this.labelOffsets).length) update["flags.hexworld.labels"] = this.labelOffsets;
      else update["flags.hexworld.-=labels"] = null;
    }
    return update;
  }
}
