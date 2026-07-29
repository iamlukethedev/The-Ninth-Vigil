/**
 * SANCTUM — Dungeon geometry primitives.
 *
 * Everything the architectural kit is built from. Two rules run through the
 * whole file:
 *
 *   1. **No sharp 90° edge, anywhere.** Every box is a chamfered box, every
 *      extrusion carries a bevel, every moulding profile has its own chamfer
 *      segments. A 90° corner returns no highlight and is the single loudest
 *      "untextured prototype" tell in a dark scene, so the bevel is not
 *      decoration — it is the thing that makes stone read as stone.
 *   2. **Flat facet normals wherever stone is dressed.** Smooth-shaded masonry
 *      looks like clay. Only the vault shell (a genuinely curved surface) is
 *      smooth-shaded, and it gets analytic normals.
 *
 * UVs written here are only a fallback: the dungeon materials override them in
 * the vertex shader with a world-space, metre-accurate planar projection, so a
 * 0.5 m ashlar block and a 24 m rock plateau share one texture scale.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SQ3 = 1 / Math.sqrt(3);
const SQ2 = Math.SQRT1_2;

/* ------------------------------------------------------------------ *
 * low-level emitters
 * ------------------------------------------------------------------ */

/** Push a triangle, auto-orienting the winding to match `n`. */
export function pushTri(pos, nor, a, b, c, n) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  if (cx * cx + cy * cy + cz * cz < 1e-16) return;   // degenerate
  const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
  const t = flip ? [a, c, b] : [a, b, c];
  for (let i = 0; i < 3; i++) {
    pos.push(t[i][0], t[i][1], t[i][2]);
    nor.push(n[0], n[1], n[2]);
  }
}

export function pushQuad(pos, nor, a, b, c, d, n) {
  pushTri(pos, nor, a, b, c, n);
  pushTri(pos, nor, a, c, d, n);
}

/** Flat-shaded quad whose normal is derived from its own corners. */
export function pushQuadAuto(pos, nor, a, b, c, d) {
  const n = faceNormal(a, b, c);
  pushTri(pos, nor, a, b, c, n);
  pushTri(pos, nor, a, c, d, n);
}

/** Smooth triangle: per-vertex normals, winding oriented by their average. */
export function pushTriSmooth(pos, nor, a, b, c, na, nb, nc) {
  const mx = na[0] + nb[0] + nc[0], my = na[1] + nb[1] + nc[1], mz = na[2] + nb[2] + nc[2];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const flip = cx * mx + cy * my + cz * mz < 0;
  const P = flip ? [a, c, b] : [a, b, c];
  const N = flip ? [na, nc, nb] : [na, nb, nc];
  for (let i = 0; i < 3; i++) {
    pos.push(P[i][0], P[i][1], P[i][2]);
    nor.push(N[i][0], N[i][1], N[i][2]);
  }
}

export function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Wrap raw arrays into a geometry, with a fallback planar UV set. */
export function finishGeo(pos, nor) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  autoUV(g);
  return g;
}

/**
 * Dominant-axis planar UV, computed per triangle from its own normal. Only a
 * fallback — the dungeon materials recompute this in world space — but it keeps
 * the geometry valid for anything that samples it directly (decals, shadows of
 * alpha-tested materials, debug materials).
 */
export function autoUV(geo, scale = 1) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.normal.array;
  const count = geo.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let t = 0; t < count; t += 3) {
    const i0 = t * 3;
    const ax = Math.abs(n[i0]), ay = Math.abs(n[i0 + 1]), az = Math.abs(n[i0 + 2]);
    let a = 0, b = 2;                                  // project onto XZ
    if (ay >= ax && ay >= az) { a = 0; b = 2; }
    else if (ax >= az) { a = 2; b = 1; }
    else { a = 0; b = 1; }
    for (let k = 0; k < 3; k++) {
      const v = (t + k) * 3;
      uv[(t + k) * 2] = p[v + a] * scale;
      uv[(t + k) * 2 + 1] = p[v + b] * scale;
    }
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/* ------------------------------------------------------------------ *
 * chamfered box — the workhorse
 * ------------------------------------------------------------------ */

/**
 * A box with all 6 faces, 12 edge chamfers and 8 corner facets. 44 triangles,
 * flat shaded. This is what every dressed stone in the dungeon is made of.
 */
export function chamferBox(w, h, d, c = 0.02) {
  const e = [w * 0.5, h * 0.5, d * 0.5];
  const cc = Math.max(0.0006, Math.min(c, Math.min(e[0], e[1], e[2]) * 0.42));
  const pos = [], nor = [];
  const P = (a, va, b, vb, g, vg) => { const p = [0, 0, 0]; p[a] = va; p[b] = vb; p[g] = vg; return p; };

  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, g = (a + 2) % 3;
    for (let s = 1; s >= -1; s -= 2) {
      const n = [0, 0, 0]; n[a] = s;
      const q = [];
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [sb, sg] of corners) q.push(P(a, s * e[a], b, sb * (e[b] - cc), g, sg * (e[g] - cc)));
      pushQuad(pos, nor, q[0], q[1], q[2], q[3], n);
    }
  }
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      const g = 3 - a - b;
      for (let sa = 1; sa >= -1; sa -= 2) {
        for (let sb = 1; sb >= -1; sb -= 2) {
          const n = [0, 0, 0]; n[a] = sa * SQ2; n[b] = sb * SQ2;
          const p1 = P(a, sa * e[a], b, sb * (e[b] - cc), g, -(e[g] - cc));
          const p2 = P(a, sa * e[a], b, sb * (e[b] - cc), g, (e[g] - cc));
          const p3 = P(a, sa * (e[a] - cc), b, sb * e[b], g, (e[g] - cc));
          const p4 = P(a, sa * (e[a] - cc), b, sb * e[b], g, -(e[g] - cc));
          pushQuad(pos, nor, p1, p2, p3, p4, n);
        }
      }
    }
  }
  for (let sx = 1; sx >= -1; sx -= 2) {
    for (let sy = 1; sy >= -1; sy -= 2) {
      for (let sz = 1; sz >= -1; sz -= 2) {
        const n = [sx * SQ3, sy * SQ3, sz * SQ3];
        pushTri(pos, nor,
          [sx * e[0], sy * (e[1] - cc), sz * (e[2] - cc)],
          [sx * (e[0] - cc), sy * e[1], sz * (e[2] - cc)],
          [sx * (e[0] - cc), sy * (e[1] - cc), sz * e[2]], n);
      }
    }
  }
  return finishGeo(pos, nor);
}

/* ------------------------------------------------------------------ *
 * bevelled extrusion — mouldings, arches, portal frames
 * ------------------------------------------------------------------ */

/**
 * Extrude a 2D outline along +Z, centred on z = 0, with a real bevel on the
 * outline so the reveal of an arch or the edge of a moulding catches light.
 *
 * @param {number[][]} pts     outline, CCW, [[x,y],...]
 * @param {number} depth
 * @param {number} bevel
 * @param {number[][][]} holes optional interior loops (CW)
 */
export function bevelExtrude(pts, depth, bevel = 0.016, holes = null) {
  const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
  if (holes) {
    for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 6,
  });
  g.translate(0, 0, -depth * 0.5);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ *
 * gothic arch mathematics
 * ------------------------------------------------------------------ */

/**
 * Two-centred (pointed) arch. Returns the height above the springing line for
 * `x` in [-halfSpan, halfSpan]. `riseRatio` is apex / halfSpan and must be > 1
 * or the arch is a plain semicircle.
 */
export function archY(x, halfSpan, riseRatio = 1.30) {
  const r0 = Math.max(1.0005, riseRatio);
  const d = (r0 * r0 - 1) * 0.5;
  const R = 1 + d;
  const t = Math.min(1, Math.abs(x) / halfSpan) + d;
  const v = R * R - t * t;
  return halfSpan * (v > 0 ? Math.sqrt(v) : 0);
}

/** Polyline of a pointed arch from the left springing over the apex to the right. */
export function archPath(halfSpan, riseRatio = 1.30, segs = 11, y0 = 0, offset = 0) {
  const out = [];
  const hs = halfSpan + offset;
  for (let i = -segs; i <= segs; i++) {
    const x = (i / segs) * hs;
    out.push([x, y0 + archY(x, hs, riseRatio)]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * swept profile — ribs, archivolts, chains of moulding
 * ------------------------------------------------------------------ */

/**
 * Sweep a closed 2D profile along a 3D path. `up[i]` gives the profile's local
 * +d direction at each path point (orthogonalised against the tangent).
 *
 * @param {number[][]} path   [[x,y,z],...]
 * @param {number[][]} up     same length, [[x,y,z],...]
 * @param {number[][]} prof   closed profile, [[s,d],...]
 * @param {boolean} caps
 */
export function sweepProfile(path, up, prof, caps = false) {
  const pos = [], nor = [];
  const n = path.length, m = prof.length;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const p = path[i];
    const pPrev = path[Math.max(0, i - 1)];
    const pNext = path[Math.min(n - 1, i + 1)];
    let tx = pNext[0] - pPrev[0], ty = pNext[1] - pPrev[1], tz = pNext[2] - pPrev[2];
    let tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    let dx = up[i][0], dy = up[i][1], dz = up[i][2];
    const dot = dx * tx + dy * ty + dz * tz;
    dx -= tx * dot; dy -= ty * dot; dz -= tz * dot;
    let dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // s = t x d
    let sx = ty * dz - tz * dy, sy = tz * dx - tx * dz, sz = tx * dy - ty * dx;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;
    const r = [];
    for (let k = 0; k < m; k++) {
      const s = prof[k][0], d = prof[k][1];
      r.push([p[0] + sx * s + dx * d, p[1] + sy * s + dy * d, p[2] + sz * s + dz * d]);
    }
    ring.push(r);
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = ring[i], r1 = ring[i + 1];
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      pushQuadAuto(pos, nor, r0[k], r0[k2], r1[k2], r1[k]);
    }
  }
  if (caps) {
    for (const e of [0, n - 1]) {
      const r = ring[e];
      const n0 = faceNormal(r[0], r[1], r[2]);
      const nn = e === 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
      for (let k = 1; k < m - 1; k++) pushTri(pos, nor, r[0], r[k], r[k + 1], nn);
    }
  }
  return finishGeo(pos, nor);
}

/** Chamfered rectangular rib profile hanging below a surface. */
export function ribProfile(w = 0.13, d = 0.17, c = 0.035) {
  const hw = w * 0.5;
  return [
    [-hw, 0], [-hw, d - c], [-hw + c, d], [hw - c, d], [hw, d - c], [hw, 0],
  ];
}

/* ------------------------------------------------------------------ *
 * lathe / revolve
 * ------------------------------------------------------------------ */

/**
 * Revolve a profile. `pts` are [radius, y]. Faceted by default (mouldings are
 * turned stone, not chrome), smooth for bowls and shafts.
 */
export function revolve(pts, segs = 16, flat = true) {
  const p = pts.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const g = new THREE.LatheGeometry(p, segs);
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  if (flat) out.computeVertexNormals();
  autoUV(out);
  return out;
}

/**
 * Fluted shaft: a cylinder whose radius dips into `flutes` vertical channels.
 * Real fluting is what makes a column read at 25 m — a plain cylinder does not.
 */
export function flutedShaft(rTop, rBot, h, flutes = 12, segs = 48, depth = 0.055, rings = 4) {
  const pos = [], nor = [];
  const R = (a, t) => {
    const base = rBot + (rTop - rBot) * t;
    const f = Math.cos(a * flutes);
    const cut = Math.pow(Math.max(0, f), 1.6);
    return base - depth * cut * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.08 + 0.02)));
  };
  const V = (i, j) => {
    const a = (i / segs) * Math.PI * 2;
    const t = j / rings;
    const r = R(a, t);
    return [Math.cos(a) * r, t * h, Math.sin(a) * r];
  };
  const Nv = (i, j) => {
    const a = (i / segs) * Math.PI * 2;
    const da = 0.02;
    const t = j / rings;
    const r0 = R(a - da, t), r1 = R(a + da, t);
    const dr = (r1 - r0) / (2 * da);
    const r = R(a, t);
    // tangent in the angular direction of the polar curve
    const tx = -Math.sin(a) * r + Math.cos(a) * dr;
    const tz = Math.cos(a) * r + Math.sin(a) * dr;
    const l = Math.hypot(tx, tz) || 1;
    return [tz / l, 0.06, -tx / l];
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs;
      const a = V(i, j), b = V(i2, j), c = V(i2, j + 1), d = V(i, j + 1);
      const na = Nv(i, j), nb = Nv(i2, j), nc = Nv(i2, j + 1), nd = Nv(i, j + 1);
      pushTriSmooth(pos, nor, a, b, c, na, nb, nc);
      pushTriSmooth(pos, nor, a, c, d, na, nc, nd);
    }
  }
  return finishGeo(pos, nor);
}

/* ------------------------------------------------------------------ *
 * irregular rock
 * ------------------------------------------------------------------ */

/**
 * A broken stone chunk. Displaced icosahedron, flat shaded, flattened slightly
 * so it sits on the floor instead of looking like a ball.
 */
export function rockChunk(size, rnd, rough = 0.34) {
  const g = new THREE.IcosahedronGeometry(size * 0.5, 1);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x * 900)},${Math.round(y * 900)},${Math.round(z * 900)}`;
    let d = seen.get(key);
    if (d === undefined) {
      d = 1 + (rnd() * 2 - 1) * rough;
      seen.set(key, d);
    }
    p.setXYZ(i, x * d * 1.06, y * d * (0.56 + rnd() * 0.16), z * d * 1.06);
  }
  // IcosahedronGeometry (PolyhedronGeometry) is already non-indexed, so calling
  // toNonIndexed() unconditionally warns once per rock chunk — several hundred
  // times per crypt build.
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  out.computeVertexNormals();
  autoUV(out);
  return out;
}

/* ------------------------------------------------------------------ *
 * merge / transform helpers
 * ------------------------------------------------------------------ */

const KEEP = ['position', 'normal', 'uv'];

/** Normalise a geometry so it can be merged with anything else in the kit. */
export function prep(g) {
  let out = g;
  if (out.index) { const t = out.toNonIndexed(); out = t; }
  if (!out.attributes.uv) autoUV(out);
  for (const name of Object.keys(out.attributes)) {
    if (!KEEP.includes(name)) out.deleteAttribute(name);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

/**
 * Merge a list of `[geometry, matrix|null]` pairs into one buffer geometry.
 * Sources are disposed — the kit builds thousands of throwaway sub-pieces.
 */
export function mergeAll(parts) {
  const list = [];
  for (const item of parts) {
    if (!item) continue;
    const g = Array.isArray(item) ? item[0] : item;
    const m = Array.isArray(item) ? item[1] : null;
    if (!g) continue;
    const p = prep(g);
    if (m) p.applyMatrix4(m);
    list.push(p);
    if (p !== g) g.dispose();
  }
  if (!list.length) return new THREE.BufferGeometry();
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return merged ?? new THREE.BufferGeometry();
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Convenience TRS matrix builder (Euler YXZ). */
export function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** In-place TRS into a reusable matrix (hot path — avoids allocation). */
export function trsInto(out, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(x, y, z);
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

/** Add a little per-vertex noise so a "dressed" stone is not machined. */
export function roughenVerts(geo, amp, rnd) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const d = (rnd() * 2 - 1) * amp;
    p.setXYZ(i,
      p.getX(i) + n.getX(i) * d,
      p.getY(i) + n.getY(i) * d,
      p.getZ(i) + n.getZ(i) * d);
  }
  p.needsUpdate = true;
  return geo;
}

export { _m as scratchMatrix };
