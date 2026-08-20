/**
 * Encoding of painted terrain edits for persistence in scene flags.
 * Elevation deltas are quantized to Int8 (±1.27 in steps of 0.01); biome
 * overrides are one byte per cell (biome id, NO_OVERRIDE = none). Both are
 * base64-encoded so edited worlds remain reproducible without storing 100KB
 * arrays.
 */

/** Sentinel byte for "no biome override on this cell". */
export const NO_OVERRIDE = 255;

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** @returns {string|null} null when there are no effective edits */
export function encodeEdits(edits) {
  if (!edits) return null;
  const bytes = new Uint8Array(edits.length);
  let any = false;
  for (let i = 0; i < edits.length; i++) {
    const q = Math.max(-127, Math.min(127, Math.round(edits[i] * 100)));
    if (q !== 0) any = true;
    bytes[i] = q & 0xFF;
  }
  if (!any) return null;
  return bytesToBase64(bytes);
}

/** @returns {Float32Array|null} inverse of encodeEdits */
export function decodeEdits(encoded, length) {
  if (!encoded) return null;
  const binary = atob(encoded);
  if (binary.length !== length) return null;
  const edits = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let q = binary.charCodeAt(i);
    if (q > 127) q -= 256;
    edits[i] = q / 100;
  }
  return edits;
}

/** @returns {string|null} null when no cell has an override */
export function encodeOverrides(overrides) {
  if (!overrides) return null;
  let any = false;
  for (let i = 0; i < overrides.length; i++) {
    if (overrides[i] !== NO_OVERRIDE) { any = true; break; }
  }
  if (!any) return null;
  return bytesToBase64(overrides);
}

/** @returns {Uint8Array|null} inverse of encodeOverrides */
export function decodeOverrides(encoded, length) {
  if (!encoded) return null;
  const binary = atob(encoded);
  if (binary.length !== length) return null;
  const overrides = new Uint8Array(length);
  for (let i = 0; i < length; i++) overrides[i] = binary.charCodeAt(i);
  return overrides;
}
