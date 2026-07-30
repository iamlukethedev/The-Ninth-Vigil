/**
 * THE NINTH VIGIL — tileable procedural noise toolkit.
 *
 * Everything here is built on the deterministic `hash2` lattice from Rand.js,
 * so the output is bit-identical across runs (the screenshot critic requires
 * pixel-stable frames). The difference from the raw Rand.js helpers is that
 * these variants are *periodic*: `perlinT(u*F, v*F, F, F, seed)` wraps exactly
 * at the tile boundary, which is mandatory for RepeatWrapping textures — a
 * visible seam is an instant art-direction fail.
 *
 * The non-periodic Rand.js helpers (perlin2 / fbm2 / worley2 / valueNoise2) are
 * re-exported and used directly for one-shot fields that never tile
 * (environment probes, sparse decal masks, blue-noise seeding).
 *
 * Performance notes: no allocation in the hot path. Cellular / warp results are
 * written into module-scope scratch records (WK / WP) instead of returning
 * objects — with ~1e6 evaluations per texture, a per-call object would spend
 * more time in the GC than in the noise.
 */
import { hash2, perlin2, fbm2, worley2, valueNoise2 } from '../Rand.js';

export { hash2, perlin2, fbm2, worley2, valueNoise2 };

const TAU = 6.283185307179586;

/* Gradient LUT — perlin2() in Rand.js calls cos/sin per lattice corner, which
 * costs ~4 transcendentals per sample. Same gradients, table-driven. */
const GN = 256;
const GX = new Float32Array(GN);
const GY = new Float32Array(GN);
for (let i = 0; i < GN; i++) {
  const a = ((i + 0.5) / GN) * TAU;
  GX[i] = Math.cos(a);
  GY[i] = Math.sin(a);
}

/* ---------------- scalar helpers ---------------- */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const frac = (v) => v - Math.floor(v);
export const sat = clamp01;

export function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
export function smootherstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** Photoshop-style overlay — used to layer detail without crushing values. */
export function overlay(base, blend) {
  return base < 0.5 ? 2 * base * blend : 1 - 2 * (1 - base) * (1 - blend);
}
export const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function wrapi(v, p) {
  const m = v % p;
  return m < 0 ? m + p : m;
}

/* ---------------- periodic gradient noise ---------------- */
/**
 * Tileable Perlin. `px`/`py` are the integer lattice periods; pass the same
 * value you multiplied the coordinate by (`perlinT(u*8, v*8, 8, 8, seed)`).
 * Separate x/y periods let you stretch noise into directional streaks while
 * staying seamless.
 */
export function perlinT(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

  const x0 = wrapi(xi, px), y0 = wrapi(yi, py);
  const x1 = x0 + 1 >= px ? 0 : x0 + 1;
  const y1 = y0 + 1 >= py ? 0 : y0 + 1;

  let g = (hash2(x0, y0, seed) * GN) | 0;
  const n00 = GX[g] * xf + GY[g] * yf;
  g = (hash2(x1, y0, seed) * GN) | 0;
  const n10 = GX[g] * (xf - 1) + GY[g] * yf;
  g = (hash2(x0, y1, seed) * GN) | 0;
  const n01 = GX[g] * xf + GY[g] * (yf - 1);
  g = (hash2(x1, y1, seed) * GN) | 0;
  const n11 = GX[g] * (xf - 1) + GY[g] * (yf - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 0.7071 + 0.5;
}

/** Tileable value noise — blockier than perlin, good for per-cell tone drift. */
export function valueT(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const x0 = wrapi(xi, px), y0 = wrapi(yi, py);
  const x1 = x0 + 1 >= px ? 0 : x0 + 1;
  const y1 = y0 + 1 >= py ? 0 : y0 + 1;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const t0 = a + (b - a) * u, t1 = c + (d - c) * u;
  return t0 + (t1 - t0) * v;
}

export const FBM_NORMAL = 0;
export const FBM_RIDGED = 1;
export const FBM_BILLOW = 2;

/**
 * Tileable fBm. Periods double alongside the coordinates so every octave wraps.
 * `mode`: 0 normal, 1 ridged (sharp crests — cracks, veins, rock ridges),
 * 2 billow (rounded lumps — clumped soil, moss, cloud).
 */
export function fbmT(x, y, px, py, oct = 4, gain = 0.5, seed = 0, mode = 0) {
  let amp = 0.5, sum = 0, norm = 0;
  let X = x, Y = y, PX = px, PY = py;
  for (let i = 0; i < oct; i++) {
    let n = perlinT(X, Y, PX, PY, seed + i * 131);
    if (mode === FBM_RIDGED) {
      n = n * 2 - 1;
      n = 1 - (n < 0 ? -n : n);
      n *= n;
    } else if (mode === FBM_BILLOW) {
      n = n * 2 - 1;
      n = n < 0 ? -n : n;
    }
    sum += n * amp;
    norm += amp;
    amp *= gain;
    X *= 2; Y *= 2; PX *= 2; PY *= 2;
  }
  return sum / norm;
}

/* ---------------- periodic cellular ---------------- */
/** Scratch record for worleyT — read immediately after the call. */
export const WK = { f1: 0, f2: 0, edge: 0, id: 0, cx: 0, cy: 0 };

/**
 * Tileable Worley/cellular. Returns f1 and fills WK with f1/f2/edge plus the
 * winning cell coordinates so callers can derive stable per-cell randoms
 * (`hash2(WK.cx, WK.cy, otherSeed)`) — that is what makes each cobble, each
 * hammer facet, each leather pore an individual instead of uniform noise.
 */
export function worleyT(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, bx = 0, by = 0;
  for (let j = -1; j <= 1; j++) {
    const cy = yi + j, wy = wrapi(cy, py);
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, wx = wrapi(cx, px);
      const dx = cx + 0.14 + hash2(wx, wy, seed) * 0.72 - x;
      const dy = cy + 0.14 + hash2(wx, wy, seed + 977) * 0.72 - y;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; bx = wx; by = wy; }
      else if (d < f2) { f2 = d; }
    }
  }
  WK.f1 = Math.sqrt(f1);
  WK.f2 = Math.sqrt(f2);
  WK.edge = WK.f2 - WK.f1;
  WK.cx = bx; WK.cy = by;
  WK.id = hash2(bx, by, seed + 31);
  return WK.f1;
}

/**
 * Fast cellular for high-frequency detail (pores, grit, foam, spatter).
 *
 * Feature points are confined to the middle half of each cell, which makes the
 * 2x2 neighbourhood around the sample provably sufficient for f1 — less than
 * half the hashing of the full 3x3 scan. f2/edge are approximate here, so use
 * worleyT when you need the cell *border* rather than the cell *centre*.
 */
export function worleyT4(x, y, px, py, seed) {
  const bx = Math.floor(x + 0.5) - 1;
  const by = Math.floor(y + 0.5) - 1;
  let f1 = 1e9, f2 = 1e9, cx = 0, cy = 0;
  for (let j = 0; j < 2; j++) {
    const gy = by + j, wy = wrapi(gy, py);
    for (let i = 0; i < 2; i++) {
      const gx = bx + i, wx = wrapi(gx, px);
      const dx = gx + 0.25 + hash2(wx, wy, seed) * 0.5 - x;
      const dy = gy + 0.25 + hash2(wx, wy, seed + 977) * 0.5 - y;
      const d = dx * dx + dy * dy;
      if (d < f1) { f2 = f1; f1 = d; cx = wx; cy = wy; }
      else if (d < f2) { f2 = d; }
    }
  }
  WK.f1 = Math.sqrt(f1);
  WK.f2 = Math.sqrt(f2);
  WK.edge = WK.f2 - WK.f1;
  WK.cx = cx; WK.cy = cy;
  WK.id = hash2(cx, cy, seed + 31);
  return WK.f1;
}

/** Per-cell random for the most recent worleyT hit. */
export const cellRand = (salt) => hash2(WK.cx, WK.cy, salt);

/* ---------------- domain warping ---------------- */
export const WP = { x: 0, y: 0 };
/**
 * Periodic domain warp. Because the offset field shares the coordinate period,
 * the warped field is still exactly tileable. Domain warping is the single
 * cheapest way to stop procedural noise from reading as "computer noise" —
 * it turns isotropic blobs into flowing, geologically plausible structure.
 */
export function warpT(x, y, px, py, seed, amp, oct = 3) {
  WP.x = x + amp * (fbmT(x, y, px, py, oct, 0.5, seed) - 0.5);
  WP.y = y + amp * (fbmT(x, y, px, py, oct, 0.5, seed + 3779) - 0.5);
}

/* ---------------- directional / structural primitives ---------------- */
/**
 * Anisotropic streak field: fine across `dir`, stretched along it. Used for
 * damp runoff on stone, wood grain fiber, brushed metal, cloth thread twist.
 */
export function streakT(u, v, fAcross, fAlong, seed, oct = 4) {
  return fbmT(u * fAcross, v * fAlong, fAcross, fAlong, oct, 0.55, seed);
}

/** Thin line network from ridged fbm — cracks, veins, root fibres. */
export function veinT(u, v, f, seed, sharp = 22, oct = 4) {
  const r = fbmT(u * f, v * f, f, f, oct, 0.55, seed, FBM_RIDGED);
  return clamp01(Math.pow(r, sharp * 0.25));
}

/** Sparse point mask (embers, flecks, nail heads) at a jittered lattice. */
export function pointsT(u, v, f, seed, density, radius) {
  const x = u * f, y = v * f;
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 1e9;
  for (let j = -1; j <= 1; j++) {
    const cy = yi + j, wy = wrapi(cy, f);
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, wx = wrapi(cx, f);
      if (hash2(wx, wy, seed + 401) > density) continue;
      const dx = cx + 0.15 + hash2(wx, wy, seed) * 0.7 - x;
      const dy = cy + 0.15 + hash2(wx, wy, seed + 977) * 0.7 - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
  }
  return smoothstep(radius, radius * 0.25, best);
}
