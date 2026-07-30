/**
 * THE NINTH VIGIL — macabre dressing.
 *
 * What a crypt, a charnel arena and a moor graveyard are actually made of: bone
 * that has been *stacked* rather than dropped, cages that held someone, altars
 * that have been used, and sigils that are still warm.
 *
 * The bone here is deliberately anatomical enough to read — a skull has sockets
 * and a nasal aperture painted into its vertex colour, a ribcage has a spine
 * with vertebrae and ribs that spring from it, a femur has condyles at both
 * ends. Rounded white blobs read as pebbles, and pebbles are not frightening.
 */

import * as THREE from 'three';
import {
  tube, latheGeo, shardGeo, rockGeo, mergeParts, xform, finish, bakeWear,
  paintVertex, clamp01, smooth01, lerp,
} from './Geo.js';
import { PartSet, ringGeo, plate, bar } from './Fixtures.js';

const TAU = Math.PI * 2;

/* ================================================================== *
 * anatomy primitives
 * ================================================================== */

/**
 * A skull, facing +Z. Sockets, nasal aperture and the shadowed underside of the
 * zygomatic are painted into vertex colour — three real dark features for the
 * price of no extra geometry, which is what makes a 9 cm prop read at 28 m.
 */
export function skullGeo(rand, seed, size = 0.092, jawOpen = 0.0) {
  const parts = [];
  const cran = rockGeo({
    radius: size, detail: 2, warp: 0.13, warpFreq: 1.05,
    squash: [0.88, 0.96, 1.14], flatten: 0.1, chip: 0.05,
    seed, uTile: 1, shear: 0.04,
  });
  /* taper the front into a muzzle so it is not an egg */
  {
    const p = cran.attributes.position.array;
    for (let i = 0, n = cran.attributes.position.count; i < n; i++) {
      const o = i * 3;
      const fz = clamp01((p[o + 2] / size) * 0.85 + 0.15);
      const k = lerp(1, 0.72, fz * fz);
      p[o] *= k;
      if (p[o + 1] > 0) p[o + 1] *= lerp(1, 0.86, fz);
    }
    cran.computeVertexNormals();
  }
  paintVertex(cran, (x, y, z, nx, ny, nz, out) => {
    const front = clamp01(nz * 1.15);
    // orbits
    const ox = Math.abs(x) - size * 0.34;
    const oy = y - size * 0.06;
    const orbit = 1 - smooth01(size * 0.05, size * 0.32, Math.hypot(ox, oy));
    // nasal aperture
    const nas = 1 - smooth01(size * 0.02, size * 0.17, Math.hypot(x * 1.5, y + size * 0.3));
    // temporal hollow
    const tem = clamp01(Math.abs(nx)) * (1 - smooth01(size * 0.1, size * 0.5, Math.hypot(y - size * 0.18, z - size * 0.25)));
    let k = 1 - 0.74 * orbit * front - 0.6 * nas * front - 0.2 * tem;
    if (k < 0.1) k = 0.1;
    out[0] = k; out[1] = k * 0.985; out[2] = k * 0.95;
  });
  parts.push(cran);

  /* mandible: a shallow U hung under the muzzle, sometimes agape */
  const jaw = [];
  for (const sgn of [-1, 1]) {
    const sp = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const a = -0.55 + t * 1.5;
      sp.push({
        x: sgn * Math.sin(a) * size * 0.52,
        y: -size * 0.42 - jawOpen * size * 0.5 + Math.sin(t * Math.PI) * size * 0.05,
        z: size * (0.72 - t * 1.05),
        r: size * (0.10 - t * 0.035),
      });
    }
    const g = tube(sp, { radial: 5, uTile: 1 / 0.3, lobes: 3, lobeAmt: 0.14, seed: seed + 3, closeStart: true });
    if (g) jaw.push(g);
  }
  /* upper teeth row: a few square blocks, only readable up close but free */
  for (let i = 0; i < 5; i++) {
    const t = (i / 4 - 0.5);
    const g = shardGeo({
      w: size * 0.09, h: size * 0.1, d: size * 0.07,
      seed: seed + 20 + i, seg: 1, rough: 0.2, uTile: 1, bevel: size * 0.02,
    });
    xform(g, { pos: [t * size * 0.5, -size * 0.34, size * 0.6 - Math.abs(t) * size * 0.16] });
    jaw.push(g);
  }
  const jm = mergeParts(jaw);
  if (jm) parts.push(jm);
  const out = mergeParts(parts);
  void rand;
  return out;
}

/** A long bone with condyles at both ends. Femur, humerus, tibia. */
export function longBone(seed, len = 0.42, r = 0.019, bow = 0.03) {
  const sp = [];
  const n = 7;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    // shaft thin in the middle, knobbed at the epiphyses
    const knob = Math.pow(Math.abs(t * 2 - 1), 2.6);
    sp.push({
      x: (t - 0.5) * len,
      y: Math.sin(t * Math.PI) * bow,
      z: Math.sin(t * 3.1 + seed * 0.3) * len * 0.012,
      r: r * (0.78 + knob * 1.25),
    });
  }
  return tube(sp, { radial: 6, uTile: 1 / 0.3, lobes: 3, lobeAmt: 0.13, seed, closeStart: true });
}

/** A rib: a flattened arc. */
function ribGeo(seed, len = 0.3, r = 0.011, sweep = 1.25) {
  const sp = [];
  const n = 6;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const a = t * sweep;
    sp.push({
      x: Math.sin(a) * len,
      y: -t * len * 0.42,
      z: (1 - Math.cos(a)) * len * 0.62,
      r: r * (1 - t * 0.42),
    });
  }
  const g = tube(sp, { radial: 4, uTile: 1 / 0.3, lobes: 3, lobeAmt: 0.1, seed, closeStart: true });
  if (g) xform(g, { scale: [1, 1, 0.72] });
  return g;
}

/* ================================================================== *
 * bone piles and scatters
 * ================================================================== */

export function bonePile(rand, index = 0) {
  const P = new PartSet();
  const seed = 9600 + index * 149;
  const R = [0.55, 0.85, 0.4][index % 3];
  const bones = [];

  const nLong = [7, 12, 5][index % 3];
  for (let i = 0; i < nLong; i++) {
    const a = rand() * TAU;
    const d = Math.pow(rand(), 0.55) * R;
    const g = longBone(seed + i * 7, 0.28 + rand() * 0.24, 0.015 + rand() * 0.008, 0.02 + rand() * 0.03);
    if (!g) continue;
    xform(g, {
      pos: [Math.cos(a) * d, 0.022 + rand() * R * 0.42, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 1.1, rand() * TAU, (rand() - 0.5) * 1.1],
    });
    bones.push(g);
  }
  for (let i = 0; i < nLong; i++) {
    const a = rand() * TAU;
    const d = Math.pow(rand(), 0.5) * R * 1.15;
    const g = ribGeo(seed + 60 + i, 0.16 + rand() * 0.16, 0.009 + rand() * 0.005, 1.0 + rand() * 0.7);
    if (!g) continue;
    xform(g, {
      pos: [Math.cos(a) * d, 0.02 + rand() * R * 0.3, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 1.6, rand() * TAU, (rand() - 0.5) * 1.6],
    });
    bones.push(g);
  }
  /* a couple of skulls, because a heap of sticks is not a bone pile */
  const nSk = index % 3 === 1 ? 3 : 2;
  for (let i = 0; i < nSk; i++) {
    const a = rand() * TAU;
    const d = Math.pow(rand(), 0.7) * R * 0.7;
    const g = skullGeo(rand, seed + 200 + i * 13, 0.082 + rand() * 0.018, rand() * 0.4);
    if (!g) continue;
    xform(g, {
      pos: [Math.cos(a) * d, 0.075 + rand() * R * 0.32, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 1.5, rand() * TAU, (rand() - 0.5) * 1.2],
    });
    bones.push(g);
  }
  /* bone dust and chips settling round the base */
  for (let i = 0; i < 8; i++) {
    const a = rand() * TAU, d = R * (0.7 + rand() * 0.65);
    const g = shardGeo({
      w: 0.03 + rand() * 0.05, h: 0.012 + rand() * 0.014, d: 0.02 + rand() * 0.04,
      seed: seed + 300 + i, seg: 1, rough: 0.35, uTile: 1, bevel: 0.006,
    });
    xform(g, { pos: [Math.cos(a) * d, 0.012, Math.sin(a) * d], euler: [(rand() - 0.5) * 0.8, rand() * TAU, (rand() - 0.5) * 0.8] });
    bones.push(g);
  }
  const m = mergeParts(bones);
  if (m) P.add(index % 2 ? 'boneOld' : 'bone', m, { cast: true });
  return P.build(seed);
}

export function skullScatter(rand, index = 0) {
  const P = new PartSet();
  const seed = 9700 + index * 151;
  const n = [2, 4, 1][index % 3];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = rand() * TAU;
    const d = i === 0 ? 0 : 0.12 + rand() * 0.3;
    const g = skullGeo(rand, seed + i * 17, 0.086 + rand() * 0.02, rand() * 0.55);
    if (!g) continue;
    // resting on the cranium, on its side, or face down — never all upright
    const pose = rand();
    xform(g, {
      pos: [Math.cos(a) * d, 0.062 + rand() * 0.01, Math.sin(a) * d],
      euler: [pose < 0.4 ? 0.15 : pose < 0.7 ? 1.4 : 2.7, rand() * TAU, (rand() - 0.5) * 0.8],
    });
    parts.push(g);
  }
  for (let i = 0; i < n + 2; i++) {
    const a = rand() * TAU, d = 0.15 + rand() * 0.4;
    const g = longBone(seed + 50 + i, 0.2 + rand() * 0.2, 0.013 + rand() * 0.006, 0.02);
    if (!g) continue;
    xform(g, { pos: [Math.cos(a) * d, 0.02, Math.sin(a) * d], euler: [(rand() - 0.5) * 0.3, rand() * TAU, (rand() - 0.5) * 0.3] });
    parts.push(g);
  }
  const m = mergeParts(parts);
  if (m) P.add(index % 2 ? 'bone' : 'boneOld', m, { cast: true });
  return P.build(seed);
}

/** A ribcage, half collapsed, half sunk. The most recognisable bone silhouette. */
export function ribcage(rand, index = 0) {
  const P = new PartSet();
  const seed = 9800 + index * 157;
  const parts = [];
  const nRib = 8;
  const spineLen = 0.62;

  /* spine: a tube with a vertebra bump at each rib */
  const sp = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    sp.push({
      x: (t - 0.5) * spineLen,
      y: 0.3 - Math.pow(t - 0.35, 2) * 0.45,
      z: Math.sin(t * 3) * 0.02,
      r: 0.022 + Math.abs(Math.sin(t * 10.5)) * 0.009,
    });
  }
  const spine = tube(sp, { radial: 6, uTile: 1 / 0.3, lobes: 4, lobeAmt: 0.2, seed, closeStart: true });
  if (spine) parts.push(spine);

  for (let i = 0; i < nRib; i++) {
    const t = 0.12 + (i / (nRib - 1)) * 0.66;
    const at = sp[Math.round(t * 10)];
    const len = 0.3 * (1 - Math.pow((i / nRib - 0.4) * 1.6, 2) * 0.5);
    const broken = i === 2 || i === 6;
    for (const sgn of [-1, 1]) {
      if (broken && sgn > 0) continue;                     // ribs snapped off one side
      const g = ribGeo(seed + i * 11 + (sgn > 0 ? 1 : 0), len, 0.0105, 1.35 + rand() * 0.2);
      if (!g) continue;
      xform(g, {
        pos: [at.x, at.y, at.z],
        euler: [0, sgn > 0 ? 0 : Math.PI, 0],
      });
      xform(g, { euler: [0, 0, 0] });
      const g2 = g;
      xform(g2, { pos: [0, 0, 0] });
      parts.push(g2);
    }
  }
  /* pelvis and one femur still articulated */
  const pel = shardGeo({ w: 0.26, h: 0.2, d: 0.15, seed: seed + 90, seg: 2, rough: 0.28, uTile: 1, bevel: 0.02 });
  xform(pel, { pos: [-spineLen * 0.52, 0.12, 0], euler: [0.2, 0.3, -0.4] });
  parts.push(pel);
  const fem = longBone(seed + 95, 0.44, 0.021, 0.03);
  if (fem) {
    xform(fem, { pos: [-spineLen * 0.78, 0.06, 0.12], euler: [0.1, 0.7, 0.12] });
    parts.push(fem);
  }
  const sk = skullGeo(rand, seed + 120, 0.095, 0.5);
  if (sk) {
    xform(sk, { pos: [spineLen * 0.58, 0.09, 0.05], euler: [1.9, rand() * TAU, 0.3] });
    parts.push(sk);
  }
  const m = mergeParts(parts);
  if (m) {
    xform(m, { euler: [index % 2 ? 0.25 : -0.18, 0, index % 2 ? -0.3 : 0.22] });
    P.add('boneOld', m, { cast: true });
  }
  return P.build(seed);
}

/**
 * Ossuary stack: femurs laid up like cordwood with a course of skulls on top.
 * This is what a real catacomb looks like, and it reads instantly.
 */
export function boneStack(rand, index = 0) {
  const P = new PartSet();
  const seed = 9900 + index * 163;
  const W = index % 2 ? 1.6 : 1.15;
  const rows = index % 2 ? 5 : 4;
  const parts = [];
  for (let r = 0; r < rows; r++) {
    const y = 0.05 + r * 0.075;
    const n = Math.max(2, Math.round(W / 0.085) - (r >> 1));
    for (let i = 0; i < n; i++) {
      const g = longBone(seed + r * 31 + i * 5, 0.34 + rand() * 0.1, 0.019 + rand() * 0.004, 0.02);
      if (!g) continue;
      xform(g, {
        pos: [(rand() - 0.5) * 0.05, y, -W * 0.5 + (i + 0.5) * (W / n) + (rand() - 0.5) * 0.012],
        euler: [(rand() - 0.5) * 0.05, (rand() - 0.5) * 0.07, 0],
      });
      parts.push(g);
    }
  }
  /* the skull course */
  const nSk = Math.max(2, Math.round(W / 0.22));
  for (let i = 0; i < nSk; i++) {
    const g = skullGeo(rand, seed + 400 + i * 19, 0.088 + rand() * 0.012, 0.05);
    if (!g) continue;
    xform(g, {
      pos: [(rand() - 0.5) * 0.04, 0.06 + rows * 0.075, -W * 0.44 + (i + 0.5) * (W * 0.88 / nSk)],
      euler: [(rand() - 0.5) * 0.2, Math.PI * 0.5 + (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.2],
    });
    parts.push(g);
  }
  /* the ones that have fallen out of the stack */
  for (let i = 0; i < 5; i++) {
    const a = rand() * TAU, d = W * 0.55 + rand() * 0.35;
    const g = longBone(seed + 500 + i, 0.26 + rand() * 0.14, 0.016, 0.02);
    if (!g) continue;
    xform(g, { pos: [Math.cos(a) * d * 0.6, 0.02, Math.sin(a) * d], euler: [(rand() - 0.5) * 0.5, rand() * TAU, (rand() - 0.5) * 0.5] });
    parts.push(g);
  }
  const m = mergeParts(parts);
  if (m) P.add(index % 2 ? 'boneOld' : 'bone', m, { cast: true });
  /* the retaining plank that stops the stack spilling */
  const board = shardGeo({ w: W * 1.05, h: 0.12, d: 0.05, seed: seed + 700, seg: 1, rough: 0.12, uTile: 1, bevel: 0.014 });
  xform(board, { pos: [0.06, 0.09, 0], euler: [0, Math.PI / 2, 0.03] });
  P.add('woodDark', board);
  return P.build(seed);
}

/* ================================================================== *
 * gibbet — a hanging cage with an occupant
 * ================================================================== */

export function gibbet(rand, index = 0) {
  const P = new PartSet();
  const seed = 10000 + index * 167;
  const H = index % 2 ? 2.85 : 2.4;
  const reach = 0.78;
  const a = rand() * TAU;
  const ax = Math.cos(a), az = Math.sin(a);

  /* post, buried, with a diagonal brace */
  const sp = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    sp.push({ x: 0, y: -0.3 + t * (H + 0.3), z: 0, r: 0.095 - t * 0.026 });
  }
  const post = tube(sp, { radial: 6, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.12, seed, closeStart: true });
  if (post) P.add('timber', post);
  const arm = bar([0, H - 0.06, 0], [ax * reach, H - 0.02, az * reach], 0.055, 0.04,
    { radial: 6, seed: seed + 5, nodes: 4 });
  if (arm) P.add('timber', arm);
  const brace = bar([0, H - 0.55, 0], [ax * reach * 0.62, H - 0.09, az * reach * 0.62], 0.038, 0.03,
    { radial: 5, seed: seed + 7, nodes: 3 });
  if (brace) P.add('timber', brace);
  const cap = latheGeo([[0.075, H - 0.02], [0.06, H + 0.05], [0.03, H + 0.09]],
    { seg: 7, uTile: 1 / 0.34, seed: seed + 9, lobeAmt: 0.06, lobes: 5, capTop: true });
  P.add('metalDark', cap, { cast: false });

  /* chain and cage */
  const cageTop = H - 0.36;
  const iron = [];
  const nLink = 4;
  for (let i = 0; i < nLink; i++) {
    const t = (i + 0.5) / nLink;
    const g = ringGeo(0.03, 0.008, 4, 10);
    xform(g, {
      pos: [ax * reach, H - 0.05 - t * 0.31, az * reach],
      euler: [i & 1 ? 0 : Math.PI / 2, a, 0],
    });
    iron.push(g);
  }
  const R = 0.29, CH = 0.92;
  for (let i = 0; i < 7; i++) {
    const ba = (i / 7) * TAU + rand() * 0.1;
    const g = bar(
      [ax * reach + Math.cos(ba) * R * 0.55, cageTop, az * reach + Math.sin(ba) * R * 0.55],
      [ax * reach + Math.cos(ba) * R * 0.8, cageTop - CH, az * reach + Math.sin(ba) * R * 0.8],
      0.011, 0.011, { radial: 4, bow: 0.055, bowAxis: [Math.cos(ba), 0, Math.sin(ba)], seed: seed + 20 + i, nodes: 4 }
    );
    if (g) iron.push(g);
  }
  for (const t of [0.06, 0.5, 0.96]) {
    const rr = R * lerp(0.58, 0.82, Math.sin(t * Math.PI * 0.9));
    const g = ringGeo(rr, 0.009, 4, 16);
    xform(g, { pos: [ax * reach, cageTop - CH * t, az * reach], euler: [Math.PI / 2, 0, 0] });
    iron.push(g);
  }
  const crown = latheGeo([[R * 0.6, cageTop], [R * 0.34, cageTop + 0.05], [0.02, cageTop + 0.085]],
    { seg: 8, uTile: 1 / 0.34, seed: seed + 40, lobeAmt: 0.04, lobes: 6, capTop: true });
  xform(crown, { pos: [ax * reach, 0, az * reach] });
  iron.push(crown);
  const im = mergeParts(iron);
  if (im) P.add('metalDark', im, { cast: true });

  /* what is left inside */
  const bones = [];
  const sk = skullGeo(rand, seed + 60, 0.088, 0.35);
  if (sk) {
    xform(sk, { pos: [ax * reach + (rand() - 0.5) * 0.06, cageTop - 0.18, az * reach + (rand() - 0.5) * 0.06], euler: [0.5, rand() * TAU, 0.3] });
    bones.push(sk);
  }
  for (let i = 0; i < 4; i++) {
    const g = longBone(seed + 70 + i, 0.3 + rand() * 0.12, 0.016, 0.02);
    if (!g) continue;
    xform(g, {
      pos: [ax * reach + (rand() - 0.5) * 0.2, cageTop - CH * (0.55 + rand() * 0.35), az * reach + (rand() - 0.5) * 0.2],
      euler: [(rand() - 0.5) * 1.4, rand() * TAU, (rand() - 0.5) * 1.4],
    });
    bones.push(g);
  }
  const bm = mergeParts(bones);
  if (bm) P.add('boneOld', bm, { cast: true });
  return P.build(seed);
}

/* ================================================================== *
 * skull on a pike
 * ================================================================== */

export function skullPike(rand, index = 0) {
  const P = new PartSet();
  const seed = 10100 + index * 173;
  const H = [1.75, 2.1, 1.45][index % 3];
  const lean = 0.05 + rand() * 0.1;
  const a = rand() * TAU;
  const tx = Math.cos(a) * lean * H, tz = Math.sin(a) * lean * H;

  const sp = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    sp.push({ x: tx * t * t, y: -0.28 + t * (H + 0.28), z: tz * t * t, r: 0.042 * (1 - t * 0.4) });
  }
  const pole = tube(sp, { radial: 5, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.13, seed, closeStart: true });
  if (pole) P.add('timber', pole);

  const sk = skullGeo(rand, seed + 30, 0.098, 0.28);
  if (sk) {
    xform(sk, { pos: [tx, H + 0.03, tz], euler: [0.3 + (rand() - 0.5) * 0.4, rand() * TAU, (rand() - 0.5) * 0.5] });
    P.add('boneOld', sk, { cast: true });
  }
  /* a scrap of the rest of him */
  if (index % 3 !== 2) {
    const rag = shardGeo({ w: 0.14, h: 0.2, d: 0.02, seed: seed + 50, seg: 1, rough: 0.4, uTile: 1, bevel: 0.006 });
    xform(rag, { pos: [tx * 0.8, H * 0.72, tz * 0.8 + 0.03], euler: [0.2, rand() * TAU, 0.3] });
    P.add('leather', rag, { cast: false });
  }
  const tie = ringGeo(0.038, 0.007, 4, 9);
  xform(tie, { pos: [tx * 0.9, H - 0.12, tz * 0.9], euler: [Math.PI / 2, 0, 0.2] });
  P.add('metalDark', tie, { cast: false });
  return P.build(seed);
}

/* ================================================================== *
 * blood altar — the focal set-piece, and it comes with its own candles
 * ================================================================== */

export function bloodAltar(rand, index = 0) {
  const P = new PartSet();
  const seed = 10200 + index * 179;
  const W = 1.5, D = 0.95, H = 0.78;

  /* three courses of heavy ashlar, each shifted */
  const stone = [];
  const courses = 3;
  for (let c = 0; c < courses; c++) {
    const t = c / (courses - 1);
    const w = W * lerp(1.0, 0.86, t), d = D * lerp(1.0, 0.88, t);
    const g = shardGeo({
      w, h: H / courses * 0.96, d, seed: seed + c * 23, seg: 2, rough: 0.09, uTile: 1, bevel: 0.03,
    });
    xform(g, {
      pos: [(rand() - 0.5) * 0.02, (c + 0.5) * (H / courses), (rand() - 0.5) * 0.02],
      euler: [0, (rand() - 0.5) * 0.03, 0],
    });
    stone.push(g);
  }
  /* the mensa: a wider slab with a bevelled lip and a bled channel */
  const slab = shardGeo({ w: W * 1.12, h: 0.14, d: D * 1.14, seed: seed + 90, seg: 2, rough: 0.06, uTile: 1, bevel: 0.035 });
  xform(slab, { pos: [0, H + 0.07, 0] });
  paintVertex(slab, (x, y, z, nx, ny, nz, out) => {
    // a dark runnel down the centre line and dripping over the front lip
    const ch = 1 - smooth01(0.02, 0.1, Math.abs(z));
    const up = clamp01(ny);
    const drip = clamp01(-nz) * (1 - smooth01(H + 0.02, H + 0.08, y));
    const k = 1 - 0.55 * ch * up - 0.3 * drip;
    out[0] = k * 1.02; out[1] = k * 0.9; out[2] = k * 0.88;
  });
  stone.push(slab);
  /* corner iron rings, for what was held down */
  const sm = mergeParts(stone);
  if (sm) P.add('stone', sm, { cast: true });

  const iron = [];
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    const g = ringGeo(0.045, 0.009, 4, 11);
    xform(g, {
      pos: [sx * W * 0.5, H + 0.02, sz * D * 0.52],
      euler: [0.35, 0, 0.2 * sx],
    });
    iron.push(g);
    const plateG = plate(0.05, 0.05, 0.018, 0.006);
    xform(plateG, { pos: [sx * W * 0.52, H + 0.06, sz * D * 0.54] });
    iron.push(plateG);
  }
  /* a chain trailing off the near corner onto the floor */
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const g = ringGeo(0.028, 0.007, 4, 10);
    xform(g, {
      pos: [W * 0.5 + t * 0.34, (H + 0.02) * (1 - t * t) + 0.02, -D * 0.52 - t * 0.2],
      euler: [i & 1 ? 0 : Math.PI / 2, 0.4, 0],
    });
    iron.push(g);
  }
  const im = mergeParts(iron);
  if (im) P.add('metalDark', im, { cast: false });

  /* the bowl, and what is in it */
  const bowl = latheGeo([
    [0.03, H + 0.14], [0.09, H + 0.16], [0.115, H + 0.21], [0.12, H + 0.245],
    [0.11, H + 0.248], [0.1, H + 0.185], [0.03, H + 0.16],
  ], { seg: 12, uTile: 1 / 0.3, seed: seed + 120, lobeAmt: 0.04, lobes: 7, capBottom: true });
  xform(bowl, { pos: [-W * 0.24, 0, 0] });
  P.add('bronze', bowl);
  const pool = latheGeo([[0.1, H + 0.2], [0.09, H + 0.207], [0.03, H + 0.21]],
    { seg: 11, uTile: 1 / 0.42, seed: seed + 125, lobeAmt: 0.04, lobes: 5, capTop: true });
  xform(pool, { pos: [-W * 0.24, 0, 0] });
  P.add('flesh', pool, { cast: false });

  /* blood that has run off the slab and pooled on the floor */
  const floorPool = latheGeo([[0.52, 0], [0.48, 0.006], [0.3, 0.011], [0.05, 0.013]],
    { seg: 14, uTile: 1 / 0.42, seed: seed + 130, lobeAmt: 0.3, lobes: 6, capTop: true });
  xform(floorPool, { pos: [0.2, 0.006, -D * 0.72] });
  P.add('flesh', floorPool, { cast: false });

  /* a skull chained to the slab, and a couple of long bones as offerings */
  const bones = [];
  const sk = skullGeo(rand, seed + 150, 0.095, 0.2);
  if (sk) {
    xform(sk, { pos: [W * 0.26, H + 0.2, D * 0.16], euler: [0.35, rand() * TAU, 0.15] });
    bones.push(sk);
  }
  for (let i = 0; i < 3; i++) {
    const g = longBone(seed + 160 + i, 0.3 + rand() * 0.1, 0.016, 0.02);
    if (!g) continue;
    xform(g, {
      pos: [(rand() - 0.5) * W * 0.7, H + 0.155, (rand() - 0.5) * D * 0.5],
      euler: [0, rand() * TAU, 0.03],
    });
    bones.push(g);
  }
  const bm = mergeParts(bones);
  if (bm) P.add('boneOld', bm, { cast: true });

  /* melted candle stubs live on the slab: the module hangs real flames here */
  const out = P.build(seed);
  out.candles = [
    [-W * 0.42, H + 0.15, D * 0.3],
    [W * 0.44, H + 0.15, -D * 0.28],
  ];
  return out;
}

void finish; void bakeWear; void THREE;
