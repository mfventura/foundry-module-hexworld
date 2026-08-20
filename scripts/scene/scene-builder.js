/**
 * Scene creation, data-driven (flags version 2): the scene stores NO image.
 * The single source of truth is flags.hexworld — seed, params and painted
 * elevation deltas — and the module's canvas layer regenerates the world
 * deterministically and renders it when the scene is viewed. This is what
 * makes terrain editable after the scene exists.
 *
 * Scenes created by module versions <= 0.2.x (flags version 1) keep their
 * baked background image and are ignored by the canvas layer.
 */

import { encodeEdits, encodeOverrides, encodeBytes } from "../lib/codec.js";

/**
 * @param {object} world  result of generateWorld()/deriveWorld()
 * @param {object} opts
 * @param {string} opts.sceneName
 * @param {number} opts.distance  scene units per grid space
 * @param {string} opts.units
 * @returns {Promise<Scene>}
 */
export async function createSceneFromWorld(world, { sceneName, distance, units }) {
  const sceneData = {
    name: sceneName,
    width: world.grid.pixelWidth,
    height: world.grid.pixelHeight,
    padding: 0,
    backgroundColor: "#1e3d60",
    grid: {
      type: world.params.gridType,
      size: world.params.cellSize,
      distance,
      units,
      alpha: 0.2
    },
    tokenVision: false,
    flags: {
      hexworld: {
        version: 2,
        seed: world.params.seed,
        params: world.params,
        edits: encodeEdits(world.edits),
        editsFormat: "int8x100",
        biomes: encodeOverrides(world.overrides),
        biomesFormat: "u8",
        rivers: encodeBytes(world.riverEdits),
        riversFormat: "u8",
        stats: world.stats
      }
    }
  };
  if (game.release.generation < 14) sceneData.fog = { exploration: false };
  return Scene.create(sceneData);
}
