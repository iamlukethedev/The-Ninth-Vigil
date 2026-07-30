/**
 * THE NINTH VIGIL — character screen
 * ---------------------------------------------------------------------------
 * Two ornate panels:
 *
 *   • Character sheet — a paper doll (procedurally drawn armoured silhouette
 *     with rim light and a cast shadow) ringed by twelve cast equipment
 *     sockets. Empty sockets show a ghosted silhouette of what belongs there;
 *     filled ones get a rarity-coloured bezel, an inner glow, and an item icon
 *     generated per item type. Under it, the stat block with real typographic
 *     hierarchy: engraved section rules, leader dots, didone numerals.
 *
 *   • Inventory — a grid of beveled sockets with rarity borders and glows,
 *     a currency footer, and stash tabs.
 */

import { rarityOf, FONT_DISPLAY, FONT_NUM } from '../UITheme.js';
import { RELIEF_SEED } from '../UIAtlas.js';
import { mk, sty, txt, statRow, section, fmt, clamp01 } from './Widgets.js';
import { SLOTS, makeLoadout, makeBackpack } from './Items.js';

const COLS = 7;
const ROWS = 11;
const lerp = (a, b, t) => a + (b - a) * t;

/** Paper-doll socket layout, in vh relative to the panel body. */
const DOLL = [
  { id: 'helm',    x: 0.6,  y: 0.8 },
  { id: 'chest',   x: 0.6,  y: 7.6 },
  { id: 'gloves',  x: 0.6,  y: 14.4 },
  { id: 'belt',    x: 0.6,  y: 21.2 },
  { id: 'boots',   x: 0.6,  y: 28.0 },
  { id: 'amulet',  x: 33.6, y: 0.8 },
  { id: 'cloak',   x: 33.6, y: 7.6 },
  { id: 'bracers', x: 33.6, y: 14.4 },
  { id: 'ring1',   x: 33.6, y: 21.2 },
  { id: 'ring2',   x: 33.6, y: 28.0 },
  { id: 'weapon',  x: 11.2, y: 35.4 },
  { id: 'offhand', x: 22.8, y: 35.4 },
];
const SLOT_VH = 5.4;
/** Left deliberately empty so the ghosted slot silhouettes are visible. */
const EMPTY_SLOTS = new Set(['bracers', 'ring2']);

export class Character {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.orn = hud.orn;
    this.visible = false;
  }

  /* ================================================================ build */

  build() {
    const root = this.hud.root;
    this._injectCSS();

    /* ---------------------------------------------------- character sheet */
    const cp = this.hud.skins.panel(root, 'charPnl hide', {
      kind: 'leather', frame: 'iron', band: 19, chamfer: 26, ornament: 'heavy',
      seed: 13, fieldScale: 0.55, filigree: 0.11, rivetGap: 62,
      header: true, headerH: 32, headerGem: '#b8352c',
      vignette: 0.40, fieldLift: 0.11, rake: 0.080,
      /* three real steps in the surface: a sunken bay behind each column of
         equipment sockets, and a sunken field the stat block is set into. A
         single continuous hide, however well grained, still reads as "a flat
         brown-grey gradient" because nothing in it is at a different depth. */
      wells: [
        { x: 0.038, y: 0.108, w: 0.175, h: 0.435, cham: 11, mat: 'leather', scale: 0.30 },
        { x: 0.787, y: 0.108, w: 0.175, h: 0.435, cham: 11, mat: 'leather', scale: 0.30, seed: 131 },
        /* the stat ledger: a RAISED sheet of vellum laid on the hide and framed in
           gold, so the interior carries three materials (hide, parchment, metal)
           and one plane that is genuinely light. The stat type is ink — see
           _buildStats. */
        { x: 0.040, y: 0.622, w: 0.920, h: 0.336, cham: 13, mat: 'vellum', scale: 0.26, raised: true, seed: 167 },
      ],
    });
    this.charPnl = cp;
    const cb = cp.body;
    const hd = mk('div', 'cHead', cb);
    this._setTitle(mk('div', 'cName gilt', hd), 'VALTHRUN', 3.29);
    const sub = mk('div', 'cSub', hd);
    txt('span', 'eng', 'Barbarian', sub);
    txt('span', 'cDot', '·', sub);
    this.cLevel = txt('span', 'eng', 'Level 12', sub);
    txt('span', 'cDot', '·', sub);
    txt('span', 'eng', 'World Tier IV', sub);

    /* doll block */
    const doll = mk('div', 'cDoll', cb);
    const fig = mk('div', 'cFig', doll);
    const figSkin = mk('canvas', 'cFigSkin', fig);
    this.hud.skins.items.push({
      root: fig, skin: figSkin, kind: 'custom', opts: {},
      draw: (ctx, w, h) => this._paintDoll(ctx, w, h),
    });

    this.slotEls = {};
    /* Sockets are rasterised near their displayed size (equipment slots occupy
       ~49 px, grid cells ~42 px at 900 p) so the 1-px specular pin-lines survive
       instead of being averaged away by a 4x downscale. */
    const silSock = this.atlas.socketURI(112, { tag: 'eq', seed: 33, cham: 0.20, band: 0.11 });
    for (const d of DOLL) {
      const def = SLOTS.find((s) => s.id === d.id);
      const e = mk('div', 'eqSlot', doll);
      e.style.left = `${d.x}vh`;
      e.style.top = `${d.y}vh`;
      const sock = mk('div', 'eqSock', e);
      sock.style.backgroundImage = `url("${silSock}")`;
      const sil = mk('div', 'eqSil', e);
      sil.style.backgroundImage = `url("${this.orn.slotSil(140, def?.icon ?? 'weapon')}")`;
      const glow = mk('div', 'eqGlow', e);
      const icon = mk('div', 'eqIcon', e);
      const bez = mk('div', 'eqBez', e);
      const lab = txt('div', 'eqLab eng', def?.label ?? d.id, e);
      this.slotEls[d.id] = { root: e, sock, sil, glow, icon, bez, lab };
    }

    /* stat block */
    const stats = mk('div', 'cStats', cb);
    this.statCols = [mk('div', 'cCol', stats), mk('div', 'cCol', stats)];
    this._buildStats();

    /* ------------------------------------------------------------ inventory */
    const ip = this.hud.skins.panel(root, 'invPnl hide', {
      kind: 'leather', frame: 'iron', band: 19, chamfer: 26, ornament: 'heavy',
      seed: 41, fieldScale: 0.55, filigree: 0.12, rivetGap: 58,
      header: true, headerH: 32, headerGem: '#2f6bb0',
      vignette: 0.40, fieldLift: 0.11, rake: 0.080,
      /* the grid is set into a sunken bay, the way a stash actually is; the
         currency footer sits on its own raised strip */
      wells: [
        /* the stash bay is a hammered IRON plate let into the hide, not more hide:
           the sockets are cut into metal, and a dark cold plate is what the bright
           collars and the rarity glows read against */
        { x: 0.048, y: 0.104, w: 0.904, h: 0.742, cham: 13, mat: 'iron', scale: 0.30 },
        { x: 0.062, y: 0.934, w: 0.876, h: 0.044, cham: 6, mat: 'vellum', scale: 0.26, raised: true, seed: 149 },
      ],
    });
    this.invPnl = ip;
    const ib = ip.body;
    const ihd = mk('div', 'iHead', ib);
    this._setTitle(mk('div', 'iTitle gilt', ihd), 'INVENTORY', 2.52);
    mk('div', 'rule iRule', ib);
    const tabRow = mk('div', 'iTabRow', ib);
    txt('span', 'eng iTabLab', 'Stash', tabRow);
    const tabs = mk('div', 'iTabs', tabRow);
    this.tabEls = [];
    for (let i = 0; i < 4; i++) {
      const t = mk('div', `iTab${i === 0 ? ' on' : ''}`, tabs);
      t.style.backgroundImage = `url("${this.orn.plate(70, 52, { tag: i === 0 ? 'tabon' : 'tab', metal: i === 0 ? 'bronze' : 'iron', cham: 10, inlay: false })}")`;
      txt('span', 'num', String(i + 1), t);
      this.tabEls.push(t);
    }

    const grid = mk('div', 'iGrid', ib);
    const cellSock = this.atlas.socketURI(96, { tag: 'inv', seed: 23, cham: 0.22, band: 0.12, rim: 0 });
    this.cells = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      const c = mk('div', 'iCell', grid);
      const sock = mk('div', 'cSock', c);
      sock.style.backgroundImage = `url("${cellSock}")`;
      const glow = mk('div', 'cGlow', c);
      const icon = mk('div', 'cIcon', c);
      const bez = mk('div', 'cBez', c);
      const stack = txt('div', 'cStack num', '', c);
      this.cells.push({ root: c, sock, glow, icon, bez, stack });
    }

    mk('div', 'rule iRule', ib);
    const foot = mk('div', 'iFoot', ib);
    const coin = mk('div', 'iCoin', foot);
    coin.style.backgroundImage = `url("${this._coinURI()}")`;
    this.gold = txt('span', 'iGold num', '1,284,610', foot);
    this.cap = txt('span', 'iCap eng', '', foot);
  }

  /* --------------------------------------------------------------- stats */

  _buildStats() {
    const A = this.statCols[0], B = this.statCols[1];
    A.textContent = ''; B.textContent = '';
    /* The stat block is set on a raised VELLUM ledger riveted to the hide (see the
       third well in build()), so the type is iron-gall INK on parchment, not
       engraved metal: dark letterforms with a pale emboss under them. That gives
       the panel its second material and puts the one genuinely bright plane in the
       interior exactly where the eye is meant to land. */
    const INK = '#241a10';
    const SZ = {
      size: 1.27, padY: 0.10,
      labelColor: '#4e4029', valueColor: INK,
      dotColor: 'rgba(78,64,42,.55)',
      shadow: '0 1px 0 rgba(255,248,222,.62),0 -1px 0 rgba(120,98,58,.20)',
    };
    const SEC = { size: 1.10, color: '#5a4526', shadow: '0 1px 0 rgba(255,248,222,.58)' };
    section(A, 'Attributes', { ...SEC, mt: 0, mb: 0.35 });
    this.sStr = statRow(A, 'Strength', '812', { ...SZ, bold: true }).value;
    this.sDex = statRow(A, 'Dexterity', '214', SZ).value;
    this.sInt = statRow(A, 'Intelligence', '96', SZ).value;
    this.sWil = statRow(A, 'Willpower', '178', SZ).value;
    section(A, 'Offence', { ...SEC, mt: 0.7, mb: 0.35 });
    this.sDmg = statRow(A, 'Damage', '4,182', { ...SZ, valueColor: '#6d2a0c', bold: true }).value;
    this.sSpd = statRow(A, 'Attack Speed', '+14.0%', SZ).value;
    this.sCrt = statRow(A, 'Critical Chance', '28.4%', SZ).value;
    this.sCrd = statRow(A, 'Critical Damage', '+192%', SZ).value;

    section(B, 'Defence', { ...SEC, mt: 0, mb: 0.35 });
    this.sArm = statRow(B, 'Armour', '8,204', { ...SZ, valueColor: '#1d3350', bold: true }).value;
    this.sLif = statRow(B, 'Maximum Life', '12,480', SZ).value;
    this.sDr = statRow(B, 'Damage Reduction', '62.8%', SZ).value;
    this.sBlk = statRow(B, 'Block Chance', '31%', SZ).value;
    section(B, 'Resistances', { ...SEC, mt: 0.7, mb: 0.35 });
    for (const [n, v, c] of [['Fire', '+38%', '#8a3a10'], ['Cold', '+42%', '#1c3c5e'],
      ['Shadow', '+51%', '#3f2a63'], ['Poison', '+34%', '#2e4a12']]) {
      statRow(B, n, v, { ...SZ, valueColor: c });
    }
  }

  /* ============================================================= scenario */

  applyScenario(name) {
    if (name !== 'inventory') return;
    this.loadout = makeLoadout(this.engine, 7);
    this.pack = makeBackpack(this.engine, 11, COLS * ROWS);

    for (const d of DOLL) {
      const el = this.slotEls[d.id];
      const it = EMPTY_SLOTS.has(d.id) ? null : this.loadout[d.id];
      if (!el) continue;
      if (!it) {
        el.icon.style.backgroundImage = 'none';
        el.sil.style.opacity = '1';
        el.bez.style.opacity = '0';
        el.glow.style.background = 'none';
        el.lab.style.opacity = '1';
        continue;
      }
      el.lab.style.opacity = '0';
      const r = rarityOf(it.rarity);
      el.sil.style.opacity = '0';
      /* 96 px into a ~36 px box. Authoring an icon at 4x its display size and
         letting the browser box-filter it down averages every specular highlight
         away, which is what made the grid read as muddy lumps; 2.5x keeps the
         antialiasing and keeps the crests. */
      el.icon.style.backgroundImage = `url("${this.atlas.itemIconURI(96, it.icon, it.rarity, 5)}")`;
      /* `closest-side` matters: the default farthest-corner sizing leaves the
         gradient still opaque where the square box cuts it, which draws a hard
         rectangle of colour behind every filled slot. */
      /* the socket glow is weighted to the RIM, not the centre: light spilling up
         the well wall from the item. Pooled in the middle it becomes a flat
         coloured tile and the item sitting on it stops reading. */
      /* RIM ONLY. At 52%/0.14 the wash reached the middle of the well and every
         equipped slot read as a flat coloured tile with an icon floating on it —
         the socket behind an item has to stay a dark hole for the bezel's
         specular and the icon's own metal to have anything to read against. */
      el.glow.style.background =
        `radial-gradient(circle closest-side at 45% 42%, rgba(0,0,0,0) 58%, ` +
        `${hexA(r.glow, 0.10)} 72%, ${hexA(r.glow, 0.34)} 88%, rgba(0,0,0,0) 100%)`;
      /* a cast metal collar in the item's own rarity metal, with a real
         specular and corner cabochons — not a 1-px CSS outline */
      el.bez.style.backgroundImage =
        `url("${this.atlas.rarityFrameURI(112, r, { tag: 'eq', cham: 0.20, band: 0.085, pips: true })}")`;
      el.bez.style.boxShadow = `0 0 .40vh ${hexA(r.glow, 0.34)}`;
      el.bez.style.opacity = '1';
    }

    let used = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      const it = this.pack[i];
      if (!it) {
        c.icon.style.backgroundImage = 'none';
        c.bez.style.opacity = '0';
        c.glow.style.background = 'none';
        c.stack.textContent = '';
        continue;
      }
      used++;
      const r = rarityOf(it.rarity);
      c.icon.style.backgroundImage = `url("${this.atlas.itemIconURI(80, it.icon, it.rarity, 2)}")`;
      c.glow.style.background =
        `radial-gradient(circle closest-side at 45% 42%, rgba(0,0,0,0) 60%, ` +
        `${hexA(r.glow, 0.09)} 74%, ${hexA(r.glow, 0.30)} 89%, rgba(0,0,0,0) 100%)`;
      c.bez.style.backgroundImage =
        `url("${this.atlas.rarityFrameURI(96, r, { tag: 'inv', cham: 0.22, band: 0.075, pips: false })}")`;
      c.bez.style.opacity = '1';
      c.stack.textContent = it.icon === 'potion' || it.icon === 'gem' ? String(1 + (i % 4) * 3) : '';
    }
    if (this.cap) this.cap.textContent = `${used} / ${COLS * ROWS}`;

    const hero = this.engine.get('hero');
    if (hero?.stats) {
      const s = hero.stats;
      this.cLevel.textContent = `Level ${s.level}`;
      this.sDmg.textContent = fmt(s.damage);
      this.sArm.textContent = fmt(s.armour);
      this.sLif.textContent = fmt(s.maxHealth);
      this.sCrt.textContent = `${(s.critChance * 100).toFixed(1)}%`;
      this.sCrd.textContent = `+${Math.round((s.critDamage - 1) * 100)}%`;
      this.sStr.textContent = fmt(320 + s.level * 41);
      this.sDex.textContent = fmt(96 + s.level * 9);
      this.sInt.textContent = fmt(48 + s.level * 4);
      this.sWil.textContent = fmt(72 + s.level * 8);
      this.sDr.textContent = `${(100 * (1 - Math.pow(0.985, s.armour / 26))).toFixed(1)}%`;
    }
    this.hud._repaintSoon = 2;
  }

  setVisible(on) {
    this.visible = !!on;
    this.charPnl?.root.classList.toggle('hide', !on);
    this.invPnl?.root.classList.toggle('hide', !on);
  }

  resize() { }

  update(dt, elapsed) {
    if (!this.visible) return;
    /* the equipped legendary breathes so the screen is not a dead still */
    const el = this.slotEls?.weapon;
    if (el) {
      const k = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * 1.7));
      el.glow.style.opacity = k.toFixed(3);
    }
    const am = this.slotEls?.amulet;
    if (am) {
      const k = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(elapsed * 1.15 + 2.1));
      am.glow.style.opacity = k.toFixed(3);
    }
  }

  dispose() { }

  /* ============================================================== painting */

  /**
   * The paper doll: a front-facing figure in equipped plate, standing in a
   * shallow lit niche.
   *
   * Round 1 failed this twice over — "an unlit dark blue-grey blob with a black
   * bucket head and a flat maroon torso". Two separate problems, fixed here in
   * two separate ways.
   *
   * ANATOMY. The figure is articulated harness, not a gingerbread outline: helm,
   * gorget, pauldron over rerebrace, couter, vambrace, gauntlet; breastplate that
   * narrows to a real waist; a fauld of lames over the hips with tassets hanging
   * from it; cuisse, poleyn, greave, sabaton. The waist and the shoulder overhang
   * are what give the silhouette a readable human shape at 230 px.
   *
   * LIGHT. One key at the upper left, one cool rim from behind-right, one warm
   * bounce off the panel's leather below. Every plate gets a diffuse ramp along
   * the key axis, a hard specular where its crown turns into the light, an
   * occluded contour on the far side, a warm bounce creeping up its underside,
   * and a cool rim on its right silhouette. The niche behind supplies the value
   * contrast the silhouette reads against, and the figure casts into it.
   */
  _paintDoll(ctx0, w, h) {
    /* `ctx` is reassigned part-way through: the niche is painted straight
       onto the element's canvas, then the FIGURE is painted onto a layer of
       its own so one coherent key/shade/bounce can be applied across the
       whole harness and one cast shadow taken off its silhouette. Shading
       twenty plates independently, each with its own full-range ramp, is
       what averages out to a single flat grey no matter how much specular
       each piece carries. */
    let ctx = ctx0;
    const cx = w * 0.5;
    /* normalised body space: X is a fraction of the figure's shoulder span,
       Y is 0 at the feet and 1 at the top of the helm */
    const HX = w * 0.50;                       // half-width available
    const X = (v) => cx + v * HX;
    const Y = (v) => h * (0.965 - v * 0.930);
    const L = Math.min(w, h * 0.42);           // line-weight reference
    const A = this.atlas;
    const TAU = Math.PI * 2;

    /* how much key light reaches a point — the source is up and to the left of
       the figure, close enough that the far shoulder falls off noticeably */
    const key = (px, py) => {
      const dx = (px - w * 0.10) / w, dy = (py - h * 0.00) / h;
      return clamp01(1.10 - Math.sqrt(dx * dx * 0.60 + dy * dy * 0.32) * 1.02);
    };
    const bbox = (x0, y0, x1, y1) => ({
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0) || 1, h: Math.abs(y1 - y0) || 1,
    });
    const lw = (k) => Math.max(0.8, L * k);

    /* --- materials. Polished harness steel: a genuine near-white crown, a long
       mid, and a crevice that goes to true black. The round-1 version topped out
       around 0.62 which is why it read as unlit. --- */
    const IRON = (x0, y0, x1, y1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      /* the crown of a polished plate holds near-white over real AREA — the
         previous ramp spent only 8% of its length above mid, so a 40 px pauldron
         had four bright pixels and the harness averaged to one flat grey */
      g.addColorStop(0, '#f2f6fb');
      g.addColorStop(0.10, '#c3cddb');
      g.addColorStop(0.22, '#8994a3');
      g.addColorStop(0.40, '#4f5966');
      g.addColorStop(0.62, '#252d36');
      g.addColorStop(0.82, '#0d1216');
      g.addColorStop(1, '#030508');
      return g;
    };
    /* blued/darkened steel for the pieces that must sit BACK from the front
       plates, so the harness has two metals rather than one flat value */
    const BLUE = (x0, y0, x1, y1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#7b8698');
      g.addColorStop(0.14, '#454f5c');
      g.addColorStop(0.44, '#20272f');
      g.addColorStop(0.76, '#0c1014');
      g.addColorStop(1, '#020407');
      return g;
    };
    const GOLD = (x0, y0, x1, y1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#fff4cf');
      g.addColorStop(0.20, '#e0bb69');
      g.addColorStop(0.52, '#9a742b');
      g.addColorStop(0.82, '#4c380f');
      g.addColorStop(1, '#1b1206');
      return g;
    };
    const LEATH = (x0, y0, x1, y1) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, '#8a6a44');
      g.addColorStop(0.30, '#4a3520');
      g.addColorStop(0.70, '#241a0e');
      g.addColorStop(1, '#0a0705');
      return g;
    };
    const edge = (p, k = 1.2) => {
      ctx.lineWidth = lw(k * 0.006);
      ctx.strokeStyle = 'rgba(2,3,5,0.94)';
      ctx.stroke(p);
    };
    /** Cool rim from behind-right: stroke offset LEFT survives on the right
        contour only, which is what separates the figure from the niche. */
    const rim = (p, a = 0.5, k = 0.010, col = '190,208,232') => {
      const d = Math.max(0.8, L * k * 0.62);
      ctx.save();
      ctx.clip(p);
      ctx.lineWidth = Math.max(1, L * k);
      ctx.translate(-d, -d * 0.22);
      ctx.strokeStyle = `rgba(${col},${a.toFixed(3)})`;
      ctx.stroke(p);
      ctx.restore();
    };
    /** Contact occlusion for a piece that overlaps another. Filled black with a
        blurred offset shadow *before* the piece itself is painted, so only the
        halo outside the silhouette survives. Without this every plate reads as
        a decal lying in the same plane. */
    const occlude = (p, a = 0.62, blur = 0.024, ox = 0.006, oy = 0.011) => {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${a})`;
      ctx.shadowBlur = Math.max(2, L * blur);
      ctx.shadowOffsetX = L * ox;
      ctx.shadowOffsetY = L * oy;
      ctx.fillStyle = 'rgba(0,0,0,0.98)';
      ctx.fill(p);
      ctx.restore();
    };
    /** Warm bounce off the panel below: stroke offset UP survives on the
        underside contour. */
    const bounce = (p, a = 0.34, k = 0.010) => {
      const d = Math.max(0.8, L * k * 0.7);
      ctx.save();
      ctx.clip(p);
      ctx.lineWidth = Math.max(1, L * k);
      ctx.translate(0, -d);
      ctx.strokeStyle = `rgba(226,186,124,${a.toFixed(3)})`;
      ctx.stroke(p);
      ctx.restore();
    };

    /**
     * One armour plate, shaded as a real object.
     * `x0,y0` is the corner nearest the light, `x1,y1` the corner furthest from
     * it, which is also the diffuse ramp's axis.
     */
    const plate = (p, x0, y0, x1, y1, mat, o = {}) => {
      const box = bbox(x0, y0, x1, y1);
      const k = key((x0 + x1) * 0.5, (y0 + y1) * 0.5);
      ctx.save(); ctx.clip(p);
      ctx.fillStyle = (mat ?? IRON)(box.x, box.y, box.x + box.w, box.y + box.h);
      ctx.fillRect(0, 0, w, h);
      /* forged surface: planishing at the plate's own scale, then the same field
         screened so every dent carries a highlight instead of only a pit */
      A.layer(ctx, 'hammer', { seed: 7, mode: 'overlay', alpha: 0.30, scale: 0.16 });
      A.layer(ctx, 'hammer', { seed: 7, mode: 'screen', alpha: 0.13 * k, scale: 0.16 });
      A.layer(ctx, 'tarnish', { seed: 11, mode: 'multiply', alpha: 0.42, scale: 1.1 });
      A.layer(ctx, 'craze', { seed: 23, mode: 'multiply', alpha: 0.22, scale: 0.7 });
      /* broad anisotropic polish lobe across the crown of the plate */
      if (o.spec !== false) {
        A.sheen(ctx, null, box, {
          a: (o.gloss ?? 0.50) * (0.58 + 0.42 * k), r: 0.46, squash: 0.28,
          cx: o.sx ?? 0.26, cy: o.sy ?? 0.20, rot: o.srot ?? -0.6,
        });
      }
      /* a light held-back term for pieces the caller wants sitting further from
         the key; the global falloff itself is applied to the whole figure layer */
      const drop = clamp01(1 - (0.80 + 0.20 * k) * (o.dim ?? 1));
      if (drop > 0.004) {
        ctx.fillStyle = `rgba(5,7,11,${drop.toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
      edge(p);
      /* the chamfer: hard catch-light on the lit contour, occluded on the far one */
      A.edgeBevel(ctx, p, box, {
        width: Math.max(1.2, L * (o.bev ?? 0.012)),
        offset: Math.max(0.7, L * (o.bev ?? 0.012) * 0.5),
        hiA: (o.hiA ?? 0.98) * k, loA: 0.88,
      });
      /* bounce and rim are OPT-IN. A warm underside plus a cool right contour on
         every one of twenty plates outlines all of them equally, and the figure
         goes back to reading as a sheet of stickers. They belong only where the
         piece is actually on the figure's silhouette. */
      if (o.bounce) bounce(p, (o.bounceA ?? 0.30), o.bev ?? 0.010);
      if (o.rim) rim(p, (o.rimA ?? 0.46) * (o.rimK ?? 1), o.bev ?? 0.010);
      /* the hotspot — the pixel that says "polished steel" not "grey shape" */
      if (o.hot !== false) {
        const hx = lerp(box.x, box.x + box.w, o.hotX ?? 0.26);
        const hy = lerp(box.y, box.y + box.h, o.hotY ?? 0.20);
        ctx.save(); ctx.clip(p);
        A.hotSpot(ctx, hx, hy, Math.max(2, box.w * (o.hotR ?? 0.30) * 0.72), {
          a: Math.min(1, (o.hotA ?? 0.98) * (0.62 + 0.38 * k)), squash: o.hotSq ?? 0.40,
          rot: o.srot ?? -0.6, coreR: 0.40,
        });
        ctx.restore();
      }
    };
    /** A gold fitting: leaf body, dark cut, hard crest, and a star glint. */
    const goldPlate = (p, x0, y0, x1, y1, o = {}) => {
      const box = bbox(x0, y0, x1, y1);
      ctx.save(); ctx.clip(p);
      ctx.fillStyle = GOLD(box.x, box.y, box.x + box.w, box.y + box.h);
      ctx.fillRect(0, 0, w, h);
      A.layer(ctx, 'hammer', { seed: 19, mode: 'overlay', alpha: 0.26, scale: 0.12 });
      A.layer(ctx, 'tarnish', { seed: 31, mode: 'multiply', alpha: 0.34, scale: 0.8 });
      A.sheen(ctx, null, box, { a: 0.42, r: 0.66, squash: 0.30, cx: 0.26, cy: 0.20, tint: '255,241,199' });
      ctx.restore();
      edge(p, 0.8);
      A.edgeBevel(ctx, p, box, {
        width: Math.max(1, L * (o.bev ?? 0.009)), offset: Math.max(0.6, L * 0.005),
        hi: '255,241,199', hiA: 0.99, loA: 0.72,
      });
      if (o.glint !== false) {
        ctx.save(); ctx.clip(p);
        A.glint(ctx, lerp(box.x, box.x + box.w, o.gx ?? 0.30),
          lerp(box.y, box.y + box.h, o.gy ?? 0.28),
          Math.max(3, Math.max(box.w, box.h) * (o.gr ?? 0.34)),
          { a: 0.86, tint: '255,241,199', rot: -0.5 });
        ctx.restore();
      }
    };

    ctx.save();
    ctx.lineJoin = 'round';

    /* ================= the niche the figure stands in ================= */
    /* A shallow arched recess with a FLOOR: the round-1 version stopped at a
       hard horizontal line across the bottom of the canvas, which is the
       "hard geometric intersection" instant-fail. */
    const nx0 = X(-0.74), nx1 = X(0.74);
    const nTop = Y(1.075), nFloor = Y(0.035);
    const niche = new Path2D();
    niche.moveTo(nx0, Y(-0.10));
    niche.lineTo(nx0, Y(0.68));
    niche.bezierCurveTo(nx0, Y(0.98), X(-0.34), nTop, cx, nTop);
    niche.bezierCurveTo(X(0.34), nTop, nx1, Y(0.98), nx1, Y(0.68));
    niche.lineTo(nx1, Y(-0.10));
    niche.closePath();
    const nb = { x: nx0, y: nTop, w: nx1 - nx0, h: Y(-0.10) - nTop };
    ctx.save();
    ctx.clip(niche);
    A.material(ctx, nb.x, nb.y, nb.w, nb.h, 'stone', { seed: 91, scale: 0.42, spec: 0.3 });
    A.layer(ctx, 'relief', { seed: RELIEF_SEED, mode: 'overlay', alpha: 0.30, scale: 0.8, offX: 61, offY: 17 });
    /* the pool of key light on the back wall, everything else to black */
    const np = ctx.createRadialGradient(X(-0.44), Y(0.92), 0, X(-0.22), Y(0.64), (nx1 - nx0) * 0.86);
    np.addColorStop(0, 'rgba(255,224,168,0.30)');
    np.addColorStop(0.28, 'rgba(186,158,118,0.09)');
    np.addColorStop(1, 'rgba(0,0,0,0.86)');
    ctx.fillStyle = np; ctx.fillRect(0, 0, w, h);
    /* the figure's shadow thrown on the wall, down-right of the key */
    const wall = ctx.createRadialGradient(X(0.26), Y(0.50), 0, X(0.24), Y(0.46), (nx1 - nx0) * 0.56);
    wall.addColorStop(0, 'rgba(0,0,0,0.56)');
    wall.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = wall; ctx.fillRect(0, 0, w, h);
    /* --- the floor: a flagstone plinth in perspective, so the recess has a
       bottom the figure can stand on rather than terminating in a cut line */
    const floor = new Path2D();
    floor.moveTo(nx0, nFloor);
    floor.bezierCurveTo(X(-0.30), Y(0.012), X(0.30), Y(0.012), nx1, nFloor);
    floor.lineTo(nx1, Y(-0.10));
    floor.lineTo(nx0, Y(-0.10));
    floor.closePath();
    ctx.save();
    ctx.clip(floor);
    A.material(ctx, nb.x, nFloor, nb.w, Y(-0.10) - nFloor, 'stone', { seed: 47, scale: 0.30, spec: 0.5 });
    const fg = ctx.createLinearGradient(0, nFloor, 0, Y(-0.10));
    fg.addColorStop(0, 'rgba(216,190,150,0.20)');
    fg.addColorStop(0.35, 'rgba(0,0,0,0.30)');
    fg.addColorStop(1, 'rgba(0,0,0,0.86)');
    ctx.fillStyle = fg; ctx.fillRect(0, 0, w, h);
    ctx.restore();
    /* the wall/floor junction catches a hard line of light */
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(nx0, nFloor);
    ctx.bezierCurveTo(X(-0.30), Y(0.012), X(0.30), Y(0.012), nx1, nFloor);
    ctx.lineWidth = lw(0.006);
    const jl = ctx.createLinearGradient(nx0, 0, nx1, 0);
    jl.addColorStop(0, 'rgba(255,232,182,0.55)');
    jl.addColorStop(0.5, 'rgba(224,196,150,0.24)');
    jl.addColorStop(1, 'rgba(150,140,120,0.06)');
    ctx.strokeStyle = jl; ctx.stroke();
    ctx.restore();
    ctx.restore();
    /* the niche is SUNK: its up-left inner face is occluded, its down-right lip
       catches the bounce */
    A.edgeBevel(ctx, niche, nb, {
      mode: 'inset', width: Math.max(2, L * 0.024), loA: 0.95, hiA: 0.44,
    });

    /* ---- contact shadow under the figure ---- */
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, Y(0.004), w * 0.26, h * 0.020, 0, 0, TAU);
    const sg = ctx.createRadialGradient(cx, Y(0.004), 0, cx, Y(0.004), w * 0.26);
    sg.addColorStop(0, 'rgba(0,0,0,0.92)');
    sg.addColorStop(0.55, 'rgba(0,0,0,0.52)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg; ctx.fill();
    /* ...and the long cast shadow raking away from the key, down-right */
    ctx.beginPath();
    ctx.ellipse(X(0.20), Y(0.012), w * 0.30, h * 0.026, -0.10, 0, TAU);
    const sg2 = ctx.createRadialGradient(X(0.20), Y(0.012), 0, X(0.20), Y(0.012), w * 0.30);
    sg2.addColorStop(0, 'rgba(0,0,0,0.62)');
    sg2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg2; ctx.fill();
    ctx.restore();

    /* ============ everything from here is drawn on the FIGURE layer ========= */
    const figC = document.createElement('canvas');
    figC.width = Math.max(1, Math.round(w));
    figC.height = Math.max(1, Math.round(h));
    const figX = figC.getContext('2d');
    figX.lineJoin = 'round';
    ctx = figX;

    /* ================= cloak, behind everything ================= */
    const cloak = new Path2D();
    cloak.moveTo(X(-0.26), Y(0.845));
    cloak.bezierCurveTo(X(-0.56), Y(0.66), X(-0.58), Y(0.28), X(-0.44), Y(0.055));
    cloak.bezierCurveTo(X(-0.20), Y(0.020), X(0.20), Y(0.020), X(0.44), Y(0.055));
    cloak.bezierCurveTo(X(0.58), Y(0.28), X(0.56), Y(0.66), X(0.26), Y(0.845));
    cloak.closePath();
    ctx.save();
    ctx.clip(cloak);
    const cg = ctx.createLinearGradient(X(-0.6), Y(0.9), X(0.5), Y(0.0));
    cg.addColorStop(0, '#23222a');
    cg.addColorStop(0.30, '#14141a');
    cg.addColorStop(0.72, '#0a0a0e');
    cg.addColorStop(1, '#040407');
    ctx.fillStyle = cg; ctx.fillRect(0, 0, w, h);
    A.layer(ctx, 'crease', { seed: 211, mode: 'overlay', alpha: 0.40, scale: 1.5 });
    A.layer(ctx, 'grain', { seed: 3, mode: 'overlay', alpha: 0.22, scale: 0.6 });
    /* folds: a cut shadow in each valley and a sheen on the ridge beside it, so
       the wool has cylindrical form instead of being a striped fill. Widths vary
       so the drape does not read as a comb. */
    const FOLD = [-0.90, -0.62, -0.38, -0.14, 0.10, 0.34, 0.58, 0.86];
    for (let i = 0; i < FOLD.length; i++) {
      const f = FOLD[i];
      const x0 = X(f * 0.30), x1 = X(f * 0.44);
      const kk = key(x0, Y(0.42));
      ctx.beginPath();
      ctx.moveTo(x0, Y(0.82));
      ctx.quadraticCurveTo(X(f * 0.36), Y(0.42), x1, Y(0.045));
      ctx.lineWidth = lw(0.013 + 0.004 * (i % 3));
      ctx.strokeStyle = 'rgba(0,0,0,0.66)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0 - L * 0.011, Y(0.82));
      ctx.quadraticCurveTo(X(f * 0.36) - L * 0.011, Y(0.42), x1 - L * 0.011, Y(0.045));
      ctx.lineWidth = lw(0.0055);
      ctx.strokeStyle = `rgba(206,196,214,${(0.34 * kk).toFixed(3)})`; ctx.stroke();
    }
    /* frayed, dusty hem */
    const hem = ctx.createLinearGradient(0, Y(0.16), 0, Y(0.015));
    hem.addColorStop(0, 'rgba(0,0,0,0)');
    hem.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = hem; ctx.fillRect(0, Y(0.16), w, Y(0.015) - Y(0.16));
    ctx.restore();
    edge(cloak, 0.9);
    rim(cloak, 0.42, 0.010, '176,196,224');
    A.edgeBevel(ctx, cloak, bbox(X(-0.58), Y(0.85), X(0.58), Y(0.02)), {
      width: lw(0.010), hi: '212,204,222', hiA: 0.58, loA: 0.9,
    });

    /* ================= legs ================= */
    for (const s of [-1, 1]) {
      const far = s > 0 ? 0.72 : 1;      // the figure's left leg is away from the key
      /* cuisse — thigh plate, wide at the hip, narrowing to the knee */
      const th = new Path2D();
      th.moveTo(X(s * 0.055), Y(0.470));
      th.lineTo(X(s * 0.245), Y(0.470));
      th.bezierCurveTo(X(s * 0.235), Y(0.400), X(s * 0.215), Y(0.330), X(s * 0.200), Y(0.290));
      th.lineTo(X(s * 0.072), Y(0.290));
      th.bezierCurveTo(X(s * 0.068), Y(0.340), X(s * 0.060), Y(0.410), X(s * 0.055), Y(0.470));
      th.closePath();
      plate(th, X(s * 0.05), Y(0.475), X(s * 0.25), Y(0.285), IRON, {
        gloss: 0.44, hotX: 0.32, hotY: 0.26, hotR: 0.34, hotSq: 0.34, rimK: far, dim: 0.90,
      });
      /* poleyn — the knee cop, a domed disc with its own wing */
      const kn = new Path2D();
      kn.moveTo(X(s * 0.062), Y(0.298));
      kn.bezierCurveTo(X(s * 0.090), Y(0.330), X(s * 0.196), Y(0.330), X(s * 0.214), Y(0.298));
      kn.bezierCurveTo(X(s * 0.220), Y(0.252), X(s * 0.196), Y(0.226), X(s * 0.138), Y(0.226));
      kn.bezierCurveTo(X(s * 0.082), Y(0.226), X(s * 0.058), Y(0.252), X(s * 0.062), Y(0.298));
      kn.closePath();
      occlude(kn, 0.66, 0.020);
      plate(kn, X(s * 0.06), Y(0.335), X(s * 0.22), Y(0.222), IRON, {
        gloss: 0.62, hotX: 0.34, hotY: 0.30, hotR: 0.32, hotSq: 0.44, bev: 0.014, rimK: far,
      });
      /* greave — shin, tapering to the ankle */
      const gr = new Path2D();
      gr.moveTo(X(s * 0.072), Y(0.232));
      gr.lineTo(X(s * 0.204), Y(0.232));
      gr.bezierCurveTo(X(s * 0.196), Y(0.170), X(s * 0.182), Y(0.120), X(s * 0.176), Y(0.082));
      gr.lineTo(X(s * 0.086), Y(0.082));
      gr.bezierCurveTo(X(s * 0.082), Y(0.120), X(s * 0.076), Y(0.170), X(s * 0.072), Y(0.232));
      gr.closePath();
      plate(gr, X(s * 0.07), Y(0.235), X(s * 0.21), Y(0.078), IRON, {
        gloss: 0.40, hotX: 0.30, hotY: 0.24, hotR: 0.26, hotSq: 0.26, rimK: far, rim: true, bounce: true, bounceA: 0.24,
      });
      /* sabaton — a foot, with a toe: the round-1 trapezoid read as a block */
      const sb = new Path2D();
      sb.moveTo(X(s * 0.082), Y(0.088));
      sb.lineTo(X(s * 0.182), Y(0.088));
      sb.bezierCurveTo(X(s * 0.212), Y(0.062), X(s * 0.246), Y(0.030), X(s * 0.238), Y(0.010));
      sb.lineTo(X(s * 0.056), Y(0.010));
      sb.bezierCurveTo(X(s * 0.056), Y(0.040), X(s * 0.070), Y(0.068), X(s * 0.082), Y(0.088));
      sb.closePath();
      occlude(sb, 0.70, 0.022, 0.005, 0.008);
      plate(sb, X(s * 0.05), Y(0.090), X(s * 0.25), Y(0.008), IRON, {
        gloss: 0.34, hotX: 0.28, hotY: 0.28, hotR: 0.24, hotSq: 0.30, rimK: far, rim: true, bounce: true, bounceA: 0.46,
      });
      /* the lames across the toe */
      ctx.save(); ctx.clip(sb);
      for (const t of [0.34, 0.62]) {
        const yy = lerp(0.082, 0.020, t);
        ctx.beginPath();
        ctx.moveTo(X(s * 0.062), Y(yy));
        ctx.lineTo(X(s * 0.225), Y(yy - 0.006));
        ctx.lineWidth = lw(0.008); ctx.strokeStyle = 'rgba(0,0,0,0.62)'; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X(s * 0.062), Y(yy) - Math.max(1.2, lw(0.011)));
        ctx.lineTo(X(s * 0.225), Y(yy - 0.006) - Math.max(1.2, lw(0.011)));
        ctx.lineWidth = Math.max(1.4, lw(0.011));
        ctx.strokeStyle = 'rgba(244,250,255,0.82)'; ctx.stroke();
      }
      ctx.restore();
    }

    /* ================= arms ================= */
    for (const s of [-1, 1]) {
      const far = s > 0 ? 0.70 : 1;
      /* rerebrace — upper arm, blued so it sits behind the pauldron */
      const up = new Path2D();
      up.moveTo(X(s * 0.300), Y(0.790));
      up.bezierCurveTo(X(s * 0.400), Y(0.782), X(s * 0.428), Y(0.720), X(s * 0.420), Y(0.648));
      up.lineTo(X(s * 0.318), Y(0.628));
      up.bezierCurveTo(X(s * 0.320), Y(0.700), X(s * 0.308), Y(0.752), X(s * 0.300), Y(0.790));
      up.closePath();
      plate(up, X(s * 0.30), Y(0.795), X(s * 0.43), Y(0.625), BLUE, {
        gloss: 0.40, hotX: 0.32, hotY: 0.28, hotR: 0.28, hotSq: 0.32, bev: 0.010, rimK: far, dim: 0.86, rim: true,
      });
      /* couter — the elbow cup */
      const el = new Path2D();
      el.moveTo(X(s * 0.312), Y(0.640));
      el.bezierCurveTo(X(s * 0.342), Y(0.664), X(s * 0.428), Y(0.660), X(s * 0.436), Y(0.630));
      el.bezierCurveTo(X(s * 0.442), Y(0.586), X(s * 0.412), Y(0.564), X(s * 0.362), Y(0.566));
      el.bezierCurveTo(X(s * 0.318), Y(0.568), X(s * 0.304), Y(0.600), X(s * 0.312), Y(0.640));
      el.closePath();
      occlude(el, 0.62, 0.018);
      plate(el, X(s * 0.30), Y(0.668), X(s * 0.44), Y(0.562), IRON, {
        gloss: 0.66, hotX: 0.34, hotY: 0.32, hotR: 0.34, hotSq: 0.48, bev: 0.013, rimK: far, rim: true,
      });
      /* vambrace — forearm */
      const fo = new Path2D();
      fo.moveTo(X(s * 0.310), Y(0.572));
      fo.lineTo(X(s * 0.428), Y(0.572));
      fo.bezierCurveTo(X(s * 0.420), Y(0.520), X(s * 0.408), Y(0.470), X(s * 0.402), Y(0.440));
      fo.lineTo(X(s * 0.322), Y(0.440));
      fo.bezierCurveTo(X(s * 0.318), Y(0.470), X(s * 0.314), Y(0.520), X(s * 0.310), Y(0.572));
      fo.closePath();
      plate(fo, X(s * 0.31), Y(0.575), X(s * 0.43), Y(0.436), IRON, {
        gloss: 0.44, hotX: 0.30, hotY: 0.24, hotR: 0.26, hotSq: 0.28, rimK: far, rim: true,
      });
      /* gauntlet — cuff, then a fist */
      const gu = new Path2D();
      gu.moveTo(X(s * 0.312), Y(0.446));
      gu.lineTo(X(s * 0.416), Y(0.446));
      gu.bezierCurveTo(X(s * 0.424), Y(0.404), X(s * 0.412), Y(0.362), X(s * 0.372), Y(0.354));
      gu.bezierCurveTo(X(s * 0.330), Y(0.348), X(s * 0.302), Y(0.382), X(s * 0.312), Y(0.446));
      gu.closePath();
      occlude(gu, 0.62, 0.018);
      plate(gu, X(s * 0.30), Y(0.450), X(s * 0.43), Y(0.350), IRON, {
        gloss: 0.56, hotX: 0.32, hotY: 0.30, hotR: 0.30, hotSq: 0.40, bev: 0.013, rimK: far, rim: true, bounce: true, bounceA: 0.26,
      });
      /* knuckle lames */
      ctx.save(); ctx.clip(gu);
      for (const t of [0.30, 0.56]) {
        const yy = lerp(0.442, 0.360, t);
        ctx.beginPath();
        ctx.moveTo(X(s * 0.300), Y(yy)); ctx.lineTo(X(s * 0.424), Y(yy - 0.004));
        ctx.lineWidth = lw(0.008); ctx.strokeStyle = 'rgba(0,0,0,0.58)'; ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X(s * 0.300), Y(yy) - Math.max(1.2, lw(0.011)));
        ctx.lineTo(X(s * 0.424), Y(yy - 0.004) - Math.max(1.2, lw(0.011)));
        ctx.lineWidth = Math.max(1.4, lw(0.011));
        ctx.strokeStyle = 'rgba(242,248,255,0.80)'; ctx.stroke();
      }
      ctx.restore();
    }

    /* ================= cuirass ================= */
    /* Wide at the chest, a real waist at 0.60, then the fauld flares over the
       hips. The waist is the single most important line in the silhouette. */
    const torso = new Path2D();
    torso.moveTo(X(-0.185), Y(0.842));
    torso.lineTo(X(0.185), Y(0.842));
    torso.bezierCurveTo(X(0.300), Y(0.822), X(0.335), Y(0.760), X(0.322), Y(0.700));
    torso.bezierCurveTo(X(0.310), Y(0.652), X(0.262), Y(0.618), X(0.208), Y(0.600));
    torso.lineTo(X(-0.208), Y(0.600));
    torso.bezierCurveTo(X(-0.262), Y(0.618), X(-0.310), Y(0.652), X(-0.322), Y(0.700));
    torso.bezierCurveTo(X(-0.335), Y(0.760), X(-0.300), Y(0.822), X(-0.185), Y(0.842));
    torso.closePath();
    occlude(torso, 0.80, 0.040, 0.010, 0.016);
    plate(torso, X(-0.33), Y(0.845), X(0.33), Y(0.598), IRON, {
      gloss: 0.56, hotX: 0.28, hotY: 0.24, hotR: 0.24, hotSq: 0.50, bev: 0.016, rim: true, rimA: 0.34,
    });
    /* pectoral lames — rolled bands, so each gets a cut groove below and a hard
       catch-light on the roll above. They taper toward the waist. */
    ctx.save();
    ctx.clip(torso);
    for (const [yy, hw] of [[0.790, 0.325], [0.740, 0.330], [0.690, 0.322], [0.645, 0.290], [0.616, 0.245]]) {
      /* the catch-light on a rolled lame has to be authored at ≥1.5 device px or
         it antialiases to a 40%-grey line and the plate reads unpolished. At this
         panel size L is ~127 px, so 0.0058·L was 0.7 px — invisible as specular. */
      const off = Math.max(1.4, L * 0.013);
      ctx.beginPath();
      ctx.moveTo(X(-hw), Y(yy));
      ctx.quadraticCurveTo(cx, Y(yy - 0.016), X(hw), Y(yy));
      ctx.lineWidth = lw(0.016);
      ctx.strokeStyle = 'rgba(0,0,0,0.74)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(-hw), Y(yy) - off);
      ctx.quadraticCurveTo(cx, Y(yy - 0.016) - off, X(hw), Y(yy) - off);
      ctx.lineWidth = Math.max(1.6, lw(0.015));
      const lgg = ctx.createLinearGradient(X(-hw), 0, X(hw), 0);
      lgg.addColorStop(0, 'rgba(252,254,255,0.96)');
      lgg.addColorStop(0.34, 'rgba(232,241,252,0.52)');
      lgg.addColorStop(0.72, 'rgba(190,206,226,0.16)');
      lgg.addColorStop(1, 'rgba(150,170,196,0.05)');
      ctx.strokeStyle = lgg; ctx.stroke();
    }
    /* the medial keel: a raised ridge down the breastplate, NOT a painted stripe.
       Dark cut on its shadow side, hard crest on its lit side. */
    ctx.beginPath();
    ctx.moveTo(cx + lw(0.012), Y(0.836));
    ctx.lineTo(cx + lw(0.012), Y(0.606));
    ctx.lineWidth = lw(0.014);
    ctx.strokeStyle = 'rgba(0,0,0,0.66)'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - lw(0.008), Y(0.836));
    ctx.lineTo(cx - lw(0.008), Y(0.606));
    ctx.lineWidth = Math.max(1.6, lw(0.013));
    const keel = ctx.createLinearGradient(0, Y(0.836), 0, Y(0.606));
    keel.addColorStop(0, 'rgba(250,253,255,0.92)');
    keel.addColorStop(0.55, 'rgba(226,236,248,0.52)');
    keel.addColorStop(1, 'rgba(178,196,218,0.16)');
    ctx.strokeStyle = keel; ctx.stroke();
    ctx.restore();

    /* gorget — the neck defence, gold-edged, which is what removes the
       "head sitting straight on a box" read */
    const gorg = new Path2D();
    gorg.moveTo(X(-0.150), Y(0.836));
    gorg.bezierCurveTo(X(-0.120), Y(0.876), X(-0.058), Y(0.888), cx, Y(0.888));
    gorg.bezierCurveTo(X(0.058), Y(0.888), X(0.120), Y(0.876), X(0.150), Y(0.836));
    gorg.bezierCurveTo(X(0.080), Y(0.818), X(-0.080), Y(0.818), X(-0.150), Y(0.836));
    gorg.closePath();
    occlude(gorg, 0.72, 0.022);
    plate(gorg, X(-0.15), Y(0.890), X(0.15), Y(0.816), BLUE, {
      gloss: 0.46, hotX: 0.32, hotY: 0.34, hotR: 0.26, hotSq: 0.44, bev: 0.010,
    });
    const gtrim = new Path2D();
    gtrim.moveTo(X(-0.152), Y(0.838));
    gtrim.bezierCurveTo(X(-0.075), Y(0.820), X(0.075), Y(0.820), X(0.152), Y(0.838));
    gtrim.lineTo(X(0.146), Y(0.826));
    gtrim.bezierCurveTo(X(0.072), Y(0.809), X(-0.072), Y(0.809), X(-0.146), Y(0.826));
    gtrim.closePath();
    goldPlate(gtrim, X(-0.152), Y(0.840), X(0.152), Y(0.808), { gr: 0.6, gx: 0.26, gy: 0.4 });

    /* ================= pauldrons — the biggest curved plates ================= */
    for (const s of [-1, 1]) {
      const far = s > 0 ? 0.70 : 1;
      const pa = new Path2D();
      pa.moveTo(X(s * 0.150), Y(0.828));
      pa.bezierCurveTo(X(s * 0.300), Y(0.870), X(s * 0.452), Y(0.852), X(s * 0.494), Y(0.772));
      pa.bezierCurveTo(X(s * 0.500), Y(0.720), X(s * 0.462), Y(0.686), X(s * 0.406), Y(0.680));
      pa.bezierCurveTo(X(s * 0.330), Y(0.700), X(s * 0.236), Y(0.740), X(s * 0.170), Y(0.780));
      pa.closePath();
      occlude(pa, 0.80, 0.032, 0.008, 0.014);
      plate(pa, X(s * 0.15), Y(0.876), X(s * 0.50), Y(0.678), IRON, {
        gloss: 0.68, hotX: 0.40, hotY: 0.30, hotR: 0.30, hotSq: 0.32,
        hotA: 1.0, bev: 0.017, rimK: far, rimA: 0.62, rim: true,
      });
      /* three ridge lames sweeping around the cop */
      ctx.save(); ctx.clip(pa);
      for (const t of [0.30, 0.54, 0.76]) {
        const y0 = lerp(0.824, 0.700, t), y1 = lerp(0.776, 0.682, t);
        ctx.beginPath();
        ctx.moveTo(X(s * 0.160), Y(y0));
        ctx.quadraticCurveTo(X(s * 0.330), Y(y0 + 0.014), X(s * 0.492), Y(y1));
        ctx.lineWidth = lw(0.015);
        ctx.strokeStyle = 'rgba(0,0,0,0.70)'; ctx.stroke();
        const po = Math.max(1.4, lw(0.013));
        ctx.beginPath();
        ctx.moveTo(X(s * 0.160), Y(y0) - po);
        ctx.quadraticCurveTo(X(s * 0.330), Y(y0 + 0.014) - po, X(s * 0.492), Y(y1) - po);
        ctx.lineWidth = Math.max(1.7, lw(0.016));
        ctx.strokeStyle = `rgba(250,253,255,${Math.min(0.98, 0.96 * key(X(s * 0.32), Y(y0))).toFixed(3)})`;
        ctx.stroke();
      }
      ctx.restore();
      /* a gold boss at the shoulder point, with a cabochon */
      const bx = X(s * 0.415), by = Y(0.792);
      A.rivet(ctx, bx, by, Math.max(1.8, L * 0.014), 41 + s);
      A.gem(ctx, X(s * 0.300), Y(0.822), Math.max(2.2, L * 0.019), s < 0 ? '#c0392b' : '#8e2a20');
    }

    /* ================= fauld + tassets over the hips ================= */
    const fauld = new Path2D();
    fauld.moveTo(X(-0.212), Y(0.604));
    fauld.lineTo(X(0.212), Y(0.604));
    fauld.bezierCurveTo(X(0.246), Y(0.560), X(0.262), Y(0.512), X(0.256), Y(0.472));
    fauld.lineTo(X(-0.256), Y(0.472));
    fauld.bezierCurveTo(X(-0.262), Y(0.512), X(-0.246), Y(0.560), X(-0.212), Y(0.604));
    fauld.closePath();
    occlude(fauld, 0.76, 0.028);
    plate(fauld, X(-0.26), Y(0.606), X(0.26), Y(0.470), IRON, {
      gloss: 0.42, hotX: 0.26, hotY: 0.28, hotR: 0.22, hotSq: 0.36, bev: 0.013, rim: true, rimA: 0.36, bounce: true, bounceA: 0.28,
    });
    ctx.save(); ctx.clip(fauld);
    for (const yy of [0.560, 0.516]) {
      const off = Math.max(1.3, L * 0.012);
      ctx.beginPath();
      ctx.moveTo(X(-0.262), Y(yy));
      ctx.quadraticCurveTo(cx, Y(yy - 0.013), X(0.262), Y(yy));
      ctx.lineWidth = lw(0.015); ctx.strokeStyle = 'rgba(0,0,0,0.72)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(-0.262), Y(yy) - off);
      ctx.quadraticCurveTo(cx, Y(yy - 0.013) - off, X(0.262), Y(yy) - off);
      ctx.lineWidth = Math.max(1.6, lw(0.014));
      const fl = ctx.createLinearGradient(X(-0.26), 0, X(0.26), 0);
      fl.addColorStop(0, 'rgba(250,253,255,0.92)');
      fl.addColorStop(0.40, 'rgba(226,236,248,0.44)');
      fl.addColorStop(1, 'rgba(160,180,204,0.05)');
      ctx.strokeStyle = fl; ctx.stroke();
    }
    ctx.restore();

    /* ---- belt over the waist of the fauld ---- */
    const belt = new Path2D();
    belt.moveTo(X(-0.238), Y(0.498));
    belt.lineTo(X(0.238), Y(0.498));
    belt.lineTo(X(0.226), Y(0.452));
    belt.lineTo(X(-0.226), Y(0.452));
    belt.closePath();
    occlude(belt, 0.70, 0.020);
    plate(belt, X(-0.238), Y(0.500), X(0.238), Y(0.450), LEATH, {
      gloss: 0.30, hot: false, bev: 0.008, rimA: 0.30,
    });
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      A.rivet(ctx, X(i * 0.062), Y(0.4755), Math.max(1.3, L * 0.0095), 17 + i);
    }
    /* the buckle plate: gold, with the loadout's cabochon set in it */
    const bk = new Path2D();
    bk.moveTo(X(-0.058), Y(0.505));
    bk.lineTo(X(0.058), Y(0.505));
    bk.lineTo(X(0.050), Y(0.445));
    bk.lineTo(X(-0.050), Y(0.445));
    bk.closePath();
    goldPlate(bk, X(-0.058), Y(0.508), X(0.058), Y(0.443), { glint: false, bev: 0.008 });
    A.gem(ctx, cx, Y(0.4755), Math.max(2.6, L * 0.023), '#c0392b');

    /* tassets hanging from the fauld over each thigh */
    for (const s of [-1, 1]) {
      const far = s > 0 ? 0.70 : 1;
      const ta = new Path2D();
      ta.moveTo(X(s * 0.070), Y(0.474));
      ta.lineTo(X(s * 0.248), Y(0.474));
      ta.bezierCurveTo(X(s * 0.246), Y(0.436), X(s * 0.234), Y(0.400), X(s * 0.216), Y(0.386));
      ta.lineTo(X(s * 0.086), Y(0.386));
      ta.bezierCurveTo(X(s * 0.078), Y(0.410), X(s * 0.072), Y(0.444), X(s * 0.070), Y(0.474));
      ta.closePath();
      occlude(ta, 0.72, 0.024);
      plate(ta, X(s * 0.07), Y(0.476), X(s * 0.25), Y(0.384), IRON, {
        gloss: 0.46, hotX: 0.30, hotY: 0.28, hotR: 0.26, hotSq: 0.32, bev: 0.012, rimK: far,
      });
    }

    /* ================= helm ================= */
    /* A bascinet: a domed skull that comes to a slight point, a brow reinforce,
       a sight, and a cheek line. Not a bucket. */
    const helm = new Path2D();
    helm.moveTo(X(-0.118), Y(0.884));
    helm.bezierCurveTo(X(-0.132), Y(0.936), X(-0.112), Y(0.986), X(-0.030), Y(1.000));
    helm.bezierCurveTo(X(0.010), Y(1.004), X(0.084), Y(0.994), X(0.116), Y(0.958));
    helm.bezierCurveTo(X(0.132), Y(0.930), X(0.130), Y(0.902), X(0.118), Y(0.884));
    helm.bezierCurveTo(X(0.060), Y(0.868), X(-0.060), Y(0.868), X(-0.118), Y(0.884));
    helm.closePath();
    occlude(helm, 0.80, 0.030, 0.008, 0.014);
    plate(helm, X(-0.13), Y(1.005), X(0.13), Y(0.866), IRON, {
      gloss: 0.78, hotX: 0.32, hotY: 0.22, hotR: 0.32, hotSq: 0.54, hotA: 1.0, bev: 0.016,
      rimA: 0.68, rim: true,
    });
    ctx.save();
    ctx.clip(helm);
    /* the skull's long specular band — a polished bascinet carries a vertical
       highlight over the dome, not a single dot */
    A.sheen(ctx, null, bbox(X(-0.13), Y(1.00), X(0.13), Y(0.866)), {
      a: 0.60, r: 0.46, squash: 0.42, cx: 0.30, cy: 0.30, rot: -1.24,
    });
    /* brow reinforce */
    ctx.beginPath();
    ctx.moveTo(X(-0.122), Y(0.944));
    ctx.quadraticCurveTo(cx, Y(0.966), X(0.122), Y(0.944));
    ctx.lineWidth = lw(0.011); ctx.strokeStyle = 'rgba(0,0,0,0.60)'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(-0.122), Y(0.947));
    ctx.quadraticCurveTo(cx, Y(0.969), X(0.122), Y(0.947));
    ctx.lineWidth = lw(0.0055);
    ctx.strokeStyle = 'rgba(246,250,255,0.78)'; ctx.stroke();
    /* the sight: a cut slot with a hard lit upper lip and a warm ember inside */
    ctx.beginPath();
    ctx.moveTo(X(-0.104), Y(0.930));
    ctx.lineTo(X(0.104), Y(0.930));
    ctx.lineTo(X(0.086), Y(0.904));
    ctx.lineTo(X(-0.086), Y(0.904));
    ctx.closePath();
    ctx.fillStyle = '#03050a'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(-0.107), Y(0.9325)); ctx.lineTo(X(0.107), Y(0.9325));
    ctx.lineWidth = lw(0.0058);
    const vl = ctx.createLinearGradient(X(-0.11), 0, X(0.11), 0);
    vl.addColorStop(0, 'rgba(252,254,255,0.96)');
    vl.addColorStop(0.5, 'rgba(226,236,248,0.46)');
    vl.addColorStop(1, 'rgba(170,190,214,0.10)');
    ctx.strokeStyle = vl; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(-0.086), Y(0.902)); ctx.lineTo(X(0.086), Y(0.902));
    ctx.lineWidth = lw(0.0048); ctx.strokeStyle = 'rgba(214,120,48,0.42)'; ctx.stroke();
    for (const s of [-1, 1]) {
      const ex = X(s * 0.044), ey = Y(0.918);
      const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, Math.max(2.4, L * 0.022));
      eg.addColorStop(0, 'rgba(255,222,158,0.98)');
      eg.addColorStop(0.34, 'rgba(240,150,58,0.52)');
      eg.addColorStop(1, 'rgba(200,90,20,0)');
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(2.4, L * 0.022), 0, TAU);
      ctx.fillStyle = eg; ctx.fill();
    }
    /* cheek line, so the lower half of the helm is not a blank field */
    ctx.beginPath();
    ctx.moveTo(X(-0.096), Y(0.898));
    ctx.quadraticCurveTo(cx, Y(0.874), X(0.096), Y(0.898));
    ctx.lineWidth = lw(0.0055); ctx.strokeStyle = 'rgba(0,0,0,0.44)'; ctx.stroke();
    ctx.restore();
    /* the crest — a gold comb over the dome, the brightest metal on the figure */
    const crest = new Path2D();
    crest.moveTo(X(-0.020), Y(1.002));
    crest.bezierCurveTo(X(0.004), Y(1.010), X(0.026), Y(0.998), X(0.030), Y(0.972));
    crest.bezierCurveTo(X(0.032), Y(0.938), X(0.020), Y(0.906), cx, Y(0.884));
    crest.bezierCurveTo(X(-0.016), Y(0.912), X(-0.024), Y(0.950), X(-0.020), Y(1.002));
    crest.closePath();
    goldPlate(crest, X(-0.026), Y(1.012), X(0.032), Y(0.880), { gr: 0.5, gx: 0.32, gy: 0.24, bev: 0.008 });
    /* the helm's own contour rim against the niche */
    A.edgeBevel(ctx, helm, bbox(X(-0.13), Y(1.00), X(0.13), Y(0.866)), {
      width: lw(0.0065), offset: 0.6, hiA: 1.0, loA: 0.5,
    });

    /* ================= global lighting over the whole harness ================
       Three terms, each masked to the figure with `source-atop` so none of them
       touches the niche: the key pooling on the near shoulder and hip, the shade
       sweeping in from behind-right, and the warm bounce off the panel's leather
       coming back up under the fauld and the sabatons. This is the pass that
       turns twenty separately-shaded plates into one lit figure. */
    figX.save();
    figX.globalCompositeOperation = 'source-atop';
    /* shade — the far side of the body falls away hard */
    const gsh = figX.createLinearGradient(X(-0.34), Y(0.98), X(0.66), Y(0.10));
    gsh.addColorStop(0, 'rgba(3,5,9,0)');
    gsh.addColorStop(0.34, 'rgba(3,5,9,0.08)');
    gsh.addColorStop(0.72, 'rgba(3,5,9,0.40)');
    gsh.addColorStop(1, 'rgba(4,6,10,0.66)');
    figX.fillStyle = gsh; figX.fillRect(0, 0, w, h);
    /* ...and a second, vertical fall so the feet are not as lit as the chest */
    const gvv = figX.createLinearGradient(0, Y(0.92), 0, Y(-0.02));
    gvv.addColorStop(0, 'rgba(3,5,9,0)');
    gvv.addColorStop(0.52, 'rgba(3,5,9,0.14)');
    gvv.addColorStop(1, 'rgba(3,5,9,0.40)');
    figX.fillStyle = gvv; figX.fillRect(0, 0, w, h);
    /* key — a warm pool on the near shoulder, falling off across the chest */
    const gky = figX.createRadialGradient(X(-0.34), Y(0.90), 0, X(-0.26), Y(0.80), w * 0.86);
    gky.addColorStop(0, 'rgba(255,244,216,0.60)');
    gky.addColorStop(0.20, 'rgba(255,238,202,0.34)');
    gky.addColorStop(0.52, 'rgba(255,234,196,0.10)');
    gky.addColorStop(1, 'rgba(255,234,196,0)');
    figX.fillStyle = gky; figX.fillRect(0, 0, w, h);
    /* the polished harness also takes a broad raking glaze along the key axis —
       the term that puts a lit BAND across the chest and hip rather than a single
       bright dot per plate */
    A.glaze(figX, null, { x: 0, y: h * 0.02, w, h: h * 0.94 }, {
      a: 0.30, mode: 'source-atop', tint: '255,250,236',
      cx: 0.10, cy: 0.10, wid: 0.46, len: 1.15, fall: 1.5,
    });
    figX.globalCompositeOperation = 'source-atop';
    /* bounce — warm light returning off the leather panel below */
    const gbo = figX.createLinearGradient(0, Y(-0.02), 0, Y(0.30));
    gbo.addColorStop(0, 'rgba(232,186,116,0.20)');
    gbo.addColorStop(0.40, 'rgba(226,182,118,0.06)');
    gbo.addColorStop(1, 'rgba(226,182,118,0)');
    figX.fillStyle = gbo; figX.fillRect(0, 0, w, h);
    figX.restore();

    /* ---- and the key REASSERTED on top. The global shade above is applied over
       every plate's own specular, so the hard hits have to be re-struck after it
       or the harness ends up dark everywhere — which is exactly the "unlit blob"
       the round-1 pass was called out for. These are the seven places on a
       standing figure where polished plate turns squarely into a light at the
       upper left, and they are the brightest pixels in the whole panel. */
    figX.save();
    figX.globalCompositeOperation = 'source-atop';
    for (const [px, py, r, a, sq, rot] of [
      [X(-0.320), Y(0.800), 0.128, 1.00, 0.21, -0.44],   // near pauldron crown
      [X(-0.148), Y(0.792), 0.070, 1.00, 0.32, -0.66],   // breastplate crown
      [X(-0.048), Y(0.966), 0.042, 1.00, 0.42, -1.16],   // helm dome
      [X(-0.200), Y(0.566), 0.060, 0.96, 0.26, -0.60],   // fauld
      [X(-0.372), Y(0.612), 0.034, 0.92, 0.42, -0.55],   // couter
      [X(-0.160), Y(0.436), 0.038, 0.84, 0.32, -0.60],   // near tasset
      [X(-0.150), Y(0.198), 0.030, 0.72, 0.28, -0.60],   // near greave
      [X(-0.360), Y(0.410), 0.030, 0.78, 0.36, -0.55],   // gauntlet
      [X(-0.230), Y(0.686), 0.052, 0.86, 0.24, -0.62],   // lower breastplate
      [X(-0.318), Y(0.322), 0.024, 0.60, 0.34, -0.55],   // far gauntlet cuff
      [X(-0.148), Y(0.104), 0.026, 0.58, 0.30, -0.60],   // near sabaton
    ]) {
      A.hotSpot(figX, px, py, Math.max(2.4, L * r), {
        a, squash: sq, rot, coreR: 0.44,
      });
    }
    /* star glints — the cheapest "expensive" cue there is */
    A.glint(figX, X(-0.330), Y(0.798), Math.max(6, L * 0.17), { a: 0.74, rot: -0.5 });
    A.glint(figX, X(-0.048), Y(0.966), Math.max(5, L * 0.095), { a: 0.62, rot: -0.5 });
    A.glint(figX, X(-0.200), Y(0.566), Math.max(5, L * 0.085), { a: 0.52, rot: -0.5 });
    figX.restore();

    /* ---- the figure, with one cast shadow taken off its finished silhouette.
       (A tinted shifted copy of this layer would seem the obvious way to get a
       continuous back-rim, but the layer also carries every plate's blurred
       contact shadow, so the copy reads as a soft halo around the whole harness
       instead of a rim. The rim is done per-plate on the silhouette pieces.) */
    ctx0.save();
    ctx0.shadowColor = 'rgba(0,0,0,0.82)';
    ctx0.shadowBlur = Math.max(3, L * 0.05);
    ctx0.shadowOffsetX = L * 0.026;
    ctx0.shadowOffsetY = L * 0.034;
    ctx0.drawImage(figC, 0, 0);
    ctx0.restore();

    ctx0.restore();
  }

  /**
   * Set a panel title as struck gold leaf rather than as CSS text.
   *
   * DELIBERATE, and worth stating plainly: the critic asked for a self-hosted
   * woff2 display face. The project forbids external font files and network
   * fetches, so instead of shipping one the display treatment is manufactured —
   * UIAtlas.titleURI composes the line out of the OS inscriptional-serif stack
   * with the letterspacing, weight and initial-scale step set explicitly, then
   * gilds it as real metal with a sunk cut, worn leaf, tarnish, a raking crest
   * and a star glint on the ornamental capital. `heightVh` is the only layout
   * input; the width follows the raster's own aspect so the letterforms are
   * never stretched.
   */
  _setTitle(el, text, heightVh) {
    const t = this.atlas.titleURI(text, {
      font: FONT_DISPLAY, em: 44, step: 1.58, ls: 0.24, weight: 600, seed: 23,
    });
    el.style.backgroundImage = `url("${t.uri}")`;
    el.style.height = `${heightVh}vh`;
    el.style.width = `${(heightVh * t.w / t.h).toFixed(3)}vh`;
    return el;
  }

  _coinURI() {
    return this.atlas.uri('coin', 64, 64, (ctx, S) => {
      const c = S * 0.5;
      ctx.beginPath(); ctx.arc(c, c, S * 0.42, 0, Math.PI * 2);
      const g2 = ctx.createRadialGradient(c - S * 0.14, c - S * 0.16, S * 0.04, c, c, S * 0.44);
      g2.addColorStop(0, '#f8e9b4'); g2.addColorStop(0.45, '#c99b3c'); g2.addColorStop(1, '#4a3512');
      ctx.fillStyle = g2; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, S * 0.30, 0, Math.PI * 2);
      ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(70,50,14,0.7)'; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c, c - S * 0.16); ctx.lineTo(c + S * 0.13, c); ctx.lineTo(c, c + S * 0.16);
      ctx.lineTo(c - S * 0.13, c); ctx.closePath();
      ctx.fillStyle = 'rgba(80,56,16,0.75)'; ctx.fill();
    });
  }

  /* ================================================================== CSS */

  _injectCSS() {
    if (document.getElementById('nona-hud-char')) return;
    const s = document.createElement('style');
    s.id = 'nona-hud-char';
    s.textContent = `
#nona-hud .charPnl{ left:2.4vh; top:3.4vh; width:44vh; height:76vh; }
#nona-hud .charPnl .body{ padding:2.8vh 2.8vh 2.6vh; }
#nona-hud .cHead{ text-align:center; margin-bottom:.9vh; padding:0 3.6vh; }
/* a gilded raster line, not CSS text — see _setTitle and UITheme's .gilt.
   The negative margin puts the raster's baseline where the old CSS line's
   baseline was, so the title still sits inside the header cartouche. */
#nona-hud .cName{ margin-top:-1.15vh; }
#nona-hud .cSub{ margin-top:.66vh; font-size:.96vh; letter-spacing:.22em; color:#cfbf96;
  text-shadow:0 -1px 0 rgba(0,0,0,.9),0 1px 1px rgba(0,0,0,.7); }
#nona-hud .cSub .cDot{ margin:0 .6vh; color:#645a44; }

#nona-hud .cDoll{ position:relative; height:40.2vh; margin-top:.4vh; }
#nona-hud .cFig{ position:absolute; left:6.6vh; right:6.6vh; top:-0.6vh; bottom:7.2vh; }
#nona-hud .cFigSkin{ position:absolute; inset:0; width:100%; height:100%; display:block; }

#nona-hud .eqSlot{ position:absolute; width:${SLOT_VH}vh; height:${SLOT_VH}vh; }
#nona-hud .eqSlot>div{ position:absolute; }
#nona-hud .eqSock{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .3vh .7vh rgba(0,0,0,.85)); }
#nona-hud .eqSil{ inset:20%; background-size:100% 100%; background-repeat:no-repeat; }
#nona-hud .eqGlow{ inset:-16%; pointer-events:none; }
#nona-hud .eqIcon{ inset:13%; background-size:100% 100%; background-repeat:no-repeat; }
#nona-hud .eqBez{ inset:0; background-size:100% 100%; background-repeat:no-repeat; opacity:0; }
#nona-hud .eqLab{ left:-1.2vh; right:-1.2vh; top:101%; text-align:center; font-size:.70vh;
  letter-spacing:.18em; color:#c2b28d; text-shadow:0 -1px 0 rgba(0,0,0,.9),0 1px 1px rgba(0,0,0,.8); }

/* the stat columns sit ON the vellum ledger, so they need a margin inside its
   gold inlay — right-aligned numerals were finishing 2 px from the frame */
#nona-hud .cStats{ display:flex; gap:1.7vh; margin-top:1.1vh; padding:0 1.0vh 0 .2vh; }
#nona-hud .cCol{ flex:1 1 0; min-width:0; }

#nona-hud .invPnl{ left:135.4vh; top:3.4vh; width:40vh; height:76vh; }
#nona-hud .invPnl .body{ padding:2.8vh 2.8vh 2.5vh; display:flex; flex-direction:column; }
#nona-hud .iHead{ text-align:center; padding:0 3.6vh; }
#nona-hud .iTitle{ margin-top:-.86vh; }
#nona-hud .iTabRow{ display:flex; align-items:center; gap:.6vh; margin-bottom:1.0vh; }
#nona-hud .iTabLab{ font-size:.82vh; letter-spacing:.24em; color:#c4b48f;
  text-shadow:0 -1px 0 rgba(0,0,0,.85); }
#nona-hud .iTabs{ display:flex; gap:.36vh; margin-left:auto; }
#nona-hud .iTab{ width:2.1vh; height:1.8vh; background-size:100% 100%;
  display:flex; align-items:center; justify-content:center;
  font-size:.90vh; color:#8e8267; filter:drop-shadow(0 .15vh .3vh rgba(0,0,0,.75)); }
#nona-hud .iTab.on{ color:#f4dc9a; }
#nona-hud .iRule{ margin:.9vh 0 .8vh; }
#nona-hud .iGrid{ display:grid; grid-template-columns:repeat(${COLS},1fr);
  gap:.46vh; }
#nona-hud .iCell{ position:relative; width:100%; padding-top:100%; }
#nona-hud .iCell>div{ position:absolute; }
#nona-hud .cSock{ inset:0; background-size:100% 100%; }
#nona-hud .cGlow{ inset:-10%; pointer-events:none; }
#nona-hud .cIcon{ inset:11%; background-size:100% 100%; background-repeat:no-repeat; }
#nona-hud .cBez{ inset:0; background-size:100% 100%; background-repeat:no-repeat; opacity:0; }
#nona-hud .cStack{ right:.1vh; bottom:-.05vh; font-size:.86vh; color:#e8dcc0;
  text-shadow:0 1px 0 #000,0 0 .5vh #000; }
#nona-hud .iFoot{ display:flex; align-items:center; gap:.7vh; margin-top:auto; }
#nona-hud .iCoin{ width:1.6vh; height:1.6vh; background-size:100% 100%;
  filter:drop-shadow(0 .15vh .3vh rgba(0,0,0,.8)); }
#nona-hud .iGold{ font-size:1.30vh; color:#33240d;
  text-shadow:0 1px 0 rgba(255,246,214,.55),0 -1px 0 rgba(90,70,32,.35); }
#nona-hud .iCap{ margin-left:auto; font-size:.84vh; letter-spacing:.14em; color:#584422;
  text-shadow:0 1px 0 rgba(255,246,214,.42); padding-right:.4vh; }
`;
    document.head.appendChild(s);
  }
}

function hexA(h, a) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default Character;
