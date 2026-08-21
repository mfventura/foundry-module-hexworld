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
import { nameKeyAt, makeNamer, i18nNamePatterns } from "../generator/names.js";
import {
  encodeEdits, decodeEdits, encodeOverrides, decodeOverrides,
  encodeBytes, decodeBytes, NO_OVERRIDE
} from "../lib/codec.js";
import { TerrainMesh } from "./terrain-mesh.js";
import { BrushHud } from "./brush-hud.js";
import { cellIndexAt } from "../ui/cell-info.js";
import { siteRenderContext } from "../render/site-icons.js";
import { activateHexTab } from "../ui/tool-tabs.js";
import { labelAt } from "../render/labels.js";

const UNDO_LIMIT = 20;
const RIVER_TOOLS = new Set(["riverAdd", "riverRemove"]);
const ROUTE_TOOLS = new Set(["roadMinor", "roadMajor"]);
/** Tools that act on a single click instead of dragging an area. */
const CLICK_TOOLS = new Set([...RIVER_TOOLS, ...ROUTE_TOOLS, "site", "rename"]);
const PAINT_TOOLS = new Set([
  "raise", "lower", "smooth", "water", "land", "mountain", "biome",
  "site", "roadErase", "rename", "realm", "labelMove", ...RIVER_TOOLS, ...ROUTE_TOOLS
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
  /** @type {Uint8Array|null} realm id per cell (0 = wilderness) */
  realms = null;
  /** @type {Record<string, string>} feature names (sparse, from flags) */
  names = {};
  /** @type {Record<string, [number, number]>} manual label offsets (grid px) */
  labelOffsets = {};
  /** @type {{key: string, bx: number, by: number}|null} label being dragged */
  #dragLabel = null;
  /** Client-local label visibility (HUD toggle). */
  showLabels = true;
  world = null;
  brush = { radius: 3, strength: 0.06, biome: B.GRASSLAND, site: SITE.VILLAGE, realm: 1 };
  /** First endpoint of a pending two-click road route. */
  #routeAnchor = -1;
  /** Current render mode: terrain | height | temp | moist (client-local). */
  viewMode = "terrain";

  #mesh = null;
  #hud = null;
  #painting = false;
  /** @type {{channel: "elev"|"biome"|"river", cells: Map<number, number>}|null} */
  #strokeUndo = null;
  /** Stroke committed by the immediately-preceding _onClickLeft (same gesture). */
  #lastClickStroke = null;
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
    const areaTool = !CLICK_TOOLS.has(tool) && tool !== "labelMove";
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
    this.#lastClickStroke = null;
    this.#painting = false;
    this.#routeAnchor = -1;
    this.base = this.edits = this.overrides = this.riverEdits = null;
    this.sites = this.roads = this.realms = this.world = null;
    this.names = {};
    this.labelOffsets = {};
    this.#dragLabel = null;
  }

  /** Attach the render-only extras (channels are attached by the callers). */
  #attachOverlays() {
    if (!this.world) return;
    this.world.siteRender = siteRenderContext();
    this.world.names = this.names;
    this.world.labelOffsets = this.labelOffsets;
    this.world.showLabels = this.showLabels;
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
      this.realms = decodeBytes(f.realms ?? null, this.base.grid.n);
      this.names = { ...(f.names ?? {}) };
      this.labelOffsets = { ...(f.labels ?? {}) };
      this.world = deriveWorld(this.base, this.edits, this.overrides, this.riverEdits);
      this.world.sites = this.sites;
      this.world.roads = this.roads;
      this.world.realms = this.realms;
      this.#attachOverlays();
      this.#mesh = new TerrainMesh();
      this.#mesh.draw(this.world, this.viewMode);
      // If the FA face was not rasterizable yet, repaint once fonts settle so
      // site glyphs never stay missing on the first draw.
      document.fonts?.ready?.then?.(() => this.repaint());
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
    if (tool === "realm") return "realm";
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
    this.#lastClickStroke = null;
    this.#beginStroke();
    this.#paintAt(p);
    const stroke = this.#strokeUndo;
    this.#endStroke();
    // MIM fires clickLeft on pointerdown and the same gesture may continue
    // into a drag: remember the stroke so _onDragLeftStart can ADOPT it
    // instead of painting the origin a second time.
    if (stroke?.cells.size) this.#lastClickStroke = stroke;
  }

  _onDragLeftStart(event) {
    if (!this.#canPaint()) return;
    this.#painting = true;
    const adopted = this.#lastClickStroke;
    this.#lastClickStroke = null;
    if (adopted && this.#undoStack[this.#undoStack.length - 1] === adopted) {
      // Continue the click's stroke: origin already painted and recorded.
      this.#undoStack.pop();
      this.#strokeUndo = adopted;
      return;
    }
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
    // A canceled drag reverts instead of committing: the pre-stroke values
    // are already recorded in the stroke's cells map.
    if (this.#strokeUndo?.cells.size) this.#applyStroke(this.#strokeUndo);
    if (this.#dragLabel) {
      this.labelOffsets = { ...this.labelOffsets };
      if (this.#dragLabel.prev) this.labelOffsets[this.#dragLabel.key] = this.#dragLabel.prev;
      else delete this.labelOffsets[this.#dragLabel.key];
    }
    this.#strokeUndo = null;
    this.#dragLabel = null;
    this.#refresh();
  }

  #paintAt(point) {
    const d = canvas.dimensions;
    const x = point.x - d.sceneX;
    const y = point.y - d.sceneY;
    const tool = this.activeTool;
    if (tool === "rename") {
      this.#renameAt(x, y); // async dialog; fire and forget
      return;
    }
    if (tool === "labelMove") {
      if (!this.world) return;
      if (!this.#dragLabel) {
        const e = labelAt(this.world, x, y, this.world.grid.size * 1.2);
        if (e) {
          this.#dragLabel = {
            key: e.key, bx: e.bx, by: e.by,
            prev: this.labelOffsets[e.key] ?? null // restored on drag cancel
          };
        }
        return;
      }
      this.labelOffsets = {
        ...this.labelOffsets,
        [this.#dragLabel.key]: [Math.round(x - this.#dragLabel.bx), Math.round(y - this.#dragLabel.by)]
      };
      const now = performance.now();
      if (now - this.#lastDerive >= 80) {
        this.#lastDerive = now;
        this.repaint();
      }
      return;
    }
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
    } else if (tool === "realm") {
      this.realms ??= new Uint8Array(this.base.grid.n);
      applyBiomeBrush(this.base, this.realms, this.#strokeUndo?.cells, {
        biome: this.brush.realm, radius: this.brush.radius, x, y,
        // Realms are a land-only channel (generateRealms enforces the same);
        // the wilderness eraser may still clean up water cells.
        skip: this.brush.realm > 0 ? (c => !!this.world?.isWater[c]) : null
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
    this.world.realms = this.realms;
    this.#attachOverlays();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** Repaint with fresh settings/names/labels without re-deriving. */
  repaint() {
    if (!this.world) return;
    this.#attachOverlays();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** HUD toggle: show or hide the name labels (client-local). */
  setShowLabels(show) {
    this.showLabels = !!show;
    this.repaint();
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
    this.#dragLabel = null;
    this.#refresh();
    this.#persist();
  }

  /** Right-click with the label tool returns a label to its automatic spot. */
  _onClickRight(event) {
    if (this.activeTool === "labelMove" && game.user.isGM && this.world) {
      const p = event.interactionData?.origin;
      if (p) {
        const d = canvas.dimensions;
        this.#resetLabelAt(p.x - d.sceneX, p.y - d.sceneY);
      }
      return;
    }
    super._onClickRight?.(event);
  }

  async #resetLabelAt(x, y) {
    const e = labelAt(this.world, x, y, this.world.grid.size * 1.2);
    if (!e || !this.labelOffsets[e.key]) return;
    this.labelOffsets = { ...this.labelOffsets };
    delete this.labelOffsets[e.key];
    this.repaint();
    await canvas.scene?.update({ [`flags.hexworld.labels.-=${e.key}`]: null }, { hexworldLocal: true });
  }

  /** Name-edit dialog for a key; persists and repaints. @returns {Promise<boolean>} changed */
  async #promptRename(key, initial = null) {
    const current = this.names?.[key] ?? initial ?? "";
    const value = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize("HEXWORLD.RenameTitle") },
      content: `<div class="form-group"><label>${game.i18n.localize("HEXWORLD.NameLabel")}</label>
        <input type="text" name="featureName" value="${foundry.utils.escapeHTML(current)}" autofocus></div>`,
      ok: {
        label: "HEXWORLD.Save",
        callback: (_event, button) => button.form.elements.featureName.value.trim()
      },
      rejectClose: false
    });
    if (value === null || value === undefined || value === (this.names?.[key] ?? "")) return false;
    this.names = { ...this.names };
    let update;
    if (value) {
      this.names[key] = value;
      update = { [`flags.hexworld.names.${key}`]: value };
    } else {
      delete this.names[key];
      update = { [`flags.hexworld.names.-=${key}`]: null };
    }
    this.repaint();
    this.#hud?.render();
    await canvas.scene?.update(update, { hexworldLocal: true });
    return true;
  }

  /** Rename (or name) the feature under the pointer via a small dialog. */
  async #renameAt(x, y) {
    if (!this.world) return;
    const c = cellIndexAt(this.world, x, y);
    if (c < 0) return;
    const key = nameKeyAt(this.world, this.sites, c);
    if (!key) {
      ui.notifications.info(game.i18n.localize("HEXWORLD.RenameNothing"));
      return;
    }
    await this.#promptRename(key);
  }

  /* -------------------------------------------- */
  /*  Realm management (HUD buttons)               */
  /* -------------------------------------------- */

  /** Realm ids in use: painted in the channel or holding a name. */
  realmIdsInUse() {
    const ids = new Set();
    if (this.realms) for (const v of this.realms) if (v) ids.add(v);
    for (const k of Object.keys(this.names ?? {})) {
      if (/^k\d+$/.test(k)) ids.add(Number(k.slice(1)));
    }
    return ids;
  }

  /** Found a new realm: pick a name, select it in the palette, paint away. */
  async createRealm() {
    if (!this.world) return;
    const used = this.realmIdsInUse();
    let id = 1;
    while (used.has(id) && id < 255) id++;
    if (used.has(id)) {
      ui.notifications.warn(game.i18n.localize("HEXWORLD.RealmLimit"));
      return;
    }
    // Suggestion seeded from existing names so it cannot collide with them
    // (it is only a dialog default the GM can edit freely).
    const usedNames = new Set(Object.values(this.names ?? {}));
    const suggested = i18nNamePatterns().realm(makeNamer(() => Math.random(), usedNames)());
    const named = await this.#promptRename(`k${id}`, suggested);
    if (!named) return;
    this.brush.realm = id;
    activateHexTab("sites", "realm");
    ui.notifications.info(game.i18n.localize("HEXWORLD.RealmCreated"));
  }

  /** Rename the realm currently selected in the palette. */
  async renameSelectedRealm() {
    const id = this.brush.realm;
    if (!id || !this.realmIdsInUse().has(id)) {
      ui.notifications.info(game.i18n.localize("HEXWORLD.RealmNoneSelected"));
      return;
    }
    await this.#promptRename(`k${id}`);
  }

  /** Delete the selected realm: its land becomes wilderness (not undoable). */
  async deleteSelectedRealm() {
    const id = this.brush.realm;
    if (!id || !this.realmIdsInUse().has(id)) {
      ui.notifications.info(game.i18n.localize("HEXWORLD.RealmNoneSelected"));
      return;
    }
    const name = this.names?.[`k${id}`] ?? `${game.i18n.localize("HEXWORLD.RealmsTitle")} ${id}`;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("HEXWORLD.RealmDeleteTitle") },
      content: `<p>${game.i18n.format("HEXWORLD.RealmDeleteConfirm", { name: foundry.utils.escapeHTML(name) })}</p>`,
      rejectClose: false
    });
    if (!confirmed) return;

    // Clear the territory. NOT undoable: createRealm reuses freed ids, so an
    // undone delete could graft this territory onto a future realm — both
    // stacks are dropped instead (the confirm dialog says so).
    if (this.realms) {
      for (let c = 0; c < this.realms.length; c++) {
        if (this.realms[c] === id) this.realms[c] = 0;
      }
    }
    this.#undoStack = [];
    this.#redoStack = [];
    this.names = { ...this.names };
    delete this.names[`k${id}`];
    // Drop the realm's manual label offset too, or a future realm reusing
    // this id would inherit a pinned label position out of nowhere.
    this.labelOffsets = { ...this.labelOffsets };
    delete this.labelOffsets[`k${id}`];
    this.brush.realm = [...this.realmIdsInUse()].sort((a, b) => a - b)[0] ?? 0;
    this.#refresh();
    this.#hud?.render();
    await canvas.scene?.update({
      [`flags.hexworld.names.-=k${id}`]: null,
      [`flags.hexworld.labels.-=k${id}`]: null
    }, { hexworldLocal: true });
    await this.#persist();
  }

  /* -------------------------------------------- */
  /*  Persistence and public actions               */
  /* -------------------------------------------- */

  async #persist() {
    const scene = canvas.scene;
    if (!scene || !this.world) return;
    const update = {
      "flags.hexworld.edits": encodeEdits(this.edits),
      "flags.hexworld.biomes": encodeOverrides(this.overrides),
      "flags.hexworld.rivers": encodeBytes(this.riverEdits),
      "flags.hexworld.sites": encodeBytes(this.sites),
      "flags.hexworld.roads": encodeBytes(this.roads),
      "flags.hexworld.realms": encodeBytes(this.realms),
      "flags.hexworld.stats": this.world.stats
    };
    // Object flags merge on update: adding keys is safe, but clearing the
    // whole map (reset) needs the explicit deletion syntax.
    if (this.names && Object.keys(this.names).length) update["flags.hexworld.names"] = this.names;
    else update["flags.hexworld.-=names"] = null;
    if (this.labelOffsets && Object.keys(this.labelOffsets).length) update["flags.hexworld.labels"] = this.labelOffsets;
    else update["flags.hexworld.-=labels"] = null;
    await scene.update(update, { hexworldLocal: true });
  }

  /** Write a stroke's cell values into its channel; returns the inverse stroke. */
  #applyStroke(stroke) {
    const target = {
      biome: this.overrides, river: this.riverEdits, elev: this.edits,
      site: this.sites, road: this.roads, realm: this.realms
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
    this.realms = null;
    this.names = {};
    this.labelOffsets = {};
    this.#undoStack = [];
    this.#redoStack = [];
    this.#refresh();
    this.#persist();
  }
}
