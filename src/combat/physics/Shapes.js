/**
 * SANCTUM — physics primitives.
 *
 * Allocation-free intersection kernels. Everything here is pure arithmetic on
 * numbers written into caller-owned scratch objects, because the solvers below
 * call these tens of thousands of times per frame and a single `new Vector3()`
 * in that path costs more than the maths does.
 *
 * The static world is represented as axis-aligned boxes. That is not a
 * simplification made for convenience — the crypt IS axis aligned (Layout.js is
 * integer cell arithmetic on a 0.5 m grid) and the arena's containment is a
 * sampled mask, so an AABB soup is the *exact* collision representation for the
 * geometry that exists, at a fraction of the cost of a triangle tree over the
 * 28 M triangles the renderer draws.
 *
 * Contact convention: `normal` always points **out of the static geometry** and
 * therefore in the direction the dynamic body must be pushed. `depth` is the
 * penetration along that normal, always >= 0.
 */

const EPS = 1e-9;

/** A contact record, reused. */
export function makeContact() {
  return { hit: false, nx: 0, ny: 1, nz: 0, depth: 0, px: 0, py: 0, pz: 0, t: 0, ref: null };
}

export function makeBox(minX, minY, minZ, maxX, maxY, maxZ, kind = 0) {
  return { minX, minY, minZ, maxX, maxY, maxZ, kind, __st: -1 };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================================================================== *
 * sphere / point vs AABB
 * ================================================================== */

/**
 * Sphere against an AABB. Handles the deep case (centre inside the box) by
 * escaping along the shallowest face, which is what stops a body that has been
 * shoved inside a wall from being launched through it.
 *
 * @returns {boolean} true when penetrating; fills `out`.
 */
export function sphereBox(px, py, pz, r, b, out) {
  const qx = px < b.minX ? b.minX : px > b.maxX ? b.maxX : px;
  const qy = py < b.minY ? b.minY : py > b.maxY ? b.maxY : py;
  const qz = pz < b.minZ ? b.minZ : pz > b.maxZ ? b.maxZ : pz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  const d2 = dx * dx + dy * dy + dz * dz;

  if (d2 > EPS) {
    if (d2 >= r * r) { out.hit = false; return false; }
    const d = Math.sqrt(d2);
    const inv = 1 / d;
    out.nx = dx * inv; out.ny = dy * inv; out.nz = dz * inv;
    out.depth = r - d;
    out.px = qx; out.py = qy; out.pz = qz;
    out.hit = true;
    out.ref = b;
    return true;
  }

  /* centre is inside — leave by the nearest face */
  const dxn = px - b.minX, dxp = b.maxX - px;
  const dyn = py - b.minY, dyp = b.maxY - py;
  const dzn = pz - b.minZ, dzp = b.maxZ - pz;
  let best = dxn, ax = -1, ay = 0, az = 0;
  if (dxp < best) { best = dxp; ax = 1; ay = 0; az = 0; }
  if (dyn < best) { best = dyn; ax = 0; ay = -1; az = 0; }
  if (dyp < best) { best = dyp; ax = 0; ay = 1; az = 0; }
  if (dzn < best) { best = dzn; ax = 0; ay = 0; az = -1; }
  if (dzp < best) { best = dzp; ax = 0; ay = 0; az = 1; }
  out.nx = ax; out.ny = ay; out.nz = az;
  out.depth = r + best;
  out.px = px - ax * best; out.py = py - ay * best; out.pz = pz - az * best;
  out.hit = true;
  out.ref = b;
  return true;
}

/* ================================================================== *
 * capsule vs AABB
 * ================================================================== */

/**
 * Closest parameter along segment a->b to an AABB, by alternating projection.
 * Four iterations is exact for the axis-aligned case and converges to within a
 * fraction of a millimetre otherwise; the count is fixed so the result is
 * byte-deterministic.
 */
export function segBoxParam(ax, ay, az, bx, by, bz, box) {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const len2 = ex * ex + ey * ey + ez * ez;
  if (len2 < EPS) return 0;
  const inv = 1 / len2;
  // seed from the box centre so the first projection is already close
  let t = ((box.minX + box.maxX) * 0.5 - ax) * ex +
          ((box.minY + box.maxY) * 0.5 - ay) * ey +
          ((box.minZ + box.maxZ) * 0.5 - az) * ez;
  t *= inv;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let k = 0; k < 4; k++) {
    const px = ax + ex * t, py = ay + ey * t, pz = az + ez * t;
    const qx = px < box.minX ? box.minX : px > box.maxX ? box.maxX : px;
    const qy = py < box.minY ? box.minY : py > box.maxY ? box.maxY : py;
    const qz = pz < box.minZ ? box.minZ : pz > box.maxZ ? box.maxZ : pz;
    let nt = ((qx - ax) * ex + (qy - ay) * ey + (qz - az) * ez) * inv;
    nt = nt < 0 ? 0 : nt > 1 ? 1 : nt;
    if (Math.abs(nt - t) < 1e-6) { t = nt; break; }
    t = nt;
  }
  return t;
}

/** Capsule (segment a->b, radius r) against an AABB. Fills `out`, sets out.t. */
export function capsuleBox(ax, ay, az, bx, by, bz, r, box, out) {
  const t = segBoxParam(ax, ay, az, bx, by, bz, box);
  const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, pz = az + (bz - az) * t;
  const hit = sphereBox(px, py, pz, r, box, out);
  out.t = t;
  return hit;
}

/* ================================================================== *
 * segment vs segment (capsule vs capsule)
 * ================================================================== */

const _ss = { s: 0, t: 0 };

/**
 * Closest points between two segments, the classic Ericson clamped solve.
 * Returns { s, t } parameters on P->Q and R->S respectively.
 */
export function segSeg(p0x, p0y, p0z, p1x, p1y, p1z, q0x, q0y, q0z, q1x, q1y, q1z) {
  const dx = p1x - p0x, dy = p1y - p0y, dz = p1z - p0z;
  const ex = q1x - q0x, ey = q1y - q0y, ez = q1z - q0z;
  const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
  const a = dx * dx + dy * dy + dz * dz;
  const e = ex * ex + ey * ey + ez * ez;
  const f = ex * rx + ey * ry + ez * rz;
  let s = 0, t = 0;
  if (a <= EPS && e <= EPS) { _ss.s = 0; _ss.t = 0; return _ss; }
  if (a <= EPS) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = dx * rx + dy * ry + dz * rz;
    if (e <= EPS) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dx * ex + dy * ey + dz * ez;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  _ss.s = s; _ss.t = t;
  return _ss;
}

/** Capsule vs capsule. Fills `out` with a normal pointing from B toward A. */
export function capsuleCapsule(
  a0x, a0y, a0z, a1x, a1y, a1z, ra,
  b0x, b0y, b0z, b1x, b1y, b1z, rb, out
) {
  const p = segSeg(a0x, a0y, a0z, a1x, a1y, a1z, b0x, b0y, b0z, b1x, b1y, b1z);
  const ax = a0x + (a1x - a0x) * p.s, ay = a0y + (a1y - a0y) * p.s, az = a0z + (a1z - a0z) * p.s;
  const bx = b0x + (b1x - b0x) * p.t, by = b0y + (b1y - b0y) * p.t, bz = b0z + (b1z - b0z) * p.t;
  let dx = ax - bx, dy = ay - by, dz = az - bz;
  const d2 = dx * dx + dy * dy + dz * dz;
  const rr = ra + rb;
  if (d2 >= rr * rr) { out.hit = false; return false; }
  let d = Math.sqrt(d2);
  if (d < 1e-5) {
    // degenerate: separate along the least-aligned world axis, deterministically
    dx = 0; dy = 1; dz = 0; d = 1;
  } else {
    const inv = 1 / d;
    dx *= inv; dy *= inv; dz *= inv;
  }
  out.nx = dx; out.ny = dy; out.nz = dz;
  out.depth = rr - d;
  out.px = (ax + bx) * 0.5; out.py = (ay + by) * 0.5; out.pz = (az + bz) * 0.5;
  out.t = p.s; out.s = p.t;
  out.hit = true;
  return true;
}

/* ================================================================== *
 * misc
 * ================================================================== */

/** Distance from a point to an AABB (0 inside). */
export function pointBoxDist2(px, py, pz, b) {
  const dx = px < b.minX ? b.minX - px : px > b.maxX ? px - b.maxX : 0;
  const dy = py < b.minY ? b.minY - py : py > b.maxY ? py - b.maxY : 0;
  const dz = pz < b.minZ ? b.minZ - pz : pz > b.maxZ ? pz - b.maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

export function boxOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
         a.minY <= b.maxY && a.maxY >= b.minY &&
         a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}
