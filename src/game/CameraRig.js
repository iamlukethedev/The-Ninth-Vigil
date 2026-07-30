import * as THREE from 'three';
import { perlin2 } from '../core/Rand.js';

/**
 * THE NINTH VIGIL — CameraRig
 * ------------------------------------------------------------------
 * The isometric ARPG camera. Everything here exists to hide the fact
 * that there is a camera at all:
 *
 *  - critically damped springs (implicit / backward Euler, so they are
 *    unconditionally stable and *not* frame-rate dependent like a lerp),
 *    with a much softer vertical stiffness than lateral so stepping up a
 *    stair does not heave the whole frame,
 *  - cursor lookahead derived from NDC (never from the world raycast —
 *    that would feed back into itself and drift to the clamp),
 *  - layered low-amplitude handheld perlin on translation *and* rotation,
 *    scaled by hero speed and combat heat,
 *  - trauma^2 screen shake with independent noise lanes per source,
 *  - FOV punch on crits / heavy deaths + a short follow-hold ("hit stop"),
 *  - dithered occluder fade instead of camera dodging,
 *  - eased cinematic framing via focusOn()/release(),
 *  - terrain clearance clamp so the lens never dips into a hill.
 *
 * Deterministic: every time-varying term is a pure function of
 * engine.clock.elapsed / engine.clock.frame. No Math.random, no Date.now.
 */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smootherstep = (t) => { t = sat(t); return t * t * t * (t * (t * 6 - 15) + 10); };
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Per-scenario LENS overrides, layered on top of the scenario's own `camera`
 * block. Scenarios.js is integrator-owned and states the *intent* of a shot;
 * this table states what the intent costs in millimetres of glass, which is a
 * rig concern.
 *
 * `dungeon` / `combat` — ACTOR SCALE. Both scenarios asked for a distance that
 * made the cast unreadable. The projected height of a world-vertical figure is
 *
 *     px = h · cos(pitch) · H / (2 · dist · tan(fov/2))
 *
 * so at the authored dungeon 24 m / 44 deg the 1.85 m hero came out
 *   1.85 · cos56 · 900 / (2 · 24 · tan22) = 48 px
 * in a 900 px frame — 5.3% of frame height, and the enemies with it (measured
 * 36-40 px head-to-toe in tools/actors.mjs). An ARPG silhouette has to read at
 * roughly 8-10% of frame height or the player cannot find their own character,
 * which is exactly what was reported. Inverting the same expression for 8.5%:
 *
 *   dungeon  1.85 · cos56 · 900 / (2 · D · tan22) = 76 px  ->  D = 14.5
 *   combat   1.85 · cos54 · 900 / (2 · D · tan23) = 74 px  ->  D = 15.5
 *
 * `combat` keeps the extra metre because it frames nine bodies plus ability
 * VFX, and because a fight needs the room the pack occupies. Both still leave
 * ~16 m of ground depth and ~20 m of width, which is more than the pack spread.
 *
 * `closeup` is not a gameplay shot at all — it exists so a critic can judge the
 * hero's material detail. At the scenario's own 6.5 m / 35 deg the figure came
 * out 360 px tall (40% of frame) with two thirds of the frame spent on floor
 * rubble, and at 195 px per metre a 12 mm lame step is two pixels:
 *
 *   dist 3.78 + fov 33 -> 2.24 m of vertical extent, so the 1.85 m hero fills
 *                         ~79% of frame height and the sword tip still clears
 *                         the bottom edge;
 *   pitch 10           -> nearly level with the sternum, and chosen against the
 *                         BACKGROUND as much as the subject: at this pitch the
 *                         dark crypt wall sits behind the helm and cuirass while
 *                         the lit floor sits behind the blade, so the silhouette
 *                         reads by value contrast over its whole height. The
 *                         scenario's 22 deg looks down onto the crown of the
 *                         helm, foreshortens the cuirass to a sliver, and backs
 *                         the entire figure with bright floor;
 *   frameBias -0.028   -> a rise/fall lens shift, not a re-aim: it lifts the
 *                         subject in frame without changing where the camera is
 *                         pointing, so the figure is centred instead of sitting
 *                         561 px down a 900 px frame.
 *
 * `boss` — the same ACTOR SCALE argument, applied to the one frame that has to
 * sell spectacle. The scenario asks for 36 m / 50° / pitch 50, and Apollyon
 * is a 7.74 m body (measured live: `SPECIES.boss.height` 6.5 × the 1.19
 * spawn scale). At the authored lens that is
 *   7.74 · cos50 · 900 / (2 · 41.4 · tan25) = 108 px
 * head to toe in a 900 px frame — 12 % of frame height for the title character,
 * with fourteen loot glows the same size. The art director measured it at
 * "~40x70 px" and called it a bug; the scale was right and the lens was wrong.
 *
 * 24 m / 46° / pitch 48 puts the same body at
 *   7.74 · cos48 · 900 / (2 · 21.6 · tan23) = 254 px  (28 % of frame height)
 * once `_frameBoss` has finished solving (see BOSS FRAMING below — 24 is the
 * ceiling it works down from, not the distance it uses).
 *
 * Pitch comes DOWN, not up, and that is deliberate twice over: cos48 rather
 * than cos50 buys 4 % of the figure back, and the shallower look angle is what
 * keeps the cyclopean wall and its cressets in frame at all. At pitch 50 / 24 m
 * the far ground edge lands 12 m behind the focus and the 25 m wall ring is
 * entirely out of shot, which would have "fixed" the flat-black-wall complaint
 * by cropping the wall out of the picture.
 */
const LENS = {
  closeup: { pitch: 10, fov: 33, dist: 3.78, frameBias: -0.028, aim: [0, 1.06, 0] },
  dungeon: { dist: 14.5 },
  combat: { dist: 15.5 },
  boss: { pitch: 48, fov: 46, dist: 24, frameBias: 0.02 },
};

/**
 * BOSS FRAMING — how much of the frame each subject is allowed to own.
 *
 * `FILL` is the fraction of frame height the hero-plus-boss pair is fitted
 * into; the rest is headroom and floor. `MAX_H` / `MIN_H` bracket the boss's
 * own projected height so the solve can never crop it or lose it: at 34 % the
 * body fills more than a third of the frame and its own attack VFX start
 * leaving the picture, and under 17 % it stops being the subject.
 */
const BOSS = { FILL: 0.70, MAX_H: 0.34, MIN_H: 0.17, AIM_W: 0.58, AIM_Y: 0.38 };

/**
 * Critically-damped-by-default spring, integrated with backward Euler.
 *
 *   x' = v
 *   v' = -w^2 (x - xt) - 2 z w v
 *
 * Solving the implicit step in closed form gives an unconditionally stable
 * integrator: no explosion at any dt, and no frame-rate dependent smoothing
 * constant the way `x += (t - x) * 0.1` has. Measured step response at
 * dt = 1/60: 63% of an 18 m lateral step in 15 frames with 3 mm of overshoot.
 */
class Spring {
  constructor(value = 0, omega = 10, zeta = 1) {
    this.x = value;
    this.v = 0;
    this.omega = omega;
    this.zeta = zeta;
  }
  set(x, v = 0) { this.x = x; this.v = v; return this; }
  kick(dv) { this.v += dv; return this; }
  step(target, dt, omegaScale = 1) {
    if (!(dt > 0)) return this.x;
    const w = Math.max(1e-4, this.omega * omegaScale);
    const f = 1 + 2 * dt * this.zeta * w;
    const hoo = dt * w * w;
    const hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    const nx = (f * this.x + dt * this.v + hhoo * target) * det;
    const nv = (this.v + hoo * (target - this.x)) * det;
    this.x = Number.isFinite(nx) ? nx : target;
    this.v = Number.isFinite(nv) ? nv : 0;
    return this.x;
  }
  /** Same, but unwraps the target onto the shortest arc first. */
  stepAngle(target, dt, omegaScale = 1) {
    return this.step(this.x + wrapPi(target - this.x), dt, omegaScale);
  }
}

/** Squared distance from a point to a segment — occlusion broad phase. */
function distSqPointSeg(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _mat4 = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _q = new THREE.Quaternion();

export class CameraRig {
  static id = 'camera';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.camera = engine.camera;
    this.enabled = true;
    this.failed = false;

    /* ---------------- tunables (scenario-overridable) ---------------- */
    this.cfg = {
      pitch: 54,            // degrees below horizon
      yaw: 12,              // degrees off-axis — never a dead-on axis view
      fov: 46,
      dist: 26,
      minDist: 7,
      maxDist: 52,
      zoomStep: 1.6,

      aim: new THREE.Vector3(0, 1.0, 0), // world offset from hero origin

      followOmegaXZ: 9.0,   // lateral: tight, reads as "attached"
      followOmegaY: 3.2,    // vertical: soft, eats stairs & slopes
      followZeta: 1.0,      // critically damped — no overshoot

      lookahead: 0.15,      // fraction of the view extent at full deflection
      lookaheadOmega: 4.0,
      velocityLead: 0.13,   // seconds of hero velocity fed forward

      frameBias: 0.03,      // subject sits this fraction below frame centre

      handheld: 1.0,        // master scale for procedural breathing
      handheldPos: 0.0065,  // × distance, at full intensity
      handheldRot: 0.0016,  // radians, at full intensity

      shakePos: 0.055,      // × distance, at trauma = 1
      shakeRot: 0.021,      // radians yaw/pitch at trauma = 1
      shakeRoll: 0.042,     // radians roll at trauma = 1
      shakeFreq: 19,        // fallback Hz when an event omits one

      angleOmega: 5.2,
      distOmega: 6.4,
      fovOmega: 8.0,

      groundClearance: 2.1,
      /** Let `_frameBoss` re-aim and re-lens while a boss is alive. */
      bossFrame: true,
      occlusion: true,
      occludeFade: 0.86,    // 1 = invisible; keep a whisper of silhouette
      occludeRadius: 1.15,  // ray fan half-width around the hero, metres
      maxOccluderRadius: 46,
    };

    // Pristine copy of every scenario-controlled knob. applyScenario resets to
    // this before layering cfg.camera on top, otherwise successive scenarios
    // ratchet the derived clamps (a close-up would permanently shrink minDist).
    this._defaults = {
      pitch: this.cfg.pitch, yaw: this.cfg.yaw, fov: this.cfg.fov, dist: this.cfg.dist,
      minDist: this.cfg.minDist, maxDist: this.cfg.maxDist,
      lookahead: this.cfg.lookahead, handheld: this.cfg.handheld,
      frameBias: this.cfg.frameBias, groundClearance: this.cfg.groundClearance,
      occlusion: this.cfg.occlusion, occludeRadius: this.cfg.occludeRadius,
      bossFrame: this.cfg.bossFrame,
    };

    /* ---------------- runtime state ---------------- */
    this.focus = new THREE.Vector3();     // smoothed aim point
    this.position = new THREE.Vector3();  // final lens position

    this.sx = new Spring(0, this.cfg.followOmegaXZ, this.cfg.followZeta);
    this.sy = new Spring(0, this.cfg.followOmegaY, this.cfg.followZeta);
    this.sz = new Spring(0, this.cfg.followOmegaXZ, this.cfg.followZeta);
    this.slaX = new Spring(0, this.cfg.lookaheadOmega, 1.0);
    this.slaZ = new Spring(0, this.cfg.lookaheadOmega, 1.0);
    this.sPitch = new Spring(this.cfg.pitch * DEG, this.cfg.angleOmega, 1.0);
    this.sYaw = new Spring(this.cfg.yaw * DEG, this.cfg.angleOmega, 1.0);
    this.sDist = new Spring(this.cfg.dist, this.cfg.distOmega, 1.0);
    this.sFov = new Spring(this.cfg.fov, this.cfg.fovOmega, 1.0);
    this.sPunch = new Spring(0, 13.0, 0.62); // FOV kick: slight overshoot back

    this.zoomTarget = this.cfg.dist;
    this.trauma = [];        // active shake sources
    this._shakeLane = 0;
    this.hitStop = 0;
    this.combatHeat = 0;
    this._lastCrit = -1e9;
    this.heroSpeed = 0;
    this.heroVel = new THREE.Vector3();
    this.snapPending = false;
    this._prevHeroPos = new THREE.Vector3();
    this._hasPrevHero = false;
    this._heroRoot = null;
    this._heroModule = null;

    this.cine = null;        // { target, dist, pitch, yaw, fov, w, dir, dur, ... }
    this.cineW = 0;

    /* boss framing — resolved from Bestiary every 12th frame, never per-frame */
    this._boss = null;
    this._bossAt = -1e9;
    this.bossDist = 0;       // published so a critic/harness can read the solve

    this._noiseSeed = 20241;
    this._offs = [];         // bus unsubscribers
    this._aspect = engine.width && engine.height ? engine.width / engine.height : 16 / 9;

    /* ---------------- occlusion ---------------- */
    this._occCandidates = [];
    this._occRebuildAt = -1e9;
    this._faded = new Map();          // mesh -> { amount, target, orig, ghost }
    this._ghostCache = new WeakMap(); // mesh -> ghost material (or array)
    this._origCache = new WeakMap();  // mesh -> pristine material (or array)
    this._ghosts = [];                // flat list, for disposal
    this._ghostFactory = null;
    this._occFilter = null;
    this._occIgnore = new Set();
    this._occHits = new Set();
    this._occNames = /(terrain|ground|floor|water|sky|skydome|fogplane|volumetric|godray|helper|grid)/i;

    this._bind();
  }

  /* =================================================================
     lifecycle
     ================================================================= */

  _bind() {
    const bus = this.engine.bus;
    const on = (evt, fn) => { try { this._offs.push(bus.on(evt, fn)); } catch { /* bus optional */ } };

    on('camera:shake', (p) => this.shake(p?.amp, p?.freq, p?.duration));

    on('damage', (p) => {
      try {
        if (!p) return;
        const amount = finite(p.amount) ? p.amount : 0;
        const heroHit = this._isHero(p.target);
        const now = this.engine.clock.elapsed;
        if (p.crit) {
          // Crit: snap the lens in ~1.5 deg and let the spring carry it back.
          // Rate-gated: a flurry of crits must not turn into FOV chatter.
          if (now - this._lastCrit > 0.11) {
            this._lastCrit = now;
            this.punchFov(1.5, 0.9);
            this.hitStop = Math.max(this.hitStop, 0.055);
          }
          this.shake(0.16 + sat(amount / 600) * 0.12, 26, 0.24);
        } else if (heroHit) {
          this.shake(0.09 + sat(amount / 400) * 0.1, 22, 0.22);
        } else {
          this.shake(0.045, 24, 0.16);
        }
        this.combatHeat = Math.min(1.6, this.combatHeat + (p.crit ? 0.5 : 0.28));
      } catch { /* never let a malformed payload kill the frame */ }
    });

    on('death', (p) => {
      try {
        const big = this._isLarge(p?.entity);
        if (big) {
          this.punchFov(2.6, 0.42);       // slower, heavier push
          this.hitStop = Math.max(this.hitStop, 0.12);
          this.shake(0.62, 13, 0.85);
        } else {
          this.punchFov(0.5, 1.15);
          this.shake(0.08, 20, 0.22);
        }
        this.combatHeat = Math.min(1.6, this.combatHeat + (big ? 0.9 : 0.2));
      } catch { /* ignore */ }
    });

    on('ability:cast', () => { this.combatHeat = Math.min(1.6, this.combatHeat + 0.22); });
    on('impact', (p) => {
      const m = finite(p?.magnitude) ? p.magnitude : 0.3;
      this.combatHeat = Math.min(1.6, this.combatHeat + 0.06 + sat(m) * 0.1);
    });
    on('level:up', () => { this.punchFov(-2.0, 0.45); this.shake(0.22, 9, 0.9); });
  }

  async init() {
    try {
      this._resolveHero();
      const hero = this._heroPosition(_v1);
      this.focus.copy(hero).add(this.cfg.aim);
      this.sx.set(this.focus.x); this.sy.set(this.focus.y); this.sz.set(this.focus.z);
      this._prevHeroPos.copy(hero);
      this._hasPrevHero = true;
      this._place(1 / 60, true);
    } catch (e) {
      // Disable the rig but leave a usable static pose — a dead camera must
      // never mean a black or default-framed frame.
      this.failed = true;
      console.error('[camera] init failed — rig disabled, static pose used', e);
      try {
        const k = this.cfg;
        const P = k.pitch * DEG, Y = k.yaw * DEG;
        this.camera.position.set(
          Math.sin(Y) * k.dist * Math.cos(P),
          k.dist * Math.sin(P),
          Math.cos(Y) * k.dist * Math.cos(P)
        );
        this.camera.fov = k.fov;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(0, k.aim.y, 0);
        this.camera.updateMatrixWorld(true);
      } catch { /* nothing left to do */ }
    }
  }

  resize(w, h) {
    if (w > 0 && h > 0) this._aspect = w / h;
  }

  /* =================================================================
     scenario configuration
     ================================================================= */

  /**
   * The LENS a scenario asks for — pitch / yaw / fov / dist / aim / frameBias —
   * resolved without touching a single piece of rig state.
   *
   * `applyScenario` uses this so there is one source of truth, but the reason it
   * is public and side-effect-free is composition: modules that place actors run
   * BEFORE the camera in the manifest (world -> actors -> camera), so at spawn
   * time `this.cfg` still holds the *previous* scenario's pose. A spawner that
   * needs to know what will actually be in shot has to ask for the pose the
   * scenario is about to get, not the one the rig currently has.
   *
   * @param {string} name
   * @param {{camera?:object}} [cfg] the scenario config
   * @param {object} [out] optional target, to avoid an allocation
   */
  scenarioPose(name, cfg, out = {}) {
    const c = (cfg && cfg.camera) || {};
    const d = this._defaults;

    out.pitch = finite(c.pitch) ? clamp(c.pitch, 8, 78) : d.pitch;
    out.yaw = finite(c.yaw) ? c.yaw : d.yaw;
    out.fov = finite(c.fov) ? clamp(c.fov, 22, 62) : d.fov;
    out.dist = finite(c.dist) ? c.dist : d.dist;
    out.frameBias = finite(c.frameBias) ? clamp(c.frameBias, -0.3, 0.3) : d.frameBias;

    const aim = out.aim instanceof THREE.Vector3 ? out.aim : (out.aim = new THREE.Vector3());
    if (Array.isArray(c.target)) {
      aim.set(c.target[0] || 0, c.target[1] || 0, c.target[2] || 0);
    } else if (c.target && finite(c.target.x)) {
      aim.copy(c.target);
    } else {
      aim.set(0, 1.0, 0);
    }
    // A scenario anchor at ground level means "this spot", not "aim at the
    // hero's boots" — lift to chest height so the silhouette sits on the
    // optical centre instead of hanging off the top of it.
    if (Math.abs(aim.y) < 1e-3) aim.y = 0.95;

    /* Rig-owned lens corrections, layered last. See LENS. */
    const o = LENS[name];
    if (o) {
      if (finite(o.pitch)) out.pitch = clamp(o.pitch, 8, 78);
      if (finite(o.yaw)) out.yaw = o.yaw;
      if (finite(o.fov)) out.fov = clamp(o.fov, 22, 62);
      if (finite(o.dist)) out.dist = o.dist;
      if (finite(o.frameBias)) out.frameBias = clamp(o.frameBias, -0.3, 0.3);
      if (Array.isArray(o.aim)) aim.set(o.aim[0], o.aim[1], o.aim[2]);
    }
    return out;
  }

  /**
   * The ground-plane area a scenario actually FRAMES, as a two-way mapping
   * between world XZ and normalised device coordinates.
   *
   * THE BUG THIS EXISTS FOR: enemy packs were placed on a bearing/radius ring
   * around the hero with no reference to the lens, so roughly half of every pack
   * landed behind the camera's field of view — measured at screen Y 1416 and
   * 1611 in a 900 px frame, correctly frustum-culled, invisible. "I don't see
   * any enemies" was literally true for half the encounter. Placement has to be
   * a function of the frustum, and the frustum is the rig's business.
   *
   * Everything is derived from `scenarioPose`, so this is valid *before* the rig
   * has applied the scenario.
   *
   * `anchor` may be a POINT or a LIST of points, and passing a list is usually
   * what you want. The rig follows the hero, so a scripted walk drags the whole
   * footprint along with it: the dungeon hero covers 9 m, and the harness
   * captures that scenario anywhere from 1.5 s (tools/shot.mjs, 90 frames) to
   * 7 s (tools/actors.mjs) in. There is no single "capture moment" to compose
   * for. Given a list, `visible()` is the INTERSECTION of the framed areas over
   * every anchor — the ground that stays in shot for the whole performance — so
   * one placement satisfies every capture time. `project`/`unproject` use the
   * first anchor, which should therefore be the primary composition point.
   *
   * @param {string} name
   * @param {object} cfg scenario config
   * @param {{x:number,y?:number,z:number}|Array<{x:number,y?:number,z:number}>} [anchor]
   *        framing subject(s); defaults to the hero's current position
   * @param {number} [planeY] ground height to solve against; defaults to the first anchor's
   * @returns {{
   *   pose:object, camPos:THREE.Vector3, planeY:number, viewH:number, views:number,
   *   project:(x:number,z:number)=>{u:number,v:number},
   *   unproject:(u:number,v:number)=>{x:number,z:number}|null,
   *   visible:(x:number,z:number,mu?:number,mvLo?:number,mvHi?:number)=>boolean
   * }|null}
   */
  scenarioFrame(name, cfg, anchor = null, planeY = null) {
    try {
      const pose = this.scenarioPose(name, cfg, this._poseTmp || (this._poseTmp = {}));

      const raw = Array.isArray(anchor) ? anchor : [anchor];
      const pts = raw.filter((p) => p && finite(p.x) && finite(p.z));
      if (!pts.length) pts.push(this._heroPosition(_v1).clone());

      const P = pose.pitch * DEG, Y = pose.yaw * DEG, D = Math.max(0.6, pose.dist);
      const viewH = 2 * D * Math.tan(pose.fov * 0.5 * DEG);
      const y = finite(planeY) ? planeY : (finite(pts[0].y) ? pts[0].y : 0);
      const tmp = new THREE.Vector3();

      const views = pts.map((a) => {
        const ay = finite(a.y) ? a.y : 0;
        const fx = a.x + pose.aim.x, fy = ay + pose.aim.y, fz = a.z + pose.aim.z;
        const cam = new THREE.PerspectiveCamera(pose.fov, this._aspect > 0 ? this._aspect : 16 / 9,
          this.camera.near, this.camera.far);
        cam.position.set(fx + Math.sin(Y) * D * Math.cos(P), fy + D * Math.sin(P), fz + Math.cos(Y) * D * Math.cos(P));
        cam.up.set(0, 1, 0);
        cam.lookAt(fx, fy, fz);
        // frameBias is a rise/fall on the lens, not a re-aim: translate along the
        // camera's own up AFTER orienting, exactly as _place() does.
        cam.translateY(pose.frameBias * viewH);
        cam.updateMatrixWorld(true);
        cam.updateProjectionMatrix();
        return { cam, origin: cam.position.clone() };
      });

      const primary = views[0];
      const project = (x, z) => {
        tmp.set(x, y, z).project(primary.cam);
        return { u: tmp.x, v: tmp.y };
      };
      // NDC -> ground: shoot the ray through the pixel and meet the y = planeY
      // plane. Returns null when the ray points away from the plane (a pixel
      // above the horizon has no ground behind it).
      const unproject = (u, v) => {
        tmp.set(u, v, 0.5).unproject(primary.cam).sub(primary.origin);
        if (Math.abs(tmp.y) < 1e-6) return null;
        const t = (y - primary.origin.y) / tmp.y;
        if (!(t > 0)) return null;
        return { x: primary.origin.x + tmp.x * t, z: primary.origin.z + tmp.z * t };
      };
      /**
       * Is (x,z) inside every anchor's frame, with per-edge margins in NDC?
       * `mvLo` insets the BOTTOM edge (leave room for the HUD) and `mvHi` the
       * top (leave headroom for the body's on-screen height above its feet).
       */
      const visible = (x, z, mu = 0, mvLo = 0, mvHi = 0) => {
        for (let i = 0; i < views.length; i++) {
          tmp.set(x, y, z).project(views[i].cam);
          if (tmp.x < -1 + mu || tmp.x > 1 - mu) return false;
          if (tmp.y < -1 + mvLo || tmp.y > 1 - mvHi) return false;
          if (tmp.z < -1 || tmp.z > 1) return false;
        }
        return true;
      };

      return { pose, camPos: primary.origin, planeY: y, viewH, views: views.length, project, unproject, visible };
    } catch (e) {
      console.warn('[camera] scenarioFrame failed —', e?.message ?? e);
      return null;
    }
  }

  applyScenario(name, cfg) {
    try {
      const c = (cfg && cfg.camera) || {};
      const k = this.cfg;
      Object.assign(k, this._defaults);

      /* ---- lens: one source of truth, shared with scenarioFrame ---- */
      const pose = this.scenarioPose(name, cfg, this._poseTmp || (this._poseTmp = {}));
      k.pitch = pose.pitch;
      k.yaw = pose.yaw;
      k.fov = pose.fov;
      k.dist = pose.dist;
      k.frameBias = pose.frameBias;
      k.aim.copy(pose.aim);

      if (finite(c.minDist)) k.minDist = c.minDist;
      if (finite(c.maxDist)) k.maxDist = c.maxDist;
      if (finite(c.lookahead)) k.lookahead = clamp(c.lookahead, 0, 0.4);
      if (finite(c.handheld)) k.handheld = clamp(c.handheld, 0, 3);
      if (finite(c.groundClearance)) k.groundClearance = c.groundClearance;
      if (typeof c.occlusion === 'boolean') k.occlusion = c.occlusion;

      // Close framing needs a tighter zoom band than the default wide shot.
      // Derived from the FINAL distance, so a LENS override drags the band with it.
      k.minDist = Math.min(k.minDist, k.dist * 0.55);
      k.maxDist = Math.max(k.maxDist, k.dist * 1.35);
      k.groundClearance = Math.min(k.groundClearance, Math.max(0.6, k.dist * 0.34));

      /* ---- the `closeup` portrait also needs non-lens knobs ----
         handheld 0.5: the amplitude scales with distance but the *angular*
         effect does not, so a 3.78 m lens needs it pulled back. Occlusion stays
         on, but the ray fan narrows: at this distance the default 1.15 m
         half-width reaches well past the hero and dithers out rubble that is not
         in the way. */
      if (name === 'closeup') {
        k.minDist = 2.4;
        k.maxDist = 6.5;
        k.handheld = 0.5;
        k.lookahead = 0;
        k.groundClearance = 0.45;
        k.occludeRadius = 0.55;
      }

      this.zoomTarget = k.dist;
      this.cine = null;
      this.cineW = 0;
      this.trauma.length = 0;
      this.hitStop = 0;
      this.combatHeat = name === 'combat' || name === 'boss' ? 0.75 : 0;

      // Scenarios are graded frames: settle instantly so frame 0 is composed.
      this._resolveHero();
      this.snap();
    } catch (e) {
      console.warn('[camera] applyScenario ignored —', e?.message ?? e);
    }
  }

  /** Hard-settle every spring onto the current desired pose. */
  snap() {
    const k = this.cfg;
    this.sPitch.set(k.pitch * DEG);
    this.sYaw.set(k.yaw * DEG);
    this.sDist.set(clamp(this.zoomTarget, k.minDist, k.maxDist));
    this.sFov.set(k.fov);
    this.sPunch.set(0);
    this.sPunch.omega = 13.0;
    this.sPunch.zeta = 0.62;
    this.slaX.set(0); this.slaZ.set(0);

    // Full state reset — anything carried over here would make two identical
    // scenario setups produce different frames.
    const hero = this._heroPosition(_v1);
    this._prevHeroPos.copy(hero);
    this._hasPrevHero = true;
    this.heroSpeed = 0;
    this.heroVel.set(0, 0, 0);
    this.hitStop = 0;
    this._lastCrit = -1e9;
    this.snapPending = false;
    this._occRebuildAt = -1e9;

    const aim = _v2.copy(hero).add(k.aim);
    this.sx.set(aim.x); this.sy.set(aim.y); this.sz.set(aim.z);
    this.focus.copy(aim);

    this._clearAllFades();
    this._place(1 / 60, true);
  }

  /* =================================================================
     public API used by other modules
     ================================================================= */

  /** Trauma-based shake. amp 0..1 (1 = boss slam), freq in Hz, duration in s. */
  shake(amp = 0.3, freq = 18, duration = 0.4) {
    const a = clamp(finite(amp) ? amp : 0.3, 0, 1);
    if (a <= 0.0005) return;
    const f = clamp(finite(freq) ? freq : this.cfg.shakeFreq, 1, 60);
    const d = clamp(finite(duration) ? duration : 0.4, 0.05, 6);
    if (this.trauma.length >= 8) this.trauma.shift();
    this.trauma.push({ t: a, decay: 1 / d, freq: f, lane: (this._shakeLane = (this._shakeLane + 7) % 613) });
  }

  /**
   * Ease the FOV in by `deg` and let it spring back. Negative = pull out.
   *
   * Implemented as a velocity impulse into an under-damped (zeta 0.62) spring
   * whose rest value is 0, so the lens snaps in and eases back with a hair of
   * overshoot. For x(0)=0, x'(0)=v0 the peak is 0.49 * v0/omega, hence the
   * 1/0.49 = 2.04 factor: `deg` is the actual peak in degrees.
   */
  punchFov(deg = 1.5, speed = 1.0) {
    const d = finite(deg) ? clamp(deg, -8, 8) : 1.5;
    this.sPunch.omega = clamp(13.0 * (finite(speed) ? speed : 1), 2.5, 26);
    this.sPunch.zeta = 0.62;
    // Clamp the accumulated impulse so overlapping punches can never stack
    // into a lens-flare-grade zoom.
    const maxV = 3.6 * this.sPunch.omega * 2.04;
    this.sPunch.v = clamp(this.sPunch.v - d * this.sPunch.omega * 2.04, -maxV, maxV);
  }

  /**
   * Cinematic framing. `target` may be an Object3D, a Vector3, or {x,y,z}.
   * Blends distance / pitch / yaw / fov over `duration` seconds with an eased
   * curve on top of the springs (so it is smooth in *and* smooth out).
   */
  focusOn(target, opts = {}) {
    if (!target) return this.release(opts.duration);
    const o = opts || {};
    this.cine = {
      target,
      offset: o.offset instanceof THREE.Vector3 ? o.offset.clone()
        : Array.isArray(o.offset) ? new THREE.Vector3(o.offset[0] || 0, o.offset[1] || 0, o.offset[2] || 0)
          : new THREE.Vector3(0, 1.2, 0),
      dist: finite(o.dist) ? o.dist : null,
      pitch: finite(o.pitch) ? o.pitch : null,
      yaw: finite(o.yaw) ? o.yaw : null,
      fov: finite(o.fov) ? o.fov : null,
      bias: finite(o.bias) ? clamp(o.bias, 0, 1) : 1, // 0 = keep hero, 1 = pure target
      dur: clamp(finite(o.duration) ? o.duration : 1.1, 0.05, 12),
      dir: 1,
      t: this.cine ? this.cine.t : 0, // resume from the current blend, never pop
    };
    return this;
  }

  /** Ease back to the hero-follow pose. */
  release(duration = 0.9) {
    if (!this.cine) { this.cineW = 0; return this; }
    this.cine.dir = -1;
    this.cine.dur = clamp(finite(duration) ? duration : 0.9, 0.05, 12);
    return this;
  }

  get isCinematic() { return !!this.cine || this.cineW > 0.001; }
  /** Current combined shake energy, 0..~1.35. Useful for VFX/audio coupling. */
  get traumaLevel() {
    let s = 0;
    for (let i = 0; i < this.trauma.length; i++) s += this.trauma[i].t * this.trauma[i].t;
    return s;
  }

  setDistance(d) { this.zoomTarget = clamp(d, this.cfg.minDist, this.cfg.maxDist); return this; }
  zoom(delta) { return this.setDistance(this.zoomTarget + delta); }

  /** Replace how faded occluders are materialised. fn(baseMaterial, mesh, rig) -> Material */
  setOccluderMaterialFactory(fn) {
    this._ghostFactory = typeof fn === 'function' ? fn : null;
    this._clearAllFades();
    this._ghostCache = new WeakMap();
    for (const g of this._ghosts) { try { g.dispose?.(); } catch { /* ignore */ } }
    this._ghosts.length = 0;
    return this;
  }
  /** fn(object3D) -> boolean. Return false to never fade an object. */
  setOccluderFilter(fn) { this._occFilter = typeof fn === 'function' ? fn : null; this._occRebuildAt = -1e9; return this; }
  ignoreOccluder(obj) { if (obj) this._occIgnore.add(obj); return this; }

  /* =================================================================
     per-frame
     ================================================================= */

  update(dt, elapsed) {
    if (!this.enabled || this.failed) return;
    if (!(dt > 0)) return;

    if ((this.engine.clock.frame & 31) === 0) this._resolveHero();

    /* ---- hero tracking ---- */
    const hero = this._heroPosition(_v1);
    if (this._hasPrevHero) {
      const jump = hero.distanceToSquared(this._prevHeroPos);
      _v2.subVectors(hero, this._prevHeroPos).multiplyScalar(1 / dt);
      if (jump > 4) _v2.set(0, 0, 0); // teleport this frame: don't lead into it
      // Exponential smoothing with a real time constant (~55 ms), not a
      // frame-rate dependent constant lerp.
      this.heroVel.lerp(_v2, 1 - Math.exp(-dt * 18));
      this.heroSpeed = Math.hypot(this.heroVel.x, this.heroVel.z);
      if (jump > 900) this.snapPending = true;
    } else {
      this._hasPrevHero = true;
    }
    this._prevHeroPos.copy(hero);

    if (this.snapPending) { this.snapPending = false; this.snap(); return; }

    /* ---- decays ---- */
    this.combatHeat = Math.max(0, this.combatHeat - dt * 0.62);
    this.hitStop = Math.max(0, this.hitStop - dt);
    for (let i = this.trauma.length - 1; i >= 0; i--) {
      const s = this.trauma[i];
      s.t -= s.decay * dt;
      if (s.t <= 0) this.trauma.splice(i, 1);
    }

    /* ---- input: wheel zoom ---- */
    const wheel = this.engine.input?.wheel || 0;
    if (wheel) this.zoomTarget = clamp(this.zoomTarget + wheel * this.cfg.zoomStep, this.cfg.minDist, this.cfg.maxDist);

    this._place(dt, false);
    this._updateOcclusion(dt);
  }

  /**
   * Compute and commit the lens transform. `instant` bypasses the springs
   * (used by snap()/init so screenshots start composed).
   */
  _place(dt, instant) {
    const k = this.cfg;
    const cam = this.camera;
    const elapsed = this.engine.clock.elapsed;

    /* ---------- cinematic blend weight ---------- */
    let cineW = 0;
    if (this.cine) {
      const c = this.cine;
      c.t = clamp(c.t + (c.dir * dt) / c.dur, 0, 1);
      cineW = smootherstep(c.t) * clamp(c.bias, 0, 1);
      if (c.dir < 0 && c.t <= 0) { this.cine = null; cineW = 0; }
    }
    this.cineW = cineW;

    /* ---------- desired pose ---------- */
    let pitch = k.pitch * DEG;
    let yaw = k.yaw * DEG;
    let dist = clamp(this.zoomTarget, k.minDist, k.maxDist);
    let fov = k.fov;

    const hero = this._heroPosition(_v1);
    const aim = _v2.copy(hero).add(k.aim);

    /* ---------- boss framing ----------
       Before the cinematic blend, so `focusOn()` still wins outright. */
    if (k.bossFrame !== false) dist = this._frameBoss(aim, hero, pitch, fov, dist);

    if (this.cine) {
      const c = this.cine;
      const tp = this._resolvePoint(c.target, _v3);
      if (tp) {
        tp.add(c.offset);
        aim.lerp(tp, cineW);
      }
      if (c.pitch !== null) pitch = lerp(pitch, c.pitch * DEG, cineW);
      if (c.yaw !== null) yaw = lerp(yaw, wrapPi(c.yaw * DEG - yaw) + yaw, cineW);
      if (c.dist !== null) dist = lerp(dist, clamp(c.dist, 1.2, 240), cineW);
      if (c.fov !== null) fov = lerp(fov, clamp(c.fov, 15, 70), cineW);
    }

    /* ---------- follow springs (soft vertical, tight lateral) ---------- */
    this.sx.omega = k.followOmegaXZ; this.sz.omega = k.followOmegaXZ;
    this.sy.omega = k.followOmegaY;
    this.sx.zeta = this.sy.zeta = this.sz.zeta = k.followZeta;

    // Feed a slice of hero velocity forward so the frame does not trail
    // behind during a sprint, but keep it small — full compensation kills
    // the sense of weight.
    const lead = this.heroVel && !this.cine ? k.velocityLead : 0;
    const tx = aim.x + (this.heroVel ? this.heroVel.x * lead : 0);
    const tz = aim.z + (this.heroVel ? this.heroVel.z * lead : 0);

    // Hit-stop: hold the frame for a few dozen ms on a crit. Reads as impact.
    const hold = this.hitStop > 0 ? 0.12 : 1;

    if (instant) {
      this.sx.set(tx); this.sy.set(aim.y); this.sz.set(tz);
      this.sPitch.set(pitch); this.sYaw.set(yaw); this.sDist.set(dist); this.sFov.set(fov);
    } else {
      this.sx.step(tx, dt, hold);
      this.sy.step(aim.y, dt, hold);
      this.sz.step(tz, dt, hold);
      const angScale = this.cine ? 1.9 : 1;
      this.sPitch.stepAngle(pitch, dt, angScale);
      this.sYaw.stepAngle(yaw, dt, angScale);
      this.sDist.step(dist, dt, this.cine ? 1.5 : 1);
      this.sFov.step(fov, dt);
    }
    this.sPunch.step(0, dt);

    const P = clamp(this.sPitch.x, 6 * DEG, 84 * DEG);
    const Y = this.sYaw.x;
    const D = Math.max(0.6, this.sDist.x);
    const F = clamp(this.sFov.x + this.sPunch.x, 14, 72);

    this.focus.set(this.sx.x, this.sy.x, this.sz.x);

    /* ---------- view extents (used by lookahead + framing) ---------- */
    const viewH = 2 * D * Math.tan(F * 0.5 * DEG);
    const viewW = viewH * this._aspect;

    /* ---------- basis ---------- */
    const cp = Math.cos(P), sp = Math.sin(P);
    const sy = Math.sin(Y), cy = Math.cos(Y);
    // Ground-plane forward (from camera toward the focus) and right vectors.
    _fwd.set(-sy, 0, -cy);
    _right.set(cy, 0, -sy);

    /* ---------- cursor lookahead ----------
       Driven from NDC, never from the ground raycast: the raycast depends on
       the camera, so using it would create a positive feedback loop that
       parks the offset on its clamp. */
    let laTargetX = 0, laTargetZ = 0;
    const ndc = this.engine.input?.mouse?.ndc;
    if (ndc && k.lookahead > 0 && this.cineW < 0.5) {
      // A ground displacement of g along the camera's ground-forward projects
      // onto the screen's vertical axis by g * sin(pitch), so divide it out to
      // keep the lookahead a constant fraction of the *frame*, not the world.
      // At full cursor deflection the aim moves `lookahead` of the view extent.
      const ax = clamp(ndc.x, -1, 1) * viewW * k.lookahead;
      const ay = (clamp(ndc.y, -1, 1) * viewH * k.lookahead) / Math.max(0.35, sp);
      laTargetX = _right.x * ax + _fwd.x * ay;
      laTargetZ = _right.z * ax + _fwd.z * ay;
    }
    if (instant) { this.slaX.set(laTargetX); this.slaZ.set(laTargetZ); }
    else { this.slaX.step(laTargetX, dt, hold); this.slaZ.step(laTargetZ, dt, hold); }
    this.focus.x += this.slaX.x;
    this.focus.z += this.slaZ.x;

    /* ---------- lens position on the orbit ---------- */
    const horiz = D * cp;
    const px = this.focus.x + sy * horiz;
    const py = this.focus.y + D * sp;
    const pz = this.focus.z + cy * horiz;
    this.position.set(px, py, pz);

    /* ---------- procedural handheld ----------
       Three octaves, all sampled from clock.elapsed so a given frame index is
       reproducible. Amplitude floors at ~35% when the hero is idle so a still
       frame is composed, and rises with speed + combat heat. */
    const intensity = k.handheld * (0.34 + 0.42 * sat(this.heroSpeed / 6.5) + 0.46 * sat(this.combatHeat));
    const ampP = k.handheldPos * D * intensity;
    const ampR = k.handheldRot * intensity;

    const nx = this._breath(elapsed, 0, 0.147, 0.331, 0.79);
    const ny = this._breath(elapsed, 1, 0.121, 0.287, 0.63);
    const nz = this._breath(elapsed, 2, 0.093, 0.239, 0.55);
    const rr = this._breath(elapsed, 3, 0.101, 0.263, 0.61);
    const rp = this._breath(elapsed, 4, 0.133, 0.311, 0.71);
    const ry = this._breath(elapsed, 5, 0.113, 0.277, 0.67);

    /* ---------- trauma shake ---------- */
    let shake = 0;
    let shx = 0, shy = 0, shz = 0, shr = 0, shp = 0, shyaw = 0;
    for (let i = 0; i < this.trauma.length; i++) {
      const s = this.trauma[i];
      const g = s.t * s.t;               // trauma^2 — light hits vanish, slams hit
      shake += g;
      const t = elapsed * s.freq;
      const L = s.lane;
      shx += g * this._n(t, L + 1);
      shy += g * this._n(t, L + 2);
      shz += g * this._n(t, L + 3) * 0.55;
      shr += g * this._n(t * 0.83, L + 4);
      shp += g * this._n(t * 0.91, L + 5);
      shyaw += g * this._n(t * 0.87, L + 6);
    }
    if (shake > 1.35) {
      const s = 1.35 / shake;
      shx *= s; shy *= s; shz *= s; shr *= s; shp *= s; shyaw *= s;
    }
    const shakePos = k.shakePos * D;

    /* ---------- terrain clearance (before orientation) ---------- */
    this._clampAboveGround(this.position, this.focus, shakePos * 0.9 + ampP);

    /* ---------- orient, then translate in lens space ---------- */
    cam.position.copy(this.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.focus);

    // Extract the lens basis from the freshly built orientation.
    _q.copy(cam.quaternion);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, -1).applyQuaternion(_q);

    // Compositional bias: nudging the lens up its own Y drops the subject
    // slightly below centre without changing the aim.
    const bias = k.frameBias * viewH;

    const ox = _right.x * (nx * ampP + shx * shakePos) + _up.x * (ny * ampP + shy * shakePos + bias) + _fwd.x * (nz * ampP * 0.6 + shz * shakePos);
    const oy = _right.y * (nx * ampP + shx * shakePos) + _up.y * (ny * ampP + shy * shakePos + bias) + _fwd.y * (nz * ampP * 0.6 + shz * shakePos);
    const oz = _right.z * (nx * ampP + shx * shakePos) + _up.z * (ny * ampP + shy * shakePos + bias) + _fwd.z * (nz * ampP * 0.6 + shz * shakePos);
    cam.position.set(this.position.x + ox, this.position.y + oy, this.position.z + oz);

    // Rotational component — this is what sells a shake; pure translation
    // reads as a camera on rails being nudged.
    cam.rotateX(rp * ampR + shp * k.shakeRot);
    cam.rotateY(ry * ampR + shyaw * k.shakeRot);
    cam.rotateZ(rr * ampR * 1.6 + shr * k.shakeRoll);

    if (Math.abs(cam.fov - F) > 1e-4) {
      cam.fov = F;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  /* =================================================================
     boss framing
     ================================================================= */

  /**
   * The living boss, if there is one. Cached for 12 frames — this walks the
   * bestiary and a boss does not appear or die between two frames.
   */
  _resolveBoss() {
    const f = this.engine.clock.frame;
    if (f - this._bossAt < 12) return this._boss;
    this._bossAt = f;
    this._boss = null;
    try {
      const bes = this.engine.get('bestiary');
      const list = bes && !bes.__dead ? bes.entities : null;
      if (!list || !list.length) return null;
      let best = null;
      for (let i = 0; i < list.length; i++) {
        const en = list[i];
        if (!en || en.dead) continue;
        const boss = en.rank === 'boss' || en.isBoss === true || en.def?.isBoss === true;
        if (!boss) continue;
        if (!en.position || !finite(en.position.x) || !finite(en.position.z)) continue;
        if (!best || (en.height ?? 0) > (best.height ?? 0)) best = en;
      }
      if (best) {
        this._boss = { en: best, h: clamp(finite(best.height) ? best.height : 6.5, 2.5, 14) };
      }
    } catch { this._boss = null; }
    return this._boss;
  }

  /**
   * Re-aim and re-lens around a boss encounter, and return the distance to use.
   *
   * A follow rig that tracks only the hero cannot frame a two-subject fight: the
   * boss is 8-12 m away and 7.7 m tall, so at any distance that reads the hero
   * well the boss is either half out of frame or a thumbnail behind it. The
   * measured `boss` capture had the warden at 108 px in a 900 px frame while its
   * own loot drops were 40 px glows — the frame had no subject.
   *
   * So the solve is:
   *   AIM   58 % of the way from the hero to the boss on the ground, and 38 % of
   *         the way up to the boss's centre of mass. Both subjects end up inside
   *         the middle of the frame instead of one of them owning it.
   *   DIST  fit the vertical extent the pair actually occupies. A ground
   *         separation `s` projects to `s·sin(pitch)` on the screen's vertical
   *         axis and the boss adds `h·cos(pitch)` of its own height, so
   *             D = (s·sin P + h·cos P) / (FILL · 2 · tan(fov/2))
   *         then bracketed by the distances at which the boss would fill MAX_H
   *         or MIN_H of frame height, so it can neither be cropped nor lost.
   *
   * Everything is a pure function of two positions, so it is deterministic and
   * the springs (not this) own the smoothing.
   */
  _frameBoss(aim, hero, pitchRad, fov, baseDist) {
    const b = this._resolveBoss();
    if (!b) { this.bossDist = 0; return baseDist; }
    const k = this.cfg;
    const p = b.en.position;
    const h = b.h;
    const by = (finite(p.y) ? p.y : 0) + h * 0.40;
    const eye = hero.y + k.aim.y;

    aim.set(
      hero.x + (p.x - hero.x) * BOSS.AIM_W,
      eye + (by - eye) * BOSS.AIM_Y,
      hero.z + (p.z - hero.z) * BOSS.AIM_W
    );

    const sp = Math.max(0.15, Math.sin(pitchRad));
    const cp = Math.max(0.05, Math.cos(pitchRad));
    const tanH = Math.max(0.05, Math.tan(fov * 0.5 * DEG));
    const sep = Math.hypot(p.x - hero.x, p.z - hero.z);
    const span = sep * sp + h * cp;
    const fit = span / (BOSS.FILL * 2 * tanH);
    const near = (h * cp) / (BOSS.MAX_H * 2 * tanH);
    const far = (h * cp) / (BOSS.MIN_H * 2 * tanH);
    const d = clamp(fit,
      Math.max(near, k.minDist),
      Math.min(Math.max(far, near + 0.5), k.maxDist));
    this.bossDist = d;
    return finite(d) ? d : baseDist;
  }

  /** Layered perlin breath, deterministic in elapsed time. */
  _breath(t, lane, f0, f1, f2) {
    return (
      this._n(t * f0, lane * 3 + 101) * 0.62 +
      this._n(t * f1, lane * 3 + 102) * 0.27 +
      this._n(t * f2, lane * 3 + 103) * 0.11
    );
  }
  _n(x, lane) {
    return (perlin2(x, lane * 17.31 + 0.5, this._noiseSeed) - 0.5) * 2;
  }

  /* =================================================================
     terrain clearance
     ================================================================= */

  _clampAboveGround(pos, focus, margin) {
    const terrain = this.engine.get('terrain');
    const fn = terrain && !terrain.__dead && typeof terrain.heightAt === 'function'
      ? terrain.heightAt.bind(terrain) : null;
    if (!fn) {
      // No terrain service: only guarantee the lens sits above the world plane.
      const floor = this.cfg.groundClearance + margin;
      if (pos.y < floor) pos.y = floor;
      return;
    }
    const clearance = this.cfg.groundClearance + margin;

    let need = 0;
    // Sample the lens->focus segment (out to 70%, so the ground directly under
    // the hero never forces a lift) and solve for the vertical push at the
    // lens end that clears every sample. Raising the lens by d raises the
    // sample at parameter u by d*(1-u), hence the division.
    const S = 4;
    for (let i = 0; i <= S; i++) {
      const u = (i / S) * 0.7;
      const x = lerp(pos.x, focus.x, u);
      const z = lerp(pos.z, focus.z, u);
      const v = fn(x, z);
      const h = finite(v) ? v : 0;
      const req = h + clearance * (1 - u * 0.5);
      const cur = lerp(pos.y, focus.y, u);
      if (req > cur) {
        const lift = (req - cur) / Math.max(0.3, 1 - u);
        if (lift > need) need = lift;
      }
    }
    if (need > 0 && Number.isFinite(need)) pos.y += Math.min(need, 30);
  }

  /* =================================================================
     hero / target resolution (everything is optional and guarded)
     ================================================================= */

  _resolveHero() {
    const h = this.engine.get('hero');
    if (h && !h.__dead) {
      this._heroModule = h;
      // Used only to keep the hero's own meshes out of the occluder set; a
      // module that exposes a bare Vector3 simply has nothing to exclude.
      this._heroRoot = h.root || h.group || h.object3D || h.model || h.mesh || h.obj || null;
    } else {
      this._heroModule = null;
    }
    if (!this._heroRoot) {
      const s = this.engine.scene;
      this._heroRoot = s?.getObjectByName?.('hero') || s?.getObjectByName?.('Hero') || null;
    }
  }

  _heroPosition(out) {
    const h = this._heroModule;
    let p = null;
    if (h) {
      if (h.position && finite(h.position.x)) p = h.position;
      else if (h.root?.position && finite(h.root.position.x)) p = h.root.position;
      else if (h.group?.position && finite(h.group.position.x)) p = h.group.position;
      else if (h.mesh?.position && finite(h.mesh.position.x)) p = h.mesh.position;
      else if (typeof h.getPosition === 'function') {
        try { const q = h.getPosition(); if (q && finite(q.x)) p = q; } catch { /* ignore */ }
      }
    }
    if (!p && this._heroRoot?.position && finite(this._heroRoot.position.x)) p = this._heroRoot.position;
    if (!p) {
      // No Hero module registered yet. A hard (0, 0, 0) fallback is not safe:
      // Terrain's surface is only near y = 0 on the flat interior biomes — the
      // moor sits ~7 m up at the origin, so the rig would orbit an aim point
      // buried inside a hill and the ground-clearance clamp would then shove
      // the lens straight up. Anchor the fallback on the actual ground.
      return out.set(0, this._groundY(0, 0), 0);
    }
    return out.set(p.x, finite(p.y) ? p.y : 0, p.z);
  }

  /** Terrain height at a world XZ, or 0 when there is no terrain service. */
  _groundY(x, z) {
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (finite(y)) return y;
    }
    return 0;
  }

  _resolvePoint(t, out) {
    if (!t) return null;
    if (t.isObject3D) { t.getWorldPosition(out); return out; }
    if (finite(t.x) && finite(t.z)) return out.set(t.x, finite(t.y) ? t.y : 0, t.z);
    if (t.position && finite(t.position.x)) return out.set(t.position.x, t.position.y || 0, t.position.z);
    if (Array.isArray(t) && t.length >= 3) return out.set(t[0], t[1], t[2]);
    return null;
  }

  _isHero(e) {
    if (!e) return false;
    if (e === this._heroModule || e === this._heroRoot) return true;
    return e.isHero === true || e.faction === 'player' || e.id === 'hero' || e.tag === 'hero';
  }

  _isLarge(e) {
    if (!e) return false;
    try {
      if (e.isBoss || e.boss === true) return true;
      const tier = e.tier ?? e.rank ?? e.kind;
      if (typeof tier === 'string' && /boss|elite|champion|brute|golem|butcher/i.test(tier)) return true;
      if (finite(e.radius) && e.radius >= 1.15) return true;
      if (finite(e.height) && e.height >= 3.0) return true;
      if (finite(e.scale) && e.scale >= 1.6) return true;
      if (e.scale && finite(e.scale.x) && e.scale.x >= 1.6) return true;
      if (finite(e.maxHealth) && e.maxHealth >= 400) return true;
      if (finite(e.mass) && e.mass >= 220) return true;
    } catch { /* ignore */ }
    return false;
  }

  /* =================================================================
     occlusion fade
     ================================================================= */

  _updateOcclusion(dt) {
    const noHero = !this._heroModule && !this._heroRoot;
    if (!this.cfg.occlusion || noHero) { if (this._faded.size) this._fadeAllOut(dt); return; }
    const scene = this.engine.scene;
    if (!scene) return;

    const frame = this.engine.clock.frame;
    if (frame - this._occRebuildAt > 45) this._rebuildOccluders(scene);

    // Re-test every third frame; the fade envelope keeps it smooth between.
    if (frame % 3 === 0) {
      const hits = this._occHits;
      hits.clear();
      const camPos = this.position;
      const heroPos = this._heroPosition(_v1);
      const chest = _v2.set(heroPos.x, heroPos.y + 1.05, heroPos.z);

      const list = this._occCandidates;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const m = o.mesh;
        if (!m.visible || !m.parent) continue;

        // Broad phase: world bounding sphere against the lens->chest segment.
        _sph.copy(o.sphere).applyMatrix4(m.matrixWorld);
        const r = _sph.radius + this.cfg.occludeRadius;
        if (distSqPointSeg(_sph.center.x, _sph.center.y, _sph.center.z, camPos, chest) > r * r) continue;

        // Narrow phase: ray fan vs the object's local AABB. Cheap, exact
        // enough for architecture, and never touches triangle data.
        if (this._rayFanHits(m, o.box, camPos, chest)) hits.add(m);
      }

      for (const [mesh, st] of this._faded) st.target = hits.has(mesh) ? 1 : 0;
      for (const m of hits) {
        if (this._faded.has(m)) continue;
        let orig = this._origCache.get(m);
        if (!orig) { orig = m.material; this._origCache.set(m, orig); }
        this._faded.set(m, { amount: 0, target: 1, orig, ghost: null });
      }
    }

    this._advanceFades(dt);
  }

  _rayFanHits(mesh, localBox, camPos, chest) {
    _mat4.copy(mesh.matrixWorld).invert();
    const maxLen = camPos.distanceTo(chest);
    // Centre ray plus a small lateral fan so the fade engages before the
    // silhouette is actually cut, which is what stops the classic pop.
    for (let i = 0; i < 3; i++) {
      const off = i === 0 ? 0 : (i === 1 ? this.cfg.occludeRadius : -this.cfg.occludeRadius);
      _v3.set(chest.x - camPos.x, 0, chest.z - camPos.z);
      const l = Math.hypot(_v3.x, _v3.z) || 1;
      const rx = (-_v3.z / l) * off;
      const rz = (_v3.x / l) * off;
      _ray.origin.set(camPos.x, camPos.y, camPos.z);
      _ray.direction.set(chest.x + rx - camPos.x, chest.y - camPos.y + (i === 0 ? 0 : 0.35), chest.z + rz - camPos.z);
      const len = _ray.direction.length();
      if (len < 1e-4) continue;
      _ray.direction.multiplyScalar(1 / len);
      _ray.applyMatrix4(_mat4);
      if (_ray.intersectBox(localBox, _v3)) {
        // Reject hits behind the hero (mesh past the subject occludes nothing).
        const d = _v3.distanceTo(_ray.origin) * (mesh.matrixWorld.getMaxScaleOnAxis() || 1);
        if (d < maxLen - 0.4) return true;
      }
    }
    return false;
  }

  _advanceFades(dt) {
    const inRate = dt / 0.16;   // fade out fast enough to be useful...
    const outRate = dt / 0.34;  // ...restore slower so it never flickers
    for (const [mesh, st] of this._faded) {
      const prev = st.amount;
      st.amount = st.target > 0.5
        ? Math.min(1, st.amount + inRate)
        : Math.max(0, st.amount - outRate);
      if (st.amount <= 0.0015 && st.target < 0.5) {
        this._restore(mesh, st);
        this._faded.delete(mesh);
        continue;
      }
      if (Math.abs(st.amount - prev) > 1e-5 || !st.ghost) this._applyFade(mesh, st);
    }
  }

  _fadeAllOut(dt) {
    for (const [, st] of this._faded) st.target = 0;
    this._advanceFades(dt);
  }

  _applyFade(mesh, st) {
    try {
      if (!st.ghost) {
        if (!st.orig) { st.orig = this._origCache.get(mesh) || mesh.material; this._origCache.set(mesh, st.orig); }
        let g = this._ghostCache.get(mesh);
        if (!g) { g = this._makeGhost(st.orig, mesh); this._ghostCache.set(mesh, g); }
        st.ghost = g;
        mesh.material = g;
      } else if (mesh.material !== st.ghost) {
        mesh.material = st.ghost;
      }
      const op = 1 - st.amount * this.cfg.occludeFade;
      const g = st.ghost;
      if (Array.isArray(g)) for (const m of g) { if (m) m.opacity = op; }
      else if (g) g.opacity = op;
    } catch (e) {
      // Fading is cosmetic — never let it take the frame down.
      this._restore(mesh, st);
      this._faded.delete(mesh);
    }
  }

  _makeGhost(base, mesh) {
    const one = (m) => {
      if (!m) return m;
      if (this._ghostFactory) {
        try {
          const custom = this._ghostFactory(m, mesh, this);
          if (custom) return custom;
        } catch (e) { console.warn('[camera] occluder factory failed —', e?.message ?? e); }
      }
      const g = m.clone();
      g.name = `${m.name || 'mat'}__occluded`;
      if ('alphaHash' in g) {
        // Hashed (dithered) alpha keeps depth writes and shadow behaviour
        // intact — no sorting artefacts, and it reads like the classic ARPG
        // stipple rather than a ghosty alpha blend.
        g.alphaHash = true;
        g.transparent = false;
        g.depthWrite = true;
      } else {
        g.transparent = true;
        g.depthWrite = false;
      }
      g.opacity = 1;
      g.userData = Object.assign({}, g.userData, { nonaOccluderGhost: true });
      g.needsUpdate = true;
      if (g !== m) this._ghosts.push(g);
      return g;
    };
    return Array.isArray(base) ? base.map(one) : one(base);
  }

  _restore(mesh, st) {
    try { if (st?.orig) mesh.material = st.orig; } catch { /* ignore */ }
  }

  _clearAllFades() {
    for (const [mesh, st] of this._faded) this._restore(mesh, st);
    this._faded.clear();
  }

  _rebuildOccluders(scene) {
    this._occRebuildAt = this.engine.clock.frame;
    const out = this._occCandidates;
    out.length = 0;
    const heroRoot = this._heroRoot;
    const maxR = this.cfg.maxOccluderRadius;

    scene.traverseVisible((o) => {
      if (out.length >= 1400) return;
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.isPoints || o.isLine || o.isSprite) return;
      if (o.userData?.occluder === false || o.userData?.noOcclude) return;
      if (this._occIgnore.has(o)) return;
      if (o.userData?.nonaOccluderGhost) return;
      if (heroRoot && (o === heroRoot || this._isDescendant(o, heroRoot))) return;

      const g = o.geometry;
      if (!g) return;
      if (!g.boundingSphere) { try { g.computeBoundingSphere(); } catch { return; } }
      if (!g.boundingBox) { try { g.computeBoundingBox(); } catch { return; } }
      const bs = g.boundingSphere;
      if (!bs || !finite(bs.radius) || bs.radius <= 0.06) return;

      const scale = o.matrixWorld.getMaxScaleOnAxis() || 1;
      const worldR = bs.radius * scale;
      if (o.userData?.occluder !== true) {
        if (worldR > maxR) return;                       // terrain / skydome sized
        if (this._occNames.test(o.name || '')) return;
        const m = o.material;
        const first = Array.isArray(m) ? m[0] : m;
        if (!first || first.transparent === true || first.depthWrite === false) return;
        if (this._occFilter && !this._occFilter(o)) return;
      }
      out.push({ mesh: o, sphere: bs.clone(), box: g.boundingBox.clone() });
    });
  }

  _isDescendant(o, root) {
    let p = o.parent;
    while (p) { if (p === root) return true; p = p.parent; }
    return false;
  }

  /* =================================================================
     teardown
     ================================================================= */

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* ignore */ } }
    this._offs.length = 0;
    this._clearAllFades();
    for (const g of this._ghosts) { try { g.dispose?.(); } catch { /* ignore */ } }
    this._ghosts.length = 0;
    this._occCandidates.length = 0;
    this._occIgnore.clear();
    this._occHits.clear();
    this._ghostCache = new WeakMap();
    this._origCache = new WeakMap();
  }
}
