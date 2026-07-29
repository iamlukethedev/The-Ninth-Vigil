/**
 * SANCTUM — ragdolls.
 *
 * On death an enemy's skeleton becomes a constrained chain of bodies: one body
 * per major bone, joint limits that forbid impossible poses, collision against
 * the world and against itself, and the killing blow's impulse applied at the
 * hit point so the corpse flies the way the swing sent it. Then it settles and
 * sleeps. A ragdoll that vibrates on the floor forever is worse than none, so
 * sleeping is not an optimisation here, it is a correctness requirement.
 *
 * The formulation, and why
 * -----------------------
 * Each bone is represented by the *segment between two joint particles* rather
 * than by a free rigid body with a quaternion. Three consequences, all of them
 * the reason this reads well:
 *
 *   • **No twist DOF exists.** A segment has no roll to simulate, so "a neck
 *     must not spin" is true by construction — there is no state that could
 *     encode a spun neck. The bone's roll is reconstructed for rendering from
 *     the previous frame by minimal rotation, which is temporally coherent and
 *     drift-free.
 *   • **Bone lengths are exact.** A distance projection cannot stretch, at any
 *     impulse, so a corpse cannot be pulled into spaghetti by a big hit.
 *   • **It cannot explode.** Every constraint is a position projection, which
 *     removes energy or leaves it alone; it never adds. Combined with the
 *     per-substep travel clamp in Verlet.js the worst case is a stiff corpse,
 *     never a launched one.
 *
 * Joint limits are *relative*, which is the part that matters. Each limit stores
 * the parent and child directions as they were at the moment of death — a pose
 * that came out of an animation clip and is therefore anatomically valid — and
 * each solve transports that reference along with the live parent segment by
 * minimal rotation. Knees and elbows get a hinge (in-plane, with a signed bend
 * range that allows deep flexion and forbids hyperextension past straight);
 * everything else gets a cone whose half-angle comes from the joint class.
 *
 * Skinning hand-off
 * -----------------
 * The bodies are solved in world space; each frame the bone hierarchy is written
 * back by converting each simulated bone's world matrix into its parent-relative
 * local, parent-first. The entity's own root scale is preserved in the composed
 * world matrix, so an elite at 1.16x does not snap back to 1.0x when it dies.
 * Bones that are not simulated (jaw, hands, toes) keep their last animated local
 * pose and simply follow, which is exactly right — a corpse's fingers do not
 * need physics.
 */

import * as THREE from 'three';
import { Verlet } from './Verlet.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _sc = new THREE.Vector3(1, 1, 1);
const _pos = new THREE.Vector3();
const _rot = new THREE.Quaternion();

/* ------------------------------------------------------------------ *
 * joint taxonomy
 * ------------------------------------------------------------------ */

/**
 * Bone name -> joint class. Covers the biped / quadruped / floater naming
 * contract in chars/monsters/Rigs.js, and degrades to 'other' for anything a
 * future rig invents.
 */
export function jointClass(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'root') return 'root';
  if (n.startsWith('hips') || n.startsWith('pelvis')) return 'pelvis';
  if (n.startsWith('spine')) return 'spine';
  if (n.startsWith('chest') || n.startsWith('torso')) return 'chest';
  if (n.startsWith('neck')) return 'neck';
  if (n.startsWith('head') || n.startsWith('skull')) return 'head';
  if (n.startsWith('jaw') || n.startsWith('mandible')) return 'jaw';
  if (n.startsWith('clav')) return 'clav';
  if (n.startsWith('shoulder') || n.startsWith('upperarm')) return 'shoulder';
  if (n.startsWith('elbow') || n.startsWith('forearm')) return 'elbow';
  if (n.startsWith('wrist')) return 'wrist';
  if (n.startsWith('hand') || n.startsWith('finger') || n.startsWith('thumb')) return 'hand';
  if (n.startsWith('fhip') || n.startsWith('bhip') || n.startsWith('hip') || n.startsWith('thigh')) return 'hip';
  if (n.startsWith('fknee') || n.startsWith('bknee') || n.startsWith('knee') || n.startsWith('shin')) return 'knee';
  if (n.startsWith('fankle') || n.startsWith('bankle') || n.startsWith('ankle')) return 'ankle';
  if (n.startsWith('fpaw') || n.startsWith('bpaw') || n.startsWith('paw') || n.startsWith('toe') || n.startsWith('foot')) return 'foot';
  if (n.startsWith('tail')) return 'tail';
  if (n.startsWith('wing')) return 'tail';
  if (n.startsWith('horn')) return 'head';
  return 'other';
}

/** Bones physics does not need to own — they follow their parent. */
const SKIP = new Set(['jaw', 'hand', 'foot']);

/** Relative mass, radius (x body scale, metres), and limit per class. */
const J = {
  root: { m: 0.10, r: 0.130, cone: 0.55 },
  pelvis: { m: 0.165, r: 0.155, cone: 0.34 },
  spine: { m: 0.105, r: 0.145, cone: 0.30 },
  chest: { m: 0.160, r: 0.160, cone: 0.30 },
  neck: { m: 0.030, r: 0.065, cone: 0.42 },
  head: { m: 0.075, r: 0.115, cone: 0.34 },
  clav: { m: 0.022, r: 0.070, cone: 0.45 },
  shoulder: { m: 0.046, r: 0.085, cone: 1.05 },
  elbow: { m: 0.030, r: 0.065, cone: 0.60, hinge: true, flex: 1.95, hyper: 0.10 },
  wrist: { m: 0.013, r: 0.050, cone: 0.62 },
  hip: { m: 0.092, r: 0.092, cone: 1.00 },
  knee: { m: 0.052, r: 0.072, cone: 0.60, hinge: true, flex: 1.85, hyper: 0.07 },
  ankle: { m: 0.019, r: 0.056, cone: 0.62 },
  tail: { m: 0.016, r: 0.050, cone: 0.78 },
  other: { m: 0.030, r: 0.056, cone: 0.62 },
};

/** Preference when a bone has several simulated children — the "spine" wins. */
const PRIMARY = {
  spine: 10, chest: 10, neck: 9, head: 9,
  knee: 8, ankle: 8, elbow: 8, wrist: 8,
  pelvis: 7, tail: 6, other: 5, hip: 3, shoulder: 3, clav: 2, root: 1,
};

const MAX_PARTICLES = 22;
const HINGE_LATERAL = 0.16;
/** Quiesce window, seconds since death. See Ragdoll.step. */
const QUIET_FROM = 1.9;
const QUIET_TO = 2.9;

/* ==================================================================== *
 * one corpse
 * ==================================================================== */

export class Ragdoll {
  /**
   * @param {import('../Physics.js').Physics} phys
   * @param {object} spec {entity, root, mesh, skeleton, bones, mass, height,
   *                       radius, impulse, hitPoint|point}
   */
  constructor(phys, spec) {
    this.phys = phys;
    this.entity = spec.entity ?? null;
    this.bonesAll = spec.bones ?? spec.skeleton?.bones ?? null;
    this.rootObj = spec.root ?? this.entity?.root ?? null;
    this.mass = Math.max(4, spec.mass ?? this.entity?.mass ?? 70);
    this.height = Math.max(0.4, spec.height ?? this.entity?.height ?? 1.85);
    this.bodyScale = clamp(this.height / 1.85, 0.35, 4.2);

    this.solver = null;
    /** @type {Array<{bone:THREE.Bone, cls:string, i:number, parent:number, primary:number}>} */
    this.nodes = [];
    this.byBone = new Map();
    this.pairs = null;                 // self-collision pairs, [a,b,sep] triples
    this.q = [];                       // per-node reconstructed world rotation
    this.dirBind = [];                 // primary child offset direction, bone-local
    this.settled = 0;
    this.age = 0;
    this.frozen = false;
    this.evicted = false;
    this.posedFrozen = false;
    this.seq = 0;
    this.wscale = 1;
    this.centre = new THREE.Vector3();
    this.lowY = 0;
    this.ok = false;
  }

  /* ------------------------------------------------------------ build */

  build(spec) {
    const bones = this.bonesAll;
    if (!Array.isArray(bones) || bones.length < 4) return false;
    if (!this.rootObj) return false;

    /* Fresh world matrices: die() may be called from a bus handler before the
       renderer has run this frame, so the pose could be one frame stale. */
    try { this.rootObj.updateMatrixWorld(true); } catch { /* detached */ }

    /* ---- entity world scale, taken off the first bone's world matrix ---- */
    _m.copy(bones[0].matrixWorld);
    this.wscale = Math.hypot(_m.elements[0], _m.elements[1], _m.elements[2]) || 1;

    /* ---- decide which bones are simulated ---- */
    const inSet = new Set(bones);
    const childCount = new Map();
    for (const b of bones) {
      const p = b.parent;
      if (p && inSet.has(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
    }

    const minSeg = 0.052 * this.bodyScale;
    const chosen = [];
    const chosenSet = new Set();
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      const cls = jointClass(b.name);
      if (SKIP.has(cls)) continue;
      /* A 'root' with a single child is a phantom ground node (the biped rig
         puts it at the feet). Simulating it hangs a weight below the pelvis and
         props the corpse up on an invisible pole — so skip it, and let the
         ragdoll root at the pelvis instead. A quadruped's root has four
         children and IS the pelvis, so it stays. */
      if (cls === 'root' && (childCount.get(b) ?? 0) <= 1) continue;
      /* must be reachable: some simulated ancestor, or be the first one */
      const par = _nearestChosen(b, chosenSet);
      if (chosen.length && !par) continue;
      if (par) {
        _worldPos(b, _v);
        _worldPos(par, _v2);
        if (_v.distanceTo(_v2) < minSeg && (childCount.get(b) ?? 0) === 0) continue;
      }
      chosen.push(b);
      chosenSet.add(b);
    }
    if (chosen.length < 4) return false;

    /* ---- trim to the cap by dropping the shortest leaf segments ---- */
    while (chosen.length > MAX_PARTICLES) {
      let worst = -1, worstLen = Infinity;
      for (let i = 1; i < chosen.length; i++) {
        const b = chosen[i];
        let isLeaf = true;
        for (let k = 0; k < chosen.length; k++) {
          if (chosen[k].parent === b) { isLeaf = false; break; }
        }
        if (!isLeaf) continue;
        const par = _nearestChosen(b, chosenSet);
        if (!par) continue;
        _worldPos(b, _v); _worldPos(par, _v2);
        const l = _v.distanceTo(_v2);
        if (l < worstLen) { worstLen = l; worst = i; }
      }
      if (worst < 0) break;
      chosenSet.delete(chosen[worst]);
      chosen.splice(worst, 1);
    }

    /* ---- particles ---- */
    let wsum = 0;
    for (const b of chosen) wsum += (J[jointClass(b.name)] ?? J.other).m;
    const norm = wsum > 1e-6 ? 1 / wsum : 1;

    const solver = new Verlet({
      capacity: chosen.length,
      substeps: 2,
      iterations: 4,
      damping: 0.11,          // a corpse is not a trampoline
      maxSpeed: 9,            // a shoved body, never a launched one
      angRelax: 0.45,
    });
    this.solver = solver;

    for (let i = 0; i < chosen.length; i++) {
      const b = chosen[i];
      const cls = jointClass(b.name);
      const cfg = J[cls] ?? J.other;
      _worldPos(b, _v);
      const idx = solver.add(_v.x, _v.y, _v.z, {
        mass: Math.max(0.35, this.mass * cfg.m * norm),
        radius: cfg.r * this.bodyScale,
      });
      const node = { bone: b, cls, i: idx, parent: -1, primary: -1, len: 0 };
      this.nodes.push(node);
      this.byBone.set(b, node);
      b.getWorldQuaternion(_q);
      this.q.push(_q.clone());
      this.dirBind.push(new THREE.Vector3(0, 1, 0));
    }

    /* ---- parent links ---- */
    for (let i = 1; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const par = _nearestChosen(node.bone, chosenSet);
      const pn = par ? this.byBone.get(par) : null;
      if (!pn) continue;
      node.parent = pn.i;
      node.len = solver.dist(pn.i, node.i);
      solver.distance(pn.i, node.i, node.len, 1);
    }

    /* ---- primary child (drives each bone's reconstructed orientation) ---- */
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      let best = -1, bestScore = -1, bestLen = 0;
      for (let k = 0; k < this.nodes.length; k++) {
        const c = this.nodes[k];
        if (c.parent !== node.i) continue;
        const score = PRIMARY[c.cls] ?? 5;
        if (score > bestScore || (score === bestScore && c.len > bestLen)) {
          bestScore = score; bestLen = c.len; best = k;
        }
      }
      node.primary = best;
      if (best >= 0) {
        /* direction of the child, in this bone's own local space, from the bind
           hierarchy — constant, so the reconstructed rotation is exact */
        const cb = this.nodes[best].bone;
        _v.set(0, 0, 0);
        let o = cb;
        while (o && o !== node.bone) { _v.add(o.position); o = o.parent; }
        if (_v.lengthSq() < 1e-10) _v.set(0, 1, 0);
        this.dirBind[i].copy(_v).normalize();
      }
    }

    /* ---- joint limits: one per (grandparent, parent, child) triple ---- */
    for (let i = 0; i < this.nodes.length; i++) {
      const child = this.nodes[i];
      if (child.parent < 0) continue;
      const joint = this._byIndex(child.parent);
      if (!joint || joint.parent < 0) continue;      // the ragdoll root is free
      const gp = this._byIndex(joint.parent);
      if (!gp) continue;
      const cfg = J[joint.cls] ?? J.other;

      const pd = _dir(solver, gp.i, joint.i, _v);
      const cd = _dir(solver, joint.i, child.i, _v2);
      if (!pd || !cd) continue;
      const rp = [_v.x, _v.y, _v.z];
      const rc = [_v2.x, _v2.y, _v2.z];

      if (cfg.hinge) {
        /* hinge axis from the bend already present in the death pose; when the
           limb is dead straight, fall back to the bone's own lateral axis,
           which for every rig in this project is local X */
        let ax = _v.y * _v2.z - _v.z * _v2.y;
        let ay = _v.z * _v2.x - _v.x * _v2.z;
        let az = _v.x * _v2.y - _v.y * _v2.x;
        let al = Math.hypot(ax, ay, az);
        let bend = Math.atan2(al, _v.dot(_v2));
        if (al < 0.20) {
          joint.bone.getWorldQuaternion(_q);
          _v.set(1, 0, 0).applyQuaternion(_q);
          // re-derive the in-plane sign from the (small) existing bend
          const pdx = rp[0], pdy = rp[1], pdz = rp[2];
          ax = _v.x; ay = _v.y; az = _v.z;
          const d = ax * pdx + ay * pdy + az * pdz;
          ax -= pdx * d; ay -= pdy * d; az -= pdz * d;
          al = Math.hypot(ax, ay, az);
          if (al < 1e-5) { ax = 0; ay = 1; az = 0; al = 1; }
          bend = Math.max(bend, 0.02);
        }
        ax /= al; ay /= al; az /= al;
        const lo = -Math.min(cfg.hyper, Math.max(0, bend));
        const hi = Math.min(2.62, bend + cfg.flex);
        solver.hinge(child.i, joint.i, gp.i, lo, hi, HINGE_LATERAL, rp, rc, [ax, ay, az], 0.84);
      } else {
        solver.cone(child.i, joint.i, gp.i, cfg.cone, rp, rc, 0.86);
      }
    }

    /* ---- self collision pairs: everything more than two links apart ---- */
    this.pairs = this._buildPairs();

    /* ---- world + self collision hook ---- */
    const world = this.phys.world;
    const self = this;
    solver.collide = (s, i, x, y, z, r) => self._collideOne(world, s, i, x, y, z, r);

    /* ---- the killing blow ---- */
    this._applyKill(spec);

    /* ---- do not let the corpse be born inside the floor ---- */
    for (let i = 0; i < solver.n; i++) {
      const k = i * 3;
      const gy = world.heightAt(solver.p[k], solver.p[k + 2]) + solver.r[i];
      if (solver.p[k + 1] < gy) { solver.p[k + 1] = gy; solver.q[k + 1] = gy; }
    }

    this._measure();
    this.ok = true;
    return true;
  }

  _byIndex(pi) {
    for (let i = 0; i < this.nodes.length; i++) if (this.nodes[i].i === pi) return this.nodes[i];
    return null;
  }

  /**
   * Self-collision pair list.
   *
   * Two rules, both learned the hard way. Neighbours within two links are
   * excluded, because a shoulder sphere and a chest sphere are *meant* to
   * overlap. And every remaining pair stores its own separation distance,
   * clamped to the distance the two spheres already had in the death pose: a pair
   * that overlaps in a valid anatomical pose must be allowed to keep overlapping
   * that much, or the solver spends the whole corpse's life pushing a limb out of
   * a torso it was never outside of — which is exactly what a twitching ragdoll
   * looks like.
   *
   * Layout: [aNodeIdx, bNodeIdx, separation] triples in a flat Float32Array.
   */
  _buildPairs() {
    const n = this.nodes.length;
    const depth = new Int32Array(n);
    const parentOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      if (node.parent < 0) { parentOf[i] = -1; continue; }
      for (let k = 0; k < n; k++) if (this.nodes[k].i === node.parent) { parentOf[i] = k; break; }
    }
    for (let i = 0; i < n; i++) {
      let d = 0, k = i;
      while (parentOf[k] >= 0 && d < 64) { k = parentOf[k]; d++; }
      depth[i] = d;
    }
    const s = this.solver;
    const out = [];
    for (let i = 0; i < n; i++) {
      for (let k = i + 1; k < n; k++) {
        if (_linkDist(parentOf, depth, i, k) <= 2) continue;
        const a = this.nodes[i].i, b = this.nodes[k].i;
        const rr = (s.r[a] + s.r[b]) * 0.94;
        const rest = s.dist(a, b);
        const sep = Math.min(rr, rest * 0.94);
        if (sep < 0.01) continue;
        out.push(i, k, sep);
      }
    }
    return new Float32Array(out);
  }

  /** World + self collision for one particle. Called from inside the solver. */
  _collideOne(world, s, i, x, y, z, r) {
    const k = i * 3;
    let hit = false;
    const c = _hitScratch;
    if (world.solveSphere(x, y, z, r, c)) {
      s.p[k] += c.dx; s.p[k + 1] += c.dy; s.p[k + 2] += c.dz;
      hit = true;
    }
    const gy = world.heightAt(s.p[k], s.p[k + 2]) + r;
    if (s.p[k + 1] < gy) {
      s.p[k + 1] = gy;
      hit = true;
    }
    if (hit) {
      s.flags[i] = 1;
      /* Friction at the contact, expressed the only way a Verlet rig can: pull
         the previous position toward the current one, which removes tangential
         velocity. 0.62 is what stops a corpse skating and still lets a hard hit
         drag it half a metre. */
      s.q[k] += (s.p[k] - s.q[k]) * 0.62;
      s.q[k + 2] += (s.p[k + 2] - s.q[k + 2]) * 0.62;
    }
  }

  /** Separate non-adjacent particles — an arm cannot pass through the ribs. */
  _solveSelf() {
    const s = this.solver;
    const pr = this.pairs;
    if (!pr) return;
    for (let t = 0; t < pr.length; t += 3) {
      const a = this.nodes[pr[t]].i, b = this.nodes[pr[t + 1]].i;
      const rr = pr[t + 2];
      const ka = a * 3, kb = b * 3;
      let dx = s.p[kb] - s.p[ka], dy = s.p[kb + 1] - s.p[ka + 1], dz = s.p[kb + 2] - s.p[ka + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const inv = 1 / d;
      dx *= inv; dy *= inv; dz *= inv;
      const wa = s.im[a], wb = s.im[b], tot = wa + wb;
      if (tot < 1e-9) continue;
      /* under-relaxed for the same reason the joint limits are */
      const pen = (rr - d) * 0.45;
      const fa = (wa / tot) * pen, fb = (wb / tot) * pen;
      s.p[ka] -= dx * fa; s.p[ka + 1] -= dy * fa; s.p[ka + 2] -= dz * fa;
      s.p[kb] += dx * fb; s.p[kb + 1] += dy * fb; s.p[kb + 2] += dz * fb;
    }
  }

  /**
   * The killing blow. Momentum is split: a share to the whole body (so it is
   * thrown as one thing) and a share concentrated at the hit point with an
   * inverse-square falloff (so it also *spins* about the wound). Nothing here
   * scales with frame rate — impulses become velocities, and velocity in a
   * Verlet rig is a previous-position offset over a fixed dt.
   */
  _applyKill(spec) {
    const s = this.solver;
    const imp = spec.impulse ?? spec.force ?? null;
    const hp = spec.hitPoint ?? spec.point ?? null;
    const dt = 1 / 60;

    /* the collapse itself: a small settling drop so the body starts to fall
       rather than hanging for a frame */
    for (let i = 0; i < s.n; i++) s.addVelocity(i, 0, -0.55, 0, dt);

    if (!imp) return;
    let ix = imp.x ?? 0, iy = imp.y ?? 0, iz = imp.z ?? 0;
    const mag = Math.hypot(ix, iy, iz);
    if (mag < 1e-4) return;
    /* Cap the hit: Damage.js hands over mass-scaled numbers, but a crit on a
       light skeleton can still ask for 6 m/s, which reads as a cartoon. 4.2 m/s
       of body velocity is a hard, believable shove. */
    const vBody = Math.min(4.2, mag / this.mass);
    const ux = ix / mag, uy = iy / mag, uz = iz / mag;

    const global = 0.55, local = 0.45;
    for (let i = 0; i < s.n; i++) {
      s.addVelocity(i, ux * vBody * global, uy * vBody * global, uz * vBody * global, dt);
    }
    if (!hp) return;
    const px = hp.x ?? 0, py = hp.y ?? 0, pz = hp.z ?? 0;
    let wsum = 0;
    const w = _weights(s.n);
    for (let i = 0; i < s.n; i++) {
      const k = i * 3;
      const dx = s.p[k] - px, dy = s.p[k + 1] - py, dz = s.p[k + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const wi = 1 / (1 + d2 / 0.30);
      w[i] = wi;
      wsum += wi;
    }
    if (wsum < 1e-6) return;
    const gain = (vBody * local * s.n) / wsum;
    for (let i = 0; i < s.n; i++) {
      const f = w[i] * gain;
      s.addVelocity(i, ux * f, uy * f + f * 0.22, uz * f, dt);
    }
  }

  /* ------------------------------------------------------------- solve */

  step(dt) {
    if (this.frozen || !this.ok) return;
    this.age += dt;
    const s = this.solver;
    s.step(dt);
    this._solveSelf();
    /* joint friction — see Verlet.dampLinks. Ramped up as the corpse ages so the
       first half second still whips convincingly and the rest goes limp. */
    s.dampLinks(this.age < 0.35 ? 0.22 : this.age < 1.4 ? 0.46 : 0.62);

    /**
     * Quiesce. Between 1.9 s and 2.9 s the remaining energy is bled out and the
     * body is then frozen outright.
     *
     * This is a deliberate choice, not a fudge. Left to converge on its own a
     * corpse resting on a cobbled heightfield keeps creeping at a few centimetres
     * per second forever, because the ground normal under each contact point is
     * slightly different and the joint limits never agree on a single solution.
     * Nobody watching an ARPG can tell whether a corpse settled in 1.9 s or 4 s;
     * everybody can tell if it is still crawling. Bestiary starts its dissolve at
     * 1.7 s and finishes at 2.85 s, so a hard stop at 2.9 s is behind the burn.
     */
    if (this.age > QUIET_FROM) {
      const k = clamp01((this.age - QUIET_FROM) / (QUIET_TO - QUIET_FROM));
      s.scaleVelocity(1 - k * 0.88);
    }

    /* settle detection: mean per-particle travel per substep. 0.8 mm per substep
       is ~5 cm/s, below what a 1600x900 frame can resolve at 26 m, so freezing
       there is invisible. */
    if (s.motion < 0.0008) {
      this.settled += dt;
      if (this.settled > 0.30) this.freeze();
    } else this.settled = 0;
    if (this.age > QUIET_TO) this.freeze();
    this._measure();
  }

  freeze() {
    if (this.frozen) return;
    this.frozen = true;
    this.solver.sleep();
  }

  _measure() {
    const s = this.solver;
    let cx = 0, cz = 0, lo = Infinity;
    for (let i = 0; i < s.n; i++) {
      const k = i * 3;
      cx += s.p[k]; cz += s.p[k + 2];
      const b = s.p[k + 1] - s.r[i];
      if (b < lo) lo = b;
    }
    const inv = 1 / Math.max(1, s.n);
    this.centre.set(cx * inv, lo, cz * inv);
    this.lowY = lo;
  }

  /* ------------------------------------------------------------ render */

  /**
   * Write the simulated pose into the bone hierarchy. Parent-first, so each
   * bone's parent world matrix is already correct when its local is derived.
   */
  pose() {
    if (!this.ok) return;
    const s = this.solver;
    const rootObj = this.rootObj;
    if (!rootObj) return;

    /* keep the entity's own transform under the corpse so the contact-occlusion
       blob and the frustum sphere follow it */
    const ent = this.entity;
    if (ent && ent.position && !this.evicted) {
      ent.position.x += (this.centre.x - ent.position.x) * 0.5;
      ent.position.z += (this.centre.z - ent.position.z) * 0.5;
      const gy = this.phys.world.heightAt(this.centre.x, this.centre.z);
      ent.position.y = gy;
      ent.groundY = gy;
    }
    try { rootObj.updateMatrixWorld(true); } catch { /* detached */ }

    /* live entity scale — an elite is 1.16x and must stay that way */
    _m.copy(this.nodes[0].bone.matrixWorld);
    const ws = Math.hypot(_m.elements[0], _m.elements[1], _m.elements[2]) || 1;
    this.wscale = ws;
    _sc.setScalar(ws);

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const bone = node.bone;
      const k = node.i * 3;
      _pos.set(s.p[k], s.p[k + 1], s.p[k + 2]);

      /* --- reconstruct the bone's world rotation --- */
      const prev = this.q[i];
      if (node.primary >= 0) {
        const c = this.nodes[node.primary];
        const kc = c.i * 3;
        _v.set(s.p[kc] - s.p[k], s.p[kc + 1] - s.p[k + 1], s.p[kc + 2] - s.p[k + 2]);
        if (_v.lengthSq() > 1e-10) {
          _v.normalize();
          /* where the previous rotation puts the bind direction */
          _v2.copy(this.dirBind[i]).applyQuaternion(prev);
          _q.setFromUnitVectors(_v2, _v);
          prev.premultiply(_q).normalize();
        }
      } else {
        /* a leaf (a wrist with no simulated hand, an ankle with no toe): keep it
           aligned with its parent limb so the extremity does not read as broken */
        const pn = node.parent >= 0 ? this._byIndex(node.parent) : null;
        if (pn) {
          const pi = this.nodes.indexOf(pn);
          if (pi >= 0) prev.copy(this.q[pi]);
        }
      }
      _rot.copy(prev);

      /* --- world -> parent-relative local --- */
      _m.compose(_pos, _rot, _sc);
      const par = bone.parent;
      if (par) {
        _m2.copy(par.matrixWorld).invert();
        _m2.multiply(_m);
      } else _m2.copy(_m);
      _m2.decompose(bone.position, bone.quaternion, _v);
      bone.scale.set(1, 1, 1);
      bone.matrix.compose(bone.position, bone.quaternion, bone.scale);
      bone.matrixWorld.copy(_m);
      bone.matrixWorldNeedsUpdate = false;
    }

    /* non-simulated descendants (jaw, fingers, toes) inherit from their locals */
    try { rootObj.updateMatrixWorld(true); } catch { /* noop */ }
  }

  dispose() {
    this.solver = null;
    this.nodes.length = 0;
    this.byBone.clear();
    this.pairs = null;
    this.q.length = 0;
    this.p = null;
    this.prev = null;
    this.entity = null;
    this.root = null;
    this.asleep = true;
    this.alive = false;
  }
}

export class RagdollSet {
  /**
   * @param {import('../Physics.js').Physics} phys
   * @param {number} cap simultaneously *simulated* ragdolls
   */
  constructor(phys, cap = 8) {
    this.phys = phys;
    this.cap = cap;
    /** @type {Ragdoll[]} simulated, oldest first */
    this.list = [];
    /** @type {Ragdoll[]} over the cap: frozen and dissolving, still owned */
    this.retired = [];
    this._byEntity = new Map();
    this._seq = 0;
  }

  get activeCount() { return this.list.length; }
  get totalCount() { return this.list.length + this.retired.length; }
  get particleCount() {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) n += this.list[i].solver?.n ?? 0;
    return n;
  }
  get solvingCount() {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].frozen) n++;
    return n;
  }

  has(entity) { return this._byEntity.has(entity); }

  /** @returns {Ragdoll|null} */
  create(spec) {
    const ent = spec.entity ?? null;
    if (ent && this._byEntity.has(ent)) return this._byEntity.get(ent);

    /* Floaters do not ragdoll — a wraith has no skeleton to break and its
       keyframed dissipation reads far better than a corpse falling out of the
       air. Returning null makes Bestiary play that clip. */
    const hover = ent?.def?.hover ?? 0;
    if (hover > 0) return null;

    const rag = new Ragdoll(this.phys, spec);
    let ok = false;
    try { ok = rag.build(spec); } catch (e) {
      console.warn('[physics] ragdoll build failed —', e?.message ?? e);
      ok = false;
    }
    if (!ok) { rag.dispose(); return null; }

    rag.seq = ++this._seq;
    this.list.push(rag);
    if (ent) {
      this._byEntity.set(ent, rag);
      /* Bestiary keeps integrating its own knockback into root.position after
         death, which would slide the corpse's parent transform out from under
         it. The handoff is explicit: physics owns this body now. */
      try { ent.kbX = 0; ent.kbZ = 0; } catch { /* frozen entity — fine */ }
    }
    this._enforceCap();
    return rag;
  }

  /**
   * Retire the oldest corpses down to the cap.
   *
   * A retired ragdoll is frozen where it lies and pushed into the Bestiary's own
   * dissolve path by back-dating its death time, so it burns away with the same
   * shader everything else uses instead of popping out of existence or snapping
   * back to an animated pose. It stays registered — Bestiary still calls
   * `releaseRagdoll()` when it pools the body — but it is no longer simulated or
   * posed, so it costs nothing.
   */
  _enforceCap() {
    while (this.list.length > this.cap) {
      const rag = this.list.shift();
      rag.freeze();
      rag.evicted = true;
      const ent = rag.entity;
      if (ent) {
        try {
          const now = this.phys.engine.clock.elapsed;
          // 1.7 s is the ragdoll hold in Bestiary._dying; land just past it so
          // the dissolve starts on the next frame.
          if (Number.isFinite(ent.deathAt) && now - ent.deathAt < 1.72) ent.deathAt = now - 1.72;
        } catch { /* presentation only */ }
      }
      this.retired.push(rag);
    }
    /* hard bound: if Bestiary never hands a body back (pooled off-screen, say),
       the oldest retired corpses are released outright */
    while (this.retired.length > this.cap * 2) {
      const drop = this.retired.shift();
      if (drop.entity) this._byEntity.delete(drop.entity);
      drop.dispose();
    }
  }

  step(dt) {
    for (let i = 0; i < this.list.length; i++) {
      const rag = this.list[i];
      if (!rag.ok) continue;
      try {
        if (!rag.frozen) {
          rag.step(dt);
          rag.pose();
          rag.posedFrozen = false;
        } else if (!rag.posedFrozen) {
          /* one final write so the settled pose lands in the bone hierarchy,
             then the corpse is free */
          rag.pose();
          rag.posedFrozen = true;
        }
      } catch (e) {
        console.warn('[physics] ragdoll step —', e?.message ?? e);
        rag.ok = false;
      }
    }
    /* drop anything broken, or whose entity has been recycled behind our back */
    for (let i = this.list.length - 1; i >= 0; i--) {
      const rag = this.list[i];
      const ent = rag.entity;
      if (!rag.ok || (ent && ent.dead === false)) this._drop(this.list, i);
    }
    for (let i = this.retired.length - 1; i >= 0; i--) {
      const ent = this.retired[i].entity;
      if (ent && ent.dead === false) this._drop(this.retired, i);
    }
  }

  _drop(arr, i) {
    const rag = arr[i];
    arr.splice(i, 1);
    if (rag.entity) this._byEntity.delete(rag.entity);
    rag.dispose();
  }

  /** Bestiary calls this before pooling or destroying the body. */
  release(entity) {
    const rag = entity ? this._byEntity.get(entity) : null;
    if (!rag) return false;
    let i = this.list.indexOf(rag);
    if (i >= 0) { this._drop(this.list, i); return true; }
    i = this.retired.indexOf(rag);
    if (i >= 0) { this._drop(this.retired, i); return true; }
    this._byEntity.delete(entity);
    rag.dispose();
    return true;
  }

  clear() {
    for (const rag of this.list) rag.dispose();
    for (const rag of this.retired) rag.dispose();
    this.list.length = 0;
    this.retired.length = 0;
    this._byEntity.clear();
  }
}


/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const _hitScratch = { dx: 0, dy: 0, dz: 0, depth: 0, nx: 0, ny: 0, nz: 0, hit: false, kind: -1 };
let _wbuf = new Float64Array(32);
function _weights(n) {
  if (_wbuf.length < n) _wbuf = new Float64Array(n);
  return _wbuf;
}

function _worldPos(bone, out) {
  const e = bone.matrixWorld.elements;
  return out.set(e[12], e[13], e[14]);
}

function _nearestChosen(bone, set) {
  let p = bone.parent;
  for (let i = 0; i < 32 && p; i++) {
    if (set.has(p)) return p;
    p = p.parent;
  }
  return null;
}

/** Unit direction between two particles; false when degenerate. */
function _dir(solver, a, b, out) {
  const ka = a * 3, kb = b * 3;
  out.set(solver.p[kb] - solver.p[ka], solver.p[kb + 1] - solver.p[ka + 1], solver.p[kb + 2] - solver.p[ka + 2]);
  const l = out.length();
  if (l < 1e-6) return false;
  out.multiplyScalar(1 / l);
  return true;
}

/** Distance in links between two nodes of the same tree, capped at 3. */
function _linkDist(parentOf, depth, a, b) {
  let x = a, y = b, d = 0;
  while (depth[x] > depth[y]) { x = parentOf[x]; d++; if (d > 3) return 4; }
  while (depth[y] > depth[x]) { y = parentOf[y]; d++; if (d > 3) return 4; }
  while (x !== y) {
    if (parentOf[x] < 0 || parentOf[y] < 0) return 4;
    x = parentOf[x]; y = parentOf[y]; d += 2;
    if (d > 3) return 4;
  }
  return d;
}

export { clamp01 };
export default RagdollSet;
