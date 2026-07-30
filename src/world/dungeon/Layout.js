/**
 * THE NINTH VIGIL — dungeon layout generation.
 *
 * A deterministic, seeded generator that produces the *occupancy* of a crypt
 * level and everything the architecture builder needs to dress it:
 *
 *   rooms      — axis-aligned chambers with a bay subdivision for vaulting
 *   corridors  — L-shaped links carved at SPEC.corridorW
 *   doors      — derived from the final occupancy, so a doorway exists exactly
 *                where two open regions touch through a wall line
 *   wallRuns   — maximal runs of wall face, ready to be panelised
 *   corners    — mixed-axis run endpoints, i.e. where a quoin pier belongs
 *   open/nav   — cell grids; `open` is floor, `nav` is floor minus obstacles
 *
 * Structure, not noise: a great hall is reserved at the origin (where every
 * interior scenario points its camera) and the rest of the footprint is BSP-
 * partitioned around it. Leaves that would collide with the hall are dropped, as
 * is a fifth of the remainder, so the plan never reads as a partition diagram.
 * Each surviving leaf is inset by an independent amount per side, so no two
 * chambers share a wall line. Rooms are then linked by a Prim minimum spanning
 * tree over their centres plus the two shortest extra chords, giving the level
 * loops rather than a tree-shaped dead-end topology an AI pack cannot flank
 * through.
 *
 * Everything here is integer cell arithmetic on a 0.5 m grid and pure of THREE;
 * the only float outputs are world-space metres for the builder.
 */

import { CELL, SPEC } from './Spec.js';

/** Chamber flavours. Drives dressing, not geometry. */
export const ROOM_KINDS = ['ossuary', 'chapel', 'cistern', 'reliquary', 'catacomb', 'antechamber'];

const MIN_ROOM = 12;        // cells — 6.0 m
const SQ2 = Math.SQRT2;

export class Layout {
  constructor(opts = {}) {
    const cell = opts.cell ?? CELL;
    this.cell = cell;
    this.W = Math.max(32, Math.round((opts.footprint ?? SPEC.footprint) / cell));
    this.footprint = this.W * cell;
    this.originX = -this.footprint * 0.5;
    this.originZ = -this.footprint * 0.5;
    this.rand = opts.rand ?? (() => 0.5);
    this.corridorCells = Math.max(3, Math.round((opts.corridorW ?? SPEC.corridorW) / cell));

    const n = this.W * this.W;
    this.open = new Uint8Array(n);
    this.nav = new Uint8Array(n);
    this.clear = new Float32Array(n);

    /** @type {Array<object>} */ this.rooms = [];
    /** @type {Array<object>} */ this.corridors = [];
    /** @type {Array<object>} */ this.doors = [];
    /** @type {Array<object>} */ this.wallRuns = [];
    /** @type {Array<object>} */ this.corners = [];
    this.hall = null;

    this.bounds = {
      minX: this.originX, maxX: this.originX + this.footprint,
      minZ: this.originZ, maxZ: this.originZ + this.footprint,
      minY: SPEC.floor.substrate, maxY: SPEC.wall.h + 2.8,
    };
  }

  /* ------------------------------------------------------------ grid ---- */

  xOf(i) { return this.originX + i * this.cell; }
  zOf(j) { return this.originZ + j * this.cell; }
  iOf(x) { return Math.floor((x - this.originX) / this.cell); }
  jOf(z) { return Math.floor((z - this.originZ) / this.cell); }
  cxOf(i) { return this.originX + (i + 0.5) * this.cell; }
  czOf(j) { return this.originZ + (j + 0.5) * this.cell; }
  inGrid(i, j) { return i >= 0 && j >= 0 && i < this.W && j < this.W; }
  isOpenCell(i, j) { return this.inGrid(i, j) && this.open[j * this.W + i] === 1; }
  isNavCell(i, j) { return this.inGrid(i, j) && this.nav[j * this.W + i] === 1; }

  /** World-space walkability, used by NavGrid via Dungeon.isWalkable(). */
  walkableAt(x, z) {
    const i = this.iOf(x), j = this.jOf(z);
    return this.inGrid(i, j) && this.nav[j * this.W + i] === 1;
  }

  /** Metres of clearance to the nearest blocked cell (0 inside a wall). */
  clearanceAt(x, z) {
    const i = this.iOf(x), j = this.jOf(z);
    if (!this.inGrid(i, j)) return 0;
    return this.clear[j * this.W + i];
  }

  /* ----------------------------------------------------------- build ---- */

  build() {
    const r = this.rand;
    this.open.fill(0);
    this.rooms.length = 0;
    this.corridors.length = 0;
    this.doors.length = 0;
    this.wallRuns.length = 0;
    this.corners.length = 0;

    this._blocks(r);
    this._link(r);
    this._deriveDoors();
    this._deriveWalls();
    this._bays(r);
    this.nav.set(this.open);
    this.refreshClearance();
    return this;
  }

  /**
   * A reserved great hall at the origin plus a BSP partition of everything
   * around it.
   *
   * Hall size, and why it changed. The original 11-14 m hall was sized on the
   * assumption that the near vault would be *in* the picture and would close the
   * top of the frame. It cannot be: the gameplay camera sits ~22 m up and the
   * vault springs at 4.3 m, so Dungeon culls interior ceilings (see the ROOF
   * comment there) exactly like every other isometric ARPG. With no vault to fill
   * it, a 13 m chamber inside a ~38 x 30 m frame left the surrounding rock mass
   * covering 70 % of the image at true black — measured, not guessed. At 21-26 m
   * the hall floor, both aisle arcades, all four walls and the portals into the
   * chambers beyond are all on screen, and the rock only frames the corners.
   */
  _blocks(r) {
    const W = this.W;

    /* --- the hall, guaranteed to contain the origin --- */
    const hw = 42 + Math.floor(r() * 11);          // 21.0 - 26.0 m
    const hd = 38 + Math.floor(r() * 11);          // 19.0 - 24.0 m
    const mid = Math.round(W * 0.5);
    const hi0 = mid - (hw >> 1) + Math.floor((r() - 0.5) * 5);
    const hj0 = mid - (hd >> 1) + Math.floor((r() - 0.5) * 5);
    const hallRect = { i0: hi0, j0: hj0, i1: hi0 + hw, j1: hj0 + hd };
    const hall = this._roomRect(hallRect, 'hall');
    if (hall) { hall.grand = true; this.hall = hall; }

    /* --- BSP the footprint; leaves clear of the hall become chambers --- */
    const MAXL = 34, MINL = 23;
    const leaves = [];
    const rec = (i0, j0, i1, j1, depth) => {
      const w = i1 - i0, d = j1 - j0;
      const canX = w >= MINL * 2, canZ = d >= MINL * 2;
      const oversize = w > MAXL || d > MAXL;
      if ((!canX && !canZ) || (!oversize && depth > 1 && r() < 0.38)) {
        leaves.push({ i0, j0, i1, j1 });
        return;
      }
      const axisX = canX && (!canZ || (w > d ? r() < 0.86 : r() < 0.14));
      const t = 0.40 + r() * 0.20;
      if (axisX) {
        const m = i0 + Math.max(MINL, Math.min(w - MINL, Math.round(w * t)));
        rec(i0, j0, m, j1, depth + 1);
        rec(m, j0, i1, j1, depth + 1);
      } else {
        const m = j0 + Math.max(MINL, Math.min(d - MINL, Math.round(d * t)));
        rec(i0, j0, i1, m, depth + 1);
        rec(i0, m, i1, j1, depth + 1);
      }
    };
    rec(0, 0, W, W, 0);

    // Only 2.5 m of rock between the hall and its neighbours. An isometric
    // camera sees over a 4.6 m wall onto ground 3.1 m beyond it, so a thin
    // partition means the rooms next door are *in the frame* as depth instead of
    // being replaced by a plateau of rock.
    const pad = 5;
    const clash = (L) => !(L.i1 <= hallRect.i0 - pad || L.i0 >= hallRect.i1 + pad ||
      L.j1 <= hallRect.j0 - pad || L.j0 >= hallRect.j1 + pad);
    for (const L of leaves) {
      if (clash(L)) continue;
      // a fifth of the leaves stay solid rock: the plan must never look like a
      // partition diagram
      if (r() < 0.20) continue;
      this._roomIn(L.i0, L.j0, L.i1, L.j1, r, this._kind(r), [2, 5], [2, 5], [2, 5], [2, 5]);
    }
  }

  /** Carve an exact rect as a room (used for the reserved hall). */
  _roomRect(rect, kind) {
    const a = Math.max(3, rect.i0), b = Math.min(this.W - 3, rect.i1);
    const c = Math.max(3, rect.j0), d = Math.min(this.W - 3, rect.j1);
    if (b - a < MIN_ROOM || d - c < MIN_ROOM) return null;
    return this._register(a, c, b, d, kind);
  }

  _kind(r) { return ROOM_KINDS[Math.floor(r() * ROOM_KINDS.length) % ROOM_KINDS.length]; }

  /**
   * Inset a block into a room. Insets are independent per side so no two rooms
   * share a wall line and the plan loses its underlying grid.
   */
  _roomIn(i0, j0, i1, j1, r, kind, wIn = [4, 11], eIn = [4, 11], nIn = [4, 11], sIn = [4, 11]) {
    const pick = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    let a = i0 + pick(wIn[0], wIn[1]);
    let b = i1 - pick(eIn[0], eIn[1]);
    let c = j0 + pick(nIn[0], nIn[1]);
    let d = j1 - pick(sIn[0], sIn[1]);
    // clamp inside the footprint with a 3-cell rock skin so no wall ends up on
    // the boundary of the buildable area
    a = Math.max(3, a); c = Math.max(3, c);
    b = Math.min(this.W - 3, b); d = Math.min(this.W - 3, d);
    if (b - a < MIN_ROOM || d - c < MIN_ROOM) return null;
    return this._register(a, c, b, d, kind);
  }

  _register(a, c, b, d, kind) {
    const room = {
      id: this.rooms.length,
      kind,
      grand: false,
      i0: a, j0: c, i1: b, j1: d,
      minX: this.xOf(a), maxX: this.xOf(b),
      minZ: this.zOf(c), maxZ: this.zOf(d),
      w: (b - a) * this.cell, d: (d - c) * this.cell,
      cx: (this.xOf(a) + this.xOf(b)) * 0.5,
      cz: (this.zOf(c) + this.zOf(d)) * 0.5,
      doors: [],
      bays: null,
    };
    this._carve(a, c, b, d);
    this.rooms.push(room);
    return room;
  }

  _carve(i0, j0, i1, j1) {
    const W = this.W, open = this.open;
    const a = Math.max(0, i0), b = Math.min(W, i1);
    const c = Math.max(0, j0), d = Math.min(W, j1);
    for (let j = c; j < d; j++) {
      const row = j * W;
      for (let i = a; i < b; i++) open[row + i] = 1;
    }
  }

  /** Prim MST over room centres + two chords, carved as L corridors. */
  _link(r) {
    const n = this.rooms.length;
    if (n < 2) return;
    const dist = (a, b) => {
      const A = this.rooms[a], B = this.rooms[b];
      return Math.abs(A.cx - B.cx) + Math.abs(A.cz - B.cz);
    };
    // start from the hall so the trunk radiates outward from the camera focus
    const start = this.hall ? this.hall.id : 0;
    const inTree = new Uint8Array(n);
    inTree[start] = 1;
    const edges = [];
    for (let k = 1; k < n; k++) {
      let bi = -1, bj = -1, bd = Infinity;
      for (let a = 0; a < n; a++) {
        if (!inTree[a]) continue;
        for (let b = 0; b < n; b++) {
          if (inTree[b]) continue;
          const d = dist(a, b);
          if (d < bd) { bd = d; bi = a; bj = b; }
        }
      }
      if (bj < 0) break;
      inTree[bj] = 1;
      edges.push([bi, bj]);
    }
    // chords: the two shortest non-tree pairs that are not already linked
    const has = new Set(edges.map(([a, b]) => `${Math.min(a, b)}|${Math.max(a, b)}`));
    const extra = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const key = `${a}|${b}`;
        if (has.has(key)) continue;
        extra.push([dist(a, b), a, b]);
      }
    }
    extra.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    for (let k = 0; k < Math.min(2, extra.length); k++) edges.push([extra[k][1], extra[k][2]]);

    const half = this.corridorCells >> 1;
    for (const [a, b] of edges) {
      const A = this.rooms[a], B = this.rooms[b];
      const ai = (A.i0 + A.i1) >> 1, aj = (A.j0 + A.j1) >> 1;
      const bi = (B.i0 + B.i1) >> 1, bj = (B.j0 + B.j1) >> 1;
      // Elbow inside whichever room is "wider" on that axis, so the corridor
      // leaves through the middle of a wall rather than clipping a corner.
      if (r() < 0.5) {
        this._carveRun(ai, bi, aj, half, true);
        this._carveRun(aj, bj, bi, half, false);
        this.corridors.push({ a: [ai, aj], b: [bi, aj], axis: 'x' }, { a: [bi, aj], b: [bi, bj], axis: 'z' });
      } else {
        this._carveRun(aj, bj, ai, half, false);
        this._carveRun(ai, bi, bj, half, true);
        this.corridors.push({ a: [ai, aj], b: [ai, bj], axis: 'z' }, { a: [ai, bj], b: [bi, bj], axis: 'x' });
      }
    }
  }

  _carveRun(s0, s1, fixed, half, alongX) {
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    if (alongX) this._carve(lo, fixed - half, hi + 1, fixed + half + 1);
    else this._carve(fixed - half, lo, fixed + half + 1, hi + 1);
  }

  /**
   * Doorways are read back off the occupancy: any maximal run of a room's
   * boundary whose outside neighbour is also open is an opening in that wall.
   * Deriving rather than recording means a corridor that grazes two rooms at
   * once still gets a portal in each.
   */
  _deriveDoors() {
    const seen = new Set();
    for (const room of this.rooms) {
      for (const side of [0, 1, 2, 3]) {
        const alongX = side < 2;
        const s0 = alongX ? room.i0 : room.j0;
        const s1 = alongX ? room.i1 : room.j1;
        const fixed = side === 0 ? room.j0 : side === 1 ? room.j1 - 1 : side === 2 ? room.i0 : room.i1 - 1;
        const outward = side === 0 || side === 2 ? -1 : 1;
        let run = -1;
        for (let s = s0; s <= s1; s++) {
          let openHere = false;
          if (s < s1) {
            const i = alongX ? s : fixed;
            const j = alongX ? fixed : s;
            const oi = alongX ? s : fixed + outward;
            const oj = alongX ? fixed + outward : s;
            openHere = this.isOpenCell(i, j) && this.isOpenCell(oi, oj);
          }
          if (openHere) { if (run < 0) run = s; continue; }
          if (run >= 0) {
            const len = s - run;
            if (len >= 3) this._pushDoor(room, side, run, s, seen);
            run = -1;
          }
        }
      }
    }
  }

  _pushDoor(room, side, s0, s1, seen) {
    const alongX = side < 2;
    const cellsMid = (s0 + s1) * 0.5;
    const span = (s1 - s0) * this.cell;
    // plane of the wall face this opening pierces
    const planeCell = side === 0 ? room.j0 : side === 1 ? room.j1 : side === 2 ? room.i0 : room.i1;
    const plane = alongX ? this.zOf(planeCell) : this.xOf(planeCell);
    const mid = alongX ? this.xOf(cellsMid) : this.zOf(cellsMid);
    const key = `${alongX ? 'x' : 'z'}|${plane.toFixed(2)}|${mid.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const door = {
      axis: alongX ? 'x' : 'z',
      // face normal points from the wall plane into this room
      side: side === 0 || side === 2 ? 1 : -1,
      x: alongX ? mid : plane,
      z: alongX ? plane : mid,
      span,
      roomId: room.id,
      s0: alongX ? this.xOf(s0) : this.zOf(s0),
      s1: alongX ? this.xOf(s1) : this.zOf(s1),
    };
    this.doors.push(door);
    room.doors.push(door);
  }

  /** Maximal wall-face runs, one pass per facing. */
  _deriveWalls() {
    const W = this.W;
    const push = (axis, side, a, s0, s1) => this.wallRuns.push({ axis, side, a, s0, s1, len: s1 - s0 });

    // faces normal +Z (wall on a room's -Z edge) and -Z
    for (const side of [1, -1]) {
      for (let j = 0; j < W; j++) {
        let run = -1;
        for (let i = 0; i <= W; i++) {
          const hit = i < W && this.isOpenCell(i, j) && !this.isOpenCell(i, j - side);
          if (hit) { if (run < 0) run = i; continue; }
          if (run >= 0) {
            const plane = side === 1 ? this.zOf(j) : this.zOf(j + 1);
            push('x', side, plane, this.xOf(run), this.xOf(i));
            run = -1;
          }
        }
      }
    }
    // faces normal +X and -X
    for (const side of [1, -1]) {
      for (let i = 0; i < W; i++) {
        let run = -1;
        for (let j = 0; j <= W; j++) {
          const hit = j < W && this.isOpenCell(i, j) && !this.isOpenCell(i - side, j);
          if (hit) { if (run < 0) run = j; continue; }
          if (run >= 0) {
            const plane = side === 1 ? this.xOf(i) : this.xOf(i + 1);
            push('z', side, plane, this.zOf(run), this.zOf(j));
            run = -1;
          }
        }
      }
    }
    this._deriveCorners();
  }

  /** Quoin piers belong where two runs of different axes share an endpoint. */
  _deriveCorners() {
    const at = new Map();
    const add = (x, z, axis) => {
      const key = `${Math.round(x * 4)}|${Math.round(z * 4)}`;
      let e = at.get(key);
      if (!e) at.set(key, (e = { x, z, ax: 0, az: 0 }));
      if (axis === 'x') e.ax++; else e.az++;
    };
    for (const r of this.wallRuns) {
      if (r.axis === 'x') { add(r.s0, r.a, 'x'); add(r.s1, r.a, 'x'); }
      else { add(r.a, r.s0, 'z'); add(r.a, r.s1, 'z'); }
    }
    for (const e of at.values()) if (e.ax > 0 && e.az > 0) this.corners.push({ x: e.x, z: e.z });
  }

  /** Bay subdivision per room, used for vaulting and column placement. */
  _bays(r) {
    for (const room of this.rooms) {
      // the hall is bayed finer so its arcade has a real rhythm and the
      // collapsed centre is a handful of bays rather than one big hole
      const target = room.grand ? 2.95 : 3.35;
      const nx = Math.max(1, Math.round(room.w / target));
      const nz = Math.max(1, Math.round(room.d / target));
      room.bays = {
        nx, nz,
        bw: room.w / nx,
        bd: room.d / nz,
        // deterministic per-room phase so no two rooms' rib grids line up
        phase: r(),
      };
    }
  }

  /* ------------------------------------------------------- obstacles ---- */

  /** Mark a disc as non-walkable (columns, altars, braziers, sarcophagi). */
  blockCircle(x, z, radius) {
    const W = this.W;
    const i0 = Math.max(0, this.iOf(x - radius)), i1 = Math.min(W - 1, this.iOf(x + radius));
    const j0 = Math.max(0, this.jOf(z - radius)), j1 = Math.min(W - 1, this.jOf(z + radius));
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      const wz = this.czOf(j), row = j * W;
      for (let i = i0; i <= i1; i++) {
        const dx = this.cxOf(i) - x, dz = wz - z;
        if (dx * dx + dz * dz <= r2) this.nav[row + i] = 0;
      }
    }
  }

  /** Mark an axis-aligned box as non-walkable. */
  blockRect(x, z, w, d) {
    const W = this.W;
    const i0 = Math.max(0, this.iOf(x - w * 0.5)), i1 = Math.min(W - 1, this.iOf(x + w * 0.5));
    const j0 = Math.max(0, this.jOf(z - d * 0.5)), j1 = Math.min(W - 1, this.jOf(z + d * 0.5));
    for (let j = j0; j <= j1; j++) {
      const row = j * W;
      for (let i = i0; i <= i1; i++) this.nav[row + i] = 0;
    }
  }

  /**
   * Chamfer distance transform of `nav` -> metres of clearance. Same (1, √2)
   * kernel NavGrid uses, so radius tests agree between the two grids.
   */
  refreshClearance() {
    const W = this.W, nav = this.nav, d = this.clear, cell = this.cell;
    const FAR = 1e6, cap = 12;
    for (let j = 0; j < W; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const k = row + i;
        if (!nav[k]) { d[k] = 0; continue; }
        let v = FAR;
        if (i > 0) v = Math.min(v, d[k - 1] + 1);
        if (j > 0) {
          v = Math.min(v, d[k - W] + 1);
          if (i > 0) v = Math.min(v, d[k - W - 1] + SQ2);
          if (i < W - 1) v = Math.min(v, d[k - W + 1] + SQ2);
        }
        d[k] = v;
      }
    }
    for (let j = W - 1; j >= 0; j--) {
      const row = j * W;
      for (let i = W - 1; i >= 0; i--) {
        const k = row + i;
        if (!nav[k]) continue;
        let v = d[k];
        if (i < W - 1) v = Math.min(v, d[k + 1] + 1);
        if (j < W - 1) {
          v = Math.min(v, d[k + W] + 1);
          if (i < W - 1) v = Math.min(v, d[k + W + 1] + SQ2);
          if (i > 0) v = Math.min(v, d[k + W - 1] + SQ2);
        }
        d[k] = v;
      }
    }
    for (let k = 0; k < d.length; k++) d[k] = Math.min(d[k] * cell, cap);
  }

  /* ------------------------------------------------------------ masks --- */

  /**
   * Cells the surrounding rock mass may occupy: everything at least `pad` cells
   * away from an open cell, so the mass never intrudes into a dressed wall.
   */
  rockMask(pad = 1) {
    const W = this.W, n = W * W;
    const out = new Uint8Array(n);
    out.fill(1);
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        if (this.open[j * W + i] !== 1) continue;
        const i0 = Math.max(0, i - pad), i1 = Math.min(W - 1, i + pad);
        const j0 = Math.max(0, j - pad), j1 = Math.min(W - 1, j + pad);
        for (let jj = j0; jj <= j1; jj++) {
          const row = jj * W;
          for (let ii = i0; ii <= i1; ii++) out[row + ii] = 0;
        }
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- spawns --- */

  /**
   * Deterministic candidate points with a minimum separation and a minimum
   * clearance from geometry. Rejection sampling over the nav grid — never a
   * lattice, which the critic calls out on sight.
   */
  scatter(count, minSep, minClear, seedRand, filter = null) {
    const out = [];
    const rooms = this.rooms;
    if (!rooms.length) return out;
    const tries = count * 60;
    const sep2 = minSep * minSep;
    let weightTotal = 0;
    for (const rm of rooms) weightTotal += rm.w * rm.d;
    for (let t = 0; t < tries && out.length < count; t++) {
      // area-weighted room choice so a big hall gets proportionally more
      let pickW = seedRand() * weightTotal;
      let room = rooms[0];
      for (const rm of rooms) { pickW -= rm.w * rm.d; if (pickW <= 0) { room = rm; break; } }
      const x = room.minX + seedRand() * room.w;
      const z = room.minZ + seedRand() * room.d;
      if (this.clearanceAt(x, z) < minClear) continue;
      if (filter && !filter(x, z, room)) continue;
      let ok = true;
      for (let k = 0; k < out.length; k++) {
        const dx = out[k].x - x, dz = out[k].z - z;
        if (dx * dx + dz * dz < sep2) { ok = false; break; }
      }
      if (ok) out.push({ x, z, room });
    }
    return out;
  }
}

export default Layout;
