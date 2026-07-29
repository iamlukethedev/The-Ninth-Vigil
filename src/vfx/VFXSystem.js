import * as THREE from 'three';

import { SpriteBatch, Spec, buildMaskTexture, SHAPE, ALIGN } from './emitters/Sprites.js';
import { RECIPES, PALETTE } from './emitters/Recipes.js';
import { GroundFX, GSHAPE } from './emitters/Ground.js';
import { BoltSystem } from './emitters/Bolts.js';
import { ScreenFX } from './emitters/Screen.js';
import { TrailSystem } from './Trails.js';

/**
 * SANCTUM — VFX system.
 *
 * Owns every combat effect in the game. Five GPU resources, five draw calls
 * total, all pooled and all deterministic:
 *
 *   additive sprite batch   sparks, flame, embers, glows, rings, sparkle
 *   alpha sprite batch      smoke, dust, mist, blood, debris (form-lit)
 *   ground quads            telegraphs, scorch, rime, pools, blood splats
 *   bolt strips             procedurally branched lightning
 *   ribbon strips           weapon trails
 *   (+ one optional screen pass, only when heat / CA / low health is active)
 *
 * ### Determinism
 * One PRNG, re-seeded to a fixed constant on every `applyScenario`, advanced
 * only inside spawn code. Spawns are driven by bus events and by fixed-dt
 * accumulators, so the same scenario at the same frame count produces the same
 * particles — which the screenshot critic depends on. No `Math.random`, no
 * wall clock: the shader clock is a value this module integrates from the fixed
 * `dt` itself, and it rebases periodically so float precision never drifts.
 *
 * ### Soft particles
 * Every one of the five shaders samples the render pipeline's depth prepass and
 * fades alpha across a per-effect depth band. Hard-clipped billboards cutting
 * into the floor are an instant rubric fail, so this is not optional; if the
 * prepass is unavailable the shaders fall back to their own radial falloff and
 * a near-plane fade rather than showing a cut edge.
 *
 * ### Emissive discipline
 * Only flame, magic and lightning *cores* are written above 1.0 linear. Dust,
 * smoke, debris, blood and rime stay below it, so the bloom pass stays a tight
 * highlight on things that are genuinely hot instead of hazing the frame.
 */
export class VFXSystem {
  static id = 'vfx';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.__dead = false;
    this.enabled = true;

    /** vfx clock — integrated from the fixed dt, never the wall clock */
    this.now = 0;
    this._rebaseAt = 600;

    /** particle-count multiplier by quality tier */
    this.density = 1;
    /** scene-linear ceiling for one additive sprite — see _syncRadianceCeiling */
    this.maxRadiance = 0.84;

    this.s = new Spec();
    this.rnd = engine.freshRand(0x5A17C0);

    this.masks = null;
    /** additive batch (sparks, flame, glow) — `glow()` writes into it */
    this.add = null;
    /** alpha batch (smoke, dust, blood) — `soft()` writes into it */
    this.softBatch = null;
    this.groundFX = null;
    this.bolts = null;
    this.trails = null;
    this.screen = null;

    this._flashes = [];
    this._heat = [];
    this._attach = [];
    this._pendDecal = [];          // droplet landings waiting to become splats
    this._tg = new Map();          // telegraph uid -> ground key
    this._fixtures = [];           // warm fixtures that shed embers
    this._off = [];

    this._ca = 0;                  // live chromatic pulse amount
    this._caBase = null;           // pipeline value we are riding on top of
    this._blood = 0;               // low-health vignette amount
    this._moteAcc = 0;
    this._emberAcc = 0;
    this._fixtureScanAt = -999;
    this._hitFlash = 0;

    this._heroTrail = null;
    this._tipPrev = new THREE.Vector3();
    this._tipHas = false;
    this._trailGain = 0;

    this._v0 = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._key = new THREE.Vector3(0.4, 0.8, 0.45).normalize();
    this._keyCol = new THREE.Color(1, 0.78, 0.52);
    this._ambCol = new THREE.Color(0.20, 0.23, 0.31);
    this._focus = new THREE.Vector3();
    this._tmpCol = new THREE.Color();
    this._tgCol = new THREE.Color();
    this._tgDim = new THREE.Color();
    this._size = new THREE.Vector2();

    this._opts = {
      x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
      scale: 1, magnitude: 0.6, intensity: 1,
      colour: null, groundY: 0, kind: 'weapon',
      height: 1.8, radius: 0.42, duration: 0.6, life: 1.2,
      ax: undefined, ay: undefined, az: undefined,
      bx: undefined, by: undefined, bz: undefined,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async init() {
    const engine = this.engine;
    const tier = engine.quality?.tier ?? 'ultra';
    const budget = {
      low: { add: 1200, soft: 500, ground: 28, bolts: 12, density: 0.45 },
      med: { add: 2200, soft: 900, ground: 40, bolts: 18, density: 0.7 },
      high: { add: 3600, soft: 1500, ground: 80, bolts: 24, density: 0.9 },
      ultra: { add: 4600, soft: 1900, ground: 96, bolts: 30, density: 1.0 },
    }[tier] ?? { add: 4600, soft: 1900, ground: 96, bolts: 30, density: 1.0 };
    this.density = budget.density;

    this.masks = buildMaskTexture(256);

    this.add = new SpriteBatch({
      capacity: budget.add, blend: 'add', masks: this.masks,
      renderOrder: 20, shaded: 0, name: 'Sanctum.vfxAdd',
    });
    this.softBatch = new SpriteBatch({
      capacity: budget.soft, blend: 'alpha', masks: this.masks,
      renderOrder: 18, shaded: 1, name: 'Sanctum.vfxSoft',
    });
    this.groundFX = new GroundFX({ capacity: budget.ground, masks: this.masks });
    this.bolts = new BoltSystem({ strips: budget.bolts, segments: 16 });
    this.trails = new TrailSystem({ ribbons: 6, samples: 26 });
    this.screen = new ScreenFX();
    this.screen.setSize(engine.width || 1600, engine.height || 900);

    const root = new THREE.Group();
    root.name = 'vfx';
    root.matrixAutoUpdate = false;
    root.userData.noCSM = true;
    root.add(this.groundFX.mesh);
    root.add(this.softBatch.mesh);
    root.add(this.trails.mesh);
    root.add(this.add.mesh);
    root.add(this.bolts.mesh);
    engine.scene.add(root);
    this.root = root;

    this._buildFlashPool();
    this._wire();

    console.info(
      `[vfx] ${budget.add + budget.soft} particle slots, ${budget.ground} ground quads, ` +
      `${budget.bolts} bolt strips, 5 draw calls, 2 texture units (masks + depth)`
    );
  }

  /**
   * A pool of plain point lights, added ONCE and never removed.
   *
   * They cannot come from `Lighting`'s practical pool: that pool cross-fades
   * slot ownership at 4.2/s, so a light that wants to be at full brightness on
   * the frame of contact would take a quarter of a second to arrive — an impact
   * flash has to be instant or it is not a flash. Adding them permanently is
   * what keeps `NUM_POINT_LIGHTS` constant, so no lit material ever recompiles;
   * `castShadow` stays false, so they cost zero texture units (the project sits
   * at 14/16 and a shadowed point light would be one more sampler in every
   * material).
   */
  _buildFlashPool() {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.name = `vfx.flash.${i}`;
      l.castShadow = false;
      /* Stays visible for the whole session. `projectObject` skips invisible
         lights, so `visible = false` drops NUM_POINT_LIGHTS and relinks every
         lit program in the scene — the flash pool was toggling several times a
         second and each toggle cost ~60 ms. Intensity 0 while parked is the
         same picture for none of the cost. */
      l.visible = true;
      l.position.set(0, -1000 - i, 0);
      this.engine.scene.add(l);
      this._flashes.push({ light: l, t: 0, dur: 0, peak: 0, active: false });
    }
  }

  _wire() {
    const bus = this.engine.bus;
    const on = (evt, fn) => {
      this._off.push(bus.on(evt, (p) => {
        if (this.__dead || !this.enabled) return;
        try { fn(p); } catch (e) { console.warn(`[vfx:${evt}]`, e?.message ?? e); }
      }));
    };

    on('impact', (p) => this._onImpact(p));
    on('damage', (p) => this._onDamage(p));
    on('death', (p) => this._onDeath(p));
    on('ability:cast', (p) => this._onCast(p));
    on('loot:drop', (p) => this._onLoot(p));
    on('loot:pickup', (p) => this._onPickup(p));
    on('level:up', (p) => this._onLevelUp(p));
    on('telegraph:begin', (p) => this._onTelegraph(p, 'begin'));
    on('telegraph:update', (p) => this._onTelegraph(p, 'update'));
    on('telegraph:end', (p) => this._onTelegraph(p, 'end'));
    on('dungeon:fixture', (p) => this._addFixture(p?.position, 1));
    on('lighting:torch', (p) => this._addFixture(p?.position, 1));
    on('render:overlay', (p) => {
      if (p?.renderer && this.screen) this.screen.render(p.renderer);
    });
  }

  applyScenario(name, cfg = {}) {
    if (this.__dead) return;
    try {
      // Re-seed and wipe so a scenario always starts from the same state, no
      // matter what ran before it. Byte-identical captures depend on this.
      this.rnd = this.engine.freshRand(0x5A17C0);
      this.now = 0;
      this._ca = 0;
      this._caBase = null;
      this._blood = 0;
      this._moteAcc = 0;
      this._emberAcc = 0;
      this._fixtureScanAt = -999;
      this._tipHas = false;
      this._trailGain = 0;
      this._tg.clear();
      this._pendDecal.length = 0;
      this._attach.length = 0;
      this._fixtures.length = 0;
      this.add?.clear();
      this.softBatch?.clear();
      this.groundFX?.clear();
      this.bolts?.clear();
      this.trails?.clear();
      for (const f of this._flashes) {
        f.active = false; f.t = 0; f.peak = 0;
        f.light.intensity = 0; f.light.position.y = -1000;
      }

      const env = cfg.env ?? {};
      this.scenario = name;
      this.interior = env.interior === true;
      this.biome = env.biome ?? 'crypt';

      // Ambient particulate: substance in the air, keyed to the biome.
      const AMB = {
        crypt: { motes: 7.0, colour: PALETTE.dust, intensity: 0.5, embers: 1.6 },
        hell: { motes: 5.0, colour: PALETTE.ember, intensity: 0.75, embers: 3.2 },
        town: { motes: 3.5, colour: PALETTE.dust, intensity: 0.45, embers: 1.1 },
        moor: { motes: 2.4, colour: PALETTE.dust, intensity: 0.4, embers: 0.5 },
      };
      this.ambient = AMB[this.biome] ?? AMB.crypt;
      if (env.weather === 'rain' || env.weather === 'storm') {
        this.ambient = { ...this.ambient, motes: this.ambient.motes * 0.35 };
      }

      this._setupHeroTrail();
    } catch (e) {
      console.warn('[vfx] applyScenario —', e?.message ?? e);
    }
  }

  resize(w, h) {
    try { this.screen?.setSize(w, h); } catch { /* non-fatal */ }
  }

  dispose() {
    for (const off of this._off) { try { off(); } catch { /* ignore */ } }
    this._off.length = 0;
    for (const f of this._flashes) f.light.parent?.remove(f.light);
    this._flashes.length = 0;
    this.root?.parent?.remove(this.root);
    this.add?.dispose();
    this.softBatch?.dispose();
    this.groundFX?.dispose();
    this.bolts?.dispose();
    this.trails?.dispose();
    this.screen?.dispose();
    this.masks?.dispose();
    this._restoreCA();
  }

  /* ------------------------------------------------------------------ */
  /*  public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Fire a one-shot effect.
   * @param {string} kind  'impact' 'blood' 'fire' 'fireburst' 'frost' 'lightning'
   *                       'necrotic' 'arcane' 'charge' 'dissolve' 'shaft'
   *                       'pickup' 'dust' 'ring' 'cone' 'puddle'
   * @param {object} o { position, direction, scale, colour, intensity, magnitude, ... }
   */
  spawn(kind, o = {}) {
    if (this.__dead || !this.enabled) return false;
    try {
      const t = this._opts;
      const p = o.position ?? o.point ?? o;
      t.x = num(p?.x, 0); t.y = num(p?.y, 0); t.z = num(p?.z, 0);
      const d = o.direction ?? o.normal ?? null;
      t.nx = num(d?.x, 0); t.ny = num(d?.y, 1); t.nz = num(d?.z, 0);
      if (t.nx === 0 && t.ny === 0 && t.nz === 0) t.ny = 1;
      t.scale = num(o.scale, 1);
      t.magnitude = num(o.magnitude, num(o.intensity, 0.6));
      t.intensity = num(o.intensity, 1);
      t.colour = toColour(o.colour ?? o.color, this._tmpCol) ?? null;
      t.kind = o.kind ?? kind;
      t.height = num(o.height, 1.8);
      t.radius = num(o.radius, 0.42);
      t.duration = num(o.duration, 0.6);
      t.life = num(o.life, 1.2);
      t.ax = o.ax; t.ay = o.ay; t.az = o.az;
      t.bx = o.bx; t.by = o.by; t.bz = o.bz;
      t.groundY = num(o.groundY, this.groundYAt(t.x, t.z));
      if (t.y < t.groundY) t.y = t.groundY;

      if (kind === 'ring' || kind === 'cone' || kind === 'puddle' || kind === 'glyph') {
        this._groundShape(kind, o, t);
        return true;
      }
      const fn = RECIPES[kind];
      if (!fn) return false;
      fn(this, t);
      return true;
    } catch (e) {
      console.warn('[vfx] spawn —', e?.message ?? e);
      return false;
    }
  }

  /**
   * Attach a persistent emitter to an object. Returns a handle for `detach`.
   * @param {string} kind 'fire' 'frost' 'necrotic' 'arcane' 'embers' 'trail'
   * @param {THREE.Object3D} object3D
   */
  attach(kind, object3D, o = {}) {
    if (this.__dead || !object3D || !object3D.isObject3D) return null;
    const h = {
      kind,
      obj: object3D,
      rate: num(o.rate, kind === 'embers' ? 3 : 14),
      acc: 0,
      scale: num(o.scale, 1),
      intensity: num(o.intensity, 1),
      colour: toColour(o.colour ?? o.color, new THREE.Color()) ?? null,
      offset: new THREE.Vector3(num(o.offsetX, 0), num(o.offsetY, 0), num(o.offsetZ, 0)),
      ribbon: null,
      tip: o.tip ? new THREE.Vector3(o.tip.x, o.tip.y, o.tip.z) : new THREE.Vector3(0, 1, 0),
      hilt: o.hilt ? new THREE.Vector3(o.hilt.x, o.hilt.y, o.hilt.z) : new THREE.Vector3(0, 0, 0),
      alive: true,
    };
    if (kind === 'trail') {
      h.ribbon = this.trails?.acquire({ color: h.colour ?? PALETTE.arc }) ?? null;
      if (!h.ribbon) return null;
      h.ribbon.gain = num(o.gain, 0.5);
    }
    this._attach.push(h);
    return h;
  }

  detach(handle) {
    if (!handle) return false;
    const i = this._attach.indexOf(handle);
    if (i < 0) return false;
    this._attach.splice(i, 1);
    handle.alive = false;
    if (handle.ribbon) this.trails?.release(handle.ribbon);
    return true;
  }

  /** Ground height under a world XZ, using whatever authority exists. */
  groundYAt(x, z) {
    const e = this.engine;
    const t = e.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    const d = e.get('dungeon');
    if (d && !d.__dead) {
      const f = d.floorHeightAt ?? d.heightAt;
      if (typeof f === 'function') {
        const y = f.call(d, x, z);
        if (Number.isFinite(y)) return y;
      }
    }
    return 0;
  }

  /* --------------------------- recipe callbacks --------------------- */
  /* These are what Recipes.js drives; keeping them on the module means a
     recipe is a pure description and never touches a GPU resource itself. */

  /** Emit the shared spec into the additive batch. */
  glow() { this.add.emit(this.s, this.now); }
  /** Emit the shared spec into the alpha (form-lit) batch. */
  soft() { this.softBatch.emit(this.s, this.now); }

  /**
   * One-beat point light. Instant onset, exponential decay.
   *
   * ### Why the intensity is clamped against the floor distance
   *
   * These are the other half of the "clipped white disc" defect, and hiding the
   * additive meshes does not make them go away because they are not meshes. A
   * PointLight at `decay = 2` puts `I / d²` of irradiance on the nearest
   * surface, and a Lambert floor turns that into `irradiance * albedo / PI` of
   * scene-linear radiance. Recipes ask for I = 15-126 (fireburst asks for
   * 90 * scale) from 0.6-1.6 m above the floor, which is 35-350 irradiance and
   * 3-33 linear off a stone albedo — 4x to 40x over the value ACES maps to 0.85.
   * The result is a fully-clipped elliptical pool of white floor with no texture
   * left in it. Measured on the frozen night frame at 1600x900: zeroing the
   * three flash lights took clipped-white area from 0.305 % to 0.266 %, i.e.
   * they carried 0.039 pp of it on their own. With the clamp below in place the
   * same test moves the frame by 0.0005 pp — they now light the floor without
   * writing a clipped pixel into it.
   *
   * So the clamp is expressed where the defect is — on the irradiance that
   * reaches the floor, not on the raw candela. The floor still gets to be the
   * brightest thing in frame at ~0.85 output, which is exactly the read the
   * recipe wanted ("the scene carries the brightness of the hit"); it just stops
   * carrying it 40x past the clip point.
   *
   * Concurrent flashes within 1.5 m share the budget, because three of them at
   * the ceiling sum to three times the ceiling on the same patch of floor.
   */
  flash(x, y, z, colour, intensity, radius, dur) {
    let best = null;
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      if (!f.active) { best = f; break; }
      // Steal the one closest to finishing.
      if (!best || f.t / Math.max(f.dur, 1e-4) > best.t / Math.max(best.dur, 1e-4)) best = f;
    }
    if (!best) return;
    if (best.active && best.peak > intensity * 1.6) return;  // Don't downgrade.

    /*
     * Lift the light off the surface it is lighting.
     *
     * The clamp below is `I <= eCap * h²`, so a flash sitting 0.1 m off the floor
     * gets almost no budget and lights a 20 cm dot — physically right, and a
     * useless read. A point source that close to a plane is simply the wrong
     * model for a flash: the light of an impact pools over about a metre. At
     * 0.55 m the budget is 2.9 cd, which puts the floor directly below at 0.91
     * linear and still at 0.10 a metre out — a soft pool with a falling-off
     * edge, which is what the recipe is asking for.
     */
    const gy = this.groundYAt(x, z);
    const lift = Math.max(y, gy + 0.55);

    /* Irradiance that lands one Lambert bounce below the exposure-derived
       radiance ceiling: L = E * albedo / PI, albedo 0.30, and a flash-lit floor
       is allowed 1.15x a sprite core because it IS the light source's read. */
    const eCap = (Math.PI / 0.30) * this.maxRadiance * 1.15;
    const h = Math.max(0.3, lift - gy);
    let share = 1;
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      if (f === best || !f.active || f.light.intensity <= 1e-3) continue;
      const dx = f.light.position.x - x, dy = f.light.position.y - lift, dz = f.light.position.z - z;
      if (dx * dx + dy * dy + dz * dz < 2.25) share += 1;
    }
    const peak = Math.min(intensity, (eCap * h * h) / share);

    best.active = true;
    best.t = 0;
    best.dur = Math.max(0.05, dur);
    best.peak = peak;
    best.light.position.set(x, lift, z);
    best.light.distance = Math.max(1, radius);
    if (colour) best.light.color.copy(colour);
    best.light.intensity = peak;
    best.light.visible = true;   // Already true; kept for clarity.
  }

  /** Register a heat source for the screen-space refraction pass. */
  heat(x, y, z, radius, strength, dur) {
    if (this._heat.length > 24) return;
    this._heat.push({ x, y, z, radius, strength, t: 0, dur: Math.max(0.05, dur) });
  }

  /** Chromatic pulse on a heavy hit. Additive over the pipeline's own CA. */
  caPulse(amount) {
    this._ca = Math.min(0.9, Math.max(this._ca, amount));
  }

  /**
   * Who owns the ground read.
   *
   * `Decals` maps 'impact' and 'damage' to its own stain table off the same bus
   * events I listen to, and both it and CombatSystem's HitFeel already draw
   * telegraphs. Stacking a third copy of either is worse than having none: two
   * coincident stains double the opacity and two telegraphs disagree by a frame.
   * So my ground quads exist as the *fallback* owner, and when the real owner is
   * present I contribute only what it cannot know — where a thrown droplet
   * actually landed, and the volumetric garnish above a telegraph.
   */
  _decals() {
    const d = this.engine.get('decals');
    return d && !d.__dead && d.enabled !== false ? d : null;
  }
  _stainsOwned() { return this._decals() !== null; }
  _telegraphsOwned() {
    if (this._decals()?.telegraphs) return true;
    const c = this.engine.get('combat');
    return !!(c && !c.__dead && c.groundFX);
  }

  /** Ground stain / read. Kinds: scorch, rime, pool, glyph, blood. */
  ground(kind, o) {
    if (!this.groundFX) return;
    if (this._stainsOwned() && kind !== 'glyph') return;
    const cfg = {
      scorch: { shape: GSHAPE.STAIN, opacity: 0.62, rimGain: 0.35, fadeOut: 0.5, soft: 0.3 },
      ash: { shape: GSHAPE.STAIN, opacity: 0.55, rimGain: 0.25, fadeOut: 0.5, soft: 0.3 },
      rime: { shape: GSHAPE.STAIN, opacity: 0.40, rimGain: 0.32, fadeOut: 0.55, soft: 0.3 },
      pool: { shape: GSHAPE.STAIN, opacity: 0.55, rimGain: 0.7, fadeOut: 0.45, soft: 0.28 },
      blood: { shape: GSHAPE.STAIN, opacity: 0.72, rimGain: 0.2, fadeOut: 0.4, soft: 0.3 },
      glyph: { shape: GSHAPE.GLYPH, opacity: 0.5, rimGain: 1.0, fadeOut: 0.3, soft: 0.2 },
    }[kind] ?? { shape: GSHAPE.STAIN, opacity: 0.5, rimGain: 0.4, fadeOut: 0.4, soft: 0.3 };

    this.groundFX.add({
      x: o.x, z: o.z, y: o.y ?? this.groundYAt(o.x, o.z),
      shape: cfg.shape,
      halfX: o.radius ?? 1, halfZ: o.radius ?? 1,
      yaw: o.yaw ?? 0,
      life: o.life ?? 6,
      colour: o.colour ?? PALETTE.ash,
      opacity: o.opacity ?? cfg.opacity,
      rim: o.rim ?? o.colour ?? PALETTE.ash,
      rimGain: o.rimGain ?? cfg.rimGain,
      rimIntensity: o.rimIntensity ?? 1,
      soft: cfg.soft,
      seed: o.seed ?? this.rnd(),
      fadeIn: o.fadeIn ?? 0.05,
      fadeOut: cfg.fadeOut,
    }, this.now);
  }

  /**
   * A blood splat scheduled for the moment a droplet actually lands.
   *
   * This is the one ground mark `Decals` cannot derive from the damage event:
   * arterial spray lands a metre or two from the wound, and *that* spread is
   * what makes a fight look like it happened. Handed off to Decals when it
   * exists (it projects onto real geometry), drawn here when it does not.
   */
  groundSplat(x, z, delay, radius, rnd) {
    const gy = this.groundYAt(x, z);
    const seed = (rnd() * 4294967295) >>> 0;
    if (this._stainsOwned()) {
      if (this._pendDecal.length < 40) {
        this._pendDecal.push({
          t: this.now + delay, kind: radius > 0.28 ? 'blood_splat' : 'blood_drips',
          x, z, scale: Math.max(0.22, radius * 1.6), seed,
        });
      }
      return;
    }
    this.groundFX?.add({
      x, z, y: gy,
      shape: GSHAPE.STAIN,
      halfX: radius, halfZ: radius,
      yaw: rnd() * Math.PI * 2,
      t0: this.now + delay,
      life: rnd.range(5, 9),
      colour: PALETTE.bloodDark,
      opacity: 0.78,
      rim: PALETTE.blood,
      rimGain: 0.34,
      soft: 0.3,
      seed: rnd(),
      fadeIn: 0.03,
      fadeOut: 0.55,
    }, this.now);
  }

  /** Flush landings whose moment has come. Deterministic: driven by vfx time. */
  _flushPendingDecals() {
    const list = this._pendDecal;
    if (!list.length) return;
    const d = this._decals();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (this.now < e.t) continue;
      list.splice(i, 1);
      if (!d) continue;
      try {
        d.spawn?.(e.kind, { x: e.x, z: e.z, scale: e.scale, seed: e.seed });
      } catch { /* presentation only */ }
    }
  }

  /**
   * Announce a projected mark. When `Decals` is present it already derives
   * scorch / rime / scuff / crater from the very same 'impact' and 'damage'
   * events, so re-requesting them here would draw each stain twice; the request
   * is only broadcast for whoever *else* may be listening when Decals is absent.
   */
  decal(kind, x, y, z, radius, rot, colour, delay = 0) {
    if (this._stainsOwned()) return false;
    try {
      this.engine.bus.emit('decal:request', {
        kind, radius, rotation: rot, delay,
        position: { x, y, z },
        normal: { x: 0, y: 1, z: 0 },
        colour: colour ? colour.getHex() : undefined,
      });
    } catch { /* noop */ }
    return false;
  }

  /** Lightning polyline. */
  bolt(ax, ay, az, bx, by, bz, o = {}) {
    if (!this.bolts) return;
    this.bolts.strike({
      ax, ay, az, bx, by, bz,
      width: o.width ?? 0.07,
      life: o.life ?? 0.2,
      core: o.core ?? PALETTE.arc,
      glow: o.glow ?? PALETTE.arcMid,
      intensity: o.intensity ?? 3,
      branches: Math.round((o.branches ?? 3) * Math.max(0.4, this.density)),
      jitter: o.jitter ?? 0.4,
      seed: o.seed ?? this.rnd(),
      rnd: this.rnd,
      now: this.now,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  bus handlers                                                       */
  /* ------------------------------------------------------------------ */

  _onImpact(p) {
    if (!p) return;
    const t = this._opts;
    readVec(p.point ?? p.position, t, 'x', 'y', 'z');
    readVec(p.normal, t, 'nx', 'ny', 'nz', 0, 1, 0);
    t.groundY = this.groundYAt(t.x, t.z);
    if (t.y < t.groundY) t.y = t.groundY + 0.02;
    t.magnitude = clamp(num(p.magnitude, 0.6), 0.1, 2.2);
    t.scale = 1;
    t.intensity = 1;
    t.kind = String(p.kind ?? 'weapon');
    t.colour = null;
    // `_opts` is a shared, reused object: a stale swing axis left behind by an
    // earlier spawn() would silently steer this hit's arc. Clear, then read.
    readSwing(p, t);

    const el = elementOf(p.abilityId, t.kind);

    switch (t.kind) {
      case 'footfall':
      case 'dust':
      case 'step':
        t.magnitude *= 0.6;
        RECIPES.dust(this, t);
        return;
      case 'splash':
      case 'water':
        t.magnitude *= 0.8;
        RECIPES.dust(this, t);
        return;
      case 'summon':
        t.scale = 1.15;
        RECIPES.necrotic(this, t);
        return;
      case 'arcane':
        t.scale = 0.9 + t.magnitude * 0.4;
        RECIPES.arcane(this, t);
        return;
      case 'aoe': {
        t.scale = 1.0 + t.magnitude * 0.5;
        if (el === 'frost') RECIPES.frost(this, t);
        else if (el === 'lightning') RECIPES.lightning(this, t);
        else if (el === 'fire') RECIPES.fireburst(this, t);
        else RECIPES.necrotic(this, t);
        return;
      }
      case 'heavy_impact':
      case 'heavy':
        t.magnitude = Math.max(t.magnitude, 0.95);
        t.scale = 1.25;
        RECIPES.impact(this, t);
        return;
      default:
        if (el === 'fire') { t.scale = 1.1; RECIPES.fireburst(this, t); return; }
        if (el === 'frost') { RECIPES.frost(this, t); return; }
        if (el === 'lightning') { RECIPES.lightning(this, t); return; }
        if (el === 'necrotic') { RECIPES.necrotic(this, t); return; }
        RECIPES.impact(this, t);
    }
  }

  _onDamage(p) {
    if (!p) return;
    const t = this._opts;
    const amt = num(p.amount, 8);
    const target = p.target;
    readVec(p.hitPoint ?? p.point, t, 'x', 'y', 'z');
    if (t.x === 0 && t.y === 0 && t.z === 0) {
      const pos = target?.position;
      if (pos) { t.x = pos.x; t.y = pos.y + 1.0; t.z = pos.z; }
    }
    readVec(p.hitNormal ?? p.normal, t, 'nx', 'ny', 'nz', 0, 1, 0);
    // A wound sprays back along the blow, not along it.
    t.nx = -t.nx; t.nz = -t.nz;
    t.groundY = this.groundYAt(t.x, t.z);
    t.magnitude = clamp(0.35 + amt / 46, 0.3, 2.4) * (p.crit ? 1.5 : 1);
    t.scale = 1;
    t.colour = null;
    readSwing(p, t);

    const isHero = target && target === this.engine.get('hero');
    const fluid = fluidOf(target);
    const type = String(p.type ?? 'physical');

    if (type === 'necrotic' || type === 'poison') {
      t.scale = 0.55 + t.magnitude * 0.3;
      RECIPES.necrotic(this, t);
    } else if (type === 'fire') {
      t.scale = 0.6 + t.magnitude * 0.3;
      RECIPES.fire(this, t);
    } else if (type === 'cold' || type === 'frost') {
      t.scale = 0.55 + t.magnitude * 0.25;
      RECIPES.frost(this, t);
    } else if (fluid === 'none') {
      // Bone and armour do not bleed — they chip.
      t.kind = 'weapon';
      RECIPES.impact(this, t);
    } else {
      t.colour = fluid === 'ichor' ? PALETTE.necroDark : null;
      RECIPES.blood(this, t);
    }

    if (isHero) {
      this._hitFlash = 0.35;
      this.caPulse(Math.min(0.55, 0.18 + amt / 90));
    }
  }

  _onDeath(p) {
    if (!p) return;
    const t = this._opts;
    const ent = p.entity;
    const pos = ent?.position ?? p.hitPoint;
    t.x = num(pos?.x, 0); t.z = num(pos?.z, 0);
    t.groundY = this.groundYAt(t.x, t.z);
    t.y = t.groundY;
    t.height = clamp(num(ent?.height, num(ent?.def?.height, 1.85)), 0.6, 7);
    t.radius = clamp(num(ent?.radius, t.height * 0.22), 0.15, 2.2);
    t.nx = 0; t.ny = 1; t.nz = 0;
    t.scale = 1;
    const fluid = fluidOf(ent);
    t.colour = fluid === 'ichor' ? PALETTE.necro
      : fluid === 'none' ? PALETTE.frostMid
        : PALETTE.ember;
    RECIPES.dissolve(this, t);

    // A big death is felt in the frame, not just seen.
    if (t.height > 3) this.caPulse(0.45);
  }

  _onCast(p) {
    if (!p) return;
    const t = this._opts;
    readVec(p.origin ?? p.position, t, 'x', 'y', 'z');
    readVec(p.dir ?? p.direction, t, 'nx', 'ny', 'nz', 0, 0, 1);
    t.groundY = this.groundYAt(t.x, t.z);
    t.scale = 0.85 + num(p.level, 1) * 0.12;
    t.duration = clamp(num(p.windup, 0.55), 0.12, 2.0);
    t.magnitude = 0.7;

    const el = elementOf(p.id, p.projectile);
    const tgColour = toColour(p.telegraph?.color, this._tmpCol);
    t.colour = tgColour ?? (
      el === 'fire' ? PALETTE.flameMid
        : el === 'frost' ? PALETTE.frostMid
          : el === 'lightning' ? PALETTE.arcMid
            : el === 'necrotic' ? PALETTE.necro
              : PALETTE.arcane
    );
    RECIPES.charge(this, t);
  }

  _onLoot(p) {
    if (!p) return;
    const t = this._opts;
    const pos = p.position ?? p.point;
    t.x = num(pos?.x, 0); t.z = num(pos?.z, 0);
    t.groundY = this.groundYAt(t.x, t.z);
    t.y = t.groundY;
    t.colour = rarityColour(p.item, this._tmpCol);
    t.life = 3.2;
    RECIPES.pickup(this, t);
  }

  _onPickup(p) {
    const hero = this.engine.get('hero');
    const pos = hero?.position;
    if (!pos) return;
    const t = this._opts;
    t.x = pos.x; t.z = pos.z;
    t.groundY = this.groundYAt(t.x, t.z);
    t.y = t.groundY;
    t.colour = rarityColour(p?.item, this._tmpCol);
    t.scale = 0.7;
    t.height = 2.2;
    t.life = 0.8;
    RECIPES.shaft(this, t);
  }

  _onLevelUp(p) {
    const hero = this.engine.get('hero');
    const pos = hero?.position;
    const t = this._opts;
    t.x = num(pos?.x, 0); t.z = num(pos?.z, 0);
    t.groundY = this.groundYAt(t.x, t.z);
    t.y = t.groundY;
    t.colour = PALETTE.gold;
    t.scale = 1.25;
    t.height = 6;
    t.life = 1.9;
    RECIPES.shaft(this, t);
  }

  /**
   * Volumetric garnish for an incoming attack.
   *
   * `Decals` (SDF, ground-conforming) and CombatSystem's HitFeel both already
   * draw the flat telegraph off these same events. What neither draws is the
   * *air* above it: motes lifting off the boundary of the shape, colour-matched
   * to the danger, staggered across the windup so the read builds. That is what
   * this adds. If nobody else owns the ground read, a quad is drawn here as the
   * fallback so the telegraph still exists.
   */
  _onTelegraph(tg, phase) {
    if (!tg) return;
    const uid = tg.uid;

    if (phase === 'end') {
      const key = this._tg.get(uid);
      if (key !== undefined) { this.groundFX?.kill(key, this.now); this._tg.delete(uid); }
      return;
    }
    if (phase === 'update') {
      const key = this._tg.get(uid);
      if (key === undefined) return;
      this.groundFX?.update(key, {
        x: tg.x, y: tg.y, z: tg.z, yaw: tg.yaw,
        progress: clamp(num(tg.progress, 0), 0.02, 1),
      }, this.now);
      return;
    }

    /* --- begin --- */
    const colour = toColour(tg.color, this._tgCol) ?? PALETTE.ember;
    const dur = clamp(num(tg.duration, 0.6), 0.15, 3.0);
    const shape = String(tg.shape ?? 'circle');
    const cx = num(tg.x, 0), cz = num(tg.z, 0);
    const gy = num(tg.y, this.groundYAt(cx, cz));
    const yaw = num(tg.yaw, 0);

    let g = GSHAPE.DISC, hx = 1.5, hz = 1.5, inner = 0.6, angle = 0.7;
    let ox = 0, oz = 0;
    if (shape === 'cone') {
      g = GSHAPE.CONE;
      hx = hz = Math.max(0.6, num(tg.length, num(tg.radius, 3)));
      angle = clamp(num(tg.angle, 1.3) * 0.5, 0.08, Math.PI);
    } else if (shape === 'line' || shape === 'lane' || shape === 'rect') {
      g = GSHAPE.RECT;
      hx = Math.max(0.5, num(tg.length, 6) * 0.5);
      hz = Math.max(0.25, num(tg.width, 1.6) * 0.5);
      // An AI lane starts at the caster; the quad is centred, so push it forward.
      ox = Math.cos(yaw) * hx;
      oz = Math.sin(yaw) * hx;
    } else if (shape === 'ring') {
      g = GSHAPE.RING;
      hx = hz = Math.max(0.6, num(tg.radius, 4));
      inner = clamp(num(tg.inner, hx * 0.55) / hx, 0.05, 0.95);
    } else {
      hx = hz = Math.max(0.6, num(tg.radius, num(tg.length, 2.5)));
    }

    /* --- the air above the read --- */
    const rnd = this.rnd;
    const s = this.s;
    const n = Math.round(clamp(6 + hx * 2.2, 6, 22) * this.density);
    for (let i = 0; i < n; i++) {
      let px, pz;
      if (g === GSHAPE.RECT) {
        const t = rnd() * 2 - 1;
        const side = rnd.sign();
        const lx = t * hx, lz = side * hz;
        px = cx + ox + lx * Math.cos(yaw) - lz * Math.sin(yaw);
        pz = cz + oz + lx * Math.sin(yaw) + lz * Math.cos(yaw);
      } else if (g === GSHAPE.CONE) {
        const a = yaw + rnd.range(-angle, angle);
        const r = hx * (0.55 + rnd() * 0.45);
        px = cx + Math.cos(a) * r;
        pz = cz + Math.sin(a) * r;
      } else {
        const a = rnd() * Math.PI * 2;
        const r = hx * (g === GSHAPE.RING ? rnd.range(inner, 1) : rnd.range(0.72, 1.0));
        px = cx + Math.cos(a) * r;
        pz = cz + Math.sin(a) * r;
      }
      s.reset();
      s.at(px, gy + 0.04, pz);
      s.vel(rnd.gauss(0, 0.1), rnd.range(0.5, 1.5), rnd.gauss(0, 0.1));
      s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
      s.delay = rnd() * dur * 0.85;
      s.life = rnd.range(0.35, 0.8);
      const w = rnd.range(0.05, 0.11);
      s.size(w, w * 0.4);
      s.drag = 0.6;
      s.swayAmp = rnd.range(0.03, 0.14); s.swayFreq = rnd.range(0.9, 2.1);
      s.soft = 0.22;
      s.colorA(colour, 1.05, 0.8);
      s.colorB(colour, 0.35, 0.0);
      s.seed = rnd();
      this.glow();
    }

    /* --- fallback ground read, only when nobody else owns one --- */
    if (this._telegraphsOwned() || !this.groundFX) return;
    const key = `tg${uid}`;
    this.groundFX.add({
      x: cx + ox, z: cz + oz, y: gy,
      shape: g, halfX: hx, halfZ: hz, yaw,
      life: dur + 0.22,
      colour: this._tgDim.copy(colour).multiplyScalar(0.22), opacity: 0.42,
      rim: colour, rimGain: 0.95, rimIntensity: 1.35,
      inner, angle,
      soft: 0.14,
      progress: 0.03,
      seed: rnd(),
      fadeIn: 0.08, fadeOut: 0.18,
      lift: 0.03,
      key,
    }, this.now);
    this._tg.set(uid, key);
  }

  _addFixture(position, weight) {
    if (!position) return;
    const x = Array.isArray(position) ? position[0] : position.x;
    const y = Array.isArray(position) ? position[1] : position.y;
    const z = Array.isArray(position) ? position[2] : position.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (this._fixtures.length >= 96) return;
    for (let i = 0; i < this._fixtures.length; i++) {
      const f = this._fixtures[i];
      if (Math.abs(f.x - x) < 0.4 && Math.abs(f.y - y) < 0.4 && Math.abs(f.z - z) < 0.4) return;
    }
    this._fixtures.push({ x, y, z, w: weight ?? 1 });
  }

  /* ------------------------------------------------------------------ */
  /*  ground helper for the public spawn() shapes                        */
  /* ------------------------------------------------------------------ */

  _groundShape(kind, o, t) {
    const colour = t.colour ?? PALETTE.ember;
    const radius = num(o.radius, t.scale * 2);
    const map = { ring: GSHAPE.RING, cone: GSHAPE.CONE, puddle: GSHAPE.STAIN, glyph: GSHAPE.GLYPH };
    this.groundFX?.add({
      x: t.x, z: t.z, y: t.groundY,
      shape: map[kind] ?? GSHAPE.DISC,
      halfX: radius, halfZ: num(o.halfZ, radius),
      yaw: num(o.yaw, 0),
      life: num(o.life, kind === 'puddle' ? 7 : 1.2),
      colour: colour.clone().multiplyScalar(kind === 'puddle' ? 0.3 : 0.22),
      opacity: num(o.opacity, 0.45),
      rim: colour, rimGain: num(o.rimGain, 0.9), rimIntensity: 1.25,
      inner: num(o.inner, 0.62),
      angle: clamp(num(o.angle, 1.3) * 0.5, 0.08, Math.PI),
      soft: 0.16,
      progress: num(o.progress, 0),
      seed: this.rnd(),
      fadeIn: 0.06, fadeOut: 0.3,
      key: o.key,
    }, this.now);
  }

  /* ------------------------------------------------------------------ */
  /*  per-frame                                                          */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (this.__dead || !this.enabled) return;

    this.now += dt;
    if (this.now > this._rebaseAt) {
      const delta = this._rebaseAt * 0.5;
      this.now -= delta;
      this.add.rebase(delta);
      this.softBatch.rebase(delta);
      this.groundFX.rebase(delta);
      this.bolts.clear();
    }

    this._syncFrame();
    this._flushPendingDecals();
    this._updateFlashes(dt);
    this._updateHeat(dt);
    this._updateAmbient(dt);
    this._updateAttachments(dt);
    this._updateHeroTrail(dt);
    this._updateScreen(dt);

    this.trails.build();
    this.bolts.flush(this.now, this._pxScale ?? 0.002);
    this.groundFX.flush(this.now);
    this.add.flush(this.now);
    this.softBatch.flush(this.now);

    /*
     * Screen-region radiance budget, AFTER flush so it sees this frame's spawns.
     *
     * `_syncRadianceCeiling` bounds what one additive sprite may write; nothing
     * bounded what N of them sum to, and a `fireburst` emits 14-20 blast puffs
     * from one point. Measured on the frozen `night` frame: five additive
     * sprites over the worst pixel summing to 2.07 scene-linear against a 0.838
     * bloom threshold. This holds the sum in every 10 px tile at the ceiling
     * instead. Only the additive batch needs it — an alpha-blended puff
     * composites toward its own colour and cannot run away.
     */
    this.add.applyCrowdCap(
      this.engine.camera,
      this._size.x || this.engine.width || 1600,
      this._size.y || this.engine.height || 900,
      this.maxRadiance
    );
  }

  /** Depth prepass, fog, key light and projection scale — once per frame. */
  _syncFrame() {
    const engine = this.engine;
    const cam = engine.camera;

    const rp = engine.renderPipeline;
    let depth = null;
    if (rp && !rp.__dead && rp.gbuffer && typeof rp._needsGBuffer === 'function') {
      // Only trust the prepass if the pipeline is actually going to render it
      // this frame; otherwise it holds a stale depth buffer.
      try { if (rp._needsGBuffer()) depth = rp.gbuffer.depthTexture; } catch { depth = null; }
    }

    const size = engine.renderer.getDrawingBufferSize(this._size);
    const invX = 1 / Math.max(1, size.x);
    const invY = 1 / Math.max(1, size.y);
    const near = cam.near, far = cam.far;

    // World metres per pixel at 1 m of depth — used to clamp sub-pixel sprites.
    const px = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, size.y);
    this._pxScale = px;

    for (const b of [this.add, this.softBatch]) {
      const u = b.uniforms;
      u.uDepth.value = depth ?? this.masks;
      u.uSoftOn.value = depth ? 1 : 0;
      u.uInvRes.value.set(invX, invY);
      u.uClip.value.set(near, far);
      u.uPxScale.value = px;
      u.uMinPx.value = 2.4;
    }
    this.groundFX.setDepth(depth, invX, invY, near, far);
    this.bolts.setDepth(depth, invX, invY, near, far);
    this.trails.setDepth(depth, invX, invY, near, far);

    /* --- fog: particles must sit in the same air as the world --- */
    const fog = engine.scene.fog;
    const fp = this.add.uniforms.uFogParam.value;
    const fc = this.add.uniforms.uFogColor.value;
    if (fog) {
      if (fog.isFogExp2) fp.set(fog.density, 0, 1);
      else fp.set(fog.near, fog.far, 0);
      fc.copy(fog.color);
    } else {
      fp.set(1e6, 2e6, 0);
    }
    this.softBatch.uniforms.uFogParam.value.copy(fp);
    this.softBatch.uniforms.uFogColor.value.copy(fc);

    /* --- additive radiance ceiling, re-derived from the live exposure --- */
    this._syncRadianceCeiling();

    /* --- key light for the form-lit (smoke) batch --- */
    const lighting = engine.get('lighting');
    const sun = lighting && !lighting.__dead ? lighting.sun : null;
    if (sun && sun.enabled && sun.intensity > 0.02) {
      this._key.copy(sun.dir).multiplyScalar(-1);
      this._keyCol.copy(sun.color).multiplyScalar(clamp(0.35 + sun.intensity * 0.16, 0.3, 1.15));
    } else {
      // Sunless interior: light the smoke from above with the practicals' hue,
      // which is what actually illuminates a crypt.
      this._key.set(0.35, 0.86, 0.38).normalize();
      const warm = lighting?.practicals?.length
        ? lighting.practicals[0].coolColor
        : null;
      if (warm) this._keyCol.copy(warm).multiplyScalar(0.86);
      else this._keyCol.setRGB(0.95, 0.72, 0.46);
    }
    if (this._key.lengthSq() < 1e-6) this._key.set(0, 1, 0);
    this._v0.copy(this._key).transformDirection(cam.matrixWorldInverse);
    const su = this.softBatch.uniforms;
    su.uKeyDir.value.copy(this._v0);
    su.uKeyCol.value.copy(this._keyCol);
    su.uAmbCol.value.copy(this._ambCol);
  }

  /**
   * The one number that keeps additive VFX off the clip point.
   *
   * The pipeline renders the scene into a half-float buffer, multiplies it by
   * an auto-exposure gain, blooms it, and only then runs ACES. Nothing a
   * material writes is tonemapped at write time (three disables the tonemap
   * chunk whenever a render target is bound), so an author writing "2.4
   * emissive" is really writing 2.4 * gain into the tonemapper — 6.5 in a
   * torchlit crypt, which ACES pins at 1.0 on all three channels. That is the
   * mechanism behind every clipped white VFX blob in this project.
   *
   * ACES maps a post-exposure linear value of ~1.55 to ~0.85 output (solving
   * RRTAndODTFit(1.55 / 0.6) = 0.85). So the scene-linear ceiling one additive
   * sprite may write is 1.55 / gain, and it is a different number in every
   * scenario. Published to the shader as `uMaxRad`, and to `this.maxRadiance`
   * so recipes can author against it.
   *
   * Deliberately the WORST-CASE gain the pipeline publishes rather than a
   * measured frame value: capping slightly dark is invisible, capping slightly
   * bright is a clipped highlight, and the whole point is that it can never
   * clip.
   */
  _syncRadianceCeiling() {
    /* 1.55 post-exposure linear == ~0.85 after ACES. */
    const TONEMAP_085 = 1.55;
    const gain = Math.max(1, num(this.engine.exposureGain, 1.85));
    // Floor at 0.30 so a hypothetical 5x gain still leaves a usable hot core,
    // and ceil at 1.6 so a gain of 1 does not licence an unbounded emissive.
    const cap = clamp(TONEMAP_085 / gain, 0.30, 1.60);
    this.maxRadiance = cap;
    if (this.add) this.add.uniforms.uMaxRad.value = cap;
    // Written to the alpha batch too so the uniform is never stale if a batch
    // is ever reconfigured to blend additively.
    if (this.softBatch) this.softBatch.uniforms.uMaxRad.value = cap;
    this.bolts?.setMaxRadiance?.(cap);
  }

  _updateFlashes(dt) {
    for (let i = 0; i < this._flashes.length; i++) {
      const f = this._flashes[i];
      if (!f.active) continue;
      f.t += dt;
      const u = f.t / f.dur;
      if (u >= 1) {
        f.active = false;
        f.light.intensity = 0;
        f.light.position.y = -1000;
        continue;
      }
      // Instant on, fast exponential out — the shape of a real impact flash.
      f.light.intensity = f.peak * Math.exp(-u * 4.6) * (1 - u * u);
    }
  }

  _updateHeat(dt) {
    const cam = this.engine.camera;
    const list = this._heat;
    const screen = this.screen;
    if (!screen) return;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      h.t += dt;
      if (h.t >= h.dur) { list.splice(i, 1); continue; }
    }
    // Project the strongest few into screen space for the refraction pass.
    list.sort(byStrength);
    const uni = screen.uniforms.uHeat.value;
    for (let i = 0; i < list.length && n < uni.length; i++) {
      const h = list[i];
      this._v0.set(h.x, h.y, h.z).project(cam);
      if (this._v0.z > 1 || this._v0.z < -1) continue;
      const sx = this._v0.x * 0.5 + 0.5;
      const sy = this._v0.y * 0.5 + 0.5;
      if (sx < -0.3 || sx > 1.3 || sy < -0.3 || sy > 1.3) continue;
      const d = Math.max(1, this._v1.set(h.x, h.y, h.z).distanceTo(cam.position));
      const r = clamp((h.radius / d) * 1.6, 0.02, 0.6);
      const fade = 1 - h.t / h.dur;
      uni[n].set(sx, sy, r, h.strength * fade);
      n++;
    }
    screen.heatCount = n;
  }

  _updateAmbient(dt) {
    const amb = this.ambient;
    if (!amb) return;
    const cam = this.engine.camera;
    const rnd = this.rnd;

    /* --- focus point: where the action is, not where the lens is --- */
    const rig = this.engine.get('camera');
    const hero = this.engine.get('hero');
    if (rig && rig.focus?.isVector3) this._focus.copy(rig.focus);
    else if (hero?.position) this._focus.copy(hero.position);
    else this._focus.set(0, 0, 0);

    /* --- floating particulate: soft, dim, and it never becomes a dot --- */
    this._moteAcc += dt * amb.motes * this.density;
    let guard = 0;
    while (this._moteAcc >= 1 && guard++ < 6) {
      this._moteAcc -= 1;
      const t = this._opts;
      const r = 3 + rnd() * 15;
      const a = rnd() * Math.PI * 2;
      t.x = this._focus.x + Math.cos(a) * r;
      t.z = this._focus.z + Math.sin(a) * r;
      t.groundY = this.groundYAt(t.x, t.z);
      t.y = t.groundY + 0.25 + rnd() * 3.6;
      t.colour = amb.colour;
      t.intensity = amb.intensity;
      RECIPES.motes(this, t);
    }

    /* --- embers off the nearest fixtures --- */
    if (this._fixtures.length === 0 && this.engine.clock.frame - this._fixtureScanAt > 90) {
      this._fixtureScanAt = this.engine.clock.frame;
      this._scanFixtures();
    }
    if (this._fixtures.length) {
      this._emberAcc += dt * amb.embers * this.density * Math.min(8, this._fixtures.length);
      guard = 0;
      while (this._emberAcc >= 1 && guard++ < 8) {
        this._emberAcc -= 1;
        // Bias toward fixtures near the action so offscreen braziers cost nothing.
        let best = null, bestD = Infinity;
        const probe = 3;
        for (let k = 0; k < probe; k++) {
          const f = this._fixtures[Math.floor(rnd() * this._fixtures.length) % this._fixtures.length];
          const d = (f.x - this._focus.x) ** 2 + (f.z - this._focus.z) ** 2;
          if (d < bestD) { bestD = d; best = f; }
        }
        if (!best || bestD > 40 * 40) continue;
        const t = this._opts;
        t.x = best.x; t.y = best.y + 0.06; t.z = best.z;
        RECIPES.emberDrift(this, t);
      }
    }
  }

  /** Adopt whatever practical lights exist as ember sources. */
  _scanFixtures() {
    const lighting = this.engine.get('lighting');
    const list = lighting?.practicals;
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.kind !== 'point') continue;
      const type = String(p.type ?? 'torch');
      if (type === 'magic' || type === 'shaft' || type === 'moon') continue;
      this._addFixture(p.basePosition, 1);
    }
  }

  _updateAttachments(dt) {
    const list = this._attach;
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i];
      const obj = h.obj;
      if (!obj || !obj.parent) { this.detach(h); continue; }
      obj.updateWorldMatrix(true, false);
      this._v0.setFromMatrixPosition(obj.matrixWorld).add(h.offset);

      if (h.kind === 'trail') {
        if (!h.ribbon) { this.detach(h); continue; }
        this._v1.copy(h.hilt).applyMatrix4(obj.matrixWorld);
        this._v2.copy(h.tip).applyMatrix4(obj.matrixWorld);
        h.ribbon.push(this._v1, this._v2);
        continue;
      }

      h.acc += dt * h.rate * this.density;
      let guard = 0;
      while (h.acc >= 1 && guard++ < 8) {
        h.acc -= 1;
        const t = this._opts;
        t.x = this._v0.x; t.y = this._v0.y; t.z = this._v0.z;
        t.groundY = this.groundYAt(t.x, t.z);
        t.scale = h.scale;
        t.intensity = h.intensity;
        t.colour = h.colour;
        t.nx = 0; t.ny = 1; t.nz = 0;
        if (h.kind === 'embers') RECIPES.emberDrift(this, t);
        else if (h.kind === 'fire') this._attachFire(t);
        else if (h.kind === 'frost') this._attachFrost(t);
        else if (h.kind === 'necrotic') this._attachNecro(t);
        else RECIPES.motes(this, t);
      }
    }
  }

  /** A single continuous flame lick + ember, not a whole burst per tick. */
  _attachFire(t) {
    const rnd = this.rnd;
    const s = this.s;
    const sc = t.scale;
    const a = rnd() * Math.PI * 2, r = rnd() * 0.18 * sc;
    s.reset();
    s.at(t.x + Math.cos(a) * r, t.y, t.z + Math.sin(a) * r);
    s.vel(Math.cos(a) * 0.2, rnd.range(1.2, 2.8) * sc, Math.sin(a) * 0.2);
    s.shape = SHAPE.FLAME; s.align = ALIGN.UPRIGHT;
    s.life = rnd.range(0.22, 0.44);
    const hgt = rnd.range(0.30, 0.52) * sc;
    s.size(hgt, hgt * 0.42);
    s.aspect = rnd.range(0.38, 0.56);
    s.sizeCurve = 1.4;
    s.drag = 1.8;
    s.swayAmp = rnd.range(0.03, 0.11) * sc; s.swayFreq = rnd.range(2.6, 5.4);
    s.soft = 0.3;
    s.colorA(PALETTE.flameCore, 1.15 * t.intensity, 0.42);
    s.colorB(PALETTE.flameOuter, 0.55 * t.intensity, 0.0);
    s.seed = rnd();
    this.glow();
    if (rnd() < 0.4) RECIPES.emberDrift(this, t);
    if (rnd() < 0.25) this.heat(t.x, t.y + 0.5 * sc, t.z, 1.2 * sc, 0.7, 0.4);
  }

  _attachFrost(t) {
    const rnd = this.rnd;
    const s = this.s;
    const sc = t.scale;
    const a = rnd() * Math.PI * 2, r = rnd() * 0.22 * sc;
    s.reset();
    s.at(t.x + Math.cos(a) * r, t.y + rnd.range(-0.1, 0.3), t.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.14), rnd.range(-0.25, 0.3), rnd.gauss(0, 0.14));
    s.shape = rnd() < 0.35 ? SHAPE.STAR : SHAPE.SHARD;
    s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.4, 1.0);
    const w = rnd.range(0.05, 0.13) * sc;
    s.size(w, w * 0.5);
    s.drag = 1.1;
    s.gravity = 1.4;
    s.rot = rnd() * Math.PI * 2; s.rotVel = rnd.gauss(0, 3);
    s.soft = 0.22;
    s.colorA(t.colour ?? PALETTE.frost, 1.05, 0.8);
    s.colorB(PALETTE.frostDeep, 0.4, 0.0);
    s.seed = rnd();
    this.glow();
  }

  _attachNecro(t) {
    const rnd = this.rnd;
    const s = this.s;
    const sc = t.scale;
    const a = rnd() * Math.PI * 2, r = rnd() * 0.3 * sc;
    s.reset();
    s.at(t.x + Math.cos(a) * r, t.y + rnd.range(-0.2, 0.4), t.z + Math.sin(a) * r);
    s.vel(rnd.gauss(0, 0.12), rnd.range(0.35, 1.2), rnd.gauss(0, 0.12));
    s.shape = rnd() < 0.5 ? SHAPE.MOTE : SHAPE.WISP;
    s.align = ALIGN.CAMERA;
    s.life = rnd.range(0.8, 1.9);
    const w = rnd.range(0.05, 0.14) * sc;
    s.size(w, w * 0.45);
    s.drag = 0.6;
    s.swayAmp = rnd.range(0.08, 0.3); s.swayFreq = rnd.range(0.7, 1.8);
    s.soft = 0.25;
    s.colorA(t.colour ?? PALETTE.necro, 0.9, 0.75);
    s.colorB(PALETTE.necroDark, 0.4, 0.0);
    s.seed = rnd();
    this.glow();
  }

  /* --------------------------------------------------------- hero trail */

  _setupHeroTrail() {
    const hero = this.engine.get('hero');
    if (!hero || hero.__dead || hero.failed) { this._heroTrail = null; return; }
    if (this._heroTrail) this.trails?.release(this._heroTrail);
    this._heroTrail = this.trails?.acquire({
      color: 0xbcd4ff, taper: 0.62, maxStep: 0.28,
    }) ?? null;
    this._tipHas = false;
    this._trailGain = 0;
  }

  /**
   * Drive the ribbon off the hero's actual weapon transform, gated on measured
   * tip speed. Speed-gating matters: the wind-up and recovery of a swing are
   * slow, and ribboning those produces a huge stationary sheet of light instead
   * of a smear. The trail exists only across the fast part of the arc, which is
   * the only place a real motion blur would be.
   */
  _updateHeroTrail(dt) {
    const rb = this._heroTrail;
    if (!rb) {
      if (this.engine.get('hero') && this.trails) this._setupHeroTrail();
      return;
    }
    const hero = this.engine.get('hero');
    if (!hero || hero.__dead) { rb.gain = 0; return; }

    const tip = this._v1, hilt = this._v2;
    let ok = false;
    try {
      if (typeof hero._weaponWorld === 'function') {
        hero._weaponWorld(tip, hilt);
        ok = true;
      } else if (typeof hero.weaponTip === 'function') {
        hero.weaponTip(tip);
        const p = hero.position;
        if (p) { hilt.set(p.x, p.y + 1.25, p.z); ok = true; }
      }
    } catch { ok = false; }
    if (!ok || !Number.isFinite(tip.x)) { rb.gain = 0; return; }

    let speed = 0;
    if (this._tipHas) speed = this._tipPrev.distanceTo(tip) / Math.max(1e-4, dt);
    else this._tipHas = true;
    this._tipPrev.copy(tip);

    const state = String(hero.state ?? '');
    const swinging = state === 'attack' || state === 'heavy' || state === 'cast';
    const want = swinging ? smoothstep(6.5, 19, speed) : 0;
    this._trailGain = want > this._trailGain
      ? Math.min(want, this._trailGain + dt * 15)
      : Math.max(want, this._trailGain - dt * 5.0);

    rb.gain = this._trailGain * 0.62;
    if (rb.gain > 0.01) rb.push(hilt, tip);
    else rb.reset();

    /* Sparks shed off the blade at the top of the swing — the layer that makes
       a trail read as steel moving through air rather than as a glow card. */
    if (this._trailGain > 0.55 && speed > 12) {
      const rnd = this.rnd;
      const n = rnd() < 0.6 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const s = this.s;
        const f = rnd.range(0.55, 1.0);
        s.reset();
        s.at(hilt.x + (tip.x - hilt.x) * f, hilt.y + (tip.y - hilt.y) * f, hilt.z + (tip.z - hilt.z) * f);
        s.vel(rnd.gauss(0, 1.2), rnd.range(0.2, 1.4), rnd.gauss(0, 1.2));
        s.shape = SHAPE.MOTE; s.align = ALIGN.CAMERA;
        s.life = rnd.range(0.12, 0.3);
        const w = rnd.range(0.025, 0.05);
        s.size(w, w * 0.4);
        s.drag = 2.4;
        s.gravity = 4;
        s.soft = 0.18;
        s.colorA(PALETTE.arc, 1.15, 0.85);
        s.colorB(PALETTE.arcMid, 0.4, 0.0);
        s.seed = rnd();
        this.glow();
      }
    }
  }

  /* -------------------------------------------------------- screen pass */

  _updateScreen(dt) {
    const screen = this.screen;
    if (!screen) return;

    /* chromatic pulse — decays fast, then hands the pipeline value back */
    if (this._ca > 0.0002) this._ca *= Math.exp(-dt * 7.5);
    else this._ca = 0;
    screen.ca = this._ca * 0.010;

    // Nudge the pipeline's own CA at the same time so the pulse reads even when
    // the overlay pass is unavailable. Guarded, and always restored.
    const rp = this.engine.renderPipeline;
    if (rp && !rp.__dead && rp.params) {
      if (this._ca > 0) {
        if (this._caBase === null) this._caBase = rp.params.chromatic;
        rp.params.chromatic = this._caBase + this._ca * 0.0022;
      } else if (this._caBase !== null) {
        rp.params.chromatic = this._caBase;
        this._caBase = null;
      }
    }

    /* low-health blood vignette */
    const hero = this.engine.get('hero');
    let frac = 1;
    const st = hero?.stats;
    if (st && Number.isFinite(st.health) && Number.isFinite(st.maxHealth) && st.maxHealth > 0) {
      frac = clamp(st.health / st.maxHealth, 0, 1);
    }
    if (hero?.isDead) frac = 0;
    // Only below 45 %, and it tops out well short of opaque.
    const want = smoothstep(0.45, 0.10, frac) * 0.72
      + (this._hitFlash > 0 ? this._hitFlash * 0.35 : 0);
    this._hitFlash = Math.max(0, (this._hitFlash ?? 0) - dt * 2.6);
    this._blood += (Math.min(0.95, want) - this._blood) * Math.min(1, dt * 6);
    screen.blood = this._blood;
    screen.uniforms.uTime.value = this.now;
  }

  _restoreCA() {
    const rp = this.engine.renderPipeline;
    if (rp && !rp.__dead && rp.params && this._caBase !== null) {
      rp.params.chromatic = this._caBase;
      this._caBase = null;
    }
  }

  /** Diagnostics for the profiler / debug overlay. */
  stats() {
    return {
      add: this.add?.live ?? 0,
      soft: this.softBatch?.live ?? 0,
      ground: this.groundFX?.live ?? 0,
      bolts: this.bolts?.live ?? 0,
      spawned: (this.add?.spawned ?? 0) + (this.softBatch?.spawned ?? 0),
      recycled: (this.add?.dropped ?? 0) + (this.softBatch?.dropped ?? 0),
      drawCalls: 5,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const byStrength = (a, b) => b.strength * (1 - b.t / b.dur) - a.strength * (1 - a.t / a.dur);

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Read a {x,y,z} or Vector3 into three named fields of a target object. */
function readVec(v, out, kx, ky, kz, dx = 0, dy = 0, dz = 0) {
  out[kx] = num(v?.x, dx);
  out[ky] = num(v?.y, dy);
  out[kz] = num(v?.z, dz);
}

/**
 * Read an optional swing axis into (ax,ay,az), clearing it when absent.
 *
 * The melee impact recipe smears its hot core along the arc of the blow. A
 * caster that knows the real blade direction can hand it over as `swing`; when
 * nobody does, the recipe derives the arc from the surface tangent. Either way
 * these three fields MUST be cleared, because `_opts` is one reused object and a
 * value left by a previous `spawn({ax:...})` would steer an unrelated hit.
 */
function readSwing(p, out) {
  out.ax = undefined; out.ay = undefined; out.az = undefined;
  const s = p?.swing ?? p?.arc ?? null;
  if (!s) return;
  const x = num(s.x, NaN), z = num(s.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  out.ax = x; out.ay = num(s.y, 0); out.az = z;
}

function toColour(c, into) {
  if (c === undefined || c === null) return null;
  try {
    if (c.isColor) return into.copy(c);
    return into.set(c);
  } catch {
    return null;
  }
}

/**
 * What element an ability reads as. Keyed off the ability id and the damage
 * type, deliberately conservative: an unmatched ability falls back to a steel
 * impact rather than inventing a colour the art direction did not ask for.
 */
function elementOf(id, extra) {
  const s = `${id ?? ''} ${extra ?? ''}`.toLowerCase();
  if (/fire|flame|burn|hell|meteor|magma|lava|pyro|cinder|scorch/.test(s)) return 'fire';
  if (/frost|ice|chill|freeze|cold|rime|glaci/.test(s)) return 'frost';
  if (/lightning|shock|thunder|storm|spark|galvan|arcflash/.test(s)) return 'lightning';
  if (/necro|poison|plague|blight|rot|acid|toxic|disgorge|unquiet|brand|carrion|bone/.test(s)) return 'necrotic';
  if (/arcane|void|shadow|spirit|astral|rune/.test(s)) return 'arcane';
  return null;
}

/**
 * What a thing bleeds. The crypt is full of undead: red arterial spray coming
 * off a skeleton is the kind of detail that reads as a bug.
 */
function fluidOf(entity) {
  if (!entity) return 'blood';
  const d = entity.def ?? entity.species ?? null;
  const s = `${d?.id ?? ''} ${d?.label ?? ''} ${d?.family ?? ''} ${d?.kind ?? ''}`.toLowerCase();
  if (!s.trim()) return 'blood';
  if (/skele|bone|slinger|wraith|spectre|specter|ghost/.test(s)) return 'none';
  if (/risen|undead|ghoul|revenant|lich|warden|zombie/.test(s)) return 'ichor';
  return 'blood';
}

/** Rarity colours, D4 order: white, blue, yellow, orange, red. */
function rarityColour(item, into) {
  const r = String(item?.rarity ?? item?.tier ?? '').toLowerCase();
  const map = {
    common: 0xd8d4cc, normal: 0xd8d4cc, white: 0xd8d4cc,
    magic: 0x6f9be0, rare: 0x6f9be0, blue: 0x6f9be0,
    legendary: 0xe6b455, yellow: 0xe6b455,
    unique: 0xd9762c, orange: 0xd9762c,
    mythic: 0xc0392b, set: 0xc0392b, red: 0xc0392b,
  };
  const hex = map[r] ?? 0xe6c07a;
  return into.setHex(hex);
}
