/**
 * Scene creation: renders the world to an image, uploads it to the world's
 * data folder and creates a Scene whose grid matches the generation grid
 * exactly (same type and size, padding 0, anchored at the origin).
 * Generation params are stored in scene flags so the world is regenerable.
 */

import { renderWorldToBlob } from "../render/renderer.js";

function filePickerClass() {
  return foundry.applications.apps.FilePicker.implementation
    ?? foundry.applications.apps.FilePicker;
}

async function ensureDirectory(path) {
  const FP = filePickerClass();
  const parts = path.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FP.createDirectory("data", current);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (!msg.includes("EEXIST") && !msg.toLowerCase().includes("already exists")) throw err;
    }
  }
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "world";
}

/**
 * @param {object} world  result of generateWorld()
 * @param {object} opts
 * @param {string} opts.sceneName
 * @param {number} opts.distance  scene units per grid space
 * @param {string} opts.units
 * @returns {Promise<Scene>}
 */
export async function createSceneFromWorld(world, { sceneName, distance, units }) {
  const { blob, ext } = await renderWorldToBlob(world);
  if (!blob) throw new Error("HexWorld: could not encode the map image");

  const dir = `worlds/${game.world.id}/hexworld`;
  await ensureDirectory(dir);

  const filename = `${slugify(sceneName)}-${slugify(world.params.seed)}-${foundry.utils.randomID(6)}.${ext}`;
  const file = new File([blob], filename, { type: blob.type });
  const FP = filePickerClass();
  const upload = await FP.upload("data", dir, file, {}, { notify: false });
  const src = upload?.path ?? `${dir}/${filename}`;

  const scene = await Scene.create({
    name: sceneName,
    width: world.grid.pixelWidth,
    height: world.grid.pixelHeight,
    padding: 0,
    backgroundColor: "#1e3d60",
    background: { src },
    grid: {
      type: world.params.gridType,
      size: world.params.cellSize,
      distance,
      units,
      alpha: 0.2
    },
    tokenVision: false,
    fog: { exploration: false },
    flags: {
      hexworld: {
        version: 1,
        seed: world.params.seed,
        params: world.params,
        stats: world.stats
      }
    }
  });
  return scene;
}
