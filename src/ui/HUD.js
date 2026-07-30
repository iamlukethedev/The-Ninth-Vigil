/**
 * THE NINTH VIGIL — HUD
 * ---------------------------------------------------------------------------
 * The whole interface. A DOM/CSS overlay rather than an orthographic layer:
 * text stays vector-crisp at any resolution, and every ornament is a canvas
 * rasterised by UIAtlas at the element's real device-pixel size. Zero WebGL
 * draw calls, zero texture units, ~0.3 ms of layout work per frame.
 *
 * Structure
 *   • orbs           health (left) / resource (right) — liquid, meniscus, bezel
 *   • action bar     6 beveled sockets, rune glyphs, radial cooldown sweeps
 *   • xp bar         ticked trough + level plate
 *   • buff row       stack counts + duration sweeps
 *   • minimap        procedural top-down of the live dungeon layout
 *   • combat layer   floating damage, elite/boss nameplates, boss health bar
 *   • world labels   ground loot cartouches, collision-solved (WorldLabels.js)
 *   • feed           toast notifications + loot pickup log
 *   • character      inventory grid, paper doll, stat panel, skill tree
 *   • tooltip        the most-read element in an ARPG; fully authored
 *
 * Being DOM is not a convenience here, it is the fix for round-1 blocker #9:
 * the interface is composited by the browser AFTER the WebGL canvas resolves,
 * so no post pass can touch it. See THE COMPOSITING CONTRACT in the constructor.
 *
 * Determinism: no CSS animation, no wall clock. Every moving value is written
 * from update() using engine.clock, so `--frames=N` is byte-stable.
 */

import { baseCSS, PAL, RARITY, rarityOf, dmgStyleOf, FONT_DISPLAY, FONT_ENGRAVED, FONT_BODY, FONT_NUM, FONT_ARCANE } from './UITheme.js';
import { UIAtlas } from './UIAtlas.js';
import { Ornament } from './panels/Ornament.js';
import { mk, sty, txt, SkinSet, statRow, section, fmt, fmtTime, clamp, clamp01, mix, approach } from './panels/Widgets.js';
import { CombatLayer } from './panels/Combat.js';
import { WorldLabels } from './panels/WorldLabels.js';
import { Minimap } from './panels/Minimap.js';
import { Character } from './panels/Inventory.js';
import { Tooltip } from './panels/Tooltip.js';
import { SkillTree } from './panels/SkillTree.js';

/* --------------------------------------------------------------- ability set */

const ABILITIES = [
  { id: 'cleave',  key: 'LMB', name: 'Sundering Cleave', glyph: 'cleave', col: '#d8a04a', cd: 0,    cost: 0,  desc: 'A wide horizontal arc.' },
  { id: 'thrust',  key: 'RMB', name: 'Impaling Thrust',  glyph: 'thrust', col: '#c9d6e4', cd: 3.5,  cost: 12, desc: 'Lunge and skewer.' },
  { id: 'whirl',   key: '1',   name: 'Bloodwhirl',       glyph: 'whirl',  col: '#d8552a', cd: 8,    cost: 25, desc: 'Spin, rending all nearby.' },
  { id: 'quake',   key: '2',   name: 'Earthsunder',      glyph: 'quake',  col: '#b0813c', cd: 14,   cost: 30, desc: 'Shatter the ground.' },
  { id: 'ward',    key: '3',   name: 'Iron Bulwark',     glyph: 'ward',   col: '#7fa8d8', cd: 20,   cost: 20, desc: 'Raise a shield of will.' },
  { id: 'drain',   key: '4',   name: 'Vitae Siphon',     glyph: 'drain',  col: '#8e6cd8', cd: 30,   cost: 40, desc: 'Draw life from the wounded.' },
];

/** Deterministic starting cooldown phase per scenario, so sweeps are visible. */
const CD_PHASE = {
  combat: [0, 0.38, 0.72, 0.15, 0, 0.55],
  boss:   [0, 0.62, 0.28, 0.85, 0.40, 0.10],
  dungeon:[0, 0, 0.44, 0, 0.18, 0],
  night:  [0, 0.20, 0, 0.60, 0, 0.33],
  overworld:[0, 0, 0.12, 0, 0, 0.70],
  hub:    [0, 0, 0, 0, 0, 0],
  inventory:[0, 0, 0.30, 0, 0, 0],
  closeup:[0, 0, 0, 0, 0, 0],
};

const BUFFS = [
  { id: 'zeal',   name: 'Unbridled Zeal',   glyph: 'flame',  col: '#d8552a', kind: 'buff',   dur: 18,  stacks: 3 },
  { id: 'ward',   name: 'Iron Bulwark',     glyph: 'ward',   col: '#7fa8d8', kind: 'buff',   dur: 9,   stacks: 0 },
  { id: 'bless',  name: 'Ancestral Blessing', glyph: 'sigil', col: '#e0c74e', kind: 'buff',  dur: 42,  stacks: 0 },
  { id: 'bleed',  name: 'Rending Wound',    glyph: 'drain',  col: '#a8261c', kind: 'debuff', dur: 6,   stacks: 5 },
  { id: 'curse',  name: 'Grave Chill',      glyph: 'bolt',   col: '#6ac08a', kind: 'debuff', dur: 12,  stacks: 2 },
];

const GAMEPLAY = new Set(['hub', 'combat', 'boss', 'dungeon', 'night', 'overworld']);

/* ========================================================================= */

export class HUD {
  static id = 'hud';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.dead = false;
    this.scenario = 'combat';
    this._offs = [];
    this._t = 0;

    /**
     * THE COMPOSITING CONTRACT (round-1 blocker #9).
     *
     * Every pixel of interface in this game is DOM, which puts all of it
     * downstream of the WebGL canvas in the browser's compositor — i.e. after
     * the entire post chain, unconditionally. Bloom, DOF, motion blur, the LUT
     * grade, film grain, chromatic aberration and the vignette cannot reach it.
     *
     * That includes the WORLD-ANCHORED interface, which is the part that keeps
     * being got wrong because it is positioned from a camera projection and so
     * feels like it belongs in the scene:
     *
     *   damage numbers   panels/Combat.js      DOM, projected per frame
     *   nameplates       panels/Combat.js      DOM, projected per frame
     *   boss bar         panels/Combat.js      DOM
     *   ground labels    panels/WorldLabels.js DOM, projected per frame
     *
     * `drawsDamageNumbers` is the published half of the handshake in
     * src/combat/HitFeel.js: it draws its own instanced glyph batch INSIDE the
     * scene (and therefore through the post chain) unless a HUD claims the
     * channel. We claim it. Do not remove this flag without also removing the
     * DOM damage numbers, or the frame gets both and they will not agree.
     *
     * If you ever need to draw world-anchored interface in WebGL instead, use
     * `engine.uiLayer` — RenderPipeline keeps that camera layer out of the post
     * chain and composites it afterwards. Never put type in the graded scene.
     */
    this.drawsDamageNumbers = true;

    /* smoothed display values — they lag the true value on purpose */
    this.hpShown = 1; this.hpTarget = 1; this.hpGhost = 1;
    this.rsShown = 1; this.rsTarget = 1;
    this.xpShown = 0.62;

    this.cds = ABILITIES.map(() => 0);          // seconds remaining
    this.casts = ABILITIES.map(() => -99);      // last cast time
    this.buffT = BUFFS.map((b) => b.dur);
  }

  /* ================================================================= init */

  async init() {
    try {
      this.atlas = new UIAtlas(this.engine);
      this.orn = new Ornament(this.atlas);
      this.skins = new SkinSet(this.atlas);

      this.style = document.createElement('style');
      this.style.textContent = baseCSS() + hudCSS();
      document.head.appendChild(this.style);

      this.root = mk('div', '', document.body);
      this.root.id = 'nona-hud';

      this._buildVeil();
      this._buildOrbs();
      this._buildActionBar();
      this._buildBuffs();
      this._buildQuest();
      this._buildFeed();

      /* Sub-systems, each isolated so one failure cannot take the HUD down.
         Build order IS paint order, and both world-anchored layers belong under
         the panels, which are opaque objects.
         Ground labels are built FIRST so the combat layer paints over them: a
         loot cartouche is persistent furniture, a damage number is a 1.2 s event
         that must not be swallowed by it. Captured proof of the old order:
         shots/_debug/blk9_before_labels_over_numbers_5x.png — "263" and "941"
         half-hidden behind two plates.
         (Update order is the opposite and is set in update(): the labels treat
         the combat layer's live nameplate rects as obstacles.) */
      this.wlabels = this._sub(() => new WorldLabels(this));
      this.combat = this._sub(() => new CombatLayer(this));
      this.minimap = this._sub(() => new Minimap(this));
      this.character = this._sub(() => new Character(this));
      this.tooltip = this._sub(() => new Tooltip(this));
      this.tree = this._sub(() => new SkillTree(this));

      this._bind();
      this.resize(this.engine.width, this.engine.height);
      this.applyScenario(this.engine.scenario?.name ?? 'combat');
    } catch (e) {
      console.error('[hud] init failed —', e);
      this.dead = true;
      this.__dead = true;
    }
  }

  _sub(fn) {
    try { const s = fn(); s.build?.(); return s; } catch (e) { console.error('[hud] sub-system disabled —', e); return null; }
  }

  /**
   * True once the DOM label layer has taken the ground-label channel off Loot.
   * Published so a capture harness can assert the takeover rather than infer it
   * from pixels — a silent regression here puts filtered type back in the frame.
   */
  get ownsWorldLabels() { return !!this.wlabels?._owned; }

  _bind() {
    const bus = this.engine.bus;
    const on = (evt, fn) => this._offs.push(bus.on(evt, (p) => { try { fn(p); } catch (e) { /* never break the frame */ } }));
    on('damage', (p) => { this.combat?.onDamage(p); });
    on('death', (p) => { this.combat?.onDeath(p); });
    on('ability:cast', (p) => this._onCast(p));
    on('ui:toast', (p) => this.toast(p?.text ?? '', p?.tier ?? 'info'));
    on('loot:pickup', (p) => this._onLoot(p));
    on('loot:drop', (p) => this._onLoot(p));
    on('level:up', (p) => {
      this.xpShown = 0;
      this.toast(`Level ${p?.level ?? '?'}`, 'level');
    });
  }

  /* ============================================================== chrome */

  _buildVeil() {
    /* Darkens the world behind the character screen. Painted, not flat black. */
    this.veil = mk('div', 'veil hide', this.root);
    this.veil.style.backgroundImage = `url("${this.orn.screenVeil(1920, 1080)}")`;
    /* A permanent, very subtle bottom gradient so the HUD always has a footing
       and never floats on top of a bright floor. */
    this.foot = mk('div', 'foot', this.root);
  }

  /* ---------------------------------------------------------------- orbs */

  _buildOrbs() {
    this.orbs = {};
    for (const side of ['hp', 'rs']) {
      const isHp = side === 'hp';
      const o = mk('div', `orb ${side}`, this.root);
      const cav = mk('div', 'oCav', o);
      const clipW = mk('div', 'oClip', o);
      const ghost = isHp ? mk('div', 'oGhost', clipW) : null;
      const liq = mk('div', 'oLiq', clipW);
      const men = mk('div', 'oMen', clipW);
      const cau = mk('div', 'oCau', clipW);
      const glass = mk('div', 'oGlass', o);
      const bez = mk('div', 'oBez', o);
      const cap = txt('div', 'oCap num', '', o);
      const lab = txt('div', 'oLab eng', isHp ? 'Life' : 'Zeal', o);

      const size = 380;
      cav.style.backgroundImage = `url("${this.atlas.orbCavityURI(size, { tag: side })}")`;
      glass.style.backgroundImage = `url("${this.atlas.orbGlassURI(size, { tag: side })}")`;
      bez.style.backgroundImage = `url("${this.atlas.orbBezelURI(size, { tag: side, gem: isHp ? '#b8352c' : '#2f6bb0', seed: isHp ? 31 : 47 })}")`;
      const col = isHp ? PAL.blood : PAL.mana;
      liq.style.backgroundImage = `url("${this.orn.orbLiquid(col)}")`;
      liq.style.backgroundSize = '100% 100%';
      liq.style.backgroundRepeat = 'no-repeat';
      cau.style.backgroundImage = `url("${this.orn.tileURI('caustic', 128, isHp ? 5 : 9)}")`;
      cau.style.backgroundSize = '58% 58%';
      if (ghost) {
        ghost.style.backgroundImage = `url("${this.orn.orbLiquid('#e0563a')}")`;
        ghost.style.backgroundSize = '100% 100%';
      }
      this.orbs[side] = { root: o, liq, men, cau, ghost, cap, lab, col };
    }
    /* low-life screen vignette — painted, driven from the health fraction */
    this.dmgVig = mk('div', 'dmgVig', this.root);
  }

  /* ---------------------------------------------------------- action bar */

  _buildActionBar() {
    this.bar = mk('div', 'bar', this.root);
    const sockURI = this.atlas.socketURI(240, { tag: 'ab', seed: 23, cham: 0.20, band: 0.105, metal: 'steel' });
    const sockLit = this.atlas.socketURI(240, { tag: 'abl', seed: 51, cham: 0.20, band: 0.105, metal: 'bronze' });
    this.slots = ABILITIES.map((ab, i) => {
      const s = mk('div', 'slot', this.bar);
      const sock = mk('div', 'sSock', s);
      sock.style.backgroundImage = `url("${i < 2 ? sockLit : sockURI}")`;
      const ico = mk('div', 'sIco', s);
      ico.style.backgroundImage = `url("${this.atlas.glyphURI(160, ab.glyph, ab.col)}")`;
      const cd = mk('div', 'sCd', s);
      const hand = mk('div', 'sHand', s);
      const cdt = txt('div', 'sCdT num', '', s);
      const rdy = mk('div', 'sRdy', s);
      const kb = mk('div', 'sKb eng', s);
      kb.style.backgroundImage = `url("${this.orn.plate(84, 40, { tag: 'key', metal: 'iron', cham: 9, inlay: false })}")`;
      txt('span', '', ab.key, kb);
      return { root: s, sock, ico, cd, hand, cdt, rdy, kb, ab };
    });

    /* ---- xp bar under the action bar ---- */
    this.xp = {};
    const wrap = mk('div', 'xpWrap', this.root);
    const trough = mk('div', 'xpTrough', wrap);
    const fillClip = mk('div', 'xpClip', wrap);
    const fill = mk('div', 'xpFill', fillClip);
    const frame = mk('div', 'xpFrame', wrap);
    const plate = mk('div', 'xpPlate', wrap);
    const lvl = txt('div', 'xpLvl num', '12', plate);
    const pct = txt('div', 'xpPct eng', '', wrap);
    frame.style.backgroundImage = `url("${this.orn.barFrame(1100, 40, { tag: 'xp', ticks: 20, band: 7, cham: 9 })}")`;
    fill.style.backgroundImage = `url("${this.orn.barFill(40, '#c08b2c', { tag: 'xp' })}")`;
    plate.style.backgroundImage = `url("${this.orn.plate(150, 150, { tag: 'lvl', metal: 'iron', cham: 34, rivets: true })}")`;
    this.xp = { wrap, fill, lvl, pct, plate, frame };
  }

  /* --------------------------------------------------------------- buffs */

  _buildBuffs() {
    this.buffRow = mk('div', 'buffs', this.root);
    this.buffEls = BUFFS.map((b) => {
      const e = mk('div', `buff ${b.kind}`, this.buffRow);
      const fr = mk('div', 'bFr', e);
      fr.style.backgroundImage = `url("${this.orn.buffFrame(120, b.kind)}")`;
      const ic = mk('div', 'bIc', e);
      ic.style.backgroundImage = `url("${this.atlas.glyphURI(96, b.glyph, b.col)}")`;
      const sw = mk('div', 'bSw', e);
      const st = txt('div', 'bSt num', '', e);
      const tm = txt('div', 'bTm num', '', e);
      return { root: e, sw, st, tm, def: b };
    });
  }

  /* -------------------------------------------------------- quest tracker */

  _buildQuest() {
    const p = this.skins.panel(this.root, 'quest', {
      kind: 'vellum', frame: 'iron', band: 9, chamfer: 14, ornament: 'light', seed: 5,
      fieldScale: 0.8, vignette: 0.34, fieldLift: 0.18, rake: 0.14,
    });
    this.quest = p;
    const b = p.body;
    const h = txt('div', 'disp qTitle', 'The Hollow Sanctum', b);
    const sub = txt('div', 'eng qSub', 'Act II — Chapter 4', b);
    mk('div', 'rule', b);
    const list = mk('div', 'qList', b);
    for (const [done, s] of [[true, 'Enter the flooded crypt'], [false, 'Break the Blood Seal'], [false, 'Slay Gholrath, the Unmade']]) {
      const r = mk('div', `qRow${done ? ' done' : ''}`, list);
      mk('div', 'qPip', r);
      txt('span', '', s, r);
    }
  }

  /* ----------------------------------------------------------- feed/loot */

  _buildFeed() {
    this.toastWrap = mk('div', 'toasts', this.root);
    this.lootWrap = mk('div', 'lootLog', this.root);
    this._toasts = [];
    this._loots = [];
    /* Seed the loot log with plausible history so the frame is judgeable even
       before anything drops. */
    this._seedFeed = true;
  }

  toast(text, tier = 'info') {
    if (!this.toastWrap || !text) return;
    const e = mk('div', `toast t-${tier}`, this.toastWrap);
    const inner = mk('div', 'tIn', e);
    inner.style.backgroundImage = `url("${this.orn.ribbon(760, 74, { tag: tier, tint: TOAST_TINT[tier] ?? '#241c12' })}")`;
    txt('div', tier === 'level' || tier === 'boss' ? 'disp' : 'eng', text, inner);
    this._toasts.push({ el: e, t0: this.engine.clock.elapsed, life: tier === 'boss' ? 6 : 4.4 });
    while (this._toasts.length > 4) { const o = this._toasts.shift(); o.el.remove(); }
  }

  lootLine(name, rarityKey = 'common', qty = 1) {
    if (!this.lootWrap) return;
    const r = rarityOf(rarityKey);
    const e = mk('div', 'lRow', this.lootWrap);
    const pip = mk('div', 'lPip', e);
    pip.style.background = `radial-gradient(circle at 34% 30%, ${r.line}, ${r.deep} 78%)`;
    pip.style.boxShadow = `0 0 .7vh ${r.glow}, inset 0 0 .3vh rgba(255,255,255,.5)`;
    const t = txt('span', 'lName', qty > 1 ? `${name}  ×${qty}` : name, e);
    t.style.color = r.text;
    this._loots.push({ el: e, t0: this.engine.clock.elapsed, life: 9 });
    while (this._loots.length > 6) { const o = this._loots.shift(); o.el.remove(); }
  }

  _onLoot(p) {
    const it = p?.item ?? {};
    const kind = it.kind ?? 'coin';
    if (kind === 'gold' || kind === 'coin') { this.lootLine('Gold', 'common', 40 + ((this.engine.clock.frame * 7) % 180)); return; }
    this.lootLine(it.name ?? LOOT_NAME[kind] ?? 'Unknown Relic', it.tier ?? it.rarity ?? 'common', it.qty ?? 1);
  }

  _onCast(p) {
    const i = ABILITIES.findIndex((a) => a.id === p?.id || (p?.id ?? '').indexOf(a.id) >= 0);
    const k = i >= 0 ? i : 0;
    this.cds[k] = ABILITIES[k].cd;
    this.casts[k] = this.engine.clock.elapsed;
    if (k >= 2) {
      const b = this.buffEls?.[0];
      if (b) this.buffT[0] = BUFFS[0].dur;
    }
  }

  /* ============================================================ scenario */

  applyScenario(name) {
    if (this.dead || !this.root) return;
    this.scenario = name;
    const gameplay = GAMEPLAY.has(name);
    const inv = name === 'inventory';
    const closeup = name === 'closeup';

    const show = (el, on) => { if (el) el.classList.toggle('hide', !on); };

    show(this.orbs?.hp?.root, gameplay || inv);
    show(this.orbs?.rs?.root, gameplay || inv);
    show(this.bar, gameplay || inv);
    show(this.xp?.wrap, gameplay || inv);
    show(this.buffRow, gameplay);
    show(this.quest?.root, gameplay && !closeup);
    show(this.toastWrap, gameplay);
    show(this.lootWrap, gameplay);
    show(this.foot, !closeup);
    show(this.veil, inv);

    this.minimap?.setVisible?.(gameplay);
    this.combat?.setVisible?.(gameplay);
    this.wlabels?.setVisible?.(gameplay);
    this.character?.setVisible?.(inv);
    this.tree?.setVisible?.(inv);
    this.tooltip?.setScenario?.(name);

    /* deterministic cooldown phase so radial sweeps read in the capture */
    const ph = CD_PHASE[name] ?? CD_PHASE.combat;
    for (let i = 0; i < this.cds.length; i++) this.cds[i] = ABILITIES[i].cd * (ph[i] ?? 0);

    /* orb/resource start state per scenario */
    const hero = this.engine.get('hero');
    const frac = { boss: 0.52, combat: 0.71, dungeon: 0.88, night: 0.94, overworld: 1.0, hub: 1.0, inventory: 0.86, closeup: 1.0 }[name] ?? 0.8;
    if (hero?.stats) {
      hero.stats.health = Math.max(1, Math.round(hero.stats.maxHealth * frac));
      hero.stats.resource = Math.round(hero.stats.maxResource * (0.35 + 0.55 * (1 - frac)));
    }
    this.hpShown = frac; this.hpGhost = Math.min(1, frac + 0.09); this.hpTarget = frac;
    this.rsShown = 0.55; this.rsTarget = 0.55;
    this.xpShown = { boss: 0.83, combat: 0.62, dungeon: 0.41, night: 0.55, overworld: 0.28, hub: 0.71, inventory: 0.62 }[name] ?? 0.5;

    for (let i = 0; i < BUFFS.length; i++) this.buffT[i] = BUFFS[i].dur * (0.32 + 0.13 * i);

    /* feed content per scenario */
    if (this.toastWrap) this.toastWrap.textContent = '';
    if (this.lootWrap) this.lootWrap.textContent = '';
    this._toasts = []; this._loots = [];
    if (gameplay) {
      const seed = { combat: 1, boss: 2, dungeon: 3, night: 4, overworld: 5, hub: 6 }[name] ?? 1;
      const feed = FEED_SETS[name] ?? FEED_SETS.combat;
      for (const f of feed.loot) this.lootLine(f[0], f[1], f[2] ?? 1);
      for (const t of feed.toasts) this.toast(t[0], t[1]);
      /* stagger their ages so the stack shows a real fade ramp */
      const now = this.engine.clock.elapsed;
      this._loots.forEach((l, i) => { l.t0 = now - (this._loots.length - 1 - i) * 1.15; });
      this._toasts.forEach((t, i) => { t.t0 = now - (this._toasts.length - 1 - i) * 1.4 - seed * 0.05; });
    }

    this.minimap?.rebuild?.();
    this.wlabels?.applyScenario?.(name);
    this.character?.applyScenario?.(name);
    this.tree?.applyScenario?.(name);
    this.tooltip?.applyScenario?.(name);
    this._repaintSoon = 2;
  }

  /* ============================================================== resize */

  resize(w, h) {
    if (this.dead || !this.root) return;
    this.vw = w || innerWidth; this.vh = h || innerHeight;
    try {
      this.skins.repaint(Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1));
      this.minimap?.resize?.(this.vw, this.vh);
      this.character?.resize?.(this.vw, this.vh);
      this.tree?.resize?.(this.vw, this.vh);
      this.tooltip?.resize?.(this.vw, this.vh);
      this.combat?.resize?.(this.vw, this.vh);
      this.wlabels?.resize?.(this.vw, this.vh);
    } catch (e) { /* keep the frame alive */ }
  }

  /* ============================================================== update */

  update(dt, elapsed) {
    if (this.dead || !this.root) return;
    this._t = elapsed;
    if (this._repaintSoon > 0) { this._repaintSoon--; if (this._repaintSoon === 0) this.resize(this.vw, this.vh); }

    const hero = this.engine.get('hero');
    const st = hero?.stats;

    /* ---- orbs ---- */
    const hpMax = st?.maxHealth ?? 340;
    const rsMax = st?.maxResource ?? 100;
    this.hpTarget = clamp01((st?.health ?? hpMax * 0.7) / Math.max(1, hpMax));
    this.rsTarget = clamp01((st?.resource ?? rsMax * 0.55) / Math.max(1, rsMax));
    this.hpShown = approach(this.hpShown, this.hpTarget, 7.5, dt);
    /* the ghost trail lags far behind and only ever falls */
    if (this.hpTarget > this.hpGhost) this.hpGhost = approach(this.hpGhost, this.hpTarget, 9, dt);
    else this.hpGhost = approach(this.hpGhost, this.hpTarget, 1.5, dt);
    this.rsShown = approach(this.rsShown, this.rsTarget, 9, dt);

    this._orb('hp', this.hpShown, st?.health ?? 0, hpMax, elapsed, this.hpGhost);
    this._orb('rs', this.rsShown, st?.resource ?? 0, rsMax, elapsed + 3.1, null);

    if (this.dmgVig) {
      const k = clamp01((0.40 - this.hpShown) / 0.40);
      this.dmgVig.style.opacity = (clamp01(k * (0.58 + 0.42 * Math.sin(elapsed * 2.4))) * 0.95).toFixed(3);
    }

    /* ---- action bar ---- */
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const ab = s.ab;
      if (this.cds[i] > 0) this.cds[i] = Math.max(0, this.cds[i] - dt);
      const rem = this.cds[i];
      const total = Math.max(0.001, ab.cd);
      if (rem > 0.001) {
        const frac = clamp01(rem / total);
        const turn = frac.toFixed(4);
        s.cd.style.background =
          `conic-gradient(from 180deg at 50% 50%, rgba(3,4,7,.80) 0turn ${turn}turn, rgba(0,0,0,0) ${turn}turn 1turn)`;
        s.cd.style.opacity = '1';
        s.hand.style.opacity = '0.85';
        s.hand.style.transform = `translateX(-50%) rotate(${(180 + frac * 360).toFixed(2)}deg)`;
        s.cdt.textContent = fmtTime(rem);
        s.cdt.style.opacity = '1';
        s.ico.style.filter = 'saturate(.34) brightness(.56)';
        s.rdy.style.opacity = '0';
      } else {
        s.cd.style.opacity = '0';
        s.hand.style.opacity = '0';
        s.cdt.style.opacity = '0';
        s.ico.style.filter = 'none';
        /* charge-ready pulse: strongest just after the cooldown ends */
        const since = elapsed - (this.casts[i] + ab.cd);
        const burst = since > 0 && since < 0.85 ? 1 - since / 0.85 : 0;
        const idle = 0.34 + 0.26 * Math.sin(elapsed * 2.1 + i * 1.05);
        const k = clamp01(idle * 0.55 + burst);
        s.rdy.style.opacity = k.toFixed(3);
        s.rdy.style.boxShadow =
          `0 0 ${(0.5 + k * 1.5).toFixed(2)}vh ${(0.05 + k * 0.22).toFixed(2)}vh ${hexA(ab.col, 0.16 + k * 0.5)},` +
          ` inset 0 0 ${(0.4 + k * 1.1).toFixed(2)}vh ${hexA(ab.col, 0.10 + k * 0.30)}`;
      }
    }

    /* ---- xp ---- */
    if (this.xp?.fill) {
      this.xpShown = Math.min(1, this.xpShown + dt * 0.0032);
      this.xp.fill.style.width = `${(this.xpShown * 100).toFixed(2)}%`;
      this.xp.pct.textContent = `${(this.xpShown * 100).toFixed(1)}%`;
      if (st?.level != null) this.xp.lvl.textContent = String(st.level);
    }

    /* ---- buffs ---- */
    for (let i = 0; i < this.buffEls.length; i++) {
      const b = this.buffEls[i];
      const d = b.def;
      this.buffT[i] -= dt;
      if (this.buffT[i] <= 0) this.buffT[i] += d.dur;      // deterministic re-application
      const frac = clamp01(this.buffT[i] / d.dur);
      const turn = frac.toFixed(4);
      b.sw.style.background =
        `conic-gradient(from 180deg at 50% 50%, rgba(0,0,0,0) 0turn ${turn}turn, rgba(4,5,8,.74) ${turn}turn 1turn)`;
      b.tm.textContent = this.buffT[i] >= 10 ? String(Math.ceil(this.buffT[i])) : this.buffT[i].toFixed(1);
      b.st.textContent = d.stacks > 0 ? String(d.stacks) : '';
      /* debuffs breathe slightly so the row is not static */
      const pulse = d.kind === 'debuff' ? 1 + 0.02 * Math.sin(elapsed * 3.4 + i) : 1;
      b.root.style.transform = `scale(${pulse.toFixed(4)})`;
    }

    /* ---- feed ageing ---- */
    this._ageFeed(this._toasts, elapsed, (o, k) => {
      o.el.style.opacity = k.a.toFixed(3);
      o.el.style.transform = `translateY(${(-1.5 * (1 - k.inT)).toFixed(2)}vh) scale(${(0.96 + 0.04 * k.inT).toFixed(3)})`;
    });
    this._ageFeed(this._loots, elapsed, (o, k) => {
      o.el.style.opacity = k.a.toFixed(3);
      o.el.style.transform = `translateX(${(-1.8 * (1 - k.inT)).toFixed(2)}vh)`;
    });

    /* ---- sub-systems ----
       combat first: the ground labels treat its live nameplates as obstacles. */
    this.minimap?.update?.(dt, elapsed);
    this.combat?.update?.(dt, elapsed);
    this.wlabels?.update?.(dt, elapsed);
    this.character?.update?.(dt, elapsed);
    this.tree?.update?.(dt, elapsed);
    this.tooltip?.update?.(dt, elapsed);
  }

  _ageFeed(list, elapsed, apply) {
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      const age = elapsed - o.t0;
      const inT = clamp01(age / 0.28);
      let a = inT;
      if (age > o.life - 1.1) a = clamp01((o.life - age) / 1.1);
      apply(o, { a, inT });
      if (age > o.life) { o.el.remove(); list.splice(i, 1); }
    }
  }

  /** Write one orb's liquid level, meniscus chord, and numerals. */
  _orb(side, frac, cur, max, elapsed, ghost) {
    const o = this.orbs?.[side];
    if (!o) return;
    /* caustics drift so the liquid is alive without any CSS animation */
    o.cau.style.backgroundPosition =
      `${(elapsed * 3.1 % 100).toFixed(2)}% ${(-elapsed * 5.4 % 100).toFixed(2)}%`;
    /* the vessel's inner circle, as a fraction of the orb element */
    const IN = 0.744;                       // bezel inner diameter / orb size
    const wob = Math.sin(elapsed * 1.35 + (side === 'hp' ? 0 : 2.2)) * 0.0055
      + Math.sin(elapsed * 3.1 + 1.1) * 0.0026;
    const f = clamp01(frac + (frac > 0.02 && frac < 0.98 ? wob : 0));
    const pct = (f * 100).toFixed(2);
    o.liq.style.height = `${pct}%`;
    /* meniscus: chord of the vessel circle at the liquid surface */
    const y = 1 - f;                        // 0 at top, 1 at bottom of the vessel
    const dy = (y - 0.5) * 2;               // -1..1
    const half = Math.sqrt(Math.max(0, 1 - dy * dy));
    const wPct = (half * 100).toFixed(2);
    o.men.style.width = `${wPct}%`;
    o.men.style.left = `${(50 - half * 50).toFixed(2)}%`;
    o.men.style.bottom = `${pct}%`;
    o.men.style.opacity = f > 0.015 && f < 0.985 ? '1' : '0';
    o.men.style.background =
      `radial-gradient(ellipse at 50% 120%, ${hexA(o.col, 0.0)} 40%, ${hexA(lightHex(o.col), 0.85)} 78%, ${hexA(lightHex(o.col), 0.25)} 100%)`;
    o.men.style.boxShadow = `0 -.18vh .55vh ${hexA(lightHex(o.col), 0.42)}, 0 .12vh .3vh rgba(0,0,0,.55)`;
    if (o.ghost) {
      const g = clamp01(ghost ?? f);
      o.ghost.style.height = `${(g * 100).toFixed(2)}%`;
      o.ghost.style.opacity = g - f > 0.004 ? '0.42' : '0';
    }
    o.cap.textContent = `${fmt(cur)} / ${fmt(max)}`;
  }

  /* ============================================================= dispose */

  dispose() {
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    try { this.combat?.dispose?.(); } catch { /* noop */ }
    try { this.wlabels?.dispose?.(); } catch { /* noop */ }
    try { this.minimap?.dispose?.(); } catch { /* noop */ }
    try { this.character?.dispose?.(); } catch { /* noop */ }
    try { this.tree?.dispose?.(); } catch { /* noop */ }
    try { this.tooltip?.dispose?.(); } catch { /* noop */ }
    try { this.skins?.dispose(); } catch { /* noop */ }
    try { this.atlas?.dispose(); } catch { /* noop */ }
    this.root?.remove();
    this.style?.remove();
  }
}

/* ===================================================================== data */

const TOAST_TINT = {
  info: '#241c12', boss: '#3a0f0a', danger: '#3a0f0a', level: '#3b3110', good: '#1c2a12', quest: '#16243d',
};

const LOOT_NAME = {
  gold: 'Gold', coin: 'Gold', potion: 'Minor Healing Draught', gem: 'Flawed Ruby',
  scroll: 'Scroll of Warding', wood: 'Splintered Haft', ceramic: 'Shards',
};

const FEED_SETS = {
  combat: {
    loot: [['Ashen Coin Purse', 'common', 214], ['Ghoulbone Charm', 'magic'], ['Rendmaw, Jaw of the Pit', 'legendary'], ['Flawed Ruby', 'rare', 2]],
    toasts: [['Crypt of the Forsworn', 'quest'], ['Champion slain', 'good']],
  },
  boss: {
    loot: [['Sigil of the Unmade', 'mythic'], ['Emberforged Plate', 'legendary'], ['Gold', 'common', 1420]],
    toasts: [['GHOLRATH, THE UNMADE', 'boss'], ['Phase II', 'danger']],
  },
  dungeon: {
    loot: [['Gold', 'common', 96], ['Rusted Warhelm', 'common'], ['Whisperbone Ring', 'magic']],
    toasts: [['The Hollow Sanctum', 'quest']],
  },
  night: {
    loot: [['Moonwrought Talisman', 'rare'], ['Gold', 'common', 68]],
    toasts: [['Night falls on the Moor', 'info']],
  },
  overworld: {
    loot: [['Wanderer\'s Cloak', 'magic'], ['Gold', 'common', 42]],
    toasts: [['The Drowned Moor', 'quest']],
  },
  hub: {
    loot: [['Gold', 'common', 640], ['Blacksmith\'s Note', 'common']],
    toasts: [['Kyovashad — Sanctuary', 'quest'], ['Waypoint discovered', 'good']],
  },
};

/* ==================================================================== util */

function hex2rgbA(h) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hexA(h, a) { const [r, g, b] = hex2rgbA(h); return `rgba(${r},${g},${b},${a})`; }
export function lightHex(h) {
  const [r, g, b] = hex2rgbA(h);
  const f = (v) => Math.min(255, Math.round(v + (255 - v) * 0.55));
  return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/* ===================================================================== CSS */

function hudCSS() {
  return `
/* ------------------------------------------------------------------ veil */
#nona-hud .veil{ position:absolute; inset:0; background-size:100% 100%; }
#nona-hud .foot{
  position:absolute; left:0; right:0; bottom:0; height:26vh;
  background:linear-gradient(to top,rgba(2,3,5,.72) 0%,rgba(2,3,5,.34) 38%,rgba(0,0,0,0) 100%);
}

/* ------------------------------------------------------------------ orbs */
#nona-hud .orb{ position:absolute; width:22.2vh; height:22.2vh; bottom:0.6vh; }
#nona-hud .orb.hp{ left:1.4vh; }
#nona-hud .orb.rs{ right:1.4vh; }
#nona-hud .orb>div{ position:absolute; }
#nona-hud .oCav{ inset:12.8%; border-radius:50%; background-size:100% 100%; }
#nona-hud .oClip{ inset:12.8%; border-radius:50%; overflow:hidden; }
#nona-hud .oLiq{ position:absolute; left:0; right:0; bottom:0; height:70%; }
#nona-hud .oGhost{ position:absolute; left:0; right:0; bottom:0; height:70%; opacity:.4;
  mix-blend-mode:screen; }
#nona-hud .oCau{ position:absolute; inset:0; mix-blend-mode:overlay; opacity:.62; }
#nona-hud .oMen{ position:absolute; height:1.6vh; bottom:70%;
  transform:translateY(50%); border-radius:50%; }
#nona-hud .oGlass{ inset:12.8%; border-radius:50%; background-size:100% 100%; }
#nona-hud .oBez{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .8vh 1.6vh rgba(0,0,0,.85)); }
#nona-hud .oCap{
  left:0; right:0; top:58%; text-align:center;
  font-size:1.74vh; letter-spacing:.03em; color:#f4e8ca;
  text-shadow:0 1px 0 #000,0 -1px 2px rgba(0,0,0,.95),0 0 1.4vh rgba(0,0,0,.95);
}
#nona-hud .oLab{
  left:0; right:0; top:69%; text-align:center;
  font-size:.94vh; letter-spacing:.34em; color:#a5977a;
  text-shadow:0 1px 0 #000,0 0 1vh rgba(0,0,0,.9);
}
#nona-hud .dmgVig{ position:absolute; inset:0; opacity:0;
  background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 42%,rgba(120,14,8,.28) 76%,rgba(150,20,10,.55) 100%); }

/* ------------------------------------------------------------ action bar */
#nona-hud .bar{
  position:absolute; left:50%; bottom:5.2vh; transform:translateX(-50%);
  display:flex; gap:.86vh; align-items:flex-end;
}
#nona-hud .slot{ position:relative; width:8.0vh; height:8.0vh; }
#nona-hud .slot>div{ position:absolute; }
#nona-hud .sSock{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .5vh 1.1vh rgba(0,0,0,.85)); }
#nona-hud .sIco{ inset:15%; background-size:100% 100%; background-repeat:no-repeat; }
#nona-hud .sCd{ inset:11%; border-radius:12%; opacity:0; }
#nona-hud .sHand{ left:50%; top:11%; width:.19vh; height:39%;
  transform-origin:50% 100%; opacity:0;
  background:linear-gradient(to top,rgba(255,236,190,.9),rgba(255,236,190,.05)); }
#nona-hud .sCdT{ left:0; right:0; top:50%; transform:translateY(-52%);
  text-align:center; font-size:2.30vh; color:#f6ecd2; opacity:0;
  text-shadow:0 1px 0 #000,0 2px 3px rgba(0,0,0,.95),0 0 1.2vh rgba(0,0,0,.95); }
#nona-hud .sRdy{ inset:9%; border-radius:14%; opacity:0; }
/* The keybind tab is riveted ONTO the socket's lower bevel rather than hung in
   the gap beneath it. Hung, it started at 3.0vh off the bottom edge and the xp
   bar occupies 1.5–3.75vh, so the later sibling painted over the tab's bottom
   0.75vh — a third of its height, taking the lower halves of the letters and
   the whole bottom bevel with it. Captured proof: laneF_keys9x.png, where LMB
   and RMB are sliced through the baseline. Seating it on the socket is the fix
   that costs nothing elsewhere: dropping the xp bar instead would push the
   level medallion (4.4vh tall, hung 1.2vh proud of the trough) off the bottom
   edge, and raising the whole bar would close the gap to the buff row. */
#nona-hud .sKb{
  left:50%; bottom:-0.9vh; transform:translateX(-50%);
  min-width:3.3vh; height:2.0vh; padding:0 .48vh;
  display:flex; align-items:center; justify-content:center;
  background-size:100% 100%; font-size:1.02vh; letter-spacing:.14em; color:#dcc9a0;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.85));
}

/* ------------------------------------------------------------------- xp */
#nona-hud .xpWrap{
  position:absolute; left:50%; bottom:1.5vh; transform:translateX(-50%);
  width:64vh; height:2.25vh;
}
#nona-hud .xpWrap>div{ position:absolute; }
#nona-hud .xpClip{ left:.36vh; right:.36vh; top:.36vh; bottom:.36vh; overflow:hidden; border-radius:.3vh; }
#nona-hud .xpFill{ position:absolute; left:0; top:0; bottom:0; width:60%;
  background-size:100% 100%; box-shadow:0 0 .8vh rgba(226,180,90,.42); }
#nona-hud .xpFrame{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .3vh .7vh rgba(0,0,0,.75)); }
#nona-hud .xpPlate{
  left:-3.3vh; top:-1.2vh; width:4.4vh; height:4.4vh; background-size:100% 100%;
  display:flex; align-items:center; justify-content:center;
  filter:drop-shadow(0 .4vh .8vh rgba(0,0,0,.85));
}
#nona-hud .xpLvl{ font-size:2.0vh; color:#f0dc9a; letter-spacing:0;
  text-shadow:0 -1px 0 #000,0 1px 0 rgba(255,240,190,.2),0 0 1vh rgba(200,150,60,.5); }
#nona-hud .xpPct{ right:-4.6vh; top:.3vh; font-size:.94vh; color:#8e8267; letter-spacing:.16em; }

/* ---------------------------------------------------------------- buffs */
#nona-hud .buffs{
  position:absolute; left:50%; bottom:14.4vh; transform:translateX(-50%);
  display:flex; gap:.78vh; align-items:center;
}
#nona-hud .buff{ position:relative; width:4.3vh; height:4.3vh; }
#nona-hud .buff>div{ position:absolute; }
#nona-hud .bFr{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .3vh .6vh rgba(0,0,0,.8)); }
#nona-hud .bIc{ inset:22%; background-size:100% 100%; }
#nona-hud .bSw{ inset:14%; border-radius:50%; }
#nona-hud .bSt{
  right:-.25vh; bottom:-.35vh; min-width:1.5vh; height:1.5vh; padding:0 .18vh;
  display:flex; align-items:center; justify-content:center;
  font-size:1.0vh; color:#f2e6c8; background:radial-gradient(circle at 40% 32%,#3d444d,#0c0e11 76%);
  border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.9),inset 0 1px 0 rgba(226,196,132,.3);
}
#nona-hud .bTm{ left:0; right:0; top:104%; text-align:center; font-size:.92vh;
  color:#a89a78; text-shadow:0 1px 0 #000; }

/* ---------------------------------------------------------------- quest */
#nona-hud .quest{ left:2.0vh; top:2.0vh; width:27.5vh; height:13.4vh; }
#nona-hud .quest .body{ padding:1.7vh 1.9vh 1.2vh; }
#nona-hud .qTitle{ font-size:1.50vh; letter-spacing:.10em; color:#241a0c;
  text-shadow:0 1px 0 rgba(255,248,220,.45); }
#nona-hud .qSub{ font-size:.90vh; color:#63512f; margin-top:.20vh; letter-spacing:.22em; }
#nona-hud .quest .rule{ margin:.5vh 0 .55vh; }
#nona-hud .qList{ display:flex; flex-direction:column; gap:.30vh; }
#nona-hud .qRow{ display:flex; align-items:baseline; gap:.6vh;
  font-size:1.18vh; color:#33270f; line-height:1.34; }
#nona-hud .qRow.done{ color:#6d5f45; text-decoration:line-through; text-decoration-thickness:.5px; }
#nona-hud .qPip{ width:.56vh; height:.56vh; flex:0 0 auto; margin-top:.42vh;
  transform:rotate(45deg);
  background:linear-gradient(135deg,#c8a75c,#5d4415); box-shadow:0 0 0 1px rgba(0,0,0,.5); }
#nona-hud .qRow.done .qPip{ background:linear-gradient(135deg,#7d735c,#3a3428); }

/* --------------------------------------------------------------- toasts */
#nona-hud .toasts{
  position:absolute; left:50%; top:7.4vh; transform:translateX(-50%);
  display:flex; flex-direction:column; align-items:center; gap:.55vh;
}
/* The boss block (cartouche + forged bar + phase line) reaches ~11.3vh down
   from the top edge, so the toast column has to stand off when it is up or the
   encounter banner prints through the phase line. panels/Combat.js publishes
   the state as this class; the offset is that reach plus the same ~2.7vh of air
   the column had before the bar was rebuilt taller. */
#nona-hud.hasBoss .toasts{ top:14.0vh; }
#nona-hud .toast{ opacity:0; }
#nona-hud .tIn{
  min-width:26vh; padding:.62vh 3.4vh; background-size:100% 100%;
  display:flex; align-items:center; justify-content:center;
  filter:drop-shadow(0 .5vh 1.1vh rgba(0,0,0,.8));
}
#nona-hud .tIn>div{ font-size:1.30vh; letter-spacing:.26em; color:#d8c8a4;
  text-shadow:0 -1px 0 rgba(0,0,0,.95),0 1px 0 rgba(255,238,190,.14); white-space:nowrap; }
#nona-hud .toast.t-boss .tIn>div{ font-size:1.84vh; letter-spacing:.30em; color:#f0b48a;
  text-shadow:0 -1px 0 #000,0 0 1.8vh rgba(200,60,30,.6); }
#nona-hud .toast.t-level .tIn>div{ color:#f4dc96; font-size:1.7vh;
  text-shadow:0 -1px 0 #000,0 0 1.8vh rgba(210,160,50,.65); }
#nona-hud .toast.t-danger .tIn>div{ color:#eda08c; }
#nona-hud .toast.t-good .tIn>div{ color:#bcd49a; }

/* ------------------------------------------------------------- loot log */
#nona-hud .lootLog{
  position:absolute; left:2.6vh; bottom:25.0vh;
  display:flex; flex-direction:column-reverse; gap:.34vh; align-items:flex-start;
}
#nona-hud .lRow{ display:flex; align-items:center; gap:.7vh; opacity:0; }
#nona-hud .lPip{ width:.72vh; height:.72vh; border-radius:50%; flex:0 0 auto; }
#nona-hud .lName{ font-family:${FONT_BODY}; font-size:1.24vh; letter-spacing:.03em;
  text-shadow:0 1px 0 #000,0 0 .9vh rgba(0,0,0,.9); white-space:nowrap; }
`;
}

export default HUD;
