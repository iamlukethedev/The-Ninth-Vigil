/**
 * Deterministic PRNG (mulberry32) + value/simplex-ish noise helpers.
 * Never use Math.random() in this project — the screenshot critic needs
 * pixel-stable frames.
 */
export function makeRand(seed = 1) {
  let a = (seed >>> 0) || 1;
  const r = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + r() * (hi - lo);
  r.int = (lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  r.gauss = (mu = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  r.chance = (p) => r() < p;
  r.onSphere = () => {
    const z = r.range(-1, 1);
    const t = r.range(0, Math.PI * 2);
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(t), s * Math.sin(t), z];
  };
  r.fork = (n) => makeRand((seed * 2654435761 + n * 40503) >>> 0);
  return r;
}

/* ---- hash noise (deterministic, seedable, no allocation) ---- */
export function hash2(x, y, seed = 0) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Gradient (Perlin-style) noise — smoother than value noise, no grid artifacts. */
export function perlin2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix, iy, dx, dy) => {
    const a = hash2(ix, iy, seed) * 6.28318530718;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  return (
    lerp(
      lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
      lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u),
      v
    ) * 0.7071 + 0.5
  );
}

export function fbm2(x, y, { octaves = 5, lacunarity = 2.0, gain = 0.5, seed = 0, ridged = false } = {}) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = perlin2(x * freq, y * freq, seed + i * 131);
    if (ridged) n = 1 - Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Worley / cellular — for cracks, scales, cobblestone, caustics. */
export function worley2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 977);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return { f1: Math.sqrt(f1), f2: Math.sqrt(f2), edge: Math.sqrt(f2) - Math.sqrt(f1) };
}
