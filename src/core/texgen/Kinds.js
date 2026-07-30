/**
 * THE NINTH VIGIL — procedural surface library.
 *
 * Every kind is built the same way, because that is what makes them read as
 * one material library rather than thirteen unrelated noise experiments:
 *
 *   base value pattern  → the large statement (blocks, boards, cells, weave)
 *   mid structure       → what makes it that material (grain, facets, pores)
 *   high detail         → the micro-relief the specular highlight breaks on
 *   grime supply        → where dirt *would* land; Field.finalize() then
 *                         weights it by measured cavity and couples it into
 *                         albedo + roughness + AO + metalness at once
 *
 * Physical notes that matter more than they sound:
 *  - For metals the albedo map is the specular F0 tint, not a diffuse colour.
 *    Iron F0 ≈ 0.56 linear (~0.78 sRGB); gold ≈ (1.00, 0.77, 0.34) linear.
 *    Painting metal "dark grey" and calling it iron is the classic tell.
 *  - Rust, tarnish and dirt are dielectrics: they must pull metalness down,
 *    not just tint the albedo.
 *  - Wet surfaces get *smoother* and darker at once; dry grime gets rougher
 *    and darker. Getting those two couplings backwards is instantly readable.
 */
import { field, fieldN } from './Field.js';
import {
  hash2, perlinT, fbmT, worleyT, worleyT4, warpT, streakT, pointsT,
  WK, WP, clamp01, lerp, smoothstep, frac,
  FBM_RIDGED, FBM_BILLOW,
} from './Noise.js';

const TAU = 6.283185307179586;

/* --------------------------------------------------------------- helpers */

/**
 * Full-resolution micro relief: two octaves near the texel scale. Written as a
 * flat loop rather than through field() — at a megapixel the per-texel closure
 * call is a measurable fraction of the work.
 */
function detailField(c, seed) {
  const size = c.size;
  const fa = Math.max(16, size >> 2);
  const fb = Math.max(8, Math.round(size / 11));
  // Only the texel-scale octave needs full resolution; the coarser one is
  // band-limited well below Nyquist at half res and costs a quarter as much.
  const lo = field(size, 2, (u, v) => perlinT(u * fb, v * fb, fb, fb, seed + 7));
  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const va = (y + 0.5) * inv * fa;
    for (let x = 0; x < size; x++, i++) {
      lo[i] = perlinT((x + 0.5) * inv * fa, va, fa, fa, seed) * 0.58 + lo[i] * 0.42;
    }
  }
  return lo;
}

/**
 * TIER 0 — the MACRO VALUE BAND, and it exists because of a measurement, not
 * because a surface looked boring in a texture preview.
 *
 * At the gameplay camera one texture repeat on a character covers 9-11 screen
 * pixels (measured on the live `combat` frame at 1600x900: bone 9.4 px, metal
 * 9.4 px, cloth 11.1 px, hide 4.4 px). The hardware therefore samples the 8-16
 * texel mip, and at that mip the only thing left of a kind whose lowest tier
 * sits at 4+ cycles per repeat is its MEAN. Measured albedo luma standard
 * deviation at the 16-texel mip before this tier existed:
 *
 *   bone 0.028   metal 0.072   cloth 0.012   flesh 0.009   charred hide 0.003
 *
 * A standard deviation of 0.009 is a flat colour. That is precisely the critic's
 * "untextured flat-colour geometry", and no amount of extra fine grain fixes it,
 * because fine grain is the first thing minification throws away.
 *
 * Two octaves at 2-3 cycles per repeat is the lowest band a tiling texture can
 * carry without reading as one blob per tile, and it is the band that survives:
 * a 2-cycle feature is 128 texels wide at 256 px, so it is still 8 texels at the
 * 16-texel mip and loses nothing at all. On screen it lands at 4-8 px, which on
 * a 60-90 px figure is a value break-up the eye reads as weathering.
 *
 * Returned mean-0, SD ~0.14, range about +/-0.45. Callers apply it
 * MULTIPLICATIVELY, so the map's mean — and therefore frame brightness — is
 * unchanged, and couple it into roughness and the grime supply as well, because
 * dark AND rough AND dirty together is what reads as a used surface rather than
 * as a colour wash.
 */
function macroField(c, seed, f = 2) {
  const size = c.size;
  const a = field(size, 8, (u, v) => fbmT(u * f, v * f, f, f, 2, 0.5, seed) - 0.5);
  // A second, coprime-ish band at f+1 with a fractional phase offset. One noise
  // field at one frequency reads as a single blotch per tile; two beating bands
  // read as patches of different sizes, which is what weathering looks like. The
  // 0.37 offset is a whole number of lattice cells away from itself after one
  // repeat, so the field is still exactly tileable.
  const g = f + 1;
  const b = field(size, 8, (u, v) => fbmT(u * g + 0.37, v * g, g, g, 2, 0.5, seed + 1013) - 0.5);
  for (let i = 0; i < a.length; i++) a[i] += b[i] * 0.62;
  return a;
}

/**
 * Apply a macro field multiplicatively with a soft limiter: returns `1 + m * gain`
 * but bounded, so the field's +/-0.45 tail can neither invert a value nor double it.
 *
 * HOW THE GAINS WERE SET, because "looks about right" is what produced the
 * problem. Measured relative albedo contrast (luma SD / luma mean) of the map at
 * the mip the gameplay camera actually selects, from the live `combat` frame:
 *
 *   HERO   mail 0.66   steel 0.26   gold 0.21   cloth 0.22   leather 0.20
 *   ENEMY  bone 0.13   ghoul flesh 0.15   brute flesh 0.12   charred hide 0.13
 *
 * The hero reads as material at 113 px and the enemies read as blobs at 60-100 px,
 * and the gap is not resolution — every one of these is the same generator family
 * at the same mip. It is that the enemy kinds carried HALF the relative contrast.
 * So the tier-0 gains are set to land bone, cloth, leather and flesh in the
 * hero's 0.20-0.26 band rather than at 0.12-0.15, which for a field of SD 0.14
 * means a gain near 1.9 rather than near 0.9.
 *
 * The limiter is a rational approximation of tanh — within 2 % of it across this
 * range, and one divide instead of two exponentials per texel per channel, which
 * on five channels of a 1024 px map is 5 M transcendentals saved per material.
 */
function macroMul(m, gain) {
  const x = m * gain;
  return 1 + x / (1 + (x < 0 ? -x : x) * 0.72);
}

/**
 * Clamp a TIER 3 (fine) frequency to something the texture the forge actually
 * handed us can resolve.
 *
 * The forge degrades to 256 px once its VRAM share is spent, and the bestiary is
 * last in line — every enemy map in the `combat` scenario measures 256 px. A
 * cortex pore declared at 190 cycles per repeat is then 1.3 texels wide, which
 * is not a pore, it is white noise that mips straight to grey. Four texels per
 * cycle is the floor for a cellular feature to survive its own reconstruction.
 *
 * At 1024 px this returns the requested frequency unchanged for every value in
 * the library (256 >= all of them), so every existing full-resolution map is
 * bit-identical to before.
 */
function fineF(size, cycles) {
  return Math.min(cycles, Math.max(8, size >> 2));
}

/** Per-texel hash — mineral flecks, grit, fibre. Averages away in mips. */
function fleckField(c, seed) {
  const size = c.size;
  const out = new Float32Array(size * size);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) out[i] = hash2(x, y, seed);
  }
  return out;
}

/**
 * Tileable anisotropic noise along an integer lattice direction.
 * (ax,ay) is the axis stretched along, (bx,by) the axis resolved across.
 */
function anisoT(u, v, ax, ay, bx, by, Fa, Fb, seed, oct = 3) {
  return fbmT((ax * u + ay * v) * Fa, (bx * u + by * v) * Fb, Fa, Fb, oct, 0.5, seed);
}

/* ================================================================= STONE */
/** Quarried granite blocks, mortar joints, chipped arrises, damp runoff. */
export function genStone(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 1.15;
  P.aoStrength = 1.0; P.cavity1 = 1.15; P.cavity2 = 1.35;
  P.grimeAmount = 0.85; P.grimeColor = [0.125, 0.118, 0.098]; P.grimeRough = 0.95;
  // Dressed granite has no glossy state. 0.15 let the damp runoff reach a
  // near-mirror lobe, and a broad bright specular over a whole wall or slab is
  // what reads as foil rather than as wet stone.
  P.roughMin = 0.24; P.displacement = 0.07;
  /* TIER 2 — spalled arrises. A dressed block that has been in a wall for two
     centuries has its corners knocked off, and the fresh fracture is PALER,
     cooler and less lichened than the weathered face. This is the single cheapest
     thing that stops a rubble block reading as a placeholder slab, and it is
     driven by the joint-distance field so it lands on the arrises and nowhere
     else. `wearProud` is low because a spall is a REMOVED chunk — it is not
     proud, it is a fresh recess, so the form gate must not veto it. */
  P.wearAmount = 0.85; P.wearColor = [0.395, 0.383, 0.352];
  P.wearRough = 0.70; P.wearScale = 30; P.wearProud = 0.28;

  const COLS = 3, ROWS = 5;
  const wu = field(size, 4, (u, v) => fbmT(u * 6, v * 6, 6, 6, 4, 0.5, S + 11) - 0.5);
  const wv = field(size, 4, (u, v) => fbmT(u * 6 + 11, v * 6 + 5, 6, 6, 4, 0.5, S + 29) - 0.5);
  const chip = field(size, 2, (u, v) => fbmT(u * 22, v * 22, 22, 22, 4, 0.55, S + 53));
  // Pitting must be sparse and clustered, never an even polka-dot field: only
  // cells that win a per-cell lottery erode, and only inside weathered zones.
  const pit = field(size, 2, (u, v) => {
    worleyT4(u * 22, v * 22, 22, 22, S + 71);
    const live = hash2(WK.cx, WK.cy, S + 73);
    if (live < 0.62) return 1;
    const rad = 0.16 + (live - 0.62) * 0.7;
    return 1 - smoothstep(rad, rad * 0.15, WK.f1) * (0.45 + 0.55 * live);
  });
  const alg = field(size, 4, (u, v) => fbmT(u * 4, v * 4, 4, 4, 4, 0.6, S + 97));
  const sup = field(size, 4, (u, v) => fbmT(u * 5 + 2, v * 5, 5, 5, 5, 0.55, S + 139));
  const run = field(size, 2, (u, v) => streakT(u, v, 44, 5, S + 167));
  const det = detailField(c, S + 181);
  const flk = fleckField(c, S + 199);
  /* MACRO ZONE — two cells across the tile, i.e. ~0.8 m of wall.
     Everything above is block-scale or finer, which is why a wall of this stone
     read as one evenly-noisy surface however far back you stood: there was no
     signal at a scale LARGER than a single block. This is that signal, and it is
     coupled — the same mask darkens albedo, raises roughness and feeds the grime
     supply, which is the combination the eye reads as weathering rather than as
     a colour wash. */
  const macro = field(size, 8, (u, v) => fbmT(u * 2, v * 2, 2, 2, 3, 0.6, S + 211));
  const macroB = field(size, 8, (u, v) => fbmT(u * 3 + 5, v * 3, 3, 3, 3, 0.55, S + 223));

  // per-block character, tabulated once: dressed height, tone, weathering
  const NB = COLS * ROWS;
  const bHt = new Float32Array(NB), bTn = new Float32Array(NB), bWt = new Float32Array(NB);
  for (let r = 0; r < ROWS; r++) {
    for (let q = 0; q < COLS; q++) {
      const k = r * COLS + q;
      bHt[k] = hash2(q + 1, r + 1, S + 61) * 2 - 1;
      bTn[k] = hash2(q + 3, r + 7, S + 5) * 2 - 1;
      bWt[k] = hash2(q + 5, r + 2, S + 131);
    }
  }

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const v0 = (y + 0.5) * inv;
    for (let x = 0; x < size; x++, i++) {
      const u0 = (x + 0.5) * inv;
      const u = u0 + wu[i] * 0.019;
      const v = v0 + wv[i] * 0.013;

      const fv = v * ROWS;
      let ry = Math.floor(fv);
      const ty = fv - ry;
      ry = ((ry % ROWS) + ROWS) % ROWS;
      const fu = u * COLS + (ry & 1 ? 0.5 : 0);
      let rx = Math.floor(fu);
      const tx = fu - rx;
      rx = ((rx % COLS) + COLS) % COLS;

      const bk = ry * COLS + rx;
      const bH = bHt[bk], bT = bTn[bk], bW = bWt[bk];

      // joint distance, normalised so horizontal and vertical joints read the
      // same absolute width despite the block aspect ratio
      const dU = (tx < 1 - tx ? tx : 1 - tx) / 0.055;
      const dV = (ty < 1 - ty ? ty : 1 - ty) / 0.085;
      let d = (dU < dV ? dU : dV) - (chip[i] - 0.45) * 1.7;
      const mortar = 1 - smoothstep(0, 1, d);
      const bevel = 1 - smoothstep(0.5, 3.4, d);

      const pitting = (1 - pit[i]) * smoothstep(0.34, 0.7, alg[i] * 0.6 + bW * 0.4);
      /* Spall: a knocked-off corner. Confined to the arris band (inside the
         bevel, outside the mortar) and gated on a per-texel chip lottery, so it
         appears as a handful of bright broken notches per block rather than as a
         continuous pale outline round every stone. */
      const arris = bevel * (1 - mortar);
      const spall = clamp01(arris * smoothstep(0.50, 0.86, chip[i]) * 1.5
        * (0.45 + 0.75 * bW));

      let hh = 0.62 + bH * 0.055
        - mortar * 0.105
        - bevel * 0.024
        - pitting * 0.05
        - spall * 0.026
        + (det[i] - 0.5) * 0.015
        + (flk[i] - 0.5) * 0.004;

      // granite mineralogy: quartz flecks catch light, biotite goes near black.
      // The fleck highlight is deliberately modest: at 1.6 mm per texel a strong
      // one survives anisotropic filtering as white sugar sprinkled over the
      // whole surface, which is most of what made these slabs read as near-white.
      const q = flk[i] * 0.6 + det[i] * 0.4;
      const quartz = smoothstep(0.74, 0.96, q);
      const biotite = smoothstep(0.3, 0.07, q);
      // Macro zone: sun-bleached dry stone through dark damp-shaded stone.
      // Gain is set against the field's measured spread (sd ~0.05), not guessed —
      // a (v - 0.5) * 2.5 mask tops out near 0.12 and is invisible in the frame.
      const mz = macro[i] * 0.68 + macroB[i] * 0.32;
      const bleach = clamp01((mz - 0.516) * 8.0);
      const shade = clamp01((0.498 - mz) * 8.0);
      const base = (0.25 + bT * 0.085 + (alg[i] - 0.5) * 0.06)
        * (1.0 + bleach * 0.22 - shade * 0.30);
      let r = base * 1.04 + quartz * 0.19 - biotite * 0.1;
      let g = base * 1.0 + quartz * 0.185 - biotite * 0.098;
      let b = base * 0.955 + quartz * 0.175 - biotite * 0.075;
      // damp-shaded zones are cooler; bleached zones warmer
      r *= 1.0 + bleach * 0.03 - shade * 0.04;
      b *= 1.0 - bleach * 0.04 + shade * 0.06;
      let rough = 0.8 - quartz * 0.16 + biotite * 0.05 + (det[i] - 0.5) * 0.11
        + bleach * 0.09 - shade * 0.10;

      if (mortar > 0.002) {
        const mc = 0.2 + (chip[i] - 0.5) * 0.075;
        r += (mc * 1.04 - r) * mortar;
        g += (mc * 0.99 - g) * mortar;
        b += (mc * 0.88 - b) * mortar;
        rough += (0.95 - rough) * mortar;
      }

      // damp bleeding down from the bed joint: darker, greener, and smoother
      const dm = clamp01(smoothstep(0.5, 0.87, alg[i]) * smoothstep(0.42, 0.82, run[i])
        * Math.exp(-ty * 2.6) * (0.4 + 0.6 * bW) * 1.5);
      if (dm > 0.002) {
        r *= 1 - 0.55 * dm;
        g *= 1 - 0.44 * dm;
        b *= 1 - 0.52 * dm;
        g += 0.014 * dm;
        rough += (0.28 - rough) * dm * 0.85;
        hh -= dm * 0.004;
      }

      c.h[i] = hh;
      c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
      c.rg[i] = rough;
      c.mt[i] = 0;
      // fresh fracture on the knocked corners — see the note on P.wearAmount
      c.wr[i] = spall;
      // grime supply follows the same macro zone, so dirt, darkening, roughness
      // and occlusion all agree instead of each doing its own thing
      c.gm[i] = clamp01(((sup[i] - 0.33) * 2.1) * 0.85 * (0.55 + 1.05 * shade)
        + mortar * 0.45 + pitting * 0.3 + shade * 0.22);
    }
  }
}

/* ================================================================ COBBLE */
/** Irregular worley setts, polished crowns, mud-choked joints. */
export function genCobble(c) {
  const size = c.size, S = c.seed, P = c.params;
  /* 1.35 was the strongest normal in the library, on the one surface that fills
     the bottom half of every interior frame. Combined with a domed crown on
     every sett it gave the floor a continuous field of curved highlights — and
     once the render pipeline's wetness/SSR term reads that normal, a floor of
     curved metallic-looking lozenges is exactly what you get. Laid setts are
     flat on top; the structure belongs in the joints. */
  P.normalStrength = 1.05;
  P.aoStrength = 1.1; P.cavity1 = 1.0; P.cavity2 = 1.45;
  P.grimeAmount = 0.95; P.grimeColor = [0.105, 0.088, 0.062]; P.grimeRough = 0.96;
  // Setts never polish to a gloss — see the note on the crown polish below.
  P.roughMin = 0.28; P.displacement = 0.1;

  const F = 9;
  // one cellular pass, four derived layers — worley is the expensive call
  const [dome, tone, crown, cRough] = fieldN(size, 2, 4, (u, v, out) => {
    // heavier warp + per-cell size jitter so the setts read as laid stones,
    // not as a cracked-mud voronoi
    warpT(u * 5, v * 5, 5, 5, S + 3, 0.9, 4);
    const wu = WP.x / 5, wv = WP.y / 5;
    worleyT(wu * F, wv * F, F, F, S + 17);
    const e = WK.edge, f1 = WK.f1;
    const sz = 0.6 + hash2(WK.cx, WK.cy, S + 59) * 0.85;
    out[0] = smoothstep(0.0, 0.30 * sz, e);
    out[1] = hash2(WK.cx, WK.cy, S + 41);
    out[2] = 1 - smoothstep(0.04, 0.34 * sz, f1);
    out[3] = hash2(WK.cx, WK.cy, S + 83);
  });
  const mudDepth = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 4, 0.6, S + 101));
  const wet = field(size, 4, (u, v) => fbmT(u * 4 + 7, v * 4, 4, 4, 4, 0.55, S + 113));
  const grit = field(size, 2, (u, v) => worleyT4(u * 90, v * 90, 90, 90, S + 149));
  const det = detailField(c, S + 173);
  const flk = fleckField(c, S + 191);
  /* MACRO ZONE — 1.7 cells across the tile: at the crypt floor's 2.05 m tile
     that is a 1.2 m patch, i.e. a *region* of floor rather than a sett or a
     joint. Without it the floor was one repeating cell pattern at one value from
     wall to wall, and with a bright polished crown on every sett it read as
     crumpled foil. Trodden lanes go dark, smooth and grimy TOGETHER; the
     untrodden ground stays dry, pale and rough. */
  const macro = field(size, 8, (u, v) => fbmT(u * 1.7, v * 1.7, 1.7, 1.7, 3, 0.62, S + 209));
  const macroB = field(size, 8, (u, v) => {
    warpT(u * 2.4, v * 2.4, 2.4, 2.4, S + 227, 0.7, 2);
    return fbmT(WP.x, WP.y, 2.4, 2.4, 3, 0.55, S + 233);
  });

  for (let i = 0; i < size * size; i++) {
    const dm = dome[i];
    const t = tone[i];
    const cr = crown[i];
    /* Trodden (dark, smooth, grimy) vs untrodden (pale, dry, rough).
       A normalised fbm is heavily concentrated: measured mean 0.506, sd 0.048.
       Thresholding it at (v - 0.5) * 2.5 — the obvious thing to write — yields a
       mask that never exceeds 0.12, which is why "macro variation" that existed
       in the code did not exist in the pixels. The 9.0 gain is 0.43/sd, so each
       zone genuinely covers about a third of the surface. */
    const mz = macro[i] * 0.62 + macroB[i] * 0.38;
    const trod = clamp01((mz - 0.508) * 7.5);
    const dry = clamp01((0.498 - mz) * 7.5);

    /* Stone body. `dome` is the distance-to-joint field; raising it to 0.42 made
       the whole sett a smooth dome. A laid sett is a flat-ish face with a small
       arris roll at its edge, so the profile rises fast out of the joint and
       then PLATEAUS — which is what puts the relief in the joint lines where it
       belongs and leaves the trodden face flat enough to read as stone. */
    const body = smoothstep(0.0, 0.42, dm) * 0.86 + Math.pow(dm, 0.42) * 0.14;
    const mud = clamp01((1 - dm) * (0.55 + 1.1 * mudDepth[i]));
    const wornTop = clamp01(cr * body) * (0.35 + 0.65 * cRough[i]);

    let hh = 0.38 + body * 0.2 - mud * 0.075
      + (det[i] - 0.5) * 0.012 * (0.4 + 0.6 * body)
      + (flk[i] - 0.5) * 0.005
      - (1 - smoothstep(0.08, 0.5, grit[i])) * 0.01 * (1 - body);

    // per-sett colour: cold granite through warm sandstone. The macro zone
    // shifts the whole patch, so neighbouring regions of floor differ in value
    // and hue rather than only sett-by-sett.
    const warm = t;
    /* The zone amplitude is large on purpose. A floor fills the bottom half of
       every interior frame, so it is the surface the tonemapper's shoulder
       compresses hardest: a ±10 % patch difference lands inside the shoulder and
       resolves to one flat value. ±40 % survives it, and it is what puts real
       dark ground next to real pale ground instead of one sheet. */
    let r = (0.150 + warm * 0.180) * (1.0 + dry * 0.18 - trod * 0.42);
    let g = (0.147 + warm * 0.146) * (1.0 + dry * 0.17 - trod * 0.44);
    let b = (0.147 + warm * 0.102) * (1.0 + dry * 0.13 - trod * 0.47);
    const spk = flk[i] * 0.55 + det[i] * 0.45;
    const fleckL = smoothstep(0.78, 0.97, spk) * 0.10;
    r += fleckL; g += fleckL * 0.98; b += fleckL * 0.95;
    let rough = 0.86 + (det[i] - 0.5) * 0.1 - fleckL * 0.5 + dry * 0.07;

    /* Crowns polished by boots and cart wheels.
       This used to lift the crown to 1.3x albedo + 0.045 and drop roughness to
       0.42, which put a bright, broad specular lobe on the top of every single
       sett. Over a whole floor that is not "worn stone", it is beaten metal —
       the crumpled-foil read. Wear on stone mostly SMOOTHS and slightly
       darkens: the polish shows as a tighter highlight, not as pale paint. */
    const polish = wornTop * (0.35 + 0.65 * trod);
    r += (r * 1.06 + 0.010 - r) * polish;
    g += (g * 1.06 + 0.010 - g) * polish;
    b += (b * 1.06 + 0.012 - b) * polish;
    rough += (0.58 - rough) * polish * 0.85;

    // mud in the joints — deeper in the trodden zones
    if (mud > 0.002) {
      const md = clamp01(mud * (0.75 + 0.5 * trod));
      const mr = 0.105 + (det[i] - 0.5) * 0.05;
      r += (mr * 1.0 - r) * md;
      g += (mr * 0.82 - g) * md;
      b += (mr * 0.6 - b) * md;
      rough += (0.97 - rough) * md;
    }

    // standing water darkens and smooths — pooled in the low joints
    const wt = clamp01(smoothstep(0.55, 0.85, wet[i]) * (1 - dm) * 1.6);
    if (wt > 0.002) {
      r *= 1 - 0.5 * wt; g *= 1 - 0.48 * wt; b *= 1 - 0.42 * wt;
      rough += (0.14 - rough) * wt;
    }

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    // one mask, three couplings: grime supply rises with the trodden zone, which
    // finalize() then weights by measured cavity into albedo + roughness + AO
    c.gm[i] = clamp01((0.30 + mudDepth[i] * 0.75 + trod * 0.55) * (1 - polish * 0.55));
  }
}

/* ================================================================== WOOD */
/** Split planks: ring structure, iron-nail tannin staining, rot at the ends. */
export function genWood(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.95;
  P.aoStrength = 0.95; P.cavity1 = 1.2; P.cavity2 = 1.1;
  P.grimeAmount = 0.7; P.grimeColor = [0.1, 0.083, 0.058]; P.grimeRough = 0.95;
  P.roughMin = 0.24; P.displacement = 0.05;

  const B = 4; // planks across the tile
  // Cathedral figure: the ring spacing has to breathe along the board or the
  // grain reads as corrugated iron.
  const meander = field(size, 4, (u, v) => fbmT(u * 8, v * 3, 8, 3, 4, 0.5, S + 13) - 0.5);
  const swirl = field(size, 4, (u, v) => fbmT(u * 3, v * 6, 3, 6, 3, 0.5, S + 31) - 0.5);
  const spacing = field(size, 4, (u, v) => fbmT(u * 2, v * 4, 2, 4, 3, 0.5, S + 17));
  const rotF = field(size, 4, (u, v) => fbmT(u * 5, v * 5, 5, 5, 5, 0.6, S + 59));
  const wthr = field(size, 4, (u, v) => fbmT(u * 3 + 5, v * 3, 3, 3, 4, 0.55, S + 79));
  const fibre = field(size, 2, (u, v) => anisoT(u, v, 1, 0, 0, 1, 5, 150, S + 103, 3));
  const det = detailField(c, S + 127);
  const flk = fleckField(c, S + 151);

  const pith = new Float32Array(B), rscale = new Float32Array(B),
    ptone = new Float32Array(B), poff = new Float32Array(B),
    pend = new Float32Array(B), pcup = new Float32Array(B);
  for (let k = 0; k < B; k++) {
    pith[k] = -0.9 + hash2(k + 1, 3, S + 211) * 2.6;
    rscale[k] = 7 + hash2(k + 2, 9, S + 223) * 9;
    ptone[k] = hash2(k + 4, 5, S + 227) * 2 - 1;
    poff[k] = hash2(k + 6, 8, S + 229);
    pend[k] = hash2(k + 7, 2, S + 233);
    pcup[k] = hash2(k + 9, 4, S + 239) * 2 - 1;
  }

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const fv = v * B;
    let rb = Math.floor(fv);
    const tv = fv - rb;
    rb = ((rb % B) + B) % B;
    for (let x = 0; x < size; x++, i++) {
      const u = (x + 0.5) * inv;

      // plank edges: a deep dark gap, planks slightly cupped
      const edgeV = (tv < 1 - tv ? tv : 1 - tv) / 0.05;
      const gap = 1 - smoothstep(0, 1, edgeV - (det[i] - 0.5) * 0.6);
      // butt joint across the plank, one per plank, offset per plank
      const lu = frac(u + poff[rb]);
      const dEnd = (lu < 1 - lu ? lu : 1 - lu) / 0.035;
      const butt = 1 - smoothstep(0, 1, dEnd - (det[i] - 0.5) * 0.5);

      // annual rings around an off-board pith, meandering along the length
      const across = tv - pith[rb];
      const ring = Math.abs(across) * rscale[rb] * (0.72 + 0.56 * spacing[i])
        + meander[i] * 1.6 + swirl[i] * 0.7;
      const late = Math.pow(0.5 - 0.5 * Math.cos(TAU * ring), 4.5);
      const fib = (fibre[i] - 0.5);

      // rot: at the exposed end grain and in low-lying blotches
      const rot = clamp01((smoothstep(0.58, 0.9, rotF[i]) * 0.75
        + smoothstep(1.6, 0.2, dEnd) * 0.55 * smoothstep(0.4, 0.75, rotF[i])) * 1.25);

      // hand-forged nails, two per plank near the butt joint
      let nail = 0, stain = 0;
      for (let k = 0; k < 2; k++) {
        const nu = frac(poff[rb] + (k ? 0.52 : 0.02) + 0.06);
        let du = u - nu;
        du -= Math.round(du);
        const dv = tv - (k ? 0.72 : 0.28);
        const dn = Math.sqrt(du * du + dv * dv);
        nail = Math.max(nail, smoothstep(0.016, 0.009, dn));
        stain = Math.max(stain, smoothstep(0.075, 0.014, dn) * (0.55 + 0.45 * det[i]));
      }

      const weather = smoothstep(0.35, 0.8, wthr[i]);

      let hh = 0.6 + pcup[rb] * (tv - 0.5) * 0.03
        - gap * 0.1 - butt * 0.055
        + late * 0.007
        + fib * 0.016
        + (det[i] - 0.5) * 0.011
        + (flk[i] - 0.5) * 0.0035
        - rot * 0.028 * (0.4 + 0.6 * det[i])
        - nail * 0.014;

      // colour: warm-but-greyed heartwood → silvered weathered surface
      const tone = 0.5 + ptone[rb] * 0.5;
      let r = lerp(0.215, 0.295, tone) * (0.78 + 0.42 * (1 - late)) + fib * 0.04;
      let g = lerp(0.152, 0.208, tone) * (0.8 + 0.4 * (1 - late)) + fib * 0.031;
      let b = lerp(0.098, 0.132, tone) * (0.84 + 0.34 * (1 - late)) + fib * 0.021;
      let rough = 0.72 + late * 0.12 - fib * 0.06 + (det[i] - 0.5) * 0.1;
      let metal = 0;

      // silvered weathering: UV-bleached, fibrous, matte
      const wgrey = weather * 0.55;
      r += (0.238 - r) * wgrey;
      g += (0.222 - g) * wgrey;
      b += (0.196 - b) * wgrey;
      rough += (0.93 - rough) * wgrey;

      // rot goes green-black and very matte
      if (rot > 0.002) {
        r += (0.052 - r) * rot;
        g += (0.055 - g) * rot;
        b += (0.04 - b) * rot;
        rough += (0.97 - rough) * rot;
      }

      // tannin bleed around iron: blue-black halo
      if (stain > 0.002) {
        const st = stain * 0.85;
        r += (0.045 - r) * st;
        g += (0.043 - g) * st;
        b += (0.05 - b) * st;
        rough += (0.9 - rough) * st * 0.6;
      }
      // the nail head itself
      if (nail > 0.002) {
        r += (0.28 - r) * nail;
        g += (0.27 - g) * nail;
        b += (0.265 - b) * nail;
        rough += (0.52 - rough) * nail;
        metal = nail;
      }

      // plank gaps read as darkness, not as paint
      const dark = Math.max(gap, butt * 0.8);
      r *= 1 - 0.72 * dark; g *= 1 - 0.72 * dark; b *= 1 - 0.72 * dark;
      rough += (0.96 - rough) * dark;

      c.h[i] = hh;
      c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
      c.rg[i] = rough;
      c.mt[i] = metal;
      c.gm[i] = clamp01(0.3 + rotF[i] * 0.7) * (1 - nail * 0.8) + dark * 0.4;
    }
  }
}

/* ================================================================= METAL */
/**
 * Forged iron, in four declared tiers (see KIND_TIERS).
 *
 *  T0  mill-scale zones — a 2-cycle band carried mainly in ROUGHNESS, because on
 *      a metal the albedo map is specular F0 and a big value swing there reads as
 *      two metals welded together. This is the only tier that still exists once
 *      the plate is 60 px tall. See macroField().
 *  T1  hammer planishing — FACETS with arrises, not dimples. The distinction is
 *      the whole difference between "struck metal" and "bubble wrap": a smith's
 *      hammer leaves a shallow flat facet bounded by a crisp ridge, so the
 *      highlight breaks along LINES. A pure `(k - f1)` dish profile gives every
 *      cell a smooth dome, and a field of domes under one key light is exactly
 *      the round dimpled read the art director named.
 *  T2  wear that follows the form — the arrises polish back to bright steel
 *      (via the shared `wr` supply, gated on measured proudness), while rust
 *      and grime sink into the facet troughs and pits.
 *  T3  drawn/abrasive grain at the texel scale, carried in roughness so it
 *      averages into a smooth anisotropic sheen under minification instead of
 *      aliasing into sparkle.
 */
export function genMetal(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.85;
  P.aoStrength = 0.8; P.cavity1 = 1.0; P.cavity2 = 0.95;
  P.grimeAmount = 0.55; P.grimeColor = [0.075, 0.066, 0.055]; P.grimeRough = 0.9;
  P.grimeMetalKill = 0.85; P.roughMin = 0.1; P.displacement = 0.035;
  // Tier 2: bright steel on the arrises. Iron's polished F0 is 0.56 linear.
  P.wearAmount = 0.92; P.wearColor = [0.80, 0.805, 0.83];
  P.wearRough = 0.19; P.wearMetal = 1.0; P.wearScale = 22; P.wearProud = 1.0;

  // T1 — 13 x 11 facets per repeat, near-square so the cells read as struck
  // rather than as stretched marbling, and warped only lightly for the same
  // reason. `edge` is the arris; `f1` is the distance field inside the facet.
  const F = 13, FY = 11;
  const [facet, fRand, arris] = fieldN(size, 2, 3, (u, v, out) => {
    warpT(u * 5, v * 5, 5, 5, S + 5, 0.16, 3);
    worleyT((WP.x / 5) * F, (WP.y / 5) * FY, F, FY, S + 23);
    out[0] = WK.f1;
    out[1] = hash2(WK.cx, WK.cy, S + 47);
    // 1 at the cell wall, 0 in the middle — the ridge the hammer leaves standing
    out[2] = 1 - smoothstep(0.0, 0.16, WK.edge);
  });
  /* T1b — forging passes: a 3-cycle banded value structure, i.e. one band per
     third of the repeat. Without a signal LARGER than a facet, a sheet of this
     metal is one evenly-faceted field however far back you stand. */
  const forge = field(size, 8, (u, v) => fbmT(u * 3, v * 2, 3, 2, 3, 0.6, S + 29));
  const rustF = field(size, 4, (u, v) => {
    warpT(u * 5, v * 5, 5, 5, S + 61, 0.75, 4);
    return fbmT(WP.x, WP.y, 5, 5, 5, 0.55, S + 67);
  });
  const RP = fineF(size, 64);
  const rustPit = field(size, 2, (u, v) => worleyT4(u * RP, v * RP, RP, RP, S + 71));
  const scrA = field(size, 2, (u, v) => anisoT(u, v, 3, 1, -1, 3, 2, fineF(size, 96), S + 89, 3));
  const scrB = field(size, 2, (u, v) => anisoT(u, v, 1, -2, 2, 1, 3, fineF(size, 70), S + 97, 3));
  const det = detailField(c, S + 109);
  const flk = fleckField(c, S + 113);
  const mac = macroField(c, S + 613, 2);

  for (let i = 0; i < size * size; i++) {
    const f1 = facet[i];
    const fr = fRand[i];
    const ar = arris[i];

    /* Faceted profile. Three terms and each one earns its place:
         plane   a per-facet height offset, so neighbouring facets sit at
                 slightly different levels the way beaten sheet actually does;
         flat    smoothstep, NOT a linear ramp — it rises out of the wall and
                 then plateaus, which is what leaves a flat facet face;
         ridge   the standing arris, a narrow positive line at the cell wall. */
    const plane = (fr - 0.5) * 0.020;
    const flat = smoothstep(0.02, 0.30, f1) * 0.030;
    const ridge = ar * 0.013;
    const plate = plane + flat + ridge - 0.016;
    const scratch = Math.pow(clamp01(1 - Math.abs(scrA[i] - 0.5) * 5.5), 3) * 0.7
      + Math.pow(clamp01(1 - Math.abs(scrB[i] - 0.5) * 6.5), 3) * 0.45;

    let hh = 0.6 + plate
      + (det[i] - 0.5) * 0.014 + (flk[i] - 0.5) * 0.004;

    const rust = clamp01((smoothstep(0.52, 0.68, rustF[i]) * 1.15
      + smoothstep(0.66, 0.86, rustF[i]) * 0.4));
    const rustDeep = smoothstep(0.72, 0.95, rustF[i]);
    const pitting = (1 - smoothstep(0.06, 0.36, rustPit[i])) * rustDeep;
    hh += rust * 0.012 - pitting * 0.03;

    // aged wrought iron F0, banded by the forging passes so the sheet has
    // mid-tone structure at a scale larger than one facet
    const band = (forge[i] - 0.5);
    let base = 0.48 + band * 0.13 + (fr - 0.5) * 0.06 + (det[i] - 0.5) * 0.05;
    let r = base * 0.99, g = base * 0.995, b = base * 1.02;
    // T3 — abrasion lives in roughness, where it is an anisotropic sheen and
    // cannot draw a pattern the light does not put there.
    let rough = 0.68 + band * 0.10 + (det[i] - 0.5) * 0.18
      - scratch * 0.20 - ar * 0.10;
    let metal = 1;

    if (rust > 0.002) {
      // iron oxide is a rough dielectric — killing metalness is what sells it
      const rr = 0.30 + (det[i] - 0.5) * 0.09 + (flk[i] - 0.5) * 0.05;
      r += (rr - r) * rust;
      g += (rr * 0.53 - g) * rust;
      b += (rr * 0.26 - b) * rust;
      rough += (0.94 - rough) * rust;
      metal *= 1 - 0.94 * rust;
      const deep = rustDeep * 0.8 + pitting * 0.6;
      r *= 1 - 0.42 * deep; g *= 1 - 0.46 * deep; b *= 1 - 0.5 * deep;
    }

    /* TIER 0 — see macroField(). On a metal the albedo map is specular F0, so the
       macro band is deliberately weighted into ROUGHNESS rather than into value:
       a big swing in F0 reads as two different metals welded together, whereas a
       big swing in roughness reads as one plate where the mill scale is intact in
       some zones and has been scoured off in others — which is what a 200-year-old
       crypt gate looks like. The albedo term is a third of the roughness term and
       is there only to keep the scaled zones from reading as a pure gloss change.
       Metalness comes down slightly in the dull zones because scale is an oxide,
       i.e. a dielectric, which is the same coupling the rust branch above uses.

       Metal is the one kind whose albedo gain is NOT raised to the hero's 0.20-0.26
       band, and that is on purpose: iron's map already measured 0.26 relative
       contrast at the working mip before this tier existed — it was never one of
       the flat kinds — and on a conductor the map is F0, where a 20 % swing is a
       different alloy. The roughness gain is where the extra macro contrast goes,
       because a roughness break-up is what makes a plate read as struck metal at
       60 px without touching its colour at all. */
    const M = mac[i];
    const dull = M < 0 ? -M : 0;
    r *= macroMul(M, 0.42);
    g *= macroMul(M, 0.42);
    b *= macroMul(M, 0.45);
    rough -= M * 0.46;
    metal *= 1 - 0.40 * dull;

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = metal;
    /* Wear supply: the arrises and the scratch lines are what a sleeve, a strap
       or a scabbard actually touches. Rust blocks it — you cannot polish an
       oxide layer back to steel, it flakes — so the two tier-2 channels are
       mutually exclusive by construction rather than by luck. */
    c.wr[i] = clamp01((ar * 0.86 + scratch * 0.52) * (1 - rust) * (0.55 + 0.7 * fr));
    c.gm[i] = clamp01(0.35 + rustF[i] * 0.55 - M * 0.9);
  }
}

/* ================================================================= PLATE */
/**
 * ARMOUR PLATE — lamed, riveted, pitted iron.
 *
 * ADDITIVE: a new kind, not a change to `metal`. Nothing that asks for `metal`
 * gets anything different than it did before.
 *
 * Why a separate kind rather than reusing `metal`. `genMetal` is *sheet* iron:
 * its largest declared structure is a 13x11 hammer-facet field, i.e. 29 mm
 * features at its 0.38 m repeat. That is correct for a gate, a blade or a
 * bracket, and it is exactly wrong for a body-sized piece of armour, because at
 * the isometric camera a 29 mm feature on a character is sub-pixel and the sheet
 * collapses to its mean. MEASURED on the `boss` capture: the warden's torso
 * carried a post-downsample neighbourhood deviation of 0.041 against the hero
 * cuirass's 0.049, and its head 0.018 — a flat colour by any measure.
 *
 * Armour has a structural tier that raw sheet does not: it is built from
 * OVERLAPPING LAMES. That gives a ~3-cycle banded relief — 110 mm bands at this
 * kind's 0.34 m repeat — which is the only band that survives minification onto
 * a character (see macroField() for the measurements that established that), and
 * it comes with the two features the rubric asks a metal to show, already in the
 * right places rather than sprinkled by noise:
 *
 *   the rolled lip of each lame stands PROUD  → polishes to bright steel
 *   the lap seam under the next lame is SUNK  → holds tarnish, roughens, occludes
 *
 * finalize() drives tier 2 from measured proudness (`wr`) and measured cavity
 * (`gm`) off this kind's own height field, so that coupling is structural: the
 * bright wear cannot land anywhere but on a lip or a rivet dome, and the tarnish
 * cannot land anywhere but in a lap or a pit.
 */
export function genPlate(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 1.0;
  P.aoStrength = 0.92; P.cavity1 = 1.0; P.cavity2 = 1.1;
  P.grimeAmount = 0.66; P.grimeColor = [0.055, 0.048, 0.042]; P.grimeRough = 0.94;
  P.grimeMetalKill = 0.9; P.roughMin = 0.11; P.displacement = 0.042;
  // Tier 2: bare steel under the finish. Iron's polished F0 is 0.56 linear.
  P.wearAmount = 0.95; P.wearColor = [0.82, 0.825, 0.85];
  P.wearRough = 0.17; P.wearMetal = 1.0;
  /* The crests that take the wear here are rivet domes (~60 texels at 1024) and
     lame lips, not the 340-texel lame band itself, so the wear blur is set to
     the rivet scale. Keyed to the band instead, every lame face would lift as a
     whole and the plate would read as polished, not as worn. */
  P.wearScale = 40; P.wearProud = 1.0; P.wearGate = [0.34, 0.95];

  const LAMES = 3;   // T1  — lames per repeat: 113 mm bands at a 0.34 m repeat.
  const RIVETS = 6;  // T1b — rivets across one repeat: ~57 mm pitch.
  const RR = 0.030;  // rivet head radius in repeat units, i.e. ~20 mm domes.

  /* The lame boundary is warped by a low-frequency tileable band. A perfectly
     straight horizontal break across the tile is the classic "you can see the
     UV grid" tell, and it is an instant-fail of its own. */
  const warp = field(size, 4, (u, v) => fbmT(u * 3, v * 2, 3, 2, 2, 0.5, S + 31) - 0.5);
  /* Corrosion field: warped so the oxide creeps in fingers rather than blobs. */
  const corrF = field(size, 4, (u, v) => {
    warpT(u * 4, v * 4, 4, 4, S + 61, 0.8, 4);
    return fbmT(WP.x, WP.y, 4, 4, 5, 0.55, S + 67);
  });
  const PP = fineF(size, 72);
  const pitF = field(size, 2, (u, v) => worleyT4(u * PP, v * PP, PP, PP, S + 73));
  // T3 — two crossed abrasion directions; lives mostly in roughness.
  const scrA = field(size, 2, (u, v) => anisoT(u, v, 4, 1, -1, 4, 2, fineF(size, 88), S + 89, 3));
  const scrB = field(size, 2, (u, v) => anisoT(u, v, 1, -3, 3, 1, 3, fineF(size, 64), S + 97, 3));
  const det = detailField(c, S + 103);
  const flk = fleckField(c, S + 107);
  const mac = macroField(c, S + 617, 2);

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const v0 = (y + 0.5) * inv;
    for (let x = 0; x < size; x++, i++) {
      const u0 = (x + 0.5) * inv;
      const vw = v0 + warp[i] * 0.055;

      /* --- T1: which lame are we on, and where in it --- */
      const lf = vw * LAMES;
      let li = Math.floor(lf);
      const lt = lf - li;                       // 0 at the lap, 1 at the top edge
      li = ((li % LAMES) + LAMES) % LAMES;      // wrap so the tile still tiles
      const lr = hash2(li, 17, S + 11);         // per-lame value / bow variation

      /* Profile of one lame, read bottom to top. The lower edge laps OVER the
         lame beneath it, so it is a rolled lip standing proud; the face then
         recedes as it runs up; the top disappears under the NEXT lame's lip,
         which is a hard cavity. Two smoothsteps rather than a triangle wave,
         because a lame's lip is rolled and its lap line is not. */
      const lip = smoothstep(0.00, 0.055, lt) * (1 - smoothstep(0.075, 0.26, lt));
      const lap = smoothstep(0.87, 1.00, lt);
      // Slight convex bow across the face — plate is dished, not flat.
      const bow = Math.sin(lt * Math.PI) * 0.010 * (0.6 + lr * 0.8);

      /* --- T1b: rivet domes, in a row just above each lap --- */
      const ru = u0 * RIVETS;
      const rix = Math.floor(ru);
      const du = (ru - rix - 0.5) / RIVETS;
      const dv = vw - (Math.floor(lf) + 0.155) / LAMES;
      const rd = Math.sqrt(du * du + dv * dv);
      // A few rivets are simply gone. A perfect row reads as a decal.
      const present = hash2(((rix % RIVETS) + RIVETS) % RIVETS, li, S + 19) > 0.09 ? 1 : 0;
      const rq = rd / RR;
      const dome = present && rq < 1 ? Math.sqrt(1 - rq * rq) : 0;

      const scratch = Math.pow(clamp01(1 - Math.abs(scrA[i] - 0.5) * 5.0), 3) * 0.72
        + Math.pow(clamp01(1 - Math.abs(scrB[i] - 0.5) * 6.2), 3) * 0.46;

      /* --- corrosion, and the pitting it eats into the face --- */
      const corr = clamp01(smoothstep(0.50, 0.66, corrF[i]) * 1.1
        + smoothstep(0.68, 0.88, corrF[i]) * 0.45
        + lap * 0.30);                       // laps stay damp, so they go first
      const corrDeep = smoothstep(0.70, 0.94, corrF[i]);
      const pit = (1 - smoothstep(0.04, 0.30, pitF[i])) * (corrDeep * 0.8 + 0.2);

      let hh = 0.56 + lip * 0.048 + bow + dome * 0.028 - lap * 0.062
        + (lr - 0.5) * 0.012 + corr * 0.008 - pit * 0.034
        + (det[i] - 0.5) * 0.013 + (flk[i] - 0.5) * 0.004;

      /* Aged wrought iron F0, banded per lame so the plate has a value break at
         the structural scale and not only at the noise scale. */
      let base = 0.47 + (lr - 0.5) * 0.10 + (det[i] - 0.5) * 0.05 - lap * 0.05;
      let r = base * 0.98, g = base * 0.99, b = base * 1.03;
      let rough = 0.66 + (lr - 0.5) * 0.10 + (det[i] - 0.5) * 0.17
        - scratch * 0.19 - lip * 0.12 - dome * 0.14 + lap * 0.10;
      let metal = 1;

      if (corr > 0.002) {
        // Oxide is a rough dielectric: pulling metalness down is what sells it.
        const rr = 0.29 + (det[i] - 0.5) * 0.09 + (flk[i] - 0.5) * 0.05;
        r += (rr - r) * corr;
        g += (rr * 0.55 - g) * corr;
        b += (rr * 0.30 - b) * corr;
        rough += (0.95 - rough) * corr;
        metal *= 1 - 0.95 * corr;
        const deep = corrDeep * 0.8 + pit * 0.65;
        r *= 1 - 0.44 * deep; g *= 1 - 0.48 * deep; b *= 1 - 0.52 * deep;
      }

      /* TIER 0 — as in genMetal, the macro band is weighted into ROUGHNESS
         rather than value, because on a conductor the albedo map is F0 and a
         large swing in F0 reads as two alloys welded together. */
      const M = mac[i];
      const dull = M < 0 ? -M : 0;
      r *= macroMul(M, 0.40);
      g *= macroMul(M, 0.40);
      b *= macroMul(M, 0.43);
      rough -= M * 0.44;
      metal *= 1 - 0.42 * dull;

      c.h[i] = hh;
      c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
      c.rg[i] = rough;
      c.mt[i] = metal;
      /* Wear supply: lame lips, rivet crowns and abrasion tracks — the three
         places a strap, a wall or another man's weapon actually touches.
         Corrosion blocks it, because an oxide flakes instead of polishing. */
      c.wr[i] = clamp01((lip * 0.80 + dome * 0.95 + scratch * 0.45)
        * (1 - corr) * (0.55 + 0.7 * lr));
      /* Grime supply: the lap line first, then the corroded zones. */
      c.gm[i] = clamp01(0.26 + lap * 0.52 + corrF[i] * 0.45 - M * 0.85);
    }
  }
}

/* ================================================================== GOLD */
/** Soft polished gold: engraved filigree, tarnish sunk into the cavities. */
export function genGold(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.85;
  P.aoStrength = 0.8; P.cavity1 = 1.3; P.cavity2 = 0.9;
  P.grimeAmount = 0.62; P.grimeColor = [0.115, 0.088, 0.045]; P.grimeRough = 0.72;
  P.grimeMetalKill = 0.4; P.roughMin = 0.06; P.displacement = 0.03;

  /**
   * Engraved filigree. Built from three legible elements rather than one
   * scribble: a diagonal interlace band, a rosette with radiating petals on a
   * 2x2 panel grid, and a border rule around each panel. Everything is driven
   * by integer-frequency trigonometry so it tiles exactly, with a light warp so
   * the chasing looks cut by hand.
   */
  const orna = field(size, 2, (u, v) => {
    const wu = u + 0.012 * (fbmT(u * 4, v * 4, 4, 4, 3, 0.5, S + 3) - 0.5);
    const wv = v + 0.012 * (fbmT(u * 4 + 3, v * 4, 4, 4, 3, 0.5, S + 9) - 0.5);

    // diagonal interlace: two crossing sine bands
    const d1 = Math.sin(TAU * ((wu + wv) * 4) + 0.9 * Math.sin(TAU * (wu - wv) * 2));
    const d2 = Math.sin(TAU * ((wu - wv) * 4) + 0.9 * Math.sin(TAU * (wu + wv) * 2));
    const lattice = Math.max(
      1 - smoothstep(0.0, 0.16, Math.abs(d1)),
      1 - smoothstep(0.0, 0.16, Math.abs(d2)));

    // rosette: concentric rule + eight petals, one per panel
    const pu = frac(wu * 2) - 0.5, pv = frac(wv * 2) - 0.5;
    const rr = Math.sqrt(pu * pu + pv * pv);
    const ang = Math.atan2(pv, pu);
    const petalR = 0.15 + 0.075 * Math.cos(ang * 8);
    const petal = (1 - smoothstep(0.0, 0.02, Math.abs(rr - petalR))) * smoothstep(0.34, 0.22, rr);
    const ring = (1 - smoothstep(0.0, 0.016, Math.abs(rr - 0.075)))
      + (1 - smoothstep(0.0, 0.013, Math.abs(rr - 0.235)));
    const boss = 1 - smoothstep(0.028, 0.012, rr);
    const rose = clamp01(petal + ring * smoothstep(0.4, 0.3, rr) + (1 - boss));

    // panel border rule
    const bu = Math.abs(frac(wu * 2) - 0.5), bv = Math.abs(frac(wv * 2) - 0.5);
    const border = (1 - smoothstep(0.0, 0.012, Math.abs(Math.max(bu, bv) - 0.435)));

    const panelMask = smoothstep(0.24, 0.33, rr); // lattice only outside the rosette
    return clamp01(Math.max(Math.max(rose, border), lattice * panelMask));
  });
  const planish = field(size, 2, (u, v) => worleyT4(u * 11, v * 11, 11, 11, S + 37));
  const tarn = field(size, 4, (u, v) => fbmT(u * 6, v * 6, 6, 6, 5, 0.55, S + 53));
  const swirlA = field(size, 2, (u, v) => anisoT(u, v, 2, 1, -1, 2, 2, 110, S + 71, 3));
  const det = detailField(c, S + 83);
  const flk = fleckField(c, S + 91);

  for (let i = 0; i < size * size; i++) {
    const eng = Math.pow(orna[i], 1.35);
    const dish = (0.32 - planish[i]) * 0.016;
    const swirl = Math.pow(clamp01(1 - Math.abs(swirlA[i] - 0.5) * 6.5), 3);

    let hh = 0.66 + dish - eng * 0.06
      + (det[i] - 0.5) * 0.005 + (flk[i] - 0.5) * 0.0015 - swirl * 0.0025;

    // gold F0 ≈ (1.00, 0.77, 0.34) linear
    let r = 0.985 + (det[i] - 0.5) * 0.02;
    let g = 0.885 + (det[i] - 0.5) * 0.02;
    let b = 0.615 + (det[i] - 0.5) * 0.03;
    let rough = 0.15 + (det[i] - 0.5) * 0.09 + swirl * 0.16 + planish[i] * 0.05;
    let metal = 1;

    // tarnish is deliberately weighted by the engraving: it hides in grooves
    const tv = clamp01(smoothstep(0.42, 0.78, tarn[i]) * (0.28 + 0.95 * eng));
    if (tv > 0.002) {
      r += (0.2 - r) * tv;
      g += (0.155 - g) * tv;
      b += (0.075 - b) * tv;
      rough += (0.66 - rough) * tv;
      metal *= 1 - 0.42 * tv;
    }

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = metal;
    c.gm[i] = clamp01(0.25 + tarn[i] * 0.7) * (0.35 + 0.85 * eng);
  }
}

/* ================================================================= CLOTH */
/**
 * 2/2 TWILL weave, in four declared tiers (see KIND_TIERS).
 *
 * It is a twill and not a plain weave for one specific reason. A plain weave's
 * over-one/under-one interlacing is a CHECKERBOARD, and a checkerboard of round
 * thread crowns sampled at 2–4 screen pixels is a regular dot screen — which is
 * pixel-for-pixel the same read as a mail sleeve's ring lattice at the same
 * density. That is precisely the round-2 blocker: "a single dimpled/hex noise
 * pattern ... the hero's helmet, gorget, cuirass, arms and skirt". A 2/2 twill
 * floats each thread over two and under two, stepping one thread per row, so its
 * signature is a DIAGONAL RIB. A diagonal rib survives minification as a
 * directional texture and can never be confused with a lattice of rings.
 *
 *  T0  dye lot and sun-bleached crowns — a 2-cycle band, half multiplicative and
 *      half an additive pale bloom, because a 0.15-luma wool cannot buy absolute
 *      contrast from a multiply alone. This is the tier that survives a robe being
 *      drawn 60 px tall. See macroField().
 *  T1  twill rib + thread crowns, ~2 mm per thread at a garment's UV density
 *  T2  fray at the stress patches, dirty hem, and a burnished sheen on the
 *      proud floats where the wearer's arm rubs (shared `wr` supply)
 *  T3  slub — per-thread diameter variance — plus fibre fuzz and texel grain
 */
export function genCloth(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.8;
  P.aoStrength = 0.95; P.cavity1 = 1.25; P.cavity2 = 0.9;
  P.grimeAmount = 0.7; P.grimeColor = [0.085, 0.072, 0.055]; P.grimeRough = 0.97;
  P.roughMin = 0.42; P.displacement = 0.018;
  /* T2 — wool that has been rubbed flat. Worn wool does not go pale like a
     broken fibre does; it FELTS: the nap lies down, so it darkens slightly and
     gets appreciably smoother. Getting that coupling backwards (paler + rougher)
     is what makes cloth read as paper. */
  P.wearAmount = 0.34; P.wearColor = [0.205, 0.128, 0.112];
  P.wearRough = 0.70; P.wearScale = 16; P.wearProud = 1.0;

  // Thread count is forced to a multiple of 4 — the twill repeat is 4 threads,
  // so anything else puts a visible seam down the tile edge.
  const N = 4 * Math.max(6, Math.min(16, Math.round(size / 40)));
  const dye = field(size, 4, (u, v) => fbmT(u * 4, v * 4, 4, 4, 5, 0.6, S + 7));
  const wearF = field(size, 4, (u, v) => fbmT(u * 6 + 3, v * 6, 6, 6, 5, 0.55, S + 19));
  const hemF = field(size, 4, (u, v) => fbmT(u * 9, v * 5, 9, 5, 4, 0.6, S + 29));
  const fuzz = field(size, 2, (u, v) => anisoT(u, v, 1, 0, 0, 1, 7, fineF(size, 130), S + 41, 3));
  const det = detailField(c, S + 53);
  const flk = fleckField(c, S + 59);
  const mac = macroField(c, S + 607, 2);

  // per-thread dye lots and slub (diameter variance), tabulated once
  const warpDye = new Float32Array(N), weftDye = new Float32Array(N);
  const warpTh = new Float32Array(N), weftTh = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    warpDye[k] = hash2(k + 1, 0, S + 71) - 0.5;
    weftDye[k] = hash2(0, k + 1, S + 73) - 0.5;
    // hand-spun yarn is never one diameter; +/-18 % is a normal bolt
    warpTh[k] = 0.82 + hash2(k + 3, 5, S + 79) * 0.36;
    weftTh[k] = 0.82 + hash2(7, k + 3, S + 83) * 0.36;
  }

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    const fy = v * N;
    let cy = Math.floor(fy);
    const ty = fy - cy;
    cy = ((cy % N) + N) % N;
    for (let x = 0; x < size; x++, i++) {
      const u = (x + 0.5) * inv;
      const fx = u * N;
      let cx = Math.floor(fx);
      const tx = fx - cx;
      cx = ((cx % N) + N) % N;

      /* 2/2 twill: the warp is up for two consecutive cells and down for two,
         and the phase advances one cell per row. `(cx - cy) mod 4 < 2` is the
         whole draft, and it is what tilts the rib to 45 degrees. */
      const tw = (((cx - cy) % 4) + 4) % 4;
      const warpUp = tw < 2;
      // slub: a thick thread stands proud and a thin one sinks
      const thX = warpTh[cx], thY = weftTh[cy];
      const pX = Math.sin(Math.PI * clamp01(0.5 + (tx - 0.5) / thX)) * thX;
      const pY = Math.sin(Math.PI * clamp01(0.5 + (ty - 0.5) / thY)) * thY;
      // the thread on top gets the full round profile, the one beneath dips
      const top = warpUp ? pX : pY;
      const under = warpUp ? pY : pX;
      /* Float ridge. In a twill the top thread runs UNBROKEN across two cells,
         so the crown is a continuous diagonal welt rather than an isolated bump.
         This term is what makes the rib legible: it is high in the middle of a
         two-cell float and dips at the turn. */
      const along = warpUp ? (tw === 0 ? ty : 1 - ty) : (tw === 2 ? tx : 1 - tx);
      const floatR = Math.sin(Math.PI * clamp01(0.5 + along * 0.5));
      const twist = warpUp
        ? 0.5 - 0.5 * Math.cos(TAU * (fy * 2.5 + tx * 0.5))
        : 0.5 - 0.5 * Math.cos(TAU * (fx * 2.5 + ty * 0.5));

      // fray / thinning patches
      const fray = clamp01(smoothstep(0.62, 0.88, wearF[i]) * 1.4);
      const weaveAmp = 1 - fray * 0.75;

      let hh = 0.5 + (top * 0.075 + floatR * 0.028 - (1 - under) * 0.012) * weaveAmp
        + twist * 0.012 * weaveAmp
        + (det[i] - 0.5) * 0.01 + (flk[i] - 0.5) * 0.006
        + (fuzz[i] - 0.5) * 0.02 * fray;

      // per-thread dye variance: a hand-dyed bolt is never one colour
      const tvar = warpUp ? warpDye[cx] : weftDye[cy];
      const shade = 0.75 + dye[i] * 0.5 + tvar * 0.22;
      // muted oxblood wool — the tint override recolours it per use site
      let r = 0.255 * shade + 0.022;
      let g = 0.142 * shade + 0.016;
      let b = 0.118 * shade + 0.016;
      // the shaded side of the rib: a twill reads as a rib because one flank of
      // every float is turned away, and that is an ALBEDO fact as well as a
      // normal-map one at the distances this gets sampled from
      const ribShade = 1 - 0.16 * (1 - floatR);
      r *= ribShade; g *= ribShade; b *= ribShade;
      let rough = 0.9 - top * 0.06 + (det[i] - 0.5) * 0.08;

      // broken fibres scatter more light → paler and matte
      if (fray > 0.002) {
        r += (r * 1.55 + 0.03 - r) * fray;
        g += (g * 1.55 + 0.028 - g) * fray;
        b += (b * 1.5 + 0.026 - b) * fray;
        rough += (0.99 - rough) * fray;
      }

      // dirty hem: the band wraps across the tile seam so it stays continuous
      const hemBand = Math.max(smoothstep(0.2, 0.0, v), smoothstep(0.8, 1.0, v));
      const hem = clamp01(hemBand * (0.35 + 0.9 * hemF[i]) * 1.25);

      /* TIER 0 — see macroField(). Cloth is the kind that needed this most: its
         albedo luma SD at the 16-texel mip measured 0.012, i.e. a robe at
         gameplay distance was a single flat value with a weave that had already
         been mipped out of existence. Wool takes it two ways at once and both are
         here, because a purely multiplicative band on a 0.15-luma cloth buys
         almost no absolute contrast:
           - multiplicative, for the dye lot and the damp/shadowed folds;
           - ADDITIVE and pale on the positive lobe, for the sun-bleached and
             dust-bloomed shoulders and crowns, which on real cloth are the
             lightest thing on the garment by a wide margin.
         Measured relative albedo contrast (luma SD / luma mean) at the 16-texel
         mip: 0.079 before this tier, 0.22 here — the same band the hero's own
         cloth and cloak occupy, which are the surfaces the brief says already
         read correctly. See macroMul(). */
      const M = mac[i];
      const bleach = M > 0 ? M * M * 4 * 0.105 : 0;
      r = r * macroMul(M, 1.92) + bleach;
      g = g * macroMul(M, 1.98) + bleach * 0.94;
      b = b * macroMul(M, 2.08) + bleach * 0.86;
      rough -= M * 0.18;

      c.h[i] = hh;
      c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
      c.rg[i] = rough;
      c.mt[i] = 0;
      // felted sheen on the proud floats, strongest in the stress patches;
      // a frayed patch has lost its nap already, so it cannot also be burnished
      c.wr[i] = clamp01(floatR * (0.30 + 0.85 * smoothstep(0.34, 0.72, wearF[i]))
        * (1 - fray));
      c.gm[i] = clamp01(hem * 0.95 + smoothstep(0.5, 0.85, wearF[i]) * 0.45 + 0.12 - M * 0.85);
    }
  }
}

/* =============================================================== LEATHER */
/**
 * Tanned hide, in four declared tiers (see KIND_TIERS): a macro belly/back tone
 * band (T0), hide grain cells (T1), burnished welts and creases (T2), and
 * follicle pores (T3).
 */
export function genLeather(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.9;
  P.aoStrength = 0.9; P.cavity1 = 1.3; P.cavity2 = 1.0;
  P.grimeAmount = 0.6; P.grimeColor = [0.062, 0.05, 0.038]; P.grimeRough = 0.86;
  P.roughMin = 0.2; P.displacement = 0.025;
  /* T2 — burnish. Where a buckle tongue, a strap edge or a hand rides over hide
     the surface polishes: the raised grain cells flatten, the wax burnishes, and
     it goes DARKER and much smoother — the opposite of the pale, matte scuff a
     broken fibre gives. Having both couplings present, driven off the same form,
     is what makes leather read as leather rather than as brown card. */
  P.wearAmount = 0.62; P.wearColor = [0.155, 0.088, 0.052];
  P.wearRough = 0.26; P.wearScale = 18; P.wearProud = 1.0;

  const [grainBig, gTone] = fieldN(size, 4, 2, (u, v, out) => {
    warpT(u * 6, v * 6, 6, 6, S + 3, 0.5, 3);
    worleyT((WP.x / 6) * 38, (WP.y / 6) * 38, 38, 38, S + 11);
    out[0] = WK.edge;
    out[1] = hash2(WK.cx, WK.cy, S + 17);
  });
  const LP = fineF(size, 110);
  const pore = field(size, 1, (u, v) => worleyT4(u * LP, v * LP, LP, LP, S + 23));
  const crease = field(size, 4, (u, v) => {
    warpT(u * 4, v * 4, 4, 4, S + 31, 0.8, 3);
    return fbmT(WP.x, WP.y, 4, 4, 5, 0.55, S + 37, FBM_RIDGED);
  });
  const scuff = field(size, 4, (u, v) => fbmT(u * 7, v * 7, 7, 7, 5, 0.6, S + 43));
  const oil = field(size, 4, (u, v) => fbmT(u * 3 + 4, v * 3, 3, 3, 4, 0.6, S + 47));
  const det = detailField(c, S + 61);
  const mac = macroField(c, S + 619, 2);

  const inv = 1 / size;
  for (let y = 0, i = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++, i++) {
      const u = (x + 0.5) * inv;

      // saddle stitch running around an inset panel border
      const dU = Math.min(Math.abs(u - 0.07), Math.abs(u - 0.93));
      const dV = Math.min(Math.abs(v - 0.07), Math.abs(v - 0.93));
      const inX = u > 0.07 && u < 0.93, inY = v > 0.07 && v < 0.93;
      let dBorder, along;
      if (inX && inY) {
        if (dU < dV) { dBorder = dU; along = v; } else { dBorder = dV; along = u; }
      } else if (inX) { dBorder = dV; along = u; }
      else if (inY) { dBorder = dU; along = v; }
      else { dBorder = Math.sqrt(dU * dU + dV * dV); along = u + v; }
      const dash = frac(along * 42);
      const onStitch = smoothstep(0.62, 0.42, dash) * smoothstep(0.0092, 0.0035, dBorder);
      const hole = smoothstep(0.86, 0.98, dash) * smoothstep(0.008, 0.002, dBorder);
      const channel = smoothstep(0.017, 0.009, dBorder);

      const grain = 1 - smoothstep(0.0, 0.075, grainBig[i]);     // hide cells
      const pores = 1 - smoothstep(0.02, 0.34, pore[i]);         // follicles
      const cr2 = Math.pow(crease[i], 1.6);

      let hh = 0.6
        - grain * 0.02 - pores * 0.01
        - cr2 * 0.075
        - channel * 0.012
        + onStitch * 0.035 - hole * 0.03
        + (det[i] - 0.5) * 0.009;

      // rich saddle-brown, deepening in the creases
      const tone = 0.82 + gTone[i] * 0.36;
      let r = 0.245 * tone;
      let g = 0.138 * tone;
      let b = 0.082 * tone;
      let rough = 0.62 + (det[i] - 0.5) * 0.12 + pores * 0.12 - grain * 0.05;

      // uneven oiling: roughness variance uncorrelated with albedo is exactly
      // what makes leather read as leather rather than painted card
      const ov = oil[i];
      rough += (ov - 0.5) * 0.34;

      // scuffing on the raised grain lifts and dulls the finish
      const sc = clamp01(smoothstep(0.55, 0.85, scuff[i]) * (0.4 + 0.6 * (1 - cr2)));
      r += (r * 1.7 + 0.028 - r) * sc;
      g += (g * 1.7 + 0.024 - g) * sc;
      b += (b * 1.65 + 0.02 - b) * sc;
      rough += (0.85 - rough) * sc * 0.8;

      // waxed linen thread
      if (onStitch > 0.002) {
        r += (0.2 - r) * onStitch;
        g += (0.168 - g) * onStitch;
        b += (0.122 - b) * onStitch;
        rough += (0.55 - rough) * onStitch;
      }

      /* TIER 0 — see macroField(). Hide is cut from an animal, and an animal is
         not one tone: the belly is paler and thinner than the back, the flanks
         carry old scar zones, and where a strap has lain against it for years the
         wax has soaked in dark. Those are 5-20 cm patches. Without them a hide
         panel at gameplay distance measured an albedo luma SD of 0.021 at the
         working mip; the pore and grain tiers had already been averaged away.
         Gains set to land the relative contrast at 0.20, matching the hero's own
         leather, which the brief confirms reads correctly. See macroMul(). */
      const M = mac[i];
      r *= macroMul(M, 1.68);
      g *= macroMul(M, 1.80);
      b *= macroMul(M, 1.96);
      rough -= M * 0.26;

      c.h[i] = hh;
      c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
      c.rg[i] = rough;
      c.mt[i] = 0;
      /* Burnish supply: the raised grain between the creases, plus the stitch
         welt, which is the highest thing on the panel and therefore the first to
         take a shine. Excluded from the creases — the bottom of a fold never gets
         rubbed, it collects dirt, which the grime channel already handles. */
      c.wr[i] = clamp01(((1 - cr2) * (0.30 + 0.55 * grain) + onStitch * 0.70)
        * (0.55 + 0.75 * ov));
      c.gm[i] = clamp01(0.3 + scuff[i] * 0.5 + cr2 * 0.5 - M * 0.85);
    }
  }
}

/* ================================================================= FLESH */
/**
 * Sallow undead skin, in four declared tiers (see KIND_TIERS): a macro
 * livid/sallow band (T0), subsurface mottling and the vein network (T1), dried
 * gore in the creases (T2), and pores (T3).
 */
export function genFlesh(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.42;
  P.aoStrength = 0.6; P.cavity1 = 0.85; P.cavity2 = 0.8;
  P.grimeAmount = 0.45; P.grimeColor = [0.085, 0.058, 0.046]; P.grimeRough = 0.82;
  P.roughMin = 0.24; P.displacement = 0.02; P.cavityTint = 0.1;

  const blotchA = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 5, 0.62, S + 5));
  const blotchB = field(size, 4, (u, v) => fbmT(u * 8 + 2, v * 8, 8, 8, 5, 0.55, S + 13));
  const vein = field(size, 4, (u, v) => {
    warpT(u * 4, v * 4, 4, 4, S + 19, 1.1, 3);
    // veins only surface where the flesh is thin — a full-coverage network
    // reads as tripe, not skin
    const where = smoothstep(0.62, 0.9, fbmT(u * 2, v * 2, 2, 2, 4, 0.62, S + 21));
    return fbmT(WP.x, WP.y, 4, 4, 2, 0.45, S + 23, FBM_RIDGED) * where;
  });
  const wrinkle = field(size, 4, (u, v) => {
    warpT(u * 9, v * 9, 9, 9, S + 29, 0.7, 3);
    // two octaves only: long individual creases instead of a fractal mesh,
    // and they only appear where the skin actually folds
    const where = smoothstep(0.48, 0.8, fbmT(u * 3, v * 3, 3, 3, 3, 0.6, S + 33));
    return fbmT(WP.x, WP.y, 9, 9, 2, 0.4, S + 31, FBM_RIDGED) * where;
  });
  const FP2 = fineF(size, 130);
  const pore = field(size, 1, (u, v) => worleyT4(u * FP2, v * FP2, FP2, FP2, S + 37));
  const gore = field(size, 4, (u, v) => fbmT(u * 7 + 5, v * 7, 7, 7, 5, 0.6, S + 41));
  const det = detailField(c, S + 47);
  const flk = fleckField(c, S + 53);
  const mac = macroField(c, S + 631, 2);

  for (let i = 0; i < size * size; i++) {
    const pores = 1 - smoothstep(0.015, 0.26, pore[i]);
    const wr = Math.pow(wrinkle[i], 3.0);
    const vn = Math.pow(vein[i], 3.0);

    let hh = 0.6 - pores * 0.006 - wr * 0.014 + vn * 0.016
      + (blotchB[i] - 0.5) * 0.02 + (blotchA[i] - 0.5) * 0.03
      + (det[i] - 0.5) * 0.004 + (flk[i] - 0.5) * 0.0015;

    // base: drained, greyed-out skin with red still pushing through
    const sub = blotchA[i] * 0.65 + blotchB[i] * 0.35;
    let r = 0.335 + (sub - 0.5) * 0.24;
    let g = 0.255 + (sub - 0.5) * 0.135;
    let b = 0.222 + (sub - 0.5) * 0.085;
    // necrotic patches drift green-grey
    const necro = smoothstep(0.56, 0.86, blotchA[i]);
    r += (0.215 - r) * necro * 0.75;
    g += (0.232 - g) * necro * 0.75;
    b += (0.178 - b) * necro * 0.75;
    // capillary flush in the thin areas
    const flush = smoothstep(0.35, 0.72, blotchB[i]) * (1 - necro);
    r += 0.055 * flush;
    g -= 0.012 * flush;
    b -= 0.006 * flush;
    // veins read cold and blue-violet under the surface
    r += (0.2 - r) * vn * 0.45;
    g += (0.19 - g) * vn * 0.5;
    b += (0.245 - b) * vn * 0.5;

    let rough = 0.5 + pores * 0.16 + (det[i] - 0.5) * 0.14 - flush * 0.06;
    // sebum sheen: broad, soft, low-frequency — never uniform
    rough += (blotchA[i] - 0.5) * 0.2;

    // dried blood crusted in the creases
    const gv = clamp01(smoothstep(0.6, 0.85, gore[i]) * (0.35 + 1.1 * wr));
    if (gv > 0.002) {
      r += (0.1 - r) * gv;
      g += (0.022 - g) * gv;
      b += (0.018 - b) * gv;
      rough += (0.72 - rough) * gv;
      hh += gv * 0.006;
    }

    /* TIER 0 — see macroField(). The subsurface mottle above is 3 and 8 cycles per
       repeat, which on a character is 3-8 cm — the right size for the blood
       pooling under skin but far too small to survive the working mip: the brute's
       flesh measured an albedo luma SD of 0.009 there, i.e. flat. This band is the
       10-25 cm one: whole limbs that have gone livid, whole flanks still sallow.
       Dark drifts green-grey rather than simply darker, because what is happening
       to a corpse's skin is putrefaction, not shading. Gains set to land the
       relative albedo contrast at 0.22 against the 0.12-0.15 it measured at gain
       0.9, which was still only half the hero's. See macroMul(). */
    const M = mac[i];
    r *= macroMul(M, 1.94);
    g *= macroMul(M, 1.68);
    b *= macroMul(M, 1.84);
    rough -= M * 0.22;

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.16 + gore[i] * 0.55 + wr * 0.25 - M * 0.78);
  }
}

/* ================================================================== BONE */
/**
 * Old bone, in four declared tiers (see KIND_TIERS): a macro stain band (T0),
 * trabecular clusters (T1), hairline fractures and dirt staining that follow the
 * form (T2), and cortex pores (T3).
 */
export function genBone(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.8;
  P.aoStrength = 0.78; P.cavity1 = 1.0; P.cavity2 = 0.9;
  P.grimeAmount = 0.4; P.grimeColor = [0.17, 0.138, 0.092]; P.grimeRough = 0.93;
  P.roughMin = 0.2; P.displacement = 0.03; P.cavityTint = 0.14;

  const yellow = field(size, 4, (u, v) => fbmT(u * 4, v * 4, 4, 4, 5, 0.6, S + 7));
  const [trab, tRand] = fieldN(size, 2, 2, (u, v, out) => {
    warpT(u * 8, v * 8, 8, 8, S + 11, 0.45, 3);
    worleyT4((WP.x / 8) * 22, (WP.y / 8) * 22, 22, 22, S + 13);
    out[0] = WK.f1;
    out[1] = hash2(WK.cx, WK.cy, S + 17);
  });
  const PF = fineF(size, 190);
  const pore = field(size, 1, (u, v) => worleyT4(u * PF, v * PF, PF, PF, S + 19));
  const crack = field(size, 4, (u, v) => {
    warpT(u * 5, v * 5, 5, 5, S + 23, 0.85, 3);
    // sparse hairline fractures: low octave count keeps the lines long and
    // separate, and a broad mask stops them covering the whole surface
    const where = smoothstep(0.46, 0.76, fbmT(u * 2, v * 2, 2, 2, 3, 0.6, S + 27));
    return fbmT(WP.x, WP.y, 5, 5, 3, 0.45, S + 29, FBM_RIDGED) * where;
  });
  const stri = field(size, 2, (u, v) => anisoT(u, v, 1, 0, 0, 1, 4, fineF(size, 90), S + 31, 3));
  const det = detailField(c, S + 37);
  const flk = fleckField(c, S + 41);
  const mac = macroField(c, S + 601, 2);

  for (let i = 0; i < size * size; i++) {
    const clusters = (1 - smoothstep(0.05, 0.5, trab[i] + (det[i] - 0.5) * 0.22))
      * smoothstep(0.55, 0.92, tRand[i]);
    const pores = (1 - smoothstep(0.02, 0.2, pore[i])) * 0.45;
    // hairline fractures: very thin, deep, and dark — the readable feature
    const fr = Math.pow(crack[i], 3.5);
    const striae = (stri[i] - 0.5);

    let hh = 0.64
      - clusters * 0.02 - pores * 0.009 - fr * 0.06
      + striae * 0.01
      + (det[i] - 0.5) * 0.009 + (flk[i] - 0.5) * 0.0025;

    const age = yellow[i];
    let r = 0.6 + (age - 0.5) * 0.14 + (det[i] - 0.5) * 0.05;
    let g = 0.555 + (age - 0.5) * 0.15 + (det[i] - 0.5) * 0.045;
    let b = 0.455 + (age - 0.5) * 0.13 + (det[i] - 0.5) * 0.035;
    // deeper ivory staining where it has lain in the dirt
    const stain = smoothstep(0.55, 0.9, age);
    r += (0.4 - r) * stain * 0.6;
    g += (0.335 - g) * stain * 0.62;
    b += (0.222 - b) * stain * 0.66;

    let rough = 0.58 + pores * 0.16 + clusters * 0.12 + (det[i] - 0.5) * 0.1
      - smoothstep(0.55, 0.9, 1 - clusters) * 0.1;
    // the fracture line itself: dirt-filled, matte, near-black
    if (fr > 0.002) {
      r += (0.135 - r) * fr;
      g += (0.115 - g) * fr;
      b += (0.082 - b) * fr;
      rough += (0.95 - rough) * fr;
    }

    /* TIER 0 — see macroField(). Old bone is never one value: the side that lay
       buried is dirt-stained and dull, the side that weathered is bleached chalky
       and slightly proud, and the boundary between them is a 5-15 cm patch, not a
       1 mm pore. It is applied per channel with blue pulled down hardest on the
       dark side, because the thing doing the staining is soil, and it is coupled
       into roughness and the grime supply so the patch is dark AND matte AND
       dirty at once. Measured relative albedo contrast (luma SD / luma mean) at
       the 16-texel mip, which is the mip a 16 px repeat selects at the gameplay
       camera: 0.054 before the tier existed, 0.126 at gain 0.9, 0.23 here — the
       band the hero's own maps occupy. See macroMul(). */
    const M = mac[i];
    r *= macroMul(M, 1.82);
    g *= macroMul(M, 1.98);
    b *= macroMul(M, 2.20);
    rough -= M * 0.24;

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.35 + stain * 0.5 + fr * 0.8 + clusters * 0.4 - M * 1.05);
  }
}

/* ================================================================== DIRT */
/** Trodden soil: clumps, embedded gravel, root fibre, damp patches. */
export function genDirt(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 1.05;
  P.aoStrength = 1.05; P.cavity1 = 1.1; P.cavity2 = 1.25;
  P.grimeAmount = 0.45; P.grimeColor = [0.085, 0.068, 0.045]; P.grimeRough = 0.97;
  P.roughMin = 0.3; P.displacement = 0.06;

  const clump = field(size, 4, (u, v) => {
    warpT(u * 5, v * 5, 5, 5, S + 3, 0.7, 3);
    return fbmT(WP.x, WP.y, 5, 5, 6, 0.58, S + 7, FBM_BILLOW);
  });
  const [stone, sRand] = fieldN(size, 2, 2, (u, v, out) => {
    worleyT4(u * 14, v * 14, 14, 14, S + 11);
    out[0] = WK.f1;
    out[1] = hash2(WK.cx, WK.cy, S + 13);
  });
  const root = field(size, 4, (u, v) => {
    warpT(u * 7, v * 7, 7, 7, S + 17, 0.85, 3);
    return fbmT(WP.x * 2, WP.y * 2, 14, 14, 4, 0.5, S + 19, FBM_RIDGED);
  });
  const moist = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 5, 0.62, S + 23));
  const grit = field(size, 2, (u, v) => worleyT4(u * 100, v * 100, 100, 100, S + 29));
  const det = detailField(c, S + 31);
  const flk = fleckField(c, S + 37);

  for (let i = 0; i < size * size; i++) {
    const cl = clump[i];
    const isStone = smoothstep(0.6, 0.78, sRand[i]);
    // perturb the cell distance so buried stones are irregular lumps, not discs
    const sd = stone[i] + (det[i] - 0.5) * 0.13 + (cl - 0.5) * 0.06;
    const pebble = Math.pow(clamp01(1 - smoothstep(0.02, 0.32 * (0.55 + sRand[i]), sd)), 0.75) * isStone;
    const rt = Math.pow(root[i], 5.5) * (1 - pebble);
    const gr = 1 - smoothstep(0.06, 0.38, grit[i]);

    let hh = 0.42 + (cl - 0.5) * 0.3
      + pebble * 0.07
      + rt * 0.012
      + gr * 0.01
      + (det[i] - 0.5) * 0.022 + (flk[i] - 0.5) * 0.008;

    // dry loam, warm and dusty, with real value range between clod and hollow
    let r = 0.205 + (cl - 0.5) * 0.14 + (det[i] - 0.5) * 0.045;
    let g = 0.158 + (cl - 0.5) * 0.105 + (det[i] - 0.5) * 0.034;
    let b = 0.108 + (cl - 0.5) * 0.062 + (det[i] - 0.5) * 0.022;
    let rough = 0.95 + (det[i] - 0.5) * 0.07;

    // gravel: cold grey, harder, appreciably smoother than the soil around it
    if (pebble > 0.002) {
      // per-stone tone spans dark basalt to pale flint, so they read as a
      // scatter of individuals rather than a dotted pattern
      const pv = 0.112 + Math.pow(hash2(1, 1, ((sRand[i] * 8192) | 0) + S), 1.8) * 0.205
        + (det[i] - 0.5) * 0.055;
      r += (pv * 1.03 - r) * pebble;
      g += (pv * 1.0 - g) * pebble;
      b += (pv * 0.93 - b) * pebble;
      rough += (0.66 - rough) * pebble;
    }
    // root fibre: pale, dry, stringy
    if (rt > 0.002) {
      r += (0.245 - r) * rt;
      g += (0.198 - g) * rt;
      b += (0.115 - b) * rt;
      rough += (0.92 - rough) * rt;
    }

    // moisture: darker AND smoother — the opposite coupling to dust
    const mv = clamp01(smoothstep(0.5, 0.82, moist[i]) * (1.15 - (cl - 0.5) * 0.6));
    if (mv > 0.002) {
      r *= 1 - 0.55 * mv; g *= 1 - 0.52 * mv; b *= 1 - 0.46 * mv;
      rough += (0.5 - rough) * mv * 0.9;
    }

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.25 + (1 - cl) * 0.5) * (1 - pebble * 0.5);
  }
}

/* ================================================================== MOSS */
/** Layered growth for blending over stone. Coverage lands in the albedo alpha. */
export function genMoss(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.75;
  P.aoStrength = 1.15; P.cavity1 = 1.2; P.cavity2 = 1.3;
  P.grimeAmount = 0.3; P.grimeColor = [0.05, 0.052, 0.032]; P.grimeRough = 0.96;
  P.roughMin = 0.5; P.displacement = 0.045;

  const macro = field(size, 4, (u, v) => {
    warpT(u * 4, v * 4, 4, 4, S + 3, 0.8, 3);
    return fbmT(WP.x, WP.y, 4, 4, 5, 0.6, S + 5, FBM_BILLOW);
  });
  const mid = field(size, 4, (u, v) => {
    warpT(u * 11, v * 11, 11, 11, S + 11, 0.6, 3);
    return fbmT(WP.x, WP.y, 11, 11, 4, 0.55, S + 13, FBM_BILLOW);
  });
  const cluster = field(size, 2, (u, v) => worleyT4(u * 16, v * 16, 16, 16, S + 17));
  const frond = field(size, 1, (u, v) => {
    const f = Math.max(24, size >> 3);
    return perlinT(u * f * 2, v * f * 2, f * 2, f * 2, S + 19) * 0.6
      + perlinT(u * f, v * f, f, f, S + 23) * 0.4;
  });
  const dryF = field(size, 4, (u, v) => fbmT(u * 6 + 3, v * 6, 6, 6, 4, 0.6, S + 29));
  const flk = fleckField(c, S + 31);
  const cov = c.coverage();

  for (let i = 0; i < size * size; i++) {
    const m = macro[i];
    const cl = 1 - smoothstep(0.02, 0.44, cluster[i]);
    const layers = clamp01(m * 0.56 + mid[i] * 0.3 + cl * 0.24 - 0.06);
    const tip = clamp01((frond[i] - 0.42) * 2.2) * (0.35 + 0.65 * layers);

    // coverage: soft-edged patches with a ragged fringe
    const cv = clamp01(smoothstep(0.4, 0.6, m * 0.72 + mid[i] * 0.28)
      * 1.15 - (1 - frond[i]) * 0.28);
    cov[i] = cv;

    let hh = 0.3 + Math.pow(layers, 0.7) * 0.5 + tip * 0.06
      + (frond[i] - 0.5) * 0.028 + (flk[i] - 0.5) * 0.006;

    // deep shade at the base, bright chlorophyll at the tips
    const depth = clamp01(Math.pow(layers * 0.7 + tip * 0.55, 0.8));
    let r = lerp(0.016, 0.275, depth);
    let g = lerp(0.032, 0.395, depth);
    let b = lerp(0.014, 0.098, depth);
    // sun-scorched dry patches go ochre
    const dry = clamp01(smoothstep(0.58, 0.86, dryF[i]) * (0.4 + 0.7 * tip));
    r += (0.235 - r) * dry;
    g += (0.19 - g) * dry;
    b += (0.062 - b) * dry;

    const rough = 0.94 - tip * 0.1 + (flk[i] - 0.5) * 0.06;

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.3 + (1 - layers) * 0.55);
  }
}

/* =================================================================== ASH */
/** Fine burnt particulate, char lumps, live ember flecks (emissive). */
export function genAsh(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.8;
  P.aoStrength = 0.85; P.cavity1 = 1.0; P.cavity2 = 1.1;
  P.grimeAmount = 0.35; P.grimeCavity = 0.25; P.grimeColor = [0.055, 0.05, 0.048];
  P.grimeRough = 0.99; P.roughMin = 0.5; P.displacement = 0.04;

  const dune = field(size, 4, (u, v) => {
    warpT(u * 4, v * 4, 4, 4, S + 3, 0.6, 3);
    return fbmT(WP.x, WP.y, 4, 4, 5, 0.6, S + 5);
  });
  const [char, cRand] = fieldN(size, 2, 2, (u, v, out) => {
    worleyT4(u * 12, v * 12, 12, 12, S + 11);
    out[0] = WK.f1;
    out[1] = hash2(WK.cx, WK.cy, S + 13);
  });
  const drift = field(size, 2, (u, v) => anisoT(u, v, 1, 0, 0, 1, 6, 44, S + 17, 4));
  const emberF = field(size, 2, (u, v) => pointsT(u, v, 19, S + 19, 0.045, 0.05));
  const det = detailField(c, S + 23);
  const flk = fleckField(c, S + 29);
  const em = c.emissive();

  for (let i = 0; i < size * size; i++) {
    const isChar = smoothstep(0.52, 0.68, cRand[i]);
    const cd = char[i] + (det[i] - 0.5) * 0.16 + (drift[i] - 0.5) * 0.1;
    const lump = clamp01(1 - smoothstep(0.03, 0.42 * (0.5 + cRand[i]), cd)) * isChar;
    const fine = (flk[i] - 0.5) * 0.6 + (det[i] - 0.5) * 0.4;

    let hh = 0.48 + (dune[i] - 0.5) * 0.12
      + (drift[i] - 0.5) * 0.05
      + lump * 0.07
      + fine * 0.02;

    // cold ash is a very flat, very rough mid-dark grey with a faint warm cast
    const tone = 0.19 + (dune[i] - 0.5) * 0.09 + fine * 0.09;
    let r = tone * 1.06, g = tone * 1.0, b = tone * 0.96;
    let rough = 0.98 + fine * 0.03;

    // charcoal lumps: near-black, slightly less rough, faintly vitreous
    if (lump > 0.002) {
      r += (0.038 - r) * lump;
      g += (0.034 - g) * lump;
      b += (0.033 - b) * lump;
      rough += (0.62 - rough) * lump * 0.85;
    }

    // embers glowing under the surface: emissive only, so they do not carve
    // craters into the normal map or punch holes in the occlusion
    const ev = emberF[i] * clamp01(0.25 + lump * 1.5) * (0.35 + 0.65 * det[i]);
    if (ev > 0.002) {
      const e3 = i * 3;
      const hot = Math.pow(ev, 2.1);
      em[e3] = hot;
      em[e3 + 1] = hot * 0.28;
      em[e3 + 2] = hot * 0.045;
      r += (0.19 - r) * hot * 0.5;
      g += (0.05 - g) * hot * 0.5;
      b += (0.018 - b) * hot * 0.5;
      rough += (0.85 - rough) * hot * 0.7;
    }

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(0.3 + (dune[i] - 0.5) * 0.6);
  }
}

/* ================================================================= BLOOD */
/** Wet pooling with coagulated rims and cast-off spatter. Coverage in alpha. */
export function genBlood(c) {
  const size = c.size, S = c.seed, P = c.params;
  P.normalStrength = 0.55;
  P.aoStrength = 0.4; P.cavity1 = 0.7; P.cavity2 = 0.6;
  P.grimeAmount = 0.12; P.grimeColor = [0.06, 0.03, 0.024]; P.grimeRough = 0.7;
  P.roughMin = 0.045; P.displacement = 0.012;

  const pool = field(size, 4, (u, v) => {
    warpT(u * 3, v * 3, 3, 3, S + 3, 0.9, 4);
    return fbmT(WP.x, WP.y, 3, 3, 5, 0.6, S + 7);
  });
  const spatter = field(size, 2, (u, v) => {
    worleyT4(u * 16, v * 16, 16, 16, S + 11);
    const rad = 0.05 + 0.34 * Math.pow(hash2(WK.cx, WK.cy, S + 13), 3.2);
    return smoothstep(rad, rad * 0.3, WK.f1);
  });
  const cast = field(size, 2, (u, v) => {
    const a = anisoT(u, v, 2, 1, -1, 2, 3, 34, S + 17, 3);
    return smoothstep(0.62, 0.86, a);
  });
  const foam = field(size, 2, (u, v) => worleyT4(u * 70, v * 70, 70, 70, S + 19));
  const det = detailField(c, S + 23);
  const flk = fleckField(c, S + 29);
  const cov = c.coverage();

  for (let i = 0; i < size * size; i++) {
    const p = smoothstep(0.5, 0.63, pool[i]);
    const cv = clamp01(Math.max(Math.max(p, spatter[i]), cast[i] * 0.85)
      - (1 - det[i]) * 0.12);
    cov[i] = cv;

    // coagulated rim: the band where coverage falls off
    const rim = smoothstep(0.06, 0.3, cv) * (1 - smoothstep(0.34, 0.62, cv));
    const deep = smoothstep(0.45, 0.9, cv);
    const bub = (1 - smoothstep(0.05, 0.3, foam[i])) * rim;

    let hh = 0.5 + cv * 0.05 + rim * 0.022 - bub * 0.014
      + (det[i] - 0.5) * 0.006 * cv + (flk[i] - 0.5) * 0.003;

    // arterial red is far darker than people expect in shadow
    let r = 0.128 + (det[i] - 0.5) * 0.03;
    let g = 0.013 + (det[i] - 0.5) * 0.004;
    let b = 0.011 + (det[i] - 0.5) * 0.004;
    let rough = 0.085 + (det[i] - 0.5) * 0.05;

    // the dried rim: browner, matte, crusted
    if (rim > 0.002) {
      r += (0.088 - r) * rim;
      g += (0.026 - g) * rim;
      b += (0.017 - b) * rim;
      rough += (0.66 - rough) * rim;
    }
    // deep pool centre absorbs almost everything
    r *= 1 - 0.35 * deep;
    g *= 1 - 0.3 * deep;
    b *= 1 - 0.3 * deep;

    c.h[i] = hh;
    c.cr[i] = r; c.cg[i] = g; c.cb[i] = b;
    c.rg[i] = rough;
    c.mt[i] = 0;
    c.gm[i] = clamp01(rim * 0.6);
  }
}

/* --------------------------------------------------------------- exports */

export const KINDS = {
  stone: genStone,
  cobble: genCobble,
  wood: genWood,
  metal: genMetal,
  plate: genPlate,
  gold: genGold,
  cloth: genCloth,
  leather: genLeather,
  flesh: genFlesh,
  bone: genBone,
  dirt: genDirt,
  moss: genMoss,
  ash: genAsh,
  blood: genBlood,
};

export const KIND_LIST = Object.keys(KINDS);

/* ================================================================= TIERS */
/**
 * THE THREE-TIER CONTRACT — declared, not assumed.
 *
 * Round-2 blocker, verbatim: "A single dimpled/hex noise pattern at one scale
 * appears on the hero's helmet, gorget, cuirass, arms and skirt — and the same
 * noise family appears on the overworld terrain and the closeup rubble. Every
 * surface in the game reads as the same material."
 *
 * The cause was not a missing noise type. It was that each kind had ONE layer
 * with enough amplitude to matter, and that layer was a cellular field in every
 * case — so stone, cobble, metal, leather and bone all resolved to the same
 * rounded-cell read at whatever density their UV happened to give them.
 *
 * Every kind must therefore declare, and carry, at least TWO distinct frequency
 * tiers, and three wherever the surface will be seen close:
 *
 *   t0  MACRO VALUE BAND, 2-3 cycles per repeat — the only tier that survives
 *       minification onto a character at the gameplay camera, where one repeat is
 *       9-11 screen pixels and everything finer has already been averaged into
 *       the mean. Declared as [cycles per repeat, the family's own word for it,
 *       feature size in mm]. See macroField() for the measurements that forced
 *       it; the kinds that carry it are the ones that get drawn on a 60-90 px
 *       figure (bone, cloth, metal, leather, flesh) plus stone, which grew its
 *       own `macro` field for the same reason one round earlier.
 *
 *   t1  MID-FREQUENCY STRUCTURE, and it has to be a different KIND of structure
 *       per material family — not the same cellular field at a different scale.
 *       Declared as [cycles per repeat, the family's own word for it].
 *   t2  WEAR AND DAMAGE THAT FOLLOWS THE FORM. Not an independent noise: the
 *       shared finalize() pass drives bright wear from measured PROUDNESS (`wr`)
 *       and grime from measured CAVITY (`gm`), both off the kind's own height
 *       field, so damage lands where the form says it must.
 *   t3  FINE GRAIN at or below the texel scale, carried mainly in roughness so
 *       the mip chain averages it into a sheen instead of aliasing to sparkle.
 *
 * `mm` is the tier's feature size in millimetres at that kind's typical world
 * repeat, which is the number that actually decides whether it reads.
 */
export const KIND_TIERS = {
  stone:   { repeat: 2.0, t1: [5, 'ashlar coursing', 400], t2: ['spalled arrises + damp runoff'], t3: [256, 'quartz/biotite fleck', 8] },
  cobble:  { repeat: 2.05, t1: [9, 'laid setts', 228], t2: ['trodden lanes + mud joints'], t3: [256, 'grit fleck', 8] },
  wood:    { repeat: 1.2, t1: [4, 'boards + annual rings', 300], t2: ['rot at end grain + tannin bleed'], t3: [150, 'fibre', 8] },
  metal:   { repeat: 0.38, t0: [2, 'mill scale zones', 190], t1: [13, 'hammer facets + arrises', 29], t2: ['arris polish to steel + rust pitting'], t3: [256, 'abrasive grain', 1.5] },
  plate:   { repeat: 0.34, t0: [2, 'heat-treat zones', 170], t1: [3, 'overlapping lames', 113], t2: ['lip polish to steel + tarnish in the laps'], t3: [88, 'abrasion + corrosion pitting', 3.9] },
  gold:    { repeat: 0.4, t1: [8, 'chased filigree', 50], t2: ['tarnish in the engraving'], t3: [110, 'swirl polish', 3.6] },
  cloth:   { repeat: 0.46, t0: [2, 'dye lot + sun-bleached crowns', 230], t1: [52, '2/2 twill rib', 8.8], t2: ['fray patches + felted floats + hem'], t3: [130, 'slub + fuzz', 3.5] },
  leather: { repeat: 0.42, t0: [2, 'belly/back tone + wax-soaked straps', 210], t1: [38, 'hide grain cells', 11], t2: ['burnished welts + creases'], t3: [110, 'follicle pore', 3.8] },
  flesh:   { repeat: 0.40, t0: [2, 'livid limbs / sallow flanks', 200], t1: [3, 'subsurface mottle', 133], t2: ['dried gore in the creases'], t3: [130, 'pore', 3.1] },
  bone:    { repeat: 0.42, t0: [2, 'buried-side stain vs bleached face', 210], t1: [22, 'trabecular cluster', 19], t2: ['hairline fracture + dirt stain'], t3: [190, 'cortex pore', 2.2] },
  dirt:    { repeat: 1.5, t1: [5, 'clods', 300], t2: ['moisture + embedded gravel'], t3: [100, 'grit', 15] },
  moss:    { repeat: 0.6, t1: [4, 'growth patches', 150], t2: ['sun-scorched dry ochre'], t3: [128, 'frond', 4.7] },
  ash:     { repeat: 1.0, t1: [4, 'dunes', 250], t2: ['char lumps + live embers'], t3: [256, 'particulate', 4] },
  blood:   { repeat: 0.6, t1: [3, 'pools', 200], t2: ['coagulated rim + foam'], t3: [70, 'spatter grain', 8.6] },
};

/**
 * Enforcement. A kind with fewer than two declared tiers is the defect this
 * table exists to prevent, so it is a loud warning rather than a comment — the
 * same class of guard as the sampler-budget assert.
 */
export function assertTiers(log = console.warn) {
  const bad = [];
  for (const k of KIND_LIST) {
    const t = KIND_TIERS[k];
    const n = t ? [t.t0, t.t1, t.t2, t.t3].filter(Boolean).length : 0;
    if (n < 2) bad.push(`${k} (${n} tier${n === 1 ? '' : 's'})`);
  }
  if (bad.length) {
    log(`[texgen] SURFACE TIER VIOLATION — every kind needs >= 2 frequency tiers; `
      + `offenders: ${bad.join(', ')}`);
  }
  return bad;
}

/** Kinds whose coverage lives in the albedo alpha channel. */
export const ALPHA_KINDS = new Set(['moss', 'blood']);

/** Common misspellings / synonyms other modules are likely to reach for. */
export const KIND_ALIASES = {
  rock: 'stone', granite: 'stone', brick: 'stone', masonry: 'stone',
  wall: 'stone', marble: 'stone', plaster: 'stone', slate: 'stone',
  floor: 'cobble', cobblestone: 'cobble', gravel: 'cobble', pavement: 'cobble',
  plank: 'wood', planks: 'wood', timber: 'wood', bark: 'wood', crate: 'wood',
  iron: 'metal', steel: 'metal', rust: 'metal', armor: 'metal', armour: 'metal',
  // New aliases only — `armor`/`armour` deliberately still resolve to `metal` so
  // no existing caller silently changes material underneath it.
  lame: 'plate', lames: 'plate', cuirass: 'plate', pauldron: 'plate',
  greave: 'plate', warplate: 'plate',
  brass: 'gold', bronze: 'gold', copper: 'gold', gilt: 'gold',
  fabric: 'cloth', silk: 'cloth', linen: 'cloth', banner: 'cloth', wool: 'cloth',
  hide: 'leather', skin: 'flesh', meat: 'flesh', gore: 'blood',
  bones: 'bone', skull: 'bone', ivory: 'bone',
  soil: 'dirt', mud: 'dirt', ground: 'dirt', earth: 'dirt', sand: 'dirt',
  grass: 'moss', lichen: 'moss', algae: 'moss',
  dust: 'ash', cinder: 'ash', ember: 'ash', soot: 'ash',
};

/**
 * Per-kind material configuration. `physical` promotes the material to
 * MeshPhysicalMaterial where a second lobe genuinely matters (clearcoat on
 * wet blood and sealed leather, sheen on cloth and skin).
 */
export const KIND_MATERIAL = {
  stone: { normalScale: 1.0, envMapIntensity: 1.0, aoMapIntensity: 1.0 },
  cobble: { normalScale: 1.05, envMapIntensity: 1.0, aoMapIntensity: 1.05 },
  wood: { normalScale: 0.95, envMapIntensity: 0.9 },
  metal: { normalScale: 0.9, envMapIntensity: 1.15 },
  /* Armour is seen at half the distance a gate is, so the lame relief is pushed
     harder than sheet metal's; env intensity is held BELOW metal's because a
     body-sized conductor otherwise mirrors the sky over its whole silhouette and
     the surface disappears into a specular wash — which is the failure this kind
     exists to fix, so re-introducing it here would be self-defeating. */
  plate: { normalScale: 1.15, envMapIntensity: 0.92 },
  gold: { normalScale: 0.75, envMapIntensity: 1.35 },
  cloth: {
    normalScale: 0.85, envMapIntensity: 0.7, physical: true,
    props: { sheen: 0.55, sheenRoughness: 0.85, sheenColor: 0x6a4a44 },
  },
  leather: {
    normalScale: 0.9, envMapIntensity: 0.85, physical: true,
    props: { clearcoat: 0.18, clearcoatRoughness: 0.62 },
  },
  flesh: {
    normalScale: 0.7, envMapIntensity: 0.8, physical: true,
    props: { sheen: 0.3, sheenRoughness: 0.7, sheenColor: 0x7a3a30 },
  },
  bone: { normalScale: 0.95, envMapIntensity: 0.95 },
  dirt: { normalScale: 1.05, envMapIntensity: 0.85 },
  moss: {
    normalScale: 0.8, envMapIntensity: 0.75,
    props: { transparent: true, alphaTest: 0.32, side: 2 },
  },
  ash: { normalScale: 0.85, envMapIntensity: 0.8, props: { emissiveIntensity: 2.6 } },
  blood: {
    normalScale: 0.6, envMapIntensity: 1.1, physical: true,
    props: {
      clearcoat: 1.0, clearcoatRoughness: 0.06,
      transparent: true, alphaTest: 0.04,
    },
  },
};
