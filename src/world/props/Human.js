/**
 * SANCTUM — human dressing.
 *
 * The evidence that people lived here and then stopped: coopered barrels, nailed
 * crates, a cart with its shafts down in the mud, sacks going to rot, fences
 * with posts missing, a cold anvil, a banner nobody took down.
 *
 * Construction rules, everywhere in this file:
 *   • Nothing is one primitive. A barrel is sixteen staves and three forged
 *     hoops; a crate is battens, planks and corner straps. The silhouette has to
 *     survive a close camera.
 *   • Every edge is bevelled and every part is slightly out of true. A perfectly
 *     square crate reads as a debug cube no matter what texture is on it.
 *   • Geometry carries true metre UVs, so `wood` (0.62 m tile) shows the same
 *     plank width on a crate, a cart and a fence.
 *   • Scale is the canonical table: barrel 0.55 dia x 0.85 h against a 1.85 m
 *     hero. Dressing that is 20 % too big destroys the read of the whole frame.
 */

import * as THREE from 'three';
import {
  tube, latheGeo, boxGeo, shardGeo, rockGeo, clothGeo, mergeParts, xform, finish,
  bakeWear, setWind, clamp01, lerp,
} from './Geo.js';
import { PartSet, ringGeo, plate, bar } from './Fixtures.js';

const TAU = Math.PI * 2;

/** Iron hoop lying in a horizontal plane at height y, radius r. */
function hoop(r, y, wire = 0.016, seg = 20) {
  const g = ringGeo(r, wire, 4, seg);
  xform(g, { pos: [0, y, 0], euler: [Math.PI / 2, 0, 0] });
  return g;
}

/** A sawn plank with slightly tapered, chipped ends. */
function plank(w, h, d, seed, rough = 0.055) {
  return shardGeo({ w, h, d, seed, seg: 1, rough, uTile: 1, bevel: Math.min(w, h, d) * 0.22 });
}

/* ================================================================== *
 * crates
 * ================================================================== */

function crateBody(P, rand, s, seed, at = [0, 0, 0], ry = 0, matName = 'wood') {
  const parts = [];
  const half = s * 0.5;
  const bat = s * 0.085;
  /* corner battens */
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    const g = plank(bat, s * 0.99, bat, seed + i, 0.07);
    xform(g, { pos: [sx * (half - bat * 0.45), half, sz * (half - bat * 0.45)] });
    parts.push(g);
  }
  /* three planks per side, gapped and never quite level */
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * TAU;
    const nx = Math.cos(a), nz = Math.sin(a);
    for (let k = 0; k < 3; k++) {
      const ph = s * 0.29;
      const y = s * (0.16 + k * 0.32) + (rand() - 0.5) * 0.006;
      const g = plank(s * 0.9, ph * 0.9, s * 0.055, seed + f * 11 + k * 3);
      xform(g, {
        pos: [nx * (half - s * 0.028), y, nz * (half - s * 0.028)],
        euler: [0, -a, (rand() - 0.5) * 0.02],
      });
      parts.push(g);
    }
  }
  /* lid boards */
  for (let k = 0; k < 3; k++) {
    const g = plank(s * 0.92, s * 0.045, s * 0.29, seed + 40 + k);
    xform(g, {
      pos: [(rand() - 0.5) * 0.008, s * 0.985, (k - 1) * s * 0.31],
      euler: [(rand() - 0.5) * 0.02, (rand() - 0.5) * 0.02, 0],
    });
    parts.push(g);
  }
  const wood = mergeParts(parts);
  if (wood) {
    xform(wood, { pos: at, rotY: ry });
    P.add(matName, wood);
  }
  /* iron corner straps on two opposing edges + nail heads */
  const iron = [];
  for (const sgn of [-1, 1]) {
    for (const yy of [s * 0.12, s * 0.86]) {
      const g = plate(s * 1.01, s * 0.06, s * 0.035, 0.008);
      xform(g, { pos: [0, yy, sgn * half * 1.0] });
      iron.push(g);
    }
  }
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
    const n = latheGeo([[0.011, 0], [0.008, 0.008]], { seg: 5, uTile: 1 / 0.34, seed: seed + 60 + i, capTop: true });
    xform(n, { pos: [sx * (half - 0.03), s * 0.49, sz * half * 1.01], euler: [Math.PI / 2, 0, 0] });
    iron.push(n);
  }
  const im = mergeParts(iron);
  if (im) {
    xform(im, { pos: at, rotY: ry });
    P.add('metalDark', im);
  }
}

export function crate(rand, index = 0) {
  const P = new PartSet();
  const seed = 8000 + index * 71;
  if (index % 4 === 1) {
    /* a stacked pair, the top one shoved off true */
    const s0 = 0.66;
    crateBody(P, rand, s0, seed, [0, 0, 0], rand() * 0.3);
    crateBody(P, rand, s0 * 0.82, seed + 200, [(rand() - 0.5) * 0.16, s0 * 1.0, (rand() - 0.5) * 0.16], rand() * 0.9, 'woodDark');
  } else if (index % 4 === 2) {
    /* tipped on its side, lid sprung */
    const s0 = 0.6;
    const inner = new PartSet();
    crateBody(inner, rand, s0, seed);
    const built = inner.build(seed, { wood: false, woodDark: false, metalDark: false });
    for (const p of built.parts) {
      xform(p.geo, { euler: [Math.PI * 0.5, 0, 0], pos: [0, s0 * 0.5, 0] });
      P.add(p.matName, p.geo);
    }
    const lid = plank(s0 * 0.9, 0.045, s0 * 0.3, seed + 90);
    xform(lid, { pos: [s0 * 0.62, 0.03, s0 * 0.34], euler: [0.06, rand() * TAU, 0.1] });
    P.add('wood', lid);
  } else if (index % 4 === 3) {
    /* long chest with a domed lid */
    const w = 0.95, d = 0.5, h = 0.5;
    const body = [];
    for (let f = 0; f < 2; f++) {
      for (let k = 0; k < 3; k++) {
        const g = plank(w * 0.95, h * 0.28, 0.05, seed + f * 13 + k);
        xform(g, { pos: [0, h * (0.14 + k * 0.3), (f ? 1 : -1) * d * 0.48] });
        body.push(g);
      }
    }
    for (const sgn of [-1, 1]) {
      const g = plank(0.05, h * 0.94, d * 0.94, seed + 30 + sgn);
      xform(g, { pos: [sgn * w * 0.48, h * 0.47, 0] });
      body.push(g);
    }
    // domed lid: three boards stepped up toward the centre line, which reads as
    // a coopered chest top without needing a swept surface
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * d * 0.31;
      const rise = k === 1 ? 0.055 : 0;
      const g = plank(w * 0.97, 0.055, d * 0.3, seed + 50 + k);
      xform(g, { pos: [0, h * 0.94 + rise, off], euler: [(k - 1) * -0.16, 0, 0] });
      body.push(g);
    }
    const wm = mergeParts(body);
    if (wm) P.add('woodDark', wm);
    const iron = [];
    for (const sgn of [-1, 1]) {
      const g = plate(0.05, h * 1.0, d * 1.02, 0.008);
      xform(g, { pos: [sgn * w * 0.3, h * 0.5, 0] });
      iron.push(g);
    }
    const lock = plate(0.1, 0.11, 0.03, 0.008);
    xform(lock, { pos: [0, h * 0.72, -d * 0.5] });
    iron.push(lock);
    const im = mergeParts(iron);
    if (im) P.add('metalDark', im);
  } else {
    crateBody(P, rand, 0.7, seed, [0, 0, 0], 0);
  }
  return P.build(seed);
}

export function crateBroken(rand, index = 0) {
  const P = new PartSet();
  const seed = 8100 + index * 67;
  const s = 0.68;
  /* the bottom survived; everything above it is planks on the floor */
  const base = [];
  for (let k = 0; k < 3; k++) {
    const g = plank(s * 0.92, 0.045, s * 0.3, seed + k);
    xform(g, { pos: [0, 0.03, (k - 1) * s * 0.31], euler: [0, (rand() - 0.5) * 0.06, 0] });
    base.push(g);
  }
  for (let i = 0; i < 2; i++) {
    const g = plank(s * 0.09, s * 0.42, s * 0.09, seed + 20 + i);
    xform(g, { pos: [(i ? 1 : -1) * s * 0.42, s * 0.2, -s * 0.4], euler: [0.1, 0, (rand() - 0.5) * 0.3] });
    base.push(g);
  }
  /* scattered splinters, radiating out from where it burst */
  for (let i = 0; i < 9; i++) {
    const a = rand() * TAU;
    const d = 0.2 + rand() * 0.55;
    const g = plank(s * (0.2 + rand() * 0.6), 0.035 + rand() * 0.02, s * (0.1 + rand() * 0.18), seed + 40 + i, 0.2);
    xform(g, {
      pos: [Math.cos(a) * d, 0.025 + rand() * 0.05, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 0.6, rand() * TAU, (rand() - 0.5) * 0.6],
    });
    base.push(g);
  }
  const wm = mergeParts(base);
  if (wm) P.add('wood', wm);
  /* a bent strap and some nails */
  const iron = [];
  const strap = plate(s * 0.9, 0.05, 0.03, 0.008);
  xform(strap, { pos: [(rand() - 0.5) * 0.3, 0.03, 0.42], euler: [0.1, rand() * TAU, 0.06] });
  iron.push(strap);
  const im = mergeParts(iron);
  if (im) P.add('metalDark', im);
  /* what was inside */
  for (let i = 0; i < 4; i++) {
    const a = rand() * TAU, d = rand() * 0.3;
    const g = rockGeo({ radius: 0.05 + rand() * 0.03, detail: 1, warp: 0.3, squash: [1, 0.7, 1], flatten: 0.3, seed: seed + 70 + i, uTile: 1 });
    xform(g, { pos: [Math.cos(a) * d, 0.05, Math.sin(a) * d], rotY: rand() * TAU });
    P.add('sack', g, { cast: false });
  }
  return P.build(seed);
}

/* ================================================================== *
 * barrels — staves and forged hoops, never a smooth cylinder
 * ================================================================== */

const BARREL = { r: 0.275, h: 0.85, staves: 16 };

function barrelBody(P, rand, seed, { r = BARREL.r, h = BARREL.h, open = false, mat = 'wood' } = {}) {
  const prof = [
    [r * 0.80, 0.0], [r * 0.86, h * 0.05], [r * 0.965, h * 0.24],
    [r, h * 0.45], [r * 0.965, h * 0.7], [r * 0.87, h * 0.93], [r * 0.81, h],
  ];
  const body = latheGeo(prof, {
    seg: BARREL.staves, uTile: 1 / 0.62, seed, lobeAmt: 0.05, lobes: BARREL.staves,
    capBottom: true, capTop: !open,
  });
  P.add(mat, body);
  /* three hoops, the middle one wider — a cooper's proportions */
  const hoops = [];
  hoops.push(hoop(r * 0.845, h * 0.055, 0.015));
  hoops.push(hoop(r * 0.99, h * 0.4, 0.019));
  hoops.push(hoop(r * 0.99, h * 0.55, 0.014));
  hoops.push(hoop(r * 0.855, h * 0.94, 0.015));
  const hm = mergeParts(hoops);
  if (hm) P.add('metalDark', hm);
  if (open) {
    /* rim + a little standing water inside */
    const rim = hoop(r * 0.82, h - 0.01, 0.012, 18);
    P.add('metalDark', rim);
  } else {
    /* lid boards and a bung */
    const lid = [];
    for (let k = 0; k < 3; k++) {
      const g = plank(r * 1.5, 0.028, r * 0.52, seed + 30 + k);
      xform(g, { pos: [0, h + 0.012, (k - 1) * r * 0.55] });
      lid.push(g);
    }
    const lm = mergeParts(lid);
    if (lm) P.add('woodDark', lm);
    const bung = latheGeo([[0.028, h + 0.02], [0.022, h + 0.042]], { seg: 6, uTile: 1 / 0.62, seed: seed + 51, capTop: true });
    xform(bung, { pos: [r * 0.36, 0, r * 0.1] });
    P.add('woodDark', bung, { cast: false });
  }
  void rand;
}

export function barrel(rand, index = 0) {
  const P = new PartSet();
  const seed = 8200 + index * 73;
  if (index % 4 === 2) {
    /* on its side, chocked with a stone so it does not roll */
    const inner = new PartSet();
    barrelBody(inner, rand, seed, { open: false });
    const built = inner.build(seed, { wood: false, woodDark: false, metalDark: false });
    for (const p of built.parts) {
      xform(p.geo, { euler: [Math.PI / 2, 0, 0], pos: [0, BARREL.r, -BARREL.h * 0.5] });
      P.add(p.matName, p.geo);
    }
    const chock = rockGeo({ radius: 0.1, detail: 1, warp: 0.35, squash: [1.2, 0.7, 1], flatten: 0.35, seed: seed + 90, uTile: 1 });
    xform(chock, { pos: [BARREL.r * 0.9, 0.05, 0.1], rotY: rand() * TAU });
    P.add('stoneCold', chock);
  } else if (index % 4 === 3) {
    /* short open cask, half full of rainwater */
    barrelBody(P, rand, seed, { r: 0.3, h: 0.58, open: true, mat: 'woodDark' });
  } else if (index % 4 === 1) {
    /* stacked on a low pallet */
    const pal = [];
    for (let k = 0; k < 3; k++) {
      const g = plank(0.72, 0.04, 0.16, seed + k);
      xform(g, { pos: [0, 0.02, (k - 1) * 0.22] });
      pal.push(g);
    }
    const pm = mergeParts(pal);
    if (pm) P.add('timber', pm);
    const inner = new PartSet();
    barrelBody(inner, rand, seed + 300);
    const built = inner.build(seed, { wood: false, woodDark: false, metalDark: false });
    for (const p of built.parts) {
      xform(p.geo, { pos: [0, 0.04, 0] });
      P.add(p.matName, p.geo);
    }
  } else {
    barrelBody(P, rand, seed);
  }
  return P.build(seed);
}

export function barrelBroken(rand, index = 0) {
  const P = new PartSet();
  const seed = 8300 + index * 79;
  const r = BARREL.r, h = BARREL.h;
  /* the bottom third still standing, staves above it splayed out */
  const stump = latheGeo([
    [r * 0.80, 0], [r * 0.88, h * 0.06], [r * 0.95, h * 0.2], [r * 0.93, h * 0.28],
  ], { seg: BARREL.staves, uTile: 1 / 0.62, seed, lobeAmt: 0.06, lobes: BARREL.staves, capBottom: true });
  P.add('wood', stump);
  const staves = [];
  for (let i = 0; i < 11; i++) {
    const a = rand() * TAU;
    const out = 0.22 + rand() * 0.45;
    const g = plank(0.07 + rand() * 0.03, h * (0.35 + rand() * 0.5), 0.026, seed + i * 7, 0.16);
    const fall = 1.0 + rand() * 0.5;
    xform(g, {
      pos: [Math.cos(a) * out, 0.03 + rand() * 0.06, Math.sin(a) * out],
      euler: [Math.cos(a) * fall, a, Math.sin(a) * fall],
    });
    staves.push(g);
  }
  const sm = mergeParts(staves);
  if (sm) P.add('wood', sm);
  /* hoops: one still on the stump, two sprung and lying flat */
  const iron = [hoop(r * 0.86, h * 0.06, 0.015)];
  for (let i = 0; i < 2; i++) {
    const a = rand() * TAU, d = 0.3 + rand() * 0.35;
    const g = ringGeo(r * (0.95 + rand() * 0.18), 0.016, 4, 18);
    xform(g, {
      pos: [Math.cos(a) * d, 0.02, Math.sin(a) * d],
      euler: [Math.PI / 2 + (rand() - 0.5) * 0.5, rand() * TAU, (rand() - 0.5) * 0.5],
    });
    iron.push(g);
  }
  const im = mergeParts(iron);
  if (im) P.add('metalDark', im);
  return P.build(seed);
}

/* ================================================================== *
 * urns — thin-walled, and the most satisfying thing in the game to break
 * ================================================================== */

export function urn(rand, index = 0) {
  const P = new PartSet();
  const seed = 8400 + index * 83;
  const spec = [
    { r: 0.155, h: 0.42, neck: 0.075 },
    { r: 0.12, h: 0.3, neck: 0.06 },
    { r: 0.185, h: 0.52, neck: 0.09 },
  ][index % 3];
  const { r, h, neck } = spec;
  const body = latheGeo([
    [r * 0.34, 0], [r * 0.62, h * 0.06], [r * 0.94, h * 0.22], [r, h * 0.4],
    [r * 0.9, h * 0.6], [r * 0.62, h * 0.8], [neck * 1.05, h * 0.9],
    [neck, h * 0.96], [neck * 1.18, h], [neck * 1.05, h * 0.99],
  ], { seg: 14, uTile: 1 / 1.65, seed, lobeAmt: 0.035, lobes: 7, capBottom: true });
  P.add('stoneWarm', body);
  /* two handles: this is the detail that stops it reading as a lathe test */
  if (index % 3 !== 1) {
    for (const sgn of [-1, 1]) {
      const sp = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const ang = -0.4 + t * 2.1;
        sp.push({
          x: sgn * (neck * 1.1 + Math.sin(ang) * r * 0.42),
          y: h * 0.9 - t * h * 0.3 - Math.max(0, Math.sin(ang * 0.7)) * 0.01,
          z: 0,
          r: 0.014,
        });
      }
      const g = tube(sp, { radial: 5, uTile: 1 / 1.65, lobes: 3, lobeAmt: 0.1, seed: seed + 10, closeStart: true });
      if (g) P.add('stoneWarm', g);
    }
  }
  return P.build(seed);
}

export function urnBroken(rand, index = 0) {
  const P = new PartSet();
  const seed = 8500 + index * 89;
  const r = [0.155, 0.12, 0.185][index % 3];
  const h = [0.42, 0.3, 0.52][index % 3];
  const base = latheGeo([
    [r * 0.34, 0], [r * 0.66, h * 0.06], [r * 0.95, h * 0.2], [r * 0.98, h * 0.3],
  ], { seg: 13, uTile: 1 / 1.65, seed, lobeAmt: 0.05, lobes: 7, capBottom: true });
  /* bite a ragged rim out of the survivor */
  {
    const p = base.attributes.position.array;
    for (let i = 0; i < base.attributes.position.count; i++) {
      const o = i * 3;
      if (p[o + 1] > h * 0.16) {
        const a = Math.atan2(p[o + 2], p[o]);
        const bite = clamp01(Math.cos(a * 2 + index) * 0.5 + 0.5);
        p[o + 1] -= bite * h * 0.16;
      }
    }
    base.computeVertexNormals();
  }
  P.add('stoneWarm', base);
  const shards = [];
  for (let i = 0; i < 11; i++) {
    const a = rand() * TAU;
    const d = 0.12 + Math.pow(rand(), 0.6) * 0.5;
    const s = 0.03 + rand() * 0.06;
    const g = shardGeo({
      w: s * (1 + rand()), h: 0.012 + rand() * 0.012, d: s * (0.7 + rand() * 0.9),
      seed: seed + i * 11, seg: 1, rough: 0.3, uTile: 1, bevel: 0.005,
    });
    xform(g, {
      pos: [Math.cos(a) * d, 0.012 + rand() * 0.02, Math.sin(a) * d],
      euler: [(rand() - 0.5) * 1.5, rand() * TAU, (rand() - 0.5) * 1.5],
    });
    shards.push(g);
  }
  const sm = mergeParts(shards);
  if (sm) P.add('stoneWarm', sm, { cast: false });
  return P.build(seed);
}

/* ================================================================== *
 * sacks
 * ================================================================== */

export function sack(rand, index = 0) {
  const P = new PartSet();
  const seed = 8600 + index * 97;
  const upright = index % 3 !== 2;
  const R = 0.2 + (index % 3) * 0.02;
  const H = upright ? 0.56 : 0.3;
  const prof = upright
    ? [[R * 0.4, 0], [R * 0.88, 0.05], [R, H * 0.34], [R * 0.94, H * 0.6],
      [R * 0.6, H * 0.86], [R * 0.32, H * 0.95], [R * 0.4, H]]
    : [[R * 0.5, 0], [R * 1.1, 0.05], [R * 1.2, H * 0.5], [R * 0.9, H * 0.85], [R * 0.4, H]];
  const body = latheGeo(prof, {
    seg: 12, uTile: 1 / 0.28, seed, lobeAmt: 0.13, lobes: 6, capBottom: true, capTop: true,
  });
  if (!upright) xform(body, { scale: [1.45, 1, 0.95] });
  P.add('sack', body);
  /* the tie at the neck, and the folded cloth above it */
  if (upright) {
    const tie = ringGeo(R * 0.34, 0.012, 4, 12);
    xform(tie, { pos: [0, H * 0.93, 0], euler: [Math.PI / 2, 0, 0] });
    P.add('leather', tie, { cast: false });
    const ear = latheGeo([[R * 0.3, H], [R * 0.22, H + 0.05], [R * 0.08, H + 0.075]],
      { seg: 6, uTile: 1 / 0.28, seed: seed + 7, lobeAmt: 0.3, lobes: 4, capTop: true });
    xform(ear, { euler: [0.3, rand() * TAU, 0.2] });
    P.add('sack', ear, { cast: false });
  }
  /* spilled grain */
  if (index % 3 === 1) {
    const spill = latheGeo([[R * 1.5, 0], [R * 1.2, 0.014], [R * 0.5, 0.026], [0.02, 0.03]],
      { seg: 11, uTile: 1 / 0.85, seed: seed + 21, lobeAmt: 0.24, lobes: 6, capTop: true });
    xform(spill, { pos: [R * 1.1, 0, R * 0.4] });
    P.add('ash', spill, { cast: false });
  }
  return P.build(seed);
}

/* ================================================================== *
 * cart
 * ================================================================== */

function wheelGeo(rand, R, seed) {
  const parts = [];
  const felloe = ringGeo(R * 0.9, 0.05, 5, 22);
  parts.push(felloe);
  const tyre = ringGeo(R, 0.022, 4, 26);
  parts.push(tyre);
  const hubG = latheGeo([[0.05, -0.07], [0.075, -0.04], [0.08, 0.04], [0.05, 0.07]],
    { seg: 9, uTile: 1 / 0.62, seed: seed + 3, lobeAmt: 0.04, lobes: 6, capTop: true, capBottom: true });
  xform(hubG, { euler: [Math.PI / 2, 0, 0] });
  parts.push(hubG);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + rand() * 0.04;
    const g = bar([Math.cos(a) * 0.07, Math.sin(a) * 0.07, 0], [Math.cos(a) * R * 0.87, Math.sin(a) * R * 0.87, 0],
      0.021, 0.017, { radial: 5, seed: seed + 10 + i, nodes: 2 });
    if (g) parts.push(g);
  }
  return mergeParts(parts);
}

export function cart(rand, index = 0) {
  const P = new PartSet();
  const seed = 8700 + index * 101;
  const L = 2.05, W = 1.15, R = 0.44;
  const bedY = R * 0.98;

  /* bed planks running the length, with a gap where one is missing */
  const wood = [];
  const nP = 6;
  for (let k = 0; k < nP; k++) {
    if (k === 4 && index % 2 === 1) continue;
    const g = plank(L * 0.98, 0.045, W / nP * 0.88, seed + k);
    xform(g, { pos: [0, bedY, -W * 0.5 + (k + 0.5) * (W / nP)], euler: [0, 0, (rand() - 0.5) * 0.012] });
    wood.push(g);
  }
  /* two chassis beams under it */
  for (const sgn of [-1, 1]) {
    const g = plank(L * 1.02, 0.08, 0.09, seed + 20 + sgn);
    xform(g, { pos: [0, bedY - 0.06, sgn * W * 0.34] });
    wood.push(g);
  }
  /* side rails on stanchions */
  for (const sgn of [-1, 1]) {
    const rail = plank(L * 0.9, 0.07, 0.05, seed + 30 + sgn);
    xform(rail, { pos: [0, bedY + 0.36, sgn * W * 0.46], euler: [0, 0, (rand() - 0.5) * 0.02] });
    wood.push(rail);
    for (let i = 0; i < 3; i++) {
      const g = plank(0.06, 0.4, 0.055, seed + 40 + i * 3 + (sgn > 0 ? 1 : 0));
      xform(g, { pos: [(i - 1) * L * 0.36, bedY + 0.19, sgn * W * 0.46] });
      wood.push(g);
    }
  }
  /* headboard */
  const head = plank(0.06, 0.5, W * 0.94, seed + 60);
  xform(head, { pos: [-L * 0.49, bedY + 0.25, 0] });
  wood.push(head);
  /* shafts, resting on the ground */
  for (const sgn of [-1, 1]) {
    const g = bar([L * 0.46, bedY - 0.04, sgn * W * 0.3], [L * 1.15, 0.07, sgn * W * 0.22],
      0.045, 0.033, { radial: 6, seed: seed + 70, nodes: 4 });
    if (g) wood.push(g);
  }
  const wm = mergeParts(wood);
  if (wm) P.add('timber', wm);

  /* axle + wheels */
  const iron = [];
  const axle = bar([0, bedY - 0.1, -W * 0.62], [0, bedY - 0.1, W * 0.62], 0.03, 0.03, { radial: 6, seed: seed + 80, nodes: 2 });
  if (axle) iron.push(axle);
  const im = mergeParts(iron);
  if (im) P.add('metalDark', im);

  for (const sgn of [-1, 1]) {
    const g = wheelGeo(rand, R, seed + (sgn > 0 ? 100 : 200));
    if (!g) continue;
    xform(g, { pos: [0, R, sgn * W * 0.63], euler: [0, 0, 0] });
    // a wheel plane must face along Z: rotate the XY disc onto the XZ-normal
    xform(g, { pos: [0, 0, 0] });
    P.add('timber', g);
    const t = ringGeo(R, 0.024, 4, 26);
    xform(t, { pos: [0, R, sgn * W * 0.63] });
    P.add('metalDark', t);
  }

  /* freight */
  const inner = new PartSet();
  sackInto(inner, rand, seed + 400, [-L * 0.2, bedY + 0.02, W * 0.12]);
  sackInto(inner, rand, seed + 460, [L * 0.12, bedY + 0.02, -W * 0.14]);
  const built = inner.build(seed, { sack: false, leather: false });
  for (const p of built.parts) P.add(p.matName, p.geo);
  return P.build(seed);
}

function sackInto(P, rand, seed, at) {
  const R = 0.18, H = 0.3;
  const body = latheGeo([[R * 0.5, 0], [R * 1.05, 0.05], [R * 1.15, H * 0.5], [R * 0.85, H * 0.85], [R * 0.35, H]],
    { seg: 11, uTile: 1 / 0.28, seed, lobeAmt: 0.14, lobes: 6, capBottom: true, capTop: true });
  xform(body, { pos: at, euler: [0.1, rand() * TAU, 0.06], scale: [1.4, 1, 0.95] });
  P.add('sack', body);
}

/* ================================================================== *
 * ladder, fence, stake
 * ================================================================== */

export function ladder(rand, index = 0) {
  const P = new PartSet();
  const seed = 8800 + index * 103;
  const H = index % 2 ? 3.1 : 2.5;
  const lean = 0.24 + rand() * 0.07;
  const W = 0.42;
  const wood = [];
  for (const sgn of [-1, 1]) {
    const sp = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      sp.push({
        x: sgn * W * 0.5 * (1 - t * 0.08),
        y: t * H * Math.cos(lean),
        z: -t * H * Math.sin(lean),
        r: 0.035 - t * 0.006,
      });
    }
    const g = tube(sp, { radial: 5, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.12, seed: seed + (sgn > 0 ? 1 : 2), closeStart: true });
    if (g) wood.push(g);
  }
  const n = Math.max(6, Math.round(H / 0.32));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (i === (n >> 1) && index % 2 === 1) continue;                 // a broken rung
    const y = t * H * Math.cos(lean), z = -t * H * Math.sin(lean);
    const g = bar([-W * 0.5, y, z], [W * 0.5, y, z], 0.022, 0.022,
      { radial: 5, seed: seed + 20 + i, nodes: 2 });
    if (g) wood.push(g);
  }
  const wm = mergeParts(wood);
  if (wm) P.add('timber', wm);
  return P.build(seed);
}

export function fence(rand, index = 0) {
  const P = new PartSet();
  const seed = 8900 + index * 107;
  const span = 2.3, postH = 1.15;
  const wood = [];
  const nPost = 3;
  const skip = index % 3 === 1 ? 1 : -1;
  for (let i = 0; i < nPost; i++) {
    if (i === skip) continue;
    const x = (i / (nPost - 1) - 0.5) * span;
    const tilt = (rand() - 0.5) * 0.16;
    const h = postH * (0.85 + rand() * 0.3);
    const sp = [
      { x, y: -0.2, z: 0, r: 0.062 },
      { x: x + tilt * 0.3, y: h * 0.5, z: tilt * 0.2, r: 0.052 },
      { x: x + tilt, y: h, z: tilt * 0.6, r: 0.044 },
    ];
    const g = tube(sp, { radial: 5, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.14, seed: seed + i * 7, closeStart: true });
    if (g) wood.push(g);
  }
  /* rails: two courses, one snapped */
  for (let r = 0; r < 2; r++) {
    const y = 0.36 + r * 0.42;
    const frac = index % 3 === 2 && r === 1 ? 0.55 : 1;
    const g = bar([-span * 0.52, y + (rand() - 0.5) * 0.03, 0.03],
      [-span * 0.52 + span * 1.04 * frac, y + (rand() - 0.5) * 0.03, -0.02],
      0.036, 0.032, { radial: 5, seed: seed + 30 + r, nodes: 3, bow: 0.03 });
    if (g) wood.push(g);
  }
  const wm = mergeParts(wood);
  if (wm) P.add('timber', wm);
  /* lashings */
  const rope = [];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < nPost; i++) {
      if (i === skip) continue;
      const x = (i / (nPost - 1) - 0.5) * span;
      const g = ringGeo(0.055, 0.009, 4, 10);
      xform(g, { pos: [x, 0.36 + r * 0.42, 0.01], euler: [0, Math.PI / 2, 0.1] });
      rope.push(g);
    }
  }
  const rm = mergeParts(rope);
  if (rm) P.add('leather', rm, { cast: false });
  return P.build(seed);
}

export function stake(rand, index = 0) {
  const P = new PartSet();
  const seed = 9000 + index * 109;
  const H = [1.7, 2.15, 1.35][index % 3];
  const lean = 0.07 + rand() * 0.12;
  const a = rand() * TAU;
  const sp = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    sp.push({
      x: Math.cos(a) * lean * H * t * t,
      y: -0.24 + t * (H + 0.24),
      z: Math.sin(a) * lean * H * t * t,
      r: 0.055 * (1 - t * 0.62) * (t > 0.88 ? (1 - t) * 8 : 1),
    });
  }
  const g = tube(sp, { radial: 6, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.14, seed, closeStart: true });
  if (g) P.add('timber', g);
  /* a rag knotted round it, and it moves in the wind */
  if (index % 3 !== 2) {
    const cloth = clothGeo({
      w: 0.24, h: 0.42, segX: 4, segY: 6, sag: 0.1, fold: 0.05, taper: 0.3,
      seed: seed + 5, tatter: 0.3,
    });
    xform(cloth, {
      pos: [Math.cos(a) * lean * H * 0.5, H * 0.72, Math.sin(a) * lean * H * 0.5 + 0.05],
      rotY: rand() * TAU,
    });
    setWind(cloth, (x, y) => clamp01((H * 0.72 - y) / 0.42));
    P.add('cloth', cloth, { cast: false, side: THREE.DoubleSide });
    const tie = ringGeo(0.05, 0.008, 4, 9);
    xform(tie, { pos: [Math.cos(a) * lean * H * 0.5, H * 0.73, Math.sin(a) * lean * H * 0.5], euler: [Math.PI / 2, 0, 0.2] });
    P.add('leather', tie, { cast: false });
  }
  return P.build(seed);
}

/* ================================================================== *
 * weapon rack, anvil
 * ================================================================== */

export function weaponRack(rand, index = 0) {
  const P = new PartSet();
  const seed = 9100 + index * 113;
  const H = 1.35, W = 1.05;
  const wood = [];
  /* two crossed A-frames plus a top bar */
  for (const sgn of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      const g = bar([sgn * W * 0.5, 0, s2 * 0.28], [sgn * W * 0.5 * 0.35, H, 0], 0.04, 0.03,
        { radial: 5, seed: seed + 10 + sgn + s2, nodes: 3 });
      if (g) wood.push(g);
    }
  }
  const top = bar([-W * 0.42, H - 0.03, 0], [W * 0.42, H - 0.05, 0], 0.035, 0.035, { radial: 5, seed: seed + 20, nodes: 3 });
  if (top) wood.push(top);
  const lower = bar([-W * 0.46, 0.22, 0.06], [W * 0.46, 0.2, 0.06], 0.03, 0.03, { radial: 5, seed: seed + 21, nodes: 3 });
  if (lower) wood.push(lower);
  const wm = mergeParts(wood);
  if (wm) P.add('timber', wm);

  /* four polearms leaning in the rack, hafts at slightly different angles */
  const shafts = [], heads = [];
  const n = index % 2 ? 3 : 4;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) - 0.5) * W * 0.72 + (rand() - 0.5) * 0.05;
    const tz = (rand() - 0.5) * 0.1;
    const L = 1.95 + rand() * 0.35;
    const sp = [
      { x, y: 0.02, z: 0.18 + tz, r: 0.019 },
      { x: x * 0.9, y: H * 0.6, z: 0.05 + tz, r: 0.017 },
      { x: x * 0.8, y: L, z: -0.08 + tz, r: 0.014 },
    ];
    const g = tube(sp, { radial: 5, uTile: 1 / 0.62, lobes: 3, lobeAmt: 0.08, seed: seed + 40 + i, closeStart: true });
    if (g) shafts.push(g);
    /* a real spearhead, not a cone */
    const head = latheGeo([
      [0.012, L], [0.03, L + 0.05], [0.032, L + 0.13], [0.016, L + 0.24], [0.004, L + 0.3],
    ], { seg: 4, uTile: 1 / 0.34, seed: seed + 50 + i, lobeAmt: 0.02, lobes: 4, capTop: true, capBottom: true });
    xform(head, { pos: [x * 0.8, 0, -0.08 + tz], rotY: rand() });
    heads.push(head);
  }
  const sm = mergeParts(shafts);
  if (sm) P.add('wood', sm);
  const hm = mergeParts(heads);
  if (hm) P.add('metal', hm);

  /* a battered shield hooked on the frame */
  if (index % 2 === 0) {
    const sh = latheGeo([[0.28, 0], [0.27, 0.03], [0.2, 0.07], [0.08, 0.095], [0.0, 0.1]],
      { seg: 12, uTile: 1 / 0.4, seed: seed + 70, lobeAmt: 0.03, lobes: 8, capBottom: true });
    xform(sh, { pos: [-W * 0.5, 0.55, -0.16], euler: [Math.PI * 0.44, 0.4, 0.2] });
    P.add('leather', sh);
    const boss = latheGeo([[0.055, 0], [0.045, 0.03], [0.02, 0.05]],
      { seg: 8, uTile: 1 / 0.34, seed: seed + 71, capTop: true });
    xform(boss, { pos: [-W * 0.5, 0.55, -0.16], euler: [Math.PI * 0.44, 0.4, 0.2] });
    P.add('metal', boss, { cast: false });
  }
  return P.build(seed);
}

export function anvil(rand, index = 0) {
  const P = new PartSet();
  const seed = 9200 + index * 127;
  /* the stump it is bedded on */
  const stump = latheGeo([
    [0.24, -0.05], [0.225, 0.05], [0.215, 0.3], [0.225, 0.42], [0.21, 0.46],
  ], { seg: 11, uTile: 1 / 1.0, seed, lobeAmt: 0.09, lobes: 7, capTop: true, capBottom: true });
  P.add('timber', stump);
  const bandTop = hoop(0.222, 0.4, 0.012, 14);
  const bandBot = hoop(0.235, 0.06, 0.013, 14);
  const bm = mergeParts([bandTop, bandBot]);
  if (bm) P.add('metalDark', bm, { cast: false });

  /* the anvil itself: base, waist, body, horn, step */
  const iron = [];
  const base = plate(0.3, 0.07, 0.22, 0.014);
  xform(base, { pos: [0, 0.49, 0] });
  iron.push(base);
  const waist = plate(0.16, 0.1, 0.13, 0.02);
  xform(waist, { pos: [0, 0.57, 0] });
  iron.push(waist);
  const body = plate(0.46, 0.11, 0.155, 0.016);
  xform(body, { pos: [0.01, 0.665, 0] });
  iron.push(body);
  const step = plate(0.1, 0.055, 0.13, 0.012);
  xform(step, { pos: [-0.26, 0.64, 0] });
  iron.push(step);
  const hornSp = [];
  for (let k = 0; k <= 3; k++) {
    const t = k / 3;
    hornSp.push({ x: -0.3 - t * 0.22, y: 0.655 - t * 0.012, z: 0, r: 0.055 * (1 - t * 0.82) + 0.006 });
  }
  const horn = tube(hornSp, { radial: 7, uTile: 1 / 0.34, lobes: 3, lobeAmt: 0.05, seed: seed + 9, closeStart: true });
  if (horn) iron.push(horn);
  const im = mergeParts(iron);
  if (im) P.add('metal', im);

  /* a hammer left on the face, and tongs against the stump */
  if (index % 2 === 0) {
    const hh = plate(0.11, 0.05, 0.05, 0.01);
    xform(hh, { pos: [0.1, 0.75, 0.02], euler: [0, 0.4, 0.06] });
    P.add('metal', hh, { cast: false });
    const handle = bar([0.14, 0.735, 0.03], [0.36, 0.72, 0.11], 0.014, 0.011, { radial: 5, seed: seed + 30, nodes: 3 });
    if (handle) P.add('wood', handle, { cast: false });
  }
  return P.build(seed);
}

/* ================================================================== *
 * banner — a real sag curve, and it moves
 * ================================================================== */

export function banner(rand, index = 0) {
  const P = new PartSet();
  const seed = 9300 + index * 131;
  const H = [3.0, 3.5, 2.5][index % 3];
  const lean = (rand() - 0.5) * 0.05;
  const a = rand() * TAU;

  /* the pole, buried and slightly out of plumb */
  const sp = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    sp.push({
      x: Math.cos(a) * lean * H * t, y: -0.26 + t * (H + 0.26),
      z: Math.sin(a) * lean * H * t, r: 0.062 - t * 0.02,
    });
  }
  const pole = tube(sp, { radial: 6, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.1, seed, closeStart: true });
  if (pole) P.add('timber', pole);

  const topX = Math.cos(a) * lean * H, topZ = Math.sin(a) * lean * H;
  /* crossbar with iron ferrules */
  const cbW = 0.86;
  const cb = bar([topX - cbW * 0.5, H - 0.16, topZ], [topX + cbW * 0.5, H - 0.18, topZ],
    0.022, 0.02, { radial: 5, seed: seed + 5, nodes: 3 });
  if (cb) P.add('timber', cb);
  const fer = ringGeo(0.07, 0.012, 4, 12);
  xform(fer, { pos: [topX, H - 0.17, topZ], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', fer, { cast: false });
  /* finial */
  const fin = latheGeo([[0.05, H], [0.036, H + 0.08], [0.012, H + 0.2], [0.004, H + 0.26]],
    { seg: 6, uTile: 1 / 0.34, seed: seed + 7, lobeAmt: 0.04, lobes: 4, capTop: true, capBottom: true });
  xform(fin, { pos: [topX, 0, topZ] });
  P.add('bronze', fin);

  /* the cloth: catenary sag across the crossbar, ragged hem, wind-weighted */
  const cw = cbW * 0.92, ch = H * 0.52;
  const cloth = clothGeo({
    w: cw, h: ch, segX: 9, segY: 15, sag: 0.2, fold: 0.062, foldFreq: 2.9,
    taper: 0.12, seed: seed + 11, tatter: 0.22,
  });
  xform(cloth, { pos: [topX, H - 0.2, topZ + 0.035] });
  setWind(cloth, (x, y) => clamp01((H - 0.2 - y) / ch) * 0.92 + 0.08);
  P.add(index % 2 ? 'clothRed' : 'cloth', cloth, { cast: true, side: THREE.DoubleSide });

  /* the ties that hold it to the bar */
  const ties = [];
  for (let i = 0; i < 4; i++) {
    const g = ringGeo(0.018, 0.005, 3, 8);
    xform(g, { pos: [topX + (i / 3 - 0.5) * cw * 0.9, H - 0.19, topZ + 0.02], euler: [0, Math.PI / 2, 0] });
    ties.push(g);
  }
  const tm = mergeParts(ties);
  if (tm) P.add('leather', tm, { cast: false });
  return P.build(seed);
}

/* ================================================================== *
 * wood pile
 * ================================================================== */

export function woodPile(rand, index = 0) {
  const P = new PartSet();
  const seed = 9400 + index * 137;
  const rows = [3, 4, 2][index % 3];
  const len = 0.95;
  const logs = [];
  for (let row = 0; row < rows; row++) {
    const n = rows - row + 1;
    for (let i = 0; i < n; i++) {
      const r = 0.055 + rand() * 0.03;
      const sp = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        sp.push({
          x: (t - 0.5) * len * (0.85 + rand() * 0.25),
          y: Math.sin(t * Math.PI) * 0.008,
          z: (Math.sin(t * 4 + i) - 0.3) * 0.012,
          r: r * (0.9 + 0.18 * Math.sin(t * 3 + i)),
        });
      }
      const g = tube(sp, { radial: 6, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.13, seed: seed + row * 17 + i, closeStart: true });
      if (!g) continue;
      xform(g, {
        pos: [(rand() - 0.5) * 0.05, r + row * r * 1.85, (i - (n - 1) * 0.5) * r * 2.15],
        euler: [(rand() - 0.5) * 0.05, (rand() - 0.5) * 0.09, 0],
      });
      logs.push(g);
    }
  }
  /* two end stakes keep the stack up */
  for (const sgn of [-1, 1]) {
    const g = bar([sgn * len * 0.56, -0.14, -0.05], [sgn * len * 0.58, rows * 0.2 + 0.12, 0.02],
      0.035, 0.028, { radial: 5, seed: seed + 90 + sgn, nodes: 3 });
    if (g) logs.push(g);
  }
  const m = mergeParts(logs);
  if (m) P.add('timber', m);
  /* split kindling on the ground */
  const kind = [];
  for (let i = 0; i < 6; i++) {
    const a = rand() * TAU, d = len * 0.5 + rand() * 0.4;
    const g = plank(0.16 + rand() * 0.2, 0.035, 0.045, seed + 120 + i, 0.25);
    xform(g, { pos: [Math.cos(a) * d, 0.02, Math.sin(a) * d], euler: [(rand() - 0.5) * 0.3, rand() * TAU, (rand() - 0.5) * 0.3] });
    kind.push(g);
  }
  const km = mergeParts(kind);
  if (km) P.add('woodDark', km, { cast: false });
  return P.build(seed);
}

/* ================================================================== *
 * lantern post — a shepherd's crook with a real hook to hang light from
 * ================================================================== */

export function lanternPost(rand, index = 0) {
  const P = new PartSet();
  const seed = 9500 + index * 139;
  const H = [2.15, 2.45, 1.95][index % 3];
  const lean = (rand() - 0.5) * 0.045;
  const a = rand() * TAU;
  const dx = Math.cos(a) * lean * H, dz = Math.sin(a) * lean * H;

  const sp = [];
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    sp.push({ x: dx * t, y: -0.26 + t * (H + 0.26), z: dz * t, r: 0.07 - t * 0.022 });
  }
  const post = tube(sp, { radial: 6, uTile: 1 / 1.0, lobes: 4, lobeAmt: 0.11, seed, closeStart: true });
  if (post) P.add('timber', post);

  /* the crook: an iron arm curving out and over */
  const reach = 0.44;
  const armSp = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const ang = t * Math.PI * 0.52;
    armSp.push({
      x: dx + Math.cos(a + 0.4) * Math.sin(ang) * reach,
      y: H - 0.05 + (1 - Math.cos(ang)) * 0.13 - t * t * 0.06,
      z: dz + Math.sin(a + 0.4) * Math.sin(ang) * reach,
      r: 0.017 - t * 0.004,
    });
  }
  const arm = tube(armSp, { radial: 5, uTile: 1 / 0.34, lobes: 3, lobeAmt: 0.1, seed: seed + 9, closeStart: true });
  if (arm) P.add('metalDark', arm);
  const collar = ringGeo(0.056, 0.012, 4, 12);
  xform(collar, { pos: [dx, H - 0.08, dz], euler: [Math.PI / 2, 0, 0] });
  P.add('metalDark', collar, { cast: false });
  /* a brace back to the post so the arm has a reason not to bend */
  const brace = bar([dx, H - 0.42, dz], [armSp[3].x, armSp[3].y - 0.02, armSp[3].z], 0.012, 0.01,
    { radial: 4, seed: seed + 11, nodes: 3 });
  if (brace) P.add('metalDark', brace, { cast: false });

  const tip = armSp[armSp.length - 1];
  const hookRing = ringGeo(0.02, 0.006, 4, 9);
  xform(hookRing, { pos: [tip.x, tip.y - 0.012, tip.z], euler: [0, a, 0.3] });
  P.add('metalDark', hookRing, { cast: false });

  const out = P.build(seed);
  out.hook = [tip.x, tip.y - 0.03, tip.z];
  return out;
}

void finish; void bakeWear; void boxGeo; void lerp;
