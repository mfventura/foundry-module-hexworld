/**
 * Minimal floating panel with brush radius/strength sliders, shown while the
 * HexWorld terrain layer is active. Writes straight into layer.brush.
 */

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
    return {
      radius: this.layer.brush.radius,
      strength: this.layer.brush.strength
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
  }
}
