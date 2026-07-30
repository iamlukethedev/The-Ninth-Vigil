/**
 * THE NINTH VIGIL — decal surface conforming.
 *
 * Two paths, both of which produce world-space geometry that hugs whatever the
 * decal landed on. A flat quad hovering over uneven ground is an instant fail,
 * so nothing here ever emits a single unsubdivided plane.
 *
 * 1. HEIGHTFIELD PATCH (the volume path). A subdivided grid whose every vertex
 *    is lifted onto the analytic ground height (dungeon flagstones or terrain
 *    heightfield) with per-vertex normals from the height gradient. Costs a
 *    handful of bilinear probes, follows slopes exactly, and merges into the
 *    shared batch so 200 of them are one draw call.
 *
 * 2. PROJECTED DECAL (the accurate path). `DecalGeometry` clips the receiving
 *    mesh's triangles against a projector box, so a splatter on a stair riser,
 *    a sarcophagus lid or a rubble pile wraps the actual geometry. Used when the
 *    surface under the impact is not the ground plane — a vertical or steeply
 *    tilted hit, or a prop. Restricted to small source geometries because
 *    DecalGeometry walks every triangle of the receiver.
 *
 * A single downward ray per 0.4 m cell (memoised) reconciles the analytic height
 * with the real rendered surface, which is what keeps decals on top of steps and
 * rubble instead of buried inside them.
 */
import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

const _ray = new THREE.Raycaster();
const _org = new THREE.Vector3();
const _dir = new THREE.Vector3(0, -1, 0);
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _sz = new THREE.Vector3();

/** DecalGeometry is O(receiver triangles) — refuse anything heavy. */
const MAX_RECEIVER_TRIS = 7000;
const PROBE_CELL = 0.4;

/**
 * Scratch for `buildPatchConformed`. Module-level and never reallocated: the
 * conformed path runs at spawn time for the handful of large decals that need it,
 * and allocating two Float32Arrays per sigil would put GC pressure on the frame a
 * scenario loads in.
 * `_corr` holds at most 7x7 probe corrections, `_hgt` at most 16x16 heights.
 */
const _corr = new Float32Array(49);
const _hgt = new Float32Array(256);

export class Surface {
  constructor(engine) {
    this.engine = engine;
    this._receivers = [];
    this._probes = new Map();
    this._scratch = new THREE.Mesh();
    this._scratch.matrixAutoUpdate = false;
    this._rayFailed = false;
    _ray.firstHitOnly = true;

    // Scratch buffers, sized for the largest slot in either batch.
    const MAXV = 512;
    this.pos = new Float32Array(MAXV * 3);
    this.nrm = new Float32Array(MAXV * 3);
    this.uv = new Float32Array(MAXV * 2);
    this.loc = new Float32Array(MAXV * 2);
    this.idx = new Uint16Array(MAXV * 6);
    this.count = 0;
    this.idxCount = 0;
  }

  /* --------------------------------------------------------------- ground */

  /** Analytic ground height. Interior flagstones win over the heightfield. */
  groundY(x, z) {
    const d = this.engine.get('dungeon');
    if (d && !d.__dead && d.active && typeof d.floorHeightAt === 'function') {
      const h = d.floorHeightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const h = t.heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }

  /** Rebuild the raycast receiver set. Called on scenario change. */
  refresh() {
    this._probes.clear();
    const list = [];
    const seen = new Set();
    const shown = (o) => {
      for (let p = o; p; p = p.parent) if (p.visible === false) return false;
      return true;
    };
    const add = (root) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      root.traverse((o) => {
        if (!o.isMesh || !shown(o)) return;
        if (o.userData?.noDecal) return;
        const m = o.material;
        const mm = Array.isArray(m) ? m[0] : m;
        if (!mm || mm.transparent === true || mm.depthWrite === false) return;
        if (!o.geometry?.attributes?.position) return;
        list.push(o);
      });
    };
    add(this.engine.get('dungeon')?.group);
    add(this.engine.get('props')?.group);
    add(this.engine.get('terrain')?.group);
    this._receivers = list;
  }

  /**
   * Reconcile the analytic height with the rendered surface at (x, z).
   * @returns {{y:number, nx:number, ny:number, nz:number, obj:THREE.Object3D|null, inst:number, ok:boolean}}
   */
  probe(x, z) {
    const gy = this.groundY(x, z);
    const key = `${Math.round(x / PROBE_CELL)},${Math.round(z / PROBE_CELL)}`;
    const hit = this._probes.get(key);
    if (hit !== undefined) return hit;

    let out = { y: gy, nx: 0, ny: 1, nz: 0, obj: null, inst: -1, ok: false };
    if (!this._rayFailed && this._receivers.length) {
      try {
        _org.set(x, gy + 2.2, z);
        _ray.set(_org, _dir);
        _ray.near = 0;
        _ray.far = 4.2;
        const res = _ray.intersectObjects(this._receivers, false);
        for (let i = 0; i < res.length; i++) {
          const h = res[i];
          if (!h.face && !h.normal) continue;
          if (Math.abs(h.point.y - gy) > 1.1) continue;
          const n = h.normal ? _v.copy(h.normal) : _v.set(0, 1, 0);
          if (h.object.matrixWorld && h.face) {
            n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
          }
          out = {
            y: h.point.y, nx: n.x, ny: n.y, nz: n.z,
            obj: h.object, inst: h.instanceId ?? -1, ok: true,
          };
          break;
        }
      } catch (e) {
        this._rayFailed = true;
        console.warn('[decals] surface probe disabled —', e?.message ?? e);
      }
    }
    // keep the cache bounded; the level is static so eviction order is irrelevant
    if (this._probes.size > 6000) this._probes.clear();
    this._probes.set(key, out);
    return out;
  }

  /**
   * How much the rendered surface steps within `r` metres. Non-zero means the
   * decal is landing on rubble, a stair, or the lip of a slab — the cases the
   * projected path exists for.
   */
  stepAt(x, z, r = 0.45) {
    const c = this.probe(x, z).y;
    let m = 0;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const d = Math.abs(this.probe(x + Math.cos(a) * r, z + Math.sin(a) * r).y - c);
      if (d > m) m = d;
    }
    return m;
  }

  /** Receiver triangle count — DecalGeometry walks all of them. */
  static tris(geo) {
    if (!geo) return Infinity;
    const n = geo.index ? geo.index.count : (geo.attributes?.position?.count ?? 0);
    return n / 3;
  }

  /** True when this receiver is a discrete object worth projecting onto. */
  projectable(hit) {
    return !!hit?.ok && !!hit.obj && Surface.tris(hit.obj.geometry) <= MAX_RECEIVER_TRIS;
  }

  /* ---------------------------------------------------- heightfield patch */

  /**
   * Build a ground-conforming patch into the scratch buffers.
   * @param {number} cx centre X (m)
   * @param {number} cz centre Z (m)
   * @param {number} yaw rotation about Y; +length runs along this heading
   * @param {number} halfL half extent along the heading
   * @param {number} halfW half extent across it
   * @param {number} res subdivisions per side
   * @param {number[]} rect atlas uv rect [u, v, w, h]
   * @param {number} lift metres above the surface
   * @param {number} baseY explicit surface height at the centre (probe result)
   */
  buildPatch(cx, cz, yaw, halfL, halfW, res, rect, lift, baseY) {
    const R = Math.max(2, Math.min(15, res | 0));
    const n = R + 1;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const pos = this.pos, nrm = this.nrm, uv = this.uv, loc = this.loc;
    const [ru, rv, rw, rh] = rect;

    const gy0 = this.groundY(cx, cz);
    const shift = (baseY === undefined ? gy0 : baseY) - gy0;
    const step = Math.max(0.08, Math.min(halfL, halfW) / R);

    let k = 0;
    for (let j = 0; j < n; j++) {
      const fv = j / R;
      const v = (fv - 0.5) * 2 * halfW;
      for (let i = 0; i < n; i++, k++) {
        const fu = i / R;
        const u = (fu - 0.5) * 2 * halfL;
        const wx = cx + u * ca - v * sa;
        const wz = cz + u * sa + v * ca;

        const hC = this.groundY(wx, wz);
        const hL = this.groundY(wx - step, wz);
        const hR = this.groundY(wx + step, wz);
        const hD = this.groundY(wx, wz - step);
        const hU = this.groundY(wx, wz + step);
        let gx = (hL - hR) / (2 * step);
        let gz = (hD - hU) / (2 * step);
        const il = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        const nyv = il;
        gx *= il; gz *= il;

        const o3 = k * 3, o2 = k * 2;
        pos[o3] = wx + gx * lift;
        pos[o3 + 1] = hC + shift + nyv * lift;
        pos[o3 + 2] = wz + gz * lift;
        nrm[o3] = gx; nrm[o3 + 1] = nyv; nrm[o3 + 2] = gz;
        uv[o2] = ru + fu * rw;
        uv[o2 + 1] = rv + fv * rh;
        loc[o2] = fu; loc[o2 + 1] = fv;
      }
    }

    const idx = this.idx;
    let m = 0;
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[m++] = a; idx[m++] = c; idx[m++] = b;
        idx[m++] = b; idx[m++] = c; idx[m++] = d;
      }
    }
    this.count = k;
    this.idxCount = m;
    return true;
  }

  /**
   * A patch that conforms to the RENDERED surface, not just the analytic one.
   *
   * `buildPatch` follows `groundY`, which is the heightfield or the flagstone
   * function — and around rubble, slab lips and stairs that disagrees with the
   * geometry actually on screen by up to ~0.4 m (measured; see KNOWN_ISSUES). For
   * a footprint or a splatter that is invisible. For a 10 m ritual sigil it is the
   * whole defect: one corner of the circle sinks into the floor while the opposite
   * corner hovers over it, and a ring that hovers reads as a decal pasted on the
   * frame rather than carved into the ground.
   *
   * So the height field gets a correction term sampled from the raycaster. The
   * probe is memoised per 0.4 m cell but it is still a real raycast against every
   * receiver on a miss, so it is sampled on a COARSE lattice — `(lat+1)^2` points,
   * 25 by default — and the resulting `probe.y - groundY` DELTA is bilinearly
   * interpolated across the patch. A big sigil therefore costs 25 rays once, at
   * spawn, and nothing per frame.
   *
   * Normals come from finite differences on the corrected height grid rather than
   * from the analytic gradient, so the decal's lighting agrees with the surface it
   * is actually lying on.
   *
   * Same signature as `buildPatch` plus `lat`. Falls back to `buildPatch`'s
   * behaviour when the raycaster is unavailable, so it can never be the reason a
   * decal fails to appear.
   *
   * @param {number} lat lattice divisions for the probe correction (2..6)
   */
  buildPatchConformed(cx, cz, yaw, halfL, halfW, res, rect, lift, baseY, lat = 4) {
    const R = Math.max(2, Math.min(15, res | 0));
    const n = R + 1;
    const L = Math.max(2, Math.min(6, lat | 0));
    const ln = L + 1;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    const pos = this.pos, nrm = this.nrm, uv = this.uv, loc = this.loc;
    const [ru, rv, rw, rh] = rect;

    const gy0 = this.groundY(cx, cz);
    const baseShift = (baseY === undefined ? gy0 : baseY) - gy0;

    /* --- 1. the probe correction lattice, in patch (u, v) space ---------- */
    const corr = _corr;
    let probed = false;
    if (!this._rayFailed && this._receivers.length) {
      for (let j = 0; j < ln; j++) {
        const v = (j / L - 0.5) * 2 * halfW;
        for (let i = 0; i < ln; i++) {
          const u = (i / L - 0.5) * 2 * halfL;
          const wx = cx + u * ca - v * sa;
          const wz = cz + u * sa + v * ca;
          let d = 0;
          try {
            const pr = this.probe(wx, wz);
            // Only ever trust a hit, and never let one cell drag the sigil more
            // than a quarter of a metre off the field: a memoised probe from the
            // neighbouring cell can legitimately be a slab edge.
            if (pr.ok && Number.isFinite(pr.y)) {
              d = pr.y - this.groundY(wx, wz);
              if (d > 0.28) d = 0.28; else if (d < -0.28) d = -0.28;
              probed = true;
            }
          } catch { /* leave this lattice node uncorrected */ }
          corr[j * ln + i] = d;
        }
      }
    }

    /* --- 2. heights: analytic + bilinear correction ---------------------- */
    const hgt = _hgt;
    for (let j = 0; j < n; j++) {
      const fv = j / R;
      const v = (fv - 0.5) * 2 * halfW;
      const ly = fv * L, j0 = Math.min(L - 1, ly | 0), tj = ly - j0;
      for (let i = 0; i < n; i++) {
        const fu = i / R;
        const u = (fu - 0.5) * 2 * halfL;
        const wx = cx + u * ca - v * sa;
        const wz = cz + u * sa + v * ca;
        let h = this.groundY(wx, wz) + baseShift;
        if (probed) {
          const lx = fu * L, i0 = Math.min(L - 1, lx | 0), ti = lx - i0;
          const a = corr[j0 * ln + i0], b = corr[j0 * ln + i0 + 1];
          const c = corr[(j0 + 1) * ln + i0], d = corr[(j0 + 1) * ln + i0 + 1];
          h += (a + (b - a) * ti) * (1 - tj) + (c + (d - c) * ti) * tj;
        }
        hgt[j * n + i] = h;
      }
    }

    /* --- 3. positions + normals from the corrected grid ------------------ */
    const du = (2 * halfL) / R, dv = (2 * halfW) / R;
    let k = 0;
    for (let j = 0; j < n; j++) {
      const fv = j / R;
      const v = (fv - 0.5) * 2 * halfW;
      for (let i = 0; i < n; i++, k++) {
        const fu = i / R;
        const u = (fu - 0.5) * 2 * halfL;
        const wx = cx + u * ca - v * sa;
        const wz = cz + u * sa + v * ca;
        const h = hgt[j * n + i];

        // central differences in patch space, one-sided at the border
        const iL = i > 0 ? i - 1 : i, iR = i < R ? i + 1 : i;
        const jD = j > 0 ? j - 1 : j, jU = j < R ? j + 1 : j;
        const su = (hgt[j * n + iL] - hgt[j * n + iR]) / ((iR - iL) * du);
        const sv = (hgt[jD * n + i] - hgt[jU * n + i]) / ((jU - jD) * dv);
        // patch-space slope -> world XZ slope
        let gx = su * ca - sv * sa;
        let gz = su * sa + sv * ca;
        const il = 1 / Math.sqrt(gx * gx + gz * gz + 1);
        const nyv = il;
        gx *= il; gz *= il;

        const o3 = k * 3, o2 = k * 2;
        pos[o3] = wx + gx * lift;
        pos[o3 + 1] = h + nyv * lift;
        pos[o3 + 2] = wz + gz * lift;
        nrm[o3] = gx; nrm[o3 + 1] = nyv; nrm[o3 + 2] = gz;
        uv[o2] = ru + fu * rw;
        uv[o2 + 1] = rv + fv * rh;
        loc[o2] = fu; loc[o2 + 1] = fv;
      }
    }

    const idx = this.idx;
    let m = 0;
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[m++] = a; idx[m++] = c; idx[m++] = b;
        idx[m++] = b; idx[m++] = c; idx[m++] = d;
      }
    }
    this.count = k;
    this.idxCount = m;
    return true;
  }

  /* ------------------------------------------------------ projected decal */

  /**
   * Project onto the mesh the probe actually hit. Returns false when the
   * receiver is unsuitable (too heavy, instanced without a matrix, no result),
   * in which case the caller falls back to the patch path.
   */
  buildProjected(hit, cx, cy, cz, yaw, sizeL, sizeW, depth, rect, lift, maxVerts) {
    const obj = hit?.obj;
    if (!obj || !obj.geometry) return false;
    const g = obj.geometry;
    const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!(tris > 0) || tris > MAX_RECEIVER_TRIS) return false;

    let target = obj;
    if (obj.isInstancedMesh) {
      if (hit.inst < 0) return false;
      obj.getMatrixAt(hit.inst, _m4);
      _m4.premultiply(obj.matrixWorld);
      this._scratch.geometry = g;
      this._scratch.matrixWorld.copy(_m4);
      target = this._scratch;
    }

    // Orient the projector: -Z looks into the surface, +X along the heading.
    _v.set(hit.nx, hit.ny, hit.nz);
    if (_v.lengthSq() < 1e-6) _v.set(0, 1, 0);
    _v.normalize();
    _fwd.set(Math.cos(yaw), 0, Math.sin(yaw));
    if (Math.abs(_fwd.dot(_v)) > 0.94) _fwd.set(0, 0, 1);
    _side.crossVectors(_v, _fwd).normalize();
    _fwd.crossVectors(_side, _v).normalize();
    _m4.makeBasis(_side, _fwd, _v);
    _q.setFromRotationMatrix(_m4);
    _e.setFromQuaternion(_q);
    _sz.set(sizeL, sizeW, depth);
    _v.multiplyScalar(lift * 1.6);
    _org.set(cx + _v.x, cy + _v.y, cz + _v.z);

    let geo = null;
    try {
      geo = new DecalGeometry(target, _org, _e, _sz);
    } catch (e) {
      return false;
    }
    const pa = geo.attributes.position;
    const na = geo.attributes.normal;
    const ua = geo.attributes.uv;
    const cnt = pa ? pa.count : 0;
    if (!cnt || !na || !ua || cnt > maxVerts) { geo.dispose(); return false; }

    const [ru, rv, rw, rh] = rect;
    const P = pa.array, N = na.array, U = ua.array;
    for (let i = 0; i < cnt; i++) {
      const o3 = i * 3, o2 = i * 2;
      this.nrm[o3] = N[o3]; this.nrm[o3 + 1] = N[o3 + 1]; this.nrm[o3 + 2] = N[o3 + 2];
      this.pos[o3] = P[o3] + N[o3] * lift;
      this.pos[o3 + 1] = P[o3 + 1] + N[o3 + 1] * lift;
      this.pos[o3 + 2] = P[o3 + 2] + N[o3 + 2] * lift;
      const fu = U[o2], fv = U[o2 + 1];
      this.uv[o2] = ru + fu * rw;
      this.uv[o2 + 1] = rv + fv * rh;
      this.loc[o2] = fu; this.loc[o2 + 1] = fv;
    }
    geo.dispose();
    this.count = cnt;
    this.idxCount = cnt;
    return true;
  }

  dispose() {
    this._probes.clear();
    this._receivers.length = 0;
    this._scratch.geometry = null;
  }
}
