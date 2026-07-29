/**
 * SANCTUM — vegetation dressing.
 *
 * Everything here is *dead or dying*: gnarled leafless trees, bare thorn,
 * heather that has gone to straw, sedge, hanging moss, roots tearing out of the
 * ground. Nothing is a green summer plant — the palette does not allow it.
 */

import * as THREE from 'three';
import {
  tube, branchStructure, bladeCluster, latheGeo, mergeParts, xform, finish,
  bakeWear, setWind, paintVertex, perlin3, fbm3, clamp01, lerp, smooth01, WIND_ATTR,
} from './Geo.js';

/* ------------------------------------------------------------------ *
 * dead trees
 * ------------------------------------------------------------------ */

const TREE_SPECS = [
  // tall, sparse, reaching — the silhouette tree
  { height: 7.2, baseR: 0.26, depth: 4, splits: 2, taper: 0.66, gnarl: 0.5, droop: 0.05, moss: 3 },
  // squat, wide, heavily forked
  { height: 4.6, baseR: 0.34, depth: 4, splits: 3, taper: 0.6, gnarl: 0.8, droop: 0.16, moss: 5 },
  // leaning, lightning-split, half the crown gone
  { height: 6.1, baseR: 0.3, depth: 3, splits: 2, taper: 0.58, gnarl: 0.95, droop: 0.22, lean: 0.3, moss: 2 },
  // stunted moor thorn tree
  { height: 3.2, baseR: 0.19, depth: 4, splits: 3, taper: 0.55, gnarl: 1.15, droop: 0.26, moss: 4 },
];

/**
 * @param {object} ctx {rand, matName}
 * @returns {{parts:Array, tips:Array, height:number}}
 */
export function deadTree(rand, index, { barkMat = 'bark', mossMat = 'moss' } = {}) {
  const spec = TREE_SPECS[index % TREE_SPECS.length];
  const seed = 1000 + index * 37;
  const { geo, tips } = branchStructure({
    rand, height: spec.height, baseR: spec.baseR, depth: spec.depth, splits: spec.splits,
    taper: spec.taper, gnarl: spec.gnarl, droop: spec.droop, seed, uTile: 1 / 0.9,
  });
  if (!geo) return null;

  if (spec.lean) xform(geo, { euler: [spec.lean * 0.5, 0, spec.lean] });

  // Wind: the trunk is rigid, the outer twigs are not. Weight by height AND by
  // distance from the trunk axis, so branch ends move most.
  geo.computeBoundingBox();
  const top = geo.boundingBox.max.y;
  setWind(geo, (x, y, z) => {
    const hy = clamp01(y / Math.max(0.5, top));
    const rad = clamp01(Math.hypot(x, z) / 2.4);
    return clamp01(Math.pow(hy, 1.7) * 0.72 + rad * 0.5) * 0.95;
  });
  bakeWear(geo, {
    seed, base: 0.5, baseH: 0.5, cavity: 0.42, blotch: 0.24, blotchFreq: 1.1,
    moss: 0.55, mossColor: [0.5, 0.62, 0.42], mossDir: [0.25, 0.4, -0.88],
  });
  finish(geo);

  const parts = [{ geo, matName: barkMat, cast: true }];

  // hanging moss / dry vine off the higher branch tips
  const hangs = [];
  const usable = tips.filter((t) => t.level >= 2 && t.y > spec.height * 0.35);
  const nHang = Math.min(spec.moss, usable.length);
  for (let i = 0; i < nHang; i++) {
    const t = usable[(i * 3 + 1) % usable.length];
    const len = 0.5 + rand() * 1.5;
    const g = mossStrandGeo(rand, len, 3 + (i % 3));
    if (!g) continue;
    xform(g, { pos: [t.x, t.y, t.z], rotY: rand() * Math.PI * 2 });
    hangs.push(g);
  }
  const mossGeo = mergeParts(hangs);
  if (mossGeo) {
    setWind(mossGeo, (x, y) => clamp01(0.35 + (top - y) / Math.max(1, top) * 0.65));
    bakeWear(mossGeo, { seed: seed + 9, base: 0.12, baseH: 1.2, cavity: 0.2, blotch: 0.3 });
    finish(mossGeo);
    parts.push({ geo: mossGeo, matName: mossMat, cast: false, side: THREE.DoubleSide });
  }
  return { parts, tips, height: top };
}

/** Cheap far-LOD tree: trunk + four stubs, ~1/8 the triangles. */
export function deadTreeLOD(rand, index) {
  const spec = TREE_SPECS[index % TREE_SPECS.length];
  const seed = 2000 + index * 41;
  const parts = [];
  const nodes = 5;
  const spine = [];
  let x = 0, z = 0;
  for (let i = 0; i <= nodes; i++) {
    const t = i / nodes;
    x += (perlin3(t * 3, seed * 0.1, 0.5, seed) - 0.5) * 0.34;
    z += (perlin3(t * 3, seed * 0.1, 3.5, seed) - 0.5) * 0.34;
    spine.push({ x, y: t * spec.height * 0.82, z, r: spec.baseR * (1 - t * 0.78) });
  }
  const trunk = tube(spine, { radial: 5, uTile: 1 / 0.9, lobes: 3, lobeAmt: 0.18, seed, closeStart: true });
  if (trunk) parts.push(trunk);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    const t = 0.55 + i * 0.1;
    const from = spine[Math.min(nodes, Math.round(t * nodes))];
    const len = spec.height * (0.3 - i * 0.03);
    const sp = [];
    for (let k = 0; k <= 2; k++) {
      const tt = k / 2;
      sp.push({
        x: from.x + Math.cos(a) * len * tt * 0.8,
        y: from.y + len * tt * 0.72,
        z: from.z + Math.sin(a) * len * tt * 0.8,
        r: spec.baseR * 0.4 * (1 - tt * 0.85),
      });
    }
    const g = tube(sp, { radial: 4, uTile: 1 / 0.9, lobes: 3, lobeAmt: 0.2, seed: seed + i });
    if (g) parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  geo.computeBoundingBox();
  const top = geo.boundingBox.max.y;
  setWind(geo, (gx, gy, gz) => clamp01(Math.pow(clamp01(gy / Math.max(0.5, top)), 1.7) * 0.8 + clamp01(Math.hypot(gx, gz) / 2.4) * 0.4));
  bakeWear(geo, { seed, base: 0.5, baseH: 0.5, cavity: 0.35, blotch: 0.22 });
  finish(geo);
  return { parts: [{ geo, matName: 'barkBare', cast: true }] };
}

/** A single hanging strand of moss/lichen: a narrow tapering double-sided ribbon. */
function mossStrandGeo(rand, len = 1.0, wisps = 3) {
  const parts = [];
  for (let w = 0; w < wisps; w++) {
    const segs = 5;
    const ww = 0.05 + rand() * 0.07;
    const ox = (rand() - 0.5) * 0.14, oz = (rand() - 0.5) * 0.14;
    const sway = (rand() - 0.5) * 0.3;
    const pos = [], uvs = [], idx = [], wind = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const y = -t * len * (0.7 + rand() * 0.6);
      const half = ww * (1 - t * 0.75) * 0.5;
      const cx = ox + sway * t * t;
      pos.push(cx - half, y, oz + t * 0.05);
      pos.push(cx + half, y, oz - t * 0.05);
      uvs.push(0, t * len, ww, t * len);
      wind.push(t, t);
    }
    for (let s = 0; s < segs; s++) {
      const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setAttribute(WIND_ATTR, new THREE.BufferAttribute(new Float32Array(wind), 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeParts(parts);
}

/** Standalone hanging moss curtain — hung off arches, lintels and cage bars. */
export function hangingMoss(rand, index) {
  const len = [1.4, 0.9][index % 2];
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const g = mossStrandGeo(rand, len * (0.6 + rand() * 0.7), 3);
    if (!g) continue;
    xform(g, { pos: [(rand() - 0.5) * 0.5, 0, (rand() - 0.5) * 0.5], rotY: rand() * 6.28 });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  setWind(geo, (x, y) => clamp01(-y / len));
  bakeWear(geo, { seed: 41 + index, base: 0.1, baseH: 2, cavity: 0.18, blotch: 0.32 });
  finish(geo);
  return { parts: [{ geo, matName: 'moss', cast: false, side: THREE.DoubleSide }] };
}

/* ------------------------------------------------------------------ *
 * shrubs, brambles, thorn
 * ------------------------------------------------------------------ */

/** Bare woody shrub: a fistful of thin twigs springing from one crown. */
export function bareShrub(rand, index) {
  const spec = [
    { n: 16, h: 0.85, r: 0.016, spread: 0.55, arc: 0.5 },
    { n: 24, h: 0.55, r: 0.012, spread: 0.7, arc: 0.85 },
    { n: 12, h: 1.25, r: 0.021, spread: 0.4, arc: 0.3 },
  ][index % 3];
  const parts = [];
  for (let i = 0; i < spec.n; i++) {
    const a = rand() * Math.PI * 2;
    const tilt = 0.15 + rand() * spec.arc;
    const h = spec.h * (0.55 + rand() * 0.8);
    const segs = 4;
    const sp = [];
    let px = 0, py = 0, pz = 0;
    let dx = Math.sin(tilt) * Math.cos(a), dy = Math.cos(tilt), dz = Math.sin(tilt) * Math.sin(a);
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      sp.push({ x: px, y: py, z: pz, r: spec.r * (1 - t * 0.88) });
      const step = h / segs;
      // twigs curl outward and then back down
      dx += Math.cos(a) * 0.28 * step;
      dz += Math.sin(a) * 0.28 * step;
      dy -= 0.32 * step;
      const l = Math.hypot(dx, dy, dz) || 1;
      px += (dx / l) * step; py += (dy / l) * step; pz += (dz / l) * step;
    }
    const g = tube(sp, { radial: 4, uTile: 1 / 0.42, lobes: 3, lobeAmt: 0.22, seed: 300 + i });
    if (g) parts.push(g);
    // side thorns on a third of the twigs
    if (rand() < 0.36) {
      const t2 = [];
      const base = sp[2];
      const ta = rand() * 6.28;
      for (let k = 0; k <= 1; k++) {
        t2.push({
          x: base.x + Math.cos(ta) * 0.07 * k, y: base.y + 0.03 * k,
          z: base.z + Math.sin(ta) * 0.07 * k, r: spec.r * 0.5 * (1 - k * 0.9),
        });
      }
      const tg = tube(t2, { radial: 3, uTile: 1 / 0.42, lobeAmt: 0.1, seed: 400 + i });
      if (tg) parts.push(tg);
    }
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  geo.computeBoundingBox();
  const top = Math.max(0.3, geo.boundingBox.max.y);
  setWind(geo, (x, y) => clamp01(Math.pow(clamp01(y / top), 1.4)));
  bakeWear(geo, { seed: 500 + index, base: 0.46, baseH: 0.3, cavity: 0.3, blotch: 0.26 });
  finish(geo);
  return { parts: [{ geo, matName: 'thorn', cast: index === 2 }] };
}

/** Low bramble tangle: interlaced arcs that dive back into the ground. */
export function bramble(rand, index) {
  const spec = [{ n: 12, r: 1.1 }, { n: 18, r: 1.5 }, { n: 8, r: 0.75 }][index % 3];
  const parts = [];
  for (let i = 0; i < spec.n; i++) {
    const a0 = rand() * Math.PI * 2;
    const span = spec.r * (0.4 + rand() * 0.8);
    const arch = 0.18 + rand() * 0.42;
    const x0 = Math.cos(a0) * span * 0.5, z0 = Math.sin(a0) * span * 0.5;
    const a1 = a0 + Math.PI * (0.6 + rand() * 0.8);
    const x1 = Math.cos(a1) * span * 0.5, z1 = Math.sin(a1) * span * 0.5;
    const segs = 6;
    const sp = [];
    const rr = 0.009 + rand() * 0.008;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      sp.push({
        x: lerp(x0, x1, t) + Math.sin(t * 7 + i) * 0.06,
        y: Math.sin(t * Math.PI) * arch - 0.03,
        z: lerp(z0, z1, t) + Math.cos(t * 6 + i) * 0.06,
        r: rr * (0.6 + 0.5 * Math.sin(t * Math.PI)),
      });
    }
    const g = tube(sp, { radial: 4, uTile: 1 / 0.42, lobes: 3, lobeAmt: 0.24, seed: 600 + i });
    if (g) parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  setWind(geo, (x, y) => clamp01(y * 2.2) * 0.7);
  bakeWear(geo, { seed: 700 + index, base: 0.4, baseH: 0.2, cavity: 0.3, blotch: 0.3 });
  finish(geo);
  return { parts: [{ geo, matName: 'thorn', cast: false }] };
}

/* ------------------------------------------------------------------ *
 * grass, sedge, reeds
 * ------------------------------------------------------------------ */

const TUFT_SPECS = [
  { count: 11, h: 0.34, w: 0.026, spread: 0.13, bend: 0.5, mat: 'foliage' },
  { count: 16, h: 0.24, w: 0.022, spread: 0.18, bend: 0.75, mat: 'foliageDry' },
  { count: 8, h: 0.52, w: 0.03, spread: 0.1, bend: 0.32, mat: 'foliage' },
  { count: 21, h: 0.18, w: 0.019, spread: 0.22, bend: 0.9, mat: 'foliageDry' },
];

export function grassTuft(rand, index) {
  const s = TUFT_SPECS[index % TUFT_SPECS.length];
  const geo = bladeCluster({
    rand, count: s.count, h: s.h, w: s.w, spread: s.spread, bend: s.bend,
    segs: 3, hVar: 0.55, twist: 0.7, uPeriod: 0.55, ribs: 4,
  });
  // ground-hugging dressing: darken the roots hard so the tuft reads as growing
  // out of the dirt rather than sitting on top of it
  bakeWear(geo, {
    seed: 800 + index, base: 0.62, baseH: 0.45, cavity: 0.12, blotch: 0.3, blotchFreq: 5,
  });
  finish(geo);
  return { parts: [{ geo, matName: s.mat, cast: false, side: THREE.DoubleSide }] };
}

export function reeds(rand, index) {
  const s = [{ count: 9, h: 1.35, w: 0.022 }, { count: 14, h: 0.95, w: 0.018 }][index % 2];
  const geo = bladeCluster({
    rand, count: s.count, h: s.h, w: s.w, spread: 0.1, bend: 0.22,
    segs: 5, hVar: 0.4, twist: 0.3, uPeriod: 0.7, ribs: 4,
  });
  bakeWear(geo, { seed: 900 + index, base: 0.5, baseH: 0.3, cavity: 0.1, blotch: 0.24, blotchFreq: 3 });
  finish(geo);
  return { parts: [{ geo, matName: 'reed', cast: false, side: THREE.DoubleSide }] };
}

/* ------------------------------------------------------------------ *
 * roots breaking ground
 * ------------------------------------------------------------------ */

/**
 * Roots that arc out of the soil and back in. Placed so the arcs sit just above
 * the terrain surface — the entry/exit points are pushed below y=0 so nothing
 * ends in mid-air.
 */
export function groundRoots(rand, index) {
  const n = [4, 7, 3][index % 3];
  const scale = [1, 1.5, 0.7][index % 3];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 1.1;
    const len = (0.9 + rand() * 1.5) * scale;
    const rise = (0.07 + rand() * 0.14) * scale;
    const segs = 7;
    const sp = [];
    const rr = (0.03 + rand() * 0.035) * scale;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const wob = Math.sin(t * 9 + i * 2.1) * 0.09 * scale;
      sp.push({
        x: Math.cos(a) * len * t + Math.sin(a) * wob,
        y: Math.sin(t * Math.PI) * rise - 0.12 * scale,
        z: Math.sin(a) * len * t - Math.cos(a) * wob,
        r: rr * (1 - t * 0.62) * (0.7 + 0.5 * Math.sin(t * Math.PI)),
      });
    }
    const g = tube(sp, { radial: 5, uTile: 1 / 0.9, lobes: 3, lobeAmt: 0.2, seed: 1100 + i });
    if (g) parts.push(g);
  }
  // a knuckle where they all meet
  const knot = latheGeo(
    [[0.06 * scale, -0.14 * scale], [0.16 * scale, -0.04 * scale], [0.13 * scale, 0.08 * scale], [0.05 * scale, 0.13 * scale]],
    { seg: 8, uTile: 1 / 0.9, seed: 1200 + index, lobeAmt: 0.18, lobes: 4, capTop: true }
  );
  parts.push(knot);
  const geo = mergeParts(parts);
  if (!geo) return null;
  setWind(geo, () => 0);
  bakeWear(geo, {
    seed: 1300 + index, base: 0.55, baseH: 0.28, cavity: 0.38, blotch: 0.28,
    moss: 0.4, mossColor: [0.45, 0.55, 0.4], mossDir: [0, 1, 0],
  });
  finish(geo);
  return { parts: [{ geo, matName: 'barkStatic', cast: false }] };
}

/* ------------------------------------------------------------------ *
 * dry heather mat — a wide low ground-cover patch that hides the terrain
 * texture seam where dressing meets bare ground
 * ------------------------------------------------------------------ */

export function heatherMat(rand, index) {
  const r = 0.7 + index * 0.35;
  const parts = [];
  const clumps = 5 + index * 3;
  for (let i = 0; i < clumps; i++) {
    const a = rand() * 6.283;
    const rr = Math.pow(rand(), 0.6) * r;
    const g = bladeCluster({
      rand, count: 6 + (i % 4), h: 0.13 + rand() * 0.1, w: 0.02, spread: 0.1,
      bend: 0.9 + rand() * 0.5, segs: 3, hVar: 0.5, twist: 0.8, uPeriod: 0.55, ribs: 4,
    });
    xform(g, { pos: [Math.cos(a) * rr, 0, Math.sin(a) * rr], rotY: rand() * 6.283 });
    parts.push(g);
  }
  const geo = mergeParts(parts);
  if (!geo) return null;
  bakeWear(geo, { seed: 1400 + index, base: 0.66, baseH: 0.5, cavity: 0.1, blotch: 0.34, blotchFreq: 3 });
  paintVertex(geo, (x, y, z, nx, ny, nz, out) => {
    // radial dry-out so the patch fades into the terrain instead of stopping dead
    const d = clamp01(Math.hypot(x, z) / r);
    const k = lerp(1, 0.72, smooth01(0.45, 1, d));
    out[0] = k * lerp(1, 1.1, d); out[1] = k; out[2] = k * lerp(1, 0.82, d);
    void nx; void ny; void nz; void fbm3;
  });
  finish(geo);
  return { parts: [{ geo, matName: 'foliageDry', cast: false, side: THREE.DoubleSide }] };
}
