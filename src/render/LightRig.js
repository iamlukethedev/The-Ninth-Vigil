/**
 * THE NINTH VIGIL — LightRig
 *
 * Support machinery for `src/render/Lighting.js`:
 *
 *   • colour-temperature helpers (Planckian locus -> linear-working-space Color)
 *   • layered deterministic fire flicker (breathe + crackle + guttering)
 *   • `Practical` — a handle for a torch / brazier / hellfire / magic source
 *   • `LightPool` — a FIXED set of GPU lights that practicals are assigned to by
 *     importance, so the shader permutation never changes (no recompile hitches)
 *   • `ProbeVolume` — a coarse 3D irradiance grid so nearby stone picks up the
 *     warm bounce of a torch
 *   • scenario lighting presets + procedural sky/IBL source
 *
 * Everything here is deterministic: no Math.random(), no Date.now(). Time comes
 * from `engine.clock.elapsed`, randomness from hashes of integer seeds.
 */

import * as THREE from 'three';
import { perlin2, fbm2, valueNoise2 } from '../core/Rand.js';

/* ------------------------------------------------------------------ */
/* small math helpers                                                   */
/* ------------------------------------------------------------------ */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* colour temperature                                                   */
/* ------------------------------------------------------------------ */

/**
 * Reference colour temperatures used across the game. Rendering notes:
 * torch/candle flame is genuinely ~1850-1950 K; hellfire is pushed to 2600 K
 * but with the saturation cranked so it reads as *unnatural* fire; moonlight is
 * physically ~4100 K but the eye reads night as blue (Purkinje shift), so it is
 * rendered with a deliberate cool bias.
 */
export const KELVIN = {
  candle: 1750,
  torch: 1900,
  brazier: 2000,
  hellfire: 2600,
  lava: 1300,
  tungsten: 2850,
  duskSun: 2400,
  goldenSun: 3400,
  daySun: 5600,
  overcast: 6800,
  moon: 4100,
  skylight: 11000,
};

const _tmpHSL = { h: 0, s: 0, l: 0 };

/**
 * Planckian black-body -> sRGB (Tanner Helland fit), then converted into the
 * renderer's linear working space by THREE.Color.
 *
 * @param {number} kelvin      Colour temperature in K (1000..40000).
 * @param {THREE.Color} target Colour to write into.
 * @param {number} [sat=1]     Saturation multiplier (>1 pushes it hotter/dirtier).
 * @param {number} [coolBias=0] Blend toward a cold blue after the fit (moonlight).
 */
export function kelvinColor(kelvin, target = new THREE.Color(), sat = 1, coolBias = 0) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r, g, b;

  if (t <= 66) r = 255;
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);

  if (t <= 66) g = 99.4708025861 * Math.log(Math.max(t, 1.0001)) - 161.1195681661;
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  target.setRGB(clamp01(r / 255), clamp01(g / 255), clamp01(b / 255), THREE.SRGBColorSpace);

  if (sat !== 1) {
    target.getHSL(_tmpHSL);
    target.setHSL(_tmpHSL.h, clamp01(_tmpHSL.s * sat), _tmpHSL.l);
  }
  if (coolBias > 0) {
    // Purkinje-ish night bias: rotate toward a desaturated cold blue.
    target.lerp(_COOL, clamp01(coolBias));
  }
  return target;
}
const _COOL = new THREE.Color().setRGB(0.42, 0.58, 1.0, THREE.SRGBColorSpace);

/* ------------------------------------------------------------------ */
/* flicker                                                              */
/* ------------------------------------------------------------------ */

/**
 * Flicker profiles. Each source layers three independent noise fields:
 *   breathe — very slow swell of the whole flame body
 *   crackle — fast fractal noise from turbulence at the wick
 *   gutter  — rare, deep, short dips (a draught catching the flame)
 * plus a positional jitter so the *shadow* moves too, not just the exposure.
 */
export const FLICKER = {
  steady:   { breathe: 0.00, breatheHz: 0.10, crackle: 0.00, crackleHz: 1.0, gutter: 0.00, gutterHz: 0.3, gutterEdge: 0.90, jitter: 0.000, hotShift: 0 },
  candle:   { breathe: 0.10, breatheHz: 0.37, crackle: 0.22, crackleHz: 6.4, gutter: 0.62, gutterHz: 0.83, gutterEdge: 0.78, jitter: 0.030, hotShift: 200 },
  torch:    { breathe: 0.13, breatheHz: 0.29, crackle: 0.25, crackleHz: 5.1, gutter: 0.50, gutterHz: 0.67, gutterEdge: 0.80, jitter: 0.048, hotShift: 240 },
  brazier:  { breathe: 0.11, breatheHz: 0.21, crackle: 0.16, crackleHz: 3.3, gutter: 0.30, gutterHz: 0.41, gutterEdge: 0.85, jitter: 0.030, hotShift: 190 },
  campfire: { breathe: 0.14, breatheHz: 0.24, crackle: 0.21, crackleHz: 4.1, gutter: 0.36, gutterHz: 0.52, gutterEdge: 0.83, jitter: 0.040, hotShift: 220 },
  hellfire: { breathe: 0.19, breatheHz: 0.14, crackle: 0.28, crackleHz: 2.2, gutter: 0.22, gutterHz: 0.29, gutterEdge: 0.89, jitter: 0.062, hotShift: 330 },
  lava:     { breathe: 0.16, breatheHz: 0.07, crackle: 0.07, crackleHz: 0.9, gutter: 0.00, gutterHz: 0.2, gutterEdge: 0.95, jitter: 0.012, hotShift: 120 },
  magic:    { breathe: 0.24, breatheHz: 0.43, crackle: 0.10, crackleHz: 1.9, gutter: 0.00, gutterHz: 0.2, gutterEdge: 0.95, jitter: 0.022, hotShift: 0 },
  shaft:    { breathe: 0.05, breatheHz: 0.08, crackle: 0.03, crackleHz: 0.6, gutter: 0.00, gutterHz: 0.2, gutterEdge: 0.95, jitter: 0.004, hotShift: 0 },
};

const _flick = { mul: 1, hot: 0, jx: 0, jy: 0, jz: 0 };

/**
 * Sample the layered flicker for one source at a given time.
 * Pure function of (t, seed) — identical every replay.
 *
 * @param {number} t      seconds (engine.clock.elapsed)
 * @param {number} seed   integer id of the source
 * @param {object} p      a FLICKER profile
 * @param {number} amount 0..1 blend between steady and full flicker
 */
export function sampleFlicker(t, seed, p, amount = 1) {
  const s = (seed & 1023) * 0.6180339887;
  const i0 = (seed * 17 + 3) | 0;
  const i1 = (seed * 29 + 7) | 0;
  const i2 = (seed * 41 + 13) | 0;
  const i3 = (seed * 53 + 19) | 0;

  const breathe = perlin2(t * p.breatheHz + s * 7.3, s * 3.1 + 11.5, i0) - 0.5;
  const crackle =
    fbm2(t * p.crackleHz + s * 13.7, s * 5.9 + 2.3, {
      octaves: 3,
      gain: 0.52,
      lacunarity: 2.31,
      seed: i1,
    }) - 0.5;

  let gut = 0;
  if (p.gutter > 0) {
    const g = valueNoise2(t * p.gutterHz + s * 4.1, s * 9.7 + 5.5, i2);
    gut = smoothstep(p.gutterEdge, Math.min(0.995, p.gutterEdge + 0.13), g);
    // a gutter is a fast collapse and a slower recovery — square it up
    gut = gut * gut * (2.0 - gut);
  }

  let mul = 1 + breathe * 2 * p.breathe + crackle * 2 * p.crackle;
  mul *= 1 - gut * p.gutter;
  mul = clamp(mul, 0.22, 1.45);
  mul = 1 + (mul - 1) * amount;

  const jf = p.jitter * amount;
  _flick.mul = mul;
  _flick.hot = clamp01((mul - 0.72) / 0.55);
  _flick.jx = (perlin2(t * 2.31 + s * 2.7, 17.3 + s, i3) - 0.5) * 2 * jf;
  _flick.jy = (perlin2(t * 3.07 + s * 1.9, 41.1 + s, i0 + 91) - 0.5) * 1.4 * jf;
  _flick.jz = (perlin2(t * 2.63 + s * 3.3, 63.7 + s, i1 + 57) - 0.5) * 2 * jf;
  return _flick;
}

/* ------------------------------------------------------------------ */
/* Practical — one light source in the world                            */
/* ------------------------------------------------------------------ */

let _practicalIds = 1;

export class Practical {
  /**
   * @param {object} o
   * @param {THREE.Vector3|number[]} o.position
   * @param {number|string} [o.color]    hex tint; omit to use `kelvin`
   * @param {number} [o.kelvin]          colour temperature
   * @param {number} [o.intensity]       candela (inverse-square falloff)
   * @param {number} [o.radius]          cutoff distance in world units
   * @param {number|boolean} [o.flicker] 0..1 flicker amount
   * @param {string} [o.type]            FLICKER profile key
   * @param {'point'|'spot'} [o.kind]
   * @param {number[]} [o.direction]     spot aim direction
   * @param {number} [o.angle]           spot cone half-angle (radians)
   * @param {number} [o.penumbra]
   * @param {number} [o.saturation]      colour saturation multiplier
   * @param {number} [o.priority]        importance multiplier (1 = normal)
   * @param {boolean} [o.shadow]         allowed to take a shadow slot
   */
  constructor(o = {}) {
    this.id = _practicalIds++;
    this.kind = o.kind === 'spot' ? 'spot' : 'point';
    this.type = FLICKER[o.type] ? o.type : 'torch';
    this.profile = FLICKER[this.type];

    this.basePosition = new THREE.Vector3();
    if (Array.isArray(o.position)) this.basePosition.fromArray(o.position);
    else if (o.position) this.basePosition.copy(o.position);
    this.position = this.basePosition.clone();

    this.baseIntensity = o.intensity ?? 14;
    this.radius = o.radius ?? 13;
    this.flicker = o.flicker === false ? 0 : o.flicker === true ? 1 : (o.flicker ?? 1);
    this.priority = o.priority ?? 1;
    this.allowShadow = o.shadow !== false;
    this.enabled = true;

    // spot params
    this.angle = o.angle ?? 0.42;
    this.penumbra = o.penumbra ?? 0.65;
    this.direction = new THREE.Vector3(0, -1, 0);
    if (Array.isArray(o.direction)) this.direction.fromArray(o.direction);
    else if (o.direction) this.direction.copy(o.direction);
    if (this.direction.lengthSq() < 1e-8) this.direction.set(0, -1, 0);
    this.direction.normalize();

    // colour: cool base + hot peak, lerped by flame brightness
    const sat = o.saturation ?? (this.type === 'hellfire' ? 1.35 : this.type === 'lava' ? 1.25 : 1);
    this.coolColor = new THREE.Color();
    this.hotColor = new THREE.Color();
    if (o.color !== undefined && o.color !== null) {
      this.coolColor.set(o.color);
      this.hotColor.copy(this.coolColor).lerp(_WHITE, 0.18);
    } else {
      const k = o.kelvin ?? KELVIN[this.type] ?? KELVIN.torch;
      kelvinColor(k, this.coolColor, sat);
      kelvinColor(k + (this.profile.hotShift || 0), this.hotColor, sat);
    }
    this.color = this.coolColor.clone();

    /** external fade (0..1) — set by gameplay, e.g. a torch being doused */
    this.gain = 1;
    /** live flicker-modulated intensity, recomputed each frame */
    this.intensity = this.baseIntensity;

    /* runtime bookkeeping owned by LightPool */
    this._slot = null;
    this._slotAge = 0;
    this._score = 0;
    this._live = 0; // 0..1 how much of this practical is actually on a GPU light

    /** optional visual emitter (auto-spawned practicals only) */
    this.visual = null;
    this.userData = o.userData ?? {};
  }

  /** Move the source. Accepts (x,y,z) or a Vector3/array. */
  setPosition(x, y, z) {
    if (typeof x === 'number') this.basePosition.set(x, y, z);
    else if (Array.isArray(x)) this.basePosition.fromArray(x);
    else if (x) this.basePosition.copy(x);
    return this;
  }

  setIntensity(v) { this.baseIntensity = v; return this; }
  setRadius(v) { this.radius = v; return this; }
  setColor(c) {
    this.coolColor.set(c);
    this.hotColor.copy(this.coolColor).lerp(_WHITE, 0.18);
    return this;
  }
  setKelvin(k, sat = 1) {
    kelvinColor(k, this.coolColor, sat);
    kelvinColor(k + (this.profile.hotShift || 0), this.hotColor, sat);
    return this;
  }
  /** Fade the source out over `sec` and keep it dark (does not remove it). */
  extinguish() { this.gain = 0; return this; }
  relight() { this.gain = 1; return this; }

  /** Recompute flicker-modulated position/colour/intensity for this frame. */
  tick(t) {
    const f = this.flicker > 0
      ? sampleFlicker(t, this.id * 7919, this.profile, this.flicker)
      : _steady;
    const scale = Math.max(0.35, this.radius / 9);
    this.position.set(
      this.basePosition.x + f.jx * scale,
      this.basePosition.y + f.jy * scale,
      this.basePosition.z + f.jz * scale
    );
    this.intensity = this.baseIntensity * f.mul * this.gain * (this.enabled ? 1 : 0);
    this.color.copy(this.coolColor).lerp(this.hotColor, f.hot);
    if (this.visual) this.visual.sync(this, f);
  }
}
const _WHITE = new THREE.Color(1, 1, 1);
const _steady = { mul: 1, hot: 0.35, jx: 0, jy: 0, jz: 0 };

/* ------------------------------------------------------------------ */
/* LightPool — fixed GPU lights, importance-assigned                    */
/* ------------------------------------------------------------------ */

const _sphere = new THREE.Sphere();

/**
 * WebGL can only afford a handful of real lights, and — critically — changing
 * how many lights are in the scene rebuilds every shader program. So the pool
 * allocates its lights ONCE and never changes their count or their castShadow
 * flag; practicals are *assigned* to slots by importance and cross-faded when
 * an assignment changes. Zero recompiles, zero popping.
 */
export class LightPool {
  constructor(scene, opts) {
    this.kind = opts.kind === 'spot' ? 'spot' : 'point';
    this.size = Math.max(0, opts.size | 0);
    this.shadowSlots = Math.max(0, Math.min(opts.shadowSlots | 0, this.size));
    this.fadeRate = opts.fadeRate ?? 4.2;      // 1/seconds
    this.scene = scene;
    this.slots = [];

    for (let i = 0; i < this.size; i++) {
      const shadowed = i < this.shadowSlots;
      let light;
      if (this.kind === 'spot') {
        light = new THREE.SpotLight(0xffffff, 0, 10, 0.42, 0.65, 2);
        light.target.position.set(0, -1, 0);
        scene.add(light.target);
      } else {
        light = new THREE.PointLight(0xffffff, 0, 10, 2);
      }
      light.name = `nona.${this.kind}${shadowed ? '.sh' : ''}.${i}`;
      light.castShadow = shadowed;
      light.matrixAutoUpdate = true;

      if (shadowed) {
        const s = light.shadow;
        s.mapSize.setScalar(opts.shadowRes ?? 512);
        s.camera.near = 0.28;
        s.camera.far = 12;
        s.bias = this.kind === 'spot' ? -0.0009 : -0.0021;
        s.normalBias = this.kind === 'spot' ? 0.035 : 0.062;
        s.radius = this.kind === 'spot' ? 3.0 : 2.6;
        s.autoUpdate = true;
      }
      // Park the light out of the way until it owns something.
      light.position.set(0, -4000 - i * 8, 0);
      light.intensity = 0;
      scene.add(light);

      this.slots.push({
        light,
        index: i,
        shadowed,
        owner: null,
        want: null,
        fade: 0,
        /** Owner the depth cube was last rendered for — see `apply()`. */
        shadowOwner: null,
      });
    }
    /**
     * How many frames apart a shadowed slot rebuilds its depth map.
     *
     * A shadowed POINT light is six full scene renders. Measured on `combat` at
     * 1600x900, two of them plus one shadowed spot cost 1,315 draw calls and
     * 9.6 M triangles EVERY FRAME — 47 % of the whole frame's geometry work — to
     * re-render an essentially static crypt from a light that moves by a
     * centimetre of flicker jitter.
     *
     * So slots rebuild on a stagger instead: at period 2 only half the cubes are
     * rasterised per frame and the other half reuse last frame's depth, which for
     * a 512² map with a 2.6-texel penumbra is not a difference you can find in a
     * frame. Forced (not staggered) whenever the slot changes owner, whenever it
     * moves more than a texel's worth of world space, and until the map exists —
     * a stale cube for the WRONG torch would be very visible indeed.
     *
     * Deterministic: driven by `engine.clock.frame`, so a given capture frame
     * always lands on the same phase.
     */
    this.shadowPeriod = Math.max(1, opts.shadowPeriod ?? 2);
  }

  /**
   * Rank practicals and (re)assign them to slots.
   * Hysteresis: an incumbent gets a score bonus so the assignment does not
   * oscillate when two torches are nearly equally important.
   */
  select(practicals, camera, frustum, dt) {
    if (this.size === 0) return;

    const camPos = camera.position;
    const cand = [];
    for (let i = 0; i < practicals.length; i++) {
      const p = practicals[i];
      if (p.kind !== this.kind) continue;
      if (!p.enabled || p.gain <= 0.001 || p.baseIntensity <= 0) { p._score = 0; continue; }

      const d = Math.max(0.35, camPos.distanceTo(p.position));
      _sphere.center.copy(p.position);
      _sphere.radius = p.radius;
      const visible = frustum.intersectsSphere(_sphere);
      if (!visible && d > p.radius) { p._score = 0; continue; }

      // Screen-space importance: angular radius of the lit sphere, weighted by
      // how much light actually reaches the camera plane (inverse square).
      const angular = p.radius / d;
      const reach = p.intensity / (d * d);
      let score = p.priority * Math.pow(angular, 1.35) * (0.35 + Math.min(reach, 12));
      if (!visible) score *= 0.12;
      if (p._slot) score *= p._slot.shadowed ? 1.35 : 1.16;   // incumbency
      if (p._slotAge > 0 && p._slotAge < 0.7) score *= 1.5;   // minimum dwell
      p._score = score;
      cand.push(p);
    }

    cand.sort(_byScoreDesc);

    // Split the ranked list into the shadow tier and the plain tier.
    const wantShadow = [];
    const wantPlain = [];
    for (let i = 0, ns = 0, np = 0; i < cand.length; i++) {
      const p = cand[i];
      if (ns < this.shadowSlots && p.allowShadow) { wantShadow.push(p); ns++; }
      else if (np < this.size - this.shadowSlots) { wantPlain.push(p); np++; }
      if (ns >= this.shadowSlots && np >= this.size - this.shadowSlots) break;
    }

    this._assign(0, this.shadowSlots, wantShadow);
    this._assign(this.shadowSlots, this.size, wantPlain);

    // Advance the per-slot cross-fade.
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.owner !== s.want) {
        s.fade -= dt * this.fadeRate;
        if (s.fade <= 0) {
          s.fade = 0;
          if (s.owner) { s.owner._slot = null; s.owner._live = 0; }
          s.owner = s.want;
          if (s.owner) { s.owner._slot = s; s.owner._slotAge = 0; }
        }
      } else {
        s.fade = Math.min(1, s.fade + dt * this.fadeRate);
      }
      if (s.owner) s.owner._slotAge += dt;
    }
  }

  /** Keep incumbents in place, then fill the holes with the remaining wants. */
  _assign(from, to, want) {
    const taken = new Set();
    for (let i = from; i < to; i++) this.slots[i].want = null;

    // pass 1 — incumbents stay put
    for (let i = from; i < to; i++) {
      const s = this.slots[i];
      if (s.owner && want.includes(s.owner)) { s.want = s.owner; taken.add(s.owner); }
    }
    // pass 2 — fill remaining slots
    let w = 0;
    for (let i = from; i < to; i++) {
      const s = this.slots[i];
      if (s.want) continue;
      while (w < want.length && taken.has(want[w])) w++;
      if (w < want.length) { s.want = want[w]; taken.add(want[w]); w++; }
    }
  }

  /**
   * Push practical state onto the GPU lights. Call right before rendering.
   * @param {number} [frame] engine.clock.frame — drives the shadow stagger.
   */
  apply(frame = 0) {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const l = s.light;
      const p = s.owner;
      if (!p || s.fade <= 0) {
        l.intensity = 0;
        if (s.shadowed) {
          // Keep rendering until the depth cube actually exists — a shadow slot
          // whose `shadow.map` is still null makes three bind the empty texture
          // to a samplerCubeShadow, which is a GL_INVALID_OPERATION every draw.
          l.shadow.autoUpdate = l.shadow.map === null;
          l.shadow.needsUpdate = l.shadow.map === null;
          l.distance = 0.5;
          s.shadowOwner = null;
        }
        if (p) p._live = 0;
        continue;
      }
      const k = s.fade;
      p._live = k;
      l.position.copy(p.position);
      l.color.copy(p.color);
      l.intensity = p.intensity * k;
      l.distance = p.radius;
      l.decay = 2;
      if (this.kind === 'spot') {
        l.angle = p.angle;
        l.penumbra = p.penumbra;
        l.target.position.copy(p.position).addScaledVector(p.direction, Math.max(2, p.radius * 0.8));
        l.target.updateMatrixWorld(true);
      }
      if (s.shadowed) {
        l.shadow.camera.near = Math.min(0.3, p.radius * 0.03);
        // Staggered rebuild — see `shadowPeriod`. `autoUpdate` off, one explicit
        // `needsUpdate` per period, so three skips the six cube faces entirely on
        // the off frames instead of rasterising them into a map nothing changed.
        const lit = l.intensity > 0.01;
        const fresh = s.shadowOwner !== p || l.shadow.map === null;
        // One depth texel of this light's own map, in world units. Flicker jitter
        // is 1-6 cm and a 19 m brazier's 512-map texel is 7.4 cm, so ordinary
        // guttering stays sub-texel and does not defeat the stagger; a torch that
        // is genuinely relocated does.
        const texel = (2 * p.radius) / Math.max(16, l.shadow.mapSize.x || 512);
        const moved = s.shadowPos === undefined
          ? true
          : l.position.distanceToSquared(s.shadowPos) > texel * texel;
        const due = ((frame + s.index) % this.shadowPeriod) === 0;
        const want = lit && (fresh || moved || due);
        l.shadow.autoUpdate = false;
        l.shadow.needsUpdate = want;
        if (want) {
          s.shadowOwner = p;
          s.shadowPos = (s.shadowPos ?? new THREE.Vector3()).copy(l.position);
        }
      }
      l.updateMatrixWorld(true);
    }
  }

  dispose() {
    for (const s of this.slots) {
      s.light.shadow?.dispose?.();
      s.light.parent?.remove(s.light);
      if (s.light.target?.parent) s.light.target.parent.remove(s.light.target);
    }
    this.slots.length = 0;
  }
}
const _byScoreDesc = (a, b) => b._score - a._score;

/* ------------------------------------------------------------------ */
/* ProbeVolume — coarse dynamic irradiance grid                         */
/* ------------------------------------------------------------------ */

/**
 * A cheap 3D irradiance grid over the play area. Every frame the CPU splats the
 * practicals into it (inverse-square, windowed by radius); the GPU samples it
 * trilinearly and adds it to `irradiance` before the Lambert BRDF, so stone
 * near a torch actually goes warm and the wall behind it stays cold.
 *
 * Stored as RGBA8 with a fixed decode scale so it filters natively everywhere
 * and the per-frame upload is a few kilobytes.
 */
export class ProbeVolume {
  constructor({ nx = 24, ny = 5, nz = 24, sizeX = 92, sizeY = 17, sizeZ = 92, scale = 4 } = {}) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.size = new THREE.Vector3(sizeX, sizeY, sizeZ);
    this.min = new THREE.Vector3();
    this.invSize = new THREE.Vector3(1 / sizeX, 1 / sizeY, 1 / sizeZ);
    this.scale = scale;                 // encoded value 1.0 == `scale` irradiance
    this.invScale = 255 / scale;
    this.cell = new THREE.Vector3(sizeX / (nx - 1), sizeY / (ny - 1), sizeZ / (nz - 1));

    // Shader-side mapping. Data point i lives at `min + i*cell`, but the
    // hardware sampler puts texel i's centre at (i+0.5)/n — so the GPU origin is
    // shifted back half a cell and the scale is 1/(cell*n), not 1/size. Getting
    // this wrong slides the whole bounce field half a cell off the lights.
    this.texMin = new THREE.Vector3();
    this.texInvSize = new THREE.Vector3(
      1 / (this.cell.x * nx),
      1 / (this.cell.y * ny),
      1 / (this.cell.z * nz)
    );

    this.data = new Uint8Array(nx * ny * nz * 4);
    this.texture = new THREE.Data3DTexture(this.data, nx, ny, nz);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this._f = new Float32Array(nx * ny * nz * 3);
    this._base = new THREE.Color(0, 0, 0);
  }

  /** Re-centre the grid on `focus`, snapped to whole cells so it never swims. */
  recenter(focus) {
    const cx = Math.round(focus.x / this.cell.x) * this.cell.x;
    const cz = Math.round(focus.z / this.cell.z) * this.cell.z;
    const cy = Math.round(focus.y / this.cell.y) * this.cell.y;
    this.min.set(cx - this.size.x * 0.5, cy - this.size.y * 0.28, cz - this.size.z * 0.5);
    this.texMin.set(
      this.min.x - this.cell.x * 0.5,
      this.min.y - this.cell.y * 0.5,
      this.min.z - this.cell.z * 0.5
    );
  }

  /** Clear to a base ambient bounce colour. */
  begin(r, g, b) {
    const f = this._f;
    for (let i = 0; i < f.length; i += 3) { f[i] = r; f[i + 1] = g; f[i + 2] = b; }
  }

  /**
   * Splat one source. Only cells inside the source radius are touched, so the
   * cost is proportional to lit volume, not grid size.
   */
  splat(pos, color, intensity, radius, weight) {
    if (intensity <= 0 || weight <= 0) return;
    const { nx, ny, nz, min, cell } = this;
    const r = radius;
    const i0 = Math.max(0, Math.floor((pos.x - r - min.x) / cell.x));
    const i1 = Math.min(nx - 1, Math.ceil((pos.x + r - min.x) / cell.x));
    const j0 = Math.max(0, Math.floor((pos.y - r - min.y) / cell.y));
    const j1 = Math.min(ny - 1, Math.ceil((pos.y + r - min.y) / cell.y));
    const k0 = Math.max(0, Math.floor((pos.z - r - min.z) / cell.z));
    const k1 = Math.min(nz - 1, Math.ceil((pos.z + r - min.z) / cell.z));
    if (i0 > i1 || j0 > j1 || k0 > k1) return;

    const cr = color.r * intensity * weight;
    const cg = color.g * intensity * weight;
    const cb = color.b * intensity * weight;
    const invR2 = 1 / (r * r);
    const f = this._f;

    for (let k = k0; k <= k1; k++) {
      const z = min.z + k * cell.z - pos.z;
      const z2 = z * z;
      for (let j = j0; j <= j1; j++) {
        const y = min.y + j * cell.y - pos.y;
        const y2 = y * y;
        const row = (k * ny + j) * nx;
        for (let i = i0; i <= i1; i++) {
          const x = min.x + i * cell.x - pos.x;
          const d2 = x * x + y2 + z2;
          if (d2 > r * r) continue;
          // inverse-square with a soft window at the cutoff, clamped near zero
          const w = 1 - d2 * invR2;
          const att = (w * w) / Math.max(d2, 1.15);
          const o = (row + i) * 3;
          f[o] += cr * att;
          f[o + 1] += cg * att;
          f[o + 2] += cb * att;
        }
      }
    }
  }

  /** Encode the float scratch buffer into the texture. */
  commit() {
    const f = this._f, d = this.data, s = this.invScale;
    for (let i = 0, o = 0; i < f.length; i += 3, o += 4) {
      const r = f[i] * s, g = f[i + 1] * s, b = f[i + 2] * s;
      d[o] = r > 255 ? 255 : r;
      d[o + 1] = g > 255 ? 255 : g;
      d[o + 2] = b > 255 ? 255 : b;
      d[o + 3] = 255;
    }
    this.texture.needsUpdate = true;
  }

  /** CPU-side trilinear query — for props/VFX that want the local bounce colour. */
  sample(pos, out = new THREE.Color()) {
    const { nx, ny, nz, min, cell } = this;
    const fx = clamp((pos.x - min.x) / cell.x, 0, nx - 1.001);
    const fy = clamp((pos.y - min.y) / cell.y, 0, ny - 1.001);
    const fz = clamp((pos.z - min.z) / cell.z, 0, nz - 1.001);
    const i = fx | 0, j = fy | 0, k = fz | 0;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const f = this._f;
    let r = 0, g = 0, b = 0;
    for (let dk = 0; dk < 2; dk++) {
      const wz = dk ? tz : 1 - tz;
      for (let dj = 0; dj < 2; dj++) {
        const wy = dj ? ty : 1 - ty;
        for (let di = 0; di < 2; di++) {
          const wx = di ? tx : 1 - tx;
          const o = ((Math.min(k + dk, nz - 1) * ny + Math.min(j + dj, ny - 1)) * nx + Math.min(i + di, nx - 1)) * 3;
          const w = wx * wy * wz;
          r += f[o] * w; g += f[o + 1] * w; b += f[o + 2] * w;
        }
      }
    }
    return out.setRGB(r, g, b);
  }

  dispose() { this.texture.dispose(); }
}

/* ------------------------------------------------------------------ */
/* scenario lighting presets                                            */
/* ------------------------------------------------------------------ */

/**
 * Per-biome art direction. Values are the *targets*; `Lighting` blends toward
 * them and layers time-of-day on top.
 *
 * Value structure discipline: ambient is always a hemisphere + IBL term, never
 * a flat fill, and interiors keep the sky term near black so torches carry the
 * whole image.
 *
 * ...with ONE structural exception, `wallFill`, documented on the interior
 * presets below. A hemisphere light is the wrong SHAPE for a room, and once the
 * fictional interior "skylight" stopped casting cascades there was nothing left
 * that could reach a vertical wall at all. See the comment on `crypt.wallFill`.
 */
export const BIOME_LIGHTING = {};

/*
 * COLOUR TEMPERATURE IS THE WHOLE JOB HERE.
 *
 * The captured interiors read as one warm brown hue edge to edge — floor, wall,
 * rubble and hero all the same orange. That is not a grade bug, it is a
 * *lighting* bug: every source in the room was between 1750 K and 2600 K, the
 * ambient fill was a warm-brown hemisphere, and the torch bounce was splatted
 * into the probe volume at nearly double strength. There was literally no cold
 * light in the scene, so there was nothing for the fire to contrast against.
 *
 * The fix, applied to every biome below:
 *   • the ambient/fill half of the rig is COLD and carries more of the frame —
 *     slate skylight, blue-grey hemisphere sky, ash (not umber) ground bounce,
 *     a colder and stronger rim;
 *   • the warm half is left to the PRACTICALS alone, and its indirect spill is
 *     cut hard (`bounce`, `probeIntensity`) so firelight stays a local pool
 *     instead of a global wash;
 *   • fog inherits the cold, because coloured fog is what separates the depth
 *     planes and a warm fog just re-tints everything the practicals already did.
 *
 * Read as: cold stone lit by fire, never brown stone in brown air.
 */
BIOME_LIGHTING.crypt = {
  sunless: true,
  // The cold key. It stands in for a collapsed vault open to a night sky: 10500 K
  // with a real cool bias so exposed rock reads as wet slate. It was 9500 K at
  // 0.95 with the saturation pulled down to 0.72, which is a *grey* key, not a
  // cold one — grey plus firelight is sepia.
  //
  // ELEVATION AND AZIMUTH ARE A REDISTRIBUTION, NOT A BRIGHTNESS CHANGE. See
  // `Lighting._aimUnshadowedKey` for the bug that hid this: the interior key was
  // never actually aimed, so it travelled straight down and handed its whole
  // 1.22 to up-facing floor while every near-vertical surface got dot(N, L) = 0.
  // Once it IS aimed, the authored azimuth 205 turns out to be a pure BACKLIGHT
  // for this game's fixed isometric camera (which sits at +z looking toward -z),
  // so camera-facing faces stayed at zero anyway. Measured on the frozen `boss`
  // frame, sweeping azimuth with the aim fixed: 208 gave the rock 7.0/255, 270
  // gave 8.7, 330 gave 11.2 and 0 gave 11.3. 330 is the peak that still keeps
  // the key ~30 degrees off the camera axis, so faces have a lit side and a dark
  // side instead of the formless flat-frontal read that azimuth 0 would give.
  //
  // Elevation then trades floor for wall: a key at elevation E gives an up-facing
  // floor sin(E) and a vertical wall at most cos(E). At 64 degrees that split is
  // 0.90 / 0.44 — nine tenths of the key into the one surface that was never the
  // problem. Dropping to 42 degrees makes it 0.67 / 0.74, and the intensity is
  // raised in exactly the ratio that holds the floor still:
  //     1.22 * sin(64) = 1.0965  ->  1.64 * sin(42) = 1.0965.
  // So the floor keeps the value the art direction chose for it to four figures,
  // and a vertical face goes from 0 to 1.64 * cos(42) = 1.22.
  skylight: { kelvin: 10500, intensity: 1.64, elevation: 42, azimuth: 330, coolBias: 0.32, saturation: 0.95 },
  // Ground bounce was 0x17100b — warm umber. Inside a crypt the floor bounce is
  // whatever the floor is, and the floor is cold damp stone.
  hemi: { sky: 0x33506f, ground: 0x14171d, intensity: 0.56 },
  env: { zenith: 0x101a26, horizon: 0x1a2129, ground: 0x090b0e, haze: 0.35, sunStrength: 0 },
  envIntensity: 0.42,
  /* ELEVATION IS THE READ. `rim.elevation` feeds both the scene-wide back fill and
   * the per-material CHARACTER rim in Lighting, and for a figure standing upright
   * under a camera pitched ~55 degrees down, a high rim lands on the tops of the
   * shoulders (a few pixels) while a grazing one runs down the whole torso edge.
   * 27 -> 20 degrees roughly doubles how much of a 1.85 m silhouette the term can
   * reach. `intensity` is still the full authored value — it sets the character
   * rim's gain and hue — but the scene-wide light it drives is capped hard at
   * SCENE_RIM_CEIL, because a back light that also hits the floor separates
   * nothing. */
  rim: { color: 0x74a3d9, intensity: 0.88, elevation: 20, azimuth: 152 },
  // Warm indirect, cut. At 1.05/0.075 every torch was smearing amber irradiance
  // across the whole probe grid, which is the single largest contributor to the
  // monochrome read: the *air* went orange, not just the lit stone.
  probeIntensity: 0.70,
  bounce: 0.040,
  /* WALL BOUNCE — the term that makes an interior's VERTICAL surfaces exist.
   *
   * A HemisphereLight is an open-sky model: its irradiance is maximal at
   * normal.y = +1 and falls to the ground colour at normal.y = -1, so a wall
   * gets the 50/50 midpoint of sky and ground. That is right outdoors and
   * exactly backwards indoors, where a wall's indirect light comes from the
   * OTHER WALLS and the floor, i.e. horizontally, and the one direction that
   * sees nothing at all is straight up into a ceiling.
   *
   * It only became visible once the sunless "skylight" preset above stopped
   * casting shadows. Measured on the frozen `boss` frame, the 6.2 m
   * `dungeon:rock` mass at the arena centre received, on a camera-facing
   * vertical face:
   *   • skylight key .............. 0.000  (elevation 57 deg from azimuth 208,
   *                                 so L is (-0.26, 0.84, -0.48) and every
   *                                 camera-facing vertical normal has
   *                                 dot(N, L) <= 0 — it is fully backlit),
   *   • scene rim ................. 0.000  (driver sits at z = -35.8, behind
   *                                 the arena, so it is backlit too),
   *   • hemisphere ................ 0.0068 irradiance luma (0.40 x the 50/50
   *                                 mix of sky 0.0273 and ground 0.0069),
   *   • env IBL ................... 0.0078 (0.30 x horizon 0x3a2620),
   *   • probe grid ................ 0.061,
   *   ------------------------------------
   *   total ....................... 0.076 irradiance luma, which against the
   *   material's ~0.16 albedo is 0.0038 of reflected radiance. The rock
   *   measured 0.0094 mean scene-linear luma, and 0.0034 of that — 38 % — was
   *   Sky's atmospheric in-scatter. The SILHOUETTE WAS MADE OF FOG.
   *
   * So this is a genuine missing indirect term, not a grade problem, and the
   * honest fix is to add the shape the rig was missing rather than to lift
   * everything. `Lighting._injectProbe` weights it by (1 - |world normal.y|):
   * full value on a vertical face, ZERO on floors and ceilings. That matters
   * for two reasons — the arena floor is most of the frame and is already
   * carried by the key, so it must not move; and down-facing normals stay at
   * true black, which is what keeps the histogram bottom-weighted instead of
   * milky. It is added to `irradiance` before `RE_IndirectDiffuse`, so aoMap
   * still multiplies it and the term lands as SURFACE (crevices stay dark)
   * rather than as a flat wash.
   *
   * Colour is the cold half of the rig, per the note above: damp slate, in the
   * same family as `hemi.sky`, so the torches keep sole ownership of warmth.
   *
   * Intensity is small ON PURPOSE. Re-aiming the key is what actually fixed the
   * defect; this term only has to catch the faces the key cannot reach, which at
   * azimuth 330 are the ones pointing toward -z and +x. Measured, it moves the
   * rock about 1/255 and takes another half point off the sub-5/255 fraction —
   * worth having because those are precisely the void pixels, but it is not
   * carrying the frame and must not try to. 0.85 x the colour's linear luma of
   * 0.355 is 0.30 of irradiance on a fully vertical face, roughly 28 % of what
   * the re-aimed key delivers there, which is a believable wall-bounce ratio for
   * dry stone and nowhere near enough to lift a black. */
  wallFill: { color: 0x9fb0c4, intensity: 0.85 },
  maxFar: 66,
  fog: { color: 0x0a0f16, near: 11, far: 64 },
};
BIOME_LIGHTING.hell = {
  sunless: true,
  // A hell arena has no sun, but it does have a sky on fire. Leaving this null
  // gave the whole biome zero key light and zero cascades: the boss frame came
  // out 78% pure black, lit only by a handful of point practicals.
  //
  // It must not be *hellfire coloured*, though. At 2050 K with saturation 1.15
  // the key painted the entire arena — floor, walls, bones — the same orange as
  // the braziers, and the frame resolved as flat sepia. The rock in a hell arena
  // is basalt: the key is a desaturated warm-grey, the ember practicals and the
  // violet rim are the only saturated things in frame.
  // At 3100 K / 1.20 the key still painted the whole arena floor the same warm
  // tan and the frame came back with 0.35 % of its pixels below 5/255 — a milky
  // sepia field with no black in it anywhere, which is the "washed-out grey
  // frame" instant fail wearing an orange coat. Basalt lit from a burning sky
  // is a COOL grey with warm rim: 3900 K, cooled, desaturated, and dimmer, so
  // the ember practicals are what actually carry the warmth.
  // Re-aimed on the same reasoning as `crypt.skylight` above — read that comment
  // for the derivation. The floor-preserving intensity for this preset is
  //     0.88 * sin(57) = 0.7380  ->  1.32 * sin(34) = 0.7381,
  // and a vertical face goes from 0 to 1.32 * cos(34) = 1.09. Measured on the
  // frozen `boss` frame the two rock masses went 7.0/255 -> 20.6/255 with the
  // fraction of their pixels below 5/255 falling from 24.2 % to 5.0 %, while the
  // scene-linear frame mean moved 0.0317 -> 0.0344 (+8 %). The braziers still
  // own every warm highlight; this only decides which SURFACES the cold key
  // lands on, not how much of it there is.
  skylight: { kelvin: 3900, intensity: 1.32, elevation: 34, azimuth: 330, coolBias: 0.24, saturation: 0.44 },
  hemi: { sky: 0x342a3d, ground: 0x141318, intensity: 0.40 },
  env: { zenith: 0x1b1622, horizon: 0x3a2620, ground: 0x100e12, haze: 0.55, sunStrength: 0 },
  envIntensity: 0.30,
  // The one saturated accent for this scene. Violet against ember is the whole
  // colour story of the arena.
  rim: { color: 0x7a52d8, intensity: 0.92, elevation: 18, azimuth: 158 },
  probeIntensity: 0.78,
  bounce: 0.042,
  /* Wall bounce — see the long note on `crypt.wallFill` for the derivation and
   * the measured before/after; the hell arena is where the defect was found.
   *
   * Slate-VIOLET rather than the crypt's blue-grey: the only two saturated
   * things allowed in this frame are the ember practicals and the 0x7a52d8
   * rim, so the fill leans toward the rim's hue and lets the braziers stay the
   * sole warm source. Basalt bounced off basalt is nearly neutral anyway. */
  wallFill: { color: 0xa79cb8, intensity: 0.85 },
  maxFar: 74,
  fog: { color: 0x131019, near: 13, far: 78 },
};
BIOME_LIGHTING.town = {
  sunless: false,
  // Dusk air is BLUE. The brazier gold has to be the only warm thing in the
  // frame or the whole hub reads as one pink-brown field, which is exactly what
  // it measured at sky 0x35476a / ground 0x241a12 / intensity 0.46.
  // The hub metered so far under the auto-exposure key that the gain pinned at
  // its ceiling and the frame still came back at mean 0.099 with a third of it
  // at pure black. Shadow detail is cheaper and cleaner bought at the source
  // than by multiplying a dark plate in post, so the cold half of the rig gets
  // more authority: dusk skylight on the cobbles between the braziers.
  hemi: { sky: 0x475b6d, ground: 0x1f2126, intensity: 0.86 },
  // Blue-VIOLET skylight over warm slate albedo multiplies out as magenta, and
  // the hub's up-facing roof planes (which see only the sky term) came back
  // lavender. A dusk sky is cyan-leaning: keep green up near blue.
  env: { zenith: 0x2a3d4c, horizon: 0x6d5038, ground: 0x17181d, haze: 0.6, sunStrength: 1.6 },
  envIntensity: 0.70,
  rim: { color: 0x8fb6e6, intensity: 0.68, elevation: 19, azimuth: 148 },
  probeIntensity: 0.54,
  bounce: 0.028,
  maxFar: 108,
  fog: { color: 0x18202e, near: 24, far: 138 },
};
BIOME_LIGHTING.moor = {
  sunless: false,
  // COLD IS NOT THE SAME THING AS BLUE. The moor measured a mean RGB of
  // 0.33/0.36/0.41 — every pixel in the frame carried the same 1.25:1 blue
  // over red, which is a colour *cast*, not an art direction. The sky term was
  // 0x8296b0 (1.38:1) and the fog 0x3d4856 (1.41:1), so the cast was baked into
  // both halves of the ambient and then again into the aerial perspective.
  // Wet slate is barely blue at all; what makes it read cold is that the only
  // warm thing in frame is the campfire.
  hemi: { sky: 0x8b96a4, ground: 0x27282b, intensity: 0.66 },
  env: { zenith: 0x36414f, horizon: 0x717884, ground: 0x202225, haze: 0.8, sunStrength: 0.5 },
  envIntensity: 0.70,
  rim: { color: 0xb4c1cd, intensity: 0.40, elevation: 18, azimuth: 150 },
  probeIntensity: 0.52,
  bounce: 0.032,
  maxFar: 124,
  fog: { color: 0x434a53, near: 28, far: 168 },
};

/**
 * Resolve a full lighting description for a scenario.
 * @param {string} name scenario id
 * @param {object} cfg  the Scenarios.js entry
 */
export function resolveLighting(name, cfg = {}) {
  const env = cfg.env ?? {};
  const biome = BIOME_LIGHTING[env.biome] ?? BIOME_LIGHTING.crypt;
  const tod = env.timeOfDay ?? 0;
  const overcast = env.weather === 'overcast' || env.weather === 'rain' || env.weather === 'storm';

  const out = {
    name,
    biome: env.biome ?? 'crypt',
    interior: !!env.interior,
    hemi: { ...biome.hemi },
    env: { ...biome.env },
    envIntensity: biome.envIntensity,
    rim: { ...biome.rim },
    probeIntensity: biome.probeIntensity,
    bounce: biome.bounce,
    /* Interior-only, and deliberately gated on BOTH flags. `sunless` says the
     * biome has no real key, `interior` says the scenario is actually enclosed;
     * an exterior scenario that happened to borrow an interior biome preset
     * would otherwise get a wall fill it does not need, because outdoors a
     * vertical face genuinely does see the sky and the env IBL already pays
     * for it (envIntensity 0.70 outdoors versus 0.30 in hell). Null means the
     * uniform stays black and the term costs one mul in the shader. */
    wallFill: (biome.sunless && env.interior && biome.wallFill) ? { ...biome.wallFill } : null,
    maxFar: biome.maxFar,
    fog: biome.fog ? { ...biome.fog } : null,
    sun: null,
  };

  if (biome.sunless) {
    // Interiors: a single cold shaft from above stands in for "outside", giving
    // the floor a cool counterpoint to fire.
    if (biome.skylight) {
      const s = biome.skylight;
      out.sun = {
        elevation: s.elevation,
        azimuth: s.azimuth,
        intensity: s.intensity,
        kelvin: s.kelvin,
        coolBias: s.coolBias ?? 0,
        saturation: s.saturation ?? 1,
        /* COLOUR ONLY, NEVER SHADOW. This key is a fiction — there is no sky
         * over a crypt — but the ceiling above it is real geometry at ~7.3 m.
         * Casting cascades from it projected metres-long hard-edged black
         * wedges across the play area that buried the hero and every enemy.
         * Interiors are shadowed by their PRACTICALS, which are motivated by
         * a visible fixture and sit inside the room with the action.
         * Turning this off also returns four directional shadow samplers to
         * every lit material. Do not set this true. */
        shadow: false,
        // A ceiling shaft is placed by the level, not by the solar ephemeris —
        // Sky must not drag it around.
        authored: true,
      };
    }
    return out;
  }

  // ---- exterior: drive the key light from time of day ----
  const rawElev = Math.sin((tod - 0.25) * Math.PI * 2) * 62;   // degrees
  const azimuth = (tod * 360 - 96 + 360) % 360;

  if (rawElev > 1.5) {
    // Daylight. Low sun = warm and weak, high sun = neutral and strong.
    const h = clamp01(rawElev / 55);
    const kelvin = lerp(KELVIN.duskSun + 300, KELVIN.daySun, Math.pow(h, 0.6));
    let intensity = lerp(0.95, 3.1, Math.pow(h, 0.75));
    let sat = 1;
    // Overcast is not the same as *unlit*. At 0.42 the key was weaker than the
    // hemisphere it sat against, so the moor had no directional component at all
    // — every surface received the same irradiance from every direction and the
    // frame measured a standard deviation of 0.14 with 0.5 % black: the classic
    // flat grey wash. Even under cloud the sky has a bright patch where the sun
    // is, and that patch is what gives rock a lit face and a shadow side.
    if (overcast) { intensity *= 0.62; sat = 0.45; }
    out.sun = {
      elevation: Math.max(4, rawElev),
      azimuth,
      intensity,
      kelvin: overcast ? lerp(kelvin, KELVIN.overcast, 0.75) : kelvin,
      coolBias: overcast ? 0.12 : 0,
      saturation: sat,
      shadow: true,
    };
    if (overcast) {
      out.hemi.intensity *= 1.02;
      out.envIntensity *= 0.95;
      out.rim.intensity *= 0.8;
    }
  } else if (rawElev > -20) {
    // Civil twilight — the D4 "town at dusk" look: a low, dirty, orange key.
    // The window is deliberately generous (down to -20 degrees) because the
    // town scenarios sit at timeOfDay 0.78 and 0.80 and must not fall on
    // opposite sides of a hard dusk/night boundary.
    // The angle is the look here (long raking shadows across the cobbles), so
    // this key is art-directed and Sky does not get to move it. Anything below
    // ~8 degrees is useless in an isometric view: cos(incidence) on the ground
    // collapses and the floor goes unlit even at high intensity.
    const t = clamp01((rawElev + 20) / 21.5);
    out.sun = {
      elevation: lerp(9, 16, t),
      azimuth,
      intensity: lerp(1.7, 2.8, t),
      // Saturation was 1.18 at 2180-2600 K: a *pushed* orange key. Combined with
      // warm ground albedo it made every pixel of the hub the same pink-brown.
      // A real low sun is warm but not saturated — the colour contrast comes from
      // the blue sky fill it is sitting against, not from cranking the key.
      kelvin: lerp(2320, 2760, t),
      coolBias: 0,
      saturation: 0.86,
      shadow: true,
      authored: true,
    };
    out.hemi.intensity *= 0.85;
    out.envIntensity *= 0.8;
    out.rim.intensity *= 1.15;
  } else {
    // Night — moonlight. Physically ~4100 K, rendered cool.
    //
    // Moonlight is a COLD, DIM KEY WITH DEEP SHADOW. It is not a blue filter.
    // Measured at intensity 1.55 / coolBias 0.62 / hemi 0.44 the frame came back
    // mean 0.25 with 4.4 % black and a per-pixel saturation of 0.517: a heavy
    // uniform blue wash with compressed midtones, because the key was strong
    // enough to light everything and blue enough to tint everything it lit.
    // Two thirds of the level and a much smaller cool bias buys the shadow back,
    // and the *lit* stone reads silver rather than indigo.
    // DIM AND COLD IS NOT THE SAME THING AS ABSENT. At intensity 0.98 with a
    // 0.29 hemisphere the moor came back with 77 % of its pixels under 5/255 and
    // a p95 of 0.22: the level was not dark, it was gone, and the only saturation
    // measurement left in the frame came from near-black pixels with a blue tint
    // (a shadow at (2,4,9)/255 measures 78 % saturated). Post cannot recover
    // information that was never rendered.
    //
    // So the key roughly doubles — moonlight has to actually strike the rock and
    // leave a silver highlight on the up-facing faces — the hemisphere nearly
    // doubles so the shadow side reads as slate rather than as a hole, and the
    // cool bias and saturation both come DOWN, because what makes the frame read
    // as night is the low level and the single warm campfire, not a blue filter.
    out.sun = {
      elevation: 44,
      azimuth: (azimuth + 168) % 360,
      intensity: overcast ? 2.60 : 3.10,
      kelvin: KELVIN.moon,
      coolBias: 0.26,
      saturation: 0.46,
      shadow: true,
    };
    // The hemisphere stays low ON PURPOSE. Value structure at night comes from
    // the RATIO between the moon and the fill, not from the absolute level: a
    // strong key against a weak fill gives every rock a lit face and a dark side
    // (standard deviation, shadow detail, a silhouette for the hero). Raising
    // both together just produces a brighter version of the same flat field.
    out.hemi = { sky: 0x212b39, ground: 0x111216, intensity: overcast ? 0.34 : 0.44 };
    out.env = { zenith: 0x121a2a, horizon: 0x28313f, ground: 0x0d0e12, haze: 0.5, sunStrength: 0.12 };
    out.envIntensity = 0.46;
    out.rim = { color: 0xbccfe4, intensity: 0.58, elevation: 21, azimuth: 150 };
    out.probeIntensity = 0.62;
    out.fog = { color: 0x141a24, near: 18, far: 120 };
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* default practical layouts                                            */
/* ------------------------------------------------------------------ */

/**
 * If nothing else in the game has placed practical lights by the time a
 * scenario settles, Lighting puts down a scenario-appropriate set so the frame
 * is never an unlit grey box. Deterministic from a scenario-seeded PRNG.
 */
export function defaultPracticals(name, cfg, rand) {
  const biome = cfg?.env?.biome ?? 'crypt';
  const out = [];
  const ring = (n, r, y, fn) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand.range(-0.09, 0.09);
      out.push(fn(Math.cos(a) * r, y, Math.sin(a) * r, i, a));
    }
  };

  if (biome === 'crypt') {
    ring(8, 11.4, 2.72, (x, y, z) => ({
      kind: 'point', type: 'torch', position: [x, y + rand.range(-0.12, 0.12), z],
      kelvin: KELVIN.torch + rand.range(-70, 90), intensity: rand.range(13, 17),
      radius: rand.range(11.5, 14), flicker: 1, glow: 0.9,
    }));
    ring(2, 5.6, 0.95, (x, y, z) => ({
      kind: 'point', type: 'brazier', position: [x, y, z],
      kelvin: KELVIN.brazier + rand.range(-60, 60), intensity: rand.range(20, 25),
      radius: rand.range(14, 17), flicker: 0.85, priority: 1.4, glow: 1.3,
    }));
    // Never a shadow caster — see the note on `TIER` in `Lighting.js`. Its cone
    // and the volumetric pass carry the look.
    out.push({
      kind: 'spot', type: 'shaft', position: [-1.2, 9.4, -2.6], direction: [0.07, -1, 0.14],
      kelvin: 8600, coolBias: 0.2, intensity: 62, radius: 22, angle: 0.30, penumbra: 0.82,
      flicker: 0.25, priority: 1.6, shadow: false,
    });
  } else if (biome === 'hell') {
    ring(6, 13.6, 1.35, (x, y, z) => ({
      kind: 'point', type: 'hellfire', position: [x, y, z],
      kelvin: KELVIN.hellfire + rand.range(-120, 120), saturation: 1.4,
      intensity: rand.range(24, 32), radius: rand.range(16, 20), flicker: 1, priority: 1.2, glow: 1.5,
    }));
    ring(3, 21, 0.22, (x, y, z) => ({
      kind: 'point', type: 'lava', position: [x, y, z],
      kelvin: KELVIN.lava, saturation: 1.3, intensity: rand.range(30, 42),
      radius: rand.range(24, 30), flicker: 0.55, priority: 0.75, shadow: false,
    }));
    out.push({
      kind: 'point', type: 'magic', position: [0, 3.4, -4], color: 0x7b3cff,
      intensity: 16, radius: 20, flicker: 0.7, priority: 1.1, shadow: false, glow: 1.1,
    });
  } else if (biome === 'town') {
    ring(4, 9.2, 1.55, (x, y, z) => ({
      kind: 'point', type: 'brazier', position: [x, y, z],
      kelvin: KELVIN.brazier + rand.range(-80, 80), intensity: rand.range(17, 23),
      radius: rand.range(13, 16), flicker: 0.9, glow: 1.2,
    }));
    ring(3, 15.5, 2.9, (x, y, z) => ({
      kind: 'point', type: 'candle', position: [x, y, z],
      kelvin: KELVIN.candle + rand.range(-50, 90), intensity: rand.range(7, 10),
      radius: rand.range(8, 11), flicker: 1, priority: 0.7, shadow: false, glow: 0.6,
    }));
  } else {
    // moor
    const night = (cfg?.env?.timeOfDay ?? 0.5) < 0.16 || (cfg?.env?.timeOfDay ?? 0.5) > 0.9;
    if (night) {
      // A campfire on a dark moor is the brightest thing for 40 m, so it does not
      // need 22 cd to read — at that level it blew a white ball across 3 m of
      // ground and took its own fixture with it. 13 cd still owns the frame.
      out.push({
        kind: 'point', type: 'campfire', position: [-6.2, 0.62, 3.4],
        kelvin: KELVIN.brazier, intensity: 13, radius: 15, flicker: 1, priority: 1.5, glow: 1.15,
      });
      out.push({
        kind: 'point', type: 'campfire', position: [7.8, 0.55, -5.6],
        kelvin: KELVIN.torch + 60, intensity: 9, radius: 12.5, flicker: 1, priority: 1.1, glow: 0.85,
      });
      ring(3, 17, 1.1, (x, y, z) => ({
        kind: 'point', type: 'magic', position: [x, y + rand.range(0, 0.7), z],
        color: 0x63ffb4, intensity: rand.range(3, 5), radius: rand.range(8, 11),
        flicker: 1, priority: 0.5, shadow: false, glow: 0.6,
      }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* procedural IBL source                                                */
/* ------------------------------------------------------------------ */

const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Build a small equirectangular sky as a linear float texture. Fed to
 * PMREMGenerator so `scene.environment` is a real image-based light with
 * horizon/zenith/ground structure — never a flat ambient term.
 */
export function buildSkyEquirect(desc, sunDir, sunColor, w = 128, h = 64) {
  const data = new Float32Array(w * h * 4);
  _c0.set(desc.zenith ?? 0x101822);
  _c1.set(desc.horizon ?? 0x2a2c30);
  _c2.set(desc.ground ?? 0x0a0806);
  const haze = desc.haze ?? 0.5;
  const sunStrength = desc.sunStrength ?? 0;

  const sx = sunDir ? -sunDir.x : 0;
  const sy = sunDir ? -sunDir.y : 1;
  const sz = sunDir ? -sunDir.z : 0;

  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;           // 0 = up
    const cy = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w) * Math.PI * 2 - Math.PI;
      const dx = sinT * Math.sin(phi);
      const dz = sinT * Math.cos(phi);

      let r, g, b;
      if (cy >= 0) {
        // sky: zenith -> horizon with a haze-controlled falloff
        const t = Math.pow(1 - cy, lerp(2.6, 1.1, haze));
        r = lerp(_c0.r, _c1.r, t);
        g = lerp(_c0.g, _c1.g, t);
        b = lerp(_c0.b, _c1.b, t);
      } else {
        // ground bounce: horizon -> dark earth
        const t = Math.pow(-cy, 0.55);
        r = lerp(_c1.r * 0.55, _c2.r, t);
        g = lerp(_c1.g * 0.55, _c2.g, t);
        b = lerp(_c1.b * 0.55, _c2.b, t);
      }

      if (sunStrength > 0 && sunColor) {
        const d = dx * sx + cy * sy + dz * sz;
        if (d > 0) {
          const disc = Math.pow(clamp01(d), 900) * 42;
          const bloom = Math.pow(clamp01(d), 6) * 0.55 + Math.pow(clamp01(d), 1.6) * 0.16;
          const k = (disc + bloom) * sunStrength;
          r += sunColor.r * k;
          g += sunColor.g * k;
          b += sunColor.b * k;
        }
      }

      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 1;
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* emissive stand-in for auto-spawned practicals                        */
/* ------------------------------------------------------------------ */

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const N = 64;
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N - 0.5;
      const v = (y + 0.5) / N - 0.5;
      const r = Math.sqrt(u * u + v * v) * 2;
      const a = Math.pow(clamp01(1 - r), 2.6);
      const core = Math.pow(clamp01(1 - r * 2.3), 3.0);
      const o = (y * N + x) * 4;
      d[o] = 255; d[o + 1] = 255; d[o + 2] = 255;
      d[o + 3] = Math.min(255, (a * 190 + core * 120)) | 0;
    }
  }
  _glowTex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  _glowTex.minFilter = THREE.LinearFilter;
  _glowTex.magFilter = THREE.LinearFilter;
  _glowTex.needsUpdate = true;
  return _glowTex;
}

/**
 * A tiny emitter (hot core + additive halo) so an auto-spawned practical has a
 * visible source and something for the bloom pass to grab. Values go above 1.0
 * deliberately — that is what makes bloom read as *fire* and not as haze.
 */
export class PracticalVisual {
  constructor(scale = 1) {
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    this.scale = scale;
    const tex = glowTexture();

    // Wide, soft, saturated halo — this is the part that reads as heat.
    this.haloMat = new THREE.SpriteMaterial({
      map: tex, color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: true, fog: true, opacity: 0.7,
    });
    this.halo = new THREE.Sprite(this.haloMat);
    this.halo.scale.setScalar(0.95 * scale);
    this.halo.renderOrder = 3;
    this.group.add(this.halo);

    // Tight hot core, deliberately above 1.0 so a bloom pass has something to
    // grab — but tinted, never a white pixel.
    this.coreMat = new THREE.SpriteMaterial({
      map: tex, color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: true, fog: false, opacity: 0.95,
    });
    this.core = new THREE.Sprite(this.coreMat);
    this.core.scale.setScalar(0.30 * scale);
    this.core.renderOrder = 4;
    this.group.add(this.core);
  }

  /**
   * Gains are deliberately low.
   *
   * At the original 1.7-3.2x core gain a 2000 K practical resolved to roughly
   * (3.2, 1.7, 0.5): every channel over the exposed white point, so the core
   * clipped to pure white and the bloom pass turned each brazier into a
   * ~4 m white disc — the "lens bokeh, not light" failure. Now only the RED
   * channel crosses the bloom threshold (1.32), so the glow keeps the fire's hue
   * and stays the size of the fixture. The halo is a heat haze, not a second
   * light source: it must never read as a camera-facing card, so it is small,
   * dim, and well under 1.0.
   */
  sync(practical, f) {
    this.group.position.copy(practical.position);
    const b = clamp01(practical.intensity / Math.max(1e-3, practical.baseIntensity));
    // Gains cut again (core was 0.62 + 0.40b, halo 0.16 + 0.20b). Two additive
    // sprites at those levels put GREEN over the exposed white point as well as
    // red, so the core desaturated to white on the way through the tonemap and
    // every flame clipped to a white disc. At 0.44 + 0.26b only the red channel
    // of a 2000 K source crosses 1.0: the core stays hot AND keeps its hue, and
    // the bloom pre-filter clamp keeps the halo the size of the fixture.
    this.coreMat.color.copy(practical.color).multiplyScalar(0.44 + 0.26 * b);
    this.haloMat.color.copy(practical.color).multiplyScalar(0.11 + 0.13 * b);
    this.haloMat.opacity = 0.16 + 0.12 * b;
    // The halo must stay SMALLER than the fixture it belongs to. At 1.35 m it was
    // wider than a 0.55 m brazier bowl, so from the boss camera every practical
    // resolved as a white ball with no visible source — the exact instant fail
    // KNOWN_ISSUES calls out. Bowl, coals and flame now read; the glow just warms
    // the air immediately around them.
    this.halo.scale.setScalar(0.62 * this.scale * (0.84 + 0.32 * b));
    this.core.scale.setScalar(0.22 * this.scale * (0.72 + 0.5 * f.hot));
  }

  dispose() {
    this.coreMat.dispose();
    this.haloMat.dispose();
    this.group.parent?.remove(this.group);
  }
}
