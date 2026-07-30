/**
 * THE NINTH VIGIL — synthesis primitives.
 * ---------------------------------------------------------------------------
 * Every SFX recipe is built from these. They all take a *synth scope* `S`:
 *
 *   S = { ctx, bank, rnd, out, send, keep }
 *
 *   ctx   BaseAudioContext (live or OfflineAudioContext — recipes are portable,
 *         which is what lets the audio be rendered and inspected offline)
 *   bank  NoiseBank for that ctx
 *   rnd   deterministic [0,1) generator — per-instance variation comes from here
 *   out   destination node for the dry signal
 *   send  destination node for the reverb send (may be null)
 *   keep  (node) => node — registers a node so the voice pool can disconnect it
 *
 * Node hygiene: every source gets an explicit `stop()` and an `onended` that
 * disconnects it. Nothing is left running, ever.
 */

const TAU = Math.PI * 2;
const EPS = 1e-4;

export const rr = (S, lo, hi) => lo + S.rnd() * (hi - lo);
export const rpick = (S, arr) => arr[Math.min(arr.length - 1, Math.floor(S.rnd() * arr.length))];
export const semi = (n) => Math.pow(2, n / 12);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Register + return. */
function K(S, node) { return S.keep ? S.keep(node) : node; }

/**
 * Web Audio throws RangeError on a start time in the past, and a recipe that
 * looks backwards (a riser that begins before the beat it lands on) legitimately
 * can. Clamp to the context clock: "as soon as possible" is the right answer,
 * and it must never be an exception that takes the whole module down.
 */
export const safeT = (S, t) => (t > S.ctx.currentTime ? t : S.ctx.currentTime);

/* ------------------------------------------------------------------ *
 * envelopes
 * ------------------------------------------------------------------ */

/**
 * Percussive envelope: silence -> peak over `a` -> exponential to silence
 * over `d`. Returns the time it finishes.
 */
export function perc(param, t, peak, a = 0.002, d = 0.2, curve = 'exp') {
  const p = Math.max(EPS * 4, peak);
  param.setValueAtTime(EPS, t);
  if (a > 1e-5) param.linearRampToValueAtTime(p, t + a); else param.setValueAtTime(p, t + a);
  if (curve === 'lin') param.linearRampToValueAtTime(EPS, t + a + d);
  else param.exponentialRampToValueAtTime(EPS, t + a + d);
  param.setValueAtTime(0, t + a + d + 0.001);
  return t + a + d + 0.001;
}

/** Attack / hold / release envelope for sustained layers. */
export function ahr(param, t, peak, a = 0.05, hold = 0.2, r = 0.4) {
  const p = Math.max(EPS * 4, peak);
  param.setValueAtTime(EPS, t);
  param.linearRampToValueAtTime(p, t + a);
  param.setValueAtTime(p, t + a + hold);
  param.exponentialRampToValueAtTime(EPS, t + a + hold + r);
  param.setValueAtTime(0, t + a + hold + r + 0.001);
  return t + a + hold + r + 0.001;
}

/** Multi-point ramp: pts = [[timeOffset, value, 'lin'|'exp'|'set'], ...]. */
export function ramp(param, t, pts) {
  let end = t;
  for (let i = 0; i < pts.length; i++) {
    const [dt, v, mode] = pts[i];
    const tt = t + dt;
    const vv = mode === 'exp' ? Math.max(EPS, v) : v;
    if (i === 0 || mode === 'set') param.setValueAtTime(vv, tt);
    else if (mode === 'exp') param.exponentialRampToValueAtTime(vv, tt);
    else param.linearRampToValueAtTime(vv, tt);
    end = tt;
  }
  return end;
}

/* ------------------------------------------------------------------ *
 * sources
 * ------------------------------------------------------------------ */

/** A gain node, registered. */
export function gn(S, v = 1) {
  const g = K(S, S.ctx.createGain());
  g.gain.value = v;
  return g;
}

/** A biquad, registered. */
export function bq(S, type = 'lowpass', f = 1000, q = 1, gainDb = 0) {
  const b = K(S, S.ctx.createBiquadFilter());
  b.type = type;
  b.frequency.value = clamp(f, 10, S.ctx.sampleRate * 0.48);
  b.Q.value = q;
  b.gain.value = gainDb;
  return b;
}

/**
 * Looped noise source starting at a deterministic random offset (so repeats of
 * the same recipe never sound identical) with an optional playback-rate skew.
 * @returns {AudioBufferSourceNode}
 */
export function noise(S, kind = 'white', t = 0, dur = 0.3, rate = 1) {
  t = safeT(S, t);
  const src = K(S, S.ctx.createBufferSource());
  src.buffer = S.bank.get(kind);
  src.loop = true;
  src.playbackRate.value = clamp(rate, 0.06, 8);
  const len = src.buffer.duration;
  const off = (S.rnd() * len * 0.92) % Math.max(0.001, len);
  src.start(t, off);
  src.stop(t + dur + 0.01);
  src.onended = () => { try { src.disconnect(); } catch { /* already gone */ } };
  return src;
}

/** Oscillator with a pitch envelope: pts as in `ramp`, in Hz. */
export function tone(S, type = 'sine', t = 0, dur = 0.3, pts = [[0, 220, 'set']], detuneCents = 0) {
  t = safeT(S, t);
  const o = K(S, S.ctx.createOscillator());
  o.type = type;
  ramp(o.frequency, t, pts);
  if (detuneCents) o.detune.value = detuneCents;
  o.start(t);
  o.stop(t + dur + 0.01);
  o.onended = () => { try { o.disconnect(); } catch { /* already gone */ } };
  return o;
}

/**
 * A low-frequency modulator wired into `param`. Used for flutter, vibrato,
 * wind gusting, snarl.
 */
export function lfo(S, param, t, dur, freq, depth, type = 'sine', phaseSkew = 0) {
  t = safeT(S, t);
  const o = K(S, S.ctx.createOscillator());
  o.type = type;
  o.frequency.value = Math.max(0.01, freq);
  if (phaseSkew) o.detune.value = phaseSkew;
  const g = gn(S, depth);
  o.connect(g);
  g.connect(param);
  o.start(t);
  o.stop(t + dur + 0.01);
  o.onended = () => { try { o.disconnect(); g.disconnect(); } catch { /* already gone */ } };
  return o;
}

/* ------------------------------------------------------------------ *
 * composites
 * ------------------------------------------------------------------ */

/**
 * Vowel / creature formant bank: three parallel resonant bandpasses whose
 * centres define the perceived vowel. This is what turns a buzzy saw into a
 * throat instead of a synthesiser.
 */
export const VOWELS = {
  ah:     [[730, 1.0, 90], [1090, 0.55, 110], [2440, 0.22, 180]],
  uh:     [[520, 1.0, 80], [1190, 0.45, 110], [2390, 0.18, 190]],
  oh:     [[570, 1.0, 75], [ 840, 0.62, 95], [2410, 0.14, 200]],
  ee:     [[270, 1.0, 60], [2290, 0.60, 140], [3010, 0.30, 220]],
  growl:  [[240, 1.0, 55], [ 620, 0.70, 90], [1520, 0.30, 200]],
  throat: [[180, 1.0, 45], [ 480, 0.62, 80], [1180, 0.34, 190]],
  shriek: [[880, 0.85, 120], [1960, 1.0, 190], [3720, 0.55, 340]],
  hiss:   [[1400, 0.7, 380], [3200, 1.0, 700], [6100, 0.5, 1200]],
  bone:   [[420, 0.8, 150], [1750, 1.0, 320], [4300, 0.7, 800]],
};

/**
 * Build a formant bank between `input` and `output`.
 * @param {number} shift multiply all centre frequencies (creature size)
 * @param {number} drift cents of slow wander so it never sits still
 */
export function formants(S, input, output, vowel = 'ah', t = 0, dur = 0.5, shift = 1, drift = 0) {
  const spec = VOWELS[vowel] ?? VOWELS.ah;
  for (let i = 0; i < spec.length; i++) {
    const [f, g, bw] = spec[i];
    const fc = clamp(f * shift, 40, S.ctx.sampleRate * 0.45);
    const b = bq(S, 'bandpass', fc, Math.max(0.6, fc / bw));
    if (drift > 0) lfo(S, b.frequency, t, dur, 0.7 + i * 0.43, fc * drift, 'sine', i * 90);
    const vg = gn(S, g);
    input.connect(b); b.connect(vg); vg.connect(output);
  }
}

/**
 * Inharmonic metal ring: N decaying partials with a shared strike time. This is
 * the body of every metallic impact, chain, and bell in the game.
 */
export function metalRing(S, dest, t, {
  base = 1400, partials = 6, spread = 2.4, decay = 0.9, gain = 0.25, decayJitter = 0.5, type = 'sine',
} = {}) {
  let end = t;
  for (let i = 0; i < partials; i++) {
    const f = base * (1 + i * (spread / partials)) * rr(S, 0.94, 1.07) * (1 + i * i * 0.013);
    const d = decay * rr(S, 1 - decayJitter * 0.5, 1 + decayJitter * 0.5) / (1 + i * 0.32);
    const g = gn(S, 0);
    const o = tone(S, type, t, d + 0.02, [[0, f, 'set'], [d, f * 0.995, 'lin']]);
    o.connect(g); g.connect(dest);
    end = Math.max(end, perc(g.gain, t, gain / (1 + i * 0.55), 0.0012, d));
  }
  return end;
}

/**
 * Filtered-noise whoosh. The workhorse behind swings, spell casts and fire.
 * `sweep` is [startHz, peakHz, endHz].
 */
export function whoosh(S, dest, t, {
  dur = 0.26, sweep = [420, 2400, 700], q = 1.6, gain = 0.3, kind = 'pink',
  attack = 0.012, rate = 1, hp = 90,
} = {}) {
  const src = noise(S, kind, t, dur, rate);
  const band = bq(S, 'bandpass', sweep[0], q);
  const high = bq(S, 'highpass', hp, 0.7);
  const g = gn(S, 0);
  src.connect(high); high.connect(band); band.connect(g); g.connect(dest);
  ramp(band.frequency, t, [
    [0, sweep[0], 'set'],
    [dur * 0.42, sweep[1], 'exp'],
    [dur, sweep[2], 'exp'],
  ]);
  const peakT = clamp(Math.max(attack, dur * 0.17), 0.001, dur * 0.85);
  g.gain.setValueAtTime(EPS, t);
  g.gain.linearRampToValueAtTime(gain, t + peakT);
  g.gain.exponentialRampToValueAtTime(EPS, t + dur);
  g.gain.setValueAtTime(0, t + dur + 0.001);
  return t + dur + 0.002;
}

/** Sub-bass thump: a sine dropping in pitch. The weight under every impact. */
export function thump(S, dest, t, { f0 = 110, f1 = 38, dur = 0.24, gain = 0.5, click = 0 } = {}) {
  const g = gn(S, 0);
  const o = tone(S, 'sine', t, dur, [[0, f0, 'set'], [dur * 0.75, f1, 'exp']]);
  o.connect(g); g.connect(dest);
  perc(g.gain, t, gain, 0.004, dur);
  if (click > 0) {
    const cg = gn(S, 0);
    const cs = noise(S, 'white', t, 0.02, 1);
    const cf = bq(S, 'lowpass', 1800, 0.9);
    cs.connect(cf); cf.connect(cg); cg.connect(dest);
    perc(cg.gain, t, click, 0.0006, 0.016);
  }
  return t + dur + 0.002;
}

/** Short bright transient — the "attack" layer that makes a hit feel present. */
export function tick(S, dest, t, { gain = 0.25, dur = 0.016, hp = 2200, q = 0.8, kind = 'white' } = {}) {
  const src = noise(S, kind, t, dur, rr(S, 0.9, 1.15));
  const f = bq(S, 'highpass', hp, q);
  const g = gn(S, 0);
  src.connect(f); f.connect(g); g.connect(dest);
  perc(g.gain, t, gain, 0.0005, dur);
  return t + dur + 0.002;
}

/**
 * Plucked string / harp body: a resonant band excited by a burst, plus two
 * decaying partials. Cheap, and reads as a real pluck.
 */
export function pluck(S, dest, t, { f = 330, dur = 0.9, gain = 0.22, bright = 1, type = 'triangle' } = {}) {
  const g = gn(S, 0);
  const lp = bq(S, 'lowpass', clamp(f * 9 * bright, 300, 12000), 0.9);
  const o1 = tone(S, type, t, dur, [[0, f, 'set'], [dur, f * 0.996, 'lin']]);
  const o2 = tone(S, 'sine', t, dur * 0.55, [[0, f * 2.01, 'set']]);
  const g2 = gn(S, 0);
  o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(dest);
  perc(g.gain, t, gain, 0.003, dur);
  perc(g2.gain, t, 0.32 * bright, 0.0015, dur * 0.4);
  // string excitation noise on the very front
  const ns = noise(S, 'white', t, 0.012, 1);
  const nf = bq(S, 'bandpass', f * 3.2, 2.5);
  const ng = gn(S, 0);
  ns.connect(nf); nf.connect(ng); ng.connect(lp);
  perc(ng.gain, t, gain * 0.5, 0.0004, 0.012);
  return t + dur + 0.002;
}

/**
 * Detuned saw stack through a lowpass — the gothic pad / brass core. `voices`
 * oscillators spread over `detune` cents, each with an independent slow drift.
 */
export function sawStack(S, dest, t, {
  f = 110, voices = 3, detune = 14, dur = 2, a = 0.6, hold = 0.8, r = 1.2,
  gain = 0.12, cutoff = 900, q = 1.4, type = 'sawtooth', drift = 0.35,
} = {}) {
  const g = gn(S, 0);
  const lp = bq(S, 'lowpass', cutoff, q);
  g.connect(lp); lp.connect(dest);
  for (let i = 0; i < voices; i++) {
    const c = (i - (voices - 1) / 2) * detune + rr(S, -3, 3);
    const o = tone(S, type, t, dur, [[0, f, 'set']], c);
    const vg = gn(S, 1 / voices);
    o.connect(vg); vg.connect(g);
    if (drift > 0) lfo(S, o.detune, t, dur, rr(S, 0.13, 0.34), detune * drift, 'sine', i * 120);
  }
  const end = ahr(g.gain, t, gain, a, hold, r);
  // Filter opens slightly as the note swells — motion, not a static drone.
  ramp(lp.frequency, t, [[0, cutoff * 0.72, 'set'], [a + hold * 0.6, cutoff, 'exp'], [dur, cutoff * 0.8, 'exp']]);
  return end;
}
