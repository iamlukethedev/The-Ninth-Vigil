/**
 * SANCTUM — pacing and combat intensity.
 *
 * Two jobs.
 *
 * 1. **Authoring curve.** `tensionAt(rank)` maps a room's normalised distance
 *    from the entrance (0 = mouth, 1 = boss chamber) to a target tension. The
 *    curve rises, but it breathes: quiet stretches between fights, a rising
 *    saw-tooth so density escalates unevenly rather than linearly, and a
 *    deliberate trough immediately before the boss so the arena lands hard.
 *
 * 2. **Runtime intensity.** A single 0..1 number that says how hot the fight is
 *    right now, from live threat presence plus a decaying "heat" pool fed by
 *    damage, casts and deaths. Attack is fast (a fight starts the instant the
 *    first blow lands) and release is slow (the frame should not snap back to
 *    calm the moment the last body drops). Audio and RenderPipeline both key off
 *    this, so it must be smooth and it must be deterministic.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Frame-rate independent exponential approach. */
const expo = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

export const INTENSITY_STATES = ['calm', 'stalk', 'skirmish', 'battle', 'peak'];

export class Pacing {
  /** @param {import('../../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    /** Smoothed 0..1 intensity — the published value. */
    this.value = 0;
    /** Raw target this frame, before smoothing. */
    this.target = 0;
    /** Decaying event pool: damage, casts, kills. */
    this.heat = 0;
    /** Highest value seen since the last reset. */
    this.peak = 0;
    /** Sustained fight length in seconds (0 when calm). */
    this.combatTime = 0;
    /** Seconds since intensity was last above `engagedAt`. */
    this.calmTime = 0;

    this.state = 'calm';
    this.prevState = 'calm';
    this.engaged = false;

    this.threat = 0;          // weighted live threat near the hero
    this.threatCount = 0;     // raw body count near the hero
    this.bossActive = false;
    this.waveActive = false;

    this.engagedAt = 0.16;    // threshold at which we call it "in combat"
    this._pub = -1;
    this._pubValue = -1;
  }

  reset() {
    this.value = 0;
    this.target = 0;
    this.heat = 0;
    this.peak = 0;
    this.combatTime = 0;
    this.calmTime = 0;
    this.state = 'calm';
    this.prevState = 'calm';
    this.engaged = false;
    this.threat = 0;
    this.threatCount = 0;
    this.bossActive = false;
    this.waveActive = false;
    this._pub = -1;
    this._pubValue = -1;
  }

  /* ------------------------------------------------------------ authoring */

  /**
   * @param {number} rank 0 at the entrance, 1 at the boss chamber
   * @returns {number} authored tension 0..1
   */
  tensionAt(rank) {
    const r = clamp01(rank);
    if (r >= 0.965) return 1;          // the boss chamber itself
    if (r > 0.855) return 0.05;        // the beat of calm right before it

    // Rising base with a superlinear tail so the back half escalates hard.
    const ramp = Math.pow(r, 0.80) * 0.72 + r * r * 0.16;
    // Two and a half breaths across the level: fight, lull, fight, lull, fight.
    const breath = 0.5 + 0.5 * Math.cos(r * Math.PI * 5.0);
    // Lulls are deep early (exploration) and shallow late (relentless).
    const lull = breath * (0.30 - r * 0.17);
    return clamp01(0.10 + ramp - lull);
  }

  /**
   * Encounter density from authored tension. Returns how many bodies a room of
   * this tension wants before difficulty density scaling.
   */
  packSizeFor(tension) {
    if (tension < 0.12) return 0;
    return Math.round(2 + tension * 6.4);
  }

  /* -------------------------------------------------------------- stimuli */

  noteDamage(amount = 0, toHero = false) {
    const a = Math.max(0, amount) || 0;
    // Damage taken reads as far more intense than damage dealt.
    this.heat = Math.min(1.35, this.heat + clamp01(a / (toHero ? 55 : 190)) * (toHero ? 0.52 : 0.20));
  }

  noteCast(weight = 1) {
    this.heat = Math.min(1.35, this.heat + 0.055 * weight);
  }

  noteDeath(rank = 'normal') {
    const bump = rank === 'boss' ? 0.85 : rank === 'champion' ? 0.30 : 0.12;
    this.heat = Math.min(1.35, this.heat + bump);
  }

  noteImpact(magnitude = 0.5) {
    this.heat = Math.min(1.35, this.heat + clamp01(magnitude) * 0.030);
  }

  /* ------------------------------------------------------------- per-frame */

  /**
   * @param {number} dt
   * @param {{threat:number, count:number, boss:boolean, wave:boolean, encounter:boolean}} ctx
   */
  update(dt, ctx) {
    this.threat = ctx.threat ?? 0;
    this.threatCount = ctx.count ?? 0;
    this.bossActive = !!ctx.boss;
    this.waveActive = !!ctx.wave;

    // Heat decays over ~3.2 s, so one heavy exchange keeps the mix hot for a
    // beat after it lands instead of flickering per hit.
    this.heat *= Math.exp(-dt / 3.2);
    if (this.heat < 1e-4) this.heat = 0;

    // Presence: five ordinary bodies in reach is a full-intensity brawl.
    const presence = clamp01(this.threat / 5.2);
    let target = Math.max(presence * 0.86, Math.min(1, this.heat));
    if (ctx.encounter) target = Math.max(target, 0.22);
    if (this.waveActive) target = Math.max(target, 0.58);
    if (this.bossActive) target = Math.max(target, 0.74);
    this.target = clamp01(target);

    // Asymmetric: snap up, ease down.
    const tau = this.target > this.value ? 0.30 : 1.85;
    this.value = clamp01(expo(this.value, this.target, dt, tau));
    if (this.value > this.peak) this.peak = this.value;

    const wasEngaged = this.engaged;
    this.engaged = this.value >= this.engagedAt;
    if (this.engaged) { this.combatTime += dt; this.calmTime = 0; }
    else { this.calmTime += dt; if (wasEngaged) this.combatTime = 0; }

    this.prevState = this.state;
    this.state = this.stateFor(this.value);
    return this.value;
  }

  stateFor(v) {
    if (v < 0.08) return 'calm';
    if (v < 0.26) return 'stalk';
    if (v < 0.52) return 'skirmish';
    if (v < 0.80) return 'battle';
    return 'peak';
  }

  /** Directly pose the curve (scenario setup). */
  force(value, { heat = null, engaged = null } = {}) {
    this.value = clamp01(value);
    this.target = this.value;
    if (heat != null) this.heat = heat;
    this.peak = Math.max(this.peak, this.value);
    this.state = this.stateFor(this.value);
    this.prevState = this.state;
    this.engaged = engaged == null ? this.value >= this.engagedAt : !!engaged;
    this.combatTime = this.engaged ? Math.max(this.combatTime, 2.4) : 0;
    this._pub = -1;
    this._pubValue = -1;
  }

  /**
   * Should we publish this frame? True on a state change, on a meaningful value
   * move, or at least every 10 frames while engaged.
   */
  shouldPublish(frame) {
    if (this.state !== this.prevState) return true;
    if (Math.abs(this.value - this._pubValue) >= 0.02) return true;
    return frame - this._pub >= (this.engaged ? 10 : 30);
  }

  markPublished(frame) {
    this._pub = frame;
    this._pubValue = this.value;
  }

  snapshot() {
    return {
      value: this.value,
      target: this.target,
      state: this.state,
      peak: this.peak,
      heat: Math.min(1, this.heat),
      engaged: this.engaged,
      combatTime: this.combatTime,
      calmTime: this.calmTime,
      threat: this.threat,
      threatCount: this.threatCount,
      boss: this.bossActive,
      wave: this.waveActive,
    };
  }
}

export default Pacing;
