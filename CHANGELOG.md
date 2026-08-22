# Changelog

All notable changes to HexWorld are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every release MUST add an entry here before tagging.

## [0.11.4] - 2026-08-22

### Changed
- GitHub releases now use the version's CHANGELOG.md entry as their description instead of auto-generated commit notes, so each release page shows the same informative text as the changelog.

## [0.11.3] - 2026-08-22

### Added
- This changelog (English only, mandatory entry per release from now on), covering every version since 0.1.0.
- Bilingual README: `README.md` in English and `README.es.md` in Spanish, refreshed to describe the current feature set (they previously described v0.1).

### Changed
- The release archive now packages `README.es.md` and `CHANGELOG.md`.

## [0.11.2] - 2026-08-22

### Changed
- Brush radius sliders (scene HUD and generator) now go from 0.1 to 8 cells in 0.1 steps, allowing single-cell edits on any grid size.

### Fixed
- With a sub-cell radius the brush could select zero cells (the center-distance test missed every cell) and the falloff formula went negative for the hovered cell. The cell under the pointer is now always selected and painted at full strength.

## [0.11.1] - 2026-08-22

### Changed
- The generator preview toolbar no longer overflows to the right: it is split into two rows — grouped options on top (brush radius/strength, undo/redo/reset, view selector, artwork toggle) and the tool buttons below, with separators between the terrain, sites and regenerate groups.

## [0.11.0] - 2026-08-22

### Added
- **Biome artwork tiles**: the terrain view can draw an image per biome inside every cell instead of flat colors. A default set of 17 procedurally generated 256px tiles ships in `assets/biomes/`.
- New settings menu **Biome artwork** (GM, world scope): per-biome file picker to use your own art, revert to flat color, or restore the packaged default. Only deviations from the defaults are stored.
- Client setting/toggle "Artwork" (scene HUD and generator toolbar) to switch between artwork and classic flat colors per client.
- Tiles are pre-rasterized once per grid size (polygon-clipped with seam overscan), so artwork repaints cost the same as flat fills; any square image works on pointy/flat hex and square grids. Ocean depth and hillshade/relief cues are overlaid on top of the artwork.

### Changed
- The release archive now packages the `assets/` directory.

## [0.10.5] - 2026-08-21

### Changed
- All editing logic (channels, undo/redo, stroke lifecycle, tool dispatch, realm lifecycle, naming, flags payload) now lives once in the shared `WorldEditSession` engine; the scene layer and the generator preview are reduced to event/dialog/persistence glue. New tools are implemented exactly once.
- The engine is DOM-free and fully covered by a headless smoke test.

## [0.10.4] - 2026-08-21

### Changed
- Performance: moisture noise computed once per base and reused by every re-derive; brushes select cells via bounded neighbor expansion instead of scanning the whole map; overlay channels (sites/roads/realms/labels) repaint without re-deriving; stroke persistence writes only the touched channel; the world base is cached across scene rebuilds; label layout is cached per repaint.
- Cleanups: shared MinHeap and flags accessor, removal of dead flag fields, legacy fallbacks and unused i18n keys; smoke tests share one Foundry mock.

## [0.10.3] - 2026-08-21

### Fixed
- Coastlines and realm borders never rendered on square grids (strict edge-tie comparison).
- Apply-to-scene replaces the names/labels maps atomically; manual names are no longer lost if a write fails.
- Regenerating settlements preserves manual names and pinned labels of rivers/lakes/seas.
- A press-drag gesture no longer paints the origin cell twice; canceling a drag reverts the partial stroke.
- Brush deltas are clamped to the Int8 codec range (±1.27), eliminating author-vs-clients terrain divergence.
- Realm brush skips water when painting; deleting a realm clears undo stacks, removes its label offset and warns it is not undoable; new-realm name suggestions avoid collisions; realm auto-naming resolves the capital robustly.
- Sundry: hidden labels are not grabbable, generator sliders survive re-renders, HUD listeners no longer stack, off-map river clicks no longer snap to border cells, rename dialogs escape the current name.

## [0.10.2] - 2026-08-21

### Added
- Label collision avoidance: labels try candidate positions against already-placed labels and site markers in cartographic priority order (realms > cities > villages > POIs > waters > rivers).
- Move-label tool (settlements tab, scene and preview): drag to pin a label anywhere; right-click restores the automatic position.

## [0.10.1] - 2026-08-21

### Added
- Realm lifecycle controls in the brush panel: found a new realm (with suggested name), rename the selected realm, and delete it with confirmation (territory reverts to wilderness as an undoable stroke). The palette lists realms that exist only by name.

## [0.10.0] - 2026-08-21

### Added
- **Realms**: every city seeds a territory grown with Dijkstra over the road cost field up to a reach budget (new slider) — borders settle on ridges and rivers, wilderness remains between realms (points-of-light style). Baked into an editable per-cell channel.
- Political map view with solid realm colors, soft tint + dashed borders on the terrain view, large translucent realm labels, realm names derived from their capital, realm info in the cell inspector, and a realm brush with dynamic palette.

## [0.9.5] - 2026-08-20

### Changed
- Single toolbar button whose palette starts with two tab buttons (Terrain / Settlements) that swap the visible tool set; utilities stay visible in both tabs. Reverts the 0.9.4 two-group workaround.

## [0.9.4] - 2026-08-20

### Changed
- The scene toolbar was split into Terrain and Settlements control groups sharing the single HexWorld layer (superseded by 0.9.5).

## [0.9.3] - 2026-08-20

### Added
- Procedural fantasy names for settlements, POIs, river systems and enclosed water bodies, stored sparsely in flags; manual renames always survive regeneration.
- Map labels with halo (bold cities, italic blue water) in terrain/height views, client-local visibility toggle, and a rename tool (click to name via dialog; empty removes the label).

## [0.9.2] - 2026-08-20

### Fixed
- Stray quote/slash characters painted next to map glyphs with modern Font Awesome alt-text `content` syntax.

### Added
- Marker style choice: icon on a round badge (default) or bare outlined icon.

## [0.9.1] - 2026-08-20

### Fixed
- Missing map glyphs: the renderer now reads the exact Font Awesome family/weight and glyph characters from Foundry's own CSS, immune to FA version drift, plus a fonts-ready repaint.

### Added
- Visual icon picker settings menu replacing the five raw dropdowns.

## [0.9.0] - 2026-08-20

### Added
- Configurable site icons: map markers render the same Font Awesome glyph shown in the editor palettes (curated 18-icon catalog, five world-scoped settings, live repaint on change).

## [0.8.0] - 2026-08-20

### Added
- **Settlements, POIs and roads**: habitability-scored cities and villages with greedy spacing, remote POIs (dungeons, temples, ruins) placed by distance from civilization, and a road network built with Dijkstra over a terrain cost field. Baked into two editable per-cell channels so terrain edits never move a city.
- Tools: site palette (place/remove), two-click route tracing reusing the same cost field, road eraser, settlements density slider, and explicit settlement regeneration.

## [0.7.1] - 2026-08-20

### Fixed
- The brush HUD reopens after scene rebuilds (sea-level apply, remote edits) and the brush cursor survives rebuilds.

### Added
- Toolbar button to show/hide the brush HUD.

## [0.7.0] - 2026-08-20

### Added
- Pipeline v2 (new worlds only; existing scenes stay byte-identical via `params.algo`): domain-warped coastlines, per-template mountain range polylines, and orographic rain shadow with zonal winds.
- Editing UX: brush cursor, redo stacks, false-color debug views (height/temperature/moisture), live cell inspector, GM sea-level re-freeze dialog, and reopening a scene inside the generator with locked grid structure and apply-to-scene.

## [0.6.0] - 2026-08-20

### Added
- Manual river editing: click to add a river that follows the real drainage down to water/border/existing river, or remove downstream stopping at confluences fed by another branch. Third per-cell channel; dormant while submerged.

## [0.5.0] - 2026-08-20

### Added
- Biome override painting: categorical brush with palette and eraser, applied after derived biome assignment on land only (water stays elevation-driven; submerged overrides stay dormant). Second per-cell channel with per-channel stroke undo.

## [0.4.0] - 2026-08-20

### Added
- Semantic terrain brushes (water / lowland / mountain) that push elevation toward targets relative to the frozen sea level, so coasts, rivers, climate and biomes stay derived and consistent.

## [0.3.1] - 2026-08-20

### Fixed
- Scene controls registration.

## [0.3.0] - 2026-08-20

### Changed
- **Data-driven scenes**: scenes no longer bake a background image — the world data (seed + params + compressed edits) in scene flags is the single source of truth. A canvas layer rebuilds the world deterministically on view and renders it through a PrimarySpriteMesh texture. v0.2.x image-based scenes keep working.

### Added
- In-scene terrain editing for GMs: raise/lower/smooth brushes shared with the preview, radius/strength HUD, per-stroke undo and reset, live re-derivation and multi-client sync.

## [0.2.0] - 2026-08-20

### Added
- Terrain editing on the preview canvas: raise/lower/smooth brushes with adjustable radius/strength, per-stroke undo, live re-derivation (worldgen split into buildBase/deriveWorld with frozen sea level), edits persisted compressed in scene flags.

### Fixed
- Template shapes: softened border falloff (every template collapsed into one central landmass), tuned frequencies, per-template default water fraction, smoothing pass, and large enclosed below-sea bodies classify as inland seas.

## [0.1.1] - 2026-08-20

### Fixed
- Empty scenes on Foundry v14: the background image moved to the embedded Scene Levels collection (`LevelData.background.src`); branch by release generation to support v13 and v14.

## [0.1.0] - 2026-08-20

### Added
- Initial release: procedural fantasy world generator integrated in Foundry VTT (v13/v14). Deterministic seeded pipeline (simplex fBm + ridged heightmap templates, quantile sea level, latitude/altitude temperature, moisture, priority-flood hydrology with connected rivers and lakes, Whittaker biomes), cartographic render (hillshade, ocean depth, coastline, flux-width rivers), generator window with live preview, and direct scene creation pixel-aligned to Foundry's own hex/square grid geometry.
- GitHub release workflow and manifest installation.
