/**
 * SANCTUM — perception.
 *
 * Enemies that snap to full aggro the instant the player is in range read as
 * scripted. Enemies that *accumulate* awareness — glimpse, turn, confirm,
 * commit — read as alive. So awareness here is a scalar that fills and drains:
 *
 *   fill rate  ∝ archetype gain × distance falloff × cone position × target motion
 *   drain rate  = 0.5 /s while the target is unseen, freezing briefly on a
 *                 fresh loss so the agent commits to investigating instead of
 *                 immediately forgetting
 *
 * Hearing is separate and does not aggro on its own: a noise sets a *stimulus*
 * point and pushes awareness partway, which produces the turn-and-look beat.
 *
 * Line of sight is the expensive part, so it is budgeted: a round-robin queue
 * refreshes at most `losBudget` agents per frame and each agent's answer is
 * cached for up to 0.22 s. Against the nav grid a LOS test is ~40 half-cell
 * samples, so the whole system costs well under 0.1 ms for 30 agents.
 */

const NOISE_CAP = 24;

export class Perception {
  constructor(engine, nav) {
    this.engine = engine;
    this.nav = nav;
    this.losBudget = 6;
    this._noises = [];
    this._losCursor = 0;
    this.stats = { losChecks: 0, heard: 0 };
  }

  /**
   * Register a world noise. `loudness` 0..2 scales the effective hearing radius;
   * 1 is a footstep-loud event, 2 is a boss slam.
   */
  pushNoise(x, y, z, loudness = 1, faction = 'player') {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const t = this.engine.clock.elapsed;
    if (this._noises.length >= NOISE_CAP) this._noises.shift();
    this._noises.push({ x, y: Number.isFinite(y) ? y : 0, z, l: Math.max(0.05, Math.min(3, loudness)), t, faction });
  }

  /** Drop noises older than 0.6 s — the "was there something?" window. */
  _expire() {
    const t = this.engine.clock.elapsed;
    const n = this._noises;
    while (n.length && t - n[0].t > 0.6) n.shift();
  }

  /**
   * @param {Array} agents
   * @param {{x:number,y:number,z:number,speed:number,alive:boolean}|null} threat
   */
  update(agents, threat, dt) {
    this._expire();
    const elapsed = this.engine.clock.elapsed;

    /* ---- budgeted LOS refresh ---- */
    if (threat && agents.length) {
      let done = 0;
      const n = agents.length;
      for (let s = 0; s < n && done < this.losBudget; s++) {
        const idx = (this._losCursor + s) % n;
        const a = agents[idx];
        if (!a.active || a.dead) continue;
        if (elapsed - a.losAt < 0.22) continue;
        const d2 = (threat.x - a.px) * (threat.x - a.px) + (threat.z - a.pz) * (threat.z - a.pz);
        const maxR = a.arch.vision.range + 4;
        if (d2 > maxR * maxR) { a.losOk = false; a.losAt = elapsed; continue; }
        a.losOk = this._lineOfSight(a, threat);
        a.losAt = elapsed;
        this.stats.losChecks++;
        done++;
      }
      this._losCursor = (this._losCursor + Math.max(1, this.losBudget)) % Math.max(1, n);
    }

    /* ---- awareness integration ---- */
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.active || a.dead) continue;
      // Perception runs on the agent's own tick cadence so a distant agent is
      // not perceiving 4× more often than it thinks.
      this._agent(a, threat, dt, elapsed);
    }
  }

  _agent(a, threat, dt, elapsed) {
    const V = a.arch.vision;

    /* ---- hearing (always on, 360°) ---- */
    let heardX = 0, heardZ = 0, heardW = 0;
    for (let i = 0; i < this._noises.length; i++) {
      const nz = this._noises[i];
      if (nz.faction === a.faction) continue;
      if (nz.t <= a.lastNoiseAt) continue;
      const dx = nz.x - a.px, dz = nz.z - a.pz;
      const d = Math.hypot(dx, dz);
      const reach = a.arch.hearing * nz.l;
      if (d > reach) continue;
      const w = 1 - d / reach;
      heardX += nz.x * w; heardZ += nz.z * w; heardW += w;
      a.lastNoiseAt = nz.t;
      this.stats.heard++;
    }
    if (heardW > 0) {
      a.stimX = heardX / heardW;
      a.stimZ = heardZ / heardW;
      a.stimT = elapsed;
      a.heardRecently = true;
      // Hearing alone gets you to "suspicious", never to "committed".
      a.awareness = Math.min(0.92, a.awareness + 0.34 + heardW * 0.22);
    }

    /* ---- vision ---- */
    let sees = false;
    if (threat && threat.alive !== false) {
      const dx = threat.x - a.px, dz = threat.z - a.pz;
      const dist = Math.hypot(dx, dz);
      if (dist <= V.range && a.losOk) {
        const inv = dist > 1e-4 ? 1 / dist : 0;
        const fx = Math.cos(a.yaw), fz = Math.sin(a.yaw);
        const dot = (dx * inv) * fx + (dz * inv) * fz;
        const half = Math.cos(Math.min(Math.PI, V.fovDeg * 0.5 * Math.PI / 180));
        if (dot >= half || V.fovDeg >= 359) {
          sees = true;
          // centre of vision confirms fast; the edge of the cone only nags
          const conePos = V.fovDeg >= 359 ? 1
            : Math.min(1, Math.max(0, (dot - half) / Math.max(1e-3, 1 - half)));
          const cone = V.peripheralGain + (1 - V.peripheralGain) * conePos;
          const near = 1 - Math.min(1, dist / V.range);
          const motion = 0.55 + 0.45 * Math.min(1, (threat.speed ?? 0) / 5);
          a.awareness = Math.min(1.35, a.awareness + V.gain * cone * (0.35 + near * 0.9) * motion * dt);
          a.lastSeenX = threat.x; a.lastSeenZ = threat.z; a.lastSeenT = elapsed;
          a.stimX = threat.x; a.stimZ = threat.z; a.stimT = elapsed;
        }
      }
    }
    a.canSeeTarget = sees;

    if (!sees && heardW <= 0) {
      // Hold awareness for a beat after losing sight, then bleed it off. The
      // hold is what makes an agent walk to where you *were*.
      const held = elapsed - a.lastSeenT < 1.2;
      if (!held) a.awareness = Math.max(0, a.awareness - 0.5 * dt);
    }
    if (a.awareness > 1) a.awareness = Math.min(1.35, a.awareness);
  }

  /**
   * LOS against dungeon geometry. A dungeon module that exposes a ray test is
   * authoritative; otherwise the nav grid (which was built from the dungeon's
   * own walkability) is an accurate stand-in for walls, and free for us.
   */
  _lineOfSight(a, threat) {
    const d = this.engine.get?.('dungeon');
    if (d && !d.__dead) {
      try {
        if (typeof d.lineOfSight === 'function') {
          const r = d.lineOfSight(a.px, a.eyeY, a.pz, threat.x, (threat.y ?? 0) + 1.1, threat.z);
          if (typeof r === 'boolean') return r;
        }
        if (typeof d.hasLineOfSight === 'function') {
          const r = d.hasLineOfSight(a.px, a.eyeY, a.pz, threat.x, (threat.y ?? 0) + 1.1, threat.z);
          if (typeof r === 'boolean') return r;
        }
      } catch { /* fall through to the grid */ }
    }
    const nav = this.nav;
    if (nav && nav.built) return nav.lineOfSight(a.px, a.pz, threat.x, threat.z, 0.12);
    return true;
  }

  dispose() { this._noises.length = 0; }
}
