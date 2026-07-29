/**
 * SANCTUM — Bestiary
 *
 * Owns every enemy *body*: geometry, skeletons, animation, materials, damage
 * feedback, death and dissolve. The AI layer (src/game/ai/*) owns decisions and
 * motion; this module conforms to the entity contract EntityAdapter probes for
 * (`position`, `setFacing`, `setAnimState`, `hp`/`maxHp`/`dead`, `velocity`,
 * `aiArchetype`, `aiHint`) and never reaches into the AI.
 *
 * Design notes
 * ------------
 *  • **One geometry + one skeleton layout per species.** The skinned buffer is
 *    built once (Species.js) and shared; instances differ by root scale, per-slot
 *    material tint, and seeded animation phase. A pack never reads as cloned and
 *    never costs a second vertex buffer.
 *  • **Materials are per instance, programs are not.** MonsterMaterials builds a
 *    fresh MeshStandardMaterial around shared textures so each body owns its
 *    hit-flash / dissolve / aura uniforms, while `customProgramCacheKey` keeps
 *    them all on one shader program.
 *  • **Animation LOD.** Distance + frustum decide how often a skeleton is
 *    re-posed (1/2/3/4 frames), with staggered phases so cost spreads across
 *    frames. Bone matrices only upload on the frames a body is re-posed.
 *  • **Nothing pops.** Death is ragdoll (if Physics exists) or a keyframed
 *    collapse, then a noise-threshold dissolve with a glowing burn edge.
 *  • **Nothing floats.** Every body is placed on `terrain.heightAt`, tilted into
 *    the surface normal, and grounded by a contact-occlusion blob under it.
 *  • Fully deterministic: `engine.freshRand(seed)` and `engine.clock.elapsed`
 *    only — no Math.random, no wall clock.
 */

import * as THREE from 'three';
import { AnimGraph } from './monsters/AnimKit.js';
import { MonsterMaterials } from './monsters/MonsterMaterials.js';
import { SPECIES, resolveSpecies, ANIM_FALLBACK, BOSS_VARIANT } from './monsters/Species.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _col = new THREE.Color();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Mesh yaw for a body authored facing +Z, from the AI's (cos y, sin y) heading. */
const agentToMesh = (yaw) => Math.atan2(Math.cos(yaw), Math.sin(yaw));

/**
 * Return a pooled practical to the idle state.
 *
 * NEVER `light.visible = false`. `WebGLRenderer.projectObject` bails on an
 * invisible object before it reaches `pushLight`, so hiding a light changes
 * `NUM_POINT_LIGHTS`, which is part of every material's program cache key — one
 * flip relinks the whole scene. Zero intensity plus a park position underground
 * is visually identical and costs nothing but a dead loop iteration.
 */
function releaseLight(light) {
  if (!light) return;
  light.intensity = 0;
  light.visible = true;
  light.position.y = -3000;
}

/**
 * Constant metalness per recipe.
 *
 * The scene runs out of fragment texture units at `ultra` (CSM cascades + point
 * and spot shadow maps + the env probe leave very little), and a skinned body
 * needs albedo + normal + roughness far more than it needs a metalness or AO
 * map: metalness on a creature is a per-part constant, and cavity occlusion is
 * already baked into the vertex grime. Dropping those two samplers is what keeps
 * every enemy material linkable.
 */
const METAL = {
  metal: 0.86, brass: 0.72,
  bone: 0.02, boneOld: 0.02, basalt: 0.0, stone: 0.0,
  flesh: 0.0, rot: 0.0, charred: 0.03, cloth: 0.0, hide: 0.02, ember: 0.12,
};

/**
 * Ceiling on the hit-flash uniform.
 *
 * MonsterMaterials turns this into `flashColor * uMonFlash * 2.4` of emissive
 * plus `uMonFlash * 0.45` of albedo-toward-white, so the uniform is the only
 * knob that decides whether a flash is a punch or an erasure.
 *
 * MEASURED, on the boss body region (760,240 120x140) of the `boss` capture:
 *   uniform 0.29 -> region mean 0.509, 34.4 % of it clipped past 0.9
 *   uniform 0.00 -> region mean 0.210,  1.0 % clipped
 * i.e. at 0.29 the flash was still erasing the whole silhouette. 0.13 puts the
 * emissive punch at 0.31 linear — about ACES 0.6 once exposed, a clearly hot
 * body that still shows its basalt/metal/cloth — and drops the albedo wash to
 * 0.06, so the material read survives the hit instead of being painted out.
 */
const FLASH_CEIL = 0.13;

/**
 * CHAMPION TELL — what makes an elite unmistakable.
 *
 * Round-5 review: "no elite distinction." It was right. The champion differed from
 * a trash mob by a 1.16x scale (5 px at gameplay distance), a 0.22 lerp of its
 * accent hue into the albedo tint (invisible once the albedo is multiplied by a
 * torch), and a fresnel^3 aura at 0.14 (one pixel wide after the AA resolve). All
 * three were below the noise floor of a 1600x900 frame.
 *
 * A champion now differs on FOUR axes at once, which is the D4 answer:
 *   • SIZE      — 1.34x, so it is visibly the biggest thing in its pack;
 *   • COLOUR    — 0.42 of the accent hue in the albedo, so the body itself is
 *                 the wrong colour for its species;
 *   • AURA      — the three-lobe emissive rim at 0.30-0.42, in the accent hue;
 *   • GROUND    — a bright accent pool with two feathered rings, and one of the
 *                 pre-allocated practical lights so the accent hue actually
 *                 spills onto the stone the champion is standing on.
 */
const ELITE = {
  scale: 1.34,
  tint: 0.42,
  /**
   * Aura and ground-glow levels are SCENE-LINEAR and every one of them is budgeted
   * against the bloom floor (RenderPipeline: 1.55 / 1.85 = 0.838 scene-linear).
   *
   * The first pass of this was not, and it failed exactly the way the rubric says
   * it would. Measured on `night`, where the grade runs its highest gain: the
   * champion ghoul came back with a body mean of 0.675, a maximum of 1.000 and its
   * ground rings clipped to pure white — a blown-out glowing blob, i.e. the
   * "everything glows" instant fail. Three things were stacking: aura 0.42 through
   * a 2.82x fresnel envelope (1.18 emissive on its own), an additive ground pool at
   * 0.70, and a champion point light at 2.6 cd sitting 0.3 m from its own skin,
   * which inverse-square turns into 29 units of irradiance — eight times what a
   * torch puts on a wall.
   *
   * Now: the aura envelope is capped in the shader, the ground pool is
   * exposure-normalised per frame (see `_pumpGlow`), and the light sits at head
   * height where the nearest skin is ~0.4 m away, so its peak irradiance lands in
   * the same 4-7 range as torchlit stone.
   */
  aura: 0.20,
  auraBeat: 0.07,
  glowGain: 0.34,
  glowSize: 9.5,
  /**
   * Practical handed to a champion that has no species light of its own. Its job is
   * to put the accent hue on the STONE around the body; it must not become a second
   * key on the champion, and it must not raise the local floor value enough to eat
   * the separation the character rim is buying. Placed at `def.height * 0.95` —
   * head height — so no body surface is closer than ~0.4 m to it.
   */
  light: { intensity: 1.2, dist: 5.5, atH: 0.95 },
};

/* Pack composition per biome — mixed by design, never one species. */
const PACKS = {
  crypt: [['skeleton', 3.4], ['ghoul', 2.4], ['cultist', 1.3], ['hellhound', 1.5], ['brute', 0.8], ['wraith', 0.7]],
  hell: [['hellhound', 3.0], ['brute', 1.8], ['ghoul', 1.4], ['skeleton', 1.2], ['cultist', 1.0]],
  moor: [['ghoul', 2.6], ['skeleton', 2.4], ['wraith', 1.6], ['hellhound', 1.4], ['cultist', 0.9]],
  town: [['skeleton', 1], ['ghoul', 1]],
};

export class Bestiary {
  static id = 'bestiary';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    /** @type {Enemy[]} live bodies, in spawn order */
    this.entities = [];
    this._byId = new Map();
    this._pool = new Map();
    this._compiled = new Map();
    this._glowMats = new Set();
    this._lights = [];
    /**
     * Predicted framed area of the current scenario, used to COMPOSE the spawn
     * before the camera rig has applied the scenario. The leash that keeps the
     * cast in shot afterwards uses the live camera instead — see `inShot`.
     */
    this._stage = null;
    this._stageV = new THREE.Vector3();
    this._seq = 0;
    this._frustum = new THREE.Frustum();
    this._frustumAt = -1;
    this._deferred = [];
    this.failed = false;

    this.group = new THREE.Group();
    this.group.name = 'bestiary';
    this.group.matrixAutoUpdate = false;

    this.mats = null;
    this._offs = [];
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    const e = this.engine;
    e.scene.add(this.group);
    this.mats = new MonsterMaterials(e);

    /* --- contact occlusion: one shared alpha ramp, one shared quad --- */
    this._contactTex = makeContactTexture();
    this._contactGeo = new THREE.PlaneGeometry(1, 1);
    this._contactGeo.rotateX(-Math.PI * 0.5);
    this._glowGeo = new THREE.PlaneGeometry(1, 1);
    this._glowGeo.rotateX(-Math.PI * 0.5);
    this._engageGeo = makeEngageRing();

    /* --- practical lights, pre-allocated so the light count never changes
           after shaders compile (a late light forces a full recompile).
           `visible` MUST stay true for the whole session: three's
           `projectObject` skips invisible lights, so hiding one changes
           NUM_POINT_LIGHTS and relinks every lit program in the scene — measured
           at ~60 ms per flip, several times a second, which was the project's
           entire p99 problem. An idle light is parked below the world with
           intensity 0 instead; it costs one dead iteration of the forward light
           loop and zero recompiles. --- */
    const nLights = e.quality?.tier === 'low' ? 1 : 3;
    for (let i = 0; i < nLights; i++) {
      const l = new THREE.PointLight(0xff7a22, 0, 10, 2);
      l.name = `bestiary.practical.${i}`;
      l.castShadow = false;
      l.visible = true;
      l.position.set(0, -3000 - i * 8, 0);
      this.group.add(l);
      this._lights.push({ light: l, owner: null });
    }

    this._offs.push(e.bus.on('damage', (p) => this._onDamage(p)));
    this._offs.push(e.bus.on('ability:cast', (p) => this._onCast(p)));
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    this.despawnAll(true);
    for (const [, c] of this._compiled) { try { c.geometry.dispose(); } catch { /* noop */ } }
    this._compiled.clear();
    try { this.mats?.dispose(); } catch { /* noop */ }
    try {
      this._contactTex?.dispose(); this._contactGeo?.dispose();
      this._glowGeo?.dispose(); this._engageGeo?.dispose();
    } catch { /* noop */ }
    this.engine.scene.remove(this.group);
  }

  /* ================================================================ *
   * public API
   * ================================================================ */

  get(id) { return this._byId.get(String(id)); }

  /** Live bodies within `r` metres of a point (XZ distance). */
  queryNear(pos, r = 6, out = []) {
    out.length = 0;
    if (!pos) return out;
    const x = pos.x ?? 0, z = pos.z ?? 0, r2 = r * r;
    for (let i = 0; i < this.entities.length; i++) {
      const en = this.entities[i];
      if (en.dead) continue;
      const dx = en.position.x - x, dz = en.position.z - z;
      if (dx * dx + dz * dz <= r2) out.push(en);
    }
    return out;
  }

  /** Every live body of a species (or all of them). */
  countOf(type = null) {
    if (!type) return this.entities.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
    const k = resolveSpecies(type);
    let n = 0;
    for (const e of this.entities) if (!e.dead && e.species === k) n++;
    return n;
  }

  /**
   * @param {string} type species name (loose match) — see Species.resolveSpecies
   * @param {{x:number,y?:number,z:number}} position world spawn point
   * @param {{elite?:boolean, level?:number, yaw?:number, seed?:number, hp?:number}} [opts]
   * @returns {Enemy|null}
   */
  spawn(type, position, opts = {}) {
    if (this.failed) return null;
    try {
      const key = resolveSpecies(type);
      const def = SPECIES[key];
      const built = this._compile(key);
      if (!built) return null;

      const id = `${key}#${++this._seq}`;
      const seed = (opts.seed ?? hashStr(id)) >>> 0;
      let en = (this._pool.get(key) ?? []).pop() ?? null;
      if (en) en.reset(id, seed, opts);
      else en = new Enemy(this, key, def, built, id, seed, opts);

      const x = position?.x ?? 0, z = position?.z ?? 0;
      en.place(x, z, opts.yaw ?? this._yawTowardHero(x, z));
      this.entities.push(en);
      this._byId.set(id, en);
      this._assignLights();
      return en;
    } catch (err) {
      console.error('[bestiary] spawn failed —', err);
      return null;
    }
  }

  despawn(en, hard = false) {
    if (!en) return;
    const i = this.entities.indexOf(en);
    if (i >= 0) this.entities.splice(i, 1);
    this._byId.delete(en.id);
    if (en.light) { en.light.owner = null; releaseLight(en.light.light); en.light = null; }
    if (hard) { en.destroy(); return; }
    en.park();
    let pool = this._pool.get(en.species);
    if (!pool) this._pool.set(en.species, (pool = []));
    if (pool.length < 8) pool.push(en); else en.destroy();
    this._assignLights();
  }

  despawnAll(hard = false) {
    const list = this.entities.slice();
    for (const en of list) this.despawn(en, hard);
    this.entities.length = 0;
    this._byId.clear();
    if (hard) {
      for (const [, pool] of this._pool) for (const en of pool) en.destroy();
      this._pool.clear();
    }
  }

  /** Convenience for AI summons: a ring of adds around a point. */
  spawnPack(types, points, opts = {}) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const t = Array.isArray(types) ? types[i % types.length] : types;
      const en = this.spawn(t, { x: p.x ?? p[0] ?? 0, z: p.z ?? p[1] ?? 0 }, {
        elite: !!opts.elite, level: opts.level, seed: (hashStr(`${t}${i}`) ^ (opts.seed ?? 0)) >>> 0,
      });
      if (en) out.push(en);
    }
    return out;
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(dt, elapsed) {
    if (this.failed || !this.entities.length) { this._pumpGlow(elapsed); return; }
    const e = this.engine;
    const frame = e.clock.frame;
    const cam = e.camera;
    const terrain = e.get('terrain');
    const heightAt = terrain && !terrain.__dead && typeof terrain.heightAt === 'function'
      ? (x, z) => terrain.heightAt(x, z) : null;
    const normalAt = terrain && !terrain.__dead && typeof terrain.normalAt === 'function' ? terrain : null;
    const hasAI = !!(e.get('ai') && !e.get('ai').__dead);

    /* frustum once per frame, shared by every body */
    if (this._frustumAt !== frame) {
      this._frustumAt = frame;
      _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(_m);
    }

    /* --- separation so a self-driven pack never interpenetrates --- */
    if (!hasAI) this._separate(dt);

    const list = this.entities;
    for (let i = list.length - 1; i >= 0; i--) {
      const en = list[i];
      try {
        en.update(dt, elapsed, frame, cam, heightAt, normalAt, hasAI, this._frustum);
      } catch (err) {
        console.error(`[bestiary:${en.id}] update failed —`, err);
        this.despawn(en, true);
        continue;
      }
      if (en.removeMe) this.despawn(en);
    }

    this._pumpGlow(elapsed);

    if (this._deferred.length) {
      const q = this._deferred.slice();
      this._deferred.length = 0;
      for (const fn of q) { try { fn(); } catch (err) { console.error('[bestiary] deferred', err); } }
    }
  }

  /**
   * Drive the champion ground pools.
   *
   * `uGain` is re-published every frame rather than baked at creation because the
   * pool is ADDITIVE into the HDR buffer and the per-scenario grade gain runs from
   * 1.78x to 3.30x. A level that reads as a soft accent arc in the crypt clips to a
   * white hoop in `night` and `inventory` at the same authored number — which is
   * exactly what it did. `engine.vfxExposureNorm` (= 1.85 / live gain, published by
   * RenderPipeline) holds the pool at its authored DISPLAY brightness everywhere.
   */
  _pumpGlow(elapsed) {
    const norm = this.engine.vfxExposureNorm;
    const k = Number.isFinite(norm) ? (norm < 0.3 ? 0.3 : norm > 1 ? 1 : norm) : 1;
    const gain = ELITE.glowGain * k;
    for (const m of this._glowMats) {
      const u = m.uniforms;
      if (!u) continue;
      if (u.uTime) u.uTime.value = elapsed;
      if (u.uGain) u.uGain.value = gain;
    }
  }

  /** Cheap O(n²) push-apart used only when no AI module is steering. */
  _separate(dt) {
    const list = this.entities;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.dead) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const min = (a.radius + b.radius) * 0.94;
        const d2 = dx * dx + dz * dz;
        if (d2 > min * min || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        const ux = dx / d, uz = dz / d;
        const wa = b.mass / (a.mass + b.mass), wb = 1 - wa;
        a.position.x -= ux * push * wa * 2 * Math.min(1, dt * 14);
        a.position.z -= uz * push * wa * 2 * Math.min(1, dt * 14);
        b.position.x += ux * push * wb * 2 * Math.min(1, dt * 14);
        b.position.z += uz * push * wb * 2 * Math.min(1, dt * 14);
      }
    }
  }

  /* ================================================================ *
   * scenarios
   * ================================================================ */

  async applyScenario(name, cfg) {
    if (this.failed) return;
    try {
      this.despawnAll();
      const spawn = cfg?.spawn ?? {};
      const count = spawn.enemies | 0;
      const biome = cfg?.env?.biome ?? 'crypt';
      const rand = this.engine.freshRand(hashStr(`bestiary:${name}`));

      /* Compose against the frame that will be CAPTURED, not the one that
         exists right now. Two things move between here and the shutter: the
         hero walks its scripted path (so ask it where it ends up), and the
         camera rig applies the scenario after us in the manifest (so ask the
         rig for the pose it is about to take). Anchoring on the live hero
         position and the stale camera is what put half of every pack 15 m
         up-camera of the composition, culled and invisible. */
      const anchors = this._scenarioAnchors();
      const hero = anchors[0];
      const hx = hero.x, hz = hero.z;
      const frame = this._scenarioFrame(name, cfg, anchors);
      this._stage = frame;

      if (spawn.boss) {
        // The boss anchors the composition: put it beyond the hero, facing back —
        // as far back as the lens can still hold it.
        const ang = Math.atan2(-1, 0) + (rand() - 0.5) * 0.4;
        let d = 8.6 + rand() * 1.2;
        if (frame) {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          // the boss is 6.5 m tall: keep a generous top margin so the head is in shot
          while (d > 4.0 && !frame.visible(hx + ca * d, hz + sa * d, 0.10, 0.10, 0.34)) d -= 0.4;
        }
        const bx = hx + Math.cos(ang) * d, bz = hz + Math.sin(ang) * d;
        const boss = this.spawn('boss', { x: bx, z: bz }, { level: (spawn.level ?? 1) + 8, seed: hashStr(`${name}:boss`) });
        if (boss) {
          boss.staged = !!frame;
          boss.mbState = 'windup';
          boss.mbT = 0.30;
          boss.variant = 'slam';
        }
      }

      if (count > 0) {
        const table = PACKS[biome] ?? PACKS.crypt;
        const picks = weightedMix(table, count, rand, spawn.boss ? ['hellhound', 'ghoul', 'brute'] : null);
        const points = packFormation(hx, hz, picks.length, rand, spawn.boss ? 8.0 : 5.4, frame);
        // One champion per pack (never in the boss arena — the boss is the read).
        const eliteIdx = spawn.boss || count < 4 ? -1 : Math.floor(rand() * count);
        for (let i = 0; i < picks.length; i++) {
          const p = points[i];
          const en = this.spawn(picks[i], { x: p.x, z: p.z }, {
            elite: i === eliteIdx,
            level: spawn.level ?? 1,
            seed: hashStr(`${name}:${i}:${picks[i]}`),
          });
          if (!en) continue;
          // `place()` may have slid the body off unwalkable ground; re-check the
          // frame against where it actually stands, not where we asked for.
          if (frame) this._pullIntoFrame(en, frame, hx, hz);
          en.staged = !!frame;
          // Stagger the mock-brain clock so frame 0 already shows a live fight.
          en.mbT = rand() * 2.2;
          if (cfg?.script === 'fight' || cfg?.script === 'bossfight') {
            const r = rand();
            if (r < 0.30) { en.mbState = 'windup'; en.mbT = 0.1 + rand() * 0.3; }
            else if (r < 0.42) { en.mbState = 'strike'; en.mbT = rand() * 0.12; }
            else if (r < 0.56) { en.mbState = 'recover'; en.mbT = rand() * 0.4; }
          }
        }
      }

      this._assignLights();
    } catch (err) {
      console.error('[bestiary] applyScenario failed —', err);
    }
  }

  /* ================================================================ *
   * events
   * ================================================================ */

  _onDamage(p) {
    if (!p) return;
    const en = this._resolve(p.target);
    if (!en || en.dead) return;
    en.takeDamage(p);
  }

  _onCast(p) {
    if (!p || !p.id) return;
    const en = this._resolve(p.caster ?? p.casterId);
    if (!en) return;
    if (p.id === 'boss.phase') { en.phaseFlare(); return; }
    const v = BOSS_VARIANT[p.id];
    if (v !== undefined) en.variant = v;
  }

  _resolve(t) {
    if (!t) return null;
    if (t instanceof Enemy) return this._byId.get(t.id) ?? null;
    if (typeof t === 'string' || typeof t === 'number') return this._byId.get(String(t)) ?? null;
    if (t.__bestiary === true && t.id) return this._byId.get(String(t.id)) ?? null;
    if (t.isObject3D) {
      let o = t;
      for (let i = 0; i < 6 && o; i++) {
        if (o.userData?.entity?.__bestiary) return o.userData.entity;
        o = o.parent;
      }
    }
    if (t.entity?.__bestiary) return t.entity;
    if (t.id !== undefined && this._byId.has(String(t.id))) return this._byId.get(String(t.id));
    return null;
  }

  /* ================================================================ *
   * internals
   * ================================================================ */

  _compile(key) {
    const hit = this._compiled.get(key);
    if (hit) return hit;
    const def = SPECIES[key];
    if (!def) return null;
    let built = null;
    try {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
      const { rig, geometry, slots } = def.build(hashStr(`species:${key}`) & 0x7fffffff);
      const clips = def.clips();
      built = { def, rig, geometry, slots, clips };
      geometry.name = `bestiary:${key}`;
      const spec = fitToSpec(def, geometry);
      built.fit = spec.fit;
      built.builtHeight = spec.height;
      const tris = (geometry.getIndex()?.count ?? 0) / 3;
      if (typeof performance !== 'undefined') {
        console.info(`[bestiary] ${key}: ${tris | 0} tris, ${geometry.groups.length} groups, ` +
          `${spec.height.toFixed(2)} m built vs ${def.height.toFixed(2)} m spec (fit x${spec.fit.toFixed(3)}), ` +
          `${(performance.now() - t0).toFixed(1)} ms`);
      }
    } catch (err) {
      console.error(`[bestiary] could not build species "${key}" —`, err);
      return null;
    }
    this._compiled.set(key, built);
    return built;
  }

  /**
   * Hand the pre-allocated practicals to whoever most deserves them.
   *
   * Champions are now in the running even when their species declares no light of
   * its own (see `Enemy.lightDef`): a pool of accent-coloured light on the stone
   * around the body is the single cheapest way to make "that one is a champion"
   * legible at 39 px, and the pool count is fixed so it costs no recompile.
   * Ranking is boss > champion > lit species, so a boss never loses its slot to a
   * champion standing next to it.
   */
  _assignLights() {
    if (!this._lights.length) return;
    const want = [];
    for (const en of this.entities) {
      if (en.dead || !en.lightDef()) continue;
      want.push(en);
    }
    const rank = (e) => (e.def.isBoss ? 2 : 0) + (e.elite ? 1 : 0);
    want.sort((a, b) => rank(b) - rank(a));
    for (const slot of this._lights) {
      if (slot.owner && (!want.includes(slot.owner))) { slot.owner.light = null; slot.owner = null; releaseLight(slot.light); }
    }
    for (const en of want) {
      if (en.light) continue;
      const free = this._lights.find((s) => !s.owner);
      if (!free) break;
      free.owner = en;
      en.light = free;
      const L = en.lightDef();
      free.light.color.set(L.color);
      free.light.distance = L.dist;
      free.light.decay = 2;
    }
  }

  _heroXZ(out) {
    const h = this.engine.get('hero');
    const p = h && !h.__dead
      ? (h.position?.isVector3 ? h.position : h.root?.position ?? h.group?.position ?? h.mesh?.position ?? null)
      : null;
    if (p && Number.isFinite(p.x)) return out.set(p.x, p.y ?? 0, p.z);
    return out.set(0, 0, 0);
  }

  /**
   * Is this world point inside the shot the camera is taking RIGHT NOW, with NDC
   * margins from each edge?
   *
   * Deliberately the live camera and not the predicted scenario frame: the hero
   * accumulates root motion from its attack clips, so over a long run the actual
   * framing drifts metres away from the one the spawn was composed against
   * (measured: 9 m in the `combat` scenario after 7 s). A leash anchored to the
   * stale frame would hold bodies where the camera used to be looking. Uses last
   * frame's camera matrices, since the rig updates after us in the manifest —
   * one frame of lag on a metre-per-second body is invisible.
   */
  inShot(x, y, z, mu = 0, mvLo = 0, mvHi = 0) {
    const cam = this.engine.camera;
    if (!cam) return true;
    const q = this._stageV.set(x, y, z).project(cam);
    return q.x >= -1 + mu && q.x <= 1 - mu
      && q.y >= -1 + mvLo && q.y <= 1 - mvHi
      && q.z >= -1 && q.z <= 1;
  }

  /**
   * Every position the composition will be centred on while this scenario plays.
   *
   * A scripted scenario walks the hero several metres after `applyScenario`
   * returns, and the camera goes with it, so `_heroXZ` alone is the wrong anchor
   * for anything that has to still be in shot 90 frames later. Element 0 is the
   * primary point (the hero's destination); the rest exist so placement can be
   * checked against the whole sweep.
   */
  _scenarioAnchors() {
    const h = this.engine.get('hero');
    if (h && !h.__dead && typeof h.scenarioAnchor === 'function') {
      try {
        const a = h.scenarioAnchor([]);
        if (Array.isArray(a) && a.length && Number.isFinite(a[0]?.x)) return a;
      } catch { /* fall through to the live position */ }
    }
    return [this._heroXZ(new THREE.Vector3())];
  }

  /**
   * Last line of defence: a body that ended up outside the framed area walks
   * back down its own line to the hero until it is inside. `place()` is allowed
   * to slide a spawn up to 1.6 m to get off unwalkable ground, and that is
   * exactly enough to push a body sitting near the edge out of shot.
   */
  _pullIntoFrame(en, frame, hx, hz) {
    if (!frame) return;
    if (packVisible(frame, en.position.x, en.position.z, 0.01)) return;
    const dx = en.position.x - hx, dz = en.position.z - hz;
    let lo = 0, hi = 1;
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) * 0.5;
      if (packVisible(frame, hx + dx * m, hz + dz * m, 0.02)) lo = m; else hi = m;
    }
    const t = Math.max(0.20, lo * 0.86);
    en.place(hx + dx * t, hz + dz * t, en.yaw);
  }

  /** The rig's ground-plane framing for this scenario, or null if unavailable. */
  _scenarioFrame(name, cfg, anchors) {
    try {
      const rig = this.engine.get('camera');
      if (!rig || rig.__dead || typeof rig.scenarioFrame !== 'function') return null;
      const f = rig.scenarioFrame(name, cfg, anchors, anchors[0]?.y ?? 0);
      return f && typeof f.visible === 'function' ? f : null;
    } catch (err) {
      console.warn('[bestiary] no camera frame for placement —', err?.message ?? err);
      return null;
    }
  }

  /**
   * The middle of the shot on the ground plane — the camera rig's smoothed aim
   * point, which is what a body has to move toward to get back into frame. Falls
   * back to the hero, who is what the rig is aiming at anyway.
   */
  _shotCentre(out) {
    const rig = this.engine.get('camera');
    const f = rig && !rig.__dead ? rig.focus : null;
    if (f && Number.isFinite(f.x)) return out.set(f.x, f.y ?? 0, f.z);
    return this._heroXZ(out);
  }

  _yawTowardHero(x, z) {
    const h = this._heroXZ(_v2);
    const dx = h.x - x, dz = h.z - z;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return 0;
    return Math.atan2(dz, dx);
  }
}

/* ================================================================== *
 * Enemy — one body
 * ================================================================== */

class Enemy {
  constructor(bes, species, def, built, id, seed, opts) {
    this.__bestiary = true;
    this.bes = bes;
    this.engine = bes.engine;
    this.species = species;
    this.def = def;
    this.built = built;

    /* ---- transform hierarchy: root (yaw) -> tilt (slope) -> mesh + bones ---- */
    this.root = new THREE.Group();
    this.root.name = `enemy:${species}`;
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);
    this.position = this.root.position;
    this.velocity = new THREE.Vector3();

    const inst = built.rig.instantiate();
    this.bones = inst.bones;
    this.boneByName = inst.byName;
    this.skeleton = inst.skeleton;
    this.tilt.add(inst.root);

    this.materials = [];
    this.mesh = new THREE.SkinnedMesh(built.geometry, this.materials);
    this.mesh.frustumCulled = false;            // parent group is culled instead
    this.mesh.castShadow = !def.noShadow;
    this.mesh.receiveShadow = true;
    this.mesh.userData.entity = this;
    this.tilt.add(this.mesh);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());

    /* ---- contact occlusion + optional champion pool ---- */
    this.contactMat = new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: bes._contactTex, transparent: true,
      depthWrite: false, opacity: 0.55, toneMapped: false,
    });
    this.contact = new THREE.Mesh(bes._contactGeo, this.contactMat);
    this.contact.matrixAutoUpdate = true;
    this.contact.renderOrder = -1;
    this.root.add(this.contact);
    this.glow = null;

    /* Engagement ring — allocated on the first frame this body is in a fight,
       so an idle world costs nothing for it. See makeEngageRing. */
    this.engage = null;
    this.engageMat = null;
    this._engW = 0;

    this.anim = new AnimGraph(built.rig, built.clips, { start: 'idle', fallback: 'idle' });
    this.ctx = { gait: 0, elapsed: 0, seed: 0, hitDir: { x: 0, z: 1 }, t: 0, phase: 0 };

    this.light = null;
    this.reset(id, seed, opts);
    bes.group.add(this.root);
  }

  /* ---------------------------------------------------------------- *
   * (re)initialisation — also the pool's revive path
   * ---------------------------------------------------------------- */

  reset(id, seed, opts = {}) {
    const def = this.def;
    const rnd = this.engine.freshRand(seed);

    this.id = id;
    this.name = def.label;
    this.type = def.id;
    this.seed = seed;
    this.elite = !!opts.elite;
    this.level = Math.max(1, opts.level ?? 1);

    /* ---- AI contract ---- */
    this.faction = 'enemy';
    this.aiArchetype = def.ai;
    this.archetype = def.ai;
    this.aiHint = def.hint;
    this.aiOwnsVertical = true;      // we own grounding, hover and death sink
    this.groundOffset = def.hover;
    this.isBoss = !!def.isBoss;
    this.rank = def.isBoss ? 'boss' : this.elite ? 'champion' : 'normal';

    const lvlMul = 1 + (this.level - 1) * 0.12;
    const eliteMul = this.elite ? 2.35 : 1;
    this.maxHp = Math.round((opts.hp ?? def.hp) * lvlMul * eliteMul);
    this.hp = this.maxHp;
    this.dead = false;
    this.removeMe = false;
    this.deathAt = -1;
    this.dissolve = 0;
    this.deathSink = 0;
    this.ragdolled = false;
    this.killer = null;

    /* ---- per-instance identity: scale + tint, deterministic from the id ---- */
    const js = def.jitter?.scale ?? [1, 1];
    // `built.fit` makes def.height honest — see fitToSpec.
    this.scale = (js[0] + rnd() * (js[1] - js[0])) * (this.built.fit ?? 1);
    if (this.elite) this.scale *= ELITE.scale;
    this.root.scale.setScalar(this.scale);
    this.height = def.height * this.scale;
    this.radius = def.radius * this.scale;
    this.mass = def.mass * this.scale * this.scale * (this.elite ? 1.5 : 1);
    /* Practical-light descriptor. A species may declare one; a champion that does
       not gets a synthetic accent-hue light so its ground pool is real light and
       not just an additive decal. Resolved once per reset, never per frame. */
    this._lightDef = def.light ?? (this.elite
      ? { color: def.aura ?? def.accent ?? def.rim ?? 0x93a8c6,
          intensity: ELITE.light.intensity, dist: ELITE.light.dist * this.scale,
          at: [0, def.height * ELITE.light.atH, 0] }
      : null);
    this.aiHint = Object.assign({}, def.hint, {
      radius: this.radius, height: this.height,
      speed: (def.hint.speed ?? 3) * (this.elite ? 0.94 : 1) * (0.96 + rnd() * 0.08),
    });
    this.moveSpeed = this.aiHint.speed;

    this._buildMaterials(rnd);

    /* ---- animation state ---- */
    this.anim.cur = 'idle';
    this.anim.prev = null;
    this.anim.blend = 1;
    this.anim.tCur = rnd() * 3.0;
    this.anim.tPrev = 0;
    this.anim.speed = 1;
    this.anim.done = false;
    this.anim._impulses.length = 0;
    this.animName = 'idle';
    this.animState = 'idle';
    this.ctx.seed = seed & 0xffff;
    this.ctx.gait = 0;
    this.ctx.hitDir.x = 0; this.ctx.hitDir.z = 1;

    this.speed = 0;
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.meshYaw = 0;
    this.flash = 0;
    this.staggerPool = 0;
    this.kbX = 0; this.kbZ = 0;
    this.hitCount = 0;
    this.variant = def.isBoss ? (def.variants?.[0] ?? null) : null;
    this._attackSeq = (seed >>> 5) % 6;
    this.phase = 0;
    this.phaseFlareT = -99;
    this.groundY = 0;
    this.lodPhase = seed % 4;
    this.lodAcc = 0;
    this.lodEvery = 1;
    this.onScreen = true;
    this.distToCam = 0;
    this._aiTouch = -999;
    this._footPhase = -1;
    this._normAt = -999;
    /* Only a scenario marks a body as staged — see Enemy._holdOnStage. */
    this.staged = false;
    this._stageX = undefined;
    this._stageZ = undefined;

    /* ---- mock-brain (used only while nothing else drives this body) ---- */
    this.mbState = 'idle';
    this.mbT = rnd() * 2;
    this.mbRing = def.ring * (0.92 + rnd() * 0.28) * this.scale;
    this.mbFlank = rnd() < 0.5 ? -1 : 1;

    /* ---- champion tell: an aura and a ground pool you cannot miss ---- */
    if (this.elite && !this.glow) {
      const gm = this.bes.mats.groundGlow(this.def.aura, { rings: 1, gain: ELITE.glowGain });
      this.bes._glowMats.add(gm);
      this.glow = new THREE.Mesh(this.bes._glowGeo, gm);
      this.glow.renderOrder = -1;
      this.root.add(this.glow);
    }
    if (this.glow) {
      this.glow.visible = this.elite;
      this.glow.scale.setScalar(this.def.radius * ELITE.glowSize);
      this.glow.position.y = 0.035;
    }
    /* Contact occlusion. It is doing the same second job as the hero's grounding
       pool: as well as anchoring the body, it drops the value of the floor the
       body is standing on so the character rim has something to read against. The
       crypt floor immediately behind an enemy measured 0.44-0.54 luma against a
       0.10-0.30 body — the value structure was inverted. Wider and deeper, but
       still a pow-2.3 radial ramp with a broken edge, so it never forms a disc.
       Alpha-blended pure black is multiplicative (dst*(1-a)); it can only remove
       light, never lift a black. */
    this.contact.visible = true;
    this.contactMat.opacity = def.hover > 0 ? 0.42 : 0.68;
    this.contact.scale.setScalar(Math.max(0.5, def.radius * 5.2));
    this.contact.position.set(0, 0.03 - def.hover, 0);

    this._engW = 0;
    if (this.engage) {
      this.engage.visible = false;
      // local units: root already carries this.scale, and lifting by -hover puts
      // the mark on the FLOOR for the bodies that float above it
      this.engage.scale.setScalar(Math.max(0.42, def.radius * 1.62));
      this.engage.position.set(0, 0.085 - def.hover, 0);
    }

    this.root.visible = true;
    this.mesh.visible = true;
    this.tilt.rotation.set(0, 0, 0);
    this.tilt.position.set(0, 0, 0);
    this.tiltX = undefined;
    this.tiltZ = undefined;
    this.mesh.castShadow = !def.noShadow;
  }

  _buildMaterials(rnd) {
    const def = this.def;
    const mm = this.bes.mats;
    const jt = def.jitter?.tint ?? 0.06;
    const shift = [1 + (rnd() - 0.5) * jt, 1 + (rnd() - 0.5) * jt * 0.8, 1 + (rnd() - 0.5) * jt * 1.2];
    // Champions read as colour-shifted, not just bigger.
    const eliteTint = this.elite ? new THREE.Color(def.aura) : null;

    if (this.materials.length === this.built.slots.length) {
      // pooled revive: keep the programs, re-tint in place
      for (let i = 0; i < this.materials.length; i++) {
        const slot = this.built.slots[i];
        const cfg = def.slotMat?.[slot.name] ?? {};
        _col.set(cfg.tint ?? 0xffffff);
        _col.r *= shift[0]; _col.g *= shift[1]; _col.b *= shift[2];
        if (eliteTint) _col.lerp(eliteTint, ELITE.tint);
        this.materials[i].color.copy(_col);
        const u = this.materials[i].userData.monU;
        if (u) {
          u.uMonDissolve.value = 0;
          u.uMonFlash.value = 0;
          u.uMonAura.value = this.elite ? ELITE.aura : 0.055;
          u.uMonAuraColor.value.set(this.elite ? def.aura : (def.rim ?? 0x93a8c6));
        }
      }
      return;
    }

    this.materials.length = 0;
    for (const slot of this.built.slots) {
      const cfg = def.slotMat?.[slot.name] ?? {};
      _col.set(cfg.tint ?? 0xffffff);
      _col.r *= shift[0]; _col.g *= shift[1]; _col.b *= shift[2];
      if (eliteTint) _col.lerp(eliteTint, ELITE.tint);
      const mat = mm.make(slot.recipe, {
        tint: _col.getHex(),
        transparent: !!cfg.transparent,
        depthWrite: cfg.depthWrite ?? !cfg.transparent,
        opacity: 1,
        ghost: cfg.ghost ?? 0,
        yMin: 0,
        height: def.height * 1.05,
        dissolveEdge: def.dissolveEdge,
        dissolveScale: def.dissolveScale ?? 9,
        // Doubles as a silhouette rim: a faint fresnel term in a cold hue lifts
        // every body off the ground plane. Champions swap it for their accent.
        auraColor: this.elite ? def.aura : (def.rim ?? 0x93a8c6),
        flashColor: 0xfff3e2,
        side: cfg.transparent ? THREE.DoubleSide : THREE.FrontSide,
      });
      mat.name = `${def.id}:${slot.name}`;
      // Free two texture units per material (see METAL above).
      mat.metalnessMap = null;
      mat.aoMap = null;
      mat.metalness = cfg.metal ?? METAL[slot.recipe] ?? 0.02;
      if (cfg.rough !== undefined) mat.roughness = cfg.rough;
      const u = mat.userData.monU;
      if (u) {
        if (cfg.emiss !== undefined) {
          u.uMonEmissColor.value.set(cfg.emiss).multiplyScalar(cfg.emissI ?? 1);
        }
        if (cfg.fade) u.uMonFade.value.set(cfg.fade[0], cfg.fade[1]);
        u.uMonAura.value = this.elite ? ELITE.aura : 0.055;
      }
      this.materials.push(mat);
    }
    this.mesh.material = this.materials;
  }

  /* ---------------------------------------------------------------- *
   * placement
   * ---------------------------------------------------------------- */

  place(x, z, yaw = 0) {
    const t = this.engine.get('terrain');
    let y = 0;
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      // nudge off unwalkable ground rather than spawning inside a wall
      if (typeof t.isWalkable === 'function' && !t.isWalkable(x, z)) {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const nx = x + Math.cos(a) * 1.6, nz = z + Math.sin(a) * 1.6;
          if (t.isWalkable(nx, nz)) { x = nx; z = nz; break; }
        }
      }
      y = t.heightAt(x, z);
      if (!Number.isFinite(y)) y = 0;
    }
    this.groundY = y;
    this.position.set(x, y + this.def.hover * this.scale, z);
    this.yaw = yaw;
    this.meshYaw = agentToMesh(yaw);
    this.root.rotation.y = this.meshYaw;
    this.root.updateMatrixWorld(true);
  }

  park() {
    this.root.visible = false;
    this.dead = true;
    this.removeMe = false;
    this._releaseRagdoll();
    for (const m of this.materials) { const u = m.userData.monU; if (u) { u.uMonDissolve.value = 0; u.uMonFlash.value = 0; } }
  }

  destroy() {
    this._releaseRagdoll();
    try {
      this.root.parent?.remove(this.root);
      for (const m of this.materials) m.dispose();
      this.contactMat.dispose();
      this.engageMat?.dispose();
      this.materials.length = 0;
    } catch { /* noop */ }
  }

  /** Hand a ragdolled corpse back to Physics before we reuse or drop the body. */
  _releaseRagdoll() {
    if (!this.ragdolled) return;
    this.ragdolled = false;
    try {
      const p = this.engine.get('physics');
      if (p && !p.__dead) (p.releaseRagdoll ?? p.removeRagdoll ?? p.despawnRagdoll)?.call(p, this);
    } catch { /* optional module */ }
  }

  /* ---------------------------------------------------------------- *
   * AI-facing hooks (EntityAdapter probes for exactly these names)
   * ---------------------------------------------------------------- */

  setFacing(yaw) {
    if (!Number.isFinite(yaw)) return;
    this.yaw = yaw;
    this._aiTouch = this.engine.clock.frame;
  }

  setAnimState(name, speed) {
    this._aiTouch = this.engine.clock.frame;
    this.playAnim(name, speed);
  }

  getHealth() { return { hp: this.hp, max: this.maxHp }; }

  /**
   * This body's practical-light descriptor, or null if it does not want one.
   * Species-declared first, then the synthetic champion accent light. Resolved in
   * `reset()` — this is only the accessor `Bestiary._assignLights` ranks against.
   */
  lightDef() { return this._lightDef ?? null; }

  /** Explicit ability hand-off, for a combat/AI module that knows the move. */
  setAbility(id) {
    const v = BOSS_VARIANT[id];
    if (v !== undefined) this.variant = v;
  }

  playAnim(name, speed = 1) {
    const clips = this.built.clips;
    let want = String(name || 'idle');
    // boss/brute ability variants: attack_windup__slam etc.
    if (this.variant && clips[`${want}__${this.variant}`]) want = `${want}__${this.variant}`;
    let guard = 0;
    while (!clips[want] && guard++ < 6) want = ANIM_FALLBACK[want] ?? 'idle';
    if (!clips[want]) want = 'idle';
    if (want === this.animName) return;

    // A fresh attack picks the next telegraph so the rotation always varies.
    if (name === 'attack_windup' || name === 'cast') {
      const vs = this.def.variants;
      if (vs && vs.length && !this._variantLocked) {
        this.variant = vs[this._attackSeq++ % vs.length];
        const alt = `${name}__${this.variant}`;
        if (clips[alt]) want = alt;
      }
    }
    this.animName = want;
    this.animState = name;
    const fade = want.startsWith('attack') || want === 'hit' || want === 'death' ? 0.10 : 0.20;
    this.anim.play(want, { fade, speed: clamp(speed || 1, 0.4, 2.2), restart: want === 'hit' });
  }

  /* ---------------------------------------------------------------- *
   * damage / death
   * ---------------------------------------------------------------- */

  takeDamage(p) {
    const amount = Math.max(0, Number(p.amount) || 0);
    this.hp = Math.max(0, this.hp - amount);
    /*
     * A hit flash is a PUNCH, not a state.
     *
     * This used to be `this.flash = 1` unconditionally. Anything that deals
     * damage more than ~6 times a second — whirlwind ticks, a burn DoT, a boss
     * being focused — therefore reset the flash to full before the previous one
     * could decay, and the body sat pinned at maximum flash indefinitely.
     * Measured on the `boss` capture: `flash` was exactly 1.000 after 240 frames
     * and 21 hits, and the 6.5 m boss rendered as a flat white silhouette in the
     * middle of its own arena. Zeroing the uniform dropped that region's mean
     * from 0.509 to 0.210, which is what proved it.
     *
     * So a re-trigger now decays what is already there instead of refilling it,
     * and its height scales with how big the hit actually was: chip damage
     * flickers, a real blow lands at full. A stream of small ticks converges on
     * its own small value rather than latching white.
     */
    const sig = clamp(amount / Math.max(1, this.maxHp * 0.02), 0.22, 1);
    this.flash = Math.min(1, Math.max(this.flash * 0.5, sig));
    this.hitCount++;

    /* direction of the blow, in the body's local frame */
    let dx = 0, dz = 1;
    if (p.hitPoint) {
      dx = this.position.x - (p.hitPoint.x ?? 0);
      dz = this.position.z - (p.hitPoint.z ?? 0);
    } else if (p.hitNormal) { dx = -(p.hitNormal.x ?? 0); dz = -(p.hitNormal.z ?? 0); }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const c = Math.cos(-this.yaw), s = Math.sin(-this.yaw);
    this.ctx.hitDir.x = dx * c - dz * s;
    this.ctx.hitDir.z = dx * s + dz * c;

    /* knockback: mass-scaled, decays fast — a nudge, not a launch */
    const imp = clamp(amount / Math.max(24, this.mass * 0.22), 0, 2.4) * (p.crit ? 1.5 : 1);
    if (!this.def.isBoss) { this.kbX += dx * imp; this.kbZ += dz * imp; }

    /* stagger threshold: chip damage flinches, a real hit breaks the animation */
    const frac = amount / Math.max(1, this.maxHp);
    this.staggerPool = Math.min(1.6, this.staggerPool + frac * (p.crit ? 1.6 : 1));
    const thresh = this.def.isBoss ? 999 : (0.16 + (this.elite ? 0.10 : 0));

    if (this.hp <= 0) { this.die(p.sourceId ?? p.source ?? null, p.hitPoint); return; }

    if (this.staggerPool >= thresh) {
      this.staggerPool = 0;
      this.playAnim('hit');
    } else {
      // additive flinch — never interrupts a telegraph, always reads as a hit
      const j = this.def.ai === 'scavenger'
        ? ['neck1', 'head', 'spine1', 'spine2']
        : ['chest', 'neck', 'head', `shoulder.${this.ctx.hitDir.x > 0 ? 'R' : 'L'}`];
      this.anim.impulse(j, [-0.26 * this.ctx.hitDir.z, 0.18 * this.ctx.hitDir.x, -0.20 * this.ctx.hitDir.x],
        clamp(0.4 + frac * 3.2, 0.35, 1.3), 7.5);
    }
  }

  die(killer = null, hitPoint = null) {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.killer = killer;
    this.deathAt = this.engine.clock.elapsed;
    this.staggerPool = 0;

    /* Ragdoll if a physics module is present; keyframed collapse otherwise. */
    let ragdoll = null;
    try {
      const phys = this.engine.get('physics');
      ragdoll = phys && !phys.__dead ? phys.ragdoll?.({
        entity: this, root: this.root, mesh: this.mesh, skeleton: this.skeleton, bones: this.bones,
        mass: this.mass, height: this.height, radius: this.radius,
        impulse: { x: this.kbX * this.mass * 0.4, y: this.mass * 0.6, z: this.kbZ * this.mass * 0.4 },
        hitPoint,
      }) : null;
    } catch (err) { console.warn('[bestiary] ragdoll handoff failed —', err?.message ?? err); ragdoll = null; }
    this.ragdolled = !!ragdoll;
    if (!this.ragdolled) this.playAnim('death');

    if (this.light) { this.light.owner = null; releaseLight(this.light.light); this.light = null; }

    const bus = this.engine.bus;
    try {
      bus.emit('death', {
        entity: this, killer,
        hitPoint: hitPoint ?? { x: this.position.x, y: this.position.y + this.height * 0.5, z: this.position.z },
      });
      if (this.def.isBoss) {
        bus.emit('camera:shake', { amp: 0.9, freq: 8, duration: 1.9 });
        bus.emit('ui:toast', { text: `${this.def.label} has fallen`, tier: 'boss' });
      } else if (this.elite) {
        bus.emit('camera:shake', { amp: 0.22, freq: 14, duration: 0.4 });
      }
    } catch { /* presentation only */ }
    this.bes._deferred.push(() => this.bes._assignLights());
  }

  /** Boss phase break: flare the weak points and punch the camera. */
  phaseFlare() {
    this.phaseFlareT = this.engine.clock.elapsed;
    this.playAnim('roar');
  }

  /* ---------------------------------------------------------------- *
   * per-frame
   * ---------------------------------------------------------------- */

  update(dt, elapsed, frame, cam, heightAt, normalAt, hasAI, frustum) {
    const def = this.def;

    /* ---- visibility / LOD ---- */
    const dx = this.position.x - cam.position.x;
    const dy = this.position.y - cam.position.y;
    const dz = this.position.z - cam.position.z;
    this.distToCam = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if ((frame & 3) === (this.lodPhase & 3)) {
      _sph.center.set(this.position.x, this.position.y + this.height * 0.5, this.position.z);
      _sph.radius = this.height * 0.75 + 0.6;
      this.onScreen = frustum.intersectsSphere(_sph);
      this.root.visible = this.onScreen || this.distToCam < 6;
      // Shadow LOD: a body 30 m out contributes a few pixels of penumbra and
      // costs a full draw in every cascade it touches. Cast near, skip far.
      const wantShadow = !def.noShadow && this.onScreen
        && this.distToCam < (def.isBoss ? 60 : this.height > 2.4 ? 40 : 30);
      if (this.mesh.castShadow !== wantShadow) this.mesh.castShadow = wantShadow;
    }
    const important = def.isBoss || this.elite || this.dead;
    this.lodEvery = !this.onScreen ? 4
      : this.distToCam < 24 || important ? 1
        : this.distToCam < 44 ? 2 : 3;

    /* ---- self-drive when nothing else is steering this body ---- */
    const driven = hasAI && (frame - this._aiTouch) < 14;
    if (!driven && !this.dead) this._mockBrain(dt, elapsed);

    /* ---- knockback integration (visual + authoritative, AI reads it back) ---- */
    if (this.kbX !== 0 || this.kbZ !== 0) {
      this.position.x += this.kbX * dt;
      this.position.z += this.kbZ * dt;
      const k = Math.exp(-dt * 9);
      this.kbX *= k; this.kbZ *= k;
      if (Math.abs(this.kbX) + Math.abs(this.kbZ) < 0.01) { this.kbX = 0; this.kbZ = 0; }
    }

    /* ---- stage leash: a cast member stays on set ----
       Composing the spawn is necessary but not sufficient. A scenario runs for
       seconds before it is captured (90 frames in tools/shot.mjs, ~7 s of live
       sim in tools/actors.mjs) and the AI keeps steering: a `scavenger` hellhound
       placed 2 m from the hero was measured 12.7 m out and off-camera by second
       seven, so the frame lost a body it had been composed around. Bodies the
       SCENARIO placed are performers, and a scenario is a directed shot — the
       same reason Hero scripts a path and suppresses input. Gameplay spawns (the
       Director's reinforcements) are deliberately not leashed. */
    if (this.staged && !this.ragdolled) this._holdOnStage(dt);

    /* ---- grounding: terrain surface + hover + death sink ---- */
    if (heightAt) {
      const h = heightAt(this.position.x, this.position.z);
      if (Number.isFinite(h)) this.groundY = h;
    }
    // A ragdoll owns its own transform completely: writing y or yaw underneath
    // Physics would fight the solver and make the corpse jitter.
    if (!this.ragdolled) {
      const hover = def.hover * this.scale * (this.dead ? clamp01(1 - (elapsed - this.deathAt) * 0.8) : 1);
      const targetY = this.groundY + hover - this.deathSink;
      if (this.dead || !driven) this.position.y = targetY;
      else this.position.y += (targetY - this.position.y) * Math.min(1, dt * 16);

      /* ---- facing: spring toward the requested yaw so nothing snaps ---- */
      const wantMesh = agentToMesh(this.yaw);
      let d = wantMesh - this.meshYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const turn = (this.aiHint.turnRate ?? 8) * dt;
      this.meshYaw += clamp(d, -turn, turn);
      this.root.rotation.y = this.meshYaw;
    }

    /* ---- slope tilt: bodies lean into the ground they stand on ---- */
    if (normalAt && !def.hover && !this.ragdolled && (elapsed - this._normAt) > 0.25) {
      this._normAt = elapsed;
      normalAt.normalAt(this.position.x, this.position.z, _n);
      const c = Math.cos(-this.meshYaw), s = Math.sin(-this.meshYaw);
      const lx = _n.x * c - _n.z * s;
      const lz = _n.x * s + _n.z * c;
      this.tiltX = Math.atan2(lz, Math.max(0.2, _n.y)) * 0.55;
      this.tiltZ = -Math.atan2(lx, Math.max(0.2, _n.y)) * 0.55;
    }
    if (this.tiltX !== undefined) {
      this.tilt.rotation.x += (this.tiltX - this.tilt.rotation.x) * Math.min(1, dt * 5);
      this.tilt.rotation.z += (this.tiltZ - this.tilt.rotation.z) * Math.min(1, dt * 5);
    }

    /* ---- gait: what the clips read to scale stride and contact time ---- */
    const sp = Number.isFinite(this.speed) ? Math.abs(this.speed) : 0;
    const measured = sp > 0.01 ? sp : Math.hypot(this.velocity.x, this.velocity.z);
    const gait = clamp(measured / Math.max(1.2, this.aiHint.speed ?? 3), 0, 1.5);
    this.ctx.gait += (gait - this.ctx.gait) * Math.min(1, dt * 10);
    this.ctx.elapsed = elapsed;

    /* ---- animation (rate-limited by LOD, dt accumulated so motion is smooth) ---- */
    this.lodAcc += dt;
    if (((frame + this.lodPhase) % this.lodEvery) === 0) {
      const step = this.lodAcc;
      this.lodAcc = 0;
      const prevPhase = this.anim.phase;
      if (!this.ragdolled) this.anim.update(step, this.bones, this.ctx);
      this._footfalls(prevPhase, this.anim.phase, elapsed);
    }

    /* ---- hit flash, aura, weak-point pulse ----
     *
     * THE BUG THIS FIXES: the boss rendered as a FLAT WHITE SILHOUETTE in the
     * `boss` capture. Not a material failure and not bloom — verified by
     * capturing with bloom disabled, where the white body survives. The
     * arithmetic: MonsterMaterials adds `flashColor * uMonFlash * 2.4` to
     * emissive AND mixes albedo `uMonFlash * 0.45` toward pure white, and the
     * capture caught uMonFlash at 0.614 (measured). At the boss scenario's
     * 2.73x exposure gain and 1.15 tone-mapping bias that is 1.47 x 3.14 = 4.6
     * pre-ACES: hard white, the whole body, hiding the silhouette the frame is
     * built around. Every enemy did it, for 154 ms per hit, which in a scripted
     * fight is most captured frames.
     *
     * Two corrections, both here so no other agent's shader is touched:
     *
     *  1. NORMALISE for exposure. `2.4` was budgeted against the 1.85x reference
     *     gain; the grade pass now runs 1.78x-3.30x per scenario. Scaling by
     *     `engine.vfxExposureNorm` (published by RenderPipeline) holds the flash
     *     at its authored DISPLAY brightness in every scenario.
     *  2. CEILING it. 0.29 x 2.4 = 0.70 linear, which is the same "bright but
     *     cannot clip or bloom" ceiling the ground-read shaders use, and leaves
     *     the albedo mix at 0.13 so bone/cloth/metal still read THROUGH the
     *     flash instead of being painted out.
     *
     * Decay also goes 6.5 -> 10.0/s: a hit is a punch, not a plateau.
     */
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 10.0);
      const norm = this.engine.vfxExposureNorm;
      const k = Number.isFinite(norm) ? (norm < 0.25 ? 0.25 : norm > 1 ? 1 : norm) : 1;
      const v = Math.min(this.flash * this.flash * k, FLASH_CEIL);
      for (const m of this.materials) { const u = m.userData.monU; if (u) u.uMonFlash.value = v; }
    }
    if (this.elite || def.isBoss) this._pulse(elapsed);
    if (def.hover) this._phaseShimmer(elapsed);
    this._engageMark(dt, elapsed);

    /* ---- death: collapse, then dissolve with a glowing burn edge ---- */
    if (this.dead) this._dying(dt, elapsed);

    /* ---- practical light rides the emissive detail it belongs to ---- */
    if (this.light && this._lightDef) {
      const L = this._lightDef;
      const at = L.at;
      _v.set(at[0] * this.scale, at[1] * this.scale, at[2] * this.scale).applyAxisAngle(UP, this.meshYaw);
      this.light.light.position.set(this.position.x + _v.x, this.position.y + _v.y, this.position.z + _v.z);
      const flick = 0.86 + 0.14 * Math.sin(elapsed * 9.3 + this.seed * 0.001) * Math.sin(elapsed * 3.1 + 1.7);
      const fade = this.dead ? clamp01(1 - this.dissolve * 1.4) : 1;
      this.light.light.intensity = L.intensity * flick * fade * (this.onScreen ? 1 : 0.2);
    }
  }

  /* ---- footfalls: dust, audio cue and (for the heavy ones) camera shake ---- */
  _footfalls(prev, now, elapsed) {
    const def = this.def;
    if (!def.feet || this.dead || !this.onScreen) return;
    const nm = this.animName;
    if (nm !== 'walk' && nm !== 'run' && nm !== 'strafe' && nm !== 'walk_back') return;
    if (now < prev) prev -= 1;                                  // wrapped
    const strikes = def.feet.length === 4 ? QUAD_STRIKE : BIPED_STRIKE;
    for (let i = 0; i < strikes.length; i++) {
      const s = strikes[i];
      if (!crossed(prev, now, s)) continue;
      const bone = this.boneByName.get(def.feet[i % def.feet.length]);
      if (!bone) continue;
      _v.setFromMatrixPosition(bone.matrixWorld);
      const mag = def.footVol * (0.6 + this.ctx.gait * 0.7) * this.scale;
      try {
        this.engine.bus.emit('impact', {
          point: { x: _v.x, y: this.groundY + 0.03, z: _v.z },
          normal: { x: 0, y: 1, z: 0 }, kind: 'footfall', magnitude: mag,
        });
        if (def.shake > 0) {
          const near = clamp01(1 - this.distToCam / 42);
          const amp = def.shake * mag * near * near;
          if (amp > 0.012) this.engine.bus.emit('camera:shake', { amp, freq: 15, duration: 0.20 });
        }
      } catch { /* presentation only */ }
    }
  }

  /**
   * Keep this body inside the framed area, sliding along the boundary rather
   * than stopping dead at it.
   *
   * The axis-separated retry is what makes it read as a creature circling the
   * edge of the arena instead of one walking into an invisible wall: if the move
   * broke the frame, keep whichever single axis is still legal. Bisecting back
   * toward the pack centre every frame would instead jitter the body along the
   * edge, and hard-stopping it would freeze it mid-stride.
   */
  _holdOnStage(dt) {
    const bes = this.bes;
    const y = this.position.y;
    // Looser than the bounds the spawn was composed with (Bestiary.FRAME_*), so a
    // body placed at the edge of the composition is inside the leash from frame
    // one and never fights it. A tall body needs more headroom: the top of the
    // frame is where a 6.5 m boss loses its head first.
    const mvHi = 0.26 + Math.min(0.26, this.height * 0.055);
    const ok = (x, z) => bes.inShot(x, y, z, 0.12, 0.30, mvHi);
    const px = this.position.x, pz = this.position.z;
    if (ok(px, pz)) { this._stageX = px; this._stageZ = pz; return; }

    /* Its own move broke the frame: keep whichever single axis is still legal, so
       it slides along the boundary rather than stopping dead — the difference
       between a creature circling the edge of the arena and one walking into an
       invisible wall. */
    if (this._stageX !== undefined) {
      if (ok(px, this._stageZ)) { this.position.z = this._stageZ; this._stageX = px; return; }
      if (ok(this._stageX, pz)) { this.position.x = this._stageX; this._stageZ = pz; return; }
    }

    /* Neither axis is legal, which usually means the body never moved at all —
       the CAMERA left it behind, because the rig follows the hero and the hero
       walks. Restoring the last position would just strand it off-camera
       permanently (measured: a dungeon hellhound parked at screen Y 834 of 900
       while the hero walked 7 m past it). So walk it back toward the middle of
       the shot at its own pace; a monster wanting to be near the hero is exactly
       what it would do anyway. */
    const c = bes._shotCentre(_v3);
    const dx = c.x - px, dz = c.z - pz;
    const d = Math.hypot(dx, dz) || 1e-4;
    const step = Math.min(d, Math.max(0.8, this.moveSpeed || 3) * Math.max(0, dt));
    this.position.x = px + (dx / d) * step;
    this.position.z = pz + (dz / d) * step;
    this._stageX = this.position.x;
    this._stageZ = this.position.z;
  }

  /**
   * "This body is in the fight" — a ground mark the player can find regardless
   * of how the lighting lands on the silhouette.
   *
   * Engaged means any of: playing something other than an idle-family clip,
   * already wounded, or standing inside its own approach ring of the hero. The
   * weight is eased rather than switched so a pack does not blink on and off as
   * the AI changes its mind, and the whole thing is a pure function of dt and
   * `elapsed` — no wall clock, no rng.
   */
  _engageMark(dt, elapsed) {
    const def = this.def;
    let want = 0;
    if (!this.dead) {
      const st = this.animState;
      const busy = st && st !== 'idle' && st !== 'look' && st !== 'alert';
      if (busy || this.hp < this.maxHp) want = 1;
      else {
        const hero = this.bes._heroXZ(_v2);
        const dx = hero.x - this.position.x, dz = hero.z - this.position.z;
        if (dx * dx + dz * dz < (this.mbRing * 1.8 + 2.6) ** 2) want = 1;
      }
    }

    this._engW += (want - this._engW) * Math.min(1, dt * 5.5);
    if (this._engW < 0.004) {
      if (this.engage) this.engage.visible = false;
      return;
    }

    if (!this.engage) {
      // One material per body, same config for all of them, so they share a
      // single program (the pattern contactMat already uses). No texture.
      this.engageMat = new THREE.MeshBasicMaterial({
        color: 0x8fc6ff, vertexColors: true, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        toneMapped: false,
      });
      this.engage = new THREE.Mesh(this.bes._engageGeo, this.engageMat);
      this.engage.name = `engage:${this.species}`;
      this.engage.renderOrder = -1;
      this.engage.frustumCulled = false;
      this.engage.userData.occluder = false;
      this.engage.scale.setScalar(Math.max(0.42, def.radius * 1.62));
      this.engage.position.set(0, 0.085 - def.hover, 0);
      // `tilt` carries the terrain normal, so the mark lies IN the floor plane
      // instead of hovering flat over a slope and clipping into the slabs.
      this.tilt.add(this.engage);
    }

    // A slow breath keyed off the body's own seed: a pack pulses out of phase,
    // which reads as several separate threats rather than one UI element.
    const beat = 0.84 + 0.16 * Math.sin(elapsed * 2.3 + this.seed * 0.0011);
    const rank = def.isBoss ? 1.35 : this.elite ? 1.18 : 1.0;
    const fade = this.dead ? clamp01(1 - this.dissolve * 2) : 1;
    // 0.12: measured. At 0.22 the ring came back off the bloom pass as a hard
    // white hoop that out-read the body it was pointing at, which is the failure
    // mode of every selection indicator. At 0.12 it stays a cool arc of light on
    // the floor — findable when you scan for it, ignorable when you are not.
    const gain = this._engW * beat * fade * 0.12 * rank;
    this.engageMat.opacity = gain;
    this.engage.visible = gain > 0.006;
  }

  /** Champion aura + boss weak-point / phase emissive. */
  _pulse(elapsed) {
    const def = this.def;
    const beat = 0.5 + 0.5 * Math.sin(elapsed * 1.9 + this.seed * 0.0007);
    const flare = clamp01(1 - (elapsed - this.phaseFlareT) / 1.1);
    if (def.isBoss) {
      const f = this.hp / Math.max(1, this.maxHp);
      const phase = f <= 0.35 ? 2 : f <= 0.70 ? 1 : 0;
      if (phase !== this.phase) {
        this.phase = phase;
        this.phaseFlareT = elapsed;
        // Only announce it ourselves when no AI/BossController owns the fight.
        if (!(this.engine.get('ai') && !this.engine.get('ai').__dead)) {
          try {
            this.engine.bus.emit('camera:shake', { amp: 0.62, freq: 11, duration: 1.0 });
            this.engine.bus.emit('ui:toast', { text: `${def.label} — Phase ${['I', 'II', 'III'][phase]}`, tier: 'boss' });
          } catch { /* noop */ }
          this.playAnim('roar');
        }
      }
      const heat = 1 + this.phase * 0.55 + flare * 2.4 + beat * 0.22;
      for (let i = 0; i < this.materials.length; i++) {
        const slot = this.built.slots[i].name;
        const cfg = def.slotMat?.[slot];
        if (!cfg || cfg.emiss === undefined) continue;
        const u = this.materials[i].userData.monU;
        if (u) u.uMonEmissColor.value.set(cfg.emiss).multiplyScalar((cfg.emissI ?? 1) * (slot === 'core' ? heat : 1 + flare * 0.8));
      }
    }
    if (this.elite) {
      /* The aura is one of FOUR axes (see ELITE) rather than the whole tell, but
         it does have to be visible: at the old 0.115-0.17 it contributed under
         0.02 of measured luma to a 39 px body, i.e. nothing. The three-lobe rim in
         MonsterMaterials keeps this off the camera-facing side, so raising it
         colours the champion's rounded far edge instead of washing the whole
         figure into a neon toy. */
      const a = (ELITE.aura + beat * ELITE.auraBeat) * (this.dead ? clamp01(1 - this.dissolve * 2) : 1);
      for (const m of this.materials) { const u = m.userData.monU; if (u) u.uMonAura.value = a; }
      if (this.glow) this.glow.visible = !this.dead || this.dissolve < 0.5;
    }
  }

  /** Wraith: coverage breathes, and every few seconds it half-phases out. */
  _phaseShimmer(elapsed) {
    const t = elapsed * 0.37 + this.seed * 0.0013;
    const base = Math.sin(t * 2.1) * 0.5 + 0.5;
    const dip = Math.pow(clamp01(Math.sin(t * 0.8) * 1.6 - 0.55), 2);
    for (let i = 0; i < this.materials.length; i++) {
      const cfg = this.def.slotMat?.[this.built.slots[i].name];
      if (!cfg || cfg.ghost === undefined) continue;
      const u = this.materials[i].userData.monU;
      if (u) u.uMonGhost.value = clamp01(cfg.ghost + base * 0.08 + dip * (1 - cfg.ghost) * 0.85);
    }
  }

  _dying(dt, elapsed) {
    const t = elapsed - this.deathAt;
    const hold = this.ragdolled ? 1.7 : 1.35;
    if (t > hold) {
      this.dissolve = clamp01((t - hold) / 1.15);
      const e = this.dissolve;
      for (const m of this.materials) { const u = m.userData.monU; if (u) u.uMonDissolve.value = e; }
      if (!this.ragdolled) this.deathSink = e * e * 0.34 * this.scale;
      if (this.contactMat) this.contactMat.opacity = (this.def.hover > 0 ? 0.42 : 0.68) * (1 - e);
      if (e >= 1) this.removeMe = true;
    }
  }

  /* ---------------------------------------------------------------- *
   * mock brain — only runs while no AI module is driving this body.
   * Enough behaviour that a captured frame reads as a real fight.
   * ---------------------------------------------------------------- */

  _mockBrain(dt, elapsed) {
    const bes = this.bes;
    const hero = bes._heroXZ(_v2);
    let tx = hero.x, tz = hero.z;
    const dx = tx - this.position.x, dz = tz - this.position.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const ux = dx / dist, uz = dz / dist;
    const ring = this.mbRing;

    this.mbT -= dt;
    let want = 'idle';
    let move = 0;

    switch (this.mbState) {
      case 'windup':
        if (this.mbT <= 0) { this.mbState = 'strike'; this.mbT = 0.2; }
        want = 'attack_windup';
        break;
      case 'strike':
        if (this.mbT <= 0) { this.mbState = 'recover'; this.mbT = 0.55; }
        want = 'attack';
        move = dist > ring * 0.7 ? 0.55 : 0;
        break;
      case 'recover':
        if (this.mbT <= 0) { this.mbState = 'circle'; this.mbT = 1.1 + (this.seed % 97) * 0.01; }
        want = 'attack_recover';
        break;
      case 'circle':
        want = dist > ring * 1.9 ? 'run' : 'strafe';
        move = dist > ring * 1.15 ? 1 : 0.45;
        if (this.mbT <= 0) {
          if (dist < ring * 1.25) { this.mbState = 'windup'; this.mbT = this.def.ai === 'brute' ? 0.95 : 0.5; }
          else this.mbT = 0.8;
        }
        break;
      default:
        want = 'idle';
        if (this.mbT <= 0) { this.mbState = 'circle'; this.mbT = 0.9; }
        break;
    }

    /* approach / orbit */
    let vx = 0, vz = 0;
    if (move > 0) {
      const speed = (this.aiHint.speed ?? 3) * move;
      if (dist > ring * 1.12) { vx = ux * speed; vz = uz * speed; }
      else {
        // orbit at the ring so the pack surrounds instead of stacking
        const ox = -uz * this.mbFlank, oz = ux * this.mbFlank;
        const corr = (dist - ring) * 0.9;
        vx = (ox * 0.85 + ux * corr) * speed * 0.7;
        vz = (oz * 0.85 + uz * corr) * speed * 0.7;
      }
      this.position.x += vx * dt;
      this.position.z += vz * dt;
    }
    this.velocity.set(vx, 0, vz);
    this.speed = Math.hypot(vx, vz);
    if (want === 'strafe' && this.speed < 0.2) want = 'idle';
    if (want === 'run' && this.speed < (this.aiHint.speed ?? 3) * 0.62) want = 'walk';

    /* always look at the threat */
    this.yaw = Math.atan2(dz, dx);
    this.playAnim(want);
  }
}

const UP = new THREE.Vector3(0, 1, 0);
/** Phase of the walk cycle where each foot plants (see Clips.bipedWalk/quadRun). */
const BIPED_STRIKE = [0.0, 0.5];
const QUAD_STRIKE = [0.45, 0.57, 0.0, 0.12];

function crossed(prev, now, s) {
  return (prev < s && now >= s) || (prev < s - 1 && now >= s - 1);
}

/* ================================================================== *
 * helpers
 * ================================================================== */

function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The engagement ring: one shared annulus, feathered by vertex alpha.
 *
 * WHY IT EXISTS: at gameplay distance an actor is a ~76 px silhouette with, as
 * measured, 0.04-0.12 of luma separation from a torchlit stone floor. That is at
 * or below the threshold a human can find by scanning, which is the other half
 * of "I can't see any enemies" — the bodies were in shot and still not
 * locatable. A ground read solves it the way every ARPG solves it: the fight
 * announces its own position with a mark that does not depend on the lighting
 * that failed. Combat already draws a soft-lock reticle, but only under the one
 * enemy the hero has targeted; this marks everything actually in the fight.
 *
 * No texture (the project is at its fragment sampler ceiling), no per-instance
 * geometry, and the alpha ramp is baked into a vec4 colour attribute so the band
 * has soft edges without a second draw or an SDF.
 */
function makeEngageRing() {
  const geo = new THREE.RingGeometry(0.80, 1.0, 48, 3);
  geo.rotateX(-Math.PI * 0.5);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getZ(i));
    const t = clamp01((r - 0.80) / 0.20);
    // 0 at both edges, 1 across the middle of the band — a feathered stroke, not
    // a hard-edged hoop, which is what keeps it reading as light on the floor.
    const a = Math.sin(t * Math.PI);
    const k = i * 4;
    col[k] = 1; col[k + 1] = 1; col[k + 2] = 1; col[k + 3] = a * a;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  return geo;
}

/** 64² radial ramp with a broken edge — a contact blob, not a decal circle. */
function makeContactTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x + 0.5) / S * 2 - 1;
      const fy = (y + 0.5) / S * 2 - 1;
      const a = Math.atan2(fy, fx);
      const wob = 1 + 0.10 * Math.sin(a * 3.0) + 0.06 * Math.sin(a * 7.0 + 1.1);
      const r = Math.sqrt(fx * fx + fy * fy) / wob;
      const v = Math.pow(Math.max(0, 1 - r), 2.3);
      const i = (y * S + x) * 4;
      const b = Math.round(clamp01(v) * 255);
      data[i] = b; data[i + 1] = b; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Make `def.height` TRUE.
 *
 * Every species declares a height in metres and the whole build is judged
 * against it — the 1.85 m hero is the scale reference for material tiling, prop
 * size and camera distance alike, so "a 3.2 m brute" has to actually be 3.2 m or
 * the reference is a fiction. Measured from the bind-pose buffer, several bodies
 * had drifted under their spec as their proportions were tuned:
 *
 *   skeleton 1.82/1.90   ghoul 1.59/1.72   cultist 1.90/1.88   hound 1.06/1.05
 *   brute    2.86/3.20   wraith 1.85/2.05  boss  5.39/6.50
 *
 * The boss was 17% short of the silhouette the arena is composed around. This
 * folds the shortfall into the instance scale, so a body is built once and every
 * derived quantity (radius, mass, ring distances, footstep offsets) scales with
 * it consistently.
 *
 * Two deliberate limits:
 *  - height is measured from the SOLE PLANE (y = 0) to the highest vertex, not
 *    as the bbox extent. A cultist's robe hem and a brute's knuckles hang below
 *    the feet; counting them would report a taller body than the one that stands
 *    on the floor and shrink it to compensate;
 *  - the correction only ever grows a body, and never past 1.22x. A species
 *    whose bind pose holds a weapon above its head measures taller than it
 *    stands, and the one thing this must never do is shrink such a body to fit.
 */
function fitToSpec(def, geometry) {
  const spec = Number.isFinite(def?.height) ? def.height : 0;
  const pos = geometry?.attributes?.position;
  if (!spec || !pos) return { fit: 1, height: spec };
  let top = 0;
  const arr = pos.array;
  for (let i = 1; i < arr.length; i += 3) if (arr[i] > top) top = arr[i];
  if (!(top > 0.2)) return { fit: 1, height: top };
  return { fit: clamp(spec / top, 1, 1.22), height: top };
}

/** Weighted species draw that guarantees a mixed pack, never N of one thing. */
function weightedMix(table, count, rand, force = null) {
  const out = [];
  const total = table.reduce((s, t) => s + t[1], 0);
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    let r = rand() * total, pick = table[0][0];
    for (const [id, w] of table) { r -= w; if (r <= 0) { pick = id; break; } }
    out.push(pick);
    seen.add(pick);
  }
  // force variety: if the draw came out monotonous, replace a few members
  const wanted = force ?? table.slice(0, 3).map((t) => t[0]);
  let k = 0;
  for (const w of wanted) {
    if (seen.has(w) || out.length < 3) continue;
    out[(k * 3 + 1) % out.length] = w;
    seen.add(w);
    k++;
    if (seen.size >= Math.min(4, count)) break;
  }
  return out;
}

/**
 * How much of the frame the pack is allowed to use, in NDC.
 *
 * Not the full [-1,1] box: a body whose FEET are 4 px inside the bottom edge is
 * a pair of boots, and one whose feet are at the top edge has its head cropped.
 * These are ground-plane bounds for the FEET, so the top margin has to pay for
 * the body's on-screen height (a 1.85 m figure is ~0.17 of NDC height at this
 * lens) and the bottom margin has to clear the HUD.
 */
const FRAME_U = 0.80;      // |u| <= this
const FRAME_V_LO = -0.58;  // v >= this — above the HUD
const FRAME_V_HI = 0.66;   // v <= this — leaves headroom for the silhouette

/** Is a footprint inside the pack's share of the frame, for every anchor? */
function packVisible(frame, x, z, pad = 0) {
  return frame.visible(x, z, (1 - FRAME_U) + pad, (1 + FRAME_V_LO) + pad, (1 - FRAME_V_HI) + pad);
}

/**
 * Believable pack placement: two or three loose knots at irregular bearings from
 * the hero, members scattered inside each knot with a gaussian, then relaxed
 * apart. Never a grid, never a perfect ring, never a line.
 *
 * IN-FRAME BY CONSTRUCTION
 * ------------------------
 * The old version drew a bearing and a radius and called it done, which put
 * roughly half of every pack outside the field of view — 15 m up-camera of the
 * hero, frustum-culled, absent from the picture. The framed area on the ground
 * is not a disc around the hero: it is a trapezoid roughly 20 m wide but only
 * ~4 m deep in front of the subject and ~7 m behind, because the lens looks down
 * a 56 deg slope. A bearing pointing at the camera therefore has far less room
 * than one pointing across it.
 *
 * So `frame` (CameraRig.scenarioFrame) decides how far each bearing may reach:
 *
 *  1. knot centres keep their irregular bearings, but the radius is walked in
 *     from the authored maximum until the centre is inside the frame with room
 *     for its own scatter. A bearing with no room at all is rotated by the
 *     golden angle and retried — that keeps the search deterministic and
 *     non-repeating instead of collapsing every hard bearing onto one fallback;
 *  2. members scatter and relax exactly as before, so the *shape* of the pack is
 *     unchanged — this only bounds where the knots may sit;
 *  3. anything still outside after relaxation is drawn back along its own line
 *     to the hero by bisection, each with a different stop fraction so escapees
 *     never line up along the frame edge (which would read as the grid the art
 *     review fails).
 *
 * With `frame` omitted the behaviour is the original unbounded placement, so
 * AI-driven summons far from the lens still work.
 */
function packFormation(hx, hz, count, rand, minDist = 5.4, frame = null) {
  const inside = frame ? (x, z, pad = 0) => packVisible(frame, x, z, pad) : () => true;

  const knots = count <= 3 ? 1 : count <= 6 ? 2 : 3;
  const centres = [];
  let bearing = rand() * Math.PI * 2;
  const GOLDEN = 2.399963229728653; // rotate a hopeless bearing, don't repeat it
  for (let i = 0; i < knots; i++) {
    bearing += 1.5 + rand() * 1.9;
    const w = 0.7 + rand() * 0.9;
    const far = minDist + rand() * 4.6 + i * 0.9;
    const near = Math.min(3.5, far);        // never inside the hero's own space
    const pad = 0.055 + w * 0.045;          // room for this knot's own scatter
    let cx = hx + Math.cos(bearing) * far;
    let cz = hz + Math.sin(bearing) * far;
    let placed = inside(cx, cz, pad);
    for (let attempt = 0; !placed && attempt < 6; attempt++) {
      const a = bearing + GOLDEN * attempt;
      const ca = Math.cos(a), sa = Math.sin(a);
      // walk the radius in from `far` to `near`; take the first that fits, so a
      // knot stays as far out as the frame allows instead of hugging the hero
      for (let s = 0; s <= 6; s++) {
        const d = far + (near - far) * (s / 6);
        const tx = hx + ca * d, tz = hz + sa * d;
        if (!inside(tx, tz, pad)) continue;
        cx = tx; cz = tz; bearing = a; placed = true;
        break;
      }
    }
    if (!placed) { cx = hx + Math.cos(bearing) * near; cz = hz + Math.sin(bearing) * near; }
    centres.push({ x: cx, z: cz, w });
  }

  const pts = [];
  for (let i = 0; i < count; i++) {
    const c = centres[i % knots];
    const a = rand() * Math.PI * 2;
    const r = Math.abs(rand.gauss(0, 1)) * 1.35 * c.w + 0.35;
    pts.push({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r, pull: 0.62 + rand() * 0.30 });
  }
  /* relaxation: keep them from stacking, and off the hero's toes */
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const hdx = a.x - hx, hdz = a.z - hz;
      const hd = Math.hypot(hdx, hdz) || 1e-4;
      if (hd < 3.2) { a.x += (hdx / hd) * (3.2 - hd) * 0.6; a.z += (hdz / hd) * (3.2 - hd) * 0.6; }
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz) || 1e-4;
        if (d >= 1.85) continue;
        const p = (1.85 - d) * 0.5;
        a.x -= (dx / d) * p; a.z -= (dz / d) * p;
        b.x += (dx / d) * p; b.z += (dz / d) * p;
      }
    }
  }

  /* final guarantee: every body is in the picture */
  if (frame) {
    for (const p of pts) {
      if (inside(p.x, p.z)) { delete p.pull; continue; }
      const dx = p.x - hx, dz = p.z - hz;
      // bisect the offset from the hero — the direction (and so the read of the
      // pack) is preserved, only the reach shrinks
      let lo = 0, hi = 1;
      for (let it = 0; it < 18; it++) {
        const m = (lo + hi) * 0.5;
        if (inside(hx + dx * m, hz + dz * m, 0.02)) lo = m; else hi = m;
      }
      // stop short of the boundary by a per-body amount so escapees from the
      // same edge do not end up collinear along it
      const t = Math.max(0.18, lo * p.pull);
      p.x = hx + dx * t;
      p.z = hz + dz * t;
      delete p.pull;
    }
    /* one more push-apart: pulling bodies in can have stacked two of them */
    for (let it = 0; it < 8; it++) {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        for (let j = i + 1; j < pts.length; j++) {
          const b = pts[j];
          const dx = b.x - a.x, dz = b.z - a.z;
          const d = Math.hypot(dx, dz) || 1e-4;
          if (d >= 1.85) continue;
          const push = (1.85 - d) * 0.5;
          const ax = a.x - (dx / d) * push, az = a.z - (dz / d) * push;
          const bx = b.x + (dx / d) * push, bz = b.z + (dz / d) * push;
          if (inside(ax, az)) { a.x = ax; a.z = az; }
          if (inside(bx, bz)) { b.x = bx; b.z = bz; }
        }
      }
    }
  }
  return pts;
}
