/**
 * THE NINTH VIGIL — per-instance frustum culling for InstancedMesh batches.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * three.js culls per OBJECT. An `InstancedMesh` is one object, so its bounding
 * sphere is the union of every instance — and a crypt's wall-panel batch spans
 * the whole 72 m footprint. Measured on `combat`:
 *
 *     Dungeon   899,034 instanced tris   ->   286,652 actually inside the frustum
 *     Props     319,381 instanced tris   ->   123,670 actually inside the frustum
 *
 * i.e. two thirds of every instanced triangle in the scene was submitted, shaded
 * for the depth prepass, and re-submitted for each of the seventeen shadow
 * renders, while sitting behind the camera. Merging and LOD cannot fix that: the
 * geometry is off screen and the renderer has no way to know.
 *
 * THE FIX
 * -------
 * Keep one draw call per (geometry, material) — instancing's whole point — but
 * compact the *visible* instances to the front of the instance buffers each frame
 * and set `mesh.count` to how many survived. Everything the renderer already does
 * then works in our favour:
 *
 *   • `WebGLBufferRenderer.renderInstances()` returns before `info.update()` when
 *     the count is 0, so a fully off-screen batch costs zero draw calls and zero
 *     triangles — not a cheap draw, none at all.
 *   • `InstancedMesh.boundingSphere` is what `Frustum.intersectsObject` reads, so
 *     recomputing it over the survivors tightens object-level culling for every
 *     shadow camera as well.
 *
 * WHY IT SWAPS BUFFERS INSTEAD OF REWRITING THEM
 * ----------------------------------------------
 * Compaction permutes instance indices, and the modules that own these pools index
 * into them by hand: `Props` keeps `{mesh, idx}` slot references so a barrel can be
 * swapped for its broken variant or dropped to its LOD, and its pools grow when
 * `Dungeon` places a late fixture. Rewriting `instanceMatrix` under them would
 * silently address the wrong prop.
 *
 * So the module-owned attributes are never modified. Each entry keeps a private
 * mirror; `update()` binds the mirror for the duration of the frame and
 * `release()` puts the originals back, so outside `RenderPipeline.render()` every
 * pool is byte-for-byte what its owner wrote, `mesh.count` included. When nothing
 * is culled the original attribute is bound directly and not a byte moves.
 *
 * SHADOWS — why the margin exists
 * -------------------------------
 * An instance behind the camera can still cast into frame. The margin inflates
 * each instance's test radius, and casters get a much larger one than
 * non-casters, which are provably safe to cull hard (they only ever appear in
 * camera-frustum passes: the beauty render and the depth prepass, both driven by
 * this exact camera).
 *
 * `SHADOW_MARGIN` is sized off how far a shadow can actually travel here: the
 * cascaded sun sits ~12 deg off vertical, so a 7 m wall throws its shadow ~1.5 m
 * sideways, and the shadow-casting practicals are floor-level point lights whose
 * shadows radiate *away* from frame. 8 m is several times either figure.
 *
 * DETERMINISM
 * -----------
 * The visible set is a pure function of the camera matrices and the instance
 * transforms, compaction is stable (source order is preserved), and nothing here
 * reads a clock or a PRNG. Two captures of a scenario produce identical bytes.
 */
import * as THREE from 'three';

/** Inflation (metres) on every instance sphere. Absorbs conservative bounds. */
const BASE_MARGIN = 1.5;
/**
 * Inflation for shadow casters when nobody has told us which lights cast, and the
 * reach allowed for a shadow-casting point/spot light. A local light's shadows
 * radiate AWAY from it, so a caster far off screen throws its shadow further off
 * screen; what this has to cover is the band just outside frame whose shadow
 * still lands inside it. Verified empirically: see `perf_margin` in the report.
 */
const SHADOW_MARGIN = 8.0;
/** Floor and ceiling on the derived caster margin. */
const CASTER_MARGIN_MIN = 2.0;
const CASTER_MARGIN_MAX = 34.0;

class Entry {
  /**
   * @param {THREE.InstancedMesh} mesh
   * @param {number|null} margin explicit inflation, or null to derive per frame
   */
  constructor(mesh, margin) {
    const geo = mesh.geometry;
    const cap = mesh.instanceMatrix.count;

    this.mesh = mesh;
    this.margin = margin;
    this.cap = cap;
    this.srcCount = mesh.count;

    this.srcMatrix = mesh.instanceMatrix;
    this.gpuMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    this.gpuMatrix.setUsage(THREE.DynamicDrawUsage);

    this.srcColor = mesh.instanceColor ?? null;
    this.gpuColor = this.srcColor
      ? new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
      : null;
    this.gpuColor?.setUsage(THREE.DynamicDrawUsage);

    /** Instanced attributes that live on the geometry (aDungRough, aJit, ...). */
    this.geoPairs = [];
    for (const name in geo.attributes) {
      const a = geo.attributes[name];
      if (!a || a.isInstancedBufferAttribute !== true) continue;
      const gpu = new THREE.InstancedBufferAttribute(new Float32Array(a.array.length), a.itemSize);
      gpu.setUsage(THREE.DynamicDrawUsage);
      this.geoPairs.push({ name, src: a, gpu, size: a.itemSize });
    }

    this.cx = new Float32Array(cap);
    this.cy = new Float32Array(cap);
    this.cz = new Float32Array(cap);
    this.cr = new Float32Array(cap);
    this.vis = new Int32Array(cap);

    this.yLo = 0;
    this.yHi = 0;
    this.srcSphere = new THREE.Sphere();
    if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere();
    this.bound = 'src';
    this.allSphere = new THREE.Sphere();
  }

  /**
   * Per-instance world spheres from whatever the owner has written. Recomputed
   * every frame rather than cached, because a pool's transforms are live data:
   * Props hides an instance by writing a zero matrix into it.
   */
  refreshSpheres(n) {
    const bs = this.mesh.geometry.boundingSphere;
    const bx = bs.center.x, by = bs.center.y, bz = bs.center.z, br = bs.radius;
    const m = this.srcMatrix.array;
    const cx = this.cx, cy = this.cy, cz = this.cz, cr = this.cr;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const s = Math.max(
        Math.hypot(m[o], m[o + 1], m[o + 2]),
        Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
        Math.hypot(m[o + 8], m[o + 9], m[o + 10])
      );
      const x = m[o] * bx + m[o + 4] * by + m[o + 8] * bz + m[o + 12];
      const y = m[o + 1] * bx + m[o + 5] * by + m[o + 9] * bz + m[o + 13];
      const z = m[o + 2] * bx + m[o + 6] * by + m[o + 10] * bz + m[o + 14];
      const r = br * s;
      cx[i] = x; cy[i] = y; cz[i] = z; cr[i] = r;
      if (x - r < minX) minX = x - r;
      if (y - r < minY) minY = y - r;
      if (z - r < minZ) minZ = z - r;
      if (x + r > maxX) maxX = x + r;
      if (y + r > maxY) maxY = y + r;
      if (z + r > maxZ) maxZ = z + r;
    }
    if (minX <= maxX) {
      this.allSphere.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
      this.allSphere.radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
      this.yLo = minY; this.yHi = maxY;
    } else {
      this.allSphere.center.set(0, 0, 0);
      this.allSphere.radius = 0;
      this.yLo = 0; this.yHi = 0;
    }
    this.srcSphere.copy(this.allSphere);
  }

  bindSource() {
    if (this.bound === 'src') return;
    const mesh = this.mesh;
    mesh.instanceMatrix = this.srcMatrix;
    if (this.srcColor) mesh.instanceColor = this.srcColor;
    for (const p of this.geoPairs) mesh.geometry.attributes[p.name] = p.src;
    this.bound = 'src';
  }

  bindGpu() {
    if (this.bound === 'gpu') return;
    const mesh = this.mesh;
    mesh.instanceMatrix = this.gpuMatrix;
    if (this.gpuColor) mesh.instanceColor = this.gpuColor;
    for (const p of this.geoPairs) mesh.geometry.attributes[p.name] = p.gpu;
    this.bound = 'gpu';
  }

  /** Compact `count` source indices from `vis` into the private mirror. */
  writeVisible(count) {
    const src = this.srcMatrix.array;
    const dst = this.gpuMatrix.array;
    const vis = this.vis;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < count; k++) {
      const i = vis[k];
      const so = i * 16, dO = k * 16;
      for (let j = 0; j < 16; j++) dst[dO + j] = src[so + j];
      const r = this.cr[i];
      if (this.cx[i] - r < minX) minX = this.cx[i] - r;
      if (this.cy[i] - r < minY) minY = this.cy[i] - r;
      if (this.cz[i] - r < minZ) minZ = this.cz[i] - r;
      if (this.cx[i] + r > maxX) maxX = this.cx[i] + r;
      if (this.cy[i] + r > maxY) maxY = this.cy[i] + r;
      if (this.cz[i] + r > maxZ) maxZ = this.cz[i] + r;
    }
    this._flag(this.gpuMatrix, count * 16);
    if (this.gpuColor && this.srcColor) {
      const cs = this.srcColor.array, cd = this.gpuColor.array;
      for (let k = 0; k < count; k++) {
        const so = vis[k] * 3, dO = k * 3;
        cd[dO] = cs[so]; cd[dO + 1] = cs[so + 1]; cd[dO + 2] = cs[so + 2];
      }
      this._flag(this.gpuColor, count * 3);
    }
    for (const p of this.geoPairs) {
      const s = p.src.array, d = p.gpu.array, sz = p.size;
      for (let k = 0; k < count; k++) {
        const so = vis[k] * sz, dO = k * sz;
        for (let j = 0; j < sz; j++) d[dO + j] = s[so + j];
      }
      this._flag(p.gpu, count * sz);
    }
    this.bindGpu();
    this.mesh.count = count;
    const bsph = this.mesh.boundingSphere;
    bsph.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    bsph.radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  }

  /** Upload only the compacted prefix, not the whole pool. */
  _flag(attr, used) {
    try {
      if (typeof attr.clearUpdateRanges === 'function') {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, used);
      }
    } catch { /* whole-buffer upload is a correct fallback */ }
    attr.needsUpdate = true;
  }

  /** Put the owner's data back and forget we were ever here. */
  release() {
    this.bindSource();
    this.mesh.count = this.srcCount;
    if (this.mesh.boundingSphere) this.mesh.boundingSphere.copy(this.srcSphere);
  }

  dispose() {
    this.release();
    try { this.gpuMatrix.array = new Float32Array(0); } catch { /* noop */ }
  }
}

export class InstanceCuller {
  /** @param {import('./Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
    /** geometry uuid -> mesh uuid, so a shared geometry is only ever claimed once. */
    this._geoOwner = new Map();
    this.enabled = true;
    this._planes = new Float64Array(24);
    this._pm = new THREE.Matrix4();
    this._held = false;
    /** Shadow-caster reach in metres: derived from the lights that actually cast. */
    this._casterMargin = SHADOW_MARGIN;
    /** Y extent of everything registered — how far a raking shadow can travel. */
    this._yExtent = 12;
    this._lp = new THREE.Vector3();
    this._lt = new THREE.Vector3();
    this.counters = { batches: 0, instances: 0, drawn: 0, batchesOff: 0 };
  }

  /**
   * Tell the culler which lights cast shadows, so caster culling can be tight
   * instead of a blanket margin.
   *
   * A caster outside the camera frustum only matters if its shadow can reach
   * inside it, which is two cases and no others:
   *
   *  • A LOCAL light (point/spot) throws shadows radially outward from itself, so
   *    only casters within its shadow camera's own reach can contribute at all —
   *    an exact sphere, not a guess.
   *  • A DIRECTIONAL light displaces a shadow horizontally by
   *    `height * tan(angle from vertical)`. With the crypt's cascaded sun 12 deg
   *    off vertical and an 8 m ceiling that is ~1.8 m; with a dusk sun at 20 deg
   *    elevation it is ~22 m. Deriving it from the actual light direction is what
   *    lets an interior cull hard without breaking a low-sun exterior.
   *
   * @param {THREE.Light[]} lights
   */
  setShadowLights(lights) {
    if (!lights || !lights.length) {
      this._casterMargin = SHADOW_MARGIN;
      return;
    }
    let reach = 0;
    let any = false;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      if (!l || l.castShadow !== true || l.visible !== true || !(l.intensity > 0)) continue;
      any = true;
      if (l.isDirectionalLight === true) {
        this._lp.setFromMatrixPosition(l.matrixWorld);
        if (l.target) this._lt.setFromMatrixPosition(l.target.matrixWorld);
        else this._lt.set(0, 0, 0);
        const dx = this._lp.x - this._lt.x, dy = this._lp.y - this._lt.y, dz = this._lp.z - this._lt.z;
        const vert = Math.max(0.12, Math.abs(dy));
        // height * tan(angle from vertical): how far this sun can throw a shadow.
        const d = this._yExtent * (Math.hypot(dx, dz) / vert);
        if (d > reach) reach = d;
      } else if (l.isPointLight === true || l.isSpotLight === true) {
        if (SHADOW_MARGIN > reach) reach = SHADOW_MARGIN;
      }
    }
    this._casterMargin = any
      ? Math.min(CASTER_MARGIN_MAX, Math.max(CASTER_MARGIN_MIN, reach))
      : BASE_MARGIN;
  }

  /** Lazily attach the singleton to the engine. */
  static attach(engine) {
    if (!engine) return null;
    if (!engine.instanceCull) engine.instanceCull = new InstanceCuller(engine);
    return engine.instanceCull;
  }

  /**
   * Register a pool. Its instance data may keep changing afterwards — see the
   * buffer-swap note in the file header — but the geometry's bounding sphere and
   * the pool's capacity must not.
   * @param {THREE.InstancedMesh} mesh
   * @param {{margin?:number}} [opts]
   */
  add(mesh, opts = {}) {
    try {
      if (!this.enabled || !mesh || mesh.isInstancedMesh !== true) return false;
      if (this.entries.has(mesh.uuid)) return true;
      if (!mesh.instanceMatrix || !(mesh.instanceMatrix.count > 0)) return false;
      if (mesh.frustumCulled === false) return false;   // author opted out on purpose
      const geo = mesh.geometry;
      if (!geo) return false;
      // A geometry shared by two pools carries ONE set of instanced attributes, so
      // rebinding them for one mesh would corrupt the other. First claim wins.
      const owner = this._geoOwner.get(geo.uuid);
      if (owner && owner !== mesh.uuid) return false;
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (!geo.boundingSphere || !(geo.boundingSphere.radius >= 0)) return false;
      // null = derive per frame from the lights that actually cast (setShadowLights).
      this.entries.set(mesh.uuid, new Entry(mesh, opts.margin ?? null));
      this._geoOwner.set(geo.uuid, mesh.uuid);
      return true;
    } catch (e) {
      // A culler that throws must never take the frame with it.
      console.warn('[instanceCull] register failed —', e?.message ?? e);
      return false;
    }
  }

  /** Register every InstancedMesh under a subtree. */
  addTree(root, opts = {}) {
    if (!root) return 0;
    let n = 0;
    root.traverse((o) => { if (o.isInstancedMesh === true && this.add(o, opts)) n++; });
    return n;
  }

  remove(mesh) {
    const e = mesh && this.entries.get(mesh.uuid);
    if (!e) return false;
    try { e.dispose(); } catch { /* the mesh is going away anyway */ }
    this.entries.delete(mesh.uuid);
    if (this._geoOwner.get(mesh.geometry?.uuid) === mesh.uuid) this._geoOwner.delete(mesh.geometry.uuid);
    return true;
  }

  /** Drop batches whose meshes have left the scene (scenario rebuilds). */
  prune() {
    for (const [k, e] of this.entries) {
      if (e.mesh.parent) continue;
      try { e.dispose(); } catch { /* noop */ }
      this.entries.delete(k);
      if (this._geoOwner.get(e.mesh.geometry?.uuid) === k) this._geoOwner.delete(e.mesh.geometry.uuid);
    }
  }

  clear() {
    this.release();
    this.entries.clear();
    this._geoOwner.clear();
  }

  /**
   * Bind the culled view of every pool. Call once per frame with the camera the
   * frame will actually be rendered from, BEFORE any pass submits geometry (the
   * depth prepass included), and call `release()` when the frame is done.
   * @param {THREE.Camera} camera
   */
  update(camera) {
    if (!this.enabled || !camera || this.entries.size === 0) return;
    if (this._held) this.release();

    camera.updateMatrixWorld();
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const p = this._planes;
    const m = this._pm.elements;
    // Six inward-facing normalised planes: normal.p + constant >= 0 means inside.
    const set = (i, a, b, c, d) => {
      const l = Math.hypot(a, b, c) || 1;
      p[i] = a / l; p[i + 1] = b / l; p[i + 2] = c / l; p[i + 3] = d / l;
    };
    set(0, m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]);
    set(4, m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]);
    set(8, m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]);
    set(12, m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]);
    set(16, m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]);
    set(20, m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]);

    let batches = 0, instances = 0, drawn = 0, off = 0;
    this._held = true;
    let yLo = Infinity, yHi = -Infinity;

    for (const e of this.entries.values()) {
      const mesh = e.mesh;
      const n = Math.min(mesh.count, e.cap);
      e.srcCount = n;
      if (!mesh.parent || n <= 0) continue;
      batches++;
      instances += n;
      if (mesh.visible === false) { drawn += n; continue; }

      e.refreshSpheres(n);
      const caster = mesh.castShadow === true;
      const margin = e.margin ?? (caster ? this._casterMargin : BASE_MARGIN);

      /*
       * Feeds next frame's directional reach — see setShadowLights(). This is the
       * true vertical extent of the geometry, NOT the bounding sphere's: a batch
       * spanning a 72 m footprint has a ~52 m radius sphere, and believing that
       * was how tall the crypt is produced a 29 m caster margin that culled
       * nothing.
       */
      if (e.yLo < yLo) yLo = e.yLo;
      if (e.yHi > yHi) yHi = e.yHi;

      // Cheap whole-batch rejection / acceptance first.
      const ac = e.allSphere.center;
      const aR = e.allSphere.radius + margin;
      let outside = false;
      let fully = true;
      for (let i = 0; i < 24; i += 4) {
        const d = p[i] * ac.x + p[i + 1] * ac.y + p[i + 2] * ac.z + p[i + 3];
        if (d < -aR) { outside = true; break; }
        if (d < aR) fully = false;
      }
      if (outside) { e.bindSource(); mesh.count = 0; off++; continue; }
      if (fully) { e.bindSource(); mesh.count = n; drawn += n; continue; }

      const vis = e.vis;
      const cx = e.cx, cy = e.cy, cz = e.cz, cr = e.cr;
      let count = 0;
      for (let i = 0; i < n; i++) {
        const x = cx[i], y = cy[i], z = cz[i];
        const negR = -(cr[i] + margin);
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < negR) continue;
        if (p[4] * x + p[5] * y + p[6] * z + p[7] < negR) continue;
        if (p[8] * x + p[9] * y + p[10] * z + p[11] < negR) continue;
        if (p[12] * x + p[13] * y + p[14] * z + p[15] < negR) continue;
        if (p[16] * x + p[17] * y + p[18] * z + p[19] < negR) continue;
        if (p[20] * x + p[21] * y + p[22] * z + p[23] < negR) continue;
        vis[count++] = i;
      }
      if (count === 0) { e.bindSource(); mesh.count = 0; off++; continue; }
      if (count === n) { e.bindSource(); mesh.count = n; drawn += n; continue; }
      e.writeVisible(count);
      drawn += count;
    }

    if (yLo <= yHi) this._yExtent = Math.max(2, Math.min(60, yHi - yLo));
    this.counters.batches = batches;
    this.counters.instances = instances;
    this.counters.drawn = drawn;
    this.counters.batchesOff = off;
  }

  /** Hand every pool back to its owner, exactly as it was written. */
  release() {
    if (!this._held) return;
    this._held = false;
    for (const e of this.entries.values()) {
      try { e.release(); } catch { /* ignore */ }
    }
  }

  stats() {
    const c = this.counters;
    return {
      batches: c.batches,
      instances: c.instances,
      drawn: c.drawn,
      culled: c.instances - c.drawn,
      batchesOff: c.batchesOff,
      pct: c.instances ? +((100 * c.drawn) / c.instances).toFixed(1) : 0,
    };
  }
}
