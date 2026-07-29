import * as THREE from 'three';
import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON, GLSL_GRADE } from './ShaderChunks.js';

/* ------------------------------------------------------------------ *
 *  Named film looks. Each one is baked into a 32^3 LUT at first use.
 *  All values operate on scene-linear data; the LUT stores the sRGB
 *  encoded result so it can be applied straight after tone mapping.
 *
 *  ART DIRECTION — the one rule every look here obeys
 *  --------------------------------------------------
 *  D4's palette is a DESATURATED COLD BASE (wet slate, iron, ash, bone)
 *  with WARM FIRELIGHT PUNCTUATION and one saturated accent. The render
 *  arriving at this pass does not have that: interiors are lit almost
 *  entirely by 1900 K practicals bouncing off brown stone, so the raw
 *  frame is a single warm hue edge to edge — the "monochrome sepia"
 *  failure. Three operators here fix it, and every look uses all three:
 *
 *    1. `wb` cools the whole plate. A brown mid (0.35,0.28,0.22) lands
 *       near-neutral; a saturated flame (1.0,0.45,0.12) stays orange
 *       because its chroma is an order of magnitude larger.
 *    2. `tame` is a hue-selective de-warming that runs on MID-TONES ONLY.
 *       It measures (R-B)/(R+B), and where that is positive in the mid
 *       band it pulls R toward luma and pushes B away from it. Stone lit
 *       by fire therefore reads as cold stone with a warm gradient across
 *       it, instead of as orange stone. Flame cores sit above the band and
 *       are untouched.
 *    3. The split tone then puts the warmth back where it is *motivated*:
 *       `shadowTint` and `midTint` are cold, `highTint` is hot, so the only
 *       warm pixels in the frame are the ones the fire is actually making.
 *
 *  `post.shoulder` is the knee of a filmic soft-clip applied live in
 *  GradePass (see FRAG). Without it, `(c - blackPoint)/(whitePoint - blackPoint)`
 *  with a whitePoint under 1.0 hard-clips everything above it, which is
 *  what turned every torch into a flat white disc: a plateau, not a
 *  highlight. The shoulder is C1 at the knee and asymptotic to 1, so a
 *  flame becomes a small intense core with a real falloff.
 * ------------------------------------------------------------------ */

export const LOOKS = {
  /** Torchlit crypt: cold slate base, amber firelight punctuation, hard blacks. */
  crypt: {
    // Cool the plate. This is the single biggest lever on "the frame is one
    // warm hue": at 1.00/0.985/1.03 the stone kept the torches' colour and
    // there was no cold anywhere in the image.
    wb: [0.915, 0.982, 1.112],
    slope: [1.02, 0.995, 0.975],
    offset: [-0.005, -0.004, -0.001],
    power: [1.02, 1.02, 1.0],
    contrast: 1.19,
    pivot: 0.165,
    // Mid-tone de-warming — see the header. Band is expressed in LINEAR luma:
    // 0.004..0.03 fades in over the low mids, 0.20..0.78 fades out before the
    // flame cores so fire keeps its hue.
    tame: 0.62, tameIn: [0.004, 0.030], tameOut: [0.20, 0.78],
    // Wet slate and iron, not navy. At B = 1.30 / amt 0.88 the shadows measured
    // a per-pixel saturation over 0.53 — cold, but a *saturated* cold, which is
    // the same crime as the sepia in the other direction.
    shadowTint: [0.765, 0.880, 1.235],
    shadowAmt: 0.80,
    midTint: [0.900, 0.972, 1.108],
    midAmt: 0.52,
    highTint: [1.19, 1.005, 0.71],
    highAmt: 0.64,
    sat: 0.66,
    satHi: 0.46,
    satLo: 0.98,
    toe: [0.0, 0.003, 0.014],
    shoulder: [0.09, 0.13, 0.20],
    post: {
      // blackPoint was 0.020 with a hard clip, which is 5/255 — a third of every
      // crypt frame sat under it and went to pure black. The pedestal is now
      // 0.008 with a soft floor, and the shadow lift rebuilds the bottom decade
      // into cold slate instead of a hole. whitePoint 0.80 + shoulder 0.72 is
      // what puts a real specular on wet stone and armour.
      blackPoint: 0.014, whitePoint: 0.84, blackSoft: 0.30, contrast: 1.30, pivot: 0.42,
      shadowLift: 2.30, shadowKnee: 0.070, shadowChroma: 0.76,
      // The mildest toe of any look, because the crypt's 0.014 pedestal is the
      // one that was not crushing much: measured, the fixed bake alone already
      // brings a 0.02 input to 2.1/255 here where `hell` reaches 1.3. The toe
      // takes it to 3.1/255 and leaves everything from 0.16 up untouched.
      toeKnee: 0.100, toeGamma: 0.85,
      saturation: 0.54, highlightDesat: 0.44, tintAmount: 0.26, shoulder: 0.64,
      shadowTint: [0.90, 0.965, 1.10], highlightTint: [1.08, 1.0, 0.91],
    },
  },

  /** Hell arena: basalt base, ember accent, violet-black shadows. */
  hell: {
    // Hellfire is the ACCENT, not the palette. At 1.07/0.98/0.93 the whole
    // arena — floor, walls, bones, sky — was one sepia field.
    wb: [0.925, 0.972, 1.108],
    slope: [1.02, 0.978, 0.968],
    offset: [-0.003, -0.005, -0.004],
    power: [1.0, 1.02, 1.02],
    contrast: 1.28,
    pivot: 0.150,
    tame: 0.78, tameIn: [0.005, 0.034], tameOut: [0.30, 0.90],
    shadowTint: [0.86, 0.82, 1.16],
    shadowAmt: 0.72,
    midTint: [0.93, 0.955, 1.075],
    midAmt: 0.52,
    highTint: [1.22, 0.945, 0.60],
    highAmt: 0.70,
    sat: 0.62,
    satHi: 0.40,
    satLo: 0.92,
    toe: [0.010, 0.002, 0.006],
    shoulder: [0.07, 0.12, 0.20],
    post: {
      // blackPoint 0.150 was set against a build whose ember fog floored the
      // frame in the upper mids. It no longer does: the same number then sent
      // 42 % of the arena to pure black. A hell arena is basalt lit by fire —
      // the rock between the braziers must still read.
      blackPoint: 0.085, whitePoint: 0.70, blackSoft: 0.24, contrast: 1.34, pivot: 0.42,
      shadowLift: 1.55, shadowKnee: 0.055, shadowChroma: 0.78,
      // The heaviest pedestal of any interior look (0.085 = 22/255 of input), so
      // it is the look that most needs a toe under it: basalt between the
      // braziers has to read as rock, not as the same hole as the shadow. This
      // is the look the merged-black measurement was taken on — see the header
      // of buildLookLUT for the before/after ramp.
      toeKnee: 0.140, toeGamma: 0.78,
      saturation: 0.48, highlightDesat: 0.34, tintAmount: 0.24, shoulder: 0.64,
      shadowTint: [0.92, 0.95, 1.10], highlightTint: [1.10, 0.99, 0.87],
    },
  },

  /**
   * Storm moor: steel blue, desaturated, soft light, still deep blacks.
   *
   * CONTRAST RECOVERY. An overcast exterior integrates fog over the whole
   * frame, so the raw render arrives with its darkest percentile already at
   * ~0.09 display-referred and a standard deviation under 0.10 — a grey wash
   * with no true black anywhere. This look therefore lifts the black point to
   * where the haze floor actually sits and pushes real contrast in both the
   * baked LUT and the live post stage. It is the only look that needs this,
   * because it is the only look applied to a fog-dominated daylight exterior.
   */
  moor: {
    // The moor's job is the opposite of the crypt's. There is no fire out here,
    // so nothing has to be de-warmed — but the plate arrives ALREADY cold, and
    // the previous 0.945/1.075 white balance on top of a blue hemisphere and
    // blue fog is what produced a measured 1.25:1 blue-over-red across every
    // pixel in the frame. Wet slate is a near-neutral grey; the cold read comes
    // from the value structure and from the single warm campfire, not from tint.
    wb: [0.985, 0.998, 1.022],
    slope: [1.0, 1.0, 1.01],
    offset: [-0.009, -0.008, -0.005],
    power: [1.04, 1.01, 1.0],
    contrast: 1.30,
    pivot: 0.140,
    // Already cold; the tame only has to kill the mud in the mid-ground.
    tame: 0.24, tameIn: [0.006, 0.040], tameOut: [0.26, 0.85],
    shadowTint: [0.915, 0.965, 1.095],
    shadowAmt: 0.58,
    midTint: [0.98, 1.0, 1.025],
    midAmt: 0.34,
    highTint: [1.04, 1.02, 1.0],
    highAmt: 0.30,
    sat: 0.70,
    satHi: 0.52,
    satLo: 0.72,
    toe: [0.0, 0.0, 0.004],
    shoulder: [0.05, 0.055, 0.070],
    post: {
      // blackPoint 0.108 was a contrast-recovery hack for a fog wash that has
      // since been fixed; against the current render it crushed a fifth of the
      // moor and multiplied the remaining blue by 1/0.8. Modest pedestal, low
      // ceiling for a real highlight on wet rock, and the saturation pulled
      // down hard because this is the one look measuring a colour *cast*.
      blackPoint: 0.138, whitePoint: 0.50, blackSoft: 0.10, contrast: 1.52, pivot: 0.40,
      shadowLift: 1.00, shadowKnee: 0.070, shadowChroma: 0.82,
      // Pedestal 0.138 with soft 0.10 and the only look with no shadow lift at
      // all: measured, it put EVERY input under 0.04 at 0.00/255 and 0.08 at
      // 0.02/255 — the hardest crush of the five. It gets the strongest toe.
      toeKnee: 0.160, toeGamma: 0.70,
      saturation: 0.56, highlightDesat: 0.58, tintAmount: 0.18, shoulder: 0.78,
      shadowTint: [0.94, 0.975, 1.07], highlightTint: [1.02, 1.01, 0.99],
    },
  },

  /** Town at dusk: cold blue air, brazier gold as the only warm thing in frame. */
  town: {
    // A dusk key at 2200-2600 K plus warm ground albedo made every pixel of the
    // hub the same pink-brown. The air at dusk is BLUE; only what the braziers
    // touch is gold.
    wb: [0.955, 0.99, 1.095],
    slope: [1.02, 1.0, 0.985],
    offset: [-0.004, -0.004, -0.002],
    power: [1.0, 1.0, 1.0],
    contrast: 1.17,
    pivot: 0.175,
    tame: 0.54, tameIn: [0.005, 0.032], tameOut: [0.22, 0.80],
    shadowTint: [0.858, 0.945, 1.150],
    shadowAmt: 0.72,
    midTint: [0.932, 1.018, 1.046],
    midAmt: 0.50,
    highTint: [1.20, 1.02, 0.70],
    highAmt: 0.62,
    sat: 0.78,
    satHi: 0.55,
    satLo: 0.92,
    toe: [0.003, 0.003, 0.010],
    shoulder: [0.09, 0.12, 0.19],
    post: {
      // The hub measured mean 0.099 with 31 % pure black and a p99 of 0.56 —
      // a frame with no shadow information and nothing bright in it, i.e. both
      // failures at once. The pedestal comes almost all the way off, the lift
      // rebuilds the cobbles between the braziers, and the ceiling drops so the
      // brazier pools actually reach white.
      blackPoint: 0.028, whitePoint: 0.72, blackSoft: 0.26, contrast: 1.38, pivot: 0.44,
      shadowLift: 1.85, shadowKnee: 0.058, shadowChroma: 0.76,
      // Cobbles between the brazier pools are the whole subject of this framing,
      // and they live exactly in the band the toe covers: measured, the old
      // curve held every input below 0.04 at 0.16/255 flat, so the cobbles and
      // the gaps between them carried the same value.
      toeKnee: 0.110, toeGamma: 0.84,
      saturation: 0.60, highlightDesat: 0.42, tintAmount: 0.24, shoulder: 0.74,
      shadowTint: [0.92, 0.96, 1.11], highlightTint: [1.08, 1.01, 0.91],
    },
  },

  /**
   * Night exterior: moonlight is a COLD, DIM key with deep shadow — not a blue
   * filter over everything.
   *
   * Measured at the previous settings: mean 0.25 with 4.4 % black and a
   * per-pixel saturation of 0.517, i.e. a uniform oversaturated blue wash with
   * compressed midtones. The white point was the cause — 0.30 expanded a frame
   * whose real peak was ~0.19 by 3.3x, which lifted every shadow into the mids
   * and multiplied the blue cast along with it.
   */
  night: {
    wb: [0.945, 0.985, 1.085],
    slope: [0.985, 0.995, 1.025],
    offset: [-0.005, -0.005, -0.002],
    power: [1.04, 1.02, 1.0],
    contrast: 1.24,
    pivot: 0.160,
    tame: 0.18, tameIn: [0.005, 0.030], tameOut: [0.20, 0.80],
    shadowTint: [0.80, 0.90, 1.21],
    shadowAmt: 0.70,
    midTint: [0.955, 0.99, 1.055],
    midAmt: 0.34,
    // Moonlit stone catches a SILVER highlight, not a blue one. Anything the
    // moon actually hits has to be close to neutral or the frame reads as a
    // filter rather than as light.
    highTint: [1.02, 1.01, 1.015],
    highAmt: 0.34,
    sat: 0.60,
    satHi: 0.46,
    satLo: 0.80,
    toe: [0.0, 0.002, 0.008],
    shoulder: [0.10, 0.10, 0.09],
    post: {
      // Then measured at mean 0.063 with 77 % of the frame under 5/255: the
      // pedestal at 0.058 was above almost every pixel in the image, so the
      // moor at night was not dark, it was *deleted*. A night frame is the one
      // that needs the most shadow reconstruction and the least chroma: the
      // strongest lift of any look, the widest knee, and the hardest pull to
      // slate so a dim cold key reads as moonlight rather than a blue filter.
      blackPoint: 0.075, whitePoint: 0.67, blackSoft: 0.13, contrast: 1.65, pivot: 0.38,
      shadowLift: 1.90, shadowKnee: 0.065, shadowChroma: 0.70,
      // The highest contrast (1.65) over the second-heaviest pedestal, which
      // measured 0.01/255 out of a 0.04 input — a moonlit rock and the ground it
      // stands on were the same number. Second-strongest toe of the five; the
      // knee stays under moor's because a night frame has the most area sitting
      // in the band and is the one most at risk of coming up milky.
      toeKnee: 0.150, toeGamma: 0.72,
      // A cooler luma-neutral for the shadow pull. Moonlit shadow is bluer than
      // crypt shadow, and this is the only place in the grade where that colour
      // can be stated without also multiplying the chroma of near-black pixels.
      slate: [0.8919, 1.0087, 1.2317],
      saturation: 0.68, highlightDesat: 0.52, tintAmount: 0.26, shoulder: 0.74,
      shadowTint: [0.90, 0.955, 1.14], highlightTint: [1.0, 1.0, 1.03],
    },
  },
};

/* ---------------------------- LUT baking ---------------------------- */

const LW = [0.2126, 0.7152, 0.0722];

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ *
 *  BOTTOM-END DISCIPLINE IN THE BAKE
 *
 *  The three constants below all fix the same class of bug, and between them
 *  they were the whole of the "dark objects weld into one solid black shape"
 *  failure. Measured on a frozen `?shot=boss` frame, the grey-ramp response of
 *  the old bake plus the old live stage was:
 *
 *    in  0.000  0.005  0.010  0.020  0.040  0.080  0.160   (display-referred)
 *    out  0.27   0.27   0.27   0.27   0.28   0.92  11.67   (/255)
 *
 *  A PLATEAU three code values wide covering the bottom 4 % of the input range,
 *  then a near-vertical rise. Every unlit surface in the frame therefore
 *  resolved to the same single value regardless of how much light it actually
 *  received, which is exactly "one solid black shape", and the rise immediately
 *  above the plateau is what drew a hard outline around it. Three separate
 *  operators in this function each independently flattened the bottom:
 *
 *    - the CDL `offset`, a NEGATIVE number applied in SCENE-LINEAR units and
 *      then clipped with max(0,...). `hell` subtracts 0.003 linear, and
 *      display 0.036 sRGB *is* 0.0028 linear — so the clip alone deleted
 *      everything under 9/255 of input;
 *    - the `contrast` power law about a pivot of 0.15, whose slope at 1/50th of
 *      the pivot is 0.28 and keeps falling;
 *    - the additive `toe`, which lands a flat +0.010 on a channel at v=0. Any
 *      constant added at the bottom of a curve is a plateau by construction:
 *      the constant swamps the signal and every input below it maps to the same
 *      output.
 *
 *  None of the three is *wrong* as art direction — deep blacks, heavy mids and
 *  a coloured shadow are the whole look. They were wrong as *arithmetic*: each
 *  destroyed information rather than compressing it, and no downstream stage can
 *  recover a plateau. So the subtraction keeps a fraction of what it takes, the
 *  power law relaxes to unity slope at the bottom, and the lift is ramped in
 *  from zero. All three still map 0 to exactly 0.
 * ------------------------------------------------------------------ */

/**
 * Fraction of the sub-offset scene-linear signal that survives the CDL's black
 * subtraction instead of clipping to zero. Above the offset the curve is
 * unchanged but for a constant `floor * offset` (0.001 linear at most — under
 * 1/40th of a code value at mid grey), so this buys back the bottom decade
 * without touching the look.
 */
const CDL_SOFT_FLOOR = 0.35;

/**
 * Knee of the linear-space contrast toe, in pivot-normalised units. 0.03 of a
 * 0.15 pivot is 0.0045 scene-linear ~ 15/255 display, i.e. the relaxation is
 * confined to the deep shadows and the low mids up are untouched.
 */
const LUT_CONTRAST_TOE = 0.03;

/**
 * Display-referred value over which the look's additive `toe` fades in. Below
 * this the shadow's colour comes from the multiplicative `shadowTint` split
 * (which cannot plateau), above it the authored lift is at full strength.
 */
const TOE_ANCHOR = 0.030;

/**
 * `pivot * (v/pivot)^g` with the exponent relaxed to 1 below `knee`. Identical
 * to the plain power law at and above the knee, unity slope as v -> 0, and
 * 0 -> 0. The GLSL twin lives in GLSL_GRADE — change both together.
 */
function contrastToe(v, pivot, g, knee) {
  const u = Math.max(0, v) / pivot;
  const q = 1 + (g - 1) * smoothstep(0, knee, u);
  return pivot * Math.pow(u, q);
}

/**
 * Bakes one named look into a 32^3 RGBA LUT.
 * @param {string} name
 * @param {number} size
 * @returns {THREE.Data3DTexture}
 */
export function buildLookLUT(name, size = 32) {
  const L = LOOKS[name] ?? LOOKS.crypt;
  const n = Math.max(2, size | 0);
  const data = new Uint8Array(n * n * n * 4);
  const inv = 1 / (n - 1);
  const c = [0, 0, 0];
  const tame = L.tame ?? 0;
  const tIn = L.tameIn ?? [0.005, 0.032];
  const tOut = L.tameOut ?? [0.22, 0.80];
  let p = 0;

  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        // --- decode grid point to linear ---
        c[0] = srgbToLinear(ri * inv);
        c[1] = srgbToLinear(gi * inv);
        c[2] = srgbToLinear(bi * inv);

        // --- white balance ---
        for (let k = 0; k < 3; k++) c[k] *= L.wb[k];

        // --- ASC CDL: slope / offset / power, with a soft black floor ---
        for (let k = 0; k < 3; k++) {
          const off = L.offset[k];
          const x = Math.max(0, c[k] * L.slope[k] + Math.max(0, off));
          const sub = Math.max(0, -off);
          const v = CDL_SOFT_FLOOR * x + (1 - CDL_SOFT_FLOOR) * Math.max(x - sub, 0);
          c[k] = Math.pow(v, L.power[k]);
        }

        // --- contrast about a low pivot: mid-tones stay heavy ---
        for (let k = 0; k < 3; k++) {
          c[k] = contrastToe(c[k], L.pivot, L.contrast, LUT_CONTRAST_TOE);
        }

        let l = c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];

        /* --- mid-tone de-warming: cold stone, not orange stone ---------------
         * The frame's warmth is *light*, not *material*, so it has to be
         * removed where the material dominates (the mids) and left where the
         * light dominates (the top). `warm` is a cheap chroma-axis measure of
         * how far along the blue<->orange axis the pixel sits.
         */
        if (tame > 0) {
          const band = smoothstep(tIn[0], tIn[1], l) * (1 - smoothstep(tOut[0], tOut[1], l));
          if (band > 0.001) {
            const sum = c[0] + c[2];
            const warm = sum > 1e-5 ? (c[0] - c[2]) / sum : 0;
            if (warm > 0.04) {
              const k = tame * band * smoothstep(0.04, 0.42, warm);
              c[0] += (l - c[0]) * k;             // red toward luma
              c[1] += (l - c[1]) * k * 0.45;      // green a little
              c[2] -= (l - c[2]) * k * 0.55;      // blue AWAY from luma
              for (let q = 0; q < 3; q++) if (c[q] < 0) c[q] = 0;
              l = c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];
            }
          }
        }

        // --- split tone: cold shadows, cold mids, warm highlights only ---
        const wS = 1 - smoothstep(0.0, 0.16, l);
        const wH = smoothstep(0.16, 0.9, l);
        const wM = 1 - Math.abs(smoothstep(0.0, 0.36, l) * 2 - 1);
        for (let k = 0; k < 3; k++) {
          c[k] *= 1 + (L.shadowTint[k] - 1) * L.shadowAmt * wS;
          c[k] *= 1 + (L.midTint[k] - 1) * L.midAmt * wM;
          c[k] *= 1 + (L.highTint[k] - 1) * L.highAmt * wH;
        }

        // --- saturation with rolloff at both ends ---
        l = c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];
        const satHiW = smoothstep(0.18, 1.1, l);
        const satLoW = 1 - smoothstep(0.0, 0.05, l);
        const s = L.sat * (1 + (L.satHi - 1) * satHiW) * (1 + (L.satLo - 1) * satLoW);
        for (let k = 0; k < 3; k++) c[k] = l + (c[k] - l) * s;

        // --- back to display space, then per-channel toe + shoulder ---
        for (let k = 0; k < 3; k++) {
          let v = linearToSrgb(Math.max(0, c[k]));
          const t = 1 - v;
          v += L.toe[k] * t * t * t * t * smoothstep(0, TOE_ANCHOR, v);
          const sh = L.shoulder[k];
          v = (v * (1 + sh)) / (1 + sh * v);
          c[k] = Math.min(1, Math.max(0, v));
        }

        data[p++] = Math.round(c[0] * 255);
        data[p++] = Math.round(c[1] * 255);
        data[p++] = Math.round(c[2] * 255);
        data[p++] = 255;
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.generateMipmaps = false;
  tex.name = `Sanctum.LUT.${name}`;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The live stage. Everything the grade does now lives in `sanctumGrade` (shared
 * with the merged CompositePass so the low tiers resolve the same image): the
 * LUT, the soft pedestal, contrast, shadow reconstruction, split tone,
 * saturation rolloff and the filmic highlight shoulder.
 */
const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_GRADE}

uniform sampler2D tDiffuse;
varying vec2 vUv;

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  gl_FragColor = vec4( sanctumGrade( base.rgb ), base.a );
}
`;

/**
 * A luma-neutral cold grey. `l * SLATE` has the same luminance as `l` — the
 * weights sum to 1 against Rec.709 — so pulling a shadow toward it changes its
 * hue and kills its chroma without changing how dark it is.
 */
export const SLATE = [0.9216, 1.0074, 1.1574];

/** Shared uniform block for the grade, reused by the merged composite path. */
export function gradeUniforms() {
  return {
    uLut: { value: null },
    uLutSize: { value: 32 },
    uLutStrength: { value: 1.0 },
    uBlackPoint: { value: 0.010 },
    uWhitePoint: { value: 0.80 },
    uBlackSoft: { value: 0.34 },
    uBlackKnee: { value: 0.45 },
    uContrast: { value: 1.15 },
    uPivot: { value: 0.42 },
    uContrastToe: { value: 0.10 },
    uShadowLift: { value: 1.9 },
    uShadowKnee: { value: 0.055 },
    uShadowChroma: { value: 0.72 },
    uSlate: { value: new THREE.Color(SLATE[0], SLATE[1], SLATE[2]) },
    uToeKnee: { value: 0.09 },
    uToeGamma: { value: 0.85 },
    uSaturation: { value: 0.56 },
    uHighlightDesat: { value: 0.40 },
    uShadowTint: { value: new THREE.Color(0.88, 0.955, 1.13) },
    uHighlightTint: { value: new THREE.Color(1.09, 1.0, 0.90) },
    uTintAmount: { value: 0.28 },
    uShoulder: { value: 0.72 },
  };
}

/** Pushes the current params into a grade uniform block. */
export function syncGradeUniforms(u, params, lutCache) {
  const look = LOOKS[params.grade] ? params.grade : 'crypt';
  let tex = lutCache.get(look);
  if (!tex) {
    tex = buildLookLUT(look, 32);
    lutCache.set(look, tex);
  }
  u.uLut.value = tex;
  u.uLutSize.value = 32;
  u.uLutStrength.value = params.gradeStrength;
  u.uBlackPoint.value = params.blackPoint;
  u.uWhitePoint.value = params.whitePoint;
  u.uBlackSoft.value = params.blackSoft ?? 0.34;
  u.uBlackKnee.value = params.blackKnee ?? 0.45;
  u.uContrast.value = params.gradeContrast;
  u.uPivot.value = params.gradePivot;
  u.uContrastToe.value = params.contrastToe ?? 0.10;
  u.uShadowLift.value = params.shadowLift ?? 1.9;
  u.uShadowKnee.value = params.shadowKnee ?? 0.055;
  u.uShadowChroma.value = params.shadowChroma ?? 0.72;
  u.uToeKnee.value = params.toeKnee ?? 0.09;
  u.uToeGamma.value = params.toeGamma ?? 1.0;
  u.uSaturation.value = params.saturation;
  u.uHighlightDesat.value = params.highlightDesat;
  u.uTintAmount.value = params.tintAmount;
  u.uShoulder.value = params.gradeShoulder ?? 0.72;
  const sl = params.slate ?? SLATE;
  u.uSlate.value.setRGB(sl[0], sl[1], sl[2]);
  const st = params.shadowTint;
  const ht = params.highlightTint;
  u.uShadowTint.value.setRGB(st[0], st[1], st[2]);
  u.uHighlightTint.value.setRGB(ht[0], ht[1], ht[2]);
}

/**
 * Filmic colour grade: baked 32^3 look LUT plus live lift/contrast, split
 * toning, highlight saturation rolloff and a filmic highlight shoulder. Runs on
 * display-referred pixels, i.e. after the ACES tone map.
 */
export class GradePass extends QuadPass {
  constructor(params, lutCache) {
    super(FRAG, { tDiffuse: { value: null }, ...gradeUniforms() }, {}, 'Sanctum.Grade');
    this.params = params;
    this.lutCache = lutCache;
    this.needsSwap = true;
  }

  beforeRender() {
    syncGradeUniforms(this.uniforms, this.params, this.lutCache);
  }
}
