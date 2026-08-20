/**
 * Minimal floating panel with brush radius/strength sliders and the biome
 * palette, shown while the HexWorld terrain layer is active. Writes straight
 * into layer.brush; clicking a swatch also activates the biome tool.
 */

import { PAINTABLE_BIOMES, BIOME_COLORS } from "../generator/biomes.js";
import { NO_OVERRIDE } from "../lib/codec.js";

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
      swatches,
      eraserActive: this.layer.brush.biome === NO_OVERRIDE
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

    for (const btn of this.element.querySelectorAll(".hw-swatch")) {
      btn.addEventListener("click", () => {
        this.layer.brush.biome = Number(btn.dataset.biome);
        for (const b of this.element.querySelectorAll(".hw-swatch")) {
          b.classList.toggle("active", b === btn);
        }
        // Picking a color is an intent to paint biomes: switch to the tool.
        ui.controls.activate({ tool: "biome" });
      });
    }
  }
}
