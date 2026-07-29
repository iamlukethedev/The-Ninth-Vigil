/**
 * SANCTUM — modular architectural pieces for the crypt kit.
 *
 * Every builder returns `{ <materialKey>: BufferGeometry }` so the module can
 * batch a piece across several materials without knowing what it is made of.
 * Geometry is authored in a piece-local frame and instanced, so the only cost
 * of a hundred identical wall panels is a hundred matrices.
 *
 * Authoring conventions
 * ---------------------
 * • Wall-like pieces run along local +X, stand on y = 0, and present their
 *   dressed face at z = 0 with the room on the +Z side. The mass extends to
 *   negative z (SPEC.wall.back). Placement therefore only needs a yaw of
 *   0 / ±90° / 180°.
 * • Every hard edge is chamfered (Geom.chamferBox / bevelExtrude). A crypt lit
 *   by raking torchlight lives or dies on whether its arrises catch a highlight.
 * • UVs are recomputed from merged piece-local positions (`finish`), so a
 *   0.5 m ashlar block and a 4 m vault web share one metre-accurate texture
 *   scale instead of each stone repeating the same texel patch.
 * • Nothing here calls Math.random — every builder takes a seeded `rnd`.
 */

import * as THREE from 'three';
import { SPEC } from './Spec.js';
import {
  chamferBox, bevelExtrude, archY, archPath, sweepProfile, ribProfile,
  revolve, flutedShaft, rockChunk, roughenVerts, autoUV, mergeAll, trs,
  finishGeo, pushQuadAuto, pushTriSmooth,
} from './Geom.js';

const W = SPEC.wall;
const V = SPEC.vault;
const P = SPEC.portal;
const F = SPEC.floor;
const C = SPEC.column;

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * shared helpers
 * ------------------------------------------------------------------ */

/**
 * Merge a part list and give it metre-accurate, piece-local planar UVs.
 * `shift` decorrelates the texture between variants of the same piece so an
 * instanced wall never shows the same stain twice in a row.
 */
function finish(parts, shift = null) {
  const g = mergeAll(parts);
  if (shift) {
    g.translate(shift[0], shift[1], shift[2]);
    autoUV(g);
    g.translate(-shift[0], -shift[1], -shift[2]);
  } else {
    autoUV(g);
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Canonical size ladders. Pieces are built only at these sizes and the instance
 * matrix scales them the last few percent to fit, which is what keeps the batch
 * count near a hundred instead of near a thousand: a room whose bays are
 * 3.62 m shares its vault web with one whose bays are 3.41 m.
 */
export const LADDER = {
  bay: [2.4, 2.9, 3.4, 3.9, 4.4],
  span: [1.05, 1.35, 1.65, 1.95, 2.25],
  slabW: [1.0, 1.35, 1.7, 2.1],
  slabD: [1.0, 1.35],
};

/** Nearest rung of a ladder. */
export function snap(v, arr) {
  let best = arr[0], bd = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.abs(arr[i] - v);
    if (d < bd) { bd = d; best = arr[i]; }
  }
  return best;
}

/** How far a wall/column base is buried, so an undulating floor shows no gap. */
const BURY = 0.55;

/** Rise ratio shared by every vault web, rib and lunette — they must agree. */
const VAULT_RISE = 1.28;

/** Analytic slope of the two-centred arch, used for exact vault normals. */
function archSlope(x, halfSpan, riseRatio) {
  const r0 = Math.max(1.0005, riseRatio);
  const d = (r0 * r0 - 1) * 0.5;
  const R = 1 + d;
  const ax = Math.abs(x) / halfSpan;
  const t = Math.min(1, ax) + d;
  const v = R * R - t * t;
  if (v <= 1e-9) return x >= 0 ? -40 : 40;
  return (-t * Math.sign(x || 1)) / Math.sqrt(v);
}

/* ------------------------------------------------------------------ *
 * Kit
 * ------------------------------------------------------------------ */

export class Kit {
  /** @param {(min?:number,max?:number)=>number} rand seeded PRNG */
  constructor(rand) {
    this.rand = rand;
    this._cache = new Map();
    this.tris = 0;
  }

  dispose() {
    for (const entry of this._cache.values()) {
      for (const k in entry) entry[k]?.dispose?.();
    }
    this._cache.clear();
  }

  /** Memoise a builder by key; every geometry in the kit is shared. */
  _get(key, build) {
    let hit = this._cache.get(key);
    if (hit) return hit;
    hit = build();
    for (const k in hit) {
      const g = hit[k];
      if (!g) { delete hit[k]; continue; }
      this.tris += g.attributes.position.count / 3;
    }
    this._cache.set(key, hit);
    return hit;
  }

  /** Fresh sub-stream so a variant's noise never depends on call order. */
  _rnd(seed) {
    let a = (seed * 1103515245 + 12345) >>> 0;
    return () => {
      a ^= a << 13; a >>>= 0;
      a ^= a >>> 17;
      a ^= a << 5; a >>>= 0;
      return a / 4294967296;
    };
  }

  /* ============================================================ WALLS == */

  /**
   * A wall panel: plinth, coursed ashlar over a recessed field, string course,
   * corbelled cornice and a weathered coping. `detail` 1 dresses every stone
   * individually; `detail` 0 uses coursed bands for panels the camera only ever
   * sees at 30 m through fog.
   *
   * @param {number} len   run length in metres (multiples of 0.5)
   * @param {number} variant 0..N — block layout / damage seed
   * @param {number} detail 0|1
   */
  wallPanel(len, variant, detail = 1) {
    const L = Math.max(0.5, Math.round(len * 2) / 2);
    return this._get(`wall|${L}|${variant}|${detail}`, () => {
      const r = this._rnd(variant * 7717 + L * 31 + detail * 991);
      const parts = [];
      const hl = L * 0.5;
      const core = W.field - W.back;                       // 0.51

      /* hidden mass behind the dressed face, buried below the floor line */
      parts.push([chamferBox(L, W.corniceLo + BURY, core, 0.012),
        trs(0, (W.corniceLo - BURY) * 0.5, (W.back + W.field) * 0.5)]);

      /* plinth: two chamfered courses, the upper one weathered back */
      parts.push([chamferBox(L, 0.38 + BURY, W.plinthU - W.field, 0.045),
        trs(0, 0.19 - BURY * 0.5, (W.field + W.plinthU) * 0.5)]);
      parts.push([chamferBox(L, 0.09, W.plinthU - W.field - 0.035, 0.030),
        trs(0, 0.425, (W.field + W.plinthU - 0.035) * 0.5)]);

      /* string course */
      parts.push([chamferBox(L, W.stringHi - W.stringLo, W.stringU - W.field, 0.048),
        trs(0, (W.stringLo + W.stringHi) * 0.5, (W.field + W.stringU) * 0.5)]);

      /* cornice — corbel, cavetto band, coping */
      parts.push([chamferBox(L, 0.20, 0.72, 0.05), trs(0, 4.00, W.back + 0.36)]);
      parts.push([chamferBox(L, 0.16, W.corniceU - W.back, 0.055),
        trs(0, 4.18, (W.back + W.corniceU) * 0.5)]);
      parts.push([chamferBox(L, W.h - 4.26, W.copingU - W.back, 0.075),
        trs(0, (4.26 + W.h) * 0.5, (W.back + W.copingU) * 0.5)]);

      /* ---- ashlar fields ---- */
      const bands = [
        { y0: 0.47, y1: W.stringLo, dressed: true },
        { y0: W.stringHi, y1: 3.86, dressed: detail === 1 },
      ];
      const zBlock = W.field + W.blockDepth * 0.5;

      for (let bi = 0; bi < bands.length; bi++) {
        const band = bands[bi];
        let y = band.y0;
        while (y < band.y1 - 0.06) {
          let ch = W.course * (0.90 + r() * 0.42);
          if (y + ch > band.y1) ch = band.y1 - y;
          if (ch < 0.13) break;
          const cy = y + ch * 0.5;

          if (band.dressed) {
            // stagger each course; joints are real gaps, not texture
            let x = -hl - W.block * (0.15 + r() * 0.7);
            let guard = 0;
            while (x < hl && guard++ < 64) {
              let bw = W.block * (0.95 + r() * 0.68);
              const x0 = Math.max(-hl, x);
              const x1 = Math.min(hl, x + bw);
              const eff = x1 - x0 - W.joint;
              x += bw + W.joint;
              if (eff < 0.10) continue;
              const dropTop = bi === 1 && y > 3.3 && r() < 0.16;   // stone gone from the top course
              if (dropTop || r() < 0.035) continue;                 // missing stone
              const chip = r() < 0.16 ? 0.062 : 0.026;
              const proud = W.blockDepth * (r() < 0.22 ? 0.62 : 1.25) - (r() < 0.3 ? 0.018 : 0);
              const g = chamferBox(eff, ch - W.joint * 1.7, proud, chip);
              if (r() < 0.30) roughenVerts(g, 0.0055, r);
              parts.push([g, trs(
                (x0 + x1) * 0.5, cy, W.field + proud * 0.5,
                (r() - 0.5) * 0.012, (r() - 0.5) * 0.014, (r() - 0.5) * 0.010)]);
            }
          } else {
            // coursed band: one chamfered strip per course
            const g = chamferBox(L, ch - W.joint, W.blockDepth * 0.85, 0.022);
            parts.push([g, trs(0, cy, zBlock - 0.006, 0, 0, (r() - 0.5) * 0.004)]);
          }
          y += ch;
        }
      }
      return { stone: finish(parts, [variant * 1.37, variant * 0.61, 0]) };
    });
  }

  /**
   * Quoin pier for wall corners: alternating long/short chamfered blocks that
   * stand proud of both faces, so an inside corner reads as masonry rather than
   * two planes meeting.
   */
  pier(variant) {
    return this._get(`pier|${variant}`, () => {
      const r = this._rnd(variant * 4409 + 17);
      const parts = [];
      const s = W.pier;
      let y = 0;
      // plinth block, buried below the floor so an undulating slab shows no gap
      parts.push([chamferBox(s + 0.12, 0.46 + BURY, s + 0.12, 0.05), trs(0, 0.23 - BURY * 0.5, 0)]);
      y = 0.46;
      let flip = variant & 1;
      while (y < W.corniceLo - 0.12) {
        const h = W.course * (0.88 + r() * 0.34);
        const a = s + (flip ? 0.055 : -0.02);
        const b = s + (flip ? -0.02 : 0.055);
        const g = chamferBox(a, Math.min(h, W.corniceLo - y) - W.joint, b, r() < 0.18 ? 0.05 : 0.02);
        if (r() < 0.35) roughenVerts(g, 0.006, r);
        parts.push([g, trs((r() - 0.5) * 0.016, y + h * 0.5, (r() - 0.5) * 0.016,
          0, (r() - 0.5) * 0.02, 0)]);
        y += h;
        flip ^= 1;
      }
      // cap: corbel + coping
      parts.push([chamferBox(s + 0.24, 0.20, s + 0.24, 0.055), trs(0, 4.00, 0)]);
      parts.push([chamferBox(s + 0.34, 0.18, s + 0.34, 0.06), trs(0, 4.19, 0)]);
      parts.push([chamferBox(s + 0.26, W.h - 4.28, s + 0.26, 0.075), trs(0, (4.28 + W.h) * 0.5, 0)]);
      return { stone: finish(parts, [variant * 2.1, 0, variant * 1.3]) };
    });
  }

  /**
   * A wall respond: the corbelled shaft that receives a vault rib where a bay
   * division meets a wall. Without these the ribs die into flat masonry and the
   * vault reads as a decal.
   */
  respond(variant) {
    return this._get(`respond|${variant}`, () => {
      const r = this._rnd(variant * 863 + 5);
      const parts = [];
      // half-round shaft from the string course up to the springing
      const shaft = revolve([
        [0.001, 0], [0.15, 0.02], [0.17, 0.10], [0.155, 0.16],
        [0.155, V.spring - W.stringHi - 0.30], [0.185, V.spring - W.stringHi - 0.20],
        [0.20, V.spring - W.stringHi - 0.10], [0.16, V.spring - W.stringHi - 0.02],
        [0.001, V.spring - W.stringHi],
      ], 14, true);
      parts.push([shaft, trs(0, W.stringHi, 0.10)]);
      // corbel bracket under the shaft
      parts.push([chamferBox(0.42, 0.20, 0.30, 0.045), trs(0, W.stringHi - 0.10, 0.06)]);
      parts.push([chamferBox(0.30, 0.14, 0.20, 0.04), trs(0, W.stringHi - 0.24, 0.02)]);
      // capital / springer block at the top
      parts.push([chamferBox(0.46, 0.16, 0.34, 0.04), trs(0, V.spring - 0.08, 0.08)]);
      parts.push([chamferBox(0.38, 0.10, 0.28, 0.035), trs(0, V.spring - 0.21, 0.06)]);
      if (r() < 0.5) parts.push([chamferBox(0.20, 0.13, 0.13, 0.03), trs(0, V.spring - 0.36, 0.11)]);
      return { stone: finish(parts, [variant * 0.9, 0, 0]) };
    });
  }

  /**
   * Gothic portal: pointed opening with a chamfered reveal (the bevel of the
   * extrusion hole), radial voussoirs, a hood mould and a keystone.
   * The frame is one solid block so it seals the wall line — no light leaks.
   */
  portal(halfSpan, variant) {
    const hs = Math.round(halfSpan * 20) / 20;
    return this._get(`portal|${hs}|${variant}`, () => {
      const r = this._rnd(variant * 3313 + hs * 97);
      const rise = P.riseRatio;
      const apex = archY(0, hs, rise);
      const frameH = P.spring + apex + 0.72;
      const halfW = hs + P.jamb;
      const parts = [];

      /* solid frame with the arched opening as a bevelled hole */
      const outer = [
        [-halfW, -BURY], [halfW, -BURY], [halfW, frameH - 0.30],
        [halfW - 0.10, frameH], [-halfW + 0.10, frameH], [-halfW, frameH - 0.30],
      ];
      const hole = [];
      hole.push([-hs, -0.09]);
      const arc = archPath(hs, rise, 13, P.spring, 0);
      hole.push([-hs, P.spring]);
      for (let i = 1; i < arc.length - 1; i++) hole.push(arc[i]);
      hole.push([hs, P.spring]);
      hole.push([hs, -0.09]);
      hole.reverse();
      parts.push([bevelExtrude(outer, P.thick, 0.030, [hole]), trs(0, 0, 0)]);

      /* voussoirs around the arch — individually chamfered wedges */
      const vs = archPath(hs, rise, 14, P.spring, 0.005);
      for (let i = 0; i < vs.length - 1; i++) {
        const a = vs[i], b = vs[i + 1];
        const mx = (a[0] + b[0]) * 0.5, my = (a[1] + b[1]) * 0.5;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dep = 0.30 + (i % 2) * 0.05 + r() * 0.03;
        const g = chamferBox(seg * 1.03, dep, P.thick + 0.09, 0.022);
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        parts.push([g, trs(mx + nx * dep * 0.5, my + ny * dep * 0.5, 0, 0, 0, ang)]);
      }
      /* keystone */
      parts.push([chamferBox(0.34, 0.52, P.thick + 0.16, 0.035),
        trs(0, P.spring + apex + 0.20, 0)]);
      parts.push([chamferBox(0.22, 0.20, P.thick + 0.24, 0.03),
        trs(0, P.spring + apex + 0.13, 0)]);

      /* hood mould following the arch, plus its label stops */
      const hood = archPath(hs, rise, 16, P.spring, 0.44);
      const hp = [], hu = [];
      for (const [x, y] of hood) { hp.push([x, y, P.thick * 0.5 + 0.06]); hu.push([0, 0, 1]); }
      parts.push([sweepProfile(hp, hu, ribProfile(0.15, 0.10, 0.03), true), null]);
      for (const sx of [-1, 1]) {
        parts.push([chamferBox(0.24, 0.26, 0.30, 0.04),
          trs(sx * (hs + 0.44), P.spring - 0.02, P.thick * 0.5 + 0.02)]);
      }

      /* jamb quoins so the reveal is dressed */
      for (const sx of [-1, 1]) {
        let y = 0.0;
        let k = 0;
        while (y < P.spring - 0.22) {
          const h = 0.34 + r() * 0.16;
          const w2 = (k & 1) ? 0.30 : 0.20;
          parts.push([chamferBox(w2, Math.min(h, P.spring - y) - 0.02, P.thick + 0.055, 0.024),
            trs(sx * (hs + w2 * 0.5 - 0.01), y + h * 0.5, 0)]);
          y += h; k++;
        }
        parts.push([chamferBox(0.40, 0.14, P.thick + 0.12, 0.03),
          trs(sx * (hs + 0.16), P.spring - 0.08, 0)]);
      }
      return { stone: finish(parts, [variant * 1.7, variant * 2.3, 0]) };
    });
  }

  /**
   * Lunette: the wall web between the coping and the formeret arch of a vault
   * bay. Closes the triangle above every wall — without it, the skylight leaks
   * straight through the top of every room.
   */
  lunette(halfSpan) {
    const hs = Math.round(halfSpan * 20) / 20;
    return this._get(`lunette|${hs}`, () => {
      const arc = archPath(hs, VAULT_RISE, 11, 0, 0);
      const pts = [[-hs, -0.5], [hs, -0.5]];
      for (let i = arc.length - 1; i >= 0; i--) pts.push(arc[i]);
      const g = bevelExtrude(pts, 0.46, 0.018);
      return { stone: finish([[g, null]]) };
    });
  }

  /* =========================================================== VAULTS == */

  /**
   * Ribbed groin-vault web for one bay, built as a closed solid: the intrados
   * is the union of two two-centred barrels (`max`, which is what makes the
   * diagonal groin), the extrados is that surface lifted by its thickness, and
   * the four boundary arches are skirted. A closed shell means the vault casts
   * a correct shadow with no bias hacks — the whole crypt is lit by the pool of
   * cold light that falls through the collapsed bays.
   */
  vaultWeb(w, d, variant = 0) {
    const bw = Math.round(w * 20) / 20, bd = Math.round(d * 20) / 20;
    return this._get(`web|${bw}|${bd}|${variant}`, () => {
      const hw = bw * 0.5, hd = bd * 0.5;
      const rise = VAULT_RISE;
      const nu = Math.max(6, Math.min(11, Math.round(bw * 2.3)));
      const nv = Math.max(6, Math.min(11, Math.round(bd * 2.3)));
      const t = 0.30;
      const pos = [], nor = [];
      const hOf = (x, z) => Math.max(archY(x, hw, rise), archY(z, hd, rise));
      const nOf = (x, z, up) => {
        const ax = archY(x, hw, rise), az = archY(z, hd, rise);
        let fx = 0, fz = 0;
        if (ax >= az) fx = archSlope(x, hw, rise); else fz = archSlope(z, hd, rise);
        const s = up ? 1 : -1;
        const l = Math.hypot(fx, 1, fz) || 1;
        return [(-fx * s) / l, s / l, (-fz * s) / l];
      };
      const gx = (i) => -hw + (bw * i) / nu;
      const gz = (j) => -hd + (bd * j) / nv;

      // intrados (faces down) and extrados (faces up)
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const x0 = gx(i), x1 = gx(i + 1), z0 = gz(j), z1 = gz(j + 1);
          const q = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
          for (const up of [false, true]) {
            const off = up ? t : 0;
            const v = q.map(([x, z]) => [x, hOf(x, z) + off, z]);
            const n = q.map(([x, z]) => nOf(x, z, up));
            if (up) {
              pushTriSmooth(pos, nor, v[0], v[1], v[2], n[0], n[1], n[2]);
              pushTriSmooth(pos, nor, v[0], v[2], v[3], n[0], n[2], n[3]);
            } else {
              pushTriSmooth(pos, nor, v[0], v[2], v[1], n[0], n[2], n[1]);
              pushTriSmooth(pos, nor, v[0], v[3], v[2], n[0], n[3], n[2]);
            }
          }
        }
      }
      // boundary skirts, so the shell is a closed solid
      for (let i = 0; i < nu; i++) {
        const x0 = gx(i), x1 = gx(i + 1);
        for (const z of [-hd, hd]) {
          const a = [x0, hOf(x0, z), z], b = [x1, hOf(x1, z), z];
          const c = [x1, hOf(x1, z) + t, z], e = [x0, hOf(x0, z) + t, z];
          if (z < 0) pushQuadAuto(pos, nor, a, b, c, e);
          else pushQuadAuto(pos, nor, a, e, c, b);
        }
      }
      for (let j = 0; j < nv; j++) {
        const z0 = gz(j), z1 = gz(j + 1);
        for (const x of [-hw, hw]) {
          const a = [x, hOf(x, z0), z0], b = [x, hOf(x, z1), z1];
          const c = [x, hOf(x, z1) + t, z1], e = [x, hOf(x, z0) + t, z0];
          if (x > 0) pushQuadAuto(pos, nor, a, b, c, e);
          else pushQuadAuto(pos, nor, a, e, c, b);
        }
      }
      const shell = finishGeo(pos, nor);

      /* diagonal groin ribs + boss */
      const parts = [[shell, null]];
      const prof = ribProfile(V.ribW, V.ribD, 0.035);
      for (const sg of [1, -1]) {
        const path = [], up = [];
        const segs = 11;
        for (let k = 0; k <= segs; k++) {
          const s = k / segs;
          const x = -hw + bw * s;
          const z = sg > 0 ? -hd + bd * s : hd - bd * s;
          path.push([x, hOf(x, z) + 0.005, z]);
          up.push([0, -1, 0]);
        }
        parts.push([sweepProfile(path, up, prof, true), null]);
      }
      const apex = hOf(0, 0);
      parts.push([chamferBox(0.34, 0.30, 0.34, 0.04), trs(0, apex - 0.10, 0)]);
      parts.push([revolve([[0.001, 0], [0.13, -0.03], [0.17, -0.12], [0.11, -0.24], [0.001, -0.30]], 12, true),
        trs(0, apex - 0.22, 0)]);
      return { stone: finish(parts) };
    });
  }

  /** A transverse / formeret rib arch spanning one bay edge. */
  ribArch(halfSpan, variant = 0) {
    const hs = Math.round(halfSpan * 20) / 20;
    return this._get(`rib|${hs}|${variant}`, () => {
      const rise = VAULT_RISE;
      const segs = 13;
      const path = [], up = [];
      for (let k = 0; k <= segs; k++) {
        const x = -hs + (2 * hs * k) / segs;
        path.push([x, archY(x, hs, rise) + 0.004, 0]);
        up.push([0, -1, 0]);
      }
      const parts = [[sweepProfile(path, up, ribProfile(V.ribW * 1.15, V.ribD * 1.05, 0.04), true), null]];
      // small boss at the crown
      parts.push([chamferBox(0.20, 0.16, 0.22, 0.03), trs(0, archY(0, hs, rise) - 0.16, 0)]);
      return { stone: finish(parts) };
    });
  }

  /** Broken rib stub for a collapsed bay — the vault did not vanish, it fell. */
  ribStub(variant) {
    return this._get(`ribstub|${variant}`, () => {
      const r = this._rnd(variant * 977 + 3);
      const len = 0.9 + r() * 1.5;
      const segs = 7;
      const path = [], up = [];
      const hs = 2.0;
      for (let k = 0; k <= segs; k++) {
        const x = -hs + (len * k) / segs;
        path.push([x, archY(x, hs, VAULT_RISE) - archY(-hs, hs, VAULT_RISE), 0]);
        up.push([0, -1, 0]);
      }
      const parts = [[sweepProfile(path, up, ribProfile(V.ribW * 1.15, V.ribD * 1.05, 0.04), true), null]];
      const g = rockChunk(0.36 + r() * 0.2, r, 0.42);
      parts.push([g, trs(path[segs][0], path[segs][1] - 0.08, 0)]);
      return { stone: finish(parts) };
    });
  }

  /* =========================================================== FLOORS == */

  /**
   * Floor slab. Varied plan size, chamfered arris, faint dish so the surface
   * has subsidence rather than reading as a plane.
   */
  slab(w, d, variant) {
    const sw = Math.round(w * 20) / 20, sd = Math.round(d * 20) / 20;
    return this._get(`slab|${sw}|${sd}|${variant}`, () => {
      const r = this._rnd(variant * 6151 + sw * 71 + sd * 13);
      const g = chamferBox(sw, F.thick, sd, 0.022 + r() * 0.02);
      // dish the top face: chamferBox is non-indexed so nudging y on up-facing
      // verts costs nothing and kills the "polished plane" read
      const p = g.attributes.position, n = g.attributes.normal;
      const cx = (r() - 0.5) * 0.3, cz = (r() - 0.5) * 0.3;
      for (let i = 0; i < p.count; i++) {
        if (n.getY(i) < 0.55) continue;
        const dx = (p.getX(i) - cx) / (sw * 0.5), dz = (p.getZ(i) - cz) / (sd * 0.5);
        const rr = Math.min(1, Math.hypot(dx, dz));
        p.setY(i, p.getY(i) - (1 - rr * rr) * F.subsidence * (0.4 + r() * 0.8));
      }
      p.needsUpdate = true;
      return { floor: finish([[g, null]], [variant * 0.83, 0, variant * 1.19]) };
    });
  }

  /** Cracked slab: two halves that have parted and tilted against each other. */
  slabCracked(w, d, variant) {
    const sw = Math.round(w * 20) / 20, sd = Math.round(d * 20) / 20;
    return this._get(`slabx|${sw}|${sd}|${variant}`, () => {
      const r = this._rnd(variant * 2237 + sw * 53);
      const parts = [];
      const split = 0.35 + r() * 0.3;
      const a = sw * split - 0.02, b = sw * (1 - split) - 0.02;
      parts.push([chamferBox(a, F.thick, sd, 0.026),
        trs(-sw * 0.5 + a * 0.5, -0.01, 0, (r() - 0.5) * F.tilt * 2, 0, F.tilt * (0.5 + r()))]);
      parts.push([chamferBox(b, F.thick, sd, 0.026),
        trs(sw * 0.5 - b * 0.5, -0.03, 0, (r() - 0.5) * F.tilt * 2, 0, -F.tilt * (0.5 + r()))]);
      return { floor: finish(parts, [variant * 1.11, 0, variant * 0.47]) };
    });
  }

  /** Exposed dirt beneath a missing slab, with a lip of broken bedding mortar. */
  slabVoid(w, d, variant) {
    const sw = Math.round(w * 20) / 20, sd = Math.round(d * 20) / 20;
    return this._get(`slabv|${sw}|${sd}|${variant}`, () => {
      const r = this._rnd(variant * 8191 + sd * 29);
      const pos = [], nor = [];
      const nx = 4, nz = 4;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const x0 = -sw * 0.5 + (sw * i) / nx, x1 = -sw * 0.5 + (sw * (i + 1)) / nx;
          const z0 = -sd * 0.5 + (sd * j) / nz, z1 = -sd * 0.5 + (sd * (j + 1)) / nz;
          const y = (a, b) => F.substrate - 0.02 - Math.abs(Math.sin(a * 3.1 + b * 2.3 + r() * 0.1)) * 0.05;
          pushQuadAuto(pos, nor,
            [x0, y(x0, z0), z0], [x1, y(x1, z0), z0], [x1, y(x1, z1), z1], [x0, y(x0, z1), z1]);
        }
      }
      const dirt = finishGeo(pos, nor);
      const parts = [];
      for (let k = 0; k < 5; k++) {
        const g = rockChunk(0.10 + r() * 0.14, r, 0.45);
        parts.push([g, trs((r() - 0.5) * sw * 0.8, F.substrate + 0.03, (r() - 0.5) * sd * 0.8,
          r() * 0.6, r() * TAU, r() * 0.6)]);
      }
      return { dirt: finish([[dirt, null]]), floor: parts.length ? finish(parts) : null };
    });
  }

  /* ========================================================== COLUMNS == */

  /**
   * Column: moulded base, fluted or clustered shaft, carved capital, abacus.
   * @param {number} variant 0 fluted, 1 clustered, 2 fluted+heavier capital
   */
  column(variant) {
    return this._get(`col|${variant}`, () => {
      const r = this._rnd(variant * 5501 + 41);
      const parts = [];
      const h = C.h;
      /* base */
      parts.push([revolve([
        [0.001, 0], [C.baseR, 0], [C.baseR, 0.13], [C.baseR - 0.05, 0.20],
        [C.shaftR + 0.13, 0.28], [C.shaftR + 0.15, 0.40], [C.shaftR + 0.05, 0.50],
        [C.shaftR + 0.02, 0.58],
      ], 20, true), trs(0, 0, 0)]);
      /* plinth under the base — square, chamfered, buried below the slab line */
      parts.push([chamferBox(C.baseR * 2.2, 0.16 + BURY, C.baseR * 2.2, 0.05), trs(0, 0.08 - BURY * 0.5, 0)]);

      const shaftTop = h - 0.72;
      if (variant === 1) {
        /* clustered: a core plus eight engaged shafts */
        parts.push([revolve([[C.shaftR * 0.72, 0], [C.shaftR * 0.72, shaftTop - 0.58]], 16, false),
          trs(0, 0.58, 0)]);
        const n = 8;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU;
          const rr = C.shaftR * 0.80;
          const g = revolve([
            [0.001, 0], [0.105, 0.01], [0.115, 0.05],
            [0.115, shaftTop - 0.62], [0.10, shaftTop - 0.58],
            [0.001, shaftTop - 0.56],
          ], 10, true);
          parts.push([g, trs(Math.cos(a) * rr, 0.58, Math.sin(a) * rr)]);
        }
      } else {
        const g = flutedShaft(C.shaftR * 0.88, C.shaftR, shaftTop - 0.58, variant === 2 ? 16 : 12, 28, 0.05, 4);
        parts.push([g, trs(0, 0.58, 0)]);
      }
      /* annulet + capital */
      parts.push([revolve([
        [C.shaftR + 0.02, 0], [C.shaftR + 0.06, 0.05], [C.shaftR + 0.05, 0.10],
      ], 18, true), trs(0, shaftTop - 0.02, 0)]);
      parts.push([revolve([
        [C.shaftR + 0.02, 0], [C.shaftR + 0.13, 0.16], [C.capR - 0.06, 0.32],
        [C.capR, 0.42], [C.capR - 0.02, 0.50],
      ], 20, true), trs(0, shaftTop + 0.08, 0)]);
      /* carved foliate lobes on the capital — chunky, catches raking light */
      const lobes = variant === 2 ? 10 : 8;
      for (let k = 0; k < lobes; k++) {
        const a = (k / lobes) * TAU + r() * 0.05;
        const rr = C.capR - 0.06;
        parts.push([chamferBox(0.20, 0.26, 0.13, 0.035),
          trs(Math.cos(a) * rr, shaftTop + 0.30, Math.sin(a) * rr, 0.22, -a, 0)]);
      }
      /* abacus */
      parts.push([chamferBox(C.capR * 2.05, 0.14, C.capR * 2.05, 0.04), trs(0, shaftTop + 0.65, 0)]);
      parts.push([chamferBox(C.capR * 1.85, 0.10, C.capR * 1.85, 0.03), trs(0, shaftTop + 0.55, 0)]);
      return { stone: finish(parts, [variant * 3.1, 0, 0]) };
    });
  }

  /** A fallen column: a broken stub plus drums lying where they rolled. */
  columnBroken(variant) {
    return this._get(`colbrk|${variant}`, () => {
      const r = this._rnd(variant * 7919 + 13);
      const parts = [];
      const stubH = 0.7 + r() * 1.5;
      parts.push([chamferBox(C.baseR * 2.2, 0.16 + BURY, C.baseR * 2.2, 0.05), trs(0, 0.08 - BURY * 0.5, 0)]);
      parts.push([revolve([
        [0.001, 0], [C.baseR, 0], [C.baseR, 0.13], [C.shaftR + 0.13, 0.28],
        [C.shaftR + 0.02, 0.52],
      ], 18, true), trs(0, 0.16, 0)]);
      const g = flutedShaft(C.shaftR * 0.97, C.shaftR, stubH, 12, 32, 0.05, 3);
      roughenVerts(g, 0.02, r);
      parts.push([g, trs(0, 0.66, 0)]);
      // fractured crown
      const cap = rockChunk(C.shaftR * 2.1, r, 0.34);
      parts.push([cap, trs(0, 0.66 + stubH - 0.04, 0, 0, r() * TAU, 0, 1, 0.42, 1)]);
      // drums on the floor
      const nd = 1 + Math.floor(r() * 3);
      for (let k = 0; k < nd; k++) {
        const a = r() * TAU, dist = 0.8 + r() * 1.9;
        const dh = 0.38 + r() * 0.34;
        const drum = flutedShaft(C.shaftR, C.shaftR * 1.02, dh, 12, 16, 0.045, 1);
        parts.push([drum, trs(Math.cos(a) * dist, C.shaftR * 0.98, Math.sin(a) * dist,
          Math.PI * 0.5 + (r() - 0.5) * 0.2, a + r(), (r() - 0.5) * 0.3)]);
      }
      return { stone: finish(parts) };
    });
  }

  /* ============================================================ STAIRS = */

  /** A flight of worn treads flanked by chamfered stringers. */
  stair(width, steps, rise = 0.17, tread = 0.32) {
    return this._get(`stair|${width}|${steps}|${rise}|${tread}`, () => {
      const r = this._rnd(steps * 131 + width * 17);
      const parts = [];
      for (let k = 0; k < steps; k++) {
        const w2 = width - r() * 0.10;
        const g = chamferBox(w2, rise + 0.05, tread + 0.06, 0.03 + r() * 0.02);
        parts.push([g, trs((r() - 0.5) * 0.03, rise * (k + 0.5) - 0.02, -tread * k,
          (r() - 0.5) * 0.01, 0, (r() - 0.5) * 0.012)]);
      }
      for (const sx of [-1, 1]) {
        const len = tread * steps + 0.4;
        parts.push([chamferBox(0.26, 0.42, len, 0.045),
          trs(sx * (width * 0.5 + 0.13), rise * steps * 0.5 - 0.05, -tread * steps * 0.5 + 0.1,
            Math.atan2(rise * steps, len) * 0.0, 0, 0)]);
      }
      return { stone: finish(parts) };
    });
  }

  /* ========================================================== FITTINGS = */

  /** Altar: stepped base, blind arcading on the frontal, moulded mensa. */
  altar(variant = 0) {
    return this._get(`altar|${variant}`, () => {
      const r = this._rnd(variant * 991 + 7);
      const parts = [];
      const w = 2.30, d = 1.05;
      parts.push([chamferBox(w + 0.5, 0.16 + 0.3, d + 0.5, 0.05), trs(0, 0.08 - 0.15, 0)]);
      parts.push([chamferBox(w + 0.24, 0.14, d + 0.24, 0.045), trs(0, 0.23, 0)]);
      parts.push([chamferBox(w, 0.72, d, 0.04), trs(0, 0.66, 0)]);
      /* blind arcade: five little pointed niches on each long face */
      const n = 5;
      for (const sz of [-1, 1]) {
        for (let k = 0; k < n; k++) {
          const x = (-(n - 1) / 2 + k) * (w / n);
          const hs = w / n * 0.34;
          const arc = archPath(hs, 1.34, 6, 0.30, 0);
          const pts = [[-hs, 0.02], [hs, 0.02]];
          for (let i = arc.length - 1; i >= 0; i--) pts.push(arc[i]);
          const g = bevelExtrude(pts, 0.10, 0.014);
          parts.push([g, trs(x, 0.36, sz * (d * 0.5 + 0.03), 0, sz > 0 ? 0 : Math.PI, 0)]);
        }
      }
      /* mensa with a heavy chamfered edge and a cavetto under it */
      parts.push([chamferBox(w + 0.30, 0.10, d + 0.30, 0.04), trs(0, 1.07, 0)]);
      parts.push([chamferBox(w + 0.44, 0.16, d + 0.44, 0.055), trs(0, 1.20, 0)]);
      /* offering cups + a fallen candle stub */
      for (let k = 0; k < 3; k++) {
        const x = (k - 1) * 0.62 + (r() - 0.5) * 0.12;
        parts.push([revolve([[0.001, 0], [0.10, 0.01], [0.11, 0.05], [0.07, 0.07], [0.001, 0.07]], 12, true),
          trs(x, 1.28, (r() - 0.5) * 0.24)]);
      }
      return { stone: finish(parts, [variant * 1.9, 0, 0]) };
    });
  }

  /** Sarcophagus. `variant` 1 = lid slid off and propped against the chest. */
  sarcophagus(variant) {
    return this._get(`sarc|${variant}`, () => {
      const r = this._rnd(variant * 3571 + 29);
      const parts = [];
      const w = 2.35, d = 0.98, h = 0.72;
      parts.push([chamferBox(w + 0.22, 0.11 + 0.3, d + 0.22, 0.04), trs(0, 0.055 - 0.15, 0)]);
      parts.push([chamferBox(w, h, d, 0.045), trs(0, 0.11 + h * 0.5, 0)]);
      /* arcaded side panels */
      for (const sz of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const x = (k - 1.5) * (w / 4.2);
          parts.push([chamferBox(w / 5.6, h * 0.56, 0.06, 0.02),
            trs(x, 0.11 + h * 0.52, sz * (d * 0.5 + 0.02))]);
        }
      }
      const lid = () => {
        const p = [];
        p.push([chamferBox(w + 0.14, 0.13, d + 0.14, 0.045), trs(0, 0, 0)]);
        // coped lid with a ridge
        p.push([chamferBox(w - 0.10, 0.16, d * 0.62, 0.05), trs(0, 0.13, 0)]);
        p.push([chamferBox(w - 0.34, 0.12, d * 0.30, 0.045), trs(0, 0.26, 0)]);
        // effigy suggestion: crossed hands and a sword down the centre
        p.push([chamferBox(0.16, 0.09, 1.55, 0.03), trs(0, 0.34, 0)]);
        p.push([chamferBox(0.34, 0.07, 0.13, 0.025), trs(0, 0.35, -0.30)]);
        return p;
      };
      if (variant === 1) {
        parts.push([chamferBox(w * 0.55, 0.10, d + 0.10, 0.04), trs(-w * 0.20, 0.11 + h + 0.05, 0)]);
        const l = mergeAll(lid());
        parts.push([l, trs(w * 0.62, 0.42, d * 0.35, 0, 0.22, -0.42)]);
        // spill of bones inside the open end
        for (let k = 0; k < 4; k++) {
          parts.push([rockChunk(0.12 + r() * 0.08, r, 0.5),
            trs(w * 0.22 + (r() - 0.5) * 0.5, 0.11 + h - 0.06, (r() - 0.5) * 0.5)]);
        }
      } else {
        for (const [g, m] of lid()) parts.push([g, m ? m.clone().premultiply(trs(0, 0.11 + h + 0.065, 0)) : trs(0, 0.11 + h + 0.065, 0)]);
      }
      return { stone: finish(parts, [variant * 2.7, 0, 0]) };
    });
  }

  /** Rubble pile — the debris every wall top and collapsed bay sheds. */
  rubble(variant, size = 1) {
    return this._get(`rubble|${variant}|${size}`, () => {
      const r = this._rnd(variant * 1237 + size * 71);
      const parts = [];
      const n = 5 + Math.floor(r() * 7);
      for (let k = 0; k < n; k++) {
        const s = (0.14 + r() * 0.42) * size;
        const a = r() * TAU, rad = r() * 0.75 * size;
        // half the pile is dressed stone that fell, half is shattered chunk
        const g = r() < 0.45
          ? chamferBox(s * 1.5, s * 0.75, s * 1.1, 0.03)
          : rockChunk(s * 1.4, r, 0.4);
        parts.push([g, trs(Math.cos(a) * rad, s * 0.30 + r() * 0.05, Math.sin(a) * rad,
          (r() - 0.5) * 0.9, r() * TAU, (r() - 0.5) * 0.9)]);
      }
      return { stone: finish(parts) };
    });
  }

  /** Loose bones and skulls for ossuary niches and floor drifts. */
  bones(variant) {
    return this._get(`bones|${variant}`, () => {
      const r = this._rnd(variant * 4423 + 11);
      const parts = [];
      const n = 3 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const len = 0.22 + r() * 0.24;
        const shaft = revolve([
          [0.001, 0], [0.045, 0.015], [0.055, 0.04], [0.030, 0.10],
          [0.028, len - 0.10], [0.052, len - 0.04], [0.042, len - 0.012], [0.001, len],
        ], 8, false);
        parts.push([shaft, trs((r() - 0.5) * 0.6, 0.045, (r() - 0.5) * 0.5,
          Math.PI * 0.5, r() * TAU, (r() - 0.5) * 0.4)]);
      }
      if (r() < 0.75) {
        const skull = revolve([
          [0.001, 0], [0.075, 0.01], [0.098, 0.055], [0.095, 0.11], [0.060, 0.155], [0.001, 0.165],
        ], 10, true);
        parts.push([skull, trs((r() - 0.5) * 0.4, 0.02, (r() - 0.5) * 0.4, 0.42, r() * TAU, 0)]);
        parts.push([chamferBox(0.085, 0.05, 0.07, 0.015),
          trs((r() - 0.5) * 0.4, 0.04, (r() - 0.5) * 0.4, 0.3, r() * TAU, 0)]);
      }
      return { bone: finish(parts) };
    });
  }

  /* ============================================================ METAL == */

  /** Wall sconce: iron bracket, drip pan, pitch-soaked stub. */
  sconce(variant = 0) {
    return this._get(`sconce|${variant}`, () => {
      const parts = [], wood = [];
      // back plate + two scrolled arms
      parts.push([chamferBox(0.20, 0.34, 0.06, 0.018), trs(0, 0, 0.03)]);
      parts.push([chamferBox(0.05, 0.05, 0.30, 0.014), trs(0, -0.02, 0.19, 0.5, 0, 0)]);
      parts.push([chamferBox(0.045, 0.20, 0.045, 0.012), trs(0, -0.16, 0.10, -0.35, 0, 0)]);
      // ring that holds the torch
      parts.push([revolve([[0.10, 0], [0.125, 0.012], [0.12, 0.05], [0.095, 0.055]], 12, true),
        trs(0, 0.09, 0.30)]);
      // drip pan
      parts.push([revolve([[0.001, 0], [0.13, 0.005], [0.145, 0.045], [0.12, 0.05], [0.001, 0.03]], 14, true),
        trs(0, -0.16, 0.28)]);
      wood.push([revolve([[0.001, 0], [0.045, 0.01], [0.05, 0.05], [0.042, 0.34], [0.055, 0.40], [0.001, 0.44]], 10, false),
        trs(0, -0.10, 0.30, 0.10, 0, 0)]);
      return { iron: finish(parts), wood: finish(wood) };
    });
  }

  /** Standing brazier: tripod, bowl, coals. Coals get the emissive material. */
  brazier(variant = 0) {
    return this._get(`brazier|${variant}`, () => {
      const r = this._rnd(variant * 2861 + 19);
      const iron = [], ember = [];
      const bowlY = 0.86;
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + 0.4;
        iron.push([chamferBox(0.075, bowlY + 0.10, 0.075, 0.02),
          trs(Math.cos(a) * 0.30, (bowlY + 0.10) * 0.5, Math.sin(a) * 0.30,
            Math.cos(a) * 0.16, 0, -Math.sin(a) * 0.16)]);
        // foot
        iron.push([chamferBox(0.16, 0.055, 0.16, 0.02), trs(Math.cos(a) * 0.36, 0.03, Math.sin(a) * 0.36)]);
      }
      // ring brace
      iron.push([revolve([[0.26, 0], [0.30, 0], [0.30, 0.045], [0.26, 0.045]], 16, true), trs(0, 0.40, 0)]);
      // bowl
      iron.push([revolve([
        [0.001, 0], [0.14, 0.02], [0.30, 0.12], [0.44, 0.26], [0.47, 0.34],
        [0.43, 0.35], [0.40, 0.26], [0.27, 0.13], [0.13, 0.045], [0.001, 0.03],
      ], 20, true), trs(0, bowlY, 0)]);
      // coals
      for (let k = 0; k < 9; k++) {
        const a = r() * TAU, rad = r() * 0.30;
        ember.push([rockChunk(0.09 + r() * 0.09, r, 0.5),
          trs(Math.cos(a) * rad, bowlY + 0.22 + r() * 0.05, Math.sin(a) * rad, r(), r() * TAU, r())]);
      }
      return { iron: finish(iron), ember: finish(ember) };
    });
  }

  /**
   * Flame body. Real geometry, not a sprite: three nested tapered lobes twisted
   * against each other, drawn with the emissive ember material so bloom has a
   * shaped source to grab. KNOWN_ISSUES calls out lights with no visible flame
   * as an instant fail, and a camera-facing quad is the other instant fail — so
   * the flame is a solid.
   */
  flame(scale = 1, variant = 0) {
    const s = Math.round(scale * 20) / 20;
    return this._get(`flame|${s}|${variant}`, () => {
      const r = this._rnd(variant * 3187 + s * 53);
      const parts = [];
      const lobes = 3;
      for (let k = 0; k < lobes; k++) {
        const h = (0.30 + 0.16 * k) * s;
        const w = (0.13 - 0.030 * k) * s;
        const prof = [
          [0.001, 0], [w * 0.72, h * 0.10], [w, h * 0.30], [w * 0.86, h * 0.52],
          [w * 0.46, h * 0.78], [w * 0.16, h * 0.94], [0.001, h],
        ];
        const g = revolve(prof, 9, false);
        parts.push([g, trs(
          (r() - 0.5) * 0.035 * s, (0.02 + 0.03 * k) * s, (r() - 0.5) * 0.035 * s,
          (r() - 0.5) * 0.16, r() * TAU, (r() - 0.5) * 0.16)]);
      }
      return { ember: finish(parts) };
    });
  }

  /** Hanging chain of alternating links. */
  chain(len, variant = 0) {
    const L = Math.round(len * 4) / 4;
    return this._get(`chain|${L}|${variant}`, () => {
      const parts = [];
      const link = 0.17, wire = 0.021;
      const n = Math.max(2, Math.round(L / (link * 0.72)));
      for (let k = 0; k < n; k++) {
        const g = new THREE.TorusGeometry(link * 0.36, wire, 5, 9);
        g.scale(1, 1.5, 1);
        parts.push([g, trs(0, -link * 0.72 * k - link * 0.5, 0,
          Math.PI * 0.5, (k & 1) ? Math.PI * 0.5 : 0, 0)]);
      }
      // eye bolt at the top
      parts.push([chamferBox(0.06, 0.14, 0.06, 0.016), trs(0, -0.05, 0)]);
      return { iron: finish(parts) };
    });
  }

  /** Iron portcullis with spiked bottom rail, seated in a chase. */
  portcullis(width, height, variant = 0) {
    const w = Math.round(width * 10) / 10, h = Math.round(height * 10) / 10;
    return this._get(`grate|${w}|${h}|${variant}`, () => {
      const r = this._rnd(variant * 5099 + w * 13);
      const parts = [];
      const bar = 0.062;
      const nv = Math.max(3, Math.round(w / 0.34));
      for (let k = 0; k <= nv; k++) {
        const x = -w * 0.5 + (w * k) / nv;
        parts.push([chamferBox(bar, h, bar, 0.016), trs(x, h * 0.5, (r() - 0.5) * 0.006)]);
        // spike
        parts.push([revolve([[0.001, 0], [bar * 0.7, 0.02], [bar * 0.55, 0.06], [0.001, 0.20]], 6, true),
          trs(x, -0.19, 0, Math.PI, 0, 0)]);
      }
      const nh = Math.max(2, Math.round(h / 0.62));
      for (let k = 0; k <= nh; k++) {
        const y = (h * k) / nh;
        parts.push([chamferBox(w, bar * 0.85, bar * 1.5, 0.016), trs(0, y, 0)]);
      }
      return { iron: finish(parts) };
    });
  }

  /** Iron-bound door leaf for portals that are shut. */
  doorLeaf(width, height, variant = 0) {
    const w = Math.round(width * 10) / 10, h = Math.round(height * 10) / 10;
    return this._get(`door|${w}|${h}|${variant}`, () => {
      const r = this._rnd(variant * 6607 + h * 7);
      const wood = [], iron = [];
      const nb = Math.max(4, Math.round(w / 0.22));
      for (let k = 0; k < nb; k++) {
        const bw = w / nb;
        wood.push([chamferBox(bw - 0.012, h, 0.085 + r() * 0.012, 0.014),
          trs(-w * 0.5 + bw * (k + 0.5), h * 0.5, 0)]);
      }
      for (let k = 0; k < 3; k++) {
        const y = h * (0.16 + k * 0.34);
        iron.push([chamferBox(w * 0.98, 0.085, 0.035, 0.012), trs(0, y, 0.058)]);
        for (let b = 0; b < 5; b++) {
          iron.push([revolve([[0.001, 0], [0.030, 0.004], [0.026, 0.022], [0.001, 0.026]], 7, true),
            trs(-w * 0.4 + (w * 0.8 * b) / 4, y, 0.075, Math.PI * 0.5, 0, 0)]);
        }
      }
      iron.push([revolve([[0.055, 0], [0.075, 0.01], [0.070, 0.035], [0.050, 0.04]], 12, true),
        trs(w * 0.30, h * 0.52, 0.08, Math.PI * 0.5, 0, 0)]);
      return { wood: finish(wood), iron: finish(iron) };
    });
  }

  /* ============================================================ ARENA == */

  /** A dais step ring segment for the boss arena (built as a chamfered wedge). */
  daisSegment(rInner, rOuter, aSpan, height, variant = 0) {
    const key = `dais|${rInner.toFixed(2)}|${rOuter.toFixed(2)}|${aSpan.toFixed(3)}|${height}|${variant}`;
    return this._get(key, () => {
      const pos = [], nor = [];
      const segs = Math.max(2, Math.round(aSpan / 0.14));
      const c = 0.035;
      for (let k = 0; k < segs; k++) {
        const a0 = -aSpan * 0.5 + (aSpan * k) / segs;
        const a1 = -aSpan * 0.5 + (aSpan * (k + 1)) / segs;
        const P = (a, rad, y) => [Math.cos(a) * rad, y, Math.sin(a) * rad];
        const ri = rInner, ro = rOuter;
        // top face (inset by the chamfer)
        pushQuadAuto(pos, nor, P(a0, ri + c, height), P(a1, ri + c, height), P(a1, ro - c, height), P(a0, ro - c, height));
        // outer chamfer + outer face
        pushQuadAuto(pos, nor, P(a0, ro - c, height), P(a1, ro - c, height), P(a1, ro, height - c), P(a0, ro, height - c));
        pushQuadAuto(pos, nor, P(a0, ro, height - c), P(a1, ro, height - c), P(a1, ro, 0), P(a0, ro, 0));
        // inner chamfer + inner face
        pushQuadAuto(pos, nor, P(a0, ri + c, height), P(a0, ri, height - c), P(a1, ri, height - c), P(a1, ri + c, height));
        pushQuadAuto(pos, nor, P(a0, ri, height - c), P(a0, ri, 0), P(a1, ri, 0), P(a1, ri, height - c));
      }
      return { floor: finish([[finishGeo(pos, nor), null]]) };
    });
  }

  /** Basalt buttress for the arena perimeter — a tapered, roughened mass. */
  buttress(variant, h = 6.2) {
    return this._get(`butt|${variant}|${h}`, () => {
      const r = this._rnd(variant * 8837 + 3);
      const parts = [];
      let y = 0;
      while (y < h - 0.2) {
        const bh = 0.55 + r() * 0.5;
        const t = y / h;
        const bw = 2.10 - t * 0.85 + (r() - 0.5) * 0.12;
        const bd = 1.30 - t * 0.55 + (r() - 0.5) * 0.10;
        const g = chamferBox(bw, Math.min(bh, h - y), bd, 0.05 + r() * 0.04);
        roughenVerts(g, 0.02, r);
        parts.push([g, trs((r() - 0.5) * 0.05, y + bh * 0.5, (r() - 0.5) * 0.05,
          0, (r() - 0.5) * 0.05, (r() - 0.5) * 0.014)]);
        y += bh;
      }
      // corbelled head that carries the chain ring
      parts.push([chamferBox(1.55, 0.26, 1.20, 0.06), trs(0, h + 0.08, 0.10)]);
      parts.push([chamferBox(1.15, 0.20, 0.95, 0.05), trs(0, h + 0.30, 0.06)]);
      return { rock: finish(parts) };
    });
  }

  /**
   * Cyclopean arena wall: huge roughened basalt courses with deep chamfers and
   * a corbelled parapet. Deliberately a different masonry language from the
   * crypt's dressed ashlar — hell was not built by masons with a plumb line.
   */
  arenaWall(len, height, variant) {
    const L = Math.max(0.6, Math.round(len * 5) / 5);
    const H = Math.round(height * 10) / 10;
    return this._get(`awall|${L}|${H}|${variant}`, () => {
      const r = this._rnd(variant * 6949 + L * 37 + H * 11);
      const parts = [];
      const back = -1.15;
      /* hidden mass so no light can pass and the wall has real thickness */
      parts.push([chamferBox(L, H, 0.95, 0.02), trs(0, H * 0.5, back + 0.475)]);
      /* base batter */
      parts.push([chamferBox(L, 0.52, 0.44, 0.07), trs(0, 0.26, -0.02)]);
      let y = 0.52;
      let stagger = r() * 0.6;
      while (y < H - 0.55) {
        const ch = 0.62 + r() * 0.42;
        const use = Math.min(ch, H - 0.55 - y);
        if (use < 0.22) break;
        let x = -L * 0.5 - stagger;
        let guard = 0;
        while (x < L * 0.5 && guard++ < 24) {
          const bw = 0.95 + r() * 0.85;
          const x0 = Math.max(-L * 0.5, x), x1 = Math.min(L * 0.5, x + bw);
          x += bw + 0.03;
          const eff = x1 - x0 - 0.035;
          if (eff < 0.16) continue;
          const dep = 0.22 + r() * 0.12;
          const g = chamferBox(eff, use - 0.035, dep, 0.05 + r() * 0.04);
          roughenVerts(g, 0.016, r);
          parts.push([g, trs((x0 + x1) * 0.5, y + use * 0.5, dep * 0.5 - 0.015,
            (r() - 0.5) * 0.02, (r() - 0.5) * 0.03, (r() - 0.5) * 0.016)]);
        }
        y += use;
        stagger = r() * 0.9;
      }
      /* corbel table + parapet coping */
      parts.push([chamferBox(L, 0.24, 0.62, 0.06), trs(0, H - 0.42, 0.10)]);
      const nc = Math.max(2, Math.round(L / 0.62));
      for (let k = 0; k < nc; k++) {
        parts.push([chamferBox(0.26, 0.20, 0.34, 0.045),
          trs(-L * 0.5 + (L * (k + 0.5)) / nc, H - 0.58, 0.24)]);
      }
      parts.push([chamferBox(L, 0.30, 0.74, 0.09), trs(0, H - 0.15, 0.06)]);
      return { rock: finish(parts, [variant * 2.9, variant * 1.4, 0]) };
    });
  }

  /** Obelisk / broken pillar marker for arena rim dressing. */
  obelisk(variant) {
    return this._get(`obelisk|${variant}`, () => {
      const r = this._rnd(variant * 9109 + 7);
      const parts = [];
      const h = 3.2 + r() * 2.6;
      parts.push([chamferBox(1.15, 0.22, 1.15, 0.05), trs(0, 0.11, 0)]);
      parts.push([chamferBox(0.95, 0.18, 0.95, 0.045), trs(0, 0.31, 0)]);
      const segs = 4;
      for (let k = 0; k < segs; k++) {
        const t0 = k / segs, t1 = (k + 1) / segs;
        const w0 = 0.72 - t0 * 0.30, w1 = 0.72 - t1 * 0.30;
        const g = chamferBox((w0 + w1) * 0.5, (h / segs), (w0 + w1) * 0.5, 0.035);
        roughenVerts(g, 0.012, r);
        parts.push([g, trs((r() - 0.5) * 0.02, 0.40 + h * (t0 + t1) * 0.5, (r() - 0.5) * 0.02,
          0, r() * 0.1, (r() - 0.5) * 0.02)]);
      }
      parts.push([rockChunk(0.5 + r() * 0.2, r, 0.4), trs(0, 0.40 + h, 0, 0, r() * TAU, 0, 1, 0.5, 1)]);
      return { rock: finish(parts) };
    });
  }

  /* =========================================================== GROUND == */

  /**
   * The rock mass that buries the crypt: a per-cell displaced lid over every
   * cell the layout marked solid, skirted down at the boundary so nothing shows
   * through and no exterior light can reach the interior.
   *
   * Built as one merged geometry (not instanced) — it is unique by definition.
   */
  rockMass(mask, grid, opts = {}) {
    const { W: gw, cell, originX, originZ } = grid;
    const top = opts.top ?? SPEC.cap.y;
    const edgeY = opts.edgeY ?? SPEC.cap.edgeY;
    const relief = opts.relief ?? SPEC.cap.relief;
    const floorY = opts.floorY ?? -0.6;
    const noise = opts.noise ?? (() => 0.5);

    // distance (in cells) from each solid cell to the nearest open cell, so the
    // lid can flatten as it approaches a wall and rise into lumps further out
    const dist = new Uint16Array(gw * gw);
    dist.fill(0xffff);
    const q = new Int32Array(gw * gw);
    let qh = 0, qt = 0;
    for (let j = 0; j < gw; j++) {
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        if (mask[k]) continue;
        dist[k] = 0;
        q[qt++] = k;
      }
    }
    while (qh < qt) {
      const k = q[qh++];
      const i = k % gw, j = (k / gw) | 0;
      const d = dist[k] + 1;
      if (d > 10) continue;
      for (let n = 0; n < 4; n++) {
        const ni = i + (n === 0 ? 1 : n === 1 ? -1 : 0);
        const nj = j + (n === 2 ? 1 : n === 3 ? -1 : 0);
        if (ni < 0 || nj < 0 || ni >= gw || nj >= gw) continue;
        const nk = nj * gw + ni;
        if (dist[nk] <= d) continue;
        dist[nk] = d;
        q[qt++] = nk;
      }
    }

    const hAt = (i, j) => {
      // vertex height: sample the 4 incident cells' distance so the lid drops to
      // the wall line smoothly instead of stepping
      let dmin = 0xffff;
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= gw || jj >= gw) continue;
          const d = mask[jj * gw + ii] ? dist[jj * gw + ii] : 0;
          if (d < dmin) dmin = d;
        }
      }
      if (dmin === 0xffff) dmin = 0;
      const t = Math.min(1, dmin / 4);
      const x = originX + i * cell, z = originZ + j * cell;
      const n = noise(x, z);
      return edgeY + (top - edgeY) * t + relief * (n - 0.5) * 2 * t;
    };

    let count = 0;
    for (let k = 0; k < mask.length; k++) if (mask[k]) count++;
    const tri = count * 2 + Math.round(count * 0.9);      // tops + skirts, generous
    const pos = new Float32Array(tri * 9);
    const nor = new Float32Array(tri * 9);
    let o = 0;
    const put = (a, b, c) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      if (o + 9 > pos.length) return;
      const t3 = [a, b, c];
      for (let s = 0; s < 3; s++) {
        pos[o] = t3[s][0]; pos[o + 1] = t3[s][1]; pos[o + 2] = t3[s][2];
        nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
        o += 3;
      }
    };

    for (let j = 0; j < gw; j++) {
      for (let i = 0; i < gw; i++) {
        if (!mask[j * gw + i]) continue;
        const x0 = originX + i * cell, x1 = x0 + cell;
        const z0 = originZ + j * cell, z1 = z0 + cell;
        const y00 = hAt(i, j), y10 = hAt(i + 1, j), y11 = hAt(i + 1, j + 1), y01 = hAt(i, j + 1);
        const a = [x0, y00, z0], b = [x1, y10, z0], c = [x1, y11, z1], e = [x0, y01, z1];
        put(a, c, b); put(a, e, c);
        // skirts wherever the neighbour is open — this is the visible rock face
        if (i === 0 || !mask[j * gw + i - 1]) { put([x0, y00, z0], [x0, floorY, z1], [x0, y01, z1]); put([x0, y00, z0], [x0, floorY, z0], [x0, floorY, z1]); }
        if (i === gw - 1 || !mask[j * gw + i + 1]) { put([x1, y10, z0], [x1, y11, z1], [x1, floorY, z1]); put([x1, y10, z0], [x1, floorY, z1], [x1, floorY, z0]); }
        if (j === 0 || !mask[(j - 1) * gw + i]) { put([x0, y00, z0], [x1, y10, z0], [x1, floorY, z0]); put([x0, y00, z0], [x1, floorY, z0], [x0, floorY, z0]); }
        if (j === gw - 1 || !mask[(j + 1) * gw + i]) { put([x0, y01, z1], [x0, floorY, z1], [x1, floorY, z1]); put([x0, y01, z1], [x1, floorY, z1], [x1, y11, z1]); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos.subarray(0, o), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor.subarray(0, o), 3));
    autoUV(g);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.tris += o / 9;
    return g;
  }

  /**
   * Coarse rock apron beyond the built footprint so the horizon is always rock,
   * never terrain. One merged ring at 2 m resolution.
   */
  rockApron(inner, outer, cell, noise, base = 0) {
    const pos = [], nor = [];
    const n = Math.ceil((outer * 2) / cell);
    const h = (x, z) => {
      const d = Math.max(Math.abs(x), Math.abs(z));
      const t = Math.min(1, Math.max(0, (d - inner * 0.5) / 8));
      return base + SPEC.cap.y + 0.25 + t * 2.2 + (noise(x, z) - 0.5) * (1.1 + t * 3.4);
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = -outer + i * cell, x1 = x0 + cell;
        const z0 = -outer + j * cell, z1 = z0 + cell;
        const inX = Math.max(Math.abs(x0), Math.abs(x1)) <= inner * 0.5;
        const inZ = Math.max(Math.abs(z0), Math.abs(z1)) <= inner * 0.5;
        if (inX && inZ) continue;
        const a = [x0, h(x0, z0), z0], b = [x1, h(x1, z0), z0];
        const c = [x1, h(x1, z1), z1], e = [x0, h(x0, z1), z1];
        pushQuadAuto(pos, nor, a, e, c, b);
      }
    }
    const g = finishGeo(pos, nor);
    g.computeBoundingSphere();
    this.tris += g.attributes.position.count / 3;
    return g;
  }

  /** Flat substrate under the whole level: dirt seen through missing slabs. */
  substrate(size, cell, noise, groundFn = null) {
    const pos = [], nor = [];
    const n = Math.max(2, Math.round(size / cell));
    const gfn = groundFn ?? (() => 0);
    const h = (x, z) => gfn(x, z) + F.substrate - 0.06 - noise(x * 0.7, z * 0.7) * 0.10;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x0 = -size * 0.5 + i * cell, x1 = x0 + cell;
        const z0 = -size * 0.5 + j * cell, z1 = z0 + cell;
        pushQuadAuto(pos, nor,
          [x0, h(x0, z0), z0], [x0, h(x0, z1), z1], [x1, h(x1, z1), z1], [x1, h(x1, z0), z0]);
      }
    }
    const g = finishGeo(pos, nor);
    g.computeBoundingSphere();
    this.tris += g.attributes.position.count / 3;
    return g;
  }
}

export default Kit;
