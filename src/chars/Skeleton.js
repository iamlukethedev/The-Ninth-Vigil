/**
 * SANCTUM — Skeleton.js
 * ---------------------------------------------------------------------------
 * Procedural humanoid rig. Nothing in this project imports a skeleton, so the
 * hero's bones are authored here as a table of rest-pose joint positions and
 * assembled into a real `THREE.Bone` hierarchy + `THREE.Skeleton`.
 *
 * Conventions — CharacterMesh.js and AnimGraph.js both depend on these:
 *
 *  • 1 unit = 1 metre (KNOWN_ISSUES.md canonical scale). The figure stands on
 *    y = 0 and is 1.85 m tall, 0.62 m across the shoulders, 7.4 heads.
 *  • +Z is forward, +Y is up, +X is the character's LEFT.
 *  • **Every bone's rest rotation is identity.** That is deliberate: a bone's
 *    local rotation axes therefore coincide with rig axes in bind pose, so
 *    animation can be authored as plain world-aligned Euler angles ("thigh
 *    −X swings the leg forward") instead of per-bone twisted frames. The
 *    trade-off — bones are not aligned to a canonical axis — costs nothing
 *    here because the skin is generated from this same joint table.
 *  • Only the left side is authored; `_R` bones are mirrored across X, which
 *    guarantees a symmetric rig (and therefore symmetric skin weights).
 *
 * The skeleton is built with the root bone *unparented* so its bone inverses
 * live in rig space. Skinned meshes then bind with an identity bind matrix and
 * the whole character can be moved/rotated by an ancestor Object3D without the
 * skin double-transforming (see CharacterMesh.bindMeshes).
 */

import * as THREE from 'three';

export const HERO_HEIGHT = 1.85;
/** Ground clearance of the boot sole in rig space (the skin is built to this). */
export const SOLE_Y = 0.008;

/**
 * name, parent, x, y, z — rest-pose WORLD positions, metres.
 * Heroic proportions: long shin, deep chest, wide clavicles.
 */
const HERO_JOINTS = [
  ['pelvis',      null,          0.000, 0.980,  0.000],
  ['spine1',      'pelvis',      0.000, 1.100,  0.010],
  ['spine2',      'spine1',      0.000, 1.238,  0.016],
  ['spine3',      'spine2',      0.000, 1.374,  0.004],
  ['neck',        'spine3',      0.000, 1.534, -0.014],
  ['head',        'neck',        0.000, 1.626,  0.008],
  ['headTop',     'head',        0.000, 1.850,  0.004],
  ['clavicle_L',  'spine3',      0.050, 1.462,  0.022],
  ['upperArm_L',  'clavicle_L',  0.216, 1.452, -0.004],
  ['lowerArm_L',  'upperArm_L',  0.278, 1.158,  0.026],
  ['hand_L',      'lowerArm_L',  0.318, 0.892,  0.064],
  ['handEnd_L',   'hand_L',      0.330, 0.766,  0.086],
  ['thigh_L',     'pelvis',      0.104, 0.944, -0.004],
  ['shin_L',      'thigh_L',     0.116, 0.506,  0.016],
  ['foot_L',      'shin_L',      0.122, 0.090, -0.018],
  ['toe_L',       'foot_L',      0.126, 0.042,  0.104],
  ['toeEnd_L',    'toe_L',       0.128, 0.028,  0.192],
];

/**
 * Skin-weight falloff radius per joint, metres. Tuned by hand: too small and
 * the shoulder creases, too large and the hand drags the hip around.
 */
const SIGMA = {
  pelvis: 0.185, spine1: 0.150, spine2: 0.150, spine3: 0.160,
  neck: 0.100, head: 0.150, headTop: 0.110,
  clavicle: 0.115, upperArm: 0.118, lowerArm: 0.098, hand: 0.085, handEnd: 0.075,
  thigh: 0.145, shin: 0.125, foot: 0.100, toe: 0.070, toeEnd: 0.060,
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

const baseName = (n) => (n.endsWith('_L') || n.endsWith('_R') ? n.slice(0, -2) : n);
const flipName = (n) =>
  n.endsWith('_L') ? `${n.slice(0, -2)}_R` : n.endsWith('_R') ? `${n.slice(0, -2)}_L` : n;

/** Squared distance from point p to segment ab, allocation free. */
function distSqPointSeg(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * A built humanoid rig: bones, bind-pose tables, and the query helpers the
 * skinner and the animation graph need.
 */
export class Rig {
  /**
   * @param {Array} joints joint table (see HERO_JOINTS)
   * @param {{scale?:number, name?:string}} [opts]
   */
  constructor(joints = HERO_JOINTS, opts = {}) {
    const scale = opts.scale ?? 1;
    this.name = opts.name ?? 'hero';
    this.scale = scale;

    /* ---- expand the mirror. Left defs are interleaved with their mirror so
       a mirrored parent always precedes its mirrored child. ---- */
    const defs = [];
    for (const j of joints) {
      defs.push(j);
      if (j[0].endsWith('_L')) {
        defs.push([flipName(j[0]), j[1] ? flipName(j[1]) : null, -j[2], j[3], j[4]]);
      }
    }

    const n = defs.length;
    this.count = n;
    this.names = new Array(n);
    this.index = new Map();
    this.bones = new Array(n);
    this.parent = new Int32Array(n).fill(-1);
    this.children = [];
    this.restWorld = new Float32Array(n * 3);
    this.restLocal = new Float32Array(n * 3);
    this.tipWorld = new Float32Array(n * 3);
    this.length = new Float32Array(n);
    this.sigma = new Float32Array(n);
    this.mirrorOf = new Int32Array(n);
    this.depth = new Int32Array(n);

    for (let i = 0; i < n; i++) {
      const d = defs[i];
      this.names[i] = d[0];
      this.index.set(d[0], i);
      this.children.push([]);
      this.restWorld[i * 3] = d[2] * scale;
      this.restWorld[i * 3 + 1] = d[3] * scale;
      this.restWorld[i * 3 + 2] = d[4] * scale;
    }
    for (let i = 0; i < n; i++) {
      const p = defs[i][1];
      const pi = p == null ? -1 : (this.index.get(p) ?? -1);
      this.parent[i] = pi;
      if (pi >= 0) this.children[pi].push(i);
      this.depth[i] = pi >= 0 ? this.depth[pi] + 1 : 0;
      const mi = this.index.get(flipName(defs[i][0]));
      this.mirrorOf[i] = mi === undefined ? i : mi;
    }

    /* ---- local offsets + bones ---- */
    for (let i = 0; i < n; i++) {
      const pi = this.parent[i];
      const ox = pi >= 0 ? this.restWorld[pi * 3] : 0;
      const oy = pi >= 0 ? this.restWorld[pi * 3 + 1] : 0;
      const oz = pi >= 0 ? this.restWorld[pi * 3 + 2] : 0;
      this.restLocal[i * 3] = this.restWorld[i * 3] - ox;
      this.restLocal[i * 3 + 1] = this.restWorld[i * 3 + 1] - oy;
      this.restLocal[i * 3 + 2] = this.restWorld[i * 3 + 2] - oz;

      const bone = new THREE.Bone();
      bone.name = this.names[i];
      bone.position.set(this.restLocal[i * 3], this.restLocal[i * 3 + 1], this.restLocal[i * 3 + 2]);
      bone.matrixAutoUpdate = true;
      this.bones[i] = bone;
    }
    for (let i = 0; i < n; i++) {
      const pi = this.parent[i];
      if (pi >= 0) this.bones[pi].add(this.bones[i]);
      else this.root = this.bones[i];
    }

    /* ---- skinning segments: joint -> primary child (or an extrapolated tip) ---- */
    for (let i = 0; i < n; i++) {
      const kids = this.children[i];
      let tx, ty, tz;
      if (kids.length) {
        const k = kids[0] * 3;
        tx = this.restWorld[k]; ty = this.restWorld[k + 1]; tz = this.restWorld[k + 2];
      } else {
        const pi = this.parent[i];
        const dx = pi >= 0 ? this.restWorld[i * 3] - this.restWorld[pi * 3] : 0;
        const dy = pi >= 0 ? this.restWorld[i * 3 + 1] - this.restWorld[pi * 3 + 1] : 0.05;
        const dz = pi >= 0 ? this.restWorld[i * 3 + 2] - this.restWorld[pi * 3 + 2] : 0;
        const l = Math.hypot(dx, dy, dz) || 1;
        const s = 0.055 * scale / l;
        tx = this.restWorld[i * 3] + dx * s;
        ty = this.restWorld[i * 3 + 1] + dy * s;
        tz = this.restWorld[i * 3 + 2] + dz * s;
      }
      this.tipWorld[i * 3] = tx; this.tipWorld[i * 3 + 1] = ty; this.tipWorld[i * 3 + 2] = tz;
      this.length[i] = Math.hypot(
        tx - this.restWorld[i * 3], ty - this.restWorld[i * 3 + 1], tz - this.restWorld[i * 3 + 2]
      );
      const s = SIGMA[baseName(this.names[i])];
      this.sigma[i] = (s ?? Math.min(0.16, Math.max(0.06, this.length[i] * 0.6))) * scale;
    }

    /* ---- bind. Root is unparented, so bone inverses land in rig space. ---- */
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.skeleton.pose();
    this.boneInverses = this.skeleton.boneInverses;

    this.height = HERO_HEIGHT * scale;
    this.soleY = SOLE_Y * scale;
  }

  /* ------------------------------------------------------------ queries */

  /** @returns {number} bone index, or -1 */
  i(name) {
    const v = this.index.get(name);
    return v === undefined ? -1 : v;
  }
  /** @returns {THREE.Bone|null} */
  bone(name) {
    const i = this.i(name);
    return i < 0 ? null : this.bones[i];
  }
  has(name) { return this.index.has(name); }

  /** Bind-pose world position. */
  rest(name, out = new THREE.Vector3()) {
    const i = typeof name === 'number' ? name : this.i(name);
    if (i < 0) return out.set(0, 0, 0);
    return out.set(this.restWorld[i * 3], this.restWorld[i * 3 + 1], this.restWorld[i * 3 + 2]);
  }
  /** Bind-pose world position of the joint's segment end. */
  restTip(name, out = new THREE.Vector3()) {
    const i = typeof name === 'number' ? name : this.i(name);
    if (i < 0) return out.set(0, 0, 0);
    return out.set(this.tipWorld[i * 3], this.tipWorld[i * 3 + 1], this.tipWorld[i * 3 + 2]);
  }
  /** Current animated world position (requires updateMatrixWorld). */
  world(name, out = new THREE.Vector3()) {
    const b = typeof name === 'number' ? this.bones[name] : this.bone(name);
    if (!b) return out.set(0, 0, 0);
    return out.setFromMatrixPosition(b.matrixWorld);
  }

  /** Distance from a rig-space point to bone i's rest segment. */
  distToBone(i, x, y, z) {
    const a = i * 3;
    return Math.sqrt(distSqPointSeg(
      x, y, z,
      this.restWorld[a], this.restWorld[a + 1], this.restWorld[a + 2],
      this.tipWorld[a], this.tipWorld[a + 1], this.tipWorld[a + 2]
    ));
  }

  /** Mirror a bone name through the rig (`_L` <-> `_R`). */
  mirrorName(name) { return flipName(name); }

  /** Reset every bone to bind pose. */
  restPose() {
    for (let i = 0; i < this.count; i++) {
      const b = this.bones[i];
      b.quaternion.set(0, 0, 0, 1);
      b.position.set(this.restLocal[i * 3], this.restLocal[i * 3 + 1], this.restLocal[i * 3 + 2]);
      b.scale.set(1, 1, 1);
    }
  }

  /**
   * Rest-space orthonormal frame for a joint: `u` down the bone, `n` the
   * normal of the (bone, forward) plane. Used by the IK solver so a limb can
   * be re-aimed without picking up spurious twist.
   */
  restFrame(i, uOut, nOut, forward = _c.set(0, 0, 1)) {
    this.restTip(i, uOut).sub(this.rest(i, _a)).normalize();
    nOut.crossVectors(uOut, forward);
    if (nOut.lengthSq() < 1e-8) nOut.crossVectors(uOut, _b.set(0, 1, 0));
    nOut.normalize();
    return uOut;
  }

  dispose() {
    try { this.skeleton.dispose?.(); } catch { /* three <r160 has no dispose */ }
  }
}

/** Build the hero rig. */
export function buildHeroRig(opts = {}) {
  return new Rig(HERO_JOINTS, opts);
}

/** The authored joint table, for tools that want to inspect proportions. */
export { HERO_JOINTS };
