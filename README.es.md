# HexWorld – Generador de Mundos para Foundry VTT

[English](README.md) · **Español** · [Changelog](CHANGELOG.md) (en inglés)

Módulo de generación procedural de mundos de fantasía totalmente integrado en Foundry VTT, inspirado en [Azgaar's Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator). Genera mapas con alturas, climas y biomas coherentes, ríos, lagos, mares y montañas, y crea la Escena directamente en Foundry con rejilla hexagonal o cuadrada perfectamente alineada.

## Características

- **Generación determinista por semilla**: la misma semilla y parámetros producen siempre el mismo mundo. Las escenas guardan solo los datos del mundo (semilla + parámetros + ediciones) en sus flags — sin imagen horneada — y una capa de canvas del módulo regenera y dibuja el mundo cada vez que se abre la escena.
- **Rejilla nativa de Foundry**: la geometría y adyacencia se calculan con las propias clases `foundry.grid.*`, por lo que el mapa encaja píxel a píxel con la rejilla de la escena (hexágonos en filas/columnas, par/impar, o cuadrados).
- **Pipeline de terreno con sentido**:
  1. Mapa de alturas por ruido simplex fBm + crestas con plantillas (*Continentes, Pangea, Archipiélago, Islas*), costas con domain warp y cordilleras como polilíneas.
  2. Nivel del mar por cuantil (el slider de "% de agua" es exacto).
  3. Temperatura por latitud + enfriamiento por altitud (presets: templado, frío, tropical, planeta completo).
  4. Humedad por ruido + proximidad al agua + sombra de lluvia orográfica con vientos zonales.
  5. Hidrología real: relleno de depresiones (priority-flood), acumulación de flujo, ríos conectados que desembocan en el mar y lagos en cuencas cerradas.
  6. Biomas tipo Whittaker (temperatura × humedad) con montañas, nieves, glaciares, humedales y playas.
- **Render cartográfico**: sombreado de relieve (hillshade), gradiente de profundidad oceánica, línea de costa y ríos con grosor según caudal — y **arte de biomas** opcional: una imagen por bioma dibujada dentro de cada celda (set por defecto incluido, cada bioma reemplazable con tu propio arte en Ajustes → Arte de biomas, toggle por cliente entre arte y colores planos).
- **Edición en la propia escena (GM)**: pinceles de elevar/hundir/suavizar más herramientas semánticas de agua/llanura/montaña, paleta de overrides de bioma, añadir/quitar ríos manualmente, radio de pincel desde 0.1 (una celda) hasta 8 celdas, deshacer/rehacer por trazo, re-congelar el nivel del mar, vistas de depuración (altura/temperatura/humedad) e inspector de celda en vivo. Todo se re-deriva en vivo mientras pintas y se sincroniza a todos los clientes al soltar el trazo. Las mismas herramientas están en la previsualización del generador, y las escenas existentes se pueden reabrir en él.
- **Asentamientos, PDI y caminos**: ciudades y pueblos colocados por habitabilidad, mazmorras/templos/ruinas remotos, red de carreteras sobre un campo de coste del terreno, trazado manual de rutas con dos clicks e iconos de mapa configurables (selector Font Awesome, estilo insignia o icono suelto).
- **Marcadores libres**: coloca un marcador con su propio icono (la guarida, el portal, el vado…) en cualquier celda desde la paleta de sitios; cada marcador elige su icono del catálogo y se nombra a mano.
- **Nombres y etiquetas**: topónimos procedurales para asentamientos, ríos y masas de agua, herramienta de renombrar, layout de etiquetas anti-colisión y herramienta de arrastrar etiquetas.
- **Switches de visibilidad de capas**: conmuta etiquetas, fronteras de reinos, sitios y PDI, caminos y ríos de forma independiente (HUD de escena y barra del generador) para despejar la vista — local al cliente y puramente visual, los datos no se tocan.
- **Reinos**: territorios políticos points-of-light crecidos desde cada ciudad, vista política, pincel de reino (tierra y agua — las aguas costeras y los mares se pueden reclamar a mano) y gestión de fundar/renombrar/eliminar reinos.
- **Publicar al diario**: un click crea un JournalEntry de la escena con una página por elemento nombrado (asentamientos, PDI, marcadores, reinos, ríos, lagos, mares) y notas de mapa clicables sobre los sitios. Cada página nueva llega con una ficha de datos (bioma, clima, reino, desembocadura, capital…) y unos párrafos de lore procedural localizado con enlaces a las páginas relacionadas — sembrado por elemento, estable entre sincronizaciones. Re-sincronizar solo añade lo que falta y sigue los renombres — el contenido que escribas en las páginas nunca se pisa.

## Instalación

En Foundry: **Add-on Modules → Install Module** y pega esta URL de manifiesto:

```
https://github.com/mfventura/foundry-module-hexworld/releases/latest/download/module.json
```

Apunta siempre a la última release publicada, así que las actualizaciones llegan por el botón *Update* de Foundry.

### Publicar una nueva versión

1. Añade la entrada de la release a `CHANGELOG.md` (obligatorio) y revisa ambos README (actualiza si el cambio es de cara al usuario).
2. Sube `version` (y la URL de `download`) en `module.json`.
3. Etiqueta y publica:

```bash
git tag v0.11.2 && git push origin main v0.11.2
```

El workflow de GitHub Actions inyecta la versión del tag en `module.json`, empaqueta `module.zip` y publica la release con ambos ficheros adjuntos.

## Instalación (desarrollo)

1. Enlaza o copia esta carpeta en el directorio de módulos de Foundry con el nombre `hexworld`:
   ```bash
   ln -s /ruta/a/hexworld "<FoundryData>/Data/modules/hexworld"
   ```
2. Activa **HexWorld – Generador de Mundos** en el mundo.
3. Como GM, abre la pestaña **Escenas** y pulsa **Generar Mundo** (botón al pie del panel).

También disponible por API/macro: `game.modules.get("hexworld").api.open()`.

## Uso

1. Elige plantilla, tipo de rejilla, tamaño (columnas × filas, máx. 25.000 celdas) y parámetros de clima.
2. **Generar previsualización** — itera con distintas semillas (el dado genera una nueva).
3. Opcionalmente edita la previsualización con la barra de herramientas (terreno, biomas, ríos, sitios, caminos, reinos, etiquetas).
4. **Crear escena** — la escena guarda los datos del mundo y se renderiza sola al abrirse.

## Estructura

```
scripts/
  main.js                    # hooks, capa, scene controls, botón del sidebar, ajustes, API
  lib/                       # PRNG con semilla, ruido simplex, codec de flags, MinHeap
  generator/                 # rejilla, alturas+plantillas, clima, hidrología, biomas,
                             # pincel, sitios+caminos, reinos, nombres, orquestador
  edit/edit-session.js       # motor de edición compartido (canales, herramientas, undo)
  render/renderer.js         # render 2D a canvas (preview y textura de escena)
  render/biome-art.js        # arte por bioma (set por defecto + overrides + sprites)
  render/site-icons.js       # catálogo Font Awesome y resolución de glifos
  render/labels.js           # layout de etiquetas anti-colisión
  canvas/                    # capa de interacción, mesh de terreno, HUD del pincel
  scene/scene-builder.js     # creación de la Escena (solo datos, sin imagen)
  ui/                        # ventana del generador, selectores de iconos/arte, inspector
assets/biomes/               # arte de biomas por defecto (17 PNG)
```

## Compatibilidad

Foundry VTT **v14** (mínimo v13). Sin dependencias ni build step (ESM puro). El módulo usa los namespaces modernos (`foundry.applications.ux/apps`, `foundry.grid.*`, ApplicationV2) y tolera el eje de elevación (`k`) que v14 introduce con Scene Levels.

## Hoja de ruta

- [x] Edición manual del terreno (elevar/hundir/suavizar), en la previsualización y en la escena creada.
- [x] Pincel de bioma y de agua (overrides por celda, forzar lago/mar).
- [x] Relleno por texturas: una imagen por bioma dibujada dentro de cada celda (set por defecto en `assets/biomes/`, configurable por el GM, toggle cliente arte/colores).
- [x] Nombres procedurales con etiquetas (asentamientos incluidos).
- [x] Asentamientos, reinos y carreteras.
- [x] Capas de depuración: altura, temperatura, humedad.
- [ ] «Hornear» a imagen: exportar el estado actual como background estático.
