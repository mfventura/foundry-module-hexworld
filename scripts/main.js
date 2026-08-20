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
import { DEFAULT_SITE_ICONS, SITE_ICON_SETTINGS } from "./render/site-icons.js";
import { HexWorldIconConfig } from "./ui/icon-config.js";

Hooks.once("init", () => {
  game.settings.register("hexworld", "lastParams", {
    scope: "client",
    config: false,
    type: Object,
    default: null
  });

  // Per-site-type map icons. The raw string settings are hidden (config:
  // false) — a native <select> cannot render icons — and are edited through
  // the visual icon-picker menu below. World scope: the GM picks, every
  // client renders the same markers.
  for (const [type, key] of Object.entries(SITE_ICON_SETTINGS)) {
    game.settings.register("hexworld", key, {
      scope: "world",
      config: false,
      type: String,
      default: DEFAULT_SITE_ICONS[type],
      onChange: () => {
        canvas.hexworld?.repaint();
        HexWorldGeneratorApp.repaintPreview();
      }
    });
  }
  game.settings.register("hexworld", "markerStyle", {
    scope: "world",
    config: false,
    type: String,
    default: "badge",
    onChange: () => {
      canvas.hexworld?.repaint();
      HexWorldGeneratorApp.repaintPreview();
    }
  });
  game.settings.registerMenu("hexworld", "iconMenu", {
    name: "HEXWORLD.IconMenuName",
    label: "HEXWORLD.IconMenuLabel",
    hint: "HEXWORLD.IconMenuHint",
    icon: "fa-solid fa-icons",
    type: HexWorldIconConfig,
    restricted: true
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

  // v13+: SceneControls ya no activa canvas[control.layer]; cada control debe
  // activar su capa (mismo patrón que WallsLayer.prepareSceneControls en el
  // core). Ambos grupos comparten la capa hexworld — layerOptions.name es
  // dinámico para que el core no rebote al otro grupo al activarla.
  const activateLayer = (_event, active) => {
    if (active) canvas.hexworld?.activate();
  };
  // Shared utility buttons, present in both groups.
  const utilityTools = {
    hud: {
      name: "hud", order: 90, title: "HEXWORLD.ToggleHud", icon: "fa-solid fa-toolbox",
      button: true, onChange: () => canvas.hexworld?.toggleHud()
    },
    undo: {
      name: "undo", order: 91, title: "HEXWORLD.Undo", icon: "fa-solid fa-rotate-left",
      button: true, onChange: () => canvas.hexworld?.undo()
    },
    redo: {
      name: "redo", order: 92, title: "HEXWORLD.Redo", icon: "fa-solid fa-rotate-right",
      button: true, onChange: () => canvas.hexworld?.redo()
    }
  };

  controls.hexworld = {
    name: "hexworld",
    order: 80,
    title: "HEXWORLD.ControlsTerrain",
    icon: "fa-solid fa-mountain-sun",
    layer: "hexworld",
    activeTool: "raise",
    onChange: activateLayer,
    onToolChange: () => canvas.hexworld?.clearRouteAnchor(),
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
      ...utilityTools,
      edit: {
        name: "edit", order: 95, title: "HEXWORLD.EditScene", icon: "fa-solid fa-sliders",
        button: true, onChange: () => HexWorldGeneratorApp.openForScene(canvas.scene)
      },
      reset: {
        name: "reset", order: 96, title: "HEXWORLD.ResetEdits", icon: "fa-solid fa-eraser",
        button: true, onChange: () => canvas.hexworld?.resetEdits()
      }
    }
  };

  controls.hexworldSites = {
    name: "hexworldSites",
    order: 81,
    title: "HEXWORLD.ControlsSites",
    icon: "fa-solid fa-signs-post",
    layer: "hexworld",
    activeTool: "site",
    onChange: activateLayer,
    onToolChange: () => canvas.hexworld?.clearRouteAnchor(),
    tools: {
      site: { name: "site", order: 1, title: "HEXWORLD.ToolSite", icon: "fa-solid fa-location-dot" },
      rename: { name: "rename", order: 2, title: "HEXWORLD.ToolRename", icon: "fa-solid fa-signature" },
      roadMinor: { name: "roadMinor", order: 3, title: "HEXWORLD.ToolRoadMinor", icon: "fa-solid fa-shoe-prints" },
      roadMajor: { name: "roadMajor", order: 4, title: "HEXWORLD.ToolRoadMajor", icon: "fa-solid fa-road" },
      roadErase: { name: "roadErase", order: 5, title: "HEXWORLD.ToolRoadErase", icon: "fa-solid fa-road-circle-xmark" },
      ...utilityTools
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
