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
 * THE VALUE RESPONSE OF THE WHOLE GAME LIVES HERE. Three stages matter and each
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
 *  2. `uShadowLift` / `uShadowChroma` — shadow reconstruction. The lift is
 *     multiplicative (`x * (1 + A·e^(-l/w))`) so black maps to black and the
 *     curve is monotone and C1; it converges to unity by ~4w so mid-tones are
 *     untouched. On its own it would multiply the shadow's *chroma* too, which
 *     is why the near-black pixels measured a per-pixel saturation over 0.6 —
 *     a shadow at (2,4,9)/255 is 78 % saturated by that measure. So the same
 *     window first pulls the hue toward `uSlate`, a luma-neutral cold grey.
 *     Result: shadows are cold, desaturated, and *readable*.
 *
 *  3. `uShoulder` — the highlight knee. `min(c,k) + (1-k)(1-e^(-(c-k)/(1-k)))`.
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
uniform float uContrast;
uniform float uPivot;
uniform float uShadowLift;
uniform float uShadowKnee;
uniform float uShadowChroma;
uniform vec3  uSlate;
uniform float uSaturation;
uniform float uHighlightDesat;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;
uniform float uTintAmount;
uniform float uShoulder;

// Input and output are display-referred (sRGB encoded) values.
vec3 sanctumGrade( vec3 c ) {

  // --- 3D LUT look (tetrahedral-free hardware trilinear, half-texel inset) ---
  if ( uLutStrength > 0.0 ) {
    float px = 1.0 / uLutSize;
    vec3 uvw = vec3( 0.5 * px ) + sat3( c ) * ( 1.0 - px );
    vec3 graded = texture( uLut, uvw ).rgb;
    c = mix( c, graded, uLutStrength );
  }

  // --- pedestal + white point, with a soft floor instead of a hard clip ---
  float sc = 1.0 / max( uWhitePoint - uBlackPoint, 1e-3 );
  vec3 x = c * sc;
  float bp = uBlackPoint * sc;
  c = max( x - vec3( bp ), vec3( 0.0 ) ) + min( x, vec3( bp ) ) * uBlackSoft;

  // --- contrast around a low pivot so mid-tones stay heavy ---
  c = uPivot * pow( max( c / uPivot, vec3( 1e-4 ) ), vec3( uContrast ) );

  // --- shadow reconstruction: cold desaturated slate, never crushed black ---
  float l = luma( c );
  float sw = exp( -l / max( uShadowKnee, 1e-3 ) );
  c = mix( c, l * uSlate, uShadowChroma * sw );
  c *= 1.0 + uShadowLift * sw;

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
