/**
 * SANCTUM — procedural decal atlas.
 *
 * Every decal in the game reads from exactly two textures, so the whole system
 * costs 2 of the 16 fragment texture units no matter how many decal types exist:
 *
 *   map     RGB = albedo (sRGB)              A = coverage
 *   packed  RG  = tangent-space normal xy    B = relative roughness (0.5 = neutral)
 *                                           A = per-type detail mask
 *                                               (blood: wetness, scorch: ember,
 *                                                rime: facet rim, crack: depth,
 *                                                rune: glyph emissive)
 *
 * `packed` is bound as the material's `normalMap` with `USE_PACKED_NORMALMAP`
 * defined, so three reconstructs normal.z from xy and leaves B/A for us. That is
 * the trick that keeps the unit count at two while still giving decals real
 * normal relief, drying roughness and an emissive channel.
 *
 * Determinism: every pixel comes from Rand.js noise seeded per tile. No
 * Math.random, no Date.now, no image decoding.
 */
import * as THREE from 'three';
import { makeRand, hash2, perlin2, fbm2, worley2 } from '../../core/Rand.js';

/** Atlas is a 4x4 grid. Order defines the UV rect for every decal type. */
export const TILES = [
  'blood_a', 'blood_b', 'blood_spray', 'blood_pool',
  'scorch', 'scorch_burst', 'rime', 'crack',
  'crack_web', 'foot_boot', 'foot_claw', 'dust',
  'rune_a', 'rune_b', 'rune_c', 'drips',
];
export const GRID = 4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ Tile */
/**
 * One decal tile as separate float planes. Compositing is proper "over" on
 * coverage so overlapping droplets accumulate instead of stomping each other.
 */
class Tile {
  constructor(s, seed) {
    this.s = s;
    this.n = s * s;
    this.cr = new Float32Array(this.n);
    this.cg = new Float32Array(this.n);
    this.cb = new Float32Array(this.n);
    this.cov = new Float32Array(this.n);
    this.h = new Float32Array(this.n);
    this.rg = new Float32Array(this.n).fill(0.5);
    this.mk = new Float32Array(this.n);
    this.rand = makeRand(seed);
    this.seed = seed >>> 0;
  }

  /**
   * Composite one sample OVER the accumulated tile.
   *   Cr*Ar = Cs*As + Cd*Ad*(1 - As)   =>   weight on the new colour is As/Ar.
   * (Using As*(1-Ad)/Ar here instead is the "under" operator, and it makes an
   * opaque top layer — a charred core over an ash halo — come out washed out.)
   */
  put(i, a, r, g, b, rough, mask, h) {
    if (a <= 0.0005) return;
    if (a > 1) a = 1;
    const c = this.cov[i];
    const na = c + a * (1 - c);
    if (na <= 1e-6) return;
    const w = a / na;
    this.cr[i] += (r - this.cr[i]) * w;
    this.cg[i] += (g - this.cg[i]) * w;
    this.cb[i] += (b - this.cb[i]) * w;
    this.rg[i] += (rough - this.rg[i]) * w;
    this.mk[i] += (mask - this.mk[i]) * w;
    this.h[i] += h * a;
    this.cov[i] = na;
  }

  /** Soft, noisy round stamp. cb(i, a, nx, ny) lets callers vary per pixel. */
  blob(cx, cy, r, wob, seed, cb) {
    const s = this.s;
    const rr = r * (1 + wob) + 2;
    const x0 = Math.max(0, Math.floor(cx - rr)), x1 = Math.min(s - 1, Math.ceil(cx + rr));
    const y0 = Math.max(0, Math.floor(cy - rr)), y1 = Math.min(s - 1, Math.ceil(cy + rr));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d = Math.hypot(dx, dy);
        if (d > rr) continue;
        let edge = r;
        if (wob > 0) {
          const ux = dx / (d || 1), uy = dy / (d || 1);
          const n1 = perlin2(ux * 2.1 + 4.3, uy * 2.1 - 1.7, seed) - 0.5;
          const n2 = perlin2(ux * 5.3 - 2.1, uy * 5.3 + 3.9, seed + 91) - 0.5;
          edge = r * (1 + wob * (n1 * 1.5 + n2 * 0.7));
        }
        const a = sstep(edge + 1.1, edge - 1.1, d);
        if (a <= 0.002) continue;
        cb(y * s + x, a, dx / (edge || 1), dy / (edge || 1), d / (edge || 1));
      }
    }
  }

  /** Tapered round-capped capsule; cb(i, a, t) with t = 0..1 along the axis. */
  capsule(x0, y0, x1, y1, r0, r1, cb) {
    const s = this.s;
    const rm = Math.max(r0, r1) + 2;
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - rm));
    const bx1 = Math.min(s - 1, Math.ceil(Math.max(x0, x1) + rm));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - rm));
    const by1 = Math.min(s - 1, Math.ceil(Math.max(y0, y1) + rm));
    const ax = x1 - x0, ay = y1 - y0;
    const len2 = ax * ax + ay * ay || 1e-6;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5 - x0, py = y + 0.5 - y0;
        let t = (px * ax + py * ay) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - ax * t, qy = py - ay * t;
        const d = Math.hypot(qx, qy);
        const r = r0 + (r1 - r0) * t;
        const a = sstep(r + 0.85, r - 0.85, d);
        if (a <= 0.002) continue;
        cb(y * s + x, a, t, d / (r || 1));
      }
    }
  }

  /**
   * Annulus (ring) with soft edges; optional angular window.
   *
   * `wob` warps the annulus per-angle — `{ amp, wamp, freq, seed }` displaces the
   * radius by `amp * r` and the width by `wamp * w`. A ring drawn without it is
   * a geometrically perfect circle of constant thickness, which is exactly what
   * makes a sigil read as vector line art rather than as something carved.
   */
  ring(cx, cy, r, w, cb, a0 = 0, a1 = TAU, wob = null) {
    const s = this.s;
    const rr = r + w + 2 + (wob ? r * (wob.amp ?? 0) * 2 : 0);
    const x0 = Math.max(0, Math.floor(cx - rr)), x1 = Math.min(s - 1, Math.ceil(cx + rr));
    const y0 = Math.max(0, Math.floor(cy - rr)), y1 = Math.min(s - 1, Math.ceil(cy + rr));
    const full = a1 - a0 >= TAU - 1e-4;
    const wf = wob ? (wob.freq ?? 3.2) : 0;
    const wsd = wob ? (wob.seed ?? 0) : 0;
    const wamp = wob ? (wob.amp ?? 0.01) : 0;
    const wwam = wob ? (wob.wamp ?? 0.4) : 0;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d = Math.hypot(dx, dy);
        let rE = r, wE = w;
        if (wob) {
          const inv = 1 / (d || 1);
          const ux = dx * inv, uy = dy * inv;
          const n1 = perlin2(ux * wf + 11.3, uy * wf - 4.1, wsd) - 0.5;
          const n2 = perlin2(ux * wf * 2.7 - 6.9, uy * wf * 2.7 + 2.3, wsd + 57) - 0.5;
          rE = r * (1 + wamp * (n1 * 2 + n2 * 0.8));
          wE = Math.max(0.9, w * (1 + wwam * n2 * 2.2));
        }
        const band = Math.abs(d - rE);
        let a = sstep(wE * 0.5 + 0.75, wE * 0.5 - 0.75, band);
        if (a <= 0.002) continue;
        if (!full) {
          let ang = Math.atan2(dy, dx);
          if (ang < 0) ang += TAU;
          let lo = a0, hi = a1;
          if (hi < lo) hi += TAU;
          let t = ang;
          if (t < lo) t += TAU;
          if (t > hi) continue;
          const soft = Math.min(0.12, (hi - lo) * 0.2);
          a *= sstep(lo, lo + soft, t) * sstep(hi, hi - soft, t);
          if (a <= 0.002) continue;
        }
        cb(y * s + x, a, d / (r || 1), clamp01(band / Math.max(0.5, wE * 0.5)));
      }
    }
  }

  /**
   * Bleed the emissive mask outward and lay a matching pool of dark coverage
   * under it.
   *
   * This is the difference between "a glowing line" and "a channel of light cut
   * into stone". A 1-bit stroke has no penumbra, so the eye reads it as ink; a
   * blurred halo around the stroke — plus a faint darkened pool that only exists
   * where the halo does — reads as light spilling out of a groove and pooling on
   * the flagstones. Separable box blur, run twice, which is a good enough
   * Gaussian at this tile size and costs nothing at build time.
   */
  glowBleed(radius, gain, covAdd, col) {
    const s = this.s, n = this.n;
    const rad = Math.max(1, Math.round(radius));
    let src = this.mk;
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      // horizontal
      for (let y = 0; y < s; y++) {
        const row = y * s;
        for (let x = 0; x < s; x++) {
          let sum = 0, cnt = 0;
          for (let k = -rad; k <= rad; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= s) continue;
            sum += src[row + xx]; cnt++;
          }
          a[row + x] = sum / (cnt || 1);
        }
      }
      // vertical
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          let sum = 0, cnt = 0;
          for (let k = -rad; k <= rad; k++) {
            const yy = y + k;
            if (yy < 0 || yy >= s) continue;
            sum += a[yy * s + x]; cnt++;
          }
          b[y * s + x] = sum / (cnt || 1);
        }
      }
      src = b;
    }
    // Normalise: a box blur of a thin stroke loses almost all of its amplitude.
    let mx = 0;
    for (let i = 0; i < n; i++) if (b[i] > mx) mx = b[i];
    const inv = mx > 1e-5 ? 1 / mx : 0;
    for (let i = 0; i < n; i++) {
      const h = b[i] * inv;
      if (h <= 0.004) continue;
      const halo = h * h;                        // tight falloff, no milky wash
      const cov = this.cov[i];
      if (cov < 0.995) {
        const ca = clamp01(covAdd * halo) * (1 - cov);
        const na = cov + ca;
        if (na > 1e-6) {
          const w = ca / na;
          this.cr[i] += (col[0] - this.cr[i]) * w;
          this.cg[i] += (col[1] - this.cg[i]) * w;
          this.cb[i] += (col[2] - this.cb[i]) * w;
          this.rg[i] += (0.62 - this.rg[i]) * w;
          this.cov[i] = na;
        }
      }
      // Only outside the stroke: inside it the engraved cross-section already
      // owns the mask, and letting the halo fill the groove core back in would
      // undo the dark-centre / bright-lip read the whole thing depends on.
      const g = clamp01(gain * halo) * (1 - clamp01(cov) * 0.92);
      if (g > this.mk[i]) this.mk[i] = g;
    }
  }

  /** Coverage-only border fade so tiles never bleed and patches never hard-edge. */
  fadeBorder(frac = 0.055) {
    const s = this.s, m = s * frac;
    for (let y = 0; y < s; y++) {
      const fy = Math.min(sstep(0, m, y + 0.5), sstep(s, s - m, y + 0.5));
      for (let x = 0; x < s; x++) {
        const fx = Math.min(sstep(0, m, x + 0.5), sstep(s, s - m, x + 0.5));
        this.cov[y * s + x] *= fx * fy;
      }
    }
  }
}

/* ------------------------------------------------------------ generators */

/**
 * Authored in sRGB (these are the numbers you would dial in a colour picker) —
 * the atlas is tagged SRGBColorSpace so three decodes to linear. Blood that is
 * physically correct comes out nearly black in linear at this exposure, so the
 * value is lifted just far enough to read as dark ARTERIAL RED rather than as a
 * black smear, while staying inside the desaturated-cold-base art direction.
 */
const BLOOD_WET = [0.455, 0.078, 0.060];
const BLOOD_DEEP = [0.345, 0.052, 0.042];
const BLOOD_RIM = [0.210, 0.050, 0.046];

/** Irregular blood body: wet glossy interior, coagulated darker rim, mottling. */
function bloodBody(t, cx, cy, r, seed, gloss = 1) {
  t.blob(cx, cy, r, 0.30, seed, (i, a, nx, ny, nr) => {
    const deep = clamp01(1 - nr);
    const inner = deep * deep;
    const mot = fbm2((i % t.s) * 0.055, ((i / t.s) | 0) * 0.055, { octaves: 4, seed: seed + 17 });
    const rim = 1 - sstep(0, 0.42, deep);
    let cr = BLOOD_RIM[0] + (BLOOD_WET[0] - BLOOD_RIM[0]) * inner;
    let cg = BLOOD_RIM[1] + (BLOOD_WET[1] - BLOOD_RIM[1]) * inner;
    let cb = BLOOD_RIM[2] + (BLOOD_WET[2] - BLOOD_RIM[2]) * inner;
    const dk = 0.78 + mot * 0.42;
    cr *= dk; cg *= dk; cb *= dk;
    const rough = 0.5 - gloss * 0.22 * inner + rim * 0.26 + (mot - 0.5) * 0.10;
    const h = inner * 0.42 + rim * rim * 0.30 + (mot - 0.5) * 0.12;
    t.put(i, a, cr, cg, cb, clamp01(rough), inner * gloss, h);
  });
}

/** One directional cast-off streak ending in a droplet. */
function bloodStreak(t, x0, y0, ang, len, w, seed) {
  const x1 = x0 + Math.cos(ang) * len;
  const y1 = y0 + Math.sin(ang) * len;
  t.capsule(x0, y0, x1, y1, w, w * 0.28, (i, a, tt, dn) => {
    const wet = clamp01(1 - dn) * (1 - tt * 0.5);
    const cr = BLOOD_DEEP[0] * (0.8 + wet * 0.55);
    const cg = BLOOD_DEEP[1] * (0.8 + wet * 0.55);
    const cb = BLOOD_DEEP[2] * (0.8 + wet * 0.55);
    t.put(i, a * (1 - tt * 0.35), cr, cg, cb, 0.36 + tt * 0.24, wet * 0.8, 0.18 * wet);
  });
  const dr = w * 1.45;
  t.blob(x1, y1, dr, 0.30, seed, (i, a, nx, ny, nr) => {
    const inner = clamp01(1 - nr) ** 2;
    t.put(i, a, BLOOD_WET[0] * (0.72 + inner * 0.4), BLOOD_WET[1] * (0.72 + inner * 0.4),
      BLOOD_WET[2] * (0.72 + inner * 0.4), 0.5 - inner * 0.2, inner, inner * 0.4);
  });
}

/** Satellite droplet with a short impact tail. */
function bloodDroplet(t, cx, cy, r, ang, stretch, seed) {
  const tx = cx + Math.cos(ang) * r * stretch;
  const ty = cy + Math.sin(ang) * r * stretch;
  t.capsule(cx, cy, tx, ty, r, r * 0.22, (i, a, tt, dn) => {
    const inner = clamp01(1 - dn) ** 2;
    const k = 0.7 + inner * 0.5;
    t.put(i, a * (1 - tt * 0.25), BLOOD_WET[0] * k, BLOOD_WET[1] * k, BLOOD_WET[2] * k,
      0.46 - inner * 0.16, inner, inner * 0.35);
  });
}

function genBlood(t, { dirBias = 1, cores = 2, streaks = 14, sats = 54, cx = 0.4, spread = 0.55 }) {
  const s = t.s, r = t.rand;
  const CX = cx * s, CY = 0.5 * s;
  const R = s * 0.20;
  bloodBody(t, CX, CY, R, t.seed);
  for (let k = 1; k < cores; k++) {
    const a = r.range(-Math.PI, Math.PI);
    const d = r.range(0.55, 1.35) * R;
    bloodBody(t, CX + Math.cos(a) * d, CY + Math.sin(a) * d * 0.8, R * r.range(0.42, 0.74), t.seed + k * 37);
  }
  for (let k = 0; k < streaks; k++) {
    const ang = r.gauss(0, spread) * dirBias;
    const len = s * r.range(0.06, 0.32) * (1 - Math.abs(ang) * 0.35);
    const w = s * r.range(0.008, 0.024);
    const ox = CX + Math.cos(ang) * R * 0.8, oy = CY + Math.sin(ang) * R * 0.8;
    bloodStreak(t, ox, oy, ang, len, w, t.seed + 500 + k * 13);
  }
  for (let k = 0; k < sats; k++) {
    const u = r();
    const d = s * (0.14 + u * u * 0.36);
    const ang = r.gauss(0, spread * 0.75) * dirBias;
    const px = CX + Math.cos(ang) * d;
    const py = CY + Math.sin(ang) * d + r.gauss(0, s * 0.020);
    if (px < 4 || px > s - 4 || py < 4 || py > s - 4) continue;
    const rad = s * (0.005 + 0.018 * (1 - u) * r.range(0.4, 1.2));
    bloodDroplet(t, px, py, rad, ang, r.range(1.4, 3.4), t.seed + 900 + k * 7);
  }
}

function genBloodSpray(t) {
  const s = t.s, r = t.rand;
  const CX = 0.16 * s, CY = 0.5 * s;
  for (let k = 0; k < 260; k++) {
    const u = r();
    const d = s * (0.02 + u * 0.78);
    const ang = r.gauss(0, 0.40);
    const px = CX + Math.cos(ang) * d;
    const py = CY + Math.sin(ang) * d + r.gauss(0, s * 0.012 + d * 0.10);
    if (px < 3 || px > s - 3 || py < 3 || py > s - 3) continue;
    const rad = s * (0.0022 + 0.010 * (1 - u) * r.range(0.3, 1.3));
    bloodDroplet(t, px, py, rad, ang, r.range(1.2, 4.2), t.seed + k * 11);
  }
  for (let k = 0; k < 9; k++) {
    const ang = r.gauss(0, 0.32);
    bloodStreak(t, CX, CY + r.gauss(0, s * 0.02), ang, s * r.range(0.20, 0.60),
      s * r.range(0.004, 0.011), t.seed + 300 + k);
  }
}

function genBloodPool(t) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  bloodBody(t, CX, CY, s * 0.335, t.seed, 1.25);
  for (let k = 0; k < 4; k++) {
    const a = r.range(0, TAU), d = r.range(0.18, 0.34) * s;
    bloodBody(t, CX + Math.cos(a) * d, CY + Math.sin(a) * d, s * r.range(0.10, 0.20), t.seed + k * 53, 1.25);
  }
  // meniscus: a slightly raised, matte coagulated ring just inside the edge
  t.ring(CX, CY, s * 0.322, s * 0.030, (i, a, nr) => {
    t.put(i, a * 0.75, BLOOD_RIM[0] * 0.85, BLOOD_RIM[1] * 0.9, BLOOD_RIM[2] * 0.95, 0.74, 0.15, 0.30);
  });
  // dark clotted islands + trailing runnels
  for (let k = 0; k < 7; k++) {
    const a = r.range(0, TAU), d = r.range(0, 0.24) * s;
    t.blob(CX + Math.cos(a) * d, CY + Math.sin(a) * d, s * r.range(0.012, 0.045), 0.5, t.seed + 700 + k,
      (i, aa, nx, ny, nr) => {
        const inner = clamp01(1 - nr);
        t.put(i, aa * 0.9, BLOOD_RIM[0] * 0.62, BLOOD_RIM[1] * 0.62, BLOOD_RIM[2] * 0.62,
          0.72 - inner * 0.1, 0.1, 0.22 * inner);
      });
  }
  for (let k = 0; k < 10; k++) {
    const ang = r.range(0, TAU);
    bloodStreak(t, CX + Math.cos(ang) * s * 0.30, CY + Math.sin(ang) * s * 0.30, ang,
      s * r.range(0.03, 0.13), s * r.range(0.006, 0.014), t.seed + 1200 + k);
  }
}

function genDrips(t) {
  const s = t.s, r = t.rand;
  for (let k = 0; k < 22; k++) {
    const y = s * r.range(0.08, 0.92);
    const x = s * r.range(0.04, 0.4);
    const ang = r.gauss(0, 0.22);
    bloodStreak(t, x, y, ang, s * r.range(0.12, 0.55), s * r.range(0.005, 0.020), t.seed + k * 19);
  }
  for (let k = 0; k < 60; k++) {
    const px = s * r(), py = s * r();
    bloodDroplet(t, px, py, s * r.range(0.003, 0.013), r.gauss(0, 0.3), r.range(1.2, 3.0), t.seed + 400 + k);
  }
}

const CHAR = [0.052, 0.045, 0.040];
const ASH = [0.325, 0.300, 0.262];

function genScorch(t, burst = false) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  const R = s * (burst ? 0.30 : 0.335);

  // outer ash / soot halo
  t.blob(CX, CY, R * 1.16, 0.22, t.seed + 3, (i, a, nx, ny, nr) => {
    const mot = fbm2((i % s) * 0.07, ((i / s) | 0) * 0.07, { octaves: 4, seed: t.seed + 5 });
    const k = 0.55 + mot * 0.7;
    t.put(i, a * 0.62 * (0.5 + mot * 0.8), ASH[0] * k, ASH[1] * k, ASH[2] * k,
      0.80 + (mot - 0.5) * 0.12, 0, (mot - 0.5) * 0.10);
  });
  /* Charred core with a cracked crust; the crust cracks carry the ember mask.
   *
   * THE DEFECT THIS REPLACES: `crack = sstep( 0.26, 0.02, w.edge )` is a hard
   * two-stop ramp on a worley edge, so every cell wall in the network wrote an
   * ember mask of ~1.0 at a geometrically clean, uniform width. Multiplied by the
   * type's 2.3 emissive gain that resolved as a blown WHITE HEX MESH lying on the
   * moor — the single most gizmo-like thing in the night frame. Cooling char does
   * not glow evenly: a burn has a hot heart and cold edges, and the crust seals
   * over in patches.
   *
   * So the ember is now three coupled fields: a soft crack ramp with a narrow
   * hotter core inside it, a large-scale HEAT field that leaves most of the
   * network dark, and grain that stops any wall being uniform along its length.
   */
  t.blob(CX, CY, R * 0.74, 0.26, t.seed + 11, (i, a, nx, ny, nr) => {
    const x = i % s, y = (i / s) | 0;
    const inner = clamp01(1 - nr);
    const sc = 14 / s;
    const w = worley2(x * sc, y * sc, t.seed + 29);
    // wide soft shoulder + narrow core, so a wall has a cross-section
    const crack = sstep(0.34, 0.06, w.edge) * 0.42 + sstep(0.13, 0.01, w.edge) * 0.58;
    const mot = fbm2(x * 0.10, y * 0.10, { octaves: 4, seed: t.seed + 41 });
    // heat: slow and contrasty. Most of the crust has already gone cold.
    const heat = sstep(0.40, 0.78, fbm2(x * 0.020, y * 0.020, { octaves: 3, seed: t.seed + 67 }));
    const grain = 0.30 + 0.95 * fbm2(x * 0.30, y * 0.30, { octaves: 2, seed: t.seed + 89 });
    const ember = clamp01(crack * clamp01(inner * 1.8) * heat * grain);
    const k = 0.6 + mot * 0.85;
    let cr = CHAR[0] * k, cg = CHAR[1] * k, cb = CHAR[2] * k;
    // glassy fused rims inside the cracks
    cr += ember * 0.10; cg += ember * 0.030; cb += ember * 0.008;
    t.put(i, a * (0.72 + inner * 0.28), cr, cg, cb,
      clamp01(0.86 - ember * 0.42 + (mot - 0.5) * 0.10), ember, -0.22 * inner + crack * 0.18);
  });
  if (burst) {
    for (let k = 0; k < 26; k++) {
      const ang = r.range(0, TAU);
      const len = s * r.range(0.10, 0.42);
      const w = s * r.range(0.008, 0.028);
      t.capsule(CX + Math.cos(ang) * R * 0.5, CY + Math.sin(ang) * R * 0.5,
        CX + Math.cos(ang) * (R * 0.5 + len), CY + Math.sin(ang) * (R * 0.5 + len), w, w * 0.15,
        (i, a, tt, dn) => {
          const inner = clamp01(1 - dn);
          const em = inner * (1 - tt) * 0.22;
          t.put(i, a * (1 - tt * 0.5), CHAR[0] + em * 0.10, CHAR[1] + em * 0.03, CHAR[2],
            0.84 - em * 0.3, em, -0.10 * inner);
        });
    }
  }
  // soot speckle beyond the halo
  for (let k = 0; k < 170; k++) {
    const ang = r.range(0, TAU), d = R * r.range(1.0, 1.45);
    const px = CX + Math.cos(ang) * d, py = CY + Math.sin(ang) * d;
    if (px < 3 || px > s - 3 || py < 3 || py > s - 3) continue;
    t.blob(px, py, s * r.range(0.003, 0.013), 0.4, t.seed + 800 + k, (i, a) => {
      t.put(i, a * 0.55, CHAR[0] * 1.5, CHAR[1] * 1.5, CHAR[2] * 1.5, 0.9, 0, 0);
    });
  }
}

function genRime(t) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  const R = s * 0.34;
  const ICE = [0.360, 0.470, 0.560];
  const BRIGHT = [0.690, 0.800, 0.880];
  t.blob(CX, CY, R, 0.24, t.seed + 7, (i, a, nx, ny, nr) => {
    const x = i % s, y = (i / s) | 0;
    const inner = clamp01(1 - nr);
    const s1 = 19 / s, s2 = 48 / s;
    const w = worley2(x * s1, y * s1, t.seed + 61);
    const facet = clamp01(1 - w.edge * 5.2);
    const w2 = worley2(x * s2, y * s2, t.seed + 83);
    const fine = clamp01(1 - w2.edge * 8.0);
    const rim = 1 - sstep(0, 0.30, inner);
    const edgeGlow = clamp01(facet * 0.8 + fine * 0.55 + rim * 1.1);
    const k = 0.62 + facet * 0.30 + fine * 0.22;
    const cr = ICE[0] * k + BRIGHT[0] * edgeGlow * 0.30;
    const cg = ICE[1] * k + BRIGHT[1] * edgeGlow * 0.30;
    const cb = ICE[2] * k + BRIGHT[2] * edgeGlow * 0.32;
    t.put(i, a * (0.42 + inner * 0.58) * (0.55 + facet * 0.7),
      cr, cg, cb, clamp01(0.44 - edgeGlow * 0.30), clamp01(edgeGlow), facet * 0.35 + fine * 0.18);
  });
  // radial needle crystals
  for (let k = 0; k < 40; k++) {
    const ang = r.range(0, TAU);
    const l = R * r.range(0.45, 1.12);
    const w = s * r.range(0.004, 0.013);
    t.capsule(CX + Math.cos(ang) * R * 0.10, CY + Math.sin(ang) * R * 0.10,
      CX + Math.cos(ang) * l, CY + Math.sin(ang) * l, w, w * 0.12, (i, a, tt, dn) => {
        const inner = clamp01(1 - dn);
        t.put(i, a * (1 - tt * 0.45), BRIGHT[0] * (0.7 + inner * 0.4), BRIGHT[1] * (0.7 + inner * 0.4),
          BRIGHT[2] * (0.7 + inner * 0.4), 0.20, clamp01(0.55 + inner * 0.5), inner * 0.5);
      });
    // barbs, so needles read as crystal not as hair
    for (let b = 1; b <= 3; b++) {
      const tt = b / 4;
      const bx = CX + Math.cos(ang) * (R * 0.1 + (l - R * 0.1) * tt);
      const by = CY + Math.sin(ang) * (R * 0.1 + (l - R * 0.1) * tt);
      for (const sg of [-1, 1]) {
        const ba = ang + sg * 1.05;
        const bl = w * r.range(2.5, 6.0);
        t.capsule(bx, by, bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl, w * 0.7, w * 0.1,
          (i, a, ttt, dn) => {
            const inner = clamp01(1 - dn);
            t.put(i, a * 0.8, BRIGHT[0], BRIGHT[1], BRIGHT[2], 0.22, clamp01(0.5 + inner * 0.5), inner * 0.4);
          });
      }
    }
  }
}

/** Deterministic branching crack walk. */
function crackWalk(t, x0, y0, ang, len, w, seed, depth, col, cb) {
  const r = makeRand(seed);
  let x = x0, y = y0, a = ang;
  const steps = Math.max(3, Math.round(len / (t.s * 0.055)));
  const seg = len / steps;
  for (let i = 0; i < steps; i++) {
    // low angular jitter: fracture propagates in straight runs with sharp kinks,
    // not in the organic wander a high-variance walk produces
    a = ang + r.gauss(0, 0.20);
    const nx = x + Math.cos(a) * seg, ny = y + Math.sin(a) * seg;
    const tt = i / steps;
    const w0 = w * (1 - tt * 0.72), w1 = w * (1 - (tt + 1 / steps) * 0.72);
    t.capsule(x, y, nx, ny, Math.max(0.7, w0), Math.max(0.5, w1), cb);
    if (depth > 0 && i > 0 && r.chance(0.32)) {
      crackWalk(t, nx, ny, a + r.sign() * r.range(0.45, 0.95), len * r.range(0.26, 0.52),
        w * 0.62, (seed * 2654435761 + i * 7919) >>> 0, depth - 1, col, cb);
    }
    x = nx; y = ny;
    if (x < 2 || x > t.s - 2 || y < 2 || y > t.s - 2) break;
  }
}

function genCrack(t, web = false) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  const DUST = [0.312, 0.292, 0.258];
  const DEBRIS = [0.400, 0.378, 0.336];
  const DARK = [0.038, 0.034, 0.030];

  // dust halo over the whole tile
  t.blob(CX, CY, s * (web ? 0.44 : 0.40), 0.20, t.seed + 13, (i, a, nx, ny, nr) => {
    const mot = fbm2((i % s) * 0.06, ((i / s) | 0) * 0.06, { octaves: 4, seed: t.seed + 23 });
    const k = 0.7 + mot * 0.6;
    t.put(i, a * (web ? 0.22 : 0.34) * (0.4 + mot * 0.9), DUST[0] * k, DUST[1] * k, DUST[2] * k,
      0.86, 0, (mot - 0.5) * 0.08);
  });

  if (!web) {
    // crater: displaced rim of raised debris + a scooped floor
    t.blob(CX, CY, s * 0.185, 0.28, t.seed + 31, (i, a, nx, ny, nr) => {
      const x = i % s, y = (i / s) | 0;
      const inner = clamp01(1 - nr);
      const mot = fbm2(x * 0.12, y * 0.12, { octaves: 4, seed: t.seed + 47 });
      const k = 0.55 + mot * 0.55;
      t.put(i, a * 0.92, DUST[0] * k * 0.75, DUST[1] * k * 0.75, DUST[2] * k * 0.72,
        0.88, clamp01(inner * 0.6), -0.62 * inner * inner - (mot - 0.5) * 0.12);
    });
    t.ring(CX, CY, s * 0.196, s * 0.052, (i, a, nr) => {
      const x = i % s, y = (i / s) | 0;
      const mot = fbm2(x * 0.16, y * 0.16, { octaves: 3, seed: t.seed + 59 });
      const k = 0.75 + mot * 0.6;
      t.put(i, a * (0.55 + mot * 0.6), DEBRIS[0] * k, DEBRIS[1] * k, DEBRIS[2] * k, 0.84, 0, 0.55 * (0.4 + mot));
    });
    for (let k = 0; k < 34; k++) {
      const ang = r.range(0, TAU), d = s * r.range(0.17, 0.34);
      t.blob(CX + Math.cos(ang) * d, CY + Math.sin(ang) * d, s * r.range(0.006, 0.024), 0.55,
        t.seed + 600 + k, (i, a, nx, ny, nr) => {
          const inner = clamp01(1 - nr);
          t.put(i, a * 0.95, DEBRIS[0] * 1.05, DEBRIS[1], DEBRIS[2] * 0.95, 0.80, 0, 0.7 * inner);
        });
    }
  }

  const paint = (i, a, tt, dn) => {
    const inner = clamp01(1 - dn);
    const k = 0.6 + (1 - inner) * 0.9;
    t.put(i, a, DARK[0] * k, DARK[1] * k, DARK[2] * k, 0.92, clamp01(inner), -1.0 * inner - 0.25);
  };
  const nMain = web ? 14 : 11;
  for (let k = 0; k < nMain; k++) {
    const ang = (k / nMain) * TAU + r.gauss(0, 0.16);
    const start = web ? 0 : s * 0.17;
    crackWalk(t, CX + Math.cos(ang) * start, CY + Math.sin(ang) * start, ang,
      s * r.range(web ? 0.24 : 0.19, web ? 0.46 : 0.32), s * (web ? 0.0115 : 0.019),
      (t.seed + k * 7919) >>> 0, 2, DARK, paint);
  }
  {
    // concentric shear arcs tie the radial cracks together — this is what makes
    // impact fracture read as fracture and not as scratches
    const rings = web ? 4 : 3;
    for (let k = 0; k < rings; k++) {
      const rr = s * ((web ? 0.10 : 0.21) + k * (web ? 0.095 : 0.055));
      const n = 10 + k * 4;
      for (let j = 0; j < n; j++) {
        if (r.chance(0.28)) continue;
        const a0 = (j / n) * TAU + r.gauss(0, 0.09);
        const a1 = a0 + (TAU / n) * r.range(0.6, 1.0);
        const steps = 4;
        let px = CX + Math.cos(a0) * rr, py = CY + Math.sin(a0) * rr;
        for (let m = 1; m <= steps; m++) {
          const aa = a0 + (a1 - a0) * (m / steps);
          const rj = rr * (1 + r.gauss(0, 0.035));
          const qx = CX + Math.cos(aa) * rj, qy = CY + Math.sin(aa) * rj;
          t.capsule(px, py, qx, qy, s * (web ? 0.010 : 0.013), s * (web ? 0.008 : 0.010), paint);
          px = qx; py = qy;
        }
      }
    }
  }
}

/**
 * Sole silhouette: a width profile swept along the +x axis. This is what makes a
 * footprint read as a boot rather than as two dark blobs — heel, narrow shank,
 * wide ball, rounded toe, all one connected shape with a soft pressed edge.
 */
function sweptSole(t, x0, x1, cy, profile, wob, seed, cb) {
  const s = t.s;
  const wmax = Math.max(...profile) + 2;
  const bx0 = Math.max(0, Math.floor(x0 - wmax)), bx1 = Math.min(s - 1, Math.ceil(x1 + wmax));
  const by0 = Math.max(0, Math.floor(cy - wmax)), by1 = Math.min(s - 1, Math.ceil(cy + wmax));
  const n = profile.length - 1;
  const len = x1 - x0;
  for (let y = by0; y <= by1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = bx0; x <= bx1; x++) {
      const u = (x + 0.5 - x0) / len;
      // rounded caps: sample the profile clamped, then treat the overshoot as
      // radial distance from the end so the toe and heel arc properly
      const cu = u < 0 ? 0 : u > 1 ? 1 : u;
      const f = cu * n;
      const i0 = Math.min(n, Math.max(0, Math.floor(f)));
      const i1 = Math.min(n, i0 + 1);
      const fr = f - i0;
      let w = profile[i0] + (profile[i1] - profile[i0]) * fr;
      if (wob > 0) {
        const nz = perlin2(u * 5.5 + 3.1, dy * 0.06 + 7.7, seed) - 0.5;
        w *= 1 + wob * nz * 2;
      }
      let dist;
      if (u < 0) dist = Math.hypot((x + 0.5) - x0, dy);
      else if (u > 1) dist = Math.hypot((x + 0.5) - x1, dy);
      else dist = Math.abs(dy);
      // wide soft shoulder: a print in dust/mud has no hard silhouette
      const a = sstep(w + 2.6, w - 1.4, dist);
      if (a <= 0.002) continue;
      cb(y * s + x, a, cu, dist / (w || 1));
    }
  }
}

function genFootBoot(t) {
  const s = t.s;
  const MUD = [0.104, 0.090, 0.073];
  const press = (i, a, inner, deep) => {
    const x = i % s, y = (i / s) | 0;
    const mot = fbm2(x * 0.13, y * 0.13, { octaves: 3, seed: t.seed + 5 });
    const k = 0.66 + mot * 0.78;
    t.put(i, a, MUD[0] * k, MUD[1] * k, MUD[2] * k,
      0.70 + (mot - 0.5) * 0.18, clamp01(inner), -deep * inner);
  };
  // heel -> shank -> ball -> toe, long axis +x
  const P = [0.086, 0.112, 0.114, 0.098, 0.082, 0.092, 0.118, 0.132, 0.130, 0.112, 0.074, 0.040]
    .map((v) => v * s);
  sweptSole(t, s * 0.20, s * 0.84, s * 0.5, P, 0.05, t.seed + 1, (i, a, u, dn) => {
    // the rim of the impression is displaced up, the middle pressed down
    const inner = clamp01(1 - dn);
    // tread bars show as a value break, not only as relief
    press(i, a, inner, 0.80);
  });
  // raised sole border: mud squeezed up around the print
  sweptSole(t, s * 0.20, s * 0.84, s * 0.5, P.map((v) => v * 1.14), 0.06, t.seed + 1,
    (i, a, u, dn) => {
      if (dn < 0.82) return;
      t.h[i] += 0.5 * a;
      t.rg[i] += (0.66 - t.rg[i]) * a * 0.5;
    });
  // tread: lateral lugs across the ball, chevrons on the heel
  const lug = (i, a, dn) => {
    if (t.cov[i] < 0.12) return;
    const inner = clamp01(1 - dn);
    t.h[i] += 0.60 * inner * a;
    t.rg[i] += (0.60 - t.rg[i]) * a * 0.65;
    t.mk[i] += (0.85 - t.mk[i]) * a * 0.5;
    const w = a * inner * 0.55;
    t.cr[i] *= 1 + w * 0.85; t.cg[i] *= 1 + w * 0.85; t.cb[i] *= 1 + w * 0.80;
  };
  for (let k = 0; k < 8; k++) {
    const x = s * (0.512 + k * 0.038);
    const hw = s * (0.118 - Math.abs(k - 3.0) * 0.011);
    t.capsule(x, s * 0.5 - hw, x, s * 0.5 + hw, s * 0.0115, s * 0.0115,
      (i, a, tt, dn) => lug(i, a, dn));
  }
  for (let k = 0; k < 4; k++) {
    const x = s * (0.232 + k * 0.038);
    t.capsule(x - s * 0.013, s * 0.5 - s * 0.086, x + s * 0.013, s * 0.5, s * 0.011, s * 0.011,
      (i, a, tt, dn) => lug(i, a, dn));
    t.capsule(x - s * 0.013, s * 0.5 + s * 0.086, x + s * 0.013, s * 0.5, s * 0.011, s * 0.011,
      (i, a, tt, dn) => lug(i, a, dn));
  }
}

function genFootClaw(t) {
  const s = t.s, r = t.rand;
  const MUD = [0.094, 0.082, 0.067];
  const press = (i, a, inner, deep) => {
    const x = i % s, y = (i / s) | 0;
    const mot = fbm2(x * 0.15, y * 0.15, { octaves: 3, seed: t.seed + 9 });
    const k = 0.64 + mot * 0.78;
    t.put(i, a, MUD[0] * k, MUD[1] * k, MUD[2] * k,
      0.72 + (mot - 0.5) * 0.18, clamp01(inner), -deep * inner);
  };
  const CX = s * 0.34, CY = s * 0.5;
  // metacarpal pad: broad, slightly triangular, wider toward the toes
  const P = [0.070, 0.116, 0.150, 0.166, 0.160, 0.132, 0.090].map((v) => v * s);
  sweptSole(t, s * 0.17, s * 0.46, CY, P, 0.08, t.seed + 3, (i, a, u, dn) =>
    press(i, a, clamp01(1 - dn), 0.78));
  // three forward toes with claw gouges
  for (let k = -1; k <= 1; k++) {
    const ang = k * 0.58;
    const bx = CX + Math.cos(ang) * s * 0.20;
    const by = CY + Math.sin(ang) * s * 0.20;
    const TP = [0.038, 0.070, 0.078, 0.062, 0.034].map((v) => v * s);
    const ex = bx + Math.cos(ang) * s * 0.155, ey = by + Math.sin(ang) * s * 0.155;
    // toe pad as a short capsule chain so it reads as a digit
    t.capsule(bx, by, ex, ey, s * 0.072, s * 0.040, (i, a, tt, dn) =>
      press(i, a, clamp01(1 - dn) * (1 - tt * 0.15), 0.76));
    // claw: a sharp gouge past the toe
    const cx2 = ex + Math.cos(ang) * s * 0.115, cy2 = ey + Math.sin(ang) * s * 0.115;
    t.capsule(ex, ey, cx2, cy2, s * 0.030, s * 0.0045, (i, a, tt, dn) =>
      press(i, a, clamp01(1 - dn) * (1 - tt * 0.35), 1.05));
    void TP;
  }
  // rear spur
  const sx = s * 0.155, sy = CY + s * 0.055;
  t.capsule(sx, sy, sx - s * 0.075, sy + s * 0.030, s * 0.026, s * 0.005,
    (i, a, tt, dn) => press(i, a, clamp01(1 - dn) * (1 - tt * 0.3), 0.95));
  // squeezed rim
  sweptSole(t, s * 0.17, s * 0.46, CY, P.map((v) => v * 1.15), 0.09, t.seed + 3,
    (i, a, u, dn) => {
      if (dn < 0.84) return;
      t.h[i] += 0.46 * a;
    });
  void r;
}

function genDust(t) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  const D = [0.415, 0.392, 0.352];
  for (let k = 0; k < 26; k++) {
    const ang = r.range(0, TAU), d = s * r.range(0, 0.24);
    t.blob(CX + Math.cos(ang) * d, CY + Math.sin(ang) * d, s * r.range(0.10, 0.24), 0.34,
      t.seed + k * 29, (i, a, nx, ny, nr) => {
        const x = i % s, y = (i / s) | 0;
        const mot = fbm2(x * 0.05, y * 0.05, { octaves: 5, seed: t.seed + 3 });
        const inner = clamp01(1 - nr);
        const k2 = 0.7 + mot * 0.6;
        t.put(i, a * 0.16 * inner * (0.35 + mot), D[0] * k2, D[1] * k2, D[2] * k2, 0.92, 0, 0);
      });
  }
}

/* ---------------------------------------------------------------- runes */

const RUNE_STONE = [0.062, 0.056, 0.050];

/** Little angular glyph, drawn from deterministic strokes. */
function glyph(t, cx, cy, size, ang, seed, paint) {
  const r = makeRand(seed);
  const n = r.int(3, 5);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const px = (u, v) => [cx + (u * ca - v * sa) * size, cy + (u * sa + v * ca) * size];
  let lu = r.range(-0.5, 0.5), lv = r.range(-0.9, 0.9);
  for (let i = 0; i < n; i++) {
    const nu = r.range(-0.5, 0.5), nv = r.range(-0.9, 0.9);
    const [x0, y0] = px(lu, lv), [x1, y1] = px(nu, nv);
    t.capsule(x0, y0, x1, y1, Math.max(0.7, size * 0.16), Math.max(0.7, size * 0.16), paint);
    lu = nu; lv = nv;
  }
}

/**
 * Sigils and wards.
 *
 * THE DEFECT THIS REPLACES: every stroke used to write a flat mask value of
 * ~1.0 (`clamp01( 0.45 + inner * 0.75 )` saturates for the whole width of a
 * stroke), and the mask channel is what the stain shader turns into emission.
 * A constant-valued stroke of constant width on a geometrically perfect circle
 * is, by definition, 1-bit line art — it reads as a debug gizmo, it is the
 * brightest thing in the frame, and it fully occludes the flagstone it sits on.
 *
 * A sigil is CARVED, so it is built out of three coupled fields instead:
 *
 *   (a) an inner-glow ramp across the stroke's cross-section. The centre-line of
 *       the channel is dark (it is a shadowed groove) and the light lives at the
 *       lip, where it spills onto the stone. `glowBleed` then blurs that lip
 *       outward into a real penumbra and pools a little dark coverage under it.
 *   (b) an erosion field multiplied into BOTH coverage and mask, at three
 *       frequencies plus a worley chipping term, so no edge is geometrically
 *       clean and no run of the channel is uniformly lit.
 *   (c) a low-frequency charge field, so a third of the sigil is cold at any
 *       moment and the shader's scrolling flow has something to travel through.
 *
 * Peak mask is reached only where all three align, which is a handful of pixels
 * per tile rather than every pixel of every stroke.
 */
function genRune(t, variant) {
  const s = t.s, r = t.rand;
  const CX = 0.5 * s, CY = 0.5 * s;
  const R = s * 0.44;
  const wob = { amp: 0.011, wamp: 0.42, freq: 3.1, seed: t.seed + 401 };

  // faint darkened disc so the sigil sits in a shadowed ground pool
  t.blob(CX, CY, R * 1.02, 0.06, t.seed + 2, (i, a, nx, ny, nr) => {
    const inner = clamp01(1 - nr);
    const x = i % s, y = (i / s) | 0;
    const mot = fbm2(x * 0.05, y * 0.05, { octaves: 4, seed: t.seed + 12 });
    t.put(i, a * (0.10 + inner * 0.16) * (0.6 + mot * 0.7),
      RUNE_STONE[0] * 1.6, RUNE_STONE[1] * 1.5, RUNE_STONE[2] * 1.4, 0.66, 0, -0.05 * inner);
  });

  /** Erosion + charge, sampled per pixel. Returns [coverage k, mask k]. */
  const wear = (x, y) => {
    const mid = fbm2(x * 0.105, y * 0.105, { octaves: 4, seed: t.seed + 71 });
    const fine = fbm2(x * 0.39, y * 0.39, { octaves: 2, seed: t.seed + 133 });
    const cell = worley2(x * 21 / s, y * 21 / s, t.seed + 211);
    // worley cell walls carve chips clean through the channel
    const chip = sstep(0.34, 0.05, cell.edge);
    const ero = clamp01(0.22 + mid * 1.05 + (fine - 0.5) * 0.42) * (1 - chip * 0.72);
    /* Charge: slow and large, with real contrast, so entire arcs of the sigil are
       COLD at any moment. A ward whose every stroke is equally lit is a wireframe
       no matter how dim it is; the cold stretches are what make the shader's
       scrolling flow legible as something travelling through the channels. */
    const chg = sstep(0.34, 0.72, fbm2(x * 0.0135, y * 0.0135, { octaves: 3, seed: t.seed + 9 }))
      * (0.55 + 0.45 * sstep(0.30, 0.66, fbm2(x * 0.031 + 13.7, y * 0.031 - 8.2, { octaves: 2, seed: t.seed + 27 })));
    return [0.34 + 0.66 * ero, ero, clamp01(chg)];
  };

  const paint = (i, a, tt, dn) => {
    const x = i % s, y = (i / s) | 0;
    const dnc = clamp01(dn ?? 0);
    const [kcov, ero, chg] = wear(x, y);
    // cross-section: dark shadowed groove down the middle, light at the lip
    const lip = sstep(0.06, 0.86, dnc);
    const core = 1 - lip;
    const k = (0.46 + ero * 0.62) * (0.72 + lip * 0.55);
    const mask = clamp01((0.05 + 0.95 * lip) * (0.12 + 1.05 * chg) * (0.30 + 0.78 * ero));
    t.put(i, a * kcov,
      RUNE_STONE[0] * k, RUNE_STONE[1] * k, RUNE_STONE[2] * k,
      clamp01(0.70 - lip * 0.30 + (ero - 0.5) * 0.14), mask,
      -0.95 * core + lip * 0.22 * ero);
  };
  // Rings hand `ring()`'s band coordinate straight through, so a ring stroke
  // gets the same engraved cross-section as a capsule stroke.
  const ringPaint = (i, a, nr, bandN) => paint(i, a, 0, bandN ?? 0.4);

  if (variant === 0) {
    t.ring(CX, CY, R, s * 0.016, ringPaint, 0, TAU, wob);
    t.ring(CX, CY, R * 0.945, s * 0.008, ringPaint, 0, TAU, wob);
    t.ring(CX, CY, R * 0.70, s * 0.012, ringPaint, 0, TAU, wob);
    t.ring(CX, CY, R * 0.30, s * 0.010, ringPaint, 0, TAU, wob);
    // heptagram
    const P = 7, skip = 3;
    for (let k = 0; k < P; k++) {
      const a0 = (k / P) * TAU - Math.PI / 2;
      const a1 = (((k + skip) % P) / P) * TAU - Math.PI / 2;
      t.capsule(CX + Math.cos(a0) * R * 0.69, CY + Math.sin(a0) * R * 0.69,
        CX + Math.cos(a1) * R * 0.69, CY + Math.sin(a1) * R * 0.69, s * 0.007, s * 0.007, paint);
    }
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      const inR = k % 2 === 0 ? R * 0.955 : R * 0.975;
      t.capsule(CX + Math.cos(a) * inR, CY + Math.sin(a) * inR,
        CX + Math.cos(a) * R * 0.895, CY + Math.sin(a) * R * 0.895, s * 0.006, s * 0.005, paint);
    }
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * TAU + 0.1;
      glyph(t, CX + Math.cos(a) * R * 0.82, CY + Math.sin(a) * R * 0.82, s * 0.036,
        a + Math.PI / 2, t.seed + 1000 + k, paint);
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU - Math.PI / 2;
      t.blob(CX + Math.cos(a) * R * 0.69, CY + Math.sin(a) * R * 0.69, s * 0.013, 0.05,
        t.seed + 60 + k, (i, aa, nx, ny, nr) => paint(i, aa, 0, nr));
    }
  } else if (variant === 1) {
    t.ring(CX, CY, R, s * 0.013, ringPaint, 0, TAU, wob);
    t.ring(CX, CY, R * 0.86, s * 0.020, ringPaint, 0, TAU, wob);
    t.ring(CX, CY, R * 0.52, s * 0.011, ringPaint, 0, TAU, wob);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      t.capsule(CX + Math.cos(a) * R * 0.52, CY + Math.sin(a) * R * 0.52,
        CX + Math.cos(a) * R * 0.855, CY + Math.sin(a) * R * 0.855, s * 0.009, s * 0.009, paint);
      t.ring(CX + Math.cos(a) * R * 0.69, CY + Math.sin(a) * R * 0.69, s * 0.045, s * 0.008, ringPaint,
        0, TAU, { amp: 0.05, wamp: 0.5, freq: 2.6, seed: t.seed + 500 + k });
      glyph(t, CX + Math.cos(a) * R * 0.69, CY + Math.sin(a) * R * 0.69, s * 0.030,
        a, t.seed + 2000 + k, paint);
    }
    // hexagram
    for (const off of [0, Math.PI / 3]) {
      for (let k = 0; k < 3; k++) {
        const a0 = off + (k / 3) * TAU, a1 = off + ((k + 1) / 3) * TAU;
        t.capsule(CX + Math.cos(a0) * R * 0.50, CY + Math.sin(a0) * R * 0.50,
          CX + Math.cos(a1) * R * 0.50, CY + Math.sin(a1) * R * 0.50, s * 0.008, s * 0.008, paint);
      }
    }
    t.ring(CX, CY, R * 0.16, s * 0.014, ringPaint, 0, TAU, { amp: 0.05, wamp: 0.5, freq: 2.4, seed: t.seed + 612 });
  } else {
    // broken arc ring + angular script + central diamond
    for (let k = 0; k < 5; k++) {
      const a0 = (k / 5) * TAU + 0.16, a1 = a0 + TAU / 5 - 0.32;
      t.ring(CX, CY, R, s * 0.019, ringPaint, a0, a1, wob);
      t.ring(CX, CY, R * 0.90, s * 0.008, ringPaint, a0 + 0.06, a1 - 0.06, wob);
    }
    t.ring(CX, CY, R * 0.63, s * 0.010, ringPaint, 0, TAU, wob);
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU;
      glyph(t, CX + Math.cos(a) * R * 0.76, CY + Math.sin(a) * R * 0.76, s * 0.040,
        a + Math.PI / 2, t.seed + 3000 + k, paint);
    }
    const dia = [[0, -0.34], [0.24, 0], [0, 0.34], [-0.24, 0]];
    for (let k = 0; k < 4; k++) {
      const p0 = dia[k], p1 = dia[(k + 1) % 4];
      t.capsule(CX + p0[0] * R, CY + p0[1] * R, CX + p1[0] * R, CY + p1[1] * R, s * 0.010, s * 0.010, paint);
    }
    t.capsule(CX, CY - R * 0.20, CX, CY + R * 0.20, s * 0.007, s * 0.007, paint);
    t.capsule(CX - R * 0.14, CY, CX + R * 0.14, CY, s * 0.007, s * 0.007, paint);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + 0.16;
      t.blob(CX + Math.cos(a) * R, CY + Math.sin(a) * R, s * 0.018, 0.06, t.seed + 90 + k,
        (i, aa, nx, ny, nr) => paint(i, aa, 0, nr));
    }
  }

  /* The penumbra. Without it every stroke ends at a hard alpha step and the
     sigil is line art no matter how well the strokes themselves are eroded. */
  t.glowBleed(Math.max(2, s * 0.016), 0.42, 0.30,
    [RUNE_STONE[0] * 1.15, RUNE_STONE[1] * 1.05, RUNE_STONE[2] * 0.95]);
  void r;
}

/* --------------------------------------------------------------- build */

const GENS = {
  blood_a: (t) => genBlood(t, { dirBias: 1, cores: 3, streaks: 16, sats: 60, cx: 0.34, spread: 0.52 }),
  blood_b: (t) => genBlood(t, { dirBias: 1, cores: 4, streaks: 11, sats: 44, cx: 0.44, spread: 1.15 }),
  blood_spray: (t) => genBloodSpray(t),
  blood_pool: (t) => genBloodPool(t),
  scorch: (t) => genScorch(t, false),
  scorch_burst: (t) => genScorch(t, true),
  rime: (t) => genRime(t),
  crack: (t) => genCrack(t, false),
  crack_web: (t) => genCrack(t, true),
  foot_boot: (t) => genFootBoot(t),
  foot_claw: (t) => genFootClaw(t),
  dust: (t) => genDust(t),
  rune_a: (t) => genRune(t, 0),
  rune_b: (t) => genRune(t, 1),
  rune_c: (t) => genRune(t, 2),
  drips: (t) => genDrips(t),
};

/** Sobel normal from the tile height field, clamped (decals do not tile). */
function writeTile(tile, albedo, packed, atlasSize, tx, ty, normalStrength) {
  const s = tile.s;
  const h = tile.h;
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x >= s ? s - 1 : x;
    const cy = y < 0 ? 0 : y >= s ? s - 1 : y;
    return h[cy * s + cx];
  };
  for (let y = 0; y < s; y++) {
    const dy = (ty * s + y) * atlasSize;
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const o = (dy + tx * s + x) * 4;
      const cov = clamp01(tile.cov[i]);
      albedo[o] = clamp01(tile.cr[i]) * 255;
      albedo[o + 1] = clamp01(tile.cg[i]) * 255;
      albedo[o + 2] = clamp01(tile.cb[i]) * 255;
      albedo[o + 3] = cov * 255;

      const gx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
        - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const gy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
        - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = gx * normalStrength, ny = gy * normalStrength;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= l; ny /= l;
      packed[o] = (nx * 0.5 + 0.5) * 255;
      packed[o + 1] = (ny * 0.5 + 0.5) * 255;
      packed[o + 2] = clamp01(tile.rg[i]) * 255;
      packed[o + 3] = clamp01(tile.mk[i]) * 255;
    }
  }
}

/**
 * Build the atlas. Returns the two textures plus the per-tile UV rects.
 * @param {import('../../core/Engine.js').Engine} engine
 */
export function buildDecalAtlas(engine, size = 1024) {
  const atlasSize = size;
  const ts = (atlasSize / GRID) | 0;
  const albedo = new Uint8ClampedArray(atlasSize * atlasSize * 4);
  const packed = new Uint8ClampedArray(atlasSize * atlasSize * 4);
  const rects = {};
  const inv = 1 / GRID;

  for (let k = 0; k < TILES.length; k++) {
    const name = TILES[k];
    const tx = k % GRID, ty = (k / GRID) | 0;
    const tile = new Tile(ts, (0x51a1 + k * 7919) >>> 0);
    try {
      GENS[name](tile);
    } catch (e) {
      console.warn(`[decals] tile "${name}" failed —`, e?.message ?? e);
    }
    tile.fadeBorder(0.05);
    writeTile(tile, albedo, packed, atlasSize, tx, ty, ts / 42);
    // inset by half a texel so bilinear filtering never samples a neighbour
    const pad = 0.5 / atlasSize;
    rects[name] = [tx * inv + pad, ty * inv + pad, inv - pad * 2, inv - pad * 2];
  }

  const aniso = engine?.maxAniso ?? 1;
  const mk = (data, srgb) => {
    const t = new THREE.DataTexture(
      new Uint8Array(data.buffer, data.byteOffset, data.length),
      atlasSize, atlasSize, THREE.RGBAFormat, THREE.UnsignedByteType,
    );
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = aniso;
    t.premultiplyAlpha = false;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: mk(albedo, true),
    packed: mk(packed, false),
    rects,
    size: atlasSize,
    dispose() { this.map.dispose(); this.packed.dispose(); },
  };
}
