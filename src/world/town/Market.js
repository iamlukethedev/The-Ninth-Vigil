/**
 * THE NINTH VIGIL — the market, the well, and the street furniture.
 *
 * This is the layer that carries craft density in the plaza — the thing the
 * captured `hub` frame had none of. Everything here is a composed set piece with
 * a reason to be where it is:
 *
 *  • **Stalls** are four crooked poles, a plank counter with goods laid out on
 *    it, and a genuinely sagging patched awning (see `awningGeo` — a flat quad
 *    canopy is one of the clearest tells of a procedural town). Cloth traders get
 *    bolts hung from the ridge pole, the butcher gets hooks and carcasses, the
 *    grain seller gets open sacks and a scoop.
 *  • **The well** is the plaza's secondary anchor: a coursed drum, a timber
 *    frame with a windlass, a bucket on a rope, and a wet apron of spilled water
 *    around its base.
 *  • **Lantern posts** are the town's street lighting. Every one gets a real
 *    glazed lantern with a candle inside it and the practical is placed AT that
 *    lantern, never in mid air.
 *  • **The anvil** stands in front of the smithy where the plan put the smith.
 */

import * as THREE from 'three';
import {
  Assembler, box, beam, board, awningGeo, latheGeo, mergeParts, xform, paintVertex,
  shingleRoof, tube, faceBoxUV, fbm3, clamp01, lerp,
} from './Geo.js';

const PI = Math.PI;

function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Awning cloth colours — two per stall, always desaturated + one warm accent. */
const CLOTHS = [
  [1.25, 0.62, 0.42], [0.72, 0.66, 0.86], [1.18, 1.02, 0.62],
  [0.58, 0.78, 0.72], [1.08, 0.72, 0.66], [0.82, 0.80, 0.74],
];

/* ------------------------------------------------------------------ *
 * stall
 * ------------------------------------------------------------------ */

function stall(S) {
  const A = new Assembler();
  const r = mulberry(S.seed);
  const span = S.span, depth = S.depth;
  const H = 2.18 + r() * 0.22;
  const hx = span * 0.5, hz = depth * 0.5;

  /* four poles, each leaning its own way — nothing a trader builds is plumb */
  const poles = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = poles[i];
    const h = H * (i < 2 ? 1 : 0.90);            // the back is lower, so it drains
    const lean = (r() - 0.5) * 0.09;
    A.add('timber', beam(h, 0.085 + r() * 0.02, 0.085, { seed: S.seed + i, seg: 1, bow: 0.014 }), {
      euler: [lean, r() * 3, (r() - 0.5) * 0.07],
      pos: [sx * hx, h * 0.5, sz * hz],
    });
    // a stone pad the pole stands on, so it does not spear the cobbles
    A.add('ashlar', box(0.24, 0.07, 0.24, 0.02), { rotY: r() * 3, pos: [sx * hx, 0.03, sz * hz] });
  }
  /* the ridge pole across the front and the lower one at the back */
  A.add('timber', beam(span + 0.24, 0.075, 0.075, { seed: S.seed + 11, seg: 1 }),
    { euler: [0, 0, PI * 0.5], pos: [0, H - 0.04, -hz] });
  A.add('timber', beam(span + 0.24, 0.07, 0.07, { seed: S.seed + 12, seg: 1 }),
    { euler: [0, 0, PI * 0.5], pos: [0, H * 0.90 - 0.04, hz] });

  /* the awning */
  const c0 = CLOTHS[(r() * CLOTHS.length) | 0];
  const aw = awningGeo(span + 0.3, depth + 0.34, {
    sag: 0.10 + r() * 0.07, sagAlong: 0.05 + r() * 0.05, ripple: 0.03 + r() * 0.02,
    segX: 13, segZ: 8, seed: S.seed + 21, valance: 0.13 + r() * 0.07,
    stripe: c0, stripeW: 0.30 + r() * 0.16,
  });
  // hang it from the back ridge, falling to the front
  A.add('awning', aw, { euler: [-0.075, 0, 0], pos: [0, H - 0.04, -hz - 0.14] });
  /* a patch: a second scrap of cloth lashed over a hole */
  if (r() < 0.6) {
    const c1 = CLOTHS[(r() * CLOTHS.length) | 0];
    A.add('awning', awningGeo(span * 0.34, depth * 0.4, {
      sag: 0.04, sagAlong: 0.02, ripple: 0.02, segX: 4, segZ: 3, seed: S.seed + 31,
      valance: 0.0, stripe: c1, stripeW: 0.22,
    }), { euler: [-0.075, 0, 0], pos: [(r() - 0.5) * span * 0.5, H + 0.02, -hz + depth * 0.25] });
  }

  /* the counter: trestles and a scrubbed plank top */
  const cy = 0.92;
  for (const sx of [-1, 1]) {
    A.add('timber', beam(cy, 0.075, 0.075, { seed: S.seed + 40 + sx, seg: 1 }), { euler: [0.1, 0, 0.12 * sx], pos: [sx * hx * 0.72, cy * 0.5, -0.05] });
    A.add('timber', beam(cy, 0.07, 0.07, { seed: S.seed + 45 + sx, seg: 1 }), { euler: [-0.1, 0, 0.12 * sx], pos: [sx * hx * 0.72, cy * 0.5, 0.42] });
    A.add('timber', beam(0.55, 0.055, 0.055, { seed: S.seed + 47 + sx, seg: 1 }), { euler: [PI * 0.5, 0, 0], pos: [sx * hx * 0.72, cy * 0.42, 0.18] });
  }
  const nb = 4;
  for (let i = 0; i < nb; i++) {
    A.add('plank', board(span * 0.92, (depth * 0.62) / nb * 0.94, 0.055, { seed: S.seed + 50 + i, cup: 0.12 }),
      { euler: [0, PI * 0.5, (r() - 0.5) * 0.02], pos: [0, cy + 0.03, -0.18 + (depth * 0.62 / nb) * i] });
  }
  // a plank front skirt that hides the trestles
  A.add('plank', board(span * 0.9, 0.44, 0.04, { seed: S.seed + 60, cup: 0.08 }),
    { euler: [PI * 0.5, PI * 0.5, 0], pos: [0, cy - 0.28, 0.42] });

  /* goods */
  const goods = S.goods;
  if (goods === 'cloth') {
    for (let i = 0; i < 5; i++) {
      const x = -hx * 0.8 + (hx * 1.6 / 4) * i;
      // bolts of cloth stacked on the counter
      A.add('awning', box(0.42 + r() * 0.14, 0.13, 0.2, 0.05), { euler: [0, r() * 0.4, 0], pos: [x, cy + 0.12 + (i % 2) * 0.13, 0.02] });
    }
    // lengths hanging from the ridge pole
    for (let i = 0; i < 3; i++) {
      const x = -hx * 0.6 + (hx * 1.2 / 2) * i;
      A.add('awning', awningGeo(0.4, 1.15, {
        sag: 0.02, sagAlong: 0.14, ripple: 0.05, segX: 4, segZ: 7, seed: S.seed + 70 + i,
        valance: 0.0, stripe: CLOTHS[(i * 2 + 1) % CLOTHS.length], stripeW: 0.19,
      }), { euler: [-PI * 0.5 + 0.08, 0, 0], pos: [x, H - 0.10, -hz + 0.08] });
    }
  } else if (goods === 'pots') {
    for (let i = 0; i < 7; i++) {
      const a = r() * 6.283;
      const rr = 0.10 + r() * 0.06;
      const g = latheGeo([[0.001, 0], [rr * 0.7, 0.01], [rr, 0.07], [rr * 0.85, 0.16], [rr * 0.55, 0.2], [rr * 0.62, 0.22]],
        { seg: 10, uTile: 1, seed: S.seed + i, lobeAmt: 0.008, capBottom: true });
      A.add('ashlar', g, { rotY: a, pos: [-hx * 0.8 + (hx * 1.6 / 6) * i, cy + 0.06, -0.02 + (i % 2) * 0.2] });
    }
  } else if (goods === 'meat') {
    for (let i = 0; i < 3; i++) {
      const x = -hx * 0.55 + (hx * 1.1 / 2) * i;
      A.add('iron', xform(faceUV(new THREE.TorusGeometry(0.05, 0.011, 5, 10)), { euler: [PI * 0.5, 0, 0] }), { pos: [x, H - 0.14, -hz + 0.1] });
      // a hung carcass, approximated as a tapered sack of meat
      A.add('awning', tube([
        { x: 0, y: 0, z: 0, r: 0.09 }, { x: 0.01, y: -0.22, z: 0.01, r: 0.15 },
        { x: 0, y: -0.5, z: 0, r: 0.13 }, { x: -0.01, y: -0.72, z: 0, r: 0.07 },
      ], { radial: 8, uTile: 1, capEnd: true, closeStart: true, seed: S.seed + i }), { pos: [x, H - 0.2, -hz + 0.1] });
    }
    A.add('iron', box(0.28, 0.02, 0.22, 0.006), { euler: [0, 0.3, 0], pos: [hx * 0.5, cy + 0.06, 0.08] });
  } else {
    // grain: open sacks with a scoop, and a bushel measure
    for (let i = 0; i < 4; i++) {
      const x = -hx * 0.7 + (hx * 1.4 / 3) * i;
      A.add('awning', tube([
        { x: 0, y: 0, z: 0, r: 0.19 }, { x: 0, y: 0.16, z: 0, r: 0.21 },
        { x: 0.01, y: 0.34, z: 0, r: 0.17 }, { x: 0.02, y: 0.42, z: 0.01, r: 0.13 },
      ], { radial: 9, uTile: 1, capEnd: true, closeStart: true, seed: S.seed + 80 + i }),
        { pos: [x, 0.02, hz + 0.32 + (i % 2) * 0.12] });
    }
    A.add('plank', latheGeo([[0.001, 0], [0.16, 0.005], [0.17, 0.22], [0.165, 0.23]], { seg: 10, uTile: 1, seed: S.seed + 90, capBottom: true }),
      { pos: [hx * 0.4, cy + 0.05, 0.05] });
  }

  /* crates and a barrel tucked under the counter */
  for (let i = 0; i < 2 + ((r() * 2) | 0); i++) {
    const s0 = 0.42 + r() * 0.16;
    A.add('plank', box(s0, s0 * 0.86, s0 * 0.9, 0.02), {
      rotY: r() * 3, pos: [(r() - 0.5) * span * 0.8, s0 * 0.43, hz + 0.3 + r() * 0.5],
    });
  }

  return A;
}

/* ------------------------------------------------------------------ *
 * well
 * ------------------------------------------------------------------ */

function well(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 61);
  const R = 0.86;

  /* the drum: three courses of coursed stone, each rotated, plus a coping */
  for (let c = 0; c < 3; c++) {
    const n = 13;
    const parts = [];
    const y = 0.16 + c * 0.24;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283 + c * 0.24;
      const rr = R * (0.985 + (fbm3(i * 1.7, c * 2.1, 3, { octaves: 1, seed: 7 }) - 0.5) * 0.04);
      parts.push(xform(box(0.30, 0.235, 0.30, 0.03), { rotY: -a, pos: [Math.cos(a) * rr, y, Math.sin(a) * rr] }));
    }
    A.add('ashlar', mergeParts(parts));
  }
  A.add('ashlar', latheGeo([[R * 0.82, 0], [R * 1.12, 0.0], [R * 1.14, 0.10], [R * 0.80, 0.11], [R * 0.80, 0.0]],
    { seg: 22, uTile: 1, seed: 11, lobeAmt: 0.012 }), { pos: [0, 0.86, 0] });
  // a wet, mossy apron of spilled water
  A.add('ashlar', latheGeo([[R * 1.05, 0], [R * 1.9, 0.005], [R * 1.95, 0.02]], { seg: 20, uTile: 1, seed: 13, lobeAmt: 0.04 }), { pos: [0, 0.012, 0] });

  /* the frame: two crooked posts, a tie beam, a shingled hood */
  for (const sx of [-1, 1]) {
    A.add('timber', beam(2.25, 0.14, 0.14, { seed: 20 + sx, seg: 1, bow: 0.02 }), {
      euler: [0, 0, sx * 0.035], pos: [sx * (R * 0.92), 1.12, 0],
    });
  }
  A.add('timber', beam(R * 2.3, 0.13, 0.13, { seed: 24, seg: 1 }), { euler: [0, 0, PI * 0.5], pos: [0, 2.2, 0] });
  A.add('shingle', shingleRoof(R * 2.7, 0.72, { course: 0.2, shake: 0.24, step: 0.024, thick: 0.04, seed: 26 }),
    { euler: [-0.62, 0, 0], pos: [0, 2.28, -0.42] });
  A.add('shingle', shingleRoof(R * 2.7, 0.72, { course: 0.2, shake: 0.24, step: 0.024, thick: 0.04, seed: 27 }),
    { euler: [0.62, PI, 0], pos: [0, 2.28, 0.42] });

  /* windlass: a barrel of wood on an iron spindle, with a crank handle */
  A.add('timber', latheGeo([[0.001, 0], [0.10, 0.02], [0.105, 0.3], [0.10, 1.28], [0.001, 1.3]], { seg: 10, uTile: 1, seed: 30, lobeAmt: 0.006 }),
    { euler: [0, 0, PI * 0.5], pos: [-R * 0.65, 1.86, 0] });
  A.add('iron', box(0.035, 0.035, 0.035, 0.008), { pos: [R * 0.78, 1.86, 0] });
  A.add('iron', box(0.05, 0.34, 0.05, 0.012), { pos: [R * 0.95, 1.78, 0] });
  A.add('timber', beam(0.24, 0.05, 0.05, { seed: 33, seg: 1 }), { euler: [PI * 0.5, 0, 0], pos: [R * 0.95, 1.62, 0] });

  /* rope + bucket, hanging into the shaft */
  A.add('awning', tube([
    { x: 0, y: 1.82, z: 0, r: 0.018 }, { x: 0.005, y: 1.3, z: 0.004, r: 0.017 },
    { x: 0, y: 0.9, z: 0, r: 0.017 },
  ], { radial: 6, uTile: 1, seed: 35 }), { pos: [0.1, 0, 0] });
  A.add('plank', latheGeo([[0.001, 0], [0.14, 0.01], [0.155, 0.06], [0.165, 0.24], [0.155, 0.25], [0.14, 0.24]],
    { seg: 12, uTile: 1, seed: 37, lobeAmt: 0.006, capBottom: true }), { pos: [0.1, 0.62, 0] });
  A.add('iron', box(0.33, 0.022, 0.026, 0.006), { pos: [0.1, 0.87, 0] });

  /* the dark of the shaft — a plain black disc reads as depth for free */
  A.add('glow:shaft', latheGeo([[0.001, 0], [R * 0.76, 0]], { seg: 18, uTile: 1, seed: 39 }), { pos: [0, 0.30, 0] });

  /* a pail and a puddle-darkened stone left by the well */
  A.add('plank', latheGeo([[0.001, 0], [0.11, 0.01], [0.12, 0.2], [0.115, 0.21]], { seg: 10, uTile: 1, seed: 41, capBottom: true }),
    { rotY: r() * 3, pos: [R * 1.4, 0.02, -R * 0.9] });
  void clamp01;
  return A;
}

/* ------------------------------------------------------------------ *
 * street furniture
 * ------------------------------------------------------------------ */

function noticeBoard(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 71);
  for (const sx of [-1, 1]) {
    A.add('timber', beam(2.3, 0.11, 0.11, { seed: 80 + sx, seg: 1 }), { euler: [0, 0, sx * 0.02], pos: [sx * 0.62, 1.15, 0] });
  }
  // the board: five boards nailed to two ledgers
  for (let i = 0; i < 5; i++) {
    A.add('plank', board(1.42, 0.24, 0.045, { seed: 90 + i, cup: 0.1 }),
      { euler: [0, PI * 0.5, (r() - 0.5) * 0.02], pos: [0, 1.28 + i * 0.245, 0.06] });
  }
  A.add('timber', beam(1.3, 0.07, 0.05, { seed: 96, seg: 1 }), { euler: [0, 0, PI * 0.5], pos: [0, 1.35, -0.02] });
  A.add('timber', beam(1.3, 0.07, 0.05, { seed: 97, seg: 1 }), { euler: [0, 0, PI * 0.5], pos: [0, 2.2, -0.02] });
  // a shingled hood so the notices survive the weather
  A.add('shingle', shingleRoof(1.66, 0.44, { course: 0.18, shake: 0.22, step: 0.022, thick: 0.035, seed: 98 }),
    { euler: [-0.55, 0, 0], pos: [0, 2.5, -0.18] });
  // nailed notices: pale scraps of vellum at all angles, one curling off
  for (let i = 0; i < 7; i++) {
    const w = 0.2 + r() * 0.14, h = 0.24 + r() * 0.16;
    const g = box(w, h, 0.008, 0.002);
    paintVertex(g, (x, y, z, nx, ny, nz, out) => {
      const k = 1.9 + (y / h) * 0.25;            // bleached vellum on the cloth material
      out[0] = k * 1.02; out[1] = k * 0.97; out[2] = k * 0.82;
    });
    A.add('awning', g, {
      euler: [(r() - 0.5) * 0.25, 0, (r() - 0.5) * 0.4],
      pos: [(r() - 0.5) * 1.1, 1.4 + r() * 1.0, 0.092],
    });
  }
  // a wax-sealed writ and a dagger stuck through one of them
  A.add('iron', box(0.03, 0.22, 0.012, 0.004), { euler: [0.2, 0, 0.3], pos: [0.35, 2.05, 0.14] });
  return A;
}

function trough(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 73);
  A.add('ashlar', box(1.9, 0.52, 0.7, 0.05, 2), { pos: [0, 0.26, 0] });
  A.add('ashlar', box(1.66, 0.14, 0.48, 0.03), { pos: [0, 0.5, 0] });
  A.add('glow:shaft', box(1.62, 0.03, 0.44, 0.01), { pos: [0, 0.47, 0] });
  for (let i = 0; i < 3; i++) {
    A.add('ashlar', box(0.24 + r() * 0.1, 0.16, 0.2, 0.04), { rotY: r() * 3, pos: [(r() - 0.5) * 2.4, 0.05, (r() - 0.5) * 1.6] });
  }
  return A;
}

/** A hand cart with sacks and a broken spoke, tipped onto its shafts. */
function cartload(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 79);
  const bedY = 0.72;
  // bed
  for (let i = 0; i < 5; i++) {
    A.add('plank', board(1.9, 0.24, 0.05, { seed: 100 + i, cup: 0.1 }), { euler: [0, PI * 0.5, 0], pos: [0, bedY, -0.5 + i * 0.25] });
  }
  // sides
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      A.add('plank', board(1.9, 0.24, 0.04, { seed: 110 + i + sz, cup: 0.08 }),
        { euler: [PI * 0.5, PI * 0.5, 0], pos: [0, bedY + 0.16 + i * 0.24, sz * 0.62] });
    }
  }
  A.add('timber', beam(1.95, 0.1, 0.1, { seed: 120, seg: 1 }), { euler: [0, 0, PI * 0.5], pos: [0, bedY - 0.08, -0.5] });
  A.add('timber', beam(1.95, 0.1, 0.1, { seed: 121, seg: 1 }), { euler: [0, 0, PI * 0.5], pos: [0, bedY - 0.08, 0.5] });
  A.add('iron', box(1.66, 0.07, 0.07, 0.014), { pos: [0, 0.47, 0] });    // the axle
  // shafts, dropped so their ends rest on the road
  for (const sz of [-1, 1]) {
    A.add('timber', beam(1.9, 0.085, 0.085, { seed: 130 + sz, seg: 1 }),
      { euler: [0, 0, PI * 0.5 - 0.34], pos: [-1.5, bedY - 0.36, sz * 0.42] });
  }
  A.add('timber', beam(0.9, 0.07, 0.07, { seed: 135, seg: 1 }), { euler: [PI * 0.5, 0, 0], pos: [-2.28, bedY - 0.66, 0] });
  // wheels: the torus already lies in XY with its axis on Z, which is the axle
  for (const sz of [-1, 1]) {
    const W = new Assembler();
    W.add('timber', faceUV(new THREE.TorusGeometry(0.44, 0.055, 6, 18)));
    W.add('iron', faceUV(new THREE.TorusGeometry(0.475, 0.022, 5, 22)));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * PI;
      W.add('timber', box(0.05, 0.86, 0.05, 0.012), { euler: [0, 0, a] });
    }
    W.add('timber', box(0.16, 0.16, 0.22, 0.03));
    A.absorb(W, { pos: [0, 0.47, sz * 0.72] });
  }
  // load: sacks and a barrel
  for (let i = 0; i < 4; i++) {
    A.add('awning', tube([
      { x: 0, y: 0, z: 0, r: 0.17 }, { x: 0, y: 0.15, z: 0, r: 0.2 },
      { x: 0.02, y: 0.34, z: 0.01, r: 0.15 }, { x: 0.03, y: 0.42, z: 0.02, r: 0.09 },
    ], { radial: 8, uTile: 1, capEnd: true, closeStart: true, seed: 140 + i }),
      { rotY: r() * 3, pos: [(r() - 0.5) * 1.3, bedY + 0.04, (r() - 0.5) * 0.7] });
  }
  A.add('plank', latheGeo([[0.001, 0], [0.22, 0.02], [0.27, 0.2], [0.27, 0.5], [0.22, 0.68], [0.001, 0.7]],
    { seg: 12, uTile: 1, seed: 150, lobeAmt: 0.005 }), { euler: [0, 0, 1.45], pos: [0.6, bedY + 0.3, 0.1] });
  return A;
}

function woodstack(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 83);
  const rows = 5, per = 7;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < per; i++) {
      if (r() < 0.08) continue;
      const rr = 0.055 + r() * 0.035;
      const len = 0.72 + r() * 0.12;
      A.add('timber', latheGeo([[0.001, 0], [rr, 0.008], [rr * 0.96, len - 0.008], [0.001, len]],
        { seg: 7, uTile: 1, seed: 160 + j * 10 + i, lobeAmt: 0.02, lobes: 4 }), {
        euler: [PI * 0.5 + (r() - 0.5) * 0.05, (r() - 0.5) * 0.1, 0],
        pos: [-0.7 + i * 0.23 + (j % 2) * 0.06, 0.06 + j * 0.115, (r() - 0.5) * 0.08 - len * 0.5 + 0.36],
      });
    }
  }
  // two uprights holding the stack in
  for (const sx of [-1, 1]) {
    A.add('timber', beam(0.9, 0.08, 0.08, { seed: 200 + sx, seg: 1 }), { euler: [0, 0, sx * 0.05], pos: [sx * 0.92, 0.45, 0.3] });
  }
  // a chopping block with an axe in it
  A.add('timber', latheGeo([[0.001, 0], [0.26, 0.01], [0.27, 0.42], [0.24, 0.44]], { seg: 10, uTile: 1, seed: 210, lobeAmt: 0.02 }),
    { pos: [1.35, 0.02, -0.3] });
  A.add('timber', beam(0.62, 0.045, 0.035, { seed: 211, seg: 1 }), { euler: [0.9, 0.4, 0], pos: [1.35, 0.66, -0.24] });
  A.add('iron', box(0.06, 0.17, 0.12, 0.02), { euler: [0.9, 0.4, 0], pos: [1.33, 0.44, -0.34] });
  return A;
}

/** A lantern post: iron standard, glazed lantern, candle, and its practical. */
function lanternPost(L) {
  const A = new Assembler();
  const r = mulberry(L.seed ?? 91);
  const h = L.h ?? 3.2;
  // stone socket + iron standard, tapering
  A.add('ashlar', box(0.34, 0.30, 0.34, 0.04), { rotY: r() * 3, pos: [0, 0.11, 0] });
  A.add('iron', latheGeo([[0.001, 0], [0.065, 0.03], [0.055, 0.4], [0.042, h * 0.7], [0.036, h]],
    { seg: 8, uTile: 1, seed: 92, lobeAmt: 0.004 }), { pos: [0, 0.2, 0] });
  // a scrolled arm and a collar
  A.add('iron', box(0.34, 0.028, 0.028, 0.008), { euler: [0, 0, -0.28], pos: [0.14, h * 0.94, 0] });
  A.add('iron', box(0.09, 0.05, 0.09, 0.012), { pos: [0, h * 0.62, 0] });
  // the lantern: an iron cage with four glazed panes and a conical cap
  const ly = 0.2 + h - 0.12;
  const lw = 0.20;
  for (const [ax, az] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    A.add('iron', box(0.022, 0.30, 0.022, 0.006), { pos: [ax * lw * 0.5, ly, az * lw * 0.5] });
  }
  A.add('iron', box(lw + 0.05, 0.035, lw + 0.05, 0.008), { pos: [0, ly - 0.16, 0] });
  A.add('iron', latheGeo([[lw * 0.86, 0], [lw * 0.7, 0.07], [0.03, 0.14], [0.02, 0.2]], { seg: 8, uTile: 1, seed: 94 }),
    { pos: [0, ly + 0.15, 0] });
  A.add('glow:lamp', box(lw * 0.88, 0.26, lw * 0.88, 0.01), { pos: [0, ly, 0] });
  // the candle stub inside, so the glow has an actual source
  A.add('glow:lamp', box(0.032, 0.09, 0.032, 0.008), { pos: [0, ly - 0.09, 0] });
  return { A, light: { y: ly, r: 0 } };
}

/** The smith's anvil on its elm stump, with tongs and a slack tub. */
function anvil(P) {
  const A = new Assembler();
  const r = mulberry(P.seed ?? 97);
  A.add('timber', latheGeo([[0.001, 0], [0.28, 0.02], [0.30, 0.5], [0.27, 0.52]], { seg: 11, uTile: 1, seed: 98, lobeAmt: 0.025, lobes: 6 }),
    { pos: [0, 0, 0] });
  // the anvil: base, waist, face, horn
  A.add('iron', box(0.34, 0.09, 0.26, 0.02), { pos: [0, 0.565, 0] });
  A.add('iron', box(0.18, 0.13, 0.16, 0.02), { pos: [0, 0.665, 0] });
  A.add('iron', box(0.52, 0.11, 0.22, 0.022), { pos: [0.02, 0.78, 0] });
  A.add('iron', latheGeo([[0.10, 0], [0.075, 0.12], [0.03, 0.24], [0.012, 0.3]], { seg: 8, uTile: 1, seed: 99 }),
    { euler: [0, 0, -PI * 0.5], pos: [0.3, 0.78, 0] });
  // hammer on the face, tongs leaning on the stump
  A.add('timber', beam(0.34, 0.03, 0.03, { seed: 100, seg: 1 }), { euler: [PI * 0.46, 0.4, 0], pos: [-0.1, 0.86, 0.06] });
  A.add('iron', box(0.11, 0.06, 0.06, 0.014), { pos: [0.02, 0.87, -0.02] });
  A.add('iron', box(0.022, 0.6, 0.022, 0.006), { euler: [0.35, 0.2, 0.12], pos: [-0.34, 0.4, 0.16] });
  A.add('iron', box(0.022, 0.6, 0.022, 0.006), { euler: [0.35, 0.2, -0.02], pos: [-0.3, 0.4, 0.19] });
  // slack tub
  A.add('plank', latheGeo([[0.001, 0], [0.24, 0.02], [0.26, 0.2], [0.25, 0.42], [0.22, 0.44]],
    { seg: 12, uTile: 1, seed: 101, lobeAmt: 0.006 }), { pos: [-0.72, 0, -0.42] });
  A.add('iron', xform(faceUV(new THREE.TorusGeometry(0.255, 0.014, 4, 16)), { euler: [PI * 0.5, 0, 0] }), { pos: [-0.72, 0.34, -0.42] });
  A.add('glow:shaft', latheGeo([[0.001, 0], [0.23, 0]], { seg: 14, uTile: 1, seed: 102 }), { pos: [-0.72, 0.36, -0.42] });
  // scattered clinker
  for (let i = 0; i < 6; i++) {
    A.add('glow:coal', box(0.05 + r() * 0.04, 0.03, 0.05 + r() * 0.03, 0.012), { rotY: r() * 3, pos: [(r() - 0.5) * 1.6, 0.015, (r() - 0.5) * 1.4] });
  }
  return A;
}

/* ------------------------------------------------------------------ *
 * entry point
 * ------------------------------------------------------------------ */

export function buildMarket(A, { plan, probe, seed = 1 }) {
  const lights = [];
  const smoke = [];

  for (const S of plan.stalls) {
    try { A.absorb(stall(S), { rotY: S.rotY, pos: [S.x, S.y - 0.02, S.z] }); }
    catch (e) { console.error('[town] stall', e); }
  }

  for (const P of plan.props) {
    try {
      let sub = null;
      if (P.key === 'well') sub = well(P);
      else if (P.key === 'notice') sub = noticeBoard(P);
      else if (P.key === 'trough') sub = trough(P);
      else if (P.key === 'cartload') sub = cartload(P);
      else if (P.key === 'woodstack') sub = woodstack(P);
      if (sub) A.absorb(sub, { rotY: P.rotY ?? 0, pos: [P.x, P.y - 0.02, P.z] });
    } catch (e) { console.error(`[town] prop ${P.key}`, e); }
  }

  if (plan.smithAnvil) {
    try {
      const S = plan.smithAnvil;
      A.absorb(anvil(S), { rotY: S.rotY ?? 0, pos: [S.x, probe.heightAt(S.x, S.z) - 0.02, S.z] });
    } catch (e) { console.error('[town] anvil', e); }
  }

  for (const L of plan.lanterns) {
    try {
      const out = lanternPost(L);
      A.absorb(out.A, { rotY: L.rotY ?? 0, pos: [L.x, L.y - 0.02, L.z] });
      /*
       * Street lanterns are the town's fill light and they were losing every
       * pool slot. Lighting scores a practical as `priority * angular^1.35 *
       * (0.35 + min(reach,12))`, and at 8.5/11 m against the moor preset's own
       * 1.4-1.6-priority torches these came 20th of 29 for 14 slots, so the
       * plaza had no fill at all. A street lantern in a settlement outranks
       * scenery fire: 2.05 puts them just under the gate braziers and the forge.
       */
      lights.push({
        kind: 'lantern', x: L.x, y: L.y + out.light.y, z: L.z,
        color: 0xffb066, intensity: 15, radius: 13.5, flicker: 0.3,
        type: 'candle', priority: 2.05, shadow: false,
      });
    } catch (e) { console.error('[town] lantern', e); }
  }

  void seed; void lerp;
  return { lights, smoke };
}

/* helpers */
function faceUV(geo) { const out = faceBoxUV(geo, 1); if (out !== geo) geo.dispose(); return out; }

export { stall, well, noticeBoard, lanternPost, anvil };
