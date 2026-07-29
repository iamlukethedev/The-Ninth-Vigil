/**
 * SANCTUM — Town geometry kit.
 *
 * Every piece of the settlement is built here as plain local-space geometry and
 * handed to an `Assembler`, which transforms it, files it under a material name,
 * and finally merges each material's pile into ONE buffer. That is the whole
 * draw-call strategy: a ten-building village, a curtain wall, a market and a
 * shrine come out as eight meshes.
 *
 * Rules this file exists to enforce:
 *  • **No raw BoxGeometry.** Everything solid comes through `box()`, which is a
 *    RoundedBoxGeometry — a sharp 90° corner catches no highlight and reads as
 *    prototype (explicit critic fail).
 *  • **UVs in metres.** Merged geometry is triplanar-projected in building
 *    space at 1 unit = 1 m, so the material's own `tiling` decides the physical
 *    grain size and an ashlar course lands at 0.32 m as specified.
 *  • **Baked directional occlusion in vertex colour.** The materials run on a
 *    three-sampler diet with no aoMap, so the cavity term has to live in the
 *    mesh: darker at the ground, under eaves, on downward faces, inside
 *    doorways. This is what stops a building meeting the road at a hard
 *    unshaded line.
 *
 * Determinism: geometry is a pure function of its arguments and a seed.
 */

import * as THREE from 'three';
import {
  boxGeo, latheGeo, clothGeo, chainGeo, tube, xform, mergeParts, finish,
  ensureAttrs, faceBoxUV, paintVertex, bakeWear, fbm3, clamp01, clamp, lerp, smooth01, triCount,
} from '../props/Geo.js';

export {
  boxGeo, latheGeo, clothGeo, chainGeo, tube, xform, mergeParts, finish,
  ensureAttrs, faceBoxUV, paintVertex, bakeWear, fbm3, clamp01, clamp, lerp, smooth01, triCount,
};

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();

/** Bevelled solid. Bevel scales with the smallest dimension so thin boards
 *  keep a readable rounded arris instead of collapsing into a cylinder. */
export function box(w, h, d, bevel = null, seg = 1) {
  const b = bevel == null ? Math.min(0.022, Math.min(w, h, d) * 0.26) : bevel;
  return boxGeo(w, h, d, { bevel: b, seg, uTile: 1 });
}

/**
 * A hewn timber. Real framing is squared with an adze, so it is neither
 * perfectly straight nor perfectly square: this tapers slightly along its
 * length, bows a few millimetres, and rolls the arris. Length runs +Y.
 */
export function beam(len, w, d, { seed = 3, bow = 0.012, taper = 0.05, seg = 3 } = {}) {
  const g = boxGeo(w, len, d, { bevel: Math.min(0.02, Math.min(w, d) * 0.22), seg, uTile: 1 });
  const p = g.getAttribute('position');
  const half = len * 0.5;
  const ph = (fbm3(seed * 0.7, 1.3, 2.1, { octaves: 2, seed }) - 0.5) * Math.PI * 2;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const t = (y + half) / Math.max(1e-4, len);
    const k = 1 - taper * t;
    const s = Math.sin(t * Math.PI) * bow;
    p.setX(i, p.getX(i) * k + Math.cos(ph) * s);
    p.setZ(i, p.getZ(i) * k + Math.sin(ph) * s);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Sawn board. Same idea as `beam` but flat, cupped across its width (boards
 * always cup away from the heart) and with a ragged end.
 */
export function board(len, w, t, { seed = 5, cup = 0.1, seg = 2 } = {}) {
  const g = boxGeo(w, t, len, { bevel: Math.min(0.008, t * 0.4), seg, uTile: 1 });
  const p = g.getAttribute('position');
  const hw = w * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / Math.max(1e-4, hw);
    const n = fbm3(p.getZ(i) * 2.4, x * 1.7, seed, { octaves: 2, seed });
    p.setY(i, p.getY(i) + (x * x - 0.5) * t * cup + (n - 0.5) * t * 0.35);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * A shingled roof panel, built as a *coursed* surface rather than as thousands
 * of individual shakes.
 *
 * The plane runs +X across the eaves and +Z up the slope. Each course steps
 * proud of the one above it by `step`, and each shake within a course is
 * scalloped at its butt and given an individual height jitter, so the geometry
 * itself produces the course shadow line and the broken butt edge that read as a
 * shingle roof. A per-shake box would cost ~500 draw-worth of triangles per
 * face; this costs `courses * shakes * 8`.
 *
 * UVs are authored: u across the eaves in metres, v up the slope in metres, so
 * the material's shake texture stays square on a sloped surface (a triplanar
 * projection would compress it by cos(pitch)).
 */
export function shingleRoof(width, run, {
  course = 0.26, shake = 0.30, step = 0.028, thick = 0.05, seed = 7,
  overhangSide = 0.16, jitter = 0.16, ridgeGap = 0.0,
} = {}) {
  const nC = Math.max(2, Math.round(run / course));
  const nS = Math.max(3, Math.round((width + overhangSide * 2) / shake));
  const W = width + overhangSide * 2;
  const dS = W / nS;
  const dC = (run - ridgeGap) / nC;

  const pos = [], nor = [], uv = [], idx = [];
  const push = (x, y, z, u, v) => { pos.push(x, y, z); nor.push(0, 1, 0); uv.push(u, v); };

  for (let c = 0; c < nC; c++) {
    const z0 = c * dC;
    const z1 = z0 + dC;
    // courses are laid from the eaves up; each one lifts a little more
    const yTop = thick + c * step * 0.35;
    const yBot = thick + Math.max(0, c - 1) * step * 0.35 + step;
    for (let s = 0; s < nS; s++) {
      const stag = (c & 1) ? dS * 0.5 : 0;
      let x0 = -W * 0.5 + s * dS + stag;
      let x1 = x0 + dS;
      if (x1 < -W * 0.5 || x0 > W * 0.5) continue;
      x0 = Math.max(x0, -W * 0.5); x1 = Math.min(x1, W * 0.5);
      if (x1 - x0 < dS * 0.2) continue;

      const h = fbm3(s * 1.7, c * 2.3, seed, { octaves: 2, seed }) - 0.5;
      const lift = h * jitter * step * 3.0;
      const gap = dS * 0.055 * (0.5 + fbm3(s * 3.1, c * 1.1, seed + 3, { octaves: 1, seed }));
      const a0 = x0 + gap, a1 = x1 - gap;
      // butt end sags a touch at its outer corners — riven shakes never sit flat
      const sag = step * 0.55 * (0.4 + h * 0.7);

      const yb = yBot + lift;
      const yt = yTop + lift * 0.35;
      const base = pos.length / 3;
      // upper (buried) edge
      push(a0, yt, z1, a0, z1);
      push(a1, yt, z1, a1, z1);
      // butt edge, proud and slightly sagging at the corners
      push(a0, yb - sag, z0, a0, z0);
      push(a1, yb - sag, z0, a1, z0);
      // the butt's vertical face — this is the shadow line that makes courses read
      push(a0, yb - sag - step * 0.85, z0, a0, z0 - step);
      push(a1, yb - sag - step * 0.85, z0, a1, z0 - step);
      // Winding matters: three.js derives the normal from it and culls the back
      // face, so a roof wound the wrong way round is not a dark roof — it is an
      // invisible roof you can see the room through. Up-facing for the two slope
      // quads, outward-facing (-Z, toward the eaves) for the butt.
      idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      idx.push(base + 2, base + 3, base + 4, base + 3, base + 5, base + 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A plaster infill panel. Bulges outward between its framing timbers (lime
 * render over a woven withy panel always does) and is thin, so its edge shows
 * against the frame.
 */
export function infillPanel(w, h, t, { seed = 9, bulge = 0.028, segX = 5, segY = 5 } = {}) {
  const g = boxGeo(w, h, t, { bevel: Math.min(0.01, t * 0.4), seg: Math.max(segX, segY), uTile: 1 });
  const p = g.getAttribute('position');
  const hw = w * 0.5, hh = h * 0.5, ht = t * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Math.abs(z) < ht * 0.6) continue;
    const fx = 1 - (x / hw) * (x / hw);
    const fy = 1 - (y / hh) * (y / hh);
    const n = fbm3(x * 2.2, y * 2.2, seed, { octaves: 3, seed }) - 0.5;
    p.setZ(i, z + Math.sign(z) * (fx * fy * bulge + n * bulge * 0.55));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Sagging cloth stretched between two ridge poles.
 *
 * A flat quad awning is one of the tells that gives a procedural town away, so
 * this is a real surface: catenary sag across the span, a second sag along it,
 * wind-lift ripple, and a scalloped valance at the front edge. `stripe` writes
 * a patched two-tone into vertex colour so a row of stalls reads as different
 * traders' cloth without a second material.
 */
export function awningGeo(span, depth, {
  sag = 0.16, sagAlong = 0.05, ripple = 0.035, segX = 12, segZ = 8, seed = 11,
  valance = 0.14, stripe = null, stripeW = 0.34,
} = {}) {
  const vx = segX + 1, vz = segZ + 1;
  const rows = vz + 1;                       // +1 for the hanging valance ring
  const pos = new Float32Array(vx * rows * 3);
  const uv = new Float32Array(vx * rows * 2);
  const col = new Float32Array(vx * rows * 3).fill(1);
  const idx = [];
  const cosh = (v) => (Math.exp(v) + Math.exp(-v)) * 0.5;

  for (let j = 0; j < rows; j++) {
    const valRow = j === rows - 1;
    const tz = valRow ? 1 : j / segZ;
    for (let i = 0; i < vx; i++) {
      const tx = i / segX;
      const x = (tx - 0.5) * span;
      const z = tz * depth;
      // catenary across the span, deepest in the middle of the run
      let y = -(cosh((tx - 0.5) * 2.4) - 1) * sag;
      // and a shallower sag along the depth, so the front lip drops
      y -= Math.sin(tz * Math.PI) * sagAlong;
      // wind lift + weave slack
      y += (fbm3(tx * 3.4, tz * 2.6, seed, { octaves: 3, seed }) - 0.5) * ripple * 2;
      y += Math.sin(tx * Math.PI * 3.0 + seed) * ripple * 0.5 * tz;
      let yy = y, zz = z;
      if (valRow) {
        // the valance: cloth folds down over the front rail, cut in scallops
        const sc = 0.55 + 0.45 * Math.sin(tx * Math.PI * segX * 0.5);
        yy = y - valance * (0.55 + 0.45 * sc);
        zz = z + 0.012;
      }
      const k = (j * vx + i) * 3;
      pos[k] = x; pos[k + 1] = yy; pos[k + 2] = zz;
      const u = (j * vx + i) * 2;
      uv[u] = tx * span; uv[u + 1] = tz * depth;
      if (stripe) {
        const band = Math.floor((tx * span) / stripeW) & 1;
        const c = band ? stripe : [1, 1, 1];
        // sun-bleach the crown of the sag, grime the shaded folds
        const wear = 1 + (y + sag) * 0.55 - tz * 0.14;
        col[k] = c[0] * wear; col[k + 1] = c[1] * wear; col[k + 2] = c[2] * wear;
      }
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Leaded window: a mullioned frame with diamond quarries. Returns the frame
 * geometry and the glazing plane separately, because the glazing goes on the
 * emissive material and the frame does not.
 */
export function leadedWindow(w, h, { bars = 2, tiers = 3, frame = 0.055, depth = 0.10, seed = 4 } = {}) {
  const parts = [];
  const t = frame;
  // outer frame
  parts.push(xform(box(w, t, depth, 0.012), { pos: [0, h * 0.5 - t * 0.5, 0] }));
  parts.push(xform(box(w, t, depth, 0.012), { pos: [0, -h * 0.5 + t * 0.5, 0] }));
  parts.push(xform(box(t, h, depth, 0.012), { pos: [-w * 0.5 + t * 0.5, 0, 0] }));
  parts.push(xform(box(t, h, depth, 0.012), { pos: [w * 0.5 - t * 0.5, 0, 0] }));
  // mullions + transoms, slightly thinner
  for (let i = 1; i <= bars; i++) {
    const x = -w * 0.5 + (w * i) / (bars + 1);
    parts.push(xform(box(t * 0.72, h - t * 1.6, depth * 0.82, 0.008), { pos: [x, 0, 0] }));
  }
  for (let j = 1; j <= tiers; j++) {
    const y = -h * 0.5 + (h * j) / (tiers + 1);
    parts.push(xform(box(w - t * 1.6, t * 0.6, depth * 0.7, 0.008), { pos: [0, y, 0] }));
  }
  const frameGeo = mergeParts(parts);

  // glazing: a slightly irregular plane pushed back into the reveal, faceted so
  // old hand-blown glass catches the light unevenly
  const gx = 7, gy = 9;
  const gpos = [], gnor = [], guv = [], gidx = [];
  const iw = w - t * 1.5, ih = h - t * 1.5;
  for (let j = 0; j <= gy; j++) {
    for (let i = 0; i <= gx; i++) {
      const u = i / gx, v = j / gy;
      const n = fbm3(u * 5, v * 6, seed, { octaves: 2, seed });
      gpos.push((u - 0.5) * iw, (v - 0.5) * ih, -depth * 0.22 + (n - 0.5) * 0.012);
      gnor.push(0, 0, 1);
      guv.push(u * iw, v * ih);
    }
  }
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const a = j * (gx + 1) + i, b = a + 1, c = a + gx + 1, d = c + 1;
      gidx.push(a, b, c, b, d, c);        // glazing faces +Z, out of the reveal
    }
  }
  const glass = new THREE.BufferGeometry();
  glass.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3));
  glass.setAttribute('normal', new THREE.Float32BufferAttribute(gnor, 3));
  glass.setAttribute('uv', new THREE.Float32BufferAttribute(guv, 2));
  glass.setIndex(gidx);
  glass.computeVertexNormals();
  return { frame: frameGeo, glass };
}

/** Vertical-plank door with iron straps, a ring handle and a worn threshold. */
export function plankDoor(w, h, { planks = 5, seed = 6, straps = 2 } = {}) {
  const wood = [];
  const iron = [];
  const pw = w / planks;
  for (let i = 0; i < planks; i++) {
    const x = -w * 0.5 + pw * (i + 0.5);
    const jitter = (fbm3(i * 2.1, 0.4, seed, { octaves: 1, seed }) - 0.5);
    const g = board(h + jitter * 0.05, pw * 0.94, 0.055, { seed: seed + i, cup: 0.14, seg: 2 });
    // board() lays length along +Z; stand it up
    wood.push(xform(g, { euler: [Math.PI * 0.5, 0, 0], pos: [x, 0, 0] }));
  }
  for (let s = 0; s < straps; s++) {
    const y = -h * 0.5 + h * (0.24 + 0.5 * s);
    iron.push(xform(box(w * 0.94, 0.062, 0.028, 0.008), { pos: [0, y, 0.042] }));
    // a hinge pintle at the hanging edge
    iron.push(xform(box(0.07, 0.10, 0.05, 0.012), { pos: [-w * 0.5 + 0.03, y, 0.05] }));
  }
  const ring = new THREE.TorusGeometry(0.055, 0.013, 6, 12);
  iron.push(xform(faceBoxUV(ring, 1), { euler: [Math.PI * 0.5, 0, 0], pos: [w * 0.28, 0.02, 0.075] }));
  return { wood: mergeParts(wood), iron: mergeParts(iron) };
}

/** Stone chimney stack: battered shaft, corbelled cap, a scorched flue mouth. */
export function chimneyGeo(h, { w = 0.62, d = 0.52, seed = 8 } = {}) {
  const parts = [];
  const shaft = box(w, h, d, 0.03, 3);
  const p = shaft.getAttribute('position');
  const half = h * 0.5;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + half) / h;
    const k = 1 - t * 0.16;                       // batter: wider at the base
    const n = fbm3(p.getX(i) * 3, p.getY(i) * 2.4, seed, { octaves: 2, seed }) - 0.5;
    p.setX(i, p.getX(i) * k + n * 0.012);
    p.setZ(i, p.getZ(i) * k + n * 0.012);
  }
  p.needsUpdate = true;
  shaft.computeVertexNormals();
  parts.push(shaft);
  // corbel courses
  parts.push(xform(box(w * 1.16, 0.10, d * 1.16, 0.02), { pos: [0, half - 0.02, 0] }));
  parts.push(xform(box(w * 1.05, 0.09, d * 1.05, 0.02), { pos: [0, half - 0.13, 0] }));
  // pot rim, hollow-ish
  parts.push(xform(box(w * 0.9, 0.14, d * 0.9, 0.02), { pos: [0, half + 0.10, 0] }));
  return mergeParts(parts);
}

/**
 * Hanging shop sign: wrought bracket, a swinging board, two links.
 * Returns iron and wood piles so each lands on the right material.
 */
export function shopSign(len, { boardW = 0.52, boardH = 0.42, seed = 12 } = {}) {
  const iron = [], wood = [];
  iron.push(xform(box(len, 0.045, 0.045, 0.01), { pos: [len * 0.5, 0, 0] }));
  iron.push(xform(box(0.09, 0.16, 0.06, 0.012), { pos: [0.02, -0.04, 0] }));
  // a diagonal brace, because a cantilevered bracket without one reads as wrong
  const brace = box(len * 0.62, 0.032, 0.032, 0.008);
  iron.push(xform(brace, { euler: [0, 0, -0.72], pos: [len * 0.30, -len * 0.26, 0] }));
  const ch = chainGeo({ end: [0, -0.16, 0], links: 3, linkR: 0.026, wire: 0.008, slack: 0.02, seed });
  iron.push(xform(ch.clone(), { pos: [len * 0.78, -0.02, 0] }));
  iron.push(xform(ch, { pos: [len * 0.30, -0.02, 0] }));
  const b = board(boardH, boardW, 0.035, { seed: seed + 1, cup: 0.08 });
  wood.push(xform(b, { euler: [Math.PI * 0.5, 0, 0.06], pos: [len * 0.54, -0.20 - boardH * 0.5, 0] }));
  return { iron: mergeParts(iron), wood: mergeParts(wood) };
}

/** A sharpened palisade stake. Length runs +Y, point at the top. */
export function stakeGeo(h, r, { seed = 3, seg = 7 } = {}) {
  const spine = [];
  const N = 5;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const n = fbm3(t * 3, seed * 0.4, 1.1, { octaves: 2, seed }) - 0.5;
    const rr = t > 0.82 ? r * (1 - (t - 0.82) / 0.18) * 0.95 + 0.006 : r * (1 - t * 0.10);
    spine.push({ x: n * 0.02 * t, y: t * h, z: n * 0.018 * t, r: rr, lobe: 0.16 });
  }
  return tube(spine, { radial: seg, uTile: 1, capEnd: true, closeStart: true, lobes: 5, lobeAmt: 0.09, seed });
}

/* ------------------------------------------------------------------ *
 * assembly
 * ------------------------------------------------------------------ */

/**
 * Collects geometry per material name, transforming as it goes.
 *
 * Usage:
 *   const A = new Assembler();
 *   A.add('timber', beam(3, .16, .16), { pos:[0, 1.5, 0] });
 *   const piles = A.piles();      // Map<matName, BufferGeometry>
 */
export class Assembler {
  constructor() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.bins = new Map();
    this.count = 0;
  }

  /**
   * @param {string} mat bank material name
   * @param {THREE.BufferGeometry|null} geo
   * @param {{pos?:number[], euler?:number[], rotY?:number, quat?:THREE.Quaternion, scale?:number|number[]}} [tr]
   */
  add(mat, geo, tr = null) {
    if (!geo) return this;
    const g = geo;                       // the assembler takes ownership
    if (tr) {
      _q.identity();
      if (tr.quat) _q.copy(tr.quat);
      else if (tr.euler) _q.setFromEuler(_e.set(tr.euler[0], tr.euler[1], tr.euler[2]));
      else if (tr.rotY) _q.setFromAxisAngle(_UP, tr.rotY);
      const sc = tr.scale ?? 1;
      if (typeof sc === 'number') _s3.set(sc, sc, sc); else _s3.set(sc[0], sc[1], sc[2]);
      const pp = tr.pos ?? [0, 0, 0];
      _v3.set(pp[0], pp[1], pp[2]);
      _m4.compose(_v3, _q, _s3);
      g.applyMatrix4(_m4);
    }
    let a = this.bins.get(mat);
    if (!a) this.bins.set(mat, (a = []));
    a.push(g);
    this.count++;
    return this;
  }

  /** Merge everything else in, keeping the other assembler's material split. */
  absorb(other, tr = null) {
    if (!other) return this;
    for (const [mat, list] of other.bins) {
      for (const g of list) this.add(mat, g, tr);
    }
    other.bins.clear();
    return this;
  }

  /** @returns {Map<string, THREE.BufferGeometry>} one merged buffer per material */
  piles() {
    const out = new Map();
    for (const [mat, list] of this.bins) {
      const merged = mergeParts(list);
      if (merged) out.set(mat, merged);
    }
    this.bins.clear();
    return out;
  }

  isEmpty() { return this.count === 0; }
}

const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Triplanar-project UVs in metres. Run this on a merged pile in the space you
 * want the texture to be continuous in (building-local, usually) — never on
 * geometry whose UVs were authored parametrically (roofs, cloth).
 */
export function projectUV(geo, scale = 1) {
  const out = faceBoxUV(geo, scale);
  if (out !== geo) geo.dispose();
  return out;
}

/**
 * Bake directional occlusion + weathering into vertex colour, for a piece of
 * architecture rather than a loose prop.
 *
 * `groundY` is where the geometry meets the road, `eaveY` where an overhang
 * starts shading the wall below it. Both produce gradients; downward-facing and
 * inward-facing normals produce cavity darkening; a seeded blotch field means no
 * two buildings weather the same way. Optional `damp` adds green-black algae
 * creeping up from the base, and `soot` darkens toward a chimney.
 */
export function bakeArch(geo, {
  seed = 1, groundY = 0, groundH = 0.55, groundK = 0.5,
  eaveY = null, eaveK = 0.42, eaveH = 1.6,
  cavity = 0.36, blotch = 0.16, blotchFreq = 0.9,
  damp = 0.0, dampColor = [0.52, 0.62, 0.44], dampH = 0.9,
  dust = 0.0, dustColor = [1.14, 1.10, 1.02],
  tint = null, center = null,
} = {}) {
  ensureAttrs(geo);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = center ? center[0] : (bb.min.x + bb.max.x) * 0.5;
  const cz = center ? center[1] : (bb.min.z + bb.max.z) * 0.5;
  return paintVertex(geo, (x, y, z, nx, ny, nz, out) => {
    // 1. contact darkening where the wall meets the ground
    let k = 1 - groundK * (1 - smooth01(groundY, groundY + groundH, y));
    // 2. eave shadow: the wall gets darker the closer it is under the overhang
    if (eaveY != null && y < eaveY) {
      k *= 1 - eaveK * smooth01(eaveY - eaveH, eaveY, y);
    }
    // 3. cavity: downward faces and faces looking inward at the building core
    const down = clamp01(-ny);
    const inward = clamp01(-(nx * (x - cx) + nz * (z - cz)) * 1.6);
    k *= 1 - cavity * (down * 0.72 + inward * 0.34);
    // 4. weathering blotch
    const bl = fbm3(x * blotchFreq, y * blotchFreq * 0.7, z * blotchFreq, { octaves: 3, seed, gain: 0.55 });
    k *= 1 + (bl - 0.5) * 2 * blotch;
    out[0] = k; out[1] = k; out[2] = k;
    if (damp > 0) {
      const low = smooth01(groundY + dampH, groundY, y);
      const facing = clamp01(0.35 + 0.65 * clamp01(ny));
      const patch = clamp01(fbm3(x * 1.9, y * 1.1, z * 1.9, { octaves: 3, seed: seed + 77 }) * 1.6 - 0.45);
      const a = damp * low * patch * facing;
      out[0] = lerp(out[0], dampColor[0] * k, a);
      out[1] = lerp(out[1], dampColor[1] * k, a);
      out[2] = lerp(out[2], dampColor[2] * k, a);
    }
    if (dust > 0) {
      const up = clamp01(ny);
      const a = dust * up * clamp01(fbm3(x * 2.6, y * 2.2, z * 2.6, { octaves: 2, seed: seed + 131 }) * 1.5 - 0.2);
      out[0] = lerp(out[0], dustColor[0] * k, a);
      out[1] = lerp(out[1], dustColor[1] * k, a);
      out[2] = lerp(out[2], dustColor[2] * k, a);
    }
    if (tint) { out[0] *= tint[0]; out[1] *= tint[1]; out[2] *= tint[2]; }
  });
}
