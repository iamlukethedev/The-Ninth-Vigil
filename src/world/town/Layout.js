/**
 * THE NINTH VIGIL — Town layout.
 *
 * Procedural, but *composed*. A settlement scattered by a Poisson dart throw
 * reads as noise; a real waypoint town reads as a plaza with a road out to a
 * gate, buildings crowding the road, and a shrine as the thing you walk toward.
 * So the plot table below is authored in a frame aligned to the shot — `u` runs
 * away from the camera into the frame, `w` runs screen-right — and then rotated
 * into world space from the scenario's own camera yaw. The jitter, the
 * per-building dimensions, the lean, the roof pitch, the sign and the window
 * pattern are all seeded random; the *composition* is not, because composition
 * is the one thing a dart throw cannot do.
 *
 * The framing this is cut to: pitch 52 deg, dist 28-30, fov 42. That is not a
 * free choice — it fixes exactly where a 7 m gatehouse can stand and still fit
 * in shot. The lens sits 26.5 m up, so the ground band runs from u = -10 (bottom
 * edge) to u = +26 (top edge), and anything taller than about 5 m past u = +16
 * has its head cut off. Hence: the plaza at the origin, the gate at u = 13 where
 * its towers land fully inside the frame, the shrine at u = 7 balancing it on the
 * other side of centre, mid-ground buildings walling the street at |w| = 10-14,
 * and two big near buildings deliberately cropped in the bottom corners to open
 * up a foreground plane.
 */

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * authored plan, in shot-aligned (u, w) metres
 * ------------------------------------------------------------------ */

/**
 * `role` drives dressing: 'house' plain dwelling, 'shop' gets a sign and a
 * shuttered counter, 'smithy' gets the forge, 'inn' is the big one with the
 * biggest sign, 'tower' is the tall stone one that carries the skyline,
 * 'shed' is a lean-to outbuilding.
 */
const PLOTS = [
  // Foreground plane: big, near, cropped by the bottom corners. They occupy only
  // the outer sixth of the frame and exist to give the shot a proscenium.
  { u: -9.5, w: -17.4, yaw: 108, w0: 8.2, d0: 6.6, storeys: 2, attic: true, role: 'inn', jut: 0.55 },
  { u: -8.0, w: 18.2, yaw: -98, w0: 7.4, d0: 6.2, storeys: 2, attic: true, role: 'house', jut: 0.50 },
  // Mid ground: the street walls flanking the plaza, cropped by the frame sides.
  { u: -2.5, w: -13.6, yaw: 92, w0: 7.0, d0: 5.8, storeys: 2, attic: true, role: 'shop', jut: 0.42 },
  { u: -1.5, w: 13.4, yaw: -84, w0: 6.8, d0: 5.6, storeys: 2, attic: true, role: 'shop', jut: 0.40 },
  // The smithy stands right on the plaza so its forge throws a hot pool onto the
  // paving: the frame needs one saturated warm source low in shot.
  { u: 5.4, w: 10.6, yaw: -58, w0: 6.4, d0: 6.0, storeys: 1, attic: true, role: 'smithy', jut: 0.0 },
  // Single storey, deliberately. At two storeys plus an attic this roof rises to
  // 9.4 m and — sitting only 2 m past the plaza centre, i.e. close to the lens —
  // its silhouette covered the whole gatehouse standing 7 m behind it. The gate is
  // the frame's second focal point; a cottage does not get to sit in front of it.
  { u: 3.0, w: -10.2, yaw: 74, w0: 6.4, d0: 5.4, storeys: 1, attic: true, role: 'tower', jut: 0.30 },
  // Beyond the wall: the silhouette layer, hazed by aerial perspective. Their
  // roofs are what stops the wall reading as the edge of the world — but at
  // (u 19, w -9.4) and (u 18.6, w 6.6) they landed dead on top of the gatehouse
  // and the north curtain, both of which project into the top 160 px of the
  // frame, so the wall and the gate were completely hidden behind them. Held out
  // to the sides and down to a single storey: they still close the horizon, they
  // no longer eat the second focal point.
  { u: 15.2, w: -19.4, yaw: 52, w0: 6.4, d0: 5.2, storeys: 1, attic: true, role: 'house', jut: 0.30 },
  { u: 18.4, w: 6.4, yaw: -50, w0: 6.0, d0: 5.0, storeys: 1, attic: true, role: 'house', jut: 0.32 },
  { u: 14.0, w: 15.2, yaw: -62, w0: 5.6, d0: 4.6, storeys: 1, attic: true, role: 'shed', jut: 0.0 },
  { u: 2.0, w: 17.6, yaw: -74, w0: 5.2, d0: 4.4, storeys: 1, attic: false, role: 'shed', jut: 0.0 },
];

/** The curtain wall, as a shot-aligned polyline. The gate sits on segment 2. */
const WALL_PATH = [
  [-2.6, -15.8], [4.2, -14.2], [9.4, -10.2], [13.2, -4.6],
  [14.2, 1.8], [12.4, 8.4], [7.8, 14.0], [1.0, 17.2],
];
/**
 * Index of the wall vertex the gatehouse is centred on.
 *
 * Vertex 3 (u 13.2) sits 4 m from the top edge of the frame: its 7.2 m towers and
 * their merlons projected to y = -40, i.e. entirely above the picture, and all the
 * viewer got was a slab of ashlar with no arch. Vertex 2 (u 9.4, w -10.2) lands at
 * roughly (410, 180) with the tower tops at y = 55 — the whole gatehouse, arch,
 * gallery and parapet inside the frame — and it puts the gate left of centre
 * against the shrine right of centre, which is the composition this was after.
 */
const GATE_AT = 2;

/** Market stalls. `span` is the awning width, `goods` picks the hanging clutter. */
const STALLS = [
  { u: 2.4, w: 5.4, yaw: -150, span: 3.0, depth: 2.0, goods: 'cloth' },
  { u: 4.2, w: 1.4, yaw: -172, span: 2.6, depth: 1.9, goods: 'pots' },
  { u: -3.4, w: 4.6, yaw: -34, span: 2.8, depth: 1.9, goods: 'meat' },
  { u: -1.2, w: -6.4, yaw: 44, span: 2.6, depth: 1.8, goods: 'grain' },
  { u: 2.2, w: -7.6, yaw: 122, span: 3.0, depth: 2.0, goods: 'cloth' },
];

/** Roads, shot-aligned, width in metres. First entry is the gate road. */
const ROADS = [
  { pts: [[0, 0], [3.2, -3.5], [6.4, -7.1], [9.4, -10.4], [11.8, -13.2]], w: 4.8, wear: 1.0 },
  { pts: [[-9.5, -15.5], [-4.5, -7.5], [0, 0], [5.0, 7.5], [9.0, 13.0]], w: 4.0, wear: 0.85 },
  { pts: [[0, 0], [6.5, 4.6], [10.5, 8.6], [13.5, 13.0]], w: 3.2, wear: 0.6 },
  { pts: [[-1.0, 1.0], [-4.5, 8.0], [-6.0, 13.0]], w: 2.8, wear: 0.5 },
];

/** Lantern posts (fixture + a warm practical). */
const LANTERNS = [
  { u: 3.2, w: -3.2 }, { u: -4.6, w: 2.6 }, { u: 7.6, w: -3.6 },
  { u: 11.4, w: -4.6 }, { u: 1.2, w: 6.2 }, { u: -6.4, w: -6.0 },
  { u: 7.4, w: 5.8 },
  // Near plane, screen left and right of the watch fire. These were originally a
  // Props `post` fixture and a second `brazier`, but Props' town dressing fills
  // its own instance pools first and both came back as a flame with no body — so
  // they are authored as town geometry, which is free (they merge into the same
  // two buffers as the other seven) and cannot fail.
  { u: -6.2, w: -11.4 }, { u: 8.8, w: 2.2 }, { u: -4.4, w: 8.0 },
];

/**
 * Foreground practicals, realised through `Props.placeFixture()` so the fire and
 * its fixture are the dressing module's own (one shared flame material, one
 * shared instance pool — they cost the town nothing).
 *
 * These exist for one reason: the near plane. The lens sits at u = -18.5, so the
 * bottom third of the frame is the ground band from u = -10 to u = -4, and the
 * authored plan put nothing luminous there — measured, that band was solid black
 * and the frame had no foreground at all. A watch fire in the middle of it and a
 * lantern each side give the composition its near layer and something for the two
 * cropped corner buildings to be rim-lit against.
 */
const FIRES = [
  // One entry only. A second (a coal brazier at u -4.6, w 7.8) placed fine in `hub`
  // but came back bodiless in `inventory`, because Props fills its own pools first
  // and how much room is left depends on the scenario's dressing density. A
  // foreground light that exists in one frame and not the next is worse than one
  // that is always authored as town geometry, so the brazier became a lantern post
  // above and the campfire — whose logs, stones and fire are worth borrowing —
  // stays.
  { kind: 'campfire', u: -5.4, w: -4.6, y: 0.62, color: 0xff8a34, i: 17, r: 14, pr: 3.0, fl: 0.85 },
];

/* ------------------------------------------------------------------ *
 * plan
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   yaw    scenario camera yaw in degrees (the shot the town is composed for)
 *   rand   deterministic PRNG
 *   probe  {heightAt, slopeAt} terrain sampler
 */
export function planTown({ yaw = 35, rand, probe }) {
  const Y = yaw * DEG;
  // Ground-plane forward from the camera toward the focus, and screen-right.
  // CameraRig places the lens at focus + (sinY, ., cosY) * horiz, so the view
  // travels along (-sinY, ., -cosY).
  const f = [-Math.sin(Y), -Math.cos(Y)];
  const s = [-f[1], f[0]];
  const toWorld = (u, w) => [u * f[0] + w * s[0], u * f[1] + w * s[1]];
  const H = (x, z) => {
    const y = probe?.heightAt?.(x, z);
    return Number.isFinite(y) ? y : 0;
  };

  const plan = { basis: { f, s }, toWorld, buildings: [], wall: null, roads: [], stalls: [], lanterns: [], props: [], npcs: [], fires: [] };

  /* ---------------- buildings ---------------- */
  for (let i = 0; i < PLOTS.length; i++) {
    const P = PLOTS[i];
    const r = rand.fork ? rand.fork(i + 1) : rand;
    // Small positional jitter so the authored plan does not read as a grid, but
    // never enough to break the composition it was cut for.
    const ju = (r() - 0.5) * 1.6;
    const jw = (r() - 0.5) * 1.6;
    const [x, z] = toWorld(P.u + ju, P.w + jw);
    // Building yaw is authored in the shot frame too, so a building's front
    // faces the street whichever way the world is rotated.
    const rotY = Math.atan2(f[0], f[1]) + (P.yaw + (r() - 0.5) * 10) * DEG;

    const width = P.w0 * (0.94 + r() * 0.14);
    const depth = P.d0 * (0.94 + r() * 0.14);
    // A storey is 3 m (KNOWN_ISSUES canonical scale); ground floors run taller.
    const ground = 3.05 + r() * 0.28;
    const upper = 2.82 + r() * 0.24;
    const pitch = 48 + r() * 12;            // steep — this is a wet, cold place
    const lean = (r() - 0.5) * 0.026;       // radians of settle, per axis
    const lean2 = (r() - 0.5) * 0.022;

    // foundation: sample the four corners so the plinth actually meets the
    // ground on a slope instead of hovering or burying a wall
    const hw = width * 0.5, hd = depth * 0.5;
    const ca = Math.cos(rotY), sa = Math.sin(rotY);
    let minY = Infinity, maxY = -Infinity;
    for (const [ox, oz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0]]) {
      const wx = x + ox * ca + oz * sa;
      const wz = z - ox * sa + oz * ca;
      const y = H(wx, wz);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minY)) { minY = 0; maxY = 0; }

    plan.buildings.push({
      id: i, x, z, rotY, width, depth,
      groundY: minY, plinth: Math.max(0.24, (maxY - minY) + 0.28),
      storeyH: [ground, upper], storeys: P.storeys, attic: !!P.attic,
      pitch, lean, lean2, role: P.role, jut: P.jut ?? 0,
      seed: 9001 + i * 137, u: P.u + ju, w: P.w + jw,
    });
  }

  /* ---------------- wall + gate ---------------- */
  {
    const pts = WALL_PATH.map(([u, w], k) => {
      const r = rand.fork ? rand.fork(200 + k) : rand;
      const ju = (r() - 0.5) * 1.1, jw = (r() - 0.5) * 1.1;
      const [x, z] = toWorld(u + ju, w + jw);
      return { x, z, y: H(x, z), u: u + ju, w: w + jw };
    });
    const g = pts[GATE_AT];
    const a = pts[GATE_AT - 1], b = pts[GATE_AT + 1];
    const gateYaw = Math.atan2(b.x - a.x, b.z - a.z);
    plan.wall = { pts, gate: { x: g.x, z: g.z, y: g.y, yaw: gateYaw, index: GATE_AT } };
  }

  /* ---------------- landmark ---------------- */
  {
    const r = rand.fork ? rand.fork(41) : rand;
    const [x, z] = toWorld(7.0 + (r() - 0.5) * 0.7, 3.2 + (r() - 0.5) * 0.7);
    plan.landmark = { x, z, y: H(x, z), rotY: Math.atan2(f[0], f[1]) + (r() - 0.5) * 0.5, seed: 7717 };
  }

  /* ---------------- streets ---------------- */
  for (let i = 0; i < ROADS.length; i++) {
    const R = ROADS[i];
    plan.roads.push({
      pts: R.pts.map(([u, w]) => toWorld(u, w)),
      width: R.w, wear: R.wear, seed: 3300 + i * 71,
    });
  }
  plan.plaza = { x: 0, z: 0, r: 7.4 };

  /* ---------------- market ---------------- */
  for (let i = 0; i < STALLS.length; i++) {
    const S = STALLS[i];
    const r = rand.fork ? rand.fork(300 + i) : rand;
    const [x, z] = toWorld(S.u + (r() - 0.5) * 0.7, S.w + (r() - 0.5) * 0.7);
    plan.stalls.push({
      x, z, y: H(x, z),
      rotY: Math.atan2(f[0], f[1]) + (S.yaw + (r() - 0.5) * 14) * DEG,
      span: S.span * (0.94 + r() * 0.13), depth: S.depth * (0.95 + r() * 0.12),
      goods: S.goods, seed: 5100 + i * 53,
    });
  }
  {
    const put = (key, u, w, extra = {}) => {
      const [x, z] = toWorld(u, w);
      plan.props.push({ key, x, z, y: H(x, z), ...extra });
    };
    put('well', -5.2, -2.6, { rotY: Math.atan2(f[0], f[1]) + 0.4, seed: 6101 });
    put('notice', 2.4, -5.4, { rotY: Math.atan2(f[0], f[1]) + 2.5, seed: 6203 });
    put('trough', -2.6, -4.6, { rotY: Math.atan2(f[0], f[1]) + 1.1, seed: 6307 });
    put('cartload', 5.2, -6.4, { rotY: Math.atan2(f[0], f[1]) - 0.7, seed: 6411 });
    put('woodstack', -6.4, 6.2, { rotY: Math.atan2(f[0], f[1]) + 0.2, seed: 6521 });
    /*
     * Plaza dressing. Measured on the frame, the band from screen (650, 380) to
     * (900, 620) — dead centre, immediately around the hero — was bare paving for
     * a quarter of the picture. A market square is the most cluttered ground in a
     * settlement: a delivery cart still half unloaded, cordwood stacked against
     * the kerb, and a horse trough on the far side of the crossing.
     */
    put('cartload', -1.8, 1.9, { rotY: Math.atan2(f[0], f[1]) + 1.9, seed: 6613 });
    put('woodstack', -3.9, 3.4, { rotY: Math.atan2(f[0], f[1]) - 1.2, seed: 6719 });
    put('trough', 5.6, -1.6, { rotY: Math.atan2(f[0], f[1]) + 2.9, seed: 6823 });
    put('notice', -4.2, -8.4, { rotY: Math.atan2(f[0], f[1]) - 0.4, seed: 6929 });
  }

  /* ---------------- lantern posts ---------------- */
  for (let i = 0; i < LANTERNS.length; i++) {
    const L = LANTERNS[i];
    const r = rand.fork ? rand.fork(400 + i) : rand;
    const [x, z] = toWorld(L.u + (r() - 0.5) * 0.6, L.w + (r() - 0.5) * 0.6);
    plan.lanterns.push({ x, z, y: H(x, z), rotY: r() * 6.283, seed: 4400 + i * 31, h: 3.1 + r() * 0.5 });
  }

  /* ---------------- foreground fires ---------------- */
  for (let i = 0; i < FIRES.length; i++) {
    const F = FIRES[i];
    const r = rand.fork ? rand.fork(500 + i) : rand;
    const [x, z] = toWorld(F.u + (r() - 0.5) * 0.5, F.w + (r() - 0.5) * 0.5);
    plan.fires.push({ ...F, x, z, ground: H(x, z), rotY: r() * 6.283, seed: 4900 + i * 37 });
  }

  /* ---------------- NPC posts ----------------
     Placed against the fiction, not sprinkled: the smith at his anvil, the
     merchant behind his stall, the guard on the gate road, a beggar at the well,
     the priest at the shrine, two villagers talking, two on the road. */
  {
    const smithy = plan.buildings.find((b) => b.role === 'smithy');
    const npc = (kind, u, w, extra = {}) => {
      const [x, z] = toWorld(u, w);
      plan.npcs.push({ kind, x, z, y: H(x, z), ...extra });
    };
    const faceTo = (ax, az, bx, bz) => Math.atan2(bx - ax, bz - az);
    if (smithy) {
      // the smith stands at his anvil, on the plaza side of the forge
      const ax = smithy.x - Math.sin(smithy.rotY) * (smithy.depth * 0.5 + 1.5);
      const az = smithy.z - Math.cos(smithy.rotY) * (smithy.depth * 0.5 + 1.5);
      plan.npcs.push({ kind: 'smith', x: ax, z: az, y: H(ax, az), yaw: smithy.rotY + Math.PI, anvil: true });
      plan.smithAnvil = { x: ax + Math.sin(smithy.rotY) * 0.95, z: az + Math.cos(smithy.rotY) * 0.95, y: H(ax, az), rotY: smithy.rotY };
    }
    const s0 = plan.stalls[0];
    if (s0) {
      const bx = s0.x - Math.sin(s0.rotY) * -1.05, bz = s0.z - Math.cos(s0.rotY) * -1.05;
      plan.npcs.push({ kind: 'merchant', x: bx, z: bz, y: H(bx, bz), yaw: s0.rotY + Math.PI });
    }
    const gate = plan.wall?.gate;
    if (gate) {
      const gx = gate.x - Math.sin(Math.atan2(f[0], f[1])) * 0, gz = gate.z;
      const [ix, iz] = toWorld(6.6, -7.4);
      plan.npcs.push({ kind: 'guard', x: ix, z: iz, y: H(ix, iz), yaw: faceTo(ix, iz, gx, gz), scan: true });
    }
    npc('beggar', -6.0, -4.0, { yaw: faceTo(...toWorld(-6.6, -2.6), 0, 0) });
    npc('priest', 4.9, 4.6, { yaw: faceTo(...toWorld(5.6, -4.4), plan.landmark.x, plan.landmark.z) });
    // a conversation pair, turned toward each other
    {
      const [ax, az] = toWorld(-1.6, 4.4);
      const [bx, bz] = toWorld(0.4, 5.6);
      plan.npcs.push({ kind: 'villager', x: ax, z: az, y: H(ax, az), yaw: faceTo(ax, az, bx, bz), talk: 1 });
      plan.npcs.push({ kind: 'villagerB', x: bx, z: bz, y: H(bx, bz), yaw: faceTo(bx, bz, ax, az), talk: 2 });
    }
    // two who walk the streets
    plan.npcs.push({
      kind: 'porter', ...(() => { const [x, z] = toWorld(3.0, -2.0); return { x, z, y: H(x, z) }; })(),
      yaw: 0, route: [[2.4, -1.0], [6.2, -2.0], [9.6, -3.0], [6.2, -2.0]].map(([u, w]) => toWorld(u, w)),
    });
    plan.npcs.push({
      kind: 'villager', ...(() => { const [x, z] = toWorld(-3.2, 1.4); return { x, z, y: H(x, z) }; })(),
      yaw: 2.2, route: [[-3.2, 1.4], [-5.6, 5.4], [-2.0, 7.2], [1.0, 3.4]].map(([u, w]) => toWorld(u, w)),
    });
  }

  return plan;
}

export { PLOTS, WALL_PATH, STALLS, ROADS, LANTERNS, FIRES, GATE_AT };
