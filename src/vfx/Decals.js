/**
 * THE NINTH VIGIL — Decals.
 *
 * The layer that makes a fight leave a mark on the world: blood, scorch, rime,
 * craters, footprints, ritual sigils, and the gameplay-critical ground
 * telegraphs.
 *
 * ARCHITECTURE / COST
 * -------------------
 *   4 draw calls total, 2 texture units, 1 program for every stain in the level
 *   + 1 program for telegraphs + 1 for contact shadows.
 *
 *   • `stainGround`   1 draw call — 200 slots of ground-conforming patch geometry
 *   • `stainProjected` 1 draw call — 40 slots of DecalGeometry-projected decals
 *   • `telegraphs`    1 draw call — 14 slots of analytic-SDF ground indicators
 *   • `contact`       1 draw call — 96 slots of grounding shadow under every
 *                     character and prop in frame (zero textures, see below)
 *
 *   Both stain batches share ONE MeshStandardMaterial (so one program, two
 *   textures: an albedo+coverage atlas and a packed normal/roughness/mask atlas).
 *   Telegraphs are fully procedural in the fragment shader — zero textures, and
 *   crisp at any distance because the edges come from an SDF with `fwidth`
 *   antialiasing rather than from a bitmap.
 *
 *   Peak triangles: 200 x <=242 + 40 x 64 + 14 x 800 ~= 62k worst case, and in
 *   practice ~14k, against a 3.5 M budget.
 *
 * AGEING
 * ------
 *   Every decal carries its birth stamp in a vertex attribute; drying, ember
 *   cooling, frost sublimation, pool spreading, rune breathing and lifetime
 *   fade-out are all evaluated in the shader from one `uTime` uniform. Ageing
 *   240 decals therefore costs ZERO CPU per frame — the only per-frame work is
 *   retiring expired slots.
 *
 * BUDGET
 * ------
 *   Fixed pool, FIFO eviction, and eviction is a 0.45 s fade-out triggered from
 *   a watermark well below capacity, so decals are never popped off screen.
 *
 * DETERMINISM
 * -----------
 *   Splatter layout, size jitter and orientation come from `engine.freshRand`
 *   seeded off the event (position + kind + event ordinal). No Math.random, no
 *   Date.now. Same scenario + same frame count = same pixels.
 */
import * as THREE from 'three';
import { buildDecalAtlas } from './decals/Atlas.js';
import { DecalBatch } from './decals/Batch.js';
import { makeStainMaterial } from './decals/StainMaterial.js';
import { Surface } from './decals/Surface.js';
import { TelegraphField } from './decals/Telegraph.js';
import { DECAL_TYPES, IMPACT_MAP, DAMAGE_MAP, CLS } from './decals/Types.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/*
 * CONTACT SHADOWS — the grounding layer, and why it is a separate thing.
 * ---------------------------------------------------------------------
 * Screen-space occlusion cannot ground a character on its own. Even after
 * AOApplyPass stopped throwing its contact term away inside light pools, a
 * short-radius SSAO term is a 5-20 cm seam derived from a depth buffer: it is
 * physically the right answer and visually far too little where the eye actually
 * looks — under a boot, at the base of a rubble slab, where a building meets the
 * street. And it cannot see anything the depth buffer does not contain.
 *
 * So this layer draws the occlusion explicitly, as geometry, in the beauty pass:
 * one ground-conforming patch under every character and every prop in frame,
 * multiplied into the floor (NormalBlending over black is a straight
 * `dst * (1 - a)`, so it can only ever REMOVE light — it can never lift blacks or
 * wash the frame grey), then AO, exposure and the grade all run on top of it.
 * Because it is scene geometry it survives every light in the scene, which is the
 * whole point: a bright point light no longer overwrites the grounding.
 *
 * MEASURED BEFORE THIS EXISTED (`closeup`, 1600x900): hiding the hero's own
 * contact quad AND the prop blob mesh changed the floor luma beside the sole by
 * <= 0.006 — i.e. both existing layers were, in pixels, doing nothing. Their
 * lobes are 0.155 m Gaussians (~12 px at the 28 m gameplay camera) and they sit
 * on the ANALYTIC ground height, which around rubble disagrees with the rendered
 * surface by up to 0.4 m, so they are alternately sub-pixel and buried. This
 * layer instead sizes lobes off the anchor's real footprint and conforms to the
 * surface the decal raycaster actually found.
 *
 * COST: one draw call, zero textures, one program. 25 verts per slot, rebuilt
 * only when its anchor leaves the patch it was built for (a walking hero rebuilds
 * ~20x/second, a prop exactly once), so the steady-state per-frame work is
 * writing four vec4s for the handful of anchors that moved.
 */
const CONTACT_SLOTS = 96;
const CONTACT_RES = 4;                          // 5x5 verts, 32 tris per slot
const CONTACT_VERTS = (CONTACT_RES + 1) * (CONTACT_RES + 1);
const CONTACT_IDX = CONTACT_RES * CONTACT_RES * 6;
/** Patch margin around the anchor footprint, metres — also the rebuild slack. */
const CONTACT_SLACK = 0.7;
/** Deepest darkening any single contact patch may reach (floor keeps 1 - this). */
const CONTACT_CAP = 0.80;
/** Geometry rebuilds allowed per frame across the whole layer. */
const CONTACT_REBUILDS = 5;
/**
 * Lift above the footing, metres. Deliberately small — barely more than a stain's
 * 0.016 — because the depth clearance is bought in VIEW SPACE instead (see
 * CONTACT_ZBIAS and the note in the vertex shader). All this has to do is keep the
 * patch off the coplanar z-fighting knife edge.
 */
const CONTACT_LIFT = 0.022;
/**
 * View-space depth bias, metres toward the camera. This is what actually clears
 * the rendered stone's relief; 0.06 m along the view ray is ~0.10 m of surface
 * height at an ARPG's 50-60 degree grazing angle, which covers the analytic /
 * rendered disagreement with room to spare. Raising it further starts to darken
 * the lower centimetres of the boot and the base of a slab — which reads as
 * occlusion in the crease, so the failure mode is graceful in both directions.
 */
const CONTACT_ZBIAS = 0.06;
/** How often the prop selection is re-sorted, seconds of sim time. */
const CONTACT_PROP_REFRESH = 0.4;

/*
 * SHADOW RECEPTION — why the sigils used to float above the scene.
 * ---------------------------------------------------------------
 * The stain batches were created with `receiveShadow = false` (DecalBatch's
 * default). `THREE.WebGLPrograms` keys `USE_SHADOWMAP` off exactly that flag, so
 * however carefully StainMaterial budgeted for "properly lit, shadowed and
 * fogged", not one sampler was ever compiled in and every decal was lit as if the
 * level had no shadow casters at all.
 *
 * MEASURED on `boss` (1600x900, 240 frames, rect 660,470 280x240). Pixels were
 * binned by how deeply they sit in cast shadow — `luma(no shadow casters) -
 * luma(baseline)` — and the luma the sigil layer ADDS was averaged per bin:
 *
 *     shadow depth   0.00-0.06   0.06-0.14   0.14-0.26   0.26+
 *     sigil adds        0.0786      0.0788      0.0853    0.0758
 *
 * Dead flat. The rune circle put the same light on the floor inside a 0.26-deep
 * cast shadow as it did in full light, which is what the art director saw: the
 * ring drawn straight over the hero's ground shadow, i.e. composited above the
 * scene rather than projected onto the floor.
 *
 * So the batches receive shadows. The cost is samplers, and samplers are the one
 * budget in this project that white-screens the whole game when it is exceeded
 * (KNOWN_ISSUES, texture unit exhaustion) — so it is gated on a live count of the
 * scene's shadow casters plus the material's own maps, with the 2-unit margin
 * KNOWN_ISSUES asks for, and the numbers are logged. If the margin is not there
 * the flag stays off and the decals stay unshadowed rather than the frame going
 * white.
 */
/** Samplers StainMaterial binds regardless: map + normalMap. */
const STAIN_OWN_UNITS = 2;
/** Environment probe + irradiance volume the lit path injects on top. */
const STAIN_ENV_UNITS = 3;
/** Units that must stay free after the stain material is bound. */
const UNIT_MARGIN = 2;
/** Seconds between re-evaluations of the shadow-sampler budget. */
const SHADOW_GATE_PERIOD = 1.5;

/** Slot budgets. 240 stains + 14 telegraphs. */
const GROUND_SLOTS = 200;
const MAX_RES = 11;                       // 12x12 verts, 242 tris per slot
const GROUND_VERTS = (MAX_RES + 1) * (MAX_RES + 1);
const GROUND_IDX = MAX_RES * MAX_RES * 6;
const PROJ_SLOTS = 40;
const PROJ_VERTS = 192;
const PROJ_IDX = 192;

/** Lift above the receiving surface, metres. Sub-pixel at 28 m camera distance. */
const LIFT = 0.016;

export class Decals {
  static id = 'decals';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.__dead = false;

    this.atlas = null;
    this.material = null;
    this.surface = null;
    this.telegraphs = null;
    /** @type {ContactShadows|null} */
    this.contacts = null;
    this.contactMat = null;

    /** @type {{batch:DecalBatch, free:number[]}[]} */
    this._pools = [];
    /** @type {Array<{b:number, slot:number, birth:number, life:number, fadeIn:number, dry:number, evict:boolean, cls:number}>} */
    this._live = [];

    this._uTime = null;
    this._evt = 0;
    this._frameSpawns = 0;
    this._recent = [];          // spatial de-dupe ring
    this._prints = [];          // recent footprint positions
    this._bloodZones = [];      // wet blood a foot can track through
    this._offs = [];
    this._stats = { spawned: 0, evicted: 0, rejected: 0, projected: 0 };
    this._dressed = null;
    this._shadowOn = null;      // tri-state: null = never evaluated
    this._shadowAt = -1e9;
    this._shadowLog = '';
  }

  /* ==================================================================== *
   * lifecycle
   * ==================================================================== */

  async init() {
    try {
      const tier = this.engine.quality?.tier ?? 'ultra';
      const size = tier === 'low' ? 512 : 1024;
      this.atlas = buildDecalAtlas(this.engine, size);
      this.material = makeStainMaterial(this.engine, this.atlas);
      this._uTime = this.material.userData.uTime;
      this.surface = new Surface(this.engine);

      const ground = new DecalBatch(this.material, {
        slots: GROUND_SLOTS, verts: GROUND_VERTS, indices: GROUND_IDX,
        name: 'decals:ground', renderOrder: 4,
      });
      const proj = new DecalBatch(this.material, {
        slots: PROJ_SLOTS, verts: PROJ_VERTS, indices: PROJ_IDX,
        name: 'decals:projected', renderOrder: 5,
      });
      /* Both batches share one material, so both must agree on receiveShadow or
         three compiles the program twice. The flag itself is decided by
         `_gateShadows()` once the lights exist. */
      this._pools = [
        { batch: ground, free: freeList(GROUND_SLOTS) },
        { batch: proj, free: freeList(PROJ_SLOTS) },
      ];
      for (const p of this._pools) {
        for (let i = 0; i < p.batch.slots; i++) p.batch.clearSlot(i);
        p.batch.flush();
        this.engine.scene.add(p.batch.mesh);
      }

      this.telegraphs = new TelegraphField(this.engine, this.surface);
      this.engine.scene.add(this.telegraphs.mesh);

      /* Grounding layer. Built last so it can share the stain material's clock,
         and never allowed to take the rest of the module down with it. */
      try {
        this.contactMat = makeContactShadowMaterial(this._uTime);
        this.contacts = new ContactShadows(this.engine, this.surface, this.contactMat);
        this.engine.scene.add(this.contacts.mesh);
      } catch (e) {
        this.contacts = null;
        console.warn('[decals] contact shadows unavailable —', e?.message ?? e);
      }

      this._wire();
      this._gateShadows(0);

      const cap = this.engine.renderer?.capabilities?.maxTextures ?? 16;
      console.info(
        `[decals] ready — atlas ${size}px x2 (2 texture units of ${cap}), ` +
        `${GROUND_SLOTS}+${PROJ_SLOTS} stain slots, ${this.telegraphs.slots} telegraph slots, ` +
        `${this.contacts ? CONTACT_SLOTS : 0} contact slots, ` +
        `${this.contacts ? 4 : 3} draw calls, ` +
        `stains ${this._shadowOn ? 'receive' : 'do NOT receive'} shadows${this._shadowLog}`);
    } catch (e) {
      this.enabled = false;
      console.error('[decals] disabled —', e);
      throw e;
    }
  }

  _wire() {
    const bus = this.engine.bus;
    const on = (evt, fn) => this._offs.push(bus.on(evt, fn));
    on('impact', (p) => this._onImpact(p));
    on('damage', (p) => this._onDamage(p));
    on('death', (p) => this._onDeath(p));
    on('telegraph:begin', (p) => this.telegraphs?.begin(p));
    on('telegraph:update', (p) => this.telegraphs?.update(p));
    on('telegraph:end', (p) => this.telegraphs?.end(p));
    // Free-form requests from Combat / AI / abilities that are not agent-bound.
    on('decal:telegraph', (p) => this.telegraphs?.begin(p));
    on('telegraph:request', (p) => this.telegraphs?.begin(p));
    on('decal:spawn', (p) => { if (p?.type) this.spawn(p.type, p); });
    on('decal:rune', (p) => this._onRune(p));
    on('decal:clear', () => this.clear());
  }

  applyScenario(name, cfg) {
    if (!this.enabled || this.__dead) return;
    try {
      this.clear();
      this.surface.refresh();
      this.telegraphs?.setBiome(cfg?.env?.biome ?? 'crypt');
      this._dress(name, cfg);
      this._dressed = name;
      // The light rig has just been rebuilt for this scenario; re-decide whether
      // the shadow samplers fit before the first frame is drawn.
      this._shadowAt = -1e9;
      this._gateShadows(this.engine.clock?.elapsed ?? 0);
    } catch (e) {
      console.warn('[decals] scenario dressing failed —', e?.message ?? e);
    }
  }

  /**
   * Decide whether the stain batches may receive shadows, and act on it.
   *
   * A decal that ignores the scene's shadows reads as drawn on top of the frame
   * (see the SHADOW RECEPTION note at the top of this file), so the answer wants
   * to be yes. But `USE_SHADOWMAP` adds one fragment sampler per shadow-casting
   * light to this material, and blowing the 16-unit ceiling does not degrade — it
   * fails to LINK and the whole scene renders flat white. So the flag is derived
   * from a live count rather than assumed, with the margin KNOWN_ISSUES demands,
   * and it is cheap enough to re-check: one scene walk every 1.5 s, and the
   * batches are only touched when the answer actually changes (a `receiveShadow`
   * flip costs one program compile).
   */
  _gateShadows(elapsed) {
    if (!this._pools.length) return;
    if (this._shadowOn !== null && elapsed - this._shadowAt < SHADOW_GATE_PERIOD) return;
    this._shadowAt = elapsed;

    let dir = 0, pt = 0, spot = 0;
    try {
      this.engine.scene.traverse((o) => {
        if (!o.isLight || o.castShadow !== true || o.visible === false) return;
        if (o.isPointLight) pt++;
        else if (o.isSpotLight) spot++;
        else if (o.isDirectionalLight) dir++;
      });
    } catch {
      return;                       // cannot count: leave the flag as it stands
    }

    const cap = this.engine.renderer?.capabilities?.maxTextures ?? 16;
    const need = STAIN_OWN_UNITS + STAIN_ENV_UNITS + dir + pt + spot;
    const want = need + UNIT_MARGIN <= cap;
    this._shadowLog = ` (${need}+${UNIT_MARGIN} of ${cap} units: ` +
      `2 maps, ${STAIN_ENV_UNITS} env, ${dir} dir + ${pt} point + ${spot} spot shadows)`;
    if (want === this._shadowOn) return;

    this._shadowOn = want;
    for (const p of this._pools) {
      const m = p.batch.mesh;
      if (m.receiveShadow === want) continue;
      m.receiveShadow = want;
      // three keys the program off the object flag, so the material has to be
      // told its cached program is stale.
      if (m.material) m.material.needsUpdate = true;
    }
    console.info(`[decals] stain shadow reception ${want ? 'ON' : 'OFF'}${this._shadowLog}`);
  }

  update(dt, elapsed) {
    if (!this.enabled || this.__dead) return;
    this._frameSpawns = 0;
    if (this._uTime) this._uTime.value = elapsed;
    this._gateShadows(elapsed);

    /* retire expired slots */
    const live = this._live;
    for (let i = live.length - 1; i >= 0; i--) {
      const r = live[i];
      if (elapsed - r.birth <= r.life) continue;
      const p = this._pools[r.b];
      p.batch.clearSlot(r.slot);
      p.free.push(r.slot);
      live.splice(i, 1);
    }

    /* pressure: fade the oldest before we can ever run out of slots */
    for (let b = 0; b < this._pools.length; b++) {
      const p = this._pools[b];
      const soft = Math.max(4, Math.floor(p.batch.slots * 0.10));
      if (p.free.length >= soft) continue;
      const need = soft - p.free.length;
      let oldest = null;
      for (let n = 0; n < need; n++) {
        oldest = null;
        for (let i = 0; i < live.length; i++) {
          const r = live[i];
          if (r.b !== b || r.evict) continue;
          if (!oldest || r.birth < oldest.birth) oldest = r;
        }
        if (!oldest) break;
        oldest.evict = true;
        const age = elapsed - oldest.birth;
        oldest.life = age + 0.45;
        // shorten life in place: the shader fades over the last 38% of it
        p.batch.patchTiming(oldest.slot,
          [oldest.birth, oldest.life, oldest.fadeIn, oldest.dry]);
        this._stats.evicted++;
      }
    }

    /* expire blood-tracking zones */
    for (let i = this._bloodZones.length - 1; i >= 0; i--) {
      if (elapsed > this._bloodZones[i].until) this._bloodZones.splice(i, 1);
    }
    if (this._recent.length > 48) this._recent.splice(0, this._recent.length - 48);
    if (this._prints.length > 40) this._prints.splice(0, this._prints.length - 40);

    for (const p of this._pools) p.batch.flush();
    this.telegraphs?.tick(elapsed);

    /* Grounding. Isolated: a throw here must not stop decals ageing. */
    if (this.contacts) {
      try {
        this.contacts.update(elapsed);
      } catch (e) {
        console.warn('[decals] contact shadows disabled —', e?.message ?? e);
        try { this.contacts.mesh.visible = false; } catch { /* noop */ }
        this.contacts = null;
      }
    }
  }

  dispose() {
    for (const off of this._offs) { try { off(); } catch { } }
    this._offs.length = 0;
    for (const p of this._pools) p.batch.dispose();
    this._pools.length = 0;
    this._live.length = 0;
    try { this.material?.dispose(); } catch { }
    try { this.atlas?.dispose(); } catch { }
    try { this.telegraphs?.dispose(); } catch { }
    try { this.contacts?.dispose(); } catch { }
    try { this.contactMat?.dispose(); } catch { }
    try { this.surface?.dispose(); } catch { }
  }

  /* ==================================================================== *
   * public API
   * ==================================================================== */

  /**
   * Place a decal.
   * @param {string} type key in DECAL_TYPES
   * @param {{x:number,y?:number,z:number,dir?:number,seed?:number,scale?:number,
   *          tint?:number[],life?:number,pre?:number,opacity?:number,
   *          emissive?:number,project?:boolean}} o
   */
  spawn(type, o) {
    if (!this.enabled || this.__dead) return null;
    const def = DECAL_TYPES[type];
    if (!def || !o) return null;
    if (this._frameSpawns >= 8) { this._stats.rejected++; return null; }

    const elapsed = this.engine.clock.elapsed;
    const seed = (o.seed ?? (this._evt++ * 2654435761)) >>> 0;
    const r = this.engine.freshRand(seed ^ 0x9e37);

    const scale = o.scale ?? 1;
    const j = def.jitter ?? 0;
    const halfL = Math.max(0.05, def.size[0] * scale * (1 + r.range(-j, j)) * 0.5);
    const halfW = Math.max(0.05, def.size[1] * scale * (1 + r.range(-j, j)) * 0.5);
    const yaw = def.orient === 'dir' && o.dir !== undefined ? o.dir : r.range(0, TAU);

    const x = o.x, z = o.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;

    const probe = this.surface.probe(x, z);
    const gy = this.surface.groundY(x, z);
    const rect = this.atlas.rects[def.tile] ?? this.atlas.rects.dust;

    /* --- choose the accurate (projected) path when the receiver is not the
           flat ground: a tilted face, a step, a rubble pile, a sarcophagus --- */
    let pool = 0;
    let built = false;
    const maxHalf = Math.max(halfL, halfW);
    // The projected path exists for surfaces that are NOT the flat ground plane:
    // a tilted face, or a discrete receiver (slab lip, stair, rubble, tomb) whose
    // surface steps within the decal's own footprint. Everything else conforms
    // far more cheaply through the heightfield patch.
    const wantProject = o.project !== false && maxHalf < 1.5 &&
      this.surface.projectable(probe) &&
      (probe.ny < 0.93 || this.surface.stepAt(x, z, Math.min(0.7, maxHalf)) > 0.06);
    if (wantProject && this._pools[1].free.length > 2) {
      built = this.surface.buildProjected(
        probe, x, probe.y, z, yaw, halfL * 2, halfW * 2,
        Math.max(0.9, Math.max(halfL, halfW) * 1.6), rect, LIFT, PROJ_VERTS);
      if (built) { pool = 1; this._stats.projected++; }
    }
    if (!built) {
      const res = Math.min(MAX_RES, Math.max(2, (def.res ?? 6)));
      const baseY = probe.ok ? probe.y : gy;
      /* A sigil is 3-10 m across and is the one decal the eye reads as a single
         shape, so a corner of it hovering 0.3 m over the flagstones — which is all
         the analytic height field guarantees — is visible as "pasted on". Runes,
         and anything else this big, get the probe-corrected height field. Small
         marks keep the cheap analytic path: they are 0.5-3 m and the correction is
         sub-pixel on them. */
      const conform = def.cls === CLS.RUNE || maxHalf > 2.4;
      if (conform) {
        this.surface.buildPatchConformed(x, z, yaw, halfL, halfW, res, rect, LIFT,
          baseY, maxHalf > 4 ? 5 : 4);
      } else {
        this.surface.buildPatch(x, z, yaw, halfL, halfW, res, rect, LIFT, baseY);
      }
      pool = 0;
    }

    const p = this._pools[pool];
    if (!p.free.length) { this._stats.rejected++; return null; }
    const slot = p.free.pop();

    const S = this.surface;
    const ok = p.batch.writeGeometry(slot, S.pos, S.nrm, S.uv, S.count,
      pool === 0 ? S.idx : null, S.idxCount, S.loc);
    if (!ok) { p.free.push(slot); this._stats.rejected++; return null; }

    const tint = o.tint ?? def.tint ?? [1, 1, 1];
    const em = def.emissTint ?? [1, 1, 1];
    const gain = (o.emissive ?? def.emissive ?? 0) * (o.emissiveScale ?? 1);
    const life = o.life ?? def.life;
    const birth = elapsed - (o.pre ?? 0);
    p.batch.writeParams(
      slot,
      [tint[0], tint[1], tint[2], o.opacity ?? def.opacity ?? 1],
      [em[0], em[1], em[2], gain],
      [birth, life, def.fadeIn ?? 0.1, Math.max(0.05, def.dry ?? 8)],
      [def.cls, o.grow ?? def.grow ?? 0, def.rough[0], def.rough[1]],
    );

    this._live.push({
      b: pool, slot, birth, life,
      fadeIn: def.fadeIn ?? 0.1, dry: Math.max(0.05, def.dry ?? 8),
      evict: false, cls: def.cls,
    });
    this._frameSpawns++;
    this._stats.spawned++;
    return slot;
  }

  /** Drop every decal (scenario change). */
  clear() {
    for (const r of this._live) {
      const p = this._pools[r.b];
      if (!p) continue;
      p.batch.clearSlot(r.slot);
      p.free.push(r.slot);
    }
    this._live.length = 0;
    this._recent.length = 0;
    this._prints.length = 0;
    this._bloodZones.length = 0;
    this._evt = 0;
    for (const p of this._pools) p.batch.flush();
    this.telegraphs?.clear();
    /* The anchors themselves are gone (new level, new props), and every patch is
       baked against a surface that no longer exists. */
    try { this.contacts?.clear(); } catch { /* noop */ }
  }

  /** Convenience wrappers other modules may reach for. */
  blood(x, z, dir = 0, scale = 1, seed = 0) {
    return this.spawn('blood_splat', { x, z, dir, scale, seed });
  }
  scorch(x, z, scale = 1, seed = 0) {
    return this.spawn('scorch', { x, z, scale, seed });
  }
  crater(x, z, scale = 1, seed = 0) {
    this.spawn('crater', { x, z, scale, seed });
    return this.spawn('dust', { x, z, scale: scale * 1.3, seed: seed + 1 });
  }
  rune(x, z, kind = 'rune_minor', opts = {}) {
    return this.spawn(kind, { x, z, ...opts });
  }
  /** Manual telegraph, for systems that do not go through AI. */
  telegraph(spec) { return this.telegraphs?.begin(spec) ?? null; }

  stats() {
    let live = 0, evicting = 0;
    for (const r of this._live) { live++; if (r.evict) evicting++; }
    return {
      live, evicting,
      free: this._pools.map((p) => p.free.length),
      drawCalls: this.contacts ? 4 : 3,
      textureUnits: 2,
      telegraphs: this.telegraphs?.active ?? 0,
      contacts: this.contacts ? { ...this.contacts.stats } : null,
      ...this._stats,
    };
  }

  /* ==================================================================== *
   * bus handlers
   * ==================================================================== */

  _pt(p, out) {
    if (!p) return false;
    const v = p.point ?? p.hitPoint ?? p.position ?? p;
    if (!v) return false;
    const x = v.x, y = v.y, z = v.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    out.x = x; out.y = Number.isFinite(y) ? y : 0; out.z = z;
    return true;
  }

  /** Heading from an event normal, falling back to the seed. */
  _dirOf(n, seed) {
    if (n) {
      const dx = n.x ?? 0, dz = n.z ?? 0;
      if (Math.hypot(dx, dz) > 0.18) return Math.atan2(dz, dx);
    }
    return this.engine.freshRand(seed)() * TAU;
  }

  /** True when a mark of this class was just laid nearly on the same spot. */
  _tooClose(cls, x, z, minD) {
    const t = this.engine.clock.elapsed;
    const d2 = minD * minD;
    for (let i = this._recent.length - 1; i >= 0; i--) {
      const e = this._recent[i];
      if (t - e.t > 0.45) continue;
      if (e.cls !== cls) continue;
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz < d2) return true;
    }
    return false;
  }
  _note(cls, x, z) {
    this._recent.push({ cls, x, z, t: this.engine.clock.elapsed });
  }

  _onImpact(p) {
    if (!this.enabled || this.__dead) return;
    const P = _tmp;
    if (!this._pt(p, P)) return;
    const kind = String(p.kind ?? 'default');
    if (kind === 'footfall') { this._onFootfall(P, p); return; }

    const recipe = IMPACT_MAP[kind] ?? IMPACT_MAP.default;
    if (!recipe || !recipe.length) return;
    const mag = clamp(p.magnitude ?? 0.6, 0.08, 2.0);
    const base = (this._evt++ * 2654435761 ^ (((P.x * 71) | 0) * 40503) ^ (((P.z * 71) | 0) * 25147)) >>> 0;
    const rr = this.engine.freshRand(base);
    const dir = this._dirOf(p.normal ?? p.hitNormal, base + 7);

    for (let i = 0; i < recipe.length; i++) {
      const [type, prob, sc] = recipe[i];
      if (prob <= 0) continue;
      if (prob < 1 && rr() > prob * clamp(mag * 1.15, 0.35, 1.35)) continue;
      const def = DECAL_TYPES[type];
      if (!def) continue;
      if (this._tooClose(def.cls, P.x, P.z, def.cls === CLS.BLOOD ? 0.34 : 0.75)) continue;
      const spread = i === 0 ? 0 : 0.35 + rr() * 0.5;
      const a = dir + rr.gauss(0, 0.7);
      this.spawn(type, {
        x: P.x + Math.cos(a) * spread,
        z: P.z + Math.sin(a) * spread,
        dir: dir + rr.gauss(0, 0.24),
        seed: (base + i * 7919) >>> 0,
        scale: sc * (0.62 + mag * 0.55),
      });
      this._note(def.cls, P.x, P.z);
    }
    if (kind === 'gore' || (kind === 'heavy_impact' && mag > 0.9)) {
      this._bloodZones.push({ x: P.x, z: P.z, r: 1.6, until: this.engine.clock.elapsed + 26, n: 6 });
    }
  }

  _onDamage(p) {
    if (!this.enabled || this.__dead) return;
    const P = _tmp;
    if (!this._pt(p, P)) return;
    const amount = p.amount ?? 0;
    if (amount <= 0) return;
    const type = String(p.type ?? 'physical');
    const key = DAMAGE_MAP[type] ?? 'blood_splat';
    const def = DECAL_TYPES[key];
    if (!def) return;

    const base = (this._evt++ * 2246822519 ^ (((P.x * 53) | 0) * 40503)) >>> 0;
    const rr = this.engine.freshRand(base);
    // spatter lands away from the blow, on the ground beneath the wound
    const dir = this._dirOf(p.hitNormal ? { x: -(p.hitNormal.x ?? 0), z: -(p.hitNormal.z ?? 0) } : null, base + 3);
    const throwD = 0.30 + clamp(amount / 45, 0, 1) * 0.85;
    const mag = clamp(0.42 + amount / 55, 0.4, 1.5) * (p.crit ? 1.35 : 1);
    if (this._tooClose(def.cls, P.x, P.z, 0.30)) return;
    this.spawn(key, {
      x: P.x + Math.cos(dir) * throwD,
      z: P.z + Math.sin(dir) * throwD,
      dir, seed: base, scale: mag,
    });
    this._note(def.cls, P.x, P.z);
    if (p.crit && amount > 12) {
      this.spawn('blood_spray', {
        x: P.x + Math.cos(dir) * (throwD + 0.6),
        z: P.z + Math.sin(dir) * (throwD + 0.6),
        dir, seed: (base + 991) >>> 0, scale: mag * 1.1,
      });
      this._bloodZones.push({ x: P.x, z: P.z, r: 1.2, until: this.engine.clock.elapsed + 18, n: 4 });
    }
  }

  _onDeath(p) {
    if (!this.enabled || this.__dead) return;
    const e = p?.entity;
    const P = _tmp;
    const pos = e?.position ?? p?.hitPoint;
    if (!this._pt({ point: pos }, P)) return;
    const height = e?.height ?? (e?.def?.height) ?? 1.85;
    const boss = !!(e?.def?.isBoss);
    const elite = !!e?.elite;
    const sc = clamp(height / 1.85, 0.55, 3.4) * (boss ? 1.5 : elite ? 1.15 : 1);
    const base = (this._evt++ * 3266489917 ^ (((P.x * 37) | 0) * 40503)) >>> 0;
    const rr = this.engine.freshRand(base);

    this.spawn('blood_pool', { x: P.x, z: P.z, seed: base, scale: sc * 0.95 });
    const n = boss ? 6 : elite ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const a = rr.range(0, TAU);
      const d = rr.range(0.5, 1.5) * sc;
      this.spawn(i % 2 ? 'blood_spray' : 'blood_burst', {
        x: P.x + Math.cos(a) * d, z: P.z + Math.sin(a) * d,
        dir: a, seed: (base + i * 6151) >>> 0, scale: sc * rr.range(0.6, 1.05),
      });
    }
    if (boss) {
      this.spawn('cracks', { x: P.x, z: P.z, seed: (base + 13) >>> 0, scale: 1.35 });
      this.spawn('dust', { x: P.x, z: P.z, seed: (base + 17) >>> 0, scale: 1.8 });
    }
    this._bloodZones.push({
      x: P.x, z: P.z, r: 1.35 * sc,
      until: this.engine.clock.elapsed + 40, n: boss ? 12 : 7,
    });
  }

  _onFootfall(P, p) {
    const mag = clamp(p.magnitude ?? 0.4, 0, 3);
    if (mag < 0.16) return;
    // one print per 0.28 m keeps a walking pack from filling the pool
    for (let i = this._prints.length - 1; i >= 0; i--) {
      const e = this._prints[i];
      const dx = e.x - P.x, dz = e.z - P.z;
      if (dx * dx + dz * dz < 0.078) return;
    }
    const base = (this._evt++ * 2654435761 ^ (((P.x * 97) | 0) * 40503) ^ (((P.z * 97) | 0) * 25147)) >>> 0;
    const rr = this.engine.freshRand(base);
    let type = mag > 1.05 ? 'print_boss' : mag > 0.42 ? 'print_claw' : 'print_boot';
    let scale = clamp(0.7 + mag * 0.55, 0.65, 1.6);
    let opacity;

    // stepping in fresh blood tracks it
    let zone = null;
    for (const z of this._bloodZones) {
      const dx = z.x - P.x, dz = z.z - P.z;
      if (dx * dx + dz * dz < z.r * z.r && z.n > 0) { zone = z; break; }
    }
    if (zone) { zone.n--; type = 'print_blood'; opacity = 0.9; }
    else if (rr() > 0.62) return;   // only some steps register at all

    const dir = P.dir ?? this._dirOf(p.dir ?? p.forward, base + 11);
    this.spawn(type, { x: P.x, z: P.z, dir, seed: base, scale, opacity });
    this._prints.push({ x: P.x, z: P.z });
  }

  _onRune(p) {
    if (!p) return;
    const kind = p.kind ?? p.type ?? 'rune_minor';
    if (!DECAL_TYPES[kind]) return;
    this.spawn(kind, { x: p.x ?? 0, z: p.z ?? 0, scale: p.scale ?? 1, seed: p.seed ?? 5, ...p, type: undefined });
  }

  /* ==================================================================== *
   * scenario dressing — the world has a history before the player arrives
   * ==================================================================== */

  _walkable(x, z) {
    const d = this.engine.get('dungeon');
    if (d && !d.__dead && d.active && typeof d.isWalkable === 'function') {
      try { return d.isWalkable(x, z) !== false; } catch { return true; }
    }
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.isWalkable === 'function') {
      try { return t.isWalkable(x, z) !== false; } catch { return true; }
    }
    return true;
  }

  /** Rejection-sampled cluster scatter — never a grid, never uniform. */
  _scatter(rand, cx, cz, count, minR, maxR, fn) {
    let placed = 0;
    for (let i = 0; i < count * 7 && placed < count; i++) {
      const a = rand.range(0, TAU);
      const u = rand();
      const d = minR + (maxR - minR) * Math.sqrt(u) * rand.range(0.55, 1.0);
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      if (!this._walkable(x, z)) continue;
      fn(x, z, i);
      placed++;
    }
    return placed;
  }

  _focus() {
    const d = this.engine.get('dungeon');
    try {
      const pts = d?.active ? d.spawnPoints?.('player') : null;
      if (pts && pts.length) return { x: pts[0].x, z: pts[0].z };
    } catch { /* fall through */ }
    const h = this.engine.get('hero');
    if (h?.position) return { x: h.position.x, z: h.position.z };
    return { x: 0, z: 0 };
  }

  _dress(name, cfg) {
    const biome = cfg?.env?.biome ?? 'crypt';
    const R = this.engine.freshRand((0x0deca1 ^ hashName(name)) >>> 0);
    const F = this._focus();

    /* footprint trails read as traffic — always worth the slots */
    const trails = (n, len, type, sc) => {
      for (let t = 0; t < n; t++) {
        const a = R.range(0, TAU);
        let x = F.x + Math.cos(a) * R.range(3, 13);
        let z = F.z + Math.sin(a) * R.range(3, 13);
        let head = R.range(0, TAU);
        for (let s = 0; s < len; s++) {
          head += R.gauss(0, 0.16);
          const side = (s % 2 ? 1 : -1) * 0.17;
          const px = x + Math.cos(head + Math.PI / 2) * side;
          const pz = z + Math.sin(head + Math.PI / 2) * side;
          if (this._walkable(px, pz)) {
            this._frameSpawns = 0;
            this.spawn(type, {
              x: px, z: pz, dir: head, scale: sc * R.range(0.9, 1.1),
              seed: (0xf00 + t * 331 + s * 17) >>> 0,
              pre: R.range(4, 26), life: 900, opacity: R.range(0.30, 0.55),
            });
          }
          x += Math.cos(head) * 0.72;
          z += Math.sin(head) * 0.72;
        }
      }
    };

    const put = (type, count, minR, maxR, opts = {}) => {
      this._scatter(R, F.x, F.z, count, minR, maxR, (x, z, i) => {
        this._frameSpawns = 0;
        this.spawn(type, {
          x, z, seed: (hashName(type) + i * 7919) >>> 0,
          dir: R.range(0, TAU),
          scale: (opts.scale ?? 1) * R.range(0.7, 1.25),
          pre: opts.pre ?? R.range(30, 200),
          life: opts.life ?? 900,
          opacity: opts.opacity,
        });
      });
    };

    if (biome === 'crypt' || name === 'dungeon' || name === 'combat') {
      put('blood_splat', 14, 1.5, 15, { scale: 0.95 });
      put('blood_burst', 8, 2, 16, { scale: 0.8 });
      put('blood_spray', 5, 3, 17, { scale: 0.9, opacity: 0.62 });
      put('blood_pool', 3, 4, 14, { scale: 0.85, pre: 260 });
      put('scorch', 5, 3, 16, { scale: 0.8, pre: 120 });
      put('cracks', 3, 3, 15, { scale: 0.9, pre: 200 });
      put('crater', 2, 5, 15, { scale: 0.75, pre: 220 });
      put('scuff', 10, 1, 16, { scale: 1.1, pre: 20, opacity: 0.30 });
      trails(4, 9, 'print_boot', 1.0);
      trails(2, 7, 'print_claw', 1.1);
      if (name === 'combat') put('rune_minor', 1, 7, 9, { scale: 0.9, pre: 3 });
    } else if (biome === 'hell' || name === 'boss') {
      const a = this.engine.get('dungeon')?.arena;
      const cx = Number.isFinite(a?.x) ? a.x : 0;
      const cz = Number.isFinite(a?.z) ? a.z : -2.6;
      this.spawn('rune_major', { x: cx, z: cz, seed: 991, scale: 1.6, pre: 2 });
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * TAU + 0.32;
        this.spawn('rune_ward', {
          x: cx + Math.cos(ang) * 9.4, z: cz + Math.sin(ang) * 9.4,
          seed: (1200 + i * 71) >>> 0, scale: 1.05, pre: 2,
        });
      }
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * TAU - 0.6;
        this.spawn('rune_minor', {
          x: cx + Math.cos(ang) * 5.0, z: cz + Math.sin(ang) * 5.0,
          seed: (1400 + i * 97) >>> 0, scale: 0.95, pre: 2,
        });
      }
      put('scorch_burst', 4, 4, 13, { scale: 0.95, pre: 40 });
      put('scorch', 7, 3, 15, { scale: 0.85, pre: 90 });
      put('crater', 4, 4, 14, { scale: 1.0, pre: 160 });
      put('cracks', 4, 3, 15, { scale: 1.1, pre: 180 });
      put('blood_splat', 9, 2, 14, { scale: 1.0 });
      put('blood_pool', 3, 3, 12, { scale: 1.15, pre: 240 });
      trails(2, 6, 'print_boss', 1.0);
      trails(2, 8, 'print_claw', 1.15);
    } else if (biome === 'town') {
      put('scuff', 16, 1, 18, { scale: 1.25, pre: 30, opacity: 0.26 });
      put('dust', 4, 4, 16, { scale: 1.4, pre: 2, life: 900, opacity: 0.16 });
      trails(6, 11, 'print_boot', 1.0);
      put('blood_splat', 2, 8, 16, { scale: 0.6, opacity: 0.4, pre: 400 });
    } else {
      /* moor: exteriors — mud, tracks, a little old violence */
      put('scuff', 10, 2, 20, { scale: 1.4, pre: 40, opacity: 0.24 });
      trails(5, 10, 'print_boot', 1.05);
      trails(3, 8, 'print_claw', 1.2);
      put('blood_splat', 5, 3, 18, { scale: 0.85, pre: 120 });
      put('blood_pool', 1, 6, 14, { scale: 0.9, pre: 280 });
      put('scorch', 3, 4, 18, { scale: 0.9, pre: 150 });
      put('crater', 2, 5, 18, { scale: 0.9, pre: 200 });
    }

    if (name === 'closeup') {
      put('blood_splat', 3, 0.8, 3.2, { scale: 0.7 });
      put('scuff', 4, 0.6, 3.0, { scale: 0.8, opacity: 0.3 });
    }
    this._frameSpawns = 0;
  }
}

const _tmp = { x: 0, y: 0, z: 0, dir: undefined };
const _cv = new THREE.Vector3();

/* ====================================================================== *
 * CONTACT SHADOWS
 * ====================================================================== */

/**
 * The contact-shadow material: three Gaussian lobes per slot, evaluated in the
 * patch's own world-aligned metres, multiplied into whatever is under it.
 *
 * NO TEXTURES AT ALL (the frame's texture-unit budget is 16 and the stain atlas
 * already spends two), and the shape comes from an analytic falloff plus a hash
 * noise so the edge is organic rather than a perfect circle — a clean ellipse on
 * the floor reads as a decal, not as occlusion.
 *
 * `uTime` is the same uniform object the stain material owns, so the fade-in
 * costs nothing to drive.
 */
function makeContactShadowMaterial(uTime) {
  const mat = new THREE.ShaderMaterial({
    name: 'NonaContactShadow',
    uniforms: {
      uTime: uTime ?? { value: 0 },
      uGain: { value: 1.0 },
      uCap: { value: CONTACT_CAP },
      uZBias: { value: CONTACT_ZBIAS },
    },
    vertexShader: /* glsl */`
      attribute vec2 aLocal;
      attribute vec4 aTint;      // lobe A: offset.xz (m, from patch centre), radius, peak
      attribute vec4 aEmis;      // lobe B: same
      attribute vec4 aTiming;    // broad lobe: same
      attribute vec4 aFlags;     // birth, fadeIn, seed, patch half-extent (m)
      uniform float uZBias;
      varying vec2 vLocal;
      varying vec4 vA;
      varying vec4 vB;
      varying vec4 vC;
      varying vec4 vF;
      void main() {
        vLocal = aLocal;
        vA = aTint; vB = aEmis; vC = aTiming; vF = aFlags;
        /*
         * VIEW-SPACE DEPTH BIAS — the thing that makes this layer land at all.
         *
         * The patch follows the analytic height field; the depth buffer holds the
         * rendered stone, which carries its own relief, and the two disagree by a
         * few centimetres. With a plain projection the depth test threw away all
         * but the pixels directly under the boot (measured: peak darkening 0.18 at
         * one spot and a frame-wide mean delta of 0.0002 — invisible), which is the
         * same trap the hero's and props' own blob layers are still in.
         *
         * Lifting the geometry in WORLD space instead is not the answer: it fixes
         * the depth test by detaching the shadow, and at the 3 m portrait camera
         * 8 cm of lift is 30 px of parallax — the shadow visibly floats. Biasing
         * the VIEW-SPACE Z toward the camera clears the test without moving the
         * patch on the floor: screen x/y shift only by the perspective ratio
         * (2 % at 3 m, 0.2 % at 28 m), and it stays correct for a receiver at any
         * angle, unlike a fixed NDC offset, which would be metres of bias at
         * gameplay distance and nothing at all up close.
         */
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        mv.z += uZBias;                        // camera looks down -Z
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uGain;
      uniform float uCap;
      varying vec2 vLocal;
      varying vec4 vA;
      varying vec4 vB;
      varying vec4 vC;
      varying vec4 vF;

      float hash12( vec2 p ) {
        vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
        p3 += dot( p3, p3.yzx + 33.33 );
        return fract( ( p3.x + p3.y ) * p3.z );
      }
      float vnoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        vec2 u = f * f * ( 3.0 - 2.0 * f );
        float a = hash12( i ), b = hash12( i + vec2( 1.0, 0.0 ) );
        float c = hash12( i + vec2( 0.0, 1.0 ) ), d = hash12( i + vec2( 1.0, 1.0 ) );
        return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
      }
      /* Gaussian rather than a smoothstep disc: occlusion under a foot has no
         edge, and a smoothstep's zero crossing is exactly the "ellipse painted on
         the floor" tell. exp( -d*d*2.2 ) is ~0.11 at d = 1, so the visible
         extent is about 1.4 radii. */
      float lobe( vec2 p, vec2 c, float r, float k ) {
        if ( k <= 0.0 || r <= 1e-4 ) return 0.0;
        float d = length( p - c ) / r;
        return k * exp( -d * d * 2.2 );
      }

      void main() {
        float R = max( vF.w, 1e-3 );
        vec2 p = ( vLocal - 0.5 ) * 2.0 * R;      // metres from the patch centre

        float a = lobe( p, vA.xy, vA.z, vA.w )
                + lobe( p, vB.xy, vB.z, vB.w )
                + lobe( p, vC.xy, vC.z, vC.w );
        if ( a <= 0.0 ) discard;

        // Organic edge. Low frequency only — high-frequency noise on a shadow
        // this soft just reads as dither at gameplay distance.
        a *= 0.84 + 0.16 * vnoise( p * 1.7 + vF.z );

        // The patch is a square; nothing may ever reach its border.
        vec2 e = abs( vLocal - 0.5 ) * 2.0;
        a *= 1.0 - smoothstep( 0.74, 1.0, max( e.x, e.y ) );

        float fade = vF.y > 0.0 ? clamp( ( uTime - vF.x ) / vF.y, 0.0, 1.0 ) : 1.0;
        a = min( a * uGain * fade * fade * ( 3.0 - 2.0 * fade ), uCap );
        if ( a < 0.004 ) discard;
        gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  // Never let another module's material hook reach this: it is not lit, not
  // fogged, casts nothing, and must stay out of the depth/normal prepass or it
  // would become a false occluder for the very AO term it is complementing.
  mat.userData.noCSM = true;
  mat.userData.skyNoFog = true;
  mat.userData.noGBuffer = true;
  return mat;
}

/** Lobe scratch — 3 lobes x (offsetX, offsetZ, radius, peak). Never reallocated. */
const _lobes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const _cf = { x: 0, z: 0 };

/**
 * First matching bone on a character, whichever rig it is using. Hero exposes
 * `rig.bone(name)` (Skeleton) and monsters expose a `boneByName` Map (RigKit),
 * and the two naming conventions differ — `foot_L` versus `toe.L` — so callers
 * hand in every alias that means "the part touching the floor".
 * @returns {THREE.Object3D|null}
 */
function boneOf(host, names) {
  if (!host) return null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    try {
      const b = host.rig?.bone?.(n);
      if (b) return b;
    } catch { /* wrong rig kind — try the map */ }
    const map = host.boneByName;
    if (map) {
      const b = typeof map.get === 'function' ? map.get(n) : map[n];
      if (b) return b;
    }
  }
  return null;
}

const FOOT_L = ['foot_L', 'ankle.L', 'fPaw.L'];
const FOOT_R = ['foot_R', 'ankle.R', 'fPaw.R'];
const TOE_L = ['toe_L', 'toe.L'];
const TOE_R = ['toe_R', 'toe.R'];

/**
 * One ground-conforming darkening patch per anchor (hero, monster, NPC, prop),
 * in a single batch. See the CONTACT SHADOWS note at the top of this file.
 */
class ContactShadows {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine, surface, material) {
    this.engine = engine;
    this.surface = surface;
    this.material = material;
    this.batch = new DecalBatch(material, {
      slots: CONTACT_SLOTS, verts: CONTACT_VERTS, indices: CONTACT_IDX,
      name: 'decals:contact',
      /*
       * AFTER the stains, not before them.
       *
       * This layer is a pure multiply (`NormalBlending` over black resolves to
       * `dst * (1 - a)`), so whatever is drawn after it is not darkened by it. At
       * renderOrder 3 it ran BEFORE the ground stains at 4 and the projected
       * stains at 5, which meant the boss arena's 10 m rune circle painted itself
       * straight over the hero's own grounding — the ring was visibly brighter
       * inside the shadow pool than the stone beside it.
       *
       * 5.5, not 6: renderOrder is compared as a number, and 6 is already taken by
       * additive layers that must NOT be multiplied down — Loot's pickup beams,
       * Hero's effect quad, the shrine sigil shafts, Water's horizon bands. This
       * sits in the gap: after every ground stain (4, 5, and Loot's ground pools
       * at 4), before every light above them, and well before the telegraph field
       * at 7, which is emission and belongs on top of a shadow.
       */
      renderOrder: 5.5,
    });
    this.free = freeList(CONTACT_SLOTS);
    /** @type {Map<string, {slot:number,cx:number,cz:number,R:number,fp:number,birth:number,sig:number}>} */
    this.recs = new Map();
    this._seen = new Set();
    this._props = [];
    this._propAt = -1e9;
    this._fx = 1e9;
    this._fz = 1e9;
    this._budget = 0;
    this._rect = [0, 0, 1, 1];
    this.stats = { live: 0, rebuilt: 0, dropped: 0 };
  }

  get mesh() { return this.batch.mesh; }

  clear() {
    for (const rec of this.recs.values()) {
      this.batch.clearSlot(rec.slot);
      this.free.push(rec.slot);
    }
    this.recs.clear();
    this._props.length = 0;
    this._propAt = -1e9;
    this._fx = 1e9;
    this._fz = 1e9;
    this.batch.flush();
  }

  dispose() { this.batch.dispose(); }

  /* ------------------------------------------------------------- per frame */

  update(elapsed) {
    this._budget = CONTACT_REBUILDS;
    this._seen.clear();
    this.stats.rebuilt = 0;

    // Characters first: they always get a slot, and taking the low slots keeps
    // the per-frame upload span tight (see DecalBatch.flush).
    this._hero(elapsed);
    this._monsters(elapsed);
    this._npcs(elapsed);
    this._propAnchors(elapsed);

    for (const [key, rec] of this.recs) {
      if (this._seen.has(key)) continue;
      this.batch.clearSlot(rec.slot);
      this.free.push(rec.slot);
      this.recs.delete(key);
    }
    this.stats.live = this.recs.size;
    this.batch.flush();
  }

  /**
   * Ask for a patch. `lobes` is a flat [ax, az, ar, ak, bx, bz, br, bk, cx, cz,
   * cr, ck] in WORLD offsets from (x, z); the shader gets them relative to the
   * patch centre, which is why an anchor can move without a rebuild.
   *
   * `y` is the height of the anchor's OWN footing and it is not optional. It is
   * the one number that cannot be wrong: whatever the heightfield or the decal
   * raycaster believe, the thing casting this shadow is standing there. Trusting
   * `Surface.probe` instead is what made every previous grounding layer in this
   * project invisible — its result is memoised per 0.4 m cell, so at the hero's
   * feet it returned the 0.23 m lip of a rubble slab 0.28 m away instead of the
   * 0.305 m flagstone under the boot, and the patch was built 5 cm UNDER the
   * floor, where the depth test threw every one of its pixels away. (Measured:
   * patch centre y 0.2556 against a foot at 0.305.)
   */
  _want(key, x, z, y, fp, lobes, n, elapsed, useProbe) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    let rec = this.recs.get(key);
    if (!rec) {
      if (!this.free.length) { this.stats.dropped++; return; }
      rec = {
        slot: this.free.pop(), cx: x, cz: z, R: 0, fp: -1,
        birth: elapsed, sig: NaN,
      };
      this.recs.set(key, rec);
    }
    this._seen.add(key);

    const R = fp + CONTACT_SLACK;
    const dx = x - rec.cx, dz = z - rec.cz;
    const drift = Math.sqrt(dx * dx + dz * dz);
    const stale = rec.R <= 0 || Math.abs(fp - rec.fp) > 0.12 ||
      drift > CONTACT_SLACK * 0.62;
    if (stale && this._budget > 0) {
      this._budget--;
      if (this._build(rec, x, z, y, R, useProbe)) { rec.cx = x; rec.cz = z; rec.R = R; rec.fp = fp; }
    }
    if (rec.R <= 0) return;              // never got its geometry — no params

    // Offsets are relative to the patch centre, which is where the geometry is.
    const ox = x - rec.cx, oz = z - rec.cz;
    let sig = rec.R;
    for (let i = 0; i < n * 4; i++) sig = sig * 31.7 + lobes[i];
    if (sig === rec.sig) return;         // static prop: nothing to upload
    rec.sig = sig;

    const A = [0, 0, 0, 0], B = [0, 0, 0, 0], C = [0, 0, 0, 0];
    const dst = [A, B, C];
    for (let i = 0; i < 3; i++) {
      const o = i * 4;
      if (i < n) {
        dst[i][0] = lobes[o] + ox;
        dst[i][1] = lobes[o + 1] + oz;
        dst[i][2] = lobes[o + 2];
        dst[i][3] = lobes[o + 3];
      }
    }
    this.batch.writeParams(rec.slot, A, B, C,
      [rec.birth, 0.22, hashName(key) % 97, rec.R]);
  }

  _build(rec, x, z, y, R, useProbe) {
    const S = this.surface;
    /*
     * Start from the anchor's own footing and let the raycaster only ever push it
     * UP, and by no more than a quarter of a metre: that picks up a prop standing
     * on a slab (where the rendered surface really is above the heightfield)
     * without letting a memoised probe from the next cell drop the patch into the
     * floor. `CONTACT_LIFT` on top is what absorbs the residual disagreement
     * between the analytic field the patch follows and the rendered stone.
     */
    let baseY = Number.isFinite(y) ? y : undefined;
    /*
     * A CHARACTER NEVER ASKS THE RAYCASTER. `Surface.probe` is a real raycast
     * against ~270 receiver meshes on a cache miss, and a walking body misses the
     * 0.4 m cache constantly — 8 of those per frame measured as the bulk of this
     * layer's cost. A body also has no need of it: it is standing on the floor,
     * so its own footing height IS the answer. Props are static, ask once, and are
     * the only case that needs the correction (a barrel on a slab).
     */
    if (useProbe || baseY === undefined) {
      try {
        const probe = S.probe(x, z);
        if (probe.ok && Number.isFinite(probe.y)) {
          baseY = baseY === undefined ? probe.y : baseY + clamp(probe.y - baseY, 0, 0.25);
        }
      } catch { /* the anchor's own height is enough */ }
    }
    try {
      S.buildPatch(x, z, 0, R, R, CONTACT_RES, this._rect, CONTACT_LIFT, baseY);
    } catch { return false; }
    const ok = this.batch.writeGeometry(rec.slot, S.pos, S.nrm, S.uv, S.count,
      S.idx, S.idxCount, S.loc);
    if (ok) this.stats.rebuilt++;
    return ok;
  }

  /* --------------------------------------------------------------- anchors */

  /**
   * The hero, per SOLE. This is the pixel the art director measures: the floor
   * directly under the boot must be darker than the floor a boot-length away.
   * Each foot's lobe fades out as that foot lifts, so a running stride does not
   * drag a shadow through the air with it.
   */
  _hero(elapsed) {
    const h = this.engine.get('hero');
    if (!h || h.__dead || h.failed === true) return;
    const p = h.position;
    if (!p || !Number.isFinite(p.x)) return;

    let n = 0;
    for (let s = 0; s < 2; s++) {
      let fx = 0, fz = 0, lift = 0, ok = false;
      const b = boneOf(h, s === 0 ? FOOT_L : FOOT_R);
      if (b) {
        _cv.setFromMatrixPosition(b.matrixWorld);
        fx = _cv.x - p.x; fz = _cv.z - p.z; lift = _cv.y - p.y;
        ok = Number.isFinite(fx) && Number.isFinite(fz);
      }
      /*
       * Centre the pool on the FOOTPRINT, not the ankle. The ankle joint sits
       * ~9 cm behind the toe and ~10 cm above the sole, so a lobe parked on it
       * puts its darkest point behind the boot and reads as a smudge trailing the
       * character instead of occlusion under it. Averaging in the toe joint moves
       * the peak to the middle of the sole, which is where the light is actually
       * blocked.
       */
      const tb = ok ? boneOf(h, s === 0 ? TOE_L : TOE_R) : null;
      if (tb) {
        _cv.setFromMatrixPosition(tb.matrixWorld);
        if (Number.isFinite(_cv.x)) {
          fx = (fx + (_cv.x - p.x)) * 0.5;
          fz = (fz + (_cv.z - p.z)) * 0.5;
          lift = Math.min(lift, _cv.y - p.y);
        }
      }
      if (!ok) { fx = s === 0 ? -0.16 : 0.16; fz = 0; lift = 0; }
      // 1 at a planted foot, 0 once it is a third of a metre up.
      const t = clamp((lift - 0.05) / 0.28, 0, 1);
      const k = 0.82 * (1 - t * t * (3 - 2 * t));
      const o = n * 4;
      _lobes[o] = fx; _lobes[o + 1] = fz; _lobes[o + 2] = 0.34; _lobes[o + 3] = k;
      n++;
    }
    // Body pool: the soft half of the occlusion, and the reason the rim reads.
    let bx = 0, bz = 0;
    const pelvis = boneOf(h, ['pelvis', 'hips', 'root']) ?? h.rig?.bones?.[0] ?? null;
    if (pelvis) {
      _cv.setFromMatrixPosition(pelvis.matrixWorld);
      if (Number.isFinite(_cv.x)) { bx = (_cv.x - p.x) * 0.7; bz = (_cv.z - p.z) * 0.7; }
    }
    const o = n * 4;
    _lobes[o] = bx; _lobes[o + 1] = bz; _lobes[o + 2] = 0.95;
    _lobes[o + 3] = h.isDead ? 0.52 : 0.46;
    n++;
    // `footY` is what Hero itself planted the skeleton on; position.y is the same
    // number unless it is mid-air, where the patch should stay on the ground.
    const gy = Number.isFinite(h.footY) ? Math.min(h.footY, p.y) : p.y;
    this._want('hero', p.x, p.z, gy, 1.15, _lobes, n, elapsed);
  }

  _monsters(elapsed) {
    const bes = this.engine.get('bestiary');
    const list = bes && !bes.__dead ? bes.entities : null;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const en = list[i];
      const p = en?.position;
      if (!p || !Number.isFinite(p.x)) continue;
      if (en.visible === false || en.root?.visible === false) continue;
      const hover = (en.def?.hover ?? 0) * (en.scale ?? 1);
      const r = Math.max(0.22, (en.radius ?? 0.4));
      // A hovering thing has no contact: fade the whole patch out with height.
      const t = clamp(hover / 0.9, 0, 1);
      const gain = (en.dead ? 0.8 : 1) * (1 - t * 0.75);
      if (gain <= 0.02) continue;
      let n = 0;
      let fed = false;
      const bl = boneOf(en, FOOT_L);
      const br = boneOf(en, FOOT_R);
      if (bl && br) {
        for (let s = 0; s < 2; s++) {
          _cv.setFromMatrixPosition((s === 0 ? bl : br).matrixWorld);
          if (!Number.isFinite(_cv.x)) continue;
          const lift = _cv.y - p.y + hover;
          const lt = clamp((lift - 0.06) / 0.34, 0, 1);
          const o = n * 4;
          _lobes[o] = _cv.x - p.x; _lobes[o + 1] = _cv.z - p.z;
          _lobes[o + 2] = r * 0.6 + 0.16;
          _lobes[o + 3] = 0.66 * gain * (1 - lt * lt * (3 - 2 * lt));
          n++;
        }
        fed = n > 0;
      }
      const o = n * 4;
      _lobes[o] = 0; _lobes[o + 1] = 0;
      _lobes[o + 2] = r * (fed ? 1.3 : 1.12);
      _lobes[o + 3] = (fed ? 0.42 : 0.66) * gain;
      n++;
      this._want(`m${en.id ?? i}`, p.x, p.z, p.y - hover, r + 0.25, _lobes, n, elapsed);
    }
  }

  _npcs(elapsed) {
    const npcs = this.engine.get('npcs');
    const list = npcs && !npcs.__dead ? npcs.list : null;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const n0 = list[i];
      if (!n0 || n0.root?.visible === false) continue;
      const rp = n0.root?.position;
      const x = Number.isFinite(n0.x) ? n0.x : rp?.x;
      const z = Number.isFinite(n0.z) ? n0.z : rp?.z;
      const y = Number.isFinite(rp?.y) ? rp.y : n0.y;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      _lobes[0] = -0.13; _lobes[1] = 0; _lobes[2] = 0.30; _lobes[3] = 0.66;
      _lobes[4] = 0.13; _lobes[5] = 0; _lobes[6] = 0.30; _lobes[7] = 0.66;
      _lobes[8] = 0; _lobes[9] = 0; _lobes[10] = 0.80; _lobes[11] = 0.42;
      this._want(`n${i}`, x, z, y, 0.86, _lobes, 3, elapsed);
    }
  }

  /**
   * Props. There are 500-700 of them in a town and 96 slots, so the selection is
   * "biggest thing nearest the shot centre", refreshed a few times a second —
   * which is exactly the set whose bases are large on screen and therefore the
   * set whose hard floor intersections the eye finds.
   */
  _propAnchors(elapsed) {
    const props = this.engine.get('props');
    const list = props && !props.__dead ? props.props : null;
    if (!list || !list.length) return;

    const F = this._focus(_cf);
    const moved = Math.hypot(F.x - this._fx, F.z - this._fz) > 2.5;
    if (moved || elapsed - this._propAt > CONTACT_PROP_REFRESH || !this._props.length) {
      this._propAt = elapsed;
      this._fx = F.x; this._fz = F.z;
      this._pick(list, F.x, F.z, props);
    }
    const sel = this._props;
    for (let i = 0; i < sel.length; i++) {
      const rec = sel[i];
      if (rec.dead) continue;
      const r = Math.max(0.14, rec.r ?? 0.4);
      // One broad lobe, sized off the prop's own Poisson footprint, plus a
      // tighter core so a barrel gets a dark ring at its staves and not a
      // uniform grey disc the size of a table.
      const w = rec.__cw ?? 1;
      _lobes[0] = 0; _lobes[1] = 0; _lobes[2] = r * 0.62; _lobes[3] = 0.62 * w;
      _lobes[4] = 0; _lobes[5] = 0; _lobes[6] = r * 1.32; _lobes[7] = 0.40 * w;
      this._want(`p${rec.__cs}`, rec.x, rec.z, rec.groundY,
        Math.min(2.2, r + 0.2), _lobes, 2, elapsed, true);
    }
  }

  /** Partial selection of the props worth a slot, leaving room for characters. */
  _pick(list, fx, fz, props) {
    const room = Math.max(0, CONTACT_SLOTS - 24);
    const out = this._props;
    out.length = 0;
    const weigh = typeof props?.contactWeight === 'function' ? props : null;
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      if (!rec || rec.dead) continue;
      // Ground cover has a wide footprint and no height. Ranked by footprint
      // alone it took 50 of 72 slots on the moor and printed a black hole under
      // each clump, so Props says how much of a caster each record really is.
      const w = weigh ? weigh.contactWeight(rec) : 1;
      if (!(w > 0)) continue;
      rec.__cw = w;
      if (!Number.isFinite(rec.x) || !Number.isFinite(rec.z)) continue;
      const r = rec.r ?? 0;
      if (r < 0.13) continue;                 // a skull needs no cast shadow
      const dx = rec.x - fx, dz = rec.z - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1600) continue;                // 40 m: past the frame either way
      /*
        * Rank by screen-area-ish: a big base far away still matters more than a
        * tiny one underfoot. `__k` (sort key), `__cs` (stable slot key) and
        * `__cw` (contact weight) are scratch fields written onto Props' own
        * records — namespaced, never read by anyone else, and cheaper than a
        * parallel Map over 700 entries.
        */
      rec.__k = d2 / Math.max(0.05, r * r * w);
      if (rec.__cs === undefined) rec.__cs = i;
      out.push(rec);
    }
    out.sort((a, b) => a.__k - b.__k);
    if (out.length > room) out.length = room;
  }

  _focus(out) {
    const rig = this.engine.get('camera');
    const f = rig && !rig.__dead ? rig.focus : null;
    if (f && Number.isFinite(f.x)) { out.x = f.x; out.z = f.z; return out; }
    const h = this.engine.get('hero');
    if (h?.position && Number.isFinite(h.position.x)) {
      out.x = h.position.x; out.z = h.position.z; return out;
    }
    out.x = 0; out.z = 0;
    return out;
  }
}

function freeList(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = n - 1 - i;
  return a;
}

function hashName(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
