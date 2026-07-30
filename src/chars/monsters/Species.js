/**
 * THE NINTH VIGIL — Species
 *
 * Per-archetype *assembly*: the rig proportions, the skinned surface, the clip
 * table and the material slots that turn RigKit/Rigs/Clips/MonsterMaterials
 * into an actual creature. Bestiary.js owns instances; this file owns bodies.
 *
 * Rules that keep the bestiary readable at ARPG distance (28 m, 54° pitch):
 *
 *  • **Silhouette first.** Distinction lives in the *bind pose* — the ghoul's
 *    spine is bent and its left arm is 60 mm longer in the skeleton itself, the
 *    hound's chest sits at 0.72 m, the brute's crown is at 3.05 m. No two
 *    species share a proportion table, so they read apart as black shapes.
 *  • **Everything bevelled.** Hard parts come from `roundedBox`/`hornGeo`/
 *    `extrudeProfile`, never BoxGeometry. Swept tubes are round by construction.
 *  • **UVs in metres.** Every part passes `uvScale` from its recipe, so a 0.24 m
 *    bone grain stays 0.24 m whether it is on a skeleton or on the boss.
 *  • **Emissive by vertex mask.** Eye lights, ember cracks and boss weak points
 *    ride the `aMask` attribute (see MonsterMaterials FRAG_EFFECTS) instead of
 *    costing a draw call each.
 *  • Two accent families only — necrotic green for the undead, hellfire orange
 *    for the infernal. Never a rainbow pack.
 *
 * Determinism: geometry is built once per species from a fixed seed. Per-instance
 * variety is scale + material tint (Bestiary), never a re-build.
 */

import * as THREE from 'three';
import {
  SkinBuilder, roundedBox, hornGeo, extrudeProfile, skullGeo, mergeGeos,
} from './RigKit.js';
import { bipedRig, quadRig, floaterRig } from './Rigs.js';
import {
  bipedWalk, bipedIdle, bipedSwing, bipedHit, bipedDeath,
  quadRun, quadIdle, quadLeap, quadHit, quadDeath,
  floatBody, rattle,
} from './Clips.js';
import { RECIPES, grimeFn } from './MonsterMaterials.js';
import { ease, pulse } from './AnimKit.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const TAU = Math.PI * 2;

/* Accent palette — exactly two families, per the art-direction bible. */
export const ACCENT = {
  necrotic: 0x7ff0a8,
  necroticDim: 0x2f7a52,
  hellfire: 0xff7a22,
  hellcore: 0xffc255,
  soul: 0x9fd8ff,
};

/* ================================================================== *
 * Assembly — SkinBuilder + material-group bookkeeping
 * ================================================================== */

export class Assembly {
  /**
   * @param {import('./RigKit.js').RigDef} rig
   * @param {number} seed
   * @param {Array<{name:string,recipe:string}>} slots material slots, in order
   */
  constructor(rig, seed, slots) {
    this.rig = rig;
    this.sb = new SkinBuilder(rig, seed);
    this.slots = slots;
    this.groups = [];
    this._names = slots.map((s) => s.name);
  }

  /** Metres per texture repeat for a slot, straight off its recipe. */
  uv(slot) {
    const s = this.slots[this._names.indexOf(slot)];
    return (RECIPES[s?.recipe] ?? RECIPES.bone).uv;
  }

  /** Emit geometry into a material slot. */
  part(slot, fn) {
    const mi = this._names.indexOf(slot);
    if (mi < 0) { console.warn(`[species] unknown slot "${slot}"`); return this; }
    const start = this.sb.idx.length;
    fn(this.sb, this.uv(slot));
    const count = this.sb.idx.length - start;
    if (count <= 0) return this;
    const last = this.groups[this.groups.length - 1];
    if (last && last.mi === mi && last.start + last.count === start) last.count += count;
    else this.groups.push({ start, count, mi });
    return this;
  }

  /**
   * Reorders the index buffer so every material slot is one contiguous range.
   * Parts can therefore be authored in whatever order reads best (skull next to
   * its eye lights) while the mesh still costs exactly one draw call per slot.
   */
  build(o = {}) {
    const g = this.sb.build(o);
    const attr = g.getIndex();
    if (!attr || !this.groups.length) return g;
    const src = attr.array;
    const out = new src.constructor(src.length);
    let w = 0;
    const packed = [];
    for (let mi = 0; mi < this.slots.length; mi++) {
      const start = w;
      for (const gr of this.groups) {
        if (gr.mi !== mi) continue;
        out.set(src.subarray(gr.start, gr.start + gr.count), w);
        w += gr.count;
      }
      if (w > start) packed.push([start, w - start, mi]);
    }
    src.set(out);
    attr.needsUpdate = true;
    for (const [s, c, mi] of packed) g.addGroup(s, c, mi);
    return g;
  }
}

/* ================================================================== *
 * shared body-part builders
 * ================================================================== */

/** Swept limb segment between two joints, semi-rigid so the joint creases. */
function seg(A, slot, a, b, r0, r1, o = {}) {
  A.part(slot, (sb, uv) => sb.tube(
    [{ j: a, r: r0, sx: o.sx ?? 1, sz: o.sz ?? 1 }, { j: b, r: r1, sx: o.sx2 ?? o.sx ?? 1, sz: o.sz2 ?? o.sz ?? 1 }],
    {
      seg: o.seg ?? 8, ringsPer: o.ringsPer ?? 3, uvScale: uv, stiff: o.stiff ?? 0.55,
      noise: o.noise ?? 0, noiseFreq: o.noiseFreq ?? 7, color: o.color, mask: o.mask,
      capStart: o.capStart ?? 'round', capEnd: o.capEnd ?? 'round', seedOff: o.seedOff ?? 0,
    }
  ));
}

/** Joint ball — fills the crease and gives the elbow/knee a highlight. */
function ball(A, slot, joint, r, o = {}) {
  A.part(slot, (sb, uv) => {
    const g = new THREE.SphereGeometry(r, o.seg ?? 9, o.seg2 ?? 6);
    if (o.scale) g.scale(o.scale[0], o.scale[1], o.scale[2]);
    sb.rigid(g, joint, { at: joint, off: o.off, uvScale: uv, color: o.color, mask: o.mask });
    g.dispose();
  });
}

/** Rigid authored geometry bound to one bone. */
function hard(A, slot, geo, bone, o = {}) {
  A.part(slot, (sb, uv) => {
    sb.rigid(geo, bone, { at: o.at ?? bone, off: o.off, rot: o.rot, scale: o.scale, uvScale: uv, color: o.color, mask: o.mask });
  });
  if (o.keep !== true) geo.dispose();
}

/** Multi-control-point tube through named joints. */
function spine(A, slot, chain, o = {}) {
  A.part(slot, (sb, uv) => sb.tube(chain, {
    seg: o.seg ?? 14, ringsPer: o.ringsPer ?? 4, uvScale: uv, stiff: o.stiff ?? 0,
    noise: o.noise ?? 0, noiseFreq: o.noiseFreq ?? 6, profile: o.profile,
    capStart: o.capStart ?? 'round', capEnd: o.capEnd ?? 'round', color: o.color, mask: o.mask,
  }));
}

/**
 * Rib pairs bound to the torso. Each rib is an arc that leaves the spine,
 * wraps forward and hooks toward the sternum — the single most recognisable
 * read on an exposed-bone silhouette.
 */
function ribCage(A, slot, o) {
  const { y0, y1, halfW, depth, count, r, bind, backZ = 0 } = o;
  A.part(slot, (sb, uv) => {
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      const y = y0 + (y1 - y0) * t;
      const w = halfW * (0.72 + 0.34 * Math.sin(Math.PI * (0.22 + t * 0.7)));
      const d = depth * (0.70 + 0.36 * Math.sin(Math.PI * (0.3 + t * 0.6)));
      const drop = (o.drop ?? 0.10) * t;
      for (const sg of [1, -1]) {
        sb.tube([
          { p: [sg * w * 0.16, y, backZ - d * 0.42], r: r * 0.85, bind },
          { p: [sg * w * 0.78, y - drop * 0.25, backZ - d * 0.10], r, bind },
          { p: [sg * w * 0.92, y - drop * 0.72, backZ + d * 0.52], r: r * 0.95, bind },
          { p: [sg * w * 0.34, y - drop, backZ + d * 0.86], r: r * 0.78, bind },
        ], {
          seg: 5, ringsPer: 2, uvScale: uv, stiff: 1, color: o.color,
          capStart: 'round', capEnd: 'round', seedOff: i * 13,
        });
      }
    }
  });
}

/** Fingers / claws fanned off one bone. */
function claws(A, slot, bone, o = {}) {
  const n = o.n ?? 3;
  A.part(slot, (sb, uv) => {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) - 0.5 : 0;
      const g = hornGeo(o.len ?? 0.11, o.r0 ?? 0.016, o.r1 ?? 0.003, o.curve ?? 0.55, { steps: 6, seg: 6, lateral: t * 0.5 });
      sb.rigid(g, bone, {
        at: bone,
        off: [(o.off?.[0] ?? 0) + t * (o.spread ?? 0.055), o.off?.[1] ?? -0.02, o.off?.[2] ?? 0.02],
        rot: [(o.pitch ?? 2.5) + t * 0.16, t * 0.5, 0],
        uvScale: uv, color: o.color, mask: o.mask,
      });
      g.dispose();
    }
  });
}

/**
 * Torn cloth strips — shoulders, hem, banner scraps.
 *
 * Emitted twice with a flipped frame axis rather than once double-sided: a
 * ribbon's normals all point one way, so a single double-sided strip renders
 * pitch black from behind and reads as a flat cut-out. Two mirrored passes give
 * the scrap a correctly lit face on each side for the price of a few vertices.
 */
function tatters(A, slot, o) {
  const { anchors, n, len, w, bind } = o;
  A.part(slot, (sb, uv) => {
    for (let i = 0; i < n; i++) {
      const a = anchors[i % anchors.length];
      const k = (i * 2654435761 % 1000) / 1000;
      const sway = (k - 0.5) * (o.sway ?? 0.10);
      const l = len * (0.58 + k * 0.60);
      const ww = w * 0.66;
      const chain = [
        { p: [a[0], a[1], a[2]], w: ww * 0.85, bind },
        { p: [a[0] + sway * 0.5, a[1] - l * 0.42, a[2] + sway * 0.6], w: ww, bind },
        { p: [a[0] + sway, a[1] - l * 0.78, a[2] + sway * 0.2], w: ww * 0.70, bind },
        { p: [a[0] + sway * 1.5, a[1] - l, a[2] - sway * 0.4], w: ww * 0.26, bind },
      ];
      sb.ribbon(chain, { ringsPer: 2, uvScale: uv, axis: [0, 0, 1], color: o.color, doubleSided: false });
      sb.ribbon(chain, { ringsPer: 2, uvScale: uv, axis: [0, 0, -1], color: o.color, doubleSided: false });
    }
  });
}

/**
 * One armour lame: a closed elliptical hoop, flattened into a band.
 *
 * CLOSED on purpose. An open swept shell is the obvious way to make a lame and
 * it is wrong here: SkinBuilder emits single-sided geometry, so the inside of an
 * open band renders black and the piece reads as a paper cut-out the moment the
 * animation swings it past the camera. A squashed torus is closed, costs 320
 * triangles, and its rolled top and bottom edges are exactly the proud arrises
 * the curvature wear pass needs to find (see RigKit.curvatureAttr).
 *
 * @param {number} rx,rz  ellipse radii, metres
 * @param {number} h      band height
 * @param {number} t      band thickness
 */
function lameGeo(rx, rz, h, t, o = {}) {
  const tub = o.tub ?? 18;     // segments around the ring
  const seg = o.seg ?? 6;      // segments around the elliptical cross-section
  // `spread` flares the band's lower edge outward, which is what makes a stack
  // of lames read as a fauld rather than as a set of identical rings.
  const spread = o.spread ?? 0;
  const pos = [], idx = [];
  for (let i = 0; i < tub; i++) {
    const a = (i / tub) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const cx = ca * rx, cz = sa * rz;
    // Outward normal of the ELLIPSE (not of the circle) at this station.
    let ux = ca / rx, uz = sa / rz;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    for (let j = 0; j < seg; j++) {
      const b = (j / seg) * Math.PI * 2;
      const cb = Math.cos(b), sb = Math.sin(b);
      const rad = t * cb - spread * sb;
      pos.push(cx + ux * rad, h * 0.5 * sb, cz + uz * rad);
    }
  }
  for (let i = 0; i < tub; i++) {
    const i2 = (i + 1) % tub;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      const a = i * seg + j, b = i * seg + j2, c = i2 * seg + j, d = i2 * seg + j2;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  // No duplicated seam column, so smooth normals come out exact all the way
  // round and the band has no visible join.
  g.computeVertexNormals();
  return g;
}

/** A row of dome rivets around the front arc of a lame. */
function rivetRing(sb, bone, o) {
  const n = o.n ?? 7;
  const a0 = o.a0 ?? -1.30, a1 = o.a1 ?? 1.30;
  for (let i = 0; i < n; i++) {
    const a = a0 + (a1 - a0) * (n > 1 ? i / (n - 1) : 0.5);
    const g = new THREE.SphereGeometry(o.r ?? 0.045, 6, 4);
    g.scale(1, 0.62, 1);
    sb.rigid(g, bone, {
      at: bone,
      off: [Math.sin(a) * o.rx, o.y, Math.cos(a) * o.rz],
      uvScale: o.uv, color: o.color,
    });
    g.dispose();
  }
}

/** Two glowing points sunk into a skull's sockets. */
function eyeLights(A, slot, bone, o) {
  A.part(slot, (sb, uv) => {
    for (const sg of [1, -1]) {
      const g = new THREE.SphereGeometry(o.r ?? 0.032, 8, 6);
      sb.rigid(g, bone, { at: bone, off: [sg * (o.dx ?? 0.055), o.dy ?? 0.075, o.dz ?? 0.062], uvScale: uv, mask: 1 });
      g.dispose();
    }
  });
}

/** A ring of studded rivets around a plate — reads as forged, not extruded. */
function rivets(A, slot, bone, pts, r = 0.012) {
  A.part(slot, (sb, uv) => {
    for (const p of pts) {
      const g = new THREE.SphereGeometry(r, 6, 5);
      g.scale(1, 1, 0.7);
      sb.rigid(g, bone, { pos: p, uvScale: uv });
      g.dispose();
    }
  });
}

/* ================================================================== *
 * clip helpers
 * ================================================================== */

const clip = (fn, dur, loop = true, next = undefined) => ({ fn, dur, loop, next });
/** Play only [a,b] of a clip's phase — how one swing becomes windup/strike/recover. */
const sub = (fn, a, b) => (P, ph, ctx) => fn(P, a + (b - a) * clamp01(ph), ctx);
const layer = (...fns) => (P, ph, ctx) => { for (let i = 0; i < fns.length; i++) fns[i](P, ph, ctx); };
const reverse = (fn) => (P, ph, ctx) => fn(P, 1 - clamp01(ph), ctx);
const shake = (fn, joints, amp, freq, rot) => (P, ph, ctx) => { fn(P, ph, ctx); rattle(P, ctx, joints, amp, freq, rot); };

/** Melee set from one swing generator: hold-at-end windup, snap strike, settle. */
function meleeSet(swing, hitAt = 0.5, dur = { w: 0.52, s: 0.20, r: 0.62 }) {
  return {
    attack_windup: clip(sub(swing, 0, hitAt), dur.w, false, 'attack_windup'),
    attack: clip(sub(swing, hitAt, hitAt + 0.17), dur.s, false, 'attack'),
    attack_recover: clip(sub(swing, hitAt + 0.17, 1), dur.r, false, 'attack_recover'),
  };
}

/** Caster: both arms rise, sigil pulse, torso opens. */
function casterCast(o = {}) {
  const reach = o.reach ?? 1, sleeve = o.sleeve ?? 0;
  return (P, ph, ctx) => {
    const rise = ease.out2(clamp01(ph / 0.52));
    const push = pulse(ph, 0.74, 0.26);
    const hum = Math.sin((ctx.t ?? 0) * 7.3) * 0.012;
    P.move('root', 0, 0.035 * rise, 0);
    P.add('hips', 0.03 * rise, 0, 0);
    P.add('spine', -0.13 * rise + 0.20 * push, 0.05 * rise, 0);
    P.add('chest', -0.19 * rise + 0.30 * push, 0.07 * rise, 0);
    P.add('neck', 0.10 * rise - 0.10 * push, 0, 0);
    P.add('head', 0.14 * rise - 0.18 * push + hum, 0, 0);
    for (const [side, sg] of [['.L', 1], ['.R', -1]]) {
      P.add(`shoulder${side}`, -(1.55 + 0.55 * sleeve) * rise * reach + 0.62 * push,
        -sg * 0.18 * rise, sg * (0.30 + 0.62 * rise));
      P.add(`elbow${side}`, -(0.95 - 0.42 * rise) - 0.34 * push, 0, 0);
      P.add(`wrist${side}`, -0.42 * rise + 0.58 * push + hum * 2, 0, sg * 0.22 * rise);
      P.add(`hip${side}`, -0.05 * rise, sg * 0.04, 0);
      P.add(`knee${side}`, 0.12, 0, 0);
    }
  };
}

/** Summon: arms thrown wide and back, head to the sky, body arched. */
function casterSummon(o = {}) {
  const amp = o.amp ?? 1;
  return (P, ph, ctx) => {
    const open = ease.out3(clamp01(ph / 0.44));
    const beat = pulse(ph, 0.70, 0.24) + pulse(ph, 0.88, 0.12) * 0.6;
    const trem = Math.sin((ctx.t ?? 0) * 21) * 0.02 * open;
    P.move('root', 0, 0.06 * open + 0.03 * beat, 0);
    P.add('hips', -0.10 * open, 0, 0);
    P.add('spine', -0.24 * open * amp - 0.10 * beat, 0, 0);
    P.add('chest', -0.32 * open * amp - 0.14 * beat + trem, 0, 0);
    P.add('neck', -0.26 * open, 0, 0);
    P.add('head', -0.34 * open + trem * 2, 0.05 * Math.sin(ph * TAU * 0.7), 0);
    for (const [side, sg] of [['.L', 1], ['.R', -1]]) {
      P.add(`shoulder${side}`, -2.35 * open * amp + 0.30 * beat, -sg * 0.30 * open, sg * (0.45 + 0.95 * open));
      P.add(`elbow${side}`, -(0.30 + 0.20 * open) - 0.25 * beat, 0, 0);
      P.add(`wrist${side}`, -0.30 * open, 0, sg * 0.34 * open);
      P.add(`hip${side}`, 0.06 * open, sg * 0.06, 0);
      P.add(`knee${side}`, 0.16 + 0.10 * open, 0, 0);
    }
  };
}

/** Two-handed overhead slam — the heavy, grounded, "the floor loses" attack. */
function overheadSlam(o = {}) {
  const reach = o.reach ?? 1, hit = o.hitAt ?? 0.54;
  return (P, ph) => {
    const wind = ease.out2(clamp01(ph / hit));
    const strike = ease.snap(clamp01((ph - hit) / 0.13));
    const rec = ease.inOut(clamp01((ph - hit - 0.13) / (1 - hit - 0.13)));
    const a = wind * (1 - strike);
    P.move('root', 0, -0.10 * a - 0.30 * strike * (1 - rec * 0.8), 0.10 * a + 0.34 * strike * (1 - rec));
    P.add('root', -0.16 * a + 0.30 * strike * (1 - rec * 0.6), 0, 0);
    P.add('hips', -0.14 * a + 0.26 * strike, 0, 0);
    P.add('spine', -0.30 * a + 0.46 * strike * (1 - rec * 0.5), 0, 0);
    P.add('chest', -0.38 * a + 0.62 * strike * (1 - rec * 0.4), 0, 0);
    P.add('neck', 0.20 * a - 0.30 * strike, 0, 0);
    P.add('head', 0.24 * a - 0.42 * strike, 0, 0);
    for (const [side, sg] of [['.L', 1], ['.R', -1]]) {
      P.add(`shoulder${side}`, (-2.55 * a - 0.30) * reach + 2.15 * strike * reach, -sg * 0.12 * a, sg * (0.34 - 0.20 * a));
      P.add(`elbow${side}`, -(1.10 * a + 0.34) + 0.95 * strike, 0, 0);
      P.add(`wrist${side}`, -0.40 * a + 0.55 * strike, 0, 0);
      P.add(`hip${side}`, -0.20 * a + 0.30 * strike, sg * 0.05, 0);
      P.add(`knee${side}`, 0.52 * a + 0.70 * strike * (1 - rec), 0, 0);
      P.add(`ankle${side}`, -0.22 * a - 0.30 * strike * (1 - rec), 0, 0);
    }
  };
}

/** Roar / phase break — chest thrown open, head back, weight on the heels. */
function roarClip(o = {}) {
  const amp = o.amp ?? 1;
  return (P, ph, ctx) => {
    const up = ease.out3(clamp01(ph / 0.34));
    const hold = clamp01(1 - Math.max(0, ph - 0.62) / 0.38);
    const k = up * hold * amp;
    const trem = Math.sin((ctx.t ?? 0) * 27) * 0.03 * k;
    P.move('root', 0, 0.05 * k, -0.08 * k);
    P.add('hips', -0.14 * k, 0, 0);
    P.add('spine', -0.30 * k + trem, 0, 0);
    P.add('chest', -0.42 * k + trem, 0, 0);
    P.add('neck', -0.40 * k, 0, 0);
    P.add('head', -0.52 * k + trem * 2, 0, 0);
    P.add('jaw', 0.62 * k + trem * 3, 0, 0);
    for (const [side, sg] of [['.L', 1], ['.R', -1]]) {
      P.add(`shoulder${side}`, -0.55 * k, -sg * 0.34 * k, sg * (0.30 + 1.05 * k));
      P.add(`elbow${side}`, -(0.62 + 0.30 * k), 0, 0);
      P.add(`wrist${side}`, -0.24 * k, 0, sg * 0.30 * k);
      P.add(`hip${side}`, 0.10 * k, sg * 0.08 * k, 0);
      P.add(`knee${side}`, 0.30 * k, 0, 0);
    }
  };
}

/** Head-only scan — used for alert/look so an idle pack still feels awake. */
function lookClip(base, o = {}) {
  const amp = o.amp ?? 1;
  return (P, ph, ctx) => {
    base(P, ph, ctx);
    const s = Math.sin(ph * TAU * 0.5);
    P.add('neck', -0.06 * amp, 0.30 * amp * s, 0);
    P.add('head', -0.10 * amp, 0.36 * amp * s, 0.06 * amp * Math.cos(ph * TAU));
    P.add('chest', -0.05 * amp, 0.12 * amp * s, 0);
  };
}

/** Reach-and-thrust used by the wraith (no legs to step with). */
function floatThrust(o = {}) {
  const hit = o.hitAt ?? 0.5;
  return (P, ph, ctx) => {
    const wind = ease.out2(clamp01(ph / hit));
    const strike = ease.snap(clamp01((ph - hit) / 0.15));
    const rec = ease.inOut(clamp01((ph - hit - 0.15) / (1 - hit - 0.15)));
    const a = wind * (1 - strike);
    const drift = Math.sin((ctx.t ?? 0) * 2.1) * 0.02;
    P.move('root', 0, 0.10 * a + 0.06 * strike, -0.14 * a + 0.42 * strike * (1 - rec));
    P.add('root', -0.10 * a + 0.26 * strike * (1 - rec), 0, 0);
    P.add('hips', -0.10 * a, 0, 0);
    P.add('spine', -0.16 * a + 0.22 * strike, 0.10 * a, 0);
    P.add('chest', -0.22 * a + 0.30 * strike, 0.14 * a, 0);
    P.add('neck', 0.12 * a - 0.16 * strike, -0.10 * a, 0);
    P.add('head', 0.16 * a - 0.24 * strike + drift, -0.14 * a, 0);
    P.add('shoulder.R', -1.85 * a + 1.95 * strike, 0.24 * a, -0.42 * a);
    P.add('elbow.R', -(1.30 * a + 0.20) + 1.20 * strike, 0, 0);
    P.add('wrist.R', -0.30 * a + 0.40 * strike, 0, 0);
    P.add('shoulder.L', -0.85 * a + 0.30 * strike, -0.20 * a, 0.55 * a);
    P.add('elbow.L', -(0.75 + 0.35 * a), 0, 0);
    for (let i = 1; i <= 6; i++) {
      P.add(`tail${i}`, 0.10 + 0.12 * a - 0.16 * strike * (1 - rec), 0.06 * Math.sin((ph - i * 0.14) * TAU), 0);
    }
  };
}

/* ================================================================== *
 * SKELETON — thin, exposed bone, loose joints, rusted blade
 * ================================================================== */

function buildSkeleton(seed) {
  const rig = bipedRig({
    hips: [0, 1.00, 0], spine: [0, 0.17, 0.012], chest: [0, 0.20, -0.008],
    neck: [0, 0.17, -0.012], head: [0, 0.10, 0.022], jaw: [0, -0.055, 0.05],
    clav: [0.055, 0.055, 0.022], shoulder: [0.145, 0.0, 0],
    elbow: [0.012, -0.295, 0.006], wrist: [0.008, -0.272, 0.010], hand: [0, -0.055, 0.022],
    hip: [0.095, -0.055, 0], knee: [0.014, -0.440, 0.014],
    ankle: [-0.004, -0.420, -0.022], toe: [0, -0.082, 0.122],
  });
  const slots = [
    { name: 'bone', recipe: 'bone' },
    { name: 'metal', recipe: 'metal' },
    { name: 'cloth', recipe: 'cloth' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.02, hi: 1.5, dark: 0.70, mottle: 0.20, seed: 41, freq: 6.5, cav: 0.22, tintLow: [0.92, 0.86, 0.74] });

  /* --- spine + pelvis --- */
  spine(A, 'bone', [
    { j: 'hips', r: 0.072, sx: 1.05, sz: 0.72 },
    { j: 'spine', r: 0.056, sx: 0.92, sz: 0.70 },
    { j: 'chest', r: 0.062, sx: 0.96, sz: 0.72 },
    { j: 'neck', r: 0.040, sx: 0.85, sz: 0.85 },
  ], { seg: 10, noise: 0.16, noiseFreq: 11, color: gr });
  // vertebral spurs — the read that says "spine", not "tube"
  A.part('bone', (sb, uv) => {
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const y = 1.03 + t * 0.50;
      const g = roundedBox(0.052 - t * 0.010, 0.030, 0.044, 0.011);
      sb.rigid(g, t < 0.45 ? 'spine' : 'chest', { pos: [0, y, -0.062 - t * 0.008], rot: [0.12 * (1 - t), 0, 0], uvScale: uv, color: gr });
      g.dispose();
    }
  });
  hard(A, 'bone', pelvisGeo(0.30, 0.19, 0.17), 'hips', { off: [0, -0.045, 0.006], color: gr });
  ribCage(A, 'bone', { y0: 1.14, y1: 1.44, halfW: 0.175, depth: 0.150, count: 6, r: 0.0155, bind: 'chest', drop: 0.075, color: gr, backZ: -0.01 });
  hard(A, 'bone', roundedBox(0.066, 0.24, 0.030, 0.012), 'chest', { off: [0, -0.03, 0.126], rot: [0.08, 0, 0], color: gr });

  /* --- skull --- */
  hard(A, 'bone', skullGeo(0.235, { jawOpen: 0.0 }), 'head', { off: [0, -0.012, -0.012], color: gr });
  hard(A, 'bone', jawGeo(0.20), 'jaw', { color: gr });
  eyeLights(A, 'bone', 'head', { r: 0.030, dx: 0.050, dy: 0.068, dz: 0.056 });

  /* --- limbs --- */
  for (const side of ['.L', '.R']) {
    const s = side === '.L' ? 1 : -1;
    seg(A, 'bone', `clav${side}`, `shoulder${side}`, 0.021, 0.026, { seg: 7, color: gr, stiff: 1 });
    ball(A, 'bone', `shoulder${side}`, 0.040, { color: gr, scale: [1, 0.9, 1] });
    seg(A, 'bone', `shoulder${side}`, `elbow${side}`, 0.030, 0.024, { color: gr, noise: 0.12, sz: 0.9 });
    ball(A, 'bone', `elbow${side}`, 0.030, { color: gr });
    seg(A, 'bone', `elbow${side}`, `wrist${side}`, 0.026, 0.019, { color: gr, noise: 0.10, sx: 1.15, sz: 0.8 });
    hard(A, 'bone', roundedBox(0.058, 0.070, 0.030, 0.011), `hand${side}`, { off: [0, -0.016, 0.008], color: gr });
    claws(A, 'bone', `hand${side}`, { n: 3, len: 0.062, r0: 0.011, r1: 0.003, spread: 0.021, off: [0, -0.048, 0.012], pitch: 2.9, color: gr });

    ball(A, 'bone', `hip${side}`, 0.052, { color: gr, scale: [1, 0.85, 1] });
    seg(A, 'bone', `hip${side}`, `knee${side}`, 0.043, 0.033, { color: gr, noise: 0.12 });
    ball(A, 'bone', `knee${side}`, 0.040, { color: gr, scale: [1.1, 0.9, 1] });
    seg(A, 'bone', `knee${side}`, `ankle${side}`, 0.035, 0.024, { color: gr, noise: 0.10, sx: 0.9 });
    hard(A, 'bone', footGeo(0.088, 0.062, 0.10), `ankle${side}`, { off: [0, -0.024, 0.026], color: gr });
    hard(A, 'bone', roundedBox(0.082, 0.036, 0.088, 0.014), `toe${side}`, { off: [0, 0.010, -0.010], color: gr });
    // a single strap of rotted binding per limb — wear narrative, not symmetry
    if (s > 0) tatters(A, 'cloth', { anchors: [[s * 0.19, 1.40, 0.02]], n: 2, len: 0.34, w: 0.055, bind: 'chest', sway: 0.07 });
  }

  /* --- rusted blade + a strapped pauldron on the other shoulder --- */
  hard(A, 'metal', bladeGeo(0.80, 0.052), 'hand.R', { off: [0, -0.055, 0.030], rot: [2.62, 0.10, 0.06] });
  hard(A, 'metal', roundedBox(0.036, 0.13, 0.036, 0.010), 'hand.R', { off: [0, -0.048, 0.026], rot: [2.62, 0.10, 0.06] });
  hard(A, 'metal', pauldronGeo(0.17, 0.10), 'shoulder.L', { off: [0.024, 0.030, 0.004], rot: [0.10, 0, 0.22] });
  rivets(A, 'metal', 'shoulder.L', [[0.10, 1.485, 0.075], [0.155, 1.470, 0.010], [0.115, 1.462, -0.062]], 0.0105);
  tatters(A, 'cloth', { anchors: [[-0.14, 1.44, -0.03], [-0.18, 1.38, 0.05]], n: 3, len: 0.44, w: 0.070, bind: 'chest', sway: 0.12 });

  return { rig, geometry: A.build({ boundsPad: 1.9 }), slots };
}

/* ================================================================== *
 * GHOUL — hunched, asymmetric, lurching, torn distended flesh
 * ================================================================== */

function buildGhoul(seed) {
  const rig = bipedRig({
    hips: [0, 0.94, 0], spine: [0, 0.16, 0.090], chest: [0, 0.17, 0.110],
    neck: [0, 0.13, 0.070], head: [0, 0.06, 0.052], jaw: [0, -0.062, 0.070],
    clav: [0.062, 0.048, 0.010], shoulder: [0.155, 0.010, -0.010],
    elbow: [0.020, -0.330, 0.020], wrist: [0.012, -0.305, 0.018], hand: [0, -0.068, 0.028],
    hip: [0.100, -0.060, 0], knee: [0.022, -0.400, 0.048],
    ankle: [0, -0.380, -0.058], toe: [0, -0.078, 0.116],
    side: {
      '.L': { elbow: [0.024, -0.385, 0.022], wrist: [0.014, -0.360, 0.020], shoulder: [0.168, 0.022, -0.014] },
      '.R': { knee: [0.020, -0.372, 0.044], ankle: [0, -0.356, -0.052] },
    },
  });
  const slots = [
    { name: 'rot', recipe: 'rot' },
    { name: 'bone', recipe: 'boneOld' },
    { name: 'cloth', recipe: 'cloth' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.02, hi: 1.35, dark: 0.68, mottle: 0.26, seed: 97, freq: 5.0, cav: 0.24, up: 0.06, tintLow: [0.86, 0.78, 0.70] });
  const grB = grimeFn({ lo: 0.02, hi: 1.4, dark: 0.74, mottle: 0.18, seed: 133, freq: 7.0 });

  /* --- torso: bloated belly, sunken chest, one shoulder higher --- */
  spine(A, 'rot', [
    { j: 'hips', r: 0.150, sx: 1.10, sz: 0.94 },
    { j: 'spine', r: 0.168, sx: 1.14, sz: 1.02 },
    { j: 'chest', r: 0.150, sx: 1.22, sz: 0.86 },
    { j: 'neck', r: 0.088, sx: 1.05, sz: 0.95 },
  ], { seg: 15, noise: 0.24, noiseFreq: 7.5, color: gr });
  // distended gut, offset to one side so the silhouette is never mirrored
  ball(A, 'rot', 'spine', 0.165, { seg: 14, seg2: 11, scale: [1.10, 0.92, 1.16], off: [0.030, -0.055, 0.062], color: gr });
  ball(A, 'rot', 'hips', 0.135, { seg: 12, seg2: 9, scale: [1.16, 0.82, 1.00], off: [-0.018, -0.020, 0.010], color: gr });
  // ribs breaking through on the left flank only
  A.part('bone', (sb, uv) => {
    for (let i = 0; i < 4; i++) {
      const y = 1.16 + i * 0.075;
      sb.tube([
        { p: [0.055, y, 0.10], r: 0.016, bind: 'chest' },
        { p: [0.135, y - 0.012, 0.155], r: 0.017, bind: 'chest' },
        { p: [0.150, y - 0.048, 0.215], r: 0.013, bind: 'chest' },
      ], { seg: 6, ringsPer: 3, uvScale: uv, stiff: 1, color: grB, seedOff: i * 7 });
    }
  });
  hard(A, 'bone', pelvisGeo(0.24, 0.15, 0.15), 'hips', { off: [0, -0.055, 0.010], color: grB });

  /* --- head: lipless, jaw hanging, scalp gone --- */
  ball(A, 'rot', 'head', 0.115, { seg: 14, seg2: 11, scale: [0.94, 1.00, 1.10], off: [0, 0.020, -0.010], color: gr });
  hard(A, 'bone', skullGeo(0.185, { jawOpen: 0.0 }), 'head', { off: [0, -0.006, 0.010], scale: [0.94, 0.92, 1.02], color: grB });
  hard(A, 'bone', jawGeo(0.165), 'jaw', { rot: [0.30, 0, 0], color: grB });
  eyeLights(A, 'rot', 'head', { r: 0.022, dx: 0.042, dy: 0.058, dz: 0.062 });

  /* --- limbs: left arm long enough to knuckle-drag --- */
  for (const side of ['.L', '.R']) {
    const long = side === '.L';
    ball(A, 'rot', `shoulder${side}`, long ? 0.080 : 0.070, { color: gr, scale: [1, 0.92, 1] });
    seg(A, 'rot', `shoulder${side}`, `elbow${side}`, long ? 0.062 : 0.055, long ? 0.050 : 0.045, { color: gr, noise: 0.20, seg: 10 });
    ball(A, 'rot', `elbow${side}`, long ? 0.050 : 0.044, { color: gr });
    seg(A, 'rot', `elbow${side}`, `wrist${side}`, long ? 0.048 : 0.042, 0.030, { color: gr, noise: 0.18, seg: 10 });
    hard(A, 'rot', roundedBox(0.078, 0.086, 0.040, 0.016), `hand${side}`, { off: [0, -0.022, 0.010], color: gr });
    claws(A, 'bone', `hand${side}`, {
      n: 3, len: long ? 0.115 : 0.096, r0: 0.014, r1: 0.0028, spread: 0.028,
      off: [0, -0.060, 0.016], pitch: 2.85, color: grB,
    });
    ball(A, 'rot', `hip${side}`, 0.088, { color: gr, scale: [1, 0.86, 1] });
    seg(A, 'rot', `hip${side}`, `knee${side}`, 0.078, 0.058, { color: gr, noise: 0.18 });
    ball(A, 'rot', `knee${side}`, 0.058, { color: gr, scale: [1.1, 0.92, 1] });
    seg(A, 'rot', `knee${side}`, `ankle${side}`, 0.056, 0.034, { color: gr, noise: 0.16 });
    hard(A, 'rot', footGeo(0.098, 0.070, 0.115), `ankle${side}`, { off: [0, -0.026, 0.028], color: gr });
    claws(A, 'bone', `toe${side}`, { n: 3, len: 0.052, r0: 0.011, r1: 0.003, spread: 0.028, off: [0, -0.006, 0.036], pitch: 1.62, color: grB });
  }

  /* --- torn skin flaps + a scrap of what it was buried in --- */
  tatters(A, 'rot', { anchors: [[0.145, 1.20, 0.20], [-0.16, 1.12, 0.16], [0.05, 1.05, 0.22]], n: 4, len: 0.24, w: 0.065, bind: 'spine', sway: 0.10, color: gr });
  tatters(A, 'cloth', { anchors: [[-0.16, 1.26, -0.02], [0.13, 1.22, -0.06]], n: 3, len: 0.42, w: 0.085, bind: 'chest', sway: 0.14 });

  return { rig, geometry: A.build({ boundsPad: 1.9 }), slots };
}

/* ================================================================== *
 * CULTIST — robed, hooded, faceless, glides
 * ================================================================== */

function buildCultist(seed) {
  const rig = bipedRig({
    hips: [0, 0.99, 0], spine: [0, 0.18, 0.010], chest: [0, 0.19, 0.004],
    neck: [0, 0.16, -0.010], head: [0, 0.11, 0.014], jaw: [0, -0.05, 0.05],
    clav: [0.058, 0.052, 0.018], shoulder: [0.150, 0.0, 0],
    elbow: [0.014, -0.300, 0.008], wrist: [0.010, -0.278, 0.012], hand: [0, -0.058, 0.024],
    hip: [0.092, -0.058, 0], knee: [0.012, -0.442, 0.012],
    ankle: [-0.004, -0.418, -0.020], toe: [0, -0.080, 0.118],
  });
  const slots = [
    { name: 'cloth', recipe: 'cloth' },
    { name: 'bone', recipe: 'bone' },
    { name: 'brass', recipe: 'brass' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.0, hi: 1.9, dark: 0.64, mottle: 0.20, seed: 211, freq: 4.0, cav: 0.20, tintLow: [0.80, 0.74, 0.70] });
  const grB = grimeFn({ lo: 0.6, hi: 1.7, dark: 0.78, mottle: 0.16, seed: 251, freq: 7.0 });

  /* --- robe: one continuous cone from the shoulders to the floor --- */
  spine(A, 'cloth', [
    { j: 'chest', r: 0.185, sx: 1.10, sz: 0.90 },
    { p: [0, 1.14, 0.010], r: 0.205, sx: 1.06, sz: 0.94, bind: 'chest' },
    { p: [0, 0.92, 0.014], r: 0.235, sx: 1.02, sz: 0.98, bind: 'spine' },
    { p: [0, 0.58, 0.010], r: 0.285, sx: 1.00, sz: 1.00, bind: 'hips' },
    { p: [0, 0.24, 0.004], r: 0.330, sx: 1.02, sz: 1.00, bind: 'hips' },
    { p: [0, 0.030, 0.008], r: 0.360, sx: 1.04, sz: 1.02, bind: 'hips' },
  ], { seg: 20, ringsPer: 3, noise: 0.10, noiseFreq: 9, color: gr, profile: (a) => 1 + 0.045 * Math.cos(a * 7) + 0.03 * Math.cos(a * 13 + 1.1) });
  hard(A, 'cloth', new THREE.CircleGeometry(0.362, 18), 'hips', { pos: [0, 0.026, 0.008], rot: [Math.PI * 0.5, 0, 0], color: gr });

  /* --- cowl + hood: the face is a void with two slits in it --- */
  spine(A, 'cloth', [
    { j: 'chest', r: 0.150, sx: 1.24, sz: 1.00 },
    { j: 'neck', r: 0.125, sx: 1.10, sz: 1.02 },
    { j: 'head', r: 0.145, sx: 1.00, sz: 1.05 },
    { p: [0, 1.79, -0.030], r: 0.105, sx: 0.96, sz: 1.00, bind: 'head' },
    { p: [0, 1.86, -0.075], r: 0.035, sx: 0.9, sz: 0.9, bind: 'head' },
  ], { seg: 16, ringsPer: 3, noise: 0.12, noiseFreq: 8, color: gr });
  // hood brim, pulled forward over where a face would be
  A.part('cloth', (sb, uv) => {
    const g = new THREE.SphereGeometry(0.148, 16, 10, 0, TAU, 0, Math.PI * 0.62);
    g.scale(1.02, 0.92, 1.10);
    sb.rigid(g, 'head', { at: 'head', off: [0, 0.010, 0.030], rot: [0.34, 0, 0], uvScale: uv, color: gr });
    g.dispose();
  });
  ball(A, 'bone', 'head', 0.088, { seg: 12, seg2: 9, off: [0, 0.006, 0.028], scale: [0.92, 1.0, 1.0], color: grB });
  eyeLights(A, 'bone', 'head', { r: 0.024, dx: 0.038, dy: 0.020, dz: 0.088 });

  /* --- sleeves and hands --- */
  for (const side of ['.L', '.R']) {
    seg(A, 'cloth', `shoulder${side}`, `elbow${side}`, 0.086, 0.072, { color: gr, seg: 11, noise: 0.10 });
    seg(A, 'cloth', `elbow${side}`, `wrist${side}`, 0.074, 0.062, { color: gr, seg: 11, noise: 0.12 });
    hard(A, 'bone', roundedBox(0.062, 0.074, 0.034, 0.013), `hand${side}`, { off: [0, -0.018, 0.010], color: grB });
    claws(A, 'bone', `hand${side}`, { n: 3, len: 0.058, r0: 0.010, r1: 0.0026, spread: 0.022, off: [0, -0.048, 0.014], pitch: 2.95, color: grB });
    tatters(A, 'cloth', {
      anchors: [[(side === '.L' ? 1 : -1) * 0.20, 1.36, -0.02]], n: 2, len: 0.40, w: 0.072, bind: 'chest', sway: 0.12, color: gr,
    });
  }

  /* --- brass censer on a chain, held low in the left hand --- */
  hard(A, 'brass', censerGeo(0.085), 'hand.L', { off: [0.012, -0.26, 0.040], mask: 0 });
  A.part('brass', (sb, uv) => {
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const g = new THREE.TorusGeometry(0.014, 0.0042, 5, 8);
      g.rotateX(i % 2 ? 0 : Math.PI * 0.5);
      sb.rigid(g, 'hand.L', { at: 'hand.L', off: [0.012, -0.045 - t * 0.185, 0.026 + t * 0.012], uvScale: uv });
      g.dispose();
    }
  });
  // ember bed inside the censer bowl — the only bright thing on the model
  A.part('brass', (sb, uv) => {
    const g = new THREE.SphereGeometry(0.048, 10, 7);
    g.scale(1, 0.55, 1);
    sb.rigid(g, 'hand.L', { at: 'hand.L', off: [0.012, -0.268, 0.040], uvScale: uv, mask: 1 });
    g.dispose();
  });
  // sigil plate on the chest, engraved and glowing faintly
  hard(A, 'brass', sigilGeo(0.105), 'chest', { off: [0, 0.020, 0.152], rot: [0.10, 0, 0], mask: 0.85 });

  return { rig, geometry: A.build({ boundsPad: 1.8 }), slots };
}

/* ================================================================== *
 * HELLHOUND — quadruped, low, fast, burning mane
 * ================================================================== */

function buildHound(seed) {
  const rig = quadRig({
    rootY: 0.66,
    spine1: [0, 0.030, 0.225], spine2: [0, 0.038, 0.240], chest: [0, 0.024, 0.225],
    neck1: [0, 0.098, 0.175], neck2: [0, 0.016, 0.170], head: [0, -0.020, 0.145], jaw: [0, -0.072, 0.092],
    tail: [0, 0.022, -0.185], tails: 3,
    fHip: [0.150, -0.040, 0.020], fKnee: [0.012, -0.300, -0.024], fAnkle: [0, -0.240, 0.044], fPaw: [0, -0.104, 0.052],
    bHip: [0.160, -0.020, -0.020], bKnee: [0.012, -0.280, 0.052], bAnkle: [0, -0.220, -0.070], bPaw: [0, -0.098, 0.100],
  });
  const slots = [
    { name: 'hide', recipe: 'charred' },
    { name: 'bone', recipe: 'boneOld' },
    { name: 'ember', recipe: 'ember' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.0, hi: 0.95, dark: 0.66, mottle: 0.24, seed: 307, freq: 6.0, cav: 0.26, tintLow: [0.72, 0.66, 0.62] });
  const grB = grimeFn({ lo: 0.0, hi: 0.9, dark: 0.76, mottle: 0.18, seed: 349, freq: 8.0 });

  /* --- barrel body: deep chest, wasp waist, dropped haunches --- */
  spine(A, 'hide', [
    { p: [0, 0.700, -0.175], r: 0.140, sx: 1.00, sz: 0.96, bind: 'root' },
    { j: 'root', r: 0.175, sx: 1.02, sz: 1.06 },
    { j: 'spine1', r: 0.148, sx: 0.92, sz: 1.00 },
    { j: 'spine2', r: 0.152, sx: 0.96, sz: 1.06 },
    { j: 'chest', r: 0.170, sx: 1.00, sz: 1.12 },
    { j: 'neck1', r: 0.120, sx: 0.92, sz: 1.00 },
    { j: 'neck2', r: 0.104, sx: 0.90, sz: 0.98 },
  ], { seg: 16, ringsPer: 4, noise: 0.18, noiseFreq: 8, color: gr });
  // exposed ribs on the flanks — burnt hide has pulled back off the bone
  A.part('bone', (sb, uv) => {
    for (let i = 0; i < 4; i++) {
      const z = 0.28 + i * 0.095;
      for (const sg of [1, -1]) {
        sb.tube([
          { p: [sg * 0.050, 0.800, z], r: 0.014, bind: 'spine2' },
          { p: [sg * 0.148, 0.740, z + 0.010], r: 0.015, bind: 'spine2' },
          { p: [sg * 0.138, 0.638, z + 0.014], r: 0.012, bind: 'spine2' },
        ], { seg: 6, ringsPer: 3, uvScale: uv, stiff: 1, color: grB, seedOff: i * 11 });
      }
    }
  });

  /* --- head: long muzzle, no lips, big canines --- */
  spine(A, 'hide', [
    { j: 'head', r: 0.098, sx: 1.00, sz: 1.00 },
    { p: [0, 0.826, 1.300], r: 0.082, sx: 0.92, sz: 0.90, bind: 'head' },
    { p: [0, 0.804, 1.395], r: 0.056, sx: 0.86, sz: 0.78, bind: 'head' },
  ], { seg: 12, ringsPer: 3, noise: 0.14, noiseFreq: 10, color: gr });
  hard(A, 'bone', skullGeo(0.170, {}), 'head', { off: [0, -0.010, 0.020], scale: [0.96, 0.86, 1.28], color: grB });
  hard(A, 'bone', jawGeo(0.150), 'jaw', { rot: [0.10, 0, 0], scale: [0.96, 0.9, 1.30], color: grB });
  A.part('bone', (sb, uv) => {
    for (const sg of [1, -1]) {
      for (let i = 0; i < 2; i++) {
        const g = hornGeo(0.052 - i * 0.012, 0.010, 0.002, 0.30, { steps: 5, seg: 5 });
        sb.rigid(g, i === 0 ? 'head' : 'jaw', {
          at: i === 0 ? 'head' : 'jaw',
          off: [sg * 0.036, i === 0 ? -0.020 : 0.014, 0.128 - i * 0.012],
          rot: [i === 0 ? Math.PI * 0.92 : 0.14, 0, sg * 0.10], uvScale: uv, color: grB,
        });
        g.dispose();
      }
    }
  });
  // ears, swept back
  A.part('hide', (sb, uv) => {
    for (const sg of [1, -1]) {
      const g = extrudeProfile([[0, 0], [0.045, 0.02], [0.052, 0.10], [0.012, 0.135], [-0.020, 0.06]], 0.014, { bevel: 0.006 });
      sb.rigid(g, 'head', { at: 'head', off: [sg * 0.070, 0.055, 0.016], rot: [-0.50, sg * 0.55, sg * 0.30], uvScale: uv, color: gr });
      g.dispose();
    }
  });

  /* --- burning mane: a ring of ember quills around the neck and shoulders.
         Kept small and few: this is a mane that glows, not a light source. --- */
  A.part('ember', (sb, uv) => {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + 0.31;
      const t = (i * 2654435761 % 997) / 997;
      const len = 0.105 + t * 0.085;
      const ring = 0.135 + 0.02 * Math.sin(a * 3);
      const g = hornGeo(len, 0.014, 0.0028, 0.55 + t * 0.4, { steps: 5, seg: 5, lateral: (t - 0.5) * 0.5 });
      sb.rigid(g, i % 3 === 0 ? 'chest' : 'neck1', {
        pos: [Math.cos(a) * ring, 0.930 + Math.sin(a) * ring * 0.72, 0.845 - Math.abs(Math.cos(a)) * 0.05 + t * 0.06],
        rot: [-1.25 + t * 0.5, 0, -a + Math.PI * 0.5],
        uvScale: uv, mask: 1,
      });
      g.dispose();
    }
    // ember cracks running along the spine
    for (let i = 0; i < 7; i++) {
      const z = 0.16 + i * 0.100;
      const g = new THREE.SphereGeometry(0.019 - i * 0.001, 7, 5);
      g.scale(0.5, 0.4, 1.5);
      sb.rigid(g, i < 3 ? 'spine1' : 'spine2', { pos: [0.006 * (i % 2 ? 1 : -1), 0.872 + 0.004 * i, z], uvScale: uv, mask: 1 });
      g.dispose();
    }
  });

  /* --- legs: digitigrade, dry and sinewy --- */
  for (const side of ['.L', '.R']) {
    for (const [h, k, an, p, r0, r1] of [
      ['fHip', 'fKnee', 'fAnkle', 'fPaw', 0.062, 0.040],
      ['bHip', 'bKnee', 'bAnkle', 'bPaw', 0.072, 0.044],
    ]) {
      ball(A, 'hide', `${h}${side}`, r0 * 1.15, { color: gr, scale: [1, 0.9, 1.1] });
      seg(A, 'hide', `${h}${side}`, `${k}${side}`, r0, r1 * 1.15, { color: gr, noise: 0.16, seg: 9 });
      ball(A, 'hide', `${k}${side}`, r1 * 1.1, { color: gr });
      seg(A, 'hide', `${k}${side}`, `${an}${side}`, r1, r1 * 0.72, { color: gr, noise: 0.14, seg: 8 });
      seg(A, 'hide', `${an}${side}`, `${p}${side}`, r1 * 0.72, r1 * 0.66, { color: gr, seg: 7 });
      hard(A, 'hide', footGeo(0.078, 0.048, 0.092), `${p}${side}`, { off: [0, -0.014, 0.018], color: gr });
      claws(A, 'bone', `${p}${side}`, { n: 3, len: 0.044, r0: 0.0095, r1: 0.0024, spread: 0.024, off: [0, -0.014, 0.040], pitch: 1.72, color: grB });
    }
  }

  /* --- tail, ember-tipped --- */
  spine(A, 'hide', [
    { j: 'root', r: 0.070, sx: 1, sz: 1 },
    { j: 'tail1', r: 0.048 },
    { j: 'tail2', r: 0.032 },
    { j: 'tail3', r: 0.016 },
  ], { seg: 9, ringsPer: 3, noise: 0.14, color: gr });
  A.part('ember', (sb, uv) => {
    const g = new THREE.SphereGeometry(0.022, 8, 6);
    g.scale(0.8, 0.8, 1.6);
    sb.rigid(g, 'tail3', { at: 'tail3', off: [0, 0, -0.030], uvScale: uv, mask: 1 });
    g.dispose();
  });

  return { rig, geometry: A.build({ boundsPad: 2.0 }), slots };
}

/* ================================================================== *
 * BRUTE — 3.2 m, massive, slow, huge asymmetric weapon
 * ================================================================== */

function buildBrute(seed) {
  const rig = bipedRig({
    hips: [0, 1.72, 0], spine: [0, 0.30, 0.050], chest: [0, 0.34, 0.060],
    neck: [0, 0.18, -0.070], head: [0, 0.10, 0.075], jaw: [0, -0.095, 0.115],
    clav: [0.105, 0.095, 0.020], shoulder: [0.300, 0.020, 0],
    elbow: [0.035, -0.520, 0.014], wrist: [0.022, -0.480, 0.020], hand: [0, -0.105, 0.035],
    hip: [0.180, -0.100, 0], knee: [0.032, -0.740, 0.034],
    ankle: [0, -0.660, -0.052], toe: [0, -0.145, 0.230],
    side: {
      '.R': { shoulder: [0.345, 0.045, 0], elbow: [0.040, -0.600, 0.016], wrist: [0.026, -0.545, 0.022], hand: [0, -0.120, 0.040] },
      '.L': { shoulder: [0.285, -0.010, 0], elbow: [0.030, -0.455, 0.012], wrist: [0.020, -0.420, 0.018] },
    },
  });
  const slots = [
    { name: 'flesh', recipe: 'flesh' },
    { name: 'metal', recipe: 'metal' },
    { name: 'bone', recipe: 'boneOld' },
    { name: 'cloth', recipe: 'cloth' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.05, hi: 2.7, dark: 0.66, mottle: 0.24, seed: 419, freq: 3.0, cav: 0.26, tintLow: [0.82, 0.70, 0.64] });
  const grB = grimeFn({ lo: 0.2, hi: 2.9, dark: 0.74, mottle: 0.18, seed: 457, freq: 4.5 });

  /* --- slab torso, hunched forward, shoulders above the head --- */
  spine(A, 'flesh', [
    { j: 'hips', r: 0.300, sx: 1.10, sz: 0.88 },
    { j: 'spine', r: 0.330, sx: 1.14, sz: 0.94 },
    { j: 'chest', r: 0.360, sx: 1.30, sz: 0.90 },
    { j: 'neck', r: 0.190, sx: 1.20, sz: 1.00 },
  ], { seg: 18, ringsPer: 4, noise: 0.22, noiseFreq: 4.2, color: gr });
  ball(A, 'flesh', 'spine', 0.315, { seg: 16, seg2: 12, scale: [1.06, 0.88, 1.10], off: [-0.030, -0.060, 0.090], color: gr });
  // trapezius mass on the weapon side — a genuinely lopsided upper body
  ball(A, 'flesh', 'chest', 0.245, { seg: 14, seg2: 11, scale: [1.20, 0.86, 1.00], off: [-0.180, 0.150, -0.030], color: gr });
  ball(A, 'flesh', 'chest', 0.195, { seg: 13, seg2: 10, scale: [1.10, 0.84, 1.00], off: [0.185, 0.115, -0.020], color: gr });
  hard(A, 'bone', pelvisGeo(0.52, 0.34, 0.30), 'hips', { off: [0, -0.085, 0.010], color: grB });
  // spinal plates
  A.part('bone', (sb, uv) => {
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const g = hornGeo(0.10 + 0.075 * Math.sin(Math.PI * t), 0.036, 0.008, 0.75, { steps: 5, seg: 6 });
      sb.rigid(g, t < 0.5 ? 'spine' : 'chest', {
        pos: [0, 1.80 + t * 0.60, -0.245 - 0.03 * Math.sin(Math.PI * t)],
        rot: [Math.PI * 0.62 - t * 0.22, 0, 0], uvScale: uv, color: grB,
      });
      g.dispose();
    }
  });

  /* --- head: small, sunk, mouth stitched with iron staples --- */
  ball(A, 'flesh', 'head', 0.200, { seg: 15, seg2: 12, scale: [0.92, 1.00, 1.06], off: [0, 0.030, -0.010], color: gr });
  hard(A, 'flesh', jawGeo(0.245), 'jaw', { rot: [0.14, 0, 0], color: gr });
  A.part('metal', (sb, uv) => {
    for (let i = 0; i < 5; i++) {
      const g = roundedBox(0.020, 0.052, 0.014, 0.006);
      sb.rigid(g, 'jaw', { at: 'jaw', off: [-0.085 + i * 0.042, 0.008, 0.112], rot: [0.20, 0, (i - 2) * 0.10], uvScale: uv });
      g.dispose();
    }
  });
  eyeLights(A, 'flesh', 'head', { r: 0.034, dx: 0.062, dy: 0.058, dz: 0.152 });

  /* --- arms: right one is the weapon arm and it shows --- */
  for (const side of ['.L', '.R']) {
    const big = side === '.R';
    const s = big ? 1.16 : 0.94;
    ball(A, 'flesh', `shoulder${side}`, 0.185 * s, { seg: 14, seg2: 11, color: gr, scale: [1, 0.94, 1] });
    seg(A, 'flesh', `shoulder${side}`, `elbow${side}`, 0.155 * s, 0.120 * s, { color: gr, noise: 0.20, seg: 12 });
    ball(A, 'flesh', `elbow${side}`, 0.115 * s, { color: gr });
    seg(A, 'flesh', `elbow${side}`, `wrist${side}`, 0.118 * s, 0.086 * s, { color: gr, noise: 0.18, seg: 11 });
    hard(A, 'flesh', roundedBox(0.175 * s, 0.190 * s, 0.105 * s, 0.030), `hand${side}`, { off: [0, -0.045, 0.020], color: gr });
    claws(A, 'bone', `hand${side}`, { n: 4, len: 0.115, r0: 0.021, r1: 0.005, spread: 0.048, off: [0, -0.115, 0.030], pitch: 2.9, color: grB });
  }
  // riveted pauldron over the smaller shoulder, chain across the chest
  hard(A, 'metal', pauldronGeo(0.36, 0.22), 'shoulder.L', { off: [0.045, 0.075, 0.010], rot: [0.12, 0, 0.26] });
  rivets(A, 'metal', 'shoulder.L', [[0.20, 2.53, 0.14], [0.31, 2.50, 0.02], [0.235, 2.47, -0.115], [0.135, 2.55, 0.03]], 0.022);
  A.part('metal', (sb, uv) => {
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const g = new THREE.TorusGeometry(0.036, 0.011, 6, 9);
      g.rotateX(i % 2 ? 0 : Math.PI * 0.5);
      g.rotateZ(0.5);
      sb.rigid(g, 'chest', {
        pos: [-0.235 + t * 0.470, 2.44 - 0.30 * Math.sin(Math.PI * t) - t * 0.10, 0.245 - 0.06 * Math.sin(Math.PI * t)],
        uvScale: uv,
      });
      g.dispose();
    }
  });

  /* --- legs: tree-trunk, splayed --- */
  for (const side of ['.L', '.R']) {
    ball(A, 'flesh', `hip${side}`, 0.205, { seg: 14, seg2: 11, color: gr, scale: [1, 0.88, 1] });
    seg(A, 'flesh', `hip${side}`, `knee${side}`, 0.190, 0.140, { color: gr, noise: 0.18, seg: 12 });
    ball(A, 'flesh', `knee${side}`, 0.145, { color: gr, scale: [1.1, 0.92, 1] });
    seg(A, 'flesh', `knee${side}`, `ankle${side}`, 0.140, 0.090, { color: gr, noise: 0.16, seg: 11 });
    hard(A, 'flesh', footGeo(0.235, 0.150, 0.320), `ankle${side}`, { off: [0, -0.055, 0.075], color: gr });
    hard(A, 'flesh', roundedBox(0.215, 0.095, 0.185, 0.035), `toe${side}`, { off: [0, 0.020, -0.020], color: gr });
    claws(A, 'bone', `toe${side}`, { n: 3, len: 0.085, r0: 0.020, r1: 0.005, spread: 0.062, off: [0, -0.010, 0.078], pitch: 1.62, color: grB });
    // iron band round the ankle, half-buried in the flesh
    hard(A, 'metal', new THREE.TorusGeometry(0.135, 0.026, 7, 12), `ankle${side}`, { at: `ankle${side}`, off: [0, 0.030, 0], rot: [Math.PI * 0.5, 0, 0] });
  }

  /* --- the weapon: a bridge-rail maul, longer than a man --- */
  hard(A, 'metal', maulGeo(), 'hand.R', { off: [0.010, -0.150, 0.060], rot: [2.42, 0.16, 0.10] });
  // loincloth of stitched hides
  tatters(A, 'cloth', {
    anchors: [[-0.26, 1.66, 0.16], [-0.09, 1.63, 0.24], [0.10, 1.64, 0.22], [0.27, 1.66, 0.14], [0, 1.62, -0.24]],
    n: 6, len: 0.80, w: 0.155, bind: 'hips', sway: 0.16,
  });

  return { rig, geometry: A.build({ boundsPad: 1.8 }), slots };
}

/* ================================================================== *
 * WRAITH — legless, semi-transparent, trailing smoke
 * ================================================================== */

function buildWraith(seed) {
  const rig = floaterRig({
    hips: [0, 1.05, 0], spine: [0, 0.185, -0.010], chest: [0, 0.205, -0.006],
    neck: [0, 0.150, -0.010], head: [0, 0.110, 0.014],
    shoulder: [0.170, 0.020, 0], elbow: [0.022, -0.320, 0.030], wrist: [0.016, -0.300, 0.026], hand: [0, -0.072, 0.026],
    tail: [[0, -0.150, -0.020], [0, -0.160, -0.030], [0, -0.165, -0.026], [0, -0.170, -0.014], [0, -0.165, 0.010], [0, -0.150, 0.026]],
    tails: 6,
  });
  const slots = [
    { name: 'shroud', recipe: 'cloth' },
    { name: 'bone', recipe: 'bone' },
    { name: 'smoke', recipe: 'cloth' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.1, hi: 2.0, dark: 0.68, mottle: 0.22, seed: 523, freq: 4.5, cav: 0.18, tintLow: [0.72, 0.78, 0.82] });
  const grB = grimeFn({ lo: 0.8, hi: 1.8, dark: 0.80, mottle: 0.16, seed: 571, freq: 7.5 });

  /* --- shroud: shoulders down to where legs should be, then nothing --- */
  spine(A, 'shroud', [
    { j: 'chest', r: 0.190, sx: 1.16, sz: 0.92 },
    { j: 'spine', r: 0.185, sx: 1.08, sz: 0.92 },
    { j: 'hips', r: 0.175, sx: 1.02, sz: 0.94 },
    { j: 'tail1', r: 0.150, sx: 0.98, sz: 0.96 },
    { j: 'tail2', r: 0.115, sx: 0.94, sz: 0.94 },
    { j: 'tail3', r: 0.078, sx: 0.90, sz: 0.90 },
  ], { seg: 18, ringsPer: 3, noise: 0.16, noiseFreq: 7, color: gr, capEnd: 'none', profile: (a) => 1 + 0.05 * Math.cos(a * 6) + 0.03 * Math.cos(a * 11 + 0.7) });

  /* --- cowl and skull --- */
  spine(A, 'shroud', [
    { j: 'chest', r: 0.165, sx: 1.30, sz: 1.02 },
    { j: 'neck', r: 0.130, sx: 1.10, sz: 1.02 },
    { j: 'head', r: 0.150, sx: 1.00, sz: 1.06 },
    { p: [0, 1.72, -0.045], r: 0.100, sx: 0.94, sz: 0.98, bind: 'head' },
    { p: [0, 1.80, -0.100], r: 0.030, sx: 0.9, sz: 0.9, bind: 'head' },
  ], { seg: 16, ringsPer: 3, noise: 0.14, noiseFreq: 8, color: gr });
  A.part('shroud', (sb, uv) => {
    const g = new THREE.SphereGeometry(0.152, 16, 10, 0, TAU, 0, Math.PI * 0.60);
    g.scale(1.04, 0.90, 1.12);
    sb.rigid(g, 'head', { at: 'head', off: [0, 0.014, 0.026], rot: [0.30, 0, 0], uvScale: uv, color: gr });
    g.dispose();
  });
  hard(A, 'bone', skullGeo(0.185, {}), 'head', { off: [0, -0.014, 0.014], scale: [0.94, 0.96, 0.98], color: grB });
  eyeLights(A, 'bone', 'head', { r: 0.026, dx: 0.042, dy: 0.058, dz: 0.062 });

  /* --- long thin arms, skeletal hands --- */
  for (const side of ['.L', '.R']) {
    seg(A, 'shroud', `shoulder${side}`, `elbow${side}`, 0.078, 0.058, { color: gr, seg: 10, noise: 0.14 });
    seg(A, 'shroud', `elbow${side}`, `wrist${side}`, 0.060, 0.040, { color: gr, seg: 10, noise: 0.16 });
    hard(A, 'bone', roundedBox(0.058, 0.070, 0.030, 0.012), `hand${side}`, { off: [0, -0.018, 0.010], color: grB });
    claws(A, 'bone', `hand${side}`, { n: 3, len: 0.105, r0: 0.010, r1: 0.0022, spread: 0.024, off: [0, -0.052, 0.014], pitch: 2.9, color: grB });
  }

  /* --- trailing smoke: ribbons that fade out toward the ground --- */
  A.part('smoke', (sb, uv) => {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * TAU + 0.4;
      const k = (i * 2654435761 % 991) / 991;
      const rr = 0.115 + k * 0.075;
      const bind = i % 2 ? 'tail3' : 'tail2';
      sb.ribbon([
        { p: [Math.cos(a) * rr * 0.5, 0.92, Math.sin(a) * rr * 0.5], w: 0.075, bind: 'hips' },
        { p: [Math.cos(a) * rr, 0.62 - k * 0.08, Math.sin(a) * rr], w: 0.095 + k * 0.03, bind: 'tail2' },
        { p: [Math.cos(a) * rr * 1.15, 0.34 - k * 0.10, Math.sin(a) * rr * 1.2], w: 0.075, bind },
        { p: [Math.cos(a + 0.5) * rr * 0.9, 0.10 - k * 0.06, Math.sin(a + 0.5) * rr * 1.0], w: 0.030, bind: 'tail5' },
      ], { ringsPer: 3, uvScale: uv, axis: [0, 1, 0], color: gr, doubleSided: true });
    }
  });

  return { rig, geometry: A.build({ boundsPad: 2.1 }), slots };
}

/* ================================================================== *
 * BOSS — 6.5 m, multi-phase, molten weak points
 * ================================================================== */

function buildBoss(seed) {
  const rig = bipedRig({
    hips: [0, 3.20, 0], spine: [0, 0.52, 0.070], chest: [0, 0.62, 0.085],
    neck: [0, 0.30, -0.110], head: [0, 0.18, 0.130], jaw: [0, -0.165, 0.205],
    clav: [0.200, 0.165, 0.040], shoulder: [0.620, 0.040, 0],
    elbow: [0.060, -1.020, 0.024], wrist: [0.040, -0.940, 0.030], hand: [0, -0.185, 0.060],
    hip: [0.340, -0.200, 0], knee: [0.050, -1.440, 0.060],
    ankle: [0, -1.300, -0.100], toe: [0, -0.260, 0.420],
    side: {
      '.R': { shoulder: [0.680, 0.070, 0], elbow: [0.070, -1.120, 0.026], wrist: [0.045, -1.010, 0.032] },
    },
  });
  /* MATERIAL SLOTS — rebuilt, because what the warden was wearing is most of
     why it read as "an untextured plastic mannequin".
       char   charred (kind flesh, albedo target 0.012) on the whole body. That
              is the darkest recipe in the library by a factor of five and it is
              a BURNT-HELLHOUND skin; on a 322 px armoured giant it meant only
              39 % of the torso's measured value came from the albedo map at all
              (ablation: torso display luma 0.325 -> 0.199 with map diffuse off),
              the rest being rim, aura, floor and specular, none of which carry
              any structure. -> wardenHide, a leather solved against the hero
              cuirass reference rather than against a hellhound.
       basalt stone (5-cycle ashlar coursing) on a SKULL. -> wardenBone.
       metal  correct family but at a 0.38 m repeat authored for a 1.8 m enemy.
              -> wardenIron, same family, boss-scale repeat.
       plate  NEW. Armour is the one thing this creature is supposed to be made
              of and it had none: the lamed, riveted `plate` kind on a cuirass,
              a fauld, cuisses, greaves and a faceplate. One extra slot is one
              extra draw call, on a single actor, against a 900 budget. */
  const slots = [
    { name: 'char', recipe: 'wardenHide' },
    { name: 'basalt', recipe: 'wardenBone' },
    { name: 'metal', recipe: 'wardenIron' },
    { name: 'plate', recipe: 'wardenPlate' },
    { name: 'core', recipe: 'ember' },
    { name: 'cloth', recipe: 'cloth' },
  ];
  const A = new Assembly(rig, seed, slots);
  const gr = grimeFn({ lo: 0.1, hi: 5.6, dark: 0.64, mottle: 0.22, seed: 641, freq: 1.7, cav: 0.28, tintLow: [0.66, 0.58, 0.56] });
  const grS = grimeFn({ lo: 0.2, hi: 6.0, dark: 0.72, mottle: 0.20, seed: 683, freq: 2.2 });
  // Plate sits in the light and is the one material meant to READ, so its grime
  // ramp is shallower than the body's — a warden's armour is filthy in the laps,
  // not uniformly dimmed.
  const grP = grimeFn({ lo: 0.4, hi: 6.2, dark: 0.80, mottle: 0.16, seed: 727, freq: 1.9, cav: 0.34 });

  /* --- torso --- */
  spine(A, 'char', [
    { j: 'hips', r: 0.560, sx: 1.08, sz: 0.86 },
    { j: 'spine', r: 0.640, sx: 1.14, sz: 0.92 },
    { j: 'chest', r: 0.690, sx: 1.34, sz: 0.88 },
    { j: 'neck', r: 0.360, sx: 1.22, sz: 1.00 },
  ], { seg: 20, ringsPer: 4, noise: 0.22, noiseFreq: 2.4, color: gr });
  ball(A, 'char', 'chest', 0.470, { seg: 16, seg2: 12, scale: [1.24, 0.84, 1.00], off: [-0.360, 0.290, -0.050], color: gr });
  ball(A, 'char', 'chest', 0.400, { seg: 15, seg2: 11, scale: [1.16, 0.84, 1.00], off: [0.380, 0.230, -0.030], color: gr });
  hard(A, 'basalt', pelvisGeo(0.98, 0.62, 0.56), 'hips', { off: [0, -0.150, 0.020], color: grS });

  /* --- ARMOUR: cuirass band + fauld lames ---
     The review's exact words were "no mid-frequency forms". Texture alone
     cannot supply those: a mid-frequency FORM has to be in the silhouette and
     in the self-shadowing, which means geometry. Five hoops and two rivet rows
     cost ~2.4 k triangles on a 4.4 M frame and zero extra draw calls beyond the
     one new material slot, and they give the curvature wear pass real proud
     arrises and real laps to work with. */
  A.part('plate', (sb, uv) => {
    // cuirass: one deep band across the lower chest, under the torn ribcage
    const cu = lameGeo(0.760, 0.610, 0.500, 0.055, { tub: 22, seg: 7, spread: 0.030 });
    sb.rigid(cu, 'spine', { at: 'spine', off: [0, 0.030, 0.020], uvScale: uv, color: grP });
    cu.dispose();
    rivetRing(sb, 'spine', { rx: 0.775, rz: 0.630, y: 0.235, n: 7, r: 0.048, uv, color: grP });
    // fauld: four lames stepping down and flaring off the hips
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const g = lameGeo(0.700 + t * 0.115, 0.560 + t * 0.100, 0.230, 0.048,
        { tub: 20, seg: 6, spread: 0.040 + t * 0.028 });
      sb.rigid(g, i < 2 ? 'spine' : 'hips', {
        at: i < 2 ? 'spine' : 'hips',
        off: [0, (i < 2 ? -0.245 - i * 0.175 : 0.135 - (i - 2) * 0.180), 0.010],
        uvScale: uv, color: grP,
      });
      g.dispose();
    }
    rivetRing(sb, 'hips', { rx: 0.845, rz: 0.700, y: 0.215, n: 9, r: 0.042, uv, color: grP });
  });

  /* --- ribcage torn open over a molten core: the primary weak point --- */
  ribCage(A, 'basalt', { y0: 4.00, y1: 4.72, halfW: 0.72, depth: 0.60, count: 6, r: 0.062, bind: 'chest', drop: 0.24, color: grS, backZ: -0.02 });
  A.part('core', (sb, uv) => {
    const g = new THREE.SphereGeometry(0.360, 16, 12);
    g.scale(1.10, 1.00, 0.80);
    sb.rigid(g, 'chest', { at: 'chest', off: [0, 0.030, 0.290], uvScale: uv, mask: 1 });
    g.dispose();
    // three lesser weak points: both shoulders and the base of the spine
    for (const [bone, off] of [['chest', [-0.360, 0.360, 0.180]], ['chest', [0.380, 0.300, 0.190]], ['spine', [0, -0.180, -0.470]]]) {
      const s = new THREE.SphereGeometry(0.150, 12, 9);
      s.scale(1.0, 0.8, 0.9);
      sb.rigid(s, bone, { at: bone, off, uvScale: uv, mask: 1 });
      s.dispose();
    }
    // fissures crawling up the torso
    for (let i = 0; i < 10; i++) {
      const t = i / 9;
      const s = new THREE.SphereGeometry(0.075 - t * 0.02, 8, 6);
      s.scale(0.45, 1.9, 0.45);
      sb.rigid(s, t < 0.5 ? 'hips' : 'spine', {
        pos: [(t % 0.34 - 0.17) * 2.1, 3.24 + t * 1.15, 0.44 - t * 0.05],
        rot: [0, 0, (t - 0.5) * 0.7], uvScale: uv, mask: 1,
      });
      s.dispose();
    }
  });

  /* --- head: horned, jawless-looking, sunk between the shoulders ---
     THE HEAD WAS TWO OVERLAPPING SPHERES AND THE SKULL LOST.
     `ball('char','head',0.400)` is an ellipsoid of radii (0.376, 0.400, 0.432)
     centred at head+(0,0.06,-0.02); the skull's cranium, after its own scale and
     offset, is (0.314, 0.350, 0.434) centred at head+(0,0.180,0.007). The ball
     therefore swallowed the brow, the muzzle, the cheekbones and the jaw, and
     left a bare charred sphere with a 30-70 mm crescent of skull showing — about
     4 px of it at the boss camera. That is the "featureless white ovoid".
     Worse, `eyeLights` sat at head+(0.170,0.230,0.190) with r 0.105, and the
     ball's surface on that ray is at z = 0.319: the warden's eyes were INSIDE
     its own head. Measured on the skull-only mask: mean display luma 0.791
     (near clipping) at a post-downsample deviation of 0.018 — a white blob.

     So the ball is demoted to the occiput-and-neck mass it should always have
     been, the carved skull (see RigKit.skullGeo) becomes the face, and the eye
     lights move out to the floor of the carved orbits. */
  ball(A, 'char', 'head', 0.300, { seg: 14, seg2: 10, scale: [0.88, 0.86, 0.92], off: [0, -0.020, -0.160], color: gr });
  hard(A, 'basalt', skullGeo(0.760, {}), 'head', { off: [0, -0.030, 0.030], scale: [0.96, 0.92, 1.02], color: grS });
  hard(A, 'basalt', jawGeo(0.640), 'jaw', { rot: [0.22, 0, 0], color: grS });
  /* Solved against the carved orbit rather than guessed, which is what the old
     placement was: skullGeo's orbit axis (0.50,-0.02,0.87) meets the cranium
     ellipsoid at (0.258, 0.290, 0.418) x size and the dish floor is 0.125 x size
     further in along the surface normal (0.698,-0.021,0.716); through this
     part's own 0.76 size, its (0.96,0.92,1.02) scale and its (0,-0.030,0.030)
     offset the floor lands at (0.124, 0.174, 0.285) in head-local metres. The
     light sits 30 mm proud of that, at a radius that brings its front flush with
     the orbit rim — it fills the socket and does not bulge out of it. */
  eyeLights(A, 'core', 'head', { r: 0.062, dx: 0.145, dy: 0.174, dz: 0.306 });
  /* Faceplate: a riveted brow band and a nasal bar. "No plate seams" was called
     out by name, and a helm band is the cheapest thing that answers it — it also
     gives the head a hard horizontal accent against all those curved masses. */
  A.part('plate', (sb, uv) => {
    /* Helm band round the brow line. Radii follow the cranium ellipsoid at that
       latitude (0.306 x 0.424 head-local) so it grips the skull instead of
       floating; it crosses the TOP of the orbits only, leaving the socket and
       the eye light below it clear. */
    /* Sized 20 % clear of the cranium ellipsoid at this latitude (0.298 x 0.412
       head-local at y = 0.30). A first pass hugged it at 0.322 x 0.430 and
       measured 13 painted pixels — a band you cannot see is only triangles. */
    const band = lameGeo(0.368, 0.478, 0.150, 0.046, { tub: 18, seg: 6, spread: 0.018 });
    sb.rigid(band, 'head', { at: 'head', off: [0, 0.300, 0.015], rot: [0.07, 0, 0], uvScale: uv, color: grP });
    band.dispose();
    // Nasal bar. The muzzle's own front surface is at z 0.605 head-local at this
    // height, so the bar has to reach 0.65 to stand proud of it at all.
    const bar = roundedBox(0.090, 0.300, 0.110, 0.030);
    sb.rigid(bar, 'head', { at: 'head', off: [0, 0.140, 0.600], rot: [0.24, 0, 0], uvScale: uv, color: grP });
    bar.dispose();
    for (const sg of [1, -1]) {
      const r = new THREE.SphereGeometry(0.046, 6, 4);
      r.scale(1, 0.62, 1);
      sb.rigid(r, 'head', { at: 'head', off: [sg * 0.300, 0.312, 0.300], uvScale: uv, color: grP });
      r.dispose();
    }
  });
  A.part('basalt', (sb, uv) => {
    for (const sg of [1, -1]) {
      const g = hornGeo(0.98, 0.115, 0.016, -0.72, { steps: 9, seg: 8, lateral: 0.30 * sg, taper: 0.75 });
      sb.rigid(g, 'head', { at: 'head', off: [sg * 0.230, 0.130, -0.050], rot: [-0.34, 0, sg * -0.42], uvScale: uv, color: grS });
      g.dispose();
      const g2 = hornGeo(0.44, 0.070, 0.012, 0.55, { steps: 6, seg: 6, lateral: 0.2 * sg });
      sb.rigid(g2, 'head', { at: 'head', off: [sg * 0.300, -0.060, 0.040], rot: [-1.05, 0, sg * -0.30], uvScale: uv, color: grS });
      g2.dispose();
    }
  });

  /* --- arms --- */
  for (const side of ['.L', '.R']) {
    const big = side === '.R';
    const s = big ? 1.12 : 0.96;
    ball(A, 'char', `shoulder${side}`, 0.360 * s, { seg: 15, seg2: 12, color: gr, scale: [1, 0.94, 1] });
    seg(A, 'char', `shoulder${side}`, `elbow${side}`, 0.300 * s, 0.235 * s, { color: gr, noise: 0.20, seg: 13 });
    ball(A, 'char', `elbow${side}`, 0.225 * s, { color: gr });
    seg(A, 'char', `elbow${side}`, `wrist${side}`, 0.230 * s, 0.170 * s, { color: gr, noise: 0.18, seg: 12 });
    hard(A, 'char', roundedBox(0.360 * s, 0.380 * s, 0.215 * s, 0.060), `hand${side}`, { off: [0, -0.090, 0.040], color: gr });
    claws(A, 'basalt', `hand${side}`, { n: 4, len: 0.235, r0: 0.042, r1: 0.010, spread: 0.098, off: [0, -0.230, 0.060], pitch: 2.9, color: grS });
    /* Layered pauldron: three overlapping bevelled plates. Moved from `metal`
       to `plate` — these are the largest flat surfaces on the model and the
       review called them "flat purple-white with a hard unshaded edge", which
       is what a 0.38 m hammer-facet repeat looks like when it is stretched over
       a 0.6 m shell and then minified. The lame kind carries a 113 mm band
       instead, and the rivet row gives the hard edge something to end on. */
    A.part('plate', (sb, uv) => {
      const sg = side === '.L' ? 1 : -1;
      for (let i = 0; i < 3; i++) {
        const g = pauldronGeo(0.60 - i * 0.10, 0.30 - i * 0.05);
        sb.rigid(g, `shoulder${side}`, {
          at: `shoulder${side}`,
          off: [sg * (0.02 + i * 0.05), 0.16 - i * 0.19, 0.02 - i * 0.03],
          rot: [0.14 + i * 0.10, 0, sg * (0.24 + i * 0.06)], uvScale: uv, color: grP,
        });
        g.dispose();
      }
      rivetRing(sb, `shoulder${side}`, {
        rx: 0.300, rz: 0.315, y: 0.205, n: 5, r: 0.040, a0: -1.05, a1: 1.05, uv, color: grP,
      });
      // rerebrace: a band round the upper arm so the pauldron ends on something
      const rb = lameGeo(0.320, 0.305, 0.230, 0.042, { tub: 14, seg: 6, spread: 0.024 });
      sb.rigid(rb, `shoulder${side}`, { at: `shoulder${side}`, off: [sg * 0.020, -0.400, 0.010], uvScale: uv, color: grP });
      rb.dispose();
    });
  }

  /* --- legs --- */
  for (const side of ['.L', '.R']) {
    ball(A, 'char', `hip${side}`, 0.390, { seg: 15, seg2: 12, color: gr, scale: [1, 0.88, 1] });
    seg(A, 'char', `hip${side}`, `knee${side}`, 0.360, 0.270, { color: gr, noise: 0.18, seg: 13 });
    ball(A, 'char', `knee${side}`, 0.275, { color: gr, scale: [1.1, 0.92, 1] });
    seg(A, 'char', `knee${side}`, `ankle${side}`, 0.265, 0.175, { color: gr, noise: 0.16, seg: 12 });
    hard(A, 'char', footGeo(0.440, 0.280, 0.600), `ankle${side}`, { off: [0, -0.105, 0.140], color: gr });
    hard(A, 'char', roundedBox(0.400, 0.180, 0.340, 0.065), `toe${side}`, { off: [0, 0.035, -0.040], color: gr });
    claws(A, 'basalt', `toe${side}`, { n: 3, len: 0.160, r0: 0.038, r1: 0.009, spread: 0.115, off: [0, -0.020, 0.150], pitch: 1.62, color: grS });
    hard(A, 'metal', new THREE.TorusGeometry(0.250, 0.050, 8, 14), `ankle${side}`, { at: `ankle${side}`, off: [0, 0.060, 0], rot: [Math.PI * 0.5, 0, 0] });
    // cuisse over the thigh and a greave over the shin: two more lames, so the
    // legs are not one smooth taper from hip to ankle.
    A.part('plate', (sb, uv) => {
      const cu = lameGeo(0.395, 0.365, 0.300, 0.046, { tub: 16, seg: 6, spread: 0.028 });
      sb.rigid(cu, `hip${side}`, { at: `hip${side}`, off: [0, -0.290, 0.020], uvScale: uv, color: grP });
      cu.dispose();
      const gv = lameGeo(0.290, 0.275, 0.290, 0.042, { tub: 14, seg: 6, spread: 0.022 });
      sb.rigid(gv, `knee${side}`, { at: `knee${side}`, off: [0, -0.330, 0.015], uvScale: uv, color: grP });
      gv.dispose();
      const kn = new THREE.SphereGeometry(0.215, 10, 7);
      kn.scale(1.02, 0.80, 0.86);
      sb.rigid(kn, `knee${side}`, { at: `knee${side}`, off: [0, 0.020, 0.085], uvScale: uv, color: grP });
      kn.dispose();
    });
  }

  /* --- the cleaver: 2.6 m of pitted iron --- */
  hard(A, 'metal', bladeGeo(2.30, 0.240), 'hand.R', { off: [0.020, -0.300, 0.120], rot: [2.36, 0.18, 0.12] });
  hard(A, 'metal', roundedBox(0.110, 0.560, 0.110, 0.030), 'hand.R', { off: [0.020, -0.220, 0.100], rot: [2.36, 0.18, 0.12] });
  // dragging chain from the left wrist
  A.part('metal', (sb, uv) => {
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const g = new THREE.TorusGeometry(0.075, 0.024, 6, 10);
      g.rotateX(i % 2 ? 0 : Math.PI * 0.5);
      sb.rigid(g, 'wrist.L', { at: 'wrist.L', off: [0.02 + t * 0.06, -0.16 - t * 1.05, 0.03 + t * 0.16], uvScale: uv });
      g.dispose();
    }
  });
  // shredded standard hanging off the pauldron
  tatters(A, 'cloth', {
    anchors: [[-0.62, 4.62, -0.10], [-0.50, 4.50, 0.14], [-0.70, 4.44, 0.02]],
    n: 5, len: 1.55, w: 0.28, bind: 'chest', sway: 0.30,
  });
  tatters(A, 'cloth', {
    anchors: [[-0.40, 3.10, 0.32], [0.10, 3.06, 0.40], [0.46, 3.10, 0.26], [0, 3.04, -0.44]],
    n: 6, len: 1.35, w: 0.30, bind: 'hips', sway: 0.26,
  });

  return { rig, geometry: A.build({ boundsPad: 1.7 }), slots };
}

/* ================================================================== *
 * authored hard parts
 * ================================================================== */

function pelvisGeo(w, h, d) {
  const parts = [roundedBox(w * 0.56, h * 0.62, d * 0.78, Math.min(w, h) * 0.10)];
  for (const sg of [1, -1]) {
    const wing = roundedBox(w * 0.30, h * 0.72, d * 0.34, Math.min(w, h) * 0.09);
    wing.rotateZ(sg * 0.30);
    wing.rotateY(sg * 0.24);
    wing.translate(sg * w * 0.34, h * 0.16, d * 0.06);
    parts.push(wing);
    const sit = roundedBox(w * 0.20, h * 0.34, d * 0.26, Math.min(w, h) * 0.07);
    sit.translate(sg * w * 0.22, -h * 0.34, -d * 0.02);
    parts.push(sit);
  }
  return mergeGeos(parts);
}

function jawGeo(size) {
  const parts = [];
  const body = roundedBox(size * 0.52, size * 0.14, size * 0.50, size * 0.05);
  body.translate(0, -size * 0.04, size * 0.24);
  parts.push(body);
  for (const sg of [1, -1]) {
    const ram = roundedBox(size * 0.12, size * 0.24, size * 0.14, size * 0.045);
    ram.rotateX(-0.25);
    ram.translate(sg * size * 0.24, size * 0.06, size * 0.02);
    parts.push(ram);
  }
  for (let i = 0; i < 5; i++) {
    for (const sg of [1, -1]) {
      const t = new THREE.ConeGeometry(size * 0.030, size * 0.085, 6);
      t.translate(sg * size * (0.055 + i * 0.048), size * 0.055, size * (0.46 - i * 0.075));
      parts.push(t);
    }
  }
  return mergeGeos(parts);
}

function footGeo(w, h, d) {
  const parts = [roundedBox(w, h, d, Math.min(w, h) * 0.30)];
  const heel = roundedBox(w * 0.80, h * 1.05, d * 0.34, Math.min(w, h) * 0.28);
  heel.translate(0, -h * 0.03, -d * 0.40);
  parts.push(heel);
  return mergeGeos(parts);
}

/** Pitted blade: profile extrusion + a bevelled crossguard. */
function bladeGeo(len, w) {
  const parts = [];
  const half = w * 0.5;
  parts.push(extrudeProfile([
    [-half * 0.72, 0], [half * 0.72, 0],
    [half, len * 0.14], [half * 0.86, len * 0.62], [half * 0.52, len * 0.88],
    [0, len], [-half * 0.52, len * 0.88], [-half * 0.86, len * 0.62], [-half, len * 0.14],
  ], w * 0.34, { bevel: w * 0.10, bevelSegments: 2 }));
  const guard = roundedBox(w * 2.1, w * 0.36, w * 0.44, w * 0.11);
  guard.translate(0, -w * 0.06, 0);
  parts.push(guard);
  // nicks out of the edge — a blade that has been used
  for (let i = 0; i < 4; i++) {
    const t = 0.22 + i * 0.17;
    const n = roundedBox(w * 0.16, w * 0.14, w * 0.5, w * 0.05);
    n.translate((i % 2 ? 1 : -1) * half * 0.95, len * t, 0);
    parts.push(n);
  }
  return mergeGeos(parts);
}

/** Brute maul: rail-tie head lashed to a beam. */
function maulGeo() {
  const parts = [];
  const shaft = roundedBox(0.115, 1.62, 0.115, 0.030);
  shaft.translate(0, 0.62, 0);
  parts.push(shaft);
  const head = roundedBox(0.56, 0.74, 0.44, 0.062);
  head.translate(0.055, 1.52, 0);
  parts.push(head);
  const cheek = roundedBox(0.36, 0.40, 0.52, 0.055);
  cheek.rotateY(0.22);
  cheek.translate(-0.16, 1.40, 0.02);
  parts.push(cheek);
  for (let i = 0; i < 5; i++) {
    const sp = hornGeo(0.18, 0.045, 0.010, 0.15, { steps: 4, seg: 6 });
    const a = (i / 5) * TAU;
    sp.rotateZ(Math.PI * 0.5 - a * 0.2);
    sp.rotateX(a);
    sp.translate(0.055 + Math.cos(a) * 0.20, 1.52 + Math.sin(a) * 0.24, 0);
    parts.push(sp);
  }
  for (let i = 0; i < 4; i++) {
    const band = new THREE.TorusGeometry(0.085, 0.020, 6, 10);
    band.rotateX(Math.PI * 0.5);
    band.translate(0, 0.28 + i * 0.30, 0);
    parts.push(band);
  }
  return mergeGeos(parts);
}

function pauldronGeo(w, h) {
  const parts = [];
  const shell = new THREE.SphereGeometry(w * 0.5, 14, 9, 0, TAU, 0, Math.PI * 0.56);
  shell.scale(1.0, h / (w * 0.5) * 0.9, 1.12);
  parts.push(shell);
  const lip = new THREE.TorusGeometry(w * 0.48, w * 0.055, 6, 16, Math.PI * 1.35);
  lip.rotateX(Math.PI * 0.5);
  lip.rotateZ(-Math.PI * 0.2);
  lip.translate(0, -h * 0.12, 0);
  parts.push(lip);
  const ridge = roundedBox(w * 0.14, h * 0.9, w * 0.9, w * 0.05);
  ridge.rotateX(0.1);
  ridge.translate(0, h * 0.18, 0);
  parts.push(ridge);
  return mergeGeos(parts);
}

function censerGeo(r) {
  const parts = [];
  const bowl = new THREE.SphereGeometry(r, 14, 9, 0, TAU, Math.PI * 0.42, Math.PI * 0.58);
  parts.push(bowl);
  const rim = new THREE.TorusGeometry(r * 0.93, r * 0.10, 6, 14);
  rim.rotateX(Math.PI * 0.5);
  rim.translate(0, r * 0.06, 0);
  parts.push(rim);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU;
    const strut = roundedBox(r * 0.10, r * 0.62, r * 0.10, r * 0.03);
    strut.translate(Math.cos(a) * r * 0.80, r * 0.34, Math.sin(a) * r * 0.80);
    parts.push(strut);
  }
  return mergeGeos(parts);
}

function sigilGeo(r) {
  const parts = [];
  const disc = new THREE.CylinderGeometry(r, r * 0.96, r * 0.16, 16);
  disc.rotateX(Math.PI * 0.5);
  parts.push(disc);
  const ring = new THREE.TorusGeometry(r * 0.86, r * 0.10, 6, 18);
  parts.push(ring);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    const bar = roundedBox(r * 1.5, r * 0.12, r * 0.12, r * 0.04);
    bar.rotateZ(a);
    parts.push(bar);
  }
  return mergeGeos(parts);
}

/* ================================================================== *
 * clip tables
 * ================================================================== */

const BIPED_RATTLE = ['chest', 'neck', 'head', 'shoulder.L', 'shoulder.R', 'elbow.L', 'elbow.R', 'wrist.L', 'wrist.R', 'hip.L', 'hip.R', 'knee.L', 'knee.R'];

function skeletonClips() {
  const walk = bipedWalk({ stride: 0.50, knee: 1.02, bob: 0.042, sway: 0.026, lean: 0.16, arm: 0.50, elbow: 0.34, twist: 0.15 });
  const run = bipedWalk({ stride: 0.72, knee: 1.30, bob: 0.062, sway: 0.030, lean: 0.34, arm: 0.78, elbow: 0.58, twist: 0.22 });
  const idle = bipedIdle({ breath: 0.018, lean: 0.09, sway: 0.012, elbow: 0.34, shoulderDrop: 0.14 });
  const swing = bipedSwing({ hand: 'R', reach: 1.0, hitAt: 0.5 });
  const R = (fn, amp = 0.0065, freq = 15, rot = 0.022) => shake(fn, BIPED_RATTLE, amp, freq, rot);
  return {
    idle: clip(R(idle, 0.0075, 12, 0.026), 3.1),
    walk: clip(R(walk), 0.86),
    run: clip(R(run, 0.0055, 18, 0.018), 0.60),
    strafe: clip(R(bipedWalk({ stride: 0.30, knee: 0.72, bob: 0.030, sway: 0.052, lean: 0.08, arm: 0.26, twist: 0.06 })), 0.92),
    walk_back: clip(R(reverse(walk)), 1.05),
    alert: clip(R(lookClip(idle, { amp: 1.1 }), 0.010, 19, 0.030), 1.9),
    look: clip(R(lookClip(idle, { amp: 1.4 }), 0.009, 16, 0.026), 2.6),
    ...meleeSet(R(swing, 0.005, 20, 0.014), 0.5, { w: 0.52, s: 0.20, r: 0.62 }),
    cast: clip(R(sub(swing, 0, 0.42), 0.006, 18, 0.02), 0.62, false, 'cast'),
    summon: clip(R(casterSummon({ amp: 0.8 }), 0.008, 20, 0.024), 1.9, false, 'summon'),
    hit: clip(R(bipedHit({ amp: 1.25 }), 0.012, 26, 0.04), 0.42, false, 'idle'),
    roar: clip(R(roarClip({ amp: 0.85 }), 0.010, 22, 0.030), 1.3, false, 'idle'),
    death: clip(bipedDeath({}), 1.5, false, 'death'),
  };
}

function ghoulClips() {
  const walk = bipedWalk({ stride: 0.40, knee: 0.92, bob: 0.058, sway: 0.048, lean: 0.34, arm: 0.34, elbow: 0.62, twist: 0.09, asym: 0.72, heavy: 0.38 });
  const run = bipedWalk({ stride: 0.62, knee: 1.16, bob: 0.082, sway: 0.056, lean: 0.52, arm: 0.52, elbow: 0.70, twist: 0.13, asym: 0.60, heavy: 0.22 });
  const idle = bipedIdle({ breath: 0.056, lean: 0.20, sway: 0.020, elbow: 0.62, shoulderDrop: 0.22 });
  const swing = bipedSwing({ hand: 'L', reach: 1.06, hitAt: 0.46 });
  return {
    idle: clip(idle, 2.3),
    walk: clip(walk, 1.02),
    run: clip(run, 0.68),
    strafe: clip(bipedWalk({ stride: 0.26, knee: 0.70, bob: 0.044, sway: 0.070, lean: 0.28, arm: 0.20, elbow: 0.60, asym: 0.5 }), 1.05),
    walk_back: clip(reverse(walk), 1.25),
    alert: clip(lookClip(idle, { amp: 1.25 }), 1.7),
    look: clip(lookClip(idle, { amp: 1.5 }), 2.4),
    ...meleeSet(swing, 0.46, { w: 0.46, s: 0.18, r: 0.56 }),
    cast: clip(sub(swing, 0, 0.40), 0.55, false, 'cast'),
    summon: clip(casterSummon({ amp: 0.7 }), 1.8, false, 'summon'),
    hit: clip(bipedHit({ amp: 1.1 }), 0.40, false, 'idle'),
    roar: clip(roarClip({ amp: 1.0 }), 1.25, false, 'idle'),
    death: clip(bipedDeath({}), 1.6, false, 'death'),
  };
}

function cultistClips() {
  // legs:false — the robe hides them, so the body glides and only the hem moves
  const glide = layer(bipedWalk({ stride: 0.20, knee: 0.30, bob: 0.016, sway: 0.030, lean: 0.16, arm: 0.16, elbow: 0.72, twist: 0.07, legs: false }),
    (P, ph) => { P.add('hips', 0, 0.06 * Math.sin(ph * TAU), 0.03 * Math.cos(ph * TAU)); });
  const idle = bipedIdle({ breath: 0.030, lean: 0.12, sway: 0.014, elbow: 0.80, shoulderDrop: 0.20 });
  const cast = casterCast({ reach: 1.0, sleeve: 0.4 });
  return {
    idle: clip(idle, 3.6),
    walk: clip(glide, 1.15),
    run: clip(layer(bipedWalk({ stride: 0.30, knee: 0.42, bob: 0.026, sway: 0.036, lean: 0.30, arm: 0.24, elbow: 0.66, legs: false }),
      (P, ph) => { P.add('hips', 0, 0.09 * Math.sin(ph * TAU), 0.05 * Math.cos(ph * TAU)); }), 0.78),
    strafe: clip(layer(bipedWalk({ stride: 0.14, knee: 0.24, bob: 0.014, sway: 0.058, lean: 0.10, arm: 0.12, elbow: 0.78, legs: false })), 1.2),
    walk_back: clip(reverse(glide), 1.35),
    alert: clip(lookClip(idle, { amp: 1.0 }), 2.1),
    look: clip(lookClip(idle, { amp: 1.3 }), 2.8),
    cast: clip(cast, 1.25, false, 'cast'),
    attack_windup: clip(sub(cast, 0, 0.62), 1.22, false, 'attack_windup'),
    attack: clip(sub(cast, 0.62, 0.84), 0.22, false, 'attack'),
    attack_recover: clip(sub(cast, 0.84, 1), 0.85, false, 'attack_recover'),
    summon: clip(casterSummon({ amp: 1.0 }), 1.95, false, 'summon'),
    hit: clip(bipedHit({ amp: 1.0 }), 0.40, false, 'idle'),
    roar: clip(roarClip({ amp: 0.7 }), 1.3, false, 'idle'),
    death: clip(bipedDeath({}), 1.7, false, 'death'),
  };
}

function houndClips() {
  const run = quadRun({ stride: 0.92, knee: 1.10, bob: 0.085 });
  const trot = quadRun({ stride: 0.58, knee: 0.82, bob: 0.048 });
  const idle = quadIdle({ breath: 0.045 });
  const leap = quadLeap({ height: 1.0 });
  return {
    idle: clip(idle, 2.4),
    walk: clip(trot, 0.62),
    run: clip(run, 0.42),
    strafe: clip(trot, 0.70),
    walk_back: clip(reverse(trot), 0.80),
    alert: clip(layer(idle, (P, ph) => {
      P.add('neck1', -0.34, 0.16 * Math.sin(ph * TAU * 0.6), 0);
      P.add('head', 0.18, 0.22 * Math.sin(ph * TAU * 0.6), 0);
      for (let i = 1; i <= 3; i++) P.add(`tail${i}`, -0.30, 0, 0);
    }), 1.6),
    look: clip(layer(idle, (P, ph) => {
      P.add('neck1', -0.22, 0.34 * Math.sin(ph * TAU * 0.5), 0);
      P.add('head', 0.14, 0.30 * Math.sin(ph * TAU * 0.5), 0.08 * Math.cos(ph * TAU));
    }), 2.5),
    attack_windup: clip(sub(leap, 0, 0.26), 0.34, false, 'attack_windup'),
    attack: clip(sub(leap, 0.26, 0.72), 0.16, false, 'attack'),
    attack_recover: clip(sub(leap, 0.72, 1), 0.44, false, 'attack_recover'),
    cast: clip(sub(leap, 0, 0.22), 0.34, false, 'cast'),
    summon: clip(layer(idle, (P) => { P.add('neck1', -0.55, 0, 0); P.add('head', -0.30, 0, 0); P.add('jaw', 0.70, 0, 0); }), 1.5, false, 'summon'),
    hit: clip(quadHit({ amp: 1.2 }), 0.36, false, 'idle'),
    roar: clip(layer(idle, (P, ph) => {
      const k = Math.min(1, ph * 4) * Math.max(0, 1 - (ph - 0.6) * 2.5);
      P.add('neck1', -0.62 * k, 0, 0); P.add('neck2', -0.30 * k, 0, 0);
      P.add('head', -0.34 * k, 0, 0); P.add('jaw', 0.85 * k, 0, 0);
      for (let i = 1; i <= 3; i++) P.add(`tail${i}`, -0.22 * k, 0, 0);
    }), 1.15, false, 'idle'),
    death: clip(quadDeath(), 1.4, false, 'death'),
  };
}

function bruteClips() {
  const walk = bipedWalk({ stride: 0.34, knee: 0.70, bob: 0.085, sway: 0.062, lean: 0.26, arm: 0.22, elbow: 0.52, twist: 0.09, heavy: 1.0 });
  const run = bipedWalk({ stride: 0.48, knee: 0.92, bob: 0.115, sway: 0.070, lean: 0.42, arm: 0.34, elbow: 0.56, twist: 0.12, heavy: 0.8 });
  const idle = bipedIdle({ breath: 0.075, lean: 0.24, sway: 0.026, elbow: 0.50, shoulderDrop: 0.24 });
  const smash = overheadSlam({ reach: 1.0, hitAt: 0.56 });
  const sweep = bipedSwing({ hand: 'R', reach: 1.15, hitAt: 0.52 });
  return {
    idle: clip(idle, 4.2),
    walk: clip(walk, 1.42),
    run: clip(run, 1.02),
    strafe: clip(bipedWalk({ stride: 0.22, knee: 0.52, bob: 0.062, sway: 0.085, lean: 0.20, arm: 0.16, heavy: 1.0 }), 1.5),
    walk_back: clip(reverse(walk), 1.7),
    alert: clip(lookClip(idle, { amp: 0.8 }), 2.6),
    look: clip(lookClip(idle, { amp: 1.0 }), 3.4),
    ...meleeSet(smash, 0.56, { w: 0.96, s: 0.24, r: 1.05 }),
    'attack_windup__sweep': clip(sub(sweep, 0, 0.52), 0.82, false, 'attack_windup__sweep'),
    'attack__sweep': clip(sub(sweep, 0.52, 0.70), 0.30, false, 'attack__sweep'),
    'attack_recover__sweep': clip(sub(sweep, 0.70, 1), 0.92, false, 'attack_recover__sweep'),
    cast: clip(sub(smash, 0, 0.50), 0.96, false, 'cast'),
    summon: clip(roarClip({ amp: 1.0 }), 1.7, false, 'summon'),
    hit: clip(bipedHit({ amp: 0.55 }), 0.34, false, 'idle'),
    roar: clip(roarClip({ amp: 1.1 }), 1.5, false, 'idle'),
    death: clip(bipedDeath({}), 2.1, false, 'death'),
  };
}

function wraithClips() {
  const hover = floatBody({ amp: 0.085, rate: 0.62, tails: 6, drift: 0.10 });
  const drift = floatBody({ amp: 0.055, rate: 1.05, tails: 6, drift: 0.16 });
  const thrust = floatThrust({ hitAt: 0.5 });
  return {
    idle: clip(hover, 4.4),
    walk: clip(drift, 2.2),
    run: clip(floatBody({ amp: 0.045, rate: 1.5, tails: 6, drift: 0.22 }), 1.4),
    strafe: clip(drift, 2.4),
    walk_back: clip(reverse(drift), 2.6),
    alert: clip(layer(hover, (P, ph) => { P.add('head', -0.10, 0.28 * Math.sin(ph * TAU * 0.5), 0); P.add('neck', -0.06, 0.20 * Math.sin(ph * TAU * 0.5), 0); }), 2.6),
    look: clip(layer(hover, (P, ph) => { P.add('head', -0.06, 0.38 * Math.sin(ph * TAU * 0.4), 0.06); }), 3.4),
    ...meleeSet(layer(hover, thrust), 0.5, { w: 0.60, s: 0.18, r: 0.60 }),
    cast: clip(layer(hover, sub(thrust, 0, 0.44)), 0.72, false, 'cast'),
    summon: clip(layer(hover, casterSummon({ amp: 0.9 })), 1.9, false, 'summon'),
    hit: clip(layer(hover, bipedHit({ amp: 0.85 })), 0.42, false, 'idle'),
    roar: clip(layer(hover, roarClip({ amp: 0.8 })), 1.4, false, 'idle'),
    // no legs to buckle: the wraith sinks and unravels
    death: clip((P, ph, ctx) => {
      const k = ease.in2(clamp01(ph));
      hover(P, ph * 0.4, ctx);
      P.move('root', 0, -0.85 * k, 0);
      P.add('root', 0.34 * k, 0, 0.20 * k);
      P.add('spine', 0.30 * k, 0, -0.16 * k);
      P.add('chest', 0.36 * k, 0, -0.10 * k);
      P.add('neck', 0.26 * k, 0, 0);
      P.add('head', 0.42 * k, 0.20 * k, 0.10 * k);
      P.add('shoulder.L', -0.60 * k, 0, 0.70 * k);
      P.add('shoulder.R', -0.45 * k, 0, -0.62 * k);
      for (let i = 1; i <= 6; i++) P.add(`tail${i}`, 0.16 * k, 0.12 * k * (i % 2 ? 1 : -1), 0);
    }, 1.5, false, 'death'),
  };
}

function bossClips() {
  const walk = bipedWalk({ stride: 0.30, knee: 0.62, bob: 0.115, sway: 0.075, lean: 0.22, arm: 0.20, elbow: 0.46, twist: 0.08, heavy: 1.0 });
  const run = bipedWalk({ stride: 0.44, knee: 0.86, bob: 0.155, sway: 0.085, lean: 0.44, arm: 0.30, elbow: 0.50, twist: 0.11, heavy: 0.9 });
  const idle = bipedIdle({ breath: 0.105, lean: 0.20, sway: 0.030, elbow: 0.44, shoulderDrop: 0.20 });
  const cleave = bipedSwing({ hand: 'R', reach: 1.14, hitAt: 0.54 });
  const slam = overheadSlam({ reach: 1.05, hitAt: 0.58 });
  const quake = (P, ph, ctx) => {
    const rise = ease.out2(clamp01(ph / 0.58));
    const drop = ease.snap(clamp01((ph - 0.58) / 0.14));
    const rec = ease.inOut(clamp01((ph - 0.72) / 0.28));
    const a = rise * (1 - drop);
    P.move('root', 0, 0.16 * a - 0.42 * drop * (1 - rec), 0);
    P.add('root', -0.24 * a + 0.34 * drop, 0, 0);
    P.add('spine', -0.30 * a + 0.42 * drop, 0, 0);
    P.add('chest', -0.42 * a + 0.56 * drop, 0, 0);
    P.add('neck', -0.34 * a - 0.20 * drop, 0, 0);
    P.add('head', -0.46 * a - 0.16 * drop, 0, 0);
    P.add('jaw', 0.50 * a, 0, 0);
    for (const [side, sg] of [['.L', 1], ['.R', -1]]) {
      P.add(`shoulder${side}`, -2.75 * a + 2.35 * drop, -sg * 0.20 * a, sg * (0.30 + 0.55 * a));
      P.add(`elbow${side}`, -(0.55 + 0.35 * a) + 0.65 * drop, 0, 0);
      P.add(`wrist${side}`, -0.35 * a + 0.45 * drop, 0, 0);
      P.add(`hip${side}`, -0.16 * a + 0.34 * drop, sg * 0.06, 0);
      P.add(`knee${side}`, 0.30 * a + 0.72 * drop * (1 - rec), 0, 0);
      P.add(`ankle${side}`, -0.18 * a - 0.32 * drop * (1 - rec), 0, 0);
    }
    if (ctx && ctx.hitDir) { /* keep signature stable for layering */ }
  };
  const charge = layer(run, (P, ph) => {
    P.add('spine', 0.24, 0, 0); P.add('chest', 0.30, 0, 0);
    P.add('neck', -0.34, 0, 0); P.add('head', -0.20, 0, 0);
    P.add('shoulder.R', -0.55, 0, -0.30); P.add('elbow.R', -0.60, 0, 0);
    P.add('shoulder.L', -0.40, 0, 0.34);
  });
  return {
    idle: clip(idle, 5.2),
    walk: clip(walk, 1.62),
    run: clip(run, 1.14),
    strafe: clip(bipedWalk({ stride: 0.20, knee: 0.46, bob: 0.085, sway: 0.105, lean: 0.16, arm: 0.14, heavy: 1.0 }), 1.8),
    walk_back: clip(reverse(walk), 2.0),
    alert: clip(lookClip(idle, { amp: 0.7 }), 3.2),
    look: clip(lookClip(idle, { amp: 0.9 }), 4.0),
    ...meleeSet(cleave, 0.54, { w: 0.88, s: 0.30, r: 0.86 }),
    'attack_windup__slam': clip(sub(slam, 0, 0.58), 1.14, false, 'attack_windup__slam'),
    'attack__slam': clip(sub(slam, 0.58, 0.74), 0.30, false, 'attack__slam'),
    'attack_recover__slam': clip(sub(slam, 0.74, 1), 1.10, false, 'attack_recover__slam'),
    'attack_windup__quake': clip(sub(quake, 0, 0.58), 1.85, false, 'attack_windup__quake'),
    'attack__quake': clip(sub(quake, 0.58, 0.76), 0.42, false, 'attack__quake'),
    'attack_recover__quake': clip(sub(quake, 0.76, 1), 1.35, false, 'attack_recover__quake'),
    'attack_windup__charge': clip(sub(cleave, 0, 0.30), 1.32, false, 'attack_windup__charge'),
    'attack__charge': clip(charge, 0.62),
    'attack_recover__charge': clip(sub(cleave, 0.72, 1), 1.25, false, 'attack_recover__charge'),
    cast: clip(sub(quake, 0, 0.52), 1.42, false, 'cast'),
    summon: clip(casterSummon({ amp: 1.15 }), 1.66, false, 'summon'),
    hit: clip(bipedHit({ amp: 0.30 }), 0.30, false, 'idle'),
    roar: clip(roarClip({ amp: 1.25 }), 1.6, false, 'idle'),
    death: clip(bipedDeath({}), 2.8, false, 'death'),
  };
}

/* ================================================================== *
 * species table
 * ================================================================== */

/**
 * `ai` names the AI archetype (src/game/ai/Archetypes.js) this body plays as;
 * `hint` is the per-entity override the AI merges over the archetype so its
 * ring distances and collision radii match the *body* rather than the table.
 */
export const SPECIES = {
  skeleton: {
    id: 'skeleton', label: 'Risen Bonewalker', ai: 'grunt',
    height: 1.90, radius: 0.42, mass: 62, hover: 0,
    hint: { speed: 3.30, radius: 0.42, height: 1.90, turnRate: 9.5 },
    accent: ACCENT.necrotic, aura: ACCENT.necrotic, dissolveEdge: 0x3f7a4c,
    slotMat: {
      bone: { tint: 0xe9e0c6, emiss: ACCENT.necrotic, emissI: 1.05, rough: 0.90 },
      metal: { tint: 0x8e8073, rough: 0.72 },
      cloth: { tint: 0x6b5c4e },
    },
    feet: ['toe.L', 'toe.R'], shake: 0, footVol: 0.35,
    build: buildSkeleton, clips: skeletonClips,
    ring: 2.2, jitter: { scale: [0.945, 1.055], tint: 0.075 },
    hp: 42, dissolveScale: 12,
  },

  ghoul: {
    id: 'ghoul', label: 'Gorge Ghoul', ai: 'grunt',
    height: 1.72, radius: 0.48, mass: 96, hover: 0,
    hint: { speed: 2.85, radius: 0.48, height: 1.75, turnRate: 6.0 },
    accent: 0xd8e07a, aura: ACCENT.necrotic, dissolveEdge: 0x4c6b32,
    slotMat: {
      rot: { tint: 0xb9bd92, emiss: 0xd8e07a, emissI: 0.80 },
      bone: { tint: 0xdbd1b2 },
      cloth: { tint: 0x60533f },
    },
    feet: ['toe.L', 'toe.R'], shake: 0.035, footVol: 0.55,
    build: buildGhoul, clips: ghoulClips,
    ring: 2.0, jitter: { scale: [0.93, 1.08], tint: 0.09 },
    hp: 58, dissolveScale: 9,
  },

  cultist: {
    id: 'cultist', label: 'Ashen Acolyte', ai: 'cultist',
    height: 1.88, radius: 0.44, mass: 74, hover: 0,
    hint: { speed: 2.80, radius: 0.44, height: 1.88, turnRate: 7.5 },
    accent: ACCENT.necrotic, aura: ACCENT.necrotic, dissolveEdge: 0x39704f,
    slotMat: {
      cloth: { tint: 0x554546 },
      bone: { tint: 0xded3b6, emiss: ACCENT.necrotic, emissI: 0.95 },
      brass: { tint: 0xb2904d, emiss: ACCENT.hellcore, emissI: 0.85, rough: 0.55 },
    },
    feet: null, shake: 0, footVol: 0,
    build: buildCultist, clips: cultistClips,
    ring: 10.5, jitter: { scale: [0.955, 1.05], tint: 0.05 },
    hp: 50, dissolveScale: 8,
  },

  hellhound: {
    id: 'hellhound', label: 'Cinder Hound', ai: 'scavenger',
    height: 1.05, radius: 0.44, mass: 78, hover: 0,
    hint: { speed: 4.45, radius: 0.44, height: 1.05, turnRate: 12.0 },
    accent: ACCENT.hellfire, aura: ACCENT.hellfire, rim: 0xc79a72, dissolveEdge: 0x6b3f18,
    slotMat: {
      hide: { tint: 0x6d5a52 },
      bone: { tint: 0xd0c4a6 },
      ember: { tint: 0x3a2318, emiss: ACCENT.hellfire, emissI: 1.45 },
    },
    feet: ['fPaw.L', 'fPaw.R', 'bPaw.L', 'bPaw.R'], shake: 0, footVol: 0.30,
    build: buildHound, clips: houndClips,
    ring: 1.7, jitter: { scale: [0.92, 1.09], tint: 0.08 },
    hp: 34, dissolveScale: 11, light: { color: ACCENT.hellfire, intensity: 1.15, dist: 4.4, at: [0, 0.95, 0.75] },
  },

  brute: {
    id: 'brute', label: 'Flesh Brute', ai: 'brute',
    height: 3.20, radius: 0.96, mass: 420, hover: 0,
    hint: { speed: 2.50, radius: 0.96, height: 3.20, turnRate: 3.0 },
    accent: 0xffb27a, aura: ACCENT.hellfire, rim: 0xc79a72, dissolveEdge: 0x693a14,
    slotMat: {
      flesh: { tint: 0xa9877a, emiss: 0xff8a50, emissI: 0.7 },
      metal: { tint: 0x918274, rough: 0.68 },
      bone: { tint: 0xd3c6a9 },
      cloth: { tint: 0x60513f },
    },
    feet: ['toe.L', 'toe.R'], shake: 0.19, footVol: 1.0,
    build: buildBrute, clips: bruteClips,
    ring: 3.2, jitter: { scale: [0.955, 1.06], tint: 0.06 },
    hp: 240, dissolveScale: 5.5,
  },

  wraith: {
    id: 'wraith', label: 'Pale Wraith', ai: 'archer',
    height: 2.05, radius: 0.42, mass: 34, hover: 0.58,
    hint: { speed: 3.05, radius: 0.42, height: 2.05, turnRate: 8.0 },
    accent: ACCENT.soul, aura: ACCENT.soul, dissolveEdge: 0x3d5a70,
    slotMat: {
      shroud: { tint: 0x93a0ae, ghost: 0.58, transparent: true, emiss: ACCENT.soul, emissI: 0.75 },
      bone: { tint: 0xd8e2e8, ghost: 0.26, transparent: true, depthWrite: true, emiss: ACCENT.soul, emissI: 1.25 },
      smoke: { tint: 0x76828f, ghost: 0.86, transparent: true, fade: [0.05, 0.95] },
    },
    feet: null, shake: 0, footVol: 0,
    build: buildWraith, clips: wraithClips,
    ring: 9.0, jitter: { scale: [0.94, 1.07], tint: 0.05 },
    hp: 46, dissolveScale: 7, noShadow: true,
  },

  boss: {
    id: 'boss', label: 'Apollyon', ai: 'boss',
    height: 6.50, radius: 2.35, mass: 2600, hover: 0,
    hint: { speed: 3.00, radius: 2.35, height: 6.50, turnRate: 2.0 },
    accent: ACCENT.hellcore, aura: ACCENT.hellfire, rim: 0xd0a06e, dissolveEdge: 0x6e4014,
    /* Tints are the DENOMINATOR of MonsterMaterials' value-trim gain, so a dark
       tint no longer costs brightness — it costs saturation only. These are
       pulled back toward neutral iron and warm bone: the old 0x74605a on a
       recipe already tinted (0.30,0.26,0.25) was a double multiply, which is
       part of how the body ended up carrying so little of its own map.
       `metal`/`plate` keep `rough` unset so the map's own roughness — which is
       where the lame kind puts most of its macro contrast — survives. */
    slotMat: {
      char: { tint: 0x9a8b80, emiss: 0xff6a22, emissI: 0.45 },
      basalt: { tint: 0xa9a094 },
      /* Metalness well below bare iron's 1.0, and that is a material claim, not
         a cheat: this armour is more oxide than steel, and oxide is a
         dielectric. It also matters mechanically — the standard BRDF scales
         diffuse by (1 - metalness), so at 0.86 the albedo map, the textured
         pedestal and the whole wear layer were 86 % cancelled and the plate was
         lit almost entirely by an untextured environment reflection. That is
         precisely the "flat purple-white" the review saw on the pauldrons. The
         curvature wear pass puts metalness back up to ~0.95 on the abraded
         arrises, so bare steel still appears exactly where it should. */
      metal: { tint: 0x968779, metal: 0.58 },
      plate: { tint: 0x9c9288, metal: 0.38 },
      core: { tint: 0x2a1810, emiss: ACCENT.hellfire, emissI: 2.6 },
      cloth: { tint: 0x54424a },
    },
    feet: ['toe.L', 'toe.R'], shake: 0.42, footVol: 1.6,
    build: buildBoss, clips: bossClips,
    ring: 6.5, jitter: { scale: [1.0, 1.0], tint: 0.02 },
    hp: 3200, dissolveScale: 3.0, isBoss: true,
    light: { color: ACCENT.hellfire, intensity: 8.5, dist: 15, at: [0, 4.3, 0.55] },
    variants: ['cleave', 'slam', 'quake', 'cleave', 'charge', 'slam'],
  },
};

/** Ability id (Archetypes.js) -> boss clip variant. */
export const BOSS_VARIANT = {
  'boss.cleave': 'cleave',
  'boss.slam': 'slam',
  'boss.quake': 'quake',
  'boss.meteor': 'quake',
  'boss.charge': 'charge',
  'boss.summon': null,
  'brute.smash': null,
  'brute.sweep': 'sweep',
};

export const SPECIES_LIST = Object.keys(SPECIES);

/** Loose name -> species id, so `spawn('skeleton_archer')` still lands somewhere. */
export function resolveSpecies(name) {
  if (!name) return 'skeleton';
  const k = String(name).toLowerCase();
  if (SPECIES[k]) return k;
  if (/boss|warden|butcher|overlord|tyrant|colossus/.test(k)) return 'boss';
  if (/brute|ogre|golem|abom|behemoth|juggern|heavy|tank/.test(k)) return 'brute';
  if (/hound|dog|beast|wolf|scav|imp|leaper|quad/.test(k)) return 'hellhound';
  if (/wraith|ghost|spectre|specter|shade|spirit|phantom/.test(k)) return 'wraith';
  if (/cult|acolyte|priest|necro|mage|caster|summon|warlock|shaman|witch/.test(k)) return 'cultist';
  if (/ghoul|zombie|corpse|husk|flesh|rot/.test(k)) return 'ghoul';
  return 'skeleton';
}

/** Canonical animation-name fallbacks (Agent.ANIM -> whatever the species has). */
export const ANIM_FALLBACK = {
  run: 'walk', walk: 'idle', strafe: 'walk', walk_back: 'walk',
  alert: 'idle', look: 'idle', roar: 'alert',
  attack_windup: 'attack', attack: 'attack_windup', attack_recover: 'idle',
  cast: 'attack_windup', summon: 'cast', hit: 'idle', death: 'idle',
};
