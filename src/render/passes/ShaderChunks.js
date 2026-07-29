/**
 * SANCTUM — shared GLSL for the post pipeline.
 *
 * Everything here is deterministic: no time-based hashing, no frame-varying
 * dither unless the caller explicitly feeds a frame seed it owns. three
 * compiles every ShaderMaterial as GLSL ES 3.00 on WebGL2 with the classic
 * `texture2D` / `varying` / `gl_FragColor` compatibility defines, so GLSL-1
 * style source is fine and `sampler3D` / `texture()` are available.
 */

/** Full-screen triangle vertex shader (matches FullScreenQuad's geometry). */
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

/** Colour / depth / hash helpers shared by every custom pass. */
export const GLSL_COMMON = /* glsl */ `
#ifndef SANCTUM_COMMON
#define SANCTUM_COMMON

const vec3 LUMA_W = vec3( 0.2126, 0.7152, 0.0722 );
float luma( vec3 c ) { return dot( max( c, vec3( 0.0 ) ), LUMA_W ); }

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }
vec3  sat3( vec3 x ) { return clamp( x, vec3( 0.0 ), vec3( 1.0 ) ); }

// Window-space depth (0..1) -> view-space Z (negative, camera looks down -Z).
float perspDepthToViewZ( float d, float n, float f ) {
  return ( n * f ) / ( ( f - n ) * d - f );
}

// Positive linear distance along the view axis.
float linearDist( float d, float n, float f ) {
  return -perspDepthToViewZ( d, n, f );
}

// Normalised 0..1 linear depth.
float linear01( float d, float n, float f ) {
  return sat( ( linearDist( d, n, f ) - n ) / max( f - n, 1e-4 ) );
}

vec3 viewPosFromDepth( vec2 uv, float d, mat4 invProj ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = invProj * clip;
  return v.xyz / ( abs( v.w ) < 1e-6 ? 1e-6 : v.w );
}

// Interleaved gradient noise — spatially stable, zero temporal shimmer.
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

// Dave Hoskins style hashes — cheap, deterministic, no trig.
float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec3 hash32( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yxz + 33.33 );
  return fract( ( p3.xxy + p3.yzz ) * p3.zyx );
}

// Smooth value noise on a 2D grid (used for puddle breakup).
float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = hash12( i );
  float b = hash12( i + vec2( 1.0, 0.0 ) );
  float c = hash12( i + vec2( 0.0, 1.0 ) );
  float d = hash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

vec3 srgbToLinear( vec3 c ) {
  return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}
vec3 linearToSrgb( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

#endif
`;

/**
 * Filmic grade maths shared by GradePass and the merged CompositePass.
 *
 * THE VALUE RESPONSE OF THE WHOLE GAME LIVES HERE. Five stages matter and each
 * of them was, at some point, the reason a frame looked wrong:
 *
 *  1. `uBlackSoft` — the pedestal. A hard `(c - blackPoint)` subtraction sends
 *     every pixel under the pedestal to *exactly* zero, and in a torchlit ARPG
 *     frame that is a third to three quarters of the image. Dark is the art
 *     direction; *missing* is a bug — a D4 frame lets you read the floor in an
 *     unlit corner. So the pedestal is removed with a compressed remnant left
 *     underneath it: the darkest decade keeps a gradient, and only pixels that
 *     were genuinely zero stay zero.
 *
 *     The remnant is now spliced in through `softFloor` rather than a `max()`.
 *     `soft*x + (1-soft)*max(x-bp,0)` is algebraically the same curve as the old
 *     `max(x-bp,0) + min(x,bp)*soft`, and both have a SLOPE DISCONTINUITY at
 *     `bp`: on `boss` the slope jumped 0.39 -> 1.63 at exactly one value, so any
 *     surface whose shading crossed it grew a hard contour line at that value —
 *     the "single black shape with a hard outline". The quadratic knee is C1 and
 *     is exactly the old curve outside +-45 % of the pedestal.
 *
 *  2. `contrastToe` — contrast about a low pivot. `pivot*(x/pivot)^g` with g>1
 *     drives the bottom decade's slope toward ZERO: at x=0.01 with pivot 0.42
 *     and g=1.34 the local slope is 0.38, and the LUT applies a second power law
 *     (g=1.28 in scene-linear) on top, so the composite bottom-end exponent was
 *     1.7. Measured on frozen `boss`, that turned inputs 0.000-0.040 into a
 *     PLATEAU at 0.27/255 — every unlit surface in the frame resolved to the
 *     same single code value, which is what welded dark objects to their dim
 *     surroundings. The exponent is therefore relaxed to 1 below a knee, so
 *     near-black keeps unity slope and stays *separable* while everything from
 *     the low mids up is bit-identical to the old curve.
 *
 *  3. `uShadowLift` / `uShadowChroma` — shadow reconstruction. The lift is
 *     multiplicative (`x * (1 + A·e^(-l/w))`) so black maps to black and the
 *     curve is monotone and C1; it converges to unity by ~4w so mid-tones are
 *     untouched. On its own it would multiply the shadow's *chroma* too, which
 *     is why the near-black pixels measured a per-pixel saturation over 0.6 —
 *     a shadow at (2,4,9)/255 is 78 % saturated by that measure. So the same
 *     window first pulls the hue toward `uSlate`, a luma-neutral cold grey.
 *     Result: shadows are cold, desaturated, and *readable*.
 *
 *  4. `uToeGamma` / `uToeKnee` — the film toe, and the only stage here that
 *     exists purely to keep code values alive at the very bottom. A gain cannot
 *     do this job: the lift above multiplies, so it scales the bottom decade
 *     without changing its *exponent*, and an exponent over 1 sends the
 *     separation between two near-black surfaces to zero no matter what gain
 *     follows it. So the toe is a gamma, applied in LUMA only (the shadow's hue
 *     and chroma have already been authored by stage 3 and must not move),
 *     blended out to a no-op by `uToeKnee` with a smoothstep — whose derivative
 *     is zero at both ends, which is what makes the splice C1 at the knee and
 *     leaves the curve above it untouched. `pow` of zero is zero, so genuinely
 *     occluded pixels still reach 0; what changes is that a pixel one code value
 *     above them no longer joins them.
 *
 *  5. `uShoulder` — the highlight knee. `min(c,k) + (1-k)(1-e^(-(c-k)/(1-k)))`.
 *     Value and slope are continuous at `k`, monotone, asymptotic to 1, so a
 *     pixel at 3.0 and a pixel at 1.2 are still different pixels instead of
 *     both being flat white. That difference is the falloff around a flame.
 *     It lives here rather than in GradePass so the merged composite path on
 *     the low tiers produces the same image.
 */
export const GLSL_GRADE = /* glsl */ `
#ifndef SANCTUM_GRADE
#define SANCTUM_GRADE

uniform sampler3D uLut;
uniform float uLutSize;
uniform float uLutStrength;
uniform float uBlackPoint;
uniform float uWhitePoint;
uniform float uBlackSoft;
uniform float uBlackKnee;
uniform float uContrast;
uniform float uPivot;
uniform float uContrastToe;
uniform float uShadowLift;
uniform float uShadowKnee;
uniform float uShadowChroma;
uniform vec3  uSlate;
uniform float uToeKnee;
uniform float uToeGamma;
uniform float uSaturation;
uniform float uHighlightDesat;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uTintAmount;
uniform float uShoulder;

/**
 * max( x, 0 ) with a C1 quadratic knee of half-width k.
 *
 * Exactly 0 at and below -k, exactly x at and above +k, value and slope
 * continuous at both, and it never overshoots either branch. Used wherever a
 * hard clip would otherwise put a kink in the transfer curve — a kink in the
 * curve is a visible contour in the image.
 */
vec3 softFloor( vec3 x, float k ) {
  float w = max( k, 1e-5 );
  vec3 q = clamp( ( x + w ) / ( 2.0 * w ), vec3( 0.0 ), vec3( 1.0 ) );
  return max( x, w * q * q );
}

/**
 * pivot * (x/pivot)^g, with the exponent relaxed to 1 below the knee (measured
 * in pivot-normalised units). Identical to the plain power law at and above the
 * knee — smoothstep's derivative vanishes there — and unity slope as x -> 0, so
 * the bottom decade is compressed by the *gain* of the chain and not by a
 * runaway exponent. Zero maps to zero.
 */
vec3 contrastToe( vec3 x, float pivot, float g, float knee ) {
  vec3 u = max( x, vec3( 0.0 ) ) / pivot;
  vec3 q = mix( vec3( 1.0 ), vec3( g ), smoothstep( vec3( 0.0 ), vec3( max( knee, 1e-4 ) ), u ) );
  return pivot * pow( max( u, vec3( 1e-9 ) ), q );
}

// Input and output are display-referred (sRGB encoded) values.
vec3 sanctumGrade( vec3 c ) {

  // --- 3D LUT look (tetrahedral-free hardware trilinear, half-texel inset) ---
  if ( uLutStrength > 0.0 ) {
    float px = 1.0 / uLutSize;
    vec3 uvw = vec3( 0.5 * px ) + sat3( c ) * ( 1.0 - px );
    vec3 graded = texture( uLut, uvw ).rgb;
    c = mix( c, graded, uLutStrength );
  }

  // --- pedestal + white point, with a C1 soft floor instead of a hard clip ---
  float sc = 1.0 / max( uWhitePoint - uBlackPoint, 1e-3 );
  vec3 x = c * sc;
  float bp = uBlackPoint * sc;
  c = uBlackSoft * x + ( 1.0 - uBlackSoft ) * softFloor( x - vec3( bp ), bp * uBlackKnee );

  // --- contrast around a low pivot so mid-tones stay heavy ---
  c = contrastToe( c, uPivot, uContrast, uContrastToe );

  // --- shadow reconstruction: cold desaturated slate, never crushed black ---
  float l = luma( c );
  float sw = exp( -l / max( uShadowKnee, 1e-3 ) );
  c = mix( c, l * uSlate, uShadowChroma * sw );
  c *= 1.0 + uShadowLift * sw;

  /* --- film toe: near-black keeps code values instead of collapsing ---------
   * Luma-only, so the slate pull above still owns the shadow's colour. The
   * ratio is clamped because a pixel at 1e-9 would otherwise ask for a gain of
   * 10^2: black stays black, and the clamp only ever binds below 1/1000 of a
   * code value. */
  if ( uToeGamma < 0.999 ) {
    float T = max( uToeKnee, 1e-4 );
    float lt = max( luma( c ), 1e-7 );
    float q = mix( uToeGamma, 1.0, smoothstep( 0.0, T, lt ) );
    c *= min( 24.0, T * pow( lt / T, q ) / lt );
  }

  // --- shadow / highlight split tone ---
  l = luma( c );
  float wS = 1.0 - smoothstep( 0.0, 0.42, l );
  float wH = smoothstep( 0.45, 1.0, l );
  c *= mix( vec3( 1.0 ), uShadowTint, uTintAmount * wS );
  c *= mix( vec3( 1.0 ), uHighlightTint, uTintAmount * wH );

  // --- saturation with highlight rolloff (bright things go to white, not neon) ---
  l = luma( c );
  float s = uSaturation * mix( 1.0, uHighlightDesat, smoothstep( 0.55, 1.05, l ) );
  c = mix( vec3( l ), c, s );

  // --- filmic highlight shoulder: a flame is a core with a falloff, not a plate ---
  float k = clamp( uShoulder, 0.05, 1.0 );
  if ( k < 0.999 ) {
    float w = 1.0 - k;
    vec3 over = max( c - vec3( k ), vec3( 0.0 ) );
    c = min( c, vec3( k ) ) + w * ( 1.0 - exp( -over / w ) );
  }

  return max( c, vec3( 0.0 ) );
}

#endif
`;

/** Animated, luminance-weighted film grain. Frame seed is supplied by the CPU. */
export const GLSL_GRAIN = /* glsl */ `
#ifndef SANCTUM_GRAIN
#define SANCTUM_GRAIN

uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainChroma;
uniform float uGrainSeed;
uniform float uGrainShadowBias;

vec3 sanctumGrain( vec3 c, vec2 fragCoord ) {
  if ( uGrainAmount <= 0.0 ) return c;

  vec2 p = fragCoord / max( uGrainSize, 0.35 );
  vec2 s = vec2( uGrainSeed * 71.13, uGrainSeed * 37.71 );

  vec3 n3 = hash32( p + s ) - 0.5;
  float mono = ( n3.x + n3.y + n3.z ) * 0.3333;
  vec3 n = mix( vec3( mono ), n3, uGrainChroma );

  // Film grain lives in the shadows and the low mids; highlights stay clean.
  float l = luma( c );
  float w = mix( 1.0, 0.18, smoothstep( 0.05, 0.72, l ) );
  w = mix( w, w * uGrainShadowBias, 1.0 - smoothstep( 0.0, 0.16, l ) );

  return c + n * ( uGrainAmount * w );
}

#endif
`;

/** Radial chromatic aberration + soft natural vignette with barrel falloff. */
export const GLSL_CAVIGNETTE = /* glsl */ `
#ifndef SANCTUM_CAVIG
#define SANCTUM_CAVIG

uniform float uCaAmount;
uniform float uCaBarrel;
uniform float uVigStrength;
uniform float uVigInner;
uniform float uVigOuter;
uniform float uVigPower;
uniform float uVigRound;
uniform float uAspect;

vec3 sanctumChroma( sampler2D tex, vec2 uv ) {
  vec2 d = uv - 0.5;
  float r2 = dot( d, d ) * 4.0;              // 0 at centre, ~1 at the edge midpoints
  if ( uCaAmount <= 0.0 ) return texture2D( tex, uv ).rgb;

  vec2 dir = d * ( uCaAmount * r2 );
  vec2 bar = d * ( uCaBarrel * r2 * r2 );

  float cr = texture2D( tex, uv + dir + bar ).r;
  float cg = texture2D( tex, uv + bar ).g;
  float cb = texture2D( tex, uv - dir + bar ).b;
  return vec3( cr, cg, cb );
}

float sanctumVignette( vec2 uv ) {
  vec2 d = ( uv - 0.5 ) * vec2( mix( 1.0, uAspect, uVigRound ), 1.0 );
  float r = length( d ) * 2.0;
  float v = smoothstep( uVigOuter, uVigInner, r );
  v = pow( sat( v ), uVigPower );
  return mix( 1.0, v, uVigStrength );
}

#endif
`;

/** Depth-aware 4-tap bilateral upsample of a low resolution buffer. */
export const GLSL_BILATERAL = /* glsl */ `
#ifndef SANCTUM_BILATERAL
#define SANCTUM_BILATERAL

vec4 bilateralUpsample( sampler2D tLow, sampler2D tDepthTex, vec2 uv, vec2 lowTexel,
                        float centerDist, float sigma, float near, float far ) {
  vec4 acc = vec4( 0.0 );
  float wsum = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    vec2 o = vec2( float( i / 2 ) - 0.5, float( i - ( i / 2 ) * 2 ) - 0.5 ) * 2.0 * lowTexel;
    vec2 suv = clamp( uv + o, vec2( 0.0 ), vec2( 1.0 ) );
    float sd = linearDist( texture2D( tDepthTex, suv ).x, near, far );
    float w = exp( -abs( sd - centerDist ) * sigma );
    acc += texture2D( tLow, suv ) * w;
    wsum += w;
  }
  if ( wsum < 1e-4 ) return texture2D( tLow, uv );
  return acc / wsum;
}

#endif
`;
