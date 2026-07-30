/**
 * THE NINTH VIGIL — procedural noise bank + procedurally generated impulse responses.
 * ---------------------------------------------------------------------------
 * There are no audio files in this project. Every waveform below is computed
 * from a deterministic PRNG at runtime, once, and then reused by BufferSource
 * nodes (which are the cheapest source Web Audio has).
 *
 * Determinism: the caller supplies `rnd` — an `engine.rand()` stream. No
 * Math.random(), no Date.now().
 */

/** Shared, lazily-built noise buffers for one AudioContext. */
export class NoiseBank {
  /**
   * @param {BaseAudioContext} ctx
   * @param {() => number} rnd deterministic [0,1) generator
   * @param {number} seconds buffer length (looped / offset-sampled)
   */
  constructor(ctx, rnd, seconds = 2.5) {
    this.ctx = ctx;
    this.rnd = rnd;
    this.seconds = seconds;
    this._buf = new Map();
    this._ir = new Map();
  }

  /**
   * Buffers are deterministic for a given (kind, sampleRate, length, seed
   * stream), so they are cached process-wide and shared with any other context
   * at the same sample rate — which is what makes offline analysis renders cheap.
   */
  static _shared = new Map();

  /** @param {'white'|'pink'|'brown'|'grit'|'crackle'|'rumble'|'metal'} kind */
  get(kind = 'white') {
    let b = this._buf.get(kind);
    if (b) return b;
    const key = `${kind}:${this.ctx.sampleRate}:${this.seconds}`;
    b = NoiseBank._shared.get(key);
    if (!b) { b = this._build(kind); NoiseBank._shared.set(key, b); }
    this._buf.set(kind, b);
    return b;
  }

  _build(kind) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.max(256, Math.floor(sr * this.seconds));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const r = this.rnd;

    switch (kind) {
      case 'pink': {
        // Paul Kellet's economy pink filter — flat-ish -3 dB/oct.
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < n; i++) {
          const w = r() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
          b6 = w * 0.115926;
        }
        break;
      }
      case 'brown': {
        let last = 0;
        for (let i = 0; i < n; i++) {
          const w = r() * 2 - 1;
          last = (last + 0.019 * w) * 0.9985;
          d[i] = last * 8.5;
        }
        break;
      }
      case 'rumble': {
        // Two cascaded leaky integrators — energy almost entirely below 90 Hz.
        let a = 0, b = 0;
        for (let i = 0; i < n; i++) {
          a += ((r() * 2 - 1) - a) * 0.004;
          b += (a - b) * 0.0022;
          d[i] = b * 42;
        }
        break;
      }
      case 'grit': {
        // White noise amplitude-modulated by slow noise: grain, scuff, gravel.
        let m = 0.5, mt = 0;
        for (let i = 0; i < n; i++) {
          mt += (r() - mt) * 0.0035;
          m = 0.25 + mt * 1.5;
          const w = r() * 2 - 1;
          d[i] = w * m * (0.35 + 0.65 * (r() < 0.6 ? 1 : 0.25));
        }
        break;
      }
      case 'crackle': {
        // Sparse decaying impulses — the grain layer of fire and embers.
        d.fill(0);
        let i = 0;
        while (i < n) {
          i += 40 + Math.floor(r() * 1500);
          if (i >= n) break;
          const amp = (0.25 + r() * 0.75) * (r() < 0.12 ? 2.2 : 1);
          const dec = Math.exp(-1 / (sr * (0.0008 + r() * 0.006)));
          let e = amp;
          for (let k = i; k < n && e > 1e-4; k++) {
            d[k] += (r() * 2 - 1) * e;
            e *= dec;
          }
        }
        break;
      }
      case 'metal': {
        // Inharmonic partial soup: the shared body of chains, blades, grates.
        const partials = 26;
        const f = new Float32Array(partials);
        const g = new Float32Array(partials);
        for (let p = 0; p < partials; p++) {
          f[p] = 380 + r() * 5200;
          g[p] = (0.25 + r() * 0.75) / (1 + p * 0.22);
        }
        for (let i = 0; i < n; i++) {
          const t = i / sr;
          let s = 0;
          for (let p = 0; p < partials; p++) s += Math.sin(t * f[p] * 6.283185307179586) * g[p];
          d[i] = s * 0.16;
        }
        break;
      }
      case 'white':
      default:
        for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
        break;
    }

    // Normalise to a predictable peak so recipe gains mean the same thing
    // whatever the generator did.
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    if (peak > 1e-6 && (peak > 1.001 || peak < 0.85)) {
      const k = 0.94 / peak;
      for (let i = 0; i < n; i++) d[i] *= k;
    }
    return buf;
  }

  /* ------------------------------------------------------------------ *
   * impulse responses
   * ------------------------------------------------------------------ */

  /**
   * Room presets. `rt60` seconds, `predelay` seconds, `damping` 0..1 (how fast
   * the highs die), `er` early-reflection taps [timeSeconds, gain].
   */
  static ROOMS = {
    /** big wet ashlar crypt — long, dark, slappy */
    crypt: {
      rt60: 2.55, predelay: 0.021, damping: 0.72, tilt: 0.55, wet: 0.95,
      er: [[0.011, 0.52], [0.019, -0.41], [0.029, 0.33], [0.041, -0.26], [0.058, 0.20], [0.077, -0.15]],
    },
    /** cathedral-scale hell arena — enormous, low, ominous */
    hell: {
      rt60: 4.1, predelay: 0.034, damping: 0.80, tilt: 0.72, wet: 1.0,
      er: [[0.017, 0.44], [0.031, -0.36], [0.049, 0.29], [0.071, -0.22], [0.098, 0.17]],
    },
    /** stone chamber, mid size — corridors, vaults */
    chamber: {
      rt60: 1.5, predelay: 0.013, damping: 0.62, tilt: 0.42, wet: 0.85,
      er: [[0.007, 0.55], [0.013, -0.42], [0.022, 0.31], [0.034, -0.21]],
    },
    /** exterior: almost no tail, just a little air and a ground slap */
    exterior: {
      rt60: 0.52, predelay: 0.006, damping: 0.46, tilt: 0.25, wet: 0.42,
      er: [[0.004, 0.42], [0.009, -0.28], [0.016, 0.17]],
    },
    /** town square between buildings — short, bright, a touch of slap */
    town: {
      rt60: 0.92, predelay: 0.009, damping: 0.52, tilt: 0.3, wet: 0.55,
      er: [[0.006, 0.48], [0.012, -0.34], [0.021, 0.24], [0.033, -0.15]],
    },
  };

  /** @returns {AudioBuffer} a stereo, decaying, filtered-noise impulse response. */
  ir(name = 'chamber') {
    let b = this._ir.get(name);
    if (b) return b;
    const key = `ir:${name}:${this.ctx.sampleRate}`;
    b = NoiseBank._shared.get(key);
    if (!b) {
      const spec = NoiseBank.ROOMS[name] ?? NoiseBank.ROOMS.chamber;
      b = makeIR(this.ctx, this.rnd, spec);
      NoiseBank._shared.set(key, b);
    }
    this._ir.set(name, b);
    return b;
  }

  dispose() { this._buf.clear(); this._ir.clear(); }
}

/**
 * Build a stereo IR: exponentially decaying noise whose spectrum darkens over
 * time (air + porous-stone absorption), plus discrete early reflections, plus a
 * mild low-frequency lift so big rooms feel big rather than hissy.
 */
export function makeIR(ctx, rnd, spec) {
  const sr = ctx.sampleRate;
  const rt60 = Math.max(0.05, spec.rt60);
  const pd = Math.max(0, spec.predelay ?? 0.008);
  const n = Math.max(64, Math.floor(sr * (rt60 * 1.02 + pd)));
  const buf = ctx.createBuffer(2, n, sr);
  const decayK = -6.907755278982137 / rt60; // ln(1e-3)

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const skew = c === 0 ? 1 : 1.083;       // decorrelate the two channels
    const pdN = Math.floor(pd * sr * skew);
    let lp = 0, lp2 = 0, hp = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = (i - pdN) / sr;
      if (t < 0) { d[i] = 0; continue; }
      const env = Math.exp(decayK * t);
      // Cutoff coefficient falls as the tail ages: highs vanish first.
      const age = 1 - env;
      const a = 1 - Math.min(0.97, (spec.damping ?? 0.6) * (0.18 + 0.78 * age));
      const w = rnd() * 2 - 1;
      lp += (w - lp) * a;
      lp2 += (lp - lp2) * 0.55;
      // gentle DC/rumble control
      hp += (lp2 - hp) * 0.0009;
      const body = (lp * (1 - (spec.tilt ?? 0.4)) + lp2 * (spec.tilt ?? 0.4)) - hp * 0.6;
      // slight diffusion smear so the noise floor is dense, not grainy
      const s = body * 0.82 + prev * 0.34;
      prev = body;
      d[i] = s * env;
    }
    const er = spec.er ?? [];
    for (let k = 0; k < er.length; k++) {
      const idx = Math.floor((pd + er[k][0] * skew) * sr);
      if (idx > 0 && idx < n) d[idx] += er[k][1] * (c === 0 ? 1 : -0.86);
    }
    // Peak-normalise per channel, then scale by the room's wetness weight so
    // the convolver's output level is consistent across presets.
    let peak = 0;
    for (let i = 0; i < n; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; }
    if (peak > 1e-9) {
      const k = ((spec.wet ?? 0.8) * 0.9) / peak;
      for (let i = 0; i < n; i++) d[i] *= k;
    }
  }
  return buf;
}

/**
 * A tanh-ish soft-clip curve for the safety stage after the limiter.
 * `drive` > 1 pushes harder; the curve is exactly ±1 bounded.
 */
export function softClipCurve(len = 2048, drive = 1.6) {
  const c = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return c;
}
