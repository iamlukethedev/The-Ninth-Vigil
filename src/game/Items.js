/**
 * THE NINTH VIGIL — Items
 * ---------------------------------------------------------------------------
 * Slots, base types, rarity tiers, the item factory, and the procedural ICON
 * DESCRIPTOR that the HUD renders. Pure data + pure functions — nothing here
 * imports THREE, touches the scene, or reads the DOM, so it is trivially
 * deterministic and can be unit-exercised from anywhere.
 *
 * Everything takes an explicit `rand` (from `engine.freshRand(seed)`).
 * No Math.random, no Date.now.
 *
 * ===========================================================================
 * ICON CONTRACT  (the documented HUD hand-off, req. 9)
 * ===========================================================================
 * Two fields, deliberately:
 *
 *   `item.icon`      a short archetype KEY string — 'sword' | 'axe' | 'helm' |
 *                    'chest' | 'gloves' | 'boots' | 'belt' | 'ring' | 'amulet' |
 *                    'shield' | 'bow' | 'staff' | 'tome' | 'potion' | 'gem' |
 *                    'scroll' | 'cloak' | 'rune'.  This is exactly the `kind`
 *                    that `UIAtlas.itemIconURI(size, kind, rarity, seed)` takes,
 *                    so an item drops straight into the existing inventory
 *                    renderer with no adapter and a stable cache key.
 *
 *   `item.iconSpec`  the full procedural DESCRIPTOR below, for a renderer that
 *                    wants the exact silhouette, palette and inlays of *this*
 *                    instance rather than a generic archetype drawing.
 *
 * `item.iconSpec` is a plain, JSON-safe description of *what the icon looks like*.
 * Loot never rasterises it; the HUD does, however it likes (canvas 2D, SVG,
 * a WebGL quad). All coordinates are normalised to a unit square with the
 * origin at the TOP-LEFT, x → right, y → down, so a canvas renderer can
 * multiply by its pixel size and draw directly.
 *
 * {
 *   arch:      'sword'|'axe'|…      // archetype key, stable, safe to switch on
 *   family:    'metal'|'gold'|'leather'|'cloth'|'bone'|'wood'|'gem'
 *   outline:   [[x,y], …]           // closed polygon: the item silhouette
 *   holes:     [[[x,y], …], …]      // polygons to punch out (ring interiors)
 *   plates:    [{ poly:[[x,y],…], shade:number }]   // interior fill shapes
 *   strokes:   [{ a:[x,y], b:[x,y], w:number, shade:number }]  // engraved lines
 *   gems:      [{ x, y, r, col }]   // inlaid stones; col is 0xRRGGBB
 *   palette:   { base, shade, spec, deep, accent }  // 0xRRGGBB
 *   metalness: 0..1                 // suggested specular response
 *   roughness: 0..1
 *   wear:      0..1                 // how much grime/edge-wear to overlay
 *   trim:      'plain'|'studs'|'filigree'|'runes'|'rivets'
 *   glow:      0..1                 // emissive halo strength (legendary+)
 *   rarity:    'common'|…           // convenience copy
 *   frame:     { line, glow, deep } // rarity chrome for the icon border, hex css
 *   light:     [x, y]               // suggested light direction, normalised
 *   stack:     number|null          // draw a stack count when > 1
 * }
 *
 * `shade` is a multiplier against `palette.base` (0.4 = deep shadow, 1.35 =
 * catch-light), so the HUD needs no knowledge of the item to look correct.
 */

import {
  STATS, rollAffixSet, rollPower, nameItem, flavourFor, dominantTheme,
  ELEMENT_THEME, baseSlot,
} from './Affixes.js';

/* ==================================================================== *
 * rarity
 * ==================================================================== */

/**
 * white / blue / yellow / orange / amber / red, per the art bible.
 * `line` is the chrome hairline, `text` the readable label colour, `glow` the
 * world beam / ground pool tint, `deep` the darkest plate wash.
 */
export const RARITIES = {
  common: {
    key: 'common', label: 'Common', order: 0, prefixes: 0, suffixes: 0, powers: 0,
    line: '#cdc7b8', text: '#ddd7c8', glow: '#8d8578', deep: '#3a382f',
    beam: 0xbdb7a6, beamI: 0.55, statMul: 1.00, value: 1.0, sockets: 0,
  },
  magic: {
    key: 'magic', label: 'Magic', order: 1, prefixes: 1, suffixes: 1, powers: 0,
    line: '#5d94e0', text: '#8fbcf4', glow: '#3a6ec0', deep: '#16243d',
    beam: 0x4b86e0, beamI: 0.95, statMul: 1.08, value: 2.6, sockets: 0,
  },
  rare: {
    key: 'rare', label: 'Rare', order: 2, prefixes: 2, suffixes: 2, powers: 0,
    line: '#e0c74e', text: '#f0dc8a', glow: '#b39422', deep: '#3b3110',
    beam: 0xdcc247, beamI: 1.45, statMul: 1.18, value: 6.5, sockets: 1,
  },
  legendary: {
    key: 'legendary', label: 'Legendary', order: 3, prefixes: 2, suffixes: 2, powers: 1,
    line: '#e0862c', text: '#f5b473', glow: '#c05f10', deep: '#3f2209',
    beam: 0xff7a1e, beamI: 3.1, statMul: 1.30, value: 22, sockets: 1,
  },
  unique: {
    key: 'unique', label: 'Unique', order: 4, prefixes: 2, suffixes: 2, powers: 1,
    line: '#f2b03c', text: '#ffd489', glow: '#c98a12', deep: '#3d2c06',
    beam: 0xffb128, beamI: 3.6, statMul: 1.42, value: 44, sockets: 2,
  },
  mythic: {
    key: 'mythic', label: 'Mythic', order: 5, prefixes: 3, suffixes: 3, powers: 2,
    line: '#c0392b', text: '#ef8272', glow: '#8e1f14', deep: '#3a0f0a',
    beam: 0xff2f18, beamI: 4.4, statMul: 1.60, value: 130, sockets: 3,
  },
};
export const RARITY_ORDER = ['common', 'magic', 'rare', 'legendary', 'unique', 'mythic'];
export const rarityInfo = (k) => RARITIES[k] ?? RARITIES.common;
export const rarityRank = (k) => rarityInfo(k).order;

/* ==================================================================== *
 * slots
 * ==================================================================== */

export const SLOTS = [
  { id: 'helm', label: 'Helm', group: 'armour', row: 0, col: 0 },
  { id: 'amulet', label: 'Amulet', group: 'jewel', row: 0, col: 1 },
  { id: 'chest', label: 'Chest Armour', group: 'armour', row: 1, col: 0 },
  { id: 'gloves', label: 'Gloves', group: 'armour', row: 2, col: 0 },
  { id: 'ring1', label: 'Ring', group: 'jewel', row: 2, col: 1 },
  { id: 'belt', label: 'Belt', group: 'armour', row: 3, col: 0 },
  { id: 'ring2', label: 'Ring', group: 'jewel', row: 3, col: 1 },
  { id: 'boots', label: 'Boots', group: 'armour', row: 4, col: 0 },
  { id: 'weapon', label: 'Weapon', group: 'hand', row: 5, col: 0 },
  { id: 'offhand', label: 'Off-Hand', group: 'hand', row: 5, col: 1 },
];
export const SLOT_IDS = SLOTS.map((s) => s.id);
export const SLOT_BY_ID = new Map(SLOTS.map((s) => [s.id, s]));
export const slotLabel = (id) => SLOT_BY_ID.get(id)?.label ?? id;

/* ==================================================================== *
 * base types
 * ==================================================================== */

/**
 * @typedef {object} BaseDef
 * @property {string} id
 * @property {string} label
 * @property {string} slot
 * @property {string} arch     icon + mesh archetype key
 * @property {string} family   material family (drives tint, icon shading, mesh material)
 * @property {number} ilvl     minimum item level this base appears at
 * @property {number} w        drop weight within the slot
 * @property {number} [ar]     armour coefficient (armour slots)
 * @property {number} [dmg]    damage coefficient (weapon)
 * @property {number} [aps]    base attacks per second (weapon)
 * @property {number} tint     0xRRGGBB base colour
 * @property {{stat:string,min:number,max:number,per:number}} implicit
 */

const imp = (stat, min, max, per = 0) => ({ stat, min, max, per });

/** @type {Object<string, BaseDef[]>} */
export const BASES = {
  helm: [
    { id: 'coif', label: 'Padded Coif', arch: 'hood', family: 'cloth', ilvl: 1, w: 22, ar: 0.9, tint: 0x5d5347, implicit: imp('resource', 4, 8, 0.14) },
    { id: 'cap', label: 'Riveted Cap', arch: 'helm', family: 'leather', ilvl: 1, w: 24, ar: 1.05, tint: 0x6b5340, implicit: imp('life', 12, 22, 0.6) },
    { id: 'sallet', label: 'Iron Sallet', arch: 'helm', family: 'metal', ilvl: 8, w: 26, ar: 1.35, tint: 0x8b939c, implicit: imp('armour', 14, 26, 0.9) },
    { id: 'barbute', label: 'Barbute', arch: 'helm', family: 'metal', ilvl: 22, w: 20, ar: 1.5, tint: 0x7d858f, implicit: imp('armour', 20, 34, 1.1) },
    { id: 'greathelm', label: 'Great Helm', arch: 'greathelm', family: 'metal', ilvl: 38, w: 14, ar: 1.72, tint: 0x8f8779, implicit: imp('resAll', 2, 4, 0.03) },
    { id: 'reliqhood', label: 'Reliquary Hood', arch: 'hood', family: 'cloth', ilvl: 30, w: 12, ar: 1.02, tint: 0x4a4450, implicit: imp('cdr', 3, 5, 0.03) },
  ],
  chest: [
    { id: 'jerkin', label: 'Boiled Jerkin', arch: 'jerkin', family: 'leather', ilvl: 1, w: 24, ar: 1.6, tint: 0x6a5340, implicit: imp('life', 20, 34, 1.1) },
    { id: 'robe', label: 'Ashcloth Robe', arch: 'robe', family: 'cloth', ilvl: 1, w: 20, ar: 1.35, tint: 0x4f4a4c, implicit: imp('resource', 6, 12, 0.22) },
    { id: 'brigandine', label: 'Brigandine', arch: 'jerkin', family: 'leather', ilvl: 14, w: 22, ar: 1.95, tint: 0x5c4a3c, implicit: imp('armour', 22, 40, 1.3) },
    { id: 'cuirass', label: 'Plate Cuirass', arch: 'cuirass', family: 'metal', ilvl: 26, w: 22, ar: 2.4, tint: 0x8d959e, implicit: imp('armour', 34, 58, 1.8) },
    { id: 'harness', label: 'Ossuary Harness', arch: 'cuirass', family: 'bone', ilvl: 40, w: 12, ar: 2.2, tint: 0xc9bd9c, implicit: imp('thorns', 18, 34, 1.4) },
    { id: 'shroud', label: 'Vigil Shroud', arch: 'robe', family: 'cloth', ilvl: 44, w: 10, ar: 1.5, tint: 0x413c4a, implicit: imp('barrier', 8, 14, 0.06) },
  ],
  gloves: [
    { id: 'wraps', label: 'Linen Wraps', arch: 'wraps', family: 'cloth', ilvl: 1, w: 22, ar: 0.55, tint: 0x6d6252, implicit: imp('attackSpeed', 2, 4, 0.02) },
    { id: 'grasps', label: 'Hide Grasps', arch: 'wraps', family: 'leather', ilvl: 1, w: 24, ar: 0.68, tint: 0x6d5741, implicit: imp('critChance', 1, 2, 0.014) },
    { id: 'gauntlets', label: 'Iron Gauntlets', arch: 'gauntlet', family: 'metal', ilvl: 12, w: 26, ar: 0.92, tint: 0x89919b, implicit: imp('armour', 10, 18, 0.62) },
    { id: 'vambraces', label: 'Vambraces', arch: 'gauntlet', family: 'metal', ilvl: 28, w: 18, ar: 1.02, tint: 0x7f8790, implicit: imp('critDamage', 6, 11, 0.09) },
    { id: 'reliqgloves', label: 'Reliquary Gloves', arch: 'wraps', family: 'gold', ilvl: 42, w: 10, ar: 0.8, tint: 0xa8873d, implicit: imp('lifeOnHit', 4, 8, 0.16) },
  ],
  boots: [
    { id: 'treads', label: 'Wrapped Treads', arch: 'boot', family: 'cloth', ilvl: 1, w: 22, ar: 0.6, tint: 0x605649, implicit: imp('moveSpeed', 3, 6, 0.03) },
    { id: 'boots', label: 'Hide Boots', arch: 'boot', family: 'leather', ilvl: 1, w: 24, ar: 0.74, tint: 0x6b5440, implicit: imp('dodge', 1, 3, 0.02) },
    { id: 'greaves', label: 'Iron Greaves', arch: 'greave', family: 'metal', ilvl: 14, w: 24, ar: 0.98, tint: 0x8a929c, implicit: imp('armour', 11, 20, 0.66) },
    { id: 'sabatons', label: 'Sabatons', arch: 'greave', family: 'metal', ilvl: 30, w: 18, ar: 1.1, tint: 0x7e8792, implicit: imp('moveSpeed', 4, 7, 0.035) },
    { id: 'fenwalkers', label: 'Fenwalker Greaves', arch: 'greave', family: 'bone', ilvl: 46, w: 10, ar: 1.04, tint: 0xc4b895, implicit: imp('resPoison', 4, 8, 0.05) },
  ],
  belt: [
    { id: 'cord', label: 'Knotted Cord', arch: 'sash', family: 'cloth', ilvl: 1, w: 22, ar: 0.42, tint: 0x63594a, implicit: imp('potionCharge', 1, 1, 0) },
    { id: 'girdle', label: 'Hide Girdle', arch: 'belt', family: 'leather', ilvl: 1, w: 24, ar: 0.52, tint: 0x6c5440, implicit: imp('life', 14, 24, 0.7) },
    { id: 'warbelt', label: 'Iron Warbelt', arch: 'belt', family: 'metal', ilvl: 16, w: 24, ar: 0.7, tint: 0x8891a0, implicit: imp('armour', 8, 15, 0.5) },
    { id: 'cincture', label: 'Gilded Cincture', arch: 'belt', family: 'gold', ilvl: 34, w: 14, ar: 0.66, tint: 0xa5853c, implicit: imp('healing', 6, 11, 0.07) },
    { id: 'tithecord', label: 'Tithe-Cord', arch: 'sash', family: 'cloth', ilvl: 48, w: 10, ar: 0.58, tint: 0x4b4048, implicit: imp('goldFind', 10, 18, 0.12) },
  ],
  amulet: [
    { id: 'pendant', label: 'Bone Pendant', arch: 'amulet', family: 'bone', ilvl: 1, w: 26, tint: 0xcfc3a2, implicit: imp('allStats', 1, 2, 0.03) },
    { id: 'talisman', label: 'Iron Talisman', arch: 'amulet', family: 'metal', ilvl: 10, w: 24, tint: 0x8b939d, implicit: imp('resAll', 2, 4, 0.035) },
    { id: 'torc', label: 'Silver Torc', arch: 'torc', family: 'metal', ilvl: 24, w: 20, tint: 0xa9b1ba, implicit: imp('cdr', 3, 5, 0.035) },
    { id: 'reliquary', label: 'Reliquary Locket', arch: 'amulet', family: 'gold', ilvl: 38, w: 16, tint: 0xb08c3c, implicit: imp('critDamage', 9, 16, 0.13) },
  ],
  ring: [
    { id: 'band', label: 'Iron Band', arch: 'ring', family: 'metal', ilvl: 1, w: 26, tint: 0x8a929c, implicit: imp('life', 10, 18, 0.5) },
    { id: 'loop', label: 'Bone Loop', arch: 'ring', family: 'bone', ilvl: 1, w: 22, tint: 0xcbbfa0, implicit: imp('resource', 3, 6, 0.1) },
    { id: 'signet', label: 'Signet', arch: 'signet', family: 'gold', ilvl: 18, w: 24, tint: 0xac8a3e, implicit: imp('critChance', 1, 2, 0.016) },
    { id: 'seal', label: 'Ossuar Seal', arch: 'signet', family: 'gold', ilvl: 36, w: 16, tint: 0x9d7c37, implicit: imp('damagePct', 4, 7, 0.05) },
  ],
  weapon: [
    { id: 'falchion', label: 'Falchion', arch: 'sword', family: 'metal', ilvl: 1, w: 22, dmg: 1.00, aps: 1.20, tint: 0x9aa2ab, implicit: imp('vsInjured', 4, 8, 0.05) },
    { id: 'dagger', label: 'Ossuar Kris', arch: 'dagger', family: 'metal', ilvl: 1, w: 18, dmg: 0.62, aps: 1.65, tint: 0xa2a9b2, implicit: imp('critChance', 2, 3, 0.02) },
    { id: 'longsword', label: 'Longsword', arch: 'sword', family: 'metal', ilvl: 12, w: 22, dmg: 1.30, aps: 1.05, tint: 0x9fa7b0, implicit: imp('damagePct', 4, 7, 0.05) },
    { id: 'warmace', label: 'War Mace', arch: 'mace', family: 'metal', ilvl: 14, w: 18, dmg: 1.55, aps: 0.88, tint: 0x86899b, implicit: imp('overpower', 10, 18, 0.14) },
    { id: 'greataxe', label: 'Greataxe', arch: 'axe', family: 'metal', ilvl: 24, w: 16, dmg: 1.95, aps: 0.74, tint: 0x8d949c, hands: 2, implicit: imp('areaDamage', 8, 14, 0.1) },
    { id: 'runestaff', label: 'Runestaff', arch: 'staff', family: 'wood', ilvl: 20, w: 15, dmg: 1.62, aps: 0.92, tint: 0x6b543c, hands: 2, implicit: imp('resource', 10, 18, 0.3) },
    { id: 'scythe', label: 'Reaper Scythe', arch: 'scythe', family: 'metal', ilvl: 34, w: 12, dmg: 1.80, aps: 0.82, tint: 0x8b9298, hands: 2, implicit: imp('dotPotency', 8, 14, 0.1) },
    { id: 'huntbow', label: 'Hunting Bow', arch: 'bow', family: 'wood', ilvl: 8, w: 13, dmg: 1.18, aps: 1.12, tint: 0x6f5739, hands: 2, implicit: imp('attackSpeed', 3, 5, 0.03) },
  ],
  offhand: [
    { id: 'buckler', label: 'Iron Buckler', arch: 'shield', family: 'metal', ilvl: 1, w: 22, ar: 1.25, tint: 0x8b939c, implicit: imp('blockChance', 3, 5, 0.03) },
    { id: 'kite', label: 'Kite Shield', arch: 'shield', family: 'metal', ilvl: 14, w: 22, ar: 1.75, tint: 0x878f99, implicit: imp('blockAmount', 6, 10, 0.08) },
    { id: 'tower', label: 'Tower Shield', arch: 'towershield', family: 'metal', ilvl: 32, w: 15, ar: 2.15, tint: 0x7f8791, implicit: imp('armourPct', 3, 5, 0.03) },
    { id: 'grimoire', label: 'Grimoire', arch: 'tome', family: 'leather', ilvl: 10, w: 18, ar: 0.7, tint: 0x5b4436, implicit: imp('cdr', 3, 5, 0.035) },
    { id: 'focus', label: 'Focus Orb', arch: 'orb', family: 'gem', ilvl: 22, w: 16, ar: 0.62, tint: 0x5f7fa8, implicit: imp('resourceRegen', 7, 12, 0.09) },
    { id: 'quiver', label: 'Bonebolt Quiver', arch: 'quiver', family: 'leather', ilvl: 18, w: 14, ar: 0.6, tint: 0x6a5340, implicit: imp('attackSpeed', 3, 5, 0.03) },
  ],
};
BASES.ring1 = BASES.ring;
BASES.ring2 = BASES.ring;

export const BASE_BY_ID = new Map();
for (const k of ['helm', 'chest', 'gloves', 'boots', 'belt', 'amulet', 'ring', 'weapon', 'offhand']) {
  for (const b of BASES[k]) { b.slot = k; BASE_BY_ID.set(b.id, b); }
}

/* material family look-up — tint jitter, icon shading, mesh material family */
export const FAMILY = {
  metal: { metalness: 0.92, roughness: 0.38, spec: 0xdfe6ee, deep: 0x22262b, wear: 0.55, trim: 'rivets' },
  gold: { metalness: 1.00, roughness: 0.28, spec: 0xffe9a8, deep: 0x33240a, wear: 0.40, trim: 'filigree' },
  leather: { metalness: 0.05, roughness: 0.72, spec: 0xa08a6c, deep: 0x201810, wear: 0.66, trim: 'studs' },
  cloth: { metalness: 0.00, roughness: 0.86, spec: 0x8f8878, deep: 0x1c1a18, wear: 0.60, trim: 'plain' },
  bone: { metalness: 0.02, roughness: 0.66, spec: 0xf1e8cc, deep: 0x2b271d, wear: 0.72, trim: 'runes' },
  wood: { metalness: 0.02, roughness: 0.78, spec: 0xa8875c, deep: 0x1f170f, wear: 0.70, trim: 'plain' },
  gem: { metalness: 0.15, roughness: 0.10, spec: 0xeaf6ff, deep: 0x0d1826, wear: 0.18, trim: 'runes' },
};
export const familyOf = (k) => FAMILY[k] ?? FAMILY.metal;

/* ==================================================================== *
 * item sets
 * ==================================================================== */

export const SETS = {
  ashenVigil: {
    id: 'ashenVigil', label: 'Regalia of the Ashen Vigil', short: 'Ashen Vigil', theme: 'fire',
    slots: ['helm', 'chest', 'gloves', 'boots', 'belt', 'amulet'],
    bonuses: [
      { pieces: 2, text: '+120 Armour and +8% Fire Resistance.', stats: { armour: 120, resFire: 8 } },
      { pieces: 4, text: '+18% Damage and +12% Attack Speed.', stats: { damagePct: 18, attackSpeed: 12 } },
      { pieces: 6, text: 'Your kills erupt in cinders, and burning enemies take +25% damage.', stats: { areaDamage: 25, dotPotency: 25 } },
    ],
  },
  lowDoor: {
    id: 'lowDoor', label: 'Wardens of the Low Door', short: 'Low Door', theme: 'physical',
    slots: ['helm', 'chest', 'gloves', 'boots', 'offhand', 'ring'],
    bonuses: [
      { pieces: 2, text: '+10% Total Armour.', stats: { armourPct: 10 } },
      { pieces: 4, text: '+14% Maximum Life and +260 Thorns.', stats: { lifePct: 14, thorns: 260 } },
      { pieces: 6, text: 'Blocking reflects the blow. +30% Blocked Damage Reduction.', stats: { blockAmount: 30, blockChance: 8 } },
    ],
  },
  ninthHour: {
    id: 'ninthHour', label: 'Vestments of the Ninth Hour', short: 'Ninth Hour', theme: 'shadow',
    slots: ['helm', 'chest', 'gloves', 'belt', 'amulet', 'ring'],
    bonuses: [
      { pieces: 2, text: '+6% Cooldown Reduction.', stats: { cdr: 6 } },
      { pieces: 4, text: '+45 Maximum Resource and +20% Resource Generation.', stats: { resource: 45, resourceRegen: 20 } },
      { pieces: 6, text: 'Shadow damage over time spreads to a nearby enemy on death.', stats: { dotPotency: 30, resShadow: 15 } },
    ],
  },
};
export const SET_LIST = Object.values(SETS);

function setForBase(base, rand) {
  const s = baseSlot(base.slot);
  const eligible = SET_LIST.filter((x) => x.slots.includes(s));
  if (!eligible.length) return null;
  return eligible[Math.min(eligible.length - 1, Math.floor(rand() * eligible.length))];
}

/* ==================================================================== *
 * rarity rolling
 * ==================================================================== */

/**
 * Weighted rarity roll. `luck` folds in elite/boss status and monster level;
 * `magicFind` is the player's stat, in percent.
 * `floor` guarantees a minimum rarity (boss drops).
 */
export function rollRarity(rand, { luck = 0, magicFind = 0, floor = null } = {}) {
  const mf = 1 + magicFind / 100;
  const l = Math.max(0, luck);
  const w = {
    common: Math.max(2, 620 * Math.pow(0.42, l)),
    magic: 300 * (1 + l * 0.25),
    rare: 88 * (1 + l * 0.85) * mf,
    legendary: 15 * (1 + l * 1.9) * mf,
    unique: 3.4 * (1 + l * 2.4) * mf,
    mythic: 0.42 * (1 + l * 3.2) * mf,
  };
  const minOrder = floor ? rarityRank(floor) : 0;
  let total = 0;
  for (const k of RARITY_ORDER) { if (rarityRank(k) < minOrder) w[k] = 0; total += w[k]; }
  let x = rand() * total;
  for (const k of RARITY_ORDER) { x -= w[k]; if (x <= 0) return k; }
  return floor ?? 'common';
}

function pickBase(rand, slot, ilvl) {
  const pool = BASES[baseSlot(slot)] ?? BASES.weapon;
  const legal = pool.filter((b) => b.ilvl <= ilvl);
  const list = legal.length ? legal : [pool[0]];
  // Newer bases are rarer but not gated out: weight by declared w, damped by
  // how recently they unlocked, so a level-50 drop still occasionally rolls a
  // humble Falchion base with monstrous affixes — the "good base" chase.
  let total = 0;
  const ws = list.map((b) => {
    const age = Math.min(1, (ilvl - b.ilvl) / 18);
    const wv = b.w * (0.35 + 0.65 * age);
    total += wv;
    return wv;
  });
  let x = rand() * total;
  for (let i = 0; i < list.length; i++) { x -= ws[i]; if (x <= 0) return list[i]; }
  return list[list.length - 1];
}

/* ==================================================================== *
 * derived numbers
 * ==================================================================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = (v) => Math.round(v * 10) / 10;

function rollImplicit(rand, base, ilvl) {
  const d = base.implicit;
  if (!d) return null;
  const meta = STATS[d.stat];
  if (!meta) return null;
  const q = rand();
  let v = d.min + (d.max - d.min) * q + (d.per ?? 0) * ilvl;
  v = meta.kind === 'pct' ? r1(v) : Math.round(v);
  return {
    id: `imp:${base.id}`,
    name: meta.label,
    kind: 'implicit',
    stat: d.stat,
    statLabel: meta.label,
    statKind: meta.kind,
    tier: 0,
    tierLabel: 'IMP',
    value: v,
    range: null,
    min: Math.round(d.min + (d.per ?? 0) * ilvl),
    max: Math.round(d.max + (d.per ?? 0) * ilvl),
    q: Math.round(q * 1000) / 1000,
    text: meta.kind === 'range' ? meta.fmt(Math.round(v * 0.7), Math.round(v * 1.3)) : meta.fmt(v),
    theme: 'physical',
  };
}

/** Aggregate every affix into a flat stat bag the character sheet can add up. */
export function aggregateStats(item) {
  const out = Object.create(null);
  const push = (a) => {
    if (!a) return;
    const meta = STATS[a.stat];
    if (!meta) return;
    if (meta.kind === 'range' && a.range) {
      const cur = out[a.stat] ?? { min: 0, max: 0 };
      out[a.stat] = { min: cur.min + a.range.min, max: cur.max + a.range.max };
    } else {
      out[a.stat] = (out[a.stat] ?? 0) + a.value;
    }
  };
  push(item.implicit);
  for (const a of item.affixes) push(a);
  for (const s of item.sockets) if (s.gem) push(s.gem.affix);
  return out;
}

/* ==================================================================== *
 * gems (socketables)
 * ==================================================================== */

export const GEM_KINDS = [
  { id: 'ruby', label: 'Ruby', stat: 'life', col: 0xc0322e, theme: 'blood', vals: [18, 240] },
  { id: 'sapphire', label: 'Sapphire', stat: 'resAll', col: 0x3f7fd0, theme: 'cold', vals: [2, 9] },
  { id: 'topaz', label: 'Topaz', stat: 'critDamage', col: 0xd8b23c, theme: 'lightning', vals: [6, 34] },
  { id: 'emerald', label: 'Emerald', stat: 'dexterity', col: 0x4f9e63, theme: 'decay', vals: [4, 46] },
  { id: 'amethyst', label: 'Amethyst', stat: 'armour', col: 0x8e6cd8, theme: 'shadow', vals: [24, 320] },
  { id: 'skull', label: 'Bone Chip', stat: 'thorns', col: 0xdcd2b4, theme: 'physical', vals: [22, 300] },
];
export const GEM_GRADES = ['Chipped', 'Flawed', 'Standard', 'Flawless', 'Royal', 'Perfect'];

export function makeGem(rand, ilvl = 1) {
  const k = GEM_KINDS[Math.min(GEM_KINDS.length - 1, Math.floor(rand() * GEM_KINDS.length))];
  const grade = clamp(Math.floor(ilvl / 12 + rand() * 1.4), 0, GEM_GRADES.length - 1);
  const t = grade / (GEM_GRADES.length - 1);
  const meta = STATS[k.stat];
  let v = k.vals[0] + (k.vals[1] - k.vals[0]) * Math.pow(t, 1.5);
  v = meta.kind === 'pct' ? r1(v) : Math.round(v);
  return {
    id: k.id, grade, label: `${GEM_GRADES[grade]} ${k.label}`, col: k.col, theme: k.theme,
    affix: {
      id: `gem:${k.id}`, name: k.label, kind: 'gem', stat: k.stat, statLabel: meta.label,
      statKind: meta.kind, tier: GEM_GRADES.length - grade, tierLabel: `G${grade + 1}`,
      value: v, range: null, min: k.vals[0], max: k.vals[1], q: t, text: meta.fmt(v), theme: k.theme,
    },
  };
}

/* ==================================================================== *
 * the item factory
 * ==================================================================== */

/**
 * Build one complete item.
 * @param {(()=>number)&{range:Function,int:Function,pick:Function,chance:Function}} rand
 * @param {{slot?:string, ilvl?:number, rarity?:string, luck?:number, magicFind?:number,
 *          uid?:string, forceSet?:string|null, sockets?:number|null}} o
 */
export function makeItem(rand, o = {}) {
  const ilvl = clamp(Math.round(o.ilvl ?? 10), 1, 100);
  const slot = o.slot ?? pickSlot(rand);
  const rarity = o.rarity ?? rollRarity(rand, { luck: o.luck ?? 0, magicFind: o.magicFind ?? 0 });
  const rInfo = rarityInfo(rarity);
  const base = o.base ? (BASE_BY_ID.get(o.base) ?? pickBase(rand, slot, ilvl)) : pickBase(rand, slot, ilvl);
  const fam = familyOf(base.family);
  const luck = clamp((o.luck ?? 0) * 0.22 + rInfo.order * 0.09, 0, 0.9);

  const implicit = rollImplicit(rand, base, ilvl);
  const affixes = rollAffixSet(rand, {
    slot, ilvl, prefixes: rInfo.prefixes, suffixes: rInfo.suffixes, luck,
  });
  const power = rInfo.powers > 0 ? rollPower(rand, slot, ilvl, luck) : null;
  const power2 = rInfo.powers > 1 ? rollPower(rand, slot, ilvl, luck) : null;

  /* set membership: uniques and a slice of legendaries are set pieces */
  let set = null;
  if (o.forceSet) set = SETS[o.forceSet] ?? null;
  else if ((rarity === 'unique' || rarity === 'mythic') && rand() < 0.42) set = setForBase(base, rand);
  else if (rarity === 'legendary' && rand() < 0.26) set = setForBase(base, rand);

  /* sockets */
  const nSock = o.sockets != null ? o.sockets : (rInfo.sockets > 0 && rand() < 0.55 ? 1 + Math.floor(rand() * rInfo.sockets) : 0);
  const sockets = [];
  for (let i = 0; i < nSock; i++) sockets.push({ gem: rand() < 0.55 ? makeGem(rand, ilvl) : null });

  const theme = dominantTheme(affixes, power, base.family === 'gold' ? 'holy' : 'physical');
  const name = set
    ? `${set.short} ${base.label}`
    : nameItem(rand, { rarity, baseLabel: base.label, slot, affixes, power, theme });

  const item = {
    uid: o.uid ?? `item:${Math.floor(rand() * 0x7fffffff).toString(36)}`,
    kind: 'gear',
    slot,
    baseId: base.id,
    baseLabel: base.label,
    arch: base.arch,
    family: base.family,
    hands: base.hands ?? 1,
    name,
    rarity,
    ilvl,
    reqLevel: clamp(Math.round(ilvl * 0.92) - 1, 1, 100),
    theme,
    implicit,
    affixes,
    power,
    powers: power2 ? [power, power2] : power ? [power] : [],
    sockets,
    set: set?.id ?? null,
    setLabel: set?.label ?? null,
    stack: 1,
  };

  /* ---- item-type numbers ---- */
  const grow = 1 + ilvl * 0.088;
  if (base.ar) {
    item.armour = Math.round(base.ar * 46 * grow * rInfo.statMul * (0.92 + rand() * 0.16));
  }
  if (base.dmg) {
    const mid = base.dmg * 11 * grow * rInfo.statMul * (0.94 + rand() * 0.12);
    const spread = mid * (0.22 + rand() * 0.18);
    item.damage = { min: Math.max(1, Math.round(mid - spread)), max: Math.round(mid + spread) };
    item.attackSpeed = r1(base.aps * (0.96 + rand() * 0.1));
    item.dps = Math.round(((item.damage.min + item.damage.max) / 2) * item.attackSpeed);
  }

  item.stats = aggregateStats(item);
  item.quality = itemQuality(item);
  item.value = itemValue(item);
  item.flavour = rarityRank(rarity) >= 3 ? flavourFor(rand) : null;
  item.iconSpec = iconFor(rand, item);
  item.icon = item.iconSpec.key;
  item.mesh = meshSpecFor(item, fam);
  return item;
}

function pickSlot(rand) {
  const w = [
    ['weapon', 16], ['chest', 13], ['helm', 12], ['gloves', 12], ['boots', 12],
    ['belt', 11], ['offhand', 10], ['amulet', 7], ['ring1', 7], ['ring2', 7],
  ];
  let total = 0; for (const [, v] of w) total += v;
  let x = rand() * total;
  for (const [k, v] of w) { x -= v; if (x <= 0) return k; }
  return 'weapon';
}

/** 0..1 — how well this instance rolled inside its own possibility space. */
export function itemQuality(item) {
  let sum = 0, n = 0;
  for (const a of item.affixes) { sum += a.q ?? 0.5; n++; }
  if (item.power) { sum += item.power.q ?? 0.5; n++; }
  if (item.implicit) { sum += item.implicit.q ?? 0.5; n++; }
  return n ? Math.round((sum / n) * 100) / 100 : 0.5;
}

export function itemValue(item) {
  const r = rarityInfo(item.rarity);
  let v = (8 + item.ilvl * 3.4) * r.value;
  v *= 0.8 + item.quality * 0.6;
  for (const s of item.sockets) if (s.gem) v += 40 + s.gem.grade * 65;
  return Math.round(v);
}

/* ==================================================================== *
 * currency / consumables / materials
 * ==================================================================== */

export const MATERIALS = {
  ironShard: { id: 'ironShard', label: 'Iron Shard', col: 0x9aa3ac, arch: 'material', family: 'metal', rank: 0 },
  boneDust: { id: 'boneDust', label: 'Bone Dust', col: 0xd6cba9, arch: 'material', family: 'bone', rank: 0 },
  emberGlass: { id: 'emberGlass', label: 'Ember Glass', col: 0xe0762a, arch: 'material', family: 'gem', rank: 1 },
  gravesilk: { id: 'gravesilk', label: 'Gravesilk', col: 0x6a6480, arch: 'material', family: 'cloth', rank: 1 },
  veiledSigil: { id: 'veiledSigil', label: 'Veiled Sigil', col: 0x8e6cd8, arch: 'rune', family: 'gem', rank: 2 },
  wardenAsh: { id: 'wardenAsh', label: "Warden's Ash", col: 0xc0392b, arch: 'rune', family: 'gem', rank: 3 },
};
export const MATERIAL_LIST = Object.values(MATERIALS);

export function makeGold(rand, amount, uid) {
  const n = Math.max(1, Math.round(amount));
  return {
    uid: uid ?? `gold:${Math.floor(rand() * 0x7fffffff).toString(36)}`,
    kind: 'gold', name: `${n} Gold`, rarity: 'common', slot: null, stack: n, value: n,
    arch: 'gold', family: 'gold', ilvl: 1, affixes: [], sockets: [], stats: {}, powers: [],
    icon: 'gem',
    iconSpec: iconFor(rand, { arch: 'gold', family: 'gold', rarity: 'common', stack: n, sockets: [], affixes: [], ilvl: 1 }),
    mesh: { arch: 'gold', family: 'gold', tint: 0xd8a842, glow: 0.35, scale: 1 },
    autoPickup: true,
  };
}

export const POTIONS = [
  { id: 'minor', label: 'Minor Healing Draught', heal: 0.35, col: 0xc0322e, ilvl: 1 },
  { id: 'greater', label: 'Greater Healing Draught', heal: 0.45, col: 0xd8402c, ilvl: 20 },
  { id: 'vigil', label: 'Vigil Elixir', heal: 0.60, col: 0xe0602c, ilvl: 45 },
];

export function makePotion(rand, ilvl = 1, uid) {
  const legal = POTIONS.filter((p) => p.ilvl <= ilvl);
  const p = legal[legal.length - 1] ?? POTIONS[0];
  return {
    uid: uid ?? `potion:${Math.floor(rand() * 0x7fffffff).toString(36)}`,
    kind: 'potion', potionId: p.id, name: p.label, rarity: 'common', slot: null, stack: 1,
    value: 24, arch: 'potion', family: 'gem', ilvl, heal: p.heal,
    affixes: [], sockets: [], stats: {}, powers: [],
    icon: 'potion',
    iconSpec: iconFor(rand, { arch: 'potion', family: 'gem', rarity: 'common', tint: p.col, sockets: [], affixes: [], ilvl }),
    mesh: { arch: 'potion', family: 'gem', tint: p.col, glow: 0.9, scale: 1 },
    autoPickup: true,
  };
}

export function makeMaterial(rand, matId, amount = 1, uid) {
  const m = MATERIALS[matId] ?? MATERIALS.ironShard;
  const n = Math.max(1, Math.round(amount));
  return {
    uid: uid ?? `mat:${m.id}:${Math.floor(rand() * 0x7fffffff).toString(36)}`,
    kind: 'material', materialId: m.id, name: n > 1 ? `${m.label} ×${n}` : m.label,
    rarity: m.rank >= 3 ? 'legendary' : m.rank >= 2 ? 'rare' : m.rank >= 1 ? 'magic' : 'common',
    slot: null, stack: n, value: 6 + m.rank * 45, arch: m.arch, family: m.family, ilvl: 1,
    affixes: [], sockets: [], stats: {}, powers: [],
    icon: hudIconKey(m.arch),
    iconSpec: iconFor(rand, { arch: m.arch, family: m.family, rarity: 'common', tint: m.col, stack: n, sockets: [], affixes: [], ilvl: 1 }),
    mesh: { arch: m.arch, family: m.family, tint: m.col, glow: m.rank >= 1 ? 0.7 : 0.12, scale: 1 },
    autoPickup: true,
  };
}

/* ==================================================================== *
 * icon descriptors — see the contract block at the top of this file
 * ==================================================================== */

/** Mirror a half-profile [[y, halfWidth], …] into a closed polygon. */
function sym(profile, cx = 0.5) {
  const out = [];
  for (const [y, h] of profile) out.push([cx + h, y]);
  for (let i = profile.length - 1; i >= 0; i--) out.push([cx - profile[i][1], profile[i][0]]);
  return out;
}

function circle(cx, cy, r, n = 20, sy = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * sy]);
  }
  return out;
}

const st = (a, b, w = 0.02, shade = 0.55) => ({ a, b, w, shade });

/**
 * One builder per archetype. `j` is a small seeded jitter in [-1,1] so two
 * Longswords are never bit-identical drawings.
 */
const SHAPES = {
  sword: (j) => ({
    outline: sym([
      [0.05, 0.030 + j * 0.006], [0.10, 0.050], [0.44, 0.058 + j * 0.008], [0.60, 0.050],
      [0.63, 0.075], [0.655, 0.020], [0.70, 0.026], [0.94, 0.022], [0.96, 0.048], [0.975, 0.040],
    ]),
    plates: [{ poly: sym([[0.07, 0.014], [0.55, 0.020], [0.62, 0.010]]), shade: 1.28 }],
    strokes: [st([0.5, 0.07], [0.5, 0.60], 0.008, 1.35), st([0.40, 0.635], [0.60, 0.635], 0.014, 0.42)],
    gems: [{ x: 0.5, y: 0.655, r: 0.030 }],
  }),
  dagger: (j) => ({
    outline: sym([
      [0.18, 0.026], [0.24, 0.052 + j * 0.006], [0.52, 0.056], [0.60, 0.040],
      [0.625, 0.090], [0.66, 0.019], [0.90, 0.016], [0.935, 0.038],
    ]),
    plates: [{ poly: sym([[0.20, 0.012], [0.55, 0.017]]), shade: 1.30 }],
    strokes: [st([0.5, 0.20], [0.5, 0.58], 0.007, 1.35)],
    gems: [{ x: 0.5, y: 0.66, r: 0.024 }],
  }),
  axe: (j) => ({
    outline: [
      [0.485, 0.06], [0.545, 0.06], [0.545, 0.30],
      [0.80, 0.20 + j * 0.02], [0.93, 0.36], [0.88, 0.52], [0.63, 0.50],
      [0.545, 0.47], [0.545, 0.95], [0.485, 0.95], [0.485, 0.47],
      [0.40, 0.50], [0.15, 0.52], [0.10, 0.36], [0.22, 0.20 - j * 0.02], [0.485, 0.30],
    ],
    plates: [{ poly: [[0.56, 0.30], [0.80, 0.235], [0.895, 0.37], [0.855, 0.475], [0.60, 0.455]], shade: 1.22 }],
    strokes: [st([0.515, 0.08], [0.515, 0.93], 0.010, 0.62), st([0.60, 0.34], [0.86, 0.40], 0.010, 1.28)],
    gems: [{ x: 0.515, y: 0.385, r: 0.026 }],
  }),
  mace: (j) => ({
    outline: sym([
      [0.05, 0.075 + j * 0.008], [0.11, 0.135], [0.20, 0.150], [0.29, 0.130], [0.34, 0.070],
      [0.38, 0.038], [0.86, 0.032], [0.90, 0.052], [0.955, 0.046],
    ]),
    plates: [{ poly: circle(0.5, 0.20, 0.075, 14, 1.05), shade: 1.20 }],
    strokes: [st([0.36, 0.115], [0.64, 0.115], 0.012, 0.45), st([0.5, 0.40], [0.5, 0.84], 0.008, 0.60)],
    gems: [{ x: 0.5, y: 0.20, r: 0.030 }],
  }),
  staff: (j) => ({
    outline: sym([
      [0.03, 0.036], [0.075, 0.086 + j * 0.01], [0.14, 0.092], [0.20, 0.060],
      [0.24, 0.026], [0.92, 0.024], [0.965, 0.044],
    ]),
    plates: [{ poly: circle(0.5, 0.115, 0.058, 16), shade: 0.85 }],
    strokes: [st([0.5, 0.26], [0.5, 0.90], 0.009, 1.22), st([0.42, 0.235], [0.58, 0.235], 0.014, 0.40),
      st([0.43, 0.52], [0.57, 0.52], 0.012, 0.42)],
    gems: [{ x: 0.5, y: 0.115, r: 0.040 }],
  }),
  scythe: (j) => ({
    outline: [
      [0.47, 0.10], [0.53, 0.10], [0.53, 0.95], [0.47, 0.95],
    ],
    plates: [{
      poly: [[0.50, 0.10], [0.72, 0.09 + j * 0.02], [0.90, 0.20], [0.94, 0.36],
        [0.86, 0.31], [0.74, 0.20], [0.56, 0.16], [0.50, 0.17]], shade: 1.26,
    }],
    strokes: [st([0.50, 0.12], [0.50, 0.93], 0.011, 0.60), st([0.54, 0.15], [0.88, 0.28], 0.008, 1.32)],
    gems: [{ x: 0.50, y: 0.145, r: 0.024 }],
  }),
  bow: (j) => ({
    outline: [
      [0.36, 0.06], [0.44, 0.07], [0.62, 0.28 + j * 0.02], [0.66, 0.50], [0.62, 0.72], [0.44, 0.93], [0.36, 0.94],
      [0.44, 0.86], [0.57, 0.70], [0.60, 0.50], [0.57, 0.30], [0.44, 0.14],
    ],
    plates: [],
    strokes: [st([0.40, 0.065], [0.40, 0.935], 0.008, 1.25), st([0.60, 0.44], [0.60, 0.56], 0.020, 0.45)],
    gems: [{ x: 0.63, y: 0.50, r: 0.022 }],
  }),
  shield: (j) => ({
    outline: [
      [0.22, 0.10], [0.78, 0.10], [0.80, 0.44 + j * 0.02], [0.66, 0.76], [0.50, 0.92],
      [0.34, 0.76], [0.20, 0.44 - j * 0.02],
    ],
    plates: [{ poly: [[0.30, 0.17], [0.70, 0.17], [0.71, 0.44], [0.60, 0.68], [0.50, 0.80], [0.40, 0.68], [0.29, 0.44]], shade: 1.16 },
      { poly: circle(0.50, 0.42, 0.10, 16), shade: 0.72 }],
    strokes: [st([0.50, 0.12], [0.50, 0.88], 0.012, 0.50), st([0.24, 0.30], [0.76, 0.30], 0.010, 0.52)],
    gems: [{ x: 0.50, y: 0.42, r: 0.036 }],
  }),
  towershield: (j) => ({
    outline: [
      [0.24, 0.05], [0.76, 0.05], [0.78, 0.72 + j * 0.02], [0.50, 0.95], [0.22, 0.72],
    ],
    plates: [{ poly: [[0.31, 0.11], [0.69, 0.11], [0.70, 0.70], [0.50, 0.87], [0.30, 0.70]], shade: 1.14 },
      { poly: [[0.42, 0.20], [0.58, 0.20], [0.58, 0.62], [0.50, 0.72], [0.42, 0.62]], shade: 0.70 }],
    strokes: [st([0.26, 0.24], [0.74, 0.24], 0.012, 0.48), st([0.26, 0.50], [0.74, 0.50], 0.012, 0.48)],
    gems: [{ x: 0.50, y: 0.36, r: 0.030 }],
  }),
  tome: (j) => ({
    outline: [[0.16, 0.14], [0.84, 0.16 + j * 0.02], [0.86, 0.86], [0.14, 0.84]],
    plates: [{ poly: [[0.20, 0.18], [0.80, 0.20], [0.82, 0.82], [0.18, 0.80]], shade: 1.10 },
      { poly: [[0.16, 0.14], [0.26, 0.145], [0.24, 0.845], [0.14, 0.84]], shade: 0.62 }],
    strokes: [st([0.34, 0.34], [0.72, 0.36], 0.010, 0.50), st([0.34, 0.50], [0.72, 0.52], 0.010, 0.50),
      st([0.34, 0.66], [0.62, 0.67], 0.010, 0.50)],
    gems: [{ x: 0.50, y: 0.20, r: 0.026 }],
  }),
  orb: () => ({
    outline: circle(0.50, 0.52, 0.32, 26),
    plates: [{ poly: circle(0.44, 0.44, 0.20, 20), shade: 1.30 }],
    strokes: [st([0.24, 0.66], [0.76, 0.66], 0.014, 0.42)],
    gems: [{ x: 0.50, y: 0.52, r: 0.13 }],
  }),
  quiver: (j) => ({
    outline: sym([[0.10, 0.13], [0.20, 0.145 + j * 0.01], [0.86, 0.125], [0.94, 0.09]]),
    plates: [{ poly: sym([[0.20, 0.10], [0.80, 0.088]]), shade: 1.12 }],
    strokes: [st([0.42, 0.02], [0.44, 0.14], 0.014, 1.30), st([0.52, 0.01], [0.53, 0.13], 0.014, 1.20),
      st([0.60, 0.03], [0.61, 0.15], 0.014, 1.28), st([0.36, 0.34], [0.64, 0.34], 0.016, 0.44),
      st([0.36, 0.62], [0.64, 0.62], 0.016, 0.44)],
    gems: [],
  }),
  helm: (j) => ({
    outline: sym([[0.14, 0.10], [0.20, 0.185 + j * 0.012], [0.42, 0.235], [0.62, 0.240], [0.76, 0.205], [0.84, 0.155]]),
    plates: [{ poly: sym([[0.16, 0.055], [0.36, 0.085], [0.58, 0.075]]), shade: 1.24 },
      { poly: [[0.34, 0.40], [0.66, 0.40], [0.66, 0.52], [0.34, 0.52]], shade: 0.40 }],
    strokes: [st([0.50, 0.15], [0.50, 0.40], 0.014, 1.28), st([0.26, 0.60], [0.74, 0.60], 0.012, 0.50)],
    gems: [{ x: 0.50, y: 0.26, r: 0.026 }],
  }),
  greathelm: (j) => ({
    outline: sym([[0.10, 0.115], [0.18, 0.205 + j * 0.012], [0.50, 0.225], [0.74, 0.215], [0.86, 0.16]]),
    plates: [{ poly: [[0.28, 0.36], [0.72, 0.36], [0.72, 0.45], [0.28, 0.45]], shade: 0.38 },
      { poly: [[0.28, 0.55], [0.72, 0.55], [0.72, 0.62], [0.28, 0.62]], shade: 0.38 }],
    strokes: [st([0.50, 0.11], [0.50, 0.84], 0.016, 1.22), st([0.22, 0.28], [0.78, 0.28], 0.012, 0.52)],
    gems: [{ x: 0.50, y: 0.20, r: 0.024 }],
  }),
  hood: (j) => ({
    outline: [[0.50, 0.08], [0.72, 0.20 + j * 0.02], [0.80, 0.46], [0.74, 0.78], [0.58, 0.90],
      [0.42, 0.90], [0.26, 0.78], [0.20, 0.46], [0.28, 0.20]],
    plates: [{ poly: [[0.50, 0.16], [0.66, 0.30], [0.68, 0.56], [0.50, 0.70], [0.32, 0.56], [0.34, 0.30]], shade: 0.52 }],
    strokes: [st([0.50, 0.09], [0.50, 0.16], 0.014, 1.20), st([0.30, 0.80], [0.70, 0.80], 0.016, 0.48)],
    gems: [{ x: 0.50, y: 0.42, r: 0.020 }],
  }),
  cuirass: (j) => ({
    outline: [[0.28, 0.14], [0.42, 0.10], [0.58, 0.10], [0.72, 0.14], [0.82, 0.30 + j * 0.02],
      [0.78, 0.62], [0.68, 0.86], [0.50, 0.92], [0.32, 0.86], [0.22, 0.62], [0.18, 0.30]],
    plates: [{ poly: [[0.36, 0.20], [0.64, 0.20], [0.70, 0.40], [0.66, 0.66], [0.50, 0.80], [0.34, 0.66], [0.30, 0.40]], shade: 1.16 },
      { poly: [[0.44, 0.14], [0.56, 0.14], [0.54, 0.30], [0.46, 0.30]], shade: 0.55 }],
    strokes: [st([0.50, 0.22], [0.50, 0.80], 0.012, 0.48), st([0.30, 0.46], [0.70, 0.46], 0.012, 0.52),
      st([0.32, 0.60], [0.68, 0.60], 0.012, 0.52)],
    gems: [{ x: 0.50, y: 0.34, r: 0.030 }],
  }),
  jerkin: (j) => ({
    outline: [[0.30, 0.16], [0.44, 0.11], [0.56, 0.11], [0.70, 0.16], [0.80, 0.34 + j * 0.02],
      [0.76, 0.68], [0.66, 0.88], [0.50, 0.92], [0.34, 0.88], [0.24, 0.68], [0.20, 0.34]],
    plates: [{ poly: [[0.34, 0.22], [0.66, 0.22], [0.70, 0.48], [0.62, 0.82], [0.38, 0.82], [0.30, 0.48]], shade: 1.10 }],
    strokes: [st([0.50, 0.18], [0.50, 0.86], 0.014, 0.44), st([0.36, 0.30], [0.64, 0.30], 0.010, 0.56),
      st([0.34, 0.56], [0.66, 0.56], 0.010, 0.56)],
    gems: [],
  }),
  robe: (j) => ({
    outline: [[0.34, 0.12], [0.50, 0.08], [0.66, 0.12], [0.76, 0.34 + j * 0.02],
      [0.84, 0.88], [0.50, 0.94], [0.16, 0.88], [0.24, 0.34]],
    plates: [{ poly: [[0.42, 0.14], [0.58, 0.14], [0.62, 0.60], [0.58, 0.88], [0.42, 0.88], [0.38, 0.60]], shade: 0.62 }],
    strokes: [st([0.50, 0.10], [0.50, 0.92], 0.010, 0.46), st([0.28, 0.44], [0.72, 0.44], 0.010, 0.56)],
    gems: [{ x: 0.50, y: 0.24, r: 0.022 }],
  }),
  gauntlet: (j) => ({
    outline: [[0.28, 0.20], [0.44, 0.12], [0.62, 0.14], [0.72, 0.26 + j * 0.02],
      [0.78, 0.56], [0.70, 0.84], [0.42, 0.88], [0.26, 0.70], [0.22, 0.40]],
    plates: [{ poly: [[0.34, 0.22], [0.60, 0.20], [0.68, 0.40], [0.62, 0.56], [0.36, 0.58], [0.30, 0.38]], shade: 1.22 },
      { poly: [[0.36, 0.62], [0.66, 0.60], [0.66, 0.80], [0.42, 0.83]], shade: 0.86 }],
    strokes: [st([0.32, 0.30], [0.66, 0.28], 0.010, 0.50), st([0.34, 0.44], [0.66, 0.42], 0.010, 0.50)],
    gems: [{ x: 0.49, y: 0.34, r: 0.024 }],
  }),
  wraps: (j) => ({
    outline: [[0.26, 0.22], [0.46, 0.14], [0.64, 0.18], [0.74, 0.34 + j * 0.02],
      [0.74, 0.62], [0.64, 0.86], [0.38, 0.86], [0.26, 0.62]],
    plates: [{ poly: [[0.30, 0.36], [0.72, 0.32], [0.72, 0.46], [0.30, 0.50]], shade: 0.66 },
      { poly: [[0.30, 0.56], [0.70, 0.52], [0.70, 0.66], [0.32, 0.70]], shade: 0.66 }],
    strokes: [st([0.28, 0.30], [0.72, 0.26], 0.012, 1.10), st([0.30, 0.74], [0.68, 0.70], 0.012, 0.48)],
    gems: [],
  }),
  boot: (j) => ({
    outline: [[0.32, 0.10], [0.56, 0.12], [0.60, 0.44], [0.82, 0.60 + j * 0.02],
      [0.86, 0.82], [0.80, 0.90], [0.26, 0.90], [0.24, 0.62], [0.28, 0.30]],
    plates: [{ poly: [[0.34, 0.16], [0.54, 0.18], [0.56, 0.44], [0.36, 0.44]], shade: 1.12 },
      { poly: [[0.26, 0.82], [0.86, 0.80], [0.86, 0.90], [0.26, 0.90]], shade: 0.44 }],
    strokes: [st([0.30, 0.32], [0.58, 0.32], 0.010, 0.54), st([0.30, 0.58], [0.74, 0.62], 0.010, 0.54)],
    gems: [],
  }),
  greave: (j) => ({
    outline: [[0.30, 0.08], [0.58, 0.10], [0.62, 0.42], [0.84, 0.58 + j * 0.02],
      [0.88, 0.84], [0.80, 0.92], [0.24, 0.92], [0.22, 0.60], [0.26, 0.28]],
    plates: [{ poly: [[0.32, 0.14], [0.56, 0.16], [0.58, 0.40], [0.34, 0.40]], shade: 1.24 },
      { poly: [[0.30, 0.46], [0.72, 0.56], [0.70, 0.74], [0.30, 0.72]], shade: 1.06 },
      { poly: [[0.24, 0.84], [0.88, 0.82], [0.88, 0.92], [0.24, 0.92]], shade: 0.42 }],
    strokes: [st([0.30, 0.22], [0.58, 0.24], 0.012, 0.50), st([0.44, 0.12], [0.44, 0.40], 0.010, 1.28)],
    gems: [{ x: 0.44, y: 0.26, r: 0.020 }],
  }),
  belt: (j) => ({
    outline: [[0.08, 0.38], [0.92, 0.36 + j * 0.02], [0.92, 0.62], [0.08, 0.64]],
    plates: [{ poly: [[0.38, 0.28], [0.62, 0.28], [0.64, 0.72], [0.36, 0.72]], shade: 1.26 },
      { poly: [[0.45, 0.40], [0.55, 0.40], [0.55, 0.60], [0.45, 0.60]], shade: 0.40 }],
    strokes: [st([0.10, 0.44], [0.34, 0.43], 0.012, 0.54), st([0.66, 0.43], [0.90, 0.42], 0.012, 0.54),
      st([0.10, 0.57], [0.34, 0.56], 0.012, 0.54), st([0.66, 0.56], [0.90, 0.55], 0.012, 0.54)],
    gems: [{ x: 0.50, y: 0.50, r: 0.026 }],
  }),
  sash: (j) => ({
    outline: [[0.06, 0.34], [0.94, 0.30 + j * 0.02], [0.94, 0.56], [0.62, 0.60],
      [0.58, 0.88], [0.44, 0.86], [0.46, 0.60], [0.06, 0.62]],
    plates: [{ poly: [[0.40, 0.30], [0.62, 0.29], [0.64, 0.60], [0.42, 0.61]], shade: 0.68 }],
    strokes: [st([0.08, 0.40], [0.92, 0.36], 0.012, 1.08), st([0.08, 0.54], [0.92, 0.50], 0.012, 0.46)],
    gems: [],
  }),
  amulet: (j) => ({
    outline: [[0.50, 0.06], [0.68, 0.14], [0.76, 0.34], [0.72, 0.44],
      [0.62, 0.40], [0.66, 0.62 + j * 0.02], [0.50, 0.92], [0.34, 0.62], [0.38, 0.40],
      [0.28, 0.44], [0.24, 0.34], [0.32, 0.14]],
    plates: [{ poly: [[0.50, 0.48], [0.62, 0.62], [0.50, 0.82], [0.38, 0.62]], shade: 1.20 }],
    strokes: [st([0.32, 0.16], [0.50, 0.09], 0.012, 1.16), st([0.68, 0.16], [0.50, 0.09], 0.012, 0.60)],
    gems: [{ x: 0.50, y: 0.64, r: 0.062 }],
  }),
  torc: () => ({
    outline: circle(0.50, 0.52, 0.30, 26),
    holes: [circle(0.50, 0.52, 0.20, 22)],
    plates: [],
    strokes: [st([0.36, 0.26], [0.42, 0.20], 0.024, 1.24), st([0.64, 0.26], [0.58, 0.20], 0.024, 1.24)],
    gems: [{ x: 0.40, y: 0.22, r: 0.036 }, { x: 0.60, y: 0.22, r: 0.036 }],
  }),
  ring: () => ({
    outline: circle(0.50, 0.56, 0.30, 26),
    holes: [circle(0.50, 0.56, 0.185, 22)],
    plates: [{ poly: circle(0.50, 0.22, 0.11, 16), shade: 1.24 }],
    strokes: [st([0.30, 0.42], [0.36, 0.30], 0.016, 0.60), st([0.70, 0.42], [0.64, 0.30], 0.016, 1.20)],
    gems: [{ x: 0.50, y: 0.22, r: 0.068 }],
  }),
  signet: () => ({
    outline: circle(0.50, 0.58, 0.28, 26),
    holes: [circle(0.50, 0.58, 0.175, 22)],
    plates: [{ poly: [[0.50, 0.06], [0.66, 0.18], [0.62, 0.36], [0.38, 0.36], [0.34, 0.18]], shade: 1.28 }],
    strokes: [st([0.30, 0.44], [0.37, 0.32], 0.016, 0.58), st([0.70, 0.44], [0.63, 0.32], 0.016, 1.22)],
    gems: [{ x: 0.50, y: 0.22, r: 0.058 }],
  }),
  gold: (j) => ({
    outline: [[0.12, 0.86], [0.20, 0.62], [0.34, 0.50 + j * 0.02], [0.52, 0.44], [0.70, 0.52],
      [0.82, 0.66], [0.88, 0.86]],
    plates: [{ poly: circle(0.36, 0.62, 0.11, 14, 0.7), shade: 1.30 },
      { poly: circle(0.62, 0.58, 0.10, 14, 0.7), shade: 1.18 },
      { poly: circle(0.50, 0.74, 0.12, 14, 0.7), shade: 1.06 }],
    strokes: [st([0.14, 0.84], [0.86, 0.84], 0.016, 0.50)],
    gems: [],
  }),
  potion: (j) => ({
    outline: sym([[0.08, 0.052], [0.16, 0.062], [0.22, 0.055], [0.32, 0.135 + j * 0.01],
      [0.66, 0.215], [0.86, 0.225], [0.94, 0.185]]),
    plates: [{ poly: sym([[0.36, 0.10], [0.64, 0.165], [0.86, 0.175], [0.90, 0.15]]), shade: 1.24 }],
    strokes: [st([0.40, 0.09], [0.60, 0.09], 0.028, 0.42), st([0.42, 0.52], [0.44, 0.78], 0.016, 1.34)],
    gems: [{ x: 0.50, y: 0.66, r: 0.10 }],
  }),
  material: (j) => ({
    outline: [[0.24, 0.72], [0.18, 0.48], [0.34, 0.30 + j * 0.02], [0.56, 0.26],
      [0.74, 0.38], [0.82, 0.62], [0.68, 0.80], [0.40, 0.82]],
    plates: [{ poly: [[0.34, 0.36], [0.56, 0.32], [0.66, 0.48], [0.52, 0.62], [0.34, 0.56]], shade: 1.26 },
      { poly: [[0.36, 0.62], [0.54, 0.66], [0.60, 0.78], [0.42, 0.80]], shade: 0.70 }],
    strokes: [st([0.34, 0.36], [0.52, 0.62], 0.010, 0.52)],
    gems: [],
  }),
  rune: (j) => ({
    outline: [[0.50, 0.08], [0.74, 0.30 + j * 0.02], [0.74, 0.70], [0.50, 0.92], [0.26, 0.70], [0.26, 0.30]],
    plates: [{ poly: [[0.50, 0.18], [0.66, 0.34], [0.66, 0.66], [0.50, 0.82], [0.34, 0.66], [0.34, 0.34]], shade: 0.60 }],
    strokes: [st([0.42, 0.34], [0.58, 0.34], 0.014, 1.34), st([0.50, 0.34], [0.50, 0.66], 0.014, 1.34),
      st([0.42, 0.66], [0.58, 0.66], 0.014, 1.34)],
    gems: [{ x: 0.50, y: 0.50, r: 0.055 }],
  }),
};

const ARCH_FALLBACK = 'material';

/**
 * Fine-grained archetype -> the icon `kind` the HUD's atlas already draws.
 * Keeping this mapping here (rather than in the HUD) means new base types can
 * be added without the UI needing to learn about them.
 */
export const HUD_ICON = {
  sword: 'sword', dagger: 'sword', mace: 'axe', axe: 'axe', scythe: 'axe',
  staff: 'staff', bow: 'bow',
  shield: 'shield', towershield: 'shield', tome: 'tome', orb: 'gem', quiver: 'scroll',
  helm: 'helm', greathelm: 'helm', hood: 'helm',
  cuirass: 'chest', jerkin: 'chest', robe: 'chest',
  gauntlet: 'gloves', wraps: 'gloves',
  boot: 'boots', greave: 'boots',
  belt: 'belt', sash: 'belt',
  amulet: 'amulet', torc: 'amulet',
  ring: 'ring', signet: 'ring',
  gold: 'gem', potion: 'potion', material: 'gem', rune: 'rune',
};
export const hudIconKey = (arch) => HUD_ICON[arch] ?? 'rune';

function shade(hex, k) {
  const r = clamp(Math.round(((hex >> 16) & 255) * k), 0, 255);
  const g = clamp(Math.round(((hex >> 8) & 255) * k), 0, 255);
  const b = clamp(Math.round((hex & 255) * k), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** Build the icon descriptor (`item.iconSpec`). See the contract up top. */
export function iconFor(rand, item) {
  const arch = SHAPES[item.arch] ? item.arch : ARCH_FALLBACK;
  const fam = familyOf(item.family);
  const rInfo = rarityInfo(item.rarity);
  const j = rand() * 2 - 1;
  const s = SHAPES[arch](j);

  const baseTint = item.tint ?? BASE_BY_ID.get(item.baseId)?.tint ?? 0x8b939c;
  /* rarity nudges the metal: legendary+ items are warmer and darker-bodied */
  const warm = rarityRank(item.rarity) >= 3 ? 1.06 : 1.0;
  const base = shade(baseTint, (0.94 + rand() * 0.12) * warm);
  const gemCol = item.sockets?.find?.((x) => x.gem)?.gem?.col
    ?? (ELEMENT_THEME[item.theme]?.col ?? rInfo.beam);

  const gems = (s.gems ?? []).map((g, i) => ({
    x: g.x, y: g.y, r: g.r,
    col: i === 0 ? gemCol : shade(gemCol, 0.7),
  }));

  return {
    arch,
    key: hudIconKey(arch),
    family: item.family ?? 'metal',
    outline: s.outline,
    holes: s.holes ?? [],
    plates: s.plates ?? [],
    strokes: s.strokes ?? [],
    gems,
    palette: {
      base,
      shade: shade(base, 0.52),
      deep: fam.deep,
      spec: fam.spec,
      accent: rInfo.beam,
    },
    metalness: fam.metalness,
    roughness: fam.roughness,
    wear: clamp(fam.wear * (0.7 + rand() * 0.6) * (1 - rarityRank(item.rarity) * 0.06), 0.08, 1),
    trim: rarityRank(item.rarity) >= 3 ? 'filigree' : fam.trim,
    glow: rarityRank(item.rarity) >= 3 ? 0.45 + rarityRank(item.rarity) * 0.14 : 0,
    rarity: item.rarity ?? 'common',
    frame: { line: rInfo.line, glow: rInfo.glow, deep: rInfo.deep },
    light: [-0.55, -0.83],
    stack: (item.stack ?? 1) > 1 ? item.stack : null,
  };
}

/**
 * Mesh spec for the world-drop model. Loot.js owns the geometry builders; this
 * only says *what* to build. `family` selects one of Loot's three shared
 * materials, `tint` is baked into vertex colour so no per-item material is
 * ever created.
 */
export function meshSpecFor(item, fam = null) {
  const f = fam ?? familyOf(item.family);
  const rank = rarityRank(item.rarity);
  return {
    arch: SHAPES[item.arch] ? item.arch : ARCH_FALLBACK,
    family: item.family ?? 'metal',
    tint: item.iconSpec?.palette?.base ?? BASE_BY_ID.get(item.baseId)?.tint ?? 0x8b939c,
    gem: item.iconSpec?.gems?.[0]?.col ?? rarityInfo(item.rarity).beam,
    glow: rank >= 3 ? 0.5 + rank * 0.16 : 0.05,
    metalness: f.metalness,
    scale: item.hands === 2 ? 1.12 : 1,
  };
}

/* ==================================================================== *
 * tooltip data — the shape the HUD reads
 * ==================================================================== */

/**
 * Structured tooltip payload. The HUD styles it; it never has to know the
 * itemisation rules.
 *
 * { name, rarity, frame, header, subheader, kindLine, blocks:[…], flavour,
 *   value, reqLevel, quality, compare:[…] }
 * Each block is { type:'primary'|'implicit'|'affix'|'socket'|'power'|'set'|'note',
 *                 lines:[{ text, tier, tierLabel, q, stat, delta }] }
 */
export function tooltipFor(item, compare = null) {
  const rInfo = rarityInfo(item.rarity);
  const blocks = [];

  if (item.kind === 'gear') {
    const primary = [];
    if (item.dps != null) {
      primary.push({ text: `${item.dps} Damage per Second`, big: true });
      primary.push({ text: `${item.damage.min}–${item.damage.max} per hit`, sub: true });
      primary.push({ text: `${item.attackSpeed.toFixed(2)} Attacks per Second`, sub: true });
    }
    if (item.armour != null) primary.push({ text: `${item.armour} Armour`, big: true });
    if (primary.length) blocks.push({ type: 'primary', lines: primary });

    if (item.implicit) {
      blocks.push({ type: 'implicit', lines: [{ text: item.implicit.text, tier: 0, tierLabel: 'IMPLICIT', q: item.implicit.q, stat: item.implicit.stat }] });
    }
    if (item.affixes.length) {
      blocks.push({
        type: 'affix',
        lines: item.affixes.map((a) => ({
          text: a.text, tier: a.tier, tierLabel: a.tierLabel, q: a.q, stat: a.stat, name: a.name,
        })),
      });
    }
    if (item.sockets.length) {
      blocks.push({
        type: 'socket',
        lines: item.sockets.map((s) => (s.gem
          ? { text: `${s.gem.label} — ${s.gem.affix.text}`, col: s.gem.col, filled: true }
          : { text: 'Empty Socket', filled: false })),
      });
    }
    for (const p of item.powers) {
      blocks.push({ type: 'power', lines: [{ text: p.text, name: p.name, q: p.q, tierLabel: 'ASPECT' }] });
    }
    if (item.set) {
      const set = SETS[item.set];
      blocks.push({
        type: 'set',
        lines: [{ text: set.label, name: set.label, header: true },
          ...set.bonuses.map((b) => ({ text: `(${b.pieces}) ${b.text}`, pieces: b.pieces }))],
      });
    }
  } else if (item.kind === 'potion') {
    blocks.push({ type: 'primary', lines: [{ text: `Restores ${Math.round(item.heal * 100)}% of Maximum Life`, big: true }] });
  } else if (item.kind === 'gold') {
    blocks.push({ type: 'primary', lines: [{ text: `${item.stack} Gold`, big: true }] });
  } else if (item.kind === 'material') {
    blocks.push({ type: 'primary', lines: [{ text: 'Crafting Material', big: true }] });
  }

  return {
    uid: item.uid,
    name: item.name,
    rarity: item.rarity,
    frame: { line: rInfo.line, glow: rInfo.glow, deep: rInfo.deep, text: rInfo.text },
    header: item.name,
    subheader: item.kind === 'gear'
      ? `${rInfo.label} ${item.baseLabel}${item.setLabel ? ' — Set' : ''}`
      : rInfo.label,
    kindLine: item.kind === 'gear' ? `${slotLabel(item.slot)} · Item Power ${item.ilvl}` : null,
    reqLevel: item.reqLevel ?? null,
    quality: item.quality ?? null,
    value: item.value ?? 0,
    icon: item.icon,
    iconSpec: item.iconSpec ?? null,
    blocks,
    flavour: item.flavour ?? null,
    compare: compare ?? null,
  };
}

export default {
  RARITIES, RARITY_ORDER, rarityInfo, rarityRank, SLOTS, SLOT_IDS, SLOT_BY_ID,
  BASES, BASE_BY_ID, FAMILY, familyOf, SETS, SET_LIST, GEM_KINDS, MATERIALS,
  makeItem, makeGold, makePotion, makeMaterial, makeGem, rollRarity,
  iconFor, hudIconKey, HUD_ICON, meshSpecFor, tooltipFor, aggregateStats, itemValue, itemQuality,
};
