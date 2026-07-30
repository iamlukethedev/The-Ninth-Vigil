/**
 * SANCTUM — RigKit
 *
 * Procedural skeleton definition + skinned-geometry construction for the
 * bestiary. Everything here is deterministic: the same rig definition and seed
 * always produce byte-identical buffers, so the screenshot critic sees stable
 * frames.
 *
 * Why this exists
 * ---------------
 * At the time Bestiary was authored the Hero module (and therefore its
 * Skeleton/AnimGraph/CharacterMesh helpers) did not exist on disk, so there was
 * nothing to import. This file is deliberately written as a *general* character
 * kit rather than a monster-only one — `defineRig`, `SkinBuilder` and `AnimGraph`
 * (AnimKit.js) carry no bestiary-specific assumptions, so Hero can adopt them
 * without a fork.
 *
 * Concepts
 * --------
 *  • A **rig definition** is a flat, parent-before-child joint list with local
 *    offsets in metres. `instantiate()` materialises a fresh `THREE.Bone` tree
 *    plus a `THREE.Skeleton`; the *geometry* is built once per archetype and
 *    shared across every instance, because the bind pose is identical.
 *  • **SkinBuilder** sweeps tubes along bone chains and rigid-binds hard parts
 *    (skulls, plates, blades). It emits position/normal/uv/color/skin buffers.
 *    UVs are authored in *metres* (u,v = surface distance / uvScale) so a
 *    tiling AssetForge texture lands at a physically correct scale — the single
 *    most common failure called out in KNOWN_ISSUES.md.
 *  • Normals on swept tubes are computed by central differencing the parametric
 *    grid with wraparound in u, so the seam is invisible.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

/* ------------------------------------------------------------------ *
 * deterministic 3D noise (used for organic surface lumps)
 * ------------------------------------------------------------------ */

export function hash3(ix, iy, iz, seed = 0) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) +
          Math.imul(iz | 0, 1442695041) + Math.imul(seed | 0, 1013904223);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const c000 = hash3(xi, yi, zi, seed), c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * xf, x10 = c010 + (c110 - c010) * xf;
  const x01 = c001 + (c101 - c001) * xf, x11 = c011 + (c111 - c011) * xf;
  const y0 = x00 + (x10 - x00) * yf, y1 = x01 + (x11 - x01) * yf;
  return y0 + (y1 - y0) * zf;
}

export function fbm3(x, y, z, seed = 0, oct = 3) {
  let a = 0.55, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    s += noise3(x * f, y * f, z * f, seed + i * 71) * a;
    n += a; a *= 0.48; f *= 2.13;
  }
  return s / n;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ *
 * Rig definition
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{name:string, parent?:string|null, pos:number[]}>} joints
 *        Parent-before-child. `pos` is the offset from the parent in metres.
 * @returns {RigDef}
 */
export function defineRig(joints) {
  const n = joints.length;
  const names = new Array(n);
  const index = new Map();
  for (let i = 0; i < n; i++) { names[i] = joints[i].name; index.set(joints[i].name, i); }

  const parents = new Int32Array(n);
  const offsets = new Float32Array(n * 3);
  const rest = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = joints[i];
    const p = j.parent == null ? -1 : (index.has(j.parent) ? index.get(j.parent) : -1);
    if (j.parent != null && p < 0) console.warn(`[rigkit] joint "${j.name}" has unknown parent "${j.parent}"`);
    if (p >= i) throw new Error(`[rigkit] joint "${j.name}" declared before its parent`);
    parents[i] = p;
    const o = j.pos ?? [0, 0, 0];
    offsets[i * 3] = o[0] ?? 0; offsets[i * 3 + 1] = o[1] ?? 0; offsets[i * 3 + 2] = o[2] ?? 0;
    if (p < 0) {
      rest[i * 3] = offsets[i * 3]; rest[i * 3 + 1] = offsets[i * 3 + 1]; rest[i * 3 + 2] = offsets[i * 3 + 2];
    } else {
      rest[i * 3] = rest[p * 3] + offsets[i * 3];
      rest[i * 3 + 1] = rest[p * 3 + 1] + offsets[i * 3 + 1];
      rest[i * 3 + 2] = rest[p * 3 + 2] + offsets[i * 3 + 2];
    }
  }
  return new RigDef(names, index, parents, offsets, rest);
}

export class RigDef {
  constructor(names, index, parents, offsets, rest) {
    this.names = names;
    this.index = index;
    this.parents = parents;
    this.offsets = offsets;
    this.rest = rest;
    this.count = names.length;
  }

  /** Rest (bind-pose) world position of a joint. */
  restOf(name, out = new THREE.Vector3()) {
    const i = this.index.get(name);
    if (i === undefined) return out.set(0, 0, 0);
    return out.set(this.rest[i * 3], this.rest[i * 3 + 1], this.rest[i * 3 + 2]);
  }

  idx(name) {
    const i = this.index.get(name);
    if (i === undefined) { console.warn(`[rigkit] unknown joint "${name}"`); return 0; }
    return i;
  }

  /**
   * Fresh bone tree + skeleton. Cheap enough to call per instance.
   * `boneScale(name, i)` may return a multiplier for the joint's rest offset —
   * that is how a pack of skeletons gets genuinely different limb proportions
   * while still sharing one geometry buffer.
   */
  instantiate(boneScale = null) {
    const n = this.count;
    const bones = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = new THREE.Bone();
      b.name = this.names[i];
      const k = boneScale ? boneScale(this.names[i], i) : 1;
      b.position.set(this.offsets[i * 3] * k, this.offsets[i * 3 + 1] * k, this.offsets[i * 3 + 2] * k);
      bones[i] = b;
    }
    let root = bones[0];
    for (let i = 0; i < n; i++) {
      const p = this.parents[i];
      if (p >= 0) bones[p].add(bones[i]);
      else if (i > 0) root.add(bones[i]);
    }
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    const byName = new Map();
    for (let i = 0; i < n; i++) byName.set(this.names[i], bones[i]);
    return { root, bones, skeleton, byName };
  }
}

/* ------------------------------------------------------------------ *
 * per-vertex curvature → the coupled wear channel
 * ------------------------------------------------------------------ */

/**
 * Signed discrete mean curvature per vertex, gated per piece, packed into ONE
 * float: positive = a proud edge, negative = a cavity, zero = body curvature.
 *
 * WHY THIS EXISTS. The rubric asks every surface for "a wear/grime layer that
 * darkens, roughens, and occludes together", and metal specifically for "edge
 * wear to bright material and tarnish in cavities". The hero already has this:
 * `CharacterMesh.edgeCavity` measures curvature per authored piece and feeds an
 * `aSurf` attribute the hero shader couples into albedo, roughness and metalness
 * at once. The bestiary had NOTHING equivalent — only `grimeFn`, which is a
 * height-and-normal ramp in world space and therefore cannot know where an edge
 * or a hollow is. So an enemy's rims never wore bright and its hollows never
 * tarnished, which is precisely the "untextured, uniform-roughness" read the
 * critic flagged on the warden.
 *
 * It is a VERTEX ATTRIBUTE and not a map on purpose. The scene sits at the
 * 16-fragment-sampler ceiling — Bestiary already deletes each body's metalness
 * and AO maps to buy two units back — so any solution that costs a sampler is
 * not deployable. This costs 4 bytes per vertex and zero texture units.
 *
 * Method and its two non-obvious parts, both inherited from the hero pass
 * because they were paid for there in visible defects:
 *
 *  1. TWO JACOBI SMOOTHING PASSES before gating. A one-ring difference alternates
 *     sign column to column on any dense parametric patch, in the pattern of the
 *     MESH rather than of the shape; thresholding that raw draws one bright line
 *     per meridian. Two passes at 0.65 neighbour weight kill the alternation and
 *     leave coherent features intact.
 *  2. A PERCENTILE GATE WITH A DEAD ZONE. Below ~5 /m (a radius over 200 mm)
 *     nothing is an edge — that is the body curvature of the limb itself, and
 *     treating it as a rim is what turns a whole arm bright.
 */
function curvatureAttr(pos, nor, idx, spans) {
  const n = pos.length / 3;
  const out = new Float32Array(n);
  if (!n || !idx.length) return out;

  const acc = new Float32Array(n);
  const cnt = new Float32Array(n);
  const pair = (a, b) => {
    const ao = a * 3, bo = b * 3;
    const dx = pos[bo] - pos[ao], dy = pos[bo + 1] - pos[ao + 1], dz = pos[bo + 2] - pos[ao + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-12) return;
    // (Δn · Δp)/|Δp|² — positive where the normals splay apart, i.e. convex.
    const k = ((nor[bo] - nor[ao]) * dx + (nor[bo + 1] - nor[ao + 1]) * dy
      + (nor[bo + 2] - nor[ao + 2]) * dz) / l2;
    acc[a] += k; cnt[a] += 1; acc[b] += k; cnt[b] += 1;
  };
  for (let i = 0; i + 2 < idx.length; i += 3) {
    pair(idx[i], idx[i + 1]); pair(idx[i + 1], idx[i + 2]); pair(idx[i + 2], idx[i]);
  }
  const cv = new Float32Array(n);
  for (let i = 0; i < n; i++) cv[i] = cnt[i] > 0 ? acc[i] / cnt[i] : 0;

  {
    const sm = new Float32Array(n), c2 = new Float32Array(n);
    const addp = (a, b) => { sm[a] += cv[b]; c2[a] += 1; sm[b] += cv[a]; c2[b] += 1; };
    for (let it = 0; it < 2; it++) {
      sm.fill(0); c2.fill(0);
      for (let i = 0; i + 2 < idx.length; i += 3) {
        addp(idx[i], idx[i + 1]); addp(idx[i + 1], idx[i + 2]); addp(idx[i + 2], idx[i]);
      }
      for (let i = 0; i < n; i++) if (c2[i] > 0) cv[i] = cv[i] * 0.35 + (sm[i] / c2[i]) * 0.65;
    }
  }

  const ranges = spans.length ? spans : [0, n];
  const pos_ = [], neg_ = [];
  for (let s = 0; s < ranges.length; s += 2) {
    const a = ranges[s], b = ranges[s + 1];
    pos_.length = 0; neg_.length = 0;
    for (let i = a; i < b; i++) {
      if (cv[i] > 0) pos_.push(cv[i]); else if (cv[i] < 0) neg_.push(-cv[i]);
    }
    const pct = (arr, p) => {
      if (!arr.length) return 0;
      arr.sort((x, y) => x - y);
      return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    };
    const hi = pct(pos_, 0.88), lo = pct(neg_, 0.88);
    const hiOK = hi > 5, loOK = lo > 5;
    for (let i = a; i < b; i++) {
      const e = hiOK ? smoothstep(hi * 0.60, hi * 1.02, cv[i]) : 0;
      const c = loOK ? smoothstep(lo * 0.44, lo * 0.98, -cv[i]) : 0;
      // One channel, because curvature has one sign at a vertex: the two can
      // never both be non-zero, so packing them costs no information.
      out[i] = e - c;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * SkinBuilder
 * ------------------------------------------------------------------ */

export class SkinBuilder {
  /**
   * @param {RigDef} rig
   * @param {number} seed deterministic seed for surface noise
   */
  constructor(rig, seed = 1) {
    this.rig = rig;
    this.seed = seed | 0;
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.si = [];
    this.sw = [];
    this.msk = [];
    this.idx = [];
    /**
     * Vertex ranges of the individual primitives, [start, end) pairs.
     *
     * The curvature pass in `build()` normalises PER PIECE, not per body. A
     * warden carries claws at ~90 /m and a thigh at ~3 /m in one buffer, so one
     * global percentile is set by the claws and everything else falls under the
     * gate — which is how you get a body with wear on nothing but its fingertips.
     */
    this.spans = [];
    /** default vertex tint function: (x,y,z,nx,ny,nz)=>[r,g,b] */
    this.colorFn = null;
    /** emissive mask for the *next* primitive added (0..1, or a fn) */
    this.mask = 0;
  }

  /** Close the vertex range opened by a primitive. */
  _mark(start) {
    const end = this.vertexCount;
    if (end > start) this.spans.push(start, end);
    return this;
  }

  get vertexCount() { return this.pos.length / 3; }

  _pushVert(px, py, pz, nx, ny, nz, u, v, b0, w0, b1, w1, colorFn, mask) {
    this.pos.push(px, py, pz);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    const fn = colorFn ?? this.colorFn;
    if (fn) { const c = fn(px, py, pz, nx, ny, nz); this.col.push(c[0], c[1], c[2]); }
    else this.col.push(1, 1, 1);
    this.si.push(b0, b1, 0, 0);
    this.sw.push(w0, w1, 0, 0);
    const m = mask ?? this.mask;
    this.msk.push(typeof m === 'function' ? m(px, py, pz) : m);
  }

  /**
   * Sweep a closed tube along a chain of control points.
   *
   * @param {Array<{j?:string,p?:number[],off?:number[],bind?:string,r:number,sx?:number,sz?:number}>} chain
   * @param {object} o
   *   seg          radial segments (default 12)
   *   ringsPer     rings per control segment (default 4)
   *   uvScale      metres per texture repeat (default 0.32)
   *   noise        radial lump amplitude, 0..0.6
   *   noiseFreq    lumps per metre
   *   profile      (angle, t) => radius multiplier — must be 2π-periodic in angle
   *   capStart/capEnd  'round' | 'flat' | 'none'
   *   color        per-vertex tint fn
   *   stiff        0..1 — 1 keeps each segment rigid to its own bone
   */
  tube(chain, o = {}) {
    const n = chain.length;
    if (n < 2) { console.warn('[rigkit] tube needs >= 2 control points'); return this; }
    const seg = Math.max(4, o.seg ?? 12);
    const per = Math.max(1, o.ringsPer ?? 4);
    const uvScale = o.uvScale ?? 0.32;
    const nAmp = o.noise ?? 0;
    const nFreq = o.noiseFreq ?? 6;
    const profile = o.profile ?? null;
    const twist = o.twist ?? 0;
    const stiff = clamp01(o.stiff ?? 0);
    const seed = (this.seed + (o.seedOff ?? 0)) | 0;

    /* --- resolve control points --- */
    const P = [], R = [], SX = [], SZ = [], B = [];
    for (let i = 0; i < n; i++) {
      const c = chain[i];
      const p = new THREE.Vector3();
      if (c.p) p.set(c.p[0], c.p[1], c.p[2]);
      else this.rig.restOf(c.j, p);
      if (c.off) p.x += c.off[0], p.y += c.off[1], p.z += c.off[2];
      P.push(p);
      R.push(c.r ?? 0.06);
      SX.push(c.sx ?? 1);
      SZ.push(c.sz ?? 1);
      B.push(this.rig.idx(c.bind ?? c.j ?? chain[0].j));
    }

    /* --- centreline: Catmull-Rom in control-index space --- */
    const cr = (a, b, c, d, t) => {
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    };
    const at = (arr, i) => arr[i < 0 ? 0 : i > n - 1 ? n - 1 : i];
    const evalC = (s, out) => {
      const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
      const t = clamp01(s - i);
      const p0 = at(P, i - 1), p1 = at(P, i), p2 = at(P, i + 1), p3 = at(P, i + 2);
      return out.set(cr(p0.x, p1.x, p2.x, p3.x, t), cr(p0.y, p1.y, p2.y, p3.y, t), cr(p0.z, p1.z, p2.z, p3.z, t));
    };
    const evalS = (arr, s) => {
      const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
      const t = clamp01(s - i);
      return cr(at(arr, i - 1), at(arr, i), at(arr, i + 1), at(arr, i + 2), t);
    };

    /* --- ring list (main body) --- */
    const totalMain = (n - 1) * per + 1;
    const rings = [];
    let prevN = null, prevC = null, arc = 0;
    for (let k = 0; k < totalMain; k++) {
      const s = (k / (totalMain - 1)) * (n - 1);
      const C = evalC(s, new THREE.Vector3());
      // tangent by central difference in s
      const ds = 0.012 * (n - 1);
      const a = evalC(Math.max(0, s - ds), _v).clone();
      const b = evalC(Math.min(n - 1, s + ds), _v2).clone();
      const T = b.sub(a);
      if (T.lengthSq() < 1e-12) T.set(0, 1, 0);
      T.normalize();
      let N;
      if (!prevN) {
        // seed the frame with the axis least aligned to the tangent
        const ax = Math.abs(T.x), ay = Math.abs(T.y), az = Math.abs(T.z);
        const pick = ax <= ay && ax <= az ? new THREE.Vector3(1, 0, 0)
          : ay <= az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
        N = pick.sub(_v.copy(T).multiplyScalar(pick.dot(T))).normalize();
      } else {
        N = prevN.clone().sub(_v.copy(T).multiplyScalar(prevN.dot(T)));
        if (N.lengthSq() < 1e-10) N = new THREE.Vector3(1, 0, 0).sub(_v.copy(T).multiplyScalar(T.x));
        N.normalize();
      }
      const Bv = _v.copy(T).cross(N).normalize().clone();
      if (prevC) arc += C.distanceTo(prevC);
      rings.push({ s, C, T, N: N.clone(), B: Bv, r: evalS(R, s), sx: evalS(SX, s), sz: evalS(SZ, s), arc, pole: 0 });
      prevN = N; prevC = C;
    }

    /* --- rounded caps: hemisphere rings extending past each end --- */
    const capRings = (endRing, dir, mode) => {
      if (mode !== 'round' || endRing.r <= 1e-5) return [];
      const K = 3;
      const out = [];
      for (let k = 1; k <= K; k++) {
        const a = (k / K) * Math.PI * 0.5 * 0.94;
        const off = Math.sin(a) * endRing.r;
        const rr = Math.cos(a) * endRing.r;
        out.push({
          s: endRing.s, C: endRing.C.clone().add(_v.copy(endRing.T).multiplyScalar(off * dir)),
          T: endRing.T, N: endRing.N, B: endRing.B,
          r: rr, sx: endRing.sx, sz: endRing.sz, arc: endRing.arc + off * dir, pole: k / K,
        });
      }
      return out;
    };
    const head = capRings(rings[0], -1, o.capStart ?? 'round').reverse();
    const tailC = capRings(rings[rings.length - 1], 1, o.capEnd ?? 'round');
    const all = [...head, ...rings, ...tailC];

    /* --- build the parametric grid (seg+1 columns; last duplicates first) --- */
    const cols = seg + 1;
    const rows = all.length;
    const grid = new Float32Array(rows * cols * 3);
    const circ = Math.max(1e-4, 2 * Math.PI * rings[Math.floor(rings.length / 2)].r *
      0.5 * (rings[Math.floor(rings.length / 2)].sx + rings[Math.floor(rings.length / 2)].sz));
    const uRepeat = Math.max(1, Math.round(circ / uvScale));

    for (let r = 0; r < rows; r++) {
      const R0 = all[r];
      const t01 = rows > 1 ? r / (rows - 1) : 0;
      const tw = twist * t01;
      for (let c = 0; c < cols; c++) {
        const ang = (c / seg) * Math.PI * 2 + tw;
        let rad = R0.r;
        if (profile) rad *= profile(ang - tw, t01);
        const cx = Math.cos(ang) * R0.sx, cz = Math.sin(ang) * R0.sz;
        let px = R0.C.x + (R0.N.x * cx + R0.B.x * cz) * rad;
        let py = R0.C.y + (R0.N.y * cx + R0.B.y * cz) * rad;
        let pz = R0.C.z + (R0.N.z * cx + R0.B.z * cz) * rad;
        if (nAmp > 0) {
          const d = (fbm3(px * nFreq, py * nFreq, pz * nFreq, seed, 3) - 0.5) * 2 * nAmp * rad;
          const dx = px - R0.C.x, dy = py - R0.C.y, dz = pz - R0.C.z;
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          px += (dx / l) * d; py += (dy / l) * d; pz += (dz / l) * d;
        }
        const g = (r * cols + c) * 3;
        grid[g] = px; grid[g + 1] = py; grid[g + 2] = pz;
      }
    }

    /* --- normals: central difference with u wrap --- */
    const base = this.vertexCount;
    const gv = (r, c, out) => {
      const rr = r < 0 ? 0 : r > rows - 1 ? rows - 1 : r;
      const cc = ((c % seg) + seg) % seg;
      const g = (rr * cols + cc) * 3;
      return out.set(grid[g], grid[g + 1], grid[g + 2]);
    };
    const du = new THREE.Vector3(), dv = new THREE.Vector3(), nn = new THREE.Vector3();
    const a1 = new THREE.Vector3(), a2 = new THREE.Vector3();

    for (let r = 0; r < rows; r++) {
      const R0 = all[r];
      const vCoord = R0.arc / uvScale;
      for (let c = 0; c < cols; c++) {
        gv(r, c + 1, a1); gv(r, c - 1, a2); du.copy(a1).sub(a2);
        gv(r + 1, c, a1); gv(r - 1, c, a2); dv.copy(a1).sub(a2);
        nn.copy(du).cross(dv);
        if (nn.lengthSq() < 1e-14) {
          gv(r, c, a1);
          nn.copy(a1).sub(R0.C);
          if (nn.lengthSq() < 1e-14) nn.copy(R0.T);
        }
        nn.normalize();
        // guarantee outward orientation
        gv(r, c, a1);
        if (nn.dot(a2.copy(a1).sub(R0.C)) < 0 && R0.pole < 0.99) nn.multiplyScalar(-1);

        // skin weights: 50/50 across each interior joint, rigid mid-segment
        const s = R0.s;
        const i0 = Math.min(n - 2, Math.max(0, Math.floor(s)));
        const f = clamp01(s - i0);
        let wNext = 0.5 * smoothstep(0.58, 1.0, f) * (1 - stiff);
        let wPrev = 0.5 * smoothstep(0.42, 0.0, f) * (1 - stiff);
        if (i0 === 0) wPrev = 0;
        let b0 = B[i0], b1 = B[i0];
        let w0, w1;
        if (wNext >= wPrev) { b1 = B[Math.min(n - 1, i0 + 1)]; w1 = wNext; w0 = 1 - wNext; }
        else { b1 = B[Math.max(0, i0 - 1)]; w1 = wPrev; w0 = 1 - wPrev; }

        const g = (r * cols + c) * 3;
        this._pushVert(grid[g], grid[g + 1], grid[g + 2], nn.x, nn.y, nn.z,
          (c / seg) * uRepeat, vCoord, b0, w0, b1, w1, o.color, o.mask);
      }
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < seg; c++) {
        const a = base + r * cols + c, b = a + 1;
        const cc = base + (r + 1) * cols + c, d = cc + 1;
        this.idx.push(a, b, cc, b, d, cc);
      }
    }
    return this._mark(base);
  }

  /**
   * Rigid-bind an authored geometry to one bone.
   * @param {THREE.BufferGeometry} geo
   * @param {string} boneName
   * @param {object} o { pos:[x,y,z] (world rest space) | at:jointName, off:[..],
   *                     rot:[rx,ry,rz], scale:number|[x,y,z], uvScale, color, uvMode }
   */
  rigid(geo, boneName, o = {}) {
    const bi = this.rig.idx(boneName);
    const posA = geo.getAttribute('position');
    if (!posA) return this;
    let norA = geo.getAttribute('normal');
    if (!norA) { geo.computeVertexNormals(); norA = geo.getAttribute('normal'); }

    _m.identity();
    const anchor = new THREE.Vector3();
    if (o.pos) anchor.set(o.pos[0], o.pos[1], o.pos[2]);
    else this.rig.restOf(o.at ?? boneName, anchor);
    if (o.off) anchor.x += o.off[0], anchor.y += o.off[1], anchor.z += o.off[2];
    const e = o.rot ?? [0, 0, 0];
    _q.setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));
    const sc = o.scale ?? 1;
    const scv = typeof sc === 'number' ? _v.set(sc, sc, sc) : _v.set(sc[0], sc[1], sc[2]);
    _m.compose(anchor, _q, scv);
    const nm = new THREE.Matrix3().getNormalMatrix(_m);

    const uvScale = o.uvScale ?? 0.32;
    const base = this.vertexCount;
    const p = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < posA.count; i++) {
      p.fromBufferAttribute(posA, i).applyMatrix4(_m);
      nv.fromBufferAttribute(norA, i).applyMatrix3(nm).normalize();
      // triplanar box UVs in metres — tiling textures stay physically scaled
      const ax = Math.abs(nv.x), ay = Math.abs(nv.y), az = Math.abs(nv.z);
      let u, v;
      if (ax >= ay && ax >= az) { u = p.z / uvScale; v = p.y / uvScale; }
      else if (ay >= az) { u = p.x / uvScale; v = p.z / uvScale; }
      else { u = p.x / uvScale; v = p.y / uvScale; }
      this._pushVert(p.x, p.y, p.z, nv.x, nv.y, nv.z, u, v, bi, 1, bi, 0, o.color, o.mask);
    }
    const idx = geo.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) this.idx.push(base + idx.getX(i));
    else for (let i = 0; i < posA.count; i++) this.idx.push(base + i);
    return this._mark(base);
  }

  /**
   * A skinned flat ribbon (cloth strip, tatter, banner) along a bone chain.
   * @param {Array<{j?:string,p?:number[],off?:number[],bind?:string,w:number}>} chain
   */
  ribbon(chain, o = {}) {
    const n = chain.length;
    if (n < 2) return this;
    const per = Math.max(1, o.ringsPer ?? 3);
    const uvScale = o.uvScale ?? 0.4;
    const thick = o.thick ?? 0.012;
    const axis = new THREE.Vector3(...(o.axis ?? [1, 0, 0]));
    const P = [], W = [], B = [];
    for (let i = 0; i < n; i++) {
      const c = chain[i];
      const p = new THREE.Vector3();
      if (c.p) p.set(c.p[0], c.p[1], c.p[2]); else this.rig.restOf(c.j, p);
      if (c.off) p.x += c.off[0], p.y += c.off[1], p.z += c.off[2];
      P.push(p); W.push(c.w ?? 0.1); B.push(this.rig.idx(c.bind ?? c.j ?? chain[0].j));
    }
    const rows = (n - 1) * per + 1;
    const base = this.vertexCount;
    const C = new THREE.Vector3(), T = new THREE.Vector3(), side = new THREE.Vector3();
    let arc = 0;
    const lerp3 = (a, b, t, out) => out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    const prev = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const s = (r / (rows - 1)) * (n - 1);
      const i0 = Math.min(n - 2, Math.floor(s));
      const f = s - i0;
      lerp3(P[i0], P[i0 + 1], f, C);
      T.copy(P[i0 + 1]).sub(P[i0]).normalize();
      side.copy(axis).cross(T);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      const nrm = _v.copy(T).cross(side).normalize().clone();
      const w = W[i0] + (W[i0 + 1] - W[i0]) * f;
      if (r > 0) arc += C.distanceTo(prev);
      prev.copy(C);
      let wNext = 0.5 * smoothstep(0.55, 1.0, f);
      let wPrev = i0 === 0 ? 0 : 0.5 * smoothstep(0.45, 0.0, f);
      let b0 = B[i0], b1, w0, w1;
      if (wNext >= wPrev) { b1 = B[i0 + 1]; w1 = wNext; w0 = 1 - wNext; }
      else { b1 = B[i0 - 1]; w1 = wPrev; w0 = 1 - wPrev; }
      for (let k = 0; k < 2; k++) {
        const sg = k === 0 ? -1 : 1;
        this._pushVert(C.x + side.x * w * sg, C.y + side.y * w * sg, C.z + side.z * w * sg,
          nrm.x, nrm.y, nrm.z, (k * 2 * w) / uvScale, arc / uvScale, b0, w0, b1, w1, o.color, o.mask);
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      const a = base + r * 2, b = a + 1, c = a + 2, d = a + 3;
      this.idx.push(a, b, c, b, d, c);
      if (o.doubleSided !== false) this.idx.push(c, b, a, c, d, b);
    }
    return this._mark(base);
  }

  build(o = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.msk, 1));
    g.setAttribute('aWear', new THREE.Float32BufferAttribute(
      curvatureAttr(this.pos, this.nor, this.idx, this.spans), 1));
    const n = this.vertexCount;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    // Skinned bounds must survive animation; inflate rather than recompute.
    if (g.boundingSphere) g.boundingSphere.radius *= o.boundsPad ?? 1.7;
    return g;
  }
}

/* ------------------------------------------------------------------ *
 * Authored primitive geometry (all bevelled — sharp 90° edges are a fail)
 * ------------------------------------------------------------------ */

/**
 * Rounded box built by "inflating" a sphere's octants out to the box corners.
 * Every edge therefore catches a highlight — sharp 90° corners read as
 * prototype and are an explicit critic fail.
 */
export function roundedBox(w, h, d, r = 0.012, seg = 2) {
  const rr = Math.max(1e-4, Math.min(r, w * 0.49, h * 0.49, d * 0.49));
  const hw = w * 0.5 - rr, hh = h * 0.5 - rr, hd = d * 0.5 - rr;
  const sph = new THREE.SphereGeometry(rr, Math.max(8, (seg + 1) * 6), Math.max(6, (seg + 1) * 4));
  const pa = sph.getAttribute('position');
  const na = sph.getAttribute('normal');
  const pos = new Float32Array(pa.count * 3);
  const nor = new Float32Array(pa.count * 3);
  for (let i = 0; i < pa.count; i++) {
    const nx = na.getX(i), ny = na.getY(i), nz = na.getZ(i);
    pos[i * 3] = pa.getX(i) + (nx >= 0 ? hw : -hw);
    pos[i * 3 + 1] = pa.getY(i) + (ny >= 0 ? hh : -hh);
    pos[i * 3 + 2] = pa.getZ(i) + (nz >= 0 ? hd : -hd);
    nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(sph.getIndex().clone());
  sph.dispose();
  return g;
}

/** Alias kept for readability at call sites. */
export const bevelBox = roundedBox;

/**
 * Sweep a non-skinned tube along explicit points — horns, claws, chains,
 * ribs, spikes. Returns a geometry in local space.
 */
export function sweepGeo(points, radii, o = {}) {
  const seg = Math.max(4, o.seg ?? 8);
  const n = points.length;
  const cols = seg + 1;
  const pos = [], nor = [], idx = [];
  const frames = [];
  let prevN = null;
  for (let i = 0; i < n; i++) {
    const T = new THREE.Vector3();
    if (i === 0) T.copy(points[1]).sub(points[0]);
    else if (i === n - 1) T.copy(points[n - 1]).sub(points[n - 2]);
    else T.copy(points[i + 1]).sub(points[i - 1]);
    if (T.lengthSq() < 1e-12) T.set(0, 1, 0);
    T.normalize();
    let N;
    if (!prevN) {
      const ax = Math.abs(T.x), ay = Math.abs(T.y), az = Math.abs(T.z);
      const pick = ax <= ay && ax <= az ? new THREE.Vector3(1, 0, 0)
        : ay <= az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      N = pick.sub(_v.copy(T).multiplyScalar(pick.dot(T))).normalize();
    } else {
      N = prevN.clone().sub(_v.copy(T).multiplyScalar(prevN.dot(T)));
      if (N.lengthSq() < 1e-10) N.set(1, 0, 0);
      N.normalize();
    }
    frames.push({ T, N, B: _v.copy(T).cross(N).clone() });
    prevN = N;
  }
  for (let i = 0; i < n; i++) {
    const f = frames[i], C = points[i], r = radii[i];
    for (let c = 0; c < cols; c++) {
      const a = (c / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = f.N.x * ca + f.B.x * sa, ny = f.N.y * ca + f.B.y * sa, nz = f.N.z * ca + f.B.z * sa;
      pos.push(C.x + nx * r, C.y + ny * r, C.z + nz * r);
      nor.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < seg; c++) {
      const a = i * cols + c, b = a + 1, cc = (i + 1) * cols + c, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  // caps
  if (o.cap !== false) {
    for (const [ri, dir] of [[0, -1], [n - 1, 1]]) {
      const f = frames[ri], C = points[ri], r = radii[ri];
      if (r <= 1e-5) continue;
      const centerIdx = pos.length / 3;
      pos.push(C.x + f.T.x * r * 0.35 * dir, C.y + f.T.y * r * 0.35 * dir, C.z + f.T.z * r * 0.35 * dir);
      nor.push(f.T.x * dir, f.T.y * dir, f.T.z * dir);
      const ringBase = ri * cols;
      for (let c = 0; c < seg; c++) {
        if (dir < 0) idx.push(centerIdx, ringBase + c + 1, ringBase + c);
        else idx.push(centerIdx, ringBase + c, ringBase + c + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Curved tapered horn / claw / spike. Grows along +Y then bends toward +Z. */
export function hornGeo(len, r0, r1, curve = 0.5, o = {}) {
  const steps = o.steps ?? 9;
  const pts = [], rad = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bend = curve * len * t * t;
    pts.push(new THREE.Vector3((o.lateral ?? 0) * len * t * t, len * t, bend));
    rad.push(r0 + (r1 - r0) * Math.pow(t, o.taper ?? 0.85));
  }
  return sweepGeo(pts, rad, { seg: o.seg ?? 8, cap: true });
}

/**
 * Bevelled blade / axe head / plate from a 2D profile, extruded in Z.
 * Profile points are in the XY plane, metres.
 */
export function extrudeProfile(pts2, thick, o = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(pts2[0][0], pts2[0][1]);
  for (let i = 1; i < pts2.length; i++) shape.lineTo(pts2[i][0], pts2[i][1]);
  shape.closePath();
  const bev = o.bevel ?? Math.min(thick * 0.42, 0.02);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, thick - bev * 2),
    bevelEnabled: bev > 1e-4,
    bevelThickness: bev,
    bevelSize: bev,
    bevelSegments: o.bevelSegments ?? 2,
    curveSegments: o.curveSegments ?? 2,
    steps: 1,
  });
  g.translate(0, 0, -thick * 0.5 + bev);
  g.computeVertexNormals();
  return g;
}

/**
 * Press concave features into a closed convex shell by displacing its vertices
 * along their own normals, then re-deriving the normals.
 *
 * WHY THIS AND NOT MORE PRIMITIVES. `mergeGeos` is a buffer concatenation, not
 * a CSG union: a shape pushed into another shape does not subtract from it, it
 * simply ends up sealed inside it and contributes nothing but triangles. That is
 * exactly what happened to the skull's eye sockets — two cones sat entirely
 * within the cranium ellipsoid (MEASURED: cone tip at z = 0.41 x size, cranium
 * surface at that latitude z = 0.458 x size), so every skull in the bestiary
 * rendered as a blank ovoid and the critic called the boss's head "a featureless
 * white ovoid ... no eyes, no jaw, no plate seams, nothing".
 *
 * A socket has to be a real dish in the surface, and a real dish brings the
 * three things the flat version could not: a normal that turns away from the
 * key light, a concavity the curvature pass reads as a cavity (which then
 * darkens/roughens/occludes together — see `curvatureAttr`), and a brow that
 * physically overhangs it.
 *
 * Each feature is a CONE OF DIRECTIONS from the shell's centre rather than a
 * sphere in space, because on an ellipsoid that is the only parameterisation
 * that stays the same shape as the shell is scaled non-uniformly by the caller.
 *
 * @param {THREE.BufferGeometry} geo   shell to carve, IN PLACE
 * @param {number[]} c                 shell centre in the geometry's own space
 * @param {Array<{dir:number[],ang:number,depth:number,rim?:number}>} feats
 *        dir   axis of the feature (need not be normalised)
 *        ang   half-angle of the dish, radians
 *        depth how far in the floor of the dish sits, metres
 *        rim   how far the surrounding ring stands proud, metres — this is what
 *              turns a dent into an orbit with a brow over it
 */
function carveDishes(geo, c, feats) {
  const pa = geo.getAttribute('position');
  const na = geo.getAttribute('normal');
  const P = pa.array, N = na.array;
  const F = feats.map((f) => {
    const l = Math.hypot(f.dir[0], f.dir[1], f.dir[2]) || 1;
    return { x: f.dir[0] / l, y: f.dir[1] / l, z: f.dir[2] / l, ang: f.ang, d: f.depth, rim: f.rim ?? 0 };
  });
  for (let i = 0; i < pa.count; i++) {
    const o = i * 3;
    const dx = P[o] - c[0], dy = P[o + 1] - c[1], dz = P[o + 2] - c[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / l, uy = dy / l, uz = dz / l;
    let disp = 0;
    for (const f of F) {
      const cosA = ux * f.x + uy * f.y + uz * f.z;
      if (cosA <= 0) continue;                       // never reach round the back
      const q = Math.acos(Math.min(1, cosA)) / f.ang;
      if (q >= 1.6) continue;
      // Dish floor: flat-bottomed rather than conical, so it reads as an orbit
      // and not as a drilled hole.
      const dish = 1 - smoothstep(0.30, 1.0, q);
      // Rampart just outside the dish — the brow/orbital margin.
      const ring = smoothstep(0.82, 1.06, q) * (1 - smoothstep(1.06, 1.55, q));
      disp += -f.d * dish + f.rim * ring;
    }
    if (disp === 0) continue;
    P[o] += N[o] * disp; P[o + 1] += N[o + 1] * disp; P[o + 2] += N[o + 2] * disp;
  }
  pa.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * A skull: cranium + brow ridge + muzzle + mandible. Origin at the atlas.
 *
 * The cranium and muzzle are carved (see `carveDishes`) rather than decorated,
 * so the orbits, the temporal fossae, the parietal hollows either side of the
 * sagittal line and the nasal aperture are genuine concavities in the shell.
 *
 * The tessellation is raised from 16x12 to 26x18 (34x24 above 0.4 m, i.e. for
 * the warden) because a carved feature cannot be finer than the mesh it is
 * carved into: a 0.42 rad orbit on a 12-ring sphere spans two rings, which is a
 * crease, not a socket. Cost is ~+560 triangles per skull at the small size and
 * ~+1230 at the large one, on a 4.4 M frame — and the skull geometry is built
 * once per archetype and shared by every instance of it.
 */
export function skullGeo(size, o = {}) {
  const parts = [];
  const seg = o.seg ?? (size > 0.4 ? 34 : 26);
  const rings = Math.max(10, Math.round(seg * 0.69));

  const cran = new THREE.SphereGeometry(size * 0.5, seg, rings);
  cran.scale(0.86, 1.0, 1.12);
  cran.translate(0, size * 0.30, -size * 0.03);
  carveDishes(cran, [0, size * 0.30, -size * 0.03], [
    /* Orbits — deep, forward, outboard and aimed slightly BELOW the equator.
       The elevation matters: at +0.13 the dish landed at y = 0.367 x size, which
       is inside the brow block below, so the brow filled the socket back in and
       the skull still read as an ovoid. At -0.02 the socket sits at y = 0.29 and
       the brow becomes what it is on a real skull — a shelf overhanging it. */
    { dir: [0.50, -0.02, 0.87], ang: 0.42, depth: size * 0.125, rim: size * 0.040 },
    { dir: [-0.50, -0.02, 0.87], ang: 0.42, depth: size * 0.125, rim: size * 0.040 },
    // temporal fossae — the wide shallow hollow behind each orbit
    { dir: [0.96, 0.10, 0.26], ang: 0.50, depth: size * 0.045, rim: size * 0.012 },
    { dir: [-0.96, 0.10, 0.26], ang: 0.50, depth: size * 0.045, rim: size * 0.012 },
    // parietal hollows — carved in PAIRS so the untouched strip between them is
    // left standing as a sagittal crest, which costs no extra geometry at all
    { dir: [0.34, 0.92, 0.20], ang: 0.40, depth: size * 0.038, rim: 0 },
    { dir: [-0.34, 0.92, 0.20], ang: 0.40, depth: size * 0.038, rim: 0 },
    // occipital dish at the back of the vault
    { dir: [0, -0.06, -1.0], ang: 0.46, depth: size * 0.040, rim: size * 0.010 },
  ]);
  parts.push(cran);

  // Supraorbital shelf. Raised from y 0.345 to 0.400 so its underside clears the
  // carved orbits and it overhangs them instead of plugging them.
  const brow = roundedBox(size * 0.72, size * 0.150, size * 0.290, size * 0.055);
  brow.translate(0, size * 0.400, size * 0.400);
  parts.push(brow);

  const muzzle = new THREE.SphereGeometry(size * 0.30, 16, 12);
  muzzle.scale(0.80, 0.72, 1.25);
  muzzle.translate(0, size * 0.14, size * 0.40);
  carveDishes(muzzle, [0, size * 0.14, size * 0.40], [
    // nasal aperture — the single most recognisable hole in a skull
    { dir: [0, 0.16, 0.99], ang: 0.36, depth: size * 0.085, rim: size * 0.016 },
    // maxillary fossae either side of it
    { dir: [0.72, -0.10, 0.68], ang: 0.30, depth: size * 0.030, rim: 0 },
    { dir: [-0.72, -0.10, 0.68], ang: 0.30, depth: size * 0.030, rim: 0 },
  ]);
  parts.push(muzzle);

  const jaw = roundedBox(size * 0.56, size * 0.13, size * 0.56, size * 0.05);
  jaw.translate(0, size * (o.jawOpen ?? 0.02) - size * 0.03, size * 0.30);
  parts.push(jaw);

  /* NO backing shell inside the orbit, deliberately. The first attempt put one
     there to make the socket read black, and it did the opposite: the cranium is
     a CLOSED shell, so a carved dish is a bowl and not a hole, and a sphere
     placed at the bowl's floor protruded 0.10 x size back out through the
     opening and filled the socket in. The darkness has to come from the dish
     itself — its normals turn away from the key light, and the curvature pass
     reads it as a cavity and darkens, roughens and occludes it together (see
     RECIPES.wear). That is also the only version of it that stays correct when
     the light moves. */
  // cheekbone struts — the zygomatic arch bridging orbit to temporal fossa
  for (const sx of [-1, 1]) {
    const z = roundedBox(size * 0.10, size * 0.09, size * 0.34, size * 0.035);
    z.rotateY(sx * 0.24);
    z.translate(sx * size * 0.315, size * 0.175, size * 0.215);
    parts.push(z);
  }
  return mergeGeos(parts);
}

/** Simple deterministic merge that keeps position+normal only. */
export function mergeGeos(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    vc += g.getAttribute('position').count;
    const i = g.getIndex();
    ic += i ? i.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const pa = g.getAttribute('position');
    let na = g.getAttribute('normal');
    if (!na) { g.computeVertexNormals(); na = g.getAttribute('normal'); }
    for (let i = 0; i < pa.count; i++) {
      pos[(vo + i) * 3] = pa.getX(i); pos[(vo + i) * 3 + 1] = pa.getY(i); pos[(vo + i) * 3 + 2] = pa.getZ(i);
      nor[(vo + i) * 3] = na.getX(i); nor[(vo + i) * 3 + 1] = na.getY(i); nor[(vo + i) * 3 + 2] = na.getZ(i);
    }
    const ia = g.getIndex();
    if (ia) for (let i = 0; i < ia.count; i++) idx[io++] = vo + ia.getX(i);
    else for (let i = 0; i < pa.count; i++) idx[io++] = vo + i;
    vo += pa.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export { clamp01, smoothstep };
