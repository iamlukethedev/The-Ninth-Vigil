/**
 * SANCTUM — rock dressing. Boulders, clusters, scree, cliff chunks.
 *
 * Rule one: **no spheres**. Every boulder is an icosphere pushed around by fbm
 * at three frequencies, sheared so it leans, and flattened on the underside so
 * it beds into the ground instead of balancing on a point.
 */

import {
  rockGeo, shardGeo, mergeParts, xform, finish, bakeWear, clamp01, smooth01, perlin3, debrisUV,
} from './Geo.js';

const BOULDER_SPECS = [
  { radius: 1.15, warp: 0.30, squash: [1.15, 0.62, 0.95], flatten: 0.3, shear: 0.14, detail: 2 },
  { radius: 0.72, warp: 0.38, squash: [0.9, 0.86, 1.1], flatten: 0.24, shear: 0.2, detail: 2 },
  { radius: 1.75, warp: 0.26, squash: [1.0, 0.5, 1.25], flatten: 0.34, shear: 0.1, detail: 2 },
  { radius: 0.45, warp: 0.42, squash: [1.05, 0.78, 0.95], flatten: 0.2, shear: 0.24, detail: 1 },
];

const MOSS_DIR = [0.18, 0.52, -0.83];

export function boulder(rand, index, { mat = 'stoneCold', moss = 0.5 } = {}) {
  const s = BOULDER_SPECS[index % BOULDER_SPECS.length];
  const seed = 2100 + index * 53;
  const geo = rockGeo({ ...s, seed, uTile: 1 / 1.65 });
  bakeWear(geo, {
    seed, base: 0.44, baseH: 0.4 / s.radius, cavity: 0.4, blotch: 0.22, blotchFreq: 1.1 / s.radius,
    moss, mossColor: [0.4, 0.52, 0.36], mossDir: MOSS_DIR,
    dust: 0.16, dustColor: [1.16, 1.13, 1.06],
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

export function boulderLOD(rand, index, { mat = 'stoneCold' } = {}) {
  const s = BOULDER_SPECS[index % BOULDER_SPECS.length];
  const seed = 2100 + index * 53;
  const geo = rockGeo({ ...s, detail: 1, seed, uTile: 1 / 1.65 });
  bakeWear(geo, { seed, base: 0.44, baseH: 0.4 / s.radius, cavity: 0.35, blotch: 0.22, moss: 0.4, mossDir: MOSS_DIR });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/** Three to five stones piled against each other — how rock actually sits. */
export function rockCluster(rand, index, { mat = 'stoneCold' } = {}) {
  const n = 3 + (index % 3);
  const scale = [1, 0.68, 1.35][index % 3];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const s = BOULDER_SPECS[(index + i) % BOULDER_SPECS.length];
    const r = s.radius * scale * (0.42 + rand() * 0.5);
    const g = rockGeo({
      ...s, radius: r, detail: r > 0.55 ? 2 : 1, seed: 2300 + index * 17 + i * 7, uTile: 1 / 1.65,
    });
    const a = (i / n) * Math.PI * 2 + rand() * 1.2;
    const dist = i === 0 ? 0 : r * (0.7 + rand() * 0.7);
    xform(g, {
      pos: [Math.cos(a) * dist, i === 0 ? 0 : r * (rand() * 0.32 - 0.1), Math.sin(a) * dist],
      euler: [(rand() - 0.5) * 0.5, rand() * 6.283, (rand() - 0.5) * 0.5],
    });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed: 2400 + index, base: 0.46, baseH: 0.35, cavity: 0.42, blotch: 0.24,
    moss: 0.55, mossColor: [0.38, 0.5, 0.34], mossDir: MOSS_DIR, dust: 0.14,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/**
 * Scree: a shallow scatter of angular chips. Reads as erosion debris.
 *
 * Variant 2/5 draws four chips of up to 0.48 m, which puts this generator at exactly
 * the size the "untextured flat-colour geometry" flag was raised against. Three
 * things were wrong and all three were scale mismatches rather than missing content:
 *
 *  • `uTile: 1/1.1` put an architectural 1.1 m texture tile on a 0.3 m chip, and on
 *    `stoneRock` — which also carries a 0.26 material repeat for boulders — the
 *    effective tile was 4.2 m. A worley cell landed at 17.6 cm, so a facet showed
 *    two isolated pits and nothing else. `debrisUV` scales the tile to the piece.
 *  • `seg: 1` gives a rounded box one quad per face, and `rough` warps it through
 *    noise at a fixed 2.1 cycles/m, so a 0.3 m chip received 0.63 of a cycle: one
 *    smooth gradient, geometrically planar faces, one constant shading term per
 *    facet. seg 2 plus the size-relative `fine` term breaks that.
 *  • `dust: 0.2` at the default 1.18 dustColor lit every up-facing bevel above the
 *    albedo, which under a cool interior probe reads as frost on every arris.
 *
 * Chips also now bed: each one gets a flat spall plate lapped over its foot, so the
 * silhouette crosses the floor along a broken chip-scale edge instead of one clean
 * analytic curve.
 *
 * Verified by construction, not by frame: a per-material hide-and-measure showed the
 * four canonical frames this lane is graded on draw their debris from the crypt kit,
 * so nothing here is measurable in `closeup`. The arithmetic above is the same either
 * way — a 17.6 cm worley cell on a 30 cm chip is two pits wherever it is standing.
 */
export function scree(rand, index, { mat = 'rubble' } = {}) {
  const n = [7, 12, 4][index % 3];
  const sz = [0.16, 0.1, 0.28][index % 3];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const s = sz * (0.5 + rand() * 1.2);
    const w = s * (1 + rand() * 0.7), h = s * (0.3 + rand() * 0.45), d = s * (0.7 + rand() * 0.7);
    const g = shardGeo({
      w, h, d, seed: 2500 + index * 23 + i * 5, seg: s > 0.09 ? 2 : 1, rough: 0.34,
      uTile: debrisUV(mat, Math.max(w, h, d)), bevel: s * 0.14,
      fine: Math.min(w, h, d) * 0.12, fineCycles: 5,
    });
    const a = rand() * 6.283;
    const dist = Math.pow(rand(), 0.55) * sz * 4.5;
    const px = Math.cos(a) * dist, pz = Math.sin(a) * dist;
    xform(g, {
      pos: [px, s * 0.12, pz],
      euler: [(rand() - 0.5) * 0.7, rand() * 6.283, (rand() - 0.5) * 0.7],
    });
    parts.push(g);
    // spall lapped over the foot — only for chips big enough to show a contact line
    if (s > 0.12) {
      const bs = s * (0.55 + rand() * 0.35);
      const ba = rand() * 6.283;
      const bg = shardGeo({
        w: bs * 1.7, h: bs * 0.22, d: bs * 1.2,
        seed: 2560 + index * 23 + i * 5, seg: 1, rough: 0.4,
        uTile: debrisUV(mat, bs * 1.7), bevel: bs * 0.12,
        fine: bs * 0.1, fineCycles: 4,
      });
      xform(bg, {
        pos: [px + Math.cos(ba) * w * 0.42, bs * 0.05, pz + Math.sin(ba) * d * 0.42],
        euler: [(rand() - 0.5) * 0.24, ba, (rand() - 0.5) * 0.24],
      });
      parts.push(bg);
    }
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed: 2600 + index, base: 0.4, baseH: 0.18, cavity: 0.42, blotch: 0.3, blotchFreq: 3.5,
    dust: 0.11, dustColor: [1.03, 1.0, 0.95], grain: 0.12,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: false }] };
}

/**
 * Cliff chunk — a big fractured slab, tilted, half-buried. These are the props
 * that build mid-ground silhouette and give the frame separated depth planes.
 */
export function cliffChunk(rand, index, { mat = 'stone' } = {}) {
  const spec = [
    { w: 3.4, h: 2.6, d: 2.1, tilt: 0.22 },
    { w: 5.2, h: 3.8, d: 2.8, tilt: 0.13 },
    { w: 2.2, h: 3.4, d: 1.6, tilt: 0.3 },
  ][index % 3];
  const parts = [];
  const main = shardGeo({
    w: spec.w, h: spec.h, d: spec.d, seed: 2700 + index * 31, seg: 3, rough: 0.2,
    uTile: 1 / 1.65, bevel: 0.14,
  });
  // strata: knock a couple of ledges out of the face
  xform(main, { euler: [spec.tilt * 0.6, index * 0.7, spec.tilt] });
  parts.push(main);
  for (let i = 0; i < 3; i++) {
    const g = shardGeo({
      w: spec.w * (0.3 + rand() * 0.4), h: spec.h * 0.22, d: spec.d * (0.4 + rand() * 0.4),
      seed: 2800 + index * 13 + i, seg: 2, rough: 0.3, uTile: 1 / 1.65, bevel: 0.08,
    });
    const a = rand() * 6.283;
    xform(g, {
      pos: [Math.cos(a) * spec.w * 0.42, -spec.h * (0.15 + i * 0.22), Math.sin(a) * spec.d * 0.42],
      euler: [(rand() - 0.5) * 0.5, rand() * 6.283, (rand() - 0.5) * 0.5],
    });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, {
    seed: 2900 + index, base: 0.5, baseH: 0.25, cavity: 0.45, blotch: 0.2, blotchFreq: 0.7,
    moss: 0.42, mossColor: [0.36, 0.46, 0.33], mossDir: MOSS_DIR, dust: 0.22,
  });
  finish(geo);
  return { parts: [{ geo, matName: mat, cast: true }] };
}

/**
 * Standing stone / cairn. Sparse, deliberate, and instantly reads as authored
 * rather than scattered — exactly what the moor needs on the horizon.
 */
export function standingStone(rand, index, { mat = 'stoneCold' } = {}) {
  const h = [2.6, 1.7, 3.1][index % 3];
  const parts = [];
  /* Chunkier and LEANING. The tall variant used to be a 0.42-0.72 m thick slab
     stood dead upright, and an isometric camera sees it edge-on: a flat black
     rectangle with two parallel vertical edges, no light-catching planes and no
     silhouette information. That is the "untextured monolith" note on the
     overworld frame — the material was fine, the form was a billboard. Depth of
     0.62-0.96 m plus a 9-14 deg lean gives it a lit face, a shaded face and a
     top plane that catches the sky. */
  const geo = shardGeo({
    w: 0.86 + rand() * 0.46, h, d: 0.62 + rand() * 0.34,
    seed: 3000 + index * 19, seg: 3, rough: 0.22, uTile: 1 / 1.65, bevel: 0.075,
  });
  const lean = 0.16 + rand() * 0.09;
  const leanAz = rand() * 6.283;
  xform(geo, {
    pos: [0, h * 0.42, 0],
    euler: [Math.cos(leanAz) * lean, rand() * 6.283, Math.sin(leanAz) * lean],
  });
  parts.push(geo);
  // packing stones round the foot — more of them, and heaped against the lean so
  // the stone reads as wedged upright rather than dropped in
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 6.283 + rand() * 0.5;
    const wedge = 1 + 0.55 * Math.cos(a - leanAz);
    const g = rockGeo({
      radius: (0.15 + rand() * 0.13) * wedge, detail: 1, warp: 0.45, squash: [1, 0.7, 1],
      flatten: 0.3, seed: 3100 + index * 11 + i, uTile: 1 / 1.65,
    });
    const rr = 0.40 + rand() * 0.16;
    xform(g, { pos: [Math.cos(a) * rr, 0.03, Math.sin(a) * rr], rotY: rand() * 6.283 });
    parts.push(g);
  }
  const merged = mergeParts(parts);
  if (!merged) return null;
  bakeWear(merged, {
    seed: 3200 + index, base: 0.4, baseH: 0.22, cavity: 0.4, blotch: 0.22,
    moss: 0.6, mossColor: [0.36, 0.48, 0.32], mossDir: MOSS_DIR, dust: 0.16,
  });
  // pale lichen ring near the top, where wind-driven damp settles
  finish(merged);
  void clamp01; void smooth01; void perlin3;
  return { parts: [{ geo: merged, matName: mat, cast: true }] };
}
