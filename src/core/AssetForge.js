/**
 * SANCTUM — AssetForge: the procedural PBR material factory.
 *
 * Nothing in this project ships an authored texture. Every albedo, normal,
 * roughness, metalness, occlusion and height map in the game is synthesised
 * here at runtime from the deterministic noise in Rand.js, so this file is
 * effectively the art direction of the whole build.
 *
 * Design notes
 * ------------
 * • ORM packing. Occlusion / roughness / metalness share one RGBA texture in
 *   the glTF channel convention (R/G/B), with the height in alpha. three.js
 *   samples .r/.g/.b from the respective slots, so pointing all three material
 *   maps at one texture is both correct and a 3x saving in VRAM and fetches.
 * • Normals are Sobel-differentiated from the real height field after the wear
 *   pass has filled cavities with grime — dirt physically softens micro-relief,
 *   and reproducing that is most of what separates "PBR" from "believable".
 * • Caching is keyed on the normalised option object. Regenerating a 1024²
 *   stone is ~150 ms of main-thread work; doing it twice is a bug, so distinct
 *   tilings clone the base textures (three shares the GPU upload through
 *   Texture.source) rather than re-synthesising.
 * • Determinism: no Math.random, no Date.now in anything that touches pixels.
 *   performance.now() appears only in the diagnostic timings returned by
 *   __selftest()/stats(), which never influence a rendered frame.
 *
 * Public surface (see ENGINE_CONTRACT.md):
 *   engine.assets.pbr({kind,size,seed,tiling,tint})
 *   engine.assets.material({kind, ...materialOverrides})
 *   engine.assets.register(name, fn)
 *   engine.assets.envMap({preset})
 *   engine.assets.noiseTexture(size, seed)
 *   engine.assets.blueNoise(size)
 *   engine.assets.__selftest()
 */
import * as THREE from 'three';
import { makeRand, hash2 } from './Rand.js';
import * as TG from './texgen/Noise.js';
import {
  GenCtx, finalize, packAlbedo, packORM, packHeight, packEmissive,
  sobelNormal, field, fieldN, blurWrap, upsampleWrap, normalizeInPlace,
} from './texgen/Field.js';
import { KINDS, KIND_LIST, KIND_ALIASES, KIND_MATERIAL, ALPHA_KINDS } from './texgen/Kinds.js';

/** Toolkit handed to third-party generators registered via `register()`. */
export const FORGE_TOOLKIT = {
  ...TG, field, fieldN, blurWrap, upsampleWrap, normalizeInPlace, makeRand,
};

const RESERVED = new Set(['kind', 'size', 'seed', 'tiling', 'tint', 'unique', 'wet', 'displacementScale', 'name']);

/* ------------------------------------------------------------ IBL presets */
/**
 * Procedural environment probes. Flat ambient is a critic fail, so every probe
 * has a real key direction, a cool opposing fill, a warm ground bounce and a
 * value range that goes properly HDR (>1) in the key lobe.
 */
const ENV_PRESETS = {
  crypt: {
    zenith: [0.016, 0.019, 0.027], horizon: [0.052, 0.043, 0.036],
    ground: [0.013, 0.011, 0.009], cloud: 0.25, gain: 1.0,
    lights: [
      { dir: [0.45, 0.30, -0.84], col: [4.2, 1.85, 0.55], k: 6 },
      { dir: [-0.62, 0.22, 0.75], col: [0.30, 0.40, 0.62], k: 3 },
      { dir: [0.1, -0.9, 0.2], col: [0.22, 0.13, 0.07], k: 2 },
    ],
  },
  town: {
    zenith: [0.055, 0.072, 0.115], horizon: [0.36, 0.24, 0.155],
    ground: [0.035, 0.030, 0.026], cloud: 0.45, gain: 1.0,
    lights: [
      { dir: [-0.55, 0.18, -0.82], col: [7.5, 3.6, 1.35], k: 8 },
      { dir: [0.62, 0.55, 0.55], col: [0.55, 0.72, 1.05], k: 2.5 },
    ],
  },
  moor: {
    zenith: [0.105, 0.118, 0.145], horizon: [0.20, 0.205, 0.215],
    ground: [0.030, 0.031, 0.028], cloud: 0.7, gain: 1.0,
    lights: [
      { dir: [0.3, 0.62, -0.72], col: [1.55, 1.6, 1.72], k: 3 },
      { dir: [-0.5, 0.25, 0.83], col: [0.28, 0.31, 0.4], k: 2 },
    ],
  },
  night: {
    zenith: [0.014, 0.019, 0.034], horizon: [0.030, 0.036, 0.055],
    ground: [0.008, 0.009, 0.012], cloud: 0.5, gain: 1.0,
    lights: [
      { dir: [-0.35, 0.72, 0.6], col: [1.15, 1.35, 2.1], k: 14 },
      { dir: [0.7, 0.12, -0.7], col: [0.16, 0.15, 0.22], k: 2 },
    ],
  },
  hell: {
    zenith: [0.045, 0.020, 0.016], horizon: [0.30, 0.095, 0.035],
    ground: [0.09, 0.028, 0.010], cloud: 0.55, gain: 1.0,
    lights: [
      { dir: [0.2, -0.55, -0.81], col: [5.5, 1.35, 0.28], k: 3 },
      { dir: [-0.6, 0.42, 0.68], col: [0.42, 0.20, 0.14], k: 2 },
    ],
  },
  studio: {
    zenith: [0.30, 0.32, 0.36], horizon: [0.22, 0.22, 0.24],
    ground: [0.06, 0.06, 0.065], cloud: 0.2, gain: 1.0,
    lights: [
      { dir: [0.4, 0.7, 0.55], col: [3.0, 3.0, 3.1], k: 5 },
      { dir: [-0.7, 0.2, -0.6], col: [0.6, 0.65, 0.8], k: 3 },
    ],
  },
};

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

export class AssetForge {
  static id = 'assets';
  /** Built-in surface kinds, for integrators that want to enumerate them. */
  static kinds = KIND_LIST;
  /** Kinds whose coverage rides in the albedo alpha channel. */
  static alphaKinds = [...ALPHA_KINDS];

  /** @param {import('./Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    // Claimed immediately: the manifest loads this module first, and every
    // other module's init() expects engine.assets to already resolve.
    engine.assets = this;

    this.generators = new Map(Object.entries(KINDS));
    this.aliases = { ...KIND_ALIASES };
    this.materialConfig = { ...KIND_MATERIAL };

    this._cache = new Map();      // full option key   -> public map set
    this._base = new Map();       // kind|size|seed|tint -> base textures
    this._materials = new Map();
    this._misc = new Map();       // noise / blue-noise textures
    this._textures = new Set();   // everything we own, for dispose()
    this._warned = new Set();
    this._genMs = new Map();

    this.maxAniso = 1;
    try { this.maxAniso = engine.renderer?.capabilities?.getMaxAnisotropy?.() ?? engine.maxAniso ?? 1; }
    catch { this.maxAniso = 1; }
    if (engine.maxAniso) this.maxAniso = engine.maxAniso;

    const tier = engine.quality?.tier ?? 'ultra';
    this.defaultSize = tier === 'low' ? 512 : 1024;
    this.maxSize = tier === 'low' ? 512 : tier === 'med' ? 1024 : 2048;
    // Soft VRAM ceiling for generated maps. The frame budget allows 320 MB of
    // GPU textures in total and render targets need a large slice of that, so
    // once the forge passes its own share it starts halving new requests
    // instead of quietly blowing the budget. Deterministic: module init order
    // is fixed, so the same scenario always degrades the same textures.
    this.budgetBytes = (tier === 'low' ? 64 : tier === 'med' ? 120 : 180) * 1048576;
    this._budgetWarned = false;

    this._canvasOK = this._probeCanvas();
    this._pmrem = null;
    this._envRT = null;
    this._envPreset = null;
    this._ownsSceneEnv = false;
    this._fallback = null;
    this.__dead = false;
  }

  /* --------------------------------------------------------- lifecycle */

  async init() {
    try {
      const t0 = nowMs();
      const preset = this._presetForScenario(this.engine.scenario);
      this.envMap({ preset });
      const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
      if (params.has('selftest')) console.info('[assets] selftest', this.__selftest());
      console.info(
        `[assets] forge ready — ${this.generators.size} kinds, ${this.defaultSize}px default, ` +
        `${this._canvasOK ? 'OffscreenCanvas' : 'DataTexture'} path, env "${this._envPreset}" in ` +
        `${(nowMs() - t0).toFixed(0)}ms`);
    } catch (e) {
      // Never let the forge take the frame down: textures still generate even
      // if the IBL probe failed.
      console.error('[assets] init degraded —', e);
    }
  }

  /** Rebuild the IBL probe for the scenario's biome. */
  applyScenario(name, cfg) {
    try {
      const preset = this._presetForScenario(cfg ?? this.engine.scenario);
      if (preset !== this._envPreset) this.envMap({ preset });
    } catch (e) {
      console.error('[assets] scenario env failed —', e);
    }
  }

  dispose() {
    for (const t of this._textures) { try { t.dispose(); } catch { } }
    this._textures.clear();
    for (const m of this._materials.values()) { try { m.dispose(); } catch { } }
    this._materials.clear();
    this._cache.clear();
    this._base.clear();
    this._misc.clear();
    try {
      if (this._ownsSceneEnv && this.engine.scene) this.engine.scene.environment = null;
      this._envRT?.dispose();
      this._pmrem?.dispose();
    } catch { }
    this._envRT = null;
    this._pmrem = null;
    // engine.assets is deliberately left pointing here: the forge disposes
    // first (it is first in the manifest) and later modules' dispose() paths
    // may still dereference it.
  }

  /* ------------------------------------------------------------- public */

  /**
   * Generate (or fetch from cache) a complete map set.
   * @returns {{map:THREE.Texture, normalMap:THREE.Texture, roughnessMap:THREE.Texture,
   *            metalnessMap:THREE.Texture, aoMap:THREE.Texture, displacementMap:THREE.Texture,
   *            emissiveMap:THREE.Texture|null, ormMap:THREE.Texture, kind:string, size:number}}
   */
  pbr(opts = {}) {
    const o = this._normalize(opts);
    const key = JSON.stringify(o);
    const hit = this._cache.get(key);
    if (hit) return hit;

    let base;
    try {
      base = this._baseSet(o);
    } catch (e) {
      console.error(`[assets] generation failed for kind "${o.kind}" —`, e);
      base = this._fallbackBase();
    }
    const set = this._withTiling(base, o.tiling, o);
    this._cache.set(key, set);
    return set;
  }

  /**
   * Configured material for a kind. Promoted to MeshPhysicalMaterial where a
   * second specular lobe genuinely matters (wet stone, blood, silk, skin).
   * Materials are shared by default — pass `unique:true` for a private copy.
   */
  material(opts = {}) {
    const kind = this._resolve(opts.kind);
    const gen = {
      kind,
      size: opts.size,
      seed: opts.seed,
      tiling: opts.tiling,
      tint: opts.tint,
    };
    const over = {};
    for (const k in opts) if (!RESERVED.has(k)) over[k] = opts[k];

    const key = JSON.stringify([this._normalize(gen), over, !!opts.wet, opts.displacementScale ?? 0]);
    if (!opts.unique) {
      const hit = this._materials.get(key);
      if (hit) return hit;
    }

    let mat;
    try {
      mat = this._buildMaterial(kind, gen, over, opts);
    } catch (e) {
      console.error(`[assets] material failed for "${kind}" —`, e);
      mat = new THREE.MeshStandardMaterial({ color: 0x6b6b6b, roughness: 0.85, metalness: 0 });
    }
    mat.userData.kind = kind;
    if (!opts.unique) this._materials.set(key, mat);
    return mat;
  }

  /**
   * Add a generator. `fn(ctx, toolkit)` fills ctx.h / ctx.cr,cg,cb / ctx.rg /
   * ctx.mt / ctx.gm and may tune ctx.params; the shared wear + AO + normal
   * pass then runs over it exactly as it does for the built-in kinds.
   */
  register(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      console.warn('[assets] register(name, fn) — bad arguments');
      return false;
    }
    this.generators.set(name, fn);
    // Drop anything cached under the old definition.
    for (const k of [...this._cache.keys()]) if (k.includes(`"${name}"`)) this._cache.delete(k);
    for (const k of [...this._base.keys()]) if (k.startsWith(`${name}|`)) this._base.delete(k);
    return true;
  }

  /** Per-kind material defaults, for modules that register their own kinds. */
  registerMaterial(name, cfg) {
    this.materialConfig[name] = { ...(this.materialConfig[name] ?? {}), ...cfg };
  }

  /**
   * PMREM-filtered procedural environment. Assigned to scene.environment so
   * IBL always has directionality; a later Lighting module may override it,
   * and we do not fight for ownership if it does.
   */
  envMap(opts = {}) {
    const preset = ENV_PRESETS[opts.preset] ? opts.preset : 'crypt';
    const size = opts.size ?? 256;
    const seed = opts.seed ?? 1337;
    if (this._envRT && this._envPreset === preset) return this._envRT.texture;

    const eq = this._equirect(preset, size, seed);
    try {
      if (!this._pmrem) {
        this._pmrem = new THREE.PMREMGenerator(this.engine.renderer);
        this._pmrem.compileEquirectangularShader();
      }
      const rt = this._pmrem.fromEquirectangular(eq);
      const prev = this._envRT;
      this._envRT = rt;
      this._envPreset = preset;
      eq.dispose();
      const scene = this.engine.scene;
      if (scene && (scene.environment == null || this._ownsSceneEnv || scene.environment === prev?.texture)) {
        scene.environment = rt.texture;
        this._ownsSceneEnv = true;
      }
      prev?.dispose();
      return rt.texture;
    } catch (e) {
      console.error('[assets] PMREM failed, using raw equirect —', e);
      eq.mapping = THREE.EquirectangularReflectionMapping;
      this._textures.add(eq);
      this._envPreset = preset;
      return eq;
    }
  }

  /** Generic 4-channel noise: R fbm, G high-frequency fbm, B cellular edge, A white. */
  noiseTexture(size = 256, seed = 1) {
    const key = `noise|${size}|${seed}`;
    const hit = this._misc.get(key);
    if (hit) return hit;
    const n = size * size;
    const data = new Uint8ClampedArray(n * 4);
    const inv = 1 / size;
    for (let y = 0, i = 0; y < size; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < size; x++, i++) {
        const u = (x + 0.5) * inv;
        const o = i * 4;
        data[o] = TG.fbmT(u * 8, v * 8, 8, 8, 5, 0.5, seed) * 255;
        data[o + 1] = TG.fbmT(u * 24, v * 24, 24, 24, 4, 0.55, seed + 77) * 255;
        TG.worleyT(u * 12, v * 12, 12, 12, seed + 131);
        data[o + 2] = TG.clamp01(TG.WK.edge * 2.2) * 255;
        data[o + 3] = hash2(x, y, seed + 991) * 255;
      }
    }
    const tex = this._tex(data, size, size, { srgb: false, hasAlpha: true });
    this._misc.set(key, tex);
    return tex;
  }

  /**
   * True blue noise via void-and-cluster (Ulichney). Costly enough to be worth
   * caching, cheap enough at 64² to build on demand. R/G/B carry three
   * decorrelated toroidal phases so a shader can grab a 2D or 3D offset.
   */
  blueNoise(size = 64) {
    const s = Math.max(8, Math.min(256, 1 << Math.round(Math.log2(size))));
    const key = `blue|${s}`;
    const hit = this._misc.get(key);
    if (hit) return hit;

    const rank = voidAndCluster(s, 0x5eed);
    const n = s * s;
    const data = new Uint8ClampedArray(n * 4);
    const shift = (dx, dy, i) => {
      const x = (i % s + dx) % s, y = (((i / s) | 0) + dy) % s;
      return rank[y * s + x];
    };
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      data[o] = (rank[i] / n) * 255;
      data[o + 1] = (shift((s >> 1) + 7, 13, i) / n) * 255;
      data[o + 2] = (shift(11, (s >> 1) + 5, i) / n) * 255;
      data[o + 3] = 255;
    }
    const tex = this._tex(data, s, s, { srgb: false, hasAlpha: true });
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = 1;
    tex.needsUpdate = true;
    this._misc.set(key, tex);
    return tex;
  }

  /** Approximate VRAM held by generated textures, mip chain included. */
  memoryBytes() {
    let bytes = 0;
    for (const t of this._textures) bytes += t.userData?.bytes ?? 0;
    return bytes;
  }

  stats() {
    return {
      kinds: [...this.generators.keys()],
      sets: this._cache.size,
      textures: this._textures.size,
      materials: this._materials.size,
      bytes: this.memoryBytes(),
      mb: +(this.memoryBytes() / 1048576).toFixed(2),
      path: this._canvasOK ? 'offscreen-canvas' : 'data-texture',
      env: this._envPreset,
      genMs: Object.fromEntries(this._genMs),
    };
  }

  /**
   * Verify every kind synthesises. Generates at a reduced size into throwaway
   * textures so it can be run by the integrator without polluting the cache.
   */
  __selftest(size = 256) {
    const t0 = nowMs();
    const detail = [];
    const failed = [];
    let bytes = 0;
    for (const kind of this.generators.keys()) {
      const k0 = nowMs();
      try {
        const base = this._buildBase({ kind, size, seed: 7, tint: null });
        let b = 0;
        for (const t of base.all) { b += t.userData?.bytes ?? 0; t.dispose(); this._textures.delete(t); }
        bytes += b;
        detail.push({ kind, ms: +(nowMs() - k0).toFixed(1), bytes: b, ok: true });
      } catch (e) {
        failed.push(kind);
        detail.push({ kind, ms: +(nowMs() - k0).toFixed(1), bytes: 0, ok: false, error: String(e && e.message || e) });
      }
    }
    return {
      kinds: detail.filter((d) => d.ok).map((d) => d.kind),
      failed,
      bytes,
      ms: +(nowMs() - t0).toFixed(1),
      size,
      detail,
    };
  }

  /* ------------------------------------------------------------ internal */

  _resolve(kind) {
    let k = typeof kind === 'string' && kind ? kind : 'stone';
    if (!this.generators.has(k) && this.aliases[k]) k = this.aliases[k];
    if (!this.generators.has(k)) {
      if (!this._warned.has(k)) {
        this._warned.add(k);
        console.warn(`[assets] unknown kind "${k}" — falling back to stone`);
      }
      k = 'stone';
    }
    return k;
  }

  _normalize(opts) {
    const kind = this._resolve(opts.kind);
    let size = opts.size ?? this.defaultSize;
    size = 1 << Math.round(Math.log2(Math.max(32, Math.min(this.maxSize, size))));
    const used = this.memoryBytes();
    if (used > this.budgetBytes) size = Math.max(256, size >> 2);
    else if (used > this.budgetBytes * 0.75) size = Math.max(256, size >> 1);
    if (size < (opts.size ?? this.defaultSize) && !this._budgetWarned) {
      this._budgetWarned = true;
      console.warn(`[assets] texture budget reached (${(used / 1048576) | 0}MB) — new maps degrade to ${size}px`);
    }
    const tint = opts.tint
      ? [+(+opts.tint[0]).toFixed(4), +(+opts.tint[1]).toFixed(4), +(+opts.tint[2]).toFixed(4)]
      : null;
    return {
      kind,
      size,
      seed: (opts.seed ?? 1) | 0,
      tiling: +(opts.tiling ?? 1) || 1,
      tint,
    };
  }

  _baseSet(o) {
    const bkey = `${o.kind}|${o.size}|${o.seed}|${o.tint ? o.tint.join(',') : '-'}`;
    let base = this._base.get(bkey);
    if (!base) {
      base = this._buildBase(o);
      this._base.set(bkey, base);
    }
    return base;
  }

  /** Run a generator, the shared wear pass, and upload every map. */
  _buildBase(o) {
    const t0 = nowMs();
    const gen = this.generators.get(o.kind);
    if (!gen) throw new Error(`no generator for ${o.kind}`);

    const ctx = new GenCtx(o.size, o.seed, o);
    gen(ctx, FORGE_TOOLKIT);
    if (!ctx.ao) finalize(ctx);

    if (o.tint) {
      const [tr, tg, tb] = o.tint;
      for (let i = 0; i < ctx.n; i++) { ctx.cr[i] *= tr; ctx.cg[i] *= tg; ctx.cb[i] *= tb; }
    }

    const albedo = packAlbedo(ctx);
    const orm = packORM(ctx);
    const nrm = new Uint8ClampedArray(ctx.n * 4);
    sobelNormal(ctx.hn ?? ctx.h, o.size, ctx.params.normalStrength, nrm);
    const hgt = packHeight(ctx);
    const emi = packEmissive(ctx);

    const hasAlpha = !!ctx.cov;
    const set = {
      map: this._tex(albedo, o.size, o.size, { srgb: true, hasAlpha }),
      normalMap: this._tex(nrm, o.size, o.size, { srgb: false }),
      ormMap: this._tex(orm, o.size, o.size, { srgb: false, hasAlpha: true }),
      displacementMap: this._tex(hgt.data, hgt.size, hgt.size, { srgb: false }),
      emissiveMap: emi ? this._tex(emi, o.size, o.size, { srgb: true }) : null,
      kind: o.kind,
      size: o.size,
      displacement: ctx.params.displacement,
      hasAlpha,
    };
    set.all = [set.map, set.normalMap, set.ormMap, set.displacementMap, ...(set.emissiveMap ? [set.emissiveMap] : [])];
    this._genMs.set(o.kind, +(nowMs() - t0).toFixed(1));
    return set;
  }

  /** Clone the base textures for a distinct repeat; three shares the upload. */
  _withTiling(base, tiling, o) {
    let map = base.map, normalMap = base.normalMap, ormMap = base.ormMap;
    let displacementMap = base.displacementMap, emissiveMap = base.emissiveMap;
    if (tiling !== 1) {
      map = this._clone(map, tiling);
      normalMap = this._clone(normalMap, tiling);
      ormMap = this._clone(ormMap, tiling);
      displacementMap = this._clone(displacementMap, tiling);
      emissiveMap = emissiveMap ? this._clone(emissiveMap, tiling) : null;
    }
    return {
      map, normalMap,
      roughnessMap: ormMap,
      metalnessMap: ormMap,
      aoMap: ormMap,
      ormMap,
      displacementMap,
      emissiveMap,
      kind: base.kind,
      size: base.size,
      tiling,
      displacement: base.displacement,
      hasAlpha: base.hasAlpha,
      seed: o?.seed ?? 0,
    };
  }

  _clone(tex, tiling) {
    const t = tex.clone();
    t.repeat.set(tiling, tiling);
    t.needsUpdate = true;
    // Clones share Texture.source, so this costs no additional GPU memory.
    t.userData = { ...tex.userData, bytes: 0, cloneOf: tex.uuid };
    this._textures.add(t);
    return t;
  }

  _tex(bytes, w, h, { srgb = false, hasAlpha = false } = {}) {
    let tex = null;
    // Canvas backing stores are premultiplied, which would quantise partially
    // transparent albedo — those go down the DataTexture path instead.
    if (this._canvasOK && !hasAlpha) {
      try {
        const cv = new OffscreenCanvas(w, h);
        // willReadFrequently keeps the backing store on the CPU: we write it
        // once and hand it straight to texImage2D, so an accelerated canvas
        // would only cost a second GPU allocation we never read from.
        const g2 = cv.getContext('2d', { willReadFrequently: true });
        g2.putImageData(new ImageData(bytes, w, h), 0, 0);
        tex = new THREE.CanvasTexture(cv);
      } catch { tex = null; }
    }
    if (!tex) {
      const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
      tex = new THREE.DataTexture(view, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    }
    tex.flipY = false;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = this.maxAniso;
    tex.premultiplyAlpha = false;
    tex.unpackAlignment = 4;
    tex.needsUpdate = true;
    tex.userData.bytes = Math.round(w * h * 4 * 1.34);
    this._textures.add(tex);
    return tex;
  }

  _fallbackBase() {
    if (this._fallback) return this._fallback;
    const s = 8, n = s * s;
    const a = new Uint8ClampedArray(n * 4), nm = new Uint8ClampedArray(n * 4),
      om = new Uint8ClampedArray(n * 4), hm = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      a[o] = 118; a[o + 1] = 114; a[o + 2] = 108; a[o + 3] = 255;
      nm[o] = 128; nm[o + 1] = 128; nm[o + 2] = 255; nm[o + 3] = 255;
      om[o] = 255; om[o + 1] = 214; om[o + 2] = 0; om[o + 3] = 128;
      hm[o] = 128; hm[o + 1] = 128; hm[o + 2] = 128; hm[o + 3] = 255;
    }
    const set = {
      map: this._tex(a, s, s, { srgb: true }),
      normalMap: this._tex(nm, s, s, {}),
      ormMap: this._tex(om, s, s, {}),
      displacementMap: this._tex(hm, s, s, {}),
      emissiveMap: null,
      kind: 'fallback', size: s, displacement: 0, hasAlpha: false,
    };
    set.all = [set.map, set.normalMap, set.ormMap, set.displacementMap];
    this._fallback = set;
    return set;
  }

  _buildMaterial(kind, gen, over, opts) {
    const maps = this.pbr(gen);
    const cfg = this.materialConfig[kind] ?? {};
    const wet = !!opts.wet;
    const physical = !!cfg.physical || wet
      || over.clearcoat != null || over.sheen != null || over.transmission != null
      || over.iridescence != null || over.specularIntensity != null;
    const Ctor = physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;

    const params = {
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      metalnessMap: maps.metalnessMap,
      aoMap: maps.aoMap,
      color: 0xffffff,
      roughness: 1,      // maps carry absolute values
      metalness: 1,
      envMapIntensity: cfg.envMapIntensity ?? 1,
      aoMapIntensity: cfg.aoMapIntensity ?? 1,
      dithering: true,
      ...(cfg.props ?? {}),
    };
    if (maps.emissiveMap) {
      params.emissiveMap = maps.emissiveMap;
      params.emissive = 0xffffff;
      params.emissiveIntensity = params.emissiveIntensity ?? 2.0;
    }
    if (maps.hasAlpha && params.transparent == null) {
      params.transparent = true;
      params.alphaTest = params.alphaTest ?? 0.05;
    }
    if (wet) {
      params.clearcoat = 1.0;
      params.clearcoatRoughness = 0.14;
    }

    const mat = new Ctor(params);
    const ns = over.normalScale ?? cfg.normalScale ?? 1;
    if (typeof ns === 'number') mat.normalScale.set(ns, ns);
    else if (ns && ns.isVector2) mat.normalScale.copy(ns);

    const dScale = opts.displacementScale ?? 0;
    if (dScale) {
      mat.displacementMap = maps.displacementMap;
      mat.displacementScale = dScale;
      mat.displacementBias = -dScale * 0.5;
    }

    for (const k in over) {
      if (k === 'normalScale') continue;
      const v = over[k];
      const cur = mat[k];
      if (cur && cur.isColor) cur.set(v);
      else if (cur && cur.isVector2 && typeof v === 'number') cur.set(v, v);
      else mat[k] = v;
    }
    return mat;
  }

  _presetForScenario(cfg) {
    const env = cfg?.env ?? cfg ?? null;
    const biome = env?.biome;
    const tod = env?.timeOfDay ?? 0.5;
    if (biome === 'hell') return 'hell';
    if (biome === 'crypt') return 'crypt';
    if (biome === 'town') return tod < 0.15 || tod > 0.92 ? 'night' : 'town';
    if (biome === 'moor') return tod < 0.15 || tod > 0.92 ? 'night' : 'moor';
    return 'crypt';
  }

  /** Procedural HDR equirectangular probe (half-float RGBA). */
  _equirect(presetName, size, seed) {
    const P = ENV_PRESETS[presetName] ?? ENV_PRESETS.crypt;
    const W = size, H = size >> 1;
    const data = new Uint16Array(W * H * 4);
    const half = THREE.DataUtils.toHalfFloat;
    const invW = 1 / W, invH = 1 / H;

    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) * invH;
      const elev = (v - 0.5) * Math.PI;
      const dy = Math.sin(elev);
      const rad = Math.cos(elev);
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) * invW;
        const az = (u - 0.5) * 6.283185307179586;
        const dx = rad * Math.cos(az);
        const dz = rad * Math.sin(az);

        // seamless cloud/wall breakup so the probe is never a flat gradient
        const cl = TG.fbmT(u * 6, v * 6, 6, 6, 4, 0.55, seed) - 0.5;
        const band = TG.smoothstep(-0.06, 0.5, dy);
        let r, g, b;
        if (dy >= 0) {
          const t = TG.smoothstep(0, 0.75, dy);
          r = TG.lerp(P.horizon[0], P.zenith[0], t);
          g = TG.lerp(P.horizon[1], P.zenith[1], t);
          b = TG.lerp(P.horizon[2], P.zenith[2], t);
        } else {
          const t = TG.smoothstep(0, -0.45, dy);
          r = TG.lerp(P.horizon[0] * 0.55, P.ground[0], t);
          g = TG.lerp(P.horizon[1] * 0.55, P.ground[1], t);
          b = TG.lerp(P.horizon[2] * 0.55, P.ground[2], t);
        }
        const mod = 1 + cl * P.cloud * (0.35 + 0.65 * band);
        r *= mod; g *= mod; b *= mod;

        for (let li = 0; li < P.lights.length; li++) {
          const L = P.lights[li];
          const d = dx * L.dir[0] + dy * L.dir[1] + dz * L.dir[2];
          if (d <= 0) continue;
          const w = Math.pow(d, L.k) * (1 + cl * 0.25);
          r += L.col[0] * w; g += L.col[1] * w; b += L.col[2] * w;
        }

        const o = (y * W + x) * 4;
        data[o] = half(r * P.gain);
        data[o + 1] = half(g * P.gain);
        data[o + 2] = half(b * P.gain);
        data[o + 3] = half(1);
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  }

  _probeCanvas() {
    try {
      if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') return false;
      const cv = new OffscreenCanvas(4, 4);
      const g2 = cv.getContext('2d', { willReadFrequently: true });
      if (!g2) return false;
      const src = new Uint8ClampedArray(64);
      for (let i = 0; i < 16; i++) {
        src[i * 4] = i * 17; src[i * 4 + 1] = 255 - i * 9; src[i * 4 + 2] = i * 3; src[i * 4 + 3] = 255;
      }
      g2.putImageData(new ImageData(src, 4, 4), 0, 0);
      const back = g2.getImageData(0, 0, 4, 4).data;
      for (let i = 0; i < 64; i++) if (Math.abs(back[i] - src[i]) > 1) return false;
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------ void-and-cluster */
/**
 * Ulichney's void-and-cluster. A gaussian energy field tracks how clustered the
 * placed samples are; ranks are assigned by repeatedly filling the largest void.
 * The kernel is truncated at 3σ and splatted incrementally, which is what makes
 * this practical on the main thread.
 */
function voidAndCluster(size, seed) {
  const n = size * size;
  const rnd = makeRand(seed);
  const sigma = 1.9;
  const R = Math.max(1, Math.min((size >> 1) - 1, 6));
  const KW = 2 * R + 1;
  const K = new Float32Array(KW * KW);
  for (let dy = -R, k = 0; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++, k++) K[k] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  }

  const energy = new Float32Array(n);
  const bin = new Uint8Array(n);

  const splat = (idx, s) => {
    const x0 = idx % size, y0 = (idx / size) | 0;
    for (let dy = -R, k = 0; dy <= R; dy++) {
      const y = (y0 + dy + size) % size;
      const row = y * size;
      for (let dx = -R; dx <= R; dx++, k++) {
        energy[row + ((x0 + dx + size) % size)] += K[k] * s;
      }
    }
  };
  const tightest = () => {
    let bi = -1, be = -Infinity;
    for (let i = 0; i < n; i++) if (bin[i] === 1 && energy[i] > be) { be = energy[i]; bi = i; }
    return bi;
  };
  const largestVoid = () => {
    let bi = -1, be = Infinity;
    for (let i = 0; i < n; i++) if (bin[i] === 0 && energy[i] < be) { be = energy[i]; bi = i; }
    return bi;
  };

  // 1. seed a sparse random pattern, then relax it into a blue-noise prototype
  const m0 = Math.max(1, Math.round(n * 0.1));
  let ones = 0;
  while (ones < m0) {
    const i = Math.min(n - 1, Math.floor(rnd() * n));
    if (!bin[i]) { bin[i] = 1; splat(i, 1); ones++; }
  }
  for (let it = 0; it < 512; it++) {
    const a = tightest();
    if (a < 0) break;
    bin[a] = 0; splat(a, -1);
    const b = largestVoid();
    if (b < 0 || b === a) { bin[a] = 1; splat(a, 1); break; }
    bin[b] = 1; splat(b, 1);
  }

  const proto = bin.slice();
  const rank = new Int32Array(n).fill(-1);

  const reset = (src) => {
    energy.fill(0);
    bin.set(src);
    for (let i = 0; i < n; i++) if (bin[i]) splat(i, 1);
  };

  // 2. rank the prototype downwards by removing the tightest cluster
  reset(proto);
  for (let r = ones - 1; r >= 0; r--) {
    const i = tightest();
    if (i < 0) break;
    bin[i] = 0; splat(i, -1);
    rank[i] = r;
  }
  // 3. rank upwards by filling the largest void (phase 3 collapses into this,
  //    since kernel(ones) + kernel(zeros) is constant on the torus)
  reset(proto);
  for (let r = ones; r < n; r++) {
    const i = largestVoid();
    if (i < 0) break;
    bin[i] = 1; splat(i, 1);
    rank[i] = r;
  }
  for (let i = 0; i < n; i++) if (rank[i] < 0) rank[i] = 0;
  return rank;
}
