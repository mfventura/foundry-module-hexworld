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
import {
  encodeEdits, decodeEdits, encodeOverrides, decodeOverrides,
  encodeBytes, decodeBytes, NO_OVERRIDE
} from "../lib/codec.js";
import { TerrainMesh } from "./terrain-mesh.js";
import { BrushHud } from "./brush-hud.js";

const UNDO_LIMIT = 20;
const RIVER_TOOLS = new Set(["riverAdd", "riverRemove"]);
const PAINT_TOOLS = new Set(["raise", "lower", "smooth", "water", "land", "mountain", "biome", ...RIVER_TOOLS]);

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
  world = null;
  brush = { radius: 3, strength: 0.06, biome: B.GRASSLAND };
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
    const areaTool = !RIVER_TOOLS.has(tool);
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
    this.base = this.edits = this.overrides = this.riverEdits = this.world = null;
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
      this.world = deriveWorld(this.base, this.edits, this.overrides, this.riverEdits);
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

  #beginStroke() {
    const tool = this.activeTool;
    this.#strokeUndo = {
      channel: tool === "biome" ? "biome" : (RIVER_TOOLS.has(tool) ? "river" : "elev"),
      cells: new Map()
    };
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
    if (RIVER_TOOLS.has(this.activeTool)) return; // river tools are click-only
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
    if (RIVER_TOOLS.has(this.activeTool)) {
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
      "flags.hexworld.stats": this.world.stats
    }, { hexworldLocal: true });
  }

  /** Write a stroke's cell values into its channel; returns the inverse stroke. */
  #applyStroke(stroke) {
    const target = { biome: this.overrides, river: this.riverEdits, elev: this.edits }[stroke.channel];
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
    this.#undoStack = [];
    this.#redoStack = [];
    this.#refresh();
    this.#persist();
  }
}
