/**
 * THE NINTH VIGIL — capsule character controller.
 *
 * `moveCapsule(capsule, delta)` is the one function Hero, Bestiary and the AI's
 * steering need: give it where you want to go, get back where you actually got
 * to plus what you touched. Everything about it is written for an isometric ARPG
 * where the player holds a direction into a wall for seconds at a time:
 *
 *  1. **Sweep in bounded substeps.** A single 4 m/frame teleport can pass
 *     through a 0.6 m wall; the move is split so no substep exceeds half the
 *     capsule radius. Fixed division, so it is deterministic.
 *  2. **Depenetrate by accumulation, not by first contact.** In a doorway a
 *     capsule touches two boxes at once; resolving them one at a time makes the
 *     character buzz between them. Summing the escape vectors resolves a corner
 *     in one pass.
 *  3. **Slide, never stop.** The residual motion is projected onto the contact
 *     plane, so running along a wall keeps its full tangential speed. That single
 *     behaviour is the difference between "solid world" and "sticky world".
 *  4. **Step up.** Small ledges (default 0.42 m — a crypt plinth, a slab lip,
 *     rubble) are climbed by lifting the capsule, re-testing and dropping back
 *     down; if the lifted position is also blocked, the step is refused and the
 *     original slide stands.
 *  5. **Slope limit + ground snap.** A surface steeper than the limit is treated
 *     as a wall so nothing walks up the rock mass, and a grounded character is
 *     snapped down to the surface within `snap` metres so it never floats over a
 *     dip or gets airborne on a downslope.
 *
 * The result object is reused per controller to keep the path allocation free;
 * pass `out` if you want to own it.
 */

import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Default capsule metrics, metres. Hero is 1.85 m / r 0.34 (KNOWN_ISSUES.md). */
export const CHAR_DEFAULTS = Object.freeze({
  radius: 0.34,
  height: 1.85,
  step: 0.42,
  slope: 52 * Math.PI / 180,
  snap: 0.45,
  skin: 0.008,
  maxIter: 4,
});

export class CharacterController {
  /** @param {import('./World.js').PhysWorld} world */
  constructor(world, opts = {}) {
    this.world = world;
    this.radius = opts.radius ?? CHAR_DEFAULTS.radius;
    this.height = opts.height ?? CHAR_DEFAULTS.height;
    this.step = opts.step ?? CHAR_DEFAULTS.step;
    this.slopeCos = Math.cos(opts.slope ?? CHAR_DEFAULTS.slope);
    this.snap = opts.snap ?? CHAR_DEFAULTS.snap;
    this.skin = opts.skin ?? CHAR_DEFAULTS.skin;
    this.maxIter = opts.maxIter ?? CHAR_DEFAULTS.maxIter;

    this.result = {
      position: new THREE.Vector3(),
      motion: new THREE.Vector3(),
      groundNormal: new THREE.Vector3(0, 1, 0),
      wallNormal: new THREE.Vector3(),
      grounded: false,
      groundY: 0,
      stepped: false,
      hitWall: false,
      blocked: false,
      slopeAngle: 0,
      kind: -1,
      penetration: 0,
      iterations: 0,
    };
    this._sc = {
      dx: 0, dy: 0, dz: 0, depth: 0, nx: 0, ny: 0, nz: 0, hit: false, kind: -1, topY: 0,
    };
    this._n = { x: 0, y: 1, z: 0 };
  }

  /**
   * Resolve a capsule move.
   *
   * @param {{start:{x,y,z}, end:{x,y,z}, radius:number}|THREE.Capsule} capsule
   *        World-space capsule. Mutated to the resolved position unless
   *        `opts.mutate === false`.
   * @param {{x:number,y:number,z:number}} delta desired displacement, metres
   * @param {object} [opts] {gravityStep, allowStep, snapDown, out, mutate}
   */
  move(capsule, delta, opts = {}) {
    const R = this.result;
    const w = this.world;
    const r = capsule.radius ?? this.radius;
    let ax = capsule.start.x, ay = capsule.start.y, az = capsule.start.z;
    let bx = capsule.end.x, by = capsule.end.y, bz = capsule.end.z;
    const halfSpan = by - ay;              // vertical extent between sphere centres

    let mx = delta?.x ?? 0, my = delta?.y ?? 0, mz = delta?.z ?? 0;
    R.stepped = false; R.hitWall = false; R.blocked = false; R.kind = -1;
    R.grounded = false; R.penetration = 0; R.iterations = 0;
    R.wallNormal.set(0, 0, 0);
    R.groundNormal.set(0, 1, 0);

    /* ---- substep count: never travel more than half a radius at a time ---- */
    const travel = Math.sqrt(mx * mx + my * my + mz * mz);
    const steps = Math.min(8, Math.max(1, Math.ceil(travel / Math.max(0.05, r * 0.5))));
    let sx = mx / steps, sy = my / steps, sz = mz / steps;
    /* the unprojected substep direction, kept so a step-up can push forward even
       after a wall slide has zeroed the into-wall component */
    const osx = sx, osz = sz;
    let stepTop = -Infinity;

    for (let s = 0; s < steps; s++) {
      /* --- advance one substep --- */
      ax += sx; ay += sy; az += sz;
      bx += sx; by += sy; bz += sz;

      /* --- depenetrate --- */
      let groundedHere = false;
      let gnx = 0, gny = 0, gnz = 0;
      let wnx = 0, wny = 0, wnz = 0;
      let hitWall = false;
      let topY = -Infinity;

      for (let it = 0; it < this.maxIter; it++) {
        R.iterations++;
        const c = this._sc;
        if (!w.solveCapsule(ax, ay, az, bx, by, bz, r + this.skin, c)) break;
        if (c.depth > R.penetration) R.penetration = c.depth;
        if (c.topY > topY) topY = c.topY;
        let px = c.dx, py = c.dy, pz = c.dz;
        const pl = Math.sqrt(px * px + py * py + pz * pz);
        if (pl < 1e-7) break;
        // Never let one pass move more than the deepest penetration plus skin:
        // the accumulated sum over-shoots in a corner and would pop the capsule.
        const cap = c.depth + this.skin;
        if (pl > cap) { const f = cap / pl; px *= f; py *= f; pz *= f; }
        ax += px; ay += py; az += pz;
        bx += px; by += py; bz += pz;

        /* classify: a steep contact is a wall even if it points upward */
        if (c.ny >= this.slopeCos) {
          groundedHere = true;
          gnx = c.nx; gny = c.ny; gnz = c.nz;
        } else if (c.ny > -0.6) {
          hitWall = true;
          wnx += c.nx; wny += c.ny; wnz += c.nz;
          R.kind = c.kind;
        }
      }

      /* --- step-up: blocked horizontally with a low ledge in front --- */
      if (hitWall && (opts.allowStep !== false) && this.step > 0 && topY > -Infinity) {
        const lift = topY + this.skin * 2 - (ay - r);
        if (lift > 0.02 && lift <= this.step) {
          /* Lift AND push forward over the lip in one move. Lifting alone leaves
             the capsule hovering beside the ledge with nothing under it, and the
             ground snap at the end of the call then drops it straight back down —
             which is a step-up that reports success and never climbs anything. */
          const tay = ay + lift, tby = by + lift;
          const nudge = Math.max(0.02, r * 0.35);
          const dl = Math.hypot(osx, osz) || 1;
          const nax = ax + (osx / dl) * nudge;
          const naz = az + (osz / dl) * nudge;
          const c2 = this._sc;
          if (!w.solveCapsule(nax, tay, naz, nax + (bx - ax), tby, naz + (bz - az), r + this.skin, c2)
              || c2.depth < this.skin * 2) {
            bx += nax - ax; bz += naz - az;
            ax = nax; az = naz;
            ay = tay; by = tby;
            R.stepped = true;
            stepTop = topY;
            hitWall = false;
            groundedHere = true;
            gnx = 0; gny = 1; gnz = 0;
          }
        }
      }

      /* --- slide the remainder of this substep along the wall --- */
      if (hitWall) {
        const l = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz);
        if (l > 1e-6) {
          wnx /= l; wny /= l; wnz /= l;
          R.wallNormal.set(wnx, wny, wnz);
          R.hitWall = true;
          // Project the remaining per-substep motion onto the wall plane, so
          // running along a wall keeps its tangential speed and a dead-on push
          // stops instead of accumulating into a burst when the wall ends.
          const d = sx * wnx + sy * wny + sz * wnz;
          if (d < 0) { sx -= wnx * d; sy -= wny * d; sz -= wnz * d; }
        }
      }
      if (groundedHere) {
        R.grounded = true;
        R.groundNormal.set(gnx, gny, gnz);
      }
    }
    if (R.hitWall && (sx * sx + sz * sz) < 1e-8) R.blocked = true;
    void mx; void my; void mz;

    /* ---- ground: heightfield + box tops, then snap ---- */
    const footY = ay - r;
    let surf = w.surfaceBelow(ax, az, footY + this.snap * 0.5, this.snap + 0.5, r * 0.55);
    /* A capsule that has just stepped onto a ledge is standing on the ledge, even
       if the query rectangle still overlaps the lower floor beside it. Refusing to
       snap below the ledge is what makes the climb stick. */
    if (R.stepped && stepTop > -Infinity && (!Number.isFinite(surf) || surf < stepTop - 0.02)) {
      surf = stepTop;
    }
    if (Number.isFinite(surf) && surf > -Infinity) {
      R.groundY = surf;
      const gap = footY - surf;
      if (gap <= this.snap && (opts.snapDown !== false)) {
        ay -= gap; by -= gap;
        R.grounded = true;
        w.normalAt(ax, az, this._n);
        if (this._n.y >= this.slopeCos) R.groundNormal.set(this._n.x, this._n.y, this._n.z);
      } else if (gap <= this.skin * 4) {
        R.grounded = true;
      }
    } else {
      R.groundY = footY;
    }

    R.slopeAngle = Math.acos(clamp(R.groundNormal.y, -1, 1));
    R.position.set(ax, ay, az);
    R.motion.set(ax - capsule.start.x, ay - capsule.start.y, az - capsule.start.z);

    if (opts.mutate !== false) {
      capsule.start.set ? capsule.start.set(ax, ay, az) : (capsule.start.x = ax, capsule.start.y = ay, capsule.start.z = az);
      capsule.end.set ? capsule.end.set(bx, by, bz) : (capsule.end.x = bx, capsule.end.y = by, capsule.end.z = bz);
    }
    void halfSpan;
    if (opts.out) {
      const o = opts.out;
      o.position = o.position ?? new THREE.Vector3();
      o.position.copy(R.position);
      o.grounded = R.grounded; o.groundY = R.groundY; o.hitWall = R.hitWall;
      o.stepped = R.stepped; o.penetration = R.penetration; o.kind = R.kind;
      o.groundNormal = (o.groundNormal ?? new THREE.Vector3()).copy(R.groundNormal);
      o.wallNormal = (o.wallNormal ?? new THREE.Vector3()).copy(R.wallNormal);
      return o;
    }
    return R;
  }

  /**
   * Push a standing capsule out of anything it is already inside, without
   * attempting a move. This is what keeps actors driven by another module's
   * movement code (Hero's `_step`, Bestiary's mock brain, AI steering) out of
   * dungeon walls: they write a position, we make it legal.
   *
   * @returns {number} how far the capsule had to be moved, metres
   */
  depenetrate(x, footY, z, opts = {}) {
    const w = this.world;
    const r = opts.radius ?? this.radius;
    const h = Math.max(r * 2.05, opts.height ?? this.height);
    let ax = x, az = z;
    let ay = footY + r;
    let by = footY + h - r;
    if (by < ay) by = ay;
    const c = this._sc;
    let moved = 0;
    const iters = opts.iterations ?? 3;
    let kind = -1;
    for (let it = 0; it < iters; it++) {
      if (!w.solveCapsule(ax, ay, az, ax, by, az, r, c)) break;
      let px = c.dx, pz = c.dz;
      // horizontal only: vertical placement belongs to the owner's ground code
      const pl = Math.sqrt(px * px + pz * pz);
      if (pl < 1e-6) break;
      const cap = c.depth + 1e-3;
      if (pl > cap) { const f = cap / pl; px *= f; pz *= f; }
      ax += px; az += pz;
      moved += Math.sqrt(px * px + pz * pz);
      kind = c.kind;
    }
    const R = this.result;
    R.position.set(ax, footY, az);
    R.penetration = moved;
    R.kind = kind;
    R.hitWall = moved > 1e-5;
    return moved;
  }
}

export default CharacterController;
