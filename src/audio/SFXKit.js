/**
 * THE NINTH VIGIL — synthesised SFX library.
 * ---------------------------------------------------------------------------
 * No samples. Every entry is a recipe `(S, o) => endTimeSeconds` built from
 * three layers:
 *
 *   TRANSIENT  2–20 ms  — what makes the hit *present* (click, crack, scuff)
 *   BODY      40–400 ms — what makes it identifiable (resonance, formants, tone)
 *   TAIL     0.1–3 s    — what makes it sit in the room (ring-out, reverb send)
 *
 * Every recipe draws its own variation from `S.rnd`, so two swings are never the
 * same swing: pitch, filter centres, decay times, layer balance and grain
 * offsets all move. Recipes are pure with respect to `S`, which means the whole
 * library can be rendered in an OfflineAudioContext and measured — see
 * `AudioEngine.renderOffline()`.
 *
 * `S.wet` is the reverb send the caller should apply; recipes may overwrite it.
 */

import {
  rr, rpick, semi, clamp, gn, bq, noise, tone, lfo, formants,
  metalRing, whoosh, thump, tick, pluck, sawStack, perc, ahr, ramp,
} from './Nodes.js';

/* ================================================================== *
 * shared building blocks
 * ================================================================== */

/**
 * Run a nested recipe at an offset from the current scope time. Recipes read
 * `S.t`, so composing them is a matter of shifting it and putting it back.
 */
function at(S, dt, fn) {
  const t0 = S.t;
  S.t = t0 + dt;
  let e;
  try { e = fn(); } finally { S.t = t0; }
  return e;
}

/** Wet gouge / squelch used by flesh hits and gore. */
function squelch(S, t, dur, gain) {
  const src = noise(S, 'grit', t, dur, rr(S, 0.55, 0.95));
  const bp = bq(S, 'bandpass', rr(S, 240, 460), rr(S, 1.4, 2.6));
  const lp = bq(S, 'lowpass', rr(S, 900, 1800), 0.8);
  const g = gn(S, 0);
  src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(S.out);
  ramp(bp.frequency, t, [[0, rr(S, 320, 520), 'set'], [dur, rr(S, 130, 230), 'exp']]);
  return perc(g.gain, t, gain, 0.003, dur);
}

/**
 * Voiced creature source: a jittering saw + breath noise through a formant
 * bank. `shift` scales the formants (creature size); `growl` is sub-audio
 * amplitude flutter (a snarl); `rasp` mixes in unvoiced breath.
 */
function creature(S, t, o = {}) {
  const dur = o.dur ?? 0.7;
  const f0 = o.f0 ?? 110;
  const f1 = o.f1 ?? f0 * 0.8;
  const vowel = o.vowel ?? 'growl';
  const shift = o.shift ?? 1;
  const gain = o.gain ?? 0.4;

  const bus = gn(S, 1);
  const post = gn(S, 0);
  const shaper = bq(S, o.postType ?? 'lowpass', o.postHz ?? 3200, o.postQ ?? 0.8);
  formants(S, bus, shaper, vowel, t, dur, shift, o.drift ?? 0.012);
  // a little direct signal keeps the fundamental audible under the formants
  const direct = gn(S, o.direct ?? 0.28);
  bus.connect(direct); direct.connect(shaper);
  shaper.connect(post); post.connect(S.out);

  // voiced larynx: two detuned saws so the pitch beats slightly
  const vg = gn(S, 1 - (o.rasp ?? 0.35));
  const pts = o.pitch ?? [[0, f0 * rr(S, 0.94, 1.06), 'set'], [dur * 0.3, f0 * 1.06, 'exp'], [dur, f1, 'exp']];
  const o1 = tone(S, o.wave ?? 'sawtooth', t, dur, pts);
  const o2 = tone(S, 'square', t, dur, pts, rr(S, -28, 28));
  const o2g = gn(S, 0.42);
  o1.connect(vg); o2.connect(o2g); o2g.connect(vg); vg.connect(bus);
  // jitter: real throats are not steady
  lfo(S, o1.detune, t, dur, rr(S, 5.5, 11), rr(S, 24, 70), 'sine');
  lfo(S, o2.detune, t, dur, rr(S, 3.1, 6.4), rr(S, 30, 90), 'triangle', 60);

  // unvoiced breath
  const ng = gn(S, (o.rasp ?? 0.35) * 1.35);
  const ns = noise(S, o.noiseKind ?? 'pink', t, dur, rr(S, 0.85, 1.2));
  const nf = bq(S, 'bandpass', rr(S, 700, 1500), 0.8);
  ns.connect(nf); nf.connect(ng); ng.connect(bus);

  // amplitude flutter = growl
  if ((o.growl ?? 0) > 0) {
    lfo(S, post.gain, t, dur, o.growlHz ?? rr(S, 14, 26), gain * o.growl, 'sine');
  }
  const a = o.a ?? Math.min(0.09, dur * 0.14);
  const hold = o.hold ?? dur * 0.38;
  const end = ahr(post.gain, t, gain, a, hold, Math.max(0.05, dur - a - hold));

  // sub layer so big things feel big
  if ((o.sub ?? 0) > 0) thump(S, S.out, t + dur * 0.04, { f0: f0 * 0.66, f1: f0 * 0.34, dur: dur * 0.8, gain: o.sub });
  return end;
}

/** Bone rattle: a burst of tuned wooden clicks. */
function rattle(S, t, o = {}) {
  const n = o.count ?? 7;
  const spread = o.spread ?? 0.26;
  let end = t;
  for (let i = 0; i < n; i++) {
    const tt = t + (i / n) * spread + rr(S, -0.012, 0.012);
    const f = rr(S, 320, 1250) * (o.shift ?? 1);
    const d = rr(S, 0.035, 0.11);
    const g = gn(S, 0);
    const src = noise(S, 'white', tt, d, rr(S, 0.8, 1.3));
    const bp = bq(S, 'bandpass', f, rr(S, 6, 14));
    const hp = bq(S, 'highpass', 260, 0.7);
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(S.out);
    end = Math.max(end, perc(g.gain, tt, (o.gain ?? 0.22) * rr(S, 0.5, 1.1), 0.0008, d));
  }
  return end;
}

/** Chime / bell — loot and UI motifs. */
function chime(S, t, f, dur, gain, bright = 1) {
  const g = gn(S, 0);
  const lp = bq(S, 'lowpass', clamp(f * 7 * bright, 800, 15000), 0.9);
  g.connect(lp); lp.connect(S.out);
  const ratios = [1, 2.0, 2.99, 4.21, 5.43];
  for (let i = 0; i < ratios.length; i++) {
    const pg = gn(S, 0);
    const o = tone(S, 'sine', t, dur, [[0, f * ratios[i] * rr(S, 0.997, 1.003), 'set']]);
    o.connect(pg); pg.connect(g);
    perc(pg.gain, t, (1 / (1 + i * 1.5)) * bright, 0.002 + i * 0.001, dur / (1 + i * 0.5));
  }
  return perc(g.gain, t, gain, 0.002, dur);
}

/* ================================================================== *
 * the library
 * ================================================================== */

export const SFX = {

  /* ---------------------------------------------------- melee: the swing */

  /** Blade cutting air. Filtered-noise band swept up then down past the ear. */
  'swing': (S, o = {}) => {
    S.wet = 0.22;
    const heavy = o.heavy ?? 0;
    const speed = clamp(o.speed ?? 1, 0.6, 1.6);
    const dur = (0.20 + heavy * 0.16) / speed * rr(S, 0.9, 1.12);
    const lo = rr(S, 300, 460) * (1 - heavy * 0.3);
    const hi = rr(S, 1900, 3000) * (1 - heavy * 0.28) * speed;
    // A narrow bandpass throws away most of the noise's energy, so the gains here
    // are large by design — calibrated against the offline peak, not by eye.
    let end = whoosh(S, S.out, S.t, {
      dur, sweep: [lo, hi, lo * rr(S, 1.2, 1.7)], q: rr(S, 1.3, 2.2),
      gain: (0.98 + heavy * 0.5), kind: heavy > 0.4 ? 'brown' : 'pink',
      rate: rr(S, 0.9, 1.15), hp: 120,
    });
    // second, tighter band a hair later = the edge, not the flat
    end = Math.max(end, whoosh(S, S.out, S.t + dur * rr(S, 0.10, 0.22), {
      dur: dur * 0.7, sweep: [hi * 0.8, hi * 1.5, hi * 0.5], q: rr(S, 3.5, 6),
      gain: 0.34, kind: 'white', rate: rr(S, 0.95, 1.2), hp: 900,
    }));
    if (heavy > 0.3) {
      end = Math.max(end, thump(S, S.out, S.t + dur * 0.5, {
        f0: rr(S, 90, 130), f1: rr(S, 42, 58), dur: 0.20, gain: 0.10 * heavy,
      }));
    }
    return end;
  },

  /** Arrow / bolt passing the camera. */
  'swing.air': (S, o = {}) => {
    S.wet = 0.18;
    return whoosh(S, S.out, S.t, {
      dur: rr(S, 0.13, 0.2), sweep: [rr(S, 900, 1400), rr(S, 3200, 5200), rr(S, 700, 1100)],
      q: rr(S, 4, 7), gain: 0.46, kind: 'white', hp: 700,
    });
  },

  /* -------------------------------------------------- melee: the contact */

  /** Blade into meat: dull thump + wet gouge + damp tail. No metal at all. */
  'hit.flesh': (S, o = {}) => {
    S.wet = 0.30;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.10 * m, dur: 0.010, hp: rr(S, 700, 1200), kind: 'grit' });
    end = Math.max(end, thump(S, S.out, t, {
      f0: rr(S, 96, 138), f1: rr(S, 40, 55), dur: 0.15 + m * 0.11, gain: 0.27 * m, click: 0.07 * m,
    }));
    end = Math.max(end, squelch(S, t + 0.004, 0.11 + m * 0.09, 0.34 * m));
    // damp low tail — flesh absorbs, it does not ring
    const g = gn(S, 0);
    const src = noise(S, 'brown', t + 0.01, 0.16, rr(S, 0.7, 1.1));
    const lp = bq(S, 'lowpass', rr(S, 380, 620), 1.1);
    src.connect(lp); lp.connect(g); g.connect(S.out);
    end = Math.max(end, perc(g.gain, t + 0.01, 0.15 * m, 0.006, 0.15));
    return end;
  },

  /** Steel on steel: bright crack + inharmonic ring + long metallic tail. */
  'hit.metal': (S, o = {}) => {
    S.wet = 0.42;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.20 * m, dur: 0.012, hp: rr(S, 2600, 4200) });
    end = Math.max(end, metalRing(S, S.out, t, {
      base: rr(S, 1150, 1750), partials: 6, spread: rr(S, 2.2, 3.4),
      decay: rr(S, 0.55, 1.15) * (0.7 + m * 0.6), gain: 0.19 * m, decayJitter: 0.6,
    }));
    // low clank so it has mass
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 180, 250), f1: rr(S, 68, 92), dur: 0.13, gain: 0.16 * m }));
    // grinding scrape as the edges part
    end = Math.max(end, whoosh(S, S.out, t + 0.012, {
      dur: rr(S, 0.09, 0.16), sweep: [rr(S, 2600, 3600), rr(S, 1400, 2000), rr(S, 800, 1200)],
      q: 2.4, gain: 0.075 * m, kind: 'grit', hp: 600,
    }));
    return end;
  },

  /** Weapon into ashlar: sharp crack, short stone resonance, grit spray. */
  'hit.stone': (S, o = {}) => {
    S.wet = 0.38;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.22 * m, dur: 0.008, hp: rr(S, 2200, 3600) });
    // stone body: a couple of high-Q bands, fast decay, no long ring
    for (let i = 0; i < 3; i++) {
      const f = rr(S, 190, 460) * (1 + i * rr(S, 0.9, 1.5));
      const d = rr(S, 0.045, 0.11) / (1 + i * 0.4);
      const g = gn(S, 0);
      const src = noise(S, 'white', t, d, 1);
      const bp = bq(S, 'bandpass', f, rr(S, 7, 16));
      src.connect(bp); bp.connect(g); g.connect(S.out);
      end = Math.max(end, perc(g.gain, t, 0.20 * m / (1 + i * 0.7), 0.0008, d));
    }
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 130, 190), f1: rr(S, 55, 75), dur: 0.10, gain: 0.20 * m }));
    // dust + chips
    const g2 = gn(S, 0);
    const src2 = noise(S, 'grit', t + 0.006, 0.19, rr(S, 1.0, 1.5));
    const hp = bq(S, 'highpass', rr(S, 1000, 1900), 0.7);
    src2.connect(hp); hp.connect(g2); g2.connect(S.out);
    end = Math.max(end, perc(g2.gain, t + 0.006, 0.09 * m, 0.004, 0.18));
    return end;
  },

  /** Splintering wood: crate, barrel, door panel. */
  'hit.wood': (S, o = {}) => {
    S.wet = 0.30;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.16 * m, dur: 0.010, hp: rr(S, 1800, 3000) });
    for (let i = 0; i < 4; i++) {
      const f = rr(S, 170, 700);
      const d = rr(S, 0.05, 0.16);
      const g = gn(S, 0);
      const src = noise(S, 'white', t + i * rr(S, 0.002, 0.014), d, 1);
      const bp = bq(S, 'bandpass', f, rr(S, 4, 11));
      src.connect(bp); bp.connect(g); g.connect(S.out);
      end = Math.max(end, perc(g.gain, t + i * 0.006, 0.17 * m / (1 + i * 0.5), 0.001, d));
    }
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 110, 160), f1: rr(S, 52, 70), dur: 0.12, gain: 0.17 * m }));
    return end;
  },

  /** Pottery / urn shatter. */
  'hit.ceramic': (S, o = {}) => {
    S.wet = 0.40;
    const m = clamp(o.magnitude ?? 0.8, 0.2, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.20 * m, dur: 0.007, hp: 4200 });
    for (let i = 0; i < 9; i++) {
      const tt = t + rr(S, 0, 0.16);
      const f = rr(S, 1400, 5200);
      const d = rr(S, 0.03, 0.13);
      const g = gn(S, 0);
      const o1 = tone(S, 'sine', tt, d, [[0, f, 'set'], [d, f * 0.94, 'exp']]);
      o1.connect(g); g.connect(S.out);
      end = Math.max(end, perc(g.gain, tt, 0.075 * m * rr(S, 0.5, 1.2), 0.0008, d));
    }
    const g2 = gn(S, 0);
    const src = noise(S, 'grit', t, 0.26, 1.4);
    const hp = bq(S, 'highpass', 2200, 0.8);
    src.connect(hp); hp.connect(g2); g2.connect(S.out);
    end = Math.max(end, perc(g2.gain, t, 0.10 * m, 0.003, 0.25));
    return end;
  },

  /** Dry bone break — skeletons taking a hit. */
  'hit.bone': (S, o = {}) => {
    S.wet = 0.34;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    let end = tick(S, S.out, S.t, { gain: 0.17 * m, dur: 0.009, hp: 2600 });
    end = Math.max(end, rattle(S, S.t + 0.004, { count: 6, spread: 0.17, gain: 0.20 * m, shift: rr(S, 0.85, 1.2) }));
    end = Math.max(end, thump(S, S.out, S.t, { f0: rr(S, 150, 210), f1: 62, dur: 0.10, gain: 0.14 * m }));
    return end;
  },

  /** Impact into standing water. */
  'hit.water': (S, o = {}) => {
    S.wet = 0.34;
    const m = clamp(o.magnitude ?? 0.6, 0.15, 1.5);
    const t = S.t;
    // rising resonance = the classic "plip" of a cavity collapsing
    const g = gn(S, 0);
    const bp = bq(S, 'bandpass', 600, 4.5);
    const src = noise(S, 'white', t, 0.13, rr(S, 0.9, 1.3));
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 420, 700), 'set'], [0.09, rr(S, 1500, 2600), 'exp']]);
    let end = perc(g.gain, t, 0.22 * m, 0.002, 0.12);
    const g2 = gn(S, 0);
    const src2 = noise(S, 'white', t, 0.24, 1);
    const lp = bq(S, 'lowpass', rr(S, 1400, 2400), 0.9);
    const hp = bq(S, 'highpass', 300, 0.7);
    src2.connect(hp); hp.connect(lp); lp.connect(g2); g2.connect(S.out);
    end = Math.max(end, perc(g2.gain, t, 0.16 * m, 0.004, 0.22));
    end = Math.max(end, thump(S, S.out, t, { f0: 150, f1: 70, dur: 0.10, gain: 0.10 * m }));
    return end;
  },

  /** Parried / shield-blocked: harder, brighter, shorter, plus a grind. */
  'hit.block': (S, o = {}) => {
    S.wet = 0.44;
    const m = clamp(o.magnitude ?? 0.7, 0.2, 1.5);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.19 * m, dur: 0.010, hp: rr(S, 3400, 5200) });
    end = Math.max(end, metalRing(S, S.out, t, {
      base: rr(S, 1900, 2900), partials: 7, spread: 3.1,
      decay: rr(S, 0.34, 0.7), gain: 0.20 * m, decayJitter: 0.7,
    }));
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 210, 300), f1: rr(S, 78, 105), dur: 0.14, gain: 0.15 * m, click: 0.08 }));
    end = Math.max(end, whoosh(S, S.out, t + 0.014, {
      dur: rr(S, 0.11, 0.2), sweep: [rr(S, 3400, 4600), rr(S, 1700, 2300), rr(S, 900, 1300)],
      q: 2.0, gain: 0.10 * m, kind: 'grit', hp: 700,
    }));
    return end;
  },

  /**
   * Critical strike. Same contact family, but the whole thing is brighter, a
   * sub thump lands underneath it, and a short rising "zing" sells the crunch.
   */
  'hit.crit': (S, o = {}) => {
    S.wet = 0.46;
    const m = clamp(o.magnitude ?? 1, 0.3, 1.6);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.23 * m, dur: 0.014, hp: rr(S, 4000, 6200) });
    // deep sub — the thing that makes a crit feel like a crit
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 82, 108), f1: rr(S, 28, 36), dur: 0.34, gain: 0.33 * m, click: 0.10 }));
    end = Math.max(end, squelch(S, t + 0.004, 0.16, 0.20 * m));
    end = Math.max(end, metalRing(S, S.out, t + 0.004, {
      base: rr(S, 2200, 3300), partials: 5, spread: 3.6, decay: rr(S, 0.5, 0.95), gain: 0.15 * m,
    }));
    // rising zing
    const zg = gn(S, 0);
    const z = tone(S, 'triangle', t, 0.22, [[0, rr(S, 620, 820), 'set'], [0.18, rr(S, 2300, 3200), 'exp']]);
    const zf = bq(S, 'bandpass', 1800, 1.6);
    z.connect(zf); zf.connect(zg); zg.connect(S.out);
    end = Math.max(end, perc(zg.gain, t, 0.10 * m, 0.006, 0.2));
    return end;
  },

  /* --------------------------------------------------------------- ranged */

  /** Bowstring release: string snap + limb thoom + fletching whoosh. */
  'bow.release': (S, o = {}) => {
    S.wet = 0.26;
    const t = S.t;
    // string: extremely resonant band excited by a click, pitch dropping
    const g = gn(S, 0);
    const bp = bq(S, 'bandpass', 190, 16);
    const src = noise(S, 'white', t, 0.16, 1);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 210, 275), 'set'], [0.13, rr(S, 120, 165), 'exp']]);
    let end = perc(g.gain, t, 0.30 * (o.gain ?? 1), 0.0012, 0.15);
    // limbs flexing back
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 130, 175), f1: rr(S, 52, 68), dur: 0.18, gain: 0.20 }));
    // creak of the riser under load, just before release
    const cg = gn(S, 0);
    const cs = noise(S, 'grit', t - 0.0, 0.07, 0.55);
    const cf = bq(S, 'bandpass', rr(S, 800, 1500), 3.5);
    cs.connect(cf); cf.connect(cg); cg.connect(S.out);
    end = Math.max(end, perc(cg.gain, t, 0.09, 0.004, 0.065));
    // arrow away
    end = Math.max(end, whoosh(S, S.out, t + 0.012, {
      dur: 0.17, sweep: [1100, 3600, 900], q: 5, gain: 0.10, kind: 'white', hp: 800,
    }));
    return end;
  },

  /* ------------------------------------------------------------- elements */

  /** Fire cast: airy whoosh + low roar + crackle grain. */
  'cast.fire': (S, o = {}) => {
    S.wet = 0.34;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    const dur = 0.55 * rr(S, 0.9, 1.15) * (0.8 + lvl * 0.2);
    let end = whoosh(S, S.out, t, {
      dur, sweep: [rr(S, 220, 340), rr(S, 1500, 2400), rr(S, 420, 700)],
      q: 1.1, gain: 0.24 * lvl, kind: 'brown', attack: 0.035, hp: 60,
    });
    // roar body
    const g = gn(S, 0);
    const src = noise(S, 'brown', t, dur * 1.2, rr(S, 0.85, 1.2));
    const lp = bq(S, 'lowpass', 900, 1.4);
    src.connect(lp); lp.connect(g); g.connect(S.out);
    ramp(lp.frequency, t, [[0, 380, 'set'], [dur * 0.4, rr(S, 900, 1500), 'exp'], [dur * 1.2, 300, 'exp']]);
    end = Math.max(end, ahr(g.gain, t, 0.24 * lvl, 0.06, dur * 0.4, dur * 0.7));
    // crackle grain
    const cg = gn(S, 0);
    const cs = noise(S, 'crackle', t, dur * 1.3, rr(S, 0.9, 1.4));
    const cf = bq(S, 'bandpass', rr(S, 1800, 3200), 1.1);
    cs.connect(cf); cf.connect(cg); cg.connect(S.out);
    end = Math.max(end, ahr(cg.gain, t, 0.16 * lvl, 0.04, dur * 0.5, dur * 0.6));
    end = Math.max(end, thump(S, S.out, t + 0.02, { f0: 88, f1: 34, dur: 0.3, gain: 0.22 * lvl }));
    return end;
  },

  /** Ice cast: crystalline bell cluster + a rising freeze hiss. */
  'cast.ice': (S, o = {}) => {
    S.wet = 0.5;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    let end = t;
    const root = rr(S, 900, 1250);
    for (let i = 0; i < 5; i++) {
      end = Math.max(end, chime(S, t + i * rr(S, 0.008, 0.045), root * semi(rpick(S, [0, 3, 7, 10, 12, 15])),
        rr(S, 0.5, 1.1), 0.075 * lvl, 1.25));
    }
    // freeze: noise rising through a tightening bandpass
    const g = gn(S, 0);
    const src = noise(S, 'white', t, 0.6, 1);
    const bp = bq(S, 'bandpass', 1200, 2.2);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 900, 1400), 'set'], [0.5, rr(S, 5200, 7800), 'exp']]);
    ramp(bp.Q, t, [[0, 1.4, 'set'], [0.5, 7, 'lin']]);
    end = Math.max(end, ahr(g.gain, t, 0.13 * lvl, 0.14, 0.16, 0.3));
    end = Math.max(end, thump(S, S.out, t, { f0: 150, f1: 46, dur: 0.26, gain: 0.16 * lvl }));
    return end;
  },

  /** Ice shatter: a spray of short high partials. */
  'ice.shatter': (S, o = {}) => {
    S.wet = 0.52;
    const m = clamp(o.magnitude ?? 1, 0.2, 1.6);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.16 * m, dur: 0.008, hp: 5000 });
    const n = 12 + Math.floor(S.rnd() * 6);
    for (let i = 0; i < n; i++) {
      const tt = t + rr(S, 0, 0.22);
      const f = rr(S, 2200, 7000);
      const d = rr(S, 0.03, 0.16);
      const g = gn(S, 0);
      const os = tone(S, 'sine', tt, d, [[0, f, 'set'], [d, f * rr(S, 0.9, 0.99), 'exp']]);
      os.connect(g); g.connect(S.out);
      end = Math.max(end, perc(g.gain, tt, 0.06 * m * rr(S, 0.4, 1.2), 0.0006, d));
    }
    const g2 = gn(S, 0);
    const src = noise(S, 'grit', t, 0.3, 1.6);
    const hp = bq(S, 'highpass', 3200, 0.8);
    src.connect(hp); hp.connect(g2); g2.connect(S.out);
    end = Math.max(end, perc(g2.gain, t, 0.10 * m, 0.003, 0.28));
    return end;
  },

  /** Lightning cast: buzz charge into a broadband crack. */
  'cast.lightning': (S, o = {}) => {
    S.wet = 0.4;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    // charge buzz
    const bg = gn(S, 0);
    const b1 = tone(S, 'square', t, 0.26, [[0, rr(S, 70, 95), 'set'], [0.24, rr(S, 130, 190), 'exp']]);
    const bf = bq(S, 'bandpass', 2200, 1.1);
    b1.connect(bf); bf.connect(bg); bg.connect(S.out);
    lfo(S, bg.gain, t, 0.26, rr(S, 30, 60), 0.05, 'square');
    let end = ahr(bg.gain, t, 0.10 * lvl, 0.1, 0.08, 0.09);
    end = Math.max(end, SFX['lightning.crack'](S, { magnitude: lvl, at: 0.2 }));
    S.wet = 0.44;
    return end;
  },

  /** The crack itself — usable on its own for a strike landing. */
  'lightning.crack': (S, o = {}) => {
    S.wet = 0.46;
    const m = clamp(o.magnitude ?? 1, 0.2, 1.8);
    const t = S.t + (o.at ?? 0);
    // transient: very short, very bright, resonant
    const g = gn(S, 0);
    const src = noise(S, 'white', t, 0.05, 1);
    const hp = bq(S, 'highpass', rr(S, 1800, 3200), 0.9);
    const pk = bq(S, 'peaking', rr(S, 4200, 7200), 1.4, 12);
    src.connect(hp); hp.connect(pk); pk.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, 0.21 * m, 0.0004, 0.045, 'lin');
    // body: fast decaying noise through a falling lowpass = the tearing air
    const g2 = gn(S, 0);
    const src2 = noise(S, 'white', t, 0.45, 1);
    const lp = bq(S, 'lowpass', 6000, 1.2);
    src2.connect(lp); lp.connect(g2); g2.connect(S.out);
    ramp(lp.frequency, t, [[0, rr(S, 6000, 9000), 'set'], [0.4, rr(S, 500, 900), 'exp']]);
    end = Math.max(end, perc(g2.gain, t, 0.15 * m, 0.001, 0.4));
    // electric residue
    const g3 = gn(S, 0);
    const o3 = tone(S, 'sawtooth', t + 0.01, 0.3, [[0, rr(S, 3200, 5200), 'set'], [0.28, rr(S, 900, 1500), 'exp']]);
    const bp3 = bq(S, 'bandpass', 3000, 3.5);
    o3.connect(bp3); bp3.connect(g3); g3.connect(S.out);
    lfo(S, g3.gain, t, 0.3, rr(S, 45, 90), 0.045, 'square');
    end = Math.max(end, perc(g3.gain, t + 0.01, 0.065 * m, 0.002, 0.28));
    // sub thud
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 70, 95), f1: rr(S, 28, 38), dur: 0.42, gain: 0.24 * m }));
    return end;
  },

  /** Arcane / shadow: reverse swell into a ring-modulated bloom. */
  'cast.arcane': (S, o = {}) => {
    S.wet = 0.56;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    const f = rr(S, 150, 230);
    const g = gn(S, 0);
    const lp = bq(S, 'lowpass', 2400, 1.6);
    g.connect(lp); lp.connect(S.out);
    // two close tones beat against each other — instant "unnatural"
    const o1 = tone(S, 'triangle', t, 0.75, [[0, f, 'set'], [0.6, f * semi(7), 'exp']]);
    const o2 = tone(S, 'sine', t, 0.75, [[0, f * semi(1), 'set'], [0.6, f * semi(8.2), 'exp']]);
    const g2 = gn(S, 0.6);
    o1.connect(g); o2.connect(g2); g2.connect(g);
    let end = ahr(g.gain, t, 0.20 * lvl, 0.3, 0.08, 0.36);
    ramp(lp.frequency, t, [[0, 500, 'set'], [0.35, rr(S, 2800, 4200), 'exp'], [0.75, 900, 'exp']]);
    // shimmer on top
    for (let i = 0; i < 4; i++) {
      end = Math.max(end, chime(S, t + 0.25 + i * rr(S, 0.02, 0.08), f * 8 * semi(rpick(S, [0, 3, 7, 10])), rr(S, 0.4, 0.9), 0.05 * lvl, 1.1));
    }
    end = Math.max(end, whoosh(S, S.out, t, { dur: 0.4, sweep: [3000, 700, 300], q: 1.2, gain: 0.09 * lvl, kind: 'pink', attack: 0.25, hp: 200 }));
    end = Math.max(end, thump(S, S.out, t + 0.3, { f0: 90, f1: 34, dur: 0.4, gain: 0.24 * lvl }));
    return end;
  },

  /** Necrotic: a rotten, beating growl with a minor-second bite. */
  'cast.necrotic': (S, o = {}) => {
    S.wet = 0.5;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    let end = creature(S, t, {
      dur: 0.8, f0: rr(S, 62, 82), f1: rr(S, 44, 58), vowel: 'throat', shift: 0.85,
      gain: 0.24 * lvl, rasp: 0.45, growl: 0.35, growlHz: rr(S, 8, 14), sub: 0.2, postHz: 1600,
    });
    // the bite: a beating pair a semitone apart
    const f = rr(S, 210, 280);
    const g = gn(S, 0);
    const o1 = tone(S, 'sawtooth', t, 0.7, [[0, f, 'set'], [0.65, f * 0.72, 'exp']]);
    const o2 = tone(S, 'sawtooth', t, 0.7, [[0, f * semi(1), 'set'], [0.65, f * 0.72 * semi(1), 'exp']]);
    const lp = bq(S, 'lowpass', 1400, 2.2);
    o1.connect(g); o2.connect(g); g.connect(lp); lp.connect(S.out);
    end = Math.max(end, ahr(g.gain, t, 0.10 * lvl, 0.12, 0.2, 0.4));
    end = Math.max(end, whoosh(S, S.out, t, { dur: 0.5, sweep: [900, 320, 180], q: 1.4, gain: 0.10 * lvl, kind: 'brown', attack: 0.2, hp: 60 }));
    return end;
  },

  /** Holy: a bell and a lifted choir chord. Rare, and it should feel rare. */
  'cast.holy': (S, o = {}) => {
    S.wet = 0.6;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    const root = rr(S, 300, 380);
    let end = chime(S, t, root, 2.2, 0.16 * lvl, 1.2);
    for (const iv of [0, 7, 12, 16]) {
      end = Math.max(end, sawStack(S, S.out, t + 0.04, {
        f: root * 0.5 * semi(iv), voices: 3, detune: 9, dur: 1.9, a: 0.35, hold: 0.5, r: 1.0,
        gain: 0.045 * lvl, cutoff: 2200, type: 'triangle',
      }));
    }
    end = Math.max(end, whoosh(S, S.out, t, { dur: 0.6, sweep: [2600, 5200, 1800], q: 1.1, gain: 0.06 * lvl, kind: 'white', attack: 0.3, hp: 1200 }));
    return end;
  },

  /** Poison / plague — hissing, wet, unpleasant. */
  'cast.poison': (S, o = {}) => {
    S.wet = 0.42;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    const g = gn(S, 0);
    const src = noise(S, 'grit', t, 0.8, rr(S, 0.7, 1.1));
    const bank = gn(S, 1);
    src.connect(bank);
    formants(S, bank, g, 'hiss', t, 0.8, rr(S, 0.85, 1.15), 0.03);
    g.connect(S.out);
    let end = ahr(g.gain, t, 0.20 * lvl, 0.12, 0.28, 0.42);
    end = Math.max(end, squelch(S, t + 0.06, 0.5, 0.14 * lvl));
    end = Math.max(end, thump(S, S.out, t, { f0: 96, f1: 40, dur: 0.3, gain: 0.16 * lvl }));
    return end;
  },

  /** Generic physical ability (dash, shout, slam wind-up). */
  'cast.physical': (S, o = {}) => {
    S.wet = 0.24;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    let end = whoosh(S, S.out, S.t, {
      dur: 0.3, sweep: [rr(S, 260, 380), rr(S, 1300, 2000), rr(S, 300, 500)],
      q: 1.3, gain: 0.20 * lvl, kind: 'brown', hp: 80,
    });
    end = Math.max(end, thump(S, S.out, S.t + 0.02, { f0: 100, f1: 38, dur: 0.26, gain: 0.24 * lvl, click: 0.08 }));
    return end;
  },

  /** War cry / shout — a human roar with a shockwave under it. */
  'shout': (S, o = {}) => {
    const t = S.t;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    let end = creature(S, t, {
      dur: rr(S, 0.7, 1.0), f0: rr(S, 112, 148), f1: rr(S, 74, 96), vowel: 'ah',
      shift: rr(S, 0.96, 1.06), gain: 0.34 * lvl, rasp: 0.34, direct: 0.24, postHz: 3600,
      a: 0.03, pitch: [[0, rr(S, 120, 158), 'set'], [0.3, rr(S, 150, 195), 'exp'], [0.95, rr(S, 88, 112), 'exp']],
    });
    end = Math.max(end, whoosh(S, S.out, t + 0.04, {
      dur: 0.55, sweep: [240, 900, 200], q: 1.1, gain: 0.5 * lvl, kind: 'brown', attack: 0.06, hp: 45,
    }));
    end = Math.max(end, thump(S, S.out, t + 0.05, { f0: 84, f1: 30, dur: 0.45, gain: 0.26 * lvl }));
    S.wet = 0.5;
    return end;
  },

  /** Big rolling fire whoosh — hellfire, immolation, a lit brazier catching. */
  'fire.whoosh': (S, o = {}) => {
    S.wet = 0.38;
    const lvl = clamp(o.level ?? 1, 0.4, 2);
    const t = S.t;
    const dur = rr(S, 0.7, 1.05);
    let end = whoosh(S, S.out, t, {
      dur, sweep: [rr(S, 180, 260), rr(S, 1300, 1900), rr(S, 300, 460)],
      q: 0.9, gain: 0.26 * lvl, kind: 'brown', attack: 0.09, hp: 45,
    });
    const cg = gn(S, 0);
    const cs = noise(S, 'crackle', t, dur * 1.4, rr(S, 0.8, 1.3));
    const cf = bq(S, 'bandpass', rr(S, 1500, 2800), 1.0);
    cs.connect(cf); cf.connect(cg); cg.connect(S.out);
    end = Math.max(end, ahr(cg.gain, t, 0.17 * lvl, 0.1, dur * 0.5, dur * 0.7));
    end = Math.max(end, thump(S, S.out, t, { f0: 78, f1: 30, dur: 0.5, gain: 0.28 * lvl }));
    return end;
  },

  /** Ground telegraph charging up under an enemy attack. */
  'telegraph': (S, o = {}) => {
    S.wet = 0.5;
    const dur = clamp(o.dur ?? 0.9, 0.25, 3);
    const t = S.t;
    const g = gn(S, 0);
    const o1 = tone(S, 'sawtooth', t, dur, [[0, rr(S, 55, 75), 'set'], [dur, rr(S, 150, 210), 'exp']]);
    const o2 = tone(S, 'sine', t, dur, [[0, rr(S, 110, 150), 'set'], [dur, rr(S, 300, 420), 'exp']]);
    const g2 = gn(S, 0.4);
    const lp = bq(S, 'lowpass', 800, 3.2);
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(S.out);
    ramp(lp.frequency, t, [[0, 300, 'set'], [dur, rr(S, 1800, 2800), 'exp']]);
    lfo(S, g.gain, t, dur, rr(S, 5, 9), 0.03, 'sine');
    let end = ahr(g.gain, t, 0.16, dur * 0.85, 0.02, 0.12);
    const ng = gn(S, 0);
    const ns = noise(S, 'brown', t, dur, 1);
    const nf = bq(S, 'bandpass', 400, 1.4);
    ns.connect(nf); nf.connect(ng); ng.connect(S.out);
    ramp(nf.frequency, t, [[0, 260, 'set'], [dur, 1400, 'exp']]);
    end = Math.max(end, ahr(ng.gain, t, 0.09, dur * 0.85, 0.02, 0.12));
    return end;
  },

  /* ---------------------------------------------------------- footsteps */

  'step.stone': (S, o = {}) => {
    S.wet = 0.3;
    const m = clamp(o.magnitude ?? 0.6, 0.1, 1.6);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.15 * m, dur: 0.009, hp: rr(S, 2200, 4000), kind: 'grit' });
    const g = gn(S, 0);
    const src = noise(S, 'white', t, 0.075, 1);
    const bp = bq(S, 'bandpass', rr(S, 150, 260), rr(S, 4, 8));
    src.connect(bp); bp.connect(g); g.connect(S.out);
    end = Math.max(end, perc(g.gain, t, 0.34 * m, 0.0012, 0.07));
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 90, 130), f1: rr(S, 48, 62), dur: 0.075, gain: 0.22 * m }));
    // scuff of the sole leaving the slab
    const sg = gn(S, 0);
    const ss = noise(S, 'grit', t + rr(S, 0.01, 0.03), 0.06, rr(S, 1.1, 1.6));
    const sf = bq(S, 'highpass', rr(S, 2400, 4200), 0.7);
    ss.connect(sf); sf.connect(sg); sg.connect(S.out);
    end = Math.max(end, perc(sg.gain, t + 0.02, 0.09 * m, 0.004, 0.055));
    return end;
  },

  'step.dirt': (S, o = {}) => {
    S.wet = 0.18;
    const m = clamp(o.magnitude ?? 0.6, 0.1, 1.6);
    const t = S.t;
    const g = gn(S, 0);
    const src = noise(S, 'grit', t, 0.11, rr(S, 0.7, 1.1));
    const lp = bq(S, 'lowpass', rr(S, 900, 1600), 0.9);
    const hp = bq(S, 'highpass', 180, 0.7);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, 0.36 * m, 0.004, 0.10);
    end = Math.max(end, thump(S, S.out, t, { f0: rr(S, 76, 104), f1: rr(S, 40, 52), dur: 0.09, gain: 0.24 * m }));
    const gg = gn(S, 0);
    const gs = noise(S, 'grit', t + rr(S, 0.012, 0.035), 0.09, rr(S, 1.2, 1.9));
    const gf = bq(S, 'bandpass', rr(S, 2200, 4200), 0.9);
    gs.connect(gf); gf.connect(gg); gg.connect(S.out);
    end = Math.max(end, perc(gg.gain, t + 0.02, 0.12 * m, 0.005, 0.08));
    return end;
  },

  'step.grass': (S, o = {}) => {
    S.wet = 0.14;
    const m = clamp(o.magnitude ?? 0.6, 0.1, 1.6);
    const t = S.t;
    const g = gn(S, 0);
    const src = noise(S, 'grit', t, 0.13, rr(S, 1.2, 1.8));
    const bp = bq(S, 'bandpass', rr(S, 2600, 4600), 1.1);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, 0.30 * m, 0.006, 0.12);
    end = Math.max(end, thump(S, S.out, t, { f0: 70, f1: 40, dur: 0.07, gain: 0.14 * m }));
    return end;
  },

  'step.water': (S, o = {}) => {
    S.wet = 0.3;
    const m = clamp(o.magnitude ?? 0.6, 0.1, 1.6);
    const t = S.t;
    // splash body
    const g = gn(S, 0);
    const src = noise(S, 'white', t, 0.2, rr(S, 0.9, 1.25));
    const bp = bq(S, 'bandpass', 1400, 1.3);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 700, 1100), 'set'], [0.16, rr(S, 2600, 4200), 'exp']]);
    let end = perc(g.gain, t, 0.36 * m, 0.0025, 0.18);
    // cavity plip
    const pg = gn(S, 0);
    const ps = noise(S, 'white', t + rr(S, 0.008, 0.03), 0.1, 1);
    const pf = bq(S, 'bandpass', 800, 12);
    ps.connect(pf); pf.connect(pg); pg.connect(S.out);
    ramp(pf.frequency, t, [[0, rr(S, 500, 800), 'set'], [0.09, rr(S, 1500, 2400), 'exp']]);
    end = Math.max(end, perc(pg.gain, t + 0.014, 0.20 * m, 0.0015, 0.09));
    end = Math.max(end, thump(S, S.out, t, { f0: 120, f1: 58, dur: 0.09, gain: 0.17 * m }));
    return end;
  },

  'step.metal': (S, o = {}) => {
    S.wet = 0.4;
    const m = clamp(o.magnitude ?? 0.6, 0.1, 1.6);
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.13 * m, dur: 0.008, hp: 3200 });
    end = Math.max(end, metalRing(S, S.out, t, {
      base: rr(S, 900, 1500), partials: 4, spread: 2.8, decay: rr(S, 0.22, 0.45), gain: 0.10 * m,
    }));
    end = Math.max(end, thump(S, S.out, t, { f0: 150, f1: 62, dur: 0.09, gain: 0.12 * m }));
    return end;
  },

  /** Heavy body / ragdoll hitting the floor. */
  'thud': (S, o = {}) => {
    S.wet = 0.36;
    const m = clamp(o.magnitude ?? 0.7, 0.15, 2);
    const t = S.t;
    let end = thump(S, S.out, t, { f0: rr(S, 66, 94) / (0.7 + m * 0.4), f1: rr(S, 26, 36), dur: 0.28 + m * 0.16, gain: 0.42 * m, click: 0.08 * m });
    end = Math.max(end, squelch(S, t + 0.004, 0.14, 0.13 * m));
    const g = gn(S, 0);
    const src = noise(S, 'brown', t, 0.22, rr(S, 0.7, 1.1));
    const lp = bq(S, 'lowpass', rr(S, 300, 560), 1.2);
    src.connect(lp); lp.connect(g); g.connect(S.out);
    end = Math.max(end, perc(g.gain, t, 0.20 * m, 0.005, 0.2));
    // gear rattling as it lands
    end = Math.max(end, rattle(S, t + rr(S, 0.02, 0.06), { count: 4, spread: 0.18, gain: 0.07 * m, shift: 1.6 }));
    return end;
  },

  /* ----------------------------------------------------- vocalisations */

  'voc.skeleton': (S, o = {}) => {
    S.wet = 0.5;
    const t = S.t;
    let end = rattle(S, t, { count: 9, spread: rr(S, 0.22, 0.38), gain: 0.34, shift: rr(S, 0.9, 1.15) });
    // dry throat hiss through bone formants
    const g = gn(S, 0);
    const bank = gn(S, 1);
    const src = noise(S, 'white', t, 0.5, rr(S, 0.9, 1.2));
    src.connect(bank);
    formants(S, bank, g, 'bone', t, 0.5, rr(S, 0.9, 1.1), 0.02);
    g.connect(S.out);
    end = Math.max(end, ahr(g.gain, t, 0.21, 0.05, 0.16, 0.28));
    end = Math.max(end, creature(S, t + 0.03, {
      dur: 0.42, f0: rr(S, 92, 120), f1: rr(S, 70, 88), vowel: 'ee', shift: 1.15,
      gain: 0.17, rasp: 0.7, direct: 0.12, postHz: 4200,
    }));
    return end;
  },

  'voc.ghoul': (S, o = {}) => {
    S.wet = 0.48;
    return creature(S, S.t, {
      dur: rr(S, 0.55, 0.85), f0: rr(S, 78, 112), f1: rr(S, 56, 76), vowel: 'growl',
      shift: rr(S, 0.92, 1.12), gain: 0.32, rasp: 0.5, growl: 0.28, growlHz: rr(S, 11, 19),
      sub: 0.14, postHz: 2400, noiseKind: 'grit',
    });
  },

  'voc.cultist': (S, o = {}) => {
    S.wet = 0.62;
    const t = S.t;
    // whispered incantation: voiced 'uh' with a lot of breath, plus a hiss tail
    let end = creature(S, t, {
      dur: rr(S, 0.8, 1.15), f0: rr(S, 118, 158), f1: rr(S, 96, 128), vowel: 'uh',
      shift: rr(S, 0.95, 1.08), gain: 0.34, rasp: 0.62, direct: 0.16, postHz: 3000,
      pitch: [[0, rr(S, 130, 160), 'set'], [0.5, rr(S, 108, 128), 'exp'], [1.1, rr(S, 92, 108), 'exp']],
    });
    const g = gn(S, 0);
    const bank = gn(S, 1);
    const src = noise(S, 'pink', t + 0.1, 0.7, 1);
    src.connect(bank);
    formants(S, bank, g, 'hiss', t, 0.7, 1, 0.02);
    g.connect(S.out);
    end = Math.max(end, ahr(g.gain, t + 0.1, 0.13, 0.12, 0.2, 0.34));
    return end;
  },

  'voc.hellhound': (S, o = {}) => {
    S.wet = 0.44;
    const t = S.t;
    let end = creature(S, t, {
      dur: rr(S, 0.45, 0.7), f0: rr(S, 128, 172), f1: rr(S, 96, 130), vowel: 'growl',
      shift: rr(S, 1.15, 1.4), gain: 0.36, rasp: 0.42, growl: 0.5, growlHz: rr(S, 20, 34),
      postHz: 3400, noiseKind: 'grit',
    });
    // snap: teeth closing
    if (S.rnd() < 0.55) {
      end = Math.max(end, tick(S, S.out, t + rr(S, 0.25, 0.5), { gain: 0.16, dur: 0.012, hp: 2600, kind: 'white' }));
    }
    return end;
  },

  'voc.brute': (S, o = {}) => {
    S.wet = 0.55;
    const t = S.t;
    let end = creature(S, t, {
      dur: rr(S, 1.0, 1.5), f0: rr(S, 52, 72), f1: rr(S, 38, 52), vowel: 'throat',
      shift: rr(S, 0.66, 0.82), gain: 0.36, rasp: 0.38, growl: 0.22, growlHz: rr(S, 7, 13),
      sub: 0.34, postHz: 1900, noiseKind: 'brown',
      pitch: [[0, rr(S, 48, 62), 'set'], [0.35, rr(S, 74, 92), 'exp'], [1.4, rr(S, 40, 52), 'exp']],
    });
    // chest resonance
    end = Math.max(end, thump(S, S.out, t + 0.1, { f0: rr(S, 60, 78), f1: rr(S, 26, 34), dur: 0.9, gain: 0.24 }));
    return end;
  },

  'voc.wraith': (S, o = {}) => {
    S.wet = 0.72;
    const t = S.t;
    const dur = rr(S, 0.9, 1.4);
    // rising shriek
    let end = creature(S, t, {
      dur, f0: rr(S, 300, 420), f1: rr(S, 760, 1100), vowel: 'shriek', shift: rr(S, 1.0, 1.25),
      gain: 0.31, rasp: 0.45, direct: 0.2, postType: 'highpass', postHz: 420, postQ: 0.7,
      wave: 'sawtooth',
      pitch: [[0, rr(S, 320, 420), 'set'], [dur * 0.7, rr(S, 900, 1350), 'exp'], [dur, rr(S, 700, 1000), 'exp']],
      drift: 0.03,
    });
    // airy body — the thing has no lungs
    const g = gn(S, 0);
    const src = noise(S, 'white', t, dur, rr(S, 0.9, 1.2));
    const bp = bq(S, 'bandpass', 2200, 1.4);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 1200, 1900), 'set'], [dur * 0.7, rr(S, 3800, 5600), 'exp'], [dur, 2200, 'exp']]);
    end = Math.max(end, ahr(g.gain, t, 0.19, dur * 0.35, dur * 0.2, dur * 0.5));
    // shimmer partials
    for (let i = 0; i < 3; i++) {
      end = Math.max(end, chime(S, t + rr(S, 0.1, 0.5), rr(S, 2400, 4800), rr(S, 0.5, 1.1), 0.035, 1.3));
    }
    return end;
  },

  /** The hero: a human grunt of effort or pain, not a monster. */
  'voc.hero': (S, o = {}) => {
    S.wet = 0.36;
    const pain = clamp(o.pain ?? 0.5, 0, 1);
    const dur = rr(S, 0.26, 0.46) + pain * 0.2;
    return creature(S, S.t, {
      dur, f0: rr(S, 108, 138), f1: rr(S, 82, 104), vowel: pain > 0.6 ? 'ah' : 'uh',
      shift: rr(S, 0.97, 1.06), gain: 0.27 + pain * 0.18, rasp: 0.3 + pain * 0.2,
      direct: 0.22, postHz: 3200, a: 0.02, hold: dur * 0.3,
      pitch: [[0, rr(S, 118, 152), 'set'], [dur * 0.35, rr(S, 128, 168), 'exp'], [dur, rr(S, 84, 104), 'exp']],
    });
  },

  'voc.boss': (S, o = {}) => {
    S.wet = 0.8;
    const t = S.t;
    const dur = rr(S, 1.5, 2.2);
    let end = creature(S, t, {
      dur, f0: rr(S, 36, 50), f1: rr(S, 26, 36), vowel: 'throat', shift: rr(S, 0.5, 0.62),
      gain: 0.40, rasp: 0.34, growl: 0.24, growlHz: rr(S, 5, 9), sub: 0.42, postHz: 1500,
      noiseKind: 'brown',
      pitch: [[0, rr(S, 32, 44), 'set'], [dur * 0.3, rr(S, 56, 74), 'exp'], [dur, rr(S, 28, 38), 'exp']],
    });
    // a second voice a fifth up, detuned — two throats, one thing
    end = Math.max(end, creature(S, t + rr(S, 0.02, 0.09), {
      dur: dur * 0.85, f0: rr(S, 62, 84), f1: rr(S, 44, 58), vowel: 'growl', shift: rr(S, 0.7, 0.86),
      gain: 0.18, rasp: 0.5, growl: 0.3, growlHz: rr(S, 13, 21), postHz: 2200,
    }));
    // iron dragging under the roar
    end = Math.max(end, metalRing(S, S.out, t + rr(S, 0.3, 0.8), {
      base: rr(S, 320, 520), partials: 5, spread: 2.6, decay: rr(S, 1.2, 2.2), gain: 0.09, type: 'triangle',
    }));
    end = Math.max(end, thump(S, S.out, t, { f0: 52, f1: 22, dur: 1.6, gain: 0.34 }));
    return end;
  },

  /* -------------------------------------------------------------- death */

  'death.generic': (S, o = {}) => {
    const t = S.t;
    const arch = o.archetype ?? 'ghoul';
    const shift = o.shift ?? 1;
    // the vocalisation, but falling and losing support
    let end = creature(S, t, {
      dur: rr(S, 0.8, 1.25), f0: rr(S, 84, 118) * shift, f1: rr(S, 34, 48) * shift,
      vowel: arch === 'wraith' ? 'shriek' : 'throat', shift: shift * (arch === 'brute' ? 0.7 : 1),
      gain: 0.28, rasp: 0.55, growl: 0.2, growlHz: 9, sub: 0.2, postHz: 2200,
      pitch: [[0, rr(S, 120, 165) * shift, 'set'], [0.25, rr(S, 96, 128) * shift, 'exp'], [1.2, rr(S, 32, 48) * shift, 'exp']],
    });
    // the body arrives after the voice goes
    end = Math.max(end, at(S, rr(S, 0.42, 0.72), () => SFX['thud'](S, { magnitude: 0.55 * (o.mass ?? 1) })));
    if (arch === 'skeleton') end = Math.max(end, rattle(S, t + 0.55, { count: 12, spread: 0.6, gain: 0.17 }));
    S.wet = 0.5;
    return end;
  },

  'death.boss': (S, o = {}) => {
    const t = S.t;
    let end = SFX['voc.boss'](S, {});
    end = Math.max(end, at(S, 1.35, () => SFX['thud'](S, { magnitude: 1.8 })));
    // the room answering
    end = Math.max(end, whoosh(S, S.out, t + 0.9, { dur: 1.6, sweep: [700, 180, 70], q: 1.2, gain: 0.16, kind: 'brown', attack: 0.5, hp: 30 }));
    end = Math.max(end, metalRing(S, S.out, t + 1.1, { base: 210, partials: 6, spread: 2.2, decay: 2.6, gain: 0.10, type: 'triangle' }));
    S.wet = 0.85;
    return end;
  },

  /* --------------------------------------------------------------- loot */

  'loot.common': (S, o = {}) => {
    S.wet = 0.34;
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.10, dur: 0.008, hp: 2600 });
    end = Math.max(end, metalRing(S, S.out, t, { base: rr(S, 700, 1100), partials: 3, spread: 2.2, decay: rr(S, 0.14, 0.3), gain: 0.10 }));
    end = Math.max(end, thump(S, S.out, t, { f0: 140, f1: 62, dur: 0.10, gain: 0.10 }));
    if (S.rnd() < 0.6) end = Math.max(end, metalRing(S, S.out, t + rr(S, 0.05, 0.13), { base: rr(S, 800, 1300), partials: 2, decay: 0.2, gain: 0.06 }));
    return end;
  },

  'loot.gold': (S, o = {}) => {
    S.wet = 0.36;
    const t = S.t;
    let end = t;
    const n = 5 + Math.floor(S.rnd() * 5);
    for (let i = 0; i < n; i++) {
      const tt = t + rr(S, 0, 0.22);
      end = Math.max(end, metalRing(S, S.out, tt, {
        base: rr(S, 1600, 3400), partials: 3, spread: 2.6, decay: rr(S, 0.1, 0.3), gain: 0.075,
      }));
    }
    end = Math.max(end, thump(S, S.out, t, { f0: 130, f1: 58, dur: 0.13, gain: 0.11 }));
    return end;
  },

  'loot.magic': (S, o = {}) => {
    S.wet = 0.48;
    const t = S.t;
    const root = rr(S, 620, 720);
    let end = chime(S, t, root, 0.9, 0.13, 1.15);
    end = Math.max(end, chime(S, t + 0.075, root * semi(7), 1.1, 0.10, 1.2));
    end = Math.max(end, tick(S, S.out, t, { gain: 0.07, dur: 0.008, hp: 4200 }));
    end = Math.max(end, thump(S, S.out, t, { f0: 120, f1: 52, dur: 0.14, gain: 0.10 }));
    return end;
  },

  'loot.rare': (S, o = {}) => {
    S.wet = 0.52;
    const t = S.t;
    const root = rr(S, 560, 640);
    let end = t;
    const arp = [0, 4, 7];
    for (let i = 0; i < arp.length; i++) {
      end = Math.max(end, chime(S, t + i * 0.075, root * semi(arp[i]), 1.2 - i * 0.1, 0.115, 1.2));
    }
    end = Math.max(end, thump(S, S.out, t, { f0: 110, f1: 46, dur: 0.2, gain: 0.14 }));
    end = Math.max(end, whoosh(S, S.out, t, { dur: 0.4, sweep: [2400, 5600, 3000], q: 1.2, gain: 0.05, kind: 'white', attack: 0.2, hp: 1600 }));
    return end;
  },

  /**
   * Legendary drop. This is the one sound in the game that must stop a player
   * mid-swing, so it gets its own motif: a low sub bloom, a rising choir swell,
   * and a four-note bell figure over a perfect fifth drone.
   */
  'loot.legendary': (S, o = {}) => {
    S.wet = 0.68;
    const t = S.t;
    const root = 293.6648; // D4
    let end = thump(S, S.out, t, { f0: 74, f1: 36.7, dur: 1.5, gain: 0.44, click: 0.10 });
    // drone fifth underneath
    end = Math.max(end, sawStack(S, S.out, t, {
      f: 73.416, voices: 4, detune: 11, dur: 2.6, a: 0.08, hold: 1.1, r: 1.4, gain: 0.10, cutoff: 900, type: 'sawtooth',
    }));
    end = Math.max(end, sawStack(S, S.out, t + 0.02, {
      f: 110.0, voices: 3, detune: 9, dur: 2.5, a: 0.14, hold: 1.0, r: 1.3, gain: 0.075, cutoff: 1400, type: 'triangle',
    }));
    // choir swell
    for (const iv of [0, 7, 12]) {
      end = Math.max(end, sawStack(S, S.out, t + 0.12, {
        f: root * 0.5 * semi(iv), voices: 4, detune: 15, dur: 2.3, a: 0.55, hold: 0.5, r: 1.2,
        gain: 0.05, cutoff: 2000, type: 'triangle', drift: 0.5,
      }));
    }
    // the motif — D, A, F, D an octave up. Modal, not major: gothic, not heroic.
    const motif = [0, 7, 3, 12];
    for (let i = 0; i < motif.length; i++) {
      const tt = t + 0.10 + i * 0.155;
      end = Math.max(end, chime(S, tt, root * semi(motif[i]), 1.9 - i * 0.15, 0.135, 1.3));
      end = Math.max(end, pluck(S, S.out, tt + 0.004, { f: root * semi(motif[i]) * 2, dur: 1.0, gain: 0.055, bright: 1.4 }));
    }
    // shimmer dust
    for (let i = 0; i < 7; i++) {
      end = Math.max(end, chime(S, t + rr(S, 0.3, 1.4), root * 4 * semi(rpick(S, [0, 3, 7, 10, 12, 14])), rr(S, 0.5, 1.2), 0.028, 1.4));
    }
    end = Math.max(end, whoosh(S, S.out, t, { dur: 0.9, sweep: [1800, 6200, 2600], q: 1.0, gain: 0.06, kind: 'white', attack: 0.5, hp: 1400 }));
    return end;
  },

  /** Unique / mythic — the legendary motif, darker and lower. */
  'loot.unique': (S, o = {}) => {
    const t = S.t;
    let end = SFX['loot.legendary'](S, o);
    end = Math.max(end, creature(S, t + 0.25, {
      dur: 1.4, f0: 44, f1: 32, vowel: 'throat', shift: 0.55, gain: 0.14, rasp: 0.4, sub: 0.2, postHz: 1100,
    }));
    S.wet = 0.7;
    return end;
  },

  'loot.pickup': (S, o = {}) => {
    S.wet = 0.26;
    const t = S.t;
    // leather + a small chime
    const g = gn(S, 0);
    const src = noise(S, 'grit', t, 0.1, rr(S, 1.1, 1.6));
    const bp = bq(S, 'bandpass', rr(S, 1600, 2800), 1.2);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, 0.11, 0.006, 0.09);
    end = Math.max(end, chime(S, t + 0.02, rr(S, 1100, 1500), 0.4, 0.06, 1.2));
    end = Math.max(end, thump(S, S.out, t, { f0: 150, f1: 70, dur: 0.08, gain: 0.07 }));
    return end;
  },

  /* ------------------------------------------------------------------ UI */

  'ui.click': (S, o = {}) => {
    S.wet = 0.12;
    const t = S.t;
    let end = tick(S, S.out, t, { gain: 0.16, dur: 0.006, hp: rr(S, 2800, 4200) });
    end = Math.max(end, metalRing(S, S.out, t, { base: rr(S, 1500, 1900), partials: 3, spread: 2.4, decay: rr(S, 0.09, 0.18), gain: 0.09 }));
    end = Math.max(end, thump(S, S.out, t, { f0: 190, f1: 88, dur: 0.07, gain: 0.07 }));
    return end;
  },

  'ui.hover': (S, o = {}) => {
    S.wet = 0.10;
    const t = S.t;
    const g = gn(S, 0);
    const os = tone(S, 'sine', t, 0.05, [[0, rr(S, 2100, 2600), 'set'], [0.045, rr(S, 2600, 3200), 'exp']]);
    os.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, 0.055, 0.002, 0.045);
    end = Math.max(end, tick(S, S.out, t, { gain: 0.035, dur: 0.004, hp: 5200 }));
    return end;
  },

  'ui.toast': (S, o = {}) => {
    S.wet = 0.3;
    const t = S.t;
    const tier = o.tier ?? 'info';
    const root = tier === 'danger' ? rr(S, 210, 240) : tier === 'boss' ? rr(S, 150, 175) : rr(S, 520, 600);
    let end = chime(S, t, root, tier === 'info' ? 0.5 : 1.4, tier === 'info' ? 0.075 : 0.12, tier === 'info' ? 1.2 : 0.8);
    if (tier === 'danger' || tier === 'boss') {
      end = Math.max(end, chime(S, t + 0.06, root * semi(1), 1.2, 0.07, 0.7));
      end = Math.max(end, thump(S, S.out, t, { f0: 90, f1: 34, dur: 0.5, gain: 0.24 }));
      end = Math.max(end, whoosh(S, S.out, t, { dur: 0.7, sweep: [900, 300, 140], q: 1.3, gain: 0.09, kind: 'brown', attack: 0.3, hp: 40 }));
    }
    return end;
  },

  'ui.error': (S, o = {}) => {
    S.wet = 0.18;
    const t = S.t;
    let end = chime(S, t, 220, 0.35, 0.09, 0.6);
    end = Math.max(end, chime(S, t + 0.055, 207.65, 0.4, 0.085, 0.6));
    return end;
  },

  /** Level-up fanfare: modal ascent, choir swell, sub bloom, bell shimmer. */
  'levelup': (S, o = {}) => {
    S.wet = 0.62;
    const t = S.t;
    const root = 146.832; // D3
    let end = thump(S, S.out, t, { f0: 73.4, f1: 36.7, dur: 1.8, gain: 0.4 });
    const asc = [0, 3, 7, 10, 12];
    for (let i = 0; i < asc.length; i++) {
      const tt = t + i * 0.13;
      end = Math.max(end, chime(S, tt, root * 2 * semi(asc[i]), 1.5 - i * 0.12, 0.11, 1.3));
      end = Math.max(end, pluck(S, S.out, tt, { f: root * semi(asc[i]), dur: 1.1, gain: 0.06, bright: 1.3 }));
    }
    for (const iv of [0, 7, 15]) {
      end = Math.max(end, sawStack(S, S.out, t + 0.05, {
        f: root * semi(iv), voices: 4, detune: 14, dur: 2.6, a: 0.6, hold: 0.7, r: 1.3,
        gain: 0.055, cutoff: 2400, type: 'triangle', drift: 0.5,
      }));
    }
    end = Math.max(end, whoosh(S, S.out, t, { dur: 1.1, sweep: [1400, 6600, 3000], q: 1.0, gain: 0.07, kind: 'white', attack: 0.7, hp: 1200 }));
    for (let i = 0; i < 9; i++) {
      end = Math.max(end, chime(S, t + rr(S, 0.35, 1.7), root * 8 * semi(rpick(S, [0, 3, 7, 10, 12])), rr(S, 0.4, 1.0), 0.022, 1.4));
    }
    return end;
  },

  /** Potion: cork, glass, three gulps, a glass set-down. */
  'potion': (S, o = {}) => {
    S.wet = 0.28;
    const t = S.t;
    // cork pop
    const g = gn(S, 0);
    const bp = bq(S, 'bandpass', 700, 9);
    const src = noise(S, 'white', t, 0.05, 1);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, rr(S, 560, 780), 'set'], [0.04, rr(S, 1200, 1800), 'exp']]);
    let end = perc(g.gain, t, 0.16, 0.0012, 0.045);
    // glugs
    for (let i = 0; i < 3; i++) {
      const tt = t + 0.09 + i * rr(S, 0.10, 0.15);
      const gg = gn(S, 0);
      const gf = bq(S, 'bandpass', 400, 8);
      const gs = noise(S, 'white', tt, 0.11, rr(S, 0.8, 1.2));
      gs.connect(gf); gf.connect(gg); gg.connect(S.out);
      ramp(gf.frequency, tt, [[0, rr(S, 300, 460), 'set'], [0.09, rr(S, 700, 1100), 'exp']]);
      end = Math.max(end, perc(gg.gain, tt, 0.13, 0.004, 0.1));
      end = Math.max(end, thump(S, S.out, tt, { f0: 170, f1: 90, dur: 0.09, gain: 0.06 }));
    }
    // glass tap at the end
    end = Math.max(end, metalRing(S, S.out, t + 0.52, { base: rr(S, 2400, 3200), partials: 3, spread: 2.9, decay: 0.16, gain: 0.055 }));
    return end;
  },

  /** Heavy wooden door on iron hinges. */
  'door': (S, o = {}) => {
    const t = S.t;
    const dur = rr(S, 1.1, 1.6);
    // hinge groan: a wobbling resonant saw
    const g = gn(S, 0);
    const o1 = tone(S, 'sawtooth', t, dur, [[0, rr(S, 62, 88), 'set'], [dur * 0.6, rr(S, 96, 130), 'exp'], [dur, rr(S, 70, 92), 'exp']]);
    const bp = bq(S, 'bandpass', 420, 5.5);
    o1.connect(bp); bp.connect(g); g.connect(S.out);
    lfo(S, o1.detune, t, dur, rr(S, 4.5, 8), rr(S, 60, 160), 'triangle');
    ramp(bp.frequency, t, [[0, rr(S, 340, 480), 'set'], [dur, rr(S, 700, 1000), 'exp']]);
    let end = ahr(g.gain, t, 0.16, 0.14, dur * 0.5, dur * 0.4);
    // timber scrape
    end = Math.max(end, whoosh(S, S.out, t + 0.05, { dur: dur * 0.8, sweep: [500, 1400, 400], q: 1.5, gain: 0.10, kind: 'grit', attack: 0.15, hp: 200 }));
    // slam / latch at the end of the swing
    end = Math.max(end, at(S, dur * 0.92, () => SFX['hit.wood'](S, { magnitude: 1.1 })));
    S.wet = 0.55;
    return end;
  },

  /** Portcullis: chain ratchet, stone grind, iron slam. */
  'portcullis': (S, o = {}) => {
    const t = S.t;
    let end = t;
    // chain ratchet
    const n = 9;
    for (let i = 0; i < n; i++) {
      const tt = t + i * rr(S, 0.09, 0.15);
      end = Math.max(end, metalRing(S, S.out, tt, {
        base: rr(S, 800, 1600), partials: 4, spread: 3.2, decay: rr(S, 0.1, 0.26), gain: 0.065, decayJitter: 0.8,
      }));
      end = Math.max(end, tick(S, S.out, tt, { gain: 0.07, dur: 0.007, hp: 3400 }));
    }
    // stone grind under it
    const g = gn(S, 0);
    const src = noise(S, 'grit', t, 1.3, rr(S, 0.5, 0.8));
    const bp = bq(S, 'bandpass', 320, 1.8);
    src.connect(bp); bp.connect(g); g.connect(S.out);
    ramp(bp.frequency, t, [[0, 260, 'set'], [1.3, 620, 'exp']]);
    end = Math.max(end, ahr(g.gain, t, 0.13, 0.2, 0.7, 0.4));
    // iron slam
    end = Math.max(end, at(S, 1.3, () => SFX['hit.metal'](S, { magnitude: 1.05 })));
    end = Math.max(end, thump(S, S.out, t + 1.28, { f0: 66, f1: 26, dur: 0.9, gain: 0.27, click: 0.10 }));
    S.wet = 0.7;
    return end;
  },

  /* -------------------------------------------------------- environment */

  /** Distant thunder: crack, then a long rolling low tail. */
  'thunder': (S, o = {}) => {
    const near = clamp(o.gain ?? 0.6, 0.05, 1);
    const t = S.t;
    let end = t;
    if (near > 0.55) {
      end = Math.max(end, SFX['lightning.crack'](S, { magnitude: near * 0.8 }));
    }
    // rolling body: brown noise through a slowly closing lowpass, gusting
    const dur = 2.4 + (1 - near) * 3.4;
    const g = gn(S, 0);
    const src = noise(S, 'rumble', t, dur, rr(S, 0.7, 1.2));
    const lp = bq(S, 'lowpass', 300, 1.1);
    src.connect(lp); lp.connect(g); g.connect(S.out);
    ramp(lp.frequency, t, [[0, 90 + near * 700, 'set'], [dur, 55, 'exp']]);
    lfo(S, g.gain, t, dur, rr(S, 0.5, 1.3), 0.18 * near, 'sine');
    end = Math.max(end, ahr(g.gain, t, 0.52 * near, 0.25 + (1 - near) * 0.6, dur * 0.3, dur * 0.6));
    // a second, further roll
    const g2 = gn(S, 0);
    const src2 = noise(S, 'brown', t + rr(S, 0.4, 1.1), dur * 0.7, rr(S, 0.5, 0.9));
    const lp2 = bq(S, 'lowpass', 180, 0.9);
    src2.connect(lp2); lp2.connect(g2); g2.connect(S.out);
    end = Math.max(end, ahr(g2.gain, t + 0.6, 0.16 * near, 0.4, dur * 0.25, dur * 0.5));
    S.wet = 0.6;
    return end;
  },

  /** One water drop landing in a puddle, deep in a crypt. */
  'drip': (S, o = {}) => {
    S.wet = 0.85;
    const t = S.t;
    const f0 = rr(S, 520, 1500);
    const g = gn(S, 0);
    const os = tone(S, 'sine', t, 0.14, [[0, f0, 'set'], [0.1, f0 * rr(S, 1.9, 3.2), 'exp']]);
    os.connect(g); g.connect(S.out);
    let end = perc(g.gain, t, rr(S, 0.10, 0.2), 0.0012, rr(S, 0.06, 0.13));
    const g2 = gn(S, 0);
    const src = noise(S, 'white', t, 0.04, 1);
    const bp = bq(S, 'bandpass', f0 * 2.2, 3);
    src.connect(bp); bp.connect(g2); g2.connect(S.out);
    end = Math.max(end, perc(g2.gain, t, 0.05, 0.0006, 0.03));
    return end;
  },

  /** Small rock / debris settling. Fills crypt silence. */
  'debris': (S, o = {}) => {
    S.wet = 0.6;
    const t = S.t;
    let end = t;
    const n = 3 + Math.floor(S.rnd() * 4);
    for (let i = 0; i < n; i++) {
      const tt = t + rr(S, 0, 0.4);
      const d = rr(S, 0.03, 0.09);
      const g = gn(S, 0);
      const src = noise(S, 'white', tt, d, 1);
      const bp = bq(S, 'bandpass', rr(S, 380, 1500), rr(S, 3.5, 8));
      src.connect(bp); bp.connect(g); g.connect(S.out);
      end = Math.max(end, perc(g.gain, tt, rr(S, 0.26, 0.62), 0.001, d));
    }
    return end;
  },
};

/** Impact `kind` (from the bus) -> recipe id. */
export const IMPACT_MAP = {
  slash: 'hit.flesh',
  weapon: 'hit.flesh',
  pierce: 'hit.flesh',
  flesh: 'hit.flesh',
  gore: 'hit.flesh',
  blood: 'hit.flesh',
  metal: 'hit.metal',
  parry: 'hit.block',
  block: 'hit.block',
  shield: 'hit.block',
  stone: 'hit.stone',
  rubble: 'hit.stone',
  heavy_impact: 'hit.stone',
  aoe: 'hit.stone',
  wood: 'hit.wood',
  ceramic: 'hit.ceramic',
  bone: 'hit.bone',
  water: 'hit.water',
  splash: 'hit.water',
  arcane: 'cast.arcane',
  necrotic: 'cast.necrotic',
  fire: 'fire.whoosh',
  ember: 'fire.whoosh',
  ice: 'ice.shatter',
  frost: 'ice.shatter',
  lightning: 'lightning.crack',
  shock: 'lightning.crack',
  holy: 'cast.holy',
  poison: 'cast.poison',
  summon: 'cast.necrotic',
  summon_rift: 'cast.necrotic',
  dust: 'step.dirt',
  scuff: 'step.dirt',
  shout: 'shout',
  warcry: 'shout',
  land: 'thud',
  ragdoll: 'thud',
  body: 'thud',
  corpse: 'thud',
};

/**
 * Cue aliases. Other modules already emit `audio:sfx` / `audio:cue` with their
 * own names (Loot ships `loot.drop`, `loot.mythic`, `loot.pickupRare`; Weather
 * ships `thunder`, `rain`, `wind`), so those names are part of the de-facto
 * contract and are translated here rather than being ignored. `null` means the
 * ambience beds already cover it and a one-shot would double it.
 */
export const CUE_ALIAS = {
  'loot.drop': 'loot.common',
  'loot.mythic': 'loot.unique',
  'loot.pickupRare': 'loot.magic',
  'loot.set': 'loot.unique',
  'thunder': 'thunder',
  'rain': null,
  'wind': null,
  'snow': null,
  'hit': 'hit.flesh',
  'crit': 'hit.crit',
  'block': 'hit.block',
  'swing': 'swing',
  'step': 'step.stone',
  'levelup': 'levelup',
  'level.up': 'levelup',
  'potion': 'potion',
  'door': 'door',
  'portcullis': 'portcullis',
  'click': 'ui.click',
  'hover': 'ui.hover',
};

/** Damage `type` -> element recipe for the cast layer. */
export const ELEMENT_MAP = {
  physical: 'cast.physical',
  fire: 'cast.fire',
  cold: 'cast.ice',
  ice: 'cast.ice',
  frost: 'cast.ice',
  lightning: 'cast.lightning',
  shock: 'cast.lightning',
  arcane: 'cast.arcane',
  shadow: 'cast.arcane',
  necrotic: 'cast.necrotic',
  holy: 'cast.holy',
  poison: 'cast.poison',
};

/** Species / archetype -> vocalisation recipe. */
export const VOC_MAP = {
  skeleton: 'voc.skeleton',
  grunt: 'voc.skeleton',
  ghoul: 'voc.ghoul',
  cultist: 'voc.cultist',
  hellhound: 'voc.hellhound',
  scavenger: 'voc.hellhound',
  brute: 'voc.brute',
  wraith: 'voc.wraith',
  archer: 'voc.wraith',
  boss: 'voc.boss',
  hero: 'voc.hero',
  player: 'voc.hero',
};

/** How loud each recipe family is allowed to be, and how it competes. */
export const PRIORITY = {
  'levelup': 1.0, 'loot.legendary': 0.98, 'loot.unique': 0.98, 'death.boss': 0.97,
  'voc.boss': 0.92, 'thunder': 0.9, 'portcullis': 0.85, 'hit.crit': 0.85,
  'lightning.crack': 0.8, 'death.generic': 0.78, 'loot.rare': 0.76, 'ui.toast': 0.75,
  'hit.block': 0.7, 'cast.fire': 0.68, 'cast.ice': 0.68, 'cast.lightning': 0.68,
  'cast.arcane': 0.68, 'cast.necrotic': 0.68, 'cast.holy': 0.68, 'cast.poison': 0.68,
  'fire.whoosh': 0.66, 'ice.shatter': 0.66, 'voc.brute': 0.64, 'voc.wraith': 0.62,
  'hit.flesh': 0.6, 'hit.metal': 0.6, 'hit.stone': 0.58, 'hit.wood': 0.55,
  'hit.ceramic': 0.55, 'hit.bone': 0.55, 'hit.water': 0.5, 'thud': 0.58,
  'voc.ghoul': 0.55, 'voc.skeleton': 0.52, 'voc.cultist': 0.52, 'voc.hellhound': 0.52,
  'voc.hero': 0.72, 'shout': 0.74,
  'bow.release': 0.6, 'swing': 0.45, 'swing.air': 0.35, 'telegraph': 0.7,
  'loot.common': 0.5, 'loot.gold': 0.5, 'loot.magic': 0.6, 'loot.pickup': 0.5,
  'potion': 0.7, 'door': 0.7, 'ui.click': 0.8, 'ui.hover': 0.3, 'ui.error': 0.8,
  'step.stone': 0.28, 'step.dirt': 0.28, 'step.grass': 0.26, 'step.water': 0.3,
  'step.metal': 0.3, 'drip': 0.22, 'debris': 0.2, 'cast.physical': 0.6,
};

export const SFX_IDS = Object.keys(SFX);
