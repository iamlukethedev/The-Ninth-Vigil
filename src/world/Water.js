/**
 * THE NINTH VIGIL — Water.js : every liquid surface in the game.
 *
 * Three liquids, one system:
 *
 *   • standing water — moor tarns and town puddles. Layered scrolling slope
 *     maps + real vertex displacement, Fresnel-weighted blend between a low-res
 *     planar reflection and a depth-absorbed body colour, a noise-broken
 *     shoreline with foam and a wet stone band beyond it, and worley caustics
 *     projected onto the submerged bed.
 *   • blood — dark, viscous, near-mirror wet, spreading from corpses over time
 *     and drying to a matte coagulated crust with a raised rim.
 *   • lava — basalt crust over a molten crack network, advected by domain-warped
 *     flow, emissive above 1.0 only in the cracks (so only lava blooms), rising
 *     heat glow, and real point lights registered with the Lighting module so it
 *     illuminates the geometry around it.
 *
 * Geometry strategy — every liquid body is a *clipped grid*: the terrain height
 * field is sampled on a regular lattice, cells that straddle the liquid level are
 * emitted, and the exact waterline is resolved per-pixel from an interpolated
 * depth attribute with a noise-broken discard. That gives sub-cell shorelines
 * with no stair-stepping, no z-fighting against the terrain, and one draw call
 * per liquid regardless of how many separate pools there are (the surface level
 * is baked per-vertex, so puddles at nine different heights still merge into a
 * single mesh).
 *
 * Materials are stock MeshStandard/MeshPhysical extended through a self-composing
 * onBeforeCompile, so Sky's height fog, Lighting's cascaded shadows and the
 * irradiance probe grid all still apply — a hand-rolled ShaderMaterial would
 * silently drop out of all three.
 *
 * Determinism: no Math.random, no Date.now. All noise is seeded, all animation
 * is a pure function of engine.clock.elapsed.
 */

import * as THREE from 'three';
import { makeRand } from '../core/Rand.js';

const SEED = 90210;
const RIPPLES = 8;               // ripple wavelet slots in the shader
const MAX_BLOOD = 26;
const WAVE_TILE = 6.0;           // metres covered by one wave-texture tile
const LAVA_TILE = 6.0;           // metres covered by one lava crust tile

/* scratch — module scope so the hot path never allocates */
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();

/* ------------------------------------------------------------------ *
 * shader plumbing
 * ------------------------------------------------------------------ */

/**
 * Publish onBeforeCompile as a self-composing accessor. CSM.setupMaterial,
 * Lighting.registerMaterial and Sky.applyFog all *assign* to it while calling
 * whatever was there before; an accessor that collects assignments into a list
 * (and swallows re-entry) is the only way all four hooks survive together.
 */
function chainOBC(material, mine, tag) {
  const externals = [];
  let rev = 0;
  let running = false;
  const composed = function (shader, renderer) {
    if (running) return;
    running = true;
    try {
      mine.call(this, shader, renderer);
      for (let i = 0; i < externals.length; i++) {
        try { externals[i].call(this, shader, renderer); } catch (e) {
          console.warn('[water] chained onBeforeCompile failed —', e?.message ?? e);
        }
      }
    } finally { running = false; }
  };
  Object.defineProperty(material, 'onBeforeCompile', {
    configurable: true,
    get() { return composed; },
    set(fn) {
      if (fn === composed || typeof fn !== 'function' || externals.indexOf(fn) !== -1) return;
      externals.push(fn);
      rev++;
      material.needsUpdate = true;
    },
  });
  material.customProgramCacheKey = function () {
    return `nona-${tag}-${rev}-${externals.length}`;
  };
}

/** Shared GLSL: slope decode, ripple wavelets, cheap value noise. */
const LQ_LIB = /* glsl */`
vec2 lqSlope( sampler2D tex, vec2 uv ) {
  return texture2D( tex, uv ).xy * 2.0 - 1.0;
}
void lqRipples( vec2 p, float t, inout vec2 slope ) {
  for ( int i = 0; i < ${RIPPLES}; i++ ) {
    vec4 R = uLqRipple[ i ];
    if ( R.w <= 0.0001 ) continue;
    float age = t - R.z;
    if ( age < 0.0 || age > 3.4 ) continue;
    vec2 d = p - R.xy;
    float r = length( d ) + 1e-4;
    if ( r > 5.2 ) continue;
    float front = age * 1.65;
    float x = r - front;
    float k = 13.0;
    float env = exp( -x * x * 3.2 ) * exp( -age * 0.78 ) * ( 1.0 - smoothstep( 0.4, 5.0, r ) );
    slope += ( d / r ) * ( R.w * 0.055 * k * env * cos( x * k ) );
  }
}
`;

/* ---- water ---- */

const WATER_VERT_PARS = /* glsl */`
attribute float aDepth;
uniform float uLqTime;
uniform vec4 uLqWaveDir[ 4 ];
uniform vec4 uLqWaveSpd;
varying vec3 vLqPos;
varying float vLqDepth;
varying vec2 vLqGrad;
`;

const WATER_VERT_BODY = /* glsl */`
#include <begin_vertex>
{
  vec2 wp = transformed.xz;
  float df = smoothstep( 0.0, 0.55, aDepth );
  float h = 0.0;
  vec2 g = vec2( 0.0 );
  for ( int i = 0; i < 4; i++ ) {
    vec2 dir = uLqWaveDir[ i ].xy;
    float k = uLqWaveDir[ i ].z;
    float a = uLqWaveDir[ i ].w;
    float ph = dot( dir, wp ) * k + uLqTime * uLqWaveSpd[ i ];
    h += a * sin( ph );
    g += dir * ( a * k * cos( ph ) );
  }
  transformed.y += h * df;
  vLqGrad = g * df;
  vLqDepth = aDepth;
  vLqPos = transformed;
}
`;

const WATER_FRAG_PARS = /* glsl */`
uniform sampler2D tLqWave;
uniform sampler2D tLqDetail;
uniform sampler2D tLqRefl;
uniform mat4 uLqReflMtx;
uniform vec4 uLqNrmScale;
uniform vec4 uLqNrmVel;
uniform vec4 uLqNrmAmp;
uniform vec4 uLqAbs;
uniform vec4 uLqFoam;
uniform vec4 uLqTint;
uniform vec3 uLqShallow;
uniform vec3 uLqDeep;
uniform vec3 uLqSky;
uniform float uLqTime;
uniform vec4 uLqRipple[ ${RIPPLES} ];
varying vec3 vLqPos;
varying float vLqDepth;
varying vec2 vLqGrad;

vec3 gLqN;
vec3 gLqBody;
float gLqAlpha;
float gLqRough;
float gLqFoam;
float gLqWet;

${LQ_LIB}

void lqSurface() {
  vec2 p = vLqPos.xz;
  float d = vLqDepth;
  float dist = length( cameraPosition - vLqPos );

  // Detail LOD: high-frequency slope is the main source of specular crawl at
  // range, so the fine layers fade out well before the pixel footprint eats them.
  float f2 = 1.0 - smoothstep( 24.0, 58.0, dist );
  float f3 = 1.0 - smoothstep( 8.0, 26.0, dist );

  vec2 sl = vLqGrad;
  sl += lqSlope( tLqWave, p * uLqNrmScale.x + uLqNrmVel.xy * uLqTime ) * uLqNrmAmp.x;
  sl += lqSlope( tLqWave, p * uLqNrmScale.y - uLqNrmVel.zw * uLqTime ) * ( uLqNrmAmp.y * f2 );
  sl += lqSlope( tLqWave, p.yx * uLqNrmScale.z + vec2( -uLqNrmVel.y, uLqNrmVel.x ) * uLqTime * 1.9 ) * ( uLqNrmAmp.z * f3 );

  vec4 det = texture2D( tLqDetail, p * uLqFoam.y );
  vec4 det2 = texture2D( tLqDetail, p * uLqFoam.y * 3.7 + vec2( 0.31, 0.62 ) );

  // rain stipple — dense fine chop plus expanding micro-rings
  if ( uLqNrmScale.w > 0.001 ) {
    float rt = fract( uLqTime * 1.7 + det2.a );
    float ring = exp( -pow( ( det2.b - rt ) * 7.0, 2.0 ) );
    sl += ( vec2( det2.r, det2.g ) - 0.5 ) * ( uLqNrmScale.w * ( 0.55 + 1.35 * ring ) ) * f3;
  }

  lqRipples( p, uLqTime, sl );

  float shoreFade = smoothstep( -0.02, 0.30, d );
  sl *= 0.20 + 0.80 * shoreFade;
  gLqN = normalize( vec3( -sl.x, 1.0, -sl.y ) );

  // ---- shoreline: noise-broken waterline, then a wet-stone band beyond it ----
  float edgeN = ( det.r - 0.5 ) * uLqFoam.w + ( det2.g - 0.5 ) * uLqFoam.w * 0.45;
  float band = uLqFoam.z;
  if ( d < -band + edgeN * band * 1.6 ) discard;

  float dd = max( d, 0.0 );
  gLqWet = 1.0 - smoothstep( 0.0, 0.045, dd );

  // ---- depth absorption: shallow reads as a tint, deep goes near-black ----
  float ext = 1.0 - exp( -dd * uLqAbs.x );
  gLqBody = mix( uLqShallow, uLqDeep, ext );
  float alpha = 1.0 - exp( -dd * uLqAbs.y );

  // ---- foam: shoreline wash + wave-crest whitecaps ----
  float shoreT = 1.0 - smoothstep( 0.0, uLqFoam.x, dd );
  float wash = 0.5 + 0.5 * sin( uLqTime * 0.62 + det.r * 7.4 + p.x * 0.11 - p.y * 0.07 );
  float fn = det.g * 0.7 + ( 1.0 - det.b ) * 0.5 + det2.g * 0.35;
  /* fn spans roughly 0.0-1.55 and the wash term 0.72-1.27, so the product sits
     above 1.04 nearly everywhere the shore band reaches — the old thresholds
     saturated foam to 1.0 around the ENTIRE waterline and drew a hard white
     outline round every pool. Pushing the knee up into the top of the noise
     range makes the wash patchy, which is what surf scum actually looks like. */
  float foam = smoothstep( 0.98, 1.46, shoreT * ( 0.42 + 0.86 * fn ) * ( 0.72 + 0.55 * wash ) );
  // Whitecaps need a real fetch. 0.55 caught ordinary ripple slope on a
  // sheltered tarn and speckled the whole body with white.
  float crest = smoothstep( 0.90, 1.75, length( sl ) ) * smoothstep( 0.35, 1.1, dd ) * det2.g;
  /* Was written as an expression whose && was actually a multiply feeding a
     comparison — it happened to evaluate correctly but read as a bug. Explicit. */
  foam = uLqFoam.x > 0.0 ? clamp( max( foam, crest * 0.42 ), 0.0, 1.0 ) : 0.0;
  gLqFoam = foam;

  // wet stone: darken and gloss the ground just above the waterline
  gLqBody = mix( gLqBody, uLqShallow * 0.34, gLqWet );
  alpha = mix( alpha, uLqTint.w, gLqWet * 0.9 );
  gLqBody = mix( gLqBody, uLqTint.xyz, foam );
  gLqAlpha = clamp( max( alpha, foam * 0.94 ), 0.0, 1.0 );

  /* A 0.030 floor is a mirror, and a mirror under four CSM cascade lights sharing
     one direction returns four stacked sun lobes: the glitter field blew to pure
     white across half the tarn. 0.038 keeps the lobe TIGHT — which is what makes
     the surviving glints small, hot and legible as sun on water rather than a
     milky sheet — while the range term spreads it enough to stop specular crawl
     at the far shore. */
  float rough = mix( 0.038, 0.150, smoothstep( 6.0, 62.0, dist ) );
  rough = mix( rough, 0.74, foam );
  // Wet stone above the waterline is DAMP, not varnished: at 0.115 the band round
  // every pool caught a full sky reflection and outlined it in white.
  rough = mix( rough, 0.34, gLqWet * 0.75 );
  gLqRough = rough;
}
`;

const WATER_FRAG_OUT = /* glsl */`
{
  vec3 V = normalize( cameraPosition - vLqPos );
  vec3 refl = uLqSky;
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    vec3 rdir = reflect( -V, gLqN );
    rdir.y = max( rdir.y, 0.012 );
    refl = textureCubeUV( envMap, rdir, 0.055 ).rgb * envMapIntensity;
  #endif
  if ( uLqTint.w > 0.001 ) {
    vec4 rc = uLqReflMtx * vec4( vLqPos, 1.0 );
    if ( rc.w > 0.001 ) {
      vec2 ruv = rc.xy / rc.w;
      ruv += gLqN.xz * uLqNrmAmp.w;
      vec2 cl = clamp( ruv, vec2( 0.002 ), vec2( 0.998 ) );
      float inside = 1.0 - smoothstep( 0.0, 0.035, length( ruv - cl ) );
      vec3 planar = texture2D( tLqRefl, cl ).rgb;
      refl = mix( refl, planar, clamp( uLqReflAmt * inside, 0.0, 1.0 ) );
    }
  }
  float F = 0.02 + 0.98 * pow( clamp( 1.0 - dot( V, gLqN ), 0.0, 1.0 ), 5.0 );
  F = clamp( F * uLqAbs.z + uLqAbs.w, 0.0, 1.0 ) * ( 1.0 - gLqFoam * 0.85 );
  outgoingLight = mix( totalDiffuse, refl, F ) + totalSpecular + totalEmissiveRadiance;
  gl_FragColor = vec4( outgoingLight, clamp( max( diffuseColor.a, F * 0.92 ), 0.0, 1.0 ) );
}
`;

/* ---- blood ---- */

const BLOOD_VERT_PARS = /* glsl */`
attribute vec4 aPool;
attribute float aSeed;
varying vec3 vBlPos;
varying vec4 vBlPool;
varying float vBlSeed;
`;

const BLOOD_VERT_BODY = /* glsl */`
#include <begin_vertex>
{
  float rr = clamp( length( transformed.xz - aPool.xy ) / max( aPool.z, 0.05 ), 0.0, 1.0 );
  transformed.y += ( 1.0 - rr * rr ) * 0.008;
  vBlPos = transformed;
  vBlPool = aPool;
  vBlSeed = aSeed;
}
`;

const BLOOD_FRAG_PARS = /* glsl */`
uniform sampler2D tLqDetail;
uniform float uBlTime;
uniform vec4 uBlParams;
varying vec3 vBlPos;
varying vec4 vBlPool;
varying float vBlSeed;

vec3 gBlN;
vec3 gBlCol;
float gBlAlpha;
float gBlRough;
float gBlDry;

void blSurface() {
  vec2 l = vBlPos.xz - vBlPool.xy;
  float rl = length( l );
  float r = rl / max( vBlPool.z, 0.05 );
  vec2 dir = rl > 1e-4 ? l / rl : vec2( 0.0, 1.0 );

  float age = max( uBlTime - vBlPool.w, 0.0 );
  float grow = 1.0 - exp( -age * uBlParams.x );
  gBlDry = smoothstep( uBlParams.y, uBlParams.z, age );

  vec2 uv = vBlPos.xz * 0.42 + vec2( vBlSeed, vBlSeed * 1.7 );
  vec4 d1 = texture2D( tLqDetail, uv );
  vec4 d2 = texture2D( tLqDetail, uv * 4.3 + 0.37 );

  // boundary: surface tension pushes a lobed, noisy edge — never a circle
  float bn = ( d1.r - 0.5 ) * 0.86 + ( d1.g - 0.5 ) * 0.34 + ( d2.r - 0.5 ) * 0.16;
  float edge = mix( 0.26, 1.0, grow ) * ( 1.0 + bn * 0.34 );
  float a = 1.0 - smoothstep( edge - 0.17, edge, r );
  if ( a < 0.015 ) discard;

  float rim = smoothstep( edge - 0.38, edge - 0.02, r );

  // coagulated rim rises; the pool interior is a nearly flat film
  vec2 sl = dir * ( rim * rim * 0.85 * ( 1.0 - gBlDry * 0.4 ) );
  sl += ( vec2( d2.r, d2.g ) - 0.5 ) * ( 0.10 + 0.26 * gBlDry );
  sl += ( vec2( d1.b, d1.a ) - 0.5 ) * 0.05;
  gBlN = normalize( vec3( -sl.x, 1.0, -sl.y ) );

  vec3 wetCol = vec3( 0.0490, 0.00520, 0.00430 );
  vec3 rimCol = vec3( 0.0255, 0.00700, 0.00560 );
  vec3 dryCol = vec3( 0.0175, 0.00700, 0.00560 );
  vec3 col = mix( wetCol, rimCol, rim * 0.82 );
  col = mix( col, dryCol, gBlDry );
  col *= 0.82 + 0.36 * d1.g;
  gBlCol = col;

  float rough = mix( 0.048, 0.60, gBlDry );
  rough = mix( rough, min( 1.0, rough + 0.26 ), rim * 0.75 );
  rough = mix( rough, min( 1.0, rough + 0.18 ), d2.b * 0.5 * gBlDry );
  gBlRough = rough;
  gBlAlpha = a * mix( 0.985, 0.86, gBlDry );
}
`;

const BLOOD_FRAG_OUT = /* glsl */`
{
  outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
  gl_FragColor = vec4( outgoingLight, diffuseColor.a );
}
`;

/* ---- lava ---- */

const LAVA_VERT_PARS = /* glsl */`
attribute float aDepth;
uniform float uLvTime;
varying vec3 vLvPos;
varying float vLvDepth;
`;

const LAVA_VERT_BODY = /* glsl */`
#include <begin_vertex>
{
  vec2 wp = transformed.xz;
  float df = smoothstep( 0.0, 0.7, aDepth );
  // very slow, very long swell — molten rock is viscous
  float h = sin( wp.x * 0.16 + uLvTime * 0.13 ) * 0.055
          + sin( wp.y * 0.21 - uLvTime * 0.097 ) * 0.042
          + sin( ( wp.x + wp.y ) * 0.09 + uLvTime * 0.061 ) * 0.075;
  transformed.y += h * df;
  vLvPos = transformed;
  vLvDepth = aDepth;
}
`;

const LAVA_FRAG_PARS = /* glsl */`
uniform sampler2D tLvCrust;
uniform sampler2D tLvNormal;
uniform sampler2D tLvORM;
uniform sampler2D tLvEmis;
uniform sampler2D tLqDetail;
uniform float uLvTime;
uniform vec4 uLvFlow;
uniform vec4 uLvHeat;
uniform vec3 uLvCool;
uniform vec3 uLvHot;
varying vec3 vLvPos;
varying float vLvDepth;

vec3 gLvN;
vec3 gLvCol;
vec3 gLvEmis;
float gLvRough;

void lvSurface() {
  vec2 p = vLvPos.xz * uLvFlow.x;
  float t = uLvTime;

  // domain-warped advection: two warp layers creeping at different rates make
  // the crust visibly flow instead of sliding as a rigid texture
  vec4 w1 = texture2D( tLqDetail, p * 0.21 + vec2( t * 0.0042, -t * 0.0031 ) );
  vec4 w2 = texture2D( tLqDetail, p * 0.63 - vec2( t * 0.0088, t * 0.0061 ) );
  vec2 warp = ( vec2( w1.r, w1.g ) - 0.5 ) * uLvFlow.y
            + ( vec2( w2.g, w2.r ) - 0.5 ) * uLvFlow.y * 0.42;
  vec2 drift = vec2( t * uLvFlow.z, t * uLvFlow.z * 0.55 );

  vec2 uv = p + warp + drift;
  vec2 uv2 = p * 2.9 + warp * 1.8 - drift * 1.7;

  vec3 alb = texture2D( tLvCrust, uv ).rgb;
  vec3 orm = texture2D( tLvORM, uv ).rgb;
  vec3 emA = texture2D( tLvEmis, uv ).rgb;
  vec3 emB = texture2D( tLvEmis, uv2 ).rgb;

  vec2 nA = texture2D( tLvNormal, uv ).xy * 2.0 - 1.0;
  vec2 nB = texture2D( tLvNormal, uv2 ).xy * 2.0 - 1.0;
  vec2 sl = nA * 1.0 + nB * 0.45;
  gLvN = normalize( vec3( -sl.x, 1.0, -sl.y ) );

  // temperature: baked crack emissive, modulated by the flow field so some
  // stretches have chilled over and others are freshly split open
  float band = 0.55 + 0.45 * sin( ( vLvPos.x * 0.07 + vLvPos.z * 0.05 ) - t * 0.11 + w1.r * 4.0 );
  float heat = max( emA.r, emA.g ) * ( 0.42 + 0.85 * band );
  heat += max( emB.r, emB.g ) * 0.30 * ( 0.5 + 0.7 * w2.g );
  // molten pools sit lowest: deep lava runs hotter than the thin crusted edge
  heat *= 0.34 + 0.9 * smoothstep( 0.02, 0.55, vLvDepth );
  heat = clamp( heat, 0.0, 1.6 );

  float hot = clamp( heat * uLvHeat.x, 0.0, 1.0 );
  float hot2 = hot * hot;
  vec3 grad = mix( uLvCool, uLvHot, pow( hot, 1.45 ) );
  grad = mix( grad, vec3( 1.0, 0.93, 0.76 ), smoothstep( 0.72, 1.0, hot ) * 0.75 );
  gLvEmis = grad * ( uLvHeat.y * hot2 * ( 0.14 + uLvHeat.z * hot2 ) );

  gLvCol = alb * ( 0.55 + 0.6 * orm.r ) + grad * hot2 * 0.05;
  gLvRough = clamp( mix( orm.g, 0.34, hot2 * 0.85 ), 0.06, 1.0 );

  // chilled rim where the flow laps against cold rock
  float rim = 1.0 - smoothstep( 0.0, 0.26, vLvDepth );
  gLvCol *= 1.0 - rim * 0.45;
  gLvEmis *= 1.0 - rim * 0.72;
  if ( vLvDepth < -0.02 - ( w2.r - 0.5 ) * 0.16 ) discard;
}
`;

const LAVA_FRAG_OUT = /* glsl */`
{
  outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;
  gl_FragColor = vec4( outgoingLight, 1.0 );
}
`;

/* ---- caustics (own material: additive, unlit) ---- */

const CAUSTIC_VS = /* glsl */`
attribute float aDepth;
varying vec3 vPos;
varying float vDepth;
void main() {
  vPos = position;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
}
`;

const CAUSTIC_FS = /* glsl */`
precision highp float;
uniform sampler2D tDetail;
uniform vec3 uColor;
uniform vec4 uParams;   // x scale, y speed, z depth falloff, w gain
uniform vec2 uFade;     // near/far distance fade
uniform float uTime;
varying vec3 vPos;
varying float vDepth;

float web( vec2 uv ) {
  float e = texture2D( tDetail, uv ).b;
  return pow( clamp( 1.0 - e, 0.0, 1.0 ), 5.5 );
}

void main() {
  if ( vDepth <= 0.005 ) discard;
  vec2 p = vPos.xz * uParams.x;
  float t = uTime * uParams.y;
  // two counter-drifting worley webs interfere — the classic caustic shimmer
  float c1 = web( p + vec2( t * 0.13, t * 0.09 ) );
  float c2 = web( p * 1.47 - vec2( t * 0.11, t * 0.16 ) );
  float c3 = web( p * 0.61 + vec2( -t * 0.07, t * 0.05 ) );
  float c = ( c1 * 0.75 + c2 * 0.6 ) * ( 0.35 + 0.9 * c3 );

  float depthAtt = exp( -vDepth * uParams.z ) * smoothstep( 0.0, 0.14, vDepth );
  float d = length( cameraPosition - vPos );
  float distFade = 1.0 - smoothstep( uFade.x, uFade.y, d );
  gl_FragColor = vec4( uColor * ( c * uParams.w * depthAtt * distFade ), 1.0 );
}
`;

/* ---- heat haze (own material: additive, unlit, rising plumes) ---- */

const HAZE_VS = /* glsl */`
attribute float aDepth;
uniform float uTime;
uniform float uLift;
varying vec3 vPos;
varying float vDepth;
void main() {
  vec3 pos = position;
  float sway = sin( pos.x * 0.35 + uTime * 0.7 ) * cos( pos.z * 0.29 - uTime * 0.53 );
  pos.y += uLift + sway * uLift * 0.35;
  pos.xz += vec2( sway, -sway ) * 0.22 * uLift;
  vPos = pos;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * vec4( pos, 1.0 );
}
`;

const HAZE_FS = /* glsl */`
precision highp float;
uniform sampler2D tDetail;
uniform vec3 uColor;
uniform vec3 uParams;  // x scale, y rise speed, z gain
uniform vec2 uFade;
uniform float uTime;
varying vec3 vPos;
varying float vDepth;
void main() {
  if ( vDepth <= 0.02 ) discard;
  vec2 p = vPos.xz * uParams.x;
  float t = uTime * uParams.y;
  vec4 a = texture2D( tDetail, p + vec2( 0.0, -t ) );
  vec4 b = texture2D( tDetail, p * 2.3 + vec2( t * 0.31, -t * 1.6 ) );
  float n = a.r * 0.7 + b.g * 0.55;
  n = pow( clamp( n * 1.25 - 0.35, 0.0, 1.0 ), 1.9 );
  float body = smoothstep( 0.05, 0.55, vDepth );
  float d = length( cameraPosition - vPos );
  float fade = 1.0 - smoothstep( uFade.x, uFade.y, d );
  gl_FragColor = vec4( uColor * ( n * uParams.z * body * fade ), 1.0 );
}
`;

/* ------------------------------------------------------------------ *
 * procedural textures
 * ------------------------------------------------------------------ */

/**
 * Tileable wave slope field. A sum of sinusoids on integer wave vectors with a
 * k^-1.35 amplitude spectrum — i.e. a real (if crude) capillary-wave spectrum,
 * which is why it reads as water instead of as noise. RG hold the analytic
 * slope, B the height, A a decorrelated phase field.
 */
function buildWaveTexture(size, seed) {
  const rnd = makeRand(seed);
  const NW = 30;
  const kx = new Int32Array(NW), kz = new Int32Array(NW);
  const am = new Float32Array(NW), ph = new Float32Array(NW);
  for (let i = 0; i < NW; i++) {
    const t = i / (NW - 1);
    const mag = 1 + Math.round(Math.pow(t, 1.6) * 13);
    const ang = rnd() * Math.PI * 2;
    // squash the angular spread so the field has a dominant swell direction
    let dx = Math.cos(ang) * 0.55 + 0.45;
    let dz = Math.sin(ang);
    const L = Math.hypot(dx, dz) || 1;
    let ix = Math.round((dx / L) * mag);
    let iz = Math.round((dz / L) * mag);
    if (ix === 0 && iz === 0) ix = 1;
    kx[i] = ix; kz[i] = iz;
    am[i] = 1 / Math.pow(Math.hypot(ix, iz), 1.35);
    ph[i] = rnd() * Math.PI * 2;
  }

  const TAU = Math.PI * 2;
  // separable trig tables: sin(A+B) expansion turns 26 transcendentals per
  // pixel into 4 multiplies, which is the difference between 40 ms and 400 ms.
  const SA = new Float32Array(NW * size), CA = new Float32Array(NW * size);
  for (let i = 0; i < NW; i++) {
    for (let x = 0; x < size; x++) {
      const a = TAU * kx[i] * ((x + 0.5) / size);
      SA[i * size + x] = Math.sin(a);
      CA[i * size + x] = Math.cos(a);
    }
  }
  const sb = new Float32Array(NW), cb = new Float32Array(NW);
  const n = size * size;
  const hh = new Float32Array(n), gx = new Float32Array(n), gz = new Float32Array(n);
  let maxG = 1e-6;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let i = 0; i < NW; i++) {
      const b = TAU * kz[i] * v + ph[i];
      sb[i] = Math.sin(b); cb[i] = Math.cos(b);
    }
    const row = y * size;
    for (let x = 0; x < size; x++) {
      let h = 0, dx = 0, dz = 0;
      for (let i = 0; i < NW; i++) {
        const o = i * size + x;
        const s = SA[o] * cb[i] + CA[o] * sb[i];
        const c = CA[o] * cb[i] - SA[o] * sb[i];
        const a = am[i];
        h += a * s;
        dx += a * TAU * kx[i] * c;
        dz += a * TAU * kz[i] * c;
      }
      const k = row + x;
      hh[k] = h; gx[k] = dx; gz[k] = dz;
      const m = dx * dx + dz * dz;
      if (m > maxG) maxG = m;
    }
  }
  const invG = 1 / (Math.sqrt(maxG) * 0.55);
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < n; i++) { if (hh[i] < hMin) hMin = hh[i]; if (hh[i] > hMax) hMax = hh[i]; }
  const invH = 1 / Math.max(1e-5, hMax - hMin);

  const data = new Uint8Array(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const sx = Math.max(-1, Math.min(1, gx[i] * invG));
    const sz = Math.max(-1, Math.min(1, gz[i] * invG));
    data[o] = (sx * 0.5 + 0.5) * 255;
    data[o + 1] = (sz * 0.5 + 0.5) * 255;
    data[o + 2] = (hh[i] - hMin) * invH * 255;
    data[o + 3] = ((hh[i] - hMin) * invH * 3.37 % 1) * 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = 'nona.waveSlope';
  return tex;
}

/**
 * Fallback 4-channel noise for when AssetForge is unavailable. Same channel
 * contract as `assets.noiseTexture`: R fbm, G high-frequency fbm, B cellular
 * edge, A white.
 */
function buildFallbackDetail(size, seed) {
  const rnd = makeRand(seed);
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const P = 8;
  const grid = new Float32Array(P * P);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const smp = (u, v, f) => {
    const x = u * f, y = v * f;
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = x - xi, ty = y - yi;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const g = (a, b) => grid[(((b % P) + P) % P) * P + (((a % P) + P) % P)];
    const a0 = g(xi, yi), b0 = g(xi + 1, yi), c0 = g(xi, yi + 1), d0 = g(xi + 1, yi + 1);
    return (a0 + (b0 - a0) * sx) + ((c0 + (d0 - c0) * sx) - (a0 + (b0 - a0) * sx)) * sy;
  };
  for (let y = 0, i = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++, i++) {
      const u = (x + 0.5) / size;
      const o = i * 4;
      data[o] = (smp(u, v, 4) * 0.6 + smp(u, v, 8) * 0.4) * 255;
      data[o + 1] = smp(u, v, 8) * 255;
      data[o + 2] = Math.abs(smp(u, v, 8) - 0.5) * 2 * 255;
      data[o + 3] = smp(u, v, 8) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  tex.name = 'nona.lqDetailFallback';
  return tex;
}

/**
 * AssetForge generator for basalt crust over molten cracks. Registered rather
 * than hand-rolled so the shared wear pass (cavity AO, ash grime, Sobel
 * normals from the grime-filled height) runs over it exactly as it does for
 * every other surface in the game.
 */
function lavaCrustGen(ctx, T) {
  const { size, n, seed } = ctx;
  const P = ctx.params;

  // 6 plates + 19 sub-plates across one tile: at LAVA_TILE = 6 m that puts a
  // basalt slab at ~1 m and the crackle at ~0.3 m, which is the observed scale.
  const [plateEdge, plateId, fineEdge, flow, vesicle] = T.fieldN(size, 2, 5, (u, v, out) => {
    T.warpT(u * 6, v * 6, 6, 6, seed + 17, 0.85, 3);
    const wu = T.WP.x, wv = T.WP.y;
    T.worleyT(wu, wv, 6, 6, seed + 3);
    out[0] = T.WK.edge;
    out[1] = T.WK.id;
    T.worleyT(wu * 3.1667 + 0.31, wv * 3.1667 - 0.19, 19, 19, seed + 41);
    out[2] = T.WK.edge;
    out[3] = T.fbmT(u * 2.2, v * 2.2, 2, 2, 4, 0.52, seed + 77);
    out[4] = T.fbmT(u * 26, v * 26, 26, 26, 3, 0.6, seed + 131);
  });

  const h = ctx.h, cr = ctx.cr, cg = ctx.cg, cb = ctx.cb, rg = ctx.rg, gm = ctx.gm;
  const em = ctx.emissive();

  for (let i = 0; i < n; i++) {
    const crackBig = 1 - T.smoothstep(0.0, 0.115, plateEdge[i]);
    const crackFine = 1 - T.smoothstep(0.0, 0.085, fineEdge[i]);
    const f = flow[i];
    const ves = vesicle[i];

    // crust height: slabs sit proud, cracks cut down between them
    const slab = 0.52 + plateId[i] * 0.26 + ves * 0.12;
    let hv = slab - crackBig * 0.62 - crackFine * 0.20;
    hv -= T.smoothstep(0.55, 1.0, ves) * 0.06;
    h[i] = hv;

    // heat: big cracks are open, fine crackle only glows where the flow is fresh
    let heat = crackBig * (0.55 + 0.55 * T.smoothstep(0.30, 0.85, f));
    heat += crackFine * 0.42 * T.smoothstep(0.42, 0.95, f);
    heat = T.clamp01(heat);
    const hot = Math.pow(heat, 1.35);

    // basalt: near-black with a cold violet cast, warming toward the cracks
    const base = 0.017 + ves * 0.016 + plateId[i] * 0.010;
    cr[i] = base * 1.10 + hot * 0.075;
    cg[i] = base * 0.94 + hot * 0.016;
    cb[i] = base * 1.02 + hot * 0.006;

    rg[i] = 0.94 - hot * 0.52 - ves * 0.06;
    ctx.mt[i] = 0;

    // ash settles on the slab tops, not in the glowing cracks
    gm[i] = T.clamp01((hv - 0.35) * 1.8) * (1 - heat) * 0.9;

    // emissive carries colour × temperature; the shader recovers heat from it
    const e = i * 3;
    const t2 = T.clamp01(heat * 1.15);
    em[e] = (0.42 + 0.58 * t2) * t2;
    em[e + 1] = (0.055 + 0.62 * t2 * t2) * t2;
    em[e + 2] = (0.008 + 0.30 * Math.pow(t2, 4)) * t2;
  }

  P.normalStrength = 1.5;
  P.aoStrength = 1.05;
  P.cavity1 = 1.15;
  P.cavity2 = 0.9;
  P.grimeAmount = 0.42;
  P.grimeCavity = 0.0;
  P.grimeColor = [0.075, 0.070, 0.068];
  P.grimeRough = 0.97;
  P.grimeFill = 0.22;
  P.cavityTint = 0.30;
  P.roughMin = 0.14;
  P.displacement = 0.22;
}

/* ------------------------------------------------------------------ *
 * Water module
 * ------------------------------------------------------------------ */

export class Water {
  static id = 'water';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;
    this.kind = 'none';                 // 'water' | 'lava' | 'none'

    this.group = new THREE.Group();
    this.group.name = 'Liquids';
    this.group.matrixAutoUpdate = false;

    /** @type {{cx:number,cz:number,r:number,r2:number,level:number}[]} */
    this.bodies = [];
    /** @type {{x:number,y:number,z:number,r:number,birth:number,seed:number}[]} */
    this.pools = [];

    this._tex = { wave: null, detail: null, lava: null };
    this._mats = { water: null, caustic: null, blood: null, lava: null, haze: null };
    this._meshes = { water: null, caustic: null, blood: null, lava: null, haze: [] };
    this._geo = { water: null, caustic: null, blood: null, lava: null };

    this._ripples = [];
    for (let i = 0; i < RIPPLES; i++) this._ripples.push(new THREE.Vector4(0, 0, -99, 0));
    this._rippleNext = 0;

    this._refl = null;
    this._shadowsOk = false;
    this._reflCam = new THREE.PerspectiveCamera();
    this._reflMtx = new THREE.Matrix4();
    this._reflLevel = 0;
    this._reflFade = 0;
    this._reflWant = false;
    this._reflFrame = -1;

    this._torches = [];
    this._actors = [];
    this._samplePts = [];
    this._ambientSlot = -1;
    this._rain = 0;
    this._offs = [];
    this._registered = new Set();
    this._deathCount = 0;
    this.__dead = false;
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    const e = this.engine;
    try {
      const low = e.quality?.tier === 'low';

      this._tex.wave = buildWaveTexture(low ? 128 : 256, SEED + 11);
      this._tex.detail = this._detailTexture(low ? 128 : 256);

      try { e.assets?.register?.('nonaLavaCrust', lavaCrustGen); } catch { /* forge absent */ }

      this._mats.water = this._makeWaterMaterial();
      this._mats.caustic = this._makeCausticMaterial();
      this._mats.blood = this._makeBloodMaterial();

      e.scene.add(this.group);

      this._offs.push(e.bus.on('death', (p) => this._onDeath(p)));
      this._offs.push(e.bus.on('weather:set', (p) => this._onWeather(p)));

      this.enabled = true;
    } catch (err) {
      console.error('[water] init failed, module disabled —', err);
      this.__dead = true;
      this.enabled = false;
    }
  }

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* noop */ } }
    this._offs.length = 0;
    this._clearTorches();
    try { this.group.removeFromParent(); } catch { /* noop */ }
    for (const k in this._geo) { try { this._geo[k]?.dispose(); } catch { /* noop */ } }
    for (const k in this._mats) {
      const m = this._mats[k];
      try { this.engine.get('lighting')?.unregisterMaterial?.(m); } catch { /* noop */ }
      try { m?.dispose(); } catch { /* noop */ }
    }
    for (const k in this._tex) { try { this._tex[k]?.dispose?.(); } catch { /* noop */ } }
    try { this._refl?.dispose(); } catch { /* noop */ }
    this._refl = null;
    this.enabled = false;
  }

  resize(w, h) {
    if (!this._refl || !w || !h) return;
    const base = this._reflBase();
    const rh = Math.max(128, Math.min(base, Math.round((base * h) / w)));
    if (this._refl.width !== base || this._refl.height !== rh) {
      this._refl.setSize(base, rh);
      this._reflFade = 0;
    }
  }

  _reflBase() {
    const t = this.engine.quality?.tier ?? 'ultra';
    return t === 'low' ? 0 : t === 'med' ? 256 : 512;
  }

  /* ================================================================ *
   * scenario
   * ================================================================ */

  applyScenario(name, cfg) {
    if (this.__dead || !this.enabled) return;
    const env = cfg?.env ?? {};
    const biome = env.biome ?? 'moor';
    this._rain = env.weather === 'rain' || env.weather === 'storm' ? 1 : 0;

    try {
      this._clearLiquid();
      this._clearBlood();

      if (biome === 'moor' || biome === 'town') {
        this.kind = 'water';
        this._buildWater(biome, name);
      } else if (biome === 'hell') {
        this.kind = 'lava';
        this._buildLava(name);
      } else {
        this.kind = 'none';
      }

      if (biome === 'crypt') this._seedBlood(name);
      this._tuneWaterLook(biome, env, name);
    } catch (err) {
      console.error('[water] applyScenario failed —', err);
      this._clearLiquid();
      this.kind = 'none';
    }
  }

  /* ================================================================ *
   * frame
   * ================================================================ */

  update(dt, elapsed) {
    if (this.__dead || !this.enabled) return;
    const t = elapsed;

    if (this._mats.water) {
      const U = this._mats.water.userData.lqU;
      U.uLqTime.value = t;
      U.uLqNrmScale.value.w = this._rain * 0.5;
    }
    if (this._mats.lava) this._mats.lava.userData.lqU.uLvTime.value = t;
    if (this._mats.blood) this._mats.blood.userData.lqU.uBlTime.value = t;
    if (this._mats.caustic) this._mats.caustic.uniforms.uTime.value = t;
    if (this._mats.haze) this._mats.haze.uniforms.uTime.value = t;

    if (this.kind === 'water' && this.bodies.length) {
      this._trackActors(t);
      this._ambientRipple(t);
      this._renderReflection();
    }
    this._tickTorches(t);
  }

  /* ================================================================ *
   * public API
   * ================================================================ */

  /** Liquid surface level at a world XZ, or null when there is no liquid. */
  levelAt(x, z) {
    let best = null;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const dx = x - b.cx, dz = z - b.cz;
      if (dx * dx + dz * dz > b.r2) continue;
      if (best === null || b.level > best) best = b.level;
    }
    return best;
  }

  /** Liquid depth at a world XZ (0 when dry). */
  depthAt(x, z) {
    const l = this.levelAt(x, z);
    if (l === null) return 0;
    const t = this.engine.get('terrain');
    let g = 0;
    try { g = t?.heightAt ? t.heightAt(x, z) : 0; } catch { g = 0; }
    return Math.max(0, l - g);
  }

  /** True where an actor would be standing in liquid. */
  isLiquid(x, z, min = 0.02) { return this.depthAt(x, z) > min; }

  /** Inject an expanding ripple wavelet. `amp` is roughly 0..1.5. */
  addRipple(x, z, amp = 1, time = null) {
    if (!this._ripples.length) return;
    const t = time === null ? this.engine.clock.elapsed : time;
    const slot = this._ripples[this._rippleNext % this._ripples.length];
    this._rippleNext++;
    slot.set(x, z, t, Math.max(0, Math.min(1.6, amp)));
  }

  /**
   * Pool blood on the ground. Grows outward from nothing, then coagulates and
   * dries. Safe to call every frame; nearby pools merge instead of stacking.
   */
  addBloodPool(position, radius = 0.9) {
    if (this.__dead || !this._mats.blood) return null;
    try {
      const x = position?.x ?? position?.[0] ?? 0;
      const z = position?.z ?? position?.[2] ?? 0;
      const r = Math.max(0.25, Math.min(3.2, radius));
      const t = this.engine.clock.elapsed;

      // merge into a neighbour rather than layering two coplanar films
      for (let i = 0; i < this.pools.length; i++) {
        const p = this.pools[i];
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < (p.r * 0.75) ** 2) {
          p.r = Math.min(3.4, Math.max(p.r, r) * 1.12);
          p.birth = Math.min(p.birth, t - 0.4);
          this._rebuildBlood();
          return p;
        }
      }

      const terrain = this.engine.get('terrain');
      let y = position?.y ?? 0;
      try { if (terrain?.heightAt) y = terrain.heightAt(x, z); } catch { /* keep given y */ }

      const pool = { x, y, z, r, birth: t, seed: ((this.pools.length * 37 + 11) % 97) / 97 };
      if (this.pools.length >= MAX_BLOOD) this.pools.shift();
      this.pools.push(pool);
      this._rebuildBlood();
      return pool;
    } catch (e) {
      console.warn('[water] addBloodPool —', e?.message ?? e);
      return null;
    }
  }

  get bloodCount() { return this.pools.length; }

  /* ================================================================ *
   * bus
   * ================================================================ */

  _onDeath(p) {
    if (this.__dead) return;
    try {
      const ent = p?.entity;
      const pt = p?.hitPoint ?? ent?.position ?? ent?.root?.position ?? ent?.group?.position ?? null;
      if (!pt) return;
      this._deathCount++;
      const scale = ent?.scale?.x ?? ent?.size ?? 1;
      const r = 0.62 + Math.min(1.6, Math.max(0.4, scale)) * 0.5;
      this.addBloodPool(pt, r);
    } catch (e) {
      console.warn('[water] death handler —', e?.message ?? e);
    }
  }

  _onWeather(p) {
    const kind = p?.kind ?? 'clear';
    const inten = typeof p?.intensity === 'number' ? Math.max(0, Math.min(1, p.intensity)) : 1;
    this._rain = (kind === 'rain' || kind === 'storm') ? inten : 0;
  }

  /* ================================================================ *
   * textures + materials
   * ================================================================ */

  _detailTexture(size) {
    try {
      const t = this.engine.assets?.noiseTexture?.(size, SEED + 5);
      if (t && t.isTexture) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        return t;
      }
    } catch { /* fall through */ }
    return buildFallbackDetail(size, SEED + 5);
  }

  _lavaMaps() {
    if (this._tex.lava) return this._tex.lava;
    let maps = null;
    try {
      maps = this.engine.assets?.pbr?.({
        kind: 'nonaLavaCrust', size: this.engine.quality?.tier === 'low' ? 256 : 512,
        seed: SEED + 23, tiling: 1,
      });
    } catch (e) {
      console.warn('[water] lava crust generation failed —', e?.message ?? e);
    }
    if (!maps || !maps.map) {
      // Degrade to the shared detail noise rather than dropping lava entirely.
      const d = this._tex.detail;
      maps = { map: d, normalMap: d, ormMap: d, emissiveMap: d };
    }
    for (const k of ['map', 'normalMap', 'ormMap', 'emissiveMap']) {
      const t = maps[k];
      if (t && t.isTexture) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
    }
    this._tex.lava = maps;
    return maps;
  }

  _makeWaterMaterial() {
    const U = {
      tLqWave: { value: this._tex.wave },
      tLqDetail: { value: this._tex.detail },
      tLqRefl: { value: null },
      uLqReflMtx: { value: this._reflMtx },
      uLqReflAmt: { value: 0 },
      uLqTime: { value: 0 },
      // xyz = 1/metres per tile for the three slope layers, w = rain amount
      uLqNrmScale: { value: new THREE.Vector4(1 / WAVE_TILE, 1 / (WAVE_TILE * 0.28), 1 / (WAVE_TILE * 0.085), 0) },
      uLqNrmVel: { value: new THREE.Vector4(0.0075, 0.0042, -0.0135, 0.0091) },
      // xyz = slope amplitude per layer, w = reflection distortion in UV
      uLqNrmAmp: { value: new THREE.Vector4(0.30, 0.20, 0.11, 0.030) },
      // x colour extinction, y opacity extinction, z fresnel gain, w fresnel floor
      uLqAbs: { value: new THREE.Vector4(2.6, 3.1, 1.0, 0.10) },
      // x foam band depth, y detail tiling, z wet band, w waterline noise
      uLqFoam: { value: new THREE.Vector4(0.22, 1 / 5.5, 0.055, 0.55) },
      // xyz foam albedo, w wet-band alpha
      uLqTint: { value: new THREE.Vector4(0.28, 0.28, 0.265, 0.42) },
      uLqShallow: { value: new THREE.Color(0.085, 0.098, 0.080) },
      uLqDeep: { value: new THREE.Color(0.0055, 0.0090, 0.0105) },
      uLqSky: { value: new THREE.Color(0.055, 0.065, 0.085) },
      uLqWaveDir: {
        value: [
          new THREE.Vector4(0.94, 0.34, 1.35, 0.048),
          new THREE.Vector4(-0.52, 0.85, 2.30, 0.026),
          new THREE.Vector4(0.36, -0.93, 3.90, 0.014),
          new THREE.Vector4(-0.88, -0.47, 6.30, 0.007),
        ],
      },
      uLqWaveSpd: { value: new THREE.Vector4(1.05, -1.45, 2.10, -2.85) },
      uLqRipple: { value: this._ripples },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      /* DOUBLE-COUNTED REFLECTION. WATER_FRAG_OUT already computes the
         environment term itself — Fresnel-weighted, planar-reflection-blended —
         and then adds three's own `totalSpecular` on top, which for a roughness
         0.03 surface is essentially a second full mirror of the IBL probe. The
         exterior probe is a 1.5-2.5 linear overcast dome, so at 1.25 the pools
         came out at twice the reflectance of real water and read as panes of
         frosted glass. Keep only enough IBL for the sun/sky GLINT on the ripple
         crests; the broad reflection is the custom path's job. */
      envMapIntensity: 0.12,
      dithering: true,
      fog: true,
      premultipliedAlpha: false,
    });
    mat.name = 'NonaWater';

    chainOBC(mat, (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WATER_VERT_PARS}`)
        .replace('#include <begin_vertex>', WATER_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uLqReflAmt;\n${WATER_FRAG_PARS}`)
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n  lqSurface();\n  diffuseColor.rgb = gLqBody;\n  diffuseColor.a = gLqAlpha;')
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = gLqRough;')
        .replace('#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n  normal = normalize( ( viewMatrix * vec4( gLqN, 0.0 ) ).xyz );')
        .replace('#include <opaque_fragment>', WATER_FRAG_OUT);
    }, 'water');

    mat.userData.lqU = U;
    return mat;
  }

  _makeBloodMaterial() {
    const U = {
      tLqDetail: { value: this._tex.detail },
      uBlTime: { value: 0 },
      // x spread rate, y dry start, z dry end, w spare
      uBlParams: { value: new THREE.Vector4(0.62, 16.0, 78.0, 0) },
    };
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.06,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.07,
      transparent: true,
      depthWrite: false,
      envMapIntensity: 1.4,
      dithering: true,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    mat.name = 'NonaBlood';

    chainOBC(mat, (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BLOOD_VERT_PARS}`)
        .replace('#include <begin_vertex>', BLOOD_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${BLOOD_FRAG_PARS}`)
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n  blSurface();\n  diffuseColor.rgb = gBlCol;\n  diffuseColor.a = gBlAlpha;')
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = gBlRough;')
        .replace('#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n  normal = normalize( ( viewMatrix * vec4( gBlN, 0.0 ) ).xyz );')
        .replace('#include <clearcoat_normal_fragment_maps>',
          '#include <clearcoat_normal_fragment_maps>\n  clearcoatNormal = normal;')
        // `material` is declared by <lights_physical_fragment>, which comes AFTER
        // the clearcoat-normal chunks. Writing the field any earlier is a link
        // error ("'material' : undeclared identifier") and the whole blood
        // material silently falls back to an invalid program.
        .replace('#include <lights_physical_fragment>',
          '#include <lights_physical_fragment>\n  material.clearcoatRoughness = mix( 0.055, 0.55, gBlDry );')
        .replace('#include <opaque_fragment>', BLOOD_FRAG_OUT);
    }, 'blood');

    mat.userData.lqU = U;
    return mat;
  }

  _makeLavaMaterial() {
    const maps = this._lavaMaps();
    const U = {
      tLvCrust: { value: maps.map },
      tLvNormal: { value: maps.normalMap },
      tLvORM: { value: maps.ormMap ?? maps.roughnessMap },
      tLvEmis: { value: maps.emissiveMap ?? maps.map },
      tLqDetail: { value: this._tex.detail },
      uLvTime: { value: 0 },
      // x = 1/tile metres, y = warp amount, z = drift rate, w spare
      uLvFlow: { value: new THREE.Vector4(1 / LAVA_TILE, 0.085, 0.0032, 0) },
      // x heat gain, y emissive base, z emissive peak, w spare
      uLvHeat: { value: new THREE.Vector4(1.35, 0.75, 8.5, 0) },
      uLvCool: { value: new THREE.Color(0.55, 0.075, 0.018) },
      uLvHot: { value: new THREE.Color(1.0, 0.52, 0.115) },
    };

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      emissive: 0xffffff,
      emissiveIntensity: 1.0,
      envMapIntensity: 0.35,
      dithering: true,
      fog: true,
    });
    mat.name = 'NonaLava';

    chainOBC(mat, (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${LAVA_VERT_PARS}`)
        .replace('#include <begin_vertex>', LAVA_VERT_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${LAVA_FRAG_PARS}`)
        .replace('#include <map_fragment>',
          '#include <map_fragment>\n  lvSurface();\n  diffuseColor.rgb = gLvCol;')
        .replace('#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = gLvRough;')
        .replace('#include <normal_fragment_maps>',
          '#include <normal_fragment_maps>\n  normal = normalize( ( viewMatrix * vec4( gLvN, 0.0 ) ).xyz );')
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n  totalEmissiveRadiance = gLvEmis;')
        .replace('#include <opaque_fragment>', LAVA_FRAG_OUT);
    }, 'lava');

    mat.userData.lqU = U;
    return mat;
  }

  _makeCausticMaterial() {
    return new THREE.ShaderMaterial({
      name: 'NonaCaustics',
      vertexShader: CAUSTIC_VS,
      fragmentShader: CAUSTIC_FS,
      uniforms: {
        tDetail: { value: this._tex.detail },
        uColor: { value: new THREE.Color(0.30, 0.36, 0.34) },
        uParams: { value: new THREE.Vector4(1 / 3.2, 0.85, 1.55, 1.0) },
        uFade: { value: new THREE.Vector2(30, 66) },
        uTime: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      userData: { skyNoFog: true, noCSM: true },
    });
  }

  _makeHazeMaterial() {
    return new THREE.ShaderMaterial({
      name: 'NonaHeatHaze',
      vertexShader: HAZE_VS,
      fragmentShader: HAZE_FS,
      uniforms: {
        tDetail: { value: this._tex.detail },
        uColor: { value: new THREE.Color(0.55, 0.20, 0.055) },
        uParams: { value: new THREE.Vector3(1 / 5.5, 0.055, 0.55) },
        uFade: { value: new THREE.Vector2(34, 78) },
        uTime: { value: 0 },
        uLift: { value: 0.6 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
      userData: { skyNoFog: true, noCSM: true },
    });
  }

  /** Hook a material into cascaded shadows, the probe grid and height fog. */
  _integrate(mat) {
    if (!mat || this._registered.has(mat)) return;
    this._registered.add(mat);
    try { this.engine.get('lighting')?.registerMaterial?.(mat); } catch (e) {
      console.warn('[water] lighting.registerMaterial —', e?.message ?? e);
    }
    try { this.engine.get('sky')?.applyFog?.(mat); } catch (e) {
      console.warn('[water] sky.applyFog —', e?.message ?? e);
    }
  }

  /* ================================================================ *
   * body layout
   * ================================================================ */

  _terrainHeight(x, z) {
    const t = this._terrain;
    if (!t) return 0;
    const h = t.heightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _grabTerrain() {
    const t = this.engine.get('terrain');
    this._terrain = (t && !t.__dead && typeof t.heightAt === 'function') ? t : null;
    return this._terrain;
  }

  /** Height at the given percentile within `radius` of the origin. */
  _percentileHeight(radius, pct, step = 2.0) {
    const vals = [];
    for (let z = -radius; z <= radius; z += step) {
      for (let x = -radius; x <= radius; x += step) {
        if (x * x + z * z > radius * radius) continue;
        vals.push(this._terrainHeight(x, z));
      }
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    const i = Math.max(0, Math.min(vals.length - 1, Math.round(pct * (vals.length - 1))));
    return vals[i];
  }

  /** Discrete depressions for puddles — verified local minima, well separated. */
  _findHollows(count, seed, minSep, probeR) {
    const t = this._terrain;
    const out = [];
    if (!t) return out;
    const accept = (x, z) => {
      const c = this._terrainHeight(x, z);
      let sum = 0, n = 0, worst = -1e9;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const h = this._terrainHeight(x + Math.cos(a) * probeR, z + Math.sin(a) * probeR);
        sum += h; n++;
        if (h > worst) worst = h;
      }
      const mean = sum / n;
      if (mean - c < 0.045) return null;
      const rise = Math.min(worst - c, mean - c + 0.14);
      return { c, rise };
    };

    let pts = [];
    try {
      pts = t.sampleScatterPoints?.(count * 6, seed, (v, info) => info.slope < 0.30 && info.walkable) ?? [];
    } catch { pts = []; }
    if (!pts.length) {
      const rnd = this.engine.freshRand(seed);
      for (let i = 0; i < count * 8; i++) {
        pts.push(new THREE.Vector3((rnd() - 0.5) * 70, 0, (rnd() - 0.5) * 70));
      }
    }

    for (const p of pts) {
      if (out.length >= count) break;
      if (Math.hypot(p.x, p.z) > 52) continue;
      let ok = true;
      for (const o of out) {
        if ((o.cx - p.x) ** 2 + (o.cz - p.z) ** 2 < minSep * minSep) { ok = false; break; }
      }
      if (!ok) continue;
      const a = accept(p.x, p.z);
      if (!a) continue;
      const r = 1.9 + a.rise * 6.5;
      out.push({
        cx: p.x, cz: p.z,
        r: Math.min(5.4, r), r2: Math.min(5.4, r) ** 2,
        level: a.c + Math.min(0.20, 0.055 + a.rise * 0.45),
      });
    }
    return out;
  }

  /* ================================================================ *
   * mesh construction
   * ================================================================ */

  /**
   * Clip a lattice against the liquid level. Returns geometry for the surface
   * and (optionally) for the submerged bed, both baked in world space so a
   * single mesh can carry pools sitting at different levels.
   */
  _buildClippedGrid(bodies, cell, wantBed, shoreSlack = 0.22) {
    if (!bodies.length) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of bodies) {
      if (b.cx - b.r < minX) minX = b.cx - b.r;
      if (b.cx + b.r > maxX) maxX = b.cx + b.r;
      if (b.cz - b.r < minZ) minZ = b.cz - b.r;
      if (b.cz + b.r > maxZ) maxZ = b.cz + b.r;
    }
    const pad = cell * 2;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;

    let step = cell;
    let nx = Math.ceil((maxX - minX) / step);
    let nz = Math.ceil((maxZ - minZ) / step);
    // Hard lattice ceiling: coarsen rather than allocate a monster grid.
    while ((nx + 1) * (nz + 1) > 320000) {
      step *= 1.35;
      nx = Math.ceil((maxX - minX) / step);
      nz = Math.ceil((maxZ - minZ) / step);
    }
    const gw = nx + 1, gh = nz + 1;
    const total = gw * gh;

    const margin = step * 2.2;
    const lvl = new Float32Array(total);
    const dep = new Float32Array(total);
    const gnd = new Float32Array(total);
    const has = new Uint8Array(total);

    for (let j = 0; j < gh; j++) {
      const z = minZ + j * step;
      for (let i = 0; i < gw; i++) {
        const x = minX + i * step;
        let best = -1e30;
        for (let b = 0; b < bodies.length; b++) {
          const B = bodies[b];
          const dx = x - B.cx, dz = z - B.cz;
          const rr = B.r + margin;
          if (dx * dx + dz * dz > rr * rr) continue;
          if (B.level > best) best = B.level;
        }
        const k = j * gw + i;
        if (best < -1e29) { has[k] = 0; continue; }
        const g = this._terrainHeight(x, z);
        has[k] = 1;
        gnd[k] = g;
        lvl[k] = best;
        dep[k] = best - g;
      }
    }

    const map = new Int32Array(total).fill(-1);
    const bedMap = wantBed ? new Int32Array(total).fill(-1) : null;
    const pos = [], depths = [], idx = [];
    const bedPos = [], bedDepth = [], bedIdx = [];

    const vert = (i, j) => {
      const k = j * gw + i;
      let v = map[k];
      if (v >= 0) return v;
      v = pos.length / 3;
      map[k] = v;
      pos.push(minX + i * step, lvl[k], minZ + j * step);
      depths.push(Math.max(-0.9, dep[k]));
      return v;
    };
    const bedVert = (i, j) => {
      const k = j * gw + i;
      let v = bedMap[k];
      if (v >= 0) return v;
      v = bedPos.length / 3;
      bedMap[k] = v;
      bedPos.push(minX + i * step, gnd[k] + 0.035, minZ + j * step);
      bedDepth.push(Math.max(0, dep[k]));
      return v;
    };

    let area = 0;
    const cellArea = step * step;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k00 = j * gw + i, k10 = k00 + 1, k01 = k00 + gw, k11 = k01 + 1;
        if (!(has[k00] && has[k10] && has[k01] && has[k11])) continue;
        const dmax = Math.max(dep[k00], dep[k10], dep[k01], dep[k11]);
        if (dmax <= -shoreSlack) continue;
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
        const dmin = Math.min(dep[k00], dep[k10], dep[k01], dep[k11]);
        if (dmin > 0) area += cellArea;
        if (wantBed && dmax > 0.015) {
          const ba = bedVert(i, j), bb = bedVert(i + 1, j), bc = bedVert(i, j + 1), bd = bedVert(i + 1, j + 1);
          bedIdx.push(ba, bc, bb, bb, bc, bd);
        }
      }
    }
    if (!idx.length) return null;

    const make = (p, dv, ix) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dv, 1));
      const nrm = new Float32Array(p.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setIndex(p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(ix, 1) : new THREE.Uint16BufferAttribute(ix, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    };

    // Deterministic sample points over open liquid — used for ambient ripples
    // and for placing the lava practicals in the middle of real pools.
    const samples = [];
    for (let n = 0; n < depths.length; n += Math.max(1, Math.floor(depths.length / 220))) {
      if (depths[n] > 0.22) samples.push([pos[n * 3], pos[n * 3 + 1], pos[n * 3 + 2], depths[n]]);
    }

    return {
      surface: make(pos, depths, idx),
      bed: wantBed && bedIdx.length ? make(bedPos, bedDepth, bedIdx) : null,
      area,
      samples,
      verts: pos.length / 3,
    };
  }

  _buildWater(biome, scenario) {
    if (!this._grabTerrain()) return;
    const bodies = [];

    if (biome === 'moor') {
      /* Terrain carves explicit tarn basins for the moor and publishes them with
         a fill level that leaves a dry margin of bank. Use those.

         WHAT THIS REPLACES, AND WHY. The old code took the 30th-percentile height
         of a 62 m disc as one global level. 62 m reaches well past the plateau
         edge (scarp r0 = 46), so 45 % of the samples came off the scarp — where
         the land has already dropped 15-40 m — and the 30th percentile landed at
         2.33 m, BELOW every square metre of a playfield that runs 3.3-5.4 m. The
         main body therefore contained no water at all, and the only surviving
         bodies were _findHollows' 3 m pockets, capped at 20 cm deep. Water 20 cm
         deep is thinner than the shoreline foam band, so it rendered as 100 %
         foam: the two white translucent quads the moor frame was called out for.
         Depth is not cosmetic here — absorption is the entire reason water reads
         as dark. */
      const basins = this._terrain.waterBasins?.() ?? [];
      for (const b of basins) {
        bodies.push({ cx: b.x, cz: b.z, r: b.r, r2: b.r * b.r, level: b.level });
      }
      if (!bodies.length) {
        // No authored basins (unknown biome variant): fall back to a percentile
        // taken INSIDE the plateau, never across the scarp.
        const inner = Math.min(40, (this._terrain.size ?? 140) * 0.29);
        const level = this._percentileHeight(inner, 0.20);
        bodies.push({ cx: 0, cz: 0, r: inner, r2: inner * inner, level });
      }
      /* No incidental _findHollows pockets on the moor. Its level cap is 20 cm,
         which is shallower than the shoreline foam band however tight that band
         is, so every one of them rendered as a hard-edged white lattice patch —
         one of them landed a metre from the hero. The moor's puddling is carried
         by the terrain wetness mask; standing water is carried by carved tarns. */
    } else {
      // Town: discrete puddles in real depressions. A global level would flood
      // the levelled plaza in one step, which is exactly the "polished glass
      // everywhere" failure the wetness mask already gets called out for.
      const hollows = this._findHollows(9, SEED + 91, 9, 1.8);
      for (const h of hollows) bodies.push(h);
      if (!hollows.length) {
        const level = this._percentileHeight(30, 0.06);
        bodies.push({ cx: 0, cz: 0, r: 22, r2: 484, level });
      }
    }
    if (!bodies.length) return;

    const cell = biome === 'moor' ? 1.05 : 0.42;
    const built = this._buildClippedGrid(bodies, cell, true, 0.24);
    if (!built) return;

    this.bodies = bodies;
    this._geo.water = built.surface;
    this._geo.caustic = built.bed;
    this._samplePts = built.samples;

    const mesh = new THREE.Mesh(built.surface, this._mats.water);
    mesh.name = 'water.surface';
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this._meshes.water = mesh;
    this._integrate(this._mats.water);

    if (built.bed) {
      const bed = new THREE.Mesh(built.bed, this._mats.caustic);
      bed.name = 'water.caustics';
      bed.matrixAutoUpdate = false;
      bed.renderOrder = 2;
      this.group.add(bed);
      this._meshes.caustic = bed;
    }

    // reflection plane = the dominant body
    let biggest = bodies[0];
    for (const b of bodies) if (b.r > biggest.r) biggest = b;
    this._reflLevel = biggest.level;
    this._reflWant = this._reflBase() > 0 && built.area > 6;
    if (this._reflWant) this._ensureReflection();

    console.info(`[water] ${biome} standing water — ${bodies.length} bodies, ` +
      `${built.verts} verts, ${built.area.toFixed(0)} m², level ${this._reflLevel.toFixed(2)}`);
  }

  _buildLava(scenario) {
    if (!this._grabTerrain()) return;
    // Hell terrain is a basalt plateau split by a worley fissure network; a low
    // percentile lands the surface inside the fissures, so lava reads as molten
    // rivers in the cracks instead of a flooded floor.
    const level = this._percentileHeight(58, 0.20);
    const r = Math.min(66, (this._terrain.size ?? 190) * 0.35);
    const bodies = [{ cx: 0, cz: 0, r, r2: r * r, level }];
    const built = this._buildClippedGrid(bodies, 0.78, false, 0.14);
    if (!built) return;

    this.bodies = bodies;
    this._geo.lava = built.surface;
    this._samplePts = built.samples;

    if (!this._mats.lava) this._mats.lava = this._makeLavaMaterial();
    if (!this._mats.haze) this._mats.haze = this._makeHazeMaterial();

    const mesh = new THREE.Mesh(built.surface, this._mats.lava);
    mesh.name = 'lava.surface';
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    this.group.add(mesh);
    this._meshes.lava = mesh;
    this._integrate(this._mats.lava);

    // Heat haze: two rising sheets built from the lava footprint. Not billboards
    // — they are the pool outline, lifted and animated, so the glow sits in the
    // fissures where the heat actually is.
    for (let i = 0; i < 2; i++) {
      const m = this._mats.haze.clone();
      m.uniforms.uLift.value = 0.55 + i * 1.15;
      m.uniforms.uParams.value = new THREE.Vector3(1 / (5.5 + i * 3), 0.055 + i * 0.02, 0.46 - i * 0.19);
      m.uniforms.uColor.value = new THREE.Color(0.55 - i * 0.12, 0.20 - i * 0.05, 0.055);
      m.uniforms.uTime = this._mats.haze.uniforms.uTime;   // share the clock
      m.uniforms.tDetail = this._mats.haze.uniforms.tDetail;
      const hz = new THREE.Mesh(built.surface, m);
      hz.name = `lava.haze${i}`;
      hz.matrixAutoUpdate = false;
      hz.renderOrder = 6 + i;
      this.group.add(hz);
      this._meshes.haze.push(hz);
    }

    this._placeLavaLights(built.samples);
    console.info(`[water] lava — ${built.verts} verts, ${built.area.toFixed(0)} m², ` +
      `level ${level.toFixed(2)}, ${this._torches.length} practicals`);
  }

  /**
   * Register emissive area lights on the biggest molten pools. Every one sits on
   * visible glowing geometry, so there are no floating orbs — and because the
   * Lighting module only auto-spawns practicals when nothing external has
   * claimed a light, this also replaces the unmotivated defaults in `boss`.
   */
  _placeLavaLights(samples) {
    this._clearTorches();
    const lighting = this.engine.get('lighting');
    if (!lighting || lighting.__dead || typeof lighting.addTorch !== 'function') return;
    if (!samples.length) return;

    const pool = samples.slice().sort((a, b) => b[3] - a[3]);
    const picked = [];
    const minSep = 11;
    for (const s of pool) {
      if (picked.length >= 8) break;
      let ok = true;
      for (const p of picked) {
        if ((p[0] - s[0]) ** 2 + (p[2] - s[2]) ** 2 < minSep * minSep) { ok = false; break; }
      }
      if (ok) picked.push(s);
    }

    for (let i = 0; i < picked.length; i++) {
      const s = picked[i];
      try {
        const t = lighting.addTorch({
          position: [s[0], s[1] + 0.35 + s[3] * 0.2, s[2]],
          type: 'lava',
          kelvin: 1450,
          saturation: 1.3,
          intensity: 26 + (i % 3) * 7,
          radius: 17 + (i % 4) * 3.5,
          flicker: 0.85,
          shadow: i < 2,
          priority: 1.15,
          glow: false,
        });
        if (t) this._torches.push(t);
      } catch (e) {
        console.warn('[water] addTorch —', e?.message ?? e);
        break;
      }
    }
  }

  _clearTorches() {
    const lighting = this.engine.get('lighting');
    for (const t of this._torches) {
      try { lighting?.removeTorch?.(t); } catch { /* noop */ }
    }
    this._torches.length = 0;
  }

  _tickTorches() { /* Lighting drives the flicker profile itself */ }

  /** Per-biome look calibration — colour, absorption, foam, caustic tint. */
  _tuneWaterLook(biome, env, scenario) {
    const W = this._mats.water?.userData.lqU;
    const C = this._mats.caustic?.uniforms;
    const night = typeof env.timeOfDay === 'number' && (env.timeOfDay < 0.12 || env.timeOfDay > 0.9);

    if (W) {
      if (biome === 'moor') {
        /* Peat bog: brown-green scatter, heavy extinction, near-black at depth.
           The shallow term was 0.062 — brighter than the peat bank it sits in, so
           every centimetre of fringe read as a pale film and the pool as a whole
           read as frosted glass. Peat-stained water scatters almost nothing. */
        W.uLqShallow.value.setRGB(0.0215, 0.0250, 0.0180);
        W.uLqDeep.value.setRGB(0.0030, 0.0052, 0.0058);
        /* .w is a FRESNEL FLOOR, and 0.09 is four times the physical value. An
           ARPG camera looks at water at ~44 deg off the normal, where real
           Fresnel is about 2 %. At 0.11 the surface handed 11 % of a 1.4-linear
           overcast sky straight back to the eye — brighter than the peat bank
           around it — which is precisely why the moor's pools read as panes of
           frosted glass instead of standing water. Dark water is dark BECAUSE it
           reflects almost nothing at this angle; the specular sun glint on the
           ripple crests is what tells you it is a liquid. */
        /* .y (opacity extinction) is raised hard: at 5.0 the surface was still 40 %
           transparent at 10 cm, so the LIT bed showed through the whole fringe and
           the pool averaged brighter than the dry bank next to it. Water that you
           can see the bottom of is clear water, and this is a peat bog. */
        W.uLqAbs.value.set(5.6, 7.4, 1.0, night ? 0.030 : 0.012);
        /* Foam band = 9 cm of DEPTH, not 26. A tarn is 2 m deep in the middle and
           the band is measured from the waterline inward, so at 0.26 the wash
           reached a quarter of the way across a shallow pool and the whole body
           read as white translucent film. Foam belongs on the last hand's-breadth
           of shoreline and on wave crests, nowhere else. `.z` (the wet-stone band
           carried onto the bank) is halved for the same reason: at roughness 0.115
           it was a glossy 5 cm ring drawing a hard bright outline round the pool.
           `.w` is raised so the waterline itself is properly lobed. */
        W.uLqFoam.value.set(0.090, 1 / 5.5, 0.030, 0.88);
        // and the wash itself is peat-stained scum, not snow
        W.uLqTint.value.set(0.098, 0.095, 0.082, 0.24);
        /* A sheltered tarn does not have whitecaps, so the slope stays under the
           crest threshold; what it DOES have is sun glitter, and the glitter is
           the only earned specular highlight anywhere in the overworld frame.
           These amplitudes set how many ripple facets align with the sun. */
        W.uLqNrmAmp.value.set(0.212, 0.138, 0.088, 0.030);
        W.uLqSky.value.setRGB(night ? 0.020 : 0.052, night ? 0.026 : 0.062, night ? 0.042 : 0.082);
      } else {
        // town puddles: shallow, clear, almost pure reflection
        W.uLqShallow.value.setRGB(0.052, 0.056, 0.060);
        W.uLqDeep.value.setRGB(0.0075, 0.0090, 0.0115);
        W.uLqAbs.value.set(5.5, 6.5, 1.15, 0.14);
        W.uLqFoam.value.set(0.10, 1 / 3.2, 0.035, 0.42);
        W.uLqTint.value.set(0.20, 0.20, 0.19, 0.50);
        W.uLqNrmAmp.value.set(0.16, 0.13, 0.085, 0.018);
        W.uLqSky.value.setRGB(0.075, 0.070, 0.072);
      }
      if (this._rain > 0) {
        W.uLqFoam.value.x *= 0.8;
        W.uLqNrmAmp.value.z += 0.05;
      }
    }

    if (C) {
      // caustics carry the colour of whatever light is refracting through
      let col = new THREE.Color(0.30, 0.34, 0.30);
      try {
        const sun = this.engine.get('lighting')?.sun;
        if (sun?.color) col = sun.color.clone().multiplyScalar(0.55);
      } catch { /* keep default */ }
      if (night) col.multiplyScalar(0.45);
      C.uColor.value.copy(col);
      C.uParams.value.set(biome === 'town' ? 1 / 1.9 : 1 / 3.4, 0.85, biome === 'town' ? 3.4 : 1.65,
        biome === 'town' ? 0.85 : 1.15);
      C.uFade.value.set(biome === 'town' ? 20 : 32, biome === 'town' ? 46 : 70);
    }
  }

  /* ================================================================ *
   * blood
   * ================================================================ */

  /**
   * Pre-place pools where the crypt terrain already stains the floor with
   * blood, so the scene reads as the aftermath of a fight rather than a clean
   * room with decals dropped on it.
   */
  _seedBlood(scenario) {
    if (!this._grabTerrain()) return;
    const t = this.engine.clock.elapsed;
    const want = scenario === 'combat' ? 11 : scenario === 'closeup' ? 3 : 7;
    let pts = [];
    try {
      pts = this._terrain.sampleScatterPoints?.(want * 3, SEED + 311,
        (v, info) => info.macro > 0.42 && info.slope < 0.30 && Math.hypot(v.x, v.z) < 26) ?? [];
    } catch { pts = []; }
    if (pts.length < want) {
      try {
        const extra = this._terrain.sampleScatterPoints?.(want * 3, SEED + 313,
          (v, info) => info.slope < 0.26 && Math.hypot(v.x, v.z) < 20) ?? [];
        pts = pts.concat(extra);
      } catch { /* keep what we have */ }
    }

    const rnd = this.engine.freshRand(SEED + 401);
    let n = 0;
    for (const p of pts) {
      if (n >= want) break;
      let ok = true;
      for (const q of this.pools) {
        if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 2.6) { ok = false; break; }
      }
      if (!ok) continue;
      // aged pools: born before the frame clock so they are already spread
      const age = 6 + rnd() * 46;
      this.pools.push({
        x: p.x, y: p.y, z: p.z,
        r: 0.55 + rnd() * 1.35,
        birth: t - age,
        seed: rnd(),
      });
      n++;
    }
    if (this.pools.length) this._rebuildBlood();
  }

  _rebuildBlood() {
    if (!this.pools.length) { this._clearBlood(); return; }
    const RING = 18, RINGS = 4;
    const vcount = this.pools.length * (1 + RING * RINGS);
    const pos = new Float32Array(vcount * 3);
    const nrm = new Float32Array(vcount * 3);
    const pool = new Float32Array(vcount * 4);
    const seed = new Float32Array(vcount);
    const idx = [];
    const terrain = this._grabTerrain();

    let v = 0;
    for (const P of this.pools) {
      const base = v;
      // centre
      const gy = terrain ? this._terrainHeight(P.x, P.z) : P.y;
      pos[v * 3] = P.x; pos[v * 3 + 1] = gy + 0.012; pos[v * 3 + 2] = P.z;
      nrm[v * 3 + 1] = 1;
      pool[v * 4] = P.x; pool[v * 4 + 1] = P.z; pool[v * 4 + 2] = P.r; pool[v * 4 + 3] = P.birth;
      seed[v] = P.seed;
      v++;
      for (let ring = 1; ring <= RINGS; ring++) {
        const rr = P.r * 1.18 * (ring / RINGS);
        for (let s = 0; s < RING; s++) {
          const a = (s / RING) * Math.PI * 2 + P.seed * 1.7;
          const x = P.x + Math.cos(a) * rr;
          const z = P.z + Math.sin(a) * rr;
          const y = terrain ? this._terrainHeight(x, z) : P.y;
          pos[v * 3] = x; pos[v * 3 + 1] = y + 0.012; pos[v * 3 + 2] = z;
          nrm[v * 3 + 1] = 1;
          pool[v * 4] = P.x; pool[v * 4 + 1] = P.z; pool[v * 4 + 2] = P.r; pool[v * 4 + 3] = P.birth;
          seed[v] = P.seed;
          v++;
        }
      }
      // inner fan
      for (let s = 0; s < RING; s++) {
        idx.push(base, base + 1 + s, base + 1 + ((s + 1) % RING));
      }
      for (let ring = 1; ring < RINGS; ring++) {
        const a0 = base + 1 + (ring - 1) * RING;
        const a1 = base + 1 + ring * RING;
        for (let s = 0; s < RING; s++) {
          const s1 = (s + 1) % RING;
          idx.push(a0 + s, a1 + s, a0 + s1);
          idx.push(a0 + s1, a1 + s, a1 + s1);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aPool', new THREE.BufferAttribute(pool, 4));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();

    const old = this._geo.blood;
    this._geo.blood = g;
    if (this._meshes.blood) {
      this._meshes.blood.geometry = g;
    } else {
      const mesh = new THREE.Mesh(g, this._mats.blood);
      mesh.name = 'blood.pools';
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this._meshes.blood = mesh;
      this._integrate(this._mats.blood);
    }
    try { old?.dispose(); } catch { /* noop */ }
  }

  _clearBlood() {
    this.pools.length = 0;
    if (this._meshes.blood) {
      this.group.remove(this._meshes.blood);
      this._meshes.blood = null;
    }
    try { this._geo.blood?.dispose(); } catch { /* noop */ }
    this._geo.blood = null;
  }

  _clearLiquid() {
    for (const key of ['water', 'caustic', 'lava']) {
      const m = this._meshes[key];
      if (m) { this.group.remove(m); this._meshes[key] = null; }
      try { this._geo[key]?.dispose(); } catch { /* noop */ }
      this._geo[key] = null;
    }
    for (const h of this._meshes.haze) {
      this.group.remove(h);
      try { h.material.dispose(); } catch { /* noop */ }
    }
    this._meshes.haze.length = 0;
    this._clearTorches();
    this.bodies = [];
    this._samplePts = [];
    this._reflWant = false;
    this._reflFade = 0;
    for (const r of this._ripples) r.set(0, 0, -99, 0);
  }

  /* ================================================================ *
   * interaction
   * ================================================================ */

  /** Find hero + enemies without knowing either module's shape. */
  _collectActors() {
    const out = [];
    const push = (o) => {
      if (!o || out.length >= 24) return;
      let p = null;
      if (o.isObject3D === true) p = o.position;
      else if (o.position?.isVector3) p = o.position;
      else if (o.root?.position) p = o.root.position;
      else if (o.group?.position) p = o.group.position;
      else if (o.mesh?.position) p = o.mesh.position;
      if (!p || !Number.isFinite(p.x)) return;
      out.push({ ref: o, pos: p });
    };
    try {
      const hero = this.engine.get('hero');
      if (hero && !hero.__dead) push(hero.root ?? hero.group ?? hero.model ?? hero.mesh ?? hero);
    } catch { /* no hero */ }
    try {
      const b = this.engine.get('bestiary');
      if (b && !b.__dead) {
        const lists = [b.entities, b.enemies, b.list, b.actors, b.units, b.alive];
        for (const l of lists) {
          if (!l) continue;
          const arr = Array.isArray(l) ? l : (typeof l.values === 'function' ? Array.from(l.values()) : null);
          if (!arr) continue;
          for (const it of arr) push(it);
          break;
        }
      }
    } catch { /* no bestiary */ }
    return out;
  }

  _trackActors(t) {
    if ((this.engine.clock.frame & 3) !== 0) return;
    const actors = this._collectActors();
    if (!actors.length) { this._actors.length = 0; return; }

    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      let rec = this._actors[i];
      if (!rec || rec.ref !== a.ref) {
        rec = this._actors[i] = { ref: a.ref, x: a.pos.x, z: a.pos.z, last: -99, splash: -99 };
      }
      const dx = a.pos.x - rec.x, dz = a.pos.z - rec.z;
      const moved = Math.hypot(dx, dz);
      rec.x = a.pos.x; rec.z = a.pos.z;

      const d = this.depthAt(a.pos.x, a.pos.z);
      if (d < 0.03) continue;
      if (moved > 0.05 && t - rec.last > 0.20) {
        rec.last = t;
        this.addRipple(a.pos.x, a.pos.z, Math.min(1.5, 0.45 + moved * 5.5), t);
      }
      // Splash particles belong to VFX; announce the contact and let it decide.
      if (moved > 0.12 && t - rec.splash > 0.34) {
        rec.splash = t;
        try {
          this.engine.bus.emit('impact', {
            point: _v3.set(a.pos.x, (this.levelAt(a.pos.x, a.pos.z) ?? a.pos.y), a.pos.z).clone(),
            normal: _v3b.set(0, 1, 0).clone(),
            kind: 'water',
            magnitude: Math.min(1, 0.25 + moved * 3.2),
          });
        } catch { /* bus rejected — ignore */ }
      }
    }
  }

  /**
   * Ambient disturbance — a rising bubble, a drip from a reed. Deterministic
   * from the elapsed-time slot, so replays are pixel-identical, and it keeps
   * the surface alive before any actor module exists.
   */
  _ambientRipple(t) {
    if (!this._samplePts.length) return;
    const slot = Math.floor(t / 1.15);
    if (slot === this._ambientSlot) return;
    this._ambientSlot = slot;
    const rnd = this.engine.freshRand(SEED + slot * 7919);
    const s = this._samplePts[(rnd() * this._samplePts.length) | 0];
    if (!s) return;
    this.addRipple(s[0], s[2], 0.32 + rnd() * 0.4, t);
  }

  /* ================================================================ *
   * planar reflection
   * ================================================================ */

  _ensureReflection() {
    const base = this._reflBase();
    if (base <= 0) return null;
    if (!this._refl) {
      const w = this.engine.width || 1600;
      const h = this.engine.height || 900;
      const rh = Math.max(128, Math.min(base, Math.round((base * h) / w)));
      this._refl = new THREE.WebGLRenderTarget(base, rh, {
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
        samples: 0,
      });
      this._refl.texture.name = 'nona.waterReflection';
      this._refl.texture.minFilter = THREE.LinearFilter;
      this._refl.texture.magFilter = THREE.LinearFilter;
      this._refl.texture.generateMipmaps = false;
      this._refl.texture.wrapS = this._refl.texture.wrapT = THREE.ClampToEdgeWrapping;
      const U = this._mats.water?.userData.lqU;
      if (U) U.tLqRefl.value = this._refl.texture;
    }
    return this._refl;
  }

  /**
   * Low-res planar reflection, half rate. Cheaper and far cleaner than SSR for
   * a horizontal plane: no ray marching, no missing off-screen geometry, and
   * the sky (which is most of what water reflects) comes through correctly.
   */
  /** True once every visible shadow-casting light has a rendered shadow map. */
  _shadowsReady() {
    if (this._shadowsOk) return true;
    const renderer = this.engine.renderer;
    if (!renderer.shadowMap.enabled) { this._shadowsOk = true; return true; }
    let ok = true;
    this.engine.scene.traverse((o) => {
      if (!ok || !o.isLight || !o.castShadow || !o.visible) return;
      if (o.intensity <= 0) return;
      if (!o.shadow || !o.shadow.map) ok = false;
    });
    this._shadowsOk = ok;
    return ok;
  }

  _renderReflection() {
    if (!this._reflWant) return;
    const e = this.engine;
    const cam = e.camera;
    const level = this._reflLevel;
    const U = this._mats.water?.userData.lqU;
    if (!U) return;

    if (cam.position.y < level + 0.25) {           // camera at or below the plane
      U.uLqReflAmt.value = 0;
      return;
    }
    // Half rate: the reflection is blurred by wave distortion anyway, and this
    // halves the extra scene pass. Parity is on the deterministic frame counter.
    const frame = e.clock.frame;
    const stale = frame - this._reflFrame;
    if (stale < 2 && this._reflFade > 0) {
      U.uLqReflAmt.value = this._reflFade * 0.92;
      return;
    }

    /*
     * Do not run before the shadow maps exist.
     *
     * This pass renders the scene with `shadowMap.autoUpdate = false` (that is
     * what keeps it affordable), but on the first frame no shadow map has been
     * allocated yet — Water updates before anything has been rendered. three then
     * binds its 1x1 RGBA placeholder to every `sampler2DShadow` in every lit
     * material and the driver rejects the whole pass:
     *   GL_INVALID_OPERATION: glDrawElements: Mismatch between texture format and
     *   sampler type (signed/unsigned/float/shadow)
     * — 256 rejected draws, once per boot, in every exterior scenario. Waiting one
     * frame costs nothing and the reflection is faded in anyway.
     */
    if (!this._shadowsReady()) { U.uLqReflAmt.value = 0; return; }

    const rt = this._ensureReflection();
    if (!rt) { U.uLqReflAmt.value = 0; return; }

    const renderer = e.renderer;
    const prevRT = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevXR = renderer.xr ? renderer.xr.enabled : false;
    const groupVisible = this.group.visible;

    try {
      const rc = this._reflCam;
      rc.fov = cam.fov; rc.aspect = cam.aspect; rc.near = cam.near; rc.far = cam.far;
      rc.zoom = cam.zoom ?? 1;

      // mirror the camera through y = level
      cam.updateMatrixWorld();
      _v3.setFromMatrixPosition(cam.matrixWorld);
      _mtx.extractRotation(cam.matrixWorld);
      _v3b.set(0, 0, -1).applyMatrix4(_mtx).add(_v3);          // look-at point
      rc.position.set(_v3.x, 2 * level - _v3.y, _v3.z);
      _v3c.set(_v3b.x, 2 * level - _v3b.y, _v3b.z);
      rc.up.set(0, 1, 0).applyMatrix4(_mtx);
      rc.up.y = -rc.up.y;
      rc.lookAt(_v3c);
      rc.updateMatrixWorld();
      rc.projectionMatrix.copy(cam.projectionMatrix);

      // reflection texture matrix (world -> reflection UV)
      this._reflMtx.set(
        0.5, 0.0, 0.0, 0.5,
        0.0, 0.5, 0.0, 0.5,
        0.0, 0.0, 0.5, 0.5,
        0.0, 0.0, 0.0, 1.0
      );
      this._reflMtx.multiply(rc.projectionMatrix);
      this._reflMtx.multiply(rc.matrixWorldInverse);

      // Oblique near plane (Lengyel) so nothing below the surface leaks in —
      // done in the projection matrix, which costs no shader recompiles the way
      // renderer.clippingPlanes would.
      _plane.setFromNormalAndCoplanarPoint(_v3b.set(0, 1, 0), _v3c.set(0, level, 0));
      _plane.applyMatrix4(rc.matrixWorldInverse);
      _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
      const pm = rc.projectionMatrix;
      _q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
      _q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
      _q.z = -1.0;
      _q.w = (1.0 + pm.elements[10]) / pm.elements[14];
      const dp = _clip.dot(_q);
      if (Math.abs(dp) > 1e-6) {
        _clip.multiplyScalar(2.0 / dp);
        pm.elements[2] = _clip.x;
        pm.elements[6] = _clip.y;
        pm.elements[10] = _clip.z + 1.0 - 0.0035;
        pm.elements[14] = _clip.w;
      }
      rc.projectionMatrixInverse.copy(pm).invert();

      this.group.visible = false;
      if (renderer.xr) renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, false);
      renderer.render(e.scene, rc);

      this._reflFrame = frame;
      this._reflFade = Math.min(1, this._reflFade + 0.34);
      U.uLqReflAmt.value = this._reflFade * 0.92;
    } catch (err) {
      console.warn('[water] planar reflection disabled —', err?.message ?? err);
      this._reflWant = false;
      U.uLqReflAmt.value = 0;
    } finally {
      this.group.visible = groupVisible;
      renderer.shadowMap.autoUpdate = prevShadow;
      if (renderer.xr) renderer.xr.enabled = prevXR;
      renderer.setRenderTarget(prevRT);
    }
  }

  /* ================================================================ *
   * diagnostics
   * ================================================================ */

  stats() {
    return {
      kind: this.kind,
      bodies: this.bodies.length,
      pools: this.pools.length,
      reflection: this._refl ? `${this._refl.width}x${this._refl.height}` : 'off',
      torches: this._torches.length,
      deaths: this._deathCount,
    };
  }
}
