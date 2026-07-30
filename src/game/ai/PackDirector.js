/**
 * THE NINTH VIGIL — encounter director.
 *
 * This is the most important file in the AI for how the game *reads*. Nine
 * enemies that all attack whenever they are in range produce an unreadable
 * scrum and an unfair fight. Nine enemies where two are committed, two are
 * winding up their approach and five are orbiting at a legible radius produce
 * the choreography players remember as "good combat".
 *
 * Mechanism:
 *
 *  - ATTACK TOKENS. A pool of 2–3 melee tokens per encounter (plus a small
 *    ranged pool and a single caster pool, which do not crowd the player's
 *    body and so are budgeted separately). No token, no attack — full stop.
 *    Tokens are granted to the agent with the highest priority score
 *    (proximity + how long it has been waiting + facing) and are force-rotated
 *    after a maximum hold so nobody monopolises the front.
 *
 *  - RING SLOTS. Every non-attacking melee gets an angular slot around the
 *    target, spread by a repulsion relaxation rather than an even division, so
 *    the ring looks organic and reshuffles as agents die. Slots are sticky:
 *    an agent keeps its angle unless the assignment is clearly worse, because
 *    re-shuffling every frame reads as indecision.
 *
 *  - FORMATION. Spawn clustering by weighted blue-noise-ish rejection sampling
 *    around a few sub-cluster seeds. Never a grid, never a perfect circle.
 */

const TAU = Math.PI * 2;
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class PackDirector {
  constructor(ai) {
    this.ai = ai;
    this.engine = ai.engine;
    this.encounters = [];
    this.aggroed = false;
    this._regroupAt = -99;
    this.stats = { tokens: 0, encounters: 0 };
  }

  /* ================================================================ *
   * grouping
   * ================================================================ */

  /**
   * One encounter per contiguous cluster of engaged agents. In practice an ARPG
   * fight is one encounter, but keeping it general means a second pack that
   * wanders in gets its own token budget instead of starving the first.
   */
  regroup(agents, elapsed) {
    this._regroupAt = elapsed;
    const engaged = [];
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.encounter = null;
      if (!a.active || a.dead) continue;
      if (a.awareness < 0.3 && !a.hasToken) continue;
      engaged.push(a);
    }

    // single-link clustering at 22 m — cheap, order-stable
    const groups = [];
    const seen = new Uint8Array(engaged.length);
    for (let i = 0; i < engaged.length; i++) {
      if (seen[i]) continue;
      const g = [engaged[i]];
      seen[i] = 1;
      for (let head = 0; head < g.length; head++) {
        const a = g[head];
        for (let j = 0; j < engaged.length; j++) {
          if (seen[j]) continue;
          const b = engaged[j];
          const dx = b.px - a.px, dz = b.pz - a.pz;
          if (dx * dx + dz * dz > 484) continue;
          seen[j] = 1;
          g.push(b);
        }
      }
      groups.push(g);
    }

    // Reuse encounter records so token holds survive a regroup.
    const next = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      let enc = null;
      // inherit the record that already owns most of this group
      const counts = new Map();
      for (const a of g) if (a.__enc) counts.set(a.__enc, (counts.get(a.__enc) ?? 0) + 1);
      let bestN = 0;
      for (const [e, n] of counts) if (n > bestN && !next.includes(e)) { bestN = n; enc = e; }
      if (!enc) enc = { members: [], melee: [], ranged: [], caster: [], pools: { melee: 0, ranged: 0, caster: 0 }, held: { melee: 0, ranged: 0, caster: 0 }, cx: 0, cz: 0, lastGrant: -99 };
      enc.members = g;
      for (const a of g) { a.encounter = enc; a.__enc = enc; }
      next.push(enc);
    }
    this.encounters = next;
    this.stats.encounters = next.length;
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(agents, threat, dt, elapsed) {
    if (elapsed - this._regroupAt > 0.5) this.regroup(agents, elapsed);

    for (let e = 0; e < this.encounters.length; e++) {
      const enc = this.encounters[e];
      this._classify(enc);
      this._budget(enc);
      this._tokens(enc, threat, dt, elapsed);
      this._slots(enc, threat, elapsed);
    }

    // Release tokens held by agents that fell out of every encounter.
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.hasToken && (!a.encounter || a.dead || !a.active)) this.ai.releaseToken(a);
      if (!a.hasToken) a.tokenWaited += dt;
    }
  }

  _classify(enc) {
    enc.melee.length = 0; enc.ranged.length = 0; enc.caster.length = 0;
    let cx = 0, cz = 0, n = 0;
    for (let i = 0; i < enc.members.length; i++) {
      const a = enc.members[i];
      if (a.dead) continue;
      cx += a.px; cz += a.pz; n++;
      const pool = a.arch.tokenPool;
      if (pool === 'ranged') enc.ranged.push(a);
      else if (pool === 'caster') enc.caster.push(a);
      else if (pool === 'boss') { /* bosses never queue for a token */ }
      else enc.melee.push(a);
    }
    enc.cx = n ? cx / n : 0;
    enc.cz = n ? cz / n : 0;
    enc.alive = n;
  }

  /**
   * Token budget. This is the dial that decides how hard the fight feels, and
   * it is deliberately small: 2 attackers, 3 only once the pack is big enough
   * that 2 would read as passive.
   */
  _budget(enc) {
    const m = enc.melee.length;
    enc.pools.melee = m === 0 ? 0 : m <= 2 ? Math.min(2, m) : m >= 7 ? 3 : 2;
    // Ranged do not occupy the player's personal space, so a couple can fire
    // concurrently without muddying the read.
    enc.pools.ranged = Math.min(2, Math.max(enc.ranged.length ? 1 : 0, Math.floor(enc.ranged.length / 3) + (enc.ranged.length ? 1 : 0)));
    enc.pools.caster = enc.caster.length ? 1 : 0;
  }

  _tokens(enc, threat, dt, elapsed) {
    if (!threat) {
      for (const a of enc.members) if (a.hasToken) this.ai.releaseToken(a);
      return;
    }
    this._poolTokens(enc, enc.melee, 'melee', enc.pools.melee, threat, elapsed);
    this._poolTokens(enc, enc.ranged, 'ranged', enc.pools.ranged, threat, elapsed);
    this._poolTokens(enc, enc.caster, 'caster', enc.pools.caster, threat, elapsed);
  }

  _poolTokens(enc, list, pool, capacity, threat, elapsed) {
    let held = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.hasToken) continue;
      held += a.arch.tokenCost;
      // Force rotation: a holder that has not converted its token into a swing
      // within a generous window loses it, so the front never stalls.
      const busy = a.state === 'windup' || a.state === 'strike' || a.state === 'recover' || a.state === 'summon';
      const maxHold = busy ? 6.0 : 2.6;
      if (elapsed - a.tokenSince > maxHold) { this.ai.releaseToken(a); held -= a.arch.tokenCost; }
    }
    enc.held[pool] = held;
    if (held >= capacity) return;

    // Grant to the best waiting candidate(s).
    let free = capacity - held;
    let guard = 0;
    while (free > 0 && guard++ < 8) {
      let best = null, bestScore = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a.hasToken || a.dead || !a.active) continue;
        if (a.arch.tokenCost > free) continue;
        if (a.awareness < 0.9 && !a.canSeeTarget) continue;
        if (a.state === 'flee' || a.state === 'stagger' || a.state === 'dead') continue;
        const dx = threat.x - a.px, dz = threat.z - a.pz;
        const dist = Math.hypot(dx, dz);
        const reach = a.arch.ranged ? a.arch.ranged.max : a.arch.ring.max + 2.5;
        if (dist > reach + 6) continue;
        // proximity dominates, fairness breaks ties, facing settles the rest
        const facing = Math.cos(Math.atan2(dz, dx) - a.yaw);
        const ready = a.globalCd <= 0 ? 1.2 : 0;
        const score = -dist * 0.55 + Math.min(a.tokenWaited, 6) * 0.85 + facing * 0.6 + ready;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      if (!best) break;
      this.ai.grantToken(best);
      free -= best.arch.tokenCost;
      this.stats.tokens++;
      enc.lastGrant = elapsed;
    }
  }

  /**
   * Angular ring slots.
   *
   * Rather than dividing the circle evenly (which reads as a parade), each agent
   * keeps its own angle and we run a couple of repulsion relaxation passes so
   * agents spread apart while preserving their rough position. The result looks
   * like animals keeping their distance, which is what it is.
   */
  _slots(enc, threat, elapsed) {
    if (!threat) return;
    const ring = [];
    for (let i = 0; i < enc.melee.length; i++) {
      const a = enc.melee[i];
      if (a.dead || a.hasToken) continue;
      ring.push(a);
    }
    for (let i = 0; i < enc.ranged.length; i++) if (!enc.ranged[i].dead) ring.push(enc.ranged[i]);
    for (let i = 0; i < enc.caster.length; i++) if (!enc.caster[i].dead) ring.push(enc.caster[i]);

    const n = ring.length;
    if (!n) return;

    // Seed each agent's angle from where it actually stands, so the ring forms
    // around the pack instead of teleporting it to an arbitrary side.
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const cur = Math.atan2(a.pz - threat.z, a.px - threat.x);
      if (a.slotSeeded !== enc) { a.slotAngle = cur; a.slotSeeded = enc; }
      else {
        // gentle pull toward the true bearing keeps slots honest as agents move
        const d = wrap(cur - a.slotAngle);
        a.slotAngle += d * 0.18;
      }
    }

    // repulsion relaxation
    const minSep = n > 1 ? Math.min(TAU / n, 1.15) : TAU;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const a = ring[i];
        let push = 0;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const d = wrap(a.slotAngle - ring[j].slotAngle);
          const ad = Math.abs(d);
          if (ad >= minSep || ad < 1e-5) continue;
          push += Math.sign(d) * (minSep - ad) * 0.5;
        }
        a.slotAngle = wrap(a.slotAngle + push * 0.5);
      }
    }

    // Radius per role. Ranged sit well outside the melee ring so both are
    // readable at a glance, and the whole ring grows with pack size so twelve
    // bodies do not compress into one another.
    const crowd = 1 + sat((enc.melee.length - 4) / 8) * 0.42;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const r = a.arch.ring;
      if (a.role === 'ranged' || a.role === 'caster') {
        const R = a.arch.ranged;
        a.ringRadius = R ? R.preferred : (r.min + r.max) * 0.5;
      } else {
        const band = r.min + (r.max - r.min) * (0.35 + 0.3 * hashUnit(a.seed));
        a.ringRadius = band * crowd;
      }
      a.slot = i;
    }
  }

  /* ================================================================ *
   * spawn formation
   * ================================================================ */

  /**
   * Believable spawn clustering: 1–3 sub-clusters, jittered radii, rejection
   * sampling against walkability and against each other. Deliberately not a
   * grid, a ring, or a uniform disc — real groups have a leader knot, a couple
   * of stragglers, and uneven spacing.
   *
   * @returns {{x:number,z:number}[]}
   */
  formationPoints(count, cx, cz, opts = {}) {
    const out = [];
    if (!(count > 0)) return out;
    const nav = this.ai.nav;
    const seed = opts.seed ?? 1337;
    const rnd = (this.engine.freshRand ?? this.engine.rand).call(this.engine, seed);
    const spread = opts.spread ?? Math.max(3.2, Math.sqrt(count) * 2.35);
    const radius = opts.radius ?? 0.45;
    const facing = opts.facing ?? 0;

    // sub-cluster seeds, biased ahead of the group's facing
    const knots = Math.max(1, Math.min(3, Math.round(1 + count / 5)));
    const seeds = [];
    for (let k = 0; k < knots; k++) {
      const a = facing + (rnd() - 0.5) * 2.2 + (k / knots) * 1.9;
      const d = k === 0 ? spread * 0.18 : spread * (0.35 + rnd() * 0.55);
      seeds.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, w: k === 0 ? 1.35 : 0.7 + rnd() * 0.6 });
    }

    let guard = 0;
    while (out.length < count && guard++ < count * 60) {
      const s = seeds[(out.length + (rnd() * knots | 0)) % knots];
      const a = rnd() * TAU;
      // gaussian-ish falloff so the knot is dense at the centre
      const u = rnd(), v = rnd();
      const g = Math.sqrt(-2 * Math.log(Math.max(1e-6, u))) * Math.cos(TAU * v);
      const d = Math.abs(g) * spread * 0.30 * s.w;
      const x = s.x + Math.cos(a) * d;
      const z = s.z + Math.sin(a) * d;

      if (nav && nav.built && !nav.isFree(x, z, radius * 1.25)) continue;
      let ok = true;
      const minSep = radius * 2.5 + 0.28;
      for (let i = 0; i < out.length; i++) {
        const dx = out[i].x - x, dz = out[i].z - z;
        if (dx * dx + dz * dz < minSep * minSep) { ok = false; break; }
      }
      if (!ok) continue;
      out.push({ x, z });
    }
    // If the nav grid was hostile, top up so the caller always gets `count`.
    while (out.length < count) {
      const a = (out.length * 2.39996) % TAU;
      const d = spread * (0.3 + (out.length % 4) * 0.19);
      out.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d });
    }
    return out;
  }

  /**
   * Detect and repair a bad spawn layout: bodies stacked on one point, or placed
   * on a visible grid. Both are instant "not AAA" tells and both are cheap to
   * fix before the first frame is ever seen. Opt out with `entity.aiNoArrange`.
   */
  arrangeSpawn(agents, opts = {}) {
    const list = agents.filter((a) => a.active && !a.dead && !a.entity?.aiNoArrange);
    if (list.length < 2) return false;

    let cx = 0, cz = 0;
    for (const a of list) { cx += a.px; cz += a.pz; }
    cx /= list.length; cz /= list.length;

    // stacked?
    let overlaps = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dx = list[j].px - list[i].px, dz = list[j].pz - list[i].pz;
        const rr = (list[i].radius + list[j].radius) * 0.92;
        if (dx * dx + dz * dz < rr * rr) overlaps++;
      }
    }
    // gridded? measure how many positions share an X or Z to within 5 cm
    let axisHits = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[i].px - list[j].px) < 0.05 || Math.abs(list[i].pz - list[j].pz) < 0.05) axisHits++;
      }
    }
    const pairs = (list.length * (list.length - 1)) / 2;
    const bad = overlaps > pairs * 0.22 || axisHits > pairs * 0.30;
    if (!bad && !opts.force) return false;

    const rMax = list.reduce((m, a) => Math.max(m, a.radius), 0.4);
    const pts = this.formationPoints(list.length, cx, cz, {
      seed: opts.seed ?? 7717,
      radius: rMax,
      spread: opts.spread ?? Math.max(4.0, Math.sqrt(list.length) * 2.6),
      facing: opts.facing ?? 0,
    });
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      a.px = pts[i].x; a.pz = pts[i].z;
      a.homeX = a.px; a.homeZ = a.pz;
      a.lastProgressX = a.px; a.lastProgressZ = a.pz;
      a.clearPath();
      // face outward from the knot: a group that was already standing here
      a.yaw = Math.atan2(a.pz - cz, a.px - cx) + (hashUnit(a.seed) - 0.5) * 1.1;
      a.faceYaw = a.yaw;
      a.lookBase = a.yaw;
    }
    return true;
  }

  dispose() {
    this.encounters.length = 0;
  }
}

function wrap(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Deterministic 0..1 from a 32-bit seed — no PRNG stream consumed. */
function hashUnit(seed) {
  let h = seed >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
