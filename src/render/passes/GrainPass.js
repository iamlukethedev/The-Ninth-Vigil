import * as THREE from 'three';
import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON, GLSL_GRAIN } from './ShaderChunks.js';

/**
 * How much of the grain's per-channel (coloured) component survives in the
 * deepest shadows, where it is otherwise strongest.
 *
 * WHY THIS EXISTS (round-1 blocker #9, the half of it that is not about the UI).
 * `sanctumGrain` weights grain by luma — heavier in the shadows, and then
 * multiplied AGAIN by `uGrainShadowBias` below 0.16 luma. That is right for the
 * monochrome component, which is what reads as film. It is exactly wrong for the
 * chroma component: coloured noise on a near-black pixel is the most visible
 * chroma signal there is. So the chroma term is luma-gated on top of the existing
 * weighting: full strength in the mids where it reads as film stock, almost gone
 * in the darks where it only reads as noise. The monochrome term is untouched, so
 * the authored grain amount and its shadow bias still do exactly what they did.
 */
const GRAIN_CHROMA_SHADOW_FLOOR = 0.12;
/** Luma window over which the chroma term fades back in. */
const GRAIN_CHROMA_KNEE = [0.035, 0.30];

/**
 * CONTRAST GATE — round-2 blocker (round-1 #9's fix moved the problem instead of
 * removing it: HUD type came clean, the world did not).
 *
 * The luma knee above cleans up the darks and nothing else. It cannot help where
 * the artifact lives: a black mortar joint against warm stone averages out to a
 * perfectly respectable MID-TONE, sails through the knee at `keep = 1.0`, and
 * gets the full per-channel term applied to a one-pixel-wide feature. So the
 * chroma term is gated on local CONTRAST as well as luma.
 *
 * A 3x3 Sobel on the INCOMING luma (grain has not been added yet, so the gradient
 * signal is the image's own structure and not the noise about to be applied),
 * normalised by 4 so a clean step edge reports its own height in display-referred
 * units. Chroma grain fades to `EDGE_FLOOR` across `EDGE_KNEE`: a mortar joint is
 * a ~0.25–0.35 step and lands past the top of the knee, stone albedo variation is
 * a ~0.02–0.06 step and is essentially unaffected, so flat surfaces keep their
 * colour grain. The monochrome term is deliberately NOT gated — monochrome noise
 * on an edge is film; only chroma decorrelates the channels into digital confetti.
 */
const GRAIN_CHROMA_EDGE_FLOOR = 0.05;
/** Gradient-magnitude window (display-referred step height) for the edge gate. */
const GRAIN_CHROMA_EDGE_KNEE = [0.045, 0.18];

/**
 * CHROMA DESPECKLE — the other half of the same blocker, and the half that turned
 * out to carry almost all of the visible damage.
 *
 * Measured, not assumed. Forcing `grainChroma` from 0.28 to 0 on `combat` moves
 * the isolated-chroma pixel count in the (0.35, 0.80) region by 0.005 pp — i.e.
 * nothing, because at `grain = 0.034` the coloured term is only worth about
 * ±0.6/255 of channel imbalance. The cyan/magenta pixels the art director found
 * peppering the mortar joints are the *frame's own* one-pixel colour aliasing:
 * warm key light on a stone face landing next to cold ambient in the joint, plus
 * specular aliasing, plus SMAA's blend decisions flipping under grain. 81 % of
 * them sit on a high-gradient pixel; the worst are things like rgb(28,0,65) with
 * a neighbourhood mean of rgb(50,53,57) — a violet speck in neutral stone.
 *
 * Grain is not the cause, but this pass is the right place to kill it, because a
 * one-pixel colour outlier is never image information at this resolution. Human
 * chroma acuity is roughly a quarter of luma acuity; film records chroma at lower
 * MTF than luma and every camera and codec in existence subsamples it. So:
 *
 *   - split the pixel into luma and chroma, and only ever move the chroma, so the
 *     correction provably cannot soften an edge or shift a value;
 *   - clamp its distance from a joint-bilateral neighbourhood colour (4x4 spatial
 *     support, weighted by luma similarity so the reference never comes from the
 *     other side of a contrast edge) to an allowance;
 *   - shrink the allowance where the luma gradient is high, since that is where a
 *     one-pixel colour outlier is aliasing rather than content, and scale it with
 *     luma, since a dark pixel in a cold scene cannot legitimately be saturated;
 *   - widen it in proportion to how saturated the neighbourhood already is, so a
 *     flame edge, a rune, or a rim of hellfire keeps its colour and only neutral
 *     stone gets scrubbed;
 *   - scale the correction back to the gamut boundary rather than clipping it,
 *     because a channel clipped at zero is itself a new speck.
 *
 * Luma is untouched by construction. The frame does not get softer, it gets clean.
 */
const DESPECKLE = 1.0;
/**
 * Base chroma deviation allowed from the wide tent mean, on flat surfaces and on
 * high-gradient ones, before the luma and saturation factors in the shader. Units
 * are display-referred chroma: a mid-tone stone face deviates ~0.003–0.01 from its
 * neighbourhood colour, a material boundary ~0.02–0.04, a flame edge ~0.035, and a
 * clipped violet speck in neutral stone 0.10–0.28.
 */
const DESPECKLE_FLAT = 0.040;
const DESPECKLE_EDGE = 0.009;
/** How much a genuinely saturated neighbourhood widens the allowance. */
const DESPECKLE_COLOR_K = 0.6;

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_GRAIN}

uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uGrainChromaFloor;
uniform float uGrainChromaKnee0;
uniform float uGrainChromaKnee1;
uniform float uGrainChromaEdgeFloor;
uniform float uGrainChromaEdge0;
uniform float uGrainChromaEdge1;
uniform float uDespeckle;
uniform float uDespeckleFlat;
uniform float uDespeckleEdge;
uniform float uDespeckleColorK;
varying vec2 vUv;

/*
 * The luma-neutral colour part of a pixel, and the same thing with brightness
 * divided out. luma() of either is exactly 0, which is what makes any correction
 * built out of them provably value-preserving: the pass can change what colour a
 * pixel is and cannot change how bright it is.
 *
 * The floor matters. Chromaticity is the only sane space for the TARGET colour —
 * a dark pixel inside a mortar joint must be pulled toward its neighbourhood's
 * hue at ITS OWN brightness, never toward the absolute chroma of the lit stone
 * beside it. Correcting toward absolute neighbourhood chroma was measured doing
 * exactly that: saturated red and yellow single pixels appeared along the joints
 * where the frame had had dark blue ones, which is trading one speck for a worse
 * one.
 */
#define CHROMA_L_FLOOR 0.06
// Luma-similarity falloff of the bilateral reference, in inverse display units:
// a neighbour 1/12 of the range away from the centre counts e^-1 as much.
#define DESPECKLE_SIGMA 12.0
vec3 chromaOf( vec3 c ) { return c - vec3( luma( c ) ); }
vec3 chromaticity( vec3 c ) { return chromaOf( c ) / max( luma( c ), CHROMA_L_FLOOR ); }

void main() {
  vec4 base = texture2D( tDiffuse, vUv );

  // --- one 3x3 neighbourhood, used for BOTH the gradient and the chroma mean ---
  vec3 t0 = texture2D( tDiffuse, vUv + vec2( -1.0, -1.0 ) * uTexel ).rgb;
  vec3 t1 = texture2D( tDiffuse, vUv + vec2(  0.0, -1.0 ) * uTexel ).rgb;
  vec3 t2 = texture2D( tDiffuse, vUv + vec2(  1.0, -1.0 ) * uTexel ).rgb;
  vec3 t3 = texture2D( tDiffuse, vUv + vec2( -1.0,  0.0 ) * uTexel ).rgb;
  vec3 t4 = texture2D( tDiffuse, vUv + vec2(  1.0,  0.0 ) * uTexel ).rgb;
  vec3 t5 = texture2D( tDiffuse, vUv + vec2( -1.0,  1.0 ) * uTexel ).rgb;
  vec3 t6 = texture2D( tDiffuse, vUv + vec2(  0.0,  1.0 ) * uTexel ).rgb;
  vec3 t7 = texture2D( tDiffuse, vUv + vec2(  1.0,  1.0 ) * uTexel ).rgb;

  // --- 3x3 luma gradient of the image BEFORE grain (see GRAIN_CHROMA_EDGE_*) ---
  float gx = ( luma( t2 ) + 2.0 * luma( t4 ) + luma( t7 ) )
           - ( luma( t0 ) + 2.0 * luma( t3 ) + luma( t5 ) );
  float gy = ( luma( t5 ) + 2.0 * luma( t6 ) + luma( t7 ) )
           - ( luma( t0 ) + 2.0 * luma( t1 ) + luma( t2 ) );
  // 0.25 normalises a clean step edge to its own height in display units.
  float grad = length( vec2( gx, gy ) ) * 0.25;
  float edgeT = smoothstep( uGrainChromaEdge0, uGrainChromaEdge1, grad );

  // --- chroma despeckle, luma-preserving by construction (see DESPECKLE_*) ---
  vec3 rgb = base.rgb;
  if ( uDespeckle > 0.0 ) {
    /*
     * The reference colour: a JOINT BILATERAL mean of the neighbourhood's
     * chromaticity — spatial tent weight times a luma-similarity weight.
     *
     * Every term here exists because a simpler version was measured failing:
     *
     *  - the centre is INCLUDED (tent weight 4). A centre-excluded mean makes the
     *    reference the surround, which INVERTS any 2-pixel-period pattern instead
     *    of smoothing it, and alternating specks along a joint are exactly that:
     *    driving the allowance to zero pushed the >22/255 outlier count UP from
     *    0.686 % to 1.218 % of the frame.
     *  - the support is 4x4, not 3x3. On the ungrained, unfiltered graded frame the
     *    >22/255 chroma outliers survive a 3x3 low-pass almost untouched (10.57 %
     *    -> 10.27 %), so they arrive in 2–3 px clumps. Four bilinear taps at ±1.5
     *    texels are four hardware 2x2 averages, i.e. 4x4 reach for four fetches.
     *  - the luma-similarity weight is what stops the filter creating new specks.
     *    Without it, a dark pixel in a joint takes its colour from the lit stone
     *    beside it, and the joints came back peppered with saturated RED and YELLOW
     *    single pixels where they had had dark blue ones. With it, a dark pixel is
     *    referenced only against other dark pixels, a flame edge only against the
     *    flame, and a stone face only against stone.
     */
    vec3 w0 = texture2D( tDiffuse, vUv + vec2( -1.5, -1.5 ) * uTexel ).rgb;
    vec3 w1 = texture2D( tDiffuse, vUv + vec2(  1.5, -1.5 ) * uTexel ).rgb;
    vec3 w2 = texture2D( tDiffuse, vUv + vec2( -1.5,  1.5 ) * uTexel ).rgb;
    vec3 w3 = texture2D( tDiffuse, vUv + vec2(  1.5,  1.5 ) * uTexel ).rgb;
    float L = luma( rgb );
    float Lc = max( L, CHROMA_L_FLOOR );
    vec3 nqSum = chromaticity( rgb ) * 4.0;
    float nqW = 4.0;
    #define DS_TAP(TX,SW) { float bw = ( SW ) * exp( -abs( luma( TX ) - L ) * DESPECKLE_SIGMA ); \
                            nqSum += chromaticity( TX ) * bw; nqW += bw; }
    DS_TAP( t0, 1.0 ) DS_TAP( t2, 1.0 ) DS_TAP( t5, 1.0 ) DS_TAP( t7, 1.0 )
    DS_TAP( t1, 2.0 ) DS_TAP( t3, 2.0 ) DS_TAP( t4, 2.0 ) DS_TAP( t6, 2.0 )
    DS_TAP( w0, 3.2 ) DS_TAP( w1, 3.2 ) DS_TAP( w2, 3.2 ) DS_TAP( w3, 3.2 )
    vec3 nq = nqSum / nqW;
    // Deviation from the neighbourhood's colour AT THIS PIXEL'S OWN BRIGHTNESS.
    vec3 dq = chromaticity( rgb ) - nq;
    /*
     * The test is on |dq| * Lc, i.e. the deviation measured back in DISPLAY units,
     * because that is what the eye sees and what the artifact metric counts: a
     * blue speck at rgb(2,0,30) inside a near-black joint is a 32/255 chroma error
     * even though it is a dark pixel. Testing in normalised units instead let that
     * exact pixel pass, because a faintly cold joint has a similar *chromaticity*.
     *
     * Three factors on the allowance, each earned by a failed measurement:
     *   - gradient: tightest on high-contrast structure, which is where a
     *     one-pixel colour outlier is aliasing and not content;
     *   - luma: a dark pixel in a cold scene cannot legitimately be saturated, so
     *     the allowance scales with value;
     *   - neighbourhood saturation (|nq| is already a saturation measure): a flame
     *     edge, a rune, or a rim of hellfire sits in genuinely colourful
     *     surroundings and keeps its colour; neutral stone does not.
     */
    float allow = mix( uDespeckleFlat, uDespeckleEdge, edgeT )
                * ( 0.30 + 2.5 * L )
                * ( 1.0 + uDespeckleColorK * length( nq ) );
    float keep = min( 1.0, allow / max( length( dq ) * Lc, 1e-5 ) );
    // Target colour is nq * Lc — the neighbourhood's hue and saturation, this
    // pixel's brightness. dq * Lc is luma-neutral, so value cannot change.
    vec3 delta = dq * ( ( keep - 1.0 ) * uDespeckle * Lc );
    // GAMUT GUARD. Rotating a very dark pixel's colour toward its neighbourhood
    // can drive a channel negative, and a negative channel clipped at zero is a
    // NEW out-of-gamut speck — the first version of this measurably raised the
    // clipped-channel count from 0.237 % to 0.399 % of the frame. Scaling the
    // whole correction back to the gamut boundary keeps it luma-neutral and can
    // never manufacture a clip. The 0.85 keeps it off the boundary rather than
    // landing exactly on zero, which would count as a clip in its own right.
    vec3 room = vec3(
      delta.r < 0.0 ? rgb.r / max( -delta.r, 1e-6 ) : 1.0,
      delta.g < 0.0 ? rgb.g / max( -delta.g, 1e-6 ) : 1.0,
      delta.b < 0.0 ? rgb.b / max( -delta.b, 1e-6 ) : 1.0 );
    float t = min( 1.0, 0.85 * min( room.r, min( room.g, room.b ) ) );
    rgb = max( rgb + delta * t, vec3( 0.0 ) );
  }

  vec3 g = sanctumGrain( rgb, gl_FragCoord.xy );
  // Split what the grain added into its monochrome and chroma parts. The
  // monochrome part is film and is kept everywhere; the chroma part is kept only
  // where it cannot manufacture a coloured single pixel — out of the deep
  // shadows (luma knee) and off high-contrast structure (contrast knee).
  vec3 d = g - rgb;
  float mono = ( d.r + d.g + d.b ) * 0.3333;
  float keepLuma = mix(
    uGrainChromaFloor, 1.0,
    smoothstep( uGrainChromaKnee0, uGrainChromaKnee1, luma( rgb ) ) );
  float keepEdge = mix( 1.0, uGrainChromaEdgeFloor, edgeT );
  d = mix( vec3( mono ), d, keepLuma * keepEdge );
  gl_FragColor = vec4( rgb + d, base.a );
}
`;

/** Shared grain uniform block (also used by the merged composite path). */
export function grainUniforms() {
  return {
    uGrainAmount: { value: 0.032 },
    uGrainSize: { value: 1.35 },
    // Coloured fraction of the noise. This is a seasoning, not a look — at 0.28
    // it was authored as if it were the latter. See the note above.
    uGrainChroma: { value: 0.04 },
    uGrainSeed: { value: 0 },
    uGrainShadowBias: { value: 1.3 },
    uGrainChromaFloor: { value: GRAIN_CHROMA_SHADOW_FLOOR },
    uGrainChromaKnee0: { value: GRAIN_CHROMA_KNEE[0] },
    uGrainChromaKnee1: { value: GRAIN_CHROMA_KNEE[1] },
    uGrainChromaEdgeFloor: { value: GRAIN_CHROMA_EDGE_FLOOR },
    uGrainChromaEdge0: { value: GRAIN_CHROMA_EDGE_KNEE[0] },
    uGrainChromaEdge1: { value: GRAIN_CHROMA_EDGE_KNEE[1] },
  };
}

export function syncGrainUniforms(u, params, frame) {
  u.uGrainAmount.value = params.grain;
  u.uGrainSize.value = params.grainSize;
  u.uGrainChroma.value = params.grainChroma;
  u.uGrainShadowBias.value = params.grainShadowBias;
  if (u.uGrainChromaFloor) {
    u.uGrainChromaFloor.value = params.grainChromaShadowFloor ?? GRAIN_CHROMA_SHADOW_FLOOR;
  }
  if (u.uGrainChromaEdgeFloor) {
    u.uGrainChromaEdgeFloor.value = params.grainChromaEdgeFloor ?? GRAIN_CHROMA_EDGE_FLOOR;
    u.uGrainChromaEdge0.value = params.grainChromaEdge0 ?? GRAIN_CHROMA_EDGE_KNEE[0];
    u.uGrainChromaEdge1.value = params.grainChromaEdge1 ?? GRAIN_CHROMA_EDGE_KNEE[1];
  }
  if (u.uDespeckle) {
    u.uDespeckle.value = params.chromaDespeckle ?? DESPECKLE;
    u.uDespeckleFlat.value = params.chromaDespeckleFlat ?? DESPECKLE_FLAT;
    u.uDespeckleEdge.value = params.chromaDespeckleEdge ?? DESPECKLE_EDGE;
    u.uDespeckleColorK.value = params.chromaDespeckleColorK ?? DESPECKLE_COLOR_K;
  }
  // Golden-ratio walk over a 64 frame cycle: the pattern moves every frame so
  // it reads as film, but the step is small and bounded so deterministic
  // stepping never produces a harsh strobe.
  const f = frame % 64;
  u.uGrainSeed.value = ((f * 0.6180339887) % 1.0) * 64.0 * params.grainMotion;
}

/**
 * Film grain and chroma cleanup, in that order in the file and the reverse order
 * in the shader (the frame is despeckled first, then grained, so the grain we add
 * is never itself a despeckle candidate).
 *
 * Grain is luminance weighted — heavier in the shadows, almost absent in
 * highlights — overwhelmingly monochrome, with a trace of per-channel noise faded
 * out of the deep shadows (GRAIN_CHROMA_SHADOW_FLOOR) and off high-contrast
 * structure (GRAIN_CHROMA_EDGE_FLOOR), driven by a frame counter the pipeline
 * owns rather than wall time. The despeckle clamps one-pixel chroma outliers
 * toward their neighbourhood without touching luma at all (see DESPECKLE).
 */
export class GrainPass extends QuadPass {
  constructor(params) {
    super(
      FRAG,
      {
        tDiffuse: { value: null },
        // Filled in by QuadPass.setSize; a sane default keeps the first frame
        // from sampling itself nine times at the same coordinate.
        uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
        uDespeckle: { value: DESPECKLE },
        uDespeckleFlat: { value: DESPECKLE_FLAT },
        uDespeckleEdge: { value: DESPECKLE_EDGE },
        uDespeckleColorK: { value: DESPECKLE_COLOR_K },
        ...grainUniforms(),
      },
      {},
      'Sanctum.Grain'
    );
    this.params = params;
    this.frame = 0;
    this.needsSwap = true;
  }

  beforeRender() {
    syncGrainUniforms(this.uniforms, this.params, this.frame);
  }
}
