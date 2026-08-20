/**
 * HexWorld — procedural fantasy world generator for Foundry VTT.
 * Entry point: settings, canvas layer, scene controls, sidebar button, API.
 */

import { HexWorldGeneratorApp } from "./ui/generator-app.js";
import { generateWorld, buildBase, deriveWorld } from "./generator/worldgen.js";
import { createSceneFromWorld } from "./scene/scene-builder.js";
import { encodeEdits, decodeEdits, encodeOverrides, decodeOverrides } from "./lib/codec.js";
import { renderWorld } from "./render/renderer.js";
import { HexWorldLayer } from "./canvas/hexworld-layer.js";

Hooks.once("init", () => {
  game.settings.register("hexworld", "lastParams", {
    scope: "client",
    config: false,
    type: Object,
    default: null
  });

  CONFIG.Canvas.layers.hexworld = {
    layerClass: HexWorldLayer,
    group: "interface"
  };
});

Hooks.once("ready", () => {
  const module = game.modules.get("hexworld");
  module.api = {
    open: () => HexWorldGeneratorApp.open(),
    generateWorld,
    buildBase,
    deriveWorld,
    createSceneFromWorld,
    encodeEdits,
    decodeEdits,
    encodeOverrides,
    decodeOverrides,
    renderWorld
  };
});

/** Terrain editing controls, only for GMs on HexWorld data-driven scenes. */
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM) return;
  const flags = canvas?.scene?.flags?.hexworld;
  if (!flags?.params || (flags.version ?? 1) < 2) return;

  controls.hexworld = {
    name: "hexworld",
    order: 80,
    title: "HEXWORLD.Controls",
    icon: "fa-solid fa-earth-europe",
    layer: "hexworld",
    activeTool: "raise",
    // v13+: SceneControls ya no activa canvas[control.layer]; cada control debe
    // activar su capa (mismo patrón que WallsLayer.prepareSceneControls en el core).
    onChange: (_event, active) => {
      if (active) canvas.hexworld?.activate();
    },
    onToolChange: () => {},
    tools: {
      raise: { name: "raise", order: 1, title: "HEXWORLD.ToolRaise", icon: "fa-solid fa-arrow-up-from-ground-water" },
      lower: { name: "lower", order: 2, title: "HEXWORLD.ToolLower", icon: "fa-solid fa-arrow-down" },
      smooth: { name: "smooth", order: 3, title: "HEXWORLD.ToolSmooth", icon: "fa-solid fa-wand-magic-sparkles" },
      water: { name: "water", order: 4, title: "HEXWORLD.ToolWater", icon: "fa-solid fa-water" },
      land: { name: "land", order: 5, title: "HEXWORLD.ToolLand", icon: "fa-solid fa-seedling" },
      mountain: { name: "mountain", order: 6, title: "HEXWORLD.ToolMountain", icon: "fa-solid fa-mountain" },
      biome: { name: "biome", order: 7, title: "HEXWORLD.ToolBiome", icon: "fa-solid fa-palette" },
      riverAdd: { name: "riverAdd", order: 8, title: "HEXWORLD.ToolRiverAdd", icon: "fa-solid fa-wave-square" },
      riverRemove: { name: "riverRemove", order: 9, title: "HEXWORLD.ToolRiverRemove", icon: "fa-solid fa-droplet-slash" },
      undo: {
        name: "undo", order: 10, title: "HEXWORLD.Undo", icon: "fa-solid fa-rotate-left",
        button: true, onChange: () => canvas.hexworld?.undo()
      },
      reset: {
        name: "reset", order: 11, title: "HEXWORLD.ResetEdits", icon: "fa-solid fa-eraser",
        button: true, onChange: () => canvas.hexworld?.resetEdits()
      }
    }
  };
});

/** Rebuild the terrain when another client changes the scene's world data. */
Hooks.on("updateScene", (scene, changes, options, userId) => {
  if (!scene.isView || !canvas?.hexworld) return;
  if (!foundry.utils.hasProperty(changes, "flags.hexworld")) return;
  if (options.hexworldLocal && userId === game.user.id) return;
  canvas.hexworld.rebuildFromFlags();
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
