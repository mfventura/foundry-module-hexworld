/**
 * Visual icon picker for site markers, opened from Foundry's Configure
 * Settings (registerMenu). One row per site type showing every catalog icon
 * as a real rendered glyph; Save writes the hidden world settings, whose
 * onChange repaints the scene and the generator preview everywhere.
 */

import { SITE_GLYPHS, SITE_ICON_SETTINGS, configuredSiteIcons } from "../render/site-icons.js";
import { SITE_TYPES } from "../canvas/brush-hud.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HexWorldIconConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "hexworld-icon-config",
    classes: ["hexworld-app"],
    tag: "div",
    window: {
      title: "HEXWORLD.IconMenuName",
      icon: "fa-solid fa-icons",
      resizable: false
    },
    position: { width: 460, height: "auto" },
    actions: {
      save: HexWorldIconConfig.#onSave
    }
  };

  static PARTS = {
    main: { template: "modules/hexworld/templates/icon-config.hbs" }
  };

  /** Working copy of the selection: site type -> icon name. */
  #selection = null;

  async _prepareContext(_options) {
    this.#selection ??= configuredSiteIcons();
    const rows = SITE_TYPES.filter(t => t.id in SITE_ICON_SETTINGS).map(t => ({
      type: t.id,
      typeLabel: game.i18n.localize(`HEXWORLD.${t.key}`),
      options: Object.entries(SITE_GLYPHS).map(([name, { label }]) => ({
        name,
        label: game.i18n.localize(label),
        active: this.#selection[t.id] === name
      }))
    }));
    return { rows };
  }

  _onRender(_context, _options) {
    for (const btn of this.element.querySelectorAll(".hw-swatch[data-icon]")) {
      btn.addEventListener("click", () => {
        const row = btn.closest("[data-type]");
        const type = row?.dataset.type;
        if (!type) return;
        this.#selection[type] = btn.dataset.icon;
        for (const b of row.querySelectorAll(".hw-swatch[data-icon]")) {
          b.classList.toggle("active", b === btn);
        }
      });
    }
  }

  static async #onSave(_event, target) {
    target.disabled = true;
    try {
      for (const [type, key] of Object.entries(SITE_ICON_SETTINGS)) {
        const chosen = this.#selection?.[type];
        if (chosen && chosen !== game.settings.get("hexworld", key)) {
          await game.settings.set("hexworld", key, chosen);
        }
      }
      this.close();
    } finally {
      target.disabled = false;
    }
  }

  _onClose(options) {
    super._onClose(options);
    this.#selection = null; // re-read settings next time
  }
}
