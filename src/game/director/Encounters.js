/**
 * SANCTUM — encounter authoring and runtime.
 *
 * A level is not a uniform enemy soup. It is a *sequence*: you walk into a hall
 * and a patrol is already pacing it; you push a side chamber and something that
 * was waiting behind the sarcophagi closes the door behind you; a reliquary is
 * guarded by three bodies that never move until you touch it; a shrine chamber is
 * deliberately empty so the frame can breathe; a champion holds the last junction
 * and the boss holds the end.
 *
 * This file authors that sequence from the rooms the Dungeon actually built, then
 * runs it: proximity triggers, patrol routes, clear detection, rewards, retiring
 * distant packs back to dormant so the body count never runs away.
 *
 * Determinism: every choice comes from `engine.freshRand('<encounter id>')`, so
 * the same seed and the same layout always author the same level, and re-arming
 * after a death rebuilds the identical pack.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Species weight tables per room kind. Rooms have *character* — an ossuary is
 * full of the bones it stores, a chapel is where the acolytes are, a cistern is
 * where the drowned things live. `deep` entries only appear as depth rises.
 */
const ROOM_TABLES = {
  hall:         { base: [['skeleton', 3.0], ['ghoul', 2.0], ['hellhound', 1.4]], deep: [['brute', 1.5], ['cultist', 1.1]] },
  arena:        { base: [['hellhound', 2.6], ['brute', 1.9], ['ghoul', 1.3]], deep: [['cultist', 1.2], ['wraith', 0.9]] },
  ossuary:      { base: [['skeleton', 4.4], ['ghoul', 1.1]], deep: [['brute', 1.0], ['wraith', 1.0]] },
  chapel:       { base: [['cultist', 2.6], ['skeleton', 2.4]], deep: [['wraith', 1.5]] },
  cistern:      { base: [['ghoul', 3.6], ['wraith', 1.4]], deep: [['hellhound', 1.4]] },
  reliquary:    { base: [['skeleton', 2.2], ['cultist', 1.6]], deep: [['brute', 1.9], ['wraith', 1.2]] },
  catacomb:     { base: [['ghoul', 2.8], ['hellhound', 2.2], ['skeleton', 1.6]], deep: [['brute', 1.2]] },
  antechamber:  { base: [['skeleton', 2.6], ['hellhound', 1.8]], deep: [['ghoul', 1.4], ['cultist', 1.0]] },
};

/** Per-encounter-kind composition bias on top of the room table. */
const KIND_BIAS = {
  patrol:    { mul: 0.9, elite: 0.06, weights: null },
  ambush:    { mul: 1.15, elite: 0.10, weights: [['ghoul', 1.8], ['hellhound', 1.6], ['skeleton', 1.2]] },
  guard:     { mul: 1.0, elite: 0.34, weights: [['brute', 1.7], ['skeleton', 1.5], ['cultist', 1.1]] },
  champion:  { mul: 1.1, elite: 1.00, weights: null },
  horde:     { mul: 0.7, elite: 0.15, weights: [['ghoul', 2.4], ['skeleton', 2.2], ['hellhound', 1.8]] },
  shrine:    { mul: 0.45, elite: 0.0, weights: [['wraith', 1.5], ['cultist', 1.2]] },
  boss:      { mul: 0.5, elite: 0.0, weights: [['hellhound', 1.6], ['ghoul', 1.2]] },
  quiet:     { mul: 0, elite: 0, weights: null },
  entrance:  { mul: 0, elite: 0, weights: null },
};

const CHAMPION_TITLES = [
  'Ossric the Unquiet', 'Gravebound Maelor', 'The Rotwarden', 'Sister Vhaine',
  'Cinderjaw', 'The Tallow Priest', 'Marrowbound Kel', 'The Sighing Widow',
];

const ROOM_LABEL = {
  hall: 'the Great Hall', arena: 'the Arena', ossuary: 'the Ossuary',
  chapel: 'the Chapel', cistern: 'the Cistern', reliquary: 'the Reliquary',
  catacomb: 'the Catacombs', antechamber: 'the Antechamber',
};

/** Hard ceilings that keep the Director inside the draw-call budget. */
const CAPS = { bodies: 26, activeEncounters: 3, perEncounter: 11 };
/**
 * Metres past which a live pack is put back to sleep. Two rooms away is far
 * enough that the player has demonstrably disengaged, and reclaiming those
 * bodies is what stops a long run from accumulating forty skinned meshes.
 */
const RETIRE_DIST = 40;

let SEQ = 0;

export class EncounterPlan {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {import('./WorldState.js').WorldState} world
   * @param {import('./Pacing.js').Pacing} pacing
   */
  constructor(engine, world, pacing) {
    this.engine = engine;
    this.world = world;
    this.pacing = pacing;

    /** @type {Array<object>} authored encounters, entrance-first */
    this.list = [];
    this.byRoom = new Map();
    this.byEntity = new Map();
    this.rooms = [];
    this.entranceRoomId = -1;
    this.bossEncounter = null;
    this.hordeEncounter = null;
    this.tensionAtHero = 0;
    this.scenario = '';

    this._entry = { x: 0, z: 0 };
    this._spawnPoints = [];
    this._roomPoints = new Map();
    this._liveBodies = 0;
    this._activeCount = 0;
    this._pointCursor = 0;
  }

  get roomCount() { return this.rooms.length; }

  /* ================================================================ *
   * authoring
   * ================================================================ */

  /**
   * Read the built dungeon and lay a paced sequence of encounters over it.
   * Safe on an absent or empty dungeon: the plan is simply short.
   */
  build(name, cfg = {}) {
    this.scenario = name || '';
    this.list.length = 0;
    this.byRoom.clear();
    this.byEntity.clear();
    this._roomPoints.clear();
    this.bossEncounter = null;
    this.hordeEncounter = null;
    this._liveBodies = 0;
    this._activeCount = 0;
    this._pointCursor = 0;

    const dungeon = this._dungeon();
    const rawRooms = dungeon?.rooms?.length ? dungeon.rooms : null;
    this._spawnPoints = this._readSpawnPoints(dungeon, 'enemy');

    /* --- where the player comes in: the level's own player slot, else hero --- */
    const pspawn = this._readSpawnPoints(dungeon, 'player');
    const hero = this.engine.get('hero');
    this._entry.x = pspawn[0]?.x ?? hero?.position?.x ?? 0;
    this._entry.z = pspawn[0]?.z ?? hero?.position?.z ?? 0;

    if (!rawRooms) {
      // No architecture (exterior scenarios). Author a ring of open-field
      // encounters around the play area so pacing still has something to run.
      this.rooms = this._syntheticRooms(name, cfg);
    } else {
      this.rooms = rawRooms.map((r) => ({
        id: r.id, kind: r.kind ?? 'catacomb', grand: !!r.grand,
        cx: r.cx ?? 0, cz: r.cz ?? 0,
        w: r.w ?? 10, d: r.d ?? 10,
        minX: r.minX ?? (r.cx ?? 0) - 5, maxX: r.maxX ?? (r.cx ?? 0) + 5,
        minZ: r.minZ ?? (r.cz ?? 0) - 5, maxZ: r.maxZ ?? (r.cz ?? 0) + 5,
      }));
    }
    if (!this.rooms.length) return this;

    /* --- order rooms by how deep into the level they are --- */
    const order = this.rooms.map((r, i) => ({
      i, d: Math.hypot(r.cx - this._entry.x, r.cz - this._entry.z), area: r.w * r.d,
    }));
    order.sort((a, b) => (a.d - b.d) || (a.i - b.i));
    const n = order.length;
    this.entranceRoomId = this.rooms[order[0].i].id;

    /* --- role assignment: the pacing skeleton of the level --- */
    const rand = this.engine.freshRand(`plan:${name}:${this.world.depth}:${n}`);
    const kinds = this._assignKinds(order, rand);

    for (let k = 0; k < n; k++) {
      const room = this.rooms[order[k].i];
      const rank = n > 1 ? k / (n - 1) : 1;
      const enc = this._author(room, kinds[k], rank, k);
      if (!enc) continue;
      this.list.push(enc);
      this.byRoom.set(room.id, enc);
      if (enc.kind === 'boss') this.bossEncounter = enc;
      if (enc.kind === 'horde') this.hordeEncounter = enc;
    }
    return this;
  }

  /**
   * Roles, in the order the player meets them. The shape of this array *is* the
   * pacing of the level: quiet mouth, patrols and ambushes escalating, a
   * reliquary and a horde in the middle third, a champion at the last junction,
   * a deliberately empty shrine chamber, then the boss.
   */
  _assignKinds(order, rand) {
    const n = order.length;
    const kinds = new Array(n).fill('patrol');
    kinds[0] = 'entrance';
    if (n === 1) { kinds[0] = 'boss'; return kinds; }
    if (n === 2) { kinds[1] = 'boss'; return kinds; }

    kinds[n - 1] = 'boss';
    kinds[n - 2] = 'shrine';          // the beat of calm before the arena

    // Everything between the mouth and the calm room, back to front.
    const mid = [];
    for (let i = 1; i <= n - 3; i++) mid.push(i);
    if (!mid.length) return kinds;

    const pick = (from) => {
      if (!mid.length) return -1;
      const idx = from === 'late' ? mid.length - 1 - Math.floor(rand() * Math.min(2, mid.length))
        : from === 'early' ? Math.floor(rand() * Math.min(2, mid.length))
          : Math.floor(rand() * mid.length);
      const v = mid[clamp(idx, 0, mid.length - 1)];
      mid.splice(mid.indexOf(v), 1);
      return v;
    };

    const champion = pick('late');
    if (champion >= 0) kinds[champion] = 'champion';
    const guard = pick('any');
    if (guard >= 0) kinds[guard] = 'guard';
    if (mid.length >= 2) {
      const horde = pick('any');
      if (horde >= 0) kinds[horde] = 'horde';
    }
    const ambushes = Math.min(mid.length, 1 + Math.floor(n / 5));
    for (let a = 0; a < ambushes; a++) {
      const i = pick('any');
      if (i >= 0) kinds[i] = 'ambush';
    }
    // Whatever is left patrols — except one breather in the first half.
    if (mid.length) {
      const quiet = pick('early');
      if (quiet >= 0) kinds[quiet] = 'quiet';
    }
    return kinds;
  }

  /** Build one encounter record. */
  _author(room, kind, rank, index) {
    const bias = KIND_BIAS[kind] ?? KIND_BIAS.patrol;
    const id = `enc:${this.world.depth}:${room.id}:${kind}`;
    const rand = this.engine.freshRand(`${id}:${this.world.runSeed}`);
    const tension = this.pacing.tensionAt(rank);

    /* --- how many bodies --- */
    let count = 0;
    if (kind === 'boss') count = this.world.depth > 1 ? 2 : 0;
    else if (bias.mul > 0) {
      const base = this.pacing.packSizeFor(tension) * bias.mul;
      count = this.world.packSize(base);
      // Small rooms cannot hold a brawl; big halls should feel populated.
      const areaCap = Math.max(2, Math.floor((room.w * room.d) / 26));
      count = clamp(count, kind === 'quiet' ? 0 : 2, Math.min(CAPS.perEncounter, areaCap));
      if (kind === 'quiet') count = 0;
    }

    /* --- what they are --- */
    const comp = count > 0 ? this._compose(room, kind, count, rand) : [];
    const elite = kind === 'champion' || (count >= 3 && rand() < this.world.eliteChance(bias.elite));

    const halfSpan = Math.max(room.w, room.d) * 0.5;
    const trigger = kind === 'ambush' ? Math.min(halfSpan * 0.62, 9.5)
      : kind === 'guard' ? Math.min(halfSpan * 0.55, 8.0)
        : kind === 'boss' ? Math.min(halfSpan * 0.9, 17)
          : Math.min(halfSpan + 3.5, 16);

    const label = kind === 'boss' ? this.world.bossName
      : kind === 'champion' ? CHAMPION_TITLES[Math.floor(rand() * CHAMPION_TITLES.length) % CHAMPION_TITLES.length]
        : kind === 'guard' ? `Guarded Reliquary — ${ROOM_LABEL[room.kind] ?? 'a sealed vault'}`
          : kind === 'ambush' ? 'Ambush!'
            : kind === 'horde' ? 'The Tide Rises'
              : kind === 'shrine' ? `Shrine of ${ROOM_LABEL[room.kind] ?? 'the Forgotten'}`
                : ROOM_LABEL[room.kind] ?? 'the Catacombs';

    return {
      id, kind, index, roomId: room.id, room, rank, tension, label,
      seed: `${id}:${this.world.runSeed}`,
      state: 'dormant',                    // dormant -> armed -> active -> cleared
      trigger, count, comp, elite,
      /** @type {object[]} */ entities: [],
      total: 0, killed: 0,
      spawnedAt: -1, clearedAt: -1,
      phase: 1,
      checkpoint: kind === 'entrance' || kind === 'shrine' || kind === 'guard',
      reward: {
        xp: Math.round((18 + tension * 90) * (kind === 'boss' ? 6 : kind === 'champion' ? 2.4 : 1)),
        loot: kind === 'boss' ? 'legendary' : kind === 'guard' ? 'rare' : kind === 'champion' ? 'magic' : null,
      },
      patrol: kind === 'patrol' ? { route: null, i: 0, t: 0 } : null,
      telegraphed: false,
    };
  }

  /**
   * Composition: the room's own table, biased by the encounter kind, with the
   * heavier species unlocking as depth rises. Never a single species unless the
   * pack is tiny — a mixed pack is what makes a fight readable.
   */
  _compose(room, kind, count, rand) {
    const table = ROOM_TABLES[room.kind] ?? ROOM_TABLES.catacomb;
    const bias = KIND_BIAS[kind] ?? KIND_BIAS.patrol;
    const weights = new Map();
    const add = (list, scale = 1) => {
      for (const [s, w] of list) weights.set(s, (weights.get(s) ?? 0) + w * scale);
    };
    add(table.base);
    // Depth 1 sees none of the heavy table; by depth 4 it is fully in play.
    const deepGate = clamp01((this.world.depth - 1) / 3);
    if (deepGate > 0 && table.deep) add(table.deep, deepGate);
    if (bias.weights) add(bias.weights, 0.9);

    const entries = [...weights.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    let total = 0;
    for (const e of entries) total += e[1];

    const tally = new Map();
    for (let i = 0; i < count; i++) {
      let roll = rand() * total, picked = entries[0][0];
      for (const [s, w] of entries) { roll -= w; if (roll <= 0) { picked = s; break; } }
      tally.set(picked, (tally.get(picked) ?? 0) + 1);
    }
    // A pack of five identical bodies reads as a copy-paste error: force a
    // second species in by converting one body.
    if (tally.size === 1 && count >= 3 && entries.length > 1) {
      const only = [...tally.keys()][0];
      const alt = entries.find((e) => e[0] !== only)?.[0];
      if (alt) { tally.set(only, tally.get(only) - 1); tally.set(alt, 1); }
    }
    return [...tally.entries()].map(([species, c]) => ({ species, count: c }));
  }

  /** Open-field pseudo-rooms for scenarios with no dungeon architecture. */
  _syntheticRooms(name, cfg) {
    const t = cfg?.camera?.target ?? [0, 0, 0];
    const cx = t[0] ?? 0, cz = t[2] ?? 0;
    const rand = this.engine.freshRand(`plan:field:${name}`);
    const out = [{ id: 0, kind: 'hall', grand: true, cx, cz, w: 22, d: 22, minX: cx - 11, maxX: cx + 11, minZ: cz - 11, maxZ: cz + 11 }];
    const kinds = ['catacomb', 'ossuary', 'cistern', 'chapel', 'antechamber', 'reliquary'];
    const rings = 5;
    for (let i = 0; i < rings; i++) {
      const a = (i / rings) * Math.PI * 2 + rand() * 0.5;
      const r = 26 + rand() * 26;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const w = 16 + rand() * 10, d = 16 + rand() * 10;
      out.push({
        id: i + 1, kind: kinds[i % kinds.length], grand: false,
        cx: x, cz: z, w, d,
        minX: x - w * 0.5, maxX: x + w * 0.5, minZ: z - d * 0.5, maxZ: z + d * 0.5,
      });
    }
    return out;
  }

  /* ================================================================ *
   * arming / triggering
   * ================================================================ */

  armAll() {
    for (const e of this.list) {
      if (e.state === 'dormant') e.state = e.count > 0 || e.kind === 'boss' ? 'armed' : 'cleared';
    }
  }

  disarmAll() {
    for (const e of this.list) if (e.state === 'armed' || e.state === 'dormant') e.state = 'dormant';
  }

  /**
   * Adopt bodies that no encounter owns (the scenario harness spawned them) into
   * a synthetic encounter, so a capture frame has a real encounter behind it
   * without the Director adding a single extra draw call.
   */
  adoptLoose(intent) {
    const bes = this.engine.get('bestiary');
    const list = bes && !bes.__dead ? bes.entities : null;
    if (!list || !list.length) return null;

    const loose = [];
    let cx = 0, cz = 0, boss = null;
    for (const en of list) {
      if (!en || en.dead || this.byEntity.has(en)) continue;
      loose.push(en);
      cx += en.position.x; cz += en.position.z;
      if (en.isBoss || en.rank === 'boss') boss = en;
    }
    if (!loose.length) return null;
    cx /= loose.length; cz /= loose.length;

    /* Prefer a real authored encounter at that spot; fall back to a synthetic. */
    const room = this._roomAt(cx, cz) ?? this.rooms[0];
    let enc = boss ? this.bossEncounter : null;
    if (!enc) enc = room ? this.byRoom.get(room.id) : null;
    if (!enc || enc.kind === 'entrance' || enc.kind === 'quiet' || (boss && enc.kind !== 'boss')) {
      enc = {
        id: `enc:adopt:${intent}:${++SEQ}`,
        kind: boss ? 'boss' : intent === 'combat' ? 'champion' : 'patrol',
        index: -1, roomId: room?.id ?? -1, room: room ?? null,
        rank: boss ? 1 : 0.6, tension: boss ? 1 : 0.7,
        label: boss ? this.world.bossName : intent === 'combat' ? 'Ambush in the Great Hall' : 'A Patrol',
        seed: `adopt:${intent}`, state: 'armed', trigger: 14,
        count: loose.length, comp: [], elite: loose.some((e) => e.elite),
        entities: [], total: 0, killed: 0, spawnedAt: -1, clearedAt: -1,
        phase: 1, checkpoint: false, patrol: null, telegraphed: true,
        reward: { xp: Math.round(30 + loose.length * 14), loot: boss ? 'legendary' : null },
        adopted: true,
      };
      this.list.push(enc);
      if (room) this.byRoom.set(room.id, enc);
      if (boss) this.bossEncounter = enc;
    }

    for (const en of loose) {
      enc.entities.push(en);
      en.__encounter = enc.id;
      this.byEntity.set(en, enc);
    }
    enc.total = enc.entities.length;
    enc.count = enc.total;
    this._liveBodies += enc.entities.length;
    return enc;
  }

  /** Wake an encounter: spawn its pack (if it has not already) and announce it. */
  activate(enc, elapsed, silent = false) {
    if (!enc || enc.state === 'active' || enc.state === 'cleared') return enc;
    enc.state = 'active';
    enc.spawnedAt = elapsed;
    this._activeCount++;
    if (!enc.entities.length && (enc.comp.length || enc.kind === 'boss')) this._spawn(enc, elapsed);
    if (!silent) this._announce(enc);
    this.engine.bus.emit('director:encounter', this._encSnapshot(enc));
    return enc;
  }

  _announce(enc) {
    const bus = this.engine.bus;
    const tier = enc.kind === 'boss' ? 'boss' : enc.kind === 'champion' ? 'elite'
      : enc.kind === 'ambush' ? 'danger' : 'info';
    if (enc.kind !== 'patrol' && enc.kind !== 'quiet' && enc.kind !== 'entrance') {
      bus.emit('ui:toast', { text: enc.label, tier });
    }
    if (enc.kind === 'ambush') {
      bus.emit('camera:shake', { amp: 0.34, freq: 13, duration: 0.5 });
      bus.emit('audio:sfx', { id: 'ambush.sting', gain: 1 });
      const r = enc.room;
      if (r) {
        bus.emit('impact', {
          point: { x: r.cx, y: this._floorAt(r.cx, r.cz) + 0.05, z: r.cz },
          normal: { x: 0, y: 1, z: 0 }, kind: 'dust', magnitude: 0.9,
        });
      }
    } else if (enc.kind === 'champion') {
      bus.emit('camera:shake', { amp: 0.22, freq: 9, duration: 0.7 });
      bus.emit('audio:sfx', { id: 'champion.roar', gain: 1 });
    } else if (enc.kind === 'boss') {
      bus.emit('camera:shake', { amp: 0.8, freq: 8, duration: 1.4 });
      bus.emit('audio:cue', { id: 'music.boss', state: 'peak', gain: 1 });
    }
  }

  /* ================================================================ *
   * spawning
   * ================================================================ */

  _spawn(enc, elapsed) {
    const bes = this.engine.get('bestiary');
    if (!bes || bes.__dead || typeof bes.spawn !== 'function') return;
    if (this._liveBodies >= CAPS.bodies) return;

    const rand = this.engine.freshRand(`${enc.seed}:spawn`);
    const points = this._pointsFor(enc, rand);
    if (!points.length) return;

    let pi = 0;
    let eliteLeft = enc.kind === 'champion' ? 1 : enc.elite ? 1 : 0;
    const isBossRoom = enc.kind === 'boss';

    if (isBossRoom) {
      /* The level may have authored its own boss mark (an altar axis, an arena
         dais). Trust it — but only if it is actually inside the chamber this
         encounter owns, or the boss lands three rooms from its own fight. */
      const bp = this._readSpawnPoints(this._dungeon(), 'boss')
        .filter((p) => !enc.room || this._inRoom(enc.room, p.x, p.z, 2.0));
      const at = bp[0] ?? points[0] ?? { x: enc.room?.cx ?? 0, z: enc.room?.cz ?? 0 };
      const boss = this._spawnOne(bes, 'boss', at.x, at.z, {
        rank: 'boss', level: this.world.levelFor('boss'), seed: `${enc.seed}:boss`,
      }, enc);
      if (boss) {
        this.engine.bus.emit('director:boss', {
          id: boss.id, name: this.world.bossName, phase: 1,
          hp: boss.hp, maxHp: boss.maxHp, frac: 1,
        });
      }
    }

    for (const part of enc.comp) {
      for (let i = 0; i < part.count; i++) {
        if (this._liveBodies >= CAPS.bodies) break;
        const p = points[pi++ % points.length];
        const jitterA = rand() * Math.PI * 2, jitterR = rand() * 0.85;
        const x = p.x + Math.cos(jitterA) * jitterR;
        const z = p.z + Math.sin(jitterA) * jitterR;
        const asElite = eliteLeft > 0 && (i === 0);
        if (asElite) eliteLeft--;
        this._spawnOne(bes, part.species, x, z, {
          rank: asElite ? 'champion' : 'normal',
          level: this.world.levelFor(asElite ? 'champion' : 'normal'),
          seed: `${enc.seed}:${part.species}:${i}`,
          elite: asElite,
        }, enc);
      }
    }

    enc.total = enc.entities.length;
    if (enc.patrol) this._makeRoute(enc, rand);
    this._applyRoles(enc, elapsed);
  }

  _spawnOne(bes, species, x, z, o, enc) {
    let en = null;
    try {
      en = bes.spawn(species, { x, z }, {
        elite: !!o.elite, level: o.level,
        seed: hashStr(String(o.seed)) >>> 0,
      });
    } catch (e) { console.warn('[director] spawn —', e?.message ?? e); return null; }
    if (!en) return null;
    enc.entities.push(en);
    en.__encounter = enc.id;
    this.byEntity.set(en, enc);
    this._liveBodies++;
    return en;
  }

  /**
   * Where a pack stands. An ambush wants to be *around* the player, a guard pack
   * wants to be between the player and the prize, everything else takes the
   * level's own enemy slots inside its room.
   */
  _pointsFor(enc, rand) {
    const room = enc.room;
    const out = [];
    if (!room) return out;

    if (enc.kind === 'ambush') {
      // A ring biased to the far side of the room, so the pack closes in rather
      // than materialising on top of the player.
      const hero = this.engine.get('hero')?.position;
      const hx = hero?.x ?? room.cx, hz = hero?.z ?? room.cz;
      const away = Math.atan2(room.cz - hz, room.cx - hx);
      for (let i = 0; i < 12; i++) {
        const a = away + (i - 5.5) * 0.42 + (rand() - 0.5) * 0.25;
        const r = 5.4 + rand() * 3.4;
        const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
        if (this._standable(x, z) && this._inRoom(room, x, z, -0.6)) out.push({ x, z });
      }
      if (out.length >= 3) return out;
    }

    /* the level's own slots inside this room */
    for (const p of this._roomSlots(room)) out.push(p);
    if (out.length >= 3) return this._shuffle(out, rand);

    /* fall back to a seeded scatter inside the room's footprint */
    const rx = Math.max(1.5, room.w * 0.5 - 1.4);
    const rz = Math.max(1.5, room.d * 0.5 - 1.4);
    for (let i = 0; i < 40 && out.length < 12; i++) {
      const x = room.cx + (rand() * 2 - 1) * rx;
      const z = room.cz + (rand() * 2 - 1) * rz;
      if (this._standable(x, z)) out.push({ x, z });
    }
    if (!out.length) out.push({ x: room.cx, z: room.cz });
    return out;
  }

  _roomSlots(room) {
    let cached = this._roomPoints.get(room.id);
    if (cached) return cached;
    cached = [];
    for (const p of this._spawnPoints) {
      if (this._inRoom(room, p.x, p.z, -1.0)) cached.push(p);
    }
    this._roomPoints.set(room.id, cached);
    return cached;
  }

  /** Give the pack its job: guards hold station, patrols get a route. */
  _applyRoles(enc, elapsed) {
    const ai = this.engine.get('ai');
    if (!ai || ai.__dead) return;
    for (const en of enc.entities) {
      const agent = typeof ai.agentFor === 'function' ? ai.agentFor(en) : null;
      if (!agent) continue;
      agent.encounter = enc.id;
      if (enc.kind === 'guard' || enc.kind === 'boss') {
        agent.homeX = en.position.x; agent.homeZ = en.position.z;
      }
    }
    void elapsed;
  }

  /** A patrol route: two to four stations inside and just outside the room. */
  _makeRoute(enc, rand) {
    const room = enc.room;
    if (!room) return;
    const stations = [];
    const rx = Math.max(1.8, room.w * 0.5 - 2.0);
    const rz = Math.max(1.8, room.d * 0.5 - 2.0);
    const nStations = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < nStations; i++) {
      for (let tries = 0; tries < 10; tries++) {
        const a = (i / nStations) * Math.PI * 2 + rand() * 0.9;
        const x = room.cx + Math.cos(a) * rx * (0.45 + rand() * 0.55);
        const z = room.cz + Math.sin(a) * rz * (0.45 + rand() * 0.55);
        if (this._standable(x, z)) { stations.push({ x, z }); break; }
      }
    }
    if (stations.length < 2) stations.push({ x: room.cx, z: room.cz });
    enc.patrol.route = stations;
    enc.patrol.i = 0;
    enc.patrol.t = 3.5 + rand() * 3.0;
  }

  /* ================================================================ *
   * runtime
   * ================================================================ */

  tick(dt, elapsed, hero, director) {
    if (!this.list.length) return;
    this.tensionAtHero = this._tensionNear(hero);

    const hx = hero.x, hz = hero.z;

    /* Pass one: the census. Trigger decisions need the *total* body count, not a
       running partial sum, or a late encounter in the list can over-spawn. */
    let active = 0, live = 0;
    for (let i = 0; i < this.list.length; i++) {
      const enc = this.list[i];
      if (enc.state === 'active') active++;
      let alive = 0;
      for (let k = 0; k < enc.entities.length; k++) {
        const en = enc.entities[k];
        if (!en || en.dead || en.removeMe) continue;
        alive++;
      }
      enc.alive = alive;
      live += alive;
    }
    this._activeCount = active;
    this._liveBodies = live;

    for (let i = 0; i < this.list.length; i++) {
      const enc = this.list[i];
      const alive = enc.alive ?? 0;
      const room = enc.room;
      const d = room ? Math.hypot(room.cx - hx, room.cz - hz) : 1e9;

      /* discovery: seeing a room counts, clearing it is separate */
      if (d < (room ? Math.max(room.w, room.d) * 0.5 + 5 : 6)) {
        if (this.world.markDiscovered(enc.roomId)) {
          this.engine.bus.emit('director:room', {
            roomId: enc.roomId, kind: enc.room?.kind ?? 'room', label: enc.label,
            discovered: this.world.discovered.size, rooms: this.rooms.length,
          });
          director?.objectives?.noteDiscovered?.(this.world);
          if (enc.kind === 'boss') director?.objectives?.noteReachedAltar?.();
        }
        if (enc.checkpoint && enc.state !== 'active' && d < 4.5) {
          this._claimCheckpoint(enc, director);
        }
        // A room that never held anything is cleared by being walked through, so
        // "cleared / total" on the HUD can actually reach 100 %.
        if (enc.count === 0 && enc.kind !== 'boss' && this.world.markCleared(enc.roomId)) {
          director?.objectives?.setProgress?.('chain.rooms', this.world.cleared.size);
        }
      }

      if (enc.state === 'armed' && d <= enc.trigger) {
        if (this._activeCount < CAPS.activeEncounters && this._liveBodies + enc.count <= CAPS.bodies) {
          this.activate(enc, elapsed);
          this._liveBodies += enc.alive ?? 0;
          if (enc.kind === 'horde') director?.wave?.begin?.(elapsed, director, hero);
          director?.objectives?.setActiveEncounter?.(enc);
        }
      } else if (enc.state === 'active') {
        if (alive === 0 && enc.total > 0 && enc.kind !== 'horde') this._clear(enc, elapsed, director);
        else if (alive === 0 && enc.kind === 'horde' && !director?.wave?.active) this._clear(enc, elapsed, director);
        else if (d > RETIRE_DIST) { this._retire(enc); this._activeCount--; }
        else if (enc.patrol) this._tickPatrol(enc, dt, elapsed);
      }
    }

    const near = this._nearestActive(hx, hz);
    director._nearEncounter = near;
  }

  /** Posed scenarios: no triggers, but adopted packs still resolve and clear. */
  tickPassive(dt, elapsed, director) {
    let live = 0;
    for (const enc of this.list) {
      let alive = 0;
      for (const en of enc.entities) if (en && !en.dead) alive++;
      enc.alive = alive;
      live += alive;
      if (enc.state === 'active' && alive === 0 && enc.total > 0) this._clear(enc, elapsed, director);
    }
    this._liveBodies = live;
    void dt;
  }

  /** Walk each patrol group's anchor along its route; the Brain does the rest. */
  _tickPatrol(enc, dt, elapsed) {
    const P = enc.patrol;
    if (!P?.route || P.route.length < 2) return;
    P.t -= dt;
    if (P.t > 0) return;
    P.i = (P.i + 1) % P.route.length;
    const st = P.route[P.i];
    const rand = this.engine.freshRand(`${enc.seed}:route:${P.i}`);
    P.t = 5.0 + rand() * 4.0;
    const ai = this.engine.get('ai');
    if (!ai || ai.__dead || typeof ai.agentFor !== 'function') return;
    let k = 0;
    for (const en of enc.entities) {
      if (!en || en.dead) continue;
      const agent = ai.agentFor(en);
      if (!agent) continue;
      // Spread the group around the station so they walk as a file, not a stack.
      const a = (k++ / Math.max(1, enc.alive)) * Math.PI * 2;
      agent.homeX = st.x + Math.cos(a) * 1.5;
      agent.homeZ = st.z + Math.sin(a) * 1.5;
    }
    void elapsed;
  }

  _clear(enc, elapsed, director) {
    if (enc.state === 'cleared') return;
    enc.state = 'cleared';
    enc.clearedAt = elapsed;
    this.world.markCleared(enc.roomId);

    const bus = this.engine.bus;
    if (enc.total > 0) {
      const gain = this.world.awardXp(enc.reward.xp);
      if (gain.levelUp && !gain.external) bus.emit('level:up', { level: gain.level, stats: this.engine.get('hero')?.stats ?? null });
      const tier = enc.kind === 'boss' ? 'boss' : enc.kind === 'champion' ? 'elite' : 'info';
      bus.emit('ui:toast', {
        text: enc.kind === 'boss' ? `${enc.label} has fallen`
          : enc.kind === 'guard' ? 'The reliquary is yours'
            : `${enc.label} cleared`,
        tier,
      });
      if (enc.reward.loot) this._dropLoot(enc);
      bus.emit('audio:sfx', { id: enc.kind === 'boss' ? 'boss.death' : 'encounter.clear', gain: 1 });
    }
    if (enc.kind === 'boss') {
      bus.emit('camera:shake', { amp: 0.9, freq: 6, duration: 2.0 });
      bus.emit('director:boss', { name: this.world.bossName, phase: 0, dead: true });
    }
    if (enc.checkpoint) this._claimCheckpoint(enc, director);
    bus.emit('director:encounter', this._encSnapshot(enc));
    director?.objectives?.noteEncounterCleared?.(enc, this.world);
  }

  _dropLoot(enc) {
    const q = this.world.lootQuality();
    const room = enc.room;
    const rand = this.engine.freshRand(`${enc.seed}:loot`);
    const drops = enc.kind === 'boss' ? 4 : enc.kind === 'guard' ? 3 : 1;
    for (let i = 0; i < drops; i++) {
      const a = rand() * Math.PI * 2, r = rand() * 1.9;
      const x = (room?.cx ?? 0) + Math.cos(a) * r;
      const z = (room?.cz ?? 0) + Math.sin(a) * r;
      const roll = clamp01(rand() * 0.7 + q.bias + (i === 0 ? 0.22 : 0));
      const tierIdx = clamp(Math.floor(roll * 4.6), 0, 4);
      this.engine.bus.emit('loot:drop', {
        item: {
          id: `${enc.id}:drop:${i}`,
          rarity: ['common', 'magic', 'rare', 'legendary', 'mythic'][tierIdx],
          level: this.world.monsterLevel,
          value: Math.round((28 + this.world.monsterLevel * 9) * q.mul * (1 + tierIdx * 0.65)),
          source: enc.kind,
        },
        position: { x, y: this._floorAt(x, z) + 0.1, z },
      });
    }
  }

  _claimCheckpoint(enc, director) {
    const room = enc.room;
    if (!room) return;
    if (this.world.checkpoint.roomId === enc.roomId) return;
    const label = enc.kind === 'entrance' ? 'Entrance Waystone'
      : enc.kind === 'shrine' ? 'Shrine Waystone' : 'Waystone';
    this.world.setCheckpoint(room.cx, room.cz, enc.roomId, label);
    this.engine.bus.emit('director:checkpoint', {
      x: room.cx, z: room.cz, roomId: enc.roomId, label, restored: false,
    });
    this.engine.bus.emit('ui:toast', { text: `${label} attuned`, tier: 'good' });
    void director;
  }

  /** Send a distant live pack back to sleep, freeing its bodies. */
  _retire(enc) {
    const bes = this.engine.get('bestiary');
    for (const en of enc.entities) {
      if (!en || en.dead) continue;
      this.byEntity.delete(en);
      try { bes?.despawn?.(en); } catch { /* noop */ }
    }
    enc.entities.length = 0;
    enc.total = 0;
    enc.killed = 0;
    enc.alive = 0;
    enc.state = 'armed';
    enc.spawnedAt = -1;
  }

  /** Everything the player did not finish is rebuilt after a death. */
  resetUnfinished(elapsed, director) {
    for (const enc of this.list) {
      if (enc.state === 'cleared') continue;
      if (enc.adopted) continue;
      this._retire(enc);
    }
    void elapsed; void director;
  }

  noteDeath(entity, elapsed, director) {
    const enc = this.byEntity.get(entity);
    if (!enc) return;
    enc.killed++;
    this.byEntity.delete(entity);
    const i = enc.entities.indexOf(entity);
    if (i >= 0) enc.entities.splice(i, 1);
    let alive = 0;
    for (const en of enc.entities) if (en && !en.dead) alive++;
    enc.alive = alive;
    this.engine.bus.emit('director:encounter', this._encSnapshot(enc));
    if (alive === 0 && enc.total > 0 && enc.state === 'active') {
      if (enc.kind === 'horde' && director?.wave?.active) return;
      this._clear(enc, elapsed, director);
    }
  }

  encounterOf(entity) { return entity ? this.byEntity.get(entity) ?? null : null; }

  /** Register a body the Wave system spawned so clear detection sees it. */
  attach(enc, entity) {
    if (!enc || !entity) return;
    enc.entities.push(entity);
    entity.__encounter = enc.id;
    this.byEntity.set(entity, enc);
    enc.total++;
  }

  /* ================================================================ *
   * queries
   * ================================================================ */

  _nearestActive(x, z) {
    let best = null, bd = 1e9;
    for (const enc of this.list) {
      if (enc.state !== 'active') continue;
      const r = enc.room;
      const d = r ? Math.hypot(r.cx - x, r.cz - z) : 1e9;
      if (d < bd) { bd = d; best = enc; }
    }
    return best;
  }

  _tensionNear(hero) {
    let best = 0;
    let bd = 1e9;
    for (const enc of this.list) {
      const r = enc.room;
      if (!r) continue;
      const d = Math.hypot(r.cx - hero.x, r.cz - hero.z);
      if (d < bd) { bd = d; best = enc.tension; }
    }
    return best;
  }

  _roomAt(x, z) {
    for (const r of this.rooms) if (this._inRoom(r, x, z, 0.5)) return r;
    let best = null, bd = 1e9;
    for (const r of this.rooms) {
      const d = Math.hypot(r.cx - x, r.cz - z);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  _inRoom(room, x, z, pad = 0) {
    return x >= room.minX - pad && x <= room.maxX + pad && z >= room.minZ - pad && z <= room.maxZ + pad;
  }

  _standable(x, z) {
    const d = this._dungeon();
    if (!d) return true;
    try {
      if (typeof d.isWalkable === 'function' && !d.isWalkable(x, z)) return false;
      if (typeof d.clearanceAt === 'function' && d.clearanceAt(x, z) < 0.6) return false;
    } catch { return true; }
    return true;
  }

  _floorAt(x, z) {
    const d = this._dungeon();
    if (d && typeof d.floorHeightAt === 'function') {
      try { const h = d.floorHeightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      try { const h = t.heightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    return 0;
  }

  _dungeon() {
    const d = this.engine.get('dungeon');
    return d && !d.__dead && d.active ? d : null;
  }

  _readSpawnPoints(dungeon, kind) {
    if (!dungeon || typeof dungeon.spawnPoints !== 'function') return [];
    try {
      const pts = dungeon.spawnPoints(kind) ?? [];
      return pts.map((p) => ({ x: p.x, y: p.y ?? 0, z: p.z }));
    } catch { return []; }
  }

  _shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /* ================================================================ *
   * output
   * ================================================================ */

  _encSnapshot(enc) {
    return {
      id: enc.id, kind: enc.kind, state: enc.state, label: enc.label,
      roomId: enc.roomId, alive: enc.alive ?? 0, total: enc.total,
      killed: enc.killed, tension: enc.tension, phase: enc.phase,
      elite: !!enc.elite,
    };
  }

  summary() {
    let armed = 0, active = 0, cleared = 0;
    for (const e of this.list) {
      if (e.state === 'armed') armed++;
      else if (e.state === 'active') active++;
      else if (e.state === 'cleared') cleared++;
    }
    return { total: this.list.length, armed, active, cleared, bodies: this._liveBodies };
  }

  report() {
    return {
      ...this.summary(),
      rooms: this.rooms.length,
      entrance: this.entranceRoomId,
      list: this.list.map((e) => ({
        id: e.id, kind: e.kind, room: e.roomId, state: e.state,
        rank: +e.rank.toFixed(2), tension: +e.tension.toFixed(2),
        count: e.count, alive: e.alive ?? 0,
        comp: e.comp.map((c) => `${c.count}x${c.species}`).join('+'),
      })),
    };
  }

  dispose() {
    for (const enc of this.list) {
      for (const en of enc.entities) this.byEntity.delete(en);
      enc.entities.length = 0;
    }
    this.list.length = 0;
    this.byRoom.clear();
    this.byEntity.clear();
  }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export default EncounterPlan;
