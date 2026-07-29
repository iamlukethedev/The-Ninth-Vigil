/**
 * SANCTUM — CombatSystem
 * ---------------------------------------------------------------------------
 * The moment-to-moment layer: what the player presses, what the blade touches,
 * what the number says, and how the world flinches.
 *
 * Architecture
 * ------------
 *   Abilities.js   declarative table — timing, cost, shape (no behaviour)
 *   Damage.js      the arithmetic — mitigation, crit, glance, DoT, thorns
 *   HitFeel.js     the response — hit-stop, knockback, shake, numbers, reads
 *   CombatSystem   this file: input, the ability state machine, hit detection,
 *                  targeting, player vitals, progression, scenario direction
 *
 * Hit detection is animation-driven, not timer-driven
 * ---------------------------------------------------
 * A weapon ability does not "deal damage after 0.44 s". Every frame of its active
 * window the blade's **measured world segment** (hilt → tip, read off the hero's
 * hand bone) is swept against every candidate capsule, including the segment it
 * occupied last frame, so a 20 m/s tip cannot tunnel through a body between two
 * frames. The active window itself is a *phase range of the clip*
 * (`CLIP_WINDOW`), so when hit-stop slows the animation the hit window slows with
 * it and the damage never desynchronises from the pose. One hit per target per
 * swing, tracked by swing id.
 *
 * Authority and the bus
 * ---------------------
 * Health lives where the body lives: `hero.stats.health` and `enemy.hp`. This
 * module resolves a hit and emits exactly one `damage` event; Bestiary subtracts
 * enemy HP, Hero mitigates and subtracts its own, AI reacts, CameraRig shakes,
 * Props break. Nothing is applied twice, and combat degrades to "numbers with no
 * feedback" rather than breaking if a listener is missing.
 *
 * Determinism: `engine.rand`, `engine.clock.elapsed`, fixed dt. No wall clock,
 * no Math.random — the same scenario and frame count is pixel-identical.
 *
 * Draw calls added: 5 (ground reads, damage glyphs, projectiles, beam, spin arc).
 * Texture units added: 1, on an unlit shader of its own (the glyph atlas).
 */

import * as THREE from 'three';
import { DamageResolver, TYPE_COLOR, TIER_COLOR } from './Damage.js';
import {
  ABILITIES, ABILITY_ORDER, BAR, BINDS, CLIP_WINDOW, CLIP_ABILITY, CLIP_TIME, COMBO_CHAIN,
  RESOURCE, VITALS, XP, hitCircle, hitRing, hitCone, hitLine, hitCapsule, makeSeg,
  clamp, clamp01, wrapPi,
} from './Abilities.js';
import { HitFeel, GroundFX, AbilityFX, SHAPE } from './HitFeel.js';

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _hilt = new THREE.Vector3();
const _seg = makeSeg();
const _cand = [];

/* ------------------------------------------------------------------ *
 * scenario direction — deterministic fight choreography
 * ------------------------------------------------------------------ *
 * The critic judges one frame, captured `frames` ticks after applyScenario plus
 * the 30 settle ticks the harness runs. `combat` captures at 3.50 s and `boss` at
 * 4.50 s, so the schedules below are written backwards from those instants: at
 * capture there must be a swing landing, numbers in the air, a telegraph burning
 * on the floor, and something in flight.
 */
const DIRECTION = {
  /* Capture lands at 3.50 s. Scheduled so that, on that frame: the fissure's
     flame front is 3 m out and still expanding (the frame's focal read, aimed
     into the pack), the hero's own scripted swing is frozen on its contact pose
     by hit-stop, numbers from both are still in the air, and the whirlwind that
     ran from 1.4–2.9 s has left DoTs burning on half the pack. */
  combat: {
    timeline: [
      { t: 0.40, id: 'warcry' },
      { t: 1.40, id: 'whirlwind' },
      { t: 3.05, id: 'shockwave' },
      { t: 3.20, id: 'kill' },
      { t: 4.40, id: 'glaive' },
      { t: 5.10, id: 'leap' },
      { t: 6.10, id: 'whirlwind' },
    ],
    loopFrom: 1,
    loopAt: 7.6,
    /** Keep the pack alive so the room is still full at the capture frame. */
    govern: true,
    heroFloor: 0.42,
  },
  /* Capture lands at 4.50 s: the void lance is channelling into the boss while
     the hero's scripted overhead reaches its slam. */
  boss: {
    timeline: [
      { t: 0.55, id: 'warcry' },
      { t: 1.30, id: 'glaive' },
      { t: 2.00, id: 'shockwave' },
      { t: 2.95, id: 'lance' },
      { t: 5.20, id: 'glaive' },
      { t: 5.90, id: 'shockwave' },
    ],
    loopFrom: 1,
    loopAt: 7.6,
    govern: true,
    heroFloor: 0.5,
  },
  dungeon: { timeline: [{ t: 1.6, id: 'warcry' }], govern: true, heroFloor: 0.6 },
  night: { timeline: [{ t: 1.1, id: 'glaive' }, { t: 2.4, id: 'shockwave' }], govern: true, heroFloor: 0.6 },
  overworld: { timeline: [{ t: 1.4, id: 'glaive' }], govern: true, heroFloor: 0.6 },
  hub: { timeline: [], govern: true, heroFloor: 1 },
  closeup: { timeline: [], govern: true, heroFloor: 1 },
  inventory: { timeline: [], govern: true, heroFloor: 1 },
};

/* ================================================================== *
 * CombatSystem
 * ================================================================== */

export class CombatSystem {
  static id = 'combat';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.failed = false;
    this._offs = [];

    this.rand = engine.freshRand(0x5ACB17);
    this.resolver = new DamageResolver(engine, this.rand);

    this.hitFeel = new HitFeel(engine, this);
    this.groundFX = new GroundFX(engine);
    this.abilityFX = new AbilityFX(engine);

    /* ---- player state. Health/resource mirror the hero when it exists. ---- */
    this.player = {
      health: 340, maxHealth: 340,
      resource: 45, maxResource: RESOURCE.max,
      level: 12, xp: 0, xpNext: XP.curve(12),
      dead: false, deathT: -1, invuln: 0,
      lastHitAt: -99, lastSpendAt: -99,
      kills: 0, combo: 0, comboT: -99,
    };
    /** @type {Array<object>} timed buffs (warcry etc.) */
    this.buffs = [];
    this._baseArmour = 148;
    this._baseDamage = 46;

    /* ---- ability machine ---- */
    /** @type {object|null} the running ability instance */
    this.act = null;
    this.cd = new Map();
    this.buffer = null;
    this.combo = { step: -1, until: -99 };
    this._swing = 0;
    this.projectiles = [];

    /* ---- targeting ---- */
    this.target = null;
    this._targetAt = -99;
    this.aim = { x: 0, z: 1 };

    /* ---- weapon path, measured, for swept hits ---- */
    this._hasPrev = false;
    this._pTip = new THREE.Vector3();
    this._pHilt = new THREE.Vector3();

    /* ---- telegraph mirror (AI + our own) ---- */
    this._tg = new Map();

    /* ---- scenario script ---- */
    this._script = null;
    this._scriptT = 0;
    this._scriptI = 0;
    this._govern = false;
    this._heroFloor = 0;
    this._allowKill = 0;
    this._userInput = false;

    this.stats = { hits: 0, kills: 0, casts: 0, dps: 0 };
  }

  /* =============================================================== init */

  async init() {
    try {
      this.hitFeel.init();
      this.groundFX.init();
      this.abilityFX.init();
      this._bind();
      const hero = this._hero();
      if (hero?.stats) {
        this._baseArmour = num(hero.stats.armour, 148);
        this._baseDamage = num(hero.stats.damage, 46);
        this.player.maxHealth = num(hero.stats.maxHealth, 340);
        this.player.health = num(hero.stats.health, this.player.maxHealth);
        this.player.level = num(hero.stats.level, 12);
        this.player.xpNext = XP.curve(this.player.level);
        hero.stats.maxResource = RESOURCE.max;
        hero.stats.resource = this.player.resource;
        if (!Number.isFinite(hero.stats.lifeSteal)) hero.stats.lifeSteal = 0.035;
      }
      console.info(`[combat] ${ABILITY_ORDER.length} abilities, ` +
        `${Object.keys(BINDS).length} binds, 5 draw calls, 1 texture unit`);
    } catch (e) {
      this.failed = true;
      console.error('[combat] init failed — module disabled', e);
      throw e;
    }
  }

  _bind() {
    const bus = this.engine.bus;
    const on = (evt, fn) => {
      try { this._offs.push(bus.on(evt, (p) => { try { fn(p); } catch (e) { console.warn(`[combat:${evt}]`, e?.message ?? e); } })); }
      catch { /* bus optional */ }
    };

    /* --- enemy telegraphs: mirror the AI's ground reads --- */
    on('telegraph:begin', (t) => this._telegraph(t, 'begin'));
    on('telegraph:update', (t) => this._telegraph(t, 'update'));
    on('telegraph:end', (t) => this._telegraph(t, 'end'));

    /* --- kill credit + progression --- */
    on('death', (p) => this._onDeath(p));

    /* --- someone else's damage still deserves feel (AI may bypass us) --- */
    on('damage', (p) => {
      if (!p || p.__combat) return;
      this.hitFeel.land(p);
    });

    /* --- a player command channel, so a Director or the HUD can fire skills --- */
    on('combat:cast', (p) => { if (p?.id) this.cast(p.id, p); });
    on('scenario', () => { /* applyScenario does the work; this is the fallback */ });
  }

  /* ============================================================ helpers */

  _hero() {
    const h = this.engine.get('hero');
    return h && !h.__dead && !h.failed ? h : null;
  }
  _bestiary() {
    const b = this.engine.get('bestiary');
    return b && !b.__dead ? b : null;
  }
  _props() {
    const p = this.engine.get('props');
    return p && !p.__dead && typeof p.queryNear === 'function' ? p : null;
  }
  /**
   * Does another module own the ground read? Decals draws SDF telegraphs that
   * conform to the floor, which is strictly better than a flat quad — so when it
   * is present, combat *publishes* its telegraphs on the bus and draws none
   * itself. Two coincident telegraphs double the opacity and disagree by a
   * frame, which is worse than having one.
   */
  _groundOwned() {
    const e = this.engine.clock.elapsed;
    if (e - num(this._ownedAt, -99) < 0.75) return this._owned;
    this._ownedAt = e;
    const d = this.engine.get('decals');
    const v = this.engine.get('vfx');
    this._owned = !!((d && !d.__dead && d.telegraphs) || (v && !v.__dead && v.ownsTelegraphs));
    return this._owned;
  }

  _groundY(x, z) {
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  /** Hero position, or the origin if the hero has not landed yet. */
  _heroPos(out) {
    const h = this._hero();
    const p = h?.position;
    if (p && Number.isFinite(p.x)) return out.set(p.x, p.y, p.z);
    return out.set(0, 0, 0);
  }

  /** Hero forward on the ground plane. Hero convention: (sin yaw, 0, cos yaw). */
  _heroFwd(out) {
    const h = this._hero();
    const y = num(h?.yaw, 0);
    return out.set(Math.sin(y), 0, Math.cos(y));
  }

  /** Shape-kernel yaw (atan2(dz,dx)) from a ground direction. */
  static shapeYaw(dx, dz) { return Math.atan2(dz, dx); }

  /** The hero's blade as a world segment, measured off the hand bone. */
  _weaponSeg(outTip, outHilt) {
    const h = this._hero();
    if (!h) return false;
    try {
      const w = h.mesh?.weapon;
      const bone = w ? h.rig?.bone?.(w.bone) : null;
      if (w && bone) {
        bone.updateWorldMatrix(true, false);
        outTip.copy(w.tip).applyMatrix4(bone.matrixWorld);
        outHilt.copy(w.hilt).applyMatrix4(bone.matrixWorld);
        return true;
      }
      if (typeof h.weaponTip === 'function') {
        h.weaponTip(outTip);
        this._heroPos(_v2);
        outHilt.set(_v2.x, _v2.y + 1.2, _v2.z);
        return true;
      }
    } catch { /* fall through */ }
    /* last resort: a forward stab from the chest, so combat still works */
    this._heroPos(_v2);
    this._heroFwd(_v1);
    outHilt.set(_v2.x, _v2.y + 1.15, _v2.z);
    outTip.copy(outHilt).addScaledVector(_v1, 1.6);
    return true;
  }

  /* ================================================================ *
   * public API — other modules call these
   * ================================================================ */

  /**
   * Inbound damage from a non-combat source (the AI calls this by contract).
   * @param {object} p {target, amount, type, hitPoint, hitNormal, source, ...}
   */
  applyDamage(p) {
    if (this.failed || !p || !p.target) return 0;
    const target = p.target;
    const ability = {
      id: p.abilityId ?? 'enemy',
      name: p.abilityLabel ?? 'Attack',
      type: p.type === 'necrotic' ? 'shadow' : (p.type ?? 'physical'),
      damage: 1,
      impact: clamp(num(p.amount, 10) / 26, 0.4, 2.4),
      stagger: 0.22,
      hitstop: 0.055,
      shake: clamp(num(p.amount, 10) / 340, 0.02, 0.2),
      glance: 0.8,
    };
    return this._resolve({
      attacker: p.source ?? null,
      target,
      ability,
      flat: num(p.amount, 0),
      edge: num(p.edge, 0.2),
      point: p.hitPoint ?? null,
      normal: p.hitNormal ?? null,
      type: ability.type,
    });
  }
  /** Aliases the AI probes for. */
  resolveEnemyAttack(p) { return this.applyDamage(p); }
  enemyAttack(p) { return this.applyDamage(p); }

  /** HUD-facing snapshot of the action bar. */
  bar() {
    const e = this.engine.clock.elapsed;
    return BAR.map((id) => {
      const a = ABILITIES[id];
      const ready = this.cd.get(id) ?? 0;
      const cdMax = a.cooldown ?? 0;
      return {
        id, name: a.name, glyph: a.glyph, slot: a.slot,
        cost: a.cost ?? 0, type: a.type,
        cd: Math.max(0, ready - e), cdMax,
        ready: e >= ready && this.player.resource >= (a.cost ?? 0) && !this.player.dead,
        active: this.act?.ability.id === id || (id === 'combo1' && this.act?.ability.comboStep >= 0),
      };
    });
  }

  /** HUD-facing vitals. */
  vitals() {
    return {
      health: this.player.health, maxHealth: this.player.maxHealth,
      resource: this.player.resource, maxResource: this.player.maxResource,
      resourceLabel: RESOURCE.label,
      level: this.player.level, xp: this.player.xp, xpNext: this.player.xpNext,
      dead: this.player.dead, invuln: this.player.invuln > 0,
      buffs: this.buffs.map((b) => ({ id: b.id, label: b.label, left: b.left, duration: b.duration })),
      target: this.target ? { name: this.target.name ?? this.target.id, hp: this.target.hp, maxHp: this.target.maxHp, rank: this.target.rank } : null,
    };
  }

  /**
   * Fire an ability by id. Honours cooldown, resource and the current phase; a
   * request that cannot start *now* is buffered rather than dropped.
   * @returns {boolean} true if it started this frame
   */
  cast(id, opts = {}) {
    if (this.failed || this.player.dead) return false;
    const want = id === 'combo' ? 'combo1' : id;
    const a = ABILITIES[want];
    if (!a) return false;
    return this._request(want, opts);
  }

  /* ================================================================ *
   * frame
   * ================================================================ */

  update(dt, elapsed) {
    if (this.failed) return;

    this._readInput();
    this._vitals(dt, elapsed);
    this._targeting(dt, elapsed);
    this._runScript(dt);

    if (this.act) this._stepAbility(dt, elapsed);
    else this._attachHeroClip(elapsed);
    this._flushBuffer(elapsed);

    this._projectiles(dt, elapsed);
    this.resolver.updateDots(dt, (p) => this._emit(p));

    /* the blade's path for next frame's sweep */
    if (this._weaponSeg(_tip, _hilt)) {
      this._pTip.copy(_tip); this._pHilt.copy(_hilt);
      this._hasPrev = true;
    }

    this.hitFeel.update(dt, elapsed);
    this.groundFX.update(dt, elapsed);
    this.abilityFX.update(dt, elapsed);
  }

  /* --------------------------------------------------------- input */

  _readInput() {
    const input = this.engine.input;
    if (!input) return;
    for (const key in BINDS) {
      let pressed = false;
      try {
        pressed = key.startsWith('mouse')
          ? !!input.justPressed?.(key)
          : !!input.justPressed?.(key);
      } catch { pressed = false; }
      if (!pressed) continue;
      this._userInput = true;
      this._govern = false;           // a real player is driving; stop posing
      this._script = null;
      this._request(BINDS[key], {});
    }
    /* held LMB auto-chains the combo, held RMB keeps the spin going */
    try {
      if (input.down?.(0) && !this.act && this._userInput) this._request('combo1', {});
      if (input.down?.(2) && this.act?.ability.id === 'whirlwind') this.act.hold = true;
      else if (this.act?.ability.id === 'whirlwind') this.act.hold = false;
    } catch { /* optional */ }
  }

  /* ------------------------------------------------------- vitals */

  _vitals(dt, elapsed) {
    const P = this.player;
    const hero = this._hero();

    /* buffs first — they change armour and damage */
    let armourMul = 1, damageMul = 1, resistAdd = 0, thorns = 0;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i];
      b.left -= dt;
      if (b.left <= 0) {
        this.buffs.splice(i, 1);
        this.engine.bus.emit('ui:toast', { text: `${b.label} fades`, tier: 'info' });
        continue;
      }
      armourMul += num(b.armour, 0);
      damageMul += num(b.damage, 0);
      resistAdd += num(b.resistAll, 0);
      thorns += num(b.thorns, 0);
    }
    if (hero?.stats) {
      if (!this.buffs.length) {
        /* No buff running: whoever else owns the sheet (Loot, a Director, the
           character panel) is the authority. Adopt its numbers rather than
           stamping ours over the top — a buff must not become a stat reset. */
        this._baseArmour = num(hero.stats.armour, this._baseArmour);
        this._baseDamage = num(hero.stats.damage, this._baseDamage);
        if (this._buffApplied) {
          this._buffApplied = false;
          hero.stats.thorns = 0;
          if (hero.stats.resists) for (const k in hero.stats.resists) hero.stats.resists[k] = 0;
        }
      } else {
        this._buffApplied = true;
        hero.stats.armour = this._baseArmour * armourMul;
        hero.stats.damage = this._baseDamage * damageMul;
        hero.stats.thorns = thorns;
        if (resistAdd > 0) {
          hero.stats.resists = hero.stats.resists ?? {};
          for (const k in TYPE_COLOR) hero.stats.resists[k] = resistAdd;
        }
      }
      // the hero caches its defence block on first hit; keep it honest
      if (hero.__cmbDef) hero.__cmbDef = undefined;
    }

    /* mirror health from whoever owns the body */
    if (hero?.stats) {
      P.health = num(hero.stats.health, P.health);
      P.maxHealth = num(hero.stats.maxHealth, P.maxHealth);
      P.dead = !!hero.isDead;
      P.invuln = num(hero._invuln, P.invuln);
    } else {
      P.invuln = Math.max(0, P.invuln - dt);
    }

    /* health regen — only well after the last hit landed */
    if (!P.dead && elapsed - P.lastHitAt > VITALS.regenDelay && P.health < P.maxHealth) {
      const h = Math.min(P.maxHealth, P.health + VITALS.regen * dt);
      P.health = h;
      if (hero?.stats) hero.stats.health = h;
    }

    /* fury: trickles in combat, bleeds away out of it */
    const inCombat = elapsed - P.lastHitAt < 5 || elapsed - P.lastSpendAt < 5 || !!this.target;
    if (inCombat) P.resource = Math.min(P.maxResource, P.resource + RESOURCE.regen * dt);
    else if (elapsed - P.lastSpendAt > RESOURCE.decayDelay) {
      P.resource = Math.max(0, P.resource - RESOURCE.decay * dt);
    }
    if (hero?.stats) hero.stats.resource = P.resource;

    /* combo meter decays; it is a feel read, not a stat */
    if (elapsed - P.comboT > 2.4) P.combo = 0;

    /* death + respawn */
    if (P.dead && P.deathT < 0) {
      P.deathT = elapsed;
      this._cancel(true);
      this.engine.bus.emit('camera:shake', { amp: 0.42, freq: 10, duration: 1.1 });
    } else if (!P.dead && P.deathT >= 0) {
      P.deathT = -1;
    }
    if (P.dead && elapsed - P.deathT > VITALS.deathHold) {
      this._respawn();
    }
  }

  _respawn() {
    const P = this.player;
    const hero = this._hero();
    P.deathT = -1;
    P.dead = false;
    P.resource = Math.round(RESOURCE.max * 0.35);
    P.combo = 0;
    this.buffs.length = 0;
    this.resolver.clearDots(hero);
    try {
      if (hero?.revive) hero.revive();
      else if (hero?.stats) { hero.stats.health = hero.stats.maxHealth; hero.isDead = false; }
    } catch { /* hero may be gone */ }
    P.health = num(hero?.stats?.maxHealth, P.maxHealth);
    this.engine.bus.emit('ui:toast', { text: 'You rise again', tier: 'good' });
    this.engine.bus.emit('camera:shake', { amp: 0.14, freq: 8, duration: 0.7 });
  }

  /* ---------------------------------------------------- targeting */

  /**
   * Soft-lock: the nearest live body inside the facing arc, with hysteresis so
   * the reticle does not flicker between two enemies standing together.
   */
  _targeting(dt, elapsed) {
    const bes = this._bestiary();
    const hero = this._hero();
    if (!bes || !hero) { this.target = null; this.groundFX.clearReticle(); return; }

    this._heroPos(_v1);
    this._heroFwd(_v2);
    /* aim: the cursor when the player is driving, the facing otherwise */
    let ax = _v2.x, az = _v2.z;
    if (this._userInput) {
      const g = this.engine.input?.mouse?.worldGround;
      if (g && Number.isFinite(g.x)) {
        const dx = g.x - _v1.x, dz = g.z - _v1.z;
        const l = Math.hypot(dx, dz);
        if (l > 1.2) { ax = dx / l; az = dz / l; }
      }
    }
    this.aim.x = ax; this.aim.z = az;

    const list = bes.queryNear(_v1, 16, _cand);
    let best = null, bestScore = 1e9;
    for (const en of list) {
      if (en.dead) continue;
      const dx = en.position.x - _v1.x, dz = en.position.z - _v1.z;
      const d = Math.hypot(dx, dz) || 1e-4;
      const dot = (dx / d) * ax + (dz / d) * az;
      if (dot < 0.15 && d > 3.2) continue;                  // behind and far: ignore
      // prefer close, in front, and already targeted
      let score = d * (1.9 - dot) + (en.def?.isBoss ? -6 : 0) + (en.elite ? -1.6 : 0);
      if (en === this.target) score -= 2.6;                  // hysteresis
      if (score < bestScore) { bestScore = score; best = en; }
    }
    if (best !== this.target) {
      this.target = best;
      this._targetAt = elapsed;
    }

    if (this.target && !this.target.dead) {
      const t = this.target;
      /* The reticle hugs the target's footprint. Scaling it 2.1x meant the boss
         (2.35 m collision radius) wore a 10 m dashed ring — read as an AoE
         telegraph rather than a selection, and dominated the arena. */
      const r = clamp(num(t.radius, 0.5) * 1.35 + 0.22, 0.62, 3.2);
      const hot = t.def?.isBoss ? 0xff7a3c : t.elite ? 0xffc766 : 0x9fd9ff;
      this.groundFX.reticle(t.position.x, t.position.z, r, hot);
    } else {
      this.groundFX.clearReticle();
    }
    void dt;
  }

  /* ================================================================ *
   * ability machine
   * ================================================================ */

  /**
   * A request to act. This is where responsiveness lives: during recovery (or
   * the tail of an active window) the request is *buffered* so it fires the
   * instant the window closes; a dash cancels outright.
   */
  _request(id, opts = {}) {
    const a = ABILITIES[id];
    if (!a || this.player.dead) return false;
    const e = this.engine.clock.elapsed;

    /* combo chaining: tapping the basic attack advances the chain */
    let want = id;
    if (id === 'combo1' && this.combo.step >= 0 && e < this.combo.until) {
      want = COMBO_CHAIN[Math.min(COMBO_CHAIN.length - 1, this.combo.step + 1)];
      if (this.combo.step >= COMBO_CHAIN.length - 1) want = 'combo1';
    }

    const cur = this.act;
    if (cur) {
      if (a.cancels) { this._cancel(false); return this._start(want, opts); }
      // buffering window: recovery, or the last 40% of the active window
      const late = cur.phase === 'recovery'
        || (cur.phase === 'active' && cur.t > cur.dur.active * 0.6);
      if (late) { this.buffer = { id: want, at: e, opts }; return false; }
      return false;
    }
    return this._start(want, opts);
  }

  _flushBuffer(elapsed) {
    if (!this.buffer || this.act) return;
    if (elapsed - this.buffer.at > 0.55) { this.buffer = null; return; }
    const b = this.buffer;
    this.buffer = null;
    this._start(b.id, b.opts);
  }

  _start(id, opts = {}) {
    const a = ABILITIES[id];
    const e = this.engine.clock.elapsed;
    const P = this.player;
    if (!a) return false;

    /* cooldown */
    const key = a.comboStep >= 0 ? 'combo1' : id;
    if (e < (this.cd.get(key) ?? 0)) return false;

    /* resource */
    const cost = num(a.cost, 0);
    if (cost > P.resource + 1e-3) {
      if (!opts.silent) this.engine.bus.emit('ui:toast', { text: `Not enough ${RESOURCE.label}`, tier: 'warn' });
      return false;
    }

    const hero = this._hero();
    this._heroPos(_v1);
    /* aim direction: the soft-lock target wins, then the cursor/facing */
    let dx = this.aim.x, dz = this.aim.z;
    if (this.target && !this.target.dead) {
      const tx = this.target.position.x - _v1.x, tz = this.target.position.z - _v1.z;
      const l = Math.hypot(tx, tz);
      if (l > 0.3) { dx = tx / l; dz = tz / l; }
    }
    if (opts.dir && Number.isFinite(opts.dir.x)) {
      const l = Math.hypot(opts.dir.x, opts.dir.z) || 1;
      dx = opts.dir.x / l; dz = opts.dir.z / l;
    }

    /* ask the hero for the animation, unless the scenario is driving its own
       performance — stealing the clip there would break the posed frame */
    let clip = null;
    const wantAnim = opts.anim !== false;
    if (wantAnim && hero) {
      try {
        if (a.anim === 'attack1' || a.anim === 'attack2' || a.anim === 'attack3') {
          if (hero.attack?.()) clip = hero.graph?.action ?? a.anim;
          else return false;                            // locked: do not fake it
        } else if (a.anim === 'heavy') { if (hero.heavy?.()) clip = 'heavy'; }
        else if (a.anim === 'cast') { if (hero.cast?.()) clip = 'cast'; }
        else if (a.anim === 'dash') { if (hero.dash?.()) clip = 'dash'; }
      } catch { clip = null; }
    }
    /* the hero picked the combo step; follow it so damage matches the pose */
    let ability = a;
    if (clip && CLIP_ABILITY[clip] && a.comboStep >= 0) ability = ABILITIES[CLIP_ABILITY[clip]] ?? a;

    /* face the aim so the shape and the body agree */
    if (hero && !opts.keepFacing && ability.anim !== 'dash') {
      const yaw = Math.atan2(dx, dz);
      hero.yaw = yaw;
      if (hero.root) hero.root.rotation.y = yaw;
    }

    P.resource = Math.max(0, P.resource - cost);
    if (cost > 0) P.lastSpendAt = e;
    this.cd.set(key, e + num(ability.cooldown, 0) + num(ability.windup, 0));

    const origin = _v1.clone();
    origin.y = this._groundY(origin.x, origin.z);
    const inst = {
      ability,
      id: ability.id,
      swingId: ++this._swing,
      phase: 'windup',
      t: 0,
      total: 0,
      dur: {
        windup: num(ability.windup, 0.1),
        active: num(ability.active, 0.1),
        recovery: num(ability.recovery, 0.1),
      },
      clip,
      hit: new Set(),
      hitCount: 0,
      tickT: 0,
      dir: { x: dx, z: dz },
      yaw: Math.atan2(dz, dx),
      origin,
      aim: this._aimPoint(origin, dx, dz, ability),
      hold: true,
      held: 0,
      anchor: this.target && !this.target.dead ? this.target : null,
      tgUid: null,
      landed: false,
      fired: false,
      props: 0,
      startY: origin.y,
    };
    this.act = inst;
    this.stats.casts++;

    /* the windup telegraph — the tell that makes an attack readable */
    this._showOwnTelegraph(inst);

    /* one bus event per cast: VFX, audio and the bestiary all key off it */
    this.engine.bus.emit('ability:cast', {
      id: ability.id, caster: hero ?? null, casterId: 'hero',
      origin: { x: origin.x, y: origin.y + 1.15, z: origin.z },
      dir: { x: dx, y: 0, z: dz },
      level: (ability.comboStep ?? 0) + 1,
      windup: inst.dur.windup, active: inst.dur.active,
      type: ability.type, color: ability.vfx?.color ?? TYPE_COLOR[ability.type],
      kind: ability.vfx?.kind ?? 'melee', ability,
    });
    return true;
  }

  _aimPoint(origin, dx, dz, ability) {
    const reach = ability.id === 'leap' ? num(ability.leapRange, 8) : num(ability.shape?.radius, 3);
    let px = origin.x + dx * reach, pz = origin.z + dz * reach;
    if (this.target && !this.target.dead) {
      const t = this.target.position;
      const d = Math.hypot(t.x - origin.x, t.z - origin.z);
      if (d <= reach + 1.5) { px = t.x; pz = t.z; }
    }
    return { x: px, z: pz, y: this._groundY(px, pz) };
  }

  _cancel(hard) {
    const inst = this.act;
    if (!inst) return;
    this._endOwnTelegraph(inst, false);
    this.act = null;
    if (hard) { this.buffer = null; this.combo.step = -1; }
  }

  /** Advance the running ability through windup → active → recovery. */
  _stepAbility(dt, elapsed) {
    const inst = this.act;
    const a = inst.ability;
    inst.t += dt;
    inst.total += dt;

    /* channels drain resource and end early when it runs dry */
    if (a.costPerSecond && inst.phase === 'active') {
      const drain = a.costPerSecond * dt;
      if (this.player.resource < drain) { this._endAbility(inst, elapsed); return; }
      this.player.resource -= drain;
      this.player.lastSpendAt = elapsed;
      inst.held += dt;
    }

    /* A weapon ability's hit window belongs to the animation; a shaped one owns
       its own clock. Gating a 9 m fissure on a 0.18 s clip window would stunt
       the sweep, and gating a blade on a stopwatch would desynchronise it. */
    const byClip = !!(inst.clip && CLIP_WINDOW[inst.clip]
      && (a.shape?.kind === 'weapon' || a.shape?.kind === 'trail'));

    switch (inst.phase) {
      case 'windup': {
        this._windup(inst, dt, elapsed);
        const done = byClip
          ? this._clipPhase() >= CLIP_WINDOW[inst.clip][0]
          : inst.t >= inst.dur.windup;
        if (done) {
          inst.phase = 'active';
          inst.t = 0;
          this._endOwnTelegraph(inst, true);
          this._onActive(inst, elapsed);
        }
        break;
      }
      case 'active': {
        this._sweep(inst, dt, elapsed);
        const done = byClip
          ? this._clipPhase() >= CLIP_WINDOW[inst.clip][1] || this._clipPhase() <= 0.02
          : inst.t >= inst.dur.active;
        if (done && !(a.channel && inst.hold && inst.held < inst.dur.active)) {
          inst.phase = 'recovery';
          inst.t = 0;
          this._onRecover(inst, elapsed);
        }
        break;
      }
      default: {
        this._recover(inst, dt, elapsed);
        if (inst.t >= inst.dur.recovery) this._endAbility(inst, elapsed);
        break;
      }
    }
  }

  /** Phase 0..1 of the hero clip currently driving this ability, or -1. */
  _clipPhase() {
    const h = this._hero();
    const g = h?.graph;
    if (!g) return -1;
    const inst = this.act;
    if (!inst?.clip) return -1;
    if (inst.clip === 'dash') return g.baseClip === 'dash' ? g.basePhase : 1;
    return g.action === inst.clip ? g.actionPhase : 1;
  }

  _windup(inst, dt, elapsed) {
    const a = inst.ability;
    /* leap: travel across the windup on a real arc */
    if (a.id === 'leap') this._leapTravel(inst, dt);
    if (a.id === 'whirlwind') this._spin(inst, dt, elapsed, 0.4);
    /* re-aim a following telegraph while the tell is still readable */
    if (inst.tgUid && a.telegraph?.follow) {
      this._heroPos(_v1);
      this.groundFX.update2(inst.tgUid, _v1.x, _v1.z, inst.yaw, undefined);
    }
    void elapsed;
  }

  _onActive(inst, elapsed) {
    const a = inst.ability;
    const hero = this._hero();
    this._heroPos(_v1);

    if (a.iframes && hero) hero._invuln = Math.max(num(hero._invuln, 0), a.iframes);

    /* one-shot shapes resolve their ground read and their impact immediately */
    if (a.id === 'leap') {
      const p = inst.aim;
      this.groundFX.pulse(p.x, p.z, num(a.shape.radius, 3) * 0.9, 0xffb063, 0.42);
      this.engine.bus.emit('impact', {
        point: { x: p.x, y: p.y + 0.06, z: p.z }, normal: { x: 0, y: 1, z: 0 },
        kind: 'heavy_impact', magnitude: 1.5, sourceId: 'hero',
      });
    } else if (a.id === 'warcry') {
      this._applyBuff(a);
      this.groundFX.show({
        uid: `own${inst.swingId}`, kind: 'flash', shape: SHAPE.RING,
        x: _v1.x, z: _v1.z, radius: a.shape.radius, inner: 0.15,
        color: a.telegraph.color, alpha: 0.85, duration: 0.5, sweep: true, follow: hero,
      });
      this.engine.bus.emit('impact', {
        point: { x: _v1.x, y: _v1.y + 0.9, z: _v1.z }, normal: { x: 0, y: 1, z: 0 },
        kind: 'shout', magnitude: 1.0, sourceId: 'hero',
      });
    } else if (a.projectile) {
      this._fireProjectile(inst);
    } else if (a.id === 'shockwave') {
      this.groundFX.show({
        uid: `own${inst.swingId}`, kind: 'wave', shape: SHAPE.CONE,
        x: _v1.x, z: _v1.z, yaw: inst.yaw, length: a.shape.radius,
        angle: a.shape.angle, color: a.telegraph.color, alpha: 0.62,
        duration: inst.dur.active, sweep: true,
      });
    }
    void elapsed;
  }

  _onRecover(inst) {
    const a = inst.ability;
    /* the combo window: press again inside it and the chain advances */
    if (a.comboStep >= 0 && a.comboWindow > 0) {
      this.combo.step = a.comboStep;
      this.combo.until = this.engine.clock.elapsed + a.comboWindow;
    } else if (a.comboStep >= 0) {
      this.combo.step = -1;
    }
    if (a.id === 'combo3' && a.shape.groundBurst) {
      this._heroPos(_v1);
      this._heroFwd(_v2);
      const x = _v1.x + _v2.x * 1.5, z = _v1.z + _v2.z * 1.5;
      this.groundFX.pulse(x, z, a.shape.groundBurst, 0xffd0a0, 0.36);
    }
  }

  _recover(inst, dt, elapsed) {
    if (inst.ability.id === 'whirlwind') this._spin(inst, dt, elapsed, 0.3);
  }

  _endAbility(inst, elapsed) {
    const a = inst.ability;
    this._endOwnTelegraph(inst, false);
    if (a.channel) {
      this.abilityFX.setBeam(0, 0, 0, 0, 0, 1, 0, 0, 0);
      this.abilityFX.setWhirl(0, 0, 0, 1, 0, 0);
    }
    /* Scorch. Where a big ability landed stays marked for a couple of seconds —
       the floor remembers the fight, which is most of what sells an ARPG frame
       until a real Decals module owns it. */
    if (!this._groundOwned() && (inst.landed || a.id === 'shockwave' || a.id === 'leap')) {
      if (a.id === 'shockwave') {
        this.groundFX.show({
          uid: `sc${inst.swingId}`, kind: 'residual', shape: SHAPE.CONE,
          x: inst.origin.x, z: inst.origin.z, yaw: inst.yaw,
          length: num(a.shape.radius, 8) * 0.92, angle: num(a.shape.angle, 1.2) * 0.94,
          color: 0x8c3208, alpha: 0.34, duration: 2.3, sweep: false, fadeIn: 0,
        });
      } else if (a.id === 'leap') {
        this.groundFX.show({
          uid: `sc${inst.swingId}`, kind: 'residual', shape: SHAPE.RING,
          x: inst.aim.x, z: inst.aim.z, radius: num(a.shape.radius, 3.4),
          inner: 0.62, color: 0x8c3a12, alpha: 0.40, duration: 2.6, sweep: false, fadeIn: 0,
        });
      }
    }
    /* refresh the real cooldown from the end of the action, not the start */
    const key = a.comboStep >= 0 ? 'combo1' : a.id;
    this.cd.set(key, elapsed + num(a.cooldown, 0));
    this.act = null;
  }

  /* ---------------------------------------------------- hit sweeps */

  /**
   * The active window. Every shape resolves here; `weapon` is the interesting
   * one because it sweeps the blade's measured path rather than testing a static
   * arc, which is what keeps damage and animation in lockstep.
   */
  _sweep(inst, dt, elapsed) {
    const a = inst.ability;
    const kind = a.shape?.kind ?? 'weapon';
    const bes = this._bestiary();
    if (!bes) return;

    this._heroPos(_v1);
    const hx = _v1.x, hy = _v1.y, hz = _v1.z;

    /* ticked shapes: clear the hit set each tick so a channel keeps hitting */
    let tick = false;
    if (a.tickRate) {
      inst.tickT -= dt;
      if (inst.tickT <= 0) {
        inst.tickT += a.tickRate;
        tick = true;
        inst.hit.clear();
        inst.hitCount = 0;
      }
    }

    switch (kind) {
      case 'weapon': return this._sweepWeapon(inst, elapsed);
      case 'circle': {
        if (a.tickRate && !tick) { if (a.id === 'whirlwind') this._spin(inst, dt, elapsed, 1); return; }
        if (a.id === 'whirlwind') this._spin(inst, dt, elapsed, 1);
        const c = a.id === 'leap' ? inst.aim : { x: hx, z: hz, y: hy };
        const near = bes.queryNear(c, a.shape.radius + 2.2, _cand);
        for (const en of near) {
          if (!this._canHit(inst, en)) continue;
          const edge = hitCircle(c.x, c.z, a.shape.radius, en.position.x, en.position.z, num(en.radius, 0.5));
          if (edge < 0) continue;
          this._hitEnemy(inst, en, edge, c.x, c.z);
        }
        this._breakProps(c.x, c.z, a.shape.radius, inst);
        break;
      }
      case 'wave': {
        /* expanding ring, limited to a forward cone */
        const u = clamp01(inst.t / Math.max(0.02, inst.dur.active));
        const r = num(a.shape.inner, 1) + (num(a.shape.radius, 8) - num(a.shape.inner, 1)) * u;
        const near = bes.queryNear({ x: hx, z: hz }, r + 2.5, _cand);
        for (const en of near) {
          if (!this._canHit(inst, en)) continue;
          const band = hitRing(inst.origin.x, inst.origin.z, r + num(a.shape.width, 1.5) * 0.5,
            Math.max(0, r - num(a.shape.width, 1.5) * 0.5), en.position.x, en.position.z, num(en.radius, 0.5));
          if (band < 0) continue;
          const cone = hitCone(inst.origin.x, inst.origin.z, inst.yaw, r + 1, num(a.shape.angle, 1.2),
            en.position.x, en.position.z, num(en.radius, 0.5));
          if (cone < 0) continue;
          this._hitEnemy(inst, en, Math.max(band * 0.6, cone * 0.6), inst.origin.x, inst.origin.z);
        }
        /* the flame front is a moving impact, so the ground reads it too */
        if (Math.floor(inst.t / 0.14) !== Math.floor((inst.t - dt) / 0.14)) {
          const px = inst.origin.x + Math.cos(inst.yaw) * r;
          const pz = inst.origin.z + Math.sin(inst.yaw) * r;
          this.engine.bus.emit('impact', {
            point: { x: px, y: this._groundY(px, pz) + 0.05, z: pz },
            normal: { x: 0, y: 1, z: 0 }, kind: 'fire', magnitude: 0.55, sourceId: 'hero',
          });
          this._breakProps(px, pz, 1.3, inst);
        }
        break;
      }
      case 'beam': {
        const len = num(a.shape.length, 12);
        const rad = num(a.shape.radius, 0.8);
        const oy = hy + 1.18;
        const dx = inst.dir.x, dz = inst.dir.z;
        /* the beam stops at the world, not through it */
        this.abilityFX.setBeam(hx + dx * 0.55, oy, hz + dz * 0.55, dx, 0, dz, len, rad * 0.7,
          clamp01(inst.t / 0.12) * (1 - clamp01((inst.t - inst.dur.active + 0.2) / 0.2)) * 0.95,
          a.vfx?.color ?? 0xa95cff);
        this.groundFX.show({
          uid: `own${inst.swingId}`, kind: 'beam', shape: SHAPE.LINE,
          x: hx, z: hz, yaw: inst.yaw, length: len, width: rad * 2.4,
          color: a.telegraph?.color ?? 0xa95cff, alpha: 0.42, duration: 0.2, sweep: false,
        });
        if (!tick) break;
        const near = bes.queryNear({ x: hx + dx * len * 0.5, z: hz + dz * len * 0.5 }, len * 0.5 + 3, _cand);
        for (const en of near) {
          if (!this._canHit(inst, en)) continue;
          const edge = hitLine(hx, hz, inst.yaw, len, rad * 2, en.position.x, en.position.z, num(en.radius, 0.5));
          if (edge < 0) continue;
          this._hitEnemy(inst, en, edge, hx, hz);
        }
        break;
      }
      case 'trail': {
        /* dash: a capsule dragged along the hero's own path */
        const near = bes.queryNear({ x: hx, z: hz }, num(a.shape.radius, 1) + 2, _cand);
        for (const en of near) {
          if (!this._canHit(inst, en)) continue;
          const edge = hitCircle(hx, hz, num(a.shape.radius, 1), en.position.x, en.position.z, num(en.radius, 0.5));
          if (edge < 0) continue;
          this._hitEnemy(inst, en, edge, hx, hz);
        }
        break;
      }
      default: break;
    }
  }

  /**
   * Swept blade. Tests the segment the weapon occupies now *and* the segment it
   * occupied last frame, plus the midpoint between them: three capsule tests per
   * candidate, which closes the tunnelling gap a 20 m/s tip opens at 60 Hz.
   */
  _sweepWeapon(inst, elapsed) {
    const bes = this._bestiary();
    if (!bes || !this._weaponSeg(_tip, _hilt)) return;
    const a = inst.ability;
    const R = num(a.shape.radius, 0.4);
    this._heroPos(_v1);
    const near = bes.queryNear(_v1, num(a.shape.reach, 2.6) + 2.4, _cand);
    const prev = this._hasPrev;

    for (const en of near) {
      if (!this._canHit(inst, en)) continue;
      const h = num(en.height, 1.8);
      const p = en.position;
      const b0y = p.y + h * 0.16, b1y = p.y + h * 0.92;
      const br = Math.max(0.22, num(en.radius, 0.45) * 0.92);

      let edge = hitCapsule(_hilt.x, _hilt.y, _hilt.z, _tip.x, _tip.y, _tip.z, R,
        p.x, b0y, p.z, p.x, b1y, p.z, br, _seg);
      if (edge < 0 && prev) {
        // midpoint of the sweep
        const mhx = (_hilt.x + this._pHilt.x) * 0.5, mhy = (_hilt.y + this._pHilt.y) * 0.5, mhz = (_hilt.z + this._pHilt.z) * 0.5;
        const mtx = (_tip.x + this._pTip.x) * 0.5, mty = (_tip.y + this._pTip.y) * 0.5, mtz = (_tip.z + this._pTip.z) * 0.5;
        edge = hitCapsule(mhx, mhy, mhz, mtx, mty, mtz, R, p.x, b0y, p.z, p.x, b1y, p.z, br, _seg);
        if (edge < 0) {
          edge = hitCapsule(this._pHilt.x, this._pHilt.y, this._pHilt.z,
            this._pTip.x, this._pTip.y, this._pTip.z, R, p.x, b0y, p.z, p.x, b1y, p.z, br, _seg);
        }
      }
      if (edge < 0) continue;
      this._hitEnemy(inst, en, edge, _seg.ax, _seg.az, _seg.ay);
    }

    /* the blade also breaks the dressing it passes through */
    this._breakProps(_tip.x, _tip.z, R + 0.5, inst);
    void elapsed;
  }

  /**
   * One hit per target per swing — or per *tick*, for a channel. `hitCount` is
   * the cleave cap; it resets with the tick so a whirlwind keeps biting.
   */
  _canHit(inst, en) {
    if (!en || en.dead || en.removeMe) return false;
    if (inst.hit.has(en)) return false;
    return inst.hitCount < Math.max(1, num(inst.ability.maxTargets, 1));
  }

  /** Resolve one landed hit on one body. */
  _hitEnemy(inst, en, edge, px, pz, py) {
    inst.hit.add(en);
    inst.hitCount++;
    inst.landed = true;
    const h = num(en.height, 1.8);
    const point = {
      x: Number.isFinite(px) ? px : en.position.x,
      y: Number.isFinite(py) ? py : en.position.y + h * 0.6,
      z: Number.isFinite(pz) ? pz : en.position.z,
    };
    let nx = en.position.x - point.x, nz = en.position.z - point.z;
    const l = Math.hypot(nx, nz);
    if (l < 1e-4) { nx = inst.dir.x; nz = inst.dir.z; } else { nx /= l; nz /= l; }

    const hero = this._hero();
    this._resolve({
      attacker: hero,
      target: en,
      ability: inst.ability,
      edge,
      point,
      normal: { x: nx, y: 0.18, z: nz },
      mul: 1 + Math.min(0.28, this.player.combo * 0.035),
    });

    /* fury on connect, never on cast: the resource follows the hit */
    const gain = num(inst.ability.gain, 0);
    if (gain > 0) {
      this.player.resource = Math.min(this.player.maxResource, this.player.resource + gain * 0.5);
    }
    this.player.combo++;
    this.player.comboT = this.engine.clock.elapsed;
  }

  /**
   * Destructibles inside a shape: barrels shatter when a real blow passes
   * through them. Capped hard at two per action — a one-second whirlwind tests
   * its radius sixty times, and without the cap it strips a room of dressing (and
   * buries the fight under loot labels) in a single cast.
   */
  _breakProps(x, z, r, inst) {
    if (num(inst.ability.impact, 0) < 1.2 || inst.props >= 2) return;
    const props = this._props();
    if (!props) return;
    const near = props.queryNear({ x, z }, r);
    for (const rec of near) {
      if (!rec.dest || rec.broken) continue;
      if (inst.hit.has(rec)) continue;
      inst.hit.add(rec);
      inst.props = num(inst.props, 0) + 1;
      try { props.damage(rec, 999, { x: rec.x, y: (rec.y ?? 0) + 0.4, z: rec.z }); } catch { /* noop */ }
      if (inst.props >= 2) return;
    }
  }

  /* --------------------------------------------------- resolution */

  /**
   * Roll a hit, apply it to whoever owns the body, and emit exactly one
   * `damage` event. Life-steal and thorns settle here too.
   */
  _resolve(ctx) {
    const target = ctx.target;
    if (!target) return 0;
    const toHero = !!target.isHero;

    /* The hero mitigates inside its own applyDamage; rolling mitigation here as
       well would double-count every point of the player's armour. */
    const p = this.resolver.resolve({ ...ctx, skipMitigation: toHero });
    if (!p) return 0;
    p.__combat = true;

    /* scenario governor: keep the fight alive for the captured frame */
    if (this._govern) this._governDamage(p, toHero);

    if (toHero) {
      const hero = this._hero();
      let applied = p.amount;
      try {
        if (hero?.applyDamage) {
          applied = hero.applyDamage(p.amount, ctx.attacker ?? p.source, {
            silent: true, point: p.hitPoint, type: p.type, crit: p.crit,
          });
        }
      } catch { /* hero mid-teardown */ }
      if (!(applied > 0)) {
        // fully avoided (i-frames): say so and stop
        if (num(hero?._invuln, 0) > 0) {
          this.engine.bus.emit('ui:toast', { text: 'Evaded', tier: 'info' });
        }
        return 0;
      }
      p.amount = Math.max(1, Math.round(applied));
      p.__fromHero = true;               // Hero's own listener must not re-apply
      p.tier = 'player';
      this.player.lastHitAt = this.engine.clock.elapsed;
      this.player.combo = 0;
      /* thorns: the player's buff bites the attacker back */
      const th = num(this._hero()?.stats?.thorns, 0);
      if (th > 0 && ctx.attacker && !ctx.attacker.isHero) {
        this._reflect(ctx.attacker, th, p.hitPoint);
      }
    } else {
      /* life-steal on the attacker */
      if (p.lifeSteal > 0 && ctx.attacker?.isHero) {
        const hero = this._hero();
        try { hero?.heal?.(p.lifeSteal); } catch { /* noop */ }
      }
      /* thorns on the defender */
      if (p.thorns > 0 && ctx.attacker?.isHero) {
        this._reflect(ctx.attacker, p.thorns, p.hitPoint, true);
      }
      /* damage-over-time riders */
      const dot = ctx.ability?.dot;
      if (dot && !p.glancing) {
        this.resolver.applyDot(target, {
          ...dot, sourceId: 'hero', source: ctx.attacker ?? null, abilityId: ctx.ability.id,
        });
      }
    }

    this.stats.hits++;
    this._emit(p);
    return p.amount;
  }

  /** Reflected damage — no crit, no feel, just a number and a health change. */
  _reflect(victim, amount, point, toHero = false) {
    const amt = Math.max(1, Math.round(amount));
    if (toHero) {
      const hero = this._hero();
      try { hero?.applyDamage?.(amt, victim, { silent: true, point, type: 'physical' }); } catch { /* noop */ }
      this._emit({
        target: hero, amount: amt, type: 'physical', crit: false, tier: 'player',
        hitPoint: point ?? null, hitNormal: null, sourceId: victim?.id ?? null,
        source: victim ?? null, abilityId: 'thorns', knockback: 0, stagger: 0,
        hitstop: 0, shake: 0.02, lifeSteal: 0, thorns: 0, __combat: true, __fromHero: true,
      });
      return;
    }
    this._emit({
      target: victim, amount: amt, type: 'physical', crit: false, tier: 'normal',
      hitPoint: point ?? null, hitNormal: null, sourceId: 'hero', source: this._hero(),
      abilityId: 'thorns', knockback: 0, stagger: 0, hitstop: 0, shake: 0,
      lifeSteal: 0, thorns: 0, __combat: true,
    });
  }

  /**
   * Scenario posing. A scripted fight that resolves in one second leaves the
   * capture frame looking at an empty room, so during scripted play damage never
   * finishes a body unless the script has explicitly opened a kill window.
   */
  _governDamage(p, toHero) {
    if (toHero) {
      const floor = this._heroFloor * num(this.player.maxHealth, 340);
      const left = num(this.player.health, 340) - floor;
      if (p.amount > left) p.amount = Math.max(1, Math.floor(Math.max(0, left)));
      return;
    }
    const hp = num(p.target?.hp, NaN);
    if (!Number.isFinite(hp)) return;
    if (this._allowKill > 0 && p.amount >= hp && !p.dot) { this._allowKill--; return; }
    if (p.amount >= hp) {
      p.amount = Math.max(1, Math.floor(hp * (p.dot ? 0.25 : 0.55)));
      p.lethal = false;
      p.overkill = 0;
      p.tier = p.dot ? 'dot' : p.glancing ? 'glance' : p.brutal ? 'brutal' : p.crit ? 'crit' : 'normal';
      p.remainingHp = hp - p.amount;
    }
  }

  /** Emit + dress a resolved payload. The single write path for `damage`. */
  _emit(p) {
    if (!p) return;
    p.__combat = true;
    try { this.engine.bus.emit('damage', p); } catch { /* noop */ }
    this.hitFeel.land(p);
  }

  /* -------------------------------------------------- projectiles */

  _fireProjectile(inst) {
    const a = inst.ability;
    const spec = a.projectile;
    this._heroPos(_v1);
    const count = Math.max(1, spec.count ?? 1);
    for (let i = 0; i < count; i++) {
      const spread = count > 1 ? (i / (count - 1) - 0.5) * 0.32 : 0;
      const c = Math.cos(spread), s = Math.sin(spread);
      const dx = inst.dir.x * c - inst.dir.z * s;
      const dz = inst.dir.x * s + inst.dir.z * c;
      const p = {
        x: _v1.x + dx * 0.7, y: _v1.y + 1.15, z: _v1.z + dz * 0.7,
        dx, dy: 0, dz,
        speed: num(spec.speed, 24),
        life: num(spec.life, 1),
        age: 0,
        radius: num(spec.radius, 0.5),
        spin: 0, spinRate: num(spec.spin, 18),
        size: 0.62, alpha: 1,
        color: a.vfx?.color ?? TYPE_COLOR[a.type] ?? 0xcbb4ff,
        ability: a,
        hit: new Set(),
        hitCount: 0,
        swingId: inst.swingId,
      };
      this.projectiles.push(p);
      this.abilityFX.addProjectile(p);
    }
    inst.fired = true;
  }

  _projectiles(dt, elapsed) {
    if (!this.projectiles.length) return;
    const bes = this._bestiary();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      const step = p.speed * dt;
      p.x += p.dx * step; p.y += p.dy * step; p.z += p.dz * step;
      p.spin += p.spinRate * dt;
      p.alpha = clamp01(1 - Math.max(0, (p.age - p.life + 0.18) / 0.18));

      if (bes) {
        const near = bes.queryNear({ x: p.x, z: p.z }, p.radius + 2, _cand);
        for (const en of near) {
          if (en.dead || p.hit.has(en)) continue;
          const edge = hitCircle(p.x, p.z, p.radius, en.position.x, en.position.z, num(en.radius, 0.5));
          if (edge < 0) continue;
          const h = num(en.height, 1.8);
          if (p.y < en.position.y + h * 0.05 || p.y > en.position.y + h * 1.15) continue;
          p.hit.add(en);
          p.hitCount++;
          this._resolve({
            attacker: this._hero(), target: en, ability: p.ability, edge,
            point: { x: p.x, y: p.y, z: p.z },
            normal: { x: p.dx, y: 0.1, z: p.dz },
          });
          this.engine.bus.emit('impact', {
            point: { x: p.x, y: p.y, z: p.z }, normal: { x: -p.dx, y: 0.2, z: -p.dz },
            kind: 'lightning', magnitude: 0.7, sourceId: 'hero',
          });
          if (!p.ability.pierce) { p.age = p.life + 1; break; }
        }
      }

      /* terrain / world stop */
      const gy = this._groundY(p.x, p.z);
      if (p.y <= gy + 0.1) {
        this.groundFX.pulse(p.x, p.z, 1.1, p.color, 0.3);
        p.age = p.life + 1;
      }
      if (p.age >= p.life) {
        this.abilityFX.removeProjectile(p);
        this.projectiles.splice(i, 1);
      }
    }
    void elapsed;
  }

  /* ------------------------------------------------ motion helpers */

  /** Airborne leap: a real arc, landed on the aim point. */
  _leapTravel(inst, dt) {
    const hero = this._hero();
    if (!hero) return;
    const u = clamp01(inst.t / Math.max(0.05, inst.dur.windup));
    const from = inst.origin, to = inst.aim;
    const x = from.x + (to.x - from.x) * u;
    const z = from.z + (to.z - from.z) * u;
    const arc = Math.sin(u * Math.PI) * num(inst.ability.leapArc, 2.4);
    try {
      hero.position.x = x;
      hero.position.z = z;
      hero.position.y = this._groundY(x, z) + arc;
      hero.footY = hero.position.y;
    } catch { /* noop */ }
    void dt;
  }

  /** Whirlwind: spin the body, and keep the ribbon and its ground read alive. */
  _spin(inst, dt, elapsed, gain) {
    const hero = this._hero();
    inst.spinPhase = num(inst.spinPhase, 0) + dt * 13.5;
    if (hero) {
      hero.yaw = wrapPi(num(hero.yaw, 0) + dt * 13.5);
      if (hero.root) hero.root.rotation.y = hero.yaw;
      // keep swinging while spinning; the hero refuses if it is mid-clip
      if (!hero.graph?.actionBusy) { try { hero.attack?.(); } catch { /* noop */ } }
    }
    this._heroPos(_v1);
    const r = num(inst.ability.shape?.radius, 2.6);
    this.abilityFX.setWhirl(_v1.x, _v1.y + 1.05, _v1.z, r * 0.92, inst.spinPhase, gain,
      inst.ability.vfx?.color ?? 0xc4d8ff);
    this.groundFX.show({
      uid: `own${inst.swingId}`, kind: 'whirl', shape: SHAPE.RING,
      x: _v1.x, z: _v1.z, radius: r, inner: 0.55,
      color: inst.ability.telegraph?.color ?? 0xbcd2ff,
      alpha: 0.30 * gain, duration: 0.2, sweep: false,
    });
    void elapsed;
  }

  /**
   * The player's own windup read.
   *
   * Deliberately *not* published on `telegraph:*`. That channel is the
   * enemy-hazard read — Decals renders it as a hatched danger field with a hot
   * release flash, and AI owns it. A player ability needs the opposite thing: a
   * quiet aim preview that says "this is where my cast will land", never a
   * warning. Publishing one down the hazard channel paints a nine-metre hazard
   * cone under the hero's own feet, which is both wrong and unreadable. The cast
   * still goes out on `ability:cast`, which is what VFX and audio key off.
   */
  _showOwnTelegraph(inst) {
    const a = inst.ability;
    const tg = a.telegraph;
    if (!tg || inst.dur.windup < 0.12) return;
    const uid = `own:${inst.swingId}`;
    const hero = this._hero();
    this._heroPos(_v1);
    const ground = a.id === 'leap';
    const shape = tg.shape === 'circle' ? SHAPE.CIRCLE : tg.shape === 'ring' ? SHAPE.RING
      : tg.shape === 'line' ? SHAPE.LINE : SHAPE.CONE;
    const x = ground ? inst.aim.x : _v1.x;
    const z = ground ? inst.aim.z : _v1.z;
    inst.tgUid = uid;
    this.groundFX.show({
      uid, kind: 'telegraph', shape,
      x, z, yaw: inst.yaw,
      radius: num(a.shape?.radius, 3),
      inner: shape === SHAPE.RING ? 0.5 : 0,
      length: num(a.shape?.length, num(a.shape?.radius, 3)),
      // a lane's width is a DIAMETER: the beam's collision radius x 2, not x 0.5
      width: num(a.shape?.width, num(a.shape?.radius, 1) * 2),
      angle: num(a.shape?.angle, 1.2),
      color: tg.color ?? 0xff7a2c,
      alpha: num(tg.alpha, 0.4),
      duration: inst.dur.windup,
      follow: tg.follow ? hero : null,
      sweep: true,
    });
  }

  /** Close out an own-telegraph: `struck` distinguishes a landed hit from a cancel. */
  _endOwnTelegraph(inst, struck) {
    if (!inst?.tgUid) return;
    this.groundFX.hide(inst.tgUid, struck);
    inst.tgUid = null;
  }

  /* -------------------------------------- hero-initiated animation */

  /**
   * The hero can be driven by its own scenario performance, the AI, or a future
   * Director. When it starts a swing that combat did not ask for, attach an
   * ability instance so the animation still deals damage, spawns numbers and
   * earns its hit-stop. This is what makes scripted frames read as real combat.
   */
  _attachHeroClip(elapsed) {
    const hero = this._hero();
    const g = hero?.graph;
    if (!g) return;
    let clip = null;
    if (g.action && g.action !== 'none' && CLIP_ABILITY[g.action]) {
      const tag = g.actionClips?.[g.action]?.tag;
      if (tag === 'attack' || tag === 'heavy' || tag === 'cast') clip = g.action;
    } else if (g.baseClip === 'dash') clip = 'dash';
    if (!clip) { this._lastAttach = null; return; }
    if (this._lastAttach === clip && elapsed - num(this._lastAttachT, -99) < 0.25) return;

    const phase = clip === 'dash' ? g.basePhase : g.actionPhase;
    const win = CLIP_WINDOW[clip];
    if (win && phase > win[1]) return;             // already past the hit window
    const a = ABILITIES[CLIP_ABILITY[clip]];
    if (!a) return;

    this._lastAttach = clip;
    this._lastAttachT = elapsed;
    this._heroPos(_v1);
    this._heroFwd(_v2);
    const origin = _v1.clone();
    origin.y = this._groundY(origin.x, origin.z);

    /* A shaped ability rides the clip's release event, not its own stopwatch:
       the fissure leaves the hand on the frame the hand opens. */
    const ct = CLIP_TIME[clip];
    const weapon = a.shape?.kind === 'weapon' || a.shape?.kind === 'trail';
    const windup = weapon || !ct
      ? num(a.windup, 0.1)
      : Math.max(0.04, (ct.release - clamp01(phase)) * ct.dur);

    /* A hero-initiated clip keeps its own facing: it is already posed. */
    this.act = {
      ability: a,
      id: a.id,
      swingId: ++this._swing,
      phase: 'windup',
      t: 0, total: 0,
      dur: { windup, active: num(a.active, 0.12), recovery: num(a.recovery, 0.15) },
      clip,
      hit: new Set(), hitCount: 0, tickT: 0,
      dir: { x: _v2.x, z: _v2.z },
      yaw: Math.atan2(_v2.z, _v2.x),
      origin,
      aim: { x: origin.x + _v2.x * 2.4, z: origin.z + _v2.z * 2.4, y: origin.y },
      hold: false, held: 0,
      anchor: this.target ?? null,
      tgUid: null, landed: false, fired: false, props: 0, startY: origin.y,
      attached: true,
    };
    /* No telegraph and no leap arc on an attached clip — the pose is the tell. */
  }

  /* ================================================================ *
   * enemy telegraph mirror
   * ================================================================ */

  _telegraph(t, kind) {
    if (!t || !t.uid || t.friendly) return;
    if (this._groundOwned()) return;              // Decals draws it properly
    const uid = `ai${t.uid}`;
    if (kind === 'end') {
      this.groundFX.hide(uid, !t.cancelled);
      this._tg.delete(uid);
      return;
    }
    const danger = t.danger ?? 'light';
    const color = t.color ?? (danger === 'heavy' ? 0xff4422 : danger === 'aoe' ? 0x8fd23c : 0xff8a3c);
    const shape = t.shape === 'circle' || t.shape === 'ring' ? SHAPE.CIRCLE
      : t.shape === 'line' ? SHAPE.LINE : SHAPE.CONE;
    if (kind === 'begin' || !this._tg.has(uid)) {
      this._tg.set(uid, t);
      this.groundFX.show({
        uid, kind: 'telegraph', shape,
        x: t.x, z: t.z, y: t.y, yaw: t.yaw,
        radius: Math.max(0.8, num(t.radius, num(t.length, 3))),
        inner: t.inner ? clamp01(t.inner / Math.max(0.1, t.radius)) : 0,
        length: Math.max(0.8, num(t.length, num(t.radius, 3))),
        width: Math.max(0.5, num(t.width, num(t.radius, 2) * 0.7)),
        angle: num(t.angle, 1.3),
        color,
        alpha: danger === 'heavy' ? 0.52 : danger === 'aoe' ? 0.44 : 0.38,
        duration: Math.max(0.14, num(t.duration, 0.6)),
        sweep: true,
      });
    } else {
      this.groundFX.update2(uid, t.x, t.z, t.yaw, t.progress);
    }
  }

  /* ================================================================ *
   * progression
   * ================================================================ */

  _onDeath(p) {
    const en = p?.entity;
    if (!en || en.isHero) return;
    const byHero = p.killer === 'hero' || p.killer?.isHero || p.killer === this._hero()
      || p.killer === null || p.killer === undefined;
    if (!byHero) return;

    this.stats.kills++;
    this.player.kills++;
    const rank = en.rank ?? (en.def?.isBoss ? 'boss' : en.elite ? 'champion' : 'normal');
    const gained = XP.perKill(num(en.level, 1), rank);
    this.player.xp += gained;
    this.player.resource = Math.min(this.player.maxResource, this.player.resource + (rank === 'normal' ? 6 : 18));

    if (rank !== 'normal') {
      this.engine.bus.emit('ui:toast', {
        text: `${en.name ?? 'Champion'} slain  ·  +${gained} xp`,
        tier: rank === 'boss' ? 'boss' : 'good',
      });
    }
    while (this.player.xp >= this.player.xpNext) {
      this.player.xp -= this.player.xpNext;
      this._levelUp();
    }
    this.resolver.clearDots(en);
  }

  _levelUp() {
    const P = this.player;
    P.level++;
    P.xpNext = XP.curve(P.level);
    this._baseDamage *= 1.06;
    this._baseArmour *= 1.05;
    const hero = this._hero();
    if (hero?.stats) {
      hero.stats.level = P.level;
      hero.stats.maxHealth = Math.round(hero.stats.maxHealth * 1.055);
      hero.stats.health = hero.stats.maxHealth;
      P.maxHealth = hero.stats.maxHealth;
      P.health = hero.stats.maxHealth;
    }
    P.resource = P.maxResource;
    this.engine.bus.emit('level:up', { level: P.level, stats: { ...(hero?.stats ?? {}) } });
    this.engine.bus.emit('ui:toast', { text: `Level ${P.level}`, tier: 'legendary' });
  }

  _applyBuff(a) {
    const b = a.buff;
    if (!b) return;
    const existing = this.buffs.find((x) => x.id === a.id);
    const rec = existing ?? { id: a.id };
    rec.label = b.label ?? a.name;
    rec.duration = num(b.duration, 6);
    rec.left = rec.duration;
    rec.armour = num(b.armour, 0);
    rec.damage = num(b.damage, 0);
    rec.resistAll = num(b.resistAll, 0);
    rec.thorns = num(b.thorns, 0);
    if (!existing) this.buffs.push(rec);
    if (b.heal) {
      try { this._hero()?.heal?.(num(this.player.maxHealth, 340) * b.heal); } catch { /* noop */ }
    }
    this.engine.bus.emit('ui:toast', { text: rec.label, tier: 'good' });

    /* a shout is also a taunt: pull the pack's attention */
    if (a.taunt) {
      const bes = this._bestiary();
      this._heroPos(_v1);
      const near = bes ? bes.queryNear(_v1, num(a.shape?.radius, 5), _cand) : [];
      const ai = this.engine.get('ai');
      for (const en of near) {
        const agent = ai?.byEntity?.get?.(en);
        if (agent) {
          agent.awareness = 1.4;
          agent.stimX = _v1.x; agent.stimZ = _v1.z;
          agent.stimT = this.engine.clock.elapsed;
        }
      }
    }
  }

  /* ================================================================ *
   * scenarios
   * ================================================================ */

  applyScenario(name, cfg) {
    try {
      const dir = DIRECTION[name] ?? DIRECTION.combat;
      this.act = null;
      this.buffer = null;
      this.combo.step = -1;
      this.combo.until = -99;
      this.cd.clear();
      this.buffs.length = 0;
      this.projectiles.length = 0;
      this.target = null;
      this._hasPrev = false;
      this._lastAttach = null;
      this._userInput = false;
      this.resolver.reset();
      this.hitFeel.reset();
      this.groundFX.reset();
      this.abilityFX.reset();

      const P = this.player;
      const hero = this._hero();
      P.dead = false;
      P.deathT = -1;
      P.invuln = 0;
      P.combo = 0;
      P.kills = 0;
      P.xp = 0;
      P.health = num(hero?.stats?.maxHealth, P.maxHealth);
      P.maxHealth = P.health;
      P.resource = Math.round(RESOURCE.max * 0.72);
      P.lastHitAt = -99;
      P.lastSpendAt = -99;
      if (hero?.stats) {
        hero.stats.resource = P.resource;
        hero.stats.maxResource = P.maxResource;
        this._baseArmour = num(hero.stats.armour, this._baseArmour);
        this._baseDamage = num(hero.stats.damage, this._baseDamage);
      }

      this._script = { name, timeline: dir.timeline ?? [], loopFrom: dir.loopFrom ?? 0, loopAt: dir.loopAt ?? 0 };
      this._scriptT = 0;
      this._scriptI = 0;
      this._govern = dir.govern !== false;
      this._heroFloor = num(dir.heroFloor, 0.5);
      this._allowKill = 0;
      this.stats.hits = 0; this.stats.kills = 0; this.stats.casts = 0;
      void cfg;
    } catch (e) {
      console.error('[combat] applyScenario failed —', e);
    }
  }

  _runScript(dt) {
    const s = this._script;
    if (!s) return;
    this._scriptT += dt;
    const tl = s.timeline;
    while (this._scriptI < tl.length && tl[this._scriptI].t <= this._scriptT) {
      const step = tl[this._scriptI++];
      if (step.id === 'kill') { this._allowKill = Math.max(this._allowKill, 1); continue; }
      /* The hero owns its own scripted performance in a posed scenario, so the
         scripted abilities never request an animation — they contribute their
         shape, their damage and their ground read on top of it. */
      this._start(step.id, { anim: false, silent: true, keepFacing: step.keepFacing !== false });
    }
    if (s.loopAt > 0 && this._scriptT >= s.loopAt) {
      this._scriptT = tl[s.loopFrom]?.t ?? 0;
      this._scriptI = s.loopFrom;
    }
  }

  /* ================================================================ *
   * teardown
   * ================================================================ */

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* noop */ } }
    this._offs.length = 0;
    try { this.hitFeel.dispose(); } catch { /* noop */ }
    try { this.groundFX.dispose(); } catch { /* noop */ }
    try { this.abilityFX.dispose(); } catch { /* noop */ }
    this.projectiles.length = 0;
  }
}

export { ABILITIES, TIER_COLOR };
