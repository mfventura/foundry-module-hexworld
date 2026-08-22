/**
 * HexWorldLayer — interaction layer for in-scene terrain editing.
 *
 * On scenes created by HexWorld (flags version >= 2) the layer rebuilds the
 * world deterministically from flags and renders it through a TerrainMesh.
 * All editing state and tool logic live in the shared WorldEditSession; this
 * class only maps Foundry's canvas events, dialogs and persistence onto it.
 */

import {
  WorldEditSession, PAINT_TOOLS, CLICK_TOOLS
} from "../edit/edit-session.js";
import { makeNamer, i18nNamePatterns } from "../generator/names.js";
import { TerrainMesh } from "./terrain-mesh.js";
import { BrushHud } from "./brush-hud.js";
import { siteRenderContext } from "../render/site-icons.js";
import { biomeArtContext, biomeArtEnabled } from "../render/biome-art.js";
import { labelAt } from "../render/labels.js";
import { activateHexTab } from "../ui/tool-tabs.js";
import { renameJournalFeature } from "../integration/journal-sync.js";
import { worldFlags } from "../lib/flags.js";

export class HexWorldLayer extends foundry.canvas.layers.InteractionLayer {
  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: "hexworld" });
  }

  session = new WorldEditSession();
  /** Current render mode: terrain | height | temp | moist | realms. */
  viewMode = "terrain";
  /** Client-local label visibility (HUD toggle). */
  showLabels = true;
  /** Client-local overlay visibility (HUD switches; hides, never deletes). */
  show = { realms: true, sites: true, roads: true, rivers: true };

  #mesh = null;
  #hud = null;
  #painting = false;
  /** Stroke committed by the immediately-preceding _onClickLeft (same gesture). */
  #lastClickStroke = null;
  #lastDerive = 0;
  /** @type {PIXI.Graphics|null} */
  #cursor = null;
  #onCursorMove = null;
  /** Serialized params of the current base (rebuild cache key). */
  #baseKey = null;

  constructor(...args) {
    super(...args);
    this.session.overlayExtras = () => ({
      siteRender: siteRenderContext(),
      showLabels: this.showLabels,
      show: { ...this.show },
      // Null while disabled or nothing is loaded yet; images that finish
      // loading later trigger ONE repaint so tiles never stay missing.
      biomeArt: biomeArtEnabled()
        ? biomeArtContext(this.session.world, () => this.repaint())
        : null
    });
  }

  /* ---- State the HUD and inspector read (delegated to the session) ---- */
  get world() { return this.session.world; }
  get brush() { return this.session.brush; }
  get names() { return this.session.names; }
  get realms() { return this.session.realms; }
  get labelOffsets() { return this.session.labelOffsets; }
  realmIdsInUse() { return this.session.realmIdsInUse(); }

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
    this.#painting = false;
    this.#lastClickStroke = null;
    this.session.clear();
  }

  /** Rebuild the world from the viewed scene's flags and (re)render it. */
  rebuildFromFlags() {
    // Respect a HUD the GM deliberately closed: only restore it if it was
    // open (or never created — first activation opens it anyway).
    const hudWasOpen = this.#hud ? this.#hud.rendered : true;
    const f = worldFlags(canvas.scene);
    // The base (grid + heightmap + moisture noise) only depends on params:
    // reuse it across rebuilds triggered by edits/names-only updates.
    const paramsKey = f ? JSON.stringify(f.params) : null;
    const reusableBase = paramsKey && paramsKey === this.#baseKey ? this.session.base : null;
    this.#destroyState();
    this.#baseKey = paramsKey;
    if (!f) return;
    try {
      this.session.loadFlags(f, reusableBase);
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

  /** Abort a pending two-click route (tool change, deactivation). */
  clearRouteAnchor() {
    this.session.routeAnchor = -1;
  }

  _onClickLeft(event) {
    if (!this.#canPaint()) return;
    const p = event.interactionData?.origin;
    if (!p) return;
    this.#lastClickStroke = null;
    const stroke = this.session.beginStroke(this.activeTool);
    this.#paintAt(p);
    this.#endStroke();
    // MIM fires clickLeft on pointerdown and the same gesture may continue
    // into a drag: remember the stroke so _onDragLeftStart can ADOPT it
    // instead of painting the origin a second time.
    if (stroke.cells.size) this.#lastClickStroke = stroke;
  }

  _onDragLeftStart(event) {
    if (!this.#canPaint()) return;
    this.#painting = true;
    const adopted = this.#lastClickStroke;
    this.#lastClickStroke = null;
    // Continue the click's stroke: origin already painted and recorded.
    if (adopted && this.session.adoptStroke(adopted)) return;
    // Click-only tools already acted in _onClickLeft (dialogs, anchors):
    // never re-run them for the drag of the same gesture.
    if (CLICK_TOOLS.has(this.activeTool)) return;
    this.session.beginStroke(this.activeTool);
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
    // A canceled drag reverts instead of committing.
    this.session.cancelStroke();
    this.#refresh();
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

  #paintAt(point) {
    const d = canvas.dimensions;
    const result = this.session.paint(this.activeTool, point.x - d.sceneX, point.y - d.sceneY);
    if (result.status === "rename") {
      if (result.key) this.#promptRename(result.key);
      else ui.notifications.info(game.i18n.localize("HEXWORLD.RenameNothing"));
      return;
    }
    if (result.status === "anchor-set") {
      ui.notifications.info(game.i18n.localize("HEXWORLD.RouteAnchorSet"));
      return;
    }
    if (result.status === "route-unreachable") {
      ui.notifications.warn(game.i18n.localize("HEXWORLD.RouteUnreachable"));
      return;
    }
    if (!result.changed) return;
    const now = performance.now();
    const interval = result.needsDerive ? (this.world.grid.n > 10000 ? 250 : 80) : 80;
    if (now - this.#lastDerive >= interval) {
      this.#lastDerive = now;
      if (result.needsDerive) this.#refresh();
      else this.repaint();
    }
  }

  #endStroke() {
    const result = this.session.endStroke();
    if (!result) return;
    if (result.needsDerive) this.#refresh();
    else this.repaint();
    this.#persist(result.fields);
  }

  #refresh() {
    if (!this.session.base) return;
    this.session.derive();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** Repaint with fresh settings/names/labels without re-deriving. */
  repaint() {
    if (!this.world) return;
    this.session.attach();
    this.#mesh?.draw(this.world, this.viewMode);
  }

  /** Switch the false-color view; repaints without re-deriving. */
  setViewMode(mode) {
    this.viewMode = mode;
    if (this.world) this.#mesh?.draw(this.world, mode);
  }

  /** HUD toggle: show or hide the name labels (client-local). */
  setShowLabels(show) {
    this.showLabels = !!show;
    this.repaint();
  }

  /** HUD switches: show/hide one overlay channel (client-local, data kept). */
  setShow(key, on) {
    if (key === "labels") return this.setShowLabels(on);
    if (!(key in this.show)) return;
    this.show[key] = !!on;
    this.repaint();
  }

  async #resetLabelAt(x, y) {
    const e = labelAt(this.world, x, y, this.world.grid.size * 1.2);
    if (!e || !this.session.labelOffsets[e.key]) return;
    this.session.labelOffsets = { ...this.session.labelOffsets };
    delete this.session.labelOffsets[e.key];
    this.repaint();
    await canvas.scene?.update({ [`flags.hexworld.labels.-=${e.key}`]: null }, { hexworldLocal: true });
  }

  /* -------------------------------------------- */
  /*  Naming dialogs                               */
  /* -------------------------------------------- */

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
    this.session.setName(key, value);
    const update = value
      ? { [`flags.hexworld.names.${key}`]: value }
      : { [`flags.hexworld.names.-=${key}`]: null };
    this.repaint();
    this.#hud?.render();
    await canvas.scene?.update(update, { hexworldLocal: true });
    // Renames follow through to an already-published journal page (no-op when
    // the scene has no journal or the feature has no page yet).
    renameJournalFeature(canvas.scene, key, value).catch(err =>
      console.error("HexWorld | Journal rename failed", err));
    return true;
  }

  /* -------------------------------------------- */
  /*  Realm management (HUD buttons)               */
  /* -------------------------------------------- */

  /** Found a new realm: pick a name, select it in the palette, paint away. */
  async createRealm() {
    if (!this.world) return;
    const id = this.session.allocRealmId();
    if (id < 0) {
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
    this.session.deleteRealm(id);
    this.repaint();
    this.#hud?.render();
    await canvas.scene?.update({
      [`flags.hexworld.names.-=k${id}`]: null,
      [`flags.hexworld.labels.-=k${id}`]: null
    }, { hexworldLocal: true });
    await this.#persist(["realms"]);
  }

  /* -------------------------------------------- */
  /*  Persistence and public actions               */
  /* -------------------------------------------- */

  /** Persist the given flag fields (null = everything). */
  async #persist(fields = null) {
    const scene = canvas.scene;
    if (!scene || !this.world) return;
    await scene.update(this.session.flagsUpdate(fields), { hexworldLocal: true });
  }

  #applyHistory(result) {
    if (!result) return;
    if (result.needsDerive) this.#refresh();
    else this.repaint();
    this.#persist(result.fields);
  }

  undo() {
    this.#applyHistory(this.session.undo());
  }

  redo() {
    this.#applyHistory(this.session.redo());
  }

  resetEdits() {
    if (!this.session.base) return;
    this.session.reset();
    this.#refresh();
    this.#persist();
  }
}
