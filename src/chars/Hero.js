/**
 * SANCTUM — Hero
 * ---------------------------------------------------------------------------
 * The player character, and the scale reference for the entire game: exactly
 * HERO_HEIGHT (1.85 m) tall, standing on the terrain surface, so every material
 * tiling and prop size in the build is judged against this silhouette.
 *
 * Composition
 * -----------
 *   Skeleton.js       humanoid rig (bones, bind pose, skin sigmas)
 *   CharacterMesh.js  five skinned meshes: flesh, cloth, leather, steel, gold
 *   HeroClips.js      procedural locomotion + keyframed actions
 *   AnimGraph.js      layered graph (locomotion ⊕ additive upper body) + IK
 *   Cloak.js          verlet cloth pinned to the pauldrons
 *
 * Scene graph — this matters and is easy to get wrong
 * ---------------------------------------------------
 * `Skeleton.js` binds with the root bone unparented, so the bone inverses live
 * in *rig* space. The bone tree is therefore parented to `this.root` (which
 * carries the hero's world position and yaw) and the skinned meshes are parented
 * to `this.holder`, which has an identity world matrix. The GPU then evaluates
 *
 *     world = I · (I · Σwᵢ·(rootWorld·Lᵢ·Rᵢ⁻¹) · I) · p  =  rootWorld · D(p)
 *
 * with no double transform. The pay-off is that every bone's `matrixWorld` is a
 * genuine world matrix, which is what makes foot IK against terrain, cloth
 * collision, wind and the weapon trail straightforward instead of a basis maze.
 *
 * `holder` used to hang off the scene, which meant `hero.root` was an EMPTY
 * subtree: the hero rendered (skinned geometry follows its bones, not its
 * parent) but every consumer that reasons about the hero by walking its
 * subtree — frustum culling, visibility toggles, animation/shadow LOD, the
 * camera rig's occluder fade, `tools/actors.mjs` — saw zero meshes and zero
 * triangles, and reported the hero as missing. `holder` is now a CHILD of
 * `root` with `matrixWorldAutoUpdate = false`, which is the one flag that gets
 * both properties at once: `Object3D.updateMatrixWorld` skips the
 * `parent.matrixWorld · matrix` product for that node (so its world matrix
 * stays the identity its children are authored against) but still recurses
 * into them. Same pixels, real hierarchy.
 *
 * Determinism: no Math.random, no Date.now. Every time-varying term is a pure
 * function of the fixed dt / `engine.clock.elapsed`.
 */

import * as THREE from 'three';
import { buildHeroRig, HERO_HEIGHT, SOLE_Y } from './Skeleton.js';
import { CharacterMesh } from './CharacterMesh.js';
import { buildHeroClips, COMBO } from './HeroClips.js';
import { HeroAnimGraph, twoBoneIK, alignBoneUp, applyLook } from './AnimGraph.js';
import { Cloak } from './Cloak.js';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };
const wrapPi = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** Exponential smoothing with a real time constant — frame-rate independent. */
const expo = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

/** Ankle height above the sole in the bind pose — the foot IK goal offset. */
const ANKLE_Y = 0.090;
const TRAIL_N = 9;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _hilt = new THREE.Vector3();
const _qt = new THREE.Quaternion();

/* ------------------------------------------------------------------ *
 * scenario direction
 * ------------------------------------------------------------------ */

/**
 * Each scenario is a graded still, so the hero's performance is scheduled on an
 * explicit clock. `applyScenario` runs, the harness then ticks 30 settle frames
 * and captures at frame N — so `t` values below are chosen to land the capture
 * on a strong pose (contact frames, not wind-ups).
 */
const SCENARIO_DIRECTION = {
  /**
   * A material portrait. `yawOffset` is measured from "facing the lens", so 34
   * deg is the classic three-quarter turn: the cuirass keel and the gold boss
   * stay on the front plane, one pauldron catches the key in profile while the
   * other reads as a silhouette edge, and the sword — carried in the right fist
   * — swings toward the camera instead of hiding behind the hip. `look` pulls
   * the head a few degrees off the lens axis so the helm shows its brow and
   * cheek structure rather than a symmetrical mask.
   */
  closeup: {
    yawOffset: 34, look: [1.5, 1.30, 2.6],
    timeline: [],
  },
  combat: {
    yawOffset: 0, look: [0, 1.15, 3.0],
    timeline: [
      { t: 0.35, act: 'attack1' }, { t: 1.15, act: 'attack2' },
      { t: 1.90, act: 'attack3' }, { t: 3.22, act: 'attack1' },
    ],
  },
  boss: {
    yaw: 180, look: [0, 2.6, -6],
    timeline: [
      { t: 0.5, act: 'attack2' }, { t: 1.6, act: 'cast' },
      { t: 2.9, act: 'attack1' }, { t: 3.76, act: 'heavy' },
    ],
  },
  hub: {
    yawOffset: -18,
    path: [[-2.4, 1.6], [2.8, -1.5], [5.2, -4.4]], walk: true,
  },
  dungeon: {
    yawOffset: 8,
    path: [[-1.9, 2.6], [1.2, -2.2], [2.6, -6.0]], walk: true,
  },
  overworld: {
    yawOffset: -12,
    path: [[-3.2, 2.2], [3.0, -2.6], [7.0, -6.4]], walk: false,
  },
  night: {
    yawOffset: 22, look: [2.6, 1.4, 4.0],
    timeline: [{ t: 1.4, act: 'cast' }],
  },
  inventory: {
    yawOffset: 25, look: [1.2, 1.5, 2.6],
    timeline: [],
  },
};

/* ================================================================== *
 * Hero
 * ================================================================== */

export class Hero {
  static id = 'hero';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    /* ---- identity, for the bus and the camera rig ---- */
    this.id = 'hero';
    this.isHero = true;
    this.faction = 'player';
    this.height = HERO_HEIGHT;
    this.radius = 0.34;

    /* ---- transform ---- */
    this.root = new THREE.Object3D();
    this.root.name = 'hero';
    /**
     * World-space bucket. Everything in here is authored in world coordinates
     * and must NOT inherit the hero's transform: the skinned meshes (bone
     * matrices are already world), the cloak and the weapon trail (verlet /
     * streak vertices are written as world positions) and the contact plane
     * (positioned in world coordinates). Parented under `root` for traversal,
     * pinned to an identity world matrix for maths. See the header.
     */
    this.holder = new THREE.Object3D();
    this.holder.name = 'heroSkin';
    this.holder.matrixAutoUpdate = false;        // identity LOCAL matrix, forever
    this.holder.matrixWorldAutoUpdate = false;   // ...and an identity WORLD matrix

    /** Feet-on-ground world position. Aliased to root.position so writes stick. */
    this.position = this.root.position;
    this.rotation = this.root.rotation;
    this.yaw = 0;
    this.velocity = new THREE.Vector3();
    this.footY = 0;
    this.speed = 0;

    /* ---- stats ---- */
    this.stats = {
      level: 12,
      health: 340, maxHealth: 340,
      resource: 100, maxResource: 100,
      armour: 148, damage: 46, critChance: 0.18, critDamage: 1.9,
      moveSpeed: 4.55, walkSpeed: 1.92,
    };
    this.maxHealth = this.stats.maxHealth;
    this.isDead = false;
    this.state = 'idle';

    /* ---- movement ---- */
    this.moveTarget = null;
    this.accel = 24;
    this.decel = 32;
    this._desired = new THREE.Vector3();
    this._locoW = 0;
    this._gait = 0;
    this._actW = 0;
    this._turnAmt = 0;
    this._pelvisOff = 0;
    this._footW = [0, 0];
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._lookTarget = null;
    this._flash = 0;

    /* ---- combat ---- */
    this.comboIndex = 0;
    this._comboWindow = 0;
    this._trailGain = 0;
    this._trailPeak = 1;
    this._invuln = 0;

    /* ---- scenario script ---- */
    this._script = null;
    this._scriptT = 0;
    this._scriptI = 0;
    this._pathI = 0;

    this._offs = [];
    this.failed = false;

    /* built in init() */
    this.rig = null;
    this.mesh = null;
    this.graph = null;
    this.cloak = null;
    this.trail = null;
    this.contact = null;
  }

  /* =============================================================== init */

  async init() {
    try {
      this.rig = buildHeroRig();
      this.root.add(this.rig.root);
      this.engine.scene.add(this.root);
      this.root.add(this.holder);

      this.mesh = new CharacterMesh(this.engine, this.rig, { seed: 20791 });
      const meshes = this.mesh.build();
      for (const m of meshes) this.holder.add(m);

      const clips = buildHeroClips();
      this.graph = new HeroAnimGraph(this.rig, clips.base, clips.actions, { baseStart: 'locomotion' });
      this.graph.onEvent = (name, clip, data) => this._onAnimEvent(name, clip, data);

      this.cloak = new Cloak(this.engine, this.rig, this.mesh.cloakAnchors);
      const cm = this.cloak.build();
      if (cm) this.holder.add(cm);

      this._buildTrail();
      this._buildContact();

      // Place on the terrain before anything reads our position.
      this._placeAt(0, 0, this.yaw);
      this.root.updateMatrixWorld(true);
      this.graph.update(1 / 60, this._ctx(1 / 60));
      this.root.updateMatrixWorld(true);
      this.cloak.reset();

      /* Cascaded shadows + probe bounce come from the Lighting module. */
      const mats = [...this.mesh.materials];
      if (this.cloak.material) mats.push(this.cloak.material);
      try {
        const lighting = this.engine.get('lighting');
        if (lighting?.registerMaterials) lighting.registerMaterials(mats);
        else this.engine.bus.emit('lighting:register', { materials: mats });
      } catch { this.engine.bus.emit('lighting:register', { materials: mats }); }

      this._bind();

      let tris = 0;
      for (const m of meshes) tris += (m.geometry.getIndex()?.count ?? 0) / 3;
      console.info(`[hero] ${meshes.length} skinned meshes, ${Math.round(tris)} tris, ` +
        `${this.rig.count} bones, cloak ${this.cloak.n} particles, ${HERO_HEIGHT.toFixed(2)} m tall`);
    } catch (e) {
      this.failed = true;
      console.error('[hero] init failed — module disabled', e);
      throw e;
    }
  }

  _bind() {
    const bus = this.engine.bus;
    const on = (evt, fn) => { try { this._offs.push(bus.on(evt, fn)); } catch { /* bus optional */ } };
    on('damage', (p) => {
      // Combat may route damage through the bus rather than calling us.
      if (!p || p.__fromHero) return;
      if (p.target === this || p.target === 'hero' || p.target?.id === 'hero') {
        this.applyDamage(p.amount ?? 0, p.source ?? p.sourceId ?? null, { silent: true, point: p.hitPoint });
      }
    });
    on('hero:command', (p) => {
      if (!p) return;
      if (p.attack) this.attack();
      if (p.heavy) this.heavy();
      if (p.dash) this.dash();
      if (p.cast) this.cast();
      if (p.moveTo) this.moveTo(p.moveTo.x, p.moveTo.z);
      if (p.revive) this.revive();
    });
  }

  /* ============================================================ helpers */

  _terrain() {
    const t = this.engine.get('terrain');
    return t && !t.__dead && typeof t.heightAt === 'function' ? t : null;
  }

  _groundY(x, z) {
    const t = this._terrain();
    if (!t) return 0;
    const y = t.heightAt(x, z);
    return finite(y) ? y : 0;
  }

  _placeAt(x, z, yaw) {
    const t = this._terrain();
    let bx = x, bz = z;
    if (t) {
      /* Search a deterministic spiral for the flattest walkable spot nearby.
         Flatness matters twice over: the hero is the frame's scale reference,
         and foot IK on a 30° tilt costs the silhouette its full height. */
      const slope = typeof t.slopeAt === 'function' ? (px, pz) => t.slopeAt(px, pz) : () => 0;
      const walk = typeof t.isWalkable === 'function' ? (px, pz) => t.isWalkable(px, pz) : () => true;
      let best = null, bestCost = 1e9;
      for (let r = 0; r <= 5; r++) {
        const n = r === 0 ? 1 : 10;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU + r * 0.31;
          const px = x + Math.cos(a) * r * 1.15, pz = z + Math.sin(a) * r * 1.15;
          if (!walk(px, pz)) continue;
          // local roughness across the foot stance, not just the point slope
          const h0 = t.heightAt(px, pz);
          let rough = 0;
          for (const [ox, oz] of [[0.16, 0], [-0.16, 0], [0, 0.16], [0, -0.16]]) {
            rough = Math.max(rough, Math.abs(t.heightAt(px + ox, pz + oz) - h0));
          }
          const cost = rough * 9 + slope(px, pz) * 2.4 + r * 0.30;
          if (cost < bestCost) { bestCost = cost; best = [px, pz]; }
        }
        if (best && bestCost < 0.35) break;
      }
      if (best) { bx = best[0]; bz = best[1]; }
    }
    this.position.set(bx, this._groundY(bx, bz), bz);
    this.footY = this.position.y;
    this.yaw = yaw ?? this.yaw;
    this.root.rotation.set(0, this.yaw, 0);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this.moveTarget = null;
  }

  /** Camera-relative forward on the ground plane. */
  _camBasis(outF, outR) {
    const cam = this.engine.camera;
    cam.getWorldDirection(_v3);
    outF.set(_v3.x, 0, _v3.z);
    if (outF.lengthSq() < 1e-6) outF.set(0, 0, 1);
    outF.normalize();
    outR.set(outF.z, 0, -outF.x);
    return outF;
  }

  _ctx(dt) {
    const c = this._ctxObj ??= {};
    c.moveW = this._locoW;
    c.gait = this._gait;
    c.turn = this._turnAmt;
    c.armDamp = this._actW;
    c.elapsed = this.engine.clock.elapsed;
    c.dt = dt;
    c.seed = 0.37;
    return c;
  }

  /* =========================================================== public API */

  moveTo(x, z) {
    if (this.isDead) return;
    (this.moveTarget ??= new THREE.Vector3()).set(x, this._groundY(x, z), z);
  }

  /** Advance the three-hit combo, or start it. */
  attack() {
    if (this.isDead || this._locked('attack')) return false;
    const inWindow = this._comboWindow > 0;
    this.comboIndex = inWindow ? (this.comboIndex + 1) % COMBO.length : 0;
    const name = COMBO[this.comboIndex];
    if (!this.graph.playAction(name, { fade: inWindow ? 0.07 : 0.11, restart: true })) return false;
    this.state = 'attack';
    this._comboWindow = 0;
    this._emitCast(name, this.comboIndex + 1);
    return true;
  }

  heavy() {
    if (this.isDead || this._locked('heavy')) return false;
    if (!this.graph.playAction('heavy', { fade: 0.12, restart: true })) return false;
    this.state = 'heavy';
    this.comboIndex = 0;
    this._emitCast('heavy', 3);
    return true;
  }

  cast() {
    if (this.isDead || this._locked('cast')) return false;
    if (!this.graph.playAction('cast', { fade: 0.14, restart: true })) return false;
    this.state = 'cast';
    this._emitCast('cast', 2);
    return true;
  }

  dash() {
    if (this.isDead || this.graph.baseClip === 'dash') return false;
    // Commit to the facing we already have, or to the movement intent.
    if (!this.graph.playBase('dash', { fade: 0.09, restart: true })) return false;
    this.graph.clearAction(0.08);
    this.state = 'dash';
    this._invuln = 0.42;
    this._emitCast('dash', 1);
    this.engine.bus.emit('camera:shake', { amp: 0.06, freq: 24, duration: 0.18 });
    return true;
  }

  /** @param {number} n damage @param {*} src attacker */
  applyDamage(n, src = null, o = {}) {
    if (this.isDead) return 0;
    const amount = Math.max(0, finite(n) ? n : 0);
    if (this._invuln > 0) return 0;
    const mitig = amount * (1 - clamp(this.stats.armour / (this.stats.armour + 900), 0, 0.62));
    this.stats.health = Math.max(0, this.stats.health - mitig);
    this._flash = 1;

    /* directional react: which way did the blow come from? */
    let dirLocal = 1, sideLocal = 0;
    const from = o.point ?? src?.position ?? src?.root?.position ?? null;
    if (from && finite(from.x)) {
      _v1.set(from.x - this.position.x, 0, from.z - this.position.z);
      if (_v1.lengthSq() > 1e-6) {
        _v1.normalize();
        const rel = wrapPi(Math.atan2(_v1.x, _v1.z) - this.yaw);
        dirLocal = Math.cos(rel);
        sideLocal = Math.sin(rel);
      }
    }
    const heavyHit = mitig > this.stats.maxHealth * 0.16;
    if (this.stats.health <= 0) {
      this._die(src, from);
    } else if (heavyHit) {
      this.graph.playBase('stagger', { fade: 0.07, restart: true });
      this.state = 'stagger';
      this.graph.clearAction(0.08);
    } else {
      const clipName = Math.abs(sideLocal) > Math.abs(dirLocal)
        ? (sideLocal > 0 ? 'hitLeft' : 'hitRight')
        : (dirLocal > 0 ? 'hitFront' : 'hitBack');
      this.graph.playAction(clipName, { fade: 0.05, restart: true });
      this.graph.impulse(['spine2', 'spine3', 'head'], [-0.22 * dirLocal, 0.10 * sideLocal, 0.16 * sideLocal], 1, 7);
      if (this.state !== 'dash') this.state = 'hit';
    }
    this._invuln = Math.max(this._invuln, 0.12);
    if (!o.silent) {
      this.engine.bus.emit('damage', {
        target: this, amount: mitig, type: o.type ?? 'physical', crit: !!o.crit,
        hitPoint: from ?? this.position, hitNormal: _v1.clone(), sourceId: src?.id ?? null, __fromHero: true,
      });
    }
    return mitig;
  }

  heal(n) {
    if (this.isDead) return;
    this.stats.health = Math.min(this.stats.maxHealth, this.stats.health + Math.max(0, n || 0));
  }

  revive() {
    this.isDead = false;
    this.stats.health = this.stats.maxHealth;
    this.state = 'idle';
    this.graph.playBase('locomotion', { fade: 0.35, restart: true });
    this.graph.clearAction(0.2);
  }

  _die(src, point) {
    this.isDead = true;
    this.state = 'dead';
    this.moveTarget = null;
    this.velocity.set(0, 0, 0);
    this.graph.clearAction(0.10);
    this.graph.playBase('death', { fade: 0.12, restart: true });
    this.engine.bus.emit('death', { entity: this, killer: src ?? null, hitPoint: point ?? this.position.clone() });
    this.engine.bus.emit('ui:toast', { text: 'You have fallen', tier: 'danger' });
  }

  _locked(next) {
    const g = this.graph;
    if (g.baseClip === 'dash' || g.baseClip === 'death' || g.baseClip === 'stagger') return true;
    const a = g.action;
    if (a === 'none') return false;
    const clip = g.actionClips[a];
    // Attacks may be chained inside the combo window; anything else commits.
    if (next === 'attack' && clip?.tag === 'attack') return this._comboWindow <= 0;
    return g.actionRemaining > 0.06;
  }

  _emitCast(id, level) {
    this._camBasis(_fwd, _v2);
    _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.engine.bus.emit('ability:cast', {
      id, caster: this, level,
      origin: _v3.set(this.position.x, this.position.y + 1.15, this.position.z).clone(),
      dir: _v1.clone(),
    });
  }

  /* ==================================================== animation events */

  _onAnimEvent(name, clip, data) {
    switch (name) {
      case 'swing:start':
        this._trailGain = 1;
        this._trailPeak = data?.trail ?? 1;
        break;
      case 'impact': {
        // The contact frame, driven by the animation — never by a timer.
        const mag = data?.mag ?? 0.6;
        this._weaponWorld(_tip, _hilt);
        _v1.copy(_tip).lerp(_hilt, 0.28);
        _nrm.set(Math.sin(this.yaw), 0.25, Math.cos(this.yaw)).normalize();
        this.engine.bus.emit('impact', {
          point: _v1.clone(), normal: _nrm.clone(),
          kind: data?.kind ?? 'slash', magnitude: mag, source: this,
        });
        this._comboWindow = clip === 'attack3' ? 0 : 0.34;
        break;
      }
      case 'shake':
        this.engine.bus.emit('camera:shake', {
          amp: data?.amp ?? 0.2, freq: data?.freq ?? 18, duration: data?.dur ?? 0.3,
        });
        break;
      case 'cast:release':
        this._weaponWorld(_tip, _hilt);
        _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.engine.bus.emit('impact', {
          point: _v3.set(this.position.x + _v1.x * 0.9, this.position.y + 1.25, this.position.z + _v1.z * 0.9).clone(),
          normal: _v1.clone(), kind: 'arcane', magnitude: data?.mag ?? 0.8, source: this,
        });
        this.engine.bus.emit('camera:shake', { amp: 0.09, freq: 17, duration: 0.28 });
        break;
      case 'dash:ground':
        _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.engine.bus.emit('impact', {
          point: _v3.set(this.position.x + _v1.x * 0.5, this.position.y + 0.06, this.position.z + _v1.z * 0.5).clone(),
          normal: _v2.set(0, 1, 0).clone(), kind: 'dust', magnitude: 0.35, source: this,
        });
        break;
      case 'death:impact':
        this.engine.bus.emit('camera:shake', { amp: 0.3, freq: 12, duration: 0.5 });
        break;
      default:
        break;
    }
  }

  /* ================================================================ frame */

  update(dt, elapsed) {
    if (this.failed || !this.rig) return;

    this._invuln = Math.max(0, this._invuln - dt);
    this._comboWindow = Math.max(0, this._comboWindow - dt);
    this._flash = Math.max(0, this._flash - dt * 5.2);
    this.mesh.setFlash(this._flash * this._flash);

    this._runScript(dt);
    if (!this._script?.suppressInput) this._readInput();
    this._move(dt);

    /* ---- animation ---- */
    const g = this.graph;
    const locked = g.baseClip === 'dash' || g.baseClip === 'stagger' || g.baseClip === 'death'
      || (g.action !== 'none' && g.actionClips[g.action]?.tag !== 'hit');
    const animSpeed = locked ? 0 : this.speed;
    const targetW = smoothstep(0.10, 1.05, animSpeed);
    const targetG = clamp01((animSpeed - this.stats.walkSpeed) / Math.max(0.5, this.stats.moveSpeed - this.stats.walkSpeed));
    this._locoW = expo(this._locoW, targetW, dt, 0.085);
    this._gait = expo(this._gait, targetG, dt, 0.12);
    this._actW = expo(this._actW, g.action === 'none' ? 0 : 1, dt, 0.075);
    g.lowerGain = 1 - 0.86 * this._locoW;
    const stride = lerp(1.32, 2.90, this._gait);
    g.locoRate = clamp(Math.max(animSpeed, 0.001) / stride, 0.28, 2.6);

    g.update(dt, this._ctx(dt));

    /* root motion from the clip, applied along the facing */
    if (Math.abs(g.rootDelta) > 1e-6) {
      _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(g.rootDelta);
      this._step(_v1.x, _v1.z);
      this.velocity.set(_v1.x / dt, 0, _v1.z / dt);
      this.speed = Math.hypot(this.velocity.x, this.velocity.z);
    }
    if (Math.abs(g.rootYawDelta) > 1e-6) {
      this.yaw = wrapPi(this.yaw + g.rootYawDelta);
      this.root.rotation.y = this.yaw;
    }

    /* ---- state label ---- */
    if (this.isDead) this.state = 'dead';
    else if (g.baseClip === 'dash') this.state = 'dash';
    else if (g.baseClip === 'stagger') this.state = 'stagger';
    else if (g.action !== 'none') {
      const tag = g.actionClips[g.action]?.tag;
      this.state = tag === 'hit' ? 'hit' : (tag ?? 'attack');
    } else this.state = this.speed > 0.25 ? 'move' : 'idle';

    this.root.updateMatrixWorld(true);

    /* ---- IK ---- */
    const ikOn = !this.isDead && g.baseClip !== 'dash';
    this._footIK(dt, ikOn ? 1 : 0);
    this._lookIK(dt, ikOn ? 1 : 0.25);
    this.root.updateMatrixWorld(true);

    /* ---- secondary ---- */
    this.cloak.setDrag(this.velocity.x, this.velocity.y, this.velocity.z);
    this.cloak.update(dt);
    this._updateTrail(dt);
    this._updateContact();

    /* Cursor raycasts must land on the hero's plane, not on y = 0. */
    try { this.engine.input?.setGroundHeight?.(this.footY); } catch { /* optional */ }
    void elapsed;
  }

  /* -------------------------------------------------------- movement */

  _readInput() {
    const input = this.engine.input;
    if (!input || this.isDead) return;

    if (input.justPressed?.('Space')) this.dash();
    if (input.justPressed?.('mouse2') || input.justPressed?.('KeyQ')) this.attack();
    if (input.justPressed?.('KeyE')) this.heavy();
    if (input.justPressed?.('KeyR') || input.justPressed?.('KeyF')) this.cast();

    /* WASD, camera relative */
    this._camBasis(_fwd, _v2);
    let ix = 0, iz = 0;
    if (input.pressed?.('KeyW') || input.pressed?.('ArrowUp')) iz += 1;
    if (input.pressed?.('KeyS') || input.pressed?.('ArrowDown')) iz -= 1;
    if (input.pressed?.('KeyA') || input.pressed?.('ArrowLeft')) ix -= 1;
    if (input.pressed?.('KeyD') || input.pressed?.('ArrowRight')) ix += 1;
    if (ix || iz) {
      this._desired.set(_fwd.x * iz + _v2.x * ix, 0, _fwd.z * iz + _v2.z * ix);
      if (this._desired.lengthSq() > 1e-6) this._desired.normalize();
      this.moveTarget = null;
      this._inputHeld = true;
      return;
    }
    this._inputHeld = false;

    /* click to move */
    if (input.down?.(0)) {
      const g = input.mouse?.worldGround;
      if (g && finite(g.x)) {
        const dx = g.x - this.position.x, dz = g.z - this.position.z;
        if (dx * dx + dz * dz > 0.16) this.moveTo(g.x, g.z);
      }
    }
  }

  _move(dt) {
    const locked = this.isDead
      || this.graph.baseClip === 'dash' || this.graph.baseClip === 'stagger'
      || (this.graph.action !== 'none' && this.graph.actionClips[this.graph.action]?.tag !== 'hit');

    /* ---- desired direction ---- */
    let want = 0;
    if (!locked) {
      if (this._inputHeld) {
        want = 1;
      } else if (this.moveTarget) {
        _v1.set(this.moveTarget.x - this.position.x, 0, this.moveTarget.z - this.position.z);
        const d = _v1.length();
        if (d < 0.28) { this.moveTarget = null; }
        else { this._desired.copy(_v1).multiplyScalar(1 / d); want = clamp01(d / 0.9); }
      }
    }

    /* ---- yaw: snappy in place, wide arcs at speed ---- */
    if (want > 0.02) {
      const targetYaw = Math.atan2(this._desired.x, this._desired.z);
      const err = wrapPi(targetYaw - this.yaw);
      this._turnAmt = expo(this._turnAmt, clamp(err * 1.5, -1, 1), dt, 0.10);
      const rate = lerp(13.5, 6.2, clamp01(this.speed / this.stats.moveSpeed));
      const step = clamp(err, -rate * dt, rate * dt);
      this.yaw = wrapPi(this.yaw + step);
      // Do not power out of a hard turn: pivot first, then accelerate.
      want *= 1 - smoothstep(1.05, 2.25, Math.abs(err));
    } else {
      this._turnAmt = expo(this._turnAmt, 0, dt, 0.16);
    }
    this.root.rotation.y = this.yaw;

    /* ---- speed ---- */
    const maxSpd = (this._script?.walk || this.engine.input?.pressed?.('ShiftLeft'))
      ? this.stats.walkSpeed : this.stats.moveSpeed;
    const targetSpd = locked ? 0 : want * maxSpd;
    const a = targetSpd > this.speed ? this.accel : this.decel;
    this.speed = this.speed + clamp(targetSpd - this.speed, -a * dt, a * dt);
    if (this.speed < 0.01) this.speed = 0;

    if (!locked && this.speed > 0) {
      _v1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.speed * dt);
      this._step(_v1.x, _v1.z);
      this.velocity.set(_v1.x / dt, 0, _v1.z / dt);
    } else if (locked) {
      this.velocity.multiplyScalar(Math.exp(-dt * 6));
    } else {
      this.velocity.set(0, 0, 0);
    }

    /* ---- terrain following ---- */
    const gy = this._groundY(this.position.x, this.position.z);
    this.velocity.y = (gy - this.position.y) / Math.max(1e-4, dt);
    this.position.y = gy;
    this.footY = gy;
  }

  /** Move on the ground plane, refusing to leave walkable terrain. */
  _step(dx, dz) {
    const t = this._terrain();
    const nx = this.position.x + dx, nz = this.position.z + dz;
    if (t && typeof t.isWalkable === 'function' && !t.isWalkable(nx, nz)) {
      // slide along whichever axis still works, so a wall does not stop dead
      if (t.isWalkable(nx, this.position.z)) { this.position.x = nx; return; }
      if (t.isWalkable(this.position.x, nz)) { this.position.z = nz; return; }
      this.moveTarget = null;
      this.speed *= 0.25;
      return;
    }
    this.position.x = nx;
    this.position.z = nz;
  }

  /* -------------------------------------------------------------- IK */

  /**
   * Two-bone foot IK with pelvis compensation. This is the single change that
   * most makes a character look like it exists in the world: on a slope the
   * downhill leg extends, the uphill knee bends, the pelvis drops to the lower
   * foot, and both soles tilt to the surface normal instead of intersecting it.
   */
  _footIK(dt, weight) {
    const rig = this.rig;
    const w0 = clamp01(weight);
    const bones = ['_L', '_R'];
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    /* Pass 1: measure the *terrain deviation* under each ankle — how much the
       ground there differs from the plane the root is standing on. Goals are
       authored relative to the animated pose, so a hand-tuned stance survives
       flat ground untouched and only deforms where the world actually slopes.
       Solving to an absolute height instead would silently straighten every
       clip's knee bend, which is the classic foot-IK mistake. */
    const dev = [0, 0];
    const goalY = [0, 0];
    const wgt = [0, 0];
    for (let s = 0; s < 2; s++) {
      const foot = rig.bone('foot' + bones[s]);
      if (!foot) continue;
      foot.updateWorldMatrix(true, false);
      _v1.setFromMatrixPosition(foot.matrixWorld);
      const gy = this._groundY(_v1.x, _v1.z);
      dev[s] = gy - this.position.y;
      // Never let the sole punch through: the goal is at least the boot's
      // thickness above the surface at that point.
      goalY[s] = Math.max(gy + ANKLE_Y - SOLE_Y - 0.030, _v1.y + dev[s]);
      // Fade IK out while the foot is in flight: a swinging leg must not be
      // dragged back onto the ground mid-stride.
      const lift = _v1.y - (this.position.y + ANKLE_Y);
      wgt[s] = w0 * (1 - smoothstep(0.045, 0.175, lift));
      this._footW[s] = wgt[s];
    }

    /* Pelvis: settle toward the lower foot so the far leg can still reach.
       Partial (0.8) and hard-clamped — full compensation on noisy ground reads
       as a permanent crouch and would break the hero's job as the scale ruler. */
    const drop = Math.min(dev[0], dev[1]);
    const target = w0 > 0.01 ? clamp(drop * 0.8, -0.17, 0.07) : 0;
    this._pelvisOff = expo(this._pelvisOff, target, dt, 0.10);
    const pelvis = rig.bones[0];
    if (pelvis) {
      pelvis.position.y += this._pelvisOff;
      pelvis.updateWorldMatrix(false, true);
    }

    /* pass 2: solve, then roll the sole onto the surface */
    const t = this._terrain();
    for (let s = 0; s < 2; s++) {
      if (wgt[s] <= 0.01) continue;
      const L = bones[s];
      const thigh = rig.bone('thigh' + L), shin = rig.bone('shin' + L), foot = rig.bone('foot' + L);
      if (!thigh || !shin || !foot) continue;
      foot.updateWorldMatrix(true, false);
      _v1.setFromMatrixPosition(foot.matrixWorld);
      _v2.set(_v1.x, goalY[s], _v1.z);
      twoBoneIK(thigh, shin, foot, _v2, _fwd, wgt[s]);
      if (t && typeof t.normalAt === 'function') {
        t.normalAt(_v1.x, _v1.z, _nrm);
        if (_nrm.lengthSq() > 1e-6) {
          _nrm.lerp(_v3.set(0, 1, 0), 0.34).normalize();
          alignBoneUp(foot, _nrm, wgt[s] * 0.85, 0.36);
        }
      }
    }
  }

  /** Head and upper spine turn toward the cursor or the current target. */
  _lookIK(dt, weight) {
    let tx = null, ty = 0, tz = 0;
    const lt = this._lookTarget;
    if (lt) { tx = lt.x; ty = lt.y; tz = lt.z; }
    else {
      const g = this.engine.input?.mouse?.worldGround;
      if (g && finite(g.x)) {
        const d2 = (g.x - this.position.x) ** 2 + (g.z - this.position.z) ** 2;
        if (d2 > 1.6) { tx = g.x; ty = this.position.y + 1.25; tz = g.z; }
      }
    }
    let yaw = 0, pitch = 0;
    if (tx !== null) {
      const dx = tx - this.position.x, dz = tz - this.position.z;
      const dist = Math.hypot(dx, dz);
      yaw = clamp(wrapPi(Math.atan2(dx, dz) - this.yaw), -1.20, 1.20);
      const eye = this.position.y + 1.62;
      pitch = clamp(Math.atan2(eye - ty, Math.max(0.6, dist)), -0.30, 0.42);
      // Beyond ±90° the head would break; hand the turn to the body instead.
      const fade = 1 - smoothstep(1.05, 1.20, Math.abs(yaw));
      yaw *= fade; pitch *= fade;
    }
    this._lookYaw = expo(this._lookYaw, yaw * weight, dt, 0.16);
    this._lookPitch = expo(this._lookPitch, pitch * weight, dt, 0.20);
    if (Math.abs(this._lookYaw) > 1e-4 || Math.abs(this._lookPitch) > 1e-4) {
      applyLook(this.rig, this._lookYaw, this._lookPitch, 1);
    }
  }

  /* ---------------------------------------------------------- weapon trail */

  _buildTrail() {
    const n = TRAIL_N;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 2 * 3);
    const age = new Float32Array(n * 2);
    const side = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      age[i * 2] = age[i * 2 + 1] = i / (n - 1);
      side[i * 2] = 0; side[i * 2 + 1] = 1;
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAge', new THREE.BufferAttribute(age, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uGain: { value: 0 },
        uCore: { value: new THREE.Color(0xcfe4ff) },
        uEdge: { value: new THREE.Color(0x4d7dc4) },
      },
      vertexShader: /* glsl */`
        attribute float aAge; attribute float aSide;
        varying float vAge; varying float vSide;
        void main() {
          vAge = aAge; vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform float uGain; uniform vec3 uCore; uniform vec3 uEdge;
        varying float vAge; varying float vSide;
        void main() {
          float life = pow( 1.0 - vAge, 1.9 );
          // bright at the tip, cool and thin toward the hilt
          float radial = smoothstep( 0.0, 0.55, vSide );
          float a = life * ( 0.10 + radial * 0.90 ) * uGain;
          if ( a < 0.004 ) discard;
          vec3 c = mix( uEdge, uCore, radial * life );
          gl_FragColor = vec4( c * a * 0.85, a );
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'heroTrail';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.userData.occluder = false;
    mesh.renderOrder = 6;
    this.holder.add(mesh);
    this.trail = { mesh, geo, mat, pos, attr: geo.getAttribute('position'), filled: false };
  }

  _weaponWorld(outTip, outHilt) {
    const bone = this.rig.bone(this.mesh.weapon.bone);
    if (!bone) { outTip.copy(this.position); outHilt.copy(this.position); return; }
    bone.updateWorldMatrix(true, false);
    outTip.copy(this.mesh.weapon.tip).applyMatrix4(bone.matrixWorld);
    outHilt.copy(this.mesh.weapon.hilt).applyMatrix4(bone.matrixWorld);
  }

  /**
   * The trail is driven by the blade's measured tip speed, not by "an attack is
   * playing". That matters: the wind-up and the recovery of a swing are slow, and
   * ribboning them produces a huge stationary sheet of light. Keyed on speed, the
   * streak exists only across the fast part of the arc, which is also the only
   * place a real motion smear would be.
   */
  _updateTrail(dt) {
    const t = this.trail;
    const g = this.graph;
    const swinging = g.action !== 'none'
      && (g.actionClips[g.action]?.tag === 'attack' || g.actionClips[g.action]?.tag === 'heavy');

    this._weaponWorld(_tip, _hilt);
    let tipSpeed = 0;
    if (this._tipPrev) tipSpeed = this._tipPrev.distanceTo(_tip) / Math.max(1e-4, dt);
    else this._tipPrev = new THREE.Vector3();
    this._tipPrev.copy(_tip);

    const want = swinging ? smoothstep(7, 20, tipSpeed) : 0;
    this._trailGain = want > this._trailGain
      ? Math.min(want, this._trailGain + dt * 14)
      : Math.max(want, this._trailGain - dt * 5.5);
    t.mat.uniforms.uGain.value = this._trailGain * this._trailPeak * 0.34;
    t.mesh.visible = this._trailGain > 0.012;
    if (!t.mesh.visible) { t.filled = false; return; }

    const p = t.pos;
    if (!t.filled) {
      for (let i = 0; i < TRAIL_N; i++) {
        p[i * 6] = _hilt.x; p[i * 6 + 1] = _hilt.y; p[i * 6 + 2] = _hilt.z;
        p[i * 6 + 3] = _tip.x; p[i * 6 + 4] = _tip.y; p[i * 6 + 5] = _tip.z;
      }
      t.filled = true;
    } else {
      p.copyWithin(6, 0, (TRAIL_N - 1) * 6);
      p[0] = _hilt.x; p[1] = _hilt.y; p[2] = _hilt.z;
      p[3] = _tip.x; p[4] = _tip.y; p[5] = _tip.z;
    }
    t.attr.needsUpdate = true;
  }

  /* ------------------------------------------------------ contact shadow */

  /**
   * Contact occlusion. The CSM shadow anchors the hero at range, but a soft
   * multiplicative pool under the body and a tight one under each sole is what
   * removes the "floating" read at close quarters. Multiplicative, not additive
   * darkening, so it never lifts the blacks.
   */
  _buildContact() {
    const geo = new THREE.PlaneGeometry(2.0, 2.0, 1, 1);
    geo.rotateX(-Math.PI * 0.5);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uFootA: { value: new THREE.Vector3() },
        uFootB: { value: new THREE.Vector3() },
        uBody: { value: new THREE.Vector2() },
        uGain: { value: 1 },
      },
      vertexShader: /* glsl */`
        varying vec2 vP;
        void main() {
          vP = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uFootA; uniform vec3 uFootB; uniform vec2 uBody; uniform float uGain;
        varying vec2 vP;
        float lobe( vec2 p, vec2 c, float r, float k ) {
          float d = length( ( p - c ) / r );
          return exp( -d * d * k );
        }
        void main() {
          // Kept well under 1: at 0.90 the pool read as a black hole punched in
          // the floor at gameplay distance, which is worse than no contact
          // shadow at all. The CSM shadow does the heavy lifting; this only has
          // to close the gap under the soles.
          float a = lobe( vP, uBody, 0.44, 2.5 ) * 0.26
                  + lobe( vP, uFootA.xy, 0.155, 2.7 ) * uFootA.z
                  + lobe( vP, uFootB.xy, 0.155, 2.7 ) * uFootB.z;
          a = clamp( a * uGain, 0.0, 0.62 );
          if ( a < 0.003 ) discard;
          gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'heroContact';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    mesh.userData.occluder = false;
    mesh.userData.noOcclude = true;
    this.holder.add(mesh);
    this.contact = { mesh, mat, geo };
  }

  _updateContact() {
    const c = this.contact;
    if (!c) return;
    const t = this._terrain();
    c.mesh.position.set(this.position.x, this.position.y + 0.016, this.position.z);
    if (t && typeof t.normalAt === 'function') {
      t.normalAt(this.position.x, this.position.z, _nrm);
      _qt.setFromUnitVectors(_v1.set(0, 1, 0), _nrm.lengthSq() > 1e-6 ? _nrm : _v2.set(0, 1, 0));
      c.mesh.quaternion.copy(_qt);
    }
    const u = c.mat.uniforms;
    for (let s = 0; s < 2; s++) {
      const b = this.rig.bone(s === 0 ? 'foot_L' : 'foot_R');
      const dst = s === 0 ? u.uFootA.value : u.uFootB.value;
      if (!b) { dst.set(0, 0, 0); continue; }
      _v1.setFromMatrixPosition(b.matrixWorld);
      // local plane coords: the blob is axis-aligned, so this is a plain offset
      const h = _v1.y - this.position.y;
      dst.set(_v1.x - this.position.x, _v1.z - this.position.z,
        0.46 * (1 - smoothstep(0.09, 0.42, h)));
    }
    const pelvis = this.rig.bones[0];
    if (pelvis) {
      _v1.setFromMatrixPosition(pelvis.matrixWorld);
      u.uBody.value.set((_v1.x - this.position.x) * 0.75, (_v1.z - this.position.z) * 0.75);
    }
    u.uGain.value = this.isDead ? 1.15 : 1.0;
  }

  /* --------------------------------------------------------- scenarios */

  /**
   * Every point the hero will be STANDING on while this scenario plays, not just
   * where it stands the instant `applyScenario` returns.
   *
   * A scripted scenario walks the hero several metres along `dir.path` and the
   * camera follows, so the framed area sweeps with it — and the harness captures
   * that scenario at wildly different points along the walk (90 frames in
   * tools/shot.mjs is 1.5 s and leaves the dungeon hero mid-path; tools/actors.mjs
   * lets it run ~7 s and reach the end). There is no single position to compose
   * against, so hand out the whole route and let the caller compose for all of
   * it. Element 0 is the PRIMARY composition point: the destination, because that
   * is where the encounter is and where the hero ends up.
   *
   * @param {THREE.Vector3[]} [out]
   * @returns {THREE.Vector3[]} at least one point, nearest-to-final first
   */
  scenarioAnchor(out = []) {
    out.length = 0;
    const p = this._script?.path;
    if (Array.isArray(p) && p.length) {
      for (let i = p.length - 1; i >= 0; i--) {
        const q = p[i];
        if (!Array.isArray(q) || !finite(q[0]) || !finite(q[1])) continue;
        out.push(new THREE.Vector3(q[0], this._groundY(q[0], q[1]), q[1]));
      }
    }
    // The live position covers the unscripted scenarios and, for a scripted one,
    // the frames before the body has moved off its start mark.
    out.push(this.position.clone());
    return out;
  }

  applyScenario(name, cfg) {
    try {
      const dir = SCENARIO_DIRECTION[name] ?? {};
      const camYaw = finite(cfg?.camera?.yaw) ? cfg.camera.yaw : 0;

      /* The rig places the lens in the direction (sin yaw, cos yaw) from the
         subject, so facing the camera means matching its yaw exactly. Then
         rotate off-axis: dead-on reads as a character-select screen, and a
         positive offset swings the sword arm toward the lens. */
      const yawDeg = finite(dir.yaw) ? dir.yaw : camYaw + (dir.yawOffset ?? 0);
      const yaw = wrapPi(yawDeg * DEG);

      const start = dir.path?.[0] ?? [0, 0];
      this.isDead = false;
      this.stats.health = this.stats.maxHealth;
      this.comboIndex = 0;
      this._comboWindow = 0;
      this._invuln = 0;
      this._flash = 0;
      this._locoW = 0; this._gait = 0; this._actW = 0; this._turnAmt = 0;
      this._pelvisOff = 0; this._lookYaw = 0; this._lookPitch = 0;
      this._trailGain = 0; this._trailPeak = 1;
      this.state = 'idle';
      this._inputHeld = false;

      this.graph.playBase('locomotion', { fade: 0 });
      this.graph.act.play('none', { fade: 0 });
      this.graph.clearAction(0);
      this.rig.restPose();

      this._placeAt(start[0], start[1], yaw);

      this._script = {
        name,
        timeline: dir.timeline ?? [],
        path: dir.path ?? null,
        walk: !!dir.walk,
        suppressInput: true,
      };
      this._scriptT = 0;
      this._scriptI = 0;
      this._pathI = 1;
      this._lookTarget = null;
      if (dir.look) {
        // authored in hero-local metres: forward is +Z
        const c = Math.cos(yaw), s = Math.sin(yaw);
        this._lookTarget = new THREE.Vector3(
          this.position.x + dir.look[0] * c + dir.look[2] * s,
          this.position.y + dir.look[1],
          this.position.z - dir.look[0] * s + dir.look[2] * c
        );
      }
      if (this._script.path && this._script.path.length > 1) {
        const p = this._script.path[1];
        this.moveTo(p[0], p[1]);
      }

      this.root.rotation.set(0, this.yaw, 0);
      this.root.updateMatrixWorld(true);
      this.graph.update(1 / 60, this._ctx(1 / 60));
      this.root.updateMatrixWorld(true);
      this.cloak.reset();
      this._updateContact();
    } catch (e) {
      console.error('[hero] applyScenario failed —', e);
    }
  }

  _runScript(dt) {
    const s = this._script;
    if (!s) return;
    this._scriptT += dt;
    const tl = s.timeline;
    while (this._scriptI < tl.length && tl[this._scriptI].t <= this._scriptT) {
      const step = tl[this._scriptI++];
      if (step.act === 'heavy') this.heavy();
      else if (step.act === 'cast') this.cast();
      else if (step.act === 'dash') this.dash();
      else if (step.act && step.act.startsWith('attack')) {
        const i = COMBO.indexOf(step.act);
        this.comboIndex = i < 0 ? 0 : i;
        if (this.graph.playAction(step.act, { fade: 0.10, restart: true })) {
          this.state = 'attack';
          this._emitCast(step.act, this.comboIndex + 1);
        }
      }
    }
    /* Re-arm the combo when the schedule runs dry. The harness captures a
       different frame count per scenario, so a one-shot timeline would put the
       hero in whatever pose happened to land on frame N; looping guarantees the
       capture lands inside a swing whenever it happens. */
    if (tl.length && this._scriptI >= tl.length && !this.graph.actionBusy && !this.graph.baseBusy) {
      const back = Math.min(tl.length - 1, s.loopAt ?? 0);
      this._scriptI = back;
      this._scriptT = tl[back].t - 0.18;
    }

    /* follow the authored path so the walk cycle is exercised on real terrain */
    if (s.path && !this.moveTarget && this._pathI < s.path.length - 1) {
      const p = s.path[++this._pathI];
      this.moveTo(p[0], p[1]);
    }
  }

  /* -------------------------------------------------------------- misc */

  /** World position of the sword tip — VFX and combat both want this. */
  weaponTip(out = new THREE.Vector3()) {
    this._weaponWorld(out, _hilt);
    return out;
  }

  /** Chest-height aim origin. */
  aimOrigin(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + 1.18, this.position.z);
  }

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* ignore */ } }
    this._offs.length = 0;
    try { this.cloak?.dispose(); } catch { /* ignore */ }
    try { this.mesh?.dispose(); } catch { /* ignore */ }
    try { this.trail?.geo.dispose(); this.trail?.mat.dispose(); } catch { /* ignore */ }
    try { this.contact?.geo.dispose(); this.contact?.mat.dispose(); } catch { /* ignore */ }
    try { this.rig?.dispose(); } catch { /* ignore */ }
    try {
      this.root.remove(this.holder);
      this.engine.scene.remove(this.root);
    } catch { /* ignore */ }
  }
}
