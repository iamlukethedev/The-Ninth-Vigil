/**
 * THE NINTH VIGIL — NPCs: the townsfolk.
 *
 * The `hub` scenario asks for `spawn.npcs: 6` and nothing was answering, because
 * Bestiary only knows how to build monsters. This module fills that slot, and it
 * does so on the EXISTING character pipeline rather than inventing a third one:
 *
 *   Skeleton.js  `buildHeroRig()`   — the canonical 1.85 m humanoid rig, whose
 *                                     bones all have identity rest rotations, so
 *                                     a pose can be authored as plain
 *                                     world-aligned Euler angles.
 *   AnimGraph.js `rigView()`        — the adapter that lets RigKit's skinner
 *                                     consume a Skeleton.js rig.
 *   RigKit.js    `SkinBuilder`      — tube/rigid/ribbon skinning with UVs in
 *                                     metres, exactly as the bestiary uses it.
 *
 * What is authored here is the *wardrobe*, because that is what makes a
 * townsperson read at 30 m: a robed priest, an aproned smith with a barrel
 * chest, a hooded beggar folded in on himself, a mailed guard with a spear.
 * Silhouette does the work; faces are four pixels.
 *
 * Budget: each townsperson is ONE skinned mesh on ONE shared material (two
 * samplers — albedo + normal; roughness and metalness are routed from the
 * skinner's `aMask` attribute in a small shader injection). Nine townsfolk cost
 * nine draw calls.
 *
 * Determinism: geometry and every idle phase are pure functions of a seed and
 * `engine.clock.elapsed`. No Math.random, no Date.now.
 */

import * as THREE from 'three';
import { buildHeroRig } from './Skeleton.js';
import { rigView } from './AnimGraph.js';
import { SkinBuilder, roundedBox, sweepGeo, mergeGeos } from './monsters/RigKit.js';

const PI = Math.PI;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** aMask channels the shader reads: cloth / skin / leather / metal. */
const M_CLOTH = 0.0, M_SKIN = 0.34, M_LEATHER = 0.67, M_METAL = 1.0;

/* ------------------------------------------------------------------ *
 * wardrobe
 * ------------------------------------------------------------------ */

/**
 * `girth` scales every body radius (a well-fed merchant vs a starved beggar),
 * `stoop` bends the spine forward, and the garment flags decide the silhouette.
 * Palette entries are linear albedo multipliers on a shared cloth texture, so
 * the whole cast stays in the desaturated cold-plus-one-warm bracket the art
 * direction asks for.
 */
const ARCHETYPES = {
  smith: {
    scale: 1.00, girth: 1.20, stoop: 0.10, seed: 4101,
    skin: [1.05, 0.80, 0.66], cloth: [0.46, 0.42, 0.40], trim: [0.60, 0.52, 0.44],
    leather: [0.72, 0.50, 0.32], metal: [0.72, 0.72, 0.75],
    apron: true, sleeves: 'short', belt: true, cap: 'coif', boots: true,
    tool: 'hammer',
  },
  merchant: {
    scale: 0.99, girth: 1.16, stoop: 0.04, seed: 4207,
    skin: [1.02, 0.80, 0.68], cloth: [0.56, 0.34, 0.36], trim: [1.05, 0.86, 0.42],
    leather: [0.55, 0.40, 0.30], metal: [1.0, 0.84, 0.42],
    robe: 0.62, sleeves: 'long', belt: true, cap: 'chaperon', boots: true,
    tool: 'ledger',
  },
  guard: {
    scale: 1.03, girth: 1.06, stoop: 0.0, seed: 4311,
    skin: [1.0, 0.79, 0.66], cloth: [0.34, 0.36, 0.42], trim: [0.62, 0.26, 0.24],
    leather: [0.46, 0.36, 0.28], metal: [0.80, 0.80, 0.84],
    gambeson: true, sleeves: 'long', belt: true, cap: 'kettle', boots: true,
    pauldrons: true, tool: 'spear',
  },
  beggar: {
    scale: 0.93, girth: 0.86, stoop: 0.34, seed: 4423,
    skin: [0.92, 0.74, 0.62], cloth: [0.36, 0.33, 0.30], trim: [0.30, 0.28, 0.26],
    leather: [0.38, 0.32, 0.26], metal: [0.5, 0.5, 0.5],
    robe: 0.86, hood: true, sleeves: 'long', tattered: true, barefoot: true,
    tool: 'bowl',
  },
  priest: {
    scale: 1.01, girth: 0.98, stoop: 0.08, seed: 4533,
    skin: [1.0, 0.82, 0.72], cloth: [0.30, 0.29, 0.36], trim: [1.0, 0.82, 0.40],
    leather: [0.40, 0.34, 0.30], metal: [1.0, 0.86, 0.46],
    robe: 1.0, hood: true, sleeves: 'wide', belt: true, stole: true,
    tool: 'censer',
  },
  villager: {
    scale: 0.97, girth: 1.0, stoop: 0.06, seed: 4641,
    skin: [1.0, 0.80, 0.68], cloth: [0.44, 0.42, 0.36], trim: [0.52, 0.44, 0.36],
    leather: [0.48, 0.38, 0.30], metal: [0.6, 0.6, 0.62],
    robe: 0.46, sleeves: 'long', belt: true, boots: true, cap: 'hood',
  },
  villagerB: {
    scale: 0.94, girth: 0.96, stoop: 0.03, seed: 4759,
    skin: [1.02, 0.82, 0.70], cloth: [0.38, 0.40, 0.46], trim: [0.56, 0.46, 0.40],
    leather: [0.44, 0.36, 0.30], metal: [0.6, 0.6, 0.62],
    robe: 0.78, sleeves: 'long', belt: true, boots: true, kerchief: true,
  },
  porter: {
    scale: 1.00, girth: 1.04, stoop: 0.20, seed: 4867,
    skin: [1.0, 0.79, 0.65], cloth: [0.42, 0.38, 0.34], trim: [0.50, 0.42, 0.34],
    leather: [0.52, 0.40, 0.30], metal: [0.6, 0.6, 0.62],
    robe: 0.40, sleeves: 'short', belt: true, boots: true, tool: 'sack',
  },
};

/* ------------------------------------------------------------------ *
 * skin
 * ------------------------------------------------------------------ */

/**
 * Build one townsperson's geometry. Everything lands in a single SkinBuilder, so
 * the whole figure — flesh, wool, leather, mail and their tool — is one buffer
 * and one draw call, with `aMask` telling the shader which surface is which.
 */
function buildSkin(view, A, seed) {
  const sb = new SkinBuilder(view, seed);
  const g = A.girth;
  const colOf = (rgb, shade = 1) => () => [rgb[0] * shade, rgb[1] * shade, rgb[2] * shade];
  const R = (n) => view.restOf(n, new THREE.Vector3());

  /* ---------------- flesh underbody ---------------- */
  // torso: elliptical section, wider at the chest than it is deep
  sb.tube([
    { j: 'pelvis', off: [0, -0.06, 0], r: 0.148 * g, sx: 1.14, sz: 0.84 },
    { j: 'spine1', r: 0.152 * g, sx: 1.10, sz: 0.80 },
    { j: 'spine2', r: 0.166 * g, sx: 1.14, sz: 0.78 },
    { j: 'spine3', r: 0.158 * g, sx: 1.22, sz: 0.74 },
    { j: 'neck', off: [0, -0.02, 0], r: 0.085, sx: 1.0, sz: 1.0 },
  ], { seg: 11, ringsPer: 3, uvScale: 0.34, noise: 0.05, noiseFreq: 3.4, color: colOf(A.cloth), mask: M_CLOTH, stiff: 0.15 });

  // neck + head
  sb.tube([
    { j: 'neck', off: [0, -0.03, 0], r: 0.062, sx: 1.05, sz: 0.95 },
    { j: 'head', off: [0, -0.02, 0], r: 0.070 },
  ], { seg: 9, ringsPer: 2, uvScale: 0.3, color: colOf(A.skin), mask: M_SKIN });
  {
    const skull = roundedBox(0.168, 0.216, 0.196, 0.075, 3);
    sb.rigid(skull, 'head', { at: 'head', off: [0, 0.072, 0.006], uvScale: 0.28, color: colOf(A.skin), mask: M_SKIN });
    // brow + jaw, so the head is not an egg
    sb.rigid(roundedBox(0.152, 0.05, 0.04, 0.018), 'head', { at: 'head', off: [0, 0.115, 0.096], uvScale: 0.24, color: colOf(A.skin, 0.92), mask: M_SKIN });
    sb.rigid(roundedBox(0.116, 0.072, 0.062, 0.026), 'head', { at: 'head', off: [0, 0.028, 0.082], uvScale: 0.24, color: colOf(A.skin, 0.95), mask: M_SKIN });
    // eye sockets read as two dark notches at this distance, which is all we need
    for (const s of [-1, 1]) {
      sb.rigid(roundedBox(0.036, 0.022, 0.02, 0.008), 'head', { at: 'head', off: [s * 0.042, 0.086, 0.098], uvScale: 0.2, color: () => [0.14, 0.12, 0.12], mask: M_SKIN });
    }
    // hair / stubble cap
    if (!A.hood && A.cap !== 'kettle') {
      const hair = roundedBox(0.176, 0.15, 0.20, 0.07, 2);
      sb.rigid(hair, 'head', { at: 'head', off: [0, 0.106, -0.012], uvScale: 0.22, color: () => [0.16, 0.13, 0.11], mask: M_CLOTH });
    }
  }

  /* ---------------- arms ---------------- */
  for (const s of ['_L', '_R']) {
    const sleeve = A.sleeves === 'short' ? 0.45 : 1.0;
    // the limb itself
    sb.tube([
      { j: `upperArm${s}`, off: [0, 0.02, 0], r: 0.062 * g },
      { j: `lowerArm${s}`, r: 0.050 * g },
      { j: `hand${s}`, r: 0.040 },
      { j: `handEnd${s}`, off: [0, 0.01, 0], r: 0.030 },
    ], { seg: 9, ringsPer: 3, uvScale: 0.28, noise: 0.05, color: colOf(A.skin), mask: M_SKIN });
    // the sleeve over it
    const wide = A.sleeves === 'wide';
    sb.tube([
      { j: `upperArm${s}`, off: [0, 0.06, 0], r: 0.082 * g },
      { j: `lowerArm${s}`, off: [0, lerp(0.16, 0, sleeve), 0], r: (wide ? 0.11 : 0.066) * g, bind: `upperArm${s}` },
      ...(sleeve > 0.7
        ? [{ j: `hand${s}`, off: [0, 0.09, 0], r: (wide ? 0.15 : 0.058) * g, bind: `lowerArm${s}` }]
        : []),
    ], { seg: 9, ringsPer: 3, uvScale: 0.3, noise: 0.07, noiseFreq: 5, color: colOf(A.cloth, 1.06), mask: M_CLOTH, capEnd: 'flat' });
    // hand: a mitten mass rather than fingers — fingers at 30 m are noise
    sb.rigid(roundedBox(0.058, 0.098, 0.078, 0.03), `hand${s}`, { at: `hand${s}`, off: [s === '_L' ? 0.012 : -0.012, -0.05, 0.014], uvScale: 0.22, color: colOf(A.skin, 0.96), mask: M_SKIN });
    if (A.pauldrons) {
      const p = roundedBox(0.15, 0.09, 0.16, 0.04, 2);
      sb.rigid(p, `upperArm${s}`, { at: `upperArm${s}`, off: [0, 0.02, 0], uvScale: 0.22, color: colOf(A.metal), mask: M_METAL });
    }
  }

  /* ---------------- legs ---------------- */
  for (const s of ['_L', '_R']) {
    sb.tube([
      { j: `thigh${s}`, off: [0, 0.02, 0], r: 0.098 * g },
      { j: `shin${s}`, r: 0.070 * g },
      { j: `foot${s}`, off: [0, 0.02, 0], r: 0.052 },
    ], { seg: 9, ringsPer: 3, uvScale: 0.3, noise: 0.04, color: colOf(A.barefoot ? A.skin : A.cloth, 0.94), mask: A.barefoot ? M_SKIN : M_CLOTH });
    // foot: a wedge, toe raised
    const foot = roundedBox(0.088, 0.062, 0.24, 0.028, 2);
    sb.rigid(foot, `foot${s}`, {
      at: `foot${s}`, off: [0, -0.022, 0.062], rot: [-0.10, 0, 0], uvScale: 0.24,
      color: colOf(A.barefoot ? A.skin : A.leather, 0.9), mask: A.barefoot ? M_SKIN : M_LEATHER,
    });
    if (A.boots) {
      sb.tube([
        { j: `shin${s}`, off: [0, 0.06, 0], r: 0.086, bind: `shin${s}` },
        { j: `foot${s}`, off: [0, 0.05, 0], r: 0.072, bind: `shin${s}` },
      ], { seg: 8, ringsPer: 2, uvScale: 0.26, color: colOf(A.leather), mask: M_LEATHER, capEnd: 'flat' });
    }
  }

  /* ---------------- garments ---------------- */
  if (A.robe || A.gambeson) {
    // A skirt/robe: one tube around both legs, rigidly bound to the pelvis, so it
    // swings with the hips instead of shrink-wrapping the thighs.
    const hem = A.robe ? lerp(1.02, 0.10, 1 - A.robe) : 0.62;      // 0..1 of leg length
    const pelvis = R('pelvis');
    const footY = R('foot_L').y;
    const y0 = pelvis.y + 0.30;
    const y1 = lerp(pelvis.y, footY + 0.03, hem);
    const chain = [];
    const N = 5;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const y = lerp(y0, y1, t);
      chain.push({
        p: [0, y, 0.004 * (1 - t)],
        r: lerp(0.20 * g, (A.robe ? 0.31 : 0.25) * g, Math.pow(t, 0.7)),
        sx: lerp(1.10, 1.0, t), sz: lerp(0.86, 1.0, t),
        bind: i < 2 ? 'pelvis' : 'pelvis',
      });
    }
    sb.tube(chain, {
      seg: 13, ringsPer: 3, uvScale: 0.36, noise: A.tattered ? 0.16 : 0.09, noiseFreq: 4.2,
      color: colOf(A.cloth), mask: M_CLOTH, stiff: 1, capEnd: 'none',
      profile: (a) => 1 + 0.05 * Math.sin(a * 7),
    });
    // a shoulder cape / upper body layer so the robe is not a bare cylinder
    sb.tube([
      { j: 'spine3', off: [0, 0.07, 0], r: 0.20 * g, sx: 1.18, sz: 0.86 },
      { j: 'spine2', off: [0, -0.02, 0], r: 0.215 * g, sx: 1.14, sz: 0.86 },
      { j: 'spine1', off: [0, -0.06, 0], r: 0.20 * g, sx: 1.10, sz: 0.86 },
    ], { seg: 12, ringsPer: 3, uvScale: 0.34, noise: 0.10, noiseFreq: 4, color: colOf(A.cloth, 0.92), mask: M_CLOTH, capEnd: 'none', capStart: 'none' });
  }

  if (A.apron) {
    // a heavy leather apron: a wide slab down the front, curling at the hem
    const pts = [
      { j: 'spine2', off: [0, 0.02, 0.14], w: 0.16 },
      { j: 'spine1', off: [0, 0.0, 0.165], w: 0.20, bind: 'spine1' },
      { p: [0, 0.86, 0.175], w: 0.23, bind: 'pelvis' },
      { p: [0, 0.60, 0.185], w: 0.24, bind: 'pelvis' },
      { p: [0, 0.40, 0.16], w: 0.21, bind: 'pelvis' },
    ];
    sb.ribbon(pts, { ringsPer: 3, uvScale: 0.36, thick: 0.02, axis: [1, 0, 0], color: colOf(A.leather), mask: M_LEATHER });
    // the neck strap
    for (const s of [-1, 1]) {
      sb.ribbon([
        { j: 'spine3', off: [s * 0.06, 0.10, 0.02], w: 0.028 },
        { j: 'spine2', off: [s * 0.10, 0.03, 0.13], w: 0.028, bind: 'spine2' },
      ], { ringsPer: 2, uvScale: 0.2, thick: 0.012, axis: [0, 0, 1], color: colOf(A.leather, 0.9), mask: M_LEATHER });
    }
  }

  if (A.stole) {
    // a priest's stole: two embroidered bands down the front
    for (const s of [-1, 1]) {
      sb.ribbon([
        { j: 'spine3', off: [s * 0.09, 0.06, 0.03], w: 0.045 },
        { j: 'spine2', off: [s * 0.12, 0.0, 0.13], w: 0.05, bind: 'spine2' },
        { p: [s * 0.13, 0.92, 0.16], w: 0.05, bind: 'pelvis' },
        { p: [s * 0.13, 0.58, 0.16], w: 0.046, bind: 'pelvis' },
      ], { ringsPer: 3, uvScale: 0.24, thick: 0.012, axis: [1, 0, 0], color: colOf(A.trim), mask: M_CLOTH });
    }
  }

  if (A.hood) {
    // a cowl: a tube around the neck flaring over the skull, plus a point at the back
    sb.tube([
      { j: 'spine3', off: [0, 0.10, 0], r: 0.185 * g, sx: 1.15, sz: 0.95, bind: 'spine3' },
      { j: 'neck', off: [0, 0.04, 0], r: 0.150, bind: 'neck' },
      { j: 'head', off: [0, 0.03, -0.02], r: 0.150, bind: 'head' },
      { j: 'head', off: [0, 0.15, -0.03], r: 0.132, bind: 'head' },
      { j: 'head', off: [0.0, 0.225, -0.10], r: 0.055, bind: 'head' },
    ], { seg: 12, ringsPer: 3, uvScale: 0.32, noise: 0.11, noiseFreq: 4.6, color: colOf(A.cloth, 0.88), mask: M_CLOTH, capEnd: 'round', capStart: 'none' });
    // the shadowed opening
    sb.rigid(roundedBox(0.14, 0.13, 0.03, 0.012), 'head', { at: 'head', off: [0, 0.075, 0.115], uvScale: 0.2, color: () => [0.07, 0.06, 0.06], mask: M_CLOTH });
  }

  if (A.cap === 'kettle') {
    // a kettle helm: a shallow dome and a wide brim
    sb.rigid(roundedBox(0.208, 0.13, 0.216, 0.09, 3), 'head', { at: 'head', off: [0, 0.125, 0.0], uvScale: 0.22, color: colOf(A.metal), mask: M_METAL });
    const brim = new THREE.TorusGeometry(0.135, 0.028, 5, 16);
    brim.rotateX(PI * 0.5);
    brim.scale(1, 1, 1.05);
    sb.rigid(brim, 'head', { at: 'head', off: [0, 0.078, 0.006], uvScale: 0.2, color: colOf(A.metal, 0.92), mask: M_METAL });
    // mail coif under it
    sb.tube([
      { j: 'head', off: [0, 0.04, 0], r: 0.108, bind: 'head' },
      { j: 'neck', off: [0, 0.0, 0], r: 0.115, bind: 'neck' },
      { j: 'spine3', off: [0, 0.09, 0], r: 0.165, bind: 'spine3' },
    ], { seg: 10, ringsPer: 2, uvScale: 0.16, color: colOf(A.metal, 0.62), mask: M_METAL, capEnd: 'none', capStart: 'none' });
  } else if (A.cap === 'coif') {
    sb.tube([
      { j: 'head', off: [0, 0.16, -0.01], r: 0.055, bind: 'head' },
      { j: 'head', off: [0, 0.09, -0.01], r: 0.105, bind: 'head' },
      { j: 'head', off: [0, 0.02, -0.01], r: 0.108, bind: 'head' },
    ], { seg: 10, ringsPer: 2, uvScale: 0.2, color: colOf(A.trim, 0.8), mask: M_CLOTH, capEnd: 'round', capStart: 'none' });
  } else if (A.cap === 'chaperon') {
    // a rolled hood worn as a hat, with a liripipe hanging down the back
    const t = new THREE.TorusGeometry(0.115, 0.052, 6, 14);
    t.rotateX(PI * 0.5);
    sb.rigid(t, 'head', { at: 'head', off: [0, 0.135, -0.01], uvScale: 0.22, color: colOf(A.trim, 0.85), mask: M_CLOTH });
    sb.ribbon([
      { j: 'head', off: [0.02, 0.13, -0.11], w: 0.05 },
      { j: 'head', off: [0.05, -0.02, -0.16], w: 0.045, bind: 'neck' },
      { j: 'spine3', off: [0.08, -0.05, -0.16], w: 0.04, bind: 'spine3' },
    ], { ringsPer: 3, uvScale: 0.2, thick: 0.012, axis: [1, 0, 0], color: colOf(A.trim, 0.8), mask: M_CLOTH });
  } else if (A.cap === 'hood') {
    sb.tube([
      { j: 'spine3', off: [0, 0.11, -0.04], r: 0.175 * g, sx: 1.1, sz: 1.0, bind: 'spine3' },
      { j: 'neck', off: [0, 0.02, -0.06], r: 0.135, bind: 'neck' },
      { j: 'head', off: [0, 0.0, -0.14], r: 0.10, bind: 'head' },
    ], { seg: 10, ringsPer: 2, uvScale: 0.3, noise: 0.12, color: colOf(A.cloth, 0.86), mask: M_CLOTH, capEnd: 'round', capStart: 'none' });
  } else if (A.kerchief) {
    sb.tube([
      { j: 'head', off: [0, 0.15, 0.0], r: 0.07, bind: 'head' },
      { j: 'head', off: [0, 0.09, 0.0], r: 0.115, bind: 'head' },
      { j: 'head', off: [0, 0.03, -0.02], r: 0.118, bind: 'head' },
    ], { seg: 10, ringsPer: 2, uvScale: 0.24, color: colOf(A.trim, 1.15), mask: M_CLOTH, capEnd: 'round', capStart: 'none' });
  }

  if (A.belt) {
    const b = new THREE.TorusGeometry(0.19 * g, 0.030, 5, 16);
    b.rotateX(PI * 0.5);
    b.scale(1.1, 1, 0.88);
    sb.rigid(b, 'pelvis', { at: 'pelvis', off: [0, 0.10, 0], uvScale: 0.2, color: colOf(A.leather), mask: M_LEATHER });
    sb.rigid(roundedBox(0.062, 0.056, 0.03, 0.012), 'pelvis', { at: 'pelvis', off: [0, 0.10, 0.175 * g], uvScale: 0.18, color: colOf(A.metal, 0.9), mask: M_METAL });
    // a pouch and a hanging strap end
    sb.rigid(roundedBox(0.10, 0.12, 0.06, 0.026), 'pelvis', { at: 'pelvis', off: [0.17 * g, 0.02, 0.09], uvScale: 0.2, color: colOf(A.leather, 0.86), mask: M_LEATHER });
  }

  /* ---------------- tool of trade ---------------- */
  if (A.tool === 'hammer') {
    const shaft = sweepGeo(
      [new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(0, 0.20, 0), new THREE.Vector3(0, 0.42, 0)],
      [0.017, 0.019, 0.021], { seg: 7 }
    );
    sb.rigid(shaft, 'hand_R', { at: 'hand_R', off: [-0.012, -0.06, 0.02], rot: [-1.35, 0, 0], uvScale: 0.2, color: colOf(A.leather, 1.1), mask: M_LEATHER });
    sb.rigid(roundedBox(0.075, 0.075, 0.20, 0.02), 'hand_R', { at: 'hand_R', off: [-0.012, 0.02, 0.44], rot: [0, 0, 0], uvScale: 0.2, color: colOf(A.metal, 0.85), mask: M_METAL });
  } else if (A.tool === 'spear') {
    const shaft = sweepGeo(
      [new THREE.Vector3(0, -1.05, 0), new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, 1.28, 0)],
      [0.019, 0.021, 0.018], { seg: 7 }
    );
    sb.rigid(shaft, 'hand_R', { at: 'hand_R', off: [0.0, 0.02, 0.04], uvScale: 0.24, color: colOf(A.leather, 1.15), mask: M_LEATHER });
    const head = sweepGeo(
      [new THREE.Vector3(0, 1.26, 0), new THREE.Vector3(0, 1.40, 0), new THREE.Vector3(0, 1.60, 0)],
      [0.032, 0.042, 0.004], { seg: 6 }
    );
    sb.rigid(head, 'hand_R', { at: 'hand_R', off: [0.0, 0.02, 0.04], uvScale: 0.2, color: colOf(A.metal), mask: M_METAL });
  } else if (A.tool === 'censer') {
    const chain = sweepGeo(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.01, -0.16, 0.01), new THREE.Vector3(0, -0.30, 0)],
      [0.006, 0.006, 0.006], { seg: 5 }
    );
    sb.rigid(chain, 'hand_R', { at: 'hand_R', off: [0, -0.05, 0.03], uvScale: 0.14, color: colOf(A.metal, 0.8), mask: M_METAL });
    sb.rigid(roundedBox(0.10, 0.12, 0.10, 0.045, 2), 'hand_R', { at: 'hand_R', off: [0, -0.40, 0.03], uvScale: 0.16, color: colOf(A.metal), mask: M_METAL });
  } else if (A.tool === 'bowl') {
    const bowl = roundedBox(0.13, 0.055, 0.13, 0.026, 2);
    sb.rigid(bowl, 'hand_L', { at: 'hand_L', off: [0.02, -0.05, 0.05], uvScale: 0.16, color: colOf(A.metal, 0.55), mask: M_METAL });
  } else if (A.tool === 'ledger') {
    sb.rigid(roundedBox(0.17, 0.21, 0.045, 0.012), 'hand_L', { at: 'hand_L', off: [0.02, -0.04, 0.10], rot: [0.5, 0, 0], uvScale: 0.2, color: colOf(A.leather, 1.2), mask: M_LEATHER });
  } else if (A.tool === 'sack') {
    // a sack over the shoulder — the porter's whole silhouette hangs off this
    const s = roundedBox(0.34, 0.42, 0.30, 0.13, 3);
    sb.rigid(s, 'spine3', { at: 'spine3', off: [-0.24, 0.16, -0.08], rot: [0.2, 0, 0.3], uvScale: 0.3, color: colOf(A.trim, 0.9), mask: M_CLOTH });
  }

  const geo = sb.build({ boundsPad: 2.2 });
  return geo;
}

/* ------------------------------------------------------------------ *
 * material
 * ------------------------------------------------------------------ */

const NPC_V_DECL = /* glsl */`
attribute float aMask;
varying float vNpcMask;
`;
const NPC_F_DECL = /* glsl */`
varying float vNpcMask;
`;
/**
 * `aMask` routes the four surface families through one material. Coupling
 * roughness to the family is what stops wool, skin, hide and steel all reading
 * as the same plastic — and it costs zero extra texture units, which matters
 * because the frame only has sixteen.
 */
const NPC_F_BODY = /* glsl */`
	{
		float m = vNpcMask;
		float rg = mix( 0.96, 0.60, smoothstep( 0.0, 0.34, m ) );
		rg = mix( rg, 0.70, smoothstep( 0.34, 0.67, m ) );
		rg = mix( rg, 0.33, smoothstep( 0.67, 1.0, m ) );
		roughnessFactor = rg;
		metalnessFactor = smoothstep( 0.74, 1.0, m ) * 0.88;
	}
`;

function makeNPCMaterial(engine) {
  let maps = null;
  try { maps = engine.assets?.pbr?.({ kind: 'cloth', size: 512, seed: 43, tiling: 1 / 0.34 }) ?? null; }
  catch { maps = null; }
  const mat = new THREE.MeshStandardMaterial({
    /*
     * Albedo lift, same trick and the same reason as the town's own bank. The
     * archetype palettes are authored as linear multipliers around 0.3-0.5, the
     * skinner then bakes a cavity term into vertex colour on top, and the hub's
     * dusk key is a 2.1-intensity sun pointing at the lens — so a townsperson
     * measured out at roughly 0.05 luminance and simply vanished into the
     * cobbles. 1.38 puts a wool cloak near 0.2 and an apron near 0.34, which is
     * where a figure reads as a silhouette at 26 m without going chalky.
     */
    color: new THREE.Color(1.38, 1.38, 1.38),
    map: maps?.map ?? null,
    normalMap: maps?.normalMap ?? null,
    roughness: 1, metalness: 0,
    vertexColors: true, dithering: true,
    // Cool sky fill is the only thing separating an unlit back from the ground.
    envMapIntensity: 1.15,
  });
  // Sampler diet: albedo + normal only. Roughness/metalness come from aMask and
  // the cavity term is already baked into vertex colour by the skinner.
  if (mat.normalScale) mat.normalScale.set(0.75, 0.75);
  mat.name = 'town.npc';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = NPC_V_DECL + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvNpcMask = aMask;'
    );
    shader.fragmentShader = NPC_F_DECL + shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>\n${NPC_F_BODY}`
    );
  };
  mat.customProgramCacheKey = () => 'town.npc';
  return mat;
}

/* ------------------------------------------------------------------ *
 * module
 * ------------------------------------------------------------------ */

export class NPCs {
  static id = 'npcs';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.ready = false;
    this.list = [];
    this.material = null;
    this.holder = new THREE.Object3D();     // identity forever — skins live here
    this.holder.name = 'npcSkins';
    this.holder.matrixAutoUpdate = false;
    this.rigs = new THREE.Object3D();
    this.rigs.name = 'npcRigs';
    this._cache = new Map();
  }

  async init() {
    this.engine.scene.add(this.holder);
    this.engine.scene.add(this.rigs);
    this.material = makeNPCMaterial(this.engine);
    try { this.engine.get('lighting')?.registerMaterial?.(this.material); } catch { /* optional */ }
    this.ready = true;
  }

  /** Town hands us its plan; every entry already has a role and a reason. */
  populate(plan, cfg = {}) {
    if (!this.ready || !plan) return 0;
    this.clear();
    const want = clamp(cfg?.spawn?.npcs ?? plan.npcs.length, 0, plan.npcs.length);
    const terrain = this.engine.get('terrain');
    const H = (x, z) => {
      const y = terrain && !terrain.__dead ? terrain.heightAt(x, z) : 0;
      return Number.isFinite(y) ? y : 0;
    };

    // The scenario may ask for fewer than the plan supports; keep the ones that
    // carry the fiction (smith, merchant, guard, priest) and drop spare villagers.
    /*
     * Floor of eight, not six. `spawn.npcs` is the scenario's *minimum* interest
     * in townsfolk, and the plan authors nine posts that each carry a piece of the
     * fiction (smith at the anvil, merchant behind his stall, guard on the gate
     * road, priest at the shrine, a talking pair, two walkers, a beggar at the
     * well). At six the plaza lost the conversation pair and one walker, which are
     * the two groups that make the place read as inhabited rather than staffed.
     * Nine archetypes share six cached geometries, so the extra figures are three
     * draw calls.
     */
    const order = plan.npcs
      .map((n, i) => ({ n, i, w: ROLE_WEIGHT[n.kind] ?? 1 }))
      .sort((a, b) => b.w - a.w || a.i - b.i)
      .slice(0, Math.max(want, 8))
      .sort((a, b) => a.i - b.i)
      .map((e) => e.n);

    for (let i = 0; i < order.length; i++) {
      try { this._spawn(order[i], i, H); }
      catch (e) { console.error(`[npcs] ${order[i].kind} failed —`, e); }
    }
    return this.list.length;
  }

  _spawn(spec, index, H) {
    const A = ARCHETYPES[spec.kind] ?? ARCHETYPES.villager;
    const rand = this.engine.freshRand(`npc:${spec.kind}:${index}`);
    const rig = buildHeroRig({ scale: A.scale, name: spec.kind });
    const view = rigView(rig);

    // Geometry is cached per archetype: two villagers share one buffer and only
    // their pose, phase and placement differ, which is free.
    let geo = this._cache.get(spec.kind);
    if (!geo) {
      geo = buildSkin(view, A, A.seed);
      this._cache.set(spec.kind, geo);
    }

    const mesh = new THREE.SkinnedMesh(geo, this.material);
    mesh.name = `npc.${spec.kind}.${index}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;            // bones are in world space
    mesh.bind(rig.skeleton, new THREE.Matrix4());

    const root = new THREE.Object3D();
    root.name = `npcRoot.${spec.kind}.${index}`;
    root.add(rig.root);
    this.rigs.add(root);
    this.holder.add(mesh);

    const y = Number.isFinite(spec.y) ? spec.y : H(spec.x, spec.z);
    root.position.set(spec.x, y, spec.z);
    root.rotation.set(0, spec.yaw ?? 0, 0);

    const npc = {
      kind: spec.kind, A, rig, mesh, root, index,
      x: spec.x, z: spec.z, y,
      yaw: spec.yaw ?? 0, targetYaw: spec.yaw ?? 0,
      phase: rand() * 6.283,
      speedScale: 0.9 + rand() * 0.25,
      route: spec.route ?? null,
      leg: 0, legT: 0, waitT: rand() * 2.4,
      talk: spec.talk ?? 0,
      scan: !!spec.scan,
      anvil: !!spec.anvil,
      gait: 0,
      H,
    };
    if (npc.route && npc.route.length > 1) {
      npc.x = npc.route[0][0]; npc.z = npc.route[0][1];
      root.position.set(npc.x, H(npc.x, npc.z), npc.z);
    }
    this.list.push(npc);
    return npc;
  }

  /* ---------------------------------------------------------------- frame */

  update(dt, elapsed) {
    if (!this.ready || !this.enabled || !this.list.length) return;
    for (let i = 0; i < this.list.length; i++) {
      const n = this.list[i];
      try {
        if (n.route) this._walk(n, dt);
        this._pose(n, elapsed);
        n.root.rotation.y = n.yaw;
        n.root.updateMatrixWorld(true);
      } catch (e) {
        console.error('[npcs] pose failed —', e);
        n.broken = true;
      }
    }
    this.list = this.list.filter((n) => !n.broken || true);
  }

  /** Waypoint patrol: constant speed, spring-damped facing, terrain-following. */
  _walk(n, dt) {
    const route = n.route;
    if (n.waitT > 0) {
      n.waitT -= dt;
      n.gait += (0 - n.gait) * Math.min(1, dt * 6);
      return;
    }
    const a = route[n.leg];
    const b = route[(n.leg + 1) % route.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const speed = 1.28 * n.speedScale;
    n.legT += (speed * dt) / len;
    if (n.legT >= 1) {
      n.legT = 0;
      n.leg = (n.leg + 1) % route.length;
      n.waitT = 1.2 + ((n.index * 0.37) % 1) * 2.2;
    }
    const t = clamp01(n.legT);
    n.x = a[0] + dx * t;
    n.z = a[1] + dz * t;
    n.y = n.H(n.x, n.z);
    n.root.position.set(n.x, n.y, n.z);
    n.targetYaw = Math.atan2(dx, dz);
    // shortest-arc turn
    let d = n.targetYaw - n.yaw;
    while (d > PI) d -= PI * 2;
    while (d < -PI) d += PI * 2;
    n.yaw += d * Math.min(1, dt * 5.5);
    n.gait += (1 - n.gait) * Math.min(1, dt * 5);
  }

  /**
   * Procedural idle + role behaviour. Bones have identity rest rotations, so a
   * pose is authored as plain world-aligned Euler angles: `thigh -X` swings the
   * leg forward, `lowerArm -X` flexes the elbow, and so on.
   */
  _pose(n, elapsed) {
    const rig = n.rig;
    const A = n.A;
    rig.restPose();
    const t = elapsed * 0.001 * 1000;           // seconds, explicit
    const ph = n.phase;
    const set = (name, x, y, z) => { const b = rig.bone(name); if (b) b.rotation.set(x, y, z); };
    const add = (name, x, y, z) => {
      const b = rig.bone(name);
      if (b) { b.rotation.x += x; b.rotation.y += y; b.rotation.z += z; }
    };

    /* ---- weight shift + breathing, the base of every idle ---- */
    const sway = Math.sin(t * 0.52 + ph);
    const sway2 = Math.sin(t * 0.31 + ph * 1.7);
    const breath = Math.sin(t * 1.05 + ph * 2.1);
    const stoop = A.stoop;

    set('pelvis', 0.02 * sway2, 0.05 * sway, 0.035 * sway);
    rig.bone('pelvis').position.y += -0.012 - 0.008 * Math.abs(sway);
    set('spine1', stoop * 0.45 + 0.012 * breath, -0.03 * sway, -0.02 * sway);
    set('spine2', stoop * 0.35 + 0.016 * breath, -0.02 * sway, -0.014 * sway);
    set('spine3', stoop * 0.20 - 0.01 * breath, -0.015 * sway, -0.01 * sway);
    set('neck', -stoop * 0.45 + 0.02 * breath, 0.04 * sway2, 0);

    /* knees never lock — a straight leg reads as a mannequin */
    const stand = 1 - n.gait;
    add('thigh_L', -0.035 * stand + 0.02 * sway, 0.02, 0);
    add('thigh_R', -0.035 * stand - 0.02 * sway, -0.02, 0);
    add('shin_L', 0.055 * stand, 0, 0);
    add('shin_R', 0.055 * stand, 0, 0);
    add('foot_L', -0.02 * stand, 0, 0);
    add('foot_R', -0.02 * stand, 0, 0);

    /* arms hang with a little natural flexion and counter-sway */
    const armBase = -0.06 - stoop * 0.10;
    add('upperArm_L', armBase + 0.05 * sway, 0, -0.10);
    add('upperArm_R', armBase - 0.05 * sway, 0, 0.10);
    add('lowerArm_L', -0.20 - 0.05 * breath, 0, 0);
    add('lowerArm_R', -0.20 + 0.05 * breath, 0, 0);

    /* ---- walking ---- */
    if (n.gait > 0.01) {
      const g = n.gait;
      const p = t * 4.3 * n.speedScale + ph;
      const s = Math.sin(p), c = Math.cos(p);
      add('thigh_L', -0.62 * s * g, 0, 0);
      add('thigh_R', 0.62 * s * g, 0, 0);
      add('shin_L', -0.62 * Math.max(0, Math.sin(p + 1.1)) * g, 0, 0);
      add('shin_R', -0.62 * Math.max(0, Math.sin(p + 1.1 + PI)) * g, 0, 0);
      add('foot_L', (0.24 * Math.sin(p + 2.2)) * g, 0, 0);
      add('foot_R', (0.24 * Math.sin(p + 2.2 + PI)) * g, 0, 0);
      add('upperArm_L', 0.42 * s * g, 0, 0);
      add('upperArm_R', -0.42 * s * g, 0, 0);
      add('lowerArm_L', -0.30 * g, 0, 0);
      add('lowerArm_R', -0.30 * g, 0, 0);
      add('spine1', 0.05 * g, -0.10 * s * g, 0);
      add('pelvis', 0, 0.12 * s * g, 0.05 * c * g);
      rig.bone('pelvis').position.y += -0.035 * g * Math.abs(c);
    }

    /* ---- role behaviour ---- */
    switch (n.kind) {
      case 'smith': {
        // a 1.35 s hammer cycle: lift, hold, strike, recoil. The elbow does the
        // work and the torso follows through, which is what reads as effort.
        const T = 1.35;
        const u = ((t * n.speedScale + ph) % T) / T;
        const lift = u < 0.55 ? Math.sin((u / 0.55) * PI * 0.5) : 1 - Math.pow((u - 0.55) / 0.45, 0.55);
        const strike = u > 0.55 ? Math.pow((u - 0.55) / 0.45, 0.6) : 0;
        set('upperArm_R', -1.02 - 0.34 * lift, -0.34, 0.30);
        set('lowerArm_R', -1.55 - 1.45 * lift + 1.7 * strike, 0.2, 0);
        set('upperArm_L', -0.95, -0.42, 0.24);
        set('lowerArm_L', -1.35, 0.30, 0);
        add('spine1', 0.16 * lift + 0.10 * strike, -0.10, 0);
        add('spine2', 0.10 * lift, -0.08, 0);
        add('neck', -0.30 - 0.10 * lift, 0, 0);
        // a solid, wide stance
        set('thigh_L', -0.10, 0.30, 0.10);
        set('thigh_R', -0.16, -0.22, -0.12);
        set('shin_L', 0.16, 0, 0);
        set('shin_R', 0.24, 0, 0);
        break;
      }
      case 'merchant': {
        // an open-handed pitch: the arms sweep out and settle, the head follows
        const T = 3.4;
        const u = ((t + ph) % T) / T;
        const g = Math.sin(u * PI * 2) * 0.5 + 0.5;
        set('upperArm_L', -0.62 - 0.55 * g, -0.30 - 0.35 * g, -0.55 - 0.22 * g);
        set('lowerArm_L', -1.10 + 0.55 * g, 0.24, 0);
        set('upperArm_R', -0.40 - 0.20 * g, 0.22, 0.42);
        set('lowerArm_R', -0.95 - 0.30 * g, -0.20, 0);
        add('spine3', 0, -0.12 * g, 0);
        add('neck', -0.06, 0.20 * Math.sin(u * PI * 4), 0);
        break;
      }
      case 'guard': {
        // spear grounded, weight on the back foot, a slow scan of the road
        const scan = Math.sin(t * 0.28 + ph) * 0.55 + Math.sin(t * 0.11 + ph * 2) * 0.2;
        set('upperArm_R', -0.30, 0.10, 0.16);
        set('lowerArm_R', -0.55, 0, 0);
        set('upperArm_L', -0.10, 0, -0.14);
        set('lowerArm_L', -0.38, 0.10, 0);
        add('neck', -0.04, scan, 0);
        add('spine3', 0, scan * 0.35, 0);
        set('thigh_L', -0.06, 0.24, 0.08);
        set('thigh_R', 0.12, -0.16, -0.08);
        set('shin_L', 0.10, 0, 0);
        set('shin_R', -0.20, 0, 0);
        break;
      }
      case 'beggar': {
        // folded down, one hand out with the bowl, a fine tremor in it
        const tremor = Math.sin(t * 7.4 + ph) * 0.02 + Math.sin(t * 11.1 + ph) * 0.012;
        set('spine1', 0.52, -0.06, 0.05);
        set('spine2', 0.34, -0.04, 0.04);
        set('spine3', 0.16, 0, 0);
        set('neck', -0.42 + 0.05 * breath, 0.10 * sway, 0);
        set('upperArm_L', -1.05 + tremor, -0.30, -0.30);
        set('lowerArm_L', -0.85 + tremor * 2, 0.18, 0);
        set('upperArm_R', 0.10, 0, 0.22);
        set('lowerArm_R', -0.42, 0, 0);
        set('thigh_L', -0.55, 0.22, 0.10);
        set('shin_L', 1.05, 0, 0);
        set('thigh_R', -0.42, -0.20, -0.08);
        set('shin_R', 0.90, 0, 0);
        rig.bone('pelvis').position.y -= 0.30;
        break;
      }
      case 'priest': {
        // a slow bow with the censer, hands low and together at the bottom
        const T = 7.0;
        const u = ((t + ph) % T) / T;
        const bow = Math.pow(Math.sin(clamp01((u - 0.15) / 0.45) * PI), 1.4);
        add('spine1', 0.30 * bow, 0, 0);
        add('spine2', 0.22 * bow, 0, 0);
        add('neck', 0.10 * bow, 0, 0);
        set('upperArm_R', -0.72 - 0.30 * bow, -0.24, 0.34);
        set('lowerArm_R', -1.35 + 0.30 * bow, 0.22, 0);
        set('upperArm_L', -0.66 - 0.28 * bow, 0.24, -0.34);
        set('lowerArm_L', -1.30 + 0.28 * bow, -0.22, 0);
        break;
      }
      default: {
        if (n.talk) {
          // a conversation pair: they take turns, and the listener nods
          const T = 5.2;
          const u = ((t + (n.talk === 1 ? 0 : T * 0.5)) % T) / T;
          const speaking = u < 0.5 ? 1 : 0;
          const beat = Math.sin(t * 3.1 + ph);
          if (speaking) {
            add('upperArm_L', -0.46 - 0.22 * beat, -0.24, -0.30);
            add('lowerArm_L', -0.85 - 0.25 * beat, 0.2, 0);
            add('spine3', 0, -0.08 * beat, 0);
            add('neck', 0.05 * beat, 0.08, 0);
          } else {
            add('neck', 0.10 * Math.max(0, Math.sin(t * 1.9 + ph)), 0.14, 0);
            add('upperArm_R', -0.30, 0.16, 0.18);
            add('lowerArm_R', -0.72, -0.18, 0);
          }
          break;
        }
        if (n.kind === 'porter' && n.gait < 0.4) {
          // resting under the sack: one hand steadying it
          add('upperArm_L', -0.70, -0.55, -0.55);
          add('lowerArm_L', -1.35, 0.4, 0);
          add('spine1', 0.12, 0, 0.05);
        }
        break;
      }
    }

    rig.root.updateMatrixWorld(true);
  }

  /* ---------------------------------------------------------------- */

  clear() {
    for (const n of this.list) {
      try {
        n.mesh.removeFromParent();
        n.root.removeFromParent();
        n.rig.dispose?.();
      } catch { /* noop */ }
    }
    this.list.length = 0;
  }

  applyScenario(name, cfg = {}) {
    // Town drives population (it owns the plan). All we do here is make sure a
    // non-town scenario leaves nothing standing in an empty crypt.
    if (cfg?.env?.biome !== 'town') this.clear();
  }

  dispose() {
    this.clear();
    for (const g of this._cache.values()) { try { g.dispose(); } catch { /* noop */ } }
    this._cache.clear();
    try { this.material?.dispose(); } catch { /* noop */ }
    this.material = null;
    this.holder.removeFromParent();
    this.rigs.removeFromParent();
    this.ready = false;
  }

  stats() {
    return {
      count: this.list.length,
      drawCalls: this.list.length,
      kinds: this.list.map((n) => n.kind),
      archetypes: this._cache.size,
    };
  }
}

/** Which townsfolk matter most when the scenario asks for fewer than the plan. */
const ROLE_WEIGHT = {
  smith: 5, merchant: 5, guard: 4.5, priest: 4, beggar: 3.5,
  porter: 3, villagerB: 2.5, villager: 2,
};

void mergeGeos; void lerp;
