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
import { applyBrush, applyBiomeBrush } from "../generator/brush.js";
import { B } from "../generator/biomes.js";
import { encodeEdits, decodeEdits, encodeOverrides, decodeOverrides, NO_OVERRIDE } from "../lib/codec.js";
import { TerrainMesh } from "./terrain-mesh.js";
import { BrushHud } from "./brush-hud.js";

const UNDO_LIMIT = 20;
const PAINT_TOOLS = new Set(["raise", "lower", "smooth", "water", "land", "mountain", "biome"]);

export class HexWorldLayer extends foundry.canvas.layers.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "hexworld" });
  }

  base = null;
  edits = null;
  /** @type {Uint8Array|null} painted biome overrides (NO_OVERRIDE = derived) */
  overrides = null;
  world = null;
  brush = { radius: 3, strength: 0.06, biome: B.GRASSLAND };

  #mesh = null;
  #hud = null;
  #painting = false;
  /** @type {{channel: "elev"|"biome", cells: Map<number, number>}|null} */
  #strokeUndo = null;
  /** @type {{channel: "elev"|"biome", cells: Map<number, number>}[]} */
  #undoStack = [];
  #lastDerive = 0;

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
    }
  }

  _deactivate() {
    super._deactivate();
    this.#hud?.close();
  }

  #destroyState() {
    this.#mesh?.destroy();
    this.#mesh = null;
    this.#hud?.close();
    this.#undoStack = [];
    this.#strokeUndo = null;
    this.#painting = false;
    this.base = this.edits = this.overrides = this.world = null;
  }

  /** Rebuild the world from the viewed scene's flags and (re)render it. */
  rebuildFromFlags() {
    this.#destroyState();
    const f = canvas.scene?.flags?.hexworld;
    if (!f?.params || (f.version ?? 1) < 2) return;
    try {
      this.base = buildBase(f.params);
      this.edits = decodeEdits(f.edits ?? null, this.base.grid.n);
      this.overrides = decodeOverrides(f.biomes ?? null, this.base.grid.n);
      this.world = deriveWorld(this.base, this.edits, this.overrides);
      this.#mesh = new TerrainMesh();
      this.#mesh.draw(this.world);
    } catch (err) {
      console.error("HexWorld | Failed to build terrain for the viewed scene", err);
      this.#destroyState();
    }
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
    this.#strokeUndo = {
      channel: this.activeTool === "biome" ? "biome" : "elev",
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
    if (this.activeTool === "biome") {
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
    this.world = deriveWorld(this.base, this.edits, this.overrides);
    this.#mesh?.draw(this.world);
  }

  #endStroke() {
    if (this.#strokeUndo?.cells.size) {
      this.#undoStack.push(this.#strokeUndo);
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
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
      "flags.hexworld.stats": this.world.stats
    }, { hexworldLocal: true });
  }

  undo() {
    const stroke = this.#undoStack.pop();
    if (!stroke) return;
    if (stroke.channel === "biome") {
      if (!this.overrides) return;
      for (const [c, prev] of stroke.cells) this.overrides[c] = prev;
    } else {
      if (!this.edits) return;
      for (const [c, prev] of stroke.cells) this.edits[c] = prev;
    }
    this.#refresh();
    this.#persist();
  }

  resetEdits() {
    if (!this.base) return;
    this.edits = null;
    this.overrides = null;
    this.#undoStack = [];
    this.#refresh();
    this.#persist();
  }
}
