/**
 * HexWorld generator window (ApplicationV2). Left: parameters. Right: live
 * preview + terrain-editing toolbar + stats. Generation is deterministic from
 * the seed; manual edits are stored as an elevation delta layer on top of the
 * procedural base, and the downstream pipeline (hydrology, climate, biomes)
 * is re-derived as you paint.
 */

import { buildBase, deriveWorld, MAX_CELLS } from "../generator/worldgen.js";
import { TEMPLATES } from "../generator/heightmap.js";
import { applyBrush, applyBiomeBrush, applyRiverTool } from "../generator/brush.js";
import { PAINTABLE_BIOMES, BIOME_COLORS } from "../generator/biomes.js";
import { renderWorld, previewScale } from "../render/renderer.js";
import { createSceneFromWorld } from "../scene/scene-builder.js";
import { randomSeedString, makeRng } from "../lib/random.js";
import { SITE, generateSettlements, routeRoad } from "../generator/sites.js";
import { generateRealms } from "../generator/realms.js";
import { generateNames, i18nNamePatterns, nameKeyAt } from "../generator/names.js";
import { siteTypeContext } from "../canvas/brush-hud.js";
import { siteRenderContext } from "../render/site-icons.js";
import { labelAt } from "../render/labels.js";
import {
  NO_OVERRIDE, encodeEdits, decodeEdits, encodeOverrides, decodeOverrides,
  encodeBytes, decodeBytes
} from "../lib/codec.js";
import { cellIndexAt, describeCell } from "./cell-info.js";
import { worldFlags } from "../lib/flags.js";

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

const UNDO_LIMIT = 20;
const RIVER_TOOLS = new Set(["riverAdd", "riverRemove"]);
const ROUTE_TOOLS = new Set(["roadMinor", "roadMajor"]);
const CLICK_TOOLS = new Set([...RIVER_TOOLS, ...ROUTE_TOOLS, "site", "rename"]);

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

  /** @type {object|null} result of buildBase() */
  #base = null;
  /** @type {Float32Array|null} painted elevation deltas */
  #edits = null;
  /** @type {Uint8Array|null} painted biome overrides (NO_OVERRIDE = derived) */
  #overrides = null;
  /** @type {Uint8Array|null} manual river edits (0 = derived) */
  #riverEdits = null;
  /** @type {Uint8Array|null} settlements/POIs per cell */
  #sites = null;
  /** @type {Uint8Array|null} road network per cell */
  #roads = null;
  /** @type {Uint8Array|null} realm id per cell */
  #realms = null;
  /** @type {Record<string, string>|null} feature names */
  #names = null;
  /** @type {Record<string, [number, number]>|null} manual label offsets */
  #labelOffsets = null;
  /** @type {{key: string, bx: number, by: number}|null} */
  #dragLabel = null;
  #routeAnchor = -1;
  #brushSite = SITE.VILLAGE;
  /** @type {object|null} derived world currently shown in the preview */
  #world = null;
  #lastScale = 1;

  #tool = "raise";
  #brushBiome = PAINTABLE_BIOMES[0].id;
  // Brush settings live in app state, not the DOM: a re-render (e.g. icon
  // settings changed) must not silently reset them.
  #brushRadius = 3;
  #brushStrength = 0.06;
  #viewMode = "terrain";
  #painting = false;
  /** @type {{channel: "elev"|"biome"|"river", cells: Map<number, number>}|null} */
  #strokeUndo = null;
  /** @type {{channel: string, cells: Map<number, number>}[]} */
  #undoStack = [];
  /** @type {{channel: string, cells: Map<number, number>}[]} */
  #redoStack = [];
  #lastDerive = 0;
  /** @type {Scene|null} scene being edited in place (openForScene) */
  #editScene = null;
  /** Pipeline version for the next generation (2 for new worlds). */
  #algo = 2;
  #pendingLoad = false;

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
      active: id === this.#brushBiome
    }));

    const siteTypes = siteTypeContext(this.#brushSite);

    return {
      p, gridTypes, templates, climates, biomeSwatches, siteTypes,
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
        this.#brushBiome = Number(btn.dataset.biome);
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
        this.#brushSite = Number(btn.dataset.site);
        this.#tool = "site";
        for (const b of root.querySelectorAll(".hw-site-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        this.#refreshToolButtons();
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

    // Brush sliders: restore from state and track changes.
    for (const [name, get, set] of [
      ["brushRadius", () => this.#brushRadius, v => { this.#brushRadius = v; }],
      ["brushStrength", () => this.#brushStrength, v => { this.#brushStrength = v; }]
    ]) {
      const input = root.querySelector(`input[name=${name}]`);
      if (!input) continue;
      input.value = String(get());
      input.addEventListener("input", () => set(Number(input.value)));
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
    const flags = this.#editScene?.flags?.hexworld;
    if (!flags?.params) return;
    try {
      this.#base = buildBase(flags.params);
      const n = this.#base.grid.n;
      this.#edits = decodeEdits(flags.edits ?? null, n);
      this.#overrides = decodeOverrides(flags.biomes ?? null, n);
      this.#riverEdits = decodeBytes(flags.rivers ?? null, n);
      this.#sites = decodeBytes(flags.sites ?? null, n);
      this.#roads = decodeBytes(flags.roads ?? null, n);
      this.#realms = decodeBytes(flags.realms ?? null, n);
      this.#names = { ...(flags.names ?? {}) };
      this.#labelOffsets = { ...(flags.labels ?? {}) };
      this.#undoStack = [];
      this.#redoStack = [];
      this.#derive();
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
  /*  Preview and stats                            */
  /* -------------------------------------------- */

  #drawPreview() {
    const canvas = this.element.querySelector("canvas.hw-canvas");
    if (!canvas || !this.#world) return;
    const box = this.element.querySelector(".hw-preview");
    const maxW = Math.max(300, (box?.clientWidth ?? 640) - 8);
    this.#lastScale = previewScale(this.#world, maxW, 540);
    this.#world.siteRender = siteRenderContext();
    this.#world._labelLayout = null; // quick paths mutate channels in place
    renderWorld(this.#world, canvas, this.#lastScale, this.#viewMode);
  }

  /** Re-render the open instance (icon settings changed). */
  static repaintPreview() {
    if (this.#instance?.rendered) this.#instance.render();
  }

  /* Brush cursor overlay + cell inspector, both fed by canvas pointermove. */
  #onHover(ev) {
    const cursor = this.element.querySelector(".hw-brush-cursor");
    const info = this.element.querySelector(".hw-inspect");
    if (!this.#base || !this.#world) { this.#onHoverEnd(); return; }
    const canvas = ev.currentTarget;
    const rect = canvas.getBoundingClientRect();

    if (cursor) {
      const isClick = CLICK_TOOLS.has(this.#tool);
      const { radius } = this.#brushSettings();
      const worldR = isClick ? this.#base.grid.size * 0.3 : radius * this.#base.grid.size;
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

  /** Right-click with the label tool returns a label to its automatic spot. */
  #onCanvasContext(ev) {
    if (this.#tool !== "labelMove" || !this.#world || !this.#labelOffsets) return;
    ev.preventDefault();
    const point = this.#canvasPoint(ev);
    if (!point) return;
    const e = labelAt(this.#world, point.x, point.y, this.#base.grid.size * 1.2);
    if (!e || !this.#labelOffsets[e.key]) return;
    this.#labelOffsets = { ...this.#labelOffsets };
    delete this.#labelOffsets[e.key];
    this.#world.labelOffsets = this.#labelOffsets;
    this.#drawPreview();
  }

  #onHoverEnd() {
    const cursor = this.element.querySelector(".hw-brush-cursor");
    if (cursor) cursor.style.display = "none";
    const info = this.element.querySelector(".hw-inspect");
    if (info) info.textContent = "";
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
    this.#routeAnchor = -1; // tool changes abort a pending route
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
      for (const el of palette.querySelectorAll("button")) el.disabled = !ready;
    }
    const undoBtn = bar.querySelector("button[data-action=undoEdit]");
    if (undoBtn) undoBtn.disabled = !ready || !this.#undoStack.length;
    const redoBtn = bar.querySelector("button[data-action=redoEdit]");
    if (redoBtn) redoBtn.disabled = !ready || !this.#redoStack.length;
  }

  /** Write a stroke's cell values into its channel; returns the inverse stroke. */
  #applyStroke(stroke) {
    const target = {
      biome: this.#overrides, river: this.#riverEdits, elev: this.#edits,
      site: this.#sites, road: this.#roads
    }[stroke.channel];
    if (!target) return null;
    const inverse = new Map();
    for (const [c, v] of stroke.cells) {
      inverse.set(c, target[c]);
      target[c] = v;
    }
    return { channel: stroke.channel, cells: inverse };
  }

  #derive() {
    if (!this.#base) return;
    this.#world = deriveWorld(this.#base, this.#edits, this.#overrides, this.#riverEdits);
    this.#world.sites = this.#sites;
    this.#world.roads = this.#roads;
    this.#world.realms = this.#realms;
    this.#world.names = this.#names ?? {};
    this.#world.labelOffsets = this.#labelOffsets ?? {};
    this.#drawPreview();
    this.#updateStats();
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

  #brushSettings() {
    return { radius: this.#brushRadius, strength: this.#brushStrength };
  }

  #onPaintStart(ev) {
    if (!this.#base || ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.#painting = true;
    this.#strokeUndo = { channel: this.#strokeChannel(), cells: new Map() };
    this.#applyBrush(ev);
  }

  #strokeChannel() {
    const t = this.#tool;
    if (t === "biome") return "biome";
    if (RIVER_TOOLS.has(t)) return "river";
    if (t === "site") return "site";
    if (ROUTE_TOOLS.has(t) || t === "roadErase") return "road";
    return "elev";
  }

  #onPaintMove(ev) {
    if (!this.#painting) return;
    if (CLICK_TOOLS.has(this.#tool)) return; // click-only tools never drag
    ev.preventDefault();
    this.#applyBrush(ev);
  }

  #onPaintEnd(ev) {
    if (!this.#painting) return;
    this.#painting = false;
    this.#dragLabel = null;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (_err) { /* already released */ }
    if (this.#strokeUndo?.cells.size) {
      this.#undoStack.push(this.#strokeUndo);
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
      this.#redoStack = []; // a new stroke invalidates the redo history
    }
    this.#strokeUndo = null;
    this.#derive();
    this.#refreshEditbar();
  }

  #applyBrush(ev) {
    const point = this.#canvasPoint(ev);
    if (!point) return;
    const { grid } = this.#base;
    const { radius, strength } = this.#brushSettings();
    if (this.#tool === "rename") {
      this.#renameAt(point); // async dialog; fire and forget
      return;
    }
    if (this.#tool === "labelMove") {
      if (!this.#world) return;
      if (!this.#dragLabel) {
        const e = labelAt(this.#world, point.x, point.y, this.#base.grid.size * 1.2);
        if (e) this.#dragLabel = { key: e.key, bx: e.bx, by: e.by };
        return;
      }
      this.#labelOffsets = {
        ...(this.#labelOffsets ?? {}),
        [this.#dragLabel.key]: [Math.round(point.x - this.#dragLabel.bx), Math.round(point.y - this.#dragLabel.by)]
      };
      this.#world.labelOffsets = this.#labelOffsets;
      const now = performance.now();
      if (now - this.#lastDerive >= 60) {
        this.#lastDerive = now;
        this.#drawPreview();
      }
      return;
    }
    if (this.#tool === "site") {
      const c = this.#world ? cellIndexAt(this.#world, point.x, point.y) : -1;
      if (c < 0) return;
      this.#sites ??= new Uint8Array(grid.n);
      const u = this.#strokeUndo?.cells;
      if (u && !u.has(c)) u.set(c, this.#sites[c]);
      this.#sites[c] = this.#brushSite;
      this.#world.sites = this.#sites;
      this.#drawPreview();
      return;
    }
    if (ROUTE_TOOLS.has(this.#tool)) {
      const c = this.#world ? cellIndexAt(this.#world, point.x, point.y) : -1;
      if (c < 0) return;
      if (this.#routeAnchor < 0 || this.#routeAnchor === c) {
        this.#routeAnchor = c;
        ui.notifications.info(game.i18n.localize("HEXWORLD.RouteAnchorSet"));
        return;
      }
      this.#roads ??= new Uint8Array(grid.n);
      const kind = this.#tool === "roadMajor" ? 2 : 1;
      const touched = routeRoad(this.#world, this.#roads, this.#strokeUndo?.cells, this.#routeAnchor, c, kind);
      if (!touched) ui.notifications.warn(game.i18n.localize("HEXWORLD.RouteUnreachable"));
      this.#routeAnchor = c;
      this.#world.roads = this.#roads;
      this.#drawPreview();
      return;
    }
    if (this.#tool === "roadErase") {
      this.#roads ??= new Uint8Array(grid.n);
      applyBiomeBrush(this.#base, this.#roads, this.#strokeUndo?.cells, {
        biome: 0, radius, x: point.x, y: point.y
      });
      if (this.#world) this.#world.roads = this.#roads;
      this.#drawPreview();
      return;
    }
    if (RIVER_TOOLS.has(this.#tool)) {
      if (!this.#world) return;
      this.#riverEdits ??= new Uint8Array(grid.n);
      applyRiverTool(this.#world, this.#riverEdits, this.#strokeUndo?.cells, {
        tool: this.#tool, x: point.x, y: point.y
      });
    } else if (this.#tool === "biome") {
      this.#overrides ??= new Uint8Array(grid.n).fill(NO_OVERRIDE);
      applyBiomeBrush(this.#base, this.#overrides, this.#strokeUndo?.cells, {
        biome: this.#brushBiome, radius, x: point.x, y: point.y
      });
    } else {
      this.#edits ??= new Float32Array(grid.n);
      applyBrush(this.#base, this.#edits, this.#strokeUndo?.cells, {
        tool: this.#tool, radius, strength, x: point.x, y: point.y
      });
    }

    // Live feedback, throttled harder on big maps where a derive is costlier.
    const now = performance.now();
    const interval = grid.n > 10000 ? 220 : 60;
    if (now - this.#lastDerive >= interval) {
      this.#lastDerive = now;
      this.#derive();
    }
  }

  /** Rename (or name) the feature under the preview pointer. */
  async #renameAt(point) {
    if (!this.#world) return;
    const c = cellIndexAt(this.#world, point.x, point.y);
    if (c < 0) return;
    const key = nameKeyAt(this.#world, this.#sites, c);
    if (!key) {
      ui.notifications.info(game.i18n.localize("HEXWORLD.RenameNothing"));
      return;
    }
    const current = this.#names?.[key] ?? "";
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
    this.#names = { ...(this.#names ?? {}) };
    if (value) this.#names[key] = value;
    else delete this.#names[key];
    if (this.#world) this.#world.names = this.#names;
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
      this.#base = buildBase(params);
      // In scene-edit mode the painted channels survive a re-generation: the
      // grid structure is locked, so the arrays still fit the new base.
      if (!this.#editScene) {
        this.#edits = null;
        this.#overrides = null;
        this.#riverEdits = null;
        this.#sites = null;
        this.#roads = null;
        this.#realms = null;
        this.#labelOffsets = null;
      }
      this.#undoStack = [];
      this.#redoStack = [];
      if (!this.#editScene) this.#names = null;
      this.#derive();
      // Fresh worlds get settlements and names right away; edited scenes
      // keep theirs and only receive names for still-unnamed features.
      if (!this.#editScene) this.#generateSites(params);
      else this.#ensureNames(params);
      const createBtn = this.element.querySelector("button[data-action=createScene]");
      if (createBtn) createBtn.disabled = false;
      this.#refreshEditbar();
    } catch (err) {
      console.error(err);
      ui.notifications.error(game.i18n.localize("HEXWORLD.ErrGenerate"));
    } finally {
      target.disabled = false;
    }
  }

  /** Bake procedural settlements/POIs/roads + fresh names into the channels. */
  #generateSites(params) {
    if (!this.#world) return;
    const rng = makeRng(params.seed + ":sites");
    const { sites, roads } = generateSettlements(this.#world, rng, params.settlements ?? 0.5);
    this.#sites = sites;
    this.#roads = roads;
    this.#world.sites = sites;
    this.#world.roads = roads;
    this.#realms = generateRealms(this.#world, sites, params.realms ?? 0.5);
    this.#world.realms = this.#realms;
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
    this.#names = generateNames(
      this.#world, sites, keepWater(this.#names), makeRng(params.seed + ":names"), i18nNamePatterns()
    );
    this.#world.names = this.#names;
    const keptOffsets = keepWater(this.#labelOffsets);
    this.#labelOffsets = Object.keys(keptOffsets).length ? keptOffsets : null;
    this.#world.labelOffsets = keptOffsets;
    // Wholesale replacement is not stroke-undoable: drop stale history.
    this.#undoStack = [];
    this.#redoStack = [];
    this.#drawPreview();
    this.#refreshEditbar();
  }

  /** Add names for unnamed features only — manual renames are untouched. */
  #ensureNames(params) {
    if (!this.#world) return;
    this.#names = generateNames(
      this.#world, this.#sites, this.#names, makeRng(params.seed + ":names"), i18nNamePatterns()
    );
    this.#world.names = this.#names;
    this.#drawPreview();
  }

  static #onRegenSites(_event, _target) {
    if (!this.#world) return;
    this.#generateSites(this.#readParams());
  }

  static #onUndoEdit(_event, _target) {
    const stroke = this.#undoStack.pop();
    if (!stroke) return;
    const inverse = this.#applyStroke(stroke);
    if (inverse) this.#redoStack.push(inverse);
    this.#derive();
    this.#refreshEditbar();
  }

  static #onRedoEdit(_event, _target) {
    const stroke = this.#redoStack.pop();
    if (!stroke) return;
    const inverse = this.#applyStroke(stroke);
    if (inverse) this.#undoStack.push(inverse);
    this.#derive();
    this.#refreshEditbar();
  }

  static #onResetEdits(_event, _target) {
    if (!this.#base) return;
    this.#edits = null;
    this.#overrides = null;
    this.#riverEdits = null;
    this.#sites = null;
    this.#roads = null;
    this.#realms = null;
    this.#names = null;
    this.#labelOffsets = null;
    this.#undoStack = [];
    this.#redoStack = [];
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
        "flags.hexworld.edits": encodeEdits(this.#edits),
        "flags.hexworld.biomes": encodeOverrides(this.#overrides),
        "flags.hexworld.rivers": encodeBytes(this.#riverEdits),
        "flags.hexworld.sites": encodeBytes(this.#sites),
        "flags.hexworld.roads": encodeBytes(this.#roads),
        "flags.hexworld.realms": encodeBytes(this.#realms),
        "flags.hexworld.stats": this.#world.stats
      };
      // Sparse maps merge on update: replace them ATOMICALLY by deleting the
      // stale keys and setting the new ones in this same update — a separate
      // clear-then-write pair could lose every name if the second write fails.
      const sceneFlags = this.#editScene.flags?.hexworld ?? {};
      const replaceMap = (field, next) => {
        for (const k of Object.keys(sceneFlags[field] ?? {})) {
          if (!next || !(k in next)) update[`flags.hexworld.${field}.-=${k}`] = null;
        }
        if (next && Object.keys(next).length) update[`flags.hexworld.${field}`] = next;
      };
      replaceMap("names", this.#names);
      replaceMap("labels", this.#labelOffsets);
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
