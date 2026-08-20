/**
 * HexWorld generator window (ApplicationV2). Left: parameters. Right: live
 * preview + terrain-editing toolbar + stats. Generation is deterministic from
 * the seed; manual edits are stored as an elevation delta layer on top of the
 * procedural base, and the downstream pipeline (hydrology, climate, biomes)
 * is re-derived as you paint.
 */

import { buildBase, deriveWorld, MAX_CELLS } from "../generator/worldgen.js";
import { TEMPLATES } from "../generator/heightmap.js";
import { applyBrush } from "../generator/brush.js";
import { renderWorld, previewScale } from "../render/renderer.js";
import { createSceneFromWorld } from "../scene/scene-builder.js";
import { randomSeedString } from "../lib/random.js";

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
  distance: 10,
  units: "km"
};

const UNDO_LIMIT = 20;

export class HexWorldGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  /** @type {object|null} result of buildBase() */
  #base = null;
  /** @type {Float32Array|null} painted elevation deltas */
  #edits = null;
  /** @type {object|null} derived world currently shown in the preview */
  #world = null;
  #lastScale = 1;

  #tool = "raise";
  #painting = false;
  /** @type {Map<number, number>|null} cell -> previous delta, for the active stroke */
  #strokeUndo = null;
  /** @type {Map<number, number>[]} */
  #undoStack = [];
  #lastDerive = 0;

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
      undoEdit: HexWorldGeneratorApp.#onUndoEdit,
      resetEdits: HexWorldGeneratorApp.#onResetEdits
    }
  };

  static PARTS = {
    main: { template: "modules/hexworld/templates/generator.hbs" }
  };

  async _prepareContext(_options) {
    const saved = game.settings.get("hexworld", "lastParams") ?? {};
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

    return { p, gridTypes, templates, climates };
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
    const canvas = root.querySelector("canvas.hw-canvas");
    if (canvas) {
      canvas.addEventListener("pointerdown", ev => this.#onPaintStart(ev));
      canvas.addEventListener("pointermove", ev => this.#onPaintMove(ev));
      canvas.addEventListener("pointerup", ev => this.#onPaintEnd(ev));
      canvas.addEventListener("pointercancel", ev => this.#onPaintEnd(ev));
    }

    this.#refreshToolButtons();
    this.#refreshEditbar();
    if (this.#world) {
      this.#drawPreview();
      this.#updateStats();
    }
  }

  /* -------------------------------------------- */
  /*  Parameters                                   */
  /* -------------------------------------------- */

  #readParams() {
    const form = this.element.querySelector("form.hw-form");
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
    return {
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
    renderWorld(this.#world, canvas, this.#lastScale);
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
    const undoBtn = bar.querySelector("button[data-action=undoEdit]");
    if (undoBtn) undoBtn.disabled = !ready || !this.#undoStack.length;
  }

  #derive() {
    if (!this.#base) return;
    this.#world = deriveWorld(this.#base, this.#edits);
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
    const bar = this.element.querySelector(".hw-editbar");
    const radius = Number(bar?.querySelector("input[name=brushRadius]")?.value ?? 3);
    const strength = Number(bar?.querySelector("input[name=brushStrength]")?.value ?? 0.06);
    return { radius, strength };
  }

  #onPaintStart(ev) {
    if (!this.#base || ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.#painting = true;
    this.#strokeUndo = new Map();
    this.#applyBrush(ev);
  }

  #onPaintMove(ev) {
    if (!this.#painting) return;
    ev.preventDefault();
    this.#applyBrush(ev);
  }

  #onPaintEnd(ev) {
    if (!this.#painting) return;
    this.#painting = false;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (_err) { /* already released */ }
    if (this.#strokeUndo?.size) {
      this.#undoStack.push(this.#strokeUndo);
      if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
    }
    this.#strokeUndo = null;
    this.#derive();
    this.#refreshEditbar();
  }

  #applyBrush(ev) {
    const point = this.#canvasPoint(ev);
    if (!point) return;
    const { grid } = this.#base;
    this.#edits ??= new Float32Array(grid.n);
    const { radius, strength } = this.#brushSettings();
    applyBrush(this.#base, this.#edits, this.#strokeUndo, {
      tool: this.#tool, radius, strength, x: point.x, y: point.y
    });

    // Live feedback, throttled harder on big maps where a derive is costlier.
    const now = performance.now();
    const interval = grid.n > 10000 ? 220 : 60;
    if (now - this.#lastDerive >= interval) {
      this.#lastDerive = now;
      this.#derive();
    }
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
      this.#edits = null;
      this.#undoStack = [];
      this.#derive();
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

  static #onUndoEdit(_event, _target) {
    const stroke = this.#undoStack.pop();
    if (!stroke || !this.#edits) return;
    for (const [c, prev] of stroke) this.#edits[c] = prev;
    this.#derive();
    this.#refreshEditbar();
  }

  static #onResetEdits(_event, _target) {
    if (!this.#base) return;
    this.#edits = null;
    this.#undoStack = [];
    this.#derive();
    this.#refreshEditbar();
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
