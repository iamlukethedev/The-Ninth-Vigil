/**
 * THE NINTH VIGIL — decal type table.
 *
 * Every field here is consumed either by the geometry builder (size, res,
 * orient) or by the stain shader through vertex attributes (life, dry, tint,
 * roughness endpoints, class, emissive gain). Sizes are METRES — canonical world
 * scale is 1 unit = 1 m, and a 1.85 m hero must be able to stand next to a
 * splatter without it reading as a puddle the size of a car.
 */

/** Shader class ids — must match the branches in StainMaterial.js. */
export const CLS = {
  BLOOD: 0,
  SCORCH: 1,
  RIME: 2,
  CRACK: 3,
  DUST: 4,
  PRINT: 5,
  RUNE: 6,
};

/**
 * tile       atlas tile name
 * size       [length, width] in metres (length runs along the orientation axis)
 * jitter     +/- fraction of random size variation
 * life       seconds until fully gone
 * fadeIn     seconds to reach full opacity
 * dry        seconds for the wet->dry transition (roughness + albedo shift)
 * grow       seconds for the stain to spread from its centre (0 = instant)
 * tint       multiplier on the atlas albedo
 * rough      [wet, dry] absolute roughness endpoints
 * emissive   gain on the mask channel (0 disables the emissive path entirely)
 * emissTint  emissive colour
 * cls        shader class
 * res        conforming patch subdivisions per side (higher = follows terrain better)
 * orient     'dir' aligns +length with the event direction, 'rand' uses the seed
 * opacity    master alpha
 */
export const DECAL_TYPES = {
  /* ---------------------------------------------------------------- blood */
  blood_splat: {
    tile: 'blood_a', size: [2.35, 1.85], jitter: 0.28, life: 240, fadeIn: 0.05,
    dry: 34, grow: 0.16, tint: [1, 1, 1], rough: [0.10, 0.74], emissive: 0.0,
    cls: CLS.BLOOD, res: 6, orient: 'dir', opacity: 0.96,
  },
  blood_burst: {
    tile: 'blood_b', size: [2.05, 2.05], jitter: 0.3, life: 240, fadeIn: 0.05,
    dry: 34, grow: 0.14, tint: [1, 1, 1], rough: [0.10, 0.74], emissive: 0.0,
    cls: CLS.BLOOD, res: 6, orient: 'rand', opacity: 0.95,
  },
  blood_spray: {
    tile: 'blood_spray', size: [3.5, 2.15], jitter: 0.3, life: 200, fadeIn: 0.04,
    dry: 22, grow: 0.10, tint: [1, 1, 1], rough: [0.14, 0.78], emissive: 0.0,
    cls: CLS.BLOOD, res: 6, orient: 'dir', opacity: 0.85,
  },
  blood_pool: {
    tile: 'blood_pool', size: [2.7, 2.7], jitter: 0.16, life: 300, fadeIn: 0.6,
    dry: 70, grow: 3.4, tint: [1, 1, 1], rough: [0.07, 0.62], emissive: 0.0,
    cls: CLS.BLOOD, res: 8, orient: 'rand', opacity: 1.0,
  },
  blood_drips: {
    tile: 'drips', size: [2.5, 1.65], jitter: 0.3, life: 200, fadeIn: 0.05,
    dry: 26, grow: 0.12, tint: [1, 1, 1], rough: [0.12, 0.76], emissive: 0.0,
    cls: CLS.BLOOD, res: 5, orient: 'dir', opacity: 0.9,
  },

  /* --------------------------------------------------------------- scorch */
  scorch: {
    tile: 'scorch', size: [2.95, 2.95], jitter: 0.24, life: 220, fadeIn: 0.12,
    dry: 9, grow: 0.28, tint: [1, 1, 1], rough: [0.72, 0.94], emissive: 2.3,
    emissTint: [1.0, 0.34, 0.075], cls: CLS.SCORCH, res: 7, orient: 'rand', opacity: 0.97,
  },
  scorch_burst: {
    tile: 'scorch_burst', size: [3.9, 3.9], jitter: 0.2, life: 220, fadeIn: 0.10,
    dry: 11, grow: 0.34, tint: [1, 1, 1], rough: [0.70, 0.94], emissive: 2.6,
    emissTint: [1.0, 0.31, 0.06], cls: CLS.SCORCH, res: 8, orient: 'rand', opacity: 0.97,
  },

  /* ------------------------------------------------------------ ice/rime */
  rime: {
    tile: 'rime', size: [2.95, 2.95], jitter: 0.22, life: 15, fadeIn: 0.18,
    dry: 9, grow: 0.55, tint: [0.86, 0.92, 1.0], rough: [0.16, 0.52], emissive: 0.48,
    emissTint: [0.52, 0.76, 1.0], cls: CLS.RIME, res: 7, orient: 'rand', opacity: 0.92,
  },

  /* ------------------------------------------------------- cracks/craters */
  crater: {
    tile: 'crack', size: [3.5, 3.5], jitter: 0.18, life: 260, fadeIn: 0.10,
    dry: 6, grow: 0.22, tint: [1, 1, 1], rough: [0.86, 0.92], emissive: 0.0,
    cls: CLS.CRACK, res: 8, orient: 'rand', opacity: 1.0,
  },
  cracks: {
    tile: 'crack_web', size: [4.3, 4.3], jitter: 0.2, life: 260, fadeIn: 0.14,
    dry: 6, grow: 0.30, tint: [1, 1, 1], rough: [0.86, 0.92], emissive: 0.0,
    cls: CLS.CRACK, res: 8, orient: 'rand', opacity: 0.94,
  },

  /* ------------------------------------------------------------- ambient */
  dust: {
    tile: 'dust', size: [3.0, 3.0], jitter: 0.3, life: 7, fadeIn: 0.10,
    dry: 3, grow: 0.9, tint: [1, 1, 1], rough: [0.9, 0.95], emissive: 0.0,
    cls: CLS.DUST, res: 4, orient: 'rand', opacity: 0.55,
  },
  scuff: {
    tile: 'dust', size: [2.0, 1.4], jitter: 0.3, life: 26, fadeIn: 0.06,
    dry: 6, grow: 0.2, tint: [0.92, 0.88, 0.80], rough: [0.9, 0.95], emissive: 0.0,
    cls: CLS.DUST, res: 4, orient: 'dir', opacity: 0.42,
  },

  /* ---------------------------------------------------------- footprints */
  print_boot: {
    tile: 'foot_boot', size: [0.56, 0.40], jitter: 0.06, life: 34, fadeIn: 0.03,
    dry: 12, grow: 0, tint: [1, 1, 1], rough: [0.52, 0.86], emissive: 0.0,
    cls: CLS.PRINT, res: 3, orient: 'dir', opacity: 0.72,
  },
  print_claw: {
    tile: 'foot_claw', size: [0.86, 0.70], jitter: 0.10, life: 34, fadeIn: 0.03,
    dry: 12, grow: 0, tint: [1, 1, 1], rough: [0.52, 0.86], emissive: 0.0,
    cls: CLS.PRINT, res: 3, orient: 'dir', opacity: 0.74,
  },
  print_boss: {
    tile: 'foot_claw', size: [2.0, 1.62], jitter: 0.08, life: 60, fadeIn: 0.04,
    dry: 18, grow: 0, tint: [0.9, 0.88, 0.86], rough: [0.55, 0.88], emissive: 0.0,
    cls: CLS.PRINT, res: 5, orient: 'dir', opacity: 0.8,
  },
  print_blood: {
    tile: 'foot_boot', size: [0.56, 0.40], jitter: 0.06, life: 60, fadeIn: 0.03,
    dry: 18, grow: 0, tint: [2.35, 0.60, 0.48], rough: [0.16, 0.70], emissive: 0.0,
    cls: CLS.BLOOD, res: 3, orient: 'dir', opacity: 0.85,
  },

  /* ---------------------------------------------------------- runes/sigils */
  /* Rune gains are budgeted against the post chain, not picked by eye. A sigil
     is drawn into the linear HDR buffer ahead of auto-exposure (up to ~1.7x in
     the crypt scenarios) and ACES. At the old 1.45-1.75 the red channel resolved
     past 2.6 linear: R clipped, G followed it up, and an orange sigil came out as
     a pale cream ring — the brightest thing in the frame, competing with the
     hero.
     The gain is no longer the only rail: StainMaterial squares the mask and then
     scales the whole emissive colour to a 0.42 LUMA ceiling, so the gain now
     controls HOW MUCH OF the sigil lights up rather than how hot its peak is.
     These values are set so a ward reads as a charged channel with cold stretches
     in it, never as a uniformly lit outline.
     `opacity` is deliberately below 1: a sigil is carved into the floor, so the
     flagstone joints have to survive underneath it.

     ROUND-5: TINT IS NOT [1,1,1] ANY MORE — this is half of the "uniform-width
     white line art" defect and the half that lives in this file.
     The atlas paints the sigil's strokes as a pale warm cream so that the ALBEDO
     alone was the read: at tint [1,1,1] and 0.84 opacity a 10 m rune circle
     resolved as bright tan line work drawn over the flagstones, and the emissive
     rim it is supposed to be read by was a minor perturbation on top of that.
     Engraved stone is DARKER than the stone around it, never lighter — the light
     comes out of the channel, not off the paint. So:
       • tint drops the albedo to a cool, dark cut in the floor,
       • opacity drops so more of the flagstone's own grain and joints survive
         through the sigil,
       • emissive rises to put the read back where it belongs, on the lit rim of
         the channel — still under StainMaterial's 0.075 luma / 0.130 max-channel
         rail, i.e. still far below the 0.838 scene-linear bloom floor.
     The hue family stays warm across the boss ring: an arena with a hellfire
     accent must not also carry a green one, and five green wards around an orange
     circle was exactly the rainbow the art bible forbids. */
  rune_minor: {
    tile: 'rune_b', size: [3.1, 3.1], jitter: 0.04, life: 1e6, fadeIn: 1.2,
    dry: 1, grow: 1.1, tint: [0.50, 0.44, 0.40], rough: [0.62, 0.62], emissive: 0.72,
    emissTint: [1.0, 0.40, 0.12], cls: CLS.RUNE, res: 9, orient: 'rand', opacity: 0.64,
  },
  rune_major: {
    tile: 'rune_a', size: [6.4, 6.4], jitter: 0.02, life: 1e6, fadeIn: 1.6,
    dry: 1, grow: 1.6, tint: [0.44, 0.38, 0.36], rough: [0.62, 0.62], emissive: 0.82,
    emissTint: [1.0, 0.34, 0.09], cls: CLS.RUNE, res: 11, orient: 'rand', opacity: 0.60,
  },
  rune_ward: {
    tile: 'rune_c', size: [4.0, 4.0], jitter: 0.03, life: 1e6, fadeIn: 1.3,
    dry: 1, grow: 1.2, tint: [0.46, 0.41, 0.39], rough: [0.62, 0.62], emissive: 0.68,
    emissTint: [1.0, 0.52, 0.20], cls: CLS.RUNE, res: 10, orient: 'rand', opacity: 0.58,
  },
};

/**
 * Bus 'impact' kinds -> decal recipes. A recipe is a list of
 * [type, probability, sizeScale] tried in order; probability is evaluated on the
 * event-seeded PRNG so the same event always yields the same marks.
 */
export const IMPACT_MAP = {
  slash: [['blood_splat', 1, 1], ['blood_spray', 0.55, 1]],
  weapon: [['blood_splat', 0.9, 0.92], ['blood_drips', 0.45, 1]],
  pierce: [['blood_spray', 1, 0.9]],
  blunt: [['blood_burst', 0.8, 0.9], ['dust', 0.5, 0.8]],
  heavy_impact: [['crater', 1, 1], ['dust', 1, 1.25], ['blood_burst', 0.35, 0.8]],
  slam: [['crater', 1, 1.1], ['cracks', 0.7, 1], ['dust', 1, 1.4]],
  aoe: [['scorch', 1, 1], ['cracks', 0.4, 0.9]],
  fire: [['scorch', 1, 1]],
  explosion: [['scorch_burst', 1, 1], ['cracks', 0.65, 1], ['dust', 1, 1.3]],
  arcane: [['scorch', 0.55, 0.75], ['rune_minor', 0.0, 1]],
  frost: [['rime', 1, 1]],
  ice: [['rime', 1, 1]],
  necrotic: [['scorch', 0.8, 0.85]],
  dust: [['dust', 1, 1]],
  footfall: [],
  summon: [['scorch', 0.7, 0.7], ['rune_minor', 0.5, 0.8]],
  summon_rift: [['scorch', 1, 0.8], ['cracks', 0.5, 0.7]],
  gore: [['blood_pool', 1, 1], ['blood_spray', 1, 1]],
  bullet: [['dust', 1, 0.4]],
  default: [['dust', 1, 0.7]],
};

/** Damage type -> decal, for the 'damage' event (small, cheap marks). */
export const DAMAGE_MAP = {
  physical: 'blood_splat',
  slashing: 'blood_splat',
  piercing: 'blood_spray',
  bleed: 'blood_drips',
  fire: 'scorch',
  cold: 'rime',
  frost: 'rime',
  lightning: 'scorch',
  poison: 'scorch',
  necrotic: 'scorch',
  shadow: 'scorch',
  arcane: 'scorch',
};
