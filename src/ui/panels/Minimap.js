/**
 * SANCTUM — Minimap
 * ---------------------------------------------------------------------------
 * A real top-down render of the live dungeon: the plan is rasterised once from
 * `Dungeon.layout.open` (the same occupancy grid the geometry was built from),
 * so the map is the level, not a decoration. Exterior scenarios get a
 * procedural terrain plate from the same deterministic noise the world uses.
 *
 * The plate is drawn once per scenario into an offscreen canvas and then
 * *panned by CSS background-position* each frame, so per-frame cost is two
 * style writes plus one per visible blip — no canvas work in the hot loop.
 */

import { fbm2, hash2 } from '../../core/Rand.js';
import { mk, txt, clamp, clamp01 } from './Widgets.js';

const MAX_BLIPS = 16;
const MAP_PX = 1024;

export class Minimap {
  constructor(hud) {
    this.hud = hud;
    this.engine = hud.engine;
    this.atlas = hud.atlas;
    this.orn = hud.orn;
    this.visible = true;
    this.windowM = 44;                 // metres across the visible disc
    this.origin = { x: -44, z: -44 };
    this.footprint = 88;
  }

  build() {
    const root = this.hud.root;
    this.root = mk('div', 'mmap', root);
    this.plate = mk('div', 'mmPlate', this.root);
    this.map = mk('div', 'mmMap', this.plate);
    this.blipWrap = mk('div', 'mmBlips', this.plate);
    this.arrow = mk('div', 'mmArrow', this.plate);
    this.arrow.style.backgroundImage = `url("${this.orn.playerArrow(80)}")`;
    this.fog = mk('div', 'mmFog', this.plate);
    this.frame = mk('div', 'mmFrame', this.root);
    this.frame.style.backgroundImage = `url("${this.orn.circleFrame(420, { tag: 'mm' })}")`;
    this.label = txt('div', 'mmLabel eng', 'THE HOLLOW SANCTUM', this.root);
    this.coord = txt('div', 'mmCoord num', '', this.root);

    this.blips = [];
    for (let i = 0; i < MAX_BLIPS; i++) {
      const b = mk('div', 'mmBlip', this.blipWrap);
      b.style.opacity = '0';
      this.blips.push(b);
    }

    this.cv = document.createElement('canvas');
    this.cv.width = MAP_PX; this.cv.height = MAP_PX;
    this._injectCSS();
    this.rebuild();
  }

  setVisible(on) {
    this.visible = !!on;
    this.root?.classList.toggle('hide', !on);
  }

  resize() { /* CSS-driven; the plate is resolution independent */ }

  /* ============================================================== rebuild */

  rebuild() {
    if (!this.cv) return;
    const ctx = this.cv.getContext('2d');
    const dun = this.engine.get('dungeon');
    const layout = dun?.layout ?? null;
    const name = this.engine.scenario?.name ?? 'combat';
    try {
      if (layout && layout.open && layout.W) this._drawPlan(ctx, layout);
      else if (dun?.rooms?.length) this._drawArena(ctx, dun);
      else this._drawTerrain(ctx, name);
    } catch (e) { this._drawTerrain(ctx, name); }

    const uri = this.cv.toDataURL('image/png');
    if (this.map) this.map.style.backgroundImage = `url("${uri}")`;
    if (this.label) this.label.textContent = (ZONE[name] ?? 'UNCHARTED').toUpperCase();
  }

  /* ------------------------------------------------------------- plan draw */

  _drawPlan(ctx, layout) {
    const W = layout.W;
    const P = MAP_PX;
    const cs = P / W;
    this.footprint = layout.footprint ?? W * (layout.cell ?? 0.5);
    this.origin = { x: layout.originX ?? -this.footprint * 0.5, z: layout.originZ ?? -this.footprint * 0.5 };
    this.windowM = 46;

    /* --- rock mass: dark, mottled, so the plan reads as carved out of stone */
    ctx.clearRect(0, 0, P, P);
    const rockG = ctx.createRadialGradient(P * 0.42, P * 0.38, P * 0.05, P * 0.5, P * 0.5, P * 0.72);
    rockG.addColorStop(0, '#15181d');
    rockG.addColorStop(1, '#080a0d');
    ctx.fillStyle = rockG;
    ctx.fillRect(0, 0, P, P);
    this.atlas.layer(ctx, 'craze', { seed: 5, mode: 'overlay', alpha: 0.30, scale: 3.2 });
    this.atlas.layer(ctx, 'grain', { seed: 9, mode: 'overlay', alpha: 0.18, scale: 1.4 });

    const open = layout.open;
    const isOpen = (i, j) => i >= 0 && j >= 0 && i < W && j < W && open[j * W + i] === 1;

    /* --- floor: warm stone, per-cell value break-up so it never reads flat */
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        if (open[j * W + i] !== 1) continue;
        const n = fbm2(i * 0.11, j * 0.11, { octaves: 3, seed: 17 });
        const g = 62 + n * 44;
        ctx.fillStyle = `rgb(${Math.round(g * 1.06)},${Math.round(g * 0.97)},${Math.round(g * 0.82)})`;
        ctx.fillRect(i * cs - 0.35, j * cs - 0.35, cs + 0.7, cs + 0.7);
      }
    }

    /* --- rooms get a slightly warmer field + a hairline gold border */
    for (const r of layout.rooms ?? []) {
      const x = r.i0 * cs, y = r.j0 * cs, w = (r.i1 - r.i0) * cs, h = (r.j1 - r.j0) * cs;
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      const rg = ctx.createLinearGradient(x, y, x + w * 0.3, y + h);
      rg.addColorStop(0, 'rgba(255,236,196,0.22)');
      rg.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.fillStyle = rg;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(190,152,80,0.30)';
      ctx.strokeRect(x + 0.7, y + 0.7, w - 1.4, h - 1.4);
    }

    /* --- wall edges: dark cut outside, catch-light inside */
    ctx.lineCap = 'butt';
    for (let j = 0; j < W; j++) {
      for (let i = 0; i < W; i++) {
        if (open[j * W + i] !== 1) continue;
        const x0 = i * cs, y0 = j * cs, x1 = x0 + cs, y1 = y0 + cs;
        const edge = (ax, ay, bx, by, nx, ny) => {
          ctx.beginPath();
          ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
          ctx.lineWidth = 2.6; ctx.strokeStyle = 'rgba(4,5,8,0.92)'; ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ax + nx, ay + ny); ctx.lineTo(bx + nx, by + ny);
          ctx.lineWidth = 1.0; ctx.strokeStyle = 'rgba(214,190,140,0.30)'; ctx.stroke();
        };
        if (!isOpen(i, j - 1)) edge(x0, y0, x1, y0, 0, 1.5);
        if (!isOpen(i, j + 1)) edge(x0, y1, x1, y1, 0, -1.5);
        if (!isOpen(i - 1, j)) edge(x0, y0, x0, y1, 1.5, 0);
        if (!isOpen(i + 1, j)) edge(x1, y0, x1, y1, -1.5, 0);
      }
    }

    /* --- points of interest: a gold lozenge at every room centre */
    for (const r of layout.rooms ?? []) {
      const cx = (r.i0 + r.i1) * 0.5 * cs, cy = (r.j0 + r.j1) * 0.5 * cs;
      const big = (r.i1 - r.i0) * (r.j1 - r.j0) > 900;
      this._poi(ctx, cx, cy, big ? 7 : 4.6, big ? '#e0c74e' : '#b28c3c');
    }

    this._finishPlate(ctx, P);
  }

  _drawArena(ctx, dun) {
    const P = MAP_PX;
    const b = dun.bounds ?? { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) || 80;
    this.footprint = span;
    this.origin = { x: b.minX, z: b.minZ };
    this.windowM = span * 0.55;
    ctx.clearRect(0, 0, P, P);
    ctx.fillStyle = '#0a0b0e';
    ctx.fillRect(0, 0, P, P);
    /* a circular arena floor with a broken rim */
    const c = P * 0.5;
    const rr = P * 0.40;
    const g = ctx.createRadialGradient(c * 0.86, c * 0.8, rr * 0.1, c, c, rr);
    g.addColorStop(0, '#6a5236');
    g.addColorStop(0.6, '#40331f');
    g.addColorStop(1, '#1c1610');
    ctx.beginPath(); ctx.arc(c, c, rr, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(4,5,8,0.9)'; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(224,120,50,0.35)';
    for (let i = 0; i < 14; i++) {
      const a0 = (i / 14) * Math.PI * 2 + hash2(i, 3, 7) * 0.1;
      ctx.beginPath(); ctx.arc(c, c, rr - 3, a0, a0 + 0.28); ctx.stroke();
    }
    /* radiating cracks with lava in them */
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.3;
      ctx.beginPath();
      ctx.moveTo(c, c);
      let x = c, y = c;
      for (let k = 1; k <= 5; k++) {
        const t = (k / 5) * rr;
        const j = (hash2(i, k, 11) - 0.5) * 0.5;
        x = c + Math.cos(a + j) * t; y = c + Math.sin(a + j) * t;
        ctx.lineTo(x, y);
      }
      ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(4,4,6,0.85)'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(226,96,26,0.55)'; ctx.stroke();
    }
    this.atlas.layer(ctx, 'craze', { seed: 12, mode: 'multiply', alpha: 0.35, scale: 2.6 });
    this._poi(ctx, c, c, 8, '#c0392b');
    this._finishPlate(ctx, P);
  }

  _drawTerrain(ctx, name) {
    const P = MAP_PX;
    this.footprint = 200;
    this.origin = { x: -100, z: -100 };
    this.windowM = 92;
    const night = name === 'night';
    ctx.clearRect(0, 0, P, P);
    const step = 2;
    const img = ctx.createImageData(P, P);
    const d = img.data;
    for (let y = 0; y < P; y += step) {
      for (let x = 0; x < P; x += step) {
        const u = x / P * 6, v = y / P * 6;
        const h = fbm2(u, v, { octaves: 5, seed: 31 });
        const wet = fbm2(u * 2.1 + 11, v * 2.1 - 7, { octaves: 3, seed: 57 });
        let r, g, b;
        if (wet > 0.62 && h < 0.52) { r = 26; g = 38; b = 46; }           // standing water
        else {
          const t = clamp01((h - 0.28) / 0.5);
          r = Math.round(30 + t * 66);
          g = Math.round(32 + t * 62);
          b = Math.round(26 + t * 44);
        }
        if (night) { r = Math.round(r * 0.62 + 10); g = Math.round(g * 0.66 + 12); b = Math.round(b * 0.86 + 20); }
        for (let j = 0; j < step; j++) {
          for (let i = 0; i < step; i++) {
            const o = ((y + j) * P + (x + i)) * 4;
            d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    /* a road, drawn as a wandering pale ribbon */
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, P * 0.62);
    for (let k = 1; k <= 10; k++) {
      const t = k / 10;
      ctx.lineTo(P * t, P * (0.62 + Math.sin(t * 5.2) * 0.10 + (fbm2(t * 4, 2, { octaves: 2, seed: 5 }) - 0.5) * 0.10));
    }
    ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(6,7,9,0.6)'; ctx.stroke();
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(148,132,98,0.55)'; ctx.stroke();
    ctx.restore();
    this.atlas.layer(ctx, 'craze', { seed: 21, mode: 'multiply', alpha: 0.26, scale: 3.4 });
    this.atlas.layer(ctx, 'grain', { seed: 4, mode: 'overlay', alpha: 0.20, scale: 1.2 });
    for (const [px, py, col] of [[0.30, 0.34, '#b28c3c'], [0.68, 0.58, '#b28c3c'], [0.50, 0.50, '#e0c74e']]) {
      this._poi(ctx, P * px, P * py, px === 0.5 ? 7 : 5, col);
    }
    this._finishPlate(ctx, P);
  }

  _poi(ctx, x, y, r, col) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI * 0.25);
    ctx.beginPath();
    ctx.rect(-r * 0.62, -r * 0.62, r * 1.24, r * 1.24);
    const g = ctx.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#f6e3a8'); g.addColorStop(0.5, col); g.addColorStop(1, '#3a2a0c');
    ctx.fillStyle = g;
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = r * 0.9;
    ctx.fill();
    ctx.lineWidth = 1.1; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
    ctx.restore();
  }

  /** Shared finish: parchment warmth, edge grime, and a vignette. */
  _finishPlate(ctx, P) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    const w = ctx.createRadialGradient(P * 0.42, P * 0.36, P * 0.04, P * 0.5, P * 0.5, P * 0.7);
    w.addColorStop(0, 'rgba(255,226,170,0.20)');
    w.addColorStop(1, 'rgba(60,40,16,0.0)');
    ctx.fillStyle = w; ctx.fillRect(0, 0, P, P);
    ctx.restore();
  }

  /* =============================================================== update */

  update(dt, elapsed) {
    if (!this.visible || !this.map) return;
    const hero = this.engine.get('hero');
    const hx = hero?.position?.x ?? 0;
    const hz = hero?.position?.z ?? 0;

    /* the plate is `footprint` metres wide; scale it so `windowM` metres fill
       the visible disc, then pan so the hero sits at the centre */
    const D = 100;                                    // work in % of the disc
    const scale = (this.footprint / this.windowM) * D;
    const fx = (hx - this.origin.x) / this.footprint;
    const fz = (hz - this.origin.z) / this.footprint;
    this.map.style.backgroundSize = `${scale.toFixed(2)}% ${scale.toFixed(2)}%`;
    this.map.style.backgroundPosition = `${(50 - fx * scale).toFixed(2)}% ${(50 - fz * scale).toFixed(2)}%`;

    const yaw = hero?.yaw ?? 0;
    this.arrow.style.transform = `translate(-50%,-50%) rotate(${(yaw * 180 / Math.PI).toFixed(1)}deg)`;

    if (this.coord) {
      this.coord.textContent = `${hx >= 0 ? 'E' : 'W'}${Math.abs(hx).toFixed(0)}  ${hz >= 0 ? 'S' : 'N'}${Math.abs(hz).toFixed(0)}`;
    }

    /* blips */
    const bes = this.engine.get('bestiary');
    const half = this.windowM * 0.5;
    let n = 0;
    if (bes?.entities) {
      for (const en of bes.entities) {
        if (n >= MAX_BLIPS) break;
        if (!en || en.dead) continue;
        const dx = (en.position.x - hx), dz = (en.position.z - hz);
        const rr = Math.hypot(dx, dz);
        if (rr > half * 0.94) continue;
        const b = this.blips[n++];
        const px = 50 + (dx / this.windowM) * 100;
        const py = 50 + (dz / this.windowM) * 100;
        b.style.left = `${px.toFixed(2)}%`;
        b.style.top = `${py.toFixed(2)}%`;
        const rank = en.rank ?? 'normal';
        const s = rank === 'boss' ? 1.5 : rank === 'champion' ? 1.05 : 0.66;
        const col = rank === 'boss' ? '#e05a2c' : rank === 'champion' ? '#e0c74e' : '#c0392b';
        const pulse = rank === 'normal' ? 1 : 1 + 0.14 * Math.sin(elapsed * 3.6 + n);
        b.style.width = `${(s * pulse).toFixed(2)}vh`;
        b.style.height = `${(s * pulse).toFixed(2)}vh`;
        b.style.background = `radial-gradient(circle at 36% 30%, #fff2d8 0%, ${col} 46%, rgba(20,4,2,.95) 100%)`;
        b.style.boxShadow = `0 0 .5vh ${col}, 0 0 0 1px rgba(0,0,0,.8)`;
        b.style.opacity = '1';
      }
    }
    for (let i = n; i < MAX_BLIPS; i++) this.blips[i].style.opacity = '0';
  }

  dispose() { this.cv = null; }

  /* ================================================================== CSS */

  _injectCSS() {
    if (document.getElementById('sanctum-hud-mmap')) return;
    const s = document.createElement('style');
    s.id = 'sanctum-hud-mmap';
    s.textContent = `
#sanctum-hud .mmap{ position:absolute; right:2.0vh; top:2.0vh; width:20.5vh; height:20.5vh; }
#sanctum-hud .mmPlate{ position:absolute; inset:9.4%; border-radius:50%; overflow:hidden;
  background:#06070a; }
#sanctum-hud .mmMap{ position:absolute; inset:0; background-repeat:no-repeat;
  image-rendering:auto; }
#sanctum-hud .mmFog{ position:absolute; inset:0;
  background:radial-gradient(circle at 50% 50%,rgba(0,0,0,0) 46%,rgba(3,4,6,.55) 78%,rgba(2,3,5,.9) 100%); }
#sanctum-hud .mmBlips{ position:absolute; inset:0; }
#sanctum-hud .mmBlip{ position:absolute; border-radius:50%; transform:translate(-50%,-50%); }
#sanctum-hud .mmArrow{ position:absolute; left:50%; top:50%; width:2.5vh; height:2.5vh;
  background-size:100% 100%; background-repeat:no-repeat; }
#sanctum-hud .mmFrame{ position:absolute; inset:0; background-size:100% 100%;
  filter:drop-shadow(0 .8vh 1.6vh rgba(0,0,0,.85)); }
#sanctum-hud .mmLabel{ position:absolute; left:50%; bottom:-1.7vh; transform:translateX(-50%);
  font-size:.92vh; letter-spacing:.28em; color:#a8996f; white-space:nowrap;
  text-shadow:0 1px 0 #000,0 0 1vh rgba(0,0,0,.9); }
#sanctum-hud .mmCoord{ position:absolute; left:50%; bottom:-3.3vh; transform:translateX(-50%);
  font-size:.86vh; letter-spacing:.14em; color:#6f6650; white-space:nowrap;
  text-shadow:0 1px 0 #000; }
`;
    document.head.appendChild(s);
  }
}

const ZONE = {
  hub: 'Kyovashad',
  dungeon: 'The Hollow Sanctum',
  combat: 'Crypt of the Forsworn',
  boss: 'The Unmade Throne',
  overworld: 'The Drowned Moor',
  night: 'Moorwatch',
  inventory: 'Kyovashad',
  closeup: 'Kyovashad',
};

export default Minimap;
