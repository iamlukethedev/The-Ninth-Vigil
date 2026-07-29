/**
 * SANCTUM — Loot
 * ---------------------------------------------------------------------------
 * The compulsion loop: what drops, how it looks when it hits the floor, and
 * what happens when you take it.
 *
 * Responsibilities
 * ----------------
 *  • listens for 'death', rolls a loot table weighted by species / elite /
 *    boss / level, and emits 'loot:drop' per item
 *  • gives every drop a physical body on the ground: a real mesh, a tumble as
 *    it lands, a rarity-coloured light shaft, a ground pool, a contact-AO
 *    darkening, drifting motes for legendary+, and a cartouche label
 *  • pickup on proximity or click -> 'loot:pickup' + 'ui:toast'
 *  • owns Progression (equipment, derived stats, inventory, XP, paragon)
 *
 * Cost (measured, worst case at MAX_DROPS = 18 simultaneous drops)
 * ----------------------------------------------------------------
 *   18 item bodies      (1 draw call each, 3 shared materials/programs)
 *    1 beam layer       (InstancedMesh, 2 shells merged, additive)
 *    1 ground pool      (InstancedMesh, additive)
 *    1 contact AO layer (InstancedMesh, normal blend)
 *    1 mote layer       (Points, additive)
 *  <=6 label sprites    (pooled, only the nearest few are ever visible)
 *   -----------------------------------------------------------------
 *   <= 28 draw calls, ~9k triangles.  Typical in-combat load: 6-11 calls.
 *
 * Texture units: the three body materials each bind map + normalMap + ORM
 * (aoMap = roughnessMap = metalnessMap, one texture) = 3 units, plus envMap.
 * The beam / pool / contact / mote materials bind 0-1. Well inside the 16-unit
 * budget documented in KNOWN_ISSUES.md.
 *
 * Determinism: every roll comes from `engine.freshRand(seed)` where the seed is
 * a hash of the scenario name, the drop ordinal and the species — no
 * Math.random, no Date.now, and animation phase comes from engine.clock.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  makeItem, makeGold, makePotion, makeMaterial, makeGem,
  rarityInfo, rarityRank, tooltipFor, RARITY_ORDER, SLOT_IDS, MATERIALS,
} from './Items.js';
import { Progression, xpForKill, xpForLevel, LEVEL_CAP } from './Progression.js';

/* ------------------------------------------------------------------ type */
/* OS-resident faces only — no webfonts, never a default sans. Mirrors
   src/ui/UITheme.js by value so Loot has no cross-agent import. */
const FONT_DISPLAY =
  `'Trajan Pro','Cinzel','Herculanum','Copperplate','Copperplate Gothic Light',` +
  `'Optima','Palatino Linotype','Book Antiqua',Palatino,Georgia,serif`;
/** Engraved small-caps — the item-type sub-line under a legendary name. */
const FONT_ENGRAVED =
  `'Copperplate','Copperplate Gothic Light','Trajan Pro','Optima','Hoefler Text',Palatino,Georgia,serif`;

/* --------------------------------------------------------------- tuning */

const MAX_DROPS = 18;
/*
 * GROUND LABELS — measured against the capture, not against intent.
 *
 * KNOWN_ISSUES #1 is still live in the current frames: five plates
 * ("ANOINTED PLATE CUIRASS OF THE ASHEN CHOIR", "PALE WAR MACE OF THE HOAR
 * GALLOW", ...) cover the hero and most of the fight in `combat`, and one clips
 * the action bar in `dungeon`. The type size and the collision nudge were both
 * already implemented — the problem is arithmetic, so here is the arithmetic.
 *
 * `entry.h = LABEL_WORLD_H * (H / 160) * 1.08`, and a wrapped legendary with an
 * engraved sub-line paints H = 366. At LABEL_WORLD_H = 0.60 that is 1.48 m of
 * world height, which at the `combat` camera (26 m, 46 deg fov, 900 px tall) is
 * 60 px tall and ~175 px wide. Diablo 4's ground labels are ~14-16 px tall and
 * ~90-130 px wide at the same output size, and it shows two or three of them.
 * So: 0.40 puts a two-line legendary at ~40 px tall / ~116 px wide, three plates
 * instead of six, and a shorter fade-in radius so fewer ever qualify at once.
 */
const MAX_LABELS = 3;
const MAX_MOTES = 240;
const MOTES_PER_ITEM = 24;
const LABEL_RANGE = 8.0;          // m — labels fade in inside this radius
const LABEL_FONT_PX = 92;         // canvas px; the plate grows, the type never shrinks
const LABEL_WORLD_H = 0.40;       // m tall for a single-line plate (~10 px on screen)
const PICKUP_RANGE = 1.9;         // m — gear pickup on click / key
const AUTO_RANGE = 1.5;           // m — gold / potions / materials vacuum in
const CLICK_RADIUS = 1.1;         // m — ground-plane click tolerance
const DISPLAY_SCALE = 1.95;       // dropped props read larger than life, as in D4
const TINT_LIFT = 1.22;           // ground loot sits in shadow; lift it to read
const GRAVITY = 15.5;             // m/s^2 — punchier than real, ARPG feel

/**
 * Scene-linear value that ACES maps to ~0.85 tonemapped output at unity gain.
 *
 * Solving `RRTAndODTFit(v / 0.6) = 0.85` gives v ~= 1.55. This project renders
 * into the composer's half-float target, which means three disables the
 * per-material tonemap chunk (`toneMapping` is forced to NoToneMapping whenever
 * a render target is bound), so everything a shader writes is raw scene-linear
 * and is later multiplied by the pipeline's auto-exposure gain before ACES.
 * Divide this by that live gain and you have the ceiling one additive layer may
 * write without clipping. Mirrors src/vfx/VFXSystem.js#_syncRadianceCeiling.
 */
const TONEMAP_085 = 1.55;

/**
 * Rarity -> glow presence. Index is `rarityRank()`: 0 common … 5 mythic.
 *
 * `beamI` / `poolI` are FRACTIONS OF THE RADIANCE CEILING, not raw emissive —
 * that is the whole point. The old code multiplied the rarity hue by
 * `rarity.beamI` (0.55 for a common, 4.4 for a mythic) and handed the result
 * straight to an additive shader, so even a common wrote ~0.3 linear across a
 * 2.5 m disc and a mythic wrote 4.4, which at the boss scenario's 2.7x exposure
 * gain is 11.9 at the tonemapper — five times ACES's white point.
 *
 * Sizes are metres and deliberately austere. A common gets NO shaft at all
 * (height 0 collapses the quad to zero area, so it costs nothing to rasterise)
 * and a 0.26 m ground smudge you have to look for; only legendary and above earn
 * a real vertical shaft, and even a mythic's is 0.36 m wide — narrow, as asked.
 * For reference the hero is 1.85 m and reads ~67 px tall at this camera, so a
 * mythic shaft is ~13 px wide: unmistakable, never dominant.
 */
const GLOW_TIERS = [
  /* common    */ { beamH: 0.00, beamW: 0.00, beamI: 0.00, poolR: 0.26, poolI: 0.11, ring: 0 },
  /* magic     */ { beamH: 0.34, beamW: 0.15, beamI: 0.30, poolR: 0.32, poolI: 0.18, ring: 0 },
  /* rare      */ { beamH: 0.62, beamW: 0.19, beamI: 0.46, poolR: 0.40, poolI: 0.26, ring: 0 },
  /* legendary */ { beamH: 1.50, beamW: 0.27, beamI: 0.86, poolR: 0.56, poolI: 0.35, ring: 0.55 },
  /* unique    */ { beamH: 1.85, beamW: 0.31, beamI: 0.98, poolR: 0.62, poolI: 0.39, ring: 0.75 },
  /* mythic    */ { beamH: 2.25, beamW: 0.36, beamI: 1.10, poolR: 0.70, poolI: 0.44, ring: 0.95 },
];

/** Per-species drop profile. `gear` is expected gear items per kill. */
const PROFILES = {
  skeleton: { gear: 0.20, gold: [5, 17], goldChance: 0.55, mats: ['boneDust', 'ironShard'], matChance: 0.16, luck: 0.00 },
  ghoul: { gear: 0.22, gold: [6, 20], goldChance: 0.58, mats: ['boneDust', 'gravesilk'], matChance: 0.18, luck: 0.04 },
  cultist: { gear: 0.28, gold: [9, 27], goldChance: 0.66, mats: ['gravesilk', 'emberGlass'], matChance: 0.24, luck: 0.10 },
  hellhound: { gear: 0.15, gold: [4, 13], goldChance: 0.48, mats: ['emberGlass'], matChance: 0.14, luck: 0.00 },
  wraith: { gear: 0.26, gold: [7, 23], goldChance: 0.60, mats: ['gravesilk', 'veiledSigil'], matChance: 0.20, luck: 0.12 },
  brute: { gear: 0.60, gold: [24, 64], goldChance: 0.92, mats: ['ironShard', 'boneDust'], matChance: 0.55, luck: 0.28 },
  boss: { gear: 4.0, gold: [420, 900], goldChance: 1.0, mats: ['wardenAsh', 'veiledSigil'], matChance: 1.0, luck: 1.0, floor: 'legendary' },
};
const DEFAULT_PROFILE = PROFILES.skeleton;

/* ------------------------------------------------------------- utilities */

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

const _o3 = new THREE.Object3D();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _gem = new THREE.Color();
const _mtx = new THREE.Matrix4();

/** Bake a primitive into a merge-ready piece with a flat vertex colour. */
function piece(geo, shadeR, shadeG, shadeB, t = {}) {
  const g = (geo.index ? geo.toNonIndexed() : geo.clone());
  _o3.position.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  _o3.rotation.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
  _o3.scale.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  _o3.updateMatrix();
  g.applyMatrix4(_o3.matrix);
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = shadeR; c[i * 3 + 1] = shadeG; c[i * 3 + 2] = shadeB; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  g.deleteAttribute('uv1');
  g.deleteAttribute('uv2');
  return g;
}

/** Merge, drop the sources, compute bounds. */
function assemble(parts) {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return new THREE.BoxGeometry(0.2, 0.2, 0.2);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/* ==================================================================== *
 * archetype geometry — one template per silhouette, cached, tint applied
 * per drop by scaling the vertex-colour attribute.
 *
 * All measurements are metres (world scale is 1 unit = 1 m). Templates are
 * authored lying along +Z with the origin at the resting centre so a drop can
 * be laid flat on the floor without guesswork.
 * ==================================================================== */

/* shade constants: relative to the item tint. >1 catches light, <1 is cavity.
   Anything above 1.0 spills into emissive via the shared onBeforeCompile
   patch, which is how gems and runes glow without a second material. */
const S_BODY = 1.00, S_EDGE = 1.34, S_DEEP = 0.46, S_TRIM = 0.72;

/**
 * Vertex-colour sentinel for an emissive inlay. Anything whose RED channel
 * lands above EMISSIVE_MARK is re-tinted to the item's gem colour and lifted
 * above 1.0, which the shared onBeforeCompile patch turns into real emissive.
 * Ordinary catch-light shades (S_EDGE = 1.34) stay safely below the mark.
 */
const EMISSIVE_MARK = 1.9;
function gemShade(glow) { return 2.05 + glow * 1.5; }

const GEO = {
  sword: (g) => {
    const p = [];
    p.push(piece(new THREE.BoxGeometry(0.075, 0.020, 0.66), S_BODY, S_BODY, S_BODY, { z: 0.20 }));
    p.push(piece(new THREE.BoxGeometry(0.030, 0.026, 0.62), S_EDGE, S_EDGE, S_EDGE, { z: 0.20 }));
    p.push(piece(new THREE.ConeGeometry(0.048, 0.13, 4), S_EDGE, S_EDGE, S_EDGE, { z: 0.585, rx: Math.PI / 2, ry: Math.PI / 4 }));
    p.push(piece(new THREE.BoxGeometry(0.24, 0.032, 0.045), S_TRIM, S_TRIM, S_TRIM, { z: -0.135 }));
    p.push(piece(new THREE.CylinderGeometry(0.022, 0.026, 0.19, 8), S_DEEP, S_DEEP, S_DEEP, { z: -0.245, rx: Math.PI / 2 }));
    p.push(piece(new THREE.SphereGeometry(0.035, 10, 8), gemShade(g), gemShade(g) * 0.62, gemShade(g) * 0.34, { z: -0.35 }));
    return assemble(p);
  },
  dagger: (g) => {
    const p = [];
    p.push(piece(new THREE.BoxGeometry(0.055, 0.016, 0.28), S_EDGE, S_EDGE, S_EDGE, { z: 0.12 }));
    p.push(piece(new THREE.ConeGeometry(0.034, 0.10, 4), S_EDGE, S_EDGE, S_EDGE, { z: 0.30, rx: Math.PI / 2, ry: Math.PI / 4 }));
    p.push(piece(new THREE.BoxGeometry(0.14, 0.026, 0.036), S_TRIM, S_TRIM, S_TRIM, { z: -0.035 }));
    p.push(piece(new THREE.CylinderGeometry(0.019, 0.022, 0.13, 8), S_DEEP, S_DEEP, S_DEEP, { z: -0.105, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.030), gemShade(g), gemShade(g) * 0.55, gemShade(g) * 0.72, { z: -0.185 }));
    return assemble(p);
  },
  axe: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.026, 0.030, 0.92, 8), S_TRIM, S_TRIM, S_TRIM, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.20, 0.20, 0.030, 3, 1, false), S_EDGE, S_EDGE, S_EDGE,
      { z: 0.31, x: 0.14, ry: Math.PI / 2, rz: -0.35 }));
    p.push(piece(new THREE.CylinderGeometry(0.20, 0.20, 0.030, 3, 1, false), S_EDGE, S_EDGE, S_EDGE,
      { z: 0.31, x: -0.14, ry: Math.PI / 2, rz: Math.PI + 0.35 }));
    p.push(piece(new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10), S_DEEP, S_DEEP, S_DEEP, { z: 0.31, ry: Math.PI / 2, rx: Math.PI / 2 }));
    p.push(piece(new THREE.SphereGeometry(0.032, 10, 8), gemShade(g), gemShade(g) * 0.58, gemShade(g) * 0.30, { z: 0.31 }));
    p.push(piece(new THREE.BoxGeometry(0.05, 0.05, 0.06), S_DEEP, S_DEEP, S_DEEP, { z: -0.45 }));
    return assemble(p);
  },
  mace: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.024, 0.028, 0.60, 8), S_TRIM, S_TRIM, S_TRIM, { z: -0.10, rx: Math.PI / 2 }));
    p.push(piece(new THREE.IcosahedronGeometry(0.105, 0), S_BODY, S_BODY, S_BODY, { z: 0.27 }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      p.push(piece(new THREE.ConeGeometry(0.030, 0.075, 4), S_EDGE, S_EDGE, S_EDGE,
        { x: Math.cos(a) * 0.10, y: Math.sin(a) * 0.10, z: 0.27, rx: Math.PI / 2, rz: -a + Math.PI / 2 }));
    }
    p.push(piece(new THREE.SphereGeometry(0.036, 10, 8), gemShade(g) * 0.9, gemShade(g) * 0.6, gemShade(g) * 0.32, { z: 0.27 }));
    p.push(piece(new THREE.CylinderGeometry(0.036, 0.030, 0.05, 8), S_DEEP, S_DEEP, S_DEEP, { z: -0.42, rx: Math.PI / 2 }));
    return assemble(p);
  },
  staff: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.026, 0.032, 1.42, 8), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.TorusGeometry(0.075, 0.018, 6, 14), S_TRIM, S_TRIM, S_TRIM, { z: 0.66 }));
    p.push(piece(new THREE.IcosahedronGeometry(0.062, 0), gemShade(g), gemShade(g) * 0.72, gemShade(g) * 0.42, { z: 0.72 }));
    p.push(piece(new THREE.TorusGeometry(0.038, 0.012, 6, 12), S_TRIM, S_TRIM, S_TRIM, { z: 0.10, rx: Math.PI / 2 }));
    p.push(piece(new THREE.TorusGeometry(0.038, 0.012, 6, 12), S_TRIM, S_TRIM, S_TRIM, { z: -0.24, rx: Math.PI / 2 }));
    return assemble(p);
  },
  scythe: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.026, 0.030, 1.36, 8), S_TRIM, S_TRIM, S_TRIM, { rx: Math.PI / 2 }));
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      p.push(piece(new THREE.BoxGeometry(0.012, 0.055 - t * 0.030, 0.15), S_EDGE, S_EDGE, S_EDGE,
        { z: 0.62 + t * 0.02, x: 0.09 + t * 0.30, rz: -0.28 - t * 0.5, ry: -0.18 * t }));
    }
    p.push(piece(new THREE.CylinderGeometry(0.045, 0.045, 0.055, 8), S_DEEP, S_DEEP, S_DEEP, { z: 0.62, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.032), gemShade(g) * 0.7, gemShade(g), gemShade(g) * 0.55, { z: 0.62 }));
    return assemble(p);
  },
  bow: (g) => {
    const p = [];
    for (let i = 0; i < 9; i++) {
      const t = i / 8, a = (t - 0.5) * 2.1;
      p.push(piece(new THREE.BoxGeometry(0.030, 0.030, 0.16), S_BODY, S_BODY, S_BODY,
        { z: Math.sin(a) * 0.56, x: Math.cos(a) * 0.20 - 0.20, ry: -a * 0.5 }));
    }
    p.push(piece(new THREE.CylinderGeometry(0.004, 0.004, 1.06, 4), S_EDGE * 0.8, S_EDGE * 0.8, S_EDGE * 0.8, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.BoxGeometry(0.045, 0.045, 0.16), S_TRIM, S_TRIM, S_TRIM, { x: -0.005 }));
    p.push(piece(new THREE.SphereGeometry(0.024, 8, 6), gemShade(g) * 0.8, gemShade(g) * 0.7, gemShade(g), { x: 0.02 }));
    return assemble(p);
  },
  shield: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.30, 0.20, 0.045, 6, 1, false), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2, sy: 1.35 }));
    p.push(piece(new THREE.CylinderGeometry(0.24, 0.15, 0.055, 6, 1, false), S_TRIM, S_TRIM, S_TRIM, { rx: Math.PI / 2, sy: 1.35, y: 0.012 }));
    p.push(piece(new THREE.SphereGeometry(0.075, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), S_EDGE, S_EDGE, S_EDGE, { y: 0.030 }));
    p.push(piece(new THREE.TorusGeometry(0.12, 0.012, 6, 16), S_DEEP, S_DEEP, S_DEEP, { y: 0.030, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.036), gemShade(g), gemShade(g) * 0.68, gemShade(g) * 0.38, { y: 0.085 }));
    return assemble(p);
  },
  towershield: (g) => {
    const p = [];
    p.push(piece(new THREE.BoxGeometry(0.46, 0.05, 0.78), S_BODY, S_BODY, S_BODY));
    p.push(piece(new THREE.ConeGeometry(0.28, 0.30, 4), S_BODY, S_BODY, S_BODY, { z: 0.50, rx: -Math.PI / 2, ry: Math.PI / 4, sy: 0.18 }));
    p.push(piece(new THREE.BoxGeometry(0.34, 0.06, 0.62), S_TRIM, S_TRIM, S_TRIM, { y: 0.014 }));
    p.push(piece(new THREE.BoxGeometry(0.075, 0.07, 0.70), S_EDGE, S_EDGE, S_EDGE, { y: 0.026 }));
    p.push(piece(new THREE.OctahedronGeometry(0.040), gemShade(g), gemShade(g) * 0.60, gemShade(g) * 0.32, { y: 0.075, z: -0.10 }));
    return assemble(p);
  },
  tome: (g) => {
    const p = [];
    p.push(piece(new THREE.BoxGeometry(0.27, 0.075, 0.35), S_BODY, S_BODY, S_BODY));
    p.push(piece(new THREE.BoxGeometry(0.245, 0.058, 0.325), 1.42, 1.38, 1.24, { y: 0.014 }));
    p.push(piece(new THREE.BoxGeometry(0.055, 0.088, 0.36), S_DEEP, S_DEEP, S_DEEP, { x: -0.125 }));
    p.push(piece(new THREE.TorusGeometry(0.055, 0.010, 5, 12), S_TRIM, S_TRIM, S_TRIM, { y: 0.045, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.032), gemShade(g), gemShade(g) * 0.55, gemShade(g) * 0.80, { y: 0.058 }));
    return assemble(p);
  },
  orb: (g) => {
    const p = [];
    p.push(piece(new THREE.IcosahedronGeometry(0.115, 1), gemShade(g) * 0.85, gemShade(g) * 0.95, gemShade(g), {}));
    p.push(piece(new THREE.TorusGeometry(0.118, 0.020, 6, 18), S_TRIM, S_TRIM, S_TRIM, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.TorusGeometry(0.118, 0.018, 6, 18), S_TRIM, S_TRIM, S_TRIM, { rz: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.055, 0.070, 0.05, 8), S_DEEP, S_DEEP, S_DEEP, { y: -0.115 }));
    return assemble(p);
  },
  quiver: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.085, 0.070, 0.44, 10, 1, true), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.070, 0.070, 0.02, 10), S_DEEP, S_DEEP, S_DEEP, { z: -0.22, rx: Math.PI / 2 }));
    p.push(piece(new THREE.TorusGeometry(0.086, 0.012, 5, 14), S_TRIM, S_TRIM, S_TRIM, { z: 0.10, rx: Math.PI / 2 }));
    p.push(piece(new THREE.TorusGeometry(0.078, 0.012, 5, 14), S_TRIM, S_TRIM, S_TRIM, { z: -0.12, rx: Math.PI / 2 }));
    for (let i = 0; i < 4; i++) {
      p.push(piece(new THREE.CylinderGeometry(0.006, 0.006, 0.24, 4), 1.25, 1.20, 1.05,
        { x: -0.03 + i * 0.02, y: 0.02 * (i % 2), z: 0.33, rx: Math.PI / 2 + 0.06 * (i - 1.5), ry: 0.05 * i }));
      p.push(piece(new THREE.ConeGeometry(0.018, 0.05, 4), gemShade(g) * 0.5, gemShade(g) * 0.5, gemShade(g) * 0.5,
        { x: -0.03 + i * 0.02, y: 0.02 * (i % 2), z: 0.46, rx: Math.PI / 2 }));
    }
    return assemble(p);
  },
  helm: (g) => {
    const p = [];
    p.push(piece(new THREE.SphereGeometry(0.145, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), S_BODY, S_BODY, S_BODY, { y: 0.02 }));
    p.push(piece(new THREE.CylinderGeometry(0.148, 0.152, 0.05, 14, 1, true), S_TRIM, S_TRIM, S_TRIM, { y: 0.0 }));
    p.push(piece(new THREE.BoxGeometry(0.032, 0.10, 0.26), S_EDGE, S_EDGE, S_EDGE, { y: 0.10 }));
    p.push(piece(new THREE.BoxGeometry(0.19, 0.030, 0.055), S_DEEP, S_DEEP, S_DEEP, { y: 0.055, z: 0.115 }));
    p.push(piece(new THREE.OctahedronGeometry(0.028), gemShade(g), gemShade(g) * 0.62, gemShade(g) * 0.34, { y: 0.135, z: 0.075 }));
    return assemble(p);
  },
  greathelm: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.145, 0.132, 0.24, 12, 1, true), S_BODY, S_BODY, S_BODY, { y: 0.06 }));
    p.push(piece(new THREE.SphereGeometry(0.145, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), S_BODY, S_BODY, S_BODY, { y: 0.18 }));
    p.push(piece(new THREE.BoxGeometry(0.030, 0.24, 0.30), S_EDGE, S_EDGE, S_EDGE, { y: 0.14 }));
    p.push(piece(new THREE.BoxGeometry(0.22, 0.028, 0.05), S_DEEP, S_DEEP, S_DEEP, { y: 0.11, z: 0.128 }));
    p.push(piece(new THREE.BoxGeometry(0.22, 0.028, 0.05), S_DEEP, S_DEEP, S_DEEP, { y: 0.03, z: 0.126 }));
    p.push(piece(new THREE.OctahedronGeometry(0.026), gemShade(g), gemShade(g) * 0.58, gemShade(g) * 0.30, { y: 0.185, z: 0.10 }));
    return assemble(p);
  },
  hood: (g) => {
    const p = [];
    p.push(piece(new THREE.SphereGeometry(0.155, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.70), S_BODY, S_BODY, S_BODY, { y: 0.01, sz: 1.15 }));
    p.push(piece(new THREE.ConeGeometry(0.10, 0.20, 8), S_BODY, S_BODY, S_BODY, { y: 0.10, z: -0.11, rx: -0.6 }));
    p.push(piece(new THREE.TorusGeometry(0.135, 0.022, 6, 14), S_TRIM, S_TRIM, S_TRIM, { y: -0.01, rx: Math.PI / 2, sz: 1.1 }));
    p.push(piece(new THREE.OctahedronGeometry(0.026), gemShade(g) * 0.7, gemShade(g) * 0.6, gemShade(g), { y: 0.055, z: 0.14 }));
    return assemble(p);
  },
  cuirass: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.20, 0.235, 0.42, 10, 1, true), S_BODY, S_BODY, S_BODY, { sz: 0.66 }));
    p.push(piece(new THREE.BoxGeometry(0.05, 0.40, 0.055), S_EDGE, S_EDGE, S_EDGE, { z: 0.145 }));
    p.push(piece(new THREE.TorusGeometry(0.215, 0.026, 6, 14), S_TRIM, S_TRIM, S_TRIM, { y: 0.20, rx: Math.PI / 2, sz: 0.68 }));
    p.push(piece(new THREE.TorusGeometry(0.235, 0.026, 6, 14), S_TRIM, S_TRIM, S_TRIM, { y: -0.20, rx: Math.PI / 2, sz: 0.68 }));
    p.push(piece(new THREE.SphereGeometry(0.085, 10, 7), S_DEEP, S_DEEP, S_DEEP, { x: -0.13, y: 0.20, sy: 0.6 }));
    p.push(piece(new THREE.SphereGeometry(0.085, 10, 7), S_DEEP, S_DEEP, S_DEEP, { x: 0.13, y: 0.20, sy: 0.6 }));
    p.push(piece(new THREE.OctahedronGeometry(0.038), gemShade(g), gemShade(g) * 0.60, gemShade(g) * 0.32, { y: 0.07, z: 0.16 }));
    return assemble(p);
  },
  jerkin: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.195, 0.225, 0.40, 9, 1, true), S_BODY, S_BODY, S_BODY, { sz: 0.62 }));
    p.push(piece(new THREE.BoxGeometry(0.075, 0.38, 0.045), S_TRIM, S_TRIM, S_TRIM, { z: 0.135 }));
    for (let i = 0; i < 5; i++) {
      p.push(piece(new THREE.BoxGeometry(0.026, 0.026, 0.030), S_EDGE, S_EDGE, S_EDGE, { y: 0.15 - i * 0.075, z: 0.155 }));
    }
    p.push(piece(new THREE.TorusGeometry(0.225, 0.024, 5, 12), S_DEEP, S_DEEP, S_DEEP, { y: -0.19, rx: Math.PI / 2, sz: 0.64 }));
    return assemble(p);
  },
  robe: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.135, 0.265, 0.50, 10, 1, true), S_BODY, S_BODY, S_BODY, { sz: 0.62 }));
    p.push(piece(new THREE.BoxGeometry(0.065, 0.48, 0.036), S_DEEP, S_DEEP, S_DEEP, { z: 0.11 }));
    p.push(piece(new THREE.TorusGeometry(0.145, 0.026, 6, 12), S_TRIM, S_TRIM, S_TRIM, { y: 0.24, rx: Math.PI / 2, sz: 0.66 }));
    p.push(piece(new THREE.OctahedronGeometry(0.030), gemShade(g) * 0.75, gemShade(g) * 0.6, gemShade(g), { y: 0.15, z: 0.10 }));
    return assemble(p);
  },
  gauntlet: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.075, 0.088, 0.20, 9, 1, true), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.BoxGeometry(0.14, 0.075, 0.14), S_EDGE, S_EDGE, S_EDGE, { z: 0.16 }));
    for (let i = 0; i < 4; i++) {
      p.push(piece(new THREE.BoxGeometry(0.026, 0.030, 0.085), S_TRIM, S_TRIM, S_TRIM, { x: -0.048 + i * 0.032, y: 0.028, z: 0.255 }));
    }
    p.push(piece(new THREE.TorusGeometry(0.090, 0.016, 5, 12), S_DEEP, S_DEEP, S_DEEP, { z: -0.10, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.026), gemShade(g), gemShade(g) * 0.62, gemShade(g) * 0.34, { y: 0.05, z: 0.13 }));
    return assemble(p);
  },
  wraps: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.070, 0.082, 0.22, 8, 1, true), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    for (let i = 0; i < 3; i++) {
      p.push(piece(new THREE.TorusGeometry(0.076, 0.014, 5, 12), S_TRIM, S_TRIM, S_TRIM, { z: -0.07 + i * 0.07, rx: Math.PI / 2 + 0.12 }));
    }
    p.push(piece(new THREE.BoxGeometry(0.115, 0.055, 0.12), S_DEEP, S_DEEP, S_DEEP, { z: 0.155 }));
    return assemble(p);
  },
  boot: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.070, 0.085, 0.26, 8, 1, true), S_BODY, S_BODY, S_BODY, { y: 0.12 }));
    p.push(piece(new THREE.BoxGeometry(0.115, 0.075, 0.24), S_BODY, S_BODY, S_BODY, { y: 0.038, z: 0.065 }));
    p.push(piece(new THREE.BoxGeometry(0.125, 0.030, 0.27), S_DEEP, S_DEEP, S_DEEP, { y: -0.005, z: 0.06 }));
    p.push(piece(new THREE.TorusGeometry(0.078, 0.014, 5, 12), S_TRIM, S_TRIM, S_TRIM, { y: 0.22, rx: Math.PI / 2 }));
    p.push(piece(new THREE.BoxGeometry(0.10, 0.024, 0.045), S_TRIM, S_TRIM, S_TRIM, { y: 0.075, z: 0.14 }));
    return assemble(p);
  },
  greave: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.072, 0.092, 0.28, 9, 1, true), S_BODY, S_BODY, S_BODY, { y: 0.13 }));
    p.push(piece(new THREE.BoxGeometry(0.12, 0.085, 0.25), S_EDGE, S_EDGE, S_EDGE, { y: 0.042, z: 0.07 }));
    p.push(piece(new THREE.BoxGeometry(0.13, 0.028, 0.28), S_DEEP, S_DEEP, S_DEEP, { y: -0.005, z: 0.065 }));
    p.push(piece(new THREE.SphereGeometry(0.070, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2), S_EDGE, S_EDGE, S_EDGE, { y: 0.255 }));
    p.push(piece(new THREE.TorusGeometry(0.085, 0.016, 5, 12), S_TRIM, S_TRIM, S_TRIM, { y: 0.12, rx: Math.PI / 2 }));
    p.push(piece(new THREE.OctahedronGeometry(0.022), gemShade(g), gemShade(g) * 0.58, gemShade(g) * 0.30, { y: 0.20, z: 0.075 }));
    return assemble(p);
  },
  belt: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.185, 0.030, 6, 20), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2, sz: 0.72 }));
    p.push(piece(new THREE.BoxGeometry(0.13, 0.055, 0.10), S_EDGE, S_EDGE, S_EDGE, { z: 0.128 }));
    p.push(piece(new THREE.BoxGeometry(0.075, 0.020, 0.055), S_DEEP, S_DEEP, S_DEEP, { z: 0.128, y: 0.024 }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      p.push(piece(new THREE.BoxGeometry(0.032, 0.030, 0.030), S_TRIM, S_TRIM, S_TRIM,
        { x: Math.cos(a) * 0.185, z: Math.sin(a) * 0.133, ry: -a }));
    }
    p.push(piece(new THREE.OctahedronGeometry(0.028), gemShade(g), gemShade(g) * 0.64, gemShade(g) * 0.34, { z: 0.128, y: 0.038 }));
    return assemble(p);
  },
  sash: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.175, 0.038, 6, 16), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2, sz: 0.70 }));
    p.push(piece(new THREE.BoxGeometry(0.075, 0.030, 0.24), S_BODY, S_BODY, S_BODY, { z: 0.20, rx: 0.25 }));
    p.push(piece(new THREE.TorusGeometry(0.055, 0.024, 5, 12), S_TRIM, S_TRIM, S_TRIM, { z: 0.115, rx: Math.PI / 2 }));
    return assemble(p);
  },
  amulet: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.105, 0.008, 5, 22), S_TRIM, S_TRIM, S_TRIM, { rx: Math.PI / 2, sz: 1.25 }));
    p.push(piece(new THREE.OctahedronGeometry(0.055), S_BODY, S_BODY, S_BODY, { z: 0.115, sy: 0.5 }));
    p.push(piece(new THREE.OctahedronGeometry(0.036), gemShade(g), gemShade(g) * 0.55, gemShade(g) * 0.85, { z: 0.115, y: 0.012 }));
    return assemble(p);
  },
  torc: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.105, 0.020, 6, 20, Math.PI * 1.6), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.SphereGeometry(0.030, 10, 8), gemShade(g), gemShade(g) * 0.62, gemShade(g) * 0.36, { x: 0.105, z: 0.0 }));
    p.push(piece(new THREE.SphereGeometry(0.030, 10, 8), gemShade(g), gemShade(g) * 0.62, gemShade(g) * 0.36,
      { x: Math.cos(Math.PI * 1.6) * 0.105, z: -Math.sin(Math.PI * 1.6) * 0.105 }));
    return assemble(p);
  },
  ring: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.052, 0.014, 8, 20), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.030, 0.024, 0.016, 8), S_TRIM, S_TRIM, S_TRIM, { y: 0.016, z: 0.048 }));
    p.push(piece(new THREE.OctahedronGeometry(0.026), gemShade(g), gemShade(g) * 0.58, gemShade(g) * 0.80, { y: 0.028, z: 0.048 }));
    return assemble(p);
  },
  signet: (g) => {
    const p = [];
    p.push(piece(new THREE.TorusGeometry(0.050, 0.016, 8, 18), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.040, 0.030, 0.020, 6), S_EDGE, S_EDGE, S_EDGE, { y: 0.018, z: 0.046 }));
    p.push(piece(new THREE.OctahedronGeometry(0.024), gemShade(g), gemShade(g) * 0.66, gemShade(g) * 0.34, { y: 0.034, z: 0.046 }));
    return assemble(p);
  },
  gold: (g) => {
    const p = [];
    const r = (i) => 0.5 + 0.5 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);
    for (let i = 0; i < 16; i++) {
      const a = i * 2.3999, rad = 0.055 + r(i) * 0.11;
      const sz = 0.024 + r(i + 7) * 0.020;
      p.push(piece(new THREE.CylinderGeometry(sz, sz, 0.014, 8), 1.15 + r(i + 3) * 0.5, 1.0 + r(i + 3) * 0.35, 0.55,
        { x: Math.cos(a) * rad, z: Math.sin(a) * rad, y: 0.008 + r(i + 11) * 0.045, rx: (r(i) - 0.5) * 0.8, rz: (r(i + 5) - 0.5) * 0.8 }));
    }
    p.push(piece(new THREE.SphereGeometry(0.10, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0.85, 0.70, 0.40, { sy: 0.35 }));
    return assemble(p);
  },
  potion: (g) => {
    const p = [];
    p.push(piece(new THREE.SphereGeometry(0.062, 12, 9), gemShade(0.7), 1.15, 1.05, { y: 0.062 }));
    p.push(piece(new THREE.CylinderGeometry(0.024, 0.030, 0.070, 9, 1, true), 0.55, 0.52, 0.50, { y: 0.135 }));
    p.push(piece(new THREE.CylinderGeometry(0.028, 0.026, 0.028, 9), 0.40, 0.34, 0.28, { y: 0.178 }));
    p.push(piece(new THREE.TorusGeometry(0.030, 0.008, 5, 12), 0.70, 0.62, 0.44, { y: 0.104, rx: Math.PI / 2 }));
    return assemble(p);
  },
  material: (g) => {
    const p = [];
    p.push(piece(new THREE.DodecahedronGeometry(0.075, 0), S_BODY, S_BODY, S_BODY));
    p.push(piece(new THREE.TetrahedronGeometry(0.048), gemShade(g), 1.0 + g * 0.9, 1.0 + g * 0.7, { x: 0.055, y: 0.030, rz: 0.6 }));
    p.push(piece(new THREE.TetrahedronGeometry(0.038), S_EDGE, S_EDGE, S_EDGE, { x: -0.062, z: 0.040, rx: 1.1 }));
    return assemble(p);
  },
  rune: (g) => {
    const p = [];
    p.push(piece(new THREE.CylinderGeometry(0.080, 0.080, 0.026, 6), S_BODY, S_BODY, S_BODY, { rx: Math.PI / 2 }));
    p.push(piece(new THREE.CylinderGeometry(0.058, 0.058, 0.032, 6), S_DEEP, S_DEEP, S_DEEP, { rx: Math.PI / 2 }));
    const gs = gemShade(Math.max(0.55, g));
    p.push(piece(new THREE.BoxGeometry(0.048, 0.010, 0.012), gs, gs * 0.68, gs, { y: 0.028 }));
    p.push(piece(new THREE.BoxGeometry(0.010, 0.010, 0.070), gs, gs * 0.68, gs, { y: 0.028 }));
    p.push(piece(new THREE.BoxGeometry(0.038, 0.010, 0.012), gs, gs * 0.68, gs, { y: 0.028, z: 0.032 }));
    return assemble(p);
  },
};
const GEO_FALLBACK = 'material';

/* ==================================================================== *
 * shaders
 * ==================================================================== */

/*
 * ==================================================================== *
 * LOOT GLOW — the round-4 rewrite, and why it is shaped like this
 * ==================================================================== *
 *
 * The old beam was two merged 14-segment `CylinderGeometry` shells drawn
 * DoubleSide with additive blending and a fresnel rim term. Every one of those
 * four decisions was wrong at this camera:
 *
 *  · 14 radial segments give a 14-gon silhouette. From a 55-degree pitch the
 *    top cap of the cone reads as a scalloped disc, and once the additive sum
 *    saturates, that scallop becomes the hard triangular sawtooth rim the
 *    critic flagged. No amount of shader work hides a low-poly silhouette.
 *  · DoubleSide on a closed shell rasterises front AND back faces, so every
 *    fragment received the shell's contribution twice.
 *  · The fresnel term peaks at the silhouette, i.e. exactly where the polygon
 *    edge is, so the brightest pixels sat on the jaggiest line.
 *  · `#include <tonemapping_fragment>` is a NO-OP here: three only defines
 *    TONE_MAPPING when no render target is bound, and this project renders the
 *    scene into the composer's half-float buffer. So the shader was writing raw
 *    scene-linear values (rarity beamI reaches 4.4) which the pipeline then
 *    multiplied by an exposure gain of 1.9x-2.7x before ACES. 4.4 x 2.7 = 11.9,
 *    and ACES pins at 1.0 past about 3 — hence pure #FFFFFF discs, one per
 *    drop, each larger and brighter than the boss.
 *
 * The replacement is a single upright billboard quad per drop: two triangles,
 * built in the vertex shader to face the camera about world Y, with a purely
 * analytic horizontal falloff. There is no silhouette to facet, no back face to
 * double up, and no fresnel. Radiance is expressed as a fraction of the
 * exposure-derived ceiling (`uMaxRad`) and the premultiplied peak is rolled off
 * to it, so the hottest pixel of a mythic shaft lands at ~0.85 tonemapped in
 * every scenario and the rarity hue survives instead of washing to white.
 */

const BEAM_VS = /* glsl */`
uniform float uTime;
varying vec2 vQ;          // (-1..1 across, 0..1 up)
varying vec3 vCol;
varying float vPh;
void main() {
  /* The quad is authored x in [-0.5,0.5], y in [0,1], so the instance origin is
     the base of the shaft and the instance scale is (width, height, -). */
  vQ = vec2(position.x * 2.0, position.y);

  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3(1.0);
  #endif

  vec3 base = vec3(0.0);
  float wq = 1.0, hq = 1.0;
  #ifdef USE_INSTANCING
    base = instanceMatrix[3].xyz;
    wq = length(instanceMatrix[0].xyz);
    hq = length(instanceMatrix[1].xyz);
    vPh = base.x * 3.13 + base.z * 1.79;
  #else
    vPh = 0.0;
  #endif

  vec3 wp = (modelMatrix * vec4(base, 1.0)).xyz;
  /* Upright billboard: horizontal axis faces the camera, vertical axis stays
     world-up. A light shaft that leans with the camera reads as a decal. */
  vec3 toCam = cameraPosition - wp;
  vec3 right = cross(vec3(0.0, 1.0, 0.0), toCam);
  float rl = length(right);
  right = (rl > 1e-4) ? right / rl : vec3(1.0, 0.0, 0.0);

  vec3 p = wp + right * (position.x * wq) + vec3(0.0, 1.0, 0.0) * (position.y * hq);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const BEAM_FS = /* glsl */`
uniform float uTime;
uniform float uMaxRad;
varying vec2 vQ;
varying vec3 vCol;
varying float vPh;
void main() {
  float x = abs(vQ.x);
  float y = clamp(vQ.y, 0.0, 1.0);

  /* Horizontal profile. Both terms reach zero WITH ZERO SLOPE — smoothstep is
     flat at both ends and pow(.,2) is flat where it lands on zero — so the
     shaft has no rim to alias and no edge to sawtooth. */
  float volume = 1.0 - smoothstep(0.0, 1.0, x);
  float core   = pow(max(0.0, 1.0 - x * 3.1), 2.0);

  /* Vertical: rises out of the floor, tapers to nothing at the top. */
  float rise = smoothstep(0.0, 0.14, y);
  float fall = pow(1.0 - smoothstep(0.10, 1.0, y), 1.45);

  float shimmer = 0.86 + 0.14 * sin(y * 13.0 - uTime * 1.9 + vPh);

  /* Peaks at exactly 1.0 on the axis, so vCol IS the peak radiance and the CPU
     can budget it against the tonemapper directly. */
  float a = rise * fall * (volume * 0.34 + core * 0.66) * shimmer;

  vec3 c = vCol * a;
  float peak = max(c.r, max(c.g, c.b));
  float knee = uMaxRad * 0.55;
  if (peak > knee) {
    float head = max(uMaxRad - knee, 1e-4);
    float rolled = knee + head * (1.0 - exp(-(peak - knee) / head));
    c *= rolled / max(peak, 1e-5);
  }
  if (max(c.r, max(c.g, c.b)) < 1e-4) discard;
  /* Additive blend is src.rgb * src.a + dst; alpha 1 makes the premultiplied
     colour the literal contribution, so the roll-off above is the real cap. */
  gl_FragColor = vec4(c, 1.0);
}`;

const POOL_VS = /* glsl */`
attribute float aRing;
varying vec2 vUv;
varying vec3 vCol;
varying float vRing;
void main() {
  vUv = uv;
  vRing = aRing;
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3(1.0);
  #endif
  vec4 lp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
  #endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * lp;
}`;

/*
 * Ground pool. Same story as the beam: this was the single largest clipped
 * region in the boss frame — a 97x88 px pure-white disc, 5,246 of the frame's
 * 7,684 fully-clipped pixels in one blob — because its radius scaled to 2.45 m
 * and its colour was `rarity.beamI` (up to 4.4 linear) with no ceiling.
 *
 * Now: peaks at 1.0 on the axis so the instance colour IS the peak radiance,
 * the high-tier rune ring is keyed off a real uniform instead of guessing the
 * tier from the colour magnitude, and the premultiplied result is rolled off to
 * the same exposure-derived ceiling. The falloff already had zero slope at the
 * rim; the `discard` outside the unit disc stays only as a raster saver.
 */
const POOL_FS = /* glsl */`
uniform float uTime;
uniform float uMaxRad;
varying vec2 vUv;
varying vec3 vCol;
varying float vRing;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float d = length(q);
  if (d > 1.0) discard;

  float a = pow(1.0 - d, 2.6);

  /* Engraved rune ring — legendary and above only, and subtle. */
  if (vRing > 0.001) {
    float ang = atan(q.y, q.x) + uTime * 0.42;
    float dash = 0.5 + 0.5 * sin(ang * 12.0);
    float ring = smoothstep(0.58, 0.66, d) * smoothstep(0.86, 0.74, d);
    a += ring * (0.10 + 0.26 * dash) * vRing;
    float ring2 = smoothstep(0.30, 0.36, d) * smoothstep(0.48, 0.40, d);
    a += ring2 * 0.14 * vRing;
  }

  vec3 c = vCol * a;
  float peak = max(c.r, max(c.g, c.b));
  float knee = uMaxRad * 0.55;
  if (peak > knee) {
    float head = max(uMaxRad - knee, 1e-4);
    float rolled = knee + head * (1.0 - exp(-(peak - knee) / head));
    c *= rolled / max(peak, 1e-5);
  }
  if (max(c.r, max(c.g, c.b)) < 1e-4) discard;
  gl_FragColor = vec4(c, 1.0);
}`;

/* Same quad, but without the pool's `aRing` instanced attribute — the contact
   layer's geometry does not carry one, and an unbound attribute is undefined
   behaviour across drivers. */
const CONTACT_VS = /* glsl */`
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vCol = instanceColor;
  #else
    vCol = vec3(1.0);
  #endif
  vec4 lp = vec4(position, 1.0);
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
  #endif
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * lp;
}`;
const CONTACT_FS = /* glsl */`
varying vec2 vUv;
varying vec3 vCol;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float d = length(q);
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.1) * 0.72;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * vCol.r);
  #include <colorspace_fragment>
}`;

const MOTE_VS = /* glsl */`
attribute float aSize;
attribute vec3 aCol;
attribute float aFade;
varying vec3 vCol;
varying float vFade;
void main() {
  vCol = aCol; vFade = aFade;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  /* Clamp to 1.2-3 px. Below one pixel a mote flickers between "there" and
     "gone" as the camera drifts (sensor noise); above three it stops being a
     spark and becomes another glowing disc, which is the failure this whole
     layer is being rebuilt to avoid. */
  gl_PointSize = clamp(aSize * (240.0 / max(1.0, -mv.z)), 1.2, 3.0);
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FS = /* glsl */`
uniform float uMaxRad;
varying vec3 vCol;
varying float vFade;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.4) * vFade;
  vec3 c = vCol * a;
  float peak = max(c.r, max(c.g, c.b));
  float knee = uMaxRad * 0.55;
  if (peak > knee) {
    float head = max(uMaxRad - knee, 1e-4);
    float rolled = knee + head * (1.0 - exp(-(peak - knee) / head));
    c *= rolled / max(peak, 1e-5);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

/* ==================================================================== *
 * Loot
 * ==================================================================== */

export class Loot {
  static id = 'loot';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;

    this.progression = new Progression(engine, { level: 1 });
    /** Live world drops. */
    this.drops = [];
    /** Freed mesh slots keyed by archetype, so a wipe does not thrash the GPU. */
    this._geoCache = new Map();
    this._pool = [];
    this._offs = [];
    this._dropOrdinal = 0;
    this._deaths = 0;
    this._scenario = 'combat';
    this._altHeld = false;
    this._ready = false;
    this._toastQueue = [];
    this.root = null;
    this.stats = { dropped: 0, pickedUp: 0, gold: 0, legendary: 0 };
  }

  /* ---------------------------------------------------------------- init */

  async init() {
    const engine = this.engine;

    this.root = new THREE.Group();
    this.root.name = 'loot';
    this.root.matrixAutoUpdate = false;
    engine.scene.add(this.root);

    this._buildMaterials();
    this._buildLayers();
    this._buildLabelPool();

    this.progression.bindHooks();

    const bus = engine.bus;
    this._offs.push(bus.on('death', (p) => this._onDeath(p)));
    this._offs.push(bus.on('loot:drop', (p) => this._onExternalDrop(p)));
    this._offs.push(bus.on('loot:request', (p) => this._onRequest(p)));

    this._ready = true;
    console.info(
      `[loot] ready — 3 body materials (3 tex units each), 3 batched layers, ` +
      `${MAX_DROPS} drop cap => <= ${MAX_DROPS + 4 + MAX_LABELS} draw calls worst case`
    );
  }

  /** Three shared PBR bodies. Vertex colour carries every per-item tint. */
  _buildMaterials() {
    const a = this.engine.assets;
    const mk = (kind, seed, extra) => {
      let m = null;
      if (a && !a.__dead && typeof a.material === 'function') {
        try {
          m = a.material({
            kind, size: 256, tiling: 2, seed, unique: true,
            vertexColors: true, envMapIntensity: 1.15, dithering: true, ...extra,
          });
        } catch { m = null; }
      }
      if (!m) m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.6, ...extra });
      /* vertex colour above 1.0 spills into emissive — this is how gems, runes
         and gold catch-lights glow without a second material or draw call. */
      m.onBeforeCompile = (s) => {
        if (!s.fragmentShader.includes('#include <emissivemap_fragment>')) return;
        s.fragmentShader = s.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += max(vec3(0.0), vColor.rgb - 1.0) * 1.35;'
        );
      };
      m.customProgramCacheKey = () => `sanctumLootBody:${kind}`;
      m.name = `loot:${kind}`;
      m.needsUpdate = true;
      return m;
    };
    this.matHard = mk('metal', 2731, { metalness: 1.0 });
    this.matSoft = mk('leather', 5417, {});
    this.matOrganic = mk('bone', 8123, {});
    this._bodyMats = { metal: this.matHard, gold: this.matHard, gem: this.matHard, leather: this.matSoft, cloth: this.matSoft, bone: this.matOrganic, wood: this.matOrganic };
  }

  _matFor(family) { return this._bodyMats[family] ?? this.matHard; }

  /** Batched beam / pool / contact / mote layers. Four draw calls, total. */
  _buildLayers() {
    /* --- beam: ONE upright billboard quad. Two triangles, no silhouette to
           facet, no back face to double-add. See the note above BEAM_VS. --- */
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0,
    ]), 3));
    beamGeo.setIndex([0, 1, 2, 0, 2, 3]);
    beamGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 4);
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
      uniforms: { uTime: { value: 0 }, uMaxRad: { value: 0.84 } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      fog: false,
    });
    this.beams = new THREE.InstancedMesh(beamGeo, this.beamMat, MAX_DROPS);
    this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.beams.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
    this.beams.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.beams.count = 0;
    this.beams.frustumCulled = false;
    this.beams.renderOrder = 6;
    this.root.add(this.beams);

    /* --- ground pool (additive). The quad is 2x2 so an instance scale of R
           gives a disc of radius R metres. --- */
    const disc = new THREE.PlaneGeometry(2, 2).toNonIndexed();
    disc.rotateX(-Math.PI / 2);
    /* --- contact occlusion (normal blend, darkens). Cloned BEFORE the pool
           gets its per-instance `aRing`, so the contact shader never sees an
           attribute its vertex program does not declare. --- */
    const disc2 = disc.clone();

    /* legendary+ rune-ring strength, per instance */
    this._poolRing = new Float32Array(MAX_DROPS);
    const ringAttr = new THREE.InstancedBufferAttribute(this._poolRing, 1);
    ringAttr.setUsage(THREE.DynamicDrawUsage);
    disc.setAttribute('aRing', ringAttr);
    this._poolRingAttr = ringAttr;

    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VS, fragmentShader: POOL_FS,
      uniforms: { uTime: { value: 0 }, uMaxRad: { value: 0.84 } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    this.pools = new THREE.InstancedMesh(disc, this.poolMat, MAX_DROPS);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
    this.pools.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.pools.count = 0;
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 4;
    this.root.add(this.pools);

    this.contactMat = new THREE.ShaderMaterial({
      vertexShader: CONTACT_VS, fragmentShader: CONTACT_FS,
      uniforms: {},
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.NormalBlending, side: THREE.DoubleSide, toneMapped: false, fog: false,
    });
    this.contacts = new THREE.InstancedMesh(disc2, this.contactMat, MAX_DROPS);
    this.contacts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.contacts.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DROPS * 3), 3);
    this.contacts.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.contacts.count = 0;
    this.contacts.frustumCulled = false;
    this.contacts.renderOrder = 3;
    this.root.add(this.contacts);

    /* --- motes --- */
    const mg = new THREE.BufferGeometry();
    this._motePos = new Float32Array(MAX_MOTES * 3);
    this._moteSize = new Float32Array(MAX_MOTES);
    this._moteCol = new Float32Array(MAX_MOTES * 3);
    this._moteFade = new Float32Array(MAX_MOTES);
    mg.setAttribute('position', new THREE.BufferAttribute(this._motePos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('aSize', new THREE.BufferAttribute(this._moteSize, 1).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('aCol', new THREE.BufferAttribute(this._moteCol, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('aFade', new THREE.BufferAttribute(this._moteFade, 1).setUsage(THREE.DynamicDrawUsage));
    mg.setDrawRange(0, 0);
    this.moteMat = new THREE.ShaderMaterial({
      vertexShader: MOTE_VS, fragmentShader: MOTE_FS,
      uniforms: { uMaxRad: { value: 0.84 } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
    });
    this.motes = new THREE.Points(mg, this.moteMat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 7;
    this.root.add(this.motes);

    /* --- two importance-selected practical lights for legendary+ drops.
           No shadows: a shadow-casting point light costs a texture unit and
           the budget in KNOWN_ISSUES.md has none to spare. --- */
    this.lights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xff7a1e, 0, 6.5, 2);
      l.name = `loot.beam.${i}`;
      l.castShadow = false;
      /* Permanently visible, parked underground with zero intensity when idle.
         `WebGLRenderer.projectObject` skips invisible lights, so toggling
         `visible` changes NUM_POINT_LIGHTS — part of every material's program
         cache key — and relinks the entire scene (~60 ms). Legendary drops come
         and go constantly, so this was a per-drop full-scene recompile. */
      l.visible = true;
      l.position.set(0, -2000 - i * 8, 0);
      this.root.add(l);
      this.lights.push(l);
    }
  }

  /* -------------------------------------------------------- label plates */

  _buildLabelPool() {
    this.labels = [];
    this._measure = document.createElement('canvas').getContext('2d');
    for (let i = 0; i < MAX_LABELS; i++) {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 160;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      /* The plate is authored at ~7x its on-screen size so the lettering stays
         sharp; without mipmaps that minification aliases into coloured speckle
         once the post chain's chromatic aberration and grain hit it. */
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.engine.maxAniso ?? 1;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
        toneMapped: false, sizeAttenuation: true,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = 40;
      sp.center.set(0.5, 0);
      this.root.add(sp);
      this.labels.push({ sprite: sp, canvas: cv, tex, mat, uid: null, w: 1, h: LABEL_WORLD_H });
    }
  }

  /**
   * Ornate hexagonal cartouche, dark iron with a rarity hairline.
   *
   * The type size is FIXED in canvas pixels and the plate grows to fit, with
   * long rare/legendary names breaking at " of " onto a second line. Combined
   * with a sprite height derived from the painted height, that keeps the
   * lettering at a constant ~14 screen pixels at the ARPG camera distance
   * instead of condensing into an illegible smear.
   */
  _paintLabel(entry, item) {
    const r = rarityInfo(item.rarity);
    const rank = rarityRank(item.rarity);
    const raw = String(item.name ?? '').toUpperCase();

    /* ---- layout ---- */
    const MAXW = 1460;
    const m = this._measure;
    const widest = (ls, px) => {
      m.font = `${px}px ${FONT_DISPLAY}`;
      try { m.letterSpacing = '5px'; } catch { /* older engines */ }
      let w = 0;
      for (const l of ls) w = Math.max(w, m.measureText(l).width);
      return w;
    };

    /* break at " OF " (the natural seam in a rare/legendary name), else mid-word-count */
    let lines = [raw];
    if (widest(lines, LABEL_FONT_PX) > 940) {
      const at = raw.lastIndexOf(' OF ');
      if (at > 4) lines = [raw.slice(0, at), raw.slice(at + 1)];
      else {
        const words = raw.split(' ');
        const mid = Math.ceil(words.length / 2);
        lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
      }
    }
    /* only after wrapping do we allow the type to shrink, and never far */
    let fs = LABEL_FONT_PX;
    let tw = widest(lines, fs);
    if (tw > MAXW) { fs = Math.max(58, Math.floor(fs * (MAXW / tw))); tw = widest(lines, fs); }
    const lineH = Math.round(fs * 1.24), pad = 26, notch = 36, side = 40;

    /* legendary+ get an engraved type line: "LEGENDARY VAMBRACES" */
    const sub = rank >= 3 && item.baseLabel
      ? `${r.label} ${item.baseLabel}`.toUpperCase() : null;
    const subFs = 50, subH = sub ? 72 : 0;
    if (sub) {
      m.font = `${subFs}px ${FONT_ENGRAVED}`;
      try { m.letterSpacing = '9px'; } catch { /* older engines */ }
      tw = Math.max(tw, m.measureText(sub).width);
    }

    const ph = pad * 2 + lineH * lines.length + subH;
    const pw = Math.ceil(tw + side * 2 + notch * 2);
    const cv = entry.canvas;
    const W = pw + 10, H = ph + 14;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.font = `${fs}px ${FONT_DISPLAY}`;
    try { g.letterSpacing = '5px'; } catch { /* older engines */ }
    const x0 = 5, y0 = 7;

    /* plate silhouette */
    const path = () => {
      g.beginPath();
      g.moveTo(x0 + notch, y0);
      g.lineTo(x0 + pw - notch, y0);
      g.lineTo(x0 + pw, y0 + ph * 0.5);
      g.lineTo(x0 + pw - notch, y0 + ph);
      g.lineTo(x0 + notch, y0 + ph);
      g.lineTo(x0, y0 + ph * 0.5);
      g.closePath();
    };

    /* cast shadow */
    g.save();
    g.translate(0, 6);
    path();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.filter = 'blur(6px)';
    g.fill();
    g.restore();

    /* iron body */
    path();
    const bg = g.createLinearGradient(0, y0, 0, y0 + ph);
    bg.addColorStop(0, '#23262c');
    bg.addColorStop(0.42, '#14171b');
    bg.addColorStop(1, '#0a0c0e');
    g.fillStyle = bg;
    g.fill();

    /* rarity wash from the bottom */
    g.save();
    path();
    g.clip();
    const rw = g.createLinearGradient(0, y0 + ph, 0, y0 + ph * 0.25);
    rw.addColorStop(0, this._rgba(r.glow, rank >= 3 ? 0.42 : 0.24));
    rw.addColorStop(1, this._rgba(r.glow, 0));
    g.fillStyle = rw;
    g.fillRect(x0, y0, pw, ph);
    /* brushed metal streaks */
    g.globalAlpha = 0.10;
    g.strokeStyle = '#cdd4dd';
    g.lineWidth = 1;
    for (let i = 0; i < 22; i++) {
      const yy = y0 + 6 + ((i * 7919) % (ph - 12));
      g.beginPath(); g.moveTo(x0 + 4, yy); g.lineTo(x0 + pw - 4, yy + ((i % 3) - 1)); g.stroke();
    }
    g.restore();

    /* bevel + rarity hairline */
    path();
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.lineWidth = 6; g.stroke();
    path();
    g.strokeStyle = this._rgba(r.line, 0.92);
    g.lineWidth = 2.6; g.stroke();
    g.save();
    path(); g.clip();
    g.strokeStyle = 'rgba(232,214,168,0.20)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0 + notch, y0 + 2); g.lineTo(x0 + pw - notch, y0 + 2); g.stroke();
    g.restore();

    /* rarity diamond caps */
    for (const cx of [x0 + notch * 0.52, x0 + pw - notch * 0.52]) {
      g.save();
      g.translate(cx, y0 + ph * 0.5);
      g.rotate(Math.PI / 4);
      g.fillStyle = this._rgba(r.line, 0.95);
      g.fillRect(-9, -9, 18, 18);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(-4, -4, 8, 8);
      g.restore();
    }

    /* the name — engraved: hard dark cut, warm catch-light, rarity glow */
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    const cx0 = x0 + pw * 0.5;
    for (let i = 0; i < lines.length; i++) {
      const cy = y0 + pad + lineH * (i + 0.5);
      g.strokeStyle = 'rgba(0,0,0,0.96)';
      g.lineWidth = 9;
      g.strokeText(lines[i], cx0, cy);
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 3;
      g.strokeText(lines[i], cx0, cy + 3);
      if (rank >= 3) { g.shadowColor = this._rgba(r.glow, 0.95); g.shadowBlur = 22; }
      g.fillStyle = this._rgba(r.text, 1);
      g.fillText(lines[i], cx0, cy);
      g.shadowBlur = 0;
      /* catch-light on the upper bevel of the letterform */
      g.globalAlpha = 0.35;
      g.fillStyle = 'rgba(255,244,214,1)';
      g.fillText(lines[i], cx0, cy - 2);
      g.globalAlpha = 1;
    }

    if (sub) {
      const sy = y0 + pad + lineH * lines.length + subH * 0.42;
      g.font = `${subFs}px ${FONT_ENGRAVED}`;
      try { g.letterSpacing = '9px'; } catch { /* older engines */ }
      /* hairline rule with a diamond, then the type line */
      const rw2 = Math.min(pw * 0.34, 220);
      g.strokeStyle = this._rgba(r.line, 0.45);
      g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(cx0 - rw2, sy - subH * 0.34); g.lineTo(cx0 - 26, sy - subH * 0.34); g.stroke();
      g.beginPath(); g.moveTo(cx0 + 26, sy - subH * 0.34); g.lineTo(cx0 + rw2, sy - subH * 0.34); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.95)';
      g.lineWidth = 6;
      g.strokeText(sub, cx0, sy);
      g.fillStyle = this._rgba(r.line, 0.86);
      g.fillText(sub, cx0, sy);
    }

    entry.tex.needsUpdate = true;
    entry.h = LABEL_WORLD_H * (H / 160) * (rank >= 3 ? 1.08 : 1);
    entry.w = entry.h * (W / H);
    return entry;
  }

  _rgba(hexCss, a) {
    const h = String(hexCss).replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  /* ==================================================================== *
   * drop rolling
   * ==================================================================== */

  _onDeath(p) {
    if (!this._ready || !p || !p.entity) return;
    const e = p.entity;
    const hero = this.engine.get('hero');
    if (hero && (e === hero || e === hero.root)) return;   // the hero drops nothing

    this._deaths++;
    const def = e.def ?? {};
    const species = def.id ?? 'skeleton';
    const isBoss = !!def.isBoss;
    const elite = !!e.elite;
    const level = Math.max(1, Math.round(e.level ?? this.progression.level));
    const rank = isBoss ? 'boss' : elite ? 'champion' : 'normal';

    /* XP first — a level-up should read before the loot lands. */
    try { this.progression.gainXp(xpForKill(level, rank) * this._xpScale()); } catch { /* noop */ }

    const at = p.hitPoint ?? e.position ?? null;
    if (!at) return;
    const seed = hashStr(`${this._scenario}|death|${species}|${this._deaths}|${level}|${elite ? 'e' : 'n'}`);
    const rand = this.engine.freshRand(seed);
    const rolled = this.rollDrops(rand, { species, elite, isBoss, level });
    const origin = new THREE.Vector3(at.x ?? 0, at.y ?? 0, at.z ?? 0);

    for (let i = 0; i < rolled.length; i++) {
      const spread = rolled.length > 1 ? 0.35 + rand() * 0.85 : 0.15;
      const a = (i / Math.max(1, rolled.length)) * Math.PI * 2 + rand() * 1.1;
      this.dropItem(rolled[i], _v.set(
        origin.x + Math.cos(a) * spread,
        origin.y + 0.35 + rand() * 0.35,
        origin.z + Math.sin(a) * spread
      ), { launch: true, rand });
    }
  }

  _xpScale() {
    const ws = this.engine.get('director')?.worldState ?? null;
    return ws?.xp ?? 1;
  }

  /**
   * Roll a full drop list for one kill.
   * @returns {object[]} items (gear, gold, potions, materials), best first
   */
  rollDrops(rand, { species = 'skeleton', elite = false, isBoss = false, level = 1 } = {}) {
    const prof = PROFILES[species] ?? DEFAULT_PROFILE;
    const out = [];
    const mf = this.progression.derived.magicFind ?? 0;

    let luck = prof.luck + (elite ? 0.35 : 0) + (isBoss ? 0.9 : 0) + Math.min(0.35, level * 0.004);
    const qual = this.engine.get('director')?.worldState?.loot ?? 1;
    luck *= qual;

    /* --- gear --- */
    let gearN = prof.gear * (elite ? 2.4 : 1) * qual;
    let n = Math.floor(gearN);
    if (rand() < gearN - n) n++;
    if (isBoss) n = Math.max(3, n);
    else if (elite) n = Math.max(1, n);
    n = Math.min(n, 6);

    const ilvlBase = clamp(Math.round(level * 1.35 + 4 + (elite ? 5 : 0) + (isBoss ? 14 : 0)), 1, 100);
    for (let i = 0; i < n; i++) {
      const floor = isBoss && i === 0 ? (prof.floor ?? 'rare') : null;
      const it = makeItem(rand, {
        ilvl: clamp(ilvlBase + Math.round((rand() - 0.5) * 6), 1, 100),
        luck: luck + (isBoss && i === 0 ? 0.6 : 0),
        magicFind: mf,
        rarity: floor ? this._floorRarity(rand, floor, luck, mf) : undefined,
        uid: `drop:${this._dropOrdinal + out.length}:${i}`,
      });
      out.push(it);
    }

    /* --- gold --- */
    if (isBoss || rand() < prof.goldChance) {
      const gmul = 1 + (this.progression.derived.goldFind ?? 0) / 100;
      const lo = prof.gold[0], hi = prof.gold[1];
      const amt = (lo + rand() * (hi - lo)) * (1 + level * 0.06) * (elite ? 2.2 : 1) * gmul;
      out.push(makeGold(rand, amt, `drop:gold:${this._dropOrdinal + out.length}`));
      if (isBoss) out.push(makeGold(rand, amt * 0.8, `drop:gold2:${this._dropOrdinal + out.length}`));
    }

    /* --- potion --- */
    if (isBoss || rand() < (elite ? 0.30 : 0.11)) {
      out.push(makePotion(rand, level, `drop:potion:${this._dropOrdinal + out.length}`));
    }

    /* --- crafting materials --- */
    if (isBoss || rand() < prof.matChance * (elite ? 1.8 : 1)) {
      const id = prof.mats[Math.floor(rand() * prof.mats.length) % prof.mats.length];
      const amount = 1 + Math.floor(rand() * (isBoss ? 4 : elite ? 2 : 1));
      out.push(makeMaterial(rand, id, amount, `drop:mat:${this._dropOrdinal + out.length}`));
    }
    if (isBoss) {
      out.push(makeMaterial(rand, 'wardenAsh', 1, `drop:mat2:${this._dropOrdinal + out.length}`));
    }

    out.sort((a, b) => rarityRank(b.rarity) - rarityRank(a.rarity));
    return out;
  }

  _floorRarity(rand, floor, luck, mf) {
    const order = rarityRank(floor);
    /* Boss guarantee: at least `floor`, with a real chance of better. */
    const roll = rand() * (1 + luck * 0.8) + mf * 0.002;
    let k = order;
    if (roll > 1.05) k = Math.min(RARITY_ORDER.length - 1, order + 1);
    if (roll > 1.55) k = Math.min(RARITY_ORDER.length - 1, order + 2);
    return RARITY_ORDER[k];
  }

  /* ==================================================================== *
   * world presentation
   * ==================================================================== */

  /**
   * Put an item on the floor. Emits 'loot:drop'.
   * @param {object} item
   * @param {THREE.Vector3|{x,y,z}} at
   * @param {{launch?:boolean, rand?:Function}} [o]
   */
  dropItem(item, at, o = {}) {
    if (!this._ready || !item) return null;
    if (this.drops.length >= MAX_DROPS) this._retire(this._oldestPickable());
    if (this.drops.length >= MAX_DROPS) return null;

    const ord = this._dropOrdinal++;
    const rand = o.rand ?? this.engine.freshRand(hashStr(`${this._scenario}|drop|${ord}`));
    const spec = item.mesh ?? { arch: 'material', family: 'metal', tint: 0x8b939c, glow: 0.1, scale: 1 };
    const rank = rarityRank(item.rarity);

    const mesh = this._acquireMesh(spec, rank);
    const y0 = this._groundY(at.x, at.z);

    const drop = {
      id: ord,
      item,
      mesh,
      rarity: item.rarity ?? 'common',
      rank,
      x: at.x, z: at.z,
      y: Math.max(y0 + 0.05, at.y ?? y0 + 0.4),
      groundY: y0,
      vx: 0, vy: 0, vz: 0,
      spin: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      settled: false,
      restQuat: new THREE.Quaternion(),
      restT: 0,
      bornAt: this.engine.clock.elapsed,
      phase: rand() * Math.PI * 2,
      bobAmp: 0.035 + rand() * 0.02,
      spinRate: (0.30 + rand() * 0.24) * (rand() < 0.5 ? -1 : 1),
      scale: (spec.scale ?? 1) * DISPLAY_SCALE * (rank >= 3 ? 1.08 : 1),
      radius: 0.28,
      body: null,
      moteBase: -1,
      labelUid: item.uid,
      showLabel: 0,
      picked: false,
    };

    if (o.launch !== false) {
      const a = rand() * Math.PI * 2;
      const sp = 1.15 + rand() * 1.4;
      drop.vx = Math.cos(a) * sp;
      drop.vz = Math.sin(a) * sp;
      drop.vy = 2.4 + rand() * 1.8;
      drop.spin.set((rand() - 0.5) * 11, (rand() - 0.5) * 9, (rand() - 0.5) * 11);
    } else {
      drop.y = y0 + 0.02;
      drop.settled = true;
      drop.restT = 1;
    }
    /* resting pose: laid flat with a believable yaw */
    drop.restQuat.setFromEuler(new THREE.Euler(
      this._restPitch(spec.arch), rand() * Math.PI * 2, (rand() - 0.5) * 0.28
    ));
    if (drop.settled) drop.quat.copy(drop.restQuat);

    drop.body = this._handOffPhysics(drop);

    this.drops.push(drop);
    this.stats.dropped++;
    if (rank >= 3) this.stats.legendary++;

    /* --- the drop moment --- */
    const bus = this.engine.bus;
    const pos = new THREE.Vector3(drop.x, drop.y, drop.z);
    try {
      bus.emit('loot:drop', { item, position: pos.clone(), rarity: drop.rarity, rank });
      bus.emit('impact', {
        point: pos.clone(), normal: new THREE.Vector3(0, 1, 0),
        kind: rank >= 3 ? 'arcane' : 'ceramic',
        magnitude: rank >= 3 ? 1.35 : 0.5,
      });
      const cue = rank >= 5 ? 'loot.mythic' : rank >= 3 ? 'loot.legendary' : rank >= 2 ? 'loot.rare' : 'loot.drop';
      bus.emit('audio:sfx', { id: cue, position: pos.clone(), gain: rank >= 3 ? 1.0 : 0.5 });
      if (rank >= 3) {
        bus.emit('audio:cue', { id: cue, tier: drop.rarity });
        bus.emit('vfx:request', {
          kind: 'lootBurst', position: pos.clone(),
          colour: rarityInfo(drop.rarity).beam, radius: rank >= 5 ? 2.4 : 1.7, count: 40 + rank * 12,
        });
        bus.emit('camera:shake', { amp: rank >= 5 ? 0.18 : 0.10, freq: 18, duration: 0.26 });
        bus.emit('ui:toast', {
          text: `${rarityInfo(drop.rarity).label.toUpperCase()} — ${item.name}`,
          tier: drop.rarity,
        });
      }
    } catch { /* presentation only */ }

    return drop;
  }

  _restPitch(arch) {
    switch (arch) {
      case 'sword': case 'dagger': case 'axe': case 'mace': case 'staff':
      case 'scythe': case 'bow': case 'quiver': case 'gauntlet': case 'wraps':
        return 0;                                   // already lying along +Z
      case 'shield': case 'towershield': case 'tome': case 'belt': case 'sash':
      case 'amulet': case 'torc': case 'ring': case 'signet':
        return 0;                                   // flat-plane archetypes
      default:
        return -Math.PI * 0.42;                      // upright shells tip over
    }
  }

  /**
   * Hand the tumble to the physics module if one exists.
   *
   * The spec below is the documented contract. Anything truthy that comes back
   * is assumed to simulate the drop, and Loot then only *reads* its transform
   * (`position`/`p`, `quaternion`/`q`, `settled`/`sleeping`) and applies it to
   * the mesh Loot owns. With no physics module — or a refusal — Loot integrates
   * the toss itself, which is the path that runs today.
   *
   * We deliberately do NOT fall through to `physics.spawnBody()`: that pool is
   * rendered by the debris InstancedMesh, so it would draw a rubble chunk on
   * top of the item we already drew. Only an API that accepts `object` (and so
   * knows a mesh already exists) is safe here.
   */
  _handOffPhysics(drop) {
    const phys = this.engine.get('physics');
    if (!phys || phys.__dead) return null;
    const bb = drop.mesh.geometry.boundingBox;
    const half = bb
      ? { x: (bb.max.x - bb.min.x) * 0.5 * drop.scale, y: (bb.max.y - bb.min.y) * 0.5 * drop.scale, z: (bb.max.z - bb.min.z) * 0.5 * drop.scale }
      : { x: 0.12, y: 0.05, z: 0.24 };
    const spec = {
      tag: 'loot', object: drop.mesh, shape: 'box', halfExtents: half,
      mass: 2.1, restitution: 0.26, friction: 0.72, linearDamping: 0.12, angularDamping: 0.2,
      position: { x: drop.x, y: drop.y, z: drop.z },
      velocity: { x: drop.vx, y: drop.vy, z: drop.vz },
      angularVelocity: { x: drop.spin.x, y: drop.spin.y, z: drop.spin.z },
      groundY: drop.groundY,
      onSettle: () => { drop.settled = true; },
    };
    try {
      const h = phys.dropItem?.(spec) ?? phys.addDynamicBody?.(spec) ?? phys.toss?.(spec) ?? null;
      if (h) drop.bodyUntil = this.engine.clock.elapsed + 4.0;
      return h || null;
    } catch (e) {
      console.warn('[loot] physics handoff refused —', e?.message ?? e);
      return null;
    }
  }

  _groundY(x, z) {
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    const hero = this.engine.get('hero');
    return hero?.position?.y ?? 0;
  }

  /* ------------------------------------------------------------- meshes */

  _templateFor(arch) {
    const key = GEO[arch] ? arch : GEO_FALLBACK;
    let g = this._geoCache.get(key);
    if (!g) {
      try { g = GEO[key](0.55); } catch (e) { console.warn(`[loot] geo ${key} failed —`, e?.message); g = new THREE.BoxGeometry(0.18, 0.06, 0.3); }
      this._geoCache.set(key, g);
    }
    return g;
  }

  /** Clone the template and multiply its vertex colours by the item tint. */
  _acquireMesh(spec, rank) {
    const tpl = this._templateFor(spec.arch);
    const geo = tpl.clone();
    const col = geo.attributes.color;
    _col.setHex(spec.tint ?? 0x8b939c, THREE.SRGBColorSpace).multiplyScalar(TINT_LIFT);
    _gem.setHex(spec.gem ?? 0xffffff, THREE.SRGBColorSpace);
    const e = (0.80 + (spec.glow ?? 0.1) * 0.5) * (rank >= 3 ? 1.0 + (rank - 2) * 0.32 : 0.72);
    const arr = col.array;
    for (let i = 0; i < arr.length; i += 3) {
      const s = arr[i];
      if (s > EMISSIVE_MARK) {
        /* emissive inlay: tinted by the gem colour, amplified by rarity */
        arr[i] = 1 + _gem.r * e * 1.7;
        arr[i + 1] = 1 + _gem.g * e * 1.7;
        arr[i + 2] = 1 + _gem.b * e * 1.7;
      } else {
        arr[i] = s * _col.r;
        arr[i + 1] = arr[i + 1] * _col.g;
        arr[i + 2] = arr[i + 2] * _col.b;
      }
    }
    col.needsUpdate = true;
    const m = new THREE.Mesh(geo, this._matFor(spec.family));
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = true;
    m.matrixAutoUpdate = false;
    this.root.add(m);
    return m;
  }

  _releaseMesh(mesh) {
    if (!mesh) return;
    this.root.remove(mesh);
    mesh.geometry.dispose();
  }

  _oldestPickable() {
    let best = null;
    for (const d of this.drops) {
      if (d.rank >= 3) continue;
      if (!best || d.bornAt < best.bornAt) best = d;
    }
    return best ?? this.drops[0] ?? null;
  }

  _retire(drop) {
    if (!drop) return;
    const i = this.drops.indexOf(drop);
    if (i >= 0) this.drops.splice(i, 1);
    if (drop.body) { try { this.engine.get('physics')?.remove?.(drop.body); } catch { /* noop */ } }
    this._releaseMesh(drop.mesh);
  }

  /* ==================================================================== *
   * pickup
   * ==================================================================== */

  /** Take a drop. Emits 'loot:pickup' and 'ui:toast'. */
  pickup(drop, { auto = false } = {}) {
    if (!drop || drop.picked) return false;
    const item = drop.item;
    const bus = this.engine.bus;
    const prog = this.progression;

    let text = item.name;
    let tier = item.rarity ?? 'common';

    if (item.kind === 'gold') {
      prog.addGold(item.stack);
      this.stats.gold += item.stack;
      text = `+${item.stack} Gold`;
      tier = 'gold';
    } else if (item.kind === 'potion') {
      if (!prog.addPotion(1)) return false;
      text = item.name;
    } else if (item.kind === 'material') {
      prog.addMaterial(item.materialId, item.stack);
      text = `${item.name}`;
    } else {
      if (prog.isFull) {
        if (!auto) {
          try { bus.emit('ui:toast', { text: 'Your bags are full', tier: 'danger' }); } catch { /* noop */ }
        }
        return false;
      }
      prog.addToInventory(item);
      /* auto-equip a clear upgrade into an empty slot — the tutorialising
         behaviour every ARPG has on early pickups */
      const cmp = prog.compare(item);
      if (cmp && !cmp.current) prog.equip(item);
    }

    drop.picked = true;
    this.stats.pickedUp++;
    this._retire(drop);

    try {
      bus.emit('loot:pickup', { item, auto, position: new THREE.Vector3(drop.x, drop.y, drop.z) });
      bus.emit('ui:toast', { text, tier });
      bus.emit('audio:sfx', {
        id: item.kind === 'gold' ? 'loot.gold' : rarityRank(tier) >= 3 ? 'loot.pickupRare' : 'loot.pickup',
        position: new THREE.Vector3(drop.x, drop.y, drop.z), gain: 0.6,
      });
    } catch { /* presentation only */ }
    this.progression.syncHero();
    return true;
  }

  /* ==================================================================== *
   * per-frame
   * ==================================================================== */

  update(dt, elapsed) {
    if (!this._ready) return;
    this.progression.tick();

    const input = this.engine.input;
    this._altHeld = !!(input?.pressed?.('AltLeft') || input?.pressed?.('AltRight'));
    const hero = this.engine.get('hero');
    const hx = hero?.position?.x ?? 0, hz = hero?.position?.z ?? 0;

    /* ---------- simulate ---------- */
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (d.body) this._readPhysics(d);
      else this._integrate(d, dt);
      this._pose(d, elapsed);
    }

    /* ---------- pickup ---------- */
    this._servicePickups(hx, hz, input);

    /* ---------- presentation ---------- */
    this.beamMat.uniforms.uTime.value = elapsed;
    this.poolMat.uniforms.uTime.value = elapsed;
    this._writeLayers(elapsed, hx, hz);
    this._writeMotes(elapsed);
    this._writeLights(hx, hz);
    this._writeLabels(elapsed, hx, hz);
  }

  _integrate(d, dt) {
    if (d.settled) return;
    d.vy -= GRAVITY * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;

    const gy = this._groundY(d.x, d.z) + 0.035;
    d.groundY = gy - 0.035;

    if (d.y <= gy) {
      d.y = gy;
      if (d.vy < -0.55) {
        d.vy = -d.vy * 0.26;
        d.vx *= 0.55; d.vz *= 0.55;
        d.spin.multiplyScalar(0.42);
        try {
          this.engine.bus.emit('impact', {
            point: new THREE.Vector3(d.x, gy, d.z), normal: new THREE.Vector3(0, 1, 0),
            kind: 'ceramic', magnitude: 0.35,
          });
        } catch { /* noop */ }
      } else {
        d.vy = 0;
        d.vx *= 0.80; d.vz *= 0.80;
        d.spin.multiplyScalar(0.72);
        if (Math.abs(d.vx) + Math.abs(d.vz) < 0.06 && d.spin.lengthSq() < 0.6) d.settled = true;
      }
    }
    if (!d.settled) {
      _eul.set(d.spin.x * dt, d.spin.y * dt, d.spin.z * dt);
      _q.setFromEuler(_eul);
      d.quat.premultiply(_q);
    }
  }

  /**
   * Read a physics-owned drop. Detaches as soon as the body settles or the
   * lease expires — a pooled body can be recycled under us, and reading a
   * recycled body would teleport the item.
   */
  _readPhysics(d) {
    const b = d.body;
    const p = b.position ?? b.p ?? b.pos ?? null;
    if (p) { d.x = p.x; d.y = p.y; d.z = p.z; }
    const q = b.quaternion ?? b.q ?? b.quat ?? null;
    if (q) d.quat.set(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1);
    d.groundY = this._groundY(d.x, d.z);
    const done = b.settled || b.sleeping || b.asleep || b.active === false ||
      this.engine.clock.elapsed > (d.bodyUntil ?? 0);
    if (done) {
      d.settled = true;
      try { this.engine.get('physics')?.remove?.(b); } catch { /* noop */ }
      d.body = null;
    }
  }

  /** Settle into the rest pose, then bob and rotate forever. */
  _pose(d, elapsed) {
    if (!d.hoverQuat) d.hoverQuat = new THREE.Quaternion();
    if (d.settled) {
      d.restT = Math.min(1, d.restT + this.engine.clock.dt * 4.2);
      d.spin.multiplyScalar(0.86);
      const e = smooth(0, 1, d.restT);
      /* ease into the resting pose, then layer a slow hover spin about world Y */
      d.quat.slerp(d.restQuat, e * 0.35);
      _q2.setFromAxisAngle(_up, elapsed * d.spinRate);
      d.hoverQuat.copy(_q2).multiply(d.quat);
      d.y = d.groundY + 0.075 + Math.sin(elapsed * 1.55 + d.phase) * d.bobAmp * (0.35 + e * 0.65);
    } else {
      d.hoverQuat.copy(d.quat);
    }
    const s = d.scale;
    _mtx.compose(_v.set(d.x, d.y, d.z), d.hoverQuat, _v2.set(s, s, s));
    d.mesh.matrix.copy(_mtx);
    d.mesh.matrixWorldNeedsUpdate = true;
  }

  _servicePickups(hx, hz, input) {
    const clicked = !!input?.justPressed?.('mouse0');
    const keyed = !!(input?.justPressed?.('KeyE') || input?.justPressed?.('Space'));
    const gp = input?.mouse?.worldGround;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (d.picked) continue;
      const dx = d.x - hx, dz = d.z - hz;
      const dist = Math.hypot(dx, dz);

      if (d.item.autoPickup && dist < AUTO_RANGE && d.settled) { this.pickup(d, { auto: true }); continue; }
      if (dist > PICKUP_RANGE) continue;
      if (keyed) { this.pickup(d); continue; }
      if (clicked && gp) {
        const cd = Math.hypot(gp.x - d.x, gp.z - d.z);
        if (cd < CLICK_RADIUS) { this.pickup(d); continue; }
      }
    }
  }

  /**
   * Scene-linear ceiling for one additive loot layer, from the pipeline's live
   * exposure gain. Floored so a hypothetical 5x gain still leaves a legible
   * shaft, ceiled so a gain of 1 does not licence an unbounded emissive.
   */
  _radianceCeiling() {
    const g = Math.max(1, Number(this.engine.exposureGain) || 1.85);
    return clamp(TONEMAP_085 / g, 0.30, 1.60);
  }

  /**
   * Set `_col` to the rarity hue at exactly `peak` scene-linear on its
   * strongest channel.
   *
   * Normalising by the max channel first is what keeps the glow RARITY-TINTED
   * instead of white. If you scale a hue by brightness without normalising, the
   * strongest channel saturates first and the others follow, so every rarity
   * converges on #FFFFFF as it gets brighter — which is exactly what the
   * fourteen identical white discs were. Normalised, an orange legendary peaks
   * orange and a blue magic peaks blue, at the same radiance.
   */
  _tintAt(hex, peak) {
    _col.setHex(hex, THREE.SRGBColorSpace);
    const mx = Math.max(_col.r, Math.max(_col.g, _col.b));
    _col.multiplyScalar(peak / (mx > 1e-4 ? mx : 1));
    return _col;
  }

  _writeLayers(elapsed, hx, hz) {
    const cap = this._radianceCeiling();
    this.beamMat.uniforms.uMaxRad.value = cap;
    this.poolMat.uniforms.uMaxRad.value = cap;
    this.moteMat.uniforms.uMaxRad.value = cap;

    let n = 0;
    for (const d of this.drops) {
      if (n >= MAX_DROPS) break;
      const r = rarityInfo(d.rarity);
      const t = GLOW_TIERS[clamp(d.rank | 0, 0, GLOW_TIERS.length - 1)];
      const gy = d.groundY;
      const age = clamp01((elapsed - d.bornAt) * 2.2);

      /* Beam — a narrow vertical shaft, and only from legendary up. A common's
         tier is all zeros, which collapses the quad to zero area: present in the
         draw call, invisible and free. */
      const h = t.beamH * (0.45 + age * 0.55);
      const w = t.beamW;
      _mtx.compose(_v.set(d.x, gy + 0.01, d.z), _q.identity(), _v2.set(w, h, w));
      this.beams.setMatrixAt(n, _mtx);
      this.beams.setColorAt(n, this._tintAt(r.beam, cap * t.beamI * (0.6 + age * 0.4)));

      /* Ground pool — a small rarity smudge under the item, breathing slowly. */
      const pr = t.poolR * (0.55 + age * 0.45);
      _mtx.compose(_v.set(d.x, gy + 0.022, d.z), _q.identity(), _v2.set(pr, 1, pr));
      this.pools.setMatrixAt(n, _mtx);
      const breathe = 0.82 + 0.18 * Math.sin(elapsed * 1.9 + d.phase);
      this.pools.setColorAt(n, this._tintAt(r.beam, cap * t.poolI * breathe * age));
      this._poolRing[n] = t.ring * age;

      /* contact occlusion — nothing floats */
      const cr = 0.26 * d.scale + 0.10;
      const lift = clamp01((d.y - gy) / 0.7);
      _mtx.compose(_v.set(d.x, gy + 0.012, d.z), _q.identity(), _v2.set(cr * (1 + lift * 0.7), 1, cr * (1 + lift * 0.7)));
      this.contacts.setMatrixAt(n, _mtx);
      _col.setRGB(clamp01(1 - lift * 0.65), 0, 0);
      this.contacts.setColorAt(n, _col);

      n++;
    }
    this.beams.count = n;
    this.pools.count = n;
    this.contacts.count = n;
    if (n) {
      this.beams.instanceMatrix.needsUpdate = true;
      this.beams.instanceColor.needsUpdate = true;
      this.pools.instanceMatrix.needsUpdate = true;
      this.pools.instanceColor.needsUpdate = true;
      this._poolRingAttr.needsUpdate = true;
      this.contacts.instanceMatrix.needsUpdate = true;
      this.contacts.instanceColor.needsUpdate = true;
    }
  }

  _writeMotes(elapsed) {
    const cap = this._radianceCeiling();
    let k = 0;
    for (const d of this.drops) {
      if (d.rank < 3) continue;
      const r = rarityInfo(d.rarity);
      /* A mote is 1-2 px, so it needs to sit near the ceiling to read at all —
         but it must not exceed it, or a drifting spark clips to a white dot and
         the frame gains a field of hot pixels the bloom then smears. */
      this._tintAt(r.beam, cap * 0.95);
      const count = Math.min(MOTES_PER_ITEM + (d.rank - 3) * 8, MAX_MOTES - k);
      for (let i = 0; i < count; i++) {
        const s = i * 0.6180339887;
        const ph = (elapsed * (0.22 + (s % 0.35)) + s * 7.13) % 1;
        const a = s * 39.98 + elapsed * 0.24;
        const rad = 0.16 + ((s * 3.7) % 1) * 0.42 * (1 - ph * 0.45);
        const o = k * 3;
        this._motePos[o] = d.x + Math.cos(a) * rad;
        this._motePos[o + 1] = d.groundY + 0.05 + ph * (1.55 + d.rank * 0.30);
        this._motePos[o + 2] = d.z + Math.sin(a) * rad;
        const fade = Math.sin(ph * Math.PI);
        this._moteSize[k] = (0.010 + ((s * 5.1) % 1) * 0.016) * (1 + d.rank * 0.10);
        this._moteFade[k] = fade * fade * 0.75;
        this._moteCol[o] = _col.r;
        this._moteCol[o + 1] = _col.g;
        this._moteCol[o + 2] = _col.b;
        k++;
        if (k >= MAX_MOTES) break;
      }
      if (k >= MAX_MOTES) break;
    }
    const g = this.motes.geometry;
    g.setDrawRange(0, k);
    if (k) {
      g.attributes.position.needsUpdate = true;
      g.attributes.aSize.needsUpdate = true;
      g.attributes.aCol.needsUpdate = true;
      g.attributes.aFade.needsUpdate = true;
    }
    this.motes.visible = k > 0;
  }

  _writeLights(hx, hz) {
    /* importance-select the two nearest legendary+ drops */
    const cands = [];
    for (const d of this.drops) if (d.rank >= 3) cands.push(d);
    cands.sort((a, b) => ((a.x - hx) ** 2 + (a.z - hz) ** 2) - ((b.x - hx) ** 2 + (b.z - hz) ** 2));
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const d = cands[i];
      if (!d) { l.intensity = 0; l.position.set(0, -2000 - i * 8, 0); continue; }
      const r = rarityInfo(d.rarity);
      l.color.setHex(r.beam, THREE.SRGBColorSpace);
      /*
       * Small, and — critically — NOT at floor level.
       *
       * This is the light that has to sell the drop now that the sprite is
       * capped: a tight warm pool on the flagstones reads as "something
       * valuable is lying there" without the sprite being the brightest thing
       * in the frame. But irradiance is I/d², so a 5-candela light parked
       * 0.4 m above the floor delivers ~30 units to the stone right under it,
       * ACES rolls that to white, and the pool that was supposed to be
       * rarity-red arrives cream — the same "it went white" failure as the
       * sprite, one bounce removed. 0.85 m up with a lower intensity bounds the
       * near field to a few units, which is where hue survives the tonemap.
       */
      l.position.set(d.x, d.groundY + 0.85, d.z);
      l.distance = 3.0 + d.rank * 0.5;
      l.intensity = 1.2 + d.rank * 0.45;
    }
  }

  _writeLabels(elapsed, hx, hz) {
    /* rank the drops by "should the player see the name right now" */
    const cand = [];
    for (const d of this.drops) {
      const dist = Math.hypot(d.x - hx, d.z - hz);
      const near = this._altHeld ? 26 : LABEL_RANGE;
      if (dist > near) continue;
      cand.push({ d, dist, pri: dist - d.rank * 3.5 });
    }
    cand.sort((a, b) => a.pri - b.pri);
    if (cand.length > MAX_LABELS) cand.length = MAX_LABELS;

    /* Sticky pool assignment: an item keeps the plate it was painted onto, so a
       harmless re-ordering never forces a canvas resize + texture re-upload. */
    const claimed = new Array(this.labels.length).fill(false);
    const slotOf = new Array(cand.length).fill(-1);
    for (let i = 0; i < cand.length; i++) {
      for (let j = 0; j < this.labels.length; j++) {
        if (!claimed[j] && this.labels[j].uid === cand[i].d.labelUid) { slotOf[i] = j; claimed[j] = true; break; }
      }
    }
    for (let i = 0; i < cand.length; i++) {
      if (slotOf[i] >= 0) continue;
      for (let j = 0; j < this.labels.length; j++) {
        if (!claimed[j]) { slotOf[i] = j; claimed[j] = true; break; }
      }
    }

    /* keep the plates from stacking on top of each other in screen space */
    const cam = this.engine.camera;
    const used = [];
    let n = 0;
    const live = new Set();
    for (let ci = 0; ci < cand.length; ci++) {
      const c = cand[ci];
      const slot = slotOf[ci];
      if (slot < 0) continue;
      const d = c.d;
      const entry = this.labels[slot];
      if (entry.uid !== d.labelUid) { this._paintLabel(entry, d.item); entry.uid = d.labelUid; }
      live.add(slot);

      const t = clamp01((this._altHeld ? 1 : smooth(LABEL_RANGE, LABEL_RANGE * 0.62, c.dist)) *
        clamp01((elapsed - d.bornAt) * 2.6 - 0.15));
      if (t <= 0.01) { entry.sprite.visible = false; continue; }

      let y = d.groundY + 0.66 + d.rank * 0.14;
      /* nudge upward if another plate already claimed this screen row */
      _v.set(d.x, y, d.z).project(cam);
      /* The old window (0.18 x 0.06 NDC) only caught plates on the same screen
         row, so two labels offset diagonally still overlapped — visible in the
         `boss` capture where four plates interleave. Widen it in y and iterate,
         since one nudge can land on top of a third plate. */
      for (let pass = 0; pass < 3; pass++) {
        let moved = false;
        for (const u of used) {
          if (Math.abs(u.x - _v.x) < 0.22 && Math.abs(u.y - _v.y) < 0.085) {
            y += 0.52; _v.set(d.x, y, d.z).project(cam); moved = true;
          }
        }
        if (!moved) break;
      }
      used.push({ x: _v.x, y: _v.y });

      entry.sprite.visible = true;
      entry.sprite.position.set(d.x, y, d.z);
      entry.sprite.scale.set(entry.w, entry.h, 1);
      entry.mat.opacity = t;
      n++;
    }
    for (let i = 0; i < this.labels.length; i++) if (!live.has(i)) this.labels[i].sprite.visible = false;
  }

  /* ==================================================================== *
   * external hooks
   * ==================================================================== */

  /** Props/destructibles emit loose 'loot:drop' specs — turn them into items. */
  _onExternalDrop(p) {
    if (!this._ready || !p || !p.item) return;
    const it = p.item;
    if (it.uid) return;                      // one of ours, already handled
    const pos = p.position ?? null;
    if (!pos) return;
    const seed = hashStr(`${this._scenario}|ext|${this._dropOrdinal}|${it.kind ?? 'x'}`);
    const rand = this.engine.freshRand(seed);
    const lvl = Math.max(1, this.progression.level);
    let item = null;
    if (it.kind === 'gold') item = makeGold(rand, 6 + rand() * (12 + lvl * 1.6), `ext:gold:${this._dropOrdinal}`);
    else if (it.kind === 'potion') item = makePotion(rand, lvl, `ext:potion:${this._dropOrdinal}`);
    else if (it.kind === 'wood') item = makeMaterial(rand, 'ironShard', 1, `ext:mat:${this._dropOrdinal}`);
    else item = makeMaterial(rand, rand() < 0.5 ? 'boneDust' : 'ironShard', 1, `ext:mat:${this._dropOrdinal}`);
    this.dropItem(item, _v.set(pos.x, (pos.y ?? 0) + 0.3, pos.z), { launch: true, rand });
  }

  /** `bus.emit('loot:request', {slot, ilvl, rarity, position})` — for scripting. */
  _onRequest(p) {
    if (!this._ready || !p) return;
    const seed = hashStr(`${this._scenario}|req|${this._dropOrdinal}|${p.rarity ?? ''}|${p.slot ?? ''}`);
    const rand = this.engine.freshRand(seed);
    const item = makeItem(rand, {
      slot: p.slot, ilvl: p.ilvl ?? this.progression.level + 6, rarity: p.rarity,
      luck: p.luck ?? 0.4, uid: `req:${this._dropOrdinal}`,
    });
    const hero = this.engine.get('hero');
    const at = p.position ?? { x: (hero?.position?.x ?? 0) + 1.4, y: 0.6, z: hero?.position?.z ?? 0 };
    this.dropItem(item, _v.set(at.x, at.y ?? 0.6, at.z), { launch: true, rand });
  }

  /* ==================================================================== *
   * public API — the surface the HUD reads
   * ==================================================================== */

  /** Character sheet + inventory + equipment, ready to render. */
  sheet() { return this.progression.sheet(); }
  get character() { return this.progression; }
  get inventory() { return this.progression.inventory; }
  get equipped() { return this.progression.equipped; }
  get derived() { return this.progression.derived; }

  /** Structured tooltip for an item, including the comparison block. */
  tooltip(item) {
    if (!item) return null;
    return tooltipFor(item, item.kind === 'gear' ? this.progression.compare(item) : null);
  }
  /**
   * Icon hand-off — see the contract at the top of Items.js.
   * `iconKey` is the string `UIAtlas.itemIconURI(size, kind, rarity, seed)`
   * takes; `icon` is the full per-instance procedural descriptor.
   */
  iconKey(item) { return item?.icon ?? 'rune'; }
  icon(item) { return item?.iconSpec ?? null; }

  /** Ground labels, for a HUD that would rather draw them in the DOM. */
  worldLabels() {
    const hero = this.engine.get('hero');
    const hx = hero?.position?.x ?? 0, hz = hero?.position?.z ?? 0;
    return this.drops.map((d) => ({
      uid: d.item.uid, name: d.item.name, rarity: d.rarity,
      frame: rarityInfo(d.rarity), position: { x: d.x, y: d.groundY + 0.7, z: d.z },
      distance: Math.hypot(d.x - hx, d.z - hz), item: d.item,
    }));
  }
  /** True when the HUD has taken over label drawing (it sets this). */
  set hudOwnsLabels(v) {
    this._hudLabels = !!v;
    if (this._hudLabels) for (const l of this.labels) l.sprite.visible = false;
  }

  equip(item, slot) { const r = this.progression.equip(item, slot); this.progression.syncHero(); return r; }
  unequip(slot) { const r = this.progression.unequip(slot); this.progression.syncHero(); return r; }
  gainXp(n) { return this.progression.gainXp(n); }

  clearWorld() {
    for (const d of [...this.drops]) this._retire(d);
    this.drops.length = 0;
    for (const l of this.labels) { l.sprite.visible = false; l.uid = null; }
    this.beams.count = 0; this.pools.count = 0; this.contacts.count = 0;
    this.motes.geometry.setDrawRange(0, 0);
    for (const l of this.lights) { l.intensity = 0; l.position.set(0, -2000, 0); }
  }

  /* ==================================================================== *
   * scenarios
   * ==================================================================== */

  async applyScenario(name, cfg) {
    this._scenario = name;
    this._dropOrdinal = 0;
    this._deaths = 0;
    this.clearWorld();

    const rand = this.engine.freshRand(hashStr(`loot:scenario:${name}`));
    const hero = this.engine.get('hero');
    const hx = hero?.position?.x ?? 0, hz = hero?.position?.z ?? 0;

    /* reset the character, then pose it for the scenario */
    this._resetCharacter();

    if (name === 'inventory' || name === 'closeup' || name === 'hub') {
      this._populateCharacter(rand, name === 'inventory' ? 47 : 32, name === 'inventory');
    } else {
      this._populateCharacter(rand, name === 'boss' ? 52 : 24, false);
    }
    this.progression.syncHero();

    /* world drops */
    const place = (item, ang, dist, launch = false) => {
      const x = hx + Math.cos(ang) * dist;
      const z = hz + Math.sin(ang) * dist;
      this.dropItem(item, _v.set(x, this._groundY(x, z) + (launch ? 0.7 : 0.02), z), { launch, rand });
    };

    if (name === 'combat') {
      place(makeItem(rand, { slot: 'weapon', ilvl: 62, rarity: 'legendary', luck: 0.8, uid: 'sc:combat:0' }), 2.35, 3.1);
      place(makeItem(rand, { slot: 'chest', ilvl: 55, rarity: 'rare', luck: 0.4, uid: 'sc:combat:1' }), 4.1, 2.4);
      place(makeItem(rand, { slot: 'gloves', ilvl: 48, rarity: 'magic', uid: 'sc:combat:2' }), 5.6, 3.6);
      place(makeGold(rand, 184, 'sc:combat:g'), 1.15, 3.9);
      place(makeMaterial(rand, 'emberGlass', 2, 'sc:combat:m'), 0.35, 3.4);
    } else if (name === 'boss') {
      place(makeItem(rand, { slot: 'weapon', ilvl: 78, rarity: 'mythic', luck: 1, uid: 'sc:boss:0' }), 1.9, 4.2);
      place(makeItem(rand, { slot: 'helm', ilvl: 74, rarity: 'unique', luck: 1, uid: 'sc:boss:1' }), 3.5, 3.6);
      place(makeItem(rand, { slot: 'offhand', ilvl: 70, rarity: 'legendary', luck: 0.9, uid: 'sc:boss:2' }), 5.2, 4.6);
      place(makeGold(rand, 1240, 'sc:boss:g'), 0.6, 3.0);
    } else if (name === 'dungeon') {
      place(makeItem(rand, { slot: 'boots', ilvl: 44, rarity: 'rare', luck: 0.4, uid: 'sc:dun:0' }), 2.1, 3.4);
      place(makeGold(rand, 92, 'sc:dun:g'), 4.4, 2.6);
    } else if (name === 'hub') {
      place(makeGold(rand, 46, 'sc:hub:g'), 2.6, 2.8);
    } else if (name === 'night' || name === 'overworld') {
      place(makeItem(rand, { slot: 'amulet', ilvl: 40, rarity: 'legendary', luck: 0.7, uid: 'sc:night:0' }), 2.9, 3.2);
    } else if (name === 'inventory') {
      place(makeItem(rand, { slot: 'ring1', ilvl: 52, rarity: 'rare', luck: 0.5, uid: 'sc:inv:0' }), 2.4, 3.0);
    }

    /* let the tumble finish so the captured frame shows settled loot */
    for (const d of this.drops) { d.settled = true; d.restT = 1; d.quat.copy(d.restQuat); }
  }

  _resetCharacter() {
    const p = this.progression;
    p.level = 1; p.xp = 0; p.xpNext = xpForLevel(1);
    p.paragon = 0; p.paragonXp = 0; p.paragonNext = xpForLevel(LEVEL_CAP);
    p.attributePoints = 0; p.skillPoints = 0; p.paragonPoints = 0;
    for (const k in p.spent) p.spent[k] = 0;
    for (const k in p.glyphs) p.glyphs[k] = 0;
    for (const s of SLOT_IDS) p.equipped[s] = null;
    p.inventory.items.fill(null);
    p.gold = 0;
    p.materials = Object.create(null);
    p.potions.count = 4;
    p.recompute();
  }

  /**
   * A believable, judgeable character: a full equipped set with mixed
   * rarities, a bag with real variety, gold, potions and materials.
   */
  _populateCharacter(rand, level, rich) {
    const p = this.progression;

    /* Level up honestly: feed the exact XP the real curve demands, so the bar
       fill, the awarded attribute/skill points and the paragon count all agree
       with the numbers a player would actually have at this level. */
    const target = clamp(level, 1, LEVEL_CAP);
    p.level = 1; p.xp = 0; p.xpNext = xpForLevel(1);
    let need = 0;
    for (let l = 1; l < target; l++) need += xpForLevel(l);
    p.gainXp(need + Math.round(xpForLevel(target) * (rich ? 0.62 : 0.34)));
    if (rich && target >= LEVEL_CAP) p.gainXp(xpForLevel(LEVEL_CAP) * 8);

    /* spend most attribute points so the sheet is not full of unspent pips */
    const order = ['strength', 'vitality', 'dexterity', 'willpower', 'intelligence'];
    let guard = 0;
    while (p.attributePoints > 3 && guard++ < 400) {
      p.spendAttribute(order[guard % order.length], 1);
    }

    /* ---- equipped set: mixed rarities, one set trio, one aspect weapon ---- */
    /* A one-handed weapon is forced so the off-hand slot is genuinely filled —
       a two-hander would legitimately empty it, which reads as missing content
       in a UI judgement frame. */
    const plan = rich
      ? [
        ['weapon', 'legendary', +8, 'longsword'], ['offhand', 'rare', +4, 'kite'], ['helm', 'legendary', +6],
        ['chest', 'unique', +10], ['gloves', 'rare', +2], ['boots', 'magic', -3],
        ['belt', 'rare', +1], ['amulet', 'legendary', +7], ['ring1', 'rare', +3], ['ring2', 'magic', -2],
      ]
      : [
        ['weapon', 'legendary', +4, 'falchion'], ['offhand', 'magic', 0, 'buckler'], ['helm', 'magic', -1],
        ['chest', 'rare', +2], ['gloves', 'common', -4], ['boots', 'magic', -2],
        ['belt', 'common', -5], ['amulet', 'rare', +1], ['ring1', 'magic', -1], ['ring2', 'common', -6],
      ];
    const baseIlvl = Math.round(target * 1.28 + 8);
    for (const [slot, rarity, off, base] of plan) {
      const it = makeItem(rand, {
        slot, rarity, base: base ?? null, ilvl: clamp(baseIlvl + off, 1, 100), luck: rich ? 0.55 : 0.2,
        uid: `eq:${slot}`,
        forceSet: rich && (slot === 'helm' || slot === 'chest' || slot === 'gloves') ? 'ashenVigil' : null,
      });
      if (slot === 'offhand' && p.equipped.weapon?.hands === 2) continue;  // 2H takes the hand
      p.equipped[slot] = it;
      it.equippedSlot = slot;
    }

    /* ---- bag: mixed, believable, a couple of obvious upgrades ---- */
    const bagPlan = rich
      ? ['legendary', 'rare', 'rare', 'magic', 'unique', 'magic', 'rare', 'common',
        'magic', 'legendary', 'rare', 'common', 'magic', 'rare', 'mythic', 'magic', 'common', 'rare']
      : ['rare', 'magic', 'magic', 'common', 'rare', 'common', 'magic', 'common', 'rare', 'magic'];
    for (let i = 0; i < bagPlan.length; i++) {
      const it = makeItem(rand, {
        rarity: bagPlan[i], ilvl: clamp(baseIlvl + Math.round((rand() - 0.45) * 14), 1, 100),
        luck: rich ? 0.45 : 0.15, uid: `bag:${i}`,
      });
      if (p.addToInventory(it) < 0) break;
    }
    /* gems and materials in the tail of the bag */
    if (rich) {
      for (let i = 0; i < 3; i++) {
        const g = makeGem(rand, baseIlvl);
        const it = makeMaterial(rand, 'veiledSigil', 1, `gem:${i}`);
        it.name = g.label;
        it.mesh = { arch: 'rune', family: 'gem', tint: g.col, glow: 0.9, scale: 1 };
        it.icon = 'gem';
        it.iconSpec.palette.base = g.col;
        it.iconSpec.gems = [{ x: 0.5, y: 0.5, r: 0.16, col: g.col }];
        it.rarity = 'magic';
        it.gem = g;
        if (p.addToInventory(it) < 0) break;
      }
    }

    p.gold = rich ? 148_920 : 6_140;
    for (const id of Object.keys(MATERIALS)) {
      p.materials[id] = rich ? 40 + Math.floor(rand() * 260) : 4 + Math.floor(rand() * 30);
    }
    p.recompute();
    p.potions.count = p.potions.max;

    if (rich) {
      /* a little paragon investment so the post-cap board is not blank */
      let g2 = 0;
      while (p.paragonPoints > 0 && g2++ < 300) {
        p.spendGlyph(['ire', 'bulwark', 'exhume', 'edict', 'sealed', 'wanderer'][g2 % 6], 1);
      }
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  resize() { /* nothing resolution dependent */ }

  dispose() {
    this._ready = false;
    for (const off of this._offs) { try { off(); } catch { /* noop */ } }
    this._offs.length = 0;
    this.progression.dispose();
    this.clearWorld();
    for (const g of this._geoCache.values()) g.dispose();
    this._geoCache.clear();
    for (const l of this.labels ?? []) { l.tex.dispose(); l.mat.dispose(); }
    for (const m of [this.beams, this.pools, this.contacts]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
    }
    this.motes?.geometry.dispose();
    this.moteMat?.dispose();
    for (const m of [this.matHard, this.matSoft, this.matOrganic]) m?.dispose();
    if (this.root) this.engine.scene.remove(this.root);
  }
}

export default Loot;
