/**
 * SANCTUM — broadphase.
 *
 * A uniform 2D grid over the play area (XZ), holding indices into a flat AABB
 * soup. Chosen over `three/addons/math/Octree` deliberately, and the reason is
 * worth writing down because the contract names the Octree:
 *
 *   • Octree stores *triangles*. The renderer draws 28 M of them; the crypt's
 *     collision surface is a few hundred axis-aligned boxes, because Layout.js
 *     is integer cell arithmetic on a 0.5 m grid. Feeding the render meshes to
 *     an Octree would cost hundreds of megabytes and hundreds of milliseconds
 *     to build, to answer questions a box soup answers exactly.
 *   • The world is a single storey. A 2D grid has one bucket lookup per cell
 *     instead of a tree descent, and the bucket contents are `Int32Array`
 *     slices — no per-query allocation, no pointer chasing, and byte-stable
 *     iteration order, which the determinism requirement needs.
 *
 * Build is a two-pass counting sort (count per cell, prefix sum, scatter), so
 * there are no per-cell arrays and no garbage. Rebuilt on 'scenario' /
 * 'dungeon:built'; dynamic bodies use a second instance rebuilt per frame.
 */

export class Grid {
  /**
   * @param {number} [cell] cell size in metres
   */
  constructor(cell = 2.0) {
    this.cell = cell;
    this.minX = 0; this.minZ = 0;
    this.nx = 1; this.nz = 1;
    this.start = new Int32Array(2);      // prefix offsets, length nx*nz+1
    this.items = new Int32Array(1);      // box indices, bucketed
    this.count = 0;
    this.maxPerCell = 0;
  }

  /**
   * @param {Array<{minX:number,minZ:number,maxX:number,maxZ:number}>} boxes
   * @param {{minX:number,minZ:number,maxX:number,maxZ:number}} bounds
   */
  build(boxes, bounds, cell = this.cell) {
    this.cell = cell;
    const pad = cell * 2;
    this.minX = bounds.minX - pad;
    this.minZ = bounds.minZ - pad;
    this.nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + pad * 2) / cell));
    this.nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ + pad * 2) / cell));
    const nCells = this.nx * this.nz;
    if (this.start.length < nCells + 1) this.start = new Int32Array(nCells + 1);
    else this.start.fill(0, 0, nCells + 1);

    const n = boxes.length;
    this.count = n;
    const inv = 1 / cell;

    /* pass 1 — count */
    let total = 0;
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      const i0 = this._ci(b.minX, inv, this.nx, this.minX);
      const i1 = this._ci(b.maxX, inv, this.nx, this.minX);
      const j0 = this._ci(b.minZ, inv, this.nz, this.minZ);
      const j1 = this._ci(b.maxZ, inv, this.nz, this.minZ);
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) this.start[j * this.nx + ii + 1]++;
      }
      total += (i1 - i0 + 1) * (j1 - j0 + 1);
    }
    /* prefix sum */
    let hi = 0;
    for (let c = 0; c < nCells; c++) {
      const v = this.start[c + 1];
      if (v > hi) hi = v;
      this.start[c + 1] = this.start[c] + v;
    }
    this.maxPerCell = hi;
    if (this.items.length < total) this.items = new Int32Array(Math.max(16, total));
    /* pass 2 — scatter (cursor reuses a scratch copy of start) */
    if (!this._cursor || this._cursor.length < nCells + 1) this._cursor = new Int32Array(nCells + 1);
    this._cursor.set(this.start.subarray(0, nCells + 1));
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      const i0 = this._ci(b.minX, inv, this.nx, this.minX);
      const i1 = this._ci(b.maxX, inv, this.nx, this.minX);
      const j0 = this._ci(b.minZ, inv, this.nz, this.minZ);
      const j1 = this._ci(b.maxZ, inv, this.nz, this.minZ);
      for (let j = j0; j <= j1; j++) {
        const row = j * this.nx;
        for (let ii = i0; ii <= i1; ii++) this.items[this._cursor[row + ii]++] = i;
      }
    }
    return this;
  }

  _ci(v, inv, n, origin) {
    let c = Math.floor((v - origin) * inv);
    if (c < 0) c = 0; else if (c >= n) c = n - 1;
    return c;
  }

  /**
   * Gather unique box indices overlapping an XZ rectangle into `out` (an
   * Int32Array-like with a `.length` we manage via the returned count).
   * `stamp` is a monotonically increasing tag written into `seen` so
   * de-duplication needs no clearing pass.
   *
   * @returns {number} how many indices were written
   */
  query(minX, minZ, maxX, maxZ, out, seen, stamp) {
    const inv = 1 / this.cell;
    const i0 = this._ci(minX, inv, this.nx, this.minX);
    const i1 = this._ci(maxX, inv, this.nx, this.minX);
    const j0 = this._ci(minZ, inv, this.nz, this.minZ);
    const j1 = this._ci(maxZ, inv, this.nz, this.minZ);
    let k = 0;
    const cap = out.length;
    for (let j = j0; j <= j1; j++) {
      const row = j * this.nx;
      for (let i = i0; i <= i1; i++) {
        const c = row + i;
        const s = this.start[c], e = this.start[c + 1];
        for (let t = s; t < e; t++) {
          const idx = this.items[t];
          if (seen[idx] === stamp) continue;
          seen[idx] = stamp;
          if (k < cap) out[k++] = idx;
        }
      }
    }
    return k;
  }
}

/**
 * Greedy rectangle merge over a boolean cell mask. Turns a 144x144 wall mask
 * into a few hundred maximal rectangles instead of 20 000 unit boxes — the
 * difference between a broadphase that costs nothing and one that dominates the
 * frame.
 *
 * Scans rows top to bottom; for each unclaimed cell it extends right while the
 * mask holds, then down while the whole span holds, then claims the block. The
 * order is fixed, so the output rectangle list is byte-identical run to run.
 *
 * @param {(i:number,j:number)=>boolean} solid
 * @param {number} W grid width  (cells)
 * @param {number} H grid height (cells)
 * @param {(i0:number,j0:number,i1:number,j1:number)=>void} emit  half-open cell rect
 */
export function greedyMerge(solid, W, H, emit) {
  const claimed = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (claimed[k] || !solid(i, j)) continue;
      /* extend right */
      let i1 = i + 1;
      while (i1 < W && !claimed[j * W + i1] && solid(i1, j)) i1++;
      /* extend down while the whole span is free */
      let j1 = j + 1;
      outer: while (j1 < H) {
        for (let ii = i; ii < i1; ii++) {
          if (claimed[j1 * W + ii] || !solid(ii, j1)) break outer;
        }
        j1++;
      }
      for (let jj = j; jj < j1; jj++) {
        for (let ii = i; ii < i1; ii++) claimed[jj * W + ii] = 1;
      }
      emit(i, j, i1, j1);
    }
  }
}

export default Grid;
