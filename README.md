# HexWorld – World Generator for Foundry VTT

**English** · [Español](README.es.md) · [Changelog](CHANGELOG.md)

Procedural fantasy world generator fully integrated in Foundry VTT, inspired by [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator). It generates maps with elevation, coherent climates and biomes, rivers, lakes, seas and mountains, and creates the Scene directly in Foundry with a perfectly aligned hexagonal or square grid.

## Features

- **Deterministic seeded generation**: the same seed and parameters always produce the same world. Scenes store only the world data (seed + parameters + edits) in their flags — no baked image — and a module canvas layer regenerates and draws the world every time the scene is viewed.
- **Native Foundry grid**: geometry and adjacency come from Foundry's own `foundry.grid.*` classes, so the map matches the scene grid pixel-perfectly (hex rows/columns, odd/even, or squares).
- **A terrain pipeline that makes sense**:
  1. Heightmap from simplex fBm + ridged noise with templates (*Continents, Pangaea, Archipelago, Islands*), domain-warped coastlines and mountain-range polylines.
  2. Sea level by quantile (the "% water" slider is exact).
  3. Temperature by latitude + altitude cooling (presets: temperate, cold, tropical, full planet).
  4. Moisture from noise + water proximity + orographic rain shadow with zonal winds.
  5. Real hydrology: depression filling (priority-flood), flow accumulation, connected rivers that reach the sea, lakes in closed basins.
  6. Whittaker-style biomes (temperature × moisture) with mountains, snow, glaciers, wetlands and beaches.
- **Cartographic render**: hillshade, ocean depth gradient, coastline, rivers with flux-based width — and optional **biome artwork**: an image tile per biome drawn inside every cell (default set included, each biome replaceable with your own art from Settings → Biome artwork, per-client toggle between artwork and flat colors).
- **In-scene editing (GM)**: raise/lower/smooth brushes plus semantic water/lowland/mountain tools, biome override palette, manual river add/remove, brush radius from 0.1 (single-cell) to 8 cells, per-stroke undo/redo, sea-level re-freeze, false-color debug views (height/temperature/moisture), live cell inspector. Everything re-derives live while painting and syncs to all clients on stroke end. The same tools are available on the generator preview, and existing scenes can be reopened in the generator.
- **Settlements, POIs and roads**: cities and villages placed by habitability, remote dungeons/temples/ruins, a road network over a terrain cost field, manual two-click route tracing, and configurable map icons (Font Awesome picker, badge or plain marker styles).
- **Free markers**: place a marker with its own icon (lair, portal, ford…) on any cell from the sites palette; each marker picks its icon from the catalog and is named by hand.
- **Names and labels**: procedural toponyms for settlements, rivers and water bodies, a rename tool, collision-avoiding label layout and a drag-to-pin label tool.
- **Realms**: points-of-light political territories grown from each city, political map view, realm brush (land and water — coastal waters and seas can be claimed by hand), and found/rename/delete realm management.
- **Journal publishing**: one click creates a JournalEntry for the scene with a page per named feature (settlements, POIs, markers, realms, rivers, lakes, seas) and clickable map Notes over the sites. Each new page opens with a data sheet (biome, climate, realm, river mouth, capital…) and a few paragraphs of procedurally generated, localized lore with links to related pages — seeded per feature, so it is stable across re-syncs. Re-syncing only adds what is missing and follows renames — your page content is never overwritten.

## Installation

In Foundry: **Add-on Modules → Install Module** and paste this manifest URL:

```
https://github.com/mfventura/foundry-module-hexworld/releases/latest/download/module.json
```

It always points to the latest published release, so updates arrive through Foundry's *Update* button.

### Publishing a new version

1. Add the release entry to `CHANGELOG.md` (mandatory) and review both READMEs (update if the change is user-facing).
2. Bump `version` (and the `download` URL) in `module.json`.
3. Tag and push:

```bash
git tag v0.11.2 && git push origin main v0.11.2
```

The GitHub Actions workflow injects the tag version into `module.json`, packages `module.zip` and publishes the release with both files attached.

## Installation (development)

1. Link or copy this folder into Foundry's modules directory as `hexworld`:
   ```bash
   ln -s /path/to/hexworld "<FoundryData>/Data/modules/hexworld"
   ```
2. Enable **HexWorld – Generador de Mundos** in the world.
3. As GM, open the **Scenes** tab and press **Generate World** (button at the bottom of the panel).

Also available via API/macro: `game.modules.get("hexworld").api.open()`.

## Usage

1. Pick a template, grid type, size (columns × rows, max 25,000 cells) and climate parameters.
2. **Generate preview** — iterate with different seeds (the die rolls a new one).
3. Optionally edit the preview with the toolbar (terrain, biomes, rivers, sites, roads, realms, labels).
4. **Create scene** — the scene stores the world data and renders itself on view.

## Structure

```
scripts/
  main.js                    # hooks, layer, scene controls, sidebar button, settings, API
  lib/                       # seeded PRNG, simplex noise, flags codec, MinHeap, flags gate
  generator/                 # grid, heightmap+templates, climate, hydrology, biomes,
                             # brush, sites+roads, realms, names, worldgen orchestrator
  edit/edit-session.js       # shared editing engine (channels, tools, undo/redo, flags)
  render/renderer.js         # 2D canvas render (preview and scene texture)
  render/biome-art.js        # per-biome artwork tiles (default set + overrides + sprites)
  render/site-icons.js       # Font Awesome icon catalog and runtime glyph resolution
  render/labels.js           # collision-avoiding label layout
  canvas/                    # interaction layer, terrain mesh, brush HUD
  scene/scene-builder.js     # Scene creation (data only, no image)
  ui/                        # generator window, icon picker, biome-art picker, inspector
assets/biomes/               # default biome artwork tiles (17 PNG)
```

## Compatibility

Foundry VTT **v14** (minimum v13). No dependencies, no build step (pure ESM). The module uses the modern namespaces (`foundry.applications.ux/apps`, `foundry.grid.*`, ApplicationV2) and tolerates the elevation axis (`k`) that v14 introduces with Scene Levels.

## Roadmap

- [x] Manual terrain editing (raise/lower/smooth), on the preview and the created scene.
- [x] Biome and water brushes (per-cell overrides, force lake/sea).
- [x] Texture fill: an image per biome drawn inside every cell (default set in `assets/biomes/`, GM-configurable, per-client artwork/colors toggle).
- [x] Procedural names with labels (settlements included).
- [x] Settlements, realms and roads.
- [x] Debug view layers: height, temperature, moisture.
- [ ] "Bake" to image: export the current state as a static background.
