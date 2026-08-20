/**
 * HexWorld generator window (ApplicationV2). Left: parameters. Right: live
 * preview + stats. Generation is deterministic from the seed; "Create scene"
 * renders the current world at full resolution and builds the Scene.
 */

import { generateWorld, MAX_CELLS } from "../generator/worldgen.js";
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
  waterFraction: 0.55,
  climate: "temperate",
  moisture: 1.0,
  riverDensity: 0.5,
  distance: 10,
  units: "km"
};

export class HexWorldGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static open() {
    this.#instance ??= new this();
    this.#instance.render({ force: true });
    return this.#instance;
  }

  #world = null;

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
      createScene: HexWorldGeneratorApp.#onCreateScene
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
      const sync = () => { if (output) output.textContent = this.#formatRange(range); };
      range.addEventListener("input", sync);
      sync();
    }
    // Redraw the preview if a world already exists (e.g. after a re-render).
    if (this.#world) this.#drawPreview();
  }

  #formatRange(range) {
    const v = Number(range.value);
    if (range.name === "waterFraction") return `${Math.round(v * 100)}%`;
    return `${Math.round(v * 100)}%`;
  }

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

  #drawPreview() {
    const canvas = this.element.querySelector("canvas.hw-canvas");
    if (!canvas || !this.#world) return;
    const box = this.element.querySelector(".hw-preview");
    const maxW = Math.max(300, (box?.clientWidth ?? 640) - 8);
    const scale = previewScale(this.#world, maxW, 560);
    renderWorld(this.#world, canvas, scale);
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
      this.#world = generateWorld(params);
      this.#drawPreview();
      this.#updateStats();
      const createBtn = this.element.querySelector("button[data-action=createScene]");
      if (createBtn) createBtn.disabled = false;
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
      ui.notifications.info(game.i18n.localize("HEXWORLD.NotifyRendering"));
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
