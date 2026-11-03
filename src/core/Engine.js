import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';
import { Profiler } from './Profiler.js';
import { makeRand } from './Rand.js';

const FIXED_DT = 1 / 60;
/** How early a tick may fire, in seconds — see the pacing note in `_loop`. */
const TICK_SLACK = 0.002;

/**
 * Core engine: renderer ownership, module registry, fixed-timestep loop,
 * deterministic stepping for the screenshot harness.
 *
 * Modules never touch the renderer's global settings; they add to the scene,
 * update on a fixed dt, and talk to each other only through `engine.bus`.
 */
export class Engine {
  constructor(container) {
    this.container = container;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // TAA/FXAA in the post chain handles this
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // screenshot harness reads the canvas
      logarithmicDepthBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in r185; the lighting module drives soft
    // penumbra itself via CSM + a PCSS-style kernel.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.25, 900);
    this.camera.position.set(0, 22, 22);
    this.camera.lookAt(0, 0, 0);

    this.bus = new EventBus();
    this.input = new Input(this, canvas);
    this.profiler = new Profiler(this);
    this.clock = { dt: FIXED_DT, elapsed: 0, frame: 0, alpha: 0 };

    this.quality = this._detectQuality();
    this.headless = new URLSearchParams(location.search).has('headless');

    /* Dynamic resolution. The live loop scales the render pixel ratio down
       when frames run long and back up when there is headroom; see
       `_governResolution`. Off for the capture harness (`?shot=`, headless),
       whose frames must not depend on how fast the machine is. */
    this.renderScale = 1;
    this._resIdx = 0;
    this._resWin = { ms: 0, n: 0, changedAt: 0 };
    this._resGovern = !this.headless && !new URLSearchParams(location.search).has('shot');
    this.paused = false;

    this._modules = new Map();
    this._ordered = [];
    this._acc = 0;
    this._last = 0;
    this._rand = new Map();

    this.renderPipeline = null; // set by the RenderPipeline module

    this._onResize = this._onResize.bind(this);
    addEventListener('resize', this._onResize);
    this._onResize();
  }

  _detectQuality() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const q = new URLSearchParams(location.search).get('q');
    const tier = q ?? 'ultra';
    const TIERS = {
      low:   { tier: 'low',   shadowRes: 1024, cascades: 2, ssao: false, ssr: false, taa: false, volumetric: false, dpr: Math.min(dpr, 1) },
      med:   { tier: 'med',   shadowRes: 2048, cascades: 3, ssao: true,  ssr: false, taa: true,  volumetric: true,  dpr: Math.min(dpr, 1) },
      high:  { tier: 'high',  shadowRes: 2048, cascades: 4, ssao: true,  ssr: true,  taa: true,  volumetric: true,  dpr: Math.min(dpr, 1.5) },
      // ultra stops at 1.5x: a full 2x Retina buffer is 4x the pixels through
      // SSR, GTAO and volumetrics, measured at 16 fps where 1x ran 45-68.
      ultra: { tier: 'ultra', shadowRes: 4096, cascades: 4, ssao: true,  ssr: true,  taa: true,  volumetric: true,  dpr: Math.min(dpr, 1.5) },
    };
    /* Own-property check, NOT `TIERS[tier] ?? null`. `??` only catches
       null/undefined, so an inherited Object.prototype member survives it:
       `?q=toString` made `TIERS['toString']` the inherited FUNCTION, `?? null`
       did not fire, the `??` fallback did not fire either, and `this.quality`
       became a function instead of a config.
       SCOPE: only keys that are NOT own properties of the literal but ARE
       inherited break. The four real tiers are own properties, so `?q=low`
       always resolved to `low` correctly -- measured on main BEFORE the fix:
         ?q=low -> tier "low", shadowRes 1024
       The defect is reachable only through inherited names:
         ?q=toString     -> engineQualityType "function", engineQualityTier null
         ?q=valueOf      -> same
         ?q=__proto__    -> cfg is the prototype object, tier undefined
       An earlier version of this comment claimed the defect also defeated the
       `?q=low` low-end mitigation and pushed VRAM 64 MB -> 180 MB. That was
       wrong: it came from reading the `??` semantics, not from measuring, and
       `?q=low` was never affected. Corrected here.
       `Object.hasOwn` is the check that means what it says. */
    const cfg = Object.hasOwn(TIERS, tier) ? TIERS[tier] : null;
    return cfg ?? { tier: 'ultra', shadowRes: 4096, cascades: 4, ssao: true, ssr: true, taa: true, volumetric: true, dpr: 1 };
  }

  /** Deterministic PRNG, memoized per key so repeat calls give the same stream. */
  rand(seed = 0) {
    const key = String(seed);
    let r = this._rand.get(key);
    if (!r) this._rand.set(key, (r = makeRand(typeof seed === 'number' ? seed : hashStr(key))));
    return r;
  }
  freshRand(seed = 0) {
    return makeRand(typeof seed === 'number' ? seed : hashStr(String(seed)));
  }

  /**
   * Idempotent by id — a module that self-registers from another module's
   * constructor won't be duplicated when the manifest also reaches it.
   */
  add(ModuleClass) {
    const id = ModuleClass.id ?? ModuleClass.name;
    const existing = this._modules.get(id);
    if (existing) return existing;
    const m = new ModuleClass(this);
    // The constructor may have registered `id` re-entrantly; re-check.
    if (this._modules.has(id)) return this._modules.get(id);
    this._modules.set(id, m);
    this._ordered.push({ id, m });
    return m;
  }

  /** Register an already-constructed module instance (used by self-registering modules). */
  register(id, instance) {
    if (this._modules.has(id)) return this._modules.get(id);
    this._modules.set(id, instance);
    this._ordered.push({ id, m: instance });
    return instance;
  }

  get(id) { return this._modules.get(id); }

  async initAll(onProgress) {
    const n = this._ordered.length;
    for (let i = 0; i < n; i++) {
      const { id, m } = this._ordered[i];
      try {
        await m.init?.();
      } catch (e) {
        console.error(`[init:${id}] module disabled —`, e);
        m.__dead = true;
      }
      onProgress?.((i + 1) / n, id);
      // Yield so the loading screen can paint.
      if (!this.headless) await new Promise((r) => setTimeout(r, 0));
    }
    this._onResize();
  }

  _onResize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(this.quality.dpr * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const { id, m } of this._ordered) {
      if (m.__dead) continue;
      try { m.resize?.(w, h); } catch (e) { console.error(`[resize:${id}]`, e); }
    }
  }

  /** One fixed-timestep simulation tick (no render). */
  tick(dt = FIXED_DT) {
    this.clock.dt = dt;
    this.clock.elapsed += dt;
    this.clock.frame++;
    this.input.update();
    for (const { id, m } of this._ordered) {
      if (m.__dead || !m.update) continue;
      this.profiler.begin(id);
      try {
        m.update(dt, this.clock.elapsed);
      } catch (e) {
        console.error(`[update:${id}] module disabled —`, e);
        m.__dead = true;
      }
      this.profiler.end();
    }
    this.bus.flush();
    this.input.endFrame();
  }

  renderFrame() {
    this.renderer.info.reset();
    if (this.renderPipeline && !this.renderPipeline.__dead) {
      try {
        this.renderPipeline.render();
        return;
      } catch (e) {
        console.error('[renderPipeline] falling back to direct render —', e);
        this.renderPipeline.__dead = true;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  start() {
    this._last = performance.now();
    this.renderer.setAnimationLoop((t) => this._loop(t));
  }
  stop() { this.renderer.setAnimationLoop(null); }

  /** @param {number} [stamp] the frame's vsync timestamp from requestAnimationFrame */
  _loop(stamp) {
    /* The vsync stamp, not performance.now(): it lands on exact multiples of
       the display interval, where now() carries however late this callback
       ran. See the pacing note below. */
    const now = Number.isFinite(stamp) ? stamp : performance.now();
    let frameMs = Math.max(0, now - this._last);
    this._last = now;
    this.profiler.frame(frameMs);
    if (this._resGovern) this._governResolution(frameMs, now);
    if (this.paused) { this.renderFrame(); return; }

    /* Frame pacing. The sim ticks at a fixed 60 Hz but the browser calls us at
       the display's rate -- 120 Hz on a ProMotion Mac. Ticking on the raw
       accumulator against a jittery 8.3 ms frame gave 0, 1 or 2 ticks per
       frame in no fixed order, and since nothing is interpolated between
       ticks, the camera -- and the whole floor with it -- moved in stop-go
       jumps. Measured from a 60 fps screen recording, the floor scrolled
       0,6,0,3,3,6,0,12 px per frame where smooth motion is a steady 3-4.

       So time comes from the vsync stamp, and a tick is allowed TICK_SLACK
       early. Even exact stamps leave the accumulator sitting on the threshold
       at 120 Hz, where float error alone decides between 0, 1 and 2 ticks
       (simulated: tick gaps of 1/2/3 frames in a 152/296/151 split); with
       the slack every tick lands on every second frame (599 of 599), and the
       debt carries into the next tick so the sim clock does not drift. A frame that
       produced no tick is not drawn at all: it would be the same picture,
       and the canvas keeps the last one (`preserveDrawingBuffer`). Motion is
       an even 60 fps, and a 120 Hz display renders half as many frames. */
    // Clamp so a stall never produces a spiral of death.
    this._acc += Math.min(frameMs / 1000, 0.1);
    let steps = 0;
    while (this._acc >= FIXED_DT - TICK_SLACK && steps < 5) {
      this.tick(FIXED_DT);
      this._acc -= FIXED_DT;
      steps++;
    }
    this.clock.alpha = Math.max(0, this._acc) / FIXED_DT;
    if (steps > 0) this.renderFrame();
  }

  /**
   * Step the render scale over one-second windows of real frame time: down a
   * step below ~45 fps, back up above ~75 fps once the last change is 4 s old.
   * The hysteresis keeps it from flapping, and the window after a change is
   * discarded so the resize itself is not counted against the new scale.
   */
  _governResolution(ms, now) {
    if (ms > 250) return;                       // a stall or a background tab, not load
    const w = this._resWin;
    w.ms += ms; w.n++;
    if (w.ms < 1000) return;
    const avg = w.ms / w.n;
    w.ms = 0; w.n = 0;
    let idx = this._resIdx;
    if (avg > 1000 / 45 && idx < RES_STEPS.length - 1) idx++;
    else if (avg < 1000 / 75 && idx > 0 && now - w.changedAt > 4000) idx--;
    if (idx === this._resIdx) return;
    this._resIdx = idx;
    this.renderScale = RES_STEPS[idx];
    w.changedAt = now;
    this._onResize();
  }

  /**
   * Deterministic advance used by the screenshot harness. Also records real
   * wall-clock cost per frame so `stats()` reports meaningful perf during a
   * headless capture (the sim advances on a fixed dt regardless).
   */
  async step(frames = 1, dt = FIXED_DT) {
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      this.tick(dt);
      this.renderFrame();
      this.profiler.frame(performance.now() - t0);
    }
    await new Promise((r) => requestAnimationFrame(r));
  }

  dispose() {
    removeEventListener('resize', this._onResize);
    this.stop();
    for (const { m } of this._ordered) { try { m.dispose?.(); } catch {} }
    this.renderer.dispose();
  }
}

/** Render-scale ladder for `_governResolution`, as fractions of the tier's pixel ratio. */
const RES_STEPS = [1, 0.85, 0.72, 0.6];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
