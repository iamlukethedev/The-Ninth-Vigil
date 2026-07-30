/**
 * THE NINTH VIGIL — wave / horde event.
 *
 * A timed survival beat: the room seals, and five escalating waves come in, each
 * one telegraphed before it lands. The telegraph is the whole point — a horde
 * event where bodies simply appear is a cheat; a horde event where the floor
 * sigils flare, the light drops, and the ground rumbles for two seconds before
 * each wave is a *fight you can prepare for*.
 *
 * Structure of one run:
 *
 *   idle → [telegraph 2.4 s] → [wave N live] → [breather 4 s] → … → done
 *
 * Escalation per wave: more bodies, heavier species, and a champion from wave 3.
 * Everything selected from `engine.freshRand('<event id>:<wave>')`, so a replay
 * of the same run is byte-identical.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const TELEGRAPH = 2.4;
const BREATHER = 4.0;

/** Wave ladder. `mix` is picked from with the given weights. */
const LADDER = [
  { n: 4, mix: [['skeleton', 3], ['ghoul', 2]], elite: 0 },
  { n: 5, mix: [['ghoul', 3], ['skeleton', 2], ['hellhound', 1.5]], elite: 0 },
  { n: 6, mix: [['hellhound', 3], ['skeleton', 2], ['cultist', 1.5]], elite: 1 },
  { n: 7, mix: [['ghoul', 2.5], ['hellhound', 2.5], ['brute', 1.4]], elite: 1 },
  { n: 8, mix: [['brute', 2], ['hellhound', 2.4], ['cultist', 1.6], ['wraith', 1.2]], elite: 2 },
];

export class WaveEvent {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {import('./WorldState.js').WorldState} world
   */
  constructor(engine, world) {
    this.engine = engine;
    this.world = world;

    this.active = false;
    this.state = 'idle';        // idle | telegraph | live | breather | done
    this.index = -1;            // 0-based wave index
    this.total = LADDER.length;
    this.t = 0;                 // seconds left in the current phase
    this.alive = 0;
    this.spawned = 0;
    this.killed = 0;
    this.centre = { x: 0, z: 0 };
    this.radius = 11;
    this.encounter = null;
    this.eventId = 'wave:0';
    /** @type {Set<object>} */ this.bodies = new Set();
    this._published = -1;
  }

  reset() {
    this.active = false;
    this.state = 'idle';
    this.index = -1;
    this.t = 0;
    this.alive = 0;
    this.spawned = 0;
    this.killed = 0;
    this.encounter = null;
    this.bodies.clear();
    this._published = -1;
  }

  /* ================================================================ *
   * control
   * ================================================================ */

  begin(elapsed, director, hero) {
    if (this.active) return false;
    const enc = director?.plan?.hordeEncounter ?? null;
    const room = enc?.room ?? null;
    this.centre.x = room?.cx ?? hero?.x ?? 0;
    this.centre.z = room?.cz ?? hero?.z ?? 0;
    this.radius = room ? clamp(Math.min(room.w, room.d) * 0.45, 7, 15) : 11;
    this.encounter = enc;
    this.eventId = `wave:${this.world.depth}:${enc?.roomId ?? 0}`;

    this.active = true;
    this.state = 'telegraph';
    this.index = 0;
    this.t = TELEGRAPH;
    this.spawned = 0;
    this.killed = 0;
    this.alive = 0;
    this.bodies.clear();
    this.total = LADDER.length;

    const bus = this.engine.bus;
    bus.emit('ui:toast', { text: 'The tide rises — hold the chamber', tier: 'danger' });
    bus.emit('audio:cue', { id: 'music.horde', state: 'battle', gain: 1 });
    bus.emit('director:wave', this.snapshot());
    director?.shrines?.armWaveRing?.(this.centre, this.radius);
    void elapsed;
    return true;
  }

  cancel() {
    if (!this.active) return;
    this.state = 'done';
    this.active = false;
    this.engine.bus.emit('director:wave', this.snapshot());
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  tick(dt, elapsed, hero, director) {
    if (!this.active) return;
    this.t -= dt;

    /* live head-count */
    let alive = 0;
    for (const en of this.bodies) {
      if (en && !en.dead) alive++;
    }
    this.alive = alive;

    switch (this.state) {
      case 'telegraph': {
        // The last half second of the telegraph is the loudest part of it.
        const frac = clamp01(1 - this.t / TELEGRAPH);
        if (frac > 0.55 && !this._rumbled) {
          this._rumbled = true;
          this.engine.bus.emit('camera:shake', { amp: 0.22 + this.index * 0.04, freq: 22, duration: 0.9 });
          this.engine.bus.emit('audio:sfx', { id: 'wave.incoming', gain: 0.9 });
        }
        director?.shrines?.setWaveCharge?.(frac, this.index / Math.max(1, this.total - 1));
        if (this.t <= 0) {
          this._rumbled = false;
          this._spawnWave(elapsed, director, hero);
          this.state = 'live';
          this.t = 0;
        }
        break;
      }
      case 'live': {
        director?.shrines?.setWaveCharge?.(1, this.index / Math.max(1, this.total - 1));
        if (alive === 0 && this.spawned > 0) {
          if (this.index >= this.total - 1) {
            this._finish(director);
          } else {
            this.state = 'breather';
            this.t = BREATHER;
            this.engine.bus.emit('ui:toast', {
              text: `Wave ${this.index + 1} of ${this.total} broken`, tier: 'good',
            });
            this.engine.bus.emit('audio:sfx', { id: 'wave.clear', gain: 0.85 });
          }
        }
        break;
      }
      case 'breather': {
        director?.shrines?.setWaveCharge?.(clamp01(1 - this.t / BREATHER) * 0.6, this.index / Math.max(1, this.total - 1));
        if (this.t <= 0) {
          this.index++;
          this.state = 'telegraph';
          this.t = TELEGRAPH;
          this.engine.bus.emit('ui:toast', {
            text: `Wave ${this.index + 1} incoming`, tier: 'danger',
          });
        }
        break;
      }
      default: break;
    }

    if (this.engine.clock.frame - this._published >= 12) this._publish();
  }

  _spawnWave(elapsed, director, hero) {
    const bes = this.engine.get('bestiary');
    if (!bes || bes.__dead || typeof bes.spawn !== 'function') return;
    const step = LADDER[clamp(this.index, 0, LADDER.length - 1)];
    const rand = this.engine.freshRand(`${this.eventId}:${this.index}`);

    const count = Math.max(1, Math.round(step.n * this.world.tier.density));
    let total = 0;
    for (const [, w] of step.mix) total += w;

    const rot = rand() * Math.PI * 2;
    let eliteLeft = step.elite;
    for (let i = 0; i < count; i++) {
      // Ring the room's edge, evenly spread with jitter — they come in from the
      // dark at the walls, not out of the middle of the floor.
      const a = rot + (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.35;
      const r = this.radius * (0.86 + rand() * 0.14);
      let x = this.centre.x + Math.cos(a) * r;
      let z = this.centre.z + Math.sin(a) * r;
      if (!this._standable(x, z)) {
        const r2 = this.radius * 0.6;
        x = this.centre.x + Math.cos(a) * r2;
        z = this.centre.z + Math.sin(a) * r2;
        if (!this._standable(x, z)) continue;
      }

      let roll = rand() * total, species = step.mix[0][0];
      for (const [s, w] of step.mix) { roll -= w; if (roll <= 0) { species = s; break; } }
      const elite = eliteLeft > 0 && i % 3 === 1;
      if (elite) eliteLeft--;

      let en = null;
      try {
        en = bes.spawn(species, { x, z }, {
          elite, level: this.world.levelFor(elite ? 'champion' : 'normal'),
          seed: hashStr(`${this.eventId}:${this.index}:${i}`) >>> 0,
        });
      } catch { en = null; }
      if (!en) continue;
      const s = this.world.scaleFor(elite ? 'champion' : 'normal');
      en.maxHp = Math.max(1, Math.round(en.maxHp * s.hp));
      en.hp = en.maxHp;
      en.__dirScaled = true;
      en.__dirDmg = s.dmg;
      this.bodies.add(en);
      this.spawned++;
      if (this.encounter) director?.plan?.attach?.(this.encounter, en);
    }

    const bus = this.engine.bus;
    bus.emit('camera:shake', { amp: 0.4 + this.index * 0.06, freq: 14, duration: 0.55 });
    bus.emit('impact', {
      point: { x: this.centre.x, y: this._floorAt(this.centre.x, this.centre.z) + 0.05, z: this.centre.z },
      normal: { x: 0, y: 1, z: 0 }, kind: 'necrotic_burst',
      magnitude: 0.7 + this.index * 0.08,
    });
    bus.emit('audio:sfx', { id: 'wave.spawn', gain: 1 });
    void elapsed; void hero;
  }

  _finish(director) {
    this.state = 'done';
    this.active = false;
    const bus = this.engine.bus;
    bus.emit('ui:toast', { text: 'The tide breaks', tier: 'good' });
    bus.emit('audio:cue', { id: 'music.explore', state: 'stalk', gain: 1 });
    director?.shrines?.disarmWaveRing?.();
    const gain = this.world.awardXp(160 + this.world.monsterLevel * 26);
    if (gain.levelUp && !gain.external) bus.emit('level:up', { level: gain.level, stats: this.engine.get('hero')?.stats ?? null });
    director?.objectives?.complete?.('chain.horde');
    /* the reward: a guaranteed upgrade at the current loot tier */
    const q = this.world.lootQuality();
    bus.emit('loot:drop', {
      item: {
        id: `${this.eventId}:reward`, rarity: q.tier, level: this.world.monsterLevel,
        value: Math.round((90 + this.world.monsterLevel * 16) * q.mul), source: 'horde',
      },
      position: { x: this.centre.x, y: this._floorAt(this.centre.x, this.centre.z) + 0.12, z: this.centre.z },
    });
    this._publish();
  }

  noteDeath(entity) {
    if (!entity || !this.bodies.has(entity)) return;
    this.bodies.delete(entity);
    this.killed++;
  }

  /* ================================================================ *
   * helpers
   * ================================================================ */

  _standable(x, z) {
    const d = this.engine.get('dungeon');
    if (!d || d.__dead || !d.active) return true;
    try {
      if (typeof d.isWalkable === 'function' && !d.isWalkable(x, z)) return false;
      if (typeof d.clearanceAt === 'function' && d.clearanceAt(x, z) < 0.6) return false;
    } catch { return true; }
    return true;
  }

  _floorAt(x, z) {
    const d = this.engine.get('dungeon');
    if (d && !d.__dead && typeof d.floorHeightAt === 'function') {
      try { const h = d.floorHeightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      try { const h = t.heightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    return 0;
  }

  _publish() {
    this._published = this.engine.clock.frame;
    this.engine.bus.emit('director:wave', this.snapshot());
  }

  snapshot() {
    return {
      active: this.active,
      state: this.state,
      index: this.index,
      wave: this.index + 1,
      total: this.total,
      alive: this.alive,
      spawned: this.spawned,
      killed: this.killed,
      countdown: this.state === 'telegraph' || this.state === 'breather' ? Math.max(0, this.t) : 0,
      centre: { x: this.centre.x, z: this.centre.z },
      radius: this.radius,
    };
  }

  report() { return this.snapshot(); }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export default WaveEvent;
