/**
 * THE NINTH VIGIL — Lighting
 *
 * Diablo 4's look is 80% lighting: near-black ambient, dramatic warm practicals,
 * a cold skylight fill, and everything nailed down by shadow. This module owns
 * all of that:
 *
 *   1. Cascaded shadow maps (three/addons/csm) for the primary directional
 *      light, with per-cascade normal/depth bias derived from the cascade's own
 *      world-space texel size — the only way to get no acne AND no peter-panning
 *      across a 60:1 depth range.
 *   2. A managed pool of point/spot practicals with importance selection, so a
 *      dungeon can hold fifty torches while the GPU only ever lights twelve and
 *      shadows four. Slot count is fixed for the lifetime of the module, so
 *      lights entering and leaving never trigger a shader recompile.
 *   3. Layered deterministic flicker (slow breathe + fast crackle + guttering)
 *      driving both intensity and a positional jitter, so torch shadows breathe.
 *   4. Ambient from an IBL probe (`scene.environment`) + a hemisphere term with
 *      a cold sky and a warm-dark ground bounce. Never a flat AmbientLight.
 *   5. A camera-tracking rim/back light, in two halves: a scene-wide cold
 *      DirectionalLight held DELIBERATELY LOW (see SCENE_RIM_CEIL), plus a
 *      CHARACTER-LOCKED rim compiled only into materials that opt in — because a
 *      light that touches everything separates nothing. Hero *and* monsters opt
 *      in, so every figure in frame carries a cold edge and the floor does not.
 *      Paired with a soft grounding pool under the character, which anchors it
 *      and drops the local background value so the rim reads. See the CHARACTER
 *      RIM note below and `_buildHeroPool`.
 *   6. A coarse dynamic irradiance grid (3D texture) injected into every
 *      registered material, so stone near a torch actually picks up its warmth.
 *
 * Cross-module contract:
 *   engine.get('lighting').registerMaterial(mat)   // required for CSM + probes
 *   mat.userData.charRim = <gain>|true|false       // opt in/out of the character rim
 *   mat.userData.heroRim = <gain>                  // legacy alias for charRim
 *   engine.get('lighting').addTorch({...}) -> handle
 *   bus 'lighting:sun'  {dir, color, intensity}    // emitted when the sun moves
 *   bus 'sky:sun'       {dir, color, intensity}    // listened to; Sky owns dir
 */

import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import {
  Practical,
  LightPool,
  ProbeVolume,
  PracticalVisual,
  resolveLighting,
  defaultPracticals,
  buildSkyEquirect,
  kelvinColor,
  clamp,
  lerp,
} from './LightRig.js';

const DEG = Math.PI / 180;

/**
 * Per-tier budgets. Shadowed practicals are the expensive ones — in two ways.
 *
 * 1. **Fragment texture units.** WebGL2 only guarantees 16, and every shadowed
 *    light is one more sampler in EVERY lit material. With 4 CSM cascades, the
 *    env probe and the irradiance volume already spoken for, four shadowed point
 *    lights plus a shadowed spot pushed the crypt's stone/cap/ember materials to
 *    17 samplers and their programs failed to link — i.e. the architecture did
 *    not render at all. Two shadowed points is the ceiling that leaves headroom.
 * 2. **Draw calls.** A shadowed point light is a cube map: six full render
 *    passes of everything inside its radius. Four of them in a dressed crypt
 *    cost ~2400 draw calls a frame on their own.
 */
const TIER = {
  low:   { point: 4,  pointShadows: 0, spot: 0, spotShadows: 0, pointRes: 256, spotRes: 512,  probe: [16, 4, 16], probeSize: 76 },
  med:   { point: 6,  pointShadows: 1, spot: 2, spotShadows: 0, pointRes: 384, spotRes: 512,  probe: [20, 4, 20], probeSize: 84 },
  // Pool SIZE is free in texture units (only shadowed lights cost a sampler), and
  // the crypt's great hall is 21-26 m across: at ten slots the far third of the
  // room fell off the pool and went to true black. Fourteen keeps every wall bay
  // lit and still fits the forward light loop comfortably.
  high:  { point: 12, pointShadows: 2, spot: 3, spotShadows: 1, pointRes: 512, spotRes: 1024, probe: [24, 5, 24], probeSize: 92 },
  ultra: { point: 14, pointShadows: 2, spot: 3, spotShadows: 1, pointRes: 512, spotRes: 1024, probe: [28, 5, 28], probeSize: 96 },
};

const PROBE_DEFINE = 'NONA_PROBEVOL';
const PROBE_HOOK = '#include <lights_fragment_maps>';

/**
 * CHARACTER RIM — the silhouette pass. This is the ONE rig that makes both the
 * hero and every monster separate from the ground.
 *
 * `this.rim` is a scene-wide DirectionalLight and it can never do this job: a
 * light that touches every surface raises the *whole* frame's edge brightness,
 * so the hero ends up exactly as separated from the floor as the floor is from
 * the wall behind it — which is to say, not at all. Three's forward renderer
 * has no per-object light masking (Object3D.layers gates lights against the
 * CAMERA, not against the lit object), so the only way to make the FIGURES the
 * only rim-lit things on screen is to put the rim term in their own fragment
 * shaders.
 *
 * That is what this is: a camera-locked cold back light evaluated per material,
 * injected only into materials that opt in (`userData.charRim`, the legacy
 * `userData.heroRim`, or a `hero_` material name). Terrain, architecture and
 * props never compile it. MonsterMaterials opts every enemy surface in, so a
 * cultist's robe and a hero's plate get the same cold edge from the same
 * direction — which is what makes a frame read as lit rather than as cut paper.
 *
 * WHY IT HAS TWO LOBES (round-6 fix). The first version was a single grazing
 * fresnel band at `pow` 2.2. At a 26-34 m gameplay camera a 1.85 m figure is
 * 40-70 px tall and 12-25 px wide, so that band lands on ONE pixel of the
 * silhouette — and one pixel is exactly what SMAA/TAA, DOF and the bloom
 * prefilter average away. Measured on `combat`: switching the whole term off
 * moved the hero's torso mean by 0.03, i.e. it was doing almost nothing.
 * So the term is now:
 *
 *   band = edge^pow * side^2         tight grazing outline (draws the shape)
 *   kick = kickGain * side^3         broad back-light gradient over the whole
 *                                    camera-far side of the figure
 *
 * The kick is what survives the resolve at 20 px; the band is what makes it read
 * as a light and not as a wash. Both are gated on `side`, so nothing is added to
 * the surfaces facing the camera — the figure keeps a dark front, which is the
 * whole point of a back light.
 *
 * It lands on the *final* radiance rather than inside the light loop on purpose:
 * CharacterMesh applies a post-lighting hue grade to the armour, and a rim light
 * is a light in the room, not part of the armour's hue balance. It must not be
 * dragged toward the plate's target chroma. `tonemapping_fragment` is the first
 * stock include after `opaque_fragment` writes gl_FragColor and nothing else in
 * the project rewrites it, so it is a safe anchor; the fallbacks exist only so a
 * three version bump degrades instead of white-screening.
 */
const RIM_DEFINE = 'NONA_HERORIM';

/**
 * Hard ceiling on the SCENE-WIDE rim DirectionalLight.
 *
 * The biome presets author `rim.intensity` at 0.40-0.92 and it was going straight
 * onto a light that hits terrain, walls, rubble and characters alike. Measured on
 * `combat`, dropping the crypt's 0.88 to 0.30 took the floor immediately behind
 * the hero from 0.509 to 0.450 luma while the hero's own body only lost 0.018 —
 * i.e. that light was worth +0.04 of NEGATIVE separation. A broad back fill still
 * has a job (it keeps the shadow side of architecture off pure black), but it is a
 * small job, and the silhouette authority it used to hold now lives in the
 * per-material term above where it can only touch figures.
 *
 * `preset.rim.intensity` is still read at full value to derive the character
 * rim's gain and its colour, so the per-biome colour story is unchanged.
 */
const SCENE_RIM_CEIL = 0.40;
const RIM_ANCHORS = [
  '#include <tonemapping_fragment>',
  '#include <colorspace_fragment>',
  '#include <dithering_fragment>',
];

/* Sampled once per frame, before the render, so the probe volume follows the
 * play area rather than the camera position (which is way up in the air). */
const _focus = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _projScreen = new THREE.Matrix4();

export class Lighting {
  static id = 'lighting';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.autoPracticals = true;

    /** @type {CSM|null} */
    this.csm = null;
    /** @type {Practical[]} */
    this.practicals = [];
    /** @type {LightPool|null} */
    this.pointPool = null;
    /** @type {LightPool|null} */
    this.spotPool = null;
    /** @type {ProbeVolume|null} */
    this.probes = null;

    this.hemi = null;
    this.rim = null;
    this.rimTarget = null;
    /** Soft "negative light" pool under the hero — see `_buildHeroPool`. */
    this.heroPool = null;

    /**
     * Character rim tuning. `gain` is resolved per scenario from the preset's rim
     * so a violet hell arena and a moonlit moor stay on their own colour story.
     * `pow` is the Fresnel exponent (higher = tighter band), `wrap` how far the
     * term bleeds past the terminator of the rim direction, and `kick` the broad
     * back-light lobe that survives the AA resolve at gameplay distance.
     */
    this._heroRim = { gain: 0.62, pow: 1.6, wrap: 0.48, kick: 0.45, pool: 0.52, poolBias: 1.35, ceil: 0.80 };
    this._rimUniforms = {
      nonaRimDir: { value: new THREE.Vector3(0, 0.45, 1).normalize() },
      nonaRimCol: { value: new THREE.Vector3(0, 0, 0) },
      nonaRimTune: { value: new THREE.Vector4(1.6, 0.48, 0.80, 0.30) },
    };

    /** Materials registered for CSM + probe injection. */
    this._materials = new Set();
    this._pending = [];
    this._skipMaterials = new WeakSet();

    /**
     * Sun state. `dir` is the direction light TRAVELS (sun -> ground).
     *
     * `shadow` gates the cascades independently of `enabled`, because a sunless
     * interior still wants the key's COLOUR — the cold counterpoint to
     * firelight — while having nothing overhead that may legitimately cast.
     * A crypt's ceiling sits at ~7.3 m and, lit by a fictional 64-degree
     * skylight, threw metres-long hard-edged black wedges across the whole
     * play area and buried the hero. See `_applySunToLights`.
     */
    this.sun = {
      dir: new THREE.Vector3(-0.45, -0.82, -0.35).normalize(),
      color: new THREE.Color(1, 1, 1),
      intensity: 0,
      enabled: false,
      shadow: true,
      ownedBySky: false,
    };

    this.preset = resolveLighting('combat', { env: { biome: 'crypt', interior: true } });
    this.focus = new THREE.Vector3();

    this._frustum = new THREE.Frustum();
    this._syncPending = true;
    this._lastCamKey = '';
    this._scenarioFrame = -1;
    this._autoSpawned = [];
    this._externalTorches = 0;
    this._envRT = null;
    this._envSrc = null;
    this._envOwned = false;
    this._fogOwned = false;
    this._prevSceneOnBeforeRender = null;
    this._chunkBackup = null;

    this._probeUniforms = {
      nonaProbeVol: { value: null },
      nonaProbeMin: { value: new THREE.Vector3() },
      nonaProbeInvSize: { value: new THREE.Vector3(1, 1, 1) },
      nonaProbeParams: { value: new THREE.Vector2(1, 4) },
      /* Oriented interior wall bounce — see BIOME_LIGHTING.crypt.wallFill in
       * LightRig for why a room needs a horizontally-weighted fill and a
       * hemisphere cannot supply one. Black outside sunless interiors, so the
       * term is one multiply-add that resolves to nothing for every exterior. */
      nonaWallFill: { value: new THREE.Color(0, 0, 0) },
    };

    // Wired in the constructor (not init) so modules that build materials during
    // their own init() can register before this module has initialised.
    const bus = engine.bus;
    this._off = [
      bus.on('lighting:register', (p) => {
        if (!p) return;
        if (Array.isArray(p)) this.registerMaterials(p);
        else if (p.materials) this.registerMaterials(p.materials);
        else if (p.material) this.registerMaterial(p.material);
        else if (p.isMaterial) this.registerMaterial(p);
      }),
      bus.on('lighting:rescan', () => this._scanScene()),
      bus.on('lighting:torch', (p) => { if (p) this.addTorch(p); }),
      bus.on('sky:sun', (p) => this._onSkySun(p)),
      bus.on('sky:env', (p) => this._onSkyEnv(p)),
    ];

    // Convenience alias — `engine.get('lighting')` remains the documented path.
    engine.lighting = this;
  }

  /* ================================================================ */
  /* lifecycle                                                         */
  /* ================================================================ */

  async init() {
    const engine = this.engine;
    const scene = engine.scene;
    const q = engine.quality ?? {};
    const tier = TIER[q.tier] ?? TIER.ultra;
    this.tier = tier;

    /* ---- hemisphere: cold sky, warm-dark ground bounce ---- */
    this.hemi = new THREE.HemisphereLight(0x223146, 0x140d09, 0.2);
    this.hemi.name = 'nona.hemi';
    this.hemi.position.set(0, 40, 0);
    scene.add(this.hemi);

    /* ---- camera-tracking rim / back light ---- */
    this.rim = new THREE.DirectionalLight(0x5b82ad, 0.5);
    this.rim.name = 'nona.rim';
    this.rim.castShadow = false;
    this.rimTarget = new THREE.Object3D();
    this.rimTarget.name = 'nona.rim.target';
    scene.add(this.rimTarget);
    this.rim.target = this.rimTarget;
    scene.add(this.rim);

    /* ---- the hero's grounding pool (see _buildHeroPool) ---- */
    this._buildHeroPool();

    /* ---- cascaded shadow maps ---- */
    try {
      this._chunkBackup = {
        begin: THREE.ShaderChunk.lights_fragment_begin,
        pars: THREE.ShaderChunk.lights_pars_begin,
      };
      const cascades = clamp(q.cascades ?? 4, 2, 4);
      // A 4096² depth map costs ~64 MB; four of them blows the whole texture
      // budget for zero visible gain, because our cascades are tight (maxFar is
      // ~70-120 world units, not a kilometre). Cap by total depth-texel budget.
      const budget = 4096 * 4096;
      let res = clamp(q.shadowRes ?? 2048, 512, 4096);
      while (res > 1024 && res * res * cascades > budget) res >>= 1;
      this.shadowRes = res;

      this.csm = new CSM({
        camera: engine.camera,
        parent: scene,
        cascades,
        maxFar: this.preset.maxFar,
        mode: 'custom',
        customSplitsCallback: practicalSplit07,
        shadowMapSize: res,
        shadowBias: 0,
        lightDirection: this.sun.dir.clone(),
        lightIntensity: 0,
        lightNear: 1,
        lightFar: 320,
        lightMargin: 70,
      });
      this.csm.fade = true;               // not settable through the ctor data
      this.csm.updateFrustums();
      for (let i = 0; i < this.csm.lights.length; i++) {
        const l = this.csm.lights[i];
        l.name = `nona.csm.${i}`;
        l.intensity = 0;
        l.shadow.autoUpdate = true;
      }
      this._tuneCascadeBias();
      this._patchCSMChunk();
    } catch (e) {
      console.warn('[lighting] CSM unavailable, falling back to a single shadowed key —', e);
      this.csm = null;
      this._restoreChunks();
      this.keyLight = new THREE.DirectionalLight(0xffffff, 0);
      this.keyLight.castShadow = true;
      this.keyLight.shadow.mapSize.setScalar(clamp(q.shadowRes ?? 2048, 512, 2048));
      this.keyLight.shadow.camera.left = -50;
      this.keyLight.shadow.camera.right = 50;
      this.keyLight.shadow.camera.top = 50;
      this.keyLight.shadow.camera.bottom = -50;
      this.keyLight.shadow.camera.near = 1;
      this.keyLight.shadow.camera.far = 220;
      this.keyLight.shadow.normalBias = 0.05;
      this.keyLight.shadow.bias = -0.0002;
      this.keyLight.shadow.radius = 3;
      this.keyTarget = new THREE.Object3D();
      scene.add(this.keyTarget, this.keyLight);
      this.keyLight.target = this.keyTarget;
    }

    /* ---- practical light pools (fixed size — never recompiles) ---- */
    this.pointPool = new LightPool(scene, {
      kind: 'point', size: tier.point, shadowSlots: tier.pointShadows, shadowRes: tier.pointRes,
    });
    this.spotPool = new LightPool(scene, {
      kind: 'spot', size: tier.spot, shadowSlots: tier.spotShadows, shadowRes: tier.spotRes,
    });

    /* ---- irradiance probe grid ---- */
    try {
      const [nx, ny, nz] = tier.probe;
      this.probes = new ProbeVolume({
        nx, ny, nz,
        sizeX: tier.probeSize, sizeY: 17, sizeZ: tier.probeSize,
        scale: 4,
      });
      this._probeUniforms.nonaProbeVol.value = this.probes.texture;
      this._probeUniforms.nonaProbeInvSize.value.copy(this.probes.texInvSize);
      this._probeUniforms.nonaProbeParams.value.set(this.preset.probeIntensity, this.probes.scale);
    } catch (e) {
      console.warn('[lighting] probe volume disabled —', e);
      this.probes = null;
    }

    /* ---- environment (IBL) ---- */
    this._refreshEnvironment();

    /* ---- render-time sync hook (camera rigs update AFTER us) ---- */
    this._prevSceneOnBeforeRender = scene.onBeforeRender;
    scene.onBeforeRender = (renderer, sc, camera, rt) => {
      try { this._prevSceneOnBeforeRender?.call(scene, renderer, sc, camera, rt); } catch (e) { console.error('[lighting:chain]', e); }
      if (camera !== this.engine.camera) return;
      try { this._syncForRender(); } catch (e) { console.error('[lighting:sync]', e); }
    };

    this.enabled = true;

    // Flush anything registered before we existed, then adopt the scene.
    const q0 = this._pending;
    this._pending = [];
    for (const m of q0) this.registerMaterial(m);
    this._scanScene();

    this.applyScenario(engine.scenario?.name ?? 'combat', engine.scenario ?? { env: { biome: 'crypt', interior: true } });
    engine.bus.emit('lighting:ready', { lighting: this });
  }

  dispose() {
    for (const off of this._off) { try { off(); } catch {} }
    this._off.length = 0;

    const scene = this.engine.scene;
    if (this._prevSceneOnBeforeRender !== null) {
      scene.onBeforeRender = this._prevSceneOnBeforeRender;
      this._prevSceneOnBeforeRender = null;
    }

    for (const m of this._materials) this._unhookMaterial(m);
    this._materials.clear();

    this.pointPool?.dispose();
    this.spotPool?.dispose();
    this._clearAutoPracticals();
    this.practicals.length = 0;

    if (this.csm) { try { this.csm.dispose(); this.csm.remove(); } catch {} this.csm = null; }
    this._restoreChunks();

    if (this.hemi) scene.remove(this.hemi);
    if (this.rim) { scene.remove(this.rim); scene.remove(this.rimTarget); }
    if (this.heroPool) {
      try {
        scene.remove(this.heroPool.mesh);
        this.heroPool.geo.dispose();
        this.heroPool.mat.dispose();
      } catch {}
      this.heroPool = null;
    }
    if (this.keyLight) { scene.remove(this.keyLight); scene.remove(this.keyTarget); this.keyLight.shadow.dispose(); }

    this.probes?.dispose();
    if (this._envOwned && scene.environment === this._envRT?.texture) scene.environment = null;
    this._envRT?.dispose();
    this._envSrc?.dispose();
    if (this._fogOwned) scene.fog = null;
    this.enabled = false;
    if (this.engine.lighting === this) this.engine.lighting = null;
  }

  resize() {
    // Aspect changed -> cascade frusta changed.
    if (this.csm) { try { this.csm.updateFrustums(); this._tuneCascadeBias(); } catch {} }
  }

  /* ================================================================ */
  /* public API                                                        */
  /* ================================================================ */

  /**
   * Register a material so it receives cascaded shadows and probe bounce.
   * Safe to call before `init()` — the material is queued.
   * @param {THREE.Material} mat
   */
  registerMaterial(mat) {
    if (!mat || !mat.isMaterial) return mat;
    if (this._materials.has(mat) || this._skipMaterials.has(mat)) return mat;
    if (mat.userData?.noCSM) { this._skipMaterials.add(mat); return mat; }
    // Only lit materials have the light loops we are extending.
    const lit = mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial ||
                mat.isMeshPhongMaterial || mat.isMeshLambertMaterial || mat.isMeshToonMaterial;
    if (!lit) { this._skipMaterials.add(mat); return mat; }

    if (!this.enabled) { this._pending.push(mat); return mat; }

    try {
      // Some materials publish `onBeforeCompile` as an accessor that composes
      // every assigned hook itself (Terrain does exactly this, so CSM cannot
      // clobber its splat shader). For those, assigning is enough — reading the
      // getter back and calling it from our wrapper would re-enter the chain.
      const desc = Object.getOwnPropertyDescriptor(mat, 'onBeforeCompile');
      const selfComposing = !!(desc && typeof desc.get === 'function');

      // Otherwise preserve whatever another module already hooked. Note that
      // `Material.prototype.onBeforeCompile` is a no-op and must not be
      // mistaken for a real hook.
      const userHook =
        !selfComposing &&
        typeof mat.onBeforeCompile === 'function' &&
        mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile &&
        !mat.userData.__nonaHook
          ? mat.onBeforeCompile
          : null;

      let csmHook = null;
      if (this.csm) {
        this.csm.setupMaterial(mat);            // assigns its own callback
        // CSM overwrote the property; chain it rather than let ours replace it.
        if (!selfComposing) csmHook = mat.onBeforeCompile;
      }

      const probeOK = !!this.probes && !mat.isMeshToonMaterial;
      if (probeOK) mat.defines = Object.assign(mat.defines || {}, { [PROBE_DEFINE]: 1 });

      /* Hero rim: opt-in, per material, and the gain is the material's own — a
       * matte gambeson needs more than a burnished pauldron to read the same
       * amount. The uniform object is per material so the source stays byte
       * identical across the hero's five materials and they keep sharing one
       * program (they all publish the same customProgramCacheKey). */
      const rimGainU = this._heroRimGain(mat);
      if (rimGainU) mat.defines = Object.assign(mat.defines || {}, { [RIM_DEFINE]: 1 });

      const self = this;
      mat.onBeforeCompile = function (shader, renderer) {
        if (csmHook) { try { csmHook.call(this, shader, renderer); } catch (e) { console.error('[lighting:csm-hook]', e); } }
        if (probeOK) { try { self._injectProbe(shader); } catch (e) { console.error('[lighting:probe-hook]', e); } }
        if (userHook) { try { userHook.call(this, shader, renderer); } catch (e) { console.error('[lighting:user-hook]', e); } }
        // Last, so it sits on top of the character shader's own grade.
        if (rimGainU) { try { self._injectHeroRim(shader, rimGainU); } catch (e) { console.error('[lighting:rim-hook]', e); } }
      };
      mat.userData.__nonaHook = true;
      mat.needsUpdate = true;
      this._materials.add(mat);
    } catch (e) {
      console.warn('[lighting] could not register material —', e);
      this._skipMaterials.add(mat);
    }
    return mat;
  }

  /** @param {Iterable<THREE.Material>} list */
  registerMaterials(list) {
    if (!list) return;
    for (const m of list) {
      if (Array.isArray(m)) this.registerMaterials(m);
      else this.registerMaterial(m);
    }
  }

  /** Detach CSM + probe injection from a material (e.g. before disposing it). */
  unregisterMaterial(mat) {
    if (!this._materials.has(mat)) return;
    this._unhookMaterial(mat);
    this._materials.delete(mat);
  }

  /**
   * Add a managed practical light (torch, brazier, hellfire, magic, shaft).
   *
   * @param {object} opts see `Practical`
   * @returns {Practical} handle — mutate `.basePosition`, call `.setIntensity()`,
   *   `.extinguish()`, or pass it to `removeTorch()`.
   */
  addTorch(opts = {}) {
    const p = new Practical(opts);
    this.practicals.push(p);
    if (!opts.__auto) this._externalTorches++;

    if (opts.glow) {
      try {
        p.visual = new PracticalVisual(typeof opts.glow === 'number' ? opts.glow : 1);
        p.visual.group.position.copy(p.basePosition);
        this.engine.scene.add(p.visual.group);
      } catch { p.visual = null; }
    }
    return p;
  }

  /** @param {Practical|number} handle */
  removeTorch(handle) {
    const p = typeof handle === 'number' ? this.practicals.find((x) => x.id === handle) : handle;
    if (!p) return false;
    const i = this.practicals.indexOf(p);
    if (i < 0) return false;
    this.practicals.splice(i, 1);
    if (p._slot) { p._slot.owner = null; p._slot.want = null; p._slot.fade = 0; p._slot.light.intensity = 0; p._slot = null; }
    p.visual?.dispose();
    p.visual = null;
    return true;
  }

  /** Local bounce irradiance at a world point (for props/VFX tinting). */
  sampleIrradiance(pos, out = new THREE.Color()) {
    if (!this.probes) return out.setRGB(0, 0, 0);
    return this.probes.sample(pos, out);
  }

  /**
   * Drive the key light directly.
   * @param {object} o {dir?, elevation?, azimuth?, color?, kelvin?, intensity?, coolBias?, saturation?, shadow?}
   */
  setSun(o = {}, emit = true) {
    const s = this.sun;
    if (o.dir) {
      _tmp.copy(o.dir);
      if (_tmp.lengthSq() > 1e-8) s.dir.copy(_tmp).normalize();
    } else if (o.elevation !== undefined || o.azimuth !== undefined) {
      const el = (o.elevation ?? 45) * DEG;
      const az = (o.azimuth ?? 0) * DEG;
      // position of the sun on the hemisphere -> direction the light travels
      const px = Math.cos(el) * Math.sin(az);
      const py = Math.sin(el);
      const pz = Math.cos(el) * Math.cos(az);
      s.dir.set(-px, -py, -pz).normalize();
    }
    if (o.color !== undefined && o.color !== null) s.color.set(o.color);
    else if (o.kelvin !== undefined) kelvinColor(o.kelvin, s.color, o.saturation ?? 1, o.coolBias ?? 0);
    if (o.intensity !== undefined) s.intensity = Math.max(0, o.intensity);
    if (o.shadow !== undefined) s.shadow = o.shadow !== false;
    s.enabled = s.intensity > 0.0005;

    this._applySunToLights();
    if (emit) {
      this.engine.bus.emit('lighting:sun', {
        dir: s.dir.clone(),
        color: s.color.clone(),
        intensity: s.intensity,
        enabled: s.enabled,
      });
    }
  }

  /* ================================================================ */
  /* scenario                                                          */
  /* ================================================================ */

  applyScenario(name, cfg) {
    if (!this.enabled) return;
    try {
      const p = resolveLighting(name, cfg ?? {});
      this.preset = p;
      this._scenarioFrame = this.engine.clock.frame;

      /* hemisphere */
      this.hemi.color.set(p.hemi.sky);
      this.hemi.groundColor.set(p.hemi.ground);
      this.hemi.intensity = p.hemi.intensity;

      /* rim — the SCENE-WIDE half is capped hard (see SCENE_RIM_CEIL); the
         silhouette authority lives in the per-material term instead. */
      this.rim.color.set(p.rim.color);
      this.rim.intensity = Math.min(p.rim.intensity, SCENE_RIM_CEIL);
      this._resolveHeroRim(p, name);

      /* sun / skylight */
      if (p.sun) {
        this.setSun({
          elevation: p.sun.elevation,
          azimuth: p.sun.azimuth,
          kelvin: p.sun.kelvin,
          saturation: p.sun.saturation,
          coolBias: p.sun.coolBias,
          intensity: p.sun.intensity,
          shadow: p.sun.shadow,
        });
      } else {
        this.sun.intensity = 0;
        this.sun.enabled = false;
        this._applySunToLights();
        this.engine.bus.emit('lighting:sun', { dir: this.sun.dir.clone(), color: this.sun.color.clone(), intensity: 0, enabled: false });
      }

      /* cascades follow the scenario's useful depth range */
      if (this.csm && this.csm.maxFar !== p.maxFar) {
        this.csm.maxFar = p.maxFar;
        this.csm.updateFrustums();
        this._tuneCascadeBias();
      }

      /* probes */
      if (this.probes) this._probeUniforms.nonaProbeParams.value.set(p.probeIntensity, this.probes.scale);
      this._applyWallFill(p);

      /* IBL */
      this._refreshEnvironment();

      /* fallback atmosphere — only if nothing else owns the fog */
      this._maybeFog(p);

      /* practicals: drop the ones we spawned, let the world provide its own */
      this._clearAutoPracticals();
      this._externalTorches = this.practicals.length;

      /* if Sky already published a sun, let it win the direction back */
      if (this._skySun) this._applySkySun(this._skySun);

      this._syncPending = true;
    } catch (e) {
      console.error('[lighting:applyScenario]', e);
    }
  }

  /**
   * Resolve the hero rim + grounding pool for a scenario.
   *
   * The rim has to clear the *local background*, and how bright that background
   * is differs by a factor of three across the eight scenarios: the crypt floor
   * is warm-lit stone right under the character while the night moor is nearly
   * black. So the gain rides the scenario's own rim intensity (which already
   * encodes "how cold and how present is the back light here") and the exposure
   * the scenario is graded at, and the pool depth rides the opposite — a bright
   * floor needs more of a pool dug into it, a black one needs almost none or the
   * character stands in a hole.
   *
   * A hard ceiling of 0.78 keeps the brightest rim pixel well under the bloom
   * threshold at 1.0. A rim that blooms stops being a silhouette and becomes a
   * glow, which is the "everything glows" instant fail wearing a cape.
   */
  _resolveHeroRim(p, name) {
    const exposure = this.engine.renderer?.toneMappingExposure ?? 1;
    const r = this._heroRim;
    // Closeup is 6.5 m from a 1.85 m figure: the band covers a large share of
    // the frame there, so it tightens and backs off to stay a light rather than
    // a lacquer. Everything else is a 24-42 m gameplay distance where the whole
    // character is 30-60 px and the band has to carry the read on its own.
    const near = name === 'closeup' || name === 'inventory';
    /* Scene-linear, and deliberately NOT divided by the scenario exposure.
     * `toneMappingExposure` and the grade's gain multiply the rim and the
     * background by the same factor, so the CONTRAST between them — which is the
     * entire point — is exposure invariant. Normalising the rim by exposure (the
     * first pass did) only dimmed it relative to the floor in exactly the
     * brightest-graded scenarios, night and the crypt. */
    const base = clamp(0.34 + p.rim.intensity * 0.40, 0.34, 0.62);
    r.gain = clamp(base * (near ? 0.55 : 1.0), 0.18, 0.62);
    /* Band width is a function of how many PIXELS the figure is. At a 24-42 m
     * gameplay camera the hero is 40-70 px tall and 12-25 px wide: a band that
     * only lands on the outermost pixel of that silhouette gets averaged away by
     * the AA resolve and reads as nothing — measured, the 2.2 band was worth
     * 0.03 of torso luma. A power of 1.6 spreads it over roughly the outer half
     * of the lit side and the `kick` lobe carries the rest. At the closeup camera
     * the same power would lacquer the whole figure, so it tightens hard there
     * and the kicker is nearly switched off (the figure is 700 px there — the
     * grazing band alone is dozens of pixels wide). */
    r.pow = near ? 3.4 : 1.6;
    r.wrap = near ? 0.16 : 0.48;
    r.kick = near ? 0.06 : 0.62;
    // Worst case a per-material gain can reach is 1.32, so 0.62 * 1.32 = 0.818,
    // clamped here to 0.80. That sits under the 0.838 scene-linear bloom floor
    // (RenderPipeline: 1.55 / 1.85), so the rim can never bloom no matter how the
    // per-material gains are retuned later. A rim that blooms stops being a
    // silhouette and becomes a glow.
    r.ceil = 0.80;
    /* Pool depth follows how bright the ground under the figure is, NOT the
     * exposure: multiplicative darkening is exposure invariant in ratio, so
     * scaling it by the grade's gain (as the first pass did) just made it
     * disappear in exactly the scenarios that needed it most. Interiors get the
     * deeper pool because they are torchlit stone right under the character; a
     * dark exterior needs no help and, being multiplicative, the pool
     * self-limits there anyway (measured: 0.05 % of the hub frame changes at
     * all, because there is no value there to remove). */
    r.pool = p.interior ? 0.72 : 0.48;
    /* How far up-camera the pool's centre sits (metres). At the closeup camera the
     * figure fills the frame and the ground behind it is barely in shot, so the
     * bias collapses back onto the feet where it reads as pure contact occlusion. */
    r.poolBias = near ? 0.25 : 1.10;
    this._rimUniforms.nonaRimTune.value.set(r.pow, r.wrap, r.ceil, r.kick);
    if (this.heroPool) this.heroPool.mat.uniforms.uPool.value.x = r.pool;
  }

  /* ================================================================ */
  /* per-frame                                                         */
  /* ================================================================ */

  update(dt, elapsed) {
    if (!this.enabled) return;

    /* flicker every practical (cheap — a handful of noise taps each) */
    for (let i = 0; i < this.practicals.length; i++) this.practicals[i].tick(elapsed);

    /* auto-populate practicals if the world never placed any */
    if (this.autoPracticals && this._externalTorches === 0 && this._autoSpawned.length === 0 &&
        this._scenarioFrame >= 0 && this.engine.clock.frame - this._scenarioFrame >= 20) {
      this._spawnAutoPracticals();
    }

    /* periodically adopt materials created by other modules */
    if ((this.engine.clock.frame & 15) === 0) this._scanScene();

    this._syncPending = true;
  }

  /**
   * Everything that depends on the *final* camera for this frame. Runs from
   * `scene.onBeforeRender`, because CameraRig updates after us in the module
   * order and a one-frame-stale camera makes cascades and rim lights swim.
   */
  _syncForRender() {
    if (!this.enabled || !this._syncPending) return;
    this._syncPending = false;

    const engine = this.engine;
    const camera = engine.camera;
    const dt = engine.clock.dt || 1 / 60;

    /* --- camera changed shape? rebuild cascade splits --- */
    if (this.csm) {
      const key = `${camera.fov}|${camera.aspect}|${camera.near}|${camera.far}|${this.csm.maxFar}`;
      if (key !== this._lastCamKey) {
        this._lastCamKey = key;
        try { this.csm.updateFrustums(); this._tuneCascadeBias(); } catch (e) { console.error('[lighting:csm]', e); }
      }
    }

    /* --- where is the action? ground point under the camera's aim --- */
    this._computeFocus(camera, _focus);
    this.focus.lerp(_focus, 0.25);

    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(_projScreen);

    /* --- cascaded shadows --- */
    if (this.csm && this.sun.enabled && this.sun.shadow !== false) {
      try {
        this.csm.update();
        for (let i = 0; i < this.csm.lights.length; i++) {
          const l = this.csm.lights[i];
          l.updateMatrixWorld(true);
          l.target.updateMatrixWorld(true);
        }
      } catch (e) { console.error('[lighting:csm-update]', e); }
    } else if (this.csm && this.sun.enabled) {
      // Guarded like the branch above: this runs inside scene.onBeforeRender, so
      // a throw here would skip the rim and probe sync for the rest of the frame.
      try { this._aimUnshadowedKey(); } catch (e) { console.error('[lighting:key-aim]', e); }
    } else if (this.keyLight && this.sun.enabled) {
      this.keyLight.position.copy(this.focus).addScaledVector(this.sun.dir, -90);
      this.keyTarget.position.copy(this.focus);
      this.keyLight.updateMatrixWorld(true);
      this.keyTarget.updateMatrixWorld(true);
    }

    /* --- rim / back light tracks the camera so silhouettes always read --- */
    this._updateRim(camera);

    /* --- practical importance selection + GPU upload --- */
    // `frame` drives the pools' staggered depth-cube rebuild (see LightPool).
    const frame = engine.clock.frame | 0;
    if (this.pointPool) { this.pointPool.select(this.practicals, camera, this._frustum, dt); this.pointPool.apply(frame); }
    if (this.spotPool) { this.spotPool.select(this.practicals, camera, this._frustum, dt); this.spotPool.apply(frame); }

    /* --- irradiance grid --- */
    this._updateProbes();
  }

  /* ================================================================ */
  /* internals                                                         */
  /* ================================================================ */

  /**
   * Per-cascade bias. Both values are derived from the cascade's own world-space
   * texel size: too little and you get shimmering acne on grazing surfaces, too
   * much and contact shadows detach (peter-panning). Normal-offset does most of
   * the work; the depth bias is a small safety margin scaled into the light's
   * normalised depth range.
   */
  _tuneCascadeBias() {
    if (!this.csm) return;
    const res = this.shadowRes;
    const depthRange = Math.max(1, this.csm.lightFar - this.csm.lightNear);
    for (let i = 0; i < this.csm.lights.length; i++) {
      const l = this.csm.lights[i];
      const cam = l.shadow.camera;
      const extent = Math.max(0.001, cam.right - cam.left);
      const texel = extent / res;

      // Offset along the normal by a bit over one texel diagonal.
      l.shadow.normalBias = clamp(texel * 1.55, 0.012, 0.34);
      // ~1.2 texels of depth slop, expressed in the shadow camera's [0,1] depth.
      l.shadow.bias = -clamp((texel * 1.2) / depthRange, 0.000012, 0.0009);
      // Penumbra that stays roughly constant in world units across cascades.
      l.shadow.radius = clamp(0.055 / texel, 1.0, 4.5);
      l.shadow.mapSize.setScalar(res);
      l.shadow.intensity = 1;
    }
  }

  /** Re-add the light-probe-grid hook CSM strips out of `lights_fragment_begin`. */
  _patchCSMChunk() {
    // CSM replaces the stock chunk wholesale; nothing of ours lives there, but
    // keep the stock probe-grid block so a future LightProbeGrid still works.
    try {
      const stock = this._chunkBackup?.begin ?? '';
      const cur = THREE.ShaderChunk.lights_fragment_begin;
      if (!cur.includes('USE_LIGHT_PROBES_GRID') && stock.includes('USE_LIGHT_PROBES_GRID')) {
        const block = `
	#ifdef USE_LIGHT_PROBES_GRID
		vec3 probeWorldPos = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 probeWorldNormal = transformNormalByInverseViewMatrix( geometryNormal, viewMatrix );
		irradiance += getLightProbeGridIrradiance( probeWorldPos, probeWorldNormal );
	#endif
`;
        // The block must land INSIDE `#if defined( RE_IndirectDiffuse )`, where
        // `irradiance` is declared — i.e. just before that block's closing
        // `#endif`, which is the last one before the RE_IndirectSpecular guard.
        const anchor = cur.lastIndexOf('#if defined( RE_IndirectSpecular )');
        const at = anchor > 0 ? cur.lastIndexOf('#endif', anchor) : -1;
        if (at > 0) {
          THREE.ShaderChunk.lights_fragment_begin =
            cur.slice(0, at) + block + '\n' + cur.slice(at);
        }
      }
    } catch (e) {
      console.warn('[lighting] probe-grid chunk patch skipped —', e);
    }
  }

  _restoreChunks() {
    if (!this._chunkBackup) return;
    THREE.ShaderChunk.lights_fragment_begin = this._chunkBackup.begin;
    THREE.ShaderChunk.lights_pars_begin = this._chunkBackup.pars;
    this._chunkBackup = null;
  }

  /**
   * Aim the cascade lights when they are NOT casting — i.e. sunless interiors.
   *
   * THIS IS THE ONE THAT MADE VERTICAL INTERIOR SURFACES READ AS VOID.
   *
   * `CSM.update()` is the only thing in the addon that ever writes
   * `light.position` / `light.target.position`; `csm.lightDirection` is just an
   * input it reads. `_syncForRender` skips `csm.update()` outright for sunless
   * interiors — correct, because that call is what allocated four directional
   * shadow cascades through the ceiling — and the `keyLight` branch below it is
   * unreachable whenever CSM constructed successfully, because `keyLight` only
   * exists in the CSM-unavailable fallback. So nothing aimed them.
   *
   * Measured on the frozen `boss` frame: all four cascade lights sat at the
   * THREE.DirectionalLight defaults, position (0, 1, 0) and target (0, 0, 0),
   * which is a key travelling STRAIGHT DOWN (0, -1, 0) while `sun.dir` said
   * (0.256, -0.839, 0.481). A straight-down key makes dot(N, L) equal to N.y, so
   * it handed the whole of its then-0.88 to the arena floor and EXACTLY ZERO to
   * anything near-vertical. That is the whole defect: the floor looked lit, so
   * the rig looked like it was working, while the 6.2 m rock faces got nothing
   * from the only real light in the room and fell back on 0.076 of ambient
   * irradiance. It also explains why the authored `azimuth` had no observable
   * effect whatsoever — the value was never read by anything.
   *
   * A DirectionalLight shades from `normalize(target.position - position)` and
   * nothing else, and that difference here is `sun.dir * 90` whatever `focus`
   * happens to be — so the rendered result does not depend on the position at
   * all and two runs of a capture stay byte-identical (verified: md5-equal). The
   * position is anchored on `focus` anyway, purely so this matches the shadowed
   * path above and a debug helper drawing the light lands somewhere sensible.
   */
  _aimUnshadowedKey() {
    const lights = this.csm.lights;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      l.position.copy(this.focus).addScaledVector(this.sun.dir, -90);
      l.target.position.copy(this.focus);
      l.updateMatrixWorld(true);
      l.target.updateMatrixWorld(true);
    }
  }

  /**
   * Push the resolved interior wall bounce into the shared uniform.
   *
   * `Color.setHex` runs the sRGB -> linear convert, so the authored hex is a HUE
   * and `intensity` is the whole magnitude — same contract as the hemisphere,
   * and the reason the presets can carry a readable slate rather than a value
   * scaled to look right as a literal. The uniform object is shared by
   * reference with every registered material, so writing `.value` here needs no
   * recompile and cannot desync a material that registers later.
   */
  _applyWallFill(p) {
    const f = p?.wallFill;
    const c = this._probeUniforms.nonaWallFill.value;
    if (!f) { c.setRGB(0, 0, 0); return; }
    c.set(f.color).multiplyScalar(f.intensity ?? 1);
  }

  /** Add the irradiance-grid lookup to a compiled material. */
  _injectProbe(shader) {
    if (!shader.fragmentShader.includes(PROBE_HOOK)) return;
    const u = this._probeUniforms;
    shader.uniforms.nonaProbeVol = u.nonaProbeVol;
    shader.uniforms.nonaProbeMin = u.nonaProbeMin;
    shader.uniforms.nonaProbeInvSize = u.nonaProbeInvSize;
    shader.uniforms.nonaProbeParams = u.nonaProbeParams;
    shader.uniforms.nonaWallFill = u.nonaWallFill;

    shader.fragmentShader =
      `#ifdef ${PROBE_DEFINE}
uniform highp sampler3D nonaProbeVol;
uniform vec3 nonaProbeMin;
uniform vec3 nonaProbeInvSize;
uniform vec2 nonaProbeParams;
uniform vec3 nonaWallFill;
#endif
` + shader.fragmentShader.replace(
        PROBE_HOOK,
        `${PROBE_HOOK}
#if defined( ${PROBE_DEFINE} ) && defined( RE_IndirectDiffuse )
	{
		// world position reconstructed from view space (no extra varyings)
		vec3 sctWP = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		vec3 sctUVW = ( sctWP - nonaProbeMin ) * nonaProbeInvSize;
		vec3 sctCl = clamp( sctUVW, vec3( 0.0 ), vec3( 1.0 ) );
		float sctEdge = 1.0 - smoothstep( 0.0, 0.10, length( sctUVW - sctCl ) );
		irradiance += texture( nonaProbeVol, sctCl ).rgb * nonaProbeParams.x * nonaProbeParams.y * sctEdge;

		/* ORIENTED INTERIOR WALL BOUNCE. \`geometryNormal\` is VIEW space, and
		 * this term has to be keyed off world up, so rotate it back: for the
		 * orthonormal view rotation, \`n * mat3( viewMatrix )\` is
		 * \`transpose( R ) * n\`, which is the inverse. Same trick the world
		 * position above uses, and it costs no new varying.
		 *
		 * The weight is 1 - |n.y|: full on a vertical wall, zero on a floor or
		 * a ceiling. That is the shape a room has and a hemisphere does not,
		 * and the zero at n.y = -1 is what keeps overhangs and undersides at
		 * true black instead of turning the frame milky. Squaring is wrong
		 * here — it would collapse the 45-degree bevels that make up most of
		 * the rock silhouette, and those are exactly the faces at issue.
		 *
		 * Adding into \`irradiance\` (not into \`reflectedLight\`) is deliberate:
		 * it keeps the term inside the aoMap multiply that follows in
		 * \`aomap_fragment\`, so it reads as lit stone with cavities rather
		 * than as a flat lift. */
		vec3 sctWN = geometryNormal * mat3( viewMatrix );
		irradiance += nonaWallFill * ( 1.0 - min( abs( sctWN.y ), 1.0 ) );
	}
#endif`
      );
  }

  /**
   * Does this material want the character rim, and how much of it?
   *
   * `userData.charRim` is the contract: a number is a gain, `true` is 1, `false`
   * opts out explicitly. `userData.heroRim` is the original spelling and is still
   * honoured (CharacterMesh publishes it). The `hero_` name prefix is the
   * fallback so the cloak (built by a different module) picks it up without a
   * second registration path. MonsterMaterials publishes `charRim` per recipe.
   *
   * Everything else in the scene returns null and never compiles the term at all
   * — which is the whole point: only FIGURES may be rim-lit, or the term buys
   * brightness and no separation.
   * @returns {{value:number}|null} a per-material uniform, or null
   */
  _heroRimGain(mat) {
    const ud = mat.userData ?? {};
    const raw = ud.charRim !== undefined && ud.charRim !== null ? ud.charRim : ud.heroRim;
    let g = null;
    if (raw !== undefined && raw !== null) {
      if (raw === false) return null;
      g = raw === true ? 1 : Number(raw);
    } else if (typeof mat.name === 'string' && mat.name.startsWith('hero_')) {
      g = 1;
    }
    if (g === null || !Number.isFinite(g) || g <= 0) return null;
    return { value: g };
  }

  /** Add the character-locked rim term to a compiled material (hero or monster). */
  _injectHeroRim(shader, gainU) {
    const src = shader.fragmentShader;
    // Both are present in meshstandard/meshphysical; bail rather than emit a
    // shader that cannot link if a three version ever drops them.
    if (!src.includes('vViewPosition') || !src.includes('#include <normal_fragment_begin>')) return;
    let anchor = null;
    for (const a of RIM_ANCHORS) { if (src.includes(a)) { anchor = a; break; } }
    if (!anchor) return;

    const u = this._rimUniforms;
    shader.uniforms.nonaRimDir = u.nonaRimDir;
    shader.uniforms.nonaRimCol = u.nonaRimCol;
    shader.uniforms.nonaRimTune = u.nonaRimTune;
    shader.uniforms.nonaRimGain = gainU;

    shader.fragmentShader =
      `#ifdef ${RIM_DEFINE}
uniform vec3 nonaRimDir;    // world-space direction TOWARD the rim source
uniform vec3 nonaRimCol;    // linear colour, premultiplied by scenario intensity
uniform vec4 nonaRimTune;   // x: fresnel power, y: terminator wrap, z: scene-linear ceiling, w: kicker gain
uniform float nonaRimGain;  // per-material gain
#endif
` + src.replace(
        anchor,
        `#ifdef ${RIM_DEFINE}
	{
		vec3 sctRimN = normalize( normal );
		vec3 sctRimV = normalize( vViewPosition );
		// Which side of the figure the rim source is on. Everything below is
		// gated on this, so the camera-facing side stays dark and the term reads
		// as a LIGHT rather than as a cartoon outline drawn round the whole body.
		vec3 sctRimL = normalize( ( viewMatrix * vec4( nonaRimDir, 0.0 ) ).xyz );
		// ...and its mirror across the camera's vertical plane, at 0.62 weight.
		// ONE back light outlines ONE shoulder, and on a 12-25 px torso that is a
		// half-figure read: measured, the hero gained only 0.028 of body luma from
		// the single-lobe term while a broad-backed brute gained 0.062, purely
		// because the brute had more surface facing the one direction. The mirror
		// wraps the whole upper silhouette and still leaves a clear key side.
		vec3 sctRimL2 = vec3( -sctRimL.x, sctRimL.y, sctRimL.z );
		float sctSideA = clamp( ( dot( sctRimN, sctRimL ) + nonaRimTune.y ) /
			( 1.0 + nonaRimTune.y ), 0.0, 1.0 );
		float sctSideB = clamp( ( dot( sctRimN, sctRimL2 ) + nonaRimTune.y ) /
			( 1.0 + nonaRimTune.y ), 0.0, 1.0 );
		float sctRimSide = max( sctSideA, sctSideB * 0.62 );
		float sctRimSide2 = sctRimSide * sctRimSide;
		// LOBE 1 — the grazing band. Draws the actual outline.
		float sctRimEdge = pow( 1.0 - clamp( dot( sctRimV, sctRimN ), 0.0, 1.0 ), nonaRimTune.x );
		// LOBE 2 — a broad back-light kicker over the whole far side. At 20-40 px
		// of figure this is the half that survives the AA resolve; without it the
		// band is a single pixel and averages to nothing (see the note above).
		float sctRimLobe = sctRimEdge * sctRimSide2 + nonaRimTune.w * sctRimSide2 * sctRimSide;
		// Hard ceiling, in scene-linear units, so no per-material gain can ever
		// push the band over the bloom threshold no matter how it is tuned.
		gl_FragColor.rgb += min(
			nonaRimCol * ( sctRimLobe * nonaRimGain ),
			vec3( nonaRimTune.z ) );
	}
#endif
` + anchor
      );
  }

  /**
   * The hero's grounding pool — a soft radial darkening on the ground centred on
   * the character. It is doing two jobs at once, and the second is the one that
   * matters:
   *
   *  1. It anchors the figure. A 30-px character standing on an evenly lit floor
   *     with no occlusion under it reads as a decal, however good the shadow map
   *     is; the CSM shadow falls away from the feet and says nothing about the
   *     ground the character is *on*.
   *  2. It drops the local background value so the rim has something to read
   *     against. A cool edge at 0.6 radiance over a crypt floor sitting at 0.5
   *     is invisible; over the same floor pulled down 35 % it is unmistakable.
   *     This is exactly the trick D4 uses on its hero and it is the reason its
   *     characters read at any zoom.
   *
   * Multiplicative (dst * (1 - a)), never additive, so it can only ever remove
   * light — it cannot lift blacks or wash the floor grey. `transparent` +
   * `depthWrite: false` also keeps it out of the G-buffer prepass, so GTAO, DOF
   * and motion blur never see it.
   */
  _buildHeroPool() {
    try {
      /* Quad half-extent MUST stay above `uPool.y` (the outer radius) or the
         ramp is cut off mid-falloff and the pool ends in a hard square edge on
         the floor — an instant fail. 5.6 m quad, 2.55 m radius. */
      const geo = new THREE.PlaneGeometry(5.6, 5.6, 1, 1);
      geo.rotateX(-Math.PI * 0.5);
      const mat = new THREE.ShaderMaterial({
        name: 'nona.heroPool',
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        uniforms: { uPool: { value: new THREE.Vector3(0.52, 2.25, 0.44) } },
        vertexShader: /* glsl */`
          varying vec2 vP;
          void main() {
            vP = position.xz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uPool;   // x: peak darkening, y: outer radius (m), z: core fraction
          varying vec2 vP;
          void main() {
            float t = length( vP ) / uPool.y;
            /* Two lobes. The core is real contact occlusion directly under the
               body — it is mostly hidden BY the body, which is what occlusion
               looks like. The wide lobe is the composition half: a gentle ramp
               that pulls the local value down so the rim has something to read
               against, without ever forming an edge you could point at. The
               first pass squared the wide term, which collapsed it to nothing
               past half a metre and made the whole pool invisible at gameplay
               distance — a squared falloff is a spotlight, not ambient
               occlusion. Both terms reach exactly zero at the quad edge. */
            float wide = 1.0 - smoothstep( 0.06, 1.0, t );
            float core = 1.0 - smoothstep( 0.0, uPool.z, t );
            /* Reweighted 0.52/0.48 -> 0.60/0.40 with a wider core (uPool.z), because
               the core was only 0.45 m across and therefore hidden almost entirely
               by the body standing on it — measured, the whole pool removed 0.031
               of luma on average from the 232x205 px region it covers. The value
               that matters is the ground the figure is READ AGAINST, half a metre
               to two metres out, and that is the wide lobe's job. */
            float a = uPool.x * ( wide * 0.60 + core * 0.40 );
            if ( a < 0.004 ) discard;
            gl_FragColor = vec4( 0.0, 0.0, 0.0, clamp( a, 0.0, 0.72 ) );
          }`,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'nona.heroPool';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = -2;             // under every other transparent
      mesh.visible = false;              // until a hero exists
      mesh.userData.noCSM = true;
      mesh.userData.occluder = false;
      mesh.userData.noOcclude = true;
      mesh.userData.noGBuffer = true;
      this.engine.scene.add(mesh);
      this.heroPool = { mesh, mat, geo };
    } catch (e) {
      console.warn('[lighting] hero grounding pool unavailable —', e?.message ?? e);
      this.heroPool = null;
    }
  }

  _unhookMaterial(mat) {
    try {
      if (this.csm) {
        const sh = this.csm.shaders;
        if (sh?.has(mat)) sh.delete(mat);
      }
      if (mat.defines) {
        delete mat.defines.USE_CSM;
        delete mat.defines.CSM_CASCADES;
        delete mat.defines.CSM_FADE;
        delete mat.defines[PROBE_DEFINE];
        delete mat.defines[RIM_DEFINE];
      }
      mat.onBeforeCompile = function () {};
      delete mat.userData.__nonaHook;
      mat.needsUpdate = true;
    } catch {}
  }

  /**
   * Adopt shadow-receiving materials that other modules created without telling
   * us. Not a substitute for registerMaterial(), but it means a module that
   * forgets still gets correct cascaded shadows.
   */
  _scanScene() {
    if (!this.enabled) return;
    const scene = this.engine.scene;
    scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh && !o.isBatchedMesh) return;
      if (o.userData?.noCSM) return;
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const mm of m) this.registerMaterial(mm); }
      else this.registerMaterial(m);
    });
  }

  /**
   * `castShadow` is gated on `sun.shadow` as well as `sun.enabled`. Dropping it
   * for sunless interiors also drops four directional shadow samplers out of
   * every lit material, which is most of the margin under the hard 16-unit
   * fragment limit this project sits against.
   */
  _applySunToLights() {
    const s = this.sun;
    const cast = s.enabled && s.shadow !== false;
    if (this.csm) {
      this.csm.lightDirection.copy(s.dir);
      for (const l of this.csm.lights) {
        l.color.copy(s.color);
        l.intensity = s.intensity;
        l.visible = s.enabled;
        l.castShadow = cast;
      }
    }
    if (this.keyLight) {
      this.keyLight.color.copy(s.color);
      this.keyLight.intensity = s.intensity;
      this.keyLight.visible = s.enabled;
      this.keyLight.castShadow = cast;
    }
  }

  /**
   * Sky owns the sun *direction* (it draws the disc and derives extinction from
   * it); we own the shadow response and, for sunless interiors, the whole key.
   * Sky publishes `dir` pointing TOWARD the light, so the travel direction is
   * its negation.
   */
  _onSkySun(p) {
    if (!p) return;
    this._skySun = p;
    this.sun.ownedBySky = true;
    this._applySkySun(p);
  }

  _applySkySun(p) {
    const preset = this.preset;
    const sun = preset.sun;

    // Interiors with no skylight take nothing from Sky at all.
    if (!sun) return;

    // --- direction: Sky's, unless this key is deliberately art-directed ---
    // (a crypt's ceiling shaft has nothing to do with where the sun is).
    if (!sun.authored) {
      let toward = null;
      if (p.dir && p.dir.isVector3) toward = _tmp2.copy(p.dir);
      else if (p.position) toward = _tmp2.copy(p.position);
      if (toward && toward.lengthSq() > 1e-8) {
        toward.normalize();
        // Only adopt it while the source is above the horizon — a set sun would
        // otherwise light the level from underneath.
        if (toward.y > 0.04) this.sun.dir.copy(toward).multiplyScalar(-1);
      }
    }

    // --- colour + intensity stay ours ---
    // Sky's own key is derived from its atmosphere model and does not know the
    // scenario's art direction ("town at DUSK" wants a warm low key even when
    // Sky's solar model has already put the sun to bed). Contract: Sky owns
    // direction, Lighting owns the shadow and intensity response.

    // Ambient *hue* follows the sky that is actually being drawn, so the fill
    // never disagrees with the horizon; the ambient *level* stays ours.
    if (this.hemi && !preset.interior) {
      if (p.ambientSky) this.hemi.color.set(preset.hemi.sky).lerp(p.ambientSky, 0.55);
      if (p.ambientGround) this.hemi.groundColor.set(preset.hemi.ground).lerp(p.ambientGround, 0.45);
      if (p.ambientIntensity !== undefined) {
        // Sky modulates the fill, it does not get to double it — the value
        // structure ("dark, mid-tones dominate") is art direction, not physics.
        this.hemi.intensity = clamp(preset.hemi.intensity * clamp(p.ambientIntensity / 0.6, 0.65, 1.25), 0, 1.15);
      }
    }

    this._applySunToLights();
  }

  _onSkyEnv(p) {
    const tex = p?.texture ?? p?.envMap ?? (p?.isTexture ? p : null);
    if (!tex) return;
    // Sky has a better environment than our fallback — take it.
    this._disposeEnv();
    this._envOwned = false;
    this.engine.scene.environment = tex;
    this.engine.scene.environmentIntensity = this.preset.envIntensity;
  }

  _refreshEnvironment() {
    const engine = this.engine;
    const scene = engine.scene;
    const p = this.preset;

    scene.environmentIntensity = p.envIntensity;

    // Someone else (Sky) already provided one — respect it.
    if (scene.environment && !this._envOwned) return;

    // Prefer the shared AssetForge if it exposes an env map factory.
    // Ownership priority: Sky (real atmosphere) > AssetForge (biome preset) >
    // our own gradient fallback. We never fight for it.
    const forge = engine.assets ?? engine.get?.('assets');
    if (forge && typeof forge.envMap === 'function') {
      let tex = null;
      try { tex = forge.envMap({ preset: p.biome, biome: p.biome, scenario: p.name, interior: p.interior }); }
      catch { try { tex = forge.envMap(); } catch {} }
      const t = tex?.isTexture ? tex : tex?.texture;
      if (t?.isTexture) {
        this._disposeEnv();
        this._envOwned = false;
        scene.environment = t;
        return;
      }
    }

    // Fallback: build our own gradient sky and PMREM it. Still a real IBL —
    // horizon glow, ground bounce, sun disc — never a flat ambient term.
    try {
      const sunColor = this.sun.enabled ? this.sun.color : null;
      const src = buildSkyEquirect(p.env, this.sun.enabled ? this.sun.dir : null, sunColor, 128, 64);
      const pmrem = new THREE.PMREMGenerator(engine.renderer);
      pmrem.compileEquirectangularShader();
      const rt = pmrem.fromEquirectangular(src);
      pmrem.dispose();

      this._disposeEnv();
      this._envRT = rt;
      this._envSrc = src;
      this._envOwned = true;
      scene.environment = rt.texture;
    } catch (e) {
      console.warn('[lighting] environment probe failed —', e);
    }
  }

  _disposeEnv() {
    if (this._envRT) { try { this._envRT.dispose(); } catch {} this._envRT = null; }
    if (this._envSrc) { try { this._envSrc.dispose(); } catch {} this._envSrc = null; }
  }

  _maybeFog(p) {
    const scene = this.engine.scene;
    const sky = this.engine.get?.('sky');
    const weather = this.engine.get?.('weather');
    const someoneElseOwnsIt = (sky && !sky.__dead) || (weather && !weather.__dead);
    if (someoneElseOwnsIt) {
      if (this._fogOwned) { scene.fog = null; this._fogOwned = false; }
      return;
    }
    if (!p.fog) return;
    if (scene.fog && !this._fogOwned) return;
    if (!scene.fog || !this._fogOwned) scene.fog = new THREE.Fog(p.fog.color, p.fog.near, p.fog.far);
    else { scene.fog.color.set(p.fog.color); scene.fog.near = p.fog.near; scene.fog.far = p.fog.far; }
    this._fogOwned = true;
  }

  /** Ground point the camera is aimed at — the centre of the play area. */
  _computeFocus(camera, out) {
    camera.getWorldDirection(_tmp);
    const eye = camera.position;
    if (Math.abs(_tmp.y) > 1e-3) {
      const t = clamp(-eye.y / _tmp.y, 0, 400);
      out.copy(eye).addScaledVector(_tmp, t);
    } else {
      out.copy(eye).addScaledVector(_tmp, 24);
      out.y = 0;
    }
    if (!Number.isFinite(out.x) || !Number.isFinite(out.z)) out.set(0, 0, 0);
  }

  /**
   * A cold back light, 150-ish degrees around from the camera and slightly
   * elevated. It never casts shadow. The scene-wide DirectionalLight half is a
   * low fill (SCENE_RIM_CEIL); the direction computed here is what actually
   * matters, because it also drives the per-material CHARACTER rim that puts a
   * cool edge on the hero AND on every monster so their silhouettes separate
   * from the ground whatever the ground happens to be doing.
   */
  _updateRim(camera) {
    const p = this.preset.rim;
    const f = this.focus;
    // azimuth from the focus toward the camera
    const camAz = Math.atan2(camera.position.x - f.x, camera.position.z - f.z);
    const base = camAz + Math.PI;
    const off = Math.abs(p.azimuth - 180) * DEG;

    /* Which side of dead-behind the rim sits on is a composition decision, and
     * the rule is: as far from the key light's yaw as the offset allows. A rim
     * that shares the key's azimuth lands on the edge the key already lights, so
     * it buys brightness and no separation — the exact failure the critic saw.
     * Camera-locked rather than key-locked, because the interiors' key is a
     * ceiling shaft at 57-64 degrees of elevation and its yaw says nothing about
     * which screen edge of the figure is dark. */
    let rimAz = base - off;
    if (this.sun.enabled && off > 1e-3) {
      const keyAz = Math.atan2(-this.sun.dir.x, -this.sun.dir.z);
      const sep = (a) => Math.abs(((a - keyAz + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (sep(base + off) > sep(base - off)) rimAz = base + off;
    }

    const el = p.elevation * DEG;
    const dist = 34;
    const dx = Math.sin(rimAz) * Math.cos(el);
    const dy = Math.sin(el);
    const dz = Math.cos(rimAz) * Math.cos(el);
    this.rim.position.set(f.x + dx * dist, f.y + dy * dist + 2.2, f.z + dz * dist);
    this.rimTarget.position.copy(f);
    this.rim.updateMatrixWorld(true);
    this.rimTarget.updateMatrixWorld(true);

    /* Same direction feeds the per-material hero rim. `this.rim.color` is
     * already the preset colour converted to linear, so the shader term stays on
     * the scenario's colour story (cold slate in the crypt, violet in the arena,
     * silver under moonlight) without a second table to keep in sync. */
    const ru = this._rimUniforms;
    ru.nonaRimDir.value.set(dx, dy, dz).normalize();
    /* Chroma, then LUMINANCE normalisation, then a peak clamp. The order is the
     * whole fix, and it is arithmetic, not taste.
     *
     * The previous pass pushed chroma by 1.45x and then renormalised on the PEAK
     * channel. For the crypt's 0x74a3d9 that produced a scene-linear rim of
     * (0.07, 0.273, 0.62): a saturated blue whose LUMINANCE is
     * 0.2126*0.07 + 0.7152*0.273 + 0.0722*0.62 = 0.335, i.e. barely half the 0.62
     * the gain claimed. Blue carries 7 % of luma; normalising a blue light on its
     * blue channel throws most of the brightness away, and brightness is the
     * entire mechanism by which a rim separates a silhouette. Measured: the whole
     * term was worth +0.028 of hero body luma.
     *
     * So the push now DESATURATES slightly (0.78 pulls the colour toward its own
     * luma) — a bright cold light reads blue-WHITE, not blue; only a dim one reads
     * as a saturated hue — and the normalisation targets luminance, so `gain` is
     * literally how bright the rim is. The peak clamp then keeps the brightest
     * channel under the bloom floor (1.55/1.85 = 0.838 scene-linear, see
     * RenderPipeline's EXPOSURE BUDGET note), because a rim that blooms stops
     * being a silhouette and becomes a glow.
     *
     * k = 0.62 is where the two constraints meet. Below it the rim desaturates
     * toward white and stops telling the scenario's colour story; above it the
     * blue channel hits the bloom clamp first and the clamp throws away luminance
     * the silhouette needs. At 0.62 the crypt rim resolves to (0.34, 0.51, 0.80)
     * scene-linear: 0.496 luminance, blue 2.35x red — unmistakably cold, and 47 %
     * brighter than the 0.335 the peak-normalised version emitted. */
    const c = this.rim.color, g = this._heroRim.gain, ceil = this._heroRim.ceil;
    const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    const k = 0.62;
    const cr = Math.max(0, lum + (c.r - lum) * k);
    const cg = Math.max(0, lum + (c.g - lum) * k);
    const cb = Math.max(0, lum + (c.b - lum) * k);
    const lum2 = Math.max(1e-4, cr * 0.2126 + cg * 0.7152 + cb * 0.0722);
    let s = g / lum2;
    const peak = Math.max(cr, cg, cb, 1e-4) * s;
    if (peak > ceil) s *= ceil / peak;
    ru.nonaRimCol.value.set(cr * s, cg * s, cb * s);
    ru.nonaRimTune.value.set(this._heroRim.pow, this._heroRim.wrap, this._heroRim.ceil, this._heroRim.kick);

    this.hemi.position.set(f.x, f.y + 40, f.z);
    this._updateHeroPool();
  }

  /**
   * Park the grounding pool on the character and orient it to the ground.
   *
   * BIASED UP-CAMERA, and that is a measured correction rather than a fudge. The
   * pool was centred exactly on the hero's feet, which is where a contact shadow
   * belongs but NOT where the hero's screen-space background is: at a 55-degree
   * pitch the top of a 1.85 m figure projects over ground roughly 2.6 m BEHIND it,
   * so a 1.9 m pool centred on the feet fell almost entirely inside the figure's
   * own footprint. Measured on `combat`: turning the pool from 0 to full moved the
   * luma behind the hero's silhouette by 0.015, while a deliberately flat test
   * pool over the same quad moved 32,441 pixels by 0.175 — it was rendering
   * correctly and covering the wrong ground.
   *
   * Offsetting the centre along the horizontal camera-forward axis puts the deep
   * half of the ramp exactly where the figure is read against it. It cannot be
   * mistaken for a misplaced shadow because it has no edge and no direction: it is
   * a 2.55 m radial value ramp reaching zero well inside the quad.
   */
  _updateHeroPool() {
    const pool = this.heroPool;
    if (!pool) return;
    const hero = this.engine.get?.('hero');
    const pos = hero && !hero.__dead && hero.failed !== true ? hero.position : null;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
      pool.mesh.visible = false;
      return;
    }
    pool.mesh.visible = true;
    /* Horizontal camera-forward, i.e. "away from the lens along the ground". */
    const cam = this.engine.camera;
    _tmp.set(pos.x - cam.position.x, 0, pos.z - cam.position.z);
    const len = Math.hypot(_tmp.x, _tmp.z);
    const bias = this._heroRim.poolBias;
    const bx = len > 1e-3 ? (_tmp.x / len) * bias : 0;
    const bz = len > 1e-3 ? (_tmp.z / len) * bias : 0;
    pool.mesh.position.set(pos.x + bx, (Number.isFinite(pos.y) ? pos.y : 0) + 0.035, pos.z + bz);

    const terrain = this.engine.get?.('terrain');
    if (terrain && !terrain.__dead && typeof terrain.normalAt === 'function') {
      try {
        terrain.normalAt(pos.x, pos.z, _tmp);
        if (_tmp.lengthSq() > 1e-6) {
          _tmp.normalize();
          pool.mesh.quaternion.setFromUnitVectors(_tmp2.set(0, 1, 0), _tmp);
        }
      } catch { /* flat is an acceptable degrade */ }
    }
    pool.mat.uniforms.uPool.value.x = this._heroRim.pool;
    pool.mesh.updateMatrixWorld(true);
  }

  /**
   * Rebuild the irradiance grid. Lights that lost their GPU slot still splat
   * here at full weight, so the pool cutoff reads as "that torch is far away"
   * rather than "that torch switched off".
   */
  _updateProbes() {
    const probes = this.probes;
    if (!probes) return;
    const p = this.preset;

    probes.recenter(this.focus);
    this._probeUniforms.nonaProbeMin.value.copy(probes.texMin);
    this._probeUniforms.nonaProbeInvSize.value.copy(probes.texInvSize);

    probes.begin(0, 0, 0);
    const bounce = p.bounce;
    const list = this.practicals;
    const min = probes.min;
    const maxX = min.x + probes.size.x, maxZ = min.z + probes.size.z;

    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t.enabled || t.intensity <= 0) continue;
      const q = t.position;
      if (q.x + t.radius < min.x || q.x - t.radius > maxX) continue;
      if (q.z + t.radius < min.z || q.z - t.radius > maxZ) continue;
      // An unpooled light contributes its whole (soft) self; a pooled one only
      // contributes the bounce it would kick off nearby surfaces.
      const w = bounce * (0.32 + 0.68 * (1 - t._live));
      probes.splat(q, t.color, t.intensity, t.radius, w);
    }
    probes.commit();
  }

  _spawnAutoPracticals() {
    try {
      const engine = this.engine;
      const cfg = engine.scenario ?? {};
      const name = this.preset.name;
      const rand = engine.freshRand
        ? engine.freshRand(`lighting:${name}`)
        : engine.rand(`lighting:${name}`);
      const list = defaultPracticals(name, cfg, rand);
      // The layouts author Y as a height above the floor, but Terrain's surface
      // is nowhere near y = 0 on the taller biomes (the moor sits ~7 m up at the
      // origin), so taken literally every torch spawns *inside* the hill and
      // contributes no light at all. Rebase onto the real ground when Terrain is
      // available; degrade to the authored Y when it is not.
      const terrain = engine.get?.('terrain');
      const groundAt = terrain && !terrain.__dead && typeof terrain.heightAt === 'function'
        ? (x, z) => { const y = terrain.heightAt(x, z); return Number.isFinite(y) ? y : 0; }
        : null;
      for (const d of list) {
        d.__auto = true;
        if (groundAt && Array.isArray(d.position) && d.position.length >= 3) {
          d.position[1] += groundAt(d.position[0], d.position[2]);
        }
        this._autoSpawned.push(this.addTorch(d));
      }
    } catch (e) {
      console.warn('[lighting] default practicals skipped —', e);
    }
  }

  _clearAutoPracticals() {
    for (const p of this._autoSpawned) this.removeTorch(p);
    this._autoSpawned.length = 0;
  }
}

/**
 * Practical cascade split with lambda = 0.7 (three's built-in `practical` mode
 * hard-codes 0.5, which wastes cascade 0 on an ARPG camera). Blends the uniform
 * and logarithmic schemes so cascade 0 hugs the hero.
 */
function practicalSplit07(amount, near, far, target) {
  const lambda = 0.7;
  for (let i = 1; i < amount; i++) {
    const uniform = (near + (far - near) * (i / amount)) / far;
    const log = (near * Math.pow(far / near, i / amount)) / far;
    target.push(lerp(uniform, log, lambda));
  }
  target.push(1);
}
