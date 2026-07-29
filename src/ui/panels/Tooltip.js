/**
 * SANCTUM — item tooltip
 * ---------------------------------------------------------------------------
 * The single most-read element in an action RPG, so it is fully authored:
 * an ornate iron frame over dark leather, a rarity-coloured title with the item
 * icon in its own cast socket, an item-power plate, a hairline gold divider
 * under the type line, the primary stat set in large didone numerals, affix
 * lines in rarity colour with the values picked out brighter, a legendary
 * power block on parchment, a socket row with real cabochons, and flavour text
 * in a true italic.
 */

import { rarityOf, FONT_ARCANE, FONT_DISPLAY, FONT_NUM } from '../UITheme.js';
import { mk, sty, txt, fmt } from './Widgets.js';
import { makeItem } from './Items.js';

export class Tooltip {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.orn = hud.orn;
    this.item = null;
    this.anchor = { x: 100.4, y: 20.5 };   // vh from left / top
  }

  build() {
    const p = this.hud.skins.panel(this.hud.root, 'ttip auto hide', {
      kind: 'leather', frame: 'iron', band: 14, chamfer: 19, ornament: 'heavy',
      seed: 29, fieldScale: 0.75, filigree: 0.13, rivetGap: 46,
      vignette: 0.44, fieldLift: 0.10, rake: 0.075,
    });
    this.panel = p;
    this.root = p.root;
    const b = p.body;

    /* --- head: icon socket + title block --- */
    const head = mk('div', 'ttHead', b);
    const sockWrap = mk('div', 'ttSockWrap', head);
    this.sock = mk('div', 'ttSock', sockWrap);
    this.sock.style.backgroundImage = `url("${this.atlas.socketURI(200, { tag: 'tt', seed: 61, cham: 0.20, band: 0.11 })}")`;
    this.glow = mk('div', 'ttGlow', sockWrap);
    this.icon = mk('div', 'ttIcon', sockWrap);
    const titleBlock = mk('div', 'ttTitles', head);
    this.title = txt('div', 'ttName', '', titleBlock);
    this.subtitle = txt('div', 'ttType eng', '', titleBlock);
    this.powerRow = mk('div', 'ttPowerRow', titleBlock);
    this.powerPlate = mk('div', 'ttPowerPlate', this.powerRow);
    this.powerPlate.style.backgroundImage = `url("${this.orn.plate(220, 64, { tag: 'pw', metal: 'bronze', cham: 12 })}")`;
    this.power = txt('span', 'ttPower num', '', this.powerPlate);
    this.upgrade = txt('span', 'ttUpg eng', '', this.powerRow);

    mk('div', 'rule ttRule', b);

    /* --- primary stat --- */
    this.primary = mk('div', 'ttPrimary', b);
    this.pBig = txt('div', 'ttBig num', '', this.primary);
    this.pLabel = txt('div', 'ttBigLabel eng', '', this.primary);
    this.pSubs = mk('div', 'ttSubs', this.primary);

    this.rule2 = mk('div', 'rule ttRule', b);

    /* --- affixes --- */
    this.affixWrap = mk('div', 'ttAffix', b);

    /* --- legendary power, on its own parchment strip --- */
    this.aspect = mk('div', 'ttAspect hide', b);
    this.aspectSkin = mk('canvas', 'ttAspectSkin', this.aspect);
    this.aspectHead = txt('div', 'ttAspectHead eng', 'LEGENDARY ASPECT', this.aspect);
    this.aspectText = txt('div', 'ttAspectText', '', this.aspect);
    this.hud.skins.items.push({
      root: this.aspect, skin: this.aspectSkin, kind: 'custom', opts: {},
      draw: (ctx, w, h) => this._paintAspect(ctx, w, h),
    });

    /* --- sockets --- */
    this.sockRow = mk('div', 'ttSockets', b);

    /* --- flavour + footer --- */
    this.rule3 = mk('div', 'rule ttRule', b);
    this.flavour = txt('div', 'ttFlav flav', '', b);
    const foot = mk('div', 'ttFoot', b);
    this.req = txt('span', 'ttReq eng', '', foot);
    this.sell = txt('span', 'ttSell num', '', foot);

    this._injectCSS();
  }

  /* --------------------------------------------------------------- content */

  setItem(item) {
    this.item = item;
    if (!item || !this.root) { this.root?.classList.add('hide'); return; }
    const r = item.rar ?? rarityOf(item.rarity);

    this.icon.style.backgroundImage = `url("${this.atlas.itemIconURI(200, item.icon, item.rarity, 3)}")`;
    this.glow.style.background =
      `radial-gradient(circle at 50% 50%, ${hexA(r.glow, 0.44)} 0%, ${hexA(r.glow, 0.13)} 52%, rgba(0,0,0,0) 78%)`;

    this.title.textContent = item.name;
    this.title.style.color = r.text;
    this.title.style.fontFamily = (item.rarity === 'legendary' || item.rarity === 'mythic') ? FONT_ARCANE : FONT_DISPLAY;
    this.title.style.fontSize = item.name.length > 24 ? '1.70vh' : '2.02vh';
    this.title.style.textShadow =
      `0 -1px 0 rgba(0,0,0,.95),0 1px 0 rgba(0,0,0,.8),0 0 1.7vh ${hexA(r.glow, 0.60)}`;
    this.subtitle.textContent = `${r.label} ${item.type}`;
    this.subtitle.style.color = hexA(r.line, 0.74);

    this.power.textContent = String(item.power);
    this.upgrade.textContent = `Upgrade ${item.upgrade}/5`;

    /* primary */
    const big = item.stats.find((s) => s.big);
    if (big) {
      this.pBig.textContent = big.value;
      this.pLabel.textContent = big.label;
      this.primary.classList.remove('hide');
    } else this.primary.classList.add('hide');
    this.pSubs.textContent = '';
    for (const s of item.stats) {
      if (!s.sub) continue;
      txt('div', 'ttSub', s.value ? `${s.label}   ${s.value}` : s.label, this.pSubs);
    }

    /* affixes */
    this.affixWrap.textContent = '';
    for (const a of item.affixes) {
      const row = mk('div', `ttAff${a.greater ? ' greater' : ''}`, this.affixWrap);
      const pip = mk('div', 'ttPip', row);
      pip.style.background = a.greater
        ? 'linear-gradient(135deg,#f6e3a8,#a4752a)'
        : `linear-gradient(135deg,${r.line},${r.deep})`;
      const t = txt('span', 'ttAffT', '', row);
      t.style.color = a.greater ? '#f0dc9a' : r.text;
      /* pick the numeral out brighter than the words */
      t.innerHTML = escapeHTML(a.text).replace(/([+\-]?\d[\d.,]*%?)/g,
        `<b style="color:#f6eed6;font-family:${FONT_NUM};font-weight:600">$1</b>`);
    }

    /* aspect */
    if (item.powerLine) {
      this.aspect.classList.remove('hide');
      this.aspectText.innerHTML = escapeHTML(item.powerLine).replace(/(\d[\d.]*%?)/g,
        `<b style="color:#1e1608;font-family:${FONT_NUM};font-weight:700">$1</b>`);
    } else this.aspect.classList.add('hide');

    /* sockets */
    this.sockRow.textContent = '';
    if (item.sockets.length) {
      const lbl = txt('span', 'ttSockLbl eng', 'Sockets', this.sockRow);
      lbl.style.color = '#8e8267';
      for (const s of item.sockets) {
        const e = mk('div', 'ttGemSock', this.sockRow);
        e.style.backgroundImage = `url("${this.atlas.socketURI(96, { tag: 'gem', seed: 77, cham: 0.28, band: 0.16, rim: 0 })}")`;
        if (s.filled) {
          const g = mk('div', 'ttGem', e);
          g.style.backgroundImage = `url("${this._gemURI(s.gem)}")`;
        }
      }
    }

    this.flavour.textContent = item.flavour ?? '';
    this.flavour.classList.toggle('hide', !item.flavour);
    this.rule3.classList.toggle('hide', !item.flavour);
    this.req.textContent = `Requires Level ${item.reqLevel}`;
    this.sell.textContent = `${fmt(item.sell)} g`;

    this.root.classList.remove('hide');
    this.hud._repaintSoon = 2;
  }

  _gemURI(col) {
    return this.atlas.uri(`ttgem:${col}`, 96, 96, (ctx, S) => {
      this.atlas.gem(ctx, S * 0.5, S * 0.5, S * 0.32, col);
    });
  }

  _paintAspect(ctx, w, h) {
    const a = this.atlas;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    a.material(ctx, 0, 0, w, h, 'vellum', { seed: 19, scale: 0.5 });
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,240,200,0.16)');
    g.addColorStop(0.5, 'rgba(40,26,6,0.10)');
    g.addColorStop(1, 'rgba(24,14,2,0.40)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.restore();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(150,112,44,0.55)';
    ctx.strokeRect(0.6, 0.6, w - 1.2, h - 1.2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.moveTo(1, 1.6); ctx.lineTo(w - 1, 1.6); ctx.stroke();
  }

  /* -------------------------------------------------------------- lifecycle */

  applyScenario(name) {
    if (!this.root) return;
    if (name === 'inventory') {
      const item = makeItem(this.engine, 4207, { slot: 'weapon', rarity: 'legendary', power: 878, level: 62 });
      this.setItem(item);
      this._place();
    } else {
      this.root.classList.add('hide');
    }
  }

  setScenario(name) { this.applyScenario(name); }

  _place() {
    if (!this.root) return;
    this.root.style.left = `${this.anchor.x}vh`;
    this.root.style.top = `${this.anchor.y}vh`;
  }

  resize() { this._place(); }
  update() { /* static; content is written on change only */ }
  dispose() { }

  /* ================================================================== CSS */

  _injectCSS() {
    if (document.getElementById('sanctum-hud-ttip')) return;
    const s = document.createElement('style');
    s.id = 'sanctum-hud-ttip';
    s.textContent = `
#sanctum-hud .ttip{ width:34.5vh; }
#sanctum-hud .ttip .body{ padding:2.1vh 2.3vh 2.6vh; display:flex; flex-direction:column; }
#sanctum-hud .ttip>canvas.skin{ filter:drop-shadow(0 1.6vh 3.0vh rgba(0,0,0,.9)); }

#sanctum-hud .ttHead{ display:flex; gap:1.0vh; align-items:flex-start; }
#sanctum-hud .ttSockWrap{ position:relative; width:6.6vh; height:6.6vh; flex:0 0 auto; }
#sanctum-hud .ttSock{ position:absolute; inset:0; background-size:100% 100%; }
#sanctum-hud .ttIcon{ position:absolute; inset:13%; background-size:100% 100%;
  background-repeat:no-repeat; }
#sanctum-hud .ttGlow{ position:absolute; inset:-16%; pointer-events:none; }
#sanctum-hud .ttTitles{ flex:1 1 auto; min-width:0; padding-top:.15vh; }
#sanctum-hud .ttName{ letter-spacing:.055em; line-height:1.16; text-transform:none; }
#sanctum-hud .ttType{ font-size:.98vh; letter-spacing:.16em; margin-top:.48vh; line-height:1.35; }
#sanctum-hud .ttPowerRow{ display:flex; align-items:center; gap:.7vh; margin-top:.68vh; }
#sanctum-hud .ttPowerPlate{ height:1.95vh; min-width:5.4vh; padding:0 .6vh;
  display:flex; align-items:center; justify-content:center; background-size:100% 100%;
  filter:drop-shadow(0 .2vh .4vh rgba(0,0,0,.7)); }
#sanctum-hud .ttPowerPlate:before{ content:'IP'; font-family:${FONT_DISPLAY}; font-size:.78vh;
  letter-spacing:.16em; color:#a08a5e; margin-right:.42vh; }
#sanctum-hud .ttPower{ font-size:1.28vh; color:#f0dc9a; letter-spacing:.03em;
  text-shadow:0 -1px 0 #000,0 1px 0 rgba(255,235,180,.16); }
#sanctum-hud .ttUpg{ font-size:.84vh; letter-spacing:.18em; color:#cbbb94;
  text-shadow:0 -1px 0 rgba(0,0,0,.85),0 1px 0 rgba(0,0,0,.6); }

#sanctum-hud .ttRule{ margin:1.0vh 0 .85vh; }

#sanctum-hud .ttBig{ font-size:2.9vh; line-height:1; color:#f2e8cc; letter-spacing:.01em;
  text-shadow:0 -1px 0 #000,0 2px 0 rgba(0,0,0,.7),0 1px 0 rgba(255,240,200,.12); }
#sanctum-hud .ttBigLabel{ font-size:.90vh; letter-spacing:.26em; color:#d3c49c; margin-top:.30vh;
  text-shadow:0 -1px 0 rgba(0,0,0,.9),0 1px 0 rgba(0,0,0,.65); }
#sanctum-hud .ttSubs{ margin-top:.62vh; display:flex; flex-direction:column; gap:.20vh; }
#sanctum-hud .ttSub{ font-size:1.14vh; letter-spacing:.02em; color:#ddd0ae;
  text-shadow:0 1px 1px rgba(0,0,0,.75); }

#sanctum-hud .ttAffix{ display:flex; flex-direction:column; gap:.38vh; }
#sanctum-hud .ttAff{ position:relative; display:flex; gap:.62vh; align-items:baseline;
  font-size:1.20vh; line-height:1.36; letter-spacing:.012em; }
#sanctum-hud .ttPip{ width:.50vh; height:.50vh; flex:0 0 auto; margin-top:.46vh;
  transform:rotate(45deg); box-shadow:0 0 0 1px rgba(0,0,0,.6); }
#sanctum-hud .ttAff.greater{ font-size:1.28vh; }
#sanctum-hud .ttAff.greater .ttPip{ box-shadow:0 0 .5vh rgba(226,180,90,.7),0 0 0 1px rgba(0,0,0,.6); }

#sanctum-hud .ttAspect{ position:relative; margin-top:1.05vh; padding:.9vh 1.0vh .95vh; }
#sanctum-hud .ttAspectSkin{ position:absolute; inset:0; width:100%; height:100%; display:block; }
#sanctum-hud .ttAspectHead{ position:relative; font-size:.82vh; letter-spacing:.26em;
  color:#6b4f18; margin-bottom:.36vh; }
#sanctum-hud .ttAspectText{ position:relative; font-size:1.14vh; line-height:1.42; color:#3a2c14;
  font-style:italic; }

#sanctum-hud .ttSockets{ display:flex; align-items:center; gap:.5vh; margin-top:1.0vh; }
#sanctum-hud .ttSockLbl{ font-size:.82vh; letter-spacing:.24em; margin-right:.3vh; }
#sanctum-hud .ttGemSock{ position:relative; width:2.0vh; height:2.0vh; background-size:100% 100%; }
#sanctum-hud .ttGem{ position:absolute; inset:6%; background-size:100% 100%; }

#sanctum-hud .ttFlav{ font-size:1.14vh; line-height:1.44; color:#c2b391;
  text-shadow:0 1px 1px rgba(0,0,0,.7); }
#sanctum-hud .ttFoot{ display:flex; justify-content:space-between; align-items:baseline;
  margin-top:1.05vh; }
#sanctum-hud .ttReq{ font-size:.86vh; letter-spacing:.18em; color:#c0b18f;
  text-shadow:0 -1px 0 rgba(0,0,0,.85); }
#sanctum-hud .ttSell{ font-size:1.02vh; color:#e2c882; text-shadow:0 1px 1px rgba(0,0,0,.7); }
`;
    document.head.appendChild(s);
  }
}

function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hexA(h, a) {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default Tooltip;
