/**
 * SANCTUM — boss controller.
 *
 * A boss is not a big grunt. It is a *rotation*: a small set of distinct,
 * heavily telegraphed abilities on independent cooldowns, gated by range and by
 * phase, chosen so the same move never fires twice in a row, arranged around an
 * arena the boss actually understands. Phase breaks are punctuation — a roar,
 * adds, a camera hit — and the enrage is the clock the player is racing.
 *
 * The controller only *decides*; the generic windup → strike → recover machinery
 * in Brain.js executes, so a boss telegraph is the same code path (and therefore
 * the same visual language) as a grunt's, just bigger and slower.
 */

import { BOSS_ABILITIES } from './Archetypes.js';

const TAU = Math.PI * 2;
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class BossController {
  constructor(ai, agent) {
    this.ai = ai;
    this.engine = ai.engine;
    this.agent = agent;
    this.arch = agent.arch;
    this.phases = this.arch.phases ?? [{ at: 1, abilities: [], castMul: 1, speedMul: 1, adds: 0 }];
    this.phaseIndex = 0;
    this.castMul = this.phases[0].castMul ?? 1;
    this.speedMul = this.phases[0].speedMul ?? 1;
    this.enraged = false;
    this.startT = this.engine.clock.elapsed;
    this.lastAbility = '';
    this.addsSpawned = 0;
    this.arena = { x: 0, z: 0, r: 19 };
    this._arenaFromWorld = false;
    this.phaseLabel = this.phases[0].name ?? 'I';
  }

  /* ================================================================ *
   * arena
   * ================================================================ */

  setArena(x, z, r) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !(r > 2)) return;
    this.arena.x = x; this.arena.z = z; this.arena.r = r;
    this._arenaFromWorld = true;
  }

  /**
   * Infer the arena from the walkable footprint around the spawn point when
   * nobody told us: march outward on eight rays until the nav grid stops being
   * walkable, and take a conservative inscribed radius.
   */
  inferArena() {
    if (this._arenaFromWorld) return;
    const nav = this.ai.nav;
    const a = this.agent;
    this.arena.x = a.px; this.arena.z = a.pz;
    if (!nav || !nav.built) { this.arena.r = 19; return; }
    let minR = 40;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * TAU;
      const cx = Math.cos(ang), cz = Math.sin(ang);
      let r = 2;
      while (r < 40) {
        if (!nav.isFree(a.px + cx * r, a.pz + cz * r, a.radius)) break;
        r += 0.8;
      }
      if (r < minR) minR = r;
    }
    this.arena.r = Math.max(9, Math.min(30, minR * 0.92));
  }

  /* ================================================================ *
   * phases
   * ================================================================ */

  _targetPhase() {
    const f = this.agent.hpFrac;
    let idx = 0;
    for (let i = 0; i < this.phases.length; i++) if (f <= this.phases[i].at + 1e-6) idx = i;
    return idx;
  }

  wantsPhaseBreak() {
    return this._targetPhase() > this.phaseIndex;
  }

  /** Called once, from ST.PHASE. This is the beat the fight is built around. */
  enterPhase(ctx) {
    this.phaseIndex = this._targetPhase();
    const p = this.phases[this.phaseIndex];
    this.castMul = p.castMul ?? 1;
    this.speedMul = p.speedMul ?? 1;
    this.phaseLabel = p.name ?? String(this.phaseIndex + 1);
    const a = this.agent;
    a.maxSpeed = this.arch.speed * this.speedMul * (this.enraged ? (this.arch.enrage?.speedMul ?? 1.2) : 1);
    // every ability comes off cooldown so the new phase opens with a statement
    a.cooldowns.clear();
    a.globalCd = 0.4;

    const bus = this.engine.bus;
    try {
      bus.emit('camera:shake', { amp: 0.72, freq: 11, duration: 1.15 });
      bus.emit('ui:toast', { text: `${this.arch.label} — Phase ${this.phaseLabel}`, tier: 'boss' });
      bus.emit('ability:cast', {
        id: 'boss.phase', caster: a.entity, casterId: a.id,
        origin: { x: a.px, y: a.py + a.height * 0.55, z: a.pz },
        dir: { x: Math.cos(a.yaw), y: 0, z: Math.sin(a.yaw) },
        level: this.phaseIndex + 1,
      });
      bus.emit('impact', {
        point: { x: a.px, y: a.py + 0.05, z: a.pz },
        normal: { x: 0, y: 1, z: 0 }, kind: 'boss_roar', magnitude: 1,
      });
    } catch { /* presentation only */ }

    // Phase-break adds land in a believable arc in front of the boss.
    if (p.adds > 0) this.summonAdds(p.adds, ctx, 6.8);
    this.ai.perception?.pushNoise(a.px, a.py, a.pz, 3, 'enemy');
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(agent, ctx, dt) {
    const E = this.arch.enrage;
    if (E && !this.enraged) {
      const timedOut = ctx.elapsed - this.startT > E.timeout;
      if (agent.hpFrac <= E.at || timedOut) {
        this.enraged = true;
        agent.enraged = true;
        agent.maxSpeed = this.arch.speed * this.speedMul * (E.speedMul ?? 1.25);
        agent.damageMul = E.damageMul ?? 1.3;
        agent.cooldowns.clear();
        try {
          this.engine.bus.emit('ui:toast', { text: `${this.arch.label} ENRAGES`, tier: 'danger' });
          this.engine.bus.emit('camera:shake', { amp: 0.85, freq: 9, duration: 1.6 });
        } catch { /* ignore */ }
      }
    }

    /* ---- arena containment ---- */
    const A = this.arena;
    const dx = agent.px - A.x, dz = agent.pz - A.z;
    const d = Math.hypot(dx, dz);
    const limit = Math.max(3, A.r - agent.radius - 1.2);
    if (d > limit) {
      // Walk back in rather than teleport; a boss that respects its arena wall
      // sells the space as a place instead of a backdrop.
      const inv = d > 1e-4 ? 1 / d : 0;
      agent.repositionTo = { x: A.x + dx * inv * (limit * 0.7), z: A.z + dz * inv * (limit * 0.7) };
      agent.repositionUntil = ctx.elapsed + 2.5;
    } else if (agent.repositionUntil !== undefined && ctx.elapsed > agent.repositionUntil) {
      agent.repositionTo = null;
    }
  }

  /* ================================================================ *
   * ability selection
   * ================================================================ */

  chooseAbility(ctx) {
    const agent = this.agent;
    const t = ctx.threat;
    if (!t) return null;
    const phase = this.phases[this.phaseIndex];
    const list = phase.abilities;
    const dist = Math.hypot(t.x - agent.px, t.z - agent.pz);

    let best = null, bestScore = -Infinity, needCentre = null;

    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      const ab = BOSS_ABILITIES[id];
      if (!ab) continue;
      if (!agent.cdReady(ab.id)) continue;
      if (ab.summon && !this.ai.canSummon(agent)) continue;

      if (ab.arenaCentre) {
        // must be standing near the middle for the safe-ring read to work
        const dc = Math.hypot(agent.px - this.arena.x, agent.pz - this.arena.z);
        if (dc > 4.5) { if (!needCentre) needCentre = ab; continue; }
      }
      if (ab.minRange && dist < ab.minRange) continue;
      if (dist > ab.range) continue;

      // Signature abilities (long cooldowns) get priority the moment they are up;
      // repeats are penalised so the rotation always reads as varied.
      let score = ab.cooldown * 0.6 + (ab.damage ?? 0) * 0.05;
      if (ab.id === this.lastAbility) score -= 9;
      if (ab.summon) score += this.ai.allyCount(agent) < 2 ? 4 : -3;
      score += agent.rnd() * 1.4;
      if (score > bestScore) { bestScore = score; best = ab; }
    }

    if (!best && needCentre) {
      // Nothing else is up and the big one wants the middle — go stand in it.
      agent.repositionTo = { x: this.arena.x, z: this.arena.z };
      agent.repositionUntil = ctx.elapsed + 4.0;
      return null;
    }

    if (best) {
      this.lastAbility = best.id;
      agent.repositionTo = null;
      // Ground-targeted abilities aim at where the player is *going*.
      if (best.groundAtTarget || best.predict) {
        const lead = best.predict ?? 0.35;
        agent.aimX = t.x + (t.vx ?? 0) * lead;
        agent.aimZ = t.z + (t.vz ?? 0) * lead;
      } else if (best.arenaCentre) {
        agent.aimX = this.arena.x; agent.aimZ = this.arena.z;
      } else {
        agent.aimX = undefined; agent.aimZ = undefined;
      }
    }
    return best;
  }

  /* ================================================================ *
   * adds
   * ================================================================ */

  summonAdds(count, ctx, radius = 6) {
    const agent = this.agent;
    const dir = ctx?.threat
      ? Math.atan2(ctx.threat.z - agent.pz, ctx.threat.x - agent.px)
      : agent.yaw;
    const cx = agent.px + Math.cos(dir) * radius * 0.75;
    const cz = agent.pz + Math.sin(dir) * radius * 0.75;
    const pts = this.ai.director.formationPoints(count, cx, cz, {
      seed: (agent.seed ^ (this.addsSpawned * 7919)) >>> 0,
      spread: radius,
      radius: 0.5,
      facing: dir,
    });
    this.addsSpawned += count;
    this.ai.requestSummon(agent, 'grunt', pts, { source: 'boss', phase: this.phaseLabel });
  }

  dispose() { this.agent = null; }
}

export { sat };
