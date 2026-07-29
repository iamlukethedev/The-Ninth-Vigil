/**
 * SANCTUM — HeroClips
 * ---------------------------------------------------------------------------
 * The hero's animation set. Two kinds of clip live here:
 *
 *  • **base clips** — full-body, driven by the movement controller:
 *      `locomotion` (a parametric idle→walk→run blend), `dash`, `stagger`, `death`.
 *  • **action clips** — additive deltas layered on the upper body (and, when the
 *      legs are free, the whole body): the three-hit combo, the heavy overhead,
 *      the cast, and four directional hit reactions.
 *
 * Authoring model
 * ---------------
 * Locomotion is *procedural* — a function of phase with amplitudes interpolated
 * by gait, because a walk and a run are the same motion at different scales and
 * a keyframe pair could never stay foot-synced across a speed ramp.
 *
 * Everything else is a **keyframe table** (`trackClip`). That matters: a swing
 * needs anticipation, an accelerating strike, an overshoot and a settle, with
 * every joint on its *own* timing so the hips lead and the blade arrives last.
 * Two-pose interpolation cannot express that; a table of 5–7 eased keys per
 * joint can, and stays readable. Segment easing is per-key, so the wind-up can
 * decelerate (`out2`) into the strike and the strike can be a hard `snap`.
 *
 * Sign conventions (rest rotations are identity, so bone axes = rig axes):
 *   • bone pointing DOWN (thigh, shin, upperArm, lowerArm):
 *       −rotX swings the distal end FORWARD (+Z), +rotX backward
 *       left side: +rotZ abducts outward; right side: −rotZ abducts
 *   • bone pointing UP (spine1..3, neck, head): +rotX leans FORWARD
 *   • +rotY turns toward the character's LEFT
 *   • +rotZ raises the +X (left) side / leans the top toward −X (right)
 *   • foot/toe point forward: +rotX lifts the toes (dorsiflexion)
 *
 * Determinism: pure functions of phase and `ctx.elapsed`. No randomness.
 */

import { ease } from './monsters/AnimKit.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Wrap-aware cyclic pulse: a strike at phase 0 stays continuous. */
function cyc(t, c, w) {
  let d = Math.abs(((t - c) % 1 + 1.5) % 1 - 0.5);
  d = (0.5 - d) / w;
  if (d <= 0) return 0;
  const s = Math.min(1, d);
  return s * s * (3 - 2 * s);
}

/* ------------------------------------------------------------------ *
 * keyframe machinery
 * ------------------------------------------------------------------ */

const EASE = ease;
const _smp = [0, 0, 0];

function prepKeys(list) {
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    const e = typeof k[4] === 'string' ? (EASE[k[4]] ?? EASE.inOut) : (k[4] ?? EASE.inOut);
    out[i] = [k[0] ?? 0, k[1] ?? 0, k[2] ?? 0, k[3] ?? 0, e];
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Sample a prepared key list at phase `ph` into `_smp`. */
function sampleKeys(keys, ph) {
  const n = keys.length;
  if (n === 0) { _smp[0] = _smp[1] = _smp[2] = 0; return _smp; }
  if (ph <= keys[0][0]) { _smp[0] = keys[0][1]; _smp[1] = keys[0][2]; _smp[2] = keys[0][3]; return _smp; }
  const last = keys[n - 1];
  if (ph >= last[0]) { _smp[0] = last[1]; _smp[1] = last[2]; _smp[2] = last[3]; return _smp; }
  let i = 0;
  while (i < n - 1 && keys[i + 1][0] <= ph) i++;
  const a = keys[i], b = keys[i + 1];
  const span = b[0] - a[0];
  // The *incoming* key owns the segment's easing curve — that is how a wind-up
  // decelerates into the strike and the strike itself snaps.
  const t = b[4](span > 1e-6 ? clamp01((ph - a[0]) / span) : 1);
  _smp[0] = a[1] + (b[1] - a[1]) * t;
  _smp[1] = a[2] + (b[2] - a[2]) * t;
  _smp[2] = a[3] + (b[3] - a[3]) * t;
  return _smp;
}

/**
 * Build a clip from keyframe tables.
 * @param {object} o { dur, loop, next, nextFade, events, root, rootYaw,
 *                     rots:{bone:[[t,x,y,z,ease]]}, moves:{bone:[[t,x,y,z,ease]]},
 *                     mirror:boolean }
 */
export function trackClip(o) {
  const rots = [];
  const moves = [];
  for (const k in (o.rots ?? {})) rots.push([k, prepKeys(o.rots[k])]);
  for (const k in (o.moves ?? {})) moves.push([k, prepKeys(o.moves[k])]);
  const extra = o.fn ?? null;
  return {
    dur: o.dur ?? 1,
    loop: o.loop ?? false,
    next: o.next,
    nextFade: o.nextFade,
    events: o.events,
    root: o.root,
    rootYaw: o.rootYaw,
    tag: o.tag ?? null,
    fn(P, ph, ctx) {
      for (let i = 0; i < rots.length; i++) {
        const s = sampleKeys(rots[i][1], ph);
        P.add(rots[i][0], s[0], s[1], s[2]);
      }
      for (let i = 0; i < moves.length; i++) {
        const s = sampleKeys(moves[i][1], ph);
        P.move(moves[i][0], s[0], s[1], s[2]);
      }
      if (extra) extra(P, ph, ctx);
    },
  };
}

/** Monotonic root-motion ramp: `d` metres travelled between phases a and b. */
const ramp = (a, b, d, e = 'snap') => {
  const fn = EASE[e] ?? EASE.snap;
  const span = Math.max(1e-4, b - a);
  return (ph) => d * fn(clamp01((ph - a) / span));
};

/* ================================================================== *
 * BASE LAYER — locomotion
 * ================================================================== */

/**
 * One clip covers idle, walk and run. `ctx.moveW` cross-fades the idle stance
 * against the stride; `ctx.gait` interpolates every stride amplitude between a
 * walk and a run. Phase rate is set by the graph from ground speed, so contacts
 * stay planted at any velocity — the whole point of a parametric blend.
 *
 * ctx: { moveW, gait, turn, strafe, elapsed, armDamp, guard }
 */
function locomotion(P, ph, ctx) {
  const mw = clamp01(ctx.moveW ?? 0);
  const g = clamp01(ctx.gait ?? 0);
  const iw = 1 - mw;
  const T = ctx.elapsed ?? 0;
  const armD = 1 - 0.86 * clamp01(ctx.armDamp ?? 0);
  const turn = ctx.turn ?? 0;

  /* -------------------------------------------------- stride ------- */
  if (mw > 1e-3) {
    const A = lerp(0.30, 0.68, g) * mw;        // hip swing
    const KB = lerp(0.86, 1.46, g) * mw;       // knee bend peak
    const bob = lerp(0.022, 0.058, g) * mw;
    const swy = lerp(0.030, 0.015, g) * mw;
    const lean = lerp(0.050, 0.315, g) * mw;
    const arm = lerp(0.34, 0.78, g) * mw * armD;
    const elb = lerp(0.24, 0.98, g) * armD;
    const ank = lerp(0.34, 0.52, g) * mw;
    const twi = lerp(0.095, 0.185, g) * mw;

    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? '_L' : '_R';
      const sgn = s === 0 ? 1 : -1;
      const t = (ph + s * 0.5) % 1;
      const cw = Math.cos(t * TAU);

      // hip: forward at contact (t=0), extended at toe-off (t=0.5)
      P.add(`thigh${side}`, -A * cw, sgn * (0.045 + 0.03 * g), sgn * (0.055 - 0.02 * g));
      // knee: big swing-phase flexion + a small strike absorption
      P.add(`shin${side}`,
        KB * (0.90 * cyc(t, 0.72, 0.30) + 0.20 * cyc(t, 0.07, 0.17)) + 0.075 * mw, 0, 0);
      // ankle: plantarflex through toe-off, dorsiflex to clear, heel-strike set
      P.add(`foot${side}`,
        -ank * cyc(t, 0.52, 0.17) + 0.21 * mw * cyc(t, 0.78, 0.22) + 0.11 * mw * cyc(t, 0.0, 0.13),
        0, 0);
      P.add(`toe${side}`, 0.36 * mw * cyc(t, 0.55, 0.14), 0, 0);

      // arms counter-swing; shoulder lags the hip by ~7% of the cycle
      const at = (t + 0.07) % 1;
      P.add(`upperArm${side}`, arm * Math.cos(at * TAU),
        -sgn * 0.06 * g, sgn * (0.105 + 0.075 * g) * armD);
      P.add(`lowerArm${side}`, -(elb + 0.34 * g * Math.max(0, -Math.cos(at * TAU))) * mw, 0, 0);
      P.add(`clavicle${side}`, 0, 0, sgn * 0.035 * arm * -Math.cos(at * TAU));
    }

    /* body — each layer lags the one below it: hips lead, chest follows,
       head arrives last. That lag is what stops a walk reading as a metronome. */
    const lagC = (ph - 0.055 + 1) % 1;
    const lagH = (ph - 0.115 + 1) % 1;
    P.move('pelvis', swy * Math.sin(ph * TAU), -bob * Math.cos(ph * 2 * TAU), 0);
    P.add('pelvis', lean * 0.16, -twi * Math.cos(ph * TAU), 0.055 * mw * Math.sin(ph * TAU));
    P.add('spine1', lean * 0.30 + 0.014 * mw * Math.cos(ph * 2 * TAU),
      twi * 0.45 * Math.cos(lagC * TAU), -0.030 * mw * Math.sin(lagC * TAU));
    P.add('spine2', lean * 0.30, twi * 0.62 * Math.cos(lagC * TAU),
      -0.026 * mw * Math.sin(lagC * TAU));
    P.add('spine3', lean * 0.24, twi * 0.42 * Math.cos(lagC * TAU),
      -0.016 * mw * Math.sin(lagC * TAU));
    P.add('neck', -lean * 0.42, -twi * 0.28 * Math.cos(lagH * TAU), 0);
    P.add('head', -lean * 0.48 + 0.020 * mw * Math.cos(ph * 2 * TAU),
      -twi * 0.34 * Math.cos(lagH * TAU), 0.020 * mw * Math.sin(lagH * TAU));
  }

  /* -------------------------------------------------- idle -------- */
  if (iw > 1e-3) {
    // Breath 0.22 Hz, weight-shift 0.115 Hz, head drift on two slower lanes.
    const br = Math.sin(T * 1.382);
    const br2 = Math.sin(T * 1.382 - 0.9);
    const ws = Math.sin(T * 0.722);
    const wsL = Math.sin(T * 0.722 - 0.62);   // lagged: torso follows the hips
    const drift = Math.sin(T * 0.409 + 1.17);
    const drift2 = Math.sin(T * 0.631 + 0.44);
    const micro = Math.sin(T * 2.31 + 0.8) * 0.004 + Math.sin(T * 3.77) * 0.0025;

    P.move('pelvis', 0.021 * ws * iw, (-0.011 - 0.008 * Math.abs(ws) + 0.004 * br) * iw, 0.004 * br2 * iw);
    P.add('pelvis', (0.014 + micro) * iw, (0.030 * ws + 0.10 * turn) * iw, 0.056 * ws * iw);

    P.add('spine1', (0.030 - 0.017 * br + micro) * iw, -0.052 * turn * iw, -0.034 * wsL * iw);
    P.add('spine2', (0.022 - 0.024 * br) * iw, -0.030 * wsL * iw, -0.024 * wsL * iw);
    P.add('spine3', (0.008 - 0.026 * br2) * iw, -0.024 * wsL * iw, -0.012 * wsL * iw);
    P.add('neck', (0.030 + 0.013 * br2) * iw, -0.030 * wsL * iw, 0);
    P.add('head', (-0.026 - 0.030 * drift2) * iw, (0.105 * drift + 0.034 * ws) * iw, 0.020 * wsL * iw);

    P.add('clavicle_L', -0.012 * br * iw, 0, (0.020 + 0.020 * br) * iw);
    P.add('clavicle_R', -0.012 * br * iw, 0, -(0.020 + 0.020 * br) * iw);

    // relaxed off-hand
    P.add('upperArm_L', (0.075 + 0.030 * br) * iw * armD, -0.05 * iw, (0.125 + 0.014 * ws) * iw * armD);
    P.add('lowerArm_L', (-0.285 - 0.045 * br2) * iw * armD, 0, 0);
    P.add('hand_L', -0.070 * iw, 0.06 * iw, 0);

    // sword hand: the wrist is cocked so the blade tips down and forward rather
    // than sticking straight out like a lance
    P.add('upperArm_R', (0.020 + 0.024 * br2) * iw * armD, 0.055 * iw, (-0.150 - 0.012 * ws) * iw * armD);
    P.add('lowerArm_R', (-0.400 - 0.030 * br) * iw * armD, 0, 0);
    P.add('hand_R', (0.080 + 0.030 * br) * iw, -0.02 * iw, 0.02 * iw);

    // stance: right foot a touch back, weight rocking between the legs
    P.add('thigh_L', (-0.055 + 0.026 * ws) * iw, 0.085 * iw, 0.058 * iw);
    P.add('thigh_R', (0.105 - 0.026 * ws) * iw, -0.115 * iw, -0.052 * iw);
    P.add('shin_L', (0.140 - 0.052 * ws) * iw, 0, 0);
    P.add('shin_R', (0.150 + 0.052 * ws) * iw, 0, 0);
    P.add('foot_L', (-0.055 + 0.020 * ws) * iw, 0, 0);
    P.add('foot_R', (-0.085 - 0.020 * ws) * iw, 0, 0);
  }

  /* Sword carry. This is NOT scaled by the idle weight: a blade has to stay
     angled down through a walk and a run too, or the hero jogs along with it
     levelled like a rifle. */
  P.add('hand_R', 0.58 - 0.10 * mw, -0.14, 0.08);
  P.add('lowerArm_R', -0.10 * mw, 0, 0);

  /* turn-in-place lean + hip anticipation */
  if (Math.abs(turn) > 1e-3) {
    const tw = turn * (1 - 0.55 * mw);
    P.add('pelvis', 0, tw * 0.16, -tw * 0.05);
    P.add('spine2', 0, -tw * 0.10, -tw * 0.045);
    P.add('thigh_L', 0, tw * 0.13, 0);
    P.add('thigh_R', 0, tw * 0.13, 0);
  }
}

/* ================================================================== *
 * BASE LAYER — one-shots
 * ================================================================== */

/** Forward shoulder roll. The pelvis is the root bone, so tumbling it tumbles
 *  the whole figure; the body tucks so the rotation centre stays plausible. */
const dash = trackClip({
  dur: 0.66,
  loop: false,
  next: 'locomotion',
  nextFade: 0.16,
  tag: 'dash',
  root: ramp(0.04, 0.86, 4.2, 'out3'),
  events: [{ t: 0.06, name: 'dash:launch' }, { t: 0.30, name: 'dash:ground' }],
  rots: {
    pelvis: [
      [0, 0, 0, 0], [0.10, -0.62, 0, 0, 'out2'], [0.32, -2.55, 0, 0, 'linear'],
      [0.55, -4.35, 0, 0, 'linear'], [0.76, -6.05, 0, 0, 'out2'],
      [0.90, -6.283, 0, 0, 'out2'], [1, -6.283, 0, 0, 'linear'],
    ],
    spine1: [[0, 0, 0, 0], [0.14, 0.38, 0, 0, 'out2'], [0.44, 0.52, 0, 0], [0.72, 0.16, 0, 0], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.14, 0.42, 0, 0, 'out2'], [0.44, 0.58, 0, 0], [0.72, 0.14, 0, 0], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.16, 0.30, 0, 0, 'out2'], [0.46, 0.42, 0, 0], [0.74, 0.10, 0, 0], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.16, 0.34, 0, 0], [0.5, 0.40, 0, 0], [0.8, 0.06, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.16, 0.30, 0.10, 0], [0.5, 0.34, 0, 0], [0.8, 0.04, 0, 0], [1, 0, 0, 0]],
    thigh_L: [[0, 0, 0, 0], [0.12, -0.55, 0, 0.12, 'out2'], [0.36, -1.62, 0, 0.14], [0.66, -0.95, 0, 0.06], [0.88, 0.18, 0, 0, 'out2'], [1, 0, 0, 0]],
    thigh_R: [[0, 0, 0, 0], [0.12, -0.42, 0, -0.12, 'out2'], [0.36, -1.48, 0, -0.14], [0.66, -1.10, 0, -0.06], [0.88, -0.22, 0, 0, 'out2'], [1, 0, 0, 0]],
    shin_L: [[0, 0, 0, 0], [0.12, 0.85, 0, 0, 'out2'], [0.36, 2.05, 0, 0], [0.66, 1.35, 0, 0], [0.9, 0.20, 0, 0], [1, 0, 0, 0]],
    shin_R: [[0, 0, 0, 0], [0.12, 0.70, 0, 0, 'out2'], [0.36, 1.95, 0, 0], [0.66, 1.55, 0, 0], [0.9, 0.32, 0, 0], [1, 0, 0, 0]],
    foot_L: [[0, 0, 0, 0], [0.3, -0.35, 0, 0], [0.7, -0.20, 0, 0], [0.92, 0.14, 0, 0], [1, 0, 0, 0]],
    foot_R: [[0, 0, 0, 0], [0.3, -0.32, 0, 0], [0.7, -0.24, 0, 0], [0.92, 0.10, 0, 0], [1, 0, 0, 0]],
    upperArm_L: [[0, 0, 0, 0], [0.12, -0.95, 0, 0.55, 'out2'], [0.40, -1.60, 0, 0.30], [0.72, -0.60, 0, 0.34], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.12, -0.70, 0, -0.42, 'out2'], [0.40, -1.25, 0, -0.55], [0.72, -0.35, 0, -0.30], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.14, -1.30, 0, 0], [0.44, -1.75, 0, 0], [0.78, -0.60, 0, 0], [1, 0, 0, 0]],
    lowerArm_R: [[0, 0, 0, 0], [0.14, -0.95, 0, 0], [0.44, -1.30, 0, 0], [0.78, -0.55, 0, 0], [1, 0, 0, 0]],
  },
  moves: {
    pelvis: [
      [0, 0, 0, 0], [0.12, 0, -0.20, 0.02, 'out2'], [0.34, 0, -0.40, 0.02],
      [0.58, 0, -0.38, 0], [0.80, 0, -0.16, 0, 'out2'], [1, 0, 0, 0, 'inOut'],
    ],
  },
});

/** Heavy stumble backward — two recovery steps, arms thrown wide. */
const stagger = trackClip({
  dur: 1.05,
  loop: false,
  next: 'locomotion',
  nextFade: 0.24,
  tag: 'stagger',
  root: (ph) => -1.15 * EASE.out3(clamp01(ph / 0.62)),
  rots: {
    pelvis: [[0, 0, 0, 0], [0.10, -0.16, 0.10, 0.05, 'out3'], [0.34, 0.10, -0.14, -0.06], [0.62, -0.05, 0.07, 0.03], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.09, -0.34, 0.10, 0.08, 'out3'], [0.32, 0.16, -0.12, -0.07], [0.60, -0.10, 0.06, 0.03], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.11, -0.40, 0.13, 0.10, 'out3'], [0.34, 0.20, -0.14, -0.09], [0.62, -0.12, 0.07, 0.04], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.13, -0.34, 0.12, 0.09, 'out3'], [0.36, 0.18, -0.12, -0.08], [0.64, -0.10, 0.06, 0.03], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.12, -0.40, 0.10, 0], [0.36, 0.22, -0.08, 0], [0.66, -0.08, 0, 0], [1, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.14, -0.46, 0.16, 0.08], [0.38, 0.26, -0.12, -0.05], [0.68, -0.10, 0.04, 0], [1, 0, 0, 0]],
    upperArm_L: [[0, 0, 0, 0], [0.12, 0.55, 0, 0.95, 'out3'], [0.36, -0.15, 0, 0.62], [0.68, 0.20, 0, 0.34], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.12, 0.42, 0, -0.85, 'out3'], [0.36, -0.25, 0, -0.50], [0.68, 0.10, 0, -0.28], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.14, -0.55, 0, 0], [0.40, -1.05, 0, 0], [0.72, -0.45, 0, 0], [1, 0, 0, 0]],
    lowerArm_R: [[0, 0, 0, 0], [0.14, -0.70, 0, 0], [0.40, -1.15, 0, 0], [0.72, -0.55, 0, 0], [1, 0, 0, 0]],
    thigh_L: [[0, 0, 0, 0], [0.16, 0.42, 0.06, 0.10, 'out2'], [0.38, -0.34, 0, 0.08], [0.66, 0.16, 0, 0.05], [1, 0, 0, 0]],
    thigh_R: [[0, 0, 0, 0], [0.16, -0.32, -0.06, -0.10, 'out2'], [0.42, 0.46, 0, -0.08], [0.70, -0.14, 0, -0.05], [1, 0, 0, 0]],
    shin_L: [[0, 0, 0, 0], [0.18, 0.62, 0, 0], [0.40, 0.95, 0, 0], [0.70, 0.30, 0, 0], [1, 0, 0, 0]],
    shin_R: [[0, 0, 0, 0], [0.18, 0.85, 0, 0], [0.44, 0.55, 0, 0], [0.72, 0.34, 0, 0], [1, 0, 0, 0]],
    foot_L: [[0, 0, 0, 0], [0.2, 0.18, 0, 0], [0.5, -0.12, 0, 0], [1, 0, 0, 0]],
    foot_R: [[0, 0, 0, 0], [0.2, -0.14, 0, 0], [0.5, 0.16, 0, 0], [1, 0, 0, 0]],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.12, 0.02, -0.075, -0.05, 'out3'], [0.36, -0.02, -0.03, 0.02], [0.66, 0.01, -0.05, -0.01], [1, 0, 0, 0, 'inOut']],
  },
});

/** Collapse: knees buckle, the torso folds, the sword arm goes slack. Holds. */
const death = trackClip({
  dur: 1.85,
  loop: false,
  next: 'death',
  tag: 'death',
  events: [{ t: 0.30, name: 'death:knees' }, { t: 0.62, name: 'death:impact' }],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.16, -0.20, 0.05, 0.04, 'out2'], [0.40, 0.32, 0.14, 0.10], [0.66, 0.74, 0.22, 0.20, 'out2'], [1, 0.86, 0.26, 0.26, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.14, -0.26, 0, 0.05, 'out2'], [0.42, 0.34, -0.08, 0.10], [0.70, 0.56, -0.12, 0.16], [1, 0.62, -0.14, 0.18]],
    spine2: [[0, 0, 0, 0], [0.14, -0.30, 0, 0.06, 'out2'], [0.44, 0.40, -0.10, 0.12], [0.72, 0.62, -0.14, 0.18], [1, 0.68, -0.16, 0.20]],
    spine3: [[0, 0, 0, 0], [0.16, -0.24, 0, 0.05, 'out2'], [0.46, 0.34, -0.08, 0.10], [0.74, 0.50, -0.12, 0.14], [1, 0.55, -0.13, 0.16]],
    neck: [[0, 0, 0, 0], [0.16, -0.34, 0, 0], [0.48, 0.30, 0.06, 0.06], [0.78, 0.44, 0.08, 0.10], [1, 0.48, 0.08, 0.11]],
    head: [[0, 0, 0, 0], [0.18, -0.42, 0.10, 0], [0.50, 0.36, 0.14, 0.08], [0.80, 0.52, 0.16, 0.14], [1, 0.56, 0.16, 0.15]],
    thigh_L: [[0, 0, 0, 0], [0.18, -0.18, 0, 0.06], [0.44, -0.92, 0.06, 0.14], [0.70, -1.36, 0.08, 0.18], [1, -1.44, 0.08, 0.19]],
    thigh_R: [[0, 0, 0, 0], [0.18, -0.10, 0, -0.06], [0.44, -0.72, -0.06, -0.10], [0.70, -1.18, -0.10, -0.14], [1, -1.26, -0.10, -0.15]],
    shin_L: [[0, 0, 0, 0], [0.18, 0.30, 0, 0], [0.44, 1.55, 0, 0], [0.70, 2.28, 0, 0], [1, 2.36, 0, 0]],
    shin_R: [[0, 0, 0, 0], [0.18, 0.24, 0, 0], [0.44, 1.35, 0, 0], [0.70, 2.10, 0, 0], [1, 2.20, 0, 0]],
    foot_L: [[0, 0, 0, 0], [0.5, -0.30, 0, 0], [1, -0.42, 0, 0]],
    foot_R: [[0, 0, 0, 0], [0.5, -0.26, 0, 0], [1, -0.38, 0, 0]],
    upperArm_L: [[0, 0, 0, 0], [0.16, 0.30, 0, 0.42, 'out2'], [0.46, -0.35, 0, 0.55], [0.76, -0.62, 0, 0.30], [1, -0.66, 0, 0.26]],
    upperArm_R: [[0, 0, 0, 0], [0.16, 0.24, 0, -0.35, 'out2'], [0.46, -0.28, 0, -0.48], [0.76, -0.50, 0, -0.26], [1, -0.54, 0, -0.22]],
    lowerArm_L: [[0, 0, 0, 0], [0.2, -0.45, 0, 0], [0.5, -0.85, 0, 0], [1, -0.42, 0, 0]],
    lowerArm_R: [[0, 0, 0, 0], [0.2, -0.55, 0, 0], [0.5, -0.70, 0, 0], [1, -0.30, 0, 0]],
    hand_L: [[0, 0, 0, 0], [0.5, -0.25, 0, 0], [1, -0.35, 0, 0]],
    hand_R: [[0, 0, 0, 0], [0.5, -0.30, 0, 0], [1, -0.40, 0, 0]],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.18, 0, -0.045, -0.02, 'out2'], [0.46, 0.02, -0.34, 0.06], [0.70, 0.05, -0.52, 0.14, 'out2'], [1, 0.06, -0.55, 0.16, 'inOut']],
  },
});

/* ================================================================== *
 * ACTION LAYER — additive
 * ================================================================== */

const none = { dur: 1, loop: true, fn() {} };

/**
 * Hit 1 — descending diagonal from the high right to the low left.
 * Anticipation 0→0.26, acceleration into contact at 0.44, follow-through to
 * 0.62, settle by 1.0. The hips reverse before the shoulders, and the wrist
 * finishes last: overlapping action, not a single rotation.
 */
const attack1 = trackClip({
  dur: 0.66,
  loop: false,
  next: 'none',
  nextFade: 0.20,
  tag: 'attack',
  root: ramp(0.24, 0.56, 0.62, 'out3'),
  events: [{ t: 0.02, name: 'swing:start', trail: 1 }, { t: 0.44, name: 'impact', mag: 0.55, kind: 'slash' }],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.24, 0, -0.30, 0, 'out2'], [0.42, 0, 0.26, 0, 'snap'], [0.62, 0, 0.13, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.25, -0.07, -0.22, 0.05, 'out2'], [0.44, 0.20, 0.22, -0.07, 'snap'], [0.64, 0.11, 0.09, -0.02, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.26, -0.11, -0.28, 0.07, 'out2'], [0.44, 0.26, 0.27, -0.11, 'snap'], [0.66, 0.13, 0.11, -0.03, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.27, -0.10, -0.25, 0.07, 'out2'], [0.45, 0.22, 0.25, -0.11, 'snap'], [0.68, 0.10, 0.10, -0.03, 'out2'], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.26, 0.04, 0.14, 0], [0.46, 0.12, -0.10, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    head: [[0, 0, 0, 0], [0.26, 0.02, 0.20, -0.04], [0.48, 0.16, -0.12, 0.04, 'snap'], [0.72, 0.06, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    clavicle_R: [[0, 0, 0, 0], [0.26, -0.10, -0.12, -0.20, 'out2'], [0.44, 0.07, 0.10, 0.13, 'snap'], [0.66, 0.02, 0.04, 0.05], [1, 0, 0, 0, 'inOut']],
    clavicle_L: [[0, 0, 0, 0], [0.26, 0.05, 0.10, 0.10, 'out2'], [0.44, -0.04, -0.08, -0.08, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.27, -2.22, -0.32, -0.48, 'out2'], [0.44, -0.82, 0.12, 0.33, 'snap'], [0.60, -0.44, 0.17, 0.53, 'out2'], [0.80, -0.20, 0.08, 0.26], [1, 0, 0, 0, 'inOut']],
    lowerArm_R: [[0, 0, 0, 0], [0.27, -1.72, 0, 0, 'out2'], [0.44, -0.40, 0, 0, 'snap'], [0.62, -0.78, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_R: [[0, 0, 0, 0], [0.27, -0.32, 0.26, 0.10], [0.45, 0.20, -0.22, -0.12, 'snap'], [0.66, 0.06, -0.08, -0.04], [1, 0, 0, 0, 'inOut']],
    upperArm_L: [[0, 0, 0, 0], [0.27, 0.34, 0, 0.58, 'out2'], [0.45, -0.38, 0, 0.26, 'snap'], [0.70, -0.10, 0, 0.20], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.27, -0.92, 0, 0, 'out2'], [0.45, -0.52, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_R: [[0, 0, 0, 0], [0.24, 0.16, -0.12, 0, 'out2'], [0.44, -0.26, 0.12, 0, 'snap'], [0.68, -0.08, 0.05, 0], [1, 0, 0, 0, 'inOut']],
    thigh_L: [[0, 0, 0, 0], [0.24, -0.12, 0.10, 0, 'out2'], [0.44, 0.22, -0.10, 0, 'snap'], [0.68, 0.07, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    shin_R: [[0, 0, 0, 0], [0.24, 0.26, 0, 0, 'out2'], [0.44, 0.12, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_L: [[0, 0, 0, 0], [0.24, 0.10, 0, 0, 'out2'], [0.44, 0.30, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    foot_R: [[0, 0, 0, 0], [0.44, -0.12, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    foot_L: [[0, 0, 0, 0], [0.44, 0.10, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.24, 0.02, -0.048, -0.055, 'out2'], [0.44, -0.02, -0.022, 0.095, 'snap'], [0.70, 0, -0.006, 0.038], [1, 0, 0, 0, 'inOut']],
  },
});

/** Hit 2 — horizontal backhand, low left to right, hips driving the blade. */
const attack2 = trackClip({
  dur: 0.60,
  loop: false,
  next: 'none',
  nextFade: 0.20,
  tag: 'attack',
  root: ramp(0.20, 0.52, 0.52, 'out3'),
  events: [{ t: 0.02, name: 'swing:start', trail: 1 }, { t: 0.40, name: 'impact', mag: 0.6, kind: 'slash' }],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.20, 0, 0.34, -0.04, 'out2'], [0.40, 0, -0.34, 0.05, 'snap'], [0.60, 0, -0.16, 0.02, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.21, 0.05, 0.28, -0.06, 'out2'], [0.40, 0.10, -0.30, 0.07, 'snap'], [0.62, 0.05, -0.13, 0.03], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.22, 0.07, 0.34, -0.08, 'out2'], [0.41, 0.13, -0.36, 0.09, 'snap'], [0.64, 0.06, -0.15, 0.04], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.23, 0.06, 0.30, -0.07, 'out2'], [0.42, 0.11, -0.32, 0.08, 'snap'], [0.66, 0.05, -0.13, 0.03], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.22, 0, -0.16, 0], [0.44, 0.06, 0.16, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    head: [[0, 0, 0, 0], [0.22, -0.02, -0.24, 0.04], [0.46, 0.08, 0.20, -0.05, 'snap'], [0.72, 0.02, 0.06, 0], [1, 0, 0, 0, 'inOut']],
    clavicle_R: [[0, 0, 0, 0], [0.22, 0.06, 0.16, 0.06, 'out2'], [0.41, -0.05, -0.16, -0.14, 'snap'], [1, 0, 0, 0, 'inOut']],
    clavicle_L: [[0, 0, 0, 0], [0.22, -0.05, -0.12, -0.08, 'out2'], [0.41, 0.04, 0.12, 0.10, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.23, -1.02, 0.55, 0.78, 'out2'], [0.41, -1.12, -0.42, -0.62, 'snap'], [0.58, -0.86, -0.52, -0.86, 'out2'], [0.80, -0.34, -0.20, -0.36], [1, 0, 0, 0, 'inOut']],
    lowerArm_R: [[0, 0, 0, 0], [0.23, -1.55, 0, 0, 'out2'], [0.41, -0.52, 0, 0, 'snap'], [0.60, -0.86, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_R: [[0, 0, 0, 0], [0.23, 0.22, 0.34, 0.16], [0.42, -0.14, -0.28, -0.16, 'snap'], [0.66, -0.04, -0.10, -0.05], [1, 0, 0, 0, 'inOut']],
    upperArm_L: [[0, 0, 0, 0], [0.23, -0.30, 0, 0.22, 'out2'], [0.42, 0.42, 0, 0.72, 'snap'], [0.70, 0.14, 0, 0.30], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.23, -1.15, 0, 0, 'out2'], [0.42, -0.55, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_R: [[0, 0, 0, 0], [0.20, -0.14, 0.14, 0, 'out2'], [0.40, 0.24, -0.14, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_L: [[0, 0, 0, 0], [0.20, 0.18, -0.12, 0, 'out2'], [0.40, -0.24, 0.12, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_R: [[0, 0, 0, 0], [0.20, 0.12, 0, 0, 'out2'], [0.40, 0.30, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_L: [[0, 0, 0, 0], [0.20, 0.28, 0, 0, 'out2'], [0.40, 0.14, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.20, -0.03, -0.038, -0.04, 'out2'], [0.40, 0.03, -0.018, 0.085, 'snap'], [0.68, 0.01, 0, 0.03], [1, 0, 0, 0, 'inOut']],
  },
});

/** Hit 3 — overhead two-handed finisher with a step-through and a real slam. */
const attack3 = trackClip({
  dur: 0.92,
  loop: false,
  next: 'none',
  nextFade: 0.24,
  tag: 'attack',
  root: ramp(0.28, 0.62, 0.98, 'out3'),
  events: [
    { t: 0.02, name: 'swing:start', trail: 1.3 },
    { t: 0.52, name: 'impact', mag: 1.0, kind: 'crush' },
    { t: 0.52, name: 'shake', amp: 0.24, freq: 20, dur: 0.3 },
  ],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.30, -0.13, -0.14, 0, 'out2'], [0.52, 0.28, 0.10, 0, 'snap'], [0.70, 0.16, 0.05, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.30, -0.30, -0.12, 0, 'out2'], [0.52, 0.40, 0.08, 0, 'snap'], [0.72, 0.22, 0.03, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.31, -0.34, -0.14, 0, 'out2'], [0.52, 0.48, 0.10, 0, 'snap'], [0.74, 0.26, 0.04, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.32, -0.28, -0.12, 0, 'out2'], [0.53, 0.40, 0.08, 0, 'snap'], [0.76, 0.20, 0.03, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.31, -0.26, 0, 0], [0.54, 0.30, 0, 0, 'snap'], [0.80, 0.14, 0, 0], [1, 0, 0, 0, 'inOut']],
    head: [[0, 0, 0, 0], [0.31, -0.34, 0.06, 0], [0.56, 0.38, -0.04, 0, 'snap'], [0.82, 0.16, 0, 0], [1, 0, 0, 0, 'inOut']],
    clavicle_R: [[0, 0, 0, 0], [0.31, -0.18, -0.06, -0.22, 'out2'], [0.52, 0.10, 0.04, 0.14, 'snap'], [1, 0, 0, 0, 'inOut']],
    clavicle_L: [[0, 0, 0, 0], [0.31, -0.16, 0.06, 0.22, 'out2'], [0.52, 0.10, -0.04, -0.14, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.32, -2.58, -0.10, -0.30, 'out2'], [0.52, -0.62, 0.02, 0.04, 'snap'], [0.68, -0.34, 0.04, 0.12, 'out2'], [0.86, -0.14, 0.02, 0.05], [1, 0, 0, 0, 'inOut']],
    lowerArm_R: [[0, 0, 0, 0], [0.32, -1.30, 0, 0, 'out2'], [0.52, -0.24, 0, 0, 'snap'], [0.70, -0.62, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_R: [[0, 0, 0, 0], [0.32, -0.30, 0.10, 0], [0.53, 0.26, -0.08, 0, 'snap'], [0.74, 0.08, 0, 0], [1, 0, 0, 0, 'inOut']],
    upperArm_L: [[0, 0, 0, 0], [0.32, -2.34, 0.20, 0.56, 'out2'], [0.52, -0.58, -0.06, 0.20, 'snap'], [0.70, -0.30, 0, 0.24, 'out2'], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.32, -1.52, 0, 0, 'out2'], [0.52, -0.42, 0, 0, 'snap'], [0.70, -0.72, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_L: [[0, 0, 0, 0], [0.32, -0.20, -0.24, 0], [0.53, 0.20, -0.10, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_R: [[0, 0, 0, 0], [0.30, 0.30, -0.06, 0, 'out2'], [0.52, -0.46, 0.06, 0, 'snap'], [0.74, -0.16, 0.02, 0], [1, 0, 0, 0, 'inOut']],
    thigh_L: [[0, 0, 0, 0], [0.30, -0.24, 0.06, 0, 'out2'], [0.52, 0.40, -0.06, 0, 'snap'], [0.74, 0.14, -0.02, 0], [1, 0, 0, 0, 'inOut']],
    shin_R: [[0, 0, 0, 0], [0.30, 0.40, 0, 0, 'out2'], [0.52, 0.22, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_L: [[0, 0, 0, 0], [0.30, 0.20, 0, 0, 'out2'], [0.52, 0.52, 0, 0, 'snap'], [0.78, 0.18, 0, 0], [1, 0, 0, 0, 'inOut']],
    foot_R: [[0, 0, 0, 0], [0.30, 0.14, 0, 0], [0.52, -0.20, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    foot_L: [[0, 0, 0, 0], [0.30, -0.12, 0, 0], [0.52, 0.16, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.30, 0, 0.030, -0.075, 'out2'], [0.52, 0, -0.075, 0.115, 'snap'], [0.74, 0, -0.030, 0.045, 'out2'], [1, 0, 0, 0, 'inOut']],
  },
});

/** Heavy — a full circular wind-up over the shoulder into a ground-breaking slam. */
const heavy = trackClip({
  dur: 1.24,
  loop: false,
  next: 'none',
  nextFade: 0.28,
  tag: 'heavy',
  root: ramp(0.36, 0.68, 1.25, 'out3'),
  events: [
    { t: 0.04, name: 'swing:start', trail: 1.6 },
    { t: 0.60, name: 'impact', mag: 1.7, kind: 'crush' },
    { t: 0.60, name: 'shake', amp: 0.52, freq: 15, dur: 0.55 },
  ],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.22, -0.10, -0.42, 0.04, 'out2'], [0.40, -0.16, -0.56, 0.05, 'out2'], [0.60, 0.34, 0.30, -0.05, 'snap'], [0.80, 0.20, 0.14, -0.02, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.22, -0.26, -0.34, 0.07, 'out2'], [0.40, -0.36, -0.46, 0.09, 'out2'], [0.60, 0.46, 0.26, -0.08, 'snap'], [0.82, 0.26, 0.10, -0.03, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.22, -0.30, -0.40, 0.09, 'out2'], [0.40, -0.42, -0.54, 0.11, 'out2'], [0.60, 0.54, 0.30, -0.10, 'snap'], [0.84, 0.30, 0.12, -0.04, 'out2'], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.24, -0.24, -0.36, 0.08, 'out2'], [0.42, -0.34, -0.48, 0.10, 'out2'], [0.61, 0.44, 0.26, -0.09, 'snap'], [0.86, 0.24, 0.10, -0.03, 'out2'], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.30, -0.24, 0.18, 0], [0.62, 0.34, -0.12, 0, 'snap'], [0.88, 0.16, 0, 0], [1, 0, 0, 0, 'inOut']],
    head: [[0, 0, 0, 0], [0.30, -0.30, 0.26, -0.06], [0.64, 0.42, -0.16, 0.05, 'snap'], [0.90, 0.18, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    clavicle_R: [[0, 0, 0, 0], [0.36, -0.22, -0.14, -0.28, 'out2'], [0.60, 0.12, 0.08, 0.18, 'snap'], [1, 0, 0, 0, 'inOut']],
    clavicle_L: [[0, 0, 0, 0], [0.36, -0.14, 0.10, 0.24, 'out2'], [0.60, 0.10, -0.06, -0.14, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.20, -0.60, -0.30, -1.05, 'out2'], [0.40, -2.05, -0.42, -0.92, 'out2'], [0.50, -2.86, -0.16, -0.34, 'out2'], [0.60, -0.72, 0.04, 0.06, 'snap'], [0.76, -0.30, 0.06, 0.16, 'out2'], [0.92, -0.10, 0.02, 0.06], [1, 0, 0, 0, 'inOut']],
    lowerArm_R: [[0, 0, 0, 0], [0.20, -0.75, 0, 0, 'out2'], [0.42, -1.70, 0, 0, 'out2'], [0.50, -1.42, 0, 0], [0.60, -0.20, 0, 0, 'snap'], [0.78, -0.66, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_R: [[0, 0, 0, 0], [0.42, -0.34, 0.20, 0.10], [0.61, 0.30, -0.14, -0.06, 'snap'], [0.82, 0.08, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    upperArm_L: [[0, 0, 0, 0], [0.24, -0.35, 0.10, 0.62, 'out2'], [0.44, -2.05, 0.30, 0.72, 'out2'], [0.52, -2.60, 0.22, 0.50, 'out2'], [0.60, -0.66, -0.04, 0.22, 'snap'], [0.80, -0.26, 0, 0.26, 'out2'], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.24, -0.85, 0, 0, 'out2'], [0.46, -1.75, 0, 0, 'out2'], [0.60, -0.40, 0, 0, 'snap'], [0.80, -0.75, 0, 0, 'out2'], [1, 0, 0, 0, 'inOut']],
    hand_L: [[0, 0, 0, 0], [0.44, -0.24, -0.28, 0], [0.61, 0.22, -0.10, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_R: [[0, 0, 0, 0], [0.24, 0.22, -0.20, 0, 'out2'], [0.42, 0.42, -0.24, 0, 'out2'], [0.60, -0.56, 0.14, 0, 'snap'], [0.84, -0.20, 0.05, 0], [1, 0, 0, 0, 'inOut']],
    thigh_L: [[0, 0, 0, 0], [0.24, -0.18, 0.16, 0, 'out2'], [0.42, -0.32, 0.20, 0, 'out2'], [0.60, 0.50, -0.12, 0, 'snap'], [0.84, 0.18, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    shin_R: [[0, 0, 0, 0], [0.24, 0.34, 0, 0, 'out2'], [0.42, 0.55, 0, 0], [0.60, 0.26, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_L: [[0, 0, 0, 0], [0.24, 0.22, 0, 0, 'out2'], [0.42, 0.30, 0, 0], [0.60, 0.66, 0, 0, 'snap'], [0.86, 0.22, 0, 0], [1, 0, 0, 0, 'inOut']],
    foot_R: [[0, 0, 0, 0], [0.42, 0.18, 0, 0], [0.60, -0.26, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    foot_L: [[0, 0, 0, 0], [0.42, -0.14, 0, 0], [0.60, 0.20, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.24, 0.03, 0.020, -0.085, 'out2'], [0.42, 0.05, 0.045, -0.110, 'out2'], [0.60, -0.02, -0.115, 0.150, 'snap'], [0.84, 0, -0.040, 0.055, 'out2'], [1, 0, 0, 0, 'inOut']],
  },
});

/** Cast — plant, gather, release. The off hand does the work. */
const cast = trackClip({
  dur: 1.0,
  loop: false,
  next: 'none',
  nextFade: 0.26,
  tag: 'cast',
  events: [{ t: 0.10, name: 'cast:gather' }, { t: 0.52, name: 'cast:release', mag: 0.8 }],
  rots: {
    pelvis: [[0, 0, 0, 0], [0.34, -0.10, 0.16, 0, 'out2'], [0.54, 0.12, -0.10, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    spine1: [[0, 0, 0, 0], [0.34, -0.20, 0.12, 0, 'out2'], [0.54, 0.20, -0.10, 0, 'snap'], [0.78, 0.08, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    spine2: [[0, 0, 0, 0], [0.34, -0.24, 0.14, 0, 'out2'], [0.54, 0.24, -0.12, 0, 'snap'], [0.80, 0.10, -0.04, 0], [1, 0, 0, 0, 'inOut']],
    spine3: [[0, 0, 0, 0], [0.35, -0.20, 0.12, 0, 'out2'], [0.55, 0.20, -0.10, 0, 'snap'], [0.82, 0.08, -0.03, 0], [1, 0, 0, 0, 'inOut']],
    neck: [[0, 0, 0, 0], [0.34, -0.16, -0.06, 0], [0.56, 0.14, 0.04, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    head: [[0, 0, 0, 0], [0.34, -0.22, -0.10, 0], [0.58, 0.18, 0.06, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    clavicle_L: [[0, 0, 0, 0], [0.34, -0.14, 0.10, 0.20, 'out2'], [0.55, 0.06, -0.04, -0.06, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_L: [[0, 0, 0, 0], [0.18, -0.55, 0.14, 0.42, 'out2'], [0.38, -1.72, 0.26, 0.34, 'out2'], [0.56, -1.34, -0.10, 0.10, 'snap'], [0.80, -0.55, 0, 0.22, 'out2'], [1, 0, 0, 0, 'inOut']],
    lowerArm_L: [[0, 0, 0, 0], [0.18, -0.90, 0, 0, 'out2'], [0.38, -1.66, 0, 0, 'out2'], [0.56, -0.42, 0, 0, 'snap'], [0.80, -0.70, 0, 0], [1, 0, 0, 0, 'inOut']],
    hand_L: [[0, 0, 0, 0], [0.38, -0.42, -0.30, 0.20], [0.56, 0.34, 0.18, -0.14, 'snap'], [1, 0, 0, 0, 'inOut']],
    upperArm_R: [[0, 0, 0, 0], [0.34, 0.28, -0.18, -0.40, 'out2'], [0.58, -0.10, 0.06, -0.16, 'snap'], [1, 0, 0, 0, 'inOut']],
    lowerArm_R: [[0, 0, 0, 0], [0.34, -0.70, 0, 0, 'out2'], [0.58, -0.34, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_L: [[0, 0, 0, 0], [0.34, -0.14, 0.10, 0.05, 'out2'], [0.56, 0.14, -0.06, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    thigh_R: [[0, 0, 0, 0], [0.34, 0.18, -0.10, -0.05, 'out2'], [0.56, -0.14, 0.06, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_L: [[0, 0, 0, 0], [0.34, 0.24, 0, 0, 'out2'], [0.56, 0.10, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
    shin_R: [[0, 0, 0, 0], [0.34, 0.30, 0, 0, 'out2'], [0.56, 0.14, 0, 0, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
  moves: {
    pelvis: [[0, 0, 0, 0], [0.34, 0, -0.055, -0.030, 'out2'], [0.56, 0, -0.018, 0.050, 'snap'], [1, 0, 0, 0, 'inOut']],
  },
});

/**
 * Directional hit reactions. No anticipation — the impact *is* frame 0 — then a
 * damped overshoot back. Built from one generator so the four directions share
 * timing and only differ in the axis the force arrives on.
 */
function hitReact(dirX, dirZ, tag) {
  const s = dirZ;   // +1 = struck from the front (recoil backward)
  const x = dirX;   // +1 = struck from the character's left (pushed right)
  return trackClip({
    dur: 0.44,
    loop: false,
    next: 'none',
    nextFade: 0.18,
    tag,
    root: (ph) => -0.24 * s * EASE.out3(clamp01(ph / 0.34)),
    events: [{ t: 0.0, name: 'hit:flinch' }],
    rots: {
      pelvis: [[0, 0, 0, 0], [0.09, -0.20 * s, 0.10 * x, 0.13 * x, 'out3'], [0.26, 0.10 * s, -0.05 * x, -0.06 * x, 'out2'], [0.42, -0.03 * s, 0.02 * x, 0.02 * x], [1, 0, 0, 0, 'inOut']],
      spine1: [[0, 0, 0, 0], [0.08, -0.30 * s, 0.12 * x, 0.18 * x, 'out3'], [0.25, 0.14 * s, -0.06 * x, -0.09 * x, 'out2'], [0.42, -0.04 * s, 0.02 * x, 0.03 * x], [1, 0, 0, 0, 'inOut']],
      spine2: [[0, 0, 0, 0], [0.09, -0.34 * s, 0.14 * x, 0.20 * x, 'out3'], [0.26, 0.16 * s, -0.07 * x, -0.10 * x, 'out2'], [0.44, -0.05 * s, 0.02 * x, 0.03 * x], [1, 0, 0, 0, 'inOut']],
      spine3: [[0, 0, 0, 0], [0.10, -0.28 * s, 0.12 * x, 0.17 * x, 'out3'], [0.28, 0.13 * s, -0.06 * x, -0.08 * x, 'out2'], [0.46, -0.04 * s, 0.02 * x, 0.02 * x], [1, 0, 0, 0, 'inOut']],
      neck: [[0, 0, 0, 0], [0.10, -0.34 * s, 0.14 * x, 0.10 * x, 'out3'], [0.30, 0.18 * s, -0.07 * x, -0.05 * x, 'out2'], [1, 0, 0, 0, 'inOut']],
      head: [[0, 0, 0, 0], [0.12, -0.42 * s, 0.20 * x, 0.14 * x, 'out3'], [0.32, 0.22 * s, -0.10 * x, -0.07 * x, 'out2'], [0.52, -0.06 * s, 0.03 * x, 0.02 * x], [1, 0, 0, 0, 'inOut']],
      clavicle_L: [[0, 0, 0, 0], [0.10, -0.10, 0, 0.16 * (1 + x) * 0.5, 'out3'], [0.32, 0.04, 0, -0.05], [1, 0, 0, 0, 'inOut']],
      clavicle_R: [[0, 0, 0, 0], [0.10, -0.10, 0, -0.16 * (1 - x) * 0.5, 'out3'], [0.32, 0.04, 0, 0.05], [1, 0, 0, 0, 'inOut']],
      upperArm_L: [[0, 0, 0, 0], [0.11, 0.34 * s + 0.10, 0, 0.52, 'out3'], [0.32, -0.14 * s, 0, 0.24, 'out2'], [1, 0, 0, 0, 'inOut']],
      upperArm_R: [[0, 0, 0, 0], [0.11, 0.30 * s + 0.08, 0, -0.46, 'out3'], [0.32, -0.12 * s, 0, -0.20, 'out2'], [1, 0, 0, 0, 'inOut']],
      lowerArm_L: [[0, 0, 0, 0], [0.13, -0.72, 0, 0, 'out3'], [0.36, -0.34, 0, 0], [1, 0, 0, 0, 'inOut']],
      lowerArm_R: [[0, 0, 0, 0], [0.13, -0.80, 0, 0, 'out3'], [0.36, -0.38, 0, 0], [1, 0, 0, 0, 'inOut']],
      thigh_L: [[0, 0, 0, 0], [0.14, 0.22 * s + 0.06 * x, 0, 0.08, 'out3'], [0.36, -0.08 * s, 0, 0.03], [1, 0, 0, 0, 'inOut']],
      thigh_R: [[0, 0, 0, 0], [0.14, 0.18 * s - 0.06 * x, 0, -0.08, 'out3'], [0.36, -0.06 * s, 0, -0.03], [1, 0, 0, 0, 'inOut']],
      shin_L: [[0, 0, 0, 0], [0.14, 0.30, 0, 0, 'out3'], [0.38, 0.12, 0, 0], [1, 0, 0, 0, 'inOut']],
      shin_R: [[0, 0, 0, 0], [0.14, 0.34, 0, 0, 'out3'], [0.38, 0.14, 0, 0], [1, 0, 0, 0, 'inOut']],
    },
    moves: {
      pelvis: [[0, 0, 0, 0], [0.10, -0.030 * x, -0.048, -0.055 * s, 'out3'], [0.30, 0.012 * x, -0.014, 0.020 * s, 'out2'], [1, 0, 0, 0, 'inOut']],
    },
  });
}

/* ------------------------------------------------------------------ *
 * exports
 * ------------------------------------------------------------------ */

export function buildHeroClips() {
  return {
    base: {
      locomotion: { dur: 1, loop: true, fn: locomotion },
      dash,
      stagger,
      death,
    },
    actions: {
      none,
      attack1,
      attack2,
      attack3,
      heavy,
      cast,
      hitFront: hitReact(0, 1, 'hit'),
      hitBack: hitReact(0, -1, 'hit'),
      hitLeft: hitReact(1, 0.25, 'hit'),
      hitRight: hitReact(-1, 0.25, 'hit'),
    },
  };
}

export const COMBO = ['attack1', 'attack2', 'attack3'];
export { cyc, trackClip as _trackClip };
