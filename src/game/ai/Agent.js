/**
 * THE NINTH VIGIL — AI agent record + entity adapter.
 *
 * The AI owns *decisions and motion*; Bestiary owns *bodies and animation*. This
 * file is the seam. Because Bestiary is written by another agent and may expose
 * any of a dozen plausible shapes, the adapter probes an entity once, caches the
 * hooks it found, and degrades all the way down to "write position directly".
 *
 * Nothing in here allocates per frame.
 */

import { buildArchetype } from './Archetypes.js';

export const ST = {
  SPAWN: 'spawn',
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  INVESTIGATE: 'investigate',
  CHASE: 'chase',
  CIRCLE: 'circle',
  WINDUP: 'windup',
  STRIKE: 'strike',
  RECOVER: 'recover',
  KITE: 'kite',
  SEEK_LOS: 'seeklos',
  SUMMON: 'summon',
  FLEE: 'flee',
  STAGGER: 'stagger',
  PHASE: 'phase',
  DEAD: 'dead',
};

/** Canonical animation names the AI asks a body to play. */
export const ANIM = {
  idle: 'idle', walk: 'walk', run: 'run', alert: 'alert', look: 'look',
  windup: 'attack_windup', strike: 'attack', recover: 'attack_recover',
  cast: 'cast', summon: 'summon', flee: 'run', stagger: 'hit', death: 'death',
  strafe: 'strafe', backpedal: 'walk_back', roar: 'roar',
};

let AGENT_SEQ = 0;

export class Agent {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {object} entity the body owned by Bestiary
   */
  constructor(engine, entity, opts = {}) {
    this.engine = engine;
    this.entity = entity;
    this.seq = AGENT_SEQ++;
    this.id = String(entity?.id ?? entity?.uuid ?? entity?.name ?? `agent${this.seq}`);
    this.seed = (hashStr(this.id) ^ (this.seq * 2654435761)) >>> 0;
    this.rnd = (engine.freshRand ?? engine.rand).call(engine, this.seed);
    this.lane = (this.seed % 977) * 0.7139;      // noise lane, stable per agent

    this.arch = buildArchetype(entity);
    this.faction = entity?.faction ?? 'enemy';
    this.active = true;
    this.dead = false;
    this.__failures = 0;

    /* ---- kinematics ---- */
    this.px = 0; this.pz = 0; this.py = 0;
    this.vx = 0; this.vz = 0;
    this.pvx = 0; this.pvz = 0;                  // previous-frame velocity (RVO)
    this.prefX = 0; this.prefZ = 0;
    this.yaw = 0;
    this.faceYaw = 0;
    this.speed = 0;
    this.radius = this.arch.radius;
    this.height = this.arch.height;
    this.mass = this.arch.mass;
    this.maxSpeed = this.arch.speed;
    this.personalSpace = Math.max(0.22, this.radius * 0.62);
    this.immovable = false;
    this.avoidShare = 0.5;
    this.eyeY = 0;
    this.groundY = 0;

    /* ---- state machine ---- */
    this.state = ST.SPAWN;
    this.prevState = ST.SPAWN;
    this.stateT = 0;
    this.stateDur = 0;
    this.anim = '';
    this.animLocked = 0;

    /* ---- perception ---- */
    this.awareness = 0;
    this.canSeeTarget = false;
    this.losOk = false;
    this.losAt = -99;
    this.lastSeenX = 0; this.lastSeenZ = 0; this.lastSeenT = -99;
    this.stimX = 0; this.stimZ = 0; this.stimT = -99;
    this.heardRecently = false;
    this.lastNoiseAt = -99;

    /* ---- navigation ---- */
    this.path = [];
    this.pathCursor = 0;
    this.pathGoalX = 0; this.pathGoalZ = 0;
    this.pathAt = -99;
    this.pathStatus = 'fail';
    this.repathQueued = false;
    this.repathPriority = 0;
    this.stuckT = 0;
    this.lastProgressX = 0; this.lastProgressZ = 0;

    /* ---- combat ---- */
    this.hp = 1; this.maxHp = 1; this.hpFrac = 1;
    this.attack = null;                          // committed attack definition
    this.attackFrom = { x: 0, z: 0, yaw: 0 };
    this.attackHitDone = false;
    this.cooldowns = new Map();
    this.globalCd = 0;
    this.hasToken = false;
    this.tokenSince = -99;
    this.tokenWaited = 0;
    this.slot = -1;
    this.slotAngle = 0;
    this.role = 'melee';                         // melee | ranged | caster | boss
    this.flankSign = 1;
    this.attacksLanded = 0;
    this.telegraph = null;
    this.boss = null;                            // BossController when applicable
    this.encounter = null;

    /* ---- patrol ---- */
    this.homeX = 0; this.homeZ = 0;
    this.wanderX = 0; this.wanderZ = 0;
    this.wanderT = 0;
    this.lookYaw = 0;

    /* ---- LOD ---- */
    this.tickInterval = 0;
    this.acc = 0;
    this.lod = 0;
    this.distToCam = 0;
    this.onScreen = true;

    this.adapter = new EntityAdapter(entity);
    this._readPose(true);
    this.homeX = opts.homeX ?? this.px;
    this.homeZ = opts.homeZ ?? this.pz;
    this.wanderX = this.homeX; this.wanderZ = this.pz;
    this.lastProgressX = this.px; this.lastProgressZ = this.pz;
    this.role = this.arch.isBoss ? 'boss'
      : this.arch.summon ? 'caster'
        : this.arch.ranged ? 'ranged' : 'melee';
    this.flankSign = (this.seed & 1) ? 1 : -1;
    this.slotAngle = ((this.seed >>> 3) % 1000) / 1000 * Math.PI * 2;
    this.maxSpeed = this.arch.speed;
  }

  /* ================================================================ *
   * entity <-> agent transfer
   * ================================================================ */

  /** Pull position, health and liveness from the body. */
  syncFromEntity() {
    const a = this.adapter;
    const beforeX = this.px, beforeZ = this.pz;
    this._readPose(false);

    // Advisory-drive watchdog. If we have been handing a body a desired velocity
    // for a while and it has not moved despite us asking for real speed, it does
    // not actually integrate — take the transform over rather than leaving a
    // pack of enemies frozen in place.
    if (a.advisory) {
      const asked = Math.hypot(this.vx, this.vz);
      const moved = Math.hypot(this.px - beforeX, this.pz - beforeZ);
      if (asked > 0.6 && moved < 1e-4) {
        if (++a.stalled > 20) { a.setDesiredVelocity = null; a.moveTo = null; a.advisory = false; a.stalled = 0; }
      } else if (moved > 1e-4) {
        a.stalled = 0;
      }
    }

    const hp = a.readHp();
    if (hp) {
      this.hp = hp.hp; this.maxHp = hp.max;
      this.hpFrac = hp.max > 0 ? Math.max(0, Math.min(1, hp.hp / hp.max)) : 1;
    }
    const dead = a.readDead();
    if (dead !== null) this.dead = dead;
    if (this.dead && this.state !== ST.DEAD) this.setState(ST.DEAD);
  }

  _readPose(initial) {
    const p = this.adapter.position;
    if (p) {
      if (Number.isFinite(p.x)) this.px = p.x;
      if (Number.isFinite(p.z)) this.pz = p.z;
      if (Number.isFinite(p.y)) this.py = p.y;
    }
    if (initial) {
      this.yaw = this.adapter.readYaw() ?? 0;
      this.faceYaw = this.yaw;
    }
    this.eyeY = this.py + this.height * 0.86;
  }

  /** Push motion + facing + animation back onto the body. */
  writeToEntity(dt, terrain) {
    const a = this.adapter;
    // Ground the body. Bestiary may own its own vertical placement (jump arcs,
    // ragdolls) — if it advertises that, we leave y alone.
    let y = this.py;
    if (!a.ownsVertical && terrain) {
      const h = terrain(this.px, this.pz);
      if (Number.isFinite(h)) y = h + (a.groundOffset || 0);
    }
    this.py = y;
    this.eyeY = y + this.height * 0.86;
    a.writeMotion(this.px, y, this.pz, this.vx, this.vz, dt);
    a.writeYaw(this.yaw);
    if (this.anim) a.writeAnim(this.anim, this.speed);
  }

  /* ================================================================ *
   * state machine plumbing
   * ================================================================ */

  setState(next, dur = 0) {
    if (this.state === next) { if (dur) this.stateDur = dur; return; }
    this.prevState = this.state;
    this.state = next;
    this.stateT = 0;
    this.stateDur = dur;
  }

  setAnim(name) {
    if (name && this.anim !== name) this.anim = name;
  }

  cdReady(id) {
    const t = this.cooldowns.get(id);
    return t === undefined || this.engine.clock.elapsed >= t;
  }
  setCd(id, seconds) {
    this.cooldowns.set(id, this.engine.clock.elapsed + Math.max(0, seconds));
  }
  cdRemaining(id) {
    const t = this.cooldowns.get(id);
    return t === undefined ? 0 : Math.max(0, t - this.engine.clock.elapsed);
  }

  /** Deterministic per-agent noise in [-1, 1]. */
  wobble(freq, phase = 0) {
    const t = this.engine.clock.elapsed * freq + this.lane + phase;
    return Math.sin(t) * 0.62 + Math.sin(t * 1.618 + 1.7) * 0.38;
  }

  clearPath() {
    this.path.length = 0;
    this.pathCursor = 0;
    this.pathStatus = 'fail';
  }

  dispose() {
    this.cooldowns.clear();
    this.path.length = 0;
    this.entity = null;
    this.adapter.entity = null;
  }
}

/* ================================================================== *
 * EntityAdapter
 * ================================================================== */

const NUM = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const FN = (o, k) => (o && typeof o[k] === 'function' ? o[k].bind(o) : null);

/**
 * Discovers, once, how to read and drive a body. Every hook is optional; the
 * final fallback (write `position` and `rotation.y` directly) always works for
 * anything that is at least an Object3D-ish holder.
 */
export class EntityAdapter {
  constructor(entity) {
    this.entity = entity;
    const e = entity ?? {};

    /* ---- transform holder ---- */
    this.root = e.root ?? e.group ?? e.object3D ?? e.obj ?? e.model ?? e.mesh ?? (e.isObject3D ? e : null);
    this.position = pickVec(e.position) ?? pickVec(this.root && this.root.position) ?? null;
    if (!this.position && this.root && this.root.position) this.position = this.root.position;

    /* ---- motion hooks, best first ---- */
    this.setDesiredVelocity = FN(e, 'setDesiredVelocity') ?? FN(e, 'setMoveInput')
      ?? FN(e, 'setVelocity') ?? FN(e, 'steer') ?? FN(e, 'setDesiredVel');
    this.moveTo = FN(e, 'moveTo') ?? FN(e, 'setMoveTarget') ?? FN(e, 'navigateTo');
    this.setPosition = FN(e, 'setPosition') ?? FN(e, 'setWorldPosition') ?? FN(e, 'teleport');

    /* ---- facing ---- */
    this.setFacing = FN(e, 'setFacing') ?? FN(e, 'setYaw') ?? FN(e, 'faceAngle');
    this.lookAt2D = FN(e, 'faceTo') ?? FN(e, 'lookAtXZ');

    /* ---- animation ---- */
    this.setAnimState = FN(e, 'setAnimState') ?? FN(e, 'setAnimation') ?? FN(e, 'playAnimation')
      ?? FN(e, 'play') ?? FN(e, 'setAnim') ?? FN(e, 'setPose') ?? FN(e, 'setActionState');

    /* ---- health ---- */
    this.getHealth = FN(e, 'getHealth') ?? FN(e, 'health') ?? null;

    /* ---- misc ---- */
    this.ownsVertical = e.aiOwnsVertical === true || e.ownsVertical === true
      || e.airborne === true || typeof e.groundedY === 'number';
    this.groundOffset = NUM(e.groundOffset) ?? NUM(e.aiGroundOffset) ?? 0;
    this.velocityVec = pickVec(e.velocity) ?? pickVec(e.vel) ?? null;
    this._animLast = '';
    this.advisory = !!(this.setDesiredVelocity || this.moveTo);
    this.stalled = 0;
  }

  readHp() {
    const e = this.entity;
    if (!e) return null;
    if (this.getHealth) {
      try {
        const h = this.getHealth();
        if (typeof h === 'number') return { hp: h, max: NUM(e.maxHp) ?? NUM(e.maxHealth) ?? Math.max(h, 1) };
        if (h && typeof h === 'object') {
          const hp = NUM(h.hp) ?? NUM(h.current) ?? NUM(h.value);
          const max = NUM(h.max) ?? NUM(h.maxHp) ?? NUM(h.total);
          if (hp != null) return { hp, max: max ?? Math.max(hp, 1) };
        }
      } catch { /* fall through */ }
    }
    const hp = NUM(e.hp) ?? NUM(e.health) ?? NUM(e.life) ?? NUM(e.currentHealth);
    if (hp == null) return null;
    const max = NUM(e.maxHp) ?? NUM(e.maxHealth) ?? NUM(e.healthMax) ?? NUM(e.maxLife) ?? Math.max(hp, 1);
    return { hp, max };
  }

  readDead() {
    const e = this.entity;
    if (!e) return true;
    if (typeof e.dead === 'boolean') return e.dead;
    if (typeof e.isDead === 'boolean') return e.isDead;
    if (typeof e.alive === 'boolean') return !e.alive;
    if (typeof e.isAlive === 'boolean') return !e.isAlive;
    const hp = this.readHp();
    if (hp && hp.max > 0) return hp.hp <= 0;
    return null;
  }

  readYaw() {
    const e = this.entity;
    if (!e) return null;
    const y = NUM(e.yaw) ?? NUM(e.facing) ?? NUM(e.heading) ?? NUM(e.aiYaw);
    if (y != null) return y;
    const r = this.root;
    if (r && r.rotation && Number.isFinite(r.rotation.y)) return meshYawToAgentYaw(r.rotation.y);
    return null;
  }

  writeMotion(x, y, z, vx, vz, dt) {
    const e = this.entity;
    if (!e) return;
    if (this.setDesiredVelocity) {
      // The body integrates; we only ever advise. Still mirror the authoritative
      // XZ so our own bookkeeping and the body cannot drift apart.
      try { this.setDesiredVelocity(vx, vz, dt); } catch { this.setDesiredVelocity = null; }
      this._syncPos(x, y, z, true);
      return;
    }
    if (this.moveTo) {
      try { this.moveTo(x + vx * 0.15, z + vz * 0.15); } catch { this.moveTo = null; }
      this._syncPos(x, y, z, true);
      return;
    }
    this._syncPos(x, y, z, false);
    if (this.velocityVec) { this.velocityVec.x = vx; this.velocityVec.z = vz; }
    if (typeof e.speed === 'number') e.speed = Math.hypot(vx, vz);
  }

  _syncPos(x, y, z, advisory) {
    const e = this.entity;
    if (advisory) {
      // The body owns its transform: read back rather than fight it.
      const p = this.position;
      if (p && Number.isFinite(p.x)) return;
    }
    if (this.setPosition) {
      try { this.setPosition(x, y, z); return; } catch { this.setPosition = null; }
    }
    const p = this.position;
    if (p) { p.x = x; p.y = y; p.z = z; }
    const r = this.root;
    if (r && r.position && r.position !== p) r.position.set(x, y, z);
    if (e && e.px !== undefined) { e.px = x; e.pz = z; }
  }

  writeYaw(yaw) {
    const e = this.entity;
    // Always publish the authoritative value so a body that prefers to drive its
    // own skeleton has something to read.
    if (e) e.aiYaw = yaw;
    if (this.setFacing) { try { this.setFacing(yaw); return; } catch { this.setFacing = null; } }
    if (this.lookAt2D) {
      try { this.lookAt2D(Math.cos(yaw), Math.sin(yaw)); return; } catch { this.lookAt2D = null; }
    }
    if (e && typeof e.yaw === 'number') e.yaw = yaw;
    const r = this.root;
    if (r && r.rotation) r.rotation.y = agentYawToMeshYaw(yaw);
  }

  writeAnim(name, speed) {
    if (name === this._animLast) return;
    this._animLast = name;
    if (this.setAnimState) {
      try { this.setAnimState(name, speed); return; } catch { this.setAnimState = null; }
    }
    const e = this.entity;
    if (e) { e.animState = name; e.aiState = name; }
  }
}

function pickVec(v) {
  return v && typeof v === 'object' && typeof v.x === 'number' && typeof v.z === 'number' ? v : null;
}

/**
 * Agent yaw is the XZ heading measured from +X toward +Z: dir = (cos y, sin y).
 * A three.js mesh authored facing local -Z, rotated by θ about Y, points along
 * (-sin θ, -cos θ). Equating the two gives the conversions below.
 */
export function agentYawToMeshYaw(yaw) {
  return Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
}
export function meshYawToAgentYaw(theta) {
  return Math.atan2(-Math.cos(theta), -Math.sin(theta));
}

export function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
