/**
 * SANCTUM — Director.
 *
 * The layer that makes this a game instead of a diorama. It owns:
 *
 *  • **World state** — depth, difficulty tier, monster-level curve, discovered
 *    and cleared rooms, kills, deaths, checkpoint. (director/WorldState.js)
 *  • **Pacing** — the authored tension curve across a level plus the live combat
 *    intensity number Audio and RenderPipeline key off. (director/Pacing.js)
 *  • **Encounters** — a *plan*, not a soup: patrol groups, proximity ambushes, a
 *    guarded reliquary, a shrine chamber, a champion pack, a horde event and a
 *    boss chamber, each with its own trigger, composition and reward.
 *    (director/Encounters.js)
 *  • **Objectives** — a small quest chain with progress and completion, pushed to
 *    the HUD over the bus. (director/Objectives.js)
 *  • **Waves** — a timed survival event with telegraphed escalation.
 *    (director/Waves.js)
 *  • **Shrines** — interactable buff sites, with the only geometry this module
 *    owns: a plinth, a floor sigil and a light. (director/Shrines.js)
 *
 * Contract notes
 * --------------
 *  - Every cross-module reach is guarded: `engine.get('x')?.fn?.()`.
 *  - Nothing uses Math.random or the wall clock. Selection is seeded per
 *    encounter id through `engine.freshRand`, timing through `engine.clock`.
 *  - Bestiary owns bodies. The Director never touches a mesh on an enemy; it
 *    asks for a spawn, scales it, tags it with its encounter, and listens for
 *    'death'.
 *  - In a capture scenario the Director does not add bodies. Bestiary's
 *    `applyScenario` already posed the pack, so the Director *adopts* it into a
 *    synthetic encounter — the frame budget stays exactly where the other
 *    modules tuned it.
 *
 * Events out
 * ----------
 *   'director:state'      full world-state snapshot (on change)
 *   'director:intensity'  {value,target,state,heat,engaged,threat,boss,wave}
 *   'director:encounter'  {id,kind,state,label,roomId,alive,total}
 *   'director:objectives' {list,active,completed,total}
 *   'director:wave'       {state,index,total,alive,countdown}
 *   'director:buff'       {list:[{id,label,remain,duration,colour,frac}]}
 *   'director:checkpoint' {x,z,label,roomId,restored}
 *   'director:room'       {roomId,kind,label,discovered,rooms}
 *   'director:shrine'     {id,blessing,label,colour,duration,x,z}
 *   'director:boss'       {name,phase,hp,maxHp,frac}
 *   'director:fail'       {stage:'died'|'recovered',deaths,checkpoint}
 *   'ui:toast'            {text,tier}
 *   'ui:quest'            {title,subtitle,rows:[{text,done,optional,frac}]}
 *   'combat:buff'         {id,damage,armour,moveSpeed,critChance,duration,active}
 *   'audio:cue' / 'audio:sfx'  music state + one-shots
 *   'vfx:spawn', 'camera:shake', 'impact', 'loot:drop', 'ai:obstacle'
 */

import { WorldState, DIFFICULTY, RANK_WEIGHT } from './director/WorldState.js';
import { Pacing } from './director/Pacing.js';
import { EncounterPlan } from './director/Encounters.js';
import { Objectives } from './director/Objectives.js';
import { WaveEvent } from './director/Waves.js';
import { Shrines } from './director/Shrines.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The single record the Director keeps inside CombatSystem's buff list. */
const BUFF_RECORD_ID = 'director.shrine';

/** Pacing state -> the score state AudioEngine understands. */
const MUSIC_FOR = {
  calm: 'explore', stalk: 'tension', skirmish: 'combat', battle: 'combat', peak: 'boss',
};

/** Scenarios in which the Director runs its live loop (spawning, triggers). */
const LIVE = new Set(['dungeon', 'overworld', 'night']);
/** Scenarios that are safe zones. */
const PEACEFUL = new Set(['hub', 'inventory', 'closeup']);

export class Director {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.world = new WorldState(engine);
    this.pacing = new Pacing(engine);
    this.plan = new EncounterPlan(engine, this.world, this.pacing);
    this.objectives = new Objectives(engine, this.world);
    this.wave = new WaveEvent(engine, this.world);
    this.shrines = new Shrines(engine, this.world);

    /** 'peaceful' | 'explore' | 'posed' */
    this.mode = 'explore';
    this.scenarioName = '';
    this.live = false;
    this.failed = false;

    /** Timed buffs the hero currently holds. */
    this.buffs = [];

    /** Death / respawn state machine. */
    this.fail = { active: false, t: 0, stage: 'none' };

    this._threat = 0;
    this._threatCount = 0;
    this._bossAlive = false;
    this._nearEncounter = null;
    this._offs = [];
    this._pubState = -1;
    this._pubObj = -1;
    this._heroXZ = { x: 0, z: 0, y: 0 };
    this._scratch = [];
    this._toastGate = new Map();
    this._stats = { encounters: 0, armed: 0, active: 0, cleared: 0, bodies: 0, drawCalls: 0 };
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    try {
      await this.shrines.init();
      this._bind();
      this.world.reset({ depth: 1 });
      this.objectives.reset();
    } catch (e) {
      this.failed = true;
      console.error('[director] init failed — module disabled', e);
    }
  }

  _bind() {
    const bus = this.engine.bus;
    const on = (evt, fn) => { try { this._offs.push(bus.on(evt, fn)); } catch { /* bus optional */ } };

    on('damage', (p) => this._onDamage(p));
    on('death', (p) => this._onDeath(p));
    on('impact', (p) => this.pacing.noteImpact(p?.magnitude ?? 0.4));
    on('ability:cast', (p) => this._onCast(p));
    on('level:up', (p) => this._onLevelUp(p));
    on('dungeon:built', () => { this._replan('dungeon:built'); });
    on('loot:pickup', () => { this.pacing.noteCast(0.2); });
    on('director:command', (p) => this._command(p));
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    try { this.plan.dispose(); } catch { /* noop */ }
    try { this.shrines.dispose(); } catch { /* noop */ }
    this.buffs.length = 0;
  }

  /* ================================================================ *
   * scenario
   * ================================================================ */

  applyScenario(name, cfg = {}) {
    if (this.failed) return;
    try {
      this.scenarioName = name || '';
      this.buffs.length = 0;
      this.fail = { active: false, t: 0, stage: 'none' };
      this.pacing.reset();
      this.wave.reset();
      this._toastGate.clear();
      this._pubState = -1;
      this._pubObj = -1;

      const peaceful = PEACEFUL.has(name);
      this.live = LIVE.has(name);
      this.mode = peaceful ? 'peaceful' : this.live ? 'explore' : 'posed';

      /* Difficulty and depth follow the scenario's intent, so a boss frame is
         a Nightmare-tier depth-3 fight and the hub is a level-1 safe zone. */
      const depth = name === 'boss' ? 3 : name === 'combat' ? 2 : 1;
      this.world.reset({ depth, tierIndex: name === 'boss' ? 2 : name === 'combat' ? 1 : 1 });
      this.world.syncPlayerLevel();

      this.plan.build(name, cfg);
      this.world.roomCount = this.plan.roomCount;
      this.shrines.place(name, cfg, this.plan);
      this.objectives.build(name, cfg, this.plan, this.world);

      /* The hero always stands on a checkpoint at the mouth of the level. */
      const hp = this._hero();
      const px = hp?.position?.x ?? 0, pz = hp?.position?.z ?? 0;
      this.world.setCheckpoint(px, pz, this.plan.entranceRoomId, 'Entrance Waystone');
      this.world.markDiscovered(this.plan.entranceRoomId);

      if (peaceful) this._poseHub();
      else if (name === 'combat') this._poseCombat();
      else if (name === 'boss') this._poseBoss();
      else this._poseExplore();

      this._publishState(true);
      this._publishObjectives(true);
      this.shrines.sync(this.engine.clock.elapsed);
    } catch (e) {
      console.error('[director:applyScenario]', e);
    }
  }

  /* ------------------------------------------------------- posed states */

  _poseHub() {
    this.pacing.force(0, { heat: 0, engaged: false });
    this.plan.disarmAll();
    this.shrines.poseCharged(0.85, true);
    this.engine.bus.emit('audio:cue', { id: 'music.town', state: 'calm', gain: 1 });
    this._scoreBeat('explore', 30);
    this._toast('Sanctuary — the braziers are lit.', 'info');
  }

  _poseExplore() {
    this.pacing.force(this.pacing.tensionAt(0.06) * 0.35, { heat: 0, engaged: false });
    this.plan.armAll();
    this.plan.adoptLoose('explore');
    this.shrines.poseCharged(0.9, false);
    this.engine.bus.emit('audio:cue', { id: 'music.explore', state: 'stalk', gain: 1 });
  }

  /** 'combat': an encounter already in progress, mid-exchange. */
  _poseCombat() {
    this.plan.armAll();
    const enc = this.plan.adoptLoose('combat');
    if (enc) {
      this.plan.activate(enc, this.engine.clock.elapsed, true);
      this._nearEncounter = enc;
      this.objectives.setActiveEncounter(enc);
    }
    this._scaleAdopted(enc);
    this.shrines.poseCharged(1, true);
    this.pacing.force(0.84, { heat: 0.55, engaged: true });
    this.engine.bus.emit('audio:cue', { id: 'music.battle', state: 'battle', gain: 1 });
    this._scoreBeat('combat', 30);
    this._toast(enc?.label ?? 'Ambush!', 'danger');
  }

  /** 'boss': the boss encounter, already broken into its second phase. */
  _poseBoss() {
    this.plan.armAll();
    const enc = this.plan.adoptLoose('boss');
    if (enc) {
      this.plan.activate(enc, this.engine.clock.elapsed, true);
      enc.phase = 2;
      this._nearEncounter = enc;
      this.objectives.setActiveEncounter(enc);
    }
    this._scaleAdopted(enc);

    /* Drop the boss to phase-II health so the AI's BossController breaks into
       phase II during the settle ticks: more abilities, faster casts, adds. */
    const boss = this._findBoss();
    if (boss) {
      /* Phase II runs from 70 % down to 35 % health. Landing at 64 % leaves the
         fight enough room that a couple of hundred settle frames of real combat
         cannot tip the capture into phase III. */
      const frac = 0.64;
      boss.hp = Math.max(1, Math.round(boss.maxHp * frac));
      this._bossAlive = true;
      this.engine.bus.emit('director:boss', {
        id: boss.id, name: this.world.bossName, phase: 2,
        hp: boss.hp, maxHp: boss.maxHp, frac,
      });
    }
    this.shrines.armBossRing(boss, this.world);
    this.shrines.poseCharged(1, true);
    this.pacing.force(0.95, { heat: 0.9, engaged: true });
    this.engine.bus.emit('audio:cue', { id: 'music.boss', state: 'peak', gain: 1 });
    this._scoreBeat('boss', 60);
    this._toast(`${this.world.bossName} — Phase II`, 'boss');
  }

  /**
   * Hold the posed boss inside its phase-II health band.
   *
   * The `boss` scenario is a *pose*, not a simulation: the harness runs 240 live
   * frames with a fully-geared hero, which is enough to take the Warden from 64 %
   * to dead. A capture that is supposed to show phase II must not resolve into an
   * empty arena — so for this one scenario the boss's health is clamped to the
   * 42–68 % window that the AI reads as phase II. Nothing outside the posed boss
   * scenario is touched.
   */
  _holdBossPhase() {
    const boss = this._findBoss();
    if (!boss || boss.dead || !(boss.maxHp > 0)) return;
    const lo = boss.maxHp * 0.42, hi = boss.maxHp * 0.68;
    if (boss.hp < lo) boss.hp = lo;
    else if (boss.hp > hi) boss.hp = hi;
    const enc = this.plan.bossEncounter;
    if (enc) enc.phase = 2;
  }

  /** Scale an adopted (scenario-spawned) pack through the difficulty curve. */
  _scaleAdopted(enc) {
    if (!enc) return;
    for (const en of enc.entities) this._scaleBody(en);
  }

  _scaleBody(en) {
    if (!en || en.__dirScaled) return;
    try {
      const s = this.world.scaleFor(en.rank ?? 'normal');
      const hpFrac = en.maxHp > 0 ? en.hp / en.maxHp : 1;
      en.maxHp = Math.max(1, Math.round(en.maxHp * s.hp));
      en.hp = Math.max(1, Math.round(en.maxHp * hpFrac));
      en.level = s.level;
      en.__dirDmg = s.dmg;
      en.__dirScaled = true;
    } catch { /* body shape unknown — leave it alone */ }
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(dt, elapsed) {
    if (this.failed) return;
    const hero = this._hero();
    if (hero?.position) {
      this._heroXZ.x = hero.position.x;
      this._heroXZ.y = hero.position.y;
      this._heroXZ.z = hero.position.z;
    }

    this.world.runTime += dt;
    this._readThreat();
    this._pushDamageScale();

    if (this.live && !this.fail.active) {
      this.plan.tick(dt, elapsed, this._heroXZ, this);
      this.wave.tick(dt, elapsed, this._heroXZ, this);
    } else {
      this.plan.tickPassive(dt, elapsed, this);
    }
    this.shrines.tick(dt, elapsed, this._heroXZ, this);

    this._tickBuffs(dt);
    this._tickFail(dt, elapsed);
    if (this.mode === 'posed' && this.scenarioName === 'boss') this._holdBossPhase();

    const ctx = {
      threat: this._threat,
      count: this._threatCount,
      boss: this._bossAlive,
      wave: this.wave.active,
      encounter: !!this._nearEncounter && this._nearEncounter.state === 'active',
    };
    this.pacing.update(dt, ctx);
    this.shrines.sync(elapsed);

    if (this.pacing.shouldPublish(this.engine.clock.frame)) this._publishIntensity();
    if (this.world.revision !== this._pubState) this._publishState(false);
    if (this.objectives.revision !== this._pubObj) this._publishObjectives(false);
  }

  /* ------------------------------------------------------------ threat */

  /**
   * Weighted live threat inside the fight bubble around the hero. This is what
   * drives intensity, so it must be cheap and it must not count a body that is
   * three rooms away and has never seen the player.
   */
  _readThreat() {
    let w = 0, n = 0, boss = false;
    const bes = this.engine.get('bestiary');
    const list = bes && !bes.__dead ? bes.entities : null;
    if (list) {
      const hx = this._heroXZ.x, hz = this._heroXZ.z;
      const R2 = 22 * 22;
      for (let i = 0; i < list.length; i++) {
        const en = list[i];
        if (!en || en.dead) continue;
        const dx = en.position.x - hx, dz = en.position.z - hz;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const rank = en.rank ?? (en.isBoss ? 'boss' : en.elite ? 'champion' : 'normal');
        // Distance falls off so a pack across the hall reads as tension, not
        // as a brawl; contact range counts fully.
        const near = clamp01(1.35 - Math.sqrt(d2) / 18);
        w += (RANK_WEIGHT[rank] ?? 1) * near;
        n++;
        if (rank === 'boss') boss = true;
      }
    }
    this._threat = w;
    this._threatCount = n;
    this._bossAlive = boss;
  }

  /** Hand per-body difficulty damage scaling to the AI agent that drives it. */
  _pushDamageScale() {
    const ai = this.engine.get('ai');
    if (!ai || ai.__dead || typeof ai.agentFor !== 'function') return;
    const bes = this.engine.get('bestiary');
    const list = bes && !bes.__dead ? bes.entities : null;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const en = list[i];
      if (!en || en.dead || en.__dirDmgPushed) continue;
      if (!en.__dirScaled) this._scaleBody(en);
      const agent = ai.agentFor(en);
      if (!agent) continue;
      const mul = en.__dirDmg ?? 1;
      agent.damageMul = (agent.damageMul ?? 1) * mul;
      if (en.__encounter) agent.encounter = en.__encounter;
      en.__dirDmgPushed = true;
    }
  }

  /* ------------------------------------------------------------- buffs */

  grantBuff(def) {
    if (!def || !def.id) return null;
    const existing = this.buffs.find((b) => b.id === def.id);
    const duration = def.duration ?? 30;
    if (existing) {
      existing.remain = Math.max(existing.remain, duration);
      existing.stacks = Math.min(3, existing.stacks + 1);
    } else {
      this.buffs.push({
        id: def.id, label: def.label ?? def.id, colour: def.colour ?? 0x8fd0ff,
        duration, remain: duration, stacks: 1, mods: def.mods ?? {},
      });
    }
    this._applyBuffMods();
    this._publishBuffs();
    return this.buffs.find((b) => b.id === def.id) ?? null;
  }

  _tickBuffs(dt) {
    if (!this.buffs.length) return;
    let dirty = false;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i];
      b.remain -= dt;
      if (b.remain <= 0) {
        this.buffs.splice(i, 1);
        dirty = true;
        this._toast(`${b.label} fades`, 'info');
      }
    }
    // The mirrored combat record counts down on its own clock; refresh it a few
    // times a second so it never expires ahead of the buff that owns it.
    if (dirty || (this.engine.clock.frame & 15) === 0) this._applyBuffMods();
    if (dirty || (this.engine.clock.frame & 5) === 0) this._publishBuffs();
  }

  /**
   * Apply the current buff set.
   *
   * Stat ownership is contested, so this routes rather than writes blindly:
   *
   *  • **damage / armour** — CombatSystem rewrites `hero.stats.damage` and
   *    `.armour` from its own base every frame, so writing them here would be
   *    stomped within one tick. Instead the whole shrine set is mirrored into
   *    CombatSystem's own buff list as a single record it already knows how to
   *    apply and expire. If CombatSystem is absent we write the stats directly.
   *  • **moveSpeed / critChance / maxHealth** — nobody else drives these, so
   *    they are written as a delta from a base captured once.
   *
   * Recomputed from scratch on every change, so stacking and expiry cannot drift.
   */
  _applyBuffMods() {
    const hero = this._hero();
    const s = hero?.stats;
    if (!s) return;
    if (!hero.__dirBase) {
      hero.__dirBase = {
        damage: s.damage, armour: s.armour, moveSpeed: s.moveSpeed,
        critChance: s.critChance, maxHealth: s.maxHealth,
      };
    }
    const base = hero.__dirBase;
    let dmg = 0, arm = 0, spd = 1, crit = 0, hp = 1, longest = 0;
    for (const b of this.buffs) {
      const k = b.stacks;
      dmg += (b.mods.damage ?? 0) * k;
      arm += (b.mods.armour ?? 0) * k;
      spd *= 1 + (b.mods.moveSpeed ?? 0) * k;
      crit += (b.mods.critChance ?? 0) * k;
      hp *= 1 + (b.mods.maxHealth ?? 0) * k;
      if (b.remain > longest) longest = b.remain;
    }

    /* --- damage / armour: through the combat authority when there is one --- */
    const routed = this._routeCombatBuff(dmg, arm, longest);
    if (!routed) {
      s.damage = Math.round(base.damage * (1 + dmg));
      s.armour = Math.round(base.armour * (1 + arm));
    }

    /* --- the rest, ours to own --- */
    s.moveSpeed = base.moveSpeed * spd;
    s.critChance = clamp01(base.critChance + crit);
    const newMax = Math.round(base.maxHealth * hp);
    if (newMax !== s.maxHealth) {
      const frac = s.maxHealth > 0 ? s.health / s.maxHealth : 1;
      s.maxHealth = newMax;
      hero.maxHealth = newMax;
      s.health = Math.min(newMax, Math.round(newMax * frac));
    }

    /* Forward contract: whoever ends up owning derived stats can adopt this
       without the Director having to know about them. */
    this.engine.bus.emit('combat:buff', {
      id: BUFF_RECORD_ID, label: 'Shrine Blessing', source: 'shrine',
      damage: dmg, armour: arm, moveSpeed: spd - 1, critChance: crit,
      duration: longest, active: this.buffs.length > 0,
    });
  }

  /**
   * Mirror the shrine set into CombatSystem's buff list. Feature-detected on the
   * exact record shape it uses, and a no-op if that shape is not there.
   * @returns {boolean} true when combat took ownership
   */
  _routeCombatBuff(damage, armour, duration) {
    const combat = this.engine.get('combat');
    const list = combat && !combat.__dead ? combat.buffs : null;
    if (!Array.isArray(list)) return false;
    const i = list.findIndex((b) => b && b.id === BUFF_RECORD_ID);
    if (!this.buffs.length) {
      if (i >= 0) list.splice(i, 1);
      return true;
    }
    const rec = i >= 0 ? list[i] : { id: BUFF_RECORD_ID };
    rec.label = this.buffs.length === 1 ? this.buffs[0].label : 'Shrine Blessing';
    rec.duration = Math.max(0.1, duration);
    rec.left = Math.max(0.1, duration);
    rec.armour = armour;
    rec.damage = damage;
    rec.resistAll = 0;
    rec.thorns = 0;
    if (i < 0) list.push(rec);
    return true;
  }

  _publishBuffs() {
    const list = this.buffs.map((b) => ({
      id: b.id, label: b.label, colour: b.colour,
      remain: b.remain, duration: b.duration, stacks: b.stacks,
      frac: b.duration > 0 ? clamp01(b.remain / b.duration) : 0,
    }));
    this.engine.bus.emit('director:buff', { list });
  }

  /* --------------------------------------------------- death / respawn */

  /**
   * The fail state, in three beats: a held breath (the frame goes quiet), the
   * pull back to the last waystone, and the re-arm. Progress is preserved —
   * cleared rooms stay cleared — but the *current* encounter resets, which is
   * both the penalty and the only sane way to make a second attempt winnable.
   */
  _onHeroDeath() {
    if (this.fail.active) return;
    this.fail = { active: true, t: 0, stage: 'hold' };
    this.world.noteDeath();
    this.pacing.noteDeath('hero');
    this.buffs.length = 0;
    this._applyBuffMods();
    this._publishBuffs();
    const cp = this.world.checkpoint;
    this._toast(`You have fallen — ${this.world.deaths} ${this.world.deaths === 1 ? 'death' : 'deaths'} this run`, 'death');
    this.engine.bus.emit('director:fail', {
      stage: 'died', deaths: this.world.deaths, checkpoint: { ...cp },
    });
    this.engine.bus.emit('audio:cue', { id: 'music.death', state: 'calm', gain: 1 });
    this._scoreBeat('dead', 6);
  }

  _tickFail(dt, elapsed) {
    if (!this.fail.active) return;
    this.fail.t += dt;
    if (this.fail.stage === 'hold' && this.fail.t >= 2.6) {
      this.fail.stage = 'restore';
      this._restoreCheckpoint(elapsed);
    } else if (this.fail.stage === 'restore' && this.fail.t >= 3.4) {
      this.fail.active = false;
      this.fail.stage = 'none';
      this.engine.bus.emit('director:fail', { stage: 'recovered', deaths: this.world.deaths });
      this.engine.bus.emit('audio:cue', { id: 'music.explore', state: 'stalk', gain: 1 });
    }
  }

  _restoreCheckpoint(elapsed) {
    const cp = this.world.checkpoint;
    const hero = this._hero();
    try {
      if (hero) {
        if (typeof hero.revive === 'function') hero.revive();
        else if (hero.stats) { hero.stats.health = hero.stats.maxHealth; hero.isDead = false; }
        if (hero.position) hero.position.set(cp.x, hero.position.y, cp.z);
        if (typeof hero.moveTo === 'function') hero.moveTo(cp.x, cp.z);
        hero.velocity?.set?.(0, 0, 0);
      }
    } catch (e) { console.warn('[director] respawn —', e?.message ?? e); }

    /* Enemy state: every *unfinished* encounter is rebuilt from its plan, so
       the player does not walk back into a half-dead pack that is already on
       top of the waystone. Cleared encounters stay cleared. */
    this.plan.resetUnfinished(elapsed, this);
    this.wave.reset();
    this.pacing.force(0.05, { heat: 0, engaged: false });
    this._toast(`Restored at ${cp.label}`, 'info');
    this.engine.bus.emit('director:checkpoint', { ...cp, restored: true });
  }

  /* ================================================================ *
   * bus handlers
   * ================================================================ */

  _onDamage(p) {
    if (!p) return;
    const toHero = p.target?.isHero === true || p.target === 'hero' || p.target?.id === 'hero';
    this.pacing.noteDamage(p.amount ?? 0, toHero);
    if (!toHero) {
      // First blood on a dormant pack wakes the encounter it belongs to.
      const enc = this.plan.encounterOf(p.target);
      if (enc && enc.state !== 'active') this.plan.activate(enc, this.engine.clock.elapsed, false);
    }
  }

  _onCast(p) {
    const w = p?.id === 'boss.phase' ? 3 : 1;
    this.pacing.noteCast(w);
    if (p?.id === 'boss.phase') {
      /* The AI's BossController puts its phase index in `level`. Trust it rather
         than incrementing, or a single break that fires the cast twice reads as
         two phases. */
      const enc = this.plan.bossEncounter;
      const phase = this.mode === 'posed' ? 2 : Math.max(2, Math.round(p.level ?? 2));
      if (enc) enc.phase = this.mode === 'posed' ? 2 : Math.max(enc.phase ?? 1, phase);
      this.engine.bus.emit('director:boss', {
        name: this.world.bossName, phase, level: phase,
      });
    }
  }

  _onDeath(p) {
    const ent = p?.entity;
    if (!ent) return;
    if (ent.isHero === true || ent === this._hero()) { this._onHeroDeath(); return; }

    const rank = ent.rank ?? (ent.isBoss ? 'boss' : ent.elite ? 'champion' : 'normal');
    this.pacing.noteDeath(rank);
    this.world.noteKill(rank);
    /* Loot/Progression owns XP when it is loaded — `awardXp` records the credit
       and returns `external:true` rather than levelling us a second time. */
    const gain = this.world.awardXp(this.world.xpValue(rank));
    if (gain.levelUp && !gain.external) {
      this._toast(`Level ${gain.level}`, 'level');
      this.engine.bus.emit('level:up', { level: gain.level, stats: this._hero()?.stats ?? null });
    }
    this.wave.noteDeath(ent);
    this.plan.noteDeath(ent, this.engine.clock.elapsed, this);
  }

  _onLevelUp(p) {
    if (!p) return;
    this.world.syncPlayerLevel();
    if (Number.isFinite(p.level)) this.world.playerLevel = clamp(p.level | 0, 1, 100);
    this.world.touch();
  }

  /** External control channel — used by the HUD and by debug tooling. */
  _command(p) {
    if (!p || typeof p !== 'object') return;
    switch (p.cmd) {
      case 'difficulty': this.world.setTier(p.value); this._toast(`${this.world.tier.label}`, 'info'); break;
      case 'shrine': this.shrines.activateNearest(this._heroXZ, this, true); break;
      case 'wave': this.wave.begin(this.engine.clock.elapsed, this, this._heroXZ); break;
      case 'descend': this.descend(); break;
      default: break;
    }
  }

  /* ================================================================ *
   * progression
   * ================================================================ */

  /** Next level down: deeper monsters, a fresh plan, cleared bookkeeping. */
  descend() {
    this.world.setDepth(this.world.depth + 1);
    this.world.syncPlayerLevel();
    this.plan.build(this.scenarioName || 'dungeon', this.engine.scenario ?? {});
    this.world.roomCount = this.plan.roomCount;
    this.shrines.place(this.scenarioName || 'dungeon', this.engine.scenario ?? {}, this.plan);
    this.objectives.build(this.scenarioName || 'dungeon', this.engine.scenario ?? {}, this.plan, this.world);
    this.plan.armAll();
    this._toast(`${this.world.levelName} — depth ${this.world.depth}`, 'level');
    this._publishState(true);
    this._publishObjectives(true);
  }

  /** The dungeon rebuilt under us — re-author from the new rooms. */
  _replan(reason) {
    if (this.failed) return;
    try {
      const name = this.scenarioName || 'dungeon';
      const cfg = this.engine.scenario ?? {};
      this.plan.build(name, cfg);
      this.world.roomCount = this.plan.roomCount;
      this.shrines.place(name, cfg, this.plan);
      this.objectives.build(name, cfg, this.plan, this.world);
      if (this.mode === 'peaceful') this.plan.disarmAll(); else this.plan.armAll();
      this._publishState(true);
      this._publishObjectives(true);
      void reason;
    } catch (e) { console.warn('[director] replan —', e?.message ?? e); }
  }

  /* ================================================================ *
   * publishing
   * ================================================================ */

  _publishIntensity() {
    const snap = this.pacing.snapshot();
    snap.encounter = this._nearEncounter?.id ?? null;
    snap.depthTension = this.plan.tensionAtHero;
    /* Pre-mapped consumer hints, so Audio and RenderPipeline can bind this event
       in one line without knowing anything about the pacing model. */
    snap.music = MUSIC_FOR[this.pacing.state] ?? 'explore';
    snap.grade = { shakeBias: snap.value, vignetteBias: snap.value * 0.35, satBias: -snap.value * 0.12 };
    this.engine.bus.emit('director:intensity', snap);
    if (this.pacing.state !== this.pacing.prevState) {
      this.engine.bus.emit('audio:cue', {
        id: `music.${this.pacing.state}`, state: this.pacing.state, gain: 1,
        music: snap.music, intensity: snap.value,
      });
    }
    this.pacing.markPublished(this.engine.clock.frame);
  }

  /**
   * Hand an *authored* score beat to the audio module.
   *
   * Deliberately narrow. AudioEngine already runs its own threat meter off
   * damage and AI events and does it well, so the Director only speaks up for
   * the handful of moments it knows about and the meter cannot infer: a boss
   * committing, a horde event opening, the hero dying, a set-piece ending.
   * Anything more would just argue with the meter every frame.
   */
  _scoreBeat(state, hold = 18) {
    const audio = this.engine.get('audio');
    if (!audio || audio.__dead) return;
    try { audio.setMusicState?.(state, hold); } catch { /* audio optional */ }
  }

  _publishState(force) {
    this._pubState = this.world.revision;
    const snap = this.world.snapshot();
    snap.intensity = this.pacing.value;
    snap.intensityState = this.pacing.state;
    snap.encounters = this.plan.summary();
    snap.buffs = this.buffs.length;
    snap.mode = this.mode;
    this.engine.bus.emit('director:state', snap);
    void force;
  }

  _publishObjectives(force) {
    this._pubObj = this.objectives.revision;
    const snap = this.objectives.snapshot();
    this.engine.bus.emit('director:objectives', snap);
    /**
     * The HUD's quest panel wants a title, a subtitle and a short list of rows.
     * Publishing that shape as well means a tracker can bind to one event with
     * no knowledge of the objective model — and the panel shows the *next* three
     * rows, not the whole chain, which is what fits the frame.
     */
    const rows = [];
    for (const o of snap.list) {
      if (o.state === 'locked') continue;
      rows.push({
        text: o.need > 1 && o.state !== 'done' ? `${o.text}  (${o.have}/${o.need})` : o.text,
        done: o.state === 'done',
        optional: o.optional,
        frac: o.frac,
      });
      if (rows.length >= 4) break;
    }
    this.engine.bus.emit('ui:quest', {
      title: snap.title,
      subtitle: snap.subtitle,
      rows,
      completed: snap.completed,
      total: snap.total,
    });
    void force;
  }

  /** Rate-limited toast so a burst of kills does not spam the HUD. */
  _toast(text, tier = 'info') {
    if (!text) return;
    const t = this.engine.clock.elapsed;
    const last = this._toastGate.get(text) ?? -99;
    if (t - last < 1.5) return;
    this._toastGate.set(text, t);
    this.engine.bus.emit('ui:toast', { text, tier });
  }

  /* ================================================================ *
   * helpers / public read API
   * ================================================================ */

  _hero() {
    const h = this.engine.get('hero');
    return h && !h.__dead && !h.failed ? h : null;
  }

  _findBoss() {
    const bes = this.engine.get('bestiary');
    const list = bes && !bes.__dead ? bes.entities : null;
    if (!list) return null;
    for (const en of list) if (!en.dead && (en.isBoss || en.rank === 'boss')) return en;
    return null;
  }

  get intensity() { return this.pacing.value; }
  get intensityState() { return this.pacing.state; }
  get difficulty() { return this.world.tier; }

  /**
   * The difficulty view other modules read (`engine.get('director').worldState`).
   * Loot multiplies XP and loot luck by `.xp` / `.loot`, so this must expose
   * **multipliers**, not totals.
   */
  get worldState() { return this.world.multipliers; }
  /** The full mutable state object, for anything that wants more than the view. */
  get state() { return this.world; }

  /** Diagnostics for tools/sheet.mjs and the debug overlay. */
  report() {
    return {
      mode: this.mode,
      scenario: this.scenarioName,
      world: this.world.snapshot(),
      intensity: this.pacing.snapshot(),
      encounters: this.plan.report(),
      objectives: this.objectives.snapshot(),
      wave: this.wave.report(),
      shrines: this.shrines.report(),
      buffs: this.buffs.map((b) => ({ id: b.id, remain: +b.remain.toFixed(2), stacks: b.stacks })),
      drawCalls: this.shrines.drawCalls,
    };
  }
}

export { DIFFICULTY };
export default Director;
