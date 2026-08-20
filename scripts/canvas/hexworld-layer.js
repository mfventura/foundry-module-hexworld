/**
 * HexWorldLayer — interaction layer for in-scene terrain editing.
 *
 * On scenes created by HexWorld (flags version >= 2) the layer rebuilds the
 * world deterministically from flags (seed + params + edits) and renders it
 * through a TerrainMesh. GM brush strokes mutate the local edits, re-derive
 * hydrology/climate/biomes live, and persist the compressed deltas to the
 * scene flags on stroke end — other clients rebuild from the update.
 */

import { buildBase, deriveWorld } from "../generator/worldgen.js";
import { applyBrush, applyBiomeBrush, applyRiverTool } from "../generator/brush.js";
import { B } from "../generator/biomes.js";
import { SITE, routeRoad } from "../generator/sites.js";
import {
  encodeEdits, decodeEdits, encodeOverrides, decodeOverrides,
  encodeBytes, decodeBytes, NO_OVERRIDE
} from "../lib/codec.js";
import { TerrainMesh } from "./terrain-mesh.js";
import { BrushHud } from "./brush-hud.js";
import { cellIndexAt } from "../ui/cell-info.js";
import { configuredSiteIcons } from "../render/site-icons.js";

const UNDO_LIMIT = 20;
const RIVER_TOOLS = new Set(["riverAdd", "riverRemove"]);
const ROUTE_TOOLS = new Set(["roadMinor", "roadMajor"]);
/** Tools that act on a single click instead of dragging an area. */
const CLICK_TOOLS = new Set([...RIVER_TOOLS, ...ROUTE_TOOLS, "site"]);
const PAINT_TOOLS = new Set([
  "raise", "lower", "smooth", "water", "land", "mountain", "biome",
  "site", "roadErase", ...RIVER_TOOLS, ...ROUTE_TOOLS
]);

export class HexWorldLayer extends foundry.canvas.layers.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "hexworld" });
  }

  base = null;
  edits = null;
  /** @type {Uint8Array|null} painted biome overrides (NO_OVERRIDE = derived) */
  overrides = null;
  /** @type {Uint8Array|null} manual river edits (0 = derived) */
  riverEdits = null;
  /** @type {Uint8Array|null} settlements/POIs per cell (SITE values) */
  sites = null;
  /** @type {Uint8Array|null} road network per cell (ROAD values) */
  roads = null;
  world = null;
  brush = { radius: 3, strength: 0.06, biome: B.GRASSLAND, site: SITE.VILLAGE };
  /** First endpoint of a pending two-click road route. */
  #routeAnchor = -1;
  /** Current render mode: terrain | height | temp | moist (client-local). */
  viewMode = "terrain";

  #mesh = null;
  #hud = null;
  #painting = false;
  /** @type {{channel: "elev"|"biome"|"river", cells: Map<number, number>}|null} */
  #strokeUndo = null;
  /** @type {{channel: string, cells: Map<number, number>}[]} */
  #undoStack = [];
  /** @type {{channel: string, cells: Map<number, number>}[]} */
  #redoStack = [];
  #lastDerive = 0;
  /** @type {PIXI.Graphics|null} */
  #cursor = null;
  #onCursorMove = null;

  /** Whether the viewed scene is a HexWorld data-driven scene. */
  get isHexWorldScene() {
    return !!this.world;
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                    */
  /* -------------------------------------------- */

  async _draw(options) {
    await super._draw(options);
    this.rebuildFromFlags();
  }

  async _tearDown(options) {
    this.#destroyState();
    return super._tearDown(options);
  }

  _activate() {
    super._activate();
    if (game.user.isGM && this.world) {
      this.#hud ??= new BrushHud(this);
      this.#hud.render({ force: true });
      this.#activateCursor();
    }
  }

  _deactivate() {
    super._deactivate();
    this.#hud?.close();
    this.#deactivateCursor();
    this.clearRouteAnchor();
  }

  /* -------------------------------------------- */
  /*  Brush cursor                                 */
  /* -------------------------------------------- */

  #activateCursor() {
    this.#cursor ??= this.addChild(new PIXI.Graphics());
    this.#cursor.visible = false;
    this.#onCursorMove ??= ev => this.#updateCursor(ev);
    canvas.stage.on("pointermove", this.#onCursorMove);
  }

  #deactivateCursor() {
    if (this.#onCursorMove) canvas.stage.off("pointermove", this.#onCursorMove);
    if (this.#cursor) this.#cursor.visible = false;
  }

  #updateCursor(ev) {
    const cur = this.#cursor;
    if (!cur) return;
    const tool = this.activeTool;
    if (!this.world || !PAINT_TOOLS.has(tool)) { cur.visible = false; return; }
    const p = ev.getLocalPosition(canvas.stage);
    const areaTool = !CLICK_TOOLS.has(tool);
    const r = areaTool ? this.brush.radius * this.world.grid.size : this.world.grid.size * 0.3;
    cur.clear();
    cur.lineStyle(2, 0xffffff, 0.85);
    cur.beginFill(0xffffff, 0.08);
    cur.drawCircle(0, 0, r);
    cur.endFill();
    cur.position.set(p.x, p.y);
    cur.visible = true;
  }

  #destroyState() {
    this.#mesh?.destroy();
    this.#mesh = null;
    this.#hud?.close();
    this.#deactivateCursor();
    if (this.#cursor) {
      this.removeChild(this.#cursor);
      this.#cursor.destroy();
      this.#cursor = null;
    }
    this.#undoStack = [];
    this.#redoStack = [];
    this.#strokeUndo = null;
    this.#painting = false;
    this.#routeAnchor = -1;
    this.base = this.edits = this.overrides = this.riverEdits = null;
    this.sites = this.roads = this.world = null;
  }

  /** Rebuild the world from the viewed scene's flags and (re)render it. */
  rebuildFromFlags() {
    // Respect a HUD the GM deliberately closed: only restore it if it was
    // open (or never created — first activation opens it anyway).
    const hudWasOpen = this.#hud ? this.#hud.rendered : true;
    this.#destroyState();
    const f = canvas.scene?.flags?.hexworld;
    if (!f?.params || (f.version ?? 1) < 2) return;
    try {
      this.base = buildBase(f.params);
      this.edits = decodeEdits(f.edits ?? null, this.base.grid.n);
      this.overrides = decodeOverrides(f.biomes ?? null, this.base.grid.n);
      this.riverEdits = decodeBytes(f.rivers ?? null, this.base.grid.n);
      this.sites = decodeBytes(f.sites ?? null, this.base.grid.n);
      this.roads = decodeBytes(f.roads ?? null, this.base.grid.n);
      this.world = deriveWorld(this.base, this.edits, this.overrides, this.riverEdits);
      this.world.sites = this.sites;
      this.world.roads = this.roads;
      this.world.siteIcons = configuredSiteIcons();
      this.#mesh = new TerrainMesh();
      this.#mesh.draw(this.world, this.viewMode);
      // A rebuild while the layer is active (sea-level change, remote edit)
      // closed the HUD in #destroyState — bring it back.
      if (this.active && game.user.isGM) {
        if (hudWasOpen) {
          this.#hud ??= new BrushHud(this);
          this.#hud.render({ force: true });
        }
        this.#activateCursor();
      }
    } catch (err) {
      console.error("HexWorld | Failed to build terrain for the viewed scene", err);
      this.#destroyState();
    }
  }

  /** Show or hide the brush panel (scene-controls button). */
  toggleHud() {
    if (!game.user.isGM || !this.world) return;
    this.#hud ??= new BrushHud(this);
    if (this.#hud.rendered) this.#hud.close();
    else this.#hud.render({ force: true });
  }

  /* -------------------------------------------- */
  /*  Painting                                     */
  /* -------------------------------------------- */

  get activeTool() {
    const t = ui.controls?.tool;
    return typeof t === "string" ? t : (t?.name ?? "raise");
  }

  #canPaint() {
    return game.user.isGM && !!this.world && PAINT_TOOLS.has(this.activeTool);
  }

  #strokeChannelFor(tool) {
    if (tool === "biome") return "biome";
    if (RIVER_TOOLS.has(tool)) return "river";
    if (tool === "site") return "site";
    if (ROUTE_TOOLS.has(tool) || tool === "roadErase") return "road";
    return "elev";
  }

  #beginStroke() {
    this.#strokeUndo = {
      channel: this.#strokeChannelFor(this.activeTool),
      cells: new Map()
    };
  }

  /** Abort a pending two-click route (tool change, deactivation). */
  clearRouteAnchor() {
    this.#routeAnchor = -1;
  }

  _onClickLeft(event) {
    if (!this.#canPaint()) return;
    const p = event.interactionData?.origin;
    if (!p) return;
    this.#beginStroke();
    this.#paintAt(p);
    this.#endStroke();
  }

  _onDragLeftStart(event) {
    if (!this.#canPaint()) return;
    this.#painting = true;
    this.#beginStroke();
    const p = event.interactionData?.origin;
    if (p) this.#paintAt(p);
  }

  _onDragLeftMove(event) {
    if (!this.#painting) return;
    if (CLICK_TOOLS.has(this.activeTool)) return; // click-only tools never drag
    const p = event.interactionData?.destination;
    if (p) this.#paintAt(p);
  }

  _onDragLeftDrop(_event) {
    if (!this.#painting) return;
    this.#painting = false;
    this.#endStroke();
  }

  _onDragLeftCancel(event) {
    super._onDragLeftCancel?.(event);
    if (!this.#painting) return;
    this.#painting = false;
    this.#endStroke();
  }

  #paintAt(point) {
    const d = canvas.dimensions;
    const x = point.x - d.sceneX;
    const y = point.y - d.sceneY;
    const tool = this.activeTool;
    if (tool === "site") {
      const c = cellIndexAt(this.world, x, y);
      if (c < 0) return;
      this.sites ??= new Uint8Array(this.base.grid.n);
      const u = this.#strokeUndo?.cells;
      if (u && !u.has(c)) u.set(c, this.sites[c]);
      this.sites[c] = this.brush.site;
    } else if (ROUTE_TOOLS.has(tool)) {
      const c = cellIndexAt(this.world, x, y);
      if (c < 0) return;
      if (this.#routeAnchor < 0 || this.#routeAnchor === c) {
        this.#routeAnchor = c;
        ui.notifications.info(game.i18n.localize("HEXWORLD.RouteAnchorSet"));
        return;
      }
      this.roads ??= new Uint8Array(this.base.grid.n);
      const kind = tool === "roadMajor" ? 2 : 1;
      const touched = routeRoad(this.world, this.roads, this.#strokeUndo?.cells, this.#routeAnchor, c, kind);
      if (!touched) ui.notifications.warn(game.i18n.localize("HEXWORLD.RouteUnreachable"));
      this.#routeAnchor = c; // chain: the next click extends the route
    } else if (tool === "roadErase") {
      this.roads ??= new Uint8Array(this.base.grid.n);
      applyBiomeBrush(this.base, this.roads, this.#strokeUndo?.cells, {
        biome: 0, radius: this.brush.radius, x, y
      });
    } else if (RIVER_TOOLS.has(tool)) {
      if (!this.world) return;
      this.riverEdits ??= new Uint8Array(this.base.grid.n);
      applyRiverTool(this.world, this.riverEdits, this.#strokeUndo?.cells, {
        tool: this.activeTool, x, y
      });
    } else if (this.activeTool === "biome") {
      this.overrides ??= new Uint8Array(this.base.grid.n).fill(NO_OVERRIDE);
      applyBiomeBrush(this.base, this.overrides, this.#strokeUndo?.cells, {
        biome: this.brush.biome, radius: this.brush.radius, x, y
      });
    } else {
      this.edits ??= new Float32Array(this.base.grid.n);
      applyBrush(this.base, this.edits, this.#strokeUndo?.cells, {
        tool: this.activeTool,
        radius: this.brush.radius,
        strength: this.brush.strength,
        x, y
      });
    }
    const now = performance.now();
    const interval = this.base.grid.n > 10000 ? 250 : 80;
    if (now - this.#lastDerive >= interval) {
      this.#lastDerive = now;
      this.#refresh();
    }
  }

  #refresh() {
    if (!this.base) return;
    this.world = deriveWorld(this.base, this.edits, this.overrides, this.riverEdits);
    this.world.sites = this.sites;
    this.world.roads = this.roads;
    this.world.siteIcons = configuredSiteIcons();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** Repaint with fresh settings (icon changes) without re-deriving. */
  repaint() {
    if (!this.world) return;
    this.world.siteIcons = configuredSiteIcons();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** Switch the false-color view; repaints without re-deriving. */
  setViewMode(mode) {
    this.viewMode = mode;
    if (this.world) this.#mesh?.draw(this.world, mode);
  }

  #endStroke() {
    if (this.#strokeUndo?.cells.size) {
      this.#undoStack.push(this.#strokeUndo);
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
      this.#redoStack = []; // a new stroke invalidates the redo history
    }
    this.#strokeUndo = null;
    this.#refresh();
    this.#persist();
  }

  /* -------------------------------------------- */
  /*  Persistence and public actions               */
  /* -------------------------------------------- */

  async #persist() {
    const scene = canvas.scene;
    if (!scene || !this.world) return;
    await scene.update({
      "flags.hexworld.edits": encodeEdits(this.edits),
      "flags.hexworld.biomes": encodeOverrides(this.overrides),
      "flags.hexworld.rivers": encodeBytes(this.riverEdits),
      "flags.hexworld.sites": encodeBytes(this.sites),
      "flags.hexworld.roads": encodeBytes(this.roads),
      "flags.hexworld.stats": this.world.stats
    }, { hexworldLocal: true });
  }

  /** Write a stroke's cell values into its channel; returns the inverse stroke. */
  #applyStroke(stroke) {
    const target = {
      biome: this.overrides, river: this.riverEdits, elev: this.edits,
      site: this.sites, road: this.roads
    }[stroke.channel];
    if (!target) return null;
    const inverse = new Map();
    for (const [c, v] of stroke.cells) {
      inverse.set(c, target[c]);
      target[c] = v;
    }
    return { channel: stroke.channel, cells: inverse };
  }

  undo() {
    const stroke = this.#undoStack.pop();
    if (!stroke) return;
    const inverse = this.#applyStroke(stroke);
    if (inverse) this.#redoStack.push(inverse);
    this.#refresh();
    this.#persist();
  }

  redo() {
    const stroke = this.#redoStack.pop();
    if (!stroke) return;
    const inverse = this.#applyStroke(stroke);
    if (inverse) this.#undoStack.push(inverse);
    this.#refresh();
    this.#persist();
  }

  resetEdits() {
    if (!this.base) return;
    this.edits = null;
    this.overrides = null;
    this.riverEdits = null;
    this.sites = null;
    this.roads = null;
    this.#undoStack = [];
    this.#redoStack = [];
    this.#refresh();
    this.#persist();
  }
}
