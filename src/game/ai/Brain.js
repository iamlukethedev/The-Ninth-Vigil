/**
 * SANCTUM — per-archetype behaviour graph.
 *
 * A prioritised-interrupt state machine, which is what shipped ARPG AI actually
 * uses: a behaviour *tree* re-derives the same decision every tick and makes
 * timing-critical states (windup → commit → recover) awkward to express, whereas
 * an explicit graph makes the readable beats — the notice, the telegraph, the
 * recovery window you punish — first-class and inspectable.
 *
 * The states that matter for how "intelligent" the AI looks:
 *
 *   ALERT       a real pause. Turn to the stimulus, register it, *then* commit.
 *               Without this beat every enemy reads as a homing missile.
 *   CIRCLE      the enemies that do not hold an attack token orbit at a readable
 *               radius instead of shoving into the player's back.
 *   WINDUP      telegraphed, cancellable, and the agent is pinned in place — this
 *               is what makes an attack punishable.
 *   RECOVER     the same, on the way out.
 *   SEEK_LOS    ranged units break and re-establish line of sight rather than
 *               standing in the open trading shots.
 *
 * Every state writes only `agent.prefX/prefZ` (a preferred velocity) and
 * `agent.faceYaw`. Avoidance, integration and turning happen once, centrally, in
 * AI.js — so no state can teleport a body or produce a velocity that clips a wall.
 */

import { ST, ANIM } from './Agent.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

export class Brain {
  constructor(ai) {
    this.ai = ai;
  }

  /* ================================================================ *
   * entry point
   * ================================================================ */

  tick(agent, ctx, dt) {
    agent.stateT += dt;
    agent.prefX = 0; agent.prefZ = 0;
    agent.immovable = false;
    agent.avoidShare = 0.5;
    agent.turnScale = 1;

    if (!this._interrupts(agent, ctx, dt)) {
      const fn = HANDLERS[agent.state] ?? HANDLERS[ST.IDLE];
      fn(this, agent, ctx, dt);
    }

    // Speed cap by state, applied after the handler so no state can outrun the
    // archetype it belongs to.
    const l = Math.hypot(agent.prefX, agent.prefZ);
    if (l > agent.maxSpeed) {
      const s = agent.maxSpeed / l;
      agent.prefX *= s; agent.prefZ *= s;
    }
  }

  /* ================================================================ *
   * interrupts — evaluated every tick, highest priority first
   * ================================================================ */

  _interrupts(agent, ctx, dt) {
    if (agent.dead) {
      if (agent.state !== ST.DEAD) this._enter(agent, ctx, ST.DEAD);
      this.sDead(agent, ctx, dt);
      return true;
    }

    // Boss phase transition outranks everything except death.
    if (agent.boss && agent.state !== ST.PHASE && agent.boss.wantsPhaseBreak()) {
      this._cancelAttack(agent, ctx);
      this._enter(agent, ctx, ST.PHASE, 1.65);
      return false;
    }

    // Hitstun. A committed strike is never interrupted (that is the trade the
    // player is making by standing in it); everything else is.
    if (agent.staggerFor > 0 && agent.state !== ST.STAGGER) {
      if (agent.state !== ST.STRIKE && !agent.arch.unshakable) {
        this._cancelAttack(agent, ctx);
        this._enter(agent, ctx, ST.STAGGER, agent.staggerFor);
        agent.staggerFor = 0;
        return false;
      }
      agent.staggerFor = 0;
    }

    // Cowardice.
    const flee = agent.arch.flee;
    if (flee && !agent.fleeSpent && agent.hpFrac <= flee.hpFrac &&
        agent.state !== ST.FLEE && agent.state !== ST.STRIKE && agent.state !== ST.RECOVER) {
      this._cancelAttack(agent, ctx);
      this._enter(agent, ctx, ST.FLEE, flee.duration);
      return false;
    }
    return false;
  }

  /* ================================================================ *
   * transitions
   * ================================================================ */

  _enter(agent, ctx, next, dur = 0) {
    const prev = agent.state;
    agent.setState(next, dur);
    const fn = ENTER[next];
    if (fn) fn(this, agent, ctx, prev);
  }

  /** Re-enter the right "engaged" state for this archetype. */
  _resume(agent, ctx) {
    if (agent.boss) { this._enter(agent, ctx, ST.CHASE); return; }
    if (agent.arch.ranged) { this._enter(agent, ctx, ST.KITE); return; }
    this._enter(agent, ctx, agent.hasToken ? ST.CHASE : ST.CIRCLE);
  }

  _cancelAttack(agent, ctx) {
    if (agent.telegraph) ctx.ai.endTelegraph(agent, true);
    if (agent.attack) {
      agent.setCd(agent.attack.id, agent.attack.cooldown * 0.35);
      agent.attack = null;
    }
    agent.attackHitDone = false;
    ctx.ai.releaseToken(agent);
  }

  /* ================================================================ *
   * movement primitives
   * ================================================================ */

  stand(agent) { agent.prefX = 0; agent.prefZ = 0; }

  moveDir(agent, dx, dz, speed) {
    const l = Math.hypot(dx, dz);
    if (l < 1e-5) { agent.prefX = 0; agent.prefZ = 0; return; }
    const s = speed / l;
    agent.prefX = dx * s;
    agent.prefZ = dz * s;
  }

  facePoint(agent, x, z) {
    const dx = x - agent.px, dz = z - agent.pz;
    if (Math.abs(dx) + Math.abs(dz) > 1e-5) agent.faceYaw = Math.atan2(dz, dx);
  }

  faceVelocity(agent) {
    if (Math.hypot(agent.prefX, agent.prefZ) > 0.25) {
      agent.faceYaw = Math.atan2(agent.prefZ, agent.prefX);
    }
  }

  /**
   * Path-follow toward a world point. Requests a re-path only when the goal has
   * genuinely moved, the path has expired, or the nav tile was rebuilt — that
   * plus AI.js's per-frame re-path quota is what keeps 30 agents affordable.
   *
   * @returns {number} remaining distance to the goal
   */
  pathTo(agent, ctx, tx, tz, speed, arriveTol = 0.5) {
    const ai = ctx.ai;
    const nav = ctx.nav;
    const distToGoal = Math.hypot(tx - agent.px, tz - agent.pz);

    if (distToGoal <= arriveTol) { this.stand(agent); return distToGoal; }

    const goalMoved = Math.hypot(tx - agent.pathGoalX, tz - agent.pathGoalZ);
    const age = ctx.elapsed - agent.pathAt;
    const stale = agent.path.length < 4 || agent.pathVersion !== nav.version ||
      goalMoved > 1.7 || age > 1.25 || agent.pathStatus === 'partial';

    if (stale) ai.requestRepath(agent, tx, tz, goalMoved > 4 ? 2 : 1);

    // Short-circuit: if we can just walk at it, do that. Cheap, and it keeps
    // motion smooth in the frames between a request and its service.
    const clearShot = distToGoal < 26 && nav.built &&
      nav.lineOfSight(agent.px, agent.pz, tx, tz, agent.radius * 0.9);
    if (clearShot) {
      this.moveDir(agent, tx - agent.px, tz - agent.pz, speed);
      return distToGoal;
    }

    if (agent.path.length >= 4) {
      const p = agent.path;
      let c = agent.pathCursor;
      const tol = Math.max(0.42, agent.radius * 1.35);
      // advance past reached waypoints (and any we can already see past)
      let guard = 0;
      while (c < (p.length >> 1) - 1 && guard++ < 24) {
        const wx = p[c * 2], wz = p[c * 2 + 1];
        if (Math.hypot(wx - agent.px, wz - agent.pz) < tol) { c++; continue; }
        const nx = p[(c + 1) * 2], nz = p[(c + 1) * 2 + 1];
        if (nav.lineOfSight(agent.px, agent.pz, nx, nz, agent.radius * 0.95)) { c++; continue; }
        break;
      }
      agent.pathCursor = c;
      const last = (p.length >> 1) - 1;
      const wx = p[c * 2], wz = p[c * 2 + 1];
      let dx = wx - agent.px, dz = wz - agent.pz;
      // Blend in the following leg so corners are rounded rather than clipped.
      if (c < last) {
        const nx2 = p[(c + 1) * 2], nz2 = p[(c + 1) * 2 + 1];
        const d0 = Math.hypot(dx, dz);
        const w = sat(1 - d0 / 2.6) * 0.55;
        if (w > 0) {
          const l0 = d0 > 1e-4 ? 1 / d0 : 0;
          let ax = nx2 - wx, az = nz2 - wz;
          const l1 = Math.hypot(ax, az);
          if (l1 > 1e-4) { ax /= l1; az /= l1; }
          dx = dx * l0 * (1 - w) + ax * w;
          dz = dz * l0 * (1 - w) + az * w;
        }
      }
      this.moveDir(agent, dx, dz, speed);
      return distToGoal;
    }

    // No usable path yet: head for the goal, avoidance will keep us honest.
    this.moveDir(agent, tx - agent.px, tz - agent.pz, speed);
    return distToGoal;
  }

  /* ================================================================ *
   * shared helpers
   * ================================================================ */

  /** Point on the engagement ring the director assigned this agent. */
  _ringPoint(agent, ctx, out) {
    const t = ctx.threat;
    const ring = agent.arch.ring;
    let radius = agent.ringRadius > 0 ? agent.ringRadius : (ring.min + ring.max) * 0.5;
    // slow orbital drift + per-agent wobble so a held ring never looks like a
    // parked formation
    const drift = ctx.elapsed * ring.orbit * agent.flankSign * 0.42;
    const wob = agent.wobble(0.47) * ring.jitter * 0.30;
    const ang = agent.slotAngle + drift + wob;
    radius += agent.wobble(0.31, 2.1) * 0.34 * ring.jitter;
    out.x = t.x + Math.cos(ang) * radius;
    out.z = t.z + Math.sin(ang) * radius;
    out.ang = ang;
    out.radius = radius;
    return out;
  }

  /** Approach point: offset off the straight line so a pack does not funnel. */
  _approachPoint(agent, ctx, out) {
    const t = ctx.threat;
    const dx = t.x - agent.px, dz = t.z - agent.pz;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const toAgent = Math.atan2(-dz, -dx);           // angle from target to us
    // Flank hard when far, straighten out as we arrive — a curved approach reads
    // as intent, a straight line reads as a slide.
    const flank = sat((dist - 3.0) / 12) * 0.85 * agent.flankSign;
    const ang = toAgent + flank + agent.wobble(0.29, 5.3) * 0.10;
    const stand = Math.max(agent.arch.ring.min * 0.86, agent.reachRange * 0.82);
    out.x = t.x + Math.cos(ang) * stand;
    out.z = t.z + Math.sin(ang) * stand;
    out.dist = dist;
    return out;
  }

  /** Distance at which this agent can land its shortest-range attack. */
  _reach(agent) {
    let best = 1.5;
    const list = agent.arch.attacks;
    for (let i = 0; i < list.length; i++) if (list[i].range < best || i === 0) best = list[i].range;
    return best + agent.radius * 0.35;
  }

  /**
   * Choose an attack: cooldown-ready, in range, phase-legal. Longest usable
   * range wins so a brute prefers its sweep over walking into smash range, with
   * a deterministic coin-flip for variety when two are equally valid.
   */
  chooseAttack(agent, ctx) {
    if (agent.boss) return agent.boss.chooseAbility(ctx);
    const t = ctx.threat;
    if (!t) return null;
    const dist = Math.hypot(t.x - agent.px, t.z - agent.pz) - (t.radius ?? 0.45);
    const list = agent.arch.attacks;
    let best = null, bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!agent.cdReady(a.id)) continue;
      if (a.minRange && dist < a.minRange) continue;
      if (dist > a.range) continue;
      const score = a.range + (agent.rnd() * 0.45) + (a.damage > 20 ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  /* ================================================================ *
   * states
   * ================================================================ */

  sSpawn(agent, ctx, dt) {
    this.stand(agent);
    agent.setAnim(ANIM.idle);
    // Look outward from the pack centre so a fresh spawn reads as a group that
    // was already here, not a row of clones facing the camera.
    if (agent.stateT >= agent.stateDur) {
      this._enter(agent, ctx, agent.awareness > 0.25 ? ST.ALERT : ST.PATROL);
    }
  }

  sIdle(agent, ctx, dt) {
    this.stand(agent);
    agent.setAnim(ANIM.idle);
    this._lookAround(agent, ctx, dt);
    if (agent.awareness >= 0.35) { this._enter(agent, ctx, ST.ALERT); return; }
    if (agent.stateDur > 0 && agent.stateT >= agent.stateDur) this._enter(agent, ctx, ST.PATROL);
  }

  sPatrol(agent, ctx, dt) {
    const P = agent.arch.patrol;
    if (agent.awareness >= 0.35) { this._enter(agent, ctx, ST.ALERT); return; }

    if (agent.wanderT > 0) {
      agent.wanderT -= dt;
      this.stand(agent);
      agent.setAnim(ANIM.idle);
      this._lookAround(agent, ctx, dt);
      return;
    }

    const speed = agent.maxSpeed * P.speedMul;
    const d = this.pathTo(agent, ctx, agent.wanderX, agent.wanderZ, speed, 0.8);
    agent.setAnim(speed > agent.maxSpeed * 0.55 ? ANIM.run : ANIM.walk);
    this.faceVelocity(agent);

    if (d <= 0.85 || agent.stateT > 14) {
      agent.wanderT = P.pause[0] + agent.rnd() * (P.pause[1] - P.pause[0]);
      this._pickWander(agent, ctx);
      agent.stateT = 0;
      agent.lookBase = agent.yaw;
    }
  }

  _pickWander(agent, ctx) {
    const P = agent.arch.patrol;
    const nav = ctx.nav;
    for (let i = 0; i < 7; i++) {
      const a = agent.rnd() * TAU;
      const r = P.leash * (0.35 + agent.rnd() * 0.65);
      const x = agent.homeX + Math.cos(a) * r;
      const z = agent.homeZ + Math.sin(a) * r;
      if (!nav.built || nav.isFree(x, z, agent.radius * 1.1)) { agent.wanderX = x; agent.wanderZ = z; return; }
    }
    agent.wanderX = agent.homeX; agent.wanderZ = agent.homeZ;
  }

  _lookAround(agent, ctx, dt) {
    if (agent.lookBase === undefined) agent.lookBase = agent.yaw;
    const amp = agent.arch.patrol.lookAround;
    // two incommensurate rates: the sweep never repeats visibly
    const s = Math.sin(ctx.elapsed * 0.53 + agent.lane) * 0.68 + Math.sin(ctx.elapsed * 0.19 + agent.lane * 1.7) * 0.32;
    agent.faceYaw = agent.lookBase + s * amp;
    agent.turnScale = 0.42;
  }

  /**
   * The notice beat. Everything the player reads as "it saw me" happens here:
   * the body squares up to the stimulus, holds for a beat, and only then commits.
   */
  sAlert(agent, ctx, dt) {
    const t = agent.stateT / Math.max(0.05, agent.stateDur);
    this.facePoint(agent, agent.stimX, agent.stimZ);
    agent.turnScale = 2.4;
    agent.setAnim(ANIM.alert);

    // a small weight shift back on the first third — reads as a flinch/recoil
    if (t < 0.34 && ctx.threat) {
      const dx = agent.px - agent.stimX, dz = agent.pz - agent.stimZ;
      this.moveDir(agent, dx, dz, agent.maxSpeed * 0.22 * (1 - t / 0.34));
    } else {
      this.stand(agent);
    }

    if (agent.stateT >= agent.stateDur) {
      if (agent.awareness >= 0.98 || agent.canSeeTarget) this._resume(agent, ctx);
      else this._enter(agent, ctx, ST.INVESTIGATE, 6.0);
    }
  }

  sInvestigate(agent, ctx, dt) {
    if (agent.awareness >= 0.98 && agent.canSeeTarget) { this._enter(agent, ctx, ST.ALERT); return; }
    const speed = agent.maxSpeed * 0.52;
    const d = this.pathTo(agent, ctx, agent.stimX, agent.stimZ, speed, 1.3);
    agent.setAnim(ANIM.walk);
    this.faceVelocity(agent);
    if (d <= 1.4) {
      // arrived: sweep the area, then give up
      this.stand(agent);
      this._lookAround(agent, ctx, dt);
      agent.setAnim(ANIM.look);
      if (agent.stateT > agent.stateDur * 0.55) {
        agent.awareness = Math.min(agent.awareness, 0.2);
        this._enter(agent, ctx, ST.PATROL);
      }
    } else if (agent.stateT >= agent.stateDur) {
      agent.awareness = Math.min(agent.awareness, 0.2);
      this._enter(agent, ctx, ST.PATROL);
    }
  }

  sChase(agent, ctx, dt) {
    const t = ctx.threat;
    if (!t || t.alive === false) { this._lose(agent, ctx); return; }
    if (!agent.canSeeTarget && ctx.elapsed - agent.lastSeenT > 4.5) { this._lose(agent, ctx); return; }

    const dist = Math.hypot(t.x - agent.px, t.z - agent.pz);
    agent.reachRange = this._reach(agent);

    // In range and holding a token? Commit.
    if (agent.hasToken && agent.globalCd <= 0) {
      const atk = this.chooseAttack(agent, ctx);
      if (atk) {
        const need = atk.groundAtTarget || atk.arenaCentre ? atk.range : atk.range + (t.radius ?? 0.45) * 0.5;
        if (dist <= need) {
          agent.attack = atk;
          this._enter(agent, ctx, ST.WINDUP, this._windup(agent, atk));
          return;
        }
      }
    }

    // No token and already at the ring: hold the ring rather than shove.
    if (!agent.hasToken && dist < agent.arch.ring.max * 1.25 && !agent.boss) {
      this._enter(agent, ctx, ST.CIRCLE);
      return;
    }

    const ap = this._approachPoint(agent, ctx, _pt);
    const sprint = dist > 9 ? agent.arch.sprintMul : 1;
    const speed = agent.maxSpeed * sprint * (agent.enraged ? 1.12 : 1);
    this.pathTo(agent, ctx, ap.x, ap.z, speed, agent.radius * 0.9);
    agent.setAnim(speed > agent.maxSpeed * 0.7 ? ANIM.run : ANIM.walk);
    // Face where we are going while closing, but square up to the target once
    // we are inside striking distance.
    if (dist < agent.reachRange * 2.2) this.facePoint(agent, t.x, t.z);
    else this.faceVelocity(agent);
  }

  /**
   * Hold a readable distance and orbit. This is the state most of a pack is in
   * at any moment and it is the single biggest contributor to the fight reading
   * as choreographed rather than as a scrum.
   */
  sCircle(agent, ctx, dt) {
    const t = ctx.threat;
    if (!t || t.alive === false) { this._lose(agent, ctx); return; }
    if (agent.hasToken) { this._enter(agent, ctx, ST.CHASE); return; }

    const rp = this._ringPoint(agent, ctx, _pt);
    const dist = Math.hypot(t.x - agent.px, t.z - agent.pz);

    // Feint: a short, telegraph-free step toward the player every few seconds.
    // Costs nothing and makes a holding ring look like it wants to attack.
    const feint = agent.wobble(0.63, 11.0);
    const feintIn = feint > 0.86 ? (feint - 0.86) / 0.14 : 0;

    let speed = agent.maxSpeed * (0.42 + 0.26 * sat(Math.abs(dist - rp.radius) / 2.5));
    if (feintIn > 0) speed *= 1 + feintIn * 0.7;

    const tx = rp.x + (t.x - rp.x) * feintIn * 0.35;
    const tz = rp.z + (t.z - rp.z) * feintIn * 0.35;
    this.pathTo(agent, ctx, tx, tz, speed, 0.28);

    this.facePoint(agent, t.x, t.z);
    const moving = Math.hypot(agent.prefX, agent.prefZ);
    agent.setAnim(moving > 0.5 ? ANIM.strafe : ANIM.idle);

    // Long enough on the ring with a free token available? Chase will grab it.
    if (agent.hasToken) this._enter(agent, ctx, ST.CHASE);
  }

  sWindup(agent, ctx, dt) {
    const t = ctx.threat;
    const atk = agent.attack;
    if (!atk) { this._resume(agent, ctx); return; }

    agent.immovable = true;
    agent.avoidShare = 0;
    const p = agent.stateT / Math.max(0.05, agent.stateDur);

    // Track for the first 55 % of the windup, then lock: the player must be able
    // to walk out of it, which is only true if the aim commits early.
    if (t && p < 0.55 && !atk.arenaCentre) {
      this.facePoint(agent, t.x, t.z);
      agent.turnScale = 2.6;
      if (agent.telegraph) ctx.ai.aimTelegraph(agent, ctx);
    } else {
      agent.faceYaw = agent.attackFrom.yaw;
      agent.turnScale = 0.5;
    }

    // Melee creeps in slightly so a shuffling target does not make every swing
    // whiff; AoE and ranged plant.
    if (t && atk.lunge > 0 && !atk.groundAtTarget) {
      const dist = Math.hypot(t.x - agent.px, t.z - agent.pz);
      if (dist > atk.range * 0.72) this.moveDir(agent, t.x - agent.px, t.z - agent.pz, agent.maxSpeed * 0.20);
    }

    agent.setAnim(atk.danger === 'summon' ? ANIM.summon : atk.projectile || atk.groundAtTarget ? ANIM.cast : ANIM.windup);

    // Cancel if the target has clearly escaped — an enemy that swings at empty
    // air two metres away looks broken, one that aborts and re-approaches does not.
    if (t && !atk.arenaCentre && !atk.groundAtTarget) {
      const dist = Math.hypot(t.x - agent.px, t.z - agent.pz);
      if (dist > atk.range * 2.05 + 1.0) {
        ctx.ai.endTelegraph(agent, true);
        agent.setCd(atk.id, atk.cooldown * 0.3);
        agent.attack = null;
        this._enter(agent, ctx, ST.CHASE);
        return;
      }
    }

    if (agent.stateT >= agent.stateDur) {
      agent.attackFrom.x = agent.px;
      agent.attackFrom.z = agent.pz;
      agent.attackFrom.yaw = agent.yaw;
      agent.attackHitDone = false;
      this._enter(agent, ctx, ST.STRIKE, atk.strike * (agent.enraged ? 0.9 : 1));
    }
  }

  sStrike(agent, ctx, dt) {
    const atk = agent.attack;
    if (!atk) { this._resume(agent, ctx); return; }
    agent.immovable = true;
    agent.avoidShare = 0;
    agent.faceYaw = agent.attackFrom.yaw;
    agent.turnScale = 0.1;
    agent.setAnim(atk.danger === 'summon' ? ANIM.summon : ANIM.strike);

    // Lunge: front-loaded so the hit lands at the start of the extension.
    if (atk.lunge > 0) {
      const p = sat(agent.stateT / Math.max(0.03, agent.stateDur));
      const env = Math.pow(1 - p, 1.6);
      const c = Math.cos(agent.attackFrom.yaw), s = Math.sin(agent.attackFrom.yaw);
      agent.prefX = c * atk.lunge * env;
      agent.prefZ = s * atk.lunge * env;
      // A charge must be able to plough through the pack, but never through a wall.
      if (atk.lunge > 12) { agent.avoidShare = 0; agent.immovable = true; }
    } else {
      this.stand(agent);
    }

    const hitAt = Math.min(atk.hitAt ?? 0.05, agent.stateDur * 0.6);
    if (!agent.attackHitDone && agent.stateT >= hitAt) {
      agent.attackHitDone = true;
      ctx.ai.resolveAttack(agent, atk, ctx);
    }

    if (agent.stateT >= agent.stateDur) {
      ctx.ai.endTelegraph(agent, false);
      this._enter(agent, ctx, ST.RECOVER, atk.recover * (agent.enraged ? 0.82 : 1));
    }
  }

  /** The punish window. The agent is pinned, unshaded by avoidance, and slow. */
  sRecover(agent, ctx, dt) {
    const atk = agent.attack;
    agent.immovable = true;
    agent.avoidShare = 0.15;
    this.stand(agent);
    agent.setAnim(ANIM.recover);
    if (ctx.threat) { this.facePoint(agent, ctx.threat.x, ctx.threat.z); agent.turnScale = 0.55; }

    if (agent.stateT >= agent.stateDur) {
      if (atk) {
        agent.setCd(atk.id, atk.cooldown * (agent.enraged ? 0.62 : 1));
        agent.globalCd = 0.28 + agent.rnd() * 0.3;
        agent.attacksLanded++;
        agent.attack = null;
      }
      ctx.ai.releaseToken(agent);

      const hr = agent.arch.hitAndRun;
      if (hr && agent.attacksLanded % Math.max(1, hr.after) === 0) {
        this._enter(agent, ctx, ST.CIRCLE);
        agent.slotAngle += (0.9 + agent.rnd() * 0.8) * agent.flankSign;
        return;
      }
      if (agent.arch.ranged && agent.attacksLanded % (agent.arch.ranged.repositionAfter || 2) === 0) {
        this._enter(agent, ctx, ST.SEEK_LOS, 4.0);
        return;
      }
      this._resume(agent, ctx);
    }
  }

  /* ---- ranged ---- */

  sKite(agent, ctx, dt) {
    const t = ctx.threat;
    const R = agent.arch.ranged;
    if (!t || t.alive === false || !R) { this._lose(agent, ctx); return; }

    const dx = t.x - agent.px, dz = t.z - agent.pz;
    const dist = Math.hypot(dx, dz) || 1e-4;
    this.facePoint(agent, t.x, t.z);
    agent.reachRange = R.max;

    // No line of fire? Go find one; standing there aiming at a wall is the
    // classic "the AI is broken" read.
    if (R.losRequired && !agent.canSeeTarget && ctx.elapsed - agent.lastSeenT > 0.6) {
      this._enter(agent, ctx, ST.SEEK_LOS, 4.0);
      return;
    }

    if (agent.hasToken && agent.globalCd <= 0) {
      const atk = this.chooseAttack(agent, ctx);
      if (atk && dist >= (atk.minRange ?? 0) && dist <= atk.range) {
        agent.attack = atk;
        this._enter(agent, ctx, ST.WINDUP, this._windup(agent, atk));
        return;
      }
    }

    const inv = 1 / dist;
    const ux = dx * inv, uz = dz * inv;
    let vx = 0, vz = 0;
    const speed = agent.maxSpeed * R.kiteMul;

    if (dist < R.min) {
      // back off, still facing the threat
      vx = -ux * speed; vz = -uz * speed;
      agent.setAnim(ANIM.backpedal);
    } else if (dist > R.max) {
      vx = ux * speed; vz = uz * speed;
      agent.setAnim(ANIM.walk);
    } else {
      // hold the band and slide laterally so we are never a static target
      const side = agent.flankSign * (0.55 + agent.wobble(0.41, 3.3) * 0.35);
      vx = -uz * speed * side * 0.62;
      vz = ux * speed * side * 0.62;
      const err = (R.preferred - dist) * 0.42;
      vx -= ux * err; vz -= uz * err;
      agent.setAnim(Math.hypot(vx, vz) > 0.4 ? ANIM.strafe : ANIM.idle);
    }
    agent.prefX = vx; agent.prefZ = vz;

    // Casters keep an eye on pack strength and summon when it thins out.
    if (agent.arch.summonAttack && agent.arch.summon) {
      const S = agent.arch.summon;
      if (agent.cdReady(agent.arch.summonAttack.id) && ctx.ai.allyCount(agent) < S.minAllies &&
          ctx.ai.canSummon(agent) && agent.hasToken) {
        agent.attack = agent.arch.summonAttack;
        this._enter(agent, ctx, ST.SUMMON, this._windup(agent, agent.attack));
      }
    }
  }

  /**
   * Break and re-establish line of fire. Candidate vantage points are sampled on
   * a ring around the target; we take the closest one that is walkable, has LOS,
   * and is not where we already stood.
   */
  sSeekLos(agent, ctx, dt) {
    const t = ctx.threat;
    const R = agent.arch.ranged;
    if (!t || !R) { this._lose(agent, ctx); return; }

    if (agent.losSpotT === undefined || ctx.elapsed - agent.losSpotT > 1.6 || agent.losSpotX === undefined) {
      const nav = ctx.nav;
      const base = Math.atan2(agent.pz - t.z, agent.px - t.x);
      let bestX = 0, bestZ = 0, bestScore = -Infinity, found = false;
      for (let i = 0; i < 12; i++) {
        // sweep outward from where we are, alternating sides
        const step = (Math.floor(i / 2) + 1) * 0.42 * (i % 2 ? 1 : -1);
        const ang = base + step;
        const rad = R.preferred * (0.88 + (i % 3) * 0.12);
        const x = t.x + Math.cos(ang) * rad;
        const z = t.z + Math.sin(ang) * rad;
        if (nav.built && !nav.isFree(x, z, agent.radius * 1.15)) continue;
        if (nav.built && !nav.lineOfSight(x, z, t.x, t.z, 0.12)) continue;
        const travel = Math.hypot(x - agent.px, z - agent.pz);
        const score = -travel - Math.abs(step) * 1.4;
        if (score > bestScore) { bestScore = score; bestX = x; bestZ = z; found = true; }
      }
      if (found) { agent.losSpotX = bestX; agent.losSpotZ = bestZ; agent.losSpotT = ctx.elapsed; }
      else { agent.losSpotX = t.x + Math.cos(base) * R.preferred; agent.losSpotZ = t.z + Math.sin(base) * R.preferred; agent.losSpotT = ctx.elapsed; }
    }

    const speed = agent.maxSpeed * agent.arch.sprintMul * 0.92;
    const d = this.pathTo(agent, ctx, agent.losSpotX, agent.losSpotZ, speed, 0.6);
    agent.setAnim(ANIM.run);
    this.faceVelocity(agent);

    if (d <= 0.9 || agent.stateT >= agent.stateDur) {
      agent.losSpotX = undefined;
      this._enter(agent, ctx, ST.KITE);
    }
  }

  sSummon(agent, ctx, dt) {
    const atk = agent.attack;
    if (!atk) { this._resume(agent, ctx); return; }
    agent.immovable = true;
    agent.avoidShare = 0.1;
    this.stand(agent);
    agent.setAnim(ANIM.summon);
    if (ctx.threat) { this.facePoint(agent, ctx.threat.x, ctx.threat.z); agent.turnScale = 0.6; }
    if (agent.stateT >= agent.stateDur) {
      agent.attackFrom.x = agent.px; agent.attackFrom.z = agent.pz; agent.attackFrom.yaw = agent.yaw;
      agent.attackHitDone = false;
      this._enter(agent, ctx, ST.STRIKE, atk.strike);
    }
  }

  sFlee(agent, ctx, dt) {
    const t = ctx.threat;
    agent.setAnim(ANIM.flee);
    const F = agent.arch.flee ?? { speedMul: 1.2, duration: 3 };
    const speed = agent.maxSpeed * F.speedMul;

    if (agent.fleeX === undefined || agent.stateT > 1.4) {
      const nav = ctx.nav;
      const away = t ? Math.atan2(agent.pz - t.z, agent.px - t.x) : agent.yaw;
      let bx = agent.px + Math.cos(away) * 12, bz = agent.pz + Math.sin(away) * 12;
      for (let i = 0; i < 9; i++) {
        const ang = away + (i === 0 ? 0 : (Math.ceil(i / 2) * 0.34) * (i % 2 ? 1 : -1));
        const x = agent.px + Math.cos(ang) * 12;
        const z = agent.pz + Math.sin(ang) * 12;
        if (!nav.built || nav.isFree(x, z, agent.radius * 1.1)) { bx = x; bz = z; break; }
      }
      agent.fleeX = bx; agent.fleeZ = bz;
      agent.stateT = Math.min(agent.stateT, 0.2);
    }

    this.pathTo(agent, ctx, agent.fleeX, agent.fleeZ, speed, 0.8);
    this.faceVelocity(agent);

    const dist = t ? Math.hypot(t.x - agent.px, t.z - agent.pz) : 99;
    if (agent.stateT >= agent.stateDur && dist > 11) {
      agent.fleeX = undefined;
      // Cowards stay gone; everything else re-engages once it has its nerve back.
      if (agent.arch.flee?.cowardly) {
        agent.fleeSpent = true;
        agent.homeX = agent.px; agent.homeZ = agent.pz;
        this._enter(agent, ctx, ST.PATROL);
      } else {
        agent.fleeSpent = true;
        this._resume(agent, ctx);
      }
    }
  }

  sStagger(agent, ctx, dt) {
    this.stand(agent);
    agent.avoidShare = 0.05;
    agent.setAnim(ANIM.stagger);
    agent.turnScale = 0.2;
    if (agent.stateT >= agent.stateDur) this._resume(agent, ctx);
  }

  sPhase(agent, ctx, dt) {
    this.stand(agent);
    agent.immovable = true;
    agent.avoidShare = 0;
    agent.setAnim(ANIM.roar);
    if (ctx.threat) { this.facePoint(agent, ctx.threat.x, ctx.threat.z); agent.turnScale = 0.7; }
    if (agent.boss && !agent.phaseDone) {
      agent.phaseDone = true;
      agent.boss.enterPhase(ctx);
    }
    if (agent.stateT >= agent.stateDur) {
      agent.phaseDone = false;
      this._enter(agent, ctx, ST.CHASE);
    }
  }

  sDead(agent, ctx, dt) {
    agent.prefX = 0; agent.prefZ = 0;
    agent.vx = 0; agent.vz = 0;
    agent.immovable = true;
    agent.avoidShare = 0;
    if (!agent.deathDone) {
      agent.deathDone = true;
      if (agent.telegraph) ctx.ai.endTelegraph(agent, true);
      ctx.ai.releaseToken(agent);
      agent.setAnim(ANIM.death);
    }
  }

  /* ---- shared exits ---- */

  _lose(agent, ctx) {
    ctx.ai.releaseToken(agent);
    if (ctx.elapsed - agent.lastSeenT < 8 && agent.lastSeenT > 0) {
      agent.stimX = agent.lastSeenX; agent.stimZ = agent.lastSeenZ;
      this._enter(agent, ctx, ST.INVESTIGATE, 6.5);
    } else {
      agent.awareness = Math.min(agent.awareness, 0.15);
      this._enter(agent, ctx, ST.PATROL);
    }
  }

  _windup(agent, atk) {
    let w = atk.windup;
    if (agent.enraged) w *= agent.arch.enrage?.castMul ?? 0.75;
    else if (agent.boss) w *= agent.boss.castMul;
    // A tiny per-agent spread stops a pack from telegraphing in unison, which
    // is both unreadable and obviously mechanical.
    return Math.max(0.12, w * (0.92 + agent.rnd() * 0.16));
  }
}

/* ------------------------------------------------------------------ *
 * dispatch tables
 * ------------------------------------------------------------------ */

const HANDLERS = {
  [ST.SPAWN]: (b, a, c, d) => b.sSpawn(a, c, d),
  [ST.IDLE]: (b, a, c, d) => b.sIdle(a, c, d),
  [ST.PATROL]: (b, a, c, d) => b.sPatrol(a, c, d),
  [ST.ALERT]: (b, a, c, d) => b.sAlert(a, c, d),
  [ST.INVESTIGATE]: (b, a, c, d) => b.sInvestigate(a, c, d),
  [ST.CHASE]: (b, a, c, d) => b.sChase(a, c, d),
  [ST.CIRCLE]: (b, a, c, d) => b.sCircle(a, c, d),
  [ST.WINDUP]: (b, a, c, d) => b.sWindup(a, c, d),
  [ST.STRIKE]: (b, a, c, d) => b.sStrike(a, c, d),
  [ST.RECOVER]: (b, a, c, d) => b.sRecover(a, c, d),
  [ST.KITE]: (b, a, c, d) => b.sKite(a, c, d),
  [ST.SEEK_LOS]: (b, a, c, d) => b.sSeekLos(a, c, d),
  [ST.SUMMON]: (b, a, c, d) => b.sSummon(a, c, d),
  [ST.FLEE]: (b, a, c, d) => b.sFlee(a, c, d),
  [ST.STAGGER]: (b, a, c, d) => b.sStagger(a, c, d),
  [ST.PHASE]: (b, a, c, d) => b.sPhase(a, c, d),
  [ST.DEAD]: (b, a, c, d) => b.sDead(a, c, d),
};

const ENTER = {
  [ST.SPAWN]: (b, a) => { a.stateDur = 0.15 + a.rnd() * 0.5; },
  [ST.PATROL]: (b, a, c) => { a.clearPath(); b._pickWander(a, c); a.wanderT = 0; a.lookBase = a.yaw; },
  [ST.IDLE]: (b, a) => { a.clearPath(); a.lookBase = a.yaw; },
  [ST.ALERT]: (b, a, c) => {
    const nb = a.arch.noticeBeat;
    a.stateDur = nb[0] + a.rnd() * (nb[1] - nb[0]);
    a.clearPath();
    c.ai.onNotice(a, c);
  },
  [ST.INVESTIGATE]: (b, a) => { a.clearPath(); if (!a.stateDur) a.stateDur = 6; },
  [ST.CHASE]: (b, a, c) => { a.reachRange = b._reach(a); c.ai.onEngage(a, c); },
  [ST.CIRCLE]: (b, a, c) => { a.clearPath(); c.ai.onEngage(a, c); },
  [ST.WINDUP]: (b, a, c) => {
    a.attackFrom.x = a.px; a.attackFrom.z = a.pz; a.attackFrom.yaw = a.yaw;
    a.clearPath();
    c.ai.beginTelegraph(a, a.attack, c);
  },
  [ST.SEEK_LOS]: (b, a) => { a.clearPath(); a.losSpotX = undefined; },
  [ST.FLEE]: (b, a, c) => { a.clearPath(); a.fleeX = undefined; c.ai.onFlee(a, c); },
  [ST.SUMMON]: (b, a, c) => { a.clearPath(); c.ai.beginTelegraph(a, a.attack, c); },
  [ST.PHASE]: (b, a) => { a.clearPath(); a.phaseDone = false; },
  [ST.DEAD]: (b, a) => { a.clearPath(); a.deathDone = false; },
};

const _pt = { x: 0, z: 0, ang: 0, radius: 0, dist: 0 };

export { wrapPi, clamp, sat };
