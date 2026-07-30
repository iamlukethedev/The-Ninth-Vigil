import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

import { hash2 } from '../core/Rand.js';
import { CameraRig } from '../game/CameraRig.js';
import { GBuffer } from './passes/GBuffer.js';
import { AOApplyPass } from './passes/AOApplyPass.js';
import { ReflectionPass } from './passes/ReflectionPass.js';
import { AutoExposurePass, ExposureApplyPass } from './passes/ExposurePass.js';
import { VolumetricPass } from './passes/VolumetricPass.js';
import { DOFPass } from './passes/DOFPass.js';
import { MotionBlurPass } from './passes/MotionBlurPass.js';
import { GradePass, LOOKS, SLATE } from './passes/GradePass.js';
import { GrainPass } from './passes/GrainPass.js';
import { CAVignettePass } from './passes/CAVignettePass.js';
import { CompositePass } from './passes/CompositePass.js';

/* ------------------------------------------------------------------ *
 *  Quality tiers. Scales are expressed against the *logical* frame so
 *  a 2x device pixel ratio does not quadruple the cost of the screen
 *  space stages.
 * ------------------------------------------------------------------ */
const TIERS = {
  low: {
    gbuffer: false, ao: false, ssr: false, vol: false, dof: false, mb: false,
    merged: true, aa: 'fxaa', gbScale: 0.5, aoScale: 0.5, ssrScale: 0.5, volScale: 0.5,
    aoSamples: 8, pdSamples: 8, ssrSteps: 10, volSamples: 16, mbTaps: 5, bloomScale: 0.5,
  },
  med: {
    gbuffer: true, ao: true, ssr: false, vol: true, dof: false, mb: false,
    merged: true, aa: 'smaa', gbScale: 0.55, aoScale: 0.45, ssrScale: 0.45, volScale: 0.45,
    aoSamples: 8, pdSamples: 8, ssrSteps: 12, volSamples: 20, mbTaps: 5, bloomScale: 0.6,
    contactTaps: 8,
  },
  high: {
    gbuffer: true, ao: true, ssr: true, vol: true, dof: true, mb: true,
    merged: false, aa: 'smaa', gbScale: 1.0, aoScale: 0.5, ssrScale: 0.5, volScale: 0.5,
    aoSamples: 12, pdSamples: 12, ssrSteps: 16, volSamples: 24, mbTaps: 6, bloomScale: 0.75,
    contactTaps: 12,
  },
  ultra: {
    gbuffer: true, ao: true, ssr: true, vol: true, dof: true, mb: true,
    merged: false, aa: 'smaa', gbScale: 1.0, aoScale: 0.5, ssrScale: 0.5, volScale: 0.5,
    aoSamples: 16, pdSamples: 16, ssrSteps: 20, volSamples: 28, mbTaps: 7, bloomScale: 1.0,
    contactTaps: 16,
  },
};

/* ------------------------------------------------------------------ *
 *  DOF profiles.
 *
 *  `far` / `near` = [ startMul, endMul, strength ] as multiples of the focal
 *  distance; `px` = the circle-of-confusion radius in pixels at strength 1.
 *
 *  Every GAMEPLAY framing gets near = 0 and a far lobe that only opens past
 *  1.8x the focal distance at a ~1 px radius: a whisper of aerial softening on
 *  the deep background and nothing else. This is a 28 m isometric camera, not a
 *  macro lens — the previous symmetric bokeh was halving the measured sharpness
 *  of every frame. Real depth of field is reserved for `closeup`, and
 *  `inventory` blurs the background only (the UI panels sit in front of it).
 * ------------------------------------------------------------------ */
const DOF_PROFILES = {
  gameplay: { px: 2.2, far: [1.80, 4.60, 0.55], near: null },
  wide: { px: 2.4, far: [1.65, 4.20, 0.60], near: null },
  interior: { px: 1.9, far: [1.90, 4.80, 0.50], near: null },
  inventory: { px: 5.0, far: [1.25, 3.00, 0.90], near: null },
  // Even a portrait framing has a budget: at 16 px anything the rig happens to
  // put between the lens and the subject stops being a shape and becomes a
  // formless smear across half the frame. 10 px still separates the subject
  // from the crypt behind him and keeps near geometry legible.
  closeup: { px: 6.0, far: [1.10, 2.30, 0.90], near: [0.16, 0.60, 0.70] },
};

/**
 * Per-scenario art direction. Everything here is a knob the critic can move.
 *
 * `white` / `black` / `shoulder` / `contrast` / `sat` / `lift` / `knee` / `soft`
 * override the look's post curve for one framing. A scenario only carries an
 * override when its framing genuinely differs from the look's average frame —
 * a 6.5 m portrait and a 24 m room share the `crypt` look but not the same
 * histogram.
 *
 * `key` is the auto-exposure target and `gain` its ceiling.
 *
 * WHY THE CEILING IS PER-SCENARIO. A torchlit room is lit by a handful of
 * practicals against near-black stone, so its log-average luminance sits far
 * below any sane key and the metered gain pins at the ceiling — the ceiling,
 * not the key, is what actually sets the exposure of every interior. The moor
 * at midday meters inside the band and is driven by `key` instead (raising the
 * ceiling there changes nothing at all, which is how you tell the two apart).
 *
 * So the ceiling is authored per framing, and it is authored DOWN wherever a
 * scenario has a large bright element: pushing a dark plate up 2.5x is what
 * turned the crypt's torch pools into flat white plateaus and the hell arena
 * into a milky sepia field. Value comes from the grade's shadow reconstruction,
 * which only touches the bottom of the curve; exposure only has to stop the
 * highlights from clipping.
 */
const SCENARIOS = {
  hub: { look: 'town', bloom: 0.085, vol: 0.85, wet: 0.42, dof: 'gameplay', grain: 0.030, vignette: 0.34, ao: 0.90, ssr: 0.55, skyRays: 0.9, key: 0.150, gain: 2.70, black: 0.030 },
  overworld: { look: 'moor', bloom: 0.075, vol: 1.35, wet: 0.55, dof: 'wide', grain: 0.032, vignette: 0.46, ao: 0.85, ssr: 0.5, skyRays: 1.0, key: 0.110, gain: 2.60 },
  dungeon: { look: 'crypt', bloom: 0.105, vol: 1.15, wet: 0.85, dof: 'interior', grain: 0.036, vignette: 0.42, ao: 1.0, ssr: 0.7, skyRays: 0.25, key: 0.168, gain: 2.35, lift: 2.6 },
  combat: { look: 'crypt', bloom: 0.115, vol: 1.05, wet: 0.78, dof: 'interior', grain: 0.034, vignette: 0.39, ao: 1.0, ssr: 0.65, skyRays: 0.25, key: 0.172, gain: 2.80, lift: 3.0, black: 0.008 },
  boss: { look: 'hell', bloom: 0.100, vol: 0.34, wet: 0.34, dof: 'gameplay', grain: 0.034, vignette: 0.44, ao: 0.95, ssr: 0.34, skyRays: 0.3, key: 0.138, gain: 3.70 },
  night: { look: 'night', bloom: 0.095, vol: 0.85, wet: 0.98, dof: 'gameplay', grain: 0.042, vignette: 0.46, ao: 0.9, ssr: 0.85, skyRays: 0.8, key: 0.115, gain: 2.50 },
  // A 6.5 m portrait fills the frame with floor 2 m from the lens, so the
  // practicals put far more irradiance on screen than the room framing does:
  // metered at the room's ceiling the lower-left flagstones clipped to
  // near-white and the whole frame read milky. Lower ceiling than the room, and
  // a white point under the look's so the armour's speculars still reach 1.
  closeup: { look: 'crypt', bloom: 0.075, vol: 0.70, wet: 0.55, dof: 'closeup', grain: 0.030, vignette: 0.32, ao: 1.0, ssr: 0.5, skyRays: 0.25, key: 0.162, gain: 2.30, white: 0.80 },
  // The inventory frame is ~85 % un-graded HUD, so the curve here is authored
  // for the SLIVER OF WORLD visible between the panels and nothing else: at the
  // town look's own ceiling that world sat at 2 % grey and read as a black hole
  // behind the UI. A low white point and a high gain give it dim readable
  // cobbles and a brazier glow — depth behind the panels instead of a void.
  inventory: { look: 'town', bloom: 0.080, vol: 0.70, wet: 0.42, dof: 'inventory', grain: 0.028, vignette: 0.35, ao: 0.9, ssr: 0.45, skyRays: 0.9, key: 0.140, gain: 4.60, white: 0.40, black: 0.045 },
};

const BIOME_LOOK = { town: 'town', moor: 'moor', crypt: 'crypt', hell: 'hell' };

/* ------------------------------------------------------------------ *
 *  EXPOSURE BUDGET — the integration contract between this pipeline and
 *  everything that writes emissive into the HDR buffer.
 *
 *  THE BUG THIS FIXES. Exposure is applied BEFORE bloom (deliberately — the
 *  threshold has to mean something), so `bloomThreshold` is expressed in
 *  POST-exposure units while every VFX author writes PRE-exposure scene-linear
 *  values. Three separate modules independently hardcoded the same reading of
 *  this pipeline and budgeted their ceilings against it:
 *
 *    src/vfx/decals/Telegraph.js  "gain up to 1.85x ... CEIL = 0.70
 *                                  (0.70 x 1.85 = 1.30 < 1.55)"
 *    src/combat/HitFeel.js        same comment, same CEIL, same arithmetic
 *    src/vfx/emitters/Types.js    "up to ~1.7x"
 *
 *  Then the per-scenario grade pass authored `gain` ceilings of 2.30-4.60 in
 *  SCENARIOS above. Measured effective gains, mix(1, ceiling, autoExposure):
 *
 *    overworld 1.78  closeup 1.83  dungeon 1.86  night 1.96
 *    hub 2.09  combat 2.15  boss 2.73  inventory 3.30
 *
 *  So a 0.70 "can never bloom" pixel actually lands at 1.91 in `boss` and 2.31
 *  in `inventory` — over the 1.55 threshold — and at 1.51 in `combat`, i.e.
 *  0.04 under it. That is why the boss arena's ground reads clipped to a white
 *  plateau while the same shapes behaved in the crypt. Nobody was wrong; the
 *  reference number just stopped being true and nothing asserted it.
 *
 *  THE FIX. Express the bloom knobs in SCENE-LINEAR units and scale them by the
 *  live gain, so "does a pixel at linear V bloom?" has one answer in every
 *  scenario — the answer the VFX authors budgeted against. The pipeline also
 *  publishes `engine.vfxExposureNorm` (= REF / gain) so a module that wants its
 *  authored absolute level back can multiply by it instead of guessing.
 * ------------------------------------------------------------------ */
/** The gain every emissive author budgeted against. Do not change casually. */
const VFX_REF_GAIN = 1.85;
/** Scene-linear value at which bloom starts. 1.55 / 1.85 — the authored intent. */
const BLOOM_SCENE_FLOOR = 1.55 / VFX_REF_GAIN;
/** Scene-linear ceiling on what the high-pass may read. 2.00 / 1.85. */
const BLOOM_SCENE_CLAMP = 2.00 / VFX_REF_GAIN;

/* ------------------------------------------------------------------ *
 *  UI LAYER — the post-chain exemption (round-1 blocker #9)
 *
 *  Blocker #9 was "post-processing is applied indiscriminately over the UI
 *  layer. Chromatic aberration and film grain are shredding tooltip and damage
 *  number text into magenta/green speckle." The tooltips and damage numbers are
 *  DOM and were never in the chain, but the GROUND LOOT LABELS were: they were
 *  THREE.Sprites parented into the scene, so bloom, DOF, grain and a per-channel
 *  lens shift all ran across 9 px lettering. Type that goes through a lens model
 *  is type you cannot read, and no amount of tuning the lens fixes it — the
 *  ordering is wrong.
 *
 *  So the pipeline now reserves a camera layer that the post chain cannot see.
 *  Objects on `engine.uiLayer` are excluded from the scene RenderPass and from
 *  the shared G-buffer prepass, then drawn straight onto the resolved frame
 *  afterwards, at native resolution, ungraded and unfiltered. Interface may be
 *  anchored in the world; it may never be *filmed*.
 *
 *  Cost when nothing claims the layer: zero. `_scanLights` already walks the
 *  scene every 30 frames, so it counts layer users in the same pass and the
 *  extra draw is skipped entirely while the count is 0 (the normal case — the
 *  HUD does all of its world-anchored drawing in DOM, which is strictly better
 *  because it is vector type composited by the browser).
 * ------------------------------------------------------------------ */
/** Reserved camera layer. 30 and 31 are conventionally left free by content. */
export const UI_LAYER = 30;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * THE NINTH VIGIL post-processing pipeline.
 *
 * Owns the whole frame: one shared G-buffer prepass feeds GTAO, screen-space
 * reflections, volumetric shafts, DOF and motion blur, then the HDR buffer runs
 * through auto-exposure, bloom, ACES, a baked film LUT, grain and lens finish
 * before an SMAA resolve.
 *
 *   scene -> RenderPass -> auto-exposure metering -> GTAO (half res, bilateral
 *   upsample) -> SSR (half res, thin-shell reject) -> exposure -> UnrealBloom
 *   -> volumetric shafts -> DOF -> camera motion blur -> ACES + sRGB
 *   (OutputPass) -> 32^3 LUT grade -> film grain -> CA + vignette -> SMAA
 *
 * Everything is deterministic: no wall clock, no Math.random, dithering is
 * spatial-only and grain is driven by a frame counter this module owns.
 */
export class RenderPipeline {
  static id = 'render';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;
    this.scene = engine.scene;
    this.camera = engine.camera;

    // --- integration shim -------------------------------------------------
    // `modules.js` looks CameraRig up as '../game/CameraRig.js', but Vite's
    // import.meta.glob keys files that sit next to the importer as
    // './CameraRig.js' — so every src/game module silently misses the manifest
    // and the rig never registers. We are the last manifest entry, and modules
    // are constructed before they are pushed onto the ordered list, so adding
    // the rig here reproduces exactly the manifest's camera-then-render order.
    try {
      if (typeof engine.get === 'function' && !engine.get('camera')) engine.add(CameraRig);
    } catch (e) {
      console.warn('[render] camera rig registration failed —', e);
    }

    // Engine.renderFrame() drives us from here on.
    engine.renderPipeline = this;

    this.__dead = false;
    this.tier = TIERS[engine.quality?.tier] ? engine.quality.tier : 'ultra';
    this.scenario = 'combat';

    this.composer = null;
    this.gbuffer = null;
    this.passes = {};
    this._lutCache = new Map();
    this._lights = [];
    this._frame = 0;
    this._lightScanAt = -999;
    this._activeLight = null;
    this._lightUV = new THREE.Vector2(0.5, 0.65);
    this._lightUVTarget = new THREE.Vector2(0.5, 0.65);
    this._lightColor = new THREE.Color(1, 0.78, 0.5);
    this._lightColorTarget = new THREE.Color(1, 0.78, 0.5);
    this._lightWeight = 0;
    this._lightWeightTarget = 0;
    this._focus = 20;
    this._overlayFailed = false;
    /**
     * Camera layer that the post chain is not allowed to see. Published on the
     * engine so any module can opt an object out of the grade with
     * `obj.layers.set(engine.uiLayer)`. See the UI LAYER note above.
     */
    this.uiLayer = UI_LAYER;
    engine.uiLayer = UI_LAYER;
    this._uiLayerUsers = 0;
    this._uiTest = new THREE.Layers();
    this._uiTest.set(UI_LAYER);
    this._uiFailed = false;
    this._compileShimmed = false;
    this._origCompile = null;
    /** Frame at which the deferred (post-settle) prewarm runs. -1 = done. */
    this._prewarmAt = -1;

    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    /** Live tuning knobs — safe to poke from the critic loop at any time. */
    this.params = {
      // ambient occlusion
      aoEnabled: true,
      aoRadius: 0.55,
      aoDistanceExponent: 1.7,
      aoThickness: 0.55,
      aoDistanceFallOff: 1.0,
      aoCurve: 1.0,
      aoIntensity: 0.84,
      aoPower: 1.0,
      aoFloor: 0.17,
      /*
       * Bottom stop on the COMBINED occlusion multiplier. `aoFloor` and
       * `contactFloor` only bound their own term, so their product let occlusion
       * remove 99 % of the light and crush lit floor to black. Occlusion darkens;
       * it does not delete. See AOApplyPass for the measurement.
       */
      aoFloorTotal: 0.28,
      aoFloorKnee: 0.18,
      aoLumaProtect: 1.0,
      aoColor: [0.055, 0.062, 0.085],
      aoDenoiseRadius: 5.0,

      /*
       * CONTACT OCCLUSION — the grounding term. See the header of
       * passes/AOApplyPass.js for why the GTAO buffer above cannot supply this.
       * `contactRadius` is metres; the pixel clamp is what makes one number
       * work for a 3 m portrait and a 28 m isometric camera.
       */
      /*
       * The estimator returns the FRACTION of 16 taps that are blocked, so a
       * gain of 2.5 saturated it at 0.45 — a boot crease and half an open floor
       * tile both resolved to "fully occluded". A third of the play area sat
       * pinned in one narrow band, and because the term is also modulated by the
       * lit frame's luma, every torch flicker and passing enemy moved that whole
       * band at once. Walking the crypt with the pack engaged, the play area
       * peaked at 43 % near-black and the frame mean moved 0.075 between
       * consecutive frames (p95). At 1.2 the term keeps headroom to the top of
       * its range, the tail goes thin and smooth, and those read 4.3 % and 0.024.
       */
      contactIntensity: 1.2,
      contactRadius: 0.22,
      contactPower: 2.1,
      contactBias: 0.08,
      contactSlope: 0.34,
      contactRangeMul: 2.6,
      /*
       * Spread of the contact spiral's 2x2 INTERLEAVED start angle, in mean
       * azimuthal gaps. 1 = the four screen-parity classes tile one gap, so a
       * 2x2 tile samples 4 x contactTaps directions and the pass's tent resolve
       * reads that whole set back. This used to be a per-pixel `ign()` rotation
       * at 0.5, which is what stamped an ordered halftone screen across every
       * shadow in the game — see the header of passes/AOApplyPass.js.
       */
      contactJitter: 1.0,
      /** 1 = resolve the contact estimate over the tile, 0 = raw (diagnostic). */
      contactDenoise: 1.0,
      /** Resolve depth tolerance, as a fraction of the receiver's distance. */
      contactResolveTol: 0.02,
      contactKnee: 0.12,
      contactFloor: 0.06,
      contactProtect: 0.55,
      contactMinPx: 2.0,
      contactMaxPx: 72.0,
      contactFar: 90.0,
      /** 0 = off, 1 = total AO, 2 = contact only, 3 = broad only, 4 = normals. */
      aoDebug: 0,

      // screen space reflections
      ssrEnabled: true,
      ssrIntensity: 0.62,
      ssrWetness: 0.75,
      ssrThickness: 0.5,
      ssrMaxDistance: 24.0,
      ssrPuddleScale: 0.115,
      ssrGloss: 0.55,
      // Reflectance floor for damp stone. Physically a water film reflects ~3%
      // at this camera pitch; a hair of artistic licence is what makes the wet
      // floor read at all from an isometric angle.
      ssrFresnelBase: 0.30,

      // Exposure. Defaults only — every scenario authors `key` and `gain` (see
      // SCENARIOS). Torchlit interiors meter far below any sane key, so the gain
      // pins at the ceiling and the CEILING is the exposure. It is deliberately
      // modest: multiplying a dark plate is what turns a torch pool into a flat
      // white plateau, and the frame's *value* is bought at the bottom of the
      // curve by the grade's shadow reconstruction, which costs no highlights.
      // Effective gain is mix(1, ceiling, autoExposure), so 2.10 -> 1.70x.
      autoExposure: 0.64,
      exposureKey: 0.150,
      exposureMinGain: 0.55,
      exposureMaxGain: 2.10,
      exposureUpRate: 1.5,
      exposureDownRate: 0.85,

      // Bloom. A point light is not a lens: the *air* around a torch must not
      // turn into a glowing ball. Threshold sits above the exposed white point
      // so only genuine emissives (flame cores, lava, runes) contribute, and the
      // radius is deliberately tight — UnrealBloomPass at radius 0.85 spreads
      // its 5-mip chain across a quarter of the frame and every practical read
      // as a soft lens-bokeh disc.
      //
      // Measured at radius 0.34 / clamp 6.0: a torch core still resolved as a
      // ~90 px white disc, because the clamp let each hot pixel push 6 units of
      // energy through a five-mip chain. A flame is a *small intense core with a
      // tight falloff*; the core's brightness comes from the tonemap, not from
      // the blur. Clamp 2.0 with radius 0.18 keeps the halo inside the fixture.
      bloomEnabled: true,
      bloomStrength: 0.105,
      bloomRadius: 0.18,
      bloomThreshold: 1.55,
      // Ceiling on what the high-pass may read. See _clampBloomInput.
      bloomClamp: 2.0,

      // volumetric shafts
      volEnabled: true,
      volDensity: 0.78,
      volWeight: 1.1,
      volDecay: 0.968,
      volThreshold: 1.05,
      volSkyWeight: 0.8,
      volSourceGain: 0.55,
      // Point emitters only scatter within this screen radius of the chosen
      // source; see the comment in VolumetricPass. Wider than ~0.2 and every
      // practical on screen grows its own streak.
      volSourceRadius: 0.13,
      volFalloff: 2.0,
      volNearGate: 0.45,
      /*
       * Ceiling on the inscatter this pass may add to a pixel.
       *
       * Measured: at 0.65 the godray march lifted the boss arena's mean from
       * 0.057 to 0.283 and left 0.1 % of the frame at true black — a uniform pink
       * wash over the whole image, i.e. the "milky lifted blacks" instant fail.
       * It did the same, more subtly, to every open-sky scenario (night measured
       * sd 0.114). Inscatter is a *veil*: it belongs in the 0.05-0.20 range so the
       * shafts read as air and the shadows stay black.
       */
      volMaxAdd: 0.22,
      // How much a march step through opaque geometry costs the shaft. See the
      // occlusion note in VolumetricPass — this is what stops the rays at a wall.
      volOcclude: 0.9,

      // depth of field — see DOF_PROFILES. `dofStrength` is a plain artistic
      // multiplier on the profile (1 = as authored); the bands and the pixel
      // radius are what actually decide how the frame reads.
      dofEnabled: true,
      dofProfile: 'gameplay',
      dofStrength: 1.0,
      dofMaxRadius: DOF_PROFILES.gameplay.px,
      dofFarStart: DOF_PROFILES.gameplay.far[0],
      dofFarEnd: DOF_PROFILES.gameplay.far[1],
      dofFarStrength: DOF_PROFILES.gameplay.far[2],
      dofNearStart: 0.10,
      dofNearEnd: 0.45,
      dofNearStrength: 0.0,
      dofFocusLag: 0.16,

      // motion blur
      motionBlurEnabled: true,
      motionBlur: 0.55,
      motionBlurMax: 0.010,

      // grade
      grade: 'crypt',
      gradeStrength: 1.0,
      blackPoint: 0.010,
      whitePoint: 0.80,
      // Fraction of the sub-pedestal signal that survives instead of clipping
      // to zero. This is what buys back shadow *detail* — see GLSL_GRADE.
      blackSoft: 0.34,
      /*
       * Half-width of the pedestal's C1 knee, as a fraction of the pedestal.
       *
       * The pedestal is `soft*x + (1-soft)*max(x - blackPoint, 0)`, so its slope
       * steps from `soft` to 1 at exactly one value: measured on `boss`, from
       * 0.39 to 1.63 at input 0.085. A step in the transfer curve's *slope* is a
       * contour line in the image wherever a surface's shading crosses it, which
       * is what drew the hard outline around the welded black shape. At 0.45 the
       * splice spans input 0.047-0.123 there and the curve is bit-identical to
       * the old one outside it. 0 restores the hard clip.
       */
      blackKnee: 0.45,
      gradeContrast: 1.15,
      gradePivot: 0.42,
      /*
       * Knee of the contrast toe, in pivot-normalised units — below it the
       * contrast exponent relaxes to 1 so the bottom decade keeps unity slope.
       * 0.10 of a 0.42 pivot is 0.042 display-referred (11/255), i.e. deep
       * shadow only; the low mids up are untouched. See GLSL_GRADE for why an
       * exponent over 1 at the bottom of the curve is what welds two dark
       * surfaces into one shape. 0 restores the plain power law.
       */
      contrastToe: 0.10,
      // Shadow reconstruction: multiplicative lift inside an exp() window,
      // preceded by a pull toward luma-neutral cold grey so the lift raises
      // value without raising chroma.
      shadowLift: 1.9,
      shadowKnee: 0.055,
      shadowChroma: 0.72,
      slate: SLATE.slice(),
      /*
       * Film toe. Below `toeKnee` (display-referred, post-crush) the luma is
       * raised by a gamma of `toeGamma`, faded to a no-op at the knee. This is
       * the one stage that exists to keep code values ALIVE at the bottom: a
       * gain cannot do it, because the lift above is multiplicative and so
       * preserves the bottom's exponent, and an exponent over 1 sends the
       * separation between two near-black surfaces to zero regardless of gain.
       * Authored per look (see LOOKS.post in passes/GradePass.js); 1.0 = off.
       */
      toeKnee: 0.09,
      toeGamma: 0.85,
      saturation: 0.56,
      highlightDesat: 0.40,
      tintAmount: 0.28,
      // Knee of the filmic highlight shoulder — see GLSL_GRADE. Below 1.0 the
      // white point stops hard-clipping and a flame gets a real falloff.
      gradeShoulder: 0.72,
      shadowTint: [0.88, 0.955, 1.13],
      highlightTint: [1.09, 1.0, 0.90],

      /*
       * GRAIN. The monochrome term is the film; the chroma term is a seasoning.
       *
       * `grainChroma` was 0.28, and that single number was peppering cyan and
       * magenta single pixels along every black mortar joint and every silhouette
       * edge in all eight scenarios. A mid-tone joint edge is not a shadow, so
       * the luma knee in GrainPass could not touch it. Two changes:
       *   - 0.28 -> 0.04, so the coloured fraction is a trace rather than a look;
       *   - the chroma term is additionally gated on a 3x3 luma GRADIENT, so it
       *     is essentially gone on high-contrast structure and fully present on
       *     flat surfaces. See GRAIN_CHROMA_EDGE_* in passes/GrainPass.js.
       * `grainShadowBias` goes 1.2 -> 1.3 so the *monochrome* grain gets slightly
       * heavier in the shadows, which is where film grain belongs, and keeps the
       * perceived grain strength after the chroma cut (per-channel noise sd only
       * falls ~7 % between chroma 0.28 and 0.04, so this more than covers it).
       *
       * Measuring it, however, exonerated the grain: at these amplitudes the
       * coloured term is worth about ±0.6/255 of channel imbalance, and forcing it
       * to zero moved the isolated-chroma pixel count on `combat` by 0.005 pp. The
       * cyan/magenta specks along the joints are the frame's OWN one-pixel colour
       * aliasing. So GrainPass also runs a luma-preserving chroma despeckle, which
       * is what actually removes them — see DESPECKLE in passes/GrainPass.js. The
       * knobs live here so a tuning pass can reach them; 0 disables.
       */
      grain: 0.034,
      grainSize: 1.35,
      grainChroma: 0.04,
      grainShadowBias: 1.3,
      grainMotion: 1.0,
      grainChromaShadowFloor: 0.12,
      grainChromaEdgeFloor: 0.05,
      grainChromaEdge0: 0.045,
      grainChromaEdge1: 0.18,
      chromaDespeckle: 1.0,
      chromaDespeckleFlat: 0.040,
      chromaDespeckleEdge: 0.009,
      chromaDespeckleColorK: 0.6,

      // lens
      // See the note in applyScenario: at 0.00065 this pass was manufacturing
      // fully-saturated rainbow pixels out of the frame's own aliasing.
      chromatic: 0.00016,
      barrel: 0.0010,
      vignette: 0.36,
      vignetteInner: 0.58,
      vignetteOuter: 1.35,
      vignettePower: 1.15,
      vignetteRound: 0.55,

      // resolve
      aaEnabled: true,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async init() {
    try {
      this._build();
      this.applyLook(this.params.grade);
      this._syncExposureBudget();
      this._syncPasses();
      this.resize(this.engine.width || 1, this.engine.height || 1);
      this._shimCompile();
    } catch (e) {
      console.error('[render] pipeline disabled —', e);
      this.__dead = true;
      this._teardown();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  shader warm-up                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Make `renderer.compile()` warm the programs the frame will ACTUALLY use.
   *
   * THE BUG. `WebGLPrograms.getParameters()` folds the *current render target's*
   * colour space into the program cache key:
   *
   *   outputColorSpace: currentRenderTarget === null ? renderer.outputColorSpace
   *                                                 : LinearSRGBColorSpace
   *
   * Every scene render in this project goes through the composer, i.e. into a
   * half-float render target, so every program the frame uses is keyed
   * `srgb-linear`. A bare `renderer.compile(scene, camera)` runs with NO target
   * bound and therefore links a complete parallel set of `srgb` programs that no
   * frame will ever bind — and three caches program variants per material for the
   * material's lifetime (`materialProperties.programs`), so they are never
   * reclaimed. Measured on `combat`: 121 wasted programs out of 308, and a
   * warm-up that warmed nothing, so the first composed frame still linked
   * everything from scratch.
   *
   * THE FIX. Bind a composer buffer for the duration of the compile. Warm-up is
   * this module's job (it owns the frame graph and therefore knows what the
   * colour-space key will be), so the shim lives here rather than asking every
   * caller to know about render targets. The original method is preserved and
   * delegated to — no renderer *settings* are touched.
   */
  _shimCompile() {
    if (this._compileShimmed) return;
    const renderer = this.renderer;
    if (typeof renderer.compile !== 'function') return;
    const orig = renderer.compile.bind(renderer);
    this._origCompile = orig;
    const self = this;
    renderer.compile = function nonaCompile(scene, camera, targetScene) {
      const prev = renderer.getRenderTarget();
      const buf = self.composer?.renderTarget1 ?? null;
      try {
        if (buf) renderer.setRenderTarget(buf);
        return orig(scene, camera, targetScene);
      } finally {
        try { renderer.setRenderTarget(prev); } catch { /* ignore */ }
      }
    };
    this._compileShimmed = true;
  }

  _unshimCompile() {
    if (!this._compileShimmed) return;
    try { this.renderer.compile = this._origCompile; } catch { /* ignore */ }
    this._compileShimmed = false;
    this._origCompile = null;
  }

  /**
   * Link every program a frame of this scenario needs, before the frame loop
   * starts. Called from `applyScenario`, so all of it lands on the loading
   * screen instead of showing up as a 60 ms hitch three seconds in.
   *
   * Two steps, because `compile()` alone is not enough:
   *  1. `compile()` — every visible material's beauty program, in the composer's
   *     colour space (see `_shimCompile`).
   *  2. one throwaway `renderer.render()` into a composer buffer — which is the
   *     only way to link the shadow *depth* and *distance* programs (three
   *     derives those inside `WebGLShadowMap.render`, and `compile()` never
   *     touches them). On `combat` that is ~40 additional programs.
   *
   * Deterministic: it draws into a buffer the composer clears on its own first
   * pass and touches no module state, no counters and no history buffers.
   */
  /**
   * Let every module that DECORATES materials finish before anything links.
   *
   * `Sky.applyFog` and `Lighting.registerMaterial` both replace
   * `material.onBeforeCompile`, and both compose a `customProgramCacheKey` that
   * falls through to `Material.prototype.customProgramCacheKey` — which returns
   * `this.onBeforeCompile.toString()`. So the cache key contains the live hook's
   * SOURCE, and a material that is compiled with only the fog hook installed and
   * then adopted by Lighting's 16-frame rescan produces a second, permanently
   * cached program with identical output. Measured on `combat`: 41 of 131
   * programs were these ghosts, one per prop/dungeon/character material.
   *
   * Both decorators are idempotent (they keep a seen-set), so driving their scans
   * to completion here means the hook — and therefore the cache key — is final
   * before the first link, and neither periodic rescan can ever dirty a material
   * again.
   */
  _settleMaterialHooks() {
    const engine = this.engine;
    try {
      const sky = engine.get('sky');
      if (sky && !sky.__dead) sky.applyFogToScene?.();
    } catch (e) { console.warn('[render] fog settle skipped —', e?.message ?? e); }
    try {
      // Lighting composes on top of whatever hook it finds, so it must go last.
      engine.bus?.emit?.('lighting:rescan', {});
    } catch (e) { console.warn('[render] lighting settle skipped —', e?.message ?? e); }
  }

  prewarm() {
    if (this.__dead || !this.composer) return false;
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    const buf = this.composer.renderTarget1 ?? null;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const before = renderer.info.programs?.length ?? 0;
    try {
      this._settleMaterialHooks();
      camera.updateMatrixWorld();
      renderer.compile(scene, camera);
      if (buf) {
        renderer.setRenderTarget(buf);
        renderer.autoClear = true;
        renderer.render(scene, camera);
      }
    } catch (e) {
      console.warn('[render] prewarm skipped —', e?.message ?? e);
      return false;
    } finally {
      renderer.autoClear = prevAutoClear;
      try { renderer.setRenderTarget(prevTarget); } catch { /* ignore */ }
    }
    const after = renderer.info.programs?.length ?? 0;
    const ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    console.info(
      `[render] prewarm '${this.scenario}' — ${after} programs (+${after - before}) in ${ms.toFixed(0)}ms`);
    return true;
  }

  _tier() {
    return TIERS[this.tier] ?? TIERS.ultra;
  }

  /**
   * Worst-case effective exposure multiplier applied to the HDR buffer before
   * bloom. `ExposureApplyPass` computes mix(1, clamp(metered), autoExposure);
   * a torchlit interior meters far below any sane key so the clamp pins at the
   * ceiling, which makes this the operative number for 7 of the 8 scenarios.
   * Deterministic and CPU-side, so emissive authors can trust it.
   */
  effectiveExposureGain() {
    const p = this.params;
    const ceiling = Math.max(1, p.exposureMaxGain || 1);
    return 1 + (ceiling - 1) * clamp(p.autoExposure ?? 0, 0, 1);
  }

  /**
   * Re-derive the bloom knobs from the live exposure gain and publish the
   * normalisation factor for emissive authors. See the EXPOSURE BUDGET note.
   */
  _syncExposureBudget() {
    const p = this.params;
    const g = this.effectiveExposureGain();
    p.bloomThreshold = BLOOM_SCENE_FLOOR * g;
    p.bloomClamp = BLOOM_SCENE_CLAMP * g;
    this.exposureGain = g;
    this.vfxExposureNorm = VFX_REF_GAIN / g;
    // Published on the engine rather than only on the bus: a module reading it
    // in update() cannot be caught out by module ordering or bus flush timing.
    this.engine.exposureGain = g;
    this.engine.vfxExposureNorm = this.vfxExposureNorm;
    try {
      this.engine.bus?.emit?.('exposure', { gain: g, norm: this.vfxExposureNorm, ref: VFX_REF_GAIN });
    } catch { /* the bus is optional to this */ }
    // Assert the invariant loudly, the way KNOWN_ISSUES asks. A silent drift
    // here is what turned a ground read into a white plateau.
    if (g > VFX_REF_GAIN * 2.2) {
      console.warn(
        `[render] exposure gain ${g.toFixed(2)}x is ${(g / VFX_REF_GAIN).toFixed(2)}x the VFX reference ` +
        `(${VFX_REF_GAIN}x) in scenario '${this.scenario}'. Emissive budgets are normalised, but a gain ` +
        `this far above the reference costs highlight headroom — prefer buying value in the grade.`
      );
    }
    return g;
  }

  /**
   * Clamp what bloom is allowed to see.
   *
   * A practical light sits ~0.2 m from its own fixture, so the brazier bowl
   * receives `I / r²` = thousands of units of irradiance and resolves to a
   * five-figure linear value. ACES rolls that off to white in about 20 units, so
   * the *image* is fine — but UnrealBloomPass runs before the tonemap on raw
   * linear values, and `value - threshold` for a five-figure pixel spreads a
   * ~110 px white disc through the mip chain. That is the "bloom reads as lens
   * bokeh, not light" failure in KNOWN_ISSUES, and no amount of lowering
   * `bloomStrength` fixes it without also killing bloom on lava and runes.
   *
   * So the high-pass gets a ceiling. Everything above `bloomClamp` still tonemaps
   * to the same white pixel; it just stops contributing unbounded energy to the
   * blur. This is the standard bloom pre-filter clamp.
   */
  _clampBloomInput(bloom) {
    const mat = bloom.materialHighPassFilter;
    if (!mat || !mat.fragmentShader || mat.fragmentShader.includes('nonaBloomClamp')) return;
    mat.uniforms.nonaBloomClamp = { value: this.params.bloomClamp };
    mat.fragmentShader = mat.fragmentShader
      .replace('void main()', 'uniform float nonaBloomClamp;\n\t\t\tvoid main()')
      .replace(
        'vec4 texel = texture2D( tDiffuse, vUv );',
        'vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\t\ttexel.rgb = min( texel.rgb, vec3( nonaBloomClamp ) );'
      );
    mat.needsUpdate = true;
    this._bloomClampU = mat.uniforms.nonaBloomClamp;
  }

  /** Screen-space stage size, expressed against logical (not device) pixels. */
  _scaled(px, scale) {
    const dpr = Math.max(1, this._dpr || this.renderer.getPixelRatio() || 1);
    return Math.max(8, Math.round((px * scale) / dpr));
  }

  _build() {
    const engine = this.engine;
    const renderer = this.renderer;
    const t = this._tier();
    const q = engine.quality ?? {};

    this._dpr = renderer.getPixelRatio() || 1;
    const w = Math.max(2, engine.width || renderer.domElement.width || 1280);
    const h = Math.max(2, engine.height || renderer.domElement.height || 720);
    const pw = Math.max(2, Math.round(w * this._dpr));
    const ph = Math.max(2, Math.round(h * this._dpr));
    this._pw = pw;
    this._ph = ph;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(this._dpr);
    composer.setSize(w, h);
    this.composer = composer;

    const P = this.passes;

    /* --- scene ---
       The UI layer is taken off the camera here, once, which is what keeps it
       out of RenderPass, the G-buffer prepass, GTAO, SSR and DOF in one move.
       Only this one bit is touched — another module may own the others. */
    this.camera.layers.disable(UI_LAYER);
    P.render = new RenderPass(this.scene, this.camera);
    composer.addPass(P.render);

    /* --- auto exposure metering (reads the raw HDR frame, swaps nothing) --- */
    P.autoExposure = new AutoExposurePass(this.params);
    composer.addPass(P.autoExposure);

    /* --- shared depth + view normal G-buffer --- */
    const wantGBuffer = t.gbuffer;
    if (wantGBuffer) {
      this.gbuffer = new GBuffer(
        this.scene,
        this.camera,
        this._scaled(pw, t.gbScale),
        this._scaled(ph, t.gbScale)
      );
    }

    /* --- GTAO at half res, applied through a depth-aware bilateral upsample --- */
    if (wantGBuffer && t.ao && q.ssao !== false) {
      const aw = this._scaled(pw, t.aoScale);
      const ah = this._scaled(ph, t.aoScale);
      const gtao = new GTAOPass(this.scene, this.camera, aw, ah);
      gtao.setGBuffer(this.gbuffer.depthTexture, this.gbuffer.normalTexture);
      // The internal normal target is dead weight once we feed our own G-buffer.
      gtao.normalRenderTarget.depthTexture?.dispose();
      gtao.normalRenderTarget.dispose();
      gtao.output = GTAOPass.OUTPUT.Off;
      gtao.needsSwap = false;
      gtao.updateGtaoMaterial({
        radius: this.params.aoRadius,
        distanceExponent: this.params.aoDistanceExponent,
        thickness: this.params.aoThickness,
        distanceFallOff: this.params.aoDistanceFallOff,
        scale: this.params.aoCurve,
        samples: t.aoSamples,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({
        lumaPhi: 10,
        depthPhi: 2,
        normalPhi: 3.5,
        radius: this.params.aoDenoiseRadius,
        rings: 2,
        samples: t.pdSamples,
      });
      this._makeDeterministicNoise(gtao);
      gtao.setSize = (sw, sh) => this._resizeGTAO(gtao, sw, sh);
      P.gtao = gtao;
      composer.addPass(gtao);

      P.aoApply = new AOApplyPass({
        aoTexture: gtao.gtaoMap,
        depthTexture: this.gbuffer.depthTexture,
        // Geometric view normals from the shared prepass. The contact term falls
        // back to depth derivatives without them, but the prepass is free here.
        normalTexture: this.gbuffer.normalTexture,
        camera: this.camera,
        params: this.params,
        taps: t.contactTaps,
      });
      P.aoApply.setAoResolution(aw, ah);
      composer.addPass(P.aoApply);
    }

    /* --- screen space reflections --- */
    if (wantGBuffer && t.ssr && q.ssr !== false) {
      const ssr = new ReflectionPass({
        camera: this.camera,
        depthTexture: this.gbuffer.depthTexture,
        normalTexture: this.gbuffer.normalTexture,
        params: this.params,
        steps: t.ssrSteps,
      });
      ssr.scale = t.ssrScale / Math.max(1, this._dpr);
      ssr.setGBuffer(this.gbuffer.depthTexture, this.gbuffer.normalTexture, this.gbuffer.width, this.gbuffer.height);
      P.ssr = ssr;
      composer.addPass(ssr);
    }

    /* --- exposure applied before bloom so the threshold means something --- */
    P.exposure = new ExposureApplyPass(P.autoExposure, this.params, renderer);
    composer.addPass(P.exposure);

    /* --- bloom: high threshold, modest strength, wide radius --- */
    const bloomScale = t.bloomScale / Math.max(1, this._dpr);
    const bloomRes = new THREE.Vector2(
      Math.max(8, Math.round(pw * bloomScale)),
      Math.max(8, Math.round(ph * bloomScale))
    );
    const bloom = new UnrealBloomPass(
      bloomRes,
      this.params.bloomStrength,
      this.params.bloomRadius,
      this.params.bloomThreshold
    );
    // UnrealBloomPass sizes its mip chain straight off setSize(), ignoring the
    // resolution handed to the constructor — scale it here instead.
    const bloomSetSize = UnrealBloomPass.prototype.setSize.bind(bloom);
    bloom.setSize = (sw, sh) =>
      bloomSetSize(Math.max(16, Math.round(sw * bloomScale)), Math.max(16, Math.round(sh * bloomScale)));
    this._clampBloomInput(bloom);
    P.bloom = bloom;
    composer.addPass(bloom);

    /* --- volumetric light shafts --- */
    if (wantGBuffer && t.vol && q.volumetric !== false) {
      const vol = new VolumetricPass({
        camera: this.camera,
        depthTexture: this.gbuffer.depthTexture,
        params: this.params,
        samples: t.volSamples,
      });
      vol.scale = t.volScale / Math.max(1, this._dpr);
      P.volumetric = vol;
      composer.addPass(vol);
    }

    /* --- depth of field --- */
    if (wantGBuffer && t.dof) {
      P.dof = new DOFPass(this.scene, this.camera, this.gbuffer.depthTexture, this.params);
      composer.addPass(P.dof);
    }

    /* --- camera velocity motion blur --- */
    if (wantGBuffer && t.mb) {
      P.motionBlur = new MotionBlurPass({
        camera: this.camera,
        depthTexture: this.gbuffer.depthTexture,
        params: this.params,
        taps: t.mbTaps,
      });
      composer.addPass(P.motionBlur);
    }

    /* --- ACES tone map + sRGB encode (reads the renderer's exposure hint) --- */
    P.output = new OutputPass();
    composer.addPass(P.output);

    /* --- display referred finish --- */
    if (t.merged) {
      P.composite = new CompositePass(this.params, this._lutCache);
      composer.addPass(P.composite);
    } else {
      P.grade = new GradePass(this.params, this._lutCache);
      composer.addPass(P.grade);
      P.grain = new GrainPass(this.params);
      composer.addPass(P.grain);
      P.lens = new CAVignettePass(this.params);
      composer.addPass(P.lens);
    }

    /* --- resolve --- */
    if (t.aa === 'smaa') P.aa = new SMAAPass();
    else if (t.aa === 'fxaa') P.aa = new FXAAPass();
    if (P.aa) composer.addPass(P.aa);

    this._syncPasses();
    this._scanLights();
  }

  _teardown() {
    if (this.composer) {
      for (const pass of this.composer.passes.slice()) {
        try { pass.dispose?.(); } catch (e) { /* keep tearing down */ }
      }
      this.composer.passes.length = 0;
      try { this.composer.dispose(); } catch (e) { /* ignore */ }
      this.composer = null;
    }
    if (this.gbuffer) {
      try { this.gbuffer.dispose(); } catch (e) { /* ignore */ }
      this.gbuffer = null;
    }
    this.passes = {};
  }

  dispose() {
    this._unshimCompile();
    this._teardown();
    for (const tex of this._lutCache.values()) {
      try { tex.dispose(); } catch (e) { /* ignore */ }
    }
    this._lutCache.clear();
    this._lights.length = 0;
    if (this.engine.renderPipeline === this) this.engine.renderPipeline = null;
  }

  /* ------------------------------------------------------------------ */
  /*  GTAO helpers                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * three's GTAOPass seeds its Poisson denoise rotation texture from
   * `SimplexNoise`, which is backed by Math.random — that would make every page
   * load a different frame. Replace it with a hash the engine can reproduce.
   */
  _makeDeterministicNoise(gtao, size = 64) {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        data[i] = (hash2(x, y, 17) * 255) | 0;
        data[i + 1] = (hash2(x + size, y, 17) * 255) | 0;
        data[i + 2] = (hash2(x, y + size, 17) * 255) | 0;
        data[i + 3] = (hash2(x + size, y + size, 17) * 255) | 0;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    tex.name = 'Nona.pdNoise';
    try { gtao.pdNoiseTexture.dispose(); } catch (e) { /* ignore */ }
    gtao.pdNoiseTexture = tex;
    gtao.pdMaterial.uniforms.tNoise.value = tex;
  }

  _resizeGTAO(gtao, width, height) {
    const t = this._tier();
    const aw = this._scaled(width, t.aoScale);
    const ah = this._scaled(height, t.aoScale);
    gtao.width = aw;
    gtao.height = ah;
    gtao.gtaoRenderTarget.setSize(aw, ah);
    gtao.pdRenderTarget.setSize(aw, ah);
    gtao.gtaoMaterial.uniforms.resolution.value.set(aw, ah);
    gtao.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
    gtao.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
    gtao.pdMaterial.uniforms.resolution.value.set(aw, ah);
    gtao.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
    this.passes.aoApply?.setAoResolution(aw, ah);
  }

  /* ------------------------------------------------------------------ */
  /*  sizing                                                             */
  /* ------------------------------------------------------------------ */

  resize(width, height) {
    if (!this.composer || this.__dead) return;
    const w = Math.max(2, width | 0);
    const h = Math.max(2, height | 0);
    this._dpr = this.renderer.getPixelRatio() || 1;
    this._pw = Math.max(2, Math.round(w * this._dpr));
    this._ph = Math.max(2, Math.round(h * this._dpr));

    this.composer.setPixelRatio(this._dpr);
    this.composer.setSize(w, h);

    if (this.gbuffer) {
      const t = this._tier();
      this.gbuffer.setSize(this._scaled(this._pw, t.gbScale), this._scaled(this._ph, t.gbScale));
      this.passes.ssr?.setGBuffer(
        this.gbuffer.depthTexture,
        this.gbuffer.normalTexture,
        this.gbuffer.width,
        this.gbuffer.height
      );
    }
    this.passes.autoExposure?.setSize(this._pw, this._ph);
  }

  /* ------------------------------------------------------------------ */
  /*  per-pass enable state                                              */
  /* ------------------------------------------------------------------ */

  _syncPasses() {
    const P = this.passes;
    const p = this.params;
    if (P.gtao) P.gtao.enabled = p.aoEnabled;
    if (P.aoApply) P.aoApply.enabled = p.aoEnabled;
    if (P.ssr) P.ssr.enabled = p.ssrEnabled && p.ssrIntensity > 0.001 && p.ssrWetness > 0.001;
    if (P.bloom) {
      P.bloom.enabled = p.bloomEnabled && p.bloomStrength > 0.0005;
      P.bloom.strength = p.bloomStrength;
      P.bloom.radius = p.bloomRadius;
      if (this._bloomClampU) this._bloomClampU.value = p.bloomClamp;
      P.bloom.threshold = p.bloomThreshold;
    }
    if (P.volumetric) P.volumetric.enabled = p.volEnabled && p.volWeight > 0.001;
    if (P.dof) {
      P.dof.enabled = p.dofEnabled && p.dofMaxRadius * p.dofStrength > 0.45 &&
        (p.dofFarStrength > 0.001 || p.dofNearStrength > 0.001);
    }
    if (P.motionBlur) P.motionBlur.enabled = p.motionBlurEnabled && p.motionBlur > 0.001;
    if (P.aa) P.aa.enabled = p.aaEnabled;
    if (P.gtao) {
      P.gtao.updateGtaoMaterial({
        radius: p.aoRadius,
        distanceExponent: p.aoDistanceExponent,
        thickness: p.aoThickness,
        distanceFallOff: p.aoDistanceFallOff,
        scale: p.aoCurve,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  public tuning API                                                  */
  /* ------------------------------------------------------------------ */

  /** @param {'low'|'med'|'high'|'ultra'} tier */
  setQuality(tier) {
    if (!TIERS[tier] || this.__dead) return false;
    if (tier === this.tier && this.composer) return true;
    this.tier = tier;
    try {
      this._teardown();
      this._build();
      this.applyLook(this.params.grade);
      this._syncExposureBudget();
      this._syncPasses();
      this.resize(this.engine.width || 1, this.engine.height || 1);
      this.passes.autoExposure?.reset();
      this.passes.motionBlur?.reset();
    } catch (e) {
      console.error('[render] setQuality failed —', e);
      this.__dead = true;
      this._teardown();
      return false;
    }
    return true;
  }

  /**
   * Merge a partial params object and re-sync every dependent pass.
   *
   * Moving `exposureMaxGain` / `autoExposure` re-derives the bloom knobs, since
   * those are expressed in scene-linear units (see EXPOSURE BUDGET). Setting
   * `bloomThreshold` or `bloomClamp` explicitly still wins for that call, so the
   * critic loop can still poke them directly.
   */
  setParams(partial = {}) {
    const pinnedBloom = partial.bloomThreshold !== undefined || partial.bloomClamp !== undefined;
    const exposureMoved = partial.exposureMaxGain !== undefined || partial.autoExposure !== undefined;
    Object.assign(this.params, partial);
    if (partial.grade) this.applyLook(partial.grade);
    if (partial.dofProfile !== undefined) this._applyDofProfile(partial.dofProfile);
    if (exposureMoved && !pinnedBloom) this._syncExposureBudget();
    this._syncPasses();
    return this.params;
  }

  /**
   * Install a named DOF profile. The profiles carry the near/far bands as
   * multiples of the focal distance plus a circle-of-confusion radius in
   * pixels, which is the only unit in which "imperceptible" is meaningful:
   * a 2 px CoC on a 1600 px frame is invisible, a 40 px CoC is a macro lens.
   * @param {keyof DOF_PROFILES} name
   */
  _applyDofProfile(name) {
    const p = this.params;
    const prof = DOF_PROFILES[name] ?? DOF_PROFILES.gameplay;
    p.dofProfile = DOF_PROFILES[name] ? name : 'gameplay';
    p.dofMaxRadius = prof.px;
    p.dofFarStart = prof.far[0];
    p.dofFarEnd = prof.far[1];
    p.dofFarStrength = prof.far[2];
    if (prof.near) {
      p.dofNearStart = prof.near[0];
      p.dofNearEnd = prof.near[1];
      p.dofNearStrength = prof.near[2];
    } else {
      p.dofNearStart = 0.10;
      p.dofNearEnd = 0.45;
      p.dofNearStrength = 0.0;
    }
    p.dofStrength = 1.0;
  }

  /** @param {'crypt'|'hell'|'moor'|'town'|'night'} name */
  applyLook(name) {
    const look = LOOKS[name] ? name : 'crypt';
    this.params.grade = look;
    const post = LOOKS[look].post;
    this.params.blackPoint = post.blackPoint;
    this.params.whitePoint = post.whitePoint;
    this.params.blackSoft = post.blackSoft ?? 0.34;
    this.params.gradeContrast = post.contrast;
    this.params.gradePivot = post.pivot;
    this.params.shadowLift = post.shadowLift ?? 1.9;
    this.params.shadowKnee = post.shadowKnee ?? 0.055;
    this.params.shadowChroma = post.shadowChroma ?? 0.72;
    this.params.slate = (post.slate ?? SLATE).slice();
    this.params.toeKnee = post.toeKnee ?? 0.09;
    this.params.toeGamma = post.toeGamma ?? 0.85;
    this.params.saturation = post.saturation;
    this.params.highlightDesat = post.highlightDesat;
    this.params.tintAmount = post.tintAmount;
    this.params.gradeShoulder = post.shoulder ?? 0.72;
    this.params.shadowTint = post.shadowTint.slice();
    this.params.highlightTint = post.highlightTint.slice();
    return look;
  }

  /**
   * Scenario hook (called directly by Scenarios.js before the bus event).
   * @param {string} name
   * @param {Object} cfg
   */
  applyScenario(name, cfg = {}) {
    if (this.__dead) return;
    try {
      this.scenario = name;
      const s = SCENARIOS[name] ?? SCENARIOS.combat;
      const env = cfg.env ?? {};
      const p = this.params;

      let look = BIOME_LOOK[env.biome] ?? s.look;
      if (name === 'night' || (env.interior !== true && typeof env.timeOfDay === 'number' && env.timeOfDay < 0.08)) {
        look = 'night';
      }
      this.applyLook(look);

      // Per-framing curve overrides. The look sets the palette; these set where
      // this particular camera's histogram sits inside it.
      if (s.white !== undefined) p.whitePoint = s.white;
      if (s.black !== undefined) p.blackPoint = s.black;
      if (s.shoulder !== undefined) p.gradeShoulder = s.shoulder;
      if (s.contrast !== undefined) p.gradeContrast = s.contrast;
      if (s.sat !== undefined) p.saturation = s.sat;
      if (s.lift !== undefined) p.shadowLift = s.lift;
      if (s.knee !== undefined) p.shadowKnee = s.knee;
      if (s.soft !== undefined) p.blackSoft = s.soft;
      if (s.toeGamma !== undefined) p.toeGamma = s.toeGamma;
      if (s.toeKnee !== undefined) p.toeKnee = s.toeKnee;
      p.bloomStrength = s.bloom;
      p.volWeight = s.vol;
      p.exposureKey = s.key ?? 0.160;
      p.exposureMaxGain = s.gain ?? 2.10;
      p.volSkyWeight = s.skyRays;
      p.ssrWetness = s.wet;
      p.ssrIntensity = s.ssr;
      p.aoIntensity = s.ao * 0.92;
      p.grain = s.grain;
      p.vignette = s.vignette;

      // Weather pushes wetness and haze around.
      if (env.weather === 'rain') {
        p.ssrWetness = Math.min(1.0, p.ssrWetness + 0.2);
        p.volWeight *= 0.85;
      } else if (env.weather === 'ember') {
        p.volWeight *= 1.12;
      }
      if (typeof env.fog === 'number') {
        p.volWeight *= 0.75 + env.fog * 0.6;
      }

      // DOF: subtle in gameplay, real only in the framed shots.
      this._applyDofProfile(s.dof);

      /*
       * Closeups want less atmosphere sitting on the hero's face.
       *
       * CHROMATIC ABERRATION, cut ~4x. Measured on `hub`: at 0.00065 the CA pass
       * turned 6.7 % of the top-right corner and 3.3 % of the whole frame into
       * FULLY SATURATED single-channel pixels (samples like 2,40,87 and 139,80,50).
       * Setting it to zero dropped the same corner to 0.21 %. The cause is that a
       * per-channel 1 px shift on a frame that already carries high-frequency
       * specular/normal aliasing decorrelates the channels into rainbow confetti —
       * the "aliasing crawl on high-contrast edges" instant fail. The aliasing
       * itself is a material/AA problem and still needs fixing at the source, but
       * the lens pass must not be its amplifier. 0.00016 keeps a trace of the
       * effect at the extreme corner and is invisible elsewhere.
       */
      if (name === 'closeup' || name === 'inventory') {
        p.volFalloff = 1.8;
        p.chromatic = 0.00012;
        p.motionBlur = 0.25;
      } else {
        p.volFalloff = 1.1;
        p.chromatic = 0.00016;
        p.motionBlur = 0.55;
      }

      // Bloom is authored in scene-linear units and the gain just moved.
      this._syncExposureBudget();
      this._syncPasses();
      this._scanLights();
      this.passes.autoExposure?.reset();
      this.passes.motionBlur?.reset();
      this._lightWeight = 0;
      this._focus = this._focusTarget();

      /*
       * Warm every program this scenario needs while the loading screen is still
       * up. Twice, on purpose: the world modules have already rebuilt by the time
       * we are called, but `Scenarios.applyScenario` then settles the sim for 30
       * ticks, and the Director spawns its encounter inside those ticks — so the
       * monsters' materials do not exist yet. The deferred pass catches them, and
       * `render()` forces it if the settle never happens.
       */
      this._shimCompile();
      this.prewarm();
      this._prewarmAt = (this.engine.clock?.frame ?? 0) + 24;
    } catch (e) {
      console.warn('[render] applyScenario —', e);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  per-frame data                                                     */
  /* ------------------------------------------------------------------ */

  update() {
    if (this.__dead || !this.composer) return;
    if (this.engine.clock.frame - this._lightScanAt > 30) this._scanLights();
    // Deferred prewarm: runs on a sim tick (no frame is being drawn), which is
    // exactly where a 40 ms link storm is free.
    if (this._prewarmAt >= 0 && this.engine.clock.frame >= this._prewarmAt) {
      this._prewarmAt = -1;
      this.prewarm();
    }
  }

  /**
   * One scene walk, two jobs: collect the shaft-source candidates and count how
   * many objects have claimed the post-exempt UI layer. Piggy-backing the count
   * here is what makes the exemption free when nobody uses it — see the UI LAYER
   * note at the top of the file.
   */
  _scanLights() {
    this._lightScanAt = this.engine.clock.frame;
    const lights = this._lights;
    lights.length = 0;
    let ui = 0;
    const test = this._uiTest;
    this.scene.traverse((o) => {
      if (o.layers.test(test) === true && (o.isMesh === true || o.isSprite === true ||
        o.isPoints === true || o.isLine === true)) ui++;
      if (o.visible !== true) return;
      if (o.isDirectionalLight === true || o.isPointLight === true || o.isSpotLight === true) {
        lights.push(o);
      }
    });
    this._uiLayerUsers = ui;
  }

  /** Pick the dominant shaft source and project it to screen space. */
  _updateLightSource() {
    const vol = this.passes.volumetric;
    if (!vol || vol.enabled === false) return;

    const cam = this.camera;
    const pos = this._v0;
    const dir = this._v1;
    const tgt = this._v2;

    let best = null;
    let bestScore = 0;
    let bestUvX = 0.5;
    let bestUvY = 0.65;
    let bestWeight = 0;

    // The incumbent gets tracked separately so switching sources needs a clear
    // win — otherwise two similar torches would ping-pong the shaft origin.
    let incumbent = null;
    let incScore = 0;
    let incUvX = 0.5;
    let incUvY = 0.65;
    let incWeight = 0;

    for (let i = 0; i < this._lights.length; i++) {
      const l = this._lights[i];
      if (l.visible !== true || !(l.intensity > 0)) continue;

      let score;
      if (l.isDirectionalLight === true) {
        pos.setFromMatrixPosition(l.matrixWorld);
        if (l.target) tgt.setFromMatrixPosition(l.target.matrixWorld);
        else tgt.set(0, 0, 0);
        dir.copy(pos).sub(tgt);
        if (dir.lengthSq() < 1e-8) continue;
        dir.normalize();
        pos.copy(cam.position).addScaledVector(dir, Math.min(cam.far * 0.5, 350));
        score = 1.5 * Math.min(l.intensity, 8);
      } else {
        pos.setFromMatrixPosition(l.matrixWorld);
        const d = pos.distanceTo(cam.position);
        score = Math.min(l.intensity, 60) / (1 + d * 0.16);
      }

      // Must be in front of the camera.
      tgt.copy(pos).applyMatrix4(cam.matrixWorldInverse);
      if (tgt.z > -cam.near) continue;

      dir.copy(pos).project(cam);
      const ux = dir.x * 0.5 + 0.5;
      const uy = dir.y * 0.5 + 0.5;
      const onScreen =
        smooth(-0.5, 0.02, ux) * (1 - smooth(0.98, 1.5, ux)) *
        smooth(-0.5, 0.02, uy) * (1 - smooth(0.98, 1.5, uy));
      if (onScreen <= 0.001) continue;

      score *= 0.3 + 0.7 * onScreen;

      if (l === this._activeLight) {
        incumbent = l;
        incScore = score;
        incUvX = ux;
        incUvY = uy;
        incWeight = onScreen;
      }
      if (score > bestScore) {
        bestScore = score;
        best = l;
        bestUvX = ux;
        bestUvY = uy;
        bestWeight = onScreen;
      }
    }

    if (incumbent && bestScore < incScore * 1.35) {
      best = incumbent;
      bestUvX = incUvX;
      bestUvY = incUvY;
      bestWeight = incWeight;
    }
    this._activeLight = best;

    if (best) {
      this._lightUVTarget.set(bestUvX, bestUvY);
      this._lightColorTarget.copy(best.color);
      this._lightWeightTarget = bestWeight;
    } else {
      this._lightWeightTarget = 0;
    }

    // Fixed-rate smoothing keeps shafts from popping when a torch flickers out.
    this._lightUV.lerp(this._lightUVTarget, 0.25);
    this._lightColor.lerp(this._lightColorTarget, 0.2);
    this._lightWeight += (this._lightWeightTarget - this._lightWeight) * 0.18;

    this.passes.volumetric?.setSource(this._lightUV, this._lightColor, clamp(this._lightWeight, 0, 1));
  }

  _heroPosition(out) {
    const hero = this.engine.get('hero');
    if (hero && !hero.__dead) {
      const o = hero.root ?? hero.group ?? hero.model ?? hero.mesh ?? hero.object3D ?? null;
      if (o && o.isObject3D === true) {
        out.setFromMatrixPosition(o.matrixWorld);
        return true;
      }
      if (hero.position && hero.position.isVector3 === true) {
        out.copy(hero.position);
        return true;
      }
    }
    // The shipped CameraRig publishes its smoothed aim point as `focus`, not
    // `target` — without this the DOF plane fell back to the ground-plane
    // intersection every frame instead of tracking what the rig is framing.
    const rig = this.engine.get('camera');
    if (rig && !rig.__dead) {
      const aim = rig.focus ?? rig.target;
      if (aim && aim.isVector3 === true) {
        out.copy(aim);
        return true;
      }
    }
    return false;
  }

  _focusTarget() {
    const cam = this.camera;
    const p = this._v0;
    if (this._heroPosition(p)) {
      return clamp(cam.position.distanceTo(p), cam.near + 0.2, cam.far * 0.5);
    }
    const d = cam.getWorldDirection(this._v1);
    if (Math.abs(d.y) > 1e-3) {
      const t = -cam.position.y / d.y;
      if (t > 0.5) return clamp(t, cam.near + 0.2, cam.far * 0.5);
    }
    return 20;
  }

  /* ------------------------------------------------------------------ */
  /*  the frame                                                          */
  /* ------------------------------------------------------------------ */

  render() {
    if (this.__dead || !this.composer) {
      // No chain, so nothing to be exempt FROM: let the UI layer draw inline
      // rather than vanish along with the post-processing.
      this.camera.layers.enable(UI_LAYER);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Last resort: a scenario that never got its settle ticks still must not
    // link programs inside a measured frame more than once.
    if (this._prewarmAt >= 0) {
      this._prewarmAt = -1;
      this.prewarm();
    }

    const profiler = this.engine.profiler;
    profiler?.begin('render');

    const dt = this.engine.clock.dt || 1 / 60;
    this.camera.updateMatrixWorld();

    // Re-assert the post-chain exemption. One `camera.layers.enableAll()` in
    // another module would otherwise silently drag interface back into the
    // grade, which is exactly how blocker #9 happened in the first place.
    if (this.camera.layers.isEnabled(UI_LAYER)) this.camera.layers.disable(UI_LAYER);

    // --- per-frame driven data (all deterministic) ---
    this._updateLightSource();

    if (this.passes.dof) {
      const target = this._focusTarget();
      this._focus += (target - this._focus) * clamp(this.params.dofFocusLag, 0.01, 1);
      this.passes.dof.setFocus(this._focus);
    }
    if (this.passes.motionBlur) this.passes.motionBlur.updateMatrices();
    if (this.passes.grain) this.passes.grain.frame = this._frame;
    if (this.passes.composite) this.passes.composite.frame = this._frame;

    /*
     * Per-instance culling, driven from here because this is the one place that
     * knows the camera matrix is final for the frame: the world modules update
     * before CameraRig, so a cull done in `Dungeon.update()` would be testing
     * against last frame's view. Everything downstream — the depth prepass, the
     * shadow cameras, the beauty pass — reads the counts this sets, and the
     * `finally` hands the pools back to their owners before the next sim tick can
     * touch them (see the buffer-swap note in core/InstanceCull.js).
     */
    const cull = this._cullFailed === true ? null : this.engine.instanceCull;
    if (cull) {
      try {
        // `_scanLights` already walks the scene for the shaft source; the culler
        // needs the same list to know how far a shadow can reach off screen.
        cull.setShadowLights(this._lights);
        cull.update(this.camera);
      } catch (e) {
        this._cullFailed = true;
        console.warn('[render] instance culling disabled —', e?.message ?? e);
        try { cull.release(); } catch { /* ignore */ }
      }
    }

    try {
      // --- shared depth + normal prepass ---
      if (this.gbuffer && this._needsGBuffer()) this.gbuffer.render(this.renderer);

      // --- the chain ---
      this.composer.render(dt);

      this._frame++;
      profiler?.end();

      this._renderOverlays();
    } finally {
      if (cull) { try { cull.release(); } catch { /* ignore */ } }
    }
  }

  _needsGBuffer() {
    const P = this.passes;
    return !!(
      (P.gtao && P.gtao.enabled) ||
      (P.ssr && P.ssr.enabled) ||
      (P.volumetric && P.volumetric.enabled) ||
      (P.dof && P.dof.enabled) ||
      (P.motionBlur && P.motionBlur.enabled)
    );
  }

  /**
   * Composite the post-exempt UI layer onto the resolved frame.
   *
   * `scene.background` is nulled and `autoClear` is forced off for the duration,
   * because `WebGLRenderer.render()` force-clears whenever the scene carries a
   * background — that would wipe the frame the chain just produced. Objects on
   * this layer are expected to be unlit and `depthTest: false`; the default
   * framebuffer's depth buffer holds only the composer's full-screen quads.
   */
  _renderUILayer() {
    if (this._uiFailed || this._uiLayerUsers <= 0) return;
    const cam = this.camera;
    const scene = this.scene;
    const mask = cam.layers.mask;
    const bg = scene.background;
    const auto = this.renderer.autoClear;
    try {
      cam.layers.set(UI_LAYER);
      scene.background = null;
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, cam);
    } catch (e) {
      this._uiFailed = true;
      console.warn('[render] UI layer composite disabled —', e?.message ?? e);
    } finally {
      cam.layers.mask = mask;
      scene.background = bg;
      this.renderer.autoClear = auto;
      this.renderer.setRenderTarget(null);
    }
  }

  /** Lets the HUD (or anything else) draw straight onto the resolved frame. */
  _renderOverlays() {
    if (this._overlayFailed) return;
    this._renderUILayer();
    try {
      const hud = this.engine.get('hud');
      if (hud && !hud.__dead && typeof hud.renderOverlay === 'function') {
        const auto = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.renderer.setRenderTarget(null);
        hud.renderOverlay(this.renderer);
        this.renderer.autoClear = auto;
        this.renderer.setRenderTarget(null);
      }
      this.engine.bus.emit('render:overlay', { renderer: this.renderer, camera: this.camera });
    } catch (e) {
      this._overlayFailed = true;
      console.warn('[render] overlay hook disabled —', e);
    }
  }
}
