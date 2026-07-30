/**
 * THE NINTH VIGIL — AudioEngine
 * ===========================================================================
 * Everything you hear is computed. There is not one audio file in this project:
 * impacts, throats, footsteps, weather and the entire adaptive score are
 * synthesised with Web Audio primitives from a deterministic PRNG.
 *
 * Signal flow
 * -----------
 *                              ┌───────────────── reverb send ────────────────┐
 *   spatial voices ─┐          │                                             │
 *   flat voices   ──┼─> sfxBus ┤                                     convolver (procedural IR)
 *   ui voices     ──┘          │                                             │
 *   ambience beds ───> ambBus ─┤                                        wetReturn
 *   music stems   ───> musBus ─┤                                             │
 *                              └──> preMaster <───────────────────────────────┘
 *                                       │
 *                        dcBlock(22 Hz) → limiter → softClip → master → out
 *
 * The limiter is a hard-knee 20:1 compressor with a 2 ms attack followed by a
 * bounded tanh shaper, so however many voices land in one frame the output
 * cannot clip — which matters in an ARPG where thirty impacts can share a frame.
 *
 * Autoplay policy
 * ---------------
 * The context is created and immediately suspended. It resumes on the first real
 * user gesture. Until then every play() call is a no-op that costs one branch.
 * If Web Audio is missing, blocked, or throws at any point, the module disables
 * itself and the game keeps running — `boot` never depends on audio.
 *
 * Headless
 * --------
 * `engine.headless` (the screenshot harness) short-circuits `init()` before any
 * context, buffer, or listener exists. Cost in a capture: zero.
 *
 * Determinism
 * -----------
 * No Math.random, no Date.now. Variation comes from `engine.rand(...)` streams;
 * scheduling uses `ctx.currentTime` (the audio hardware clock), which is what
 * sample-accurate scheduling requires and is never read by the simulation.
 */

import { NoiseBank, softClipCurve } from './Noise.js';
import { VoicePool } from './VoicePool.js';
import { SFX, IMPACT_MAP, ELEMENT_MAP, VOC_MAP, CUE_ALIAS, PRIORITY, SFX_IDS } from './SFXKit.js';
import { Ambience } from './Ambience.js';
import { Music } from './Music.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Per-scenario room: which procedural IR, how wet, and how the music sits. */
const ROOM_BY_BIOME = {
  crypt: { ir: 'crypt', wet: 0.85, air: 14000 },
  hell: { ir: 'hell', wet: 1.0, air: 9000 },
  town: { ir: 'town', wet: 0.42, air: 18000 },
  moor: { ir: 'exterior', wet: 0.34, air: 16000 },
};

/** Minimum seconds between two instances of the same recipe (machine-gun guard). */
const RATE = {
  'swing': 0.055, 'swing.air': 0.05, 'step.stone': 0.06, 'step.dirt': 0.06,
  'step.grass': 0.06, 'step.water': 0.06, 'step.metal': 0.06,
  'hit.flesh': 0.022, 'hit.metal': 0.022, 'hit.stone': 0.03, 'hit.wood': 0.03,
  'hit.bone': 0.03, 'hit.ceramic': 0.05, 'hit.water': 0.05, 'hit.block': 0.04,
  'hit.crit': 0.06, 'thud': 0.05, 'ui.hover': 0.035, 'ui.click': 0.03,
  'drip': 0.25, 'debris': 0.2, 'telegraph': 0.25,
  'voc.skeleton': 0.5, 'voc.ghoul': 0.5, 'voc.cultist': 0.6, 'voc.hellhound': 0.45,
  'voc.brute': 0.9, 'voc.wraith': 0.8, 'voc.boss': 2.2, 'voc.hero': 0.35, 'shout': 0.5,
  'death.generic': 0.09, 'death.boss': 3, 'thunder': 1.2,
  'loot.common': 0.07, 'loot.gold': 0.1, 'loot.magic': 0.15, 'loot.rare': 0.3,
  'loot.legendary': 2.5, 'loot.unique': 2.5, 'loot.pickup': 0.06,
  'cast.fire': 0.12, 'cast.ice': 0.12, 'cast.lightning': 0.12, 'cast.arcane': 0.12,
  'cast.necrotic': 0.12, 'cast.holy': 0.2, 'cast.poison': 0.12, 'cast.physical': 0.09,
  'fire.whoosh': 0.15, 'ice.shatter': 0.1, 'lightning.crack': 0.1,
  'bow.release': 0.07, 'levelup': 2, 'potion': 0.3, 'door': 0.6, 'portcullis': 2,
};

/**
 * How many new voices a single frame may start. A pack wipe can fire thirty
 * impacts in one tick; past about a dozen simultaneous transients nothing is
 * more audible, it just eats headroom, so the surplus is dropped by priority.
 */
const VOICES_PER_FRAME = 9;

export class AudioEngine {
  static id = 'audio';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.enabled = false;        // true once a context exists
    this.running = false;        // true once the context is actually resumed
    this.failed = false;
    this.muted = false;
    this.silent = false;         // headless: never build anything

    this.ctx = null;
    this.bank = null;
    this.pool = null;
    this.music = null;
    this.ambience = null;

    this.volume = { master: 0.85, sfx: 1.0, music: 0.6, ambience: 0.75, ui: 0.9 };

    /* listener state — derived from the camera every frame */
    this.listener = { x: 0, y: 1.6, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
    this.listenerPull = 0.64;    // pull the ear from the camera toward its target

    /* world context */
    this.biome = 'crypt';
    this.interior = true;
    this.room = 'crypt';
    this.weather = { kind: 'none', intensity: 0 };

    /* adaptive-music drivers */
    this.threat = 0;
    this.bossActive = false;
    this.heroDead = false;
    this._killT = -99;
    this._victoryArmed = false;
    this._duck = 0;
    this._autoState = null;      // last state the intensity driver pushed
    this._override = null;       // explicit setMusicState()
    this._overrideUntil = 0;

    /* bookkeeping */
    this._last = new Map();      // recipe id -> last start time (ctx clock)
    this._vocAt = new Map();     // entity -> last vocalisation time
    this._frameVoices = 0;
    this._stepPhase = 0;
    this._stepPrev = 0;
    this._offs = [];             // bus unsubscribers
    this._gestureOff = [];
    this._stats = { played: 0, dropped: 0, rateLimited: 0, errors: 0 };
    this._idleVocAt = 0;
    this._sceneT = 0;
  }

  /* ==================================================================== *
   * lifecycle
   * ==================================================================== */

  async init() {
    if (this.engine.headless) { this.silent = true; return; }
    const AC = typeof globalThis.AudioContext === 'function' ? globalThis.AudioContext
      : typeof globalThis.webkitAudioContext === 'function' ? globalThis.webkitAudioContext : null;
    if (!AC) { this.failed = true; console.info('[audio] Web Audio unavailable — running silent'); return; }

    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      // Autoplay policy: start suspended on purpose, resume on a real gesture.
      if (this.ctx.state !== 'suspended') { try { await this.ctx.suspend(); } catch { /* fine */ } }
    } catch (e) {
      this.failed = true;
      console.info('[audio] could not create an AudioContext — running silent:', e?.message ?? e);
      return;
    }

    try {
      this._buildGraph();
      this._wireBus();
      this._wireGestures();
      this.enabled = true;
      console.info(`[audio] ready — ${this.ctx.sampleRate} Hz, suspended until first gesture`);
    } catch (e) {
      this.failed = true;
      console.error('[audio] graph build failed — running silent:', e);
      this._teardown();
    }
  }

  _buildGraph() {
    const ctx = this.ctx;
    const rndNoise = this.engine.rand('audio:noise');

    this.bank = new NoiseBank(ctx, rndNoise, 2.5);

    /* ---- master chain ---------------------------------------------- */
    this.master = ctx.createGain();
    this.master.gain.value = this.volume.master;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(2048, 1.45);
    this.shaper.oversample = '2x';

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -5.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.14;

    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 24;
    this.dcBlock.Q.value = 0.7;

    this.preMaster = ctx.createGain();
    this.preMaster.gain.value = 1;

    this.preMaster.connect(this.dcBlock);
    this.dcBlock.connect(this.limiter);
    this.limiter.connect(this.shaper);
    this.shaper.connect(this.master);
    this.master.connect(ctx.destination);

    /* ---- sub-buses -------------------------------------------------- */
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = this.volume.sfx;
    this.uiBus = ctx.createGain(); this.uiBus.gain.value = this.volume.ui;
    this.ambBus = ctx.createGain(); this.ambBus.gain.value = this.volume.ambience;
    this.musBus = ctx.createGain(); this.musBus.gain.value = this.volume.music;
    for (const b of [this.sfxBus, this.uiBus, this.ambBus, this.musBus]) b.connect(this.preMaster);

    /* ---- procedural convolution reverb ------------------------------ */
    this.revSend = ctx.createGain(); this.revSend.gain.value = 1;
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.wetReturn = ctx.createGain(); this.wetReturn.gain.value = 0.85;
    // Roll the top off the tail: stone eats highs, and it keeps the wet from
    // competing with the dry transients that carry combat readability.
    this.wetTilt = ctx.createBiquadFilter();
    this.wetTilt.type = 'lowpass';
    this.wetTilt.frequency.value = 5200;
    this.wetTilt.Q.value = 0.7;
    this.revSend.connect(this.convolver);
    this.convolver.connect(this.wetTilt);
    this.wetTilt.connect(this.wetReturn);
    this.wetReturn.connect(this.preMaster);
    this._setIR(this.room);

    /* ---- voices ----------------------------------------------------- */
    const lowTier = this.engine.quality?.tier === 'low';
    this.pool = new VoicePool(ctx, {
      dry: this.sfxBus, wet: this.revSend,
      hrtf: !lowTier,
      max: lowTier ? 16 : 30, maxFlat: 12,
      refDistance: 5.5, maxDistance: 120, rolloff: 1.2,
    });
    this.uiPool = new VoicePool(ctx, {
      dry: this.uiBus, wet: this.revSend, hrtf: false, max: 2, maxFlat: 10,
    });

    /* ---- ambience + music ------------------------------------------ */
    this.ambience = new Ambience({
      ctx, bank: this.bank, bus: this.ambBus, wet: this.revSend,
      rnd: this.engine.rand('audio:ambience'),
      play: (id, o) => this.play(id, o),
      engine: this.engine,
    });
    this.ambience.build();

    this.music = new Music({
      ctx, bank: this.bank, bus: this.musBus, wet: this.revSend,
      rnd: this.engine.rand('audio:music'), seed: 0x5A1C7C4D,
    });
    this.music.build();

    this._initListener();
  }

  _initListener() {
    const L = this.ctx.listener;
    try {
      if (L.forwardX) {
        L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
        L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
      } else if (L.setOrientation) {
        L.setOrientation(0, 0, -1, 0, 1, 0);
      }
    } catch { /* older implementations — harmless */ }
  }

  /** Swap the room impulse response. Ramps the wet out and back so it never clicks. */
  _setIR(name) {
    if (!this.convolver || !this.bank) return;
    try {
      const buf = this.bank.ir(name);
      const t = this.ctx.currentTime;
      const g = this.wetReturn.gain;
      const target = (ROOM_BY_BIOME[this.biome]?.wet ?? 0.7);
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.0001, t + 0.06);
      this.convolver.buffer = buf;
      g.setValueAtTime(0.0001, t + 0.07);
      g.linearRampToValueAtTime(target, t + 0.45);
      this.room = name;
    } catch (e) {
      console.warn('[audio] reverb IR failed —', e?.message ?? e);
    }
  }

  /* ---------------------------------------------------- autoplay policy */

  _wireGestures() {
    const resume = () => this.resume();
    const opts = { passive: true };
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'wheel']) {
      addEventListener(ev, resume, opts);
      this._gestureOff.push(() => removeEventListener(ev, resume, opts));
    }
    this._onVis = () => this._setMuted(document.visibilityState === 'hidden');
    this._onBlur = () => this._setMuted(true);
    this._onFocus = () => this._setMuted(false);
    document.addEventListener('visibilitychange', this._onVis);
    addEventListener('blur', this._onBlur);
    addEventListener('focus', this._onFocus);
  }

  /** Resume after a user gesture. Safe to call any number of times. */
  resume() {
    if (!this.enabled || this.failed || this.running) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const go = () => {
      if (this.running) return;
      this.running = true;
      for (const off of this._gestureOff) { try { off(); } catch { /* noop */ } }
      this._gestureOff.length = 0;
      try {
        this.ambience?.apply(this.biome, this.weather, 3.0);
        this.music?.start();
        this.music?.request(this._musicStateWanted());
      } catch (e) { console.warn('[audio] resume warm-up failed —', e?.message ?? e); }
      console.info('[audio] context resumed');
    };
    try {
      const p = ctx.resume?.();
      if (p && typeof p.then === 'function') p.then(go, (e) => console.info('[audio] resume rejected —', e?.message ?? e));
      else go();
    } catch (e) { console.info('[audio] resume threw —', e?.message ?? e); }
  }

  _setMuted(on) {
    if (!this.enabled || this.muted === on) return;
    this.muted = on;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(on ? 0.0001 : this.volume.master, t + (on ? 0.09 : 0.35));
    } catch { /* param busy */ }
    if (on) {
      // Suspend after the fade so a hidden tab costs nothing at all.
      this._suspendTimer = setTimeout(() => {
        if (this.muted && this.ctx?.state === 'running') { try { this.ctx.suspend(); } catch { /* noop */ } }
      }, 160);
    } else {
      if (this._suspendTimer) { clearTimeout(this._suspendTimer); this._suspendTimer = null; }
      if (this.running && this.ctx?.state === 'suspended') { try { this.ctx.resume(); } catch { /* noop */ } }
    }
  }

  /* ==================================================================== *
   * public API
   * ==================================================================== */

  setVolume(which, v) {
    if (!(which in this.volume)) return;
    this.volume[which] = clamp(v, 0, 1.5);
    if (!this.enabled) return;
    const node = { master: this.master, sfx: this.sfxBus, ui: this.uiBus, ambience: this.ambBus, music: this.musBus }[which];
    if (!node) return;
    const t = this.ctx.currentTime;
    try {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(this.volume[which], t + 0.2);
    } catch { /* busy */ }
  }

  /**
   * Force a score state. It holds for `hold` seconds against the automatic
   * combat-intensity driver, so a scripted boss intro or a cutscene is not
   * argued out of existence by the threat meter on the next frame.
   */
  setMusicState(state, hold = 24) {
    this._override = state;
    this._overrideUntil = this._sceneT + Math.max(0, hold);
    this.music?.request(state);
  }

  /**
   * Play a recipe.
   * @param {string} id key in SFXKit
   * @param {object} o { position:[x,y,z]|Vector3, gain, priority, ui, delay, ...recipeOpts }
   * @returns {import('./VoicePool.js').Voice|null}
   */
  play(id, o = {}) {
    if (!this.running || this.muted || this.failed) return null;
    const recipe = SFX[id];
    if (!recipe) return null;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    /* rate limit + per-frame budget */
    const min = RATE[id] ?? 0;
    if (min > 0) {
      const last = this._last.get(id) ?? -99;
      if (now - last < min) { this._stats.rateLimited++; return null; }
    }
    if (this._frameVoices >= VOICES_PER_FRAME && (o.priority ?? PRIORITY[id] ?? 0.5) < 0.75) {
      this._stats.dropped++; return null;
    }

    const priority = o.priority ?? PRIORITY[id] ?? 0.5;
    const spatial = !o.ui && !!o.position;
    const pool = o.ui ? this.uiPool : this.pool;
    // A generous provisional lifetime; the recipe's real end time replaces it.
    const v = pool.acquire(spatial, 1.2, priority, id);
    if (!v) { this._stats.dropped++; return null; }

    const t = now + Math.max(0, o.delay ?? 0) + 0.012;   // one buffer of scheduling slack
    const S = {
      ctx, bank: this.bank, rnd: this._rndFor(id), out: v.in, send: v.send,
      keep: (n) => v.keep(n), t, wet: 0.3,
    };

    let end = t + 0.4;
    try {
      end = recipe(S, o) || (t + 0.4);
    } catch (e) {
      this._stats.errors++;
      if (this._stats.errors < 6) console.warn(`[audio] recipe '${id}' threw —`, e?.message ?? e);
      v._reset();
      pool.active = Math.max(0, pool.active - 1);
      return null;
    }

    /* level, room send, placement, occlusion */
    const gain = clamp(o.gain ?? 1, 0, 4);
    if (gain !== 1) { try { v.in.gain.setValueAtTime(gain, now); } catch { /* busy */ } }
    const roomWet = ROOM_BY_BIOME[this.biome]?.wet ?? 0.7;
    const wet = clamp((o.wet ?? S.wet ?? 0.3) * roomWet, 0, 1.4);
    try { v.send.gain.setValueAtTime(wet, now); } catch { /* busy */ }

    if (spatial) {
      const p = o.position;
      const x = p.x ?? p[0] ?? 0, y = p.y ?? p[1] ?? 0, z = p.z ?? p[2] ?? 0;
      const occ = o.occlusion ?? this._occlusion(x, z);
      pool.place(v, x, y, z, occ, ROOM_BY_BIOME[this.biome]?.air ?? 18000);
    } else if (v.stereo && o.pan !== undefined) {
      try { v.stereo.pan.setValueAtTime(clamp(o.pan, -1, 1), now); } catch { /* busy */ }
    }

    pool.hold(v, end + 0.12);
    this._last.set(id, now);
    this._frameVoices++;
    this._stats.played++;
    return v;
  }

  /** Per-recipe deterministic stream, so one loud family cannot desync another. */
  _rndFor(id) {
    let r = this._rnds?.get(id);
    if (!r) {
      (this._rnds ??= new Map()).set(id, (r = this.engine.rand(`audio:${id}`)));
    }
    return r;
  }

  /**
   * Cheap occlusion: sample the dungeon walk grid along the listener→source
   * segment. Six integer lookups; only runs indoors, where walls exist.
   */
  _occlusion(x, z) {
    if (!this.interior) return 0;
    const d = this._dungeon;
    if (!d || d.__dead || typeof d.isBlocked !== 'function') return 0;
    const lx = this.listener.x, lz = this.listener.z;
    const dx = x - lx, dz = z - lz;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.5) return 0;
    let blocked = 0;
    const N = 6;
    try {
      for (let i = 1; i <= N; i++) {
        const k = i / (N + 1);
        if (d.isBlocked(lx + dx * k, lz + dz * k)) blocked++;
      }
    } catch { return 0; }
    return clamp01((blocked / N) * 0.92);
  }

  /* ==================================================================== *
   * scenario
   * ==================================================================== */

  applyScenario(name, cfg) {
    if (this.silent) return;
    const env = cfg?.env ?? {};
    this.biome = env.biome ?? 'crypt';
    this.interior = !!env.interior;
    const wk = String(env.weather ?? 'none');
    this.weather = { kind: wk, intensity: wk === 'none' || wk === 'clear' ? 0 : 0.65 };
    this.bossActive = name === 'boss';
    this.heroDead = false;
    this.threat = name === 'combat' ? 0.85 : name === 'boss' ? 1 : name === 'overworld' || name === 'night' ? 0.2 : 0;
    this._victoryArmed = false;
    this._sceneT = 0;
    this._autoState = null;
    this._override = null;
    this._overrideUntil = 0;
    this.ambience?.clearFires();

    if (!this.enabled) return;
    const room = ROOM_BY_BIOME[this.biome] ?? ROOM_BY_BIOME.crypt;
    this._setIR(room.ir);
    // UI-heavy scenarios pull the world back so the interface reads.
    const uiScene = name === 'inventory';
    this.ambience?.setIntensity(uiScene ? 0.35 : 1, 1.2);
    this.ambience?.apply(this.biome, this.weather, this.running ? 2.2 : 0.05);
    this.music?.setIntensity(uiScene ? 0.55 : name === 'closeup' ? 0.7 : 1);
    this.music?.request(this._musicStateWanted());
  }

  /* ==================================================================== *
   * bus wiring
   * ==================================================================== */

  _wireBus() {
    const bus = this.engine.bus;
    const on = (evt, fn) => this._offs.push(bus.on(evt, (p) => {
      if (!this.running) return;
      try { fn(p); } catch (e) {
        this._stats.errors++;
        if (this._stats.errors < 8) console.warn(`[audio:${evt}]`, e?.message ?? e);
      }
    }));

    on('impact', (p) => this._onImpact(p));
    on('damage', (p) => this._onDamage(p));
    on('death', (p) => this._onDeath(p));
    on('ability:cast', (p) => this._onCast(p));
    on('loot:drop', (p) => this._onLootDrop(p));
    on('loot:pickup', () => this.play('loot.pickup', { position: this._atHero(), gain: 0.9 }));
    on('level:up', () => { this.play('levelup', { ui: true, gain: 1 }); this.music?.request('victory'); });
    on('ui:toast', (p) => this.play('ui.toast', { ui: true, tier: p?.tier ?? 'info', gain: 0.9 }));
    on('ui:click', () => this.play('ui.click', { ui: true }));
    on('ui:hover', () => this.play('ui.hover', { ui: true }));
    on('camera:shake', (p) => this._onShake(p));
    on('weather:set', (p) => this._onWeather(p));
    on('weather:thunder', (p) => this._onThunder(p));
    on('audio:sfx', (p) => this._onCue(p));
    on('audio:cue', (p) => this._onCue(p));
    on('telegraph:begin', (p) => this._onTelegraph(p));
    on('ai:engage', () => { this.threat = Math.max(this.threat, 0.62); });
    on('ai:notice', (p) => this._onNotice(p));
    on('ai:flee', () => { this.threat = Math.max(0, this.threat - 0.1); });
    on('dungeon:fixture', (p) => this._onFixture(p));
    on('lighting:torch', (p) => this._onFixture(p));
    on('door:open', (p) => this.play(p?.kind === 'portcullis' ? 'portcullis' : 'door', {
      position: this._pos(p?.position) ?? this._atHero(), gain: 1,
    }));
    on('potion:drink', () => this.play('potion', { position: this._atHero(), gain: 1 }));
    on('scenario', () => { /* applyScenario already ran; nothing extra to do */ });
  }

  _pos(p) {
    if (!p) return null;
    if (Array.isArray(p)) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    if (typeof p.x === 'number') return [p.x, p.y ?? 0, p.z ?? 0];
    return null;
  }

  _atHero() {
    const h = this._hero;
    if (h?.position) return [h.position.x, h.position.y + 1.1, h.position.z];
    return [this.listener.x, this.listener.y, this.listener.z];
  }

  /* ----------------------------------------------------------- handlers */

  _onImpact(p) {
    if (!p) return;
    const kind = String(p.kind ?? 'weapon');
    const pos = this._pos(p.point ?? p.hitPoint ?? p.position) ?? this._atHero();
    const mag = clamp(p.magnitude ?? 0.6, 0.05, 2);

    if (kind === 'footfall' || kind === 'footstep' || kind === 'step') {
      const surf = this._surfaceAt(pos[0], pos[1], pos[2]);
      this.play(`step.${surf}`, { position: pos, magnitude: clamp(mag, 0.2, 1.5), gain: clamp(0.5 + mag * 0.6, 0.25, 1.6), priority: 0.28 });
      return;
    }
    if (kind === 'dust' || kind === 'scuff') {
      this.play('step.dirt', { position: pos, magnitude: mag * 0.8, gain: 0.55, priority: 0.24 });
      return;
    }
    const id = IMPACT_MAP[kind] ?? 'hit.stone';
    this.play(id, { position: pos, magnitude: mag, gain: clamp(0.55 + mag * 0.5, 0.3, 1.6), level: mag });
    if (kind === 'heavy_impact' || kind === 'aoe' || mag > 1.1) {
      this.play('thud', { position: pos, magnitude: clamp(mag * 0.7, 0.2, 1.6), gain: 0.7, delay: 0.01 });
    }
    if (kind !== 'ambient' && kind !== 'drip' && kind !== 'rain') this.threat = Math.min(1, this.threat + 0.06 * mag);
  }

  _onDamage(p) {
    if (!p) return;
    const pos = this._pos(p.hitPoint ?? p.point) ?? this._atHero();
    const amount = p.amount ?? 0;
    const hero = this._hero;
    const toHero = p.target === hero || p.__fromHero === true;
    const tier = String(p.tier ?? '');

    if (p.crit || tier === 'crit' || tier === 'brutal') {
      // A brutal hit is a crit with more weight behind it.
      const heft = tier === 'brutal' ? 1.25 : 1;
      this.play('hit.crit', { position: pos, magnitude: clamp((0.7 + amount / 90) * heft, 0.4, 1.5), gain: 1.1 * heft });
    } else if (p.blocked || p.dodged || tier === 'glance' || p.glancing) {
      // Deflected: bright, short, and it must read as "that did nothing".
      this.play('hit.block', { position: pos, magnitude: 0.7, gain: 0.85 });
    }

    // the receiving throat
    const target = p.target;
    if (toHero) {
      this._vocalise('hero', pos, { pain: clamp01(amount / 90), gain: 1 });
    } else if (target) {
      const arch = this._archetypeOf(target);
      if (arch && amount > 0) this._vocalise(arch, pos, { gain: 0.85 }, target);
    }
    // Elemental damage gets its own signature layer on top of the physical hit.
    const el = ELEMENT_MAP[String(p.type ?? 'physical')];
    if (el && el !== 'cast.physical') {
      this.play(el, { position: pos, level: clamp(0.4 + amount / 70, 0.4, 1.4), gain: 0.55, delay: 0.015 });
    }
    this.threat = Math.min(1, this.threat + (toHero ? 0.2 : 0.12));
  }

  _onDeath(p) {
    if (!p) return;
    const e = p.entity;
    const pos = this._pos(p.hitPoint) ?? (e?.position ? [e.position.x, e.position.y + 0.9, e.position.z] : this._atHero());
    const hero = this._hero;
    if (e && e === hero) {
      this.heroDead = true;
      this._vocalise('hero', pos, { pain: 1, gain: 1.2 });
      this.play('thud', { position: pos, magnitude: 1.1, gain: 1, delay: 0.5 });
      this.music?.request('dead');
      return;
    }
    const isBoss = !!(e?.def?.isBoss || e?.arch?.isBoss || e?.isBoss);
    const arch = this._archetypeOf(e) ?? 'ghoul';
    if (isBoss) {
      this.play('death.boss', { position: pos, gain: 1.2 });
      this.bossActive = false;
      this._killT = this._sceneT;
      this._victoryArmed = true;
      this.music?.request('victory');
      return;
    }
    const mass = clamp((e?.mass ?? 70) / 80, 0.4, 2.4);
    const shift = arch === 'brute' ? 0.62 : arch === 'wraith' ? 1.5 : arch === 'hellhound' ? 1.25 : 1;
    this.play('death.generic', { position: pos, archetype: arch, shift, mass, gain: 1 });
    this._killT = this._sceneT;
    this._victoryArmed = true;
  }

  _onCast(p) {
    if (!p) return;
    const id = String(p.id ?? '');
    const origin = this._pos(p.origin) ?? this._atHero();
    const level = clamp(p.level ?? 1, 0.4, 2);
    const el = p.element ?? p.school ?? p.type ?? null;

    if (/attack|slash|stab|cleave|sweep|smash|bite|heavy|strike|swing/.test(id)) {
      const heavy = /heavy|smash|cleave|quake|slam/.test(id) ? 0.9 : /attack3|sweep/.test(id) ? 0.5 : 0.15;
      this.play('swing', { position: origin, heavy, speed: 1 + (level - 1) * 0.12, gain: 1 });
      return;
    }
    if (/bolt|arrow|shot|sling/.test(id)) { this.play('bow.release', { position: origin, gain: 1 }); return; }
    if (/dash|charge|leap/.test(id)) { this.play('cast.physical', { position: origin, level, gain: 0.9 }); return; }
    if (/summon|disgorge|call/.test(id)) { this.play('cast.necrotic', { position: origin, level: level * 1.1, gain: 1 }); return; }
    if (/meteor|hellrain|brand|fire|immol/.test(id)) { this.play('cast.fire', { position: origin, level, gain: 1 }); return; }
    if (/quake|slam/.test(id)) { this.play('cast.physical', { position: origin, level: level * 1.4, gain: 1.1 }); return; }

    const recipe = (el && ELEMENT_MAP[String(el)]) || 'cast.arcane';
    this.play(recipe, { position: origin, level, gain: 1 });
    this.threat = Math.min(1, this.threat + 0.08);
  }

  _onLootDrop(p) {
    if (!p) return;
    const item = p.item ?? {};
    const pos = this._pos(p.position) ?? this._atHero();
    const tier = String(p.rarity ?? item.tier ?? item.rarity ?? 'common').toLowerCase();
    const kind = String(item.kind ?? '').toLowerCase();
    // Loot ships a numeric `rank` as well as a name; the rank is authoritative
    // because it is what drove the beam colour and the toast.
    const rank = Number.isFinite(p.rank) ? p.rank : -1;
    let id = 'loot.common';
    if (kind === 'gold' || kind === 'coin' || kind === 'coins') id = 'loot.gold';
    if (tier === 'magic' || tier === 'uncommon' || tier === 'blue') id = 'loot.magic';
    else if (tier === 'rare' || tier === 'yellow') id = 'loot.rare';
    else if (tier === 'legendary' || tier === 'orange') id = 'loot.legendary';
    else if (tier === 'unique' || tier === 'mythic' || tier === 'set' || tier === 'red') id = 'loot.unique';
    if (rank >= 5) id = 'loot.unique';
    else if (rank >= 3) id = 'loot.legendary';
    else if (rank === 2 && id === 'loot.common') id = 'loot.rare';
    // A legendary is a moment: it plays flat (front and centre) and ducks the mix.
    const flat = id === 'loot.legendary' || id === 'loot.unique';
    this.play(id, flat ? { ui: true, gain: 1.05 } : { position: pos, gain: 1 });
    if (flat) this._duck = Math.max(this._duck, 0.6);
  }

  _onShake(p) {
    const amp = clamp(p?.amp ?? 0, 0, 2);
    if (amp < 0.34) return;
    // Big shakes get a room-wide sub whump the individual hit cannot supply.
    this.play('thud', { ui: true, magnitude: clamp(amp * 0.9, 0.3, 1.8), gain: 0.55, priority: 0.62 });
    this._duck = Math.max(this._duck, clamp01(amp * 0.4));
  }

  /**
   * Generic cue channel. Other modules emit `audio:sfx`/`audio:cue` with their
   * own vocabulary alongside the canonical events, so a drop arrives twice: once
   * as `loot:drop` and once as a cue. That is handled for free — the canonical
   * handler runs first and the per-recipe rate limiter swallows the duplicate,
   * so nothing double-triggers and nothing needs to know about the other path.
   */
  _onCue(p) {
    if (!p) return;
    const raw = String(p.id ?? p.cue ?? '');
    if (!raw) return;
    if (raw === 'thunder') { this._onThunder(p); return; }
    let id = SFX[raw] ? raw : undefined;
    if (id === undefined) {
      if (!(raw in CUE_ALIAS)) return;
      id = CUE_ALIAS[raw];
    }
    if (!id) return;                      // deliberately covered by an ambience bed
    const pos = this._pos(p.position ?? p.point);
    this.play(id, {
      position: pos ?? undefined, ui: !pos, gain: clamp(p.gain ?? 1, 0, 2),
      tier: p.tier, magnitude: p.magnitude, level: p.level,
    });
  }

  _onWeather(p) {
    if (!p) return;
    this.weather = { kind: String(p.kind ?? 'none'), intensity: clamp01(p.intensity ?? 0.5) };
    this.ambience?.apply(this.biome, this.weather, 3.4);
  }

  _onThunder(p) {
    const near = clamp01(p?.gain ?? 0.6);
    // Position it out on the horizon in a deterministic direction.
    const r = this.engine.rand('audio:thunder');
    const a = r() * Math.PI * 2;
    const d = 40 + (1 - near) * 55;
    this.play('thunder', {
      position: [this.listener.x + Math.cos(a) * d, this.listener.y + 25, this.listener.z + Math.sin(a) * d],
      gain: 0.7 + near * 0.6, priority: 0.9, occlusion: 0,
    });
    this._duck = Math.max(this._duck, near * 0.5);
  }

  _onTelegraph(p) {
    const pos = this._pos(p?.position ?? p?.point ?? p?.centre) ?? null;
    if (!pos) return;
    this.play('telegraph', { position: pos, dur: clamp(p?.duration ?? p?.dur ?? 0.9, 0.25, 2.5), gain: 0.85 });
  }

  _onNotice(p) {
    const e = p?.entity;
    const arch = this._archetypeOf(e);
    if (!arch) return;
    const pos = e?.position ? [e.position.x, e.position.y + 1.2, e.position.z] : this._atHero();
    this._vocalise(arch, pos, { gain: 0.95 }, e);
    this.threat = Math.max(this.threat, 0.4);
  }

  _onFixture(p) {
    const pos = this._pos(p?.position) ?? null;
    if (!pos) return;
    const kind = String(p?.kind ?? p?.type ?? 'torch');
    if (/torch|brazier|campfire|candle|hellfire|lava|fire/.test(kind)) {
      this.ambience?.addFire(pos[0], pos[1], pos[2]);
    }
  }

  /* ---------------------------------------------------------- creatures */

  _archetypeOf(e) {
    if (!e) return null;
    if (e === this._hero) return 'hero';
    const keys = [e.def?.id, e.def?.ai, e.arch?.id, e.archetype, e.species, e.kind, e.type];
    for (const k of keys) {
      if (typeof k === 'string' && VOC_MAP[k]) return k;
    }
    if (e.def?.isBoss || e.isBoss) return 'boss';
    return null;
  }

  /** One throat per entity per cooldown, so a pack does not become a chorus. */
  _vocalise(arch, pos, opts = {}, entity = null) {
    const id = VOC_MAP[arch] ?? 'voc.ghoul';
    if (entity) {
      const now = this.ctx.currentTime;
      const last = this._vocAt.get(entity) ?? -99;
      const gap = arch === 'boss' ? 2.4 : 0.75;
      if (now - last < gap) return null;
      this._vocAt.set(entity, now);
      if (this._vocAt.size > 128) this._vocAt.clear();
    }
    return this.play(id, { position: pos, ...opts });
  }

  /** Footstep surface from the world, not from a guess. */
  _surfaceAt(x, y, z) {
    const water = this._water;
    if (water && !water.__dead && typeof water.levelAt === 'function') {
      try {
        const lvl = water.levelAt(x, z);
        if (Number.isFinite(lvl) && y < lvl + 0.07) return 'water';
      } catch { /* water not built for this biome */ }
    }
    if (this.interior) return 'stone';
    const terrain = this._terrain;
    let wet = 0;
    if (terrain && !terrain.__dead && typeof terrain.wetnessAt === 'function') {
      try { wet = terrain.wetnessAt(x, z) ?? 0; } catch { wet = 0; }
    }
    if (this.weather.kind === 'rain' && this.weather.intensity > 0.5) wet = Math.max(wet, 0.5);
    if (wet > 0.62) return 'water';
    if (this.biome === 'town') return 'stone';
    return wet > 0.3 ? 'dirt' : 'grass';
  }

  /* ==================================================================== *
   * frame
   * ==================================================================== */

  /**
   * The engine disables any module that throws out of `update`. Audio is
   * presentation: a bad envelope must never cost the player a frame, let alone
   * the rest of the session. So the frame is fenced, and if it keeps failing the
   * sound goes quiet on its own instead of taking the game with it.
   */
  update(dt, elapsed) {
    if (this.silent || !this.enabled || this.failed) return;
    try {
      this._frame(dt, elapsed);
    } catch (e) {
      this._stats.errors++;
      if (this._stats.errors <= 4) console.warn('[audio] frame error —', e?.message ?? e);
      if (this._stats.errors > 24) {
        console.warn('[audio] too many frame errors — going silent');
        this.failed = true;
        try { this.music?.stop(0.3); } catch { /* noop */ }
      }
    }
  }

  _frame(dt) {
    this._frameVoices = 0;
    this._sceneT += dt;

    // Module handles are resolved lazily and cached — modules can be absent.
    if (this._hero === undefined || (this.engine.clock.frame & 63) === 0) {
      this._hero = this.engine.get('hero') ?? null;
      this._terrain = this.engine.get('terrain') ?? null;
      this._water = this.engine.get('water') ?? null;
      this._dungeon = this.engine.get('dungeon') ?? null;
      this._bestiary = this.engine.get('bestiary') ?? null;
      this._lighting = this.engine.get('lighting') ?? null;
      this._harvestFixtures();
    }

    this._updateListener(dt);
    if (!this.running) return;

    this.pool.update();
    this.uiPool.update();
    this._heroFootsteps(dt);
    this._idleVocalisations(dt);
    this.ambience.update(dt, this.listener.x, this.listener.y, this.listener.z);
    this.music.update();
    this.music.reap();
    this._updateMusicState(dt);
    this._updateDuck(dt);
  }

  /** Listener rides the camera, pulled toward what the camera is looking at. */
  _updateListener(dt) {
    const cam = this.engine.camera;
    if (!cam) return;
    const L = this.listener;
    const cp = cam.position;
    // Camera forward in world space.
    const e = cam.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    // Pull the ear from the camera down the view ray toward the focal plane, so
    // an ARPG camera 28 m out does not put every sound at the far end of a hall.
    const focus = (this.engine.get('camera')?.distance ?? 28) * this.listenerPull;
    L.x = cp.x + fx * focus; L.y = cp.y + fy * focus; L.z = cp.z + fz * focus;
    L.fx = fx; L.fy = fy; L.fz = fz;
    L.ux = ux; L.uy = uy; L.uz = uz;

    const lis = this.ctx.listener;
    const t = this.ctx.currentTime;
    try {
      if (lis.positionX) {
        lis.positionX.setTargetAtTime(L.x, t, 0.03);
        lis.positionY.setTargetAtTime(L.y, t, 0.03);
        lis.positionZ.setTargetAtTime(L.z, t, 0.03);
        lis.forwardX.setTargetAtTime(fx, t, 0.05);
        lis.forwardY.setTargetAtTime(fy, t, 0.05);
        lis.forwardZ.setTargetAtTime(fz, t, 0.05);
        lis.upX.setTargetAtTime(ux, t, 0.05);
        lis.upY.setTargetAtTime(uy, t, 0.05);
        lis.upZ.setTargetAtTime(uz, t, 0.05);
      } else {
        lis.setPosition?.(L.x, L.y, L.z);
        lis.setOrientation?.(fx, fy, fz, ux, uy, uz);
      }
    } catch { /* listener params busy — next frame */ }
  }

  /**
   * Hero footsteps are driven by the locomotion clip's phase, not a timer, so
   * they land on the animation's contact frames exactly like the enemies' do
   * (Bestiary emits `impact` kind 'footfall' from its own foot bones).
   */
  _heroFootsteps() {
    const h = this._hero;
    const g = h?.graph;
    if (!h || !g || h.isDead || h.failed) return;
    if (g.baseClip !== 'locomotion') { this._stepPrev = 0; return; }
    const vel = h.velocity;
    const speed = vel ? Math.hypot(vel.x ?? 0, vel.z ?? 0) : 0;
    if (speed < 0.35) { this._stepPrev = g.basePhase ?? 0; return; }

    const ph = g.basePhase ?? 0;
    let prev = this._stepPrev;
    if (ph < prev) prev -= 1;                                  // wrapped this frame
    this._stepPrev = ph;
    // Two contacts per locomotion cycle, at the phases the clip plants a foot.
    for (const contact of [0.07, 0.57]) {
      if (!(prev < contact && ph >= contact)) continue;
      const p = h.position;
      const surf = this._surfaceAt(p.x, p.y, p.z);
      const run = clamp01((speed - 0.6) / 4.2);
      this.play(`step.${surf}`, {
        position: [p.x, p.y + 0.06, p.z],
        magnitude: 0.4 + run * 0.7,
        gain: 0.7 + run * 0.55,
        priority: 0.3,
      });
    }
  }

  /** Occasional idle throat from a nearby living enemy — a pack you can hear. */
  _idleVocalisations(dt) {
    if (this._sceneT < this._idleVocAt) return;
    const r = this.engine.rand('audio:idlevoc');
    this._idleVocAt = this._sceneT + 1.6 + r() * 4.2;
    const bes = this._bestiary;
    const list = bes?.entities ?? bes?.actors ?? bes?.monsters ?? null;
    if (!Array.isArray(list) || !list.length) return;
    // Pick deterministically among those in earshot.
    const lx = this.listener.x, lz = this.listener.z;
    let best = null, bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.dead || !e.position) continue;
      const d2 = (e.position.x - lx) ** 2 + (e.position.z - lz) ** 2;
      if (d2 > 1200) continue;
      const score = r() * (1 - d2 / 1200);
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (!best) return;
    const arch = this._archetypeOf(best);
    if (!arch) return;
    this._vocalise(arch, [best.position.x, best.position.y + 1.2, best.position.z], { gain: 0.55, priority: 0.4 }, best);
  }

  /** Read practicals already registered with Lighting so fire has a place to be. */
  _harvestFixtures() {
    const l = this._lighting;
    const list = l && !l.__dead ? l.practicals : null;
    if (!Array.isArray(list) || !list.length) return;
    this.ambience?.clearFires();
    let n = 0;
    for (let i = 0; i < list.length && n < 64; i++) {
      const p = list[i];
      const type = String(p?.type ?? 'torch');
      if (!/torch|brazier|campfire|candle|hellfire|lava/.test(type)) continue;
      const bp = p.basePosition ?? p.position;
      if (!bp) continue;
      this.ambience?.addFire(bp.x ?? 0, bp.y ?? 1.4, bp.z ?? 0);
      n++;
    }
  }

  /** Combat intensity -> score state. Hysteresis, so it never flutters. */
  _updateMusicState(dt) {
    this.threat = Math.max(0, this.threat - dt * 0.075);
    if (this.bossActive === false && this._bestiary) {
      // A boss can spawn mid-scene; notice it without polling every frame.
      if ((this.engine.clock.frame & 127) === 0) {
        const list = this._bestiary.entities ?? this._bestiary.actors ?? null;
        if (Array.isArray(list)) {
          for (const e of list) if (e && !e.dead && (e.def?.isBoss || e.isBoss)) { this.bossActive = true; break; }
        }
      }
    }
    if (this._victoryArmed && this.threat < 0.12 && this._sceneT - this._killT > 2.2) {
      this._victoryArmed = false;
      this._autoState = 'victory';
      this.music?.request('victory');
      return;
    }
    // An explicit setMusicState() wins for its hold window; the hero dying wins
    // over everything.
    if (this.heroDead) { this._overrideUntil = 0; }
    else if (this._sceneT < (this._overrideUntil ?? 0)) return;

    const want = this._musicStateWanted();
    // Edge-triggered: only push on change, so polling never cancels a pending
    // transition that something else asked for.
    if (want !== this._autoState) {
      this._autoState = want;
      if (this.music && this.music.state !== 'victory') this.music.request(want);
    }
  }

  _musicStateWanted() {
    if (this.heroDead) return 'dead';
    if (this.bossActive) return 'boss';
    if (this.threat > 0.5) return 'combat';
    if (this.threat > 0.14) return 'tension';
    return 'explore';
  }

  /** Transient music/ambience duck under a big event. */
  _updateDuck(dt) {
    if (this._duck <= 0.001) return;
    const prev = this._duck;
    this._duck = Math.max(0, this._duck - dt * 0.85);
    const t = this.ctx.currentTime;
    const target = this.volume.music * (1 - prev * 0.42);
    try {
      this.musBus.gain.cancelScheduledValues(t);
      this.musBus.gain.setValueAtTime(this.musBus.gain.value, t);
      this.musBus.gain.linearRampToValueAtTime(this._duck < 0.002 ? this.volume.music : target, t + 0.12);
    } catch { /* busy */ }
  }

  /* ==================================================================== *
   * diagnostics + offline analysis
   * ==================================================================== */

  diagnostics() {
    if (this.silent) return { silent: true, reason: 'headless' };
    if (!this.enabled) return { enabled: false, failed: this.failed };
    return {
      enabled: true,
      running: this.running,
      muted: this.muted,
      state: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      baseLatency: +(this.ctx.baseLatency ?? 0).toFixed(4),
      room: this.room,
      biome: this.biome,
      interior: this.interior,
      weather: this.weather,
      threat: +this.threat.toFixed(3),
      bossActive: this.bossActive,
      duck: +this._duck.toFixed(3),
      listener: {
        x: +this.listener.x.toFixed(2), y: +this.listener.y.toFixed(2), z: +this.listener.z.toFixed(2),
      },
      voices: {
        spatial: this.pool.spatialVoices.length, flat: this.pool.flatVoices.length,
        active: this.pool.active, peak: this.pool.peakActive,
        stolen: this.pool.stolen, dropped: this.pool.dropped,
        ui: this.uiPool.flatVoices.length,
      },
      stats: { ...this._stats },
      fires: this.ambience?.firePoints.length ?? 0,
      music: this.music?.diagnostics() ?? null,
      recipes: SFX_IDS.length,
      irSeconds: +(this.convolver?.buffer?.duration ?? 0).toFixed(2),
    };
  }

  /** Every recipe id, for tooling and QA. */
  list() { return SFX_IDS.slice(); }

  /**
   * Render one recipe in an OfflineAudioContext and measure it. This is how the
   * SFX library is verified without a speaker: peak (must not clip), RMS (must
   * not be silent), and the spectral centroid (does a "metal" hit actually sit
   * higher than a "flesh" hit?).
   *
   * @returns {Promise<{id, duration, peak, rms, dbfs, centroidHz, silent, clipped}>}
   */
  async renderOffline(id, o = {}) {
    const recipe = SFX[id];
    if (!recipe) throw new Error(`no such sfx: ${id}`);
    const OAC = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('OfflineAudioContext unavailable');
    const sr = o.sampleRate ?? 48000;
    const seconds = o.seconds ?? 6;
    const ctx = new OAC(1, Math.floor(sr * seconds), sr);
    const bank = new NoiseBank(ctx, this.engine.rand(`audio:offline:${id}`), 2.5);
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(ctx.destination);
    const S = { ctx, bank, rnd: this.engine.rand(`audio:offline:v:${id}`), out, send: null, keep: (n) => n, t: 0.02, wet: 0.3 };
    let end = 0.5;
    try { end = recipe(S, o.opts ?? {}) || 0.5; } catch (e) { throw new Error(`recipe '${id}' threw: ${e?.message ?? e}`); }
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0, nz = 0;
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      if (a > 1e-4) nz = i;
    }
    const rms = Math.sqrt(sum / Math.max(1, d.length));
    // Spectral centroid via a coarse zero-crossing/energy proxy on the loud part.
    let cross = 0, prev = d[0] ?? 0, count = 0;
    const lim = Math.min(d.length, Math.max(1024, nz));
    for (let i = 1; i < lim; i++) {
      if ((d[i] >= 0) !== (prev >= 0)) cross++;
      prev = d[i];
      count++;
    }
    const centroidHz = count > 0 ? (cross / 2) * (sr / count) : 0;
    return {
      id,
      duration: +(nz / sr).toFixed(3),
      scheduledEnd: +end.toFixed(3),
      peak: +peak.toFixed(4),
      rms: +rms.toFixed(5),
      dbfs: +(20 * Math.log10(Math.max(1e-9, peak))).toFixed(2),
      centroidHz: Math.round(centroidHz),
      silent: peak < 0.002,
      clipped: peak > 1.0,
    };
  }

  /**
   * Render the adaptive score offline so the composition can be measured and
   * plotted. `cues` is a list of `[barIndex, state]` transitions, which is how
   * the exploration → combat → boss → victory arc is verified end to end.
   *
   * @returns {Promise<{seconds, peak, rms, bars, samples: Float32Array, sampleRate}>}
   */
  async renderMusicOffline(o = {}) {
    const OAC = globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext;
    if (!OAC) throw new Error('OfflineAudioContext unavailable');
    const sr = o.sampleRate ?? 24000;
    const seconds = o.seconds ?? 24;
    const ctx = new OAC(1, Math.floor(sr * seconds), sr);
    const bank = new NoiseBank(ctx, this.engine.rand('audio:offline:music:noise'), 2.5);

    const bus = ctx.createGain();
    bus.gain.value = this.volume.music;   // same trim the live music bus carries
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -5.5; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.002; lim.release.value = 0.14;
    bus.connect(lim); lim.connect(ctx.destination);

    // A dry-ish room so the plot shows the composition, not the tail.
    const send = ctx.createGain(); send.gain.value = 0.5;
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = bank.ir('chamber');
    const back = ctx.createGain(); back.gain.value = 0.5;
    send.connect(conv); conv.connect(back); back.connect(lim);

    const { Music: M } = await import('./Music.js');
    const m = new M({ ctx, bank, bus, wet: send, rnd: this.engine.rand('audio:offline:music'), seed: 0x5A1C7C4D });
    m.state = o.start ?? 'explore';
    const bars = m.scheduleAhead(o.bars ?? 12, 0.05, o.cues ?? [[3, 'combat'], [7, 'boss'], [10, 'victory']]);

    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
      sum += d[i] * d[i];
    }
    m.dispose();
    return {
      seconds, sampleRate: sr, bars: +bars.toFixed(2),
      peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(5),
      samples: d,
    };
  }

  /* ==================================================================== *
   * teardown
   * ==================================================================== */

  _teardown() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    for (const off of this._gestureOff) { try { off(); } catch { /* noop */ } }
    this._gestureOff.length = 0;
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
    if (this._onBlur) removeEventListener('blur', this._onBlur);
    if (this._onFocus) removeEventListener('focus', this._onFocus);
    if (this._suspendTimer) { clearTimeout(this._suspendTimer); this._suspendTimer = null; }
    try { this.music?.dispose(); } catch { /* noop */ }
    try { this.ambience?.dispose(); } catch { /* noop */ }
    try { this.pool?.dispose(); this.uiPool?.dispose(); } catch { /* noop */ }
    try { this.bank?.dispose(); } catch { /* noop */ }
    this.running = false;
    this.enabled = false;
  }

  dispose() {
    if (this.silent) return;
    this._teardown();
    try { this.ctx?.close?.(); } catch { /* noop */ }
    this.ctx = null;
  }
}
