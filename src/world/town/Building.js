/**
 * SANCTUM — timber-framed building generator.
 *
 * One `buildHouse()` call produces a whole structure as material piles ready to
 * merge: rubble plinth, box-framed walls with real studs and St-Andrew braces,
 * bulged lime infill, a jettied upper storey on carved corbels, leaded windows
 * with warm interiors, shutters where the lamp is out, a banded plank door, a
 * steep coursed-shingle roof with barge boards, and a battered stone chimney.
 *
 * The things that make this read as architecture rather than as boxes:
 *
 *  • **The jetty.** A medieval upper floor oversails the one below on corbels.
 *    That single overhang gives the elevation a hard horizontal shadow line and
 *    is most of why the silhouette reads as "old town" instead of "shed".
 *  • **The frame is structural.** Sill beam, corner posts, studs at ~1.1 m,
 *    wall plate, and diagonal bracing in the end bays. Infill sits *inside* the
 *    frame and bulges, so the timber stands proud and catches the key light.
 *  • **The building has settled.** The whole superstructure leans a couple of
 *    degrees off plumb about both axes, and the plinth is built up out of
 *    courses that follow the ground, so it meets a sloping road properly
 *    instead of intersecting it at a hard line.
 *  • **The roof is coursed.** See `shingleRoof` — real course steps, real butt
 *    shadow, broken butt line, at a few thousand triangles per face.
 *
 * Everything is deterministic from `seed`.
 */

import * as THREE from 'three';
import {
  Assembler, box, beam, board, shingleRoof, infillPanel, leadedWindow, plankDoor,
  chimneyGeo, shopSign, latheGeo, mergeParts, xform, fbm3, clamp01, lerp,
} from './Geo.js';

const PI = Math.PI;

/* ------------------------------------------------------------------ *
 * wall panel
 * ------------------------------------------------------------------ */

/**
 * One timber-framed wall, built in a local frame with the wall plane on XY and
 * its outward face toward +Z. Origin is the middle of the sill.
 *
 * @param {Assembler} A
 * @param {object} o
 *   w, h        wall width and storey height
 *   t           frame timber thickness
 *   openings    [{x, w, h, y0, kind:'window'|'door'|'open', lit, shutters}]
 *   stone       true → coursed ashlar instead of frame + infill
 *   brace       0..1 chance of a diagonal brace per end bay
 */
function frameWall(A, o) {
  const {
    w, h, t = 0.16, seed = 1, openings = [], stone = false, brace = 0.75,
    plaster = 'plaster', timber = 'timber', infillInset = 0.045, noSill = false,
  } = o;
  const r = mulberry(seed);

  if (stone) {
    /*
     * Coursed ashlar, laid as a grid of blocks rather than as one slab, so the
     * courses can be interrupted where an opening goes. A stone wall that
     * ignores its own doorway is not a wall with a door in it, it is a wall with
     * a door painted on it — and the smithy's open bay in particular has to be a
     * real hole for the forge glow to come out of.
     */
    const courses = 5 + ((r() * 3) | 0);
    const ch = h / courses;
    const blocksPer = Math.max(3, Math.round(w / 0.72));
    const bw = w / blocksPer;
    const parts = [];
    for (let ci = 0; ci < courses; ci++) {
      const y0 = ci * ch;
      const stagger = (ci & 1) ? bw * 0.5 : 0;
      for (let bi = -1; bi <= blocksPer; bi++) {
        let x0 = -w * 0.5 + bi * bw + stagger;
        let x1 = x0 + bw;
        if (x1 <= -w * 0.5 || x0 >= w * 0.5) continue;
        x0 = Math.max(x0, -w * 0.5); x1 = Math.min(x1, w * 0.5);
        if (x1 - x0 < bw * 0.25) continue;
        const cx = (x0 + x1) * 0.5;
        if (openingCovers(openings, cx, x1 - x0, y0, y0 + ch)) continue;
        const back = r() * 0.03;
        parts.push(xform(box((x1 - x0) * 0.99, ch * 0.97, t * 1.35 - back, 0.024, 1),
          { pos: [cx, y0 + ch * 0.5, -back * 0.5] }));
      }
    }
    A.add('ashlar', mergeParts(parts));
    // a chamfered string course under the wall plate
    A.add('ashlar', box(w * 1.01, 0.09, t * 1.6, 0.02), { pos: [0, h - 0.05, 0.02] });
    carveOpenings(A, { ...o, wallT: t * 1.35, faceZ: t * 0.68 });
    return;
  }

  const halfW = w * 0.5;
  const faceZ = 0;                       // frame centreline
  const dep = t;                          // frame depth

  /* --- sill + wall plate --- */
  if (!noSill) A.add(timber, beam(w, t * 1.12, dep * 1.05, { seed: seed + 1, seg: 1, bow: 0.006 }), { euler: [0, 0, PI * 0.5], pos: [0, t * 0.56, faceZ] });
  A.add(timber, beam(w, t * 1.2, dep * 1.1, { seed: seed + 2, seg: 1, bow: 0.008 }), { euler: [0, 0, PI * 0.5], pos: [0, h - t * 0.6, faceZ] });

  /* --- posts --- */
  const nBays = Math.max(2, Math.round(w / 1.15));
  const bayW = w / nBays;
  const postX = [];
  for (let i = 0; i <= nBays; i++) postX.push(-halfW + bayW * i);
  for (let i = 0; i < postX.length; i++) {
    const corner = i === 0 || i === postX.length - 1;
    const pw = corner ? t * 1.28 : t * 0.86;
    A.add(timber, beam(h, pw, dep * (corner ? 1.14 : 0.95), { seed: seed + 10 + i, seg: 1 }),
      { pos: [postX[i], h * 0.5, faceZ] });
  }

  /* --- diagonal braces in the end bays: the signature of box framing --- */
  for (const side of [-1, 1]) {
    if (r() > brace) continue;
    const x0 = side * (halfW - bayW * 0.5);
    const len = Math.hypot(bayW, h * 0.62);
    const ang = Math.atan2(h * 0.62, bayW) * side;
    A.add(timber, beam(len * 0.98, t * 0.72, dep * 0.8, { seed: seed + 30 + side, seg: 1 }),
      { euler: [0, 0, PI * 0.5 - ang], pos: [x0, h * 0.34, faceZ - dep * 0.06] });
  }

  /* --- mid rail on tall walls --- */
  const midY = h * 0.52;
  const hasMid = h > 2.6 && r() > 0.35;
  if (hasMid) {
    A.add(timber, beam(w * 0.99, t * 0.78, dep * 0.86, { seed: seed + 5, seg: 1 }),
      { euler: [0, 0, PI * 0.5], pos: [0, midY, faceZ] });
  }

  /* --- infill panels, skipping anything an opening eats --- */
  const rows = hasMid
    ? [[t * 1.1, midY - t * 0.4], [midY + t * 0.4, h - t * 1.1]]
    : [[t * 1.1, h - t * 1.1]];
  for (let i = 0; i < nBays; i++) {
    const cx = -halfW + bayW * (i + 0.5);
    for (const [y0, y1] of rows) {
      if (y1 - y0 < 0.2) continue;
      if (openingCovers(openings, cx, bayW, y0, y1)) continue;
      const pw = bayW - t * 0.92;
      const ph = y1 - y0;
      A.add(plaster, infillPanel(pw, ph, dep * 0.72, {
        seed: seed + 60 + i * 3 + (y0 * 7 | 0), bulge: 0.018 + r() * 0.010, segX: 2, segY: 2,
      }), { pos: [cx, (y0 + y1) * 0.5, faceZ - dep * 0.06] });
    }
  }

  carveOpenings(A, { ...o, wallT: dep, faceZ: dep * 0.5 });
}

/** True if any opening overlaps the given bay/row rectangle. */
function openingCovers(openings, cx, bayW, y0, y1) {
  for (const op of openings) {
    const ox0 = op.x - op.w * 0.5 - 0.06, ox1 = op.x + op.w * 0.5 + 0.06;
    const oy0 = op.y0 - 0.06, oy1 = op.y0 + op.h + 0.06;
    if (ox1 > cx - bayW * 0.5 && ox0 < cx + bayW * 0.5 && oy1 > y0 && oy0 < y1) return true;
  }
  return false;
}

/** Windows, doors and open bays, plus their reveals, sills and shutters. */
function carveOpenings(A, o) {
  const { openings = [], seed = 1, faceZ = 0.08, wallT = 0.16, timber = 'timber' } = o;
  const r = mulberry(seed + 991);
  for (let i = 0; i < openings.length; i++) {
    const op = openings[i];
    const cy = op.y0 + op.h * 0.5;
    if (op.kind === 'open') {
      // an open bay (smithy, cart shed): just a lintel and a threshold
      A.add(timber, beam(op.w + 0.3, 0.19, wallT * 1.2, { seed: seed + i, seg: 1 }),
        { euler: [0, 0, PI * 0.5], pos: [op.x, op.y0 + op.h + 0.09, 0] });
      A.add('ashlar', box(op.w + 0.4, 0.11, wallT * 1.5, 0.018), { pos: [op.x, 0.05, 0] });
      continue;
    }
    if (op.kind === 'door') {
      const d = plankDoor(op.w * 0.94, op.h * 0.97, { seed: seed + i * 3, planks: 4 + ((r() * 2) | 0), straps: 2 });
      A.add('plank', d.wood, { pos: [op.x, cy, faceZ - 0.01] });
      A.add('iron', d.iron, { pos: [op.x, cy, faceZ - 0.01] });
      // frame + lintel + a worn stone step
      A.add(timber, beam(op.h, 0.11, wallT * 1.1, { seed: seed + i * 5, seg: 1 }), { pos: [op.x - op.w * 0.5 - 0.045, cy, 0] });
      A.add(timber, beam(op.h, 0.11, wallT * 1.1, { seed: seed + i * 6, seg: 1 }), { pos: [op.x + op.w * 0.5 + 0.045, cy, 0] });
      A.add(timber, beam(op.w + 0.24, 0.16, wallT * 1.15, { seed: seed + i * 7, seg: 1 }),
        { euler: [0, 0, PI * 0.5], pos: [op.x, op.y0 + op.h + 0.08, 0] });
      A.add('ashlar', box(op.w + 0.5, 0.10, wallT + 0.52, 0.022), { pos: [op.x, 0.045, faceZ + 0.2] });
      continue;
    }
    // window
    const win = leadedWindow(op.w, op.h, {
      bars: op.w > 0.8 ? 2 : 1, tiers: op.h > 1.0 ? 3 : 2, frame: 0.055, depth: wallT * 0.85, seed: seed + i,
    });
    A.add(timber, win.frame, { pos: [op.x, cy, faceZ - wallT * 0.32] });
    if (op.lit) {
      A.add('glow:window', win.glass, { pos: [op.x, cy, faceZ - wallT * 0.36] });
    } else {
      win.glass.dispose();
      // shutters closed over a dark window — cheaper than a second material and
      // it tells you which houses are asleep
      const sw = op.w * 0.5 - 0.01;
      for (const side of [-1, 1]) {
        const sh = board(op.h * 0.98, sw, 0.035, { seed: seed + i * 11 + side, cup: 0.1 });
        A.add('plank', xform(sh, { euler: [PI * 0.5, 0, 0] }), { pos: [op.x + side * sw * 0.5, cy, faceZ + 0.026] });
        A.add('iron', box(sw * 0.9, 0.036, 0.016, 0.006), { pos: [op.x + side * sw * 0.5, cy + op.h * 0.3, faceZ + 0.05] });
      }
    }
    // sill + a small pentice hood over the head
    A.add(timber, board(wallT + 0.2, op.w + 0.22, 0.06, { seed: seed + i * 13, cup: 0.05 }),
      { pos: [op.x, op.y0 - 0.035, faceZ + 0.03] });
    if (op.hood) {
      A.add('shingle', shingleRoof(op.w + 0.34, 0.28, { course: 0.14, shake: 0.2, step: 0.02, thick: 0.03, seed: seed + i }),
        { euler: [-0.7, 0, 0], pos: [op.x, op.y0 + op.h + 0.12, faceZ + 0.02] });
    }
    // open shutters flanking a lit window
    if (op.lit && op.shutters) {
      for (const side of [-1, 1]) {
        const sw = op.w * 0.46;
        const sh = board(op.h * 0.96, sw, 0.032, { seed: seed + i * 17 + side, cup: 0.08 });
        A.add('plank', xform(sh, { euler: [PI * 0.5, 0, 0] }),
          { euler: [0, side * -1.15, 0], pos: [op.x + side * (op.w * 0.5 + sw * 0.24), cy, faceZ + sw * 0.42] });
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * roof
 * ------------------------------------------------------------------ */

/**
 * Gabled roof over a `w` x `d` plan. The ridge runs along X. Returns the ridge
 * height above the eaves so the caller can place gables and a chimney.
 */
function gableRoof(A, {
  w, d, eaveY, pitch = 52, over = 0.42, overGable = 0.30, seed = 3, thick = 0.055,
  maxRise = 4.2,
}) {
  let th = pitch * PI / 180;
  const halfSpan = d * 0.5 + over;
  // A 55 deg pitch over a 7 m span puts the ridge five metres above the eaves,
  // which on a single-storey cottage reads as a roof with a house parked under
  // it. Clamp the rise and back-solve the pitch so the silhouette stays a
  // building.
  let rise = halfSpan * Math.tan(th);
  if (rise > maxRise) { rise = maxRise; th = Math.atan2(rise, halfSpan); }
  const run = halfSpan / Math.cos(th);
  const width = w + overGable * 2;
  const ridgeY = eaveY + rise;
  const pitchDeg = th * 180 / PI;

  for (const side of [-1, 1]) {
    const panel = shingleRoof(width, run, {
      course: 0.25, shake: 0.30, step: 0.030, thick, seed: seed + (side > 0 ? 17 : 0),
      overhangSide: 0.0, jitter: 0.22,
    });
    if (side < 0) A.add('shingle', panel, { euler: [-th, 0, 0], pos: [0, eaveY, -halfSpan] });
    else A.add('shingle', panel, { euler: [th, PI, 0], pos: [0, eaveY, halfSpan] });
  }

  /* ridge cap: a run of clay crestings, each one a squat lathe form */
  {
    const parts = [];
    const n = Math.max(3, Math.round(width / 0.42));
    for (let i = 0; i < n; i++) {
      const x = -width * 0.5 + (width / n) * (i + 0.5);
      const g = latheGeo([[0.001, 0], [0.085, 0.02], [0.10, 0.07], [0.075, 0.13], [0.03, 0.155]],
        { seg: 8, uTile: 1, seed: seed + i, lobeAmt: 0.012, capTop: true });
      parts.push(xform(g, { euler: [PI * 0.5, 0, 0], pos: [x, 0, 0] }));
    }
    parts.push(xform(box(width, 0.10, 0.20, 0.03), { pos: [0, -0.03, 0] }));
    A.add('shingle', mergeParts(parts), { pos: [0, ridgeY + 0.03, 0] });
  }

  /* barge boards along the rake, and an eaves fascia */
  const rakeLen = Math.hypot(halfSpan, rise);
  for (const gx of [-1, 1]) {
    for (const side of [-1, 1]) {
      const ang = Math.atan2(rise, halfSpan) * -side;
      A.add('plank', board(rakeLen * 1.02, 0.22, 0.05, { seed: seed + 40 + gx * 2 + side, cup: 0.06 }), {
        euler: [ang, PI * 0.5, 0],
        pos: [gx * (w * 0.5 + overGable), eaveY + rise * 0.5 + 0.02, side * halfSpan * 0.5],
      });
    }
    // a carved finial where the barge boards meet
    A.add('plank', box(0.13, 0.34, 0.11, 0.03), { pos: [gx * (w * 0.5 + overGable), ridgeY + 0.12, 0] });
  }
  for (const side of [-1, 1]) {
    A.add('plank', board(width * 1.0, 0.17, 0.045, { seed: seed + 50 + side, cup: 0.05 }),
      { euler: [0, PI * 0.5, 0], pos: [0, eaveY - 0.06, side * halfSpan] });
    // exposed rafter feet under the eaves — this is what makes an overhang read
    const nr = Math.max(4, Math.round(width / 0.62));
    const parts = [];
    for (let i = 0; i < nr; i++) {
      const x = -width * 0.5 + (width / (nr - 1)) * i;
      parts.push(xform(box(0.075, 0.10, over * 1.5, 0.014), { pos: [x, 0, 0] }));
    }
    A.add('timber', mergeParts(parts), { euler: [side * th * 0.55, 0, 0], pos: [0, eaveY + 0.03, side * (halfSpan - over * 0.62)] });
  }

  return { ridgeY, rise, halfSpan, th, pitchDeg };
}

/** Gable end wall: a framed triangle with infill and a loft opening. */
function gableEnd(A, { w, rise, seed = 5, t = 0.14, loft = false, plaster = 'plaster' }) {
  const halfW = w * 0.5;
  const r = mulberry(seed);
  // the two rake timbers
  const len = Math.hypot(halfW, rise);
  for (const side of [-1, 1]) {
    const ang = Math.atan2(rise, halfW) * side;
    A.add('timber', beam(len, t, t * 0.9, { seed: seed + side, seg: 1 }),
      { euler: [0, 0, PI * 0.5 - ang], pos: [side * halfW * 0.5, rise * 0.5, 0] });
  }
  // king post + two queen posts
  A.add('timber', beam(rise * 0.98, t * 0.9, t * 0.85, { seed: seed + 7, seg: 1 }), { pos: [0, rise * 0.49, 0] });
  for (const side of [-1, 1]) {
    const x = side * halfW * 0.48;
    const hh = rise * (1 - Math.abs(x) / halfW);
    A.add('timber', beam(hh * 0.96, t * 0.7, t * 0.7, { seed: seed + 9 + side, seg: 1 }), { pos: [x, hh * 0.48, 0] });
    // collar
    A.add('timber', beam(halfW * 0.52, t * 0.6, t * 0.6, { seed: seed + 11 + side, seg: 1 }),
      { euler: [0, 0, PI * 0.5], pos: [x * 0.5, hh * 0.62, 0] });
  }
  // infill: three triangle-ish strips, approximated by tapering boxes
  const strips = 4;
  for (let i = 0; i < strips; i++) {
    const y0 = (rise / strips) * i + t * 0.6;
    const y1 = (rise / strips) * (i + 1) - t * 0.4;
    if (y1 - y0 < 0.12) continue;
    const wAt = (y) => Math.max(0.1, w * (1 - y / rise) - t * 1.4);
    const wm = wAt((y0 + y1) * 0.5);
    A.add(plaster, infillPanel(wm, y1 - y0, t * 0.6, { seed: seed + 20 + i, bulge: 0.02, segX: 2, segY: 2 }),
      { pos: [0, (y0 + y1) * 0.5, -t * 0.08] });
  }
  if (loft) {
    // a hayloft hatch with a hoist beam poking out of it
    const lw = Math.min(0.95, w * 0.28), lh = 0.9;
    const y0 = rise * 0.18;
    const d = plankDoor(lw, lh, { seed: seed + 33, planks: 3, straps: 1 });
    A.add('plank', d.wood, { pos: [0, y0 + lh * 0.5, t * 0.42] });
    A.add('iron', d.iron, { pos: [0, y0 + lh * 0.5, t * 0.42] });
    A.add('timber', beam(0.95, 0.10, 0.10, { seed: seed + 34, seg: 1 }),
      { euler: [PI * 0.5, 0, 0], pos: [0, y0 + lh + 0.16, t * 0.42 + 0.42] });
    if (r() > 0.4) {
      A.add('iron', box(0.05, 0.28, 0.05, 0.012), { pos: [0, y0 + lh + 0.0, t * 0.42 + 0.78] });
    }
  }
}

/* ------------------------------------------------------------------ *
 * building
 * ------------------------------------------------------------------ */

/**
 * @param {object} B a plan entry from Layout.planTown()
 * @returns {{A: Assembler, lights: object[], smoke: object[], height: number}}
 *   `A` holds geometry in BUILDING-LOCAL space (origin on the ground at the
 *   footprint centre, +Z the front, y = 0 at `B.groundY`).
 */
export function buildHouse(B) {
  const A = new Assembler();
  const S = new Assembler();          // the superstructure — leans as one piece
  const r = mulberry(B.seed);
  const lights = [];
  const smoke = [];

  const W = B.width, D = B.depth;
  const role = B.role;
  const stoneGround = role === 'tower' || role === 'smithy' || r() < 0.35;
  const plankWalls = role === 'shed';

  /* ---------------- plinth ----------------
     Built as courses of rubble that step outward at the bottom, so the building
     sits ON the ground rather than intersecting it. `plinth` came from the
     terrain corner spread, so a building on a slope gets a taller one. */
  const pl = B.plinth;
  {
    const courses = 2 + ((r() * 2) | 0);
    let y = -0.34;                               // buried, so no gap can open up
    for (let i = 0; i < courses; i++) {
      const t = i / courses;
      const ch = (pl + 0.34) / courses;
      const grow = lerp(0.36, 0.10, t);
      A.add('ashlar', box(W + grow, ch * 1.02, D + grow, 0.03, 2), { pos: [0, y + ch * 0.5, 0] });
      y += ch;
    }
    // a chamfered plinth cap the frame sits on
    A.add('ashlar', box(W + 0.16, 0.10, D + 0.16, 0.028), { pos: [0, pl - 0.03, 0] });
    // a couple of loose stones spilled at the base, and a corner buttress
    for (let i = 0; i < 3; i++) {
      const a = r() * 6.283;
      A.add('ashlar', box(0.3 + r() * 0.2, 0.2 + r() * 0.12, 0.26 + r() * 0.18, 0.05),
        { rotY: r() * 3, pos: [Math.cos(a) * (W * 0.5 + 0.2), -0.02 + r() * 0.05, Math.sin(a) * (D * 0.5 + 0.2)] });
    }
  }

  /* ---------------- storeys ---------------- */
  const gh = B.storeyH[0];
  const uh = B.storeyH[1];
  const nUp = Math.max(0, B.storeys - 1);
  const jut = B.jut;

  /* ground storey openings */
  const doorX = (r() - 0.5) * (W * 0.34);
  const gOpen = [];
  if (role === 'smithy') {
    gOpen.push({ x: 0, w: W * 0.62, h: gh * 0.78, y0: 0, kind: 'open' });
  } else {
    gOpen.push({ x: doorX, w: 1.06, h: 2.4, y0: 0, kind: 'door' });   // doorway 2.4 m
    const nWin = W > 6.6 ? 2 : 1;
    for (let i = 0; i < nWin; i++) {
      const x = doorX + (i === 0 ? -1 : 1) * (1.05 + i * 1.5 + r() * 0.3) * (r() < 0.5 ? 1 : -1);
      if (Math.abs(x) > W * 0.5 - 0.9) continue;
      gOpen.push({
        x, w: role === 'shop' ? 1.32 : 1.0, h: role === 'shop' ? 1.22 : 1.05,
        y0: role === 'shop' ? 1.02 : 1.18, kind: 'window',
        // A dusk hub is lit from its windows: they are the only warm value in the
        // frame that is not a fire, and at 0.62 half the street front stayed shuttered.
        lit: r() < (role === 'shop' || role === 'inn' ? 0.95 : 0.8), shutters: true, hood: role === 'shop',
      });
    }
  }

  const face = (mat, o) => frameWall(S, { plaster: plankWalls ? 'plank' : 'plaster', ...o });

  const wallSpec = (wid, hgt, sd, opens, stone) => ({
    w: wid, h: hgt, t: 0.155, seed: sd, openings: opens, stone,
  });

  /* --- ground storey: four walls --- */
  {
    const y0 = pl;
    const s = new Assembler();
    // front (+Z)
    frameWall(s, { ...wallSpec(W, gh, B.seed + 1, gOpen, stoneGround), plaster: plankWalls ? 'plank' : 'plaster' });
    S.absorb(s, { pos: [0, y0, D * 0.5 - 0.075] });

    const bOpen = r() < 0.5 ? [{ x: (r() - 0.5) * W * 0.4, w: 0.86, h: 0.9, y0: 1.4, kind: 'window', lit: r() < 0.58 }] : [];
    const s2 = new Assembler();
    frameWall(s2, { ...wallSpec(W, gh, B.seed + 2, bOpen, stoneGround), plaster: plankWalls ? 'plank' : 'plaster' });
    S.absorb(s2, { euler: [0, PI, 0], pos: [0, y0, -D * 0.5 + 0.075] });

    for (const side of [-1, 1]) {
      const sOpen = r() < 0.55
        ? [{ x: (r() - 0.5) * D * 0.3, w: 0.9, h: 1.0, y0: 1.25, kind: 'window', lit: r() < 0.72, shutters: true }]
        : [];
      const s3 = new Assembler();
      frameWall(s3, { ...wallSpec(D, gh, B.seed + 3 + side, sOpen, stoneGround), plaster: plankWalls ? 'plank' : 'plaster' });
      S.absorb(s3, { euler: [0, side * PI * 0.5, 0], pos: [side * (W * 0.5 - 0.075), y0, 0] });
    }
    void face;
  }

  /* --- the jetty and the upper storeys --- */
  let topY = pl + gh;
  let uW = W, uD = D;
  for (let st = 0; st < nUp; st++) {
    const oversail = st === 0 ? jut : jut * 0.5;
    uW = W + oversail * 2 * (st === 0 ? 0.55 : 0.3);
    uD = D + oversail * 2;
    if (oversail > 0.02) {
      /* the jetty: a bressummer beam across the front, carried on carved corbels */
      S.add('timber', beam(uW + 0.1, 0.26, 0.20, { seed: B.seed + 70, seg: 1 }),
        { euler: [0, 0, PI * 0.5], pos: [0, topY + 0.12, uD * 0.5 - 0.1] });
      S.add('timber', beam(uW + 0.1, 0.22, 0.18, { seed: B.seed + 71, seg: 1 }),
        { euler: [0, 0, PI * 0.5], pos: [0, topY + 0.11, -uD * 0.5 + 0.1] });
      for (const side of [-1, 1]) {
        S.add('timber', beam(uD + 0.1, 0.22, 0.18, { seed: B.seed + 72 + side, seg: 1 }),
          { euler: [PI * 0.5, 0, 0], pos: [side * (uW * 0.5 - 0.09), topY + 0.11, 0] });
      }
      const nc = Math.max(2, Math.round(W / 1.7));
      for (let i = 0; i < nc; i++) {
        const x = -W * 0.5 + (W / (nc - 1 || 1)) * i;
        for (const zs of [-1, 1]) {
          // a bracket: an angled strut with a chamfered shoulder
          const L = Math.hypot(oversail + 0.16, 0.52);
          S.add('timber', beam(L, 0.115, 0.115, { seed: B.seed + 80 + i * 2 + zs, seg: 1 }),
            { euler: [zs * -Math.atan2(oversail + 0.16, 0.52), 0, 0], pos: [x, topY - 0.24, zs * (D * 0.5 - 0.03 + (oversail + 0.16) * 0.42)] });
        }
      }
    }

    const uOpen = [];
    const nWin = uW > 6.2 ? 3 : 2;
    for (let i = 0; i < nWin; i++) {
      const x = -uW * 0.5 + (uW / nWin) * (i + 0.5);
      uOpen.push({
        x, w: 0.94, h: 1.14, y0: 0.85, kind: 'window',
        lit: r() < 0.74, shutters: r() < 0.6,
      });
    }
    const sf = new Assembler();
    frameWall(sf, { w: uW, h: uh, t: 0.145, seed: B.seed + 100 + st, openings: uOpen, plaster: plankWalls ? 'plank' : 'plaster', noSill: false });
    S.absorb(sf, { pos: [0, topY + 0.2, uD * 0.5 - 0.07] });

    const bOpen = [{ x: (r() - 0.5) * uW * 0.3, w: 0.8, h: 0.9, y0: 1.0, kind: 'window', lit: r() < 0.35 }];
    const sb = new Assembler();
    frameWall(sb, { w: uW, h: uh, t: 0.145, seed: B.seed + 110 + st, openings: bOpen, plaster: plankWalls ? 'plank' : 'plaster' });
    S.absorb(sb, { euler: [0, PI, 0], pos: [0, topY + 0.2, -uD * 0.5 + 0.07] });

    for (const side of [-1, 1]) {
      const sOpen = r() < 0.6 ? [{ x: (r() - 0.5) * uD * 0.28, w: 0.82, h: 0.95, y0: 0.95, kind: 'window', lit: r() < 0.5 }] : [];
      const ss = new Assembler();
      frameWall(ss, { w: uD, h: uh, t: 0.145, seed: B.seed + 120 + st * 3 + side, openings: sOpen, plaster: plankWalls ? 'plank' : 'plaster' });
      S.absorb(ss, { euler: [0, side * PI * 0.5, 0], pos: [side * (uW * 0.5 - 0.07), topY + 0.2, 0] });
    }
    topY += uh + 0.2;
  }

  /* ---------------- roof ---------------- */
  let ridge = null;
  if (plankWalls) {
    /* lean-to: a single pitch falling to the back */
    const th = 26 * PI / 180;
    const run = (uD + 0.7) / Math.cos(th);
    S.add('shingle', shingleRoof(uW + 0.5, run, { course: 0.25, shake: 0.3, step: 0.03, thick: 0.05, seed: B.seed + 9 }),
      { euler: [-th, 0, 0], pos: [0, topY + 0.04, -uD * 0.5 - 0.35] });
    S.add('plank', board(uW + 0.5, 0.16, 0.045, { seed: B.seed + 10, cup: 0.05 }),
      { euler: [0, PI * 0.5, 0], pos: [0, topY - 0.02, -uD * 0.5 - 0.35] });
    ridge = { ridgeY: topY + (uD + 0.7) * Math.tan(th), rise: (uD + 0.7) * Math.tan(th), halfSpan: uD * 0.5 + 0.35, th };
  } else {
    ridge = gableRoof(S, {
      w: uW, d: uD, eaveY: topY, pitch: B.pitch, over: 0.40 + r() * 0.16,
      overGable: 0.26 + r() * 0.12, seed: B.seed + 200,
      maxRise: B.storeys >= 2 ? 4.0 : 2.9,
    });
    // gable ends
    for (const side of [-1, 1]) {
      const ge = new Assembler();
      gableEnd(ge, {
        w: uD, rise: ridge.rise * (uD * 0.5) / ridge.halfSpan, seed: B.seed + 300 + side,
        loft: B.attic && side > 0, plaster: plankWalls ? 'plank' : 'plaster',
      });
      S.absorb(ge, { euler: [0, side * PI * 0.5, 0], pos: [side * (uW * 0.5 - 0.06), topY, 0] });
    }
    // a dormer on the taller houses — breaks the roof line
    if (B.attic && B.storeys >= 2 && r() < 0.55) {
      const dW = 1.15, dH = 1.0;
      const dz = uD * 0.5 * 0.45;
      const dy = topY + ridge.rise * (1 - (dz / ridge.halfSpan)) * 0.55;
      const dm = new Assembler();
      frameWall(dm, {
        w: dW, h: dH, t: 0.10, seed: B.seed + 400,
        openings: [{ x: 0, w: 0.66, h: 0.72, y0: 0.16, kind: 'window', lit: r() < 0.7 }],
      });
      dm.add('shingle', shingleRoof(dW + 0.3, 0.62, { course: 0.2, shake: 0.24, step: 0.024, thick: 0.04, seed: B.seed + 401 }),
        { euler: [-0.75, 0, 0], pos: [0, dH + 0.02, -0.1] });
      dm.add('shingle', shingleRoof(dW + 0.3, 0.62, { course: 0.2, shake: 0.24, step: 0.024, thick: 0.04, seed: B.seed + 402 }),
        { euler: [0.75, PI, 0], pos: [0, dH + 0.02, 0.42] });
      S.absorb(dm, { pos: [(r() - 0.5) * uW * 0.4, dy, dz] });
    }
  }

  /* ---------------- chimney ---------------- */
  {
    const cx = (r() < 0.5 ? -1 : 1) * (uW * 0.5 - 0.45);
    const cz = (r() - 0.5) * uD * 0.35;
    const base = topY - 0.4;
    const top = ridge.ridgeY + 0.85 + r() * 0.5;
    const hgt = top - base;
    S.add('ashlar', chimneyGeo(hgt, { w: 0.66, d: 0.56, seed: B.seed + 500 }), { pos: [cx, base + hgt * 0.5, cz] });
    smoke.push({ x: cx, y: top + 0.12, z: cz, r: 0.3 });
  }

  /* ---------------- role dressing ---------------- */
  if (role === 'shop' || role === 'inn') {
    const len = role === 'inn' ? 1.35 : 1.05;
    const sg = shopSign(len, { boardW: role === 'inn' ? 0.78 : 0.58, boardH: role === 'inn' ? 0.62 : 0.46, seed: B.seed + 600 });
    const sy = pl + gh - 0.55;
    const sx = doorX + (doorX > 0 ? -1 : 1) * 1.0;
    S.add('iron', sg.iron, { euler: [0, 0, 0], pos: [sx, sy, D * 0.5 + 0.06] });
    S.add('plank', sg.wood, { pos: [sx, sy, D * 0.5 + 0.06] });
    // a lamp bracket by the door, and the lamp itself glows
    const lx = doorX + (doorX > 0 ? 1 : -1) * 0.85;
    S.add('iron', box(0.42, 0.035, 0.035, 0.008), { pos: [lx + 0.19, pl + 2.55, D * 0.5 + 0.16] });
    S.add('iron', box(0.14, 0.20, 0.14, 0.02), { pos: [lx + 0.38, pl + 2.42, D * 0.5 + 0.16] });
    S.add('glow:lamp', box(0.105, 0.15, 0.105, 0.02), { pos: [lx + 0.38, pl + 2.42, D * 0.5 + 0.16] });
    lights.push({
      kind: 'lamp', x: lx + 0.38, y: pl + 2.42, z: D * 0.5 + 0.16,
      color: 0xffa348, intensity: 8.4, radius: 9.5, flicker: 0.35, priority: 1.35,
    });
    // a shuttered shop counter under the window
    S.add('plank', board(1.5, 0.5, 0.06, { seed: B.seed + 610, cup: 0.06 }),
      { euler: [0, PI * 0.5, -0.06], pos: [doorX - 1.5, pl + 1.0, D * 0.5 + 0.34] });
    S.add('timber', beam(0.95, 0.07, 0.07, { seed: B.seed + 611, seg: 1 }),
      { euler: [0, 0, 0.35], pos: [doorX - 2.1, pl + 0.5, D * 0.5 + 0.3] });
  }

  if (role === 'smithy') {
    /* the forge: a stone hearth with glowing coals under a hood, set back inside
       the open bay so the glow spills out onto the road */
    const fz = -D * 0.18;
    S.add('ashlar', box(1.5, 0.82, 1.0, 0.04, 2), { pos: [0, pl + 0.41, fz] });
    S.add('ashlar', box(1.62, 0.10, 1.12, 0.03), { pos: [0, pl + 0.84, fz] });
    // coal bed
    const coals = [];
    for (let i = 0; i < 12; i++) {
      const a = r() * 6.283, rr = r() * 0.34;
      coals.push(xform(box(0.09 + r() * 0.07, 0.05 + r() * 0.04, 0.09 + r() * 0.06, 0.02),
        { rotY: r() * 3, pos: [Math.cos(a) * rr, r() * 0.03, Math.sin(a) * rr] }));
    }
    S.add('glow:forge', mergeParts(coals), { pos: [0, pl + 0.90, fz] });
    // hood + flue
    S.add('iron', box(1.3, 0.5, 0.9, 0.03), { pos: [0, pl + 2.05, fz] });
    for (const sx of [-0.55, 0.55]) {
      S.add('iron', box(0.06, 1.2, 0.06, 0.014), { pos: [sx, pl + 1.45, fz - 0.4] });
    }
    // bellows
    S.add('plank', box(0.5, 0.24, 0.8, 0.05), { euler: [0, 0, 0.12], pos: [-0.95, pl + 0.62, fz - 0.1] });
    S.add('iron', box(0.05, 0.05, 0.7, 0.012), { pos: [-0.62, pl + 0.72, fz + 0.34] });
    // a rack of stock iron and a quench barrel
    for (let i = 0; i < 5; i++) {
      S.add('iron', box(0.035, 1.5 + r() * 0.5, 0.035, 0.01),
        { euler: [0, 0, (r() - 0.5) * 0.2], pos: [0.9 + i * 0.06, pl + 0.8, fz - 0.45 + i * 0.04] });
    }
    lights.push({
      kind: 'forge', x: 0, y: pl + 1.0, z: fz,
      color: 0xff7a22, intensity: 27, radius: 14, flicker: 0.55, priority: 2.9, shadow: false,
    });
    smoke.push({ x: 0, y: pl + 2.5, z: fz, r: 0.34, warm: true });
  }

  /* a few crates / a bench against the wall — buildings should not meet the
     ground as a clean line anywhere */
  {
    const n = 1 + ((r() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const a = r() * 6.283;
      const px = Math.cos(a) * (W * 0.5 + 0.28), pz = Math.sin(a) * (D * 0.5 + 0.28);
      if (r() < 0.5) {
        A.add('plank', box(0.5 + r() * 0.18, 0.46, 0.44 + r() * 0.16, 0.02),
          { rotY: r() * 3, pos: [px, pl * 0.2 + 0.23, pz] });
      } else {
        A.add('timber', beam(1.1 + r() * 0.4, 0.12, 0.12, { seed: B.seed + 700 + i, seg: 1 }),
          { euler: [0, r() * 3, PI * 0.5], pos: [px, pl * 0.2 + 0.42, pz] });
        A.add('timber', beam(0.42, 0.09, 0.09, { seed: B.seed + 710 + i, seg: 1 }), { pos: [px, pl * 0.2 + 0.21, pz] });
      }
    }
  }

  /* ---------------- settle the whole superstructure ---------------- */
  A.absorb(S, { euler: [B.lean2, 0, B.lean], pos: [0, 0, 0] });

  return { A, lights, smoke, height: ridge ? ridge.ridgeY : topY, top: topY };
}

/* ------------------------------------------------------------------ *
 * local deterministic PRNG (mulberry32) — Rand.js's makeRand, inlined so a
 * geometry builder never needs the engine handle.
 * ------------------------------------------------------------------ */
function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { mulberry, frameWall, gableRoof, gableEnd };
void THREE; void clamp01;
