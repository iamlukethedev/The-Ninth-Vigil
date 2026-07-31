/**
 * THE NINTH VIGIL — navigation grid + A* + string-pulled path smoothing.
 *
 * A single sliding nav *tile* centred on the action rather than a grid over the
 * whole 260 m heightfield: agents only ever path within a few dozen metres of
 * the player, so covering 115 m at 0.55 m resolution (210² = 44 100 cells) buys
 * everything we need for ~1 ms of build cost, recentred with hysteresis when the
 * action walks off the tile.
 *
 * Per cell we store:
 *   walk[]   1 = standable  (terrain.isWalkable AND NOT dungeon-blocked)
 *   clear[]  distance in metres to the nearest blocked cell (chamfer transform)
 *
 * The clearance field is what stops the classic "agents hug the wall / clip the
 * corner" read. It is used three ways: as an A* cost so paths run down the
 * middle of a corridor, as a radius test so a 0.96 m brute never plans through
 * a 0.6 m gap, and as the visibility test for string-pulling.
 *
 * Everything is allocation-free on the hot path: open/closed sets are
 * generation-stamped and reused, and paths are written into pooled arrays.
 */

import { K_PROP } from '../../combat/physics/World.js';

const SQ2 = Math.SQRT2;
const FAR = 1e6;

/**
 * A* step multiplier for a cell with `m` metres of clearance. Strongest right
 * against a wall and gone by 1.6 m out, so paths prefer the middle of a corridor
 * without refusing a tight one.
 */
function wallCost(m) {
  const t = m < 1.6 ? 1 - m / 1.6 : 0;
  return 1 + t * t * 2.2;
}

export class NavGrid {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   */
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.cell = opts.cell ?? 0.55;
    this.span = opts.span ?? 116;
    this.W = Math.max(16, Math.round(this.span / this.cell));
    this.span = this.W * this.cell;
    const n = this.W * this.W;

    this.walk = new Uint8Array(n);
    this.clear = new Float32Array(n);
    this.cost = new Float32Array(n);          // 1 + wall-proximity penalty
    /** Clearance measured against the collision world — see `_refineClearance`. */
    this.tight = new Float32Array(n).fill(Infinity);
    /**
     * Which of the 3x3 probe positions the clearance in `clear` was measured at,
     * 0..8 with 4 meaning dead centre. `clear` answers "can a body get through
     * this cell", which is a claim about ONE point in it, not about the centre —
     * so a route has to be handed that point or it aims at stone. See `repX`.
     */
    this.rep = new Uint8Array(n).fill(4);
    /** Probe spacing, shared by `_refineClearance` and `repX`/`repZ`. */
    this.repOff = this.cell * 0.45;

    // A* scratch (generation-stamped so we never clear a 44 k array)
    this._g = new Float32Array(n);
    this._f = new Float32Array(n);
    this._from = new Int32Array(n);
    this._stamp = new Int32Array(n);
    this._closed = new Uint8Array(n);
    this._gen = 0;

    // binary heap over cell indices
    this._heapIdx = new Int32Array(n + 1);
    this._heapKey = new Float32Array(n + 1);
    this._heapN = 0;

    this.originX = -this.span * 0.5;
    this.originZ = -this.span * 0.5;
    this.version = 0;
    this.built = false;
    this.ready = false;

    this._lastBuildFrame = -9999;
    /** Physics static-world revision the prop stamps came from. See `_stampSolidProps`. */
    this.staticRevision = -1;
    this._stamps = [];                        // dynamic obstacles, replayed on rebuild
    this._cache = new Map();                  // path cache
    this._cacheOrder = [];
    this.nodeBudget = 0;                      // reset per frame by AI
    this.stats = { builds: 0, buildMs: 0, astar: 0, cacheHits: 0, expansions: 0, deferred: 0, tightened: 0 };
    /** Scratch contact for `_refineClearance`, so the band scan allocates nothing. */
    this._fit = {
      dx: 0, dy: 0, dz: 0, depth: 0, nx: 0, ny: 0, nz: 0, kind: -1, hit: false, ground: false,
    };

    this._scratchA = new Float64Array(1024);  // raw A* polyline
    this._scratchB = new Float64Array(1024);  // string-pulled polyline
  }

  /* ================================================================ *
   * coordinates
   * ================================================================ */

  ix(x) { return Math.floor((x - this.originX) / this.cell); }
  iz(z) { return Math.floor((z - this.originZ) / this.cell); }
  cx(ix) { return this.originX + (ix + 0.5) * this.cell; }
  cz(iz) { return this.originZ + (iz + 0.5) * this.cell; }
  inside(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.W && iz < this.W; }

  /**
   * The point in cell `k` that `clear[k]` actually describes.
   *
   * Anything that turns a cell into a place to walk to must ask for this and not
   * for `cx`/`cz`. `_refineClearance` keeps the ROOMIEST of nine probes, so in a
   * doorway whose opening is off the cell lattice the roomy point can be a
   * quarter of a cell from the middle — and the middle can be inside the jamb.
   * Emitting centres put 19 % of the crypt's walkable cells on ground the hero
   * cannot stand on, and the hero walked into the jamb of a 1.75 m door the grid
   * was describing as 3.25 m wide.
   */
  repX(k) { return this.cx(k % this.W) + ((this.rep[k] % 3) - 1) * this.repOff; }
  repZ(k) { return this.cz((k / this.W) | 0) + (((this.rep[k] / 3) | 0) - 1) * this.repOff; }

  /** True when a world point is inside the current tile with `margin` to spare. */
  covers(x, z, margin = 0) {
    return x >= this.originX + margin && x <= this.originX + this.span - margin &&
           z >= this.originZ + margin && z <= this.originZ + this.span - margin;
  }

  /* ================================================================ *
   * build
   * ================================================================ */

  /**
   * Recentre the tile on (x, z) if the point has drifted near the border.
   * Rate-limited so a jittering target cannot rebuild every frame — unless the
   * point has left the tile entirely, in which case we must rebuild now.
   */
  ensureCovers(x, z, margin = 16) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const hard = !this.covers(x, z, 1.5);
    if (this.built && this.covers(x, z, margin)) return false;
    const frame = this.engine.clock.frame;
    if (!hard && this.built && frame - this._lastBuildFrame < 45) return false;
    this.rebuild(x, z);
    return true;
  }

  rebuild(centerX = 0, centerZ = 0) {
    const t0 = now();
    this.originX = centerX - this.span * 0.5;
    this.originZ = centerZ - this.span * 0.5;
    this._lastBuildFrame = this.engine.clock.frame;

    // Measured clearances belong to the geometry under the OLD tile.
    this.tight.fill(Infinity);
    this.rep.fill(4);

    const terrain = this._terrain();
    const dungeon = this._dungeon();
    const W = this.W, walk = this.walk, cell = this.cell;

    const tWalk = terrain && typeof terrain.isWalkable === 'function' ? terrain : null;
    const dWalk = dungeon && typeof dungeon.isWalkable === 'function' ? dungeon : null;
    const dBlock = dungeon && !dWalk && typeof dungeon.isBlocked === 'function' ? dungeon : null;
    const dSolid = dungeon && !dWalk && !dBlock && typeof dungeon.blocksAt === 'function' ? dungeon : null;

    for (let j = 0; j < W; j++) {
      const wz = this.originZ + (j + 0.5) * cell;
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const wx = this.originX + (i + 0.5) * cell;
        let ok = true;
        if (tWalk) { try { ok = tWalk.isWalkable(wx, wz) !== false; } catch { ok = true; } }
        if (ok && dWalk) {
          // A dungeon that reports walkability is authoritative *inside* its
          // footprint; outside it, most implementations answer false for the
          // whole world, which would blank the tile. Trust it only when it
          // says the interior is walkable somewhere nearby.
          try { ok = dWalk.isWalkable(wx, wz) !== false; } catch { /* keep terrain answer */ }
        } else if (ok && dBlock) {
          try { ok = dBlock.isBlocked(wx, wz) !== true; } catch { /* keep */ }
        } else if (ok && dSolid) {
          try { ok = dSolid.blocksAt(wx, wz) !== true; } catch { /* keep */ }
        }
        walk[row + i] = ok ? 1 : 0;
      }
    }

    // A dungeon whose isWalkable() is world-scoped can wipe the tile out. If
    // almost nothing is walkable we clearly asked the wrong question — fall back
    // to terrain only rather than freezing every agent in place.
    if (dWalk) {
      let open = 0;
      for (let k = 0; k < walk.length; k++) open += walk[k];
      if (open < walk.length * 0.04) {
        for (let j = 0; j < W; j++) {
          const wz = this.originZ + (j + 0.5) * cell;
          const row = j * W;
          for (let i = 0; i < W; i++) {
            const wx = this.originX + (i + 0.5) * cell;
            let ok = true;
            if (tWalk) { try { ok = tWalk.isWalkable(wx, wz) !== false; } catch { ok = true; } }
            walk[row + i] = ok ? 1 : 0;
          }
        }
      }
    }

    // solid props, read back from the collision world they already feed
    this._stampSolidProps();

    // dynamic obstacles (hazards, shrines, corpses) stamped by other modules
    for (let s = 0; s < this._stamps.length; s++) {
      const st = this._stamps[s];
      this._stampNow(st.x, st.z, st.r, st.blocked);
    }

    this._distanceTransform();
    this._refineClearance();
    this.built = true;
    this.ready = true;
    this.version++;
    this._cache.clear();
    this._cacheOrder.length = 0;
    this.stats.builds++;
    this.stats.buildMs = now() - t0;
    return true;
  }

  /**
   * Two-pass chamfer distance transform (1, √2) — gives clearance in metres
   * accurate to a few percent, which is all the radius test needs, at O(n).
   */
  _distanceTransform() {
    const W = this.W, walk = this.walk, d = this.clear, cost = this.cost, cell = this.cell;
    const cap = 8 * cell;

    for (let j = 0; j < W; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const k = row + i;
        if (!walk[k]) { d[k] = 0; continue; }
        let v = FAR;
        if (i > 0) { const t = d[k - 1] + 1; if (t < v) v = t; }
        if (j > 0) {
          const t = d[k - W] + 1; if (t < v) v = t;
          if (i > 0) { const t2 = d[k - W - 1] + SQ2; if (t2 < v) v = t2; }
          if (i < W - 1) { const t3 = d[k - W + 1] + SQ2; if (t3 < v) v = t3; }
        }
        d[k] = v;
      }
    }
    for (let j = W - 1; j >= 0; j--) {
      const row = j * W;
      for (let i = W - 1; i >= 0; i--) {
        const k = row + i;
        if (!walk[k]) continue;
        let v = d[k];
        if (i < W - 1) { const t = d[k + 1] + 1; if (t < v) v = t; }
        if (j < W - 1) {
          const t = d[k + W] + 1; if (t < v) v = t;
          if (i < W - 1) { const t2 = d[k + W + 1] + SQ2; if (t2 < v) v = t2; }
          if (i > 0) { const t3 = d[k + W - 1] + SQ2; if (t3 < v) v = t3; }
        }
        d[k] = v;
      }
    }
    // to metres, capped, plus the A* corridor-centring cost
    for (let k = 0; k < d.length; k++) {
      let m = d[k] * cell;
      if (m > cap) m = cap;
      d[k] = m;
      cost[k] = wallCost(m);
    }
    this._applyTight();
  }

  /**
   * Fold the measured clearances back over the chamfer's guesses.
   *
   * Every path back into this function recomputes `clear` from `walk` alone, and
   * `addObstacle` takes one on each hazard or rescue stamp — so without this the
   * measurements survived exactly until the first stamp, after which the tight
   * gaps read as passable again and the hero went back to walking into them. The
   * probes stay valid across stamps because they measure the collision world,
   * and any change THERE rebuilds the tile outright (see `staticRevision`).
   */
  _applyTight() {
    const clear = this.clear, tight = this.tight, cost = this.cost;
    for (let k = 0; k < clear.length; k++) {
      const t = tight[k];
      if (!(t < clear[k])) continue;
      clear[k] = t;
      cost[k] = wallCost(t);
    }
  }

  /**
   * Replace the chamfer's guess near geometry with the gap the collision world
   * actually leaves. Lowers clearance only; never raises it, never edits `walk`.
   *
   * The transform above cannot express "tight". It seeds blocked cells at zero
   * and adds a whole cell per step, so its smallest non-zero answer is 0.55 m
   * however close the wall really is — which is why a measured 0.50 m slot
   * between two crypt walls read as a passable channel with 0.55 m of room. A*
   * planned through it, and the 0.68 m hero wedged in the slot while Physics
   * shoved back: a destination reachable by a longer way round looked, to the
   * pathfinder, like a short walk in a straight line.
   *
   * So ask Physics. `solveSphere` reports the deepest penetration of a probe
   * sphere, so `probe − depth` IS the distance to the nearest surface, and it
   * comes from the same boxes that stop the hero rather than from a second
   * opinion that can drift.
   *
   * Sample nine positions and keep the BEST, because the question A* needs
   * answered is "can a body get through this cell", not "does one fit dead
   * centre". The difference decides real corridors: in a 1.1 m passage both
   * cell centres sit 0.275 m off a wall, so a centre-only probe would tighten
   * the whole passage below hero width and wall off ground that is walked every
   * day — the exact overreach that, when it was `walk` being cleared instead of
   * `clear` being lowered, left brutes and ghouls standing still. Nine samples
   * keep that passage at 0.55 and still close the 0.50 m slot, where no
   * position in the cell fits.
   *
   * Only cells the transform already calls tight are probed — a thin band round
   * the walls, not all 44 100 — and only up to the widest body that has to
   * squeeze (a brute, 0.96 m). Bosses are wider still but only ever fight in
   * open rooms, where the chamfer is honest anyway.
   */
  _refineClearance() {
    const world = this._physWorld();
    if (!world || typeof world.solveSphere !== 'function' || typeof world.heightAt !== 'function') return;
    const W = this.W, cell = this.cell, walk = this.walk, clear = this.clear, tight = this.tight;
    const probe = 1.15;                       // ≥ band, so "no contact" cannot tighten
    const band = cell * 2.05;                 // 1.13 m — covers the widest squeezer
    const o = cell * 0.45;                    // how far off centre a sample may sit
    const c = this._fit;
    let tightened = 0;
    for (let j = 0; j < W; j++) {
      const wz = this.originZ + (j + 0.5) * cell;
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const k = row + i;
        if (!walk[k] || clear[k] <= 0 || clear[k] > band) continue;
        const wx = this.originX + (i + 0.5) * cell;
        /* All nine, every time. The old loop stopped at the first probe that met
           the chamfer's guess, which is enough to decide "passable" but not
           enough to say WHERE — and where is what the route needs, so a cell
           could be entered on the strength of a sample 0.25 m off centre and
           then be walked to at its centre, which is a different place. */
        let best = 0, bestS = 4;
        for (let s = 0; s < 9; s++) {
          const sx = wx + (s % 3 - 1) * o;
          const sz = wz + (((s / 3) | 0) - 1) * o;
          let gap = probe;
          try {
            const y = world.heightAt(sx, sz) + 0.95;
            if (world.solveSphere(sx, y, sz, probe, c)) gap = probe - c.depth;
          } catch { gap = probe; }
          if (gap > best) { best = gap; bestS = s; }
        }
        this.rep[k] = bestS;
        if (best >= clear[k]) continue;
        tight[k] = best < 0 ? 0 : best;
        tightened++;
      }
    }
    this._applyTight();
    this.stats.tightened = tightened;
  }

  /* ---- dynamic obstacles ---- */

  /** Stamp a circle of blocked/unblocked cells. Persists across rebuilds. */
  addObstacle(x, z, r, blocked = true) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) return;
    if (this._stamps.length < 256) this._stamps.push({ x, z, r, blocked });
    if (this.built) { this._stampNow(x, z, r, blocked); this._distanceTransform(); this.version++; this._cache.clear(); }
  }

  clearObstacles() {
    this._stamps.length = 0;
    if (this.built) this.rebuild(this.originX + this.span * 0.5, this.originZ + this.span * 0.5);
  }

  /**
   * Blocking a circle is unconditional; UNBLOCKING one may not delete
   * architecture.
   *
   * An unblock stamp means "this ground is walkable after all" — a hazard that
   * expired, or `AI._rescueNav` overriding a terrain mask that calls flat floor
   * unwalkable. Applied blindly it means something much larger, because the
   * stamp is a circle several metres across and the grid is the only record of
   * where the walls are: one 16 m rescue pocket, centred on a pack's centroid
   * that happened to average out inside a crypt wall, erased every wall around
   * it. The pathfinder then had line of sight through solid masonry, so a click
   * on the far side was answered with a straight line into the stone — the
   * player wedged against a wall the route insisted was not there.
   *
   * So consult the collision world, which is the thing that actually stops a
   * body: restore only cells something could stand in. With no collision world
   * (open field, no interior) every cell qualifies and this is the old
   * behaviour, which is what the terrain-mask rescue needs.
   */
  _stampNow(x, z, r, blocked) {
    const c = this.cell, W = this.W;
    const i0 = Math.max(0, this.ix(x - r)), i1 = Math.min(W - 1, this.ix(x + r));
    const j0 = Math.max(0, this.iz(z - r)), j1 = Math.min(W - 1, this.iz(z + r));
    const r2 = r * r;
    const world = blocked ? null : this._physWorld();
    const solid = world && typeof world.solveSphere === 'function' && typeof world.heightAt === 'function'
      ? world : null;
    for (let j = j0; j <= j1; j++) {
      const wz = this.originZ + (j + 0.5) * c;
      const row = j * W;
      for (let i = i0; i <= i1; i++) {
        const wx = this.originX + (i + 0.5) * c;
        const dx = wx - x, dz = wz - z;
        if (dx * dx + dz * dz > r2) continue;
        if (blocked) { this.walk[row + i] = 0; continue; }
        if (!solid) { this.walk[row + i] = 1; continue; }
        // Smallest thing that walks. A cell no body can occupy is not ground.
        let fits = true;
        try { fits = !solid.solveSphere(wx, solid.heightAt(wx, wz) + 0.95, wz, 0.3, this._fit); } catch { fits = true; }
        if (fits) this.walk[row + i] = 1;
      }
    }
  }

  /**
   * Stamp solid dressing — boulders, columns, sarcophagi, carts — as blocked.
   *
   * Walls reach the grid through `dungeon.isWalkable`, but props appear in no
   * walkability mask at all: they are placement records that Physics turns into
   * collision boxes. So before this pass the grid called a 1 m boulder open
   * floor, planned straight through it, and every walker — the player included —
   * ground to a halt against something the pathfinder was certain was not there.
   *
   * Read from Physics' static box soup rather than from Props directly. Its
   * boxes are already filtered through `props.blocksAt` and sized by the
   * per-kind footprint table (a dead tree's collision radius is its trunk, not
   * its canopy), so taking them at face value keeps ONE definition of "solid"
   * instead of a second copy here that would quietly drift. `K_PROP` only: wall
   * and boundary boxes are the mask we already sampled, and the boundary ring is
   * sized to Physics' own bounds, which need not match this tile.
   */
  _stampSolidProps() {
    const world = this._physWorld();
    if (!world) return;
    const x0 = this.originX, z0 = this.originZ;
    let n = 0;
    try { n = world.query(x0, z0, x0 + this.span, z0 + this.span); } catch { return; }
    /* Record the revision even with nothing to stamp: an empty tile is a valid
       answer for this revision, and leaving the field stale makes AI's "have the
       props changed?" test read true forever, rebuilding the grid every frame. */
    this.staticRevision = world.revision;
    if (!n) return;

    const hits = world.hits, boxes = world.boxes;
    const W = this.W, cell = this.cell, walk = this.walk;
    /* Blank a cell when a BODY STANDING AT ITS CENTRE would collide — the same
       question `walk` already answers for terrain, asked with a footprint. The
       tempting shortcut, blanking every cell the box touches, inflates each prop
       by up to a full cell on all four sides; measured, that grew a 0.7 m boulder
       into a 1.8 m no-go zone and walled a 2.1 m-wide brute into place, which
       renders as a statue mid-fight. Radius is the smallest walker, so the grid
       stays a statement about ground rather than about one actor. */
    const hero = this.engine.get?.('hero');
    const r = Number.isFinite(hero?.radius) ? hero.radius : 0.34;
    const r2 = r * r;
    for (let h = 0; h < n; h++) {
      const b = boxes[hits[h]];
      if (!b || b.kind !== K_PROP) continue;
      const i0 = Math.max(0, Math.floor((b.minX - r - x0) / cell));
      const i1 = Math.min(W - 1, Math.floor((b.maxX + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((b.minZ - r - z0) / cell));
      const j1 = Math.min(W - 1, Math.floor((b.maxZ + r - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const wz = z0 + (j + 0.5) * cell;
        const dz = wz < b.minZ ? b.minZ - wz : wz > b.maxZ ? wz - b.maxZ : 0;
        const row = j * W;
        for (let i = i0; i <= i1; i++) {
          const wx = x0 + (i + 0.5) * cell;
          const dx = wx < b.minX ? b.minX - wx : wx > b.maxX ? wx - b.maxX : 0;
          if (dx * dx + dz * dz < r2) walk[row + i] = 0;
        }
      }
    }
  }

  /* ================================================================ *
   * queries
   * ================================================================ */

  clearanceAt(x, z) {
    const i = this.ix(x), j = this.iz(z);
    if (!this.inside(i, j)) return 8 * this.cell;    // off-tile: assume open
    return this.clear[j * this.W + i];
  }

  /**
   * Can a disc of `radius` stand at this POINT? Off-tile answers optimistically.
   *
   * `clear[k]` is one measurement taken somewhere in the cell, so reading it as
   * the answer for every point in the cell is how a route came to be drawn
   * through a door jamb: half a metre away from where the room was measured, the
   * room is not there. Clearance is a distance-to-obstacle field, so it is
   * 1-Lipschitz — it cannot fall faster than one metre per metre travelled — and
   * that gives a lower bound on the room here for free, with no extra probing.
   * Costing the walk from the measured point is what makes this a question about
   * a point rather than about a cell.
   */
  isFree(x, z, radius = 0.4) {
    const i = this.ix(x), j = this.iz(z);
    if (!this.inside(i, j)) return true;
    const k = j * this.W + i;
    if (!this.walk[k]) return false;
    const dx = x - this.repX(k), dz = z - this.repZ(k);
    const here = this.clear[k] - Math.sqrt(dx * dx + dz * dz);
    return here >= Math.min(radius, 7 * this.cell) - 1e-4;
  }

  /**
   * Supercover DDA visibility test with a radius. This is the string-pulling
   * primitive and the LOS primitive; both need "could a disc of r slide along
   * this segment", not "does an infinitely thin ray hit a wall".
   */
  lineOfSight(ax, az, bx, bz, radius = 0.25) {
    const c = this.cell;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return this.isFree(ax, az, radius);
    // sample at half-cell steps: with the clearance field a half-cell step
    // cannot skip an obstacle thicker than one cell, and thinner walls do not
    // exist in the grid by construction.
    const steps = Math.max(2, Math.ceil(len / (c * 0.5)));
    const inv = 1 / steps;
    for (let s = 0; s <= steps; s++) {
      const t = s * inv;
      if (!this.isFree(ax + dx * t, az + dz * t, radius)) return false;
    }
    return true;
  }

  /** Nearest standable point for a disc of `radius`, spiral search. */
  nearestFree(x, z, radius = 0.4, maxR = 6, out = null) {
    const o = out ?? { x, z, found: false };
    o.x = x; o.z = z; o.found = false;
    if (this.isFree(x, z, radius)) { o.found = true; return o; }
    const c = this.cell;
    const rings = Math.max(1, Math.ceil(maxR / c));
    const i0 = this.ix(x), j0 = this.iz(z);
    for (let r = 1; r <= rings; r++) {
      let best = -1, bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        const ar = r - Math.abs(dj);
        for (let s = -1; s <= 1; s += 2) {
          const di = s * ar;
          if (ar === 0 && s > 0) continue;
          const i = i0 + di, j = j0 + dj;
          if (!this.inside(i, j)) continue;
          const k = j * this.W + i;
          if (!this.walk[k] || this.clear[k] < radius - 1e-4) continue;
          const wx = this.repX(k), wz = this.repZ(k);
          const d = (wx - x) * (wx - x) + (wz - z) * (wz - z);
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      if (best >= 0) {
        o.x = this.repX(best);
        o.z = this.repZ(best);
        o.found = true;
        return o;
      }
    }
    return o;
  }

  /* ================================================================ *
   * A*
   * ================================================================ */

  /**
   * @param {number} sx @param {number} sz start (world)
   * @param {number} gx @param {number} gz goal  (world)
   * @param {number} radius agent radius
   * @param {number[]} out flat [x,z,x,z,...] destination, cleared on success
   * @returns {'direct'|'ok'|'partial'|'deferred'|'fail'}
   */
  findPath(sx, sz, gx, gz, radius, out) {
    if (!this.built) return 'fail';
    const r = Math.max(0.12, Math.min(radius, 7 * this.cell));

    // 1. straight shot — by far the most common case in an arena fight
    if (this.lineOfSight(sx, sz, gx, gz, r)) {
      out.length = 0;
      out.push(sx, sz, gx, gz);
      return 'direct';
    }

    // 2. cache
    const key = this._cacheKey(sx, sz, gx, gz, r);
    const hit = this._cache.get(key);
    if (hit && this.engine.clock.elapsed - hit.t < 1.6 && hit.v === this.version) {
      out.length = 0;
      for (let i = 0; i < hit.p.length; i++) out.push(hit.p[i]);
      this.stats.cacheHits++;
      return hit.s;
    }

    // 3. budget gate — only N agents may run A* per frame
    if (this.nodeBudget <= 0) { this.stats.deferred++; return 'deferred'; }

    const s = this.nearestFree(sx, sz, r, 4, _nf1);
    const g = this.nearestFree(gx, gz, r, 6, _nf2);
    if (!s.found || !g.found) return 'fail';

    const status = this._astar(s.x, s.z, g.x, g.z, r, out);
    if (status === 'ok' || status === 'partial') {
      const copy = out.slice();
      this._cache.set(key, { p: copy, t: this.engine.clock.elapsed, v: this.version, s: status });
      this._cacheOrder.push(key);
      while (this._cacheOrder.length > 192) {
        const old = this._cacheOrder.shift();
        if (old !== key) this._cache.delete(old);
      }
    }
    return status;
  }

  /**
   * Guarantee `n` expansions for one query that matters more than the pack's.
   *
   * The per-frame budget is shared and deliberately small, which is right for
   * thirty monsters re-routing at a target that moved half a metre and wrong for
   * the player's click: a route the long way round a crypt wall cost 2814
   * expansions, more than a whole frame's allowance, so the hero's ask came back
   * `partial` every time, aimed at the closest point on the wrong side of the
   * wall, and the walk ended against the stone. One agent asking at most every
   * sixth frame can afford to jump the queue.
   */
  reserve(n) {
    if (this.nodeBudget < n) this.nodeBudget = n;
  }

  _cacheKey(sx, sz, gx, gz, r) {
    // quantise to 2 m so a pack converging on the same target shares one path
    const q = 0.5;
    const si = Math.round(sx * q), sj = Math.round(sz * q);
    const gi = Math.round(gx * q), gj = Math.round(gz * q);
    const rb = r < 0.55 ? 0 : r < 1.1 ? 1 : 2;
    return (((si & 1023) << 22) ^ ((sj & 1023) << 12) ^ ((gi & 1023) << 2) ^ (gj & 1023)) * 4 + rb;
  }

  _astar(sx, sz, gx, gz, radius, out) {
    const W = this.W, walk = this.walk, clear = this.clear, cost = this.cost, cell = this.cell;
    const si = this.ix(sx), sj = this.iz(sz);
    const gi = this.ix(gx), gj = this.iz(gz);
    if (!this.inside(si, sj) || !this.inside(gi, gj)) return 'fail';
    const start = sj * W + si, goal = gj * W + gi;
    if (start === goal) { out.length = 0; out.push(sx, sz, gx, gz); return 'ok'; }

    const gen = ++this._gen;
    const g = this._g, f = this._f, from = this._from, stamp = this._stamp, closed = this._closed;
    this._heapN = 0;

    const limit = Math.min(this.nodeBudget, 4200);
    const rMin = radius - 1e-4;

    stamp[start] = gen; closed[start] = 0;
    g[start] = 0;
    f[start] = octile(si - gi, sj - gj) * cell;
    this._push(start, f[start]);

    let expansions = 0;
    let bestNode = start, bestH = f[start];
    let found = false;

    while (this._heapN > 0) {
      const cur = this._pop();
      if (closed[cur] === 1 && stamp[cur] === gen) continue;
      closed[cur] = 1; stamp[cur] = gen;
      if (cur === goal) { found = true; break; }
      if (++expansions > limit) break;

      const ci = cur % W, cj = (cur / W) | 0;
      const gc = g[cur];

      for (let d = 0; d < 8; d++) {
        const ni = ci + NX[d], nj = cj + NZ[d];
        if (ni < 0 || nj < 0 || ni >= W || nj >= W) continue;
        const nk = nj * W + ni;
        if (!walk[nk] || clear[nk] < rMin) continue;
        if (d >= 4) {
          // no corner cutting: both orthogonal neighbours must be passable
          const a = cj * W + ni, b = nj * W + ci;
          if (!walk[a] || clear[a] < rMin || !walk[b] || clear[b] < rMin) continue;
        }
        const step = (d >= 4 ? SQ2 : 1) * cell * cost[nk];
        const ng = gc + step;
        if (stamp[nk] === gen) {
          if (closed[nk] === 1 || ng >= g[nk] - 1e-6) continue;
        } else {
          stamp[nk] = gen; closed[nk] = 0;
        }
        g[nk] = ng;
        from[nk] = cur;
        const h = octile(ni - gi, nj - gj) * cell;
        // 1.06 weight: a hair of greediness cuts expansions ~40 % and the
        // string-pull pass hides the sub-optimality entirely.
        f[nk] = ng + h * 1.06;
        this._push(nk, f[nk]);
        if (h < bestH) { bestH = h; bestNode = nk; }
      }
    }

    this.nodeBudget -= expansions;
    this.stats.astar++;
    this.stats.expansions += expansions;

    const end = found ? goal : bestNode;
    if (!found && end === start) return 'fail';

    // reconstruct backwards into scratch, then reverse
    const raw = this._scratchA;
    let n = 0;
    let k = end;
    let guard = 0;
    while (guard++ < 8192) {
      raw[n * 2] = this.repX(k);
      raw[n * 2 + 1] = this.repZ(k);
      n++;
      if (k === start || n * 2 + 2 >= raw.length) break;
      k = from[k];
      if (stamp[k] !== gen) break;
    }
    // reverse in place
    for (let a = 0, b = n - 1; a < b; a++, b--) {
      const x0 = raw[a * 2], z0 = raw[a * 2 + 1];
      raw[a * 2] = raw[b * 2]; raw[a * 2 + 1] = raw[b * 2 + 1];
      raw[b * 2] = x0; raw[b * 2 + 1] = z0;
    }
    // exact endpoints beat cell centres
    raw[0] = sx; raw[1] = sz;
    if (found) { raw[(n - 1) * 2] = gx; raw[(n - 1) * 2 + 1] = gz; }

    this._smooth(raw, n, radius, out);
    return found ? 'ok' : 'partial';
  }

  /**
   * String-pulling + a validated corner round-off.
   *
   * Pass 1 is greedy furthest-visible (this is what removes the staircase).
   * Pass 2 chamfers each remaining corner by inserting two points at 22 % along
   * the incoming and outgoing legs, keeping them only if the shortcut is still
   * clear for the agent's radius. The result is a polyline that curves through
   * doorways instead of clipping the jamb, which is the whole visual point.
   */
  _smooth(raw, n, radius, out) {
    const r = Math.max(0.12, radius);
    const pulled = this._scratchB;
    let m = 0;
    pulled[0] = raw[0]; pulled[1] = raw[1]; m = 1;

    let i = 0;
    while (i < n - 1) {
      let j = n - 1;
      // furthest visible vertex from i
      while (j > i + 1 && !this.lineOfSight(raw[i * 2], raw[i * 2 + 1], raw[j * 2], raw[j * 2 + 1], r)) j--;
      pulled[m * 2] = raw[j * 2];
      pulled[m * 2 + 1] = raw[j * 2 + 1];
      m++;
      if (m * 2 + 4 >= pulled.length) break;
      i = j;
    }

    out.length = 0;
    if (m <= 2) {
      for (let k = 0; k < m; k++) out.push(pulled[k * 2], pulled[k * 2 + 1]);
      if (out.length < 4) out.push(pulled[(m - 1) * 2], pulled[(m - 1) * 2 + 1]);
      return;
    }

    out.push(pulled[0], pulled[1]);
    for (let k = 1; k < m - 1; k++) {
      const px = pulled[(k - 1) * 2], pz = pulled[(k - 1) * 2 + 1];
      const cxp = pulled[k * 2], czp = pulled[k * 2 + 1];
      const nx = pulled[(k + 1) * 2], nz = pulled[(k + 1) * 2 + 1];
      const l0 = Math.hypot(cxp - px, czp - pz);
      const l1 = Math.hypot(nx - cxp, nz - czp);
      const t0 = Math.min(0.34, 1.1 / Math.max(0.2, l0));
      const t1 = Math.min(0.34, 1.1 / Math.max(0.2, l1));
      const ax = cxp + (px - cxp) * t0, az = czp + (pz - czp) * t0;
      const bx = cxp + (nx - cxp) * t1, bz = czp + (nz - czp) * t1;
      if (l0 > 0.9 && l1 > 0.9 && this.lineOfSight(ax, az, bx, bz, r)) {
        out.push(ax, az, bx, bz);
      } else {
        out.push(cxp, czp);
      }
    }
    out.push(pulled[(m - 1) * 2], pulled[(m - 1) * 2 + 1]);
  }

  /* ---- heap ---- */

  _push(node, key) {
    let i = ++this._heapN;
    const idx = this._heapIdx, k = this._heapKey;
    if (i >= idx.length) { this._heapN--; return; }
    idx[i] = node; k[i] = key;
    while (i > 1) {
      const p = i >> 1;
      if (k[p] <= k[i]) break;
      const ti = idx[p], tk = k[p];
      idx[p] = idx[i]; k[p] = k[i];
      idx[i] = ti; k[i] = tk;
      i = p;
    }
  }

  _pop() {
    const idx = this._heapIdx, k = this._heapKey;
    const top = idx[1];
    idx[1] = idx[this._heapN]; k[1] = k[this._heapN];
    this._heapN--;
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let s = i;
      if (l <= this._heapN && k[l] < k[s]) s = l;
      if (r <= this._heapN && k[r] < k[s]) s = r;
      if (s === i) break;
      const ti = idx[s], tk = k[s];
      idx[s] = idx[i]; k[s] = k[i];
      idx[i] = ti; k[i] = tk;
      i = s;
    }
    return top;
  }

  /* ---- module lookups (both optional) ---- */

  _terrain() {
    const t = this.engine.get?.('terrain');
    return t && !t.__dead ? t : null;
  }
  _dungeon() {
    const d = this.engine.get?.('dungeon');
    return d && !d.__dead ? d : null;
  }
  _physWorld() {
    const p = this.engine.get?.('physics');
    const w = p && !p.__dead ? p.world : null;
    return w && typeof w.query === 'function' && Array.isArray(w.boxes) ? w : null;
  }

  /** Debug: walkable-boundary segments near a point, for the AI overlay. */
  boundarySegments(cxw, czw, halfExtent, outSegs, maxSegs = 2400) {
    if (!this.built) return 0;
    const W = this.W, walk = this.walk;
    const i0 = Math.max(1, this.ix(cxw - halfExtent)), i1 = Math.min(W - 2, this.ix(cxw + halfExtent));
    const j0 = Math.max(1, this.iz(czw - halfExtent)), j1 = Math.min(W - 2, this.iz(czw + halfExtent));
    const c = this.cell, h = c * 0.5;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const row = j * W;
      for (let i = i0; i <= i1; i++) {
        if (!walk[row + i]) continue;
        const x = this.cx(i), z = this.cz(j);
        if (!walk[row + i + 1]) { outSegs[n++] = x + h; outSegs[n++] = z - h; outSegs[n++] = x + h; outSegs[n++] = z + h; }
        if (!walk[row + i - 1]) { outSegs[n++] = x - h; outSegs[n++] = z - h; outSegs[n++] = x - h; outSegs[n++] = z + h; }
        if (!walk[row + W + i]) { outSegs[n++] = x - h; outSegs[n++] = z + h; outSegs[n++] = x + h; outSegs[n++] = z + h; }
        if (!walk[row - W + i]) { outSegs[n++] = x - h; outSegs[n++] = z - h; outSegs[n++] = x + h; outSegs[n++] = z - h; }
        if (n >= maxSegs * 4) return n >> 2;
      }
    }
    return n >> 2;
  }

  dispose() {
    this._cache.clear();
    this._cacheOrder.length = 0;
    this._stamps.length = 0;
    this.built = false;
    this.ready = false;
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NZ = [0, 0, 1, -1, 1, -1, 1, -1];

function octile(dx, dz) {
  const ax = dx < 0 ? -dx : dx, az = dz < 0 ? -dz : dz;
  return ax > az ? ax + (SQ2 - 1) * az : az + (SQ2 - 1) * ax;
}

const _nf1 = { x: 0, z: 0, found: false };
const _nf2 = { x: 0, z: 0, found: false };

/** Wall-clock, profiling only — never fed back into the simulation. */
function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}
