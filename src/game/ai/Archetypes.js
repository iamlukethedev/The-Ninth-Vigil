/**
 * SANCTUM — AI archetype tuning tables.
 *
 * Every number here is authored to the canonical world scale (1 unit = 1 metre,
 * hero = 1.85 m tall, brute = 3.2 m, boss = 6–7 m). Speeds are m/s, durations
 * are seconds, angles are radians unless the field name says `Deg`.
 *
 * An archetype is pure data. `Brain.js` reads it; nothing here holds state, so
 * the same table drives 1 agent or 60 with no aliasing hazards. Anything an
 * entity wants to override it can hand us on `entity.aiHint`.
 */

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * Attack definitions — the shape data doubles as the telegraph spec.
 * `shape` is what the VFX/Decals module draws on the ground.
 * ------------------------------------------------------------------ */

const A = {
  gruntSlash: {
    id: 'grunt.slash', label: 'Rusted Slash',
    shape: 'cone', angle: 78 * DEG, length: 2.9,
    range: 2.05, windup: 0.52, strike: 0.20, recover: 0.62, cooldown: 1.45,
    damage: 11, lunge: 3.1, hitAt: 0.06, danger: 'melee', color: 0xff7a2e,
  },
  gruntStab: {
    id: 'grunt.stab', label: 'Gutting Thrust',
    shape: 'line', length: 3.4, width: 0.9,
    range: 2.9, windup: 0.64, strike: 0.17, recover: 0.74, cooldown: 2.6,
    damage: 15, lunge: 6.4, hitAt: 0.05, danger: 'melee', color: 0xff6a22,
  },
  bruteSmash: {
    id: 'brute.smash', label: 'Overhead Smash',
    shape: 'circle', radius: 3.05,
    range: 3.15, windup: 0.96, strike: 0.24, recover: 1.05, cooldown: 3.2,
    damage: 32, lunge: 1.9, hitAt: 0.10, danger: 'heavy', color: 0xff4d1a,
    shake: 0.30,
  },
  bruteSweep: {
    id: 'brute.sweep', label: 'Chain Sweep',
    shape: 'cone', angle: 168 * DEG, length: 4.6,
    range: 4.1, windup: 0.82, strike: 0.30, recover: 0.92, cooldown: 5.4,
    damage: 26, lunge: 0.6, hitAt: 0.08, danger: 'heavy', color: 0xff5a1e,
    shake: 0.22,
  },
  archerBolt: {
    id: 'archer.bolt', label: 'Barbed Bolt',
    shape: 'line', length: 17, width: 0.55,
    range: 17, windup: 0.72, strike: 0.14, recover: 0.55, cooldown: 2.35,
    damage: 14, lunge: 0, hitAt: 0.02, danger: 'ranged', color: 0xffc45c,
    projectile: 'bolt', projectileSpeed: 34,
  },
  cultistBrand: {
    id: 'cultist.brand', label: 'Necrotic Brand',
    shape: 'circle', radius: 2.6,
    range: 13.5, windup: 1.22, strike: 0.22, recover: 0.85, cooldown: 5.0,
    damage: 19, lunge: 0, hitAt: 0.08, danger: 'aoe', color: 0x6ef0a2,
    groundAtTarget: true,
  },
  cultistSummon: {
    id: 'cultist.summon', label: 'Call the Unquiet',
    shape: 'ring', radius: 4.2,
    range: 22, windup: 1.9, strike: 0.35, recover: 1.15, cooldown: 17,
    damage: 0, lunge: 0, hitAt: 0.0, danger: 'summon', color: 0x7de0b4,
    summon: { archetype: 'grunt', count: 3, radius: 3.4 },
  },
  scavBite: {
    id: 'scav.bite', label: 'Ragged Bite',
    shape: 'cone', angle: 66 * DEG, length: 1.9,
    range: 1.55, windup: 0.34, strike: 0.14, recover: 0.42, cooldown: 1.1,
    damage: 7, lunge: 4.6, hitAt: 0.05, danger: 'melee', color: 0xff8a3c,
  },

  /* ---- boss rotation ---- */
  bossCleave: {
    id: 'boss.cleave', label: 'Reaper Cleave',
    shape: 'cone', angle: 104 * DEG, length: 8.4,
    range: 7.8, windup: 0.88, strike: 0.30, recover: 0.86, cooldown: 5.6,
    damage: 38, lunge: 2.4, hitAt: 0.10, danger: 'heavy', color: 0xff4a16, shake: 0.30,
  },
  bossSlam: {
    id: 'boss.slam', label: 'Sundering Slam',
    shape: 'circle', radius: 6.6,
    range: 8.6, windup: 1.14, strike: 0.30, recover: 1.10, cooldown: 8.2,
    damage: 46, lunge: 1.2, hitAt: 0.12, danger: 'heavy', color: 0xff3d10, shake: 0.52,
  },
  bossCharge: {
    id: 'boss.charge', label: 'Gore Charge',
    shape: 'line', length: 21, width: 3.4,
    range: 24, minRange: 8.5, windup: 1.32, strike: 0.62, recover: 1.25, cooldown: 12.5,
    damage: 42, lunge: 30, hitAt: 0.04, danger: 'heavy', color: 0xff5a1c, shake: 0.40,
  },
  bossQuake: {
    id: 'boss.quake', label: 'Bonequake',
    shape: 'ring', radius: 13.5, inner: 4.6,
    range: 40, windup: 1.85, strike: 0.42, recover: 1.35, cooldown: 19,
    damage: 52, lunge: 0, hitAt: 0.14, danger: 'aoe', color: 0xff6a20, shake: 0.70,
    arenaCentre: true, phase: 2,
  },
  bossMeteor: {
    id: 'boss.meteor', label: 'Hellrain',
    shape: 'circle', radius: 3.5, salvo: 3, salvoSpread: 5.5,
    range: 34, windup: 1.42, strike: 0.36, recover: 1.05, cooldown: 14,
    damage: 30, lunge: 0, hitAt: 0.10, danger: 'aoe', color: 0xff8a22, shake: 0.26,
    groundAtTarget: true, predict: 0.55, phase: 3,
  },
  bossSummon: {
    id: 'boss.summon', label: 'Disgorge',
    shape: 'ring', radius: 6.4,
    range: 44, windup: 1.66, strike: 0.40, recover: 1.20, cooldown: 21,
    damage: 0, lunge: 0, hitAt: 0, danger: 'summon', color: 0x8fe8bc,
    summon: { archetype: 'grunt', count: 4, radius: 5.6 }, phase: 1,
  },
};

/* ------------------------------------------------------------------ *
 * Archetypes
 * ------------------------------------------------------------------ */

/** @typedef {typeof ARCHETYPES.grunt} Archetype */
export const ARCHETYPES = {
  /* --- rank and file: the pack that must read as coordinated --- */
  grunt: {
    id: 'grunt', label: 'Risen',
    radius: 0.44, height: 1.90, mass: 78,
    speed: 3.35, sprintMul: 1.16, accel: 15.0, decel: 20.0, turnRate: 8.4,
    attacks: [A.gruntSlash, A.gruntStab],
    ring: { min: 2.9, max: 4.4, orbit: 0.55, jitter: 0.5 },
    vision: { fovDeg: 132, range: 21, gain: 2.35, peripheralGain: 0.55 },
    hearing: 12.5,
    noticeBeat: [0.34, 0.62],
    patrol: { leash: 8.5, pause: [1.4, 3.6], speedMul: 0.36, lookAround: 0.7 },
    flee: null,
    tokenCost: 1, tokenPool: 'melee',
    stagger: 0.34,
    lodBias: 1,
  },

  brute: {
    id: 'brute', label: 'Flesh Brute',
    radius: 0.96, height: 3.20, mass: 420,
    speed: 2.55, sprintMul: 1.10, accel: 7.0, decel: 9.0, turnRate: 3.1,
    attacks: [A.bruteSmash, A.bruteSweep],
    ring: { min: 4.2, max: 5.9, orbit: 0.24, jitter: 0.3 },
    vision: { fovDeg: 118, range: 24, gain: 1.75, peripheralGain: 0.42 },
    hearing: 15.0,
    noticeBeat: [0.62, 1.02],
    patrol: { leash: 6.0, pause: [2.4, 5.2], speedMul: 0.30, lookAround: 0.45 },
    flee: null,
    tokenCost: 2, tokenPool: 'melee',
    stagger: 0.14, unshakable: true,
    lodBias: 0.7,
  },

  archer: {
    id: 'archer', label: 'Bone Slinger',
    radius: 0.42, height: 1.86, mass: 70,
    speed: 3.15, sprintMul: 1.22, accel: 16.0, decel: 22.0, turnRate: 9.0,
    attacks: [A.archerBolt],
    ring: { min: 8.5, max: 13.5, orbit: 0.40, jitter: 0.6 },
    vision: { fovDeg: 108, range: 28, gain: 2.8, peripheralGain: 0.35 },
    hearing: 11.0,
    noticeBeat: [0.28, 0.50],
    patrol: { leash: 7.0, pause: [1.6, 4.0], speedMul: 0.34, lookAround: 0.85 },
    ranged: { preferred: 11.0, min: 7.0, max: 15.5, kiteMul: 0.92, losRequired: true, repositionAfter: 2 },
    flee: { hpFrac: 0.16, speedMul: 1.28, duration: 3.4 },
    tokenCost: 1, tokenPool: 'ranged',
    stagger: 0.46,
    lodBias: 1,
  },

  cultist: {
    id: 'cultist', label: 'Blood Acolyte',
    radius: 0.44, height: 1.88, mass: 74,
    speed: 2.85, sprintMul: 1.12, accel: 12.0, decel: 18.0, turnRate: 7.0,
    attacks: [A.cultistBrand],
    summonAttack: A.cultistSummon,
    ring: { min: 9.0, max: 14.0, orbit: 0.30, jitter: 0.45 },
    vision: { fovDeg: 120, range: 26, gain: 2.1, peripheralGain: 0.40 },
    hearing: 13.0,
    noticeBeat: [0.44, 0.80],
    patrol: { leash: 5.0, pause: [2.8, 6.0], speedMul: 0.26, lookAround: 0.55 },
    ranged: { preferred: 11.5, min: 8.0, max: 16.0, kiteMul: 0.80, losRequired: true, repositionAfter: 2 },
    summon: { minAllies: 4, cooldown: 17, maxTotal: 9 },
    flee: { hpFrac: 0.22, speedMul: 1.18, duration: 2.8 },
    tokenCost: 1, tokenPool: 'caster',
    stagger: 0.52,
    lodBias: 1,
  },

  scavenger: {
    id: 'scavenger', label: 'Carrion Imp',
    radius: 0.34, height: 1.42, mass: 34,
    speed: 4.25, sprintMul: 1.30, accel: 22.0, decel: 26.0, turnRate: 12.5,
    attacks: [A.scavBite],
    ring: { min: 2.3, max: 5.4, orbit: 1.15, jitter: 0.95 },
    vision: { fovDeg: 150, range: 18, gain: 3.2, peripheralGain: 0.70 },
    hearing: 14.0,
    noticeBeat: [0.18, 0.34],
    patrol: { leash: 11.0, pause: [0.7, 2.0], speedMul: 0.45, lookAround: 1.2 },
    flee: { hpFrac: 0.42, speedMul: 1.35, duration: 4.6, cowardly: true },
    tokenCost: 1, tokenPool: 'melee',
    stagger: 0.78,
    lodBias: 1.2,
    hitAndRun: { after: 1, retreat: 1.15 },
  },

  boss: {
    id: 'boss', label: 'Sanctum Warden',
    radius: 2.35, height: 6.50, mass: 2600,
    speed: 3.05, sprintMul: 1.05, accel: 5.4, decel: 7.0, turnRate: 2.0,
    attacks: [A.bossCleave, A.bossSlam, A.bossCharge, A.bossQuake, A.bossMeteor],
    summonAttack: A.bossSummon,
    ring: { min: 6.5, max: 9.0, orbit: 0.14, jitter: 0.15 },
    vision: { fovDeg: 360, range: 60, gain: 9.0, peripheralGain: 1.0 },
    hearing: 60.0,
    noticeBeat: [0.90, 1.30],
    patrol: { leash: 4.0, pause: [3.0, 6.0], speedMul: 0.22, lookAround: 0.3 },
    flee: null,
    tokenCost: 0, tokenPool: 'boss',
    stagger: 0.0, unshakable: true, isBoss: true,
    lodBias: 0,
    phases: [
      { at: 1.00, name: 'I',  abilities: ['boss.cleave', 'boss.slam', 'boss.charge'], castMul: 1.00, speedMul: 1.00, adds: 0 },
      { at: 0.70, name: 'II', abilities: ['boss.cleave', 'boss.slam', 'boss.charge', 'boss.quake', 'boss.summon'], castMul: 0.86, speedMul: 1.06, adds: 3 },
      { at: 0.35, name: 'III', abilities: ['boss.cleave', 'boss.slam', 'boss.charge', 'boss.quake', 'boss.meteor', 'boss.summon'], castMul: 0.74, speedMul: 1.12, adds: 4 },
    ],
    enrage: { at: 0.12, timeout: 165, castMul: 0.60, speedMul: 1.26, damageMul: 1.35 },
  },
};

/* Everything the boss can throw, by id — the phase table references these. */
export const BOSS_ABILITIES = {
  'boss.cleave': A.bossCleave,
  'boss.slam': A.bossSlam,
  'boss.charge': A.bossCharge,
  'boss.quake': A.bossQuake,
  'boss.meteor': A.bossMeteor,
  'boss.summon': A.bossSummon,
};

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

const PATTERNS = [
  [/(^|[^a-z])(boss|warden|butcher|avatar|overlord|dread|tyrant|colossus)/i, 'boss'],
  [/brute|golem|ogre|troll|abom|juggern|behemoth|flesh|tank|heavy/i, 'brute'],
  [/archer|arbal|bow|cross|sling|spit|dart|marks|ranger|shooter/i, 'archer'],
  [/cult|acolyte|shaman|necro|summon|priest|warlock|witch|caster|mage|sorc/i, 'cultist'],
  [/scav|imp|rat|swarm|maggot|gremlin|coward|hound|leaper|skitter/i, 'scavenger'],
  [/grunt|risen|ghoul|zombie|skele|corpse|husk|thrall|drone|melee/i, 'grunt'],
];

/**
 * Best-effort archetype resolution for an entity we did not author.
 * Explicit wins over inferred; inferred wins over the default.
 */
export function resolveArchetypeKey(entity) {
  if (!entity) return 'grunt';
  const hint = entity.aiHint;
  const explicit = (hint && hint.archetype) || entity.aiArchetype || entity.archetype;
  if (typeof explicit === 'string' && ARCHETYPES[explicit]) return explicit;

  if (entity.isBoss === true || entity.boss === true || entity.rank === 'boss') return 'boss';

  const fields = [entity.archetype, entity.kind, entity.type, entity.species, entity.rank,
    entity.tier, entity.family, entity.name, entity.id];
  for (let i = 0; i < fields.length; i++) {
    const v = fields[i];
    if (typeof v !== 'string' || !v) continue;
    if (ARCHETYPES[v]) return v;
    for (let p = 0; p < PATTERNS.length; p++) if (PATTERNS[p][0].test(v)) return PATTERNS[p][1];
  }

  // Fall back on physical scale: a 3 m tall thing is not a grunt.
  const h = num(entity.height) ?? (num(entity.scale) ? num(entity.scale) * 1.9 : null);
  if (h != null) {
    if (h >= 5.2) return 'boss';
    if (h >= 2.6) return 'brute';
    if (h <= 1.55) return 'scavenger';
  }
  const r = num(entity.radius);
  if (r != null) {
    if (r >= 1.8) return 'boss';
    if (r >= 0.8) return 'brute';
  }
  return 'grunt';
}

/**
 * Merge an archetype with per-entity overrides. Returns a fresh, flat object so
 * mutating one agent's tuning can never leak into the shared table.
 */
export function buildArchetype(entity) {
  const key = resolveArchetypeKey(entity);
  const base = ARCHETYPES[key] ?? ARCHETYPES.grunt;
  const out = {
    key,
    id: base.id,
    label: base.label,
    radius: num(entity?.radius) ?? base.radius,
    height: num(entity?.height) ?? base.height,
    mass: num(entity?.mass) ?? base.mass,
    speed: num(entity?.moveSpeed) ?? num(entity?.speed) ?? base.speed,
    sprintMul: base.sprintMul,
    accel: base.accel, decel: base.decel, turnRate: base.turnRate,
    attacks: base.attacks,
    summonAttack: base.summonAttack ?? null,
    ring: base.ring,
    vision: base.vision,
    hearing: base.hearing,
    noticeBeat: base.noticeBeat,
    patrol: base.patrol,
    ranged: base.ranged ?? null,
    summon: base.summon ?? null,
    flee: base.flee ?? null,
    tokenCost: base.tokenCost,
    tokenPool: base.tokenPool,
    stagger: base.stagger,
    unshakable: base.unshakable === true,
    isBoss: base.isBoss === true,
    lodBias: base.lodBias,
    hitAndRun: base.hitAndRun ?? null,
    phases: base.phases ?? null,
    enrage: base.enrage ?? null,
  };

  const hint = entity?.aiHint;
  if (hint && typeof hint === 'object') {
    for (const k of ['speed', 'radius', 'height', 'turnRate', 'hearing', 'tokenCost', 'lodBias', 'accel']) {
      const v = num(hint[k]);
      if (v != null) out[k] = v;
    }
    if (hint.vision && typeof hint.vision === 'object') out.vision = Object.assign({}, out.vision, hint.vision);
    if (hint.ranged === null) out.ranged = null;
    else if (hint.ranged && typeof hint.ranged === 'object') out.ranged = Object.assign({}, out.ranged ?? {}, hint.ranged);
    if (hint.flee === null) out.flee = null;
    if (Array.isArray(hint.attacks) && hint.attacks.length) out.attacks = hint.attacks;
  }

  // A grunt that is somehow 3 m across still needs a ring it fits in.
  const pad = Math.max(0, out.radius - (ARCHETYPES[key] ?? ARCHETYPES.grunt).radius);
  if (pad > 0.01) out.ring = { min: out.ring.min + pad, max: out.ring.max + pad * 1.4, orbit: out.ring.orbit, jitter: out.ring.jitter };
  return out;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

export { A as ATTACKS, DEG };
