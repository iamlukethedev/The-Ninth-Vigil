import * as THREE from 'three';
import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON, GLSL_BILATERAL } from './ShaderChunks.js';

/*
 * WHY THIS PASS HAS TWO AO TERMS.
 *
 * The half-resolution GTAO buffer is a *bent-normal-scale* occlusion term: at
 * `aoRadius` 0.55 m it measures how enclosed a point is by the room, and it is
 * denoised with a 5-px poisson kernel and then bilaterally upsampled from half
 * res. Measured on `closeup`: mean 0.937, only 5.9 % of pixels below 0.7. That
 * is a correct *ambient enclosure* signal and it is completely useless for
 * grounding, because grounding is a 5-20 cm phenomenon and every trace of it
 * has been averaged out by the time the buffer reaches this pass.
 *
 * The result was the single worst defect in the project: every rock, slab,
 * crate, pillar base and boot met the floor at a hard unshaded line, so the
 * whole frame read as objects composited onto a backdrop.
 *
 * So a SECOND, short-radius term is computed here, at FULL resolution, from the
 * same depth prepass:
 *
 *   - world radius `contactRadius` (0.22 m), clamped in SCREEN space to
 *     [contactMinPx, contactMaxPx]. The clamp is what makes one setting work for
 *     a 3 m portrait and a 28 m isometric camera: at 3 m the 0.22 m sphere spans
 *     ~90 px and is pulled back to 72 (bounding the sampling footprint); at 28 m
 *     it is ~10 px and passes through untouched; on the horizon the floor of
 *     2 px keeps a one-pixel seam alive instead of nothing at all.
 *   - a normal-oriented visibility count: a tap occludes when the geometry it
 *     hits sits above the receiver's tangent plane AND within a short range of
 *     it. That range check is what makes the term halo-free — a pixel can only
 *     be darkened by geometry a few centimetres from it, which is exactly the
 *     seam we want and nothing else.
 *   - a pedestal (`contactKnee`) subtracted from the obscurance before anything
 *     else. Every rough surface answers with a low non-zero occlusion over its
 *     whole area, and multiplying a whole frame by 0.88 is a dimmer switch, not
 *     grounding — it cost the moor its highlights. The pedestal throws that
 *     ambient wash away (it is the broad term's job) and keeps the local spikes.
 *   - `pow(ao, contactPower)`. A point 5 cm from a boot really only loses ~12 %
 *     of its hemisphere; the curve is what turns a physically correct 0.88 into
 *     a seam you can see, and it is applied to the contact term ALONE so the
 *     broad enclosure term keeps its linear response.
 *
 * `params.aoDebug` outputs the terms straight to the frame (1 = total, 2 =
 * contact, 3 = broad, 4 = normals) so "is the AO reaching the composite at all"
 * is one uniform away from an answer instead of a guess.
 *
 * The two are multiplied, and the contact term is deliberately given far less
 * luminance protection than the broad one (`contactProtect`), because the whole
 * point is to darken a boot standing on a brightly lit flagstone — the exact
 * pixel the broad term's protection throws away.
 *
 * WHY THE LUMINANCE PROTECTION HAS A KNEE (and why it MUST).
 * ---------------------------------------------------------
 * This pass runs on the composited HDR radiance, so its multiply lands on the
 * DIRECT lighting as much as on the ambient — that is the only way occlusion can
 * survive inside a light pool. The first version threw that away: the protection
 * was `1 / (1 + k * luma)` with no knee, i.e. a curve that starts eroding the
 * occlusion at luma 0. A flagstone lit to scene-linear 0.6 by a point light kept
 * only 62 % of its broad AO and 74 % of its contact AO, and a floor at 1.5 kept
 * 40 % / 55 %. The result was measured and named by the art director: occlusion
 * that is present in shadow and VANISHES exactly where a light is bright, which
 * is precisely where the eye goes. A bright point light was overwriting contact.
 *
 * The protection only ever had one job — stop AO from ringing a flame core or a
 * spell with a dark outline — and those are EMISSIVES, which live above 1.0
 * scene-linear by construction (the bloom threshold is 0.838 scene-linear, see
 * RenderPipeline's exposure budget note). So the curve now subtracts a knee
 * first: below `uProtKnee` a pixel gets its occlusion in full no matter how
 * brightly it is lit, and above it the old rolloff takes over. Lit stone is
 * grounded; flames are still left alone.
 */

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BILATERAL}

uniform sampler2D tDiffuse;
uniform sampler2D tAO;
// NOTE: three's program prefix already emits "precision highp sampler2D",
// so this is a full-precision depth fetch without an explicit qualifier
// (which would clash with the shared bilateral helper's sampler2D parameter).
uniform sampler2D tDepth;
#ifdef SANCTUM_GB_NORMAL
uniform sampler2D tNormal;
#endif

uniform vec2  uAoTexel;
uniform vec2  uTexel;
uniform vec2  uResolution;
uniform vec2  uProjScale;
uniform mat4  uInvProj;
uniform float uNear;
uniform float uFar;
uniform float uIntensity;
uniform float uPower;
uniform float uMinAO;
uniform float uLumaProtect;
uniform float uProtKnee;
uniform float uDepthSigma;
uniform vec3  uAoColor;

// --- short-radius contact term ---
uniform float uCIntensity;
uniform float uCRadius;
uniform float uCPower;
uniform float uCBias;
uniform float uCSlope;
uniform float uCRangeMul;
uniform float uCJitter;
uniform float uCKnee;
uniform float uCFloor;
uniform float uCProtect;
uniform float uCProtKnee;
uniform vec2  uCPx;          // min / max screen radius, pixels
uniform float uCFar;         // distance past which the contact term fades out
uniform int   uDebug;

varying vec2 vUv;

#ifndef CONTACT_TAPS
#define CONTACT_TAPS 16
#endif
const float GOLDEN_ANGLE = 2.39996323;

float depthAt( vec2 uv ) { return texture2D( tDepth, uv ).x; }

/* Emissive-only occlusion protection. Returns 1 (occlude fully) for everything
 * below the knee — however brightly a DIRECT light is hitting it — and rolls off
 * above it, where the only things that live are flame cores, hot metal, runes and
 * spell VFX. See the header note. */
float protectAt( float l, float knee, float k ) {
  return 1.0 / ( 1.0 + k * max( l - knee, 0.0 ) );
}

/* View-space normal. The prepass already rendered geometric view normals, so
 * use them; the depth-derivative fallback exists only for the case where the
 * pass is constructed without a normal target. */
vec3 viewNormal( vec2 uv, vec3 P ) {
#ifdef SANCTUM_GB_NORMAL
  vec3 gn = texture2D( tNormal, uv ).xyz * 2.0 - 1.0;
  float gnl = length( gn );
  return gnl > 1e-4 ? gn / gnl : vec3( 0.0, 0.0, 1.0 );
#else
  // Least-difference central differences: picks the side that is not crossing a
  // silhouette, so edge pixels get a plausible normal instead of a wild one.
  float dl = depthAt( uv - vec2( uTexel.x, 0.0 ) );
  float dr = depthAt( uv + vec2( uTexel.x, 0.0 ) );
  float db = depthAt( uv - vec2( 0.0, uTexel.y ) );
  float dt = depthAt( uv + vec2( 0.0, uTexel.y ) );
  vec3 pl = viewPosFromDepth( uv - vec2( uTexel.x, 0.0 ), dl, uInvProj );
  vec3 pr = viewPosFromDepth( uv + vec2( uTexel.x, 0.0 ), dr, uInvProj );
  vec3 pb = viewPosFromDepth( uv - vec2( 0.0, uTexel.y ), db, uInvProj );
  vec3 pt = viewPosFromDepth( uv + vec2( 0.0, uTexel.y ), dt, uInvProj );
  vec3 dx = ( abs( pl.z - P.z ) < abs( pr.z - P.z ) ) ? ( P - pl ) : ( pr - P );
  vec3 dy = ( abs( pb.z - P.z ) < abs( pt.z - P.z ) ) ? ( P - pb ) : ( pt - P );
  vec3 n = cross( dx, dy );
  float nl = length( n );
  return nl > 1e-6 ? n / nl : vec3( 0.0, 0.0, 1.0 );
#endif
}

/* Normal-oriented obscurance over a very small world radius.
 * Returns 1 = unoccluded.
 *
 * WHY THE RANGE IS A MULTIPLE OF THE DISC RADIUS. The tap disc is a SCREEN
 * space circle, so its world footprint is only "radius" wide on a surface
 * facing the camera. An ARPG floor is seen at 50-60 degrees off the view axis,
 * which stretches that footprint by 1.5-2.5x — the first version of this
 * estimator rejected almost every floor tap for being "out of range" and the
 * whole term measured 0.99 everywhere (visible in shots/_debug/ao_c_only.png:
 * correct structure, no magnitude). uCRangeMul is that stretch factor.
 *
 * WHY THE WEIGHT IS A SMOOTHSTEP AND NOT ndotv * atten^2. Occlusion is binary
 * per direction — a tap either sees geometry above the receiver's tangent plane
 * or it does not — and the useful signal is HOW MANY taps are blocked, not by
 * how much. Weighting each tap by its elevation cosine and a squared falloff
 * multiplied the answer by ~0.05 before it ever reached the power curve. */
float contactAO( vec2 uv, vec3 P, vec3 N ) {
  if ( uCIntensity <= 0.0 ) return 1.0;

  float dist = max( -P.z, 1e-3 );

  // World radius -> uv radius, clamped in pixels so one setting works for a 3 m
  // portrait and a 28 m isometric camera. R is re-derived from the clamped
  // pixel radius so the range check always describes the disc actually sampled.
  vec2 rUv = ( 0.5 * uCRadius / dist ) * uProjScale;
  float rPx = max( rUv.x * uResolution.x, rUv.y * uResolution.y );
  float px = clamp( rPx, uCPx.x, uCPx.y );
  float k = px / max( rPx, 1e-5 );
  rUv *= k;
  float range = uCRadius * k * uCRangeMul;

  // Angular jitter. Fully random per pixel (jitter 1) trades banding for dither
  // noise that a 3x crop shows up immediately; a fraction of one angular step is
  // enough to break the golden spiral's star pattern without visible grain.
  float rot = ign( gl_FragCoord.xy ) * ( GOLDEN_ANGLE * uCJitter );
  float occ = 0.0;

  for ( int i = 0; i < CONTACT_TAPS; i ++ ) {
    float fi = ( float( i ) + 0.5 ) / float( CONTACT_TAPS );
    float a = rot + float( i ) * GOLDEN_ANGLE;
    // pow 0.7 rather than the area-uniform sqrt: taps are pulled toward the
    // centre, where the contact signal lives, which both tightens the seam and
    // cuts the sample variance that shows up as dither on the ground.
    vec2 suv = uv + vec2( cos( a ), sin( a ) ) * rUv * pow( fi, 0.7 );
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

    float sd = depthAt( suv );
    if ( sd >= 0.999999 ) continue;                 // sky occludes nothing

    vec3 v = viewPosFromDepth( suv, sd, uInvProj ) - P;
    float d = length( v );
    if ( d < 1e-5 ) continue;

    // Elevation above the receiver's tangent plane. The bias band is what stops
    // a flat floor (or a noisy heightfield) from occluding itself.
    float ndv = dot( v, N ) / d;
    float w = smoothstep( uCBias, uCBias + uCSlope, ndv );
    if ( w <= 0.0 ) continue;

    // Nothing outside the little sphere may darken this pixel: that range check
    // is what keeps the term halo-free while the radius stays contact-scale.
    w *= 1.0 - smoothstep( range * 0.4, range, d );
    occ += w;
  }

  float o = ( occ / float( CONTACT_TAPS ) ) * uCIntensity;

  /*
   * PEDESTAL. Any rough surface returns a low, non-zero obscurance everywhere —
   * a moor of broken rock measured a mean 0.88 across the WHOLE terrain, and
   * multiplying an entire frame by 0.88 is a dimmer switch, not grounding.
   * Measured on the overworld moor: without this the frame mean fell 0.299 -> 0.148
   * and its 99th percentile 0.855 -> 0.718, i.e. the term ate the highlights.
   * Subtracting the pedestal and renormalising keeps the strong local seams
   * (a boot, a rock base, a mortar joint) and discards the ambient wash, which
   * is the broad GTAO term's job anyway.
   */
  o = max( o - uCKnee, 0.0 ) / max( 1.0 - uCKnee, 1e-3 );
  return sat( 1.0 - o );
}

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float dRaw = depthAt( vUv );

  // Sky / cleared depth receives no occlusion at all.
  if ( dRaw >= 0.999999 ) {
    gl_FragColor = uDebug > 0 ? vec4( 1.0, 1.0, 1.0, base.a ) : base;
    return;
  }

  float centerDist = linearDist( dRaw, uNear, uFar );

  // Depth-aware upsample of the half-res GTAO buffer: no bleeding across
  // silhouettes, which is what produces the classic dark halo.
  float ao = bilateralUpsample( tAO, tDepth, vUv, uAoTexel, centerDist, uDepthSigma, uNear, uFar ).r;
  ao = sat( ao );

  ao = pow( ao, uPower );
  ao = mix( 1.0, ao, uIntensity );
  ao = max( ao, uMinAO );

  // --- contact occlusion, full res, ~0.1-0.2 m ---
  vec3 P = viewPosFromDepth( vUv, dRaw, uInvProj );
  vec3 N = viewNormal( vUv, P );
  float cao = contactAO( vUv, P, N );
  cao = pow( cao, uCPower );
  // Fade out with distance: past uCFar the sphere is sub-pixel and all it can
  // add is aliasing on the horizon.
  float far = 1.0 - smoothstep( uCFar * 0.72, uCFar, centerDist );
  cao = mix( 1.0, cao, far );
  cao = max( cao, uCFloor );

  /*
   * EMISSIVES resist occlusion — that stops AO from ringing torches and spell
   * VFX with a dark outline. LIT SURFACES DO NOT: the knee (see header) is what
   * makes this multiply land on the direct lighting instead of being erased by
   * it. A flagstone at scene-linear 0.6 under a point light now keeps 100 % of
   * both terms; a flame core at 5.0 keeps 19 % of the broad term and 30 % of the
   * contact term, so it still reads as a light source and not as a hole.
   *
   * The contact term gets the weaker curve of the two (contactProtect scales its
   * slope, contactProtectKnee pushes its knee higher): a boot standing on a
   * brightly lit flagstone is the exact pixel this whole pass exists for.
   */
  float l = luma( base.rgb );
  ao = mix( 1.0, ao, protectAt( l, uProtKnee, uLumaProtect ) );
  cao = mix( 1.0, cao, protectAt( l, uCProtKnee, uLumaProtect * uCProtect ) );

  float total = ao * cao;

  if ( uDebug == 1 ) { gl_FragColor = vec4( vec3( total ), base.a ); return; }
  if ( uDebug == 2 ) { gl_FragColor = vec4( vec3( cao ), base.a ); return; }
  if ( uDebug == 3 ) { gl_FragColor = vec4( vec3( ao ), base.a ); return; }
  if ( uDebug == 4 ) { gl_FragColor = vec4( N * 0.5 + 0.5, base.a ); return; }

  // Occlusion is tinted cool rather than a flat black multiply: crevices read
  // as bounced indirect shadow instead of dead pixels.
  vec3 occ = mix( uAoColor, vec3( 1.0 ), total );
  gl_FragColor = vec4( base.rgb * occ, base.a );
}
`;

/** Fallbacks, so the pass is correct even if `params` never carries the knobs. */
const D = {
  contactIntensity: 2.5,
  contactRadius: 0.22,
  contactPower: 2.1,
  contactBias: 0.08,
  contactSlope: 0.34,
  contactRangeMul: 2.6,
  contactJitter: 0.5,
  contactKnee: 0.12,
  contactFloor: 0.06,
  contactProtect: 0.55,
  contactMinPx: 2.0,
  contactMaxPx: 72.0,
  contactFar: 90.0,
  /*
   * Scene-linear luma at which occlusion starts to be given up. Below this a
   * pixel is occluded in full however brightly it is lit; the bloom threshold is
   * 0.838 scene-linear, so 0.9 / 1.25 means "only things that bloom resist AO".
   */
  aoProtectKnee: 0.9,
  contactProtectKnee: 1.25,
  aoDebug: 0,
};

/**
 * Applies occlusion to the HDR scene colour: the half-resolution GTAO buffer
 * through a depth-aware bilateral upsample for ambient enclosure, plus a
 * full-resolution short-radius contact term for grounding.
 */
export class AOApplyPass extends QuadPass {
  constructor({ aoTexture, depthTexture, normalTexture = null, camera, params, taps = 16 }) {
    const defines = { CONTACT_TAPS: Math.max(4, Math.min(24, taps | 0)) };
    if (normalTexture) defines.SANCTUM_GB_NORMAL = 1;
    super(
      FRAG,
      {
        tDiffuse: { value: null },
        tAO: { value: aoTexture },
        tDepth: { value: depthTexture },
        tNormal: { value: normalTexture },
        uAoTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
        uResolution: { value: new THREE.Vector2(1600, 900) },
        uProjScale: { value: new THREE.Vector2(1.5, 2.75) },
        uInvProj: { value: new THREE.Matrix4() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uIntensity: { value: 0.9 },
        uPower: { value: 1.15 },
        uMinAO: { value: 0.12 },
        uLumaProtect: { value: 0.85 },
        uProtKnee: { value: D.aoProtectKnee },
        uDepthSigma: { value: 6.0 },
        uAoColor: { value: new THREE.Color(0.055, 0.062, 0.085) },
        uCIntensity: { value: D.contactIntensity },
        uCRadius: { value: D.contactRadius },
        uCPower: { value: D.contactPower },
        uCBias: { value: D.contactBias },
        uCSlope: { value: D.contactSlope },
        uCRangeMul: { value: D.contactRangeMul },
        uCJitter: { value: D.contactJitter },
        uCKnee: { value: D.contactKnee },
        uCFloor: { value: D.contactFloor },
        uCProtect: { value: D.contactProtect },
        uCProtKnee: { value: D.contactProtectKnee },
        uCPx: { value: new THREE.Vector2(D.contactMinPx, D.contactMaxPx) },
        uCFar: { value: D.contactFar },
        uDebug: { value: 0 },
      },
      defines,
      'Sanctum.AOApply'
    );
    this.camera = camera;
    this.params = params;
    this.needsSwap = true;
  }

  setAoResolution(w, h) {
    this.uniforms.uAoTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  beforeRender() {
    const p = this.params;
    const u = this.uniforms;
    const cam = this.camera;

    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uIntensity.value = p.aoIntensity;
    u.uPower.value = p.aoPower;
    u.uMinAO.value = p.aoFloor;
    u.uLumaProtect.value = p.aoLumaProtect;
    u.uProtKnee.value = p.aoProtectKnee ?? D.aoProtectKnee;
    u.uAoColor.value.setRGB(p.aoColor[0], p.aoColor[1], p.aoColor[2]);

    // Contact term. `projectionMatrix` elements 0 and 5 turn a world offset at
    // view depth z into an NDC offset, which is how a metre radius becomes a
    // pixel radius without ever leaving the shader's own space.
    const e = cam.projectionMatrix.elements;
    u.uProjScale.value.set(Math.abs(e[0]), Math.abs(e[5]));
    u.uInvProj.value.copy(cam.projectionMatrixInverse);

    u.uCIntensity.value = p.contactIntensity ?? D.contactIntensity;
    u.uCRadius.value = p.contactRadius ?? D.contactRadius;
    u.uCPower.value = p.contactPower ?? D.contactPower;
    u.uCBias.value = p.contactBias ?? D.contactBias;
    u.uCSlope.value = p.contactSlope ?? D.contactSlope;
    u.uCRangeMul.value = p.contactRangeMul ?? D.contactRangeMul;
    u.uCJitter.value = p.contactJitter ?? D.contactJitter;
    u.uCKnee.value = p.contactKnee ?? D.contactKnee;
    u.uCFloor.value = p.contactFloor ?? D.contactFloor;
    u.uCProtect.value = p.contactProtect ?? D.contactProtect;
    u.uCProtKnee.value = p.contactProtectKnee ?? D.contactProtectKnee;
    u.uCPx.value.set(p.contactMinPx ?? D.contactMinPx, p.contactMaxPx ?? D.contactMaxPx);
    u.uCFar.value = p.contactFar ?? D.contactFar;
    u.uDebug.value = p.aoDebug ?? 0;
  }
}
