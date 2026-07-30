/**
 * THE NINTH VIGIL — shared procedural clip library for the bestiary.
 *
 * Every archetype's animation set is assembled from these generators and then
 * re-tuned, which is what keeps a hound feeling fast and a brute feeling heavy
 * from the *same* code: the difference is stride length, contact time, phase
 * offsets between hips/chest/head, and how much overshoot each joint carries.
 *
 * Sign conventions (right-handed, +Z is the creature's forward):
 *   • a bone pointing DOWN (-Y): +rotX swings it backward, -rotX forward
 *   • a bone pointing UP  (+Y): +rotX leans it forward
 *   • knees/elbows only ever bend one way; the generators respect that
 *
 * Rotations accumulate through `P.add`, so a clip may be layered.
 */

import { noise3 } from './RigKit.js';
import { pulse, ease } from './AnimKit.js';

export const TAU = Math.PI * 2;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Cyclic pulse — handles wrap so a foot-strike at t=0 is continuous. */
export function wpulse(t, c, w) {
  let d = Math.abs(((t - c) % 1 + 1.5) % 1 - 0.5);
  d = (0.5 - d) / w;
  if (d <= 0) return 0;
  const s = Math.min(1, d);
  return s * s * (3 - 2 * s);
}

const L = '.L', R = '.R';

/* ------------------------------------------------------------------ *
 * biped locomotion
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   stride     hip swing amplitude (rad)
 *   knee       peak knee bend (rad)
 *   bob        vertical body travel (m)
 *   sway       lateral body travel (m)
 *   lean       forward torso lean (rad)
 *   arm        shoulder counter-swing (rad)
 *   elbow      base elbow bend (rad)
 *   asym       0..1 limp — shortens one leg's swing and drops the body on it
 *   heavy      0..1 — extends contact time and adds a settle at foot strike
 *   twist      torso counter-rotation (rad)
 */
export function bipedWalk(o = {}) {
  const A = o.stride ?? 0.52, KB = o.knee ?? 0.95, bob = o.bob ?? 0.035;
  const sway = o.sway ?? 0.022, lean = o.lean ?? 0.10, arm = o.arm ?? 0.42;
  const elb = o.elbow ?? 0.36, asym = o.asym ?? 0, heavy = o.heavy ?? 0;
  const twist = o.twist ?? 0.11;
  const legs = o.legs !== false;
  return (P, ph, ctx) => {
    const g = ctx.gait ?? 1;
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? L : R;
      const t = (ph + s * 0.5) % 1;
      const shorten = s === 0 ? 1 : 1 - asym * 0.55;
      if (legs) {
        // hip: forward at contact, back at toe-off; contact stretched when heavy
        const cyc = Math.cos((t + heavy * 0.06) * TAU);
        P.add(`hip${side}`, -A * g * cyc * shorten, (s === 0 ? 1 : -1) * 0.05, 0);
        P.add(`knee${side}`,
          KB * g * (0.92 * wpulse(t, 0.70, 0.30) + 0.14 * wpulse(t, 0.10, 0.18)) * shorten +
          0.10 + KB * asym * 0.45 * (s === 1 ? 1 : 0), 0, 0);
        P.add(`ankle${side}`,
          -0.42 * g * wpulse(t, 0.48, 0.16) + 0.26 * g * wpulse(t, 0.98, 0.14) - 0.06, 0, 0);
        P.add(`toe${side}`, 0.30 * g * wpulse(t, 0.52, 0.14), 0, 0);
      }
      // arms counter-swing; the far arm leads the near leg
      P.add(`shoulder${side}`, arm * g * Math.cos(t * TAU), 0,
        (s === 0 ? 1 : -1) * (0.12 + arm * 0.16));
      P.add(`elbow${side}`, -(elb + 0.22 * g * Math.max(0, -Math.cos(t * TAU))), 0, 0);
    }
    const dbl = Math.cos(ph * 2 * TAU);
    P.move('root', sway * Math.sin(ph * TAU), -bob * (0.5 - 0.5 * dbl) - heavy * 0.012 * g, 0);
    P.add('root', 0, 0, -0.035 * g * Math.sin(ph * TAU));
    P.add('hips', 0.02, twist * Math.cos(ph * TAU), 0.05 * Math.sin(ph * TAU) * (1 + asym));
    P.add('spine', lean * 0.45, -twist * 0.55 * Math.cos(ph * TAU), asym * 0.10);
    P.add('chest', lean * 0.55, -twist * 0.75 * Math.cos(ph * TAU), asym * 0.06);
    P.add('neck', -lean * 0.30, twist * 0.30 * Math.cos(ph * TAU), 0);
    P.add('head', -lean * 0.25 + 0.03 * dbl, twist * 0.22 * Math.cos((ph + 0.1) * TAU), 0);
  };
}

export function bipedIdle(o = {}) {
  const br = o.breath ?? 0.035, lean = o.lean ?? 0.06, sw = o.sway ?? 0.010;
  const elb = o.elbow ?? 0.30, shoulderDrop = o.shoulderDrop ?? 0.10;
  return (P, ph, ctx) => {
    const b = Math.sin(ph * TAU);
    const b2 = Math.sin(ph * TAU * 2 + 1.1);
    P.move('root', sw * b2 * 0.4, -br * 0.35 * (0.5 + 0.5 * b), 0);
    P.add('hips', 0.03, 0.035 * b2, 0.02 * b);
    P.add('spine', lean * 0.4 + br * 0.5 * b, -0.03 * b2, 0);
    P.add('chest', lean * 0.6 - br * 0.9 * b, -0.05 * b2, 0);
    P.add('neck', -lean * 0.3, 0.06 * b2, 0);
    P.add('head', -lean * 0.35 + 0.035 * Math.sin(ph * TAU * 0.7), 0.14 * Math.sin(ph * TAU * 0.43 + 2.0), 0.02 * b);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? L : R;
      const sg = s === 0 ? 1 : -1;
      P.add(`shoulder${side}`, shoulderDrop + 0.05 * Math.sin((ph + s * 0.37) * TAU), 0, sg * 0.14);
      P.add(`elbow${side}`, -(elb + 0.06 * Math.sin((ph + s * 0.21) * TAU)), 0, 0);
      P.add(`hip${side}`, -0.03, sg * 0.05, sg * 0.03);
      P.add(`knee${side}`, 0.10, 0, 0);
      P.add(`ankle${side}`, -0.05, 0, 0);
    }
  };
}

/**
 * Overhead / diagonal melee swing. `hand` is 'R' or 'L'.
 * windup 0..0.42, strike 0.42..0.60, recover 0.60..1
 */
export function bipedSwing(o = {}) {
  const side = o.hand === 'L' ? L : R;
  const other = o.hand === 'L' ? R : L;
  const sg = o.hand === 'L' ? -1 : 1;
  const reach = o.reach ?? 1;
  const hit = o.hitAt ?? 0.5;
  return (P, ph) => {
    const wind = ease.out2(clamp01(ph / hit));
    const strike = ease.snap(clamp01((ph - hit) / 0.16));
    const rec = ease.inOut(clamp01((ph - hit - 0.16) / (1 - hit - 0.16)));
    const a = wind * (1 - strike);

    // wind up: torso coils away, weapon arm cocks back and high
    P.add('hips', 0, -sg * 0.30 * a + sg * 0.34 * strike * (1 - rec), 0);
    P.add('spine', -0.16 * a + 0.30 * strike * (1 - rec * 0.7), -sg * 0.26 * a + sg * 0.30 * strike, 0);
    P.add('chest', -0.20 * a + 0.42 * strike * (1 - rec * 0.6), -sg * 0.34 * a + sg * 0.40 * strike, sg * 0.12 * strike);
    P.add('neck', 0.10 * a - 0.16 * strike, sg * 0.18 * a, 0);
    P.add('head', 0.06 * a - 0.10 * strike, sg * 0.10 * a, 0);

    P.add(`shoulder${side}`, (-2.05 * a - 0.35) * reach + 1.65 * strike * reach, -sg * 0.35 * a, -sg * (0.55 * a - 0.30 * strike));
    P.add(`elbow${side}`, -(1.35 * a + 0.20) + 1.15 * strike, 0, 0);
    P.add(`wrist${side}`, -0.35 * a + 0.45 * strike, 0, sg * 0.25 * a);
    P.add(`shoulder${other}`, 0.55 * a - 0.30 * strike, 0, sg * 0.30 * a);
    P.add(`elbow${other}`, -(0.70 + 0.35 * a), 0, 0);

    // step into the blow — weight transfer, not a slide
    P.move('root', sg * 0.05 * a, -0.06 * strike * (1 - rec), 0.16 * strike * (1 - rec * 0.8));
    P.add(`hip${side}`, -0.22 * strike, 0, 0);
    P.add(`knee${side}`, 0.30 * a + 0.16 * strike, 0, 0);
    P.add(`hip${other}`, 0.14 * a, 0, 0);
    P.add(`knee${other}`, 0.42 * a + 0.30 * strike, 0, 0);
    P.add(`ankle${other}`, -0.24 * a, 0, 0);
  };
}

/** Directional flinch. ctx.hitDir is a local-space unit vector (x right, z fwd). */
export function bipedHit(o = {}) {
  const amp = o.amp ?? 1;
  return (P, ph, ctx) => {
    const k = (1 - ease.out3(ph)) * amp;
    const hx = ctx.hitDir ? ctx.hitDir.x : 0;
    const hz = ctx.hitDir ? ctx.hitDir.z : 1;
    const sh = Math.sin(ph * 22) * Math.max(0, 1 - ph * 2.4);
    P.add('root', -hz * 0.10 * k, hx * 0.12 * k, hx * 0.16 * k);
    P.move('root', -hx * 0.05 * k, -0.05 * k, -hz * 0.06 * k);
    P.add('hips', -hz * 0.14 * k, hx * 0.16 * k, hx * 0.10 * k);
    P.add('spine', -hz * 0.26 * k, hx * 0.18 * k, -hx * 0.14 * k);
    P.add('chest', -hz * 0.34 * k + sh * 0.03, hx * 0.22 * k, -hx * 0.18 * k);
    P.add('neck', -hz * 0.18 * k, -hx * 0.14 * k, 0);
    P.add('head', -hz * 0.30 * k + sh * 0.05, -hx * 0.22 * k, -hx * 0.12 * k);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? L : R;
      const sg = s === 0 ? 1 : -1;
      P.add(`shoulder${side}`, -0.30 * k, 0, sg * (0.34 * k));
      P.add(`elbow${side}`, -(0.55 + 0.45 * k), 0, 0);
      P.add(`hip${side}`, 0.10 * k, 0, sg * 0.06 * k);
      P.add(`knee${side}`, 0.34 * k, 0, 0);
    }
  };
}

/** Keyframed collapse used when no physics ragdoll is available. */
export function bipedDeath(o = {}) {
  const back = o.backward ?? false;
  const sg = back ? -1 : 1;
  return (P, ph, ctx) => {
    // 0.00-0.20 buckle · 0.20-0.62 fall · 0.62-1.0 settle on the ground
    const buck = ease.out2(clamp01(ph / 0.20));
    const fall = ease.in2(clamp01((ph - 0.16) / 0.46));
    const set = ease.bounceOut(clamp01((ph - 0.60) / 0.40));
    const drop = fall * 0.86 + set * 0.10;
    const twitch = Math.max(0, 1 - (ph - 0.6) * 6) * Math.sin(ph * 40) * 0.02;

    P.add('root', sg * (0.30 * buck + 1.18 * fall), 0.22 * fall * (back ? -1 : 1), 0.10 * fall);
    P.move('root', 0, -(0.52 * drop) - 0.10 * buck, sg * 0.34 * fall);
    P.add('hips', sg * 0.26 * buck + 0.14 * fall, 0.10 * fall, 0.12 * fall);
    P.add('spine', -sg * 0.34 * buck + 0.30 * fall + twitch, -0.14 * fall, -0.16 * fall);
    P.add('chest', -sg * 0.30 * buck + 0.42 * fall, -0.18 * fall, -0.10 * fall);
    P.add('neck', 0.30 * buck + 0.34 * fall, 0.16 * fall, 0);
    P.add('head', 0.42 * buck + 0.50 * fall + twitch * 2, 0.26 * fall, 0.14 * fall);
    P.add('shoulder.L', -0.90 * buck - 0.55 * fall, 0.30 * fall, 0.85 * buck + 0.55 * fall);
    P.add('elbow.L', -(0.35 + 1.25 * buck) + 0.85 * fall, 0, 0);
    P.add('shoulder.R', -0.55 * buck - 0.35 * fall, -0.24 * fall, -(0.60 * buck + 0.75 * fall));
    P.add('elbow.R', -(0.30 + 0.95 * buck) + 0.60 * fall, 0, 0);
    P.add('hip.L', -0.30 * buck + 0.55 * fall, 0.16 * fall, 0.20 * fall);
    P.add('knee.L', 1.35 * buck + 0.45 * fall, 0, 0);
    P.add('hip.R', -0.14 * buck + 0.22 * fall, -0.20 * fall, -0.26 * fall);
    P.add('knee.R', 0.75 * buck + 1.05 * fall, 0, 0);
    P.add('ankle.L', -0.30 * fall, 0, 0);
    P.add('ankle.R', 0.24 * fall, 0, 0);
  };
}

/* ------------------------------------------------------------------ *
 * quadruped locomotion
 * ------------------------------------------------------------------ */

const QF = ['fHip', 'fKnee', 'fAnkle', 'fPaw'];
const QB = ['bHip', 'bKnee', 'bAnkle', 'bPaw'];

/** Transverse gallop — the fast, low, predatory gait. */
export function quadRun(o = {}) {
  const A = o.stride ?? 0.85, KB = o.knee ?? 1.05, bob = o.bob ?? 0.075;
  return (P, ph, ctx) => {
    const g = ctx.gait ?? 1;
    // gallop footfall order: bL, bR, fL, fR
    const off = [[QB, L, 0.00], [QB, R, 0.12], [QF, L, 0.45], [QF, R, 0.57]];
    for (const [set, side, po] of off) {
      const t = (ph + po) % 1;
      const front = set === QF;
      P.add(`${set[0]}${side}`, -A * g * Math.cos(t * TAU) * (front ? 1 : 1.12),
        0, (side === L ? 1 : -1) * 0.05);
      P.add(`${set[1]}${side}`,
        (front ? 1 : -1) * (KB * g * (0.95 * wpulse(t, 0.66, 0.32) + 0.20)), 0, 0);
      P.add(`${set[2]}${side}`,
        (front ? -1 : 1) * (0.55 * g * wpulse(t, 0.80, 0.26) + 0.16), 0, 0);
      P.add(`${set[3]}${side}`, (front ? 0.30 : -0.26) * g * wpulse(t, 0.52, 0.16), 0, 0);
    }
    // spine flexion/extension is what sells a gallop
    const flex = Math.sin(ph * TAU);
    P.move('root', 0, bob * g * Math.sin(ph * TAU * 2 - 0.6), 0);
    P.add('root', -0.06 * g * flex, 0, 0);
    P.add('spine1', 0.20 * g * flex, 0, 0.05 * Math.cos(ph * TAU));
    P.add('spine2', 0.24 * g * flex, 0, -0.05 * Math.cos(ph * TAU));
    P.add('chest', -0.14 * g * flex, 0, 0);
    P.add('neck1', -0.18 * g * flex - 0.10, 0.05 * Math.cos(ph * TAU), 0);
    P.add('neck2', -0.12 * g * flex, 0.06 * Math.cos(ph * TAU), 0);
    P.add('head', 0.16 * g * flex + 0.10, 0, 0);
    P.add('jaw', 0.24 + 0.14 * g * Math.max(0, flex), 0, 0);
    for (let i = 1; i <= 3; i++) {
      P.add(`tail${i}`, -0.16 + 0.14 * Math.sin((ph - i * 0.16) * TAU),
        0.34 * Math.sin((ph - i * 0.13) * TAU * 1.3), 0);
    }
  };
}

export function quadIdle(o = {}) {
  const br = o.breath ?? 0.05;
  return (P, ph) => {
    const b = Math.sin(ph * TAU);
    P.move('root', 0, br * 0.25 * b, 0);
    P.add('spine1', 0.03 * b, 0.02 * Math.sin(ph * TAU * 0.7), 0);
    P.add('spine2', -0.04 * b, 0, 0);
    P.add('chest', 0.05 * b, 0, 0);
    P.add('neck1', -0.16 - 0.04 * b, 0.10 * Math.sin(ph * TAU * 0.53), 0);
    P.add('neck2', -0.10, 0.12 * Math.sin(ph * TAU * 0.41 + 1.2), 0);
    P.add('head', 0.20 + 0.05 * b, 0.10 * Math.sin(ph * TAU * 0.33), 0.04 * b);
    P.add('jaw', 0.14 + 0.10 * Math.max(0, Math.sin(ph * TAU * 1.7)), 0, 0);
    for (const [set, side, sg] of [[QF, L, 1], [QF, R, -1], [QB, L, 1], [QB, R, -1]]) {
      const front = set === QF;
      P.add(`${set[0]}${side}`, front ? -0.06 : 0.08, 0, sg * 0.04);
      P.add(`${set[1]}${side}`, front ? 0.28 : -0.42, 0, 0);
      P.add(`${set[2]}${side}`, front ? -0.24 : 0.40, 0, 0);
      P.add(`${set[3]}${side}`, front ? 0.04 : -0.06, 0, 0);
    }
    for (let i = 1; i <= 3; i++) {
      P.add(`tail${i}`, -0.20, 0.26 * Math.sin((ph - i * 0.15) * TAU * 0.8), 0);
    }
  };
}

/** Pounce: crouch, launch, airborne extension, landing absorb. */
export function quadLeap(o = {}) {
  const h = o.height ?? 1;
  return (P, ph) => {
    const crouch = ease.out2(clamp01(ph / 0.26));
    const air = clamp01((ph - 0.26) / 0.46);
    const arc = Math.sin(air * Math.PI);
    const land = ease.out3(clamp01((ph - 0.72) / 0.28));
    const c = crouch * (1 - air);

    P.move('root', 0, (-0.16 * c + 0.72 * h * arc) - 0.10 * land * (1 - land), 0);
    P.add('root', -0.30 * c + 0.34 * arc - 0.22 * land, 0, 0);
    P.add('spine1', 0.26 * c - 0.30 * arc + 0.18 * land, 0, 0);
    P.add('spine2', 0.22 * c - 0.34 * arc + 0.14 * land, 0, 0);
    P.add('chest', -0.14 * c + 0.20 * arc, 0, 0);
    P.add('neck1', -0.26 * c - 0.16 * arc, 0, 0);
    P.add('head', 0.34 * c + 0.30 * arc, 0, 0);
    P.add('jaw', 0.18 + 0.62 * arc + 0.30 * c, 0, 0);
    for (const side of [L, R]) {
      P.add(`fHip${side}`, 0.62 * c - 1.05 * arc + 0.30 * land, 0, 0);
      P.add(`fKnee${side}`, 1.05 * c - 0.30 * arc + 0.55 * land, 0, 0);
      P.add(`fAnkle${side}`, -0.65 * c - 0.30 * arc - 0.35 * land, 0, 0);
      P.add(`fPaw${side}`, -0.25 * arc, 0, 0);
      P.add(`bHip${side}`, -0.75 * c + 0.85 * arc - 0.20 * land, 0, 0);
      P.add(`bKnee${side}`, -1.25 * c - 0.35 * arc - 0.60 * land, 0, 0);
      P.add(`bAnkle${side}`, 1.05 * c + 0.30 * arc + 0.50 * land, 0, 0);
    }
    for (let i = 1; i <= 3; i++) P.add(`tail${i}`, -0.34 * c + 0.30 * arc, 0.10, 0);
  };
}

export function quadHit(o = {}) {
  const amp = o.amp ?? 1;
  return (P, ph, ctx) => {
    const k = (1 - ease.out3(ph)) * amp;
    const hx = ctx.hitDir ? ctx.hitDir.x : 0;
    const sh = Math.sin(ph * 26) * Math.max(0, 1 - ph * 2.2);
    P.move('root', -hx * 0.06 * k, -0.07 * k, 0);
    P.add('root', 0.10 * k, hx * 0.20 * k, hx * 0.18 * k);
    P.add('spine1', 0.20 * k, -hx * 0.16 * k, -hx * 0.12 * k);
    P.add('spine2', 0.16 * k, -hx * 0.12 * k, 0);
    P.add('neck1', 0.26 * k + sh * 0.04, -hx * 0.24 * k, 0);
    P.add('head', 0.30 * k + sh * 0.06, -hx * 0.20 * k, 0);
    P.add('jaw', 0.50 * k, 0, 0);
    for (const side of [L, R]) {
      P.add(`fKnee${side}`, 0.36 * k, 0, 0);
      P.add(`bKnee${side}`, -0.34 * k, 0, 0);
    }
    for (let i = 1; i <= 3; i++) P.add(`tail${i}`, 0.20 * k, hx * 0.22 * k, 0);
  };
}

export function quadDeath() {
  return (P, ph) => {
    const buck = ease.out2(clamp01(ph / 0.18));
    const fall = ease.in2(clamp01((ph - 0.14) / 0.48));
    const set = ease.bounceOut(clamp01((ph - 0.58) / 0.42));
    const twitch = Math.max(0, 1 - (ph - 0.62) * 5.5) * Math.sin(ph * 44) * 0.03;
    P.move('root', 0.10 * fall, -(0.34 * fall + 0.04 * set), 0);
    P.add('root', 0, 0, 1.42 * fall + 0.10 * set);      // roll onto the flank
    P.add('spine1', 0.30 * buck + 0.22 * fall + twitch, 0.20 * fall, 0.16 * fall);
    P.add('spine2', 0.24 * buck + 0.16 * fall, 0.16 * fall, 0.12 * fall);
    P.add('neck1', -0.44 * buck - 0.30 * fall, 0.34 * fall, 0);
    P.add('neck2', -0.26 * fall, 0.20 * fall, 0);
    P.add('head', 0.30 * buck + 0.44 * fall + twitch * 2, 0.30 * fall, 0);
    P.add('jaw', 0.34 + 0.30 * fall, 0, 0);
    for (const side of [L, R]) {
      P.add(`fHip${side}`, -0.60 * fall, 0, 0);
      P.add(`fKnee${side}`, 1.15 * buck + 0.55 * fall, 0, 0);
      P.add(`bHip${side}`, 0.55 * fall, 0, 0);
      P.add(`bKnee${side}`, -1.30 * buck - 0.50 * fall, 0, 0);
    }
    for (let i = 1; i <= 3; i++) P.add(`tail${i}`, 0.20 * fall + twitch, 0.30 * fall, 0);
  };
}

/* ------------------------------------------------------------------ *
 * floating / robed
 * ------------------------------------------------------------------ */

/** Hover + trailing-tail sway. Shared by wraith and (partly) cultist. */
export function floatBody(o = {}) {
  const amp = o.amp ?? 0.09, rate = o.rate ?? 1, tails = o.tails ?? 5;
  const drift = o.drift ?? 0.09;
  return (P, ph, ctx) => {
    const v = ctx.gait ?? 0;
    const b = Math.sin(ph * TAU * rate);
    P.move('root', drift * 0.5 * Math.sin(ph * TAU * 0.63), amp * b, 0);
    P.add('root', 0.05 * b + v * 0.16, drift * 0.6 * Math.sin(ph * TAU * 0.41), 0.06 * Math.sin(ph * TAU * 0.77));
    P.add('hips', -0.06 * b, 0.10 * Math.sin(ph * TAU * 0.55), 0.05 * b);
    P.add('spine', 0.05 * b - v * 0.08, -0.08 * Math.sin(ph * TAU * 0.55), 0.04 * b);
    P.add('chest', -0.07 * b, 0.06 * Math.sin(ph * TAU * 0.72), -0.03 * b);
    P.add('neck', 0.04 * b, 0.10 * Math.sin(ph * TAU * 0.37), 0);
    P.add('head', -0.06 * b + 0.05, 0.16 * Math.sin(ph * TAU * 0.29 + 1.3), 0.03 * b);
    for (let i = 1; i <= tails; i++) {
      const lag = i * 0.17;
      const w = 0.10 + i * 0.055;
      P.add(`tail${i}`,
        0.10 + w * Math.sin((ph - lag) * TAU * rate) + v * 0.12,
        w * 1.5 * Math.sin((ph - lag * 1.3) * TAU * 0.7),
        w * 0.8 * Math.sin((ph - lag * 0.8) * TAU * 1.25));
    }
  };
}

/**
 * Small deterministic per-bone jitter — the skeleton's loose joints, the
 * wraith's shimmer. Driven by elapsed time, never Math.random.
 */
export function rattle(P, ctx, names, amp = 0.006, freq = 13, rot = 0) {
  const t = (ctx.elapsed ?? 0) * freq;
  const s = (ctx.seed ?? 0) | 0;
  for (let i = 0; i < names.length; i++) {
    const nx = noise3(t, i * 3.7, s * 0.013, 11) - 0.5;
    const ny = noise3(t + 5.1, i * 3.7, s * 0.013, 29) - 0.5;
    const nz = noise3(t + 9.3, i * 3.7, s * 0.013, 53) - 0.5;
    P.move(names[i], nx * amp * 2, ny * amp * 2, nz * amp * 2);
    if (rot) P.add(names[i], nx * rot * 2, ny * rot * 2, nz * rot * 2);
  }
}

export { clamp01, pulse, ease };
