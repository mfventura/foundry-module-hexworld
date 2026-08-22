/**
 * Biome artwork picker, opened from Foundry's Configure Settings
 * (registerMenu). One row per biome with a live thumbnail of the configured
 * tile; browse replaces it with any image via FilePicker, clear reverts the
 * biome to its flat color, reset restores the packaged default. Save writes
 * the hidden "biomeArt" world setting, whose onChange invalidates the sprite
 * caches and repaints the scene and the generator preview everywhere.
 */

import { BIOME_KEYS, BIOME_COLORS } from "../generator/biomes.js";
import { DEFAULT_BIOME_ART, configuredBiomeArt } from "../render/biome-art.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HexWorldBiomeArtConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "hexworld-biome-art-config",
    classes: ["hexworld-app"],
    tag: "div",
    window: {
      title: "HEXWORLD.BiomeArtMenuName",
      icon: "fa-solid fa-image",
      resizable: false
    },
    position: { width: 480, height: "auto" },
    actions: {
      save: HexWorldBiomeArtConfig.#onSave
    }
  };

  static PARTS = {
    main: { template: "modules/hexworld/templates/biome-art-config.hbs" }
  };

  /** Working copy: biome id -> path ("" = flat color). */
  #selection = null;

  async _prepareContext(_options) {
    this.#selection ??= configuredBiomeArt();
    const rows = Object.entries(BIOME_KEYS).map(([id, key]) => {
      const path = this.#selection[id] ?? "";
      return {
        id,
        label: game.i18n.localize(`HEXWORLD.Biome${key}`),
        color: BIOME_COLORS[id],
        path,
        fileName: path ? path.split("/").pop() : game.i18n.localize("HEXWORLD.BiomeArtFlat"),
        isDefault: path === DEFAULT_BIOME_ART[id]
      };
    });
    return { rows };
  }

  _onRender(_context, _options) {
    for (const row of this.element.querySelectorAll(".hw-art-row")) {
      const id = row.dataset.biome;
      row.querySelector(".hw-art-browse")?.addEventListener("click", () => this.#browse(id));
      row.querySelector(".hw-art-clear")?.addEventListener("click", () => {
        this.#selection[id] = "";
        this.render();
      });
      row.querySelector(".hw-art-reset")?.addEventListener("click", () => {
        this.#selection[id] = DEFAULT_BIOME_ART[id];
        this.render();
      });
    }
  }

  #browse(id) {
    const current = this.#selection[id] || DEFAULT_BIOME_ART[id];
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: "image",
      current: current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : "",
      callback: path => {
        this.#selection[id] = path;
        this.render();
      }
    }).browse();
  }

  static async #onSave(_event, target) {
    target.disabled = true;
    try {
      // Persist only the deviations from the packaged defaults.
      const overrides = {};
      for (const [id, path] of Object.entries(this.#selection ?? {})) {
        if (path !== DEFAULT_BIOME_ART[id]) overrides[id] = path;
      }
      await game.settings.set("hexworld", "biomeArt", overrides);
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
