/**
 * SANCTUM — UI Theme
 * ---------------------------------------------------------------------------
 * Design tokens for the whole interface: type stacks, the gothic palette,
 * rarity colours, and the CSS custom properties every panel reads.
 *
 * NO EXTERNAL FONTS. Every family named here ships with the operating system
 * (macOS: Herculanum / Copperplate / Luminari / Didot / Bodoni 72 / Hoefler
 * Text / Palatino / Baskerville / Optima; Windows: Trajan Pro / Palatino
 * Linotype / Book Antiqua / Constantia / Georgia). The stacks always terminate
 * in `serif` so a default *sans* face can never appear.
 *
 * ── On the display face, deliberately ────────────────────────────────────────
 * The art director asked for a self-hosted woff2 for the display type. We are
 * NOT adding one: the engine contract forbids external asset files and runtime
 * network fetches outright ("No CDNs, no remote textures, no fonts"), and a
 * base64 woff2 inlined in a source file is the same asset by another name.
 *
 * What replaces it is not a compromise on letterforms, it is a different lever:
 *   • SCALE HIERARCHY — five discrete steps (see TYPE below), never intermediate
 *     sizes, so every line's rank is unambiguous.
 *   • LETTERSPACING — inscriptional tracking (.17em–.34em) on everything set in
 *     capitals, which is the single strongest cue that type is *display* type.
 *   • WEIGHT — 600/700 on plates and headers, with synthetic stem-thickening in
 *     the gilded rasters (UIAtlas.titleURI) because the OS inscriptional stacks
 *     resolve to comparatively light faces.
 *   • ORNAMENTAL CAPITALS — panel titles are not CSS text at all. They are
 *     rasterised by `UIAtlas.titleURI` and gilded as physical gold leaf: a dark
 *     cut sunk under each stroke, worn leaf on the face, tarnish and planishing
 *     through it, a raking crest, and a star glint on the versal. That gives the
 *     titles genuine specular, which no webfont plus `text-shadow` can.
 * Body copy, stats and affixes stay as live text in the OS old-style serifs,
 * because they must reflow and be selectable-sharp at any resolution.
 *
 * Everything is sized in `vh` so the interface is resolution independent and
 * stays pixel-crisp: raster ornament is generated at the device pixel size it
 * will actually occupy (see UIAtlas), never up-scaled.
 */

/* ------------------------------------------------------------------ type */

/** Inscriptional Roman capitals — panel headers, plates, boss titles. */
export const FONT_DISPLAY =
  `'Trajan Pro','Cinzel','Herculanum','Copperplate','Copperplate Gothic Light',` +
  `'Optima','Palatino Linotype','Book Antiqua',Palatino,Georgia,serif`;

/** Engraved small-caps — sub-headers, keybinds, tab labels, section rules. */
export const FONT_ENGRAVED =
  `'Copperplate','Copperplate Gothic Light','Trajan Pro','Optima',` +
  `'Hoefler Text',Palatino,Georgia,serif`;

/** Old-style body serif with real italics — stats, affixes, flavour text. */
export const FONT_BODY =
  `'Hoefler Text','Palatino Linotype','Book Antiqua',Palatino,'Baskerville',` +
  `Constantia,Georgia,'Times New Roman',serif`;

/** High-contrast didone numerals — orb values, damage, level plate. */
export const FONT_NUM =
  `'Didot','Bodoni 72','Bodoni MT','Hoefler Text','Palatino Linotype',` +
  `Palatino,Georgia,serif`;

/** Calligraphic display — legendary item names, boss epithets. */
export const FONT_ARCANE =
  `'Luminari','Trattatello','Papyrus','Herculanum','Trajan Pro',Georgia,serif`;

/**
 * The type scale, in vh. Five steps and no others — a hierarchy with
 * intermediate sizes in it is not a hierarchy. `track` is the letterspacing that
 * goes with each step: the smaller and more capital the setting, the wider the
 * tracking, which is how inscriptional lettering is actually spaced.
 */
export const TYPE = {
  /** panel titles — gilded rasters, see UIAtlas.titleURI */
  display: { size: 1.96, track: 0.26, weight: 700 },
  /** section heads, plate labels, tab keys */
  head:    { size: 1.30, track: 0.30, weight: 600 },
  /** stat rows, affixes, body copy */
  body:    { size: 1.27, track: 0.045, weight: 400 },
  /** sub-labels, socket captions, keybinds */
  small:   { size: 0.96, track: 0.24, weight: 600 },
  /** stack counts, footnotes */
  micro:   { size: 0.82, track: 0.14, weight: 600 },
};

/* --------------------------------------------------------------- palette */

/**
 * Cold desaturated base, warm restrained gold, one saturated accent per state.
 * Values are the *linear intent* of the art direction bible, authored in sRGB.
 */
export const PAL = {
  /* iron / steel — frames, sockets, plates */
  ironDeep:   '#0c0e11',
  ironDark:   '#1a1d22',
  iron:       '#2c3138',
  ironMid:    '#3d444d',
  ironLight:  '#5b636e',
  ironSpec:   '#8e97a3',

  /* gold leaf — used sparingly, always worn */
  goldDeep:   '#4a3413',
  goldDark:   '#7a5620',
  gold:       '#b28c3c',
  goldLight:  '#dcb35e',
  goldSpec:   '#f6e3a8',

  /* parchment / vellum */
  vellumDeep: '#6b5c40',
  vellum:     '#b6a483',
  vellumLit:  '#d8c8a4',

  /* ink on parchment */
  ink:        '#241c12',
  inkSoft:    '#4a3d2a',

  /* liquid */
  blood:      '#8e1220',
  bloodLit:   '#e0432c',
  mana:       '#1d4f8c',
  manaLit:    '#5fb8ee',

  /* type on metal */
  textHi:     '#e8dcc0',
  text:       '#c6b795',
  textDim:    '#8e8267',
  textFaint:  '#5f5744',

  /* states */
  danger:     '#c2402c',
  good:       '#7fa855',
  arcane:     '#8e6cd8',
  necro:      '#6ac08a',
};

/* ---------------------------------------------------------------- rarity */

/** white / blue / yellow / orange / red — legible at a glance, per contract. */
export const RARITY = {
  common:    { key: 'common',    label: 'Common',    line: '#cdc7b8', glow: '#8d8578', text: '#ddd7c8', deep: '#3a382f' },
  magic:     { key: 'magic',     label: 'Magic',     line: '#5d94e0', glow: '#3a6ec0', text: '#8fbcf4', deep: '#16243d' },
  rare:      { key: 'rare',      label: 'Rare',      line: '#e0c74e', glow: '#b39422', text: '#f0dc8a', deep: '#3b3110' },
  legendary: { key: 'legendary', label: 'Legendary', line: '#e0862c', glow: '#c05f10', text: '#f5b473', deep: '#3f2209' },
  mythic:    { key: 'mythic',    label: 'Mythic',    line: '#c0392b', glow: '#8e1f14', text: '#ef8272', deep: '#3a0f0a' },
};
export const RARITY_ORDER = ['common', 'magic', 'rare', 'legendary', 'mythic'];
export const rarityOf = (k) => RARITY[k] ?? RARITY.common;

/** Damage-number palette — never plain white. */
export const DMG = {
  physical: { a: '#fff0d0', b: '#c9a05a', edge: '#2a1c0c' },
  fire:     { a: '#ffd79a', b: '#d8551a', edge: '#2c0d04' },
  shadow:   { a: '#d9c4f2', b: '#6b3fb0', edge: '#170a26' },
  cold:     { a: '#dff2ff', b: '#3f8fd0', edge: '#08202e' },
  poison:   { a: '#dcf7bc', b: '#5f9e2c', edge: '#122208' },
  holy:     { a: '#fff6d4', b: '#d8b23c', edge: '#2b2005' },
  heal:     { a: '#e6ffd8', b: '#5fa84c', edge: '#0f2409' },
  crit:     { a: '#fff4d2', b: '#e0561c', edge: '#280a02' },
  player:   { a: '#ffd3cd', b: '#b42a1c', edge: '#280604' },
};
export const dmgStyleOf = (t) => DMG[t] ?? DMG.physical;

/* ------------------------------------------------------------------ CSS */

/**
 * Root stylesheet. Written once into a <style> owned by the HUD.
 *
 * Deliberately contains NO css animations or transitions — every moving value
 * is written from `update()` off `engine.clock`, so a captured frame is a pure
 * function of the frame index (the screenshot critic requires this).
 */
export function baseCSS() {
  return `
#sanctum-hud{
  position:fixed; inset:0; z-index:900; pointer-events:none;
  overflow:hidden;
  font-family:${FONT_BODY};
  color:${PAL.text};
  -webkit-font-smoothing:antialiased;
  text-rendering:geometricPrecision;
  font-kerning:normal;
  font-variant-ligatures:none;
  --gold:${PAL.gold}; --goldLight:${PAL.goldLight}; --goldSpec:${PAL.goldSpec};
  --iron:${PAL.iron}; --ironDark:${PAL.ironDark}; --ironDeep:${PAL.ironDeep};
  --text:${PAL.text}; --textHi:${PAL.textHi}; --textDim:${PAL.textDim};
}
#sanctum-hud *{ margin:0; padding:0; box-sizing:border-box; }
#sanctum-hud .hide{ display:none !important; }

/* every panel is a physical object: raster fill + ornate border painted into
   its own backing canvas, plus a real cast shadow */
#sanctum-hud .pnl{ position:absolute; }
#sanctum-hud .pnl>canvas.skin{
  position:absolute; inset:0; width:100%; height:100%; display:block;
  filter:drop-shadow(0 1.4vh 2.6vh rgba(0,0,0,.82));
}
#sanctum-hud .pnl>.body{ position:absolute; inset:0; }
/* an .auto panel is sized BY its content: the body flows normally so the
   element gets a real height, and the skin canvas stretches to match */
#sanctum-hud .pnl.auto>.body{ position:relative; inset:auto; }

/* engraved lettering: dark cut below, warm catch-light above */
#sanctum-hud .eng{
  font-family:${FONT_ENGRAVED};
  text-transform:uppercase;
  letter-spacing:.24em;
  color:${PAL.text};
  text-shadow:0 -1px 0 rgba(0,0,0,.92), 0 1px 0 rgba(232,206,150,.20);
}
#sanctum-hud .disp{
  font-family:${FONT_DISPLAY};
  text-transform:uppercase;
  letter-spacing:.17em;
  color:${PAL.goldLight};
  text-shadow:0 -1px 0 rgba(0,0,0,.95), 0 1px 1px rgba(0,0,0,.7),
              0 1px 0 rgba(255,230,170,.24), 0 0 1.4vh rgba(190,140,60,.30);
}
#sanctum-hud .num{ font-family:${FONT_NUM}; font-variant-numeric:lining-nums tabular-nums; }
#sanctum-hud .flav{ font-family:${FONT_BODY}; font-style:italic; color:#9a8c6d; }

/* GILT — a display line rasterised and gilded by UIAtlas.titleURI. This is the
   interface's display "face": there is no woff2 (see the note at the top of this
   file), so the ornamental capital, the tracking and the gold-leaf specular are
   all authored into the raster. The element is sized by HEIGHT only; its width is
   set from the raster's own aspect so letterforms are never stretched. */
#sanctum-hud .gilt{
  background-size:100% 100%; background-repeat:no-repeat; margin:0 auto;
}
/* inscriptional tracking steps, so a caller never invents a value */
#sanctum-hud .tr-wide{ letter-spacing:.34em; }
#sanctum-hud .tr-head{ letter-spacing:.30em; }
#sanctum-hud .tr-cap { letter-spacing:.24em; }
#sanctum-hud .sc{ font-variant-caps:small-caps; letter-spacing:.14em; }

/* a hairline gold rule with a diamond centre — used between tooltip sections */
#sanctum-hud .rule{
  position:relative; height:.9vh;
  background:linear-gradient(90deg,rgba(178,140,60,0) 0%,rgba(178,140,60,.52) 18%,
             rgba(220,180,100,.72) 50%,rgba(178,140,60,.52) 82%,rgba(178,140,60,0) 100%)
             center/100% 1px no-repeat;
}
#sanctum-hud .rule:after{
  content:''; position:absolute; left:50%; top:50%; width:.62vh; height:.62vh;
  transform:translate(-50%,-50%) rotate(45deg);
  background:linear-gradient(135deg,${PAL.goldSpec},${PAL.goldDark});
  box-shadow:0 0 .4vh rgba(0,0,0,.9);
}
`;
}

export default { PAL, RARITY, DMG, TYPE, FONT_DISPLAY, FONT_ENGRAVED, FONT_BODY, FONT_NUM, FONT_ARCANE, baseCSS };
