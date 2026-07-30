/**
 * SANCTUM — Props geometry toolkit.
 *
 * Every dressing mesh in the game is synthesised here. The rules the whole
 * library obeys:
 *
 *   • **Metre UVs.** Every generator writes UVs in world metres (u,v are
 *     distances along the surface). A material then only has to say "my texture
 *     tile is 1.6 m across" via `tiling = 1/1.6` and the scale is correct
 *     everywhere, on every prop, forever. This is the single most common way a
 *     procedural build ends up looking like a macro photograph.
 *   • **No hard 90° edges.** Boxes are bevelled, cylinders are chamfered,
 *     silhouettes are broken. A sharp corner catches no highlight.
 *   • **Baked mid-frequency variation.** Vertex colour carries per-prop
 *     weathering, moss on the north face, grime at the base and an approximate
 *     cavity AO. Combined with per-instance colour jitter that gives three
 *     independent scales of variation from one texture.
 *   • **Wind weight.** Vegetation and cloth carry an `aWindW` attribute
 *     (0 = rooted, 1 = free tip) that the wind vertex shader reads.
 *   • Deterministic: seeded PRNG only, no Math.random, no Date.now.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const WIND_ATTR = 'aWindW';

/* ================================================================== *
 * 3D noise — gradient noise + fbm, hash-seeded, allocation free
 * ================================================================== */

const G3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
];

export function hash3i(x, y, z, seed = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return h >>> 0;
}

const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function grad3(ix, iy, iz, seed, dx, dy, dz) {
  const g = (hash3i(ix, iy, iz, seed) & 15) * 3;
  return G3[g] * dx + G3[g + 1] * dy + G3[g + 2] * dz;
}

/** Perlin-style gradient noise in [0,1]. */
export function perlin3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade5(xf), v = fade5(yf), w = fade5(zf);
  const x1 = xi + 1, y1 = yi + 1, z1 = zi + 1;
  const n000 = grad3(xi, yi, zi, seed, xf, yf, zf);
  const n100 = grad3(x1, yi, zi, seed, xf - 1, yf, zf);
  const n010 = grad3(xi, y1, zi, seed, xf, yf - 1, zf);
  const n110 = grad3(x1, y1, zi, seed, xf - 1, yf - 1, zf);
  const n001 = grad3(xi, yi, z1, seed, xf, yf, zf - 1);
  const n101 = grad3(x1, yi, z1, seed, xf - 1, yf, zf - 1);
  const n011 = grad3(xi, y1, z1, seed, xf, yf - 1, zf - 1);
  const n111 = grad3(x1, y1, z1, seed, xf - 1, yf - 1, zf - 1);
  const a = n000 + (n100 - n000) * u;
  const b = n010 + (n110 - n010) * u;
  const c = n001 + (n101 - n001) * u;
  const d = n011 + (n111 - n011) * u;
  const e = a + (b - a) * v;
  const f = c + (d - c) * v;
  return (e + (f - e) * w) * 0.72 + 0.5;
}

/** Fractional Brownian motion over perlin3. `ridged` gives sharp crests. */
export function fbm3(x, y, z, {
  octaves = 4, freq = 1, gain = 0.5, lacunarity = 2.03, seed = 0, ridged = false,
} = {}) {
  let amp = 0.5, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = perlin3(x * f, y * f, z * f, seed + i * 137);
    if (ridged) n = 1 - Math.abs(n * 2 - 1);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smooth01(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/* ================================================================== *
 * attribute plumbing
 * ================================================================== */

/** Ensure a geometry has position/normal/uv/color, filling sensible defaults. */
export function ensureAttrs(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!geo.attributes.color) {
    const c = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!geo.getAttribute(WIND_ATTR)) {
    geo.setAttribute(WIND_ATTR, new THREE.BufferAttribute(new Float32Array(n), 1));
  }
  return geo;
}

/* ================================================================== *
 * debris texture scale
 * ================================================================== */

/**
 * Texture tile length in metres for a DEBRIS-scale piece, given the bank material
 * it will draw in and its own largest dimension. Returns a `uTile` for
 * `faceBoxUV`, i.e. tiles per metre.
 *
 * THE UNTEXTURED-RUBBLE DEFECT, root cause. Every debris generator wrote
 * `uTile = 1/1.65` or `1/1.1` — the architectural tile, authored for a wall. The
 * pieces those UVs land on are 0.1-0.6 m across, so:
 *
 *   • loose chip on `rubble` (a worley plate field, ~13 cells per tile at a 1.1 m
 *     tile => 8.5 cm cells) gets two or three isolated cells per 0.35 m facet —
 *     which renders as a flat wash with a couple of stray pits in it;
 *   • chip on `stoneRock` was worse: that name also carries a 0.26 material repeat
 *     for boulders, so the effective tile was 4.2 m and a cell landed at 17.6 cm,
 *     i.e. under two cells across a whole chip;
 *   • dressed block on `stone` (3 x 5 ashlar per tile) covered ~one brick face,
 *     and a brick face is by construction the featureless part of that generator.
 *
 * The crypt kit made the identical mistake at the identical scale and it is the one
 * the canonical frames could measure: 7x7 luma SD over the debris pixels in
 * `closeup` came in at 0.021, which is what a flat-shaded box measures. So the
 * surface was never missing — it was magnified past the point where any of it
 * resolved, in both places.
 *
 * The tile is scaled to the PIECE, not to the building. `span * k` keeps the same
 * number of texture features across a 0.15 m chip and a 0.6 m block, and the clamps
 * stop the two ends degenerating into macro-blur or into noise finer than the
 * 256 px map can carry. The two families need different k because they carry
 * different content at different densities:
 *
 *   ashlar (`stone`, `stoneWarm`, `stoneCold`, `marble`) — 3 x 5 dressed blocks per
 *     tile. At `span * 1.7` a 0.5 m piece gets a 0.85 m tile => a 0.28 x 0.17 m
 *     block, so one or two real joints cross every face and the generator's pitting
 *     lands at 2-4 cm. Tiling it any tighter turns a broken lump into brick veneer.
 *   granular (`rubble`, `stoneRock`, `stoneRockCold`, `dirt`) — a worley plate/pebble
 *     field. At `span * 0.75` a 0.35 m chip gets a 0.26 m tile => 2 cm cells, which
 *     is coarse sand and is what fractured stone actually looks like at arm's length.
 *     `stoneRock`'s 0.26 material repeat is divided out here so both names land on
 *     the same physical cell size.
 */
const ASHLAR_MATS = new Set(['stone', 'stoneWarm', 'stoneCold', 'marble']);
const MAT_REPEAT = { stoneRock: 0.26, stoneRockCold: 0.24, dirt: 0.42 };

export function debrisUV(mat, span) {
  const s = Math.max(0.05, span);
  const tile = ASHLAR_MATS.has(mat)
    ? clamp(s * 1.7, 0.38, 0.95)
    : clamp(s * 0.75, 0.16, 0.46);
  return 1 / (tile / (MAT_REPEAT[mat] ?? 1));
}

/**
 * Per-face planar UV projection onto the dominant axis of the face normal,
 * in metres. Requires non-indexed geometry (so a face never shares a vertex
 * with a face projecting onto a different axis — that is what makes seams).
 */
export function faceBoxUV(geo, scale = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const count = g.attributes.position.count;
  const uv = new Float32Array(count * 2);
  for (let f = 0; f < count; f += 3) {
    const i0 = f * 3, i1 = i0 + 3, i2 = i0 + 6;
    const ax = p[i1] - p[i0], ay = p[i1 + 1] - p[i0 + 1], az = p[i1 + 2] - p[i0 + 2];
    const bx = p[i2] - p[i0], by = p[i2 + 1] - p[i0 + 1], bz = p[i2 + 2] - p[i0 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
    let au = 0, av = 2;                     // project onto XZ (up-facing)
    if (anx >= any && anx >= anz) { au = 2; av = 1; }        // YZ
    else if (anz >= anx && anz >= any) { au = 0; av = 1; }   // XY
    for (let k = 0; k < 3; k++) {
      const o = (f + k) * 3;
      uv[(f + k) * 2] = p[o + au] * scale;
      uv[(f + k) * 2 + 1] = p[o + av] * scale;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Paint vertex colours. `fn(x,y,z, nx,ny,nz, out3, i)` writes rgb multipliers. */
export function paintVertex(geo, fn) {
  ensureAttrs(geo);
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const col = geo.attributes.color.array;
  const out = [1, 1, 1];
  for (let i = 0, n = geo.attributes.position.count; i < n; i++) {
    const o = i * 3;
    out[0] = 1; out[1] = 1; out[2] = 1;
    fn(pos[o], pos[o + 1], pos[o + 2], nor[o], nor[o + 1], nor[o + 2], out, i);
    col[o] *= out[0]; col[o + 1] *= out[1]; col[o + 2] *= out[2];
  }
  geo.attributes.color.needsUpdate = true;
  return geo;
}

/** Write the wind weight attribute. `fn(x,y,z,i) -> 0..1`. */
export function setWind(geo, fn) {
  ensureAttrs(geo);
  const pos = geo.attributes.position.array;
  const w = geo.getAttribute(WIND_ATTR).array;
  for (let i = 0, n = geo.attributes.position.count; i < n; i++) {
    const o = i * 3;
    w[i] = clamp01(fn(pos[o], pos[o + 1], pos[o + 2], i));
  }
  geo.getAttribute(WIND_ATTR).needsUpdate = true;
  return geo;
}

/**
 * Cheap but *directional* baked occlusion + grime. Darkens toward the base of
 * the prop, darkens downward-facing and inward-facing surfaces, and adds a
 * seeded blotch field so no two props weather alike. This is the layer that
 * stops instanced dressing reading as identical stamps.
 */
export function bakeWear(geo, {
  seed = 1, base = 0.42, baseH = 0.35, cavity = 0.35, blotch = 0.2,
  blotchFreq = 1.6, moss = 0, mossColor = [0.42, 0.55, 0.3], mossDir = [0, 1, 0],
  dust = 0, dustColor = [1.18, 1.14, 1.06], tint = null,
  grain = 0, grainFreq = 26,
} = {}) {
  ensureAttrs(geo);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const minY = bb.min.y;
  const spanY = Math.max(1e-3, bb.max.y - minY);
  const cx = (bb.min.x + bb.max.x) * 0.5, cz = (bb.min.z + bb.max.z) * 0.5;
  const md = mossDir;
  return paintVertex(geo, (x, y, z, nx, ny, nz, out) => {
    const hy = (y - minY) / spanY;
    // base contact darkening (this is what makes props sit in the ground)
    let k = 1 - base * (1 - smooth01(0, baseH, hy));
    // downward and inward faces occlude
    const down = clamp01(-ny);
    const inward = clamp01(-(nx * (x - cx) + nz * (z - cz)) * 2.2);
    k *= 1 - cavity * (down * 0.75 + inward * 0.35);
    // seeded blotch weathering
    const bl = fbm3(x * blotchFreq, y * blotchFreq * 0.8, z * blotchFreq, { octaves: 3, seed, gain: 0.55 });
    k *= 1 + (bl - 0.5) * 2 * blotch;
    /*
     * Fine grain, a whole octave band above `blotch`.
     *
     * `blotch` runs at 1-3.5 cycles/m, which is a per-PROP weathering pattern: it
     * separates one instance from another and does nothing at all inside a single
     * 0.4 m facet. That is how a prop ends up flat at character range with every
     * wear layer switched on: the debris facets in `closeup` measured a mean 7x7
     * luma SD of 0.021 with nothing in the pipeline varying below 30 cm (that
     * particular debris is the crypt kit's rather than a prop, but the ceiling is
     * the same one and every `bakeWear` caller was under it). At `grainFreq` 26
     * cycles/m one wavelength is 3.8 cm, which is
     * roughly the vertex spacing of a subdivided chip, so it is the highest
     * frequency vertex colour can actually carry, and it lands exactly in the band
     * the eye reads as "stone" rather than "surface".
     */
    if (grain > 0) {
      const gr = fbm3(x * grainFreq, y * grainFreq, z * grainFreq, { octaves: 2, seed: seed + 907, gain: 0.5 });
      k *= 1 + (gr - 0.5) * 2 * grain;
    }
    out[0] = k; out[1] = k; out[2] = k;
    if (moss > 0) {
      const facing = clamp01(nx * md[0] + ny * md[1] + nz * md[2]);
      const m = clamp01(facing * facing * moss * smooth01(0.42, 0.66, bl) * 2.4);
      out[0] = lerp(out[0], mossColor[0] * k, m);
      out[1] = lerp(out[1], mossColor[1] * k, m);
      out[2] = lerp(out[2], mossColor[2] * k, m);
    }
    if (dust > 0) {
      const up = clamp01(ny);
      const d = clamp01(up * up * dust * (0.35 + 0.65 * bl));
      out[0] = lerp(out[0], dustColor[0] * k, d);
      out[1] = lerp(out[1], dustColor[1] * k, d);
      out[2] = lerp(out[2], dustColor[2] * k, d);
    }
    if (tint) { out[0] *= tint[0]; out[1] *= tint[1]; out[2] *= tint[2]; }
  });
}

/** Apply a transform to a geometry in place. */
export function xform(geo, { pos, quat, euler, scale, rotY } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (quat) q.copy(quat);
  else if (euler) q.setFromEuler(euler.isEuler ? euler : new THREE.Euler(euler[0], euler[1], euler[2]));
  else if (rotY) q.setFromAxisAngle(_UP, rotY);
  const s = typeof scale === 'number' ? _s.set(scale, scale, scale)
    : scale ? (scale.isVector3 ? scale : _s.fromArray(scale)) : _one;
  const p = pos ? (pos.isVector3 ? pos : _p.fromArray(pos)) : _zero;
  m.compose(p, q, s);
  geo.applyMatrix4(m);
  return geo;
}
const _UP = new THREE.Vector3(0, 1, 0);
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3();

/** Merge a list of geometries (all must carry the same attribute set). */
export function mergeParts(parts) {
  const list = parts.filter(Boolean).map((g) => ensureAttrs(g.index ? g.toNonIndexed() : g));
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  for (const g of list) if (g !== merged) g.dispose();
  return merged ?? list[0];
}

/** Final pass: bounds + a stable draw-range. */
export function finish(geo) {
  ensureAttrs(geo);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Triangle count, for budgeting. */
export function triCount(geo) {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

/* ================================================================== *
 * primitive builders
 * ================================================================== */

/**
 * Swept tube along a spine with per-node radius, an irregular (lobed)
 * cross-section and parallel-transport frames — the workhorse behind trunks,
 * branches, roots, reeds and bones.
 *
 * @param {Array<{x,y,z,r:number,lobe?:number}>} spine
 * @param {object} o {radial, uTile, capEnd, closeStart, lobes, lobeAmt, seed}
 */
export function tube(spine, o = {}) {
  const radial = Math.max(3, o.radial ?? 7);
  const uTile = o.uTile ?? 1;
  const lobes = o.lobes ?? 3;
  const lobeAmt = o.lobeAmt ?? 0.16;
  const seed = o.seed ?? 1;
  const n = spine.length;
  if (n < 2) return null;

  // parallel-transport frames
  const T = [], Nv = [], Bv = [];
  const t = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = spine[Math.max(0, i - 1)], b = spine[Math.min(n - 1, i + 1)];
    t.set(b.x - a.x, b.y - a.y, b.z - a.z);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    t.normalize();
    T.push(t.clone());
  }
  // seed the first normal from the least-aligned axis
  {
    const t0 = T[0];
    const ax = Math.abs(t0.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    nrm.copy(ax).sub(t0.clone().multiplyScalar(t0.dot(ax))).normalize();
    Nv.push(nrm.clone());
    Bv.push(new THREE.Vector3().crossVectors(t0, nrm).normalize());
  }
  for (let i = 1; i < n; i++) {
    const prevT = T[i - 1], curT = T[i];
    const axis = new THREE.Vector3().crossVectors(prevT, curT);
    let N = Nv[i - 1].clone();
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();
      const ang = Math.acos(clamp(prevT.dot(curT), -1, 1));
      N.applyAxisAngle(axis, ang);
    }
    N.sub(curT.clone().multiplyScalar(curT.dot(N)));
    if (N.lengthSq() < 1e-10) N.set(1, 0, 0).sub(curT.clone().multiplyScalar(curT.x));
    N.normalize();
    Nv.push(N);
    Bv.push(new THREE.Vector3().crossVectors(curT, N).normalize());
  }

  // arc length for metre-correct v
  const vLen = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = spine[i - 1], b = spine[i];
    vLen[i] = vLen[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }

  const rings = n;
  const vertsPerRing = radial + 1;
  const total = rings * vertsPerRing;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = [];

  // Round the circumference to a whole number of texture tiles so the UV seam
  // on the back of the trunk lands on a tile boundary instead of mid-pattern.
  const tileLen = 1 / Math.max(1e-4, uTile);

  for (let i = 0; i < rings; i++) {
    const s = spine[i];
    const N = Nv[i], B = Bv[i];
    const circ = Math.max(tileLen, Math.round((2 * Math.PI * Math.max(0.01, s.r)) / tileLen) * tileLen);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      // lobed cross-section: bark is never a circle
      const lo = 1 + Math.sin(a * lobes + (s.lobe ?? 0)) * lobeAmt
        + (perlin3(Math.cos(a) * 1.7, Math.sin(a) * 1.7, i * 0.42, seed) - 0.5) * lobeAmt * 1.3;
      const r = Math.max(0.002, s.r * lo);
      const k = (i * vertsPerRing + j) * 3;
      pos[k] = s.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r;
      pos[k + 1] = s.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r;
      pos[k + 2] = s.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r;
      const u = (i * vertsPerRing + j) * 2;
      uv[u] = (j / radial) * circ;
      uv[u + 1] = vLen[i];
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * vertsPerRing + j, b = a + 1;
      const c = a + vertsPerRing, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  if (o.capEnd !== false) {
    // close the tip with a small fan so nothing reads as a hollow pipe
    const caps = [];
    if (o.capEnd !== 'start') caps.push(rings - 1);
    if (o.closeStart) caps.push(0);
    if (caps.length) {
      const extra = capFans(geo, spine, caps, radial, vertsPerRing);
      if (extra) return extra;
    }
  }
  return geo;
}

/** Close a tube end with a triangle fan to a centre vertex. */
function capFans(geo, spine, ringIdx, radial, vertsPerRing) {
  const oldPos = geo.attributes.position.array;
  const oldUv = geo.attributes.uv.array;
  const oldIdx = Array.from(geo.index.array);
  const oldCount = geo.attributes.position.count;
  const addPos = [], addUv = [];
  let next = oldCount;
  for (const ri of ringIdx) {
    const s = spine[ri];
    addPos.push(s.x, s.y, s.z);
    addUv.push(0, 0);
    const centre = next++;
    const base = ri * vertsPerRing;
    for (let j = 0; j < radial; j++) {
      if (ri === 0) oldIdx.push(centre, base + j, base + j + 1);
      else oldIdx.push(centre, base + j + 1, base + j);
    }
  }
  const pos = new Float32Array(oldPos.length + addPos.length);
  pos.set(oldPos); pos.set(addPos, oldPos.length);
  const uv = new Float32Array(oldUv.length + addUv.length);
  uv.set(oldUv); uv.set(addUv, oldUv.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(oldIdx);
  g.computeVertexNormals();
  geo.dispose();
  return g;
}

/**
 * Irregular boulder: an icosphere pushed around by fbm at three scales, squashed,
 * then flattened on the bottom so it beds into the ground rather than balancing
 * on a point.
 */
export function rockGeo({
  detail = 2, radius = 1, seed = 1, warp = 0.34, warpFreq = 1.35,
  squash = [1, 0.72, 1], flatten = 0.28, chip = 0.13, uTile = 0.625, shear = 0.12,
} = {}) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const p = geo.attributes.position.array;
  const count = geo.attributes.position.count;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    let x = p[o], y = p[o + 1], z = p[o + 2];
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    const f = warpFreq / radius;
    // three scales: massing, facets, chipped grain
    const big = fbm3(nx * 1.05 * radius * f, ny * 1.05 * radius * f, nz * 1.05 * radius * f,
      { octaves: 3, seed, gain: 0.52 }) - 0.5;
    const mid = fbm3(nx * 3.1 * radius * f + 11, ny * 3.1 * radius * f, nz * 3.1 * radius * f,
      { octaves: 3, seed: seed + 71, gain: 0.5, ridged: true }) - 0.5;
    const fine = perlin3(nx * 9.5 * radius * f, ny * 9.5 * radius * f, nz * 9.5 * radius * f, seed + 211) - 0.5;
    let r = len * (1 + big * warp * 2 + mid * warp * 0.85 + fine * chip);
    x = nx * r; y = ny * r; z = nz * r;
    x *= squash[0]; y *= squash[1]; z *= squash[2];
    // shear so the mass leans — vertical symmetry reads as "sphere"
    x += y * shear;
    z -= y * shear * 0.6;
    p[o] = x; p[o + 1] = y; p[o + 2] = z;
  }
  // flatten the base: pull everything below the cut plane up onto it
  geo.computeBoundingBox();
  const minY = geo.boundingBox.min.y;
  const cut = minY + (geo.boundingBox.max.y - minY) * flatten;
  for (let i = 0; i < count; i++) {
    const o = i * 3 + 1;
    if (p[o] < cut) {
      const t = smooth01(minY, cut, p[o]);
      p[o] = lerp(cut - (cut - minY) * 0.14, cut, t);
    }
  }
  geo.computeVertexNormals();
  const out = faceBoxUV(geo, uTile);
  if (out !== geo) geo.dispose();
  return out;
}

/**
 * Angular broken slab — scree, rubble, cliff chunks, masonry debris.
 * A box with randomised corner displacement and fractured faces.
 */
/**
 * `fine` — SIZE-RELATIVE fracture relief, in metres of displacement.
 *
 * The two fbm terms above it run at a FIXED 2.1 and 5.5 cycles per world metre,
 * which is correct on a 3 m standing stone and does nothing whatsoever on a 0.3 m
 * chip: at 2.1 cycles/m a 0.3 m piece spans 0.63 of one noise cell, so the
 * "displacement" it receives is a single smooth gradient and every facet comes out
 * of the generator dead planar. That is the geometric half of a debris field
 * measuring a mean 7x7 luma SD of 0.021 — the value a flat-shaded box gives, seen
 * on the crypt kit's debris in `closeup`. There is no signal at facet scale for a
 * highlight to catch, only one flat normal per triangle.
 *
 * This term is scaled to the piece instead: `fineCycles` wavelengths across its
 * largest dimension, so a 0.15 m chip and a 0.6 m block both get the same number
 * of bumps across their faces, and the amplitude is in absolute metres so it never
 * distorts the silhouette. Defaults to 0, i.e. every existing caller is untouched.
 */
export function shardGeo({
  w = 1, h = 0.4, d = 0.8, seed = 1, seg = 2, rough = 0.28, uTile = 0.625, bevel = 0.05,
  fine = 0, fineCycles = 7,
} = {}) {
  const geo = new RoundedBoxGeometry(w, h, d, seg, Math.min(bevel, Math.min(w, h, d) * 0.32));
  const p = geo.attributes.position.array;
  const ff = fineCycles / Math.max(0.05, Math.max(w, h, d));
  for (let i = 0, n = geo.attributes.position.count; i < n; i++) {
    const o = i * 3;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    const f = 2.1;
    const a = fbm3(x * f + 3, y * f, z * f, { octaves: 3, seed, gain: 0.5 }) - 0.5;
    const b = fbm3(x * f * 2.6, y * f * 2.6 + 7, z * f * 2.6, { octaves: 2, seed: seed + 41, gain: 0.5 }) - 0.5;
    const m = (a * 0.75 + b * 0.35) * rough;
    p[o] = x * (1 + m);
    p[o + 1] = y * (1 + m * 1.25);
    p[o + 2] = z * (1 + m);
    if (fine > 0) {
      // Displace along the box normal direction rather than radially, so a flat
      // face gets relief instead of being scaled about the centre.
      const c = fbm3(x * ff + 11, y * ff, z * ff, { octaves: 2, seed: seed + 613, gain: 0.5 }) - 0.5;
      const e = fbm3(x * ff * 2.7, y * ff * 2.7 + 3, z * ff * 2.7, { octaves: 2, seed: seed + 811, gain: 0.5 }) - 0.5;
      const amp = (c + e * 0.45) * fine * 2;
      const ax = Math.abs(x) / (w * 0.5 + 1e-6);
      const ay = Math.abs(y) / (h * 0.5 + 1e-6);
      const az = Math.abs(z) / (d * 0.5 + 1e-6);
      if (ax >= ay && ax >= az) p[o] += Math.sign(x || 1) * amp;
      else if (ay >= az) p[o + 1] += Math.sign(y || 1) * amp;
      else p[o + 2] += Math.sign(z || 1) * amp;
    }
  }
  geo.computeVertexNormals();
  const out = faceBoxUV(geo, uTile);
  if (out !== geo) geo.dispose();
  return out;
}

/** Bevelled box with metre UVs. Nothing in this game has a sharp 90° corner. */
export function boxGeo(w, h, d, { bevel = 0.02, seg = 1, uTile = 0.625 } = {}) {
  const b = Math.max(0.004, Math.min(bevel, Math.min(w, h, d) * 0.32));
  const geo = new RoundedBoxGeometry(w, h, d, seg, b);
  const out = faceBoxUV(geo, uTile);
  if (out !== geo) geo.dispose();
  return out;
}

/**
 * Lathe with metre UVs and a lobed radius so turned stone/wood is not perfectly
 * circular. `profile` is [[r,y], ...] bottom to top.
 */
export function latheGeo(profile, {
  seg = 16, uTile = 0.625, seed = 3, lobeAmt = 0.02, lobes = 5, capTop = false, capBottom = false,
} = {}) {
  const rings = profile.length;
  const vpr = seg + 1;
  const total = rings * vpr;
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = [];
  const tileLen = 1 / Math.max(1e-4, uTile);

  let arc = 0;
  const vArc = new Float64Array(rings);
  for (let i = 1; i < rings; i++) {
    arc += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
    vArc[i] = arc;
  }

  for (let i = 0; i < rings; i++) {
    const [r0, y] = profile[i];
    const circ = Math.max(tileLen, Math.round((2 * Math.PI * Math.max(0.02, r0)) / tileLen) * tileLen);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const lo = 1 + Math.sin(a * lobes + i * 0.21) * lobeAmt
        + (perlin3(Math.cos(a) * 2, Math.sin(a) * 2, i * 0.5, seed) - 0.5) * lobeAmt * 1.5;
      const r = r0 * lo;
      const k = (i * vpr + j) * 3;
      pos[k] = Math.cos(a) * r;
      pos[k + 1] = y;
      pos[k + 2] = Math.sin(a) * r;
      const u = (i * vpr + j) * 2;
      uv[u] = (j / seg) * circ;
      uv[u + 1] = vArc[i];
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * vpr + j, b = a + 1, c = a + vpr, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const caps = [];
  if (capTop) caps.push({ ring: rings - 1, flip: false });
  if (capBottom) caps.push({ ring: 0, flip: true });
  if (!caps.length) return geo;

  const oldPos = geo.attributes.position.array, oldUv = geo.attributes.uv.array;
  const oldIdx = Array.from(geo.index.array);
  const addP = [], addU = [];
  let next = geo.attributes.position.count;
  for (const c of caps) {
    const y = profile[c.ring][1];
    addP.push(0, y, 0); addU.push(0, y);
    const centre = next++;
    const base = c.ring * vpr;
    for (let j = 0; j < seg; j++) {
      if (c.flip) oldIdx.push(centre, base + j, base + j + 1);
      else oldIdx.push(centre, base + j + 1, base + j);
    }
  }
  const pp = new Float32Array(oldPos.length + addP.length);
  pp.set(oldPos); pp.set(addP, oldPos.length);
  const uu = new Float32Array(oldUv.length + addU.length);
  uu.set(oldUv); uu.set(addU, oldUv.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uu, 2));
  g.setIndex(oldIdx);
  g.computeVertexNormals();
  geo.dispose();
  return g;
}

/**
 * A hanging cloth panel with a real sag surface: catenary droop between the two
 * top corners plus a travelling fold wave. Never a flat plane.
 */
export function clothGeo({
  w = 0.9, h = 1.9, segX = 8, segY = 14, sag = 0.16, fold = 0.05, foldFreq = 2.6,
  taper = 0.1, seed = 5, uTile = 3, tatter = 0.16,
} = {}) {
  const vx = segX + 1, vy = segY + 1;
  const pos = new Float32Array(vx * vy * 3);
  const uv = new Float32Array(vx * vy * 2);
  const idx = [];
  for (let j = 0; j < vy; j++) {
    const tv = j / segY;
    // hem is ragged: the bottom edge is eaten away unevenly
    const rag = tatter > 0 ? (fbm3(tv * 4, 0.3, 1.7, { octaves: 2, seed: seed + 5 }) - 0.5) * 2 * tatter : 0;
    for (let i = 0; i < vx; i++) {
      const tu = i / segX;
      const cx = (tu - 0.5) * w * (1 - taper * tv);
      const cy = -tv * h * (1 + (tu - 0.5) * rag * 0.3) - (tatter > 0 ? Math.max(0, rag) * h * 0.06 : 0);
      // catenary across the width, deepening downward
      const droop = (Math.cosh((tu - 0.5) * 2.2) - 1) * -sag * (0.25 + 0.75 * tv);
      const wave = Math.sin(tu * Math.PI * foldFreq + tv * 1.4 + seed) * fold * (0.2 + 0.8 * tv)
        + (fbm3(tu * 3.2, tv * 2.4, seed * 0.7, { octaves: 3, seed }) - 0.5) * fold * 1.1;
      const k = (j * vx + i) * 3;
      pos[k] = cx;
      pos[k + 1] = cy;
      pos[k + 2] = droop + wave;
      const u = (j * vx + i) * 2;
      uv[u] = tu * w;
      uv[u + 1] = tv * h;
    }
  }
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  setWind(geo, (x, y) => clamp01(-y / h));
  return geo;
}

/**
 * A hanging chain: torus links alternating 90°, following a catenary between
 * (0,0,0) and `end`.
 */
export function chainGeo({ end = [0, -1.6, 0], links = 9, linkR = 0.035, wire = 0.011, slack = 0.18, seed = 7 } = {}) {
  const parts = [];
  const ex = end[0], ey = end[1], ez = end[2];
  const geo = new THREE.TorusGeometry(linkR, wire, 5, 9);
  for (let i = 0; i < links; i++) {
    const t = (i + 0.5) / links;
    const sagY = -Math.sin(t * Math.PI) * slack;
    const jitter = (perlin3(i * 0.7, seed * 0.3, 1.1, seed) - 0.5) * 0.03;
    const g = geo.clone();
    // Face the link along the chain, alternating the roll every other link.
    const dir = new THREE.Vector3(ex, ey, ez).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    if (i & 1) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
    xform(g, {
      pos: [ex * t + jitter, ey * t + sagY, ez * t + jitter * 0.7],
      quat: q,
    });
    parts.push(faceBoxUV(g, 3));
    if (g !== parts[parts.length - 1]) g.dispose();
  }
  geo.dispose();
  const merged = mergeParts(parts);
  if (merged) setWind(merged, (x, y) => clamp01(-y / Math.max(0.2, Math.abs(ey))) * 0.8);
  return merged;
}

/**
 * Flame body: a teardrop of revolution with per-vertex height/angle attributes
 * the flame shader animates. Real geometry, never a camera-facing quad.
 */
export function flameGeo({ h = 0.22, r = 0.055, rings = 7, seg = 7 } = {}) {
  const vpr = seg + 1;
  const pos = new Float32Array(rings * vpr * 3);
  const aH = new Float32Array(rings * vpr);
  const idx = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    // teardrop: fat near the base, pinched to a point
    const rr = r * Math.sin(Math.pow(t, 0.55) * Math.PI * 0.94) * (1 - t * 0.15) + r * 0.06 * (1 - t);
    const y = t * h;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const k = (i * vpr + j) * 3;
      pos[k] = Math.cos(a) * rr;
      pos[k + 1] = y;
      pos[k + 2] = Math.sin(a) * rr;
      aH[i * vpr + j] = t;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * vpr + j, b = a + 1, c = a + vpr, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aH', new THREE.BufferAttribute(aH, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Contact-shadow blob: a shallow dome disc with a soft, noisy alpha ramp so the
 * darkening under a prop has an organic edge instead of a perfect circle.
 * Radius 1 — scaled per instance.
 */
export function contactBlobGeo({ seg = 14, rings = 3, dome = 0.06, seed = 11 } = {}) {
  const pos = [], uvs = [], idx = [];
  pos.push(0, dome, 0); uvs.push(0.5, 0.5);
  for (let r = 1; r <= rings; r++) {
    const rad = r / rings;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const wob = 1 + (perlin3(Math.cos(a) * 2.3, Math.sin(a) * 2.3, r * 0.9, seed) - 0.5) * 0.34;
      const rr = rad * wob;
      pos.push(Math.cos(a) * rr, dome * (1 - rad * rad), Math.sin(a) * rr);
      uvs.push(0.5 + Math.cos(a) * rad * 0.5, 0.5 + Math.sin(a) * rad * 0.5);
    }
  }
  for (let j = 0; j < seg; j++) idx.push(0, 1 + ((j + 1) % seg), 1 + j);
  for (let r = 1; r < rings; r++) {
    const b0 = 1 + (r - 1) * seg, b1 = 1 + r * seg;
    for (let j = 0; j < seg; j++) {
      const jn = (j + 1) % seg;
      idx.push(b0 + j, b1 + jn, b1 + j, b0 + j, b0 + jn, b1 + jn);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Blade cluster — the base primitive for grass tufts, reeds, heather and small
 * ferns. Each blade is a tapered 3-quad strip with a curve and a twist.
 */
export function bladeCluster({
  count = 7, h = 0.42, w = 0.028, spread = 0.11, bend = 0.42, rand,
  segs = 4, hVar = 0.45, twist = 0.5, uPeriod = 0.55, ribs = 4,
} = {}) {
  const r = rand;
  const pos = [], uvs = [], idx = [], wind = [];
  // One rib of the foliage texture spans exactly one blade, and consecutive
  // blades take different ribs — otherwise every blade in the game samples the
  // identical column of the texture and the tuft reads as flat ribbon.
  const ribW = uPeriod / ribs;
  let base = 0;
  for (let b = 0; b < count; b++) {
    const ang = r() * Math.PI * 2;
    const rr = Math.pow(r(), 0.65) * spread;
    const ox = Math.cos(ang) * rr, oz = Math.sin(ang) * rr;
    const bh = h * (1 - hVar * 0.5 + r() * hVar);
    const bw = w * (0.7 + r() * 0.6);
    const dir = ang + (r() - 0.5) * 1.4;
    const dx = Math.cos(dir), dz = Math.sin(dir);
    const bd = bend * (0.5 + r());
    const tw = (r() - 0.5) * twist;
    const u0 = ribW * ((b + (r() * ribs | 0)) % ribs);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const taper = 1 - t * t * 0.92;
      const y = bh * t;
      // quadratic droop
      const lean = bd * t * t * bh;
      const px = ox + dx * lean, pz = oz + dz * lean;
      const sy = -bd * 2 * t * bh;                       // tangent for the drop
      const drop = t * t * bh * 0.06;
      const halfW = bw * taper * 0.5;
      const nx = -dz * Math.cos(tw * t) + 0 * Math.sin(tw * t);
      const nz = dx * Math.cos(tw * t);
      const ty = Math.sin(tw * t) * halfW;
      pos.push(px - nx * halfW, y - drop - ty, pz - nz * halfW);
      pos.push(px + nx * halfW, y - drop + ty, pz + nz * halfW);
      uvs.push(u0, t * bh, u0 + ribW * 0.92, t * bh);
      const ww = Math.pow(t, 1.35);
      wind.push(ww, ww);
      void sy;
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2, b2 = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b2, b2, c, d);
    }
    base += (segs + 1) * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute(WIND_ATTR, new THREE.BufferAttribute(new Float32Array(wind), 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Recursive gnarled branching. Returns {geo, tips} where `tips` are world-space
 * branch ends (hang moss, lanterns or corpses off them).
 */
export function branchStructure({
  rand, height = 5.2, baseR = 0.24, depth = 4, splits = 2, seed = 3,
  taper = 0.62, gnarl = 0.55, radialBase = 8, uTile = 1.15, droop = 0.1,
} = {}) {
  const r = rand;
  const parts = [];
  const tips = [];
  let budget = 130;                                     // hard cap on branches

  const grow = (from, dir, len, rad, level) => {
    if (level > depth || budget-- <= 0 || rad < 0.012) return;
    const nodes = Math.max(3, 7 - level);
    const spine = [];
    const p = from.clone();
    const d = dir.clone().normalize();
    // per-branch twist axis so the limb corkscrews rather than arcing flat
    const side = new THREE.Vector3(-d.z, 0, d.x);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const bendAxis = side.clone().applyAxisAngle(d, r() * Math.PI * 2);
    const curve = (0.25 + r() * 0.75) * gnarl / Math.max(1, level * 0.6);
    for (let i = 0; i <= nodes; i++) {
      const t = i / nodes;
      spine.push({
        x: p.x, y: p.y, z: p.z,
        r: rad * (1 - t * (1 - taper)) * (1 + (perlin3(p.x * 3, p.y * 3, p.z * 3, seed + level) - 0.5) * 0.34),
        lobe: (perlin3(p.x, p.y * 0.7, p.z, seed + 17) - 0.5) * 6,
      });
      if (i === nodes) break;
      const step = len / nodes;
      d.applyAxisAngle(bendAxis, curve * step * (0.6 + 0.8 * r()));
      d.y -= droop * step * (level / Math.max(1, depth));
      d.normalize();
      p.addScaledVector(d, step);
    }
    const g = tube(spine, {
      radial: Math.max(4, radialBase - level * 2),
      uTile, lobes: 3 + (level & 1), lobeAmt: 0.15 + 0.06 * level, seed: seed + level * 13,
      closeStart: level === 0,
    });
    if (g) parts.push(g);
    tips.push({ x: p.x, y: p.y, z: p.z, r: rad * taper, level });

    if (level === depth) return;
    const nSplit = level === 0 ? splits + 1 : (r() < 0.72 ? splits : splits + 1);
    for (let s = 0; s < nSplit; s++) {
      const az = (s / nSplit) * Math.PI * 2 + r() * 1.5;
      const spreadAng = (0.42 + r() * 0.55) * (level === 0 ? 0.72 : 1);
      const nd = d.clone();
      const axis = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
      axis.sub(nd.clone().multiplyScalar(axis.dot(nd)));
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
      axis.normalize();
      nd.applyAxisAngle(axis, spreadAng).normalize();
      grow(p.clone(), nd, len * (0.54 + r() * 0.24), rad * taper * (0.72 + r() * 0.2), level + 1);
    }
  };

  // buttressed root flare at the bottom: a trunk that meets the ground at a
  // constant radius reads as a pipe stuck in the dirt
  const flareR = baseR * 1.9;
  const flare = latheGeo(
    [[flareR, -0.16], [flareR * 0.86, 0.02], [baseR * 1.22, 0.2], [baseR * 1.05, 0.42]],
    { seg: 9, uTile, seed: seed + 3, lobeAmt: 0.19, lobes: 5 }
  );
  parts.push(flare);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + r() * 0.7;
    const rl = 0.4 + r() * 0.5;
    const sp = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      sp.push({
        x: Math.cos(a) * rl * t, y: 0.34 * (1 - t) * (1 - t) - 0.05 * t,
        z: Math.sin(a) * rl * t, r: baseR * 0.42 * (1 - t * 0.8),
      });
    }
    const g = tube(sp, { radial: 5, uTile, lobes: 3, lobeAmt: 0.2, seed: seed + i });
    if (g) parts.push(g);
  }

  grow(new THREE.Vector3(0, 0.34, 0), new THREE.Vector3((r() - 0.5) * 0.22, 1, (r() - 0.5) * 0.22),
    height * 0.42, baseR, 0);

  const geo = mergeParts(parts);
  return { geo, tips };
}
