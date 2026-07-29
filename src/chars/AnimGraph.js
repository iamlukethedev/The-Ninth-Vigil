/**
 * SANCTUM — AnimGraph (hero layer)
 * ---------------------------------------------------------------------------
 * The bestiary's `monsters/AnimKit.js` already ships a working procedural clip
 * graph with quaternion crossfades and decaying impulses. The hero needs three
 * things it does not have:
 *
 *   1. **Layers.** A full-body locomotion layer plus an *additive* action layer
 *      masked to the upper body, so the hero can swing a sword while running.
 *   2. **Root motion.** Attacks and the dodge roll displace the character; the
 *      displacement is authored as a curve on the clip and consumed by the
 *      movement controller, never faked with a velocity impulse.
 *   3. **Animation events.** `impact` must fire on the frame the blade actually
 *      passes through the arc, not on a timer started when the swing began.
 *
 * So this file *composes* AnimKit rather than replacing it: two `AnimKit.AnimGraph`
 * instances are driven with a throwaway bone array, their `qOut/pOut/sOut`
 * buffers are read back, and the composition + masking happens here. Everything
 * AnimKit does well (slerp crossfade, `next` chaining, impulses) still applies.
 *
 * It also carries the IK the hero needs, because IK is a pose-space operation
 * and belongs next to the graph:
 *
 *   • `twoBoneIK`   — analytic thigh/shin/foot and shoulder/elbow/hand solver
 *   • `alignBoneUp` — clamped world-space re-orientation (foot to terrain normal)
 *   • `applyLook`   — clamped, weighted spine/neck/head look-at chain
 *
 * Determinism: no Math.random, no wall clock. Every time-varying quantity is a
 * pure function of the fixed dt the engine hands down.
 */

import * as THREE from 'three';
import { AnimGraph as KitGraph, ease, pulse, wave } from './monsters/AnimKit.js';

export { ease, pulse, wave };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapPi = (a) => {
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/* ------------------------------------------------------------------ *
 * Skeleton.Rig -> RigKit.RigDef adapter
 * ------------------------------------------------------------------ */

const _views = new WeakMap();

/**
 * `Skeleton.js` predates RigKit and exposes a slightly different vocabulary
 * (`restLocal`/`restWorld`/`i()` instead of `offsets`/`rest`/`idx()`). Rather
 * than fork either file, present the hero rig through the interface that
 * `SkinBuilder` and `AnimKit.AnimGraph` already consume. Zero copies: the typed
 * arrays are shared, not duplicated.
 *
 * @param {import('./Skeleton.js').Rig} rig
 */
export function rigView(rig) {
  let v = _views.get(rig);
  if (v) return v;
  v = {
    source: rig,
    names: rig.names,
    index: rig.index,
    count: rig.count,
    parents: rig.parent,
    offsets: rig.restLocal,
    rest: rig.restWorld,
    bones: rig.bones,
    skeleton: rig.skeleton,
    restOf(name, out = new THREE.Vector3()) { return rig.rest(name, out); },
    restTipOf(name, out = new THREE.Vector3()) { return rig.restTip(name, out); },
    idx(name) {
      const i = rig.i(name);
      if (i < 0) { console.warn(`[heroanim] unknown joint "${name}"`); return 0; }
      return i;
    },
  };
  _views.set(rig, v);
  return v;
}

/* ------------------------------------------------------------------ *
 * IK
 * ------------------------------------------------------------------ */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _at = new THREE.Vector3();
const _bc = new THREE.Vector3();
const _ba = new THREE.Vector3();
const _ax0 = new THREE.Vector3();
const _ax1 = new THREE.Vector3();
const _axL = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

const angleBetween = (u, v) => Math.acos(clamp(u.dot(v) / ((u.length() * v.length()) || 1e-9), -1, 1));

/** Rotate `bone` by `angle` about a WORLD axis, keeping its parent untouched. */
function rotateWorld(bone, axis, angle) {
  if (!(Math.abs(angle) > 1e-6) || axis.lengthSq() < 1e-12) return;
  _q1.setFromAxisAngle(axis, angle);
  if (bone.parent) bone.parent.getWorldQuaternion(_q2); else _q2.identity();
  _q3.copy(_q2).invert().multiply(_q1).multiply(_q2);
  bone.quaternion.premultiply(_q3);
}

/**
 * Analytic two-bone IK (law of cosines). `A`→`B`→`C` is a chain of three bones
 * where C is the end effector; A and B receive rotation.
 *
 * The bend plane is chosen by `pole`: a world direction the joint should bend
 * *away* from (for a knee, the character's forward vector, so the knee never
 * inverts). Rotations are applied as world-space pre-multiplications computed
 * from the *original* configuration, then B's hinge is re-expressed in its own
 * local frame so it rides along with A's new orientation.
 *
 * @param {THREE.Bone} A upper bone (hip / shoulder)
 * @param {THREE.Bone} B lower bone (knee / elbow)
 * @param {THREE.Bone} C end effector (ankle / wrist)
 * @param {THREE.Vector3} targetW world-space goal for C
 * @param {THREE.Vector3} pole world direction the joint bends toward
 * @param {number} weight 0..1
 * @returns {boolean} true if a rotation was applied
 */
export function twoBoneIK(A, B, C, targetW, pole, weight = 1) {
  if (!A || !B || !C || weight <= 1e-4) return false;
  A.updateWorldMatrix(true, false);
  B.updateWorldMatrix(false, false);
  C.updateWorldMatrix(false, false);
  _a.setFromMatrixPosition(A.matrixWorld);
  _b.setFromMatrixPosition(B.matrixWorld);
  _c.setFromMatrixPosition(C.matrixWorld);

  const lab = _a.distanceTo(_b);
  const lcb = _b.distanceTo(_c);
  if (lab < 1e-5 || lcb < 1e-5) return false;

  // Partial weighting: pull the goal toward the animated position.
  _t.copy(_c).lerp(targetW, clamp01(weight));

  const reach = lab + lcb;
  const inner = Math.abs(lab - lcb);
  let lat = _a.distanceTo(_t);
  lat = clamp(lat, inner + 1e-4, reach - 1e-4);

  _ab.subVectors(_b, _a);
  _ac.subVectors(_c, _a);
  _at.subVectors(_t, _a);
  _bc.subVectors(_c, _b);
  _ba.subVectors(_a, _b);
  if (_ac.lengthSq() < 1e-10 || _at.lengthSq() < 1e-10) return false;

  const acAb0 = angleBetween(_ac, _ab);
  const baBc0 = angleBetween(_ba, _bc);
  const acAt0 = angleBetween(_ac, _at);
  const acAb1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const baBc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));

  // Hinge axis: perpendicular to the limb and to the pole vector.
  _ax0.crossVectors(_ac, pole);
  if (_ax0.lengthSq() < 1e-8) _ax0.crossVectors(_ac, _ab);
  if (_ax0.lengthSq() < 1e-8) return false;
  _ax0.normalize();
  _ax1.crossVectors(_ac, _at);
  const swing = _ax1.lengthSq() > 1e-9;
  if (swing) _ax1.normalize();

  // Express the hinge in B's own frame *before* A moves, so it follows A.
  B.getWorldQuaternion(_qi);
  _axL.copy(_ax0).applyQuaternion(_qi.invert());

  rotateWorld(A, _ax0, acAb1 - acAb0);
  if (swing) rotateWorld(A, _ax1, acAt0);

  const dB = baBc1 - baBc0;
  if (Math.abs(dB) > 1e-6 && _axL.lengthSq() > 1e-10) {
    _q1.setFromAxisAngle(_axL.normalize(), dB);
    B.quaternion.multiply(_q1);
  }
  A.updateWorldMatrix(false, true);
  return true;
}

/**
 * Rotate a bone in world space so its local +Y axis points along `upWorld`,
 * clamped to `maxRad` and scaled by `weight`. Used to sit a foot flat on a
 * slope without letting a cliff edge snap the ankle off.
 */
export function alignBoneUp(bone, upWorld, weight = 1, maxRad = 0.42) {
  if (!bone || weight <= 1e-4 || upWorld.lengthSq() < 1e-8) return;
  bone.updateWorldMatrix(true, false);
  bone.getWorldQuaternion(_q1);
  _up.set(0, 1, 0).applyQuaternion(_q1);
  _t.copy(upWorld).normalize();
  const ang = angleBetween(_up, _t);
  if (ang < 1e-4) return;
  _ax0.crossVectors(_up, _t);
  if (_ax0.lengthSq() < 1e-10) return;
  _ax0.normalize();
  rotateWorld(bone, _ax0, Math.min(ang, maxRad) * clamp01(weight));
}

/**
 * Clamped look-at spread across a chain. Angles are authored as *rig-relative*
 * yaw/pitch (0 = straight ahead) and distributed by `share`, so the head does
 * most of the work and the spine only assists — the classic ARPG head-tracking
 * feel. Applied multiplicatively on top of whatever the clips produced.
 *
 * @param {import('./Skeleton.js').Rig} rig
 * @param {number} yaw   radians, + = character's left
 * @param {number} pitch radians, + = down
 * @param {number} weight 0..1
 */
export function applyLook(rig, yaw, pitch, weight = 1, share = LOOK_SHARE) {
  const w = clamp01(weight);
  if (w <= 1e-4) return;
  for (const [name, k] of share) {
    const bone = rig.bone(name);
    if (!bone) continue;
    _q1.setFromEuler(_lookEuler.set(pitch * k * w, yaw * k * w, 0, 'YXZ'));
    bone.quaternion.multiply(_q1);
  }
}

const _lookEuler = new THREE.Euler();
export const LOOK_SHARE = [
  ['spine2', 0.13],
  ['spine3', 0.20],
  ['neck', 0.24],
  ['head', 0.43],
];

/* ------------------------------------------------------------------ *
 * Layered graph
 * ------------------------------------------------------------------ */

/** Bones the additive action layer owns outright. */
const UPPER = [
  'spine1', 'spine2', 'spine3', 'neck', 'head', 'headTop',
  'clavicle_L', 'clavicle_R', 'upperArm_L', 'upperArm_R',
  'lowerArm_L', 'lowerArm_R', 'hand_L', 'hand_R', 'handEnd_L', 'handEnd_R',
];
/** Bones the action layer only reaches when the legs are not busy walking. */
const LOWER = [
  'pelvis', 'thigh_L', 'thigh_R', 'shin_L', 'shin_R',
  'foot_L', 'foot_R', 'toe_L', 'toe_R', 'toeEnd_L', 'toeEnd_R',
];

export class HeroAnimGraph {
  /**
   * @param {import('./Skeleton.js').Rig} rig
   * @param {Record<string,object>} baseClips  full-body clips (locomotion, dash, death…)
   * @param {Record<string,object>} actionClips additive clips; must include `none`
   */
  constructor(rig, baseClips, actionClips, opts = {}) {
    this.rig = rig;
    this.view = rigView(rig);
    this.n = rig.count;
    this.bones = rig.bones;

    this.baseClips = baseClips;
    this.actionClips = actionClips;

    // Throwaway sink: AnimKit writes into `bones[i]` and skips holes, so an
    // array of undefined lets us harvest qOut/pOut without a second skeleton.
    this._sink = new Array(this.n);

    this.base = new KitGraph(this.view, baseClips, {
      start: opts.baseStart ?? 'locomotion',
      fallback: opts.baseFallback ?? 'locomotion',
    });
    this.act = new KitGraph(this.view, actionClips, { start: 'none', fallback: 'none' });

    this.maskUp = new Float32Array(this.n);
    this.isLower = new Uint8Array(this.n);
    for (const nm of UPPER) { const i = rig.i(nm); if (i >= 0) this.maskUp[i] = 1; }
    for (const nm of LOWER) { const i = rig.i(nm); if (i >= 0) this.isLower[i] = 1; }
    // The pelvis is the root: an action that rotates the hips rotates the whole
    // torso, which is exactly what "hips lead, shoulders follow" needs.

    /** 0..1 — how much of the action layer reaches the legs. */
    this.lowerGain = 1;
    /** locomotion phase-rate multiplier (stride sync) */
    this.locoRate = 1;

    this.rootDelta = 0;      // metres of forward root motion consumed this frame
    this.rootYawDelta = 0;   // radians of root yaw from the clip
    this.onEvent = null;     // (name, clipName, data) => void

    this._actPrev = 0;
        this._basePrev = 0;
    this._actClip = 'none';
    this._baseClip = this.base.cur;

    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._qw = new THREE.Quaternion();
  }

  /* ---------------------------------------------------------- control */

  playBase(name, o = {}) {
    if (!this.baseClips[name]) return false;
    const ok = this.base.play(name, o);
    if (ok) { this._basePrev = 0; this._baseClip = name; }
    return ok;
  }

  playAction(name, o = {}) {
    if (!this.actionClips[name]) return false;
    const ok = this.act.play(name, o);
    if (ok) { this._actPrev = 0; this._actClip = name; }
    return ok;
  }

  /** Cancel the additive layer back to identity. */
  clearAction(fade = 0.14) {
    if (this.act.cur === 'none') return;
    this.act.play('none', { fade });
    this._actPrev = 0;
    this._actClip = 'none';
  }

  impulse(joints, euler, amp = 1, decay = 6) { this.base.impulse(joints, euler, amp, decay); }

  get action() { return this.act.cur; }
  get actionPhase() { return this.act.cur === 'none' ? 1 : this.act.phase; }
  get actionBusy() { return this.act.cur !== 'none'; }
  get baseClip() { return this.base.cur; }
  get basePhase() { return this.base.phase; }
  get baseBusy() { return this.base.cur !== 'locomotion'; }

  /** Remaining seconds of the current action clip (0 when idle). */
  get actionRemaining() {
    if (this.act.cur === 'none') return 0;
    const c = this.actionClips[this.act.cur];
    return Math.max(0, (c.dur ?? 1) - this.act.tCur);
  }
  get baseRemaining() {
    if (this.base.cur === 'locomotion') return 0;
    const c = this.baseClips[this.base.cur];
    return Math.max(0, (c.dur ?? 1) - this.base.tCur);
  }

  /* ------------------------------------------------------------ frame */

  update(dt, ctx) {
    this.rootDelta = 0;
    this.rootYawDelta = 0;

    // Locomotion phase rate: stride length is fixed, so cadence must scale with
    // ground speed or the feet skate. Other base clips run at authored speed.
    this.base.speed = this.base.cur === 'locomotion' ? this.locoRate : 1;

    const baseWas = this.base.cur;
    const actWas = this.act.cur;

    this.base.update(dt, this._sink, ctx);
    this.act.update(dt, this._sink, ctx);

    this._harvest(this.base, this.baseClips, baseWas, '_basePrev', '_baseClip');
    this._harvest(this.act, this.actionClips, actWas, '_actPrev', '_actClip');

    this._compose();
  }

  /** Fire animation events and integrate root motion for one AnimKit graph. */
  _harvest(g, clips, wasName, prevKey, clipKey) {
    const name = g.cur;
    if (this[clipKey] !== name) { this[clipKey] = name; this[prevKey] = 0; }
    const c = clips[name];
    if (!c) return;
    const loop = c.loop !== false;
    const ph = g.phase;
    let prev = this[prevKey];
    if (loop && ph < prev) prev -= 1;             // wrapped this frame

    if (c.events && this.onEvent) {
      for (let i = 0; i < c.events.length; i++) {
        const e = c.events[i];
        const et = e.t ?? 0;
        if ((prev < et && ph >= et) || (loop && prev < et - 1 && ph >= et - 1)) {
          try { this.onEvent(e.name, name, e); } catch (err) { console.error('[heroanim] event', err); }
        }
      }
    }
    if (c.root) {
      const d = c.root(Math.max(0, ph)) - c.root(Math.max(0, prev));
      if (Number.isFinite(d)) this.rootDelta += d;
    }
    if (c.rootYaw) {
      const d = c.rootYaw(Math.max(0, ph)) - c.rootYaw(Math.max(0, prev));
      if (Number.isFinite(d)) this.rootYawDelta += d;
    }
    this[prevKey] = ph;
    void wasName;
  }

  /**
   * base ⊕ (action × mask). The action layer is authored as a delta from rest,
   * so composition is `qBase * slerp(identity, qAction, w)` — a true additive
   * layer, not a crossfade, which is what lets a swing ride on top of a run.
   */
  _compose() {
    const qb = this.base.qOut, pb = this.base.pOut, sb = this.base.sOut;
    const qa = this.act.qOut, pa = this.act.pOut, sa = this.act.sOut;
    const off = this.view.offsets;
    const lg = clamp01(this.lowerGain);
    const bones = this.bones;

    for (let i = 0; i < this.n; i++) {
      const bone = bones[i];
      if (!bone) continue;
      const w = this.isLower[i] ? lg : this.maskUp[i];
      const o = i * 3, q = i * 4;

      if (w > 1e-3) {
        this._qa.set(qa[q], qa[q + 1], qa[q + 2], qa[q + 3]);
        if (w < 0.999) this._qw.set(0, 0, 0, 1).slerp(this._qa, w);
        else this._qw.copy(this._qa);
        this._qb.set(qb[q], qb[q + 1], qb[q + 2], qb[q + 3]);
        bone.quaternion.copy(this._qb).multiply(this._qw);
        bone.position.set(
          off[o] + pb[o] + pa[o] * w,
          off[o + 1] + pb[o + 1] + pa[o + 1] * w,
          off[o + 2] + pb[o + 2] + pa[o + 2] * w
        );
        const s = sb[i] * (1 + (sa[i] - 1) * w);
        if (s !== 1 || bone.scale.x !== 1) bone.scale.setScalar(s);
      } else {
        bone.quaternion.set(qb[q], qb[q + 1], qb[q + 2], qb[q + 3]);
        bone.position.set(off[o] + pb[o], off[o + 1] + pb[o + 1], off[o + 2] + pb[o + 2]);
        if (sb[i] !== 1 || bone.scale.x !== 1) bone.scale.setScalar(sb[i]);
      }
    }
  }
}

export { clamp, clamp01, wrapPi };
