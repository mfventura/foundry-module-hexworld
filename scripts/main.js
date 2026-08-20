/**
 * HexWorld — procedural fantasy world generator for Foundry VTT.
 * Entry point: settings, sidebar button, public API.
 */

import { HexWorldGeneratorApp } from "./ui/generator-app.js";
import { generateWorld } from "./generator/worldgen.js";
import { createSceneFromWorld } from "./scene/scene-builder.js";
import { renderWorld } from "./render/renderer.js";

Hooks.once("init", () => {
  game.settings.register("hexworld", "lastParams", {
    scope: "client",
    config: false,
    type: Object,
    default: null
  });
});

Hooks.once("ready", () => {
  const module = game.modules.get("hexworld");
  module.api = {
    open: () => HexWorldGeneratorApp.open(),
    generateWorld,
    createSceneFromWorld,
    renderWorld
  };
});

/** Inject the "Generate World" button into the Scenes sidebar. */
Hooks.on("renderSceneDirectory", (_app, root) => {
  if (!game.user.isGM) return;
  if (!root || root.querySelector(".hexworld-open")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hexworld-open";
  btn.innerHTML = `<i class="fa-solid fa-earth-europe"></i> ${game.i18n.localize("HEXWORLD.OpenGenerator")}`;
  btn.addEventListener("click", () => HexWorldGeneratorApp.open());

  const footer = root.querySelector(".directory-footer") ?? root;
  footer.appendChild(btn);
});
