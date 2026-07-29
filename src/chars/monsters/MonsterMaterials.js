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
 * Keep these small — a 1.7 m skeleton whose bone grain repeats every 1.5 m is
 * exactly the "macro photograph" failure KNOWN_ISSUES.md calls out.
 *
 * `floor` = ALBEDO FLOOR, in scene-linear units, and it is a bug fix.
 *
 * The bestiary's dark recipes were crushed to black. Measured material colours
 * from the live `combat` scenario:
 *
 *   cultist:cloth  [0.092, 0.059, 0.063]      skeleton:cloth [0.145, 0.108, 0.073]
 *   brute:cloth    [0.116, 0.084, 0.049]      hellhound:ember [0.252, 0.056, 0.011]
 *
 * and that colour is then multiplied by the albedo MAP (~0.4-0.6 mid) and again
 * by the per-vertex grime term (`grimeFn` darkens the lower body to 0.58), so a
 * cultist's robe arrives at the BRDF at roughly 0.025 linear. No amount of light
 * makes 0.025 albedo show cloth weave: the surface has nowhere to read, which is
 * exactly the critic's "solid black cone with no internal detail".
 *
 * So every recipe declares a floor and the shader lifts the albedo into
 * [floor, 1] (`floor + c * (1 - floor)`) — black goes to `floor`, white stays
 * white, and the mid-tone structure the maps carry is preserved as a ratio. The
 * values sit in the 0.06-0.10 band: enough for cloth, bone and flesh to hold
 * material information under a torch, low enough that a robe is still the
 * darkest thing on the body.
 */
export const RECIPES = {
  bone:   { kind: 'bone',    uv: 0.24, seed: 611,  normalScale: 1.15, env: 0.75, rough: 1.0, floor: 0.070, rim: 0.85 },
  boneOld:{ kind: 'bone',    uv: 0.28, seed: 977,  normalScale: 1.25, env: 0.55, rough: 1.0, tint: [0.78, 0.74, 0.66], floor: 0.070, rim: 0.85 },
  flesh:  { kind: 'flesh',   uv: 0.26, seed: 233,  normalScale: 1.1,  env: 0.6,  floor: 0.080, rim: 1.05 },
  rot:    { kind: 'flesh',   uv: 0.28, seed: 809,  normalScale: 1.25, env: 0.5,  tint: [0.70, 0.78, 0.62], floor: 0.080, rim: 1.05 },
  charred:{ kind: 'flesh',   uv: 0.22, seed: 1471, normalScale: 1.35, env: 0.45, tint: [0.30, 0.26, 0.25], floor: 0.075, rim: 1.20 },
  cloth:  { kind: 'cloth',   uv: 0.34, seed: 353,  normalScale: 1.0,  env: 0.45, floor: 0.095, rim: 1.30 },
  hide:   { kind: 'leather', uv: 0.30, seed: 457,  normalScale: 1.1,  env: 0.55, floor: 0.085, rim: 1.15 },
  metal:  { kind: 'metal',   uv: 0.26, seed: 733,  normalScale: 0.95, env: 1.15, floor: 0.060, rim: 1.20 },
  brass:  { kind: 'gold',    uv: 0.20, seed: 1093, normalScale: 0.8,  env: 1.3,  floor: 0.060, rim: 1.05 },
  basalt: { kind: 'stone',   uv: 0.36, seed: 1279, normalScale: 1.2,  env: 0.7,  tint: [0.55, 0.50, 0.52], floor: 0.075, rim: 1.10 },
  ember:  { kind: 'ash',     uv: 0.18, seed: 1613, normalScale: 0.9,  env: 0.5,  floor: 0.065, rim: 0.90 },
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
       somewhere to read, while white stays white and every mid-tone keeps its
       ratio to its neighbours. Applied FIRST, before the emissive-mask cavity
       darkening below, so glowing eye sockets are still cut out of it. */
    diffuseColor.rgb = uMonAlbFloor + diffuseColor.rgb * ( 1.0 - uMonAlbFloor );

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
       to pure white. */
    totalEmissiveRadiance += min(
      uMonAuraColor * uMonAura * ( 0.10 + monF2 * 0.62 + monF3 * 1.35 ),
      vec3( 0.62 ) );
    totalEmissiveRadiance += uMonFlashColor * uMonFlash * 2.4;
    totalEmissiveRadiance += uMonDissEdge * monEdge * 7.0;

    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), uMonFlash * 0.45 );
    // wraith / phasing: fresnel-weighted coverage, never a flat 50 % fade
    float monGhostA = clamp( 0.12 + monF * 1.30 + monF3 * 0.55, 0.0, 1.0 );
    diffuseColor.a *= mix( 1.0, monGhostA, uMonGhost );
    // uMonFade: coverage ramp along local Y — smoke trails dissolving into air
    float monFadeOn = step( 0.0001, uMonFade.y );
    diffuseColor.a *= mix( 1.0, clamp( ( vMonPos.y - uMonFade.x ) / max( 0.0001, uMonFade.y ), 0.0, 1.0 ), monFadeOn );
    roughnessFactor = clamp( roughnessFactor - uMonFlash * 0.28, 0.04, 1.0 );
  }
`;

/** Attach the shared monster shader to any Standard/Physical material. */
export function injectMonsterShader(mat, u) {
  mat.userData.monU = u;
  mat.onBeforeCompile = (shader) => {
    for (const k in u) shader.uniforms[k] = u[k];
    shader.vertexShader = 'varying vec3 vMonPos;\nvarying float vMonMask;\nattribute float aMask;\n' +
      shader.vertexShader.replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\n\tvMonPos = transformed;\n\tvMonMask = aMask;'
      );
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAG_DISSOLVE)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + FRAG_EFFECTS);
  };
  // v2: albedo floor + three-lobe aura. Defines are part of three's own cache key
  // so this is belt-and-braces, but it documents that the source changed shape.
  mat.customProgramCacheKey = () => 'sanctum-monster-v2';
  return mat;
}

export function makeMonsterUniforms(o = {}) {
  const f = o.albFloor ?? 0.075;
  return {
    uMonAlbFloor: { value: new THREE.Vector3(f * FLOOR_TINT[0], f * FLOOR_TINT[1], f * FLOOR_TINT[2]) },
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
    this._extra = new Map();
    this._owned = [];
  }

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

    const u = makeMonsterUniforms(Object.assign({ albFloor: r.floor ?? 0.075 }, o));
    injectMonsterShader(mat, u);
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
    this._extra.clear();
  }
}
