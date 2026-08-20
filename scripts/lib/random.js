/**
 * Deterministic, seedable randomness. Everything the generator does derives
 * from a seed string so a world can always be regenerated from its flags.
 */

/** xmur3 string hash — produces a 32-bit seeding function from a string. */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32 PRNG — fast, decent quality, 32-bit state. Returns () => [0,1). */
export function mulberry32(a) {
  return function() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a PRNG from a seed string. */
export function makeRng(seedString) {
  const h = hashSeed(String(seedString));
  return mulberry32(h());
}

/** Short human-friendly random seed, e.g. "k3f9x2". */
export function randomSeedString() {
  let s = "";
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
