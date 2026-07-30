/**
 * THE NINTH VIGIL — Physics.
 *
 * There is no third-party physics engine in this project and there is not going
 * to be one. What the game actually needs is four specific things, and a general
 * solver would be slower and less predictable at all four:
 *
 *   1. **Characters must not walk through walls.** A capsule controller over an
 *      AABB soup, with step-up, slope limits and ground snapping.
 *      → physics/Character.js, physics/World.js
 *   2. **Debris must tumble and then be quiet.** An impulse solver over convex
 *      chunks with real inverse inertia, friction, restitution and *sleeping*.
 *      → physics/Bodies.js
 *   3. **Corpses must fall convincingly.** Ragdolls: one body per major bone,
 *      hinge and cone joint limits, world and self collision, the killing blow's
 *      impulse applied at the hit point.
 *      → physics/Ragdoll.js
 *   4. **Props must break.** Convex-ish shatter with inherited velocity, hooked
 *      into Props' own destructible path.
 *
 * Determinism (ENGINE_CONTRACT.md, non-negotiable)
 * -----------------------------------------------
 * Fixed dt from the engine, fixed substep counts, fixed constraint iteration
 * counts, fixed solve order (arrays indexed, never object-key iteration), and
 * every random number from `engine.freshRand(seed)` with the seed derived from
 * stable data (entity id, world position quantised to a millimetre). Wall-clock
 * time appears only in `this.cost`, which is reported and never read back into
 * the simulation. Two captures of the same scenario are byte-identical.
 *
 * Budget
 * ------
 * Draw calls added: at most 3 (one InstancedMesh per debris material class), and
 * zero when nothing is broken — the meshes go `visible = false` at count 0.
 * Ragdolls add none at all: they drive the SkinnedMesh the Bestiary already
 * draws. Texture units added: 2 per debris material (albedo + normal only), well
 * inside the 16-unit ceiling documented in KNOWN_ISSUES.md.
 */

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { PhysWorld, K_PROP, K_WALL } from './physics/World.js';
import { CharacterController } from './physics/Character.js';
import { RigidWorld, DebrisRenderer, MAT_RUBBLE, MAT_TIMBER, MAT_BONE } from './physics/Bodies.js';
import { RagdollSet } from './physics/Ragdoll.js';
import { Verlet, makeCloth, makeRope } from './physics/Verlet.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _v = new THREE.Vector3();
const _cap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.34);

/** Material class per prop kind, for shatter chunks. */
const SHATTER_MAT = [
  ['barrel', MAT_TIMBER], ['crate', MAT_TIMBER], ['cart', MAT_TIMBER], ['plank', MAT_TIMBER],
  ['wood', MAT_TIMBER], ['fence', MAT_TIMBER], ['ladder', MAT_TIMBER],
  ['bone', MAT_BONE], ['skull', MAT_BONE], ['ossuary', MAT_BONE], ['rib', MAT_BONE],
  ['urn', MAT_RUBBLE], ['pot', MAT_RUBBLE], ['vase', MAT_RUBBLE],
];

export class Physics {
  static id = 'physics';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.world = new PhysWorld(engine);
    this.rigid = new RigidWorld(this.world, 168);
    this.debris = new DebrisRenderer(engine, 168);
    this.ragdolls = new RagdollSet(this, 8);

    this.controller = new CharacterController(this.world);
    this._ctrl = new Map();          // per-entity controllers, keyed by entity

    this.enabled = true;
    this.cost = 0;                   // last frame's CPU cost, ms (diagnostic)
    this.stats = {
      boxes: 0, bodies: 0, awake: 0, ragdolls: 0, contacts: 0,
      chars: 0, drawCalls: 0, ms: 0,
    };

    this._offs = [];
    this._brokenSeen = new WeakSet();
    this._propScanAt = -1;
    this._shatterSeq = 0;
    this._debrisSeq = 0;
    this._pendingDeaths = [];
    this._rebuildPending = true;
    this._enforce = true;
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    this.debris.init();
    const bus = this.engine.bus;
    this._offs.push(bus.on('scenario', () => { this._rebuildPending = true; this._reset(); }));
    this._offs.push(bus.on('dungeon:built', () => { this._rebuildPending = true; }));
    this._offs.push(bus.on('death', (p) => this._onDeath(p)));
    this._offs.push(bus.on('impact', (p) => this._onImpact(p)));
    this._offs.push(bus.on('loot:drop', (p) => this._onLootDrop(p)));
    this.world.rebuild();
    this._rebuildPending = false;
    console.info(
      `[physics] static world: ${this.world.stats.boxes} boxes from ${this.world.stats.source} ` +
      `in ${this.world.stats.buildMs.toFixed(1)}ms, grid ${this.world.grid.nx}x${this.world.grid.nz}`
    );
  }

  applyScenario() { this._rebuildPending = true; this._reset(); }

  _reset() {
    this.rigid.clear();
    this.ragdolls.clear();
    this._ctrl.clear();
    this._pendingDeaths.length = 0;
    this._propScanAt = -1;
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    this.ragdolls.clear();
    this.rigid.clear();
    this.debris.dispose();
  }

  /* ================================================================ *
   * frame
   * ================================================================ */

  update(dt) {
    if (!this.enabled) return;
    const t0 = _now();

    if (this._rebuildPending) {
      this._rebuildPending = false;
      try { this.world.rebuild(); } catch (e) { console.error('[physics] world rebuild failed —', e); }
      this._ctrl.clear();
    }

    /* deaths are queued from the bus and converted here, so a ragdoll is built
       once per frame in a fixed order regardless of emit order */
    if (this._pendingDeaths.length) {
      for (let i = 0; i < this._pendingDeaths.length; i++) {
        const d = this._pendingDeaths[i];
        try { this.ragdoll(d); } catch (e) { console.warn('[physics] ragdoll failed —', e?.message ?? e); }
      }
      this._pendingDeaths.length = 0;
    }

    try { this.rigid.step(dt); } catch (e) { console.error('[physics] rigid step —', e); }
    try { this.ragdolls.step(dt); } catch (e) { console.error('[physics] ragdoll step —', e); }
    if (this._enforce) {
      try { this._enforceCharacters(dt); } catch (e) { console.error('[physics] character pass —', e); }
    }
    this._scanDestructibles();
    try { this.debris.sync(this.rigid); } catch (e) { console.error('[physics] debris sync —', e); }

    const s = this.stats;
    s.boxes = this.world.stats.boxes;
    s.bodies = this.rigid.stats.active;
    s.awake = this.rigid.stats.awake;
    s.contacts = this.rigid.stats.contacts;
    s.ragdolls = this.ragdolls.activeCount;
    s.drawCalls = this.debris.drawCalls;
    this.cost = _now() - t0;
    s.ms = this.cost;
  }

  /* ================================================================ *
   * public API — characters
   * ================================================================ */

  /**
   * Resolve a capsule move against the world.
   *
   * @param {Capsule|{start:THREE.Vector3,end:THREE.Vector3,radius:number}} capsule
   *        World-space capsule; mutated to the resolved pose unless
   *        `opts.mutate === false`.
   * @param {{x:number,y:number,z:number}} delta desired displacement in metres
   *        for this tick (already multiplied by dt by the caller)
   * @param {object} [opts] {allowStep, snapDown, radius, height, out, mutate}
   * @returns {{position:THREE.Vector3, motion:THREE.Vector3, grounded:boolean,
   *            groundY:number, groundNormal:THREE.Vector3, hitWall:boolean,
   *            wallNormal:THREE.Vector3, stepped:boolean, blocked:boolean,
   *            slopeAngle:number, kind:number, penetration:number}}
   *
   * The returned object is reused between calls — copy what you need, or pass
   * `opts.out`.
   */
  moveCapsule(capsule, delta, opts = {}) {
    const c = this.controller;
    if (opts.radius) c.radius = opts.radius;
    if (opts.height) c.height = opts.height;
    if (opts.step !== undefined) c.step = opts.step;
    return c.move(capsule, delta ?? _ZERO, opts);
  }

  /**
   * Convenience wrapper for the common shape of the call: a foot position and a
   * desired XZ displacement. Returns the same result record.
   */
  moveActor(x, footY, z, dx, dz, opts = {}) {
    const r = opts.radius ?? 0.34;
    const h = Math.max(r * 2.1, opts.height ?? 1.85);
    _cap.start.set(x, footY + r, z);
    _cap.end.set(x, footY + h - r, z);
    _cap.radius = r;
    const res = this.moveCapsule(_cap, _v.set(dx, opts.dy ?? 0, dz), opts);
    res.position.y -= r;         // report a foot position, as handed in
    return res;
  }

  /**
   * Push a capsule out of the static world without moving it. Returns the
   * corrected foot position in `out` (or a shared vector) and the distance moved.
   */
  resolveCapsule(x, footY, z, opts = {}) {
    const moved = this.controller.depenetrate(x, footY, z, opts);
    return { position: this.controller.result.position, moved, kind: this.controller.result.kind };
  }

  /** Ground height (heightfield + box tops) under a point. */
  groundAt(x, z, fromY = 1e4) {
    const s = this.world.surfaceBelow(x, z, fromY, 1e4, 0.12);
    return Number.isFinite(s) && s > -Infinity ? s : this.world.heightAt(x, z);
  }

  heightAt(x, z) { return this.world.heightAt(x, z); }
  isWalkable(x, z) { return this.world.isWalkable(x, z); }

  /** Surface normal of the ground under a point. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const n = this.world.normalAt(x, z, _n3);
    return out.set(n.x, n.y, n.z);
  }

  /** First static hit along a segment. `out.t` is the fraction, 1 = clear. */
  raycast(origin, dir, dist = 40, out = _RAY) {
    this.world.raySegment(origin.x, origin.y, origin.z, dir.x * dist, dir.y * dist, dir.z * dist, out);
    return out;
  }

  /** True when a straight line between two points is unobstructed. */
  lineOfSight(ax, ay, az, bx, by, bz) {
    return this.world.raySegment(ax, ay, az, bx - ax, by - ay, bz - az, _RAY) >= 1;
  }

  /* ================================================================ *
   * public API — rigid bodies
   * ================================================================ */

  /**
   * Spawn one rigid body.
   *
   * @param {object} o
   *   position {x,y,z} | pos, velocity {x,y,z}, spin {x,y,z},
   *   size {x,y,z} half-extents (or `radius` for a sphere),
   *   mat 0..2 (MAT_RUBBLE|MAT_TIMBER|MAT_BONE), tint, life, restitution,
   *   friction, density
   * @returns {import('./physics/Bodies.js').Body|null}
   */
  spawnBody(o = {}) {
    const b = this.rigid.acquire();
    if (!b) return null;
    const p = o.position ?? o.pos ?? o;
    b.p.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    if (o.radius) b.setSphere(o.radius, o.density ?? 900);
    else {
      const s = o.size ?? { x: 0.09, y: 0.07, z: 0.06 };
      b.setBox(Math.max(0.012, s.x), Math.max(0.012, s.y), Math.max(0.012, s.z), o.density ?? 900);
    }
    if (o.quaternion) b.q.copy(o.quaternion);
    if (o.velocity) b.v.set(o.velocity.x ?? 0, o.velocity.y ?? 0, o.velocity.z ?? 0);
    if (o.spin) b.w.set(o.spin.x ?? 0, o.spin.y ?? 0, o.spin.z ?? 0);
    b.mat = o.mat ?? MAT_RUBBLE;
    b.restitution = o.restitution ?? 0.22;
    b.friction = o.friction ?? 0.66;
    b.life = o.life ?? 24;
    if (o.tint !== undefined) b.tint.set(o.tint);
    else b.tint.setRGB(1, 1, 1);
    return b;
  }

  /**
   * Break a prop into convex-ish chunks that inherit the impact.
   *
   * @param {object} object   a Props placement record, a THREE.Object3D, or any
   *                          {x,y,z,r?,kind?,scale?}
   * @param {object} [o]      {impulse:{x,y,z}|number, point:{x,y,z}, pieces:number,
   *                           mat, tint, spread}
   * @returns {number} how many chunks were spawned
   */
  shatter(object, o = {}) {
    if (!object) return 0;
    const c = _centreOf(object, _v);
    const kind = object.kind ?? object.name ?? '';
    const radius = clamp(
      object.r ?? object.radius ?? (object.geometry?.boundingSphere?.radius ?? 0.45),
      0.16, 1.6
    );
    const scale = object.scale && typeof object.scale === 'number' ? object.scale : 1;
    const pieces = clamp(Math.round(o.pieces ?? (5 + radius * 6)), 3, 16) | 0;
    const mat = o.mat ?? _shatterMat(kind);

    /* Seeded on the quantised centre: the same barrel always breaks the same
       way, which is what makes the frame reproducible. */
    const seed = (_hash3(c.x, c.y, c.z) ^ (this._shatterSeq++ * 2654435761)) >>> 0;
    const rand = this.engine.freshRand(seed);

    const point = o.point ?? c;
    const imp = o.impulse;
    let ix = 0, iy = 0, iz = 0;
    if (typeof imp === 'number') {
      ix = (c.x - point.x); iy = (c.y - point.y) + 0.4; iz = (c.z - point.z);
      const l = Math.hypot(ix, iy, iz) || 1;
      ix = ix / l * imp; iy = iy / l * imp; iz = iz / l * imp;
    } else if (imp) { ix = imp.x ?? 0; iy = imp.y ?? 0; iz = imp.z ?? 0; }

    const gy = this.world.heightAt(c.x, c.z);
    const spread = o.spread ?? 1;
    let made = 0;
    for (let i = 0; i < pieces; i++) {
      /* chunk size falls off so the burst has one or two big pieces and a lot of
         small ones — a uniform size distribution reads as a particle effect */
      const t = i / pieces;
      const f = 0.30 + (1 - t) * (1 - t) * 0.72;
      /* Aspect ratio per material, because the geometry is a unit box and the
         half-extents are what make a chunk read as a stave, a splinter or a
         block. A barrel breaks into long curved staves; masonry breaks into
         blocks; bone splinters. */
      const base = radius * scale * f * (0.26 + rand() * 0.16);
      const ar = mat === MAT_TIMBER ? _AR_STAVE : mat === MAT_BONE ? _AR_SPLINTER : _AR_BLOCK;
      const sx = base * ar[0] * (0.85 + rand() * 0.30);
      const sy = base * ar[1] * (0.85 + rand() * 0.30);
      const sz = base * ar[2] * (0.85 + rand() * 0.30);

      /* spawn on the shell of the original volume, never all at the centre */
      const th = rand() * Math.PI * 2;
      const ph = Math.acos(clamp(rand() * 2 - 1, -1, 1));
      const rr = radius * scale * (0.35 + rand() * 0.55);
      const px = c.x + Math.sin(ph) * Math.cos(th) * rr;
      const pz = c.z + Math.sin(ph) * Math.sin(th) * rr;
      const py = Math.max(gy + sy + 0.01, c.y + Math.cos(ph) * rr * 0.7);

      const b = this.spawnBody({
        position: { x: px, y: py, z: pz },
        size: { x: sx, y: sy, z: sz },
        mat,
        density: mat === MAT_TIMBER ? 620 : mat === MAT_BONE ? 700 : 1500,
        restitution: mat === MAT_TIMBER ? 0.16 : 0.26,
        friction: mat === MAT_TIMBER ? 0.72 : 0.60,
        life: 22 + rand() * 6,
        tint: o.tint,
      });
      if (!b) break;
      made++;

      /* radial burst from the impact point + the inherited impulse */
      let dx = px - point.x, dy = py - point.y, dz = pz - point.z;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      const burst = (1.9 + rand() * 2.6) * spread;
      b.v.set(
        dx * burst + ix * b.invMass,
        Math.abs(dy) * burst * 0.75 + 1.5 + rand() * 1.4 + iy * b.invMass,
        dz * burst + iz * b.invMass
      );
      b.w.set((rand() - 0.5) * 15, (rand() - 0.5) * 15, (rand() - 0.5) * 15);
      b.q.setFromAxisAngle(_v.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), rand() * Math.PI * 2);
      b.tint.setScalar(0.86 + rand() * 0.24);
    }
    return made;
  }

  /**
   * Loose debris with no parent object — gibs, coins, a dropped skull.
   * @returns {number} chunks spawned
   */
  spawnDebris(point, o = {}) {
    if (!point) return 0;
    const n = clamp(Math.round(o.count ?? 6), 1, 20) | 0;
    const seed = (_hash3(point.x, point.y, point.z) ^ (this._debrisSeq++ * 40503)) >>> 0;
    const rand = this.engine.freshRand(seed);
    const mat = o.mat ?? MAT_RUBBLE;
    const sz = o.size ?? 0.075;
    let made = 0;
    for (let i = 0; i < n; i++) {
      const b = this.spawnBody({
        position: { x: point.x + (rand() - 0.5) * 0.12, y: point.y + rand() * 0.12, z: point.z + (rand() - 0.5) * 0.12 },
        size: { x: sz * (0.6 + rand() * 0.8), y: sz * (0.5 + rand() * 0.7), z: sz * (0.6 + rand() * 0.8) },
        mat,
        density: o.density ?? 900,
        restitution: o.restitution ?? 0.3,
        friction: 0.62,
        life: o.life ?? 18,
        tint: o.tint,
      });
      if (!b) break;
      made++;
      const sp = o.speed ?? 2.6;
      const dir = o.dir;
      const ax = dir ? dir.x : (rand() - 0.5) * 2;
      const az = dir ? dir.z : (rand() - 0.5) * 2;
      b.v.set(ax * sp * (0.4 + rand()), (dir?.y ?? 1) * sp * (0.35 + rand() * 0.7), az * sp * (0.4 + rand()));
      b.w.set((rand() - 0.5) * 18, (rand() - 0.5) * 18, (rand() - 0.5) * 18);
      b.tint.setScalar(0.85 + rand() * 0.25);
    }
    return made;
  }

  /* ================================================================ *
   * public API — ragdolls
   * ================================================================ */

  /**
   * Convert a dead character into a ragdoll.
   *
   * Accepts both call shapes in use in the codebase:
   *   physics.ragdoll(entity, {impulse, point})
   *   physics.ragdoll({entity, root, mesh, skeleton, bones, mass, height,
   *                    radius, impulse, hitPoint})            ← Bestiary
   *
   * @returns {object|null} the ragdoll handle, or null when it could not be built
   */
  ragdoll(a, b) {
    if (!a) return null;
    const spec = (a.entity || a.bones || a.skeleton) && !a.isObject3D ? a : { entity: a, ...(b ?? {}) };
    if (b && spec !== a) Object.assign(spec, b);
    return this.ragdolls.create(spec);
  }

  /** Hand a corpse back. Bestiary calls this before pooling the body. */
  releaseRagdoll(entity) { return this.ragdolls.release(entity); }
  removeRagdoll(entity) { return this.ragdolls.release(entity); }
  despawnRagdoll(entity) { return this.ragdolls.release(entity); }
  hasRagdoll(entity) { return this.ragdolls.has(entity); }

  /* ================================================================ *
   * public API — shared verlet solver
   * ================================================================ */

  /** A bare solver, for anything that wants particles + constraints. */
  verlet(opts) { return new Verlet(opts); }
  /** A pinned cloth sheet (cloaks, banners, webs). */
  cloth(opts) { return makeCloth(opts); }
  /** A hanging rope / chain. */
  rope(opts) { return makeRope(opts); }

  /**
   * The world-collision callback a foreign Verlet rig can install so its
   * particles collide with the same geometry everything else does:
   *   const rig = physics.cloth({...}); rig.solver.collide = physics.verletCollider();
   */
  verletCollider(o = {}) {
    const world = this.world;
    const friction = o.friction ?? 0.55;
    const sc = { dx: 0, dy: 0, dz: 0, depth: 0, nx: 0, ny: 0, nz: 0, hit: false, kind: -1 };
    return (solver, i, x, y, z, r) => {
      const k = i * 3;
      let moved = false;
      if (world.solveSphere(x, y, z, r, sc)) {
        solver.p[k] += sc.dx; solver.p[k + 1] += sc.dy; solver.p[k + 2] += sc.dz;
        moved = true;
      }
      const gy = world.heightAt(solver.p[k], solver.p[k + 2]) + r;
      if (solver.p[k + 1] < gy) {
        solver.p[k + 1] = gy;
        moved = true;
        solver.flags[i] = 1;
      }
      if (moved && friction > 0) {
        // tangential damping at the contact, applied through the previous
        // position — the only place a Verlet rig can express friction
        solver.q[k] += (solver.p[k] - solver.q[k]) * friction;
        solver.q[k + 2] += (solver.p[k + 2] - solver.q[k + 2]) * friction;
      }
    };
  }

  /* ================================================================ *
   * characters — nobody walks through a wall
   * ================================================================ */

  /**
   * Hero, Bestiary and the AI's steering all write positions directly, because
   * they were written before this module existed and none of them may be edited
   * from here. So Physics runs after them (see the manifest order) and makes
   * whatever they wrote legal: a horizontal capsule depenetration against the
   * static world, which is invisible when they were already right and hard when
   * they were not.
   */
  _enforceCharacters(dt) {
    let n = 0;
    const eng = this.engine;

    const hero = _live(eng.get('hero'));
    if (hero && hero.position && !hero.noPhysics) {
      n += this._pinActor(hero, hero.radius ?? 0.34, hero.height ?? 1.85, dt) ? 1 : 0;
    }

    const bes = _live(eng.get('bestiary'));
    if (bes && Array.isArray(bes.entities)) {
      const list = bes.entities;
      for (let i = 0; i < list.length; i++) {
        const en = list[i];
        if (!en || !en.position) continue;
        if (en.ragdolled || en.dead) continue;
        if ((en.def?.hover ?? 0) > 0) continue;             // wraiths float
        const r = (en.radius ?? en.def?.radius ?? 0.45) * 0.82;
        const h = Math.max(r * 2.2, (en.height ?? en.def?.height ?? 1.8) * 0.92);
        n += this._pinActor(en, r, h, dt) ? 1 : 0;
      }
    }
    this.stats.chars = n;
  }

  /** @returns {boolean} true if the actor had to be corrected */
  _pinActor(actor, radius, height, dt) {
    const p = actor.position;
    const footY = Number.isFinite(actor.footY) ? actor.footY
      : (Number.isFinite(actor.groundY) ? actor.groundY : p.y);
    const moved = this.controller.depenetrate(p.x, footY, p.z, { radius, height, iterations: 3 });
    if (moved <= 1e-5) return false;
    const r = this.controller.result.position;
    // Correct at a bounded rate: a huge single-frame teleport out of geometry
    // reads worse than a firm shove, and a rebuilt world can put an actor deep
    // inside a new wall.
    const maxStep = Math.max(0.06, 7 * dt);
    let dx = r.x - p.x, dz = r.z - p.z;
    const l = Math.hypot(dx, dz);
    if (l > maxStep) { const f = maxStep / l; dx *= f; dz *= f; }
    p.x += dx; p.z += dz;
    if (actor.velocity) {
      // kill the component that was driving into the wall so the actor does not
      // grind against it while its own steering keeps pushing
      const nx = dx / (l || 1), nz = dz / (l || 1);
      const vd = actor.velocity.x * nx + actor.velocity.z * nz;
      if (vd < 0) { actor.velocity.x -= nx * vd; actor.velocity.z -= nz * vd; }
    }
    if (actor.moveTarget && l > maxStep * 0.9) actor.moveTarget = null;
    return true;
  }

  /* ================================================================ *
   * destructibles
   * ================================================================ */

  /**
   * Props owns destruction (hp, loot, the broken-mesh swap) and may not be
   * edited from here, so the hook is a read-only scan for records that have just
   * flipped to `broken`. Every third frame is plenty — a barrel takes 0.4 s to
   * fall apart visually — and the scan is a flag test per record.
   */
  _scanDestructibles() {
    const frame = this.engine.clock.frame;
    if ((frame % 3) !== 0) return;
    const props = _live(this.engine.get('props'));
    const list = props?.props;
    if (!Array.isArray(list) || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (!rec || !rec.broken || this._brokenSeen.has(rec)) continue;
      this._brokenSeen.add(rec);
      const y = (rec.groundY ?? rec.y ?? 0) + (rec.r ?? 0.4) * 0.6;
      this.shatter(
        { x: rec.x, y, z: rec.z, r: rec.r, kind: rec.kind, scale: rec.scale ?? 1 },
        { point: { x: rec.x, y: y + 0.1, z: rec.z }, pieces: 4 + Math.round((rec.r ?? 0.4) * 7) }
      );
    }
  }

  /* ================================================================ *
   * bus
   * ================================================================ */

  _onDeath(p) {
    if (!p || !p.entity) return;
    const en = p.entity;
    if (en.isHero) return;                       // the player does not ragdoll
    if (this.ragdolls.has(en)) return;
    // Bestiary calls physics.ragdoll() directly from die(); this is the path for
    // anything that only emits the event.
    if (en.ragdolled) return;
    this._pendingDeaths.push({
      entity: en,
      root: en.root, mesh: en.mesh, skeleton: en.skeleton, bones: en.bones,
      mass: en.mass, height: en.height, radius: en.radius,
      hitPoint: p.hitPoint,
      impulse: p.impulse ?? null,
    });
  }

  /** Heavy impacts kick nearby loose debris — cheap, and it sells the weight. */
  _onImpact(p) {
    if (!p || !p.point) return;
    const mag = p.magnitude ?? 1;
    if (mag < 0.7 || this.rigid.activeCount === 0) return;
    const live = this.rigid._live;
    const px = p.point.x, py = p.point.y, pz = p.point.z;
    const r2 = (1.1 + mag * 0.9) ** 2;
    for (let k = 0; k < live.length; k++) {
      const b = this.rigid.bodies[live[k]];
      if (!b.active) continue;
      const dx = b.p.x - px, dy = b.p.y - py, dz = b.p.z - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const f = (1 - Math.sqrt(d2 / r2)) * mag * 0.42;
      const l = Math.sqrt(d2) || 1;
      b.applyImpulse(
        (dx / l) * f * b.mass, (0.5 + dy / l) * f * b.mass, (dz / l) * f * b.mass,
        b.p.x, b.p.y, b.p.z
      );
      b.w.x += (dx / l) * f * 3; b.w.z += (dz / l) * f * 3;
    }
  }

  /**
   * Dropped loot gets a physical bounce. Loot (when it exists) owns the item
   * mesh; all we do here is provide the settle, and only when nothing else
   * claimed the drop.
   */
  _onLootDrop(p) {
    if (!p || !p.position) return;
    const kind = String(p.item?.kind ?? '');
    if (kind === 'gold') {
      this.spawnDebris(p.position, {
        count: 5, size: 0.045, mat: MAT_RUBBLE, density: 2400,
        speed: 2.2, restitution: 0.34, life: 16, tint: 0xd9a94e,
      });
    } else if (kind === 'wood') {
      this.spawnDebris(p.position, {
        count: 4, size: 0.07, mat: MAT_TIMBER, density: 620,
        speed: 1.8, restitution: 0.18, life: 16,
      });
    }
  }

  /* ================================================================ *
   * diagnostics
   * ================================================================ */

  /** A one-line summary for the profiler overlay / harness. */
  report() {
    const s = this.stats;
    return `boxes ${s.boxes} | bodies ${s.bodies} (${s.awake} awake) | ragdolls ${s.ragdolls}` +
      ` | contacts ${s.contacts} | chars ${s.chars} | +${s.drawCalls} calls | ${s.ms.toFixed(2)} ms`;
  }

  /** Structured stats — the verification harness reads this. */
  snapshot() {
    return {
      boxes: this.world.stats.boxes,
      source: this.world.stats.source,
      buildMs: +this.world.stats.buildMs.toFixed(2),
      grid: `${this.world.grid.nx}x${this.world.grid.nz}`,
      bodies: this.rigid.stats.active,
      awake: this.rigid.stats.awake,
      contacts: this.rigid.stats.contacts,
      ragdolls: this.ragdolls.activeCount,
      ragdollsRetired: this.ragdolls.retired.length,
      ragdollsSolving: this.ragdolls.solvingCount,
      ragdollParticles: this.ragdolls.particleCount,
      chars: this.stats.chars,
      drawCalls: this.debris.drawCalls,
      ms: +this.cost.toFixed(3),
    };
  }
}

/* ------------------------------------------------------------------ */

/** Half-extent aspect ratios: [long, thin, wide]. */
const _AR_STAVE = [1.0, 0.20, 0.40];
const _AR_SPLINTER = [1.0, 0.26, 0.26];
const _AR_BLOCK = [1.0, 0.78, 0.86];

const _ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
const _n3 = { x: 0, y: 1, z: 0 };
const _RAY = { t: 1, nx: 0, ny: 0, nz: 0, kind: -1, hit: false };

function _live(m) { return m && !m.__dead ? m : null; }

function _centreOf(o, out) {
  if (o.isObject3D) {
    o.getWorldPosition(out);
    return out;
  }
  return out.set(o.x ?? o.position?.x ?? 0, o.y ?? o.position?.y ?? 0, o.z ?? o.position?.z ?? 0);
}

function _shatterMat(kind) {
  const k = String(kind);
  for (let i = 0; i < SHATTER_MAT.length; i++) {
    if (k.indexOf(SHATTER_MAT[i][0]) >= 0) return SHATTER_MAT[i][1];
  }
  return MAT_RUBBLE;
}

/** Quantise to a millimetre and hash — a stable seed from a world position. */
function _hash3(x, y, z) {
  let h = Math.imul(Math.round(x * 1000) | 0, 374761393)
    ^ Math.imul(Math.round(y * 1000) | 0, 668265263)
    ^ Math.imul(Math.round(z * 1000) | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Diagnostics only — never read back into the simulation. */
function _now() {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

export { K_WALL, K_PROP, MAT_RUBBLE, MAT_TIMBER, MAT_BONE };
export default Physics;
