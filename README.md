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
- **Creación de escena en un clic**: sube la imagen (webp) a `worlds/<mundo>/hexworld/` y crea la escena con rejilla, distancia y unidades configuradas.

## Instalación

En Foundry: **Add-on Modules → Install Module** y pega esta URL de manifiesto:

```
https://github.com/mfventura/hexworld/releases/latest/download/module.json
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
  main.js                  # hooks, botón del sidebar, API pública
  lib/random.js            # PRNG con semilla (xmur3 + mulberry32)
  lib/noise.js             # simplex 2D, fBm, ridged
  generator/grid.js        # WorldGrid: geometría/adyacencia vía foundry.grid.*
  generator/heightmap.js   # alturas + plantillas + nivel del mar
  generator/climate.js     # temperatura y humedad
  generator/hydrology.js   # océanos, lagos, relleno de depresiones, flujo, ríos
  generator/biomes.js      # tabla de biomas y colores
  generator/worldgen.js    # orquestador del pipeline
  render/renderer.js       # render a canvas (preview y fondo de escena)
  scene/scene-builder.js   # subida de imagen y creación de la Escena
  ui/generator-app.js      # ventana ApplicationV2
```

## Compatibilidad

Foundry VTT **v14** (mínimo v13). Sin dependencias ni build step (ESM puro). El módulo usa los namespaces modernos (`foundry.applications.ux/apps`, `foundry.grid.*`, ApplicationV2) y tolera el eje de elevación (`k`) que V14 introduce con Scene Levels.

## Hoja de ruta

- [ ] Nombres procedurales (mares, cordilleras, regiones) con etiquetas como Drawings/Notes.
- [ ] Asentamientos, estados y carreteras.
- [ ] Edición manual del terreno (pincel de altura/bioma) antes de crear la escena.
- [ ] Exportar/importar datos del mundo; regenerar escena desde flags.
- [ ] Capas: precipitación, temperatura, altura (modo de vista de depuración).
