/**
 * Minimal floating panel shown while the HexWorld terrain layer is active:
 * brush radius/strength, false-color view selector, biome palette, sea-level
 * dialog and a live cell inspector. Writes straight into layer.brush.
 */

import { PAINTABLE_BIOMES, BIOME_COLORS } from "../generator/biomes.js";
import { SITE } from "../generator/sites.js";
import { NO_OVERRIDE } from "../lib/codec.js";
import { cellIndexAt, describeCell } from "../ui/cell-info.js";

export const SITE_TYPES = [
  { id: SITE.VILLAGE, icon: "fa-solid fa-house", key: "SiteVillage" },
  { id: SITE.CITY, icon: "fa-solid fa-city", key: "SiteCity" },
  { id: SITE.DUNGEON, icon: "fa-solid fa-dungeon", key: "SiteDungeon" },
  { id: SITE.TEMPLE, icon: "fa-solid fa-place-of-worship", key: "SiteTemple" },
  { id: SITE.RUIN, icon: "fa-solid fa-archway", key: "SiteRuin" },
  { id: SITE.NONE, icon: "fa-solid fa-eraser", key: "SiteErase" }
];

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BrushHud extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(layer, options = {}) {
    super(options);
    this.layer = layer;
  }

  static DEFAULT_OPTIONS = {
    id: "hexworld-brush-hud",
    classes: ["hexworld-brush-hud"],
    window: { frame: false, positioned: false }
  };

  static PARTS = {
    main: { template: "modules/hexworld/templates/brush-hud.hbs" }
  };

  #onStageMove = null;
  #lastInspect = 0;

  async _prepareContext(_options) {
    const swatches = PAINTABLE_BIOMES.map(({ id, key }) => ({
      id,
      color: BIOME_COLORS[id],
      label: game.i18n.localize(`HEXWORLD.Biome${key}`),
      active: this.layer.brush.biome === id
    }));
    return {
      radius: this.layer.brush.radius,
      strength: this.layer.brush.strength,
      viewMode: this.layer.viewMode,
      swatches,
      eraserActive: this.layer.brush.biome === NO_OVERRIDE,
      siteTypes: SITE_TYPES.map(t => ({
        ...t,
        label: game.i18n.localize(`HEXWORLD.${t.key}`),
        active: this.layer.brush.site === t.id
      }))
    };
  }

  _onRender(_context, _options) {
    for (const range of this.element.querySelectorAll("input[type=range]")) {
      const output = range.closest(".hw-hud-row")?.querySelector("output");
      const sync = () => {
        const v = Number(range.value);
        this.layer.brush[range.name] = v;
        if (output) output.textContent = range.name === "radius" ? String(v) : `${Math.round(v * 100)}%`;
      };
      range.addEventListener("input", sync);
      sync();
    }

    for (const btn of this.element.querySelectorAll(".hw-swatch[data-biome]")) {
      btn.addEventListener("click", () => {
        this.layer.brush.biome = Number(btn.dataset.biome);
        for (const b of this.element.querySelectorAll(".hw-swatch[data-biome]")) {
          b.classList.toggle("active", b === btn);
        }
        // Picking a color is an intent to paint biomes: switch to the tool.
        ui.controls.activate({ tool: "biome" });
      });
    }

    for (const btn of this.element.querySelectorAll(".hw-site-swatch")) {
      btn.addEventListener("click", () => {
        this.layer.brush.site = Number(btn.dataset.site);
        for (const b of this.element.querySelectorAll(".hw-site-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        ui.controls.activate({ tool: "site" });
      });
    }

    const viewSel = this.element.querySelector("select[name=viewMode]");
    viewSel?.addEventListener("change", () => this.layer.setViewMode(viewSel.value));

    this.element.querySelector(".hw-sea-btn")?.addEventListener("click", () => this.#openSeaDialog());

    // Cell inspector: follow the canvas pointer while the layer is active.
    this.#onStageMove ??= ev => this.#inspect(ev);
    canvas.stage.on("pointermove", this.#onStageMove);
  }

  _onClose(options) {
    if (this.#onStageMove) canvas.stage.off("pointermove", this.#onStageMove);
    super._onClose(options);
  }

  #inspect(ev) {
    const now = performance.now();
    if (now - this.#lastInspect < 60) return;
    this.#lastInspect = now;
    const info = this.element?.querySelector(".hw-hud-info");
    const world = this.layer.world;
    if (!info || !world) return;
    const p = ev.getLocalPosition(canvas.stage);
    const d = canvas.dimensions;
    const c = cellIndexAt(world, p.x - d.sceneX, p.y - d.sceneY);
    info.textContent = c >= 0 ? describeCell(world, c) : "";
  }

  /** GM action: re-freeze the sea level (moves every coastline on purpose). */
  async #openSeaDialog() {
    const scene = canvas.scene;
    const params = scene?.flags?.hexworld?.params;
    if (!params) return;
    const current = Math.round((params.waterFraction ?? 0.5) * 100);
    const value = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("HEXWORLD.SeaLevelTitle") },
      content: `
        <p class="hint">${game.i18n.localize("HEXWORLD.SeaLevelHint")}</p>
        <div class="form-group">
          <label>${game.i18n.localize("HEXWORLD.WaterPct")}</label>
          <div class="form-fields">
            <input type="range" name="water" min="10" max="85" step="1" value="${current}">
            <output>${current}%</output>
          </div>
        </div>`,
      render: (_event, dialog) => {
        const el = dialog.element ?? dialog;
        const range = el.querySelector("input[name=water]");
        const out = el.querySelector("output");
        range?.addEventListener("input", () => { if (out) out.textContent = `${range.value}%`; });
      },
      buttons: [
        {
          action: "ok", icon: "fa-solid fa-check", default: true,
          label: "HEXWORLD.SeaLevelApply",
          callback: (_event, button) => Number(button.form.elements.water.value)
        },
        { action: "cancel", icon: "fa-solid fa-xmark", label: "Cancel" }
      ]
    });
    if (typeof value !== "number" || Number.isNaN(value) || value === current) return;
    // No hexworldLocal flag: every client, this one included, rebuilds via the
    // updateScene hook.
    await scene.update({ "flags.hexworld.params.waterFraction": value / 100 });
  }
}
