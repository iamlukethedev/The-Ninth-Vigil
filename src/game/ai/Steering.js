/**
 * THE NINTH VIGIL — local avoidance (RVO / reciprocal velocity obstacles).
 *
 * Each agent hands us a *preferred* velocity from its brain; we return a
 * velocity that is as close to it as possible while not committing to a
 * collision. This is the sampling formulation of RVO2: build the candidate set,
 * score each candidate by
 *
 *      penalty = |v - vPref| + w / timeToCollision
 *
 * against the reciprocal velocity obstacle of every neighbour, and keep the
 * best. Reciprocity (each agent takes half the avoidance burden) is what makes
 * a pack part around the player instead of two agents ping-ponging.
 *
 * On top of that:
 *  - a static term sampled from the nav clearance field, so agents peel around
 *    corners rather than grinding along a wall,
 *  - a soft personal-space separation so a stationary pack never stacks,
 *  - a hard, symmetric depenetration pass after integration, which is the only
 *    way to *guarantee* no interpenetration on screen.
 *
 * Deterministic: the candidate set is a fixed table, neighbour iteration is in
 * agent registration order, and no PRNG is touched.
 */

const TAU = Math.PI * 2;

/* Candidate directions relative to the preferred velocity, in radians, ordered
 * so the first acceptable one is also the least deviation. */
const ANGLES = [0, 0.20, -0.20, 0.42, -0.42, 0.70, -0.70, 1.05, -1.05,
  1.48, -1.48, 1.95, -1.95, 2.50, -2.50, Math.PI];
const SPEEDS = [1.0, 0.72, 0.42];

export class Steering {
  constructor(engine, nav) {
    this.engine = engine;
    this.nav = nav;
    this.timeHorizon = 1.9;        // s — how far ahead we care about collisions
    this.obstacleHorizon = 0.9;
    this.maxNeighbours = 7;
    this.neighbourRange = 7.5;
    this.stats = { pairs: 0, samples: 0 };
    this._nb = [];                  // reused neighbour scratch
    for (let i = 0; i < 16; i++) this._nb.push({ dx: 0, dz: 0, d: 0, rr: 0, share: 0, vx: 0, vz: 0 });
    this._nbN = 0;
  }

  /* ================================================================ *
   * neighbours
   * ================================================================ */

  /**
   * Gather the nearest avoidance neighbours of `agent`.
   * O(n²) over the roster: at 30–60 agents that is 500–1800 squared-distance
   * tests per frame — cheaper than the bookkeeping a hash grid would need, and
   * exactly reproducible.
   */
  _gather(agent, agents, obstacles) {
    const px = agent.px, pz = agent.pz;
    const range = this.neighbourRange + agent.radius;
    const r2 = range * range;
    let n = 0;
    const list = this._nb;
    const maxN = this.maxNeighbours;

    for (let i = 0; i < agents.length; i++) {
      const o = agents[i];
      if (o === agent || !o.active || o.dead) continue;
      const dx = o.px - px, dz = o.pz - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      this.stats.pairs++;
      const d = Math.sqrt(d2);
      // Reciprocity share: how much of the correction the *neighbour* absorbs.
      // A committed attacker, a staggered body or a boss absorbs none, so we
      // take the whole burden and go around it.
      insert(list, n, maxN, dx, dz, d, agent.radius + o.radius, o.avoidShare, o.pvx, o.pvz);
      if (n < maxN) n++;
    }

    // Non-agent circular obstacles: the hero, and anything a module stamped in.
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o.ignore === agent) continue;
      const dx = o.x - px, dz = o.z - pz;
      const d2 = dx * dx + dz * dz;
      const rr = agent.radius + o.radius;
      if (d2 > (range + o.radius) * (range + o.radius)) continue;
      const d = Math.sqrt(d2);
      insert(list, n, maxN, dx, dz, d, rr, 0, o.vx ?? 0, o.vz ?? 0);
      if (n < maxN) n++;
    }

    this._nbN = Math.min(n, maxN);
    return this._nbN;
  }

  /* ================================================================ *
   * solve
   * ================================================================ */

  /**
   * Resolve `agent`'s preferred velocity into a safe one.
   * Writes the result to `agent.vx / agent.vz`.
   */
  resolve(agent, agents, obstacles, dt) {
    const maxSpeed = Math.max(0.05, agent.maxSpeed);
    let prefX = agent.prefX, prefZ = agent.prefZ;
    const prefLen = Math.hypot(prefX, prefZ);
    if (prefLen > maxSpeed) { const s = maxSpeed / prefLen; prefX *= s; prefZ *= s; }

    const n = this._gather(agent, agents, obstacles);

    /* ---- soft separation: personal space, applied to the preference ---- */
    let sepX = 0, sepZ = 0;
    for (let i = 0; i < n; i++) {
      const nb = this._nb[i];
      const want = nb.rr + agent.personalSpace;
      if (nb.d >= want || nb.d < 1e-5) continue;
      const push = (want - nb.d) / want;
      const inv = 1 / nb.d;
      sepX -= nb.dx * inv * push;
      sepZ -= nb.dz * inv * push;
    }
    if (sepX || sepZ) {
      const k = maxSpeed * 0.9;
      prefX += sepX * k;
      prefZ += sepZ * k;
      const l = Math.hypot(prefX, prefZ);
      if (l > maxSpeed) { const s = maxSpeed / l; prefX *= s; prefZ *= s; }
    }

    if (n === 0) {
      // No neighbours — only the static field can still veto the preference.
      const safe = this._slideStatic(agent, prefX, prefZ, maxSpeed);
      agent.vx = safe.x; agent.vz = safe.z;
      return;
    }

    /* ---- RVO candidate search ---- */
    const baseAng = prefLen > 1e-4 ? Math.atan2(prefZ, prefX) : agent.yaw;
    const baseSpeed = Math.max(Math.hypot(prefX, prefZ), maxSpeed * 0.35);

    let bestX = 0, bestZ = 0, bestPen = Infinity;
    const w = 2.6;                    // collision weight; higher = more timid

    for (let a = 0; a < ANGLES.length; a++) {
      const ang = baseAng + ANGLES[a];
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (let s = 0; s < SPEEDS.length; s++) {
        const sp = baseSpeed * SPEEDS[s];
        const vx = ca * sp, vz = sa * sp;
        const pen = this._penalty(agent, vx, vz, prefX, prefZ, n, w);
        this.stats.samples++;
        if (pen < bestPen) { bestPen = pen; bestX = vx; bestZ = vz; }
        // A candidate with no collision term at all cannot be beaten by a
        // larger deviation, so stop early — this is what keeps the cost flat.
        if (bestPen < 1e-3) { a = ANGLES.length; s = SPEEDS.length; }
      }
    }
    // Standing still is always a legal candidate; a pack pressed against a
    // wall must be allowed to just stop instead of grinding sideways.
    const stopPen = this._penalty(agent, 0, 0, prefX, prefZ, n, w);
    if (stopPen < bestPen) { bestPen = stopPen; bestX = 0; bestZ = 0; }

    const safe = this._slideStatic(agent, bestX, bestZ, maxSpeed);
    agent.vx = safe.x; agent.vz = safe.z;
  }

  /**
   * RVO penalty of candidate velocity (vx, vz).
   *
   * The reciprocal velocity obstacle is evaluated in the generalised form
   *
   *      rel = (v - α·vSelf) / (1 - α)  -  vOther
   *
   * where α is the share of the correction the neighbour is expected to take.
   * α = 0.5 gives the textbook `2v - vSelf - vOther`; α = 0 collapses to the
   * plain velocity obstacle used for immovable bodies and static hazards.
   */
  _penalty(agent, vx, vz, prefX, prefZ, n, w) {
    let worst = 0;
    const svx = agent.pvx, svz = agent.pvz;
    const horizon = this.timeHorizon;
    for (let i = 0; i < n; i++) {
      const nb = this._nb[i];
      const a = nb.share > 0.6 ? 0.6 : nb.share < 0 ? 0 : nb.share;
      const k = 1 / (1 - a);
      const relX = (vx - a * svx) * k - nb.vx;
      const relZ = (vz - a * svz) * k - nb.vz;
      const t = timeToCollision(-nb.dx, -nb.dz, relX, relZ, nb.rr);
      if (t >= horizon) continue;
      let term;
      if (t <= 0) {
        /* Already touching or interpenetrating.
         *
         * This used to `return Infinity`, which reads as caution and is actually
         * paralysis: it scores EVERY candidate the same, standing still included,
         * so `resolve` never beats its initial zero and the agent stops moving
         * for good. Two bodies that come to rest in exact contact — d === rr,
         * which is precisely where a settled pack sits — froze each other for the
         * remainder of the fight, and `depenetrate` could not help because at
         * zero overlap there is nothing to push apart. Measured in `combat`: a
         * brute and a ghoul, touching, both motionless for 360 straight frames
         * while both wanted to move.
         *
         * So score it, signed by whether this candidate separates us, and let the
         * search find the way out. Bad enough that a clear velocity always wins;
         * ordered so that moving apart beats standing still beats pushing in. */
        const d = nb.d > 1e-4 ? nb.d : 1e-4;
        const sp = agent.maxSpeed > 1e-3 ? agent.maxSpeed : 1;
        // `nb.dx/dz` points from the neighbour to us, so this is the escape axis.
        const away = (relX * nb.dx + relZ * nb.dz) / (d * sp);
        term = (w / 0.05) * (1 - 0.5 * (away > 1 ? 1 : away < -1 ? -1 : away));
      } else {
        term = w / t;
      }
      if (term > worst) worst = term;
    }
    const dvx = vx - prefX, dvz = vz - prefZ;
    return Math.sqrt(dvx * dvx + dvz * dvz) + worst;
  }

  /**
   * Static-geometry veto. Probe the candidate a short time ahead; if the probe
   * leaves the walkable set, rotate the candidate toward the local clearance
   * gradient (which points away from the nearest wall) until it clears, and
   * shed speed if nothing works.
   */
  _slideStatic(agent, vx, vz, maxSpeed) {
    const nav = this.nav;
    const out = _out;
    out.x = vx; out.z = vz;
    if (!nav || !nav.built) return out;

    const r = agent.radius;
    const look = this.obstacleHorizon;
    const speed = Math.hypot(vx, vz);
    if (speed < 1e-4) return out;

    const probe = Math.min(look, 1.1) * 1.0;

    /* Twice: once as the real body, then as a narrower one.
     *
     * Nav clearance is ADVICE about where a body will fit; `Physics._pinActor` is
     * what actually keeps it out of geometry. So before concluding there is
     * nowhere to go, ask again as something slimmer — a brute that squeezes past
     * a boulder and gets shoved straight afterwards reads as a brute pushing
     * through, while one that stands still reads as a bug.
     *
     * This path only started mattering when solid props entered the grid: a 2.1 m
     * wide brute wants 1.07 m of clearance, a dressed crypt does not always have
     * it, and every candidate below was vetoed. Measured, that froze two of nine
     * actors in `combat` for the entire fight. */
    for (let w = 0; w < 2; w++) {
      const rr = w === 0 ? r : r * 0.55;
      if (nav.lineOfSight(agent.px, agent.pz, agent.px + vx * probe, agent.pz + vz * probe, rr)) return out;
      // sample rotations either way, nearest first
      for (let k = 1; k <= 6; k++) {
        const a = (k / 6) * (Math.PI * 0.92);
        for (let s = -1; s <= 1; s += 2) {
          const ca = Math.cos(a * s), sa = Math.sin(a * s);
          const nx = vx * ca - vz * sa;
          const nz = vx * sa + vz * ca;
          if (nav.lineOfSight(agent.px, agent.pz, agent.px + nx * probe, agent.pz + nz * probe, rr)) {
            out.x = nx; out.z = nz;
            return out;
          }
        }
      }
    }
    // fully boxed in — creep along the clearance gradient so we un-wedge
    const g = this._gradient(agent.px, agent.pz);
    const gl = Math.hypot(g.x, g.z);
    if (gl > 1e-4) {
      const s = Math.min(maxSpeed * 0.4, speed) / gl;
      out.x = g.x * s; out.z = g.z * s;
    } else {
      out.x = 0; out.z = 0;
    }
    return out;
  }

  /** Central-difference gradient of the nav clearance field, in world space. */
  _gradient(x, z) {
    const nav = this.nav;
    const h = nav.cell;
    const gx = nav.clearanceAt(x + h, z) - nav.clearanceAt(x - h, z);
    const gz = nav.clearanceAt(x, z + h) - nav.clearanceAt(x, z - h);
    _grad.x = gx; _grad.z = gz;
    return _grad;
  }

  /* ================================================================ *
   * post-integration depenetration
   * ================================================================ */

  /**
   * Symmetric positional correction. Runs after every agent has integrated, so
   * the frame we actually render never contains two overlapping bodies. Weighted
   * by mass so a grunt bounces off a brute rather than the reverse.
   */
  depenetrate(agents, obstacles, iterations = 2) {
    for (let it = 0; it < iterations; it++) {
      let moved = 0;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a.active || a.dead) continue;
        for (let j = i + 1; j < agents.length; j++) {
          const b = agents[j];
          if (!b.active || b.dead) continue;
          let dx = b.px - a.px, dz = b.pz - a.pz;
          const rr = a.radius + b.radius;
          let d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) {
            // exactly coincident: break the tie deterministically by index
            const ang = ((i * 31 + j * 17) % 360) * (TAU / 360);
            dx = Math.cos(ang); dz = Math.sin(ang); d = 1;
          }
          const overlap = rr - d;
          const inv = 1 / d;
          const ma = a.immovable ? 0 : 1 / Math.max(1, a.mass);
          const mb = b.immovable ? 0 : 1 / Math.max(1, b.mass);
          const sum = ma + mb;
          if (sum <= 0) continue;
          const pa = (overlap * ma / sum) * 0.62;
          const pb = (overlap * mb / sum) * 0.62;
          a.px -= dx * inv * pa; a.pz -= dz * inv * pa;
          b.px += dx * inv * pb; b.pz += dz * inv * pb;
          moved++;
        }
        // circular obstacles (hero, hazards) push agents out, never the reverse
        for (let o = 0; o < obstacles.length; o++) {
          const ob = obstacles[o];
          if (ob.ignore === a || ob.soft) continue;
          const dx = a.px - ob.x, dz = a.pz - ob.z;
          const rr = a.radius + ob.radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2) || 1e-4;
          const push = (rr - d) * 0.85;
          a.px += (dx / d) * push;
          a.pz += (dz / d) * push;
        }
      }
      if (!moved) break;
    }
  }

  /**
   * Push an agent back onto walkable ground after integration.
   *
   * One clearance bar throughout, and that is load bearing. This used to ACCEPT
   * at `radius * 0.92` while RELOCATING to somewhere that only promised
   * `radius * 0.8`, so an agent whose surroundings offered something in between
   * was rejected, snapped to a cell, rejected again next frame, snapped to the
   * same cell — pinned there, at zero net velocity, for as long as it lived.
   * Latent until solid props tightened the clearance field enough to land big
   * bodies in that band, at which point it froze two of nine actors in `combat`
   * for an entire fight. When no cell clears the bar, leave the agent where it
   * is: Physics keeps it out of the geometry and `AI._stuckCheck` walks it out,
   * both of which beat teleporting it back and forth.
   */
  clampToNav(agent) {
    const nav = this.nav;
    if (!nav || !nav.built) return;
    const need = agent.radius * 0.92;
    if (nav.isFree(agent.px, agent.pz, need)) return;
    const g = this._gradient(agent.px, agent.pz);
    const gl = Math.hypot(g.x, g.z);
    if (gl > 1e-4) {
      const step = nav.cell * 0.9;
      const nx = agent.px + (g.x / gl) * step;
      const nz = agent.pz + (g.z / gl) * step;
      if (nav.isFree(nx, nz, need)) { agent.px = nx; agent.pz = nz; return; }
    }
    const f = nav.nearestFree(agent.px, agent.pz, need, 3.2, _nf);
    if (f.found) { agent.px = f.x; agent.pz = f.z; }
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * Time until two discs of combined radius `rr` touch, given the relative
 * position `(rx, rz)` from us to them and relative velocity `(vx, vz)`.
 * Returns 0 if already overlapping, Infinity if they never will.
 */
function timeToCollision(rx, rz, vx, vz, rr) {
  const c = rx * rx + rz * rz - rr * rr;
  if (c < 0) return 0;                       // already interpenetrating
  const a = vx * vx + vz * vz;
  if (a < 1e-8) return Infinity;
  const b = rx * vx + rz * vz;
  if (b >= 0) return Infinity;               // separating
  const disc = b * b - a * c;
  if (disc <= 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t < 0 ? Infinity : t;
}

/** Insertion sort into a fixed-size nearest-N list, sorted by distance. */
function insert(list, n, maxN, dx, dz, d, rr, share, vx, vz) {
  if (n >= maxN && d >= list[maxN - 1].d) return;
  let pos = n < maxN ? n : maxN - 1;
  while (pos > 0 && list[pos - 1].d > d) {
    const prev = list[pos - 1], cur = list[pos];
    cur.dx = prev.dx; cur.dz = prev.dz; cur.d = prev.d; cur.rr = prev.rr;
    cur.share = prev.share; cur.vx = prev.vx; cur.vz = prev.vz;
    pos--;
  }
  const s = list[pos];
  s.dx = dx; s.dz = dz; s.d = d; s.rr = rr; s.share = share; s.vx = vx; s.vz = vz;
}

const _out = { x: 0, z: 0 };
const _grad = { x: 0, z: 0 };
const _nf = { x: 0, z: 0, found: false };
