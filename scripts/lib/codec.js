/**
 * Encoding of painted elevation deltas for persistence in scene flags.
 * Quantized to Int8 (±1.27 in steps of 0.01) and base64-encoded, so edited
 * worlds remain reproducible without storing 100KB float arrays.
 */

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
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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
