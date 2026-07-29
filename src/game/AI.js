/**
 * SANCTUM — AI module entry.
 *
 * This file is the *driver*. Every decision-making part already lives in
 * `src/game/ai/*`; AI.js owns the things that can only be done once, centrally,
 * with the whole roster in hand:
 *
 *   roster        wrap Bestiary's bodies in Agents (via EntityAdapter) and retire
 *                 them when the bodies go away
 *   world         build / recentre the NavGrid from terrain + dungeon walkability
 *   target        resolve the hero into a threat record (absent hero => patrol)
 *   director      run the PackDirector so only 2–3 enemies ever hold an attack
 *                 token and the rest orbit at a readable radius
 *   think         tick Perception -> Brain at a distance/visibility LOD cadence
 *   move          resolve every preferred velocity through one RVO pass, integrate
 *                 with per-archetype accel/turn limits, depenetrate, clamp to nav
 *   present       telegraphs, damage resolution, summons, noises, bus events
 *
 * Budgets (the reason 30+ agents are affordable):
 *   - at most `repathPerFrame` A* queries per frame, round-robin, with a shared
 *     node budget; paths are cached in NavGrid and reused for ~1.25 s
 *   - Perception refreshes at most 6 line-of-sight tests per frame
 *   - Brains tick at 1/2/4/8-frame intervals by distance + frustum visibility,
 *     phase-offset per agent so the cost is flat instead of spiky; integration
 *     still runs every frame so motion is smooth at every LOD
 *
 * Determinism: no `Math.random`, no wall clock in the simulation. Every agent's
 * PRNG and noise lane are seeded from `hashStr(stableId)`, so the same scenario
 * and frame count always produce the same frame. `performance.now()` appears
 * only in the cost counters, which are never read back by the sim.
 */

import * as THREE from 'three';

import { NavGrid } from './ai/NavGrid.js';
import { Brain } from './ai/Brain.js';
import { Steering } from './ai/Steering.js';
import { Perception } from './ai/Perception.js';
import { PackDirector } from './ai/PackDirector.js';
import { BossController } from './ai/Boss.js';
import { Agent, ST, ANIM, hashStr } from './ai/Agent.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const NUM = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);

/** LOD interval (frames between brain ticks) per LOD level. */
const LOD_INTERVAL = [1, 2, 4, 8];

/**
 * Canonical AI animation name -> candidate clip names, best first. Bestiary owns
 * the clips; if it advertises which ones exist we pick the closest match here
 * rather than asking it to know about our vocabulary.
 */
const ANIM_ALIAS = {
  idle: ['idle', 'Idle', 'idle_a', 'stand', 'breathe'],
  walk: ['walk', 'Walk', 'walk_fwd', 'walkForward', 'move', 'stride'],
  run: ['run', 'Run', 'sprint', 'charge', 'walk'],
  alert: ['alert', 'notice', 'aggro', 'taunt', 'roar', 'idle'],
  look: ['look', 'look_around', 'search', 'scan', 'idle'],
  attack_windup: ['attack_windup', 'windup', 'attack_start', 'telegraph', 'wind_up', 'attack'],
  attack: ['attack', 'attack_a', 'swing', 'strike', 'melee', 'slash', 'smash'],
  attack_recover: ['attack_recover', 'recover', 'attack_end', 'attack_recovery', 'idle'],
  cast: ['cast', 'cast_a', 'channel', 'conjure', 'attack'],
  summon: ['summon', 'channel', 'cast', 'roar', 'attack'],
  hit: ['hit', 'flinch', 'hurt', 'stagger', 'impact', 'pain'],
  death: ['death', 'die', 'dead', 'collapse'],
  strafe: ['strafe', 'strafe_l', 'sidestep', 'walk_side', 'walk'],
  walk_back: ['walk_back', 'backpedal', 'walk_bwd', 'retreat', 'walk'],
  roar: ['roar', 'shout', 'bellow', 'taunt', 'alert'],
};

/** States in which an agent is committed and must never be de-prioritised. */
const COMMITTED = new Set([ST.WINDUP, ST.STRIKE, ST.RECOVER, ST.SUMMON, ST.PHASE, ST.STAGGER]);

/**
 * Impact kinds that are NOT a hearing stimulus. Locomotion is the important one:
 * a walking pack emits a footfall per step and every one of them would otherwise
 * read as "something is out there".
 */
const IGNORED_IMPACTS = new Set([
  'footfall', 'footstep', 'step', 'land', 'scuff',
  'summon', 'summon_rift', 'dust', 'ambient', 'drip', 'ember', 'rain',
]);

export class AI {
  static id = 'ai';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    /* ---- subsystems (constructed in init) ---- */
    this.nav = null;
    this.navGrid = null;          // public alias, required by the diagnosis API
    this.brain = null;
    this.steering = null;
    this.perception = null;
    this.director = null;

    /* ---- roster ---- */
    this.agents = [];
    this.byEntity = new Map();
    this.byId = new Map();
    this.maxAgents = 72;
    this.maxMeleeTokens = 3;      // global cap: never more than 3 attackers on the hero
    this._idCounter = 0;

    /* ---- target ---- */
    this.threat = {
      x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, radius: 0.42,
      alive: true, entity: null, valid: false,
    };
    this._heroProbe = null;
    this._prevHeroX = 0; this._prevHeroZ = 0; this._prevHeroT = -1;

    /* ---- obstacles handed to the steering pass ---- */
    this.obstacles = [];
    this._heroObstacle = { x: 0, z: 0, radius: 0.5, vx: 0, vz: 0, soft: false };
    this._extraObstacles = [];

    /* ---- pathing budget ---- */
    this.repathPerFrame = 4;
    this.nodeBudgetPerFrame = 2600;
    this._repathQ = [];

    /* ---- telegraphs / deferred hits ---- */
    this._telegraphs = new Map();
    this._tgSeq = 0;
    this._pendingHits = [];
    this._summonQ = [];

    /* ---- lifecycle ---- */
    this.enabled = true;
    this.scenarioName = '';
    this._needsNavRebuild = true;
    this._arranged = false;
    this._arenaHint = null;
    this._heightFn = null;
    this._errors = 0;
    this._offs = [];

    /* ---- LOD scratch ---- */
    this._frustum = new THREE.Frustum();
    this._pv = new THREE.Matrix4();
    this._camInv = new THREE.Matrix4();
    this._sphere = new THREE.Sphere();
    this._camPos = new THREE.Vector3();

    /* ---- debug overlay ---- */
    this.debug = false;
    this._dbg = null;

    this.stats = {
      agents: 0, thinking: 0, tokens: 0, circling: 0, attacking: 0,
      repaths: 0, deferred: 0, ms: 0, msPeak: 0, msAvg: 0,
    };
    this._ctx = { ai: this, nav: null, threat: null, elapsed: 0, dt: 1 / 60, frame: 0 };
  }

  /* ================================================================== *
   * lifecycle
   * ================================================================== */

  async init() {
    const q = this.engine.quality ?? {};
    const tier = q.tier ?? 'high';
    const cell = tier === 'low' ? 0.68 : 0.55;
    const span = tier === 'low' ? 96 : 116;

    this.nav = new NavGrid(this.engine, { cell, span });
    this.navGrid = this.nav;
    this.steering = new Steering(this.engine, this.nav);
    // Perception gets a *sight* view of the world, not the walkability view.
    this.perception = new Perception(this.engine, this._makeSightGrid());
    this.brain = new Brain(this);
    this.director = new PackDirector(this);
    this._ctx.nav = this.nav;

    if (tier === 'low') { this.repathPerFrame = 2; this.nodeBudgetPerFrame = 1400; this.perception.losBudget = 4; }
    else if (tier === 'med') { this.repathPerFrame = 3; this.nodeBudgetPerFrame = 2000; this.perception.losBudget = 5; }
    else { this.perception.losBudget = 6; }

    this._resolveHeightFn();
    this.nav.rebuild(0, 0);
    this._needsNavRebuild = false;

    const bus = this.engine.bus;
    const on = (evt, fn) => this._offs.push(bus.on(evt, fn));
    on('scenario', (p) => this._onScenario(p?.name ?? '', p?.cfg ?? null));
    on('damage', (p) => this._onDamage(p));
    on('death', (p) => this._onDeath(p));
    on('impact', (p) => this._onImpact(p));
    on('ability:cast', (p) => this._onAbilityCast(p));
    on('ai:noise', (p) => {
      if (!p) return;
      this.perception?.pushNoise(p.x ?? 0, p.y ?? 0, p.z ?? 0, p.loudness ?? 1, p.faction ?? 'player');
    });
    on('ai:obstacle', (p) => this.addObstacle(p));
    on('ai:debug', (p) => this.debugDraw(p?.enable !== false));
    on('boss:arena', (p) => {
      if (!p) return;
      const x = NUM(p.x), z = NUM(p.z), r = NUM(p.r ?? p.radius);
      if (x == null || z == null || r == null) return;
      this._arenaHint = { x, z, r };
      for (const a of this.agents) a.boss?.setArena(x, z, r);
    });
  }

  /** Integrator calls this before the 'scenario' bus event; both routes are safe. */
  async applyScenario(name, cfg) {
    this._onScenario(name, cfg);
  }

  _onScenario(name, cfg) {
    if (this._scenarioAt === this.engine.clock.frame && this.scenarioName === name) return;
    this._scenarioAt = this.engine.clock.frame;
    this.scenarioName = name || '';

    // The world itself changed: retire every body-bound agent, drop cached paths
    // and stamped obstacles, and rebuild the nav tile from the new geometry.
    for (const a of this.agents) a.dispose();
    this.agents.length = 0;
    this.byEntity.clear();
    this.byId.clear();
    this._repathQ.length = 0;
    this._telegraphs.clear();
    this._pendingHits.length = 0;
    this._summonQ.length = 0;
    this._extraObstacles.length = 0;
    this._idCounter = 0;
    this._arranged = false;
    this._arenaHint = null;
    this._heroProbe = null;
    this._prevHeroT = -1;
    this._engagedOnce = false;
    this._pockets = null;
    this.stats.msPeak = 0;
    this.director?.dispose();
    this.perception?.dispose();
    this.nav?.clearObstacles();
    this._resolveHeightFn();
    this._needsNavRebuild = true;

    const target = cfg?.camera?.target;
    this._navCentre = Array.isArray(target) ? { x: target[0] ?? 0, z: target[2] ?? 0 } : { x: 0, z: 0 };
  }

  /**
   * Perception must not ask "can I walk there?" — it must ask "can I see there?".
   *
   * Handing Perception the raw walkability grid fails badly in both directions,
   * and both failures were observed here:
   *
   *  - Outdoors, lava, water and a 40° scree slope are all unwalkable and none of
   *    them block a sightline. A pack staring across an open moor reported no
   *    line of sight and cycled alert -> investigate -> patrol forever.
   *  - Indoors it is not simply "blocked cells are the walls" either. A dungeon
   *    marks its dais steps, rubble and pits unwalkable too, and a knee-high step
   *    does not hide a 1.85 m hero. The boss stood 7 m from the player inside its
   *    own arena and never noticed it.
   *
   * So sight gets its own model, and it uses the two signals that actually mean
   * occlusion:
   *   1. floor height — march the eye-to-chest ray against the dungeon floor /
   *      heightfield and see whether the ground rises through it. This is what
   *      correctly ignores a low step and correctly stops at a ridge.
   *   2. contiguous blockage — a wall is *thick*. A run of blocked cells longer
   *      than ~1.1 m along the ray is masonry; one or two cells is furniture.
   */
  _makeSightGrid() {
    const nav = this.nav;
    const self = this;
    return {
      get built() { return nav.built; },
      get cell() { return nav.cell; },
      clearanceAt: (x, z) => nav.clearanceAt(x, z),
      isFree: (x, z, r) => nav.isFree(x, z, r),
      lineOfSight: (ax, az, bx, bz) => !self._sightBlocked(ax, az, bx, bz),
    };
  }

  _sightBlocked(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1.2) return false;
    const H = this._heightFn;
    const nav = this.nav;
    const navOk = !!(nav && nav.built);
    if (!H && !navOk) return false;

    const eye = (H ? H(ax, az) : 0) + 1.55;
    const tgt = (H ? H(bx, bz) : 0) + 1.05;
    const n = Math.min(140, Math.max(3, Math.ceil(len / 0.5)));
    const segLen = len / n;

    // Occlusion is something *between* the two points. Blockage that starts at
    // the viewer's own feet is not a wall in the way, it is a body standing on
    // ground the grid calls impassable — which happens constantly, because a
    // 2.35 m boss placed on a dais lip or a hair outside an arena footprint sits
    // in blocked cells while having a perfectly clear view. Counting that as a
    // wall blinded the boss inside its own arena. So ignore any run before the
    // ray first reaches open space, and require an interior run to be closed off
    // by open space on the far side too.
    let run = 0;
    let sawFree = false;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = ax + dx * t, z = az + dz * t;
      if (H && H(x, z) > eye + (tgt - eye) * t + 0.35) return true;
      if (!navOk) continue;
      if (nav.isFree(x, z, 0.1)) {
        if (sawFree && run >= 1.15) return true;      // masonry, both sides open
        run = 0;
        sawFree = true;
      } else if (sawFree) {
        // An unbounded run still counts once it is far too thick to be furniture
        // or a placement error.
        if ((run += segLen) >= 2.4) return true;
      }
    }
    return false;
  }

  /** Back-compat alias used by diagnostics. */
  _terrainSight(ax, az, bx, bz) { return !this._sightBlocked(ax, az, bx, bz); }

  _resolveHeightFn() {
    const terrain = this._mod('terrain');
    const dungeon = this._mod('dungeon');
    const fns = [];
    if (dungeon) {
      // An interior floor is built *on top of* the heightfield, so when a dungeon
      // is active its floor is the authoritative ground — using terrain height
      // inside a crypt or an arena puts phantom ridges through the room (the hell
      // biome swings ±5 m under a dais that is dead flat, which is enough to
      // occlude every sightline in the boss arena). Outside its own scenarios the
      // dungeon reports `active === false` and answers 0 for the whole world, so
      // return NaN there and let terrain answer instead.
      for (const k of ['floorHeightAt', 'floorAt', 'groundAt', 'heightAt']) {
        if (typeof dungeon[k] !== 'function') continue;
        fns.push((x, z) => (dungeon.active === false ? NaN : dungeon[k](x, z)));
        break;
      }
    }
    if (terrain && typeof terrain.heightAt === 'function') fns.push((x, z) => terrain.heightAt(x, z));
    if (!fns.length) { this._heightFn = null; return; }
    this._heightFn = (x, z) => {
      for (let i = 0; i < fns.length; i++) {
        try {
          const h = fns[i](x, z);
          if (Number.isFinite(h)) return h;
        } catch { /* try the next source */ }
      }
      return 0;
    };
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* ignore */ } }
    this._offs.length = 0;
    for (const a of this.agents) a.dispose();
    this.agents.length = 0;
    this.byEntity.clear();
    this.byId.clear();
    this.director?.dispose();
    this.perception?.dispose();
    this.nav?.dispose();
    this._disposeDebug();
  }

  /* ================================================================== *
   * per-frame
   * ================================================================== */

  update(dt, elapsed) {
    if (!this.enabled || this.__dead) return;
    const t0 = _now();
    try {
      this._update(dt, elapsed);
    } catch (e) {
      if (++this._errors <= 3) console.error('[ai] frame error —', e);
      if (this._errors > 40) { this.enabled = false; console.error('[ai] disabled after repeated errors'); }
    }
    const ms = _now() - t0;
    this.stats.ms = ms;
    this.stats.msAvg = this.stats.msAvg * 0.92 + ms * 0.08;
    if (ms > this.stats.msPeak) this.stats.msPeak = ms;
  }

  _update(dt, elapsed) {
    const frame = this.engine.clock.frame;

    this._readThreat(dt, elapsed);
    this._syncRoster();
    this._ensureNav();
    this._buildObstacles();

    const agents = this.agents;
    const ctx = this._ctx;
    ctx.elapsed = elapsed;
    ctx.dt = dt;
    ctx.frame = frame;
    ctx.threat = this.threat.valid ? this.threat : null;

    if (!agents.length) {
      this._flushStats(0, 0, 0, 0);
      if (this.debug) this._debugUpdate();
      return;
    }

    // First frames after a spawn: fix a stacked or gridded layout before it is
    // ever seen. PackDirector only acts if the layout is actually bad.
    if (!this._arranged && this.nav.built) {
      this._arranged = true;
      try {
        this.director.arrangeSpawn(agents, {
          seed: 7717 + (hashStr(this.scenarioName || 'combat') & 0xffff),
          facing: this.threat.valid ? Math.atan2(this.threat.z, this.threat.x) : 0,
        });
      } catch (e) { console.warn('[ai] arrangeSpawn —', e.message); }
    }

    /* ---- read bodies, refresh LOD ---- */
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.pvx = a.vx; a.pvz = a.vz;
      a.syncFromEntity();
      if (a.globalCd > 0) a.globalCd = Math.max(0, a.globalCd - dt);
      this._applyLungeSpeed(a);
      if (a.boss) {
        if (!a.hasToken && !a.dead) this.grantToken(a);
        if (!a.__arenaFixed && this.threat.valid) {
          // The arena could not be sized before the hero existed; do it once now.
          a.__arenaFixed = true;
          const A = this._arenaHint ?? this._dungeonArena() ?? this._inferArena(a);
          a.boss.setArena(A.x, A.z, A.r);
        }
      }
    }
    this._refreshLod(frame);

    /* ---- perception (budgeted LOS inside) ---- */
    // Keep every agent's line-of-sight answer inside Perception's 0.22 s cache
    // window whatever the roster size, or a big pack starts forgetting the hero.
    this.perception.losBudget = clamp(Math.ceil(agents.length / 4), 4, 14);
    this.perception.update(agents, ctx.threat, dt);
    this._scatterStimuli(agents);

    /* ---- encounter direction: attack tokens + ring slots ---- */
    this.director.update(agents, ctx.threat, dt, elapsed);

    /* ---- think ---- */
    this.nav.nodeBudget = this.nodeBudgetPerFrame;
    let thinking = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.active) continue;
      const interval = LOD_INTERVAL[a.lod] ?? 1;
      const due = a.dead
        ? a.state !== ST.DEAD
        : ((frame + a.tickPhase) % interval === 0) || a.lastTickFrame < 0;
      if (!due) continue;
      const dtEff = a.lastTickFrame < 0 ? dt : clamp((frame - a.lastTickFrame) * dt, dt, dt * 10);
      a.lastTickFrame = frame;
      thinking++;

      ctx.threat = this._threatFor(a);
      if (a.boss) { try { a.boss.update(a, ctx, dtEff); } catch (e) { this._agentError(a, e); } }
      try {
        this.brain.tick(a, ctx, dtEff);
      } catch (e) {
        this._agentError(a, e);
        a.prefX = 0; a.prefZ = 0;
      }
      this._postBrain(a, ctx, dtEff);
      // The tick may have entered STRIKE; re-arm the speed ceiling now so the
      // very first frame of a lunge is not clipped to walking pace.
      this._applyLungeSpeed(a);
      if (a.staggerFor > 0 && a.state !== ST.STAGGER) a.staggerFor = 0;
    }
    ctx.threat = this.threat.valid ? this.threat : null;

    /* ---- service the path queue (bounded) ---- */
    this._servicePaths(elapsed);

    /* ---- steer + integrate every frame, so LOD never shows as stutter ---- */
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.active) continue;
      if (a.dead) { a.vx = 0; a.vz = 0; continue; }
      if (a.lod <= 1 || (frame + a.tickPhase) % 2 === 0) {
        this.steering.resolve(a, agents, this.obstacles, dt);
      }
      this._integrate(a, dt);
    }

    this.steering.depenetrate(agents, this.obstacles, 2);

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.active || a.dead) continue;
      this.steering.clampToNav(a);
      this._stuckCheck(a, dt, elapsed);
    }

    /* ---- write back to the bodies ---- */
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.active) continue;
      this._writeAgent(a, dt);
    }

    this._resolvePendingHits(elapsed);
    this._serviceSummons();
    this._flushStats(thinking, 0, 0, 0);
    if (this.debug) this._debugUpdate();
  }

  /**
   * A noise gives every agent that heard it the *same* stimulus point, and a
   * dozen bodies walking to one coordinate is the most obvious "they are all
   * running the same script" tell there is. Push each agent's investigate target
   * onto its own stable offset so the pack sweeps an area instead of funnelling.
   * Agents that can actually see the target keep the exact point.
   */
  _scatterStimuli(agents) {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.heardRecently) continue;
      a.heardRecently = false;
      if (a.canSeeTarget || a.dead || !a.active) continue;
      const spread = 1.6 + Math.min(3.2, agents.length * 0.12);
      a.stimX += (hashUnit(a.seed) - 0.5) * 2 * spread;
      a.stimZ += (hashUnit(a.seed ^ 0x9e3779b9) - 0.5) * 2 * spread;
    }
  }

  _agentError(agent, e) {
    if (++agent.__failures <= 1) console.error(`[ai:${agent.id}] ${agent.state} —`, e);
    if (agent.__failures > 6) { agent.active = false; }
  }

  _flushStats(thinking) {
    const s = this.stats;
    s.agents = this.agents.length;
    s.thinking = thinking;
    let tokens = 0, circling = 0, attacking = 0;
    for (const a of this.agents) {
      if (a.dead) continue;
      if (a.hasToken) tokens++;
      if (a.state === ST.CIRCLE || a.state === ST.KITE || a.state === ST.SEEK_LOS) circling++;
      if (a.state === ST.WINDUP || a.state === ST.STRIKE || a.state === ST.RECOVER || a.state === ST.SUMMON) attacking++;
    }
    s.tokens = tokens; s.circling = circling; s.attacking = attacking;
    s.repaths = this.nav ? this.nav.stats.astar : 0;
    s.deferred = this.nav ? this.nav.stats.deferred : 0;
  }

  /* ================================================================== *
   * roster
   * ================================================================== */

  /** Iterate whatever container Bestiary chose to publish. */
  * _entities() {
    const b = this._mod('bestiary');
    if (!b) return;
    const src = b.entities ?? b.list ?? b.all ?? b.monsters ?? b.actors;
    if (!src) return;
    if (Array.isArray(src)) { for (let i = 0; i < src.length; i++) if (src[i]) yield src[i]; return; }
    if (src instanceof Map) { for (const v of src.values()) if (v) yield v; return; }
    if (typeof src[Symbol.iterator] === 'function') { for (const v of src) if (v) yield v; return; }
    if (typeof src === 'object') { for (const k in src) { const v = src[k]; if (v && typeof v === 'object') yield v; } }
  }

  _syncRoster() {
    const seen = this._seen ?? (this._seen = new Set());
    seen.clear();
    for (const e of this._entities()) {
      if (this._skipEntity(e)) continue;
      seen.add(e);
      if (!this.byEntity.has(e)) {
        if (this.agents.length >= this.maxAgents) continue;
        this._makeAgent(e);
      }
    }
    // Retire agents whose bodies left the roster.
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      if (a.entity && seen.has(a.entity)) continue;
      this._retire(a, i);
    }
  }

  _skipEntity(e) {
    if (!e || typeof e !== 'object') return true;
    if (e.aiDisabled === true || e.noAI === true || e.aiExternal === true) return true;
    const f = e.faction;
    if (f === 'player' || f === 'hero') return true;
    return false;
  }

  _retire(agent, index) {
    if (agent.telegraph) this.endTelegraph(agent, true);
    this.releaseToken(agent);
    if (agent.boss) { try { agent.boss.dispose(); } catch { /* ignore */ } agent.boss = null; }
    this.byEntity.delete(agent.entity);
    this.byId.delete(agent.id);
    const qi = this._repathQ.indexOf(agent);
    if (qi >= 0) this._repathQ.splice(qi, 1);
    agent.dispose();
    this.agents.splice(index, 1);
  }

  _stableId(entity) {
    let base = entity.aiId ?? entity.id ?? entity.uuid ?? entity.name
      ?? entity.root?.uuid ?? entity.group?.uuid ?? null;
    if (typeof base !== 'string' || !base) base = `body${this._idCounter++}`;
    let id = base;
    let n = 1;
    while (this.byId.has(id)) id = `${base}#${n++}`;
    try { entity.aiId = id; } catch { /* frozen entity: fine, we keep our copy */ }
    return id;
  }

  _makeAgent(entity) {
    let agent;
    try {
      agent = new Agent(this.engine, entity);
    } catch (e) {
      console.warn('[ai] could not wrap entity —', e.message);
      return null;
    }

    // Re-seed from the stable id alone so nothing depends on construction order.
    const id = this._stableId(entity);
    agent.id = id;
    const seed = hashStr(id);
    agent.seed = seed;
    agent.rnd = this.engine.freshRand(seed);
    agent.lane = (seed % 977) * 0.7139;
    agent.flankSign = (seed & 1) ? 1 : -1;
    agent.slotAngle = ((seed >>> 3) % 1000) / 1000 * TAU;
    agent.tickPhase = seed % 8;

    /* ---- fields the Brain reads but Agent does not pre-declare ---- */
    agent.staggerFor = 0;
    agent.fleeSpent = false;
    agent.enraged = false;
    agent.damageMul = 1;
    agent.ringRadius = 0;
    agent.turnScale = 1;
    agent.pathVersion = -1;
    agent.deathDone = false;
    agent.phaseDone = false;
    agent.repositionTo = null;
    agent.repositionUntil = 0;
    agent.aimX = undefined;
    agent.aimZ = undefined;
    agent.losSpotX = undefined;
    agent.losSpotZ = undefined;
    agent.losSpotT = -99;
    agent.fleeX = undefined;
    agent.fleeZ = undefined;
    agent.lookBase = agent.yaw;
    agent.repathGoalX = agent.px;
    agent.repathGoalZ = agent.pz;
    agent.repathAsked = -1;
    agent.lastTickFrame = -1;
    agent.lastSummonT = -99;
    agent.summonCount = 0;
    agent.reachRange = this._reachOf(agent);
    agent.hitFlashT = -99;
    agent.stuckHits = 0;

    // Ground it immediately so frame 0 never shows a floating body.
    if (this._heightFn && !agent.adapter.ownsVertical) {
      const h = this._heightFn(agent.px, agent.pz);
      if (Number.isFinite(h)) agent.py = h + (agent.adapter.groundOffset || 0);
    }
    agent.homeX = agent.px; agent.homeZ = agent.pz;
    agent.wanderX = agent.px; agent.wanderZ = agent.pz;
    agent.setState(ST.SPAWN, 0.15 + agent.rnd() * 0.5);

    agent.__clipSet = this._clipSet(entity);

    if (agent.arch.isBoss) {
      try {
        agent.boss = new BossController(this, agent);
        const explicit = this._arenaHint ?? this._dungeonArena();
        const A = explicit ?? this._inferArena(agent);
        agent.boss.setArena(A.x, A.z, A.r);
        agent.__arenaFixed = !!explicit;
        agent.maxSpeed = agent.arch.speed * agent.boss.speedMul;
        // A boss is its own encounter: it never queues behind the pack for the
        // right to attack, so it holds a permanent token from its own pool.
        this.grantToken(agent);
      } catch (e) {
        console.warn('[ai] boss controller —', e.message);
        agent.boss = null;
      }
    }

    this.agents.push(agent);
    this.byEntity.set(entity, agent);
    this.byId.set(id, agent);
    return agent;
  }

  _reachOf(agent) {
    const list = agent.arch.attacks;
    let best = 1.5;
    if (Array.isArray(list) && list.length) {
      best = list[0].range ?? 1.5;
      for (let i = 1; i < list.length; i++) if ((list[i].range ?? 99) < best) best = list[i].range;
    }
    return best + agent.radius * 0.35;
  }

  /**
   * Which animation clip names does this body actually own?
   *
   * Only consulted for bodies that have no `setAnimState`-style hook, i.e. ones
   * the adapter can only talk to by assigning `entity.animState`. A body that
   * owns an animation entry point owns its own naming too — Bestiary, for one,
   * has its own canonical fallback chain and keys attack-telegraph variants off
   * the exact string `attack_windup`, so re-mapping names here would quietly
   * strip its variety.
   */
  _clipSet(entity) {
    if (typeof entity.setAnimState === 'function' || typeof entity.playAnim === 'function') return null;
    const probe = entity.clips ?? entity.anim?.clips ?? entity.animGraph?.clips
      ?? entity.graph?.clips ?? entity.clipNames ?? entity.states ?? null;
    if (!probe) return null;
    const set = new Set();
    if (Array.isArray(probe)) { for (const c of probe) if (typeof c === 'string') set.add(c); else if (c?.name) set.add(c.name); }
    else if (probe instanceof Map) { for (const k of probe.keys()) if (typeof k === 'string') set.add(k); }
    else if (typeof probe === 'object') { for (const k in probe) set.add(k); }
    return set.size ? set : null;
  }

  _resolveAnim(agent, name) {
    const set = agent.__clipSet;
    if (!set) return name;
    if (set.has(name)) return name;
    const list = ANIM_ALIAS[name];
    if (list) for (let i = 0; i < list.length; i++) if (set.has(list[i])) return list[i];
    return name;
  }

  /**
   * Arena inference when nobody declared one.
   *
   * BossController.inferArena() probes outward from the boss's own feet, which is
   * right when the boss starts in the middle of its room and wrong when it starts
   * at the edge — containment would then pin it a few metres from its spawn and
   * the fight could never begin. So centre on the *encounter* (the midpoint of
   * boss and hero, or the scenario's camera target), probe the walkable footprint
   * from there, and guarantee the radius always contains both bodies.
   */
  _inferArena(agent) {
    let cx, cz;
    if (this.threat.valid) { cx = (this.threat.x + agent.px) * 0.5; cz = (this.threat.z + agent.pz) * 0.5; }
    else { cx = this._navCentre?.x ?? 0; cz = this._navCentre?.z ?? 0; }
    const nav = this.nav;
    let minR = 44;
    if (nav && nav.built) {
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * TAU, ux = Math.cos(ang), uz = Math.sin(ang);
        let r = 2.5;
        while (r < 44) { if (!nav.isFree(cx + ux * r, cz + uz * r, agent.radius)) break; r += 0.9; }
        if (r < minR) minR = r;
      }
    }
    const contain = Math.max(
      Math.hypot(agent.px - cx, agent.pz - cz),
      this.threat.valid ? Math.hypot(this.threat.x - cx, this.threat.z - cz) : 0,
    ) + agent.radius + 7;
    return { x: cx, z: cz, r: clamp(Math.max(minR * 0.92, contain), 14, 34) };
  }

  /**
   * The dungeon owns the room the boss fights in, so ask it first. Probes the
   * shapes an arena builder plausibly publishes: an explicit centre+radius, a
   * bounds rectangle, or a declared boss spawn point.
   */
  _dungeonArena() {
    const d = this._mod('dungeon');
    if (!d) return null;
    let a = d.arena ?? d.bossArena ?? null;
    if (!a && typeof d.getArena === 'function') { try { a = d.getArena(); } catch { a = null; } }

    for (const src of [a, a?.bounds, d.bounds]) {
      if (!src || typeof src !== 'object') continue;
      const x = NUM(src.x ?? src.cx ?? src.centerX);
      const z = NUM(src.z ?? src.cz ?? src.centerZ);
      if (x == null || z == null) continue;
      let r = NUM(src.r ?? src.radius ?? src.outer ?? src.inradius);
      if (r == null) {
        const w = NUM(src.w ?? src.width), dd = NUM(src.d ?? src.depth ?? src.h ?? src.height);
        if (w != null && dd != null) r = Math.min(w, dd) * 0.5 * 0.88;
      }
      if (r == null || r <= 4) continue;
      return { x, z, r: clamp(r, 9, 40) };
    }

    // Fall back to a declared boss spawn: the room is centred on it by convention.
    if (typeof d.spawnPoints === 'function') {
      try {
        const pts = d.spawnPoints('boss');
        if (Array.isArray(pts) && pts.length && Number.isFinite(pts[0]?.x)) {
          return { x: pts[0].x, z: pts[0].z, r: 18 };
        }
      } catch { /* no arena info */ }
    }
    return null;
  }

  /* ================================================================== *
   * target acquisition
   * ================================================================== */

  _readThreat(dt, elapsed) {
    const t = this.threat;
    const hero = this._mod('hero');
    if (!hero) { t.valid = false; t.entity = null; return; }

    if (!this._heroProbe || this._heroProbe.mod !== hero) this._heroProbe = this._probeHero(hero);
    const p = this._heroProbe;
    const pos = p.pos ? p.pos() : null;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) { t.valid = false; return; }

    t.x = pos.x; t.z = pos.z;
    t.y = Number.isFinite(pos.y) ? pos.y : (this._heightFn ? this._heightFn(pos.x, pos.z) : 0);
    t.radius = p.radius ?? 0.42;
    t.entity = p.entity ?? hero;

    // Velocity from finite difference on the fixed timestep — no wall clock.
    if (this._prevHeroT >= 0 && dt > 1e-6) {
      const nvx = (t.x - this._prevHeroX) / dt;
      const nvz = (t.z - this._prevHeroZ) / dt;
      t.vx = t.vx * 0.6 + nvx * 0.4;
      t.vz = t.vz * 0.6 + nvz * 0.4;
    } else { t.vx = 0; t.vz = 0; }
    this._prevHeroX = t.x; this._prevHeroZ = t.z; this._prevHeroT = elapsed;
    if (p.vel) {
      const v = p.vel();
      if (v && Number.isFinite(v.x) && Number.isFinite(v.z)) { t.vx = v.x; t.vz = v.z; }
    }
    t.speed = Math.hypot(t.vx, t.vz);
    t.alive = p.alive ? p.alive() !== false : true;
    t.valid = true;

    // The hero's footsteps are what a patrolling pack hears — but a noise costs
    // more than it looks. Perception saturates hearing-only awareness at 0.92,
    // which is *below* the 0.98 that confirms a target, so a footstep arriving
    // every few frames actively holds back an agent that is already looking at
    // the hero. Only broadcast when somebody who cannot see the hero is close
    // enough to hear it; then the noise does the job it exists for and nothing else.
    if (t.alive && t.speed > 1.4 && (elapsed - (this._stepAt ?? -9)) > 0.5) {
      let useful = false;
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i];
        if (a.dead || !a.active || a.canSeeTarget) continue;
        const dx = a.px - t.x, dz = a.pz - t.z;
        const reach = a.arch.hearing * 1.2;
        if (dx * dx + dz * dz <= reach * reach) { useful = true; break; }
      }
      if (useful) {
        this._stepAt = elapsed;
        this.perception.pushNoise(t.x, t.y, t.z, sat(t.speed / 5) * 0.85 + 0.25, 'player');
      }
    }
  }

  _probeHero(hero) {
    const cand = [hero, hero.entity, hero.actor, hero.player, hero.body].filter((o) => o && typeof o === 'object');
    const out = { mod: hero, entity: hero, pos: null, vel: null, alive: null, radius: 0.42 };
    for (const o of cand) {
      const p = o.position ?? o.root?.position ?? o.group?.position ?? o.mesh?.position ?? o.model?.position;
      if (p && typeof p.x === 'number' && typeof p.z === 'number') {
        out.pos = () => p;
        out.entity = o;
        const r = NUM(o.radius) ?? NUM(o.collisionRadius);
        if (r) out.radius = r;
        const v = o.velocity ?? o.vel;
        if (v && typeof v.x === 'number') out.vel = () => v;
        if (typeof o.dead === 'boolean') out.alive = () => !o.dead;
        else if (typeof o.alive === 'boolean') out.alive = () => o.alive;
        else if (typeof o.hp === 'number') out.alive = () => o.hp > 0;
        break;
      }
      if (typeof o.getPosition === 'function') {
        out.pos = () => { try { return o.getPosition(); } catch { return null; } };
        out.entity = o;
        break;
      }
      if (typeof o.px === 'number' && typeof o.pz === 'number') {
        out.pos = () => ({ x: o.px, y: o.py ?? 0, z: o.pz });
        out.entity = o;
        break;
      }
    }
    return out;
  }

  /** Per-agent threat: only hostile factions chase the hero. */
  _threatFor(agent) {
    if (!this.threat.valid) return null;
    const f = agent.faction;
    if (f && f !== 'enemy' && f !== 'monster' && f !== 'undead' && f !== 'hostile') return null;
    return this.threat;
  }

  /* ================================================================== *
   * nav
   * ================================================================== */

  _ensureNav() {
    const nav = this.nav;
    if (!nav) return;
    let cx, cz;
    if (this.threat.valid) { cx = this.threat.x; cz = this.threat.z; }
    else if (this.agents.length) {
      cx = 0; cz = 0;
      for (const a of this.agents) { cx += a.px; cz += a.pz; }
      cx /= this.agents.length; cz /= this.agents.length;
    } else { cx = this._navCentre?.x ?? 0; cz = this._navCentre?.z ?? 0; }

    if (this._needsNavRebuild || !nav.built) {
      this._needsNavRebuild = false;
      nav.rebuild(cx, cz);
      for (const a of this.agents) { a.clearPath(); a.pathVersion = -1; }
      this._rescueNav(cx, cz);
      return;
    }
    if (nav.ensureCovers(cx, cz, 18)) this._rescueNav(cx, cz);
    else if ((this.engine.clock.frame & 31) === 0) this._rescueNav(cx, cz);
  }

  /**
   * Self-heal an encounter standing on ground the heightfield calls unwalkable.
   *
   * Terrain's biome masks can exclude large regions for reasons that have nothing
   * to do with slope — the `hell` biome, for instance, marks its whole central
   * basin as fissure. If the scenario then places the hero and a pack inside that
   * region, every agent's path fails, the steering pass vetoes every candidate
   * velocity against the static field, and the fight renders as a set of frozen
   * statues. Refusing to move is technically obedient and visually broken.
   *
   * So: if the encounter centre is blocked but the terrain there is demonstrably
   * flat, carve a slope-validated walkable pocket and log it once. The pocket is
   * a persistent nav stamp, so it survives tile recentres, and the whole thing
   * disappears the moment Terrain's mask agrees with reality.
   */
  _rescueNav(cx, cz) {
    const nav = this.nav;
    if (!nav || !nav.built) return;
    if (nav.isFree(cx, cz, 0.55)) return;
    const pockets = this._pockets ?? (this._pockets = []);
    for (let i = 0; i < pockets.length; i++) {
      const p = pockets[i];
      if (Math.hypot(cx - p.x, cz - p.z) < p.r * 0.55) return;    // already covered
    }
    if (pockets.length >= 6) return;

    const r = this._pocketRadius(cx, cz, 16);
    if (r < 4) return;                                            // genuinely broken ground
    pockets.push({ x: cx, z: cz, r });
    nav.addObstacle(cx, cz, r, false);
    for (const a of this.agents) { a.clearPath(); a.pathVersion = -1; }
    console.info(`[ai] carved a ${r.toFixed(1)} m walkable pocket at (${cx.toFixed(1)}, ${cz.toFixed(1)}) — `
      + `terrain reports this ground unwalkable but the encounter is standing on it`);
  }

  /** Largest radius around a point over which the terrain stays gently sloped. */
  _pocketRadius(cx, cz, maxR) {
    const terrain = this._mod('terrain');
    const slopeAt = terrain && typeof terrain.slopeAt === 'function' ? terrain : null;
    if (!slopeAt) return maxR;
    let best = maxR;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * TAU, ux = Math.cos(ang), uz = Math.sin(ang);
      for (let d = 1; d <= maxR; d += 1) {
        let s = 0;
        try { s = slopeAt.slopeAt(cx + ux * d, cz + uz * d); } catch { s = 0; }
        if (s > 0.62) { if (d - 1 < best) best = d - 1; break; }
      }
    }
    return best;
  }

  /** Stamp a permanent circular blocker (props, hazards) into the nav grid. */
  addObstacle(p) {
    if (!p || !this.nav) return;
    const x = NUM(p.x), z = NUM(p.z), r = NUM(p.r ?? p.radius);
    if (x == null || z == null || r == null || r <= 0) return;
    if (p.dynamic) {
      if (this._extraObstacles.length < 48) {
        this._extraObstacles.push({ x, z, radius: r, vx: 0, vz: 0, soft: p.soft === true });
      }
      return;
    }
    this.nav.addObstacle(x, z, r, p.blocked !== false);
  }

  _buildObstacles() {
    const list = this.obstacles;
    list.length = 0;
    if (this.threat.valid && this.threat.alive) {
      const h = this._heroObstacle;
      h.x = this.threat.x; h.z = this.threat.z;
      h.radius = this.threat.radius;
      h.vx = this.threat.vx; h.vz = this.threat.vz;
      list.push(h);
    }
    for (let i = 0; i < this._extraObstacles.length; i++) list.push(this._extraObstacles[i]);
  }

  /* ---- path requests ---- */

  requestRepath(agent, tx, tz, priority = 1) {
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
    agent.repathGoalX = tx;
    agent.repathGoalZ = tz;
    if (agent.repathQueued) {
      if (priority > agent.repathPriority) agent.repathPriority = priority;
      return;
    }
    agent.repathQueued = true;
    agent.repathPriority = priority;
    agent.repathAsked = this.engine.clock.frame;
    this._repathQ.push(agent);
  }

  _servicePaths(elapsed) {
    const q = this._repathQ;
    if (!q.length) return;
    const nav = this.nav;
    // Deterministic order: priority, then who has waited longest, then id hash.
    q.sort((a, b) => (b.repathPriority - a.repathPriority)
      || (a.repathAsked - b.repathAsked)
      || (a.seed - b.seed));

    let served = 0;
    while (q.length && served < this.repathPerFrame) {
      const a = q[0];
      if (!a.active || a.dead) { q.shift(); a.repathQueued = false; continue; }
      if (nav.nodeBudget <= 0) break;
      const status = nav.findPath(a.px, a.pz, a.repathGoalX, a.repathGoalZ, a.radius * 1.04, a.path);
      if (status === 'deferred') break;                // out of budget: keep the request
      q.shift();
      a.repathQueued = false;
      a.pathAt = elapsed;
      a.pathVersion = nav.version;
      a.pathStatus = status;
      a.pathCursor = 0;
      a.pathGoalX = a.repathGoalX;
      a.pathGoalZ = a.repathGoalZ;
      if (status === 'fail') a.clearPath();
      served++;
    }
  }

  /* ================================================================== *
   * motion
   * ================================================================== */

  /**
   * Boss arena containment and any module-requested reposition are expressed as
   * a movement override rather than a Brain state, so the boss keeps telegraphing
   * and facing correctly while it walks back into its arena.
   */
  _postBrain(agent, ctx, dt) {
    const rp = agent.repositionTo;
    if (!rp || COMMITTED.has(agent.state) || agent.dead) return;
    if (agent.repositionUntil && ctx.elapsed > agent.repositionUntil) { agent.repositionTo = null; return; }
    const speed = agent.maxSpeed * 0.85;
    const d = this.brain.pathTo(agent, ctx, rp.x, rp.z, speed, 1.1);
    agent.setAnim(ANIM.walk);
    if (d > 1.6) this.brain.faceVelocity(agent);
    if (d <= 1.2) agent.repositionTo = null;
  }

  /**
   * A lunge, pounce or gore-charge is animation-driven displacement, not
   * locomotion. Both `Brain.tick` and `Steering.resolve` clamp the preferred
   * velocity to `agent.maxSpeed`, so without raising the ceiling here a 30 m/s
   * charge is silently reduced to a 3 m/s walk and the boss's signature move
   * never leaves the ground. Raise it for the strike window only, then put the
   * archetype's real speed back.
   */
  _applyLungeSpeed(agent) {
    const lunge = agent.state === ST.STRIKE && agent.attack ? (agent.attack.lunge ?? 0) : 0;
    if (lunge > 0) {
      if (agent.__lungeBase === undefined) agent.__lungeBase = agent.maxSpeed;
      agent.maxSpeed = Math.max(agent.__lungeBase, lunge);
      return;
    }
    if (agent.__lungeBase === undefined) return;
    // Restore. A phase break or enrage may have raised the base mid-strike, so
    // recompute rather than trusting the snapshot for a boss.
    if (agent.boss) {
      const E = agent.arch.enrage;
      agent.maxSpeed = agent.arch.speed * agent.boss.speedMul
        * (agent.enraged ? (E?.speedMul ?? 1.25) : 1);
    } else {
      agent.maxSpeed = agent.__lungeBase;
    }
    agent.__lungeBase = undefined;
  }

  _integrate(agent, dt) {
    const arch = agent.arch;
    let tx = agent.vx, tz = agent.vz;
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) { tx = 0; tz = 0; }

    const cx = agent.pvx, cz = agent.pvz;
    const dvx = tx - cx, dvz = tz - cz;
    const dv = Math.hypot(dvx, dvz);
    const speeding = Math.hypot(tx, tz) >= Math.hypot(cx, cz);
    let accel = arch.accel, decel = arch.decel;
    if (agent.__lungeBase !== undefined) {
      // Same reason: the walking accel curve must not eat the burst.
      const burst = Math.max(accel, agent.maxSpeed * 9);
      accel = burst; decel = Math.max(decel, burst);
    }
    const rate = (speeding ? accel : decel) * dt;
    if (dv > rate && dv > 1e-6) {
      const s = rate / dv;
      tx = cx + dvx * s; tz = cz + dvz * s;
    }
    agent.vx = tx; agent.vz = tz;
    agent.speed = Math.hypot(tx, tz);
    agent.px += tx * dt;
    agent.pz += tz * dt;

    // Turn toward the facing the brain asked for, rate-limited per archetype.
    const turn = arch.turnRate * (agent.turnScale ?? 1) * dt;
    const d = wrapPi(agent.faceYaw - agent.yaw);
    agent.yaw = wrapPi(agent.yaw + (Math.abs(d) <= turn ? d : Math.sign(d) * turn));
  }

  /**
   * Un-wedge. An agent that wants to move but has not covered ground for a
   * second is either boxed in by the pack or has a dead path; escalate the
   * re-path and nudge its ring slot so the pack reshuffles instead of jamming.
   */
  _stuckCheck(agent, dt, elapsed) {
    const wants = Math.hypot(agent.prefX, agent.prefZ);
    if (wants < 0.35 || COMMITTED.has(agent.state)) { agent.stuckT = 0; return; }
    const moved = Math.hypot(agent.px - agent.lastProgressX, agent.pz - agent.lastProgressZ);
    if (moved > 0.22) {
      agent.lastProgressX = agent.px; agent.lastProgressZ = agent.pz;
      agent.stuckT = 0;
      agent.stuckHits = 0;
      return;
    }
    agent.stuckT += dt;
    if (agent.stuckT > 0.9) {
      agent.stuckT = 0;
      agent.lastProgressX = agent.px; agent.lastProgressZ = agent.pz;
      agent.clearPath();
      agent.pathVersion = -1;
      agent.slotAngle = wrapPi(agent.slotAngle + 0.62 * agent.flankSign);
      if (agent.repathAsked >= 0) this.requestRepath(agent, agent.repathGoalX, agent.repathGoalZ, 2);

      // Three failures in a row is not a bad path, it is a wedge: a 3.2 m brute
      // in a 1.1 m gap stands on legal ground with nowhere legal to step, so the
      // steering pass vetoes every candidate and it freezes mid-fight. Give it a
      // goal it can actually reach — open ground — and let the normal reposition
      // path walk it out.
      if (++agent.stuckHits >= 3) {
        agent.stuckHits = 0;
        const f = this.nav.nearestFree(agent.px, agent.pz, agent.radius * 1.4, 7, _nf);
        if (f.found && Math.hypot(f.x - agent.px, f.z - agent.pz) > 0.3) {
          agent.repositionTo = { x: f.x, z: f.z };
          agent.repositionUntil = elapsed + 2.2;
        }
      }
    }
  }

  _writeAgent(agent, dt) {
    const canon = agent.anim;
    if (canon) {
      const r = this._resolveAnim(agent, canon);
      if (r !== canon) agent.anim = r;
    }
    try {
      agent.writeToEntity(dt, this._heightFn);
    } catch (e) {
      this._agentError(agent, e);
    }
    agent.anim = canon;
    // Publish a compact read-only view so HUD / VFX can key off AI state.
    const e = agent.entity;
    if (e) {
      e.aiState = agent.state;
      e.aiHasToken = agent.hasToken;
      e.aiAwareness = agent.awareness;
      e.aiArchetype = agent.arch.key;
    }
  }

  /* ================================================================== *
   * LOD
   * ================================================================== */

  _refreshLod(frame) {
    const cam = this.engine.camera;
    if (cam) {
      this._camPos.setFromMatrixPosition(cam.matrixWorld);
      this._camInv.copy(cam.matrixWorld).invert();
      this._pv.multiplyMatrices(cam.projectionMatrix, this._camInv);
      this._frustum.setFromProjectionMatrix(this._pv);
    }
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const dx = a.px - this._camPos.x, dy = a.py + a.height * 0.5 - this._camPos.y, dz = a.pz - this._camPos.z;
      a.distToCam = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Recheck visibility on a stagger so 60 sphere tests never land on one frame.
      if (((frame + a.tickPhase) & 3) === 0 && cam) {
        this._sphere.center.set(a.px, a.py + a.height * 0.5, a.pz);
        this._sphere.radius = Math.max(a.radius, a.height * 0.6) + 0.8;
        a.onScreen = this._frustum.intersectsSphere(this._sphere);
      }

      const bias = a.arch.lodBias ?? 1;
      if (bias <= 0 || a.boss || COMMITTED.has(a.state) || a.hasToken || a.telegraph) { a.lod = 0; continue; }
      const d = a.distToCam / Math.max(0.35, bias);
      let lod;
      if (a.onScreen) lod = d < 26 ? 0 : d < 48 ? 1 : 2;
      else lod = d < 20 ? 1 : d < 42 ? 2 : 3;
      // An agent that is aware but not yet engaged still needs a responsive turn.
      if (lod > 1 && a.awareness > 0.9 && a.distToCam < 60) lod = 1;
      a.lod = lod;
    }
  }

  /* ================================================================== *
   * PackDirector / Brain callbacks
   * ================================================================== */

  /**
   * The PackDirector budgets tokens *per encounter*; this is the global backstop.
   * If a pack ever splits into two encounter records (it can — clustering is
   * distance-based) each would get its own melee budget and the player would face
   * six simultaneous attackers. One hero means one front, so the melee cap is
   * enforced here across the whole roster. Ranged and caster pools are not
   * capped: they do not occupy the player's body and stay readable.
   */
  grantToken(agent) {
    if (agent.hasToken) return;
    if (agent.arch.tokenPool === 'melee') {
      let held = 0, melee = 0;
      for (let i = 0; i < this.agents.length; i++) {
        const o = this.agents[i];
        if (o.dead || !o.active || o.arch.tokenPool !== 'melee') continue;
        melee++;
        if (o.hasToken) held += o.arch.tokenCost;
      }
      const cap = melee >= 7 ? this.maxMeleeTokens : Math.min(2, this.maxMeleeTokens);
      if (held + agent.arch.tokenCost > cap) return;
    }
    agent.hasToken = true;
    agent.tokenSince = this.engine.clock.elapsed;
    agent.tokenWaited = 0;
  }

  releaseToken(agent) {
    if (!agent || !agent.hasToken) return;
    agent.hasToken = false;
    agent.tokenSince = this.engine.clock.elapsed;
    agent.tokenWaited = 0;
  }

  /** Living hostile agents near `agent`, excluding itself and any boss. */
  allyCount(agent) {
    let n = 0;
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const o = agents[i];
      if (o === agent || o.dead || !o.active || o.arch.isBoss) continue;
      if (o.faction !== agent.faction) continue;
      const dx = o.px - agent.px, dz = o.pz - agent.pz;
      if (dx * dx + dz * dz <= 324) n++;
    }
    return n;
  }

  canSummon(agent) {
    const cap = agent.arch.summon?.maxTotal ?? 9;
    let live = 0;
    for (const a of this.agents) if (!a.dead && a.active && !a.arch.isBoss) live++;
    if (live >= cap) return false;
    return this.agents.length + 2 <= this.maxAgents;
  }

  /**
   * A shout. The agent that noticed pulls its neighbours partway to aware and
   * hands them the stimulus point, which is what makes a pack turn together
   * instead of waking one body at a time.
   */
  onNotice(agent, ctx) {
    const elapsed = ctx.elapsed;
    const agents = this.agents;
    for (let i = 0; i < agents.length; i++) {
      const o = agents[i];
      if (o === agent || o.dead || !o.active) continue;
      if (o.faction !== agent.faction) continue;
      const dx = o.px - agent.px, dz = o.pz - agent.pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 196) continue;
      const w = 1 - Math.sqrt(d2) / 14;
      if (o.awareness < 0.62) {
        o.awareness = Math.max(o.awareness, 0.32 + w * 0.34);
        o.stimX = agent.stimX; o.stimZ = agent.stimZ; o.stimT = elapsed;
      }
    }
    this.engine.bus.emit('ai:notice', {
      entity: agent.entity, id: agent.id, archetype: agent.arch.key,
      position: { x: agent.px, y: agent.py, z: agent.pz },
    });
  }

  onEngage(agent, ctx) {
    if (this.director) this.director.aggroed = true;
    if (!this._engagedOnce) {
      this._engagedOnce = true;
      this.engine.bus.emit('ai:engage', { entity: agent.entity, id: agent.id, count: this.agents.length });
    }
  }

  onFlee(agent, ctx) {
    this.engine.bus.emit('ai:flee', { entity: agent.entity, id: agent.id });
  }

  /* ================================================================== *
   * telegraphs
   * ================================================================== */

  /** Ground-truth aim point for a ground-targeted or arena-centred ability. */
  _aimPoint(agent, atk, ctx, out) {
    const t = ctx.threat;
    if (agent.aimX !== undefined && agent.aimZ !== undefined) { out.x = agent.aimX; out.z = agent.aimZ; return out; }
    if (atk.arenaCentre && agent.boss) { out.x = agent.boss.arena.x; out.z = agent.boss.arena.z; return out; }
    if (t) {
      const lead = atk.predict ?? (atk.groundAtTarget ? 0.34 : 0);
      out.x = t.x + t.vx * lead;
      out.z = t.z + t.vz * lead;
      return out;
    }
    out.x = agent.px + Math.cos(agent.yaw) * (atk.range * 0.6);
    out.z = agent.pz + Math.sin(agent.yaw) * (atk.range * 0.6);
    return out;
  }

  beginTelegraph(agent, atk, ctx) {
    if (!atk) return null;
    if (agent.telegraph) this.endTelegraph(agent, true);
    const aim = this._aimPoint(agent, atk, ctx, _pt);
    const ground = atk.groundAtTarget || atk.arenaCentre;
    const tg = {
      uid: ++this._tgSeq,
      id: atk.id,
      label: atk.label,
      casterId: agent.id,
      caster: agent.entity,
      archetype: agent.arch.key,
      shape: atk.shape,
      danger: atk.danger,
      color: atk.color,
      // geometry — everything a decal needs, in metres/radians
      x: ground ? aim.x : agent.px,
      z: ground ? aim.z : agent.pz,
      y: 0,
      yaw: agent.faceYaw,
      length: atk.length ?? atk.range,
      width: atk.width ?? 0,
      angle: atk.angle ?? 0,
      radius: atk.radius ?? 0,
      inner: atk.inner ?? 0,
      salvo: atk.salvo ?? 1,
      salvoSpread: atk.salvoSpread ?? 0,
      ground,
      t0: ctx.elapsed,
      duration: Math.max(0.12, agent.stateDur || atk.windup),
      cancelled: false,
    };
    tg.y = this._heightFn ? this._heightFn(tg.x, tg.z) : 0;
    agent.telegraph = tg;
    agent.aimX = ground ? aim.x : undefined;
    agent.aimZ = ground ? aim.z : undefined;
    this._telegraphs.set(tg.uid, tg);

    const bus = this.engine.bus;
    bus.emit('ability:cast', {
      id: atk.id,
      caster: agent.entity,
      casterId: agent.id,
      origin: { x: agent.px, y: agent.py + agent.height * 0.62, z: agent.pz },
      dir: { x: Math.cos(agent.faceYaw), y: 0, z: Math.sin(agent.faceYaw) },
      level: agent.boss ? agent.boss.phaseIndex + 1 : 1,
      windup: tg.duration,
      telegraph: tg,
    });
    // Decals / VFX draw the ground read; both may not exist yet.
    bus.emit('telegraph:begin', tg);
    return tg;
  }

  /** Re-aim during the trackable part of the windup. */
  aimTelegraph(agent, ctx) {
    const tg = agent.telegraph;
    if (!tg) return;
    const atk = agent.attack;
    if (!atk) return;
    if (tg.ground) {
      const aim = this._aimPoint(agent, atk, ctx, _pt);
      if (agent.aimX === undefined) { tg.x = aim.x; tg.z = aim.z; }
      else { tg.x = agent.aimX; tg.z = agent.aimZ; }
      tg.y = this._heightFn ? this._heightFn(tg.x, tg.z) : 0;
    } else {
      tg.x = agent.px; tg.z = agent.pz;
      tg.y = this._heightFn ? this._heightFn(tg.x, tg.z) : 0;
    }
    tg.yaw = agent.faceYaw;
    tg.progress = sat((ctx.elapsed - tg.t0) / Math.max(0.05, tg.duration));
    this.engine.bus.emit('telegraph:update', tg);
  }

  endTelegraph(agent, cancelled) {
    const tg = agent.telegraph;
    agent.telegraph = null;
    if (!tg) return;
    tg.cancelled = !!cancelled;
    this._telegraphs.delete(tg.uid);
    this.engine.bus.emit('telegraph:end', tg);
  }

  /* ================================================================== *
   * attack resolution
   * ================================================================== */

  resolveAttack(agent, atk, ctx) {
    if (!atk) return;
    const bus = this.engine.bus;
    const originX = agent.attackFrom.x, originZ = agent.attackFrom.z;
    const yaw = agent.attackFrom.yaw;
    const ground = atk.groundAtTarget || atk.arenaCentre;
    const cx = ground ? (agent.aimX ?? originX) : originX;
    const cz = ground ? (agent.aimZ ?? originZ) : originZ;
    const y = this._heightFn ? this._heightFn(cx, cz) : 0;

    if (atk.summon) {
      this._doSummon(agent, atk, ctx);
      bus.emit('impact', {
        point: { x: cx, y: y + 0.04, z: cz }, normal: { x: 0, y: 1, z: 0 },
        kind: 'summon', magnitude: 0.8,
      });
      return;
    }

    // Every strike is an audible event, which is how a fight spreads aggro.
    this.perception.pushNoise(originX, agent.py, originZ, atk.danger === 'heavy' ? 2.2 : 1.3, agent.faction);

    if (atk.projectile) {
      const t = ctx.threat;
      const dirX = Math.cos(yaw), dirZ = Math.sin(yaw);
      const ox = originX + dirX * (agent.radius + 0.25);
      const oz = originZ + dirZ * (agent.radius + 0.25);
      const oy = agent.py + agent.height * 0.62;
      bus.emit('ability:cast', {
        id: atk.id, caster: agent.entity, casterId: agent.id,
        origin: { x: ox, y: oy, z: oz },
        dir: { x: dirX, y: 0, z: dirZ },
        level: 1, projectile: atk.projectile, speed: atk.projectileSpeed ?? 30,
        damage: atk.damage, range: atk.range,
      });
      if (t) {
        const dist = Math.hypot(t.x - ox, t.z - oz);
        const travel = clamp(dist / Math.max(6, atk.projectileSpeed ?? 30), 0.02, 1.4);
        if (this._pendingHits.length < 48) {
          this._pendingHits.push({
            at: ctx.elapsed + travel, agent, atk,
            x: ox, z: oz, yaw, cx: ox, cz: oz, kind: 'projectile',
          });
        }
      }
      return;
    }

    // Salvoed ground AoE (boss meteor): one hit test per impact point.
    const salvo = Math.max(1, atk.salvo ?? 1);
    for (let s = 0; s < salvo; s++) {
      let px = cx, pz = cz;
      if (salvo > 1) {
        const ang = (s / salvo) * TAU + agent.lane;
        const rad = (atk.salvoSpread ?? 4) * (0.35 + (s % 2) * 0.45);
        px += Math.cos(ang) * rad;
        pz += Math.sin(ang) * rad;
      }
      this._applyAttack(agent, atk, ctx, originX, originZ, yaw, px, pz, s);
    }
  }

  _resolvePendingHits(elapsed) {
    const list = this._pendingHits;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      if (elapsed < h.at) continue;
      list.splice(i, 1);
      const ctx = this._ctx;
      ctx.threat = this._threatFor(h.agent);
      this._applyAttack(h.agent, h.atk, ctx, h.x, h.z, h.yaw, h.cx, h.cz, 0);
      ctx.threat = this.threat.valid ? this.threat : null;
    }
  }

  _applyAttack(agent, atk, ctx, originX, originZ, yaw, centreX, centreZ, salvoIndex) {
    const bus = this.engine.bus;
    const t = ctx.threat;
    const ground = atk.groundAtTarget || atk.arenaCentre || salvoIndex > 0;
    const y = this._heightFn ? this._heightFn(centreX, centreZ) : 0;

    let hit = false;
    if (t && t.alive !== false) {
      hit = ground
        ? this._hitsGround(atk, centreX, centreZ, t.x, t.z, t.radius)
        : this._hitsShape(atk, originX, originZ, yaw, t.x, t.z, t.radius);
    }

    bus.emit('impact', {
      point: { x: centreX, y: y + 0.05, z: centreZ },
      normal: { x: 0, y: 1, z: 0 },
      kind: atk.danger === 'aoe' ? 'aoe' : atk.danger === 'heavy' ? 'heavy_impact' : 'weapon',
      magnitude: clamp((atk.damage ?? 10) / 40, 0.15, 1.4),
      abilityId: atk.id,
      sourceId: agent.id,
    });

    if (atk.shake) {
      // Scale by how close the hit is to what the camera is looking at, so an
      // offscreen swing never kicks the frame.
      const dx = centreX - this._camPos.x, dz = centreZ - this._camPos.z;
      const near = sat(1 - Math.hypot(dx, dz) / 46);
      const amp = atk.shake * (0.35 + near * 0.65) * (hit ? 1.15 : 0.8);
      if (amp > 0.03) bus.emit('camera:shake', { amp, freq: 12 - atk.shake * 4, duration: 0.22 + atk.shake * 0.5 });
    }

    if (!hit) return;
    const amount = (atk.damage ?? 0) * (agent.damageMul ?? 1);
    if (amount <= 0) return;

    const hitX = t.x, hitZ = t.z;
    const payload = {
      target: t.entity,
      amount,
      type: atk.danger === 'aoe' ? 'necrotic' : 'physical',
      crit: false,
      hitPoint: { x: hitX, y: (t.y ?? 0) + 1.05, z: hitZ },
      hitNormal: { x: Math.cos(yaw + Math.PI), y: 0, z: Math.sin(yaw + Math.PI) },
      sourceId: agent.id,
      source: agent.entity,
      abilityId: atk.id,
      abilityLabel: atk.label,
    };

    // Prefer a combat authority if one exists; otherwise the bus event *is* the
    // contract and whoever owns health picks it up.
    const combat = this._mod('combat');
    if (combat) {
      for (const k of ['applyDamage', 'resolveEnemyAttack', 'enemyAttack']) {
        if (typeof combat[k] === 'function') {
          try { combat[k](payload); return; } catch { /* fall through to the bus */ }
        }
      }
    }
    bus.emit('damage', payload);
  }

  /** Origin-relative shapes: cone, line, circle, ring. */
  _hitsShape(atk, ox, oz, yaw, tx, tz, tr) {
    const dx = tx - ox, dz = tz - oz;
    const dist = Math.hypot(dx, dz);
    const r = tr ?? 0.42;
    switch (atk.shape) {
      case 'cone': {
        const len = (atk.length ?? atk.range) + r;
        if (dist > len) return false;
        if (dist < 1e-3) return true;
        const half = (atk.angle ?? 1.4) * 0.5 + Math.atan2(r, Math.max(0.4, dist));
        return Math.abs(wrapPi(Math.atan2(dz, dx) - yaw)) <= half;
      }
      case 'line': {
        const len = atk.length ?? atk.range;
        const fx = Math.cos(yaw), fz = Math.sin(yaw);
        const along = dx * fx + dz * fz;
        if (along < -r || along > len + r) return false;
        const perp = Math.abs(-dx * fz + dz * fx);
        return perp <= (atk.width ?? 0.8) * 0.5 + r;
      }
      case 'ring': {
        const outer = (atk.radius ?? atk.range) + r;
        const inner = Math.max(0, (atk.inner ?? 0) - r);
        return dist <= outer && dist >= inner;
      }
      case 'circle':
      default: {
        const rad = (atk.radius ?? atk.range) + r;
        return dist <= rad;
      }
    }
  }

  /** Ground-targeted shapes are always centred on the aim point. */
  _hitsGround(atk, cx, cz, tx, tz, tr) {
    const d = Math.hypot(tx - cx, tz - cz);
    const r = tr ?? 0.42;
    if (atk.shape === 'ring') {
      const outer = (atk.radius ?? 6) + r;
      const inner = Math.max(0, (atk.inner ?? 0) - r);
      return d <= outer && d >= inner;
    }
    return d <= (atk.radius ?? 2.5) + r;
  }

  /* ================================================================== *
   * summoning
   * ================================================================== */

  _doSummon(agent, atk, ctx) {
    const S = atk.summon ?? { archetype: 'grunt', count: 3, radius: 3.4 };
    const dir = ctx.threat
      ? Math.atan2(ctx.threat.z - agent.pz, ctx.threat.x - agent.px)
      : agent.yaw;
    const cx = agent.px + Math.cos(dir) * (S.radius ?? 3.4) * 0.7;
    const cz = agent.pz + Math.sin(dir) * (S.radius ?? 3.4) * 0.7;
    const pts = this.director.formationPoints(S.count ?? 3, cx, cz, {
      seed: (agent.seed ^ ((agent.summonCount + 1) * 7919)) >>> 0,
      spread: S.radius ?? 3.4,
      radius: 0.5,
      facing: dir,
    });
    agent.summonCount += S.count ?? 3;
    agent.lastSummonT = ctx.elapsed;
    this.requestSummon(agent, S.archetype ?? 'grunt', pts, { source: agent.arch.key, abilityId: atk.id });
  }

  /**
   * Ask Bestiary for bodies. It may not expose a spawn hook at all, in which
   * case the bus request stands and a later module can honour it — the AI never
   * builds bodies itself.
   */
  /**
   * Queue a summon rather than building bodies inline.
   *
   * Spawning a species for the first time makes Bestiary compile a rig, geometry
   * and materials — tens of milliseconds. Called straight from a brain tick, a
   * four-add summon lands the entire cost inside one frame (measured: a 63 ms
   * spike) and the fight visibly hitches at exactly the dramatic beat it should
   * not. So the rift flash fires now, the bodies arrive one per frame afterwards,
   * and the whole summon still reads as instantaneous at 60 fps.
   */
  requestSummon(agent, archetype, points, meta = {}) {
    const list = Array.isArray(points) ? points : [];
    if (!list.length) return 0;
    const bus = this.engine.bus;
    const room = Math.max(0, this.maxAgents - this.agents.length - this._summonQ.length);
    const pts = room < list.length ? list.slice(0, room) : list;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const y = this._heightFn ? this._heightFn(p.x, p.z) : 0;
      this._summonQ.push({
        archetype, x: p.x, y, z: p.z, faction: agent.faction,
        seed: (agent.seed ^ ((i + 1) * 7919)) >>> 0,
        level: meta.level ?? agent.entity?.level ?? 1,
        summonedBy: agent.id, source: meta.source ?? 'ai', abilityId: meta.abilityId,
      });
      bus.emit('impact', {
        point: { x: p.x, y: y + 0.03, z: p.z }, normal: { x: 0, y: 1, z: 0 },
        kind: 'summon_rift', magnitude: 0.55,
      });
    }
    return pts.length;
  }

  /** One body per frame, at the end of the tick. */
  _serviceSummons() {
    const q = this._summonQ;
    if (!q.length) return;
    const s = q.shift();
    const bestiary = this._mod('bestiary');
    let ok = false;
    if (bestiary) {
      const before = this._entityCount();
      const opts = { seed: s.seed, level: s.level };
      if (typeof bestiary.spawnPack === 'function') {
        try { bestiary.spawnPack(s.archetype, [{ x: s.x, z: s.z }], opts); } catch (e) { console.warn('[ai] spawnPack —', e.message); }
      }
      if (this._entityCount() === before) {
        for (const fn of ['spawn', 'spawnAt', 'spawnEnemy', 'summon']) {
          if (typeof bestiary[fn] !== 'function') continue;
          try { bestiary[fn](s.archetype, { x: s.x, y: s.y, z: s.z }, opts); } catch { /* next hook */ }
          if (this._entityCount() > before) break;
        }
      }
      ok = this._entityCount() > before;
    }
    // Nobody built it: the request still stands, a later module may honour it.
    if (!ok) {
      this.engine.bus.emit('spawn:request', {
        archetype: s.archetype, kind: s.archetype, faction: s.faction,
        x: s.x, y: s.y, z: s.z, position: { x: s.x, y: s.y, z: s.z },
        summonedBy: s.summonedBy, source: s.source, abilityId: s.abilityId,
      });
    }
  }

  _entityCount() {
    const b = this._mod('bestiary');
    const src = b && (b.entities ?? b.list ?? b.all);
    if (Array.isArray(src)) return src.length;
    let n = 0;
    for (const _ of this._entities()) n++;
    return n;
  }

  /* ================================================================== *
   * bus reactions
   * ================================================================== */

  _onDamage(p) {
    if (!p) return;
    const agent = p.target ? this.byEntity.get(p.target) : null;
    const elapsed = this.engine.clock.elapsed;
    if (agent) {
      const amount = NUM(p.amount) ?? 0;
      const frac = agent.maxHp > 0 ? amount / agent.maxHp : 0.1;
      const st = agent.arch.stagger;
      if (st > 0 && frac > 0.015) agent.staggerFor = Math.max(agent.staggerFor, st * clamp(0.6 + frac * 4, 0.6, 1.9));
      agent.awareness = 1.35;
      agent.hitFlashT = elapsed;
      const hp = p.hitPoint;
      if (hp && Number.isFinite(hp.x)) { agent.stimX = hp.x; agent.stimZ = hp.z; }
      else if (this.threat.valid) { agent.stimX = this.threat.x; agent.stimZ = this.threat.z; }
      agent.stimT = elapsed;
      agent.lastSeenX = agent.stimX; agent.lastSeenZ = agent.stimZ; agent.lastSeenT = elapsed;
      // Pain is loud: the pack turns.
      this.perception.pushNoise(agent.px, agent.py, agent.pz, 1.8, 'player');
      return;
    }
    // The hero got hit — nearby enemies smell blood and press in.
    if (this.threat.valid && p.target && p.target === this.threat.entity) {
      this.perception.pushNoise(this.threat.x, this.threat.y, this.threat.z, 1.6, 'player');
    }
  }

  _onDeath(p) {
    if (!p) return;
    const agent = p.entity ? this.byEntity.get(p.entity) : null;
    if (!agent) return;
    agent.dead = true;
    agent.staggerFor = 0;
    if (agent.telegraph) this.endTelegraph(agent, true);
    this.releaseToken(agent);
    agent.setState(ST.DEAD);
    // A death is a morale event: cowards break, the rest close the gap.
    for (const o of this.agents) {
      if (o === agent || o.dead || o.faction !== agent.faction) continue;
      const dx = o.px - agent.px, dz = o.pz - agent.pz;
      if (dx * dx + dz * dz > 144) continue;
      o.slotSeeded = null;                 // force the ring to reform
      if (o.arch.flee?.cowardly && !o.fleeSpent) o.hpFrac = Math.min(o.hpFrac, o.arch.flee.hpFrac);
    }
  }

  /**
   * Impacts are a hearing stimulus — but only *some* of them, and this is a trap
   * worth spelling out. Bodies emit a `footfall` impact per footstep; a pack of
   * nine walking monsters produces dozens per second. Re-broadcasting those as
   * player-faction noise means every enemy permanently hears "the player" — and
   * because hearing alone saturates awareness at 0.92, never at the 0.98 that
   * confirms a target, the whole pack gets locked out of engaging and mills about
   * investigating its own footprints forever.
   *
   * So: drop locomotion kinds, drop anything one of our own agents emitted, and
   * rate-limit what survives.
   */
  _onImpact(p) {
    if (!p || !p.point) return;
    const k = p.kind;
    if (!k || IGNORED_IMPACTS.has(k)) return;
    if (p.sourceId && this.byId.has(p.sourceId)) return;           // ours
    if (p.source && this.byEntity.has(p.source)) return;
    const mag = NUM(p.magnitude) ?? 0.6;
    if (mag < 0.2) return;
    const elapsed = this.engine.clock.elapsed;
    if (elapsed - (this._impactNoiseAt ?? -9) < 0.12) return;
    this._impactNoiseAt = elapsed;
    this.perception?.pushNoise(p.point.x, p.point.y ?? 0, p.point.z, clamp(0.5 + mag, 0.5, 2.6), 'player');
  }

  _onAbilityCast(p) {
    if (!p || !p.origin) return;
    // Only the hero's casts are a stimulus; our own are already noises.
    if (p.casterId && this.byId.has(p.casterId)) return;
    this.perception?.pushNoise(p.origin.x, p.origin.y ?? 0, p.origin.z, 1.5, 'player');
  }

  /* ================================================================== *
   * diagnosis
   * ================================================================== */

  /** Human-readable snapshot for the console / harness. */
  report() {
    const states = {};
    const holders = [];
    const pools = { melee: 0, ranged: 0, caster: 0, boss: 0 };
    let live = 0, contact = 0;
    for (const a of this.agents) {
      if (!a.dead) live++;
      states[a.state] = (states[a.state] ?? 0) + 1;
      if (a.hasToken) { holders.push(`${a.arch.key}:${a.id}`); pools[a.arch.tokenPool] = (pools[a.arch.tokenPool] ?? 0) + 1; }
      if (!a.dead && this.threat.valid && a.arch.tokenPool === 'melee'
        && Math.hypot(a.px - this.threat.x, a.pz - this.threat.z) < 3.0) contact++;
    }
    const ringDist = [];
    if (this.threat.valid) {
      for (const a of this.agents) {
        if (a.dead) continue;
        ringDist.push(+Math.hypot(a.px - this.threat.x, a.pz - this.threat.z).toFixed(2));
      }
      ringDist.sort((x, y) => x - y);
    }
    return {
      agents: this.agents.length,
      live,
      threat: this.threat.valid ? { x: +this.threat.x.toFixed(2), z: +this.threat.z.toFixed(2) } : null,
      states,
      tokens: holders,
      tokenCount: holders.length,
      tokensByPool: pools,
      meleeInContact: contact,
      circling: this.stats.circling,
      attacking: this.stats.attacking,
      ringDist,
      ms: +this.stats.ms.toFixed(3),
      msAvg: +this.stats.msAvg.toFixed(3),
      msPeak: +this.stats.msPeak.toFixed(3),
      nav: this.nav ? {
        built: this.nav.built, W: this.nav.W, cell: this.nav.cell,
        builds: this.nav.stats.builds, buildMs: +this.nav.stats.buildMs.toFixed(2),
        astar: this.nav.stats.astar, cacheHits: this.nav.stats.cacheHits,
        expansions: this.nav.stats.expansions, deferred: this.nav.stats.deferred,
      } : null,
      perception: this.perception ? { ...this.perception.stats } : null,
      steering: this.steering ? { ...this.steering.stats } : null,
      director: this.director ? { ...this.director.stats } : null,
      telegraphs: this._telegraphs.size,
    };
  }

  /* ================================================================== *
   * debug overlay
   * ================================================================== */

  /**
   * Wireframe diagnosis layer: nav boundary, live paths, ring slots, token
   * holders, telegraph footprints, vision cones. Off by default and allocates
   * nothing until first enabled.
   */
  debugDraw(enable = true) {
    this.debug = !!enable;
    if (this.debug && !this._dbg) this._buildDebug();
    if (this._dbg) this._dbg.group.visible = this.debug;
    if (this.debug) { try { this._debugUpdate(); } catch (e) { console.warn('[ai] debug draw —', e.message); } }
    return this.debug;
  }

  _buildDebug() {
    const MAX = 24000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 9990;
    const group = new THREE.Group();
    group.name = 'AI.debug';
    group.add(lines);
    group.visible = this.debug;
    this.engine.scene.add(group);
    this._dbg = { group, lines, geo, mat, pos, col, max: MAX, n: 0, segs: new Float32Array(9600) };
  }

  _disposeDebug() {
    if (!this._dbg) return;
    this.engine.scene.remove(this._dbg.group);
    this._dbg.geo.dispose();
    this._dbg.mat.dispose();
    this._dbg = null;
  }

  _dbgSeg(ax, ay, az, bx, by, bz, r, g, b) {
    const d = this._dbg;
    if (d.n + 2 > d.max) return;
    let i = d.n * 3;
    d.pos[i] = ax; d.pos[i + 1] = ay; d.pos[i + 2] = az;
    d.col[i] = r; d.col[i + 1] = g; d.col[i + 2] = b;
    i += 3;
    d.pos[i] = bx; d.pos[i + 1] = by; d.pos[i + 2] = bz;
    d.col[i] = r; d.col[i + 1] = g; d.col[i + 2] = b;
    d.n += 2;
  }

  _dbgCircle(cx, cz, radius, r, g, b, lift = 0.06, segments = 28) {
    const h = this._heightFn ? this._heightFn(cx, cz) : 0;
    let px = cx + radius, pz = cz;
    for (let i = 1; i <= segments; i++) {
      const a = (i / segments) * TAU;
      const nx = cx + Math.cos(a) * radius;
      const nz = cz + Math.sin(a) * radius;
      this._dbgSeg(px, h + lift, pz, nx, h + lift, nz, r, g, b);
      px = nx; pz = nz;
    }
  }

  _debugUpdate() {
    const d = this._dbg;
    if (!d) return;
    d.n = 0;
    const H = this._heightFn;
    const lift = 0.08;

    /* ---- nav boundary near the action ---- */
    if (this.nav?.built) {
      const cx = this.threat.valid ? this.threat.x : this.nav.originX + this.nav.span * 0.5;
      const cz = this.threat.valid ? this.threat.z : this.nav.originZ + this.nav.span * 0.5;
      const count = this.nav.boundarySegments(cx, cz, 24, d.segs, 1200);
      for (let i = 0; i < count; i++) {
        const ax = d.segs[i * 4], az = d.segs[i * 4 + 1];
        const bx = d.segs[i * 4 + 2], bz = d.segs[i * 4 + 3];
        const ay = (H ? H(ax, az) : 0) + lift;
        const by = (H ? H(bx, bz) : 0) + lift;
        this._dbgSeg(ax, ay, az, bx, by, bz, 0.24, 0.26, 0.34);
      }
    }

    /* ---- threat + engagement rings ---- */
    if (this.threat.valid) {
      this._dbgCircle(this.threat.x, this.threat.z, this.threat.radius, 0.35, 0.85, 1.0, lift + 0.02, 20);
      this._dbgCircle(this.threat.x, this.threat.z, 4.4, 0.16, 0.30, 0.42, lift, 40);
      this._dbgCircle(this.threat.x, this.threat.z, 11.0, 0.14, 0.24, 0.34, lift, 56);
    }

    /* ---- per agent ---- */
    for (const a of this.agents) {
      if (!a.active) continue;
      const y = (H ? H(a.px, a.pz) : a.py) + lift;
      // Saturated primaries: the overlay is composited through ACES + bloom, so
      // mid-value colours all resolve to the same washed white.
      const tok = a.hasToken;
      const cr = a.dead ? 0.22 : tok ? 1.0 : 0.04;
      const cg = a.dead ? 0.22 : tok ? 0.06 : 0.90;
      const cb = a.dead ? 0.22 : tok ? 0.02 : 0.30;

      // body disc + facing spur
      this._dbgCircle(a.px, a.pz, a.radius, cr, cg, cb, lift, 16);
      const fl = a.radius + 0.7;
      this._dbgSeg(a.px, y, a.pz, a.px + Math.cos(a.yaw) * fl, y, a.pz + Math.sin(a.yaw) * fl, cr, cg, cb);

      // path
      const p = a.path;
      if (p.length >= 4) {
        for (let i = 0; i < (p.length >> 1) - 1; i++) {
          const ax = p[i * 2], az = p[i * 2 + 1];
          const bx = p[(i + 1) * 2], bz = p[(i + 1) * 2 + 1];
          const ay = (H ? H(ax, az) : 0) + lift + 0.03;
          const by = (H ? H(bx, bz) : 0) + lift + 0.03;
          this._dbgSeg(ax, ay, az, bx, by, bz, 0.20, 0.62, 0.78);
        }
      }

      // assigned ring slot
      if (!a.dead && a.ringRadius > 0 && this.threat.valid) {
        const sx = this.threat.x + Math.cos(a.slotAngle) * a.ringRadius;
        const sz = this.threat.z + Math.sin(a.slotAngle) * a.ringRadius;
        const sy = (H ? H(sx, sz) : 0) + lift;
        this._dbgSeg(sx - 0.28, sy, sz, sx + 0.28, sy, sz, 0.55, 0.48, 0.14);
        this._dbgSeg(sx, sy, sz - 0.28, sx, sy, sz + 0.28, 0.55, 0.48, 0.14);
      }

      // telegraph footprint
      const tg = a.telegraph;
      if (tg) {
        const r = ((tg.color >> 16) & 255) / 255;
        const g = ((tg.color >> 8) & 255) / 255;
        const b = (tg.color & 255) / 255;
        if (tg.shape === 'circle') this._dbgCircle(tg.x, tg.z, tg.radius || 2.5, r, g, b, lift + 0.05, 30);
        else if (tg.shape === 'ring') {
          this._dbgCircle(tg.x, tg.z, tg.radius || 6, r, g, b, lift + 0.05, 40);
          if (tg.inner) this._dbgCircle(tg.x, tg.z, tg.inner, r, g, b, lift + 0.05, 24);
        } else if (tg.shape === 'line') {
          const fx = Math.cos(tg.yaw), fz = Math.sin(tg.yaw);
          const hw = (tg.width || 0.8) * 0.5;
          const L = tg.length || 4;
          const corners = [
            [tg.x - fz * hw, tg.z + fx * hw], [tg.x + fx * L - fz * hw, tg.z + fz * L + fx * hw],
            [tg.x + fx * L + fz * hw, tg.z + fz * L - fx * hw], [tg.x + fz * hw, tg.z - fx * hw],
          ];
          for (let i = 0; i < 4; i++) {
            const c0 = corners[i], c1 = corners[(i + 1) % 4];
            this._dbgSeg(c0[0], (H ? H(c0[0], c0[1]) : 0) + lift + 0.05, c0[1],
              c1[0], (H ? H(c1[0], c1[1]) : 0) + lift + 0.05, c1[1], r, g, b);
          }
        } else {
          const half = (tg.angle || 1.4) * 0.5;
          const L = tg.length || 3;
          let px = tg.x, pz = tg.z;
          for (let i = 0; i <= 12; i++) {
            const ang = tg.yaw - half + (i / 12) * half * 2;
            const nx = tg.x + Math.cos(ang) * L;
            const nz = tg.z + Math.sin(ang) * L;
            this._dbgSeg(px, (H ? H(px, pz) : 0) + lift + 0.05, pz,
              nx, (H ? H(nx, nz) : 0) + lift + 0.05, nz, r, g, b);
            px = nx; pz = nz;
          }
          this._dbgSeg(px, (H ? H(px, pz) : 0) + lift + 0.05, pz, tg.x, y + 0.05, tg.z, r, g, b);
        }
      }

      // boss arena
      if (a.boss) this._dbgCircle(a.boss.arena.x, a.boss.arena.z, a.boss.arena.r, 0.62, 0.18, 0.12, lift, 72);
    }

    d.geo.setDrawRange(0, d.n);
    d.geo.attributes.position.needsUpdate = true;
    d.geo.attributes.color.needsUpdate = true;
    d.geo.computeBoundingSphere();
  }

  /* ================================================================== *
   * helpers
   * ================================================================== */

  _mod(id) {
    const m = this.engine.get?.(id);
    return m && !m.__dead ? m : null;
  }

  /** Public: the agent driving a body, if any. */
  agentFor(entity) { return this.byEntity.get(entity) ?? null; }
}

const _pt = { x: 0, z: 0 };
const _nf = { x: 0, z: 0, found: false };

/** Deterministic 0..1 from a 32-bit seed. Consumes no PRNG stream. */
function hashUnit(seed) {
  let h = seed >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export { ST as AI_STATES, ANIM as AI_ANIMS };
