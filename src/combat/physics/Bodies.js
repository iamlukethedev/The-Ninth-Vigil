/**
 * SANCTUM — impulse-based rigid bodies + their pooled instanced renderer.
 *
 * Scope: debris, barrel staves, urn shards, dropped loot, skulls and gibs. Tens
 * of small convex chunks, spawned in bursts, that must tumble convincingly, come
 * to rest, and then cost nothing.
 *
 * Formulation — a point cloud per body
 * -----------------------------------
 * Each body carries a handful of collision points (the 8 corners of its box, or
 * a single centre for a sphere). Collision resolves each point against the
 * static AABB soup with a full impulse at the contact — normal impulse with
 * restitution plus a Coulomb friction impulse in the tangent plane, both applied
 * through the body's inverse inertia so the chunk *spins* when it clips an edge.
 * This is the classic approach for convex debris: it has no manifold-generation
 * step to get wrong, its worst failure mode is a slightly soft corner rather
 * than a tunnelling body, and it is trivially deterministic — the points are
 * visited in a fixed order.
 *
 * Stability
 * ---------
 *   • two fixed substeps, so a 6 m/s shard advances 5 cm per solve
 *   • penetration is removed by position correction, never by injecting velocity
 *     (Baumgarte with a slop band — the classic jitter cause is correcting the
 *     last half-millimetre forever)
 *   • restitution is killed below a threshold normal speed, which is what makes
 *     a bouncing chunk actually settle instead of buzzing
 *   • sleeping: below 0.055 m/s and 0.35 rad/s for 0.4 s the body is frozen and
 *     removed from the solve entirely. It never wakes on its own.
 *
 * Rendering: one InstancedMesh per (geometry, material) pair, count driven down
 * to 0 and `visible=false` when the pool is empty, so an idle frame pays nothing.
 * Three pairs total — rubble, timber, bone — which is 3 draw calls in the worst
 * case and 0 at rest.
 */

import * as THREE from 'three';
import { makeRand } from '../../core/Rand.js';

const GRAV = -9.81;
const SUBSTEPS = 2;
const SLOP = 0.0035;
const BETA = 0.42;
const REST_VEL = 0.42;        // below this normal speed, no bounce
const SLEEP_V = 0.055;
const SLEEP_W = 0.35;
const SLEEP_T = 0.40;
const MAX_V = 22;
const MAX_W = 24;

/** Material classes. Index into DebrisRenderer's pools. */
export const MAT_RUBBLE = 0;
export const MAT_TIMBER = 1;
export const MAT_BONE = 2;
export const MAT_COUNT = 3;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/* ==================================================================== *
 * body
 * ==================================================================== */

class Body {
  constructor() {
    this.active = false;
    this.sleeping = false;
    this.p = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.w = new THREE.Vector3();
    this.he = new THREE.Vector3(0.1, 0.1, 0.1);   // half extents (metres)
    this.invMass = 1;
    this.invI = new THREE.Vector3(1, 1, 1);       // diagonal, body space
    this.restitution = 0.22;
    this.friction = 0.62;
    this.linDamp = 0.30;                          // per second
    this.angDamp = 0.55;
    this.mat = MAT_RUBBLE;
    this.tint = new THREE.Color(1, 1, 1);
    this.rough = 1;
    this.slot = -1;
    this.stillT = 0;
    this.age = 0;
    this.life = 26;
    this.fade = 0;
    this.points = 8;
    this.pr = 0.02;                               // point collision radius
    this.groundBias = 0;
    this.seq = 0;
  }

  setBox(hx, hy, hz, density = 900) {
    this.he.set(hx, hy, hz);
    const m = Math.max(0.02, 8 * hx * hy * hz * density * 0.001);
    this.invMass = 1 / m;
    // solid box inertia, diagonal
    const k = m / 3;
    const ix = k * (hy * hy + hz * hz);
    const iy = k * (hx * hx + hz * hz);
    const iz = k * (hx * hx + hy * hy);
    this.invI.set(1 / Math.max(1e-5, ix), 1 / Math.max(1e-5, iy), 1 / Math.max(1e-5, iz));
    this.points = 8;
    this.pr = Math.min(hx, hy, hz) * 0.30;
    return this;
  }

  setSphere(r, density = 900) {
    this.he.set(r, r, r);
    const m = Math.max(0.02, (4 / 3) * Math.PI * r * r * r * density * 0.001);
    this.invMass = 1 / m;
    const i = 0.4 * m * r * r;
    this.invI.setScalar(1 / Math.max(1e-5, i));
    this.points = 1;
    this.pr = r;
    return this;
  }

  get mass() { return 1 / this.invMass; }

  /** Impulse (N·s) at a world point. Wakes the body. */
  applyImpulse(ix, iy, iz, px, py, pz) {
    this.sleeping = false;
    this.stillT = 0;
    this.v.x += ix * this.invMass;
    this.v.y += iy * this.invMass;
    this.v.z += iz * this.invMass;
    if (px !== undefined) {
      // torque = r x J, converted through the body-space inverse inertia
      _v.set(px - this.p.x, py - this.p.y, pz - this.p.z);
      _v2.set(iy * _v.z - iz * _v.y, iz * _v.x - ix * _v.z, ix * _v.y - iy * _v.x);
      _q.copy(this.q).invert();
      _v2.applyQuaternion(_q);
      _v2.x *= this.invI.x; _v2.y *= this.invI.y; _v2.z *= this.invI.z;
      _v2.applyQuaternion(this.q);
      this.w.add(_v2);
    }
    if (this.w.length() > MAX_W) this.w.setLength(MAX_W);
    if (this.v.length() > MAX_V) this.v.setLength(MAX_V);
  }
}

/* ==================================================================== *
 * solver
 * ==================================================================== */

export class RigidWorld {
  /**
   * @param {import('./World.js').PhysWorld} world
   * @param {number} capacity
   */
  constructor(world, capacity = 160) {
    this.world = world;
    this.capacity = capacity;
    /** @type {Body[]} */
    this.bodies = [];
    this._free = [];
    for (let i = 0; i < capacity; i++) {
      const b = new Body();
      this.bodies.push(b);
      this._free.push(i);
    }
    this._live = [];               // indices of active bodies, spawn order
    this._sc = { dx: 0, dy: 0, dz: 0, depth: 0, nx: 0, ny: 0, nz: 0, hit: false, kind: -1 };
    this.stats = { active: 0, awake: 0, contacts: 0 };
    this._seq = 0;
  }

  /** Oldest active body, for eviction when the pool is exhausted. */
  _evict() {
    let best = -1, bestSeq = Infinity;
    for (let k = 0; k < this._live.length; k++) {
      const b = this.bodies[this._live[k]];
      if (b.seq < bestSeq) { bestSeq = b.seq; best = this._live[k]; }
    }
    if (best >= 0) this.release(this.bodies[best]);
  }

  /** @returns {Body|null} */
  acquire() {
    if (!this._free.length) this._evict();
    const i = this._free.pop();
    if (i === undefined) return null;
    const b = this.bodies[i];
    b.active = true;
    b.sleeping = false;
    b.v.set(0, 0, 0);
    b.w.set(0, 0, 0);
    b.q.set(0, 0, 0, 1);
    b.stillT = 0;
    b.age = 0;
    b.fade = 0;
    b.slot = -1;
    b.groundBias = 0;
    b.seq = ++this._seq;
    b.__i = i;
    this._live.push(i);
    return b;
  }

  release(b) {
    if (!b || !b.active) return;
    b.active = false;
    const i = b.__i;
    const k = this._live.indexOf(i);
    if (k >= 0) this._live.splice(k, 1);
    this._free.push(i);
  }

  clear() {
    for (let k = this._live.length - 1; k >= 0; k--) this.release(this.bodies[this._live[k]]);
  }

  get activeCount() { return this._live.length; }

  /* ------------------------------------------------------------- step */

  step(dt) {
    const n = this._live.length;
    this.stats.active = n;
    this.stats.awake = 0;
    this.stats.contacts = 0;
    if (!n) return;
    const h = dt / SUBSTEPS;

    for (let s = 0; s < SUBSTEPS; s++) {
      for (let k = 0; k < n; k++) {
        const b = this.bodies[this._live[k]];
        if (!b.active || b.sleeping) continue;
        this._integrate(b, h);
        this._collide(b, h);
      }
      this._separate();
    }

    /* ---- ageing, sleeping bookkeeping, fade-out ---- */
    for (let k = this._live.length - 1; k >= 0; k--) {
      const b = this.bodies[this._live[k]];
      if (!b.active) continue;
      b.age += dt;
      if (!b.sleeping) {
        this.stats.awake++;
        if (b.v.lengthSq() < SLEEP_V * SLEEP_V && b.w.lengthSq() < SLEEP_W * SLEEP_W) {
          b.stillT += dt;
          if (b.stillT >= SLEEP_T) {
            b.sleeping = true;
            b.v.set(0, 0, 0);
            b.w.set(0, 0, 0);
          }
        } else b.stillT = 0;
      }
      if (b.age > b.life) {
        b.fade = Math.min(1, b.fade + dt * 1.6);
        if (b.fade >= 1) this.release(b);
      }
    }
  }

  _integrate(b, h) {
    b.v.y += GRAV * h;
    const ld = Math.exp(-b.linDamp * h);
    const ad = Math.exp(-b.angDamp * h);
    b.v.multiplyScalar(ld);
    b.w.multiplyScalar(ad);
    if (b.v.lengthSq() > MAX_V * MAX_V) b.v.setLength(MAX_V);
    if (b.w.lengthSq() > MAX_W * MAX_W) b.w.setLength(MAX_W);
    b.p.x += b.v.x * h; b.p.y += b.v.y * h; b.p.z += b.v.z * h;
    /* q += 0.5 * (w (x) q) * h — first-order, renormalised */
    const wx = b.w.x * 0.5 * h, wy = b.w.y * 0.5 * h, wz = b.w.z * 0.5 * h;
    const { x, y, z, w } = b.q;
    b.q.set(
      x + (wx * w + wy * z - wz * y),
      y + (wy * w + wz * x - wx * z),
      z + (wz * w + wx * y - wy * x),
      w - (wx * x + wy * y + wz * z)
    ).normalize();
  }

  /** Resolve every collision point of `b` against the static world. */
  _collide(b, h) {
    const c = this._sc;
    const world = this.world;
    const np = b.points;
    let corrX = 0, corrY = 0, corrZ = 0, nCorr = 0;

    for (let i = 0; i < np; i++) {
      /* --- world position of the point --- */
      let rx, ry, rz;
      if (np === 1) { rx = 0; ry = 0; rz = 0; } else {
        rx = (i & 1) ? b.he.x : -b.he.x;
        ry = (i & 2) ? b.he.y : -b.he.y;
        rz = (i & 4) ? b.he.z : -b.he.z;
        _v.set(rx, ry, rz).applyQuaternion(b.q);
        rx = _v.x; ry = _v.y; rz = _v.z;
      }
      const px = b.p.x + rx, py = b.p.y + ry, pz = b.p.z + rz;

      /* --- static geometry --- */
      let nx = 0, ny = 0, nz = 0, depth = 0;
      if (world.solveSphere(px, py, pz, b.pr, c)) {
        nx = c.nx; ny = c.ny; nz = c.nz; depth = c.depth;
      }
      /* --- heightfield floor (never boxed; exact and cheap) --- */
      const gy = world.heightAt(px, pz);
      const gd = (gy + b.pr) - py;
      if (gd > depth) {
        world.normalAt(px, pz, _gn, 0.4);
        nx = _gn.x; ny = _gn.y; nz = _gn.z; depth = gd;
      }
      if (depth <= 0) continue;
      this.stats.contacts++;

      /* --- relative velocity at the point --- */
      const vpx = b.v.x + (b.w.y * rz - b.w.z * ry);
      const vpy = b.v.y + (b.w.z * rx - b.w.x * rz);
      const vpz = b.v.z + (b.w.x * ry - b.w.y * rx);
      const vn = vpx * nx + vpy * ny + vpz * nz;

      if (vn < 0) {
        const kn = this._effMass(b, rx, ry, rz, nx, ny, nz);
        const e = -vn > REST_VEL ? b.restitution : 0;
        const jn = (-(1 + e) * vn) / kn;
        this._applyAt(b, nx * jn, ny * jn, nz * jn, rx, ry, rz);

        /* --- Coulomb friction in the tangent plane --- */
        const nvx = b.v.x + (b.w.y * rz - b.w.z * ry);
        const nvy = b.v.y + (b.w.z * rx - b.w.x * rz);
        const nvz = b.v.z + (b.w.x * ry - b.w.y * rx);
        const dn = nvx * nx + nvy * ny + nvz * nz;
        let tx = nvx - nx * dn, ty = nvy - ny * dn, tz = nvz - nz * dn;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tl > 1e-5) {
          tx /= tl; ty /= tl; tz /= tl;
          const kt = this._effMass(b, rx, ry, rz, tx, ty, tz);
          let jt = -tl / kt;
          const lim = b.friction * jn;
          if (jt < -lim) jt = -lim;
          this._applyAt(b, tx * jt, ty * jt, tz * jt, rx, ry, rz);
        }
      }

      /* --- position correction, accumulated and averaged --- */
      const pen = depth - SLOP;
      if (pen > 0) {
        corrX += nx * pen; corrY += ny * pen; corrZ += nz * pen;
        nCorr++;
      }
    }

    if (nCorr) {
      const f = BETA / nCorr;
      b.p.x += corrX * f; b.p.y += corrY * f; b.p.z += corrZ * f;
    }
    void h;
  }

  /** 1/m + n·((I⁻¹(r×n))×r) — the denominator of the impulse. */
  _effMass(b, rx, ry, rz, nx, ny, nz) {
    // r x n
    let ax = ry * nz - rz * ny, ay = rz * nx - rx * nz, az = rx * ny - ry * nx;
    // to body space, scale by invI, back to world
    _v.set(ax, ay, az).applyQuaternion(_q.copy(b.q).invert());
    _v.x *= b.invI.x; _v.y *= b.invI.y; _v.z *= b.invI.z;
    _v.applyQuaternion(b.q);
    ax = _v.x; ay = _v.y; az = _v.z;
    // (I⁻¹(r×n)) x r
    const cx = ay * rz - az * ry, cy = az * rx - ax * rz, cz = ax * ry - ay * rx;
    return b.invMass + (cx * nx + cy * ny + cz * nz);
  }

  _applyAt(b, jx, jy, jz, rx, ry, rz) {
    b.v.x += jx * b.invMass; b.v.y += jy * b.invMass; b.v.z += jz * b.invMass;
    let tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
    _v.set(tx, ty, tz).applyQuaternion(_q.copy(b.q).invert());
    _v.x *= b.invI.x; _v.y *= b.invI.y; _v.z *= b.invI.z;
    _v.applyQuaternion(b.q);
    b.w.x += _v.x; b.w.y += _v.y; b.w.z += _v.z;
    if (b.w.lengthSq() > MAX_W * MAX_W) b.w.setLength(MAX_W);
    if (b.v.lengthSq() > MAX_V * MAX_V) b.v.setLength(MAX_V);
  }

  /**
   * Body-vs-body separation, bounding spheres, one pass, O(n²) over awake
   * bodies only. At 60 awake chunks that is 1 770 cheap tests — far less than
   * building a grid for them, and it stops debris piles from interpenetrating
   * into a single blob, which is the tell that gives a fake pile away.
   */
  _separate() {
    const live = this._live;
    const n = live.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const a = this.bodies[live[i]];
      if (!a.active) continue;
      const ra = a.he.length() * 0.72;
      for (let j = i + 1; j < n; j++) {
        const b = this.bodies[live[j]];
        if (!b.active) continue;
        if (a.sleeping && b.sleeping) continue;
        const rb = b.he.length() * 0.72;
        const rr = ra + rb;
        let dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, dz = b.p.z - a.p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-9) continue;
        const d = Math.sqrt(d2);
        const inv = 1 / d;
        dx *= inv; dy *= inv; dz *= inv;
        const pen = (rr - d) * 0.5;
        const wa = a.invMass, wb = b.invMass;
        const tot = wa + wb;
        if (tot < 1e-9) continue;
        const fa = (wa / tot) * pen, fb = (wb / tot) * pen;
        a.p.x -= dx * fa; a.p.y -= dy * fa; a.p.z -= dz * fa;
        b.p.x += dx * fb; b.p.y += dy * fb; b.p.z += dz * fb;
        /* exchange a little normal velocity so the pile settles rather than
           trading position corrections forever */
        const rvn = (b.v.x - a.v.x) * dx + (b.v.y - a.v.y) * dy + (b.v.z - a.v.z) * dz;
        if (rvn < 0) {
          const j2 = (-rvn * 0.55) / tot;
          if (!a.sleeping) { a.v.x -= dx * j2 * wa; a.v.y -= dy * j2 * wa; a.v.z -= dz * j2 * wa; }
          if (!b.sleeping) { b.v.x += dx * j2 * wb; b.v.y += dy * j2 * wb; b.v.z += dz * j2 * wb; }
          if (a.sleeping && rvn < -0.4) { a.sleeping = false; a.stillT = 0; }
          if (b.sleeping && rvn < -0.4) { b.sleeping = false; b.stillT = 0; }
        }
      }
    }
  }
}

const _gn = { x: 0, y: 1, z: 0 };

/* ==================================================================== *
 * renderer
 * ==================================================================== */

/**
 * Pooled instanced renderer for the rigid bodies. Three geometry/material pairs
 * cover everything the game breaks: masonry rubble, split timber, bone.
 *
 * Texture units: `map` + `normalMap` only, two samplers per material. The
 * project sits at 14/16 worst case (KNOWN_ISSUES.md) — a debris chunk 26 m from
 * the camera gets nothing from an ORM fetch that a tinted instance colour and a
 * normal map do not already give it, and three samplers here would be three
 * samplers the CSM cascades cannot have.
 */
export class DebrisRenderer {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine, capacity = 160) {
    this.engine = engine;
    this.capacity = capacity;
    this.group = new THREE.Group();
    this.group.name = 'physics:debris';
    this.group.matrixAutoUpdate = false;
    /** @type {Array<{mesh:THREE.InstancedMesh, n:number}>} */
    this.pools = [];
    this._geos = [];
    this._mats = [];
    this.drawCalls = 0;
  }

  init() {
    const rand = makeRand(0x5ede15);
    const geos = [
      chunkGeometry(rand.fork(1), 0.19),        // rubble — blocky, chipped
      plankGeometry(rand.fork(2)),              // timber — split stave
      shardGeometry(rand.fork(3)),              // bone   — elongated splinter
    ];
    /* Palette: the crypt's own values (KNOWN_ISSUES.md art direction — cold
       desaturated base). Rubble is wet slate, not concrete; timber is dark
       weathered oak, not pine; bone is aged ivory, not white. A chunk brighter
       than the floor it lands on reads as litter dropped in from another game. */
    const kinds = ['stone', 'wood', 'bone'];
    const tints = [0x5d6068, 0x5e472c, 0xa8a087];
    const roughs = [0.94, 0.88, 0.80];
    const caps = [Math.ceil(capacityShare(this.capacity, 0)), Math.ceil(capacityShare(this.capacity, 1)), Math.ceil(capacityShare(this.capacity, 2))];

    for (let i = 0; i < MAT_COUNT; i++) {
      const mat = this._material(kinds[i], tints[i], roughs[i]);
      const mesh = new THREE.InstancedMesh(geos[i], mat, caps[i]);
      mesh.name = `physics:debris:${kinds[i]}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;      // instances move far from the pool origin
      mesh.count = 0;
      mesh.visible = false;
      const colors = new THREE.InstancedBufferAttribute(new Float32Array(caps[i] * 3), 3);
      colors.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = colors;
      mesh.geometry.setAttribute('instanceColor', colors);
      this.group.add(mesh);
      this.pools.push({ mesh, n: 0, cap: caps[i] });
      this._geos.push(geos[i]);
      this._mats.push(mat);
    }
    this.engine.scene.add(this.group);
    return this;
  }

  _material(kind, tint, rough) {
    let map = null, normalMap = null;
    try {
      const a = this.engine.assets;
      if (a && typeof a.pbr === 'function') {
        // 0.5 m per texture tile: a 20 cm chunk shows real grain rather than a
        // smear, and matches the 0.23 m sett scale the rest of the crypt uses.
        const set = a.pbr({ kind, size: 256, seed: 3313, tiling: 2.0 });
        map = set.map ?? null;
        normalMap = set.normalMap ?? null;
      }
    } catch { /* forge out of budget — vertex colour carries it */ }
    const mat = new THREE.MeshStandardMaterial({
      color: tint,
      map,
      normalMap,
      roughness: rough,
      metalness: 0.02,
      vertexColors: true,
      dithering: true,
      // Flat shading is not a stylistic choice here: a 20 cm chunk is 12 px on
      // screen, and only hard facets give it an edge that catches a highlight.
      // Smoothed normals turn every chunk into a pebble.
      flatShading: true,
    });
    mat.name = `physics:${kind}`;
    if (normalMap) mat.normalScale.set(0.85, 0.85);
    _instanceColorPatch(mat);
    return mat;
  }

  /** Write every live body's transform into the instance buffers. */
  sync(rigid) {
    for (let i = 0; i < this.pools.length; i++) this.pools[i].n = 0;
    const live = rigid._live;
    for (let k = 0; k < live.length; k++) {
      const b = rigid.bodies[live[k]];
      if (!b.active) continue;
      const pool = this.pools[b.mat] ?? this.pools[0];
      if (pool.n >= pool.cap) continue;
      const i = pool.n++;
      const shrink = b.fade > 0 ? Math.max(0.001, 1 - b.fade) : 1;
      _s.set(b.he.x * 2 * shrink, b.he.y * 2 * shrink, b.he.z * 2 * shrink);
      _m.compose(b.p, b.q, _s);
      pool.mesh.setMatrixAt(i, _m);
      pool.mesh.instanceColor.setXYZ(i, b.tint.r, b.tint.g, b.tint.b);
    }
    let calls = 0;
    for (let i = 0; i < this.pools.length; i++) {
      const p = this.pools[i];
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;
      if (p.n > 0) {
        calls++;
        p.mesh.instanceMatrix.needsUpdate = true;
        p.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.drawCalls = calls;
  }

  dispose() {
    for (const g of this._geos) { try { g.dispose(); } catch { /* noop */ } }
    for (const m of this._mats) { try { m.dispose(); } catch { /* noop */ } }
    this._geos.length = 0; this._mats.length = 0;
    this.pools.length = 0;
    this.group.removeFromParent();
  }
}

function capacityShare(total, i) {
  const share = [0.5, 0.3, 0.24];
  return Math.max(16, total * share[i]);
}

/**
 * three's stock instanceColor path multiplies diffuse by the attribute, which is
 * exactly what we want, but only when the material declares USE_INSTANCING_COLOR.
 * Setting `mesh.instanceColor` after construction does not raise the define, so
 * raise it here — cheaper and less fragile than rebuilding the mesh.
 */
function _instanceColorPatch(mat) {
  mat.defines = mat.defines ?? {};
  mat.defines.USE_INSTANCING_COLOR = '';
  mat.defines.USE_INSTANCING_COLOR_ALPHA = undefined;
  mat.needsUpdate = true;
}

/* ------------------------------------------------------------------ *
 * chunk geometries — convex-ish, flat shaded, deterministic
 * ------------------------------------------------------------------ */

/**
 * A chipped masonry chunk.
 *
 * Every chunk geometry in this file is authored to a **unit 1x1x1 extent**, and
 * the instance matrix scales it by the body's full extents. That is not tidiness:
 * the collider is the body's half-extents, so any geometry that does not fill its
 * own unit box leaves the visual floating above the floor it is resting on, which
 * is the "nothing floats" instant-fail in CRITIC_RUBRIC.md. Aspect ratio — stave,
 * splinter, block — comes from the half-extents chosen at spawn, not from the
 * geometry.
 *
 * A jittered *box*, not a jittered sphere. Broken ashlar fails along bedding
 * planes and mortar joints, so a fragment is a wedge with three or four large
 * flat faces and one fresh conchoidal break; an icosahedron with radial noise
 * reads as a potato no matter how much noise you add, which is exactly what the
 * first pass of this looked like. Each of the 8 corners is displaced once (shared
 * by the three faces meeting there, so the solid stays convex) and one corner is
 * sheared hard to make the fracture face.
 */
export function chunkGeometry(rand, jitter = 0.17) {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  _jitterCorners(g, rand, jitter, (rand() * 8) | 0, 2.1);
  _fitUnit(g);
  g.computeVertexNormals();
  _tintVertices(g, rand, 0.20);
  _boxUV(g, 1);
  return g;
}

/**
 * A split barrel stave / broken plank. Unit extent; the stave proportion is the
 * body's. Ends are tapered and the long faces are cambered, so a pile of them
 * does not read as a stack of floor tiles.
 */
export function plankGeometry(rand) {
  const g = new THREE.BoxGeometry(1, 1, 1, 3, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    /* taper toward the split ends, and bow the stave slightly */
    const t = 1 - Math.abs(x) * 0.42;
    const camber = (1 - x * x * 4) * 0.10;
    pos.setXYZ(
      i,
      x,
      y * t + camber * Math.sign(y || 1) * 0.5 + (rand() - 0.5) * 0.05,
      z * t + (rand() - 0.5) * 0.06
    );
  }
  _fitUnit(g);
  g.computeVertexNormals();
  _tintVertices(g, rand, 0.22);
  _boxUV(g, 1);
  return g;
}

/** A bone splinter: a five-sided prism, tapered and jittered. Unit extent. */
export function shardGeometry(rand) {
  const g = new THREE.CylinderGeometry(0.34, 0.5, 1.0, 5, 1, false);
  g.rotateZ(Math.PI * 0.5);
  g.scale(1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = 0.82 + rand() * 0.36;
    pos.setXYZ(i, x, pos.getY(i) * t, pos.getZ(i) * t);
  }
  _fitUnit(g);
  g.computeVertexNormals();
  _tintVertices(g, rand, 0.16);
  _boxUV(g, 1);
  return g;
}

/**
 * Rescale and recentre a geometry so its bounding box is exactly the unit cube.
 * This is what guarantees the rendered chunk touches the floor its collider is
 * resting on — see the note on chunkGeometry.
 */
function _fitUnit(g) {
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cy = (bb.min.y + bb.max.y) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  const sx = 1 / Math.max(1e-4, bb.max.x - bb.min.x);
  const sy = 1 / Math.max(1e-4, bb.max.y - bb.min.y);
  const sz = 1 / Math.max(1e-4, bb.max.z - bb.min.z);
  g.translate(-cx, -cy, -cz);
  g.scale(sx, sy, sz);
}

/** Displace each of a box's 8 corners once, keeping the solid convex. */
function _jitterCorners(g, rand, jitter, broken, brokenMul) {
  const off = new Float32Array(24);
  for (let c = 0; c < 8; c++) {
    off[c * 3] = (rand() - 0.5) * 2 * jitter;
    off[c * 3 + 1] = (rand() - 0.5) * 2 * jitter;
    off[c * 3 + 2] = (rand() - 0.5) * 2 * jitter;
  }
  off[broken * 3] *= brokenMul;
  off[broken * 3 + 1] *= brokenMul;
  off[broken * 3 + 2] *= brokenMul;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const c = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0);
    /* pull inward only, so the hull never exceeds the unit box */
    pos.setXYZ(
      i,
      x - Math.sign(x) * Math.abs(off[c * 3]),
      y - Math.sign(y) * Math.abs(off[c * 3 + 1]),
      z - Math.sign(z) * Math.abs(off[c * 3 + 2])
    );
  }
}

/** Per-vertex value noise so a chunk is never one flat colour. */
function _tintVertices(g, rand, amp) {
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = 1 - rand() * amp;
    // slight warm/cool split by facing: up-facing dust, cavity grime
    const up = pos.getY(i) > 0 ? 1.04 : 0.93;
    col[i * 3] = v * up;
    col[i * 3 + 1] = v * up * 0.995;
    col[i * 3 + 2] = v * up * 0.975;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Triplanar-ish UVs from object space, so the tiling texture lands in metres. */
function _boxUV(g, scale) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = pos.getX(i); v = pos.getZ(i); }
    else if (nx >= nz) { u = pos.getZ(i); v = pos.getY(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv[i * 2] = u / scale;
    uv[i * 2 + 1] = v / scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export { Body };
export default RigidWorld;
