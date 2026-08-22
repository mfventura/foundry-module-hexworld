/**
 * HexWorld generator window (ApplicationV2). Left: parameters. Right: live
 * preview + terrain-editing toolbar + stats. Generation is deterministic from
 * the seed; all editing state and tool logic live in the shared
 * WorldEditSession — this class maps DOM events, params and scene
 * creation/update onto it.
 */

import { buildBase, MAX_CELLS } from "../generator/worldgen.js";
import { TEMPLATES } from "../generator/heightmap.js";
import { PAINTABLE_BIOMES, BIOME_COLORS } from "../generator/biomes.js";
import { renderWorld, previewScale } from "../render/renderer.js";
import { createSceneFromWorld } from "../scene/scene-builder.js";
import { randomSeedString, makeRng } from "../lib/random.js";
import { generateSettlements, SITE } from "../generator/sites.js";
import { generateRealms } from "../generator/realms.js";
import { generateNames, i18nNamePatterns } from "../generator/names.js";
import { siteTypeContext, markerIconOptions } from "../canvas/brush-hud.js";
import { siteRenderContext } from "../render/site-icons.js";
import { biomeArtContext, biomeArtEnabled } from "../render/biome-art.js";
import { labelAt } from "../render/labels.js";
import { cellIndexAt, describeCell } from "./cell-info.js";
import { worldFlags } from "../lib/flags.js";
import { WorldEditSession, CLICK_TOOLS } from "../edit/edit-session.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DEFAULT_PARAMS = {
  sceneName: "",
  seed: "",
  template: "continents",
  gridType: 2, // CONST.GRID_TYPES.HEXODDR
  cols: 64,
  rows: 48,
  cellSize: 100,
  waterFraction: 0.58,
  climate: "temperate",
  moisture: 1.0,
  riverDensity: 0.5,
  settlements: 0.5,
  realms: 0.5,
  distance: 10,
  units: "km"
};

export class HexWorldGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static open() {
    this.#instance ??= new this();
    this.#instance.#editScene = null;
    this.#instance.#algo = 2;
    this.#instance.render({ force: true });
    return this.#instance;
  }

  /**
   * Open the generator bound to an existing HexWorld scene: params come from
   * its flags, painted channels are loaded, grid-structure fields are locked
   * (the cell arrays must keep their length) and "Apply to scene" writes the
   * regenerated params + channels back to the scene flags.
   */
  static openForScene(scene) {
    const flags = worldFlags(scene);
    if (!flags) return this.open();
    const app = (this.#instance ??= new this());
    app.#editScene = scene;
    app.#algo = flags.params.algo ?? 1; // never upgrade an existing world's terrain
    app.#pendingLoad = true;
    app.render({ force: true });
    return app;
  }

  /** Re-render the open instance (icon settings changed). */
  static repaintPreview() {
    if (this.#instance?.rendered) this.#instance.render();
  }

  #session = new WorldEditSession();
  #lastScale = 1;

  #tool = "raise";
  #viewMode = "terrain";
  /** Client-local overlay visibility (toolbar switches; hides, never deletes). */
  #show = { labels: true, realms: true, sites: true, roads: true, rivers: true };
  #painting = false;
  #lastDerive = 0;
  /** @type {Scene|null} scene being edited in place (openForScene) */
  #editScene = null;
  /** Pipeline version for the next generation (2 for new worlds). */
  #algo = 2;
  #pendingLoad = false;

  constructor(...args) {
    super(...args);
    this.#session.overlayExtras = () => ({
      siteRender: siteRenderContext(),
      showLabels: this.#show.labels,
      show: { ...this.#show },
      biomeArt: biomeArtEnabled()
        ? biomeArtContext(this.#session.world, () => HexWorldGeneratorApp.repaintPreview())
        : null
    });
  }

  get #world() { return this.#session.world; }
  get #base() { return this.#session.base; }

  static DEFAULT_OPTIONS = {
    id: "hexworld-generator",
    classes: ["hexworld-app"],
    window: {
      title: "HEXWORLD.AppTitle",
      icon: "fa-solid fa-earth-europe",
      resizable: true
    },
    position: { width: 1020, height: "auto" },
    actions: {
      randomSeed: HexWorldGeneratorApp.#onRandomSeed,
      generate: HexWorldGeneratorApp.#onGenerate,
      createScene: HexWorldGeneratorApp.#onCreateScene,
      applyToScene: HexWorldGeneratorApp.#onApplyToScene,
      undoEdit: HexWorldGeneratorApp.#onUndoEdit,
      redoEdit: HexWorldGeneratorApp.#onRedoEdit,
      resetEdits: HexWorldGeneratorApp.#onResetEdits,
      regenSites: HexWorldGeneratorApp.#onRegenSites
    }
  };

  static PARTS = {
    main: { template: "modules/hexworld/templates/generator.hbs" }
  };

  async _prepareContext(_options) {
    const saved = this.#editScene
      ? this.#editScene.flags.hexworld.params
      : (game.settings.get("hexworld", "lastParams") ?? {});
    const p = foundry.utils.mergeObject(foundry.utils.deepClone(DEFAULT_PARAMS), saved, { inplace: false });
    if (!p.sceneName) p.sceneName = game.i18n.localize("HEXWORLD.DefaultSceneName");
    if (!p.seed) p.seed = randomSeedString();

    const T = CONST.GRID_TYPES;
    const gridTypes = [
      { value: T.HEXODDR, label: game.i18n.localize("HEXWORLD.GridHexOddR") },
      { value: T.HEXEVENR, label: game.i18n.localize("HEXWORLD.GridHexEvenR") },
      { value: T.HEXODDQ, label: game.i18n.localize("HEXWORLD.GridHexOddQ") },
      { value: T.HEXEVENQ, label: game.i18n.localize("HEXWORLD.GridHexEvenQ") },
      { value: T.SQUARE, label: game.i18n.localize("HEXWORLD.GridSquare") }
    ].map(o => ({ ...o, selected: o.value === Number(p.gridType) }));

    const templates = ["continents", "pangea", "archipelago", "islands"].map(v => ({
      value: v,
      label: game.i18n.localize(`HEXWORLD.Template${v.charAt(0).toUpperCase()}${v.slice(1)}`),
      selected: v === p.template
    }));

    const climates = [
      { value: "temperate", label: game.i18n.localize("HEXWORLD.ClimateTemperate") },
      { value: "cold", label: game.i18n.localize("HEXWORLD.ClimateCold") },
      { value: "tropical", label: game.i18n.localize("HEXWORLD.ClimateTropical") },
      { value: "planet", label: game.i18n.localize("HEXWORLD.ClimatePlanet") }
    ].map(o => ({ ...o, selected: o.value === p.climate }));

    const biomeSwatches = PAINTABLE_BIOMES.map(({ id, key }) => ({
      id,
      color: BIOME_COLORS[id],
      label: game.i18n.localize(`HEXWORLD.Biome${key}`),
      active: id === this.#session.brush.biome
    }));

    return {
      p, gridTypes, templates, climates, biomeSwatches,
      siteTypes: siteTypeContext(this.#session.brush.site, this.#session.brush.markerIcon),
      markerIcons: markerIconOptions(this.#session.brush.markerIcon),
      editSceneName: this.#editScene?.name ?? null
    };
  }

  _onRender(_context, _options) {
    const root = this.element;
    // The template's <form> is only a field container — never navigate.
    root.querySelector("form.hw-form")?.addEventListener("submit", ev => ev.preventDefault());

    // Live value labels for range sliders.
    for (const range of root.querySelectorAll("input[type=range]")) {
      const output = range.closest(".hw-range")?.querySelector("output");
      const sync = () => { if (output) output.textContent = `${Math.round(Number(range.value) * 100)}%`; };
      range.addEventListener("input", sync);
      sync();
    }

    // Each template has a water fraction it was tuned for — adopt it on change.
    const tplSelect = root.querySelector("select[name=template]");
    tplSelect?.addEventListener("change", () => {
      const water = TEMPLATES[tplSelect.value]?.water;
      if (water == null) return;
      const range = root.querySelector("input[name=waterFraction]");
      if (!range) return;
      range.value = String(water);
      range.dispatchEvent(new Event("input"));
    });

    // Terrain editing: tool selection and paint events on the preview canvas.
    for (const btn of root.querySelectorAll(".hw-editbar [data-tool]")) {
      btn.addEventListener("click", () => {
        this.#tool = btn.dataset.tool;
        this.#refreshToolButtons();
      });
    }

    // Biome palette: picking a color also switches to the biome tool.
    for (const btn of root.querySelectorAll(".hw-palette .hw-swatch[data-biome]")) {
      btn.addEventListener("click", () => {
        this.#session.brush.biome = Number(btn.dataset.biome);
        this.#tool = "biome";
        for (const b of root.querySelectorAll(".hw-palette .hw-swatch[data-biome]")) {
          b.classList.toggle("active", b === btn);
        }
        this.#refreshToolButtons();
      });
    }

    // Site palette: picking a type also switches to the site tool.
    for (const btn of root.querySelectorAll(".hw-site-swatch")) {
      btn.addEventListener("click", () => {
        this.#session.brush.site = Number(btn.dataset.site);
        this.#tool = "site";
        for (const b of root.querySelectorAll(".hw-site-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        this.#refreshToolButtons();
      });
    }

    // Free-marker icon: picking one is an intent to place markers.
    const markerSel = root.querySelector("select[name=markerIcon]");
    markerSel?.addEventListener("change", () => {
      this.#session.brush.markerIcon = markerSel.value;
      this.#session.brush.site = SITE.MARKER;
      this.#tool = "site";
      this.render(); // refresh the marker swatch icon + active states
    });

    // Brush sliders: restore from state and track changes (a re-render must
    // not silently reset them).
    const brush = this.#session.brush;
    for (const [name, key] of [["brushRadius", "radius"], ["brushStrength", "strength"]]) {
      const input = root.querySelector(`input[name=${name}]`);
      if (!input) continue;
      input.value = String(brush[key]);
      input.addEventListener("input", () => { brush[key] = Number(input.value); });
    }

    // False-color view selector.
    const viewSel = root.querySelector("select[name=viewMode]");
    if (viewSel) {
      viewSel.value = this.#viewMode;
      viewSel.addEventListener("change", () => {
        this.#viewMode = viewSel.value;
        this.#drawPreview();
      });
    }

    // Artwork toggle: writes the client setting, whose onChange repaints the
    // preview and the scene alike.
    const artChk = root.querySelector("input[name=showArt]");
    if (artChk) {
      artChk.checked = biomeArtEnabled();
      artChk.addEventListener("change", () => game.settings.set("hexworld", "useBiomeArt", artChk.checked));
    }

    // Layer visibility switches: hide/show overlay channels, never the data.
    for (const chk of root.querySelectorAll("input[name=layerToggle]")) {
      chk.checked = this.#show[chk.dataset.layer] !== false;
      chk.addEventListener("change", () => {
        this.#show[chk.dataset.layer] = chk.checked;
        this.#session.attach(); // refresh world.show/showLabels
        this.#drawPreview();
      });
    }

    const canvas = root.querySelector("canvas.hw-canvas");
    if (canvas) {
      canvas.addEventListener("pointerdown", ev => this.#onPaintStart(ev));
      canvas.addEventListener("pointermove", ev => this.#onPaintMove(ev));
      canvas.addEventListener("pointerup", ev => this.#onPaintEnd(ev));
      canvas.addEventListener("pointercancel", ev => this.#onPaintEnd(ev));
      canvas.addEventListener("pointermove", ev => this.#onHover(ev));
      canvas.addEventListener("pointerleave", () => this.#onHoverEnd());
      canvas.addEventListener("contextmenu", ev => this.#onCanvasContext(ev));
    }

    // Scene edit mode: lock grid-structure fields (arrays must keep length)
    // and load the scene's world on first render.
    if (this.#editScene) {
      for (const name of ["cols", "rows", "cellSize", "gridType"]) {
        const el = root.querySelector(`[name=${name}]`);
        if (el) el.disabled = true;
      }
      if (this.#pendingLoad) {
        this.#pendingLoad = false;
        this.#loadFromScene();
      }
    }

    this.#refreshToolButtons();
    this.#refreshEditbar();
    if (this.#world) {
      this.#drawPreview();
      this.#updateStats();
      const createBtn = root.querySelector("button[data-action=createScene]");
      if (createBtn) createBtn.disabled = false;
      const applyBtn = root.querySelector("button[data-action=applyToScene]");
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  _onClose(options) {
    super._onClose(options);
    this.#editScene = null;
    this.#algo = 2;
  }

  /** Load base + painted channels from the edited scene's flags. */
  #loadFromScene() {
    const flags = worldFlags(this.#editScene);
    if (!flags) return;
    try {
      this.#session.loadFlags(flags);
      this.#drawPreview();
      this.#updateStats();
    } catch (err) {
      console.error("HexWorld | Failed to load the scene into the generator", err);
      ui.notifications.error(game.i18n.localize("HEXWORLD.ErrGenerate"));
    }
  }

  /* -------------------------------------------- */
  /*  Parameters                                   */
  /* -------------------------------------------- */

  #readParams() {
    const form = this.element.querySelector("form.hw-form");
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
    // Structure fields are locked in scene-edit mode: force them from the
    // scene so disabled inputs can never corrupt the cell-array length.
    if (this.#editScene) {
      const sp = this.#editScene.flags.hexworld.params;
      data.gridType = sp.gridType;
      data.cols = sp.cols;
      data.rows = sp.rows;
      data.cellSize = sp.cellSize;
    }
    return {
      algo: this.#algo,
      sceneName: String(data.sceneName || game.i18n.localize("HEXWORLD.DefaultSceneName")),
      seed: String(data.seed || "").trim(),
      template: String(data.template),
      gridType: Number(data.gridType),
      cols: Math.round(clamp(data.cols, 8, 250)),
      rows: Math.round(clamp(data.rows, 8, 250)),
      cellSize: Math.round(clamp(data.cellSize, 50, 300)),
      waterFraction: clamp(data.waterFraction, 0.1, 0.85),
      climate: String(data.climate),
      moisture: clamp(data.moisture, 0.5, 1.5),
      riverDensity: clamp(data.riverDensity, 0, 1),
      settlements: clamp(data.settlements ?? 0.5, 0, 1),
      realms: clamp(data.realms ?? 0.5, 0, 1),
      distance: clamp(data.distance, 0.01, 100000),
      units: String(data.units || "km")
    };
  }

  /* -------------------------------------------- */
  /*  Preview, stats and hover                     */
  /* -------------------------------------------- */

  #drawPreview() {
    const canvas = this.element.querySelector("canvas.hw-canvas");
    if (!canvas || !this.#world) return;
    const box = this.element.querySelector(".hw-preview");
    const maxW = Math.max(300, (box?.clientWidth ?? 640) - 8);
    this.#lastScale = previewScale(this.#world, maxW, 540);
    this.#session.attach();
    renderWorld(this.#world, canvas, this.#lastScale, this.#viewMode);
  }

  #derive() {
    if (!this.#base) return;
    this.#session.derive();
    this.#drawPreview();
    this.#updateStats();
  }

  /* Brush cursor overlay + cell inspector, both fed by canvas pointermove. */
  #onHover(ev) {
    const cursor = this.element.querySelector(".hw-brush-cursor");
    const info = this.element.querySelector(".hw-inspect");
    if (!this.#base || !this.#world) { this.#onHoverEnd(); return; }
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();

    if (cursor) {
      const isClick = CLICK_TOOLS.has(this.#tool) || this.#tool === "labelMove";
      const worldR = isClick ? this.#base.grid.size * 0.3 : this.#session.brush.radius * this.#base.grid.size;
      const screenR = worldR * this.#lastScale * (rect.width / (canvas.width || 1));
      const parentRect = cursor.offsetParent?.getBoundingClientRect() ?? rect;
      cursor.style.display = "block";
      cursor.style.width = `${screenR * 2}px`;
      cursor.style.height = `${screenR * 2}px`;
      cursor.style.left = `${ev.clientX - parentRect.left}px`;
      cursor.style.top = `${ev.clientY - parentRect.top}px`;
    }

    if (info) {
      const p = this.#canvasPoint(ev);
      const c = p ? cellIndexAt(this.#world, p.x, p.y) : -1;
      info.textContent = c >= 0 ? describeCell(this.#world, c) : "";
    }
  }

  #onHoverEnd() {
    const cursor = this.element.querySelector(".hw-brush-cursor");
    if (cursor) cursor.style.display = "none";
    const info = this.element.querySelector(".hw-inspect");
    if (info) info.textContent = "";
  }

  /** Right-click with the label tool returns a label to its automatic spot. */
  #onCanvasContext(ev) {
    if (this.#tool !== "labelMove" || !this.#world) return;
    ev.preventDefault();
    const point = this.#canvasPoint(ev);
    if (!point) return;
    const e = labelAt(this.#world, point.x, point.y, this.#base.grid.size * 1.2);
    if (!e || !this.#session.labelOffsets[e.key]) return;
    this.#session.labelOffsets = { ...this.#session.labelOffsets };
    delete this.#session.labelOffsets[e.key];
    this.#drawPreview();
  }

  #updateStats() {
    const el = this.element.querySelector(".hw-stats");
    if (!el) return;
    if (!this.#world) {
      el.textContent = game.i18n.localize("HEXWORLD.NoWorld");
      return;
    }
    const s = this.#world.stats;
    el.textContent = game.i18n.format("HEXWORLD.StatsSummary", {
      cells: s.cells,
      land: s.landPct,
      rivers: s.riverCells,
      lakes: s.lakeCells
    });
  }

  #refreshToolButtons() {
    this.#session.routeAnchor = -1; // tool changes abort a pending route
    for (const btn of this.element.querySelectorAll(".hw-editbar [data-tool]")) {
      btn.classList.toggle("active", btn.dataset.tool === this.#tool);
    }
  }

  #refreshEditbar() {
    const bar = this.element.querySelector(".hw-editbar");
    if (!bar) return;
    const ready = !!this.#base;
    bar.classList.toggle("disabled", !ready);
    for (const el of bar.querySelectorAll("button, input")) el.disabled = !ready;
    const palette = this.element.querySelector(".hw-palette-bar");
    if (palette) {
      palette.classList.toggle("disabled", !ready);
      for (const el of palette.querySelectorAll("button, select")) el.disabled = !ready;
    }
    const undoBtn = bar.querySelector("button[data-action=undoEdit]");
    if (undoBtn) undoBtn.disabled = !ready || !this.#session.hasUndo;
    const redoBtn = bar.querySelector("button[data-action=redoEdit]");
    if (redoBtn) redoBtn.disabled = !ready || !this.#session.hasRedo;
  }

  /* -------------------------------------------- */
  /*  Terrain painting                             */
  /* -------------------------------------------- */

  /** Canvas event -> world pixel coordinates (undo CSS scaling + preview scale). */
  #canvasPoint(ev) {
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (ev.clientX - rect.left) * (canvas.width / rect.width) / this.#lastScale,
      y: (ev.clientY - rect.top) * (canvas.height / rect.height) / this.#lastScale
    };
  }

  #onPaintStart(ev) {
    if (!this.#base || ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.#painting = true;
    this.#session.beginStroke(this.#tool);
    this.#applyPaint(ev);
  }

  #onPaintMove(ev) {
    if (!this.#painting) return;
    if (CLICK_TOOLS.has(this.#tool)) return; // click-only tools never drag
    ev.preventDefault();
    this.#applyPaint(ev);
  }

  #onPaintEnd(ev) {
    if (!this.#painting) return;
    this.#painting = false;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (_err) { /* already released */ }
    const result = this.#session.endStroke();
    if (result) {
      if (result.needsDerive) this.#derive();
      else this.#drawPreview();
    }
    this.#refreshEditbar();
  }

  #applyPaint(ev) {
    const point = this.#canvasPoint(ev);
    if (!point || !this.#world) return;
    const result = this.#session.paint(this.#tool, point.x, point.y);
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
    const interval = result.needsDerive ? (this.#base.grid.n > 10000 ? 220 : 60) : 60;
    if (now - this.#lastDerive >= interval) {
      this.#lastDerive = now;
      if (result.needsDerive) this.#derive();
      else this.#drawPreview();
    }
  }

  /** Rename dialog (preview-local: state only, saved on create/apply). */
  async #promptRename(key) {
    const current = this.#session.names?.[key] ?? "";
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
    if (value === null || value === undefined || value === current) return;
    this.#session.setName(key, value);
    this.#drawPreview();
  }

  /* -------------------------------------------- */
  /*  Actions                                      */
  /* -------------------------------------------- */

  static #onRandomSeed(_event, _target) {
    const input = this.element.querySelector("input[name=seed]");
    if (input) input.value = randomSeedString();
  }

  static async #onGenerate(event, target) {
    const params = this.#readParams();
    if (!params.seed) {
      params.seed = randomSeedString();
      const input = this.element.querySelector("input[name=seed]");
      if (input) input.value = params.seed;
    }
    if (params.cols * params.rows > MAX_CELLS) {
      ui.notifications.warn(game.i18n.format("HEXWORLD.ErrTooManyCells", {
        n: params.cols * params.rows, max: MAX_CELLS
      }));
      return;
    }

    target.disabled = true;
    try {
      await game.settings.set("hexworld", "lastParams", params);
      // Let the disabled state paint before the synchronous generation work.
      await new Promise(r => setTimeout(r, 20));
      // In scene-edit mode the painted channels survive a re-generation: the
      // grid structure is locked, so the arrays still fit the new base.
      this.#session.setBase(buildBase(params), { keepChannels: !!this.#editScene });
      this.#drawPreview();
      this.#updateStats();
      // Fresh worlds get settlements and names right away; edited scenes
      // keep theirs and only receive names for still-unnamed features.
      if (!this.#editScene) this.#generateSites(params);
      else this.#ensureNames(params);
      const createBtn = this.element.querySelector("button[data-action=createScene]");
      if (createBtn) createBtn.disabled = false;
      const applyBtn = this.element.querySelector("button[data-action=applyToScene]");
      if (applyBtn) applyBtn.disabled = false;
      this.#refreshEditbar();
    } catch (err) {
      console.error(err);
      ui.notifications.error(game.i18n.localize("HEXWORLD.ErrGenerate"));
    } finally {
      target.disabled = false;
    }
  }

  /** Bake procedural settlements/POIs/roads/realms + names into the channels. */
  #generateSites(params) {
    const s = this.#session;
    if (!s.world) return;
    const { sites, roads } = generateSettlements(s.world, makeRng(params.seed + ":sites"), params.settlements ?? 0.5);
    s.sites = sites;
    s.roads = roads;
    s.markers = {}; // the sites channel was replaced: manual markers went with it
    s.attach();
    s.realms = generateRealms(s.world, sites, params.realms ?? 0.5);
    s.attach();
    // Sites/realms are replaced, so their names/offsets are rebuilt — but
    // manual names and pinned labels of WATERS (rivers/lakes/seas), which a
    // settlements regen does not touch, must survive.
    const keepWater = map => {
      const kept = {};
      for (const [k, v] of Object.entries(map ?? {})) {
        if (k.startsWith("r") || k.startsWith("l")) kept[k] = v;
      }
      return kept;
    };
    s.names = generateNames(s.world, sites, keepWater(s.names), makeRng(params.seed + ":names"), i18nNamePatterns());
    s.labelOffsets = keepWater(s.labelOffsets);
    // Wholesale replacement is not stroke-undoable: drop stale history.
    s.clearHistory();
    s.attach();
    this.#drawPreview();
    this.#refreshEditbar();
  }

  /** Add names for unnamed features only — manual renames are untouched. */
  #ensureNames(params) {
    const s = this.#session;
    if (!s.world) return;
    s.names = generateNames(s.world, s.sites, s.names, makeRng(params.seed + ":names"), i18nNamePatterns());
    s.attach();
    this.#drawPreview();
  }

  static #onRegenSites(_event, _target) {
    if (!this.#world) return;
    this.#generateSites(this.#readParams());
  }

  static #onUndoEdit(_event, _target) {
    this.#applyHistory(this.#session.undo());
  }

  static #onRedoEdit(_event, _target) {
    this.#applyHistory(this.#session.redo());
  }

  #applyHistory(result) {
    if (!result) return;
    if (result.needsDerive) this.#derive();
    else this.#drawPreview();
    this.#refreshEditbar();
  }

  static #onResetEdits(_event, _target) {
    if (!this.#base) return;
    this.#session.reset();
    this.#derive();
    this.#refreshEditbar();
  }

  /** Write the previewed world (params + painted channels) back to the scene. */
  static async #onApplyToScene(_event, target) {
    if (!this.#editScene || !this.#world) return;
    target.disabled = true;
    try {
      const update = {
        "flags.hexworld.params": this.#world.params,
        ...this.#session.flagsUpdate()
      };
      // The session's names/labels writes merge on update: replace them
      // ATOMICALLY by also deleting the stale keys in this same update — a
      // separate clear-then-write pair could lose every name if the second
      // write failed.
      const sceneFlags = this.#editScene.flags?.hexworld ?? {};
      const objectChannels = {
        names: this.#session.names,
        labels: this.#session.labelOffsets,
        markers: this.#session.markers
      };
      for (const [field, next] of Object.entries(objectChannels)) {
        for (const k of Object.keys(sceneFlags[field] ?? {})) {
          if (!(k in next)) update[`flags.hexworld.${field}.-=${k}`] = null;
        }
      }
      await this.#editScene.update(update);
      ui.notifications.info(game.i18n.format("HEXWORLD.NotifySceneUpdated", { name: this.#editScene.name }));
    } catch (err) {
      console.error(err);
      ui.notifications.error(game.i18n.localize("HEXWORLD.ErrGenerate"));
    } finally {
      target.disabled = false;
    }
  }

  static async #onCreateScene(_event, target) {
    if (!this.#world) {
      ui.notifications.warn(game.i18n.localize("HEXWORLD.ErrNoWorld"));
      return;
    }
    const params = this.#readParams();
    target.disabled = true;
    try {
      this.#session.attach();
      const scene = await createSceneFromWorld(this.#world, {
        sceneName: params.sceneName,
        distance: params.distance,
        units: params.units
      });
      ui.notifications.info(game.i18n.format("HEXWORLD.NotifySceneCreated", { name: scene.name }));
      await scene.view();
    } catch (err) {
      console.error(err);
      ui.notifications.error(game.i18n.localize("HEXWORLD.ErrGenerate"));
    } finally {
      target.disabled = false;
    }
  }
}
