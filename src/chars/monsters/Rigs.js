/**
 * SANCTUM — rig presets.
 *
 * Bipeds, quadrupeds and floaters share a joint-naming contract so the clip
 * library in Clips.js can drive any of them. Proportions are *always* in metres
 * and always authored against the 1.85 m hero from KNOWN_ISSUES.md — the rest
 * pose itself carries the silhouette (a ghoul's spine is bent in bind pose, so
 * even its idle reads hunched without the animation doing the work).
 *
 * Every offset accepts a per-side override, which is how asymmetric creatures
 * (the ghoul's overlong left arm, the brute's oversized weapon arm) get a
 * genuinely lopsided skeleton rather than a mirrored one.
 */

import { defineRig } from './RigKit.js';

const SIDES = [['.L', 1], ['.R', -1]];

function pick(s, key, side) {
  const o = s.side?.[side]?.[key];
  return o ?? s[key];
}

/**
 * Biped: root · hips · spine · chest · neck · head · jaw
 *        shoulder/elbow/wrist/hand ×2 · hip/knee/ankle/toe ×2
 */
export function bipedRig(s) {
  const J = [];
  const push = (name, parent, pos) => J.push({ name, parent, pos });
  push('root', null, [0, 0, 0]);
  push('hips', 'root', s.hips);
  push('spine', 'hips', s.spine);
  push('chest', 'spine', s.chest);
  push('neck', 'chest', s.neck);
  push('head', 'neck', s.head);
  push('jaw', 'head', s.jaw ?? [0, -0.05, 0.05]);
  for (const [side, sg] of SIDES) {
    let parent = 'chest';
    if (s.clav) { const c = pick(s, 'clav', side); push(`clav${side}`, 'chest', [c[0] * sg, c[1], c[2]]); parent = `clav${side}`; }
    for (const key of ['shoulder', 'elbow', 'wrist', 'hand']) {
      const v = pick(s, key, side);
      push(`${key}${side}`, parent, [v[0] * sg, v[1], v[2]]);
      parent = `${key}${side}`;
    }
  }
  for (const [side, sg] of SIDES) {
    let parent = 'hips';
    for (const key of ['hip', 'knee', 'ankle', 'toe']) {
      const v = pick(s, key, side);
      push(`${key}${side}`, parent, [v[0] * sg, v[1], v[2]]);
      parent = `${key}${side}`;
    }
  }
  if (s.extra) for (const e of s.extra) push(e.name, e.parent, e.pos);
  return defineRig(J);
}

/**
 * Quadruped: root · spine1 · spine2 · chest · neck1 · neck2 · head · jaw
 *            tail1..3 · fHip/fKnee/fAnkle/fPaw ×2 · bHip/bKnee/bAnkle/bPaw ×2
 * `root` sits at the pelvis; the spine runs forward (+Z) to the chest.
 */
export function quadRig(s) {
  const J = [];
  const push = (name, parent, pos) => J.push({ name, parent, pos });
  push('root', null, [0, s.rootY ?? 0.7, 0]);
  push('spine1', 'root', s.spine1);
  push('spine2', 'spine1', s.spine2);
  push('chest', 'spine2', s.chest);
  push('neck1', 'chest', s.neck1);
  push('neck2', 'neck1', s.neck2);
  push('head', 'neck2', s.head);
  push('jaw', 'head', s.jaw);
  let tp = 'root';
  for (let i = 1; i <= (s.tails ?? 3); i++) { push(`tail${i}`, tp, s.tail); tp = `tail${i}`; }
  for (const [side, sg] of SIDES) {
    let parent = 'chest';
    for (const key of ['fHip', 'fKnee', 'fAnkle', 'fPaw']) {
      const v = pick(s, key, side);
      push(`${key}${side}`, parent, [v[0] * sg, v[1], v[2]]);
      parent = `${key}${side}`;
    }
  }
  for (const [side, sg] of SIDES) {
    let parent = 'root';
    for (const key of ['bHip', 'bKnee', 'bAnkle', 'bPaw']) {
      const v = pick(s, key, side);
      push(`${key}${side}`, parent, [v[0] * sg, v[1], v[2]]);
      parent = `${key}${side}`;
    }
  }
  if (s.extra) for (const e of s.extra) push(e.name, e.parent, e.pos);
  return defineRig(J);
}

/**
 * Floater: a biped torso with no legs — the chain below the hips is a trailing
 * smoke tail. Arm/spine names match the biped contract so clips are reusable.
 */
export function floaterRig(s) {
  const J = [];
  const push = (name, parent, pos) => J.push({ name, parent, pos });
  push('root', null, [0, 0, 0]);
  push('hips', 'root', s.hips);
  push('spine', 'hips', s.spine);
  push('chest', 'spine', s.chest);
  push('neck', 'chest', s.neck);
  push('head', 'neck', s.head);
  for (const [side, sg] of SIDES) {
    let parent = 'chest';
    for (const key of ['shoulder', 'elbow', 'wrist', 'hand']) {
      const v = pick(s, key, side);
      push(`${key}${side}`, parent, [v[0] * sg, v[1], v[2]]);
      parent = `${key}${side}`;
    }
  }
  let tp = 'hips';
  for (let i = 1; i <= (s.tails ?? 5); i++) {
    push(`tail${i}`, tp, Array.isArray(s.tail[0]) ? s.tail[i - 1] : s.tail);
    tp = `tail${i}`;
  }
  if (s.extra) for (const e of s.extra) push(e.name, e.parent, e.pos);
  return defineRig(J);
}
