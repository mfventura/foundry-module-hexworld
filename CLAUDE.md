# HexWorld — notas para el desarrollo

Módulo de Foundry VTT (**objetivo: v14**, mínimo v13) de generación procedural de mundos, estilo Azgaar pero integrado: genera terreno por celdas alineadas a la rejilla y crea Escenas directamente.

## Principios de diseño (no romper)

- **JavaScript ESM puro, sin build step.** Foundry carga `scripts/main.js` vía `esmodules`. No introducir bundlers ni TypeScript sin decisión explícita.
- **Determinismo por semilla.** Todo lo aleatorio deriva de `params.seed` con streams separados por etapa (`seed + ":elev"`, `seed + ":moist"`). Las escenas guardan solo `params` en `flags.hexworld` — el mundo se regenera, nunca se serializan los arrays.
- **La geometría viene de Foundry.** `generator/grid.js` instancia `foundry.grid.SquareGrid`/`HexagonalGrid` con el mismo `{type, size}` que tendrá la escena; centros, vértices y vecinos salen de ahí. Así la imagen renderizada encaja píxel-perfecto con la rejilla de la escena (padding 0, origen 0,0). No reimplementar matemática hexagonal a mano.
- **Objetivo Foundry v14.** Se usan directamente los namespaces modernos: `foundry.applications.ux.FormDataExtended`, `foundry.applications.apps.FilePicker.implementation`, `foundry.grid.*`; el hook `renderSceneDirectory` recibe HTMLElement (AppV2). No añadir fallbacks a globals legacy (v12) — están eliminados o en vías de eliminación.
- **V14 y Scene Levels**: `getCenterPoint`/`getAdjacentOffsets` pueden devolver componentes 3D (`elevation`, `k`); el generador trabaja en 2D e ignora/dedupe esos campos (ver `grid.js`). Los breaking changes de v14 (Active Effects V2, eliminación de MeasuredTemplates y TinyMCE) no afectan al módulo.
- **Fondo de escena en v14**: `Scene.background` ya NO existe en la raíz del esquema — el fondo vive en la colección embebida `levels` (`LevelData.background = {src, tint, alphaThreshold, color}`). Un `background` raíz se descarta en silencio (escena con rejilla vacía). `scene-builder.js` bifurca por `game.release.generation` (≥14 → `levels: [{background: {src}}]`; 13 → `background` raíz + `fog.exploration`).

## Pipeline (generator/worldgen.js)

Dividido en `buildBase(params)` (grid + heightmap + nivel del mar) y `deriveWorld(base, edits)` (resto). heightmap (fBm+ridged+falloff por plantilla, 1 pasada de suavizado) → nivel del mar por cuantil del slider de agua → océano por flood-fill desde el borde; masas encerradas bajo el mar ≥1.5% de celdas = mares interiores (isOcean), menores = lagos → priority-flood (relleno de depresiones; pits > 0.02 = lagos) → temperatura (latitud+altitud, °C) → humedad (ruido+BFS a agua) → flujo acumulado sobre la superficie rellenada (ríos = cuantil de flujo, conectados por construcción) → biomas (tabla Whittaker + montaña/nieve/humedal/playa).

**Edición de terreno**: `edits` es un Float32Array de deltas de elevación sobre `elevBase`; el nivel del mar queda congelado al de la base (pintar no desplaza costas ajenas). El pincel (`generator/brush.js`, compartido por preview y escena) selecciona celdas por distancia euclídea a los centros, re-derivando en vivo con throttle. Además de raise/lower/smooth hay pinceles semánticos (`water`/`land`/`mountain`) que empujan la elevación hacia un objetivo relativo al mar congelado (`toolTarget`): agua = sea×0.5, llanura = sea+12% del rango, montaña = sea+70% (por encima del umbral 0.55 de `assignBiomes`); la fuerza actúa como velocidad de convergencia (`blend = min(1, strength×10)`). Se sigue editando solo elevación — el tipo de celda (océano/lago/bioma/ríos) siempre se deriva, nunca se fuerza. Las ediciones se guardan en flags como Int8 (delta×100) en base64 (`lib/codec.js`).

## Escenas data-driven (v0.3.0, flags version 2)

Las escenas NO llevan imagen: `flags.hexworld = {version: 2, seed, params, edits, stats}` es la fuente de verdad. Arquitectura:
- `canvas/hexworld-layer.js` — `InteractionLayer` registrada en `CONFIG.Canvas.layers.hexworld` (grupo interface). En `_draw` reconstruye el mundo desde flags (`buildBase`+`decodeEdits`+`deriveWorld`) y lo pinta. Trazos del GM (drag left) → `applyBrush` → re-derive + repintado con throttle → al soltar, persiste flags con `{hexworldLocal: true}`; el hook `updateScene` en main.js reconstruye en los demás clientes (y se salta al autor).
- `canvas/terrain-mesh.js` — el render NO es por polígonos PIXI: se reutiliza el renderer 2D a un canvas offscreen (cap ~10 MP) que se convierte en textura de un `PrimarySpriteMesh` en `canvas.primary`, posicionado en `(sceneX, sceneY)` y estirado al tamaño de escena (elevation 0, sort -9999, sortLayer 300 → bajo tiles/tokens). Repintar = re-render 2D + `baseTexture.update()`. Si algo falla con PrimarySpriteMesh en una versión futura, mirar su firma de constructor ({texture}) — es el punto más sensible a cambios de core.
- Los controles de escena (`getSceneControlButtons`, formato record de v13+) solo aparecen para GM en escenas con flags v2. **Ojo v13+**: el core ya NO activa `canvas[control.layer]` al pulsar el grupo — el `onChange` del control debe llamar a `canvas.hexworld.activate()` (si no, la capa nunca es `activeLayer`, no recibe `_onClickLeft`/`_onDragLeft*` ni ejecuta `_activate`, y las herramientas "no hacen nada" sin errores). El hook sí se re-dispara por escena (`ui.controls.render({reset: true})` en cada draw del canvas), así que el gating por `canvas.scene` es válido. HUD de radio/fuerza: `canvas/brush-hud.js` (AppV2 sin frame), abierto en `_activate`.
- Escenas v0.2.x (flags version 1, con imagen horneada) siguen funcionando: la capa las ignora.
- Coordenadas: los datos del mundo viven en el espacio del grid (origen 0,0); en escena hay que restar `canvas.dimensions.sceneX/sceneY` al puntero.

**Plantillas** (heightmap.js): cada una lleva su `water` por defecto que la UI adopta al cambiar de plantilla. El `falloffDrop` debe mantenerse bajo salvo en pangea: como el mar es un cuantil, un falloff agresivo consume todo el presupuesto de agua y toda plantilla colapsa en una única masa central (bug corregido en v0.2.0 — verificado visualmente con scratchpad/viz.mjs, que renderiza BMPs por plantilla).

Límite: `MAX_CELLS = 25000`. Tamaño de imagen final capado a 13000 px de lado (Foundry estira el fondo a las dimensiones de la escena, la alineación se mantiene).

## Pruebas

No hay framework de tests. Smoke test del pipeline en Node con mocks de `foundry.grid`:
el patrón está en el scratchpad de la sesión original (`smoke.mjs`): define `globalThis.CONST` y `globalThis.foundry.grid` con mocks, importa `worldgen.js` y valida land%, ríos que desembocan, ausencia de NaN y determinismo. Reproducirlo si se toca el generador.

Chequeo de sintaxis: `node --input-type=module --check < archivo.js`.

## Estado / siguientes fases

v0.1 completa: generación + preview + creación de escena. Pendiente (en orden previsto): nombres procedurales y etiquetas, asentamientos/estados/carreteras, edición manual del terreno, regenerar escena desde flags, capas de depuración (altura/temperatura/humedad).
