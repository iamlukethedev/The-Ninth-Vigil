/**
 * SANCTUM — world state.
 *
 * The persistent, serialisable truth about a run: which level we are on, how
 * hard it is, which rooms the player has seen and emptied, how many times they
 * have died, and the monster-level curve every spawn is scaled through.
 *
 * Nothing here touches THREE or the scene. It is pure data plus the curves that
 * turn "depth 4, player level 17, Nightmare" into concrete multipliers, so both
 * the Director and any HUD can read the same numbers.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Difficulty tiers. `hp`/`dmg` scale the bodies, `density` scales how many of
 * them an encounter authors, `loot`/`xp` are reward multipliers, `lvl` is the
 * monster-level offset, `elite` biases how often a pack gets a champion.
 */
export const DIFFICULTY = [
  { id: 'adventurer', label: 'Adventurer', hp: 0.78, dmg: 0.80, density: 0.86, loot: 1.00, xp: 1.00, lvl: -2, elite: 0.80, colour: 0x9aa7b4 },
  { id: 'veteran',    label: 'Veteran',    hp: 1.00, dmg: 1.00, density: 1.00, loot: 1.18, xp: 1.15, lvl: 0,  elite: 1.00, colour: 0xc9a86a },
  { id: 'nightmare',  label: 'Nightmare',  hp: 1.66, dmg: 1.42, density: 1.14, loot: 1.46, xp: 1.45, lvl: 3,  elite: 1.22, colour: 0xa26bd4 },
  { id: 'torment',    label: 'Torment',    hp: 2.62, dmg: 2.05, density: 1.28, loot: 1.88, xp: 1.90, lvl: 7,  elite: 1.48, colour: 0xd8632c },
  { id: 'abyssal',    label: 'Abyssal',    hp: 4.10, dmg: 2.95, density: 1.42, loot: 2.45, xp: 2.55, lvl: 12, elite: 1.78, colour: 0xb01f24 },
];

export const LOOT_TIERS = ['common', 'magic', 'rare', 'legendary', 'mythic'];

/** Named levels, so a toast never reads "Dungeon 3". */
const LEVEL_NAMES = [
  'The Forsaken Ossuary',
  'Halls of the Weeping Saint',
  'Cistern of Ash',
  'The Bonewright Vaults',
  'Sanctum of the Third Seal',
];

const BOSS_NAMES = [
  'Gravewarden Ossric',
  'The Weeping Saint',
  'Ashmaw, Cinder of the Deep',
  'Bonewright Prime',
  'Herald of the Third Seal',
];

/** Rank weights used everywhere a "how much threat is this" number is needed. */
export const RANK_WEIGHT = { normal: 1, champion: 2.6, boss: 6.5 };

export class WorldState {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.runSeed = 20250728;
    this.depth = 1;
    this.tierIndex = 1;

    this.playerLevel = 1;
    this.xp = 0;
    this.xpToNext = 220;
    /** Total XP this run credited *through* the Director, for the run summary. */
    this.earnedXp = 0;
    this._mul = null;
    this._mulKey = '';

    /** @type {Set<number>} */ this.discovered = new Set();
    /** @type {Set<number>} */ this.cleared = new Set();
    this.roomCount = 0;

    this.deaths = 0;
    this.kills = 0;
    this.eliteKills = 0;
    this.bossKills = 0;
    this.shrinesUsed = 0;
    this.runTime = 0;

    /** Set by the Director when a checkpoint is claimed. */
    this.checkpoint = { x: 0, z: 0, depth: 1, roomId: -1, label: 'Entrance' };

    this._revision = 0;
  }

  /* ------------------------------------------------------------- basics */

  get tier() { return DIFFICULTY[clamp(this.tierIndex | 0, 0, DIFFICULTY.length - 1)]; }
  get tierId() { return this.tier.id; }
  get levelName() {
    return LEVEL_NAMES[this.depth - 1] ?? `The Abyss — Depth ${this.depth}`;
  }
  get bossName() {
    return BOSS_NAMES[(this.depth - 1) % BOSS_NAMES.length];
  }
  /** Monotonically increases on every meaningful mutation — cheap dirty flag. */
  get revision() { return this._revision; }
  touch() { this._revision++; return this; }

  reset(opts = {}) {
    this.depth = Math.max(1, opts.depth ?? 1);
    this.tierIndex = clamp(opts.tierIndex ?? this.tierIndex, 0, DIFFICULTY.length - 1);
    this.discovered.clear();
    this.cleared.clear();
    this.roomCount = opts.roomCount ?? 0;
    this.deaths = 0;
    this.kills = 0;
    this.eliteKills = 0;
    this.bossKills = 0;
    this.shrinesUsed = 0;
    this.runTime = 0;
    this.xp = 0;
    this.earnedXp = 0;
    this._mul = null;
    this._mulKey = '';
    this.syncPlayerLevel();
    this.xpToNext = this.xpFor(this.playerLevel);
    this.checkpoint = { x: 0, z: 0, depth: this.depth, roomId: -1, label: 'Entrance' };
    return this.touch();
  }

  setTier(v) {
    const i = typeof v === 'string' ? DIFFICULTY.findIndex((t) => t.id === v) : v | 0;
    if (i < 0) return this;
    this.tierIndex = clamp(i, 0, DIFFICULTY.length - 1);
    return this.touch();
  }

  setDepth(d) {
    this.depth = Math.max(1, d | 0);
    this.discovered.clear();
    this.cleared.clear();
    return this.touch();
  }

  /**
   * Read the player's level from whoever owns progression.
   *
   * Ownership order matters: Loot's `Progression` is the authority when it
   * exists, then CombatSystem's player block, then the Hero's stats. The
   * Director must never be a *second* source of truth for level or XP — it only
   * needs the number to drive the monster-level curve.
   */
  syncPlayerLevel() {
    let lvl = this.playerLevel;
    try {
      const prog = this.engine.get('loot')?.progression;
      const combat = this.engine.get('combat');
      const hero = this.engine.get('hero');
      if (prog && Number.isFinite(prog.level)) lvl = prog.level;
      else if (combat && Number.isFinite(combat.player?.level)) lvl = combat.player.level;
      else if (hero && !hero.__dead && Number.isFinite(hero.stats?.level)) lvl = hero.stats.level;
    } catch { /* all of them are optional */ }
    this.playerLevel = clamp(Math.round(lvl) || 1, 1, 100);
    return this.playerLevel;
  }

  /** True when another module owns XP and levelling, so we must not double-award. */
  get externalProgression() {
    try {
      if (this.engine.get('loot')?.progression) return true;
      if (this.engine.get('combat')?.player) return true;
    } catch { /* noop */ }
    return false;
  }

  /* ------------------------------------------------- progression curves */

  xpFor(level) { return Math.round(180 + Math.pow(level, 1.62) * 46); }

  /**
   * Monster level: the player's level, plus the tier offset, plus a slow
   * per-depth climb. Kept inside +/- a sane band so a level-1 character in a
   * deep crypt is threatened, not deleted.
   */
  get monsterLevel() {
    const t = this.tier;
    const depthTerm = (this.depth - 1) * 1.6;
    return clamp(Math.round(this.playerLevel + t.lvl + depthTerm), 1, 110);
  }

  /** Level of a specific rank of body — champions and bosses out-level you. */
  levelFor(rank = 'normal') {
    const base = this.monsterLevel;
    if (rank === 'boss') return base + 3;
    if (rank === 'champion') return base + 1;
    return base;
  }

  /** Health / damage multipliers a spawned body is scaled through. */
  scaleFor(rank = 'normal') {
    const t = this.tier;
    const deep = 1 + (this.depth - 1) * 0.09;
    const rankHp = rank === 'boss' ? 1.0 : rank === 'champion' ? 1.0 : 1.0;
    return {
      hp: t.hp * deep * rankHp,
      dmg: t.dmg * (1 + (this.depth - 1) * 0.05),
      level: this.levelFor(rank),
    };
  }

  /** Pack size after density scaling, never below one body. */
  packSize(base) {
    const n = Math.round(base * this.tier.density);
    return Math.max(1, n);
  }

  /** Champion chance for an ordinary pack. */
  eliteChance(base = 0.14) { return clamp01(base * this.tier.elite); }

  /**
   * Loot quality. `mul` is a straight value multiplier; `bias` shifts the
   * rarity roll upward; `tier` is the best rarity this level can drop.
   */
  lootQuality() {
    const t = this.tier;
    const bias = clamp01((t.loot - 1) * 0.55 + (this.depth - 1) * 0.06);
    const idx = clamp(1 + Math.floor(bias * 4.2), 1, LOOT_TIERS.length - 1);
    return { mul: t.loot, bias, tier: LOOT_TIERS[idx], tierIndex: idx, magicFind: bias * 100 };
  }

  /* --------------------------------------------------------- bookkeeping */

  markDiscovered(roomId) {
    if (roomId == null || roomId < 0 || this.discovered.has(roomId)) return false;
    this.discovered.add(roomId);
    this.touch();
    return true;
  }

  markCleared(roomId) {
    if (roomId == null || roomId < 0 || this.cleared.has(roomId)) return false;
    this.cleared.add(roomId);
    this.discovered.add(roomId);
    this.touch();
    return true;
  }

  get exploration() {
    return this.roomCount > 0 ? clamp01(this.discovered.size / this.roomCount) : 0;
  }
  get clearProgress() {
    return this.roomCount > 0 ? clamp01(this.cleared.size / this.roomCount) : 0;
  }

  /**
   * Award XP. When another module owns progression this only *records* the award
   * for the run summary — it never levels the player, so there is exactly one
   * level-up event in the game no matter how many systems are loaded.
   *
   * @returns {{levelUp:boolean, level:number, gained:number, external:boolean}}
   */
  awardXp(amount) {
    const gain = Math.max(0, Math.round((amount || 0) * this.tier.xp));
    this.earnedXp += gain;
    if (this.externalProgression) {
      const before = this.playerLevel;
      this.syncPlayerLevel();
      this.touch();
      return { levelUp: this.playerLevel > before, level: this.playerLevel, gained: gain, external: true };
    }
    this.xp += gain;
    let levelUp = false;
    let guard = 0;
    while (this.xp >= this.xpToNext && this.playerLevel < 100 && guard++ < 12) {
      this.xp -= this.xpToNext;
      this.playerLevel++;
      this.xpToNext = this.xpFor(this.playerLevel);
      levelUp = true;
    }
    this.touch();
    return { levelUp, level: this.playerLevel, gained: gain, external: false };
  }

  /**
   * The difficulty view other modules read as `engine.get('director').worldState`.
   * Loot uses `.xp` and `.loot` as straight multipliers, so this object exposes
   * *multipliers*, never accumulated totals. Cached and only rebuilt when the
   * tier or depth actually moves.
   */
  get multipliers() {
    const t = this.tier;
    if (!this._mul || this._mulKey !== `${this.tierIndex}:${this.depth}`) {
      const q = this.lootQuality();
      this._mulKey = `${this.tierIndex}:${this.depth}`;
      this._mul = {
        xp: t.xp,
        loot: q.mul,
        hp: t.hp,
        dmg: t.dmg,
        density: t.density,
        magicFind: q.magicFind,
        lootTier: q.tier,
        difficulty: t.id,
        difficultyLabel: t.label,
        tierIndex: this.tierIndex,
        depth: this.depth,
        monsterLevel: this.monsterLevel,
      };
    } else {
      this._mul.monsterLevel = this.monsterLevel;
    }
    return this._mul;
  }

  /** XP a body of this rank is worth at the current monster level. */
  xpValue(rank = 'normal') {
    const w = RANK_WEIGHT[rank] ?? 1;
    return Math.round((8 + this.monsterLevel * 2.4) * w);
  }

  noteKill(rank = 'normal') {
    this.kills++;
    if (rank === 'champion') this.eliteKills++;
    else if (rank === 'boss') this.bossKills++;
    return this.touch();
  }

  noteDeath() { this.deaths++; return this.touch(); }

  setCheckpoint(x, z, roomId = -1, label = 'Waystone') {
    this.checkpoint = { x, z, depth: this.depth, roomId, label };
    return this.touch();
  }

  /* -------------------------------------------------------------- output */

  /** Flat, JSON-safe view for the bus and the HUD. */
  snapshot() {
    const q = this.lootQuality();
    return {
      depth: this.depth,
      levelName: this.levelName,
      bossName: this.bossName,
      difficulty: this.tier.id,
      difficultyLabel: this.tier.label,
      difficultyColour: this.tier.colour,
      tierIndex: this.tierIndex,
      playerLevel: this.playerLevel,
      monsterLevel: this.monsterLevel,
      xp: this.xp,
      earnedXp: this.earnedXp,
      xpToNext: this.xpToNext,
      xpFrac: this.xpToNext > 0 ? clamp01(this.xp / this.xpToNext) : 0,
      rooms: this.roomCount,
      discovered: this.discovered.size,
      cleared: this.cleared.size,
      exploration: this.exploration,
      clearProgress: this.clearProgress,
      deaths: this.deaths,
      kills: this.kills,
      eliteKills: this.eliteKills,
      bossKills: this.bossKills,
      shrinesUsed: this.shrinesUsed,
      runTime: this.runTime,
      checkpoint: { ...this.checkpoint },
      loot: q,
      revision: this._revision,
    };
  }
}

export default WorldState;
