/**
 * THE NINTH VIGIL — item model
 * ---------------------------------------------------------------------------
 * Deterministic item generation for the character screen and the tooltip. Real
 * ARPG data shape: a base (which decides the icon, the type line and the
 * primary stat), an item power, a rarity that decides how many affixes roll,
 * and a socket row. Everything is derived from `engine.freshRand(seed)` so a
 * given seed always yields the same item — the screenshot critic requires it.
 *
 * If a live `loot` module ever appears the HUD prefers its data; this is the
 * fallback that keeps the frame judgeable in the meantime.
 */

import { RARITY, RARITY_ORDER, rarityOf } from '../UITheme.js';

/* ------------------------------------------------------------------ bases */

export const SLOTS = [
  { id: 'helm',    label: 'Helm',      icon: 'helm' },
  { id: 'chest',   label: 'Chest',     icon: 'chest' },
  { id: 'gloves',  label: 'Gloves',    icon: 'gloves' },
  { id: 'belt',    label: 'Belt',      icon: 'belt' },
  { id: 'boots',   label: 'Boots',     icon: 'boots' },
  { id: 'amulet',  label: 'Amulet',    icon: 'amulet' },
  { id: 'cloak',   label: 'Cloak',     icon: 'cloak' },
  { id: 'bracers', label: 'Bracers',   icon: 'gloves' },
  { id: 'ring1',   label: 'Ring',      icon: 'ring' },
  { id: 'ring2',   label: 'Ring',      icon: 'ring' },
  { id: 'weapon',  label: 'Weapon',    icon: 'sword' },
  { id: 'offhand', label: 'Off-Hand',  icon: 'shield' },
];

const BASES = {
  weapon: [
    { name: 'Greatsword',   icon: 'sword',  type: 'Two-Handed Sword',  primary: 'dps', speed: 0.9 },
    { name: 'Warglaive',    icon: 'axe',    type: 'Two-Handed Axe',    primary: 'dps', speed: 0.8 },
    { name: 'Reaver Blade', icon: 'sword',  type: 'One-Handed Sword',  primary: 'dps', speed: 1.2 },
    { name: 'Warstaff',     icon: 'staff',  type: 'Two-Handed Staff',  primary: 'dps', speed: 0.85 },
    { name: 'Hunting Bow',  icon: 'bow',    type: 'Two-Handed Bow',    primary: 'dps', speed: 1.1 },
  ],
  offhand: [
    { name: 'Aegis',        icon: 'shield', type: 'Shield',            primary: 'block' },
    { name: 'Grimoire',     icon: 'tome',   type: 'Focus',             primary: 'power' },
  ],
  helm:    [{ name: 'Sallet',    icon: 'helm',   type: 'Helm',    primary: 'armour' },
            { name: 'Great Helm', icon: 'helm',  type: 'Helm',    primary: 'armour' }],
  chest:   [{ name: 'Cuirass',   icon: 'chest',  type: 'Chest Armour', primary: 'armour' },
            { name: 'Hauberk',   icon: 'chest',  type: 'Chest Armour', primary: 'armour' }],
  gloves:  [{ name: 'Gauntlets', icon: 'gloves', type: 'Gloves',  primary: 'armour' }],
  bracers: [{ name: 'Vambraces', icon: 'gloves', type: 'Bracers', primary: 'armour' }],
  belt:    [{ name: 'Girdle',    icon: 'belt',   type: 'Belt',    primary: 'armour' }],
  boots:   [{ name: 'Sabatons',  icon: 'boots',  type: 'Boots',   primary: 'armour' }],
  cloak:   [{ name: 'Mantle',    icon: 'cloak',  type: 'Cloak',   primary: 'armour' }],
  amulet:  [{ name: 'Talisman',  icon: 'amulet', type: 'Amulet',  primary: 'none' }],
  ring1:   [{ name: 'Band',      icon: 'ring',   type: 'Ring',    primary: 'none' }],
  ring2:   [{ name: 'Signet',    icon: 'ring',   type: 'Ring',    primary: 'none' }],
  misc:    [{ name: 'Elixir',    icon: 'potion', type: 'Elixir',  primary: 'none' },
            { name: 'Ruby',      icon: 'gem',    type: 'Gem',     primary: 'none' },
            { name: 'Sigil',     icon: 'scroll', type: 'Nocturn Sigil', primary: 'none' },
            { name: 'Codex',     icon: 'tome',   type: 'Tome',    primary: 'none' }],
};

const PREFIX = ['Gravewrought', 'Ashen', 'Coilbone', 'Sepulchral', 'Rotcalled', 'Emberforged',
  'Hollowed', 'Bloodsworn', 'Palewatch', 'Cindershorn', 'Thornclad', 'Duskbound'];
const SUFFIX = ['of the Forsworn', 'of Cold Vigil', 'of the Drowned', 'of Nine Wounds',
  'of the Unmade', 'of Grave Silence', 'of the Rotwood', 'of Iron Penance'];

const UNIQUE = {
  weapon: ['Rendmaw, Jaw of the Pit', 'Sorrowsong', 'The Widow\'s Answer', 'Gravebreaker'],
  chest:  ['Carapace of the Nine Martyrs', 'Shroud of Waning Faith'],
  helm:   ['Crown of the Hollow King', 'Visage of Silent Rot'],
  amulet: ['Heartcage of Malthrin', 'The Unbroken Vow'],
  ring1:  ['Ouroboros', 'Coil of the Deep Warden'],
  ring2:  ['Ouroboros', 'Coil of the Deep Warden'],
  offhand:['Bulwark of the Last Gate'],
  boots:  ['Strides of the Wretched Choir'],
  gloves: ['Grasp of the Flesh Sculptor'],
  belt:   ['Girdle of Bound Sorrow'],
  cloak:  ['Pall of the Long Night'],
  bracers:['Bindings of the Faithless'],
};

/* affix pools: [text template, min, max, unit] */
const AFFIX_OFF = [
  ['+{v}% Critical Strike Damage', 18, 62, ''],
  ['+{v}% Damage to Elites', 8, 24, ''],
  ['+{v} Strength', 18, 96, ''],
  ['+{v}% Attack Speed', 4, 11, ''],
  ['+{v}% Overpower Damage', 22, 78, ''],
  ['+{v}% Damage while Berserking', 10, 30, ''],
  ['+{v} Damage per Zeal Spent', 3, 14, ''],
  ['+{v}% Vulnerable Damage', 12, 44, ''],
];
const AFFIX_DEF = [
  ['+{v} Maximum Life', 84, 620, ''],
  ['+{v}% Damage Reduction from Bleeding', 6, 18, ''],
  ['+{v} Armour', 96, 780, ''],
  ['+{v}% Shadow Resistance', 7, 24, ''],
  ['+{v} Thorns', 42, 340, ''],
  ['+{v}% Life per Second', 1, 4, ''],
  ['+{v}% Block Chance', 3, 9, ''],
];
const AFFIX_UTIL = [
  ['+{v}% Movement Speed', 4, 16, ''],
  ['+{v}% Resource Generation', 5, 18, ''],
  ['+{v} Zeal on Kill', 2, 9, ''],
  ['+{v}% Lucky Hit Chance', 3, 11, ''],
  ['+{v} to Threshing Floor', 1, 4, ''],
];

const LEGENDARY_POWER = [
  'Sundering Cleave rends the earth, dealing {v}% of its damage to all enemies in a line.',
  'Every fifth strike releases a wave of grave-cold, Chilling enemies for {v}%.',
  'While below 40% Life you gain {v}% Damage Reduction and your wounds bleed fire.',
  'Killing an elite leaves a Sanctified Pool that restores {v} Life per second.',
];

const FLAVOUR = [
  '"They buried it face-down so it could not find the sky."',
  '"The smith wept as he quenched it. He would not say why."',
  '"Nine wore it. Nine were unmade. It is not tired yet."',
  '"Old iron remembers every hand that failed it."',
  '"Whatever it was made to hold, the hold did not last."',
  '"It hums when the dead are near. It has not stopped humming."',
  '"Penance, forged. Wear it and be forgiven nothing."',
];

/* ------------------------------------------------------------------ build */

const AFFIX_COUNT = { common: 0, magic: 2, rare: 3, legendary: 4, mythic: 5 };

/**
 * @param {import('../../core/Engine.js').Engine} engine
 * @param {number} seed
 * @param {{slot?:string, rarity?:string, power?:number, level?:number}} o
 */
export function makeItem(engine, seed, o = {}) {
  const r = engine.freshRand((seed | 0) ^ 0x5bf03635);
  const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))];
  const between = (a, b) => a + (b - a) * r();

  const slot = o.slot ?? 'weapon';
  const bases = BASES[slot] ?? BASES.misc;
  const base = pick(bases);
  const rarity = o.rarity ?? pick(['common', 'common', 'magic', 'magic', 'rare', 'rare', 'legendary', 'mythic']);
  const rar = rarityOf(rarity);
  const level = o.level ?? 60;
  const power = o.power ?? Math.round(700 + between(0, 225));

  /* name */
  let name;
  if (rarity === 'legendary' || rarity === 'mythic') {
    const u = UNIQUE[slot] ?? UNIQUE.weapon;
    name = u[Math.floor(r() * u.length) % u.length];
  } else if (rarity === 'rare') {
    name = `${pick(PREFIX)} ${base.name} ${pick(SUFFIX)}`;
  } else if (rarity === 'magic') {
    name = `${pick(PREFIX)} ${base.name}`;
  } else {
    name = base.name;
  }

  /* primary stat block */
  const stats = [];
  if (base.primary === 'dps') {
    const dps = Math.round(power * 2.35 + between(-40, 60));
    const lo = Math.round(dps * 0.62 / (base.speed ?? 1));
    const hi = Math.round(dps * 1.42 / (base.speed ?? 1));
    stats.push({ label: 'Damage Per Second', value: String(dps), big: true });
    stats.push({ label: `${lo} — ${hi} Damage per Hit`, value: '', sub: true });
    stats.push({ label: 'Attacks per Second', value: (base.speed ?? 1).toFixed(2), sub: true });
  } else if (base.primary === 'armour') {
    const ar = Math.round(power * 1.14 + between(-30, 40));
    stats.push({ label: 'Armour', value: String(ar), big: true });
  } else if (base.primary === 'block') {
    stats.push({ label: 'Block Chance', value: `${Math.round(between(28, 42))}%`, big: true });
    stats.push({ label: 'Armour', value: String(Math.round(power * 0.82)), sub: true });
  } else if (base.primary === 'power') {
    stats.push({ label: 'Skill Damage', value: `+${Math.round(between(18, 46))}%`, big: true });
  }

  /* affixes */
  const n = AFFIX_COUNT[rarity] ?? 2;
  const pool = base.primary === 'dps' || base.primary === 'power'
    ? [...AFFIX_OFF, ...AFFIX_UTIL, ...AFFIX_DEF]
    : [...AFFIX_DEF, ...AFFIX_UTIL, ...AFFIX_OFF];
  const used = new Set();
  const affixes = [];
  for (let i = 0; i < n; i++) {
    let a = null;
    for (let k = 0; k < 12; k++) {
      const cand = pool[Math.floor(r() * pool.length) % pool.length];
      if (!used.has(cand[0])) { a = cand; used.add(cand[0]); break; }
    }
    if (!a) break;
    const raw = between(a[1], a[2]);
    const v = a[2] <= 20 ? raw.toFixed(1).replace(/\.0$/, '') : String(Math.round(raw));
    affixes.push({ text: a[0].replace('{v}', v), greater: i === 0 && (rarity === 'legendary' || rarity === 'mythic') });
  }

  /* legendary power */
  let powerLine = null;
  if (rarity === 'legendary' || rarity === 'mythic') {
    const t = LEGENDARY_POWER[Math.floor(r() * LEGENDARY_POWER.length) % LEGENDARY_POWER.length];
    powerLine = t.replace('{v}', String(Math.round(between(18, 68))));
  }

  /* sockets */
  const nSock = rarity === 'common' ? 0 : rarity === 'magic' ? 1 : rarity === 'rare' ? 2 : 3;
  const sockets = [];
  for (let i = 0; i < nSock; i++) {
    const filled = r() < 0.55;
    sockets.push({ filled, gem: filled ? pick(['#b8352c', '#2f6bb0', '#3f8f4a', '#c8a13a']) : null });
  }

  return {
    id: `it${seed}`,
    name, rarity, rar, slot, level, power,
    icon: base.icon,
    type: base.type,
    stats, affixes, powerLine, sockets,
    flavour: rarity === 'legendary' || rarity === 'mythic' || r() < 0.35
      ? FLAVOUR[Math.floor(r() * FLAVOUR.length) % FLAVOUR.length] : null,
    reqLevel: Math.max(1, level - Math.round(between(0, 6))),
    sell: Math.round(between(1800, 24000)),
    upgrade: Math.floor(r() * 5),
  };
}

/** A full equipped set, one item per slot, deterministic. */
export function makeLoadout(engine, seed = 7) {
  const out = {};
  const rarPlan = {
    weapon: 'legendary', chest: 'legendary', helm: 'rare', gloves: 'rare', belt: 'magic',
    boots: 'rare', amulet: 'mythic', cloak: 'magic', bracers: 'common',
    ring1: 'legendary', ring2: 'rare', offhand: 'rare',
  };
  let i = 0;
  for (const s of SLOTS) {
    out[s.id] = makeItem(engine, seed * 131 + (i++) * 977, { slot: s.id, rarity: rarPlan[s.id] ?? 'magic' });
  }
  return out;
}

/** Backpack contents: 60 cells, ~22 filled, weighted toward lower rarity. */
export function makeBackpack(engine, seed = 11, cells = 60) {
  const r = engine.freshRand(seed ^ 0x2545f491);
  const slots = new Array(cells).fill(null);
  const slotIds = ['weapon', 'helm', 'chest', 'gloves', 'boots', 'belt', 'amulet', 'ring1', 'offhand', 'misc', 'misc', 'bracers', 'cloak'];
  const rarPool = ['common', 'common', 'common', 'magic', 'magic', 'magic', 'rare', 'rare', 'rare', 'legendary', 'mythic'];
  /* Fill density scales with the bag: a 24-item cap in a 77-cell bag leaves the
     grid two-thirds empty, which reads as an unfinished screen rather than a
     played character's stash. */
  const want = Math.max(18, Math.round(cells * 0.64));
  let placed = 0;
  for (let i = 0; i < cells && placed < want; i++) {
    if (r() > 0.74) continue;
    const slot = slotIds[Math.floor(r() * slotIds.length) % slotIds.length];
    const rarity = rarPool[Math.floor(r() * rarPool.length) % rarPool.length];
    slots[i] = makeItem(engine, (seed * 7919 + i * 104729) | 0, { slot, rarity });
    placed++;
  }
  return slots;
}

export { RARITY, RARITY_ORDER, rarityOf };
export default { makeItem, makeLoadout, makeBackpack, SLOTS };
