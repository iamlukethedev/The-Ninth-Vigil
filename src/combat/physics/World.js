/**
 * THE NINTH VIGIL — static world collision.
 *
 * The collision world is an AABB soup plus a heightfield, and both come from the
 * modules that already own the truth:
 *
 *   walls   ← Dungeon's nav mask (or `dungeon.isWalkable` sampled on a grid for
 *             the arena, whose containment is a hexagon test rather than a mask)
 *   props   ← Props' placement records, filtered through `props.blocksAt` so the
 *             definition of "solid dressing" stays in one place
 *   ground  ← `dungeon.floorHeightAt` when an interior is up, `terrain.heightAt`
 *             otherwise. A heightfield query is exact and costs one bilinear
 *             fetch, so the floor is never approximated by boxes.
 *
 * Blocked cells are greedy-merged into maximal rectangles before they become
 * boxes: the crypt's 144x144 mask collapses to a couple of hundred boxes, and
 * the surrounding rock mass — which is most of the grid — becomes a handful.
 *
 * Contact convention (shared with Shapes.js): a normal points OUT of the static
 * geometry, i.e. the direction a dynamic body must move to escape, and `depth`
 * is the penetration along it.
 */

import { Grid, greedyMerge } from './Broadphase.js';
import { makeBox, makeContact, sphereBox, capsuleBox, pointBoxDist2 } from './Shapes.js';

/** Box classes, so impacts can pick a material and AI can tell wall from crate. */
export const K_WALL = 0;
export const K_PROP = 1;
export const K_EDGE = 2;   // world boundary / rock mass

/** Interior wall height (Spec.wall.h) plus the cornice — see dungeon/Spec.js. */
const WALL_H = 4.60;
const WALL_BASE = 0.75;    // how far the box extends below the floor
/**
 * Per-kind solid box: [substring, height in metres, footprint fraction].
 *
 * The fraction matters as much as the height. Props' `fp` is a *scatter* radius —
 * it includes a dead tree's whole canopy — and using it as a collision radius
 * would wall off a 3 m circle around a 0.4 m trunk. The fraction converts a
 * scatter footprint into the solid part an actor can actually walk into.
 */
const PROP_BOX = [
  ['sarcophagus', 0.92, 0.80], ['barrel', 0.86, 0.72], ['crate', 0.80, 0.74],
  ['urn', 0.62, 0.62], ['pot', 0.55, 0.60],
  ['tomb', 1.12, 0.60], ['menhir', 2.20, 0.48], ['column', 2.35, 0.44],
  ['statue', 1.85, 0.50], ['arch', 3.00, 0.50], ['lintel', 0.70, 0.70],
  ['wall', 1.70, 0.82], ['cliff', 2.60, 0.80], ['obsidian', 2.40, 0.78],
  ['boulder', 0.95, 0.70], ['rocks', 0.80, 0.62],
  ['deadTree', 3.20, 0.20], ['charTree', 2.80, 0.20],
  ['cart', 1.15, 0.70], ['anvil', 0.90, 0.62], ['altar', 1.15, 0.72],
  ['brazier', 1.10, 0.40], ['sconce', 0.45, 0.30],
  ['rubble', 0.50, 0.55], ['bones', 0.35, 0.40], ['chain', 0.20, 0.20],
  ['shrub', 0.55, 0.25], ['bramble', 0.50, 0.25], ['reeds', 0.60, 0.20],
];

export class PhysWorld {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Array<object>} flat AABB soup */
    this.boxes = [];
    this.grid = new Grid(2.5);
    this.bounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40, minY: -4, maxY: 12 };
    this.floorY = 0;
    this.interior = false;
    this.revision = 0;

    this._seen = new Int32Array(64);
    this._stamp = 0;
    this._hits = new Int32Array(256);
    this._c = makeContact();
    this._c2 = makeContact();
    this._heightAt = null;
    this._walkAt = null;
    this.stats = { boxes: 0, cells: 0, buildMs: 0, source: 'none' };
  }

  /* ================================================================ *
   * build
   * ================================================================ */

  /** Rebuild the whole static world. Cheap enough to call on every scenario. */
  rebuild() {
    const t0 = _now();
    this.boxes.length = 0;
    this.revision++;

    const eng = this.engine;
    const dungeon = _live(eng.get('dungeon'));
    const terrain = _live(eng.get('terrain'));

    /* ---- ground sampler ---- */
    const dOn = !!(dungeon && dungeon.active && typeof dungeon.floorHeightAt === 'function');
    const tOn = !!(terrain && typeof terrain.heightAt === 'function');
    this.interior = dOn;
    if (dOn) {
      this._heightAt = (x, z) => {
        const h = dungeon.floorHeightAt(x, z);
        return Number.isFinite(h) ? h : 0;
      };
    } else if (tOn) {
      this._heightAt = (x, z) => {
        const h = terrain.heightAt(x, z);
        return Number.isFinite(h) ? h : 0;
      };
    } else {
      this._heightAt = () => 0;
    }
    this._walkAt = dOn && typeof dungeon.isWalkable === 'function'
      ? (x, z) => dungeon.isWalkable(x, z)
      : (tOn && typeof terrain.isWalkable === 'function' ? (x, z) => terrain.isWalkable(x, z) : null);

    /* ---- bounds ---- */
    const b = (dOn && dungeon.bounds) ? dungeon.bounds : null;
    if (b) {
      this.bounds = {
        minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ,
        minY: b.minY ?? -4, maxY: b.maxY ?? 12,
      };
    } else {
      const half = 60;
      this.bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half, minY: -12, maxY: 24 };
    }
    this.floorY = this._heightAt(0, 0);

    /* ---- walls ---- */
    let source = 'open';
    if (dOn) {
      const mask = dungeon.navMask;
      if (mask && mask.data && mask.W) { this._wallsFromMask(mask); source = 'navMask'; }
      else if (this._walkAt) { this._wallsFromSampler(); source = 'sampled'; }
    }
    this._boundaryBoxes();

    /* ---- solid props ---- */
    const props = _live(eng.get('props'));
    if (props && Array.isArray(props.props)) this._propBoxes(props);

    /* ---- broadphase ---- */
    if (this._seen.length < this.boxes.length) this._seen = new Int32Array(this.boxes.length + 64);
    else this._seen.fill(0);
    this._stamp = 0;
    this.grid.build(this.boxes, this.bounds, 2.5);

    this.stats.boxes = this.boxes.length;
    this.stats.cells = this.grid.nx * this.grid.nz;
    this.stats.buildMs = _now() - t0;
    this.stats.source = source;
    return this;
  }

  /** Blocked nav cells -> merged wall boxes. The fast path. */
  _wallsFromMask(mask) {
    const { data, W, cell, originX, originZ } = mask;
    const H = Math.floor(data.length / W);
    const solid = (i, j) => data[j * W + i] === 0;
    greedyMerge(solid, W, H, (i0, j0, i1, j1) => {
      const x0 = originX + i0 * cell, x1 = originX + i1 * cell;
      const z0 = originZ + j0 * cell, z1 = originZ + j1 * cell;
      const gy = this._sampleFloor(x0, z0, x1, z1);
      this.boxes.push(makeBox(x0, gy - WALL_BASE, z0, x1, gy + WALL_H, z1, K_WALL));
    });
  }

  /** Fallback: sample `isWalkable` on a 0.5 m grid, then merge. Used by the arena. */
  _wallsFromSampler() {
    const cell = 0.5;
    const bb = this.bounds;
    const W = Math.min(320, Math.ceil((bb.maxX - bb.minX) / cell));
    const H = Math.min(320, Math.ceil((bb.maxZ - bb.minZ) / cell));
    const ox = bb.minX, oz = bb.minZ;
    const mask = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) {
      const z = oz + (j + 0.5) * cell;
      for (let i = 0; i < W; i++) {
        const x = ox + (i + 0.5) * cell;
        mask[j * W + i] = this._walkAt(x, z) ? 0 : 1;
      }
    }
    greedyMerge((i, j) => mask[j * W + i] === 1, W, H, (i0, j0, i1, j1) => {
      const x0 = ox + i0 * cell, x1 = ox + i1 * cell;
      const z0 = oz + j0 * cell, z1 = oz + j1 * cell;
      const gy = this._sampleFloor(x0, z0, x1, z1);
      this.boxes.push(makeBox(x0, gy - WALL_BASE, z0, x1, gy + WALL_H, z1, K_WALL));
    });
  }

  /** Lowest floor height over a rectangle, from five taps (corners + centre). */
  _sampleFloor(x0, z0, x1, z1) {
    const h = this._heightAt;
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    let lo = h(cx, cz);
    const a = h(x0 + 0.02, z0 + 0.02); if (a < lo) lo = a;
    const c = h(x1 - 0.02, z0 + 0.02); if (c < lo) lo = c;
    const d = h(x0 + 0.02, z1 - 0.02); if (d < lo) lo = d;
    const e = h(x1 - 0.02, z1 - 0.02); if (e < lo) lo = e;
    return lo;
  }

  /** Four slabs just outside the play area so nothing can leave the world. */
  _boundaryBoxes() {
    const b = this.bounds;
    const t = 4, y0 = b.minY - 4, y1 = b.maxY + 8;
    this.boxes.push(makeBox(b.minX - t, y0, b.minZ - t, b.minX, y1, b.maxZ + t, K_EDGE));
    this.boxes.push(makeBox(b.maxX, y0, b.minZ - t, b.maxX + t, y1, b.maxZ + t, K_EDGE));
    this.boxes.push(makeBox(b.minX, y0, b.minZ - t, b.maxX, y1, b.minZ, K_EDGE));
    this.boxes.push(makeBox(b.minX, y0, b.maxZ, b.maxX, y1, b.maxZ + t, K_EDGE));
  }

  /** Solid dressing -> boxes. Solidity is Props' own call, via `blocksAt`. */
  _propBoxes(props) {
    const list = props.props;
    const canAsk = typeof props.blocksAt === 'function';
    let added = 0;
    for (let i = 0; i < list.length && added < 900; i++) {
      const p = list[i];
      if (!p || p.hidden || p.far) continue;
      const r = p.r ?? 0;
      if (r < 0.3) continue;                       // grass, scree, moss
      if (canAsk && !props.blocksAt(p.x, p.z, 0.02)) continue;
      const spec = _propSpec(p.kind, r);
      const hr = Math.min(1.3, r * spec[2]);
      if (hr < 0.16) continue;                       // not solid enough to matter
      const h = spec[1] * (p.scale ?? 1);
      const gy = p.groundY ?? this._heightAt(p.x, p.z);
      this.boxes.push(makeBox(p.x - hr, gy - 0.35, p.z - hr, p.x + hr, gy + h, p.z + hr, K_PROP));
      added++;
    }
  }

  /* ================================================================ *
   * queries
   * ================================================================ */

  heightAt(x, z) { return this._heightAt ? this._heightAt(x, z) : 0; }

  isWalkable(x, z) { return this._walkAt ? !!this._walkAt(x, z) : true; }

  /**
   * Ground normal by central difference on the heightfield. `out` is a plain
   * {x,y,z}; the caller owns it.
   */
  normalAt(x, z, out, e = 0.35) {
    const h = this._heightAt;
    const hx = h(x + e, z) - h(x - e, z);
    const hz = h(x, z + e) - h(x, z - e);
    const nx = -hx, ny = 2 * e, nz = -hz;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** Box indices whose XZ footprint overlaps the rectangle. */
  query(minX, minZ, maxX, maxZ) {
    if (this._hits.length < this.grid.count) this._hits = new Int32Array(this.grid.count + 64);
    this._stamp++;
    if (this._stamp > 2000000000) { this._seen.fill(0); this._stamp = 1; }
    this._nHits = this.grid.query(minX, minZ, maxX, maxZ, this._hits, this._seen, this._stamp);
    return this._nHits;
  }
  get hits() { return this._hits; }

  /**
   * Push a sphere out of every box it overlaps. Accumulates so a corner resolves
   * in one call instead of ping-ponging between two faces.
   *
   * @param {object} out {dx,dy,dz,depth,nx,ny,nz,kind,hit,ground}
   * @returns {boolean} true if anything was hit
   */
  solveSphere(x, y, z, r, out) {
    const n = this.query(x - r, z - r, x + r, z + r);
    out.dx = 0; out.dy = 0; out.dz = 0; out.depth = 0;
    out.nx = 0; out.ny = 0; out.nz = 0; out.hit = false; out.kind = -1;
    if (!n) return false;
    const c = this._c;
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      const box = this.boxes[this._hits[i]];
      if (y - r > box.maxY || y + r < box.minY) continue;
      if (!sphereBox(x, y, z, r, box, c)) continue;
      out.dx += c.nx * c.depth;
      out.dy += c.ny * c.depth;
      out.dz += c.nz * c.depth;
      out.hit = true;
      if (c.depth > deepest) {
        deepest = c.depth;
        out.nx = c.nx; out.ny = c.ny; out.nz = c.nz;
        out.kind = box.kind;
      }
    }
    out.depth = deepest;
    return out.hit;
  }

  /**
   * Capsule against the world. Same accumulation, plus the deepest contact's
   * normal and the highest surface found under the capsule (for step-up).
   */
  solveCapsule(ax, ay, az, bx, by, bz, r, out) {
    const minX = Math.min(ax, bx) - r, maxX = Math.max(ax, bx) + r;
    const minZ = Math.min(az, bz) - r, maxZ = Math.max(az, bz) + r;
    const loY = Math.min(ay, by) - r, hiY = Math.max(ay, by) + r;
    const n = this.query(minX, minZ, maxX, maxZ);
    out.dx = 0; out.dy = 0; out.dz = 0; out.depth = 0;
    out.nx = 0; out.ny = 0; out.nz = 0; out.hit = false; out.kind = -1;
    out.topY = -Infinity;
    if (!n) return false;
    const c = this._c;
    let deepest = 0;
    for (let i = 0; i < n; i++) {
      const box = this.boxes[this._hits[i]];
      if (loY > box.maxY || hiY < box.minY) continue;
      if (!capsuleBox(ax, ay, az, bx, by, bz, r, box, c)) continue;
      out.dx += c.nx * c.depth;
      out.dy += c.ny * c.depth;
      out.dz += c.nz * c.depth;
      out.hit = true;
      if (box.maxY > out.topY) out.topY = box.maxY;
      if (c.depth > deepest) {
        deepest = c.depth;
        out.nx = c.nx; out.ny = c.ny; out.nz = c.nz;
        out.kind = box.kind;
      }
    }
    out.depth = deepest;
    return out.hit;
  }

  /**
   * Highest solid surface at or below `fromY` within `dist`, considering both
   * the heightfield and box tops. Returns the surface Y, or -Infinity.
   */
  surfaceBelow(x, z, fromY, dist = 2.0, r = 0.15) {
    let best = -Infinity;
    const gy = this._heightAt(x, z);
    if (gy <= fromY + 1e-4 && gy >= fromY - dist) best = gy;
    const n = this.query(x - r, z - r, x + r, z + r);
    for (let i = 0; i < n; i++) {
      const box = this.boxes[this._hits[i]];
      if (box.kind === K_EDGE) continue;
      if (x + r < box.minX || x - r > box.maxX || z + r < box.minZ || z - r > box.maxZ) continue;
      const top = box.maxY;
      if (top <= fromY + 1e-4 && top >= fromY - dist && top > best) best = top;
    }
    return best;
  }

  /** True if a point is inside any solid box (used to reject bad spawns). */
  inside(x, y, z, pad = 0) {
    const n = this.query(x - pad, z - pad, x + pad, z + pad);
    for (let i = 0; i < n; i++) {
      const b = this.boxes[this._hits[i]];
      if (x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad &&
          z >= b.minZ - pad && z <= b.maxZ + pad) return true;
    }
    return false;
  }

  /** Squared distance from a point to the nearest box (for cover queries). */
  nearestBoxDist2(x, y, z, radius = 3) {
    const n = this.query(x - radius, z - radius, x + radius, z + radius);
    let best = radius * radius;
    for (let i = 0; i < n; i++) {
      const b = this.boxes[this._hits[i]];
      const d2 = pointBoxDist2(x, y, z, b);
      if (d2 < best) best = d2;
    }
    return best;
  }

  /**
   * Segment against the box soup — a DDA-free conservative walk that is exact
   * for AABBs (slab test per candidate). Used by shatter to keep chunks inside
   * the room and by AI line-of-sight if it wants it.
   * @returns {number} t in 0..1 of the first hit, or 1 when clear
   */
  raySegment(ox, oy, oz, dx, dy, dz, out = null) {
    const minX = Math.min(ox, ox + dx), maxX = Math.max(ox, ox + dx);
    const minZ = Math.min(oz, oz + dz), maxZ = Math.max(oz, oz + dz);
    const n = this.query(minX, minZ, maxX, maxZ);
    let bestT = 1, bnx = 0, bny = 0, bnz = 0, bk = -1;
    const ix = dx !== 0 ? 1 / dx : Infinity;
    const iy = dy !== 0 ? 1 / dy : Infinity;
    const iz = dz !== 0 ? 1 / dz : Infinity;
    for (let i = 0; i < n; i++) {
      const b = this.boxes[this._hits[i]];
      let t0 = 0, t1 = bestT, ax = 0, ay = 0, az = 0;
      let lo = (b.minX - ox) * ix, hi = (b.maxX - ox) * ix;
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) { t0 = lo; ax = dx > 0 ? -1 : 1; ay = 0; az = 0; }
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      lo = (b.minY - oy) * iy; hi = (b.maxY - oy) * iy;
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) { t0 = lo; ax = 0; ay = dy > 0 ? -1 : 1; az = 0; }
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
      lo = (b.minZ - oz) * iz; hi = (b.maxZ - oz) * iz;
      if (lo > hi) { const s = lo; lo = hi; hi = s; }
      if (lo > t0) { t0 = lo; ax = 0; ay = 0; az = dz > 0 ? -1 : 1; }
      if (hi < t1) t1 = hi;
      if (t0 > t1 || t0 < 0) continue;
      if (t0 < bestT) { bestT = t0; bnx = ax; bny = ay; bnz = az; bk = b.kind; }
    }
    if (out) { out.t = bestT; out.nx = bnx; out.ny = bny; out.nz = bnz; out.kind = bk; out.hit = bestT < 1; }
    return bestT;
  }
}

/* ------------------------------------------------------------------ */

const _PROP_FALLBACK = ['', 1, 0.6];

/** @returns {[string, number, number]} [kindKey, height, footprintFraction] */
function _propSpec(kind, r) {
  if (typeof kind === 'string') {
    for (let i = 0; i < PROP_BOX.length; i++) {
      if (kind.indexOf(PROP_BOX[i][0]) >= 0) return PROP_BOX[i];
    }
  }
  const h = r * 1.6;
  _PROP_FALLBACK[1] = h < 0.5 ? 0.5 : h > 1.7 ? 1.7 : h;
  return _PROP_FALLBACK;
}

function _live(m) { return m && !m.__dead ? m : null; }

/** Wall-clock is used for build diagnostics only — never for simulation. */
function _now() {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

export { makeContact };
export default PhysWorld;
