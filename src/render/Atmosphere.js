/**
 * THE NINTH VIGIL — Atmosphere support library.
 *
 * Everything the Sky module needs that is not scene-graph plumbing:
 *   - weather presets
 *   - the CPU-side evaluation of the sky model (so fog / light colours are
 *     literally sampled from the same function the sky shader runs)
 *   - deterministic procedural cloud noise + cloud-shadow textures
 *   - the GLSL source blocks shared between the sky dome, the horizon
 *     silhouette rings and the injected aerial-perspective fog
 *
 * The analytic model is Preetham (as in three/addons/objects/Sky.js) but the
 * default look is thrown away: sun intensity uses a softened twilight falloff,
 * an explicit wavelength-shifted twilight/belt-of-Venus term is layered on top,
 * a night sky is composited underneath and per-weather turbidity / rayleigh /
 * mie / tint / desaturation reshape the whole thing.
 *
 * NOTHING here uses Math.random() or Date.now(). All noise comes from the
 * project's deterministic hash in core/Rand.js.
 */

import * as THREE from 'three';
import { hash2 } from '../core/Rand.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/* ═══════════════════════════════════════════════════════════════════════════
   WEATHER PRESETS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every field is consumed by Sky.js. `tint`/`desat` reshape the analytic sky,
 * `cloud*` drive the raymarched layer, `fogMul`/`fogFall` reshape height fog.
 */
export const WEATHER = {
  clear: {
    turbidity: 2.4, rayleigh: 2.35, mieCoefficient: 0.0042, mieG: 0.795,
    cloudCoverage: 0.47, cloudDensity: 0.85, cloudAbsorb: 2.6, cloudPowder: 0.75,
    cloudSpeed: 0.0042, cloudTop: 0.62, skyGain: 1.0, sunMul: 1.0,
    fogMul: 1.0, fogFall: 0.045, fogInscatter: 1.0, desat: 0.0,
    tint: [1.0, 1.0, 1.0], shadowStrength: 0.30, twilightGain: 1.85,
  },
  fair: {
    turbidity: 3.4, rayleigh: 2.1, mieCoefficient: 0.006, mieG: 0.78,
    cloudCoverage: 0.58, cloudDensity: 0.95, cloudAbsorb: 3.0, cloudPowder: 0.75,
    cloudSpeed: 0.0050, cloudTop: 0.66, skyGain: 0.98, sunMul: 0.92,
    fogMul: 1.15, fogFall: 0.043, fogInscatter: 1.05, desat: 0.04,
    tint: [1.0, 0.99, 0.98], shadowStrength: 0.34, twilightGain: 1.8,
  },
  overcast: {
    turbidity: 8.5, rayleigh: 1.35, mieCoefficient: 0.0135, mieG: 0.735,
    cloudCoverage: 0.80, cloudDensity: 1.15, cloudAbsorb: 4.4, cloudPowder: 0.45,
    cloudSpeed: 0.0068, cloudTop: 0.80, skyGain: 0.80, sunMul: 0.36,
    fogMul: 1.75, fogFall: 0.036, fogInscatter: 0.55, desat: 0.38,
    tint: [0.90, 0.93, 0.99], shadowStrength: 0.22, twilightGain: 1.25,
  },
  rain: {
    turbidity: 10.5, rayleigh: 1.15, mieCoefficient: 0.0165, mieG: 0.70,
    cloudCoverage: 0.88, cloudDensity: 1.30, cloudAbsorb: 5.2, cloudPowder: 0.35,
    cloudSpeed: 0.0092, cloudTop: 0.86, skyGain: 0.70, sunMul: 0.24,
    fogMul: 2.05, fogFall: 0.032, fogInscatter: 0.42, desat: 0.48,
    tint: [0.86, 0.91, 1.00], shadowStrength: 0.18, twilightGain: 1.0,
  },
  storm: {
    turbidity: 15.0, rayleigh: 0.95, mieCoefficient: 0.0225, mieG: 0.63,
    cloudCoverage: 0.96, cloudDensity: 1.55, cloudAbsorb: 6.4, cloudPowder: 0.25,
    cloudSpeed: 0.0135, cloudTop: 0.95, skyGain: 0.56, sunMul: 0.14,
    fogMul: 2.55, fogFall: 0.028, fogInscatter: 0.30, desat: 0.56,
    tint: [0.80, 0.86, 0.95], shadowStrength: 0.14, twilightGain: 0.8,
  },
  mist: {
    turbidity: 5.5, rayleigh: 1.8, mieCoefficient: 0.011, mieG: 0.76,
    cloudCoverage: 0.52, cloudDensity: 0.85, cloudAbsorb: 3.2, cloudPowder: 0.6,
    cloudSpeed: 0.0032, cloudTop: 0.70, skyGain: 0.92, sunMul: 0.60,
    fogMul: 3.10, fogFall: 0.070, fogInscatter: 1.15, desat: 0.30,
    tint: [0.95, 0.96, 1.0], shadowStrength: 0.20, twilightGain: 1.5,
  },
  snow: {
    turbidity: 6.5, rayleigh: 1.6, mieCoefficient: 0.0125, mieG: 0.74,
    cloudCoverage: 0.86, cloudDensity: 1.05, cloudAbsorb: 3.6, cloudPowder: 0.6,
    cloudSpeed: 0.0058, cloudTop: 0.78, skyGain: 0.88, sunMul: 0.42,
    fogMul: 2.1, fogFall: 0.040, fogInscatter: 0.85, desat: 0.42,
    tint: [0.94, 0.96, 1.02], shadowStrength: 0.20, twilightGain: 1.3,
  },
  ember: {
    // Hell / ashfall: heavy warm murk, low sun, glowing horizon.
    turbidity: 11.0, rayleigh: 0.85, mieCoefficient: 0.019, mieG: 0.845,
    cloudCoverage: 0.74, cloudDensity: 1.25, cloudAbsorb: 4.8, cloudPowder: 0.5,
    cloudSpeed: 0.0075, cloudTop: 0.88, skyGain: 0.72, sunMul: 0.45,
    fogMul: 1.9, fogFall: 0.038, fogInscatter: 1.6, desat: 0.10,
    tint: [1.22, 0.74, 0.52], shadowStrength: 0.24, twilightGain: 2.3,
  },
};
WEATHER.none = WEATHER.clear;
WEATHER.sunny = WEATHER.clear;
WEATHER.cloudy = WEATHER.overcast;
WEATHER.fog = WEATHER.mist;
WEATHER.ash = WEATHER.ember;
WEATHER.thunder = WEATHER.storm;

export function resolveWeather(kind) {
  return WEATHER[kind] ?? WEATHER.clear;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SKY STATE  (CPU side of the analytic model)
   ═══════════════════════════════════════════════════════════════════════════ */

/* Preetham coefficients, lifted from three/addons/objects/Sky.js so this model
   is bit-for-bit the same analytic core the addon ships — everything on top of
   it (twilight band, night sky, weather grade, knee) is ours. Keeping the
   constants here rather than importing the addon lets the CPU evaluator and the
   GLSL share one source of truth, which is what makes fog match the sky. */
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;
const SUN_EE = 780.0;

/**
 * Raw Preetham radiance lands around 3-30 which ACES crushes to white. This
 * scales the analytic term (and ONLY the analytic term — the authored twilight
 * and night values are already in display range) into a moody exposure band.
 * Shared verbatim by the CPU evaluator and the GLSL below so fog matches sky.
 */
export const ATMOS_GAIN = 0.12;

/**
 * Preetham's forward-scattering lobe runs to ~1600 linear when you look
 * straight down the sun at the horizon (worse with high-mie weather). Left
 * alone that turns the fog colour — and therefore every distant surface — into
 * a white blob. This is a hue-preserving soft knee: divide by the *max*
 * channel so the ratio between channels (i.e. the sunset hue) survives while
 * the magnitude asymptotes to SKY_KNEE.
 */
export const SKY_KNEE = 3.2;
export function skyKnee(c) {
  const m = Math.max(c[0], c[1], c[2]);
  if (m <= 0) return c;
  const k = 1 / (1 + m / SKY_KNEE);
  c[0] *= k; c[1] *= k; c[2] *= k;
  return c;
}

/** Solar arc: t=0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. */
export function sunDirectionFor(t) {
  const a = (t - 0.25) * TAU;
  const tilt = 0.40;      // arc leans south, max elevation ~66deg
  const yaw = -0.62;      // composition offset so the sun is never axis-aligned
  let x = Math.cos(a), y = Math.sin(a), z = 0;
  // rotate about X (tilts the arc plane)
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const y2 = y * ct, z2 = y * st;
  // rotate about Y (world yaw)
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x3 = x * cy + z2 * sy;
  const z3 = -x * sy + z2 * cy;
  return new THREE.Vector3(x3, y2, z3).normalize();
}

export function moonDirectionFor(t) {
  const a = (t - 0.25) * TAU + Math.PI + 0.62;
  const tilt = -0.28;
  const yaw = -0.62 + 0.35;
  let x = Math.cos(a), y = Math.sin(a);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const y2 = y * ct, z2 = y * st;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return new THREE.Vector3(x * cy + z2 * sy, y2, -x * sy + z2 * cy).normalize();
}

function totalMie(turbidity, out) {
  const c = 0.2 * turbidity * 10e-18;
  out[0] = 0.434 * c * MIE_CONST[0];
  out[1] = 0.434 * c * MIE_CONST[1];
  out[2] = 0.434 * c * MIE_CONST[2];
  return out;
}

/**
 * Full CPU state for a given time-of-day + weather. Everything the shader
 * needs as a uniform, plus derived light colours for the Lighting module.
 */
export function computeSkyState(timeOfDay, weatherKey, opts = {}) {
  const w = resolveWeather(weatherKey);
  const sunDir = sunDirectionFor(timeOfDay);
  const moonDir = moonDirectionFor(timeOfDay);
  const sunY = sunDir.y;

  // Softened twilight falloff — Preetham's hard cutoff kills dusk entirely.
  const sunUpT = smoothstep(-0.26, 0.09, sunY);
  const sunE = SUN_EE * Math.pow(sunUpT, 1.28) * w.skyGain;

  // Rayleigh climbs a touch at low sun so the reddening deepens near sunset.
  const lowSun = 1.0 - smoothstep(-0.05, 0.30, sunY);
  const rayleigh = w.rayleigh * (1.0 + 0.55 * lowSun);
  const turbidity = w.turbidity * (1.0 + 0.35 * lowSun);
  const mieCoefficient = w.mieCoefficient * (1.0 + 0.85 * lowSun);

  const sunfade = 1.0 - clamp(1.0 - Math.exp(sunY * 400000 / 450000), 0, 1);
  const rayleighCoefficient = Math.max(rayleigh - (1.0 - sunfade), 0.02);

  const betaR = [
    TOTAL_RAYLEIGH[0] * rayleighCoefficient,
    TOTAL_RAYLEIGH[1] * rayleighCoefficient,
    TOTAL_RAYLEIGH[2] * rayleighCoefficient,
  ];
  const bm = totalMie(turbidity, [0, 0, 0]);
  const betaM = [bm[0] * mieCoefficient, bm[1] * mieCoefficient, bm[2] * mieCoefficient];

  const night = smoothstep(0.055, -0.145, sunY);
  const twilight = Math.exp(-Math.pow((sunY + 0.015) / 0.175, 2));
  const moonUp = smoothstep(-0.06, 0.10, moonDir.y);

  return {
    timeOfDay, weather: weatherKey, w,
    sunDir, moonDir, sunY,
    betaR, betaM, sunE, mieG: w.mieG,
    turbidity, rayleigh: rayleighCoefficient,
    night, twilight, twilightGain: w.twilightGain,
    moonUp,
    /** Sky brightness driver — hard cutoff at the horizon. */
    sunUp: smoothstep(-0.09, 0.07, sunY),
    /** Lighting driver — keeps a warm twilight tail after the disc has set, so
     *  a dusk scene is lit by low orange light rather than snapping to moonlight. */
    lightUp: smoothstep(-0.26, 0.05, sunY),
    desat: w.desat, tint: w.tint,
    interior: !!opts.interior,
  };
}

/** Rayleigh phase, matching the shader exactly. */
function rayleighPhase(c) { return 0.05968310365946075 * (1.0 + (c * 0.5 + 0.5) * (c * 0.5 + 0.5)); }
function hgPhase(c, g) {
  const g2 = g * g;
  return 0.07957747154594767 * ((1.0 - g2) / Math.pow(Math.max(1.0 - 2.0 * g * c + g2, 1e-4), 1.5));
}

/**
 * Normalised sunlight colour from atmospheric extinction, with a hue floor.
 * Raw extinction at a sub-horizon sun normalises to ~(1, 0.001, 0) — literally
 * monochrome red, which would paint the entire scene. Real low sun is a rich
 * orange, so the green/blue channels are floored relative to red.
 */
export function sunLightColor(S, out = [1, 1, 1]) {
  const F = extinctionFor(S, { y: Math.max(S.sunDir.y, -0.05) });
  const m = Math.max(F[0], F[1], F[2], 1e-6);
  out[0] = F[0] / m;
  out[1] = Math.max(F[1] / m, 0.480 * out[0]);
  out[2] = Math.max(F[2] / m, 0.260 * out[0]);
  /* Deepen toward orange as the sun drops — but not past it. Lighting applies
     this colour to the whole scene, and a (1, 0.33, 0.10) key paints every
     surface the same hue, which breaks the "cold base, warm accent" palette. */
  const low = 1 - clamp((S.sunDir.y + 0.05) / 0.35, 0, 1);
  out[1] = lerp(out[1], out[1] * 0.95, low);
  out[2] = lerp(out[2], out[2] * 0.80, low);
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SUB-HORIZON AERIAL BAND  —  the thing an ARPG camera actually calls "the sky"
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * MEASURED CAMERA GEOMETRY (shipped rigs, not guessed):
 *   overworld  pos y 35.55, pitch 46 deg, fov 48  ->  the TOP of the frame is
 *              already 22 deg BELOW level (tan(depression) 0.363) and the bottom
 *              is at 1.44. night/hub are steeper still.
 *
 * So in every gameplay scenario the analytic Preetham dome is entirely OFF
 * SCREEN. Every pixel a player calls "sky" is the band below level, and a single
 * constant there is a flat grey card by construction — which is exactly what
 * `overworld` was measured to be (#94989d, luma 0.374, sd 0.18 over the whole
 * visible wedge, brighter than any other large area in frame).
 *
 * This block derives that band from the real sky state so it carries
 * colour temperature, a value ramp and an implied light direction, and it
 * derives the FOG's far-field target from the same numbers — which is what makes
 * distant land resolve to the sky it is silhouetted against, minus a value gap.
 *
 * Levels are expressed as fractions of `skyline`, and `skyline` itself is a
 * COMPRESSED function of the sky's own luminance:
 *
 *     skyline = BAND_GAIN * pow( skyLum, BAND_COMP )
 *
 * The compression matters. Raw overcast horizon radiance is 1.38 linear while a
 * rainy midnight is 0.023 — a 60x span. Feeding that straight through gives
 * either a white card by day or a black void at night; pow(.,0.62) squeezes the
 * 60x to 8x, which is the range a single grade can hold.
 *
 * BAND_GAIN IS PINNED BY A MEASURED DOWNSTREAM LIMIT, not by taste. The `moor`
 * look in RenderPipeline grades with blackPoint 0.138 / whitePoint 0.50 and
 * saturation 0.56 x highlightDesat 0.58, and a runtime sweep of this whole family
 * (scale 0.35 / 0.55 / 0.75 / 1.0 / 1.4, reading the framebuffer at fixed pixels)
 * showed the sky pixel pinning at display luma 0.2545 with HSV sat 0.00 for every
 * scale at or above 1.0 of the old level, and recovering to sat 0.56-0.69 once the
 * band dropped under roughly 0.06 scene-linear. In other words: above that value
 * the grade throws the sky's chroma and its gradient away, which is exactly the
 * "flat grey card, no colour-temperature gradient" the review measured at
 * #b9bbbd. The band is therefore authored to land at 0.04-0.08 scene-linear on the
 * shipped overworld rig so the grade can still show what is there.
 */
const BAND_GAIN = 0.118;   // skyline luma at skyLum = 1
const BAND_COMP = 0.62;    // luminance compression exponent
const BAND_OPP = 0.71;     // anti-key skyline, as a fraction of the key side
/* ── DAYLIGHT SKY-TO-GROUND RATIO ────────────────────────────────────────────
 * The block above was tuned entirely against DUSK and NIGHT rigs (`hub` at
 * tod 0.78 and `night` at tod 0.02 both put the sun 10-66 deg BELOW the horizon,
 * so both meter S.sunUp = 0). On those the level above is right: a moonlit moor
 * and a near-black sky are within a factor of two of each other, and lifting the
 * band would turn the night sky into a grey card.
 *
 * `overworld` is the only shipped scenario with the sun actually up, and there
 * the same level is physically inverted. MEASURED on the shipped rig: the lit
 * moor resolves to 0.056 scene-linear and the fully-fogged far field to 0.060,
 * while the band the frame silhouettes against sat at 0.031-0.071 — i.e. the SKY
 * WAS DARKER THAN THE GROUND. Real numbers for an overcast day are a 20-40:1
 * sky-to-ground ratio (5000 cd/m^2 off the cloud deck against wet peat at
 * albedo 0.08), so distance has to LIFT toward the horizon and a ridge has to
 * read as a dark shape against a bright one. At 0.058 linear the whole 30-78 m
 * depth range the rig frames arrived within 7 % of one value, which is precisely
 * "distant ridges have identical value to near terrain".
 *
 * The lift is gated on S.sunUp, so it is identically 1.0 for every dusk and
 * night scenario and cannot regress the two frames that share these files.
 *
 * IT APPLIES TO THE FAR HAZE ONLY, NOT TO THE BAND. That split is not a
 * refinement, it is the constraint the block above already states: above roughly
 * 0.06 scene-linear the `moor` grade throws the sky's chroma and its gradient
 * away. An earlier pass here scaled the band by this lift too, which put it at
 * 0.365 scene-linear, and the frame reproduced that prediction exactly — the
 * visible sky measured display luma 0.5945 at HSV saturation 0.0017, i.e. the
 * flat achromatic card BAND_GAIN exists to avoid, with the four receding
 * silhouette layers and the mist banks compressed into it and invisible.
 *
 * Nothing was gained by it. MEASURED with a runtime sweep that scales the band
 * uniforms alone: taking the band from that lifted level back down to its
 * authored one moves the fraction of the frame above display 0.75 by 0.15 points
 * out of 2.36, while the same sweep on the two far-haze targets alone moves it by
 * 1.66 points at only a 20 % cut. The highlight quota lives entirely in the
 * hazed far ground; the band contributes nothing to it and only loses its own
 * hue and gradient by being dragged up there. Removing the band's share also
 * MEASURED better on both remaining metrics — frame saturation 0.180 -> 0.192 and
 * mean 0.230 -> 0.203 — because a flat desaturated sky was averaging both down. */
const DAY_SKY_LIFT = 4.90;
/* Deep-band level. MEASURED CONSTRAINT: the `moor` grade's toe crushes anything
   under roughly 0.036 scene-linear to black and its contrast stage AMPLIFIES the
   0.036-0.065 window by about 2.9x in log terms. At 0.30 the band fell to 0.034 by
   the bottom of the visible wedge and took the whole silhouette stack under the
   toe with it — the four receding crests measured display luma 0.008-0.018, i.e.
   black. 0.52 keeps the entire ladder inside the window the grade can actually
   render. */
const BAND_LO = 0.52;
const BAND_GLOW = 0.30;    // horizon-warming glow amplitude, fraction of skyline
/* Fog far-field target, as fractions of the skyline BEFORE the daylight lift below
   is applied. MEASURED CONSTRAINT: the lit moor resolves to 0.032-0.050
   scene-linear, so the far target has to clear that by a real multiple or the fog
   mix is arithmetically a no-op and 20 m / 300 m come out the same value — which is
   precisely what "distant ridges have identical value to near terrain" means. The
   key/anti-key split is what stops the air being one flat wash across the frame;
   0.82 keeps the half of the sky behind the sun a fifth dimmer than the half in
   front of it, which is the right sign for forward scatter. */
const HAZE_SUN = 1.00;
const HAZE_OPP = 0.82;
/* How much of DAY_SKY_LIFT the far haze gets — and since the band no longer takes
   any of it, this is the whole daylight ratio. 0.80 puts the far target at 0.291 /
   0.238 scene-linear (key / anti-key) against a near-field haze pinned at 0.061
   and a lit moor at 0.032-0.050, which is the 4-6x walk that makes 30 m and 80 m
   read as two planes instead of one.
   The pre-existing note here said the haze must land BELOW the band or "the skyline
   inverts and the ridges disappear into it". That reasoning was written for a rig
   whose horizon is in shot. This one's is not: at 46 deg of pitch the top of the
   frame sits 22 deg BELOW level, so the only sky in frame is the sub-horizon band —
   which, being air at 22-30 deg down from a camera 35.6 m up, is looking at the
   same 60-90 m of atmosphere as the far ground itself. There is no horizon line in
   frame for the far haze to invert across, and the receding crests stay legible
   because uHzRock sits at 0.037 against both. */
const HAZE_DAY_K = 0.80;
/* Near-field haze. MEASURED: at 0.34 of the skyline this landed at 0.0440 while
   the reference stone albedo resolves to 0.0488, so the first 40 m of fog made the
   ground DARKER and the 20 m -> 40 m value went 0.04877 -> 0.04844 (a dip, i.e.
   non-monotone). At 0.50 it sits just above any plausible surface value, so the
   curve only ever climbs. */
const HAZE_NEAR = 0.76;
/* The air is never more chromatic than this. 0.13 was chosen purely to make the
   saturation-vs-depth curve monotone, and it over-corrected: with the two distance
   drains in Sky.js on top of it, the fully-fogged far field measured HSV saturation
   0.023-0.033, which is a grey wash and was the largest single contributor to the moor
   frame's 0.208 saturation — well over half its pixels sit past 60 m, where the fog
   owns 90 % of the result. 0.22 lets the air keep a readable hue; monotonicity is now
   held by the hue-bias weights below instead, and measured on the shipped fog probe
   this cap is no longer the binding term on the moor rig (0.22 and 0.30 resolve to the
   same curve). It still binds at a grazing sun, where the transmitted colour is
   (1, 0.25, 0.01) raw and would otherwise make the whole distance orange. */
const HAZE_SAT = 0.22;
const ROCK_LEVEL = 0.50;   // far-silhouette rock albedo*light, fraction of skyline

const LUMA = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Scale a colour to an exact luminance, preserving its hue ratios. */
function toLuma(src, target, out) {
  const l = LUMA(src);
  const k = l > 1e-7 ? target / l : 0;
  out[0] = src[0] * k; out[1] = src[1] * k; out[2] = src[2] * k;
  return out;
}

/** Pull a colour toward its own luminance until HSV saturation is <= maxSat. */
function limitSat(c, maxSat) {
  const hi = Math.max(c[0], c[1], c[2]);
  if (hi <= 1e-7) return c;
  const lo = Math.min(c[0], c[1], c[2]);
  const s = (hi - lo) / hi;
  if (s <= maxSat) return c;
  const l = LUMA(c);
  const t = 1 - maxSat / s;
  c[0] = lerp(c[0], l, t); c[1] = lerp(c[1], l, t); c[2] = lerp(c[2], l, t);
  return c;
}

function mix3(a, b, t, out) {
  out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t);
  return out;
}

/** Unit-max normalisation — strips level, keeps hue. */
function hueOf(src, out) {
  const m = Math.max(src[0], src[1], src[2], 1e-7);
  out[0] = src[0] / m; out[1] = src[1] / m; out[2] = src[2] / m;
  return out;
}

/**
 * Everything the sub-horizon band, the far-silhouette stack and the aerial fog
 * need, derived from one sky state so all three agree by construction.
 *
 * @param {object} S       computeSkyState() result
 * @param {{x:number,y:number,z:number}} keyDir  key light direction (sun by day, moon by night)
 * @param {object} opts    { biomeHaze:[r,g,b], fogAmount:0..1, weatherIntensity:0..1 }
 * @returns {{
 *   skyline:number, hi:number[], opp:number[], lo:number[], glow:number[],
 *   hazeNear:number[], hazeSun:number[], hazeOpp:number[],
 *   rock:number[][], rim:number[]
 * }}
 */
export function bandState(S, keyDir, opts = {}) {
  const biome = opts.biomeHaze ?? [0.38, 0.40, 0.45];
  const fogAmount = clamp(opts.fogAmount ?? 0.4, 0, 1);

  const kx = keyDir.x, ky = keyDir.y, kz = keyDir.z;
  const up = evalSkyColor(S, 0, 1, 0, [0, 0, 0]);
  const hs = evalSkyColor(S, kx, ky, kz, [0, 0, 0]);
  const ho = evalSkyColor(S, -kx, ky, -kz, [0, 0, 0]);

  /* A downward view collects light scattered out of the WHOLE dome, so the
     reference luminance weights the zenith in rather than only the two horizons
     — otherwise the hot forward-scatter lobe alone sets the level and a sunset
     drags the entire frame monochrome-orange. */
  const skyLum = Math.max(
    LUMA([(hs[0] + ho[0] + 2 * up[0]) * 0.25,
      (hs[1] + ho[1] + 2 * up[1]) * 0.25,
      (hs[2] + ho[2] + 2 * up[2]) * 0.25]),
    1e-5
  );
  /* The band, its glow, the rim and the far silhouette stack are all authored
     against this one number, and BAND_GAIN pins it to the 0.04-0.08 scene-linear
     window the `moor` grade can still render chroma and gradient inside. The
     daylight sky-to-ground ratio is therefore applied to the far HAZE alone (see
     DAY_SKY_LIFT and hazeLift below), which is the term that actually separates
     the depth planes; dragging the band up with it only flattened the sky. */
  const skyline = BAND_GAIN * Math.pow(skyLum, BAND_COMP);

  /* ---- hues ----
     Key side leans toward the sun's TRANSMITTED colour (long slant path through
     the atmosphere = red-shifted), which is the physical origin of a warm
     horizon; the anti-key side keeps the Rayleigh-dominated cool horizon hue and
     picks up the biome. `lowSun` decides how much of the warm shift is honest:
     at a 42 deg sun an overcast horizon is NOT orange, it is only *less blue*
     than the half of the sky behind you. */
  const lowSun = 1 - clamp((S.sunDir.y + 0.05) / 0.35, 0, 1);
  const warmH = hueOf(extinctionFor(S, { y: 0.06 }), [0, 0, 0]);
  // floor the short wavelengths — raw extinction at a grazing sun is (1, .25, .01),
  // which as a horizon hue is a pure-red instant fail.
  warmH[1] = Math.max(warmH[1], 0.46 * warmH[0]);
  warmH[2] = Math.max(warmH[2], 0.25 * warmH[0]);

  const sunH = hueOf(hs, [0, 0, 0]);
  const oppH = hueOf(ho, [0, 0, 0]);
  const biomeH = hueOf(biome, [0, 0, 0]);

  const hiHue = limitSat(mix3(sunH, warmH, 0.20 + 0.44 * lowSun, [0, 0, 0]), 0.34);
  const oppHue = limitSat(mix3(oppH, biomeH, 0.30, [0, 0, 0]), 0.30);
  const loHue = limitSat(mix3(oppH, biomeH, 0.58, [0, 0, 0]), 0.26);
  const rockHue = limitSat(mix3(loHue, biomeH, 0.35, [0, 0, 0]), 0.20);

  /* Heavier weather closes the value spread of the band (more scattering = less
     contrast between the skyline and the ground beneath it) and lifts the deep
     end. fogAmount does the same, more gently. */
  const wi = clamp(opts.weatherIntensity ?? 1, 0, 1);
  const murk = clamp((lerp(1, S.w.fogMul, wi) - 1) / 1.6, 0, 1);
  /* By day the anti-key half of the band has to come up close to the key half, and
     not for prettiness: with the daylight lift in place the fully-fogged far land
     resolves to 0.2225 scene-linear, and at the dusk-calibrated 0.735 the anti-key
     band sat at 0.204 — BELOW the land standing in front of it, so the silhouette
     inverted and the horizon stopped reading. An overcast deck is also genuinely
     near-uniform in azimuth (the sun's position barely shows through 0.80 coverage),
     whereas a moonlit night really is much darker away from the moon, which is what
     0.71 was measured against. Gated on S.sunUp, so every dusk and night rig keeps
     the old value exactly. */
  const oppK = lerp(lerp(BAND_OPP, 0.80, murk * 0.6), 0.90, S.sunUp);
  const loK = lerp(BAND_LO, 0.42, murk * 0.55 + fogAmount * 0.18);

  const hi = toLuma(hiHue, skyline, [0, 0, 0]);
  const opp = toLuma(oppHue, skyline * oppK, [0, 0, 0]);
  const lo = toLuma(loHue, skyline * loK, [0, 0, 0]);

  /* Horizon-warming glow. Additive, tight against the skyline, and honest:
     amplitude tracks how low the key light actually is.
     The high-sun floor was 0.22, which at `overworld`'s 42 deg sun resolved the
     glow to 0.0083 scene-linear — under the grade's toe, so the band had NO bright
     region anywhere and there was nothing for a ridgeline to rim against. A broken
     overcast deck at midday is exactly where the brightest patch in the frame
     lives (the cloud edge round the sun is the 5000 cd/m^2 part), so the floor is
     0.60: it puts a 0.023-above-band patch on the key azimuth, i.e. a 1.15x local
     lift the far crests read as a silhouette against. Cases with the key light
     actually low (lowSun = 1: `hub` at dusk, `night`) hit the same lerp endpoint as
     before and are bit-identical. */
  const glowK = BAND_GLOW * lerp(0.60, 1.0, lowSun) * lerp(1, 0.55, S.desat) * (1 - 0.55 * S.night);
  /* At a high sun the break is a WHITE hole in grey cloud, not an orange one —
     `warmH` is the grazing-path extinction hue (1, 0.46, 0.25 after flooring) and
     reads as sunset at any elevation. Blending back toward the key-side sky hue by
     (1 - lowSun) keeps dusk orange and makes midday neutral-warm. */
  const glowHue = limitSat(mix3(hiHue, warmH, 0.30 + 0.70 * lowSun, [0, 0, 0]), 0.34);
  const glow = toLuma(glowHue, skyline * glowK, [0, 0, 0]);

  /* ---- fog targets ----
     HAZE_SUN / HAZE_OPP are the readable horizon. Fully-fogged distant land converges on
     `hazeSun`/`hazeOpp`; the dome above it sits on `hi`/`opp`. Land must resolve
     BELOW the sky it stands against or the skyline vanishes — which is exactly
     what happened when the far target was derived as uSkGround * 1.52 and landed
     at 0.173 linear against a 0.16 dome (both measured). */
  /* The AIR's hue is capped much harder than the sky's. The anti-key horizon hue
     resolves to HSV sat 0.32, and a surface fogged toward a saturated blue passes
     through neutral and comes out the other side — measured saturation went
     0.058 at 80 m back up to 0.079 at 160 m, i.e. non-monotone. Capping the air
     at 0.20 (the sky band keeps 0.30) removes that overshoot. */
  /* The air's hue is also pulled toward the KEY-LIGHT side of the sky, hard.
     Left on the anti-solar horizon hue it is a definite blue, and a warm rock
     fogged toward a definite blue CROSSES neutral: measured saturation fell
     0.205 -> 0.012 at 80 m and then climbed back to 0.020 at 300 m as the blue
     took over — non-monotone. The air is lit mostly by forward-scattered
     sunlight, so a cool-neutral (not blue) haze is both the physically better
     answer and the one whose saturation curve only ever descends. */
  /* And it carries a WARM bias, which is what finally makes the saturation curve
     monotone for every surface hue rather than for most of them. Any fog whose
     hue sits on the opposite side of neutral from the surface makes saturation
     CROSS zero and climb again: measured on a mid stone albedo, 0.241 at 20 m ->
     0.0033 at 80 m -> 0.0101 at 300 m. Air is lit mostly by the sun's
     transmitted light, which at any elevation is red-shifted, so biasing the haze
     toward that colour is both the physical answer and the one that removes the
     crossing. The cap keeps it a whisper (HSV 0.13) — the SKY stays cool at
     0.14-0.32, so the frame still reads cold base / warm distance rather than
     warm everywhere. */
  /* The warm-bias weights were 0.35 / 0.85 / 0.80 and are now 0.26 / 0.62 / 0.66. They
     are the term that actually holds the saturation curve monotone, so they were tuned
     against the shipped fog probe rather than by eye, and the measurement is worth
     recording because the failure mode is subtle. Any fog whose hue sits on the
     OPPOSITE side of neutral from the surface makes saturation cross zero and climb
     again on the far side. Pulled all the way to 0.20 / 0.45 / 0.55 — which is what an
     overcast day's genuinely blue-grey distance wants — the anti-key haze went cool
     against the probe's warm reference stone and the curve measured 0.237 at 20 m,
     0.021 at 58 m, then back UP to 0.032 at 80 m: a crossing, exactly as documented
     below. At 0.26 / 0.62 / 0.66 the same probe reads
     0.244 / 0.187 / 0.145 / 0.104 / 0.073 / 0.049 / 0.047 / 0.046 / 0.045 / 0.043 /
     0.041 at 20-190 m, i.e. non-increasing at every step, while still leaving the
     anti-key side visibly cooler than the key side so the air is not one flat wash. */
  const hazeSunHue = limitSat(mix3(hiHue, warmH, 0.26, [0, 0, 0]), HAZE_SAT);
  const hazeOppHue = limitSat(mix3(oppHue, hazeSunHue, 0.62, [0, 0, 0]), HAZE_SAT);
  const hazeNearHue = limitSat(mix3(loHue, hazeSunHue, 0.66, [0, 0, 0]), HAZE_SAT);
  const hazeLift = lerp(1, DAY_SKY_LIFT * HAZE_DAY_K, S.sunUp);
  const hazeSun = toLuma(hazeSunHue, skyline * hazeLift * HAZE_SUN, [0, 0, 0]);
  const hazeOpp = toLuma(hazeOppHue, skyline * hazeLift * HAZE_OPP, [0, 0, 0]);
  /* Near haze stays on the UNLIFTED reference. The whole point of the daylight
     lift is to open the ratio between the two ends of the aerial ramp; scaling both
     ends would move the near field with it and change nothing about the separation,
     while lifting the near ground straight off the grade's toe and taking p01 with
     it. Pinned here, the shipped fog probe reads 0.0502 linear at 20 m against
     0.2434 at 300 m — a 4.85x walk where the pre-fix rig measured 1.06x. */
  const hazeNear = toLuma(hazeNearHue, skyline * HAZE_NEAR * lerp(0.80, 1.25, fogAmount), [0, 0, 0]);

  /* ---- far silhouette stack ----
     One rock family, four fog depths. That is how aerial perspective actually
     separates receding ranges: same material, progressively more of the air in
     front of it. Values staggered a hair so the layers are not arithmetically
     identical where their fog mixes happen to coincide. */
  /* By day the far crests are the DARK half of the sky-to-ground ratio: rock at
     albedo 0.09 under a 20:1 deck cannot approach the deck's own value. At
     ROCK_LEVEL the stack lands at 0.0371 against a 0.074 band and a 0.24-0.29 far
     haze, so the receding ranges read as shapes cut out of the air rather than as
     four grey steps a hair apart from it. */
  const rockL = skyline * ROCK_LEVEL;
  const rock = [
    toLuma(rockHue, rockL * 1.00, [0, 0, 0]),
    toLuma(rockHue, rockL * 0.94, [0, 0, 0]),
    toLuma(rockHue, rockL * 0.87, [0, 0, 0]),
  ];

  const rim = toLuma(warmH, skyline * 0.42, [0, 0, 0]);

  return { skyline, skyLum, hi, opp, lo, glow, hazeNear, hazeSun, hazeOpp, rock, rim, lowSun };
}

/** Extinction (transmittance) along a direction — this is the sun's colour. */
export function extinctionFor(S, dir) {
  const cz = Math.max(0, dir.y);
  const zAng = Math.acos(clamp(cz, -1, 1));
  const inv = 1.0 / (Math.cos(zAng) + 0.15 * Math.pow(Math.max(93.885 - (zAng * 180) / Math.PI, 1e-3), -1.253));
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;
  return [
    Math.exp(-(S.betaR[0] * sR + S.betaM[0] * sM)),
    Math.exp(-(S.betaR[1] * sR + S.betaM[1] * sM)),
    Math.exp(-(S.betaR[2] * sR + S.betaM[2] * sM)),
  ];
}

/**
 * Evaluate the sky (atmosphere + twilight + night base, no stars/clouds) in a
 * direction. Returns linear radiance, exactly what the shader produces for the
 * same direction — this is what makes the fog colour genuinely "sky sampled".
 */
export function evalSkyColor(S, dx, dy, dz, out = [0, 0, 0]) {
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;

  const Fex = extinctionFor(S, { y: dy });
  const cosT = dx * S.sunDir.x + dy * S.sunDir.y + dz * S.sunDir.z;
  const rP = rayleighPhase(cosT);
  const mP = hgPhase(cosT, S.mieG);

  const upDotSun = clamp(S.sunDir.y, -1, 1);
  const mixT = clamp(Math.pow(Math.max(1.0 - upDotSun, 0), 5.0), 0, 1);

  for (let i = 0; i < 3; i++) {
    const bR = S.betaR[i] * rP;
    const bM = S.betaM[i] * mP;
    const ratio = (bR + bM) / (S.betaR[i] + S.betaM[i]);
    let Lin = Math.pow(Math.max(S.sunE * ratio * (1.0 - Fex[i]), 0), 1.5);
    const alt = Math.pow(Math.max(S.sunE * ratio * Fex[i], 0), 0.5);
    Lin *= lerp(1.0, alt, mixT);
    const L0 = 0.1 * Fex[i];
    out[i] = (Lin + L0) * 0.04 * ATMOS_GAIN;
  }
  out[1] += 0.0003; out[2] += 0.00075;

  /* ---- twilight: wavelength-shifted horizon band + belt of Venus ---- */
  const horiz = Math.exp(-Math.max(dy, 0) / 0.135);
  const below = smoothstep(-0.17, 0.005, dy);
  const shx = S.sunDir.x, shz = S.sunDir.z;
  const sl = Math.hypot(shx, shz) || 1e-5;
  const dl = Math.hypot(dx, dz) || 1e-5;
  const azDot = (dx * shx + dz * shz) / (dl * sl);
  const az = Math.pow(clamp(azDot * 0.5 + 0.5, 0, 1), 2.4);
  const tw = S.twilight * S.twilightGain;
  const warm = [1.00, 0.335, 0.095];
  const mid = [0.63, 0.255, 0.30];
  const cold = [0.155, 0.170, 0.345];
  const bov = Math.exp(-Math.pow((dy - 0.105) / 0.095, 2)) * (1.0 - az) * S.twilight * 0.55 * S.twilightGain;
  for (let i = 0; i < 3; i++) {
    const inner = lerp(mid[i], warm[i], az * az);
    out[i] += lerp(cold[i], inner, az) * tw * horiz * below;
    out[i] += [0.30, 0.155, 0.215][i] * bov;
  }

  /* ---- night base ---- */
  if (S.night > 0.001) {
    const hz = Math.exp(-Math.max(dy, 0) / 0.26);
    const nb = [
      lerp(0.0062, 0.0268, hz),
      lerp(0.0086, 0.0312, hz),
      lerp(0.0232, 0.0470, hz),
    ];
    // faint moon-side wash so the night sky is not flat
    const mDot = clamp(dx * S.moonDir.x + dy * S.moonDir.y + dz * S.moonDir.z, -1, 1);
    const mWash = Math.pow(Math.max(mDot, 0), 5.0) * 0.055 * S.moonUp;
    for (let i = 0; i < 3; i++) out[i] += (nb[i] + mWash * [0.72, 0.80, 1.0][i]) * S.night;
  }

  /* ---- soft knee (must mirror skKnee() in GLSL) ---- */
  skyKnee(out);

  /* ---- weather grade ---- */
  const lum = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
  for (let i = 0; i < 3; i++) {
    out[i] = lerp(out[i], lum, S.desat) * S.tint[i];
    if (!(out[i] >= 0)) out[i] = 0;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DETERMINISTIC PERIODIC NOISE  (CPU)  — tiling, seamless, no Math.random
   ═══════════════════════════════════════════════════════════════════════════ */

const wrap = (n, p) => ((n % p) + p) % p;

function pperlin2(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const g = (ix, iy, ddx, ddy) => {
    const a = hash2(wrap(ix, period), wrap(iy, period), seed) * TAU;
    return Math.cos(a) * ddx + Math.sin(a) * ddy;
  };
  return (
    lerp(
      lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
      lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u),
      v
    ) * 0.7071 + 0.5
  );
}

function pfbm2(u, v, period, octaves, seed, gain = 0.5, ridged = false) {
  let amp = 0.5, f = period, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = pperlin2(u * f, v * f, f, seed + i * 131);
    if (ridged) n = 1 - Math.abs(n * 2 - 1);
    sum += n * amp; norm += amp;
    amp *= gain; f *= 2;
  }
  return sum / norm;
}

function pworley2(u, v, cells, seed) {
  const x = u * cells, y = v * cells;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = wrap(cx, cells), wy = wrap(cy, cells);
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 977);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < f1) f1 = d;
    }
  }
  return clamp(Math.sqrt(f1), 0, 1);
}

function worleyFbm(u, v, base, seed, octaves = 3) {
  if (octaves <= 1) return 1 - pworley2(u, v, base, seed);
  if (octaves === 2) {
    return (1 - pworley2(u, v, base, seed)) * 0.66 +
           (1 - pworley2(u, v, base * 2, seed + 31)) * 0.34;
  }
  return (
    (1 - pworley2(u, v, base, seed)) * 0.55 +
    (1 - pworley2(u, v, base * 2, seed + 31)) * 0.30 +
    (1 - pworley2(u, v, base * 4, seed + 67)) * 0.15
  );
}

const remap = (x, a, b, c, d) => c + ((clamp(x, Math.min(a, b), Math.max(a, b)) - a) / (b - a || 1e-6)) * (d - c);

/* ═══════════════════════════════════════════════════════════════════════════
   CLOUD NOISE TEXTURE
   ═══════════════════════════════════════════════════════════════════════════ */

const _noiseCache = new Map();

/**
 * RGBA tiling cloud noise.
 *   R — perlin-worley coverage field (big shapes, domain warped)
 *   G — billow (inverted worley fbm), mid frequency — puffiness / erosion
 *   B — fine worley, high frequency — edge erosion
 *   A — ridged fbm, very low frequency — cloud *type* (stratus <-> cumulus)
 *
 * Also returns the raw R field as a Float32Array so the cloud-shadow map can
 * be re-thresholded per weather without regenerating any noise.
 */
export function buildCloudNoise(size = 256, seed = 20873) {
  const key = `${size}:${seed}`;
  const hit = _noiseCache.get(key);
  if (hit) return hit;

  const px = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const inv = 1 / size;
  let fmin = Infinity, fmax = -Infinity;

  for (let y = 0; y < size; y++) {
    const v = y * inv;
    for (let x = 0; x < size; x++) {
      const u = x * inv;

      // domain warp keeps the coverage field from reading as lattice noise
      const wx = (pfbm2(u, v, 3, 3, seed + 5) - 0.5) * 0.38;
      const wy = (pfbm2(u, v, 3, 3, seed + 71) - 0.5) * 0.38;

      const perlin = pfbm2(u + wx, v + wy, 4, 5, seed);
      const billowLow = worleyFbm(u + wx * 0.5, v + wy * 0.5, 5, seed + 211, 3);
      // Schneider's perlin-worley remap: perlin shapes, worley bites into it
      let pw = remap(perlin, billowLow - 1.0, 1.0, 0.0, 1.0);
      pw = clamp(Math.pow(pw, 1.12), 0, 1);

      const billowMid = worleyFbm(u, v, 9, seed + 401, 2);
      const fine = worleyFbm(u, v, 26, seed + 733, 1);
      const type = pfbm2(u, v, 2, 4, seed + 909, 0.55, true);

      const o = (y * size + x) * 4;
      px[o + 1] = (clamp(billowMid, 0, 1) * 255) | 0;
      px[o + 2] = (clamp(fine, 0, 1) * 255) | 0;
      px[o + 3] = (clamp(type, 0, 1) * 255) | 0;
      field[y * size + x] = pw;
      if (pw < fmin) fmin = pw;
      if (pw > fmax) fmax = pw;
    }
  }

  /* Second pass: stretch the coverage field to the full 0..1 range. Without
     this the perlin-worley remap leaves it bunched around 0.6 and the coverage
     threshold in the shader either wipes the clouds out or floods the sky. */
  const span = 1 / Math.max(fmax - fmin, 1e-4);
  for (let i = 0; i < field.length; i++) {
    const v = clamp((field[i] - fmin) * span, 0, 1);
    field[i] = v;
    px[i * 4] = (v * 255) | 0;
  }

  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'nona.cloudNoise';

  const res = { texture: tex, field, size };
  _noiseCache.set(key, res);
  return res;
}

/**
 * Ground cloud-shadow map derived from the same coverage field the sky uses.
 * White = lit, black = under a cloud. Softened so it reads as a real penumbra.
 */
export function buildCloudShadowTexture(noise, coverage, softness = 1.0) {
  const { field, size } = noise;
  const n = size * size;
  const soft = new Float32Array(n);

  // separable box blur (2 passes) -> soft penumbra, still tiling
  const r = Math.max(1, Math.round(2 + softness * 3));
  const tmp = new Float32Array(n);
  const invW = 1 / (r * 2 + 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += field[y * size + wrap(x + k, size)];
      tmp[y * size + x] = s * invW;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[wrap(y + k, size) * size + x];
      soft[y * size + x] = s * invW;
    }
  }

  const data = new Uint8Array(n * 4);
  const cvg = clamp(coverage, 0, 1);
  const thr = 1.0 - cvg;
  const knee = Math.max(cvg * 0.55, 0.12);
  for (let i = 0; i < n; i++) {
    // density above the coverage threshold -> shadow
    const d = clamp((soft[i] - thr) / knee, 0, 1);
    const shade = 1.0 - d * d * (3 - 2 * d);
    const b = (clamp(shade, 0, 1) * 255) | 0;
    const o = i * 4;
    data[o] = b; data[o + 1] = b; data[o + 2] = b; data[o + 3] = 255;
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'nona.cloudShadow';
  return tex;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GLSL BLOCKS
   ═══════════════════════════════════════════════════════════════════════════ */

/** Hashes + value noise, shared by every shader below. */
export const GLSL_HASH = /* glsl */`
float skHash11( float p ) {
  p = fract( p * 0.1031 );
  p *= p + 33.33;
  p *= p + p;
  return fract( p );
}
float skHash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float skHash13( vec3 p3 ) {
  p3 = fract( p3 * 0.1031 );
  p3 += dot( p3, p3.zyx + 31.32 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec3 skHash33( vec3 p3 ) {
  p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yxx ) * p3.zyx );
}
float skNoise2( vec2 x ) {
  vec2 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = skHash21( i );
  float b = skHash21( i + vec2( 1.0, 0.0 ) );
  float c = skHash21( i + vec2( 0.0, 1.0 ) );
  float d = skHash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float skNoise3( vec3 x ) {
  vec3 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = skHash13( i );
  float n100 = skHash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = skHash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = skHash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = skHash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = skHash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = skHash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = skHash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ), f.z );
}
float skFbm3a( vec3 p ) {
  return skNoise3( p ) * 0.5333 + skNoise3( p * 2.03 + 17.1 ) * 0.2667
       + skNoise3( p * 4.11 + 5.7 ) * 0.1333 + skNoise3( p * 8.33 + 29.3 ) * 0.0667;
}
float skFbm2a( vec2 p ) {
  return skNoise2( p ) * 0.5161 + skNoise2( p * 2.07 + 13.1 ) * 0.2581
       + skNoise2( p * 4.13 + 7.3 ) * 0.1290 + skNoise2( p * 8.21 + 31.7 ) * 0.0645
       + skNoise2( p * 16.7 + 3.9 ) * 0.0323;
}
mat2 skRot( float a ) { float c = cos( a ), s = sin( a ); return mat2( c, -s, s, c ); }
`;

/**
 * The analytic sky, shared verbatim in spirit with evalSkyColor() above.
 * Requires uniforms: uSunDir uMoonDir uBetaR uBetaM uSunE uMieG uTwilight
 * uTwilightGain uNight uMoonUp uDesat uTint.
 */
export const GLSL_ATMOS = /* glsl */`
const float SK_PI = 3.141592653589793;
float skRayleighPhase( float c ) { float k = c * 0.5 + 0.5; return 0.05968310365946075 * ( 1.0 + k * k ); }
float skHG( float c, float g ) {
  float g2 = g * g;
  return 0.07957747154594767 * ( ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}
vec3 skExtinction( float dirY ) {
  float zA = acos( max( 0.0, dirY ) );
  float inv = 1.0 / ( cos( zA ) + 0.15 * pow( max( 93.885 - degrees( zA ), 1e-3 ), -1.253 ) );
  return exp( - ( uBetaR * ( 8.4e3 * inv ) + uBetaM * ( 1.25e3 * inv ) ) );
}
vec3 skAtmosphere( vec3 dir ) {
  vec3 Fex = skExtinction( dir.y );
  float cosT = dot( dir, uSunDir );
  vec3 bR = uBetaR * skRayleighPhase( cosT );
  vec3 bM = uBetaM * skHG( cosT, uMieG );
  vec3 ratio = ( bR + bM ) / ( uBetaR + uBetaM );
  vec3 Lin = pow( max( uSunE * ratio * ( 1.0 - Fex ), vec3( 0.0 ) ), vec3( 1.5 ) );
  float t = clamp( pow( max( 1.0 - uSunDir.y, 0.0 ), 5.0 ), 0.0, 1.0 );
  Lin *= mix( vec3( 1.0 ), pow( max( uSunE * ratio * Fex, vec3( 0.0 ) ), vec3( 0.5 ) ), t );
  vec3 L0 = vec3( 0.1 ) * Fex;
  return ( Lin + L0 ) * ( 0.04 * ${ATMOS_GAIN.toFixed(5)} ) + vec3( 0.0, 0.0003, 0.00075 );
}
vec3 skTwilight( vec3 dir ) {
  float horiz = exp( - max( dir.y, 0.0 ) / 0.135 );
  float below = smoothstep( -0.17, 0.005, dir.y );
  vec2 dl = normalize( vec2( dir.x, dir.z ) + vec2( 1e-5 ) );
  vec2 sl = normalize( vec2( uSunDir.x, uSunDir.z ) + vec2( 1e-5 ) );
  float az = pow( clamp( dot( dl, sl ) * 0.5 + 0.5, 0.0, 1.0 ), 2.4 );
  vec3 warm = vec3( 1.00, 0.335, 0.095 );
  vec3 midc = vec3( 0.63, 0.255, 0.30 );
  vec3 cold = vec3( 0.155, 0.170, 0.345 );
  vec3 band = mix( cold, mix( midc, warm, az * az ), az ) * ( uTwilight * uTwilightGain ) * horiz * below;
  float bov = exp( - pow( ( dir.y - 0.105 ) / 0.095, 2.0 ) ) * ( 1.0 - az ) * uTwilight * 0.55 * uTwilightGain;
  return band + vec3( 0.30, 0.155, 0.215 ) * bov;
}
vec3 skNightBase( vec3 dir ) {
  float hz = exp( - max( dir.y, 0.0 ) / 0.26 );
  vec3 nb = vec3( mix( 0.0062, 0.0268, hz ), mix( 0.0086, 0.0312, hz ), mix( 0.0232, 0.0470, hz ) );
  float mWash = pow( max( dot( dir, uMoonDir ), 0.0 ), 5.0 ) * 0.055 * uMoonUp;
  return nb + mWash * vec3( 0.72, 0.80, 1.0 );
}
vec3 skKnee( vec3 c ) {
  float m = max( max( c.r, c.g ), c.b );
  return c / ( 1.0 + m * ${(1 / SKY_KNEE).toFixed(6)} );
}
vec3 skGrade( vec3 c ) {
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  return mix( c, vec3( l ), uDesat ) * uTint;
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   SUB-HORIZON AERIAL BAND  (GLSL)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The band below level, which on every shipped camera rig IS the sky the player
 * sees (see bandState() above for the measured geometry). Four things happen
 * here, and each one exists because its absence was visible in a capture:
 *
 *  1. AZIMUTHAL COLOUR TEMPERATURE. `uBandHi` (key-light side) against
 *     `uBandOpp` (away from it), blended by the horizontal dot with the key
 *     azimuth. Over overworld's 76 deg of horizontal FOV that dot runs +0.48 at
 *     the left edge to -0.56 at the right, so the two ends of the band are
 *     measurably different in both value and hue. This is the ONLY cue of light
 *     direction available when the disc is off-frame, which it always is.
 *  2. A VALUE RAMP measured from the skyline downward — the lit air column you
 *     look through shortens as you look further down. Parameterised on
 *     tan(depression) from `uBandCurve.x` so the ramp is anchored to the skyline
 *     rather than to the frame, and spans `1/uBandCurve.y` of it.
 *  3. HORIZON WARMING: a tight exponential glow hugging the skyline on the key
 *     side only.
 *  4. TWO HAZE STRATA so the air has structure at any zoom. The previous band
 *     had one 16 % noise term and measured sd 0.18 across the wedge almost
 *     entirely from the terrain edge, not from the sky itself.
 *
 * Requires GLSL_HASH first. Uniforms:
 *   uBandHi uBandOpp uBandLo uBandGlow  vec3
 *   uBandCurve vec4( skylineS, 1/rampSpan, sidePow, rampPow )
 *   uBandStrat vec3( base, strat1Amp, strat2Amp )
 *   uBandGlowW float
 */
export const GLSL_BAND = /* glsl */`
vec3 skAerialBand( vec3 dir, vec2 keyAz ) {
  float hl = max( length( dir.xz ), 1e-4 );
  float s = -dir.y / hl;                                   // tan(depression)
  vec2 dl = normalize( dir.xz + vec2( 1e-5 ) );
  float side = clamp( dot( dl, keyAz ) * 0.5 + 0.5, 0.0, 1.0 );

  vec3 hi = mix( uBandOpp, uBandHi, pow( side, uBandCurve.z ) );
  float d = clamp( ( s - uBandCurve.x ) * uBandCurve.y, 0.0, 1.0 );
  vec3 col = mix( hi, uBandLo, pow( d, uBandCurve.w ) );

  col += uBandGlow * exp( - max( s - uBandCurve.x, 0.0 ) / uBandGlowW ) * pow( side, 2.6 );

  float azp = atan( dir.z, dir.x );
  float st1 = skFbm2a( vec2( azp * 0.92, s * 3.6 ) );
  float st2 = skNoise2( vec2( azp * 2.70, s * 9.1 ) + 11.3 );
  col *= uBandStrat.x + uBandStrat.y * st1 + uBandStrat.z * st2;
  return max( col, vec3( 0.0 ) );
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   FAR-HORIZON SILHOUETTE  (evaluated from the view direction, inside the dome)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The horizon used to be three transparent cylinder meshes at 320/430/560 m.
 * They were drawn every frame and produced nothing: Terrain's far apron is
 * opaque, writes depth, and silhouettes across exactly the band the rings
 * occupied, so all three failed the depth test in every exterior frame — and
 * the two thirds of each cylinder below tan(depression) 1.27 were clipped by
 * the 900 m far plane on top of that.
 *
 * A ridge line kilometres away is a pure FUNCTION OF DIRECTION — it has no
 * usable parallax at ARPG camera speeds — so it belongs in the dome shader.
 * Folded in here it cannot be depth-culled, cannot be far-plane clipped, costs
 * zero draw calls and zero programs, and is guaranteed to sit behind every
 * piece of real geometry because the dome only ever shades unwritten pixels.
 *
 * `s` below is tan(depression) = -dir.y / |dir.xz|. It is the one coordinate
 * that makes receding layers stackable: a skyline at s = S covers every
 * direction steeper than S regardless of how far away the range "is". The
 * camera geometry that fixes the usable range, MEASURED off the shipped rig
 * rather than guessed: on `overworld` the visible sky wedge runs s = 0.363 at
 * the top centre, 0.376-0.538 in the top-left wedge and 0.363-0.496 in the
 * top-right one, and the moor's own plateau rim silhouettes at s = 0.45-0.55
 * (Terrain's apron sits below 0.595 and no longer eats the band).
 *
 * FOUR layers now, not three, and the change is not cosmetic:
 *
 *  - The old stack based at 0.368 / 0.410 / 0.456 put the FARTHEST layer's crest
 *    at s = 0.338-0.368, i.e. inside the top 10 px of the frame. Its coverage
 *    step is `smoothstep(top-aa, top+aa, s)` with aa = fwidth(s)*1.25, so it
 *    resolved to a ONE-TO-TWO PIXEL hard edge running horizontally across the
 *    whole top of frame. That edge is what read as "a hard cloud-layer geometry
 *    seam" — there is no cloud geometry anywhere near it; the raymarched layer
 *    early-outs below dir.y = 0.004 and the whole frame is at dir.y < -0.31.
 *    It is fixed two ways: `uHzSoft` widens every crest by a haze-driven amount
 *    (a ridge 20 km out through 0.6 of optical depth has a crest softened over
 *    tenths of a degree, not over one pixel), and each layer spills haze UP over
 *    its own crest, which is what a real range does to the sky above it.
 *  - A broad low-frequency LANDMASS band sits above the three ridges so there is
 *    a continuous readable horizon at every azimuth, including where the ridges
 *    dip. Previously the gaps between crests fell straight through to bare band.
 *
 * Requires GLSL_HASH (skNoise2 / skHash11) to be included first.
 */
export const GLSL_HORIZON = /* glsl */`
/* Ridged azimuthal profile — five octaves, explicit seed / frequency / power.
   The frequencies are high on purpose. A 48 deg FOV spans roughly 40 deg of
   azimuth, so a fundamental of 3-6 cycles per full turn puts less than half a
   crest in frame and the silhouette reads as one smooth wave rather than as a
   range. 15-29 cycles per turn puts 2-4 crests plus their octaves in shot. */
float skHzRidge( float az, float freq, float seed, float pw ) {
  vec2 c = vec2( cos( az ), sin( az ) );
  float h = 0.0, amp = 0.5, fr = freq, nrm = 0.0;
  for ( int i = 0; i < 5; i ++ ) {
    float n = skNoise2( c * fr + seed );
    n = 1.0 - abs( n * 2.0 - 1.0 );
    h += n * amp; nrm += amp;
    amp *= 0.52; fr *= 2.07;
  }
  return pow( clamp( h / nrm, 0.0, 1.0 ), pw );
}

/**
 * One receding silhouette layer. Returns rgb in .xyz and coverage in .w, and
 * writes its skyline (in tan(depression)) to 'topOut' so the caller can spill
 * haze above the crest.
 *
 * base/amp are in tan(depression); the skyline sits at base - ridge * amp, so a
 * bigger ridge value reads HIGHER in the frame.
 */
vec4 skHzLayer(
  float az, float s, float aa,
  float base, float amp, float bodySpan, float freq, float seed, float pw,
  vec3 rock, vec3 haze, float fogMix, float poolMix, float mist,
  float spireCount, vec3 rimCol, float rimGain, vec2 sunAz,
  float bandStep, float bandAmp, float bandCount, vec2 bandHaze,
  out float topOut
) {
  float ridge = skHzRidge( az, freq, seed, pw );
  float top = base - ridge * amp;

  /* Broken crenellated spires on the farthest ridge only (spireCount > 0).
     The lift is capped well under amp on purpose: the crest is authored just
     inside the top scanline, so a tall spire would be guillotined by the frame
     edge instead of breaking the skyline. */
  if ( spireCount > 0.5 ) {
    float u = az * 0.15915494 + 0.5;
    float sec = floor( u * spireCount );
    float a1 = skHash11( sec * 1.13 + seed * 7.7 );
    float a2 = skHash11( sec * 2.71 + 5.3 + seed * 7.7 );
    float a3 = skHash11( sec * 4.37 + 9.1 + seed * 7.7 );
    if ( a1 > 0.60 ) {
      float w = ( 0.09 + 0.22 * a2 ) * 0.5;
      float cen = ( sec + 0.5 + ( a2 - 0.5 ) * 0.45 ) / spireCount;
      float dd = abs( fract( u - cen + 0.5 ) - 0.5 ) * spireCount;
      if ( dd < w ) {
        float lift = ( 0.22 + 0.62 * a1 ) * amp * 0.30;
        lift *= 0.70 + 0.30 * skHash11( floor( dd * 10.0 ) * 3.7 + sec * 31.0 + a3 );
        top = min( top, base - amp - lift );
      }
    }
  }

  topOut = top;
  float cov = smoothstep( top - aa, top + aa, s );
  if ( cov < 0.002 ) return vec4( 0.0 );

  /* Value falls from the crest down into the body of the range, and haze pools
     at its foot — that vertical gradient is what stops a silhouette reading as
     a flat paper cut-out.
     'bodySpan' is DECOUPLED from 'amp' on purpose. It used to be amp * 3.2, and
     for a broad low-amplitude layer that is 0.05 of tan(depression) while the
     layer's visible extent in frame is 0.10-0.14 — so depthT clamped to 1 across
     the whole thing and the body resolved to ONE value. That is measurable: the
     top band of the frame came out sd 0.013 over a 180x40 px window, i.e.
     literally the featureless rectangle the review named. bodySpan is now set to
     each layer's actual visible extent so its gradient lands inside the frame. */
  float depthT = clamp( ( s - top ) / max( bodySpan, 1e-3 ), 0.0, 1.0 );
  vec3 body = rock * ( 0.58 + 0.42 * ( 1.0 - depthT ) );
  /* Broad azimuthal shading — spurs and shaded flanks across the range. Without
     it a layer is a constant along every horizontal scanline, which no amount of
     fine grain disguises. */
  body *= 0.80 + 0.40 * skNoise2( vec2( az * 6.3, s * 9.0 ) + seed * 0.61 );
  /* Fine grain. The old term ran at 88 cycles per unit s, which over the 0.18 of
     s the frame spans is one cycle every ~10 px — mottled blocking, not rock.
     230 puts it under 4 px and it reads as material. */
  body *= 0.91 + 0.18 * skNoise2( vec2( az * 128.0, s * 230.0 ) + seed );
  float pool = smoothstep( 0.04, 0.96, depthT );
  vec3 col = mix( body, haze, clamp( fogMix + pool * poolMix, 0.0, 1.0 ) );

  /* Sub-ridges further down the same layer: extra breaks of slope so one layer
     reads as several receding spurs rather than one wall. */
  int nb = int( bandCount + 0.5 );
  for ( int k = 0; k < 3; k ++ ) {
    if ( k >= nb ) break;
    float fk = float( k );
    float rr = skHzRidge( az, freq * ( 1.42 + 0.95 * fk ), seed + 21.37 * ( fk + 1.0 ), 1.30 );
    float edge = top + bandStep * ( fk + 1.0 ) + ( rr - 0.5 ) * bandAmp * ( 0.7 + 0.5 * fk );
    float m = smoothstep( edge - aa, edge + aa, s );
    float t = nb > 1 ? fk / float( nb - 1 ) : 0.0;
    float hz = mix( bandHaze.x, bandHaze.y, t );
    vec3 band = mix( rock * ( 0.68 + 0.52 * t ), haze, clamp( hz, 0.0, 1.0 ) );
    col = mix( col, band, m );
    // a break of slope LIGHTENS toward the haze in real aerial perspective
    float lip = 1.0 - clamp( abs( s - edge ) / max( aa * 8.0, 0.004 ), 0.0, 1.0 );
    col = mix( col, haze * 0.96, lip * lip * 0.34 * mist );
  }

  // sun-side rim on the skyline — the only earned highlight this far out
  float side = clamp( dot( normalize( vec2( cos( az ), sin( az ) ) ), sunAz ) * 0.5 + 0.5, 0.0, 1.0 );
  float rim = 1.0 - smoothstep( 0.0, amp * 0.26, s - top );
  col += rimCol * rim * pow( side, 2.2 ) * rimGain;

  // low mist bank riding the foot of the range
  col = mix( col, haze * 0.94, smoothstep( 0.58, 1.0, depthT ) * mist );

  return vec4( col, cov );
}

/**
 * The whole stack. 'sky' is what the dome already resolved to in this direction
 * (the sub-horizon aerial band); layers composite over it far-to-near, each one
 * spilling haze up over its own crest so no crest is a hard line.
 *
 * Requires uniforms uHzRock0/1/2, uHzFog, uHzRim, uHzRimGain, uHzMist, uHzSoft,
 * uHzSpill.
 */
/* Composite one layer over the stack, then spill haze UP over its own crest.
   The spill is the seam fix: a crest whose only transition is a 1-2 px coverage
   smoothstep reads as cut paper (or, as the last review put it, as a hard
   cloud-layer geometry seam). A real range through 0.5-0.8 of optical depth
   bleeds haze into the sky above it over a visible angular distance, and the
   bleed is strongest on the layer with the most air in front of it. */
vec3 skHzOver( vec3 col, vec4 L, vec3 haze, float top, float s, float aa, float spill ) {
  col = mix( col, L.xyz, L.w );
  col += haze * ( uHzSpill * spill )
       * exp( - max( top - s, 0.0 ) / max( aa * 3.2, 1e-4 ) ) * ( 1.0 - L.w );
  return col;
}

vec3 skHorizonStack( vec3 dir, vec3 sky, vec3 haze, vec2 sunAz ) {
  float hl = max( length( dir.xz ), 1e-4 );
  float s = -dir.y / hl;
  if ( s <= 0.310 ) return sky;
  float az = atan( dir.z, dir.x );
  float px = fwidth( s ) * 1.25 + 3e-4;

  vec3 col = sky;
  vec4 L;
  float top = 1.0;

  /* Bases MEASURED against the wedge the shipped overworld rig actually leaves
     open above the terrain: raycast through the live camera puts unoccluded sky
     at s = 0.373-0.421 at x = 1250 and s = 0.387-0.440 at x = 350, with the moor
     itself taking over at s = 0.458 (x = 1250) and s = 0.497 (x = 350). So the
     WHOLE stack has to live inside s = 0.36 .. 0.47 — a window 0.11 wide.
     Bases at 0.368/0.410/0.456 put the farthest crest above the window (top of
     frame was that layer's flat body, skyline never in shot); bases at
     0.408/0.442/0.478/0.518 pushed the nearest two BEHIND the moor. 0.390 /
     0.415 / 0.440 / 0.465 with amplitudes near 0.027 packs four crests into the
     window with a few pixels of bare band above the farthest one at the corners. */

  /* 0 — LANDMASS. Broad, low frequency, almost fully hazed: a continuous
     readable horizon at every azimuth so the ridge gaps never fall through to
     bare band. Two sub-ridges give it internal breaks of slope; no spires. */
  float aa0 = px + uHzSoft * 1.00;
  L = skHzLayer( az, s, aa0, 0.3900, 0.0280, 0.075, 9.0, 41.09, 0.92,
                 uHzRock0, haze, clamp( uHzFog * 1.00, 0.0, 1.0 ), 0.10, uHzMist * 1.10,
                 0.0, uHzRim, uHzRimGain * 0.45, sunAz,
                 0.0100, 0.0062, 2.0, vec2( 0.78, 0.86 ),
                 top );
  col = skHzOver( col, L, haze, top, s, aa0, 1.00 );

  /* 1 — farthest RIDGE: spires, most haze of the three. */
  float aa1 = px + uHzSoft * 0.74;
  L = skHzLayer( az, s, aa1, 0.4150, 0.0260, 0.060, 15.0, 3.17, 1.18,
                 uHzRock0, haze, clamp( uHzFog * 0.82, 0.0, 1.0 ), 0.15, uHzMist * 1.00,
                 44.0, uHzRim, uHzRimGain * 0.62, sunAz,
                 0.0085, 0.0052, 2.0, vec2( 0.62, 0.72 ),
                 top );
  col = skHzOver( col, L, haze, top, s, aa1, 0.78 );

  float aa2 = px + uHzSoft * 0.48;
  L = skHzLayer( az, s, aa2, 0.4400, 0.0260, 0.055, 21.0, 11.73, 1.38,
                 uHzRock1, haze, clamp( uHzFog * 0.64, 0.0, 1.0 ), 0.19, uHzMist * 0.78,
                 0.0, uHzRim, uHzRimGain * 0.84, sunAz,
                 0.0080, 0.0050, 2.0, vec2( 0.42, 0.56 ),
                 top );
  col = skHzOver( col, L, haze, top, s, aa2, 0.52 );

  /* 3 — nearest: darkest, least haze. This is the value the eye reads as "land",
     and it still has to sit ABOVE the fully-fogged terrain in front of it —
     see HAZE_SUN / HAZE_OPP in bandState(). */
  float aa3 = px + uHzSoft * 0.28;
  L = skHzLayer( az, s, aa3, 0.4650, 0.0280, 0.055, 29.0, 27.41, 1.58,
                 uHzRock2, haze, clamp( uHzFog * 0.46, 0.0, 1.0 ), 0.24, uHzMist * 0.58,
                 0.0, uHzRim, uHzRimGain * 1.05, sunAz,
                 0.0080, 0.0052, 3.0, vec2( 0.16, 0.32 ),
                 top );
  col = skHzOver( col, L, haze, top, s, aa3, 0.30 );

  return col;
}
`;

export const ATMOS_SEED = 20873;
