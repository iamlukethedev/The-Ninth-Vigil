/**
 * THE NINTH VIGIL — ambience beds.
 * ---------------------------------------------------------------------------
 * Continuous, always-running layers whose gains are crossfaded by biome and
 * weather, plus sparse scheduled one-shots (drips, debris, embers) that keep
 * silence from feeling like a bug.
 *
 * Node cost: each bed is one BufferSource + 1–3 filters + 1 gain, created once
 * and never rebuilt. Twelve nodes total for the whole soundscape.
 *
 * Beds
 *   wind      brown noise -> lowpass gusting on a slow LFO, plus a whistle band
 *   rain      white noise -> bandpass hiss + a lowpassed body
 *   fire      brown roar + crackle grain, panned to the nearest practical
 *   rumble    sub-bass cave tone, very slow amplitude drift
 *   room      broadband stone hiss — the "silence" of a big sealed space
 *
 * One-shots
 *   drip / debris in crypts, ember pops near fire, distant thunder from Weather.
 */

import { NoiseBank } from './Noise.js';
import { gn, bq, lfo, clamp } from './Nodes.js';

const MIX = {
  crypt:  { wind: 0.10, rain: 0, fire: 0.85, rumble: 0.55, room: 0.45, drip: 1.0,  debris: 0.55 },
  hell:   { wind: 0.20, rain: 0, fire: 1.00, rumble: 0.95, room: 0.35, drip: 0.15, debris: 0.75 },
  town:   { wind: 0.45, rain: 0, fire: 0.55, rumble: 0.05, room: 0.10, drip: 0.10, debris: 0.05 },
  moor:   { wind: 1.00, rain: 0, fire: 0.20, rumble: 0.10, room: 0.05, drip: 0.05, debris: 0.10 },
  default:{ wind: 0.55, rain: 0, fire: 0.35, rumble: 0.15, room: 0.15, drip: 0.25, debris: 0.20 },
};

export class Ambience {
  /**
   * @param {object} host { ctx, bank, bus (GainNode), wet (GainNode|null), pool, rnd, engine }
   */
  constructor(host) {
    this.h = host;
    this.ctx = host.ctx;
    this.beds = new Map();
    this.biome = 'crypt';
    this.weather = { kind: 'none', intensity: 0 };
    this.wetness = 0;
    this.intensity = 1;
    this.firePoints = [];
    this._fireIdx = 0;
    this._next = { drip: 0.8, debris: 3.1, ember: 1.7, gust: 5.0 };
    this._t = 0;
    this._started = false;
    /** every node built here, so dispose() can tear the whole bed down */
    this._nodes = [];
  }

  /** Build every bed once, silent. Nothing is audible until `apply()` runs. */
  build() {
    if (this._started) return;
    const { ctx } = this;
    const keep = (n) => { this._nodes.push(n); return n; };
    const S = { ctx, bank: this.h.bank, rnd: this.h.rnd, out: this.h.bus, keep };

    /* ---- wind: gusting lowpassed brown noise + a thin whistle ---- */
    {
      const out = gn(S, 0);
      const src = ctx.createBufferSource();
      src.buffer = this.h.bank.get('brown');
      src.loop = true;
      src.playbackRate.value = 0.85;
      const lp = bq(S, 'lowpass', 420, 0.9);
      const hp = bq(S, 'highpass', 45, 0.7);
      src.connect(hp); hp.connect(lp); lp.connect(out);
      // two decorrelated gust LFOs so the envelope never repeats obviously
      lfo(S, lp.frequency, 0, 1e7, 0.043, 250, 'sine');
      lfo(S, lp.frequency, 0, 1e7, 0.017, 160, 'triangle', 90);
      lfo(S, out.gain, 0, 1e7, 0.031, 0.22, 'sine');
      // whistle: a narrow band drifting across the top of the noise
      const wsrc = ctx.createBufferSource();
      wsrc.buffer = this.h.bank.get('white');
      wsrc.loop = true;
      const wbp = bq(S, 'bandpass', 1400, 8);
      const wg = gn(S, 0.05);
      wsrc.connect(wbp); wbp.connect(wg); wg.connect(out);
      lfo(S, wbp.frequency, 0, 1e7, 0.021, 700, 'sine', 45);
      lfo(S, wg.gain, 0, 1e7, 0.037, 0.045, 'triangle');
      out.connect(this.h.bus);
      this._reg('wind', out, [src, wsrc]);
    }

    /* ---- rain: hiss band + lowpassed body ---- */
    {
      const out = gn(S, 0);
      const src = ctx.createBufferSource();
      src.buffer = this.h.bank.get('white');
      src.loop = true;
      const bp = bq(S, 'bandpass', 2400, 0.55);
      const hp = bq(S, 'highpass', 700, 0.7);
      const hg = gn(S, 0.55);
      src.connect(hp); hp.connect(bp); bp.connect(hg); hg.connect(out);
      const src2 = ctx.createBufferSource();
      src2.buffer = this.h.bank.get('pink');
      src2.loop = true;
      src2.playbackRate.value = 1.3;
      const lp = bq(S, 'lowpass', 900, 0.8);
      const lg = gn(S, 0.5);
      src2.connect(lp); lp.connect(lg); lg.connect(out);
      lfo(S, out.gain, 0, 1e7, 0.067, 0.10, 'sine');
      out.connect(this.h.bus);
      this._reg('rain', out, [src, src2]);
    }

    /* ---- fire: roar + crackle, spatialised at the nearest practical ---- */
    {
      const out = gn(S, 0);
      const src = ctx.createBufferSource();
      src.buffer = this.h.bank.get('brown');
      src.loop = true;
      src.playbackRate.value = 1.15;
      const lp = bq(S, 'lowpass', 700, 1.3);
      const hp = bq(S, 'highpass', 90, 0.7);
      const rg = gn(S, 0.7);
      src.connect(hp); hp.connect(lp); lp.connect(rg); rg.connect(out);
      lfo(S, lp.frequency, 0, 1e7, 0.31, 260, 'sine');
      lfo(S, rg.gain, 0, 1e7, 0.19, 0.18, 'triangle');
      const csrc = ctx.createBufferSource();
      csrc.buffer = this.h.bank.get('crackle');
      csrc.loop = true;
      const cbp = bq(S, 'bandpass', 2200, 1.0);
      const cg = gn(S, 0.5);
      csrc.connect(cbp); cbp.connect(cg); cg.connect(out);
      lfo(S, cg.gain, 0, 1e7, 0.53, 0.22, 'sine', 120);
      // fire gets its own panner so it sits at a torch rather than in the head
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = 3.2;
      pan.rolloffFactor = 1.5;
      pan.maxDistance = 40;
      out.connect(pan);
      pan.connect(this.h.bus);
      if (this.h.wet) { const w = gn(S, 0.35); out.connect(w); w.connect(this.h.wet); }
      this._reg('fire', out, [src, csrc], pan);
    }

    /* ---- cave rumble: sub tone with a very slow breath ---- */
    {
      const out = gn(S, 0);
      const src = ctx.createBufferSource();
      src.buffer = this.h.bank.get('rumble');
      src.loop = true;
      src.playbackRate.value = 0.7;
      const lp = bq(S, 'lowpass', 78, 1.6);
      src.connect(lp); lp.connect(out);
      lfo(S, out.gain, 0, 1e7, 0.023, 0.30, 'sine');
      lfo(S, lp.frequency, 0, 1e7, 0.011, 22, 'triangle', 60);
      out.connect(this.h.bus);
      this._reg('rumble', out, [src]);
    }

    /* ---- room tone: the broadband hiss of a big sealed stone space ---- */
    {
      const out = gn(S, 0);
      const src = ctx.createBufferSource();
      src.buffer = this.h.bank.get('pink');
      src.loop = true;
      src.playbackRate.value = 0.6;
      const lp = bq(S, 'lowpass', 1100, 0.7);
      const hp = bq(S, 'highpass', 160, 0.7);
      src.connect(hp); hp.connect(lp); lp.connect(out);
      out.connect(this.h.bus);
      if (this.h.wet) { const w = gn(S, 0.5); out.connect(w); w.connect(this.h.wet); }
      this._reg('room', out, [src]);
    }

    const t = this.ctx.currentTime + 0.02;
    for (const bed of this.beds.values()) for (const s of bed.sources) { try { s.start(t); } catch { /* already started */ } }
    this._started = true;
  }

  _reg(name, gain, sources, panner = null) {
    this.beds.set(name, { gain, sources, panner, target: 0 });
  }

  /** Biome / weather mix. Everything crossfades — nothing cuts. */
  apply(biome, weather = null, fade = 2.2) {
    if (biome) this.biome = biome;
    if (weather) this.weather = { kind: weather.kind ?? 'none', intensity: weather.intensity ?? 0 };
    const mix = MIX[this.biome] ?? MIX.default;
    const w = this.weather;
    const rainAmt = (w.kind === 'rain' || w.kind === 'storm') ? clamp(0.25 + w.intensity * 0.85, 0, 1)
      : w.kind === 'snow' ? clamp(w.intensity * 0.18, 0, 0.3) : 0;
    const windBoost = (w.kind === 'storm' ? 1.5 : w.kind === 'overcast' ? 1.15 : w.kind === 'ember' ? 0.8 : 1)
      * (1 + w.intensity * 0.35);

    this._set('wind', mix.wind * windBoost * 0.16, fade);
    this._set('rain', rainAmt * 0.34, fade * 0.6);
    this._set('fire', mix.fire * 0.20, fade);
    this._set('rumble', mix.rumble * 0.28, fade);
    this._set('room', mix.room * 0.055, fade);
    this._mix = mix;
  }

  _set(name, v, fade) {
    const bed = this.beds.get(name);
    if (!bed) return;
    bed.target = v;
    const g = bed.gain.gain;
    const t = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(v * this.intensity, t + Math.max(0.05, fade));
    } catch { /* param busy — next apply() will catch up */ }
  }

  /** Master ambience trim (used when music takes the foreground in a boss fight). */
  setIntensity(k, fade = 1.5) {
    this.intensity = clamp(k, 0, 1.5);
    for (const [name, bed] of this.beds) this._set(name, bed.target, fade);
  }

  /** Register a fire source position (torch, brazier, campfire). */
  addFire(x, y, z) {
    this.firePoints.push({ x, y, z });
    if (this.firePoints.length > 96) this.firePoints.shift();
  }
  clearFires() { this.firePoints.length = 0; }

  /**
   * Per-frame: move the fire bed to the nearest practical and schedule sparse
   * one-shots. `lx/ly/lz` is the listener position.
   */
  update(dt, lx, ly, lz) {
    this._t += dt;
    const mix = this._mix ?? MIX.default;

    /* fire bed follows the nearest lit fixture */
    const fire = this.beds.get('fire');
    if (fire?.panner) {
      let best = null, bd = Infinity;
      for (let i = 0; i < this.firePoints.length; i++) {
        const p = this.firePoints[i];
        const d = (p.x - lx) ** 2 + (p.z - lz) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        const p = fire.panner;
        const t = this.ctx.currentTime;
        if (p.positionX) {
          p.positionX.setTargetAtTime(best.x, t, 0.25);
          p.positionY.setTargetAtTime(best.y, t, 0.25);
          p.positionZ.setTargetAtTime(best.z, t, 0.25);
        } else if (p.setPosition) p.setPosition(best.x, best.y, best.z);
      }
    }

    /* sparse one-shots */
    const R = this.h.rnd;
    if (mix.drip > 0.02 && this._t >= this._next.drip) {
      this._next.drip = this._t + 1.4 + R() * 5.5 / Math.max(0.15, mix.drip);
      const a = R() * Math.PI * 2, r = 3 + R() * 12;
      this.h.play('drip', {
        position: [lx + Math.cos(a) * r, ly - 1.2 + R() * 2.5, lz + Math.sin(a) * r],
        gain: 0.55 + R() * 0.6, priority: 0.22,
      });
    }
    if (mix.debris > 0.02 && this._t >= this._next.debris) {
      this._next.debris = this._t + 6 + R() * 16 / Math.max(0.15, mix.debris);
      const a = R() * Math.PI * 2, r = 6 + R() * 18;
      this.h.play('debris', {
        position: [lx + Math.cos(a) * r, ly + R() * 3, lz + Math.sin(a) * r],
        gain: 0.4 + R() * 0.5, priority: 0.2,
      });
    }
    if (this.firePoints.length && this._t >= this._next.ember) {
      this._next.ember = this._t + 2.2 + R() * 5.5;
      const p = this.firePoints[this._fireIdx++ % this.firePoints.length];
      if (p && (p.x - lx) ** 2 + (p.z - lz) ** 2 < 900) {
        this.h.play('debris', { position: [p.x, p.y, p.z], gain: 0.22 + R() * 0.25, priority: 0.18 });
      }
    }
  }

  /** Occlusion / wetness trim applied by the engine when it knows the space. */
  setRoom(room) {
    this.room = room;
  }

  dispose() {
    for (const bed of this.beds.values()) {
      for (const s of bed.sources) { try { s.stop(); s.disconnect(); } catch { /* already gone */ } }
      try { bed.gain.disconnect(); bed.panner?.disconnect(); } catch { /* gone */ }
    }
    for (const n of this._nodes) {
      try { if (typeof n.stop === 'function') n.stop(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* already gone */ }
    }
    this._nodes.length = 0;
    this.beds.clear();
    this.firePoints.length = 0;
    this._started = false;
  }
}

export const AMBIENCE_ROOMS = NoiseBank.ROOMS;
