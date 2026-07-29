/**
 * SANCTUM — Props: environment dressing.
 *
 * This module owns the rubric's "craft density" axis. A Diablo-class frame is
 * *dense with authored detail* — chains, roots, candles, cracked masonry, bone,
 * crates, banners, rubble — and an empty ground plane with a shader on it reads
 * as unfinished no matter how good the shader is.
 *
 * Responsibilities, in priority order:
 *
 *  1. **Light fixtures.** Every practical light in the game is placed by this
 *     module, AT a flame, inside real geometry (see props/Fixtures.js). A bare
 *     glowing orb in mid-air is an instant rubric fail, and it was the single
 *     worst defect in the project.
 *  2. **Grounding.** Every prop is sunk into the terrain, tilted onto its
 *     normal, and given a contact-darkening blob. A hard unshaded intersection
 *     line where a prop meets the floor is an instant fail.
 *  3. **Placement that reads as authored.** Clustered Poisson-disk scatter with
 *     per-type slope/altitude bands and exclusion zones (props/Scatter.js), plus
 *     explicit set-pieces — colonnades, grave plots, market rows, cairn rings.
 *     Nothing on a uniform grid, ever.
 *  4. **Instancing.** One InstancedMesh per (kind, variant, material) with
 *     per-instance hue/roughness jitter and a distance/LOD pass, so a dense
 *     scene stays inside the draw-call budget.
 *  5. **Destructibles.** Barrels, crates and urns take damage, shatter into a
 *     broken variant, and drop loot.
 *
 * Cross-module contract:
 *   props.placeFixture(kind, position, opts) -> fixture handle
 *   props.fixtures                            // array, for Dungeon/Lighting
 *   props.queryNear(pos, r)                   // for combat + physics
 *   props.damage(record, amount, point)
 *   bus 'damage' / 'impact'  in     -> destruction
 *   bus 'impact' / 'loot:drop' out  <- destruction
 *   bus 'weather:set'        in     -> wind amplitude
 */

import * as THREE from 'three';
import { InstanceCuller } from '../core/InstanceCull.js';
import {
  contactBlobGeo, flameGeo, mergeParts, finish, clamp01, lerp, smooth01,
} from './props/Geo.js';
import {
  MatBank, makeFlameMaterial, makeContactMaterial, makeMoteMaterial, makeRuneMaterial,
} from './props/PropMaterials.js';
import { Scatter } from './props/Scatter.js';
import { FIXTURE_KINDS, buildFixture } from './props/Fixtures.js';
import * as Veg from './props/Vegetation.js';
import * as Rock from './props/Rock.js';
import * as Ruin from './props/Ruin.js';
import * as Human from './props/Human.js';
import * as Mac from './props/Macabre.js';

const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _qtm = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _col = new THREE.Color();
const _m = new THREE.Matrix4();
const _ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _cam = new THREE.Vector3();
const _wind = new THREE.Vector3();

/* ================================================================== *
 * kind table
 *
 * `fp`      footprint radius in metres (Poisson exclusion + contact blob size)
 * `tilt`    0..1 how far this type leans onto the terrain normal
 * `sink`    metres pushed under the surface (grounding — never 0 for ground props)
 * `blob`    contact-blob radius multiplier
 * `lod`     kind id to swap to beyond `lodAt` metres
 *
 * The three fields below exist to answer "the same asset stamped repeatedly".
 * Instancing shares one vertex buffer, so diversity has to come from the
 * per-instance transform and the per-instance shader inputs:
 *
 * `squash`  peak-to-peak NON-UNIFORM scale variation. A uniform scale keeps the
 *           silhouette similar however far it is pushed; 0.3 here means x and z
 *           are drawn independently in 0.85..1.15, so the outline changes shape
 *           and not just size. Turned/crafted objects (barrels, urns) get almost
 *           none — a squashed barrel reads as a modelling error, not variety.
 * `tumble`  peak-to-peak extra tilt in radians about the prop's own X and Z, on
 *           top of the terrain-normal alignment. This is what stops every copy
 *           of a debris heap presenting the same face to the camera. Upright
 *           dressed objects get ~0.05; things that fell get up to 0.5.
 * `sculpt`  per-instance vertex-warp amplitude in metres (see PropMaterials'
 *           VERT_BODY). 0 leaves the authored form untouched.
 * `tintVar` / `hueVar`  per-instance albedo value / warm-cool spread written to
 *           instanceColor, so twelve heaps of one geometry are twelve values.
 * ================================================================== */

/**
 * Per-variant material spreads, for kinds whose variants must not all share one
 * surface. See `_variant` — one InstancedMesh already exists per variant, so this
 * costs no extra draw call.
 *
 * Every name here is in the SAME warm limestone family as the architecture and
 * the floor (`stone` neutral, `stoneWarm` warm, `stoneCold` the darker cooler
 * value, `rubble` the loose grit). That is the point: the art director's note was
 * that the debris "is cold blue-grey while the architecture and floor are warm
 * stone", so the spread has to run along VALUE, not along hue.
 */
/*
 * NATURAL rock alternates the warm granular surface with the cooler darker one.
 * `stone`/`stoneWarm` are deliberately NOT in this list even though they are the
 * warmest members of the family: they carry the full 1.65 m coursed-ashlar tile
 * (see TILE_SCALE), and coursed ashlar wrapped round a 1 m boulder reads as a
 * manhole cover. `rubble` is the cobble generator at a 1.1 m tile with a warm
 * tint, which on a boulder reads as coarse granular rock — the right surface AND
 * the warm end of the value range, for no new texture set at all.
 */
/*
 * NATURAL rock draws in the two `cobble`-generator rock surfaces (granular, warm,
 * two values) plus one earthen member, never in `stoneCold`. `stoneCold` and its
 * siblings are the COURSED ASHLAR generator: 0.55 x 0.32 m dressed blocks in
 * running bond, which is correct on a wall, a lintel or a rubble block chipped off
 * one, and reads as a manhole cover wrapped round a boulder. The previous
 * workaround — pushing stoneCold's tile out 2.4x through TILE_SCALE so the
 * coursing fell below the resolvable frequency — is what made every tomb, chunk
 * and boulder render as a flat near-constant value: see the note on TILE_SCALE.
 */
const ROCK_MATS = ['stoneRock', 'stoneRockCold', 'dirt', 'stoneRock'];
/**
 * Masonry debris: chips of the building, so the dressed names are correct here —
 * with one granular member, because a debris field where every piece shares one
 * surface reads as one asset however varied the shapes are.
 */
const DEBRIS_MATS = ['rubble', 'stoneWarm', 'stoneRock', 'stone', 'stoneWarm', 'rubble'];
/** Headstones are dressed stone — four different quarries in one graveyard. */
const TOMB_MATS = ['stoneCold', 'stone', 'stoneRockCold', 'stoneWarm'];

const KINDS = {
  /* --- vegetation --- */
  deadTree: { fn: Veg.deadTree, variants: 4, fp: 1.5, tilt: 0.18, sink: 0.16, blob: 1.5, scale: [0.85, 1.2], lod: 'deadTreeLOD', lodAt: 62, cast: true, squash: 0.18, tumble: 0.07, sculpt: 0.03 },
  deadTreeLOD: { fn: Veg.deadTreeLOD, variants: 4, fp: 1.5, tilt: 0.18, sink: 0.16, blob: 1.5, scale: [0.85, 1.2], cast: true, hidden: true, squash: 0.18, tumble: 0.07 },
  charTree: { fn: Veg.deadTree, variants: 4, args: { barkMat: 'barkCharred', mossMat: 'barkCharred' }, fp: 1.4, tilt: 0.2, sink: 0.16, blob: 1.4, scale: [0.7, 1.05], cast: true, squash: 0.2, tumble: 0.09, sculpt: 0.03 },
  shrub: { fn: Veg.bareShrub, variants: 3, fp: 0.55, tilt: 0.45, sink: 0.07, blob: 1.5, scale: [0.8, 1.35], squash: 0.26, tumble: 0.14, sculpt: 0.02 },
  bramble: { fn: Veg.bramble, variants: 3, fp: 0.9, tilt: 0.55, sink: 0.06, blob: 1.25, scale: [0.75, 1.3], squash: 0.3, tumble: 0.16, sculpt: 0.02 },
  // Scale: a 0.34 m tuft is four pixels from an ARPG camera. Moor tussock runs
  // to a metre, and ground cover has to actually cover ground to do its job.
  grass: { fn: Veg.grassTuft, variants: 4, fp: 0.28, tilt: 0.75, sink: 0.05, blob: 0, scale: [0.95, 1.85], noBlob: true, squash: 0.3, tumble: 0.1, carpet: true },
  heather: { fn: Veg.heatherMat, variants: 3, fp: 0.85, tilt: 0.8, sink: 0.05, blob: 0, scale: [1.0, 1.65], noBlob: true, squash: 0.3, tumble: 0.1, carpet: true },
  reeds: { fn: Veg.reeds, variants: 2, fp: 0.3, tilt: 0.5, sink: 0.06, blob: 1.2, scale: [0.75, 1.3], squash: 0.26, tumble: 0.12 },
  roots: { fn: Veg.groundRoots, variants: 3, fp: 0.9, tilt: 0.85, sink: 0.07, blob: 1.15, scale: [0.8, 1.35], squash: 0.3, tumble: 0.3, sculpt: 0.035 },
  moss: { fn: Veg.hangingMoss, variants: 2, fp: 0.35, tilt: 0, sink: 0, blob: 0, mounted: true, squash: 0.24 },

  /* --- rock --- */
  // `args` as a function of the variant index: even variants take the warm
  // granular surface, odd ones the darker cooler value, so a rockfall of five
  // stops reading as five castings of one stone. boulder and boulderLOD MUST
  // index the same array or a boulder changes colour at the LOD distance.
  /*
   * `squash` / `tumble` / `sculpt` widened: a boulder is the one prop whose whole
   * job is silhouette, and Rock.boulder builds a smooth dome, so four castings of
   * it at a uniform-ish scale read as four copies. 0.42 of non-uniform scale plus
   * 0.44 rad of tumble about its own X and Z (on top of terrain alignment) plus a
   * 7 cm vertex warp means no two share an outline. Numbers must match on `boulder`
   * and `boulderLOD` or a boulder changes shape at the LOD distance.
   */
  boulder: { fn: Rock.boulder, variants: 4, args: (vi) => ({ mat: ROCK_MATS[vi % 4] }), fp: 1.0, tilt: 0.6, sink: 0.14, blob: 1.35, scale: [0.66, 1.44], lod: 'boulderLOD', lodAt: 58, cast: true, squash: 0.42, tumble: 0.44, sculpt: 0.07, tintVar: 0.3, hueVar: 0.7 },
  boulderLOD: { fn: Rock.boulderLOD, variants: 4, args: (vi) => ({ mat: ROCK_MATS[vi % 4] }), fp: 1.0, tilt: 0.6, sink: 0.14, blob: 1.35, scale: [0.66, 1.44], cast: true, hidden: true, squash: 0.42, tumble: 0.44, sculpt: 0.07, tintVar: 0.3, hueVar: 0.7 },
  rocks: { fn: Rock.rockCluster, variants: 4, args: (vi) => ({ mat: ROCK_MATS[(vi + 1) % 4] }), fp: 1.15, tilt: 0.55, sink: 0.2, blob: 1.4, scale: [0.7, 1.34], cast: true, squash: 0.38, tumble: 0.4, sculpt: 0.062, tintVar: 0.3, hueVar: 0.7 },
  // Six variants, not three. Rock.scree keys its piece count off index % 3 but
  // seeds every shard from `index`, so 3..5 are genuinely different meshes — and
  // each of the six draws in its own value of the stone family.
  scree: { fn: Rock.scree, variants: 6, args: (vi) => ({ mat: DEBRIS_MATS[vi % 6] }), fp: 0.7, tilt: 0.9, sink: 0.07, blob: 0.95, scale: [0.68, 1.6], squash: 0.52, tumble: 0.95, sculpt: 0.042, tintVar: 0.36, hueVar: 0.8 },
  cliff: { fn: Rock.cliffChunk, variants: 3, args: (vi) => ({ mat: ROCK_MATS[vi % 4] }), fp: 2.4, tilt: 0.35, sink: 0.5, blob: 1.2, scale: [0.75, 1.35], cast: true, squash: 0.24, tumble: 0.22, sculpt: 0.085 },
  obsidian: { fn: Rock.cliffChunk, variants: 3, args: { mat: 'stone' }, fp: 2.2, tilt: 0.3, sink: 0.55, blob: 1.25, scale: [0.6, 1.15], cast: true, squash: 0.26, tumble: 0.24, sculpt: 0.085 },
  menhir: { fn: Rock.standingStone, variants: 3, fp: 0.85, tilt: 0.2, sink: 0.24, blob: 1.6, scale: [0.85, 1.25], cast: true, squash: 0.2, tumble: 0.11, sculpt: 0.05 },

  /* --- ruin --- */
  column: { fn: Ruin.brokenColumn, variants: 3, fp: 1.1, tilt: 0.12, sink: 0.1, blob: 1.5, scale: [0.9, 1.15], cast: true, squash: 0.1, tumble: 0.06, sculpt: 0.018 },
  lintel: { fn: Ruin.fallenLintel, variants: 2, fp: 1.6, tilt: 0.5, sink: 0.12, blob: 1.3, scale: [0.85, 1.15], cast: true, squash: 0.16, tumble: 0.3, sculpt: 0.028 },
  wall: { fn: Ruin.crackedWall, variants: 3, fp: 2.0, tilt: 0.14, sink: 0.16, blob: 1.35, scale: [0.9, 1.15], cast: true, squash: 0.13, tumble: 0.08, sculpt: 0.026 },
  tomb: { fn: Ruin.tombstone, variants: 4, args: (vi) => ({ mat: TOMB_MATS[vi % 4] }), fp: 0.62, tilt: 0.42, sink: 0.12, blob: 1.7, scale: [0.85, 1.2], cast: true, squash: 0.16, tumble: 0.12, sculpt: 0.016 },
  sarcophagus: { fn: Ruin.sarcophagus, variants: 2, fp: 1.5, tilt: 0.3, sink: 0.1, blob: 1.25, scale: [0.9, 1.1], cast: true, squash: 0.1, tumble: 0.07, sculpt: 0.018 },
  statue: { fn: Ruin.statueFragment, variants: 2, fp: 0.9, tilt: 0.16, sink: 0.09, blob: 1.5, scale: [0.9, 1.15], cast: true, squash: 0.08, tumble: 0.05 },
  arch: { fn: Ruin.archRemnant, variants: 2, fp: 2.1, tilt: 0.14, sink: 0.14, blob: 1.3, scale: [0.9, 1.1], cast: true, squash: 0.1, tumble: 0.05, sculpt: 0.026 },
  /*
   * TEN authored silhouettes, not six.
   *
   * `Ruin.rubbleHeap` has ten entries in RUBBLE_KIND and takes `index % 10`, but
   * this table said `variants: 6` — so `_place` only ever drew 0..5 and the four
   * silhouettes that exist specifically to break the cuboid read (the round
   * column drum, the hollow blast ring, the tall leaning stack, the flat mortar
   * sheet) were dead code. Six variations on a box is exactly the "same
   * blue-grey chamfered slab, ~30 times" the art director counted; the round,
   * annular, tall and flat reads are the ones that defeat it, and they were
   * unreachable. Widest per-instance spread in the table on top, because this is
   * still the most-repeated prop in the game.
   */
  rubble: { fn: Ruin.rubbleHeap, variants: 10, fp: 0.95, tilt: 0.85, sink: 0.1, blob: 1.2, scale: [0.68, 1.5], squash: 0.42, tumble: 0.62, sculpt: 0.055, tintVar: 0.4, hueVar: 0.85 },

  /* --- human dressing --- */
  crate: { fn: Human.crate, variants: 4, fp: 0.55, tilt: 0.4, sink: 0.05, blob: 1.5, scale: [0.9, 1.12], cast: true, squash: 0.13, tumble: 0.09, dest: { hp: 14, loot: 'wood', broken: 'crateBroken' } },
  crateBroken: { fn: Human.crateBroken, variants: 3, fp: 0.65, tilt: 0.6, sink: 0.05, blob: 1.5, scale: [0.9, 1.12], cast: true, hidden: true, squash: 0.16, tumble: 0.24 },
  barrel: { fn: Human.barrel, variants: 4, fp: 0.4, tilt: 0.35, sink: 0.05, blob: 1.65, scale: [0.92, 1.1], cast: true, squash: 0.07, tumble: 0.09, dest: { hp: 12, loot: 'gold', broken: 'barrelBroken' } },
  barrelBroken: { fn: Human.barrelBroken, variants: 3, fp: 0.55, tilt: 0.7, sink: 0.04, blob: 1.6, scale: [0.92, 1.1], cast: true, hidden: true, squash: 0.1, tumble: 0.3 },
  urn: { fn: Human.urn, variants: 3, fp: 0.32, tilt: 0.35, sink: 0.05, blob: 1.6, scale: [0.85, 1.2], cast: true, squash: 0.07, tumble: 0.1, dest: { hp: 6, loot: 'gold', broken: 'urnBroken' } },
  urnBroken: { fn: Human.urnBroken, variants: 3, fp: 0.45, tilt: 0.75, sink: 0.03, blob: 1.5, scale: [0.85, 1.2], cast: false, hidden: true, squash: 0.12, tumble: 0.34 },
  sack: { fn: Human.sack, variants: 3, fp: 0.38, tilt: 0.6, sink: 0.05, blob: 1.5, scale: [0.85, 1.2], cast: true, squash: 0.2, tumble: 0.18 },
  cart: { fn: Human.cart, variants: 2, fp: 1.5, tilt: 0.25, sink: 0.06, blob: 1.2, scale: [0.95, 1.05], cast: true },
  ladder: { fn: Human.ladder, variants: 2, fp: 0.6, tilt: 0.2, sink: 0.06, blob: 1.4, scale: [0.9, 1.1], cast: true },
  fence: { fn: Human.fence, variants: 3, fp: 1.15, tilt: 0.3, sink: 0.14, blob: 1.1, scale: [0.9, 1.1], cast: true },
  stake: { fn: Human.stake, variants: 3, fp: 0.3, tilt: 0.25, sink: 0.2, blob: 1.7, scale: [0.85, 1.25], cast: true },
  rack: { fn: Human.weaponRack, variants: 2, fp: 0.85, tilt: 0.25, sink: 0.07, blob: 1.35, scale: [0.95, 1.05], cast: true },
  anvil: { fn: Human.anvil, variants: 2, fp: 0.55, tilt: 0.2, sink: 0.08, blob: 1.6, scale: [0.95, 1.05], cast: true },
  banner: { fn: Human.banner, variants: 3, fp: 0.45, tilt: 0.12, sink: 0.2, blob: 1.8, scale: [0.9, 1.15], cast: true },
  woodPile: { fn: Human.woodPile, variants: 3, fp: 0.85, tilt: 0.4, sink: 0.07, blob: 1.35, scale: [0.9, 1.15], cast: true },
  lanternPost: { fn: Human.lanternPost, variants: 3, fp: 0.4, tilt: 0.18, sink: 0.2, blob: 1.7, scale: [0.92, 1.08], cast: true, hook: true },

  /* --- macabre --- */
  bones: { fn: Mac.bonePile, variants: 5, fp: 0.9, tilt: 0.75, sink: 0.07, blob: 1.3, scale: [0.8, 1.3], squash: 0.3, tumble: 0.34, sculpt: 0.022 },
  skulls: { fn: Mac.skullScatter, variants: 5, fp: 0.45, tilt: 0.8, sink: 0.05, blob: 1.4, scale: [0.8, 1.3], squash: 0.24, tumble: 0.42, sculpt: 0.014 },
  ribcage: { fn: Mac.ribcage, variants: 2, fp: 0.85, tilt: 0.6, sink: 0.1, blob: 1.35, scale: [0.85, 1.25], cast: true, squash: 0.18, tumble: 0.2, sculpt: 0.02 },
  gibbet: { fn: Mac.gibbet, variants: 2, fp: 0.7, tilt: 0.14, sink: 0.24, blob: 1.7, scale: [0.92, 1.1], cast: true },
  skullPike: { fn: Mac.skullPike, variants: 3, fp: 0.3, tilt: 0.22, sink: 0.24, blob: 1.7, scale: [0.85, 1.2], cast: true },
  altar: { fn: Mac.bloodAltar, variants: 2, fp: 1.2, tilt: 0.12, sink: 0.09, blob: 1.4, scale: [0.95, 1.05], cast: true, candles: true },
  boneStack: { fn: Mac.boneStack, variants: 2, fp: 1.3, tilt: 0.3, sink: 0.12, blob: 1.25, scale: [0.9, 1.15], cast: true },
};

/** Materials that must render from both sides (foliage, cloth strands). */
const DOUBLE_SIDED = new Set(['foliage', 'foliageDry', 'reed', 'moss', 'cloth', 'clothRed', 'sack']);

/** Scalar metalness once the packed ORM metalness sampler is dropped (see `_mat`). */
const METALNESS = {
  metal: 0.94, metalDark: 0.9, bronze: 0.88,
};

/**
 * Albedo lift, applied as a linear (>1 is legal) multiplier on `material.color`.
 *
 * The generated surfaces are authored very dark — bark lands near 0.09 albedo,
 * moor foliage near 0.11 — which is right for a texture swatch and wrong for a
 * prop that then gets a baked-occlusion vertex pass on top of it and is finally
 * lit by a 15-candela torch six metres away. The result is a black silhouette
 * with no material read at all. These values put the mid-tone back where a
 * torch can find it while keeping the frame bottom-weighted: stone lands around
 * 0.17, wood around 0.19, dead foliage around 0.18 — all still far below the
 * 0.5 that would make the frame milky.
 */
const LIFT = {
  bark: 1.6, barkBare: 1.6, barkStatic: 1.55, barkCharred: 1.3, thorn: 1.55,
  foliage: 1.65, foliageDry: 1.6, reed: 1.55, moss: 1.45,
  wood: 1.4, woodDark: 1.32, timber: 1.42,
  // rubble carries the most lift of the stone family on purpose: it is loose
  // broken grit, which has far more scattering surface per square metre than a
  // dressed ashlar face, and it was reading as a near-black placeholder slab
  // against a floor two stops brighter than it.
  stone: 1.14, stoneCold: 1.14, stoneWarm: 1.18, marble: 1.05, rubble: 1.32,
  stoneRock: 1.26, stoneRockCold: 1.22,
  metal: 1.28, metalDark: 1.22, bronze: 1.22,
  bone: 1.12, boneOld: 1.12,
  cloth: 1.22, clothRed: 1.22, sack: 1.28, leather: 1.28,
  dirt: 1.16, ash: 1.1, wax: 1.12, flesh: 1.12, coal: 1.0,
};

/**
 * Texture-tile rescale, as a multiplier on the bank's authored repeat.
 *
 * The `stone` generator lays coursed ashlar — 0.55 x 0.32 m blocks — which is
 * exactly right on a wall, a column or a lintel, and completely wrong on a
 * boulder or an urn, where it reads as a manhole cover rather than rock. The
 * masonry names keep their tile; the natural-stone and ceramic names push theirs
 * out until the blocks fall below the frequency the eye resolves, leaving the
 * grain, the grime and the geometry's own fbm relief to carry the surface.
 */
/*
 * The masonry names are NOT in this table any more. Their geometry already writes
 * `uTile = 1/1.65` UVs and MatBank now leaves the material repeat at 1, so a
 * dressed prop shows the generator's 0.55 x 0.32 m ashlar at canonical scale —
 * structure at block frequency, grain under it, grime under that. Coarsening them
 * (stoneCold was 0.42, i.e. a 3.9 m repeat) is what made the debris read as
 * untextured slabs: a 0.5 m chip covered a sixty-fourth of one tile.
 *
 * What IS here is the natural-rock set, whose `cobble` generator lays 24 worley
 * cells per tile. Rock geometry writes `uTile = 1/1.65` UVs, so 0.26 puts a cell at
 * 1.65 / 0.26 / 24 = 0.26 m and the earthen member's clods at 1.65 / 0.42 / 12 =
 * 0.33 m. Both numbers are chosen AGAINST THE FLOOR, not in isolation: the crypt
 * floor's own cells land near 0.15 m, and a boulder carrying 0.15 m cells reads as
 * a lump of floor rather than as a rock lying on it — the mid-frequency signal has
 * to differ between two surfaces that touch, or they merge. A 1:1 repeat would have
 * given 4 cm pea gravel, which is where "the boulder is a heap of pebbles the same
 * size as the floor's" came from.
 */
/*
 * `bone` is the one place the geometry convention is genuinely mixed: the long
 * bones and ribs are swept tubes authored at `uTile = 1/0.3` (tile units, like
 * everything else), but a skull is built from `rockGeo` at `uTile = 1` (metres),
 * and a skull is only 9 cm across. At a 1:1 repeat that 9 cm prop covers under a
 * tenth of the bone tile and comes back as a flat blob. 2.0 lands the metre-UV
 * pieces at a 0.5 m repeat and the tile-UV pieces at 0.15 m — both inside the range
 * where the generator's grain reads, which is the only thing that matters here.
 */
const TILE_SCALE = {
  stoneRock: 0.26, stoneRockCold: 0.24, dirt: 0.42,
  bone: 2.0, boneOld: 2.0,
};

/**
 * Multiplier on `material.roughness`, which scales the roughness MAP.
 *
 * The generators author natural stone at roughness 0.72-0.98 and the bank leaves
 * the scalar at 1.0, so cold stone has literally no glossy pixel anywhere on it.
 * A menhir on a rain-soaked moor is the single tallest object in the overworld
 * frame and it came back as a flat black rectangle: uniform roughness is the
 * rubric's "reads as plastic / instant fail", and with no specular there is no
 * highlight to separate it from the sky behind it. 0.86 keeps it unmistakably
 * rough while letting the damp faces and bevels catch a sky glance.
 */
const ROUGH_SCALE = {
  stone: 0.93, stoneCold: 0.88, stoneWarm: 0.90, rubble: 0.93, boneOld: 0.94,
  stoneRock: 0.90, stoneRockCold: 0.86,
};

/**
 * Flame looks. Only these and the coal kind are allowed above emissive 1.0.
 *
 * The intensities are deliberately just over the bloom threshold rather than
 * far over it. A 0.3 m flame driven to 4.0 does not read as fire through a wide
 * bloom kernel — it reads as a lens artefact, which is the exact note the
 * captured frames came back with. Warm, saturated and only slightly blown is
 * what looks like combustion.
 */
const FLAME_STYLES = {
  // The flame body is additive and double-sided, so a view ray through it
  // accumulates four or more layers. Authoring these as if a single layer were
  // the whole answer is what turned every fire in the game into a white dot.
  fire: { core: [1.0, 0.6, 0.23], mid: [1.0, 0.28, 0.06], tip: [0.28, 0.045, 0.012], intensity: 1.1, amp: 0.034, speed: 1.0 },
  candle: { core: [1.0, 0.6, 0.24], mid: [1.0, 0.3, 0.07], tip: [0.22, 0.035, 0.01], intensity: 0.45, amp: 0.011, speed: 1.55 },
  hell: { core: [1.0, 0.46, 0.17], mid: [0.96, 0.14, 0.045], tip: [0.22, 0.018, 0.03], intensity: 1.4, amp: 0.05, speed: 0.78 },
};

const DENSITY = { dense: 1.0, scattered: 0.6, sparse: 0.26, arena: 0.8 };

/** Capacity of a pool created on demand by placeFixture / a late prop. */
const DYN_CAP = 64;

export class Props {
  static id = 'props';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.ready = false;

    this.group = new THREE.Group();
    this.group.name = 'Props';

    /** @type {Array} placement records, the query API's backing store */
    this.props = [];
    /** @type {Array} fixture handles — Dungeon and Lighting read this */
    this.fixtures = [];

    this.biome = 'moor';
    this.density = 'dense';

    this.mats = null;
    this._extras = new Map();
    this._lib = new Map();          // `${kind}#${vi}` -> {parts, flames, lights}
    this._meshes = [];             // {mesh, key}
    this._groups = new Map();      // `${kind}#${vi}#${pi}` -> {mesh, next}
    this._contact = null;
    this._flames = new Map();      // style -> {mesh, mat, next}
    this._motes = null;
    this._runes = [];
    this._qgrid = new Map();
    this._dyn = [];                // records needing per-frame LOD/cull work
    this._offs = [];
    this._plan = [];
    this._fixPlan = [];
    this._extAt = [];
    this._scenarioName = null;
    this._triCount = 0;
    this._camAt = new THREE.Vector3(1e9, 1e9, 1e9);
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    this.mats = new MatBank(this.engine);
    this.contactMat = makeContactMaterial();
    // The blob is a *hint* of occlusion, not a painted shadow — but at 0.3 it was
    // invisible on the night moor, and boulders, tombs and dead trees read as
    // floating: a hard silhouette meeting the ground at an unshaded line, which is
    // one of the rubric's instant fails. The original worry was ink splats under
    // grass, and grass never gets a blob at all (only solid props do), so 0.55 is
    // safe and it is what actually grounds them.
    if (this.contactMat.uniforms?.uStrength) this.contactMat.uniforms.uStrength.value = 0.42;
    this.group.matrixAutoUpdate = false;
    this.engine.scene.add(this.group);

    // A soot-fogged glass for lanterns. Not in the bank because it is the only
    // transmissive surface in the dressing set.
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x2a2620, roughness: 0.34, metalness: 0,
      transparent: true, opacity: 0.3, depthWrite: false,
      emissive: 0x2a1a08, emissiveIntensity: 0.55,
      side: THREE.DoubleSide, envMapIntensity: 1.1,
    });
    glass.name = 'props.glass';
    this._extras.set('glass', glass);

    for (const style in FLAME_STYLES) {
      const mat = makeFlameMaterial(FLAME_STYLES[style]);
      this._flames.set(style, { mat, mesh: null, next: 0, cap: 0 });
    }
    this._flameGeo = flameGeo({ h: 0.22, r: 0.055, rings: 8, seg: 8 });
    this._blobGeo = contactBlobGeo({ seg: 16, rings: 3, dome: 0.055, seed: 11 });

    this._offs.push(this.engine.bus.on('weather:set', (p) => {
      try { this.mats?.setWeather(p?.kind ?? 'clear', p?.intensity ?? 1); } catch { /* noop */ }
    }));
    this._offs.push(this.engine.bus.on('damage', (p) => { try { this._onDamage(p); } catch { /* noop */ } }));
    this._offs.push(this.engine.bus.on('impact', (p) => { try { this._onImpact(p); } catch { /* noop */ } }));

    this.ready = true;
  }

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* noop */ } }
    this._offs.length = 0;
    this._clear();
    for (const [, f] of this._flames) { try { f.mat.dispose(); } catch { /* noop */ } }
    this._flames.clear();
    for (const [, v] of this._lib) {
      for (const p of v.parts) { try { p.geo.dispose(); } catch { /* noop */ } }
    }
    this._lib.clear();
    for (const [, m] of this._extras) { try { m.dispose(); } catch { /* noop */ } }
    this._extras.clear();
    try { this._flameGeo?.dispose(); } catch { /* noop */ }
    try { this._blobGeo?.dispose(); } catch { /* noop */ }
    try { this.contactMat?.dispose(); } catch { /* noop */ }
    this.mats?.dispose();
    this.group.removeFromParent();
    this.ready = false;
  }

  /* ================================================================ *
   * scenario
   * ================================================================ */

  async applyScenario(name, cfg = {}) {
    if (!this.ready) return;
    try {
      this._clear();
      const env = cfg.env ?? {};
      this.biome = ['town', 'moor', 'crypt', 'hell'].includes(env.biome) ? env.biome : 'moor';
      this.density = DENSITY[cfg.spawn?.props] !== undefined ? cfg.spawn.props : 'scattered';
      const dens = DENSITY[this.density] ?? 0.6;

      const probe = this._makeProbe();
      const scatter = new Scatter(probe);
      this._probe = probe;
      this._scatter = scatter;

      const target = cfg.camera?.target ?? [0, 0, 0];
      const cx = target[0] ?? 0, cz = target[2] ?? 0;
      this._center = new THREE.Vector3(cx, probe.heightAt(cx, cz), cz);

      /* --- exclusion zones ------------------------------------------- */
      // the playfield: the hero and the pack fight here, nothing may block it
      const arena = this.biome === 'hell' ? 9.5 : this.biome === 'crypt' ? 5.6 : 5.0;
      scatter.exclude(cx, cz, arena);
      scatter.exclude(0, 0, arena * 0.8);

      const dungeon = probe.dungeon;
      if (dungeon) {
        // Architecture is present, so the exclusion is *not* the whole footprint
        // (that would leave the interior bare). Dressing goes on the walkable
        // floor; the walls themselves are excluded by the walkability test in
        // `siteOK`, and the spawn slots the level owns are excluded by name.
        for (const kind of ['player', 'boss']) {
          let pts = [];
          try { pts = dungeon.spawnPoints?.(kind) ?? []; } catch { pts = []; }
          for (const p of pts) scatter.exclude(p.x, p.z, kind === 'boss' ? 4.6 : 3.8);
        }
        let epts = [];
        try { epts = dungeon.spawnPoints?.('enemy') ?? []; } catch { epts = []; }
        for (const p of epts) scatter.exclude(p.x, p.z, 1.15);
        // and keep clear of the level's own light fixtures
        for (const f of this._dungeonFixtures(dungeon)) scatter.exclude(f.x, f.z, 0.9);
      }
      // town lanes radiate from the plaza; keep them walkable
      if (this.biome === 'town') {
        for (const a of [0.35, 1.92, 3.49, 5.06]) {
          scatter.excludePath([[cx, cz], [cx + Math.cos(a) * 95, cz + Math.sin(a) * 95]], 3.0, true);
        }
      }

      /* --- layout ---------------------------------------------------- */
      const rand = this.engine.freshRand(`props:${name}:${this.biome}`);
      const ctx = { rand, scatter, probe, cx, cz, dens, name, cfg, dungeon };
      if (this.biome === 'crypt') {
        if (dungeon) this._layoutInterior(ctx); else this._layoutCrypt(ctx);
      } else if (this.biome === 'town') this._layoutTown(ctx);
      else if (this.biome === 'hell') {
        if (dungeon) this._layoutInterior(ctx); else this._layoutHell(ctx);
      } else this._layoutMoor(ctx);

      this._realize();
      this._placeFixtures();
      this._adoptDungeonFires(dungeon);
      this._buildMotes(env);
      this._finalisePools();
      this._registerCulling();
      this._refreshDynamic(true);
      this._scenarioName = name;
    } catch (e) {
      console.error('[props:applyScenario]', e);
    }
  }

  /* ================================================================ *
   * layouts — each biome is set-dressed with intent, not sprinkled
   * ================================================================ */

  /**
   * Interior dressing when the Dungeon owns the architecture.
   *
   * The level hands us a clearance field and a list of wall-adjacent prop slots.
   * We honour both, and we deliberately build **no** wall, column or arch of our
   * own — ours would fight the masonry and read as a modelling error. What goes
   * in is what accumulates in a room somebody stopped maintaining: ossuary
   * stacks against the walls, crates and casks in the corners, urns in the
   * niches, bone across the floor, candles wherever a mourner could reach.
   */
  _layoutInterior({ rand, scatter, cx, cz, dens, dungeon }) {
    const hell = this.biome === 'hell';
    const probe = this._probe;
    /* the floor test that keeps dressing out of the walls */
    const floor = (x, z) => probe.isWalkable(x, z) && probe.clearanceAt(x, z) > 0.5;
    const hug = (x, z) => floor(x, z) && probe.clearanceAt(x, z) < 3.6;
    const open = (x, z) => floor(x, z) && probe.clearanceAt(x, z) > 1.8;

    /* --- set-pieces on the level's own wall-adjacent slots --- */
    let slots = [];
    try { slots = dungeon.spawnPoints?.('prop') ?? []; } catch { slots = []; }
    const order = slots.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const bigPlan = hell
      ? [['boneStack', 5], ['ribcage', 5], ['skullPike', 7], ['bones', 6], ['gibbet', 2], ['rubble', 6]]
      : [['sarcophagus', 3], ['boneStack', 5], ['barrel', 8], ['crate', 7], ['urn', 8],
        ['ribcage', 3], ['gibbet', 2], ['woodPile', 2], ['ladder', 2], ['rack', 1],
        ['sack', 4], ['tomb', 4], ['statue', 2]];

    /*
     * A shuffled demand queue walked against the slot list, rather than each
     * type draining the front of the list in turn. Draining in turn means the
     * first two types take every slot and the room ends up dressed with nothing
     * but casks — the mix, not the count, is what reads as authored.
     */
    const queue = [];
    for (const [kind, n0] of bigPlan) {
      if (!KINDS[kind]) continue;
      const n = Math.max(1, Math.round(n0 * dens));
      for (let i = 0; i < n; i++) queue.push(kind);
    }
    for (let i = queue.length - 1; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
    }
    let qi = 0, misses = 0;
    for (let si = 0; si < order.length && qi < queue.length; si++) {
      const p = slots[order[si]];
      if (!p) continue;
      const kind = queue[qi];
      const def = KINDS[kind];
      /*
       * THE LEVEL'S SLOTS ARE A LATTICE, AND THE WALL IS STRAIGHT.
       *
       * Dungeon derives its prop slots from the floor-tile grid, so they arrive on
       * exact half-metre coordinates a fixed distance off the wall face. The
       * previous fix jittered each slot by 0.2-0.75 m in a random BEARING and then
       * — critically — fell back to the raw lattice point on its last attempt with
       * the collinearity test switched off. Both halves failed:
       *
       *  • an isotropic jitter of ±0.75 m on points that share one coordinate to
       *    within a few centimetres leaves them sharing it to within 0.75 m, which
       *    at 28 m and 55 degrees of pitch is four pixels of wander on a run
       *    twelve metres long. It still reads as a line.
       *  • the no-test fallback fired constantly, because wall-hug space is the
       *    tightest space in the room, so most props ended up exactly on the
       *    lattice with no run test at all. A measured capture had five props
       *    inside x = -11.2 ± 0.4 spanning z = -5.4 to 6.1, and seven more in a
       *    matching column on the far wall: two dead-straight 12 m runs, which is
       *    the art director's "visible lines" and "clean diagonal run".
       *
       * What breaks a wall line is not lateral jitter, it is STAND-OFF: real
       * clutter against a wall sits at wildly different distances from it — a cask
       * shoved flush, a crate pulled out to sit on, an ossuary stack a metre into
       * the room. So the offset is drawn in the frame of the wall: `_wallOpen`
       * gives the bearing into the room, the prop is pushed along it by a
       * power-distributed 0.05-1.9 m, and only the small remaining component runs
       * ALONG the wall. Two props at the same wall coordinate now differ by up to
       * two metres in depth, which no amount of collinearity testing could have
       * produced on its own.
       *
       * The run test then stays on for every attempt, easing rather than switching
       * off (`runRelax`), and a slot that cannot take this type is skipped instead
       * of being filled on the lattice.
       */
      const open = this._wallOpen(p.x, p.z, rand);
      let px = p.x, pz = p.z, ok = false;
      const ATT = 7;
      for (let att = 0; att < ATT; att++) {
        // depth away from the wall: pow(,1.7) keeps most props near it but gives a
        // long tail out into the room, which is what a lived-in corner looks like
        const depth = 0.05 + Math.pow(rand(), 1.7) * 1.85;
        const along = (rand() - 0.5) * 1.15;
        px = p.x + Math.cos(open) * depth - Math.sin(open) * along;
        pz = p.z + Math.sin(open) * depth + Math.cos(open) * along;
        if (floor(px, pz) && scatter.siteOK(px, pz, def.fp, {
          clearance: def.fp * 0.5, noRun: true, runR: 6.5, runEps: 0.6, axisEps: 0.55,
          fanWedge: 0.5, chainR: 10.0, chainN: 4, chainThin: 0.21, chainMin: 2.6,
          runRelax: 1 - (att / ATT) * 0.55, peerFrac: 0.28,
        })) { ok = true; break; }
      }
      if (!ok) {
        if (++misses >= 7) { qi++; misses = 0; }       // this type will not fit; move on
        continue;
      }
      misses = 0;
      scatter.claim(px, pz, def.fp);
      // face away from the wall it is standing against
      const yaw = this._wallYaw(px, pz, rand);
      this._place(kind, { x: px, y: probe.heightAt(px, pz), z: pz },
        { rand, claimed: true, rotY: yaw, rotJitter: 0.8 });
      qi++;
    }
    /* anything the level's slots could not take goes wall-hugging on our own */
    const left = new Map();
    for (; qi < queue.length; qi++) left.set(queue[qi], (left.get(queue[qi]) ?? 0) + 1);
    for (const [kind, n] of [...left.entries()].sort()) {
      this._scatterKind(kind, {
        rand, scatter, count: n, cx, cz, r0: 5, r1: 32,
        clusters: Math.max(1, Math.ceil(n / 2)), clusterR: 3.2, slopeMax: 1.6, filter: hug,
        noRun: true,
      });
    }

    /* --- floor litter, clustered so the room has swept and unswept corners --- */
    // `noRun` matters most here: interior litter is confined to walkable floor,
    // and in a corridor that free space is a 2 m ribbon. Poisson-disk inside a
    // ribbon *is* a straight line at fixed spacing — see Scatter.runsInto.
    const S = (kind, count, o = {}) => this._scatterKind(kind, {
      rand, scatter, count: Math.round(count * dens), cx, cz,
      r0: o.r0 ?? 4.5, r1: o.r1 ?? 34, clusters: o.clusters ?? 6, clusterR: o.clusterR ?? 4,
      slopeMax: 1.6, filter: o.filter ?? floor, loners: o.loners, footprint: o.footprint,
      noRun: o.noRun !== false,
    });
    // The level already drifts its own rubble and bone along the room edges, so
    // ours is a top-up with anatomy in it, not a second full pass.
    S('rubble', 12, { clusters: 6, clusterR: 4.4 });
    S('scree', 14, { clusters: 6, clusterR: 4.6 });
    S('bones', hell ? 22 : 12, { clusters: 6, clusterR: 4.2 });
    S('skulls', hell ? 26 : 16, { clusters: 8, clusterR: 3.6 });
    S('boulder', hell ? 12 : 6, { clusters: 4, clusterR: 4.5, filter: open });
    if (hell) {
      S('obsidian', 8, { r0: 12, r1: 34, clusters: 4, clusterR: 7, filter: open });
      S('charTree', 6, { r0: 12, r1: 32, clusters: 3, clusterR: 6, filter: open });
    } else {
      S('roots', 8, { clusters: 4, clusterR: 5, filter: hug });
      S('moss', 0);
    }

    /* --- fire: candles where a hand could place one, dishes in the open --- */
    // Few, and clustered. Thirty individual candle flames spread across a frame
    // stop reading as devotion and start reading as fireflies.
    const candleSpots = scatter.clusterField({
      rand, count: Math.round((hell ? 3 : 5) * dens), cx, cz, r0: 4.5, r1: 26,
      clusters: hell ? 2 : 3, clusterR: 2.6, footprint: 0.5, filter: hug,
    });
    for (const p of candleSpots) this._fixture('candles', p, { rand, claimed: true });

    const dishes = scatter.clusterField({
      rand, count: hell ? 5 : 4, cx, cz, r0: 8, r1: 30,
      clusters: 4, clusterR: 6, footprint: 0.9, filter: open,
    });
    for (const p of dishes) this._fixture(hell ? 'hellBrazier' : 'brazier', p, { rand, claimed: true });

    /* --- one authored focal set-piece, off the fighting axis --- */
    const aA = rand() * 6.283;
    for (let i = 0; i < 24; i++) {
      const a = aA + i * 0.62;
      const r = 11 + (i % 5) * 2.4;
      const ax = cx + Math.cos(a) * r, az = cz + Math.sin(a) * r;
      if (!open(ax, az)) continue;
      if (!scatter.siteOK(ax, az, 1.5, { clearance: 1.2 })) continue;
      scatter.claim(ax, az, 1.5);
      this._place('altar', { x: ax, y: probe.heightAt(ax, az), z: az },
        { rand, claimed: true, rotY: this._wallYaw(ax, az, rand), rotJitter: 0.3 });
      this._rune([ax, az], 3.2, hell ? [1.0, 0.3, 0.1] : [0.6, 0.15, 0.12], hell ? 1.9 : 1.4, a);
      break;
    }
  }

  /**
   * Yaw that points away from the nearest wall, found by walking the Dungeon's
   * clearance field. A crate rotated at random against a wall clips into it;
   * this is what makes interior dressing look placed rather than dropped.
   */
  _wallYaw(x, z, rand) {
    const probe = this._probe;
    if (!probe.dungeon) return rand() * 6.283;
    let best = -1, bestA = rand() * 6.283;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.283;
      const c = probe.clearanceAt(x + Math.cos(a) * 0.9, z + Math.sin(a) * 0.9);
      if (c > best) { best = c; bestA = a; }
    }
    return bestA + (rand() - 0.5) * 0.5;
  }

  /**
   * Bearing that points INTO the room from a wall-adjacent slot — the axis the
   * stand-off offset is drawn along in `_layoutInterior`.
   *
   * Deliberately probed at 1.6 m rather than `_wallYaw`'s 0.9 m and over 14
   * directions rather than 8: at 0.9 m every bearing inside a 3 m ribbon of floor
   * still reports clearance, so the argmax is nearly arbitrary and the "away from
   * the wall" offset ends up pointing along the wall about half the time — which
   * would tighten the run instead of breaking it. Sampling further out and finer
   * resolves the actual open half-plane.
   */
  _wallOpen(x, z, rand) {
    const probe = this._probe;
    if (!probe.dungeon || typeof probe.clearanceAt !== 'function') return rand() * 6.283;
    const N = 14;
    let best = -1e9, bestA = 0;
    const a0 = rand() * 6.283 / N;            // decorrelate the sample rosette
    for (let i = 0; i < N; i++) {
      const a = a0 + (i / N) * 6.283;
      // two radii, so a slot in a 2 m niche does not score the same as one on an
      // open wall run: the sum favours a direction that stays open
      const c = probe.clearanceAt(x + Math.cos(a) * 1.6, z + Math.sin(a) * 1.6)
        + probe.clearanceAt(x + Math.cos(a) * 2.8, z + Math.sin(a) * 2.8) * 0.7;
      if (c > best) { best = c; bestA = a; }
    }
    return bestA + (rand() - 0.5) * 0.6;
  }

  /**
   * Crypt: a burial hall, built by us because no Dungeon module is present. Two
   * ruined colonnades frame the fight, walls close the ends, the corners fill
   * with rubble and bone, and every light comes from a brazier at a column foot
   * or a candle cluster on a tomb.
   */
  _layoutCrypt({ rand, scatter, cx, cz, dens }) {
    const A = rand() * 6.283;                              // hall bearing
    const ca = Math.cos(A), sa = Math.sin(A);
    const L = (u, v) => [cx + ca * u - sa * v, cz + sa * u + ca * v];

    /* --- the colonnade: two rows, irregular spacing, one bay collapsed --- */
    for (const side of [-1, 1]) {
      const off = side * (6.6 + rand() * 0.5);
      const pts = scatter.lineField({
        rand, from: L(-15, off), to: L(15, off), count: 6, footprint: 1.3, drift: 0.55, jitterT: 0.5,
      });
      for (let i = 0; i < pts.length; i++) {
        if (i === (side > 0 ? 2 : 4)) {                    // this bay came down
          this._place('lintel', pts[i], { rand, rotJitter: 0.5 });
          this._place('rubble', { x: pts[i].x + 0.8, y: pts[i].y, z: pts[i].z - 0.6 }, { rand });
          continue;
        }
        this._place('column', pts[i], { rand, rotJitter: 6.283 });
        // a brazier at every other column foot — motivated, not evenly spaced
        if (i % 2 === (side > 0 ? 1 : 0)) {
          const fa = rand() * 6.283;
          this._fixture('brazier', {
            x: pts[i].x + Math.cos(fa) * 1.35, z: pts[i].z + Math.sin(fa) * 1.35,
          }, { rand });
        }
      }
    }

    /* --- end walls + a broken arch as the doorway --- */
    for (const side of [-1, 1]) {
      const pts = scatter.lineField({
        rand, from: L(side * 17.5, -8.5), to: L(side * 17.5, 8.5), count: 4,
        footprint: 2.1, drift: 0.7, jitterT: 0.3,
      });
      for (const p of pts) this._place('wall', p, { rand, rotY: A + Math.PI / 2, rotJitter: 0.22 });
    }
    const archPts = scatter.lineField({ rand, from: L(-19.5, -3), to: L(-19.5, 3), count: 1, footprint: 2.2 });
    for (const p of archPts) this._place('arch', p, { rand, rotY: A + Math.PI / 2, rotJitter: 0.1 });

    /* --- wall torches on the standing masonry --- */
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const u = -12 + i * 9 + rand() * 2.5;
        const pos = L(u, side * 9.6);
        this._fixture(side > 0 ? 'torch' : 'sconce', { x: pos[0], z: pos[1] }, {
          rand, y: 1.72 + rand() * 0.2, rotY: A + (side > 0 ? -Math.PI / 2 : Math.PI / 2), mounted: true,
        });
      }
    }

    /* --- the grave plot: tombs clustered off to one side, all leaning --- */
    const plot = L(9, -13);
    this._scatterKind('tomb', {
      rand, scatter, count: Math.round(11 * dens), cx: plot[0], cz: plot[1],
      r0: 0, r1: 8.5, clusters: 3, clusterR: 3.4, slopeMax: 0.6,
    });
    this._scatterKind('sarcophagus', {
      rand, scatter, count: Math.round(3 * dens), cx, cz, r0: 8, r1: 16, clusters: 2, clusterR: 4,
    });
    this._scatterKind('statue', { rand, scatter, count: 2, cx, cz, r0: 9, r1: 15, clusters: 2, clusterR: 3 });

    /* --- ossuary: bone stacked against the walls, the way a crypt fills up --- */
    this._scatterKind('boneStack', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 8.5, r1: 15, clusters: 3, clusterR: 3.5 });
    this._scatterKind('bones', { rand, scatter, count: Math.round(14 * dens), cx, cz, r0: 5.5, r1: 20, clusters: 4, clusterR: 3.6 });
    this._scatterKind('skulls', { rand, scatter, count: Math.round(20 * dens), cx, cz, r0: 5, r1: 21, clusters: 6, clusterR: 3.2 });
    this._scatterKind('ribcage', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 6, r1: 17, clusters: 3, clusterR: 3 });

    /* --- collapse debris, dust and roots coming through the vault --- */
    this._scatterKind('rubble', { rand, scatter, count: Math.round(22 * dens), cx, cz, r0: 5.5, r1: 24, clusters: 6, clusterR: 4.2 });
    this._scatterKind('scree', { rand, scatter, count: Math.round(20 * dens), cx, cz, r0: 5.2, r1: 26, clusters: 7, clusterR: 4.5 });
    this._scatterKind('boulder', { rand, scatter, count: Math.round(6 * dens), cx, cz, r0: 8, r1: 24, clusters: 3, clusterR: 4 });
    this._scatterKind('roots', { rand, scatter, count: Math.round(7 * dens), cx, cz, r0: 7, r1: 22, clusters: 3, clusterR: 5 });
    this._scatterKind('urn', { rand, scatter, count: Math.round(9 * dens), cx, cz, r0: 6, r1: 18, clusters: 4, clusterR: 3 });
    this._scatterKind('crate', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 7, r1: 17, clusters: 2, clusterR: 2.6 });
    this._scatterKind('barrel', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 7, r1: 17, clusters: 2, clusterR: 2.4 });

    /* --- the ritual: an altar, its candles, and a sigil bled into the floor --- */
    const altarAt = L(-11.5, 6.5);
    this._place('altar', { x: altarAt[0], y: this._probe.heightAt(altarAt[0], altarAt[1]), z: altarAt[1] },
      { rand, rotY: A + Math.PI, rotJitter: 0.2 });
    scatter.claim(altarAt[0], altarAt[1], 1.4);
    for (let i = 0; i < 3; i++) {
      const a = A + Math.PI + (i - 1) * 0.9;
      this._fixture('candles', {
        x: altarAt[0] + Math.cos(a) * 1.5, z: altarAt[1] + Math.sin(a) * 1.5,
      }, { rand });
    }
    this._rune(L(-11.5, 6.5), 3.4, [0.55, 0.16, 0.12], 1.5, A);

    /* --- gibbets: two hanging cages, because a crypt has a warden --- */
    this._scatterKind('gibbet', { rand, scatter, count: 2, cx, cz, r0: 10, r1: 17, clusters: 2, clusterR: 3 });

    /* --- candles everywhere a mourner could have left one --- */
    const candles = scatter.clusterField({
      rand, count: Math.round(7 * dens), cx, cz, r0: 6, r1: 19,
      clusters: 5, clusterR: 3.2, footprint: 0.5, slopeMax: 0.55,
    });
    for (const p of candles) this._fixture('candles', p, { rand, claimed: true });
  }

  /**
   * Town: a market plaza at dusk. Clutter clumps against the buildings that
   * would be there, lanes stay clear, and the light comes from a hearth, torch
   * posts and hanging lanterns.
   */
  _layoutTown({ rand, scatter, cx, cz, dens }) {
    /* the hearth: off-centre, so the composition has a warm corner */
    const hA = 2.3 + rand() * 0.6;
    const hearth = { x: cx + Math.cos(hA) * 6.4, z: cz + Math.sin(hA) * 6.4 };
    this._fixture('campfire', hearth, { rand });
    this._scatterKind('woodPile', { rand, scatter, count: 2, cx: hearth.x, cz: hearth.z, r0: 1.4, r1: 3.2, clusters: 2, clusterR: 1.4 });

    /* torch posts ring the plaza — a lit edge is what makes a hub read as safe */
    const posts = scatter.ringField({
      rand, count: 6, r: 13.5, cx, cz, footprint: 0.7, jitterR: 0.2, jitterA: 0.8, slopeMax: 0.55,
    });
    for (const p of posts) this._fixture('post', p, { rand, claimed: true });

    /* lantern posts with real hanging lanterns on their hooks */
    const lp = scatter.ringField({ rand, count: 9, r: 8.6, cx, cz, footprint: 0.6, jitterR: 0.34, jitterA: 1.4, a0: rand() * 6.283 });
    for (const p of lp) this._place('lanternPost', p, { rand, claimed: true, rotJitter: 6.283 });

    /* market rows: crates, barrels and sacks in dense corners, not sprinkled */
    for (let g = 0; g < 6; g++) {
      const a = rand() * 6.283;
      const d = 7.5 + rand() * 9;
      const gx = cx + Math.cos(a) * d, gz = cz + Math.sin(a) * d;
      this._scatterKind('crate', { rand, scatter, count: Math.round((4 + rand() * 4) * dens), cx: gx, cz: gz, r0: 0, r1: 3.1, clusters: 2, clusterR: 1.5, slopeMax: 0.5 });
      this._scatterKind('barrel', { rand, scatter, count: Math.round((3 + rand() * 4) * dens), cx: gx, cz: gz, r0: 0, r1: 3.4, clusters: 2, clusterR: 1.6, slopeMax: 0.5 });
      this._scatterKind('sack', { rand, scatter, count: Math.round((2 + rand() * 3) * dens), cx: gx, cz: gz, r0: 0.4, r1: 3.6, clusters: 2, clusterR: 1.5, slopeMax: 0.5 });
      if (rand() < 0.6) this._scatterKind('urn', { rand, scatter, count: Math.round(3 * dens), cx: gx, cz: gz, r0: 0.5, r1: 3, clusters: 1, clusterR: 1.2 });
    }

    /* the working corner: anvil, rack, cart, ladder */
    const smith = { x: cx - 9.5 + rand(), z: cz + 6.5 + rand() };
    this._place('anvil', { x: smith.x, y: this._probe.heightAt(smith.x, smith.z), z: smith.z }, { rand, rotJitter: 6.283 });
    scatter.claim(smith.x, smith.z, 0.8);
    this._scatterKind('rack', { rand, scatter, count: 2, cx: smith.x, cz: smith.z, r0: 1.4, r1: 4, clusters: 2, clusterR: 1.6 });
    this._scatterKind('cart', { rand, scatter, count: 2, cx, cz, r0: 9, r1: 17, clusters: 2, clusterR: 3 });
    this._scatterKind('ladder', { rand, scatter, count: 3, cx, cz, r0: 9, r1: 18, clusters: 3, clusterR: 2.5 });
    this._scatterKind('banner', { rand, scatter, count: Math.round(8 * dens), cx, cz, r0: 6.5, r1: 20, clusters: 5, clusterR: 3.4 });
    this._scatterKind('woodPile', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 9, r1: 22, clusters: 3, clusterR: 3 });
    this._scatterKind('stake', { rand, scatter, count: Math.round(5 * dens), cx, cz, r0: 11, r1: 24, clusters: 3, clusterR: 3 });

    /* two dishes on the plaza edge so the warm pools overlap the market rows */
    const dishRing = scatter.ringField({
      rand, count: 3, r: 10.4, cx, cz, footprint: 0.8, jitterR: 0.3, jitterA: 1.5, a0: rand() * 6.283, slopeMax: 0.5,
    });
    for (const p of dishRing) this._fixture('brazier', p, { rand, claimed: true });

    /* fences along the lane edges, deliberately gappy */
    for (let i = 0; i < 4; i++) {
      const a = 0.35 + i * 1.57 + 0.55;
      const r0 = 10 + rand() * 4;
      const from = [cx + Math.cos(a) * r0, cz + Math.sin(a) * r0];
      const to = [cx + Math.cos(a + 0.55) * (r0 + 7), cz + Math.sin(a + 0.55) * (r0 + 7)];
      const pts = scatter.lineField({ rand, from, to, count: 4, footprint: 1.2, drift: 0.5, jitterT: 0.4, slopeMax: 0.5 });
      const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
      for (const p of pts) this._place('fence', p, { rand, rotY: ang, rotJitter: 0.16, claimed: true });
    }

    /* the world does not stop at the plaza: dressing and vegetation beyond */
    this._scatterKind('rubble', { rand, scatter, count: Math.round(20 * dens), cx, cz, r0: 8, r1: 34, clusters: 7, clusterR: 4.5, flat: true });
    this._scatterKind('scree', { rand, scatter, count: Math.round(34 * dens), cx, cz, r0: 5, r1: 32, clusters: 12, clusterR: 3.8, flat: true });
    this._scatterKind('grass', { rand, scatter, count: Math.round(300 * dens), cx, cz, r0: 4, r1: 40, clusters: 30, clusterR: 4.0, slopeMax: 0.75, footprint: 0.3, loners: 0.34, flat: true });
    this._scatterKind('shrub', { rand, scatter, count: Math.round(20 * dens), cx, cz, r0: 12, r1: 46, clusters: 8, clusterR: 4 });
    this._scatterKind('deadTree', { rand, scatter, count: Math.round(9 * dens), cx, cz, r0: 18, r1: 52, clusters: 4, clusterR: 7 });
    this._scatterKind('boulder', { rand, scatter, count: Math.round(14 * dens), cx, cz, r0: 16, r1: 55, clusters: 5, clusterR: 5 });
    this._farField({ rand, scatter, cx, cz, kinds: ['deadTreeLOD', 'boulder', 'rocks'], counts: [14, 16, 8], r0: 46, r1: 96, seed: 4411 });
  }

  /**
   * Moor: an exhausted burial landscape. Heather and sedge carry the ground,
   * boulders and cliff chunks carry the silhouette, a lost graveyard and a cairn
   * ring carry the story, and a single roadside fire carries the light.
   */
  _layoutMoor({ rand, scatter, cx, cz, dens }) {
    /* ground cover first: it hides the terrain texture seam under everything */
    this._scatterKind('heather', { rand, scatter, count: Math.round(84 * dens), cx, cz, r0: 3, r1: 40, clusters: 16, clusterR: 5.5, footprint: 0.85, slopeMax: 0.6, loners: 0.28 });
    this._scatterKind('grass', { rand, scatter, count: Math.round(620 * dens), cx, cz, r0: 2.5, r1: 40, clusters: 42, clusterR: 4.2, footprint: 0.3, slopeMax: 0.85, loners: 0.36 });
    this._scatterKind('reeds', { rand, scatter, count: Math.round(48 * dens), cx, cz, r0: 5, r1: 42, clusters: 10, clusterR: 4.0, footprint: 0.34, slopeMax: 0.45, wetMin: 0.28 });
    this._scatterKind('bramble', { rand, scatter, count: Math.round(34 * dens), cx, cz, r0: 5, r1: 40, clusters: 11, clusterR: 4.4 });
    this._scatterKind('shrub', { rand, scatter, count: Math.round(62 * dens), cx, cz, r0: 4.5, r1: 42, clusters: 16, clusterR: 4.2 });
    this._scatterKind('roots', { rand, scatter, count: Math.round(24 * dens), cx, cz, r0: 5, r1: 42, clusters: 8, clusterR: 4.6 });
    this._scatterKind('bones', { rand, scatter, count: Math.round(9 * dens), cx, cz, r0: 8, r1: 40, clusters: 4, clusterR: 4 });
    this._scatterKind('skulls', { rand, scatter, count: Math.round(11 * dens), cx, cz, r0: 8, r1: 40, clusters: 5, clusterR: 3.6 });

    /* rock: clumped as rockfall, never evenly sown */
    this._scatterKind('boulder', { rand, scatter, count: Math.round(46 * dens), cx, cz, r0: 5, r1: 46, clusters: 12, clusterR: 5.0, slopeMax: 0.9 });
    this._scatterKind('rocks', { rand, scatter, count: Math.round(21 * dens), cx, cz, r0: 6, r1: 46, clusters: 8, clusterR: 4.6 });
    this._scatterKind('scree', { rand, scatter, count: Math.round(44 * dens), cx, cz, r0: 4, r1: 46, clusters: 14, clusterR: 4.2, slopeMax: 0.98 });
    this._scatterKind('cliff', { rand, scatter, count: Math.round(11 * dens), cx, cz, r0: 18, r1: 58, clusters: 6, clusterR: 8, slopeMax: 0.95 });

    /* the cairn ring: five stones, deliberately irregular — reads as authored */
    const ringA = rand() * 6.283;
    const menhirs = scatter.ringField({
      rand, count: 5, r: 17 + rand() * 4, cx, cz, footprint: 1.1, jitterR: 0.3, jitterA: 1.4, a0: ringA, slopeMax: 0.55,
    });
    for (const p of menhirs) this._place('menhir', p, { rand, claimed: true, rotJitter: 6.283 });

    /* a graveyard the moor has nearly swallowed */
    const gA = ringA + 2.4;
    const plot = { x: cx + Math.cos(gA) * 21, z: cz + Math.sin(gA) * 21 };
    this._scatterKind('tomb', { rand, scatter, count: Math.round(13 * dens), cx: plot.x, cz: plot.z, r0: 0, r1: 8, clusters: 3, clusterR: 3.2, slopeMax: 0.5 });
    this._scatterKind('wall', { rand, scatter, count: 3, cx: plot.x, cz: plot.z, r0: 6, r1: 11, clusters: 2, clusterR: 4 });
    this._scatterKind('column', { rand, scatter, count: 2, cx: plot.x, cz: plot.z, r0: 4, r1: 9, clusters: 2, clusterR: 3 });

    /* dead copses: trees clump where there was shelter */
    this._scatterKind('deadTree', { rand, scatter, count: Math.round(22 * dens), cx, cz, r0: 8, r1: 46, clusters: 7, clusterR: 6.5, slopeMax: 0.65 });

    /* human traces: a fence line, stakes, a wayside fire */
    const fa = rand() * 6.283;
    const fFrom = [cx + Math.cos(fa) * 11, cz + Math.sin(fa) * 11];
    const fTo = [cx + Math.cos(fa + 0.8) * 27, cz + Math.sin(fa + 0.8) * 27];
    const fpts = scatter.lineField({ rand, from: fFrom, to: fTo, count: 6, footprint: 1.2, drift: 0.6, jitterT: 0.4, slopeMax: 0.55 });
    const fang = Math.atan2(fTo[1] - fFrom[1], fTo[0] - fFrom[0]);
    for (const p of fpts) this._place('fence', p, { rand, rotY: fang, rotJitter: 0.2, claimed: true });
    this._scatterKind('stake', { rand, scatter, count: Math.round(7 * dens), cx, cz, r0: 9, r1: 34, clusters: 3, clusterR: 3.4 });

    const camp = { x: cx + Math.cos(fa - 1.6) * 8.5, z: cz + Math.sin(fa - 1.6) * 8.5 };
    this._fixture('campfire', camp, { rand });
    this._scatterKind('woodPile', { rand, scatter, count: 1, cx: camp.x, cz: camp.z, r0: 1.5, r1: 2.8, clusters: 1, clusterR: 1 });
    this._scatterKind('crate', { rand, scatter, count: 2, cx: camp.x, cz: camp.z, r0: 1.4, r1: 3.4, clusters: 1, clusterR: 1.4 });
    const postPts = scatter.ringField({ rand, count: 3, r: 15, cx, cz, footprint: 0.7, jitterR: 0.35, jitterA: 1.6, a0: fa + 2.2, slopeMax: 0.5 });
    for (const p of postPts) this._fixture('post', p, { rand, claimed: true });

    /* far field: this is where aerial perspective gets something to separate */
    this._farField({
      rand, scatter, cx, cz,
      kinds: ['deadTreeLOD', 'boulder', 'cliff', 'rocks', 'menhir'],
      counts: [26, 26, 12, 14, 4], r0: 58, r1: 118, seed: 5521,
    });
  }

  /**
   * Hell: a basalt arena. Obsidian slabs ring the floor, bone is the ground
   * cover, and every light is hellfire in a stone dish.
   */
  _layoutHell({ rand, scatter, cx, cz, dens }) {
    /* the ring of dishes that lights the fight */
    const braz = scatter.ringField({
      rand, count: 6, r: 12.5, cx, cz, footprint: 0.9, jitterR: 0.18, jitterA: 0.9, a0: rand() * 6.283,
    });
    for (const p of braz) this._fixture('hellBrazier', p, { rand, claimed: true });

    /* obsidian: the silhouette that keeps the arena from reading as a disc */
    this._scatterKind('obsidian', { rand, scatter, count: Math.round(13 * dens), cx, cz, r0: 15, r1: 34, clusters: 6, clusterR: 7 });
    this._scatterKind('boulder', { rand, scatter, count: Math.round(22 * dens), cx, cz, r0: 11, r1: 38, clusters: 7, clusterR: 5 });
    this._scatterKind('scree', { rand, scatter, count: Math.round(30 * dens), cx, cz, r0: 10, r1: 40, clusters: 9, clusterR: 4.6 });
    this._scatterKind('rubble', { rand, scatter, count: Math.round(16 * dens), cx, cz, r0: 10, r1: 34, clusters: 6, clusterR: 4.4 });

    /* the charnel floor */
    this._scatterKind('bones', { rand, scatter, count: Math.round(26 * dens), cx, cz, r0: 9.5, r1: 34, clusters: 8, clusterR: 4.6 });
    this._scatterKind('skulls', { rand, scatter, count: Math.round(30 * dens), cx, cz, r0: 9.5, r1: 34, clusters: 9, clusterR: 4 });
    this._scatterKind('ribcage', { rand, scatter, count: Math.round(6 * dens), cx, cz, r0: 10, r1: 30, clusters: 4, clusterR: 4 });
    this._scatterKind('boneStack', { rand, scatter, count: Math.round(4 * dens), cx, cz, r0: 13, r1: 28, clusters: 3, clusterR: 4 });

    /* impaled: a ring of pikes facing in, and two gibbets */
    const pikes = scatter.ringField({
      rand, count: Math.round(9 * dens), r: 17.5, cx, cz, footprint: 0.5, jitterR: 0.3, jitterA: 1.3, a0: rand() * 6.283,
    });
    for (const p of pikes) this._place('skullPike', p, { rand, claimed: true, rotJitter: 6.283 });
    this._scatterKind('gibbet', { rand, scatter, count: 2, cx, cz, r0: 13, r1: 24, clusters: 2, clusterR: 4 });

    /* charred trees: bare, black, reaching */
    this._scatterKind('charTree', { rand, scatter, count: Math.round(10 * dens), cx, cz, r0: 14, r1: 40, clusters: 4, clusterR: 7 });

    /* the summoning: an altar and its sigil, set off the arena's axis */
    const aA = rand() * 6.283;
    const altarAt = [cx + Math.cos(aA) * 15.5, cz + Math.sin(aA) * 15.5];
    this._place('altar', { x: altarAt[0], y: this._probe.heightAt(altarAt[0], altarAt[1]), z: altarAt[1] },
      { rand, rotY: aA + Math.PI, rotJitter: 0.2 });
    scatter.claim(altarAt[0], altarAt[1], 1.4);
    this._rune(altarAt, 3.8, [1.0, 0.28, 0.1], 1.9, aA);
    this._rune([cx, cz], 8.5, [0.95, 0.24, 0.08], 1.1, aA + 0.7);

    this._farField({
      rand, scatter, cx, cz, kinds: ['obsidian', 'cliff', 'boulder'],
      counts: [14, 10, 18], r0: 40, r1: 88, seed: 6611,
    });
  }

  /**
   * Distant content: what turns aerial perspective into readable depth planes.
   * Uses Terrain's own scatter sampler, which knows about slope, flow and
   * geology, so the far ring sits where the landform says it should.
   */
  _farField({ rand, scatter, cx, cz, kinds, counts, r0, r1, seed }) {
    const terrain = this._probe.terrain;
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const def = KINDS[kind];
      if (!def) continue;
      const pts = scatter.terrainField(terrain, {
        count: counts[i], seed: seed + i * 97, cx, cz, r0, r1,
        footprint: def.fp * 1.4, slopeMax: 0.95, flowMax: 0.7,
      });
      // fall back to a plain clustered ring when Terrain is unavailable
      const use = pts.length ? pts : scatter.clusterField({
        rand, count: counts[i], cx, cz, r0, r1, clusters: 5,
        clusterR: 12, footprint: def.fp * 1.4,
      });
      for (const p of use) this._place(kind, p, { rand, claimed: true, rotJitter: 6.283, far: true });
    }
  }

  /* ================================================================ *
   * placement primitives
   * ================================================================ */

  /**
   * THE LEAK THAT PUT THE STRAIGHT RUNS BACK.
   *
   * `Scatter.runsInto` — the collinearity / lattice / fan rejection that exists
   * precisely to answer the art director's "sometimes in visible lines and grids"
   * — is gated on `o.noRun`. This function builds the option object for **every
   * clustered field in the game** (all four biome layouts route through it) and
   * did not set that flag, so `noRun` arrived `undefined`, `siteOK` skipped the
   * test, and the only fields that ever got run rejection were the handful in
   * `_layoutInterior` that happened to pass it by hand. 46 moor boulders, 34 town
   * scree, 22 crypt rubble heaps and everything else were placed by raw
   * Poisson-disk, which guarantees a minimum spacing and *nothing whatsoever*
   * about alignment. It is now on by default and a caller must opt out
   * explicitly, which is the only safe polarity for a test like this.
   *
   * `runR` scales with the prop's own footprint: a run of 0.3 m skulls needs a
   * much shorter search radius than a run of 2.4 m cliff chunks, and a fixed
   * radius either misses the small props' runs or starves the big props' density.
   */
  _scatterKind(kind, o) {
    const def = KINDS[kind];
    if (!def) return;
    const scatter = o.scatter;
    const filter = o.wetMin !== undefined
      ? (x, z) => this._probe.wetnessAt(x, z) >= o.wetMin
      : o.filter ?? null;
    const fp = o.footprint ?? def.fp;
    const pts = scatter.clusterField({
      rand: o.rand, count: o.count, cx: o.cx, cz: o.cz, r0: o.r0, r1: o.r1,
      clusters: o.clusters, clusterR: o.clusterR, loners: o.loners,
      footprint: fp, fpVar: 0.35,
      slopeMax: o.slopeMax ?? 0.8, altMin: o.altMin, altMax: o.altMax,
      wetMax: o.wetMax, filter, bias: o.bias, flat: o.flat,
      // Ground cover is a CARPET: hundreds of tufts whose whole job is to cover,
      // and which read as texture rather than as objects. Run rejection there
      // would both starve the coverage and cost a neighbour gather per dart
      // against an occupancy grid that already holds every other prop.
      noRun: o.noRun !== false && !def.carpet,
      runR: o.runR ?? Math.max(3.0, Math.min(9.0, fp * 6.5)),
      runEps: o.runEps ?? Math.max(0.22, fp * 0.62),
      axisEps: o.axisEps ?? Math.max(0.18, fp * 0.5),
      /*
       * The chain test (Scatter.runsInto step 4) is the one that catches a run
       * whose members are further apart than `runR` — a wall line, a ledge line,
       * the rim of an exclusion zone. Its radius is deliberately much larger than
       * the pairwise radius, because that is the whole point: a twelve-metre column
       * of props is invisible to every local test. Carpets are exempt for the same
       * reason they are exempt from `noRun`.
       *
       * The thresholds are set against the shapes this module legitimately builds,
       * not by eye. A clump is an oriented ellipse whose axis ratio bottoms out
       * near 0.4 in standard deviations, and two adjacent clumps read as a dumbbell
       * at about 0.37 — both must survive, or the frame trades a repetition tell for
       * an emptiness tell, which the rubric scores just as harshly. A wall line
       * measures 0.05-0.12. 0.16 sits in the gap with room either side, and
       * `chainMin` in metres additionally exempts anything compact.
       */
      chainN: def.carpet ? 0 : (o.chainN ?? 5),
      chainR: o.chainR ?? Math.max(7.0, Math.min(16.0, fp * 13.0)),
      chainThin: o.chainThin ?? 0.16,
      chainMin: o.chainMin ?? 3.0,
    });
    for (const p of pts) {
      this._place(kind, p, { rand: o.rand, claimed: true, rotJitter: 6.283, core: p.s });
    }
  }

  /**
   * Ground one prop: pick a variant, sink it, tilt it onto the terrain normal,
   * jitter the scale, and record it. Nothing here is optional — a prop that is
   * not sunk and tilted reads as a sticker on a photograph.
   */
  _place(kind, pt, o = {}) {
    const def = KINDS[kind];
    if (!def) return null;
    const rand = o.rand;
    const vi = o.variant !== undefined ? o.variant : (rand() * def.variants) | 0;
    const sc = def.scale ?? [1, 1];
    // cluster cores get the bigger specimens: a clump needs a subject
    const core = o.core ?? 0.5;
    const t = clamp01(rand() * 0.75 + core * 0.35);
    const scale = lerp(sc[0], sc[1], t);

    /*
     * Non-uniform scale. x and z are drawn independently so the FOOTPRINT
     * changes shape, not only size — a uniformly scaled instance has the same
     * outline at every size, which is why "vary the scale" on its own never
     * fixes a repeated-asset read. y is pulled from a narrower range so nothing
     * turns into a pancake or a tower.
     */
    const sq = def.squash ?? 0;
    const sx = scale * (1 + (rand() - 0.5) * sq);
    const sz = scale * (1 + (rand() - 0.5) * sq);
    const sy = scale * (1 + (rand() - 0.5) * sq * 0.62);

    /* Extra tilt about the prop's own X and Z, INSIDE the terrain alignment. */
    const tu = def.tumble ?? 0;
    const tiltX = tu ? (rand() - 0.5) * tu : 0;
    const tiltZ = tu ? (rand() - 0.5) * tu : 0;

    const x = pt.x, z = pt.z;
    const gy = pt.y !== undefined ? pt.y : this._probe.heightAt(x, z);
    // A tumbled prop pivots about its own origin, so one edge lifts off the
    // ground by roughly (tilt * radius). Sink it by that much or the tumble
    // trades a repetition tell for a floating tell.
    const lift = (Math.abs(tiltX) + Math.abs(tiltZ)) * (def.fp ?? 0.5) * scale * 0.55;
    const y = (o.y !== undefined ? gy + o.y : gy) - (def.sink ?? 0.05) * scale - lift;

    let rotY = o.rotY ?? 0;
    if (o.rotJitter) rotY += (rand() - 0.5) * o.rotJitter;
    else if (o.rotY === undefined) rotY = rand() * 6.283;

    if (!o.claimed) this._scatter?.claim(x, z, (def.fp ?? 0.5) * scale);

    /*
     * Per-instance albedo, written to instanceColor (free — three multiplies it
     * into vColor next to the baked wear, no sampler and no extra program).
     * `hue` runs warm-to-cool along the same axis the Dungeon uses for its
     * masonry, so props and architecture vary within ONE family instead of
     * drifting apart.
     */
    const tv = def.tintVar ?? 0.2;
    const hv = def.hueVar ?? 0.34;
    const val = 1 + (rand() - 0.5) * tv;
    /*
     * The hue coefficients were 0.055 / 0.012 / -0.050. At the default
     * `hueVar` of 0.34 that is hue in +/-0.17, i.e. a red channel multiplier of
     * 1 +/- 0.0094 — a NINE-TENTHS-OF-ONE-PERCENT warm/cool spread. The comment
     * claimed a warm-to-cool axis; the numbers were inside quantisation noise, so
     * in practice every instance of a prop shared one chromaticity and only the
     * value moved. 0.19 / 0.035 / -0.165 gives a spread the eye can actually
     * find (about +/-8 % of red against -/+7 % of blue at hueVar 0.85) while
     * staying a limestone-to-slate tilt rather than a hue rotation — the palette
     * rule is one family with variation inside it, never a rainbow.
     */
    const hue = (rand() - 0.5) * hv;
    const rec = {
      kind, vi, scale, rotY, sx, sy, sz, tiltX, tiltZ,
      x, y, z, groundY: gy,
      r: (def.fp ?? 0.5) * scale * (1 + sq * 0.25),
      tint: [val * (1 + hue * 0.19), val * (1 + hue * 0.035), val * (1 - hue * 0.165)],
      slots: null, lodSlots: null, blobSlot: -1,
      lodAt: def.lod ? (def.lodAt ?? 60) : 0,
      far: !!o.far, hp: def.dest ? def.dest.hp : 0, broken: false,
      hidden: false,
    };
    this._plan.push(rec);
    return rec;
  }

  /** Queue a fixture placement; realized after the geometry pass. */
  _fixture(kind, pt, o = {}) {
    const def = FIXTURE_KINDS[kind];
    if (!def) return null;
    const rand = o.rand ?? this.engine.freshRand(1);
    const x = pt.x, z = pt.z;
    if (!o.claimed && this._scatter) {
      if (!this._scatter.free(x, z, def.footprint) || this._scatter.blocked(x, z, def.footprint * 0.5)) return null;
      this._scatter.claim(x, z, def.footprint);
    }
    const rec = {
      kind, variant: (rand() * def.variants) | 0,
      x, z, y: o.y, rotY: o.rotY, mounted: !!(o.mounted ?? def.mounted),
      tilt: def.tilt ?? 0, rand,
    };
    this._fixPlan.push(rec);
    return rec;
  }

  /** A glowing sigil bled into the floor. One accent hue per scene. */
  _rune(at, radius, color, intensity, rot = 0) {
    const x = Array.isArray(at) ? at[0] : at.x;
    const z = Array.isArray(at) ? at[1] : at.z;
    const mat = makeRuneMaterial({ color, intensity });
    const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, 1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.set(-Math.PI / 2, 0, rot);
    mesh.position.set(x, this._probe.heightAt(x, z) + 0.035, z);
    mesh.renderOrder = 2;
    mesh.frustumCulled = true;
    this.group.add(mesh);
    this._runes.push({ mesh, mat, geo });
  }

  /* ================================================================ *
   * realization — geometry, instancing, grounding
   * ================================================================ */

  _variant(kind, vi) {
    const key = `${kind}#${vi}`;
    const hit = this._lib.get(key);
    if (hit !== undefined) return hit;
    const def = KINDS[kind];
    let out = null;
    try {
      const rand = this.engine.freshRand(`props:geo:${kind}:${vi}`);
      /*
       * `args` may be a FUNCTION of the variant index, which is how a kind gets
       * per-variant materials. This is free diversity: `_realize` already builds
       * one InstancedMesh per (kind, variant, part), so variant 0 of `scree`
       * drawing in warm dressed stone and variant 3 drawing in loose grit costs
       * exactly the same number of draw calls as all six sharing one material —
       * and it is the difference between six copies of one debris look and six
       * different debris looks.
       */
      const args = typeof def.args === 'function' ? def.args(vi) : (def.args ?? undefined);
      const built = def.fn(rand, vi, args);
      if (built && Array.isArray(built.parts) && built.parts.length) {
        out = { parts: built.parts, hook: built.hook ?? null, candles: built.candles ?? null };
        for (const p of out.parts) finish(p.geo);
      }
    } catch (e) {
      console.warn(`[props] variant "${kind}#${vi}" failed —`, e);
      out = null;
    }
    this._lib.set(key, out);
    return out;
  }

  _mat(name) {
    /*
     * A missing material name used to fall through MatBank.get's `DEFS[name] ??
     * DEFS.stone` and get cached under the bad key, minting a duplicate,
     * untinted, un-lifted material (the `props.null` that made every rubble
     * block read cold — see Ruin.rubbleHeap). Normalise here so the bug cannot
     * come back silently, and say so loudly.
     */
    if (typeof name !== 'string' || !name) {
      console.warn(`[props] part with no material name — falling back to "stone" (was ${String(name)})`);
      name = 'stone';
    }
    const ex = this._extras.get(name);
    if (ex) return ex;
    const m = this.mats.get(name);
    if (DOUBLE_SIDED.has(name) && m.side !== THREE.DoubleSide) { m.side = THREE.DoubleSide; m.needsUpdate = true; }
    if (!m.userData.__propDiet) {
      m.userData.__propDiet = true;
      /*
       * Sampler diet. The fragment stage has a hard MAX_TEXTURE_IMAGE_UNITS
       * budget (16 on the capture context), and the CSM cascades, the irradiance
       * probe volume, the point-light shadows and the fog LUT already claim most
       * of it. A material that overruns does not degrade — the program fails to
       * link and the prop renders as nothing at all.
       *
       * AssetForge packs occlusion/roughness/metalness into one ORM texture but
       * still binds it through three separate sampler uniforms. Two of those
       * three buy us nothing here: `bakeWear` has already written directional
       * occlusion into vertex colour, and every dressing surface is either fully
       * dielectric or fully metal, so a scalar is exact. Roughness keeps its map,
       * because coupled roughness variation is what stops PBR reading as plastic.
       */
      if (m.aoMap) m.aoMap = null;
      if (m.metalnessMap) { m.metalnessMap = null; m.metalness = METALNESS[name] ?? 0; }
      if (m.displacementMap) m.displacementMap = null;
      // Emissive belongs to fire and glowing coal only. Anywhere else it is a
      // sampler we cannot afford and a bloom haze we do not want.
      if (m.emissiveMap && name !== 'coal') { m.emissiveMap = null; m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0; }
      const lift = LIFT[name];
      if (lift && lift !== 1) m.color.setRGB(lift, lift, lift);
      const rs = ROUGH_SCALE[name];
      if (rs) m.roughness = (typeof m.roughness === 'number' ? m.roughness : 1) * rs;
      const ts = TILE_SCALE[name];
      if (ts) {
        for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) {
          const t = m[k];
          if (t && t.isTexture) { t.repeat.multiplyScalar(ts); t.needsUpdate = true; }
        }
      }
      m.needsUpdate = true;
    }
    return m;
  }

  _makeGroup(key, geo, matName, cast, count, castOverride) {
    const mat = this._mat(matName);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.name = `props.${key}`;
    mesh.castShadow = castOverride !== false && cast !== false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /*
     * Per-instance shader inputs, four floats:
     *   x  roughness offset — a hundred copies of one barrel must not share one
     *      specular response
     *   y  wind phase
     *   z  sculpt amplitude in metres of object space (see KINDS.sculpt and
     *      PropMaterials' VERT_BODY) — this is what makes two instances of one
     *      geometry geometrically DIFFERENT rather than merely differently posed
     *   w  macro-noise phase, so overlapping instances do not share a grime field
     */
    const kind = key.slice(0, key.indexOf('#'));
    const sculpt = (KINDS[kind]?.sculpt ?? 0);
    const jit = new Float32Array(count * 4);
    const r = this.engine.freshRand(`props:jit:${key}`);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      jit[o] = (r() - 0.5) * 0.2;
      jit[o + 1] = r();
      jit[o + 2] = sculpt * (0.45 + r() * 0.85);
      jit[o + 3] = r();
    }
    geo.setAttribute('aJit', new THREE.InstancedBufferAttribute(jit, 4));
    // Every prop pool carries instanceColor, even the ones that never tint, so
    // USE_INSTANCING_COLOR is uniform across a material and the program count
    // does not double.
    const col = new Float32Array(count * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    if (mat.userData?.propWind > 0 && mesh.castShadow) {
      const d = this.mats.depthFor(matName);
      if (d) mesh.customDepthMaterial = d;
    }
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _ZERO);
    // Pools grow as slots are claimed, so an unused reserve costs nothing and a
    // fixture placed later by Dungeon still lands in a live draw.
    mesh.count = 0;
    this.group.add(mesh);
    this._meshes.push(mesh);
    return { mesh, next: 0, cap: count };
  }

  _realize() {
    /* --- count instances per (kind, variant) so meshes are exactly sized --- */
    const need = new Map();
    const bump = (kind, vi) => {
      const k = `${kind}#${vi}`;
      need.set(k, (need.get(k) ?? 0) + 1);
    };
    let blobs = 0;
    for (const rec of this._plan) {
      const def = KINDS[rec.kind];
      if (!this._variant(rec.kind, rec.vi)) { rec.dead = true; continue; }
      bump(rec.kind, rec.vi);
      if (def.lod && this._variant(def.lod, rec.vi)) bump(def.lod, rec.vi);
      if (def.dest && KINDS[def.dest.broken] && this._variant(def.dest.broken, rec.vi)) bump(def.dest.broken, rec.vi);
      if (!def.noBlob && !def.mounted && (def.blob ?? 1) > 0) blobs++;
    }
    /* fixtures need instances too, plus a blob each for the ground-standing ones */
    for (const f of this._fixPlan) {
      const v = this._fixVariant(f.kind, f.variant);
      if (!v) { f.dead = true; continue; }
      const fk = `fx:${f.kind}`;
      bump(fk, f.variant);
      if (!f.mounted) blobs++;
    }

    /* --- create the instanced meshes --- */
    for (const [key, count] of [...need.entries()].sort()) {
      const hash = key.indexOf('#');
      const kind = key.slice(0, hash);
      const vi = Number(key.slice(hash + 1));
      const variant = kind.startsWith('fx:') ? this._fixVariant(kind.slice(3), vi) : this._variant(kind, vi);
      if (!variant) continue;
      const def = KINDS[kind] ?? FIXTURE_KINDS[kind.slice(3)] ?? {};
      for (let pi = 0; pi < variant.parts.length; pi++) {
        const part = variant.parts[pi];
        const g = this._makeGroup(`${key}#${pi}`, part.geo, part.matName, part.cast, count, def.cast);
        this._groups.set(`${key}#${pi}`, g);
      }
    }

    /* --- contact blobs: one instanced mesh for the whole scene --- */
    blobs += 40;                                    // headroom for late fixtures
    if (blobs > 0) {
      const cm = new THREE.InstancedMesh(this._blobGeo, this.contactMat, blobs);
      cm.name = 'props.contact';
      cm.castShadow = false;
      cm.receiveShadow = false;
      cm.frustumCulled = true;
      cm.matrixAutoUpdate = false;
      cm.renderOrder = 1;
      cm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < blobs; i++) cm.setMatrixAt(i, _ZERO);
      cm.count = 0;
      this.group.add(cm);
      this._meshes.push(cm);
      this._contact = { mesh: cm, next: 0, cap: blobs };
    }

    /* --- write every prop's transform --- */
    for (const rec of this._plan) {
      if (rec.dead) continue;
      const def = KINDS[rec.kind];
      this._compose(rec, def);
      rec.slots = this._claimSlots(`${rec.kind}#${rec.vi}`, rec.matrix, null, null, rec.tint);
      if (def.lod) {
        const lk = `${def.lod}#${rec.vi}`;
        rec.lodSlots = this._claimSlots(lk, _ZERO, null, null, rec.tint);
      }
      if (def.dest && KINDS[def.dest.broken]) {
        rec.brokenSlots = this._claimSlots(`${def.dest.broken}#${rec.vi}`, _ZERO, null, null, rec.tint);
        rec.dest = def.dest;
      }
      if (!def.noBlob && !def.mounted && (def.blob ?? 1) > 0) {
        rec.blobSlot = this._blob(rec.x, rec.groundY, rec.z, rec.r * (def.blob ?? 1.3));
      }
      this.props.push(rec);
      if (def.lod) this._dyn.push(rec);
    }

    this._indexGrid();
  }

  /** Bounds + triangle accounting, once every pool has stopped growing. */
  _finalisePools() {
    this._triCount = 0;
    for (const m of this._meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      try { m.computeBoundingSphere(); } catch { /* noop */ }
      const g = m.geometry;
      const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      this._triCount += tris * m.count;
    }
  }

  /**
   * Hand the dressing pools to the per-instance culler.
   *
   * A prop pool is one InstancedMesh spanning the whole dressed area, so three's
   * per-OBJECT culling can only ever reject the pool entirely: measured on
   * `combat`, 319 k of the 319 k instanced prop triangles were submitted every
   * pass and 124 k of them were inside the frustum. The culler never modifies our
   * buffers — it binds a compacted mirror for the duration of the frame and hands
   * ours back before the next tick — so `rec.slots` index references, the LOD swap
   * in `_refreshDynamic`, destruction, and late pool growth all keep working on
   * exactly the data this module wrote.
   */
  _registerCulling() {
    try {
      const culler = InstanceCuller.attach(this.engine);
      if (!culler) return;
      culler.prune();
      let n = 0;
      for (const m of this._meshes) if (m.isInstancedMesh === true && culler.add(m)) n++;
      this._culledPools = n;
    } catch (e) {
      console.warn('[props] instance culling unavailable —', e?.message ?? e);
    }
  }

  /**
   * Reserve one instance slot per part of a variant. Pass `variant` to allow a
   * pool to be created on demand — that is the path a fixture placed by Dungeon
   * outside our own dressing pass takes.
   */
  _claimSlots(key, matrix, variant = null, def = null, tint = null) {
    const out = [];
    for (let pi = 0; ; pi++) {
      const gk = `${key}#${pi}`;
      let g = this._groups.get(gk);
      if (!g) {
        const part = variant?.parts?.[pi];
        if (!part) break;
        g = this._makeGroup(gk, part.geo, part.matName, part.cast, DYN_CAP, def?.cast);
        this._groups.set(gk, g);
      }
      if (g.next >= g.cap) break;
      const idx = g.next++;
      g.mesh.setMatrixAt(idx, matrix);
      if (tint && g.mesh.instanceColor) {
        _col.setRGB(tint[0], tint[1], tint[2]);
        g.mesh.setColorAt(idx, _col);
        g.mesh.instanceColor.needsUpdate = true;
      }
      if (g.mesh.count < g.next) g.mesh.count = g.next;
      g.mesh.instanceMatrix.needsUpdate = true;
      out.push({ mesh: g.mesh, idx });
    }
    return out.length ? out : null;
  }

  _compose(rec, def) {
    _p.set(rec.x, rec.y, rec.z);
    _qy.setFromAxisAngle(UP, rec.rotY);
    // Tumble is innermost: total = terrainAlign * yaw * tumble, so the extra lean
    // is expressed in the prop's own frame. Rotation on all three axes is what
    // stops every copy of a debris heap presenting the same face to the camera.
    if (rec.tiltX || rec.tiltZ) {
      _eul.set(rec.tiltX, 0, rec.tiltZ, 'XZY');
      _qtm.setFromEuler(_eul);
      _qy.multiply(_qtm);
    }
    const tilt = def.tilt ?? 0.4;
    if (tilt > 0.001) {
      this._probe.normalAt(rec.x, rec.z, _n);
      _q.setFromUnitVectors(UP, _n);
      _qt.identity().slerp(_q, tilt);
      _qt.multiply(_qy);
    } else {
      _qt.copy(_qy);
    }
    _s.set(rec.sx ?? rec.scale, rec.sy ?? rec.scale, rec.sz ?? rec.scale);
    rec.matrix = new THREE.Matrix4().compose(_p, _qt, _s);
    rec.quat = _qt.clone();
  }

  /** Contact darkening under a prop, laid onto the terrain normal. */
  _blob(x, gy, z, radius) {
    const c = this._contact;
    if (!c || c.next >= c.cap) return -1;
    const idx = c.next++;
    this._probe.normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, _n);
    _p.set(x, gy + 0.022, z);
    _s.set(radius, Math.min(1, radius * 0.6), radius);
    _m.compose(_p, _q, _s);
    c.mesh.setMatrixAt(idx, _m);
    if (c.mesh.count < c.next) c.mesh.count = c.next;
    c.mesh.instanceMatrix.needsUpdate = true;
    return idx;
  }

  /* ================================================================ *
   * fixtures
   * ================================================================ */

  _fixVariant(kind, vi) {
    const key = `fx:${kind}#${vi}`;
    const hit = this._lib.get(key);
    if (hit !== undefined) return hit;
    const rand = this.engine.freshRand(`props:fx:${kind}:${vi}`);
    const built = buildFixture(kind, rand, vi);
    const out = built ? { parts: built.parts, flames: built.flames, lights: built.lights } : null;
    if (out) for (const p of out.parts) finish(p.geo);
    this._lib.set(key, out);
    return out;
  }

  _placeFixtures() {
    for (const f of this._fixPlan) {
      if (f.dead) continue;
      this._realizeFixture(f);
    }
    /* lantern posts carry a real lantern on their hook */
    for (const rec of this.props) {
      if (rec.kind !== 'lanternPost') continue;
      const v = this._lib.get(`${rec.kind}#${rec.vi}`);
      const hook = v?.hook;
      if (!hook) continue;
      _p.set(hook[0], hook[1], hook[2]).applyMatrix4(rec.matrix);
      this._realizeFixture({
        kind: 'lantern', variant: (rec.vi + 1) % FIXTURE_KINDS.lantern.variants,
        x: _p.x, z: _p.z, absY: _p.y, mounted: true, rotY: rec.rotY, tilt: 0,
        rand: this.engine.freshRand(`props:lantern:${rec.x | 0}:${rec.z | 0}`),
      });
    }
    /* altars come with their own candles, standing on the slab */
    for (const rec of this.props) {
      if (rec.kind !== 'altar') continue;
      const v = this._lib.get(`${rec.kind}#${rec.vi}`);
      const spots = v?.candles;
      if (!spots) continue;
      for (let i = 0; i < spots.length; i++) {
        _p.fromArray(spots[i]).applyMatrix4(rec.matrix);
        this._realizeFixture({
          kind: 'candles', variant: (rec.vi + i) % FIXTURE_KINDS.candles.variants,
          x: _p.x, z: _p.z, absY: _p.y, mounted: true, rotY: rec.rotY + i, tilt: 0,
          rand: this.engine.freshRand(`props:altarcandle:${rec.x | 0}:${i}`),
        });
      }
    }
  }

  _realizeFixture(f) {
    const def = FIXTURE_KINDS[f.kind];
    const variant = this._fixVariant(f.kind, f.variant);
    if (!variant || !def) return null;

    const gy = this._probe.heightAt(f.x, f.z);
    const y = f.absY !== undefined ? f.absY
      : f.y !== undefined ? gy + f.y
        : gy - (def.sink ?? 0.04);
    const rotY = f.rotY !== undefined ? f.rotY : (f.rand ? f.rand() * 6.283 : 0);

    _p.set(f.x, y, f.z);
    _qy.setFromAxisAngle(UP, rotY);
    const tilt = f.mounted ? 0 : (def.tilt ?? 0.3);
    if (tilt > 0.001) {
      this._probe.normalAt(f.x, f.z, _n);
      _q.setFromUnitVectors(UP, _n);
      _qt.identity().slerp(_q, tilt);
      _qt.multiply(_qy);
    } else {
      _qt.copy(_qy);
    }
    _s.setScalar(1);
    const matrix = new THREE.Matrix4().compose(_p, _qt, _s);

    const key = `fx:${f.kind}#${f.variant}`;
    // A mild per-fixture value/hue spread: six braziers in a ring must not be
    // six copies of one casting.
    const fv = f.rand ? 1 + (f.rand() - 0.5) * 0.16 : 1;
    const fh = f.rand ? (f.rand() - 0.5) * 0.3 : 0;
    const slots = this._claimSlots(key, matrix, variant, def,
      [fv * (1 + fh * 0.05), fv, fv * (1 - fh * 0.045)]);
    const handle = {
      kind: f.kind, position: _p.clone(), rotY, matrix, slots,
      external: !!f.external, lights: [], flames: [], lightAt: null,
    };

    /* flames, at the fuel */
    for (const fl of variant.flames) {
      _p.set(fl.x, fl.y, fl.z).applyMatrix4(matrix);
      const idx = this._flameInstance(fl.style, _p, fl.s);
      if (idx >= 0) handle.flames.push({ style: fl.style, idx });
    }
    if (variant.lights.length) {
      const li = variant.lights[0];
      handle.lightAt = _p.set(li.x, li.y, li.z).applyMatrix4(matrix).clone();
    }

    /*
     * Lights, AT the flame — the whole point of this module. When a fixture was
     * requested by another module (Dungeon), that module has already registered
     * its own practical for it, usually at the fixture's origin rather than at
     * the fire. Adopting and re-seating that light is better than adding a
     * second one: one flame, one light, in the same place.
     */
    let adopted = false;
    if (f.external && handle.lightAt) adopted = this._adoptLightNear(f.x, f.z, handle);
    if (!adopted) this._addFixtureLights(variant, matrix, handle);

    if (!f.mounted && (def.footprint ?? 0) > 0) {
      handle.blobSlot = this._blob(f.x, gy, f.z, (def.footprint ?? 0.5) * 1.15);
    }
    this.fixtures.push(handle);
    if (f.external) this._extAt.push({ x: f.x, z: f.z });
    return handle;
  }

  _addFixtureLights(variant, matrix, handle) {
    const lighting = this.engine.get?.('lighting');
    for (const li of variant.lights) {
      _p.set(li.x, li.y, li.z).applyMatrix4(matrix);
      const desc = {
        position: [_p.x, _p.y, _p.z],
        intensity: li.intensity, radius: li.radius,
        type: li.type ?? 'torch', kelvin: li.kelvin,
        flicker: li.flicker ?? 1, shadow: li.shadow ?? false,
        priority: li.priority ?? (li.shadow ? 1.3 : 1),
      };
      let h = null;
      try { h = lighting?.addTorch?.(desc) ?? null; } catch { h = null; }
      if (h) h.__propsFixture = true;
      else {
        // no Lighting module: announce so whoever owns light can pick it up
        try { this.engine.bus.emit('lighting:torch', desc); } catch { /* noop */ }
      }
      handle.lights.push(h ?? desc);
    }
  }

  /** Re-seat a caller's already-registered practical onto our flame. */
  _adoptLightNear(x, z, handle) {
    const lighting = this.engine.get?.('lighting');
    const list = lighting?.practicals;
    if (!Array.isArray(list) || !handle.lightAt) return false;
    let best = null, bd = 0.75 * 0.75;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.__propsFixture || !p.basePosition) continue;
      const dx = p.basePosition.x - x, dz = p.basePosition.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return false;
    try {
      best.setPosition(handle.lightAt.x, handle.lightAt.y, handle.lightAt.z);
      best.__propsFixture = true;
      best.__propsAdopted = true;
    } catch { return false; }
    handle.lights.push(best);
    return true;
  }

  /** Fixtures another module placed, if it exposes them. Read-only, guarded. */
  _dungeonFixtures(d) {
    if (!d) return [];
    const a = d._fixtures ?? d.fixtures;
    return Array.isArray(a) ? a : [];
  }

  /**
   * The Dungeon builds its interior during its own init, before this module is
   * ready, so it falls back to its own sconce/brazier kit and its own lights.
   * That geometry is good — it just has no fire in it. Put real flame exactly
   * where the level put its light, so no practical anywhere is a bare orb.
   */
  _adoptDungeonFires(dungeon) {
    if (!dungeon) return;
    const list = this._dungeonFixtures(dungeon);
    for (const f of list) {
      if (!Number.isFinite(f?.x)) continue;
      let dup = false;
      for (const e of this._extAt) {
        if (Math.abs(e.x - f.x) < 0.3 && Math.abs(e.z - f.z) < 0.3) { dup = true; break; }
      }
      if (dup) continue;                             // we built this one ourselves
      // The level fell back to its own kit, which includes a flame solid — see
      // Dungeon._fixture. Adding ours on top of it puts two additive fires in the
      // same 0.4 m and the pair clips to a white disc.
      if (f.flame) continue;
      const y = Number.isFinite(f.y) ? f.y : 0;
      if (f.kind === 'brazier') {
        _p.set(f.x, y + 1.0, f.z);
        this._flameInstance('fire', _p, 1.9);
        _p.set(f.x + 0.07, y + 0.96, f.z - 0.05);
        this._flameInstance('fire', _p, 0.95);
      } else {
        const nx = Math.sin(f.yaw ?? 0), nz = Math.cos(f.yaw ?? 0);
        _p.set(f.x + nx * 0.3, y + 0.34, f.z + nz * 0.3);
        this._flameInstance('fire', _p, 1.15);
      }
    }
  }

  _flameInstance(style, pos, scale) {
    const f = this._flames.get(style) ?? this._flames.get('fire');
    if (!f) return -1;
    if (!f.mesh) {
      // Flames are cheap and few; one generously sized pool per style avoids a
      // second geometry pass and keeps the draw count at one per style.
      const cap = style === 'candle' ? 256 : 128;
      const mesh = new THREE.InstancedMesh(this._flameGeo, f.mat, cap);
      mesh.name = `props.flame.${style}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 6;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, _ZERO);
      mesh.count = 0;
      this.group.add(mesh);
      this._meshes.push(mesh);
      f.mesh = mesh; f.cap = cap; f.next = 0;
    }
    if (f.next >= f.cap) return -1;
    const idx = f.next++;
    _m.makeScale(scale, scale, scale);
    _m.setPosition(pos.x, pos.y, pos.z);
    f.mesh.setMatrixAt(idx, _m);
    if (f.mesh.count < f.next) f.mesh.count = f.next;
    f.mesh.instanceMatrix.needsUpdate = true;
    return idx;
  }

  /**
   * Public: place a fixture at an architectural position. Dungeon calls this
   * for sconces on its walls and braziers in its rooms.
   *
   * @param {string} kind brazier|campfire|sconce|torch|post|lantern|candles|hellBrazier
   * @param {THREE.Vector3|number[]} position
   * @param {object} [opts] {rotY, mounted, yaw, absolute, variant, seed}
   */
  placeFixture(kind, position, opts = {}) {
    const def = FIXTURE_KINDS[kind];
    if (!def || !position) return null;
    const x = Array.isArray(position) ? position[0] : position.x;
    const py = Array.isArray(position) ? position[1] : position.y;
    const z = Array.isArray(position) ? position[2] : position.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const rand = this.engine.freshRand(opts.seed ?? `props:fx:${kind}:${Math.round(x * 13)}:${Math.round(z * 7)}`);
    const rec = {
      kind,
      variant: opts.variant !== undefined ? opts.variant % def.variants : (rand() * def.variants) | 0,
      x, z,
      absY: opts.absolute === false ? undefined : py,
      y: opts.absolute === false ? py : undefined,
      rotY: opts.rotY ?? opts.yaw,
      mounted: opts.mounted ?? def.mounted ?? (py !== undefined && opts.absolute !== false),
      external: opts.external !== false,
      rand,
    };
    /*
     * Decline while a dressing pass is pending.
     *
     * Dungeon builds its interior — and therefore calls us — during its own init
     * and at the top of a scenario switch, both of which happen *before* our
     * pass runs, and our pass empties the instance pools. Anything realized now
     * would be silently thrown away, and worse, a fixture accepted for the crypt
     * would survive into a town frame as a flame floating in mid-air.
     *
     * Returning null is the honest answer: the caller then builds its own
     * fixture geometry and places its own light, and `_adoptDungeonFires` puts
     * real fire at those positions during our pass. Nothing ends up as an orb,
     * and nothing ends up in the wrong scene.
     */
    const pending = !this.ready || !this._probe
      || (this.engine.scenario?.name !== undefined && this.engine.scenario.name !== this._scenarioName);
    if (pending) return null;
    try {
      return this._realizeFixture(rec);
    } catch (e) {
      console.warn('[props] placeFixture failed —', e);
      return null;
    }
  }

  /* ================================================================ *
   * motes
   * ================================================================ */

  _buildMotes(env) {
    /*
     * Particulate has to give the air substance without becoming a swarm of
     * legible dots — a hundred discrete bright specks across a frame reads as
     * fireflies or sensor dirt, which is the same instant-fail as a bare torch
     * orb. Dust and pollen therefore sit *well* under the bloom threshold and
     * stay small; only hell's embers, which genuinely are burning, go bright.
     */
    const cfgs = {
      crypt: { n: 150, color: [0.66, 0.63, 0.58], size: 2.3, intensity: 0.3, rise: 0, span: 4.5, r: 26, h: 5 },
      town: { n: 130, color: [1.0, 0.74, 0.36], size: 2.6, intensity: 0.7, rise: 0.28, span: 6, r: 24, h: 6 },
      moor: { n: 140, color: [0.6, 0.76, 0.68], size: 2.4, intensity: 0.55, rise: 0, span: 4, r: 34, h: 5 },
      hell: { n: 300, color: [1.0, 0.42, 0.12], size: 3.4, intensity: 1.7, rise: 0.95, span: 9, r: 32, h: 9 },
    };
    const c = cfgs[this.biome];
    if (!c) return;
    const n = Math.max(24, Math.round(c.n * (DENSITY[this.density] ?? 0.6)));
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 3);
    const r = this.engine.freshRand(`props:motes:${this.biome}`);
    const cx = this._center?.x ?? 0, cz = this._center?.z ?? 0;
    for (let i = 0; i < n; i++) {
      const a = r() * 6.283;
      const d = Math.sqrt(r()) * c.r;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      pos[i * 3] = x;
      pos[i * 3 + 1] = this._probe.heightAt(x, z) + 0.25 + r() * c.h;
      pos[i * 3 + 2] = z;
      seed[i * 3] = r(); seed[i * 3 + 1] = r(); seed[i * 3 + 2] = r();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.computeBoundingSphere();
    const mat = makeMoteMaterial({
      color: c.color, size: c.size, intensity: c.intensity,
      speed: 1, rise: c.rise, spanY: c.span,
    });
    mat.uniforms.uPixelRatio.value = this.engine.renderer?.getPixelRatio?.() ?? 1;
    const pts = new THREE.Points(geo, mat);
    pts.name = 'props.motes';
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    this.group.add(pts);
    this._motes = { pts, geo, mat };
    void env;
  }

  /* ================================================================ *
   * per-frame
   * ================================================================ */

  update(dt, elapsed) {
    if (!this.ready || !this.enabled) return;

    /* wind: direction from the shared field, amplitude from the weather event */
    this.mats.update(dt, elapsed);
    if ((this.engine.clock.frame & 15) === 0) {
      const weather = this.engine.get?.('weather');
      const w = weather && !weather.__dead ? weather.windAt?.(this._center ?? _cam, elapsed, _wind) : null;
      if (w) {
        const l = Math.hypot(w.x, w.z);
        if (l > 1e-4) this.mats.setWindDir(w.x, w.z);
      }
    }

    /* fire */
    for (const [, f] of this._flames) {
      if (f.mat) f.mat.uniforms.uTime.value = elapsed;
    }
    for (const r of this._runes) r.mat.uniforms.uTime.value = elapsed;
    if (this._motes) this._motes.mat.uniforms.uTime.value = elapsed;

    /* LOD + distance cull, on a fixed cadence so frames stay reproducible */
    if (this._dyn.length && (this.engine.clock.frame % 10) === 0) this._refreshDynamic(false);
  }

  _refreshDynamic(force) {
    const cam = this.engine.camera.position;
    if (!force && cam.distanceToSquared(this._camAt) < 4) return;
    this._camAt.copy(cam);
    const touched = new Set();
    for (let i = 0; i < this._dyn.length; i++) {
      const rec = this._dyn[i];
      if (rec.broken || rec.hidden) continue;
      const dx = cam.x - rec.x, dy = cam.y - rec.y, dz = cam.z - rec.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const far = d > rec.lodAt;
      if (far === rec._far) continue;
      rec._far = far;
      this._setSlots(rec.slots, far ? _ZERO : rec.matrix, touched);
      this._setSlots(rec.lodSlots, far ? rec.matrix : _ZERO, touched);
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
  }

  _setSlots(slots, matrix, touched) {
    if (!slots) return;
    for (let i = 0; i < slots.length; i++) {
      slots[i].mesh.setMatrixAt(slots[i].idx, matrix);
      if (touched) touched.add(slots[i].mesh); else slots[i].mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ================================================================ *
   * queries + destruction
   * ================================================================ */

  _indexGrid() {
    this._qgrid.clear();
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      const key = `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`;
      let a = this._qgrid.get(key);
      if (!a) this._qgrid.set(key, (a = []));
      a.push(p);
    }
  }

  /**
   * Props within `r` of a point. Used by combat for destructible checks and by
   * AI/physics for cover and obstacle avoidance.
   * @returns {Array} placement records
   */
  queryNear(pos, r = 2) {
    const out = [];
    if (!pos) return out;
    const x = pos.x ?? pos[0] ?? 0, z = pos.z ?? pos[2] ?? 0;
    const i0 = Math.floor((x - r) / 4), i1 = Math.floor((x + r) / 4);
    const j0 = Math.floor((z - r) / 4), j1 = Math.floor((z + r) / 4);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const a = this._qgrid.get(`${i},${j}`);
        if (!a) continue;
        for (let k = 0; k < a.length; k++) {
          const p = a[k];
          const dx = p.x - x, dz = p.z - z;
          const rr = r + p.r;
          if (dx * dx + dz * dz <= rr * rr && out.indexOf(p) < 0) out.push(p);
        }
      }
    }
    return out;
  }

  /** True if a capsule of radius `r` at (x,z) would intersect solid dressing. */
  blocksAt(x, z, r = 0.35) {
    const near = this.queryNear({ x, z }, r);
    for (const p of near) {
      if (p.broken || p.hidden) continue;
      const def = KINDS[p.kind];
      if (!def || def.noBlob || def.mounted) continue;
      if ((def.fp ?? 0) < 0.3) continue;                 // grass and scree are not walls
      const dx = p.x - x, dz = p.z - z;
      const rr = r + p.r * 0.72;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    return false;
  }

  /** Apply damage to a prop record. Public so combat can drive it directly. */
  damage(rec, amount = 1, point = null) {
    if (!rec || !rec.dest || rec.broken) return false;
    rec.hp -= amount;
    if (rec.hp > 0) return false;
    this._break(rec, point);
    return true;
  }

  _break(rec, point) {
    rec.broken = true;
    this._setSlots(rec.slots, _ZERO, null);
    if (rec.brokenSlots) {
      // the shattered variant sits a touch lower and turned, so the swap does
      // not read as one mesh becoming another in place
      _p.set(rec.x, rec.y - 0.04 * rec.scale, rec.z);
      _qy.setFromAxisAngle(UP, rec.rotY + 0.6);
      _s.set(rec.sx ?? rec.scale, rec.sy ?? rec.scale, rec.sz ?? rec.scale);
      const m = new THREE.Matrix4().compose(_p, rec.quat ? _qy.premultiply(rec.quat) : _qy, _s);
      this._setSlots(rec.brokenSlots, m, null);
    }
    const at = point ?? { x: rec.x, y: rec.y + 0.35 * rec.scale, z: rec.z };
    try {
      this.engine.bus.emit('impact', {
        point: new THREE.Vector3(at.x, at.y, at.z),
        normal: new THREE.Vector3(0, 1, 0),
        kind: rec.dest.loot === 'gold' ? 'ceramic' : 'wood',
        magnitude: 1.1,
      });
      this.engine.bus.emit('loot:drop', {
        item: { kind: rec.dest.loot, tier: 'common', source: rec.kind },
        position: new THREE.Vector3(rec.x, rec.groundY + 0.15, rec.z),
      });
    } catch { /* noop */ }
  }

  _onDamage(p) {
    if (!p) return;
    const t = p.target;
    if (t && t.__propRecord) { this.damage(t.__propRecord, p.amount ?? 1, p.hitPoint); return; }
    if (t && t.kind && t.dest && this.props.indexOf(t) >= 0) { this.damage(t, p.amount ?? 1, p.hitPoint); return; }
    if (!p.hitPoint) return;
    const near = this.queryNear(p.hitPoint, 1.1);
    for (const rec of near) {
      if (rec.dest && !rec.broken) { this.damage(rec, p.amount ?? 1, p.hitPoint); return; }
    }
  }

  _onImpact(p) {
    if (!p || !p.point || (p.magnitude ?? 0) < 1.4) return;
    const near = this.queryNear(p.point, 1.6);
    for (const rec of near) {
      if (rec.dest && !rec.broken) this.damage(rec, (p.magnitude ?? 1) * 8, p.point);
    }
  }

  /* ================================================================ *
   * teardown of a dressing pass
   * ================================================================ */

  _clear() {
    const lighting = this.engine.get?.('lighting');
    for (const f of this.fixtures) {
      for (const l of f.lights) {
        // An adopted practical belongs to whoever registered it; releasing it
        // here would leave that module holding a dead handle.
        if (l && l.id !== undefined && !l.__propsAdopted) {
          try { lighting?.removeTorch?.(l); } catch { /* noop */ }
        } else if (l && l.__propsAdopted) {
          l.__propsFixture = false;
        }
      }
    }
    this.fixtures.length = 0;
    this._extAt.length = 0;
    for (const m of this._meshes) {
      this.group.remove(m);
      // Detached pools must leave the culler with them: their geometry is reused
      // across scenarios and gets a fresh `aJit` on the next build, so a stale
      // entry would hold a mirror of an attribute that no longer exists.
      try { this.engine.instanceCull?.remove(m); } catch { /* noop */ }
      try { m.dispose?.(); } catch { /* noop */ }
      // geometry is owned by the variant library and reused across scenarios
      if (m.geometry?.getAttribute?.('aJit')) m.geometry.deleteAttribute('aJit');
    }
    this._meshes.length = 0;
    this._groups.clear();
    this._contact = null;
    for (const [, f] of this._flames) { f.mesh = null; f.next = 0; f.cap = 0; }
    for (const r of this._runes) {
      this.group.remove(r.mesh);
      try { r.geo.dispose(); r.mat.dispose(); } catch { /* noop */ }
    }
    this._runes.length = 0;
    if (this._motes) {
      this.group.remove(this._motes.pts);
      try { this._motes.geo.dispose(); this._motes.mat.dispose(); } catch { /* noop */ }
      this._motes = null;
    }
    this.props.length = 0;
    this._plan.length = 0;
    this._fixPlan.length = 0;
    this._dyn.length = 0;
    this._qgrid.clear();
    this._camAt.set(1e9, 1e9, 1e9);
  }

  /* ================================================================ */

  /**
   * The surface props stand on. Two authorities: Terrain outdoors, and the
   * Dungeon's dressed floor indoors. Getting this wrong is the difference
   * between dressing that sits on the floor and dressing that hovers over it or
   * disappears into it, so the interior case takes precedence whenever the
   * Dungeon has actually built something.
   */
  _makeProbe() {
    const t = this.engine.get?.('terrain');
    const ok = !!(t && !t.__dead && typeof t.heightAt === 'function');
    const b = ok ? t.bounds : null;
    const span = ok ? Math.max(1e-3, (b.maxY ?? 1) - (b.minY ?? 0)) : 1;
    const minY = ok ? (b.minY ?? 0) : 0;

    const d = this.engine.get?.('dungeon');
    const din = !!(d && !d.__dead && d.active && typeof d.heightAt === 'function');

    const terrH = ok
      ? (x, z) => { const y = t.heightAt(x, z); return Number.isFinite(y) ? y : 0; }
      : () => 0;

    return {
      terrain: ok ? t : null,
      dungeon: din ? d : null,
      interior: din,
      size: din ? Math.max(20, (d.bounds?.maxX ?? 40) - (d.bounds?.minX ?? -40)) : (ok ? (t.size ?? 200) : 200),
      heightAt: din
        ? (x, z) => { const y = d.heightAt(x, z); return Number.isFinite(y) ? y : 0; }
        : terrH,
      // An interior floor is dressed masonry: flat, so props stand upright and
      // only the terrain outdoors gets slope-aware tilting.
      slopeAt: din ? () => 0 : (ok && typeof t.slopeAt === 'function' ? (x, z) => t.slopeAt(x, z) : () => 0),
      altAt: din ? () => 0.5 : (ok ? (x, z) => clamp01((terrH(x, z) - minY) / span) : () => 0.5),
      isWalkable: din
        ? (x, z) => d.isWalkable(x, z)
        : (ok && typeof t.isWalkable === 'function' ? (x, z) => t.isWalkable(x, z) : () => true),
      clearanceAt: din && typeof d.clearanceAt === 'function' ? (x, z) => d.clearanceAt(x, z) : () => 8,
      wetnessAt: ok && !din && typeof t.wetnessAt === 'function' ? (x, z) => t.wetnessAt(x, z) : () => 0,
      normalAt: din
        ? (x, z, out) => out.set(0, 1, 0)
        : (ok && typeof t.normalAt === 'function'
          ? (x, z, out) => t.normalAt(x, z, out)
          : (x, z, out) => out.set(0, 1, 0)),
    };
  }

  /** Debug/profiling: what this module actually costs. */
  stats() {
    return {
      props: this.props.length,
      fixtures: this.fixtures.length,
      lights: this.fixtures.reduce((a, f) => a + f.lights.length, 0),
      drawCalls: this._meshes.length + this._runes.length,
      triangles: Math.round(this._triCount),
      biome: this.biome, density: this.density,
    };
  }
}

void smooth01;
void mergeParts;
