/**
 * THE NINTH VIGIL — Ornament
 * ---------------------------------------------------------------------------
 * Second-tier procedural UI art built on top of UIAtlas: the pieces the HUD and
 * the panels need that are not generic panels — bar troughs, level plates,
 * banner ribbons, the minimap bezel, equipment-slot silhouettes, elite rank
 * badges, skill-tree node frames, buff frames.
 *
 * Everything returns a cached PNG data URI so a piece is rasterised once per
 * (size, variant) and then costs nothing. Light is always from the upper-left,
 * every raised edge gets a catch-light above and a cut shadow below, and every
 * recess gets an occlusion gradient — that is what makes a flat rectangle read
 * as a physical object.
 *
 * No Math.random, no Date.now: every jitter comes from `hash2`.
 */

import { hash2 } from '../../core/Rand.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hex2rgb(h) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (c, a) => { const [r, g, b] = hex2rgb(c); return `rgba(${r},${g},${b},${a})`; };
const lighten = (c, k) => {
  const [r, g, b] = hex2rgb(c);
  return `rgb(${Math.min(255, Math.round(r + (255 - r) * k))},${Math.min(255, Math.round(g + (255 - g) * k))},${Math.min(255, Math.round(b + (255 - b) * k))})`;
};
const darken = (c, k) => {
  const [r, g, b] = hex2rgb(c);
  return `rgb(${Math.round(r * (1 - k))},${Math.round(g * (1 - k))},${Math.round(b * (1 - k))})`;
};

function pathCham(p, x, y, w, h, c) {
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

function pathRound(p, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
}

/**
 * Boss-bar geometry, published because it is read from TWO places that must
 * agree to the pixel: the raster in `Ornament.bossTrough`, and the stylesheet
 * in panels/Combat.js that lays the liquid and the phase stones over it. When
 * those two drifted apart the fill sat proud of its own channel, which is the
 * single most obvious way to make a bar look unfinished.
 *
 * Vertical values are fractions of the element HEIGHT, horizontal ones of its
 * WIDTH, and `aspect` is the width-to-height ratio the raster is authored at —
 * the element must be given the same ratio or the forged end caps stretch.
 */
export const BOSS_GEO = {
  /** authored raster size, and therefore the element's required aspect */
  rasterW: 1500,
  rasterH: 66,
  get aspect() { return this.rasterW / this.rasterH; },
  /** the beam's own top/bottom inset — the caps and gates stand proud of it */
  beamT: 0.13,
  /** thickness of the beam's rails around the channel */
  band: 0.115,
  /** the channel interior: what the liquid element is clipped to */
  clipX: 0.0607,
  clipY: 0.245,
  /** phase gates, as health fractions along the channel */
  gates: [0.25, 0.5, 0.75],
  /** width of one gate boss, as a fraction of the element HEIGHT */
  gateW: 0.58,
  /** radius of the stone socket in a gate, as a fraction of element HEIGHT */
  stoneR: 0.155,
};

/** Centre of a phase gate as a fraction of the bar element's width. */
export const bossGateX = (g) => BOSS_GEO.clipX + g * (1 - BOSS_GEO.clipX * 2);

/**
 * Box for the stone overlay, as a fraction of the bar element's HEIGHT.
 * `phaseStone` draws its cabochon at 0.30 of its own raster, so the overlay has
 * to be scaled up by the reciprocal for the stone to land in the socket.
 */
export const BOSS_STONE_H = (BOSS_GEO.stoneR * 2) / 0.60;

/** Heraldic shield outline (used for slot silhouettes + rank badges). */
function pathShield(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h * 0.56);
  ctx.quadraticCurveTo(x + w, y + h * 0.90, x + w * 0.5, y + h);
  ctx.quadraticCurveTo(x, y + h * 0.90, x, y + h * 0.56);
  ctx.closePath();
}

export class Ornament {
  constructor(atlas) {
    this.a = atlas;
  }

  /* ==================================================== bar trough / fill */

  /**
   * A recessed bar trough: iron band, gold hairline, transparent interior so
   * the fill element behind shows through, optional tick marks and phase
   * segment dividers cut into the rim.
   */
  barFrame(w, h, o = {}) {
    const ticks = o.ticks ?? 0;
    const segs = o.segs ?? 0;
    const band = o.band ?? Math.max(3, h * 0.20);
    const key = `bar:${o.tag ?? 'a'}:${ticks}:${segs}:${band.toFixed(1)}:${o.metal ?? 'iron'}:${o.cham ?? 0}`;
    return this.a.uri(key, w, h, (ctx, W, H) => {
      const cham = o.cham ?? Math.min(H * 0.42, 10);
      const outer = new Path2D(); pathCham(outer, 0.75, 0.75, W - 1.5, H - 1.5, cham);
      const inner = new Path2D(); pathCham(inner, band, band, W - band * 2, H - band * 2, Math.max(1, cham - band * 0.8));

      /* band = outer ∖ inner */
      const bandPath = new Path2D(); bandPath.addPath(outer); bandPath.addPath(inner);
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      this.a.material(ctx, 0, 0, W, H, o.metal ?? 'iron', { seed: 44, scale: 0.42 });
      const bg = ctx.createLinearGradient(0, 0, W * 0.06, H);
      bg.addColorStop(0, 'rgba(255,246,222,0.36)');
      bg.addColorStop(0.28, 'rgba(255,240,210,0.07)');
      bg.addColorStop(0.62, 'rgba(0,0,0,0.10)');
      bg.addColorStop(1, 'rgba(0,0,0,0.62)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.restore();

      /* hard rims */
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(3,4,6,0.95)'; ctx.stroke(outer);
      ctx.save(); ctx.translate(0, -0.9);
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(206,176,110,0.26)'; ctx.stroke(outer);
      ctx.restore();

      /* gold hairline just inside the band */
      const gi = new Path2D();
      pathCham(gi, band - 1.4, band - 1.4, W - (band - 1.4) * 2, H - (band - 1.4) * 2, Math.max(1, cham - band));
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(196,156,76,0.60)'; ctx.stroke(gi);
      ctx.save(); ctx.translate(0, -0.8);
      ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(246,227,168,0.40)'; ctx.stroke(gi);
      ctx.restore();

      /* interior occlusion cast by the rim (drawn INSIDE the trough, kept
         translucent so the fill still reads) */
      ctx.save();
      ctx.clip(inner);
      ctx.lineWidth = band * 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.42)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = band * 1.1;
      ctx.shadowOffsetY = band * 0.28;
      ctx.stroke(inner);
      ctx.restore();

      /* tick marks cut into the top rim */
      if (ticks > 0) {
        for (let i = 1; i < ticks; i++) {
          const x = Math.round(band + (W - band * 2) * (i / ticks)) + 0.5;
          const big = i % 5 === 0;
          const len = band * (big ? 1.55 : 0.95);
          ctx.beginPath();
          ctx.moveTo(x, band * 0.32); ctx.lineTo(x, band * 0.32 + len);
          ctx.lineWidth = big ? 1.6 : 1;
          ctx.strokeStyle = 'rgba(0,0,0,0.72)'; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + 1, band * 0.32); ctx.lineTo(x + 1, band * 0.32 + len);
          ctx.lineWidth = big ? 1 : 0.7;
          ctx.strokeStyle = 'rgba(232,206,150,0.30)'; ctx.stroke();
        }
      }

      /* phase segment dividers spanning the whole trough */
      if (segs > 1) {
        for (let i = 1; i < segs; i++) {
          const x = Math.round(band + (W - band * 2) * (i / segs)) + 0.5;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x, 1); ctx.lineTo(x, H - 1);
          ctx.lineWidth = Math.max(2.4, H * 0.055);
          ctx.strokeStyle = 'rgba(4,5,7,0.88)'; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + 1.2, 1); ctx.lineTo(x + 1.2, H - 1);
          ctx.lineWidth = Math.max(1, H * 0.022);
          ctx.strokeStyle = 'rgba(214,182,112,0.34)'; ctx.stroke();
          ctx.restore();
        }
      }

      /* end rivets */
      if (o.rivets !== false) {
        const rr = Math.max(2, band * 0.52);
        const inset = band * 0.5 + rr * 0.4;
        this.a.rivet(ctx, inset + cham * 0.35, H * 0.5, rr, 3);
        this.a.rivet(ctx, W - inset - cham * 0.35, H * 0.5, rr, 9);
      }
    });
  }

  /**
   * Liquid fill for a bar. Purely a vertical gradient plus grain, so the
   * element can be width-animated without stretching any horizontal feature.
   */
  barFill(h, colour, o = {}) {
    const W = 24;
    return this.a.uri(`fill:${colour}:${o.tag ?? 'a'}`, W, h, (ctx, w, H) => {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, lighten(colour, 0.52));
      g.addColorStop(0.16, lighten(colour, 0.26));
      g.addColorStop(0.46, colour);
      g.addColorStop(0.80, darken(colour, 0.42));
      g.addColorStop(1, darken(colour, 0.68));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, H);
      /* top gloss — a wet-looking bar has a hard specular line just under the
         meniscus, not a soft wash */
      const gl = ctx.createLinearGradient(0, 0, 0, H * 0.46);
      gl.addColorStop(0, 'rgba(255,252,242,0.30)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl; ctx.fillRect(0, 0, w, H * 0.46);
      ctx.fillStyle = 'rgba(255,252,240,0.92)';
      ctx.fillRect(0, Math.max(1, H * 0.14), w, Math.max(1, H * 0.10));
      ctx.fillStyle = 'rgba(255,250,236,0.42)';
      ctx.fillRect(0, Math.max(1, H * 0.24), w, Math.max(1, H * 0.07));
      /* bottom bounce */
      const bo = ctx.createLinearGradient(0, H * 0.72, 0, H);
      bo.addColorStop(0, 'rgba(255,255,255,0)');
      bo.addColorStop(1, rgba(colour, 0.22));
      ctx.fillStyle = bo; ctx.fillRect(0, H * 0.72, w, H * 0.28);
      this.a.layer(ctx, 'grain', { seed: 12, mode: 'overlay', alpha: 0.22, scale: 0.6 });
    });
  }

  /* =================================================== boss encounter bar */

  /**
   * The boss bar's forged trough.
   *
   * This is deliberately NOT `barFrame`. `barFrame` is chrome for a 9-px xp
   * strip and a 7-px nameplate bar: one iron band, a gold hairline and two
   * rivets, which is all those read at. The encounter bar is the largest single
   * piece of furniture in a fight and it was getting the same treatment, so next
   * to the orbs — which have glass, a cast bezel, flutes and a crown — it read
   * as a coloured strip laid over the frame rather than as part of the same
   * object. Captured proof: shots/_debug/laneF_bar_before.png.
   *
   * So it is built as an actual object, in the order a smith would: a beam,
   * caps forged onto its ends, a channel sunk into its face, a gilt fillet
   * around the channel, notches filed along the lip and phase bosses riveted
   * across it. Every one of those is a silhouette break, and silhouette breaks
   * are what stop a long horizontal object reading as a rectangle.
   *
   * The interior is transparent: the liquid element behind shows through, and
   * only the recess's own occlusion is painted over it.
   */
  bossTrough(w, h, o = {}) {
    const gates = o.gates ?? BOSS_GEO.gates;
    const ticks = o.ticks ?? 20;
    const key = `bosstr:${o.tag ?? 'a'}:${gates.join('_')}:${ticks}:${o.metal ?? 'iron'}`;
    return this.a.uri(key, w, h, (ctx, W, H) => {
      const bodyT = H * BOSS_GEO.beamT;
      const bodyH = H * (1 - BOSS_GEO.beamT * 2);
      const band = H * BOSS_GEO.band;
      const cham = bodyH * 0.34;
      const tx = W * BOSS_GEO.clipX;
      const ty = H * BOSS_GEO.clipY;
      const th = H * (1 - BOSS_GEO.clipY * 2);
      const BODY = { x: 0, y: bodyT, w: W, h: bodyH };
      const TROUGH = { x: tx, y: ty, w: W - tx * 2, h: th };

      const outer = new Path2D();
      pathCham(outer, 1, bodyT, W - 2, bodyH, cham);
      const inner = new Path2D();
      pathCham(inner, tx, ty, W - tx * 2, th, Math.max(1.5, th * 0.30));

      /* ---- 1. the beam. Lit per RUN, not per corner: a rail 23 times longer
         than it is tall has its whole top edge turned into a key at the upper
         left, and a corner-to-corner falloff would light 60 px of it and leave
         the other 1400 at base value. */
      const bandPath = new Path2D();
      bandPath.addPath(outer); bandPath.addPath(inner);
      ctx.save();
      ctx.clip(bandPath, 'evenodd');
      this.a.material(ctx, 0, bodyT, W, bodyH, o.metal ?? 'iron', { seed: 44, scale: 0.26 });
      this.a.runLight(ctx, band * 0.94, BODY, {
        hi: 0.70, lo: 0.80, crest: 0.34, tail: 0.28, loBand: band * 1.20,
      });
      /* The tonal ramp the run lighting cannot supply. `runLight` shades each
         RUN against its own edge, which is correct for the chamfers but leaves
         the rails at the material's own mid value along their whole length — and
         a 675-px object sitting at one mid grey in a frame with a mean of 0.12
         reads as a pale strip laid on top of the game rather than as iron in it.
         This is the object's overall stand in the key: lit crown, shaded belly. */
      const tone = ctx.createLinearGradient(0, bodyT, 0, bodyT + bodyH);
      tone.addColorStop(0, 'rgba(255,244,214,0.13)');
      tone.addColorStop(0.30, 'rgba(0,0,0,0.06)');
      tone.addColorStop(0.68, 'rgba(0,0,0,0.26)');
      tone.addColorStop(1, 'rgba(0,0,0,0.52)');
      ctx.fillStyle = tone;
      ctx.fillRect(0, bodyT, W, bodyH);
      ctx.restore();

      /* ---- 2. rims and the raised outer chamfer */
      ctx.lineWidth = Math.max(2, H * 0.036);
      ctx.strokeStyle = 'rgba(3,4,6,0.95)';
      ctx.stroke(outer);
      this.a.edgeBevel(ctx, outer, BODY, {
        width: Math.max(1.5, band * 0.34), offset: band * 0.16, hiA: 0.70, loA: 0.72,
      });
      this.a.edgeBevel(ctx, outer, BODY, { width: 1.0, offset: 0.6, hiA: 0.78, loA: 0.30 });

      /* ---- 3. the channel: occlusion under the top lip, a clean middle so the
         liquid keeps its own value, and a darker foot. A flat wash over the
         whole recess would cancel the fill's gloss and put us back where we
         started. */
      ctx.save();
      ctx.clip(inner);
      const oc = ctx.createLinearGradient(0, ty, 0, ty + th);
      oc.addColorStop(0, 'rgba(0,0,0,0.78)');
      oc.addColorStop(0.17, 'rgba(0,0,0,0.28)');
      oc.addColorStop(0.36, 'rgba(0,0,0,0.05)');
      oc.addColorStop(0.78, 'rgba(0,0,0,0.07)');
      oc.addColorStop(1, 'rgba(0,0,0,0.50)');
      ctx.fillStyle = oc;
      ctx.fillRect(0, ty, W, th);
      /* the ends of a sunk channel are in shade from the cap that closes them */
      for (const dir of [1, -1]) {
        const x0 = dir > 0 ? tx : W - tx;
        const eg = ctx.createLinearGradient(x0, 0, x0 + dir * th * 1.6, 0);
        eg.addColorStop(0, 'rgba(0,0,0,0.62)');
        eg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = eg;
        ctx.fillRect(Math.min(x0, x0 + dir * th * 1.6), ty, th * 1.6, th);
      }
      ctx.restore();
      this.a.edgeBevel(ctx, inner, TROUGH, {
        mode: 'inset',
        loW: Math.max(1.8, band * 0.66), loOff: Math.max(1, band * 0.28), loA: 0.94,
        hiW: Math.max(0.9, band * 0.22), hiOff: Math.max(0.5, band * 0.10), hiA: 0.52,
      });

      /* ---- 4. gilt fillet around the channel */
      const gk = band * 0.44;
      const fillet = new Path2D();
      pathCham(fillet, tx - gk, ty - gk, W - (tx - gk) * 2, th + gk * 2, Math.max(1, th * 0.30));
      this.a.goldStroke(ctx, BODY, Math.max(1.5, band * 0.30), fillet,
        { specW: 0.40, specA: 0.98, wear: 0.48, seed: 17 });

      /* ---- 5. notches filed along both lips. These are the "segment ticks":
         they give the eye a scale to read the remaining fraction against, which
         a smooth bar cannot do. Every fifth one is deeper. */
      ctx.save();
      ctx.clip(inner);
      for (let i = 1; i < ticks; i++) {
        const x = Math.round(tx + (W - tx * 2) * (i / ticks)) + 0.5;
        const big = i % 5 === 0;
        const len = th * (big ? 0.40 : 0.22);
        ctx.beginPath();
        ctx.moveTo(x, ty); ctx.lineTo(x, ty + len);
        ctx.lineWidth = big ? 2.0 : 1.2;
        ctx.strokeStyle = 'rgba(0,0,0,0.60)';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 1.3, ty); ctx.lineTo(x + 1.3, ty + len);
        ctx.lineWidth = big ? 1.2 : 0.8;
        ctx.strokeStyle = 'rgba(238,216,166,0.22)';
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, ty + th); ctx.lineTo(x, ty + th - len * 0.60);
        ctx.lineWidth = big ? 1.6 : 1.0;
        ctx.strokeStyle = 'rgba(0,0,0,0.46)';
        ctx.stroke();
      }
      ctx.restore();

      /* ---- 6. phase bosses, riveted across the beam at each gate */
      for (const g of gates) this._bossGate(ctx, tx + (W - tx * 2) * g, H);

      /* ---- 7. the forged end caps */
      for (const dir of [1, -1]) this._bossCap(ctx, dir > 0 ? 0 : W, dir, H);
    });
  }

  /**
   * One phase gate: a lozenge boss forged across the beam with a socket sunk
   * into it. The socket is drawn EMPTY here — the stone that fills it while the
   * gate is still sealed is `phaseStone`, laid over the top as its own element,
   * because whether a gate has broken is state and this raster is not.
   *
   * A gate has to break the bar's silhouette to read as inlaid rather than as a
   * dot printed on it, so the lozenge stands proud of the beam top and bottom.
   */
  _bossGate(ctx, cx, H) {
    const hw = H * BOSS_GEO.gateW * 0.5;
    const hh = H * 0.455;
    const cy = H * 0.5;
    const p = new Path2D();
    p.moveTo(cx, cy - hh);
    p.lineTo(cx + hw, cy - hh * 0.40);
    p.lineTo(cx + hw, cy + hh * 0.40);
    p.lineTo(cx, cy + hh);
    p.lineTo(cx - hw, cy + hh * 0.40);
    p.lineTo(cx - hw, cy - hh * 0.40);
    p.closePath();
    const BOX = { x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2 };
    ctx.save();
    ctx.clip(p);
    /* TWO FACETS meeting at a vertical crest, authored as an explicit ramp
       rather than a tiled material. The boss is ~15 device px wide by the time
       the bar is on screen, and at that size a 256-px material tile resolves to
       one flat tone — the previous pass read as a grey blob with a hole in it.
       A chisel's own cross-section is the only thing that survives the scale. */
    const fx = ctx.createLinearGradient(cx - hw, 0, cx + hw, 0);
    fx.addColorStop(0, '#161b21');
    fx.addColorStop(0.16, '#39424c');
    fx.addColorStop(0.44, '#8e98a5');
    fx.addColorStop(0.52, '#a2acb8');
    fx.addColorStop(0.62, '#3d454f');
    fx.addColorStop(1, '#0b0e12');
    ctx.fillStyle = fx;
    ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
    const fy = ctx.createLinearGradient(0, cy - hh, 0, cy + hh);
    fy.addColorStop(0, 'rgba(255,248,226,0.24)');
    fy.addColorStop(0.34, 'rgba(0,0,0,0)');
    fy.addColorStop(1, 'rgba(0,0,0,0.66)');
    ctx.fillStyle = fy;
    ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
    ctx.restore();
    ctx.lineWidth = Math.max(1.6, H * 0.034);
    ctx.strokeStyle = 'rgba(2,3,5,0.96)';
    ctx.stroke(p);
    this.a.edgeBevel(ctx, p, BOX, {
      width: Math.max(1.2, hw * 0.26), offset: hw * 0.12, hiA: 0.78, loA: 0.80,
    });
    /* the socket: a drilled seat with its own inset bevel and a black floor */
    const sr = H * BOSS_GEO.stoneR;
    const sock = new Path2D();
    sock.arc(cx, cy, sr, 0, TAU);
    ctx.save();
    ctx.clip(sock);
    const sg = ctx.createRadialGradient(cx - sr * 0.3, cy - sr * 0.36, sr * 0.05, cx, cy, sr);
    sg.addColorStop(0, '#141922');
    sg.addColorStop(0.6, '#080a0e');
    sg.addColorStop(1, '#030406');
    ctx.fillStyle = sg;
    ctx.fillRect(cx - sr, cy - sr, sr * 2, sr * 2);
    ctx.restore();
    this.a.edgeBevel(ctx, sock, { x: cx - sr, y: cy - sr, w: sr * 2, h: sr * 2 }, {
      mode: 'inset',
      loW: Math.max(1, sr * 0.52), loA: 0.96,
      hiW: Math.max(0.7, sr * 0.26), hiA: 0.58,
    });
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.90)';
    ctx.stroke(sock);
  }

  /**
   * A forged terminal on one end of the beam. `dir` is +1 for the left cap and
   * -1 for the right, so the same spearhead profile is mirrored rather than
   * authored twice and allowed to drift.
   */
  _bossCap(ctx, x0, dir, H) {
    const cw = H * 1.24;
    const cy = H * 0.5;
    const X = (k) => x0 + dir * cw * k;
    /* A spearhead, not a paddle: one real point, shoulders swept back off it,
       and a shorter bevelled run into the beam. Kept to a single convex
       silhouette on purpose — an earlier profile pinched a waist behind the
       shoulders, and at 25 device px the two extra vertices read as a notch cut
       out of the cap rather than as forging. */
    const p = new Path2D();
    p.moveTo(X(0.00), cy);
    p.lineTo(X(0.30), H * 0.055);
    p.lineTo(X(0.80), H * 0.175);
    p.lineTo(X(1.00), H * 0.42);
    p.lineTo(X(1.00), H * 0.58);
    p.lineTo(X(0.80), H * 0.825);
    p.lineTo(X(0.30), H * 0.945);
    p.closePath();
    const BOX = { x: Math.min(x0, X(1)), y: 0, w: cw, h: H };
    ctx.save();
    ctx.clip(p);
    this.a.material(ctx, BOX.x, 0, cw, H, 'iron', { seed: 63, scale: 0.10 });
    this.a.runLight(ctx, H * 0.24, BOX, { hi: 0.62, lo: 0.80, crest: 0.36, tail: 0.28 });
    /* the cap is forged thicker than the beam, so its belly falls further */
    const tone = ctx.createLinearGradient(0, 0, 0, H);
    tone.addColorStop(0, 'rgba(255,246,220,0.16)');
    tone.addColorStop(0.34, 'rgba(0,0,0,0.06)');
    tone.addColorStop(0.72, 'rgba(0,0,0,0.30)');
    tone.addColorStop(1, 'rgba(0,0,0,0.58)');
    ctx.fillStyle = tone;
    ctx.fillRect(BOX.x, 0, cw, H);
    ctx.restore();
    ctx.lineWidth = Math.max(1.6, H * 0.034);
    ctx.strokeStyle = 'rgba(3,4,6,0.96)';
    ctx.stroke(p);
    this.a.edgeBevel(ctx, p, BOX, {
      width: Math.max(1.4, H * 0.050), offset: H * 0.020, hiA: 0.74, loA: 0.78,
    });
    this.a.edgeBevel(ctx, p, BOX, { width: 1.0, offset: 0.6, hiA: 0.82, loA: 0.30 });
    /* a gilt keel down the cap's spine, then the rivet that holds it on */
    const keel = new Path2D();
    keel.moveTo(X(0.16), cy);
    keel.lineTo(X(0.94), cy);
    this.a.goldStroke(ctx, BOX, Math.max(1.2, H * 0.034), keel, { specW: 0.42, wear: 0.44, seed: 29 });
    this.a.rivet(ctx, X(0.52), cy, Math.max(1.6, H * 0.098), 7);
  }

  /**
   * The stone in a phase socket, shown only while that gate is still sealed.
   *
   * A real cabochon in a gold collet, plus the coloured bounce the surrounding
   * steel would pick up from it — the bounce is what makes the stone read as
   * set INTO the boss rather than stuck on it, and it costs one gradient.
   */
  phaseStone(size, colour = '#d8452c') {
    return this.a.uri(`bossstone:${colour}`, size, size, (ctx, S) => {
      const c = S * 0.5;
      const r = S * 0.30;
      const halo = ctx.createRadialGradient(c, c, r * 0.90, c, c, r * 1.66);
      halo.addColorStop(0, rgba(colour, 0.46));
      halo.addColorStop(1, rgba(colour, 0));
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(c, c, r * 1.66, 0, TAU); ctx.fill();
      this.a.gem(ctx, c, c, r, colour);
    });
  }

  /**
   * The name plate: a cast cartouche with pointed ends, a gilt border and a
   * field sunk below it for the lettering.
   *
   * It replaces a leather ribbon that rendered as a pale sand-coloured band —
   * the single lightest object in the boss frame, and near enough featureless
   * at the size it is actually seen. A dark cast field is both truer to the
   * reference and the only surface gilded lettering has any contrast against.
   */
  bossCartouche(w, h, o = {}) {
    return this.a.uri(`bosscart:${o.tag ?? 'a'}`, w, h, (ctx, W, H) => {
      const tip = H * 0.72;
      const BOX = { x: 0, y: 0, w: W, h: H };
      const p = new Path2D();
      p.moveTo(0, H * 0.5);
      p.lineTo(tip * 0.72, H * 0.10);
      p.lineTo(W - tip * 0.72, H * 0.10);
      p.lineTo(W, H * 0.5);
      p.lineTo(W - tip * 0.72, H * 0.90);
      p.lineTo(tip * 0.72, H * 0.90);
      p.closePath();

      ctx.save();
      ctx.clip(p);
      this.a.material(ctx, 0, 0, W, H, 'iron', { seed: 71, scale: 0.22 });
      this.a.runLight(ctx, H * 0.20, BOX, { hi: 0.62, lo: 0.72, crest: 0.34, tail: 0.30 });
      /* the plate is darkened toward its middle so the type has a field to sit
         on that is quieter than the rails around it */
      const vg = ctx.createRadialGradient(W * 0.42, H * 0.40, H * 0.10, W * 0.5, H * 0.5, W * 0.56);
      vg.addColorStop(0, 'rgba(0,0,0,0.30)');
      vg.addColorStop(0.55, 'rgba(0,0,0,0.52)');
      vg.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      ctx.lineWidth = Math.max(2, H * 0.030);
      ctx.strokeStyle = 'rgba(3,4,6,0.95)';
      ctx.stroke(p);
      this.a.edgeBevel(ctx, p, BOX, {
        width: Math.max(1.8, H * 0.075), offset: H * 0.026, hiA: 0.96, loA: 0.70,
      });
      this.a.edgeBevel(ctx, p, BOX, { width: 1.2, offset: 0.6, hiA: 1.0, loA: 0.28 });

      /* the sunk field, then the gilt border that frames it */
      const k = H * 0.19;
      const fld = new Path2D();
      fld.moveTo(k * 0.7, H * 0.5);
      fld.lineTo(tip * 0.72 + k * 0.5, H * 0.10 + k);
      fld.lineTo(W - tip * 0.72 - k * 0.5, H * 0.10 + k);
      fld.lineTo(W - k * 0.7, H * 0.5);
      fld.lineTo(W - tip * 0.72 - k * 0.5, H * 0.90 - k);
      fld.lineTo(tip * 0.72 + k * 0.5, H * 0.90 - k);
      fld.closePath();
      ctx.save();
      ctx.clip(fld);
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      this.a.edgeBevel(ctx, fld, BOX, {
        mode: 'inset',
        loW: Math.max(1.4, H * 0.055), loOff: Math.max(0.8, H * 0.022), loA: 0.92,
        hiW: Math.max(0.8, H * 0.020), hiOff: 0.6, hiA: 0.50,
      });
      this.a.goldStroke(ctx, BOX, Math.max(1.4, H * 0.038), fld,
        { specW: 0.42, specA: 1.0, wear: 0.46, seed: 41 });

      /* bosses in the two points, where a real plate would be pinned */
      const rr = Math.max(1.6, H * 0.085);
      this.a.rivet(ctx, tip * 0.40, H * 0.5, rr, 11);
      this.a.rivet(ctx, W - tip * 0.40, H * 0.5, rr, 13);
    });
  }

  /**
   * Liquid for the encounter bar. Same contract as `barFill` — a purely
   * vertical section, so width-animating the element cannot stretch anything —
   * but authored with the range a 30-px trough can actually show: a hot crown
   * under the meniscus, the body colour through the middle, and a foot that
   * goes nearly black where the channel occludes it.
   */
  bossFill(h, colour, o = {}) {
    const W = 24;
    return this.a.uri(`bossfill:${colour}:${o.tag ?? 'a'}`, W, h, (ctx, w, H) => {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, lighten(colour, 0.66));
      g.addColorStop(0.10, lighten(colour, 0.42));
      g.addColorStop(0.30, lighten(colour, 0.12));
      g.addColorStop(0.52, colour);
      g.addColorStop(0.78, darken(colour, 0.46));
      g.addColorStop(1, darken(colour, 0.76));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, H);
      /* the meniscus: a hard specular line, not a soft wash — this is the cue
         that reads as a wet surface rather than a printed gradient */
      ctx.fillStyle = 'rgba(255,250,236,0.86)';
      ctx.fillRect(0, Math.max(1, H * 0.12), w, Math.max(1, H * 0.075));
      ctx.fillStyle = 'rgba(255,246,226,0.34)';
      ctx.fillRect(0, Math.max(1, H * 0.205), w, Math.max(1, H * 0.055));
      /* bounce off the channel floor, in the liquid's own hue */
      const bo = ctx.createLinearGradient(0, H * 0.68, 0, H);
      bo.addColorStop(0, 'rgba(255,255,255,0)');
      bo.addColorStop(1, rgba(colour, 0.30));
      ctx.fillStyle = bo;
      ctx.fillRect(0, H * 0.68, w, H * 0.32);
      this.a.layer(ctx, 'grain', { seed: 12, mode: 'overlay', alpha: 0.26, scale: 0.5 });
    });
  }

  /**
   * The hot leading edge of the fill — the front where the liquid is being
   * burned back.
   *
   * It is a separate raster pinned to the fill's right edge rather than part of
   * `bossFill` because the fill is width-animated: any horizontal feature baked
   * into that texture would slide and stretch with the health fraction. Pinned,
   * it stays a fixed number of pixels wide at every value.
   *
   * Kept narrow on purpose. The frame it lives in has a mean of 0.12 and the
   * brief is a boss bar, not a light source.
   */
  bossEdge(h, colour = '#ff9a54', o = {}) {
    const W = 40;
    return this.a.uri(`bossedge:${colour}:${o.tag ?? 'a'}`, W, h, (ctx, w, H) => {
      /* along the bar: nothing at the left, the whole heat inside the last
         third, and a hard pin on the face itself */
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, rgba(colour, 0));
      g.addColorStop(0.52, rgba(colour, 0.18));
      g.addColorStop(0.84, rgba(colour, 0.62));
      g.addColorStop(1, rgba(colour, 0.96));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, H);
      /* across the bar: the front is hottest at the meniscus and cools into the
         shaded foot, exactly as the liquid behind it does */
      const v = ctx.createLinearGradient(0, 0, 0, H);
      v.addColorStop(0, 'rgba(0,0,0,0.34)');
      v.addColorStop(0.22, 'rgba(0,0,0,0)');
      v.addColorStop(0.68, 'rgba(0,0,0,0.10)');
      v.addColorStop(1, 'rgba(0,0,0,0.52)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, w, H);
      ctx.globalCompositeOperation = 'source-over';
      /* the face: near-white where the front is thinnest */
      const f = ctx.createLinearGradient(w - Math.max(2, w * 0.10), 0, w, 0);
      f.addColorStop(0, 'rgba(255,246,224,0)');
      f.addColorStop(1, 'rgba(255,248,228,0.92)');
      ctx.fillStyle = f;
      ctx.fillRect(w - Math.max(2, w * 0.10), H * 0.10, Math.max(2, w * 0.10), H * 0.78);
    });
  }

  /** Any UIAtlas seamless tile as a cached data URI (for CSS backgrounds). */
  tileURI(name, size = 128, seed = 3) {
    return this.a.uri(`tileu:${name}:${seed}`, size, size, (ctx, W) => {
      const t = this.a.tile(name, size, seed);
      ctx.drawImage(t, 0, 0, W, W);
    });
  }

  /**
   * Orb liquid body: a vertical column that is brightest just under the
   * surface and nearly black at the bottom of the vessel, with subsurface
   * scatter. Stretched vertically by the fill level — deliberately contains no
   * horizontal feature so stretching is invisible.
   */
  orbLiquid(colour) {
    return this.a.uri(`orbliq:${colour}`, 32, 256, (ctx, W, H) => {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, lighten(colour, 0.60));
      g.addColorStop(0.05, lighten(colour, 0.34));
      g.addColorStop(0.20, lighten(colour, 0.10));
      g.addColorStop(0.52, colour);
      g.addColorStop(0.82, darken(colour, 0.52));
      g.addColorStop(1, darken(colour, 0.80));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      /* surface sheen */
      const s = ctx.createLinearGradient(0, 0, 0, H * 0.09);
      s.addColorStop(0, 'rgba(255,255,255,0.42)');
      s.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = s; ctx.fillRect(0, 0, W, H * 0.09);
    });
  }

  /** A chamfered metal plate — level numeral, tab labels, key caps. */
  plate(w, h, o = {}) {
    const metal = o.metal ?? 'iron';
    return this.a.uri(`plate:${metal}:${o.tag ?? 'a'}:${o.cham ?? 0}`, w, h, (ctx, W, H) => {
      const cham = o.cham ?? Math.min(W, H) * 0.26;
      const p = new Path2D(); pathCham(p, 1.2, 1.2, W - 2.4, H - 2.4, cham);
      ctx.save();
      ctx.clip(p);
      this.a.material(ctx, 0, 0, W, H, metal, { seed: 71, scale: 0.4 });
      const g = ctx.createLinearGradient(0, 0, W * 0.2, H);
      g.addColorStop(0, 'rgba(255,248,226,0.18)');
      g.addColorStop(0.34, 'rgba(255,240,208,0.04)');
      g.addColorStop(1, 'rgba(0,0,0,0.64)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(3,4,6,0.95)'; ctx.stroke(p);
      /* raised chamfer: hard catch-light on the light-facing faces */
      const PB = { x: 0, y: 0, w: W, h: H };
      this.a.edgeBevel(ctx, p, PB, { width: Math.max(1.4, Math.min(W, H) * 0.10), hiA: 0.97, loA: 0.68 });
      this.a.edgeBevel(ctx, p, PB, { width: 1.0, offset: 0.6, hiA: 1.0, loA: 0.3 });
      if (o.inlay !== false) {
        const gi = new Path2D();
        const k = Math.max(2, Math.min(W, H) * 0.11);
        pathCham(gi, k, k, W - k * 2, H - k * 2, Math.max(1, cham - k));
        this.a.goldStroke(ctx, PB, Math.max(1.3, Math.min(W, H) * 0.032), gi, { specW: 0.42 });
      }
      if (o.rivets) {
        const rr = Math.max(1.6, Math.min(W, H) * 0.07);
        const in2 = Math.min(W, H) * 0.16;
        for (const [px, py] of [[in2, in2], [W - in2, in2], [in2, H - in2], [W - in2, H - in2]]) {
          this.a.rivet(ctx, px, py, rr, 5 + px);
        }
      }
    });
  }

  /**
   * A banner ribbon with swallow-tail ends — boss name, panel titles. Field is
   * dark cloth so gold lettering sits on it legibly.
   */
  ribbon(w, h, o = {}) {
    return this.a.uri(`ribbon:${o.tag ?? 'a'}:${o.tint ?? 'x'}`, w, h, (ctx, W, H) => {
      const tail = Math.min(W * 0.10, H * 0.85);
      const p = new Path2D();
      p.moveTo(0, H * 0.06);
      p.lineTo(W, H * 0.06);
      p.lineTo(W - tail, H * 0.5);
      p.lineTo(W, H * 0.94);
      p.lineTo(0, H * 0.94);
      p.lineTo(tail, H * 0.5);
      p.closePath();
      ctx.save();
      ctx.clip(p);
      this.a.material(ctx, 0, 0, W, H, 'leather', { seed: 91, scale: 0.5 });
      const tint = o.tint ?? '#3a0f0a';
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, rgba(tint, 0.55));
      g.addColorStop(0.45, rgba(tint, 0.24));
      g.addColorStop(1, 'rgba(0,0,0,0.78)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const sh = ctx.createLinearGradient(0, 0, 0, H * 0.34);
      sh.addColorStop(0, 'rgba(255,244,214,0.16)');
      sh.addColorStop(1, 'rgba(255,244,214,0)');
      ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H * 0.34);
      ctx.restore();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(3,4,6,0.9)'; ctx.stroke(p);
      ctx.save(); ctx.translate(0, -0.9);
      ctx.lineWidth = 1.1; ctx.strokeStyle = 'rgba(198,158,78,0.44)'; ctx.stroke(p);
      ctx.restore();
    });
  }

  /* ======================================================== minimap bezel */

  /**
   * Ornate circular bezel with a transparent centre: hammered iron ring, gold
   * inlay, 4 compass points, rivets, and a cast shadow inward.
   */
  circleFrame(size, o = {}) {
    return this.a.uri(`cfrm:${o.tag ?? 'a'}`, size, size, (ctx, W) => {
      const s = W, c = s * 0.5;
      const rOut = s * 0.492, rIn = s * 0.405;
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rOut, 0, TAU);
      ctx.arc(c, c, rIn, 0, TAU, true);
      ctx.clip();
      this.a.material(ctx, 0, 0, s, s, 'iron', { seed: 63, scale: 0.5 });
      const lg = ctx.createLinearGradient(0, 0, s * 0.3, s);
      lg.addColorStop(0, 'rgba(255,246,220,0.40)');
      lg.addColorStop(0.24, 'rgba(255,240,210,0.08)');
      lg.addColorStop(1, 'rgba(0,0,0,0.66)');
      ctx.fillStyle = lg; ctx.fillRect(0, 0, s, s);
      /* cable moulding */
      ctx.globalCompositeOperation = 'overlay';
      const N = 44;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU;
        ctx.save(); ctx.translate(c, c); ctx.rotate(a);
        const fg = ctx.createLinearGradient(rIn, 0, rOut, 0);
        fg.addColorStop(0, 'rgba(0,0,0,0.30)');
        fg.addColorStop(0.45, 'rgba(255,255,255,0.24)');
        fg.addColorStop(1, 'rgba(0,0,0,0.34)');
        ctx.fillStyle = fg;
        const hw = (TAU / N) * 0.32;
        ctx.beginPath();
        ctx.moveTo(Math.cos(-hw) * rIn, Math.sin(-hw) * rIn);
        ctx.lineTo(Math.cos(-hw) * rOut, Math.sin(-hw) * rOut);
        ctx.lineTo(Math.cos(hw) * rOut, Math.sin(hw) * rOut);
        ctx.lineTo(Math.cos(hw) * rIn, Math.sin(hw) * rIn);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      const ring = (r, lw, col, dy = 0) => {
        ctx.save(); ctx.translate(0, dy);
        ctx.beginPath(); ctx.arc(c, c, r, 0, TAU);
        ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
        ctx.restore();
      };
      ring(rOut, 2.4, 'rgba(3,4,6,0.95)');
      ring(rOut - 1.2, 1.1, 'rgba(214,182,112,0.32)', -1.0);
      ring(rIn + s * 0.014, Math.max(2, s * 0.017), 'rgba(198,158,78,0.68)');
      ring(rIn + s * 0.014, Math.max(1, s * 0.007), 'rgba(248,231,176,0.4)', -1.0);
      ring(rIn, 2.4, 'rgba(2,3,5,0.95)');

      /* inner cast shadow onto the map */
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU); ctx.clip();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU);
      ctx.lineWidth = s * 0.05; ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = s * 0.05;
      ctx.shadowOffsetY = s * 0.012;
      ctx.stroke();
      ctx.restore();

      /* compass points: gold fleurons at N/E/S/W */
      for (let q = 0; q < 4; q++) {
        const a = -Math.PI * 0.5 + q * (Math.PI * 0.5);
        ctx.save();
        ctx.translate(c + Math.cos(a) * (rOut + rIn) * 0.5, c + Math.sin(a) * (rOut + rIn) * 0.5);
        ctx.rotate(a + Math.PI * 0.5);
        const k = s * 0.045;
        ctx.beginPath();
        ctx.moveTo(0, -k); ctx.lineTo(k * 0.62, 0); ctx.lineTo(0, k); ctx.lineTo(-k * 0.62, 0);
        ctx.closePath();
        const gg = ctx.createLinearGradient(-k, -k, k, k);
        gg.addColorStop(0, '#f4e0a6'); gg.addColorStop(0.5, '#b48d3c'); gg.addColorStop(1, '#4a3512');
        ctx.fillStyle = gg; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
        ctx.restore();
      }
      /* rivets between the compass points */
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI * 0.25 + i * (Math.PI * 0.25);
        if (i % 2 === 1) continue;
        const rr = (rOut + rIn) * 0.5;
        this.a.rivet(ctx, c + Math.cos(a) * rr, c + Math.sin(a) * rr, s * 0.021, 17 + i);
      }
    });
  }

  /* ================================================= equipment silhouettes */

  /** Ghosted line-art of the item that belongs in an empty equipment slot. */
  slotSil(size, kind) {
    return this.a.uri(`sil:${kind}`, size, size, (ctx, S) => {
      const c = S * 0.5;
      ctx.save();
      ctx.strokeStyle = 'rgba(150,140,116,0.30)';
      ctx.fillStyle = 'rgba(150,140,116,0.13)';
      ctx.lineWidth = Math.max(1.2, S * 0.030);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const R = (x, y, w, h, r) => { const p = new Path2D(); pathRound(p, c + x * S, c + y * S, w * S, h * S, r * S); ctx.fill(p); ctx.stroke(p); };
      switch (kind) {
        case 'helm':
          ctx.beginPath();
          ctx.moveTo(c - S * 0.22, c + S * 0.16);
          ctx.bezierCurveTo(c - S * 0.26, c - S * 0.18, c - S * 0.11, c - S * 0.30, c, c - S * 0.30);
          ctx.bezierCurveTo(c + S * 0.11, c - S * 0.30, c + S * 0.26, c - S * 0.18, c + S * 0.22, c + S * 0.16);
          ctx.lineTo(c + S * 0.15, c + S * 0.26); ctx.lineTo(c - S * 0.15, c + S * 0.26);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          break;
        case 'chest':
          ctx.beginPath();
          ctx.moveTo(c - S * 0.08, c - S * 0.28); ctx.lineTo(c + S * 0.08, c - S * 0.28);
          ctx.lineTo(c + S * 0.26, c - S * 0.14); ctx.lineTo(c + S * 0.20, c + S * 0.28);
          ctx.lineTo(c - S * 0.20, c + S * 0.28); ctx.lineTo(c - S * 0.26, c - S * 0.14);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          break;
        case 'gloves':
          R(-0.24, -0.16, 0.20, 0.36, 0.05); R(0.04, -0.16, 0.20, 0.36, 0.05);
          break;
        case 'boots':
          for (const sg of [-1, 1]) {
            ctx.beginPath();
            const bx = c + sg * S * 0.12;
            ctx.moveTo(bx - S * 0.06, c - S * 0.26); ctx.lineTo(bx + S * 0.06, c - S * 0.26);
            ctx.lineTo(bx + S * 0.07, c + S * 0.12); ctx.lineTo(bx + sg * S * 0.09, c + S * 0.20);
            ctx.lineTo(bx - S * 0.07, c + S * 0.20);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          }
          break;
        case 'belt':
          R(-0.30, -0.08, 0.60, 0.16, 0.03);
          break;
        case 'ring':
          ctx.beginPath(); ctx.arc(c, c + S * 0.04, S * 0.18, 0, TAU);
          ctx.lineWidth = Math.max(2, S * 0.06); ctx.stroke();
          break;
        case 'amulet':
          ctx.beginPath();
          ctx.moveTo(c - S * 0.20, c - S * 0.26);
          ctx.quadraticCurveTo(c, c + S * 0.02, c + S * 0.20, c - S * 0.26);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(c, c - S * 0.02); ctx.lineTo(c + S * 0.12, c + S * 0.12);
          ctx.lineTo(c, c + S * 0.28); ctx.lineTo(c - S * 0.12, c + S * 0.12);
          ctx.closePath(); ctx.fill(); ctx.stroke();
          break;
        case 'shield':
          pathShield(ctx, c - S * 0.22, c - S * 0.26, S * 0.44, S * 0.54);
          ctx.fill(); ctx.stroke();
          break;
        case 'weapon':
        default:
          ctx.beginPath();
          ctx.moveTo(c, c - S * 0.32); ctx.lineTo(c + S * 0.05, c - S * 0.22);
          ctx.lineTo(c + S * 0.05, c + S * 0.06); ctx.lineTo(c - S * 0.05, c + S * 0.06);
          ctx.lineTo(c - S * 0.05, c - S * 0.22); ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(c - S * 0.17, c + S * 0.08); ctx.lineTo(c + S * 0.17, c + S * 0.08);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(c, c + S * 0.10); ctx.lineTo(c, c + S * 0.30);
          ctx.lineWidth = Math.max(2, S * 0.05); ctx.stroke();
          break;
      }
      ctx.restore();
    });
  }

  /* ========================================================= rank badges */

  /** Elite / champion / boss badge: a heraldic shield with a cut device. */
  rankIcon(size, rank = 'champion') {
    return this.a.uri(`rank:${rank}`, size, size, (ctx, S) => {
      const c = S * 0.5;
      const tint = rank === 'boss' ? '#c0392b' : rank === 'champion' ? '#e0c74e' : '#8fbcf4';
      pathShield(ctx, S * 0.14, S * 0.08, S * 0.72, S * 0.84);
      const g = ctx.createLinearGradient(S * 0.14, S * 0.08, S * 0.86, S * 0.92);
      g.addColorStop(0, '#8b939d'); g.addColorStop(0.35, '#4a5158');
      g.addColorStop(0.75, '#22272c'); g.addColorStop(1, '#0d1013');
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(1.4, S * 0.045);
      ctx.strokeStyle = 'rgba(3,4,6,0.92)'; ctx.stroke();
      ctx.save();
      ctx.lineWidth = Math.max(1, S * 0.028);
      ctx.strokeStyle = rgba(tint, 0.72); ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(c, c * 1.02);
      ctx.strokeStyle = rgba(tint, 0.95);
      ctx.fillStyle = rgba(tint, 0.9);
      ctx.lineWidth = Math.max(1.2, S * 0.055);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = rgba(tint, 0.7); ctx.shadowBlur = S * 0.10;
      if (rank === 'boss') {
        /* horned skull */
        ctx.beginPath();
        ctx.moveTo(-S * 0.14, -S * 0.02);
        ctx.bezierCurveTo(-S * 0.16, -S * 0.22, S * 0.16, -S * 0.22, S * 0.14, -S * 0.02);
        ctx.bezierCurveTo(S * 0.13, S * 0.12, -S * 0.13, S * 0.12, -S * 0.14, -S * 0.02);
        ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.arc(-S * 0.06, -S * 0.02, S * 0.035, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(S * 0.06, -S * 0.02, S * 0.035, 0, TAU); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-S * 0.15, -S * 0.12); ctx.lineTo(-S * 0.26, -S * 0.24);
        ctx.moveTo(S * 0.15, -S * 0.12); ctx.lineTo(S * 0.26, -S * 0.24);
        ctx.lineWidth = Math.max(1, S * 0.04); ctx.stroke();
      } else {
        /* four-pointed star with a centre pip */
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = -Math.PI * 0.5 + i * (Math.PI / 4);
          const r = i % 2 === 0 ? S * 0.21 : S * 0.075;
          const x = Math.cos(a) * r, y = Math.sin(a) * r;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = Math.max(1, S * 0.03);
        ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
      ctx.restore();
    });
  }

  /* ================================================== skill-tree node frame */

  /**
   * Skill node: an octagonal cast frame. state = 'locked' | 'open' | 'ranked'
   * | 'maxed'. The interior is transparent so a glyph shows through.
   */
  node(size, state = 'open') {
    return this.a.uri(`node:${state}`, size, size, (ctx, S) => {
      const c = S * 0.5;
      const rOut = S * 0.47, rIn = S * 0.335;
      const oct = (r, rot = Math.PI / 8) => {
        const p = new Path2D();
        for (let i = 0; i < 8; i++) {
          const a = rot + i * (TAU / 8);
          const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
          i ? p.lineTo(x, y) : p.moveTo(x, y);
        }
        p.closePath();
        return p;
      };
      const outer = oct(rOut), inner = oct(rIn);
      const band = new Path2D(); band.addPath(outer); band.addPath(inner);

      const metal = state === 'maxed' ? 'gold' : state === 'locked' ? 'stone' : 'iron';
      ctx.save();
      ctx.clip(band, 'evenodd');
      this.a.material(ctx, 0, 0, S, S, metal, { seed: 83, scale: 0.42 });
      /* the cast collar's chamfer, lit per run: the facets that face up and left
         carry the key along their whole length, the ones facing down and right go
         to black. A corner-only falloff leaves fifteen of these reading as flat
         dark rings with a speck on one corner. */
      this.a.runLight(ctx, (rOut - rIn) * 1.25, { x: c - rOut, y: c - rOut, w: rOut * 2, h: rOut * 2 }, {
        hi: metal === 'gold' ? 0.90 : 0.84, lo: 0.72, crest: 0.32,
        tint: metal === 'gold' ? '255,244,208' : '255,250,238',
      });
      const g = ctx.createLinearGradient(0, 0, S * 0.60, S);
      g.addColorStop(0, 'rgba(255,246,220,0.10)');
      g.addColorStop(0.34, 'rgba(255,240,208,0.02)');
      g.addColorStop(1, 'rgba(0,0,0,0.56)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      ctx.restore();

      const NB = { x: 0, y: 0, w: S, h: S };
      ctx.lineWidth = Math.max(1.6, S * 0.026);
      ctx.strokeStyle = 'rgba(3,4,6,0.95)'; ctx.stroke(outer);
      /* cast collar: raised chamfer outside, sunk lip inside */
      this.a.edgeBevel(ctx, outer, NB, { width: Math.max(1.8, S * 0.074), offset: Math.max(0.9, S * 0.036), hiA: 1.0, loA: 0.70 });
      this.a.edgeBevel(ctx, outer, NB, { width: 1.0, offset: 0.6, hiA: 1.0, loA: 0.3 });
      ctx.lineWidth = Math.max(1.3, S * 0.020);
      ctx.strokeStyle = 'rgba(2,3,5,0.9)'; ctx.stroke(inner);
      /* the hard hits on the two collar facets that turn squarely into the key.
         A cast octagon with no specular anywhere on its rim reads as a printed
         ring however carefully its bevel is shaded. */
      ctx.save();
      ctx.clip(band, 'evenodd');
      const hrN = Math.max(2.0, S * 0.075);
      this.a.hotSpot(ctx, c - rOut * 0.60, c - rOut * 0.60, hrN * 1.5,
        { a: 1.0, squash: 0.26, rot: -0.785, coreR: 0.28 });
      this.a.hotSpot(ctx, c + rOut * 0.16, c - rOut * 0.88, hrN * 1.05,
        { a: 0.86, squash: 0.20, rot: 0.30, coreR: 0.24 });
      this.a.hotSpot(ctx, c - rOut * 0.88, c + rOut * 0.18, hrN,
        { a: 0.66, squash: 0.20, rot: Math.PI * 0.5 - 0.3, coreR: 0.22 });
      if (S >= 80) {
        this.a.glint(ctx, c - rOut * 0.60, c - rOut * 0.60, S * 0.13,
          { a: 0.60, tint: state === 'maxed' ? '255,241,199' : '255,249,233', rot: -0.785 });
      }
      ctx.restore();

      /* recess behind the glyph */
      ctx.save();
      ctx.clip(inner);
      const rg = ctx.createRadialGradient(c + rIn * 0.3, c + rIn * 0.35, rIn * 0.06, c, c, rIn * 1.1);
      rg.addColorStop(0, 'rgba(46,44,38,0.62)');
      rg.addColorStop(0.55, 'rgba(9,11,14,0.86)');
      rg.addColorStop(1, 'rgba(0,0,0,0.96)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, S, S);
      ctx.restore();
      /* the tablet behind the glyph is glazed — one raking band with a crest */
      this.a.glaze(ctx, inner, NB, { a: 0.26, wid: 0.44, len: 1.1, cx: 0.16, cy: 0.10, fall: 1.8 });
      this.a.edgeBevel(ctx, inner, NB, {
        mode: 'inset', width: Math.max(1.4, S * 0.052), offset: Math.max(0.8, S * 0.026),
        loA: 0.96, hiA: 0.74,
      });

      if (state === 'locked') {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = 'rgba(10,12,16,0.42)';
        ctx.fillRect(0, 0, S, S);
        ctx.restore();
      } else {
        /* active nodes get a gold inlay ring + 4 corner pips */
        const gi = oct(rIn + S * 0.028);
        ctx.lineWidth = Math.max(1.1, S * 0.016);
        ctx.strokeStyle = state === 'maxed' ? 'rgba(246,227,168,0.85)' : 'rgba(196,156,76,0.62)';
        ctx.stroke(gi);
        for (let i = 0; i < 4; i++) {
          const a = i * (TAU / 4) + Math.PI / 4;
          this.a.rivet(ctx, c + Math.cos(a) * (rOut + rIn) * 0.5, c + Math.sin(a) * (rOut + rIn) * 0.5, S * 0.036, 21 + i);
        }
      }
      if (state === 'maxed') {
        ctx.save();
        ctx.beginPath(); ctx.arc(c, c, rOut, 0, TAU);
        ctx.strokeStyle = 'rgba(240,214,140,0.30)';
        ctx.lineWidth = S * 0.05;
        ctx.shadowColor = 'rgba(226,180,90,0.8)'; ctx.shadowBlur = S * 0.14;
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  /** Filigree connector between two skill nodes (a straight ornate rod). */
  link(len, thick, active) {
    const W = Math.max(8, Math.round(len)), H = Math.max(6, Math.round(thick));
    return this.a.uri(`link:${active ? 1 : 0}`, W, H, (ctx, w, h) => {
      const y = h * 0.5;
      const col = active ? '#c69e4e' : '#3a3f46';
      const hi = active ? 'rgba(246,227,168,0.55)' : 'rgba(140,150,162,0.22)';
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(0, y + 1); ctx.lineTo(w, y + 1);
      ctx.lineWidth = Math.max(2, h * 0.5); ctx.strokeStyle = 'rgba(0,0,0,0.72)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.lineWidth = Math.max(1.6, h * 0.34); ctx.strokeStyle = col; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y - h * 0.14); ctx.lineTo(w, y - h * 0.14);
      ctx.lineWidth = Math.max(0.8, h * 0.10); ctx.strokeStyle = hi; ctx.stroke();
      /* three collars along the run */
      for (const t of [0.25, 0.5, 0.75]) {
        const x = w * t;
        ctx.beginPath();
        ctx.ellipse(x, y, Math.max(1.6, h * 0.16), h * 0.44, 0, 0, TAU);
        const gg = ctx.createLinearGradient(x, y - h * 0.5, x, y + h * 0.5);
        gg.addColorStop(0, active ? '#f2dda2' : '#6d757e');
        gg.addColorStop(1, active ? '#5d4415' : '#1a1e23');
        ctx.fillStyle = gg; ctx.fill();
        ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
      }
    });
  }

  /* ============================================================ buff frame */

  /** Small round buff/debuff frame with a transparent centre. */
  buffFrame(size, kind = 'buff') {
    return this.a.uri(`buff:${kind}`, size, size, (ctx, S) => {
      const c = S * 0.5, rOut = S * 0.48, rIn = S * 0.355;
      const col = kind === 'debuff' ? '#8e2a20' : kind === 'boss' ? '#c0392b' : '#b28c3c';
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rOut, 0, TAU); ctx.arc(c, c, rIn, 0, TAU, true);
      ctx.clip();
      this.a.material(ctx, 0, 0, S, S, kind === 'debuff' ? 'bronze' : 'iron', { seed: 37, scale: 0.35 });
      const g = ctx.createLinearGradient(0, 0, S * 0.3, S);
      g.addColorStop(0, 'rgba(255,246,220,0.42)');
      g.addColorStop(0.3, 'rgba(255,240,208,0.05)');
      g.addColorStop(1, 'rgba(0,0,0,0.68)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      ctx.restore();
      ctx.beginPath(); ctx.arc(c, c, rOut, 0, TAU);
      ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgba(3,4,6,0.95)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, rIn + S * 0.012, 0, TAU);
      ctx.lineWidth = Math.max(1, S * 0.022); ctx.strokeStyle = rgba(col, 0.62); ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU);
      ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(2,3,5,0.92)'; ctx.stroke();
      ctx.save();
      ctx.beginPath(); ctx.arc(c, c, rIn, 0, TAU); ctx.clip();
      const rg = ctx.createRadialGradient(c - rIn * 0.3, c - rIn * 0.35, rIn * 0.05, c, c, rIn);
      rg.addColorStop(0, 'rgba(24,27,32,0.5)');
      rg.addColorStop(1, 'rgba(0,0,0,0.9)');
      ctx.fillStyle = rg; ctx.fillRect(0, 0, S, S);
      ctx.restore();
    });
  }

  /* =============================================== nameplate / enemy bar */

  /**
   * Enemy health bar chrome for a nameplate: a thin trough with a bracketed
   * frame. Transparent interior.
   */
  plateBar(w, h, rank = 'champion') {
    return this.a.uri(`pbar:${rank}`, w, h, (ctx, W, H) => {
      const col = rank === 'boss' ? '#c0392b' : '#e0c74e';
      const p = new Path2D();
      const cham = H * 0.44;
      pathCham(p, 1, 1, W - 2, H - 2, cham);
      const band = Math.max(2.2, H * 0.24);
      const inner = new Path2D();
      pathCham(inner, band, band, W - band * 2, H - band * 2, Math.max(0.8, cham - band));
      const bp = new Path2D(); bp.addPath(p); bp.addPath(inner);
      ctx.save(); ctx.clip(bp, 'evenodd');
      this.a.material(ctx, 0, 0, W, H, 'iron', { seed: 29, scale: 0.3 });
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,246,220,0.34)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.1)');
      g.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
      ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(2,3,5,0.92)'; ctx.stroke(p);
      ctx.lineWidth = 0.9; ctx.strokeStyle = rgba(col, 0.34);
      ctx.save(); ctx.translate(0, -0.7); ctx.stroke(p); ctx.restore();
      /* end caps */
      for (const x of [0, W]) {
        ctx.save();
        ctx.translate(x, H * 0.5);
        ctx.beginPath();
        const k = H * 0.66;
        ctx.moveTo(0, -k); ctx.lineTo(k * 0.5 * (x === 0 ? 1 : -1), 0); ctx.lineTo(0, k);
        ctx.closePath();
        const gg = ctx.createLinearGradient(0, -k, 0, k);
        gg.addColorStop(0, '#c9d0d8'); gg.addColorStop(0.5, '#535b64'); gg.addColorStop(1, '#12161a');
        ctx.fillStyle = gg; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
        ctx.restore();
      }
    });
  }

  /* ================================================================ misc */

  /** Radial darkening behind a full-screen panel set. */
  screenVeil(w, h) {
    return this.a.uri('veil', Math.max(64, Math.round(w / 6)), Math.max(36, Math.round(h / 6)), (ctx, W, H) => {
      const g = ctx.createRadialGradient(W * 0.5, H * 0.46, Math.min(W, H) * 0.1, W * 0.5, H * 0.5, Math.max(W, H) * 0.78);
      g.addColorStop(0, 'rgba(3,4,6,0.30)');
      g.addColorStop(0.55, 'rgba(3,4,6,0.58)');
      g.addColorStop(1, 'rgba(0,0,0,0.86)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    });
  }

  /** Deterministic grime overlay for large panels. */
  grunge(seed = 4) { return this.a.grungeURI(256, seed); }

  /** A small chevron/arrow used for the player marker on the minimap. */
  playerArrow(size) {
    return this.a.uri('parrow', size, size, (ctx, S) => {
      const c = S * 0.5;
      ctx.save();
      ctx.translate(c, c);
      ctx.beginPath();
      ctx.moveTo(0, -S * 0.40);
      ctx.lineTo(S * 0.28, S * 0.34);
      ctx.lineTo(0, S * 0.16);
      ctx.lineTo(-S * 0.28, S * 0.34);
      ctx.closePath();
      const g = ctx.createLinearGradient(-S * 0.3, -S * 0.4, S * 0.3, S * 0.34);
      g.addColorStop(0, '#fff3d2'); g.addColorStop(0.5, '#e0b45e'); g.addColorStop(1, '#7a5620');
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = S * 0.14;
      ctx.fill();
      ctx.lineWidth = Math.max(1, S * 0.05);
      ctx.strokeStyle = 'rgba(20,14,4,0.9)'; ctx.stroke();
      ctx.restore();
    });
  }

  /** Deterministic jitter helper for panels that want authored-looking wear. */
  jit(i, j, seed = 0) { return hash2(i, j, seed); }
}

export default Ornament;
export { clamp01, lerp, rgba, lighten, darken, pathCham, pathRound };
