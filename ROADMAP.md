# HexWorld — Roadmap v0.12 → v0.16

Diseño acordado el 2026-08-22. Cada versión es una release completa (CHANGELOG en inglés,
revisión de README bilingüe, bump + tag `v*`). Los invariantes del proyecto aplican a todas
las fases: streams RNG nuevos creados SIEMPRE después de los existentes, canales opcionales
merge-safe en `flags.hexworld`, nunca subir `algo` en escenas existentes, smoke tests en
`scratchpad/`.

## v0.12 — Diarios, notas y marcadores

Sincronización con documentos Foundry + marcadores libres (inspirado en los Markers de Azgaar).

- **Publicar al diario**: botón que crea/sincroniza JournalEntries para asentamientos, PDI,
  reinos y ríos nombrados, y coloca documentos `Note` clicables sobre la escena en la celda
  de cada sitio. Idempotente: rastreo por flag `flags.hexworld.journalKey` en el documento,
  nunca por nombre. La sincronización solo toca el **nombre**; el cuerpo que edite el GM no
  se pisa jamás. Contenido inicial generado desde datos del mundo (bioma, reino, río cercano,
  tipo de sitio). Renombrar con la herramienta rename actualiza el diario.
- **Marcadores libres**: herramienta para colocar en cualquier celda un marcador con icono del
  catálogo FA existente y nombre (la guarida, el portal, el vado…), sin que lo haya generado
  el mundo. Implementación: nuevo tipo en el canal `sites` (id 6 = marcador custom) + mapa
  disperso `flags.hexworld.markers` (`{celda: iconName}`) para el icono por marcador — así
  heredan gratis render, etiquetas, rename, undo y journal-sync.

Riesgo bajo, valor inmediato en mesa. No toca pipeline ni `algo`.

## v0.13 — Modo hexcrawl: viaje y zonas

- **Ruta de viaje**: herramienta de dos clicks (como `routeRoad`) que muestra distancia y
  **días de viaje** sobre el campo de coste real (velocidad configurable como ajuste de
  mundo; carretera < camino < campo abierto), desglose por etapas enviable al chat.
  `generator/travel.js` convierte coste→horas por bioma/pendiente/red viaria. Herramienta de
  consulta: no persiste canales. Smoke test de monotonía (carretera ≤ camino ≤ campo abierto;
  océano inalcanzable).
- **Zonas** (Azgaar Zones): pincel de áreas con nombre y color translúcido (territorio
  infestado, ducado en guerra…) como overlay. Canal u8 `flags.hexworld.zones` + mapa
  `zoneDefs` (nombre, color); pincel categórico calcado de `applyBiomeBrush`, paleta dinámica
  como la de reinos.

## v0.14 — Culturas abiertas: predefinidas + editor CRUD (Namesbase)

Cada reino tiene una cultura que da sabor a sus topónimos; sistema abierto al estilo
Namesbase de Azgaar:

- 4–6 culturas predefinidas de fábrica (latina, nórdica, árabe-desértica, silvana…), no
  borrables pero clonables.
- **Editor de culturas** (AppV2): crear, editar y eliminar culturas propias. Cada cultura
  define nombre, color de acento y su **base de nombres** (lista de nombres de ejemplo →
  cadenas de sílabas por Markov ligero de dígrafos, como Azgaar), más patrones por tipo
  ("Río {name}", "Reino de {name}" personalizables). Vista previa en vivo de 10 nombres.
- Export/import de culturas como JSON.
- Asignación por reino desde el HUD de reinos: auto por defecto (bioma dominante + stream
  `seed+":culture"`), override manual persistente.

Almacenamiento: culturas como **ajuste de mundo** (biblioteca entre escenas, patrón
`biomeArt`); asignación en `flags.hexworld.cultures` (`{realmId: cultureId}`, merge-safe).
Eliminar una cultura en uso degrada a la neutra con aviso. Los nombres ya escritos jamás se
regeneran (`generateNames` solo añade faltantes). Escenas viejas sin el campo → cultura
neutra. Smoke: determinismo con la misma base, CRUD sin romper nombres existentes.

## v0.15 — Profundidad política: provincias, emblemas y demografía

- **Provincias** (Azgaar Provinces): subdivisión opcional de cada reino — cada pueblo/ciudad
  del reino siembra una provincia que crece por Dijkstra dentro del territorio del reino
  (mismo campo de coste de carreteras); fronteras internas punteadas finas, nombre derivado
  de su cabeza + cultura. Canal u8 `flags.hexworld.provinces` horneado como `realms`
  (regenerable por reino, editable con pincel).
- **Emblemas heráldicos** (Azgaar Emblems): escudo procedural determinista por reino y ciudad
  (`seed+":emblem"`) — SVG por composición (partición + tintura + carga de un catálogo de
  ~30 símbolos), color ligado a `REALM_COLORS`. Se pinta junto a la etiqueta del reino y en
  su entrada de diario; editable desde el HUD. Solo overrides en `flags.hexworld.emblems`.
- **Demografía** (Azgaar Burgs): población estimada por asentamiento (habitabilidad × tipo ×
  río/costa), visible en inspector, tooltip y diario. Derivada, no persiste.

Fase grande; troceable (provincias v0.15.0, emblemas v0.15.x).

## v0.16 — Submapas regionales (drill-down)

Equivalente al Submap de Azgaar pero encadenando escenas dentro de Foundry: seleccionar una
región del mapa mundial y generar una **escena hija** a mayor resolución coherente con el
padre — elevación/humedad del padre interpoladas como base + detalle fBm de stream derivado
(`seed+":sub:"+celda`), heredando biomas, ríos, asentamientos, cultura y reino de la región.

- Escena hija con `flags.hexworld.parent = {sceneId, region, params}`, regenerable de flags
  como cualquiera; enlaces bidireccionales padre↔hija (notas de v0.12 reutilizadas).
- Punto de extensión en `heightmap.js` para sembrar por interpolación en vez de plantilla.
- Riesgos: costuras en bordes de región y ríos que cruzan el recorte. Prototipar en
  scratchpad (viz de subregiones) ANTES de la UI.

Llega al final a propósito: hereda culturas, provincias y emblemas ya existentes.

## Backlog (identificado en Azgaar, fuera de estas 5)

- Export/import de mundos (JSON portable de flags v2) + export PNG del mapa — candidato
  natural a v0.17, barato porque los mundos ya son 100% datos.
- Religiones (similar a culturas; esperar a validar ese patrón).
- Goods/comercio; fuerzas militares y simulador de batallas (el sistema de reglas del VTT ya
  cubre combate).
- Conversor imagen→heightmap (importar mapas dibujados como base).
- Editor visual de plantillas de heightmap.
- Export GIS.

## Resumen

| Versión | Funcionalidad | Origen | Valor | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| v0.12 | Diarios + notas + marcadores libres | Foundry + Markers | Alto | Bajo | Bajo |
| v0.13 | Viaje/hexcrawl + zonas | Propio + Zones | Alto | Medio | Bajo |
| v0.14 | Culturas abiertas con editor CRUD | Namesbase | Alto | Medio | Bajo |
| v0.15 | Provincias + emblemas + demografía | Provinces/Emblems/Burgs | Alto | Alto | Medio |
| v0.16 | Submapas regionales | Submap | Muy alto | Alto | Medio-alto |
