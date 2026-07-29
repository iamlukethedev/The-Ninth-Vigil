/**
 * SANCTUM — world-anchored ground labels
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (round-1 blocker #9, and KNOWN_ISSUES #1).
 *
 * Ground loot labels used to be `THREE.Sprite`s living in the 3D scene, which
 * means they were composited BEFORE the post chain: bloom, DOF, film grain and
 * chromatic aberration all ran over the lettering. Text that is filtered by a
 * lens model is text you cannot read.
 *
 * Captured proof that the channel is now clean: shots/_debug/blk9_after_world_no_ui.png
 * is a full `combat` frame with the DOM HUD hidden, and it contains NO type at
 * all — no plates, no numbers, no nameplates. Every glyph in the shipped frame is
 * composited by the browser after the canvas resolves.
 *
 * So the labels moved OUT of the scene and into this layer. The HUD is a DOM
 * overlay, i.e. it is composited by the browser after the WebGL canvas has been
 * fully resolved — structurally downstream of every post pass, and therefore
 * immune to all of them by construction. There is nothing to disable and no
 * ordering to get wrong.
 *
 * What this layer also fixes
 * --------------------------
 *  • COLLISION. Round 1: "the tooltip stacks TWO tooltips — 'WINTER HOWL' over
 *    'RELIQUARY LOCKET' over 'LEGENDARY RELIQUARY LOCKET'". Those were two
 *    label plates overlapping, one of which was itself printing a redundant
 *    rarity+type sub-line. Here a rect solver places every plate against the
 *    ones already placed, against the hero, against live nameplates, and
 *    against every occupied HUD region (quest log, minimap, action bar, orbs,
 *    XP bar, buffs, boss bar, toasts, loot feed, item tooltip). A plate that
 *    cannot find clear space is not drawn. Two labels can never overlap, and a
 *    label can never overlap a tooltip.
 *  • SIZE. The sprite plates measured 126x39 px on a 1600x900 frame — three
 *    lines of type, the third one ("LEGENDARY WAR MACE") illegible and redundant
 *    with the first. Diablo 4's ground labels are ~14-16 px tall and ~90-130 px
 *    wide at that output size. Measured here: 110x18 px for a one-line plate and
 *    135x29 for a wrapped legendary, at 1.10vh caps. The redundant rarity line is
 *    gone — rarity is the pip, the lettering colour and the hairline, which is
 *    how D4 does it.
 *  • COUNT + FADE. Nearest 3 only, inside 8 m, faded over the last metre and
 *    tapered by rank order. Hold Alt to sweep the room: 26 m, up to 8 plates,
 *    no fade.
 *
 * Determinism: positions come from projecting drop positions with the live
 * camera, opacity ramps come from `engine.clock.elapsed`, plate art comes from
 * UIAtlas (hash-seeded). No Math.random, no wall clock, no CSS animation.
 */

import * as THREE from 'three';
import { rarityOf, RARITY_ORDER, FONT_DISPLAY } from '../UITheme.js';
import { mk, txt, clamp, clamp01 } from './Widgets.js';

/* ------------------------------------------------------------------ tuning */

/** DOM plates allocated. Only MAX_NEAR are shown unless Alt is held. */
const POOL = 8;
/** Plates visible at once with no modifier. D4 shows two or three. */
const MAX_NEAR = 3;
/** Metres. Outside this a drop has no label at all. */
const RANGE = 8.0;
/** Metres, Alt held — "show me everything on the floor". */
const ALT_RANGE = 26.0;
/**
 * Fraction of RANGE at which the distance fade starts.
 *
 * Measured at 0.62 the fade band was 5.0–8.0 m, i.e. most of the visible range,
 * and the `dungeon` capture showed a legendary plate at roughly 15 % opacity —
 * a label that faint reads as a rendering fault, not as a distance cue. The band
 * belongs in the last metre: present, or gone.
 */
const FADE_IN = 0.86;
/** Seconds — a fresh drop's label ramps in rather than popping. */
const BORN_RAMP = 0.24;
/**
 * Stacking steps the solver may try before giving up on a plate.
 *
 * Deliberately short. A plate lifted six rows is 200 px from the thing it names
 * and the association is gone — at that point the honest answer is to show
 * nothing and let the drop's rarity beam carry it, which is also what the brief
 * asks for ("fade/collapse when they would collide").
 */
const TRIES = 4;
/**
 * Rows the solver may spend on dodging a SOFT obstacle. One. Stepping three
 * rows to miss an enemy's head puts the plate 100 px from its item, which is a
 * worse read than clipping a shoulder — measured: the two-line legendary plate
 * in `combat` was landing at y=283 for an item at y=380.
 */
const SOFT_TRIES = 2;
/** Vertical gap between stacked plates, vh. */
const GAP_VH = 0.42;
/** Plate bottom clearance above the drop's anchor point, vh. */
const LIFT_VH = 0.30;
/**
 * Wrap to two lines at this rarity rank or above (common 0 … mythic 4).
 * Rare and better carry the generated "<adjective> <base> of the <suffix>"
 * names, which do not fit on one 17vh line and read badly truncated; common and
 * magic names are short ("EMBER GLASS ×2", "184 GOLD") and stay on one line.
 */
const WRAP_RANK = 2;
/** Characters before a wrappable name is allowed to wrap. */
const WRAP_AT = 18;
/** Enemy heads reserved so a cartouche never lands on a face. */
const MAX_HEADS = 10;
/** Metres from the hero — beyond this an enemy cannot collide with a label. */
const HEAD_RANGE = 14.0;

const HUD_OBSTACLES = [
  '.quest', '.mmap', '.bar', '.xpWrap', '.buffs', '.orb.hp', '.orb.rs',
  '.bossBar', '.toasts', '.lootLog', '.ttip', '.charPnl', '.invPnl', '.treePnl',
];

const rankOf = (r) => {
  const i = RARITY_ORDER.indexOf(r);
  return i < 0 ? 0 : i;
};
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
/** Do two rects overlap, with a 1 px tolerance so touching is allowed? */
function hit(a, b) {
  return a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 &&
    a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
}
function hits(rect, list) {
  for (let i = 0; i < list.length; i++) if (hit(rect, list[i])) return true;
  return false;
}

/* ========================================================================= */

export class WorldLabels {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.visible = true;
    this.vw = hud.vw || 1600;
    this.vh = hud.vh || 900;
    this.unit = this.vh / 100;
    /** uid -> first frame we saw it, for the spawn ramp */
    this._born = new Map();
    /** rendered string -> measured {w,h}, so a reflow happens once per string */
    this._meas = new Map();
    /** cached rects of the static HUD furniture */
    this._res = [];
    this._resAt = -999;
    /** hard obstacles (never overlap) and soft ones (prefer not to) */
    this._obst = [];
    this._soft = [];
    this._owned = false;
    /** sprites we took off the scene graph, so dispose() can hand them back */
    this._detached = [];
    /**
     * Rects of the plates actually drawn this frame, in screen px (top-left).
     *
     * Published for panels/Combat.js, which seeds its damage-number solver with
     * them so a floating number lifts clear of a ground cartouche instead of
     * printing across it. It reads them one frame late — this layer has to solve
     * after the combat layer, because it consumes the live nameplate rects — and
     * that is fine: a cartouche is pinned to a drop on the floor.
     */
    this.labelRects = [];
  }

  /* =============================================================== build */

  build() {
    this.layer = mk('div', 'wlLayer', this.hud.root);
    this.slots = [];
    for (let i = 0; i < POOL; i++) {
      const root = mk('div', 'wl', this.layer);
      const skin = mk('canvas', 'wlSkin', root);
      const stem = mk('div', 'wlStem', root);
      const inner = mk('div', 'wlIn', root);
      const pip = mk('div', 'wlPip', inner);
      const col = mk('div', 'wlCol', inner);
      const l1 = txt('div', 'wlName', '', col);
      const l2 = txt('div', 'wlName wl2', '', col);
      root.style.opacity = '0';
      root.style.transform = 'translate(-9999px,-9999px)';
      this.slots.push({
        root, skin, stem, pip, l1, l2,
        uid: null, rarity: null, text: null, w: 0, h: 0, painted: '',
      });
    }
    this._injectCSS();
  }

  /* ------------------------------------------------------- label ownership */

  /**
   * Take the ground-label channel off Loot.
   *
   * `Loot` publishes the handshake (`set hudOwnsLabels`) and a data feed
   * (`worldLabels()`) precisely so the HUD can do this — see the comment on
   * those members. The setter hides the sprite pool once, but Loot's own
   * `_writeLabels()` re-asserts `sprite.visible = true` every frame, so hiding
   * alone is not enough: the sprites come off the scene graph. Nothing else in
   * Loot re-parents them, and `dispose()`/`clearWorld()` only touch `.visible`
   * and the textures, so this is safe and reversible.
   */
  _claim(loot) {
    if (this._owned || !loot) return;
    try {
      loot.hudOwnsLabels = true;
      const pool = loot.labels;
      if (Array.isArray(pool)) {
        const ui = this.engine.uiLayer;
        for (const l of pool) {
          const sp = l?.sprite;
          if (!sp) continue;
          sp.visible = false;
          if (sp.parent) {
            this._detached.push({ sprite: sp, parent: sp.parent });
            sp.parent.remove(sp);
          }
          /* If anything ever puts them back, they land on the post-exempt UI
             layer rather than back inside the graded frame. */
          if (typeof ui === 'number') sp.layers.set(ui);
        }
      }
      this._owned = true;
    } catch (e) {
      console.warn('[hud] could not claim ground labels —', e?.message ?? e);
      this._owned = true;               // do not retry every frame
    }
  }

  /* ============================================================ lifecycle */

  setVisible(on) {
    this.visible = !!on;
    if (this.layer) this.layer.classList.toggle('hide', !this.visible);
    if (!this.visible) this._parkAll();
  }

  applyScenario() {
    this._born.clear();
    this._resAt = -999;
    for (const s of this.slots ?? []) { s.uid = null; s.text = null; }
    this._parkAll();
  }

  resize(w, h) {
    this.vw = w || this.vw;
    this.vh = h || this.vh;
    this.unit = this.vh / 100;
    this._resAt = -999;
    /* vh-relative type just changed size — every plate must be re-measured */
    this._meas.clear();
    for (const s of this.slots ?? []) { s.uid = null; s.text = null; s.painted = ''; }
  }

  _parkAll() {
    this.labelRects.length = 0;
    for (const s of this.slots ?? []) {
      s.root.style.opacity = '0';
      s.root.style.transform = 'translate(-9999px,-9999px)';
    }
  }

  /* =============================================================== update */

  update(dt, elapsed) {
    if (!this.slots) return;
    const loot = this.engine.get('loot');
    if (!loot || typeof loot.worldLabels !== 'function') { this._parkAll(); return; }
    /*
     * Claim BEFORE the visibility gate.
     *
     * Measured regression: gating this on `visible` meant the `inventory`
     * framing — where this layer is deliberately hidden behind the character
     * screen — never claimed the channel, so Loot kept drawing one filtered
     * sprite plate into the graded scene behind the panels. The takeover is a
     * property of the HUD existing, not of the layer being on screen.
     */
    this._claim(loot);
    if (!this.visible) return;

    const cam = this.engine.camera;
    const input = this.engine.input;
    const alt = !!(input?.pressed?.('AltLeft') || input?.pressed?.('AltRight'));
    const range = alt ? ALT_RANGE : RANGE;
    const maxN = alt ? POOL : MAX_NEAR;

    /* ---------------------------------------------------- rank the drops */
    let feed;
    try { feed = loot.worldLabels(); } catch { this._parkAll(); return; }
    if (!feed || !feed.length) { this._parkAll(); this._born.clear(); return; }

    const cand = [];
    const seen = new Set();
    for (const d of feed) {
      if (!d || !d.position || !d.uid) continue;
      seen.add(d.uid);
      const dist = typeof d.distance === 'number' ? d.distance : 0;
      if (dist > range) continue;
      const rank = rankOf(d.rarity);
      cand.push({ d, dist, rank, pri: dist - rank * 3.5 });
    }
    for (const uid of [...this._born.keys()]) if (!seen.has(uid)) this._born.delete(uid);
    /* uid tiebreak keeps the order stable when two drops are equidistant */
    cand.sort((a, b) => (a.pri - b.pri) || (a.d.uid < b.d.uid ? -1 : 1));
    if (cand.length > maxN) cand.length = maxN;

    /* ------------------------------------------- sticky slot assignment */
    const claimed = new Array(this.slots.length).fill(false);
    const slotOf = new Array(cand.length).fill(-1);
    for (let i = 0; i < cand.length; i++) {
      for (let j = 0; j < this.slots.length; j++) {
        if (!claimed[j] && this.slots[j].uid === cand[i].d.uid) { slotOf[i] = j; claimed[j] = true; break; }
      }
    }
    for (let i = 0; i < cand.length; i++) {
      if (slotOf[i] >= 0) continue;
      for (let j = 0; j < this.slots.length; j++) {
        if (!claimed[j]) { slotOf[i] = j; claimed[j] = true; break; }
      }
    }

    /* ------------------------------------------------ obstacle collection */
    /*
     * HARD obstacles may never be overlapped: other labels, the hero, live
     * nameplates, and every occupied region of the HUD (this is what makes
     * "a label can never sit on the tooltip" a structural fact rather than a
     * hope). SOFT obstacles are only a preference — see _solve.
     */
    const hard = this._obst;
    hard.length = 0;
    if (this.engine.clock.frame - this._resAt > 45) this._refreshReserved();
    for (const r of this._res) hard.push(r);
    const heroRect = this._heroRect(cam);
    if (heroRect) hard.push(heroRect);
    const plates = this.hud.combat?.plateRects;
    if (plates) for (const r of plates) hard.push(r);
    const soft = this._soft;
    soft.length = 0;
    this._pushHeads(cam, soft);

    /* --------------------------------------------------------- place them */
    const live = new Set();
    this.labelRects.length = 0;
    for (let i = 0; i < cand.length; i++) {
      const slot = this.slots[slotOf[i]];
      if (!slot) continue;
      const c = cand[i];
      const d = c.d;

      if (slot.uid !== d.uid) {
        slot.uid = d.uid;
        this._content(slot, d, c.rank);
      }
      if (!this._born.has(d.uid)) this._born.set(d.uid, elapsed);

      const p = d.position;
      const ndc = project(p.x, p.y, p.z, cam);
      if (!ndc) continue;
      const sx = (ndc.x * 0.5 + 0.5) * this.vw;
      const sy = (-ndc.y * 0.5 + 0.5) * this.vh;

      const rect = this._solve(slot, sx, sy, hard, soft);
      if (!rect) continue;                              // no clear space: drop it

      const fade = alt ? 1 : 1 - smooth(range * FADE_IN, range, c.dist);
      const born = clamp01((elapsed - (this._born.get(d.uid) ?? elapsed)) / BORN_RAMP);
      const taper = 1 - 0.11 * i;
      const a = clamp01(fade * born * taper);
      if (a <= 0.02) continue;

      hard.push(rect);
      this.labelRects.push(rect);
      live.add(slotOf[i]);
      const dy = (sy - this.unit * LIFT_VH) - (rect.y + rect.h);
      slot.stem.style.height = dy > 2 ? `${dy.toFixed(1)}px` : '0px';
      slot.stem.style.left = `${clamp(sx - rect.x, 2, rect.w - 2).toFixed(1)}px`;
      slot.stem.style.opacity = dy > 2 ? (a * 0.55).toFixed(3) : '0';
      slot.root.style.transform = `translate(${rect.x.toFixed(1)}px,${rect.y.toFixed(1)}px)`;
      slot.root.style.opacity = a.toFixed(3);
    }
    for (let j = 0; j < this.slots.length; j++) {
      if (live.has(j)) continue;
      this.slots[j].root.style.opacity = '0';
      this.slots[j].root.style.transform = 'translate(-9999px,-9999px)';
    }
  }

  /* ------------------------------------------------------------- content */

  /** Write the lettering, measure the resulting box, repaint the cartouche. */
  _content(slot, d, rank) {
    const r = rarityOf(d.rarity);
    const lines = this._lines(String(d.name ?? 'Unknown'), rank);
    slot.l1.textContent = lines[0];
    slot.l2.textContent = lines[1] ?? '';
    slot.l2.classList.toggle('hide', !lines[1]);
    slot.l1.style.color = r.text;
    slot.l2.style.color = r.text;
    slot.root.classList.toggle('two', !!lines[1]);
    slot.pip.style.background =
      `radial-gradient(circle at 36% 30%, ${r.line}, ${r.deep} 82%)`;
    slot.pip.style.boxShadow =
      `0 0 0 1px rgba(0,0,0,.85), inset 0 .1vh .2vh rgba(255,255,255,.45)`;
    slot.rarity = d.rarity;
    const key = lines.join('|');
    slot.text = key;

    /*
     * Measuring is a forced layout flush, so it happens once per distinct string
     * and is then memoised. Without the memo a pair of drops at nearly equal
     * priority can trade one slot back and forth and pay a reflow every frame.
     */
    let m = this._meas.get(key);
    if (!m) {
      const b = slot.root.getBoundingClientRect();
      m = { w: Math.max(8, b.width), h: Math.max(6, b.height) };
      if (this._meas.size > 96) this._meas.clear();
      this._meas.set(key, m);
    }
    slot.w = m.w;
    slot.h = m.h;
    this._paint(slot);
  }

  /**
   * One line for everything short. A legendary or mythic may break once, at
   * " of " if the name has one — which is where the old sprite plate broke it,
   * and it is the only break that reads. Everything else is truncated by CSS.
   */
  _lines(name, rank) {
    const up = name.toUpperCase();
    if (rank < WRAP_RANK || up.length <= WRAP_AT) return [up];
    const i = up.lastIndexOf(' OF ');
    if (i > 4 && up.length - i > 5) return [up.slice(0, i), up.slice(i + 1)];
    let bi = -1, bd = 1e9;
    const mid = up.length * 0.5;
    for (let k = 0; k < up.length; k++) {
      if (up[k] !== ' ') continue;
      const dd = Math.abs(k - mid);
      if (dd < bd) { bd = dd; bi = k; }
    }
    return bi > 3 ? [up.slice(0, bi), up.slice(bi + 1)] : [up];
  }

  /* --------------------------------------------------------------- solver */

  /**
   * Find the lowest clear row above the drop. Plates stack upward in whole
   * plate-heights so a column of them reads as a list, never as a smear.
   *
   * Two passes, because the two obstacle classes are not equally important.
   * Pass 1 avoids everything but may only spend SOFT_TRIES rows doing it. Pass 2
   * drops the soft set and gets the full budget. Only if no row clears the HARD
   * set is the plate abandoned — the "collapse rather than overlap" behaviour the
   * brief asks for.
   */
  _solve(slot, sx, sy, hard, soft) {
    const u = this.unit;
    const gap = u * GAP_VH;
    const base = sy - u * LIFT_VH;
    const marginX = u * 0.9;
    const marginTop = u * 1.0;
    const x = clamp(sx - slot.w * 0.5, marginX, Math.max(marginX, this.vw - slot.w - marginX));
    for (let pass = 0; pass < 2; pass++) {
      const tries = pass === 0 ? SOFT_TRIES : TRIES;
      for (let k = 0; k < tries; k++) {
        const rect = { x, y: base - k * (slot.h + gap) - slot.h, w: slot.w, h: slot.h };
        if (rect.y < marginTop) break;
        if (rect.y + rect.h > this.vh) continue;
        if (hits(rect, hard)) continue;
        if (pass === 0 && hits(rect, soft)) continue;
        return rect;
      }
    }
    return null;
  }

  /**
   * Reserve the nearest enemies' heads.
   *
   * "The labels occlude the fight" is the actual complaint, and the fight is the
   * bodies. Only the head box is reserved, not the whole silhouette: a label
   * must never cover a face, but reserving 3 m of torso in a nine-enemy pack
   * would leave nowhere legal to stand and every label would silently vanish.
   */
  _pushHeads(cam, obst) {
    const bes = this.engine.get('bestiary');
    const ents = bes?.entities;
    if (!ents || !ents.length) return;
    const hero = this.engine.get('hero');
    const hx = hero?.position?.x ?? 0;
    const hz = hero?.position?.z ?? 0;
    const w = this.unit * 2.5;
    const h = this.unit * 2.8;
    let n = 0;
    for (let i = 0; i < ents.length && n < MAX_HEADS; i++) {
      const en = ents[i];
      const p = en?.position;
      if (!en || en.dead || !p) continue;
      const dx = p.x - hx, dz = p.z - hz;
      if (dx * dx + dz * dz > HEAD_RANGE * HEAD_RANGE) continue;
      const eh = typeof en.height === 'number' ? en.height : 1.9;
      const ndc = project(p.x, (p.y ?? 0) + eh * 0.86, p.z, cam);
      if (!ndc) continue;
      const sx = (ndc.x * 0.5 + 0.5) * this.vw;
      const sy = (-ndc.y * 0.5 + 0.5) * this.vh;
      obst.push({ x: sx - w * 0.5, y: sy - h * 0.55, w, h });
      n++;
    }
  }

  /** Reserve the hero's silhouette so a label can never sit on the player. */
  _heroRect(cam) {
    const hero = this.engine.get('hero');
    const p = hero?.position;
    if (!p || typeof p.x !== 'number') return null;
    const h = typeof hero.height === 'number' ? hero.height : 1.85;
    const ndc = project(p.x, (p.y ?? 0) + h * 0.55, p.z, cam);
    if (!ndc) return null;
    const sx = (ndc.x * 0.5 + 0.5) * this.vw;
    const sy = (-ndc.y * 0.5 + 0.5) * this.vh;
    /* ~1.4x the hero's on-screen silhouette at an ARPG camera distance: enough
       that nothing lands on the pauldrons, not so much that it sterilises the
       whole centre of the frame. */
    const w = this.unit * 6.0;
    const ht = this.unit * 9.0;
    return { x: sx - w * 0.5, y: sy - ht * 0.58, w, h: ht };
  }

  /**
   * Rects of the occupied HUD furniture. Read on scenario change, on resize and
   * every 45 frames — never per frame, because a `getBoundingClientRect` in the
   * inner loop would force a layout flush 8 times a frame.
   */
  _refreshReserved() {
    this._resAt = this.engine.clock.frame;
    const R = this._res;
    R.length = 0;
    const root = this.hud.root;
    if (!root) return;
    const pad = this.unit * 0.5;
    for (const sel of HUD_OBSTACLES) {
      let el = null;
      try { el = root.querySelector(sel); } catch { el = null; }
      if (!el) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      if (parseFloat(s.opacity || '1') < 0.04) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 3 || b.height < 3) continue;
      R.push({ x: b.left - pad, y: b.top - pad, w: b.width + pad * 2, h: b.height + pad * 2 });
    }
  }

  /* ---------------------------------------------------------------- paint */

  /**
   * The cartouche: a chamfered dark-leather plate over hammered iron, a rarity
   * hairline along the top and bottom edges, a catch-light on the upper bevel
   * and an occlusion gradient into the lower one. Painted into the slot's own
   * canvas at device resolution, so the ornament is never a stretched bitmap.
   */
  _paint(slot) {
    const key = `${Math.round(slot.w)}x${Math.round(slot.h)}:${slot.rarity}`;
    if (slot.painted === key) return;
    slot.painted = key;
    const d = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    const W = Math.max(4, Math.round(slot.w * d));
    const H = Math.max(4, Math.round(slot.h * d));
    const cv = slot.skin;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const w = slot.w, h = slot.h;
    const r = rarityOf(slot.rarity);

    const cham = Math.min(h * 0.44, w * 0.10);
    const p = new Path2D();
    const x0 = 0.5, y0 = 0.5, ww = w - 1, hh = h - 1;
    p.moveTo(x0 + cham, y0);
    p.lineTo(x0 + ww - cham, y0);
    p.lineTo(x0 + ww, y0 + hh * 0.5);
    p.lineTo(x0 + ww - cham, y0 + hh);
    p.lineTo(x0 + cham, y0 + hh);
    p.lineTo(x0, y0 + hh * 0.5);
    p.closePath();

    ctx.save();
    ctx.clip(p);
    try {
      this.atlas?.material?.(ctx, 0, 0, w, h, 'leather', { seed: 37, scale: 0.30 });
    } catch {
      ctx.fillStyle = '#15110c';
      ctx.fillRect(0, 0, w, h);
    }
    /* Darken hard. 10 px type has to read over a torchlit flagstone that can be
       anywhere from black to clipped white, so the plate carries the contrast —
       it is a physical object hanging in front of the floor, not a tint. */
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(7,8,11,0.86)');
    g.addColorStop(0.44, 'rgba(4,5,8,0.94)');
    g.addColorStop(1, 'rgba(2,2,4,0.97)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    /* rarity wash, strongest at the ends where the chamfers catch it */
    const rg = ctx.createLinearGradient(0, 0, w, 0);
    rg.addColorStop(0, hexA(r.deep, 0.80));
    rg.addColorStop(0.30, hexA(r.deep, 0.20));
    rg.addColorStop(0.70, hexA(r.deep, 0.20));
    rg.addColorStop(1, hexA(r.deep, 0.80));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
    /* upper bevel catch-light */
    const cl = ctx.createLinearGradient(0, 0, 0, Math.max(1, h * 0.34));
    cl.addColorStop(0, 'rgba(255,244,214,0.13)');
    cl.addColorStop(1, 'rgba(255,244,214,0)');
    ctx.fillStyle = cl;
    ctx.fillRect(0, 0, w, h * 0.34);
    ctx.restore();

    /* cut line under the plate, then the rarity hairline just inside it */
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(2,3,5,0.95)';
    ctx.stroke(p);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(r.line, 0.46);
    ctx.stroke(p);
    /* a brighter hairline on the top edge only — light comes from above */
    ctx.beginPath();
    ctx.moveTo(cham + 1, 1.2);
    ctx.lineTo(w - cham - 1, 1.2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = hexA(r.line, 0.30);
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ================================================================ util */

  dispose() {
    /* hand the sprites back so the game is not left label-less */
    for (const rec of this._detached) {
      try { rec.parent.add(rec.sprite); rec.sprite.visible = false; } catch { /* gone */ }
    }
    this._detached.length = 0;
    this.labelRects.length = 0;
    this._born.clear();
    this._meas.clear();
    this._res.length = 0;
    this._obst.length = 0;
    this._soft.length = 0;
    try {
      const loot = this.engine.get('loot');
      if (loot) loot.hudOwnsLabels = false;
    } catch { /* module already down */ }
    this.layer?.remove();
  }

  /* ================================================================== CSS */

  _injectCSS() {
    if (document.getElementById('sanctum-hud-wlabels')) return;
    const s = document.createElement('style');
    s.id = 'sanctum-hud-wlabels';
    s.textContent = `
#sanctum-hud .wlLayer{ position:absolute; inset:0; pointer-events:none; }

/* One plate. Content-sized, so the cartouche is measured, not guessed. */
#sanctum-hud .wl{
  position:absolute; left:0; top:0; width:max-content; opacity:0;
  will-change:transform,opacity;
}
#sanctum-hud .wlSkin{
  position:absolute; inset:0; width:100%; height:100%; display:block;
  filter:drop-shadow(0 .28vh .5vh rgba(0,0,0,.78));
}
/* hairline stem back down to the drop when the plate has been nudged up */
#sanctum-hud .wlStem{
  position:absolute; top:100%; width:1px; height:0;
  background:linear-gradient(to bottom,rgba(226,196,132,.55),rgba(226,196,132,0));
}
#sanctum-hud .wlIn{
  position:relative; display:flex; align-items:center; gap:.44vh;
  padding:.32vh 1.05vh .34vh .82vh;
}
/* a wrapped name already has its own leading; do not also pad it vertically */
#sanctum-hud .wl.two .wlIn{ padding-top:.22vh; padding-bottom:.24vh; }
#sanctum-hud .wlPip{
  width:.52vh; height:.52vh; flex:0 0 auto; border-radius:50%;
}
#sanctum-hud .wlCol{ display:flex; flex-direction:column; min-width:0; }
#sanctum-hud .wl .wlName{
  font-family:${FONT_DISPLAY};
  font-size:1.10vh; line-height:1.20; letter-spacing:.075em;
  max-width:17vh; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  text-shadow:0 -1px 0 rgba(0,0,0,.95),0 1px 0 rgba(0,0,0,.85),0 0 .5vh rgba(0,0,0,.9);
}
#sanctum-hud .wl .wl2{ font-size:1.00vh; opacity:.92; letter-spacing:.09em; }
`;
    document.head.appendChild(s);
  }
}

/* ------------------------------------------------------------------ maths */

/** Scratch — one vector for the whole layer, no per-frame allocation. */
const _px = new THREE.Vector3();

/** World point -> NDC, or null when it is behind the camera / off the far plane. */
function project(x, y, z, cam) {
  if (!cam) return null;
  _px.set(x, y, z).project(cam);
  return _px.z > 1 ? null : _px;
}

function hexA(h, a) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  if (!Number.isFinite(n)) return `rgba(0,0,0,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default WorldLabels;
