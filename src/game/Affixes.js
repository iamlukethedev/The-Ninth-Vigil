/**
 * SANCTUM — Affixes
 * ---------------------------------------------------------------------------
 * The affix pool, the tier tables, the weighted roller, the legendary powers,
 * and the procedural name generator. Pure data + pure functions: nothing here
 * touches THREE, the scene, or the DOM, so it can be exercised from anywhere
 * and is trivially deterministic.
 *
 * Design
 * ------
 * • **Tiers, not curves.** Every affix is a ladder of discrete tiers, each with
 *   an item-level gate and a value band. This is what makes an ARPG loot drop
 *   legible: "Ferocity (T4)" is a comparable, nameable thing, and a T7 roll on
 *   an ilvl 70 item is a real event. Values roll uniformly inside the band and
 *   the normalised roll is retained as `q` so the tooltip can draw a fill bar.
 * • **Weighted eligibility.** Affix weight is (base weight) x (slot affinity).
 *   Tier weight decays with distance below the highest tier the item level
 *   unlocks, so high-ilvl items mostly roll high tiers but can still disappoint,
 *   which is the entire emotional engine of the genre.
 * • **Legendary powers change behaviour.** Every power declares a `hook`
 *   (onKill / onCrit / onHit / onDash / passive / aura) plus an `effect` payload.
 *   Progression.js binds live bus handlers for the hooks, so an equipped aspect
 *   actually does something instead of adding a number with a fancier font.
 * • **Determinism.** Every function takes an explicit `rand` (from
 *   `engine.freshRand(seed)`). No Math.random, no Date.now, no module state.
 *
 * Public surface
 * --------------
 *   STATS, STAT_ORDER, DAMAGE_TYPES
 *   AFFIXES, AFFIX_BY_ID, affixCandidates(), rollAffix(), rollAffixSet()
 *   LEGENDARY_POWERS, rollPower(), powerText()
 *   nameItem(), flavourFor()
 */

/* ==================================================================== *
 * stats
 * ==================================================================== */

/**
 * Every stat an affix can touch. `kind` drives aggregation in Progression:
 *   flat  — summed
 *   pct   — summed as a percentage, applied multiplicatively once
 *   range — summed as a {min,max} pair
 *   flag  — boolean / structured payload from a legendary power
 */
export const STATS = {
  strength:     { label: 'Strength',            kind: 'flat', fmt: (v) => `+${v} Strength` },
  dexterity:    { label: 'Dexterity',           kind: 'flat', fmt: (v) => `+${v} Dexterity` },
  intelligence: { label: 'Intelligence',        kind: 'flat', fmt: (v) => `+${v} Intelligence` },
  willpower:    { label: 'Willpower',           kind: 'flat', fmt: (v) => `+${v} Willpower` },
  vitality:     { label: 'Vitality',            kind: 'flat', fmt: (v) => `+${v} Vitality` },
  allStats:     { label: 'All Attributes',      kind: 'flat', fmt: (v) => `+${v} to All Attributes` },

  armour:       { label: 'Armour',              kind: 'flat', fmt: (v) => `+${v} Armour` },
  armourPct:    { label: 'Armour %',            kind: 'pct',  fmt: (v) => `+${v}% Total Armour` },
  life:         { label: 'Maximum Life',        kind: 'flat', fmt: (v) => `+${v} Maximum Life` },
  lifePct:      { label: 'Maximum Life %',      kind: 'pct',  fmt: (v) => `+${v}% Maximum Life` },
  lifeOnHit:    { label: 'Life on Hit',         kind: 'flat', fmt: (v) => `+${v} Life on Hit` },
  lifeRegen:    { label: 'Life Regeneration',   kind: 'flat', fmt: (v) => `+${v} Life per Second` },
  barrier:      { label: 'Barrier Generation',  kind: 'pct',  fmt: (v) => `+${v}% Barrier Generation` },
  healing:      { label: 'Healing Received',    kind: 'pct',  fmt: (v) => `+${v}% Healing Received` },

  damagePct:    { label: 'Damage',              kind: 'pct',  fmt: (v) => `+${v}% Damage` },
  physical:     { label: 'Physical Damage',     kind: 'range', fmt: (a, b) => `Adds ${a}–${b} Physical Damage` },
  fire:         { label: 'Fire Damage',         kind: 'range', fmt: (a, b) => `Adds ${a}–${b} Fire Damage` },
  cold:         { label: 'Cold Damage',         kind: 'range', fmt: (a, b) => `Adds ${a}–${b} Cold Damage` },
  lightning:    { label: 'Lightning Damage',    kind: 'range', fmt: (a, b) => `Adds ${a}–${b} Lightning Damage` },
  shadow:       { label: 'Shadow Damage',       kind: 'range', fmt: (a, b) => `Adds ${a}–${b} Shadow Damage` },
  critChance:   { label: 'Critical Strike Chance', kind: 'pct', fmt: (v) => `+${v}% Critical Strike Chance` },
  critDamage:   { label: 'Critical Strike Damage', kind: 'pct', fmt: (v) => `+${v}% Critical Strike Damage` },
  attackSpeed:  { label: 'Attack Speed',        kind: 'pct',  fmt: (v) => `+${v}% Attack Speed` },
  areaDamage:   { label: 'Area Damage',         kind: 'pct',  fmt: (v) => `+${v}% Area Damage` },
  overpower:    { label: 'Overpower Damage',    kind: 'pct',  fmt: (v) => `+${v}% Overpower Damage` },
  vsElites:     { label: 'Damage to Elites',    kind: 'pct',  fmt: (v) => `+${v}% Damage to Elites` },
  vsInjured:    { label: 'Damage to Injured',   kind: 'pct',  fmt: (v) => `+${v}% Damage to Injured Enemies` },
  dotPotency:   { label: 'Damage over Time',    kind: 'pct',  fmt: (v) => `+${v}% Damage over Time` },
  thorns:       { label: 'Thorns',              kind: 'flat', fmt: (v) => `${v} Thorns` },

  resFire:      { label: 'Fire Resistance',      kind: 'pct', fmt: (v) => `+${v}% Fire Resistance` },
  resCold:      { label: 'Cold Resistance',      kind: 'pct', fmt: (v) => `+${v}% Cold Resistance` },
  resLightning: { label: 'Lightning Resistance', kind: 'pct', fmt: (v) => `+${v}% Lightning Resistance` },
  resPoison:    { label: 'Poison Resistance',    kind: 'pct', fmt: (v) => `+${v}% Poison Resistance` },
  resShadow:    { label: 'Shadow Resistance',    kind: 'pct', fmt: (v) => `+${v}% Shadow Resistance` },
  resAll:       { label: 'All Resistance',       kind: 'pct', fmt: (v) => `+${v}% Resistance to All Elements` },

  blockChance:  { label: 'Block Chance',        kind: 'pct',  fmt: (v) => `+${v}% Block Chance` },
  blockAmount:  { label: 'Blocked Damage',      kind: 'pct',  fmt: (v) => `+${v}% Blocked Damage Reduction` },
  dodge:        { label: 'Dodge Chance',        kind: 'pct',  fmt: (v) => `+${v}% Dodge Chance` },
  cdr:          { label: 'Cooldown Reduction',  kind: 'pct',  fmt: (v) => `+${v}% Cooldown Reduction` },
  resource:     { label: 'Maximum Resource',    kind: 'flat', fmt: (v) => `+${v} Maximum Resource` },
  resourceRegen:{ label: 'Resource Regeneration', kind: 'pct', fmt: (v) => `+${v}% Resource Generation` },
  moveSpeed:    { label: 'Movement Speed',      kind: 'pct',  fmt: (v) => `+${v}% Movement Speed` },
  magicFind:    { label: 'Magic Find',          kind: 'pct',  fmt: (v) => `+${v}% Magic Find` },
  goldFind:     { label: 'Extra Gold',          kind: 'pct',  fmt: (v) => `+${v}% Gold from Monsters` },
  potionCharge: { label: 'Potion Capacity',     kind: 'flat', fmt: (v) => `+${v} Potion Charges` },
};

/** Display order used by the character sheet. */
export const STAT_ORDER = [
  'strength', 'dexterity', 'intelligence', 'willpower', 'vitality',
  'life', 'armour', 'damagePct', 'critChance', 'critDamage', 'attackSpeed',
  'resFire', 'resCold', 'resLightning', 'resPoison', 'resShadow',
  'moveSpeed', 'cdr', 'dodge', 'thorns', 'magicFind', 'goldFind',
];

export const DAMAGE_TYPES = ['physical', 'fire', 'cold', 'lightning', 'shadow'];

/** Element theming — drives name words, beam tint hints and icon gem colour. */
export const ELEMENT_THEME = {
  physical: { word: 'Iron',   noun: 'Reckoning', col: 0xb9c0c9 },
  fire:     { word: 'Ashen',  noun: 'Pyre',      col: 0xff6a22 },
  cold:     { word: 'Hoar',   noun: 'Silence',   col: 0x76c8e6 },
  lightning:{ word: 'Storm',  noun: 'Fulmen',    col: 0xc9a6ff },
  shadow:   { word: 'Umbral', noun: 'Vigil',     col: 0x8a6adf },
  holy:     { word: 'Hallowed', noun: 'Choir',   col: 0xf0dca0 },
  blood:    { word: 'Crimson', noun: 'Tithe',    col: 0xc0322e },
  decay:    { word: 'Blighted', noun: 'Rot',     col: 0x8fa049 },
};

/* ==================================================================== *
 * slot affinity groups
 * ==================================================================== */

const ARMOUR_SLOTS = ['helm', 'chest', 'gloves', 'boots', 'belt'];
const JEWEL_SLOTS = ['amulet', 'ring1', 'ring2'];
const HAND_SLOTS = ['weapon', 'offhand'];
const ALL_SLOTS = [...ARMOUR_SLOTS, ...JEWEL_SLOTS, ...HAND_SLOTS];

/** Canonical slot key — ring1/ring2 share one affix pool. */
export const baseSlot = (s) => (s === 'ring1' || s === 'ring2' ? 'ring' : s);

const on = (slots, w = 1) => {
  const m = Object.create(null);
  for (const s of slots) m[baseSlot(s)] = w;
  return m;
};
const merge = (...maps) => Object.assign(Object.create(null), ...maps);

/* ==================================================================== *
 * tier ladder helper
 * ==================================================================== */

/**
 * Build a tier ladder. `spec` is [ilvlGate, min, max] triples; the roman label
 * is derived from the index so the UI never has to know the table.
 */
function ladder(spec) {
  return spec.map(([ilvl, min, max], i) => ({
    t: spec.length - i,          // T-number counts DOWN: highest tier is T1, D4-style
    idx: i,
    ilvl,
    min,
    max,
    label: `T${spec.length - i}`,
  }));
}

/** Scale a flat ladder by a single growth factor — keeps the tables readable. */
function grow(base, steps, gates, round = 1) {
  const spec = [];
  for (let i = 0; i < gates.length; i++) {
    const lo = base * Math.pow(steps, i);
    const hi = lo * 1.42;
    spec.push([gates[i], Math.max(round, Math.round(lo / round) * round), Math.max(round * 2, Math.round(hi / round) * round)]);
  }
  return ladder(spec);
}

const GATES = [1, 11, 22, 34, 46, 58, 70];
const GATES5 = [1, 15, 30, 46, 62];

/* ==================================================================== *
 * the affix pool
 * ==================================================================== */

/**
 * @typedef {object} AffixDef
 * @property {string} id
 * @property {string} stat            key into STATS
 * @property {'prefix'|'suffix'} kind
 * @property {number} weight          base selection weight
 * @property {Object<string,number>} slots  slot -> affinity multiplier
 * @property {{t:number,idx:number,ilvl:number,min:number,max:number,label:string}[]} tiers
 * @property {string} [name]          affix name shown in the tooltip
 * @property {string} [theme]         element theme for naming
 * @property {boolean} [rangeSpread]  range affixes roll min..max as a spread
 */

/** @type {AffixDef[]} */
export const AFFIXES = [
  /* ---- attributes (prefix) ---- */
  { id: 'str', name: 'Might', stat: 'strength', kind: 'prefix', weight: 120,
    slots: merge(on(ARMOUR_SLOTS, 1), on(HAND_SLOTS, 0.9), on(JEWEL_SLOTS, 0.7)),
    tiers: grow(4, 1.62, GATES), theme: 'physical' },
  { id: 'dex', name: 'Poise', stat: 'dexterity', kind: 'prefix', weight: 120,
    slots: merge(on(ARMOUR_SLOTS, 1), on(HAND_SLOTS, 0.9), on(JEWEL_SLOTS, 0.7)),
    tiers: grow(4, 1.62, GATES), theme: 'cold' },
  { id: 'int', name: 'Insight', stat: 'intelligence', kind: 'prefix', weight: 120,
    slots: merge(on(ARMOUR_SLOTS, 1), on(HAND_SLOTS, 0.9), on(JEWEL_SLOTS, 0.7)),
    tiers: grow(4, 1.62, GATES), theme: 'shadow' },
  { id: 'wil', name: 'Resolve', stat: 'willpower', kind: 'prefix', weight: 110,
    slots: merge(on(ARMOUR_SLOTS, 1), on(HAND_SLOTS, 0.8), on(JEWEL_SLOTS, 0.8)),
    tiers: grow(4, 1.60, GATES), theme: 'holy' },
  { id: 'vit', name: 'Endurance', stat: 'vitality', kind: 'prefix', weight: 130,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(HAND_SLOTS, 0.6), on(JEWEL_SLOTS, 0.9)),
    tiers: grow(5, 1.60, GATES), theme: 'blood' },
  { id: 'allstat', name: 'the Paragon', stat: 'allStats', kind: 'prefix', weight: 18,
    slots: merge(on(JEWEL_SLOTS, 1.6), on(ARMOUR_SLOTS, 0.7), on(HAND_SLOTS, 0.5)),
    tiers: grow(2, 1.55, GATES), theme: 'holy' },

  /* ---- defence (prefix) ---- */
  { id: 'armour', name: 'Bulwark', stat: 'armour', kind: 'prefix', weight: 140,
    slots: merge(on(ARMOUR_SLOTS, 1.4), on(['offhand'], 1.2), on(JEWEL_SLOTS, 0.4)),
    tiers: grow(22, 1.72, GATES, 2), theme: 'physical' },
  { id: 'armourpct', name: 'the Aegis', stat: 'armourPct', kind: 'prefix', weight: 30,
    slots: merge(on(['chest', 'offhand'], 1.5), on(ARMOUR_SLOTS, 0.6)),
    tiers: ladder([[22, 3, 5], [40, 5, 8], [58, 8, 12], [70, 11, 16]]), theme: 'physical' },
  { id: 'life', name: 'the Whole', stat: 'life', kind: 'prefix', weight: 135,
    slots: merge(on(ARMOUR_SLOTS, 1.3), on(JEWEL_SLOTS, 1.1), on(HAND_SLOTS, 0.5)),
    tiers: grow(28, 1.68, GATES, 2), theme: 'blood' },
  { id: 'lifepct', name: 'the Colossus', stat: 'lifePct', kind: 'prefix', weight: 26,
    slots: merge(on(['chest', 'belt'], 1.5), on(JEWEL_SLOTS, 1.0)),
    tiers: ladder([[15, 3, 5], [34, 5, 8], [52, 8, 11], [70, 10, 15]]), theme: 'blood' },
  { id: 'thorns', name: 'Brambles', stat: 'thorns', kind: 'prefix', weight: 55,
    slots: merge(on(['chest', 'gloves', 'boots', 'offhand'], 1.3), on(JEWEL_SLOTS, 0.6)),
    tiers: grow(14, 1.75, GATES, 1), theme: 'decay' },
  { id: 'barrier', name: 'the Ward', stat: 'barrier', kind: 'prefix', weight: 34,
    slots: merge(on(['helm', 'chest', 'offhand'], 1.2), on(JEWEL_SLOTS, 0.9)),
    tiers: ladder([[15, 6, 10], [34, 10, 15], [52, 15, 22], [70, 20, 30]]), theme: 'holy' },

  /* ---- offence (prefix) ---- */
  { id: 'dmgpct', name: 'Ferocity', stat: 'damagePct', kind: 'prefix', weight: 95,
    slots: merge(on(['weapon'], 1.8), on(JEWEL_SLOTS, 1.1), on(['gloves'], 0.9)),
    tiers: ladder([[1, 5, 9], [15, 9, 14], [30, 14, 20], [46, 20, 27], [58, 26, 35], [70, 33, 45]]), theme: 'physical' },
  { id: 'phys', name: 'Butchery', stat: 'physical', kind: 'prefix', weight: 90, rangeSpread: true,
    slots: merge(on(['weapon'], 1.9), on(['gloves', 'ring1'], 0.7)),
    tiers: grow(5, 1.70, GATES, 1), theme: 'physical' },
  { id: 'fire', name: 'the Pyre', stat: 'fire', kind: 'prefix', weight: 72, rangeSpread: true,
    slots: merge(on(['weapon'], 1.7), on(JEWEL_SLOTS, 0.9), on(['gloves'], 0.6)),
    tiers: grow(5, 1.72, GATES, 1), theme: 'fire' },
  { id: 'cold', name: 'the Rime', stat: 'cold', kind: 'prefix', weight: 72, rangeSpread: true,
    slots: merge(on(['weapon'], 1.7), on(JEWEL_SLOTS, 0.9), on(['gloves'], 0.6)),
    tiers: grow(5, 1.72, GATES, 1), theme: 'cold' },
  { id: 'lit', name: 'the Tempest', stat: 'lightning', kind: 'prefix', weight: 68, rangeSpread: true,
    slots: merge(on(['weapon'], 1.7), on(JEWEL_SLOTS, 0.9), on(['gloves'], 0.6)),
    tiers: grow(5, 1.74, GATES, 1), theme: 'lightning' },
  { id: 'shadow', name: 'the Umbra', stat: 'shadow', kind: 'prefix', weight: 62, rangeSpread: true,
    slots: merge(on(['weapon'], 1.7), on(JEWEL_SLOTS, 0.9), on(['helm'], 0.6)),
    tiers: grow(5, 1.76, GATES, 1), theme: 'shadow' },
  { id: 'block', name: 'the Wall', stat: 'blockChance', kind: 'prefix', weight: 40,
    slots: on(['offhand'], 2.4),
    tiers: ladder([[1, 3, 5], [22, 5, 7], [40, 7, 10], [58, 9, 13]]), theme: 'physical' },

  /* ---- suffixes ---- */
  { id: 'crit', name: 'Precision', stat: 'critChance', kind: 'suffix', weight: 78,
    slots: merge(on(['gloves', 'weapon'], 1.8), on(JEWEL_SLOTS, 1.4), on(['helm'], 0.5)),
    tiers: ladder([[1, 2, 3], [15, 3, 4], [30, 4, 6], [46, 5, 8], [58, 7, 10], [70, 9, 13]]), theme: 'cold' },
  { id: 'critdmg', name: 'Cruelty', stat: 'critDamage', kind: 'suffix', weight: 74,
    slots: merge(on(['weapon', 'gloves'], 1.7), on(JEWEL_SLOTS, 1.5)),
    tiers: ladder([[1, 8, 13], [15, 13, 19], [30, 19, 27], [46, 26, 36], [58, 34, 46], [70, 44, 60]]), theme: 'blood' },
  { id: 'aspd', name: 'Alacrity', stat: 'attackSpeed', kind: 'suffix', weight: 66,
    slots: merge(on(['weapon', 'gloves'], 1.8), on(JEWEL_SLOTS, 1.2)),
    tiers: ladder([[1, 3, 5], [22, 5, 7], [40, 7, 9], [58, 8, 12]]), theme: 'lightning' },
  { id: 'area', name: 'the Maelstrom', stat: 'areaDamage', kind: 'suffix', weight: 44,
    slots: merge(on(['weapon', 'chest'], 1.3), on(JEWEL_SLOTS, 1.0)),
    tiers: ladder([[15, 8, 13], [34, 13, 19], [52, 19, 27], [70, 25, 36]]), theme: 'fire' },
  { id: 'overpower', name: 'the Sledge', stat: 'overpower', kind: 'suffix', weight: 40,
    slots: merge(on(['weapon', 'belt'], 1.4), on(['gloves'], 0.8)),
    tiers: ladder([[15, 12, 18], [34, 18, 26], [52, 26, 37], [70, 34, 48]]), theme: 'physical' },
  { id: 'vselite', name: 'the Slayer', stat: 'vsElites', kind: 'suffix', weight: 46,
    slots: merge(on(['weapon', 'amulet'], 1.5), on(['ring1'], 1.2)),
    tiers: ladder([[1, 4, 7], [22, 7, 11], [40, 11, 16], [58, 15, 22]]), theme: 'holy' },
  { id: 'vsinjured', name: 'the Vulture', stat: 'vsInjured', kind: 'suffix', weight: 42,
    slots: merge(on(['weapon', 'gloves'], 1.4), on(JEWEL_SLOTS, 1.0)),
    tiers: ladder([[1, 6, 10], [22, 10, 15], [40, 15, 22], [58, 20, 30]]), theme: 'blood' },
  { id: 'dot', name: 'Contagion', stat: 'dotPotency', kind: 'suffix', weight: 38,
    slots: merge(on(['weapon', 'gloves', 'amulet'], 1.3)),
    tiers: ladder([[11, 7, 11], [30, 11, 17], [50, 17, 24], [70, 22, 32]]), theme: 'decay' },

  { id: 'resfire', name: 'Emberskin', stat: 'resFire', kind: 'suffix', weight: 70,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(JEWEL_SLOTS, 1.4), on(['offhand'], 0.9)),
    tiers: ladder([[1, 5, 8], [15, 8, 12], [30, 12, 17], [46, 16, 23], [58, 21, 30]]), theme: 'fire' },
  { id: 'rescold', name: 'Frostskin', stat: 'resCold', kind: 'suffix', weight: 70,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(JEWEL_SLOTS, 1.4), on(['offhand'], 0.9)),
    tiers: ladder([[1, 5, 8], [15, 8, 12], [30, 12, 17], [46, 16, 23], [58, 21, 30]]), theme: 'cold' },
  { id: 'reslit', name: 'Stormskin', stat: 'resLightning', kind: 'suffix', weight: 70,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(JEWEL_SLOTS, 1.4), on(['offhand'], 0.9)),
    tiers: ladder([[1, 5, 8], [15, 8, 12], [30, 12, 17], [46, 16, 23], [58, 21, 30]]), theme: 'lightning' },
  { id: 'respoison', name: 'Blightskin', stat: 'resPoison', kind: 'suffix', weight: 66,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(JEWEL_SLOTS, 1.3), on(['offhand'], 0.9)),
    tiers: ladder([[1, 5, 8], [15, 8, 12], [30, 12, 17], [46, 16, 23], [58, 21, 30]]), theme: 'decay' },
  { id: 'resshadow', name: 'Nightskin', stat: 'resShadow', kind: 'suffix', weight: 62,
    slots: merge(on(ARMOUR_SLOTS, 1.2), on(JEWEL_SLOTS, 1.3), on(['offhand'], 0.9)),
    tiers: ladder([[1, 5, 8], [15, 8, 12], [30, 12, 17], [46, 16, 23], [58, 21, 30]]), theme: 'shadow' },
  { id: 'resall', name: 'the Sealed', stat: 'resAll', kind: 'suffix', weight: 20,
    slots: merge(on(JEWEL_SLOTS, 1.8), on(['chest', 'helm'], 0.8)),
    tiers: ladder([[22, 3, 5], [40, 5, 8], [58, 7, 11], [70, 10, 14]]), theme: 'holy' },

  { id: 'lifeonhit', name: 'the Leech', stat: 'lifeOnHit', kind: 'suffix', weight: 54,
    slots: merge(on(['weapon', 'ring1'], 1.6), on(['gloves'], 1.0)),
    tiers: grow(6, 1.66, GATES, 1), theme: 'blood' },
  { id: 'liferegen', name: 'the Mending', stat: 'lifeRegen', kind: 'suffix', weight: 50,
    slots: merge(on(ARMOUR_SLOTS, 1.1), on(JEWEL_SLOTS, 1.2)),
    tiers: grow(4, 1.70, GATES, 1), theme: 'holy' },
  { id: 'healing', name: 'the Salve', stat: 'healing', kind: 'suffix', weight: 34,
    slots: merge(on(['belt', 'chest'], 1.4), on(JEWEL_SLOTS, 0.9)),
    tiers: ladder([[11, 8, 13], [30, 13, 19], [50, 19, 26], [70, 24, 34]]), theme: 'holy' },
  { id: 'dodge', name: 'the Wisp', stat: 'dodge', kind: 'suffix', weight: 44,
    slots: merge(on(['boots', 'gloves'], 1.6), on(JEWEL_SLOTS, 1.0)),
    tiers: ladder([[1, 2, 4], [22, 4, 6], [40, 5, 8], [58, 7, 10]]), theme: 'cold' },
  { id: 'cdr', name: 'the Unbound', stat: 'cdr', kind: 'suffix', weight: 48,
    slots: merge(on(['helm', 'boots'], 1.5), on(JEWEL_SLOTS, 1.3)),
    tiers: ladder([[11, 4, 6], [30, 6, 9], [50, 9, 12], [70, 11, 15]]), theme: 'lightning' },
  { id: 'resource', name: 'the Wellspring', stat: 'resource', kind: 'suffix', weight: 52,
    slots: merge(on(['helm', 'chest', 'offhand'], 1.4), on(JEWEL_SLOTS, 1.0)),
    tiers: grow(8, 1.58, GATES, 1), theme: 'shadow' },
  { id: 'resregen', name: 'the Conduit', stat: 'resourceRegen', kind: 'suffix', weight: 40,
    slots: merge(on(['helm', 'offhand'], 1.4), on(JEWEL_SLOTS, 1.0)),
    tiers: ladder([[11, 8, 12], [30, 12, 17], [50, 17, 23], [70, 21, 29]]), theme: 'shadow' },
  { id: 'move', name: 'the Wanderer', stat: 'moveSpeed', kind: 'suffix', weight: 46,
    slots: merge(on(['boots'], 2.6), on(JEWEL_SLOTS, 0.7)),
    tiers: ladder([[1, 4, 7], [22, 7, 10], [40, 10, 14], [58, 13, 18]]), theme: 'cold' },
  { id: 'magicfind', name: 'the Fortunate', stat: 'magicFind', kind: 'suffix', weight: 22,
    slots: merge(on(JEWEL_SLOTS, 1.8), on(['helm'], 0.9)),
    tiers: ladder([[11, 5, 9], [30, 9, 14], [50, 14, 20], [70, 18, 26]]), theme: 'holy' },
  { id: 'goldfind', name: 'the Avaricious', stat: 'goldFind', kind: 'suffix', weight: 26,
    slots: merge(on(JEWEL_SLOTS, 1.5), on(['belt', 'gloves'], 1.1)),
    tiers: ladder([[1, 10, 16], [22, 16, 24], [40, 24, 34], [58, 32, 45]]), theme: 'holy' },
  { id: 'potion', name: 'the Vintner', stat: 'potionCharge', kind: 'suffix', weight: 16,
    slots: on(['belt'], 2.2),
    tiers: ladder([[15, 1, 1], [40, 1, 2], [65, 2, 2]]), theme: 'blood' },
  { id: 'blockamt', name: 'the Deflector', stat: 'blockAmount', kind: 'suffix', weight: 24,
    slots: on(['offhand'], 2.4),
    tiers: ladder([[11, 6, 10], [34, 10, 15], [58, 14, 20]]), theme: 'physical' },
];

export const AFFIX_BY_ID = new Map(AFFIXES.map((a) => [a.id, a]));

/* ==================================================================== *
 * rolling
 * ==================================================================== */

/** Affixes legal on `slot` at `ilvl`, with their effective weights. */
export function affixCandidates(slot, ilvl, kind = null, exclude = null) {
  const s = baseSlot(slot);
  const out = [];
  for (const a of AFFIXES) {
    if (kind && a.kind !== kind) continue;
    if (exclude && exclude.has(a.id)) continue;
    const aff = a.slots[s];
    if (!aff) continue;
    if (a.tiers[a.tiers.length - 1].ilvl > ilvl && a.tiers[0].ilvl > ilvl) continue;
    let unlocked = 0;
    for (const t of a.tiers) if (t.ilvl <= ilvl) unlocked++;
    if (!unlocked) continue;
    out.push({ def: a, weight: a.weight * aff, unlocked });
  }
  return out;
}

function pickWeighted(rand, list, weightOf) {
  let total = 0;
  for (const it of list) total += weightOf(it);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const it of list) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}

/**
 * Pick a tier. Bias climbs with item level and with `luck` (elite/boss bonus),
 * so a level-70 boss drop lands near the top of the ladder most of the time but
 * never guarantees it.
 */
function pickTier(rand, def, ilvl, luck = 0) {
  const elig = def.tiers.filter((t) => t.ilvl <= ilvl);
  if (!elig.length) return def.tiers[def.tiers.length - 1];
  const topIdx = elig.length - 1;
  const decay = 1.55 + luck * 0.9;
  const chosen = pickWeighted(rand, elig, (t) => Math.pow(decay, -(topIdx - elig.indexOf(t))));
  return chosen ?? elig[topIdx];
}

/**
 * Roll one affix instance.
 * @returns {{id,name,kind,stat,statLabel,tier,tierLabel,value,min,max,q,text,theme,range?:{min,max}}}
 */
export function rollAffix(rand, { slot, ilvl, kind = null, exclude = null, luck = 0 } = {}) {
  const cands = affixCandidates(slot, ilvl, kind, exclude);
  if (!cands.length) return null;
  const pick = pickWeighted(rand, cands, (c) => c.weight);
  if (!pick) return null;
  return instantiate(rand, pick.def, ilvl, luck);
}

function instantiate(rand, def, ilvl, luck) {
  const tier = pickTier(rand, def, ilvl, luck);
  const meta = STATS[def.stat];
  const q = Math.min(1, Math.max(0, rand() * (1 - luck * 0.18) + luck * 0.18));
  let value = tier.min + (tier.max - tier.min) * q;
  let text;
  let range = null;

  if (meta.kind === 'range') {
    // A damage range rolls a midpoint plus a spread, so no two rolls are the
    // same shape: 4–11 and 6–9 have the same mean and feel different.
    const mid = Math.max(1, Math.round(value));
    const spread = Math.max(1, Math.round(mid * (0.28 + rand() * 0.34)));
    range = { min: Math.max(1, mid - spread), max: mid + spread };
    value = mid;
    text = meta.fmt(range.min, range.max);
  } else {
    value = meta.kind === 'pct' ? Math.round(value * 10) / 10 : Math.round(value);
    text = meta.fmt(value);
  }

  return {
    id: def.id,
    name: def.name ?? meta.label,
    kind: def.kind,
    stat: def.stat,
    statLabel: meta.label,
    statKind: meta.kind,
    tier: tier.t,
    tierLabel: tier.label,
    tierIndex: tier.idx,
    value,
    range,
    min: tier.min,
    max: tier.max,
    q: Math.round(q * 1000) / 1000,
    text,
    theme: def.theme ?? 'physical',
  };
}

/**
 * Roll the full affix list for an item.
 * @param {(()=>number)&{range:Function}} rand
 * @param {{slot:string,ilvl:number,prefixes:number,suffixes:number,luck?:number}} o
 */
export function rollAffixSet(rand, { slot, ilvl, prefixes, suffixes, luck = 0 }) {
  const used = new Set();
  const out = [];
  const statsUsed = new Set();
  for (let i = 0; i < prefixes; i++) {
    const a = rollAffixUnique(rand, slot, ilvl, 'prefix', used, statsUsed, luck);
    if (a) out.push(a);
  }
  for (let i = 0; i < suffixes; i++) {
    const a = rollAffixUnique(rand, slot, ilvl, 'suffix', used, statsUsed, luck);
    if (a) out.push(a);
  }
  return out;
}

function rollAffixUnique(rand, slot, ilvl, kind, used, statsUsed, luck) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = rollAffix(rand, { slot, ilvl, kind, exclude: used, luck });
    if (!a) return null;
    if (statsUsed.has(a.stat)) { used.add(a.id); continue; }
    used.add(a.id);
    statsUsed.add(a.stat);
    return a;
  }
  return null;
}

/* ==================================================================== *
 * legendary powers — behaviour, not numbers
 * ==================================================================== */

/**
 * @typedef {object} PowerDef
 * @property {string} id
 * @property {string} name        "Aspect of …" — printed in the tooltip header
 * @property {string[]} slots     slots it can appear on
 * @property {string} hook        onKill|onCrit|onHit|onDash|onHurt|passive
 * @property {[number,number]} vals  value band, rolled per item
 * @property {(v:number)=>string} text
 * @property {object} effect      payload consumed by Progression's hook binder
 */
export const LEGENDARY_POWERS = [
  { id: 'ashenReprisal', name: 'Aspect of Ashen Reprisal', slots: ['weapon', 'gloves', 'ring'],
    hook: 'onKill', vals: [55, 140], theme: 'fire',
    text: (v) => `Slaying an enemy erupts a nova of cinders, dealing ${v}% of your damage to everything within 4 m.`,
    effect: { kind: 'nova', radius: 4, element: 'fire' } },
  { id: 'gravebindings', name: 'Aspect of the Gravebinding', slots: ['boots', 'belt'],
    hook: 'onKill', vals: [8, 20], theme: 'shadow',
    text: (v) => `Each kill grants ${v}% Movement Speed for 3 s, stacking three times.`,
    effect: { kind: 'buff', stat: 'moveSpeed', duration: 3, stacks: 3 } },
  { id: 'splinteringStar', name: 'Aspect of the Splintering Star', slots: ['weapon', 'amulet'],
    hook: 'onCrit', vals: [30, 75], theme: 'lightning',
    text: (v) => `Critical strikes fork lightning to 2 nearby enemies for ${v}% of the hit.`,
    effect: { kind: 'chain', targets: 2, radius: 6, element: 'lightning' } },
  { id: 'hollowKing', name: 'Aspect of the Hollow King', slots: ['helm', 'chest'],
    hook: 'onHurt', vals: [14, 30], theme: 'blood',
    text: (v) => `Dropping below 35% Life grants a Barrier equal to ${v}% of your Maximum Life. 20 s cooldown.`,
    effect: { kind: 'barrier', threshold: 0.35, cooldown: 20 } },
  { id: 'iron Tithe', name: 'Aspect of the Iron Tithe', slots: ['chest', 'offhand'],
    hook: 'passive', vals: [12, 28], theme: 'physical',
    text: (v) => `${v}% of incoming damage is dealt to your Resource instead of your Life.`,
    effect: { kind: 'mitigate', channel: 'resource' } },
  { id: 'vesselOfCinders', name: 'Aspect of the Vessel of Cinders', slots: ['weapon', 'ring'],
    hook: 'onHit', vals: [6, 15], theme: 'fire',
    text: (v) => `Attacks burn the target for ${v}% of the hit over 3 s. Burning enemies take +10% damage.`,
    effect: { kind: 'dot', element: 'fire', duration: 3, amp: 10 } },
  { id: 'wintersMandate', name: "Aspect of Winter's Mandate", slots: ['weapon', 'gloves'],
    hook: 'onHit', vals: [12, 30], theme: 'cold',
    text: (v) => `Attacks Chill for ${v}%. Frozen enemies shatter for 25% of their remaining Life.`,
    effect: { kind: 'chill', shatter: 0.25, element: 'cold' } },
  { id: 'unbrokenVigil', name: 'Aspect of the Unbroken Vigil', slots: ['offhand', 'helm'],
    hook: 'passive', vals: [10, 24], theme: 'holy',
    text: (v) => `While standing still for 1 s you gain ${v}% Damage Reduction and Thorns equal to your Armour.`,
    effect: { kind: 'stance', delay: 1 } },
  { id: 'ravenousMaw', name: 'Aspect of the Ravenous Maw', slots: ['weapon', 'amulet'],
    hook: 'onKill', vals: [3, 8], theme: 'blood',
    text: (v) => `Kills restore ${v}% of your Maximum Life and 6 Resource.`,
    effect: { kind: 'restore', resource: 6 } },
  { id: 'sunderedCovenant', name: 'Aspect of the Sundered Covenant', slots: ['ring', 'amulet'],
    hook: 'onCrit', vals: [18, 45], theme: 'shadow',
    text: (v) => `Critical strikes reduce the target's Armour by ${v}% for 4 s.`,
    effect: { kind: 'debuff', stat: 'armour', duration: 4 } },
  { id: 'stormcallersPact', name: "Aspect of the Stormcaller's Pact", slots: ['weapon', 'offhand'],
    hook: 'onDash', vals: [80, 180], theme: 'lightning',
    text: (v) => `Dashing leaves a thundercloud that strikes for ${v}% damage over 2 s.`,
    effect: { kind: 'zone', duration: 2, radius: 3, element: 'lightning' } },
  { id: 'gildedRefusal', name: 'Aspect of the Gilded Refusal', slots: ['offhand', 'boots'],
    hook: 'passive', vals: [20, 45], theme: 'holy',
    text: (v) => `Blocking or Dodging an attack grants ${v}% Attack Speed for 2 s.`,
    effect: { kind: 'buff', stat: 'attackSpeed', duration: 2, stacks: 1 } },
  { id: 'boneharvest', name: 'Aspect of the Bone Harvest', slots: ['gloves', 'weapon'],
    hook: 'onKill', vals: [1, 3], theme: 'decay',
    text: (v) => `Every kill raises ${v} bone shard that impales the next enemy you strike.`,
    effect: { kind: 'summon', charges: 3 } },
  { id: 'emberboundOath', name: 'Aspect of the Emberbound Oath', slots: ['chest', 'belt'],
    hook: 'passive', vals: [8, 18], theme: 'fire',
    text: (v) => `You are wreathed in flame, dealing ${v}% of your damage per second within 3 m.`,
    effect: { kind: 'aura', radius: 3, element: 'fire' } },
  { id: 'pallidChoir', name: 'Aspect of the Pallid Choir', slots: ['helm', 'amulet'],
    hook: 'passive', vals: [5, 12], theme: 'holy',
    text: (v) => `Your Resistances also grant ${v}% of their value as Damage Reduction.`,
    effect: { kind: 'convert', from: 'resAll', to: 'dr' } },
  { id: 'quietedBlade', name: 'Aspect of the Quieted Blade', slots: ['weapon'],
    hook: 'passive', vals: [25, 60], theme: 'shadow',
    text: (v) => `Your first strike against a full-Life enemy deals +${v}% damage and always Overpowers.`,
    effect: { kind: 'firstStrike' } },
  { id: 'threefoldWound', name: 'Aspect of the Threefold Wound', slots: ['weapon', 'gloves'],
    hook: 'onHit', vals: [10, 26], theme: 'blood',
    text: (v) => `Every third hit on the same enemy deals an extra ${v}% as Physical damage.`,
    effect: { kind: 'everyNth', n: 3, element: 'physical' } },
  { id: 'wanderersToll', name: "Aspect of the Wanderer's Toll", slots: ['boots', 'belt'],
    hook: 'passive', vals: [6, 14], theme: 'cold',
    text: (v) => `You gain ${v}% Damage Reduction for each second spent moving, up to 4 stacks.`,
    effect: { kind: 'stance', delay: 1, stacks: 4 } },
  { id: 'moltenCrown', name: 'Aspect of the Molten Crown', slots: ['helm'],
    hook: 'onHurt', vals: [40, 95], theme: 'fire',
    text: (v) => `Taking damage while below 50% Life releases a scorching wave for ${v}% damage. 8 s cooldown.`,
    effect: { kind: 'nova', radius: 5, element: 'fire', cooldown: 8, threshold: 0.5 } },
  { id: 'exhumedHunger', name: 'Aspect of Exhumed Hunger', slots: ['ring', 'gloves'],
    hook: 'onHit', vals: [2, 6], theme: 'decay',
    text: (v) => `Hits have a ${v}% chance to tear a wound that spreads Poison to nearby enemies.`,
    effect: { kind: 'spread', radius: 4, element: 'poison' } },
];

export const POWER_BY_ID = new Map(LEGENDARY_POWERS.map((p) => [p.id, p]));

/** Roll a legendary power appropriate to the slot. */
export function rollPower(rand, slot, ilvl = 1, luck = 0) {
  const s = baseSlot(slot);
  const pool = LEGENDARY_POWERS.filter((p) => p.slots.includes(s));
  const list = pool.length ? pool : LEGENDARY_POWERS;
  const def = list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
  const q = Math.min(1, rand() * (1 - luck * 0.2) + luck * 0.2);
  const raw = def.vals[0] + (def.vals[1] - def.vals[0]) * q;
  const value = raw >= 20 ? Math.round(raw) : Math.round(raw * 10) / 10;
  return {
    id: def.id,
    name: def.name,
    hook: def.hook,
    theme: def.theme,
    value,
    min: def.vals[0],
    max: def.vals[1],
    q: Math.round(q * 1000) / 1000,
    text: def.text(value),
    effect: { ...def.effect, value },
  };
}

export function powerText(power) {
  if (!power) return '';
  const def = POWER_BY_ID.get(power.id);
  return def ? def.text(power.value) : power.text ?? '';
}

/* ==================================================================== *
 * procedural naming
 * ==================================================================== */

/** Adjectival prefixes, grouped by theme so a fire item never reads as frosty. */
const PREFIX_WORDS = {
  physical: ['Grim', 'Sundered', 'Riveted', 'Bulwark', 'Ironbound', 'Hewn', 'Battered', 'Wrought'],
  fire:     ['Ashen', 'Cindershod', 'Smouldering', 'Emberlit', 'Scorched', 'Pyreborn', 'Charred'],
  cold:     ['Hoarfrost', 'Rimeclad', 'Pale', 'Glacial', 'Frostbitten', 'Wintersworn', 'Bleak'],
  lightning:['Stormcut', 'Fulgurant', 'Skyriven', 'Thundershorn', 'Arcing', 'Voltaic'],
  shadow:   ['Umbral', 'Nightgilt', 'Whispering', 'Hollow', 'Veiled', 'Duskbound', 'Silent'],
  holy:     ['Hallowed', 'Gilded', 'Sanctified', 'Vigilant', 'Reliquary', 'Anointed', 'Chorister'],
  blood:    ['Crimson', 'Sanguine', 'Exsanguine', 'Bloodslick', 'Vein-carved', 'Ruddy'],
  decay:    ['Blighted', 'Mouldering', 'Vermin-gnawed', 'Rotgilded', 'Fenwrought', 'Sallow'],
};

/** "of the <ADJ> <NOUN>" — the second half of a rare/legendary name. */
const SUFFIX_ADJ = {
  physical: ['Ashen', 'Iron', 'Broken', 'Silent', 'Weeping'],
  fire:     ['Ashen', 'Cinder', 'Smouldering', 'Kindled'],
  cold:     ['Pale', 'Hoar', 'Frozen', 'Silent'],
  lightning:['Riven', 'Storm', 'Sky-torn', 'Roaring'],
  shadow:   ['Hollow', 'Umbral', 'Nameless', 'Whispered'],
  holy:     ['Ashen', 'Golden', 'Hallowed', 'Kneeling'],
  blood:    ['Crimson', 'Bleeding', 'Sworn', 'Second'],
  decay:    ['Blighted', 'Drowned', 'Sunken', 'Fetid'],
};

const SUFFIX_NOUN = [
  'Vigil', 'Penance', 'Choir', 'Reckoning', 'Covenant', 'Sepulchre', 'Tithe',
  'Lament', 'Warden', 'Oath', 'Requiem', 'Pilgrim', 'Verdict', 'Cinder',
  'Threshold', 'Reliquary', 'Bellringer', 'Gallows', 'Silence', 'Harvest',
];

/** Fixed evocative names for unique / mythic drops, keyed by slot group. */
const UNIQUE_NAMES = {
  weapon: [
    ['Thornmaw', 'the Gilded Refusal'], ['Vaulderhaunt', 'Eighth of Nine'],
    ['Sablecry', 'the Widow Verdict'], ['Emberquill', 'the Last Sermon'],
    ['Grieftooth', 'Warden of the Low Door'],
  ],
  offhand: [
    ['Palewatch', 'the Unclosing Eye'], ['Cindercreed', 'the Kept Flame'],
    ['Hollowbell', 'Toll of the Ninth Hour'],
  ],
  helm: [
    ['Crown of Quiet Hours'], ['Sallet of the Drowned Choir'], ['Vaultmask of Ossuar'],
  ],
  chest: [
    ['Harness of the Unmade Saint'], ['Ossuary Cuirass'], ['Shroud of the Ninth Vigil'],
  ],
  gloves: [['Grasp of the Ashen Verdict'], ['Reliquary Gauntlets'], ['Gravebinder Wraps']],
  boots: [['Stride of the Silent Pilgrim'], ['Sabatons of Long Penance'], ['Fenwalker Greaves']],
  belt: [['Girdle of Cold Iron Faith'], ['Cincture of the Kept Oath'], ['Tithe-Cord of Ossuar']],
  amulet: [['Cinderheart Reliquary'], ['Pendant of the Nameless Warden'], ['Sablestone Talisman']],
  ring: [['Signet of the Low Door'], ['Bandreave, the Second Verdict'], ['Ossuar Seal']],
};

const FLAVOUR = [
  'Recovered from the ossuary beneath the Sanctum, still warm.',
  'The smith left no mark. The buyer left no name.',
  'Nine were made. Eight are accounted for.',
  'It has been sharpened more often than it has been washed.',
  'The prayer etched inside was never finished.',
  'Taken from a hand that would not open.',
  'Older than the crypt it was buried in.',
  'Every dent in it is somebody.',
  'The Vigil issued these. The Vigil is gone.',
  'It rings, faintly, when the dead are near.',
];

const pick = (rand, arr) => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))];

/**
 * Dominant theme of an item: the theme of its highest-tier affix (or its
 * legendary power), so the name agrees with what the item actually does.
 */
export function dominantTheme(affixes = [], power = null, fallback = 'physical') {
  if (power?.theme) return power.theme;
  let best = null;
  for (const a of affixes) {
    if (!a) continue;
    if (!best || a.tier < best.tier) best = a;
  }
  return best?.theme ?? fallback;
}

/**
 * Procedural item name.
 *   common     "Sallet"
 *   magic      "Ashen Sallet"  |  "Sallet of Precision"
 *   rare       "Grim Vambraces of the Ashen Vigil"
 *   legendary  "Cindershod Gauntlets of the Kindled Reckoning"
 *   unique     "Thornmaw, the Gilded Refusal"
 */
export function nameItem(rand, { rarity, baseLabel, slot, affixes = [], power = null, theme = null }) {
  const th = theme ?? dominantTheme(affixes, power);
  const pre = pick(rand, PREFIX_WORDS[th] ?? PREFIX_WORDS.physical);
  const adj = pick(rand, SUFFIX_ADJ[th] ?? SUFFIX_ADJ.physical);
  const noun = pick(rand, SUFFIX_NOUN);

  if (rarity === 'unique' || rarity === 'mythic') {
    const pool = UNIQUE_NAMES[baseSlot(slot)] ?? UNIQUE_NAMES.weapon;
    const entry = pick(rand, pool);
    return entry.length > 1 ? `${entry[0]}, ${entry[1]}` : entry[0];
  }
  if (rarity === 'common') return baseLabel;
  if (rarity === 'magic') {
    return rand() < 0.55
      ? `${pre} ${baseLabel}`
      : `${baseLabel} of ${affixes.find((a) => a.kind === 'suffix')?.name ?? noun}`;
  }
  return `${pre} ${baseLabel} of the ${adj} ${noun}`;
}

export function flavourFor(rand) { return pick(rand, FLAVOUR); }

/** Roman numeral for tier chips in the tooltip. */
export function roman(n) {
  const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '', v = Math.max(0, Math.round(n));
  for (const [k, s] of table) while (v >= k) { out += s; v -= k; }
  return out || 'I';
}
