/**
 * THE NINTH VIGIL — AnimKit
 *
 * A tiny procedural animation graph. Clips are *functions of phase*, not baked
 * tracks: `fn(P, phase, ctx)` writes local joint rotations (and optional local
 * translations, which the skeleton archetype needs for rattling loose joints).
 *
 * Blending is quaternion slerp between the outgoing and incoming clip, so a
 * death pose can cross-fade out of a run cycle without the shortest-arc
 * artefacts that Euler lerping produces.
 *
 * Determinism: nothing here reads Math.random or wall-clock time. Phase is
 * advanced by the fixed dt the engine hands down, and per-instance variation
 * comes from a seeded scalar the owner passes in `ctx`.
 *
 * Generic on purpose — no bestiary-specific assumptions, so Hero can share it.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;

/* euler(XYZ) -> quaternion, written straight into a flat array */
function eulerToQuat(x, y, z, out, o) {
  const c1 = Math.cos(x * 0.5), c2 = Math.cos(y * 0.5), c3 = Math.cos(z * 0.5);
  const s1 = Math.sin(x * 0.5), s2 = Math.sin(y * 0.5), s3 = Math.sin(z * 0.5);
  out[o] = s1 * c2 * c3 + c1 * s2 * s3;
  out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
}

export const ease = {
  linear: (t) => t,
  in2: (t) => t * t,
  out2: (t) => 1 - (1 - t) * (1 - t),
  in3: (t) => t * t * t,
  out3: (t) => 1 - Math.pow(1 - t, 3),
  inOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) * 0.5),
  /** fast attack, slow settle — the shape of nearly every melee swing */
  snap: (t) => 1 - Math.pow(1 - t, 5),
  /** overshoot then settle */
  back: (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  bounceOut: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/** Smooth 0->1->0 pulse centred on `c` with half-width `w`. */
export function pulse(t, c, w) {
  const d = Math.abs(t - c) / w;
  if (d >= 1) return 0;
  const s = 1 - d;
  return s * s * (3 - 2 * s);
}

export const wave = (ph, off = 0) => Math.sin((ph + off) * TAU);

/**
 * Pose writer handed to clip functions.
 * Rotations accumulate (so a clip can layer contributions); positions too.
 */
class PoseWriter {
  constructor(rig) {
    this.rig = rig;
    this.n = rig.count;
    this.e = new Float32Array(this.n * 3);
    this.p = new Float32Array(this.n * 3);
    this.s = new Float32Array(this.n);       // uniform bone scale (rattle/inflate)
  }
  clear() { this.e.fill(0); this.p.fill(0); this.s.fill(1); }
  /** set (overwrite) local euler */
  rot(name, x, y = 0, z = 0) {
    const i = this.rig.index.get(name); if (i === undefined) return this;
    this.e[i * 3] = x; this.e[i * 3 + 1] = y; this.e[i * 3 + 2] = z; return this;
  }
  /** accumulate local euler */
  add(name, x, y = 0, z = 0) {
    const i = this.rig.index.get(name); if (i === undefined) return this;
    this.e[i * 3] += x; this.e[i * 3 + 1] += y; this.e[i * 3 + 2] += z; return this;
  }
  /** local translation offset in metres (added to the rig's rest offset) */
  move(name, x, y = 0, z = 0) {
    const i = this.rig.index.get(name); if (i === undefined) return this;
    this.p[i * 3] += x; this.p[i * 3 + 1] += y; this.p[i * 3 + 2] += z; return this;
  }
  scale(name, s) {
    const i = this.rig.index.get(name); if (i === undefined) return this;
    this.s[i] = s; return this;
  }
  /** spread a rotation smoothly down a named chain */
  chain(names, x, y = 0, z = 0, falloff = 1) {
    let w = 1;
    for (const nm of names) { this.add(nm, x * w, y * w, z * w); w *= falloff; }
    return this;
  }
}

export class AnimGraph {
  /**
   * @param {import('./RigKit.js').RigDef} rig
   * @param {Record<string,{dur?:number,loop?:boolean,fn:Function,next?:string}>} clips
   */
  constructor(rig, clips, opts = {}) {
    this.rig = rig;
    this.clips = clips;
    this.n = rig.count;
    this.A = new PoseWriter(rig);
    this.B = new PoseWriter(rig);
    this.qA = new Float32Array(this.n * 4);
    this.qB = new Float32Array(this.n * 4);
    this.qOut = new Float32Array(this.n * 4);
    this.pOut = new Float32Array(this.n * 3);
    this.sOut = new Float32Array(this.n);

    this.cur = opts.start ?? 'idle';
    this.prev = null;
    this.tCur = 0;
    this.tPrev = 0;
    this.blend = 1;
    this.fadeDur = 0.2;
    this.speed = 1;
    this.fallback = opts.fallback ?? 'idle';
    this.done = false;
    this._impulses = [];
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
  }

  has(name) { return !!this.clips[name]; }

  /** @returns {boolean} true if the clip actually started */
  play(name, o = {}) {
    if (!this.clips[name]) return false;
    if (name === this.cur && !o.restart) return false;
    this.prev = this.cur;
    this.tPrev = this.tCur;
    this.cur = name;
    this.tCur = 0;
    this.speed = o.speed ?? 1;
    this.fadeDur = Math.max(0.001, o.fade ?? 0.18);
    this.blend = o.fade === 0 ? 1 : 0;
    this.done = false;
    return true;
  }

  /** Transient additive rotation that decays — hit reactions, recoil, flinch. */
  impulse(joints, euler, amp = 1, decay = 6) {
    this._impulses.push({ joints, e: euler, amp, decay, life: 1 });
    if (this._impulses.length > 12) this._impulses.shift();
  }

  clipDur(name) { return this.clips[name]?.dur ?? 1; }
  get phase() {
    const c = this.clips[this.cur];
    if (!c) return 0;
    const d = c.dur ?? 1;
    return c.loop === false ? Math.min(1, this.tCur / d) : (this.tCur / d) % 1;
  }

  /**
   * Advance and write the result into `bones`.
   * @param {number} dt
   * @param {THREE.Bone[]} bones
   * @param {object} ctx handed to clip fns (speed, entity, jitter seed, ...)
   */
  update(dt, bones, ctx) {
    const step = dt * this.speed;
    this.tCur += step;
    this.tPrev += step;
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.fadeDur);
      if (this.blend >= 1) this.prev = null;
    }

    const cA = this.clips[this.cur];
    if (!cA) return;
    const dA = cA.dur ?? 1;
    let phA;
    if (cA.loop === false) {
      phA = Math.min(1, this.tCur / dA);
      if (phA >= 1 && !this.done) {
        this.done = true;
        const nx = cA.next ?? this.fallback;
        if (nx && nx !== this.cur && this.clips[nx]) { this.play(nx, { fade: cA.nextFade ?? 0.22 }); }
      }
    } else phA = (this.tCur / dA) % 1;

    this.A.clear();
    ctx.phase = phA;
    ctx.t = this.tCur;
    try { cA.fn(this.A, phA, ctx); } catch (e) { console.error('[animkit] clip failed', this.cur, e); }
    this._toQuat(this.A, this.qA);

    if (this.blend < 1 && this.prev && this.clips[this.prev]) {
      const cB = this.clips[this.prev];
      const dB = cB.dur ?? 1;
      const phB = cB.loop === false ? Math.min(1, this.tPrev / dB) : (this.tPrev / dB) % 1;
      this.B.clear();
      ctx.phase = phB;
      ctx.t = this.tPrev;
      try { cB.fn(this.B, phB, ctx); } catch { /* keep the frame alive */ }
      this._toQuat(this.B, this.qB);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      for (let i = 0; i < this.n; i++) {
        THREE.Quaternion.slerpFlat(this.qOut, i * 4, this.qB, i * 4, this.qA, i * 4, t);
        for (let k = 0; k < 3; k++) {
          this.pOut[i * 3 + k] = this.B.p[i * 3 + k] + (this.A.p[i * 3 + k] - this.B.p[i * 3 + k]) * t;
        }
        this.sOut[i] = this.B.s[i] + (this.A.s[i] - this.B.s[i]) * t;
      }
    } else {
      this.qOut.set(this.qA);
      this.pOut.set(this.A.p);
      this.sOut.set(this.A.s);
    }

    /* additive decaying impulses (hit react / recoil) */
    if (this._impulses.length) {
      for (let k = this._impulses.length - 1; k >= 0; k--) {
        const im = this._impulses[k];
        im.life -= dt * im.decay;
        if (im.life <= 0) { this._impulses.splice(k, 1); continue; }
        // damped oscillation reads as a flinch rather than a slide
        const w = im.life * im.amp * Math.cos((1 - im.life) * 7.0);
        for (const jn of im.joints) {
          const i = this.rig.index.get(jn);
          if (i === undefined) continue;
          eulerToQuat(im.e[0] * w, im.e[1] * w, im.e[2] * w, this._tmpQ ??= new Float32Array(4), 0);
          this._q1.set(this.qOut[i * 4], this.qOut[i * 4 + 1], this.qOut[i * 4 + 2], this.qOut[i * 4 + 3]);
          this._q2.set(this._tmpQ[0], this._tmpQ[1], this._tmpQ[2], this._tmpQ[3]);
          this._q1.multiply(this._q2);
          this.qOut[i * 4] = this._q1.x; this.qOut[i * 4 + 1] = this._q1.y;
          this.qOut[i * 4 + 2] = this._q1.z; this.qOut[i * 4 + 3] = this._q1.w;
        }
      }
    }

    /* write to bones */
    const off = this.rig.offsets;
    for (let i = 0; i < this.n; i++) {
      const b = bones[i];
      if (!b) continue;
      b.quaternion.set(this.qOut[i * 4], this.qOut[i * 4 + 1], this.qOut[i * 4 + 2], this.qOut[i * 4 + 3]);
      b.position.set(off[i * 3] + this.pOut[i * 3], off[i * 3 + 1] + this.pOut[i * 3 + 1],
        off[i * 3 + 2] + this.pOut[i * 3 + 2]);
      const s = this.sOut[i];
      if (s !== 1) b.scale.setScalar(s); else if (b.scale.x !== 1) b.scale.setScalar(1);
    }
  }

  _toQuat(pw, out) {
    const e = pw.e;
    for (let i = 0; i < this.n; i++) eulerToQuat(e[i * 3], e[i * 3 + 1], e[i * 3 + 2], out, i * 4);
  }
}
