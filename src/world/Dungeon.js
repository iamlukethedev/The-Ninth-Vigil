/**
 * THE NINTH VIGIL — Dungeon.
 *
 * Builds the interiors: the crypt level (every `crypt`-biome scenario, which is
 * where the combat frames are captured) and the hell boss arena. This module
 * carries the frame, so it is written around three ideas:
 *
 * 1. **Architecture, not boxes.** Walls have a real cross-section (plinth,
 *    coursed ashlar over a recessed field, string course, corbelled cornice,
 *    weathered coping). Rooms are vaulted with ribbed groin webs on springers
 *    and wall responds. Doorways are two-centred gothic portals with voussoirs,
 *    a hood mould and a chamfered reveal. Every arris is chamfered — see
 *    dungeon/Pieces.js.
 *
 * 2. **Light is composition.** The vault is a closed solid and casts shadow, so
 *    the crypt is dark by construction; the only cold light in the level falls
 *    through the collapsed bays over the great hall, which is also what keeps a
 *    ceiling from hiding the play space from an isometric camera. Warm
 *    practicals go where a mason would have put them — flanking every portal, in
 *    the wall bays between responds, on the altar — each with real fixture
 *    geometry and a real flame, so the player walks between pools of light.
 *
 * 3. **Everything is instanced and deterministic.** One InstancedMesh per
 *    (geometry, material, shadow) with per-instance colour and roughness jitter,
 *    seeded entirely from `engine.rand`. Pieces are authored at canonical sizes
 *    and scaled the last few percent by the instance matrix, which is what keeps
 *    a whole crypt inside ~130 draw calls.
 *
 * Grounding: every piece is placed on `terrain.heightAt` (the crypt biome's
 * heightfield IS the interior slab floor) with its base buried half a metre, so
 * nothing floats and nothing shows a hard intersection line.
 *
 * Public surface (NavGrid, AI and the Director all read these):
 *   dungeon.rooms                room records in metres
 *   dungeon.bounds               {minX,maxX,minZ,maxZ,minY,maxY}
 *   dungeon.navMask              {data, clearance, W, cell, originX, originZ}
 *   dungeon.isWalkable(x, z)
 *   dungeon.clearanceAt(x, z)
 *   dungeon.floorHeightAt(x, z)  (also .floorAt / .groundAt / .heightAt)
 *   dungeon.spawnPoints(kind)
 */

import * as THREE from 'three';
import { fbm2 } from '../core/Rand.js';
import { InstanceCuller } from '../core/InstanceCull.js';
import { SPEC, CELL } from './dungeon/Spec.js';
import { Layout } from './dungeon/Layout.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Kit, LADDER, snap } from './dungeon/Pieces.js';
import { buildArena } from './dungeon/Arena.js';
import { trsInto } from './dungeon/Geom.js';

const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const HALF_PI = Math.PI * 0.5;
const TAU = Math.PI * 2;

/** Playable footprint. Smaller than the 88 m in Spec: the isometric frame only
 *  ever contains ~40 x 30 m, and the rock mass hides everything past the edge,
 *  so the metres beyond 36 cost triangles and buy nothing. */
const FOOTPRINT = 72;

/**
 * The dungeon grounds its flagging on the crypt biome's heightfield so that an
 * actor placed with `terrain.heightAt` stands exactly on our slabs — the lift is
 * only the bedding mortar.
 *
 * Two surfaces cannot both be the crypt floor: the terrain heightfield renders
 * up to 12 cm above what `heightAt` reports (its LOD chunks interpolate between
 * heightfield nodes and its skirts overshoot), so any flagging low enough to
 * keep feet on the ground loses the depth test to it in patches. While an
 * interior is built the dungeon therefore hides the terrain surface — the data
 * side (heightAt / isWalkable / NavGrid) is untouched, and visibility is
 * restored the moment the dungeon deactivates for an exterior scenario.
 */
const FLOOR_LIFT = 0.03;

/** metres-per-texture-tile -> texture repeat */
const rep = (metres) => 1 / metres;

/**
 * Per-instance look for a debris pile, in one place so the four call sites agree.
 * Consumes exactly three `r()`, in tint, rough, hue order.
 *
 * VALUE, 0.76-1.00 -> 0.90-1.12. The new `Kit.rubble` is chipped rather than
 * chamfered and beds each block on a spall plate, which is a lot of extra facets
 * turned away from a light 3 m up. Measured on `closeup`: at the old value the frame
 * sat at 0.2614 with 0.527 % merged solid black, at this one 0.2653 with 0.470 %,
 * and the debris' own sampled pixels went 0.365 -> 0.375. That pays part of the
 * geometry back where it was lost instead of lifting the whole frame, and it is
 * honest — stone broken to fresh faces is lighter than the weathered course it fell
 * off, so the old value was darkening the one thing in frame that should be
 * brightest. It does not pay all of it back: `closeup` is 0.2653 against 0.2776
 * before this lane, and buying the last 0.012 here would take +45 % albedo, which is
 * chalk. Debris that is legible is worth 4 % of frame mean.
 *
 * TEMPERATURE, symmetric -> warm-biased. Every other piece in the kit jitters hue
 * symmetrically about 0, right for masonry that is damp in some bays and dusty in
 * others. Debris is the class the critic called COLD, and physically it is: an
 * isometric camera sees mostly its up-faces, the practicals rake verticals, so a
 * horizontal facet's only illuminant is an ambient probe that is cold by art
 * direction. A `+0.26` mean is +1.3 % red and -1.2 % blue on the instance colour —
 * far less than it sounds (+0.4 % luma), and it reads as settled dust rather than as
 * a different stone. The remaining +/-0.25 keeps the pile-to-pile spread.
 */
const RUBBLE_LOOK = (r) => ({
  tint: 0.90 + r() * 0.22,
  rough: 0.95 + r() * 0.3,
  hue: 0.26 + (r() - 0.5) * 0.5,
});

const MAT_DEFS = {
  // 3 x 5 blocks per tile at 1.62 m -> a 0.54 x 0.32 m ashlar, per the scale table
  stone: { kind: 'stone', uv: 1.62, size: 1024, seed: 811, color: 0xccd3de },
  // 9 setts per tile at 2.05 m -> a 0.23 m sett
  floor: { kind: 'cobble', uv: 2.05, size: 1024, seed: 419, color: 0xafaa9e },
  rock: { kind: 'stone', uv: SPEC.uv.rock, size: 1024, seed: 977, color: 0x9aa0aa },
  /*
   * The arena's standing masonry — wall panels, buttresses, obelisks. Split off
   * `rock` (same kind, same seed, so `_baseSet` is a cache hit and the four maps
   * are shared clones: no new VRAM, no new sampler, no new program) purely to
   * give it a different LIGHT RESPONSE.
   *
   * WHY IT NEEDED ONE. `hell` is a sunless interior: no directional light, no
   * shadow cascades, and only ~14 practicals survive Lighting's importance cut.
   * Every one of those is on the floor or on a mid-side pilaster, so the six corner
   * buttresses and the panels either side of them are lit by ambient IBL and very
   * little else. Two departures from `rock` for that, and one honest negative:
   *
   *  • `uv: 1.20` instead of 3.10 m per tile — the change that carries this. On a
   *    6.2 m panel the old tiling laid two texture tiles top to bottom, so the
   *    ashlar coursing, the spalled arrises and the quartz fleck were magnified
   *    2.6x past the point where they read as surface. At 1.20 m the generator's
   *    5-course ashlar lands at 0.24 m per course, the right size for cyclopean
   *    basalt seen from 22 m up, and gives the eye something to catch.
   *  • `aoMapIntensity: 0.35`. Ambient occlusion attenuates ambient, and on a
   *    surface whose only light IS ambient the cavity map multiplies the one
   *    contribution it has. Correct for a wall with a key light, backwards here.
   *  • `emissive: 0x30201a` and `envMapIntensity: 3.4` are the ambient bounce a
   *    basalt room full of lava has, and they cost no sampler and cannot be
   *    importance-culled — but be clear that NEITHER fixed the black shape this
   *    room was failing on. Measured on the frozen boss frame: raising
   *    `envMapIntensity` from 1 to 3.4 moved the void's luma by 0.0000, and forcing
   *    emissive to red at six times intensity moved it by 0.0000 as well. That
   *    shape was this geometry's own cast shadow, and it is fixed in
   *    dungeon/Arena.js where the panels stop casting. These two stay because they
   *    are right for a wall lit only by bounce, not because they earned the fix.
   *
   * No `emissiveIntensity` key on purpose — supplying one would enrol this material
   * in `_emissiveMats` and make a stone wall pulse like a brazier.
   */
  crag: {
    kind: 'stone', uv: 1.20, size: 1024, seed: 977, color: 0x9aa0aa,
    over: { envMapIntensity: 3.4, aoMapIntensity: 0.35, emissive: 0x30201a },
  },
  // The mass the crypt is buried in. Earth, not masonry: the surrounding cap is
  // most of the frame outside the rooms, and if it reads as coursed blocks the
  // whole picture reads as brickwork.
  cap: { kind: 'dirt', uv: 3.2, size: 512, seed: 541, color: 0x6f6c62 },
  dirt: { kind: 'dirt', uv: SPEC.uv.dirt, size: 512, seed: 233, color: 0xcdc0a8 },
  iron: { kind: 'metal', uv: SPEC.uv.iron, size: 512, seed: 613, color: 0xdedbd6 },
  wood: { kind: 'wood', uv: SPEC.uv.wood, size: 512, seed: 331, color: 0xd2c1a4 },
  bone: { kind: 'bone', uv: SPEC.uv.bone, size: 512, seed: 727, color: 0xf3ecda },
  ember: {
    kind: 'ash', uv: 0.40, size: 512, seed: 149, color: 0x3a2a1e,
    over: { emissive: 0xff5a16, emissiveIntensity: 1.12 },
  },
  lava: {
    kind: 'ash', uv: SPEC.uv.lava, size: 512, seed: 907, color: 0x241a14,
    over: { emissive: 0xff5410, emissiveIntensity: 3.2 },
  },
};

/** Biome grading, applied to the shared materials — never a new texture set. */
const BIOME_TINT = {
  // Tints multiply an albedo the generators already author at realistic stone
  // reflectance (0.15 - 0.35), so they sit near white. A "dark stone" tint here
  // lands the surface at charcoal and no amount of torchlight recovers it.
  crypt: { stone: 0xccd3de, floor: 0xafaa9e, rock: 0x9aa0aa, crag: 0x9aa0aa, cap: 0x6f6c62, dirt: 0xbdb098, iron: 0xd6d3ce },
  // Basalt, not sandstone. These were authored at the same reflectance as the
  // crypt's limestone, which put the arena floor at ~0.35 display grey filling the
  // whole frame — a milky plane with the lava moat and the braziers unable to read
  // as the accent against it. Volcanic rock reflects 6-10 %.
  /*
   * `crag` is graded 0xa08a79 against `rock`'s 0x7d6a5e — a stop and a half
   * brighter, and warmer. Not a licence to make hell pale: it applies only to the
   * standing masonry, which in this room is the one surface class with no key
   * light on it, and 0x7d6a5e reflectance under ambient alone measured 0.013.
   */
  hell: { stone: 0x8e7264, floor: 0x83685c, rock: 0x7d6a5e, crag: 0xa08a79, cap: 0x54402f, dirt: 0x8a7058, iron: 0xc9b5a4 },
};

/** Pieces that must occlude light. Floors, relief and dressing need not. */
const CAST = { yes: true, no: false };

/**
 * Ceiling classes, for the isometric roof cull.
 *
 * `shell` is the vault infill — webs and lunettes, the solid surfaces that make
 * the crypt a sealed volume. `rib` is the structural skeleton: the transverse and
 * formeret arches those webs span between.
 *
 * A closed vault is correct architecture and dead wrong for a camera 22 m above a
 * room whose ceiling springs at 4.3 m: it covers the play space and the frame
 * becomes a photograph of a roof. Every isometric ARPG culls interior ceilings for
 * the gameplay camera, so we do too. Both classes go: seen from directly overhead
 * the bare ribs stop reading as architecture and become a lattice of hoops across
 * the play space, which hides the hero as effectively as the webs did. The broken
 * rib stubs inside the collapse count as ribs for the same reason: from overhead
 * they sit *over* the fighting floor and read as tangled noodles, not as ruin.
 */
const ROOF = { none: 0, shell: 1, rib: 2 };

/**
 * Draw-call welding (see `_flushBatches`). A batch with `WELD_MAX_INSTANCES`
 * instances or fewer is baked into a shared mesh instead of costing its own draw.
 *
 * `WELD_CELL` is the spatial bucket that keeps the weld cullable, and
 * `WELD_MAX_TRIS` is what makes the trade profitable: welding is draw calls
 * bought with culling granularity, so it must only ever apply to pieces cheap
 * enough that drawing a whole bucket off-screen is not worth its own test. At an
 * 18 m bucket with no triangle cap the crypt's chunky one-offs — a portcullis, a
 * sarcophagus, a 3 k-triangle door — went in too and cost 160 k triangles per
 * pass in lost culling to save calls they were already earning.
 */
const WELD_MAX_INSTANCES = 3;
const WELD_CELL = 12;
const WELD_MAX_TRIS = 1200;

export class Dungeon {
  static id = 'dungeon';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.group = new THREE.Group();
    this.group.name = 'Dungeon';
    this.group.visible = false;

    this.mode = 'off';                 // 'off' | 'crypt' | 'arena'
    this.biome = 'crypt';
    this.active = false;
    this.floorY = 0;
    this.seed = 20250728;

    /** @type {Array<object>} */ this.rooms = [];
    this.layout = null;
    this.arena = null;
    this.bounds = { minX: -1, maxX: 1, minZ: -1, maxZ: 1, minY: 0, maxY: 1 };
    this.navMask = null;

    this.materials = new Map();
    this.kit = null;
    this._batches = new Map();
    this._claimed = new Set();
    this._meshes = [];
    this._roofMeshes = [];
    this._roofHidden = false;
    this._unique = [];
    this._torches = [];
    this._fixtures = [];
    this._spawns = { player: [], enemy: [], boss: [], prop: [], loot: [], light: [] };
    this._emissiveMats = [];
    this._oculus = { x: 0, z: 0, r: 6 };
    this._altar = null;
    this._ground = null;
    this._gMin = 0;
    this._gMax = 0;
    this._terrainHidden = false;
    this._buildMs = 0;
    this._stats = { instances: 0, batches: 0, tris: 0 };
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    this.engine.scene.add(this.group);
    this._buildMaterials();
    this.kit = new Kit(this.engine.rand(this.seed));
    if (!this.engine.scenario) this._setMode('crypt', 'crypt');
  }

  applyScenario(name, cfg) {
    const env = cfg?.env ?? {};
    const biome = env.biome ?? 'crypt';
    const isArena = cfg?.spawn?.props === 'arena' || biome === 'hell';
    let mode = 'off';
    if (isArena) mode = 'arena';
    else if (biome === 'crypt' || env.interior) mode = 'crypt';
    this._setMode(mode, biome);
  }

  _setMode(mode, biome) {
    /**
     * (mode, biome) alone is NOT a sufficient memo, because the FLOOR can move
     * underneath an already-built dungeon.
     *
     * On the live default boot (no `?shot=` param) Terrain.init() comes up on the
     * 'moor' heightfield, so init()'s `_setMode('crypt','crypt')` bakes the
     * flagging onto hills at y~4. main.js then applies the 'dungeon' scenario,
     * Terrain rebuilds flat to the 'crypt' field at y~0 — but applyScenario asks
     * for the SAME ('crypt','crypt'), so this memo used to early-return and the
     * geometry was never re-laid. Actors are placed live through floorHeightAt(),
     * which is a closure over the NEW terrain, so every character ended up ~3.5 m
     * beneath a floor frozen on the old one and was occluded by it — the player
     * saw an empty room.
     *
     * The `?shot=` harness path never reproduced it (Terrain boots straight to
     * 'crypt'), which is exactly why screenshot verification kept passing.
     */
    const groundMoved =
      mode !== 'off' && this._ground && Math.abs(this._g(0, 0) - this.floorY) > 0.05;
    if (mode === this.mode && biome === this.biome && !groundMoved) {
      this._reseatLights();
      return;
    }
    this.mode = mode;
    this.biome = biome;
    this._applyTint(biome);
    if (mode === 'off') {
      this._teardown();
      this.group.visible = false;
      this.active = false;
      this.layout = null;
      this.rooms = [];
      this.navMask = null;
      return;
    }
    try {
      const t0 = now();
      this._teardown();
      this._resolveGround();
      if (mode === 'arena') this._buildArena();
      else this._buildCrypt();
      this._flushBatches();
      this._cullRoof();
      this._buildMs = now() - t0;
      this.group.visible = true;
      this.active = true;
      this._hideTerrainSurface(true);
      this.engine.get('sky')?.applyFogToScene?.(this.group);
      this.engine.bus.emit('lighting:rescan', {});
      this.engine.bus.emit('dungeon:built', {
        mode, bounds: this.bounds, rooms: this.rooms.length,
      });
      console.info(
        `[dungeon] ${mode} built in ${this._buildMs.toFixed(0)}ms — ${this.rooms.length} rooms, ` +
        `${this._stats.batches} draw batches, ${this._stats.instances} instances, ` +
        `${(this._stats.tris / 1000) | 0}k tris, ${this._torches.length} practicals`);
    } catch (e) {
      console.error('[dungeon] build failed —', e);
      this._teardown();
      this.group.visible = false;
      this.active = false;
    }
  }

  update(dt, elapsed) {
    if (!this.active) return;
    // The camera moves, so the roof cull is re-evaluated — cheaply, and only
    // every eighth frame; it only ever flips when the camera crosses the
    // springing line, which gameplay never does.
    if ((this.engine.clock.frame & 7) === 0) this._cullRoof();
    // Coals and lava breathe. Deterministic: driven only by engine.clock.
    for (let i = 0; i < this._emissiveMats.length; i++) {
      const e = this._emissiveMats[i];
      const f = 0.80 + 0.20 * Math.sin(elapsed * e.hz + e.ph) +
        0.11 * Math.sin(elapsed * e.hz * 2.7 + e.ph * 1.7);
      e.mat.emissiveIntensity = e.base * f;
    }
    void dt;
  }

  dispose() {
    this._teardown();
    this._hideTerrainSurface(false);
    for (const m of this.materials.values()) { try { m.dispose(); } catch { /* noop */ } }
    this.materials.clear();
    this.kit?.dispose();
    this.kit = null;
    this.group.removeFromParent();
  }

  /**
   * Take (or release) ownership of the interior ground plane. Guarded both ways:
   * a missing or dead Terrain module simply means there was nothing to hide.
   */
  _hideTerrainSurface(hide) {
    if (hide === this._terrainHidden) return;
    try {
      const t = this.engine.get('terrain');
      const g = t && !t.__dead ? t.group : null;
      if (!g) return;
      g.visible = !hide;
      this._terrainHidden = hide;
    } catch { /* terrain absent — nothing to own */ }
  }

  _teardown() {
    this._hideTerrainSurface(false);
    const lighting = this.engine.get('lighting');
    for (const t of this._torches) { try { lighting?.removeTorch?.(t); } catch { /* noop */ } }
    this._torches.length = 0;
    this._fixtures.length = 0;
    for (const mesh of this._meshes) mesh.removeFromParent();
    // Detached meshes must leave the culler with them, or a scenario rebuild
    // leaks an entry that keeps pointing at dead GPU buffers.
    try { this.engine.instanceCull?.prune(); } catch { /* noop */ }
    this._meshes.length = 0;
    this._roofMeshes.length = 0;
    this._roofHidden = false;
    for (const g of this._unique) { try { g.dispose(); } catch { /* noop */ } }
    this._unique.length = 0;
    this._batches.clear();
    this._claimed.clear();
    this._altar = null;
    for (const k in this._spawns) this._spawns[k].length = 0;
    this._stats = { instances: 0, batches: 0, tris: 0 };
    while (this.group.children.length) this.group.remove(this.group.children[0]);
  }

  /* ================================================================ *
   * ground
   * ================================================================ */

  /**
   * The crypt biome's heightfield is authored as the interior slab floor, so the
   * dungeon grounds on it instead of assuming y = 0. Everything else in the game
   * places actors with `terrain.heightAt`, and this is what keeps their feet on
   * our flagstones.
   */
  _resolveGround() {
    const t = this.engine.get('terrain');
    const ok = t && !t.__dead && typeof t.heightAt === 'function';
    this._ground = ok
      ? (x, z) => {
        const h = t.heightAt(x, z);
        return (Number.isFinite(h) ? Math.max(-4, Math.min(4, h)) : 0) + FLOOR_LIFT;
      }
      : () => FLOOR_LIFT;
    let lo = Infinity, hi = -Infinity;
    const half = FOOTPRINT * 0.5 + 2;
    for (let z = -half; z <= half; z += 2) {
      for (let x = -half; x <= half; x += 2) {
        const h = this._ground(x, z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    this._gMin = Number.isFinite(lo) ? lo : 0;
    this._gMax = Number.isFinite(hi) ? hi : 0;
    this.floorY = this._ground(0, 0);
  }

  _g(x, z) { return this._ground ? this._ground(x, z) : 0; }

  /* ================================================================ *
   * materials
   * ================================================================ */

  _buildMaterials() {
    const assets = this.engine.assets;
    for (const key in MAT_DEFS) {
      const d = MAT_DEFS[key];
      let mat;
      try {
        mat = assets.material({
          kind: d.kind, size: d.size, seed: d.seed, tiling: rep(d.uv),
          unique: true, color: d.color, ...(d.over ?? {}),
        });
      } catch (e) {
        console.warn(`[dungeon] material ${key} degraded —`, e);
        mat = new THREE.MeshStandardMaterial({ color: d.color ?? 0x8a8a8a, roughness: 0.9, metalness: 0.02 });
      }
      mat.name = `dungeon:${key}`;
      mat.side = THREE.FrontSide;
      mat.shadowSide = THREE.FrontSide;
      /*
       * Fragment texture-unit budget. WebGL2 only guarantees 16 samplers, and the
       * shadow maps (4 CSM cascades + the practical pools), the env probe and the
       * irradiance volume claim nine of them in every lit material. Ashlar, dirt,
       * cobble, bone, wood and ash are dielectrics: their metalness is a constant,
       * so a full metalness map is a sampler spent on a texture that reads 0
       * everywhere. Dropping it is what keeps these programs linkable — without
       * it `dungeon:stone`, `dungeon:cap` and `dungeon:ember` exceeded the limit
       * and did not render at all. Iron keeps its map: edge wear to bright metal
       * is the whole point of the recipe.
       */
      if (key !== 'iron') {
        if (mat.metalnessMap) { mat.metalnessMap = null; mat.needsUpdate = true; }
        mat.metalness = key === 'ember' || key === 'lava' ? 0.04 : 0.0;
      }
      this._instanceRoughness(mat);
      this.engine.get('sky')?.applyFog?.(mat);
      this.engine.get('lighting')?.registerMaterial?.(mat);
      if (d.over?.emissiveIntensity) {
        this._emissiveMats.push({
          mat, base: d.over.emissiveIntensity,
          hz: key === 'lava' ? 0.55 : 1.35,
          ph: key === 'lava' ? 1.9 : 0.4,
        });
      }
      this.materials.set(key, mat);
    }
  }

  /**
   * Per-instance roughness multiplier. Uniform roughness across two thousand
   * instanced stones is the loudest "plastic" tell there is; a ±25 % spread
   * costs one float per instance.
   *
   * Assigned before Sky.applyFog and Lighting.registerMaterial so both compose
   * on top of this hook instead of replacing it. Falls back to 1.0 when the
   * attribute is absent, so the same material is safe on ordinary meshes.
   */
  _instanceRoughness(mat) {
    mat.onBeforeCompile = (shader) => {
      if (shader.vertexShader.includes('aDungRough')) return;
      shader.vertexShader = 'attribute float aDungRough;\nattribute vec3 aDungTint;\n' +
        'varying float vDungRough;\nvarying vec3 vDungTint;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvDungRough = aDungRough;\n\tvDungTint = aDungTint;');
      shader.fragmentShader = 'varying float vDungRough;\nvarying vec3 vDungTint;\n' +
        shader.fragmentShader
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n\tif ( vDungRough > 0.001 ) roughnessFactor = clamp( roughnessFactor * vDungRough, 0.05, 1.0 );')
          /*
           * The welded (draw-call-merged) meshes carry their per-piece tint here
           * instead of in `instanceColor`, because a weld is one instance holding
           * dozens of pieces. An unbound attribute reads (0,0,0), which is what
           * the guard tests — so an ordinary instanced mesh takes the vColor path
           * below untouched and both share one compiled program.
           */
          .replace(
            '#include <color_fragment>',
            '#include <color_fragment>\n\tif ( vDungTint.r + vDungTint.g + vDungTint.b > 0.003 ) diffuseColor.rgb *= vDungTint;');
    };
    const prevKey = mat.customProgramCacheKey;
    mat.customProgramCacheKey = function dungeonKey() {
      let base = '';
      try { base = typeof prevKey === 'function' ? String(prevKey.call(this)) : ''; } catch { base = ''; }
      return `${base}|dungeon-rough-v2`;
    };
    mat.needsUpdate = true;
  }

  _applyTint(biome) {
    const t = BIOME_TINT[biome] ?? BIOME_TINT.crypt;
    for (const key in t) {
      const mat = this.materials.get(key);
      if (mat) mat.color.setHex(t[key]);
    }
  }

  /* ================================================================ *
   * batching
   * ================================================================ */

  /**
   * Queue one instance.
   * @param {THREE.BufferGeometry} geo
   * @param {string} matKey
   * @param {THREE.Matrix4} matrix
   * @param {{tint?:number, rough?:number, hue?:number, shadow?:boolean}} o
   */
  _push(geo, matKey, matrix, o) {
    if (!geo) return;
    const mat = this.materials.get(matKey);
    if (!mat) return;
    const shadow = o.shadow !== false;
    const roof = o.roof | 0;
    const key = `${geo.uuid}|${matKey}|${shadow ? 1 : 0}|${roof}`;
    let b = this._batches.get(key);
    if (!b) this._batches.set(key, (b = { geo, mat, shadow, roof, m: [], c: [], r: [] }));
    b.m.push(matrix.clone());
    b.c.push(o.tint ?? 1, o.hue ?? 0);
    b.r.push(o.rough ?? 1);
  }

  /** Push every material part of a kit piece with one transform. */
  _pushPiece(piece, matrix, o) {
    if (!piece) return;
    for (const key in piece) this._push(piece[key], key, matrix, o);
  }

  /** Add a one-off merged mesh (rock mass, substrate, arena floor). */
  _pushUnique(geo, matKey, opts = {}) {
    const mat = this.materials.get(matKey);
    if (!geo || !mat) return null;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = opts.castShadow === true;
    mesh.receiveShadow = opts.receiveShadow !== false;
    mesh.matrixAutoUpdate = false;
    if (opts.position) mesh.position.copy(opts.position);
    mesh.updateMatrix();
    mesh.name = opts.name ?? `dungeon:${matKey}`;
    this.group.add(mesh);
    this._meshes.push(mesh);
    this._stats.tris += geo.attributes.position.count / 3;
    return mesh;
  }

  _flushBatches() {
    /** @type {Map<string, {mat:THREE.Material, shadow:boolean, roof:number, items:object[]}>} */
    const weld = new Map();
    for (const [, b] of this._batches) {
      const n = b.m.length;
      if (!n) continue;

      /*
       * A batch of one or two is instancing that did not pay for itself. The kit
       * memoises by (builder, arguments), so a wall panel cut to a length no other
       * wall shares, a portal at an odd span, a one-off sarcophagus — each ends up
       * as its own InstancedMesh with a single matrix in it. Measured on `combat`:
       * 204 of the crypt's 302 meshes, carrying 6 % of its triangles between them
       * but 68 % of its draw calls, and every one of them re-submitted for the
       * depth prepass and each of the seventeen shadow renders.
       *
       * Those get welded into one mesh per (material, shadow class, roof class,
       * spatial cell) with their transforms baked in. The cell is what keeps this
       * from trading draw calls for triangles: an 18 m bucket is still culled as a
       * unit, so an off-screen corner of the crypt costs nothing, exactly as it
       * did when its dressing was 40 separate objects.
       */
      if (n <= WELD_MAX_INSTANCES && this._weldable(b.geo)) {
        for (let i = 0; i < n; i++) {
          const m = b.m[i];
          const cx = Math.floor(m.elements[12] / WELD_CELL);
          const cz = Math.floor(m.elements[14] / WELD_CELL);
          const key = `${b.mat.uuid}|${b.shadow ? 1 : 0}|${b.roof}|${cx},${cz}|${this._geoSig(b.geo)}`;
          let g = weld.get(key);
          if (!g) weld.set(key, (g = { mat: b.mat, shadow: b.shadow, roof: b.roof, items: [] }));
          g.items.push({
            geo: b.geo, matrix: m,
            tint: b.c[i * 2], hue: b.c[i * 2 + 1], rough: b.r[i],
          });
        }
        continue;
      }

      let geo = b.geo;
      if (this._claimed.has(geo.uuid)) {
        geo = b.geo.clone();
        this._unique.push(geo);
      } else {
        this._claimed.add(geo.uuid);
      }
      const mesh = new THREE.InstancedMesh(geo, b.mat, n);
      mesh.castShadow = b.shadow;
      mesh.receiveShadow = true;
      if (b.roof) { mesh.userData.roof = b.roof; this._roofMeshes.push(mesh); }
      const rough = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, b.m[i]);
        const tint = b.c[i * 2], hue = b.c[i * 2 + 1];
        // hue jitter leans cool where stone is damp, warm where dust settles —
        // a spread of value and temperature, never of saturation
        _col.setRGB(tint * (1 + hue * 0.050), tint * (1 + hue * 0.010), tint * (1 - hue * 0.046));
        mesh.setColorAt(i, _col);
        rough[i] = b.r[i];
      }
      geo.setAttribute('aDungRough', new THREE.InstancedBufferAttribute(rough, 1));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this._meshes.push(mesh);
      this._stats.batches++;
      this._stats.instances += n;
      this._stats.tris += (geo.attributes.position.count / 3) * n;
    }
    this._flushWeld(weld);
    this._batches.clear();
    this._registerCulling();
  }

  /**
   * Only weld geometry whose attribute set the kit guarantees: `mergeGeometries`
   * requires every part to agree, and a piece that ever grows a tangent or a
   * second UV must fall back to instancing rather than silently drop it.
   */
  _weldable(geo) {
    const a = geo.attributes;
    if (geo.index || !a.position || !a.normal || !a.uv || Object.keys(a).length !== 3) return false;
    return a.position.count / 3 <= WELD_MAX_TRIS;
  }

  _geoSig(geo) {
    return Object.keys(geo.attributes).sort().join(',');
  }

  /**
   * Bake a welded cell into one mesh.
   *
   * The per-instance shader inputs move from instance attributes to VERTEX
   * attributes — `aDungRough` needs no shader change at all (it is declared as a
   * plain `attribute float`, which reads from either), and the instance tint moves
   * to `aDungTint`, handled by the same `onBeforeCompile` every dungeon material
   * already carries. Both guard on "is the attribute actually bound", so one hook
   * and therefore ONE PROGRAM serves welded and instanced meshes alike; a plain
   * `THREE.Mesh` here would have cost a second non-instanced program variant per
   * material instead.
   */
  _flushWeld(weld) {
    if (!weld.size) return;
    const identity = new THREE.Matrix4();
    const white = new THREE.Color(1, 1, 1);
    for (const [, g] of weld) {
      const parts = [];
      try {
        for (const it of g.items) {
          const p = it.geo.clone();
          p.applyMatrix4(it.matrix);
          const vc = p.attributes.position.count;
          const rough = new Float32Array(vc);
          rough.fill(it.rough ?? 1);
          p.setAttribute('aDungRough', new THREE.BufferAttribute(rough, 1));
          const tint = it.tint ?? 1, hue = it.hue ?? 0;
          _col.setRGB(tint * (1 + hue * 0.050), tint * (1 + hue * 0.010), tint * (1 - hue * 0.046));
          const tv = new Float32Array(vc * 3);
          for (let k = 0, o = 0; k < vc; k++, o += 3) {
            tv[o] = _col.r; tv[o + 1] = _col.g; tv[o + 2] = _col.b;
          }
          p.setAttribute('aDungTint', new THREE.BufferAttribute(tv, 3));
          parts.push(p);
        }
        const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
        if (!merged) throw new Error('mergeGeometries returned null');
        if (merged !== parts[0]) for (const p of parts) p.dispose();
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        this._unique.push(merged);

        // count 1, but still an InstancedMesh: same program as its instanced kin.
        const mesh = new THREE.InstancedMesh(merged, g.mat, 1);
        mesh.name = 'dungeon:weld';
        mesh.castShadow = g.shadow;
        mesh.receiveShadow = true;
        mesh.setMatrixAt(0, identity);
        mesh.setColorAt(0, white);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (g.roof) { mesh.userData.roof = g.roof; this._roofMeshes.push(mesh); }
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        this._meshes.push(mesh);
        this._stats.batches++;
        this._stats.instances += g.items.length;
        this._stats.welded = (this._stats.welded ?? 0) + g.items.length;
        this._stats.tris += merged.attributes.position.count / 3;
      } catch (e) {
        // Degrade to the instanced path rather than lose the geometry.
        for (const p of parts) { try { p.dispose(); } catch { /* noop */ } }
        console.warn('[dungeon] weld failed, falling back to instances —', e?.message ?? e);
        for (const it of g.items) {
          const geo = it.geo.clone();
          this._unique.push(geo);
          const mesh = new THREE.InstancedMesh(geo, g.mat, 1);
          mesh.castShadow = g.shadow;
          mesh.receiveShadow = true;
          mesh.setMatrixAt(0, it.matrix);
          _col.setRGB(it.tint, it.tint, it.tint);
          mesh.setColorAt(0, _col);
          geo.setAttribute('aDungRough', new THREE.InstancedBufferAttribute(new Float32Array([it.rough ?? 1]), 1));
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          if (g.roof) { mesh.userData.roof = g.roof; this._roofMeshes.push(mesh); }
          mesh.computeBoundingSphere();
          this.group.add(mesh);
          this._meshes.push(mesh);
          this._stats.batches++;
          this._stats.instances += 1;
        }
      }
    }
  }

  /**
   * Hand the finished batches to the per-instance culler.
   *
   * Crypt batches span the whole 72 m footprint, so three's per-OBJECT culling
   * never rejects one: measured on `combat`, 899 k of the dungeon's 927 k
   * triangles were submitted every pass and only 287 k of them were inside the
   * frustum. The instance data is written once in `_flushBatches` and never
   * touched again (the roof cull toggles whole-mesh `visible`, nothing else), so
   * this module satisfies the culler's ownership contract exactly.
   */
  _registerCulling() {
    try {
      const culler = InstanceCuller.attach(this.engine);
      if (!culler) return;
      culler.prune();
      let n = 0;
      for (const mesh of this._meshes) if (mesh.isInstancedMesh === true && culler.add(mesh)) n++;
      this._culledBatches = n;
    } catch (e) {
      console.warn('[dungeon] instance culling unavailable —', e?.message ?? e);
    }
  }

  /**
   * Isometric roof cull. Hides the vaulting whenever the camera sits above the
   * springing line and is therefore looking down into the rooms. Below it — an
   * interior close-up, a doorway shot — the vault comes back and the crypt is a
   * sealed volume again.
   */
  _cullRoof() {
    if (!this._roofMeshes.length) return;
    const camY = this.engine.camera?.position?.y ?? 0;
    const hide = camY > this._gMax + SPEC.vault.spring + 0.6;
    if (hide === this._roofHidden) return;
    this._roofHidden = hide;
    for (const m of this._roofMeshes) m.visible = !hide;
  }

  /* ================================================================ *
   * crypt
   * ================================================================ */

  _buildCrypt() {
    const eng = this.engine;
    const layout = new Layout({
      rand: eng.freshRand(this.seed),
      footprint: FOOTPRINT,
      cell: CELL,
      corridorW: SPEC.corridorW,
    }).build();
    this.layout = layout;
    this.rooms = layout.rooms;
    this.bounds = {
      ...layout.bounds,
      minY: this._gMin + SPEC.floor.substrate - 0.4,
      maxY: this._gMax + SPEC.wall.h + 2.8,
    };

    const hall = layout.hall ?? layout.rooms[0];
    // The collapse sits just off the origin: every crypt scenario aims its
    // camera there, and an off-centre light pool composes better than a
    // bullseye.
    this._oculus = hall
      ? { x: hall.cx * 0.25 - 0.5, z: hall.cz * 0.25 + 2.3, rx: 5.1, rz: 4.4, r: 4.7 }
      : { x: 0, z: 2.3, rx: 5.1, rz: 4.4, r: 4.7 };

    const nz = (x, z) => fbm2(x * 0.09, z * 0.09, { octaves: 4, seed: 4471 });
    const focus = { x: 0, z: 0 };

    /* ---- ground ---- */
    // dirt bed just under the flagging, seen through every missing slab
    const sub = this.kit.substrate(FOOTPRINT + 6, 3.0, nz, (x, z) => this._g(x, z) + 0.10);
    this._unique.push(sub);
    this._pushUnique(sub, 'dirt', { name: 'dungeon:substrate' });

    this._layFloor(layout, eng.freshRand(this.seed ^ 0x1111), focus);

    const rock = this.kit.rockMass(layout.rockMask(1), {
      W: layout.W, cell: layout.cell, originX: layout.originX, originZ: layout.originZ,
    }, {
      noise: nz,
      top: this._gMax + SPEC.cap.y,
      edgeY: this._gMax + SPEC.cap.edgeY,
      floorY: this._gMin - 1.4,
      relief: 0.95,
    });
    this._unique.push(rock);
    this._pushUnique(rock, 'cap', { name: 'dungeon:rockmass', castShadow: false });

    const apron = this.kit.rockApron(FOOTPRINT, FOOTPRINT * 0.5 + SPEC.margin, 2.4, nz, this._gMax);
    this._unique.push(apron);
    this._pushUnique(apron, 'cap', { name: 'dungeon:apron' });

    /* ---- architecture ---- */
    this._raiseWalls(layout, eng.freshRand(this.seed ^ 0x2222), focus);
    this._raisePortals(layout, eng.freshRand(this.seed ^ 0x3333));
    this._raiseVaults(layout, eng.freshRand(this.seed ^ 0x4444), focus);
    this._raiseColumns(layout, eng.freshRand(this.seed ^ 0x5555));
    this._dress(layout, eng.freshRand(this.seed ^ 0x6666), focus);

    layout.refreshClearance();
    this.navMask = {
      data: layout.nav, clearance: layout.clear, W: layout.W, cell: layout.cell,
      originX: layout.originX, originZ: layout.originZ,
    };
    this._makeSpawns(layout, eng.freshRand(this.seed ^ 0x7777));
    this._lightCrypt(layout, eng.freshRand(this.seed ^ 0x8888));
  }

  /** Ellipse test for the collapsed roof over the great hall. */
  _inOculus(x, z, pad = 0) { return inOculus(this._oculus, x, z, pad); }

  /** Detail tier from distance to the camera focus. */
  _tier(x, z, focus) {
    const d = Math.hypot(x - focus.x, z - focus.z);
    return d < 16 ? 0 : d < 27 ? 1 : 2;
  }

  /* ---------------------------------------------------------- floors -- */

  /**
   * Flagged floor. Row bands of varied depth are packed with slabs of varied
   * width, phase-shifted per band; some are cracked and parted, some are gone so
   * the dirt substrate shows through, and every slab carries its own subsidence
   * dish, tilt, and colour/roughness jitter. Slab geometry comes from a small
   * ladder of canonical sizes and is scaled to fit, so two thousand slabs cost
   * about twenty draw calls.
   */
  _layFloor(layout, r, focus) {
    const W = layout.W;
    let j = 0;
    while (j < W) {
      const j1 = Math.min(W, j + (2 + (r() < 0.34 ? 1 : 0)));
      const bd = (j1 - j) * layout.cell;
      let i = 0;
      while (i < W) {
        let ok = true;
        for (let jj = j; jj < j1 && ok; jj++) if (!layout.isOpenCell(i, jj)) ok = false;
        if (!ok) { i++; continue; }
        let i1 = i;
        while (i1 < W) {
          let good = true;
          for (let jj = j; jj < j1 && good; jj++) if (!layout.isOpenCell(i1, jj)) good = false;
          if (!good) break;
          i1++;
        }
        this._packRow(layout, i, i1, j, bd, r, focus);
        i = i1 + 1;
      }
      j = j1;
    }
  }

  _packRow(layout, i0, i1, j0, bd, r, focus) {
    const kit = this.kit;
    const cell = layout.cell;
    const z = layout.zOf(j0) + bd * 0.5;
    const sd = snap(bd, LADDER.slabD);
    let i = i0;
    let phase = r() < 0.5 ? 0 : 1;
    while (i < i1) {
      const tier = this._tier(layout.xOf(i), z, focus);
      const wCells = tier === 2 ? 4 : (r() < 0.52 ? 2 : r() < 0.9 ? 3 : 4);
      const iEnd = Math.min(i1, i + wCells);
      const bw = (iEnd - i) * cell;
      if (bw < 0.45) { i = iEnd; continue; }
      const x = layout.xOf(i) + bw * 0.5;
      const gy = this._g(x, z);
      const sw = snap(bw, LADDER.slabW);
      const sx = bw / sw, sz = bd / sd;
      const roll = r();
      const variant = (r() * 4) | 0;
      const o = {
        tint: 0.80 + r() * 0.30,
        hue: (r() - 0.5) * 0.8,
        rough: 0.82 + r() * 0.42,
        shadow: CAST.no,
      };
      const sink = -r() * SPEC.floor.subsidence * 0.9;
      if (roll < 0.05 && tier < 2) {
        this._pushPiece(kit.slabVoid(sw, sd, variant),
          trsInto(_m, x, gy, z, 0, 0, 0, sx, 1, sz),
          { tint: 0.9 + r() * 0.2, rough: 1.05 + r() * 0.2, hue: o.hue, shadow: CAST.no });
      } else if (roll < 0.17 && tier < 2) {
        this._pushPiece(kit.slabCracked(sw, sd, variant),
          trsInto(_m, x, gy - SPEC.floor.thick * 0.5 + sink, z, 0, 0, 0, sx, 1, sz), o);
      } else {
        this._pushPiece(kit.slab(sw, sd, variant),
          trsInto(_m, x, gy - SPEC.floor.thick * 0.5 + sink, z,
            (r() - 0.5) * SPEC.floor.tilt, 0, (r() - 0.5) * SPEC.floor.tilt, sx, 1, sz), o);
      }
      i = iEnd;
      phase ^= 1;
    }
  }

  /* ----------------------------------------------------------- walls -- */

  _raiseWalls(layout, r, focus) {
    const kit = this.kit;
    for (const run of layout.wallRuns) {
      const yaw = run.axis === 'x'
        ? (run.side === 1 ? 0 : Math.PI)
        : (run.side === 1 ? HALF_PI : -HALF_PI);
      let s = run.s0;
      const end = run.s1;
      let guard = 0;
      while (s < end - 1e-4 && guard++ < 400) {
        let len = SPEC.wall.panel;
        const left = end - s;
        if (left < SPEC.wall.panel + SPEC.wall.filler * 0.5) len = left;
        else if (r() < 0.22) len = SPEC.wall.panel * 0.5 + SPEC.wall.filler;
        len = Math.max(SPEC.wall.filler, Math.min(left, Math.round(len / SPEC.wall.filler) * SPEC.wall.filler));
        const mid = s + len * 0.5;
        const px = run.axis === 'x' ? mid : run.a;
        const pz = run.axis === 'x' ? run.a : mid;
        const tier = this._tier(px, pz, focus);
        const detail = tier === 0 ? 1 : tier === 1 ? (r() < 0.45 ? 1 : 0) : 0;
        this._pushPiece(kit.wallPanel(len, (r() * 4) | 0, detail),
          trsInto(_m, px, this._g(px, pz), pz, 0, yaw, 0),
          { tint: 0.86 + r() * 0.26, rough: 0.86 + r() * 0.34, hue: (r() - 0.5) * 0.7,
            shadow: tier < 2 });
        // spoil where a wall has shed its facing
        if (tier < 2 && r() < 0.14) {
          const off = (r() - 0.5) * len * 0.6;
          const nx = run.axis === 'x' ? 0 : run.side;
          const nzs = run.axis === 'x' ? run.side : 0;
          const rx = px + nx * (0.40 + r() * 0.30) + (run.axis === 'x' ? off : 0);
          const rz = pz + nzs * (0.40 + r() * 0.30) + (run.axis === 'x' ? 0 : off);
          this._pushPiece(kit.rubble((r() * 4) | 0, 0.55 + r() * 0.4),
            trsInto(_m, rx, this._g(rx, rz), rz, 0, r() * TAU, 0),
            RUBBLE_LOOK(r));
        }
        s += len;
      }
    }
    for (const c of layout.corners) {
      if (this._tier(c.x, c.z, focus) === 2 && r() < 0.5) continue;
      this._pushPiece(kit.pier((r() * 3) | 0),
        trsInto(_m, c.x, this._g(c.x, c.z), c.z, 0, Math.floor(r() * 4) * HALF_PI, 0),
        { tint: 0.88 + r() * 0.22, rough: 0.88 + r() * 0.3, hue: (r() - 0.5) * 0.6 });
    }
  }

  /* --------------------------------------------------------- portals -- */

  _raisePortals(layout, r) {
    const kit = this.kit;
    for (const d of layout.doors) {
      const nArch = Math.max(1, Math.ceil(d.span / 4.1));
      const cellW = d.span / nArch;
      const want = Math.max(1.05, Math.min(2.05, cellW * 0.5 - 0.32));
      const hs = snap(want, LADDER.span);
      const sx = want / hs;
      const yaw = d.axis === 'x' ? 0 : HALF_PI;
      for (let k = 0; k < nArch; k++) {
        const off = -d.span * 0.5 + cellW * (k + 0.5);
        const px = d.axis === 'x' ? d.x + off : d.x;
        const pz = d.axis === 'x' ? d.z : d.z + off;
        const gy = this._g(px, pz);
        this._pushPiece(kit.portal(hs, (r() * 2) | 0),
          trsInto(_m, px, gy, pz, 0, yaw, 0, sx, 1, 1),
          { tint: 0.9 + r() * 0.2, rough: 0.86 + r() * 0.3, hue: (r() - 0.5) * 0.5 });
        // jambs narrow the passage: tell the nav grid
        const jw = want + SPEC.portal.jamb * 0.5;
        for (const sgn of [-1, 1]) {
          const jx = d.axis === 'x' ? px + sgn * jw : px;
          const jz = d.axis === 'x' ? pz : pz + sgn * jw;
          layout.blockRect(jx, jz,
            d.axis === 'x' ? SPEC.portal.jamb : SPEC.portal.thick + 0.2,
            d.axis === 'x' ? SPEC.portal.thick + 0.2 : SPEC.portal.jamb);
        }
        const roll = r();
        if (roll < 0.18) {
          this._pushPiece(kit.portcullis(want * 2 - 0.12, SPEC.portal.spring - 0.2, (r() * 2) | 0),
            trsInto(_m, px, gy + SPEC.portal.spring + 0.6, pz, 0, yaw, 0),
            { tint: 0.9 + r() * 0.2, rough: 0.8 + r() * 0.35, hue: -0.4 });
          for (const sgn of [-1, 1]) {
            const cx = d.axis === 'x' ? px + sgn * (want - 0.22) : px;
            const cz = d.axis === 'x' ? pz : pz + sgn * (want - 0.22);
            this._pushPiece(kit.chain(1.5, 0),
              trsInto(_m, cx, gy + SPEC.portal.spring + 2.2, cz, 0, yaw, 0),
              { tint: 0.9, rough: 0.9, hue: -0.4, shadow: CAST.no });
          }
        } else if (roll < 0.27) {
          this._pushPiece(kit.doorLeaf(want * 2 - 0.16, SPEC.portal.spring - 0.12, (r() * 2) | 0),
            trsInto(_m, px, gy, pz, 0, yaw + (r() - 0.5) * 0.22, 0),
            { tint: 0.86 + r() * 0.2, rough: 0.9 + r() * 0.25, hue: 0.3 });
        }
      }
    }
  }

  /* ---------------------------------------------------------- vaults -- */

  /**
   * Ribbed groin vaults, bay by bay. Bays inside the collapse radius over the
   * great hall lose their web and gain broken rib stubs plus the fallen mass on
   * the floor below — which is what lets the level's only cold light reach the
   * floor, and what stops a ceiling from hiding the play space.
   */
  _raiseVaults(layout, r, focus) {
    const kit = this.kit;
    const oc = this._oculus;
    for (const room of layout.rooms) {
      const B = room.bays;
      if (!B) continue;
      const tier = this._tier(room.cx, room.cz, focus);
      const gy = this._g(room.cx, room.cz);
      const spring = gy + SPEC.vault.spring;
      // A third of the side chambers are open to the rock above: the crypt reads
      // as ruined rather than sealed, their floors take the cold key, and the
      // frame gains lit depth past the hall's portals.
      const ruined = !room.grand && r() < 0.34;
      const gone = (x, z, pad = 0) => ruined || (room.grand && inOculus(oc, x, z, pad));

      /* webs */
      const wSnap = snap(B.bw, LADDER.bay), dSnap = snap(B.bd, LADDER.bay);
      const web = kit.vaultWeb(wSnap, dSnap, 0);
      for (let bj = 0; bj < B.nz; bj++) {
        for (let bi = 0; bi < B.nx; bi++) {
          const cx = room.minX + B.bw * (bi + 0.5);
          const cz = room.minZ + B.bd * (bj + 0.5);
          if (gone(cx, cz, (r() - 0.5) * 1.6)) {
            for (let k = 0; k < 2 + ((r() * 3) | 0); k++) {
              const a = r() * TAU;
              this._pushPiece(kit.ribStub((r() * 3) | 0),
                trsInto(_m, cx + Math.cos(a) * B.bw * 0.5, spring, cz + Math.sin(a) * B.bd * 0.5,
                  0, a + Math.PI, 0),
                { tint: 0.86 + r() * 0.2, rough: 0.95 + r() * 0.3, hue: (r() - 0.5) * 0.6, roof: ROOF.rib });
            }
            const rx = cx + (r() - 0.5) * B.bw * 0.6, rz = cz + (r() - 0.5) * B.bd * 0.6;
            this._pushPiece(kit.rubble((r() * 4) | 0, 0.9 + r() * 0.7),
              trsInto(_m, rx, this._g(rx, rz), rz, 0, r() * TAU, 0),
              RUBBLE_LOOK(r));
            continue;
          }
          if (tier === 2) continue;
          this._pushPiece(web,
            trsInto(_m, cx, spring, cz, 0, 0, 0, B.bw / wSnap, 1, B.bd / dSnap),
            { tint: 0.84 + r() * 0.22, rough: 0.9 + r() * 0.3, hue: (r() - 0.5) * 0.5, roof: ROOF.shell });
        }
      }
      if (tier === 2) continue;

      /* transverse and formeret ribs on every bay line */
      const hsx = B.bw * 0.5, hsz = B.bd * 0.5;
      const sxSnap = snap(hsx, LADDER.span), szSnap = snap(hsz, LADDER.span);
      const ribX = kit.ribArch(sxSnap, 0), ribZ = kit.ribArch(szSnap, 0);
      const lunX = kit.lunette(sxSnap), lunZ = kit.lunette(szSnap);
      const ribO = () => ({ tint: 0.86 + r() * 0.2, rough: 0.9 + r() * 0.28, hue: (r() - 0.5) * 0.4, roof: ROOF.rib });
      for (let bi = 0; bi <= B.nx; bi++) {
        const x = room.minX + B.bw * bi;
        for (let bj = 0; bj < B.nz; bj++) {
          const z = room.minZ + B.bd * (bj + 0.5);
          if (gone(x, z, -0.8)) continue;
          this._pushPiece(ribZ, trsInto(_m, x, spring, z, 0, HALF_PI, 0, hsz / szSnap, 1, 1), ribO());
        }
      }
      for (let bj = 0; bj <= B.nz; bj++) {
        const z = room.minZ + B.bd * bj;
        for (let bi = 0; bi < B.nx; bi++) {
          const x = room.minX + B.bw * (bi + 0.5);
          if (gone(x, z, -0.8)) continue;
          this._pushPiece(ribX, trsInto(_m, x, spring, z, 0, 0, 0, hsx / sxSnap, 1, 1), ribO());
        }
      }
      /* lunettes close the wall between coping and formeret — without them the
         skylight leaks over the top of every wall */
      for (let bi = 0; bi < B.nx; bi++) {
        const x = room.minX + B.bw * (bi + 0.5);
        for (const [z, yaw] of [[room.minZ, 0], [room.maxZ, Math.PI]]) {
          if (gone(x, z, -1.4)) continue;
          this._pushPiece(lunX,
            trsInto(_m, x, spring, z + (yaw === 0 ? -0.20 : 0.20), 0, yaw, 0, hsx / sxSnap, 1, 1),
            { tint: 0.84 + r() * 0.2, rough: 0.95, hue: (r() - 0.5) * 0.4, roof: ROOF.shell });
        }
      }
      for (let bj = 0; bj < B.nz; bj++) {
        const z = room.minZ + B.bd * (bj + 0.5);
        for (const [x, yaw] of [[room.minX, HALF_PI], [room.maxX, -HALF_PI]]) {
          if (gone(x, z, -1.4)) continue;
          this._pushPiece(lunZ,
            trsInto(_m, x + (yaw > 0 ? -0.20 : 0.20), spring, z, 0, yaw, 0, hsz / szSnap, 1, 1),
            { tint: 0.84 + r() * 0.2, rough: 0.95, hue: (r() - 0.5) * 0.4, roof: ROOF.shell });
        }
      }
      /* responds carrying every bay line down to the string course */
      const resO = () => ({ tint: 0.9 + r() * 0.2, rough: 0.9 + r() * 0.25, hue: (r() - 0.5) * 0.4, shadow: CAST.no });
      for (let bi = 0; bi <= B.nx; bi++) {
        const x = room.minX + B.bw * bi;
        for (const [z, yaw] of [[room.minZ, 0], [room.maxZ, Math.PI]]) {
          this._pushPiece(kit.respond((r() * 2) | 0), trsInto(_m, x, this._g(x, z), z, 0, yaw, 0), resO());
        }
      }
      for (let bj = 0; bj <= B.nz; bj++) {
        const z = room.minZ + B.bd * bj;
        for (const [x, yaw] of [[room.minX, HALF_PI], [room.maxX, -HALF_PI]]) {
          this._pushPiece(kit.respond((r() * 2) | 0), trsInto(_m, x, this._g(x, z), z, 0, yaw, 0), resO());
        }
      }
    }
    this._vaultCorridors(layout, r, focus);
  }

  /** Vault every open cell no room covers, marched into bays along the run. */
  _vaultCorridors(layout, r, focus) {
    const kit = this.kit;
    const W = layout.W, cell = layout.cell;
    const inRoom = new Uint8Array(W * W);
    for (const room of layout.rooms) {
      for (let j = room.j0; j < room.j1; j++) {
        const row = j * W;
        for (let i = room.i0; i < room.i1; i++) inRoom[row + i] = 1;
      }
    }
    const done = new Uint8Array(W * W);
    const step = Math.max(4, Math.round(SPEC.vault.bay / cell));
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (done[k] || inRoom[k] || layout.open[k] !== 1) continue;
        let i1 = i;
        while (i1 < W && i1 - i < step && layout.open[j * W + i1] === 1 && !inRoom[j * W + i1] && !done[j * W + i1]) i1++;
        let j1 = j;
        outer: while (j1 < W && j1 - j < step) {
          for (let ii = i; ii < i1; ii++) {
            const kk = j1 * W + ii;
            if (layout.open[kk] !== 1 || inRoom[kk] || done[kk]) break outer;
          }
          j1++;
        }
        for (let jj = j; jj < j1; jj++) for (let ii = i; ii < i1; ii++) done[jj * W + ii] = 1;
        const bw = (i1 - i) * cell, bd = (j1 - j) * cell;
        if (bw < 0.9 || bd < 0.9) continue;
        const cx = layout.xOf(i) + bw * 0.5, cz = layout.zOf(j) + bd * 0.5;
        if (this._tier(cx, cz, focus) === 2) continue;
        const spring = this._g(cx, cz) + SPEC.vault.spring;
        const ws = snap(bw, LADDER.bay), ds = snap(bd, LADDER.bay);
        this._pushPiece(kit.vaultWeb(ws, ds, 0),
          trsInto(_m, cx, spring, cz, 0, 0, 0, bw / ws, 1, bd / ds),
          { tint: 0.82 + r() * 0.22, rough: 0.92 + r() * 0.28, hue: (r() - 0.5) * 0.5, roof: ROOF.shell });
        const hz = snap(bd * 0.5, LADDER.span), hx = snap(bw * 0.5, LADDER.span);
        this._pushPiece(kit.ribArch(hz, 0),
          trsInto(_m, layout.xOf(i), spring, cz, 0, HALF_PI, 0, (bd * 0.5) / hz, 1, 1),
          { tint: 0.86 + r() * 0.2, rough: 0.9, hue: (r() - 0.5) * 0.4, roof: ROOF.rib });
        this._pushPiece(kit.ribArch(hx, 0),
          trsInto(_m, cx, spring, layout.zOf(j), 0, 0, 0, (bw * 0.5) / hx, 1, 1),
          { tint: 0.86 + r() * 0.2, rough: 0.9, hue: (r() - 0.5) * 0.4, roof: ROOF.rib });
      }
    }
  }

  /* --------------------------------------------------------- columns -- */

  _raiseColumns(layout, r) {
    const kit = this.kit;
    const oc = this._oculus;
    for (const room of layout.rooms) {
      const B = room.bays;
      if (!B || B.nx < 2 || B.nz < 2) continue;
      if (!room.grand && r() < 0.42) continue;
      // A grand hall gets two aisle arcades, not a forest: columns stand only on
      // the bay lines next to the long walls, so the nave the player fights in
      // stays clear and the hero never hides behind a shaft.
      const aisleX = room.grand && room.w >= room.d;
      const aisleZ = room.grand && room.d > room.w;
      for (let bj = 1; bj < B.nz; bj++) {
        for (let bi = 1; bi < B.nx; bi++) {
          if (aisleZ && bi !== 1 && bi !== B.nx - 1) continue;
          if (aisleX && bj !== 1 && bj !== B.nz - 1) continue;
          const x = room.minX + B.bw * bi + (r() - 0.5) * 0.12;
          const z = room.minZ + B.bd * bj + (r() - 0.5) * 0.12;
          const gy = this._g(x, z);
          // the columns under the collapse came down with it; the ring just
          // outside it is what the vault still stands on
          if (room.grand && inOculus(oc, x, z, -1.1)) {
            if (r() < 0.5) {
              this._pushPiece(kit.columnBroken((r() * 2) | 0),
                trsInto(_m, x, gy, z, 0, r() * TAU, 0),
                { tint: 0.84 + r() * 0.22, rough: 0.95 + r() * 0.28, hue: (r() - 0.5) * 0.5 });
              layout.blockCircle(x, z, SPEC.column.baseR * 0.9);
            }
            continue;
          }
          const broken = room.grand ? inOculus(oc, x, z, 1.4) && r() < 0.4 : r() < 0.12;
          const variant = broken ? (r() * 2) | 0 : (r() * 3) | 0;
          this._pushPiece(broken ? kit.columnBroken(variant) : kit.column(variant),
            trsInto(_m, x, gy, z, 0, r() * TAU, 0),
            { tint: 0.88 + r() * 0.2, rough: 0.9 + r() * 0.26, hue: (r() - 0.5) * 0.5 });
          layout.blockCircle(x, z, SPEC.column.baseR * (broken ? 0.9 : 1.05));
        }
      }
    }
  }

  /* ---------------------------------------------------------- dress --- */

  _dress(layout, r, focus) {
    const kit = this.kit;
    const hall = layout.hall;

    /* The altar closes the hall against its far (-Z) wall: every crypt camera
       looks down -Z, so this is the frame's focal object. */
    if (hall) {
      const ax = hall.cx + (r() - 0.5) * 1.2;
      const az = hall.minZ + 1.75;
      const yaw = 0;                       // faces +Z, toward the camera
      const steps = 3;
      const stairZ = az + 1.75;
      this._pushPiece(kit.stair(4.2, steps, 0.17, 0.30),
        trsInto(_m, ax, this._g(ax, stairZ), stairZ, 0, Math.PI, 0),
        { tint: 0.9, rough: 0.95, hue: 0 });
      const py = this._g(ax, az) + steps * 0.17;
      this._pushPiece(kit.altar(0), trsInto(_m, ax, py, az, 0, yaw, 0),
        { tint: 0.94, rough: 0.88, hue: 0.35 });
      layout.blockRect(ax, az, 3.4, 2.2);
      layout.blockRect(ax, stairZ, 4.8, 1.4);
      this._altar = { x: ax, y: py, z: az, yaw };

      /* braziers flanking the altar steps — the warm key of the frame */
      for (const s of [-1, 1]) {
        const bx = ax + s * 2.9, bz = az + 2.1;
        this._fixture('brazier', bx, this._g(bx, bz), bz, r() * TAU, {
          kelvin: 2000, intensity: 128 + r() * 24, radius: 19, type: 'brazier',
          priority: 1.7, glow: 0.45,
        });
        layout.blockCircle(bx, bz, 0.55);
      }
    }

    /* sarcophagi and ossuary drifts, clustered — never on a lattice */
    const tombs = layout.scatter(24, 3.4, 1.7, r, (x, z, room) => {
      if (inOculus(this._oculus, x, z, 0.8)) return false;
      return room.grand ? r() < 0.4 : true;
    });
    for (const t of tombs) {
      const yaw = Math.floor(r() * 2) * HALF_PI + (r() - 0.5) * 0.16;
      const variant = r() < 0.34 ? 1 : 0;
      const gy = this._g(t.x, t.z);
      this._pushPiece(kit.sarcophagus(variant), trsInto(_m, t.x, gy, t.z, 0, yaw, 0),
        { tint: 0.86 + r() * 0.22, rough: 0.9 + r() * 0.28, hue: (r() - 0.5) * 0.5 });
      const alongX = Math.abs(Math.cos(yaw)) > 0.7;
      layout.blockRect(t.x, t.z, alongX ? 2.7 : 1.4, alongX ? 1.4 : 2.7);
      if (r() < 0.55) {
        const bx = t.x + (r() - 0.5) * 2.8, bz = t.z + (r() - 0.5) * 2.8;
        this._pushPiece(kit.bones((r() * 3) | 0),
          trsInto(_m, bx, this._g(bx, bz), bz, 0, r() * TAU, 0),
          { tint: 0.9 + r() * 0.2, rough: 0.95, hue: 0.4, shadow: CAST.no });
      }
    }

    /* rubble and bone drift along the room edges, thickest in the corners */
    for (const p of layout.scatter(80, 1.4, 0.5, r, (x, z) => layout.clearanceAt(x, z) < 2.8)) {
      if (this._tier(p.x, p.z, focus) === 2 && r() < 0.6) continue;
      const gy = this._g(p.x, p.z);
      if (r() < 0.74) {
        this._pushPiece(kit.rubble((r() * 4) | 0, 0.4 + r() * 0.6),
          trsInto(_m, p.x, gy, p.z, 0, r() * TAU, 0),
          RUBBLE_LOOK(r));
      } else {
        this._pushPiece(kit.bones((r() * 3) | 0),
          trsInto(_m, p.x, gy, p.z, 0, r() * TAU, 0),
          { tint: 0.88 + r() * 0.2, rough: 0.95, hue: 0.45, shadow: CAST.no });
      }
    }

    /* Foreground cluster. The camera looks down -Z from +Z, so the bottom third
       of the frame is the hall's +Z end; leaving it bare floor throws away a
       third of the picture. A fallen column, its drums, spoil from the vault and
       a broken sarcophagus give the frame a dark, detailed near plane. */
    if (hall) {
      const fz = hall.maxZ - 2.6;
      const fx = hall.cx + (r() - 0.5) * 3.0;
      this._pushPiece(kit.columnBroken(1),
        trsInto(_m, fx - 2.9, this._g(fx - 2.9, fz), fz, 0, r() * TAU, 0),
        { tint: 0.84 + r() * 0.2, rough: 0.95 + r() * 0.25, hue: (r() - 0.5) * 0.5 });
      layout.blockCircle(fx - 2.9, fz, 0.6);
      this._pushPiece(kit.sarcophagus(1),
        trsInto(_m, fx + 2.6, this._g(fx + 2.6, fz - 0.4), fz - 0.4, 0, HALF_PI + (r() - 0.5) * 0.3, 0),
        { tint: 0.86 + r() * 0.2, rough: 0.92 + r() * 0.25, hue: (r() - 0.5) * 0.4 });
      layout.blockRect(fx + 2.6, fz - 0.4, 1.5, 2.8);
      for (let k = 0; k < 7; k++) {
        const rx = fx + (r() - 0.5) * 8.5, rz = fz - r() * 3.4;
        this._pushPiece(kit.rubble((r() * 4) | 0, 0.45 + r() * 0.8),
          trsInto(_m, rx, this._g(rx, rz), rz, 0, r() * TAU, 0),
          RUBBLE_LOOK(r));
      }
      for (let k = 0; k < 3; k++) {
        const bx = fx + (r() - 0.5) * 7.0, bz = fz - r() * 3.0;
        this._pushPiece(kit.bones((r() * 3) | 0),
          trsInto(_m, bx, this._g(bx, bz), bz, 0, r() * TAU, 0),
          { tint: 0.9 + r() * 0.2, rough: 0.95, hue: 0.45, shadow: CAST.no });
      }
    }

    /* chains hanging from intact bays, catching the torchlight */
    for (const c of layout.scatter(12, 4.5, 1.5, r, (x, z, room) =>
      !!room.bays && !inOculus(this._oculus, x, z, 0.4))) {
      this._pushPiece(kit.chain(1.6 + r() * 2.6, 0),
        trsInto(_m, c.x, this._g(c.x, c.z) + SPEC.vault.spring + 0.35, c.z, 0, r() * TAU, 0),
        { tint: 0.92, rough: 0.86, hue: -0.3, shadow: CAST.no });
    }
  }

  /* ---------------------------------------------------------- lights -- */

  /**
   * Practicals go where a mason would have put them: a pair flanking the main
   * portals, a sconce in one wall bay out of three, braziers at the altar and
   * at the head of the approach, and one cold shaft through the collapse. Every
   * one has fixture geometry and a flame; none is a floating orb.
   */
  _lightCrypt(layout, r) {
    const oc = this._oculus;
    /* Hard budget. The volumetric pass scatters from every practical, so forty
       torches do not read as forty torches — they read as a white-out. Fourteen
       well-placed sources give the frame pools to move between and keep the
       histogram bottom-weighted. */
    const MAX_SCONCE = 16;
    const REACH = 25;
    const near = (x, z) => Math.hypot(x, z) < REACH;
    let sconces = 0;

    /* 1. portal flanks — the most-motivated sconce position in the level */
    const doors = layout.doors
      .filter((d) => near(d.x, d.z))
      .sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
    for (const d of doors) {
      if (sconces >= 7) break;
      const inward = d.side;
      const sgn = r() < 0.5 ? -1 : 1;
      const off = Math.min(d.span * 0.5 + 0.62, 2.5) * sgn;
      const x = d.axis === 'x' ? d.x + off : d.x + inward * 0.16;
      const z = d.axis === 'x' ? d.z + inward * 0.16 : d.z + off;
      const probe = d.axis === 'x' ? [x, z + inward * 0.9] : [x + inward * 0.9, z];
      if (!layout.walkableAt(probe[0], probe[1])) continue;
      const yaw = d.axis === 'x' ? (inward === 1 ? 0 : Math.PI) : (inward === 1 ? HALF_PI : -HALF_PI);
      this._fixture('sconce', x, this._g(x, z) + 2.58, z, yaw, {
        kelvin: 1900 + r() * 90, intensity: 62 + r() * 16, radius: 13 + r() * 2,
        type: 'torch', glow: 0,
      });
      sconces++;
    }

    /* 2. the hall's own wall bays, alternating sides so the light zig-zags down
          the nave instead of forming two parallel rails */
    const hall = layout.hall;
    if (hall && hall.bays) {
      const B = hall.bays;
      const runs = [
        { n: B.nx, base: hall.minX, step: B.bw, axis: 'x', a: hall.minZ, side: 1 },
        { n: B.nz, base: hall.minZ, step: B.bd, axis: 'z', a: hall.maxX, side: -1 },
        { n: B.nx, base: hall.minX, step: B.bw, axis: 'x', a: hall.maxZ, side: -1 },
        { n: B.nz, base: hall.minZ, step: B.bd, axis: 'z', a: hall.minX, side: 1 },
      ];
      let k = 1;
      while (sconces < MAX_SCONCE && k < 24) {
        const w = runs[k % runs.length];
        const idx = 1 + ((k * 2 + (k > 7 ? 1 : 0)) % Math.max(1, w.n - 1));
        const t = w.base + w.step * (idx + 0.5);
        const x = w.axis === 'x' ? t : w.a + w.side * 0.14;
        const z = w.axis === 'x' ? w.a + w.side * 0.14 : t;
        k++;
        if (!near(x, z)) continue;
        const yaw = w.axis === 'x' ? (w.side === 1 ? 0 : Math.PI) : (w.side === 1 ? HALF_PI : -HALF_PI);
        this._fixture('sconce', x, this._g(x, z) + 2.52 + r() * 0.12, z, yaw, {
          kelvin: 1880 + r() * 110, intensity: 55 + r() * 18, radius: 12.5 + r() * 2.5,
          type: 'torch', glow: 0,
        });
        sconces++;
      }
    }

    /* 3. one floor brazier where an approach corridor opens into the hall */
    for (const s of layout.scatter(1, 9, 2.0, r, (x, z) =>
      layout.clearanceAt(x, z) > 2.0 && !inOculus(oc, x, z, 2.5) && near(x, z))) {
      this._fixture('brazier', s.x, this._g(s.x, s.z), s.z, r() * TAU, {
        kelvin: 1990 + r() * 60, intensity: 95 + r() * 22, radius: 17 + r() * 2,
        type: 'brazier', priority: 1.3, glow: 0.45,
      });
      layout.blockCircle(s.x, s.z, 0.52);
    }

    /* 4. the shaft through the collapse: the level's only cold light, and the
          reason the vault is a closed solid that casts shadow at all */
    const gy = this._g(oc.x, oc.z);
    this._addTorch({
      kind: 'spot', type: 'shaft',
      position: [oc.x + 0.4, gy + 11.6, oc.z - 1.6],
      direction: [0.05, -1, 0.08],
      kelvin: 8800, coolBias: 0.30, saturation: 0.85,
      intensity: 620, radius: 24, angle: 0.30, penumbra: 0.80,
      flicker: 0.14, priority: 2.4, shadow: true,
    });
  }

  /**
   * Place a light *and* its fixture. Prefers the Props module's shared fixture
   * kit when it exists; otherwise builds this kit's sconce or brazier plus a
   * real flame solid, so a practical is never a floating orb.
   */
  _fixture(kind, x, y, z, yaw, light) {
    const props = this.engine.get('props');
    let handled = false;
    try {
      if (props && !props.__dead && typeof props.placeFixture === 'function') {
        const res = props.placeFixture(kind, new THREE.Vector3(x, y, z), { yaw, ...light });
        handled = res !== false && res !== undefined && res !== null;
      }
    } catch { handled = false; }

    /*
     * Where the light goes, and why it is not on the coals.
     *
     * A point light obeys 1/d². Parked 0.15 m above a brazier's coal bed at
     * ~100 cd it delivers ~4400 units of irradiance to its own bowl, which
     * resolves five orders of magnitude over the exposed white point: the
     * fixture became a clipped white disc and bloom spread it across 110 px.
     * So the light sits up inside the flame body it is supposed to be coming
     * from — half a metre off the coals, which is both more physically honest
     * and 12x less irradiance on the geometry nearest to it.
     */
    let lightPos = [x, y + 0.2, z];
    let ownFlame = false;
    if (!handled) {
      const kit = this.kit;
      ownFlame = true;
      if (kind === 'brazier') {
        this._pushPiece(kit.brazier(0), trsInto(_m, x, y, z, 0, yaw, 0),
          { tint: 0.95, rough: 0.9, hue: 0.3 });
        this._pushPiece(kit.flame(1.15, 0), trsInto(_m, x, y + 1.06, z, 0, yaw, 0),
          { tint: 1, rough: 1, hue: 0, shadow: CAST.no });
        lightPos = [x, y + 1.58, z];
      } else {
        const nx = Math.sin(yaw), nz = Math.cos(yaw);
        this._pushPiece(kit.sconce(0), trsInto(_m, x, y, z, 0, yaw, 0),
          { tint: 0.95, rough: 0.85, hue: 0.2 });
        this._pushPiece(kit.flame(0.62, 1),
          trsInto(_m, x + nx * 0.30, y + 0.34, z + nz * 0.30, 0, yaw, 0),
          { tint: 1, rough: 1, hue: 0, shadow: CAST.no });
        lightPos = [x + nx * 0.40, y + 0.62, z + nz * 0.40];
      }
    }
    // `flame` tells Props we already built fire here. Without it its
    // `_adoptDungeonFires` pass stacks a second animated flame on top of this
    // one at the same coordinate, and two additive fires in the same 0.4 m
    // clipped to white.
    this._fixtures.push({ kind, x, y, z, yaw, flame: ownFlame });
    this.engine.bus.emit('dungeon:fixture', { kind, position: lightPos, yaw });
    this._addTorch({ position: lightPos, ...light });
  }

  _addTorch(opts) {
    const lighting = this.engine.get('lighting');
    if (!lighting || lighting.__dead || typeof lighting.addTorch !== 'function') return null;
    try {
      const h = lighting.addTorch(opts);
      if (h) this._torches.push(h);
      return h;
    } catch (e) {
      console.warn('[dungeon] torch rejected —', e);
      return null;
    }
  }

  /** Re-register our practicals if a scenario re-apply dropped them. */
  _reseatLights() {
    const lighting = this.engine.get('lighting');
    if (!lighting || !this._torches.length) return;
    let alive = 0;
    for (const t of this._torches) if (lighting.practicals?.includes?.(t)) alive++;
    if (alive > 0) return;
    const keep = this._torches.slice();
    this._torches.length = 0;
    for (const t of keep) {
      this._addTorch({
        kind: t.kind, type: t.type, position: t.basePosition.toArray(),
        intensity: t.baseIntensity, radius: t.radius, flicker: t.flicker,
        priority: t.priority, angle: t.angle, penumbra: t.penumbra,
        direction: t.direction.toArray(), color: t.coolColor.getHex(),
        shadow: t.allowShadow,
      });
    }
  }

  /* ================================================================ *
   * arena
   * ================================================================ */

  _buildArena() {
    const res = buildArena(this, this.engine.freshRand(this.seed ^ 0xa1e4));
    this.layout = null;
    this.rooms = res.rooms;
    this.bounds = res.bounds;
    this.floorY = 0;
    this.navMask = res.navMask;
    this._arenaNav = res.nav;
    this._spawns = res.spawns;
    this.arena = res;
    /*
     * AI.js asks the dungeon for the boss arena so BossController can contain the
     * fight. It probes for a centre + radius (`x`/`z`/`r`) and only falls back to
     * a rectangle. `res.bounds` is a rectangle in min/max form, which matches
     * neither, so without this the boss's arena was inferred from a lone spawn
     * point with a hard-coded 18 m radius. Publish the real footprint: the
     * walkable floor stops at the wall hexagon's apothem.
     */
    const b = res.bounds;
    const inradius = Math.min((b.maxX - b.minX), (b.maxZ - b.minZ)) * 0.5 - 2;
    this.arena.x = (b.minX + b.maxX) * 0.5;
    this.arena.z = (b.minZ + b.maxZ) * 0.5;
    this.arena.r = Math.max(9, inradius * 0.94);
  }

  /* ================================================================ *
   * queries
   * ================================================================ */

  /** True where an actor may stand. Authoritative inside the built footprint. */
  isWalkable(x, z) {
    if (!this.active) return true;
    if (this.mode === 'arena') return this._arenaNav ? this._arenaNav(x, z) : true;
    return this.layout ? this.layout.walkableAt(x, z) : true;
  }

  isBlocked(x, z) { return !this.isWalkable(x, z); }

  clearanceAt(x, z) {
    if (!this.active) return 8;
    if (this.mode === 'arena') return this.arena?.clearanceAt?.(x, z) ?? 8;
    return this.layout ? this.layout.clearanceAt(x, z) : 8;
  }

  /**
   * Floor height. The crypt floor is flagged over the biome heightfield; the
   * arena has a raised dais and a sunken moat. AI.js probes for `floorHeightAt`,
   * so all four names resolve here.
   */
  floorHeightAt(x, z) {
    if (!this.active) return this._g(x, z);
    if (this.mode === 'arena') return this.arena?.heightAt?.(x, z) ?? 0;
    return this._g(x, z);
  }
  floorAt(x, z) { return this.floorHeightAt(x, z); }
  groundAt(x, z) { return this.floorHeightAt(x, z); }
  heightAt(x, z) { return this.floorHeightAt(x, z); }

  /**
   * @param {'player'|'enemy'|'boss'|'prop'|'loot'|'light'} kind
   * @returns {THREE.Vector3[]}
   */
  spawnPoints(kind = 'enemy') {
    const list = this._spawns[kind] ?? this._spawns.enemy;
    return list.map((p) => new THREE.Vector3(p.x, p.y ?? this.floorHeightAt(p.x, p.z), p.z));
  }

  _makeSpawns(layout, r) {
    const hall = layout.hall ?? layout.rooms[0];
    const oc = this._oculus;
    const push = (arr, x, z) => arr.push({ x, z, y: this._g(x, z) });

    /* the player lands in the pool of light under the collapse */
    if (hall) {
      const best = layout.scatter(12, 2.0, 1.5, r, (x, z, room) =>
        room === hall && inOculus(oc, x, z, -1.6));
      if (best.length) push(this._spawns.player, best[0].x, best[0].z);
      else push(this._spawns.player, hall.cx, hall.cz);
    } else push(this._spawns.player, 0, 0);

    /* enemies: a loose ring inside the hall, plus holders in the side rooms */
    for (const p of layout.scatter(16, 2.3, 1.15, r, (x, z, room) => {
      return room === hall && !inOculus(oc, x, z, -2.4);
    })) push(this._spawns.enemy, p.x, p.z);
    for (const p of layout.scatter(18, 3.6, 1.15, r, (x, z, room) => room !== hall)) {
      push(this._spawns.enemy, p.x, p.z);
    }

    /* boss: on the altar axis, facing the approach */
    if (this._altar) push(this._spawns.boss, this._altar.x, this._altar.z + 6.2);
    else if (hall) push(this._spawns.boss, hall.cx, hall.cz);

    for (const p of layout.scatter(44, 1.9, 0.8, r, (x, z) => layout.clearanceAt(x, z) < 3.1)) {
      push(this._spawns.prop, p.x, p.z);
    }
    for (const p of layout.scatter(18, 3.0, 1.3, r)) push(this._spawns.loot, p.x, p.z);
    for (const f of this._fixtures) this._spawns.light.push({ x: f.x, z: f.z, y: f.y });
  }

  /* ================================================================ *
   * helpers exposed to Arena.js
   * ================================================================ */

  pushPiece(piece, matrix, tint, rough, hue, shadow) {
    this._pushPiece(piece, matrix, { tint, rough, hue, shadow });
  }
  pushGeo(geo, matKey, matrix, tint, rough, hue, shadow) {
    this._push(geo, matKey, matrix, { tint, rough, hue, shadow });
  }
  pushUnique(geo, matKey, opts) { this._unique.push(geo); return this._pushUnique(geo, matKey, opts); }
  fixture(kind, x, y, z, yaw, light) { this._fixture(kind, x, y, z, yaw, light); }
  addTorch(opts) { return this._addTorch(opts); }
}

/** Normalised ellipse test, `pad` metres of slop on both radii. */
function inOculus(oc, x, z, pad = 0) {
  if (!oc) return false;
  const rx = Math.max(0.3, (oc.rx ?? oc.r) + pad);
  const rz = Math.max(0.3, (oc.rz ?? oc.r) + pad);
  const dx = (x - oc.x) / rx, dz = (z - oc.z) / rz;
  return dx * dx + dz * dz < 1;
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

export default Dungeon;
