/**
 * SANCTUM — scalar field plumbing for procedural texture synthesis.
 *
 * A "field" is a Float32Array of size*size laid out row-major, row 0 first.
 * Textures are uploaded with flipY = false, so the array row index maps
 * directly to v — that keeps the green channel of the derived normal map in
 * the OpenGL (+Y up) convention every three.js material expects.
 *
 * The important trick here is `field(size, ds, fn)`: low- and mid-frequency
 * layers are evaluated on a coarse grid and smoothly resampled. A frequency-8
 * warp field carries zero information above the Nyquist limit of a 256² grid,
 * so evaluating it 1,048,576 times at 1024² is pure waste. This is what keeps
 * a full 13-kind material set inside the ~2.5 s budget while still running
 * genuine multi-octave synthesis.
 */

/* ---------------------------------------------------------------- fields */

/**
 * Build a scalar field. `ds` is the downsample factor for evaluation
 * (1 = full res). The coarse grid is never allowed below 256² so 512-tier
 * textures keep the same structural fidelity as 1024.
 *
 * @param {number} size    output resolution
 * @param {number} ds      evaluation downsample (1,2,4,8)
 * @param {(u:number,v:number,x:number,y:number)=>number} fn
 */
export function field(size, ds, fn) {
  const eff = Math.max(1, Math.min(ds | 0 || 1, Math.round((ds * size) / 1024) || 1));
  if (eff <= 1) {
    const out = new Float32Array(size * size);
    const inv = 1 / size;
    for (let y = 0, i = 0; y < size; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < size; x++, i++) out[i] = fn((x + 0.5) * inv, v, x, y);
    }
    return out;
  }
  const c = Math.max(8, Math.round(size / eff));
  const lo = new Float32Array(c * c);
  const invc = 1 / c;
  for (let y = 0, i = 0; y < c; y++) {
    const v = (y + 0.5) * invc;
    for (let x = 0; x < c; x++, i++) lo[i] = fn((x + 0.5) * invc, v, x, y);
  }
  return upsampleWrap(lo, c, size);
}

/**
 * Multi-output field. Cellular passes are the expensive part of synthesis and
 * a single worley evaluation carries f1, f2, edge *and* a stable per-cell id —
 * this lets a generator harvest all of them from one pass instead of paying
 * for the lookup three times.
 *
 * @param {(u:number,v:number,out:Float32Array,x:number,y:number)=>void} fn
 * @returns {Float32Array[]} `count` fields at full resolution
 */
export function fieldN(size, ds, count, fn) {
  const eff = Math.max(1, Math.min(ds | 0 || 1, Math.round((ds * size) / 1024) || 1));
  const tmp = new Float32Array(count);
  if (eff <= 1) {
    const outs = [];
    for (let k = 0; k < count; k++) outs.push(new Float32Array(size * size));
    const inv = 1 / size;
    for (let y = 0, i = 0; y < size; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < size; x++, i++) {
        fn((x + 0.5) * inv, v, tmp, x, y);
        for (let k = 0; k < count; k++) outs[k][i] = tmp[k];
      }
    }
    return outs;
  }
  const c = Math.max(8, Math.round(size / eff));
  const los = [];
  for (let k = 0; k < count; k++) los.push(new Float32Array(c * c));
  const invc = 1 / c;
  for (let y = 0, i = 0; y < c; y++) {
    const v = (y + 0.5) * invc;
    for (let x = 0; x < c; x++, i++) {
      fn((x + 0.5) * invc, v, tmp, x, y);
      for (let k = 0; k < count; k++) los[k][i] = tmp[k];
    }
  }
  return los.map((lo) => upsampleWrap(lo, c, size));
}

/** Toroidal C1 resample (quintic weights — no bilinear diamonds). */
export function upsampleWrap(lo, c, size) {
  const out = new Float32Array(size * size);
  const inv = 1 / size;
  const ix0 = new Int32Array(size), ix1 = new Int32Array(size), wx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const fx = (x + 0.5) * inv * c - 0.5;
    let i0 = Math.floor(fx);
    const t = fx - i0;
    i0 = ((i0 % c) + c) % c;
    ix0[x] = i0;
    ix1[x] = (i0 + 1) % c;
    wx[x] = t * t * t * (t * (t * 6 - 15) + 10);
  }
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) * inv * c - 0.5;
    let j0 = Math.floor(fy);
    const t = fy - j0;
    j0 = ((j0 % c) + c) % c;
    const j1 = (j0 + 1) % c;
    const wy = t * t * t * (t * (t * 6 - 15) + 10);
    const r0 = j0 * c, r1 = j1 * c, o = y * size;
    for (let x = 0; x < size; x++) {
      const a = lo[r0 + ix0[x]], b = lo[r0 + ix1[x]];
      const cc = lo[r1 + ix0[x]], d = lo[r1 + ix1[x]];
      const t0 = a + (b - a) * wx[x];
      const t1 = cc + (d - cc) * wx[x];
      out[o + x] = t0 + (t1 - t0) * wy;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- filters */

/* Wrapped moving-average sweeps. The ring buffer is materialised into a padded
 * scratch line so the inner loop is modulo-free — with four sweeps over a
 * megapixel per blur, the `%` was costing more than the arithmetic. */
function boxH(src, dst, size, r, pad) {
  const w = 1 / (2 * r + 1);
  const span = 2 * r + 1;
  for (let y = 0; y < size; y++) {
    const o = y * size;
    for (let k = 0; k < r; k++) pad[k] = src[o + size - r + k];
    for (let k = 0; k < size; k++) pad[r + k] = src[o + k];
    for (let k = 0; k < r; k++) pad[r + size + k] = src[o + k];
    let sum = 0;
    for (let k = 0; k < span; k++) sum += pad[k];
    for (let x = 0; x < size; x++) {
      dst[o + x] = sum * w;
      sum += pad[x + span] - pad[x];
    }
  }
}
function boxV(src, dst, size, r, pad) {
  const w = 1 / (2 * r + 1);
  const span = 2 * r + 1;
  for (let x = 0; x < size; x++) {
    for (let k = 0; k < r; k++) pad[k] = src[(size - r + k) * size + x];
    for (let k = 0; k < size; k++) pad[r + k] = src[k * size + x];
    for (let k = 0; k < r; k++) pad[r + size + k] = src[k * size + x];
    let sum = 0;
    for (let k = 0; k < span; k++) sum += pad[k];
    for (let y = 0; y < size; y++) {
      dst[y * size + x] = sum * w;
      sum += pad[y + span] - pad[y];
    }
  }
}

function blurCore(a, size, r, passes) {
  const rr = Math.max(1, Math.min(r, size - 1));
  const b = new Float32Array(size * size);
  const pad = new Float32Array(size + 2 * rr + 1);
  for (let p = 0; p < passes; p++) {
    boxH(a, b, size, rr, pad);
    boxV(b, a, size, rr, pad);
  }
  return a;
}

/** Toroidal box average over f x f blocks. */
export function downsampleWrap(src, size, c) {
  const f = size / c;
  const out = new Float32Array(c * c);
  const inv = 1 / (f * f);
  for (let y = 0; y < c; y++) {
    for (let x = 0; x < c; x++) {
      let s = 0;
      for (let j = 0; j < f; j++) {
        const row = (y * f + j) * size + x * f;
        for (let i = 0; i < f; i++) s += src[row + i];
      }
      out[y * c + x] = s * inv;
    }
  }
  return out;
}

/**
 * Wrapped near-gaussian blur (iterated box, O(1) in radius).
 * Broad radii are computed at quarter resolution — a 40-texel blur carries no
 * detail a quarter-res grid cannot hold, and it is 16x less work.
 */
export function blurWrap(src, size, radius, passes = 2) {
  const r = Math.max(1, Math.round(radius));
  if (r >= 8 && size >= 128 && size % 4 === 0) {
    const c = size >> 2;
    const lo = downsampleWrap(src, size, c);
    blurCore(lo, c, Math.max(1, Math.round(r / 4)), passes);
    return upsampleWrap(lo, c, size);
  }
  return blurCore(src.slice(), size, r, passes);
}

/**
 * Proudness / recess measure of a height field, in [-1, 1].
 *
 * This is the piece of plumbing the material library was missing, and its
 * absence is why "wear" everywhere in the project was an *independent noise
 * field* sprayed over the surface rather than damage that follows the form. A
 * scratch, a polished arris, a chipped corner and a tarnished recess are all
 * consequences of where the surface is PROUD or SHELTERED, so they have to be
 * derived from the structure that is already there:
 *
 *   +1  the crest of a hammer facet, the arris of a block, the crown of a ring
 *    0  the flat field
 *   -1  the trough of a joint, the floor of a dent, the gap between rings
 *
 * `radius` selects which structural tier the measure responds to — pass the
 * blur radius of the tier whose crests should take the wear.
 */
export function proudness(h, size, radius) {
  const b = blurWrap(h, size, Math.max(1, Math.round(radius)), 2);
  const n = h.length;
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = h[i] - b[i];
    out[i] = d;
    acc += d < 0 ? -d : d;
  }
  // Scale against the field's own mean deviation, so a kind whose relief is
  // shallow still gets a usable 0..1 channel and the caller's gains mean the
  // same thing on every kind.
  const k = 1 / Math.max(1e-6, (acc / n) * 2.2);
  for (let i = 0; i < n; i++) {
    const v = out[i] * k;
    out[i] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return out;
}

export function minmax(src) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return [mn, mx];
}

export function normalizeInPlace(src, lo = 0, hi = 1) {
  const [mn, mx] = minmax(src);
  const s = mx > mn ? (hi - lo) / (mx - mn) : 0;
  for (let i = 0; i < src.length; i++) src[i] = lo + (src[i] - mn) * s;
  return src;
}

/* ---------------------------------------------------------------- normals */

/**
 * Sobel-derived tangent-space normal map from a real height field.
 *
 * The gradient scale is calibrated against the field's own mean slope rather
 * than a hard-coded constant, so a kind whose height range happens to be small
 * still gets a normal map with usable relief, and the result is independent of
 * texture resolution. `strength` then behaves like an artist slider around a
 * sane default of 1.
 */
export function sobelNormal(h, size, strength, out) {
  let acc = 0;
  const stride = size;
  for (let y = 0; y < size; y += 2) {
    const ym = (y - 1 + size) % size, yp = (y + 1) % size;
    const r0 = ym * stride, r1 = y * stride, r2 = yp * stride;
    for (let x = 0; x < size; x += 2) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[r0 + xp] + 2 * h[r1 + xp] + h[r2 + xp]) - (h[r0 + xm] + 2 * h[r1 + xm] + h[r2 + xm]);
      const dy = (h[r2 + xm] + 2 * h[r2 + x] + h[r2 + xp]) - (h[r0 + xm] + 2 * h[r0 + x] + h[r0 + xp]);
      acc += Math.abs(dx) + Math.abs(dy);
    }
  }
  const samples = Math.ceil(size / 2) * Math.ceil(size / 2) * 2;
  const mean = acc / Math.max(1, samples);
  // Aim for a mean slope of ~0.34 (≈19°) at strength 1; clamp so a nearly flat
  // field is not amplified into noise.
  const k = Math.min(320, 0.34 * strength / Math.max(1e-5, mean));

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size, yp = (y + 1) % size;
    const r0 = ym * stride, r1 = y * stride, r2 = yp * stride;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[r0 + xp] + 2 * h[r1 + xp] + h[r2 + xp]) - (h[r0 + xm] + 2 * h[r1 + xm] + h[r2 + xm]);
      const dy = (h[r2 + xm] + 2 * h[r2 + x] + h[r2 + xp]) - (h[r0 + xm] + 2 * h[r0 + x] + h[r0 + xp]);
      const nx = -dx * k, ny = -dy * k;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (r1 + x) * 4;
      out[o] = (nx * invLen * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * invLen * 0.5 + 0.5) * 255;
      out[o + 2] = (invLen * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- context */

/**
 * The buffer bundle a generator fills in. Channels are kept as separate
 * Float32Arrays (not interleaved) so each synthesis pass stays cache-linear.
 *
 * A generator must fill: h (height), cr/cg/cb (albedo, sRGB display values),
 * rg (roughness), mt (metalness), gm (grime *supply* — where dirt would land
 * if the geometry catches it; the finalize pass weights this by measured
 * cavity), and — for anything that is meant to look used — wr (bright-wear
 * *supply*, weighted by measured proudness; see finalize()).
 * Optional: coverage() for blend layers, emissive() for embers.
 */
export class GenCtx {
  constructor(size, seed, opts = {}) {
    const n = size * size;
    this.size = size;
    this.n = n;
    this.seed = seed | 0;
    this.opts = opts;
    this.h = new Float32Array(n);
    this.cr = new Float32Array(n);
    this.cg = new Float32Array(n);
    this.cb = new Float32Array(n);
    this.rg = new Float32Array(n);
    this.mt = new Float32Array(n);
    this.gm = new Float32Array(n);
    /** bright-wear supply — where abrasion WOULD expose fresh material */
    this.wr = new Float32Array(n);
    this.cov = null;
    this.em = null;
    this.params = {
      /** normal map punch */
      normalStrength: 1.0,
      /** cavity → ambient occlusion depth */
      aoStrength: 0.9,
      /** weights for the fine / broad cavity terms */
      cavity1: 1.0,
      cavity2: 1.0,
      /** how much grime the surface can hold at all */
      grimeAmount: 0.6,
      /** 1 = grime only in cavities, 0 = uniform film (dust, ash) */
      grimeCavity: 1.0,
      grimeColor: [0.19, 0.17, 0.14],
      grimeRough: 0.94,
      /** dielectric dirt shorts out metallic response */
      grimeMetalKill: 0.9,
      /** grime fills micro-relief, softening the normal */
      grimeFill: 0.35,
      /** bake a touch of cavity into albedo — reads far better than pure AO */
      cavityTint: 0.22,
      /* ---- TIER 2: bright wear that follows the form ----
       * Symmetric to the grime pass, and the reason it exists is the round-2
       * blocker: every surface in the project carried "structure" and "grain"
       * but its wear was a third independent noise field, so nothing looked
       * *used* — it looked speckled. Grime is weighted by measured CAVITY;
       * wear is weighted by measured PROUDNESS, which is what puts polished
       * metal on an arris, a chipped pale corner on a block, a burnished crown
       * on a mail ring and a scuffed shine on a raised leather welt.
       * `wearAmount` 0 disables the pass entirely, so any kind that has not
       * opted in is bit-identical to before. */
      wearAmount: 0,
      /** the material UNDER the finish: bare steel, fresh stone, pale fibre */
      wearColor: [0.80, 0.80, 0.82],
      wearRough: 0.24,
      /** null = leave metalness alone; a number = metalness at full wear */
      wearMetal: null,
      /** blur radius (texels at 1024) of the tier whose crests take the wear */
      wearScale: 26,
      /* The proudness window, in units of the field's own mean deviation. Only
         texels above `wearGate[0]` take any wear and only those above
         `wearGate[1]` take all of it. This is the knob that sets what FRACTION of
         a surface ends up as bare material, so it is per-kind: a hammered plate
         shows bare steel over a few percent of its area, a stone block's spalls
         are rarer still, a mail ring's crown is most of the ring. */
      wearGate: [0.40, 1.05],
      /** how hard proudness gates the supply. 0 = ignore form (do not) */
      wearProud: 1.0,
      roughMin: 0.04,
      roughMax: 1.0,
      /** world height of the displacement map across one UV tile */
      displacement: 0.05,
    };
  }
  coverage() {
    if (!this.cov) this.cov = new Float32Array(this.n).fill(1);
    return this.cov;
  }
  emissive() {
    if (!this.em) this.em = new Float32Array(this.n * 3);
    return this.em;
  }
  set(i, r, g, b) { this.cr[i] = r; this.cg[i] = g; this.cb[i] = b; }
}

/**
 * The shared wear pass. Every kind — including ones registered by other
 * modules — goes through this, which is what makes the whole material library
 * feel like it came from one hand:
 *
 *   1. height is normalised, then measured at two blur scales to recover
 *      genuine cavity/curvature (a cheap but real AO bake, not a noise map);
 *   2. the kind's *bright-wear* supply is multiplied by measured PROUDNESS, so
 *      abrasion only exposes fresh material where the form actually stands
 *      proud — arrises, facet crests, ring crowns, raised welts;
 *   3. the kind's grime *supply* is multiplied by that cavity, so dirt only
 *      collects where the surface can actually hold it;
 *   4. grime then darkens albedo, raises roughness, deepens occlusion and
 *      kills metalness *together*. That coupling — dark AND rough AND
 *      occluded AND dielectric — is the thing the eye reads as "real".
 *
 * Steps 2 and 3 are deliberately opposite in sign and driven by the SAME height
 * field, which is what makes a surface read as one object that has been used
 * rather than as three noise fields stacked on each other.
 */
export function finalize(ctx) {
  const { size, n, h, cr, cg, cb, rg, mt, gm, wr } = ctx;
  const P = ctx.params;

  normalizeInPlace(h);

  const bFine = blurWrap(h, size, Math.max(1, size / 190), 2);
  const bBroad = blurWrap(h, size, Math.max(3, size / 26), 2);
  /* The wear tier gets its OWN blur scale. Reusing bBroad would tie edge wear
     to whatever the coarsest tier happens to be, and on a plate the arrises the
     polishing cloth reaches are a mid-frequency feature, not a macro one. */
  const wScale = Math.max(1, Math.round((P.wearScale * size) / 1024));
  const bWear = (P.wearAmount > 0 && wScale !== Math.max(3, Math.round(size / 26)))
    ? blurWrap(h, size, wScale, 2)
    : bBroad;

  const ao = new Float32Array(n);
  const hn = new Float32Array(n); // grime-filled height → normals

  // Mean deviation of the wear-scale relief, so `wearProud` is calibrated
  // against the kind's own structure instead of an absolute height guess.
  let wAcc = 0;
  if (P.wearAmount > 0) {
    for (let i = 0; i < n; i++) { const d = h[i] - bWear[i]; wAcc += d < 0 ? -d : d; }
  }
  const wK = 1 / Math.max(1e-6, (wAcc / n) * 2.0);
  const WC = P.wearColor, wRgh = P.wearRough, wMtl = P.wearMetal;
  const wG = P.wearGate ?? [0.40, 1.05];
  const wG0 = wG[0], wGk = 1 / Math.max(1e-3, wG[1] - wG[0]);

  for (let i = 0; i < n; i++) {
    const hv = h[i];
    const c1 = bFine[i] - hv;
    const c2 = bBroad[i] - hv;
    let cav = (c1 > 0 ? c1 * 3.2 * P.cavity1 : c1 * 1.2) + (c2 > 0 ? c2 * 2.2 * P.cavity2 : c2 * 0.8);
    cav = cav < 0 ? 0 : cav > 1 ? 1 : cav;

    // A real crevice still receives bounce light; letting AO reach zero is what
    // turns fine pores into black pinholes.
    let a = 1 - cav * P.aoStrength * 0.92;

    /* ---- TIER 2a: bright wear on the proud form ---- */
    if (P.wearAmount > 0) {
      const prd = (hv - bWear[i]) * wK;
      /* The gate is a WINDOW, not a ramp, and that distinction is the whole
         difference between wear and a wash. A ramp from 0 gives every texel above
         the mean some fraction of the wear, so the surface lifts uniformly by
         ~0.15 and nothing ever reaches bare metal — measured: p90 albedo 0.510 and
         0.01 % of the map above 0.72, i.e. a broad partial plateau, which is the
         defect this pass exists to remove. Windowed on [0.40, 1.05] of the field's
         own normalised proudness, only the genuine crests qualify and they reach
         FULL wear, so bright material appears as a small, high-contrast fraction
         of the area — rare and earned, in the rubric's terms. */
      let gate = (prd - wG0) * wGk;
      gate = gate <= 0 ? 0 : gate >= 1 ? 1 : gate * gate * (3 - 2 * gate);
      let w = (wr[i] < 0 ? 0 : wr[i] > 1 ? 1 : wr[i]) * P.wearAmount
        * (1 - P.wearProud + P.wearProud * gate);
      if (w > 1) w = 1;
      if (w > 0.002) {
        cr[i] += (WC[0] - cr[i]) * w;
        cg[i] += (WC[1] - cg[i]) * w;
        cb[i] += (WC[2] - cb[i]) * w;
        rg[i] += (wRgh - rg[i]) * w;
        if (wMtl !== null) mt[i] += (wMtl - mt[i]) * w;
        // A polished crest sheds dirt — this is the coupling that makes the two
        // passes read as one history instead of two overlays.
        gm[i] *= 1 - 0.72 * w;
      }
    }

    const supply = gm[i] < 0 ? 0 : gm[i] > 1 ? 1 : gm[i];
    const catchment = 0.16 + 1.5 * cav;
    let g = supply * P.grimeAmount * (P.grimeCavity * (catchment > 1 ? 1 : catchment) + (1 - P.grimeCavity));
    if (g > 1) g = 1;

    if (g > 0.002) {
      const gc = P.grimeColor;
      // grime is a thin dielectric film: it takes on some of the substrate's
      // value so a pale surface stays pale-dirty rather than turning to mud.
      const l = cr[i] * 0.2126 + cg[i] * 0.7152 + cb[i] * 0.0722;
      const k = 0.5 + 0.85 * l;
      cr[i] += (gc[0] * k - cr[i]) * g;
      cg[i] += (gc[1] * k - cg[i]) * g;
      cb[i] += (gc[2] * k - cb[i]) * g;
      rg[i] += (P.grimeRough - rg[i]) * g * 0.92;
      mt[i] *= 1 - P.grimeMetalKill * g;
      a *= 1 - 0.5 * g;
      hn[i] = hv + (bFine[i] - hv) * P.grimeFill * g;
    } else {
      hn[i] = hv;
    }

    a = a < 0.07 ? 0.07 : a > 1 ? 1 : a;
    ao[i] = a;

    // contact darkening in albedo — small, but it is what stops flat lighting
    // from reading as plastic when AO is subtle or disabled.
    const t = 1 - P.cavityTint * (1 - a);
    cr[i] *= t; cg[i] *= t; cb[i] *= t;

    let r = rg[i];
    if (r < P.roughMin) r = P.roughMin;
    else if (r > P.roughMax) r = P.roughMax;
    rg[i] = r;

    let m = mt[i];
    mt[i] = m < 0 ? 0 : m > 1 ? 1 : m;
  }

  ctx.ao = ao;
  ctx.hn = hn;
  return ctx;
}

/* ---------------------------------------------------------------- packing */

export function packAlbedo(ctx) {
  const { n, cr, cg, cb, cov } = ctx;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out[o] = cr[i] * 255;
    out[o + 1] = cg[i] * 255;
    out[o + 2] = cb[i] * 255;
    out[o + 3] = cov ? cov[i] * 255 : 255;
  }
  return out;
}

/** ORM packing (glTF convention): R = occlusion, G = roughness, B = metalness. */
export function packORM(ctx) {
  const { n, ao, rg, mt, h } = ctx;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out[o] = ao[i] * 255;
    out[o + 1] = rg[i] * 255;
    out[o + 2] = mt[i] * 255;
    out[o + 3] = h[i] * 255;
  }
  return out;
}

export function packEmissive(ctx) {
  const { n, em } = ctx;
  if (!em) return null;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, o = 0, e = 0; i < n; i++, o += 4, e += 3) {
    out[o] = em[e] * 255;
    out[o + 1] = em[e + 1] * 255;
    out[o + 2] = em[e + 2] * 255;
    out[o + 3] = 255;
  }
  return out;
}

/** Half-resolution height, 2x2 box filtered. Displacement never needs full res. */
export function packHeight(ctx) {
  const { size, h } = ctx;
  const hs = Math.max(4, size >> 1);
  const out = new Uint8ClampedArray(hs * hs * 4);
  for (let y = 0; y < hs; y++) {
    const s0 = y * 2 * size, s1 = (y * 2 + 1) * size;
    for (let x = 0; x < hs; x++) {
      const x0 = x * 2, x1 = x * 2 + 1;
      const v = (h[s0 + x0] + h[s0 + x1] + h[s1 + x0] + h[s1 + x1]) * 0.25 * 255;
      const o = (y * hs + x) * 4;
      out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
    }
  }
  return { data: out, size: hs };
}
