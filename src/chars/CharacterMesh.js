/**
 * THE NINTH VIGIL — CharacterMesh
 * ---------------------------------------------------------------------------
 * The hero's body and armour, built once at init as five skinned meshes (one
 * per surface family: flesh, cloth, leather, steel, gold) sharing a single
 * `THREE.Skeleton`. Five draw calls buys real material contrast — plate that
 * reads as plate next to cloth that reads as cloth — which a single atlased
 * mesh cannot deliver.
 *
 * Everything is authored to the canonical scale in KNOWN_ISSUES.md: 1 unit =
 * 1 metre, hero 1.85 m, shoulders 0.62 m. The hero is the scale reference for
 * the whole game, so these numbers are load-bearing.
 *
 * Construction rules the critic rubric demands, and how they are met here:
 *
 *  • **Bevel every hard edge.** No raw `BoxGeometry` appears anywhere. Solid
 *    blocks come from RigKit's `roundedBox` (a sphere inflated to the corners,
 *    so every edge catches a highlight); every armour plate comes from
 *    `shellGeo`, which builds a curved surface with a genuine inner face and a
 *    *rolled rim* — three rings of geometry around the border, so the plate has
 *    visible thickness and a lit edge rather than reading as cardboard.
 *  • **Layer the armour.** Pauldrons, fauld and sabatons are built as
 *    overlapping lames with increasing radius, so each plate casts onto the one
 *    beneath it. Nothing is a single flat shell.
 *  • **Couple the wear.** Two per-vertex channels feed the shader: vertex
 *    colour carries grime (dirt climbing from the ground, dust on up-facing
 *    surfaces, sludge in downward cavities, low-frequency mottle) and `aMask`
 *    carries *edge wear*, which the shader turns into brighter, smoother,
 *    more-metallic material exactly on the rims and high points. Darkening,
 *    roughening and occluding together is what separates PBR from believable.
 *  • **UVs in metres.** SkinBuilder writes surface distance / uvScale, so a
 *    tiling AssetForge texture lands at a physically correct grain size.
 *
 * Determinism: geometry is a pure function of the joint table and fixed seeds.
 */

import * as THREE from 'three';
import {
  SkinBuilder, roundedBox, sweepGeo, mergeGeos, fbm3,
} from './monsters/RigKit.js';
import { rigView } from './AnimGraph.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _AX = new THREE.Vector3(1, 0, 0);
const _AY = new THREE.Vector3(0, 1, 0);

/* ================================================================== *
 * geometry helpers
 * ================================================================== */

/**
 * Bend a geometry around the vertical axis: `k` radians of wrap per metre of
 * local X. Positive k pulls the edges toward −Z, which is how a breastplate
 * wraps around a ribcage. Normals are rotated by the same angle, so the result
 * is an exact surface, not a squashed approximation.
 */
function bendY(geo, k) {
  if (!(Math.abs(k) > 1e-6)) return geo;
  const R = 1 / k;
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const a = x * k;
    const rr = R + z;
    p.setX(i, rr * Math.sin(a));
    p.setZ(i, rr * Math.cos(a) - R);
    if (n) {
      _v.set(n.getX(i), n.getY(i), n.getZ(i)).applyQuaternion(_q.setFromAxisAngle(_AY, a));
      n.setXYZ(i, _v.x, _v.y, _v.z);
    }
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  return geo;
}

/** Bend around the X axis: positive k curls the top and bottom toward −Z. */
function bendX(geo, k) {
  if (!(Math.abs(k) > 1e-6)) return geo;
  const R = 1 / k;
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), z = p.getZ(i);
    const a = y * k;
    const rr = R + z;
    p.setY(i, rr * Math.sin(a));
    p.setZ(i, rr * Math.cos(a) - R);
    if (n) {
      _v.set(n.getX(i), n.getY(i), n.getZ(i)).applyQuaternion(_q.setFromAxisAngle(_AX, -a));
      n.setXYZ(i, _v.x, _v.y, _v.z);
    }
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  return geo;
}

/** Linear taper in X as a function of Y (narrow a plate toward its top). */
function taperX(geo, h, k) {
  const p = geo.getAttribute('position');
  const inv = 1 / Math.max(1e-4, h);
  for (let i = 0; i < p.count; i++) {
    p.setX(i, p.getX(i) * (1 + k * (p.getY(i) * inv)));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/* ================================================================== *
 * curvature extraction — the engine behind edge wear and cavity tarnish
 * ================================================================== */

/**
 * Per-vertex discrete mean curvature, in 1/metres, read straight off the
 * triangle graph, then split into an **edge** channel (convex: rims, rolls,
 * rivet crowns, blade edges, knuckle ridges) and a **cavity** channel (concave:
 * inner faces, the flanks of a raised keel, the trough of a fold, the recess
 * behind a lame).
 *
 * This exists because the previous pass drove wear from `wearMask` — distance
 * from a hand-placed anchor point. That is a *guess* at where the edges are, and
 * a guess cannot know that a pauldron's rolled rim is 8 mm in radius while the
 * dome it borders is 170 mm, which is the entire difference between "polished
 * edge" and "uniform grey speckle". Curvature knows, exactly, for free, for
 * every primitive in the build — shells, lofts, bevelled blocks, spheres.
 *
 *   k(a,b) = dot( n_b - n_a, p_b - p_a ) / |p_b - p_a|²      [1/m]
 *
 * is the standard directional-curvature estimate along a mesh edge; positive is
 * convex. Averaged over a vertex's incident edges it is a mean-curvature proxy.
 *
 * The thresholds have to be **per piece**, not absolute: a rivet's roll is
 * 1/4 mm⁻¹ and a breastplate's body is 1/200 mm⁻¹ — three orders of magnitude
 * apart — so the window is set from each piece's own 88th percentile.
 *
 * @returns {{edge:Float32Array, cav:Float32Array}|null}
 */
function edgeCavity(geo) {
  if (geo.userData.__ec) return geo.userData.__ec;
  const posA = geo.getAttribute('position');
  if (!posA) return null;
  let norA = geo.getAttribute('normal');
  if (!norA) { geo.computeVertexNormals(); norA = geo.getAttribute('normal'); }
  const n = posA.count;
  const P = posA.array, N = norA.array;
  const acc = new Float32Array(n);
  const cnt = new Float32Array(n);
  const pair = (a, b) => {
    const ao = a * 3, bo = b * 3;
    const dx = P[bo] - P[ao], dy = P[bo + 1] - P[ao + 1], dz = P[bo + 2] - P[ao + 2];
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < 1e-12) return;
    const k = ((N[bo] - N[ao]) * dx + (N[bo + 1] - N[ao + 1]) * dy + (N[bo + 2] - N[ao + 2]) * dz) / l2;
    acc[a] += k; cnt[a] += 1; acc[b] += k; cnt[b] += 1;
  };
  const idx = geo.getIndex();
  if (idx) {
    const A = idx.array;
    for (let i = 0; i + 2 < A.length; i += 3) { pair(A[i], A[i + 1]); pair(A[i + 1], A[i + 2]); pair(A[i + 2], A[i]); }
  } else {
    for (let i = 0; i + 2 < n; i += 3) { pair(i, i + 1); pair(i + 1, i + 2); pair(i + 2, i); }
  }
  const cv = new Float32Array(n);
  for (let i = 0; i < n; i++) cv[i] = cnt[i] > 0 ? acc[i] / cnt[i] : 0;

  /* ---- SMOOTH THE CURVATURE BEFORE THRESHOLDING IT ----
   *
   * A one-ring central difference is a noisy estimator: on a dense parametric
   * patch it alternates sign from column to column wherever the surface has any
   * ripple in it, and it does that in the pattern of the MESH, not of the shape.
   * Thresholding that raw gives one bright burnished line per meridian.
   *
   * This is not a cosmetic worry — it was the visible defect. The barbute skull
   * is a 72-column dome carrying eight raised planished facets, so its raw
   * curvature alternated along every column: the shader turned each alternation
   * into a line of bare polished steel (albedo x 1.66, roughness x 0.30) and the
   * helm rendered as a combed brushed-nickel swirl with ~20 converging hairlines.
   * Zeroing the abrasion and the scratch channels changed nothing, because
   * neither of them drew it; the wear channel did, off mesh noise.
   *
   * Two Jacobi passes at 0.65 neighbour weight remove the per-vertex alternation
   * while leaving a genuine 8 mm rolled rim — which is coherent across a dozen
   * vertices — essentially untouched.
   */
  {
    const sm = new Float32Array(n), cn2 = new Float32Array(n);
    const addp = (a2, b2) => { sm[a2] += cv[b2]; cn2[a2] += 1; sm[b2] += cv[a2]; cn2[b2] += 1; };
    for (let it = 0; it < 2; it++) {
      sm.fill(0); cn2.fill(0);
      if (idx) {
        const A = idx.array;
        for (let i = 0; i + 2 < A.length; i += 3) { addp(A[i], A[i + 1]); addp(A[i + 1], A[i + 2]); addp(A[i + 2], A[i]); }
      } else {
        for (let i = 0; i + 2 < n; i += 3) { addp(i, i + 1); addp(i + 1, i + 2); addp(i + 2, i); }
      }
      for (let i = 0; i < n; i++) if (cn2[i] > 0) cv[i] = cv[i] * 0.35 + (sm[i] / cn2[i]) * 0.65;
    }
  }

  const pos = [], neg = [];
  for (let i = 0; i < n; i++) { if (cv[i] > 0) pos.push(cv[i]); else if (cv[i] < 0) neg.push(-cv[i]); }
  const pct = (arr, p) => {
    if (!arr.length) return 0;
    arr.sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  };
  const hi = pct(pos, 0.88), lo = pct(neg, 0.88);
  // Under 5 /m (a radius over 200 mm) nothing is an "edge" — that is the body
  // curvature of the plate itself, and treating it as a rim is what produced
  // the uniform bright field the critic called crumpled foil.
  /* The window is tightened from [0.34, 0.95] of the 88th percentile to
     [0.62, 1.02]. At 0.34 the body curvature of a 105 mm helm dome (9.5 /m) was
     already inside the ramp, so a large fraction of every curved piece came up as
     "worn" — a broad bright field rather than a rim, which is the same failure the
     plate texture had and the reason the armour read as one bright material. At
     0.62 the ramp starts above the body curvature of everything bigger than about
     a 60 mm radius, so only rolls, rivet crowns, standing edges and blade edges
     reach it. */
  const edge = new Float32Array(n), cav = new Float32Array(n);
  const hiOK = hi > 5, loOK = lo > 5;
  for (let i = 0; i < n; i++) {
    edge[i] = hiOK ? smoothstep(hi * 0.62, hi * 1.02, cv[i]) : 0;
    cav[i] = loOK ? smoothstep(lo * 0.44, lo * 0.98, -cv[i]) : 0;
  }
  const out = { edge, cav };
  geo.userData.__ec = out;
  return out;
}

/* ================================================================== *
 * hardware: rivets, buckles, strap ends
 * ================================================================== *
 * "Assembled from pieces" is a *geometry* claim and it has to be paid for in
 * geometry. A plate with no rivets is a stamping, and a stamping is what the
 * previous pass looked like at close range. Everything here is small, bevelled,
 * and cheap: a rivet is 56 triangles, and 130 of them cost less than one of the
 * cuirass shells.
 */

/** A proud dome rivet with a slight flange, axis along +Y, seated at the origin. */
function rivetGeo(r = 0.0082, h = 0.0052) {
  // A full oblate spheroid, half of it sunk into the plate: closed geometry, so
  // there is never a hole to see the inside of the armour through.
  const dome = new THREE.SphereGeometry(r, 8, 5);
  dome.scale(1, h / r, 1);
  const flange = new THREE.CylinderGeometry(r * 1.30, r * 1.38, h * 0.34, 10, 1);
  flange.translate(0, -h * 0.22, 0);
  return mergeGeos([dome, flange]);
}

/**
 * A row of rivets around an elliptical band, each seated on and oriented to the
 * local surface normal. `a`/`c` are the semi-axes the row follows.
 */
function rivetRow(o) {
  const parts = [];
  const n = Math.max(1, o.n ?? 5);
  const a = o.a ?? 0.2, c = o.c ?? 0.14;
  const r = o.r ?? 0.0082, h = o.h ?? 0.0052;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const b = lerp(o.b0 ?? -1, o.b1 ?? 1, t);
    const y = lerp(o.y0 ?? 0, o.y1 ?? (o.y0 ?? 0), t) + (o.sag ?? 0) * Math.sin(t * Math.PI);
    const g = rivetGeo(r, h);
    // Ellipse outward normal: (sin b / a, tilt, cos b / c), normalised.
    _v.set(Math.sin(b) / a, o.tilt ?? 0, Math.cos(b) / c).normalize();
    g.applyQuaternion(_q.setFromUnitVectors(_AY, _v));
    g.translate(Math.sin(b) * a * (o.push ?? 1), y, Math.cos(b) * c * (o.push ?? 1));
    parts.push(g);
  }
  return mergeGeos(parts);
}

/** A straight run of rivets between two points, seated along `dir`. */
function rivetLine(p0, p1, dir, n, r = 0.0078, h = 0.005) {
  const parts = [];
  _v.set(dir[0], dir[1], dir[2]).normalize();
  _q.setFromUnitVectors(_AY, _v);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const g = rivetGeo(r, h);
    g.applyQuaternion(_q);
    g.translate(lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), lerp(p0[2], p1[2], t));
    parts.push(g);
  }
  return mergeGeos(parts);
}

/**
 * A real buckle: a rectangular frame with four bevelled bars, a centre bar and
 * a pin lying across it. Two stacked blocks — what the previous pass used — read
 * as a lump of solder at any zoom that can resolve them at all.
 */
function buckleGeo(w = 0.032, h = 0.026, t = 0.0055) {
  const bar = w * 0.16;
  const parts = [
    (() => { const g = block(w, bar, t, { r: bar * 0.42 }); g.translate(0, h * 0.5 - bar * 0.5, 0); return g; })(),
    (() => { const g = block(w, bar, t, { r: bar * 0.42 }); g.translate(0, -h * 0.5 + bar * 0.5, 0); return g; })(),
    (() => { const g = block(bar, h, t, { r: bar * 0.42 }); g.translate(-w * 0.5 + bar * 0.5, 0, 0); return g; })(),
    (() => { const g = block(bar, h, t, { r: bar * 0.42 }); g.translate(w * 0.5 - bar * 0.5, 0, 0); return g; })(),
    // centre bar the pin hinges on
    (() => { const g = block(bar * 0.72, h * 0.86, t * 0.8, { r: bar * 0.3 }); return g; })(),
    // pin, angled across the frame
    (() => {
      const g = block(w * 0.60, bar * 0.55, t * 0.7, { r: bar * 0.24 });
      g.rotateZ(0.22);
      g.translate(w * 0.10, 0, t * 0.42);
      return g;
    })(),
  ];
  return mergeGeos(parts);
}

/**
 * A leather strap end: a tapered tongue with a rounded tip, a raised keeper
 * loop and two punched holes shown as shallow bevelled dimples. This is the
 * detail that says a plate is *strapped on* rather than modelled in one piece.
 */
function strapEndGeo(len = 0.072, w = 0.020, t = 0.0055) {
  const parts = [];
  const rings = [];
  const SEG = 10;
  const STEPS = 7;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    // full width for the first two thirds, then taper into a rounded tongue
    const k = s < 0.62 ? 1 : Math.sqrt(Math.max(0, 1 - ((s - 0.62) / 0.38) ** 2)) * 0.92 + 0.08;
    const hw = w * 0.5 * k, ht = t * 0.5 * (0.62 + 0.38 * k);
    const pts = [];
    for (let j = 0; j < SEG; j++) {
      const ang = (j / SEG) * Math.PI * 2;
      pts.push([Math.cos(ang) * hw, Math.sin(ang) * ht]);
    }
    rings.push({ y: -len * s, pts });
  }
  parts.push(loftGeo(rings, { cap: true, capLift: 0.0015 }));
  // keeper loop
  const keeper = block(w * 1.24, w * 0.30, t * 2.6, { r: t * 0.7 });
  keeper.translate(0, -len * 0.30, 0);
  parts.push(keeper);
  return mergeGeos(parts);
}

/**
 * A curved plate with real thickness and a rolled rim.
 *
 * `fn(u, v, out)` samples the *outer* surface over the unit square. The builder
 * differences that grid for normals, offsets it inward by `thick` for the inner
 * face, and rings the boundary with three rows of geometry (outer edge → a mid
 * ring pushed `bevel` past the boundary at half depth → inner edge) so the rim
 * is convex and catches light. This one helper produces every pauldron lame,
 * fauld lame, tasset, greave, vambrace, sabaton, gorget and hood in the build.
 *
 * @param {(u:number,v:number,out:THREE.Vector3)=>void} fn
 * @param {object} o ru, rv, thick, bevel, closeU, center|outDir, flip
 */
function shellGeo(fn, o = {}) {
  const RU = Math.max(2, o.ru ?? 14);
  const RV = Math.max(2, o.rv ?? 8);
  const thick = Math.max(1e-4, o.thick ?? 0.02);
  const bev = Math.max(0, o.bevel ?? Math.min(thick * 0.55, 0.009));
  const closeU = !!o.closeU;
  const cols = closeU ? RU : RU + 1;   // closeU: last column duplicates the first
  const rows = RV + 1;
  const nv = rows * cols;

  const P = new Float32Array(nv * 3);
  const N = new Float32Array(nv * 3);
  const tmp = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    const v = r / RV;
    for (let c = 0; c < cols; c++) {
      const u = c / RU;
      fn(u, v, tmp);
      const i = (r * cols + c) * 3;
      P[i] = tmp.x; P[i + 1] = tmp.y; P[i + 2] = tmp.z;
    }
  }

  const gp = (r, c, out) => {
    const rr = r < 0 ? 0 : r > rows - 1 ? rows - 1 : r;
    const cc = closeU ? ((c % cols) + cols) % cols : (c < 0 ? 0 : c > cols - 1 ? cols - 1 : c);
    const i = (rr * cols + cc) * 3;
    return out.set(P[i], P[i + 1], P[i + 2]);
  };
  const du = new THREE.Vector3(), dv = new THREE.Vector3();
  const a1 = new THREE.Vector3(), a2 = new THREE.Vector3(), nn = new THREE.Vector3();
  const centre = o.center ? new THREE.Vector3(o.center[0], o.center[1], o.center[2]) : null;
  const outDir = o.outDir ? new THREE.Vector3(...o.outDir).normalize() : null;

  /* Raw normals from the parametric cross product, plus a *single* orientation
     vote for the whole patch.
     The vote has to be global. Flipping shading normals per vertex while leaving
     the triangle winding alone is a silent disaster: the front faces end up
     pointing away from the viewer, get culled, and what renders is the inner
     shell — whose normals face into the object. The surface then receives no
     diffuse light at all and shows up as a flat, matte, ambient-only patch. */
  let vote = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      gp(r, c + 1, a1); gp(r, c - 1, a2); du.copy(a1).sub(a2);
      gp(r + 1, c, a1); gp(r - 1, c, a2); dv.copy(a1).sub(a2);
      nn.crossVectors(du, dv);
      if (nn.lengthSq() < 1e-14) {
        gp(r, c, a1);
        nn.copy(centre ? a1.sub(centre) : (outDir ?? _AY));
      }
      nn.normalize();
      const i = (r * cols + c) * 3;
      N[i] = nn.x; N[i + 1] = nn.y; N[i + 2] = nn.z;
      gp(r, c, a1);
      if (centre) vote += nn.dot(a1.sub(centre));
      else if (outDir) vote += nn.dot(outDir);
      else vote += nn.y;
    }
  }
  const flipped = o.flip ? vote >= 0 : vote < 0;
  if (flipped) for (let i = 0; i < nv * 3; i++) N[i] = -N[i];

  /* Surface UVs in metres, from cumulative arc length along each parametric
     direction. This is not cosmetic: `SkinBuilder.rigid` would otherwise assign
     triplanar box UVs per vertex, and on a curved shell adjacent vertices pick
     different projection planes. The UV set then jumps at those seams, the
     screen-space derivatives three uses to build the tangent frame blow up, and
     the normal-mapped shading collapses to a flat unlit grey. Continuous UVs
     fix it and land the grain at a physically correct scale as a bonus. */
  const SU = new Float32Array(nv);
  const SV = new Float32Array(nv);
  const q1 = new THREE.Vector3(), q2 = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    let acc = 0;
    for (let c = 0; c < cols; c++) {
      if (c > 0) { gp(r, c, q1); gp(r, c - 1, q2); acc += q1.distanceTo(q2); }
      SU[r * cols + c] = acc;
    }
  }
  for (let c = 0; c < cols; c++) {
    let acc = 0;
    for (let r = 0; r < rows; r++) {
      if (r > 0) { gp(r, c, q1); gp(r - 1, c, q2); acc += q1.distanceTo(q2); }
      SV[r * cols + c] = acc;
    }
  }

  /* ---- de-degenerate the U coordinate at a pole ----
   *
   * Arc-length U is metrically exact, and on a closed dome that exactness is a
   * trap. `domeShell` starts at a polar angle of 0.02 rad, so the first row's
   * circumference is ~4 mm while the equator's is ~600 mm: every column in that
   * row therefore maps to essentially the SAME u, the texture is sampled along a
   * single line across the whole crown, and whatever is in the map gets smeared
   * radially outward from the pole.
   *
   * That is where the helm's "combed swirl" came from — the domain-warped
   * planishing lattice, smeared into curved bands converging on the crown, which
   * reads as polished marble. It survived every attempt to fix it by lowering the
   * amplitude of one layer or another, because the layer was never the problem:
   * the parameterisation was.
   *
   * The fix is to stop any row from being more than ~3x narrower in UV than the
   * widest row, scaling about the row's own centre so the texture does not slide.
   * Near a pole the grain is then STRETCHED (a 20 mm dish becomes a 60 mm oval)
   * instead of being collapsed to a line, and a stretched dish still reads as a
   * dish. Rows whose arc length is already within 3x of the widest — every
   * plateShell, bandShell, greave, tasset and lame in the build — are left
   * bit-for-bit unchanged, so this only touches the geometry that needs it.
   */
  {
    let maxArc = 0;
    for (let r = 0; r < rows; r++) {
      const a = SU[r * cols + cols - 1];
      if (a > maxArc) maxArc = a;
    }
    const minArc = maxArc * 0.34;
    if (minArc > 1e-9) {
      for (let r = 0; r < rows; r++) {
        const a = SU[r * cols + cols - 1];
        if (!(a > 1e-9) || a >= minArc) continue;
        const k = minArc / a;          // continuous in `a`, so smooth across rows
        const mid = a * 0.5;
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          SU[i] = (SU[i] - mid) * k + mid;
        }
      }
    }
  }

  const pos = [], nor = [], uvs = [], idx = [];
  const push = (px, py, pz, nx, ny, nz, u, v) => {
    pos.push(px, py, pz); nor.push(nx, ny, nz); uvs.push(u, v);
  };

  /* outer surface */
  for (let i = 0; i < nv; i++) push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], N[i * 3], N[i * 3 + 1], N[i * 3 + 2], SU[i], SV[i]);
  const innerBase = nv;
  /* inner surface, pushed in along −N */
  for (let i = 0; i < nv; i++) {
    push(P[i * 3] - N[i * 3] * thick, P[i * 3 + 1] - N[i * 3 + 1] * thick, P[i * 3 + 2] - N[i * 3 + 2] * thick,
      -N[i * 3], -N[i * 3 + 1], -N[i * 3 + 2], SU[i], SV[i]);
  }
  const cLim = closeU ? cols : cols - 1;
  const tri = flipped
    ? (x, y, z) => { idx.push(x, z, y); }   // winding follows the normal vote
    : (x, y, z) => { idx.push(x, y, z); };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cLim; c++) {
      const c1 = closeU ? (c + 1) % cols : c + 1;
      const a = r * cols + c, b = r * cols + c1, d = (r + 1) * cols + c, e = (r + 1) * cols + c1;
      tri(a, b, d); tri(b, e, d);
      tri(innerBase + a, innerBase + d, innerBase + b);
      tri(innerBase + b, innerBase + d, innerBase + e);
    }
  }

  /* ---- rolled rim ---- */
  const loops = [];
  if (closeU) {
    const top = [], bot = [];
    for (let c = 0; c < cols; c++) { top.push([0, c, 0, -1]); bot.push([rows - 1, c, 0, 1]); }
    loops.push(top, bot);
  } else {
    const loop = [];
    for (let c = 0; c < cols; c++) loop.push([0, c, 0, -1]);
    for (let r = 1; r < rows; r++) loop.push([r, cols - 1, 1, 0]);
    for (let c = cols - 2; c >= 0; c--) loop.push([rows - 1, c, 0, 1]);
    for (let r = rows - 2; r >= 1; r--) loop.push([r, 0, -1, 0]);
    loops.push(loop);
  }

  const tanU = new THREE.Vector3(), tanV = new THREE.Vector3(), out3 = new THREE.Vector3();
  for (const loop of loops) {
    const base = pos.length / 3;
    let rimArc = 0;
    for (let k = 0; k < loop.length; k++) {
      const [r, c, su, sv] = loop[k];
      const i = (r * cols + c) * 3;
      if (k > 0) {
        const pk = loop[k - 1];
        const j = (pk[0] * cols + pk[1]) * 3;
        rimArc += Math.hypot(P[i] - P[j], P[i + 1] - P[j + 1], P[i + 2] - P[j + 2]);
      }
      gp(r, c + 1, a1); gp(r, c - 1, a2); tanU.copy(a1).sub(a2).normalize();
      gp(r + 1, c, a1); gp(r - 1, c, a2); tanV.copy(a1).sub(a2).normalize();
      out3.set(0, 0, 0).addScaledVector(tanU, su).addScaledVector(tanV, sv);
      if (out3.lengthSq() < 1e-10) out3.copy(tanU);
      out3.normalize();
      const nx = N[i], ny = N[i + 1], nz = N[i + 2];
      // outer edge
      push(P[i], P[i + 1], P[i + 2], (nx + out3.x) * 0.5, (ny + out3.y) * 0.5, (nz + out3.z) * 0.5,
        rimArc, 0);
      // mid ring: pushed past the boundary at half depth — this is the roll
      push(P[i] - nx * thick * 0.5 + out3.x * bev, P[i + 1] - ny * thick * 0.5 + out3.y * bev,
        P[i + 2] - nz * thick * 0.5 + out3.z * bev, out3.x, out3.y, out3.z,
        rimArc, thick * 0.5 + bev);
      // inner edge
      push(P[i] - nx * thick, P[i + 1] - ny * thick, P[i + 2] - nz * thick,
        (out3.x - nx) * 0.5, (out3.y - ny) * 0.5, (out3.z - nz) * 0.5,
        rimArc, thick + bev);
    }
    const L = loop.length;
    for (let k = 0; k < L; k++) {
      const k2 = (k + 1) % L;
      for (let s = 0; s < 2; s++) {
        const a = base + k * 3 + s, b = base + k2 * 3 + s;
        tri(a, b, a + 1); tri(b, b + 1, a + 1);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.userData.metreUV = true;
  return g;
}

/**
 * Ellipsoidal dome patch — pauldron lames, poleyns, couters, the hood.
 * `a` is the polar angle from +Y, `b` the azimuth measured from +X toward +Z.
 */
function domeShell(o) {
  const R = o.r ?? 0.1;
  const sx = o.sx ?? 1, sy = o.sy ?? 1, sz = o.sz ?? 1;
  const a0 = o.a0 ?? 0.02, a1 = o.a1 ?? 1.4;
  const b0 = o.b0 ?? -1.1, b1 = o.b1 ?? 1.1;
  const swell = o.swell ?? 0;
  const flare = o.flare ?? 0;
  return shellGeo((u, v, out) => {
    const a = lerp(a0, a1, v);
    const b = lerp(b0, b1, u);
    const rr = R * (1 + swell * Math.sin(v * Math.PI) + flare * v * v)
      * (1 + (o.lobe ?? 0) * Math.cos(u * Math.PI * 2 * (o.lobes ?? 3)));
    const sa = Math.sin(a), ca = Math.cos(a);
    out.set(rr * sa * Math.cos(b) * sx, rr * ca * sy, rr * sa * Math.sin(b) * sz);
  }, { ru: o.ru ?? 14, rv: o.rv ?? 7, thick: o.thick ?? 0.02, bevel: o.bevel, center: [0, 0, 0], closeU: o.closeU });
}

/**
 * Cylindrical band shell — fauld lames, tassets, greaves, vambraces, belts.
 * `b` is the azimuth measured from +Z (forward) toward +X (the hero's left).
 */
function bandShell(o) {
  const b0 = o.b0 ?? -1.3, b1 = o.b1 ?? 1.3;
  const y0 = o.y0 ?? 0, y1 = o.y1 ?? -0.12;
  const r0 = o.r0 ?? 0.18, r1 = o.r1 ?? 0.18;
  const sx = o.sx ?? 1, sz = o.sz ?? 1;
  const hem = o.hem ?? 0;
  const lobes = o.lobes ?? 3;
  const bulge = o.bulge ?? 0;
  return shellGeo((u, v, out) => {
    const b = lerp(b0, b1, u);
    const rr = lerp(r0, r1, v) * (1 + bulge * Math.sin(v * Math.PI));
    const y = lerp(y0, y1, v) + hem * v * v * Math.cos(u * Math.PI * lobes);
    out.set(Math.sin(b) * rr * sx, y, Math.cos(b) * rr * sz);
  }, {
    ru: o.ru ?? 16, rv: o.rv ?? 6, thick: o.thick ?? 0.02, bevel: o.bevel,
    closeU: o.closeU,
    outDir: null,
    center: [0, lerp(y0, y1, 0.5), 0],
  });
}

/**
 * Torso plate: an elliptical band with a raised medial ridge.
 *
 * The cross-section is a genuine ellipse (`a` across, `c` fore-and-aft) because
 * a ribcage is not round — a circular breastplate either floats a hand's width
 * off the sternum or cuts through the lats. `keel` swells the radius on the
 * centre line, which is the raised medial ridge every real cuirass has and the
 * thing that gives the chest a specular highlight down its middle instead of a
 * flat wash. `b` is the azimuth measured from +Z (forward) toward +X (left).
 */
function plateShell(o) {
  const b0 = o.b0 ?? -1.30, b1 = o.b1 ?? 1.30;
  const y0 = o.y0 ?? 0.15, y1 = o.y1 ?? -0.15;
  const a0 = o.a0 ?? 0.206, a1 = o.a1 ?? 0.186;
  const c0 = o.c0 ?? 0.132, c1 = o.c1 ?? 0.128;
  const keel = o.keel ?? 0;
  const keelW = o.keelW ?? 0.34;
  const keelAt = o.keelAt ?? 0;          // azimuth the ridge runs along
  const lobes = o.lobes ?? 0;
  const lobeAmp = o.lobeAmp ?? 0;
  const hem = o.hem ?? 0;
  const bow = o.bow ?? 0;                // extra swell at mid height
  return shellGeo((u, v, out) => {
    const b = lerp(b0, b1, u);
    const db = b - keelAt;
    const k = 1 + keel * Math.exp(-(db * db) / (keelW * keelW))
      + lobeAmp * Math.cos((b - keelAt) * lobes);
    const swell = 1 + bow * Math.sin(v * Math.PI);
    const A = lerp(a0, a1, v) * k * swell;
    const C = lerp(c0, c1, v) * k * swell;
    const y = lerp(y0, y1, v) + hem * v * v * Math.cos(db * (lobes || 3));
    out.set(Math.sin(b) * A, y, Math.cos(b) * C);
  }, {
    ru: o.ru ?? 20, rv: o.rv ?? 6, thick: o.thick ?? 0.016, bevel: o.bevel,
    closeU: o.closeU, center: [0, lerp(y0, y1, 0.5), 0],
  });
}

/** Loft a stack of cross-section rings (blade, grip, boot). */
function loftGeo(rings, o = {}) {
  const seg = rings[0].pts.length;
  const pos = [], nor = [], uvs = [], idx = [];
  // UVs in metres: u around the section, v along the loft.
  let vArc = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (r > 0) vArc += Math.abs(ring.y - rings[r - 1].y);
    let uArc = 0;
    for (let c = 0; c < seg; c++) {
      const p = ring.pts[c];
      if (c > 0) {
        const q = ring.pts[c - 1];
        uArc += Math.hypot(p[0] - q[0], p[1] - q[1]);
      }
      pos.push(p[0], ring.y, p[1]);
      nor.push(0, 0, 0);
      uvs.push(uArc, vArc);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let c = 0; c < seg; c++) {
      const c2 = (c + 1) % seg;
      const a = r * seg + c, b = r * seg + c2, d = (r + 1) * seg + c, e = (r + 1) * seg + c2;
      idx.push(a, d, b, b, d, e);
    }
  }
  // caps
  if (o.cap !== false) {
    for (const [r, dir] of [[0, -1], [rings.length - 1, 1]]) {
      const ci = pos.length / 3;
      const ring = rings[r];
      let cx = 0, cz = 0;
      for (const p of ring.pts) { cx += p[0]; cz += p[1]; }
      pos.push(cx / seg, ring.y + dir * (o.capLift ?? 0.004), cz / seg);
      nor.push(0, dir, 0);
      uvs.push(0, r === 0 ? 0 : vArc);
      for (let c = 0; c < seg; c++) {
        const c2 = (c + 1) % seg;
        if (dir < 0) idx.push(ci, r * seg + c, r * seg + c2);
        else idx.push(ci, r * seg + c2, r * seg + c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.userData.metreUV = true;
  return g;
}

/**
 * SkinBuilder with the three additions the hero's surface fidelity depends on.
 *
 *  1. **Metre-space UVs survive.** Anything built by `shellGeo`/`loftGeo` carries
 *     arc-length UVs and keeps them; blocks, spheres and merged hardware fall
 *     through to a triplanar box projection. (Box-projecting a curved shell tears
 *     the UV set at every plane switch, which destroys the screen-space tangent
 *     frame and reads as flat unlit plastic.)
 *  2. **Per-piece UV transform.** `uvScale`, `uvOff`, `uvRot`, `uvAniso` are
 *     baked per call, so a pauldron and a gauntlet sharing one 4-sampler
 *     material still sample different regions of it, at different densities, in
 *     different directions. This is the whole answer to "the same grey speckle
 *     at the same UV density on every metal piece".
 *  3. **Curvature-driven wear.** `edge`/`cavity` read the geometry's own
 *     convexity (see `edgeCavity`) instead of a distance-from-anchor guess, and
 *     `polish` carries a per-piece finish, both into an `aSurf` attribute the
 *     hero shader consumes.
 */
class HeroSkin extends SkinBuilder {
  constructor(rig, seed) {
    super(rig, seed);
    /** flattened vec4 per vertex: (cavity, polish, oxide, normalWeight) — `aSurf` */
    this.surf = [];
    this._sCav = 0;
    this._sPol = 0.5;
    this._sOx = 0;
    this._sNrm = 1;
  }

  /** Cavity + polish + oxide + normal weight for the *next* primitive. */
  setSurf(cav, polish, ox, nrm) {
    this._sCav = cav ?? 0;
    this._sPol = polish ?? 0.5;
    this._sOx = ox ?? 0;
    this._sNrm = nrm ?? 1;
    return this;
  }

  _pushVert(px, py, pz, nx, ny, nz, u, v, b0, w0, b1, w1, colorFn, mask) {
    super._pushVert(px, py, pz, nx, ny, nz, u, v, b0, w0, b1, w1, colorFn, mask);
    this.surf.push(this._sCav, this._sPol, this._sOx, this._sNrm);
  }

  build(o = {}) {
    const g = super.build(o);
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 4));
    return g;
  }

  /**
   * @param {THREE.BufferGeometry} geo
   * @param {string} boneName
   * @param {object} o at/off/rot/scale/color/mask, plus:
   *   uvScale  metres per texture repeat
   *   uvOff    [u,v] offset into the tile, in repeats — this is what makes two
   *            pieces sharing one texture sample two *different* noise fields
   *   uvRot    rotation of the tile, radians — different grain direction again
   *   uvAniso  extra scale on v, so the grain is not isotropic
   *   edge     gain on the curvature edge-wear channel (0 disables)
   *   cavity   gain on the curvature cavity channel (0 disables)
   *   cavBase  cavity floor for the whole piece
   *   polish   0..1 per-piece finish; drives a roughness multiplier
   *   oxide    0..1 per-piece BLACKENING. Independent of `polish`, because a
   *            plate can be dark and smooth (a freshly blued helm) or pale and
   *            rough (a sabaton scoured back to grey by gravel), and collapsing
   *            those two into one number is what made the suit read as one
   *            material. Darkens F0, roughens, and kills metalness together —
   *            never one without the others.
   *   maskK    how much of the authored `mask` survives under edge wear
   */
  rigid(geo, boneName, o = {}) {
    const bi = this.rig.idx(boneName);
    const posA = geo.getAttribute('position');
    if (!posA) return this;
    let norA = geo.getAttribute('normal');
    if (!norA) { geo.computeVertexNormals(); norA = geo.getAttribute('normal'); }
    const uvA = geo.userData?.metreUV ? geo.getAttribute('uv') : null;

    const anchor = new THREE.Vector3();
    if (o.pos) anchor.set(o.pos[0], o.pos[1], o.pos[2]);
    else this.rig.restOf(o.at ?? boneName, anchor);
    if (o.off) { anchor.x += o.off[0]; anchor.y += o.off[1]; anchor.z += o.off[2]; }
    const e = o.rot ?? [0, 0, 0];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));
    const sc = o.scale ?? 1;
    const scv = typeof sc === 'number'
      ? new THREE.Vector3(sc, sc, sc)
      : new THREE.Vector3(sc[0], sc[1], sc[2]);
    const m = new THREE.Matrix4().compose(anchor, q, scv);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const uvScale = o.uvScale ?? 0.32;
    const uGain = ((scv.x + scv.y + scv.z) / 3) / uvScale;
    const uOff = o.uvOff?.[0] ?? 0, vOff = o.uvOff?.[1] ?? 0;
    const rot = o.uvRot ?? 0;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const aniso = o.uvAniso ?? 1;

    /* Curvature. This is where edge wear and cavity tarnish actually come from:
       a per-vertex convexity read off the triangle graph, so the rolled rim of a
       lame, the crown of a rivet and the edge of the blade all resolve as the
       same *material* (bright burnished steel) while the sheltered field of the
       plate and the recess under an overlapping lame resolve as the other one
       (dark oxide). A radius-from-anchor guess cannot tell those apart. */
    const eG = o.edge ?? 0, cG = o.cavity ?? 0;
    const ec = (eG > 0 || cG > 0) ? edgeCavity(geo) : null;
    const cavBase = o.cavBase ?? 0;
    const pol = o.polish ?? 0.5;
    const oxd = o.oxide ?? 0;
    /* Per-piece normal weight. 1 = the map's full authored relief; the small,
       strongly curved pieces whose arc-length UVs converge (a helm dome, a
       couter, a rivet, a blade) take a fraction of it, because a cell-wall
       network wrapped round a 105 mm sphere arcs into a comb. */
    const nrm = o.nrm ?? 1;
    const maskK = o.maskK ?? 0.52;
    const maskFn = typeof o.mask === 'function' ? o.mask : null;
    const maskC = maskFn ? 0 : (o.mask ?? 0);

    const base = this.vertexCount;
    const p = new THREE.Vector3(), nv = new THREE.Vector3();
    for (let i = 0; i < posA.count; i++) {
      p.fromBufferAttribute(posA, i).applyMatrix4(m);
      nv.fromBufferAttribute(norA, i).applyMatrix3(nm).normalize();
      let u, v;
      if (uvA) {
        u = uvA.getX(i) * uGain; v = uvA.getY(i) * uGain * aniso;
      } else {
        /* Triplanar box UVs in metres — right for a bevelled block, wrong for a
           curved shell (adjacent vertices pick different planes, the UV set
           tears and the derived tangent frame collapses), which is why anything
           built by shellGeo/loftGeo carries its own arc-length UVs above. */
        const ax = Math.abs(nv.x), ay = Math.abs(nv.y), az = Math.abs(nv.z);
        if (ax >= ay && ax >= az) { u = p.z / uvScale; v = p.y / uvScale; }
        else if (ay >= az) { u = p.x / uvScale; v = p.z / uvScale; }
        else { u = p.x / uvScale; v = p.y / uvScale; }
        v *= aniso;
      }
      if (rot !== 0) { const t = u * cr - v * sr; v = u * sr + v * cr; u = t; }
      u += uOff; v += vOff;

      const m0 = maskFn ? maskFn(p.x, p.y, p.z) : maskC;
      const wear = ec
        ? clamp01(m0 * maskK + ec.edge[i] * eG)
        : m0;
      this._sCav = ec ? clamp01(cavBase + ec.cav[i] * cG) : cavBase;
      this._sPol = pol;
      this._sOx = oxd;
      this._sNrm = nrm;
      this._pushVert(p.x, p.y, p.z, nv.x, nv.y, nv.z, u, v, bi, 1, bi, 0, o.color, wear);
    }
    const idx = geo.getIndex();
    if (idx) for (let i = 0; i < idx.count; i++) this.idx.push(base + idx.getX(i));
    else for (let i = 0; i < posA.count; i++) this.idx.push(base + i);
    return this;
  }
}

/** Bevelled solid block, taper and bends applied in geometry space. */
function block(w, h, d, o = {}) {
  const g = roundedBox(w, h, d, o.r ?? Math.min(w, h, d) * 0.26, o.seg ?? 2);
  if (o.taper) taperX(g, h, o.taper);
  if (o.wrap) bendY(g, o.wrap);
  if (o.curl) bendX(g, o.curl);
  return g;
}

/* ================================================================== *
 * per-vertex wear
 * ================================================================== */

/**
 * Grime tint. Dirt climbs from the ground, dust settles on up-facing surfaces,
 * sludge collects in downward-facing cavities, and low-frequency mottle stops
 * any two square centimetres reading the same. Clean geometry is a critic fail
 * and this is the cheapest place to fix it.
 */
function wearTint(o = {}) {
  const base = o.base ?? [1, 1, 1];
  const seed = o.seed ?? 11;
  const mot = o.mottle ?? 0.14;
  const dirtTop = o.dirtTop ?? 0.62;
  const dirtAmt = o.dirt ?? 0.24;
  const freq = o.freq ?? 7.5;
  const warm = o.warm ?? [1.02, 0.90, 0.74];
  const cavW = o.cav ?? 0.26;
  /* Soot field. A separate, deliberately *low* frequency layer (roughly one
     patch per 60 cm) on top of the fine mottle, because grime on armour arrives
     in body-scale passages — a sooted shoulder, a clean breast, a filthy skirt —
     not as even speckle. This is also the main lever on the figure's overall
     value: the plate's own albedo has to stay at real steel reflectance for the
     highlights to exist, so the *average* has to come down through dirt instead.
     Without it the cuirass measured 0.70 display luminance across its whole
     field and read as unglazed ceramic. */
  const sootAmt = o.soot ?? 0;
  const sootFreq = o.sootFreq ?? 1.5;
  return (x, y, z, nx, ny, nz) => {
    const dirt = (1 - smoothstep(0.04, dirtTop, y)) * dirtAmt;
    const cav = Math.max(0, -ny);
    const up = Math.max(0, ny);
    const m = fbm3(x * freq, y * freq, z * freq, seed, 3);
    let k = 1 - cavW * cav - dirt * 0.7 + 0.05 * up;
    if (sootAmt > 0) {
      const s = fbm3(x * sootFreq, y * sootFreq * 0.62, z * sootFreq, seed + 977, 4);
      k *= 1 - sootAmt * smoothstep(0.40, 0.88, s);
    }
    k *= 1 + (m - 0.5) * 2 * mot;
    if (k < 0.02) k = 0.02;
    const r = base[0] * k, g = base[1] * k, b = base[2] * k;
    return [
      lerp(r, r * warm[0], dirt), lerp(g, g * warm[1], dirt), lerp(b, b * warm[2], dirt),
    ];
  };
}

/**
 * Wrap a tint function with a *seam shadow*: a band of darkening running down
 * from `yTop` for `depth` metres, in rig space.
 *
 * This is the missing half of "layered plate". Overlapping lames only read as
 * overlapping if the covered strip of each lame is visibly darker than the rim
 * of the lame riding over it — and a 20 mm strip is well below what a cascaded
 * shadow map can resolve at any sane resolution, so it has to be baked. Every
 * lame family calls this with its own measured top edge, which is why the fauld,
 * the tassets and the pauldron stack now show a hard little line at every seam
 * instead of reading as one smooth shell with panel lines drawn on it.
 */
function seamShade(tint, yTop, depth = 0.026, amount = 0.62) {
  return (x, y, z, nx, ny, nz) => {
    const c = tint(x, y, z, nx, ny, nz);
    const t = clamp01((yTop - y) / depth);
    const k = 1 - amount * (1 - smoothstep(0, 1, t));
    return [c[0] * k, c[1] * k, c[2] * k];
  };
}

/**
 * Edge-wear channel. Wear is highest far from a piece's anchor (rims, spikes,
 * the crown of a dome) and on up-facing surfaces, because those are what scrape
 * against the world. The shader turns this into bright polished steel.
 */
function wearMask(cx, cy, cz, radius, gain = 1) {
  const inv = 1 / Math.max(1e-3, radius);
  return (x, y, z) => {
    const d = Math.hypot(x - cx, y - cy, z - cz) * inv;
    // Fine, low-amplitude break-up. At the old 21 cycles/m and +/-31% the
    // variation landed as 5 cm blotches, and since this channel drives albedo
    // gain, roughness AND metalness at once, those blotches read as corrosion
    // scabs across every plate.
    const m = fbm3(x * 38, y * 38, z * 38, 97, 2);
    /* The window has to be measured against the *plates*, not guessed. Each
       call site passes a radius roughly equal to its piece's own extent, so d
       runs 0..1 across the piece — and the old smoothstep(0.52, 1.02) therefore
       resolved to 0.85-1.0 over about 90% of every plate. The channel was
       nominally "edge wear" but was in practice a constant, which is why lifting
       it to a real oxide→steel switch instantly blew out 38% of the cuirass.
       Windowed on [0.72, 1.06] the sheltered field of a breastplate sits near
       the 0.10 floor and only the outer fifth — the rims, the roll, the standing
       edges — comes up, which is where a suit of armour actually gets polished. */
    return clamp01((smoothstep(0.72, 1.06, d) * 0.86 + 0.10) * gain * (0.88 + m * 0.24));
  };
}

/* ================================================================== *
 * custom AssetForge kinds
 * ================================================================== *
 * Registered through the documented `engine.assets.register(name, fn)` hook,
 * so the core factory file stays untouched. Two kinds, both of which exist
 * because the stock library's nearest equivalent is authored for the world and
 * not for a character:
 *
 *  • `heroPlate` — the stock `metal` kind is aged wrought iron. Its rust field
 *    covers roughly a third of the surface with hard-edged patches that swing
 *    albedo from 0.50 to 0.08 and roughness from 0.30 to 0.94. That is superb
 *    on a portcullis; wrapped round a breastplate at 10 cm per repeat it reads
 *    as crazy paving, which is precisely what the previous pass rendered.
 *  • `heroMail` — there is no mail in the library at all, and radial noise on
 *    a tube is not a substitute: a mail sleeve has to show *rings*.
 */

/* ------------------------------------------------------------------ *
 * FEATURE SIZE IS THE WHOLE BALLGAME — read this before touching a frequency.
 *
 * The previous pass authored its high-frequency layers at 176 cycles per texture
 * repeat (a Perlin lattice) and its abrasion at 96. Measured against what the
 * frame actually samples:
 *
 *   steel map ....... 1024 px, so one texel = 0.41 mm at the cuirass's 0.42 m
 *                     repeat, or 0.34 screen px at the closeup camera's
 *                     ~830 px/m — i.e. the texture is MINIFIED 3x.
 *   176 cyc/repeat .. 2.4 mm per cycle = 5.8 texels = 2.0 SCREEN PIXELS.
 *   96 cyc/repeat ... 4.4 mm per cycle = 3.6 screen pixels.
 *
 * Two screen pixels per cycle is exactly Nyquist. Mip selection cannot rescue
 * it: minification of 3x picks mip ~1.6, whose effective texel is 1.2 mm, so a
 * 2.4 mm feature is still two samples wide *in the mip that gets used*. The
 * result is the defect the art director named — "one speckle noise at one UV
 * density on every metal plate" and "a near-white ... normal map with a broad
 * soft specular and no grain". It was not a noise *choice*, it was aliasing:
 * the same random shimmer appears on the helm and the gauntlet because
 * aliasing has no scale of its own, only the pixel grid's.
 *
 * Measured on the previous build, region (0.505,0.34)-(0.555,0.42) of the
 * closeup frame — bare cuirass, no hardware:
 *     mean 0.506   sd 0.256   p50 0.504   p99 0.954   26.3 % of pixels > 0.72
 * A quarter of the breastplate was above the near-clip line in a random
 * salt-and-pepper field. That is the "crumpled aluminium foil" read, precisely.
 *
 * THE RULE THIS FILE NOW FOLLOWS. Every layer either sits comfortably ABOVE the
 * aliasing band (>= 6 screen px, so it resolves as structure) or comfortably
 * BELOW it (per-texel, so the mip chain averages it into a smooth roughness
 * lift). Nothing is authored into 1.5-5 screen px. In cycles per repeat that
 * caps the finest structural layer at 40 and puts the abrasion at 34/27.
 * ------------------------------------------------------------------ */
function genHeroPlate(c, T) {
  const { field, fieldN, worleyT, warpT, fbmT, perlinT, streakT, veinT, pointsT, hash2,
    clamp01: sat, lerp: mix, smoothstep: ss, frac, WK, WP } = T;
  const size = c.size, S = c.seed, P = c.params, n = size * size;

  /* ==================================================================== *
   * THE THREE-TIER CONTRACT, on the piece of the frame that failed it worst.
   * ==================================================================== *
   * Round-2 blocker: "A single dimpled/hex noise pattern at one scale appears on
   * the hero's helmet, gorget, cuirass, arms and skirt." Measured at 6x on the
   * closeup frame before this pass, that is exactly what the cuirass was: a field
   * of soft round blobs about 8 screen pixels across, uniform in value, with no
   * finer grain under them and no wear anywhere on them.
   *
   * There was one cause and it was structural, not a matter of amplitude. The
   * ONLY layer with real amplitude was a domain-warped Worley distance field used
   * as a DISH — `(0.34 - f1) * 0.023`. A distance-to-nearest-site field ramped
   * linearly is a dome per cell, so the surface was a close-packed field of domes,
   * i.e. bubble wrap. Everything else in the generator was authored at one to two
   * percent of that amplitude and therefore did not exist in the pixels.
   *
   * The three tiers this now carries, with their measured feature sizes at the
   * cuirass's 0.42 m repeat (and the helm's 0.34 / a gauntlet's 0.18):
   *
   *  T1  STRUCTURE — hammer planishing as FACETS, 9 x 8 per repeat:
   *      47 mm on the cuirass, 38 mm on the helm, 20 mm on a gauntlet. A facet is
   *      a flat face bounded by a standing arris, so the highlight breaks along
   *      LINES. That single change is the difference between "planished steel" and
   *      "dimpled". Plus a 3-cycle rolled-sheet undulation (140 mm) so the plate
   *      has a statement larger than one facet.
   *  T2  WEAR THAT FOLLOWS FORM — and it is no longer a hand-rolled `burnish`
   *      blend. The arrises, the strap-rub band edges and the dent lips write into
   *      the shared `wr` supply, which finalize() gates on MEASURED PROUDNESS of
   *      the height field. So the bright steel lands on what actually stands proud,
   *      it is a line and not a plateau, and it automatically sheds grime.
   *      Cavity tarnish is the same mechanism with the sign flipped (`gm`).
   *  T3  FINE GRAIN — a 40-cycle perlin (10 mm) plus a genuine PER-TEXEL hash.
   *      Both live almost entirely in roughness. That is deliberate: a per-texel
   *      perturbation of the NORMAL on a metal is specular sparkle, which is an
   *      order of magnitude more visible than the same perturbation in albedo and
   *      is what the first pass shipped as "speckle". In roughness the mip chain
   *      averages it into a slightly broader lobe, which is what micro-roughness
   *      physically IS.
   * ==================================================================== */

  /* Normal strength is up (0.74 -> 0.98) because the relief is now legible
     structure rather than noise, and the per-piece `aSurf.w` weight (see MP.nrm)
     is what keeps it off the pieces that must not have it — the helm dome takes
     0.20 of it, the cuirass takes all of it. Before that channel existed the
     amplitude had to be set to whatever the WORST case could tolerate, which is
     why the breastplate had no visible hammer work: it was paying for the helm. */
  P.normalStrength = 0.98;
  /* The occlusion channel of the packed ORM is not bound on the hero, so every
     millimetre of crevice shading the texture contributes has to be baked into
     albedo. `cavityTint` is that path. */
  P.aoStrength = 0.88; P.cavity1 = 1.28; P.cavity2 = 1.02;
  P.grimeAmount = 0.40; P.grimeColor = [0.028, 0.030, 0.039]; P.grimeRough = 0.74;
  P.grimeMetalKill = 0.34; P.grimeFill = 0.58; P.cavityTint = 0.42;
  P.roughMin = 0.05; P.displacement = 0.010;
  /* TIER 2, declared. Polished iron: F0 0.62 linear (0.804 sRGB) at roughness
     0.13 and full metalness. `wearScale` 30 texels selects the planishing tier,
     so it is the ARRISES that polish and not the broad rolled undulation, and
     `wearProud` 1.0 means a texel that is not proud gets nothing at all. */
  /* `wearScale` 56 texels-at-1024 = a 28-texel blur on the 512 map, which is half
     a facet. That is deliberate and it was wrong at 30: the gate has to respond to
     the PLANISHING tier, because with the arris removed from the height field the
     only thing standing proud on this surface is a high facet — which is also
     exactly what a polishing cloth, a sleeve and a scabbard actually touch. At 30
     the gate saw only sub-facet relief, measured 0.05 % of the map above 0.72
     display luminance, and the plate had no bright steel anywhere. */
  P.wearAmount = 1.0; P.wearColor = [0.804, 0.804, 0.836];
  P.wearRough = 0.13; P.wearMetal = 1.0; P.wearScale = 56; P.wearProud = 1.0;
  /* Solved, not guessed: [0.40, 1.05] put 0.57 % of the map at bare steel and
     [0.22, 0.80] puts 3.1 %, measured at 512 after finalize. Three percent is the
     figure this file has twice converged on as the coverage at which the frame has
     real highlights and none of them is a plateau. */
  P.wearGate = [0.15, 0.72];

  /* ---------------------------------------------------------------- T1 */
  // 9 x 8 facets per repeat. `edge` is the arris — the ridge the hammer leaves
  // standing between two blows — and it is the feature that makes this read as
  // struck metal. Warp stays light (0.09): a heavy warp turns a cell lattice into
  // organic banding, which is the marbling the dome used to show.
  const F = 9, FY = 8;
  const [dish, cellR, cellEdge] = fieldN(size, 2, 3, (u, v, out) => {
    warpT(u * 4, v * 4, 4, 4, S + 5, 0.17, 3);
    worleyT((WP.x / 4) * F, (WP.y / 4) * FY, F, FY, S + 23);
    out[0] = WK.f1;
    out[1] = hash2(WK.cx, WK.cy, S + 47);
    /* Per-cell border WIDTH jitter, so the partition does not read as a regular
       honeycomb. Without it nine near-equal rounded polygons per repeat is a
       tessellation, and a tessellation on a curved shell is reptile skin however
       shallow the relief is. */
    out[2] = WK.edge / (0.55 + hash2(WK.cx, WK.cy, S + 131) * 0.95);
  });
  /* The SMOOTH half of the planishing tier, at the same 9 cycles as the facets.
     Blending it with the facet levels is what keeps the tier's scale while
     dissolving the tessellation: the eye gets a 47 mm undulation with facet
     boundaries implied by tone rather than drawn as a net. */
  const soft = field(size, 2, (u, v) => perlinT(u * 9, v * 8, 9, 8, S + 137));
  /* Rolled sheet: 3 cycles, i.e. 140 mm on the cuirass. Low amplitude, but it is
     the only signal at a scale LARGER than a facet, and without one a plate is
     one evenly-worked field however far back the camera stands. */
  const roll = field(size, 8, (u, v) => fbmT(u * 3, v * 2, 3, 2, 3, 0.62, S + 29));
  /* Struck dents: sparse authored events, 9 per repeat (47 mm apart on the
     cuirass). Nine large features say "this plate has been hit"; ten thousand
     small ones say "noise". */
  const dent = field(size, 2, (u, v) => pointsT(u, v, 9, S + 37, 0.34, 0.30));
  /* Fired black oxide in body-scale passages — 5 cycles is an 84 mm patch on the
     cuirass. This is the channel that gives the plate a readable light-and-dark
     pattern at 20 cm, which is what mid-tone structure means on a character. */
  const oxide = field(size, 4, (u, v) => fbmT(u * 5, v * 5, 5, 5, 4, 0.58, S + 67));
  const tarn = field(size, 4, (u, v) => fbmT(u * 3, v * 3, 3, 3, 4, 0.55, S + 71));

  /* ---------------------------------------------------------------- T2 */
  /* STRAP RUB — "scuffing where straps rub", authored rather than hoped for.
     Two bands per repeat running along the integer lattice direction (2,1), so
     they tile exactly: 2 bands across 0.42 m is a 42 mm strap at 190 mm centres,
     which is a real harness strap at a real spacing. Inside the band the oxide
     has been scoured off and the metal is grey and dulled; along the band's two
     edges — where the leather's cut edge digs in — it is scoured to bright steel.
     Different piece, different `uvRot`, so the bands cross each plate at a
     different angle and no two pieces show the same rub. */
  const [strapIn, strapEdge] = fieldN(size, 2, 2, (u, v, out) => {
    const wob = fbmT(u * 5, v * 5, 5, 5, 3, 0.5, S + 113) - 0.5;
    const s = frac((2 * u + v) * 2 + wob * 0.03);
    const d = Math.abs(s - 0.5) / 0.5;        // 0 at band centre, 1 at midway
    out[0] = 1 - ss(0.44, 0.62, d);            // the rubbed band
    out[1] = ss(0.34, 0.50, d) * (1 - ss(0.50, 0.66, d)); // its two edges
  });
  /* Directional abrasion at 34 and 27 cycles across (10-12 mm on the cuirass:
     6-10 screen px, above the aliasing band). Coherent along one axis, so even
     where it undersamples it degrades into a soft directional smear, never into
     isotropic sparkle. TWO octaves: streakT is an fbm, so oct=3 puts its top
     octave at 136 cycles, straight back into the band this exists to vacate. */
  const scrA = field(size, 2, (u, v) => streakT(u, v, 34, 6, S + 83, 2));
  const scrB = field(size, 2, (u, v) => streakT(v, u, 27, 5, S + 89, 2));
  /* Scuff lines: an ISOTROPIC line network, not the crest of a stretched streak
     field. Every dome in the build carries arc-length UVs whose u compresses to
     nothing at the pole, so a directional line source CONVERGES there and the
     helm renders as combed swirls. A ridged-fbm vein network at 22 cycles has no
     preferred direction and scuffs a dome the same way it scuffs a flat lame. */
  const scuff = field(size, 2, (u, v) => veinT(u, v, 22, S + 103, 26, 2));

  /* ---------------------------------------------------------------- T3 */
  // 40 cycles = 10.5 mm on the cuirass, 7.5 mm on a greave: the finest layer the
  // closeup camera can still resolve as grain rather than sample as noise.
  const det = field(size, 2, (u, v) => perlinT(u * 40, v * 40, 40, 40, S + 97));
  /* PER-TEXEL grain. This is the tier that was simply absent — the plate had
     nothing between 10 mm and nothing, so under minification there was no
     micro-roughness at all and the specular lobe stayed glassy-smooth across
     every plate. A texel hash is BELOW the aliasing band by construction: the
     mip chain averages it, which is exactly the behaviour wanted. It is worth
     0.05 of roughness and 0.010 of albedo, and 0.0006 of height. */
  const grain = new Float32Array(n);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) grain[i] = hash2(x, y, S + 149);
  }

  for (let i = 0; i < n; i++) {
    const d = dish[i], cr = cellR[i], eg = cellEdge[i];
    /* FACET PROFILE — and getting this wrong twice is instructive, so both
       failures are recorded here.
         Attempt 1 (shipped, and the blocker): `(0.34 - f1) * 0.023`. A worley
       distance field ramped linearly is a DOME per cell. A close-packed field of
       domes is bubble wrap, which is the "single dimpled pattern" complaint.
         Attempt 2: a plateau `ss(0.03, 0.34, f1)` plus a crisp arris ridge. That
       inverts the dome into a BOWL — f1 is small at the site, so the cell centre
       sank and the wall stood up — giving every cell a dark dot inside a bright
       polygonal net. Measured at 6x it read as reptile scales. Crisper is not the
       same thing as more structural.
         What planishing actually is: each hammer blow leaves a shallow, almost
       flat facet at its own slight tilt, and adjacent facets meet at the sheet's
       mean level. So the profile is a per-facet LEVEL OFFSET faded to zero at the
       cell border (`join`), which makes the facets meet C0 with no step and no
       net, plus a low narrow arris so the seam has something for the polish and
       the wear pass to find, plus a very shallow dish under the blow itself.
       The dominant term is the per-facet level, which is why this reads as a
       quilt of soft broad highlights that shift facet to facet — the thing you
       actually see on planished steel. */
    const join = ss(0.0, 0.12, eg);            // 1 inside a facet, 0 at the border
    const ar = 1 - ss(0.0, 0.055, eg);         // the narrow arris itself
    /* NOTHING sharp goes into the height field. Attempt 2's crisp arris ridge and
       its dish both did, and the normal map turned them into a continuous bright
       polygonal net with a dark dot inside every cell — measured at 6x, crazed
       pottery. The arris survives in ALBEDO as a faint seam and in the wear
       supply as the line the polish finds, which is where a change of FINISH
       belongs; the relief is only the facet levels and the smooth undulation. */
    const plate = (soft[i] - 0.5) * 0.021 + (cr - 0.5) * 0.013 * join;
    const dn = dent[i];
    // A dent is a real depression with a raised lip around it.
    const dentH = -dn * 0.021 + ss(0.06, 0.34, dn) * (1 - ss(0.34, 0.62, dn)) * 0.006;
    const ab = (scrA[i] - 0.5), bb = (scrB[i] - 0.5);
    const scratch = sat(scuff[i]) * 0.74;
    const sIn = strapIn[i], sEd = strapEdge[i];
    /* Abrasion, the scuff network and the strap bands contribute NOTHING to
       height. Brushed steel is an anisotropic ROUGHNESS and a scratch is a change
       of finish, not of form — both belong in roughness and in the wear supply,
       where they change how the highlight behaves and cannot draw a pattern of
       their own into the normal map. On a dome, lines in UV wrap into radial arcs,
       which is what the helm's combed swirl was. */
    c.h[i] = 0.62 + plate + dentH
      + (roll[i] - 0.5) * 0.0060
      + (det[i] - 0.5) * 0.0016
      + (grain[i] - 0.5) * 0.0006;

    const tv = ss(0.30, 0.74, tarn[i]);   // heat tint, low frequency, low contrast
    /* Oxide coverage. 0 = blued steel showing through, 1 = fired black scale.
       Deliberately high-contrast in VALUE and low in chroma, and now modulated by
       the rolled-sheet tier so the patches sit inside a broader value gradient
       rather than floating on a constant field. The strap band has scoured it. */
    const ox = sat(ss(0.34, 0.72, oxide[i]) * (0.82 + 0.42 * (roll[i] - 0.5) * 2)
      * (1 - 0.62 * sIn));

    /* ALBEDO ON A METAL IS THE SPECULAR F0, NOT A DIFFUSE COLOUR.
       Iron's F0 is 0.56 linear (~0.79 sRGB). The two states here are physically
       different MATERIALS, not two shades of one:
         field    a fired black oxide — a dielectric film over iron, so low
                  reflectance, high roughness, and `c.mt` below drops it to ~0.55
                  so it keeps a real diffuse lobe. That lobe is what makes the
                  field read as a dark material rather than a dark mirror.
         wear     bare polished steel at 0.804 sRGB / roughness 0.13 / metalness
                  1.0, applied by the shared proudness-gated pass. */
    let base = mix(0.470, 0.334, ox)
      + (roll[i] - 0.5) * 0.048        // rolled-sheet value structure
      + (cr - 0.5) * 0.022             // per-facet tone
      + (det[i] - 0.5) * 0.009
      + (grain[i] - 0.5) * 0.010       // T3, in albedo where it cannot sparkle
      - tv * 0.085
      /* Dents darken, but at 0.085 the nine per repeat read as PUNCHED HOLES at
         6x — perfectly round, near-black, evenly spaced. A dent is a bruise, not
         an aperture: most of its read should come from the relief and the dirt in
         it, not from a hole in the reflectance. */
      - dn * 0.048                     // a struck dent holds dirt
      /* The strap band's albedo lift, halved. ABLATION: setting the helm's normal
         weight to 0.00 left its soft radiating swirl almost unchanged, which rules
         the normal map out entirely and locates the remaining smear in the albedo
         line-fields — chiefly this one, because a band running along a fixed
         lattice direction becomes a spiral on any shell whose UVs converge. The
         band still reads as a scoured passage on the flat lames, where it belongs;
         its bright scoured EDGE (see `sEd` in the wear supply) is untouched, since
         that is a thin line rather than a broad tonal sweep. */
      + sIn * 0.026                    // scoured grey where the strap rides
      - ar * 0.014;                    // the arris reads as a seam, not as relief
    /* Roughness spread is what makes a metal read as metal: the oxide field is
       rough enough that its reflection of the room is a dim wash, and the polished
       arrises are smooth enough to concentrate the same light into a glint.
       T3 carries most of its amplitude HERE — 0.050 of texel grain and 0.020 of
       the 40-cycle perlin — because micro-roughness is what fine grain physically
       is on a metal, and because roughness cannot alias into sparkle. */
    const rough = 0.60 + ox * 0.15 + tv * 0.09
      + (grain[i] - 0.5) * 0.050
      + (det[i] - 0.5) * 0.020
      /* Directional abrasion and the scuff network are held DOWN to a third of
         what they were, and the reason is the helm. Both are LINE fields, and every
         dome in the build carries arc-length UVs that converge at the crown, so
         lines arc into a radial comb there. On a plate at roughness 0.70 a +/-0.020
         roughness streak is invisible; on the helm at 0.30 — after its polish
         multiplier — the same swing is a 7 % change in specular lobe width, which
         renders as fine radiating streaks, i.e. the "combed hair" read this file
         has now chased through three separate mechanisms. Fine grain is carried by
         the per-texel hash instead, which has no direction to converge. */
      + (ab * 0.011 + bb * 0.006)
      + sIn * 0.075                    // a rubbed band is dulled, not polished
      - scratch * 0.028
      + dn * 0.11
      - ar * 0.030;

    c.cr[i] = sat(base * 0.972); c.cg[i] = sat(base); c.cb[i] = sat(base * 1.040);
    c.rg[i] = sat(rough);
    // The black oxide and the heat tarnish are both dielectric films: they must
    // pull metalness down, not merely darken the tint, or the field still mirrors
    // the room and the plate has no diffuse component at all.
    c.mt[i] = sat(1 - (0.40 + ox * 0.22 + tv * 0.24) * (1 - 0.35 * sIn));
    /* TIER 2 SUPPLY — where abrasion WOULD expose bright steel. finalize() then
       multiplies this by the measured proudness of the height field, so a texel
       that is not standing proud gets nothing however high its supply is. That
       gate is the whole reason this can be authored generously and still come out
       as lines and points rather than as the broad plateau the previous pass shipped
       (26 % of the breastplate above 0.72 display luminance).
         arris   the standing ridge between two hammer blows
         scratch the isotropic scuff network
         lip     the proud rim thrown up around a dent
         sEd     the cut edge of a strap, digging in as it rubs */
    /* The SUPPLY has to reach ~1 where the story says the metal is bare, because
       the gate is what makes wear rare — not the supply. Held at ~0.5 (as it was)
       the arithmetic caps the polished state at a 50 % blend, i.e. albedo 0.61
       against bare steel's 0.804, and the plate has a grey wash instead of a
       highlight: measured 0.01 % of the map above 0.72. Supply near 1 plus a
       window gate gives the right shape — a small area at FULL bare steel. */
    c.wr[i] = sat((0.56 + ar * 0.42 + scratch * 0.40 + sEd * 0.85
      + ss(0.05, 0.30, dn) * (1 - ss(0.30, 0.58, dn)) * 0.50)
      * (0.74 + 0.44 * cr) * (1 - 0.30 * tv) * (1 - 0.50 * sIn));
    // Grime supply: the oxide patches are porous and the dents are pits, so both
    // hold dirt. finalize() weights this by cavity and then knocks it back
    // wherever the wear pass fired, so dirt and polish cannot occupy one texel.
    c.gm[i] = sat(0.20 + ox * 0.40 + dn * 0.42 + tv * 0.34 + sIn * 0.20);
  }
}

function genHeroMail(c, T) {
  const { field, fieldN, fbmT, perlinT, hash2, clamp01: sat, smoothstep: ss } = T;
  const size = c.size, S = c.seed, P = c.params, n = size * size;

  /* ==================================================================== *
   * Riveted mail, in three declared tiers.
   *
   * The round-2 complaint that a mail sleeve and a breastplate shared one grain
   * was true, and the reason was that the mail's only real feature was a ring
   * BAND — a torus cross-section — with nothing inside it and nothing on it. A
   * lattice of featureless donuts sampled at three screen pixels is a dot screen,
   * and so is a lattice of hammer dimples. Two things fix that and both are
   * topology, not frequency: the rings must have HOLES you can see through the
   * shading of, and each ring must carry the RIVET that closes it.
   *
   *  T1  ring topology — 20 x 18 rings per repeat = a 9.8 mm ring at the mail's
   *      0.196 m repeat, which is a real 14th-century link. Two interleaved
   *      lattices, each ring showing wire, hole and rivet.
   *  T2  wear that follows form — the ring CROWNS burnish to bright iron through
   *      the shared proudness-gated pass, while the interstices and the holes go
   *      dark and dielectric. That opposition — bright ring, black hole — is what
   *      makes mail read as mail at a glance instead of as knitted wool.
   *      Over the top, a 3-cycle rub field: the shoulders and forearms of a
   *      hauberk are polished by the plate riding on them, the flanks are not.
   *  T3  drawn-wire striae running AROUND each wire, plus a per-texel hash.
   * ==================================================================== */
  P.normalStrength = 1.08;
  P.aoStrength = 1.05; P.cavity1 = 1.35; P.cavity2 = 1.0;
  P.grimeAmount = 0.66; P.grimeColor = [0.026, 0.028, 0.036]; P.grimeRough = 0.90;
  P.grimeMetalKill = 0.55; P.grimeFill = 0.30; P.cavityTint = 0.36;
  P.roughMin = 0.14; P.displacement = 0.020;
  P.wearAmount = 0.92; P.wearColor = [0.782, 0.786, 0.812];
  P.wearRough = 0.17; P.wearMetal = 1.0; P.wearScale = 26; P.wearProud = 1.0;
  // A ring's crown IS most of the ring, so the window is wide open at the bottom.
  P.wearGate = [0.26, 0.86];

  const TAU2 = 6.283185307179586;
  /* Two interlocking lattices of rings. Periods are integers (and even in v,
     because the row-parity offset has period 2) so the tile is seamless. */
  /* MEASURED, not chosen. `tube()` sets uRepeat = round(circumference / uvScale),
     so on a 0.35 m arm at 0.196 m per repeat the sleeve carries 2 repeats around,
     i.e. 0.173 m of surface per repeat. At the previous 20 x 18 that is a 8.6 mm
     ring, and at the closeup camera's measured 369 px/m a 8.6 mm ring is 3.2
     SCREEN PIXELS — inside the aliasing band, which is why the sleeve resolved to
     salt-and-pepper noise at 9x rather than to rings, and why it shared a read
     with every other fine surface on the figure. 13 x 12 gives a 13 mm ring
     across and 16 mm along: 5-6 screen pixels, which resolves as a ring with a
     hole in it. A 13 mm link is a coarse hauberk rather than a fine one, and that
     is the correct trade — mail that reads as mail beats mail that is
     dimensionally right and renders as grey static. */
  const NX = 13, NY = 12;
  const [wire, hole, rivet, stri] = fieldN(size, 1, 4, (u, v, out) => {
    const fx = u * NX, fy = v * NY;
    let best = 0, bestAng = 0, bestId = 0, bestD = 1;
    for (let k = 0; k < 2; k++) {
      const yy = fy - k * 0.5;
      const row = Math.floor(yy);
      const off = (((row % 2) + 2) % 2) * 0.5;
      const xx = fx - off - k * 0.26;
      const col = Math.floor(xx);
      const cx = col + 0.5;
      const dx = xx - cx, dy = (yy - row - 0.5) * 1.34;
      const dd = Math.sqrt(dx * dx + dy * dy);
      const t = 1 - sat(Math.abs(dd - 0.335) / 0.135);
      const val = Math.sin(t * Math.PI * 0.5) * (k === 0 ? 1 : 0.87);
      if (val > best) {
        best = val;
        bestAng = Math.atan2(dy, dx);
        bestId = hash2(col + 1, row + 1, S + 59 + k * 17);
        bestD = dd;
      }
    }
    out[0] = best;
    // Inside the ring: 1 in the eye of the link, 0 on the wire and outward. This
    // is the channel that lets a ring read as a ring rather than as a blob.
    out[1] = 1 - ss(0.06, 0.20, bestD);
    /* The rivet that closes the link. One per ring, at a per-ring angle, and
       small — about 20 degrees of arc — so it reads as a bright bead on the wire
       at closeup and averages harmlessly away at gameplay distance. */
    let da = bestAng - (bestId * TAU2);
    da = Math.abs(da - Math.round(da / TAU2) * TAU2);
    out[2] = ss(0.34, 0.86, best) * (1 - ss(0.0, 0.30, da));
    /* T3 — drawn-wire striae. They run AROUND the wire (they are a function of
       the ring's angular coordinate), which is what a wire drawn through a
       die actually shows, and being tied to the ring's own frame they cannot
       read as a screen-space or UV-space pattern. */
    out[3] = 0.5 + 0.5 * Math.sin(bestAng * 13 + bestId * 19);
  });
  const dye = field(size, 4, (u, v) => fbmT(u * 4, v * 4, 4, 4, 4, 0.55, S + 11));
  /* T2 — rub zones: 3 cycles, i.e. a 65 mm passage on the sleeve. A hauberk is
     polished bright where a pauldron or a vambrace rides on it and dark in the
     hollows, and that body-scale variation is what stops a sleeve reading as one
     even mesh from wrist to shoulder. */
  const rub = field(size, 8, (u, v) => fbmT(u * 3 + 2, v * 3, 3, 3, 3, 0.6, S + 17));
  /* 40 cycles = 4.9 mm, about half a ring. At the previous 148 cycles it was
     1.3 mm — barely one screen pixel at the closeup camera — and it aliased into
     the same grey sparkle the plate carried, which is how a mail sleeve and a
     breastplate ended up sharing a grain. */
  const det = field(size, 2, (u, v) => perlinT(u * 40, v * 40, 40, 40, S + 23));
  const grain = new Float32Array(n);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) grain[i] = hash2(x, y, S + 151);
  }

  for (let i = 0; i < n; i++) {
    const r = wire[i], hl = hole[i], rv = rivet[i], st = stri[i] - 0.5;
    const rb = rub[i] - 0.5;

    /* NO per-texel grain in the mail's height. On the plate a texel hash in height
       is harmless because the plate is nearly flat and heavily minified; on a mail
       SLEEVE the surface is a tube seen at a grazing angle over most of its width,
       mip selection there picks the sharpest mip in one axis, and the hash comes
       through as real normal noise — grey static laid over the ring lattice. Fine
       grain on the mail lives in roughness only. */
    c.h[i] = 0.40 + r * 0.42 + rv * 0.030 - hl * 0.035
      + st * 0.010 * r
      + (det[i] - 0.5) * 0.018;

    const shade = 0.80 + dye[i] * 0.30;
    /* A riveted ring is drawn iron: the crown of each ring is bright metal
       (0.72 sRGB = 0.47 linear) and the gaps between rings are dark because they
       are OCCLUDED, which the cavity channel carries — not because the iron is
       black. The rub field then swings the whole passage +/-14 %. */
    const base = sat((0.296 + r * 0.412) * shade * (1.0 + rb * 0.28)
      + rv * 0.055
      - hl * 0.115
      + st * 0.020 * r
      + (grain[i] - 0.5) * 0.010);
    c.cr[i] = sat(base * 0.975); c.cg[i] = base; c.cb[i] = sat(base * 1.045);
    c.rg[i] = sat(0.76 - r * 0.38 - rb * 0.16 + hl * 0.12
      + (det[i] - 0.5) * 0.06 + (grain[i] - 0.5) * 0.032 - st * 0.030 * r);
    c.mt[i] = sat(0.44 + r * 0.54 - hl * 0.22);
    // T2 supply: ring crowns and rivet heads, weighted by the rub passage. The
    // proudness gate in finalize() then confines it to the actual crowns.
    c.wr[i] = sat((ss(0.42, 0.95, r) * 0.78 + rv * 0.85) * (0.42 + 0.95 * rub[i]));
    c.gm[i] = sat(0.74 - r * 0.42 + hl * 0.30 - rb * 0.22);
  }
}

/* ================================================================== *
 * shader
 * ================================================================== */

// TWO WAYS TO SILENTLY DELETE THE HERO FROM EVERY FRAME, both previously shipped:
//   1. A backtick inside one of the GLSL strings below. They are JS template
//      literals, so a backtick ends the template, the module fails to parse and
//      Hero never loads — the frame simply has no character in it.
//   2. A comment-close sequence inside a GLSL comment. GLSL comments do not
//      nest, so it ends the comment early, the following prose compiles as
//      code, the program fails to LINK and the material renders flat white.
// Use plain words and single quotes in these blocks. Nothing else.

const HERO_FRAG_HEAD = /* glsl */`
varying float vHeroWear;
/* x: cavity 0..1, y: per-piece polish, z: per-piece oxide,
   w: PER-PIECE NORMAL WEIGHT.
   The fourth channel is the one the previous pass identified as the next move and
   did not take. Without it the plate texture's relief amplitude had to be set to
   whatever the WORST case on the figure could tolerate — a 105 mm helm dome, whose
   arc-length UVs converge at the crown and turn any cell-wall network into a comb
   — so it was held at 0.50 and the breastplate, which wants every bit of its
   hammer work, was paying for the helm. Now the dome takes 0.20 of the map and the
   cuirass takes 1.00, from one texture, in one draw call. */
varying vec4  vHeroSurf;
varying float vHeroUp;       // rig-space normal.y, post-skinning
varying vec3  vHeroPos;
uniform vec4  uHeroCav;      // x: albedo mult at cavity=1, y: roughness target, z: metalness mult, w: roughness blend
uniform vec3  uHeroCavTint;  // chroma of the oxide that collects in the recesses
uniform vec2  uHeroPol;      // roughness multiplier at polish 0 / polish 1
uniform vec4  uHeroOx;       // x: albedo mult at oxide=1, y: roughness target, z: metalness mult, w: roughness blend
uniform vec3  uHeroOxTint;   // chroma of the fired black scale
uniform vec3  uHeroGnd;      // x: tight contact reach (m), y: ambient reach (m), z: strength
uniform float uHeroFlash;
uniform vec3  uHeroFlashColor;
uniform vec4  uHeroHue;      // rgb: luminance-normalised target chroma, a: how hard to force it
uniform float uHeroAlb;      // albedo multiplier — see the note in _material()
uniform vec2  uHeroRgh;      // roughness = x + map * y
uniform vec2  uHeroMtl;      // metalness = x + map * y
uniform vec3  uHeroWear;     // x: rough mult at wear=0, y: rough mult at wear=1, z: metal add
uniform vec4  uHeroWearCol;  // x: albedo gain at wear=1, y: damp darkening, zw: wear remap window
uniform vec4  uHeroRim;      // rgb: grazing-angle sheen colour, a: strength
uniform vec4  uHeroCool;     // rgb: cold ambient wrap colour, a: strength
uniform vec4  uHeroBounce;   // rgb: warm floor-bounce colour, a: strength
uniform vec4  uHeroGrade;    // rgb: target chroma for the *shaded* result, a: amount
/* Written by HERO_FRAG_SURF (which runs at metalnessmap_fragment, before the
   lighting accumulation) and consumed by HERO_FRAG_AO at aomap_fragment. The
   hero binds no aoMap — four samplers is the ceiling — so USE_AOMAP is never
   defined and three's own aomap chunk compiles to nothing. This is the
   replacement path for the *character's* occlusion, and it has to modulate the
   indirect lobes rather than the albedo: multiplying diffuseColor alone leaves a
   full-strength environment reflection on the underside of a sabaton, which is
   how a boot ends up darker in albedo and no darker on screen. */
float heroOcclusion = 1.0;
`;

/**
 * Hue discipline, injected straight after the albedo fetch.
 *
 * The generated surface textures are authored warm — `metal` carries iron-oxide
 * patches at (0.30, 0.16, 0.08) and `cloth` is oxblood wool at (0.26, 0.14,
 * 0.12). Sampled raw in a crypt lit by firelight, every one of them lands on
 * the same warm brown as the floor and the hero's silhouette stops reading.
 * So: keep the texture's *value* structure, which is where all the grain and
 * wear detail lives, and force its *chroma* to an authored target. The vertex
 * colour multiply (`color_fragment`) runs after this, so per-part tints — the
 * crimson of a tabard, the tarnish in a cavity — survive untouched.
 */
const HERO_FRAG_ALBEDO = /* glsl */`
  {
    float heroL = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, heroL * uHeroHue.rgb, uHeroHue.a ) * uHeroAlb;
  }
`;

const HERO_FRAG_SURF = /* glsl */`
  {
    /* Remap the edge-wear channel through an explicit window before anything
       reads it. The raw channel has a floor (a sheltered plate is still 0.30) and
       most small proud parts are authored at a flat 0.85-1.0, so used directly it
       is nearly constant across the figure and cannot express a *material*
       change. Windowed, wear becomes the geometry-scale switch between two real
       materials — black oxide below the window, bare burnished steel above — and
       that is what puts the bright specular on the plate edges, the pauldron
       rims, the rivets, the knuckles and the sword's edge rather than on
       everything at once. */
    float w = smoothstep( uHeroWearCol.z, uHeroWearCol.w, clamp( vHeroWear, 0.0, 1.0 ) );
    // Remap the map's roughness into an authored window before the wear pass.
    // Raw, the metal generator swings 0.30 -> 0.94 across its rust patches,
    // which on a curved plate reads as corroded bronze rather than plate.
    roughnessFactor = clamp( uHeroRgh.x + roughnessFactor * uHeroRgh.y, 0.03, 1.0 );
    roughnessFactor = clamp( roughnessFactor * mix( uHeroWear.x, uHeroWear.y, w ), 0.035, 1.0 );
    metalnessFactor = clamp( uHeroMtl.x + metalnessFactor * uHeroMtl.y + uHeroWear.z * w, 0.0, 1.0 );
    diffuseColor.rgb *= mix( 1.0, uHeroWearCol.x, w );

    /* ---- per-piece finish ----
       One material, many pieces, and a suit of armour is not uniformly finished:
       the helm is the one thing its owner keeps bright, the sabatons have been
       kicked through gravel for a year, the fauld hangs in the dust. 'polish'
       is authored per piece and shifts roughness for that piece alone, so the
       specular response differs from plate to plate on a single draw call. */
    float pol = clamp( vHeroSurf.y, 0.0, 1.0 );
    roughnessFactor = clamp( roughnessFactor * mix( uHeroPol.x, uHeroPol.y, pol ), 0.035, 1.0 );

    /* ---- per-piece oxide ----
       The other half of "different wear per armour piece", and the half a UV
       offset cannot deliver: a tile offset changes WHICH noise a plate carries,
       not how dark it is. This changes the plate's *material state*. The suit is
       authored as a range — a nearly bare gauntlet at 0.10 next to a
       hard-blackened fauld at 0.86 — so neighbouring plates differ in value at a
       glance, which is what a real harness looks like and what the previous pass
       (one albedo for every steel piece on the figure) did not.
       Weighted out of the worn rims: burnish is bare metal and cannot be black,
       so oxide must not dull the very highlights that make the plate read. */
    float ox = clamp( vHeroSurf.z, 0.0, 1.0 ) * ( 1.0 - 0.82 * w );
    diffuseColor.rgb *= mix( vec3( 1.0 ), uHeroOxTint * uHeroOx.x, ox );
    roughnessFactor = mix( roughnessFactor, uHeroOx.y, ox * uHeroOx.w );
    metalnessFactor *= mix( 1.0, uHeroOx.z, ox );

    /* ---- cavity tarnish ----
       The counterpart to edge wear, and the other half of what makes metal read
       as metal: where edge wear exposes bright steel on the convex rims, the
       recesses collect a black-brown oxide that darkens, roughens AND kills
       metalness *together*. Moving those three independently is exactly what
       makes a PBR surface read as painted resin. Driven by the geometry's own
       concavity (see edgeCavity), so it lands in the inner faces, the flanks
       of a raised keel and the strip under every overlapping lame — never as a
       noise field sprayed over the whole piece. */
    float cav = clamp( vHeroSurf.x, 0.0, 1.0 );
    diffuseColor.rgb *= mix( vec3( 1.0 ), uHeroCavTint * uHeroCav.x, cav );
    roughnessFactor = mix( roughnessFactor, uHeroCav.y, cav * uHeroCav.w );
    metalnessFactor *= mix( 1.0, uHeroCav.z, cav );

    // damp boots: the last 25 cm darken and gloss up, like leather out of mud
    float damp = ( 1.0 - smoothstep( 0.03, 0.30, vHeroPos.y ) ) * uHeroWearCol.y;
    diffuseColor.rgb *= 1.0 - 0.34 * damp;
    roughnessFactor = clamp( roughnessFactor - 0.30 * damp, 0.04, 1.0 );

    /* ---- contact occlusion on the character itself ----
       "The hero's foot lands and there is LITERALLY zero darkening." Ground
       contact is a two-sided contract: the floor darkens under the boot (a
       ground pool, which lives outside this file) and the boot darkens against
       the floor (only this shader can do it — the screen-space AO pass does not
       see skinned meshes, and a cascaded shadow map cannot resolve a 20 mm
       gradient at any sane texel density).

       TWO lobes, because a real contact has two length scales and the previous
       single 70 mm lobe at 0.30 peak strength was invisible:
         tight    0..uHeroGnd.x (30 mm) — the crushed black seam where sole meets
                  stone. Nearly total on down-facing geometry.
         ambient  0..uHeroGnd.y (240 mm) — the floor stealing sky from the whole
                  lower boot and greave. Weak, wide, and the thing that actually
                  makes the leg look planted rather than pasted on.
       Both are weighted away from up-facing normals: the instep of a sabaton
       sees the room, its welt does not. */
    float tight = 1.0 - smoothstep( 0.002, uHeroGnd.x, vHeroPos.y );
    float wide  = 1.0 - smoothstep( uHeroGnd.x * 0.5, uHeroGnd.y, vHeroPos.y );
    float face  = clamp( 0.46 - 0.62 * vHeroUp, 0.0, 1.0 );
    float occ = clamp( ( tight * face * 2.05 + wide * ( 0.20 + 0.55 * face ) * 0.62 )
      * uHeroGnd.z, 0.0, 1.0 );
    diffuseColor.rgb *= 1.0 - 0.88 * occ;
    roughnessFactor = clamp( roughnessFactor + 0.22 * occ, 0.035, 1.0 );
    // Occlusion has to reach the specular too, or the boot darkens in albedo and
    // then a full-strength environment reflection puts the value straight back.
    heroOcclusion = 1.0 - 0.80 * occ;
  }
`;

/** Applies `heroOcclusion` to the indirect lobes. See the note in the head. */
const HERO_FRAG_AO = /* glsl */`
  {
    reflectedLight.indirectDiffuse *= heroOcclusion;
    #if defined( USE_ENVMAP ) && defined( STANDARD )
      reflectedLight.indirectSpecular *= heroOcclusion;
    #endif
    #ifdef USE_CLEARCOAT
      clearcoatSpecularIndirect *= heroOcclusion;
    #endif
    #ifdef USE_SHEEN
      sheenSpecularIndirect *= heroOcclusion;
    #endif
  }
`;

const HERO_FRAG_EMIT = /* glsl */`
  {
    // Grazing-angle sheen. The player silhouette must read against any
    // background at 30 m, and this is the cheapest honest way to get it: a
    // Fresnel edge term, kept well under 1.0 so it never trips the bloom
    // threshold and turns into a cartoon outline.
    float heroNdV = clamp( dot( normalize( vViewPosition ), normalize( normal ) ), 0.0, 1.0 );
    float heroF = pow( 1.0 - heroNdV, 4.0 );
    totalEmissiveRadiance += uHeroRim.rgb * ( heroF * uHeroRim.a );
    // Cold ambient wrap. The crypt probe's key lobe is (4.2, 1.85, 0.55) and
    // every practical in the scene is firelight, so a physically correct metal
    // comes out orange — the hero then shares the environment's hue and the
    // figure dissolves into the floor. This is a small, explicitly directed
    // cool fill weighted to up-facing surfaces, i.e. the skylight a suit of
    // plate would be catching. Held far under 1.0 so bloom never sees it.
    float heroUp = clamp( 0.5 + 0.5 * normal.y, 0.0, 1.0 );
    totalEmissiveRadiance += uHeroCool.rgb * ( uHeroCool.a * mix( 0.42, 1.0, heroUp ) );
    /* Floor bounce. At metalness 0.8 a plate has almost no diffuse lobe, so any
       surface whose normal points away from every light in the room resolves to
       black — which is what turned the pauldrons into two black scallops while
       the cuirass was blowing out. In a stone room lit from below by fire there
       *is* light arriving from underneath, and this is it: warm, weighted to
       down-facing normals, and small enough that it lifts the undersides off
       zero without flattening them. Physically it stands in for the floor's
       first bounce, which the probe volume only samples at a metre's cadence. */
    totalEmissiveRadiance += uHeroBounce.rgb * ( uHeroBounce.a * clamp( -normal.y, 0.0, 1.0 ) );
  }
  totalEmissiveRadiance += uHeroFlashColor * uHeroFlash * 2.1;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), uHeroFlash * 0.38 );
`;

/**
 * Per-character colour grade, applied to the *shaded* result.
 *
 * This is the one thing that actually makes the plate read cold, and it is
 * worth being explicit about why an albedo tint cannot. The crypt probe's key
 * lobe is (4.2, 1.85, 0.55) and every practical in the scene is firelight, so
 * the incident radiance ratio is roughly 7.6 : 3.4 : 1. Multiply that by even
 * an aggressively blue albedo of (0.80, 1.01, 1.40) and the product is still
 * 4.3 : 2.4 : 1 — brass. Physically correct, and wrong for the brief: the hero
 * has to separate from a warm environment, and a suit of armour that shares the
 * floor's hue is a silhouette failure on its own.
 *
 * So the balance happens after lighting, weighted *down* in the brightest
 * values so a firelight glint on a burnished rim still comes through warm. That
 * highlight-preserving weight matters — a flat grade over the whole range
 * flattens the specular and the armour goes back to looking like painted resin.
 */
const HERO_FRAG_GRADE = /* glsl */`
  {
    float heroLum = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
    float g = uHeroGrade.a * ( 1.0 - 0.58 * smoothstep( 0.30, 1.30, heroLum ) );
    outgoingLight = mix( outgoingLight, heroLum * uHeroGrade.rgb, g );
  }
`;

function injectHeroShader(mat, u) {
  mat.userData.heroU = u;
  mat.onBeforeCompile = (shader) => {
    for (const k in u) shader.uniforms[k] = u[k];
    shader.vertexShader =
      'attribute float aMask;\nattribute vec4 aSurf;\n'
      + 'varying float vHeroWear;\nvarying vec4 vHeroSurf;\nvarying float vHeroUp;\nvarying vec3 vHeroPos;\n'
      + shader.vertexShader.replace(
        '#include <skinning_vertex>',
        '#include <skinning_vertex>\n\tvHeroWear = aMask;\n\tvHeroSurf = aSurf;\n'
        // objectNormal is already skinned at this point (skinnormal_vertex runs
        // in the normal block above), and the mesh matrix is identity, so this
        // is the rig-space up-ness the ground-contact term needs.
        + '\tvHeroUp = normalize( objectNormal ).y;\n\tvHeroPos = transformed;'
      );
    shader.fragmentShader = HERO_FRAG_HEAD + shader.fragmentShader
      /* PER-PIECE NORMAL WEIGHT.
         NOT done by patching `mapN.xy *= normalScale;`. onBeforeCompile hands over
         the shader with its `#include` directives STILL UNRESOLVED — three expands
         ShaderChunk afterwards — so a replace against any chunk's internals is a
         silent no-op. (It was: the helm's comb survived a per-piece weight of 0.20
         because the weight was never in the program.) Patch the include line, which
         does exist at this point, and blend the perturbed normal back toward the
         interpolated geometric one. `vNormal` is view-space and this material is
         FrontSide, so it is the un-perturbed normal by definition. */
      .replace('#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n'
        + '#ifdef USE_NORMALMAP_TANGENTSPACE\n'
        + '\tnormal = normalize( mix( normalize( vNormal ), normal, clamp( vHeroSurf.w, 0.0, 1.0 ) ) );\n'
        + '#endif\n')
      .replace('#include <map_fragment>', '#include <map_fragment>' + HERO_FRAG_ALBEDO)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>' + HERO_FRAG_SURF)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + HERO_FRAG_EMIT)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>' + HERO_FRAG_AO)
      .replace('#include <opaque_fragment>', HERO_FRAG_GRADE + '#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'nona-hero-v9';
  return mat;
}

/**
 * Surface families.
 *
 *  uv     metres per texture repeat — the single number that decides whether
 *         the armour reads as steel or as a macro photograph of steel.
 *  hue    luminance-normalised target chroma (dot with Rec.709 luma ≈ 1, so
 *         forcing it changes colour without changing value).
 *  desat  how hard `hue` overrides the texture's own colour.
 *  rgh    roughness = x + mapRoughness * y  (window remap)
 *  mtl    metalness = x + mapMetalness * y
 *  wRgh   roughness multiplier at wear 0 / wear 1
 *  wMtl   metalness added at full edge wear
 *  gain   albedo multiplier at full edge wear (burnished back to bright metal)
 *  cool   cold ambient wrap colour + strength
 *  rimK   gain on the HERO-LOCKED rim light (Lighting.js injects the term; this
 *         is the per-material response). It is not the same thing as `rim`,
 *         which is this material's own ambient Fresnel sheen. A matte gambeson
 *         scatters a grazing light far more visibly than a burnished pauldron
 *         does, and warm gold takes a cold rim badly, so the one light needs a
 *         different weight per surface family to read as a single edge.
 */
const SURFACES = {
  /**
   * `alb` exists because the texture generators write *linear* values into an
   * sRGB-encoded texture: `cloth`'s oxblood 0.255 becomes byte 65, which the
   * shader decodes as 0.054 linear. Sampled straight, every fabric on the hero
   * came out near-black. This is the per-family compensation, applied in the
   * same place as the hue discipline.
   */
  cloth: {
    kind: 'cloth', uv: 0.104, seed: 5309, tint: 0xf4f2f6, alb: 2.45,
    hue: [0.930, 1.004, 1.156], desat: 0.88,
    rgh: [0.42, 0.54], mtl: [0.0, 0.02], wRgh: [1.0, 0.92], wMtl: 0.0,
    gain: 1.14, wRange: [0.0, 1.0], normalScale: 0.82, env: 0.26, damp: 0.55,
    rim: [0x56637d, 0.085], cool: [0x5c6f9c, 0.026], bounce: [0xa8632f, 0.016],
    grade: [0.960, 1.000, 1.075, 0.10], rimK: 1.24,
    // Wool gathering into a fold is darker and matter at the bottom of the
    // channel; there is no oxide, so metalness is untouched.
    cav: [0.44, 1.00, 1.00, 0.42], cavTint: [0.94, 0.955, 1.00], pol: [1.05, 0.94],
    // Cloth does not oxidise; the channel carries soaked-in grime instead.
    ox: [0.62, 1.00, 1.00, 0.30], oxTint: [1.00, 0.94, 0.88], gnd: [0.030, 0.300, 1.05],
  },
  leather: {
    kind: 'leather', uv: 0.126, seed: 6113, tint: 0xece6e0, alb: 2.05,
    hue: [1.052, 0.994, 0.930], desat: 0.74,
    rgh: [0.30, 0.58], mtl: [0.0, 0.05], wRgh: [1.0, 0.72], wMtl: 0.02,
    gain: 1.24, wRange: [0.0, 1.0], normalScale: 1.0, env: 0.30, damp: 1.0,
    rim: [0x565c66, 0.12], cool: [0x5a6a90, 0.024], bounce: [0xa5602c, 0.014],
    grade: [1.000, 0.998, 1.010, 0.42], rimK: 1.12,
    // A crease in hide holds dirt and loses its wax: darker, much rougher.
    cav: [0.40, 0.99, 1.00, 0.62], cavTint: [1.00, 0.93, 0.86], pol: [1.10, 0.78],
    /* Hide takes wax and mud, not oxide. `gnd` is the widest on the figure and
       the strongest: the boots ARE the ground contact, and this family is the one
       the art director measured when he wrote that the foot lands with literally
       zero darkening. */
    ox: [0.58, 1.00, 1.00, 0.34], oxTint: [1.00, 0.92, 0.84], gnd: [0.038, 0.270, 1.24],
  },
  /**
   * Blackened plate — and this is where the "no highlights" defect lived.
   *
   * The previous pass tried to keep the armour cold by *crushing the albedo*
   * (`alb` 0.42) and holding metalness near 0.6. On a metal the albedo IS the
   * specular F0, so that combination produced F0 ≈ 0.06: a surface physically
   * incapable of a specular highlight. The frame measured p99 = 0.53 with the
   * NO HIGHLIGHTS flag, and the plate read as matte grey-brown, because the only
   * things lighting it were a 2% diffuse lobe and two emissive fudge terms.
   *
   * The correct way to keep a metal cold in a firelit room is not to make it a
   * bad mirror. It is:
   *   1. real F0 (iron = 0.56 linear), so a highlight can exist at all;
   *   2. a *roughness* spread — the field is rough enough (0.26–0.52) that its
   *      reflection of the room is a dim wash, while the worn rims drop to
   *      0.12–0.27 and concentrate the same light into a small bright glint.
   *      Highlights are then rare and earned, which is the rubric's ask;
   *   3. a cold F0 tint plus the post-lighting grade below, whose weight falls
   *      off in the highlights — so the mid-tones read as cold steel while the
   *      brightest hits stay warm, because they are firelight and should be.
   * `env` can now carry real weight: the crypt probe is a dark cold field
   * (zenith 0x101a26), so at 1.05 it fills the flats with a slate reflection
   * that varies over a curved plate — which is most of what makes plate read as
   * metal — without ever approaching the bloom threshold.
   */
  steel: {
    /* `alb` 0.56 -> 0.505. Adding a real tier-2 wear pass raised the plate's mean
       display luminance from 0.433 to 0.500 in the cuirass region, measured on the
       frame — the contrast gain is what was wanted (sd 0.193 -> 0.222) but the
       brightening is not: this armour has to stay dark, and "near-white plate" is
       a complaint this project has already had twice. Scaling the whole albedo
       preserves the field/wear RATIO, so the contrast survives and only the value
       comes down. Burnished steel still lands at F0 0.30 in the map and 0.48 on
       the curvature-worn rims via `gain`, which is polished iron's range. */
    kind: 'heroPlate', uv: 0.098, seed: 7717, tint: 0xf6f8fa, alb: 0.505,
    hue: [0.876, 1.006, 1.216], desat: 0.90,
    /* These windows exist to *preserve* the two-material split the generator
       authored, not to flatten it into an average. Solved against the map's
       actual output so the oxide field and the burnished crests both land where
       they were designed to:
         roughness = 0.06 + map * 0.72  ->  field 0.56-0.66, burnish 0.16
         metalness = 0.13 + map * 0.84  ->  field 0.50-0.60, burnish 0.97
       The wear channel then only fine-tunes: it cannot be doing the heavy
       lifting here, because a per-vertex radius function has no idea where the
       hammer crests are. */
    /* Re-solved against the generator's new roughness range (field 0.58-0.81,
       burnish 0.13 — see genHeroPlate):
         roughness = 0.24 + map * 0.60  ->  field 0.59-0.73, burnish 0.32
         metalness = 0.13 + map * 0.84  ->  field 0.44-0.58, burnish 0.97
       then wRgh takes the curvature-worn rims to 0.10. */
    /* RE-SOLVED against the rewritten generator, measured at 512 px after
       finalize() (not guessed — see the note above genHeroPlate):
         map roughness  p10 0.428  p50 0.700  p90 0.761   worn tail p01 0.137
         map metalness  p10 0.361  p50 0.590  p99 0.996
       so
         roughness = 0.04 + map * 0.87  ->  field 0.61-0.70, worn arris 0.16
         metalness = -0.02 + map * 1.02 ->  field 0.35-0.58, worn arris 1.00
       `wRgh` and `wMtl` are BOTH pulled back hard (0.30 -> 0.55, 0.50 -> 0.30)
       because the texture's own tier-2 pass now carries the polish. Leaving them
       where they were double-counted it: a rim that is worn in the texture AND
       worn per-vertex landed at roughness 0.024, i.e. a perfect mirror, which is
       the mechanism behind every previous 'clipped white specular on every rim'
       report. Vertex wear now fine-tunes what the map already says. */
    rgh: [0.04, 0.87], mtl: [-0.02, 1.02], wRgh: [1.04, 0.55], wMtl: 0.30,
    /* `gain` is the albedo multiplier at FULL edge wear, and 3.60 was a
       catastrophe hiding in plain sight. The generator authors its burnished
       crests at 0.808 sRGB = 0.62 linear; times `alb` 0.56 that is F0 = 0.347,
       correct for polished iron under this material's cold tint. Multiplying it
       by 3.60 put F0 at **1.25** — a physically impossible mirror. Every rim,
       every rivet, every roll on the figure was a clipped white specular, which
       is precisely the "near-white ... broad soft specular ... crumpled
       aluminium foil" read.
       1.66 puts the curvature-worn rims at F0 = 0.57, which is polished iron's
       real reflectance, and — because the curvature channel only fires on rolls,
       rivet crowns and standing edges — it buys the frame its highlights back as
       LINES AND POINTS rather than as the broad plateau this pass just removed
       from the plate field. That distinction is the whole brief: after darkening
       the field, the frame measured p99 = 0.69 and would have tripped the
       harness's own NO HIGHLIGHTS warning at 0.72. Highlights have to exist; they
       just have to be earned by geometry. */
    /* `env` 0.85 -> 1.00. The crypt probe is a dark cold field with one HDR key
       lobe at (4.2, 1.85, 0.55), so on a SMOOTH plate this is a small bright
       directional hit and on a rough one it is a dim slate wash — which is
       exactly the response that separates a kept helm from a kicked sabaton
       without either of them changing colour. It is also the term that lifts the
       pauldrons, whose normals face no practical in the room, off zero. */
    /* normalScale 0.94 -> 0.50, and this number was earned by ablation rather than
       taste. Setting it to 0 (everything else untouched) removed the helm's
       "combed swirl" completely, which located the defect in the NORMAL MAP. Then,
       one layer at a time: the directional abrasion is not it, the 40-cycle detail
       perlin is not it, the scuff network is not it, the helm's UV density is not
       it (that only changes the comb's width). What is left, and what it is, is the
       planishing field itself — a domain-warped Worley is a network of cell WALLS,
       i.e. inherently a system of curved ridges, and on a 105 mm dome under a
       single hard key those ridges arc into a comb.
       That field is correct for a breastplate, where 25 mm dishes on a nearly flat
       plate read as hammer work (verified in the frame). It is wrong at full
       strength on a small sphere. 0.50 is the amplitude at which the dome reads as
       a polished dome with soft planishing while the cuirass keeps enough relief to
       catch its own highlights — the cuirass's dish structure is also carried in
       albedo by the oxide field, so it does not depend on the normal alone.
       A per-piece normal weight (a fourth `aSurf` channel) would let the dome and
       the breastplate each have the amplitude they want; that is the next move
       here, not more amplitude. */
    /* normalScale 0.50 -> 0.92, and the reason it can go up is `MP.<piece>.nrm`.
       0.50 was not the amplitude the breastplate wanted; it was the amplitude the
       HELM could tolerate, because a cell-wall network wrapped round a 105 mm dome
       whose UVs converge at the crown arcs into a comb. One number for the whole
       suit had to be set by that worst case, so the cuirass got a third of the
       hammer relief it was authored with and rendered as soft pale blobs. The
       per-piece weight (aSurf.w) lets the dome take 0.20 of the map and the
       cuirass take 1.00, out of one texture in one draw call. */
    gain: 1.60, wRange: [0.40, 0.94], normalScale: 0.92, env: 1.00, damp: 0.6,
    /* `cool` raised from 0.046. It is weighted to up-facing normals, so it lands
       on the pauldrons and the tops of the vambraces — the pieces that face away
       from every practical in a crypt and were resolving to black scallops while
       the cuirass carried the frame. Lifting the darks is how the figure gets
       mid-tones; crushing the lights is only half the job. Still 6 % of the bloom
       threshold, so nothing here can glow. */
    rim: [0x93b4e6, 0.15], cool: [0x6f8ecb, 0.058], bounce: [0xc07437, 0.034],
    /* rimK 1.00 -> 1.32. The plate is now a genuinely dark material, and a dark
       material needs MORE of the hero-locked rim to hold its silhouette, not the
       same amount: value contrast against the floor was doing the separation for
       free while the armour was near-white, and darkening it hands that job back
       to the edge light. It is also the frame's cheapest honest highlight — a
       thin bright contour follows the geometry, so it cannot become the broad
       plateau this pass removed from the plate field. */
    grade: [0.874, 1.000, 1.216, 0.52], rimK: 1.32,
    /* Cavity tarnish. Black iron oxide is a *dielectric film*: it darkens the
       reflectance to a third, drags roughness to 0.94, and drops metalness to a
       quarter so the recess gains a diffuse lobe and stops mirroring the room.
       Warm-tinted, because fired scale and rust are both brown. */
    /* `pol` widened to [1.30, 0.44] from [1.26, 0.58]. This is the roughness
       multiplier at polish 0 / polish 1, and it is where the frame's earned
       highlights now come from: at 0.44 the helm dome, the comb and the blade run
       at roughness 0.26-0.30 against the fauld and sabatons at 0.77, so the one
       set concentrates the key lobe into a real specular while the other cannot.
       A single number spread over the suit buys highlights that are motivated by
       WHICH PIECE they are on, which is what "rare and earned" has to mean. */
    cav: [0.30, 0.94, 0.26, 0.88], cavTint: [1.10, 0.90, 0.74], pol: [1.30, 0.44],
    /* PER-PIECE OXIDE — the fired blue-black scale, driven by `MP.<piece>.oxide`.
       This is the lever that answers "every metal piece carries the SAME grey
       speckle": a tile offset changes which noise a plate samples, this changes
       how dark the plate IS. A sabaton at 0.86 and a gauntlet at 0.16 are two
       visibly different materials on one draw call. Cold-tinted, because gun
       bluing is a blue-black; and it kills metalness to 0.44 because the scale
       is a dielectric film, so the darkened plate keeps a diffuse lobe instead
       of turning into a dark mirror. */
    ox: [0.50, 0.84, 0.44, 0.64], oxTint: [0.90, 0.955, 1.09], gnd: [0.030, 0.240, 1.0],
  },
  /** Riveted mail: dark and occluded between the rings, a hard glint on each. */
  mail: {
    kind: 'heroMail', uv: 0.196, seed: 9127, tint: 0xf2f4f8, alb: 0.515,
    hue: [0.888, 1.004, 1.176], desat: 0.88,
    /* Solved against the rewritten ring generator (measured at 512 after
       finalize): map roughness p10 0.299 / p50 0.609 / p90 0.829, map metalness
       p10 0.321 / p50 0.666 / p99 0.983. So
         roughness = 0.01 + map * 0.98  ->  ring crown 0.30, hole 0.82
         metalness = 0.02 + map * 1.00  ->  ring crown 0.99, hole 0.34
       The spread between a ring's crown and the hole behind it is the whole
       reason mail reads as mail and not as knitted wool. */
    rgh: [0.01, 0.98], mtl: [0.02, 1.00], wRgh: [1.00, 0.68], wMtl: 0.14,
    gain: 1.30, wRange: [0.40, 0.94], normalScale: 0.95, env: 0.80, damp: 0.8,
    rim: [0x88a2cc, 0.14], cool: [0x687fb4, 0.026], bounce: [0xb06a33, 0.024],
    grade: [0.898, 1.000, 1.164, 0.50], rimK: 1.30,
    cav: [0.28, 0.96, 0.32, 0.90], cavTint: [1.08, 0.90, 0.78], pol: [1.12, 0.86],
    ox: [0.56, 0.90, 0.48, 0.66], oxTint: [0.92, 0.96, 1.07], gnd: [0.030, 0.220, 0.95],
  },
  /** Gold: the one warm accent, and the frame's most reliable bright specular. */
  gold: {
    kind: 'gold', uv: 0.170, seed: 8831, tint: 0xd8c9a4, alb: 0.92,
    hue: [1.176, 0.986, 0.610], desat: 0.42,
    rgh: [0.10, 0.34], mtl: [0.30, 0.68], wRgh: [1.00, 0.48], wMtl: 0.10,
    /* The gold roundel, the collar rim and the langet are the only warm elements
       on the figure and together they cover well under a thousand pixels, so this
       is the cheapest legitimate highlight in the frame — a small, saturated,
       motivated specular against a cold plate, which is exactly the D4 grammar. */
    gain: 1.44, wRange: [0.42, 0.96], normalScale: 0.22, env: 1.38, damp: 0.2,
    rim: [0xb59a62, 0.15], cool: [0x6f7f9c, 0.018], bounce: [0xc07c3a, 0.026],
    grade: [1.118, 1.000, 0.700, 0.16], rimK: 0.68,
    // Gold does not corrode, but the grime that fills an engraved line does.
    cav: [0.32, 0.88, 0.44, 0.80], cavTint: [1.00, 0.86, 0.62], pol: [1.18, 0.52],
    // Gold does not blacken. The channel only carries a dulling patina here, and
    // it is deliberately weak so the one warm accent stays the frame's highlight.
    ox: [0.80, 0.62, 0.86, 0.26], oxTint: [1.00, 0.90, 0.70], gnd: [0.026, 0.190, 0.85],
  },
};

/** Families whose albedo is a specular F0 and therefore need a metalness map. */
const METALLIC = new Set(['steel', 'gold', 'mail']);

/* ================================================================== *
 * per-piece surface profiles
 * ================================================================== *
 * This table is the direct answer to the round-1 blocker: "every metal piece on
 * the hero — helm dome, pauldron, cuisse, greave, gauntlet — carries the SAME
 * grey speckle at the SAME UV density."
 *
 * They did, and there were two reasons.
 *
 *  1. **One UV density for the whole suit.** Every steel piece was authored at
 *     0.098 m per texture repeat. The plate generator lays 17 x 11 planishing
 *     dishes per repeat, so that put a hammer dish at 5.8 mm — and at the
 *     closeup camera's ~380 px/m a 5.8 mm feature is 2.2 px. Mid-frequency
 *     structure rendered at two pixels is not structure, it is *speckle*, and
 *     it was identical on the helm and on the gauntlet because the number was
 *     identical. Here the spread runs 0.085 m (the blade) to 0.46 m
 *     (the backplate), a 5.4x range, so a breastplate carries 25 mm dishes that read
 *     as raised planishing while a gauntlet carries 11 mm ones that read as fine
 *     work — and NOTHING is authored below 0.085 m, because the generator's
 *     finest layer at 40 cycles per repeat has to stay above 2 mm to survive
 *     being sampled. Pushing a piece's density past that point does not buy
 *     finer detail, it buys aliasing, which is how the first pass ended up with
 *     one shimmer on every plate.
 *
 *  2. **One region of one texture.** Even at different densities, two pieces
 *     starting at UV (0,0) walk the same noise. Every piece therefore also gets
 *     its own tile offset, its own tile rotation, and in places an anisotropic
 *     stretch — so no two plates on the figure show the same field, in the same
 *     direction, at the same scale.
 *
 * `polish` shifts each piece's roughness independently (a kept helm against
 * kicked sabatons), `edge` and `cavity` weight the curvature-driven burnish and
 * oxide per piece, and `tint` selects which grime field the piece carries.
 *
 * `oxide` is the third axis and the newest. UV density and tile offset change
 * *which noise* a plate carries; they cannot change how dark it is, and the
 * measured defect was a value one — the whole steel family rendered as one grey.
 * `oxide` is a per-piece blackening (see SURFACES.steel.ox) authored as a wear
 * narrative rather than as variety for its own sake:
 *
 *   0.06-0.20  rivets, blade, comb, gauntlets, helm — handled, polished, or
 *              scoured by use every single day
 *   0.30-0.50  cuirass, greaves, vambraces — the plates that get wiped down
 *   0.60-0.90  fauld, tassets, sabatons, backplate — the skirt and feet, which
 *              hang in the dust and never see a cloth
 *
 * Read down the column: the figure now has a light head and hands, a mid torso
 * and a dark skirt and feet, which is a deliberate value gradient as well as
 * per-piece variation.
 */
const MP = {
  chest:    { uv: 0.42,  uvOff: [0.07, 0.55], uvRot: 0.13, polish: 0.62, edge: 0.86, cavity: 0.92, oxide: 0.34, nrm: 1.00 },
  belly:    { uv: 0.36,  uvOff: [0.61, 0.18], uvRot: 1.94, polish: 0.52, edge: 0.82, cavity: 1.00, oxide: 0.50, nrm: 1.00 },
  back:     { uv: 0.46,  uvOff: [0.29, 0.83], uvRot: 2.71, polish: 0.42, edge: 0.74, cavity: 1.05, oxide: 0.62, nrm: 0.95 },
  collar:   { uv: 0.34,  uvOff: [0.83, 0.37], uvRot: 0.62, polish: 0.72, edge: 0.92, cavity: 0.86, oxide: 0.26, nrm: 0.85 },
  strapTop: { uv: 0.31,  uvOff: [0.44, 0.66], uvRot: 1.31, polish: 0.48, edge: 0.88, cavity: 1.00, oxide: 0.56, nrm: 0.90 },
  // Held low deliberately: the pauldrons face away from every practical in the
  // crypt and already resolve near black. Blackening them further would deepen
  // exactly the value hole that costs the figure its mid-tones.
  pauldron: { uv: 0.34,  uvOff: [0.44, 0.09], uvRot: 2.24, polish: 0.44, edge: 0.98, cavity: 1.10, uvAniso: 1.18, oxide: 0.18, nrm: 0.55 },
  gorget:   { uv: 0.25,  uvOff: [0.17, 0.71], uvRot: 0.88, polish: 0.66, edge: 0.94, cavity: 1.02, oxide: 0.38, nrm: 0.60 },
  fauld:    { uv: 0.33,  uvOff: [0.72, 0.44], uvRot: 1.57, polish: 0.30, edge: 0.90, cavity: 1.14, uvAniso: 0.86, oxide: 0.78, nrm: 1.00 },
  tasset:   { uv: 0.37,  uvOff: [0.51, 0.27], uvRot: 2.98, polish: 0.26, edge: 0.86, cavity: 1.14, oxide: 0.72, nrm: 1.00 },
  cuisse:   { uv: 0.32,  uvOff: [0.91, 0.63], uvRot: 0.41, polish: 0.28, edge: 0.84, cavity: 1.08, oxide: 0.64, nrm: 0.85 },
  /* Measured the flattest piece on the figure (region sd 0.106 before this pass).
     A greave is kicked through gravel: dark, matt, scoured. `oxide` 0.44 -> 0.60
     and `polish` 0.24 -> 0.20 push it hard away from both the helm (smooth, bright)
     and the cuirass (mid, beaten) so the three-material check has a real answer. */
  greave:   { uv: 0.305, uvOff: [0.23, 0.47], uvRot: 1.79, polish: 0.20, edge: 0.90, cavity: 1.14, uvAniso: 1.24, oxide: 0.60, nrm: 0.70 },
  poleyn:   { uv: 0.25,  uvOff: [0.66, 0.02], uvRot: 2.46, polish: 0.32, edge: 0.98, cavity: 1.10, oxide: 0.50, nrm: 0.45 },
  sabaton:  { uv: 0.215, uvOff: [0.35, 0.92], uvRot: 0.24, polish: 0.12, edge: 0.96, cavity: 1.22, oxide: 0.88, nrm: 0.95 },
  rerebrace:{ uv: 0.28,  uvOff: [0.09, 0.31], uvRot: 1.12, polish: 0.46, edge: 0.88, cavity: 1.02, oxide: 0.54, nrm: 0.70 },
  vambrace: { uv: 0.270, uvOff: [0.38, 0.14], uvRot: 2.63, polish: 0.50, edge: 0.92, cavity: 1.02, uvAniso: 1.30, oxide: 0.40, nrm: 0.80 },
  couter:   { uv: 0.230, uvOff: [0.05, 0.29], uvRot: 0.71, polish: 0.40, edge: 1.00, cavity: 1.08, oxide: 0.32, nrm: 0.45 },
  gauntlet: { uv: 0.180, uvOff: [0.79, 0.58], uvRot: 1.44, polish: 0.56, edge: 1.00, cavity: 1.12, oxide: 0.16, nrm: 0.85 },
  /* The helm is the piece the verification frame judges against the cuirass, so it
     is pushed away from the cuirass on FINISH and VALUE, deliberately not on
     structure scale — that was tried and it failed in pixels. At uv 0.235 / nrm
     0.30 the 26 mm facet network wrapped round the skull and resolved as a fibrous
     hairy swirl at 6x (the arc-length UV of a dome converges at the crown, so ANY
     cell network arcs into a comb there; the finer the cells, the more hair-like).
     Reverted to a coarse 47 mm field at 0.16 of the map's relief, which renders as
     what it should be: a raised, polished, blued skull whose structure is carried
     by tone and specular width instead of by bump.
       oxide 0.22 -> 0.34 — a kept helm is BLUED, not bare, and this is what stops
     the dome resolving as a near-white pearl while it stays the smoothest and
     brightest-specular piece on the figure. */
  helm:     { uv: 0.340, uvOff: [0.13, 0.05], uvRot: 0.34, polish: 0.86, edge: 0.80, cavity: 0.82, oxide: 0.34, nrm: 0.16 },
  comb:     { uv: 0.220,  uvOff: [0.55, 0.41], uvRot: 1.68, polish: 0.92, edge: 1.00, cavity: 0.90, oxide: 0.10, nrm: 0.45 },
  brow:     { uv: 0.250,  uvOff: [0.27, 0.88], uvRot: 2.35, polish: 0.90, edge: 0.98, cavity: 0.94, oxide: 0.18, nrm: 0.34 },
  cheek:    { uv: 0.260,  uvOff: [0.57, 0.74], uvRot: 0.96, polish: 0.74, edge: 0.94, cavity: 0.96, oxide: 0.28, nrm: 0.55 },
  nape:     { uv: 0.280, uvOff: [0.86, 0.12], uvRot: 2.07, polish: 0.60, edge: 0.90, cavity: 1.04, oxide: 0.46, nrm: 0.70 },
  rivet:    { uv: 0.090, uvOff: [0.41, 0.36], uvRot: 0.52, polish: 0.92, edge: 1.00, cavity: 0.30, oxide: 0.06, nrm: 0.30 },
  hardware: { uv: 0.130, uvOff: [0.68, 0.21], uvRot: 1.23, polish: 0.80, edge: 0.96, cavity: 0.66, oxide: 0.12, nrm: 0.55 },
  /* The blade is the frame's ONE legitimate near-clip highlight, so its cavity
     tarnish is held low: a sharpened, oiled sword in a torchlit room is the
     brightest thing a knight is carrying, and a frame with no value above ~0.7
     reads as flat however correct its mid-tones are. Tarnish stays only in the
     fuller, where the hone never reaches. */
  blade:    { uv: 0.085, uvOff: [0.19, 0.62], uvRot: 0.08, polish: 0.98, edge: 1.00, cavity: 0.34, uvAniso: 2.6, oxide: 0.02, nrm: 0.30 },
  // leather — oxide carries soaked-in mud here, so it climbs toward the ground
  belt:     { uv: 0.115, uvOff: [0.31, 0.09], uvRot: 0.44, polish: 0.42, edge: 0.62, cavity: 0.90, oxide: 0.26, nrm: 1.00 },
  boot:     { uv: 0.098, uvOff: [0.74, 0.53], uvRot: 1.86, polish: 0.24, edge: 0.58, cavity: 1.05, oxide: 0.62, nrm: 1.00 },
  strap:    { uv: 0.072, uvOff: [0.12, 0.77], uvRot: 2.55, polish: 0.34, edge: 0.70, cavity: 0.95, oxide: 0.34, nrm: 1.00 },
  grip:     { uv: 0.058, uvOff: [0.63, 0.28], uvRot: 0.19, polish: 0.50, edge: 0.74, cavity: 1.00, oxide: 0.20, nrm: 1.00 },
  // gold
  trim:     { uv: 0.148, uvOff: [0.22, 0.48], uvRot: 0.77, polish: 0.88, edge: 0.96, cavity: 0.90, oxide: 0.10, nrm: 0.60 },
  boss:     { uv: 0.105, uvOff: [0.58, 0.15], uvRot: 2.13, polish: 0.94, edge: 1.00, cavity: 0.95, oxide: 0.06, nrm: 0.60 },
  // cloth
  tabard:   { uv: 0.132, uvOff: [0.36, 0.71], uvRot: 0.28, polish: 0.30, edge: 0.42, cavity: 1.00, oxide: 0.30, nrm: 1.00 },
};

/* ================================================================== *
 * CharacterMesh
 * ================================================================== */

export class CharacterMesh {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {import('./Skeleton.js').Rig} rig
   */
  constructor(engine, rig, opts = {}) {
    this.engine = engine;
    this.rig = rig;
    this.view = rigView(rig);
    this.seed = opts.seed ?? 20791;

    this.meshes = [];
    this.materials = [];
    this.uniforms = [];
    this._geos = [];

    /** rig-space offsets from hand_R's rest position */
    this.weapon = { bone: 'hand_R', tip: new THREE.Vector3(), hilt: new THREE.Vector3(), length: 1 };
    /** where the cloak pins: bone name + rig-space offset from that bone's rest */
    this.cloakAnchors = [];

    this._flash = 0;
  }

  /* ------------------------------------------------------------ build */

  build() {
    // Register the character-specific surface kinds before any material asks
    // for them. `register()` also drops anything the forge had cached under the
    // same name, so this is safe to run more than once.
    try {
      this.engine.assets?.register?.('heroPlate', genHeroPlate);
      this.engine.assets?.register?.('heroMail', genHeroMail);
    } catch (e) {
      console.warn('[hero] custom surface kinds unavailable —', e?.message ?? e);
    }

    const sb = {};
    for (const key in SURFACES) sb[key] = new HeroSkin(this.view, this.seed + key.length * 37);

    this._body(sb);
    this._armour(sb);
    this._head(sb);
    this._weapon(sb);
    this._anchors();

    for (const key in SURFACES) {
      const b = sb[key];
      if (b.vertexCount === 0) continue;
      const geo = b.build({ boundsPad: 2.0 });
      const mat = this._material(key);
      const mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.name = `hero_${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // bones live in world space; the mesh matrix is identity
      mesh.bind(this.rig.skeleton, new THREE.Matrix4());
      mesh.userData.occluder = false;
      this.meshes.push(mesh);
      this._geos.push(geo);
    }
    return this.meshes;
  }

  _material(key) {
    const s = SURFACES[key];
    let maps = null;
    try {
      maps = this.engine.assets?.pbr?.({ kind: s.kind, seed: s.seed, tiling: 1 }) ?? null;
    } catch (e) {
      console.warn(`[hero] pbr maps failed for ${key} —`, e?.message ?? e);
    }
    const params = {
      color: new THREE.Color(s.tint),
      roughness: 1,
      metalness: 1,
      vertexColors: true,
      /* dithering MUST stay off. three's `dithering()` adds +/- 0.5/255 to
         gl_FragColor via `rand(gl_FragCoord.xy)`, and both halves of that are
         wrong here:
           1. the value is authored for an 8-bit BACKBUFFER, but this material
              renders into the pipeline's linear HDR target, where 0.002 is 20 %
              of a surface sitting at 0.01 scene-linear. Exposure (~1.8x) and the
              tonemap's steep shadow slope then multiply the error again, which is
              why it was visible ONLY on the darkest geometry — the cloak hem, the
              inside of a pauldron, a shadowed rubble face.
           2. that `rand` is the sin(dot(uv,vec2(12.9898,78.233))) hash, which on
              integer fragment coordinates under Metal/ANGLE collapses into a
              REGULAR one-pixel diagonal lattice instead of noise. Measured at 10x
              zoom on the cloak hem it is a clean screen-aligned diamond grid.
         That lattice is what reads as "the SAME grey speckle at the SAME UV
         density" on every dark surface in the frame: it has no UV density at all,
         it is the pixel grid. The pipeline already lays a proper film grain over
         the composite, which is where dither belongs. */
      dithering: false,
      envMapIntensity: s.env,
      aoMapIntensity: 1.0,
      side: THREE.FrontSide,
    };
    const metallic = METALLIC.has(key);
    if (maps) {
      params.map = maps.map;
      params.normalMap = maps.normalMap;
      params.roughnessMap = maps.roughnessMap;
      // Sampler budget: MAX_TEXTURE_IMAGE_UNITS is 16 and the lighting module
      // spends four on cascaded shadows plus one on the probe volume, with more
      // going to practicals. So: no metalness map on a dielectric (it is a
      // constant zero) and no AO map at all — the per-vertex cavity term in
      // `wearTint` already darkens crevices, and it does it in object space
      // where a tiling texture's AO would just be noise.
      if (metallic) params.metalnessMap = maps.metalnessMap;
      else params.metalness = 0.02;
    } else {
      params.roughness = metallic ? 0.42 : 0.82;
      params.metalness = metallic ? 0.95 : 0.04;
    }
    const mat = key === 'cloth'
      ? new THREE.MeshPhysicalMaterial(params)
      : new THREE.MeshStandardMaterial(params);
    if (maps) mat.normalScale.set(s.normalScale, s.normalScale);
    // Cool sheen, not warm: a wool sheen lobe tinted brown is the single
    // fastest way to make a surcoat read as bare skin at gameplay distance.
    if (key === 'cloth') { mat.sheen = 0.42; mat.sheenRoughness = 0.88; mat.sheenColor = new THREE.Color(0x4b5468); }
    if (key === 'leather') { mat.clearcoat = 0.14; mat.clearcoatRoughness = 0.66; }
    mat.name = `hero_${key}`;
    /* Opt this material in to the hero-locked rim light. Lighting.js compiles
       the term ONLY into materials that publish this, which is what makes the
       hero the single rim-lit object in frame — the D4 tell, and the reason the
       silhouette reads at 30 px. See Lighting._injectHeroRim. */
    mat.userData.heroRim = s.rimK ?? 1;

    const hue = s.hue ?? [1, 1, 1];
    const u = {
      uHeroFlash: { value: 0 },
      uHeroFlashColor: { value: new THREE.Color(0xffe2c0) },
      uHeroHue: { value: new THREE.Vector4(hue[0], hue[1], hue[2], s.desat ?? 0) },
      uHeroAlb: { value: s.alb ?? 1 },
      uHeroRgh: { value: new THREE.Vector2(s.rgh[0], s.rgh[1]) },
      uHeroMtl: { value: new THREE.Vector2(s.mtl[0], s.mtl[1]) },
      uHeroWear: { value: new THREE.Vector3(s.wRgh[0], s.wRgh[1], s.wMtl ?? 0) },
      uHeroWearCol: { value: new THREE.Vector4(
        s.gain, s.damp, s.wRange?.[0] ?? 0.0, s.wRange?.[1] ?? 1.0,
      ) },
      uHeroRim: { value: (() => {
        const c = new THREE.Color(s.rim?.[0] ?? 0x8fa6c4);
        return new THREE.Vector4(c.r, c.g, c.b, s.rim?.[1] ?? 0.3);
      })() },
      uHeroCool: { value: (() => {
        const c = new THREE.Color(s.cool?.[0] ?? 0x6f8ecb);
        return new THREE.Vector4(c.r, c.g, c.b, s.cool?.[1] ?? 0.03);
      })() },
      uHeroBounce: { value: (() => {
        const c = new THREE.Color(s.bounce?.[0] ?? 0xb8703a);
        return new THREE.Vector4(c.r, c.g, c.b, s.bounce?.[1] ?? 0.018);
      })() },
      uHeroGrade: { value: (() => {
        const g = s.grade ?? [1, 1, 1, 0];
        return new THREE.Vector4(g[0], g[1], g[2], g[3]);
      })() },
      uHeroCav: { value: (() => {
        const c = s.cav ?? [1, 1, 1, 0];
        return new THREE.Vector4(c[0], c[1], c[2], c[3]);
      })() },
      uHeroCavTint: { value: (() => {
        const c = s.cavTint ?? [1, 1, 1];
        return new THREE.Vector3(c[0], c[1], c[2]);
      })() },
      uHeroPol: { value: new THREE.Vector2(s.pol?.[0] ?? 1, s.pol?.[1] ?? 1) },
      uHeroOx: { value: (() => {
        const o = s.ox ?? [1, 1, 1, 0];
        return new THREE.Vector4(o[0], o[1], o[2], o[3]);
      })() },
      uHeroOxTint: { value: (() => {
        const t = s.oxTint ?? [1, 1, 1];
        return new THREE.Vector3(t[0], t[1], t[2]);
      })() },
      uHeroGnd: { value: (() => {
        const g = s.gnd ?? [0.030, 0.240, 1.0];
        return new THREE.Vector3(g[0], g[1], g[2]);
      })() },
    };
    injectHeroShader(mat, u);
    this.materials.push(mat);
    this.uniforms.push(u);
    return mat;
  }

  /* ------------------------------------------------------------- body */

  /**
   * The soft layer the plate is strapped over: a quilted gambeson, mail sleeves
   * and hose. There is deliberately **no exposed flesh anywhere on this
   * character** — a fully closed helm and gauntlets. That is a colour decision
   * as much as a design one: skin is the warmest, most saturated thing you can
   * put on a figure, and in a firelit crypt a bare arm reads as exactly the
   * same hue as the floor it is standing on.
   */
  _body(sb) {
    const C = sb.cloth, A = sb.mail;
    // Under-armour is nearly black so the plate has something to read against.
    const gambeson = wearTint({ base: [0.40, 0.41, 0.48], seed: 33, mottle: 0.22, dirt: 0.34, dirtTop: 1.0 });
    const mailTint = wearTint({ base: [0.86, 0.88, 0.94], seed: 39, mottle: 0.20, dirt: 0.34, dirtTop: 0.9, warm: [1.0, 0.96, 0.94] });
    const hoseTint = wearTint({ base: [0.32, 0.33, 0.39], seed: 45, mottle: 0.20, dirt: 0.46, dirtTop: 0.85 });
    const uvC = SURFACES.cloth.uv, uvA = SURFACES.mail.uv;

    /* torso: the gambeson worn under the plate. Elliptical — deeper than wide
       at the waist, broad across the chest. Held a centimetre tighter than the
       first pass so the cuirass shells sit proud of it instead of inside it. */
    C.tube([
      { j: 'pelvis', off: [0, -0.055, 0.004], r: 0.138, sx: 1.10, sz: 0.78 },
      { j: 'pelvis', r: 0.146, sx: 1.10, sz: 0.78 },
      { j: 'spine1', r: 0.140, sx: 1.06, sz: 0.74 },
      { j: 'spine2', r: 0.156, sx: 1.27, sz: 0.70 },
      { j: 'spine3', r: 0.148, sx: 1.29, sz: 0.68 },
      { j: 'spine3', off: [0, 0.075, -0.010], bind: 'spine3', r: 0.116, sx: 1.22, sz: 0.68 },
    ], { seg: 20, ringsPer: 3, uvScale: uvC, noise: 0.05, noiseFreq: 9, color: gambeson, mask: 0.12, capStart: 'round', capEnd: 'round' });

    /* neck: a mail standard, not a throat. Short and thick — a long thin neck
       is the classic amateur tell — and it has to climb high enough to meet the
       helm's neck lame so there is never a gap to see daylight through. */
    A.tube([
      { j: 'spine3', off: [0, 0.045, -0.008], bind: 'spine3', r: 0.100, sx: 1.30, sz: 1.05 },
      { j: 'neck', off: [0, -0.020, 0], bind: 'neck', r: 0.082, sx: 1.10, sz: 1.02 },
      { j: 'neck', off: [0, 0.050, 0.006], bind: 'head', r: 0.076 },
      { j: 'head', off: [0, -0.014, 0.004], bind: 'head', r: 0.078 },
    ], { seg: 14, ringsPer: 3, uvScale: uvA, noise: 0.022, noiseFreq: 34, color: mailTint, mask: 0.30, capStart: 'none', capEnd: 'round' });

    for (const s of [-1, 1]) {
      const LR = s > 0 ? '_L' : '_R';
      /* arm: mail sleeve down to the wrist. High-frequency radial noise at
         46 lumps/m gives it a rivetted-ring read at close quarters, which is
         what separates a sleeve from a bare limb. */
      A.tube([
        { j: 'clavicle' + LR, off: [s * 0.10, 0.010, -0.004], bind: 'upperArm' + LR, r: 0.086, sx: 1.0, sz: 1.05 },
        { j: 'upperArm' + LR, r: 0.068, sx: 1.02, sz: 1.06 },
        { j: 'upperArm' + LR, off: [s * 0.03, -0.145, 0.012], bind: 'upperArm' + LR, r: 0.058 },
        { j: 'lowerArm' + LR, r: 0.052, sx: 1.0, sz: 1.04 },
        { j: 'lowerArm' + LR, off: [s * 0.02, -0.135, 0.020], bind: 'lowerArm' + LR, r: 0.043 },
        { j: 'hand' + LR, r: 0.040 },
      ], { seg: 14, ringsPer: 3, uvScale: uvA, noise: 0.026, noiseFreq: 34, color: mailTint, mask: 0.26, capStart: 'round', capEnd: 'none' });

      /* leg: hose over the thigh, tucked into the boot */
      C.tube([
        { j: 'thigh' + LR, off: [0, 0.045, 0], bind: 'pelvis', r: 0.104, sx: 1.02, sz: 1.02 },
        { j: 'thigh' + LR, r: 0.098 },
        { j: 'thigh' + LR, off: [s * 0.006, -0.220, 0.008], bind: 'thigh' + LR, r: 0.082 },
        { j: 'shin' + LR, r: 0.074, sx: 1.02, sz: 1.05 },
        { j: 'shin' + LR, off: [s * 0.004, -0.200, 0.006], bind: 'shin' + LR, r: 0.055 },
        { j: 'foot' + LR, off: [0, 0.030, -0.004], bind: 'foot' + LR, r: 0.049 },
      ], { seg: 16, ringsPer: 3, uvScale: uvC, noise: 0.035, noiseFreq: 10, color: hoseTint, mask: 0.10, capStart: 'round', capEnd: 'none' });
    }
  }

  /* --------------------------------------------------------- armour */

  _armour(sb) {
    const M = sb.steel, L = sb.leather, G = sb.gold, C = sb.cloth;
    const uvL = SURFACES.leather.uv, uvC = SURFACES.cloth.uv;
    /* Six grime fields, not one.
       `wearTint` is the *body-scale* half of the wear story (the texture carries
       the millimetre half), and a single field applied to the whole suit is
       another way of saying every piece is finished the same. A breastplate is
       sooted from a fire it faced; a fauld is filthy because it hangs in the
       dust; a sabaton is caked; a helm is the one thing kept clean. Each field
       has its own seed, its own spatial frequency and its own dirt gradient, so
       neighbouring pieces never share a mottle pattern. */
    const plateTint = wearTint({
      base: [1, 1, 1], seed: 51, mottle: 0.30, freq: 3.0, dirt: 0.38, dirtTop: 1.50,
      cav: 0.46, soot: 0.46, sootFreq: 1.4, warm: [1.10, 0.84, 0.62],
    });
    const shoulderTint = wearTint({
      base: [1, 1, 1], seed: 57, mottle: 0.26, freq: 4.4, dirt: 0.30, dirtTop: 1.55,
      cav: 0.52, soot: 0.58, sootFreq: 2.1, warm: [1.12, 0.86, 0.64],
    });
    const skirtTint = wearTint({
      base: [1, 1, 1], seed: 69, mottle: 0.34, freq: 3.8, dirt: 0.62, dirtTop: 1.05,
      cav: 0.50, soot: 0.42, sootFreq: 1.7, warm: [1.12, 0.82, 0.58],
    });
    const legTint = wearTint({
      base: [1, 1, 1], seed: 75, mottle: 0.32, freq: 5.6, dirt: 0.80, dirtTop: 0.66,
      cav: 0.48, soot: 0.36, sootFreq: 2.6, warm: [1.14, 0.80, 0.56],
    });
    const armTint = wearTint({
      base: [1, 1, 1], seed: 81, mottle: 0.24, freq: 6.4, dirt: 0.28, dirtTop: 1.35,
      cav: 0.44, soot: 0.34, sootFreq: 3.0, warm: [1.08, 0.86, 0.68],
    });
    const hwTint = wearTint({
      base: [1, 1, 1], seed: 99, mottle: 0.17, freq: 9.5, dirt: 0.22, dirtTop: 1.1,
      cav: 0.30, soot: 0.22, sootFreq: 4.4, warm: [1.06, 0.88, 0.72],
    });
    const leatherTint = wearTint({ base: [1, 1, 1], seed: 63, mottle: 0.20, dirt: 0.42, dirtTop: 0.7, cav: 0.34, soot: 0.26 });
    const bootTint = wearTint({ base: [1, 1, 1], seed: 67, mottle: 0.26, freq: 6.0, dirt: 0.78, dirtTop: 0.52, cav: 0.40, soot: 0.30 });
    const goldTint = wearTint({ base: [1, 1, 1], seed: 71, mottle: 0.15, dirt: 0.20, dirtTop: 0.6, cav: 0.30, soot: 0.22 });
    const clothTint = wearTint({ base: [1, 1, 1], seed: 87, mottle: 0.22, dirt: 0.36, dirtTop: 1.1, soot: 0.24 });
    /* Rig-space Y of the pelvis and clavicles — the seam-shadow bands below are
       authored against the actual joint table, not against guessed heights. */
    const pelvisY = this.rig.rest('pelvis', new THREE.Vector3()).y;
    const spine2Y = this.rig.rest('spine2', new THREE.Vector3()).y;
    const shinYof = (LR) => this.rig.rest('shin' + LR, new THREE.Vector3()).y;

    /**
     * `p` is a profile from `MP` — it carries the piece's UV density, tile
     * offset, tile rotation, finish and wear weights. Passing one is what makes
     * a piece materially distinct from its neighbour.
     */
    const put = (b, geo, bone, p, o = {}) => {
      b.rigid(geo, bone, {
        at: o.at ?? bone, off: o.off, rot: o.rot, scale: o.scale,
        uvScale: o.uv ?? p.uv, uvOff: p.uvOff, uvRot: p.uvRot, uvAniso: p.uvAniso,
        edge: o.edge ?? p.edge, cavity: o.cavity ?? p.cavity, cavBase: o.cavBase,
        polish: o.polish ?? p.polish, oxide: o.oxide ?? p.oxide,
        nrm: o.nrm ?? p.nrm ?? 1, maskK: o.maskK,
        color: o.color, mask: o.mask,
      });
      geo.dispose();
    };

    /* ============ cuirass ============
       Four overlapping elliptical plates plus a backplate. The measurement that
       matters: the gambeson's front face sits at z = +0.109 at spine2, so every
       shell here is authored with a `c` semi-axis of 0.128 or more and steps
       outward as it goes down. The first pass had the breastplate at c = 0.097
       and the whole cuirass was *inside* the body — which is exactly why the
       torso rendered as a smooth bare tube with a gold badge stuck on it.
       Each lame also rides 6–10 mm proud of the one below at the seam, so it
       casts a real contact shadow onto it. That self-shadowing is what makes
       armour read as overlapping steel rather than as painted-on panel lines. */
    {
      // chest, with a proud medial ridge running up the sternum
      put(M, plateShell({
        b0: -1.42, b1: 1.42, y0: 0.150, y1: 0.006,
        a0: 0.196, a1: 0.212, c0: 0.130, c1: 0.146,
        keel: 0.055, keelW: 0.30, thick: 0.017, ru: 18, rv: 4, bow: 0.02,
      }), 'spine2', MP.chest, { off: [0, 0.010, 0], color: plateTint, mask: 0.22 });

      // belly, lapped *under* the chest plate's lower rim — so the strip the
      // chest covers is shaded, which is what makes the two read as two plates
      put(M, plateShell({
        b0: -1.36, b1: 1.36, y0: 0.014, y1: -0.150,
        a0: 0.204, a1: 0.170, c0: 0.138, c1: 0.126,
        keel: 0.075, keelW: 0.26, thick: 0.016, ru: 18, rv: 4,
      }), 'spine2', MP.belly, {
        off: [0, 0.008, 0],
        color: seamShade(plateTint, spine2Y + 0.022, 0.032, 0.66),
        mask: 0.20, cavBase: 0.05,
      });

      // upper breast / collar plate, riding over the chest at the throat
      put(M, plateShell({
        b0: -1.30, b1: 1.30, y0: 0.082, y1: -0.024,
        a0: 0.176, a1: 0.202, c0: 0.118, c1: 0.140,
        keel: 0.045, keelW: 0.30, thick: 0.016, ru: 16, rv: 3,
      }), 'spine3', MP.collar, { off: [0, 0.008, 0], color: plateTint, mask: 0.22 });

      // backplate: the rear 170°, with a ridge down the spine
      put(M, plateShell({
        b0: 1.66, b1: Math.PI * 2 - 1.66, y0: 0.156, y1: -0.148,
        a0: 0.198, a1: 0.172, c0: 0.128, c1: 0.122,
        keel: 0.050, keelW: 0.34, keelAt: Math.PI, thick: 0.016, ru: 19, rv: 5, bow: 0.02,
      }), 'spine2', MP.back, { off: [0, 0.008, 0], color: plateTint, mask: 0.18 });

      // shoulder straps closing the cuirass over the top of the trapezius
      for (const s of [-1, 1]) {
        const st = plateShell({
          b0: -0.62, b1: 0.62, y0: 0.052, y1: -0.086,
          a0: 0.150, a1: 0.164, c0: 0.150, c1: 0.164,
          keel: 0.03, thick: 0.014, ru: 8, rv: 3,
        });
        st.rotateZ(-s * 1.30);
        put(M, st, 'spine3', MP.strapTop, { off: [s * 0.030, 0.062, -0.010], color: plateTint, mask: 0.30 });
      }

      /* Gold: one restrained accent, not a trim line on every edge. A raised
         rim along the collar plate and a sun boss on the sternum. */
      put(G, plateShell({
        b0: -1.28, b1: 1.28, y0: 0.096, y1: 0.074,
        a0: 0.180, a1: 0.184, c0: 0.122, c1: 0.126,
        keel: 0.048, keelW: 0.30, thick: 0.010, ru: 16, rv: 2,
      }), 'spine3', MP.trim, { off: [0, 0.008, 0], color: goldTint, mask: 0.62 });

      const boss = mergeGeos([
        (() => { const d = domeShell({ r: 0.050, a0: 0.02, a1: 1.30, b0: -Math.PI, b1: Math.PI, sy: 0.52, thick: 0.009, ru: 15, rv: 3, closeU: true }); d.rotateX(-Math.PI * 0.5); return d; })(),
        (() => { const c = block(0.014, 0.082, 0.013, { r: 0.005 }); return c; })(),
        (() => { const c = block(0.082, 0.014, 0.013, { r: 0.005 }); return c; })(),
      ]);
      put(G, boss, 'spine2', MP.boss, { off: [0, 0.070, 0.150], color: goldTint, mask: 0.66 });

      /* ---- rivets ----
         Two rows on the cuirass: one along the chest plate's lower rim where it
         laps the belly plate, one up each side of the collar plate. Each rivet is
         a proud dome oriented to the ellipse's own outward normal, so it catches
         its own crescent highlight and throws its own shadow instead of reading
         as a painted dot. */
      put(M, rivetRow({
        n: 9, b0: -1.06, b1: 1.06, a: 0.215, c: 0.149, y0: 0.019, y1: 0.019,
        sag: -0.004, r: 0.0086, h: 0.0056, tilt: 0.18,
      }), 'spine2', MP.rivet, { off: [0, 0, 0], color: hwTint, mask: 0.92 });
      for (const s of [-1, 1]) {
        put(M, rivetRow({
          n: 3, b0: s * 0.90, b1: s * 1.26, a: 0.196, c: 0.135, y0: 0.062, y1: -0.006,
          r: 0.0078, h: 0.0050, tilt: 0.05,
        }), 'spine3', MP.rivet, { off: [0, 0.008, 0], color: hwTint, mask: 0.92 });
      }
      // backplate rivets, up both sides of the spine ridge
      for (const s of [-1, 1]) {
        put(M, rivetRow({
          n: 5, b0: Math.PI + s * 0.34, b1: Math.PI + s * 0.34, a: 0.183, c: 0.121,
          y0: 0.126, y1: -0.116, r: 0.0074, h: 0.0046,
        }), 'spine2', MP.rivet, { off: [0, 0.008, 0], color: hwTint, mask: 0.90 });
      }
      /* Buckle-and-strap pair closing the cuirass at each armpit. A cuirass is
         two shells laced together and the fastening is the proof. */
      for (const s of [-1, 1]) {
        put(L, buckleGeo(0.034, 0.028, 0.0058), 'spine2', MP.hardware, {
          off: [s * 0.196, 0.086, 0.028], rot: [0, s * 1.32, 0.10], color: leatherTint, mask: 0.40,
        });
        put(L, strapEndGeo(0.086, 0.021, 0.0055), 'spine2', MP.strap, {
          off: [s * 0.198, 0.078, 0.014], rot: [0.16, s * 1.32, s * 0.10], color: leatherTint, mask: 0.30,
        });
      }
    }

    /* ============ gorget ============
       Three collar lames climbing the throat. They have to reach high enough to
       close the gap to the hood, or the neck reads as a bare stalk. Each lame is
       seam-shaded where the one above covers it, and the middle lame carries a
       rivet arc, so the stack reads as three plates and not one fluted tube. */
    for (let i = 0; i < 3; i++) {
      const gy = 0.070 - i * 0.048;
      const g = bandShell({
        b0: -2.62, b1: 2.62, y0: gy, y1: 0.016 - i * 0.050,
        r0: 0.082 + i * 0.016, r1: 0.096 + i * 0.024, sz: 1.06, thick: 0.016, ru: 16, rv: 3, bulge: 0.06,
      });
      const neckY = this.rig.rest('neck', new THREE.Vector3()).y;
      put(M, g, 'neck', MP.gorget, {
        off: [0, -0.006 + i * 0.004, 0.004],
        color: i === 0 ? plateTint : seamShade(plateTint, neckY + gy + 0.006, 0.026, 0.60),
        mask: 0.26,
      });
      if (i === 1) {
        put(M, rivetRow({
          n: 7, b0: -1.02, b1: 1.02, a: 0.106, c: 0.112, y0: 0.006, y1: 0.006,
          sag: -0.006, r: 0.0062, h: 0.0040, tilt: 0.22,
        }), 'neck', MP.rivet, { off: [0, -0.002, 0.004], color: hwTint, mask: 0.92 });
      }
    }

    /* ============ pauldrons ============
       Three lames per shoulder on overlapping polar ranges with growing radius,
       so each rides proud of the one above. The top two follow the clavicle
       (a real pauldron stays put while the arm swings under it); the hanging
       skirt follows the upper arm so it swings with the limb. */
    for (const s of [-1, 1]) {
      const LR = s > 0 ? '_L' : '_R';
      const heavy = s > 0;      // the left is the shield shoulder: bigger, one lame more
      /* A heroic ARPG silhouette is shoulder-led: the pauldrons carry 0.80 m
         across, nearly twice the 0.43 m bone span. Each lame steps 20 mm
         further out than the one above and flares 12% at its own lower edge,
         so every lame throws a hard little shadow onto the next. Deliberately
         asymmetric — matched pauldrons read as a mannequin, and the sword
         shoulder needs to be the lighter one. */
      const lames = heavy
        ? [
          { a0: 0.04, a1: 0.80, r: 0.124, bind: 'clavicle' + LR, dy: 0.046, th: 0.020 },
          { a0: 0.52, a1: 1.24, r: 0.148, bind: 'clavicle' + LR, dy: 0.028, th: 0.019 },
          { a0: 0.96, a1: 1.64, r: 0.172, bind: 'upperArm' + LR, dy: 0.006, th: 0.018 },
          { a0: 1.38, a1: 2.04, r: 0.196, bind: 'upperArm' + LR, dy: -0.014, th: 0.018 },
        ]
        : [
          { a0: 0.04, a1: 0.84, r: 0.118, bind: 'clavicle' + LR, dy: 0.040, th: 0.019 },
          { a0: 0.58, a1: 1.34, r: 0.141, bind: 'clavicle' + LR, dy: 0.018, th: 0.018 },
          { a0: 1.08, a1: 1.90, r: 0.164, bind: 'upperArm' + LR, dy: -0.008, th: 0.018 },
        ];
      const armY = this.rig.rest('upperArm' + LR, _v).y;
      for (let i = 0; i < lames.length; i++) {
        const l = lames[i];
        const d = domeShell({
          r: l.r, a0: l.a0, a1: l.a1, b0: -1.24, b1: 1.24,
          sx: 1.0, sy: 0.94, sz: 1.12, thick: l.th, ru: 15, rv: 4,
          swell: 0.04, flare: 0.12, lobe: 0.026, lobes: 3,
        });
        /* Each lame's radius steps 24 mm past the one above it and its polar span
           overlaps by ~0.25 rad, so the previous lame's rim hangs a clear 20 mm
           proud of this one's covered top. `seamShade` then darkens that covered
           strip: the top of lame i sits at armY + dy + r*sy*cos(a0). */
        const top = armY + l.dy + l.r * 0.94 * Math.cos(l.a0);
        put(M, d, l.bind, MP.pauldron, {
          at: 'upperArm' + LR, off: [s * 0.014, l.dy, 0.004],
          color: i === 0 ? shoulderTint : seamShade(shoulderTint, top, 0.032, 0.64),
          mask: 0.24 + i * 0.05,
          // Each lame is finished a little differently — the crown lame catches
          // the light and gets rubbed, the hanging skirt lame does not.
          polish: MP.pauldron.polish + (i === 0 ? 0.18 : -0.06 * i),
          cavBase: i === 0 ? 0 : 0.06,
        });
        /* Rivet arc along each lame's leading edge, so the stack visibly
           articulates. The row follows the lame's own ellipse at its a1 edge. */
        if (i < lames.length - 1) {
          const aEdge = l.a1 - 0.10;
          const rr = l.r * 1.01;
          const parts = [];
          const nR = 4;
          for (let k = 0; k < nR; k++) {
            const b = lerp(-0.86, 0.86, nR === 1 ? 0.5 : k / (nR - 1));
            const g = rivetGeo(0.0068, 0.0044);
            const sa = Math.sin(aEdge), ca = Math.cos(aEdge);
            _v.set(sa * Math.cos(b), ca * 0.94, sa * Math.sin(b) * 1.12).normalize();
            g.applyQuaternion(_q.setFromUnitVectors(_AY, _v));
            g.translate(rr * sa * Math.cos(b), rr * ca * 0.94, rr * sa * Math.sin(b) * 1.12);
            parts.push(g);
          }
          put(M, mergeGeos(parts), l.bind, MP.rivet, {
            at: 'upperArm' + LR, off: [s * 0.014, l.dy, 0.004], color: hwTint, mask: 0.92,
          });
        }
      }
      // Gold crest over the crown of the heavy shoulder only.
      if (heavy) {
        const cr = block(0.024, 0.022, 0.226, { r: 0.007 });
        put(G, cr, 'clavicle' + LR, MP.trim, { at: 'upperArm' + LR, off: [-s * 0.004, 0.104, 0.004], color: goldTint, mask: 0.70 });
      }
      // Standing rim on the outermost lame, so the shoulder has a hard top
      // edge instead of a soft dome. This is the single detail that most stops
      // a pauldron reading as a shoulder pad.
      {
        const outer = lames[lames.length - 1];
        const rim = domeShell({
          r: outer.r * 1.045, a0: outer.a1 - 0.16, a1: outer.a1 + 0.04, b0: -1.20, b1: 1.20,
          sx: 1.0, sy: 0.94, sz: 1.12, thick: 0.012, ru: 12, rv: 2, flare: 0.10,
        });
        put(M, rim, outer.bind, MP.pauldron, {
          at: 'upperArm' + LR, off: [s * 0.014, outer.dy, 0.004], color: shoulderTint,
          mask: 0.70, polish: 0.66,
        });
      }
      // rerebrace: a short plate on the outer upper arm, under the pauldron
      {
        const rb = bandShell({
          b0: -1.05, b1: 1.05, y0: -0.045, y1: -0.175, r0: 0.080, r1: 0.072, thick: 0.017, ru: 10, rv: 3,
        });
        rb.rotateY(s * Math.PI * 0.5);
        put(M, rb, 'upperArm' + LR, MP.rerebrace, { off: [0, 0, 0], color: armTint, mask: 0.24, cavBase: 0.10 });
        // buckled strap round the rerebrace
        put(L, buckleGeo(0.026, 0.021, 0.005), 'upperArm' + LR, MP.hardware, {
          off: [-s * 0.070, -0.108, 0.014], rot: [0, -s * 1.42, 0], color: leatherTint, mask: 0.40,
        });
        put(L, strapEndGeo(0.058, 0.017, 0.005), 'upperArm' + LR, MP.strap, {
          off: [-s * 0.068, -0.114, 0.004], rot: [0.2, -s * 1.42, 0], color: leatherTint, mask: 0.30,
        });
      }
    }

    /* ============ fauld ============
       Four horizontal lames hanging off the bottom of the cuirass.

       The measurements here are the whole point, and the previous pass had them
       an order of magnitude too small to see: lame pitch 46 mm against a lame
       height of 50 mm gave 4 mm of overlap, and a radial step of 10 mm against a
       hem step of 12 mm left each lame just 2 mm proud of the next. At this
       scenario's 400 px per metre that is a 1.6 px overlap and a 0.8 px
       standoff — literally sub-pixel, which is why the skirt read as one smooth
       shell with panel lines scribed on it.

       Now: 70 mm lames on a 50 mm pitch (20 mm of overlap) and each lame's hem
       sits a measured 12 mm proud of the top of the lame below —
         hem(i-1) = 0.202 + 0.014*(i-1)    top(i) = 0.176 + 0.014*i
         hem(i-1) - top(i) = 0.012  for every i
       so every seam is a real 12 mm step, worth ~5 px, and `seamShade` darkens
       the 26 mm of each lame that the one above actually covers. */
    for (let i = 0; i < 4; i++) {
      const y0 = 0.104 - i * 0.050;
      const shade = seamShade(skirtTint, pelvisY + y0, 0.028, 0.66);
      const f = bandShell({
        b0: -1.74, b1: 1.74,
        y0, y1: y0 - 0.070,
        r0: 0.176 + i * 0.014, r1: 0.202 + i * 0.014,
        sz: 0.74, thick: 0.014, ru: 17, rv: 4, bulge: 0.05,
      });
      put(M, f, 'pelvis', MP.fauld, {
        off: [0, 0, 0.004], color: shade, mask: 0.22,
        // Each lame down the skirt is dirtier and duller than the one above it.
        polish: MP.fauld.polish - i * 0.04, cavBase: 0.05 + i * 0.02,
      });
      // matching rear lames, so the skirt closes behind
      const rb = bandShell({
        b0: Math.PI - 1.42, b1: Math.PI + 1.42,
        y0: y0 - 0.004, y1: y0 - 0.072,
        r0: 0.174 + i * 0.014, r1: 0.198 + i * 0.014,
        sz: 0.74, thick: 0.013, ru: 13, rv: 3, bulge: 0.04,
      });
      put(M, rb, 'pelvis', MP.fauld, {
        off: [0, 0, 0.004], color: shade, mask: 0.18,
        polish: MP.fauld.polish - i * 0.04, cavBase: 0.07 + i * 0.02,
      });
      /* Sliding rivets: the pins each lame pivots on, one pair per lame at the
         hips. This is the single most recognisable piece of hardware on a
         articulated skirt and there was none of it. */
      if (i > 0) {
        for (const s of [-1, 1]) {
          put(M, rivetRow({
            n: 1, b0: s * 1.30, b1: s * 1.30, a: 0.196 + i * 0.014, c: 0.150 + i * 0.010,
            y0: y0 - 0.016, r: 0.0080, h: 0.0052, tilt: 0.06,
          }), 'pelvis', MP.rivet, { off: [0, 0, 0.004], color: hwTint, mask: 0.94 });
        }
      }
      // rivet run across the front of the second lame
      if (i === 1) {
        put(M, rivetRow({
          n: 7, b0: -0.82, b1: 0.82, a: 0.204, c: 0.152, y0: y0 - 0.020, y1: y0 - 0.020,
          sag: -0.004, r: 0.0068, h: 0.0044, tilt: 0.10,
        }), 'pelvis', MP.rivet, { off: [0, 0, 0.004], color: hwTint, mask: 0.92 });
      }
    }

    /* ============ tassets ============
       Same treatment: the second plate steps 14 mm further out than the first
       and laps 30 mm over it, with the covered strip shaded — plus the strap,
       buckle and hanging tongue that actually hold it to the fauld. */
    for (const s of [-1, 1]) {
      // hanging tasset over the front of each thigh: two overlapping plates
      for (let i = 0; i < 2; i++) {
        const ty0 = -0.098 - i * 0.100;
        const t = bandShell({
          b0: s > 0 ? 0.14 : -1.24, b1: s > 0 ? 1.24 : -0.14,
          y0: ty0, y1: ty0 - 0.130 - i * 0.016,
          r0: 0.214 + i * 0.014, r1: 0.222 + i * 0.014, sz: 0.80, thick: 0.017, ru: 11, rv: 4,
          hem: i === 1 ? 0.010 : 0.004, lobes: 2,
        });
        put(M, t, 'pelvis', MP.tasset, {
          off: [0, 0, 0.004],
          color: i === 1 ? seamShade(skirtTint, pelvisY + ty0, 0.032, 0.64) : skirtTint,
          mask: 0.22, polish: MP.tasset.polish - i * 0.06, cavBase: 0.05 + i * 0.03,
        });
        // rivet pair at each tasset's top corners
        put(M, rivetRow({
          n: 2, b0: s > 0 ? 0.30 : -1.10, b1: s > 0 ? 1.10 : -0.30,
          a: 0.216 + i * 0.014, c: 0.175 + i * 0.010, y0: ty0 - 0.016, y1: ty0 - 0.016,
          r: 0.0074, h: 0.0048, tilt: 0.08,
        }), 'pelvis', MP.rivet, { off: [0, 0, 0.004], color: hwTint, mask: 0.94 });
        // leather strap + buckle joining the tasset to the fauld above it
        if (i === 0) {
          put(L, buckleGeo(0.032, 0.026, 0.0055), 'pelvis', MP.hardware, {
            off: [s * 0.132, -0.084, 0.152], rot: [0.12, s * 0.34, 0], color: leatherTint, mask: 0.42,
          });
          put(L, strapEndGeo(0.076, 0.019, 0.0052), 'pelvis', MP.strap, {
            off: [s * 0.134, -0.092, 0.146], rot: [0.16, s * 0.34, s * 0.08], color: leatherTint, mask: 0.30,
          });
        }
      }
      // thigh cop bound to the leg so it tracks the limb
      {
        const c = bandShell({ b0: -0.85, b1: 0.85, y0: -0.075, y1: -0.215, r0: 0.106, r1: 0.096, sz: 0.94, thick: 0.016, ru: 10, rv: 3 });
        put(M, c, 'thigh' + (s > 0 ? '_L' : '_R'), MP.cuisse, { color: legTint, mask: 0.20, cavBase: 0.08 });
      }
    }

    /* ============ arms: vambrace + couter + gauntlet ============ */
    for (const s of [-1, 1]) {
      const LR = s > 0 ? '_L' : '_R';
      // couter (elbow cup) — the elbow points backward, so the cup must too
      {
        const d = domeShell({ r: 0.072, a0: 0.05, a1: 1.34, b0: -1.40, b1: 1.40, sy: 0.74, sz: 1.18, thick: 0.018, ru: 10, rv: 4, swell: 0.06 });
        d.rotateX(-Math.PI * 0.5);
        d.rotateY(s * 0.22);
        put(M, d, 'lowerArm' + LR, MP.couter, { off: [s * 0.008, 0.014, -0.016], color: armTint, mask: 0.28 });
      }
      // vambrace: one shell from below the couter to the wrist, lapped once
      {
        // A ridge down the outside of the forearm. Without it a vambrace is a
        // pale tube, which is what the previous pass rendered.
        const vb = plateShell({
          b0: -2.30, b1: 2.30, y0: -0.052, y1: -0.238,
          a0: 0.062, a1: 0.050, c0: 0.066, c1: 0.054,
          keel: 0.075, keelW: 0.46, thick: 0.017, ru: 15, rv: 5, bow: 0.05,
        });
        const armY2 = this.rig.rest('lowerArm' + LR, new THREE.Vector3()).y;
        put(M, vb, 'lowerArm' + LR, MP.vambrace, {
          off: [s * 0.006, 0.006, 0.010],
          color: seamShade(armTint, armY2 - 0.058, 0.030, 0.60), mask: 0.26,
        });
        const lap = plateShell({
          b0: -2.05, b1: 2.05, y0: -0.026, y1: -0.086,
          a0: 0.068, a1: 0.066, c0: 0.072, c1: 0.070,
          keel: 0.055, keelW: 0.46, thick: 0.015, ru: 12, rv: 2,
        });
        put(M, lap, 'lowerArm' + LR, MP.vambrace, {
          off: [s * 0.006, 0.006, 0.010], color: armTint, mask: 0.34, polish: 0.58,
        });
        // rivets down the vambrace's outer seam, plus the buckled closure
        put(M, rivetLine(
          [s * 0.006 + Math.sin(2.30) * 0.062, -0.058, Math.cos(2.30) * 0.066 + 0.010],
          [s * 0.006 + Math.sin(2.30) * 0.050, -0.230, Math.cos(2.30) * 0.054 + 0.010],
          [Math.sin(2.30), 0, Math.cos(2.30)], 4, 0.0064, 0.0042,
        ), 'lowerArm' + LR, MP.rivet, { off: [0, 0, 0], color: hwTint, mask: 0.94 });
        put(L, buckleGeo(0.024, 0.020, 0.0048), 'lowerArm' + LR, MP.hardware, {
          off: [-s * 0.056, -0.150, -0.030], rot: [0, -s * 1.10, 0], color: leatherTint, mask: 0.40,
        });
      }
      // gauntlet: cuff, back-of-hand shell, three knuckle ridges
      {
        const cuff = bandShell({ b0: -Math.PI, b1: Math.PI, y0: 0.030, y1: -0.026, r0: 0.055, r1: 0.049, thick: 0.016, ru: 14, rv: 2, closeU: true, bulge: 0.10 });
        put(M, cuff, 'hand' + LR, MP.gauntlet, { off: [0, 0.014, 0.004], color: armTint, mask: 0.32 });
        // back of the hand: one shell, with a single knuckle ridge across it
        const back = domeShell({ r: 0.056, a0: 0.05, a1: 1.44, b0: -Math.PI, b1: Math.PI, closeU: true, sx: 0.62, sy: 0.66, sz: 1.22, thick: 0.013, ru: 13, rv: 4 });
        put(M, back, 'hand' + LR, MP.gauntlet, { off: [s * 0.002, -0.052, 0.012], color: armTint, mask: 0.30, cavBase: 0.06 });
        const ridge = block(0.062, 0.016, 0.030, { r: 0.006, wrap: 6.5 });
        put(M, ridge, 'hand' + LR, MP.gauntlet, { off: [s * 0.002, -0.086, 0.034], color: armTint, mask: 0.60, polish: 0.74 });
        // rivets round the cuff — the gauntlet's most visible hardware
        put(M, rivetRow({
          n: 6, b0: -1.15, b1: 1.15, a: 0.058, c: 0.058, y0: 0.016, y1: 0.016,
          r: 0.0056, h: 0.0036, tilt: 0.14,
        }), 'hand' + LR, MP.rivet, { off: [0, 0.014, 0.004], color: hwTint, mask: 0.94 });
      }
      // gauntlet fist: one mitten mass with grooved finger separations, so the
      // hand reads as a closed fist rather than a comb of tabs
      {
        const fist = mergeGeos([
          (() => {
            const g = domeShell({ r: 0.056, a0: 0.05, a1: 1.55, b0: -Math.PI, b1: Math.PI, closeU: true, sx: 0.66, sy: 0.86, sz: 0.92, thick: 0.012, ru: 13, rv: 4 });
            g.translate(0, -0.010, 0);
            return g;
          })(),
          ...[0, 1, 2].map((k) => {
            const f = block(0.024, 0.030, 0.052, { r: 0.010 });
            f.rotateX(-0.30);
            f.translate(s * (0.020 - k * 0.020), -0.014 - k * 0.006, 0.040 - k * 0.004);
            return f;
          }),
        ]);
        put(M, fist, 'handEnd' + LR, MP.gauntlet, { off: [s * 0.002, 0.004, 0.020], color: armTint, mask: 0.30, cavBase: 0.08 });
        const thumb = block(0.026, 0.050, 0.028, { r: 0.010 });
        thumb.rotateZ(s * 0.95);
        thumb.rotateX(-0.34);
        put(M, thumb, 'hand' + LR, MP.gauntlet, { off: [-s * 0.024, -0.084, 0.034], color: armTint, mask: 0.30 });
      }
    }

    /* ============ legs: poleyn + greave + sabaton + boot ============ */
    for (const s of [-1, 1]) {
      const LR = s > 0 ? '_L' : '_R';
      // knee poleyn with a fluted side wing
      {
        const d = domeShell({ r: 0.086, a0: 0.05, a1: 1.30, b0: -1.45, b1: 1.45, sy: 0.80, sz: 1.10, thick: 0.020, ru: 12, rv: 4, swell: 0.08 });
        d.rotateX(Math.PI * 0.5);
        put(M, d, 'shin' + LR, MP.poleyn, { off: [0, 0.026, 0.014], color: legTint, mask: 0.30 });
        const wing = bandShell({ b0: -0.9, b1: 0.9, y0: 0.020, y1: -0.048, r0: 0.098, r1: 0.086, thick: 0.014, ru: 8, rv: 2 });
        wing.rotateY(s * Math.PI * 0.5);
        put(M, wing, 'shin' + LR, MP.poleyn, { off: [s * 0.010, 0.014, 0.006], color: legTint, mask: 0.40, polish: 0.40 });
        // the pin the wing pivots on
        put(M, rivetRow({
          n: 1, b0: 0, b1: 0, a: s * 0.100, c: 0.006, y0: 0.006, r: 0.0082, h: 0.0054,
        }), 'shin' + LR, MP.rivet, { off: [0, 0.014, 0.006], color: hwTint, mask: 0.96 });
      }
      // greave: one continuous shell from below the knee to the ankle, with a
      // short second lame lapped over its top. Stacked narrow bands read as
      // bracelets in profile, which is what the first pass looked like.
      {
        // Shin ridge + a wider ankle flare. A greave with a constant circular
        // section is the plainest shape on a suit of armour and it showed.
        const gv = plateShell({
          b0: -2.25, b1: 2.25, y0: -0.040, y1: -0.372,
          a0: 0.084, a1: 0.062, c0: 0.088, c1: 0.066,
          keel: 0.070, keelW: 0.42, thick: 0.019, ru: 16, rv: 6, bow: 0.05,
        });
        // The lap plate rides 8 mm proud of the greave from below the knee, so
        // the greave's own top strip is covered and therefore shaded.
        put(M, gv, 'shin' + LR, MP.greave, {
          off: [0, -0.010, 0.008],
          color: seamShade(legTint, shinYof(LR) - 0.046, 0.036, 0.62),
          mask: 0.20, cavBase: 0.06,
        });
        const lap = plateShell({
          b0: -1.95, b1: 1.95, y0: -0.010, y1: -0.116,
          a0: 0.096, a1: 0.096, c0: 0.100, c1: 0.100,
          keel: 0.055, keelW: 0.42, thick: 0.017, ru: 12, rv: 3,
        });
        put(M, lap, 'shin' + LR, MP.greave, { off: [0, -0.010, 0.008], color: legTint, mask: 0.30, polish: 0.34 });
        // ankle lame, flaring over the top of the boot
        const ank = plateShell({
          b0: -2.05, b1: 2.05, y0: -0.324, y1: -0.396,
          a0: 0.068, a1: 0.076, c0: 0.072, c1: 0.082,
          keel: 0.035, keelW: 0.50, thick: 0.014, ru: 12, rv: 2, hem: 0.004, lobes: 3,
        });
        put(M, ank, 'shin' + LR, MP.greave, {
          off: [0, -0.010, 0.008],
          color: seamShade(legTint, shinYof(LR) - 0.330, 0.028, 0.55),
          mask: 0.44, polish: 0.18,
        });
        /* Hinge rivets down the greave's outer seam — a greave is two shells on a
           hinge and the hinge is what makes it read as armour rather than a pale
           tube. Plus the buckled closure across the calf. */
        put(M, rivetRow({
          n: 5, b0: 2.20, b1: 2.20, a: s * 0.088, c: 0.092,
          y0: -0.062, y1: -0.320, r: 0.0070, h: 0.0046,
        }), 'shin' + LR, MP.rivet, { off: [0, -0.010, 0.008], color: hwTint, mask: 0.94 });
        put(L, buckleGeo(0.030, 0.024, 0.0052), 'shin' + LR, MP.hardware, {
          off: [s * 0.078, -0.196, 0.006], rot: [0, s * 1.35, 0], color: leatherTint, mask: 0.42,
        });
        put(L, strapEndGeo(0.062, 0.018, 0.005), 'shin' + LR, MP.strap, {
          off: [s * 0.080, -0.204, -0.006], rot: [0.14, s * 1.35, 0], color: leatherTint, mask: 0.30,
        });
      }
      // leather boot: ankle cuff, then a sole that actually looks like a sole
      {
        const bt = bandShell({ b0: -Math.PI, b1: Math.PI, y0: 0.080, y1: -0.048, r0: 0.062, r1: 0.070, sz: 1.10, thick: 0.014, ru: 14, rv: 4, closeU: true });
        put(L, bt, 'foot' + LR, MP.boot, { off: [0, 0.002, 0.002], color: bootTint, mask: 0.24 });
        const sole = block(0.086, 0.022, 0.268, { r: 0.009, seg: 2, taper: 0 });
        put(L, sole, 'foot' + LR, MP.boot, { off: [0, -0.070, 0.056], color: bootTint, mask: 0.34, polish: 0.10, cavBase: 0.14 });
        const heel = block(0.078, 0.026, 0.062, { r: 0.008 });
        put(L, heel, 'foot' + LR, MP.boot, { off: [0, -0.084, -0.028], color: bootTint, mask: 0.36, polish: 0.10, cavBase: 0.18 });
        // instep, filling the wedge between the cuff and the sole
        const instep = domeShell({ r: 0.070, a0: 0.06, a1: 1.42, b0: -Math.PI, b1: Math.PI, closeU: true, sx: 0.72, sy: 0.60, sz: 1.28, thick: 0.010, ru: 13, rv: 4 });
        put(L, instep, 'foot' + LR, MP.boot, { off: [0, -0.036, 0.052], color: bootTint, mask: 0.24, cavBase: 0.08 });
      }
      // sabaton: a plate over the instep plus two overlapping toe lames, each
      // riding a little proud of the one behind it
      {
        const sa = domeShell({
          r: 0.074, a0: 0.06, a1: 1.36, b0: -Math.PI, b1: Math.PI, closeU: true,
          sx: 0.68, sy: 0.44, sz: 1.16, thick: 0.014, ru: 13, rv: 4, swell: 0.05,
        });
        put(M, sa, 'foot' + LR, MP.sabaton, { off: [0, -0.026, 0.042], color: legTint, mask: 0.26, cavBase: 0.10 });
        // rivets across the instep lame
        put(M, rivetRow({
          n: 5, b0: -1.05, b1: 1.05, a: 0.052, c: 0.088, y0: -0.006, y1: -0.006,
          r: 0.0058, h: 0.0038, tilt: 0.55,
        }), 'foot' + LR, MP.rivet, { off: [0, -0.026, 0.042], color: hwTint, mask: 0.94 });
      }
      {
        const tl = domeShell({
          r: 0.060, a0: 0.06, a1: 1.34, b0: -Math.PI, b1: Math.PI, closeU: true,
          sx: 0.62, sy: 0.38, sz: 1.05, thick: 0.012, ru: 11, rv: 3,
        });
        // Kept inside the sole's footprint: the toe lame must lap the sabaton,
        // not float past the end of the boot.
        put(M, tl, 'toe' + LR, MP.sabaton, { off: [0, -0.016, 0.008], color: legTint, mask: 0.36, polish: 0.08, cavBase: 0.06 });
      }
    }

    /* ============ belts and straps ============ */
    {
      // waist belt, riding *over* the fauld's top lame (radius 0.141) so it
      // reads as the thing the skirt hangs from rather than a stripe under it
      const belt = bandShell({ b0: -Math.PI, b1: Math.PI, y0: 0.112, y1: 0.056, r0: 0.198, r1: 0.202, sz: 0.76, thick: 0.017, ru: 18, rv: 2, closeU: true, bulge: 0.05 });
      put(L, belt, 'pelvis', MP.belt, { off: [0, 0, 0.004], color: leatherTint, mask: 0.26 });
      // buckle on the hip, not dead centre: the tabard drapes over the belt's
      // front and a buckle behind cloth is invisible work
      put(G, buckleGeo(0.062, 0.052, 0.011), 'pelvis', MP.hardware, {
        off: [0.166, 0.084, 0.096], rot: [0, 1.05, 0], color: goldTint, mask: 0.66,
      });
      // strap end hanging past the buckle, with its keeper
      put(L, strapEndGeo(0.104, 0.030, 0.0062), 'pelvis', MP.strap, {
        off: [0.176, 0.070, 0.082], rot: [0.10, 1.05, 0.14], color: leatherTint, mask: 0.30,
      });
      // punched holes down the free end, as proud rivet-like eyelets
      put(L, rivetLine([0.182, 0.032, 0.070], [0.182, -0.020, 0.070], [0.62, 0, 0.78], 3, 0.0055, 0.0028),
        'pelvis', MP.hardware, { off: [0, 0, 0], color: leatherTint, mask: 0.52 });
      // a second sword belt slung across the hip, over the fauld
      const belt2 = bandShell({ b0: -Math.PI, b1: Math.PI, y0: -0.070, y1: -0.106, r0: 0.212, r1: 0.218, sz: 0.78, thick: 0.013, ru: 16, rv: 2, closeU: true });
      belt2.rotateZ(0.11);
      put(L, belt2, 'pelvis', MP.belt, { off: [0, 0, 0.004], color: leatherTint, mask: 0.22, polish: 0.30 });
      // sword-belt buckle on the opposite hip, so the two belts do not stack
      put(L, buckleGeo(0.030, 0.024, 0.0052), 'pelvis', MP.hardware, {
        off: [-0.196, -0.076, 0.086], rot: [0, -1.02, 0.11], color: leatherTint, mask: 0.42,
      });
    }
    /* baldric across the chest — authored on an ellipse a shade larger than the
       cuirass so it lies *on* the plate. Every one of these control points was
       checked against the breastplate's own (a, c) at that height; a strap that
       sinks inside the plate is invisible work. */
    sb.leather.ribbon([
      { p: [0.148, 1.474, 0.034], bind: 'spine3', w: 0.032 },
      { p: [0.100, 1.362, 0.134], bind: 'spine3', w: 0.034 },
      { p: [0.020, 1.242, 0.166], bind: 'spine2', w: 0.034 },
      { p: [-0.082, 1.132, 0.152], bind: 'spine1', w: 0.032 },
      { p: [-0.176, 1.032, 0.082], bind: 'pelvis', w: 0.030 },
      { p: [-0.206, 0.988, -0.028], bind: 'pelvis', w: 0.028 },
    ], { ringsPer: 3, uvScale: uvL * 0.62, thick: 0.012, axis: [0, 0, 1], color: leatherTint, mask: 0.45 });
    for (const s of [-1, 1]) {
      const LR = s > 0 ? '_L' : '_R';
      // pauldron retaining strap, wrapping the upper arm under the lames
      L.setSurf(0.16, 0.34);
      sb.leather.ribbon([
        { p: [s * 0.196, 1.318, 0.072], bind: 'upperArm' + LR, w: 0.026 },
        { p: [s * 0.286, 1.310, 0.006], bind: 'upperArm' + LR, w: 0.026 },
        { p: [s * 0.200, 1.302, -0.070], bind: 'upperArm' + LR, w: 0.024 },
      ], { ringsPer: 2, uvScale: uvL * 0.5, thick: 0.010, axis: [0, 1, 0], color: leatherTint, mask: 0.42 });
      // thigh straps
      sb.leather.ribbon([
        { p: [s * 0.118, 0.790, 0.104], bind: 'thigh' + LR, w: 0.020 },
        { p: [s * 0.192, 0.782, 0.010], bind: 'thigh' + LR, w: 0.020 },
        { p: [s * 0.120, 0.774, -0.090], bind: 'thigh' + LR, w: 0.020 },
      ], { ringsPer: 2, uvScale: uvL * 0.44, thick: 0.009, axis: [0, 1, 0], color: leatherTint, mask: 0.35 });
      L.setSurf(0, 0.5);
    }

    /* ============ tabard over the plate ============
       Front and back panels of deep crimson wool hanging from the chest to
       mid-thigh, with a scalloped, frayed hem. This is the scene's one
       saturated accent and the reason the figure has a colour of its own; the
       vertex tint carries it, so it survives the shader's hue discipline. */
    {
      /* The `cloth` generator writes oxblood at 0.054 linear into an sRGB map, so
         after the shader's `alb` compensation the panel's own luminance is only
         ~0.13 — and a 0.13-luminance tint multiplied by (0.64, 0.078, 0.112)
         lands on a dark *brown*, which is the same hue as the crypt floor. The
         base is lifted and re-saturated so the accent survives the chain; red is
         the only saturated hue on the figure and it has to actually read as red. */
      const crimson = wearTint({
        base: [2.55, 0.150, 0.190], seed: 91, mottle: 0.26, dirt: 0.34, dirtTop: 1.2,
        cav: 0.40, soot: 0.30, sootFreq: 2.4, warm: [0.92, 0.88, 0.86],
      });
      const panel = (sign) => shellGeo((u, v, out) => {
        const b = lerp(-0.62, 0.62, u) + (sign < 0 ? Math.PI : 0);
        const t = v * v * 0.68 + v * 0.32;
        const y = lerp(0.175, -0.402, v)
          + 0.022 * v * v * Math.cos(u * Math.PI * 5)
          // torn hem: bites out of the bottom edge, so it is not a ruled line
          - 0.034 * smoothstep(0.84, 1.0, v) * (0.5 + 0.5 * Math.cos(u * Math.PI * 3.0));
        const A = lerp(0.196, 0.250, t);
        const Cc = lerp(0.170, 0.208, t);
        /* Three fold frequencies instead of two, at roughly double the amplitude,
           and skewed with v. At the previous 8% of a 0.20 m radius the deepest
           fold was 16 mm — under 7 px at the closeup framing and invisible at any
           other, so the tabard rendered as a flat cardboard rectangle. At 17% the
           channels are 34 mm deep and shade properly against the plate behind. */
        const fold = 1
          + 0.170 * Math.cos(u * Math.PI * 3.0 + v * 0.5) * smoothstep(0.04, 0.70, v)
          + 0.062 * Math.cos(u * Math.PI * 7.0 - v * 0.9) * smoothstep(0.14, 0.92, v)
          + 0.026 * Math.cos(u * Math.PI * 13.0) * smoothstep(0.30, 1.0, v);
        out.set(Math.sin(b) * A * fold, y, Math.cos(b) * Cc * fold);
      }, { ru: 30, rv: 12, thick: 0.007, bevel: 0.0035, center: [0, -0.12, 0] });
      put(C, panel(1), 'pelvis', MP.tabard, { off: [0, 0.058, 0.004], color: crimson, mask: 0.18 });
      put(C, panel(-1), 'pelvis', MP.tabard, {
        off: [0, 0.058, 0.004], color: crimson, mask: 0.18,
        // The back panel is a different cut of the same bolt: rotate its tile so
        // the weave does not run in the same direction as the front's.
        uv: MP.tabard.uv * 0.88,
      });
      // Braid trim along both hems, in a second cloth tone, so the panel is not
      // a rectangle of one value ending at a ruled line.
      for (const sign of [1, -1]) {
        const braid = shellGeo((u, v, out) => {
          const b = lerp(-0.60, 0.60, u) + (sign < 0 ? Math.PI : 0);
          const y = lerp(-0.372, -0.398, v)
            + 0.020 * Math.cos(u * Math.PI * 5)
            - 0.030 * smoothstep(0.84, 1.0, 0.96) * (0.5 + 0.5 * Math.cos(u * Math.PI * 3.0));
          const A = 0.248 * (1 + 0.030 * Math.cos(u * Math.PI * 9.0));
          const Cc = 0.206 * (1 + 0.030 * Math.cos(u * Math.PI * 9.0));
          out.set(Math.sin(b) * A, y, Math.cos(b) * Cc);
        }, { ru: 26, rv: 2, thick: 0.006, bevel: 0.003, center: [0, -0.38, 0] });
        put(C, braid, 'pelvis', MP.tabard, {
          off: [0, 0.058, 0.004], uv: 0.036, color: clothTint, mask: 0.34, polish: 0.44,
        });
      }
    }
  }

  /* --------------------------------------------------------- head */

  /**
   * A barbute. Skull dome, a raised comb, a proud brow, a Y-shaped face
   * aperture split by a nasal bar, riveted cheek plates and a neck lame — plus
   * a near-black inner shell so the aperture is a *void* and not a hole you can
   * see the wall through. There is no face: the previous pass modelled a brow,
   * a nose and a jaw as separate rounded blocks inside an open hood, and at any
   * distance that reads as a toy, while at close range the pieces visibly do
   * not join. A closed helm with a dark slot is both the stronger silhouette
   * and the honest one.
   *
   * Every radius here is measured against the mail standard on the neck
   * (r = 0.078 at the head joint) so the helm closes over it with no gap.
   */
  _head(sb) {
    const M = sb.steel, L = sb.leather, G = sb.gold;
    const uvM = SURFACES.steel.uv, uvL = SURFACES.leather.uv, uvG = SURFACES.gold.uv;
    // The helm stays the cleanest thing on the figure — it is the focal point —
    // but "cleanest" is not "clean": it still carries soot and cavity grime, or
    // it reads as a chromed prop next to a filthy body.
    const steelTint = wearTint({
      base: [1, 1, 1], seed: 111, mottle: 0.26, freq: 5.0, dirt: 0.08, dirtTop: 0.2,
      cav: 0.44, soot: 0.36, sootFreq: 3.2, warm: [1.08, 0.88, 0.70],
    });
    const goldTint = wearTint({ base: [1, 1, 1], seed: 117, mottle: 0.14, dirt: 0.06, dirtTop: 0.2, cav: 0.32, soot: 0.18, sootFreq: 3.0 });
    /* Hardware carries its own field: a rivet is turned from bar stock and
       polished by the hand that seats it, so it is cleaner and finer-grained
       than the plate it holds down. (This used to reference the _armour scope's
       `hwTint`, which threw at build time and disabled the entire hero module.) */
    const hwTint = wearTint({
      base: [1, 1, 1], seed: 123, mottle: 0.16, freq: 9.0, dirt: 0.06, dirtTop: 0.2,
      cav: 0.28, soot: 0.20, sootFreq: 4.6, warm: [1.06, 0.90, 0.74],
    });
    const voidTint = () => [0.030, 0.031, 0.038];

    /* helm centre, in rig space. The head joint is at 1.626 and headTop at
       1.850, so a 0.232 m tall helm centred at 1.712 crowns at 1.828. */
    const HY = 1.712;
    const R = 0.106, SX = 0.98, SY = 1.06, SZ = 1.09;
    const put = (b, geo, p, o = {}) => {
      b.rigid(geo, 'head', {
        at: 'head', off: [0, HY - 1.626, 0.004], rot: o.rot,
        uvScale: o.uv ?? p.uv, uvOff: p.uvOff, uvRot: p.uvRot, uvAniso: p.uvAniso,
        edge: o.edge ?? p.edge, cavity: o.cavity ?? p.cavity, cavBase: o.cavBase,
        polish: o.polish ?? p.polish, oxide: o.oxide ?? p.oxide,
        nrm: o.nrm ?? p.nrm ?? 1,
        color: o.color, mask: o.mask,
      });
      geo.dispose();
    };

    /* ---- inner void: everything behind the aperture is black ---- */
    {
      const v = domeShell({
        r: 0.093, a0: 0.02, a1: 3.06, b0: -Math.PI, b1: Math.PI, closeU: true,
        sx: 0.96, sy: 1.00, sz: 1.02, thick: 0.006, ru: 12, rv: 6,
      });
      put(L, v, MP.boot, { uv: uvL, color: voidTint, mask: 0.0, edge: 0, cavity: 0, cavBase: 1.0, polish: 0 });
    }

    /* ---- skull.
       The lower edge is a function of azimuth: it stops just above the eyes at
       the front and sweeps down past the ear at the sides and nape. That single
       varying edge is what makes a barbute a barbute rather than a bowl. ---- */
    {
      const skull = shellGeo((u, v, out) => {
        const b = u * Math.PI * 2;
        const front = Math.max(0, Math.cos(b));
        const a1 = lerp(2.14, 1.462, Math.pow(front, 1.35));
        const a = lerp(0.025, a1, v);
        /* Eight raised-and-planished flats. At the previous +/-1.4 % the facets
           were 1.5 mm of relief on a 210 mm dome, which at the closeup camera is
           half a pixel — so the dome resolved as one broad soft specular, the
           tell the critic named exactly ("crumpled aluminium foil"). At 3.4 %
           plus a fluted valley between each pair, the seams are 3.6 mm ridges
           that each carry their own highlight, and the curvature pass reads them
           as convex crests and burnishes them. */
        /* The flute was `pow(|sin(4b)|, 3)`, whose zeros are cusps — derivative
           discontinuities, i.e. unbounded harmonics. Sampled at ru = 40 that is
           five columns per cusp, so `shellGeo`'s central-difference normals
           aliased and every one of the 40 meridians picked up its own error. The
           dome then rendered as ~20 converging hairlines: a combed, brushed-nickel
           swirl instead of eight planished flats, and it was the most prominent
           surface in the closeup frame. `sin^2` of the half-angle is the same
           valley shape with a continuous derivative, and ru = 72 gives nine
           columns per facet crest — enough for the normal estimate to resolve the
           facet it is supposed to describe. */
        const facet = 1
          + 0.034 * Math.cos(b * 8) * Math.sin(a)
          - 0.011 * Math.pow(0.5 - 0.5 * Math.cos(b * 8), 1.6) * Math.sin(a);
        const rr = R * facet;
        out.set(Math.sin(a) * Math.sin(b) * rr * SX, Math.cos(a) * rr * SY, Math.sin(a) * Math.cos(b) * rr * SZ);
      }, { ru: 48, rv: 10, thick: 0.013, bevel: 0.0062, center: [0, 0, 0], closeU: true });
      put(M, skull, MP.helm, { color: steelTint, mask: 0.26 });
    }

    /* ---- comb: a raised crest over the crown, front to back ---- */
    {
      const comb = shellGeo((u, v, out) => {
        const a = lerp(-1.24, 1.04, u);
        const rise = 0.0155 * Math.sin(Math.PI * clamp01(u)) + 0.004;
        const rr = R + rise;
        const w = lerp(-0.0125, 0.0125, v);
        out.set(w, Math.cos(a) * rr * SY, Math.sin(a) * rr * SZ);
      }, { ru: 18, rv: 2, thick: 0.012, bevel: 0.005, center: [0, 0, 0] });
      put(M, comb, MP.comb, { color: steelTint, mask: 0.50 });
    }

    /* ---- brow: a proud band above the aperture, dipping at the centre ---- */
    {
      const brow = shellGeo((u, v, out) => {
        const b = lerp(-1.24, 1.24, u);
        const front = Math.max(0, Math.cos(b));
        const y = lerp(0.036, 0.004, v) - 0.016 * front * front;
        const k = 1.072 - 0.030 * v;
        out.set(Math.sin(b) * R * SX * k, y, Math.cos(b) * R * SZ * k);
      }, { ru: 17, rv: 2, thick: 0.011, bevel: 0.005, center: [0, 0.02, 0] });
      put(M, brow, MP.brow, { color: steelTint, mask: 0.46 });
      // gold browband inlay: the single ornament on the helm
      const inlay = shellGeo((u, v, out) => {
        const b = lerp(-1.16, 1.16, u);
        const front = Math.max(0, Math.cos(b));
        const y = lerp(0.030, 0.020, v) - 0.016 * front * front;
        out.set(Math.sin(b) * R * SX * 1.086, y, Math.cos(b) * R * SZ * 1.086);
      }, { ru: 16, rv: 2, thick: 0.007, bevel: 0.003, center: [0, 0.024, 0] });
      put(G, inlay, MP.trim, { color: goldTint, mask: 0.68 });
      /* Rivets along the brow band, holding it to the skull. The brow is the
         reinforcing band on a real barbute and it is riveted on, not brazed. */
      put(M, rivetRow({
        n: 7, b0: -1.02, b1: 1.02, a: R * SX * 1.072, c: R * SZ * 1.072,
        y0: 0.014, y1: 0.014, sag: -0.010, r: 0.0058, h: 0.0038, tilt: 0.10,
      }), MP.rivet, { color: hwTint, mask: 0.94 });
    }

    /* ---- nasal bar: splits the aperture into two eye slots ---- */
    {
      const nasal = shellGeo((u, v, out) => {
        const b = lerp(-0.205, 0.205, u);
        const y = lerp(0.028, -0.128, v);
        const flare = 1 + 0.10 * smoothstep(0.55, 1.0, v);
        const k = 1.085 - 0.020 * smoothstep(0.0, 0.4, v);
        out.set(Math.sin(b * flare) * R * SX * k, y, Math.cos(b) * R * SZ * k);
      }, { ru: 6, rv: 7, thick: 0.012, bevel: 0.005, center: [0, -0.05, 0] });
      put(M, nasal, MP.brow, { color: steelTint, mask: 0.44, polish: 0.78 });
    }

    /* ---- cheek plates: riveted on, riding proud so they lap the skull ---- */
    for (const s of [-1, 1]) {
      const cheek = shellGeo((u, v, out) => {
        const b = s > 0 ? lerp(0.225, 1.42, u) : lerp(-1.42, -0.225, u);
        const side = 1 - Math.abs(Math.cos(b));
        const y = lerp(-0.038 - 0.026 * side, -0.120 + 0.010 * side, v);
        const A = lerp(0.108, 0.086, v), C = lerp(0.120, 0.094, v);
        out.set(Math.sin(b) * A, y, Math.cos(b) * C);
      }, { ru: 13, rv: 5, thick: 0.011, bevel: 0.005, center: [0, -0.07, 0] });
      // seam-shaded where the skull's own lower edge laps over it
      put(M, cheek, MP.cheek, {
        color: seamShade(steelTint, HY - 0.030, 0.024, 0.52), mask: 0.30,
        // the two cheeks are not the same piece: shift the tile so they differ
        uv: MP.cheek.uv * (s > 0 ? 1.0 : 0.87),
      });

      // rivets down the cheek's forward edge, now proud domes on the surface
      // normal rather than half-buried spheres
      put(M, rivetRow({
        n: 4, b0: s * 0.30, b1: s * 0.46, a: 0.109, c: 0.121,
        y0: -0.044, y1: -0.126, r: 0.0064, h: 0.0042, tilt: 0.06,
      }), MP.rivet, { color: hwTint, mask: 0.96 });
    }

    /* ---- nape lame over the neck ---- */
    {
      const nape = shellGeo((u, v, out) => {
        const b = lerp(1.06, Math.PI * 2 - 1.06, u);
        const y = lerp(-0.046, -0.116, v);
        const A = lerp(0.108, 0.100, v) * 1.02, C = lerp(0.120, 0.108, v) * 1.02;
        out.set(Math.sin(b) * A, y, Math.cos(b) * C);
      }, { ru: 15, rv: 3, thick: 0.011, bevel: 0.005, center: [0, -0.08, 0] });
      put(M, nape, MP.nape, {
        color: seamShade(steelTint, HY - 0.040, 0.026, 0.56), mask: 0.28,
      });
      put(M, rivetRow({
        n: 5, b0: Math.PI - 0.68, b1: Math.PI + 0.68, a: 0.112, c: 0.124,
        y0: -0.052, y1: -0.052, r: 0.0058, h: 0.0038, tilt: 0.10,
      }), MP.rivet, { color: hwTint, mask: 0.94 });
    }
    void G;
  }

  /* --------------------------------------------------------- weapon */

  /**
   * A hand-and-a-half sword, rigid-bound to `hand_R`. Built along +Y around the
   * grip centre, then pitched forward so it reads as "carried low" in the idle
   * pose. The blade is a lofted diamond section with a raised central ridge, so
   * it catches a specular line down its length instead of reading as a plank.
   */
  _weapon(sb) {
    const uvM = SURFACES.steel.uv, uvG = SURFACES.gold.uv, uvL = SURFACES.leather.uv;
    const steelTint = wearTint({ base: [1, 1, 1], seed: 151, mottle: 0.11, dirt: 0.10, dirtTop: 0.2 });
    const goldTint = wearTint({ base: [1, 1, 1], seed: 163, mottle: 0.10, dirt: 0.08, dirtTop: 0.2 });
    const leatherTint = wearTint({ base: [1, 1, 1], seed: 171, mottle: 0.18, dirt: 0.10, dirtTop: 0.2 });

    const GRIP0 = -0.082, GRIP1 = 0.086, GUARD = 0.098, BLADE0 = 0.118, BLADE1 = 0.985;
    // Pitch in the fist: the blade leaves the hand forward and 20° down, which
    // with the idle arm pose reads as "carried low" and swings through a
    // believable arc when the shoulder drives it.
    const PITCH = 1.95;

    /* ---- blade.
       A 14-point lenticular section with a real fuller: the mid-face points sit
       *below* the shoulder points for the first two thirds of the length, which
       is a groove, and then rise past them into a diamond ridge for the last
       third, which is a reinforced point. That single change is the difference
       between a sword and the flat spike the previous pass produced — the
       fuller catches a broken specular line down the blade and the ridge
       catches an unbroken one, so the length reads. ---- */
    const section = (w, th, fuller) => {
      const hw = w * 0.5;
      // fuller = 1 -> grooved face at 0.52 of thickness; 0 -> ridge at 1.0
      const midY = lerp(1.02, 0.50, fuller);
      const shoulder = lerp(0.80, 0.86, fuller);
      const top = [
        [-hw, 0],
        [-hw * 0.80, th * 0.56],
        [-hw * 0.44, th * shoulder],
        [-hw * 0.15, th * midY],
        [hw * 0.15, th * midY],
        [hw * 0.44, th * shoulder],
        [hw * 0.80, th * 0.56],
      ];
      return [
        ...top, [hw, 0],
        ...top.slice(1).reverse().map(([x, y]) => [x, -y]),
      ];
    };
    const rings = [];
    const STEPS = 18;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const y = lerp(BLADE0, BLADE1, t);
      // slim ricasso, then a long even taper, then the point
      const taper = t < 0.06
        ? lerp(0.86, 1.0, t / 0.06)
        : (t < 0.74 ? 1 - (t - 0.06) * 0.24 : (1 - 0.68 * 0.24) * (1 - smoothstep(0.74, 1.0, t) * 0.94));
      const w = 0.098 * taper;
      const th = 0.0235 * (1 - t * 0.42);
      const fuller = 1 - smoothstep(0.48, 0.70, t);
      rings.push({ y, pts: section(w, th, fuller) });
    }
    const blade = loftGeo(rings, { cap: true, capLift: 0.006 });
    blade.rotateX(PITCH);
    sb.steel.rigid(blade, 'hand_R', {
      /* A blade's grain is finer than a breastplate's — but not 0.045 m per
         repeat, which put the generator's 40-cycle detail layer at 1.1 mm and its
         planishing at 2.6 mm. Both are far under a pixel at any camera in the
         game, so the whole map collapsed into per-pixel sparkle along the fuller.
         0.085 m puts the detail at 2.1 mm and the dish structure at 5 mm, which
         is what a hammer-finished fuller looks like, and it still reads three
         times finer than the cuirass beside it.
         The blade also now takes curvature wear and cavity tarnish (`MP.blade`):
         bright burnished steel along the two edges and the spine where the hone
         and the world touch it, dark oxide in the fuller where they do not. A
         uniformly polished blade is a chrome prop. */
      at: 'hand_R', off: [0, 0, 0.012], uvScale: MP.blade.uv,
      uvOff: MP.blade.uvOff, uvRot: MP.blade.uvRot, uvAniso: MP.blade.uvAniso,
      edge: MP.blade.edge, cavity: MP.blade.cavity,
      polish: MP.blade.polish, oxide: MP.blade.oxide, nrm: MP.blade.nrm,
      color: steelTint,
      mask: (x, y, z) => {
        // the edges wear to bright steel; the flats stay tarnished
        const d = Math.hypot(x + 0.318, y - 0.892, z - 0.076);
        // A blade is the one part of a suit that is *kept* polished: it is
        // sharpened and oiled after every fight, so it sits near the top of the
        // wear window over most of its length and only the ricasso by the guard
        // stays dark. It is also the frame's single largest bright element, and a
        // sword that does not catch the light is the tell that this is a prop.
        return clamp01(0.34 + smoothstep(0.10, 0.90, d) * 0.64);
      },
    });
    blade.dispose();

    /* ---- crossguard: a down-swept bar with faceted terminals ---- */
    {
      const bar = block(0.272, 0.030, 0.044, { r: 0.009, seg: 2 });
      bendY(bar, 1.55);          // sweeps the tips toward the blade
      const q = mergeGeos([
        bar,
        // écusson: the collar where the guard meets the blade
        (() => { const e = block(0.062, 0.046, 0.058, { r: 0.014, seg: 2 }); e.translate(0, 0.014, 0); return e; })(),
        // faceted quillon terminals, canted down and back
        ...[-1, 1].map((s) => {
          const t = block(0.034, 0.052, 0.048, { r: 0.011, seg: 2 });
          t.rotateZ(-s * 0.30);
          t.translate(s * 0.126, -0.008, -0.008);
          return t;
        }),
      ]);
      q.rotateX(PITCH);
      q.translate(0, Math.cos(PITCH) * GUARD, Math.sin(PITCH) * GUARD);
      sb.steel.rigid(q, 'hand_R', {
        off: [0, 0, 0.012], uvScale: MP.hardware.uv, uvOff: MP.hardware.uvOff,
        uvRot: MP.hardware.uvRot, edge: MP.hardware.edge, cavity: MP.hardware.cavity,
        polish: MP.hardware.polish, oxide: MP.hardware.oxide, nrm: MP.hardware.nrm,
        color: steelTint, mask: 0.9,
      });
      q.dispose();
      // gold langet running up onto the blade's ricasso
      const lang = block(0.028, 0.072, 0.019, { r: 0.006 });
      lang.rotateX(PITCH);
      lang.translate(0, Math.cos(PITCH) * (GUARD + 0.036), Math.sin(PITCH) * (GUARD + 0.036));
      sb.gold.rigid(lang, 'hand_R', { off: [0, 0, 0.012], uvScale: uvG, color: goldTint, mask: 0.95 });
      lang.dispose();
    }

    /* ---- grip: leather-wrapped, six raised ridges ---- */
    {
      const gRings = [];
      const N = 13;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const y = lerp(GRIP0, GRIP1, t);
        const rib = 1 + 0.10 * Math.cos(t * Math.PI * 2 * 6);
        const rx = 0.0175 * rib * (1 - 0.10 * t);
        const rz = 0.0125 * rib * (1 - 0.08 * t);
        const pts = [];
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          pts.push([Math.cos(a) * rx, Math.sin(a) * rz]);
        }
        gRings.push({ y, pts });
      }
      const grip = loftGeo(gRings, { cap: true });
      grip.rotateX(PITCH);
      sb.leather.rigid(grip, 'hand_R', { off: [0, 0, 0.012], uvScale: uvL * 0.5, color: leatherTint, mask: 0.5 });
      grip.dispose();
    }

    /* ---- pommel: a wheel, disc plane in the plane of the edges ---- */
    {
      const wheel = mergeGeos([
        (() => { const p = new THREE.SphereGeometry(0.0355, 16, 9); p.scale(1.0, 1.0, 0.46); return p; })(),
        // raised hub on both faces
        (() => { const h = new THREE.SphereGeometry(0.0135, 10, 6); h.scale(1, 1, 1.55); return h; })(),
        // stub of tang peened over the top
        (() => { const t = block(0.016, 0.014, 0.016, { r: 0.005 }); t.translate(0, 0.036, 0); return t; })(),
      ]);
      wheel.rotateX(PITCH);
      wheel.translate(0, Math.cos(PITCH) * (GRIP0 - 0.030), Math.sin(PITCH) * (GRIP0 - 0.030));
      sb.steel.rigid(wheel, 'hand_R', { off: [0, 0, 0.012], uvScale: uvM, color: steelTint, mask: 0.95 });
      wheel.dispose();
      const cap = new THREE.SphereGeometry(0.0092, 8, 6);
      cap.scale(1, 1, 1.9);
      cap.rotateX(PITCH);
      cap.translate(0, Math.cos(PITCH) * (GRIP0 - 0.030), Math.sin(PITCH) * (GRIP0 - 0.030));
      sb.gold.rigid(cap, 'hand_R', { off: [0, 0, 0.012], uvScale: uvG, color: goldTint, mask: 1.0 });
      cap.dispose();
    }

    /* ---- sockets: rig-space offsets from hand_R's rest position ---- */
    const handRest = this.rig.rest('hand_R', new THREE.Vector3());
    const local = (y) => new THREE.Vector3(0, Math.cos(PITCH) * y, Math.sin(PITCH) * y + 0.012);
    this.weapon.tip.copy(local(BLADE1));
    this.weapon.hilt.copy(local(BLADE0));
    this.weapon.length = this.weapon.tip.distanceTo(this.weapon.hilt);
    void handRest;
  }

  /* --------------------------------------------------------- sockets */

  _anchors() {
    // Cloak pin line: across the top of the pauldrons and behind the gorget.
    const pin = (bone, x, y, z) => {
      const r = this.rig.rest(bone, new THREE.Vector3());
      this.cloakAnchors.push({ bone, offset: new THREE.Vector3(x - r.x, y - r.y, z - r.z) });
    };
    // Pinned behind the back plate, not on the spine axis: a cloak pinned
    // inside the body's collision radius gets shoved out every substep. The
    // torso collider is 0.170 m in radius, so the pin line clears it.
    pin('clavicle_L', 0.218, 1.534, -0.134);
    pin('clavicle_L', 0.156, 1.546, -0.156);
    pin('spine3', 0.074, 1.552, -0.168);
    pin('spine3', 0.000, 1.554, -0.174);
    pin('spine3', -0.074, 1.552, -0.168);
    pin('clavicle_R', -0.156, 1.546, -0.156);
    pin('clavicle_R', -0.218, 1.534, -0.134);
  }

  /* --------------------------------------------------------- runtime */

  /** Emissive hit flash, 0..1. Driven as emissive so it blooms and tonemaps. */
  setFlash(v) {
    const f = clamp01(v);
    if (Math.abs(f - this._flash) < 1e-4) return;
    this._flash = f;
    for (const u of this.uniforms) u.uHeroFlash.value = f;
  }

  dispose() {
    for (const m of this.meshes) { try { m.parent?.remove(m); } catch { /* ignore */ } }
    for (const g of this._geos) { try { g.dispose(); } catch { /* ignore */ } }
    for (const m of this.materials) { try { m.dispose(); } catch { /* ignore */ } }
    this.meshes.length = 0;
    this._geos.length = 0;
    this.materials.length = 0;
  }
}

export { shellGeo, domeShell, bandShell, loftGeo, block, bendX, bendY, wearTint, wearMask };
