import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON, GLSL_CAVIGNETTE } from './ShaderChunks.js';

/**
 * Bound on how far any one channel may depart from the unshifted sample.
 *
 * WHY THIS EXISTS (round-1 blocker #9, the half of it that is not about the UI).
 * A per-channel radial shift is a *smooth* effect on smooth image content, but
 * this frame is full of black mortar joints against near-clipped stone, and a
 * sub-pixel shift across an edge like that decorrelates the channels completely:
 * the pass stops being a lens model and becomes an amplifier for the frame's own
 * aliasing, which is what produced the magenta/green confetti the art director
 * called out. Lowering `chromatic` to 0.00016 helped and did not fix it —
 * measured on `combat`, 0.372 % of the frame still sat above a 90/255 channel
 * spread, and turning grain and CA off dropped that to 0.055 %.
 *
 * Clamping the deviation keeps the effect the lens actually models — a soft
 * fringe that grows with r² toward the corners — and removes the part that only
 * ever fires on a one-pixel edge. 0.035 is roughly 9/255, i.e. a fringe you can
 * see on a large smooth gradient and cannot see on a single pixel.
 *
 * ROUND 2: the clamp is now itself radius-weighted (scaled by the same saturated
 * r² the sample offset uses), so the allowance is exactly ZERO on the optical
 * axis and only reaches 9/255 out at the frame edge. A real lens has no lateral
 * chromatic aberration at the centre of the field, so neither does this: a
 * high-contrast mortar joint under the hero cannot fringe at all, and the corners
 * keep the sub-pixel colour separation that makes the frame read as a photograph.
 * With the offset ALSO ∝ r² the effective fringe now grows as r⁴ near the axis,
 * which is far below the visibility floor anywhere in the inner half of frame.
 */
const CA_DEVIATION_CLAMP = 0.035;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_CAVIGNETTE}

uniform sampler2D tDiffuse;
uniform float uCaClamp;
varying vec2 vUv;

void main() {
  vec3 ref = texture2D( tDiffuse, vUv ).rgb;
  vec3 c = nonaChroma( tDiffuse, vUv );
  // See CA_DEVIATION_CLAMP: bound the per-channel excursion so the fringe
  // survives and the single-pixel rainbow confetti cannot form. The bound is
  // radius-weighted with the same saturated r² the sample offset uses, so the
  // optical axis is exactly free of lateral CA and only the field edge fringes.
  vec2 dv = vUv - 0.5;
  float r2 = sat( dot( dv, dv ) * 4.0 );
  vec3 lim = vec3( uCaClamp * r2 );
  c = ref + clamp( c - ref, -lim, lim );
  c *= nonaVignette( vUv );
  gl_FragColor = vec4( c, 1.0 );
}
`;

/** Shared CA + vignette uniform block (also used by the merged composite). */
export function caVignetteUniforms() {
  return {
    uCaAmount: { value: 0.0011 },
    uCaBarrel: { value: 0.0016 },
    uCaClamp: { value: CA_DEVIATION_CLAMP },
    uVigStrength: { value: 0.34 },
    uVigInner: { value: 0.58 },
    uVigOuter: { value: 1.35 },
    uVigPower: { value: 1.15 },
    uVigRound: { value: 0.55 },
    uAspect: { value: 1.777 },
  };
}

export function syncCaVignetteUniforms(u, params) {
  u.uCaAmount.value = params.chromatic;
  u.uCaBarrel.value = params.barrel;
  // Honour an explicit override from the tuning loop, otherwise hold the clamp.
  if (u.uCaClamp) u.uCaClamp.value = params.chromaClamp ?? CA_DEVIATION_CLAMP;
  u.uVigStrength.value = params.vignette;
  u.uVigInner.value = params.vignetteInner;
  u.uVigOuter.value = params.vignetteOuter;
  u.uVigPower.value = params.vignettePower;
  u.uVigRound.value = params.vignetteRound;
}

/**
 * Lens finish: radius-squared chromatic aberration (dead clean at the centre,
 * about two pixels at the far corner) plus a wide, soft vignette with a slight
 * barrel falloff. Both are deliberately restrained — heavy CA and a hard
 * vignette are the two fastest ways to make a frame look like a phone filter —
 * and the CA is additionally deviation-clamped so it can never manufacture a
 * saturated pixel out of an aliased edge (see CA_DEVIATION_CLAMP).
 */
export class CAVignettePass extends QuadPass {
  constructor(params) {
    super(FRAG, { tDiffuse: { value: null }, ...caVignetteUniforms() }, {}, 'Nona.CAVignette');
    this.params = params;
    this.needsSwap = true;
  }

  beforeRender() {
    syncCaVignetteUniforms(this.uniforms, this.params);
  }
}
