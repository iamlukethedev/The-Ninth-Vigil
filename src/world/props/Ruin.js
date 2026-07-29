/**
 * SANCTUM — ruin dressing. Columns, lintels, cracked walls, tombstones,
 * sarcophagi, statue fragments, arch remnants.
 *
 * Authored to the canonical scale table: ashlar block 0.55 × 0.32 m, tombstone
 * 0.6 × 1.1 m, doorway 2.4 m. Every stone is chipped, every edge bevelled,
 * everything tilts — nothing in a crypt has been level for four hundred years.
 */

import * as THREE from 'three';
import {
  boxGeo, shardGeo, latheGeo, rockGeo, tube, mergeParts, xform, finish,
  bakeWear, paintVertex, clamp01, lerp, smooth01, perlin3,
} from './Geo.js';

const MOSS_DIR = [0.2, 0.45, -0.87];

/* ------------------------------------------------------------------ *
 * columns
 * ------------------------------------------------------------------ */

/** Fluted drum column, snapped off at a jagged height, with a spilled capital. */
export function brokenColumn(rand, index, { mat = 'stone' } = {}) {
  const spec = [
    { r: 0.34, h: 2.4, drums: 4, flutes: 14, base: true },
    { r: 0.28, h: 1.3, drums: 2, flutes: 12, base: true },
    { r: 0.42, h: 3.6, drums: 6, flutes: 16, base: true, cap: true },
  ][index % 3];
  const parts = [];
  const seed = 3300 + index * 29;

  if (spec.base) {
    // stepped plinth, chipped
    parts.push(xform(boxGeo(spec.r * 2.6, 0.16, spec.r * 2.6, { bevel: 0.035, uTile: 1 / 1.65 }), { pos: [0, 0.08, 0] }));
    parts.push(xform(boxGeo(spec.r * 2.2, 0.12, spec.r * 2.2, { bevel: 0.03, uTile: 1 / 1.65 }), { pos: [0, 0.22, 0] }));
  }
  const drumH = spec.h / spec.drums;
  let y = spec.base ? 0.28 : 0;
  for (let d = 0; d < spec.drums; d++) {
    const last = d === spec.drums - 1;
    const taper = 1 - (y / spec.h) * 0.11;
    // fluted profile: entasis + a torus bead at each joint
    const prof = [
      [spec.r * taper * 1.05, 0],
      [spec.r * taper, drumH * 0.08],
      [spec.r * taper * 0.99, drumH * 0.92],
      [spec.r * taper * 1.04, drumH],
    ];
    const g = latheGeo(prof, {
      seg: spec.flutes, uTile: 1 / 1.65, seed: seed + d * 7,
      lobeAmt: 0.035, lobes: spec.flutes, capTop: last, capBottom: d === 0,
    });
    // the snapped drum loses a wedge
    if (last) {
      const p = g.attributes.position.array;
      for (let i = 0; i < g.attributes.position.count; i++) {
        const o = i * 3;
        if (p[o + 1] > drumH * 0.62) {
          const a = Math.atan2(p[o + 2], p[o]);
          const bite = clamp01(Math.cos(a * 1.5 + index) * 0.5 + 0.5);
          p[o + 1] -= bite * drumH * 0.42 * (p[o + 1] / drumH);
          p[o] *= 1 - bite * 0.06;
          p[o + 2] *= 1 - bite * 0.06;
        }
      }
      g.computeVertexNormals();
    }
    xform(g, { pos: [(rand() - 0.5) * 0.03, y, (rand() - 0.5) * 0.03], rotY: rand() * 6.283 });
    parts.push(g);
    y += drumH;
  }
  if (spec.cap) {
    const cap = boxGeo(spec.r * 2.5, 0.2, spec.r * 2.5, { bevel: 0.045, uTile: 1 / 1.65 });
    xform(cap, { pos: [0, y + 0.1, 0], euler: [0.03, 0.2, -0.02] });
    parts.push(cap);
  }
  // a fallen drum lying at the foot
  const fallen = latheGeo(
    [[spec.r * 1.02, 0], [spec.r, 0.04], [spec.r, drumH - 0.04], [spec.r * 1.03, drumH]],
    { seg: spec.flutes, uTile: 1 / 1.65, seed: seed + 91, lobeAmt: 0.04, lobes: spec.flutes, capTop: true, capBottom: true }
  );
  const fa = rand() * 6.283;
  xform(fallen, {
    pos: [Math.cos(fa) * (spec.r * 2.4), spec.r * 0.98, Math.sin(fa) * (spec.r * 2.4)],
    euler: [Math.PI / 2 + (rand() - 0.5) * 0.2, fa, (rand() - 0.5) * 0.3],
  });
  parts.push(fallen);

  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed, base: 0.42, baseH: 0.18, cavity: 0.44, blotch: 0.16, blotchFreq: 1.4,
    moss: 0.4, mossColor: [0.4, 0.48, 0.36], mossDir: MOSS_DIR, dust: 0.24,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/** A dressed lintel fallen off its piers, cracked in two. */
export function fallenLintel(rand, index, { mat = 'stone' } = {}) {
  const len = [2.6, 3.6][index % 2];
  const parts = [];
  const seed = 3500 + index * 17;
  const halves = 2;
  let x = -len * 0.5;
  for (let i = 0; i < halves; i++) {
    const l = len / halves * (0.8 + rand() * 0.4);
    const g = shardGeo({
      w: l, h: 0.42, d: 0.55, seed: seed + i * 11, seg: 2, rough: 0.1, uTile: 1 / 1.65, bevel: 0.05,
    });
    xform(g, {
      pos: [x + l * 0.5, 0.21 + (i === 1 ? 0.06 : 0), (rand() - 0.5) * 0.2],
      euler: [(rand() - 0.5) * 0.12, (rand() - 0.5) * 0.24, (rand() - 0.5) * 0.2],
    });
    parts.push(g);
    x += l + 0.06;
  }
  // rubble spill from the break
  for (let i = 0; i < 4; i++) {
    const g = shardGeo({
      w: 0.14 + rand() * 0.14, h: 0.08 + rand() * 0.08, d: 0.12 + rand() * 0.12,
      seed: seed + 50 + i, seg: 1, rough: 0.4, uTile: 1 / 1.1, bevel: 0.02,
    });
    xform(g, {
      pos: [(rand() - 0.5) * len * 0.7, 0.05, (rand() - 0.5) * 0.7],
      euler: [rand(), rand() * 6.283, rand()],
    });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed, base: 0.44, baseH: 0.3, cavity: 0.42, blotch: 0.18,
    moss: 0.36, mossColor: [0.4, 0.5, 0.36], mossDir: MOSS_DIR, dust: 0.28,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/**
 * Cracked wall fragment. Real ashlar courses (0.55 × 0.32 m), running bond,
 * missing blocks toward the broken top, slumped out of plumb.
 */
export function crackedWall(rand, index, { mat = 'stone' } = {}) {
  const spec = [
    { w: 3.3, courses: 7, thick: 0.45, lean: 0.03 },
    { w: 2.2, courses: 4, thick: 0.4, lean: 0.06 },
    { w: 5.0, courses: 9, thick: 0.55, lean: 0.02 },
  ][index % 3];
  const bw = 0.55, bh = 0.32;
  const parts = [];
  const seed = 3700 + index * 23;
  const nAcross = Math.max(2, Math.round(spec.w / bw));
  for (let c = 0; c < spec.courses; c++) {
    const y = bh * (c + 0.5);
    // the top courses are progressively eaten away
    const survive = 1 - Math.pow(c / spec.courses, 2.1) * 0.85;
    const offset = (c & 1) ? bw * 0.5 : 0;
    for (let i = 0; i < nAcross; i++) {
      if (rand() > survive) continue;
      const bx = -spec.w * 0.5 + offset + bw * (i + 0.5);
      if (bx > spec.w * 0.5) continue;
      const jitter = 0.012;
      const g = shardGeo({
        w: bw * 0.96, h: bh * 0.94, d: spec.thick,
        seed: seed + c * 31 + i * 7, seg: 1, rough: 0.075, uTile: 1 / 1.65, bevel: 0.022,
      });
      xform(g, {
        pos: [bx + (rand() - 0.5) * jitter, y, (rand() - 0.5) * jitter * 3],
        euler: [(rand() - 0.5) * 0.03, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.03],
      });
      parts.push(g);
    }
  }
  // spilled blocks at the base
  for (let i = 0; i < 5; i++) {
    const g = shardGeo({
      w: bw * (0.4 + rand() * 0.6), h: bh * (0.5 + rand() * 0.5), d: spec.thick * (0.5 + rand() * 0.5),
      seed: seed + 200 + i, seg: 1, rough: 0.22, uTile: 1 / 1.65, bevel: 0.02,
    });
    xform(g, {
      pos: [(rand() - 0.5) * spec.w, 0.08 + rand() * 0.08, spec.thick * (0.6 + rand() * 1.4) * (rand() < 0.5 ? -1 : 1)],
      euler: [(rand() - 0.5) * 0.9, rand() * 6.283, (rand() - 0.5) * 0.9],
    });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  xform(geo, { euler: [spec.lean, 0, spec.lean * 1.6] });
  bakeWear(geo, {
    seed, base: 0.46, baseH: 0.22, cavity: 0.46, blotch: 0.17, blotchFreq: 0.9,
    moss: 0.5, mossColor: [0.36, 0.46, 0.33], mossDir: MOSS_DIR, dust: 0.2,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/* ------------------------------------------------------------------ *
 * tombstones
 * ------------------------------------------------------------------ */

/** Four weathered headstone shapes. 0.6 × 1.1 m per the scale table. */
export function tombstone(rand, index, { mat = 'stoneCold' } = {}) {
  const seed = 3900 + index * 37;
  const parts = [];
  const kind = index % 4;

  if (kind === 0) {
    // plain slab, chipped top corners
    const g = shardGeo({ w: 0.6, h: 1.05, d: 0.13, seed, seg: 2, rough: 0.09, uTile: 1 / 1.65, bevel: 0.024 });
    xform(g, { pos: [0, 0.5, 0] });
    parts.push(g);
  } else if (kind === 1) {
    // round-topped stone
    const w = 0.56, h = 0.9;
    const body = shardGeo({ w, h: h * 0.8, d: 0.12, seed, seg: 2, rough: 0.08, uTile: 1 / 1.65, bevel: 0.022 });
    xform(body, { pos: [0, h * 0.4, 0] });
    parts.push(body);
    const cyl = latheGeo(
      [[w * 0.5, 0], [w * 0.47, 0.09], [w * 0.34, 0.18], [w * 0.14, 0.25], [0.01, 0.27]],
      { seg: 11, uTile: 1 / 1.65, seed: seed + 3, lobeAmt: 0.03, lobes: 4, capTop: true }
    );
    // squash to a slab cross-section
    xform(cyl, { pos: [0, h * 0.8, 0], scale: [1, 1, 0.24] });
    parts.push(cyl);
  } else if (kind === 2) {
    // celtic-ish cross
    const shaft = shardGeo({ w: 0.22, h: 1.3, d: 0.16, seed, seg: 2, rough: 0.07, uTile: 1 / 1.65, bevel: 0.02 });
    xform(shaft, { pos: [0, 0.65, 0] });
    parts.push(shaft);
    const arm = shardGeo({ w: 0.66, h: 0.2, d: 0.15, seed: seed + 5, seg: 1, rough: 0.09, uTile: 1 / 1.65, bevel: 0.02 });
    xform(arm, { pos: [0, 1.0, 0], euler: [0, 0, (rand() - 0.5) * 0.06] });
    parts.push(arm);
    const halo = new THREE.TorusGeometry(0.19, 0.045, 5, 12);
    xform(halo, { pos: [0, 1.0, 0], euler: [0, Math.PI / 2, 0] });
    parts.push(halo);
  } else {
    // broken obelisk
    const h = 1.55;
    const g = latheGeo(
      [[0.19, 0], [0.175, h * 0.45], [0.13, h * 0.82], [0.1, h]],
      { seg: 4, uTile: 1 / 1.65, seed, lobeAmt: 0.03, lobes: 4, capTop: true, capBottom: true }
    );
    xform(g, { rotY: Math.PI / 4 });
    parts.push(g);
    const chunk = shardGeo({ w: 0.2, h: 0.28, d: 0.2, seed: seed + 9, seg: 1, rough: 0.3, uTile: 1 / 1.65, bevel: 0.02 });
    xform(chunk, { pos: [0.42, 0.12, -0.22], euler: [0.7, rand() * 6.283, 0.5] });
    parts.push(chunk);
  }

  // a low kerb / grave slab in front — the thing that makes it read as a grave
  const kerb = shardGeo({ w: 0.72, h: 0.1, d: 0.5, seed: seed + 21, seg: 1, rough: 0.16, uTile: 1 / 1.65, bevel: 0.02 });
  xform(kerb, { pos: [0, 0.045, 0.42], euler: [(rand() - 0.5) * 0.1, (rand() - 0.5) * 0.2, (rand() - 0.5) * 0.1] });
  parts.push(kerb);

  const geo = mergeParts(parts);
  if (!geo) return null;
  // headstones lean — this is most of what makes a graveyard read as old
  xform(geo, { euler: [(rand() - 0.5) * 0.2, rand() * 6.283, (rand() - 0.5) * 0.24] });
  bakeWear(geo, {
    seed, base: 0.46, baseH: 0.28, cavity: 0.4, blotch: 0.22, blotchFreq: 1.6,
    moss: 0.62, mossColor: [0.36, 0.47, 0.32], mossDir: MOSS_DIR, dust: 0.14,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/** Stone coffin with the lid shoved aside. */
export function sarcophagus(rand, index, { mat = 'stone' } = {}) {
  const seed = 4100 + index * 43;
  const w = 0.95, l = 2.15, h = 0.72;
  const parts = [];
  // hollow chest: four walls + floor, so the open end reads as a void
  const t = 0.13;
  const add = (gw, gh, gd, px, py, pz) => {
    const g = shardGeo({ w: gw, h: gh, d: gd, seed: seed + Math.round(px * 71 + pz * 31 + py * 13), seg: 1, rough: 0.09, uTile: 1 / 1.65, bevel: 0.024 });
    xform(g, { pos: [px, py, pz] });
    parts.push(g);
  };
  add(l, t, w, 0, t * 0.5, 0);
  add(l, h - t, t, 0, (h + t) * 0.5, (w - t) * 0.5);
  add(l, h - t, t, 0, (h + t) * 0.5, -(w - t) * 0.5);
  add(t, h - t, w - t * 2, (l - t) * 0.5, (h + t) * 0.5, 0);
  add(t, h - t, w - t * 2, -(l - t) * 0.5, (h + t) * 0.5, 0);

  const lidOff = index % 2 === 0 ? 0.36 : -0.28;
  const lid = shardGeo({ w: l * 1.04, h: 0.16, d: w * 1.04, seed: seed + 61, seg: 2, rough: 0.1, uTile: 1 / 1.65, bevel: 0.03 });
  xform(lid, { pos: [lidOff, h + 0.08, lidOff * 0.4], euler: [0.03, 0.06, -0.05] });
  parts.push(lid);
  // effigy ridge on the lid
  const ridge = latheGeo([[0.16, 0], [0.15, 0.06], [0.1, 0.1]], { seg: 7, uTile: 1 / 1.65, seed: seed + 71, capTop: true });
  xform(ridge, { pos: [lidOff, h + 0.16, lidOff * 0.4], scale: [3.2, 1, 1] });
  parts.push(ridge);

  const geo = mergeParts(parts);
  if (!geo) return null;
  xform(geo, { euler: [0, rand() * 6.283, 0] });
  bakeWear(geo, {
    seed, base: 0.44, baseH: 0.2, cavity: 0.48, blotch: 0.2,
    moss: 0.34, mossColor: [0.38, 0.47, 0.34], mossDir: MOSS_DIR, dust: 0.26,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/** Headless statue on a plinth, or just a torso in the dirt. */
export function statueFragment(rand, index, { mat = 'marble' } = {}) {
  const seed = 4300 + index * 47;
  const parts = [];
  const onPlinth = index % 2 === 0;
  let y = 0;
  if (onPlinth) {
    parts.push(xform(boxGeo(0.95, 0.22, 0.95, { bevel: 0.04, uTile: 1 / 2.3 }), { pos: [0, 0.11, 0] }));
    parts.push(xform(boxGeo(0.78, 0.5, 0.78, { bevel: 0.035, uTile: 1 / 2.3 }), { pos: [0, 0.47, 0] }));
    y = 0.72;
  }
  // legs / robe as a lathe with fabric folds
  const robe = latheGeo(
    [[0.36, 0], [0.34, 0.2], [0.3, 0.55], [0.27, 0.9], [0.26, 1.1]],
    { seg: 14, uTile: 1 / 2.3, seed: seed + 3, lobeAmt: 0.075, lobes: 9, capBottom: true }
  );
  xform(robe, { pos: [0, y, 0] });
  parts.push(robe);
  // torso, broken at the chest
  const torso = latheGeo(
    [[0.26, 0], [0.28, 0.16], [0.25, 0.42], [0.2, 0.52]],
    { seg: 12, uTile: 1 / 2.3, seed: seed + 7, lobeAmt: 0.06, lobes: 6, capTop: true }
  );
  xform(torso, { pos: [0, y + 1.1, 0], scale: [1.15, 1, 0.78] });
  parts.push(torso);
  // one surviving arm
  const armSp = [];
  for (let k = 0; k <= 3; k++) {
    const t = k / 3;
    armSp.push({ x: 0.22 + t * 0.2, y: y + 1.45 - t * 0.5, z: -t * 0.14, r: 0.075 * (1 - t * 0.35) });
  }
  const arm = tube(armSp, { radial: 6, uTile: 1 / 2.3, lobes: 3, lobeAmt: 0.06, seed: seed + 11, closeStart: true });
  if (arm) parts.push(arm);
  // rubble: the head, face-down
  const head = rockGeo({ radius: 0.16, detail: 1, warp: 0.2, squash: [0.85, 1, 0.9], flatten: 0.2, seed: seed + 17, uTile: 1 / 2.3 });
  xform(head, { pos: [0.55, 0.14, 0.4], euler: [1.3, rand() * 6.283, 0.4] });
  parts.push(head);

  const geo = mergeParts(parts);
  if (!geo) return null;
  xform(geo, { euler: [0, rand() * 6.283, 0] });
  bakeWear(geo, {
    seed, base: 0.4, baseH: 0.18, cavity: 0.42, blotch: 0.16, blotchFreq: 1.9,
    moss: 0.34, mossColor: [0.34, 0.42, 0.3], mossDir: MOSS_DIR, dust: 0.22,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/** Two piers and the springing of an arch — the rest has come down. */
export function archRemnant(rand, index, { mat = 'stone' } = {}) {
  const seed = 4500 + index * 53;
  const span = [2.6, 3.4][index % 2];
  const pierH = [2.1, 2.7][index % 2];
  const parts = [];
  const bw = 0.5;
  for (const side of [-1, 1]) {
    const courses = Math.round(pierH / 0.32);
    for (let c = 0; c < courses; c++) {
      const g = shardGeo({
        w: bw, h: 0.3, d: 0.5, seed: seed + c * 17 + (side > 0 ? 101 : 0),
        seg: 1, rough: 0.09, uTile: 1 / 1.65, bevel: 0.022,
      });
      xform(g, {
        pos: [side * span * 0.5 + (rand() - 0.5) * 0.02, 0.16 + c * 0.32, (rand() - 0.5) * 0.03],
        euler: [0, (rand() - 0.5) * 0.05, 0],
      });
      parts.push(g);
    }
    // voussoirs springing inward, then stopping mid-air (broken arch)
    const nV = 3 + (index % 2);
    for (let v = 0; v < nV; v++) {
      const ang = (v + 0.5) * (Math.PI / 2) / (nV + 1.6);
      const r = span * 0.5;
      const g = shardGeo({
        w: 0.34, h: 0.3, d: 0.5, seed: seed + 300 + v * 13 + (side > 0 ? 7 : 0),
        seg: 1, rough: 0.08, uTile: 1 / 1.65, bevel: 0.022,
      });
      xform(g, {
        pos: [side * (r - r * (1 - Math.cos(ang))), pierH + r * Math.sin(ang) * 0.92, 0],
        euler: [0, 0, -side * ang],
      });
      parts.push(g);
    }
  }
  // collapse debris in the opening
  for (let i = 0; i < 6; i++) {
    const g = shardGeo({
      w: 0.2 + rand() * 0.3, h: 0.14 + rand() * 0.16, d: 0.2 + rand() * 0.28,
      seed: seed + 500 + i, seg: 1, rough: 0.24, uTile: 1 / 1.65, bevel: 0.022,
    });
    xform(g, {
      pos: [(rand() - 0.5) * span * 0.8, 0.1 + rand() * 0.12, (rand() - 0.5) * 0.9],
      euler: [(rand() - 0.5) * 1.2, rand() * 6.283, (rand() - 0.5) * 1.2],
    });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed, base: 0.46, baseH: 0.2, cavity: 0.46, blotch: 0.18,
    moss: 0.46, mossColor: [0.36, 0.46, 0.33], mossDir: MOSS_DIR, dust: 0.22,
  });
  finish(geo);
  void paintVertex; void lerp; void smooth01; void perlin3;
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/* ------------------------------------------------------------------ *
 * rubble
 * ------------------------------------------------------------------ */

/**
 * Loose masonry rubble — the filler that makes a crypt floor read as ruined,
 * and the single most-repeated prop in the game.
 *
 * THE DEFECT THIS REPLACES. There were three variants, all built the same way:
 * N chips of the same size class thrown into a disc of radius `spread`. Three
 * discs of gravel differing only in count is one silhouette, so ~30 instances
 * across a frame read as one asset stamped over and over — the art director
 * counted them. On top of that every piece was in the `rubble` (cobble) material
 * while the columns, lintels and walls beside them were in `stone`, so the
 * debris did not read as having come off the building it was lying against.
 *
 * What is here now:
 *
 *  • **Ten authored silhouettes**, not N densities of one disc. Six are boxy
 *    masonry reads — a flat wide drift, a part-collapsed course still in bond, a
 *    tall narrow cone, a cracked floor slab splayed into plates, a tipped wall
 *    corner, a single long dressed fragment with a grit trail — and four are
 *    deliberately NOT boxy, because six variations on a cuboid still resolve to
 *    "the same slab" at 28 m: a snapped column drum lying on its side (the only
 *    round outline in the set), a blast ring with an empty middle (a donut, not a
 *    mound), a five-block stack leaning on a diagonal spine (the only tall one),
 *    and a mortar-fines sheet that is almost flat (the only one with no mass).
 *    Round / annular / tall / flat is a real silhouette spread; three gravel
 *    discs never was.
 *  • **One warm stone family, three values.** Dressed pieces go in `stone` or
 *    `stoneWarm` — literally the bank materials the architecture uses — and only
 *    the loose grit stays in `rubble`, itself tinted into the same warm family.
 *    Which of the two dressed materials a heap uses is per-variant, so the set
 *    carries value variation without any of it drifting cold.
 *  • Per-piece non-uniform dimensions, three-axis rotation and per-piece fbm
 *    surface displacement (`shardGeo(rough)`, itself jittered per piece), so no
 *    two pieces are congruent even inside one heap.
 *  • Wear coupled: grime and damp in the cavities, dust on the up-faces, a
 *    per-variant value tint so the ten do not share one exposure.
 */
/**
 * Whole-heap low-frequency deformation.
 *
 * `shardGeo(rough)` already displaces each chip's own surface, but every chip is
 * displaced INDEPENDENTLY, so the heap's overall mass — the thing that actually
 * forms the silhouette at 28 m — is exactly the sum of the authored placements
 * and identical in every instance of that variant. This warps the merged cloud
 * through one continuous 3-D noise field, which slides whole groups of chips
 * together and changes the OUTLINE rather than the surface. Amplitude is per
 * variant, so the ten heaps differ in mass as well as in arrangement.
 *
 * `sy` is deliberately smaller than `sx`/`sz`: a heap may sprawl, but it must not
 * grow spikes, and the vertex normals are recomputed here so the lighting still
 * matches the surface (unlike the per-instance sculpt in PropMaterials, which
 * cannot recompute and therefore has to stay long-wavelength).
 */
function warpHeap(geo, seed, amp, freq) {
  if (!geo || amp <= 0) return;
  const p = geo.attributes.position.array;
  for (let i = 0, n = geo.attributes.position.count; i < n; i++) {
    const o = i * 3;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    p[o] += (perlin3(x * freq, y * freq, z * freq, seed) - 0.5) * amp;
    p[o + 1] += (perlin3(x * freq + 5.1, y * freq, z * freq, seed + 37) - 0.5) * amp * 0.5;
    p[o + 2] += (perlin3(x * freq, y * freq, z * freq + 7.3, seed + 71) - 0.5) * amp;
  }
  geo.computeVertexNormals();
}

/*
 * `sq` is a per-variant NON-UNIFORM stretch of the whole heap, applied after the
 * pieces are laid. Props.js already draws an independent x/z instance scale, but
 * that is a *random* spread around one authored form; this makes the ten forms
 * themselves differ in proportion — 0 is a 1.35 x 0.55 x 0.80 sprawl, 8 is a
 * 0.78 x 1.30 x 0.85 tower — so the set has genuinely different aspect ratios
 * rather than ten differently-sized copies of one aspect ratio.
 * `warp` is [amplitude m, frequency 1/m] for warpHeap above.
 */
const RUBBLE_KIND = [
  /* 0  wide low drift            */ { chips: 17, chipR: [0.055, 0.15], spread: 1.15, flat: 0.62, dust: 0.34, moss: 0.1, tint: 1.06, block: 'stone', sq: [1.35, 0.55, 0.80], warp: [0.075, 1.1] },
  /* 1  collapsed course in bond  */ { chips: 9, chipR: [0.06, 0.14], spread: 0.72, flat: 1.0, dust: 0.26, moss: 0.24, tint: 0.94, block: 'stone', sq: [1.10, 0.90, 0.92], warp: [0.045, 1.5] },
  /* 2  narrow cone               */ { chips: 15, chipR: [0.08, 0.2], spread: 0.5, flat: 1.55, dust: 0.2, moss: 0.16, tint: 1.0, block: 'stoneWarm', sq: [0.86, 1.18, 0.90], warp: [0.09, 1.3] },
  /* 3  cracked slab, splayed     */ { chips: 7, chipR: [0.05, 0.13], spread: 0.95, flat: 0.7, dust: 0.3, moss: 0.2, tint: 1.03, block: 'stone', sq: [1.18, 0.62, 1.05], warp: [0.05, 1.7] },
  /* 4  tipped corner, bond held  */ { chips: 8, chipR: [0.06, 0.16], spread: 0.8, flat: 1.1, dust: 0.22, moss: 0.3, tint: 0.9, block: 'stoneWarm', sq: [0.94, 1.06, 1.12], warp: [0.04, 1.6] },
  /* 5  long fragment + trail     */ { chips: 12, chipR: [0.05, 0.12], spread: 1.3, flat: 0.5, dust: 0.32, moss: 0.14, tint: 1.09, block: 'stone', sq: [1.42, 0.58, 0.68], warp: [0.06, 1.2] },
  /* 6  snapped column drum       */ { chips: 11, chipR: [0.05, 0.13], spread: 0.86, flat: 0.7, dust: 0.28, moss: 0.34, tint: 0.97, block: 'stoneWarm', sq: [1.06, 0.82, 0.96], warp: [0.05, 1.4] },
  /* 7  blast ring, hollow middle */ { chips: 19, chipR: [0.045, 0.12], spread: 1.35, flat: 0.55, dust: 0.36, moss: 0.12, tint: 1.11, block: 'stone', ring: 0.62, sq: [1.26, 0.50, 1.22], warp: [0.085, 1.0] },
  /* 8  leaning five-block stack  */ { chips: 10, chipR: [0.055, 0.14], spread: 0.62, flat: 1.25, dust: 0.18, moss: 0.26, tint: 0.87, block: 'stoneWarm', sq: [0.78, 1.30, 0.85], warp: [0.035, 1.9] },
  /* 9  mortar-fines sheet        */ { chips: 24, chipR: [0.03, 0.075], spread: 1.6, flat: 0.34, dust: 0.42, moss: 0.08, tint: 1.13, block: 'stone', sq: [1.30, 0.42, 1.15], warp: [0.10, 0.9] },
];
const RUBBLE_VARIANTS = RUBBLE_KIND.length;

export function rubbleHeap(rand, index, { mat = 'rubble', blockMat = null } = {}) {
  const kind = index % RUBBLE_VARIANTS;
  const spec = RUBBLE_KIND[kind];
  /*
   * THE COLD-BLUE SLAB, root cause.
   *
   * `spec.block` names the bank material each variant's dressed masonry should
   * draw in — `stone` or `stoneWarm`, i.e. literally the two materials the
   * columns, lintels and walls beside it use. It was never read. `blockMat`
   * defaulted to `null`, that null went all the way through to
   * `Props._mat(null)` -> `MatBank.get(null)` -> `DEFS[null] ?? DEFS.stone`, and
   * the result was a SEPARATE, UNTINTED material cached under the key `null`
   * (it showed up in the live scene graph as `props.null`). Untinted means it
   * missed `DEFS.stoneWarm`'s warm tint, and it also missed `Props.LIFT.stone`
   * and `Props.ROUGH_SCALE` because those are keyed by name — so every dressed
   * rubble block in the game rendered a neutral-grey, un-lifted, fully-rough
   * surface, lit on its up-faces by a cold ambient probe, sitting on a warm tan
   * floor. Neutral albedo under cold ambient IS slate blue. On top of that it
   * burned a whole 512 px map/normal/ORM set out of an already-exhausted texture
   * budget for a material that duplicated `stone`.
   */
  const bmat = blockMat ?? spec.block ?? 'stone';
  const seed = 4700 + index * 59;
  const blocks = [];        // dressed masonry — the architecture's own material
  const grit = [];          // loose chip and gravel

  /**
   * One dressed ashlar block, 0.55 x 0.32 m per the scale table, chipped.
   *
   * `rough` is drawn per piece rather than fixed. A constant fbm amplitude means
   * every block in the game shares one family of surface dents, which is the
   * geometric half of "one asset stamped repeatedly"; drawing it in 0.07..0.19
   * makes some faces near-dressed and others badly spalled.
   */
  const ashlar = (i, w, h, d, pos, euler) => {
    const g = shardGeo({
      w, h, d, seed: seed + 400 + i * 13, seg: 1, rough: 0.07 + rand() * 0.12,
      uTile: 1 / 1.65, bevel: Math.min(w, h, d) * (0.09 + rand() * 0.08),
    });
    xform(g, { pos, euler });
    blocks.push(g);
  };

  if (kind === 1) {
    /* a course that came down but stayed roughly in bond, part-buried */
    let x = -0.5;
    for (let i = 0; i < 3; i++) {
      const w = 0.5 + rand() * 0.12;
      ashlar(i, w, 0.3 + rand() * 0.05, 0.36 + rand() * 0.1,
        [x + w * 0.5, 0.13 + i * 0.055, (rand() - 0.5) * 0.16],
        [(rand() - 0.5) * 0.3, (rand() - 0.5) * 0.5, (rand() - 0.5) * 0.34]);
      x += w * (0.82 + rand() * 0.2);
    }
  } else if (kind === 3) {
    /* a floor slab cracked clean through and splayed — broad angled plates */
    const th = 0.13;
    for (let i = 0; i < 3; i++) {
      const a = -0.9 + i * 0.95 + rand() * 0.4;
      const w = 0.44 + rand() * 0.3;
      ashlar(i, w, th, 0.52 + rand() * 0.3,
        [Math.cos(a) * (0.16 + i * 0.2), th * 0.55 + i * 0.035, Math.sin(a) * (0.18 + i * 0.22)],
        [(rand() - 0.5) * 0.55, a, (rand() - 0.5) * 0.62]);
    }
  } else if (kind === 4) {
    /* a wall corner tipped over with its bond intact — the tall blocky read */
    const bw = 0.5, bh = 0.3;
    for (let i = 0; i < 4; i++) {
      const row = i >> 1, col = i & 1;
      ashlar(i, bw * (0.9 + rand() * 0.16), bh, 0.34 + rand() * 0.08,
        [(col ? bw * 0.52 : -bw * 0.48) + (rand() - 0.5) * 0.04,
          bh * (0.52 + row * 0.98), (row & 1 ? 0.1 : -0.08) + (rand() - 0.5) * 0.06],
        [0.1 + (rand() - 0.5) * 0.16, (rand() - 0.5) * 0.4, 0.16 + (rand() - 0.5) * 0.2]);
    }
  } else if (kind === 5) {
    /* one long dressed fragment — a snapped lintel or sill — plus a grit trail */
    ashlar(0, 1.25 + rand() * 0.25, 0.3 + rand() * 0.07, 0.38 + rand() * 0.1,
      [(rand() - 0.5) * 0.1, 0.16, (rand() - 0.5) * 0.12],
      [(rand() - 0.5) * 0.16, (rand() - 0.5) * 0.7, (rand() - 0.5) * 0.14]);
    ashlar(1, 0.3 + rand() * 0.16, 0.26, 0.3,
      [0.78 + rand() * 0.2, 0.13, -0.28 - rand() * 0.2],
      [0.7 + rand() * 0.5, rand() * 6.283, 0.4 + rand() * 0.4]);
  } else if (kind === 2) {
    /* the cone: a few mid blocks buried in the middle carry its mass */
    for (let i = 0; i < 3; i++) {
      const a = rand() * 6.283;
      ashlar(i, 0.3 + rand() * 0.16, 0.22 + rand() * 0.1, 0.24 + rand() * 0.14,
        [Math.cos(a) * 0.14, 0.14 + i * 0.13, Math.sin(a) * 0.14],
        [(rand() - 0.5) * 0.9, rand() * 6.283, (rand() - 0.5) * 0.9]);
    }
  } else if (kind === 6) {
    /*
     * A snapped column drum on its side. This is the only ROUND outline in the
     * set and it is here purely to break the cuboid read: an eye scanning a
     * frame for repeats latches onto silhouette first, and a cylinder among
     * boxes is the cheapest possible way to defeat that.
     */
    const dr = 0.29 + rand() * 0.07;
    const dl = 0.52 + rand() * 0.26;
    const drum = latheGeo(
      [[dr * 1.03, 0], [dr, dl * 0.06], [dr * 0.985, dl * 0.94], [dr * 1.02, dl]],
      {
        seg: 13, uTile: 1 / 1.65, seed: seed + 611, lobeAmt: 0.045, lobes: 13,
        capTop: true, capBottom: true,
      }
    );
    const roll = rand() * 6.283;
    xform(drum, {
      pos: [(rand() - 0.5) * 0.14, dr * 0.9, (rand() - 0.5) * 0.14],
      euler: [Math.PI / 2 + (rand() - 0.5) * 0.22, roll, (rand() - 0.5) * 0.34],
    });
    blocks.push(drum);
    // the wedge that came off the drum, plus the block that landed on it
    ashlar(0, 0.26 + rand() * 0.14, 0.2 + rand() * 0.1, 0.3 + rand() * 0.12,
      [Math.cos(roll) * 0.5, 0.12, Math.sin(roll) * 0.5],
      [0.6 + rand() * 0.6, rand() * 6.283, 0.35 + rand() * 0.5]);
    ashlar(1, 0.34 + rand() * 0.12, 0.16, 0.22,
      [-Math.cos(roll) * 0.42, dr * 1.5, -Math.sin(roll) * 0.3],
      [(rand() - 0.5) * 0.5, rand() * 6.283, 0.9 + rand() * 0.4]);
  } else if (kind === 7) {
    /*
     * A blast ring: the middle is EMPTY and two plates are flung outward onto
     * the rim, tipped up on their edges. An annulus is a completely different
     * read from a mound at any distance, and the tipped plates give it two
     * vertical accents that catch a torch.
     */
    const a0 = rand() * 6.283;
    for (let i = 0; i < 2; i++) {
      const a = a0 + i * (2.1 + rand() * 1.6);
      const r = 0.72 + rand() * 0.3;
      ashlar(i, 0.42 + rand() * 0.26, 0.12 + rand() * 0.05, 0.4 + rand() * 0.22,
        [Math.cos(a) * r, 0.16 + rand() * 0.08, Math.sin(a) * r],
        [1.05 + (rand() - 0.5) * 0.5, a + (rand() - 0.5) * 0.8, (rand() - 0.5) * 0.7]);
    }
  } else if (kind === 8) {
    /*
     * Five blocks stacked and leaning on one diagonal spine — the only variant
     * with real height (about 0.9 m). Somebody cleared this floor once and piled
     * what they lifted; that reads as narrative rather than as scatter.
     */
    const spine = rand() * 6.283;
    const sc = Math.cos(spine), ss = Math.sin(spine);
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const w = 0.48 - t * 0.14 + rand() * 0.1;
      const off = (t - 0.5) * 0.34 + (rand() - 0.5) * 0.09;
      ashlar(i, w, 0.19 + rand() * 0.06, 0.3 + rand() * 0.1,
        [sc * off, 0.11 + i * 0.185, ss * off],
        [(rand() - 0.5) * 0.24, spine + (rand() - 0.5) * 0.7, 0.1 + (rand() - 0.5) * 0.3]);
    }
  } else if (kind === 9) {
    /* the fines sheet: one thin spalled plate, everything else is dust and chip */
    ashlar(0, 0.6 + rand() * 0.3, 0.075 + rand() * 0.03, 0.5 + rand() * 0.28,
      [(rand() - 0.5) * 0.5, 0.05, (rand() - 0.5) * 0.5],
      [(rand() - 0.5) * 0.2, rand() * 6.283, (rand() - 0.5) * 0.2]);
  }

  /* loose chip: the layer that beds the heap into the floor */
  const [c0, c1] = spec.chipR;
  // 0, 5 and 9 drift along an axis rather than filling a disc; 7 is an annulus
  const drift = kind === 0 ? 0.55 : kind === 5 ? 0.85 : kind === 9 ? 0.7 : 0;
  const driftA = rand() * 6.283;
  const ring = spec.ring ?? 0;
  for (let i = 0; i < spec.chips; i++) {
    const s = c0 + rand() * (c1 - c0);
    const g = shardGeo({
      w: s * (1.05 + rand() * 0.95), h: s * (0.34 + rand() * 0.62), d: s * (0.7 + rand() * 0.85),
      seed: seed + i * 11, seg: 1, rough: 0.24 + rand() * 0.26,
      uTile: 1 / 1.1, bevel: s * (0.1 + rand() * 0.1),
    });
    const a = rand() * 6.283;
    // `ring` pushes the radial distribution off zero, so the middle stays open
    const u = rand();
    const d = ring > 0
      ? (ring + (1 - ring) * Math.pow(u, 0.7)) * spec.spread
      : Math.pow(u, 0.5) * spec.spread;
    const dx = Math.cos(a) * d + Math.cos(driftA) * d * drift;
    const dz = Math.sin(a) * d + Math.sin(driftA) * d * drift;
    xform(g, {
      pos: [dx, s * 0.42 * spec.flat * (1 - d / (spec.spread * 1.35)) + s * 0.16, dz],
      euler: [(rand() - 0.5) * 1.5, rand() * 6.283, (rand() - 0.5) * 1.5],
    });
    grit.push(g);
  }

  const parts = [];
  const gGrit = mergeParts(grit);
  const gBlock = blocks.length ? mergeParts(blocks) : null;

  /*
   * Per-variant proportion and mass. The stretch goes on BOTH halves so a heap
   * keeps registering as one object, and the noise warp goes on the grit only —
   * dressed ashlar that has melted reads as a modelling error, loose broken chip
   * that has settled into a drift does not.
   */
  const sq = spec.sq;
  if (sq) {
    if (gGrit) xform(gGrit, { scale: sq });
    if (gBlock) xform(gBlock, { scale: [1 + (sq[0] - 1) * 0.45, 1 + (sq[1] - 1) * 0.35, 1 + (sq[2] - 1) * 0.45] });
  }
  if (gGrit && spec.warp) warpHeap(gGrit, seed + 811, spec.warp[0], spec.warp[1]);

  const wear = {
    seed, base: 0.42, baseH: 0.2, cavity: 0.46, blotch: 0.28, blotchFreq: 2.4,
    dust: spec.dust, dustColor: [1.2, 1.15, 1.04],
    moss: spec.moss, mossColor: [0.4, 0.47, 0.36], mossDir: MOSS_DIR,
    tint: [spec.tint, spec.tint * 0.995, spec.tint * 0.985],
  };
  if (gBlock) {
    // dressed stone keeps more of its face: less blotch, more grime in the joints
    bakeWear(gBlock, Object.assign({}, wear, { blotch: 0.2, blotchFreq: 1.5, cavity: 0.5 }));
    finish(gBlock);
    parts.push({ geo: gBlock, matName: bmat, cast: true });
  }
  if (gGrit) {
    bakeWear(gGrit, wear);
    finish(gGrit);
    parts.push({ geo: gGrit, matName: mat, cast: false });
  }
  return parts.length ? { parts } : null;
}
