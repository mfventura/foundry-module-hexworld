# HexWorld – Generador de Mundos para Foundry VTT

Módulo de generación procedural de mundos de fantasía totalmente integrado en Foundry VTT, inspirado en [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator). Genera mapas con alturas, climas, biomas coherentes, ríos, lagos, mares y montañas, y crea la escena directamente en Foundry con rejilla hexagonal o cuadrada perfectamente alineada.

## Características (v0.1)

- **Generación determinista por semilla**: la misma semilla y parámetros producen siempre el mismo mundo. Los parámetros se guardan en las flags de la escena, así que cualquier mapa es regenerable.
- **Rejilla nativa de Foundry**: la geometría y adyacencia se calculan con las propias clases `foundry.grid.*`, por lo que la imagen encaja píxel a píxel con la rejilla de la escena (hexágonos en filas/columnas, par/impar, o cuadrados).
- **Pipeline de terreno con sentido**:
  1. Mapa de alturas por ruido simplex fBm + crestas (ridged) con plantillas: *Continentes, Pangea, Archipiélago, Islas*.
  2. Nivel del mar por cuantil (el slider de "% de agua" es exacto).
  3. Temperatura por latitud + enfriamiento por altitud (presets: templado, frío, tropical, planeta completo).
  4. Humedad por ruido + proximidad al agua.
  5. Hidrología real: relleno de depresiones (priority-flood), acumulación de flujo, ríos conectados que desembocan en el mar y lagos en cuencas cerradas.
  6. Biomas tipo Whittaker (temperatura × humedad) con montañas, nieves, glaciares, humedales y playas.
- **Render cartográfico**: sombreado de relieve (hillshade), gradiente de profundidad oceánica, línea de costa y ríos con grosor según caudal.
- **Escenas data-driven, sin imagen**: la escena no guarda ningún fichero — solo los datos del mundo (semilla + parámetros + ediciones) en sus flags. Una capa de canvas del módulo regenera el mundo determinísticamente y lo dibuja al abrir la escena.
- **Edición del terreno en la propia escena**: grupo de controles «Terreno HexWorld» (solo GM) con pinceles de elevar, hundir y suavizar, HUD de radio/fuerza, deshacer por trazo y descartar. Ríos, lagos, costas y biomas se recalculan en vivo mientras pintas, y los cambios se sincronizan a todos los clientes al soltar el trazo. Los mismos pinceles están disponibles en la previsualización antes de crear la escena.

## Instalación

En Foundry: **Add-on Modules → Install Module** y pega esta URL de manifiesto:

```
https://github.com/mfventura/foundry-module-hexworld/releases/latest/download/module.json
```

Apunta siempre a la última release publicada, así que las actualizaciones llegan por el botón *Update* de Foundry.

### Publicar una nueva versión

```bash
git tag v0.2.0 && git push origin v0.2.0
```

El workflow de GitHub Actions inyecta la versión del tag en `module.json`, empaqueta `module.zip` y publica la release con ambos ficheros adjuntos.

## Instalación (desarrollo)

1. Enlaza o copia esta carpeta en el directorio de módulos de Foundry con el nombre `hexworld`:
   ```bash
   ln -s /Users/manuel.fernandezventura/hexworld "<FoundryData>/Data/modules/hexworld"
   ```
2. Activa **HexWorld – Generador de Mundos** en el mundo.
3. Como GM, abre la pestaña **Escenas** y pulsa **Generar Mundo** (botón al pie del panel).

También disponible por API/macro: `game.modules.get("hexworld").api.open()`.

## Uso

1. Elige plantilla, tipo de rejilla, tamaño (columnas × filas, máx. 25.000 celdas) y parámetros de clima.
2. **Generar previsualización** — itera con distintas semillas (el dado genera una nueva).
3. **Crear escena** — renderiza a resolución completa y crea la escena.

## Estructura

```
scripts/
  main.js                    # hooks, capa, scene controls, botón del sidebar, API
  lib/random.js              # PRNG con semilla (xmur3 + mulberry32)
  lib/noise.js               # simplex 2D, fBm, ridged
  lib/codec.js               # codificación de ediciones (Int8+base64) para flags
  generator/grid.js          # WorldGrid: geometría/adyacencia vía foundry.grid.*
  generator/heightmap.js     # alturas + plantillas + nivel del mar
  generator/climate.js       # temperatura y humedad
  generator/hydrology.js     # océanos/mares interiores, lagos, flujo, ríos
  generator/biomes.js        # tabla de biomas y colores
  generator/brush.js         # pincel de terreno compartido (preview y escena)
  generator/worldgen.js      # orquestador: buildBase + deriveWorld
  render/renderer.js         # render 2D a canvas (preview y textura de escena)
  canvas/hexworld-layer.js   # capa de interacción: edición en escena y sync
  canvas/terrain-mesh.js     # PrimarySpriteMesh con la textura del terreno
  canvas/brush-hud.js        # HUD flotante de radio/fuerza
  scene/scene-builder.js     # creación de la Escena (solo datos, sin imagen)
  ui/generator-app.js        # ventana ApplicationV2 del generador
```

## Compatibilidad

Foundry VTT **v14** (mínimo v13). Sin dependencias ni build step (ESM puro). El módulo usa los namespaces modernos (`foundry.applications.ux/apps`, `foundry.grid.*`, ApplicationV2) y tolera el eje de elevación (`k`) que V14 introduce con Scene Levels.

## Hoja de ruta

- [x] Edición manual del terreno (elevar/hundir/suavizar), en la previsualización y en la escena creada.
- [ ] Pincel de bioma y de agua (overrides por celda, forzar lago/mar).
- [ ] Relleno por texturas: un asset hexagonal por bioma (atlas configurable por el GM).
- [ ] «Hornear» a imagen: exportar el estado actual como background estático.
- [ ] Nombres procedurales (mares, cordilleras, regiones) con etiquetas como Drawings/Notes.
- [ ] Asentamientos, estados y carreteras.
- [ ] Capas: precipitación, temperatura, altura (modo de vista de depuración).
