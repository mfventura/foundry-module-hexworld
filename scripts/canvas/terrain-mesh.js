/**
 * TerrainMesh — hosts the world rendering inside Foundry's canvas.
 *
 * Approach: the existing 2D renderer draws the world into an offscreen
 * canvas, which becomes a PIXI texture on a PrimarySpriteMesh placed in the
 * primary group (below tokens, below the grid overlay). Repainting terrain
 * re-renders the offscreen canvas and re-uploads the texture — no per-cell
 * canvas objects, no Foundry documents, no image files.
 *
 * The texture is capped at ~10 MP: terrain colors are low-frequency, so a
 * downscaled texture stretched to scene size stays crisp at play zoom while
 * keeping stroke-time texture uploads cheap.
 */

import { renderWorld } from "../render/renderer.js";

const MAX_TEXTURE_PIXELS = 10_000_000;

export class TerrainMesh {
  #canvasEl = null;
  #texture = null;
  #sprite = null;

  /** Render (or re-render) the world and attach the sprite to the canvas. */
  draw(world, mode = "terrain") {
    const g = world.grid;
    const scale = Math.min(1, Math.sqrt(MAX_TEXTURE_PIXELS / (g.pixelWidth * g.pixelHeight)));

    this.#canvasEl ??= document.createElement("canvas");
    renderWorld(world, this.#canvasEl, scale, mode);

    if (!this.#sprite) {
      this.#texture = PIXI.Texture.from(this.#canvasEl);
      const Cls = foundry.canvas.primary.PrimarySpriteMesh;
      this.#sprite = new Cls({ texture: this.#texture, name: "hexworld-terrain" });
      // Sort below tiles (500) and tokens (700) at ground elevation.
      this.#sprite.elevation = 0;
      this.#sprite.sort = -9999;
      try { this.#sprite.sortLayer = 300; } catch (_err) { /* read-only in some builds */ }
      canvas.primary.addChild(this.#sprite);
      canvas.primary.sortDirty = true;
    } else {
      this.#texture.baseTexture.update();
    }

    const d = canvas.dimensions;
    this.#sprite.position.set(d.sceneX, d.sceneY);
    this.#sprite.width = g.pixelWidth;
    this.#sprite.height = g.pixelHeight;
  }

  destroy() {
    if (this.#sprite) {
      canvas.primary?.removeChild(this.#sprite);
      this.#sprite.destroy();
      this.#sprite = null;
    }
    if (this.#texture) {
      this.#texture.destroy(true);
      this.#texture = null;
    }
    this.#canvasEl = null;
  }
}
