/**
 * Minimal floating panel shown while the HexWorld terrain layer is active:
 * brush radius/strength, false-color view selector, biome palette, sea-level
 * dialog and a live cell inspector. Writes straight into layer.brush.
 */

import { PAINTABLE_BIOMES, BIOME_COLORS } from "../generator/biomes.js";
import { SITE } from "../generator/sites.js";
import { configuredSiteIcons } from "../render/site-icons.js";
import { NO_OVERRIDE } from "../lib/codec.js";
import { cellIndexAt, describeCell } from "../ui/cell-info.js";
import { activateHexTab } from "../ui/tool-tabs.js";
import { REALM_COLORS } from "../render/renderer.js";

export const SITE_TYPES = [
  { id: SITE.VILLAGE, key: "SiteVillage" },
  { id: SITE.CITY, key: "SiteCity" },
  { id: SITE.DUNGEON, key: "SiteDungeon" },
  { id: SITE.TEMPLE, key: "SiteTemple" },
  { id: SITE.RUIN, key: "SiteRuin" },
  { id: SITE.NONE, key: "SiteErase", icon: "fa-solid fa-eraser" }
];

/** Palette entries with the CONFIGURED icon per type (matches the map). */
export function siteTypeContext(activeId) {
  const icons = configuredSiteIcons();
  return SITE_TYPES.map(t => ({
    ...t,
    icon: t.icon ?? `fa-solid ${icons[t.id]}`,
    label: game.i18n.localize(`HEXWORLD.${t.key}`),
    active: t.id === activeId
  }));
}

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
      showLabels: this.layer.showLabels,
      swatches,
      eraserActive: this.layer.brush.biome === NO_OVERRIDE,
      siteTypes: siteTypeContext(this.layer.brush.site),
      realmSwatches: this.#realmSwatches()
    };
  }

  /** One swatch per realm present in the channel, plus the wilderness eraser. */
  #realmSwatches() {
    const realms = this.layer.realms;
    if (!realms) return [];
    const ids = [...new Set(realms)].filter(id => id > 0).sort((a, b) => a - b);
    if (!ids.length) return [];
    const out = ids.map(id => {
      const [r, g, b] = REALM_COLORS[(id - 1) % REALM_COLORS.length];
      return {
        id,
        color: `rgb(${r},${g},${b})`,
        label: this.layer.names?.[`k${id}`] ?? `${game.i18n.localize("HEXWORLD.RealmsTitle")} ${id}`,
        active: this.layer.brush.realm === id
      };
    });
    out.push({
      id: 0, color: "rgba(0,0,0,0.35)", erase: true,
      label: game.i18n.localize("HEXWORLD.RealmWilderness"),
      active: this.layer.brush.realm === 0
    });
    return out;
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
        // Picking a color is an intent to paint biomes: switch tab + tool.
        activateHexTab("terrain", "biome");
      });
    }

    for (const btn of this.element.querySelectorAll(".hw-site-swatch")) {
      btn.addEventListener("click", () => {
        this.layer.brush.site = Number(btn.dataset.site);
        for (const b of this.element.querySelectorAll(".hw-site-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        activateHexTab("sites", "site");
      });
    }

    for (const btn of this.element.querySelectorAll(".hw-realm-swatch")) {
      btn.addEventListener("click", () => {
        this.layer.brush.realm = Number(btn.dataset.realm);
        for (const b of this.element.querySelectorAll(".hw-realm-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        activateHexTab("sites", "realm");
      });
    }

    const viewSel = this.element.querySelector("select[name=viewMode]");
    viewSel?.addEventListener("change", () => this.layer.setViewMode(viewSel.value));

    const labelsChk = this.element.querySelector("input[name=showLabels]");
    labelsChk?.addEventListener("change", () => this.layer.setShowLabels(labelsChk.checked));

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
