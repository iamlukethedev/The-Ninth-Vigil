/**
 * SANCTUM — Damage model
 * ---------------------------------------------------------------------------
 * Pure-ish arithmetic layer for combat. No THREE, no scene access, no bus: the
 * resolver takes an attacker, a defender and an ability, and returns a fully
 * formed `damage` payload that CombatSystem emits. Keeping it separate means the
 * numbers can be reasoned about (and tuned) without touching hit detection or
 * presentation.
 *
 * What the model covers
 * ---------------------
 *   • six damage types — physical / fire / cold / lightning / poison / shadow
 *   • armour mitigation with diminishing returns, level-scaled
 *   • per-type resistance with a soft cap (40% linear, then 45% efficiency)
 *   • crit chance / crit damage, and a *brutal* tier above 2× base
 *   • glancing blows — an edge hit or a badly-outclassed swing lands soft
 *   • overkill, reported so death VFX can scale with the size of the finisher
 *   • damage-over-time stacks with their own tick clocks and stack caps
 *   • life-steal on the attacker, thorns on the defender
 *
 * Determinism: every roll comes from a seeded stream owned by CombatSystem.
 * No Math.random, no wall clock.
 */

/* ------------------------------------------------------------------ *
 * tables
 * ------------------------------------------------------------------ */

export const DAMAGE_TYPES = Object.freeze([
  'physical', 'fire', 'cold', 'lightning', 'poison', 'shadow',
]);

/** Hue per damage type. Cold base, warm punctuation — never a rainbow spread. */
export const TYPE_COLOR = Object.freeze({
  physical: 0xf2ead6,
  fire: 0xff7a24,
  cold: 0x8fd0ff,
  lightning: 0xcbb4ff,
  poison: 0x9fd23c,
  shadow: 0xa95cff,
});

/**
 * Floating-number tiers, using the project's rarity ramp
 * (white → blue → yellow → orange → red) so a crit reads at a glance.
 */
export const TIER_COLOR = Object.freeze({
  glance: 0x8e97a4,   // grey-blue, soft hit
  normal: 0xe9e1cd,   // bone white
  dot: 0x9fd23c,   // sickly green tick
  heal: 0x86d98f,
  crit: 0xffd469,   // gold
  brutal: 0xff9a34,   // orange
  execute: 0xff4636,   // red — the blow that killed
  player: 0xff5a4a,   // damage taken by the player
});

/**
 * Defence per species. The Bestiary's species table carries no armour or
 * resistances (it is a *body* description), so combat owns the combat stats.
 * Values are tuned against a level-12 hero doing ~46 base weapon damage.
 */
const DEFENCE = Object.freeze({
  skeleton: { armour: 120, res: { physical: 0.05, cold: 0.35, poison: 0.60, shadow: 0.25, fire: -0.15 } },
  ghoul: { armour: 180, res: { physical: 0.10, poison: 0.45, shadow: 0.20, fire: -0.10 } },
  cultist: { armour: 90, res: { shadow: 0.45, fire: 0.25, lightning: -0.10 } },
  hellhound: { armour: 140, res: { fire: 0.70, cold: -0.30, shadow: 0.10 } },
  brute: { armour: 460, res: { physical: 0.22, cold: 0.10, poison: 0.30, lightning: -0.15 } },
  wraith: { armour: 60, res: { physical: 0.45, shadow: 0.60, cold: 0.30, lightning: -0.25 } },
  boss: { armour: 900, res: { physical: 0.30, fire: 0.40, shadow: 0.35, cold: 0.20, poison: 0.25, lightning: 0.15 } },
});

/** Thorns (flat reflect) — only the armoured things bite back. */
const THORNS = Object.freeze({ brute: 7, boss: 14, skeleton: 0, ghoul: 0, cultist: 0, hellhound: 0, wraith: 0 });

/** Stagger resistance multiplier — how much of an impulse actually lands. */
const POISE = Object.freeze({
  skeleton: 1.15, ghoul: 0.9, cultist: 1.2, hellhound: 1.25, brute: 0.34, wraith: 1.0, boss: 0.06,
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/* ------------------------------------------------------------------ *
 * mitigation
 * ------------------------------------------------------------------ */

/**
 * Armour → fraction of physical/impact damage removed. Diminishing returns
 * against a level-scaled denominator, hard-capped so nothing is immune.
 */
export function armourFactor(armour, attackerLevel = 1) {
  const a = Math.max(0, num(armour));
  return clamp(a / (a + 620 + attackerLevel * 74), 0, 0.72);
}

/**
 * Resistance → fraction removed. Linear to 40%, then 45% efficiency, capped at
 * 75%. Negative resistance (a vulnerability) amplifies, uncapped to -100%.
 */
export function resistFactor(resist) {
  const r = num(resist);
  if (r <= 0) return Math.max(-1, r);
  return r <= 0.4 ? r : clamp(0.4 + (r - 0.4) * 0.45, 0, 0.75);
}

/** Read a defender's armour, resistance table, poise and thorns, whatever it is. */
export function defenceOf(entity) {
  if (!entity) return { armour: 0, res: null, poise: 1, thorns: 0, level: 1 };
  const cached = entity.__cmbDef;
  if (cached) return cached;

  const species = entity.species ?? entity.type ?? null;
  const table = species ? DEFENCE[species] : null;
  const stats = entity.stats ?? null;

  // Explicit stats win; then the species table; then a mass-derived guess so an
  // entity this file has never heard of still behaves sensibly.
  const mass = num(entity.mass, 80);
  let armour = num(stats?.armour, NaN);
  if (!Number.isFinite(armour)) armour = table ? table.armour : clamp(mass * 0.9, 40, 700);

  const eliteMul = entity.elite ? 1.35 : 1;
  const lvl = Math.max(1, num(entity.level, 1));
  const def = {
    armour: armour * eliteMul * (1 + (lvl - 1) * 0.05),
    res: stats?.resists ?? table?.res ?? null,
    poise: num(entity.poise, NaN) || (species ? POISE[species] ?? 1 : 1),
    thorns: num(stats?.thorns, NaN) || (species ? THORNS[species] ?? 0 : 0),
    level: lvl,
  };
  // Cache on the entity: species defence never changes, and this is queried on
  // every hit test of every swing.
  try { Object.defineProperty(entity, '__cmbDef', { value: def, enumerable: false, writable: true }); } catch { /* frozen — fine */ }
  return def;
}

/** Total mitigation multiplier applied to one hit. */
export function mitigate(amount, type, defence, attackerLevel) {
  let v = Math.max(0, amount);
  const physicalish = type === 'physical';
  if (physicalish) v *= 1 - armourFactor(defence.armour, attackerLevel);
  else v *= 1 - armourFactor(defence.armour, attackerLevel) * 0.35;   // armour helps a little vs elemental
  const r = defence.res ? defence.res[type] : 0;
  if (r) v *= 1 - resistFactor(r);
  return Math.max(0, v);
}

/* ------------------------------------------------------------------ *
 * resolver
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} HitContext
 * @property {*}      attacker
 * @property {*}      target
 * @property {object} ability   an entry from Abilities.js
 * @property {number} edge      0 = dead centre of the hit shape, 1 = grazing the rim
 * @property {object} point     {x,y,z} world contact point
 * @property {object} normal    {x,y,z} surface/impulse normal
 * @property {number} [mul]     extra multiplier (combo step, charge, tick)
 * @property {string} [type]    overrides the ability's damage type
 * @property {object} [defence] overrides the looked-up defence block
 * @property {boolean} [skipMitigation] the defender mitigates for itself
 *           (the Hero owns its own armour maths), so resolve the roll only
 * @property {number} [flat]    replaces the weapon-damage roll entirely
 */

export class DamageResolver {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {() => number} rand deterministic 0..1 stream owned by CombatSystem
   */
  constructor(engine, rand) {
    this.engine = engine;
    this.rand = rand;
    /** @type {Map<*, {stacks: object[]}>} */
    this.dots = new Map();
    this._dotSeq = 0;
    this.totals = { dealt: 0, taken: 0, hits: 0, crits: 0, kills: 0, overkill: 0 };
  }

  reset() {
    this.dots.clear();
    this._dotSeq = 0;
    this.totals.dealt = 0; this.totals.taken = 0; this.totals.hits = 0;
    this.totals.crits = 0; this.totals.kills = 0; this.totals.overkill = 0;
  }

  /* ------------------------------------------------------------ rolls */

  /** Base weapon/spell damage for an attacker before the ability multiplier. */
  baseOf(attacker) {
    const s = attacker?.stats;
    const d = num(s?.damage, NaN);
    if (Number.isFinite(d)) return d;
    return num(attacker?.damage, 12);
  }

  /**
   * Resolve one landed hit into a `damage` payload.
   * @param {HitContext} ctx
   * @returns {object|null}
   */
  resolve(ctx) {
    const { attacker, target, ability } = ctx;
    if (!target) return null;

    const type = ctx.type ?? ability?.type ?? 'physical';
    const stats = attacker?.stats ?? {};
    const level = Math.max(1, num(stats.level, 1));

    /* ---- base roll: ±12% spread so repeated hits never read as a spreadsheet ---- */
    const base = Number.isFinite(ctx.flat)
      ? ctx.flat * num(ctx.mul, 1)
      : this.baseOf(attacker) * num(ability?.damage, 1) * num(ctx.mul, 1);
    let amount = base * (0.88 + this.rand() * 0.24);

    /* ---- glancing: a rim hit, or a strike into something far above your level.
       Glances cannot crit — the two rolls are mutually exclusive on purpose, so
       the feedback is never "soft hit for a huge number". ---- */
    const defence = ctx.defence ?? defenceOf(target);
    const edge = clamp01(num(ctx.edge, 0));
    const outclassed = clamp01((defence.level - level) / 14);
    const glanceChance = clamp(num(ability?.glance, 1) * (0.05 + edge * edge * 0.30 + outclassed * 0.25), 0, 0.5);
    const glancing = ability?.noGlance ? false : this.rand() < glanceChance;

    let crit = false, brutal = false;
    if (glancing) {
      amount *= 0.52;
    } else {
      const cc = clamp01(num(stats.critChance, 0.05) + num(ability?.critBonus, 0));
      crit = this.rand() < cc;
      if (crit) {
        const cd = Math.max(1.05, num(stats.critDamage, 1.5) + num(ability?.critDamageBonus, 0));
        amount *= cd;
        brutal = cd >= 2.2 || amount >= base * 2.4;
      }
    }

    /* ---- mitigation ----
       `skipMitigation` exists because the Hero owns its own armour formula and
       applies it inside `applyDamage`. Running both would silently double-count
       every point of the player's armour. */
    const raw = amount;
    if (!ctx.skipMitigation) {
      amount = mitigate(amount, type, defence, level);
      // A hit always does *something*: chip damage keeps the fight legible.
      amount = Math.max(amount, raw * 0.06);
    }

    /* ---- resolve against the target's health ---- */
    const hp = num(target.hp, num(target.stats?.health, num(target.health, NaN)));
    const maxHp = num(target.maxHp, num(target.stats?.maxHealth, num(target.maxHealth, NaN)));
    const rounded = amount < 1 ? Math.max(1, Math.round(amount)) : Math.round(amount);
    const lethal = Number.isFinite(hp) && rounded >= hp;
    const overkill = lethal ? rounded - Math.max(0, hp) : 0;

    /* ---- impulse: mass-scaled, so a brute barely rocks and a skeleton flies ---- */
    const mass = Math.max(8, num(target.mass, 80));
    const weight = num(ability?.impact, 1) * (crit ? 1.45 : 1) * (glancing ? 0.45 : 1);
    const knock = clamp(weight * (240 / mass) * (0.55 + rounded / Math.max(24, maxHp || 120) * 2.4), 0, 6.5);
    const staggerAdd = num(ability?.stagger, 0.1) * weight * defence.poise
      * (1 + (Number.isFinite(maxHp) ? rounded / Math.max(1, maxHp) * 2.2 : 0.4));

    const tier = glancing ? 'glance'
      : lethal ? 'execute'
        : brutal ? 'brutal'
          : crit ? 'crit' : 'normal';

    this.totals.hits++;
    if (crit) this.totals.crits++;
    if (lethal) { this.totals.kills++; this.totals.overkill += overkill; }
    if (target.isHero) this.totals.taken += rounded; else this.totals.dealt += rounded;

    return {
      target,
      amount: rounded,
      type,
      crit,
      glancing,
      brutal,
      lethal,
      overkill,
      tier,
      hitPoint: ctx.point,
      hitNormal: ctx.normal,
      sourceId: attacker?.id ?? null,
      source: attacker ?? null,
      abilityId: ability?.id ?? null,
      abilityLabel: ability?.name ?? null,
      knockback: knock,
      stagger: staggerAdd,
      hitstop: num(ability?.hitstop, 0.06) * (crit ? 1.5 : 1) * (glancing ? 0.4 : 1),
      shake: num(ability?.shake, 0.05) * (crit ? 1.4 : 1) * (glancing ? 0.3 : 1),
      lifeSteal: Math.max(0, num(stats.lifeSteal, 0)) * rounded,
      thorns: defence.thorns > 0 ? defence.thorns * (1 + num(stats.level, 1) * 0.02) : 0,
      remainingHp: Number.isFinite(hp) ? Math.max(0, hp - rounded) : NaN,
      maxHp,
    };
  }

  /* -------------------------------------------------------------- dots */

  /**
   * Apply (or refresh) a damage-over-time stack.
   * @param {*} target
   * @param {{type:string, dps:number, duration:number, interval?:number,
   *          maxStacks?:number, sourceId?:*, source?:*, abilityId?:string}} spec
   */
  applyDot(target, spec) {
    if (!target || target.dead || target.isDead) return null;
    let rec = this.dots.get(target);
    if (!rec) this.dots.set(target, (rec = { stacks: [] }));
    const type = spec.type ?? 'poison';
    const maxStacks = Math.max(1, spec.maxStacks ?? 4);
    const same = rec.stacks.filter((s) => s.type === type && s.abilityId === spec.abilityId);
    if (same.length >= maxStacks) {
      // Refresh the shortest-lived stack instead of piling up forever.
      let oldest = same[0];
      for (const s of same) if (s.left < oldest.left) oldest = s;
      oldest.left = spec.duration;
      oldest.dps = Math.max(oldest.dps, spec.dps);
      return oldest;
    }
    const interval = Math.max(0.12, spec.interval ?? 0.5);
    const stack = {
      uid: ++this._dotSeq,
      type,
      dps: Math.max(0, spec.dps ?? 1),
      interval,
      next: interval,
      left: Math.max(interval, spec.duration ?? 3),
      sourceId: spec.sourceId ?? null,
      source: spec.source ?? null,
      abilityId: spec.abilityId ?? null,
    };
    rec.stacks.push(stack);
    return stack;
  }

  /** Number of live DoT stacks on a target (for HUD/AI reads). */
  dotStacks(target) { return this.dots.get(target)?.stacks.length ?? 0; }

  clearDots(target) { if (target) this.dots.delete(target); }

  /**
   * Tick every DoT. `onTick(payload)` is called once per stack per tick with a
   * complete `damage` payload — CombatSystem forwards it to the bus.
   */
  updateDots(dt, onTick) {
    if (!this.dots.size) return;
    for (const [target, rec] of this.dots) {
      const gone = target.dead || target.isDead || target.removeMe;
      if (gone) { this.dots.delete(target); continue; }
      for (let i = rec.stacks.length - 1; i >= 0; i--) {
        const s = rec.stacks[i];
        s.left -= dt;
        s.next -= dt;
        if (s.next <= 0) {
          s.next += s.interval;
          const defence = defenceOf(target);
          const raw = s.dps * s.interval;
          const amount = Math.max(1, Math.round(mitigate(raw, s.type, defence, 1)));
          const hp = num(target.hp, num(target.stats?.health, NaN));
          onTick?.({
            target,
            amount,
            type: s.type,
            crit: false,
            glancing: false,
            brutal: false,
            lethal: Number.isFinite(hp) && amount >= hp,
            overkill: 0,
            tier: 'dot',
            dot: true,
            hitPoint: null,
            hitNormal: null,
            sourceId: s.sourceId,
            source: s.source,
            abilityId: s.abilityId,
            knockback: 0,
            stagger: 0,
            hitstop: 0,
            shake: 0,
            lifeSteal: 0,
            thorns: 0,
            remainingHp: Number.isFinite(hp) ? Math.max(0, hp - amount) : NaN,
          });
        }
        if (s.left <= 0) rec.stacks.splice(i, 1);
      }
      if (!rec.stacks.length) this.dots.delete(target);
    }
  }
}

export { clamp, clamp01, num };
