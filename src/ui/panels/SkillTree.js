/**
 * SANCTUM — skill tree
 * ---------------------------------------------------------------------------
 * A radial node graph: a keystone at the hub, three branches of clustered
 * octagonal nodes, connected by cast filigree rods. Node frames are cast metal
 * (stone when locked, iron when open, gold when maxed) with a recessed glyph
 * seat; ranked nodes show pips, maxed nodes carry a gold inlay ring and a warm
 * bloom. One node renders its hover tooltip open so the interaction reads in a
 * still frame.
 *
 * The layout is authored, not random — a tree that looks generated looks cheap.
 */

import { FONT_DISPLAY, FONT_NUM } from '../UITheme.js';
import { mk, sty, txt, clamp01 } from './Widgets.js';

/**
 * Nodes in polar coordinates around the panel centre.
 * a = degrees (0 = up, clockwise), r = fraction of the usable radius.
 * st: 'locked' | 'open' | 'ranked' | 'maxed'
 */
const NODES = [
  { id: 'core',    a: 0,    r: 0,    glyph: 'sigil',  col: '#e0c74e', st: 'maxed',  rank: [1, 1], size: 1.45, name: 'Bloodsworn Oath', desc: 'The pact that makes the rest possible.' },

  /* --- branch I: rage (upper left) --- */
  { id: 'r1', a: -60,  r: 0.34, glyph: 'cleave', col: '#d8a04a', st: 'maxed',  rank: [5, 5], link: 'core', name: 'Sundering Cleave', desc: 'Cleave rends in a wider arc.' },
  { id: 'r2', a: -84,  r: 0.68, glyph: 'whirl',  col: '#d8552a', st: 'ranked', rank: [3, 5], link: 'r1',   name: 'Bloodwhirl', desc: 'Spin, rending every enemy caught in the turn.' },
  { id: 'r3', a: -38,  r: 0.68, glyph: 'flame',  col: '#d8552a', st: 'ranked', rank: [2, 3], link: 'r1',   name: 'Unbridled Fury', desc: 'Fury spent above 80 sets your weapon alight.' },
  { id: 'r4', a: -62,  r: 0.99, glyph: 'quake',  col: '#b0813c', st: 'locked', rank: [0, 3], link: 'r2',   name: 'Earthsunder', desc: 'Requires 8 points in Rage.' },

  /* --- branch II: iron (below) --- */
  { id: 'i1', a: 180,  r: 0.34, glyph: 'ward',   col: '#7fa8d8', st: 'maxed',  rank: [3, 3], link: 'core', name: 'Iron Bulwark', desc: 'A shield of will absorbs the next blow.' },
  { id: 'i2', a: 156,  r: 0.68, glyph: 'banner', col: '#c9d6e4', st: 'ranked', rank: [1, 3], link: 'i1',   name: 'War Standard', desc: 'Plant a standard; allies within it take less damage.' },
  { id: 'i3', a: 204,  r: 0.68, glyph: 'thrust', col: '#c9d6e4', st: 'ranked', rank: [4, 5], link: 'i1',   name: 'Impaling Thrust', desc: 'Lunge forward and skewer.' },
  { id: 'i4', a: 180,  r: 0.99, glyph: 'sigil',  col: '#8e6cd8', st: 'locked', rank: [0, 1], link: 'i2',   name: 'Unyielding', desc: 'Requires 10 points in Iron.' },

  /* --- branch III: blood (upper right) --- */
  { id: 'b1', a: 60,   r: 0.34, glyph: 'drain',  col: '#8e6cd8', st: 'maxed',  rank: [5, 5], link: 'core', name: 'Vitae Siphon', desc: 'Draw life from wounded enemies.' },
  { id: 'b2', a: 38,   r: 0.68, glyph: 'bolt',   col: '#6ac08a', st: 'ranked', rank: [2, 5], link: 'b1',   name: 'Grave Chill', desc: 'Siphoned life chills the ground you stand on.' },
  { id: 'b3', a: 84,   r: 0.68, glyph: 'flame',  col: '#a8261c', st: 'locked', rank: [0, 3], link: 'b1',   name: 'Rending Wound', desc: 'Requires 6 points in Blood.' },
  { id: 'b4', a: 62,   r: 0.99, glyph: 'whirl',  col: '#8e6cd8', st: 'locked', rank: [0, 1], link: 'b2',   name: 'Second Heart', desc: 'Requires 12 points in Blood.' },
];

const BRANCH_LABELS = [
  { text: 'RAGE',  a: -60, r: 1.20 },
  { text: 'IRON',  a: 180, r: 1.20 },
  { text: 'BLOOD', a: 60,  r: 1.20 },
];

export class SkillTree {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.orn = hud.orn;
    this.visible = false;
  }

  build() {
    this._injectCSS();
    const p = this.hud.skins.panel(this.hud.root, 'treePnl hide', {
      kind: 'stone', frame: 'iron', band: 19, chamfer: 26, ornament: 'heavy',
      seed: 71, fieldScale: 0.7, filigree: 0.10, rivetGap: 68,
      header: true, headerH: 32, headerGem: '#8e6cd8',
      vignette: 0.40, fieldLift: 0.11, rake: 0.080,
      /* the node graph is set into a sunken bay and the legend sits on a raised
         plinth, so the panel interior has depth instead of being one dark slab */
      wells: [
        { x: 0.048, y: 0.100, w: 0.904, h: 0.620, cham: 22, mat: 'stone', scale: 0.26 },
        { x: 0.220, y: 0.742, w: 0.560, h: 0.040, cham: 6, mat: 'vellum', scale: 0.26, raised: true, seed: 181 },
      ],
    });
    this.panel = p;
    const b = p.body;

    const hd = mk('div', 'tHead', b);
    txt('div', 'tTitle disp', 'PATH OF THE BLOODSWORN', hd);
    const pts = mk('div', 'tPts', b);
    this.ptPlate = mk('div', 'tPtPlate', pts);
    this.ptPlate.style.backgroundImage = `url("${this.orn.plate(180, 60, { tag: 'pts', metal: 'bronze', cham: 12 })}")`;
    txt('span', 'eng tPtLab', 'Points', this.ptPlate);
    txt('span', 'num tPtVal', '4', this.ptPlate);

    /* the graph lives in its own square field so polar maths is simple */
    this.field = mk('div', 'tField', b);
    this.linkWrap = mk('div', 'tLinks', this.field);
    this.nodeWrap = mk('div', 'tNodes', this.field);

    /* ---- links first so nodes sit on top ---- */
    const byId = new Map(NODES.map((n) => [n.id, n]));
    this.linkEls = [];
    for (const n of NODES) {
      if (!n.link) continue;
      const from = byId.get(n.link);
      if (!from) continue;
      const active = n.st !== 'locked';
      const e = mk('div', 'tLink', this.linkWrap);
      e.style.backgroundImage = `url("${this.orn.link(240, 18, active)}")`;
      this.linkEls.push({ el: e, from, to: n, active });
    }

    /* ---- nodes ---- */
    this.nodeEls = NODES.map((n) => {
      const e = mk('div', `tNode ${n.st}`, this.nodeWrap);
      const fr = mk('div', 'tFr', e);
      /* rasterised near its displayed size (~52 px) so the collar's 1-px
         specular pin-line is not averaged away by a 3.5x downscale */
      fr.style.backgroundImage = `url("${this.orn.node(112, n.st === 'ranked' ? 'open' : n.st)}")`;
      const ic = mk('div', 'tIc', e);
      ic.style.backgroundImage = `url("${this.atlas.glyphURI(120, n.glyph, n.st === 'locked' ? '#5c6470' : n.col)}")`;
      const ring = mk('div', 'tRing', e);
      const pip = mk('div', 'tPips', e);
      if (n.rank && n.rank[1] > 1) {
        for (let i = 0; i < n.rank[1]; i++) {
          const d = mk('div', `tPip${i < n.rank[0] ? ' on' : ''}`, pip);
          d.title = '';
        }
      }
      const rk = txt('div', 'tRank num', n.rank ? `${n.rank[0]}/${n.rank[1]}` : '', e);
      if (n.st === 'locked') {
        const lk = mk('div', 'tLock', e);
        lk.style.backgroundImage = `url("${this._lockURI()}")`;
      }
      return { root: e, fr, ic, ring, rk, def: n };
    });

    /* ---- branch labels engraved into the field ---- */
    this.labelEls = BRANCH_LABELS.map((l) => {
      const e = txt('div', 'tBranch eng', l.text, this.field);
      return { el: e, def: l };
    });

    /* ---- legend so the state vocabulary is explicit ---- */
    const leg = mk('div', 'tLegend', b);
    for (const [st, lab] of [['maxed', 'Maxed'], ['open', 'Ranked'], ['locked', 'Locked']]) {
      const it = mk('div', 'tLegIt', leg);
      const ch = mk('div', 'tLegCh', it);
      ch.style.backgroundImage = `url("${this.orn.node(90, st)}")`;
      txt('span', 'eng', lab, it);
    }

    /* ---- one node's tooltip left open so hover reads in a still ---- */
    const tp = this.hud.skins.panel(b, 'tTip auto', {
      kind: 'leather', frame: 'iron', band: 8, chamfer: 12, ornament: 'light', seed: 53,
      fieldScale: 0.7, vignette: 0.48, fieldLift: 0.09, rake: 0.07,
    });
    this.tip = tp;
    const tb = tp.body;
    this.tipName = txt('div', 'tTipName disp', '', tb);
    this.tipType = txt('div', 'tTipType eng', '', tb);
    mk('div', 'rule tTipRule', tb);
    this.tipDesc = txt('div', 'tTipDesc', '', tb);
    this.tipRank = txt('div', 'tTipRank eng', '', tb);

    this._layout();
  }

  /* --------------------------------------------------------------- layout */

  _layout() {
    /* the field is square; place nodes in % so it stays resolution free */
    const R = 37;                                   // % of the field, usable radius
    const pos = new Map();
    for (const n of NODES) {
      const rad = (n.a - 90) * Math.PI / 180;
      const x = 50 + Math.cos(rad) * R * n.r;
      const y = 50 + Math.sin(rad) * R * n.r;
      pos.set(n.id, { x, y });
    }
    this._pos = pos;

    for (let i = 0; i < this.nodeEls.length; i++) {
      const ne = this.nodeEls[i];
      const p = pos.get(ne.def.id);
      const s = (ne.def.size ?? 1);
      ne.root.style.left = `${p.x}%`;
      ne.root.style.top = `${p.y}%`;
      ne.root.style.width = `${(5.8 * s).toFixed(2)}vh`;
      ne.root.style.height = `${(5.8 * s).toFixed(2)}vh`;
    }

    for (const l of this.linkEls) {
      const a = pos.get(l.from.id), b = pos.get(l.to.id);
      /* the field is square in CSS, so % on both axes is isotropic */
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      l.el.style.left = `${a.x}%`;
      l.el.style.top = `${a.y}%`;
      l.el.style.width = `${len}%`;
      l.el.style.transform = `translateY(-50%) rotate(${ang.toFixed(2)}deg)`;
      l.el.style.transformOrigin = '0% 50%';
    }

    for (const l of this.labelEls) {
      const rad = (l.def.a - 90) * Math.PI / 180;
      l.el.style.left = `${50 + Math.cos(rad) * 39 * l.def.r}%`;
      l.el.style.top = `${50 + Math.sin(rad) * 39 * l.def.r}%`;
    }

    /* the open hover tooltip sits under the graph so it never masks a node */
    const n = NODES.find((x) => x.id === 'r2');
    if (this.tip && n) {
      this.tipName.textContent = n.name;
      this.tipType.textContent = 'Core Skill · 25 Fury';
      this.tipDesc.innerHTML = `${n.desc} Deals <b>182%</b> weapon damage per rotation and Fortifies you for <b>8%</b> of Maximum Life on hit.`;
      this.tipRank.textContent = `Rank ${n.rank[0]} of ${n.rank[1]}   ·   hold to rank up`;
    }
  }

  _lockURI() {
    return this.atlas.uri('lock', 64, 64, (ctx, S) => {
      const c = S * 0.5;
      ctx.save();
      ctx.translate(c, c * 1.12);
      ctx.beginPath();
      ctx.arc(0, -S * 0.10, S * 0.16, Math.PI, 0);
      ctx.lineWidth = S * 0.085;
      ctx.strokeStyle = '#6d7580';
      ctx.stroke();
      ctx.beginPath();
      const w = S * 0.44, h = S * 0.30;
      ctx.rect(-w * 0.5, -S * 0.06, w, h);
      const g = ctx.createLinearGradient(0, -S * 0.06, 0, -S * 0.06 + h);
      g.addColorStop(0, '#98a2ad'); g.addColorStop(1, '#3a4148');
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = S * 0.035; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
      ctx.restore();
    });
  }

  /* ------------------------------------------------------------- lifecycle */

  applyScenario(name) {
    if (name !== 'inventory') return;
    this._layout();
    this.hud._repaintSoon = 2;
  }

  setVisible(on) {
    this.visible = !!on;
    this.panel?.root.classList.toggle('hide', !on);
  }

  resize() { this._layout(); }

  update(dt, elapsed) {
    if (!this.visible) return;
    /* maxed nodes breathe; the keystone pulses slower and brighter */
    for (const ne of this.nodeEls) {
      const d = ne.def;
      if (d.st === 'maxed') {
        const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(elapsed * (d.id === 'core' ? 0.9 : 1.6) + d.a * 0.02));
        ne.ring.style.opacity = k.toFixed(3);
        ne.ring.style.boxShadow =
          `0 0 ${(0.7 + k * 1.5).toFixed(2)}vh ${(0.05 + k * 0.2).toFixed(2)}vh rgba(226,180,90,${(0.20 + k * 0.30).toFixed(3)})`;
      } else if (d.st === 'ranked') {
        ne.ring.style.opacity = '0.28';
        ne.ring.style.boxShadow = `0 0 .6vh rgba(180,150,90,.22)`;
      } else {
        ne.ring.style.opacity = '0';
      }
    }
  }

  dispose() { }

  /* ================================================================== CSS */

  _injectCSS() {
    if (document.getElementById('sanctum-hud-tree')) return;
    const s = document.createElement('style');
    s.id = 'sanctum-hud-tree';
    s.textContent = `
#sanctum-hud .treePnl{ left:48.4vh; top:3.4vh; width:50vh; height:76vh; }
#sanctum-hud .treePnl .body{ padding:2.4vh 2.6vh 2.2vh; }
#sanctum-hud .tHead{ text-align:center; padding:0 3.6vh; }
#sanctum-hud .tTitle{ font-size:1.36vh; letter-spacing:.26em; color:#eeddac;
  text-shadow:0 -1px 0 #000,0 2px 2px rgba(0,0,0,.9),0 1px 0 rgba(255,244,200,.20); }
#sanctum-hud .tPts{ display:flex; justify-content:center; margin-top:.9vh; }
#sanctum-hud .tPtPlate{ height:2.1vh; padding:0 .8vh; background-size:100% 100%;
  display:flex; align-items:center; gap:.5vh;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.75)); }
#sanctum-hud .tPtLab{ font-size:.78vh; letter-spacing:.20em; color:#cbb47e;
  text-shadow:0 -1px 0 rgba(0,0,0,.85); }
#sanctum-hud .tPtVal{ font-size:1.24vh; color:#f0dc9a; text-shadow:0 -1px 0 #000; }

#sanctum-hud .tField{ position:relative; width:44.8vh; height:44.8vh; margin:1.4vh auto 0; }
#sanctum-hud .tLinks,#sanctum-hud .tNodes{ position:absolute; inset:0; }
#sanctum-hud .tLink{ position:absolute; height:1.35vh; background-size:100% 100%;
  background-repeat:no-repeat; filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.8)); }

#sanctum-hud .tNode{ position:absolute; transform:translate(-50%,-50%); }
#sanctum-hud .tNode>div{ position:absolute; }
#sanctum-hud .tFr{ inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .4vh .9vh rgba(0,0,0,.85)); }
#sanctum-hud .tIc{ inset:26%; background-size:100% 100%; background-repeat:no-repeat; }
#sanctum-hud .tRing{ inset:2%; border-radius:50%; opacity:0; pointer-events:none; }
#sanctum-hud .tLock{ inset:30%; background-size:100% 100%; background-repeat:no-repeat;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.9)); }
#sanctum-hud .tNode.locked .tIc{ opacity:.34; }
#sanctum-hud .tPips{ left:0; right:0; bottom:-1.05vh; display:flex; gap:.16vh;
  justify-content:center; }
#sanctum-hud .tPip{ width:.34vh; height:.34vh; transform:rotate(45deg);
  background:#22262c; box-shadow:0 0 0 1px rgba(0,0,0,.7); }
#sanctum-hud .tPip.on{ background:linear-gradient(135deg,#f6e3a8,#a4752a);
  box-shadow:0 0 .35vh rgba(226,180,90,.75),0 0 0 1px rgba(0,0,0,.6); }
#sanctum-hud .tRank{ left:-2vh; right:-2vh; bottom:-2.5vh; text-align:center;
  font-size:.86vh; color:#9c9078; text-shadow:0 1px 0 #000; }
#sanctum-hud .tNode.locked .tRank{ color:#6a6353; }

#sanctum-hud .tBranch{ position:absolute; transform:translate(-50%,-50%);
  font-size:1.02vh; letter-spacing:.34em; color:#8a7d5f; white-space:nowrap;
  text-shadow:0 -1px 0 rgba(0,0,0,.9),0 1px 0 rgba(232,206,150,.14); }

#sanctum-hud .tLegend{ display:flex; justify-content:center; align-items:center;
  gap:2.2vh; margin-top:1.15vh; height:2.6vh; }
#sanctum-hud .tLegIt{ display:flex; align-items:center; gap:.55vh; }
#sanctum-hud .tLegCh{ width:1.8vh; height:1.8vh; background-size:100% 100%;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.8)); }
#sanctum-hud .tLegIt span{ font-size:.80vh; letter-spacing:.20em; color:#5a4a26;
  text-shadow:0 1px 0 rgba(255,246,214,.42); }

#sanctum-hud .tTip{ position:relative !important; left:auto !important; top:auto !important;
  width:100%; margin-top:1.4vh; }
#sanctum-hud .tTip .body{ padding:1.3vh 1.5vh 1.2vh; }
#sanctum-hud .tTip>canvas.skin{ filter:drop-shadow(0 1.2vh 2.2vh rgba(0,0,0,.9)); }
#sanctum-hud .tTipName{ font-size:1.26vh; letter-spacing:.10em; color:#f0dc9a;
  text-transform:none; text-shadow:0 -1px 0 #000,0 0 1.2vh rgba(190,140,60,.4); }
#sanctum-hud .tTipType{ font-size:.78vh; letter-spacing:.20em; color:#8e8267; margin-top:.3vh; }
#sanctum-hud .tTipRule{ margin:.6vh 0 .55vh; }
#sanctum-hud .tTipDesc{ font-size:1.04vh; line-height:1.42; color:#bdb094; }
#sanctum-hud .tTipDesc b{ color:#f4ecd4; font-family:${FONT_NUM}; font-weight:600; }
#sanctum-hud .tTipRank{ margin-top:.6vh; font-size:.80vh; letter-spacing:.18em; color:#7f7459; }
`;
    document.head.appendChild(s);
  }
}

export default SkillTree;
