/**
 * THE NINTH VIGIL — UIAtlas
 * ---------------------------------------------------------------------------
 * Every pixel of ornament in the interface is generated here, at runtime, from
 * a deterministic PRNG. There are no image files, no icon fonts, no gradients
 * standing in for material — panels are hammered iron and worn vellum, sockets
 * are cast and beveled, gems are cabochons with a real specular, and the light
 * always comes from the upper-left.
 *
 * Two output forms:
 *   • `uri(...)`  — a cached PNG data URI for anything used many times as a CSS
 *                   background (sockets, rivets, grunge, item icons, glyphs).
 *   • `skin(...)` — painted straight into a <canvas> sized to the element that
 *                   owns it, so a 700 px panel frame is authored at 700 px and
 *                   never stretched. Repainted on resize only.
 *
 * Noise is *periodic* so tiles seam-match, and all of it is seeded through
 * `engine.rand`/`hash2` — no Math.random, no Date.now.
 */

import { hash2 } from '../core/Rand.js';

/* ------------------------------------------------------------ noise core */

const TAU = Math.PI * 2;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

/** Periodic gradient noise — wraps exactly every `per` lattice cells. */
function pnoise(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const w = (n) => ((n % per) + per) % per;
  const g = (ix, iy, dx, dy) => {
    const a = hash2(w(ix), w(iy), seed) * TAU;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  return (
    lerp(
      lerp(g(xi, yi, xf, yf), g(xi + 1, yi, xf - 1, yf), u),
      lerp(g(xi, yi + 1, xf, yf - 1), g(xi + 1, yi + 1, xf - 1, yf - 1), u),
      v
    ) * 0.7071 + 0.5
  );
}

function pfbm(x, y, per, seed, oct = 4, gain = 0.5, ridged = false) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) {
    let v = pnoise(x * f, y * f, per * f, seed + i * 811);
    if (ridged) v = 1 - Math.abs(v * 2 - 1);
    s += v * a; n += a; a *= gain; f *= 2;
  }
  return s / n;
}

/** Periodic Worley — returns nearest and second-nearest feature distances. */
function pworley(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  const w = (n) => ((n % per) + per) % per;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = w(cx), wy = w(cy);
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 977);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  f1 = Math.sqrt(f1); f2 = Math.sqrt(f2);
  return { f1, f2, edge: f2 - f1 };
}

/* --------------------------------------------------------- colour helpers */

function hex2rgb(h) {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => { const [r, g, b] = Array.isArray(c) ? c : hex2rgb(c); return `rgba(${r},${g},${b},${a})`; };
function mixc(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
}

/* ------------------------------------------------------------------ light */

/**
 * The interface has ONE key light: a hard, slightly warm source at the upper
 * left, at finite distance (so highlights fall off across a panel instead of
 * running dead-even along an edge), plus a dim cool bounce from below.
 *
 * Every raised face turned toward LKEY catches `SPEC`; every face turned away
 * falls to `SHADE`; recesses get the bounce only. Nothing in the UI may be
 * shaded by an axis-aligned gradient alone — that is what made round 1 read as
 * flat vector art.
 */
const LKEY = { x: -0.66, y: -0.75 };          // toward the key light
const SPEC = '255,249,233';                    // hard specular (near-white, warm)
const SPEC_G = '255,241,199';                  // specular on gold leaf
const SHADE = '2,3,5';                         // shadow side of a bevel
const BOUNCE = '196,178,146';                  // warm bounce into a recess

/** One shared seed for the `relief` height field — see UIAtlas.panel(). */
export const RELIEF_SEED = 4021;

/* --------------------------------------------------------------- geometry */

/** Chamfered ("gothic") rounded rect: straight edges, cut corners. */
function chamferPath(ctx, x, y, w, h, c) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function octPath(ctx, x, y, w, h, c) { chamferPath(ctx, x, y, w, h, c); }

function roundPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ========================================================================= *
 * UIAtlas
 * ========================================================================= */

export class UIAtlas {
  constructor(engine) {
    this.engine = engine;
    this.dpr = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    this._uri = new Map();
    this._tiles = new Map();
    this._pat = new Map();
    this._budget = 0;
  }

  dispose() { this._uri.clear(); this._tiles.clear(); this._pat.clear(); }

  /* ---------------------------------------------------------------- utils */

  cv(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** Cached data URI. `draw(ctx, w, h)` paints into a fresh canvas. */
  uri(key, w, h, draw) {
    const k = `${key}|${Math.round(w)}x${Math.round(h)}`;
    let u = this._uri.get(k);
    if (u) return u;
    const c = this.cv(w, h);
    const ctx = c.getContext('2d');
    try { draw(ctx, c.width, c.height); } catch (e) { /* degrade to blank */ }
    u = c.toDataURL('image/png');
    this._uri.set(k, u);
    return u;
  }

  css(key, w, h, draw) { return `url("${this.uri(key, w, h, draw)}")`; }

  /* ---------------------------------------------------------------- tiles */

  /**
   * Seamless overlay tiles. Each returns an RGBA canvas meant to be composited
   * with a blend mode over a base fill.
   */
  tile(name, size = 256, seed = 3) {
    const k = `${name}|${size}|${seed}`;
    let c = this._tiles.get(k);
    if (c) return c;
    c = this.cv(size, size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const S = size;
    const put = (i, r, g, b, a) => { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; };

    switch (name) {
      /* fine tooth — a universal grain layer, blended 'overlay' */
      case 'grain': {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const n = hash2(x, y, seed);
          const m = pnoise(x / 3.1, y / 3.1, S / 3.1, seed + 17);
          const v = clamp01(n * 0.55 + m * 0.45);
          const g = Math.round(96 + v * 118);
          put(i, g, g, g, 96);
        }
        break;
      }
      /* hand-hammered planishing dents, shaded from the upper-left */
      case 'hammer': {
        const cells = S / 21;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const u = (x / S) * cells, v = (y / S) * cells;
          const w0 = pworley(u, v, cells, seed);
          const w1 = pworley(u * 2.13, v * 2.13, cells * 2.13, seed + 41);
          // dome height inside each cell -> analytic normal via slope of f1
          const h0 = 1 - clamp01(w0.f1 * 1.55);
          const h1 = 1 - clamp01(w1.f1 * 1.4);
          const hh = h0 * 0.72 + h1 * 0.28;
          const e = 0.55 / S * cells;
          const hx = (1 - clamp01(pworley(u + e, v, cells, seed).f1 * 1.55)) - h0;
          const hy = (1 - clamp01(pworley(u, v + e, cells, seed).f1 * 1.55)) - h0;
          // N·L against the one key light (upper-left): a dome's up-left flank
          // catches, its down-right flank falls into shadow
          const l = clamp01(0.5 + (-hx * LKEY.x - hy * LKEY.y) * 9.4);
          const g = Math.round(24 + Math.pow(l, 1.15) * 216);
          put(i, g, g, Math.round(g * 0.99), Math.round(78 + hh * 46));
        }
        break;
      }
      /* brushed / drawn steel — anisotropic streaks */
      case 'brush': {
        for (let y = 0; y < S; y++) {
          const row = pnoise(0, y / 1.7, S / 1.7, seed + 5);
          for (let x = 0; x < S; x++) {
            const i = (y * S + x) * 4;
            const n = pnoise(x / 46, y / 1.15, S / 46, seed) * 0.6 + row * 0.4;
            const t = hash2(x >> 2, y, seed + 91) * 0.28;
            const g = Math.round(74 + (n * 0.72 + t) * 150);
            put(i, g, g, g, 74);
          }
        }
        break;
      }
      /* tarnish / grime blotches, blended 'multiply' */
      case 'tarnish': {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const a = pfbm(x / 58, y / 58, S / 58, seed, 4);
          const b = pfbm(x / 17, y / 17, S / 17, seed + 303, 3);
          const v = clamp01(a * 0.7 + b * 0.3);
          const t = smooth(0.42, 0.86, v);
          put(i, Math.round(150 - t * 92), Math.round(142 - t * 96), Math.round(120 - t * 88),
            Math.round(28 + t * 168));
        }
        break;
      }
      /* LAID PAPER — the structure a sheet of vellum/laid parchment actually has:
         laid lines (the close-pitch ridges left by the mould wires), chain lines
         (the wide-pitch ones at right angles to them), matted fibre, and foxing.
         All four are authored with real contrast, because the previous 'fibre'
         pass put its detail at 0.75 px on a panel-scale sheet — under a display
         pixel, so it averaged to one flat tone and the interior read as blank
         card with a crackle glaze on it. Every term here is exactly periodic over
         S, so the tile still seams. */
      case 'laid': {
        const NL = Math.max(1, Math.round(S / 6.2));    // laid-line count
        const NC = Math.max(1, Math.round(S / 34));     // chain-line count
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          /* the mould was handmade: wobble both line families so they are not a
             printed screen */
          const wy = (pnoise(x / 37, y / 37, S / 37, seed + 3) - 0.5) * 1.9;
          const wx = (pnoise(x / 21, y / 21, S / 21, seed + 9) - 0.5) * 2.6;
          const laid = 0.5 + 0.5 * Math.cos((y + wy) * (TAU * NL / S));
          const chain = Math.pow(0.5 + 0.5 * Math.cos((x + wx) * (TAU * NC / S)), 8);
          /* matted fibre: fine tooth clumped by a coarser field */
          const f0 = pnoise(x / 1.9, y / 1.9, S / 1.9, seed + 17);
          const f1 = pnoise(x / 11, y / 11, S / 11, seed + 51);
          const fib = clamp01(f0 * 0.62 + f1 * 0.38);
          /* foxing / thin-and-thick patches in the sheet */
          const m = pfbm(x / 34, y / 34, S / 34, seed + 13, 4);
          /* The mould lines come and go across a real sheet — held at constant
             amplitude they read as corduroy, which is worse than having no
             structure at all. Fibre and foxing carry the value; the laid lines are
             a whisper you only catch in raking light. */
          const amp = clamp01(0.10 + pfbm(x / 52, y / 52, S / 52, seed + 29, 3) * 1.25);
          const v = clamp01(0.12 + laid * 0.15 * amp + fib * 0.40 + m * 0.32 - chain * 0.09 * amp);
          const g = Math.round(12 + Math.pow(v, 1.05) * 232);
          put(i, g, Math.round(g * 0.992), Math.round(g * 0.94), 168);
        }
        break;
      }
      /* vellum fibre + mottling */
      case 'fibre': {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const f = pnoise(x / 1.25, y / 30, S / 30, seed + 7);
          const f2 = pnoise(x / 34, y / 1.3, S / 34, seed + 71);
          const m = pfbm(x / 44, y / 44, S / 44, seed + 13, 4);
          const v = clamp01(f * 0.3 + f2 * 0.26 + m * 0.44);
          const g = Math.round(88 + v * 128);
          put(i, g, Math.round(g * 0.985), Math.round(g * 0.94), 118);
        }
        break;
      }
      /* leather pebbling — each grain is a little dome, shaded by the key light
         from the slope of its own distance field, so the hide has relief rather
         than being a flat blotch pattern */
      case 'leather': {
        const cells = S / 15;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const u = (x / S) * cells, v = (y / S) * cells;
          const w0 = pworley(u, v, cells, seed);
          const w1 = pworley(u * 2.7, v * 2.7, cells * 2.7, seed + 29);
          const e = clamp01(w0.edge * 2.1) * 0.7 + clamp01(w1.edge * 2.4) * 0.3;
          const dome = 1 - clamp01(w0.f1 * 1.7);
          const ee = 0.6 / S * cells;
          const hx = (1 - clamp01(pworley(u + ee, v, cells, seed).f1 * 1.7)) - dome;
          const hy = (1 - clamp01(pworley(u, v + ee, cells, seed).f1 * 1.7)) - dome;
          const nl = clamp01(0.5 + (-hx * LKEY.x - hy * LKEY.y) * 7.4);
          const l = clamp01(0.18 + e * 0.30 + dome * 0.18 + nl * 0.52);
          const g = Math.round(14 + Math.pow(l, 1.2) * 222);
          put(i, g, g, g, 142);
        }
        break;
      }
      /* hairline cracks + pits, 'multiply' */
      case 'craze': {
        const cells = S / 30;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const u = (x / S) * cells, v = (y / S) * cells;
          const w0 = pworley(u, v, cells, seed);
          const line = 1 - smooth(0.0, 0.055, w0.edge);
          const pit = smooth(0.72, 0.98, pfbm(x / 8, y / 8, S / 8, seed + 5, 3));
          const t = clamp01(line * 0.8 + pit * 0.45);
          const g = Math.round(255 - t * 200);
          put(i, g, Math.round(g * 0.97), Math.round(g * 0.93), Math.round(t * 230));
        }
        break;
      }
      /* relief-lit rough surface: a real height field, shaded by the key light
         from its own analytic slope. This is the mid-frequency structure a dark
         stone/iron field needs — without it a panel interior is a gradient. */
      case 'relief': {
        /* One fbm evaluation per pixel into a height buffer, then the slope is
           read from the neighbours — the field is periodic over S so the wrap is
           seamless. Sampling the noise three times per pixel to difference it
           costs 3x as much for no extra detail. */
        const Hf = new Float32Array(S * S);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          Hf[y * S + x] =
            pfbm(x / 26, y / 26, S / 26, seed, 4, 0.55) * 0.62 +
            pfbm(x / 7.5, y / 7.5, S / 7.5, seed + 55, 3, 0.5) * 0.38;
        }
        for (let y = 0; y < S; y++) {
          const yn = ((y + 1) % S) * S;
          const y0 = y * S;
          for (let x = 0; x < S; x++) {
            const i = (y0 + x) * 4;
            const h0 = Hf[y0 + x];
            const hx = Hf[y0 + ((x + 1) % S)] - h0;
            const hy = Hf[yn + x] - h0;
            // N·L with the key light; k exaggerates the slope into a visible facet
            const l = clamp01(0.5 + (-hx * LKEY.x - hy * LKEY.y) * 22.0);
            const g = Math.round(18 + Math.pow(l, 1.25) * 224);
            put(i, g, g, Math.round(g * 0.98), Math.round(96 + h0 * 52));
          }
        }
        break;
      }
      /* long soft folds — the LOW-frequency structure a hide or a bolt of cloth
         has under its grain. Ridged fbm gives creases that meet in valleys; the
         field is lit from its own analytic slope so the ridges catch and the
         valleys occlude. Without this a leather panel is one uniform speckle,
         which is what "flat brown-grey gradient" means. */
      case 'crease': {
        const Hf = new Float32Array(S * S);
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          Hf[y * S + x] =
            pfbm(x / 40, y / 40, S / 40, seed, 4, 0.52, true) * 0.70 +
            pfbm(x / 13, y / 13, S / 13, seed + 617, 3, 0.5, true) * 0.30;
        }
        for (let y = 0; y < S; y++) {
          const yn = ((y + 1) % S) * S, y0 = y * S;
          const yp = ((y - 1 + S) % S) * S;
          for (let x = 0; x < S; x++) {
            const i = (y0 + x) * 4;
            const h0 = Hf[y0 + x];
            const hx = Hf[y0 + ((x + 1) % S)] - Hf[y0 + ((x - 1 + S) % S)];
            const hy = Hf[yn + x] - Hf[yp + x];
            const l = clamp01(0.5 + (-hx * LKEY.x - hy * LKEY.y) * 15.0);
            /* valleys hold grime, crests are burnished: couple value to height */
            const v = clamp01(Math.pow(l, 1.30) * 0.78 + h0 * 0.30);
            const g = Math.round(6 + v * 244);
            put(i, g, Math.round(g * 0.995), Math.round(g * 0.96), Math.round(112 + h0 * 74));
          }
        }
        break;
      }
      /* liquid caustics for the orbs */
      case 'caustic': {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          const a = pfbm(x / 40, y / 40, S / 40, seed, 4, 0.5, true);
          const b = pfbm(x / 15, y / 15, S / 15, seed + 71, 3, 0.5, true);
          const v = clamp01(Math.pow(a * 0.65 + b * 0.35, 2.1));
          const g = Math.round(40 + v * 215);
          put(i, g, g, g, Math.round(46 + v * 150));
        }
        break;
      }
      default: {
        for (let i = 0; i < d.length; i += 4) put(i, 128, 128, 128, 0);
      }
    }
    ctx.putImageData(img, 0, 0);
    this._tiles.set(k, c);
    return c;
  }

  pattern(ctx, name, size = 256, seed = 3) {
    const key = `${name}|${size}|${seed}`;
    let p = this._pat.get(key);
    if (!p) { p = ctx.createPattern(this.tile(name, size, seed), 'repeat'); this._pat.set(key, p); }
    return p;
  }

  /** Composite a seamless tile over the current clip with a blend mode. */
  layer(ctx, name, { size = 256, seed = 3, mode = 'overlay', alpha = 1, scale = 1, offX = 0, offY = 0 } = {}) {
    const pat = ctx.createPattern(this.tile(name, size, seed), 'repeat');
    if (!pat) return;
    ctx.save();
    ctx.globalCompositeOperation = mode;
    ctx.globalAlpha = alpha;
    if (scale !== 1 || offX || offY) {
      const m = new DOMMatrix();
      pat.setTransform(m.translate(offX, offY).scale(scale, scale));
    }
    ctx.fillStyle = pat;
    ctx.fillRect(-4096, -4096, 8192, 8192);
    ctx.restore();
  }

  /* ------------------------------------------------------------ materials */

  /**
   * Fill the current path/clip with a physical material. Always call inside a
   * `ctx.save(); ctx.clip();`.
   *
   * kind: 'iron' | 'steel' | 'bronze' | 'gold' | 'vellum' | 'leather' | 'stone'
   */
  material(ctx, x, y, w, h, kind = 'iron', o = {}) {
    const seed = o.seed ?? 11;
    const sc = o.scale ?? 1;
    const P = {
      iron:    { a: '#0e1114', b: '#2b3138', c: '#454d57', tar: 0.55, ham: 0.9, br: 0.35, met: 1 },
      steel:   { a: '#1b2027', b: '#3b434e', c: '#6c7784', tar: 0.35, ham: 0.55, br: 0.8,  met: 1 },
      bronze:  { a: '#1d1408', b: '#4d3717', c: '#8a6a30', tar: 0.62, ham: 0.8, br: 0.3,  met: 1 },
      gold:    { a: '#3a2708', b: '#8c6821', c: '#e2c274', tar: 0.34, ham: 0.62, br: 0.28, met: 1 },
      /* Leather and stone were authored around luminance 0.08 — dark enough that
         a whole panel interior sat under 0.13 and the eye read it as one flat
         value with no material in it at all. Lifted into the low mids: the deep
         end still goes to near-black, but the mid the grain modulates around is
         now high enough for that grain to be visible. */
      /* the shadowed end of a sheet of vellum is still parchment: authored at
         #655741 the far corner of a large sheet fell below the value that carries
         ink, so the whole ramp sits in the lit half of the material */
      vellum:  { a: '#6e5e44', b: '#b6a47e', c: '#e6dbbd', tar: 0.46, ham: 0, br: 0, met: 0 },
      leather: { a: '#120e08', b: '#4d3924', c: '#80623c', tar: 0.55, ham: 0, br: 0, met: 0 },
      /* near-neutral, only faintly cool: a genuinely blue slate slab set into a
         warm hide panel reads as a plastic inlay, not as the same object */
      stone:   { a: '#0d1013', b: '#2f3339', c: '#525a63', tar: 0.58, ham: 0, br: 0, met: 0 },
    }[kind] ?? { a: '#0c0e11', b: '#1c2025', c: '#2f353c', tar: 0.58, ham: 0.5, br: 0.4, met: 1 };

    // base: light from above -> top brighter
    const g = ctx.createLinearGradient(x, y, x + w * 0.22, y + h);
    g.addColorStop(0, mixc(P.b, P.c, 0.55));
    g.addColorStop(0.34, P.b);
    g.addColorStop(0.78, mixc(P.a, P.b, 0.45));
    g.addColorStop(1, P.a);
    ctx.fillStyle = g;
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

    const box = { x, y, w, h };

    if (kind === 'vellum') {
      /* THREE frequencies, as with hide: the laid/chain mould structure (~6 px),
         matted fibre (~2 px), and thick-and-thin foxing patches (~40 px). The
         laid pass goes on twice — overlay for the ridge value and multiply for
         the wire shadow between ridges — because a sheet lit from a raking key
         shows both, and overlay alone on a light base barely bites. */
      this.layer(ctx, 'laid', { seed, mode: 'overlay', alpha: 0.86, scale: 1.6 * sc });
      this.layer(ctx, 'laid', { seed, mode: 'multiply', alpha: 0.20, scale: 1.6 * sc });
      this.layer(ctx, 'laid', { seed: seed + 401, mode: 'soft-light', alpha: 0.54, scale: 4.6 * sc, offX: 7 });
      this.layer(ctx, 'fibre', { seed: seed + 77, mode: 'overlay', alpha: 0.58, scale: 0.42 * sc });
      this.layer(ctx, 'fibre', { seed: seed + 211, mode: 'soft-light', alpha: 0.44, scale: 0.16 * sc, offY: 13 });
      this.layer(ctx, 'tarnish', { seed: seed + 5, mode: 'multiply', alpha: 0.5 * P.tar, scale: 1.9 * sc });
      /* the crackle is a GLAZE defect, not the paper: at 0.30 it was the loudest
         thing on the sheet and the parchment read as crazed plaster */
      this.layer(ctx, 'craze', { seed: seed + 9, mode: 'multiply', alpha: 0.15, scale: 1.5 * sc });
      this.layer(ctx, 'grain', { seed: seed + 3, mode: 'overlay', alpha: 0.34, scale: 0.7 });
      /* burnished: a raking band with a crest where the sheet has been rubbed
         smooth, plus the broad lobe. Vellum is semi-gloss, not matte paper. */
      if (o.spec !== false) {
        this.glaze(ctx, null, box, { a: 0.16, tint: '255,250,232', cx: 0.14, cy: 0.08, wid: 0.52, len: 1.24, fall: 1.6 });
        this.sheen(ctx, null, box, { a: 0.13, r: 0.8, squash: 0.44, cx: 0.24, cy: 0.16 });
      }
      return;
    }
    if (kind === 'leather') {
      /* THREE frequencies, which is what separates hide from noise:
         long folds (crease, ~90 px), pebbled grain (~14 px), tooth (~2 px).
         The folds carry the value structure; the pebbles carry the specular. */
      /* the folds are authored at ~4 m of hide, not 20: at scale 8.5 the ridged
         field's features landed near 200 px on a panel and read as one soft brown
         blob rather than as drape */
      this.layer(ctx, 'crease', { seed: seed + 71, mode: 'overlay', alpha: 0.60, scale: 3.4 * sc, offX: 23, offY: 61 });
      this.layer(ctx, 'crease', { seed: seed + 71, mode: 'multiply', alpha: 0.24, scale: 3.4 * sc, offX: 23, offY: 61 });
      this.layer(ctx, 'leather', { seed: seed + 133, mode: 'soft-light', alpha: 0.52, scale: 1.7 * sc, offX: 11, offY: 5 });
      this.layer(ctx, 'leather', { seed, mode: 'overlay', alpha: 0.62, scale: 0.52 * sc });
      /* the pebbles' own catch-light: screening the same dome field puts a real
         highlight on every grain instead of only darkening between them */
      this.layer(ctx, 'leather', { seed, mode: 'screen', alpha: 0.22, scale: 0.52 * sc });
      this.layer(ctx, 'craze', { seed: seed + 57, mode: 'multiply', alpha: 0.26, scale: 1.5 * sc });
      this.layer(ctx, 'tarnish', { seed: seed + 12, mode: 'multiply', alpha: 0.50, scale: 3.4 * sc });
      this.layer(ctx, 'grain', { seed: seed + 2, mode: 'overlay', alpha: 0.22 });
      /* burnished sheen — oiled leather is glossy where it has been handled */
      if (o.spec !== false) {
        this.sheen(ctx, null, box, { a: 0.15, r: 0.86, squash: 0.38, cx: 0.24, cy: 0.13 });
        this.sheen(ctx, null, box, { a: 0.11, r: 0.30, squash: 0.52, cx: 0.14, cy: 0.09, rot: -0.95 });
      }
      return;
    }
    if (P.br > 0) this.layer(ctx, 'brush', { seed: seed + 21, mode: 'overlay', alpha: 0.5 * P.br, scale: 1.3 * sc });
    if (P.ham > 0) {
      this.layer(ctx, 'hammer', { seed, mode: 'overlay', alpha: 0.82 * P.ham, scale: 1.0 * sc });
      /* the planishing dents catch the key light: screening the same tile puts
         a real specular on every dome instead of only darkening the pits */
      this.layer(ctx, 'hammer', { seed, mode: 'screen', alpha: 0.14 * P.ham, scale: 1.0 * sc });
    }
    this.layer(ctx, 'tarnish', { seed: seed + 7, mode: 'multiply', alpha: 0.62 * P.tar, scale: 2.4 * sc });
    this.layer(ctx, 'craze', { seed: seed + 31, mode: 'multiply', alpha: 0.34, scale: 1.7 * sc });
    this.layer(ctx, 'grain', { seed: seed + 4, mode: 'overlay', alpha: 0.22, scale: 0.75 });
    /* --- polish. A metal with no specular lobe is a grey fill; this is the
       BROAD term only — deliberately restrained, because the hard highlights
       come from edgeBevel/hotSpot where geometry actually turns to the light. */
    if (o.spec !== false) {
      const sa = (o.spec ?? 1) * (P.met ? 1 : 0.30);
      const tint = kind === 'gold' || kind === 'bronze' ? SPEC_G : SPEC;
      this.sheen(ctx, null, box, { a: 0.20 * sa, r: 0.56, squash: 0.28, cx: 0.26, cy: 0.16, tint });
      this.sheen(ctx, null, box, { a: 0.14 * sa, r: 0.24, squash: 0.50, cx: 0.15, cy: 0.10, rot: -0.9, tint });
    }
  }

  /* ------------------------------------------------------------- specular */

  /**
   * Directional falloff gradient for the key light. `dir:+1` is brightest at
   * the upper-left corner of the box and gone by the lower-right (the faces
   * turned toward the light); `dir:-1` is the mirror (faces turned away).
   */
  _falloff(ctx, box, col, a, dir = 1, tightness = 1) {
    const { x, y, w, h } = box;
    const g = dir > 0
      ? ctx.createLinearGradient(x, y, x + w * 0.92, y + h * 0.98)
      : ctx.createLinearGradient(x + w, y + h, x + w * 0.08, y + h * 0.02);
    const k = clamp01(a);
    g.addColorStop(0, `rgba(${col},${k.toFixed(3)})`);
    g.addColorStop(0.24 / tightness, `rgba(${col},${(k * 0.70).toFixed(3)})`);
    g.addColorStop(0.58 / tightness, `rgba(${col},${(k * 0.26).toFixed(3)})`);
    g.addColorStop(Math.min(0.98, 0.88 / tightness), `rgba(${col},${(k * 0.05).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    return g;
  }

  /**
   * Light the edge of a closed path as a real bevel, drawn strictly *inside*
   * the path so it never bleeds onto a neighbour.
   *
   *   mode 'raised' — catch-light on the up-left faces, cut on the down-right
   *   mode 'inset'  — occlusion on the up-left faces, warm bounce down-right
   *
   * The two strokes are the same geometry offset along ±LKEY; that offset is
   * literally the bevel width, which is why this reads as chamfered metal and a
   * plain `box-shadow: inset` does not.
   */
  edgeBevel(ctx, path, box, o = {}) {
    const lw = Math.max(0.7, o.width ?? 2.0);
    const inset = o.mode === 'inset';
    const hiA = o.hiA ?? (inset ? 0.46 : 0.95);
    const loA = o.loA ?? (inset ? 0.88 : 0.80);
    const hiCol = o.hi ?? (inset ? BOUNCE : SPEC);
    const loCol = o.lo ?? SHADE;
    const t = o.tightness ?? 1;
    /* The catch-light and the occlusion may be different WIDTHS. On a sunken lip
       the shaded flank is broad and the bounce that creeps back up the far wall is
       a thin line — giving both the same width put a 10 px pale khaki band around
       the bottom-right of every socket, which reads as plastic, not as a bevel. */
    const wHi = Math.max(0.7, (inset ? o.hiW : o.hiW) ?? lw);
    const wLo = Math.max(0.7, o.loW ?? lw);
    const oHi = o.hiOff ?? o.offset ?? wHi * 0.52;
    const oLo = o.loOff ?? o.offset ?? wLo * 0.52;
    const step = (off) => [-LKEY.x * off, -LKEY.y * off];   // away from the light
    ctx.save();
    ctx.clip(path);
    ctx.lineJoin = 'round';
    /* band A — hugs the top + left inner edges */
    ctx.save();
    {
      const [dx, dy] = step(inset ? oLo : oHi);
      ctx.translate(dx, dy);
      ctx.lineWidth = inset ? wLo : wHi;
      ctx.strokeStyle = inset
        ? this._falloff(ctx, box, loCol, loA, 1, t)
        : this._falloff(ctx, box, hiCol, hiA, 1, t);
      ctx.stroke(path);
    }
    ctx.restore();
    /* band B — hugs the bottom + right inner edges */
    ctx.save();
    {
      const [dx, dy] = step(inset ? oHi : oLo);
      ctx.translate(-dx, -dy);
      ctx.lineWidth = inset ? wHi : wLo;
      ctx.strokeStyle = inset
        ? this._falloff(ctx, box, hiCol, hiA, -1, t)
        : this._falloff(ctx, box, loCol, loA * 0.9, -1, t);
      ctx.stroke(path);
    }
    ctx.restore();
    ctx.restore();
  }

  /**
   * Broad anisotropic polish lobe — the reason a metal band reads as *metal*
   * rather than a grey fill. Elongated across the light direction, screened so
   * it lifts value without washing the hue out.
   */
  sheen(ctx, path, box, o = {}) {
    const { x, y, w, h } = box;
    const cx = x + w * (o.cx ?? 0.28);
    const cy = y + h * (o.cy ?? 0.18);
    const R = Math.max(w, h) * (o.r ?? 0.66);
    const sq = o.squash ?? 0.26;
    ctx.save();
    if (path) ctx.clip(path);
    ctx.globalCompositeOperation = o.mode ?? 'screen';
    ctx.translate(cx, cy);
    ctx.rotate(o.rot ?? -0.60);
    ctx.scale(1, sq);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    const col = o.tint ?? SPEC;
    const a = o.a ?? 0.42;
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(0.34, `rgba(${col},${(a * 0.46).toFixed(3)})`);
    g.addColorStop(0.72, `rgba(${col},${(a * 0.10).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /**
   * A BOUNDED raking band of polish across a whole face — the panel-scale
   * counterpart to `hotSpot`.
   *
   * `sheen` is a soft radial lobe: correct for a curved moulding, but on a large
   * flat interior it reads as fog, because it has no edge anywhere. Real varnished
   * hide, glazed slate and waxed vellum all show a *band* of light with a crisp
   * crest along it where the surface passes through the mirror angle. That crest
   * is the whole cue, and it is why a 500 px panel field can be given a genuine
   * specular instead of a gradient.
   *
   * The band is authored in its own rotated frame running away from the key, and
   * faded along its length by slicing — a canvas gradient is 1-D, so the crest
   * profile (across) and the falloff (along) cannot come from one fill.
   */
  glaze(ctx, path, box, o = {}) {
    const { x, y, w, h } = box;
    const col = o.tint ?? SPEC;
    const a = clamp01(o.a ?? 0.18);
    if (a <= 0.002) return;
    const cx = x + w * (o.cx ?? 0.16);
    const cy = y + h * (o.cy ?? 0.10);
    const len = Math.hypot(w, h) * (o.len ?? 1.15);
    const wid = Math.min(w, h) * (o.wid ?? 0.46);
    const N = o.slices ?? 14;
    const fall = o.fall ?? 1.7;
    ctx.save();
    if (path) ctx.clip(path);
    ctx.globalCompositeOperation = o.mode ?? 'screen';
    ctx.translate(cx, cy);
    ctx.rotate(o.rot ?? Math.atan2(-LKEY.y, -LKEY.x));   // along the key axis
    /* cross-section of the band: soft shoulder, hard crest, quick fall */
    const g = ctx.createLinearGradient(0, -wid * 0.5, 0, wid * 0.5);
    g.addColorStop(0, `rgba(${col},0)`);
    g.addColorStop(0.26, `rgba(${col},${(a * 0.20).toFixed(3)})`);
    g.addColorStop(0.44, `rgba(${col},${a.toFixed(3)})`);
    g.addColorStop(0.50, `rgba(${col},${(a * 0.92).toFixed(3)})`);
    g.addColorStop(0.60, `rgba(${col},${(a * 0.34).toFixed(3)})`);
    g.addColorStop(0.82, `rgba(${col},${(a * 0.07).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    const seg = len / N;
    for (let i = 0; i < N; i++) {
      ctx.globalAlpha = clamp01(Math.pow(1 - i / N, fall));
      /* 0.6 px of overlap: adjacent slices at different alphas must not leave a
         seam line down the band */
      ctx.fillRect(-len * 0.16 + i * seg, -wid * 0.5, seg + 0.6, wid);
    }
    ctx.restore();
  }

  /**
   * A hard specular hotspot with a *solid* core. The core is the part that
   * actually reads as shiny: a gradient that only ever reaches 60% white looks
   * like fog, not like light bouncing off polished metal.
   */
  hotSpot(ctx, x, y, r, o = {}) {
    const col = o.tint ?? SPEC;
    const a = o.a ?? 0.98;
    const sq = o.squash ?? 0.68;
    const rot = o.rot ?? -0.62;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(1, sq);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, `rgba(${col},${a})`);
    g.addColorStop(0.30, `rgba(${col},${(a * 0.74).toFixed(3)})`);
    g.addColorStop(0.62, `rgba(${col},${(a * 0.20).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    if (o.core !== false) {
      ctx.fillStyle = `rgba(${col},${Math.min(1, a * 1.02).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(0, 0, r * (o.coreR ?? 0.36), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Four-point star glint — the little cross of light a polished cabochon or a
   * gold boss throws. Tiny, but it is the single cheapest "expensive" cue.
   */
  glint(ctx, x, y, r, o = {}) {
    const col = o.tint ?? SPEC;
    const a = o.a ?? 0.9;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.rot ?? 0);
    for (const [sx, sy] of [[1, 0.20], [0.20, 1]]) {
      const g = ctx.createLinearGradient(-r * sx, -r * sy, r * sx, r * sy);
      g.addColorStop(0, `rgba(${col},0)`);
      g.addColorStop(0.34, `rgba(${col},${(a * 0.30).toFixed(3)})`);
      g.addColorStop(0.5, `rgba(${col},${a})`);
      g.addColorStop(0.66, `rgba(${col},${(a * 0.30).toFixed(3)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-r * sx, 0); ctx.lineTo(0, -r * sy * 0.5);
      ctx.lineTo(r * sx, 0); ctx.lineTo(0, r * sy * 0.5);
      ctx.closePath(); ctx.fill();
    }
    this.hotSpot(ctx, 0, 0, r * 0.26, { tint: col, a, squash: 0.9 });
    ctx.restore();
  }

  /**
   * Light a frame band per RUN rather than per corner. Call inside the band clip.
   *
   * A collar under a distant source at the upper left has its top rail and its
   * left stile turned into the light along their WHOLE length, and its bottom and
   * right runs turned fully away. A single corner-to-corner falloff instead lights
   * only the up-left corner and leaves the rest of the rail at base value — which
   * is exactly why an 8x11 grid of them reads as "identical rounded-square black
   * slots" with one bright speck each.
   *
   * Every term is a gradient confined to one band width from one edge, so it can
   * only ever touch its own run. Across the run the profile peaks at `crest`,
   * which is the chamfer face, and falls to nothing at the flat behind it.
   */
  runLight(ctx, band, box, o = {}) {
    const { x, y, w, h } = box;
    const bw = Math.max(1.2, band);
    /* The shadow runs are allowed their OWN width. A crest and its cast shadow
       are not the same size on a real moulding: the chamfer face that catches the
       key is narrow and hot, while the whole opposite flank sits in shade. Tying
       them to one width is what produced a collar that was a uniformly pale band
       on all four sides — "a single flat value with no bevel". */
    const lw2 = Math.max(1.2, o.loBand ?? band);
    const tint = o.tint ?? SPEC;
    const hi = clamp01(o.hi ?? 0.80);
    const lo = clamp01(o.lo ?? 0.70);
    const crest = o.crest ?? 0.34;
    const tail = o.tail ?? 0.22;
    const ramp = (x0, y0, x1, y1, col, a, cr = crest, tl = tail) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, `rgba(${col},${(a * (o.edgeA ?? 0.30)).toFixed(3)})`);
      g.addColorStop(cr, `rgba(${col},${a.toFixed(3)})`);
      g.addColorStop(Math.min(0.94, cr + tl), `rgba(${col},${(a * 0.34).toFixed(3)})`);
      g.addColorStop(1, `rgba(${col},0)`);
      return g;
    };
    ctx.save();
    /* the flanks turned away go FIRST and go to true black. Laying them down
       before the crest means the crest's own soft tail cannot be cancelled by
       them, so the cross-section keeps both ends of its range. */
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ramp(x, y + h, x, y + h - lw2, '0,0,0', lo, 0.30, 0.44);
    ctx.fillRect(x - 1, y + h - lw2, w + 2, lw2 + 1);
    ctx.fillStyle = ramp(x + w, y, x + w - lw2, y, '0,0,0', lo * 0.94, 0.30, 0.44);
    ctx.fillRect(x + w - lw2, y - 1, lw2 + 1, h + 2);
    /* lit runs — screened, so the planishing and tarnish underneath still
       modulate through instead of being replaced by a flat white L */
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = ramp(x, y, x, y + bw, tint, hi);
    ctx.fillRect(x - 1, y - 1, w + 2, bw + 1);
    ctx.fillStyle = ramp(x, y, x + bw, y, tint, hi * 0.92);
    ctx.fillRect(x - 1, y - 1, bw + 1, h + 2);
    ctx.restore();
  }

  /**
   * Gold-leaf treatment for a stroked ornament: a dark cut below, worn leaf on
   * the body, then a hard near-white specular on the light-facing side of the
   * same stroke. `path` is a Path2D.
   */
  goldStroke(ctx, box, lw, path, o = {}) {
    const { x, y, w, h } = box;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    /* A rolled half-round of leaf, painted as a CROSS-SECTION rather than one
       flat run: dark cut on the shadow side, worn leaf body, a mid band, then a
       hard crest on the lit side, and finally tarnish stroked through the whole
       thing so the gold is not a uniform highlighter line. */
    const base = ctx.createLinearGradient(x, y, x + w * 0.8, y + h);
    base.addColorStop(0, '#f2dea6');
    base.addColorStop(0.28, '#c39a44');
    base.addColorStop(0.62, '#7d5c1e');
    base.addColorStop(1, '#33240b');
    const dark = ctx.createLinearGradient(x, y, x + w * 0.8, y + h);
    dark.addColorStop(0, '#8a6a26');
    dark.addColorStop(0.44, '#4d3812');
    dark.addColorStop(1, '#1a1206');
    /* 1 — the cut below */
    ctx.lineWidth = lw * 1.12;
    ctx.strokeStyle = 'rgba(0,0,0,0.86)';
    ctx.save(); ctx.translate(lw * 0.36, lw * 0.42); ctx.stroke(path); ctx.restore();
    /* 2 — body */
    ctx.lineWidth = lw;
    ctx.strokeStyle = base;
    ctx.stroke(path);
    /* 3 — the shadowed lower half of the torus */
    ctx.lineWidth = lw * 0.46;
    ctx.strokeStyle = dark;
    ctx.save(); ctx.translate(lw * 0.28, lw * 0.30); ctx.stroke(path); ctx.restore();
    /* 4 — tarnish and wear through the leaf */
    const tp = this.pattern(ctx, 'tarnish', 256, (o.seed ?? 5) + 13);
    if (tp) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = o.wear ?? 0.42;
      ctx.lineWidth = lw;
      ctx.strokeStyle = tp;
      ctx.stroke(path);
      ctx.restore();
    }
    /* 5 — the hard crest on the lit side */
    ctx.lineWidth = Math.max(0.7, lw * (o.specW ?? 0.34));
    ctx.strokeStyle = this._falloff(ctx, box, o.spec ?? SPEC_G, o.specA ?? 0.98, 1, o.tightness ?? 1);
    ctx.save(); ctx.translate(-lw * 0.28, -lw * 0.32); ctx.stroke(path); ctx.restore();
    /* 6 — and a sub-pixel white pin right on the crest, which is the actual
       "gold leaf catches the light" cue at panel scale */
    ctx.lineWidth = Math.max(0.6, lw * 0.16);
    ctx.strokeStyle = this._falloff(ctx, box, SPEC, (o.pinA ?? 0.92), 1, (o.tightness ?? 1) * 1.2);
    ctx.save(); ctx.translate(-lw * 0.36, -lw * 0.40); ctx.stroke(path); ctx.restore();
    ctx.restore();
  }

  /* --------------------------------------------------------------- emboss */

  /**
   * Shade a band (the region between `outer` and `inner` paths) as a raised
   * bevel lit from the upper-left, then cut a groove and a contact shadow.
   */
  bevelBand(ctx, outer, inner, o = {}) {
    const { x, y, w, h } = o.box;
    ctx.save();
    outer(ctx); ctx.save(); ctx.clip();
    inner(ctx);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  /* ============================================================== panels */

  /**
   * Paint a complete ornate panel into `canvas` at its own pixel size.
   *
   * o = { kind, band, chamfer, ornament, header, tint, seed, apex }
   *   kind      field material ('vellum' | 'iron' | 'leather' | 'stone')
   *   band      frame width in CSS px
   *   ornament  'heavy' | 'light' | 'none'
   */
  panel(canvas, cssW, cssH, o = {}) {
    const dpr = o.dpr ?? this.dpr;
    const W = Math.max(8, Math.round(cssW * dpr));
    const H = Math.max(8, Math.round(cssH * dpr));
    canvas.width = W; canvas.height = H;
    canvas.style.width = '100%'; canvas.style.height = '100%';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(dpr, dpr);
    const w = cssW, h = cssH;
    const seed = o.seed ?? 17;
    const band = o.band ?? Math.max(9, Math.min(w, h) * 0.055);
    const cham = o.chamfer ?? Math.min(26, Math.min(w, h) * 0.10);
    const field = o.kind ?? 'vellum';
    const frameMat = o.frame ?? 'iron';

    /* ---- 1. field ------------------------------------------------------ */
    ctx.save();
    chamferPath(ctx, band * 0.55, band * 0.55, w - band * 1.1, h - band * 1.1, Math.max(2, cham - band * 0.5));
    ctx.clip();
    this.material(ctx, 0, 0, w, h, field, { seed: seed + 3, scale: o.fieldScale ?? 1 });
    /* mid-frequency relief so the interior is a surface, not a gradient:
       cleaved facets on stone, swollen creases on hide, laid grain on vellum */
    /* ONE shared relief seed across every panel: the tile is the expensive
       asset in the whole atlas, and per-panel offsets + scales decorrelate it
       far more cheaply than generating a fresh field per panel would. */
    const roff = ((seed * 37) % 211) | 0;
    if (field === 'stone' || field === 'iron' || field === 'steel') {
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'overlay', alpha: 0.34, scale: 1.6 * (o.fieldScale ?? 1), offX: roff, offY: roff * 1.7 });
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'soft-light', alpha: 0.30, scale: 4.4 * (o.fieldScale ?? 1), offX: -roff * 2.3, offY: roff });
    } else if (field === 'leather') {
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'soft-light', alpha: 0.40, scale: 3.6 * (o.fieldScale ?? 1), offX: roff, offY: -roff * 1.3 });
    }
    // interior vignette: the field sits *below* the frame, so it darkens at the edge
    const vig = o.vignette ?? 0.62;
    const vg = ctx.createRadialGradient(w * 0.42, h * 0.30, Math.min(w, h) * 0.08,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
    vg.addColorStop(0, `rgba(255,246,220,${(o.fieldLift ?? 0.055).toFixed(3)})`);
    vg.addColorStop(0.58, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(0,0,0,${vig.toFixed(3)})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    /* --- the KEY on the field. A `source-over` warm wash can never lift a dark
       hide past its own alpha, which is why an interior reads as one flat value
       however much grain it carries. So the key goes on as two real screened
       glazes with crests — burnished wax on hide, polish on slate — and the fall
       away from the light goes on as its own darkening ramp. That pairing is what
       turns the interior into a lit surface instead of a printed fill. */
    const rake = o.rake ?? 0.045;
    const FIELDBOX = { x: 0, y: 0, w, h };
    this.glaze(ctx, null, FIELDBOX, {
      a: clamp01(rake * 3.6), tint: '255,240,208',
      cx: 0.10, cy: 0.05, wid: 0.66, len: 1.30, fall: 1.45,
    });
    this.glaze(ctx, null, FIELDBOX, {
      a: clamp01(rake * 2.1), tint: SPEC,
      cx: 0.05, cy: 0.02, wid: 0.22, len: 0.92, fall: 2.3,
    });
    const rk = ctx.createLinearGradient(0, 0, w * 0.82, h);
    rk.addColorStop(0, 'rgba(0,0,0,0)');
    rk.addColorStop(0.40, 'rgba(0,0,0,0.05)');
    rk.addColorStop(0.74, 'rgba(0,0,0,0.24)');
    rk.addColorStop(1, `rgba(0,0,0,${(o.fieldFall ?? 0.44).toFixed(3)})`);
    ctx.fillStyle = rk;
    ctx.fillRect(0, 0, w, h);

    /* a debossed heraldic sigil sunk into the field — large, low contrast, and
       lit from the same key, so the interior has authored structure at a scale
       the grain cannot provide */
    if (o.emblem !== false && Math.min(w, h) > 140) {
      const es = Math.min(w, h) * (o.emblemScale ?? 0.46);
      ctx.save();
      ctx.translate(w * 0.5, h * (o.emblemY ?? 0.5));
      ctx.globalAlpha = o.emblemA ?? 0.30;
      this._sigil(ctx, es, seed + 71);
      ctx.restore();
    }

    /* --- compartments. A panel interior that is one continuous field, however
       well grained, still reads as "a flat gradient with zero material" because
       nothing in it is at a different DEPTH. These are the sunken wells that hold
       a grid and the raised plaques that carry a stat block: each one is a real
       step in or out of the surface, with its own material, its own occlusion and
       its own lit lip. They are what give the interior authored structure and a
       value range instead of one mid-brown mass. */
    if (Array.isArray(o.wells) && o.wells.length) {
      const FBOX = { x: 0, y: 0, w, h };
      for (const wl of o.wells) {
        const x0 = wl.x * w, y0 = wl.y * h, ww = wl.w * w, hh = wl.h * h;
        if (!(ww > 4 && hh > 4)) continue;
        const c2 = wl.cham ?? Math.min(14, Math.min(ww, hh) * 0.12);
        const wp = new Path2D();
        pathChamfer(wp, x0, y0, ww, hh, c2);
        const raised = wl.raised === true;
        ctx.save();
        ctx.clip(wp);
        this.material(ctx, x0, y0, ww, hh, wl.mat ?? (raised ? 'vellum' : 'stone'), {
          seed: seed + (wl.seed ?? 97), scale: wl.scale ?? 0.42,
        });
        this.layer(ctx, raised ? 'crease' : 'relief', {
          seed: RELIEF_SEED, mode: 'overlay', alpha: raised ? 0.34 : 0.56,
          scale: raised ? 4.2 : 0.9, offX: 37, offY: 71,
        });
        if (!raised) {
          this.layer(ctx, 'relief', {
            seed: RELIEF_SEED, mode: 'soft-light', alpha: 0.44, scale: 3.4, offX: -83, offY: 29,
          });
        }
        /* a sunken well is dark at its up-left wall and lifts toward the far
           side; a raised plaque is the exact inverse */
        const dg = ctx.createLinearGradient(x0, y0, x0 + ww * 0.55, y0 + hh);
        if (raised) {
          /* A raised plaque still turns away from the key, but it is a plane in
             front of the surface, not a hole — it must not fall further than the
             field behind it. A 0.44 black here took a parchment sheet down to 0.21
             at its far corner, where ink on it stops being legible. */
          dg.addColorStop(0, 'rgba(255,248,222,0.26)');
          dg.addColorStop(0.30, 'rgba(255,242,210,0.08)');
          dg.addColorStop(0.72, 'rgba(0,0,0,0.05)');
          dg.addColorStop(1, 'rgba(0,0,0,0.20)');
        } else {
          dg.addColorStop(0, 'rgba(0,0,0,0.44)');
          dg.addColorStop(0.40, 'rgba(0,0,0,0.10)');
          dg.addColorStop(1, 'rgba(0,0,0,0.34)');
        }
        ctx.fillStyle = dg; ctx.fillRect(x0 - 2, y0 - 2, ww + 4, hh + 4);
        /* --- the well's own specular. A sunken bay is still a physical face and
           it is the largest single area in the whole panel, so it carries the
           interior's only chance of a real highlight: a raking glaze with a crest
           across its up-left third, and a hard glass line right on the lip where
           the surface turns. Without this the bay is a dark rectangle and the
           panel interior reads as "flat with zero material" no matter how much
           grain the fill has. */
        const WB = { x: x0, y: y0, w: ww, h: hh };
        const gz = wl.glaze ?? 1;
        if (gz > 0) {
          this.glaze(ctx, null, WB, {
            a: clamp01((raised ? 0.30 : 0.20) * gz), tint: raised ? '255,246,222' : '236,244,255',
            cx: 0.12, cy: 0.07, wid: raised ? 0.78 : 0.60, len: 1.24, fall: raised ? 1.3 : 1.6,
          });
          this.glaze(ctx, null, WB, {
            a: clamp01((raised ? 0.20 : 0.15) * gz), tint: SPEC,
            cx: 0.05, cy: 0.03, wid: 0.20, len: 0.86, fall: 2.4,
          });
        }
        if (raised) {
          this.sheen(ctx, null, WB,
            { a: 0.22, r: 0.50, squash: 0.34, cx: 0.22, cy: 0.18 });
          /* one flat lift across the sheet. `screen` raises the shadowed end of
             the plaque far more than its lit end, which keeps the whole plane
             inside the range that carries ink without flattening the light. */
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = 'rgba(198,180,146,0.10)';
          ctx.fillRect(x0 - 2, y0 - 2, ww + 4, hh + 4);
          ctx.restore();
        } else {
          /* the shadow the surrounding surface throws into the well */
          ctx.lineWidth = Math.max(2, c2 * 0.9);
          ctx.strokeStyle = 'rgba(0,0,0,0.62)';
          ctx.shadowColor = 'rgba(0,0,0,0.92)';
          ctx.shadowBlur = Math.max(3, c2 * 0.9);
          ctx.shadowOffsetX = c2 * 0.22; ctx.shadowOffsetY = c2 * 0.28;
          ctx.stroke(wp);
        }
        ctx.restore();
        ctx.lineWidth = Math.max(1.2, c2 * 0.14);
        ctx.strokeStyle = 'rgba(2,3,5,0.90)';
        ctx.stroke(wp);
        this.edgeBevel(ctx, wp, FBOX, raised
          ? { width: Math.max(1.4, c2 * 0.34), offset: Math.max(0.8, c2 * 0.17), hiA: 0.98, loA: 0.84 }
          : { mode: 'inset', width: Math.max(1.4, c2 * 0.34), offset: Math.max(0.8, c2 * 0.17), loA: 0.94, hiA: 0.50 });
        if (wl.gold !== false) {
          const gi = new Path2D();
          const gk = Math.max(1.4, c2 * 0.22);
          pathChamfer(gi, x0 + gk, y0 + gk, ww - gk * 2, hh - gk * 2, Math.max(1, c2 - gk));
          this.goldStroke(ctx, FBOX, Math.max(2.0, c2 * 0.22), gi,
            { specW: 0.40, specA: 0.98, wear: 0.44, seed: seed + 3 });
        }
        /* --- the framing metal's hard hits. Three, on the runs of the surround
           that turn squarely into the key: the up-left chamfer corner, the top
           rail and the left stile. A moulding whose brightest pixel is a 1-px
           stroke has no specular at panel scale — these are the pixels that make
           the bay read as metal-framed rather than drawn. */
        {
          const wpo = new Path2D();
          const ok = Math.max(1.2, c2 * 0.62);
          pathChamfer(wpo, x0 - ok, y0 - ok, ww + ok * 2, hh + ok * 2, c2 + ok);
          const surround = new Path2D();
          surround.addPath(wpo); surround.addPath(wp);
          ctx.save();
          ctx.clip(surround, 'evenodd');
          const hr = Math.max(2.4, c2 * 0.60);
          this.hotSpot(ctx, x0 + c2 * 0.34, y0 + c2 * 0.34, hr * 1.45,
            { a: 1.0, squash: 0.24, rot: -0.785, coreR: 0.26 });
          this.hotSpot(ctx, x0 + ww * 0.30, y0 - ok * 0.10, hr * 1.15,
            { a: 0.90, squash: 0.16, rot: 0, coreR: 0.22 });
          this.hotSpot(ctx, x0 - ok * 0.10, y0 + hh * 0.26, hr,
            { a: 0.70, squash: 0.16, rot: Math.PI * 0.5, coreR: 0.20 });
          this.glint(ctx, x0 + c2 * 0.34, y0 + c2 * 0.34, Math.max(5, c2 * 0.95),
            { a: 0.62, tint: SPEC_G, rot: -0.785 });
          ctx.restore();
        }
      }
    }

    /* saddle-stitch seam just inside the field edge: two rows of slanted
       stitches with a pricked hole under each, which is what tells the eye the
       field is hide stretched over the frame */
    if (field === 'leather' && o.stitch !== false) {
      const si = band * 0.55 + Math.max(4, band * 0.42);
      const sp = new Path2D();
      pathChamfer(sp, si, si, w - si * 2, h - si * 2, Math.max(2, cham - si * 0.8));
      ctx.save();
      ctx.lineCap = 'butt';
      ctx.setLineDash([Math.max(2.6, band * 0.26), Math.max(2.4, band * 0.24)]);
      ctx.lineWidth = Math.max(1.6, band * 0.15);
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.save(); ctx.translate(0.6, 0.9); ctx.stroke(sp); ctx.restore();
      ctx.lineWidth = Math.max(1.1, band * 0.10);
      ctx.strokeStyle = 'rgba(196,170,120,0.42)';
      ctx.stroke(sp);
      ctx.lineWidth = Math.max(0.7, band * 0.05);
      ctx.strokeStyle = this._falloff(ctx, { x: 0, y: 0, w, h }, SPEC, 0.60, 1, 1);
      ctx.save(); ctx.translate(-0.5, -0.7); ctx.stroke(sp); ctx.restore();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.restore();

    /* ---- 2. frame band ------------------------------------------------- */
    // Painting the band by clipping outer∖inner (canvas has no even-odd on two
    // separate paths without a Path2D, so build one).
    const outer = new Path2D();
    pathChamfer(outer, 0.5, 0.5, w - 1, h - 1, cham);
    const innerEdge = new Path2D();
    pathChamfer(innerEdge, band, band, w - band * 2, h - band * 2, Math.max(1, cham - band));
    const bandPath = new Path2D();
    bandPath.addPath(outer); bandPath.addPath(innerEdge);

    const BOX = { x: 0, y: 0, w, h };

    ctx.save();
    ctx.clip(bandPath, 'evenodd');
    /* the band is only ~15 px across, so its planishing has to be authored at
       ~5 px or the dents are wider than the moulding and the iron reads as
       smooth grey card. This scale is deliberately much finer than the field. */
    this.material(ctx, 0, 0, w, h, frameMat, { seed, scale: o.frameScale ?? 0.30 });
    // the band is a rolled moulding: its own cross-section shading, keyed to
    // the same upper-left light as everything else
    const bg = ctx.createLinearGradient(0, 0, w * 0.25, h);
    bg.addColorStop(0, 'rgba(255,244,220,0.16)');
    bg.addColorStop(0.16, 'rgba(255,240,208,0.05)');
    bg.addColorStop(0.52, 'rgba(0,0,0,0.14)');
    bg.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.restore();

    /* ---- 3. rims, grooves, contact shadow ------------------------------ */
    // outer dark rim + the hard specular that makes the frame a lit object.
    // The bright run is a NARROW chamfer, not a wide band: a wide one drowns the
    // hammered iron underneath and the frame goes back to reading as vector art.
    ctx.save();
    ctx.lineWidth = 2.6; ctx.strokeStyle = 'rgba(3,4,6,0.95)';
    ctx.stroke(outer);
    ctx.restore();
    this.edgeBevel(ctx, outer, BOX, {
      width: Math.max(2.2, band * 0.30), offset: Math.max(1.3, band * 0.16),
      hiA: 0.99, loA: 0.72, tightness: 1.06,
    });
    // a second, tighter run right on the lip: this is the bright pin-line that
    // separates the panel from the world behind it
    this.edgeBevel(ctx, outer, BOX, { width: Math.max(1.0, band * 0.075), offset: 0.6, hiA: 1.0, loA: 0.4 });

    /* The band is a MOULDING PROFILE, not a slab: chamfer, groove, astragal,
       hammered flat, bead, gold inlay. Alternating bright crest and dark groove
       is what makes 15 px of iron read as turned metal — a single wide bright
       band just reads as white card, which is how round 1 failed. */
    const moulding = (inset, lw, hiA = 0.96) => {
      const p = new Path2D();
      pathChamfer(p, inset, inset, w - inset * 2, h - inset * 2, Math.max(1, cham - inset));
      ctx.save();
      ctx.lineWidth = lw * 1.7;
      ctx.strokeStyle = 'rgba(0,0,0,0.58)';
      ctx.stroke(p);
      ctx.restore();
      this.edgeBevel(ctx, p, BOX, { width: lw, offset: lw * 0.56, hiA, loA: 0.58 });
      return p;
    };
    /* one bead, set INSIDE the astragal that follows — two more mouldings out at
       band*0.20 and band*0.42 would be painted over by it */
    moulding(Math.max(3.0, band * 0.58), Math.max(1.4, band * 0.14), 0.96);

    /* --- re-assert the metal OVER the bevel strokes. Every crest above was
       painted as a smooth gradient stroke; without this pass the whole moulding
       reads as three grey plastic ribs. Overlaying the planishing + tarnish at
       the band's own scale breaks the crests into forged metal, and the
       multiply-tarnish puts grime in the grooves where it collects. */
    ctx.save();
    ctx.clip(bandPath, 'evenodd');
    this.layer(ctx, 'hammer', { seed, mode: 'overlay', alpha: 0.48, scale: 0.30 });
    this.layer(ctx, 'brush', { seed: seed + 21, mode: 'overlay', alpha: 0.30, scale: 0.22 });
    this.layer(ctx, 'tarnish', { seed: seed + 7, mode: 'multiply', alpha: 0.40, scale: 1.1 });
    this.layer(ctx, 'craze', { seed: seed + 31, mode: 'multiply', alpha: 0.26, scale: 0.7 });
    /* and the hard hits: three discrete specular pops where the moulding turns
       squarely into the key light. These are the pixels that read as polished
       iron rather than as a light-grey fill. */
    const hr = Math.max(3.4, band * 0.62);
    for (const [hx, hy, ha, hs] of [
      [band * 0.52, h * 0.16, 1.0, 0.20],
      [w * 0.19, band * 0.50, 0.98, 0.20],
      [band * 0.52, h * 0.44, 0.72, 0.18],
      [w * 0.46, band * 0.50, 0.70, 0.18],
      [band * 0.52, h * 0.70, 0.44, 0.16],
    ]) {
      this.hotSpot(ctx, hx, hy, hr, {
        a: ha, squash: hs, rot: hy < band * 1.2 ? 0 : Math.PI * 0.5, coreR: 0.22,
      });
    }
    ctx.restore();

    /* --- the ASTRAGAL: a broad polished half-round turned into the band. This
       is the one piece of the frame with real area at real specular brightness —
       a panel whose brightest pixel is a 2 px pin-line has "not one specular
       highlight in the entire UI", which is exactly how round 1 read. It runs
       near-white where it faces the key and to true black where it turns away,
       so widening it adds contrast rather than milkiness. */
    {
      const a0 = Math.max(2.0, band * 0.09), a1 = Math.max(a0 + 2.4, band * 0.56);
      const ao = new Path2D(); pathChamfer(ao, a0, a0, w - a0 * 2, h - a0 * 2, Math.max(1, cham - a0));
      const ai = new Path2D(); pathChamfer(ai, a1, a1, w - a1 * 2, h - a1 * 2, Math.max(1, cham - a1));
      const ring = new Path2D(); ring.addPath(ao); ring.addPath(ai);
      ctx.save();
      ctx.clip(ring, 'evenodd');
      /* the body of the half-round: a mid steel that already carries the key's
         falloff, so the run is bright where it faces the light and true black
         where it turns away. NOT near-white across its whole width — that is
         white card, and it is what the moulding must not become. */
      const ag = ctx.createLinearGradient(0, 0, w * 0.86, h * 0.94);
      ag.addColorStop(0, 'rgba(226,231,239,0.95)');
      ag.addColorStop(0.10, 'rgba(174,183,196,0.86)');
      ag.addColorStop(0.26, 'rgba(104,113,126,0.72)');
      ag.addColorStop(0.48, 'rgba(38,45,53,0.78)');
      ag.addColorStop(0.74, 'rgba(11,14,19,0.90)');
      ag.addColorStop(1, 'rgba(2,3,5,0.96)');
      ctx.fillStyle = ag; ctx.fillRect(0, 0, w, h);
      /* forged, not chromed. On a light base `overlay` barely bites, so the
         planishing has to go through as MULTIPLY to break the run up at all. */
      this.layer(ctx, 'hammer', { seed: seed + 5, mode: 'multiply', alpha: 0.30, scale: 0.22 });
      this.layer(ctx, 'hammer', { seed: seed + 5, mode: 'overlay', alpha: 0.30, scale: 0.22 });
      this.layer(ctx, 'brush', { seed: seed + 23, mode: 'multiply', alpha: 0.22, scale: 0.14 });
      this.layer(ctx, 'tarnish', { seed: seed + 41, mode: 'multiply', alpha: 0.44, scale: 0.9 });
      this.layer(ctx, 'craze', { seed: seed + 47, mode: 'multiply', alpha: 0.24, scale: 0.6 });
      /* and the crest of the half-round, right along its middle: a wide warm run
         plus a narrow full-white pin inside it */
      const am = (a0 + a1) * 0.5;
      const amid = new Path2D();
      pathChamfer(amid, am, am, w - am * 2, h - am * 2, Math.max(1, cham - am));
      const doff = Math.max(0.7, (a1 - a0) * 0.26);
      ctx.save();
      ctx.translate(-LKEY.x * doff, -LKEY.y * doff);
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.2, (a1 - a0) * 0.62);
      ctx.strokeStyle = this._falloff(ctx, BOX, SPEC, 0.96, 1, 1.16);
      ctx.stroke(amid);
      ctx.lineWidth = Math.max(0.8, (a1 - a0) * 0.26);
      ctx.strokeStyle = this._falloff(ctx, BOX, '255,255,255', 1.0, 1, 1.30);
      ctx.stroke(amid);
      ctx.restore();
      /* the shadow flank, so the half-round has a back */
      ctx.save();
      ctx.translate(LKEY.x * doff * 1.2, LKEY.y * doff * 1.2);
      ctx.lineWidth = Math.max(1.0, (a1 - a0) * 0.42);
      ctx.strokeStyle = this._falloff(ctx, BOX, '0,0,0', 0.80, -1, 1.0);
      ctx.stroke(amid);
      ctx.restore();
      ctx.restore();
      /* the groove that separates the astragal from the flat inside it */
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      ctx.lineWidth = Math.max(1.0, band * 0.10);
      ctx.strokeStyle = 'rgba(0,0,0,0.80)';
      ctx.stroke(ai);
      ctx.restore();
      this.edgeBevel(ctx, ai, BOX, {
        mode: 'inset', width: Math.max(1.0, band * 0.12), offset: 0.6, loA: 0.85, hiA: 0.34,
      });
    }

    // gold inlay hairline just inside the band, with its own specular
    if (o.inlay !== false) {
      const gin = band - 1.5;
      const gi = new Path2D();
      pathChamfer(gi, gin, gin, w - gin * 2, h - gin * 2, Math.max(1, cham - band + 1.5));
      /* a rolled half-round of leaf: dark cut under, worn body, hard crest over.
         Wider than a hairline so the cross-section is actually visible. */
      this.goldStroke(ctx, BOX, Math.max(2.4, band * 0.20), gi, { specW: 0.34, tightness: 1.1 });
      /* two glints where the torus turns into the light — gold with no glint is
         a brown line, and that was the round-1 read */
      ctx.save();
      ctx.clip(outer);
      this.glint(ctx, gin + cham * 0.30, gin + cham * 0.30, Math.max(5, band * 0.95),
        { a: 0.86, tint: SPEC_G, rot: -0.78 });
      this.glint(ctx, w * 0.30, gin + 0.5, Math.max(4, band * 0.72), { a: 0.62, tint: SPEC_G });
      this.glint(ctx, gin + 0.5, h * 0.34, Math.max(4, band * 0.72), { a: 0.56, tint: SPEC_G, rot: 1.57 });
      ctx.restore();
    }

    // inner recess: the field is sunk, so it gets a shadow from the frame
    const ip = new Path2D();
    pathChamfer(ip, band, band, w - band * 2, h - band * 2, Math.max(1, cham - band));
    ctx.save();
    ctx.clip(ip);
    ctx.lineWidth = band * 0.9;
    ctx.strokeStyle = 'rgba(0,0,0,0.66)';
    ctx.shadowColor = 'rgba(0,0,0,0.94)';
    ctx.shadowBlur = band * 0.95;
    ctx.shadowOffsetY = band * 0.18;
    ctx.stroke(ip);
    ctx.restore();
    // ...and the far lip of that recess catches the bounce, which is what makes
    // the field read as BELOW the frame rather than pasted onto it
    this.edgeBevel(ctx, ip, BOX, {
      mode: 'inset', width: Math.max(1.6, band * 0.20), loA: 0.92, hiA: 0.50,
    });

    /* ---- 4. rivets ----------------------------------------------------- */
    if ((o.ornament ?? 'heavy') !== 'none') {
      const rr = Math.max(2.6, band * 0.30);
      const pts = rivetRing(w, h, band, cham, o.rivetGap ?? Math.max(34, band * 3.2));
      for (const p of pts) this.rivet(ctx, p[0], p[1], rr, seed + p[2]);
    }

    /* ---- 5. corner filigree -------------------------------------------- */
    if ((o.ornament ?? 'heavy') === 'heavy') {
      const fs = Math.min(w, h) * (o.filigree ?? 0.16);
      /* big enough to actually read: a 20 px scroll at panel scale is a scribble */
      const gsz = Math.max(26, Math.min(96, fs));
      for (let q = 0; q < 4; q++) {
        ctx.save();
        const fx = q === 0 || q === 3 ? band * 0.9 : w - band * 0.9;
        const fy = q < 2 ? band * 0.9 : h - band * 0.9;
        ctx.translate(fx, fy);
        ctx.scale(q === 0 || q === 3 ? 1 : -1, q < 2 ? 1 : -1);
        this.filigree(ctx, gsz, seed + q * 13);
        ctx.restore();
      }
    }

    /* ---- 6. header cartouche ------------------------------------------- */
    if (o.header) {
      const hh = o.headerH ?? Math.max(24, h * 0.062);
      const hy = band * 0.9;
      const hx = band * 1.3;
      const hw = w - hx * 2;
      ctx.save();
      const hp = new Path2D();
      pathChamfer(hp, hx, hy, hw, hh, hh * 0.42);
      ctx.save(); ctx.clip(hp);
      /* the cartouche is a slab of cut stone let into the frame — it must show
         its own cleaved facets, or it is a black bar with a gold outline */
      this.material(ctx, hx, hy, hw, hh, 'stone', { seed: seed + 61, scale: 0.30 });
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'overlay', alpha: 0.42, scale: 0.55, offX: 91, offY: 33 });
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'soft-light', alpha: 0.34, scale: 1.7, offX: -47 });
      const hg = ctx.createLinearGradient(0, hy, 0, hy + hh);
      hg.addColorStop(0, 'rgba(0,0,0,0.64)');
      hg.addColorStop(0.30, 'rgba(0,0,0,0.14)');
      hg.addColorStop(0.62, 'rgba(0,0,0,0.30)');
      hg.addColorStop(1, 'rgba(0,0,0,0.74)');
      ctx.fillStyle = hg; ctx.fillRect(hx, hy, hw, hh);
      /* a raking light along the slab so the sunk plate is not one flat value */
      this.sheen(ctx, null, { x: hx, y: hy, w: hw, h: hh },
        { a: 0.18, r: 0.42, squash: 0.34, cx: 0.20, cy: 0.26 });
      ctx.restore();
      // the cartouche is set in a cast gold surround — the brightest metal on
      // the panel, because it is what the eye is meant to find first
      ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke(hp);
      this.goldStroke(ctx, BOX, Math.max(2.0, hh * 0.105), hp, { specW: 0.40, specA: 0.98, tightness: 0.9 });
      // an engraved fillet just inside it
      const hpi = new Path2D();
      pathChamfer(hpi, hx + hh * 0.16, hy + hh * 0.16, hw - hh * 0.32, hh - hh * 0.32, hh * 0.30);
      ctx.lineWidth = 1.1; ctx.strokeStyle = 'rgba(0,0,0,0.62)'; ctx.stroke(hpi);
      this.edgeBevel(ctx, hpi, BOX, { mode: 'inset', width: 1.1, offset: 0.6, loA: 0.7, hiA: 0.5 });
      // little gold pips at the cartouche ends, pulled outward so a centred
      // title never collides with them
      const gr = hh * 0.17;
      this.gem(ctx, hx + gr * 2.4, hy + hh * 0.5, gr, o.headerGem ?? '#b8352c');
      this.gem(ctx, hx + hw - gr * 2.4, hy + hh * 0.5, gr, o.headerGem ?? '#b8352c');
      ctx.restore();
    }

    /* ---- 7. grunge + top sheen over everything ------------------------- */
    ctx.save();
    ctx.clip(outer);
    this.layer(ctx, 'craze', { seed: seed + 99, mode: 'multiply', alpha: 0.16, scale: 2.6 });
    const sh = ctx.createLinearGradient(0, 0, 0, h);
    sh.addColorStop(0, 'rgba(255,248,226,0.055)');
    sh.addColorStop(0.10, 'rgba(255,248,226,0.0)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, w, h);
    ctx.restore();

    ctx.restore();
    return canvas;
  }

  /* --------------------------------------------------------------- pieces */

  /**
   * A debossed heraldic sigil — sunk cut below, catch-light above, so it reads
   * as struck into the field. Used as the large low-contrast structure inside a
   * panel interior.
   */
  _sigil(ctx, s, seed = 3) {
    /* NB: `arm` contributes a sub-path to the caller's *open* path — it must not
       call beginPath(), or each arm wipes the previous one and the cross fleury
       collapses to a single leaf. */
    const arm = (a, len, wid) => {
      ctx.save(); ctx.rotate(a);
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(wid, -len * 0.30, wid * 0.62, -len * 0.74, 0, -len);
      ctx.bezierCurveTo(-wid * 0.62, -len * 0.74, -wid, -len * 0.30, 0, 0);
      ctx.closePath();
      ctx.restore();
    };
    const shape = (c2) => {
      // a four-armed cross fleury inside a ring, with lancet spurs
      for (let i = 0; i < 4; i++) arm(i * Math.PI * 0.5, s * 0.46, s * 0.085);
      for (let i = 0; i < 4; i++) arm(i * Math.PI * 0.5 + Math.PI * 0.25, s * 0.28, s * 0.045);
      c2.moveTo(s * 0.40, 0);
      c2.arc(0, 0, s * 0.40, 0, TAU);
      c2.moveTo(s * 0.345, 0);
      c2.arc(0, 0, s * 0.345, 0, TAU, true);
    };
    for (const pass of [0, 1]) {
      ctx.save();
      ctx.translate(pass ? -s * 0.012 : s * 0.014, pass ? -s * 0.014 : s * 0.016);
      ctx.beginPath();
      shape(ctx);
      ctx.fillStyle = pass
        ? `rgba(${SPEC},0.34)`
        : 'rgba(0,0,0,0.62)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    // the body itself, barely there — it is a deboss, not a decal
    ctx.beginPath(); shape(ctx);
    ctx.fillStyle = 'rgba(24,20,14,0.30)';
    ctx.fill('evenodd');
    void seed;
  }

  /** A domed rivet, lit upper-left, with its own contact shadow. */
  rivet(ctx, x, y, r, seed = 0) {
    ctx.save();
    ctx.translate(x, y);
    // seat: a pressed collar with occlusion under the head
    ctx.beginPath(); ctx.arc(0, 0, r * 1.42, 0, TAU);
    const sg = ctx.createRadialGradient(r * 0.20, r * 0.24, r * 0.4, 0, 0, r * 1.42);
    sg.addColorStop(0, 'rgba(0,0,0,0.78)');
    sg.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = sg; ctx.fill();
    // dome
    const g = ctx.createRadialGradient(-r * 0.40, -r * 0.46, r * 0.04, 0, 0, r * 1.06);
    g.addColorStop(0, '#e9eef4');
    g.addColorStop(0.22, '#a9b2bd');
    g.addColorStop(0.58, '#565e67');
    g.addColorStop(0.86, '#22272c');
    g.addColorStop(1, '#0d1013');
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = g; ctx.fill();
    // bounce from below
    ctx.beginPath(); ctx.arc(0, 0, r * 0.90, Math.PI * 0.15, Math.PI * 0.85);
    ctx.lineWidth = Math.max(0.6, r * 0.18);
    ctx.strokeStyle = 'rgba(214,182,116,0.40)'; ctx.stroke();
    // tarnish speck
    const t = hash2(Math.round(x), Math.round(y), seed);
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    ctx.arc(r * (t - 0.5) * 0.8, r * (hash2(3, 7, seed) - 0.5) * 0.8, r * 0.30, 0, TAU);
    ctx.fillStyle = '#2a1f12'; ctx.fill();
    ctx.restore();
    // the specular: a domed steel head *must* carry a hard hotspot or it reads
    // as a printed circle
    this.hotSpot(ctx, -r * 0.36, -r * 0.42, r * 0.52, { a: 0.98, squash: 0.74, coreR: 0.30 });
    ctx.restore();
  }

  /**
   * A polished cabochon gem: gold collet with its own bevel, a deep body, an
   * internal glow that lights the stone from within, a hard cabochon specular
   * with a solid core, and light refracted through to the far rim.
   */
  gem(ctx, x, y, r, colour = '#b8352c', o = {}) {
    const [cr, cg3, cb] = hex2rgb(colour);
    const litA = (k, add, a) => `rgba(${Math.min(255, cr * k + add) | 0},${Math.min(255, cg3 * k + add) | 0},${Math.min(255, cb * k + add) | 0},${a})`;
    const lit = (k, add = 0) => litA(k, add, 1);
    ctx.save();
    ctx.translate(x, y);
    const R = r * 1.36;
    // --- collet ring
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU);
    const gc = ctx.createRadialGradient(-r * 0.5, -r * 0.6, r * 0.1, 0, 0, R);
    gc.addColorStop(0, '#f8ecc4');
    gc.addColorStop(0.34, '#c19a48');
    gc.addColorStop(0.74, '#6b4f1d');
    gc.addColorStop(1, '#191308');
    ctx.fillStyle = gc; ctx.fill();
    ctx.lineWidth = Math.max(0.7, r * 0.13);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
    const colletPath = new Path2D();
    colletPath.arc(0, 0, R, 0, TAU);
    this.edgeBevel(ctx, colletPath, { x: -R, y: -R, w: R * 2, h: R * 2 }, {
      width: Math.max(1, r * 0.26), hi: SPEC_G, hiA: 0.95, loA: 0.7,
    });
    // --- internal glow: the stone is lit from inside, so the body is brighter
    // than its surroundings and throws colour onto the collet
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const ig = ctx.createRadialGradient(0, r * 0.10, 0, 0, r * 0.10, r * 1.5);
    ig.addColorStop(0, rgba(colour, 0.85));
    ig.addColorStop(0.42, rgba(colour, 0.32));
    ig.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = ig;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.5, 0, TAU); ctx.fill();
    ctx.restore();
    // --- gem body
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
    const gb = ctx.createRadialGradient(r * 0.20, r * 0.34, r * 0.04, -r * 0.10, -r * 0.16, r * 1.24);
    gb.addColorStop(0, lit(1.55, 46));
    gb.addColorStop(0.40, colour);
    gb.addColorStop(0.80, lit(0.32));
    gb.addColorStop(1, lit(0.12));
    ctx.fillStyle = gb; ctx.fill();
    // --- caustic: light that passed through the dome and pooled on the far side
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.ellipse(r * 0.26, r * 0.34, r * 0.44, r * 0.28, -0.6, 0, TAU);
    const cg = ctx.createRadialGradient(r * 0.26, r * 0.34, 0, r * 0.26, r * 0.34, r * 0.50);
    cg.addColorStop(0, litA(1.9, 70, 0.72));
    cg.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = cg; ctx.fill();
    ctx.restore();
    // --- cabochon specular, with a solid core
    this.hotSpot(ctx, -r * 0.33, -r * 0.39, r * 0.46, { a: 0.99, squash: 0.62, coreR: 0.40 });
    if (o.glint !== false && r >= 4.2) this.glint(ctx, -r * 0.33, -r * 0.39, r * 1.05, { a: 0.52, rot: -0.5 });
    // --- refracted rim on the shadow side
    ctx.beginPath(); ctx.arc(0, 0, r * 0.93, Math.PI * 0.06, Math.PI * 0.74);
    ctx.lineWidth = Math.max(0.6, r * 0.14);
    ctx.strokeStyle = `rgba(${Math.min(255, cr + 110)},${Math.min(255, cg3 + 96)},${Math.min(255, cb + 96)},0.62)`;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * A corner filigree scroll: logarithmic spirals + acanthus leaves, in worn
   * gold. Drawn at the origin, opening down-right; the caller mirrors it.
   */
  filigree(ctx, s, seed = 5) {
    const r = this.engine?.freshRand ? this.engine.freshRand(seed) : (() => 0.5);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const spiral = (ox, oy, a, b, t0, t1, rot, lw, col) => {
      ctx.beginPath();
      const N = 40;
      for (let i = 0; i <= N; i++) {
        const t = lerp(t0, t1, i / N);
        const rr = a * Math.exp(b * t);
        const px = ox + Math.cos(t + rot) * rr;
        const py = oy + Math.sin(t + rot) * rr;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.lineWidth = lw;
      ctx.strokeStyle = col;
      ctx.stroke();
    };

    const leaf = (ox, oy, len, wid, rot, col) => {
      ctx.save();
      ctx.translate(ox, oy); ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(len * 0.30, -wid, len * 0.72, -wid * 0.72, len, 0);
      ctx.bezierCurveTo(len * 0.72, wid * 0.42, len * 0.30, wid * 0.28, 0, 0);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    };

    // dark cut, then the leaf, then the specular running along the lit side of
    // every scroll — gold ornament with no highlight is just a brown line
    for (const pass of [0, 1, 2]) {
      ctx.save();
      if (pass === 0) ctx.translate(0.9, 1.2);
      if (pass === 2) ctx.translate(-0.7, -0.9);
      const gold = pass === 0 ? 'rgba(0,0,0,0.72)' : null;
      const grad = ctx.createLinearGradient(0, 0, s, s);
      grad.addColorStop(0, '#f8ecc4');
      grad.addColorStop(0.35, '#c9a24c');
      grad.addColorStop(0.7, '#7d5c1f');
      grad.addColorStop(1, '#4a3512');
      const spec = this._falloff(ctx, { x: 0, y: 0, w: s, h: s }, SPEC_G, 0.97, 1, 1.05);
      const col = pass === 2 ? spec : (gold ?? grad);
      const lw = Math.max(1.1, s * 0.055) * (pass === 2 ? 0.42 : 1);

      spiral(s * 0.16, s * 0.16, s * 0.055, 0.31, 0, 5.4, 0.9, lw, col);
      spiral(s * 0.60, s * 0.20, s * 0.032, 0.30, 0, 4.4, 2.4, lw * 0.8, col);
      spiral(s * 0.20, s * 0.62, s * 0.032, 0.30, 0, 4.4, 0.7, lw * 0.8, col);
      // connecting stem
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.16);
      ctx.bezierCurveTo(s * 0.42, s * 0.10, s * 0.56, s * 0.13, s * 0.62, s * 0.20);
      ctx.moveTo(s * 0.16, s * 0.16);
      ctx.bezierCurveTo(s * 0.10, s * 0.42, s * 0.13, s * 0.56, s * 0.20, s * 0.62);
      ctx.lineWidth = lw * 0.9; ctx.strokeStyle = col; ctx.stroke();

      const lc = gold ?? '#b08b38';
      leaf(s * 0.30, s * 0.11, s * 0.26, s * 0.085, 0.16, lc);
      leaf(s * 0.11, s * 0.30, s * 0.26, s * 0.085, 1.41, lc);
      leaf(s * 0.46, s * 0.44, s * 0.20, s * 0.07, 0.78, lc);
      ctx.restore();
    }
    ctx.restore();
  }

  /* -------------------------------------------------------------- sockets */

  /**
   * Recessed octagonal socket used by the ability bar and inventory grid.
   *
   * Anatomy, from the outside in: a cast metal collar with a hard specular on
   * its up-left faces; a gold inlay lip; then a *recess* whose up-left inner
   * face is occluded and whose down-right inner face catches the bounce. That
   * inversion is the whole reason an empty slot reads as a hole in a metal
   * plate rather than a dark rounded square.
   */
  socketURI(size, o = {}) {
    const seed = o.seed ?? 23;
    const key = `socket:${o.tag ?? 'a'}:${seed}:${o.cham ?? 0.22}:${o.rim ?? 1}:${o.metal ?? 'iron'}:v3`;
    return this.uri(key, size, size, (ctx, W, H) => {
      const s = W;
      const BOX = { x: 0, y: 0, w: s, h: s };
      const cham = s * (o.cham ?? 0.22);
      const band = s * (o.band ?? 0.11);
      /* Detail budget by size. A 96 px tile shown in a 41 px inventory cell can
         carry ~4 authored px per profile step; a 240 px ability socket can carry
         a full moulding. Authoring the same six-step profile at both sizes is why
         the grid collar collapsed into one flat pale band — every step was under
         a display pixel and the box filter averaged them into their mean. */
      const big = s >= 132;
      const outer = new Path2D(); pathChamfer(outer, 1, 1, s - 2, s - 2, cham);
      const inner = new Path2D(); pathChamfer(inner, band, band, s - band * 2, s - band * 2, Math.max(1, cham - band));

      // ---- recess: cut stone, deeply occluded toward the light side
      ctx.save(); ctx.clip(inner);
      this.material(ctx, 0, 0, s, s, o.recess ?? 'stone', { seed: seed + 4, scale: 0.55, spec: 0.4 });
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'overlay', alpha: 0.54, scale: 0.62 });
      this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'soft-light', alpha: 0.40, scale: 1.9, offX: 29, offY: 13 });
      /* the well's floor: near-black where the collar shades it (up-left) and a
         warm bounce pooling on the far wall (down-right). That inversion across
         the hole is the inset bevel's whole read. */
      const rg = ctx.createRadialGradient(s * 0.66, s * 0.74, s * 0.04, s * 0.5, s * 0.5, s * 0.82);
      rg.addColorStop(0, 'rgba(150,134,104,0.40)');
      rg.addColorStop(0.30, 'rgba(58,56,54,0.36)');
      rg.addColorStop(0.58, 'rgba(6,8,11,0.70)');
      rg.addColorStop(1, 'rgba(0,0,0,0.97)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, s, s);
      // shadow cast into the well by the collar, from the upper-left
      ctx.lineWidth = band * 1.10;
      ctx.strokeStyle = 'rgba(0,0,0,0.80)';
      ctx.shadowColor = 'rgba(0,0,0,0.97)'; ctx.shadowBlur = band * 1.05;
      ctx.shadowOffsetX = band * 0.30; ctx.shadowOffsetY = band * 0.38;
      ctx.stroke(inner);
      ctx.restore();
      /* ---- the INSET BEVEL at the well lip. Wider and harder than the collar's
         own chamfer, and inverted against it: occlusion where the lip faces the
         key (up-left), warm bounce where it turns away (down-right). Read across
         the hole that inversion is the single cue that says "socket cut into a
         plate" instead of "dark rounded square". */
      this.edgeBevel(ctx, inner, BOX, {
        mode: 'inset',
        loW: Math.max(2.0, band * 0.95), loOff: Math.max(1.1, band * 0.48), loA: 1.0,
        hiW: Math.max(1.0, band * 0.30), hiOff: Math.max(0.6, band * 0.16), hiA: 0.72,
      });
      /* and a hard occlusion arc right under the lip's up-left face, so the
         shadow does not depend on the falloff gradient alone surviving downscale */
      ctx.save();
      ctx.clip(inner);
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.4, band * 0.42);
      ctx.save();
      ctx.translate(-LKEY.x * band * 0.30, -LKEY.y * band * 0.30);
      ctx.strokeStyle = this._falloff(ctx, BOX, '0,0,0', 0.95, 1, 1.25);
      ctx.stroke(inner);
      ctx.restore();
      ctx.restore();

      // ---- collar band
      const bandPath = new Path2D(); bandPath.addPath(outer); bandPath.addPath(inner);
      ctx.save(); ctx.clip(bandPath, 'evenodd');
      /* the collar is 10 px wide at cell size: its planishing has to be authored
         at ~3 px or the dents are wider than the metal they sit on */
      this.material(ctx, 0, 0, s, s, o.metal ?? 'iron', { seed, scale: 0.14, spec: 0.32 });
      /* Keep the BODY of the collar dark forged metal. A specular only reads as
         specular against something that is not already bright: the previous pass
         screened a 15 px near-white ramp over an 11 px band, so the whole collar
         sat at 0.87 and the frame read as pale card. */
      const bg = ctx.createLinearGradient(0, 0, s * 0.66, s);
      bg.addColorStop(0, 'rgba(224,230,240,0.10)');
      bg.addColorStop(0.26, 'rgba(0,0,0,0.18)');
      bg.addColorStop(0.62, 'rgba(0,0,0,0.52)');
      bg.addColorStop(1, 'rgba(0,0,0,0.86)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, s, s);
      /* the chamfer, lit per run: a NARROW near-white crest along the top rail and
         left stile, and the whole opposite flank taken to true black. Narrow and
         hot beats wide and pale — it is the contrast across the profile, not the
         area of pale, that makes 77 of these read as cast metal framing. */
      /* The chamfer FACE, not a pin-line. It has to be wide enough to survive the
         box filter down to the cell size with its value intact: 2 authored px of
         white in a 96 px tile shown at 41 px is 0.85 px on screen and averages
         away to the mid grey of its neighbours, which is why round 2's "specular"
         measured p99 0.84 with no pixel over 0.96 anywhere in the grid. ~7 px
         here lands ~3 px of genuine near-white on every socket. */
      this.runLight(ctx, band * 0.66, BOX, {
        hi: 1.0, lo: 0.95, crest: 0.36, tail: 0.44, edgeA: 0.88,
        loBand: band * 1.02, tint: '255,253,247',
      });
      /* the QUIRK groove immediately inside the chamfer face. Bright crest → dark
         quirk → dark flat → gold bead → lip is a moulding profile; a single bright
         run with nothing beside it is a painted outline however hot it is. */
      {
        const q = new Path2D();
        const qi = band * 0.72;
        pathChamfer(q, qi, qi, s - qi * 2, s - qi * 2, Math.max(1, cham - qi));
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(1.0, band * 0.26);
        ctx.strokeStyle = this._falloff(ctx, BOX, '0,0,0', 0.86, 1, 1.05);
        ctx.stroke(q);
        ctx.restore();
      }
      /* forged, not chromed: the planishing goes back over the crest, so the
         bright run is broken metal rather than a smooth white stroke */
      this.layer(ctx, 'hammer', { seed: seed + 5, mode: 'multiply', alpha: 0.30, scale: 0.10 });
      this.layer(ctx, 'hammer', { seed: seed + 5, mode: 'overlay', alpha: 0.36, scale: 0.10 });
      this.layer(ctx, 'brush', { seed: seed + 23, mode: 'overlay', alpha: 0.26, scale: 0.08 });
      this.layer(ctx, 'tarnish', { seed: seed + 41, mode: 'multiply', alpha: 0.36, scale: 0.55 });
      ctx.restore();

      ctx.lineWidth = Math.max(1.6, s * 0.012); ctx.strokeStyle = 'rgba(4,5,7,0.96)'; ctx.stroke(outer);
      // the collar's raised outer chamfer: this is the bright metal framing. Wide
      // enough to carry real area at specular brightness — a 1-px pin-line is a
      // drawn outline, not a lit chamfer.
      this.edgeBevel(ctx, outer, BOX, {
        hiW: Math.max(2.4, band * 0.54), hiOff: Math.max(1.2, band * 0.27), hiA: 1.0,
        loW: Math.max(2.0, band * 0.60), loOff: Math.max(1.0, band * 0.30), loA: 0.95,
        tightness: 1.10,
      });
      this.edgeBevel(ctx, outer, BOX, { width: Math.max(1.0, s * 0.010), offset: 0.6, hiA: 1.0, loA: 0.40 });
      /* gold inlay bead on the inner third of the collar. Kept OFF the outer
         chamfer on purpose: run out there it lightens the whole rim and the
         chamfer's own crest stops being the brightest thing on the frame. */
      const lip = new Path2D();
      const li = band * (big ? 0.66 : 0.76);
      pathChamfer(lip, li, li, s - li * 2, s - li * 2, Math.max(1, cham - li));
      this.goldStroke(ctx, BOX, Math.max(1.3, s * (big ? 0.017 : 0.013)), lip,
        { specW: 0.44, specA: 1.0, wear: 0.46, tightness: 1.15 });

      /* the hard hits on the collar: discrete specular pops where the chamfer
         turns squarely into the key. An empty slot with no specular anywhere on
         its rim is the "identical rounded-square black slot" the round-1 grid was
         called out for — the bevel alone is not enough, the metal has to be shiny.
         Each has a SOLID core: a lobe that only reaches 60% white is fog. */
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      const chr = Math.max(2.0, band * 0.80);
      this.hotSpot(ctx, cham * 0.44, cham * 0.44, chr * 1.55, { a: 1.0, squash: 0.26, rot: -0.785, coreR: 0.30 });
      this.hotSpot(ctx, s * 0.40, band * 0.40, chr * 1.15, { a: 0.94, squash: 0.17, rot: 0, coreR: 0.26 });
      this.hotSpot(ctx, s * 0.68, band * 0.40, chr * 0.85, { a: 0.70, squash: 0.15, rot: 0, coreR: 0.22 });
      this.hotSpot(ctx, band * 0.40, s * 0.44, chr * 1.05, { a: 0.80, squash: 0.17, rot: Math.PI * 0.5, coreR: 0.24 });
      this.hotSpot(ctx, band * 0.40, s * 0.70, chr * 0.80, { a: 0.52, squash: 0.15, rot: Math.PI * 0.5, coreR: 0.20 });
      if (s >= 60) this.glint(ctx, cham * 0.44, cham * 0.44, band * 1.9, { a: 0.72, rot: -0.785 });
      ctx.restore();

      if (o.rim !== 0 && s >= 96) {
        const rr = Math.max(1.5, s * 0.038);
        const inset = band * 0.52;
        for (const [px, py] of [[inset + cham * 0.3, inset + cham * 0.3],
          [s - inset - cham * 0.3, inset + cham * 0.3],
          [inset + cham * 0.3, s - inset - cham * 0.3],
          [s - inset - cham * 0.3, s - inset - cham * 0.3]]) {
          this.rivet(ctx, px, py, rr, seed + px);
        }
      }
      // ---- a glass cover over the well: a raking band with a crest, plus the
      // hard line right on the glass's up-left edge. Real slots in D4 are glazed
      // and that reflection is what stops an empty slot being a black square.
      this.glaze(ctx, inner, BOX, { a: 0.15, wid: 0.66, len: 1.15, cx: 0.14, cy: 0.08, fall: 1.7 });
      this.glaze(ctx, inner, BOX, { a: 0.22, wid: 0.12, len: 0.70, cx: 0.05, cy: 0.02, fall: 3.0 });
    });
  }

  /**
   * The rarity frame that sits *over* an occupied slot: a chamfered collar in
   * the rarity's own metal, a hard specular on its light-facing faces, a socket
   * glow bleeding inward from the rim, and gem pips at the corners. Replaces the
   * 1-px coloured outline, which is the tell that a slot grid was made in CSS.
   */
  rarityFrameURI(size, r, o = {}) {
    const key = `rarf:${r.key}:${o.tag ?? 'a'}:${o.cham ?? 0.22}:${o.band ?? 0.055}:${o.pips ? 1 : 0}:v3`;
    return this.uri(key, size, size, (ctx, W) => {
      const s = W;
      const BOX = { x: 0, y: 0, w: s, h: s };
      const cham = s * (o.cham ?? 0.22);
      /* wide enough to hold a cross-section. A 1.5 px collar can only ever be a
         coloured outline no matter how it is shaded. */
      const band = Math.max(3.0, s * (o.band ?? 0.055) * 1.32);
      const ring = (inset) => {
        const p = new Path2D();
        pathChamfer(p, inset, inset, s - inset * 2, s - inset * 2, Math.max(1, cham - inset));
        return p;
      };
      const outer = ring(1.0);
      const inner = ring(band);
      const [lr, lg, lb] = hex2rgb(r.line);
      /* the rarity's own specular: the metal's hue pushed most of the way to
         white, so a gold bezel highlights warm and a cobalt one highlights cool */
      const RSPEC = `${Math.min(255, lr + 150) | 0},${Math.min(255, lg + 150) | 0},${Math.min(255, lb + 142) | 0}`;

      /* ---- the SOCKET GLOW: the item's own light spilling out of the well and
         washing up the inside of the collar. Two runs — a wide soft bleed that
         puts the rarity's hue on the well wall, and a tight hot line right at the
         lip — plus a pool low and right where the light collects. Left as a rim
         only, the rarity read as a printed coloured outline. */
      ctx.save();
      ctx.clip(inner);
      ctx.globalCompositeOperation = 'screen';
      /* wide soft bleed up the well wall... */
      ctx.lineWidth = band * 0.42;
      ctx.strokeStyle = rgba(r.glow, 0.20);
      ctx.shadowColor = rgba(r.glow, 0.62);
      ctx.shadowBlur = band * 0.50;
      ctx.stroke(inner);
      /* ...and the hot line right at the lip. Kept HARD to the rim: at 0.85 band
         with a 0.95 blur the bleed reached the middle of a 41 px cell and every
         occupied slot read as one flat sheet of coloured plastic with an icon
         floating on it. The well behind an item stays dark. */
      ctx.lineWidth = band * 0.34;
      ctx.strokeStyle = rgba(r.line, 0.58);
      ctx.shadowBlur = band * 0.34;
      ctx.stroke(inner);
      ctx.restore();

      /* ---- the collar body: cast metal in the rarity's alloy, NOT a flat fill.
         The ramp runs along the key-light axis so the down-right run of the
         collar falls to near-black — that inversion across a 5 px band is the
         whole reason it reads as a turned bezel. */
      const bandPath = new Path2D(); bandPath.addPath(outer); bandPath.addPath(inner);
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      /* the alloy body is the rarity hue *cut with iron* — a saturated pastel ring
         reads as painted plastic; the colour has to sit at a metal's value and let
         the specular carry the brightness */
      const bgm = ctx.createLinearGradient(0, 0, s * 0.80, s * 0.92);
      bgm.addColorStop(0, mixc(r.line, '#2d333b', 0.42));
      bgm.addColorStop(0.22, mixc(r.line, '#1a1e24', 0.54));
      bgm.addColorStop(0.52, mixc(r.glow, '#0c0f13', 0.58));
      bgm.addColorStop(0.80, mixc(r.deep, '#04060a', 0.54));
      bgm.addColorStop(1, '#020305');
      ctx.fillStyle = bgm; ctx.fillRect(0, 0, s, s);
      this.layer(ctx, 'brush', { seed: 61, mode: 'overlay', alpha: 0.44, scale: 0.14 });
      this.layer(ctx, 'hammer', { seed: 29, mode: 'overlay', alpha: 0.40, scale: 0.08 });
      this.layer(ctx, 'hammer', { seed: 29, mode: 'multiply', alpha: 0.22, scale: 0.08 });
      this.layer(ctx, 'tarnish', { seed: 67, mode: 'multiply', alpha: 0.38, scale: 0.45 });
      /* the alloy's chamfer, lit per run in the rarity's own specular so a gold
         bezel highlights warm and a cobalt one cool. NARROW crest, WIDE shadow —
         a 1.35-band lit run at 0.62 lifted the entire bezel to one pastel value,
         which is the "flat coloured tile" read. */
      this.runLight(ctx, band * 0.46, BOX, {
        hi: 0.98, lo: 0.92, crest: 0.34, tail: 0.30, edgeA: 0.42,
        loBand: band * 1.05, tint: RSPEC,
      });
      ctx.restore();

      /* ---- profile. Outer contact line, then the CREST: a narrow run of the
         alloy's own specular along the faces turned to the key, then the groove
         at the collar's inner shoulder, then the lip bounce. */
      ctx.lineWidth = Math.max(1.1, s * 0.010);
      ctx.strokeStyle = 'rgba(2,3,5,0.95)';
      ctx.stroke(outer);

      /* crest — sits on the outer third of the band. The strokes are OFFSET along
         ±LKEY and clipped to the band, so a run only survives on the faces whose
         normal actually turns toward (or away from) the key. Stroking the ring
         with a plain distance falloff instead lights the bottom edge as brightly
         as the top, and that is precisely what makes a bezel read as a printed
         outline rather than a turned chamfer. */
      const crest = ring(band * 0.24);
      const off = Math.max(0.7, band * 0.26);
      const dx = -LKEY.x * off, dy = -LKEY.y * off;
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      ctx.lineJoin = 'round';
      ctx.save(); ctx.translate(dx, dy);
      ctx.lineWidth = Math.max(1.4, band * 0.40);
      ctx.strokeStyle = this._falloff(ctx, BOX, RSPEC, 1.0, 1, 1.10);
      ctx.stroke(crest);
      /* a full-white pin inside the alloy crest. The rarity's own specular is a
         tinted near-white; the pin is the actual mirror reflection of the key and
         is what puts an occupied cell's brightest pixel above the empty one's. */
      ctx.lineWidth = Math.max(0.9, band * 0.15);
      ctx.strokeStyle = this._falloff(ctx, BOX, SPEC, 1.0, 1, 1.22);
      ctx.stroke(crest);
      ctx.restore();
      /* ...and the occluded run on the shadow side, so the collar has a back. It
         is WIDER than the crest: the whole far flank of a turned bezel is in
         shade, only the chamfer face itself catches. */
      ctx.save(); ctx.translate(-dx * 1.5, -dy * 1.5);
      ctx.lineWidth = Math.max(1.3, band * 0.62);
      ctx.strokeStyle = this._falloff(ctx, BOX, '0,0,0', 0.94, -1, 0.95);
      ctx.stroke(crest);
      ctx.restore();
      /* the pin-line right on the lip: full specular, sub-pixel narrow */
      const lip = ring(1.9);
      ctx.lineWidth = Math.max(0.9, s * 0.011);
      ctx.save(); ctx.translate(dx * 0.30, dy * 0.30);
      ctx.strokeStyle = this._falloff(ctx, BOX, SPEC, 1.0, 1, 1.18);
      ctx.stroke(lip);
      ctx.restore();
      ctx.restore();

      /* groove between collar and well */
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      ctx.lineWidth = Math.max(1.0, band * 0.24);
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.stroke(ring(band * 0.82));
      ctx.restore();

      /* the well's lip: occluded where it faces the key, and only a DIM bounce on
         the far side. A near-white bounce here lights the bottom edge as hard as
         the crest and the bezel stops reading as a raised collar. */
      this.edgeBevel(ctx, inner, BOX, {
        mode: 'inset',
        loW: Math.max(1.2, band * 0.52), loOff: Math.max(0.6, band * 0.24), loA: 0.96,
        hiW: Math.max(0.8, band * 0.20), hiOff: Math.max(0.4, band * 0.10), hiA: 0.44,
        hi: hex2rgb(r.line).join(','),
      });

      /* ---- the hard hits. On the corners and rails where the chamfer turns
         squarely into the light. This is the "shiny" the round-1 pass had none
         of, and a cell without one reads as printed. */
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      const hr = Math.max(1.8, band * 0.72);
      // on the chamfer face, running ALONG it — a round blob at the corner point
      // reads as a paint smear, a squashed streak reads as a lit chamfer
      this.hotSpot(ctx, cham * 0.44, cham * 0.44, hr * 1.50, { a: 1.0, squash: 0.26, rot: -0.785, coreR: 0.30 });
      this.hotSpot(ctx, s * 0.40, band * 0.38, hr * 1.10, { a: 0.92, squash: 0.17, rot: 0, coreR: 0.26 });
      this.hotSpot(ctx, s * 0.68, band * 0.38, hr * 0.80, { a: 0.62, squash: 0.15, rot: 0, coreR: 0.20 });
      this.hotSpot(ctx, band * 0.38, s * 0.44, hr * 1.00, { a: 0.76, squash: 0.17, rot: Math.PI * 0.5, coreR: 0.24 });
      if (s >= 60) {
        this.glint(ctx, cham * 0.44, cham * 0.44, band * 1.50, { a: 0.74, tint: SPEC, rot: -0.785 });
      }
      ctx.restore();

      /* corner pips: four tiny cabochons in the rarity colour */
      if (o.pips === true) {
        const pr = Math.max(1.8, s * 0.030);
        const q = band * 0.92 + cham * 0.18;
        for (const [px, py] of [[q, q], [s - q, q], [q, s - q], [s - q, s - q]]) {
          this.gem(ctx, px, py, pr, r.line, { glint: false });
        }
      }
    });
  }

  /* ---------------------------------------------------------------- versal */

  /**
   * An ORNAMENTAL CAPITAL ("versal") — the letter a display face would carry,
   * built procedurally instead of downloaded.
   *
   * The critic asked for a self-hosted woff2 display face. The project forbids
   * external font files and network fetches outright, so the display *feel* is
   * manufactured here: the letterform comes from the OS inscriptional-serif
   * stack, and everything that makes a display face look expensive is then
   * authored on top of it as material — a dark cut sunk under the stroke, worn
   * gold leaf across its face, planishing and tarnish through the leaf, a hard
   * near-white crest along the side that turns into the key, and a star glint
   * where the leaf catches. That is a genuinely lit gold object rather than
   * coloured text with a shadow, and it is the one place in the interface where
   * the type itself carries specular.
   *
   * `plate:true` additionally sinks it into a chamfered stone lozenge with a
   * cast gold collar, for use as a true drop-capital.
   */
  versalURI(size, ch, o = {}) {
    const seed = o.seed ?? 19;
    const font = o.font ?? `'Trajan Pro','Copperplate','Optima',Palatino,Georgia,serif`;
    const key = `versal:${ch}:${o.tag ?? 'a'}:${seed}:${o.plate ? 1 : 0}:${o.tint ?? 'gold'}`;
    return this.uri(key, size, size, (ctx, W) => {
      const s = W;
      const BOX = { x: 0, y: 0, w: s, h: s };

      /* ---- optional sunken lozenge behind the letter */
      let plate = null;
      if (o.plate === true) {
        plate = new Path2D();
        pathChamfer(plate, s * 0.05, s * 0.05, s * 0.90, s * 0.90, s * 0.24);
        ctx.save(); ctx.clip(plate);
        this.material(ctx, 0, 0, s, s, 'stone', { seed: seed + 7, scale: 0.30 });
        this.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'overlay', alpha: 0.46, scale: 0.48, offX: 17 });
        const vg = ctx.createRadialGradient(s * 0.34, s * 0.30, s * 0.03, s * 0.5, s * 0.5, s * 0.74);
        vg.addColorStop(0, 'rgba(104,92,70,0.30)');
        vg.addColorStop(0.48, 'rgba(6,7,10,0.46)');
        vg.addColorStop(1, 'rgba(0,0,0,0.92)');
        ctx.fillStyle = vg; ctx.fillRect(0, 0, s, s);
        ctx.restore();
        this.edgeBevel(ctx, plate, BOX, {
          mode: 'inset',
          loW: Math.max(1.6, s * 0.055), loOff: Math.max(0.9, s * 0.026), loA: 0.96,
          hiW: Math.max(0.9, s * 0.020), hiOff: Math.max(0.5, s * 0.010), hiA: 0.62,
        });
        this.goldStroke(ctx, BOX, Math.max(1.8, s * 0.042), plate,
          { specW: 0.42, specA: 1.0, wear: 0.44, seed });
      }

      /* ---- the letterform as a mask. Canvas 2D cannot hand back text as a
         Path2D, so the glyph is rasterised once into its own layer and every
         material term is then masked to it with source-in / source-atop. */
      const em = Math.round(s * (o.plate === true ? 0.60 : 0.86));
      const msk = this.cv(s, s);
      const mc = msk.getContext('2d');
      mc.font = `${o.weight ?? 600} ${em}px ${font}`;
      mc.textAlign = 'center';
      mc.textBaseline = 'alphabetic';
      mc.fillStyle = '#fff';
      const bx = s * 0.5, by = s * (o.plate === true ? 0.76 : 0.90);
      mc.fillText(String(ch), bx, by);

      /* the dark cut the stroke is sunk into */
      const cut = this.cv(s, s);
      const cc = cut.getContext('2d');
      cc.drawImage(msk, 0, 0);
      cc.globalCompositeOperation = 'source-in';
      cc.fillStyle = 'rgba(4,3,2,0.95)';
      cc.fillRect(0, 0, s, s);

      /* the leaf */
      const leaf = this.cv(s, s);
      const lc = leaf.getContext('2d');
      lc.drawImage(msk, 0, 0);
      lc.globalCompositeOperation = 'source-in';
      const gg = lc.createLinearGradient(0, 0, s * 0.82, s);
      if (o.tint === 'iron') {
        gg.addColorStop(0, '#f4f8fd'); gg.addColorStop(0.18, '#bcc6d3');
        gg.addColorStop(0.46, '#69737f'); gg.addColorStop(0.76, '#2a323a');
        gg.addColorStop(1, '#0a0d11');
      } else {
        gg.addColorStop(0, '#fff6d6'); gg.addColorStop(0.18, '#eccb7c');
        gg.addColorStop(0.46, '#b28c3c'); gg.addColorStop(0.74, '#6b4d18');
        gg.addColorStop(1, '#2a1d08');
      }
      lc.fillStyle = gg; lc.fillRect(0, 0, s, s);
      /* wear and planishing THROUGH the leaf: gold with a smooth fill is a
         highlighter stroke, gold with tarnish in its hollows is metal */
      lc.globalCompositeOperation = 'multiply';
      this.layer(lc, 'tarnish', { seed: seed + 13, mode: 'multiply', alpha: 0.40, scale: 0.22 });
      this.layer(lc, 'hammer', { seed: seed + 5, mode: 'overlay', alpha: 0.34, scale: 0.10 });
      this.layer(lc, 'craze', { seed: seed + 31, mode: 'multiply', alpha: 0.22, scale: 0.16 });
      /* the key, masked to the letterform */
      lc.globalCompositeOperation = 'source-atop';
      this.glaze(lc, null, BOX, {
        a: 0.40, mode: 'source-atop', tint: SPEC_G,
        cx: 0.10, cy: 0.06, wid: 0.34, len: 1.24, fall: 1.5,
      });
      this.glaze(lc, null, BOX, {
        a: 0.34, mode: 'source-atop', tint: SPEC,
        cx: 0.05, cy: 0.02, wid: 0.11, len: 0.82, fall: 2.6,
      });
      lc.globalCompositeOperation = 'source-atop';
      this.hotSpot(lc, s * 0.30, s * 0.26, s * 0.13, { a: 1.0, squash: 0.34, rot: -0.62, coreR: 0.38, tint: SPEC });
      this.hotSpot(lc, s * 0.58, s * 0.52, s * 0.075, { a: 0.72, squash: 0.42, rot: -0.62, coreR: 0.28, tint: SPEC_G });
      /* trim to the letterform: canvas blend modes composite alpha as
         source-over, so the tarnish/planishing passes above also painted the
         transparent pixels around the glyph */
      lc.globalCompositeOperation = 'destination-in';
      lc.drawImage(msk, 0, 0);

      /* ---- assemble: cut first, offset away from the key, then the leaf with a
         soft contact shadow so the letter sits proud of the plate */
      ctx.save();
      ctx.globalAlpha = 0.92;
      ctx.drawImage(cut, Math.max(1, s * 0.016), Math.max(1, s * 0.022));
      ctx.restore();
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.78)';
      ctx.shadowBlur = Math.max(2, s * 0.030);
      ctx.shadowOffsetX = s * 0.012;
      ctx.shadowOffsetY = s * 0.016;
      ctx.drawImage(leaf, 0, 0);
      ctx.restore();
      /* the glint — the cheapest "expensive" cue, and the reason the initial
         reads as struck metal rather than as a coloured glyph */
      this.glint(ctx, s * 0.30, s * 0.26, s * 0.24, { a: 0.80, tint: SPEC, rot: -0.52 });

      /* ---- acanthus spurs flanking the letter */
      if (o.flourish !== false) {
        const fs = s * 0.30;
        ctx.save(); ctx.translate(s * 0.015, s * 0.03); ctx.scale(0.9, 0.9);
        this.filigree(ctx, fs, seed + 3);
        ctx.restore();
        ctx.save(); ctx.translate(s * 0.985, s * 0.97); ctx.scale(-0.9, -0.9);
        this.filigree(ctx, fs, seed + 11);
        ctx.restore();
      }
    });
  }

  /**
   * Shade an alpha mask as struck gold (or steel) leaf: worn leaf body, tarnish
   * and planishing through it, a raking glaze with a crest, and hard hits.
   * Returns a new canvas; the mask is not modified.
   */
  _gild(msk, W, H, o = {}) {
    const seed = o.seed ?? 19;
    const BOX = { x: 0, y: 0, w: W, h: H };
    const out = this.cv(W, H);
    const lc = out.getContext('2d');
    lc.drawImage(msk, 0, 0);
    lc.globalCompositeOperation = 'source-in';
    /* The ramp axis is STEEP, not diagonal: a letter's cross-section runs top to
       bottom, so every glyph in a line needs the same bright-crown-to-dark-foot
       gradient. A corner-to-corner ramp across a wide line instead lights the
       first letter and takes the last one to black, which reads as a lighting
       error rather than as leaf. The gentle left-to-right fall comes after, as
       its own term. */
    const gy0 = o.gy0 ?? 0;
    const gy1 = o.gy1 ?? H * 1.30;
    /* PURELY VERTICAL by default. A canvas linear gradient parameterises by the
       projection onto its own axis vector, so giving the endpoint any appreciable
       x-extent on a wide raster exhausts the whole ramp within the first couple of
       letters and everything after them clamps to the darkest stop — which is
       exactly why the line read as two bright letters followed by dull bronze.
       The left-to-right fall is a separate term (`fall`) that cannot do that. */
    const gg = lc.createLinearGradient(0, gy0, W * (o.axis ?? 0), gy1);
    if (o.tint === 'iron') {
      gg.addColorStop(0, '#f8fbff'); gg.addColorStop(0.20, '#c8d2de');
      gg.addColorStop(0.50, '#7a8492'); gg.addColorStop(0.78, '#333c45');
      gg.addColorStop(1, '#10141a');
    } else {
      gg.addColorStop(0, '#fffbec'); gg.addColorStop(0.26, '#f8e2aa');
      gg.addColorStop(0.56, '#dfb964'); gg.addColorStop(0.84, '#a8842f');
      gg.addColorStop(1, '#6b4f1a');
    }
    lc.fillStyle = gg; lc.fillRect(0, 0, W, H);
    /* the fall along the line, away from a key at the upper left */
    lc.globalCompositeOperation = 'source-atop';
    const hz = lc.createLinearGradient(0, 0, W, 0);
    hz.addColorStop(0, 'rgba(255,250,232,0.12)');
    hz.addColorStop(0.42, 'rgba(0,0,0,0)');
    hz.addColorStop(1, `rgba(0,0,0,${(o.fall ?? 0.30).toFixed(2)})`);
    lc.fillStyle = hz; lc.fillRect(0, 0, W, H);
    lc.globalCompositeOperation = 'source-over';
    this.layer(lc, 'tarnish', { seed: seed + 13, mode: 'multiply', alpha: o.wear ?? 0.24, scale: 0.16 });
    this.layer(lc, 'hammer', { seed: seed + 5, mode: 'overlay', alpha: 0.32, scale: 0.07 });
    this.layer(lc, 'craze', { seed: seed + 31, mode: 'multiply', alpha: o.craze ?? 0.12, scale: 0.12 });
    lc.globalCompositeOperation = 'source-atop';
    this.glaze(lc, null, BOX, {
      a: o.glazeA ?? 0.42, mode: 'source-atop', tint: SPEC_G,
      cx: o.gcx ?? 0.08, cy: 0.04, wid: o.gwid ?? 0.46,
      len: o.glen ?? 1.26, fall: o.gfall ?? 1.35,
    });
    this.glaze(lc, null, BOX, {
      a: o.pinA ?? 0.36, mode: 'source-atop', tint: SPEC,
      cx: (o.gcx ?? 0.08) * 0.5, cy: 0.01, wid: (o.gwid ?? 0.46) * 0.32,
      len: (o.glen ?? 1.26) * 0.68, fall: (o.gfall ?? 1.35) * 1.7,
    });
    lc.globalCompositeOperation = 'source-atop';
    for (const [fx, fy, fr, fa] of (o.hits ?? [[0.16, 0.30, 0.16, 1.0], [0.52, 0.34, 0.10, 0.72], [0.82, 0.36, 0.085, 0.52]])) {
      this.hotSpot(lc, W * fx, H * fy, Math.max(2, Math.min(W, H) * fr * 1.5),
        { a: fa, squash: 0.40, rot: -0.62, coreR: 0.36, tint: fa > 0.9 ? SPEC : SPEC_G });
    }
    /* TRIM back to the letterforms. Canvas separable blend modes ('multiply',
       'overlay', 'soft-light') composite their ALPHA as source-over, so a
       pattern fill in one of those modes paints over transparent pixels as well
       as blending with opaque ones — the texture passes above would otherwise
       leave a full-canvas grey field around the type. */
    lc.globalCompositeOperation = 'destination-in';
    lc.drawImage(msk, 0, 0);
    return out;
  }

  /**
   * A whole display line, set as struck gold leaf.
   *
   * This is where the interface's "display face" comes from. There is no woff2 —
   * the project forbids external font files — so the line is composed here glyph
   * by glyph out of the OS inscriptional-serif stack, with the letterspacing,
   * the weight and the initial's scale step all set explicitly, and then gilded
   * as real metal: a dark cut sunk under every stroke, worn leaf on the face,
   * planishing and tarnish through it, a raking crest, three hard hits and a
   * star glint on the versal. Coloured text with a drop shadow cannot do that,
   * and it is what "nothing in it is shiny" was pointing at.
   *
   * Returns `{ uri, w, h }` so the caller can size the element to the raster's
   * own aspect and never stretch the letterforms.
   */
  titleURI(text, o = {}) {
    const font = o.font ?? `'Trajan Pro','Copperplate','Optima',Palatino,Georgia,serif`;
    const weight = o.weight ?? 600;
    const em = o.em ?? 44;
    const em1 = o.em1 ?? em * (o.step ?? 1.58);
    const ls = o.ls ?? 0.22;
    const str = String(text);
    const seed = o.seed ?? 19;

    /* measure first so the raster is exactly the line's own box */
    const mm = this.cv(8, 8).getContext('2d');
    const advance = (i) => {
      const sz = i === 0 ? em1 : em;
      mm.font = `${weight} ${sz}px ${font}`;
      return mm.measureText(str[i]).width + sz * ls;
    };
    let total = 0;
    for (let i = 0; i < str.length; i++) total += advance(i);
    total -= em * ls * 0.5;                       // trailing letterspace
    /* the raster is the line's own cap box plus one glint radius of air, so the
       caller can size the element by height and get a predictable cap height */
    const padX = Math.round(em1 * 0.22);
    const padY = Math.round(em1 * 0.10);
    const bold = em * (o.bold ?? 0.055);          // synthetic weight, see below
    const W = Math.max(8, Math.ceil(total + padX * 2 + bold));
    const H = Math.max(8, Math.ceil(em1 * 0.86 + padY * 2));
    const base = Math.round(H - padY);

    const uri = this.uri(`title:${str}:${em}:${em1}:${ls}:${o.tint ?? 'gold'}:${weight}`, W, H, (ctx) => {
      /* ---- the letterforms as one alpha mask */
      const msk = this.cv(W, H);
      const mc = msk.getContext('2d');
      mc.textAlign = 'left';
      mc.textBaseline = 'alphabetic';
      mc.fillStyle = '#fff';
      mc.strokeStyle = '#fff';
      mc.lineJoin = 'round';
      let x = padX + bold * 0.5;
      for (let i = 0; i < str.length; i++) {
        const sz = i === 0 ? em1 : em;
        mc.font = `${weight} ${sz}px ${font}`;
        /* SYNTHETIC WEIGHT. The OS inscriptional stacks resolve to comparatively
           light faces (Optima, Palatino) on most machines, and a hairline stem
           has nowhere to put a cross-section — the leaf, the cut and the crest
           all collapse into one line. Stroking the outline before filling it
           thickens every stem by a fixed amount, which is exactly what a display
           cut of the same face would have. */
        if (bold > 0.2) { mc.lineWidth = sz * (o.bold ?? 0.055); mc.strokeText(str[i], x, base); }
        mc.fillText(str[i], x, base);
        x += mc.measureText(str[i]).width + sz * ls;
      }
      /* ---- the cut sunk under the strokes */
      const cut = this.cv(W, H);
      const cc = cut.getContext('2d');
      cc.drawImage(msk, 0, 0);
      cc.globalCompositeOperation = 'source-in';
      cc.fillStyle = 'rgba(3,3,2,0.96)';
      cc.fillRect(0, 0, W, H);
      /* ---- leaf */
      /* a line is a long thin object: its raking crest has to run the whole way
         along it, not fall off in the first third the way a square boss does */
      const leaf = this._gild(msk, W, H, {
        seed, tint: o.tint, fall: 0.12, wear: 0.18, craze: 0.08,
        /* the ramp is fitted to the BODY letters' own cap box, so a capital runs
           crown-to-foot across the leaf's full range wherever it sits in the line.
           Fitted to the raster instead, a 74 px tall strip put every body letter
           in the bottom half of the ramp and the whole line read as dull bronze. */
        gy0: base - em * 0.81, gy1: base + em * 0.27,
        glazeA: 0.38, pinA: 0.30, gcx: 0.04, gwid: 0.72, glen: 1.02, gfall: 0.42,
        hits: [[0.10, 0.30, 0.13, 1.0], [0.34, 0.28, 0.075, 0.72],
          [0.60, 0.30, 0.065, 0.60], [0.84, 0.30, 0.055, 0.46]],
      });
      const d = Math.max(1, em * 0.030);
      ctx.save(); ctx.globalAlpha = 0.94;
      ctx.drawImage(cut, d, d * 1.35);
      ctx.restore();
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.80)';
      ctx.shadowBlur = Math.max(2, em * 0.09);
      ctx.shadowOffsetX = em * 0.028;
      ctx.shadowOffsetY = em * 0.040;
      ctx.drawImage(leaf, 0, 0);
      ctx.restore();
      /* ---- the versal's own star glint, on its upper-left shoulder */
      if (o.glint !== false) {
        this.glint(ctx, padX + em1 * 0.26, base - em1 * 0.52, em1 * 0.30,
          { a: 0.78, tint: SPEC, rot: -0.52 });
      }
    });
    return { uri, w: W, h: H };
  }

  /* ------------------------------------------------------------ orb parts */

  /** Ornate orb bezel — transparent centre so the liquid shows through. */
  orbBezelURI(size, o = {}) {
    const seed = o.seed ?? 31;
    return this.uri(`orb:${o.tag ?? 'hp'}:${seed}`, size, size, (ctx, W) => {
      const s = W, c = s * 0.5;
      const rOut = s * 0.485;
      const rIn = s * 0.372;

      // ---- outer ring, hammered iron with gold inlay
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rOut, 0, TAU);
      ctx.arc(c, c, rIn, 0, TAU, true);
      ctx.clip();
      this.material(ctx, 0, 0, s, s, 'iron', { seed, scale: 0.55 });
      const lg = ctx.createLinearGradient(0, 0, s * 0.28, s);
      lg.addColorStop(0, 'rgba(255,246,220,0.40)');
      lg.addColorStop(0.22, 'rgba(255,240,210,0.10)');
      lg.addColorStop(0.55, 'rgba(0,0,0,0.10)');
      lg.addColorStop(1, 'rgba(0,0,0,0.66)');
      ctx.fillStyle = lg; ctx.fillRect(0, 0, s, s);
      // radial flutes — each is a little cylindrical rib, so it carries its own
      // crest highlight, and the ribs that face the key light get a hot one
      const N = o.flutes ?? 24;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        // how squarely this rib faces the upper-left key
        const nl = clamp01(0.5 + (Math.cos(a) * LKEY.x + Math.sin(a) * LKEY.y) * 0.92);
        ctx.save(); ctx.translate(c, c); ctx.rotate(a);
        ctx.globalCompositeOperation = 'overlay';
        const fg = ctx.createLinearGradient(rIn, 0, rOut, 0);
        fg.addColorStop(0, 'rgba(0,0,0,0.34)');
        fg.addColorStop(0.5, `rgba(255,255,255,${(0.10 + 0.34 * nl).toFixed(3)})`);
        fg.addColorStop(1, 'rgba(0,0,0,0.30)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        const hw = (TAU / N) * 0.30;
        ctx.moveTo(Math.cos(-hw) * rIn, Math.sin(-hw) * rIn);
        ctx.lineTo(Math.cos(-hw) * rOut, Math.sin(-hw) * rOut);
        ctx.lineTo(Math.cos(hw) * rOut, Math.sin(hw) * rOut);
        ctx.lineTo(Math.cos(hw) * rIn, Math.sin(hw) * rIn);
        ctx.closePath(); ctx.fill();
        // the crest specular on the ribs turned toward the light
        if (nl > 0.52) {
          ctx.globalCompositeOperation = 'source-over';
          const sg2 = ctx.createLinearGradient(rIn, 0, rOut, 0);
          sg2.addColorStop(0, `rgba(${SPEC},0)`);
          sg2.addColorStop(0.46, `rgba(${SPEC},${(0.98 * (nl - 0.52) / 0.48).toFixed(3)})`);
          sg2.addColorStop(1, `rgba(${SPEC},0)`);
          ctx.fillStyle = sg2;
          ctx.beginPath();
          const hw2 = hw * 0.36;
          ctx.moveTo(Math.cos(-hw2) * rIn, Math.sin(-hw2) * rIn);
          ctx.lineTo(Math.cos(-hw2) * rOut, Math.sin(-hw2) * rOut);
          ctx.lineTo(Math.cos(hw2) * rOut, Math.sin(hw2) * rOut);
          ctx.lineTo(Math.cos(hw2) * rIn, Math.sin(hw2) * rIn);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();

      // ---- hard rims
      const ring = (r, lw, col, dy = 0) => {
        ctx.save(); ctx.translate(0, dy);
        ctx.beginPath(); ctx.arc(c, c, r, 0, TAU);
        ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
        ctx.restore();
      };
      ring(rOut, 2.4, 'rgba(3,4,6,0.95)');
      ring(rIn, 2.6, 'rgba(2,3,5,0.95)');
      // the bezel's raised outer chamfer and its sunk inner lip, both keyed to
      // the upper-left light
      const oRing = new Path2D(); oRing.arc(c, c, rOut, 0, TAU);
      const iRing = new Path2D(); iRing.arc(c, c, rIn, 0, TAU);
      const OB = { x: c - rOut, y: c - rOut, w: rOut * 2, h: rOut * 2 };
      this.edgeBevel(ctx, oRing, OB, { width: Math.max(2, s * 0.018), offset: s * 0.008, hiA: 0.98, loA: 0.66 });
      this.edgeBevel(ctx, oRing, OB, { width: Math.max(1, s * 0.006), offset: 0.6, hiA: 1.0, loA: 0.3 });
      // gold torus on the inner lip
      const goldRing = new Path2D(); goldRing.arc(c, c, rIn + s * 0.016, 0, TAU);
      this.goldStroke(ctx, OB, Math.max(2, s * 0.022), goldRing, { specW: 0.40, specA: 0.98 });
      // three discrete highlights where the moulding turns toward the light
      for (const [ax, aa] of [[-2.42, 1.0], [-1.86, 0.72], [-2.95, 0.6]]) {
        const rr = (rOut + rIn) * 0.5;
        this.hotSpot(ctx, c + Math.cos(ax) * rr, c + Math.sin(ax) * rr, s * 0.052,
          { a: 0.92 * aa, squash: 0.40, rot: ax + Math.PI * 0.5, coreR: 0.30 });
      }

      // ---- inner lip shadow onto the liquid
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU); ctx.clip();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU);
      ctx.lineWidth = s * 0.05;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = s * 0.05;
      ctx.shadowOffsetY = s * 0.012;
      ctx.stroke();
      ctx.restore();

      // ---- crown: gem + wings at the top, buttress at the bottom
      const gemR = s * 0.072;
      ctx.save();
      // wings
      for (const sgn of [-1, 1]) {
        ctx.save();
        ctx.translate(c, c);
        ctx.scale(sgn, 1);
        ctx.rotate(-Math.PI * 0.5);
        ctx.translate(0, 0);
        ctx.beginPath();
        ctx.moveTo(rOut * 0.02, -rOut * 0.99);
        ctx.bezierCurveTo(s * 0.14, -rOut * 1.02, s * 0.20, -rOut * 0.80, s * 0.155, -rOut * 0.66);
        ctx.bezierCurveTo(s * 0.13, -rOut * 0.76, s * 0.09, -rOut * 0.86, rOut * 0.02, -rOut * 0.86);
        ctx.closePath();
        const wg = ctx.createLinearGradient(0, -rOut, s * 0.2, -rOut * 0.6);
        wg.addColorStop(0, '#d9c081'); wg.addColorStop(0.5, '#8d6c2c'); wg.addColorStop(1, '#3d2c10');
        ctx.fillStyle = wg; ctx.fill();
        ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      this.gem(ctx, c, c - rOut * 0.97, gemR, o.gem ?? '#b8352c');
      // bottom buttress
      ctx.save();
      ctx.translate(c, c + rOut * 0.93);
      ctx.beginPath();
      ctx.moveTo(-s * 0.075, 0);
      ctx.lineTo(s * 0.075, 0);
      ctx.lineTo(s * 0.042, s * 0.062);
      ctx.lineTo(-s * 0.042, s * 0.062);
      ctx.closePath();
      const pg = ctx.createLinearGradient(0, 0, 0, s * 0.062);
      pg.addColorStop(0, '#7b838d'); pg.addColorStop(1, '#171b1f');
      ctx.fillStyle = pg; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
      ctx.restore();

      // ---- rivets around the ring
      const nr = o.rivets ?? 8;
      for (let i = 0; i < nr; i++) {
        const a = -Math.PI * 0.5 + (i + 0.5) * (TAU / nr);
        const rr = (rOut + rIn) * 0.5;
        this.rivet(ctx, c + Math.cos(a) * rr, c + Math.sin(a) * rr, s * 0.026, seed + i);
      }
    });
  }

  /** The dark cavity behind the liquid. */
  orbCavityURI(size, o = {}) {
    return this.uri(`orbcav:${o.tag ?? 'a'}`, size, size, (ctx, W) => {
      const s = W, c = s * 0.5, r = s * 0.5;
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.clip();
      this.material(ctx, 0, 0, s, s, 'stone', { seed: 57, scale: 0.6 });
      const g = ctx.createRadialGradient(c - r * 0.22, c - r * 0.28, r * 0.05, c, c, r);
      g.addColorStop(0, 'rgba(28,30,36,0.35)');
      g.addColorStop(0.55, 'rgba(6,7,9,0.82)');
      g.addColorStop(1, 'rgba(0,0,0,0.97)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      ctx.restore();
    });
  }

  /**
   * Spherical glass overlay: broad inner shading that turns the disc into a
   * ball, a hard specular highlight, and a cool bounce along the lower rim.
   */
  orbGlassURI(size, o = {}) {
    return this.uri(`orbglass:${o.tag ?? 'a'}`, size, size, (ctx, W) => {
      const s = W, c = s * 0.5, r = s * 0.5;
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.clip();
      // sphere darkening toward the silhouette edge
      const g = ctx.createRadialGradient(c - r * 0.26, c - r * 0.32, r * 0.02, c, c, r * 1.02);
      g.addColorStop(0, 'rgba(255,255,255,0.10)');
      g.addColorStop(0.42, 'rgba(255,255,255,0.0)');
      g.addColorStop(0.72, 'rgba(0,0,0,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0.62)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      // primary specular — a glass dome reflecting the key light. The core has
      // to be solid white or the orb reads as a matte disc.
      this.hotSpot(ctx, c - r * 0.30, c - r * 0.40, r * 0.34, {
        a: 0.98, squash: 0.56, rot: -0.55, coreR: 0.36,
      });
      this.glint(ctx, c - r * 0.30, c - r * 0.40, r * 0.62, { a: 0.34, rot: -0.5 });
      // secondary sheen band
      ctx.beginPath();
      ctx.ellipse(c + r * 0.30, c - r * 0.10, r * 0.10, r * 0.30, -0.5, 0, TAU);
      const sp2 = ctx.createRadialGradient(c + r * 0.30, c - r * 0.10, 0, c + r * 0.30, c - r * 0.10, r * 0.32);
      sp2.addColorStop(0, 'rgba(255,255,255,0.16)');
      sp2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sp2; ctx.fill();
      // cool bounce along the bottom rim
      ctx.beginPath(); ctx.arc(c, c, r * 0.93, Math.PI * 0.14, Math.PI * 0.86);
      ctx.lineWidth = r * 0.10;
      ctx.strokeStyle = 'rgba(150,178,208,0.20)';
      ctx.stroke();
      ctx.restore();
    });
  }

  /* ---------------------------------------------------------------- glyph */

  /**
   * Ability glyphs. Each is a real little vector sigil, cut into a dark tablet
   * and lit from above, with an emissive core in the ability's accent colour.
   */
  glyphURI(size, kind, colour) {
    return this.uri(`glyph:${kind}:${colour}`, size, size, (ctx, W) => {
      const s = W, c = s * 0.5;
      ctx.save();
      // engraved shadow pass, then the emissive pass
      for (const pass of [0, 1]) {
        ctx.save();
        if (pass === 0) { ctx.translate(s * 0.012, s * 0.022); }
        const col = pass === 0 ? 'rgba(0,0,0,0.85)' : null;
        const grad = ctx.createLinearGradient(0, s * 0.12, 0, s * 0.9);
        const [r, g, b] = hex2rgb(colour);
        grad.addColorStop(0, `rgb(${Math.min(255, r + 110)},${Math.min(255, g + 105)},${Math.min(255, b + 100)})`);
        grad.addColorStop(0.45, colour);
        grad.addColorStop(1, `rgb(${(r * 0.42) | 0},${(g * 0.4) | 0},${(b * 0.44) | 0})`);
        ctx.strokeStyle = col ?? grad;
        ctx.fillStyle = col ?? grad;
        ctx.lineWidth = s * 0.062;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (pass === 1) { ctx.shadowColor = rgba(colour, 0.85); ctx.shadowBlur = s * 0.10; }
        drawGlyph(ctx, kind, s, c);
        ctx.restore();
      }
      ctx.restore();
    });
  }

  /* ------------------------------------------------------------ item icon */

  /** Procedural item icon per equipment kind, rarity-tinted. */
  itemIconURI(size, kind, rarityKey = 'common', seed = 1) {
    return this.uri(`item:${kind}:${rarityKey}:${seed}:v2`, size, size, (ctx, W) => {
      const tint = RAR_TINT[rarityKey] ?? RAR_TINT.common;
      /* the rarity aura sits UNDER the object and casts no shadow of its own.
         Kept faint on purpose: at 0.34 it filled 78% of the cell with a wash and
         the socket behind the item stopped being a hole. */
      const bg = ctx.createRadialGradient(W * 0.5, W * 0.5, W * 0.04, W * 0.5, W * 0.5, W * 0.52);
      bg.addColorStop(0, rgba(tint, 0.15));
      bg.addColorStop(0.55, rgba(tint, 0.05));
      bg.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, W);
      /* The object is drawn on its own layer so ONE cast shadow can be applied to
         the finished silhouette. Shadowing every fill and stroke individually —
         which is what round 1 did — puts a dark halo around every specular, and
         once the icon is downscaled into a 33 px cell those halos average the
         highlights away. That is why the grid read as muddy brown lumps. */
      const off = this.cv(W, W);
      const octx = off.getContext('2d');
      try { drawItem(this, octx, W, kind, rarityKey, seed); } catch (e) { /* degrade */ }
      /* ONE light over the whole object. Every part of an icon is drawn with its
         own full-range gradient, so twenty parts average out to a uniform mid grey
         — the "muddy brown lump" read. `source-atop` masks these three terms to
         the object's own alpha: the fall away from the key, then the key
         re-struck as a raking glaze with a crest, then a hard hit. */
      try {
        octx.save();
        octx.globalCompositeOperation = 'source-atop';
        const sh = octx.createLinearGradient(0, 0, W * 0.92, W);
        sh.addColorStop(0, 'rgba(4,6,10,0)');
        sh.addColorStop(0.44, 'rgba(4,6,10,0.08)');
        sh.addColorStop(0.76, 'rgba(4,6,10,0.36)');
        sh.addColorStop(1, 'rgba(3,5,9,0.58)');
        octx.fillStyle = sh; octx.fillRect(0, 0, W, W);
        const IB = { x: 0, y: 0, w: W, h: W };
        this.glaze(octx, null, IB, {
          a: 0.34, mode: 'source-atop', tint: '255,248,230',
          cx: 0.12, cy: 0.05, wid: 0.50, len: 1.22, fall: 1.55,
        });
        this.glaze(octx, null, IB, {
          a: 0.26, mode: 'source-atop', tint: SPEC,
          cx: 0.06, cy: 0.02, wid: 0.17, len: 0.84, fall: 2.5,
        });
        octx.globalCompositeOperation = 'source-atop';
        this.hotSpot(octx, W * 0.355, W * 0.315, W * 0.135,
          { a: 0.94, squash: 0.40, rot: -0.62, coreR: 0.34 });
        this.hotSpot(octx, W * 0.560, W * 0.545, W * 0.075,
          { a: 0.62, squash: 0.46, rot: -0.62, coreR: 0.26 });
        octx.restore();
      } catch (e) { /* the un-lit object is still a valid icon */ }
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.80)';
      ctx.shadowBlur = W * 0.05;
      ctx.shadowOffsetX = W * 0.020;
      ctx.shadowOffsetY = W * 0.028;
      ctx.drawImage(off, 0, 0);
      ctx.restore();
    });
  }

  /* --------------------------------------------------------------- grunge */

  grungeURI(size = 256, seed = 4) {
    return this.uri(`grunge:${seed}`, size, size, (ctx, W) => {
      const img = ctx.createImageData(W, W);
      const d = img.data;
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = pfbm(x / 30, y / 30, W / 30, seed, 4);
        const b = hash2(x, y, seed + 3);
        const t = clamp01(smooth(0.48, 0.92, a) * 0.8 + b * 0.14);
        d[i] = 20; d[i + 1] = 18; d[i + 2] = 14; d[i + 3] = Math.round(t * 96);
      }
      ctx.putImageData(img, 0, 0);
    });
  }

  /** Thin decorative divider with a centred diamond — tooltip section rules. */
  dividerURI(w, h, colour = '#c69e4e') {
    return this.uri(`div:${colour}`, w, h, (ctx, W, H) => {
      const y = H * 0.5;
      const g = ctx.createLinearGradient(0, 0, W, 0);
      g.addColorStop(0, rgba(colour, 0));
      g.addColorStop(0.16, rgba(colour, 0.5));
      g.addColorStop(0.5, rgba(colour, 0.9));
      g.addColorStop(0.84, rgba(colour, 0.5));
      g.addColorStop(1, rgba(colour, 0));
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1, H * 0.09);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.save();
      ctx.translate(W * 0.5, y); ctx.rotate(Math.PI * 0.25);
      const d = H * 0.30;
      const dg = ctx.createLinearGradient(-d, -d, d, d);
      dg.addColorStop(0, '#f6e3a8'); dg.addColorStop(1, '#6d4e17');
      ctx.fillStyle = dg;
      ctx.fillRect(-d, -d, d * 2, d * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 1;
      ctx.strokeRect(-d, -d, d * 2, d * 2);
      ctx.restore();
    });
  }
}

/* ===================================================== path/util helpers */

function pathChamfer(p, x, y, w, h, c) {
  const cc = Math.max(0, Math.min(c, w * 0.5, h * 0.5));
  p.moveTo(x + cc, y);
  p.lineTo(x + w - cc, y);
  p.lineTo(x + w, y + cc);
  p.lineTo(x + w, y + h - cc);
  p.lineTo(x + w - cc, y + h);
  p.lineTo(x + cc, y + h);
  p.lineTo(x, y + h - cc);
  p.lineTo(x, y + cc);
  p.closePath();
}

/** Rivet positions around a panel band — corners plus an even run per edge. */
function rivetRing(w, h, band, cham, gap) {
  const pts = [];
  const inset = band * 0.5;
  const x0 = inset + cham * 0.55, x1 = w - inset - cham * 0.55;
  const y0 = inset + cham * 0.55, y1 = h - inset - cham * 0.55;
  pts.push([x0, y0, 1], [x1, y0, 2], [x0, y1, 3], [x1, y1, 4]);
  const nx = Math.max(0, Math.floor((x1 - x0) / gap) - 1);
  for (let i = 1; i <= nx; i++) {
    const t = i / (nx + 1);
    pts.push([lerp(x0, x1, t), inset, 10 + i], [lerp(x0, x1, t), h - inset, 20 + i]);
  }
  const ny = Math.max(0, Math.floor((y1 - y0) / gap) - 1);
  for (let i = 1; i <= ny; i++) {
    const t = i / (ny + 1);
    pts.push([inset, lerp(y0, y1, t), 30 + i], [w - inset, lerp(y0, y1, t), 40 + i]);
  }
  return pts;
}

/* ------------------------------------------------------------ glyph forms */

function drawGlyph(ctx, kind, s, c) {
  const P = (x, y) => [c + x * s, c + y * s];
  const line = (pts, close = false) => {
    ctx.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (close) ctx.closePath();
    ctx.stroke();
  };
  const ring = (r, a0 = 0, a1 = TAU) => { ctx.beginPath(); ctx.arc(c, c, r * s, a0, a1); ctx.stroke(); };

  switch (kind) {
    case 'cleave': { // two crossed arcs + a chevron
      ctx.beginPath(); ctx.arc(c - s * 0.06, c + s * 0.10, s * 0.30, -1.9, 0.15); ctx.stroke();
      ctx.beginPath(); ctx.arc(c + s * 0.06, c + s * 0.10, s * 0.30, Math.PI - 0.15, Math.PI + 1.9); ctx.stroke();
      line([[-0.13, -0.05], [0, -0.22], [0.13, -0.05]]);
      line([[-0.09, 0.20], [0, 0.06], [0.09, 0.20]]);
      break;
    }
    case 'thrust': { // spearhead
      ctx.beginPath();
      const p0 = P(0, -0.31), p1 = P(0.12, -0.05), p2 = P(0, 0.30), p3 = P(-0.12, -0.05);
      ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.lineTo(...p2); ctx.lineTo(...p3); ctx.closePath();
      ctx.stroke();
      line([[0, -0.10], [0, 0.20]]);
      line([[-0.22, 0.14], [-0.12, 0.02]]);
      line([[0.22, 0.14], [0.12, 0.02]]);
      break;
    }
    case 'whirl': { // triple spiral
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        const rot = (k / 3) * TAU;
        for (let i = 0; i <= 26; i++) {
          const t = (i / 26) * 3.0;
          const r = s * 0.055 * Math.exp(0.55 * t);
          const x = c + Math.cos(t + rot) * r, y = c + Math.sin(t + rot) * r;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'quake': { // radiating cracks from a filled core
      ctx.beginPath(); ctx.arc(c, c, s * 0.075, 0, TAU); ctx.fill();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + 0.24;
        const j = ((i * 37) % 11) / 11 - 0.5;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * s * 0.10, c + Math.sin(a) * s * 0.10);
        ctx.lineTo(c + Math.cos(a + j * 0.3) * s * 0.22, c + Math.sin(a + j * 0.3) * s * 0.22);
        ctx.lineTo(c + Math.cos(a - j * 0.24) * s * 0.36, c + Math.sin(a - j * 0.24) * s * 0.36);
        ctx.stroke();
      }
      break;
    }
    case 'ward': { // heraldic shield with a cross
      ctx.beginPath();
      ctx.moveTo(...P(-0.24, -0.28));
      ctx.lineTo(...P(0.24, -0.28));
      ctx.lineTo(...P(0.24, 0.06));
      ctx.quadraticCurveTo(...P(0.24, 0.26), ...P(0, 0.34));
      ctx.quadraticCurveTo(...P(-0.24, 0.26), ...P(-0.24, 0.06));
      ctx.closePath(); ctx.stroke();
      line([[0, -0.19], [0, 0.20]]);
      line([[-0.14, -0.04], [0.14, -0.04]]);
      break;
    }
    case 'bolt': { // zigzag with nodes
      line([[-0.10, -0.32], [0.10, -0.10], [-0.04, -0.04], [0.13, 0.32]]);
      ctx.beginPath(); ctx.arc(...P(-0.10, -0.32), s * 0.035, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(...P(0.13, 0.32), s * 0.035, 0, TAU); ctx.fill();
      ring(0.33, -0.6, 1.3);
      ring(0.33, Math.PI - 0.6, Math.PI + 1.3);
      break;
    }
    case 'drain': { // downturned crescent + droplets
      ctx.beginPath(); ctx.arc(c, c - s * 0.06, s * 0.26, 0.35, Math.PI - 0.35); ctx.stroke();
      for (let i = -1; i <= 1; i++) {
        const x = c + i * s * 0.16;
        ctx.beginPath();
        ctx.moveTo(x, c + s * 0.10);
        ctx.quadraticCurveTo(x + s * 0.05, c + s * 0.22, x, c + s * 0.30);
        ctx.quadraticCurveTo(x - s * 0.05, c + s * 0.22, x, c + s * 0.10);
        ctx.closePath(); ctx.fill();
      }
      ring(0.34, 1.5, 1.9);
      break;
    }
    case 'banner': { // standard with a pennant
      line([[0, -0.34], [0, 0.34]]);
      ctx.beginPath();
      ctx.moveTo(...P(0.02, -0.30));
      ctx.lineTo(...P(0.30, -0.22));
      ctx.lineTo(...P(0.18, -0.10));
      ctx.lineTo(...P(0.30, 0.02));
      ctx.lineTo(...P(0.02, -0.02));
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(...P(0, -0.36), s * 0.04, 0, TAU); ctx.fill();
      break;
    }
    case 'sigil': { // hexagram in a ring
      ring(0.34);
      for (const flip of [0, 1]) {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const a = -Math.PI / 2 + (i / 3) * TAU + (flip ? Math.PI / 3 : 0);
          const x = c + Math.cos(a) * s * 0.28, y = c + Math.sin(a) * s * 0.28;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath(); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(c, c, s * 0.05, 0, TAU); ctx.fill();
      break;
    }
    case 'flame': {
      ctx.beginPath();
      ctx.moveTo(...P(0, -0.34));
      ctx.bezierCurveTo(...P(0.20, -0.10), ...P(0.24, 0.10), ...P(0.10, 0.26));
      ctx.bezierCurveTo(...P(0.02, 0.34), ...P(-0.12, 0.30), ...P(-0.16, 0.16));
      ctx.bezierCurveTo(...P(-0.20, 0.0), ...P(-0.08, -0.14), ...P(0, -0.34));
      ctx.closePath(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(...P(0.0, -0.10));
      ctx.bezierCurveTo(...P(0.09, 0.02), ...P(0.06, 0.16), ...P(-0.01, 0.20));
      ctx.bezierCurveTo(...P(-0.08, 0.14), ...P(-0.06, 0.02), ...P(0, -0.10));
      ctx.closePath(); ctx.fill();
      break;
    }
    default: {
      ring(0.30);
      line([[-0.16, 0], [0.16, 0]]);
      line([[0, -0.16], [0, 0.16]]);
    }
  }
}

/* ------------------------------------------------------------- item forms */

const RAR_TINT = {
  common: '#b9b3a4', magic: '#6f9ada', rare: '#dcc45c', legendary: '#dd8b38', mythic: '#c4463a',
};

function drawItem(atlas, ctx, S, kind, rarityKey, seed) {
  const tint = RAR_TINT[rarityKey] ?? RAR_TINT.common;
  const c = S * 0.5;

  const steel = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#f4f7fb'); g.addColorStop(0.16, '#b9c3cf');
    g.addColorStop(0.44, '#727d8b'); g.addColorStop(0.74, '#333b44');
    g.addColorStop(1, '#0c1014');
    return g;
  };
  const goldG = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#fff3cd'); g.addColorStop(0.22, '#ddb862');
    g.addColorStop(0.56, '#8f6b26'); g.addColorStop(1, '#2f210a');
    return g;
  };
  const leatherG = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#6b5138'); g.addColorStop(0.4, '#412f1f');
    g.addColorStop(1, '#170f09');
    return g;
  };
  const clothG = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#5a4a52'); g.addColorStop(0.45, '#3a2c33');
    g.addColorStop(1, '#160f13');
    return g;
  };
  const stroke = (w = S * 0.018, col = 'rgba(0,0,0,0.86)') => {
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
  };

  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  /* NO per-shape shadow: itemIconURI casts one shadow off the finished
     silhouette instead, which keeps every highlight crisp at cell size. */

  switch (kind) {
    case 'sword': {
      ctx.save(); ctx.translate(c, c); ctx.rotate(-0.42);
      // blade
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.40);
      ctx.lineTo(S * 0.055, -S * 0.30);
      ctx.lineTo(S * 0.055, S * 0.10);
      ctx.lineTo(-S * 0.055, S * 0.10);
      ctx.lineTo(-S * 0.055, -S * 0.30);
      ctx.closePath();
      ctx.fillStyle = steel(-S * 0.06, -S * 0.4, S * 0.06, S * 0.1); ctx.fill(); stroke();
      // fuller
      ctx.beginPath(); ctx.moveTo(0, -S * 0.34); ctx.lineTo(0, S * 0.08);
      ctx.lineWidth = S * 0.012; ctx.strokeStyle = 'rgba(240,246,255,0.5)'; ctx.stroke();
      // guard
      ctx.beginPath();
      ctx.moveTo(-S * 0.20, S * 0.10); ctx.lineTo(S * 0.20, S * 0.10);
      ctx.lineTo(S * 0.16, S * 0.165); ctx.lineTo(-S * 0.16, S * 0.165); ctx.closePath();
      ctx.fillStyle = goldG(-S * 0.2, S * 0.1, S * 0.2, S * 0.17); ctx.fill(); stroke();
      // grip
      ctx.beginPath(); roundPath(ctx, -S * 0.032, S * 0.165, S * 0.064, S * 0.19, S * 0.02);
      ctx.fillStyle = leatherG(-S * 0.03, S * 0.16, S * 0.03, S * 0.35); ctx.fill(); stroke(S * 0.012);
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(-S * 0.032, S * (0.18 + i * 0.036));
        ctx.lineTo(S * 0.032, S * (0.19 + i * 0.036));
        ctx.lineWidth = S * 0.008; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      }
      // pommel
      ctx.beginPath(); ctx.arc(0, S * 0.375, S * 0.042, 0, TAU);
      ctx.fillStyle = goldG(-S * 0.04, S * 0.34, S * 0.04, S * 0.42); ctx.fill(); stroke(S * 0.012);
      ctx.restore();
      atlas.gem(ctx, c + S * 0.075, c + S * 0.045, S * 0.030, tint);
      break;
    }
    case 'axe': {
      ctx.save(); ctx.translate(c, c); ctx.rotate(0.22);
      // shaft
      ctx.beginPath(); roundPath(ctx, -S * 0.030, -S * 0.36, S * 0.060, S * 0.74, S * 0.02);
      ctx.fillStyle = leatherG(-S * 0.03, -S * 0.36, S * 0.03, S * 0.38); ctx.fill(); stroke(S * 0.014);
      // head
      ctx.beginPath();
      ctx.moveTo(-S * 0.02, -S * 0.30);
      ctx.bezierCurveTo(S * 0.22, -S * 0.34, S * 0.34, -S * 0.16, S * 0.30, S * 0.02);
      ctx.lineTo(S * 0.02, -S * 0.06);
      ctx.closePath();
      ctx.fillStyle = steel(0, -S * 0.34, S * 0.3, S * 0.02); ctx.fill(); stroke();
      ctx.beginPath();
      ctx.moveTo(-S * 0.02, -S * 0.28);
      ctx.bezierCurveTo(-S * 0.16, -S * 0.30, -S * 0.22, -S * 0.16, -S * 0.19, -S * 0.04);
      ctx.lineTo(-S * 0.02, -S * 0.07);
      ctx.closePath();
      ctx.fillStyle = steel(0, -S * 0.3, -S * 0.2, -S * 0.04); ctx.fill(); stroke();
      // edge highlight
      ctx.beginPath();
      ctx.moveTo(S * 0.29, -S * 0.02);
      ctx.bezierCurveTo(S * 0.33, -S * 0.16, S * 0.22, -S * 0.32, S * 0.02, -S * 0.30);
      ctx.lineWidth = S * 0.016; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke();
      ctx.restore();
      break;
    }
    case 'helm': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.26, c + S * 0.16);
      ctx.bezierCurveTo(c - S * 0.30, c - S * 0.20, c - S * 0.13, c - S * 0.36, c, c - S * 0.36);
      ctx.bezierCurveTo(c + S * 0.13, c - S * 0.36, c + S * 0.30, c - S * 0.20, c + S * 0.26, c + S * 0.16);
      ctx.lineTo(c + S * 0.19, c + S * 0.30);
      ctx.lineTo(c - S * 0.19, c + S * 0.30);
      ctx.closePath();
      ctx.fillStyle = steel(c - S * 0.3, c - S * 0.36, c + S * 0.2, c + S * 0.3); ctx.fill(); stroke();
      // eye slits
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(c + sgn * S * 0.055, c - S * 0.04);
        ctx.lineTo(c + sgn * S * 0.19, c - S * 0.06);
        ctx.lineTo(c + sgn * S * 0.19, c + S * 0.03);
        ctx.lineTo(c + sgn * S * 0.055, c + S * 0.045);
        ctx.closePath();
        ctx.fillStyle = '#07090c'; ctx.fill();
        ctx.lineWidth = S * 0.01; ctx.strokeStyle = 'rgba(210,220,235,0.35)'; ctx.stroke();
      }
      // crest
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.38);
      ctx.lineTo(c + S * 0.035, c - S * 0.10);
      ctx.lineTo(c, c + S * 0.28);
      ctx.lineTo(c - S * 0.035, c - S * 0.10);
      ctx.closePath();
      ctx.fillStyle = goldG(c - S * 0.04, c - S * 0.38, c + S * 0.04, c + S * 0.28); ctx.fill(); stroke(S * 0.012);
      // brow band
      ctx.beginPath();
      ctx.moveTo(c - S * 0.27, c - S * 0.08);
      ctx.quadraticCurveTo(c, c - S * 0.15, c + S * 0.27, c - S * 0.08);
      ctx.lineWidth = S * 0.030; ctx.strokeStyle = goldG(c - S * 0.2, c - S * 0.12, c + S * 0.2, c - S * 0.05);
      ctx.stroke();
      break;
    }
    case 'chest': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.10, c - S * 0.34);
      ctx.lineTo(c + S * 0.10, c - S * 0.34);
      ctx.lineTo(c + S * 0.20, c - S * 0.28);
      ctx.lineTo(c + S * 0.32, c - S * 0.16);
      ctx.lineTo(c + S * 0.26, c + S * 0.02);
      ctx.lineTo(c + S * 0.24, c + S * 0.34);
      ctx.lineTo(c - S * 0.24, c + S * 0.34);
      ctx.lineTo(c - S * 0.26, c + S * 0.02);
      ctx.lineTo(c - S * 0.32, c - S * 0.16);
      ctx.lineTo(c - S * 0.20, c - S * 0.28);
      ctx.closePath();
      ctx.fillStyle = steel(c - S * 0.3, c - S * 0.34, c + S * 0.25, c + S * 0.34); ctx.fill(); stroke();
      // pectoral bands
      for (let i = 0; i < 3; i++) {
        const y = c - S * 0.10 + i * S * 0.13;
        ctx.beginPath();
        ctx.moveTo(c - S * 0.23, y);
        ctx.quadraticCurveTo(c, y + S * 0.05, c + S * 0.23, y);
        ctx.lineWidth = S * 0.020; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(c - S * 0.23, y - S * 0.012);
        ctx.quadraticCurveTo(c, y + S * 0.038, c + S * 0.23, y - S * 0.012);
        ctx.lineWidth = S * 0.008; ctx.strokeStyle = 'rgba(220,232,246,0.30)'; ctx.stroke();
      }
      // collar
      ctx.beginPath();
      ctx.moveTo(c - S * 0.10, c - S * 0.34);
      ctx.quadraticCurveTo(c, c - S * 0.24, c + S * 0.10, c - S * 0.34);
      ctx.lineWidth = S * 0.026; ctx.strokeStyle = goldG(c - S * 0.1, c - S * 0.34, c + S * 0.1, c - S * 0.24);
      ctx.stroke();
      atlas.gem(ctx, c, c - S * 0.02, S * 0.045, tint);
      break;
    }
    case 'gloves': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.20, c + S * 0.30);
      ctx.lineTo(c - S * 0.22, c - S * 0.06);
      ctx.lineTo(c - S * 0.14, c - S * 0.32);
      ctx.lineTo(c - S * 0.02, c - S * 0.34);
      ctx.lineTo(c + S * 0.06, c - S * 0.16);
      ctx.lineTo(c + S * 0.22, c - S * 0.10);
      ctx.lineTo(c + S * 0.24, c + S * 0.10);
      ctx.lineTo(c + S * 0.14, c + S * 0.30);
      ctx.closePath();
      ctx.fillStyle = leatherG(c - S * 0.22, c - S * 0.34, c + S * 0.24, c + S * 0.3); ctx.fill(); stroke();
      for (let i = 0; i < 4; i++) {
        const x = c - S * 0.14 + i * S * 0.09;
        ctx.beginPath(); roundPath(ctx, x, c - S * 0.30 + i * S * 0.03, S * 0.055, S * 0.13, S * 0.025);
        ctx.fillStyle = steel(x, c - S * 0.3, x + S * 0.06, c - S * 0.16); ctx.fill(); stroke(S * 0.010);
      }
      ctx.beginPath(); roundPath(ctx, c - S * 0.21, c + S * 0.10, S * 0.44, S * 0.10, S * 0.02);
      ctx.fillStyle = goldG(c - S * 0.2, c + S * 0.1, c + S * 0.2, c + S * 0.2); ctx.fill(); stroke(S * 0.012);
      break;
    }
    case 'boots': {
      for (const sgn of [-1, 1]) {
        const bx = c + sgn * S * 0.13;
        ctx.beginPath();
        ctx.moveTo(bx - S * 0.075, c - S * 0.32);
        ctx.lineTo(bx + S * 0.075, c - S * 0.32);
        ctx.lineTo(bx + S * 0.085, c + S * 0.12);
        ctx.lineTo(bx + sgn * S * 0.10, c + S * 0.22);
        ctx.lineTo(bx - S * 0.085, c + S * 0.22);
        ctx.closePath();
        ctx.fillStyle = leatherG(bx - S * 0.08, c - S * 0.32, bx + S * 0.09, c + S * 0.22);
        ctx.fill(); stroke(S * 0.014);
        ctx.beginPath(); roundPath(ctx, bx - S * 0.10, c + S * 0.20, S * 0.20, S * 0.075, S * 0.02);
        ctx.fillStyle = steel(bx - S * 0.1, c + S * 0.2, bx + S * 0.1, c + S * 0.28); ctx.fill(); stroke(S * 0.012);
        ctx.beginPath();
        ctx.moveTo(bx - S * 0.075, c - S * 0.20);
        ctx.lineTo(bx + S * 0.078, c - S * 0.20);
        ctx.lineWidth = S * 0.022; ctx.strokeStyle = goldG(bx - S * 0.08, c - S * 0.22, bx + S * 0.08, c - S * 0.17);
        ctx.stroke();
      }
      break;
    }
    case 'ring': {
      ctx.beginPath(); ctx.arc(c, c + S * 0.06, S * 0.215, 0, TAU);
      ctx.lineWidth = S * 0.075;
      ctx.strokeStyle = goldG(c - S * 0.2, c - S * 0.15, c + S * 0.2, c + S * 0.28); ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c + S * 0.06, S * 0.215, 0, TAU);
      ctx.lineWidth = S * 0.012; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c + S * 0.06, S * 0.253, 0.3, 1.5);
      ctx.lineWidth = S * 0.012; ctx.strokeStyle = 'rgba(255,240,200,0.4)'; ctx.stroke();
      atlas.gem(ctx, c, c - S * 0.22, S * 0.10, tint);
      break;
    }
    case 'amulet': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.24, c - S * 0.32);
      ctx.quadraticCurveTo(c, c + S * 0.02, c + S * 0.24, c - S * 0.32);
      ctx.lineWidth = S * 0.024; ctx.strokeStyle = goldG(c - S * 0.2, c - S * 0.3, c + S * 0.2, c); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.02);
      ctx.lineTo(c + S * 0.15, c + S * 0.14);
      ctx.lineTo(c, c + S * 0.34);
      ctx.lineTo(c - S * 0.15, c + S * 0.14);
      ctx.closePath();
      ctx.fillStyle = goldG(c - S * 0.15, c - S * 0.02, c + S * 0.15, c + S * 0.34); ctx.fill(); stroke(S * 0.014);
      atlas.gem(ctx, c, c + S * 0.14, S * 0.075, tint);
      break;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.27, c - S * 0.31);
      ctx.lineTo(c + S * 0.27, c - S * 0.31);
      ctx.lineTo(c + S * 0.27, c + S * 0.06);
      ctx.quadraticCurveTo(c + S * 0.26, c + S * 0.28, c, c + S * 0.37);
      ctx.quadraticCurveTo(c - S * 0.26, c + S * 0.28, c - S * 0.27, c + S * 0.06);
      ctx.closePath();
      ctx.fillStyle = steel(c - S * 0.28, c - S * 0.31, c + S * 0.2, c + S * 0.37); ctx.fill(); stroke();
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.24); ctx.lineTo(c, c + S * 0.28);
      ctx.moveTo(c - S * 0.20, c - S * 0.06); ctx.lineTo(c + S * 0.20, c - S * 0.06);
      ctx.lineWidth = S * 0.030; ctx.strokeStyle = goldG(c - S * 0.2, c - S * 0.2, c + S * 0.2, c + S * 0.2);
      ctx.stroke();
      atlas.gem(ctx, c, c - S * 0.06, S * 0.058, tint);
      for (let i = 0; i < 6; i++) {
        const a = -1.9 + i * 0.62;
        atlas.rivet(ctx, c + Math.cos(a) * S * 0.225, c - S * 0.02 + Math.sin(a) * S * 0.255, S * 0.020, seed + i);
      }
      break;
    }
    case 'bow': {
      ctx.beginPath();
      ctx.moveTo(c + S * 0.10, c - S * 0.36);
      ctx.bezierCurveTo(c - S * 0.26, c - S * 0.18, c - S * 0.26, c + S * 0.18, c + S * 0.10, c + S * 0.36);
      ctx.lineWidth = S * 0.045; ctx.strokeStyle = leatherG(c - S * 0.2, c - S * 0.3, c + S * 0.1, c + S * 0.3);
      ctx.stroke();
      ctx.lineWidth = S * 0.014; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c + S * 0.10, c - S * 0.36); ctx.lineTo(c + S * 0.10, c + S * 0.36);
      ctx.lineWidth = S * 0.010; ctx.strokeStyle = 'rgba(226,232,240,0.6)'; ctx.stroke();
      ctx.beginPath(); roundPath(ctx, c - S * 0.135, c - S * 0.075, S * 0.075, S * 0.15, S * 0.02);
      ctx.fillStyle = goldG(c - S * 0.14, c - S * 0.08, c - S * 0.06, c + S * 0.08); ctx.fill(); stroke(S * 0.012);
      break;
    }
    case 'staff': {
      ctx.save(); ctx.translate(c, c); ctx.rotate(-0.28);
      ctx.beginPath(); roundPath(ctx, -S * 0.028, -S * 0.20, S * 0.056, S * 0.60, S * 0.02);
      ctx.fillStyle = leatherG(-S * 0.03, -S * 0.2, S * 0.03, S * 0.4); ctx.fill(); stroke(S * 0.014);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(-S * 0.028, S * (-0.10 + i * 0.12));
        ctx.lineTo(S * 0.028, S * (-0.085 + i * 0.12));
        ctx.lineWidth = S * 0.012; ctx.strokeStyle = goldG(-S * 0.03, 0, S * 0.03, S * 0.02); ctx.stroke();
      }
      // crown claws
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(sgn * S * 0.02, -S * 0.19);
        ctx.quadraticCurveTo(sgn * S * 0.13, -S * 0.26, sgn * S * 0.085, -S * 0.375);
        ctx.lineWidth = S * 0.026; ctx.strokeStyle = goldG(0, -S * 0.4, sgn * S * 0.12, -S * 0.19);
        ctx.stroke();
      }
      ctx.restore();
      atlas.gem(ctx, c + S * 0.075, c - S * 0.245, S * 0.088, tint);
      break;
    }
    case 'potion': {
      ctx.beginPath();
      ctx.moveTo(c - S * 0.055, c - S * 0.30);
      ctx.lineTo(c - S * 0.055, c - S * 0.16);
      ctx.bezierCurveTo(c - S * 0.26, c - S * 0.04, c - S * 0.22, c + S * 0.32, c, c + S * 0.32);
      ctx.bezierCurveTo(c + S * 0.22, c + S * 0.32, c + S * 0.26, c - S * 0.04, c + S * 0.055, c - S * 0.16);
      ctx.lineTo(c + S * 0.055, c - S * 0.30);
      ctx.closePath();
      const gg = ctx.createLinearGradient(c - S * 0.2, c - S * 0.2, c + S * 0.2, c + S * 0.3);
      gg.addColorStop(0, 'rgba(180,200,215,0.45)');
      gg.addColorStop(0.5, 'rgba(40,52,62,0.6)');
      gg.addColorStop(1, 'rgba(12,16,20,0.8)');
      ctx.fillStyle = gg; ctx.fill(); stroke(S * 0.016);
      // liquid
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(c - S * 0.055, c - S * 0.16);
      ctx.bezierCurveTo(c - S * 0.26, c - S * 0.04, c - S * 0.22, c + S * 0.32, c, c + S * 0.32);
      ctx.bezierCurveTo(c + S * 0.22, c + S * 0.32, c + S * 0.26, c - S * 0.04, c + S * 0.055, c - S * 0.16);
      ctx.closePath(); ctx.clip();
      const lg = ctx.createLinearGradient(0, c + S * 0.02, 0, c + S * 0.32);
      lg.addColorStop(0, '#ef5a3a'); lg.addColorStop(0.4, '#a8121c'); lg.addColorStop(1, '#3d0308');
      ctx.fillStyle = lg; ctx.fillRect(c - S * 0.3, c + S * 0.02, S * 0.6, S * 0.4);
      ctx.beginPath(); ctx.ellipse(c, c + S * 0.02, S * 0.19, S * 0.035, 0, 0, TAU);
      ctx.fillStyle = 'rgba(255,180,140,0.65)'; ctx.fill();
      ctx.restore();
      // highlight
      ctx.beginPath(); ctx.ellipse(c - S * 0.10, c + S * 0.10, S * 0.030, S * 0.10, -0.35, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.fill();
      // cork
      ctx.beginPath(); roundPath(ctx, c - S * 0.075, c - S * 0.375, S * 0.15, S * 0.09, S * 0.02);
      ctx.fillStyle = leatherG(c - S * 0.08, c - S * 0.38, c + S * 0.08, c - S * 0.29); ctx.fill(); stroke(S * 0.012);
      break;
    }
    case 'gem': {
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.34);
      ctx.lineTo(c + S * 0.26, c - S * 0.10);
      ctx.lineTo(c + S * 0.16, c + S * 0.30);
      ctx.lineTo(c - S * 0.16, c + S * 0.30);
      ctx.lineTo(c - S * 0.26, c - S * 0.10);
      ctx.closePath();
      const g1 = ctx.createLinearGradient(c - S * 0.2, c - S * 0.3, c + S * 0.2, c + S * 0.3);
      g1.addColorStop(0, rgba(tint, 1)); g1.addColorStop(0.5, rgba(tint, 0.55));
      g1.addColorStop(1, 'rgba(8,10,14,0.9)');
      ctx.fillStyle = g1; ctx.fill(); stroke(S * 0.016);
      // facets
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.34); ctx.lineTo(c - S * 0.09, c - S * 0.02); ctx.lineTo(c, c + S * 0.30);
      ctx.moveTo(c, c - S * 0.34); ctx.lineTo(c + S * 0.09, c - S * 0.02); ctx.lineTo(c, c + S * 0.30);
      ctx.moveTo(c - S * 0.26, c - S * 0.10); ctx.lineTo(c - S * 0.09, c - S * 0.02);
      ctx.moveTo(c + S * 0.26, c - S * 0.10); ctx.lineTo(c + S * 0.09, c - S * 0.02);
      ctx.lineWidth = S * 0.010; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
      break;
    }
    case 'scroll': {
      ctx.beginPath(); roundPath(ctx, c - S * 0.20, c - S * 0.30, S * 0.40, S * 0.60, S * 0.02);
      ctx.fillStyle = (() => {
        const g = ctx.createLinearGradient(c - S * 0.2, c - S * 0.3, c + S * 0.2, c + S * 0.3);
        g.addColorStop(0, '#d8c8a0'); g.addColorStop(0.5, '#ab9770'); g.addColorStop(1, '#6a5b3f');
        return g;
      })();
      ctx.fill(); stroke(S * 0.014);
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.moveTo(c - S * 0.14, c - S * 0.20 + i * S * 0.072);
        ctx.lineTo(c + S * (i % 2 ? 0.10 : 0.14), c - S * 0.20 + i * S * 0.072);
        ctx.lineWidth = S * 0.012; ctx.strokeStyle = 'rgba(40,30,18,0.55)'; ctx.stroke();
      }
      for (const y of [c - S * 0.30, c + S * 0.30]) {
        ctx.beginPath(); roundPath(ctx, c - S * 0.26, y - S * 0.045, S * 0.52, S * 0.09, S * 0.04);
        ctx.fillStyle = leatherG(c - S * 0.26, y - S * 0.05, c + S * 0.26, y + S * 0.05);
        ctx.fill(); stroke(S * 0.012);
      }
      break;
    }
    case 'tome': {
      ctx.beginPath(); roundPath(ctx, c - S * 0.24, c - S * 0.30, S * 0.48, S * 0.60, S * 0.03);
      ctx.fillStyle = leatherG(c - S * 0.24, c - S * 0.3, c + S * 0.24, c + S * 0.3); ctx.fill(); stroke();
      ctx.beginPath(); ctx.rect(c + S * 0.14, c - S * 0.27, S * 0.075, S * 0.54);
      ctx.fillStyle = '#c3b28c'; ctx.fill();
      ctx.lineWidth = S * 0.008; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.moveTo(c + S * 0.145, c - S * 0.25 + i * S * 0.075);
        ctx.lineTo(c + S * 0.213, c - S * 0.25 + i * S * 0.075);
        ctx.stroke();
      }
      ctx.beginPath(); roundPath(ctx, c - S * 0.20, c - S * 0.26, S * 0.30, S * 0.52, S * 0.02);
      ctx.lineWidth = S * 0.014; ctx.strokeStyle = goldG(c - S * 0.2, c - S * 0.26, c + S * 0.1, c + S * 0.26);
      ctx.stroke();
      atlas.gem(ctx, c - S * 0.05, c, S * 0.070, tint);
      break;
    }
    case 'belt': {
      ctx.beginPath(); roundPath(ctx, c - S * 0.34, c - S * 0.10, S * 0.68, S * 0.20, S * 0.03);
      ctx.fillStyle = leatherG(c - S * 0.34, c - S * 0.1, c + S * 0.34, c + S * 0.1); ctx.fill(); stroke();
      for (let i = 0; i < 7; i++) {
        atlas.rivet(ctx, c - S * 0.28 + i * S * 0.078, c + S * 0.055, S * 0.019, seed + i);
      }
      ctx.beginPath(); roundPath(ctx, c - S * 0.11, c - S * 0.17, S * 0.22, S * 0.34, S * 0.04);
      ctx.lineWidth = S * 0.042; ctx.strokeStyle = goldG(c - S * 0.11, c - S * 0.17, c + S * 0.11, c + S * 0.17);
      ctx.stroke();
      ctx.lineWidth = S * 0.010; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.stroke();
      atlas.gem(ctx, c, c, S * 0.052, tint);
      break;
    }
    case 'cloak': {
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.34);
      ctx.bezierCurveTo(c + S * 0.20, c - S * 0.30, c + S * 0.30, c - S * 0.02, c + S * 0.26, c + S * 0.32);
      ctx.lineTo(c - S * 0.26, c + S * 0.32);
      ctx.bezierCurveTo(c - S * 0.30, c - S * 0.02, c - S * 0.20, c - S * 0.30, c, c - S * 0.34);
      ctx.closePath();
      ctx.fillStyle = clothG(c - S * 0.3, c - S * 0.34, c + S * 0.3, c + S * 0.32); ctx.fill(); stroke();
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(c + i * S * 0.085, c - S * 0.26);
        ctx.quadraticCurveTo(c + i * S * 0.105, c + S * 0.04, c + i * S * 0.115, c + S * 0.31);
        ctx.lineWidth = S * 0.014; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(c - S * 0.16, c - S * 0.30);
      ctx.quadraticCurveTo(c, c - S * 0.20, c + S * 0.16, c - S * 0.30);
      ctx.lineWidth = S * 0.030; ctx.strokeStyle = goldG(c - S * 0.16, c - S * 0.3, c + S * 0.16, c - S * 0.2);
      ctx.stroke();
      break;
    }
    default: { // rune / unknown
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.30);
      ctx.lineTo(c + S * 0.28, c);
      ctx.lineTo(c, c + S * 0.30);
      ctx.lineTo(c - S * 0.28, c);
      ctx.closePath();
      ctx.fillStyle = steel(c - S * 0.28, c - S * 0.3, c + S * 0.28, c + S * 0.3); ctx.fill(); stroke();
      atlas.gem(ctx, c, c, S * 0.088, tint);
    }
  }
  ctx.restore();

  /* wear + grime on top of the object */
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.22;
  const pat = ctx.createPattern(atlas.tile('craze', 128, 9), 'repeat');
  if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, S, S); }
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.22;
  const gp = ctx.createPattern(atlas.tile('grain', 128, 6), 'repeat');
  if (gp) { ctx.fillStyle = gp; ctx.fillRect(0, 0, S, S); }
  ctx.restore();

  /* polish — restricted to the object with 'source-atop' so the empty ground
     inside the socket stays dark. Every item in the panel has to catch the same
     key light or the grid reads as a sheet of stickers. */
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  const pg = ctx.createRadialGradient(S * 0.33, S * 0.25, 0, S * 0.36, S * 0.30, S * 0.60);
  pg.addColorStop(0, `rgba(${SPEC},0.46)`);
  pg.addColorStop(0.34, `rgba(${SPEC},0.16)`);
  pg.addColorStop(0.72, `rgba(${SPEC},0.02)`);
  pg.addColorStop(1, `rgba(${SPEC},0)`);
  ctx.fillStyle = pg; ctx.fillRect(0, 0, S, S);
  /* the HARD term. The broad lobe above only lifts value; a solid near-white
     core is what actually reads as a lit object once the icon is 33 px wide.
     Two of them — the main mass and a secondary catch — plus a star glint. */
  atlas.hotSpot(ctx, S * 0.335, S * 0.265, S * 0.135, { a: 0.98, squash: 0.46, rot: -0.62, coreR: 0.30 });
  atlas.hotSpot(ctx, S * 0.60, S * 0.375, S * 0.075, { a: 0.72, squash: 0.40, rot: -0.62, coreR: 0.24 });
  atlas.glint(ctx, S * 0.335, S * 0.265, S * 0.26, { a: 0.44, rot: -0.5 });
  const dg = ctx.createLinearGradient(S * 0.4, S * 0.4, S, S);
  dg.addColorStop(0, 'rgba(0,0,0,0)');
  dg.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = dg; ctx.fillRect(0, 0, S, S);
  ctx.restore();
}

export default UIAtlas;
