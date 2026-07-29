/**
 * SANCTUM — the waypoint shrine.
 *
 * The single most-needed thing in the old `hub` capture was a focal point: an
 * object the eye lands on, lit differently from everything else, that tells you
 * what this place is for. This is it — a riven monolith on a stepped dais, its
 * carved channels running with arcane light, ringed by chained standing stones,
 * a slow orbit of glyph plates, and two braziers on the approach so the cold
 * violet key has warm firelight to be read against.
 *
 * Colour discipline: the town's palette is desaturated cold stone punctuated by
 * warm firelight, so the shrine supplies the scene's ONE saturated accent
 * (arcane violet) and nothing else in the town is allowed to be saturated. That
 * is what stops the frame going rainbow.
 */

import * as THREE from 'three';
import {
  Assembler, box, beam, latheGeo, chainGeo, mergeParts, xform, tube,
  faceBoxUV, paintVertex, fbm3, clamp01, lerp,
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
function faceUV(geo) { const out = faceBoxUV(geo, 1); if (out !== geo) geo.dispose(); return out; }

/**
 * A riven standing stone: a tapered hexagonal shaft, split down one face, with
 * the split filled by a glowing vein. `sides = 6` reads as worked stone; the
 * per-ring lateral drift keeps it from reading as an extruded prism.
 */
function monolithGeo(h, r0, r1, { sides = 7, rings = 9, seed = 3, split = 0.0 } = {}) {
  const pos = [], nor = [], uv = [], idx = [];
  const cols = sides + 1;
  const ctr = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings;
    const rr = lerp(r0, r1, Math.pow(t, 0.78));
    const cx = (fbm3(t * 2.4, 1.1, seed, { octaves: 2, seed }) - 0.5) * 0.22 * t;
    const cz = (fbm3(t * 2.4, 4.7, seed, { octaves: 2, seed }) - 0.5) * 0.18 * t;
    ctr.push([cx, t * h, cz, rr]);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * PI * 2 + t * 0.10;
      // per-facet chamfer + chipped edges
      const chip = (fbm3(i * 3.1, t * 5.2, seed + 7, { octaves: 2, seed }) - 0.5) * 0.10;
      const rad = rr * (1 + chip) * (1 - split * Math.max(0, Math.cos(a - 0.4)) * t * 0.14);
      pos.push(cx + Math.cos(a) * rad, t * h, cz + Math.sin(a) * rad);
      nor.push(Math.cos(a), 0, Math.sin(a));
      uv.push((i / sides) * rr * 6.283, t * h);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < sides; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // a broken, canted cap rather than a flat top
  const base = pos.length / 3;
  const top = ctr[rings];
  pos.push(top[0] + 0.05, h + 0.09, top[2] - 0.03); nor.push(0, 1, 0); uv.push(0, 0);
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * PI * 2 + 0.10;
    const k = 0.9 + (fbm3(i * 2.7, 9.1, seed, { octaves: 2, seed }) - 0.5) * 0.3;
    pos.push(top[0] + Math.cos(a) * top[3] * k, h - 0.05 + Math.sin(a * 2 + seed) * 0.09, top[2] + Math.sin(a) * top[3] * k);
    nor.push(0, 1, 0); uv.push((i / sides) * top[3] * 6.283, h);
  }
  for (let i = 0; i < sides; i++) idx.push(base, base + 1 + i + 1, base + 1 + i);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * @param {import('./Geo.js').Assembler} A world-space assembler
 * @returns {{lights:object[], spin:Assembler|null, spinAt:number[]}}
 */
export function buildLandmark(A, { plan, probe, seed = 1 }) {
  const lights = [];
  const L = plan.landmark;
  if (!L) return { lights, spin: null, spinAt: [0, 0, 0] };
  const r = mulberry(seed);
  const S = new Assembler();
  const spin = new Assembler();

  /* ---------------- the dais ---------------- */
  let dais = 0.6;
  {
    const steps = [[3.95, 0.24], [3.15, 0.26], [2.40, 0.28]];
    let y = -0.16;
    for (let i = 0; i < steps.length; i++) {
      const [rad, hh] = steps[i];
      // built out of wedge blocks, not a cylinder: the joints matter at 20 m
      const n = 16 - i * 2;
      const parts = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * PI * 2 + i * 0.2;
        const jn = fbm3(k * 1.9, i * 3.3, seed, { octaves: 1, seed });
        const rr = rad * (0.985 + (jn - 0.5) * 0.03);
        parts.push(xform(box(rad * 0.86, hh * 1.02, rad * 0.55, 0.035, 2), {
          euler: [(jn - 0.5) * 0.02, -a, (jn - 0.5) * 0.02],
          pos: [Math.cos(a) * (rr - rad * 0.27), y + hh * 0.5, Math.sin(a) * (rr - rad * 0.27)],
        }));
      }
      S.add('ashlar', mergeParts(parts));
      y += hh;
    }
    // the paved top with a worn, wax-run kneeling stone
    S.add('ashlar', latheGeo([[0.001, 0], [2.15, 0.0], [2.2, 0.09], [2.1, 0.10]], { seg: 26, uTile: 1, seed: 5, lobeAmt: 0.02 }), { pos: [0, y - 0.02, 0] });
    S.add('ashlar', box(1.1, 0.16, 0.55, 0.04), { rotY: 0.3, pos: [0, y + 0.06, 1.35] });
    dais = y + 0.08;
  }

  /* ---------------- the monolith ---------------- */
  // Heavier than the first pass: at 0.74 m across the base and 26 m from the lens
  // a 6 m shaft was three pixels wide at the top and read as a dark spike rather
  // than the thing the composition is built around.
  const MH = 6.6;
  {
    const geo = monolithGeo(MH, 1.00, 0.54, { sides: 7, rings: 11, seed: 11, split: 1 });
    // darken the flutes so the glowing channels have something to sit in
    paintVertex(geo, (x, y2, z, nx, ny, nz, out) => {
      const k = 1 - 0.30 * clamp01(1 - y2 / MH) - 0.12 * clamp01(-ny);
      out[0] = k * 0.95; out[1] = k * 0.96; out[2] = k * 1.02;   // cold stone
    });
    S.add('ashlar', geo, { euler: [0.022, 0.4, -0.03], pos: [0, dais, 0] });

    /*
     * The carved channels.
     *
     * These were authored as a stack of seven 4.5 cm boxes per channel plus a ring
     * of sixteen 3.8 cm glyphs. At this camera one pixel is 2.1 cm of world, so
     * every one of those was a two-pixel high-contrast emissive fleck: they did
     * not read as carved light, they read as coloured sparkle crawling on the
     * stone — textbook aliasing on a high-contrast edge, which the rubric fails
     * explicitly. Rebuilt as FEWER, WIDER, CONTINUOUS forms: three fat segments
     * per channel (five pixels across, proud enough to catch their own shading),
     * and the glyph ring is now one turned band of light instead of sixteen dots.
     */
    /*
     * The shaft is a SEVEN-sided prism, so its flat faces sit at
     * `circumradius * cos(pi/7)` = 0.90 of the radius the ring vertices use. The
     * previous pass placed the channels on the circumradius plus a 28 mm proud
     * offset, which put every one of them 13 cm clear of the stone: on screen the
     * "carved" light read as a cage of bars floating around the monolith. This is
     * the apothem, so a channel lies in its facet.
     */
    const FACET = Math.cos(PI / 7);
    const R_AT = (yy) => lerp(1.00, 0.54, Math.pow(clamp01(yy / MH), 0.78)) * FACET;
    const runes = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * PI * 2 + 0.35;
      const y0 = 0.55 + r() * 0.4;
      const y1 = MH * (0.60 + r() * 0.26);
      const n = 3;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const yy = lerp(y0, y1, t);
        const rr = R_AT(yy) + 0.012;
        const wob = Math.sin(t * 4.1 + i) * 0.055;
        runes.push(xform(box(0.115, (y1 - y0) / n * 0.92, 0.075, 0.024), {
          rotY: -(a + wob),
          pos: [Math.cos(a + wob) * rr, yy, Math.sin(a + wob) * rr],
        }));
      }
    }
    {
      const yy = MH * 0.44;
      const rr = R_AT(yy) + 0.010;
      runes.push(xform(latheGeo([[rr, -0.075], [rr * 1.012, 0], [rr, 0.075]],
        { seg: 22, uTile: 1, seed: 9, lobeAmt: 0.006 }), { pos: [0, yy, 0] }));
    }
    S.add('glow:rune', mergeParts(runes), { euler: [0.022, 0.4, -0.03], pos: [0, dais, 0] });

    // the split: a wedge of light in the riven face
    S.add('glow:rune', box(0.14, MH * 0.32, 0.30, 0.026), { euler: [0.03, 0.0, 0.02], pos: [0.50, dais + MH * 0.62, -0.28] });
    // the capstone gem — the single brightest point in the frame, and the thing
    // the eye is supposed to land on first
    S.add('glow:rune', latheGeo([[0.001, 0], [0.13, 0.10], [0.10, 0.22], [0.001, 0.30]],
      { seg: 9, uTile: 1, seed: 13, lobeAmt: 0.02 }), { pos: [0.05, dais + MH + 0.10, -0.03] });

    /*
     * Practical placement. The shipped pair sat on the shaft's own axis at 58% of
     * its height — i.e. INSIDE 1 m of solid ashlar. A point light inside an opaque
     * object lights the world and leaves the object itself entirely to ambient,
     * which is precisely why the landmark measured as a black monolith. Both are
     * now outside the stone: a high one pushed clear of the shaft on the camera
     * side so the flutes get a raking violet key, and a low one at the dais lip
     * for the bounce onto the steps.
     */
    lights.push({
      kind: 'shrine',
      x: L.x - Math.sin(L.rotY + 0.5) * 1.9, y: L.y + dais + MH * 0.66, z: L.z - Math.cos(L.rotY + 0.5) * 1.9,
      color: 0x9c7cff, intensity: 11, radius: 10.5, flicker: 0.14, type: 'rune',
      priority: 3.4, shadow: false,
    });
    lights.push({
      kind: 'shrine',
      x: L.x + Math.sin(L.rotY - 1.9) * 1.7, y: L.y + dais + 0.75, z: L.z + Math.cos(L.rotY - 1.9) * 1.7,
      color: 0x7a5ce8, intensity: 6.0, radius: 8.5, flicker: 0.1, type: 'rune',
      priority: 2.2, shadow: false,
    });
  }

  /* ---------------- the orbiting glyph plates ---------------- */
  {
    /*
      * Six plates, not nine, and held in close to the shaft. At radius 1.55 m with
      * an ashlar backing plate the size of the glyph, they read at this camera as
      * loose sheets of white paper orbiting the stone — a floating-geometry tell.
      * Tucked to 1.25 m and cut down to a slate tablet with a lit face, they read
      * as what they are.
      */
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2;
      const rr = 1.24 + (i % 3) * 0.10;
      const yy = (i % 2 ? 0.05 : -0.05) + Math.sin(a * 2) * 0.10;
      const g = box(0.155, 0.235, 0.038, 0.010);
      spin.add('glow:glyph', g, { euler: [0.2, -a, 0.14], pos: [Math.cos(a) * rr, yy, Math.sin(a) * rr] });
      spin.add('ashlar', box(0.185, 0.265, 0.030, 0.009), { euler: [0.2, -a, 0.14], pos: [Math.cos(a) * rr * 1.03, yy, Math.sin(a) * rr * 1.03] });
    }
  }

  /* ---------------- chained standing stones ---------------- */
  {
    const n = 4;
    const posts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * PI * 2 + 0.78;
      const rr = 4.6;
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      const gy = probe.heightAt(L.x + px, L.z + pz) - L.y;
      const hh = 1.5 + r() * 0.5;
      S.add('ashlar', monolithGeo(hh, 0.24, 0.17, { sides: 6, rings: 5, seed: 21 + i }), {
        euler: [(r() - 0.5) * 0.09, r() * 3, (r() - 0.5) * 0.09], pos: [px, gy - 0.1, pz],
      });
      S.add('iron', xform(faceUV(new THREE.TorusGeometry(0.055, 0.014, 5, 12)), { euler: [PI * 0.5, 0, 0] }),
        { pos: [px, gy + hh - 0.18, pz] });
      posts.push([px, gy + hh - 0.2, pz]);
    }
    for (let i = 0; i < n; i++) {
      const a = posts[i], b = posts[(i + 1) % n];
      const ch = chainGeo({
        end: [b[0] - a[0], b[1] - a[1], b[2] - a[2]], links: 13, linkR: 0.05, wire: 0.014,
        slack: 0.42, seed: 30 + i,
      });
      S.add('iron', ch, { pos: [a[0], a[1], a[2]] });
      // prayer ribbons tied to the chain
      if (i % 2 === 0) {
        const mx = (a[0] + b[0]) * 0.5, mz = (a[2] + b[2]) * 0.5;
        const my = (a[1] + b[1]) * 0.5 - 0.35;
        for (let k = 0; k < 3; k++) {
          S.add('awning', box(0.055, 0.46 + r() * 0.2, 0.012, 0.004), {
            euler: [(r() - 0.5) * 0.3, r() * 3, (r() - 0.5) * 0.2],
            pos: [mx + (r() - 0.5) * 0.7, my - 0.2, mz + (r() - 0.5) * 0.7],
          });
        }
      }
    }
  }

  /* ---------------- braziers on the approach ---------------- */
  {
    for (const side of [-1, 1]) {
      const a = 1.9 + side * 0.72;
      const px = Math.cos(a) * 3.0, pz = Math.sin(a) * 3.0;
      const gy = probe.heightAt(L.x + px, L.z + pz) - L.y;
      // an iron tripod: three raking legs and a ring
      for (let k = 0; k < 3; k++) {
        const la = (k / 3) * PI * 2 + 0.4;
        S.add('iron', box(0.05, 1.12, 0.05, 0.012), {
          euler: [Math.sin(la) * 0.22, 0, -Math.cos(la) * 0.22],
          pos: [px + Math.cos(la) * 0.16, gy + 0.54, pz + Math.sin(la) * 0.16],
        });
      }
      S.add('iron', xform(faceUV(new THREE.TorusGeometry(0.28, 0.018, 5, 16)), { euler: [PI * 0.5, 0, 0] }), { pos: [px, gy + 0.92, pz] });
      S.add('iron', latheGeo([[0.001, 0], [0.12, 0.02], [0.27, 0.11], [0.30, 0.24], [0.275, 0.27], [0.25, 0.25], [0.27, 0.11]],
        { seg: 13, uTile: 1, seed: 41 + side, lobeAmt: 0.012 }), { pos: [px, gy + 1.0, pz] });
      const coals = [];
      for (let k = 0; k < 8; k++) {
        const ca = (k / 8) * 6.283 + r();
        const cr = r() * 0.17;
        coals.push(xform(box(0.07 + r() * 0.04, 0.045, 0.07 + r() * 0.04, 0.016),
          { rotY: r() * 3, pos: [Math.cos(ca) * cr, r() * 0.02, Math.sin(ca) * cr] }));
      }
      S.add('glow:coal', mergeParts(coals), { pos: [px, gy + 1.20, pz] });
      lights.push({
        kind: 'brazier', x: L.x + px * Math.cos(L.rotY) + pz * Math.sin(L.rotY),
        y: L.y + gy + 1.42, z: L.z - px * Math.sin(L.rotY) + pz * Math.cos(L.rotY),
        color: 0xffa04a, intensity: 20, radius: 13, flicker: 0.6,
        priority: 2.4, shadow: false, flame: true, flameScale: 1.25,
      });
    }
  }

  /* ---------------- offerings ---------------- */
  {
    for (let i = 0; i < 11; i++) {
      const a = r() * 6.283;
      const rr = 1.25 + r() * 0.85;
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      const hh = 0.08 + r() * 0.13;
      // candle stubs with wax runs, some burnt out
      S.add('ashlar', latheGeo([[0.001, 0], [0.038, 0.005], [0.034, hh], [0.001, hh + 0.006]],
        { seg: 7, uTile: 1, seed: 60 + i, lobeAmt: 0.02 }), { pos: [px, dais + 0.06, pz] });
      if (r() < 0.62) S.add('glow:coal', box(0.024, 0.035, 0.024, 0.006), { pos: [px, dais + 0.06 + hh + 0.02, pz] });
    }
    // an offering bowl with coins, and a wilted posy
    S.add('iron', latheGeo([[0.001, 0], [0.16, 0.02], [0.19, 0.09], [0.18, 0.10]], { seg: 12, uTile: 1, seed: 71, lobeAmt: 0.006 }),
      { pos: [0.75, dais + 0.06, -0.85] });
    for (let i = 0; i < 5; i++) {
      S.add('iron', box(0.05, 0.012, 0.05, 0.004), { rotY: r() * 3, pos: [0.75 + (r() - 0.5) * 0.16, dais + 0.13, -0.85 + (r() - 0.5) * 0.16] });
    }
    S.add('awning', tube([
      { x: 0, y: 0, z: 0, r: 0.05 }, { x: 0.04, y: 0.1, z: 0.03, r: 0.06 }, { x: 0.08, y: 0.18, z: 0.05, r: 0.03 },
    ], { radial: 6, uTile: 1, capEnd: true, closeStart: true, seed: 77 }), { pos: [-0.85, dais + 0.06, 0.7] });
  }

  A.absorb(S, { rotY: L.rotY, pos: [L.x, L.y, L.z] });
  void beam;
  return {
    lights, spin,
    spinAt: [L.x, L.y + dais + MH * 0.50, L.z],
  };
}
