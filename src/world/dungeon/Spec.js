/**
 * THE NINTH VIGIL — Dungeon dimensional specification.
 *
 * EVERY number in this file is metres. 1 world unit = 1 metre (KNOWN_ISSUES.md).
 * Nothing in the dungeon kit is allowed to invent its own scale; if a piece needs
 * a dimension it comes from here, so the whole crypt stays measurable against a
 * 1.85 m hero.
 *
 * Cross-section of a wall, looking along the run. `u` is the across-wall axis:
 * +u points INTO the room, u = 0 is the face of the dressed ashlar.
 *
 *        u = +0.20  +0.13   0.0   -0.09        -0.60
 *                |      |     |      |            |
 *   4.60 ────────┼──────┤     |      |            |   coping top
 *   3.92 ─ cornice (corbelled cavetto, chamfered coping)
 *   2.52 ─┐
 *   2.20 ─┘ string course
 *   0.44 ─ plinth top (weathered slope back to the field)
 *   0.00 ─ floor
 *
 * Ashlar blocks stand 0.09 m proud of the recessed field, so the wall reads as
 * three separate depth planes plus two mouldings — never an extruded box.
 */

export const CELL = 0.5;                       // layout grid pitch

export const SPEC = {
  cell: CELL,
  /** playable footprint, metres (square, centred on the origin) */
  footprint: 88,
  /** flat rock margin beyond the footprint so no exterior terrain is ever seen */
  margin: 16,
  /** corridors are 7 cells wide */
  corridorW: 7 * CELL,

  wall: {
    h: 4.60,              // cornice coping top
    back: -0.60,          // u of the hidden back face
    field: -0.09,         // u of the recessed field between mouldings
    face: 0.0,            // u of the dressed ashlar face
    plinthTop: 0.44,
    plinthU: 0.10,
    stringLo: 2.20,
    stringHi: 2.52,
    stringU: 0.13,
    corniceLo: 3.92,
    corniceU: 0.20,
    copingU: 0.13,
    course: 0.30,         // ashlar course height
    block: 0.50,          // ashlar block length
    joint: 0.022,
    blockDepth: 0.09,
    panel: 2.0,           // modular panel length (4 blocks)
    filler: 0.5,          // quarter panel for grid remainders
    pier: 0.70,           // corner pier / quoin footprint
  },

  cap: {
    y: 4.30,              // rock mass top over non-walkable cells
    edgeY: 4.14,          // lowered where it meets a wall, so it stays hidden
    relief: 0.55,         // rock lumpiness amplitude away from walls
  },

  vault: {
    spring: 4.30,         // springing line
    bay: 3.5,             // nominal bay
    unitRise: 0.60,       // rise of the authored unit bay (per unit span)
    ribW: 0.13,
    ribD: 0.17,
  },

  portal: {
    frameH: 5.45,         // portal frames rise above the wall line
    jamb: 0.78,
    spring: 2.45,
    riseRatio: 1.30,
    thick: 0.80,
  },

  floor: {
    thick: 0.16,
    joint: 0.035,
    substrate: -0.14,     // dirt surface revealed by missing slabs
    subsidence: 0.055,
    tilt: 0.016,          // radians
  },

  column: {
    h: 4.30,
    baseR: 0.52,
    shaftR: 0.34,
    capR: 0.56,
  },

  arena: {
    R: 25.0,              // hexagon circumradius
    wallH: 6.2,
    daisR: 9.5,
    daisH: 1.35,
    channelOuter: 23.2,
    channelInner: 20.4,
    channelDepth: 0.85,
  },

  /** texture world scale, metres per texture tile — the tiling defect fix */
  uv: {
    wall: 1.62,           // stone kind is 3x5 blocks per tile -> 0.54 x 0.32 m
    floor: 1.30,
    rock: 3.10,
    dirt: 2.20,
    iron: 0.62,
    wood: 0.95,
    bone: 0.42,
    cloth: 1.15,
    gold: 0.55,
    lava: 3.40,
  },
};

export default SPEC;
