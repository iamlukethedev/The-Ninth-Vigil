/**
 * THE NINTH VIGIL — the curtain wall and its gate.
 *
 * A waypoint is a place that survived, and what makes that read is a defence
 * that was built in a hurry out of whatever was to hand: a low stone footing
 * carried around from an older wall, a timber palisade raised on top of it, and
 * one properly built gatehouse where the road comes in.
 *
 *  • **Palisade stakes are instanced.** They are the most-repeated element in
 *    the town by an order of magnitude, so they get one InstancedMesh and one
 *    shared geometry rather than merged copies.
 *  • **The gatehouse is the composition's second focal point.** Two battered
 *    stone towers, a timber fighting gallery oversailing the arch, a raised
 *    portcullis, a banded oak leaf standing part-open, and a brazier on a stone
 *    pillar either side. The braziers are the only shadow-casting practicals the
 *    town asks for.
 *  • Nothing meets the ground at a clean line: the footing steps, batters, and
 *    is buried below the terrain sample at every post.
 */

import * as THREE from 'three';
import {
  Assembler, box, beam, board, stakeGeo, mergeParts, xform, shingleRoof, latheGeo,
  bakeArch, faceBoxUV, fbm3, clamp01, lerp,
} from './Geo.js';

const PI = Math.PI;

function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {import('./Geo.js').Assembler} A world-space assembler
 * @returns {{lights:object[], instanced:{mesh:THREE.InstancedMesh, mat:string}[]}}
 */
export function buildWall(A, { plan, probe, seed = 1 }) {
  const lights = [];
  const instanced = [];
  const wall = plan.wall;
  if (!wall) return { lights, instanced };
  const r = mulberry(seed);
  const pts = wall.pts;
  const gate = wall.gate;

  /* ------------------------------------------------------------------ *
   * pass 1 — collect palisade stake transforms and footing sections
   * ------------------------------------------------------------------ */
  const stakes = [];        // {x,y,z,yaw,tilt,h,rr}
  const footing = [];
  const rail = [];
  const brace = [];
  const stoneCurtain = [];
  const merlons = [];

  const GATE_CLEAR = 3.4;   // half-width of the gateway opening

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const tx = dx / len, tz = dz / len;
    const yaw = Math.atan2(tx, tz);
    // Segments touching the gate vertex are built as proper stone curtain; the
    // rest is palisade. That contrast is what makes the gate read as the piece
    // somebody paid for.
    const stone = i === gate.index - 1 || i === gate.index;

    /* --- footing: stepped, battered rubble that follows the ground --- */
    const fstep = 1.35;
    const nF = Math.max(1, Math.round(len / fstep));
    for (let k = 0; k < nF; k++) {
      const t = (k + 0.5) / nF;
      const wx = a.x + dx * t, wz = a.z + dz * t;
      if (Math.hypot(wx - gate.x, wz - gate.z) < GATE_CLEAR) continue;
      const gy = probe.heightAt(wx, wz);
      const h = 0.82 + fbm3(k * 1.7, i * 2.3, seed, { octaves: 2, seed }) * 0.34;
      const w = len / nF * 1.04;
      footing.push(xform(box(w, h + 0.5, 1.12, 0.04, 2), {
        rotY: yaw, pos: [wx, gy + (h + 0.5) * 0.5 - 0.5, wz],
      }));
      // a second, wider course at the very base
      footing.push(xform(box(w * 1.01, 0.26, 1.5, 0.045), { rotY: yaw, pos: [wx, gy - 0.02, wz] }));
    }

    if (stone) {
      /* --- stone curtain: 5 m of ashlar with a walkway and merlons --- */
      const sstep = 1.2;
      const nS = Math.max(1, Math.round(len / sstep));
      for (let k = 0; k < nS; k++) {
        const t = (k + 0.5) / nS;
        const wx = a.x + dx * t, wz = a.z + dz * t;
        if (Math.hypot(wx - gate.x, wz - gate.z) < GATE_CLEAR) continue;
        const gy = probe.heightAt(wx, wz);
        const H = 4.5 + fbm3(k * 2.1, i * 1.3, seed + 5, { octaves: 2, seed }) * 0.5;
        const w = len / nS * 1.03;
        // battered: thicker at the bottom
        stoneCurtain.push(xform(box(w, H, 0.98, 0.035, 2), { rotY: yaw, pos: [wx, gy + 0.7 + H * 0.5, wz] }));
        stoneCurtain.push(xform(box(w * 1.005, 0.9, 1.22, 0.04), { rotY: yaw, pos: [wx, gy + 1.05, wz] }));
        // string course under the parapet
        stoneCurtain.push(xform(box(w * 1.01, 0.16, 1.24, 0.03), { rotY: yaw, pos: [wx, gy + 0.7 + H - 0.5, wz] }));
        // merlons, with embrasures between them
        if (k % 2 === 0) {
          const mh = 0.82 + fbm3(k * 3.1, i, seed + 9, { octaves: 1, seed }) * 0.16;
          merlons.push(xform(box(w * 0.78, mh, 1.02, 0.035), { rotY: yaw, pos: [wx, gy + 0.7 + H + mh * 0.5, wz] }));
        }
      }
    } else {
      /* --- palisade: sharpened stakes, a rail and raking braces --- */
      const gap = 0.30;
      const nP = Math.max(2, Math.round(len / gap));
      for (let k = 0; k <= nP; k++) {
        const t = k / nP;
        const wx = a.x + dx * t, wz = a.z + dz * t;
        if (Math.hypot(wx - gate.x, wz - gate.z) < GATE_CLEAR) continue;
        const gy = probe.heightAt(wx, wz);
        const n = fbm3(k * 1.31, i * 2.7, seed + 11, { octaves: 2, seed });
        if (n < 0.10) continue;                                 // a stake pulled out
        const foot = 0.86 + fbm3(k * 0.7, i * 1.1, seed, { octaves: 2, seed }) * 0.3;
        stakes.push({
          x: wx + (n - 0.5) * 0.05, y: gy + foot - 0.12, z: wz + (n - 0.5) * 0.05,
          yaw: yaw + (n - 0.5) * 0.5,
          tilt: (n - 0.5) * 0.10,
          h: 2.55 + n * 0.85,
          rr: 0.085 + n * 0.035,
        });
      }
      // horizontal rails lashed across the back
      const nR = Math.max(1, Math.round(len / 2.0));
      for (let k = 0; k < nR; k++) {
        const t = (k + 0.5) / nR;
        const wx = a.x + dx * t, wz = a.z + dz * t;
        if (Math.hypot(wx - gate.x, wz - gate.z) < GATE_CLEAR + 0.6) continue;
        const gy = probe.heightAt(wx, wz);
        for (const ry of [1.55, 3.05]) {
          rail.push(xform(beam(len / nR * 1.02, 0.12, 0.12, { seed: seed + k * 3 + i, seg: 1 }), {
            euler: [0, yaw, PI * 0.5], pos: [wx - tz * 0.5, gy + ry, wz + tx * 0.5],
          }));
        }
        // a raking brace every other bay
        if (k % 2 === 0) {
          brace.push(xform(beam(3.1, 0.11, 0.11, { seed: seed + 40 + k, seg: 1 }), {
            euler: [0.72, yaw, 0], pos: [wx - tz * 1.0, gy + 1.5, wz + tx * 1.0],
          }));
        }
      }
    }
  }

  if (footing.length) A.add('ashlar', mergeParts(footing));
  if (stoneCurtain.length) A.add('ashlar', mergeParts(stoneCurtain));
  if (merlons.length) A.add('ashlar', mergeParts(merlons));
  if (rail.length) A.add('timber', mergeParts(rail));
  if (brace.length) A.add('timber', mergeParts(brace));

  /* ------------------------------------------------------------------ *
   * palisade stakes — one InstancedMesh for the lot
   * ------------------------------------------------------------------ */
  if (stakes.length) {
    const geo = stakeGeo(1.0, 0.1, { seed: seed + 3, seg: 7 });
    // per-instance colour variation cannot ride on vertex colour in an
    // InstancedMesh sharing one geometry, so bake the weathering into the
    // geometry once and let the height/tilt jitter carry the variety.
    bakeArch(geo, { seed: seed + 4, groundY: 0, groundH: 0.5, groundK: 0.5, cavity: 0.4, blotch: 0.2, damp: 0.55, dampH: 0.45 });
    const mesh = new THREE.InstancedMesh(geo, null, stakes.length);
    mesh.name = 'town.palisade';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < stakes.length; i++) {
      const S = stakes[i];
      e.set(S.tilt, S.yaw, S.tilt * 0.7);
      q.setFromEuler(e);
      p.set(S.x, S.y, S.z);
      s.set(S.rr / 0.1, S.h, S.rr / 0.1);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    instanced.push({ mesh, mat: 'timber' });
  }

  /* ------------------------------------------------------------------ *
   * gatehouse
   * ------------------------------------------------------------------ */
  {
    const gx = gate.x, gz = gate.z, gy = gate.y;
    const yaw = gate.yaw;                         // along the wall
    const tx = Math.sin(yaw), tz = Math.cos(yaw); // wall tangent
    const nx = -tz, nz = tx;                      // outward-ish normal
    const G = new Assembler();                    // a local assembler in gate space

    const OPEN = 3.2;         // clear width of the gateway
    const TW = 2.5;           // tower width along the wall
    const TD = 3.0;           // tower depth across the wall
    const TH = 7.2;           // tower height

    for (const side of [-1, 1]) {
      const cx = side * (OPEN * 0.5 + TW * 0.5);
      /* battered tower: four stacked courses each slightly narrower */
      const courses = 5;
      let y = -0.4;
      for (let i = 0; i < courses; i++) {
        const t = i / courses;
        const ch = (TH + 0.4) / courses;
        const k = lerp(1.10, 0.94, t);
        G.add('ashlar', box(TW * k, ch * 1.02, TD * k, 0.05, 2), { pos: [cx, y + ch * 0.5, 0] });
        y += ch;
      }
      /* corbel table + parapet + merlons */
      G.add('ashlar', box(TW * 1.16, 0.20, TD * 1.16, 0.04), { pos: [cx, TH - 0.05, 0] });
      G.add('ashlar', box(TW * 1.10, 0.16, TD * 1.10, 0.035), { pos: [cx, TH - 0.28, 0] });
      for (let mi = 0; mi < 3; mi++) {
        for (const zz of [-1, 1]) {
          const mx = cx + (mi - 1) * TW * 0.36;
          G.add('ashlar', box(TW * 0.28, 0.78, 0.34, 0.03), { pos: [mx, TH + 0.44, zz * (TD * 0.5)] });
        }
        G.add('ashlar', box(0.32, 0.78, TD * 0.3, 0.03), { pos: [cx + side * TW * 0.52, TH + 0.44, (mi - 1) * TD * 0.32] });
      }
      /* arrow loops: a narrow dark slot with a splayed stone surround */
      for (const ly of [2.5, 4.6]) {
        G.add('ashlar', box(0.46, 1.05, 0.22, 0.03), { pos: [cx, ly, TD * 0.5 + 0.02] });
        G.add('glow:rune', box(0.10, 0.62, 0.06, 0.02), { pos: [cx, ly, TD * 0.5 + 0.10] });
      }
      /* a stone pillar carrying a brazier, out in front of the tower */
      const px = side * (OPEN * 0.5 + TW * 0.35);
      const pz = TD * 0.5 + 1.15;
      G.add('ashlar', box(0.62, 1.28, 0.62, 0.04, 2), { pos: [px, 0.6, pz] });
      G.add('ashlar', box(0.78, 0.14, 0.78, 0.03), { pos: [px, 1.28, pz] });
      // the bowl: a lathe form with a coal bed and iron feet
      G.add('iron', latheGeo([[0.001, 0], [0.14, 0.02], [0.30, 0.10], [0.34, 0.26], [0.31, 0.30], [0.28, 0.28], [0.30, 0.10]],
        { seg: 14, uTile: 1, seed: seed + side, lobeAmt: 0.012 }), { pos: [px, 1.34, pz] });
      const coals = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * 6.283 + r();
        const rr = r() * 0.2;
        coals.push(xform(box(0.075 + r() * 0.05, 0.05, 0.075 + r() * 0.05, 0.018),
          { rotY: r() * 3, pos: [Math.cos(a) * rr, r() * 0.02, Math.sin(a) * rr] }));
      }
      G.add('glow:coal', mergeParts(coals), { pos: [px, 1.60, pz] });
      lights.push({
        kind: 'brazier',
        lx: px, ly: 1.85, lz: pz,
        color: 0xff9438, intensity: 30, radius: 16, flicker: 0.6,
        priority: 3.0, shadow: side > 0, flame: true, flameScale: 1.5,
      });
    }

    /* --- the arch --- */
    {
      // voussoirs sweeping over the opening
      const nV = 13;
      const R = OPEN * 0.5 + 0.2;
      const springY = 3.1;
      const vs = [];
      for (let i = 0; i < nV; i++) {
        const a = PI * (i + 0.5) / nV;
        const ax = Math.cos(a) * R, ay = Math.sin(a) * R;
        vs.push(xform(box(0.42, 0.5, TD + 0.5, 0.03), {
          euler: [0, 0, a - PI * 0.5],
          pos: [ax, springY + ay, 0],
        }));
      }
      G.add('ashlar', mergeParts(vs));
      // spandrel wall above the arch
      G.add('ashlar', box(OPEN + 0.9, 1.5, TD * 0.92, 0.04, 2), { pos: [0, springY + R + 0.85, 0] });
      // a carved keystone
      G.add('ashlar', box(0.44, 0.66, TD + 0.62, 0.05), { pos: [0, springY + R + 0.16, 0] });
    }

    /* --- timber fighting gallery oversailing the arch --- */
    {
      const gw = OPEN + TW * 2 + 0.4;
      const gd = TD * 0.75;
      const y0 = 5.2;
      // joists poking out under it
      const nJ = 9;
      const joists = [];
      for (let i = 0; i < nJ; i++) {
        const x = -gw * 0.5 + (gw / (nJ - 1)) * i;
        joists.push(xform(box(0.13, 0.15, gd + 1.5, 0.02), { pos: [x, 0, 0.6] }));
      }
      G.add('timber', mergeParts(joists), { pos: [0, y0 - 0.1, 0] });
      // the hoarding: plank walls with murder-holes, and a shingle pent roof
      const planks = [];
      const nPl = Math.round(gw / 0.28);
      for (let i = 0; i < nPl; i++) {
        const x = -gw * 0.5 + (gw / nPl) * (i + 0.5);
        const n = fbm3(i * 1.7, 3.1, seed, { octaves: 2, seed });
        if (n < 0.16) continue;                       // gaps to shoot through
        planks.push(xform(board(1.5, gw / nPl * 0.92, 0.05, { seed: seed + i, cup: 0.1 }),
          { euler: [PI * 0.5, 0, (n - 0.5) * 0.03], pos: [x, 0, 0] }));
      }
      G.add('plank', mergeParts(planks), { pos: [0, y0 + 0.78, gd * 0.5 + 0.55] });
      for (let i = 0; i < 5; i++) {
        G.add('timber', beam(1.7, 0.12, 0.12, { seed: seed + 60 + i, seg: 1 }),
          { pos: [-gw * 0.5 + (gw / 4) * i, y0 + 0.85, gd * 0.5 + 0.55] });
      }
      G.add('shingle', shingleRoof(gw + 0.3, 1.5, { course: 0.24, shake: 0.3, step: 0.028, thick: 0.05, seed: seed + 70 }),
        { euler: [-0.42, 0, 0], pos: [0, y0 + 1.62, gd * 0.5 - 0.4] });
      // a banner hanging from the gallery rail
      G.add('awning', bannerGeo(0.85, 1.9, seed + 80), { pos: [0, y0 + 0.7, gd * 0.5 + 0.62] });
    }

    /* --- portcullis, raised but not fully --- */
    {
      const pw = OPEN - 0.15, ph = 2.5;
      const bars = [];
      const nB = 7;
      for (let i = 0; i < nB; i++) {
        const x = -pw * 0.5 + (pw / (nB - 1)) * i;
        bars.push(xform(box(0.075, ph, 0.075, 0.016), { pos: [x, 0, 0] }));
      }
      for (let j = 0; j < 4; j++) {
        bars.push(xform(box(pw, 0.07, 0.06, 0.014), { pos: [0, -ph * 0.5 + (ph / 3) * j, 0] }));
      }
      // spiked bottom
      for (let i = 0; i < nB; i++) {
        const x = -pw * 0.5 + (pw / (nB - 1)) * i;
        bars.push(xform(box(0.07, 0.24, 0.07, 0.03), { pos: [x, -ph * 0.5 - 0.1, 0] }));
      }
      G.add('iron', mergeParts(bars), { pos: [0, 4.55, TD * 0.16] });
      // the chase it runs in
      for (const side of [-1, 1]) {
        G.add('ashlar', box(0.26, 4.4, 0.4, 0.02), { pos: [side * (OPEN * 0.5 + 0.02), 3.2, TD * 0.16] });
      }
    }

    /* --- the gate leaf itself: banded oak, standing part open --- */
    {
      const lw = OPEN * 0.5 - 0.06, lh = 3.5;
      for (const side of [-1, 1]) {
        const L = new Assembler();
        const nPl = 6;
        for (let i = 0; i < nPl; i++) {
          const x = -lw * 0.5 + (lw / nPl) * (i + 0.5);
          L.add('plank', board(lh, lw / nPl * 0.95, 0.10, { seed: seed + 90 + i + side, cup: 0.08 }),
            { euler: [PI * 0.5, 0, 0], pos: [x, 0, 0] });
        }
        for (const by of [-0.35, 0.42, 1.15]) {
          L.add('iron', box(lw * 0.98, 0.09, 0.035, 0.008), { pos: [0, by, 0.07] });
          L.add('iron', box(0.13, 0.16, 0.10, 0.02), { pos: [-lw * 0.5 + 0.06, by, 0.08] });
        }
        // a big ring handle and studs
        L.add('iron', xform(faceUV(new THREE.TorusGeometry(0.09, 0.02, 6, 12)), { euler: [PI * 0.5, 0, 0] }),
          { pos: [lw * 0.34, 0.1, 0.11] });
        // swing it open by ~55°
        const ang = side * -0.95;
        const hingeX = side * (OPEN * 0.5 - 0.04);
        G.absorb(L, {
          euler: [0, ang, 0],
          pos: [hingeX - Math.sin(ang) * 0 - side * Math.cos(ang) * lw * 0.5, lh * 0.5 + 0.05, TD * 0.16 - side * Math.sin(ang) * lw * 0.5],
        });
      }
    }

    /* --- a rutted threshold and a spill of gravel through the arch --- */
    G.add('ashlar', box(OPEN + 1.2, 0.12, 2.0, 0.03), { pos: [0, 0.03, TD * 0.16] });
    for (let i = 0; i < 8; i++) {
      G.add('ashlar', box(0.2 + r() * 0.16, 0.1, 0.18 + r() * 0.14, 0.03), {
        rotY: r() * 3,
        pos: [(r() - 0.5) * (OPEN + 2), 0.02, TD * 0.16 + (r() - 0.5) * 4.0],
      });
    }

    /* --- push the whole gatehouse into world space --- */
    const yawW = yaw;
    A.absorb(G, { rotY: yawW, pos: [gx, gy, gz] });

    // and take the lights with it
    for (const L of lights) {
      if (L.lx === undefined) continue;
      const c = Math.cos(yawW), s = Math.sin(yawW);
      L.x = gx + L.lx * c + L.lz * s;
      L.z = gz - L.lx * s + L.lz * c;
      L.y = gy + L.ly;
      delete L.lx; delete L.ly; delete L.lz;
    }
    void nx; void nz;
  }

  return { lights, instanced };
}

/** A hanging banner with a scalloped hem and a slight billow. */
function bannerGeo(w, h, seed) {
  const sx = 8, sy = 12;
  const pos = [], uv = [], col = [], idx = [];
  for (let j = 0; j <= sy; j++) {
    const tv = j / sy;
    for (let i = 0; i <= sx; i++) {
      const tu = i / sx;
      const hem = tv > 0.92 ? -Math.abs(Math.sin(tu * Math.PI * 3)) * 0.16 : 0;
      const billow = Math.sin(tu * Math.PI) * 0.06 * tv
        + (fbm3(tu * 4, tv * 5, seed, { octaves: 3, seed }) - 0.5) * 0.05;
      pos.push((tu - 0.5) * w, -tv * h + hem, billow);
      uv.push(tu * w, tv * h);
      // a device: a pale bar across a dark field, sun-bleached at the top
      const dev = (tv > 0.30 && tv < 0.46) || (Math.abs(tu - 0.5) < 0.09 && tv > 0.16 && tv < 0.7) ? 1 : 0;
      const wear = 1 - tv * 0.22;
      const base = dev ? [1.35, 1.15, 0.72] : [0.62, 0.30, 0.28];
      col.push(base[0] * wear, base[1] * wear, base[2] * wear);
    }
  }
  for (let j = 0; j < sy; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function faceUV(geo) { const out = faceBoxUV(geo, 1); if (out !== geo) geo.dispose(); return out; }

export { bannerGeo };
void clamp01;
