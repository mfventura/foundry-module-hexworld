/**
 * Single accessor for a scene's HexWorld data flags: returns the flags object
 * for data-driven scenes (version >= 2 with params), null otherwise. Any
 * future flags migration hooks in here instead of at every gate.
 */
export function worldFlags(scene) {
  const f = scene?.flags?.hexworld;
  return f?.params && (f.version ?? 1) >= 2 ? f : null;
}
