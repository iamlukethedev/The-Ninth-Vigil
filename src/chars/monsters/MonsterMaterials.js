/**
 * SANCTUM — MonsterMaterials
 *
 * One place that turns AssetForge map sets into the surfaces the bestiary needs,
 * and injects the per-instance effects every enemy shares:
 *
 *   1. **albedo floor** — lifts crushed albedo into [floor, 1] so cloth, bone and
 *                        flesh have somewhere to read instead of resolving as a
 *                        black cutout. See `RECIPES` and `FRAG_EFFECTS`.
 *   2. **character rim** — every surface opts in to Lighting's camera-tracking
 *                        cold back light (`userData.charRim`), so an enemy
 *                        silhouette separates from the floor the same way the
 *                        hero's does. This is the other half of the same fix.
 *   3. **hit flash**   — a brief emissive punch, driven as emissive so it blooms
 *                        and tonemaps correctly instead of being pasted on top.
 *   4. **dissolve**     — noise-threshold discard with a glowing edge, swept from
 *                        the feet upward. This is the death exit; nothing pops.
 *   5. **elite aura**   — three-lobe rim emissive in the champion's accent hue.
 *   6. **ghost/phase**  — fresnel-weighted alpha for the wraith.
 *
 * Textures are generated once per recipe and shared by every instance
 * (`AssetForge.pbr` is cached, and clones share `Texture.source`). Materials
 * themselves are *not* cloned — `THREE.Material.copy()` runs userData through
 * JSON, which would destroy the uniform objects — so each instance builds a
 * fresh material around the shared maps. That costs a few uniform uploads and
 * nothing else: the shader cache key is identical, so all instances of all
 * archetypes collapse into a handful of programs.
 *
 * UVs are authored in metres by SkinBuilder, so every recipe requests
 * `tiling: 1` and lets the geometry decide the physical scale of the grain.
 */

import * as THREE from 'three';
// grimeFn() below is built on RigKit's deterministic noise + smoothstep.
import { fbm3, smoothstep } from './RigKit.js';

/**
 * `uv` = metres per texture repeat, applied when the geometry is built.
 *
 * MEASURED against the on-screen size, which is the only place the number means
 * anything. At the gameplay camera (24-34 m, 1600x900) an enemy occupies 60-100
 * px and its texture repeat covers 9-11 px — so every frequency the map carries,
 * including the largest one a tiling texture can hold, was landing at 1-2 px and
 * being averaged into a flat colour by mip selection. These are therefore ~1.7x
 * their old values, which puts the new macro tier (2 cycles per repeat, see
 * texgen's macroField) at 7-8 px on a 90 px figure: a value break-up the eye
 * reads as weathering. They are NOT raised further, because at 0.42 m per repeat
 * bone's trabecular tier already sits at 19 mm, and past roughly 25 mm a
 * character starts to read as the "macro photograph" failure KNOWN_ISSUES.md
 * calls out.
 *
 * `albedo` = target MEAN scene-linear diffuse albedo luma for the surface, and it
 * replaces brightness-by-accident with brightness-on-purpose.
 *
 * Measured material colours from the live combat scenario are extremely dark —
 *
 *   cultist:cloth  [0.092, 0.059, 0.063]      skeleton:cloth [0.145, 0.108, 0.073]
 *   brute:cloth    [0.116, 0.084, 0.049]      hellhound:ember [0.252, 0.056, 0.011]
 *
 * — and that colour multiplies the albedo MAP (measured mean linear luma: bone
 * 0.234, metal 0.135, cloth 0.019, charred flesh 0.005) and again the per-vertex
 * grime term (mean 0.87), so a cultist's robe was arriving at the BRDF at 0.0018
 * scene-linear. That is coal. The previous fix for it was a flat additive albedo
 * floor of 0.06-0.10, which did stop the black cutouts but at 48x the surface's
 * own value it also became the surface: it is the measured cause of the enemies
 * reading as near-white featureless blobs (silhouette mean luma 0.71 with 30 % of
 * pixels blown past 0.9, against the hero's 0.47 and 11 %).
 *
 * So instead each recipe now declares the albedo it wants and `make()` solves for
 * the gain: `gain = albedo / (mapMean * tintLuma)`. A gain preserves 100 % of the
 * map's relative contrast — including the macro tier — where an additive pedestal
 * destroys it. Metal and brass declare none: on a metal the albedo map is specular
 * F0 and iron's 0.56 linear is physics, not taste.
 *
 * THE NUMBERS ARE SET BY WHERE THE PIXEL LANDS, not by a reflectance table, and
 * that is the point. Dry bone reflects about 0.55 in the real world; at this
 * scenario's exposure an albedo of 0.55 renders at display luma 0.95, i.e. CLIPPED,
 * and a clipped pixel cannot show structure no matter how good the map behind it
 * is. Measured on the combat capture at albedo 0.098: bone silhouette mean 0.626
 * with 13.4 % of its pixels past 0.9 — the skull was a blank white egg with a
 * perfectly good 0.20-relative-contrast map underneath it. Every value here is
 * therefore chosen so the surface sits in the 0.40-0.55 display band where the
 * macro tier is actually visible, and the relative ordering is preserved: bone is
 * still the palest thing on a skeleton at 0.061, burnt hound hide the darkest
 * at 0.023.
 *
 * `floor` = ALBEDO FLOOR, in scene-linear units, still present but now a genuine
 * safety net rather than the dominant term, and textured by the map instead of
 * flat (see FRAG_EFFECTS). It is what keeps a robe in an unlit corner from
 * resolving as a hole.
 *
 * It is also CAPPED at 28 % of the recipe's own `albedo` target, and that cap is
 * doing real work. An absolute floor cannot be right for a library whose targets
 * span 0.012 to 0.098: at charred hide's 0.012 the declared 0.022 floor was
 * 65 % of the entire diffuse term, so the burnt hound was mostly pedestal again —
 * the same failure as the original bug, three per cent of the way down the
 * brightness range. As a fraction the floor is always a lift and never the
 * surface, whatever the recipe is worth.
 *
 * `rim` = gain on Lighting's CHARACTER RIM, and these are ~40 % of what they were.
 *
 * The rim is a fresnel-weighted ADDITIVE band, so like the aura it carries no
 * surface structure at all. On the hero, whose limbs are 20-30 px wide at the
 * gameplay camera, the fresnel term only catches a genuine edge and the effect is
 * the intended separation. On enemies it is not: a skeleton's femur is 4-8 px
 * wide, a hellhound's leg 5 px, so the glancing-normal band covers the whole body
 * and the term becomes a flat wash. A/B measured on the combat capture with the
 * rim compiled out entirely: pack silhouette mean luma 0.576 -> 0.502 and
 * blown-highlight share 0.177 -> 0.124, i.e. the rim alone was 13 % of an enemy's
 * brightness and 30 % of its clipping. Cut rather than removed, because
 * separation from the floor is a different critic axis and the enemies used to
 * fail it: at these gains the measured enemy-to-floor luma separation is still
 * 0.16-0.30 against tools/actors.mjs's 0.05 invisibility threshold.
 *
 * `wear` = [edgeGain, cavityGain, edgeRoughness, cavityRoughAdd] for the
 * curvature-driven coupled wear layer, and `wearCol` is the material UNDER the
 * finish. See the wear block in FRAG_EFFECTS and RigKit.curvatureAttr. The
 * coupling is a material property, so the numbers are per recipe: iron polishes
 * to a bright specular and tarnishes nearly black, bone chalks to a dull pale
 * and only stains, cloth does neither and is left at zero.
 */
export const RECIPES = {
  /* Bone's cavity gain is the highest of the non-metals, and that is aimed at
     one feature: skullGeo now carves real orbits, and an orbit that is not
     markedly darker than the cheek beside it is a dimple, not an eye socket.
     The skeletons are only ~14 px tall on screen, so the socket has to win on
     VALUE — there is no room for it to win on shape. */
  bone:   { kind: 'bone',    uv: 0.42, seed: 611,  normalScale: 1.15, env: 0.75, rough: 1.0, floor: 0.024, albedo: 0.061, rim: 0.50, wear: [0.34, 0.76, 0.62, 0.24], wearCol: [0.190, 0.184, 0.166] },
  boneOld:{ kind: 'bone',    uv: 0.46, seed: 977,  normalScale: 1.25, env: 0.55, rough: 1.0, tint: [0.78, 0.74, 0.66], floor: 0.024, albedo: 0.052, rim: 0.50, wear: [0.30, 0.78, 0.68, 0.26], wearCol: [0.160, 0.152, 0.132] },
  flesh:  { kind: 'flesh',   uv: 0.42, seed: 233,  normalScale: 1.1,  env: 0.6,  floor: 0.026, albedo: 0.066, rim: 0.65, wear: [0.16, 0.46, 0.42, 0.12], wearCol: [0.150, 0.086, 0.078] },
  rot:    { kind: 'flesh',   uv: 0.44, seed: 809,  normalScale: 1.25, env: 0.5,  tint: [0.70, 0.78, 0.62], floor: 0.026, albedo: 0.044, rim: 0.65, wear: [0.16, 0.50, 0.42, 0.12], wearCol: [0.120, 0.106, 0.070] },
  charred:{ kind: 'flesh',   uv: 0.36, seed: 1471, normalScale: 1.35, env: 0.45, tint: [0.30, 0.26, 0.25], floor: 0.022, albedo: 0.012, rim: 0.80, wear: [0.30, 0.55, 0.50, 0.18], wearCol: [0.115, 0.090, 0.074] },
  cloth:  { kind: 'cloth',   uv: 0.50, seed: 353,  normalScale: 1.0,  env: 0.45, floor: 0.028, albedo: 0.072, rim: 0.85, wear: [0.20, 0.40, 0.78, 0.10], wearCol: [0.135, 0.126, 0.112] },
  hide:   { kind: 'leather', uv: 0.46, seed: 457,  normalScale: 1.1,  env: 0.55, floor: 0.026, albedo: 0.068, rim: 0.75, wear: [0.28, 0.48, 0.44, 0.16], wearCol: [0.150, 0.122, 0.094] },
  metal:  { kind: 'metal',   uv: 0.38, seed: 733,  normalScale: 0.95, env: 1.15, floor: 0.018, rim: 0.80, wear: [0.52, 0.66, 0.17, 0.26], wearCol: [0.330, 0.334, 0.348], wearM: [1.0, 0.14] },
  brass:  { kind: 'gold',    uv: 0.26, seed: 1093, normalScale: 0.8,  env: 1.3,  floor: 0.018, rim: 0.70, wear: [0.46, 0.62, 0.16, 0.24], wearCol: [0.380, 0.300, 0.150], wearM: [1.0, 0.18] },
  basalt: { kind: 'stone',   uv: 0.48, seed: 1279, normalScale: 1.2,  env: 0.7,  tint: [0.55, 0.50, 0.52], floor: 0.024, albedo: 0.058, rim: 0.72, wear: [0.30, 0.50, 0.66, 0.18], wearCol: [0.165, 0.158, 0.162] },
  ember:  { kind: 'ash',     uv: 0.26, seed: 1613, normalScale: 0.9,  env: 0.5,  floor: 0.022, albedo: 0.038, rim: 0.60 },

  /* ---------------------------------------------------------------------- *
   * WARDEN SET — boss-scale materials.
   *
   * The warden is 5.4 m tall and 322 px on screen in the `boss` capture, three
   * to four times any other enemy, and it was wearing recipes authored for a
   * burnt hellhound (`charred`) and for crypt masonry (`basalt`). Two separate
   * failures came out of that:
   *
   *  1. `charred` targets albedo 0.012 — by a factor of five the darkest recipe
   *     in the library. ABLATION on the live boss frame: zeroing the diffuse
   *     contribution from the albedo map moved the torso's display luma from
   *     0.325 to 0.199, i.e. only 39 % of what the torso reads came from the one
   *     term that can carry surface structure at all. The other 61 % was rim,
   *     aura, albedo floor and specular, none of which has any texture in it.
   *     That ratio IS the "untextured flat-colour geometry" flag.
   *  2. Every recipe's `uv` is authored for a 1.7-2.2 m enemy. At 0.36 m per
   *     repeat the warden's torso carries 9 repeats across a 1.9 m chest, so the
   *     largest thing the texture can say lands at ~7 px on a 322 px figure.
   *
   * These four fix both: a much larger share of the value comes from the map,
   * and the repeats are scaled to the body carrying them, so the macro tier
   * lands at 20-30 px where the eye reads it as forged plate rather than noise.
   *
   * The albedo targets are solved against the HERO CUIRASS, which is this
   * project's known-good reference surface: masked mean display luma 0.400 in
   * `shots/closeup.png`. A first pass at hide 0.046 / bone 0.070 fixed the
   * structure but measured the torso at 0.644 and the thigh at 0.607 — a 60 %
   * overshoot of the reference, which is just the opposite failure. At the
   * values below the torso measures 0.442 against the hero's 0.400.
   * ------------------------------------------------------------------------ */
  wardenPlate: { kind: 'plate', uv: 0.62, seed: 2141, normalScale: 1.30, env: 0.92, floor: 0.020, albedo: 0.138, rim: 0.42, wear: [0.62, 0.72, 0.15, 0.30], wearCol: [0.355, 0.360, 0.375], wearM: [0.95, 0.12] },
  wardenIron:  { kind: 'plate', uv: 0.40, seed: 2273, normalScale: 1.20, env: 1.00, floor: 0.018, rim: 0.50, wear: [0.58, 0.70, 0.16, 0.28], wearCol: [0.340, 0.344, 0.360], wearM: [1.00, 0.14] },
  wardenBone:  { kind: 'bone',  uv: 0.30, seed: 2311, normalScale: 1.35, env: 0.62, rough: 1.0, tint: [0.74, 0.71, 0.66], floor: 0.022, albedo: 0.039, rim: 0.38, wear: [0.40, 0.80, 0.60, 0.28], wearCol: [0.215, 0.206, 0.184] },
  wardenHide:  { kind: 'leather', uv: 0.54, seed: 2377, normalScale: 1.30, env: 0.50, tint: [0.62, 0.56, 0.52], floor: 0.024, albedo: 0.020, rim: 0.44, wear: [0.34, 0.56, 0.40, 0.20], wearCol: [0.150, 0.120, 0.098] },
};

/**
 * The albedo floor is tinted very slightly COOL.
 *
 * A neutral grey lift makes a crushed robe read as dusty; the art bible's shadow
 * hue is wet slate, and the only warm light in a crypt comes from the torches, so
 * the value that black lifts to should be the colour of the room's shadow, not of
 * its fire. This is a 1.15:1 blue-over-red ratio — enough to read as cold next to
 * a 1900 K practical, nowhere near enough to read as a blue cast.
 */
const FLOOR_TINT = [0.92, 0.99, 1.10];

/* ------------------------------------------------------------------ *
 * vertex-colour wear
 * ------------------------------------------------------------------ */

/**
 * Build a per-vertex tint function: dirt climbing the legs, dust on up-facing
 * surfaces, grime pooling in downward-facing cavities, plus low-frequency
 * mottling so no two square centimetres read the same. Clean geometry is an
 * explicit critic fail, and this is the cheapest place to fix it.
 */
export function grimeFn(o = {}) {
  const lo = o.lo ?? 0.02, hi = o.hi ?? 1.15;
  const dark = o.dark ?? 0.58;
  const base = o.base ?? [1, 1, 1];
  const mot = o.mottle ?? 0.16;
  const seed = o.seed ?? 3;
  const freq = o.freq ?? 5.5;
  const up = o.up ?? 0.09;
  const cav = o.cav ?? 0.16;
  const tintLow = o.tintLow ?? [1, 0.97, 0.92];
  return (x, y, z, nx, ny, nz) => {
    const t = smoothstep(lo, hi, y);
    let k = dark + (1 - dark) * t;
    k *= 1 + up * Math.max(0, ny);
    k *= 1 - cav * Math.max(0, -ny);
    const m = fbm3(x * freq, y * freq, z * freq, seed, 3);
    k *= 1 + (m - 0.5) * 2 * mot;
    const lt = 1 - t;
    return [
      base[0] * k * (1 + (tintLow[0] - 1) * lt),
      base[1] * k * (1 + (tintLow[1] - 1) * lt),
      base[2] * k * (1 + (tintLow[2] - 1) * lt),
    ];
  };
}

/* ------------------------------------------------------------------ *
 * map measurement
 * ------------------------------------------------------------------ */

/** sRGB byte -> scene-linear, matching the hardware decode of an sRGB texture. */
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) S2L[i] = srgbToLinear(i / 255);

/**
 * Scene-linear luma statistics of a generated albedo map: `{ mean, hi }`, where
 * `hi` is the 99th percentile.
 *
 * Both numbers are load-bearing:
 *
 *   `mean` — the textured pedestal in FRAG_EFFECTS divides the map's luma by the
 *   map's own average, or a dark kind would get a dark pedestal and a pale kind a
 *   blinding one. It is also the denominator of the VALUE-TRIM GAIN in make(),
 *   which is what actually sets how bright an enemy reads.
 *
 *   `hi` — the gain's safety clamp. Normalising a MEAN says nothing about the
 *   peak, and a kind with a long bright tail (metal's polished scratches sit ~6x
 *   its mean) could be handed a gain that pushes its highlights past albedo 1.0,
 *   which is unphysical and blows out into exactly the white blobs being fixed.
 *
 * Measured here rather than tabulated because the forge silently degrades map
 * resolution once its VRAM share is spent (every enemy map in the `combat`
 * scenario comes back at 256 px, not 1024), and because texgen is another lane's
 * file: a hard-coded table would go stale the first time a kind is retuned.
 * Deterministic — an average and a histogram over a generated buffer, no
 * sampling, no clock. Stride 2 in each axis because the statistics over a quarter
 * of the texels agree to three decimal places and cost a quarter as much.
 */
const STATS_FALLBACK = { mean: 0.06, hi: 0.30 };
function mapStats(tex) {
  try {
    const im = tex?.image;
    if (!im || !im.width || !im.height) return STATS_FALLBACK;
    const w = im.width, h = im.height;
    let data = im.data ?? null;
    if (!data) {
      // AssetForge's fast path backs albedo with an OffscreenCanvas; anything
      // with an alpha channel comes back as a DataTexture and hits `im.data`.
      const cv = typeof im.getContext === 'function' ? im : new OffscreenCanvas(w, h);
      const g = cv.getContext('2d', { willReadFrequently: true });
      if (cv !== im) g.drawImage(im, 0, 0);
      data = g.getImageData(0, 0, w, h).data;
    }
    if (!data || data.length < w * h * 4) return STATS_FALLBACK;
    // 128 linear-luma bins. Albedo maps live almost entirely below 0.6 linear, so
    // the bin width of 0.0078 resolves the tail finely enough to place a
    // percentile within a couple of per cent.
    const BINS = 128;
    const hist = new Uint32Array(BINS);
    let sum = 0, n = 0;
    for (let y = 0; y < h; y += 2) {
      const row = y * w;
      for (let x = 0; x < w; x += 2) {
        const o = (row + x) * 4;
        const l = 0.2126 * S2L[data[o]] + 0.7152 * S2L[data[o + 1]] + 0.0722 * S2L[data[o + 2]];
        sum += l; n++;
        hist[Math.min(BINS - 1, (l * BINS) | 0)]++;
      }
    }
    if (!n) return STATS_FALLBACK;
    let acc = 0, hi = 1;
    const cut = n * 0.99;
    for (let i = 0; i < BINS; i++) {
      acc += hist[i];
      if (acc >= cut) { hi = (i + 1) / BINS; break; }
    }
    // The floor of 0.004 stops a near-black kind from producing a normalisation
    // factor big enough to turn its own pedestal into a highlight.
    return { mean: Math.max(0.004, sum / n), hi: Math.max(0.008, hi) };
  } catch (e) {
    return STATS_FALLBACK;
  }
}

/* ------------------------------------------------------------------ *
 * shader injection
 * ------------------------------------------------------------------ */

const NOISE_GLSL = /* glsl */`
float monHash13( vec3 p ) {
  p = fract( p * 0.1031 + vec3( 0.1, 0.11, 0.13 ) );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
float monNoise3( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = mix( mix( monHash13( i ), monHash13( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
                 mix( monHash13( i + vec3( 0.0, 1.0, 0.0 ) ), monHash13( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y );
  float b = mix( mix( monHash13( i + vec3( 0.0, 0.0, 1.0 ) ), monHash13( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
                 mix( monHash13( i + vec3( 0.0, 1.0, 1.0 ) ), monHash13( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y );
  return mix( a, b, f.z );
}
float monFbm( vec3 p ) {
  return monNoise3( p ) * 0.60 + monNoise3( p * 2.31 ) * 0.27 + monNoise3( p * 5.77 ) * 0.13;
}
`;

const FRAG_HEAD = /* glsl */`
varying vec3 vMonPos;
varying float vMonMask;
uniform float uMonAlbNorm;
uniform float uMonAlbGain;
uniform float uMonDissolve;
uniform vec3  uMonDissEdge;
uniform vec2  uMonDissRange;
uniform float uMonDissScale;
uniform float uMonFlash;
uniform vec3  uMonFlashColor;
uniform float uMonAura;
uniform vec3  uMonAuraColor;
uniform float uMonGhost;
uniform float uMonEmiss;
uniform vec3  uMonEmissColor;
uniform vec2  uMonFade;
uniform vec3  uMonAlbFloor;
varying float vMonWear;
uniform vec4  uMonWear;
uniform vec3  uMonWearCol;
uniform vec2  uMonWearM;
/* Carried from the effects block (which runs at emissivemap_fragment, long
   before the lighting accumulates) down to aomap_fragment, where the indirect
   lobes can still be attenuated. Same trick as the hero's heroOcclusion. */
float monOcc = 1.0;
${NOISE_GLSL}
`;

const FRAG_DISSOLVE = /* glsl */`
  float monEdge = 0.0;
  if ( uMonDissolve > 0.0005 ) {
    float hb = clamp( ( vMonPos.y - uMonDissRange.x ) / max( 0.0001, uMonDissRange.y ), 0.0, 1.0 );
    float n = monFbm( vMonPos * uMonDissScale ) * 0.80 + hb * 0.36 + 0.02;
    float th = uMonDissolve * 1.34;
    if ( n < th - 0.012 ) discard;
    monEdge = smoothstep( th + 0.115, th, n );
  }
`;

const FRAG_EFFECTS = /* glsl */`
  {
    vec3 monV = normalize( vViewPosition );
    float monF = 1.0 - clamp( abs( dot( normalize( normal ), monV ) ), 0.0, 1.0 );
    float monF2 = monF * monF;
    float monF3 = monF2 * monF;

    /* ALBEDO FLOOR — see RECIPES.floor. Lifts the crushed end of the albedo
       range into [floor, 1] so cloth weave, bone grain and rotting flesh have
       somewhere to read, while white stays white. Applied FIRST, before the
       emissive-mask cavity darkening below, so glowing eye sockets are still cut
       out of it.

       THE PEDESTAL IS TEXTURED, and that is a bug fix, not a refinement. As a
       flat add it was measured to be the single largest term in an enemy's
       albedo and therefore the direct cause of "near-white featureless blobs".
       Worked example from the live combat frame: the cultist's robe arrives
       here at map 0.019 * tint 0.11 * vertex grime 0.87 = 0.0018 scene-linear,
       and the flat floor added 0.087 — forty-eight times the surface's own
       value. Every scrap of structure the map carried was therefore diluted to
       0.0018/0.0888 = 2 % of the pixel, so the robe rendered as one flat lifted
       grey no matter how good the weave underneath was. Switching the floor off
       entirely at runtime dropped the enemy silhouette mean luma from 0.71 to
       0.40 and the blown-highlight share from 0.30 to 0.12: it was not a subtle
       lift, it WAS the surface.

       So the pedestal is now modulated by the albedo map's own luma, normalised
       by that map's measured mean (uMonAlbNorm = 1/mean, computed once per
       recipe in MonsterMaterials.mid()). The MEAN lift is unchanged, so nothing
       goes back to being a black cutout, but the lift now carries 100 % of the
       map's relative contrast instead of 2 % of it — including the new macro
       tier, which is the only tier that survives being drawn 60 px tall. The
       clamp keeps the darkest pedestal at 0.30x (a fold is dark, not a hole) and
       the brightest at 2.3x (a bleached crown, not a light source).

       Re-fetching the albedo map costs no sampler: it is the same uniform and the
       same texture unit, and this project sits close enough to the 16-sampler
       limit that a second sampler would turn the scene white. */
    float monStruct = 1.0;
    #ifdef USE_MAP
      float monMapL = dot( texture2D( map, vMapUv ).rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      monStruct = clamp( monMapL * uMonAlbNorm, 0.30, 2.30 );
    #endif
    /* VALUE-TRIM GAIN — see RECIPES.albedo for how the target is chosen.
       It lives in a UNIFORM rather than being folded into material.color, and that
       is not a style preference. Bestiary's pooled-revive path re-tints a recycled
       enemy in place with a colour copy onto the live material, which silently
       wiped a gain baked into that colour: the cultist in the combat capture
       was running at its raw 0.0016 map-times-tint albedo, so its entire visible
       value was the albedo pedestal, and raising its albedo target by 1.46x moved
       its measured silhouette mean by 0.001. A uniform cannot be clobbered by a
       colour assignment, so the trim survives every revive, elite lerp and
       damage tint the bestiary applies. */
    diffuseColor.rgb = uMonAlbFloor * monStruct + diffuseColor.rgb * uMonAlbGain * ( 1.0 - uMonAlbFloor );

    /* ---- COUPLED WEAR AND TARNISH, off measured curvature ----
       The rubric's surface bar is "a wear/grime layer that darkens, roughens,
       and occludes together", and for metal specifically "edge wear to bright
       material and tarnish in cavities". Every enemy in the bestiary failed
       that outright: the only per-vertex signal a monster carried was grimeFn,
       a world-space height-and-normal ramp, which by construction cannot know
       where a rim or a hollow is. So nothing on a monster ever wore.

       vMonWear is signed per-vertex curvature, gated per authored piece — see
       RigKit.curvatureAttr for the estimator and for why it is an attribute
       rather than a map (the scene is at the 16-sampler ceiling; Bestiary
       already deletes each body's metalness and AO maps to buy two units back,
       so a wear map is simply not affordable).

         > 0  a proud edge   → toward bare material, SMOOTHER, more metallic
         < 0  a cavity       → DARKER, ROUGHER, and occluded via monOcc

       Applied AFTER the albedo floor on purpose. The floored value is what the
       eye actually receives — on a monster the textured pedestal is the majority
       of it — so wear applied before the floor would be diluted by the same
       48:1 factor that made the flat pedestal a bug in the first place.

       The four gains are per recipe (RECIPES.wear) because the coupling is a
       material property: iron polishes to a bright specular and tarnishes almost
       black, bone chalks to a dull pale and merely stains, cloth does neither. */
    float monEdgeW = clamp(  vMonWear, 0.0, 1.0 ) * uMonWear.x;
    float monCavW  = clamp( -vMonWear, 0.0, 1.0 ) * uMonWear.y;
    diffuseColor.rgb = mix( diffuseColor.rgb, uMonWearCol, monEdgeW );
    diffuseColor.rgb *= 1.0 - 0.62 * monCavW;
    roughnessFactor = clamp(
      mix( roughnessFactor, uMonWear.z, monEdgeW ) + uMonWear.w * monCavW, 0.04, 1.0 );
    /* Metalness moves with the other three, in both directions. An abraded
       arris is BARE metal, so it goes up; oxide and packed dirt are dielectrics,
       so a tarnished hollow goes down. Skipping this is what leaves a "worn"
       plate reading as a uniformly polished one with a paint job on it, and
       leaves a tarnished cavity reading as a dark mirror.
       Non-metals declare (0, 1) and their metalness is <= 0.02, so this is a
       no-op for bone, hide, cloth and flesh. */
    metalnessFactor = mix( metalnessFactor, uMonWearM.x, monEdgeW )
      * mix( 1.0, uMonWearM.y, monCavW );
    // "Occludes" is the third leg and the one that is usually skipped. Without
    // it the environment probe puts back in indirect specular exactly what the
    // albedo darkening just removed, and the cavity stops reading as a cavity.
    monOcc = 1.0 - 0.72 * monCavW;

    totalEmissiveRadiance *= uMonEmiss;
    // per-vertex emissive mask: eye sockets, runes, ember cores, weak points.
    // Lets every glow detail share the body material instead of costing a draw.
    totalEmissiveRadiance += uMonEmissColor * vMonMask;
    diffuseColor.rgb *= mix( 1.0, 0.14, clamp( vMonMask, 0.0, 1.0 ) );
    /* Aura / champion tell. Three lobes rather than one fresnel^3 spike: at the
       20-40 px an enemy occupies at gameplay distance a cubed fresnel lands on a
       single pixel and the AA resolve averages it away, so a champion measured
       identical to a trash mob. The constant term states "this body is lit from
       within", the squared term carries the accent hue across the whole rounded
       far side, and the cubed term keeps a hot edge on the true silhouette.
       CAPPED at 0.62 scene-linear, under RenderPipeline's 0.838 bloom floor: an
       aura that blooms is a glowing blob, not a champion. Measured before the cap:
       the night champion peaked at 1.18 from this term alone and its body clipped
       to pure white.

       BOTH EMISSIVE TERMS BELOW ARE MULTIPLIED BY monStruct, and that is the fix
       for the second half of "near-white featureless blobs".

       An additive emissive is the one operation that cannot be recovered from: it
       does not scale the surface, it replaces it. Measured on the live combat
       frame, a ghoul caught at uMonFlash 0.10 — well under Bestiary's 0.13 ceiling
       and therefore an ordinary hit, not an edge case — read 0.929 silhouette mean
       luma with 83 % of its pixels past 0.9 and a luma SD of 0.088, while its two
       identically-shaded packmates measured 0.51 and 0.53. Verified against the
       materials alone with every transparent and additive mesh in the scene
       hidden, so it is not a VFX overlay: 0.10 * 2.4 = 0.24 scene-linear of flat
       white emissive on a body whose diffuse albedo is 0.070 is a 3.4:1 paint-over.
       In a scripted fight something is always mid-flash, which is why a "featureless
       white blob" was in every combat capture.

       Weighting by the albedo map's own normalised luma (0.30x in a stained crease,
       2.30x on a bleached crown) means a hot body stays hot but its bone still reads
       as bone: the flash now modulates the surface instead of erasing it. The gains
       come down as well — 2.4 -> 1.5 and the albedo-toward-white wash 0.45 -> 0.22 —
       because the structure term averages to 1.0 and would otherwise leave the
       punch exactly as strong as it was.

       FLASH GAIN 1.5 -> 0.7, measured a second time after the above landed. With
       Bestiary's ceiling at 0.05 the term was still contributing 0.05 * 1.5 = 0.075
       scene-linear, and a monster body's post-floor diffuse is only 0.07-0.10, so a
       flash was still roughly DOUBLING scene-linear radiance. On the frozen combat
       frame that showed up as one of three identically-shaded ghouls reading 0.823
       silhouette mean with 43 % of its pixels past 0.9 while its packmates sat at
       0.508 and 0.522 with 3-9 % blown — a +0.30 display-luma spike from the flash
       alone. 0.7 puts the lift at 0.035 scene-linear, about +45 % rather than +100 %,
       which is still an unmistakable tell because the flash is ANIMATED: a 45 % step
       that appears and decays over a few frames reads far louder than the same step
       held static, and unlike the old value it cannot clip the body to white. */
    totalEmissiveRadiance += min(
      uMonAuraColor * uMonAura * ( 0.10 + monF2 * 0.62 + monF3 * 1.35 ) * monStruct,
      vec3( 0.62 ) );
    totalEmissiveRadiance += uMonFlashColor * uMonFlash * 0.7 * monStruct;
    totalEmissiveRadiance += uMonDissEdge * monEdge * 7.0;

    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), uMonFlash * 0.22 );
    // wraith / phasing: fresnel-weighted coverage, never a flat 50 % fade
    float monGhostA = clamp( 0.12 + monF * 1.30 + monF3 * 0.55, 0.0, 1.0 );
    diffuseColor.a *= mix( 1.0, monGhostA, uMonGhost );
    // uMonFade: coverage ramp along local Y — smoke trails dissolving into air
    float monFadeOn = step( 0.0001, uMonFade.y );
    diffuseColor.a *= mix( 1.0, clamp( ( vMonPos.y - uMonFade.x ) / max( 0.0001, uMonFade.y ), 0.0, 1.0 ), monFadeOn );
    roughnessFactor = clamp( roughnessFactor - uMonFlash * 0.28, 0.04, 1.0 );
  }
`;

/** Cavity occlusion reaching the indirect lobes. See `monOcc` in FRAG_HEAD. */
const FRAG_AO = /* glsl */`
  {
    reflectedLight.indirectDiffuse *= monOcc;
    #if defined( USE_ENVMAP ) && defined( STANDARD )
      reflectedLight.indirectSpecular *= monOcc;
    #endif
    #ifdef USE_SHEEN
      sheenSpecularIndirect *= monOcc;
    #endif
  }
`;

/** Attach the shared monster shader to any Standard/Physical material. */
export function injectMonsterShader(mat, u) {
  mat.userData.monU = u;
  mat.onBeforeCompile = (shader) => {
    for (const k in u) shader.uniforms[k] = u[k];
    shader.vertexShader = 'varying vec3 vMonPos;\nvarying float vMonMask;\n'
      + 'varying float vMonWear;\nattribute float aMask;\nattribute float aWear;\n'
      + shader.vertexShader.replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\n\tvMonPos = transformed;\n\tvMonMask = aMask;\n\tvMonWear = aWear;'
      );
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAG_DISSOLVE)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + FRAG_EFFECTS)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>' + FRAG_AO);
  };
  // v5: adds the curvature-driven coupled wear/tarnish layer and its cavity
  // occlusion. Defines are part of three's own cache key so this is
  // belt-and-braces, but it documents that the source changed shape.
  mat.customProgramCacheKey = () => 'sanctum-monster-v5';
  return mat;
}

export function makeMonsterUniforms(o = {}) {
  const f = o.albFloor ?? 0.075;
  return {
    uMonAlbFloor: { value: new THREE.Vector3(f * FLOOR_TINT[0], f * FLOOR_TINT[1], f * FLOOR_TINT[2]) },
    // 1 / mean linear luma of this recipe's albedo map, so the pedestal above can
    // be normalised without a divide per fragment. 1/0.06 is the fallback used
    // when the map could not be measured (see mapStats).
    uMonAlbNorm: { value: o.albNorm ?? (1 / 0.06) },
    uMonAlbGain: { value: o.albGain ?? 1 },
    uMonDissolve: { value: 0 },
    uMonDissEdge: { value: new THREE.Color(o.dissolveEdge ?? 0xffb060) },
    uMonDissRange: { value: new THREE.Vector2(o.yMin ?? 0, o.height ?? 2) },
    uMonDissScale: { value: o.dissolveScale ?? 9.0 },
    uMonFlash: { value: 0 },
    uMonFlashColor: { value: new THREE.Color(o.flashColor ?? 0xfff0e0) },
    uMonAura: { value: 0 },
    uMonAuraColor: { value: new THREE.Color(o.auraColor ?? 0xff7a22) },
    uMonGhost: { value: o.ghost ?? 0 },
    uMonEmiss: { value: 1 },
    uMonEmissColor: { value: new THREE.Color(0, 0, 0) },
    uMonFade: { value: new THREE.Vector2(0, 0) },
    /* (edgeGain, cavityGain, edgeRoughness, cavityRoughAdd) — see RECIPES.wear.
       Defaults to zero on both gains so any material built without a wear
       profile behaves exactly as it did before this layer existed. */
    uMonWear: { value: new THREE.Vector4(
      o.wear?.[0] ?? 0, o.wear?.[1] ?? 0, o.wear?.[2] ?? 0.3, o.wear?.[3] ?? 0.22) },
    /* The material UNDER the finish, in the same post-floor scene-linear space
       the wear mix happens in: bare steel, chalked bone, scuffed leather. */
    uMonWearCol: { value: new THREE.Vector3().fromArray(o.wearCol ?? [0.30, 0.30, 0.32]) },
    /* (metalness at full edge wear, metalness multiplier at full cavity). */
    uMonWearM: { value: new THREE.Vector2(o.wearM?.[0] ?? 0, o.wearM?.[1] ?? 1) },
  };
}

/* ------------------------------------------------------------------ *
 * library
 * ------------------------------------------------------------------ */

export class MonsterMaterials {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this._maps = new Map();
    this._mid = new Map();
    this._extra = new Map();
    this._owned = [];
  }

  /**
   * Linear luma statistics of a recipe's albedo map, measured once and memoised.
   * Feeds the textured albedo pedestal and the value-trim gain — see
   * FRAG_EFFECTS, make() and mapStats().
   */
  stats(key) {
    const hit = this._mid.get(key);
    if (hit !== undefined) return hit;
    const v = mapStats(this.maps(key)?.map ?? null);
    this._mid.set(key, v);
    return v;
  }

  /** Mean linear luma of a recipe's albedo map. */
  mid(key) { return this.stats(key).mean; }

  /** Cached AssetForge map set for a recipe (textures shared by all instances). */
  maps(key) {
    const hit = this._maps.get(key);
    if (hit !== undefined) return hit;
    const r = RECIPES[key] ?? RECIPES.bone;
    let set = null;
    try {
      set = this.engine.assets?.pbr?.({ kind: r.kind, seed: r.seed, tiling: 1, tint: r.tint ?? null }) ?? null;
    } catch (e) {
      console.warn(`[bestiary] material maps failed for "${key}" —`, e?.message ?? e);
      set = null;
    }
    this._maps.set(key, set);
    return set;
  }

  uvScale(key) { return (RECIPES[key] ?? RECIPES.bone).uv; }

  /**
   * Solve this material's VALUE-TRIM GAIN for the mean scene-linear albedo its
   * recipe asked for: `gain = albedo / (mapMean * tintLuma)`. See RECIPES.albedo
   * for why the targets are what they are and FRAG_EFFECTS for why the result is a
   * uniform rather than a factor folded into `color`.
   *
   * MUST be re-run by anything that writes `material.color`, because the tint is
   * the denominator. Bestiary calls it after every re-tint — pooled revive, elite
   * accent lerp, per-species colour shift — and that is the whole reason this is a
   * method instead of eight lines inside make().
   */
  trim(mat) {
    const u = mat.userData?.monU;
    const r = RECIPES[mat.userData?.recipe];
    if (!u?.uMonAlbGain || !r?.albedo || !mat.map) return;
    const st = this.stats(mat.userData.recipe);
    const tl = Math.max(0.004, 0.2126 * mat.color.r + 0.7152 * mat.color.g + 0.0722 * mat.color.b);
    let gain = r.albedo / (st.mean * tl);
    /* Peak clamp: never let the 99th percentile of the surface exceed 0.74
       scene-linear. Normalising a MEAN says nothing about the peak, and the kinds
       with a long bright tail — metal's polished scratches sit about 6x their own
       mean — would otherwise be handed a gain that pushes their highlights past
       albedo 1.0. That is unphysical, and in this frame it clips to exactly the
       white blob being fixed. 0.74 is roughly dry bleached bone, the brightest
       diffuse reflector anything in a crypt is made of. */
    gain = Math.max(0.05, Math.min(64, Math.min(gain, 0.74 / (st.hi * tl))));
    u.uMonAlbGain.value = gain;
    mat.userData.albGain = gain;
    mat.userData.albMean = st.mean * tl * gain;
  }

  /**
   * Build a fresh per-instance material.
   * @param {string} key recipe name
   * @param {object} o { tint, emissive, emissiveIntensity, ghost, transparent,
   *                     side, yMin, height, auraColor, dissolveEdge, roughAdd }
   */
  make(key, o = {}) {
    const r = RECIPES[key] ?? RECIPES.bone;
    const maps = this.maps(key);
    const params = {
      color: o.tint ?? 0xffffff,
      roughness: 1,
      metalness: 1,
      vertexColors: true,
      dithering: true,
      envMapIntensity: o.env ?? r.env ?? 0.7,
      aoMapIntensity: 1.0,
      side: o.side ?? THREE.FrontSide,
    };
    if (maps) {
      params.map = maps.map;
      params.normalMap = maps.normalMap;
      params.roughnessMap = maps.roughnessMap;
      params.metalnessMap = maps.metalnessMap;
      params.aoMap = maps.aoMap;
    } else {
      params.roughness = 0.85;
      params.metalness = 0.05;
    }
    if (o.emissive !== undefined) {
      params.emissive = new THREE.Color(o.emissive);
      params.emissiveIntensity = o.emissiveIntensity ?? 1.0;
      if (o.useEmissiveMap && maps?.emissiveMap) params.emissiveMap = maps.emissiveMap;
    }
    if (o.transparent) {
      params.transparent = true;
      params.depthWrite = o.depthWrite ?? false;
      params.opacity = o.opacity ?? 1;
    }
    const mat = new THREE.MeshStandardMaterial(params);
    if (maps) mat.normalScale.set(r.normalScale ?? 1, r.normalScale ?? 1);

    // Roughness maps carry absolute values; nudge, don't replace.
    if (o.roughAdd) mat.userData.roughAdd = o.roughAdd;

    /* Opt this surface in to Lighting's CHARACTER RIM — the camera-tracking cold
       back light that is compiled per material rather than added to the scene,
       because a light that touches the floor too separates nothing. Enemies used
       to be excluded from it, which is precisely why they read as "flat near-black
       paper cutouts with no rim separation". The gain is per recipe: a matte
       gambeson needs more of it than a polished pauldron to read the same amount.
       MUST be set before registerMaterial() below — that is when the define is
       compiled in. See Lighting._heroRimGain / _injectHeroRim. */
    mat.userData.charRim = o.charRim ?? r.rim ?? 1.0;

    mat.userData.recipe = key;
    const floor = r.albedo ? Math.min(r.floor ?? 0.075, r.albedo * 0.28) : (r.floor ?? 0.075);
    const u = makeMonsterUniforms(Object.assign(
      {
        albFloor: floor,
        albNorm: maps ? 1 / this.mid(key) : (1 / 0.06),
        wear: r.wear, wearCol: r.wearCol, wearM: r.wearM,
      }, o));
    injectMonsterShader(mat, u);
    this.trim(mat);
    this._owned.push(mat);
    try { this.engine.get?.('lighting')?.registerMaterial?.(mat); } catch { /* optional */ }
    return mat;
  }

  /**
   * Flat additive ground pool used to (a) ground an enemy with a soft contact
   * glow and (b) make champions and the boss unmistakable from above. One
   * shared geometry, one material per colour — no skinning, so no risk of a
   * shader surprise on a hot path.
   */
  groundGlow(color = 0xff8a2a, o = {}) {
    const key = `glow|${color}|${o.rings ?? 0}`;
    const hit = this._extra.get(key);
    if (hit) return hit;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uGain: { value: o.gain ?? 0.55 },
        uTime: { value: 0 },
        uRings: { value: o.rings ?? 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUvG;
        void main() {
          vUvG = uv * 2.0 - 1.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uGain; uniform float uTime; uniform float uRings;
        varying vec2 vUvG;
        void main() {
          float r = length( vUvG );
          if ( r > 1.0 ) discard;
          /* Core falloff softened 2.6 -> 1.9: at a 26-34 m camera the pool is
             ~40 px across and a 2.6 power put almost all of its value inside the
             body's own footprint, where the body hides it. A champion has to be
             identifiable from the FLOOR before you can even resolve its shape. */
          float core = pow( 1.0 - r, 1.9 );
          /* Two counter-rotating rings, feathered rather than 1-texel hairlines —
             a hard hoop reads as a UI selection circle, a soft arc reads as light
             on stone. Widths are in normalised radius, so they scale with the body. */
          float ring = 0.0;
          if ( uRings > 0.5 ) {
            float r0 = 0.82 + 0.035 * sin( uTime * 1.7 );
            float r1 = 0.56 + 0.030 * sin( uTime * 1.1 + 2.1 );
            ring  = smoothstep( 0.075, 0.0, abs( r - r0 ) ) * 0.85;
            ring += smoothstep( 0.055, 0.0, abs( r - r1 ) ) * 0.45;
          }
          float a = ( core * 0.85 + ring ) * uGain;
          gl_FragColor = vec4( uColor * a, a );
        }`,
    });
    this._owned.push(mat);
    this._extra.set(key, mat);
    return mat;
  }

  dispose() {
    for (const m of this._owned) { try { m.dispose(); } catch { /* noop */ } }
    this._owned.length = 0;
    this._maps.clear();
    this._mid.clear();
    this._extra.clear();
  }
}
