/**
 * SANCTUM — Ability table + hit-shape kernels
 * ---------------------------------------------------------------------------
 * Data, not behaviour. Every ability is a plain record describing *timing*,
 * *cost* and *shape*; CombatSystem owns the state machine that walks it and
 * HitFeel owns how the landing reads. Keeping the table declarative is what
 * makes eight abilities feel authored rather than eight copies of one function.
 *
 * The timing contract (this is the whole feel of an ARPG)
 * ------------------------------------------------------
 *      |<-- windup -->|<-- active -->|<-- recovery -->|
 *      cast starts     hits land      inputs buffer
 *
 *  • **windup**   the tell. Nothing can be hit yet. Cancellable by a dash.
 *  • **active**   the hit window. For weapon abilities the *animation* decides
 *                 when this opens (`animActive`, phase of the hero clip), so the
 *                 blade and the damage always agree. For shaped abilities it is
 *                 the authored window.
 *  • **recovery** committed frames. Input during recovery is *buffered*, so the
 *                 next combo step fires the instant the window closes, and a
 *                 dash cancels it outright.
 *
 * Damage is expressed as a fraction of the attacker's weapon damage, the way an
 * ARPG skill tooltip reads ("120% weapon damage"). That keeps the whole table
 * balanced by one number on the hero and lets scaling live in one place.
 *
 * Binds: LMB combo, RMB whirlwind, 1 leap slam, 2 shockwave, 3 glaive,
 * 4 void lance, Space dash strike, Q/5 war cry.
 */

/* ------------------------------------------------------------------ *
 * resource + progression tuning
 * ------------------------------------------------------------------ */

export const RESOURCE = Object.freeze({
  id: 'fury',
  label: 'Fury',
  max: 100,
  /** Fury bleeds away out of combat; it is a momentum resource, not a pool. */
  decay: 5.5,
  decayDelay: 2.6,
  /** Passive trickle while in combat so a rotation never fully stalls. */
  regen: 2.2,
});

export const VITALS = Object.freeze({
  /** Health per second, only after this long without taking a hit. */
  regen: 5.0,
  regenDelay: 4.5,
  /** Respawn timing after death. */
  deathHold: 2.6,
  respawnFade: 0.8,
  /** Dodge invulnerability, seconds. */
  iframes: 0.34,
});

export const XP = Object.freeze({
  /** XP needed for level n → n+1. */
  curve: (level) => Math.round(180 * Math.pow(level, 1.42)),
  perKill: (enemyLevel, rank) =>
    Math.round((14 + enemyLevel * 9) * (rank === 'boss' ? 22 : rank === 'champion' ? 3.4 : 1)),
});

/* ------------------------------------------------------------------ *
 * abilities
 * ------------------------------------------------------------------ */

/**
 * `animActive` is [phase0, phase1] of the hero clip during which the weapon
 * capsule is live. The numbers come straight from HeroClips.js: attack1 lands
 * its `impact` event at 0.44, attack2 at 0.40, attack3 at 0.52, heavy at 0.60 —
 * the window brackets the contact frame with a few frames of lead-in and
 * follow-through, which is exactly what a swept hit needs.
 */
export const ABILITIES = {
  /* ---------------------------------------------------------------- *
   * LMB — three-hit combo. One ability, three steps, escalating reads.
   * ---------------------------------------------------------------- */
  combo1: {
    id: 'combo1', name: 'Rending Slash', slot: 'lmb', key: 'mouse0', glyph: '1',
    type: 'physical', anim: 'attack1', comboStep: 0, comboNext: 'combo2',
    damage: 0.52, cost: 0, gain: 11, cooldown: 0,
    windup: 0.19, active: 0.14, recovery: 0.22, comboWindow: 0.42,
    shape: { kind: 'weapon', radius: 0.36, reach: 2.5 },
    maxTargets: 3, pierce: false,
    impact: 0.85, stagger: 0.12, hitstop: 0.058, shake: 0.05, glance: 1,
    vfx: { kind: 'slash', color: 0xd8e6ff, arc: 1 },
  },
  combo2: {
    id: 'combo2', name: 'Backhand Cleave', slot: 'lmb', key: 'mouse0', glyph: '2',
    type: 'physical', anim: 'attack2', comboStep: 1, comboNext: 'combo3',
    damage: 0.60, cost: 0, gain: 13, cooldown: 0,
    windup: 0.17, active: 0.15, recovery: 0.20, comboWindow: 0.40,
    shape: { kind: 'weapon', radius: 0.40, reach: 2.7 },
    maxTargets: 4, pierce: false,
    impact: 1.0, stagger: 0.15, hitstop: 0.064, shake: 0.06, glance: 0.9,
    vfx: { kind: 'slash', color: 0xd8e6ff, arc: -1 },
  },
  combo3: {
    id: 'combo3', name: 'Sundering Blow', slot: 'lmb', key: 'mouse0', glyph: '3',
    type: 'physical', anim: 'attack3', comboStep: 2, comboNext: null,
    damage: 1.05, cost: 0, gain: 18, cooldown: 0,
    windup: 0.30, active: 0.17, recovery: 0.34, comboWindow: 0,
    shape: { kind: 'weapon', radius: 0.48, reach: 2.9, groundBurst: 2.0 },
    maxTargets: 5, pierce: false,
    impact: 1.9, stagger: 0.34, hitstop: 0.098, shake: 0.13, glance: 0.7,
    critBonus: 0.06,
    vfx: { kind: 'crush', color: 0xffd7a8, arc: 0 },
  },

  /* ---------------------------------------------------------------- *
   * RMB — whirlwind. A channel: no discrete swing, a rotating capsule.
   * ---------------------------------------------------------------- */
  whirlwind: {
    id: 'whirlwind', name: 'Whirlwind', slot: 'rmb', key: 'mouse2', glyph: 'W',
    type: 'physical', anim: 'spin', channel: true,
    damage: 0.30, cost: 14, costPerSecond: 16, gain: 0, cooldown: 0.9,
    windup: 0.14, active: 1.05, recovery: 0.30,
    tickRate: 0.17,
    shape: { kind: 'circle', radius: 2.75, height: 2.4 },
    maxTargets: 8, pierce: true, moveMul: 0.55,
    impact: 0.55, stagger: 0.07, hitstop: 0.032, shake: 0.035, glance: 0.6,
    telegraph: { color: 0xbcd2ff, alpha: 0.20, shape: 'ring', follow: true },
    vfx: { kind: 'whirl', color: 0xc4d8ff },
  },

  /* ---------------------------------------------------------------- *
   * 1 — leap slam. Telegraphed, airborne, lands with weight.
   * ---------------------------------------------------------------- */
  leap: {
    id: 'leap', name: 'Earthbreaker', slot: '1', key: 'Digit1', glyph: 'L',
    type: 'physical', anim: 'heavy',
    damage: 1.55, cost: 25, gain: 22, cooldown: 6.5,
    windup: 0.42, active: 0.16, recovery: 0.46,
    /** Airborne travel happens across the windup; the slam is the active frame. */
    leapRange: 8.5, leapArc: 2.6,
    shape: { kind: 'circle', radius: 3.6, height: 3.0 },
    maxTargets: 9, pierce: true,
    impact: 2.6, stagger: 0.62, hitstop: 0.11, shake: 0.34, glance: 0, noGlance: true,
    telegraph: { color: 0xff8a2c, alpha: 0.42, shape: 'circle', danger: 'heavy' },
    vfx: { kind: 'slam', color: 0xffb063 },
    dust: 1,
  },

  /* ---------------------------------------------------------------- *
   * 2 — ground shockwave. Travels outward as a ring, hits as it passes.
   * ---------------------------------------------------------------- */
  shockwave: {
    id: 'shockwave', name: 'Fissure', slot: '2', key: 'Digit2', glyph: 'S',
    type: 'fire',
    anim: 'cast',
    damage: 0.78, cost: 20, gain: 0, cooldown: 4.2,
    windup: 0.26, active: 0.72, recovery: 0.30,
    /** The ring's leading edge sweeps from `inner` to `radius` over `active`. */
    shape: { kind: 'wave', radius: 9.0, inner: 1.2, width: 1.7, angle: 1.25, height: 2.2 },
    maxTargets: 12, pierce: true,
    impact: 1.25, stagger: 0.26, hitstop: 0.05, shake: 0.16, glance: 0.4,
    dot: { type: 'fire', dps: 9, duration: 3.0, interval: 0.5, maxStacks: 2 },
    telegraph: { color: 0xff6a1e, alpha: 0.34, shape: 'cone' },
    vfx: { kind: 'fissure', color: 0xff7a24 },
  },

  /* ---------------------------------------------------------------- *
   * 3 — thrown glaive. Pierces, hits every body on the line, once each.
   * ---------------------------------------------------------------- */
  glaive: {
    id: 'glaive', name: 'Storm Glaive', slot: '3', key: 'Digit3', glyph: 'G',
    type: 'lightning',
    anim: 'cast',
    damage: 0.66, cost: 15, gain: 6, cooldown: 2.6,
    windup: 0.22, active: 0.06, recovery: 0.22,
    projectile: { speed: 26, life: 0.95, radius: 0.62, spin: 26, count: 1 },
    shape: { kind: 'projectile', radius: 0.62, height: 2.0 },
    maxTargets: 99, pierce: true,
    impact: 0.9, stagger: 0.16, hitstop: 0.045, shake: 0.05, glance: 0.5,
    critBonus: 0.10,
    vfx: { kind: 'glaive', color: 0xcbb4ff },
  },

  /* ---------------------------------------------------------------- *
   * 4 — channelled beam. Ticks along a capsule while held.
   * ---------------------------------------------------------------- */
  lance: {
    id: 'lance', name: 'Void Lance', slot: '4', key: 'Digit4', glyph: 'V',
    type: 'shadow', anim: 'cast', channel: true,
    damage: 0.34, cost: 12, costPerSecond: 18, gain: 0, cooldown: 1.4,
    windup: 0.30, active: 1.55, recovery: 0.36,
    tickRate: 0.13,
    shape: { kind: 'beam', length: 13.0, radius: 0.85, height: 2.2 },
    maxTargets: 6, pierce: true, moveMul: 0.25,
    impact: 0.45, stagger: 0.05, hitstop: 0.026, shake: 0.028, glance: 0.3,
    dot: { type: 'shadow', dps: 7, duration: 2.4, interval: 0.4, maxStacks: 3 },
    telegraph: { color: 0xa95cff, alpha: 0.26, shape: 'line', follow: true },
    vfx: { kind: 'lance', color: 0xa95cff },
  },

  /* ---------------------------------------------------------------- *
   * Space — dash strike. Cancels everything, grants i-frames, hits through.
   * ---------------------------------------------------------------- */
  dash: {
    id: 'dash', name: 'Shadow Step', slot: 'space', key: 'Space', glyph: 'D',
    type: 'physical', anim: 'dash',
    damage: 0.42, cost: 10, gain: 8, cooldown: 1.1,
    windup: 0.05, active: 0.30, recovery: 0.10,
    iframes: 0.40, canCancel: true, cancels: true,
    shape: { kind: 'trail', radius: 0.95, height: 2.0 },
    maxTargets: 4, pierce: true,
    impact: 0.7, stagger: 0.20, hitstop: 0.036, shake: 0.05, glance: 0.5,
    vfx: { kind: 'dash', color: 0x9fc6ff },
  },

  /* ---------------------------------------------------------------- *
   * Q / 5 — defensive shout. No damage: a buff, a taunt and a pulse.
   * ---------------------------------------------------------------- */
  warcry: {
    id: 'warcry', name: 'Iron Bellow', slot: 'q', key: 'KeyQ', altKey: 'Digit5', glyph: 'C',
    type: 'physical',
    anim: 'cast',
    damage: 0, cost: 0, gain: 30, cooldown: 11.0,
    windup: 0.22, active: 0.20, recovery: 0.34,
    shape: { kind: 'circle', radius: 5.4, height: 2.6 },
    maxTargets: 12, pierce: true,
    impact: 0.9, stagger: 0.40, hitstop: 0, shake: 0.14, glance: 0,
    buff: {
      duration: 8.0, armour: 0.55, damage: 0.22, resistAll: 0.15,
      thorns: 14, heal: 0.12, label: 'Iron Bellow',
    },
    taunt: true,
    telegraph: { color: 0xffc766, alpha: 0.30, shape: 'ring' },
    vfx: { kind: 'shout', color: 0xffc766 },
  },
};

/** Deterministic iteration order — object key order is stable but be explicit. */
export const ABILITY_ORDER = Object.freeze([
  'combo1', 'combo2', 'combo3', 'whirlwind', 'leap', 'shockwave', 'glaive', 'lance', 'dash', 'warcry',
]);

/** What the HUD shows in the action bar, in bar order. */
export const BAR = Object.freeze(['combo1', 'whirlwind', 'leap', 'shockwave', 'glaive', 'lance', 'warcry', 'dash']);

/** key code -> ability id. Mouse buttons use the Input module's `mouseN` names. */
export const BINDS = (() => {
  const m = {};
  for (const id of ABILITY_ORDER) {
    const a = ABILITIES[id];
    if (a.comboStep > 0) continue;                    // combo steps chain, not bind
    if (a.key) m[a.key] = id;
    if (a.altKey) m[a.altKey] = id;
  }
  return Object.freeze(m);
})();

/**
 * The hero clip an ability rides, mapped to the phase window during which its
 * weapon capsule is live. Read straight off HeroClips' `impact` event times.
 */
export const CLIP_WINDOW = Object.freeze({
  attack1: [0.30, 0.58],
  attack2: [0.27, 0.55],
  attack3: [0.40, 0.66],
  heavy: [0.47, 0.74],
  cast: [0.44, 0.62],
});

/** Reverse map: a hero-initiated clip becomes an ability instance. */
export const CLIP_ABILITY = Object.freeze({
  attack1: 'combo1', attack2: 'combo2', attack3: 'combo3',
  heavy: 'combo3', cast: 'shockwave', dash: 'dash',
});

/**
 * Clip length and the phase at which it releases — the `impact` / `cast:release`
 * event times in HeroClips.js. A shaped ability attached to a hero-initiated
 * clip fires at the release, so the fissure leaves the hand when the hand opens.
 */
export const CLIP_TIME = Object.freeze({
  attack1: { dur: 0.66, release: 0.44 },
  attack2: { dur: 0.60, release: 0.40 },
  attack3: { dur: 0.92, release: 0.52 },
  heavy: { dur: 1.24, release: 0.60 },
  cast: { dur: 1.00, release: 0.52 },
  dash: { dur: 0.66, release: 0.30 },
});

export const COMBO_CHAIN = Object.freeze(['combo1', 'combo2', 'combo3']);

/* ------------------------------------------------------------------ *
 * shape kernels
 * ------------------------------------------------------------------ *
 * Each returns the *edge factor* of the hit — 0 at the dead centre of the
 * shape, 1 grazing the rim — or -1 for a miss. The damage model turns that
 * straight into glancing-blow probability, which is why a clipped hit at the
 * end of a swing reads soft and a centred one does not.
 */

const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const wrapPi = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Filled disc. */
export function hitCircle(cx, cz, r, tx, tz, tr) {
  const d = Math.hypot(tx - cx, tz - cz) - tr;
  if (d > r) return -1;
  return clamp01(d / Math.max(0.001, r));
}

/** Annulus — the shockwave's leading edge, or a ring telegraph. */
export function hitRing(cx, cz, rOuter, rInner, tx, tz, tr) {
  const d = Math.hypot(tx - cx, tz - cz);
  if (d - tr > rOuter || d + tr < rInner) return -1;
  const mid = (rOuter + rInner) * 0.5;
  const half = Math.max(0.001, (rOuter - rInner) * 0.5 + tr);
  return clamp01(Math.abs(d - mid) / half);
}

/** Cone from an origin, `yaw` centred, total sweep `angle`. */
export function hitCone(ox, oz, yaw, length, angle, tx, tz, tr) {
  const dx = tx - ox, dz = tz - oz;
  const dist = Math.hypot(dx, dz);
  if (dist - tr > length) return -1;
  if (dist < 1e-3) return 0;
  const half = angle * 0.5 + Math.atan2(tr, Math.max(0.35, dist));
  const off = Math.abs(wrapPi(Math.atan2(dz, dx) - yaw));
  if (off > half) return -1;
  // rim-ness is the worse of "far along the cone" and "off to the side"
  return clamp01(Math.max(off / half, (dist - tr) / Math.max(0.001, length)) * 0.92);
}

/** Rectangle from an origin along `yaw`: length forward, ±width/2 across. */
export function hitLine(ox, oz, yaw, length, width, tx, tz, tr) {
  const dx = tx - ox, dz = tz - oz;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const along = dx * c + dz * s;
  const across = -dx * s + dz * c;
  if (along < -tr || along - tr > length) return -1;
  const half = width * 0.5 + tr;
  if (Math.abs(across) > half) return -1;
  return clamp01(Math.abs(across) / half);
}

/**
 * Closest approach between two segments — the kernel behind swept weapon hits.
 * Ericson's clamped solve, written to a caller-owned scratch object so a swing
 * against nine bodies allocates nothing.
 */
export function segSeg(
  p0x, p0y, p0z, p1x, p1y, p1z,
  q0x, q0y, q0z, q1x, q1y, q1z, out
) {
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const ex = q1x - q0x, ey = q1y - q0y, ez = q1z - q0z;
  const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = dx * dx + dy * dy + dz * dz;
  const e = ex * ex + ey * ey + ez * ez;
  const f = ex * rx + ey * ry + ez * rz;
  const EPS = 1e-9;
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { t = clamp(f / e, 0, 1); }
  else {
    const c = dx * rx + dy * ry + dz * rz;
    if (e <= EPS) s = clamp(-c / a, 0, 1);
    else {
      const b = dx * ex + dy * ey + dz * ez;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const ax = p0x + dx * s, ay = p0y + dy * s, az = p0z + dz * s;
  const bx = q0x + ex * t, by = q0y + ey * t, bz = q0z + ez * t;
  out.s = s; out.t = t;
  out.ax = ax; out.ay = ay; out.az = az;
  out.bx = bx; out.by = by; out.bz = bz;
  out.dist = Math.hypot(ax - bx, ay - by, az - bz);
  return out;
}

export function makeSeg() {
  return { s: 0, t: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, dist: 0 };
}

/** Capsule vs capsule as an edge factor + contact point in `out`. */
export function hitCapsule(
  a0x, a0y, a0z, a1x, a1y, a1z, ra,
  b0x, b0y, b0z, b1x, b1y, b1z, rb, out
) {
  segSeg(a0x, a0y, a0z, a1x, a1y, a1z, b0x, b0y, b0z, b1x, b1y, b1z, out);
  const rr = ra + rb;
  if (out.dist > rr) return -1;
  return clamp01(out.dist / Math.max(0.001, rr));
}

/**
 * Total resource cost of an ability instance over `held` seconds — one-shot
 * cost plus the channel drain.
 */
export function costOf(ability, held = 0) {
  return (ability.cost ?? 0) + (ability.costPerSecond ?? 0) * Math.max(0, held);
}

/** Sum of the authored phases: how long the whole action commits the character. */
export function durationOf(ability) {
  return (ability.windup ?? 0) + (ability.active ?? 0) + (ability.recovery ?? 0);
}
