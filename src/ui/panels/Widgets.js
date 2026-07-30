/**
 * THE NINTH VIGIL — UI widget primitives
 * ---------------------------------------------------------------------------
 * Thin DOM helpers plus the "skin registry": every ornate panel in the
 * interface is a <div> with an absolutely-positioned <canvas> behind its
 * content. The canvas is painted by UIAtlas at the element's *real* device
 * pixel size, which is what keeps the ornament crisp at any resolution instead
 * of being a stretched bitmap.
 *
 * Nothing here animates on its own — no CSS transitions, no keyframes. The HUD
 * writes every moving value from `update()` off `engine.clock`, so a captured
 * frame is a pure function of the frame index.
 */

/* ------------------------------------------------------------------ DOM */

export function mk(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

export function sty(e, s) {
  if (typeof s === 'string') { e.style.cssText += s; return e; }
  for (const k in s) e.style[k] = s[k];
  return e;
}

export function txt(tag, cls, str, parent) {
  const e = mk(tag, cls, parent);
  e.textContent = str;
  return e;
}

/** Absolutely position an element with vh-relative box values. */
export function box(e, l, t, w, h) {
  const s = e.style;
  if (l != null) s.left = l;
  if (t != null) s.top = t;
  if (w != null) s.width = w;
  if (h != null) s.height = h;
  return e;
}

/* ------------------------------------------------------------- registry */

/**
 * Builds panels and remembers them so the whole set can be re-rasterised on
 * resize in one pass.
 */
export class SkinSet {
  constructor(atlas) {
    this.atlas = atlas;
    this.items = [];
  }

  /**
   * Create a skinned panel.
   *   parent  — DOM parent
   *   cls     — extra classes
   *   opts    — forwarded to UIAtlas.panel()
   * Returns { root, body } where content goes in `body`.
   */
  panel(parent, cls, opts = {}) {
    const root = mk('div', `pnl ${cls || ''}`.trim(), parent);
    const skin = mk('canvas', 'skin', root);
    const body = mk('div', 'body', root);
    this.items.push({ root, skin, opts, kind: 'panel' });
    return { root, body, skin };
  }

  /** A skinned element whose canvas is painted by a caller-supplied function. */
  custom(parent, cls, draw, opts = {}) {
    const root = mk('div', `pnl ${cls || ''}`.trim(), parent);
    const skin = mk('canvas', 'skin', root);
    const body = mk('div', 'body', root);
    this.items.push({ root, skin, opts, draw, kind: 'custom' });
    return { root, body, skin };
  }

  /** Rasterise every registered skin at its current CSS box. */
  repaint(dpr) {
    const d = dpr ?? Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
    for (const it of this.items) {
      const r = it.root.getBoundingClientRect();
      const w = Math.max(2, r.width), h = Math.max(2, r.height);
      if (!w || !h) continue;
      it.w = w; it.h = h;
      try {
        if (it.kind === 'custom') {
          const W = Math.max(2, Math.round(w * d)), H = Math.max(2, Math.round(h * d));
          it.skin.width = W; it.skin.height = H;
          it.skin.style.width = '100%'; it.skin.style.height = '100%';
          const ctx = it.skin.getContext('2d');
          ctx.clearRect(0, 0, W, H);
          ctx.save(); ctx.scale(d, d);
          it.draw(ctx, w, h, it.opts);
          ctx.restore();
        } else {
          this.atlas.panel(it.skin, w, h, { ...it.opts, dpr: d });
        }
      } catch (e) { /* a panel that fails to paint stays transparent */ }
    }
  }

  dispose() { this.items.length = 0; }
}

/* -------------------------------------------------------------- widgets */

/**
 * A horizontal statistic row with a leader-dotted rule between label and value
 * — real typographic hierarchy rather than two stacked divs.
 */
export function statRow(parent, label, value, o = {}) {
  const row = mk('div', 'srow', parent);
  sty(row, {
    display: 'flex', alignItems: 'baseline', gap: '.5vh',
    padding: `${o.padY ?? 0.16}vh 0`,
    fontSize: `${o.size ?? 1.42}vh`,
    lineHeight: '1.35',
  });
  const l = txt('span', 'slab', label, row);
  sty(l, { color: o.labelColor ?? '#9c9078', letterSpacing: '.045em', whiteSpace: 'nowrap' });
  const dots = mk('span', 'sdots', row);
  sty(dots, {
    flex: '1 1 auto', height: '1px', marginBottom: '.30vh',
    background: `repeating-linear-gradient(90deg,${o.dotColor ?? 'rgba(150,132,96,.45)'} 0 1px,transparent 1px 4px)`,
    opacity: '.6',
  });
  const v = txt('span', 'num sval', value, row);
  sty(v, {
    color: o.valueColor ?? '#e8dcc0', whiteSpace: 'nowrap',
    fontWeight: o.bold ? '600' : '400',
    /* on metal the type is engraved (dark cut above, warm catch-light below); on
       parchment it is ink, so the emboss inverts */
    textShadow: o.shadow ?? '0 -1px 0 rgba(0,0,0,.9),0 1px 0 rgba(255,238,190,.12)',
  });
  return { row, label: l, value: v };
}

/** Section header: engraved small-caps over a hairline rule. */
export function section(parent, title, o = {}) {
  const wrap = mk('div', 'sect', parent);
  sty(wrap, { position: 'relative', margin: `${o.mt ?? 0.9}vh 0 ${o.mb ?? 0.5}vh` });
  const t = txt('div', 'eng', title, wrap);
  sty(t, {
    fontSize: `${o.size ?? 1.20}vh`, letterSpacing: '.30em',
    color: o.color ?? '#a8996f', textAlign: o.align ?? 'left',
    paddingBottom: '.34vh',
  });
  if (o.shadow) t.style.textShadow = o.shadow;
  const rule = mk('div', 'rule', wrap);
  return { wrap, title: t, rule };
}

/** Utility: format an integer with thin thousands separators. */
export function fmt(n) {
  const v = Math.max(0, Math.round(n || 0));
  return v >= 1000 ? v.toLocaleString('en-US') : String(v);
}

export function fmtTime(s) {
  const v = Math.max(0, s);
  if (v >= 60) return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const mix = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach (dt is fixed, so deterministic). */
export const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export default { mk, sty, txt, box, SkinSet, statRow, section, fmt, fmtTime, clamp, clamp01, mix, approach };
