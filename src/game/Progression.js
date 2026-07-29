/**
 * SANCTUM — Progression
 * ---------------------------------------------------------------------------
 * The character model behind the loot: equipment, stat recomputation, derived
 * combat numbers, set bonuses, the inventory, the XP curve, levels, attribute
 * and skill points, and the paragon post-cap. Plus the legendary-power hook
 * binder that makes an equipped aspect actually *do* something.
 *
 * Pure logic — no THREE, no DOM. The only engine surfaces it touches are
 * `engine.bus` (to emit) and `engine.get('hero')` (guarded, optional).
 *
 * ===========================================================================
 * HUD DATA CONTRACT
 * ===========================================================================
 * `progression.sheet()` returns, and is stable:
 *
 * {
 *   level, xp, xpNext, xpFrac,            // 0..1 bar fill
 *   paragon: { level, points, frac },
 *   points: { attribute, skill, paragon },
 *   attributes: { strength, dexterity, intelligence, willpower, vitality },
 *   attributeSources: { strength:{base,level,spent,gear}, … },
 *   derived: {
 *     life, lifeMax, armour, damageReduction, dps,
 *     damage:{min,max}, attackSpeed, critChance, critDamage,
 *     resistances:{fire,cold,lightning,poison,shadow}, resistCap,
 *     dodge, block, cdr, moveSpeed, thorns, lifeOnHit, lifeRegen,
 *     resource, resourceRegen, magicFind, goldFind
 *   },
 *   equipped: { helm:item|null, …, weapon, offhand },
 *   sets: [ { id, label, count, bonuses:[{pieces,text,active}] } ],
 *   powers: [ { id, name, hook, text, slot } ],
 *   inventory: { cols, rows, capacity, used, items:[item|null …] },  // row-major
 *   gold, potions:{count,max}, materials:{ id:count, … },
 *   emptySlots: [slotId …]
 * }
 *
 * `progression.compare(item)` returns the tooltip comparison block:
 * { slot, current, deltas:[ { label, from, to, delta, pct, better } ], scoreDelta }
 */

import { STATS, POWER_BY_ID } from './Affixes.js';
import {
  SLOT_IDS, SLOT_BY_ID, SETS, rarityRank, rarityInfo, aggregateStats, slotLabel,
} from './Items.js';

/* ==================================================================== *
 * curve
 * ==================================================================== */

export const LEVEL_CAP = 60;
export const PARAGON_CAP = 200;

/** XP required to advance FROM `level` to `level + 1`. */
export function xpForLevel(level) {
  const l = Math.max(1, level);
  return Math.round(360 * Math.pow(l, 1.58) + 90 * l + 240);
}

/** Cumulative XP required to reach `level` from 1. */
export function totalXpTo(level) {
  let sum = 0;
  for (let l = 1; l < Math.max(1, level); l++) sum += xpForLevel(l);
  return sum;
}

/** XP for one paragon level past the cap — flat-ish, climbing slowly. */
export function xpForParagon(p) {
  return Math.round(xpForLevel(LEVEL_CAP) * (1.0 + p * 0.055));
}

/** XP a monster of `level` and `rank` is worth. */
export function xpForKill(level, rank = 'normal') {
  const base = 26 + Math.pow(Math.max(1, level), 1.42) * 4.2;
  const mul = rank === 'boss' ? 26 : rank === 'champion' ? 4.2 : 1;
  return Math.round(base * mul);
}

/* ==================================================================== *
 * attributes
 * ==================================================================== */

export const ATTRIBUTES = [
  { id: 'strength', label: 'Strength', note: '+0.5 Armour, +0.1% Overpower' },
  { id: 'dexterity', label: 'Dexterity', note: '+0.02% Dodge, +0.03% Crit Chance' },
  { id: 'intelligence', label: 'Intelligence', note: '+0.05% All Resistance' },
  { id: 'willpower', label: 'Willpower', note: '+0.1% Healing, +0.25% Overpower' },
  { id: 'vitality', label: 'Vitality', note: '+3.5 Maximum Life' },
];
export const ATTRIBUTE_IDS = ATTRIBUTES.map((a) => a.id);

/** Class-flavoured baseline. SANCTUM has one hero archetype: a martial crusader. */
const ATTR_BASE = { strength: 12, dexterity: 9, intelligence: 7, willpower: 8, vitality: 11 };
const ATTR_PER_LEVEL = { strength: 1.4, dexterity: 0.9, intelligence: 0.6, willpower: 0.8, vitality: 1.2 };

/* ==================================================================== *
 * paragon
 * ==================================================================== */

/** A small, believable paragon board: glyph nodes bought with paragon points. */
export const PARAGON_GLYPHS = [
  { id: 'ire', label: 'Ire', stat: 'damagePct', per: 0.9, max: 40, theme: 'physical' },
  { id: 'bulwark', label: 'Bulwark', stat: 'armour', per: 22, max: 40, theme: 'physical' },
  { id: 'exhume', label: 'Exhume', stat: 'life', per: 34, max: 40, theme: 'blood' },
  { id: 'edict', label: 'Edict', stat: 'critDamage', per: 1.6, max: 30, theme: 'lightning' },
  { id: 'sealed', label: 'Sealed', stat: 'resAll', per: 0.5, max: 25, theme: 'holy' },
  { id: 'wanderer', label: 'Wanderer', stat: 'moveSpeed', per: 0.35, max: 25, theme: 'cold' },
];

/* ==================================================================== *
 * helpers
 * ==================================================================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = (v) => Math.round(v * 10) / 10;

function addBag(dst, src, mul = 1) {
  for (const k in src) {
    const v = src[k];
    if (v && typeof v === 'object' && 'min' in v) {
      const cur = dst[k] ?? { min: 0, max: 0 };
      dst[k] = { min: cur.min + v.min * mul, max: cur.max + v.max * mul };
    } else {
      dst[k] = (dst[k] ?? 0) + v * mul;
    }
  }
}

/* ==================================================================== *
 * Progression
 * ==================================================================== */

export class Progression {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {{level?:number, cols?:number, rows?:number}} [opts]
   */
  constructor(engine, opts = {}) {
    this.engine = engine;

    this.level = clamp(opts.level ?? 1, 1, LEVEL_CAP);
    this.xp = 0;
    this.xpNext = xpForLevel(this.level);
    this.paragon = 0;
    this.paragonXp = 0;
    this.paragonNext = xpForParagon(0);

    this.attributePoints = 0;
    this.skillPoints = 0;
    this.paragonPoints = 0;
    this.spent = { strength: 0, dexterity: 0, intelligence: 0, willpower: 0, vitality: 0 };
    this.glyphs = Object.create(null);
    for (const g of PARAGON_GLYPHS) this.glyphs[g.id] = 0;

    this.equipped = Object.create(null);
    for (const s of SLOT_IDS) this.equipped[s] = null;

    const cols = opts.cols ?? 10;
    const rows = opts.rows ?? 6;
    this.inventory = { cols, rows, capacity: cols * rows, items: new Array(cols * rows).fill(null) };

    this.gold = 0;
    this.potions = { count: 4, max: 4 };
    this.materials = Object.create(null);

    /** Cached recomputed state — never read directly, use `derived`. */
    this._derived = null;
    this._bag = Object.create(null);
    this._sets = [];
    this._powers = [];
    this._cooldowns = Object.create(null);
    this._offs = [];
    this._procBudget = 0;

    this.recompute();
  }

  /* ---------------------------------------------------------------- xp */

  /** Award XP; cascades through levels and into paragon past the cap. */
  gainXp(amount) {
    let n = Math.max(0, Math.round(amount || 0));
    if (!n) return null;
    let levelled = null;

    while (n > 0) {
      if (this.level < LEVEL_CAP) {
        const need = this.xpNext - this.xp;
        if (n < need) { this.xp += n; n = 0; break; }
        n -= need;
        this.level++;
        this.xp = 0;
        this.xpNext = xpForLevel(this.level);
        this.attributePoints += 5;
        this.skillPoints += this.level % 2 === 0 ? 1 : 0;
        levelled = this.level;
      } else {
        if (this.paragon >= PARAGON_CAP) { this.xp = this.xpNext; break; }
        const need = this.paragonNext - this.paragonXp;
        if (n < need) { this.paragonXp += n; n = 0; break; }
        n -= need;
        this.paragon++;
        this.paragonXp = 0;
        this.paragonNext = xpForParagon(this.paragon);
        this.paragonPoints += 1;
        levelled = LEVEL_CAP;
      }
    }

    if (levelled != null) {
      this.recompute();
      try {
        this.engine.bus.emit('level:up', {
          level: this.level,
          paragon: this.paragon,
          stats: this.derived,
          points: { attribute: this.attributePoints, skill: this.skillPoints, paragon: this.paragonPoints },
        });
      } catch { /* presentation only */ }
    }
    return levelled;
  }

  spendAttribute(attr, n = 1) {
    if (!(attr in this.spent)) return false;
    const k = Math.min(n, this.attributePoints);
    if (k <= 0) return false;
    this.spent[attr] += k;
    this.attributePoints -= k;
    this.recompute();
    return true;
  }

  spendGlyph(id, n = 1) {
    const g = PARAGON_GLYPHS.find((x) => x.id === id);
    if (!g) return false;
    const room = g.max - (this.glyphs[id] ?? 0);
    const k = Math.min(n, this.paragonPoints, room);
    if (k <= 0) return false;
    this.glyphs[id] += k;
    this.paragonPoints -= k;
    this.recompute();
    return true;
  }

  /* --------------------------------------------------------- inventory */

  get freeSlots() {
    let n = 0;
    for (const it of this.inventory.items) if (!it) n++;
    return n;
  }
  get isFull() { return this.freeSlots === 0; }

  /** @returns {number} grid index, or -1 if the bag is full. */
  addToInventory(item) {
    const inv = this.inventory;
    for (let i = 0; i < inv.items.length; i++) {
      if (!inv.items[i]) { inv.items[i] = item; item.bagIndex = i; return i; }
    }
    return -1;
  }

  removeFromInventory(item) {
    const inv = this.inventory;
    const i = typeof item === 'number' ? item : inv.items.indexOf(item);
    if (i < 0 || i >= inv.items.length) return null;
    const it = inv.items[i];
    inv.items[i] = null;
    if (it) it.bagIndex = -1;
    return it;
  }

  moveInInventory(from, to) {
    const inv = this.inventory;
    if (from < 0 || to < 0 || from >= inv.items.length || to >= inv.items.length) return false;
    const a = inv.items[from], b = inv.items[to];
    inv.items[to] = a; inv.items[from] = b;
    if (a) a.bagIndex = to;
    if (b) b.bagIndex = from;
    return true;
  }

  addGold(n) { this.gold = Math.max(0, this.gold + Math.round(n || 0)); return this.gold; }

  addMaterial(id, n = 1) {
    this.materials[id] = (this.materials[id] ?? 0) + Math.max(1, Math.round(n));
    return this.materials[id];
  }

  addPotion(n = 1) {
    const before = this.potions.count;
    this.potions.count = Math.min(this.potions.max, this.potions.count + n);
    return this.potions.count > before;
  }

  /* --------------------------------------------------------- equipment */

  /**
   * Equip an item, auto-choosing between ring1/ring2, and returning whatever
   * came off. The replaced item is pushed back into the bag if there is room.
   */
  equip(item, slotOverride = null) {
    if (!item || item.kind !== 'gear') return { ok: false, replaced: null };
    let slot = slotOverride ?? item.slot;
    if (slot === 'ring1' || slot === 'ring2') {
      if (!slotOverride) slot = !this.equipped.ring1 ? 'ring1' : !this.equipped.ring2 ? 'ring2' : this._worseRing();
    }
    if (!SLOT_BY_ID.has(slot)) return { ok: false, replaced: null };

    const replaced = this.equipped[slot] ?? null;
    if (item.bagIndex >= 0 && this.inventory.items[item.bagIndex] === item) this.removeFromInventory(item.bagIndex);
    this.equipped[slot] = item;
    item.equippedSlot = slot;

    /* two-handers clear the off-hand */
    let bumped = null;
    if (slot === 'weapon' && item.hands === 2 && this.equipped.offhand) {
      bumped = this.equipped.offhand;
      this.equipped.offhand = null;
      bumped.equippedSlot = null;
      this.addToInventory(bumped);
    }
    if (slot === 'offhand' && this.equipped.weapon?.hands === 2) {
      bumped = this.equipped.weapon;
      this.equipped.weapon = null;
      bumped.equippedSlot = null;
      this.addToInventory(bumped);
    }

    if (replaced) { replaced.equippedSlot = null; this.addToInventory(replaced); }
    this.recompute();
    return { ok: true, slot, replaced, bumped };
  }

  _worseRing() {
    const a = this.equipped.ring1, b = this.equipped.ring2;
    if (!a) return 'ring1';
    if (!b) return 'ring2';
    return this.score(a) <= this.score(b) ? 'ring1' : 'ring2';
  }

  unequip(slot) {
    const it = this.equipped[slot];
    if (!it) return null;
    if (this.isFull) return null;
    this.equipped[slot] = null;
    it.equippedSlot = null;
    this.addToInventory(it);
    this.recompute();
    return it;
  }

  /** Crude power score — drives auto-equip and the tooltip's "upgrade" arrow. */
  score(item) {
    if (!item || item.kind !== 'gear') return 0;
    let s = (item.armour ?? 0) * 0.5 + (item.dps ?? 0) * 1.6 + item.ilvl * 2.2;
    s += rarityRank(item.rarity) * 24;
    for (const a of item.affixes) s += (a.value ?? 0) * (STATS[a.stat]?.kind === 'pct' ? 3.2 : 0.7);
    if (item.implicit) s += (item.implicit.value ?? 0) * 0.5;
    s += item.powers.length * 90;
    for (const so of item.sockets) if (so.gem) s += 30 + so.gem.grade * 22;
    return Math.round(s);
  }

  /* ------------------------------------------------------- computation */

  get derived() {
    if (!this._derived) this.recompute();
    return this._derived;
  }
  get statBag() {
    if (!this._derived) this.recompute();
    return this._bag;
  }
  get sets() { if (!this._derived) this.recompute(); return this._sets; }
  get powers() { if (!this._derived) this.recompute(); return this._powers; }

  /** Rebuild the flat stat bag, the set bonuses, the powers, and the derived block. */
  recompute() {
    const bag = Object.create(null);

    /* gear */
    for (const s of SLOT_IDS) {
      const it = this.equipped[s];
      if (!it) continue;
      addBag(bag, it.stats ?? aggregateStats(it));
    }

    /* set bonuses */
    const counts = Object.create(null);
    for (const s of SLOT_IDS) {
      const id = this.equipped[s]?.set;
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    const setList = [];
    for (const id in counts) {
      const def = SETS[id];
      if (!def) continue;
      const n = counts[id];
      const bonuses = def.bonuses.map((b) => {
        const active = n >= b.pieces;
        if (active) addBag(bag, b.stats);
        return { pieces: b.pieces, text: b.text, active };
      });
      setList.push({ id, label: def.label, short: def.short, count: n, total: def.slots.length, bonuses });
    }
    this._sets = setList;

    /* paragon glyphs */
    for (const g of PARAGON_GLYPHS) {
      const n = this.glyphs[g.id] ?? 0;
      if (n) bag[g.stat] = (bag[g.stat] ?? 0) + n * g.per;
    }

    /* legendary powers */
    const powers = [];
    for (const s of SLOT_IDS) {
      const it = this.equipped[s];
      if (!it) continue;
      for (const p of it.powers ?? []) {
        powers.push({ ...p, slot: s, itemUid: it.uid, itemName: it.name });
      }
    }
    this._powers = powers;
    this._bag = bag;

    /* attributes */
    const attrs = Object.create(null);
    const sources = Object.create(null);
    const allStat = bag.allStats ?? 0;
    for (const id of ATTRIBUTE_IDS) {
      const base = ATTR_BASE[id];
      const lvl = Math.round(ATTR_PER_LEVEL[id] * (this.level - 1));
      const spent = this.spent[id] ?? 0;
      const gear = Math.round((bag[id] ?? 0) + allStat);
      attrs[id] = base + lvl + spent + gear;
      sources[id] = { base, level: lvl, spent, gear };
    }
    this.attributes = attrs;
    this.attributeSources = sources;

    /* ---- derived combat numbers ---- */
    const w = this.equipped.weapon;
    const lvl = this.level;

    const lifeFlat = 42 + lvl * 11 + attrs.vitality * 3.5 + (bag.life ?? 0);
    const lifeMax = Math.round(lifeFlat * (1 + (bag.lifePct ?? 0) / 100));

    const armourRaw = 8 + lvl * 2.4 + attrs.strength * 0.5 + (bag.armour ?? 0);
    const armour = Math.round(armourRaw * (1 + (bag.armourPct ?? 0) / 100));
    const armourDR = clamp(armour / (armour + 42 * lvl + 320), 0, 0.85);

    const mainStat = attrs.strength;
    const statMul = 1 + mainStat * 0.008;
    const dmgMul = statMul * (1 + (bag.damagePct ?? 0) / 100);

    const wMin = w?.damage?.min ?? Math.round(4 + lvl * 1.4);
    const wMax = w?.damage?.max ?? Math.round(7 + lvl * 2.2);
    const addMin = (bag.physical?.min ?? 0) + (bag.fire?.min ?? 0) + (bag.cold?.min ?? 0) +
      (bag.lightning?.min ?? 0) + (bag.shadow?.min ?? 0);
    const addMax = (bag.physical?.max ?? 0) + (bag.fire?.max ?? 0) + (bag.cold?.max ?? 0) +
      (bag.lightning?.max ?? 0) + (bag.shadow?.max ?? 0);
    const dmgMin = Math.round((wMin + addMin) * dmgMul);
    const dmgMax = Math.round((wMax + addMax) * dmgMul);

    const aps = r1((w?.attackSpeed ?? 1.1) * (1 + (bag.attackSpeed ?? 0) / 100));
    const critChance = clamp(5 + attrs.dexterity * 0.03 + (bag.critChance ?? 0), 0, 100);
    const critDamage = 50 + (bag.critDamage ?? 0) + attrs.willpower * 0.05;
    const avg = (dmgMin + dmgMax) / 2 * (1 + (critChance / 100) * (critDamage / 100));
    const dps = Math.round(avg * aps);

    const resAll = bag.resAll ?? 0;
    const intRes = attrs.intelligence * 0.05;
    const resistCap = 70;
    const res = {
      fire: clamp(r1((bag.resFire ?? 0) + resAll + intRes), -60, resistCap),
      cold: clamp(r1((bag.resCold ?? 0) + resAll + intRes), -60, resistCap),
      lightning: clamp(r1((bag.resLightning ?? 0) + resAll + intRes), -60, resistCap),
      poison: clamp(r1((bag.resPoison ?? 0) + resAll + intRes), -60, resistCap),
      shadow: clamp(r1((bag.resShadow ?? 0) + resAll + intRes), -60, resistCap),
    };

    this._derived = {
      level: lvl,
      life: lifeMax,
      lifeMax,
      armour,
      damageReduction: Math.round(armourDR * 1000) / 10,
      damage: { min: dmgMin, max: dmgMax },
      dps,
      attackSpeed: aps,
      critChance: r1(critChance),
      critDamage: r1(critDamage),
      resistances: res,
      resistCap,
      dodge: clamp(r1((bag.dodge ?? 0) + attrs.dexterity * 0.02), 0, 60),
      block: clamp(r1(bag.blockChance ?? 0), 0, 75),
      blockAmount: clamp(r1(15 + (bag.blockAmount ?? 0)), 0, 100),
      cdr: clamp(r1(bag.cdr ?? 0), 0, 60),
      moveSpeed: clamp(r1(bag.moveSpeed ?? 0), -50, 60),
      thorns: Math.round(bag.thorns ?? 0),
      lifeOnHit: Math.round(bag.lifeOnHit ?? 0),
      lifeRegen: r1(bag.lifeRegen ?? 0),
      resource: Math.round(80 + lvl * 1.5 + (bag.resource ?? 0)),
      resourceRegen: r1(bag.resourceRegen ?? 0),
      barrier: r1(bag.barrier ?? 0),
      healing: r1(bag.healing ?? 0),
      overpower: r1((bag.overpower ?? 0) + attrs.strength * 0.1 + attrs.willpower * 0.25),
      areaDamage: r1(bag.areaDamage ?? 0),
      vsElites: r1(bag.vsElites ?? 0),
      vsInjured: r1(bag.vsInjured ?? 0),
      dotPotency: r1(bag.dotPotency ?? 0),
      magicFind: r1(bag.magicFind ?? 0),
      goldFind: r1(bag.goldFind ?? 0),
      potionCharges: 4 + Math.round(bag.potionCharge ?? 0),
      itemPower: this._avgItemPower(),
    };
    this.potions.max = this._derived.potionCharges;
    this.potions.count = Math.min(this.potions.count, this.potions.max);
    return this._derived;
  }

  _avgItemPower() {
    let sum = 0, n = 0;
    for (const s of SLOT_IDS) { const it = this.equipped[s]; if (it) { sum += it.ilvl; n++; } }
    return n ? Math.round(sum / n) : 0;
  }

  /**
   * Push the recomputed numbers onto the Hero so combat uses them. Guarded —
   * Hero may be absent, and we never overwrite fields it does not declare.
   */
  syncHero() {
    const hero = this.engine.get?.('hero');
    if (!hero || hero.__dead || !hero.stats) return false;
    const d = this.derived;
    const s = hero.stats;
    const frac = s.maxHealth > 0 ? s.health / s.maxHealth : 1;
    s.level = this.level;
    s.maxHealth = d.lifeMax;
    s.health = Math.max(1, Math.round(d.lifeMax * frac));
    s.maxResource = d.resource;
    s.resource = Math.min(s.resource ?? d.resource, d.resource);
    s.armour = d.armour;
    s.damage = Math.round((d.damage.min + d.damage.max) / 2);
    s.critChance = d.critChance / 100;
    s.critDamage = 1 + d.critDamage / 100;
    if (typeof hero.maxHealth === 'number') hero.maxHealth = d.lifeMax;
    return true;
  }

  /* -------------------------------------------------------- comparison */

  /**
   * Tooltip comparison against whatever occupies the item's slot.
   * Never mutates state — it clones the bag maths, it does not equip.
   */
  compare(item) {
    if (!item || item.kind !== 'gear') return null;
    let slot = item.slot;
    if (slot === 'ring1' || slot === 'ring2') {
      slot = !this.equipped.ring1 ? 'ring1' : !this.equipped.ring2 ? 'ring2' : this._worseRing();
    }
    const cur = this.equipped[slot] ?? null;

    const rows = [];
    const push = (label, from, to, higherIsBetter = true, unit = '') => {
      const d = to - from;
      if (Math.abs(d) < 0.05) return;
      rows.push({
        label, from: r1(from), to: r1(to), delta: r1(d), unit,
        pct: from > 0 ? Math.round((d / from) * 1000) / 10 : null,
        better: higherIsBetter ? d > 0 : d < 0,
      });
    };

    push('Armour', cur?.armour ?? 0, item.armour ?? 0);
    push('Damage per Second', cur?.dps ?? 0, item.dps ?? 0);
    push('Item Power', cur?.ilvl ?? 0, item.ilvl ?? 0);

    /* stat-by-stat, union of both bags */
    const a = cur ? (cur.stats ?? aggregateStats(cur)) : {};
    const b = item.stats ?? aggregateStats(item);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const meta = STATS[k];
      if (!meta) continue;
      const va = a[k], vb = b[k];
      if (meta.kind === 'range') {
        const fa = va ? (va.min + va.max) / 2 : 0;
        const fb = vb ? (vb.min + vb.max) / 2 : 0;
        push(meta.label, fa, fb);
      } else {
        push(meta.label, va ?? 0, vb ?? 0);
      }
    }

    return {
      slot,
      slotLabel: slotLabel(slot),
      current: cur,
      currentName: cur?.name ?? null,
      deltas: rows,
      scoreDelta: this.score(item) - this.score(cur),
      upgrade: this.score(item) > this.score(cur),
    };
  }

  /* ------------------------------------------------------------- sheet */

  sheet() {
    const d = this.derived;
    const empty = [];
    for (const s of SLOT_IDS) if (!this.equipped[s]) empty.push(s);
    return {
      level: this.level,
      levelCap: LEVEL_CAP,
      xp: this.xp,
      xpNext: this.xpNext,
      xpFrac: this.level >= LEVEL_CAP ? this.paragonXp / this.paragonNext : this.xp / this.xpNext,
      paragon: { level: this.paragon, cap: PARAGON_CAP, points: this.paragonPoints, frac: this.paragonXp / this.paragonNext },
      points: { attribute: this.attributePoints, skill: this.skillPoints, paragon: this.paragonPoints },
      attributes: { ...this.attributes },
      attributeSources: this.attributeSources,
      attributeDefs: ATTRIBUTES,
      derived: d,
      equipped: { ...this.equipped },
      sets: this._sets,
      powers: this._powers,
      glyphs: { ...this.glyphs },
      glyphDefs: PARAGON_GLYPHS,
      inventory: {
        cols: this.inventory.cols,
        rows: this.inventory.rows,
        capacity: this.inventory.capacity,
        used: this.inventory.capacity - this.freeSlots,
        items: this.inventory.items,
      },
      gold: this.gold,
      potions: { ...this.potions },
      materials: { ...this.materials },
      emptySlots: empty,
    };
  }

  /* ============================================================== *
   * legendary power hooks — behaviour, not numbers
   * ============================================================== */

  /**
   * Bind the live hooks. Aspects fire real events:
   *   • self-effects (barrier / heal / buff) are applied to the Hero directly
   *     through its own guarded public API;
   *   • world effects (nova / chain / zone / dot) are announced as
   *     `'power:proc'` {power, effect, origin, radius, element, amount} plus an
   *     `'impact'` for VFX/audio, so CombatSystem and VFXSystem can consume
   *     them without Progression reaching into either module.
   * Every proc is cooldown-gated and the per-frame proc budget is capped, so a
   * pack wipe cannot avalanche the bus.
   */
  bindHooks() {
    this.unbindHooks();
    const bus = this.engine.bus;
    this._offs.push(bus.on('death', (p) => this._onKill(p)));
    this._offs.push(bus.on('damage', (p) => this._onDamage(p)));
    this._offs.push(bus.on('ability:cast', (p) => this._onCast(p)));
  }

  unbindHooks() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
  }

  /** Called once per sim frame by Loot so cooldowns and the budget advance. */
  tick() { this._procBudget = 3; }

  _ready(id, cd) {
    const t = this.engine.clock.elapsed;
    if ((this._cooldowns[id] ?? -1e9) + cd > t) return false;
    if (this._procBudget <= 0) return false;
    this._cooldowns[id] = t;
    this._procBudget--;
    return true;
  }

  _isHero(e) {
    const hero = this.engine.get?.('hero');
    return !!e && !!hero && (e === hero || e === hero.root);
  }

  _proc(power, origin, extra = {}) {
    const eff = power.effect ?? {};
    try {
      this.engine.bus.emit('power:proc', {
        id: power.id, name: power.name, hook: power.hook, value: power.value,
        effect: eff, element: eff.element ?? 'physical', origin, ...extra,
      });
      if (origin) {
        this.engine.bus.emit('impact', {
          point: origin,
          normal: { x: 0, y: 1, z: 0 },
          kind: eff.element ?? 'arcane',
          magnitude: eff.kind === 'nova' ? 1.6 : 0.8,
        });
      }
    } catch { /* presentation only */ }
  }

  _onKill(p) {
    if (!p || !this._powers.length) return;
    if (!this._isHero(p.killer)) return;
    const at = p.hitPoint ?? p.entity?.position ?? null;
    for (const power of this._powers) {
      if (power.hook !== 'onKill') continue;
      const eff = power.effect ?? {};
      if (!this._ready(`kill:${power.id}`, eff.cooldown ?? 0.35)) continue;
      if (eff.kind === 'restore') this._healHero((eff.value ?? 4) / 100);
      else if (eff.kind === 'buff') this._buff(power);
      this._proc(power, at, { radius: eff.radius ?? 4 });
    }
  }

  _onDamage(p) {
    if (!p || !this._powers.length) return;
    if (!p.__fromHero && !this._isHero(p.source ?? p.attacker)) return;
    const at = p.hitPoint ?? null;
    for (const power of this._powers) {
      const eff = power.effect ?? {};
      if (power.hook === 'onCrit' && p.crit) {
        if (!this._ready(`crit:${power.id}`, eff.cooldown ?? 0.5)) continue;
        this._proc(power, at, { target: p.target, radius: eff.radius ?? 6 });
      } else if (power.hook === 'onHit') {
        if (!this._ready(`hit:${power.id}`, eff.cooldown ?? 0.75)) continue;
        this._proc(power, at, { target: p.target });
      }
    }
    if (this._bag.lifeOnHit) this._healFlat(this._bag.lifeOnHit);
  }

  _onCast(p) {
    if (!p || !this._powers.length) return;
    if (!this._isHero(p.caster)) return;
    const dash = typeof p.id === 'string' && /dash|evade|charge|leap/i.test(p.id);
    if (!dash) return;
    for (const power of this._powers) {
      if (power.hook !== 'onDash') continue;
      if (!this._ready(`dash:${power.id}`, power.effect?.cooldown ?? 1.2)) continue;
      this._proc(power, p.origin ?? null, { radius: power.effect?.radius ?? 3 });
    }
  }

  _healHero(frac) {
    const hero = this.engine.get?.('hero');
    if (!hero || hero.__dead) return;
    const amt = (hero.stats?.maxHealth ?? this.derived.lifeMax) * frac;
    hero.heal?.(amt);
  }
  _healFlat(n) {
    const hero = this.engine.get?.('hero');
    if (!hero || hero.__dead || !n) return;
    hero.heal?.(n);
  }
  _buff(power) {
    try {
      this.engine.bus.emit('power:buff', {
        id: power.id, stat: power.effect?.stat, value: power.value,
        duration: power.effect?.duration ?? 3, stacks: power.effect?.stacks ?? 1,
      });
    } catch { /* noop */ }
  }

  /** Human-readable text for a bound power, for the character sheet. */
  powerLines() {
    return this._powers.map((p) => ({
      id: p.id, name: p.name, hook: p.hook, slot: p.slot, slotLabel: slotLabel(p.slot),
      text: p.text ?? POWER_BY_ID.get(p.id)?.text?.(p.value) ?? '',
      itemName: p.itemName, rarity: 'legendary', frame: rarityInfo('legendary'),
    }));
  }

  dispose() { this.unbindHooks(); }
}

export default Progression;
