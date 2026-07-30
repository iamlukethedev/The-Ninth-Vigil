/**
 * THE NINTH VIGIL — decal geometry batch.
 *
 * One BufferGeometry, one material, ONE DRAW CALL, N fixed-stride slots. Slots
 * are handed out FIFO, which is also the eviction order, so the buffer never
 * fragments and no compaction pass is ever needed.
 *
 * A freed slot collapses all of its vertices onto a single point: every triangle
 * in the block becomes zero-area and is discarded before rasterisation, so a
 * half-empty batch costs the vertex shader and nothing else.
 *
 * Per-vertex decal state (birth time, life, tint, class...) lives in vertex
 * attributes and the whole ageing model runs in the shader from a single `uTime`
 * uniform. That is what keeps the per-frame CPU cost of 240 ageing decals at
 * literally zero.
 */
import * as THREE from 'three';

/** vec4 attributes carried per vertex, in upload order. */
const V4 = ['aTint', 'aEmis', 'aTiming', 'aFlags'];

export class DecalBatch {
  /**
   * @param {THREE.Material} material shared across batches
   * @param {{slots:number, verts:number, indices:number, name:string, renderOrder:number}} opts
   */
  constructor(material, opts) {
    this.slots = opts.slots;
    this.vps = opts.verts;
    this.ips = opts.indices;
    this.name = opts.name ?? 'decals';

    const nv = this.slots * this.vps;
    const ni = this.slots * this.ips;

    this.geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(nv * 3), 3);
    this.uv = new THREE.BufferAttribute(new Float32Array(nv * 2), 2);
    this.loc = new THREE.BufferAttribute(new Float32Array(nv * 2), 2);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nrm.setUsage(THREE.DynamicDrawUsage);
    this.uv.setUsage(THREE.DynamicDrawUsage);
    this.loc.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('normal', this.nrm);
    this.geo.setAttribute('uv', this.uv);
    this.geo.setAttribute('aLocal', this.loc);

    this.v4 = {};
    for (const k of V4) {
      const a = new THREE.BufferAttribute(new Float32Array(nv * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(k, a);
      this.v4[k] = a;
    }

    this.idx = new THREE.BufferAttribute(new Uint32Array(ni), 1);
    this.idx.setUsage(THREE.DynamicDrawUsage);
    this.geo.setIndex(this.idx);

    // Decals are world-space baked and scattered across the level, so per-mesh
    // culling is meaningless — one big sphere, culling disabled.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e5);
    this.geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1e5, -1e5, -1e5), new THREE.Vector3(1e5, 1e5, 1e5));

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = this.name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = opts.renderOrder ?? 4;
    this.mesh.updateMatrix();
    // decals must never pollute the depth/normal prepass
    this.mesh.userData.noGBuffer = true;
    this.mesh.userData.skyNoFog = false;

    this._lo = Infinity;
    this._hi = -Infinity;
    this._occ = new Uint8Array(this.slots);
    this._top = -1;
    this.geo.setDrawRange(0, 0);
  }

  /** Never submit index blocks past the highest live slot. */
  _retop() {
    let top = -1;
    for (let i = this.slots - 1; i >= 0; i--) if (this._occ[i]) { top = i; break; }
    if (top === this._top) return;
    this._top = top;
    this.geo.setDrawRange(0, (top + 1) * this.ips);
  }

  _dirty(slot) {
    if (slot < this._lo) this._lo = slot;
    if (slot > this._hi) this._hi = slot;
  }

  /**
   * Write a slot's geometry. `positions`/`normals`/`uvs` are flat arrays of
   * `count` vertices; `indices` are slot-relative (or null for a triangle soup).
   * @returns {boolean} false if it does not fit (caller must degrade)
   */
  writeGeometry(slot, positions, normals, uvs, count, indices, idxCount, locals) {
    if (slot < 0 || slot >= this.slots) return false;
    if (count > this.vps) return false;
    const need = indices ? idxCount : count;
    if (need > this.ips) return false;

    const vb = slot * this.vps;
    const pa = this.pos.array, na = this.nrm.array, ua = this.uv.array, la = this.loc.array;
    for (let i = 0; i < count; i++) {
      const o3 = (vb + i) * 3, s3 = i * 3;
      pa[o3] = positions[s3]; pa[o3 + 1] = positions[s3 + 1]; pa[o3 + 2] = positions[s3 + 2];
      na[o3] = normals[s3]; na[o3 + 1] = normals[s3 + 1]; na[o3 + 2] = normals[s3 + 2];
      const o2 = (vb + i) * 2, s2 = i * 2;
      ua[o2] = uvs[s2]; ua[o2 + 1] = uvs[s2 + 1];
      if (locals) { la[o2] = locals[s2]; la[o2 + 1] = locals[s2 + 1]; }
      else { la[o2] = uvs[s2]; la[o2 + 1] = uvs[s2 + 1]; }
    }
    // collapse the tail so stale vertices from a previous tenant cannot show
    for (let i = count; i < this.vps; i++) {
      const o3 = (vb + i) * 3;
      pa[o3] = 0; pa[o3 + 1] = -9999; pa[o3 + 2] = 0;
      na[o3] = 0; na[o3 + 1] = 1; na[o3 + 2] = 0;
    }

    const ib = slot * this.ips;
    const ia = this.idx.array;
    if (indices) {
      for (let i = 0; i < idxCount; i++) ia[ib + i] = vb + indices[i];
      for (let i = idxCount; i < this.ips; i++) ia[ib + i] = vb;
    } else {
      for (let i = 0; i < count; i++) ia[ib + i] = vb + i;
      for (let i = count; i < this.ips; i++) ia[ib + i] = vb;
    }

    this._occ[slot] = 1;
    this._dirty(slot);
    return true;
  }

  /** Write the per-decal shader state across every vertex of the slot. */
  writeParams(slot, tint, emis, timing, flags) {
    if (slot < 0 || slot >= this.slots) return;
    const vb = slot * this.vps;
    const src = [tint, emis, timing, flags];
    for (let k = 0; k < 4; k++) {
      const arr = this.v4[V4[k]].array;
      const s = src[k];
      const a = s[0], b = s[1], c = s[2], d = s[3];
      for (let i = 0; i < this.vps; i++) {
        const o = (vb + i) * 4;
        arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d;
      }
    }
    this._dirty(slot);
  }

  /** Patch only the timing vec4 — used by the fade-out-on-evict path. */
  patchTiming(slot, timing) {
    if (slot < 0 || slot >= this.slots) return;
    const vb = slot * this.vps;
    const arr = this.v4.aTiming.array;
    for (let i = 0; i < this.vps; i++) {
      const o = (vb + i) * 4;
      arr[o] = timing[0]; arr[o + 1] = timing[1]; arr[o + 2] = timing[2]; arr[o + 3] = timing[3];
    }
    this._dirty(slot);
  }

  /** Collapse a slot to nothing. */
  clearSlot(slot) {
    if (slot < 0 || slot >= this.slots) return;
    const vb = slot * this.vps;
    const pa = this.pos.array;
    for (let i = 0; i < this.vps; i++) {
      const o3 = (vb + i) * 3;
      pa[o3] = 0; pa[o3 + 1] = -9999; pa[o3 + 2] = 0;
    }
    const arr = this.v4.aTint.array;
    for (let i = 0; i < this.vps; i++) arr[(vb + i) * 4 + 3] = 0;
    this._occ[slot] = 0;
    this._dirty(slot);
  }

  /** Upload only the slot span touched this frame. */
  flush() {
    if (this._hi < this._lo) return;
    this._retop();
    const lo = this._lo, hi = this._hi;
    const n = hi - lo + 1;
    const vStart = lo * this.vps, vCount = n * this.vps;

    this.pos.addUpdateRange(vStart * 3, vCount * 3); this.pos.needsUpdate = true;
    this.nrm.addUpdateRange(vStart * 3, vCount * 3); this.nrm.needsUpdate = true;
    this.uv.addUpdateRange(vStart * 2, vCount * 2); this.uv.needsUpdate = true;
    this.loc.addUpdateRange(vStart * 2, vCount * 2); this.loc.needsUpdate = true;
    for (const k of V4) {
      const a = this.v4[k];
      a.addUpdateRange(vStart * 4, vCount * 4);
      a.needsUpdate = true;
    }
    this.idx.addUpdateRange(lo * this.ips, n * this.ips);
    this.idx.needsUpdate = true;

    this._lo = Infinity;
    this._hi = -Infinity;
  }

  dispose() {
    this.geo.dispose();
    this.mesh.removeFromParent();
  }
}
