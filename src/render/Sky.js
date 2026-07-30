/**
 * THE NINTH VIGIL — Sky, atmosphere, clouds, aerial-perspective fog and horizon depth.
 *
 * What this module owns:
 *
 *  1. A physical sky dome (Preetham scattering, re-driven by time-of-day and
 *     weather) extended with a wavelength-shifted twilight band, a full night
 *     sky (procedural stars, milky-way band with dust lanes, shaded moon disc
 *     with real phase terminator) and heavy storm variants.
 *  2. A raymarched cloud layer on a spherical shell — domain-warped procedural
 *     noise, per-step light marching for self-shading (Beer + powder), forward
 *     scattering phase. Thickens with weather.
 *  3. A ground cloud-shadow map (texture + world->uv matrix) that scrolls with
 *     the wind. Exposed for Terrain, and auto-multiplied into every patched
 *     material's albedo so the ground breathes even without Terrain's help.
 *  4. Exponential *height* fog whose colour is sampled from the sky in the
 *     view direction (true aerial perspective — distant geometry desaturates
 *     toward the horizon colour and glows toward the sun, never a grey wash).
 *     Injected into materials via onBeforeCompile; auto-applied to the whole
 *     scene at init, on 'scene:added', and on a cheap periodic rescan.
 *  5. Three procedural far-silhouette layers (ridgelines + broken spires)
 *     evaluated INSIDE the dome shader from the view direction, so the world has
 *     a horizon that reads as depth instead of a cut-off. They used to be three
 *     transparent cylinder meshes; those were depth-culled by Terrain's far apron
 *     in every exterior frame and never drew a pixel. See GLSL_HORIZON.
 *  6. Interiors: the dome becomes a dark void and the fog becomes dense, close
 *     and warm-tinted so torchlight reads as volumetric.
 *
 * Determinism: no Math.random, no Date.now. All noise is hashed, all motion is
 * driven by engine.clock.elapsed.
 */

import * as THREE from 'three';
import { PMREMGenerator } from 'three';
import {
  WEATHER, computeSkyState, evalSkyColor, extinctionFor,
  buildCloudNoise, buildCloudShadowTexture, sunLightColor, bandState,
  GLSL_HASH, GLSL_ATMOS, GLSL_BAND, GLSL_HORIZON, ATMOS_SEED,
} from './Atmosphere.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* Ground-haze tint per biome — keeps fog from ever reading as neutral grey. */
const BIOME_HAZE = {
  town: [0.44, 0.42, 0.46],
  moor: [0.36, 0.40, 0.46],
  crypt: [0.30, 0.31, 0.36],
  hell: [0.56, 0.32, 0.24],
  waste: [0.46, 0.42, 0.38],
  default: [0.38, 0.40, 0.45],
};

/* ═══════════════════════════════════════════════════════════════════════════
   SKY DOME SHADER
   ═══════════════════════════════════════════════════════════════════════════ */

const SKY_VERT = /* glsl */`
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorldDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vWorldDir;

uniform vec3 uSunDir, uMoonDir, uBetaR, uBetaM, uTint;
uniform float uSunE, uMieG, uTwilight, uTwilightGain, uNight, uMoonUp, uDesat;
uniform float uTime, uInterior, uShowSunDisc, uDither;
uniform float uStarBright, uMilkyWay, uMoonSize, uMoonBright;
uniform float uSunSize, uSunDiscBright, uSunUp;
uniform vec3 uSunDiscColor, uIntFloor, uIntCeil, uIntWarm;

uniform sampler2D uCloudTex;
uniform vec3 uCloudLight, uCloudAmbTop, uCloudAmbBot, uCloudLightDir;
uniform vec2 uWind;
uniform float uCloudCoverage, uCloudDensity, uCloudAbsorb, uCloudPowder;
uniform float uCloudScale, uCloudMieG, uCloudWarp, uCloudEnable;
uniform float uPlanetR, uShellBot, uShellTop, uMaxMarch, uCloudHorizonFade;

uniform vec3 uHzRock0, uHzRock1, uHzRock2, uHzRim;
uniform float uHzFog, uHzRimGain, uHzMist, uHzEnable, uHzSoft, uHzSpill;

/* sub-horizon aerial band — see GLSL_BAND / bandState() in Atmosphere.js */
uniform vec3 uBandHi, uBandOpp, uBandLo, uBandGlow, uBandStrat;
uniform vec4 uBandCurve;      // x skylineS, y 1/rampSpan, z sidePow, w rampPow
uniform float uBandGlowW, uBandVeil, uBandVeilAmt;
uniform vec2 uKeyAz;

${GLSL_HASH}
${GLSL_ATMOS}
${GLSL_BAND}
${GLSL_HORIZON}

/* ---------- stars ---------- */
vec3 skStarLayer( vec3 dir, float px, float scale, float thr, float bright, float size ) {
  vec3 p = dir * scale;
  vec3 id = floor( p );
  vec3 r = skHash33( id );
  if ( r.x < thr ) return vec3( 0.0 );
  vec3 f = p - id - 0.5 - ( r - 0.5 ) * 0.54;
  float d = length( f ) / scale;
  float rad = max( ( size / scale ) * ( 0.55 + 1.45 * r.y * r.y ), px * 0.85 );
  float core = exp( - ( d * d ) / ( rad * rad ) );
  float tw = 0.70 + 0.30 * sin( uTime * ( 1.3 + r.y * 2.4 ) + r.z * 6.2831853 );
  vec3 col = mix( vec3( 0.62, 0.74, 1.00 ), vec3( 1.00, 0.80, 0.58 ), r.z );
  return col * core * bright * tw * ( 0.30 + 0.90 * r.y );
}

vec3 skNightSky( vec3 dir, float px ) {
  vec3 acc = vec3( 0.0 );
  vec3 gal = normalize( vec3( 0.36, 0.60, -0.71 ) );
  float gd = dot( dir, gal );
  float band = exp( - gd * gd / 0.052 );
  float dens = 0.0;
  if ( band > 0.004 ) {
    float f1 = skFbm3a( dir * 5.4 );
    float f2 = skFbm3a( dir * 13.7 + vec3( 3.1 ) );
    float dust = smoothstep( 0.34, 0.72, f2 );
    float m = band * ( 0.24 + 1.10 * f1 * f1 ) * ( 1.0 - 0.78 * dust );
    vec3 mwCol = mix( vec3( 0.30, 0.38, 0.66 ), vec3( 0.92, 0.82, 0.66 ), pow( band, 1.9 ) );
    acc += mwCol * m * uMilkyWay;
    dens = band;
  }
  acc += skStarLayer( dir, px,  92.0, 0.9720 - dens * 0.020, 1.00, 0.075 );
  acc += skStarLayer( dir, px, 178.0, 0.9580 - dens * 0.030, 0.40, 0.058 );
  acc += skStarLayer( dir, px, 312.0, 0.9370 - dens * 0.045, 0.15, 0.052 );
  return acc * uStarBright;
}

vec3 skMoon( vec3 dir ) {
  float ca = clamp( dot( dir, uMoonDir ), -1.0, 1.0 );
  float ang = acos( ca );
  vec3 acc = vec3( 0.66, 0.74, 0.95 ) *
             ( exp( - ang / 0.17 ) * 0.045 + exp( - ang * ang / 0.0015 ) * 0.30 ) * uMoonBright;
  if ( ang < uMoonSize * 1.3 ) {
    vec3 upref = abs( uMoonDir.y ) > 0.94 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
    vec3 tv = normalize( cross( uMoonDir, upref ) );
    vec3 bv = cross( uMoonDir, tv );
    vec2 uvm = vec2( dot( dir, tv ), dot( dir, bv ) ) / uMoonSize;
    float r2 = dot( uvm, uvm );
    if ( r2 < 1.0 ) {
      vec3 n = normalize( tv * uvm.x + bv * uvm.y + uMoonDir * sqrt( max( 1.0 - r2, 0.0 ) ) );
      float lam = max( dot( n, uSunDir ), 0.0 );
      float maria = skFbm3a( n * 3.4 );
      float crat = skFbm3a( n * 15.0 );
      vec3 surf = mix( vec3( 0.32, 0.34, 0.40 ), vec3( 0.90, 0.88, 0.82 ), smoothstep( 0.34, 0.70, maria ) );
      surf *= 1.0 - 0.32 * smoothstep( 0.50, 0.78, crat );
      float limb = pow( max( 1.0 - r2, 0.0 ), 0.20 );
      float edge = 1.0 - smoothstep( 0.955, 1.0, sqrt( r2 ) );
      acc += surf * ( 0.05 + lam * 1.30 ) * limb * edge * uMoonBright * 2.4;
    }
  }
  return acc * uMoonUp;
}

/* ---------- clouds ---------- */
float skRaySphere( vec3 ro, vec3 rd, float R ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - R * R;
  float d = b * b - c;
  if ( d < 0.0 ) return -1.0;
  return - b + sqrt( d );
}

float skCloudDensity( vec3 p, float lod ) {
  float h = clamp( ( length( p ) - uShellBot ) / max( uShellTop - uShellBot, 1e-4 ), 0.0, 1.0 );
  vec2 base = p.xz * uCloudScale + uWind * uTime;

  // stratus <-> cumulus selector and a very low frequency "weather map" so the
  // repeat of the base layer never reads as a tiled pattern
  float type = texture2D( uCloudTex, base * 0.42 + vec2( 0.31, 0.67 ) ).a;
  /* The shape layer necessarily repeats a few times across the visible cloud
     plane. This weather map has a period larger than the whole field, so every
     repeat sits at a different coverage and none of them read as a tile. */
  float wmap = texture2D( uCloudTex, base * 0.06 + vec2( 0.77, 0.19 ) ).r;

  vec2 wv = ( texture2D( uCloudTex, base * 1.35 + vec2( 0.13, 0.71 ) ).ra - 0.5 ) * uCloudWarp;
  float cov = texture2D( uCloudTex, base + wv ).r;

  float prof = smoothstep( 0.0, 0.17, h ) * ( 1.0 - smoothstep( mix( 0.40, 0.88, type ), 1.0, h ) );
  float cvg = clamp( uCloudCoverage + ( wmap - 0.5 ) * 0.42, 0.02, 1.0 );

  // remap into 0..1 against the coverage so density keeps its full range at any
  // coverage setting instead of collapsing to a sliver
  float d = ( cov * prof - ( 1.0 - cvg ) ) / cvg;
  if ( d <= 0.0 ) return 0.0;
  d = min( d, 1.0 );

  vec2 u2 = skRot( 0.87 ) * ( base * 3.7 ) + uWind * uTime * 1.7 + vec2( 0.41, 0.13 );
  float ero = texture2D( uCloudTex, u2 ).g * 0.42;
  if ( lod < 0.5 ) {
    vec2 u3 = skRot( -1.31 ) * ( base * 11.3 ) + uWind * uTime * 2.6;
    ero += texture2D( uCloudTex, u3 ).b * 0.20;
  }
  ero *= 0.30 + 0.70 * ( 1.0 - h );
  d = ( d - ero ) / max( 1.0 - ero, 0.08 );

  return max( d, 0.0 ) * uCloudDensity;
}

vec4 skCloudMarch( vec3 dir ) {
  if ( uCloudEnable < 0.5 || dir.y < 0.004 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  vec3 ro = vec3( 0.0, uPlanetR + 0.02, 0.0 );
  float t0 = skRaySphere( ro, dir, uShellBot );
  float t1 = skRaySphere( ro, dir, uShellTop );
  if ( t1 <= t0 || t0 < 0.0 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
  t1 = min( t1, t0 + uMaxMarch );
  float stepLen = ( t1 - t0 ) / float( CLOUD_STEPS );
  float lstep0 = ( uShellTop - uShellBot ) / float( CLOUD_LIGHT_STEPS ) * 0.48;
  float cosT = dot( dir, uCloudLightDir );
  float ph = clamp( ( mix( skHG( cosT, uCloudMieG ), skHG( cosT, -0.22 ), 0.32 ) ) * 12.566371, 0.30, 5.5 );

  float T = 1.0;
  vec3 scat = vec3( 0.0 );
  float t = t0 + stepLen * 0.5;
  for ( int i = 0; i < CLOUD_STEPS; i ++ ) {
    if ( T > 0.010 ) {
      vec3 p = ro + dir * t;
      float d = skCloudDensity( p, 0.0 );
      if ( d > 0.0008 ) {
        float ld = 0.0, ls = lstep0, lt = 0.0;
        for ( int j = 0; j < CLOUD_LIGHT_STEPS; j ++ ) {
          lt += ls;
          ld += skCloudDensity( p + uCloudLightDir * lt, 1.0 ) * ls;
          ls *= 1.42;
        }
        float beer = exp( - ld * uCloudAbsorb );
        float powder = 1.0 - exp( - d * 14.0 );
        float sunT = beer * mix( 1.0, powder * 1.8, uCloudPowder );
        float h = clamp( ( length( p ) - uShellBot ) / ( uShellTop - uShellBot ), 0.0, 1.0 );
        vec3 amb = mix( uCloudAmbBot, uCloudAmbTop, h * h );
        vec3 lum = uCloudLight * sunT * ph + amb;
        float ext = exp( - d * stepLen * uCloudAbsorb );
        scat += lum * ( 1.0 - ext ) * T;
        T *= ext;
      }
    }
    t += stepLen;
  }
  float fade = smoothstep( 0.0, uCloudHorizonFade, dir.y );
  return vec4( scat * fade, mix( 1.0, T, fade ) );
}

void main() {
  vec3 dir = normalize( vWorldDir );
  vec3 col;

  if ( uInterior > 0.5 ) {
    /* Dark void: a barely-there vertical gradient with a warm floor bounce so
       torchlight has something to sit against instead of pure black. */
    float g = smoothstep( -0.75, 0.60, dir.y );
    col = mix( uIntFloor, uIntCeil, g );
    float pool = exp( - max( dir.y + 0.10, 0.0 ) / 0.22 );
    col += uIntWarm * pool;
    col *= 0.86 + 0.28 * skFbm2a( vec2( atan( dir.z, dir.x ) * 1.6, dir.y * 3.4 ) );
  } else {
    float px = length( fwidth( dir ) ) + 1e-6;

    /* The sub-horizon aerial band. Computed FIRST because the analytic dome
       needs it: the last few degrees above level are the same air column you
       see below level, so the Preetham term has to be pulled toward the band as
       the view approaches the horizon. Without that veil an overcast horizon
       resolves to 1.38 LINEAR (measured, uSkHorizonSun) against a band at 0.12,
       which is a 10x step across 6 deg — a white rim in any frame that shows the
       horizon, and a hard joint. The veil is applied before skTwilight() so a
       sunset's belt/warm band still reads at full strength. */
    vec3 band = skAerialBand( dir, uKeyAz );

    col = skAtmosphere( dir );
    col = mix( col, band, clamp( exp( - max( dir.y, 0.0 ) / uBandVeil ) * uBandVeilAmt, 0.0, 1.0 ) );
    col += skTwilight( dir );

    if ( uNight > 0.002 ) {
      col += ( skNightBase( dir ) + skNightSky( dir, px ) + skMoon( dir ) ) * uNight;
    }

    col = skKnee( col );

    if ( uShowSunDisc > 0.5 && uSunUp > 0.001 ) {
      float ang = acos( clamp( dot( dir, uSunDir ), -1.0, 1.0 ) );
      vec3 Fex = skExtinction( max( uSunDir.y, 0.0 ) );
      float disc = 1.0 - smoothstep( uSunSize * 0.94, uSunSize * 1.08, ang );
      col += Fex * uSunDiscColor * disc * uSunDiscBright;
      col += Fex * uSunDiscColor * exp( - ang / 0.060 ) * 0.55;
      col += Fex * uSunDiscColor * exp( - ang / 0.30 ) * 0.10;
    }

    col = skGrade( col );

    vec4 cl = skCloudMarch( dir );
    col = col * cl.w + cl.xyz;

    /* Below level the analytic model is meaningless, and on every shipped camera
       rig that is the WHOLE frame (overworld tops out 22 deg down). So this is
       not a fallback — it is the sky. skAerialBand() carries the colour
       temperature split, the value ramp and the horizon warming; the silhouette
       stack composites its receding land over it.
       The ramp is widened from the old 0.02..-0.11 (6.5 deg) to 0.055..-0.14
       (11 deg) so the joint with the veiled dome above cannot read as an edge. */
    float bel = smoothstep( 0.055, -0.14, dir.y );
    if ( bel > 0.0 ) {
      vec3 gh = band;
      if ( uHzEnable > 0.5 ) gh = skHorizonStack( dir, gh, band, uKeyAz );
      col = mix( col, gh, bel );
    }
  }

  /* Ordered-free hash dither scaled by local luminance: a flat amplitude that
     hides banding in a bright daytime gradient is visible grain in a 0.015
     night sky, so it has to track brightness. Stable per pixel, so frames stay
     byte-identical. */
  float dlum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  col += ( skHash21( gl_FragCoord.xy ) - 0.5 ) * uDither * ( 0.06 + dlum );
  col = max( col, vec3( 0.0 ) );

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   INJECTED FOG CHUNK
   ═══════════════════════════════════════════════════════════════════════════ */

const FOG_PARS = /* glsl */`
uniform vec3 uSkHazeNear, uSkHazeSun, uSkHazeOpp, uSkSunTint, uSkSunDir;
uniform vec4 uSkFogA;   // x density, y heightFalloff, z baseY, w start
uniform vec4 uSkFogB;   // x maxOpacity, y inscatter, z anisotropy, w noiseAmp
uniform vec4 uSkFogC;   // x rampStart, y rampEnd, z nearScale, w hazeNeutralBase
uniform vec4 uSkAer;    // x aerStart, y aerEnd, z surfaceDesat, w hazeGain
uniform vec4 uSkAer2;   // x hazeChromaDrain, y sidePow, z resultChromaCeiling, w -
uniform float uSkTime;
uniform vec4 uSkCloudShade;  // x strength, y 1/worldSize, z windU, w windV
uniform vec2 uSkCloudCov;    // smoothstep thresholds derived from coverage
varying vec3 vSkWPos;

float skfHash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float skfNoise2( vec2 x ) {
  vec2 i = floor( x ), f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( skfHash21( i ), skfHash21( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( skfHash21( i + vec2( 0.0, 1.0 ) ), skfHash21( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float skfHG( float c, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / ( 12.566371 * pow( max( 1.0 + g2 - 2.0 * g * c, 1e-4 ), 1.5 ) );
}
/* Moving cloud shadow. Procedural on purpose: an extra sampler on every patched
   material overflows MAX_TEXTURE_IMAGE_UNITS on heavy splat-mapped terrain. */
float skfCloudShade( vec2 xz ) {
  vec2 q = xz * uSkCloudShade.y + vec2( uSkTime * uSkCloudShade.z, uSkTime * uSkCloudShade.w );
  vec2 w = vec2( skfNoise2( q * 0.63 + 3.17 ), skfNoise2( q * 0.63 + 8.71 ) ) - 0.5;
  q += w * 0.90;
  float n = skfNoise2( q ) * 0.52 + skfNoise2( q * 2.17 + 5.30 ) * 0.30 + skfNoise2( q * 4.41 + 1.70 ) * 0.18;
  return 1.0 - smoothstep( uSkCloudCov.x, uSkCloudCov.y, n ) * uSkCloudShade.x;
}
vec3 skApplyFog( vec3 color, vec3 wpos ) {
  vec3 delta = wpos - cameraPosition;
  float dist = length( delta );
  if ( dist < 1e-4 ) return color;
  vec3 dir = delta / dist;
  float ed = dist - uSkFogA.w;
  if ( ed <= 0.0 ) return color;

  float b = uSkFogA.y;
  float base = uSkFogA.x * exp( - b * ( cameraPosition.y - uSkFogA.z ) );
  float bd = b * dir.y;
  float tau = ( abs( bd ) > 1e-5 )
    ? base * ( 1.0 - exp( - clamp( bd * ed, -48.0, 48.0 ) ) ) / bd
    : base * ed;

  vec3 mid = cameraPosition + dir * ( uSkFogA.w + ed * 0.5 );
  float n = skfNoise2( mid.xz * 0.010 + vec2( uSkTime * 0.010, uSkTime * -0.0065 ) ) * 0.65
          + skfNoise2( mid.xz * 0.031 + vec2( -uSkTime * 0.017, uSkTime * 0.009 ) ) * 0.35;
  tau *= 1.0 + ( n - 0.5 ) * uSkFogB.w;

  /* DISTANCE GATE — the reason 60 m of depth used to collapse into one plane.
     A pure height-fog integral is nearly linear across the band an ARPG camera
     frames (33-82 m on the overworld rig): it delivered 17 % at the bottom of
     the frame and 45 % at the top, and since the haze colour sat at the same
     LEVEL as the lit ground, that 28-point spread changed nothing measurable.
     Squashing the near end (uSkFogC.z) and letting the far end run at full
     density turns the same curve into 7 % / 26 % / 56 % at 32 / 50 / 80 m,
     which is a value separation the eye reads as depth. */
  float ramp = smoothstep( uSkFogC.x, uSkFogC.y, dist );
  tau *= mix( uSkFogC.z, 1.0, ramp );
  tau = max( tau, 0.0 );

  /* Opacity ceiling. It used to sit at 0.80, which the height-fog integral
     reaches by ~80 m on this rig — so 80 m and 300 m resolved to IDENTICAL
     values and the far half of the frame was one plane. 0.93 keeps a sliver of
     the surface's own albedo alive at any range while leaving 80 m visibly short
     of the far plateau. The horizon stays readable because the far colour is
     keyed BELOW the sky it silhouettes against (HAZE_SUN / HAZE_OPP in bandState), not
     because the fog was starved. */
  float f = min( 1.0 - exp( - tau ), uSkFogB.x );

  /* ONE monotone ramp in view depth drives BOTH the haze colour and the chroma
     drain, so value and saturation cannot move independently of distance:
     value rises toward the horizon colour, saturation falls, always. */
  /* The shaping used to be a SECOND smoothstep on top of the first, which is a
     quintic in disguise and put the entire useful part of the curve outside the
     frame. MEASURED on the overworld rig, whose terrain spans 30-78 m of view
     depth: aer came out 0.002 / 0.034 / 0.144 at 30 / 50 / 80 m, so the haze
     colour never left uSkHazeNear anywhere on screen and the far target was
     decorative — the fog mix was arithmetically a no-op over the whole visible
     range, which is the real reason 20 m and 80 m read as the same plane.
     pow(.., 0.55) is still monotone in depth (so the value-up / chroma-down
     guarantee below is untouched) but front-loads the walk: 0.10 / 0.24 / 0.46 at
     the same three depths, reaching 0.89 by 145 m and 1.0 past 210 m, so 20 / 80 /
     300 m stay three distinct planes AND the two that are actually on screen
     separate. */
  float aer = pow( smoothstep( uSkAer.x, uSkAer.y, dist ), 0.55 );

  /* Haze colour, keyed to the sky's own horizon: near-field air is dim and
     biome-tinted, the far field converges on the skyline colour of THIS
     time-of-day and weather, split warm/cool about the key light so the fog is
     never one flat wash across the frame. */
  vec2 dl = normalize( vec2( dir.x, dir.z ) + vec2( 1e-5 ) );
  vec2 sl = normalize( vec2( uSkSunDir.x, uSkSunDir.z ) + vec2( 1e-5 ) );
  float side = clamp( dot( dl, sl ) * 0.5 + 0.5, 0.0, 1.0 );
  vec3 farHaze = mix( uSkHazeOpp, uSkHazeSun, pow( side, uSkAer2.y ) );
  vec3 fc = mix( uSkHazeNear, farHaze, aer ) * uSkAer.w;

  /* The haze loses chroma with distance too. Neutralising only the SURFACE (as
     before) meant the far plane converged on the haze's own saturation — an
     overcast ground haze measures sat 0.31, so 300 m of fog RAISED saturation
     instead of dropping it, which is the opposite of aerial perspective. */
  float drain = clamp( uSkFogC.w + ( 1.0 - uSkFogC.w ) * aer * uSkAer2.x, 0.0, 1.0 );
  fc = mix( fc, vec3( dot( fc, vec3( 0.2126, 0.7152, 0.0722 ) ) ), drain );
  fc += uSkSunTint * ( uSkFogB.y * skfHG( dot( dir, uSkSunDir ), uSkFogB.z ) );

  float lum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = mix( color, vec3( lum ), aer * uSkAer.z );

  vec3 mixed = mix( color, fc, f );

  /* CHROMA CEILING — the guarantee, not a tweak.
     Draining the surface and the haze separately still lets total saturation
     rise with distance whenever the two hues OPPOSE: a warm moor fogged toward a
     cool haze passes through neutral and comes out chromatic on the far side.
     Measured on the shipped rig: sat 0.260 at 20 m -> 0.058 at 80 m -> 0.079 at
     160 m. A single monotone ceiling applied to the RESULT cannot do that,
     whatever the two hues are, so saturation now falls at every range by
     construction. */
  float ml = dot( mixed, vec3( 0.2126, 0.7152, 0.0722 ) );
  return mix( vec3( ml ), mixed, 1.0 - aer * uSkAer2.z );
}
`;

const FOG_VERT_DECL = 'varying vec3 vSkWPos;\n';
const FOG_VERT_BODY = /* glsl */`
#include <project_vertex>
{
  vec4 skWP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    skWP = batchingMatrix * skWP;
  #endif
  #ifdef USE_INSTANCING
    skWP = instanceMatrix * skWP;
  #endif
  vSkWPos = ( modelMatrix * skWP ).xyz;
}
`;

const CLOUD_SHADOW_BODY = /* glsl */`
#include <map_fragment>
if ( uSkCloudShade.x > 0.001 ) {
  diffuseColor.rgb *= skfCloudShade( vSkWPos.xz );
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   MODULE
   ═══════════════════════════════════════════════════════════════════════════ */

export class Sky {
  static id = 'sky';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = false;

    this.timeOfDay = 0.62;
    this._todTarget = 0.62;
    this._todBlend = 1;
    this.weatherKey = 'clear';
    this.weatherIntensity = 1;
    this.interior = false;
    this.fogAmount = 0.4;
    this.biome = 'moor';

    this.state = null;
    /** Latest solar/lunar light description; also broadcast on 'sky:sun'. */
    this.sun = {
      dir: V3(0, 1, 0),
      position: V3(0, 120, 0),
      color: new THREE.Color(1, 1, 1),
      intensity: 0,
      isNight: false,
      moonDir: V3(0, 1, 0),
      ambientSky: new THREE.Color(0.2, 0.25, 0.35),
      ambientGround: new THREE.Color(0.08, 0.07, 0.06),
      ambientIntensity: 0.4,
      fogColor: new THREE.Color(0.3, 0.33, 0.38),
    };

    /* Cloud-shadow contract (Terrain reads these directly):
       uv = worldPos.xz / cloudShadowWorldSize + cloudShadowOffset
       shade = mix( 1.0, texture( cloudShadowTexture, uv ).r, cloudShadowStrength )
       NOTE: while Sky is enabled it already multiplies an equivalent (sampler-
       free, procedural) term into every material it patches — consumers should
       stand down rather than double it. */
    this.cloudShadowWorldSize = 150;
    this.cloudShadowMatrix = new THREE.Matrix3();
    this.cloudShadowOffset = new THREE.Vector2();
    this.cloudShadowTexture = null;
    this.cloudShadowStrength = 0;
    this._shadowScroll = 0.018;

    this._patched = new WeakSet();
    this._seen = new WeakSet();
    this._interiorUp = V3(0, 1, 0);
    this._scanFrame = 0;
    this._disposables = [];
    this._sunEmitKey = '';
    this._forceEmit = 3;
    this._skyRadius = 800;
    this._pmrem = null;
    this._envRT = null;
    this._tmpColor = [0, 0, 0];
    this._gnd = [0, 0, 0];
    this._keyAz = V3(0, 1, 0);
    this._keyAz2 = new THREE.Vector2(0, -1);
    this._tmpV = V3();
    this._tmpV2 = V3();
    /** Latest bandState() result — the skyline colour family this frame is graded to. */
    this.band = null;
    /** 0..1 how much of the key light's disc is inside the frustum. */
    this.sunInShot = 0;
    this._offs = [];
  }

  /* ───────────────────────── init ───────────────────────── */

  async init() {
    const e = this.engine;
    try {
      const tier = e.quality?.tier ?? 'high';
      const steps = { low: [8, 2], med: [12, 3], high: [17, 4], ultra: [22, 5] }[tier] ?? [17, 4];

      /* --- shared fog uniforms (one object graph, referenced by every patched material) --- */
      const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      white.needsUpdate = true;
      white.name = 'nona.whiteFallback';
      this._white = white;
      this._disposables.push(white);

      this.fogU = {
        /* Published for Lighting (hemisphere) and Weather (mist tint) via
           `sun.ambientSky` / `ambientGround` / `fogColor` — they describe the sky,
           they are no longer what the fog shader samples. */
        uSkZenith: { value: V3(0.20, 0.26, 0.40) },
        uSkHorizonSun: { value: V3(0.44, 0.38, 0.34) },
        uSkHorizonOpp: { value: V3(0.24, 0.28, 0.38) },
        uSkGround: { value: V3(0.12, 0.13, 0.16) },
        /* What the fog actually converges on — derived by bandState() from the
           same numbers that shade the dome's sub-horizon band. */
        uSkHazeNear: { value: V3(0.040, 0.043, 0.050) },
        uSkHazeSun: { value: V3(0.070, 0.068, 0.062) },
        uSkHazeOpp: { value: V3(0.046, 0.050, 0.058) },
        uSkSunTint: { value: V3(0.6, 0.5, 0.4) },
        uSkSunDir: { value: V3(0, 1, 0) },
        uSkFogA: { value: new THREE.Vector4(0.005, 0.045, 0.0, 8.0) },
        uSkFogB: { value: new THREE.Vector4(0.93, 0.55, 0.72, 0.40) },
        uSkFogC: { value: new THREE.Vector4(18.0, 78.0, 0.24, 0.26) },
        uSkAer: { value: new THREE.Vector4(16.0, 210.0, 0.60, 1.0) },
        uSkAer2: { value: new THREE.Vector4(0.45, 1.35, 0.55, 0) },
        uSkTime: { value: 0 },
        uSkCloudShade: { value: new THREE.Vector4(0, 1 / this.cloudShadowWorldSize, 0.018, 0.011) },
        uSkCloudCov: { value: new THREE.Vector2(0.44, 0.59) },
      };

      /* --- procedural cloud noise --- */
      const noiseSize = tier === 'low' ? 128 : 256;
      this._noise = buildCloudNoise(noiseSize, ATMOS_SEED);
      this._noise.texture.anisotropy = Math.min(4, e.maxAniso ?? 1);

      /* --- sky dome ---
         Deliberately parked BEYOND the far plane: our own shader forces
         gl_Position.z = w so it always draws, while any depth/normal prepass
         using an override material clips it out entirely instead of writing a
         bogus 0.999 depth that would give GTAO a halo at the horizon. */
      this._skyRadius = Math.max(200, (e.camera?.far ?? 900) * 1.6);
      const geo = new THREE.SphereGeometry(1, 48, 24);
      this._disposables.push(geo);

      this.skyMat = new THREE.ShaderMaterial({
        name: 'NonaSky',
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        fog: false,
        defines: { CLOUD_STEPS: steps[0], CLOUD_LIGHT_STEPS: steps[1] },
        uniforms: {
          uSunDir: { value: V3(0, 1, 0) },
          uMoonDir: { value: V3(0, -1, 0) },
          uBetaR: { value: V3() },
          uBetaM: { value: V3() },
          uTint: { value: V3(1, 1, 1) },
          uSunE: { value: 500 },
          uMieG: { value: 0.8 },
          uTwilight: { value: 0 },
          uTwilightGain: { value: 1.8 },
          uNight: { value: 0 },
          uMoonUp: { value: 0 },
          uDesat: { value: 0 },
          uTime: { value: 0 },
          uInterior: { value: 0 },
          uShowSunDisc: { value: 1 },
          uDither: { value: 0.010 },
          uStarBright: { value: 0 },
          uMilkyWay: { value: 0 },
          uMoonSize: { value: 0.029 },
          uMoonBright: { value: 1 },
          uSunSize: { value: 0.021 },
          uSunDiscBright: { value: 48 },
          uSunUp: { value: 0 },
          uSunDiscColor: { value: V3(1, 0.95, 0.86) },
          /* ---- sub-horizon aerial band (this IS the visible sky) ---- */
          uBandHi: { value: V3(0.128, 0.122, 0.110) },
          uBandOpp: { value: V3(0.080, 0.085, 0.096) },
          uBandLo: { value: V3(0.032, 0.034, 0.039) },
          uBandGlow: { value: V3(0.030, 0.016, 0.008) },
          uBandStrat: { value: V3(0.885, 0.165, 0.085) },
          uBandCurve: { value: new THREE.Vector4(0.30, 1 / 0.85, 1.35, 0.85) },
          uBandGlowW: { value: 0.115 },
          uBandVeil: { value: 0.055 },
          uBandVeilAmt: { value: 0.85 },
          uKeyAz: { value: new THREE.Vector2(0, -1) },
          /* Far-horizon silhouette stack — a landmass band plus three receding
             ridges, evaluated from the view direction inside this shader. */
          uHzEnable: { value: 1 },
          uHzRock0: { value: V3(0.046, 0.044, 0.040) },
          uHzRock1: { value: V3(0.043, 0.041, 0.038) },
          uHzRock2: { value: V3(0.040, 0.038, 0.035) },
          uHzRim: { value: V3(0.055, 0.030, 0.016) },
          uHzFog: { value: 0.80 },
          uHzRimGain: { value: 0.8 },
          uHzMist: { value: 0.30 },
          /* Crest softening + haze spill — the seam fix. See GLSL_HORIZON. */
          uHzSoft: { value: 0.0055 },
          uHzSpill: { value: 0.30 },
          uIntFloor: { value: V3(0.012, 0.010, 0.009) },
          uIntCeil: { value: V3(0.004, 0.004, 0.006) },
          uIntWarm: { value: V3(0.016, 0.009, 0.004) },

          uCloudTex: { value: this._noise.texture },
          uCloudLight: { value: V3(2.6, 2.5, 2.3) },
          uCloudAmbTop: { value: V3(0.30, 0.34, 0.42) },
          uCloudAmbBot: { value: V3(0.10, 0.11, 0.15) },
          uCloudLightDir: { value: V3(0, 1, 0) },
          uWind: { value: new THREE.Vector2(0.0011, 0.0006) },
          uCloudCoverage: { value: 0.35 },
          uCloudDensity: { value: 0.9 },
          uCloudAbsorb: { value: 2.8 },
          uCloudPowder: { value: 0.7 },
          uCloudScale: { value: 0.05 },
          uCloudMieG: { value: 0.72 },
          uCloudWarp: { value: 0.075 },
          uCloudEnable: { value: 1 },
          uPlanetR: { value: 6371.0 },
          uShellBot: { value: 6372.4 },
          uShellTop: { value: 6374.6 },
          uMaxMarch: { value: 62.0 },
          uCloudHorizonFade: { value: 0.035 },
        },
      });
      this.skyMat.userData.skyNoFog = true;

      this.mesh = new THREE.Mesh(geo, this.skyMat);
      this.mesh.name = 'nona.skyDome';
      this.mesh.scale.setScalar(this._skyRadius);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 90;
      this.mesh.matrixAutoUpdate = true;
      this.mesh.userData.skyNoFog = true;
      e.scene.add(this.mesh);

      /* --- horizon silhouette ---
         The three transparent cylinder rings that used to live here are GONE.
         They were drawn every frame and contributed nothing: Terrain's far apron
         is opaque, writes depth and silhouettes across exactly the band the
         rings occupied, so every ring fragment failed the depth test in every
         exterior frame, and everything below tan(depression) 1.27 was clipped by
         the 900 m far plane on top of that. That is why `overworld` had no
         horizon at all and the terrain edge stood against a bare dome.

         The silhouette is now evaluated inside the DOME shader as a function of
         view direction (see GLSL_HORIZON in Atmosphere.js). A ridge line
         kilometres out has no usable parallax, so direction is the correct
         parameterisation — and folded into the dome it cannot be depth-culled,
         cannot be far-plane clipped, and costs 3 fewer draw calls and 3 fewer
         programs than the meshes it replaces. `this.rings` stays as an empty
         list so update()/dispose() keep working unchanged. */
      this.rings = [];

      /* --- bus wiring --- */
      this._offs.push(
        e.bus.on('scene:added', (p) => this._onSceneAdded(p)),
        e.bus.on('weather:set', (p) => {
          if (!p) return;
          this.setWeather(p.kind ?? p.weather ?? this.weatherKey, p.intensity ?? 1);
        }),
        e.bus.on('sky:setTimeOfDay', (p) => this.setTimeOfDay(typeof p === 'number' ? p : p?.t ?? 0.5, true)),
      );

      // Our own fog replaces three's — make sure nothing double-applies.
      e.scene.fog = null;

      this.enabled = true;
      this._rebuild(true);
      this.applyFogToScene();
      this._buildEnvironment();
    } catch (err) {
      console.error('[sky] disabled —', err);
      this.enabled = false;
      throw err;
    }
  }

  /* ───────────────────────── public API ───────────────────────── */

  /**
   * @param {number} t 0..1 (0 = midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset)
   * @param {boolean} immediate skip the smooth blend (scenarios use this)
   */
  setTimeOfDay(t, immediate = false) {
    const v = ((t % 1) + 1) % 1;
    this._todTarget = v;
    if (immediate) {
      this.timeOfDay = v;
      this._todBlend = 1;
      this._todFrom = v;
      if (this.enabled) this._rebuild(true);
    } else {
      this._todFrom = this.timeOfDay;
      this._todBlend = 0;
    }
    return this;
  }

  setWeather(kind, intensity = 1) {
    const key = typeof kind === 'string' && WEATHER[kind] ? kind : this.weatherKey;
    this.weatherKey = key;
    this.weatherIntensity = clamp01(intensity);
    if (this.enabled) this._rebuild(true);
    return this;
  }

  setInterior(on) {
    this.interior = !!on;
    if (this.enabled) this._rebuild(true);
    return this;
  }

  /** Scenario hook (Scenarios.js calls this directly). */
  applyScenario(name, cfg) {
    if (!this.enabled) return;
    const env = cfg?.env ?? {};
    this.biome = env.biome ?? this.biome;
    this.interior = !!env.interior;
    this.fogAmount = typeof env.fog === 'number' ? clamp01(env.fog) : this.fogAmount;
    if (typeof env.timeOfDay === 'number') {
      this.timeOfDay = ((env.timeOfDay % 1) + 1) % 1;
      this._todTarget = this.timeOfDay;
      this._todFrom = this.timeOfDay;
      this._todBlend = 1;
    }
    if (typeof env.weather === 'string') {
      this.weatherKey = WEATHER[env.weather] ? env.weather : 'clear';
    }
    this._rebuild(true);
    this.applyFogToScene();
    this._buildEnvironment();
    this._forceEmit = 3;
  }

  /**
   * Inject nona height fog + aerial perspective (and the cloud-shadow
   * modulation) into a material. Safe to call repeatedly.
   * @returns {THREE.Material} the same material
   */
  applyFog(material) {
    if (!material || !this.enabled) return material;
    if (this._patched.has(material)) return material;
    if (material.userData?.skyNoFog) return material;
    if (material.isShaderMaterial && !material.userData?.skyFog) return material;
    if (material.isRawShaderMaterial) return material;
    if (material.blending !== undefined && material.blending !== THREE.NormalBlending) return material;
    if (material.isSpriteMaterial || material.isPointsMaterial || material.isLineBasicMaterial) return material;

    this._patched.add(material);
    const U = this.fogU;
    const prev = material.onBeforeCompile;

    material.onBeforeCompile = function nonaFogInject(shader, renderer) {
      try {
        if (typeof prev === 'function' && prev !== THREE.Material.prototype.onBeforeCompile) {
          prev.call(this, shader, renderer);
        }
      } catch (e) { /* another module's hook failed — ours still applies */ }

      if (!shader.fragmentShader.includes('#include <tonemapping_fragment>')) return;
      if (!shader.vertexShader.includes('#include <project_vertex>')) return;

      Object.assign(shader.uniforms, U);

      shader.vertexShader = FOG_VERT_DECL +
        shader.vertexShader.replace('#include <project_vertex>', FOG_VERT_BODY);

      let fs = FOG_PARS + shader.fragmentShader;
      if (fs.includes('#include <map_fragment>')) {
        fs = fs.replace('#include <map_fragment>', CLOUD_SHADOW_BODY);
      }
      fs = fs.replace(
        '#include <tonemapping_fragment>',
        'gl_FragColor.rgb = skApplyFog( gl_FragColor.rgb, vSkWPos );\n\t#include <tonemapping_fragment>'
      );
      shader.fragmentShader = fs;
    };

    /* Compose rather than clobber: Terrain (and CSM) install their own cache
       key to describe their variants, and replacing it would let two different
       programs collide on one cache entry. */
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = function nonaFogKey() {
      let base = '';
      try { base = typeof prevKey === 'function' ? String(prevKey.call(this)) : ''; } catch { base = ''; }
      return `${base}|nona-fog-v1`;
    };
    material.fog = false;
    material.needsUpdate = true;
    return material;
  }

  /** Patch every material under `root` (defaults to the whole scene). */
  applyFogToScene(root) {
    if (!this.enabled) return 0;
    const target = root ?? this.engine.scene;
    let n = 0;
    const take = (m) => {
      if (!m || this._seen.has(m)) return;
      this._seen.add(m);
      this.applyFog(m);
      n++;
    };
    try {
      target.traverse((o) => {
        if (!o || o.userData?.skyNoFog) return;
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) { for (const mm of m) take(mm); } else take(m);
      });
    } catch (e) { /* malformed subtree — ignore */ }
    return n;
  }

  /**
   * The moving cloud-shadow field.
   * Sample as: `uv = ( matrix * vec3( worldPos.xz, 1.0 ) ).xy` then multiply
   * lighting by `mix( 1.0, texture2D( texture, uv ).r, strength )`.
   */
  getCloudShadow() {
    return {
      texture: this.cloudShadowTexture ?? this._white,
      matrix: this.cloudShadowMatrix,
      offset: this.cloudShadowOffset,
      strength: this.cloudShadowStrength,
      worldSize: this.cloudShadowWorldSize,
      /** true while Sky is already folding an equivalent term into materials */
      ownedBySky: this.enabled,
    };
  }

  /** Linear sky radiance in a direction — the exact function the fog samples. */
  getSkyColor(dir, out = new THREE.Color()) {
    if (!this.state) return out.setRGB(0.2, 0.24, 0.3);
    const c = evalSkyColor(this.state, dir.x, dir.y, dir.z, this._tmpColor);
    return out.setRGB(c[0], c[1], c[2]);
  }

  /* ───────────────────────── frame ───────────────────────── */

  update(dt, elapsed) {
    if (!this.enabled) return;
    const e = this.engine;

    if (this._todBlend < 1) {
      this._todBlend = Math.min(1, this._todBlend + dt / 1.2);
      const a = this._todFrom ?? this.timeOfDay;
      let b = this._todTarget;
      // shortest path around the clock
      if (b - a > 0.5) b -= 1; else if (a - b > 0.5) b += 1;
      const t = this._todBlend;
      const s = t * t * (3 - 2 * t);
      this.timeOfDay = ((lerp(a, b, s) % 1) + 1) % 1;
      this._rebuild(false);
    }

    const cam = e.camera;
    this.skyMat.uniforms.uTime.value = elapsed;
    this.fogU.uSkTime.value = elapsed;

    if (cam) {
      const want = Math.max(200, cam.far * 1.6);
      if (Math.abs(want - this._skyRadius) > 1) {
        this._skyRadius = want;
        this.mesh.scale.setScalar(want);
      }
      this.mesh.position.copy(cam.position);
      this._updateSunInShot(cam);
    }

    /* cloud shadows scroll with the wind (deterministic in elapsed) */
    const inv = 1 / this.cloudShadowWorldSize;
    const sc = this._shadowScroll;
    const ox = elapsed * sc * 0.62, oy = elapsed * sc;
    this.cloudShadowOffset.set(ox, oy);
    this.cloudShadowMatrix.set(inv, 0, ox, 0, inv, oy, 0, 0, 1);

    /* periodic rescan so late-spawned geometry inherits the fog */
    if ((this._scanFrame = (this._scanFrame + 1) % 12) === 0) this.applyFogToScene();

    this._emitSun();
  }

  resize() { /* nothing resolution dependent */ }

  /**
   * "The sky must not be the brightest thing in frame unless the sun is actually
   * in shot" — so the engine has to KNOW whether it is.
   *
   * Every gameplay rig pitches 46-56 deg down with a 44-50 deg FOV, which puts
   * the top of the frame 20-34 deg BELOW level; a sun at any usable elevation is
   * therefore off-frame in every one of them (measured on `overworld`: sun at
   * +42 deg, frame top at -22 deg). The band's own level is unconditionally
   * graded down for that reason. This weight only decides how hot the horizon
   * glow is allowed to run: when you genuinely are looking into the key light,
   * the forward-scatter lobe is real and should read.
   *
   * Deterministic — a pure function of the camera and the sky state, and smooth
   * in screen position so it cannot pop.
   */
  _updateSunInShot(cam) {
    const S = this.state;
    if (!S || this.interior) { this.sunInShot = 0; return; }
    const L = this._computeLight(S);
    const dir = L.isNight ? S.moonDir : S.sunDir;
    const p = this._tmpV.copy(cam.position).addScaledVector(dir, Math.min(cam.far * 0.5, 400));
    /* Behind the camera -> not in shot. Tested in VIEW space first because
       project() divides by w and folds anything behind the eye back into the
       frustum, which would report a sun at your back as centre-frame. */
    const q = this._tmpV2.copy(p).applyMatrix4(cam.matrixWorldInverse);
    if (q.z > -cam.near) { this.sunInShot = 0; return; }
    p.project(cam);
    const fx = 1 - clamp01((Math.abs(p.x) - 0.85) / 0.45);
    const fy = 1 - clamp01((Math.abs(p.y) - 0.85) / 0.45);
    const w = fx * fy;
    this.sunInShot = w * w * (3 - 2 * w);
    const g = this.skyMat.uniforms.uBandGlowW;
    if (g) g.value = lerp(0.085, 0.145, this.band?.lowSun ?? 0) * lerp(1, 1.45, this.sunInShot);
  }

  /**
   * MEASUREMENT HOOK — evaluates the shipped fog shader on the GPU for a list of
   * view depths and returns the resolved linear colour of each.
   *
   * This exists because "I implemented aerial perspective" is not a claim anyone
   * can check. It compiles the SAME FOG_PARS source the scene materials are
   * patched with, binds the SAME live uniform objects, and renders one pixel per
   * sample, so the numbers it returns are what the frame is actually doing — not
   * a CPU re-implementation that can drift from the GLSL.
   *
   * @param {object} o
   * @param {number[]} o.dists      view depths in metres
   * @param {number[]} o.albedo     the surface colour to fog, scene-linear
   * @param {THREE.Vector3} [o.dir] sightline (defaults to the camera's)
   * @returns {{dist:number, rgb:number[], luma:number, sat:number}[]|null}
   */
  fogProbe({ dists = [20, 80, 300], albedo = [0.055, 0.048, 0.040], dir = null } = {}) {
    if (!this.enabled) return null;
    const e = this.engine;
    const cam = e.camera;
    if (!cam) return null;
    const n = dists.length;
    const ray = (dir ? dir.clone() : cam.getWorldDirection(new THREE.Vector3())).normalize();

    let rt = null, mesh = null, geo = null, mat = null;
    try {
      const pos = new Float32Array(n * 6 * 3);
      const wp = new Float32Array(n * 6 * 3);
      for (let i = 0; i < n; i++) {
        // one screen-space quad per sample, each carrying its own world position
        const x0 = (i / n) * 2 - 1, x1 = ((i + 1) / n) * 2 - 1;
        const q = [[x0, -1], [x1, -1], [x1, 1], [x0, -1], [x1, 1], [x0, 1]];
        const P = ray.clone().multiplyScalar(dists[i]).add(cam.position);
        for (let v = 0; v < 6; v++) {
          const o = (i * 6 + v) * 3;
          pos[o] = q[v][0]; pos[o + 1] = q[v][1]; pos[o + 2] = 0;
          wp[o] = P.x; wp[o + 1] = P.y; wp[o + 2] = P.z;
        }
      }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('probeWPos', new THREE.BufferAttribute(wp, 3));

      mat = new THREE.RawShaderMaterial({
        vertexShader: `precision highp float;
attribute vec3 position;
attribute vec3 probeWPos;
varying vec3 vSkWPos;
void main() { vSkWPos = probeWPos; gl_Position = vec4( position, 1.0 ); }`,
        fragmentShader: `precision highp float;
// RawShaderMaterial gets no prefix, so the built-in the fog chunk relies on has
// to be declared here. WebGLRenderer still fills it from camera.matrixWorld.
uniform vec3 cameraPosition;
uniform vec3 uProbeAlbedo;
${FOG_PARS}
void main() { gl_FragColor = vec4( skApplyFog( uProbeAlbedo, vSkWPos ), 1.0 ); }`,
        uniforms: Object.assign(
          { uProbeAlbedo: { value: new THREE.Vector3(albedo[0], albedo[1], albedo[2]) } },
          this.fogU
        ),
        depthTest: false, depthWrite: false,
      });
      mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;

      rt = new THREE.WebGLRenderTarget(n, 1, {
        type: THREE.FloatType, format: THREE.RGBAFormat,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      });
      const scn = new THREE.Scene();
      scn.add(mesh);
      const prevRT = e.renderer.getRenderTarget();
      const prevTone = e.renderer.toneMapping;
      e.renderer.toneMapping = THREE.NoToneMapping;
      e.renderer.setRenderTarget(rt);
      e.renderer.render(scn, cam);
      const buf = new Float32Array(n * 4);
      e.renderer.readRenderTargetPixels(rt, 0, 0, n, 1, buf);
      e.renderer.setRenderTarget(prevRT);
      e.renderer.toneMapping = prevTone;

      const out = [];
      for (let i = 0; i < n; i++) {
        const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
        const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
        out.push({
          dist: dists[i],
          rgb: [r, g, b],
          luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
          sat: hi > 1e-7 ? (hi - lo) / hi : 0,
        });
      }
      return out;
    } catch (err) {
      console.warn('[sky] fogProbe failed —', err?.message ?? err);
      return null;
    } finally {
      try { rt?.dispose(); geo?.dispose(); mat?.dispose(); } catch { /* nothing to salvage */ }
    }
  }

  /* ───────────────────────── internals ───────────────────────── */

  _onSceneAdded(payload) {
    if (!this.enabled) return;
    const obj = payload?.isObject3D ? payload
      : payload?.object?.isObject3D ? payload.object
        : payload?.target?.isObject3D ? payload.target
          : payload?.mesh?.isObject3D ? payload.mesh : null;
    this.applyFogToScene(obj ?? undefined);
  }

  _rebuild(hard) {
    const S = computeSkyState(this.timeOfDay, this.weatherKey, { interior: this.interior });
    this.state = S;
    const w = S.w;
    const U = this.skyMat.uniforms;
    const wi = this.weatherIntensity;

    /* ---- analytic sky uniforms ---- */
    U.uSunDir.value.copy(S.sunDir);
    U.uMoonDir.value.copy(S.moonDir);
    U.uBetaR.value.set(S.betaR[0], S.betaR[1], S.betaR[2]);
    U.uBetaM.value.set(S.betaM[0], S.betaM[1], S.betaM[2]);
    U.uSunE.value = S.sunE;
    U.uMieG.value = S.mieG;
    U.uTwilight.value = S.twilight;
    U.uTwilightGain.value = S.twilightGain;
    U.uNight.value = S.night;
    U.uMoonUp.value = S.moonUp;
    U.uDesat.value = S.desat * wi;
    U.uTint.value.set(
      lerp(1, w.tint[0], wi), lerp(1, w.tint[1], wi), lerp(1, w.tint[2], wi)
    );
    U.uInterior.value = this.interior ? 1 : 0;
    U.uSunUp.value = S.sunUp;

    const cloudy = clamp01(w.cloudCoverage * wi);
    U.uStarBright.value = S.night * (1 - cloudy * 0.55) * (this.interior ? 0 : 1);
    U.uMilkyWay.value = 0.055 * S.night * (1 - cloudy * 0.75);
    U.uMoonBright.value = 1.0 * (1 - cloudy * 0.35);

    /* ---- sun / moon colour from real extinction ---- */
    const sunCol = sunLightColor(S);
    const low = 1 - clamp01((S.sunDir.y + 0.05) / 0.35);
    U.uSunDiscColor.value.set(sunCol[0], sunCol[1], sunCol[2]);
    U.uSunDiscBright.value = 48 * lerp(1, 0.35, low) * lerp(1, w.sunMul, 0.5);

    /* ---- cloud layer ---- */
    const covr = clamp01(lerp(0.18, w.cloudCoverage, wi));
    U.uCloudCoverage.value = covr;
    U.uCloudDensity.value = lerp(0.7, w.cloudDensity, wi);
    U.uCloudAbsorb.value = lerp(2.4, w.cloudAbsorb, wi);
    U.uCloudPowder.value = w.cloudPowder;
    U.uCloudEnable.value = this.interior ? 0 : 1;
    U.uShowSunDisc.value = this.interior ? 0 : 1;
    U.uShellTop.value = 6372.4 + lerp(1.4, 3.2, w.cloudTop);
    const spd = w.cloudSpeed * 0.35 * lerp(0.5, 1, wi);
    U.uWind.value.set(spd * 0.82, spd * 0.48);
    this._shadowScroll = lerp(0.010, 0.030, clamp01(w.cloudSpeed / 0.0135));

    const L = this._computeLight(S);
    const isNight = L.isNight;
    U.uCloudLightDir.value.copy(isNight ? S.moonDir : S.sunDir);
    const sunPower = lerp(0.30, 1.0, S.lightUp) * lerp(1, w.sunMul, 0.55);
    if (isNight) {
      U.uCloudLight.value.set(0.30, 0.36, 0.52).multiplyScalar(0.55 + S.moonUp * 0.7);
      U.uCloudAmbTop.value.set(0.022, 0.028, 0.048);
      U.uCloudAmbBot.value.set(0.010, 0.012, 0.022);
    } else {
      U.uCloudLight.value.set(sunCol[0], sunCol[1], sunCol[2]).multiplyScalar(2.85 * sunPower);
      const zen = evalSkyColor(S, 0, 1, 0, [0, 0, 0]);
      U.uCloudAmbTop.value.set(zen[0] * 1.35 + 0.05, zen[1] * 1.35 + 0.06, zen[2] * 1.35 + 0.09);
      U.uCloudAmbBot.value.set(zen[0] * 0.42 + 0.012, zen[1] * 0.42 + 0.014, zen[2] * 0.45 + 0.022);
    }
    U.uCloudMieG.value = lerp(0.62, 0.80, 1 - S.desat);

    /* ---- fog / aerial perspective + the sub-horizon band ----
       _rebuildFog() computes bandState() once and writes BOTH the dome's band
       uniforms and the fog's haze targets from it, which is what guarantees that
       fully-fogged distant land and the sky directly above it are the same
       family of colours separated by a known value gap. */
    this._rebuildFog(S);

    /* ---- far horizon silhouette (inside the dome shader) ----
       Rock colours and the rim come from bandState() so they track time-of-day;
       what is set here is how much AIR sits in front of each layer. */
    U.uHzEnable.value = this.interior ? 0 : 1;
    /* uHzFog is the farthest layer's mix; GLSL_HORIZON scales it 1.00 / 0.75 /
       0.50 / 0.25 down the stack, so the four crests recede in value. */
    U.uHzFog.value = clamp01(0.62 + (w.fogMul - 1) * 0.11 + this.fogAmount * 0.16);
    U.uHzMist.value = clamp01(0.20 + this.fogAmount * 0.24 + (w.fogMul - 1) * 0.06);
    /* Crest softness in tan(depression). A 1-2 px coverage step is what read as a
       hard geometry seam; 0.004-0.010 of s is 0.25-0.6 deg, which at 1600x900 on
       this rig is 8-22 px of soft crest. */
    U.uHzSoft.value = lerp(0.0038, 0.0115, clamp01(this.fogAmount * 0.7 + (w.fogMul - 1) * 0.26));
    /* Spill is applied once per layer, so the four layers stack. At 0.32 each the
       top of frame picked up ~1.5x the band value on top of itself and was pushed
       past the grade's clip point; 0.06-0.16 keeps the total bleed under a quarter
       while still softening every crest. */
    U.uHzSpill.value = lerp(0.06, 0.16, clamp01(this.fogAmount * 0.8 + (w.fogMul - 1) * 0.22));
    U.uHzRimGain.value = lerp(0.10, 0.95, S.lightUp) * lerp(1, w.sunMul, 0.6);
    this.mesh.visible = true;

    /* ---- cloud shadow map ---- */
    if (hard) this._rebuildCloudShadow(covr, w);
    this.cloudShadowStrength = this.interior
      ? 0
      : clamp01(w.shadowStrength * wi * lerp(0.10, 1.0, S.lightUp));
    const cs = this.fogU.uSkCloudShade.value;
    cs.x = this.cloudShadowStrength;
    cs.y = 1 / this.cloudShadowWorldSize;
    cs.z = this._shadowScroll * 0.62;
    cs.w = this._shadowScroll;
    // centre the coverage threshold so the shadowed fraction tracks the sky
    const mid = 0.5 + (0.5 - covr) * 0.42;
    this.fogU.uSkCloudCov.value.set(mid - 0.075, mid + 0.075);
  }

  _rebuildFog(S) {
    const U = this.fogU;
    const D = this.skyMat.uniforms;
    const w = S.w;
    const L = this._computeLight(S);

    /* Sample along the KEY LIGHT's azimuth, not the sun's. At night the sun is
       on the far side of the planet; biasing the fog toward it would brighten
       the wrong half of the world. This keeps the band's warm/cool split, the
       inscatter lobe, the ridge rim and the shader's azimuth blend all pointing
       at one source. */
    const key = this._keyAz.set(L.dir.x, 0.04, L.dir.z);
    if (key.lengthSq() < 1e-6) key.set(0, 1, 0);
    key.normalize();

    const up = evalSkyColor(S, 0, 1, 0, [0, 0, 0]);
    const hs = evalSkyColor(S, key.x, key.y, key.z, [0, 0, 0]);
    const ho = evalSkyColor(S, -key.x, key.y, -key.z, [0, 0, 0]);

    const haze = BIOME_HAZE[this.biome] ?? BIOME_HAZE.default;
    /* A downward view collects light scattered out of the WHOLE dome, so weight
       the zenith in too. Averaging only the two horizons let the hot sunset
       band drag the entire frame monochrome-orange. */
    const skyAvg = [
      (hs[0] + ho[0] + 2 * up[0]) * 0.25,
      (hs[1] + ho[1] + 2 * up[1]) * 0.25,
      (hs[2] + ho[2] + 2 * up[2]) * 0.25,
    ];
    const groundLum = (skyAvg[0] + skyAvg[1] + skyAvg[2]) / 3;

    /* The key azimuth as a unit 2-vector, shared by the dome band and the fog so
       "which side of the sky is the light on" has exactly one answer. */
    const kaz = this._keyAz2;
    kaz.set(key.x, key.z);
    if (kaz.lengthSq() < 1e-9) kaz.set(0, -1); else kaz.normalize();
    D.uKeyAz.value.copy(kaz);

    if (this.interior) {
      /* Dense, close, slightly warm — torch light becomes volumetric. */
      const d = lerp(0.014, 0.042, this.fogAmount);
      const warm = this.biome === 'hell' ? [0.055, 0.026, 0.016] : [0.030, 0.026, 0.024];
      U.uSkZenith.value.set(warm[0] * 0.55, warm[1] * 0.55, warm[2] * 0.62);
      U.uSkHorizonSun.value.set(warm[0], warm[1], warm[2]);
      U.uSkHorizonOpp.value.set(warm[0] * 0.72, warm[1] * 0.74, warm[2] * 0.86);
      U.uSkGround.value.set(warm[0] * 0.50, warm[1] * 0.48, warm[2] * 0.52);
      U.uSkSunTint.value.set(0.10, 0.055, 0.022);
      U.uSkFogA.value.set(d, 0.055, 0.0, 9.0);
      U.uSkFogB.value.set(0.985, 0.06, 0.45, 0.55);
      /* Interiors keep the exact curve they were tuned to — a torchlit crypt
         reads through 12 m, not 300, so a distance gate and a chroma fall-off
         would only eat contrast. Neutral values: gate = 1, drain = 0, gain = 1,
         and all three haze targets equal so the azimuth blend is a constant. */
      U.uSkFogC.value.set(0.0, 1.0, 1.0, 0.0);
      U.uSkAer.value.set(0.0, 1.0, 0.0, 1.0);
      U.uSkAer2.value.set(0.0, 1.0, 0.0, 0);
      const iw = [warm[0] * 0.62, warm[1] * 0.60, warm[2] * 0.64];
      U.uSkHazeNear.value.set(iw[0], iw[1], iw[2]);
      U.uSkHazeSun.value.set(iw[0], iw[1], iw[2]);
      U.uSkHazeOpp.value.set(iw[0], iw[1], iw[2]);
    } else {
      /* ---- ONE derivation for the band, the silhouettes and the fog ----
         bandState() returns the skyline colour of this time-of-day/weather plus
         everything keyed off it. The dome shades its sub-horizon band with
         hi/opp/lo/glow; the fog converges on hazeSun/hazeOpp; the silhouette
         stack uses rock/rim. Because all of it comes from one number, distant
         land can never resolve brighter than the sky it stands against — which
         is the failure mode that erased the horizon in every previous pass. */
      const B = bandState(S, key, {
        biomeHaze: haze,
        fogAmount: this.fogAmount,
        weatherIntensity: this.weatherIntensity,
      });
      this.band = B;

      D.uBandHi.value.set(B.hi[0], B.hi[1], B.hi[2]);
      D.uBandOpp.value.set(B.opp[0], B.opp[1], B.opp[2]);
      D.uBandLo.value.set(B.lo[0], B.lo[1], B.lo[2]);
      D.uBandGlow.value.set(B.glow[0], B.glow[1], B.glow[2]);
      D.uHzRock0.value.set(B.rock[0][0], B.rock[0][1], B.rock[0][2]);
      D.uHzRock1.value.set(B.rock[1][0], B.rock[1][1], B.rock[1][2]);
      D.uHzRock2.value.set(B.rock[2][0], B.rock[2][1], B.rock[2][2]);
      D.uHzRim.value.set(B.rim[0], B.rim[1], B.rim[2]);

      /* Ramp geometry. skylineS is where the stack's farthest crest sits, so the
         value ramp is anchored to the visible skyline rather than to level; the
         span reaches full depth at s = skylineS + 1/y (about 40 deg down), which
         is the bottom third of any gameplay frame. */
      const fa = clamp01(this.fogAmount);
      const wm = lerp(1, w.fogMul, this.weatherIntensity);
      D.uBandCurve.value.set(0.30, 1 / 0.85, 1.35, lerp(0.92, 0.74, fa));
      D.uBandGlowW.value = lerp(0.085, 0.145, B.lowSun);
      D.uBandStrat.value.set(0.885, lerp(0.135, 0.185, fa), 0.085);
      /* The veil pulls the analytic dome onto the band as the view nears level.
         Heavier weather = a taller, stronger haze layer. */
      D.uBandVeil.value = lerp(0.045, 0.075, clamp01((wm - 1) / 1.6));
      D.uBandVeilAmt.value = clamp01(lerp(0.78, 0.92, clamp01((wm - 1) / 1.6)));

      /* ---- height fog ----
         DENSITY. Calibrated against the measured rig (camera y 35.55, 46 deg
         pitch): base = d * exp(-b * camY) must put the integral along a sightline
         to the far country at tau ~4 while a 40-80 m sightline sits near tau
         0.5-1.0. FOG_CAL is what renormalises the authored `fogAmount` onto that
         band; without it the near edge of the frame already integrates a third of
         the way to the haze and the terrain disappears.
         Raised 0.88 -> 1.22 after measuring the mid-ground: with the far target
         pulled down to keep the sky inside the grade's window, f at 70 m had
         fallen to ~0.5 and the moor's 60-90 m band (whose own lit value measures
         0.005 scene-linear) resolved at display luma 0.009 — a black mass. The
         density now puts f near 0.7 there, which lifts it clear of the grade's toe
         without touching the far plateau, where f is capped anyway. */
      const FOG_CAL = 1.95;
      const d = lerp(0.0055, 0.0280, this.fogAmount) * wm * FOG_CAL;
      U.uSkFogA.value.set(d, w.fogFall, 0.0, 6.0);

      /* These four still describe the SKY and are published to Lighting
         (hemisphere ambient) and Weather (ground-mist tint). They are no longer
         what the fog samples. */
      U.uSkZenith.value.set(up[0], up[1], up[2]);
      U.uSkHorizonSun.value.set(hs[0], hs[1], hs[2]);
      U.uSkHorizonOpp.value.set(ho[0], ho[1], ho[2]);
      const GROUND_HAZE_CAL = 0.25;
      const moonLift = L.isNight ? 0.011 * S.moonUp : 0;
      const MOON_HUE = [0.55, 0.66, 1.0];
      for (let i = 0; i < 3; i++) {
        this._gnd[i] = lerp(haze[i] * groundLum * 2.6, skyAvg[i] * 0.85, 0.5) * GROUND_HAZE_CAL
                     + moonLift * MOON_HUE[i];
      }
      U.uSkGround.value.set(this._gnd[0], this._gnd[1], this._gnd[2]);

      /* ---- what the fog converges on ---- */
      U.uSkHazeNear.value.set(B.hazeNear[0], B.hazeNear[1], B.hazeNear[2]);
      U.uSkHazeSun.value.set(B.hazeSun[0], B.hazeSun[1], B.hazeSun[2]);
      U.uSkHazeOpp.value.set(B.hazeOpp[0], B.hazeOpp[1], B.hazeOpp[2]);

      if (L.isNight) {
        // moonlit haze glows faintly toward the moon rather than the buried sun
        const g = 0.055 * S.moonUp;
        U.uSkSunTint.value.set(g * 0.55, g * 0.68, g);
        U.uSkFogB.value.set(0.955, 0.9, 0.62, 0.42);
      } else {
        const FexSun = extinctionFor(S, { y: Math.max(S.sunDir.y, 0.0) });
        const inSc = w.fogInscatter * lerp(0.10, 1.0, S.lightUp) * (1 - S.desat * 0.5);
        U.uSkSunTint.value.set(FexSun[0] * 0.55, FexSun[1] * 0.42, FexSun[2] * 0.30);
        /* OPACITY CEILING. 0.80 was reached by ~80 m on this rig, so 80 m and
           300 m resolved to the same value and the far half of the frame was one
           plane — the defect the review called "hills read as holes". 0.93 keeps
           the curve climbing all the way out; the horizon still reads because the
           far COLOUR is keyed below the skyline (HAZE_SUN / HAZE_OPP), not because the fog
           was starved of range. */
        U.uSkFogB.value.set(0.93, inSc * 0.45, 0.76, 0.42);
      }

      /* ---- aerial perspective calibration ----
         uSkFogC — distance gate on the optical depth. rampStart..rampEnd bracket
         the ground band the rig frames (33-82 m); `nearScale` throttles the
         integral inside it so the near third keeps its own contrast.
         uSkAer  — the aerial ramp: x..y is the window over which the air takes
         chroma out of the surface and the haze colour walks from near to
         horizon. It MUST extend well past the fog's own saturation distance or
         mid and far collapse onto each other: 16..210 m gives measurably
         different colour at 20 / 80 / 300 m.
         uSkAer2 — x is how much of the haze's OWN chroma the distance drains. */
      U.uSkFogC.value.set(
        lerp(28, 20, fa),
        lerp(100, 80, fa),
        clamp01(lerp(0.46, 0.36, fa)),
        /* Haze neutral floor. Was 0.20 + 0.22*fa = 0.32 on the moor, which with the
           distance drain below left the far field at HSV sat 0.023 — a grey wash, and
           the single biggest contributor to the frame's 0.208 saturation. Aerial
           perspective desaturates toward the SKY's hue, and this sky is a definite
           cool blue-grey; draining the air to near-neutral throws that away. 0.15 +
           0.17*fa = 0.24 keeps the air readably cool while the ramp still only ever
           removes chroma with distance. */
        clamp01(0.10 + 0.12 * fa)
      );
      U.uSkAer.value.set(
        lerp(22, 15, fa),
        lerp(240, 190, fa),
        /* Surface chroma loss. Split with the result-side ceiling below rather
           than carrying the whole drop, because a single strong pre-mix desat
           leaves the haze's own hue free to raise total saturation again.
           Trimmed from 0.20 + 0.34*fa because the ramp above now reaches these
           values 3-6x earlier in depth: at the old coefficients the same curve
           applied 0.36 of desat by 80 m where it previously applied 0.05, which
           would have taken the frame's saturation DOWN while the brief needs it up.
           The total chroma removed at full distance is what is preserved, not the
           per-metre rate. */
        clamp01(0.14 + 0.20 * fa + 0.06 * (wm - 1)),
        lerp(0.94, 1.06, fa)
      );
      /* .x and .z were 0.26 + 0.22*fa and 0.28 + 0.17*fa. Stacked on the (then 0.13)
         haze saturation cap they took the far field to HSV 0.031 — three multiplicative
         drains on a colour that was already nearly neutral. MEASURED end state on the
         moor: 0.246 at 20 m falling to 0.031 at 300 m, i.e. the far 60 % of the frame
         had no hue at all. Aerial perspective is a HUE SHIFT toward the air plus a
         chroma reduction, not a conversion to greyscale. Halved, the same curve lands
         at 0.10-0.12 far, so it still falls monotonically by a factor of two-plus over
         the depth range while distant land actually reads as blue-grey. */
      U.uSkAer2.value.set(
        clamp01(0.10 + 0.10 * fa),
        1.35,
        clamp01(0.09 + 0.07 * fa + 0.03 * (wm - 1)),
        0
      );
    }
    U.uSkSunDir.value.copy(this.interior ? this._interiorUp : L.dir);
  }

  _rebuildCloudShadow(coverage, w) {
    try {
      const key = `${coverage.toFixed(3)}|${w.cloudDensity.toFixed(2)}`;
      if (this._shadowKey === key && this.cloudShadowTexture) return;
      this._shadowKey = key;
      const old = this.cloudShadowTexture;
      const tex = buildCloudShadowTexture(this._noise, coverage, 1.0);
      tex.anisotropy = Math.min(4, this.engine.maxAniso ?? 1);
      this.cloudShadowTexture = tex;
      if (old) old.dispose();
      this.engine.bus.emit('sky:cloudShadow', this.getCloudShadow());
    } catch (e) {
      console.warn('[sky] cloud shadow build failed —', e?.message ?? e);
    }
  }

  /**
   * Decide which body is the key light. Compared by resulting intensity rather
   * than by a hard "sun is below the horizon" test, so civil twilight stays
   * sun-lit (low, warm, raking) instead of snapping to blue moonlight the
   * instant the disc dips — which is what a dusk hub scene needs.
   */
  _computeLight(S) {
    const w = S.w;
    const wi = this.weatherIntensity;
    const cloudDim = lerp(1, 1 - clamp01(w.cloudCoverage) * 0.45, wi);
    const sunI = 3.25 * Math.pow(S.lightUp, 1.35) * lerp(1, w.sunMul, wi) * cloudDim;
    const moonI = 0.26 * S.moonUp * cloudDim;
    const isNight = moonI > sunI;
    const L = this._light ?? (this._light = { dir: V3(0, 1, 0), col: [1, 1, 1], intensity: 0, isNight: false });
    L.isNight = isNight;
    L.intensity = this.interior ? 0 : (isNight ? moonI : sunI);
    if (isNight) {
      L.dir.copy(S.moonDir);
      L.col[0] = 0.56; L.col[1] = 0.66; L.col[2] = 1.0;
    } else {
      L.dir.copy(S.sunDir);
      const sc = sunLightColor(S);
      L.col[0] = sc[0]; L.col[1] = sc[1]; L.col[2] = sc[2];
    }
    /* A key light below the horizon leaves flat ground with dot(N,L) <= 0 and
       therefore unlit. Graze it instead of losing the whole directional term. */
    const minY = isNight ? 0.075 : 0.055;
    if (L.dir.y < minY) { L.dir.y = minY; L.dir.normalize(); }
    return L;
  }

  _emitSun() {
    const S = this.state;
    if (!S) return;
    const L = this._computeLight(S);
    const isNight = L.isNight;
    const dir = this.sun.dir;
    dir.copy(L.dir);

    this.sun.position.copy(dir).multiplyScalar(140);
    this.sun.color.setRGB(L.col[0], L.col[1], L.col[2]);
    this.sun.intensity = L.intensity;
    this.sun.isNight = isNight;
    this.sun.moonDir.copy(S.moonDir);
    const cr = L.col[0], cb = L.col[2];
    const intensity = L.intensity;

    const zen = this.fogU.uSkZenith.value;
    const gnd = this.fogU.uSkGround.value;
    this.sun.ambientSky.setRGB(zen.x, zen.y, zen.z);
    this.sun.ambientGround.setRGB(gnd.x, gnd.y, gnd.z);
    this.sun.ambientIntensity = this.interior ? 0.16 : lerp(0.30, 1.05, S.sunUp) * lerp(1, 1.35, S.desat);

    /* `fogColor` is the colour of PARTICULATE SITTING ON THE GROUND — Weather
       tints its ground-mist banks from it. It used to publish `uSkHorizonSun`,
       the radiance looking at the horizon toward the sun, which for an overcast
       moor is (1.15, 1.43, 1.56) *linear*. Weather takes 55 % of that, so every
       mist card rendered at ~0.8 linear and the moor grew a blown-out white
       cloud that swallowed the props standing in it. A low mist bank is lit by
       the downward hemisphere, not by the horizon: ground haze with a small
       bias toward the key light's horizon hue, which keeps it warm/cool
       correctly while staying an order of magnitude below the blowout. */
    const hz = this.fogU.uSkHorizonSun.value;
    const gh = this.fogU.uSkGround.value;
    /* GROUND_MIST is the second half of the calibration. `uSkGround` is the
       radiance of the WHOLE fogged air column out to the horizon; a knee-high
       bank a few metres thick integrates a small fraction of that, so handing the
       full value to a mist card stacks it several times over and saturates. At
       0.30 the densest core of a bank lands a little above the lit ground —
       readable as mist — instead of a hard white cloud sitting on the moor. */
    const GROUND_MIST = 0.30;
    const MIST_HORIZON_BIAS = 0.022;
    this.sun.fogColor.setRGB(
      gh.x * GROUND_MIST + hz.x * MIST_HORIZON_BIAS,
      gh.y * GROUND_MIST + hz.y * MIST_HORIZON_BIAS,
      gh.z * GROUND_MIST + hz.z * MIST_HORIZON_BIAS
    );

    const key = `${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)},${intensity.toFixed(3)},${cr.toFixed(3)},${cb.toFixed(3)}`;
    if (key !== this._sunEmitKey || this._forceEmit > 0) {
      this._sunEmitKey = key;
      if (this._forceEmit > 0) this._forceEmit--;
      this.engine.bus.emit('sky:sun', this.sun);
    }
  }

  /**
   * Bake the sky into an IBL probe. We always publish it on 'sky:env' (Lighting
   * prefers a real atmosphere probe over its own gradient fallback) but only
   * assign scene.environment when the slot is free or already ours.
   */
  _buildEnvironment() {
    const e = this.engine;
    if ((e.quality?.tier ?? 'high') === 'low') return;
    const scn = e.scene;

    /* Interiors: the dome is a near-black void, so an IBL baked from it would
       be a black probe that kills every ambient term in the scene. Hand the
       slot back and let Lighting own the interior probe. */
    if (this.interior) {
      if (scn.environment === this._envTex) scn.environment = null;
      return;
    }

    try {
      if (!this._pmrem) this._pmrem = new PMREMGenerator(e.renderer);

      const probeScene = new THREE.Scene();
      const probeMesh = new THREE.Mesh(this.mesh.geometry, this.skyMat);
      probeMesh.scale.setScalar(900);
      probeMesh.frustumCulled = false;
      probeScene.add(probeMesh);

      const prevDisc = this.skyMat.uniforms.uShowSunDisc.value;
      this.skyMat.uniforms.uShowSunDisc.value = 0;

      const rt = this._pmrem.fromScene(probeScene, 0.03, 1, 4000);

      this.skyMat.uniforms.uShowSunDisc.value = prevDisc;
      probeScene.remove(probeMesh);

      const prevTex = this._envTex;
      if (this._envRT) this._envRT.dispose();
      this._envRT = rt;
      this._envTex = rt.texture;
      this.environmentTexture = rt.texture;
      if (!scn.environment || scn.environment === prevTex) scn.environment = rt.texture;
      e.bus.emit('sky:env', { texture: rt.texture });
    } catch (err) {
      console.warn('[sky] environment probe skipped —', err?.message ?? err);
    }
  }

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch {} }
    this._offs.length = 0;
    try {
      if (this.mesh) this.engine.scene.remove(this.mesh);
      for (const r of this.rings ?? []) { this.engine.scene.remove(r.mesh); r.mat.dispose(); }
      this.skyMat?.dispose();
      for (const d of this._disposables) { try { d.dispose?.(); } catch {} }
      this.cloudShadowTexture?.dispose();
      if (this._envRT) this._envRT.dispose();
      this._pmrem?.dispose();
      if (this.engine.scene.environment === this._envTex) this.engine.scene.environment = null;
    } catch {}
    this.enabled = false;
  }
}
