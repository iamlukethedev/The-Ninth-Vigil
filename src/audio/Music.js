/**
 * THE NINTH VIGIL — adaptive procedural score.
 * ---------------------------------------------------------------------------
 * There is no music file. The score is composed at runtime from a modal scale
 * (Aeolian for exploration, Phrygian once blades are out — the Phrygian ♭II is
 * the single interval that makes a cue read "gothic" rather than "fantasy") and
 * played by five synthesised stems:
 *
 *   drone    continuous detuned saw pair + sine sub, glides between chord roots
 *   pad      detuned saw/triangle triad through a moving lowpass — the bed
 *   choir    saw stack through a vowel formant bank — wordless voices
 *   harp     plucked modal figures, sparse, the only "melody" in exploration
 *   perc     taiko-ish low thump + iron scrape; enters with combat
 *   hits     swelling braam + sub bloom at phrase heads; boss only
 *
 * Adaptivity: `request('combat')` never cuts. The new state is latched and
 * applied on the next bar boundary, and stem gains crossfade over roughly a bar
 * and a half. Tempo changes are likewise quantised to the bar.
 *
 * Determinism: every bar's figure is generated from `makeRand(seed ^ bar)`, so
 * bar 37 is the same bar 37 on every run and in every session with the same
 * world seed. Nothing here calls Math.random or Date.now — `ctx.currentTime` is
 * the audio hardware clock, which is what sample-accurate scheduling requires.
 */

import { makeRand } from '../core/Rand.js';
import {
  gn, bq, tone, lfo, noise, pluck, sawStack, thump, formants,
  perc as percEnv, ahr, ramp, clamp, semi,
} from './Nodes.js';

const MODES = {
  aeolian:  [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  locrian:  [0, 1, 3, 5, 6, 8, 10],
  dorian:   [0, 2, 3, 5, 7, 9, 10],
};

/** D2 — low, dark, and it puts the harp register in a comfortable place. */
const ROOT = 73.41619;

/**
 * States. `stems` are target gains; `prog` is a list of scale degrees (index
 * into the mode) used as the chord root of each bar.
 */
const STATES = {
  explore: {
    mode: 'aeolian', tempo: 62, prog: [0, 5, 3, 4],
    stems: { drone: 0.58, pad: 0.40, choir: 0.06, harp: 0.40, perc: 0.00, hits: 0.00 },
    harpDensity: 0.44, percDensity: 0, cutoff: 900,
  },
  tension: {
    mode: 'aeolian', tempo: 74, prog: [0, 1, 0, 5],
    stems: { drone: 0.70, pad: 0.50, choir: 0.18, harp: 0.20, perc: 0.28, hits: 0.10 },
    harpDensity: 0.2, percDensity: 0.3, cutoff: 1100,
  },
  combat: {
    mode: 'phrygian', tempo: 94, prog: [0, 1, 0, 6, 0, 1, 5, 4],
    stems: { drone: 0.82, pad: 0.60, choir: 0.34, harp: 0.10, perc: 0.88, hits: 0.46 },
    harpDensity: 0.1, percDensity: 0.85, cutoff: 1500,
  },
  boss: {
    mode: 'phrygian', tempo: 82, prog: [0, 1, 5, 1, 0, 6, 4, 1],
    stems: { drone: 1.00, pad: 0.74, choir: 0.72, harp: 0.05, perc: 1.00, hits: 1.00 },
    harpDensity: 0.06, percDensity: 1.0, cutoff: 1800,
  },
  victory: {
    mode: 'dorian', tempo: 70, prog: [0, 4, 5, 0],
    stems: { drone: 0.52, pad: 0.86, choir: 0.84, harp: 0.62, perc: 0.34, hits: 0.40 },
    harpDensity: 0.5, percDensity: 0.25, cutoff: 2400,
  },
  dead: {
    mode: 'locrian', tempo: 48, prog: [0, 1, 0, 1],
    stems: { drone: 0.46, pad: 0.24, choir: 0.14, harp: 0.05, perc: 0.00, hits: 0.00 },
    harpDensity: 0.08, percDensity: 0, cutoff: 520,
  },
};

const STEMS = ['drone', 'pad', 'choir', 'harp', 'perc', 'hits'];

/**
 * Per-stem calibration. `STATES[*].stems` is *musical balance* (0..1, what the
 * arrangement wants); this is the *level* each stem needs to hit that balance,
 * measured from offline renders. A detuned saw drone is intrinsically ~6× hotter
 * than a plucked harp, so without this the drone alone eats the whole bus and the
 * limiter flattens the arrangement into a wall — which is exactly what it did
 * before these numbers existed.
 */
const STEM_TRIM = { drone: 0.17, pad: 0.32, choir: 0.42, harp: 1.1, perc: 0.55, hits: 0.34 };

export class Music {
  /** @param {object} host { ctx, bank, bus, wet, rnd, seed } */
  constructor(host) {
    this.h = host;
    this.ctx = host.ctx;
    this.seed = (host.seed ?? 0x5A17C7) >>> 0;

    this.state = 'explore';
    this.pending = null;
    this.bar = 0;
    this.nextBarAt = 0;
    this.barLen = 4 * 60 / STATES.explore.tempo;
    this.running = false;
    this.lookahead = 1.1;
    this.intensity = 1;
    this._victoryBars = 0;

    /** @type {Record<string, GainNode>} */
    this.stem = {};
    this._nodes = [];
    /** [node, expiryTime] — every transient node built for a bar */
    this._pending = [];
    this._drone = null;
    this._scheduled = 0;
  }

  /* ------------------------------------------------------------ build */

  build() {
    const ctx = this.ctx;
    const keep = (n) => { this._nodes.push(n); return n; };

    for (const name of STEMS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.h.bus);
      if (this.h.wet) {
        const w = ctx.createGain();
        w.gain.value = name === 'choir' ? 0.55 : name === 'perc' ? 0.20 : name === 'hits' ? 0.45 : 0.32;
        g.connect(w); w.connect(this.h.wet);
        keep(w);
      }
      this.stem[name] = g;
      keep(g);
    }

    /* ---- the drone is continuous: two saws + a sub, glided, never retriggered ---- */
    const S = { ctx, bank: this.h.bank, rnd: this.h.rnd, out: this.stem.drone, keep };
    const mix = gn(S, 1);
    const lp = bq(S, 'lowpass', 320, 1.8);
    mix.connect(lp); lp.connect(this.stem.drone);
    const o1 = tone(S, 'sawtooth', 0, 1e7, [[0, ROOT, 'set']], -7);
    const o2 = tone(S, 'sawtooth', 0, 1e7, [[0, ROOT, 'set']], +9);
    const o3 = tone(S, 'sine', 0, 1e7, [[0, ROOT * 0.5, 'set']]);
    // The sub octave sits at ~37 Hz, below most playback systems, so it is kept
    // quiet — it is felt, not heard, and it is the first thing to eat headroom.
    const g1 = gn(S, 0.34), g2 = gn(S, 0.30), g3 = gn(S, 0.20);
    o1.connect(g1); g1.connect(mix);
    o2.connect(g2); g2.connect(mix);
    o3.connect(g3); g3.connect(mix);
    lfo(S, lp.frequency, 0, 1e7, 0.037, 140, 'sine');
    lfo(S, lp.frequency, 0, 1e7, 0.129, 55, 'triangle', 40);
    lfo(S, o1.detune, 0, 1e7, 0.11, 6, 'triangle');
    lfo(S, o2.detune, 0, 1e7, 0.083, 7, 'sine', 90);
    // two breathing swells at incommensurate rates: the drone never sits still
    lfo(S, mix.gain, 0, 1e7, 0.029, 0.17, 'sine');
    lfo(S, mix.gain, 0, 1e7, 0.131, 0.09, 'sine', 55);
    this._drone = { o1, o2, o3, lp, freq: ROOT };
    this._droneStarted = false;
  }

  /* ---------------------------------------------------------- control */

  start() {
    if (this.running) return;
    if (!this._drone) this.build();
    if (!this._droneStarted) {
      // Oscillators created with start(0) are already running from t=0; nothing
      // to do but mark it. (tone() starts them at build time.)
      this._droneStarted = true;
    }
    this.running = true;
    this.nextBarAt = this.ctx.currentTime + 0.12;
    this._applyState(this.state, 0.9);
  }

  stop(fade = 1.2) {
    this.running = false;
    const t = this.ctx.currentTime;
    for (const name of STEMS) {
      const g = this.stem[name]?.gain;
      if (!g) continue;
      try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + fade); } catch { /* busy */ }
    }
  }

  /**
   * Latch a state change. It lands on the next bar — never mid-bar. Asking for
   * what is already playing (or already queued) is a no-op, so a caller polling
   * every frame cannot cancel a transition it did not make.
   */
  request(state) {
    if (!STATES[state]) return;
    if (state === (this.pending ?? this.state)) return;
    this.pending = state;
  }

  /** Global music trim, separate from the state's own stem balance. */
  setIntensity(k) {
    this.intensity = clamp(k, 0, 1.4);
    this._applyState(this.state, 0.8);
  }

  _applyState(name, fadeBars = 1.4) {
    const st = STATES[name] ?? STATES.explore;
    this.barLen = 4 * 60 / st.tempo;
    // Offline renders drive the clock themselves (see `scheduleAhead`).
    const t = this._stateRampAt || this.ctx.currentTime;
    const fade = Math.max(0.35, this.barLen * fadeBars);
    for (const stem of STEMS) {
      const g = this.stem[stem]?.gain;
      if (!g) continue;
      const target = (st.stems[stem] ?? 0) * (STEM_TRIM[stem] ?? 0.4) * this.intensity;
      try {
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(target, t + fade);
      } catch { /* param busy this frame — the next bar re-applies */ }
    }
  }

  /* ------------------------------------------------------------ frame */

  update() {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    let guard = 0;
    while (this.nextBarAt < now + this.lookahead && guard++ < 4) {
      this._scheduleBar(this.bar, this.nextBarAt);
      this.nextBarAt += this.barLen;
      this.bar++;
    }
    if (this.nextBarAt < now - 4) this.nextBarAt = now + 0.05; // recovered from a long suspend
  }

  /**
   * Schedule `bars` bars starting at `t0` without the real-time clock. An
   * OfflineAudioContext never advances `currentTime` until it renders, so the
   * normal lookahead loop cannot drive it; this does, which is what makes the
   * score renderable and measurable offline.
   *
   * @param {number} bars how many bars to lay down
   * @param {number} t0 start time in context seconds
   * @param {Array<[number,string]>|null} cues [barIndex, state] changes to apply
   * @returns {number} the time the last bar ends
   */
  scheduleAhead(bars, t0 = 0.05, cues = null) {
    if (!this._drone) this.build();
    const map = new Map(cues ?? []);
    let t = t0;
    this._applyState(this.state, 0.01);
    for (let b = 0; b < bars; b++) {
      const cue = map.get(b);
      if (cue) {
        this.pending = cue;
        // Gains must land inside the render, so ramp them from this bar's start.
        this._stateRampAt = t;
      }
      this._scheduleBar(b, t);
      t += this.barLen;
    }
    this._stateRampAt = 0;
    return t;
  }

  /* -------------------------------------------------------- composing */

  _scheduleBar(bar, t) {
    // state changes land here, on the bar line
    if (this.pending && this.pending !== this.state) {
      this.state = this.pending;
      this.pending = null;
      if (this.state === 'victory') this._victoryBars = 6;
      this._applyState(this.state, 1.3);
    } else if (this.state === 'victory' && this._victoryBars-- <= 0) {
      this.state = 'explore';
      this._applyState('explore', 1.6);
    }

    const st = STATES[this.state] ?? STATES.explore;
    const scale = MODES[st.mode] ?? MODES.aeolian;
    const deg = st.prog[bar % st.prog.length];
    const rootSemi = scale[deg % scale.length] + (deg >= scale.length ? 12 : 0);
    const chordRoot = ROOT * semi(rootSemi);
    const beat = this.barLen / 4;
    const r = makeRand((this.seed ^ Math.imul(bar + 1, 2654435761)) >>> 0);
    const phraseHead = bar % 4 === 0;

    // chord tones inside the mode, built off the chord's degree
    const triad = [0, 2, 4].map((k) => scale[(deg + k) % scale.length] + (deg + k >= scale.length ? 12 : 0));

    // Everything scheduled for this bar is guaranteed silent by here (longest
    // tail is the braam at ~2.4 s and the pad at 1.25 bars), so one expiry stamp
    // reclaims the whole bar's transient graph in a single linear pass.
    this._expiry = t + this.barLen * 1.6 + 2.8;

    this._drones(chordRoot, t, st);
    if ((st.stems.pad ?? 0) > 0.02) this._pad(triad, t, beat, st, r);
    if ((st.stems.choir ?? 0) > 0.04) this._choir(triad, t, beat, st, r, phraseHead);
    if ((st.stems.harp ?? 0) > 0.03) this._harp(scale, deg, t, beat, st, r);
    if ((st.stems.perc ?? 0) > 0.03) this._perc(t, beat, st, r, phraseHead);
    if ((st.stems.hits ?? 0) > 0.05 && phraseHead) this._hit(chordRoot, t, st, r);
    this._scheduled++;
  }

  /** Glide the continuous drone to the new chord root. */
  _drones(f, t, st) {
    const d = this._drone;
    if (!d) return;
    const glide = Math.min(this.barLen * 0.45, 1.4);
    for (const [o, mul] of [[d.o1, 1], [d.o2, 1], [d.o3, 0.5]]) {
      try {
        o.frequency.cancelScheduledValues(t);
        o.frequency.setValueAtTime(o.frequency.value, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(12, f * mul), t + glide);
      } catch { /* param busy */ }
    }
    try {
      d.lp.frequency.cancelScheduledValues(t);
      d.lp.frequency.setValueAtTime(d.lp.frequency.value, t);
      d.lp.frequency.linearRampToValueAtTime(st.cutoff * 0.42, t + glide);
    } catch { /* busy */ }
    d.freq = f;
  }

  /**
   * A synth scope whose every node is stamped with this bar's expiry, so the
   * reaper can disconnect the entire bar's graph in one linear pass. Sources
   * additionally self-disconnect on `onended`; this catches the gains, filters
   * and formant banks, which have no such callback.
   */
  _stemScope(name) {
    const q = this._pending;
    const exp = this._expiry;
    return {
      ctx: this.ctx, bank: this.h.bank, rnd: this.h.rnd, out: this.stem[name],
      keep: (n) => { q.push([n, exp]); return n; },
    };
  }

  /** Sustained triad: the harmonic bed. One stack per chord tone. */
  _pad(triad, t, beat, st, r) {
    const S = this._stemScope('pad');
    const dur = this.barLen * 1.25;
    for (let i = 0; i < triad.length; i++) {
      const oct = i === 0 ? 1 : 2;
      const f = ROOT * semi(triad[i]) * oct;
      sawStack(S, this.stem.pad, t + r() * 0.03, {
        f, voices: 3, detune: 11 + r() * 7, dur, a: this.barLen * 0.32, hold: this.barLen * 0.4,
        r: this.barLen * 0.5, gain: (i === 0 ? 0.13 : 0.085), cutoff: st.cutoff * (i === 0 ? 0.8 : 1.15),
        q: 1.5, type: i === 0 ? 'sawtooth' : 'triangle', drift: 0,
      });
    }
  }

  /** Wordless choir: saw stack pushed through a vowel formant bank. */
  _choir(triad, t, beat, st, r, phraseHead) {
    const vowel = phraseHead ? 'ah' : (r() < 0.5 ? 'oh' : 'uh');
    const dur = this.barLen * 1.15;
    const S = this._stemScope('choir');
    const bus = gn(S, 1);
    const out = gn(S, 0);
    formants(S, bus, out, vowel, t, dur + 0.4, 1, 0.02);
    const direct = gn(S, 0.18);
    bus.connect(direct); direct.connect(out);
    out.connect(this.stem.choir);
    // three voices: root up an octave, fifth, and the third above that
    const notes = [triad[0] + 12, triad[2] + 12, triad[1] + 24];
    for (let i = 0; i < notes.length; i++) {
      sawStack(S, bus, t + r() * 0.05, {
        f: ROOT * semi(notes[i]), voices: 3, detune: 13 + r() * 9, dur,
        a: this.barLen * 0.38, hold: this.barLen * 0.28, r: this.barLen * 0.45,
        gain: 0.05 / (1 + i * 0.35), cutoff: 2200, q: 1.1, type: 'sawtooth', drift: 0.4,
      });
    }
    ahr(out.gain, t, 1, this.barLen * 0.3, this.barLen * 0.45, this.barLen * 0.5);
  }

  /** Sparse plucked modal figure. The closest thing to a tune. */
  _harp(scale, deg, t, beat, st, r) {
    const S = this._stemScope('harp');
    const steps = 8;
    let last = deg;
    for (let i = 0; i < steps; i++) {
      if (r() > st.harpDensity * (i % 2 === 0 ? 1.35 : 0.7)) continue;
      // walk the mode: small intervals, occasional leap
      const move = r() < 0.72 ? (r() < 0.5 ? -1 : 1) : (r() < 0.5 ? -3 : 3);
      last = ((last + move) % scale.length + scale.length) % scale.length;
      const oct = 2 + (r() < 0.35 ? 1 : 0) + (r() < 0.12 ? 1 : 0);
      const f = ROOT * semi(scale[last]) * Math.pow(2, oct);
      pluck(S, this.stem.harp, t + i * (beat / 2) + r() * 0.012, {
        f, dur: 0.85 + r() * 0.9, gain: 0.16 * (0.6 + r() * 0.6), bright: 0.9 + r() * 0.6,
      });
    }
  }

  /** Taiko thump + iron scrape. This is what makes combat feel like combat. */
  _perc(t, beat, st, r, phraseHead) {
    const S = this._stemScope('perc');
    const d = st.percDensity;
    const pattern = [1, 0, 0.35, 0, 0.75, 0, 0.4, 0.55];
    for (let i = 0; i < 8; i++) {
      const w = pattern[i];
      if (w <= 0) continue;
      if (r() > 0.32 + d * w) continue;
      const tt = t + i * (beat / 2) + (r() - 0.5) * 0.008;
      const hard = w > 0.7;
      thump(S, this.stem.perc, tt, {
        f0: hard ? 108 + r() * 26 : 84 + r() * 20,
        f1: hard ? 41 : 48, dur: hard ? 0.42 : 0.24,
        gain: (hard ? 0.30 : 0.15) * (0.75 + r() * 0.5), click: hard ? 0.10 : 0.04,
      });
      // skin slap
      const g = gn(S, 0);
      const ns = noise(S, 'grit', tt, 0.07, 0.9 + r() * 0.5);
      const bp = bq(S, 'bandpass', 500 + r() * 900, 1.3);
      ns.connect(bp); bp.connect(g); g.connect(this.stem.perc);
      percEnv(g.gain, tt, (hard ? 0.09 : 0.05) * (0.6 + r() * 0.7), 0.002, 0.07);
    }
    // iron scrape on the back half of the bar
    if (d > 0.5 && r() < 0.55) {
      const tt = t + beat * (2 + Math.floor(r() * 2));
      const g = gn(S, 0);
      const ns = noise(S, 'metal', tt, 0.3, 0.5 + r() * 0.9);
      const bp = bq(S, 'bandpass', 2600 + r() * 2600, 2.2);
      const hp = bq(S, 'highpass', 900, 0.7);
      ns.connect(hp); hp.connect(bp); bp.connect(g); g.connect(this.stem.perc);
      percEnv(g.gain, tt, 0.055, 0.004, 0.26);
    }
  }

  /** Braam: a swelling detuned stack with a sub bloom and a noise riser. */
  _hit(f, t, st, r) {
    const S = this._stemScope('hits');
    const dur = Math.min(this.barLen * 0.9, 2.4);
    sawStack(S, this.stem.hits, t, {
      f: f * 0.5, voices: 5, detune: 17 + r() * 10, dur, a: 0.045, hold: dur * 0.35, r: dur * 0.55,
      gain: 0.11, cutoff: st.cutoff * 1.3, q: 1.6, type: 'sawtooth', drift: 0.25,
    });
    sawStack(S, this.stem.hits, t + 0.01, {
      f: f * semi(7), voices: 3, detune: 13, dur: dur * 0.8, a: 0.06, hold: dur * 0.25, r: dur * 0.5,
      gain: 0.05, cutoff: st.cutoff * 1.6, q: 1.2, type: 'triangle', drift: 0.2,
    });
    thump(S, this.stem.hits, t, { f0: f * 0.5, f1: f * 0.25, dur: dur * 0.7, gain: 0.28, click: 0.06 });
    // Riser out of the previous bar into this one. On the very first bar there
    // is no previous bar to reach back into, so it starts where the clock is.
    const rt = Math.max(t - 0.35, this.ctx.currentTime);
    const lead = t - rt;
    const g = gn(S, 0);
    const ns = noise(S, 'white', rt, lead + 0.07, 1);
    const bp = bq(S, 'bandpass', 1200, 2.4);
    ns.connect(bp); bp.connect(g); g.connect(this.stem.hits);
    ramp(bp.frequency, rt, [[0, 900, 'set'], [Math.max(0.02, lead), 5200, 'exp']]);
    percEnv(g.gain, rt, 0.05, Math.max(0.01, lead * 0.86), 0.09);
  }

  /**
   * Disconnect every transient node whose bar has fully decayed. Amortised, one
   * linear pass per frame, and it is the only thing standing between an adaptive
   * score and an unbounded node graph.
   */
  reap() {
    const q = this._pending;
    if (!q || !q.length) return;
    const now = this.ctx.currentTime;
    let w = 0;
    for (let i = 0; i < q.length; i++) {
      if (q[i][1] <= now) { try { q[i][0].disconnect(); } catch { /* gone */ } }
      else q[w++] = q[i];
    }
    q.length = w;
  }

  diagnostics() {
    const g = {};
    for (const s of STEMS) g[s] = +(this.stem[s]?.gain.value ?? 0).toFixed(3);
    return {
      state: this.state, pending: this.pending, bar: this.bar, barsScheduled: this._scheduled,
      tempo: Math.round(4 * 60 / this.barLen),
      mode: (STATES[this.state] ?? STATES.explore).mode, stems: g,
      pendingReap: this._pending?.length ?? 0,
    };
  }

  dispose() {
    this.running = false;
    for (const n of this._nodes) {
      try { if (typeof n.stop === 'function') n.stop(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* gone */ }
    }
    this._nodes.length = 0;
    if (this._pending) { for (const [n] of this._pending) { try { n.disconnect(); } catch { /* gone */ } } this._pending.length = 0; }
    this._drone = null;
  }
}

export const MUSIC_STATES = Object.keys(STATES);
