/**
 * THE NINTH VIGIL — LIGHT FIXTURES.
 *
 * This file exists because of one specific, fatal defect: captured frames had
 * torch lights with **no source object**. A point light floating in empty air
 * with a bloom halo around it does not read as fire; it reads as lens dirt or a
 * firefly, and a hostile art director calls it a billboard blob and stops
 * reading.
 *
 * The rule this file enforces:
 *
 *   Every practical light in the game is co-located with
 *     (a) real fixture geometry that could plausibly hold fire,
 *     (b) a fuel bed that is *itself* emissive (glowing coal / embers), and
 *     (c) an animated 3D flame body — a teardrop of revolution, never a quad —
 *   and the light sits AT the flame, a few centimetres above the fuel, not at
 *   the fixture origin and never in mid-air.
 *
 * Emissive discipline: only the flame material and the coal kind exceed 1.0.
 * Iron, wood, wax and glass all stay under it, or bloom turns into full-frame
 * haze and every other axis of the rubric collapses with it.
 *
 * Scale is the canonical table: hero 1.85 m. A brazier bowl sits at 1.0 m —
 * waist height on the hero. A wall sconce mounts at 1.9 m. A torch post stands
 * 2.2 m. If a fixture reads as furniture for giants, the whole frame's sense of
 * scale goes with it.
 */

import * as THREE from 'three';
import {
  tube, latheGeo, boxGeo, rockGeo, shardGeo, chainGeo, mergeParts, xform,
  finish, bakeWear, faceBoxUV, clamp01, lerp,
} from './Geo.js';

/* ------------------------------------------------------------------ *
 * shared assembly helper
 * ------------------------------------------------------------------ */

/**
 * Collects geometry by material so a fixture (or any composite prop) ends up as
 * one merged draw per material instead of one per screw. Also carries the
 * fixture's flame emitters and light definitions.
 */
export class PartSet {
  constructor() {
    /** @type {Map<string,{geos:THREE.BufferGeometry[],cast:boolean,side:number|null,wear:object|false}>} */
    this.groups = new Map();
    this.flames = [];
    this.lights = [];
  }

  /**
   * @param {string} matName bank material name
   * @param {THREE.BufferGeometry|null} geo
   * @param {object} [o] {cast, side, wear}
   */
  add(matName, geo, o = null) {
    if (!geo) return this;
    let g = this.groups.get(matName);
    if (!g) this.groups.set(matName, (g = { geos: [], cast: true, side: null, wear: undefined }));
    g.geos.push(geo);
    if (o) {
      if (o.cast !== undefined) g.cast = o.cast;
      if (o.side !== undefined) g.side = o.side;
      if (o.wear !== undefined) g.wear = o.wear;
    }
    return this;
  }

  /** A flame emitter. `s` scales flameGeo (base 0.22 m tall, 0.055 m wide). */
  flame(x, y, z, s = 1, style = 'fire') {
    this.flames.push({ x, y, z, s, style });
    return this;
  }

  /** A practical light. Positioned at the flame by every caller in this file. */
  light(o) { this.lights.push(o); return this; }

  /**
   * Merge, weather and finish. `wearDefaults` maps material name -> bakeWear
   * options; anything unlisted gets the generic iron/stone treatment.
   */
  build(seed = 1, wearDefaults = null) {
    const parts = [];
    // Sorted so the output order is a pure function of the content, never of
    // Map insertion timing — the screenshot critic needs byte-stable frames.
    const names = [...this.groups.keys()].sort();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const g = this.groups.get(name);
      const geo = mergeParts(g.geos);
      if (!geo) continue;
      const w = g.wear !== undefined ? g.wear : (wearDefaults?.[name] ?? WEAR[name] ?? WEAR.__default);
      if (w) bakeWear(geo, { seed: seed + i * 37, ...w });
      finish(geo);
      parts.push({ geo, matName: name, cast: g.cast, side: g.side });
    }
    return { parts, flames: this.flames, lights: this.lights };
  }
}

/**
 * Per-material weathering defaults: how each surface accumulates its history.
 *
 * Two calibration notes, both learned from captured frames:
 *
 *  • `base` (contact darkening at the foot) is kept modest. The library's source
 *    albedos are already very dark — bark sits at 0.09, iron at 0.13 — so a 0.5
 *    base multiplier crushes the bottom half of every prop to pure black and the
 *    dressing stops reading as anything at all. Grounding is the contact blob's
 *    job; this layer only needs to suggest it.
 *  • `tint` lifts the mid-tone back to where a torch can actually find it. It is
 *    a multiplier on vertex colour, so it costs nothing and it keeps the frame's
 *    value structure bottom-weighted without going to mud.
 */
const WEAR = {
  __default: { base: 0.24, baseH: 0.3, cavity: 0.34, blotch: 0.2, tint: [1.18, 1.15, 1.1] },
  metalDark: { base: 0.2, baseH: 0.35, cavity: 0.4, blotch: 0.2, blotchFreq: 3.2, dust: 0.1, tint: [1.3, 1.26, 1.22] },
  metal: { base: 0.18, baseH: 0.35, cavity: 0.38, blotch: 0.18, blotchFreq: 3.4, dust: 0.12, tint: [1.35, 1.32, 1.28] },
  bronze: { base: 0.16, baseH: 0.4, cavity: 0.36, blotch: 0.16, blotchFreq: 3.0, tint: [1.28, 1.2, 1.05] },
  wood: { base: 0.26, baseH: 0.3, cavity: 0.34, blotch: 0.24, blotchFreq: 2.2, dust: 0.14, tint: [1.4, 1.3, 1.18] },
  woodDark: { base: 0.3, baseH: 0.3, cavity: 0.36, blotch: 0.26, blotchFreq: 2.2, tint: [1.32, 1.22, 1.1] },
  timber: { base: 0.28, baseH: 0.28, cavity: 0.32, blotch: 0.24, blotchFreq: 1.5, dust: 0.16, tint: [1.45, 1.34, 1.2] },
  barkCharred: { base: 0.3, baseH: 0.4, cavity: 0.4, blotch: 0.3, blotchFreq: 2.0, tint: [1.2, 1.14, 1.1] },
  // Coal must NOT be darkened at the base or the incandescent cracks go out.
  coal: { base: 0.06, baseH: 0.6, cavity: 0.12, blotch: 0.22, blotchFreq: 5.0 },
  wax: { base: 0.1, baseH: 0.5, cavity: 0.22, blotch: 0.12, blotchFreq: 4.0, tint: [1.12, 1.08, 1.0] },
  ash: { base: 0.12, baseH: 0.5, cavity: 0.18, blotch: 0.3, blotchFreq: 3.5, dust: 0.3 },
  glass: false,
  stone: { base: 0.24, baseH: 0.25, cavity: 0.38, blotch: 0.2, dust: 0.2, tint: [1.16, 1.15, 1.14] },
  stoneCold: { base: 0.26, baseH: 0.25, cavity: 0.38, blotch: 0.2, dust: 0.18, tint: [1.12, 1.15, 1.2] },
  stoneWarm: { base: 0.24, baseH: 0.25, cavity: 0.36, blotch: 0.22, dust: 0.16, tint: [1.24, 1.16, 1.06] },
  leather: { base: 0.26, baseH: 0.35, cavity: 0.36, blotch: 0.22, blotchFreq: 2.6, tint: [1.24, 1.16, 1.08] },
  bone: { base: 0.2, baseH: 0.3, cavity: 0.38, blotch: 0.24, blotchFreq: 3.0, tint: [1.14, 1.12, 1.06] },
  boneOld: { base: 0.22, baseH: 0.3, cavity: 0.38, blotch: 0.26, blotchFreq: 3.0, tint: [1.16, 1.12, 1.02] },
  cloth: { base: 0.24, baseH: 0.4, cavity: 0.3, blotch: 0.24, blotchFreq: 2.4, tint: [1.22, 1.2, 1.16] },
  clothRed: { base: 0.2, baseH: 0.45, cavity: 0.28, blotch: 0.22, blotchFreq: 2.4, tint: [1.3, 1.1, 1.06] },
  sack: { base: 0.26, baseH: 0.35, cavity: 0.32, blotch: 0.26, blotchFreq: 2.8, tint: [1.3, 1.24, 1.12] },
  rubble: { base: 0.26, baseH: 0.22, cavity: 0.4, blotch: 0.26, blotchFreq: 2.6, dust: 0.24, tint: [1.14, 1.13, 1.12] },
  foliageDry: { base: 0.42, baseH: 0.45, cavity: 0.12, blotch: 0.3, blotchFreq: 4, tint: [1.2, 1.16, 1.05] },
  flesh: { base: 0.2, baseH: 0.4, cavity: 0.36, blotch: 0.26, blotchFreq: 3, tint: [1.15, 1.0, 1.0] },
};

/* ------------------------------------------------------------------ *
 * small primitives (metre UVs — uv = world metres, material owns the tile)
 * ------------------------------------------------------------------ */

/** A torus with metre UVs: hoops, rings, hooks, collars, chain links. */
export function ringGeo(r, wire, radial = 5, tubular = 12) {
  const g = new THREE.TorusGeometry(r, wire, radial, tubular);
  const out = faceBoxUV(g, 1);
  if (out !== g) g.dispose();
  return out;
}

/** Bevelled plate/box in true metre UVs. */
export function plate(w, h, d, bevel = 0.012) {
  return boxGeo(w, h, d, { bevel, uTile: 1 });
}

/** A rough forged bar between two points — never a clean cylinder. */
export function bar(from, to, r0, r1 = r0, { radial = 5, bowAxis = null, bow = 0, seed = 3, nodes = 4 } = {}) {
  const sp = [];
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  let bx = 0, by = 0, bz = 0;
  if (bow !== 0) {
    if (bowAxis) { bx = bowAxis[0]; by = bowAxis[1]; bz = bowAxis[2]; }
    else {
      // default bow: perpendicular in the horizontal plane
      const l = Math.hypot(dx, dz) || 1;
      bx = -dz / l; by = 0; bz = dx / l;
    }
  }
  for (let i = 0; i <= nodes; i++) {
    const t = i / nodes;
    const s = Math.sin(t * Math.PI) * bow;
    sp.push({
      x: from[0] + dx * t + bx * s,
      y: from[1] + dy * t + by * s,
      z: from[2] + dz * t + bz * s,
      r: lerp(r0, r1, t),
    });
  }
  return tube(sp, { radial, uTile: 1 / 0.34, lobes: 3, lobeAmt: 0.13, seed, closeStart: true });
}

/**
 * A bed of glowing coals: irregular lumps packed into a shallow dish. The
 * `propcoal` material carries incandescence in its emissive map, so the cracks
 * between lumps glow and the crust stays near-black — which is what makes a
 * brazier read as *fuelled* rather than as a bowl with a light in it.
 */
export function coalBed(rand, { r = 0.2, y = 0, count = 9, size = 0.055, flat = 0.5 } = {}) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.pow(rand(), 0.55) * r;
    const s = size * (0.55 + rand() * 0.9);
    const g = rockGeo({
      radius: s, detail: 1, warp: 0.44, warpFreq: 1.6,
      squash: [1.1, flat, 0.95], flatten: 0.3, chip: 0.2,
      seed: 7100 + i * 13, uTile: 1, shear: 0.2,
    });
    xform(g, {
      pos: [Math.cos(a) * d, y + s * (0.25 + rand() * 0.4), Math.sin(a) * d],
      euler: [(rand() - 0.5) * 0.8, rand() * 6.283, (rand() - 0.5) * 0.8],
    });
    parts.push(g);
  }
  return mergeParts(parts);
}

/** Charred split log. */
function logGeo(rand, len, r, seed) {
  const sp = [];
  const n = 4;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    sp.push({
      x: (t - 0.5) * len,
      y: Math.sin(t * Math.PI) * r * 0.16 * (rand() - 0.2),
      z: (Math.sin(t * 5.1 + seed) - 0.2) * r * 0.35,
      r: r * (0.82 + 0.28 * Math.sin(t * 3.1 + seed * 0.7)),
    });
  }
  return tube(sp, { radial: 6, uTile: 1 / 0.9, lobes: 4, lobeAmt: 0.16, seed, closeStart: true });
}

/* ------------------------------------------------------------------ *
 * 1 · standing brazier — tripod, bowl, coal bed, flame
 * ------------------------------------------------------------------ */

export function brazier(rand, index = 0) {
  const P = new PartSet();
  const big = index % 3 === 2;
  const R = big ? 0.36 : 0.29;                 // bowl rim radius
  const H = big ? 1.14 : 0.98;                 // rim height
  const legR = R * 0.98;

  /* three splayed legs with claw feet, twisted so the tripod is not symmetric */
  const a0 = rand() * 6.283;
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i / 3) * 6.283 + (rand() - 0.5) * 0.22;
    const fx = Math.cos(a) * legR, fz = Math.sin(a) * legR;
    P.add('metalDark', bar(
      [fx, -0.02, fz], [Math.cos(a) * R * 0.44, H - 0.24, Math.sin(a) * R * 0.44],
      0.026, 0.019, { bow: 0.05, bowAxis: [-Math.cos(a), 0, -Math.sin(a)], seed: 7200 + i * 7, nodes: 5 }
    ));
    // claw foot
    const foot = latheGeo([[0.045, -0.03], [0.036, 0.01], [0.022, 0.05]],
      { seg: 5, uTile: 1 / 0.34, seed: 7210 + i, lobeAmt: 0.2, lobes: 3, capTop: true, capBottom: true });
    xform(foot, { pos: [fx, 0, fz] });
    P.add('metalDark', foot);
  }
  /* brace ring holds the legs together — reads as forged, not modelled */
  const brace = ringGeo(legR * 0.72, 0.014, 4, 14);
  xform(brace, { pos: [0, H * 0.34, 0], euler: [Math.PI / 2, rand() * 0.5, 0] });
  P.add('metalDark', brace);

  /* the bowl: hemispherical, thick, with a rolled rim */
  const bowl = latheGeo([
    [R * 0.30, H - 0.30], [R * 0.62, H - 0.24], [R * 0.86, H - 0.14],
    [R * 0.98, H - 0.05], [R, H], [R * 0.93, H + 0.005],
    [R * 0.90, H - 0.06], [R * 0.55, H - 0.17], [R * 0.20, H - 0.22],
  ], { seg: 18, uTile: 1 / 0.34, seed: 7220 + index, lobeAmt: 0.022, lobes: 9, capBottom: true });
  P.add('metalDark', bowl);
  const rim = ringGeo(R * 0.99, 0.022, 5, 20);
  xform(rim, { pos: [0, H, 0], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', rim);
  /* three rivet bosses round the bowl */
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i / 3) * 6.283 + 1.05;
    const boss = latheGeo([[0.024, 0], [0.019, 0.014]], { seg: 5, uTile: 1 / 0.34, seed: 7230 + i, capTop: true });
    xform(boss, {
      pos: [Math.cos(a) * R * 0.96, H - 0.10, Math.sin(a) * R * 0.96],
      euler: [Math.PI / 2, 0, -a],
    });
    P.add('metalDark', boss);
  }

  /* fuel */
  const coals = coalBed(rand, { r: R * 0.74, y: H - 0.13, count: big ? 13 : 10, size: R * 0.24, flat: 0.55 });
  P.add('coal', coals, { cast: false });
  const ashPile = latheGeo([[R * 0.82, H - 0.17], [R * 0.7, H - 0.145], [R * 0.3, H - 0.125]],
    { seg: 12, uTile: 1 / 0.85, seed: 7240 + index, lobeAmt: 0.14, lobes: 5, capTop: true });
  P.add('ash', ashPile, { cast: false });

  /* flame sits on the fuel, light sits in the flame */
  const fs = big ? 2.15 : 1.75;
  P.flame(0, H - 0.06, 0, fs, 'fire');
  P.flame(R * 0.28, H - 0.09, -R * 0.2, fs * 0.55, 'fire');
  P.light({
    x: 0, y: H + 0.16, z: 0,
    intensity: big ? 20 : 15.5, radius: big ? 15 : 12.5,
    type: 'brazier', kelvin: 2000, flicker: 0.9, shadow: true,
  });
  return P.build(7250 + index);
}

/* ------------------------------------------------------------------ *
 * 2 · campfire — stone ring, stacked logs, ember bed
 * ------------------------------------------------------------------ */

export function campfire(rand, index = 0) {
  const P = new PartSet();
  const R = 0.62 + (index % 2) * 0.14;

  /* hearth ring: stones set on edge, gapped, one knocked out of line */
  const nStone = 8 + (index % 3);
  const a0 = rand() * 6.283;
  for (let i = 0; i < nStone; i++) {
    if (i === 3 && index % 2 === 0) continue;              // a gap to feed the fire
    const a = a0 + (i / nStone) * 6.283 + (rand() - 0.5) * 0.28;
    const s = 0.10 + rand() * 0.075;
    const g = rockGeo({
      radius: s, detail: 1, warp: 0.36, squash: [1.2, 0.78, 0.9], flatten: 0.3,
      seed: 7300 + index * 17 + i, uTile: 1, shear: 0.16,
    });
    const d = R * (0.92 + rand() * 0.18);
    xform(g, {
      pos: [Math.cos(a) * d, s * 0.52, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 0.45, a + (rand() - 0.5) * 0.6, (rand() - 0.5) * 0.4],
    });
    P.add('stoneCold', g);
  }

  /* ash and scorch inside the ring */
  const bed = latheGeo([[R * 0.94, 0.0], [R * 0.86, 0.03], [R * 0.5, 0.055], [R * 0.15, 0.062]],
    { seg: 15, uTile: 1 / 0.85, seed: 7310 + index, lobeAmt: 0.13, lobes: 6, capTop: true });
  P.add('ash', bed, { cast: false });

  /* logs: two on the ground, three leaning into a tipi */
  for (let i = 0; i < 2; i++) {
    const a = a0 + 1.1 + i * 1.9;
    const g = logGeo(rand, R * 1.5, 0.062 + rand() * 0.02, 7320 + i);
    xform(g, { pos: [(rand() - 0.5) * 0.16, 0.075, (rand() - 0.5) * 0.16], euler: [0, a, (rand() - 0.5) * 0.14] });
    P.add('barkCharred', g);
  }
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i / 3) * 6.283 + 0.4 + rand() * 0.3;
    const g = logGeo(rand, R * 1.35, 0.05 + rand() * 0.018, 7330 + i);
    xform(g, {
      pos: [Math.cos(a) * R * 0.34, 0.24, Math.sin(a) * R * 0.34],
      euler: [0, a + Math.PI / 2, 0.78 + rand() * 0.16],
    });
    P.add('barkCharred', g);
  }

  /* embers under the logs — the hottest thing in the frame after the flame */
  P.add('coal', coalBed(rand, { r: R * 0.5, y: 0.05, count: 14, size: 0.05, flat: 0.42 }), { cast: false });

  P.flame(0, 0.16, 0, 2.5, 'fire');
  P.flame(0.13, 0.11, -0.09, 1.6, 'fire');
  P.flame(-0.11, 0.10, 0.12, 1.35, 'fire');
  P.light({
    x: 0, y: 0.62, z: 0, intensity: 22, radius: 17,
    type: 'campfire', kelvin: 1950, flicker: 1, shadow: true,
  });
  return P.build(7340 + index);
}

/* ------------------------------------------------------------------ *
 * 3 · wall sconce — bracket, bowl, coals. Origin at the wall face, +Z out.
 * ------------------------------------------------------------------ */

export function wallSconce(rand, index = 0) {
  const P = new PartSet();

  /* back plate with a punched trefoil edge and two rivets */
  const bp = plate(0.17, 0.27, 0.032, 0.01);
  xform(bp, { pos: [0, 0.02, 0.016] });
  P.add('metalDark', bp);
  for (let i = 0; i < 2; i++) {
    const riv = latheGeo([[0.014, 0], [0.010, 0.011]], { seg: 5, uTile: 1 / 0.34, seed: 7400 + i, capTop: true });
    xform(riv, { pos: [0, 0.10 - i * 0.16, 0.034], euler: [Math.PI / 2, 0, 0] });
    P.add('metalDark', riv);
  }
  /* scrolled bracket arm */
  P.add('metalDark', bar([0, -0.04, 0.03], [0, 0.10, 0.20], 0.020, 0.015,
    { bow: 0.045, bowAxis: [0, -1, 0], seed: 7410 + index, nodes: 5 }));
  P.add('metalDark', bar([0, 0.10, 0.04], [0, 0.12, 0.19], 0.014, 0.012,
    { bow: 0.03, bowAxis: [0, 1, 0], seed: 7415 + index, nodes: 4 }));
  const scroll = ringGeo(0.036, 0.011, 4, 11);
  xform(scroll, { pos: [0, 0.015, 0.115], euler: [0, Math.PI / 2, 0.4] });
  P.add('metalDark', scroll);

  /* bowl on the arm's end */
  const R = 0.115;
  const bowl = latheGeo([
    [R * 0.34, 0.0], [R * 0.7, 0.028], [R * 0.94, 0.062], [R, 0.082],
    [R * 0.92, 0.086], [R * 0.8, 0.05], [R * 0.3, 0.02],
  ], { seg: 12, uTile: 1 / 0.34, seed: 7420 + index, lobeAmt: 0.04, lobes: 7, capBottom: true });
  xform(bowl, { pos: [0, 0.115, 0.205] });
  P.add('metalDark', bowl);
  const rim = ringGeo(R * 0.99, 0.012, 4, 14);
  xform(rim, { pos: [0, 0.197, 0.205], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', rim);

  const coals = coalBed(rand, { r: R * 0.66, y: 0.15, count: 7, size: 0.032, flat: 0.6 });
  xform(coals, { pos: [0, 0, 0.205] });
  P.add('coal', coals, { cast: false });

  P.flame(0, 0.195, 0.205, 1.15, 'fire');
  P.light({
    x: 0, y: 0.29, z: 0.23, intensity: 11.5, radius: 10.5,
    type: 'torch', kelvin: 1900, flicker: 1, shadow: false,
  });
  return P.build(7430 + index);
}

/* ------------------------------------------------------------------ *
 * 4 · wall torch — bracket ring + pitch-soaked head. Origin at the wall.
 * ------------------------------------------------------------------ */

export function wallTorch(rand, index = 0) {
  const P = new PartSet();
  const tilt = 0.44 + rand() * 0.12;                       // lean out from the wall
  const L = 0.62;
  const hx = Math.sin(tilt) * L, hy = Math.cos(tilt) * L;

  /* strap and two collars that actually hold the shaft */
  const strap = plate(0.055, 0.3, 0.026, 0.008);
  xform(strap, { pos: [0, 0.06, 0.013] });
  P.add('metalDark', strap);
  P.add('metalDark', bar([0, 0.0, 0.02], [0, 0.02, 0.115], 0.013, 0.011, { seed: 7500, nodes: 3 }));
  P.add('metalDark', bar([0, 0.16, 0.02], [0, 0.19, 0.13], 0.013, 0.011, { seed: 7501, nodes: 3 }));
  for (let i = 0; i < 2; i++) {
    const t = i === 0 ? 0.06 : 0.24;
    const ring = ringGeo(0.042, 0.011, 4, 11);
    xform(ring, {
      pos: [0, 0.02 + hy * t, 0.115 + hx * t * 0.0 + 0.055 + t * 0.12],
      euler: [Math.PI / 2 - tilt, 0, 0],
    });
    P.add('metalDark', ring);
  }

  /* the shaft, leaning out and up */
  const shaft = tube([
    { x: 0, y: -0.06, z: 0.10, r: 0.026 },
    { x: 0, y: 0.14, z: 0.16, r: 0.024 },
    { x: 0, y: 0.36, z: 0.235, r: 0.023 },
    { x: 0, y: hy * 0.9 - 0.02, z: 0.105 + hx * 0.9, r: 0.021 },
  ], { radial: 6, uTile: 1 / 0.62, lobes: 4, lobeAmt: 0.11, seed: 7510 + index, closeStart: true });
  P.add('wood', shaft);

  /* pitch-soaked rag head: lumpy, charred, unmistakably fuel */
  const headY = hy * 0.9 + 0.02, headZ = 0.105 + hx * 0.9;
  const head = latheGeo([
    [0.028, -0.05], [0.052, -0.02], [0.058, 0.02], [0.05, 0.055], [0.03, 0.078],
  ], { seg: 9, uTile: 1 / 0.4, seed: 7520 + index, lobeAmt: 0.22, lobes: 5, capTop: true, capBottom: true });
  xform(head, { pos: [0, headY, headZ], euler: [-tilt * 0.5, rand() * 3, 0] });
  P.add('leather', head);
  const wrap = ringGeo(0.05, 0.009, 4, 10);
  xform(wrap, { pos: [0, headY - 0.03, headZ], euler: [Math.PI / 2 - tilt * 0.5, 0, 0] });
  P.add('metalDark', wrap);
  const ember = coalBed(rand, { r: 0.032, y: headY + 0.05, count: 5, size: 0.024, flat: 0.7 });
  xform(ember, { pos: [0, 0, headZ] });
  P.add('coal', ember, { cast: false });

  P.flame(0, headY + 0.075, headZ, 1.5, 'fire');
  P.light({
    x: 0, y: headY + 0.2, z: headZ + 0.04, intensity: 13, radius: 12,
    type: 'torch', kelvin: 1900, flicker: 1, shadow: false,
  });
  return P.build(7530 + index);
}

/* ------------------------------------------------------------------ *
 * 5 · torch post — a free-standing practical for open ground
 * ------------------------------------------------------------------ */

export function torchPost(rand, index = 0) {
  const P = new PartSet();
  const H = 1.95 + (index % 3) * 0.18;
  const lean = (rand() - 0.5) * 0.09;
  const la = rand() * 6.283;
  const tipX = Math.sin(lean) * H * Math.cos(la), tipZ = Math.sin(lean) * H * Math.sin(la);

  /* buried, split post — the base flares so it does not read as a pipe */
  const post = tube([
    { x: 0, y: -0.28, z: 0, r: 0.09 },
    { x: tipX * 0.1, y: 0.05, z: tipZ * 0.1, r: 0.078 },
    { x: tipX * 0.45, y: H * 0.45, z: tipZ * 0.45, r: 0.066 },
    { x: tipX * 0.8, y: H * 0.82, z: tipZ * 0.8, r: 0.058 },
    { x: tipX, y: H, z: tipZ, r: 0.05 },
  ], { radial: 7, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.11, seed: 7600 + index, closeStart: true });
  P.add('timber', post);

  /* two iron collars and a bracket wedge — a reason the basket stays on */
  for (let i = 0; i < 2; i++) {
    const t = 0.72 + i * 0.2;
    const ring = ringGeo(0.068 - i * 0.006, 0.012, 4, 13);
    xform(ring, { pos: [tipX * t, H * t, tipZ * t], euler: [Math.PI / 2, 0, 0] });
    P.add('metalDark', ring);
  }

  /* open fire basket: six bowed bars and a rim */
  const bR = 0.175, bY = H - 0.02, bH = 0.24;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 6.283 + rand() * 0.16;
    P.add('metalDark', bar(
      [tipX + Math.cos(a) * bR * 0.32, bY, tipZ + Math.sin(a) * bR * 0.32],
      [tipX + Math.cos(a) * bR, bY + bH, tipZ + Math.sin(a) * bR],
      0.014, 0.011, { bow: 0.035, bowAxis: [-Math.cos(a), 0, -Math.sin(a)], seed: 7610 + i, nodes: 4 }
    ));
  }
  const basin = latheGeo([
    [bR * 0.16, bY - 0.05], [bR * 0.5, bY - 0.03], [bR * 0.72, bY + 0.01], [bR * 0.66, bY + 0.03],
  ], { seg: 12, uTile: 1 / 0.34, seed: 7620 + index, lobeAmt: 0.05, lobes: 6, capBottom: true });
  xform(basin, { pos: [tipX, 0, tipZ] });
  P.add('metalDark', basin);
  const rim = ringGeo(bR * 0.99, 0.015, 4, 16);
  xform(rim, { pos: [tipX, bY + bH, tipZ], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', rim);
  const mid = ringGeo(bR * 0.76, 0.010, 4, 14);
  xform(mid, { pos: [tipX, bY + bH * 0.55, tipZ], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', mid);

  const coals = coalBed(rand, { r: bR * 0.62, y: bY + 0.02, count: 10, size: 0.05, flat: 0.5 });
  xform(coals, { pos: [tipX, 0, tipZ] });
  P.add('coal', coals, { cast: false });

  P.flame(tipX, bY + 0.06, tipZ, 2.0, 'fire');
  P.flame(tipX + 0.05, bY + 0.03, tipZ - 0.04, 1.1, 'fire');
  P.light({
    x: tipX, y: bY + 0.3, z: tipZ, intensity: 18, radius: 16,
    type: 'torch', kelvin: 1920, flicker: 1, shadow: true,
  });
  return P.build(7630 + index);
}

/* ------------------------------------------------------------------ *
 * 6 · hanging lantern — chain, iron cage, glass, candle. Origin at the hook.
 * ------------------------------------------------------------------ */

export function hangingLantern(rand, index = 0) {
  const P = new PartSet();
  const drop = 0.42 + (index % 3) * 0.16;
  const topY = -drop;
  const W = 0.088;                                        // half-width of the cage
  const bodyH = 0.24;

  /* hook + chain */
  const hook = ringGeo(0.026, 0.008, 4, 11);
  xform(hook, { pos: [0, -0.02, 0], euler: [0, 0, 0.3] });
  P.add('metalDark', hook);
  const chain = chainGeo({
    end: [0, topY + 0.04, 0], links: Math.max(4, Math.round(drop / 0.062)),
    linkR: 0.024, wire: 0.0075, slack: 0.012, seed: 7700 + index,
  });
  P.add('metalDark', chain, { cast: false });

  /* pyramidal cap + finial */
  const cap = latheGeo([[W * 1.28, topY], [W * 1.16, topY + 0.012], [W * 0.62, topY + 0.055], [0.012, topY + 0.082]],
    { seg: 4, uTile: 1 / 0.34, seed: 7710 + index, lobeAmt: 0.01, lobes: 4, capBottom: true, capTop: true });
  xform(cap, { rotY: Math.PI / 4 });
  P.add('metalDark', cap);
  const fin = latheGeo([[0.016, topY + 0.078], [0.011, topY + 0.1]], { seg: 5, uTile: 1 / 0.34, seed: 7712, capTop: true });
  P.add('metalDark', fin);

  /* four corner posts + top and bottom frames */
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i / 4) * 6.283;
    const px = Math.cos(a) * W, pz = Math.sin(a) * W;
    P.add('metalDark', bar([px, topY, pz], [px, topY - bodyH, pz], 0.008, 0.008, { seed: 7720 + i, nodes: 2 }));
  }
  for (const y of [topY - 0.004, topY - bodyH + 0.004]) {
    for (let i = 0; i < 4; i++) {
      const a0 = Math.PI / 4 + (i / 4) * 6.283, a1 = Math.PI / 4 + ((i + 1) / 4) * 6.283;
      P.add('metalDark', bar(
        [Math.cos(a0) * W, y, Math.sin(a0) * W],
        [Math.cos(a1) * W, y, Math.sin(a1) * W], 0.007, 0.007, { seed: 7730 + i, nodes: 2 }
      ));
    }
  }
  const base = plate(W * 1.9, 0.018, W * 1.9, 0.006);
  xform(base, { pos: [0, topY - bodyH - 0.012, 0], rotY: Math.PI / 4 });
  P.add('metalDark', base);

  /* four soot-fogged glass panes */
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * 6.283;
    const pane = plate(W * 1.32, bodyH - 0.02, 0.004, 0.001);
    xform(pane, { pos: [Math.cos(a) * W * 0.99, topY - bodyH * 0.5, Math.sin(a) * W * 0.99], rotY: -a });
    P.add('glass', pane, { cast: false, wear: false });
  }

  /* the candle that is actually burning */
  const candY = topY - bodyH + 0.01;
  const cand = latheGeo([
    [0.026, candY], [0.023, candY + 0.02], [0.0225, candY + 0.075], [0.024, candY + 0.09], [0.020, candY + 0.1],
  ], { seg: 8, uTile: 1 / 0.22, seed: 7740 + index, lobeAmt: 0.16, lobes: 5, capTop: true, capBottom: true });
  P.add('wax', cand, { cast: false });

  P.flame(0, candY + 0.1, 0, 0.62, 'candle');
  P.light({
    x: 0, y: candY + 0.11, z: 0, intensity: 7.5, radius: 8.5,
    type: 'candle', kelvin: 2050, flicker: 0.85, shadow: false,
  });
  return P.build(7750 + index);
}

/* ------------------------------------------------------------------ *
 * 7 · candle cluster — varied heights, wax drips, small flames
 * ------------------------------------------------------------------ */

export function candleCluster(rand, index = 0) {
  const P = new PartSet();
  const n = 3 + (index % 3) * 2;
  const spread = 0.10 + (index % 3) * 0.045;

  /* the pooled wax they have all melted into */
  const pool = latheGeo([
    [spread * 1.9, 0], [spread * 1.82, 0.011], [spread * 1.45, 0.021], [spread * 0.7, 0.028], [0.02, 0.031],
  ], { seg: 15, uTile: 1 / 0.22, seed: 7800 + index, lobeAmt: 0.24, lobes: 7, capTop: true });
  P.add('wax', pool, { cast: false });

  /* a chipped stone paten under it, so the cluster has a reason to be here */
  if (index % 2 === 0) {
    const dish = shardGeo({
      w: spread * 4.4, h: 0.035, d: spread * 4.0, seed: 7805 + index,
      seg: 1, rough: 0.2, uTile: 1, bevel: 0.012,
    });
    xform(dish, { pos: [0, 0.015, 0], euler: [(rand() - 0.5) * 0.06, rand() * 6.283, (rand() - 0.5) * 0.06] });
    P.add('stoneCold', dish);
  }

  let tallest = 0;
  for (let i = 0; i < n; i++) {
    const a = rand() * 6.283;
    const d = Math.pow(rand(), 0.6) * spread;
    const h = 0.055 + Math.pow(rand(), 1.4) * 0.22;
    const r = 0.019 + rand() * 0.012;
    const px = Math.cos(a) * d, pz = Math.sin(a) * d;
    const tip = 0.026 + h;
    if (tip > tallest) tallest = tip;
    /* drips: the profile bulges irregularly and flares where wax ran down */
    const cand = latheGeo([
      [r * 1.32, 0.02], [r * 1.08, 0.045], [r, h * 0.42 + 0.05], [r * 0.94, h * 0.78 + 0.05],
      [r * 1.06, h * 0.9 + 0.05], [r * 0.86, h + 0.026],
    ], { seg: 8, uTile: 1 / 0.22, seed: 7810 + i * 11, lobeAmt: 0.2, lobes: 5, capTop: true, capBottom: true });
    xform(cand, { pos: [px, 0, pz], euler: [(rand() - 0.5) * 0.16, rand() * 6.283, (rand() - 0.5) * 0.16] });
    P.add('wax', cand, { cast: false });
    /* wick — a millimetre of char, but it is what sells the flame's origin */
    const wick = bar([px, tip - 0.004, pz], [px + (rand() - 0.5) * 0.006, tip + 0.012, pz], 0.0022, 0.0016,
      { radial: 3, seed: 7820 + i, nodes: 2 });
    P.add('barkCharred', wick, { cast: false });
    P.flame(px, tip + 0.006, pz, 0.34 + rand() * 0.2, 'candle');
  }

  P.light({
    x: 0, y: tallest * 0.7 + 0.06, z: 0,
    intensity: 4.2 + n * 0.42, radius: 5.5 + n * 0.18,
    type: 'candle', kelvin: 2100, flicker: 0.9, shadow: false,
  });
  return P.build(7830 + index);
}

/* ------------------------------------------------------------------ *
 * 8 · hell brazier — obsidian bowl on a bone tripod, green-shifted fire
 * ------------------------------------------------------------------ */

export function hellBrazier(rand, index = 0) {
  const P = new PartSet();
  const R = 0.42, H = 0.9;

  /* three cracked basalt legs */
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * 6.283 + rand() * 0.3;
    const g = shardGeo({
      w: 0.16, h: H * 0.92, d: 0.15, seed: 7900 + index * 13 + i,
      seg: 2, rough: 0.3, uTile: 1, bevel: 0.03,
    });
    xform(g, {
      pos: [Math.cos(a) * R * 0.6, H * 0.44, Math.sin(a) * R * 0.6],
      euler: [Math.cos(a) * 0.14, a, -Math.sin(a) * 0.14],
    });
    P.add('stone', g);
  }
  /* the dish: heavy, chipped, cracked */
  const bowl = latheGeo([
    [R * 0.4, H - 0.1], [R * 0.78, H - 0.02], [R, H + 0.08], [R * 1.06, H + 0.14],
    [R * 0.97, H + 0.15], [R * 0.86, H + 0.05], [R * 0.34, H - 0.03],
  ], { seg: 16, uTile: 1 / 1.65, seed: 7910 + index, lobeAmt: 0.05, lobes: 8, capBottom: true });
  P.add('stone', bowl);

  P.add('coal', coalBed(rand, { r: R * 0.74, y: H + 0.0, count: 14, size: R * 0.22, flat: 0.5 }), { cast: false });
  /* skulls in the fuel: this is hell, not a campsite */
  for (let i = 0; i < 2; i++) {
    const a = rand() * 6.283;
    const sk = rockGeo({
      radius: 0.075, detail: 1, warp: 0.22, squash: [0.9, 1.0, 1.15], flatten: 0.22,
      seed: 7920 + i, uTile: 1, shear: 0.1,
    });
    xform(sk, { pos: [Math.cos(a) * R * 0.4, H + 0.09, Math.sin(a) * R * 0.4], euler: [rand(), rand() * 6.28, rand() * 0.4] });
    P.add('bone', sk, { cast: false });
  }

  P.flame(0, H + 0.14, 0, 2.9, 'hell');
  P.flame(R * 0.32, H + 0.1, -R * 0.24, 1.5, 'hell');
  P.flame(-R * 0.28, H + 0.09, R * 0.2, 1.2, 'hell');
  P.light({
    x: 0, y: H + 0.44, z: 0, intensity: 24, radius: 18,
    type: 'hellfire', kelvin: 2500, flicker: 1, shadow: true,
  });
  return P.build(7930 + index);
}

/* ------------------------------------------------------------------ *
 * registry
 * ------------------------------------------------------------------ */

export const FIXTURE_KINDS = {
  brazier: { fn: brazier, variants: 3, footprint: 0.5, tilt: 0.35, sink: 0.05, cast: true },
  campfire: { fn: campfire, variants: 2, footprint: 1.0, tilt: 0.55, sink: 0.06, cast: true },
  sconce: { fn: wallSconce, variants: 2, footprint: 0.25, tilt: 0, sink: 0, cast: false, mounted: true },
  torch: { fn: wallTorch, variants: 2, footprint: 0.25, tilt: 0, sink: 0, cast: false, mounted: true },
  post: { fn: torchPost, variants: 3, footprint: 0.55, tilt: 0.2, sink: 0.1, cast: true },
  lantern: { fn: hangingLantern, variants: 3, footprint: 0.2, tilt: 0, sink: 0, cast: false, mounted: true },
  candles: { fn: candleCluster, variants: 4, footprint: 0.4, tilt: 0.6, sink: 0.02, cast: false },
  hellBrazier: { fn: hellBrazier, variants: 2, footprint: 0.6, tilt: 0.3, sink: 0.06, cast: true },
};

/** Build one fixture variant. Never throws — a bad fixture must not kill init. */
export function buildFixture(kind, rand, index = 0) {
  const def = FIXTURE_KINDS[kind];
  if (!def) return null;
  try {
    const out = def.fn(rand, index);
    if (!out || !out.parts?.length) return null;
    return out;
  } catch (e) {
    console.warn(`[props] fixture "${kind}" failed —`, e);
    return null;
  }
}

void clamp01;
