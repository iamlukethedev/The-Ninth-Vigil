import * as THREE from 'three';
import { SHAPE, ALIGN } from './Sprites.js';

/**
 * THE NINTH VIGIL — layered effect recipes.
 *
 * Every entry here is a *stack*, never a sprite. The house rule, taken straight
 * off the rubric: an effect is not finished until it has a bright core, a soft
 * glow that is wider and dimmer than the core, particulate that carries
 * direction (sparks / debris / droplets), something slow and dark to give it
 * mass (smoke, dust, mist), a ground read where it touches the floor, and a
 * light so the world reacts. Most of these also get a distortion or a screen
 * pulse when they are big enough to earn one.
 *
 * Emissive discipline: only flame, magic and lightning *cores* are written
 * above 1.0. Dust, debris, blood, smoke and rime all stay under it, so bloom
 * stays a tight highlight on the things that are actually hot.
 *
 * Every recipe reads its randomness from `v.rnd`, which is re-seeded
 * deterministically per scenario, and its clock from `v.now`.
 */

/* --------------------------------------------------------------- palette */

/**
 * Desaturated cold base, warm firelight punctuation, one saturated accent per
 * element. Nothing here is a pure hue and nothing is a primary — a rainbow
 * palette is an instant fail, so the greens sit toward teal, the blues toward
 * slate, and the reds toward oxide.
 */
export const PALETTE = {
  hot: new THREE.Color(0xfff3d8),
  spark: new THREE.Color(0xffb45c),
  ember: new THREE.Color(0xff7a24),
  emberDim: new THREE.Color(0x4d1704),
  flameCore: new THREE.Color(0xfff5e6),
  flameMid: new THREE.Color(0xffb03a),
  flameOuter: new THREE.Color(0xd44a10),
  smokeLit: new THREE.Color(0x3b352e),
  smokeDark: new THREE.Color(0x0d0c0b),
  dust: new THREE.Color(0x4a4238),
  dustDark: new THREE.Color(0x15120e),
  stone: new THREE.Color(0x59524a),
  stoneDark: new THREE.Color(0x1d1a17),
  blood: new THREE.Color(0x82101a),
  bloodDark: new THREE.Color(0x33070c),
  bloodMist: new THREE.Color(0x5e0d14),
  frost: new THREE.Color(0xd6f0ff),
  frostMid: new THREE.Color(0x74b6e6),
  frostDeep: new THREE.Color(0x22496e),
  arc: new THREE.Color(0xeaf2ff),
  arcMid: new THREE.Color(0x8fb6ff),
  arcDeep: new THREE.Color(0x2a3f80),
  necro: new THREE.Color(0x8dfab0),
  necroMid: new THREE.Color(0x2f9a5c),
  necroDark: new THREE.Color(0x0c2a1c),
  arcane: new THREE.Color(0xd7b4ff),
  arcaneMid: new THREE.Color(0x8a4fd6),
  gold: new THREE.Color(0xffd98a),
  goldDeep: new THREE.Color(0x8a5a12),
  ash: new THREE.Color(0x2a2724),
};

const P = PALETTE;

/* ------------------------------------------------------------- helpers */

const TAU = Math.PI * 2;
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _arc = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

/** Orthonormal basis around `n` (already normalised) into _b1/_b2. */
function basis(n) {
  if (Math.abs(n.y) < 0.92) _b1.set(0, 1, 0).cross(n).normalize();
  else _b1.set(1, 0, 0).cross(n).normalize();
  _b2.copy(n).cross(_b1).normalize();
}

/**
 * Random direction inside a cone of half-angle `spread` around `n`.
 * Writes into (out.x,out.y,out.z). No allocation.
 */
function cone(rnd, n, spread, out) {
  basis(n);
  const cosMax = Math.cos(spread);
  const c = 1 - rnd() * (1 - cosMax);
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const a = rnd() * TAU;
  out.x = n.x * c + (_b1.x * Math.cos(a) + _b2.x * Math.sin(a)) * s;
  out.y = n.y * c + (_b1.y * Math.cos(a) + _b2.y * Math.sin(a)) * s;
  out.z = n.z * c + (_b1.z * Math.cos(a) + _b2.z * Math.sin(a)) * s;
  return out;
}

/** Ballistic landing time for a launch at vy from height h above the floor. */
function fallTime(vy, h, g) {
  const disc = vy * vy + 2 * g * Math.max(h, 0);
  if (disc <= 0) return 0;
  return (vy + Math.sqrt(disc)) / g;
}

/* ================================================================== *
 *  1 — MELEE IMPACT
 *  arc smear along the swing · spark fan in the blade plane · chips ·
 *  low dust skirt · brief practical light
 *
 *  ROUND-4 REWRITE. The previous version was a radial burst: a 2.4-linear
 *  white GLOW disc at the contact point with a second, wider GLOW halo behind
 *  it. Two problems, both instant fails.
 *
 *   1. Radiance. Nothing is tonemapped at write time in this pipeline (three
 *      disables the tonemap chunk when a render target is bound), so 2.4 linear
 *      became 2.4 x the exposure gain at the tonemapper — 4.5 in `dungeon`, 6.5
 *      in `boss` — and ACES pins every channel at 1.0 past about 3. The core
 *      resolved as a flat #FFFFFF plateau with no hue and no falloff.
 *   2. Shape. A camera-facing disc centred on the contact point is centred on
 *      the *player* when the player is the one swinging, at a camera distance
 *      where the contact point is ~30 px from the hero's chest. Whatever its
 *      size, a radial burst there erases the silhouette.
 *
 *  A blade does not detonate. It sweeps, and the flash is a smear along the
 *  path with the sparks skittering off in the plane of the swing. So the core
 *  is now velocity-aligned along the arc tangent (the vertex shader stretches
 *  the quad along screen-space velocity, which is what makes it read as motion
 *  rather than as a billboard), pushed to the FAR side of contact along the hit
 *  normal so it lands on the thing that was hit, kept under 0.30 m of screen
 *  height so it physically cannot cover a 1.85 m hero, and given a 0.06-0.10 s
 *  life so it is a beat, not a cloud. Peak radiance is authored just over the
 *  batch's exposure-derived ceiling so the hard cap in Sprites.js governs the
 *  brightness in every scenario and bloom — not clipping — carries the punch.
 * ================================================================== */

export function impact(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const m = Math.max(0.18, Math.min(2.2, o.magnitude ?? 0.6));
  const scale = o.scale ?? 1;
  const kind = o.kind ?? 'weapon';
  const heavy = kind === 'heavy_impact' || m > 0.9;
  const gy = o.groundY;
  const onFloor = o.ny > 0.72;
  const col = o.colour ?? P.spark;

  _n.set(o.nx, o.ny, o.nz);
  if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
  _n.normalize();

  /*
   * The swing arc. A caller that knows the real blade direction passes it as
   * (ax,ay,az); otherwise it is the horizontal tangent of the struck surface,
   * which is the axis a blade arriving along -n actually travels along. The
   * degenerate case (a straight-down hit on the floor) falls back to world X.
   */
  if (Number.isFinite(o.ax) && Number.isFinite(o.az)) {
    _arc.set(o.ax, o.ay ?? 0, o.az);
  } else {
    _arc.copy(_UP).cross(_n);
  }
  if (_arc.lengthSq() < 1e-5) _arc.set(1, 0, 0);
  _arc.normalize();
  // Bias the smear slightly downward-outward: a swing finishes low and away.
  _arc.y -= 0.16;
  _arc.normalize();

  /* Contact point, pushed onto the far side of the hit so the core sits on the
     target rather than between the target and the swinger. */
  const px = o.x + _n.x * 0.14, py = o.y + _n.y * 0.14, pz = o.z + _n.z * 0.14;

  /*
   * --- 1. the arc smear: hot core + two flanking licks ---
   *
   * ALIGN.VELOCITY stretches the quad along screen-space velocity, so the
   * *direction* is carried by iVel, not by a rotation the CPU has to project.
   * High drag means it stretches without actually travelling anywhere.
   * The intensities (1.35 / 0.95 / 0.62) are deliberately above the additive
   * ceiling: Sprites.js rolls the premultiplied peak off to `uMaxRad`, which is
   * the exposure-corrected value ACES maps to ~0.85, so the core reads at the
   * same brightness in `dungeon` (gain 1.86) as in `boss` (gain 2.73) and
   * clips in neither.
   */
  const arcSpeed = 5.2 + m * 3.4;
  const coreSz = (0.10 + m * 0.055) * scale;      // <= 0.19 m at m = 1.6
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 0.19 * scale * (0.7 + m * 0.3);
    const lead = i === 1 ? 1 : 0.62;
    s.reset();
    s.at(px + _arc.x * off, py + _arc.y * off, pz + _arc.z * off);
    s.vel(_arc.x * arcSpeed, _arc.y * arcSpeed, _arc.z * arcSpeed);
    s.shape = SHAPE.GLOW; s.align = ALIGN.VELOCITY;
    s.life = 0.055 + m * 0.028;
    s.size(coreSz * lead, coreSz * lead * 1.35);
    s.aspect = 0.52;                 // narrow across the arc
    s.stretch = 0.055 + m * 0.012;   // metres of streak per (m/s)
    s.sizeCurve = 0.6;
    s.drag = 14;                     // stretches, barely moves
    s.soft = 0.28;
    if (i === 1) s.colorA(P.hot, 1.35, 0.95);
    else s.colorA(P.spark, 0.95, 0.80);
    s.colorB(col, 0.28, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* A single wider, dimmer smear underneath gives the core a falloff without
     becoming a bokeh disc. Stays far below the ceiling on purpose — the read
     comes from the core, this only stops the core ending in hard air. */
  s.reset();
  s.at(px, py, pz);
  s.vel(_arc.x * arcSpeed * 0.7, _arc.y * arcSpeed * 0.7, _arc.z * arcSpeed * 0.7);
  s.shape = SHAPE.GLOW; s.align = ALIGN.VELOCITY;
  s.life = 0.10 + m * 0.05;
  s.size(coreSz * 1.5, coreSz * 2.1);
  s.aspect = 0.62;
  s.stretch = 0.045;
  s.sizeCurve = 0.5;
  s.drag = 11;
  s.soft = 0.55;
  s.colorA(col, 0.30, 0.30);
  s.colorB(P.emberDim, 0.14, 0.0);
  s.seed = rnd();
  v.glow();

  /*
   * --- 2. spark fan in the plane of the swing ---
   *
   * Steel on stone throws sparks along the blade tangent, fanned in the plane
   * spanned by the arc and the surface normal — not into a cone around the
   * normal, which is what made the old burst read as a radial firework.
   */
  const nSpark = Math.round((9 + m * 14) * v.density);
  const fan = kind === 'slash' ? 0.55 : 0.40;   // out-of-plane scatter
  for (let i = 0; i < nSpark; i++) {
    const along = rnd.sign() * rnd.range(0.55, 1.0);
    const outw = rnd.range(0.22, 0.85);
    _d.set(
      _arc.x * along + _n.x * outw,
      _arc.y * along + _n.y * outw + rnd.range(0.10, 0.55),
      _arc.z * along + _n.z * outw
    );
    // out-of-plane jitter so the fan has thickness
    _d.x += rnd.gauss(0, fan * 0.35);
    _d.z += rnd.gauss(0, fan * 0.35);
    if (_d.lengthSq() < 1e-6) _d.copy(_n);
    _d.normalize();
    const sp = rnd.range(4.5, 12) * (0.65 + m * 0.6);
    s.reset();
    s.at(px + _d.x * 0.05, py + _d.y * 0.05, pz + _d.z * 0.05);
    s.vel(_d.x * sp, _d.y * sp + rnd.range(0.4, 2.0), _d.z * sp);
    s.shape = SHAPE.SPARK; s.align = ALIGN.VELOCITY;
    s.life = rnd.range(0.14, 0.40);
    const w = rnd.range(0.034, 0.070) * scale;
    s.size(w, w);
    s.aspect = 0.38;
    s.stretch = 0.022;
    s.gravity = 11.5;
    s.drag = rnd.range(0.9, 2.0);
    s.soft = 0.16;
    // Struck steel is orange, not white. The SPARK mask brightens its own thin
    // core, so the body colour must stay warm or the burst reads as scratches.
    s.colorA(P.spark, 1.05 + m * 0.22, 1.0);
    s.colorB(P.ember, 0.34, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /*
   * --- 3. dust: a low skirt along the arc, never a puff over the contact ---
   *
   * Two changes from the old radial cloud: the count is roughly halved, and
   * every puff is launched along ±arc and BELOW the contact point, so the
   * smoke settles around the strike instead of billowing up in front of the
   * character. The alpha is also lower — overlapping form-lit puffs composite
   * toward their own colour, so eight of them at 0.28 read as a solid milky
   * sheet no matter how dark the individual puff is authored.
   */
  const nDust = Math.round((1 + m * 2.2) * v.density);
  for (let i = 0; i < nDust; i++) {
    const along = rnd.sign() * rnd.range(0.3, 1.0);
    const sp = rnd.range(0.5, 1.8) * (0.7 + m * 0.5);
    s.reset();
    s.at(
      px + _arc.x * along * 0.22,
      Math.max(gy + 0.05, py - 0.18),
      pz + _arc.z * along * 0.22
    );
    s.vel(_arc.x * along * sp, rnd.range(0.10, 0.55), _arc.z * along * sp);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.45, 0.95);
    s.size(rnd.range(0.14, 0.24) * scale, rnd.range(0.55, 1.0) * scale);
    s.sizeCurve = 0.6;
    s.drag = 2.4;
    s.gravity = -0.4;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.9);
    s.swayAmp = rnd.range(0.04, 0.12); s.swayFreq = rnd.range(0.8, 1.7);
    s.soft = 0.75;
    s.colorA(P.dust, 1.0, rnd.range(0.09, 0.17) * (0.6 + m * 0.5));
    s.colorB(P.dustDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- 4. debris chips with real weight, thrown along the arc --- */
  const nChip = Math.round((3 + m * 4) * v.density);
  for (let i = 0; i < nChip; i++) {
    const along = rnd.sign() * rnd.range(0.4, 1.0);
    _d.set(
      _arc.x * along + _n.x * rnd.range(0.2, 0.8),
      Math.abs(_arc.y) * 0.3 + rnd.range(0.35, 0.9),
      _arc.z * along + _n.z * rnd.range(0.2, 0.8)
    ).normalize();
    const sp = rnd.range(2.4, 7.0) * (0.7 + m * 0.6);
    s.reset();
    s.at(px, py, pz);
    s.vel(_d.x * sp, _d.y * sp * 0.8 + rnd.range(1.2, 3.8), _d.z * sp);
    s.shape = SHAPE.CHIP; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.45, 0.95);
    const w = rnd.range(0.030, 0.085) * scale;
    s.size(w, w * 0.92);
    s.gravity = 16;
    s.drag = 0.25;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 13);
    s.soft = 0.2;
    s.colorA(P.stone, 1.0, 0.92);
    s.colorB(P.stoneDark, 1.0, 0.35);
    s.seed = rnd();
    v.soft();
  }

  /* --- 5. ground shock ring, only where the blow really met the floor --- */
  if (onFloor || heavy) {
    s.reset();
    s.at(o.x, (onFloor ? o.y : gy) + 0.035, o.z);
    s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
    s.life = 0.20 + m * 0.12;
    s.size(0.25 * scale, (0.72 + m * 0.85) * scale);
    s.sizeCurve = 0.5;
    s.rot = rnd() * TAU;
    s.soft = 0.4;
    s.colorA(col, 0.34, 0.28);
    s.colorB(P.emberDim, 0.12, 0.0);
    s.seed = rnd();
    v.glow();

    // low skirt of dust kicked outward along the floor
    const nSkirt = Math.round((1 + m * 2.2) * v.density);
    for (let i = 0; i < nSkirt; i++) {
      const a = rnd() * TAU;
      const sp = rnd.range(1.4, 4.2) * (0.6 + m * 0.7);
      s.reset();
      s.at(o.x + Math.cos(a) * 0.15, (onFloor ? o.y : gy) + 0.09, o.z + Math.sin(a) * 0.15);
      s.vel(Math.cos(a) * sp, rnd.range(0.15, 0.8), Math.sin(a) * sp);
      s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
      s.life = rnd.range(0.55, 1.2);
      s.size(rnd.range(0.18, 0.34) * scale, rnd.range(0.7, 1.5) * scale);
      s.sizeCurve = 0.55;
      s.drag = 2.6;
      s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.7);
      s.swayAmp = rnd.range(0.05, 0.18); s.swayFreq = rnd.range(0.7, 1.5);
      s.soft = 0.85;
      s.colorA(P.dust, 1.0, rnd.range(0.07, 0.16));
      s.colorB(P.dustDark, 1.0, 0.0);
      s.seed = rnd();
      v.soft();
    }
  }

  /*
   * --- 6. the world reacts: a one-beat practical ---
   * Short and placed at the contact, so the *scene* carries the brightness of
   * the hit — a lit floor and a lit blade — instead of the sprite doing it with
   * raw emissive. This is the read the clipped core used to fake.
   */
  v.flash(px, py, pz, col, 15 + m * 26, 4.2 + m * 3.2, 0.09 + m * 0.09);

  /* --- 7. hand the scuff to whoever owns decals --- */
  if (m > 0.5) v.decal('scuff', o.x, gy, o.z, (0.35 + m * 0.5) * scale, rnd() * TAU, P.stoneDark);
  if (heavy) v.caPulse(Math.min(0.45, m * 0.32));
}

/* ================================================================== *
 *  2 — DUST ONLY (footfalls, dashes, landings)
 * ================================================================== */

export function dust(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const m = Math.max(0.1, Math.min(1.6, o.magnitude ?? 0.35));
  const gy = o.groundY;
  const n = Math.max(1, Math.round((1 + m * 3.2) * v.density));
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const sp = rnd.range(0.4, 2.0) * (0.5 + m);
    s.reset();
    s.at(o.x + Math.cos(a) * rnd.range(0, 0.18), gy + 0.06, o.z + Math.sin(a) * rnd.range(0, 0.18));
    s.vel(Math.cos(a) * sp, rnd.range(0.25, 1.1) * (0.5 + m), Math.sin(a) * sp);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.5, 1.15);
    s.size(rnd.range(0.14, 0.26), rnd.range(0.5, 1.15) * (0.7 + m * 0.6));
    s.sizeCurve = 0.55;
    s.drag = 2.4;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.8);
    s.swayAmp = rnd.range(0.03, 0.12); s.swayFreq = rnd.range(0.7, 1.6);
    s.soft = 0.8;
    s.colorA(P.dust, 1.0, rnd.range(0.07, 0.18) * (0.5 + m * 0.6));
    s.colorB(P.dustDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }
  if (m > 0.7) {
    // a few grit chips for a heavy landing
    for (let i = 0; i < 3; i++) {
      const a = rnd() * TAU;
      const sp = rnd.range(1.5, 4.0);
      s.reset();
      s.at(o.x, gy + 0.05, o.z);
      s.vel(Math.cos(a) * sp, rnd.range(1.2, 3.2), Math.sin(a) * sp);
      s.shape = SHAPE.CHIP; s.align = ALIGN.CAMERA;
      s.life = rnd.range(0.4, 0.8);
      s.size(0.045, 0.04);
      s.gravity = 15; s.drag = 0.3;
      s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 11);
      s.soft = 0.2;
      s.colorA(P.stone, 1.0, 0.8);
      s.colorB(P.stoneDark, 1.0, 0.2);
      s.seed = rnd();
      v.soft();
    }
  }
}

/* ================================================================== *
 *  3 — BLOOD
 *  arterial spray along the hit direction · gravity droplets that land and
 *  hand a splat to Decals · fine mist · wound puff
 * ================================================================== */

export function blood(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const amount = Math.max(0.2, Math.min(2.5, o.magnitude ?? 0.7));
  const gy = o.groundY;
  const h = Math.max(0.05, o.y - gy);

  _n.set(o.nx, o.ny, o.nz);
  if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
  _n.normalize();
  // Spray follows the blow, biased upward — a wound sprays along the strike.
  _n.y += 0.42;
  _n.normalize();

  /* --- wound puff: the dense core of the spray --- */
  s.reset();
  s.at(o.x, o.y, o.z);
  s.shape = SHAPE.SPLAT; s.align = ALIGN.CAMERA;
  s.life = 0.26;
  s.size(0.16 * amount, 0.52 * amount);
  s.sizeCurve = 0.45;
  s.soft = 0.4;
  s.colorA(P.blood, 1.0, 0.95);
  s.colorB(P.bloodDark, 1.0, 0.0);
  s.seed = rnd();
  v.soft();

  /* --- arterial droplets --- */
  const nDrop = Math.round((10 + amount * 14) * v.density);
  // Splats are capped: the ground pool is shared with telegraphs, and twenty
  // stains from one hit would evict the read the player actually needs.
  let splats = 0;
  for (let i = 0; i < nDrop; i++) {
    const d = cone(rnd, _n, 0.62, _d);
    const sp = rnd.range(3.0, 10.5) * (0.6 + amount * 0.5);
    const vx = d.x * sp, vy = d.y * sp, vz = d.z * sp;
    const g = 17.5;
    s.reset();
    s.at(o.x + d.x * 0.06, o.y + d.y * 0.06, o.z + d.z * 0.06);
    s.vel(vx, vy, vz);
    s.shape = SHAPE.DROP; s.align = ALIGN.VELOCITY;
    const t = fallTime(vy, h, g);
    s.life = Math.max(0.14, Math.min(1.1, t));
    const w = rnd.range(0.035, 0.085) * (0.8 + amount * 0.35);
    s.size(w, w);
    s.aspect = 0.62;
    s.stretch = 0.011;
    s.gravity = g;
    s.drag = 0.35;
    s.soft = 0.16;
    s.colorA(P.blood, 1.0, 0.96);
    s.colorB(P.bloodDark, 1.0, 0.85);
    s.seed = rnd();
    v.soft();

    /* where it lands: a ground splat scheduled at the exact impact time */
    if (t > 0.1 && t < 1.1 && splats < 3 && rnd() < 0.55) {
      splats++;
      const lx = o.x + vx * t * 0.72;
      const lz = o.z + vz * t * 0.72;
      v.groundSplat(lx, lz, t, w * rnd.range(2.4, 5.0), rnd);
    }
  }

  /* --- fine mist: what sells "arterial" more than the droplets do --- */
  const nMist = Math.round((6 + amount * 8) * v.density);
  for (let i = 0; i < nMist; i++) {
    const d = cone(rnd, _n, 1.0, _d);
    const sp = rnd.range(0.8, 3.4);
    s.reset();
    s.at(o.x + d.x * 0.08, o.y + d.y * 0.08, o.z + d.z * 0.08);
    s.vel(d.x * sp, d.y * sp + rnd.range(-0.2, 0.6), d.z * sp);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.28, 0.68);
    s.size(rnd.range(0.06, 0.14), rnd.range(0.22, 0.5));
    s.sizeCurve = 0.6;
    s.drag = 3.2;
    s.gravity = 2.5;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 1.4);
    s.soft = 0.45;
    s.colorA(P.bloodMist, 1.0, rnd.range(0.18, 0.40));
    s.colorB(P.bloodDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  if (amount > 1.1) v.caPulse(0.22);
}

/* ================================================================== *
 *  4 — FIRE
 *  three-band temperature ramp (white-hot core -> yellow -> orange) ·
 *  turbulent rise · embers · dark smoke · heat distortion · light
 * ================================================================== */

export function fire(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const inten = o.intensity ?? 1;
  const n = Math.max(2, Math.round(3 * v.density * (0.6 + scale * 0.5)));

  /*
   * Three additive bands make the colour temperature ramp, and their VALUES are
   * the whole trick. The post chain multiplies this batch by the scenario
   * exposure times an auto-exposure gain that reaches 2.7x in a torchlit crypt,
   * so a lick authored at "2.7 emissive" arrives at the tonemapper around 9.0
   * and every channel clips: the flame becomes a white blob with no hue at all.
   * Authored at ~1.15 with a modest alpha, two or three overlapping licks land
   * in the 1-3 linear range, where ACES keeps the red above the green above the
   * blue — which IS the ramp. Small and hot beats big and clipped.
   */

  /* --- band 1: white-hot core, small and short-lived --- */
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, r = rnd() * 0.09 * scale;
    const hgt = rnd.range(0.14, 0.24) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(0, 0.08) * scale, o.z + Math.sin(a) * r);
    s.vel(Math.cos(a) * 0.25, rnd.range(1.5, 3.0) * scale, Math.sin(a) * 0.25);
    s.shape = SHAPE.FLAME; s.align = ALIGN.UPRIGHT;
    s.life = rnd.range(0.18, 0.32);
    s.size(hgt, hgt * 0.45);
    s.aspect = rnd.range(0.34, 0.50);
    s.sizeCurve = 1.5;
    s.drag = 1.9;
    s.swayAmp = rnd.range(0.03, 0.09) * scale; s.swayFreq = rnd.range(3.0, 6.0);
    s.soft = 0.3;
    s.colorA(P.flameCore, 0.95 * inten, 0.34);
    s.colorB(P.flameMid, 0.5 * inten, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- band 2: the yellow/orange body that carries the hue --- */
  for (let i = 0; i < n + 3; i++) {
    const a = rnd() * TAU, r = rnd() * 0.24 * scale;
    const hgt = rnd.range(0.34, 0.62) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(0.02, 0.18) * scale, o.z + Math.sin(a) * r);
    s.vel(Math.cos(a) * 0.4, rnd.range(1.0, 2.3) * scale, Math.sin(a) * 0.4);
    s.shape = SHAPE.FLAME; s.align = ALIGN.UPRIGHT;
    s.life = rnd.range(0.30, 0.55);
    s.size(hgt, hgt * 0.40);
    s.aspect = rnd.range(0.40, 0.62);
    s.sizeCurve = 1.3;
    s.drag = 1.6;
    s.swayAmp = rnd.range(0.05, 0.15) * scale; s.swayFreq = rnd.range(2.2, 4.6);
    s.soft = 0.35;
    s.colorA(P.flameMid, 0.66 * inten, 0.24);
    s.colorB(P.flameOuter, 0.30 * inten, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- band 3: the cooling orange fringe that becomes smoke --- */
  const nf = Math.round(5 * v.density * (0.6 + scale * 0.5));
  for (let i = 0; i < nf; i++) {
    const a = rnd() * TAU, r = rnd() * 0.42 * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(0.15, 0.5) * scale, o.z + Math.sin(a) * r);
    s.vel(Math.cos(a) * 0.3, rnd.range(0.8, 1.9) * scale, Math.sin(a) * 0.3);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.7, 1.5);
    s.size(rnd.range(0.24, 0.44) * scale, rnd.range(0.8, 1.7) * scale);
    s.sizeCurve = 0.7;
    s.drag = 1.1;
    s.gravity = -0.9;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.6);
    s.swayAmp = rnd.range(0.10, 0.34) * scale; s.swayFreq = rnd.range(0.7, 1.6);
    s.soft = 0.9;
    s.colorA(P.smokeLit, 1.0, rnd.range(0.16, 0.32));
    s.colorB(P.smokeDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- embers: rise, drift, cool --- */
  const ne = Math.round(6 * v.density * (0.6 + scale * 0.6));
  for (let i = 0; i < ne; i++) {
    const a = rnd() * TAU, r = rnd() * 0.3 * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(0.05, 0.3) * scale, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.25), rnd.range(1.0, 2.6) * scale, rnd.gauss(0, 0.25));
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.8, 2.1);
    const w = rnd.range(0.030, 0.062) * scale;
    s.size(w, w * 0.45);
    s.drag = 0.45;
    s.gravity = -0.35;
    s.swayAmp = rnd.range(0.14, 0.55) * scale; s.swayFreq = rnd.range(0.8, 2.1);
    s.soft = 0.2;
    s.colorA(P.ember, 1.15 * inten, 0.95);
    s.colorB(P.emberDim, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- base glow so the fire lights its own footprint --- */
  s.reset();
  s.at(o.x, o.y + 0.12 * scale, o.z);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = 0.4;
  s.size(0.55 * scale, 0.72 * scale);
  s.soft = 1.0;
  s.colorA(P.ember, 0.32 * inten, 0.30);
  s.colorB(P.emberDim, 0.25, 0.0);
  s.seed = rnd();
  v.glow();

  v.heat(o.x, o.y + 0.5 * scale, o.z, 1.4 * scale, 0.8 * inten, 0.5);
  v.flash(o.x, o.y + 0.3 * scale, o.z, P.ember, 18 * inten * scale, 6 * scale, 0.35);
}

/** One-shot fire explosion: fire, plus outward blast and a scorch ring. */
export function fireburst(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1.4;
  const gy = o.groundY;

  fire(v, { ...o, scale: scale * 0.9, intensity: (o.intensity ?? 1) * 1.15 });

  /* radial blast of flame pushed outward, not up */
  const n = Math.round(14 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const sp = rnd.range(3.5, 9.0) * scale;
    s.reset();
    s.at(o.x, o.y + 0.15, o.z);
    s.vel(Math.cos(a) * sp, rnd.range(0.6, 3.0) * scale, Math.sin(a) * sp);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.35, 0.75);
    s.size(rnd.range(0.2, 0.4) * scale, rnd.range(0.9, 1.9) * scale);
    s.sizeCurve = 0.55;
    s.drag = 2.4;
    s.soft = 0.7;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 1.1);
    s.colorA(P.flameMid, 0.9, 0.45);
    s.colorB(P.smokeDark, 1.0, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* shock ring + scorch */
  s.reset();
  s.at(o.x, gy + 0.04, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.42;
  s.size(0.5 * scale, 5.0 * scale);
  s.sizeCurve = 0.45;
  s.soft = 0.5;
  s.colorA(P.flameMid, 0.9, 0.5);
  s.colorB(P.emberDim, 0.2, 0.0);
  s.seed = rnd();
  v.glow();

  v.ground('scorch', {
    x: o.x, z: o.z, y: gy, radius: 1.6 * scale, life: 9,
    colour: P.ash, rim: P.ember, rimGain: 0.55, seed: rnd(),
  });
  v.decal('scorch', o.x, gy, o.z, 1.6 * scale, rnd() * TAU, P.ash);
  v.flash(o.x, o.y + 0.6, o.z, P.flameMid, 90 * scale, 11 * scale, 0.30);
  v.caPulse(0.4);
}

/* ================================================================== *
 *  5 — FROST
 *  shards · cold mist that pools low · crystalline sparkle · ground rime
 * ================================================================== */

export function frost(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const gy = o.groundY;

  /* --- core burst --- */
  s.reset();
  s.at(o.x, o.y, o.z);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = 0.16;
  s.size(0.4 * scale, 1.5 * scale);
  s.sizeCurve = 0.45;
  s.soft = 0.6;
  s.colorA(P.frost, 1.30, 0.75);
  s.colorB(P.frostMid, 0.6, 0.0);
  s.seed = rnd();
  v.glow();

  /* --- shards --- */
  const n = Math.round(12 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const el = rnd.range(0.1, 1.1);
    const sp = rnd.range(2.5, 7.5) * scale;
    s.reset();
    s.at(o.x, o.y, o.z);
    s.vel(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp * 0.9, Math.sin(a) * Math.cos(el) * sp);
    s.shape = SHAPE.SHARD; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.45, 1.0);
    const w = rnd.range(0.09, 0.22) * scale;
    s.size(w, w * 0.55);
    s.gravity = 7.5;
    s.drag = 1.3;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 5);
    s.soft = 0.25;
    s.colorA(P.frost, 0.92, 0.85);
    s.colorB(P.frostDeep, 0.5, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- cold mist: heavy, spreads along the floor --- */
  const nm = Math.round(9 * v.density * scale);
  for (let i = 0; i < nm; i++) {
    const a = rnd() * TAU;
    const sp = rnd.range(0.7, 3.0) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * rnd.range(0, 0.3), o.y * 0.35 + gy * 0.65 + 0.08, o.z + Math.sin(a) * rnd.range(0, 0.3));
    s.vel(Math.cos(a) * sp, rnd.range(-0.1, 0.5), Math.sin(a) * sp);
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.life = rnd.range(1.1, 2.4);
    s.size(rnd.range(0.3, 0.6) * scale, rnd.range(1.3, 2.8) * scale);
    s.sizeCurve = 0.55;
    s.drag = 2.0;
    s.gravity = 0.35;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.5);
    s.swayAmp = rnd.range(0.08, 0.3); s.swayFreq = rnd.range(0.5, 1.2);
    s.soft = 1.0;
    s.colorA(P.frost, 0.55, rnd.range(0.10, 0.22));
    s.colorB(P.frostDeep, 0.7, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- crystalline sparkle: the read that says "ice", not "smoke" --- */
  const ns = Math.round(10 * v.density * scale);
  for (let i = 0; i < ns; i++) {
    const a = rnd() * TAU, r = rnd.range(0.1, 1.5) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(-0.4, 0.9) * scale, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.3), rnd.range(-0.4, 0.4), rnd.gauss(0, 0.3));
    s.shape = SHAPE.STAR; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, 0.5);
    s.life = rnd.range(0.14, 0.34);
    const w = rnd.range(0.09, 0.20) * scale;
    s.size(w * 0.4, w);
    s.sizeCurve = 0.5;
    s.rot = rnd() * TAU;
    s.drag = 1.2;
    s.soft = 0.2;
    s.colorA(P.frost, 1.45, 0.9);
    s.colorB(P.frostMid, 0.5, 0.0);
    s.seed = rnd();
    v.glow();
  }

  v.ground('rime', {
    x: o.x, z: o.z, y: gy, radius: 1.5 * scale, life: 8,
    colour: P.frost, rim: P.frostMid, rimGain: 0.35, seed: rnd(),
  });
  v.decal('rime', o.x, gy, o.z, 1.5 * scale, rnd() * TAU, P.frost);
  v.flash(o.x, o.y + 0.4, o.z, P.frostMid, 34 * scale, 7 * scale, 0.22);
}

/* ================================================================== *
 *  6 — LIGHTNING
 *  branched bolt (Bolts.js) · additive glow along it · endpoint flash ·
 *  fast sparks · scorch · very short bright light
 * ================================================================== */

export function lightning(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const gy = o.groundY;

  // Default arc: from above the point, down into it — reads as a strike.
  const ax = o.ax ?? o.x;
  const ay = o.ay ?? (o.y + 5.5 * scale);
  const az = o.az ?? o.z;
  const bx = o.bx ?? o.x;
  const by = o.by ?? o.y;
  const bz = o.bz ?? o.z;

  v.bolt(ax, ay, az, bx, by, bz, {
    width: 0.075 * scale,
    life: 0.20,
    core: P.arc,
    glow: P.arcMid,
    intensity: 2.0,
    branches: 4,
    jitter: 0.42 * scale,
    seed: rnd(),
  });

  /* impact flash at the ground end */
  s.reset();
  s.at(bx, by, bz);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = 0.10;
  s.size(0.5 * scale, 2.1 * scale);
  s.sizeCurve = 0.4;
  s.soft = 0.6;
  s.colorA(P.arc, 2.05, 0.92);
  s.colorB(P.arcMid, 0.8, 0.0);
  s.seed = rnd();
  v.glow();

  /* star flare — gives the strike a hard optical read */
  s.reset();
  s.at(bx, by + 0.1, bz);
  s.shape = SHAPE.STAR; s.align = ALIGN.CAMERA;
  s.life = 0.14;
  s.size(0.6 * scale, 2.6 * scale);
  s.sizeCurve = 0.4;
  s.rot = rnd() * TAU;
  s.soft = 0.6;
  s.colorA(P.arc, 1.55, 0.85);
  s.colorB(P.arcDeep, 0.5, 0.0);
  s.seed = rnd();
  v.glow();

  /* fast sparks scattering off the strike point */
  const n = Math.round(16 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const el = rnd.range(0.15, 1.4);
    const sp = rnd.range(6, 17) * scale;
    s.reset();
    s.at(bx, by + 0.05, bz);
    s.vel(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp);
    s.shape = SHAPE.SPARK; s.align = ALIGN.VELOCITY;
    s.life = rnd.range(0.10, 0.28);
    const w = rnd.range(0.035, 0.075) * scale;
    s.size(w, w);
    s.aspect = 0.4;
    s.stretch = 0.034;
    s.gravity = 9;
    s.drag = 2.6;
    s.soft = 0.15;
    s.colorA(P.arc, 1.65, 0.95);
    s.colorB(P.arcMid, 0.7, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* residual arc wisps clinging to the ground */
  const nw = Math.round(5 * v.density * scale);
  for (let i = 0; i < nw; i++) {
    const a = rnd() * TAU, r = rnd.range(0.2, 1.4) * scale;
    s.reset();
    s.at(bx + Math.cos(a) * r, gy + rnd.range(0.05, 0.5), bz + Math.sin(a) * r);
    s.vel(0, rnd.range(0.3, 1.1), 0);
    s.shape = SHAPE.WISP; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0.02, 0.16);
    s.life = rnd.range(0.18, 0.42);
    s.size(rnd.range(0.2, 0.45) * scale, rnd.range(0.1, 0.3) * scale);
    s.drag = 1.5;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 2);
    s.soft = 0.3;
    s.colorA(P.arcMid, 1.05, 0.6);
    s.colorB(P.arcDeep, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  s.reset();
  s.at(bx, gy + 0.04, bz);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.26;
  s.size(0.4 * scale, 3.4 * scale);
  s.sizeCurve = 0.42;
  s.soft = 0.5;
  s.colorA(P.arcMid, 1.0, 0.5);
  s.colorB(P.arcDeep, 0.3, 0.0);
  s.seed = rnd();
  v.glow();

  v.decal('scorch', bx, gy, bz, 0.9 * scale, rnd() * TAU, P.ash);
  v.flash(bx, by + 0.5, bz, P.arcMid, 150 * scale, 14 * scale, 0.12);
  v.caPulse(0.5);
}

/* ================================================================== *
 *  7 — NECROTIC / POISON
 *  sickly motes rising · viscous drips · dark shadow pulse · vapour
 * ================================================================== */

export function necrotic(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const gy = o.groundY;
  const col = o.colour ?? P.necro;

  /* --- shadow pulse: a dark expanding ring, the opposite of a flash --- */
  s.reset();
  s.at(o.x, gy + 0.03, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.55;
  s.size(0.4 * scale, 4.4 * scale);
  s.sizeCurve = 0.5;
  s.soft = 0.55;
  s.colorA(P.necroDark, 1.0, 0.65);
  s.colorB(P.necroDark, 1.0, 0.0);
  s.seed = rnd();
  v.soft();

  s.reset();
  s.at(o.x, gy + 0.05, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.5;
  s.size(0.3 * scale, 4.0 * scale);
  s.sizeCurve = 0.45;
  s.soft = 0.5;
  s.colorA(col, 0.95, 0.44);
  s.colorB(P.necroMid, 0.3, 0.0);
  s.seed = rnd();
  v.glow();

  /* --- rising motes: the signature read --- */
  const n = Math.round(16 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, r = rnd() * 1.5 * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd.range(0.02, 0.5), o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.16), rnd.range(0.5, 1.8), rnd.gauss(0, 0.16));
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, 0.45);
    s.life = rnd.range(0.9, 2.2);
    const w = rnd.range(0.05, 0.115) * scale;
    s.size(w, w * 0.35);
    s.drag = 0.5;
    s.swayAmp = rnd.range(0.12, 0.45); s.swayFreq = rnd.range(0.6, 1.6);
    s.soft = 0.22;
    s.colorA(col, 0.92, 0.85);
    s.colorB(P.necroMid, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- vapour: dark green, hugs the floor --- */
  const nv = Math.round(8 * v.density * scale);
  for (let i = 0; i < nv; i++) {
    const a = rnd() * TAU;
    const sp = rnd.range(0.4, 2.2) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * rnd.range(0, 0.6), gy + rnd.range(0.05, 0.4), o.z + Math.sin(a) * rnd.range(0, 0.6));
    s.vel(Math.cos(a) * sp, rnd.range(0.1, 0.8), Math.sin(a) * sp);
    s.shape = SHAPE.WISP; s.align = ALIGN.CAMERA;
    s.life = rnd.range(1.0, 2.3);
    s.size(rnd.range(0.3, 0.6) * scale, rnd.range(1.2, 2.4) * scale);
    s.sizeCurve = 0.6;
    s.drag = 1.8;
    s.gravity = -0.25;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.6);
    s.swayAmp = rnd.range(0.1, 0.35); s.swayFreq = rnd.range(0.5, 1.3);
    s.soft = 0.95;
    s.colorA(P.necroMid, 0.9, rnd.range(0.14, 0.30));
    s.colorB(P.necroDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- viscous drips: heavy, slow, land as pools --- */
  const nd = Math.round(6 * v.density * scale);
  for (let i = 0; i < nd; i++) {
    const a = rnd() * TAU, r = rnd() * 1.0 * scale;
    const h = rnd.range(0.9, 2.1);
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + h, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.15), -rnd.range(0.2, 0.8), rnd.gauss(0, 0.15));
    s.shape = SHAPE.DROP; s.align = ALIGN.VELOCITY;
    const t = fallTime(-0.5, h, 9.0);
    s.delay = rnd.range(0, 0.6);
    s.life = Math.max(0.2, t);
    const w = rnd.range(0.055, 0.11) * scale;
    s.size(w, w);
    s.aspect = 0.7;
    s.stretch = 0.010;
    s.gravity = 9.0;
    s.soft = 0.18;
    s.colorA(P.necroMid, 0.88, 0.85);
    s.colorB(P.necroDark, 1.0, 0.7);
    s.seed = rnd();
    v.glow();
  }

  v.ground('pool', {
    x: o.x, z: o.z, y: gy, radius: 1.8 * scale, life: 7,
    colour: P.necroDark, rim: col, rimGain: 0.8, seed: rnd(),
  });
  v.decal('poison', o.x, gy, o.z, 1.8 * scale, rnd() * TAU, P.necroMid);
  v.flash(o.x, gy + 0.6, o.z, P.necroMid, 26 * scale, 7 * scale, 0.5);
}

/* ================================================================== *
 *  8 — ARCANE (hero cast release, generic magic)
 * ================================================================== */

export function arcane(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const col = o.colour ?? P.arcane;

  s.reset();
  s.at(o.x, o.y, o.z);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = 0.22;
  s.size(0.3 * scale, 1.5 * scale);
  s.sizeCurve = 0.42;
  s.soft = 0.6;
  s.colorA(P.arc, 1.6, 0.85);
  s.colorB(col, 0.8, 0.0);
  s.seed = rnd();
  v.glow();

  s.reset();
  s.at(o.x, o.y, o.z);
  s.shape = SHAPE.STAR; s.align = ALIGN.CAMERA;
  s.life = 0.28;
  s.size(0.4 * scale, 2.0 * scale);
  s.sizeCurve = 0.42;
  s.rot = rnd() * TAU; s.rotVel = 1.2;
  s.soft = 0.6;
  s.colorA(col, 1.35, 0.8);
  s.colorB(P.arcaneMid, 0.5, 0.0);
  s.seed = rnd();
  v.glow();

  _n.set(o.nx, o.ny, o.nz);
  if (_n.lengthSq() < 1e-6) _n.set(0, 0, 1);
  _n.normalize();

  const n = Math.round(14 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const d = cone(rnd, _n, 0.75, _d);
    const sp = rnd.range(3.5, 11) * scale;
    s.reset();
    s.at(o.x, o.y, o.z);
    s.vel(d.x * sp, d.y * sp + rnd.range(-0.5, 1.4), d.z * sp);
    s.shape = SHAPE.SPARK; s.align = ALIGN.VELOCITY;
    s.life = rnd.range(0.2, 0.5);
    const w = rnd.range(0.04, 0.085) * scale;
    s.size(w, w);
    s.aspect = 0.42;
    s.stretch = 0.028;
    s.drag = 2.2;
    s.gravity = 2.5;
    s.soft = 0.16;
    s.colorA(P.arc, 1.5, 0.95);
    s.colorB(col, 0.7, 0.0);
    s.seed = rnd();
    v.glow();
  }

  const nw = Math.round(8 * v.density * scale);
  for (let i = 0; i < nw; i++) {
    const a = rnd() * TAU, r = rnd() * 0.7 * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, o.y + rnd.range(-0.3, 0.4), o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.5), rnd.range(0.3, 1.4), rnd.gauss(0, 0.5));
    s.shape = SHAPE.WISP; s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.4, 0.95);
    s.size(rnd.range(0.2, 0.4) * scale, rnd.range(0.5, 1.0) * scale);
    s.drag = 1.6;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 1.6);
    s.swayAmp = rnd.range(0.05, 0.2); s.swayFreq = rnd.range(1.2, 2.8);
    s.soft = 0.5;
    s.colorA(col, 1.0, 0.55);
    s.colorB(P.arcaneMid, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  v.flash(o.x, o.y, o.z, col, 40 * scale, 7 * scale, 0.20);
}

/* ================================================================== *
 *  9 — CAST CHARGE (windup — lives for the whole telegraph)
 * ================================================================== */

export function charge(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const dur = Math.max(0.15, o.duration ?? 0.6);
  const scale = o.scale ?? 1;
  const col = o.colour ?? P.arcane;

  /* motes converging inward — the classic "something is coming" read */
  const n = Math.round(18 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU;
    const el = rnd.range(-0.5, 1.0);
    const r = rnd.range(0.8, 2.0) * scale;
    const px = o.x + Math.cos(a) * Math.cos(el) * r;
    const py = o.y + Math.sin(el) * r * 0.7;
    const pz = o.z + Math.sin(a) * Math.cos(el) * r;
    const tt = rnd.range(dur * 0.35, dur * 0.95);
    s.reset();
    s.at(px, py, pz);
    // aim it at the origin so it arrives roughly when the cast releases
    s.vel((o.x - px) / tt, (o.y - py) / tt, (o.z - pz) / tt);
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, dur * 0.4);
    s.life = tt;
    const w = rnd.range(0.05, 0.11) * scale;
    s.size(w * 0.6, w * 1.15);
    s.drag = 0;
    s.swayAmp = rnd.range(0.03, 0.12); s.swayFreq = rnd.range(1.5, 3.5);
    s.soft = 0.2;
    s.colorA(col, 0.8, 0.45);
    s.colorB(P.arc, 1.5, 0.95);
    s.seed = rnd();
    v.glow();
  }

  /* a core that swells across the windup */
  s.reset();
  s.at(o.x, o.y, o.z);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = dur;
  s.size(0.10 * scale, 0.75 * scale);
  s.sizeCurve = 2.0;
  s.soft = 0.5;
  s.colorA(col, 0.7, 0.30);
  s.colorB(P.arc, 1.6, 0.9);
  s.seed = rnd();
  v.glow();
}

/* ================================================================== *
 *  10 — DEATH DISSOLVE
 *  A noise-thresholded burn line sweeps up the body: each mote is born
 *  glowing at the edge, then cools to ash. Rising embers above, ash fall
 *  below, a base pulse and a lingering smoke column.
 * ================================================================== */

export function dissolve(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const h = Math.max(0.6, o.height ?? 1.8);
  const rad = Math.max(0.15, o.radius ?? 0.42);
  const gy = o.groundY;
  const sweep = Math.min(1.4, 0.42 + h * 0.14);
  const hot = o.colour ?? P.ember;

  /* --- the dissolving body: a capsule of motes, delayed by height --- */
  const n = Math.round((34 + h * 16) * v.density);
  for (let i = 0; i < n; i++) {
    const t = rnd();                       // normalised height
    const a = rnd() * TAU;
    // waist profile so the cloud has a body silhouette, not a cylinder
    const prof = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const r = rad * prof * Math.sqrt(rnd());
    const px = o.x + Math.cos(a) * r;
    const pz = o.z + Math.sin(a) * r;
    const py = gy + t * h;
    // ragged threshold: the sweep front is eroded, never a clean line
    const noise = (Math.sin(px * 7.3 + pz * 5.1) * 0.5 + 0.5) * 0.18;
    s.reset();
    s.at(px, py, pz);
    s.vel(rnd.gauss(0, 0.22), rnd.range(0.25, 1.15), rnd.gauss(0, 0.22));
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = Math.max(0, t * sweep + noise);
    s.life = rnd.range(0.5, 1.15);
    const w = rnd.range(0.055, 0.135);
    s.size(w, w * 0.5);
    s.drag = 0.7;
    s.gravity = -0.4;
    s.swayAmp = rnd.range(0.05, 0.25); s.swayFreq = rnd.range(0.9, 2.2);
    s.soft = 0.25;
    s.colorA(hot, 1.50, 0.95);             // glowing burn edge at birth
    s.colorB(P.ash, 0.5, 0.0);            // cools to ash
    s.seed = rnd();
    v.glow();
  }

  /* --- ash smoke released as the body goes --- */
  const nsm = Math.round((10 + h * 4) * v.density);
  for (let i = 0; i < nsm; i++) {
    const t = rnd();
    const a = rnd() * TAU, r = rad * rnd.range(0.2, 1.3);
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + t * h, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.2), rnd.range(0.35, 1.2), rnd.gauss(0, 0.2));
    s.shape = SHAPE.SMOKE; s.align = ALIGN.CAMERA;
    s.delay = t * sweep + rnd.range(0, 0.2);
    s.life = rnd.range(1.1, 2.4);
    s.size(rnd.range(0.2, 0.42), rnd.range(0.9, 2.0));
    s.sizeCurve = 0.65;
    s.drag = 1.2;
    s.gravity = -0.5;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 0.5);
    s.swayAmp = rnd.range(0.1, 0.4); s.swayFreq = rnd.range(0.5, 1.3);
    s.soft = 0.95;
    s.colorA(P.smokeLit, 1.0, rnd.range(0.14, 0.30));
    s.colorB(P.smokeDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- embers escaping upward --- */
  const ne = Math.round((12 + h * 5) * v.density);
  for (let i = 0; i < ne; i++) {
    const a = rnd() * TAU, r = rad * rnd.range(0.1, 1.1);
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd() * h * 0.8, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.3), rnd.range(1.0, 2.8), rnd.gauss(0, 0.3));
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, sweep * 0.9);
    s.life = rnd.range(1.0, 2.6);
    const w = rnd.range(0.030, 0.062);
    s.size(w, w * 0.4);
    s.drag = 0.4;
    s.gravity = -0.5;
    s.swayAmp = rnd.range(0.2, 0.7); s.swayFreq = rnd.range(0.7, 1.9);
    s.soft = 0.2;
    s.colorA(hot, 1.20, 0.95);
    s.colorB(P.emberDim, 0.35, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- ash raining out of the collapse --- */
  const na = Math.round((7 + h * 3) * v.density);
  for (let i = 0; i < na; i++) {
    const a = rnd() * TAU, r = rad * rnd.range(0.1, 1.2);
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd.range(0.3, 1) * h, o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.35), rnd.range(-0.2, 0.5), rnd.gauss(0, 0.35));
    s.shape = SHAPE.CHIP; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, sweep);
    s.life = rnd.range(0.6, 1.4);
    const w = rnd.range(0.03, 0.075);
    s.size(w, w * 0.85);
    s.gravity = 6.5;
    s.drag = 1.4;
    s.rot = rnd() * TAU; s.rotVel = rnd.gauss(0, 8);
    s.soft = 0.2;
    s.colorA(P.ash, 1.0, 0.8);
    s.colorB(P.stoneDark, 1.0, 0.0);
    s.seed = rnd();
    v.soft();
  }

  /* --- base pulse + a ground stain where the body was --- */
  s.reset();
  s.at(o.x, gy + 0.04, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.5;
  s.size(0.3, rad * 6 + 1.0);
  s.sizeCurve = 0.45;
  s.soft = 0.5;
  s.colorA(hot, 1.0, 0.45);
  s.colorB(P.emberDim, 0.2, 0.0);
  s.seed = rnd();
  v.glow();

  v.ground('scorch', {
    x: o.x, z: o.z, y: gy, radius: rad * 2.4 + 0.35, life: 10,
    colour: P.ash, rim: hot, rimGain: 0.30, seed: rnd(),
  });
  v.decal('ash', o.x, gy, o.z, rad * 2.4 + 0.35, rnd() * TAU, P.ash);
  v.flash(o.x, gy + h * 0.5, o.z, hot, 22 + h * 8, 5 + h, 0.45);
}

/* ================================================================== *
 *  11 — LEVEL UP / PICKUP
 *  vertical light shaft · rising sparks · ground ring · flash
 * ================================================================== */

export function shaft(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const scale = o.scale ?? 1;
  const gy = o.groundY;
  const col = o.colour ?? P.gold;
  const height = (o.height ?? 4.5) * scale;
  const life = o.life ?? 1.35;

  /* --- the column: three nested widths so it has a core and a falloff --- */
  const WID = [0.34, 0.80, 1.55];
  const GAIN = [1.35, 0.58, 0.30];
  const OPA = [0.62, 0.34, 0.20];
  for (let i = 0; i < 3; i++) {
    const w = WID[i] * scale;
    s.reset();
    s.at(o.x, gy + height * 0.5, o.z);
    s.shape = SHAPE.SHAFT; s.align = ALIGN.UPRIGHT;
    s.life = life * (1.0 - i * 0.08);
    s.size(height, height);
    s.aspect = w / height;
    s.soft = 1.1;
    s.colorA(col, GAIN[i], OPA[i]);
    s.colorB(P.goldDeep, 0.2, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- rising sparks --- */
  const n = Math.round(20 * v.density * scale);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, r = rnd.range(0.1, 0.85) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd.range(0, 0.4), o.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.18), rnd.range(1.6, 4.2) * scale, rnd.gauss(0, 0.18));
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, life * 0.6);
    s.life = rnd.range(0.7, 1.5);
    const w = rnd.range(0.035, 0.08) * scale;
    s.size(w, w * 0.4);
    s.drag = 0.35;
    s.gravity = -0.6;
    s.swayAmp = rnd.range(0.06, 0.28); s.swayFreq = rnd.range(0.9, 2.2);
    s.soft = 0.2;
    s.colorA(P.hot, 1.30, 0.95);
    s.colorB(col, 0.6, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- sparkle stars for the "reward" read --- */
  const ns = Math.round(8 * v.density * scale);
  for (let i = 0; i < ns; i++) {
    const a = rnd() * TAU, r = rnd.range(0.2, 1.4) * scale;
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd.range(0.3, height * 0.7), o.z + Math.sin(a) * r);
    s.vel(0, rnd.range(0.2, 0.9), 0);
    s.shape = SHAPE.STAR; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, life * 0.8);
    s.life = rnd.range(0.2, 0.45);
    const w = rnd.range(0.12, 0.26) * scale;
    s.size(w * 0.3, w);
    s.sizeCurve = 0.5;
    s.rot = rnd() * TAU;
    s.soft = 0.3;
    s.colorA(P.gold, 1.45, 0.85);
    s.colorB(P.goldDeep, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  /* --- ground ring --- */
  s.reset();
  s.at(o.x, gy + 0.04, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.7;
  s.size(0.4 * scale, 3.6 * scale);
  s.sizeCurve = 0.45;
  s.soft = 0.5;
  s.colorA(col, 0.9, 0.52);
  s.colorB(P.goldDeep, 0.2, 0.0);
  s.seed = rnd();
  v.glow();

  v.ground('glyph', {
    x: o.x, z: o.z, y: gy, radius: 1.5 * scale, life: life,
    colour: P.goldDeep, rim: col, rimGain: 1.0, seed: rnd(),
  });
  v.flash(o.x, gy + 1.2, o.z, col, 55 * scale, 9 * scale, life * 0.6);
}

/** Loot beacon — quieter, longer, and rarity-coloured. */
export function pickup(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const col = o.colour ?? P.gold;
  const gy = o.groundY;
  const life = o.life ?? 2.6;

  s.reset();
  s.at(o.x, gy + 0.9, o.z);
  s.shape = SHAPE.SHAFT; s.align = ALIGN.UPRIGHT;
  s.life = life;
  s.size(1.8, 1.8);
  s.aspect = 0.34;
  s.soft = 1.0;
  s.colorA(col, 0.82, 0.26);
  s.colorB(col, 0.35, 0.0);
  s.seed = rnd();
  v.glow();

  s.reset();
  s.at(o.x, gy + 0.16, o.z);
  s.shape = SHAPE.GLOW; s.align = ALIGN.CAMERA;
  s.life = life;
  s.size(0.5, 0.62);
  s.soft = 0.6;
  s.colorA(col, 0.6, 0.44);
  s.colorB(col, 0.35, 0.0);
  s.seed = rnd();
  v.glow();

  const n = Math.round(9 * v.density);
  for (let i = 0; i < n; i++) {
    const a = rnd() * TAU, r = rnd.range(0.05, 0.4);
    s.reset();
    s.at(o.x + Math.cos(a) * r, gy + rnd.range(0, 0.2), o.z + Math.sin(a) * r);
    s.vel(0, rnd.range(0.5, 1.5), 0);
    s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
    s.delay = rnd.range(0, life * 0.8);
    s.life = rnd.range(0.7, 1.4);
    const w = rnd.range(0.03, 0.06);
    s.size(w, w * 0.35);
    s.drag = 0.4;
    s.swayAmp = rnd.range(0.04, 0.16); s.swayFreq = rnd.range(0.8, 1.8);
    s.soft = 0.2;
    s.colorA(col, 1.1, 0.85);
    s.colorB(col, 0.4, 0.0);
    s.seed = rnd();
    v.glow();
  }

  s.reset();
  s.at(o.x, gy + 0.035, o.z);
  s.shape = SHAPE.RING; s.align = ALIGN.GROUND;
  s.life = 0.55;
  s.size(0.25, 1.5);
  s.sizeCurve = 0.45;
  s.soft = 0.4;
  s.colorA(col, 0.78, 0.48);
  s.colorB(col, 0.2, 0.0);
  s.seed = rnd();
  v.glow();
}

/* ================================================================== *
 *  12 — AMBIENT: floating particulate. Deliberately extremely soft and
 *  dim — the existing dust motes read as hard white dots, which is the
 *  exact failure this shape avoids.
 * ================================================================== */

export function motes(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  const col = o.colour ?? P.dust;
  s.reset();
  s.at(o.x, o.y, o.z);
  s.vel(rnd.gauss(0, 0.10), rnd.range(-0.04, 0.22), rnd.gauss(0, 0.10));
  s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
  s.life = rnd.range(3.5, 8.0);
  const w = rnd.range(0.020, 0.055);
  s.size(w, w * 0.85);
  s.drag = 0.12;
  s.swayAmp = rnd.range(0.10, 0.45); s.swayFreq = rnd.range(0.15, 0.55);
  s.soft = 0.5;
  s.colorA(col, o.intensity ?? 0.55, 0.0);
  s.colorB(col, (o.intensity ?? 0.55) * 0.7, rnd.range(0.10, 0.30));
  s.a0 = rnd.range(0.08, 0.24);
  s.seed = rnd();
  v.glow();
}

/** Embers drifting off a fixture — warm, tiny, and low enough not to bloom. */
export function emberDrift(v, o) {
  const rnd = v.rnd;
  const s = v.s;
  s.reset();
  s.at(o.x + rnd.gauss(0, 0.07), o.y, o.z + rnd.gauss(0, 0.07));
  s.vel(rnd.gauss(0, 0.12), rnd.range(0.55, 1.7), rnd.gauss(0, 0.12));
  s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
  s.life = rnd.range(1.4, 3.4);
  const w = rnd.range(0.022, 0.048);
  s.size(w, w * 0.35);
  s.drag = 0.3;
  s.gravity = -0.28;
  s.swayAmp = rnd.range(0.10, 0.42); s.swayFreq = rnd.range(0.6, 1.6);
  s.soft = 0.2;
  s.colorA(P.ember, 0.95, 0.9);
  s.colorB(P.emberDim, 0.4, 0.0);
  s.seed = rnd();
  v.glow();
}

export const RECIPES = {
  impact, dust, blood, fire, fireburst, frost, lightning,
  necrotic, arcane, charge, dissolve, shaft, pickup, motes, emberDrift,
};
