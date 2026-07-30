/**
 * SANCTUM — boss arena.
 *
 * A hexagonal basalt chamber, paved. A ritual apron of dressed radial slabs
 * carries the sigil ring at the centre; laid courses of basalt flagging run out
 * from it to a lava moat cut into the floor; cyclopean walls stand on six
 * corner buttresses with chains hanging from their corbelled heads.
 *
 * ---------------------------------------------------------------------------
 * TWO BUGS THIS FILE EXISTED TO CAUSE, AND WHY THE FIXES LOOK LIKE THIS
 * ---------------------------------------------------------------------------
 *
 * 1. **THE ARENA HAD NO FLOOR.** Every annular surface — floor, moat bed, lava,
 *    ambulatory, dais table — was emitted by one `annulus()` helper that walked
 *    its quad corners (angle-major, radius-minor). `pushQuadAuto` derives the
 *    face normal from that winding, and for this ordering the cross product
 *    points **down**: measured on the live scene, `arena:floor` had 8712 verts
 *    with normal.y = -1 and **zero** up-facing vertices, on a `FrontSide`
 *    material. Five meshes, all back-face culled, all invisible from an
 *    isometric camera. What the art director read as "a smooth featureless
 *    grey-brown gradient with no material" was the SKY DOME seen through the
 *    hole: hiding `sanctum.skyDome` dropped that region from luma 56.2 to 5.6,
 *    while tinting the floor material red, deleting its albedo map, and hiding
 *    the entire dungeon group each changed it by under 1.1 luma.
 *
 *    Every surface in this file is therefore emitted through `pushUp()` /
 *    `pushOut()`, which compute the face normal and **reorder the corners until
 *    it faces the way the caller asked for**. Winding is no longer something a
 *    call site can get wrong.
 *
 * 2. **THE FLOOR AND THE CAST WERE ON DIFFERENT SURFACES.** Bestiary grounds
 *    every body on `terrain.heightAt` (Bestiary.js:1290) and cannot be told
 *    otherwise from here. The hell heightfield swings from -0.26 m to +3.22 m
 *    inside the arena (mean 1.66), so a flat floor authored at y = 0 would have
 *    put the boss 2.7 m in the air and half the pack knee-deep in the stone.
 *    So the paving CONFORMS: every slab corner is sampled from the same ground
 *    function the bodies use, which makes contact exact rather than lucky, and
 *    turns the heightfield's relief into heaved, subsided paving instead of a
 *    flat plane (itself an instant-fail flag). The old 1.35 m dais is gone for
 *    the same reason — a raised platform nothing else knows about is a platform
 *    the boss stands 1.35 m below. It is now a 0.13 m ritual apron with a kerb,
 *    which is a floor pattern, not a plinth.
 *
 * ---------------------------------------------------------------------------
 * Material stack (the crypt's, adapted to a circular plan)
 * ---------------------------------------------------------------------------
 *   • laid slabs      — radial trapezoids, chamfered rim, subsidence dish, per
 *                       slab tint/hue/roughness jitter, ~12 % cracked and ~5 %
 *                       missing so the dirt bedding shows through
 *   • ritual apron    — finer courses, a dressed kerb ring, carved radial spokes
 *   • scorch          — slabs darken in clusters under the braziers and along
 *                       the fissures; baked into the tint, so it survives the
 *                       decal budget
 *   • glowing fissure — where the heightfield drops away, the paving stops and
 *                       an ember crust takes over: the frame's saturated accent
 *   • bone scatter    — clustered, never uniform
 *   • chains          — hanging from the corbels AND coiled on the floor
 *   • braziers        — a key quartet on the apron, a fill ring around it, and
 *                       six wall cressets so the walls are lit by something
 *
 * Per-slab colour rides on `aDungTint` / `aDungRough`, the same vertex
 * attributes Dungeon's weld path uses, so the whole 1000-slab floor is four
 * draw calls on programs that already exist.
 */

import * as THREE from 'three';
import { SPEC } from './Spec.js';
import { fbm2 } from '../../core/Rand.js';
import {
  finishGeo, pushQuadAuto, faceNormal, autoUV, trs, rockChunk, chamferBox, mergeAll,
} from './Geom.js';

const A = SPEC.arena;
const TAU = Math.PI * 2;
const DEG60 = Math.PI / 3;

/** Ritual apron: a floor pattern, not a plinth. See note 2 in the header. */
const APRON_R = 11.0;
const APRON_H = 0.13;
const KERB_W = 0.62;
const KERB_H = 0.26;

/** Joint width and arris chamfer, metres. 2·cham + joint ≈ 10 cm of groove. */
const JOINT = 0.030;
const CHAM = 0.035;
/** How far a slab's skirt drops into the bedding. */
const SKIRT = 0.11;

/** Radius of a regular hexagon with apothem `ap` at angle `a` (flat sides on the axes). */
function hexR(a, ap) {
  const t = ((a % DEG60) + DEG60) % DEG60 - DEG60 * 0.5;
  return ap / Math.cos(t);
}

/* ==================================================================== *
 * winding-safe emitters
 *
 * `pushQuadAuto` takes the normal from the corner order, so the corner order
 * IS the visible side. These wrappers make the caller state the side it wants
 * and fix the order to match — which is the whole content of bug 1.
 * ==================================================================== */

/** Emit a quad whose visible face points up. */
function pushUp(P, a, b, c, d) {
  const n = faceNormal(a, b, c);
  if (n[1] < 0) pushQuadAuto(P.pos, P.nor, a, d, c, b);
  else pushQuadAuto(P.pos, P.nor, a, b, c, d);
}

/** Emit a quad whose visible face points along (ox, oz) in plan. */
function pushOut(P, a, b, c, d, ox, oz) {
  const n = faceNormal(a, b, c);
  if (n[0] * ox + n[2] * oz < 0) pushQuadAuto(P.pos, P.nor, a, d, c, b);
  else pushQuadAuto(P.pos, P.nor, a, b, c, d);
}

/**
 * Vertex-attribute accumulator for a merged surface.
 *
 * `aDungTint` and `aDungRough` are the two attributes every dungeon material's
 * `onBeforeCompile` already declares (Dungeon.js `_instanceRoughness`), and both
 * guard on "is this actually bound", so filling them per-slab gives a thousand
 * stones their own value, temperature and gloss inside ONE mesh — no instancing,
 * no extra program, no extra draw.
 */
class Surface {
  constructor() { this.pos = []; this.nor = []; this.tint = []; this.rough = []; }

  get verts() { return this.pos.length / 3; }

  /**
   * Assign colour + roughness to every vertex emitted since `from`.
   * The hue skew matches Dungeon's weld bake exactly (`_flushWeld`), so a slab
   * here and a wall block there sit on the same value/temperature spread.
   */
  mark(from, tint, hue, rough) {
    const r = tint * (1 + hue * 0.050);
    const g = tint * (1 + hue * 0.010);
    const b = tint * (1 - hue * 0.046);
    for (let i = from, n = this.verts; i < n; i++) {
      this.tint.push(r, g, b);
      this.rough.push(rough);
    }
  }

  geometry() {
    if (this.pos.length < 9) return null;
    const g = finishGeo(this.pos, this.nor);
    g.setAttribute('aDungTint', new THREE.Float32BufferAttribute(this.tint, 3));
    g.setAttribute('aDungRough', new THREE.Float32BufferAttribute(this.rough, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * One laid slab, as a radial trapezoid.
 *
 * The top field is sampled from `hAt` at every node, so neighbours that share a
 * footprint edge share a height and the paving has no cracks even where the
 * ground underneath it swings a metre. Character comes from the subsidence dish,
 * a per-slab two-axis tilt, and the chamfered rim that turns each joint into a
 * shadow line rather than a seam.
 */
function emitSlab(P, a0, a1, ri, ro, hAt, o = {}) {
  const cham = o.cham ?? CHAM;
  const nu = o.nu ?? 2, nv = o.nv ?? 2;
  const rm = (ri + ro) * 0.5;
  const dj = JOINT / Math.max(0.5, rm);                 // joint as an angle
  const b0 = a0 + dj * 0.5, b1 = a1 - dj * 0.5;
  const q0 = ri + JOINT * 0.5, q1 = ro - JOINT * 0.5;
  if (b1 - b0 < 1e-3 || q1 - q0 < 0.12) return false;

  // inset top face; the chamfer runs from here out to the footprint edge
  const ca = cham / Math.max(0.5, rm);
  const t0 = b0 + ca, t1 = b1 - ca;
  const s0 = q0 + cham, s1 = q1 - cham;
  if (t1 <= t0 || s1 <= s0) return false;

  const tilt = o.tilt ?? 0;
  const tiltB = o.tiltB ?? 0;
  const dish = o.dish ?? 0.030;
  const lift = o.lift ?? 0;

  const NX = nu + 1, NZ = nv + 1;
  const X = new Array(NX * NZ), Z = new Array(NX * NZ), H = new Array(NX * NZ);
  for (let j = 0; j < NZ; j++) {
    const tv = j / nv;
    const rr = s0 + (s1 - s0) * tv;
    for (let i = 0; i < NX; i++) {
      const tu = i / nu;
      const aa = t0 + (t1 - t0) * tu;
      const x = Math.cos(aa) * rr, z = Math.sin(aa) * rr;
      const k = j * NX + i;
      X[k] = x; Z[k] = z;
      const bowl = (1 - Math.abs(tu * 2 - 1)) * (1 - Math.abs(tv * 2 - 1));
      H[k] = hAt(x, z) + lift - bowl * dish + tilt * (tu - 0.5) + tiltB * (tv - 0.5);
    }
  }
  const at = (i, j) => { const k = j * NX + i; return [X[k], H[k], Z[k]]; };

  const from = P.verts;

  /* top */
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      pushUp(P, at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }

  /* rim: chamfer out to the footprint edge, then a skirt into the bedding.
     The outward direction at each boundary node is taken from the slab centroid,
     which is correct for a trapezoid and needs no per-edge special cases. */
  let cxs = 0, czs = 0;
  for (let k = 0; k < NX * NZ; k++) { cxs += X[k]; czs += Z[k]; }
  const cx = cxs / (NX * NZ), cz = czs / (NX * NZ);

  const ring = [];
  for (let i = 0; i < NX; i++) ring.push([i, 0]);
  for (let j = 1; j < NZ; j++) ring.push([nu, j]);
  for (let i = nu - 1; i >= 0; i--) ring.push([i, nv]);
  for (let j = nv - 1; j >= 1; j--) ring.push([0, j]);

  const outw = ring.map(([i, j]) => {
    const k = j * NX + i;
    let dx = X[k] - cx, dz = Z[k] - cz;
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  });

  const skirt = o.skirt ?? SKIRT;
  for (let e = 0; e < ring.length; e++) {
    const f = (e + 1) % ring.length;
    const [i0, j0] = ring[e], [i1, j1] = ring[f];
    const p0 = at(i0, j0), p1 = at(i1, j1);
    const d0 = outw[e], d1 = outw[f];
    const e0 = [p0[0] + d0[0] * cham, p0[1] - cham * 0.8, p0[2] + d0[1] * cham];
    const e1 = [p1[0] + d1[0] * cham, p1[1] - cham * 0.8, p1[2] + d1[1] * cham];
    const g0 = [e0[0], e0[1] - skirt, e0[2]];
    const g1 = [e1[0], e1[1] - skirt, e1[2]];
    const mx = (d0[0] + d1[0]) * 0.5, mz = (d0[1] + d1[1]) * 0.5;
    pushOut(P, p0, p1, e1, e0, mx, mz);
    pushOut(P, e0, e1, g1, g0, mx, mz);
  }

  P.mark(from, o.tint ?? 1, o.hue ?? 0, o.rough ?? 1);
  return true;
}

/** A conforming annulus — used for the bedding and the moat, never for paving. */
function emitAnnulus(P, rA, rB, rings, segs, hFn, o = {}) {
  const from = P.verts;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    for (let k = 0; k < rings; k++) {
      const u0 = k / rings, u1 = (k + 1) / rings;
      const p = (a, u) => {
        const rr = rA + (rB - rA) * u;
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        return [x, hFn(x, z, u), z];
      };
      pushUp(P, p(a0, u0), p(a1, u0), p(a1, u1), p(a0, u1));
    }
  }
  P.mark(from, o.tint ?? 1, o.hue ?? 0, o.rough ?? 1);
}

/**
 * @param {import('../Dungeon.js').Dungeon} dungeon
 * @param {(min?:number,max?:number)=>number} r seeded PRNG
 */
export function buildArena(dungeon, r) {
  const kit = dungeon.kit;
  const ap = A.R;                       // apothem of the wall hexagon
  const outer = hexR(DEG60 * 0.5, ap);  // circumradius
  const chIn = A.channelInner, chOut = A.channelOuter;
  const chDepth = A.channelDepth;
  const wallIn = ap - 0.30;

  /* ================================================== GROUND REFERENCE ==
   *
   * The one function every body in the frame is standing on. Dungeon's `_g`
   * is `terrain.heightAt` clamped to ±4 m plus 3 cm of bedding mortar — the
   * same lift the crypt's flagging uses, so a foot sits 3 cm inside the stone
   * instead of 3 cm above it. Falls back through terrain, then to flat.
   */
  const G = (() => {
    if (typeof dungeon._g === 'function') {
      return (x, z) => { const v = dungeon._g(x, z); return Number.isFinite(v) ? v : 0; };
    }
    const t = dungeon.engine?.get?.('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      return (x, z) => {
        const v = t.heightAt(x, z);
        return Number.isFinite(v) ? Math.max(-4, Math.min(4, v)) + 0.03 : 0;
      };
    }
    return () => 0;
  })();

  /** Datum: the mean ground inside the paved disc. Fissures are measured off it. */
  let gSum = 0, gN = 0, gLo = 1e9, gHi = -1e9;
  for (let j = -20; j <= 20; j += 2) {
    for (let i = -20; i <= 20; i += 2) {
      if (i * i + j * j > 400) continue;
      const h = G(i, j);
      gSum += h; gN++;
      if (h < gLo) gLo = h;
      if (h > gHi) gHi = h;
    }
  }
  const gRef = gN ? gSum / gN : 0;

  /** Ground slope magnitude, sampled at paving scale. */
  const slopeAt = (x, z) => {
    const e = 0.75;
    const gx = (G(x + e, z) - G(x - e, z)) / (2 * e);
    const gz = (G(x, z + e) - G(x, z - e)) / (2 * e);
    return Math.hypot(gx, gz);
  };

  /** Where the heightfield has torn open. These become the glowing accent. */
  const FISSURE = -0.62;
  const isFissure = (x, z) => G(x, z) - gRef < FISSURE;
  const isBroken = (x, z) => slopeAt(x, z) > 0.40;

  /* Scorch field: authored clusters, not a uniform wash. Seeded ash pools sit
     under the brazier ring and drift off the apron edge. */
  const scorchPts = [];
  const scorch = (x, z) => {
    let v = 0;
    for (let i = 0; i < scorchPts.length; i++) {
      const s = scorchPts[i];
      const d = Math.hypot(x - s.x, z - s.z) / s.r;
      if (d < 1) v = Math.max(v, (1 - d) * (1 - d) * s.k);
    }
    return v;
  };

  /* ================================================ SURFACES ============ */

  const dressed = new Surface();   // apron + laid flagging          -> 'floor'
  const rough = new Surface();     // broken paving, scree, moat     -> 'rock'
  const bedding = new Surface();   // dirt under the slabs           -> 'dirt'
  const crust = new Surface();     // fissure crust                  -> 'ember'
  const molten = new Surface();    // lava in the moat and the rifts -> 'lava'

  /**
   * Dirt bedding, emitted ONLY under the cells that expose it.
   *
   * The first version of this laid one conforming skin under the whole paved
   * disc. It closed every hole, and it also added a second full-arena shading
   * layer that the slabs immediately overdrew — measured at +2.4 ms of frame
   * time for pixels nobody ever sees. A slab's 3 cm joint is closed by its own
   * 11 cm skirt at any camera pitch under 74°, so the only cells that need
   * bedding are the ones whose slab is gone.
   */
  const bed = (a0, a1, ri, ro) => {
    const from = bedding.verts;
    const p = (a, rr) => {
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      return [x, G(x, z) - 0.155 - fbm2(x * 0.9, z * 0.9, { octaves: 3, seed: 331 }) * 0.05, z];
    };
    const am = (a0 + a1) * 0.5, rm = (ri + ro) * 0.5;
    pushUp(bedding, p(a0, ri), p(am, ri), p(am, rm), p(a0, rm));
    pushUp(bedding, p(am, ri), p(a1, ri), p(a1, rm), p(am, rm));
    pushUp(bedding, p(a0, rm), p(am, rm), p(am, ro), p(a0, ro));
    pushUp(bedding, p(am, rm), p(a1, rm), p(a1, ro), p(am, ro));
    bedding.mark(from, 0.84, -0.25, 1.15);
  };

  /* ================================================ SCORCH SEEDS ======== */

  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * TAU + 0.4 + (r() - 0.5) * 0.5;
    const rr = APRON_R + 1.4 + r() * 3.2;
    scorchPts.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, r: 3.2 + r() * 2.4, k: 0.55 + r() * 0.3 });
  }
  for (let k = 0; k < 5; k++) {
    const a = r() * TAU, rr = 2.2 + r() * 7.0;
    scorchPts.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, r: 2.0 + r() * 2.0, k: 0.45 + r() * 0.35 });
  }

  /* ================================================ PAVING ============== */

  /**
   * Lay one concentric course. Slab width, course depth, the fraction cracked
   * and the fraction missing are all per-course, and the angular phase shifts
   * every course so no joint ever runs straight across the floor.
   */
  const layCourse = (ri, ro, o) => {
    const rm = (ri + ro) * 0.5;
    const want = o.slabW ?? 1.28;
    const n = Math.max(6, Math.round((TAU * rm) / want));
    const phase = r() * TAU;
    for (let k = 0; k < n; k++) {
      const a0 = phase + (k / n) * TAU;
      const a1 = phase + ((k + 1) / n) * TAU;
      const am = (a0 + a1) * 0.5;
      const x = Math.cos(am) * rm, z = Math.sin(am) * rm;

      /* --- ground story decides what this cell even is --- */
      if (isFissure(x, z)) {
        emitSlab(crust, a0, a1, ri, ro, G, {
          nu: 1, nv: 1, cham: 0.06, skirt: 0.34, dish: 0.10, lift: -0.10,
          tint: 0.58 + r() * 0.22, hue: 0.9, rough: 1.2,
        });
        continue;
      }
      if (isBroken(x, z)) {
        emitSlab(rough, a0, a1, ri, ro, G, {
          nu: 2, nv: 2, cham: 0.05, skirt: 0.18, dish: 0.075,
          tilt: (r() - 0.5) * 0.10, tiltB: (r() - 0.5) * 0.12,
          lift: -0.02, tint: 0.82 + r() * 0.28, hue: (r() - 0.5) * 0.8, rough: 1.18,
        });
        continue;
      }

      const roll = r();
      const sc = scorch(x, z);
      /* value + temperature: scorch darkens and cools, dust warms */
      const tint = (0.92 + r() * 0.32) * (1 - sc * 0.46);
      const hue = (r() - 0.5) * 0.8 - sc * 0.55;
      const rgh = 0.84 + r() * 0.40 + sc * 0.22;

      if (roll < (o.gone ?? 0.05)) {
        /* slab gone: the bedding shows, with a lip of broken mortar */
        bed(a0, a1, ri, ro);
        const lipA = a0 + (a1 - a0) * (0.2 + r() * 0.3);
        emitSlab(rough, a0, lipA, ri, ro, G, {
          nu: 1, nv: 1, cham: 0.05, skirt: 0.16, dish: 0.02, lift: -0.10,
          tint: 0.78 + r() * 0.2, hue: -0.3, rough: 1.2,
        });
        continue;
      }
      if (roll < (o.gone ?? 0.05) + (o.cracked ?? 0.12)) {
        /* cracked: two halves that have parted and tipped against each other */
        const split = 0.36 + r() * 0.28;
        const ax = a0 + (a1 - a0) * split;
        emitSlab(dressed, a0, ax, ri, ro, G, {
          nu: 1, nv: 2, cham: CHAM, dish: 0.035, lift: o.lift ?? 0,
          tilt: 0.03 + r() * 0.03, tiltB: (r() - 0.5) * 0.05,
          tint, hue, rough: rgh,
        });
        emitSlab(dressed, ax, a1, ri, ro, G, {
          nu: 1, nv: 2, cham: CHAM, dish: 0.035, lift: (o.lift ?? 0) - 0.015,
          tilt: -(0.03 + r() * 0.03), tiltB: (r() - 0.5) * 0.05,
          tint: tint * 0.96, hue, rough: rgh,
        });
        continue;
      }

      emitSlab(dressed, a0, a1, ri, ro, G, {
        nu: o.nu ?? 2, nv: o.nv ?? 2, cham: CHAM,
        dish: o.dish ?? 0.034, lift: o.lift ?? 0,
        tilt: (r() - 0.5) * 0.045, tiltB: (r() - 0.5) * 0.05,
        tint, hue, rough: rgh,
      });
    }
  };

  /* ---- centre medallion: the ground the boss is fought on ---- */
  {
    const n = 9;
    const phase = r() * TAU;
    for (let k = 0; k < n; k++) {
      emitSlab(dressed, phase + (k / n) * TAU, phase + ((k + 1) / n) * TAU, 0.02, 1.35, G, {
        nu: 2, nv: 2, cham: 0.04, dish: 0.024, lift: APRON_H,
        tint: 1.02 + r() * 0.2, hue: 0.35 + (r() - 0.5) * 0.4, rough: 0.80 + r() * 0.22,
      });
    }
  }

  /* ---- ritual apron: finer courses, tighter joints, less damage ---- */
  {
    let rr = 1.35;
    let course = 0;
    while (rr < APRON_R - 0.4) {
      const d = 0.92 + (course % 3) * 0.16 + r() * 0.10;
      const ro = Math.min(APRON_R - 0.05, rr + d);
      layCourse(rr, ro, {
        slabW: 1.02 + r() * 0.22, lift: APRON_H,
        cracked: 0.09, gone: 0.02, dish: 0.026, nu: 2, nv: 2,
      });
      rr = ro;
      course++;
    }
  }

  /* ---- kerb ring: a dressed course standing 13 cm proud of the flagging,
     which is what makes the apron read as a built thing and not a decal ---- */
  {
    const n = 46;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * TAU, a1 = ((k + 1) / n) * TAU;
      const gone = r() < 0.09;
      emitSlab(gone ? rough : dressed, a0, a1, APRON_R - 0.05, APRON_R + KERB_W, G, {
        nu: 1, nv: 1, cham: 0.05, skirt: 0.36, dish: 0.012,
        lift: gone ? APRON_H * 0.4 : KERB_H,
        tilt: (r() - 0.5) * 0.03, tiltB: (r() - 0.5) * 0.04,
        tint: (gone ? 0.84 : 1.02) + r() * 0.18,
        hue: 0.3 + (r() - 0.5) * 0.5, rough: 0.78 + r() * 0.3,
      });
    }
  }

  /* ---- outer flagging: bigger stones, more damage, more scorch ---- */
  {
    let rr = APRON_R + KERB_W;
    let course = 0;
    while (rr < chIn - 0.5) {
      const d = 1.24 + (course % 4) * 0.18 + r() * 0.14;
      const ro = Math.min(chIn - 0.15, rr + d);
      layCourse(rr, ro, {
        slabW: 1.34 + r() * 0.34,
        cracked: 0.14, gone: 0.06, dish: 0.038, nu: 2, nv: 2,
      });
      rr = ro;
      course++;
    }
  }

  /* ---- radial spokes: twelve carved channels crossing the apron courses,
     the only element allowed to run straight through a joint ---- */
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU + 0.13;
    const w = 0.115 / APRON_R;
    const hot = k % 3 === 0;
    emitSlab(hot ? crust : rough, a - w, a + w, 1.5, APRON_R - 0.1, G, {
      nu: 1, nv: 9, cham: 0.018, skirt: 0.10, dish: 0.0,
      lift: APRON_H - 0.055,
      tint: hot ? 0.9 : 0.62, hue: hot ? 1.0 : -0.4, rough: 1.1,
    });
  }

  /* ---- glowing rifts: short crack runs off the apron, following the
     paving grain. These are the frame's saturated accent inside 15 m. ---- */
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * TAU + 0.61 + (r() - 0.5) * 0.24;
    const r0 = APRON_R + KERB_W + 0.3 + r() * 1.8;
    const len = 1.8 + r() * 3.4;
    const w = 0.085 / (r0 + len * 0.5);
    emitSlab(molten, a - w, a + w, r0, r0 + len, G, {
      nu: 1, nv: 5, cham: 0.02, skirt: 0.06, dish: 0.0, lift: -0.20,
      tint: 0.95, hue: 1.0, rough: 1.0,
    });
    emitSlab(crust, a - w * 3.1, a + w * 3.1, r0 - 0.16, r0 + len + 0.16, G, {
      nu: 1, nv: 5, cham: 0.05, skirt: 0.22, dish: 0.055, lift: -0.055,
      tint: 0.6 + r() * 0.2, hue: 0.85, rough: 1.2,
    });
  }

  /* ================================================ MOAT =============== */

  /* inner scarp -> bed -> outer scarp, all conforming, all facing up/out */
  {
    const NA = 108;
    const bedIn = chIn + 0.62, bedOut = chOut - 0.62;
    const from = rough.verts;
    for (let i = 0; i < NA; i++) {
      const a0 = (i / NA) * TAU, a1 = ((i + 1) / NA) * TAU;
      const P = (a, rr, dy) => {
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        return [x, G(x, z) + dy, z];
      };
      /* the lip starts 0.25 m inside the last flagging course so the two
         surfaces overlap — a butt joint here left a visible annular slit */
      pushOut(rough,
        P(a0, chIn - 0.25, -0.02), P(a1, chIn - 0.25, -0.02),
        P(a1, bedIn, -chDepth), P(a0, bedIn, -chDepth),
        Math.cos((a0 + a1) * 0.5), Math.sin((a0 + a1) * 0.5));
      pushUp(rough,
        P(a0, bedIn, -chDepth), P(a1, bedIn, -chDepth),
        P(a1, bedOut, -chDepth - 0.07), P(a0, bedOut, -chDepth - 0.07));
      pushOut(rough,
        P(a0, bedOut, -chDepth - 0.07), P(a1, bedOut, -chDepth - 0.07),
        P(a1, chOut, 0.0), P(a0, chOut, 0.0),
        -Math.cos((a0 + a1) * 0.5), -Math.sin((a0 + a1) * 0.5));
    }
    rough.mark(from, 0.74, -0.2, 1.15);
  }

  /* lava surface, a hair under the scarp lip so the crust reads as a bank */
  emitAnnulus(molten, chIn - 0.05, chOut + 0.05, 3, 108,
    (x, z) => G(x, z) - chDepth * 0.44 + fbm2(x * 0.22, z * 0.22, { octaves: 3, seed: 733 }) * 0.05,
    { tint: 1, hue: 1, rough: 1 });

  /* ---- ambulatory between the moat and the wall: coarse, cheap, off-frame ---- */
  {
    let rr = chOut;
    while (rr < wallIn - 0.4) {
      const ro = Math.min(wallIn - 0.05, rr + 1.5 + r() * 0.4);
      layCourse(rr, ro, {
        slabW: 2.0 + r() * 0.5, cracked: 0.18, gone: 0.10,
        dish: 0.04, nu: 1, nv: 1,
      });
      rr = ro;
    }
  }

  /* ---- commit the five surfaces ---- */
  const commit = (surf, key, name, o = {}) => {
    const g = surf.geometry();
    if (!g) return null;
    return dungeon.pushUnique(g, key, { name, castShadow: false, receiveShadow: true, ...o });
  };
  commit(bedding, 'dirt', 'arena:bedding');
  commit(dressed, 'floor', 'arena:paving');
  commit(rough, 'rock', 'arena:paving-rough');
  commit(crust, 'ember', 'arena:fissure-crust');
  const lavaMesh = commit(molten, 'lava', 'arena:lava', { receiveShadow: false });
  if (lavaMesh) lavaMesh.userData.skyNoFog = false;

  /* ============================================================ WALLS == */

  const wallLen = 2 * ap * Math.tan(DEG60 * 0.5);
  const cressets = [];
  for (let side = 0; side < 6; side++) {
    const a = DEG60 * side;
    const nx = Math.cos(a), nz = Math.sin(a);
    const cx = nx * ap, cz = nz * ap;
    // face normal points inward: -n. Wall pieces face +Z, so yaw maps +Z -> -n.
    const yaw = Math.atan2(-nx, -nz);
    const tx = -nz, tz = nx;
    let s = -wallLen * 0.5 + 0.4;
    let guard = 0;
    while (s < wallLen * 0.5 - 0.4 && guard++ < 60) {
      const len = 2.2 + Math.round(r() * 2) * 0.6;
      const use = Math.min(len, wallLen * 0.5 - 0.4 - s);
      if (use < 0.8) break;
      const mid = s + use * 0.5;
      const px = cx + tx * mid, pz = cz + tz * mid;
      /*
       * Seated on the heightfield and buried, so no panel shows a gap or a hard
       * intersection line where the ground rolls under it.
       *
       * AND IT CASTS NOTHING. This is the brief's "unlit 6.2 m rock reading as a
       * hole": not a rock, and not unlit. A 6.2 m panel lit by a cresset 1.5 m in
       * front of it throws its own shadow 30 m across the paving, and because that
       * streak runs away from an isometric lens it lands on screen as a straight
       * hard-edged vertical black band 40 px wide beside the boss. Measured over
       * the band's own 73 x 89 px window on the frozen boss frame:
       *
       *   as built ........................... mean luma 0.033, 86 % under 0.035
       *   these panels hidden ................ mean luma 0.150, 23 % under 0.035
       *   renderer.shadowMap.enabled = false . mean luma 0.149, 23 % under 0.035
       *   built as non-casters (this fix) .... mean luma 0.150, 23 % under 0.035
       *
       * Hiding the caster, disabling shadow sampling, and building the caster as a
       * non-caster all give the same number to within noise, which is what
       * identifies the shape as this geometry's shadow rather than its surface.
       * Over the whole play area, merged solid black went 1.90 % -> 0.07 % and the
       * frame mean rose 0.139 -> 0.151. Nothing is lost by not casting: the wall is
       * the room's boundary, the closed vault above it still casts, and there is
       * nothing behind a boundary wall for it to shade.
       *
       * (Toggling `castShadow` on these meshes at RUNTIME proves nothing either way
       * — Lighting runs the practical maps with `autoUpdate = false` and re-freezes
       * them, so the map on screen is the one rendered at build time. That is why
       * this has to be a build-time flag and why an hour of live probing said the
       * casters were innocent.)
       */
      dungeon.pushPiece(kit.arenaWall(use, A.wallH, (r() * 3) | 0),
        trs(px, G(px, pz) - 0.34, pz, 0, yaw, 0),
        0.86 + r() * 0.26, 0.88 + r() * 0.32, (r() - 0.5) * 0.7, false);
      s += use;
    }

    /* corner buttress + a mid-side pilaster — same no-cast rule as the panels,
       they are the same 6.2 m of near-vertical stone at the same rim */
    const ca = a + DEG60 * 0.5;
    const cr = hexR(ca, ap) - 0.55;
    const bx = Math.cos(ca) * cr, bz = Math.sin(ca) * cr;
    /* ruined: see `Kit.buttress` — an intact 6.2 m pier out here at 28 m is
       outside every practical's reach and reads as a hole, not as masonry */
    dungeon.pushPiece(kit.buttress((r() * 3) | 0, A.wallH, true),
      trs(bx, G(bx, bz) - 0.36, bz, 0, Math.atan2(-Math.cos(ca), -Math.sin(ca)), 0),
      0.82 + r() * 0.22, 0.92 + r() * 0.3, (r() - 0.5) * 0.6, false);
    const mx = cx - nx * 0.5, mz = cz - nz * 0.5;
    dungeon.pushPiece(kit.buttress((r() * 3) | 0, A.wallH - 0.9),
      trs(mx, G(mx, mz) - 0.36, mz, 0, yaw, 0),
      0.82 + r() * 0.22, 0.92 + r() * 0.3, (r() - 0.5) * 0.6, false);

    /* the cresset that actually lights this wall face — the critic's "flat
       black untextured trapezoids" were untextured only in the sense that
       nothing within 13 m was throwing light at them. Mounted on the front
       face of the mid-side pilaster (which projects 1.15 m), 3.35 m up.
     *
     * ONE PER SIDE, AND NOT MORE. Tried three per side (the run is 28.9 m long, so
     * the panels near each corner sit 14.5 m from the only flame aimed at them):
     * it made the frame WORSE, not better — merged solid black went 1.99 % -> 2.51 %
     * and the void's largest blob grew from 3103 px to 8031 px. Two reasons. Each
     * extra cresset is also an extra unlit sconce prop bolted to a dark wall, and
     * more practicals means Lighting's importance cut evicts brighter ones. The
     * arena is already asking for 24 practicals against roughly 14 slots. */
    cressets.push({ x: cx - nx * 1.42, z: cz - nz * 1.42, yaw, side });

    /* chains from the corner corbels into the dark */
    for (let k = 0; k < 2; k++) {
      const aa = ca + (r() - 0.5) * 0.22;
      const rr = cr - 1.6 - r() * 3.4;
      const chx = Math.cos(aa) * rr, chz = Math.sin(aa) * rr;
      dungeon.pushPiece(kit.chain(2.4 + r() * 4.2, 0),
        trs(chx, G(chx, chz) + A.wallH + 0.2, chz, 0, r() * TAU, 0),
        0.92, 0.85, -0.35, false);
    }
  }

  /* ========================================================== LIGHTING = *
   *
   * Composition, in four tiers, priority-ordered because Lighting importance-
   * selects and only ~14 practicals survive the cut:
   *   key   4 heavy braziers at the apron corbels — this is the boss's light
   *   rim   6 wall cressets, high and aimed inward — separates the silhouette
   *         from the wall AND is the only thing lighting the masonry
   *   fill  6 braziers outside the kerb, uneven spacing
   *   bounce moat practicals, unshadowed, so the up-light is continuous
   */

  const blocked = [];
  const block = (x, z, rad) => blocked.push({ x, z, r: rad });

  /*
   * NO SHADOW-CASTING PRACTICALS IN THIS ROOM.
   *
   * The wall panels above stop casting, so nothing in here needs to be the light
   * that makes them cast. Practicals are also the wrong lamps to hang a shadow map
   * on at all in an interior: Lighting freezes them (`shadow.autoUpdate = false`,
   * `needsUpdate = false`), so the map is rendered once, from before this room's
   * ground settled — `_setMode` moves the floor after the build, which is what the
   * `groundMoved` guard in Dungeon.js exists for. Twenty-four flames in one room
   * means nothing here is more than 5 m from a second one, so occlusion from any
   * single flame buys very little and can only be wrong by construction.
   *
   * Hell already renders with no directional shadow cascades: an earlier pass
   * removed them for throwing frame-crossing wedges, and this is the same artefact
   * from a point light. Bodies keep their contact shadows from the `decals:contact`
   * pool, which is a screen-space pass and unaffected.
   */
  for (let k = 0; k < 4; k++) {
    const a = DEG60 * 0.5 + (k / 4) * TAU + 0.08;
    const rr = APRON_R - 2.6;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    dungeon.fixture('brazier', x, G(x, z) + APRON_H, z, r() * TAU, {
      kelvin: 2650, saturation: 1.4, type: 'hellfire',
      intensity: 40 + r() * 10, radius: 23, priority: 1.95, glow: 0.7, shadow: false,
    });
    block(x, z, 0.62);
  }

  /* rim: on the pilaster faces, 3.35 m up, so the masonry is lit from 1.5 m
     away instead of 13 m away, which is the entire reason it read as black */
  for (const c of cressets) {
    dungeon.fixture('sconce', c.x, G(c.x, c.z) + 3.35, c.z, c.yaw, {
      kelvin: 2100 + r() * 160, saturation: 1.25, type: 'torch',
      intensity: 96 + r() * 24, radius: 18 + r() * 3, priority: 1.5, glow: 0, shadow: false,
    });
  }

  /* fill: an uneven ring just outside the kerb */
  {
    const NB = 6;
    for (let k = 0; k < NB; k++) {
      const a = (k / NB) * TAU + 0.21 + (r() - 0.5) * 0.34;
      const rr = APRON_R + 1.5 + r() * 1.4;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      dungeon.fixture('brazier', x, G(x, z), z, r() * TAU, {
        kelvin: 2600, saturation: 1.35, type: 'hellfire',
        intensity: 34 + r() * 10, radius: 20 + r() * 4, priority: 1.22, glow: 0.6, shadow: false,
      });
      block(x, z, 0.62);
    }
  }

  /* bounce: the moat itself */
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + 0.4;
    const rr = (chIn + chOut) * 0.5;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    dungeon.addTorch({
      kind: 'point', type: 'lava', position: [x, G(x, z) - chDepth * 0.44 + 0.55, z],
      kelvin: 1300, saturation: 1.3, intensity: 30 + r() * 12, radius: 22 + r() * 6,
      flicker: 0.5, priority: 0.62, shadow: false,
    });
  }

  /* the rifts glow, so give two of them a real (tiny) practical */
  for (let k = 0; k < 2; k++) {
    const a = (k / 2) * TAU + 0.61;
    const rr = APRON_R + 2.6;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    dungeon.addTorch({
      kind: 'point', type: 'lava', position: [x, G(x, z) + 0.22, z],
      kelvin: 1450, saturation: 1.35, intensity: 14 + r() * 5, radius: 9,
      flicker: 0.7, priority: 0.55, shadow: false,
    });
  }

  /* ========================================================== DRESSING = */

  /** Clustered scatter: pick a few anchors, then drop everything around them. */
  const clusters = (count, per, rMin, rMax, spread, fn) => {
    for (let c = 0; c < count; c++) {
      const a = (c / count) * TAU + (r() - 0.5) * 0.9;
      const rr = rMin + r() * (rMax - rMin);
      const ax = Math.cos(a) * rr, az = Math.sin(a) * rr;
      const n = Math.max(1, Math.round(per * (0.55 + r() * 0.9)));
      for (let i = 0; i < n; i++) {
        const aa = r() * TAU, dd = Math.sqrt(r()) * spread;
        fn(ax + Math.cos(aa) * dd, az + Math.sin(aa) * dd, i, c);
      }
    }
  };

  /* obelisks and broken masses on the ambulatory */
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * TAU + r() * 0.4;
    const rr = chOut + 0.85 + r() * 0.6;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    dungeon.pushPiece(kit.obelisk((r() * 3) | 0),
      trs(x, G(x, z) - 0.1, z, 0, Math.atan2(-x, -z) + (r() - 0.5) * 0.3, 0),
      0.76 + r() * 0.22, 0.94 + r() * 0.28, (r() - 0.5) * 0.6);
  }

  /* rubble drifts — clustered against the kerb and out on the flagging */
  clusters(7, 5, APRON_R + 0.9, chIn - 2.5, 2.1, (x, z) => {
    if (Math.hypot(x, z) > chIn - 1.0) return;
    dungeon.pushPiece(kit.rubble((r() * 4) | 0, 0.5 + r() * 0.9),
      trs(x, G(x, z) - 0.04, z, 0, r() * TAU, 0),
      0.74 + r() * 0.24, 0.95 + r() * 0.3, (r() - 0.5) * 0.6);
  });
  /* scree where the ground is too steep to have held its paving */
  clusters(5, 4, 4.0, chIn - 3.0, 2.6, (x, z) => {
    if (!isBroken(x, z) && r() < 0.55) return;
    dungeon.pushPiece(kit.rubble((r() * 4) | 0, 0.4 + r() * 0.7),
      trs(x, G(x, z) - 0.03, z, 0, r() * TAU, 0),
      0.70 + r() * 0.22, 1.0 + r() * 0.3, (r() - 0.5) * 0.7);
  });

  /* bone scatter — four ossuary drifts on the apron, none uniform */
  clusters(4, 6, 2.4, APRON_R - 1.4, 1.7, (x, z) => {
    dungeon.pushPiece(kit.bones((r() * 3) | 0),
      trs(x, G(x, z) + APRON_H + 0.01, z, 0, r() * TAU, 0),
      0.86 + r() * 0.2, 0.95, 0.45, false);
  });
  clusters(3, 4, APRON_R + 1.0, chIn - 3.0, 2.2, (x, z) => {
    dungeon.pushPiece(kit.bones((r() * 3) | 0),
      trs(x, G(x, z) + 0.01, z, 0, r() * TAU, 0),
      0.80 + r() * 0.2, 1.0, 0.2, false);
  });

  /* chains: five hanging into frame over the apron ring, plus coils on the
     floor — a chain lying in the light is worth two hanging in the dark */
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + 0.9 + (r() - 0.5) * 0.4;
    const rr = APRON_R + 1.0 + r() * 3.6;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    dungeon.pushPiece(kit.chain(3.2 + r() * 2.6, 0),
      trs(x, G(x, z) + A.wallH + 1.4, z, 0, r() * TAU, 0),
      0.92, 0.85, -0.35, false);
  }
  clusters(4, 2, 3.0, chIn - 4.0, 1.6, (x, z) => {
    /* a chain laid flat: rotate it onto the ground and let it run */
    dungeon.pushPiece(kit.chain(1.4 + r() * 2.0, 0),
      trs(x, G(x, z) + 0.055, z, Math.PI * 0.5 + (r() - 0.5) * 0.12, r() * TAU, 0),
      0.88, 0.9, -0.3, false);
  });

  /* a shattered ring of standing stones marking the boss's ground */
  {
    const parts = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      const rr = APRON_R - 4.2;
      const h = 0.9 + r() * 0.8;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const g = chamferBox(0.42, h, 0.30, 0.045);
      parts.push([g, trs(x, G(x, z) + APRON_H + h * 0.5 - 0.06, z,
        (r() - 0.5) * 0.12, -a, (r() - 0.5) * 0.12)]);
    }
    const sigilGeo = mergeAll(parts);
    autoUV(sigilGeo);
    sigilGeo.computeBoundingSphere();
    dungeon.pushUnique(sigilGeo, 'stone', { name: 'arena:sigil', castShadow: true });
  }

  /* glowing cinder heaps, clustered in the scorch pools where they belong */
  {
    const parts = [];
    for (const s of scorchPts) {
      const n = 2 + ((r() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const aa = r() * TAU, dd = Math.sqrt(r()) * s.r * 0.7;
        const x = s.x + Math.cos(aa) * dd, z = s.z + Math.sin(aa) * dd;
        const rr = Math.hypot(x, z);
        if (rr > chIn - 1.2) continue;
        const lift = rr < APRON_R ? APRON_H : 0;
        parts.push([rockChunk(0.15 + r() * 0.20, r, 0.5),
          trs(x, G(x, z) + lift + 0.035, z, r(), r() * TAU, r())]);
      }
    }
    if (parts.length) {
      const cg = mergeAll(parts);
      autoUV(cg);
      cg.computeBoundingSphere();
      dungeon.pushUnique(cg, 'ember', { name: 'arena:cinders', castShadow: false });
    }
  }

  /* ============================================================== NAV == */

  const cell = 0.5;
  const gw = Math.ceil((outer * 2 + 4) / cell);
  const originX = -gw * cell * 0.5, originZ = -gw * cell * 0.5;
  const nav = new Uint8Array(gw * gw);
  const clear = new Float32Array(gw * gw);
  const inArena = (x, z) => {
    const rr = Math.hypot(x, z);
    if (rr > chIn - 0.55) return false;
    for (let i = 0; i < blocked.length; i++) {
      const b = blocked[i];
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r) return false;
    }
    return true;
  };
  /* A rift is a hole in the floor and a scree face is a wall; the AI should
     path around both. Guarded: if the heightfield ever turned most of the
     arena unwalkable this would strand the fight, so it is applied only while
     it costs under a third of the cells. */
  const hazard = new Uint8Array(gw * gw);
  let hazardCount = 0, openCount = 0;
  for (let j = 0; j < gw; j++) {
    for (let i = 0; i < gw; i++) {
      const x = originX + (i + 0.5) * cell, z = originZ + (j + 0.5) * cell;
      const k = j * gw + i;
      if (!inArena(x, z)) continue;
      openCount++;
      if (isFissure(x, z) || isBroken(x, z)) { hazard[k] = 1; hazardCount++; }
    }
  }
  const useHazard = openCount > 0 && hazardCount / openCount < 0.34;
  for (let j = 0; j < gw; j++) {
    for (let i = 0; i < gw; i++) {
      const x = originX + (i + 0.5) * cell, z = originZ + (j + 0.5) * cell;
      const k = j * gw + i;
      nav[k] = inArena(x, z) && !(useHazard && hazard[k]) ? 1 : 0;
    }
  }
  // chamfer clearance transform, same kernel as NavGrid
  const SQ2 = Math.SQRT2, FAR = 1e6;
  for (let j = 0; j < gw; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      if (!nav[k]) { clear[k] = 0; continue; }
      let v = FAR;
      if (i > 0) v = Math.min(v, clear[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, clear[k - gw] + 1);
        if (i > 0) v = Math.min(v, clear[k - gw - 1] + SQ2);
        if (i < gw - 1) v = Math.min(v, clear[k - gw + 1] + SQ2);
      }
      clear[k] = v;
    }
  }
  for (let j = gw - 1; j >= 0; j--) {
    for (let i = gw - 1; i >= 0; i--) {
      const k = j * gw + i;
      if (!nav[k]) continue;
      let v = clear[k];
      if (i < gw - 1) v = Math.min(v, clear[k + 1] + 1);
      if (j < gw - 1) {
        v = Math.min(v, clear[k + gw] + 1);
        if (i < gw - 1) v = Math.min(v, clear[k + gw + 1] + SQ2);
        if (i > 0) v = Math.min(v, clear[k + gw - 1] + SQ2);
      }
      clear[k] = v;
    }
  }
  for (let k = 0; k < clear.length; k++) clear[k] = Math.min(clear[k] * cell, 12);

  const idx = (x, z) => {
    const i = Math.floor((x - originX) / cell), j = Math.floor((z - originZ) / cell);
    if (i < 0 || j < 0 || i >= gw || j >= gw) return -1;
    return j * gw + i;
  };

  /* =========================================================== SPAWNS == */

  const spawns = { player: [], enemy: [], boss: [], prop: [], loot: [], light: [] };
  /**
   * The arena's own floor height. Now the SAME field the bodies stand on
   * (see note 2), so AI y and Bestiary y agree to within the 13 cm apron rise.
   */
  const heightAt = (x, z) => {
    const rr = Math.hypot(x, z);
    const g = G(x, z);
    if (rr < APRON_R) return g + APRON_H;
    if (rr < APRON_R + KERB_W) return g + KERB_H;
    if (rr < chIn) return g;
    if (rr < chOut) return g - chDepth;
    return g;
  };

  spawns.player.push({ x: 1.2, z: 13.8, y: heightAt(1.2, 13.8) });
  spawns.boss.push({ x: 0, z: -2.6, y: heightAt(0, -2.6) });
  for (let k = 0; k < 22; k++) {
    const a = r() * TAU, rr = 6 + r() * (chIn - 8);
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const ii = idx(x, z);
    if (ii < 0 || !nav[ii] || clear[ii] < 1.1) continue;
    spawns.enemy.push({ x, z, y: heightAt(x, z) });
  }
  for (let k = 0; k < 18; k++) {
    const a = r() * TAU, rr = chIn - 1.6 - r() * 4;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    spawns.prop.push({ x, z, y: heightAt(x, z) });
  }
  for (let k = 0; k < 10; k++) {
    const a = r() * TAU, rr = 4 + r() * 8;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    spawns.loot.push({ x, z, y: heightAt(x, z) });
  }

  return {
    rooms: [{
      id: 0, kind: 'arena', grand: true,
      cx: 0, cz: 0, w: outer * 2, d: outer * 2,
      minX: -outer, maxX: outer, minZ: -outer, maxZ: outer,
      doors: [], bays: null,
    }],
    bounds: {
      minX: -outer - 2, maxX: outer + 2, minZ: -outer - 2, maxZ: outer + 2,
      minY: gLo - chDepth - 0.6, maxY: gHi + A.wallH + 2.4,
    },
    navMask: { data: nav, clearance: clear, W: gw, cell, originX, originZ },
    nav: (x, z) => { const i = idx(x, z); return i >= 0 && nav[i] === 1; },
    clearanceAt: (x, z) => { const i = idx(x, z); return i >= 0 ? clear[i] : 0; },
    heightAt,
    spawns,
  };
}

export default buildArena;
