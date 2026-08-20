/**
 * 2D simplex noise (Gustavson-style) seeded from a PRNG, plus fBm and
 * ridged-multifractal helpers used by the heightmap builder.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);

export class Simplex2 {
  /** @param {() => number} rng seeded PRNG in [0,1) */
  constructor(rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    this.permMod8 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod8[i] = this.perm[i] % 8;
    }
  }

  /** @returns {number} noise value in roughly [-1, 1] */
  noise(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      const gi = this.permMod8[ii + this.perm[jj]] * 2;
      n0 = t0 * t0 * (GRAD[gi] * x0 + GRAD[gi + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      const gi = this.permMod8[ii + i1 + this.perm[jj + j1]] * 2;
      n1 = t1 * t1 * (GRAD[gi] * x1 + GRAD[gi + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      const gi = this.permMod8[ii + 1 + this.perm[jj + 1]] * 2;
      n2 = t2 * t2 * (GRAD[gi] * x2 + GRAD[gi + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }
}

/** Fractal Brownian motion. Returns approximately [-1, 1]. */
export function fbm(noise, x, y, { octaves = 5, lacunarity = 2, gain = 0.5 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp mountain ridges. Returns [0, 1]. */
export function ridged(noise, x, y, { octaves = 4, lacunarity = 2, gain = 0.5 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const v = 1 - Math.abs(noise.noise(x * freq, y * freq));
    sum += amp * v * v;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
