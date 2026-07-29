/**
 * SANCTUM — HUD combat layer
 * ---------------------------------------------------------------------------
 * Everything in the interface that is anchored to something in the world:
 *
 *   • floating damage numbers — arc-and-fade, two-tone gradient fill, dark
 *     outline, crits larger with a struck-metal flash behind them
 *   • elite / champion / boss nameplates — rank badge, epithet, level, health
 *     trough with a lagging damage ghost
 *   • the boss health bar — wide, ornate, phase-segmented, with a banner
 *
 * All of it is DOM, deliberately: it is therefore composited after the whole
 * post chain and no lens or grain pass can reach the lettering. See THE
 * COMPOSITING CONTRACT in HUD.js. `src/combat/HitFeel.js` draws the same numbers
 * as an instanced glyph batch *inside* the scene when no HUD claims the channel;
 * `HUD.drawsDamageNumbers` is what stops that.
 *
 * Pools are fixed-size and every element is written from `update()`, so the
 * cost is a handful of style writes per frame and the output is deterministic.
 */

import * as THREE from 'three';
import { dmgStyleOf, PAL, RARITY, FONT_DISPLAY } from '../UITheme.js';
import { mk, sty, txt, fmt, clamp, clamp01, approach } from './Widgets.js';
import { BOSS_GEO, BOSS_STONE_H, bossGateX } from './Ornament.js';

const _v = new THREE.Vector3();

const MAX_DMG = 30;
const MAX_PLATES = 6;
/** Rows the damage-number de-collision may spend lifting one number. */
const MAX_DMG_ROWS = 5;
/**
 * Fixed HUD regions a floating number may not print through.
 *
 * Deliberately short: only the chrome that carries TYPE and sits where numbers
 * actually fly. The boss block hangs off the top edge and the toast column sits
 * under it, and both were being crossed by numbers in the `boss` capture. The
 * bottom chrome is not listed — the hero is never low enough in frame for a
 * number to reach it, and reserving a quarter of the frame on a hunch would make
 * numbers vanish for no observed reason.
 */
const DMG_HUD_OBSTACLES = ['.bossBar', '.toasts'];

/**
 * The encounter bar's layout, in vh. One number drives it: the trough's height.
 * Its width follows from the raster's authored aspect, because the forged end
 * caps are round objects and giving the element any other ratio turns them into
 * ovals. Everything else is sized against those two so the block scales as one
 * piece at any resolution.
 */
const BOSS_BAR_VH = 3.30;
const BOSS_BAR_W_VH = BOSS_BAR_VH * BOSS_GEO.aspect;
const BOSS_CART_ASPECT = 10;
const BOSS_CART_VH = 4.40;
const BOSS_CART_W_VH = BOSS_CART_VH * BOSS_CART_ASPECT;
/** Cap height of the gilded name raster. See CombatLayer._setBossName. */
const BOSS_TITLE_VH = 2.86;
/**
 * Widest the name raster may be drawn. The cartouche's two points and the rank
 * badge in the left one are not usable width, and a long epithet that ran into
 * them would look like a layout accident rather than a name plate.
 */
const BOSS_TITLE_MAX_VH = BOSS_CART_W_VH - 11.0;

/** Champion epithets — deterministic per enemy seed, never Math.random. */
const FORE = ['Gnash', 'Vor', 'Mal', 'Khar', 'Zul', 'Bhaal', 'Ur', 'Grim', 'Sar', 'Thul', 'Vex', 'Mor'];
const AFT = ['ruk', 'gath', 'thok', 'zeth', 'mor', 'gore', 'vash', 'dun', 'rath', 'kul'];
const TITLE = ['the Rotbound', 'the Flayer', 'Bone-Eater', 'the Unclean', 'Hollowmaw', 'the Gravechild',
  'Ashenhide', 'the Wretched', 'Bloodsworn', 'the Sundered'];

/** Deterministic 0..1 from an integer. Replaces the frame-derived jitter. */
function h1(n) {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class CombatLayer {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.orn = hud.orn;
    this.visible = true;
    this._names = new Map();
    /** Monotonic spawn counter — the seed for per-number spread. */
    this._seq = 0;
    /** target -> {n, t}: how many numbers this body is already showing. */
    this._stack = new Map();
    /** '<text>@<sizeVh>' -> {w,h} in px. One forced layout per distinct string. */
    this._measure = new Map();
    /** scratch box list for the damage-number de-collision pass */
    this._dmgBoxes = [];
    /** cached rects of the fixed HUD type a number must not print through */
    this._fixed = [];
    this._fixedAt = -999;
    /**
     * Live nameplate rects in screen px, republished every frame. WorldLabels
     * treats them as obstacles so a loot cartouche never lands on an enemy's
     * name — the two systems are the only things in the frame both anchored to
     * the world and made of type.
     */
    this.plateRects = [];
  }

  /* =============================================================== build */

  build() {
    const root = this.hud.root;
    this.layer = mk('div', 'cLayer', root);

    /* ---- damage number pool ----
     *
     * TWO layers per number, and the reason is a CSS paint-order trap that cost
     * this project a 7/10 blocker. A gradient-filled numeral is done with
     * `background-clip:text` + `-webkit-text-fill-color:transparent`, i.e. the
     * fill lives in the element's BACKGROUND paint phase. `text-shadow` paints
     * *after* the background and *before* the text — so the eleven opaque outline
     * offsets that used to sit on this element covered the gradient completely and
     * every number resolved to a solid blob of `edge` colour. Captured proof:
     * shots/_debug/blk9_before_ui_only.png and blk9_before_dmg_blob_20x.png (world
     * hidden, HUD alone) — "263" is a featureless maroon smear and "10" is
     * invisible; blk9_after_ui_only.png is the same frame with the layers split.
     * The art director read that as "chromatic aberration and grain shredding
     * damage numbers"; the post chain never touched it, the paint order did.
     *
     * So the outline gets its own element UNDERNEATH:
     *   .dStroke  opaque `edge` fill + a real -webkit-text-stroke, plus the soft
     *             accent halo and drop shadow as FILTERS (filters composite behind
     *             the element's own pixels, so the dark outline stays dark)
     *   .dFill    the gradient, clipped to the glyphs, with no shadow at all
     * Identical text and metrics in both, so they register exactly.
     */
    this.dmgPool = [];
    for (let i = 0; i < MAX_DMG; i++) {
      const e = mk('div', 'dmg', this.layer);
      const flash = mk('div', 'dFlash', e);
      const num = mk('div', 'dNum', e);
      const stroke = txt('div', 'dStroke num', '', num);
      const t = txt('div', 'dFill num', '', num);
      e.style.opacity = '0';
      this.dmgPool.push({ el: e, txt: t, stroke, flash, active: false, t0: -99 });
    }
    this._dmgHead = 0;

    /* ---- nameplate pool ---- */
    const barFrame = this.orn.plateBar(360, 20, 'champion');
    const barFill = this.orn.barFill(20, '#a8261c', { tag: 'np' });
    this.plates = [];
    for (let i = 0; i < MAX_PLATES; i++) {
      const e = mk('div', 'np', this.layer);
      const top = mk('div', 'npTop', e);
      const icon = mk('div', 'npIcon', top);
      const name = txt('span', 'npName disp', '', top);
      const lvl = txt('span', 'npLvl num', '', top);
      const bar = mk('div', 'npBar', e);
      const clip = mk('div', 'npClip', bar);
      const ghost = mk('div', 'npGhost', clip);
      const fill = mk('div', 'npFill', clip);
      const frame = mk('div', 'npFrame', bar);
      frame.style.backgroundImage = `url("${barFrame}")`;
      fill.style.backgroundImage = `url("${barFill}")`;
      ghost.style.backgroundImage = `url("${this.orn.barFill(20, '#e0e0d0', { tag: 'ghost' })}")`;
      icon.style.backgroundImage = `url("${this.orn.rankIcon(72, 'champion')}")`;
      e.style.opacity = '0';
      this.plates.push({ el: e, icon, name, lvl, fill, ghost, frame, ghostV: 1, owner: null });
    }

    /* ---- boss bar ----
     *
     * Rebuilt as a physical object rather than a coloured strip. It used to be
     * `barFrame` — the same 9-px chrome the xp bar and the nameplates use — with
     * a flat fill in it and a leather ribbon above, and next to the orbs in the
     * bottom corners (glass, cast bezel, flutes, a crown) it did not read as
     * belonging to the same game. Captured proof: laneF_bar_before.png.
     *
     * The pieces, and why each one is a separate element:
     *   .bbName   cast cartouche; the name inside it is a GILDED RASTER, not
     *             CSS text, so the display line has real leaf specular
     *   .bbClip   the channel, sized from BOSS_GEO so it lands exactly in the
     *             frame's own recess
     *   .bbFill   liquid, width-animated; .bbEdge is pinned to its right edge
     *             so the hot front cannot stretch with the health fraction
     *   .bbFrame  the forged trough, painted OVER the liquid — that is what
     *             puts the channel's inner shadow and the filed notches on top
     *             of the fill instead of under it
     *   .bbStone  one per phase gate, switched off as each gate breaks
     */
    const bb = mk('div', 'bossBar hide', root);
    this.boss = { root: bb, ghostV: 1, nameKey: '', pips: [] };

    const nameWrap = mk('div', 'bbName', bb);
    nameWrap.style.backgroundImage = `url("${this.orn.bossCartouche(900, 90, { tag: 'boss' })}")`;
    this.boss.icon = mk('div', 'bbIcon', nameWrap);
    this.boss.icon.style.backgroundImage = `url("${this.orn.rankIcon(96, 'boss')}")`;
    this.boss.name = mk('div', 'bbTitle gilt', nameWrap);

    const bar = mk('div', 'bbBar', bb);
    const clip = mk('div', 'bbClip', bar);
    this.boss.ghost = mk('div', 'bbGhost', clip);
    this.boss.fill = mk('div', 'bbFill', clip);
    this.boss.ghost.style.backgroundImage = `url("${this.orn.bossFill(68, '#e8d8b0', { tag: 'bghost' })}")`;
    this.boss.fill.style.backgroundImage = `url("${this.orn.bossFill(68, '#9c1a18', { tag: 'boss' })}")`;
    this.boss.edge = mk('div', 'bbEdge', this.boss.fill);
    this.boss.edge.style.backgroundImage = `url("${this.orn.bossEdge(68, '#ff8438', { tag: 'boss' })}")`;

    const frame = mk('div', 'bbFrame', bar);
    frame.style.backgroundImage =
      `url("${this.orn.bossTrough(BOSS_GEO.rasterW, BOSS_GEO.rasterH, { tag: 'boss' })}")`;

    const stone = this.orn.phaseStone(56, '#e0502c');
    for (const g of BOSS_GEO.gates) {
      const s = mk('div', 'bbStone', bar);
      s.style.backgroundImage = `url("${stone}")`;
      s.style.left = `${(bossGateX(g) * 100).toFixed(3)}%`;
      this.boss.pips.push({ el: s, gate: g });
    }

    this.boss.hpTxt = txt('div', 'bbHp num', '', bar);
    this.boss.sub = txt('div', 'bbSub eng', 'PHASE II · LEVEL 20', bb);
    this._setBossName('SANCTUM WARDEN');

    this._injectCSS();
  }

  /**
   * Set the encounter name as struck gold leaf rather than as CSS text.
   *
   * The same decision the panel titles took, and for the same reason: the
   * project forbids external font files, so there is no display woff2 to reach
   * for. `UIAtlas.titleURI` composes the line out of the OS inscriptional-serif
   * stack with the tracking, weight and initial-scale step set explicitly, then
   * gilds it as metal — a dark cut sunk under every stroke, worn leaf, tarnish
   * and planishing through it, a raking crest and a star glint on the versal.
   * A coloured `text-shadow` cannot produce specular, and specular is the whole
   * difference between a boss name and a caption.
   *
   * Height is the only layout input; the width follows the raster's own aspect
   * so the letterforms are never stretched, and if a long epithet would overrun
   * the plate the WHOLE thing is scaled down rather than condensed.
   */
  _setBossName(text) {
    const t = this.atlas.titleURI(text, {
      font: FONT_DISPLAY, em: 34, step: 1.46, ls: 0.26, weight: 600, seed: 37,
    });
    let h = BOSS_TITLE_VH;
    let w = h * (t.w / t.h);
    if (w > BOSS_TITLE_MAX_VH) { h *= BOSS_TITLE_MAX_VH / w; w = BOSS_TITLE_MAX_VH; }
    const el = this.boss.name;
    el.style.backgroundImage = `url("${t.uri}")`;
    el.style.height = `${h.toFixed(3)}vh`;
    el.style.width = `${w.toFixed(3)}vh`;
  }

  setVisible(on) {
    this.visible = !!on;
    if (this.layer) this.layer.classList.toggle('hide', !on);
    if (!on && this.boss) this.boss.root.classList.add('hide');
    if (!on) this.plateRects.length = 0;
    if (!on) this.hud.root?.classList.remove('hasBoss');
    this._fixedAt = -999;
  }

  resize(w, h) { this.vw = w; this.vh = h; this._fixedAt = -999; this._measure.clear(); }

  /* ============================================================== events */

  onDamage(p) {
    if (!p || !this.visible) return;
    const amount = Math.max(0, Math.round(p.amount ?? 0));
    if (amount <= 0) return;
    this._lastReal = this.engine.clock.elapsed;
    const toHero = !!p.__fromHero || p.target?.isHero;
    const pt = p.hitPoint;
    let x = 0, y = 1.2, z = 0;
    if (pt && typeof pt.x === 'number') { x = pt.x; y = pt.y; z = pt.z; }
    else if (p.target?.position) {
      x = p.target.position.x; z = p.target.position.z;
      y = (p.target.position.y ?? 0) + (p.target.height ?? 1.8) * 0.72;
    }
    const rec = this.dmgPool[this._dmgHead];
    this._dmgHead = (this._dmgHead + 1) % MAX_DMG;
    const now = this.engine.clock.elapsed;
    /*
     * SPREAD. This used to seed the jitter from `clock.frame` alone, so every
     * hit landing on the SAME FRAME — which is every cleave, every whirlwind
     * tick, every multi-target ability — got an identical horizontal velocity
     * and the numbers launched from the same point along the same path. The
     * capture proved it: four numbers (23 / 10 / 263 / 22) inside a 34 px box,
     * reading as one unresolvable smear rather than four hits.
     *
     * Two independent fixes, because either alone leaves a case broken:
     *   1. a monotonic spawn counter drives the jitter, so simultaneous hits
     *      diverge even when they share a frame AND a target;
     *   2. a per-target stack counter lifts each successive number on one body
     *      by a fixed step and alternates the fan direction, so a sustained
     *      channel on one enemy reads as a rising column (this is what D4 does).
     */
    const seq = ++this._seq;
    const jitter = h1(seq * 2654435761) - 0.5;
    const tgt = p.target ?? null;
    let st = tgt ? this._stack.get(tgt) : null;
    if (!st || now - st.t > 0.85) st = { n: 0, t: now };
    st.n = (st.n + 1) % 5;
    st.t = now;
    if (tgt) {
      this._stack.set(tgt, st);
      if (this._stack.size > 48) this._pruneStacks(now);
    }
    const fan = st.n % 2 === 0 ? 1 : -1;

    rec.active = true;
    rec.t0 = now;
    rec.x = x; rec.y = y + 0.25; rec.z = z;
    rec.crit = !!p.crit;
    rec.life = rec.crit ? 1.55 : 1.18;
    rec.vx = (jitter * 3.0 + fan * (1.9 + st.n * 0.62)) * (toHero ? 0.5 : 1);
    rec.fan = fan;
    /** Screen rows this number starts above the hit point. */
    rec.stack = st.n;
    rec.rise = (rec.crit ? 7.4 : 6.0) + st.n * 0.34;
    const kind = toHero ? 'player' : (p.crit ? 'crit' : (p.type ?? 'physical'));
    const sc = dmgStyleOf(kind);
    const label = (toHero ? '-' : '') + fmt(amount);

    /* Size in vh, then in px so the outline weight can be a real stroke width
       rather than a guess. A didone numeral at 20 px has ~1 px hairlines, so the
       stroke has to stay under ~2 px or the counters close up; it lives only on
       the dark under-layer, which means the bright fill on top is never eroded. */
    const vhPx = Math.max(4, (this.vh || this.engine.height || 900) / 100);
    const sizeVh = rec.crit ? 3.6 : (amount > 400 ? 2.70 : 2.35);
    const px = sizeVh * vhPx;
    const strokeW = clamp(px * (rec.crit ? 0.070 : 0.082), 1.05, 3.0);
    const halo = px * (rec.crit ? 0.30 : 0.18);

    rec.seq = seq;
    rec.amount = amount;
    rec.txt.textContent = label;
    rec.stroke.textContent = label;
    for (const el of [rec.txt, rec.stroke]) {
      el.style.fontSize = `${sizeVh.toFixed(3)}vh`;
      /* A ~1 px outward stroke on each side of two adjacent didone digits closes
         the gap between them and "263" welds into one shape. Buy the gap back. */
      el.style.letterSpacing = rec.crit ? '.035em' : '.05em';
    }
    /* the readable part: cream core falling to the element's accent at the baseline */
    rec.txt.style.backgroundImage =
      `linear-gradient(180deg,${sc.a} 0%,${sc.a} 34%,${sc.b} 88%,${sc.b} 100%)`;
    /* the outline: one honest stroke, not eleven stacked shadows */
    rec.stroke.style.color = sc.edge;
    rec.stroke.style.setProperty('-webkit-text-stroke', `${strokeW.toFixed(2)}px ${sc.edge}`);
    rec.stroke.style.setProperty('text-stroke', `${strokeW.toFixed(2)}px ${sc.edge}`);
    /* Halo + cast shadow as FILTERS. A filter drop-shadow composites behind the
       element's own coverage, so neither of these can climb over the outline the
       way a text-shadow does — which is the whole point of splitting the layers. */
    rec.stroke.style.filter =
      `drop-shadow(0 0 ${halo.toFixed(2)}px ${sc.b})` +
      ` drop-shadow(0 ${(px * 0.075).toFixed(2)}px ${(px * 0.11).toFixed(2)}px rgba(0,0,0,.92))`;
    rec.el.classList.toggle('crit', rec.crit);
    rec.flash.style.background = rec.crit
      ? `radial-gradient(circle at 50% 50%, ${sc.a} 0%, ${sc.b}00 62%)`
      : 'none';
    rec.el.style.opacity = '1';

    /* Box size, for the screen-space de-collision in update(). Memoised per
       (string, size) because reading it is a forced layout flush. */
    const mk_ = `${label}@${sizeVh}`;
    let m = this._measure.get(mk_);
    if (!m) {
      const b = rec.txt.getBoundingClientRect();
      m = { w: Math.max(6, b.width) + strokeW * 2, h: Math.max(6, b.height) };
      if (this._measure.size > 128) this._measure.clear();
      this._measure.set(mk_, m);
    }
    rec.w = m.w;
    rec.h = m.h;
    rec.push = null;                 // resolved on the first update() after spawn
  }

  /**
   * Rects of the fixed HUD type, centre-based, refreshed every 45 frames.
   * A `getBoundingClientRect` per number per frame would force a layout flush
   * thirty times a frame; this chrome moves only on a scenario change or resize.
   */
  _refreshFixed() {
    this._fixedAt = this.engine.clock.frame;
    const out = this._fixed;
    out.length = 0;
    const root = this.hud.root;
    if (!root) return;
    for (const sel of DMG_HUD_OBSTACLES) {
      let el = null;
      try { el = root.querySelector(sel); } catch { el = null; }
      if (!el) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      if (parseFloat(st.opacity || '1') < 0.04) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 3 || b.height < 3) continue;
      out.push({ x: b.left + b.width * 0.5, y: b.top + b.height * 0.5, w: b.width, h: b.height });
    }
  }

  /**
   * Highest already-placed damage-number box that a box at (cx,cy,w,h) would
   * overlap, or null when the spot is clear.
   *
   * The 0.05 slack is load-bearing: the caller's escape jump lands a box EXACTLY
   * on the separation threshold, and without a tolerance one float ulp re-reports
   * the same blocker forever — the search then burns its whole row budget and a
   * whole burst of numbers ends up piled at one height.
   */
  _dmgBlocker(cx, cy, w, h, gap) {
    const boxes = this._dmgBoxes;
    let top = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (Math.abs(b.x - cx) >= (b.w + w) * 0.46) continue;
      if (Math.abs(b.y - cy) >= (b.h + h) * 0.5 + gap - 0.05) continue;
      if (!top || b.y < top.y) top = b;
    }
    return top;
  }

  /** Drop stack entries for bodies nothing has hit recently. */
  _pruneStacks(now) {
    for (const [k, v] of this._stack) if (now - v.t > 1.2) this._stack.delete(k);
  }

  onDeath(p) {
    const en = p?.entity;
    if (!en || !this.visible) return;
    if (en.rank === 'boss') {
      this.hud.toast(`${(en.name ?? 'Boss').toUpperCase()} FALLS`, 'boss');
      this.hud.lootLine('Sigil of the Unmade', 'mythic');
    } else if (en.rank === 'champion') {
      this.hud.toast(`${this._nameOf(en)} slain`, 'good');
      this.hud.lootLine(pickLoot(en, this.engine), 'rare');
    }
  }

  /* ============================================================== update */

  update(dt, elapsed) {
    if (!this.visible || !this.layer) return;
    const cam = this.engine.camera;
    const vw = this.vw || this.engine.width || innerWidth;
    const vh = this.vh || this.engine.height || innerHeight;
    const unit = vh / 100;                                   // 1vh in px

    /* ---------------------------------------------------------- nameplates
     * Deliberately FIRST, so this frame's plate rects are already available when
     * the damage numbers solve. A nameplate is persistent identification and a
     * damage number is a 1.2 s event, so the number is the thing that gives way.
     * Measured before the reorder: `overworld` printed "54" straight across
     * "Malrath, Hollowmaw", and `night` did the same with "110".
     */
    const bes = this.engine.get('bestiary');
    const list = [];
    let bossEn = null;
    if (bes?.entities) {
      for (const en of bes.entities) {
        if (!en || en.dead) continue;
        if (en.rank === 'boss') { bossEn = en; continue; }
        if (en.rank !== 'champion') continue;
        list.push(en);
      }
    }
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    /* Republished for WorldLabels; also used to de-collide the plates with each
       other, since two champions standing together used to print one name over
       the other. The box is the CSS box: 22vh wide, anchored bottom-centre. */
    const rects = this.plateRects;
    rects.length = 0;
    const PW = 22 * unit, PH = 4.4 * unit, PGAP = 0.4 * unit;
    for (let i = 0; i < this.plates.length; i++) {
      const pl = this.plates[i];
      const en = list[i];
      if (!en) { pl.el.style.opacity = '0'; pl.owner = null; continue; }
      if (pl.owner !== en) {
        pl.owner = en;
        pl.name.textContent = this._nameOf(en);
        pl.lvl.textContent = String(en.level ?? 1);
        pl.ghostV = 1;
      }
      _v.set(en.position.x, (en.position.y ?? 0) + (en.height ?? 2) * 1.08 + 0.35, en.position.z).project(cam);
      if (_v.z > 1) { pl.el.style.opacity = '0'; continue; }
      const sx = (_v.x * 0.5 + 0.5) * vw;
      let sy = (-_v.y * 0.5 + 0.5) * vh;
      /* lift over any plate already placed on this screen row */
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (const q of rects) {
          if (Math.abs(q.x + q.w * 0.5 - sx) < PW * 0.55 && Math.abs(q.y + PH - sy) < PH) {
            sy -= PH + PGAP; moved = true;
          }
        }
        if (!moved) break;
      }
      const f = clamp01((en.hp ?? 1) / Math.max(1, en.maxHp ?? 1));
      pl.ghostV = f < pl.ghostV ? approach(pl.ghostV, f, 2.2, dt) : f;
      pl.fill.style.width = `${(f * 100).toFixed(2)}%`;
      pl.ghost.style.width = `${(pl.ghostV * 100).toFixed(2)}%`;
      pl.el.style.transform = `translate(-50%,-100%) translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
      pl.el.style.opacity = '1';
      rects.push({ x: sx - PW * 0.5, y: sy - PH, w: PW, h: PH });
    }

    /* ---------------------------------------------------------- boss bar */
    const bb = this.boss;
    /*
     * The boss block is 8 vh of ornate chrome hanging off the top edge, and the
     * toast column's authored home is 7.4 vh — so in `boss` the encounter banner
     * printed straight through the phase line and the hp readout. Captured proof:
     * shots/_debug/blk9_before_bossbar_toast.png. Publishing the state as a class
     * on the HUD root lets the stylesheet move the column, which keeps the layout
     * decision in CSS next to the two rules it reconciles.
     */
    this.hud.root?.classList.toggle('hasBoss', !!bossEn);
    if (bossEn) {
      bb.root.classList.remove('hide');
      const f = clamp01((bossEn.hp ?? 1) / Math.max(1, bossEn.maxHp ?? 1));
      bb.ghostV = f < bb.ghostV ? approach(bb.ghostV, f, 1.6, dt) : f;
      bb.fill.style.width = `${(f * 100).toFixed(2)}%`;
      bb.ghost.style.width = `${(bb.ghostV * 100).toFixed(2)}%`;
      /* the name is a rasterised gold-leaf line, so it is only re-struck when
         the encounter actually changes — not every frame */
      const nm = String(bossEn.name ?? 'Warden').toUpperCase();
      if (nm !== bb.nameKey) { bb.nameKey = nm; this._setBossName(nm); }
      const phase = f > 0.75 ? 'I' : f > 0.5 ? 'II' : f > 0.25 ? 'III' : 'IV';
      bb.sub.textContent = `PHASE ${phase}  ·  LEVEL ${bossEn.level ?? 20}`;
      bb.hpTxt.textContent = `${fmt(bossEn.hp)} / ${fmt(bossEn.maxHp)}`;
      /* A gate's stone is struck out the moment health falls past it, leaving
         the empty socket that is already cut into the frame. That states how
         much of the fight is left without needing a legend, and it is the only
         part of this block that is state rather than chrome. */
      for (const p of bb.pips) p.el.style.opacity = f > p.gate ? '1' : '0';
      /* the bar breathes very slightly with the fight */
      const k = 0.90 + 0.10 * Math.abs(Math.sin(elapsed * 0.9));
      bb.fill.style.filter = `brightness(${k.toFixed(3)})`;
      /* The leading edge flares while the damage ghost is still catching up —
         i.e. for the moment after a hit lands — and idles at a low value the
         rest of the time. A permanently hot front would be a light source in a
         frame whose whole point is that it is dark. */
      const heat = clamp01((bb.ghostV - f) * 6);
      bb.edge.style.opacity =
        clamp01(0.68 + 0.14 * Math.abs(Math.sin(elapsed * 1.7)) + 0.26 * heat).toFixed(3);
    } else {
      bb.root.classList.add('hide');
    }

    /* ---------------------------------------------------- damage numbers
     * Two passes. The first integrates each number's arc into a screen point;
     * the second separates the ones that would print on top of each other.
     *
     * The per-target stack + fan already spreads hits on ONE body, but two
     * bodies can project to the same screen point, and then two full-opacity
     * numbers superimpose into one unreadable mass. Captured proof:
     * shots/_debug/blk9_before_labels_over_numbers_5x.png — a burst of nine hits
     * inside one 0.6 m box printed as a single unreadable mass;
     * blk9_after_burst_5x.png is the same burst solved.
     *
     * The de-collision is a stable rect solver. Numbers are visited by IMPORTANCE
     * (crit, then magnitude, then spawn order) and each one lifts clear of the
     * boxes already placed, so what gives way under pressure is always the small
     * change and never the big hit. The ranking keys are immutable per record, so
     * the order is identical every frame and nothing shuffles. A number that
     * cannot clear the row budget is not drawn at all — the same "collapse rather
     * than overlap" policy the ground labels use, because five faded numbers piled
     * at one height is the exact unreadable mass this is meant to prevent.
     */
    const live = [];
    for (const r of this.dmgPool) {
      if (!r.active) continue;
      const t = elapsed - r.t0;
      if (t > r.life) { r.active = false; r.el.style.opacity = '0'; continue; }
      _v.set(r.x, r.y, r.z).project(cam);
      if (_v.z > 1) { r.el.style.opacity = '0'; continue; }
      const sx = (_v.x * 0.5 + 0.5) * vw;
      const sy = (-_v.y * 0.5 + 0.5) * vh;
      /*
       * Arc: rise fast, then fall under gravity, launched from the stack row
       * this number owns. The row step must exceed the tallest line box or
       * consecutive rows overlap — measured in `boss`, where five simultaneous
       * hits on the warden printed a column of half-covered digits.
       */
      const st = r.stack ?? 0;
      const dy = (-r.rise * t + 5.6 * t * t - st * 2.85) * unit;
      const dx = (r.vx * t + (r.fan ?? 1) * (1.2 + st * 0.45)) * unit;
      r._t = t;
      r._cx = sx + dx;
      r._cy = sy + dy;
      live.push(r);
    }
    live.sort((a, b) =>
      (b.crit ? 1 : 0) - (a.crit ? 1 : 0) ||
      (b.amount ?? 0) - (a.amount ?? 0) ||
      (a.seq ?? 0) - (b.seq ?? 0));

    const boxes = this._dmgBoxes;
    boxes.length = 0;
    const gap = unit * 0.26;
    const topLimit = unit * 3.0;
    /*
     * Seed the solver with the other world-anchored type in the frame, so a
     * number dodges it exactly the way it dodges another number.
     *  • nameplates — this frame's, computed above.
     *  • ground loot plates — LAST frame's, because WorldLabels solves after this
     *    layer (it needs the plate rects). One frame of staleness is invisible:
     *    a cartouche is pinned to a drop on the floor and moves only as fast as
     *    the camera. Boxes here are centre-based; both sources are top-left.
     *  • the fixed HUD type listed in DMG_HUD_OBSTACLES, cached.
     * The nameplate box is narrowed to 0.72 of its 22vh CSS width because the
     * element is much wider than the name and bar actually drawn inside it, and
     * reserving the full box would lift numbers that were never touching it.
     */
    for (const q of this.plateRects) {
      boxes.push({ x: q.x + q.w * 0.5, y: q.y + q.h * 0.5, w: q.w * 0.72, h: q.h });
    }
    const labelRects = this.hud.wlabels?.labelRects;
    if (labelRects) {
      for (const q of labelRects) {
        boxes.push({ x: q.x + q.w * 0.5, y: q.y + q.h * 0.5, w: q.w, h: q.h });
      }
    }
    if (this.engine.clock.frame - this._fixedAt > 45) this._refreshFixed();
    for (const q of this._fixed) boxes.push(q);
    for (const r of live) {
      const rw = r.w || unit * 3, rh = r.h || unit * 2.4;
      /*
       * Jump straight above the HIGHEST box this one collides with, then re-test.
       * That converges in two or three steps where a fixed-step search needs a
       * dozen and gives up half way, leaving a pile at one height.
       *
       * Five rows is the whole budget, on purpose: lifted further than that a
       * number is 150 px from the body it belongs to and the association is lost.
       */
      let cy = r._cy;
      let rows = 0;
      for (; rows < MAX_DMG_ROWS; rows++) {
        const top = this._dmgBlocker(r._cx, cy, rw, rh, gap);
        if (!top) break;
        cy = top.y - (top.h + rh) * 0.5 - gap;
      }
      if (rows >= MAX_DMG_ROWS || (rows > 0 && cy < topLimit)) {
        /* No clear row inside the budget — or clearing one would have pushed the
           number off the top of the frame. Say nothing rather than say it on top
           of something else; the hit still registered in hit-stop and VFX.
           `rows > 0` matters: a number whose own anchor is high in frame is drawn
           where it belongs, it is only the DODGE that may not leave the frame. */
        r.el.style.opacity = '0';
        r.flash.style.opacity = '0';
        continue;
      }
      /*
       * `cy` is now guaranteed clear. Easing toward it is a nicety, so it is
       * conditional: take the eased position only when the eased position is
       * ALSO clear, otherwise snap to the resolved one. Without that test the
       * relaxation is what re-introduces the overlap — measured in `boss` with
       * 30 numbers in flight, 8 overlapping pairs, every one of them a number
       * that had been resolved clear and then eased back down into a lower-ranked
       * neighbour placed after it. With the test, "no two numbers overlap" is a
       * property of the loop rather than something the tuning has to earn.
       */
      let drawY = cy;
      if (r.push != null) {
        const eased = r._cy + approach(r.push, cy - r._cy, 11, dt);
        if (!this._dmgBlocker(r._cx, eased, rw, rh, gap)) drawY = eased;
      }
      r.push = drawY - r._cy;
      boxes.push({ x: r._cx, y: drawY, w: rw, h: rh });

      const t = r._t;
      const pop = r.crit
        ? (t < 0.10 ? 0.6 + 4.6 * t : 1.06 - 0.06 * Math.min(1, (t - 0.10) / 0.22))
        : (t < 0.08 ? 0.72 + 3.4 * t : 1.0);
      const a = t > r.life * 0.55 ? clamp01((r.life - t) / (r.life * 0.45)) : 1;
      r.el.style.transform =
        `translate(-50%,-50%) translate(${r._cx.toFixed(1)}px,${drawY.toFixed(1)}px) scale(${pop.toFixed(3)})`;
      r.el.style.opacity = a.toFixed(3);
      if (r.crit) {
        const fk = clamp01(1 - t / 0.34);
        r.flash.style.opacity = (fk * 0.7).toFixed(3);
        r.flash.style.transform = `translate(-50%,-50%) scale(${(0.5 + (1 - fk) * 2.4).toFixed(3)})`;
      } else r.flash.style.opacity = '0';
    }
  }

  /* ================================================================ util */

  _nameOf(en) {
    let n = this._names.get(en.id);
    if (n) return n;
    const r = this.engine.freshRand(en.seed ?? 1);
    const a = FORE[Math.floor(r() * FORE.length) % FORE.length];
    const b = AFT[Math.floor(r() * AFT.length) % AFT.length];
    const t = TITLE[Math.floor(r() * TITLE.length) % TITLE.length];
    n = `${a}${b}, ${t}`;
    this._names.set(en.id, n);
    return n;
  }

  dispose() {
    this._names.clear();
    this._stack.clear();
    this._measure.clear();
    this._dmgBoxes.length = 0;
    this._fixed.length = 0;
    this.plateRects.length = 0;
  }

  /* ================================================================= CSS */

  _injectCSS() {
    if (document.getElementById('sanctum-hud-combat')) return;
    const s = document.createElement('style');
    s.id = 'sanctum-hud-combat';
    s.textContent = `
#sanctum-hud .cLayer{ position:absolute; inset:0; }

/* ---- damage numbers ----
   .dNum is the inline-block that gives the pair a shared box; .dStroke is taken
   out of flow directly on top of it so both layers share one text origin. */
#sanctum-hud .dmg{ position:absolute; left:0; top:0; will-change:transform,opacity; }
#sanctum-hud .dNum{ position:relative; display:inline-block; white-space:nowrap; }
#sanctum-hud .dNum>div{
  white-space:nowrap; font-variant-numeric:lining-nums tabular-nums;
  font-weight:600; line-height:1.06;
}
#sanctum-hud .dStroke{ position:absolute; left:0; top:0; }
#sanctum-hud .dFill{ position:relative; }
/* The gradient fill is the enhancement, not the baseline: if an engine cannot
   clip a background to text, the numerals stay a solid colour and stay legible. */
#sanctum-hud .dFill{ color:#fff0d0; }
@supports (-webkit-background-clip:text) or (background-clip:text){
  #sanctum-hud .dFill{
    -webkit-background-clip:text; background-clip:text;
    -webkit-text-fill-color:transparent;
  }
}
#sanctum-hud .dmg.crit .dNum>div{ font-weight:700; }
#sanctum-hud .dFlash{
  position:absolute; left:50%; top:50%; width:9vh; height:9vh; border-radius:50%;
  opacity:0; pointer-events:none; mix-blend-mode:screen;
}

/* ---- nameplates ---- */
#sanctum-hud .np{ position:absolute; left:0; top:0; width:22vh; margin-left:-11vh;
  display:flex; flex-direction:column; align-items:center; gap:.24vh; }
#sanctum-hud .npTop{ display:flex; align-items:center; gap:.46vh; }
#sanctum-hud .npIcon{ width:1.9vh; height:1.9vh; background-size:100% 100%;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.9)); flex:0 0 auto; }
#sanctum-hud .npName{ font-size:1.20vh; letter-spacing:.11em; color:#f0dc9a;
  text-shadow:0 -1px 0 #000,0 1px 0 rgba(0,0,0,.9),0 0 1vh rgba(0,0,0,.95); white-space:nowrap; }
#sanctum-hud .npLvl{ font-size:1.06vh; color:#b9ab86; opacity:.85;
  text-shadow:0 1px 0 #000; }
#sanctum-hud .npLvl:before{ content:'lv '; font-size:.78em; opacity:.7; letter-spacing:.1em; }
#sanctum-hud .npBar{ position:relative; width:13.5vh; height:.86vh; }
#sanctum-hud .npClip{ position:absolute; left:.22vh; right:.22vh; top:.20vh; bottom:.20vh;
  overflow:hidden; }
#sanctum-hud .npFill,#sanctum-hud .npGhost{ position:absolute; left:0; top:0; bottom:0;
  background-size:100% 100%; }
#sanctum-hud .npGhost{ opacity:.34; }
#sanctum-hud .npFrame{ position:absolute; inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.85)); }

/* ---- boss bar ----
   Every box here is derived from BOSS_BAR_VH and BOSS_GEO rather than typed in,
   because the channel insets have to line up with the recess painted into the
   frame raster. Hand-kept copies of those four numbers drift the first time
   either side is tuned, and a fill sitting proud of its own channel is the most
   obvious way to make a bar look unfinished. */
#sanctum-hud .bossBar{ position:absolute; left:50%; top:2.4vh; transform:translateX(-50%);
  width:${BOSS_BAR_W_VH.toFixed(3)}vh; display:flex; flex-direction:column; align-items:center; }
#sanctum-hud .bbName{ position:relative; z-index:2;
  width:${BOSS_CART_W_VH.toFixed(3)}vh; height:${BOSS_CART_VH.toFixed(3)}vh;
  background-size:100% 100%;
  display:flex; align-items:center; justify-content:center;
  filter:drop-shadow(0 .5vh 1.2vh rgba(0,0,0,.86)); }
/* the gilded name raster — sized by JS from its own aspect, see _setBossName */
#sanctum-hud .bbTitle{ filter:drop-shadow(0 .12vh .3vh rgba(0,0,0,.9)); }
#sanctum-hud .bbIcon{ position:absolute; left:2.0vh; top:50%; transform:translateY(-50%);
  width:2.5vh; height:2.5vh; background-size:100% 100%;
  filter:drop-shadow(0 .2vh .5vh rgba(0,0,0,.92)); }
/* The cartouche seats ON the beam's top edge, so the two read as one assembly
   rather than as a caption floating above a bar — but only just. At a deeper
   overlap the plate covered the upper halves of all three phase bosses (they
   are all inside its span horizontally) and each of them read as a map pin. */
#sanctum-hud .bbBar{ position:relative;
  width:${BOSS_BAR_W_VH.toFixed(3)}vh; height:${BOSS_BAR_VH.toFixed(3)}vh; margin-top:-.52vh; }
#sanctum-hud .bbClip{ position:absolute; overflow:hidden;
  left:${(BOSS_GEO.clipX * 100).toFixed(3)}%; right:${(BOSS_GEO.clipX * 100).toFixed(3)}%;
  top:${(BOSS_GEO.clipY * 100).toFixed(3)}%; bottom:${(BOSS_GEO.clipY * 100).toFixed(3)}%; }
#sanctum-hud .bbFill,#sanctum-hud .bbGhost{ position:absolute; left:0; top:0; bottom:0;
  background-size:100% 100%; }
#sanctum-hud .bbGhost{ opacity:.34; }
#sanctum-hud .bbEdge{ position:absolute; right:0; top:0; bottom:0; width:1.30vh;
  background-size:100% 100%; }
#sanctum-hud .bbFrame{ position:absolute; inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .45vh 1.1vh rgba(0,0,0,.82)); }
#sanctum-hud .bbStone{ position:absolute; top:50%; transform:translate(-50%,-50%);
  width:${(BOSS_STONE_H * BOSS_BAR_VH).toFixed(3)}vh;
  height:${(BOSS_STONE_H * BOSS_BAR_VH).toFixed(3)}vh; background-size:100% 100%; }
/* the readout lives IN the channel, in the last segment — the one stretch of
   trough no phase boss crosses — so the number a player checks mid-fight is on
   the object it describes instead of orbiting it */
#sanctum-hud .bbHp{ position:absolute; left:0; top:0; bottom:0;
  right:${(BOSS_GEO.clipX * 100 + 2.3).toFixed(3)}%;
  display:flex; align-items:center; justify-content:flex-end;
  font-size:1.14vh; letter-spacing:.09em; color:#f4e6c4;
  text-shadow:0 -1px 0 rgba(0,0,0,.96),0 1px 2px rgba(0,0,0,.96),0 0 .8vh rgba(0,0,0,.94); }
#sanctum-hud .bbSub{ margin-top:.58vh; font-size:.94vh; letter-spacing:.34em; color:#a89272;
  text-shadow:0 1px 0 #000,0 0 .8vh rgba(0,0,0,.9); }
`;
    document.head.appendChild(s);
  }
}

const LOOT_TABLE = ['Gravewrought Pauldrons', 'Ghoulbone Charm', 'Cryptwarden Greaves', 'Ashen Signet',
  'Coilbone Girdle', 'Rotcaller\'s Grimoire', 'Sepulchre Mantle'];

function pickLoot(en, engine) {
  const r = engine.freshRand((en.seed ?? 1) ^ 0x9e37);
  return LOOT_TABLE[Math.floor(r() * LOOT_TABLE.length) % LOOT_TABLE.length];
}

export default CombatLayer;
