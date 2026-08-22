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
import { invalidateBiomeArt } from "./render/biome-art.js";
import { HexWorldIconConfig } from "./ui/icon-config.js";
import { HexWorldBiomeArtConfig } from "./ui/biome-art-config.js";
import { hexToolTab, activateHexTab, HEX_TAB_DEFAULT_TOOL } from "./ui/tool-tabs.js";
import { worldFlags } from "./lib/flags.js";

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

  // Per-biome artwork paths. Hidden raw object (edited through the visual
  // menu below); world scope so every client renders the same tiles. Only
  // deviations from the packaged defaults are stored.
  game.settings.register("hexworld", "biomeArt", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => {
      invalidateBiomeArt();
      canvas.hexworld?.repaint();
      HexWorldGeneratorApp.repaintPreview();
    }
  });
  // Client toggle: artwork tiles vs classic flat colors on the terrain view.
  game.settings.register("hexworld", "useBiomeArt", {
    name: "HEXWORLD.UseBiomeArt",
    hint: "HEXWORLD.UseBiomeArtHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      canvas.hexworld?.repaint();
      HexWorldGeneratorApp.repaintPreview();
    }
  });
  game.settings.registerMenu("hexworld", "biomeArtMenu", {
    name: "HEXWORLD.BiomeArtMenuName",
    label: "HEXWORLD.BiomeArtMenuLabel",
    hint: "HEXWORLD.BiomeArtMenuHint",
    icon: "fa-solid fa-image",
    type: HexWorldBiomeArtConfig,
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
  if (!worldFlags(canvas?.scene)) return;

  // v13+: SceneControls ya no activa canvas[control.layer]; el control debe
  // activar su capa (mismo patrón que WallsLayer.prepareSceneControls en el
  // core). Un ÚNICO grupo en la columna: sus dos primeros botones son las
  // pestañas (terreno / asentamientos) y el resto de herramientas se filtra
  // por visibilidad según la pestaña activa (tool-tabs.js re-renderiza los
  // controles con reset al cambiar).
  const tab = hexToolTab();

  controls.hexworld = {
    name: "hexworld",
    order: 80,
    title: "HEXWORLD.ControlsMain",
    icon: "fa-solid fa-earth-europe",
    layer: "hexworld",
    activeTool: HEX_TAB_DEFAULT_TOOL[tab],
    onChange: (_event, active) => {
      if (active) canvas.hexworld?.activate();
    },
    onToolChange: () => canvas.hexworld?.clearRouteAnchor(),
    tools: {
      // --- Sub-group tabs ---
      tabTerrain: {
        name: "tabTerrain", order: 1, title: "HEXWORLD.ControlsTerrain",
        icon: "fa-solid fa-mountain-sun",
        button: true, onChange: () => activateHexTab("terrain")
      },
      tabSites: {
        name: "tabSites", order: 2, title: "HEXWORLD.ControlsSites",
        icon: "fa-solid fa-signs-post",
        button: true, onChange: () => activateHexTab("sites")
      },
      // --- Terrain tab ---
      raise: { name: "raise", order: 10, title: "HEXWORLD.ToolRaise", icon: "fa-solid fa-arrow-up-from-ground-water", visible: tab === "terrain" },
      lower: { name: "lower", order: 11, title: "HEXWORLD.ToolLower", icon: "fa-solid fa-arrow-down", visible: tab === "terrain" },
      smooth: { name: "smooth", order: 12, title: "HEXWORLD.ToolSmooth", icon: "fa-solid fa-wand-magic-sparkles", visible: tab === "terrain" },
      water: { name: "water", order: 13, title: "HEXWORLD.ToolWater", icon: "fa-solid fa-water", visible: tab === "terrain" },
      land: { name: "land", order: 14, title: "HEXWORLD.ToolLand", icon: "fa-solid fa-seedling", visible: tab === "terrain" },
      mountain: { name: "mountain", order: 15, title: "HEXWORLD.ToolMountain", icon: "fa-solid fa-mountain", visible: tab === "terrain" },
      biome: { name: "biome", order: 16, title: "HEXWORLD.ToolBiome", icon: "fa-solid fa-palette", visible: tab === "terrain" },
      riverAdd: { name: "riverAdd", order: 17, title: "HEXWORLD.ToolRiverAdd", icon: "fa-solid fa-wave-square", visible: tab === "terrain" },
      riverRemove: { name: "riverRemove", order: 18, title: "HEXWORLD.ToolRiverRemove", icon: "fa-solid fa-droplet-slash", visible: tab === "terrain" },
      // --- Sites tab ---
      site: { name: "site", order: 10, title: "HEXWORLD.ToolSite", icon: "fa-solid fa-location-dot", visible: tab === "sites" },
      rename: { name: "rename", order: 11, title: "HEXWORLD.ToolRename", icon: "fa-solid fa-signature", visible: tab === "sites" },
      roadMinor: { name: "roadMinor", order: 12, title: "HEXWORLD.ToolRoadMinor", icon: "fa-solid fa-shoe-prints", visible: tab === "sites" },
      roadMajor: { name: "roadMajor", order: 13, title: "HEXWORLD.ToolRoadMajor", icon: "fa-solid fa-road", visible: tab === "sites" },
      roadErase: { name: "roadErase", order: 14, title: "HEXWORLD.ToolRoadErase", icon: "fa-solid fa-road-circle-xmark", visible: tab === "sites" },
      realm: { name: "realm", order: 15, title: "HEXWORLD.ToolRealm", icon: "fa-solid fa-flag", visible: tab === "sites" },
      labelMove: { name: "labelMove", order: 16, title: "HEXWORLD.ToolLabelMove", icon: "fa-solid fa-arrows-up-down-left-right", visible: tab === "sites" },
      // --- Always available ---
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
      },
      edit: {
        name: "edit", order: 93, title: "HEXWORLD.EditScene", icon: "fa-solid fa-sliders",
        button: true, onChange: () => HexWorldGeneratorApp.openForScene(canvas.scene)
      },
      reset: {
        name: "reset", order: 94, title: "HEXWORLD.ResetEdits", icon: "fa-solid fa-eraser",
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
